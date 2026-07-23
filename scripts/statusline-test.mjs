import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listHostActivities, recordHostActivity } from "../src/host-activity-store.mjs";

const root = resolve(import.meta.dirname, "..");
const stateDirectory = mkdtempSync(join(tmpdir(), "bridge-statusline-test-"));
const id = "bridge-11111111-1111-4111-8111-111111111111";
try {
  await recordHostActivity(stateDirectory, {
    provider: "claude",
    action: "start",
    sessionId: "statusline-session",
    workspace: "/workspace/nolvaren-next",
    hostPid: process.pid,
    task: "Coordinate the active work",
  });
  const beforeHeartbeat = (await listHostActivities(stateDirectory))[0].heartbeatAt;
  writeFileSync(join(stateDirectory, `${id}.json`), JSON.stringify({
    id,
    status: "running",
    workspace: "/workspace/nolvaren-next",
    updatedAt: new Date().toISOString(),
    runtime: {
      activeCall: {
        agent: "codex",
        phase: "provider_progress",
        heartbeatAt: new Date().toISOString(),
        summary: "Running the complete CI gate; commit comes next.",
      },
    },
  }));
  const output = execFileSync(process.execPath, [resolve(root, "scripts/claude-statusline.mjs")], {
    input: JSON.stringify({ session_id: "statusline-session", workspace: { current_dir: "/workspace/nolvaren-next" }, model: { display_name: "Opus 4.8" } }),
    env: { ...process.env, BRIDGE_COLLABORATION_DIR: stateDirectory, BRIDGE_BASE_STATUSLINE: "printf base-status" },
    encoding: "utf8",
  });
  assert.match(output, /base-status/);
  assert.match(output, /↻ codex · provider_progress · heartbeat \d+s/);
  assert.match(output, /Running the complete CI gate/);
  assert.match(output, new RegExp(id));
  const refreshed = (await listHostActivities(stateDirectory))[0];
  assert.ok(Date.parse(refreshed.heartbeatAt) >= Date.parse(beforeHeartbeat));
  assert.equal(refreshed.model, "Opus 4.8");
  console.log("Claude status-line heartbeat test passed.");
} finally {
  rmSync(stateDirectory, { recursive: true, force: true });
}
