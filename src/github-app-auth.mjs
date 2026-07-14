import { createSign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export const DEFAULT_GITHUB_APPS_CONFIG = resolve(homedir(), ".config/local-agent-bridge/github-apps.json");
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9-]+(?:\[bot\])?$/;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(homedir(), path);
}

function resolveConfiguredPath(path, configPath) {
  if (path === "~" || path.startsWith("~/") || isAbsolute(path)) return expandHome(path);
  return resolve(dirname(expandHome(configPath)), path);
}

async function readConfig(configPath) {
  const resolvedPath = expandHome(configPath);
  try {
    return { config: JSON.parse(await readFile(resolvedPath, "utf8")), exists: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { config: null, exists: false };
    throw new Error(`Unable to read GitHub Apps config at ${resolvedPath}: ${error.message}`);
  }
}

async function securePrivateKey(path) {
  const keyPath = expandHome(path);
  const info = await stat(keyPath);
  if (!info.isFile()) throw new Error("GitHub App privateKeyPath must be a file.");
  if ((info.mode & 0o077) !== 0) {
    throw new Error("GitHub App private key must not be accessible by group or other users.");
  }
  return { keyPath, privateKey: await readFile(keyPath, "utf8") };
}

export function createAppJwt({ appId, privateKey, now = Date.now() }) {
  if (!/^\d+$/.test(String(appId || ""))) throw new Error("GitHub App appId must contain digits only.");
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: String(appId) }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}

async function githubJson(url, { token, method = "GET", body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub App request failed (${response.status}): ${payload.message || "unknown error"}`);
  return payload;
}

export async function listGitHubAppInstallations({ appId, privateKeyPath, apiUrl = "https://api.github.com", fetchImpl = fetch }) {
  const { privateKey } = await securePrivateKey(privateKeyPath);
  const jwt = createAppJwt({ appId, privateKey });
  const installations = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await githubJson(`${apiUrl}/app/installations?per_page=100&page=${page}`, { token: jwt, fetchImpl });
    if (!Array.isArray(batch)) throw new Error("GitHub App installations response must be an array.");
    installations.push(...batch);
    if (batch.length < 100) break;
    if (page === 20) throw new Error("GitHub App installation discovery exceeded the pagination safety limit.");
  }
  return installations.map((installation) => ({
    account: installation.account?.login,
    installationId: installation.id,
    repositorySelection: installation.repository_selection,
    permissions: installation.permissions || {},
  }));
}

export async function loadGitHubAppRole({ role, repository, configPath = DEFAULT_GITHUB_APPS_CONFIG }) {
  if (!/^[a-z][a-z0-9_-]*$/i.test(role || "")) throw new Error("GitHub App role is invalid.");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) {
    throw new Error("repository must be owner/name.");
  }
  const [owner] = repository.split("/");
  const { config, exists } = await readConfig(configPath);
  if (!exists) throw new Error(`GitHub Apps config does not exist: ${expandHome(configPath)}`);
  if (config.version !== 1) throw new Error("Unsupported GitHub Apps config version.");
  const selected = config.roles?.[role];
  if (!selected) throw new Error(`GitHub App role is not configured: ${role}`);
  if (!/^\d+$/.test(String(selected.appId || ""))) throw new Error(`GitHub App appId is invalid for role: ${role}`);
  if (!GITHUB_LOGIN_PATTERN.test(selected.expectedLogin || "")) throw new Error(`GitHub App expectedLogin is invalid for role: ${role}`);
  if (typeof selected.privateKeyPath !== "string" || !selected.privateKeyPath) {
    throw new Error(`GitHub App privateKeyPath is invalid for role: ${role}`);
  }
  const installationId = Object.entries(selected.installations || {})
    .find(([account]) => account.toLowerCase() === owner.toLowerCase())?.[1];
  if (!Number.isInteger(installationId) || installationId < 1) {
    throw new Error(`No ${role} GitHub App installation is configured for ${owner}.`);
  }
  return {
    appId: String(selected.appId),
    expectedLogin: selected.expectedLogin || null,
    installationId,
    privateKeyPath: resolveConfiguredPath(selected.privateKeyPath, configPath),
  };
}

export async function createInstallationToken({
  role,
  repository,
  configPath = DEFAULT_GITHUB_APPS_CONFIG,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  const selected = await loadGitHubAppRole({ role, repository, configPath });
  const { privateKey } = await securePrivateKey(selected.privateKeyPath);
  const jwt = createAppJwt({ appId: selected.appId, privateKey });
  const app = await githubJson(`${apiUrl}/app`, { token: jwt, fetchImpl });
  const verifiedLogin = app?.slug ? `${app.slug}[bot]` : null;
  if (!verifiedLogin || verifiedLogin !== selected.expectedLogin) {
    throw new Error(`GitHub App identity mismatch: configured ${selected.expectedLogin || "unknown"}, received ${verifiedLogin || "unknown"}.`);
  }
  const result = await githubJson(`${apiUrl}/app/installations/${selected.installationId}/access_tokens`, {
    token: jwt,
    method: "POST",
    body: { repositories: [repository.split("/")[1]] },
    fetchImpl,
  });
  if (!result.token) throw new Error("GitHub did not return an installation token.");
  return {
    token: result.token,
    expiresAt: result.expires_at,
    expectedLogin: selected.expectedLogin,
    verifiedLogin,
    installationId: selected.installationId,
  };
}

export async function resolveReviewToken({
  repository,
  tokenFile,
  configPath = process.env.GITHUB_APP_CONFIG || DEFAULT_GITHUB_APPS_CONFIG,
  appApiUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  const { config, exists } = await readConfig(configPath);
  if (exists && config?.roles?.reviewer) {
    return createInstallationToken({ role: "reviewer", repository, configPath, apiUrl: appApiUrl, fetchImpl });
  }

  if (!tokenFile) {
    throw new Error(exists
      ? "GitHub App role is not configured: reviewer"
      : `GitHub Apps config does not exist: ${expandHome(configPath)}`);
  }

  const resolvedTokenFile = expandHome(tokenFile);
  const info = await stat(resolvedTokenFile);
  if (!info.isFile()) throw new Error("GitHub review token path must be a file.");
  if ((info.mode & 0o077) !== 0) throw new Error("GitHub review token file must not be accessible by group or other users.");
  const token = (await readFile(resolvedTokenFile, "utf8")).trim();
  if (!token) throw new Error("GitHub review token file is empty.");
  return { token, expiresAt: null, expectedLogin: null, verifiedLogin: null, installationId: null };
}
