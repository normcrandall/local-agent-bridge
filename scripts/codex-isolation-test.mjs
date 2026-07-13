import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "agent-bridge-codex-home-"));
const source = join(temporary, "source");
const destination = join(temporary, "destination");
try {
  execFileSync("mkdir", ["-p", source]);
  writeFileSync(join(source, "auth.json"), "{\"token\":\"fixture-only\"}\n", { mode: 0o600 });
  writeFileSync(join(source, "config.toml"), `model = "configured-model"
model_reasoning_effort = "high"
notify = ["unsafe-command"]
sandbox_mode = "danger-full-access"

[mcp_servers.collaboration]
command = "/unsafe/bridge"

[plugins."browser@example"]
enabled = true
`);

  execFileSync(process.execPath, [join(root, "scripts/prepare-codex-home.mjs"), source, destination]);
  const config = readFileSync(join(destination, "config.toml"), "utf8");
  assert.match(config, /model = "configured-model"/);
  assert.match(config, /model_reasoning_effort = "high"/);
  assert.doesNotMatch(config, /notify|sandbox_mode|mcp_servers|plugins|unsafe/);
  assert.equal(lstatSync(join(destination, "auth.json")).isSymbolicLink(), true);
  assert.equal(resolve(destination, readlinkSync(join(destination, "auth.json"))), resolve(source, "auth.json"));

  unlinkSync(join(destination, "auth.json"));
  writeFileSync(join(destination, "auth.json"), "not-json\n", { mode: 0o600 });
  assert.throws(
    () => execFileSync(process.execPath, [join(root, "scripts/prepare-codex-home.mjs"), source, destination], { stdio: "pipe" }),
    /Command failed/,
  );
  assert.equal(readFileSync(join(destination, "auth.json"), "utf8"), "not-json\n");
  unlinkSync(join(destination, "auth.json"));
  writeFileSync(join(destination, "auth.json"), "{\"token\":\"rotated-by-codex\"}\n", { mode: 0o600 });

  execFileSync(process.execPath, [join(root, "scripts/prepare-codex-home.mjs"), source, destination]);
  assert.match(readFileSync(join(source, "auth.json"), "utf8"), /rotated-by-codex/);
  assert.equal(lstatSync(join(destination, "auth.json")).isSymbolicLink(), true);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log("Delegated Codex home isolation test passed: auth linked, model defaults preserved, MCPs/plugins/hooks removed.");
