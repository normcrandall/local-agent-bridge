import { spawn } from "node:child_process";

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

  const fallback = await loadFallbackToken();
  stderr.write("GitHub App permission denied; retrying the same command with the configured PAT fallback.\n");
  const second = await runCredentialCommand({ command, token: fallback.token, env, spawnImpl, stdout, stderr });
  return { ...second, fallbackUsed: true };
}
