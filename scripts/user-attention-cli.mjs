#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import { listCollaborations, readCollaboration } from "../src/collaboration-store.mjs";
import { attentionRequestIsFresh } from "../src/attention-state.mjs";
import { repositoryForLane } from "../src/mission-control.mjs";
import { attentionMessage, attentionNeedsUser, attentionRepository, createAttentionAction, deliverAttentionNotification, scanPendingUserAttention } from "../src/user-attention.mjs";

const args = process.argv.slice(2);
const command = args[0] || "list";
const stateRootIndex = args.indexOf("--state-root");
const stateRoot = resolve(stateRootIndex >= 0 && args[stateRootIndex + 1]
  ? args[stateRootIndex + 1]
  : process.env.BRIDGE_COLLABORATION_DIR || resolve(homedir(), ".local/share/agent-bridge/state"));
process.env.BRIDGE_COLLABORATION_DIR = stateRoot;

if (command === "test") {
  const repositoryIndex = args.indexOf("--repo");
  const repository = repositoryIndex >= 0 && args[repositoryIndex + 1]
    ? args[repositoryIndex + 1]
    : await repositoryForLane({ workspace: process.cwd() });
  const state = {
    id: "bridge-notification-test",
    repository,
    workspace: process.cwd(),
    coordinatorWake: { sequence: 0 },
  };
  const actionUrl = process.platform === "darwin" ? await createAttentionAction(process.cwd(), state) : null;
  const result = await deliverAttentionNotification(attentionMessage(state, { actionUrl }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.delivered ? 0 : 1);
}

if (command === "notify") {
  const results = await scanPendingUserAttention(process.cwd(), { force: true });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  process.exit(0);
}

if (command !== "list") {
  process.stderr.write("Usage: bridge attention list [--state-root PATH] [--repo OWNER/REPO]\n       bridge attention notify [--state-root PATH]\n       bridge attention test [--state-root PATH] [--repo OWNER/REPO]\n");
  process.exit(2);
}

const summaries = await listCollaborations(process.cwd(), { limit: 10_000 });
const pending = [];
const historical = [];
const repositoryIndex = args.indexOf("--repo");
const repositoryFilter = repositoryIndex >= 0 ? args[repositoryIndex + 1] : null;
for (const summary of summaries) {
  if (summary.status !== "needs_user" || summary.coordinatorWake?.kind !== "needs_user") continue;
  const state = await readCollaboration(process.cwd(), summary.id).catch(() => null);
  if (!state || !attentionNeedsUser(state)) continue;
  const repository = await repositoryForLane({
    repository: attentionRepository(state),
    workspace: state.workspace,
  });
  if (repositoryFilter && repository !== repositoryFilter) continue;
  const entry = {
    collaborationId: state.id,
    repository,
    status: state.status,
    workspace: state.workspace,
    summary: state.coordinatorWake?.summary || state.error || state.task,
    attention: state.coordinatorWake?.userAttention || null,
  };
  (attentionRequestIsFresh(state) ? pending : historical).push(entry);
}
process.stdout.write(`${JSON.stringify({ stateRoot, pending, historical }, null, 2)}\n`);
