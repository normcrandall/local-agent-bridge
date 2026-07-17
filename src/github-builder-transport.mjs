import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Broker-private bounded Git HTTPS transport. No shell anywhere: git is spawned
// directly from a fixed absolute path with a constructed environment, and
// credentials flow only through a private Node askpass helper plus the git
// child's environment. Tokens never appear in argv, stdout, or error text.

const GIT_BINARY_CANDIDATES = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git", "/bin/git"];
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const LOCAL_GIT_TIMEOUT_MS = 15_000;
export const PUSH_TIMEOUT_MS = 120_000;

export function resolveGitBinary(candidates = GIT_BINARY_CANDIDATES) {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`No git executable found at the fixed candidate paths: ${candidates.join(", ")}.`);
}

export function redactSecrets(text, secrets = []) {
  let value = String(text ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    const basic = Buffer.from(`x-access-token:${secret}`).toString("base64");
    value = value.split(secret).join("[REDACTED]").split(basic).join("[REDACTED]");
  }
  return value;
}

export function sanitizedGitEnv(extra = {}) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: tmpdir(),
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "false",
    GIT_SSH_COMMAND: "false",
    GIT_ALLOW_PROTOCOL: "https",
    ...extra,
  };
}

export function runGit(args, { gitPath, cwd, env, timeoutMs = LOCAL_GIT_TIMEOUT_MS, secrets = [] }) {
  return new Promise((resolve, reject) => {
    const cp = spawn(gitPath, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      shell: false,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    const killGroup = () => {
      try { process.kill(-cp.pid, "SIGKILL"); } catch { try { cp.kill("SIGKILL"); } catch {} }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    timer.unref?.();
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    cp.stdout.on("data", (chunk) => { stdoutChunks.push(chunk); });
    cp.stderr.on("data", (chunk) => { stderrChunks.push(chunk); });
    cp.on("error", (error) => {
      finish(reject, new Error(redactSecrets(`git spawn failed: ${error.message}`, secrets)));
    });
    cp.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = redactSecrets(Buffer.concat(stderrChunks).toString("utf8"), secrets);
      if (timedOut) {
        const error = new Error(`git ${redactSecrets(args.join(" "), secrets)} timed out after ${timeoutMs}ms and its process group was terminated.`);
        error.timedOut = true;
        error.stderr = stderr;
        finish(reject, error);
        return;
      }
      if (code === 0) {
        finish(resolve, { code, stdout, stderr });
        return;
      }
      const error = new Error(`git ${redactSecrets(args.join(" "), secrets)} failed with exit code ${code}\nstderr: ${stderr}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      finish(reject, error);
    });
    cp.stdin.end();
  });
}

export function assertBranchRef(ref) {
  if (!ref || typeof ref !== "string" || !ref.startsWith("refs/heads/")) {
    throw new Error("Ref must start with refs/heads/.");
  }
  const branch = ref.slice("refs/heads/".length);
  if (!branch || branch.length > 200) {
    throw new Error("Ref branch name is empty or exceeds the 200-character bound.");
  }
  if (
    !/^[A-Za-z0-9._/-]+$/.test(branch)
    || branch.includes("..")
    || branch.includes("//")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("@{")
  ) {
    throw new Error(`Ref contains unsafe characters or sequences: ${ref}`);
  }
  for (const component of branch.split("/")) {
    if (!component || component.startsWith(".") || component.endsWith(".") || component.startsWith("-") || component.endsWith(".lock")) {
      throw new Error(`Ref contains an unsafe path component: ${ref}`);
    }
  }
  return branch;
}

export function resolveTransportUrl({ repository, transportUrl = null }) {
  if (!REPOSITORY_PATTERN.test(repository || "")) {
    throw new Error("repository must be owner/name.");
  }
  if (!transportUrl) {
    return { url: `https://github.com/${repository}.git`, allowProtocol: "https" };
  }
  let parsed;
  try {
    parsed = new URL(transportUrl);
  } catch {
    throw new Error("Injected transport URL is not a valid URL.");
  }
  if (parsed.hostname !== "127.0.0.1") {
    throw new Error("Injected transport URLs are restricted to the 127.0.0.1 loopback test seam.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Injected transport URLs must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Transport URLs must not embed credentials.");
  }
  if (parsed.pathname !== `/${repository}.git` && parsed.pathname !== `/${repository}`) {
    throw new Error("Injected transport URL must target the bound repository path.");
  }
  return { url: transportUrl, allowProtocol: parsed.protocol === "http:" ? "http" : "https" };
}

export function createAskpassHelper({ token }) {
  const nodePath = process.execPath;
  if (/\s/.test(nodePath)) {
    throw new Error("Node executable path contains whitespace; cannot create a shebang-based askpass helper.");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "builder-askpass-"));
  chmodSync(dir, 0o700);
  const helperPath = path.join(dir, "askpass");
  const script = [
    `#!${nodePath}`,
    `"use strict";`,
    `const prompt = String(process.argv[2] || "");`,
    `if (/username/i.test(prompt)) { process.stdout.write("x-access-token\\n"); }`,
    `else { process.stdout.write((process.env.BUILDER_ASKPASS_TOKEN || "") + "\\n"); }`,
    "",
  ].join("\n");
  writeFileSync(helperPath, script, { mode: 0o700 });
  return {
    dir,
    helperPath,
    env: { GIT_ASKPASS: helperPath, BUILDER_ASKPASS_TOKEN: token },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function pushCommit({
  gitPath,
  workspace,
  repository,
  ref,
  sha,
  expectedRemoteSha = null,
  token,
  transportUrl = null,
  timeoutMs = PUSH_TIMEOUT_MS,
}) {
  assertBranchRef(ref);
  if (!SHA_PATTERN.test(sha || "")) throw new Error("pushCommit requires a full commit SHA.");
  if (expectedRemoteSha !== null && !SHA_PATTERN.test(expectedRemoteSha)) {
    throw new Error("expectedRemoteSha must be a full commit SHA when provided.");
  }
  if (!token || typeof token !== "string") throw new Error("pushCommit requires an installation token.");
  const { url, allowProtocol } = resolveTransportUrl({ repository, transportUrl });
  const askpass = createAskpassHelper({ token });
  try {
    const args = [
      "-c", "credential.helper=",
      "-c", "http.extraHeader=",
      "-c", "core.hooksPath=/dev/null",
      "push",
      "--atomic",
      `--force-with-lease=${ref}:${expectedRemoteSha ?? ""}`,
      url,
      `${sha}:${ref}`,
    ];
    const env = sanitizedGitEnv({
      HOME: askpass.dir,
      ...askpass.env,
      GIT_ALLOW_PROTOCOL: allowProtocol,
    });
    return await runGit(args, { gitPath, cwd: workspace, env, timeoutMs, secrets: [token] });
  } finally {
    askpass.cleanup();
  }
}
