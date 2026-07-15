import { spawn } from "node:child_process";
import { basename } from "node:path";

const MAX_CAPTURED_OUTPUT = 64 * 1024;
const PERMISSION_DENIED_PATTERNS = [
  /resource not accessible by integration/i,
  /installation token.+(?:lacks|missing|requires?).+permissions?/i,
  /github app.+(?:lacks|missing|requires?).+permissions?/i,
  /requires? (?:the )?[a-z_ -]+ permission/i,
];

export function isGitHubAppPermissionError(output = "") {
  return PERMISSION_DENIED_PATTERNS.some((pattern) => pattern.test(output));
}

function normalizedCommand(command = []) {
  return command.map((value) => String(value));
}

export function patFallbackPolicy(command = []) {
  const [executable = "", ...arguments_] = normalizedCommand(command);
  const name = basename(executable);
  if (name === "git" && arguments_[0] === "push") {
    return { allowed: false, reason: "Git pushes can mutate protected branches or refs." };
  }
  if (name !== "gh") {
    return { allowed: false, reason: "PAT fallback is restricted to an allowlist of non-authorizing gh operations." };
  }
  const [group, action] = arguments_;
  if (group === "issue" && ["create", "comment", "edit", "close", "reopen"].includes(action)) {
    return { allowed: true, reason: "Issue lifecycle operation." };
  }
  if (group === "pr" && ["create", "comment", "ready", "close", "reopen"].includes(action)) {
    return { allowed: true, reason: "Non-review pull-request lifecycle operation." };
  }
  if (group === "pr" && action === "merge") {
    return { allowed: false, reason: "A personal token must never bypass merge protection or approval policy." };
  }
  if (group === "pr" && action === "review") {
    return { allowed: false, reason: "A personal identity must never replace the configured reviewer App." };
  }
  if (group === "pr" && action === "edit") {
    return { allowed: false, reason: "PR edit can retarget the protected base branch and is not eligible for personal-token fallback." };
  }
  if (group === "api") {
    return { allowed: false, reason: "Arbitrary GitHub API mutations are not eligible for PAT fallback." };
  }
  return { allowed: false, reason: "The command is not an allowlisted compatibility operation." };
}

export function runCredentialCommand({ command, token, env = process.env, spawnImpl = spawn, stdout = process.stdout, stderr = process.stderr }) {
  return new Promise((resolve) => {
    let output = "";
    const child = spawnImpl(command[0], command.slice(1), {
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...env, GH_TOKEN: token, GITHUB_TOKEN: token },
    });
    const relay = (stream, destination) => stream?.on("data", (chunk) => {
      destination.write(chunk);
      output = `${output}${chunk}`.slice(-MAX_CAPTURED_OUTPUT);
    });
    relay(child.stdout, stdout);
    relay(child.stderr, stderr);
    child.on("error", (error) => {
      stderr.write(`${error.message}\n`);
      resolve({ code: 1, signal: null, output: `${output}\n${error.message}` });
    });
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, output }));
  });
}

export async function executeWithPermissionFallback({ command, appToken, loadFallbackToken, env, spawnImpl, stdout, stderr = process.stderr }) {
  const first = await runCredentialCommand({ command, token: appToken, env, spawnImpl, stdout, stderr });
  if (first.code === 0 || !isGitHubAppPermissionError(first.output)) return { ...first, fallbackUsed: false };

  const policy = patFallbackPolicy(command);
  if (!policy.allowed) {
    stderr.write(`GitHub App permission denied; PAT fallback blocked: ${policy.reason}\n`);
    return { ...first, fallbackUsed: false, fallbackBlocked: true, fallbackReason: policy.reason };
  }

  const fallback = await loadFallbackToken();
  stderr.write("GitHub App permission denied; retrying the same command with the configured PAT fallback.\n");
  const second = await runCredentialCommand({ command, token: fallback.token, env, spawnImpl, stdout, stderr });
  return { ...second, fallbackUsed: true };
}
