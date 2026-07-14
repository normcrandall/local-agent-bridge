#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWithPermissionFallback, isGitHubAppPermissionError } from "../src/github-command-fallback.mjs";

const temporary = await mkdtemp(join(tmpdir(), "github-command-fallback-test-"));
const fakeCommand = join(temporary, "fake-gh");
const output = { value: "", write(chunk) { this.value += String(chunk); } };

try {
  await writeFile(fakeCommand, `#!/bin/sh\nif [ "$GH_TOKEN" = "app-token" ]; then\n  echo "GraphQL: Resource not accessible by integration (closeIssue)" >&2\n  exit 1\nfi\n[ "$GH_TOKEN" = "pat-token" ] || exit 2\necho "closed with fallback"\n`, { mode: 0o700 });
  await chmod(fakeCommand, 0o700);

  assert.equal(isGitHubAppPermissionError("Resource not accessible by integration"), true);
  assert.equal(isGitHubAppPermissionError("builder GitHub App lacks required permissions: pull_requests:write."), true);
  assert.equal(isGitHubAppPermissionError("branch protection rejected the merge"), false);
  const result = await executeWithPermissionFallback({
    command: [fakeCommand],
    appToken: "app-token",
    loadFallbackToken: async () => ({ token: "pat-token" }),
    stdout: output,
    stderr: output,
  });
  assert.equal(result.code, 0);
  assert.equal(result.fallbackUsed, true);
  assert.match(output.value, /retrying the same command/);
  assert.match(output.value, /closed with fallback/);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("GitHub command fallback test passed: App permission denial retries once with the configured PAT.");
