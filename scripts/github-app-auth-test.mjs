#!/usr/bin/env node

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInstallationToken,
  assertGitHubAppPermissions,
  GITHUB_LOGIN_PATTERN,
  inspectGitHubAppRoles,
  listGitHubAppInstallations,
  resolveReviewToken,
} from "../src/github-app-auth.mjs";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const temporary = await mkdtemp(join(tmpdir(), "github-app-auth-test-"));
const privateKeyPath = join(temporary, "app.pem");
const configPath = join(temporary, "github-apps.json");
const tokenFile = join(temporary, "token");

try {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(tokenFile, "static-review-token\n", { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({
    version: 1,
    roles: {
      builder: {
        appId: "123456",
        expectedLogin: "example-builder[bot]",
        privateKeyPath,
        installations: { ExampleOrg: 222 },
      },
      reviewer: {
        appId: "654321",
        expectedLogin: "example-reviewer[bot]",
        privateKeyPath,
        installations: { ExampleOrg: 333 },
      },
    },
  }), { mode: 0o600 });

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    assert.match(options.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    assert.equal(options.headers["X-GitHub-Api-Version"], "2026-03-10");
    const jwtPayload = JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64url"));
    if (url.endsWith("/app/installations?per_page=100&page=1")) {
      return json([
        { id: 111, account: { login: "personal" }, repository_selection: "selected", permissions: {} },
        { id: 222, account: { login: "ExampleOrg" }, repository_selection: "all", permissions: { contents: "write" } },
      ]);
    }
    if (url.endsWith("/app")) {
      return json({ slug: jwtPayload.iss === "123456" ? "example-builder" : "example-reviewer" });
    }
    if (url.endsWith("/app/installations/222/access_tokens")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { repositories: ["repo"] });
      return json({ token: "builder-installation-token", expires_at: "2026-07-14T20:00:00Z", permissions: { contents: "write", pull_requests: "write", metadata: "read" } }, 201);
    }
    if (url.endsWith("/app/installations/333/access_tokens")) {
      return json({ token: "reviewer-installation-token", expires_at: "2026-07-14T20:00:00Z", permissions: { contents: "read", pull_requests: "write", metadata: "read" } }, 201);
    }
    return json({ message: `Unexpected URL ${url}` }, 404);
  };

  const installations = await listGitHubAppInstallations({
    appId: "123456",
    privateKeyPath,
    apiUrl: "https://github.test",
    fetchImpl,
  });
  assert.deepEqual(installations.map(({ account, installationId }) => ({ account, installationId })), [
    { account: "personal", installationId: 111 },
    { account: "ExampleOrg", installationId: 222 },
  ]);

  const builder = await createInstallationToken({
    role: "builder",
    repository: "exampleorg/repo",
    configPath,
    apiUrl: "https://github.test",
    fetchImpl,
  });
  assert.equal(builder.token, "builder-installation-token");
  assert.equal(builder.expectedLogin, "example-builder[bot]");
  await assert.rejects(
    createInstallationToken({ role: "builder", repository: "UnknownOwner/repo", configPath, apiUrl: "https://github.test", fetchImpl }),
    /No builder GitHub App installation is configured for UnknownOwner/,
  );

  const reviewer = await resolveReviewToken({
    repository: "ExampleOrg/repo",
    configPath,
    tokenFile,
    appApiUrl: "https://github.test",
    fetchImpl,
  });
  assert.equal(reviewer.token, "reviewer-installation-token");
  assert.equal(assertGitHubAppPermissions("builder", { contents: "write", pull_requests: "write", metadata: "read" }), true);
  assert.throws(() => assertGitHubAppPermissions("reviewer", { contents: "read", pull_requests: "read", metadata: "read" }), /pull_requests:write/);
  const inspected = await inspectGitHubAppRoles({ configPath });
  assert.equal(inspected.roles.builder.privateKeySecure, true);
  assert.equal(inspected.roles.reviewer.privateKeySecure, true);
  assert.deepEqual(inspected.roles.builder.installations, ["ExampleOrg"]);

  await assert.rejects(
    createInstallationToken({
      role: "builder",
      repository: "ExampleOrg/repo",
      configPath,
      apiUrl: "https://github.test",
      fetchImpl: async (url, options) => (
        url.endsWith("/app") ? json({ slug: "wrong-builder" }) : fetchImpl(url, options)
      ),
    }),
    /GitHub App identity mismatch/,
  );

  const fallback = await resolveReviewToken({
    repository: "ExampleOrg/repo",
    configPath: join(temporary, "missing.json"),
    tokenFile,
    fetchImpl,
  });
  assert.equal(fallback.token, "static-review-token");

  const noFallbackConfig = join(temporary, "no-fallback.json");
  await writeFile(noFallbackConfig, JSON.stringify({
    version: 1,
    compatibility: { allowPatFallback: false },
    roles: { builder: JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8")).roles.builder },
  }), { mode: 0o600 });
  await assert.rejects(
    resolveReviewToken({ repository: "ExampleOrg/repo", configPath: noFallbackConfig, tokenFile }),
    /PAT fallback is disabled/,
  );

  await assert.rejects(
    resolveReviewToken({
      repository: "ExampleOrg/repo",
      configPath,
      tokenFile,
      appApiUrl: "https://github.test",
      fetchImpl: async () => json({ message: "installation revoked" }, 401),
    }),
    /installation revoked/,
  );

  await chmod(privateKeyPath, 0o644);
  await assert.rejects(
    createInstallationToken({ role: "builder", repository: "ExampleOrg/repo", configPath, fetchImpl }),
    /must not be accessible by group or other users/,
  );

  assert.ok(calls.length >= 3);
  assert.equal(GITHUB_LOGIN_PATTERN.test("example-reviewer[bot]"), true);
  assert.equal(GITHUB_LOGIN_PATTERN.test("invalid[user]"), false);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("GitHub App auth tests passed: JWT, discovery, role routing, repository scope, fallback, and fail-closed behavior.");
