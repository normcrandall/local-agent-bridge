import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exportPortableManifest } from "../src/operations.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);
const secretPattern = /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}/;
for (const file of files) assert.doesNotMatch(readFileSync(resolve(root, file), "utf8"), secretPattern, file);

const temporary = mkdtempSync(join(tmpdir(), "bridge-secret-boundary-"));
try {
  const path = join(temporary, "manifest.json");
  const manifest = exportPortableManifest({ destination: path, sourceRoot: root });
  const exclusions = manifest.excludes.join(" ");
  for (const expected of ["ghtoken", "github-apps", "provider credentials", "collaboration state", "capsule files"]) assert.match(exclusions, new RegExp(expected));
} finally { rmSync(temporary, { recursive: true, force: true }); }

console.log("Secret boundary test passed: tracked source and portable manifest exclude credentials.");
