#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  collaborationStates,
  createWorktree,
  exportPortableManifest,
  inspectRecovery,
  isSafeWorkerPid,
  preflight,
  providerCapabilities,
  reconcileReviews,
  refreshCi,
  selectRoles,
  summarizeStates,
  usageDecision,
} from "../src/operations.mjs";
import { appendEvent, readCollaboration, updateCollaboration } from "../src/collaboration-store.mjs";

const root = resolve(import.meta.dirname, "..");
const stateRoot = process.env.BRIDGE_COLLABORATION_DIR || resolve(homedir(), ".local/share/agent-bridge/state");
process.env.BRIDGE_COLLABORATION_DIR = stateRoot;
const [command, ...args] = process.argv.slice(2);
const json = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

function value(flag, fallback = null) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

function firstValue(flags, fallback = null) {
  for (const flag of flags) {
    const found = value(flag);
    if (found !== null && found !== undefined) return found;
  }
  return fallback;
}

switch (command) {
  case "status":
    json(summarizeStates(collaborationStates(stateRoot)));
    break;
  case "capabilities":
    json(providerCapabilities());
    break;
  case "roles":
    json(selectRoles({
      taskNumber: Number.parseInt(firstValue(["--task", "--task-number"], args[0]), 10),
      agents: (value("--agents", "claude,codex,antigravity")).split(","),
      offset: Number.parseInt(value("--offset", "0"), 10),
    }));
    break;
  case "preflight":
    json(preflight({
      workspace: resolve(value("--workspace", process.cwd())),
      agents: value("--agents", "claude,codex,antigravity").split(","),
      mode: value("--mode", "review"),
      workProfile: value("--profile", "exact"),
      permissionProfile: value("--permissions", "standard"),
    }));
    break;
  case "recover": { // explicit inspection by default; mutation requires a flag
    const id = args.find((arg) => arg.startsWith("bridge-"));
    if (!id) throw new Error("recover requires a collaboration ID.");
    const state = await readCollaboration(root, id);
    if (args.includes("--cancel")) {
      if (isSafeWorkerPid(state.workerPid)) {
        try { process.kill(-state.workerPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      const cancelled = await updateCollaboration(root, id, (current) => ({
        ...current, status: "cancelled", cancelRequested: true, workerPid: null,
        runtime: { ...current.runtime, activeCall: null },
      }));
      await appendEvent(root, id, { type: "recovery_cancelled", at: new Date().toISOString() });
      json(inspectRecovery(cancelled));
    } else if (args.includes("--mark-indeterminate")) {
      const report = inspectRecovery(state);
      if (report.processAlive) throw new Error("Refusing to mark indeterminate while the worker process is alive.");
      const changed = await updateCollaboration(root, id, (current) => ({ ...current, status: "indeterminate" }));
      await appendEvent(root, id, { type: "recovery_marked_indeterminate", at: new Date().toISOString() });
      json(inspectRecovery(changed));
    } else json(inspectRecovery(state));
    break;
  }
  case "worktree":
    json(createWorktree({
      workspace: resolve(value("--workspace", process.cwd())),
      taskId: value("--task"),
      branch: value("--branch"),
      base: value("--base", "HEAD"),
      worktreeRoot: value("--root"),
    }));
    break;
  case "ci":
    json(refreshCi({ workspace: resolve(value("--workspace", process.cwd())), prNumber: Number.parseInt(value("--pr"), 10) }));
    break;
  case "reconcile": {
    const path = resolve(value("--reviews"));
    const reviews = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
    json(reconcileReviews(reviews));
    break;
  }
  case "usage": {
    const id = value("--id");
    const state = id ? await readCollaboration(root, id) : { usage: {} };
    json(usageDecision({
      usage: state.usage || {},
      budget: {
        maxCostUsd: value("--max-cost") == null ? undefined : Number(value("--max-cost")),
        maxTokens: value("--max-tokens") == null ? undefined : Number(value("--max-tokens")),
      },
    }));
    break;
  }
  case "bundle": {
    const destination = resolve(firstValue(["--output", "--destination"], resolve(process.cwd(), "agent-bridge-portable")));
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const manifest = exportPortableManifest({ destination: resolve(destination, "manifest.json"), sourceRoot: root });
    const archive = resolve(destination, "agent-bridge-source.tgz");
    const tar = spawnSync("tar", ["--exclude=node_modules", "--exclude=.git", "--exclude=.bridge", "-czf", archive, "-C", root, "."], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error((tar.stderr || tar.stdout).trim());
    writeFileSync(resolve(destination, "INSTALL.txt"), "Extract agent-bridge-source.tgz, then run: npm ci && npm run install:global && npm run doctor\nNever copy provider credentials or ~/.config/ghtoken between computers.\n");
    const installer = resolve(destination, "install.sh");
    writeFileSync(installer, `#!/bin/zsh
set -eu
HERE="\${0:A:h}"
TARGET="\${1:-$HOME/.local/src/agent-bridge}"
mkdir -p "$TARGET"
tar -xzf "$HERE/agent-bridge-source.tgz" -C "$TARGET"
npm --prefix "$TARGET" ci
npm --prefix "$TARGET" run install:global
npm --prefix "$TARGET" run doctor
print "Authenticate Claude Code, Codex, Antigravity, and provision ~/.config/ghtoken separately if PR reviews are required."
`, { mode: 0o700 });
    chmodSync(installer, 0o700);
    json({ destination, archive, installer, manifest });
    break;
  }
  default:
    process.stdout.write("Usage: bridge <status|capabilities|roles|preflight|recover|worktree|ci|reconcile|usage|bundle> [options]\n");
}
