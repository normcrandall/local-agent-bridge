#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { missionControlLaneKey } from "../src/mission-control-event-protocol.mjs";
import {
  MISSION_CONTROL_SESSION_MAX_BYTES,
  MISSION_CONTROL_SESSION_STORE_VERSION,
  createMissionControlSessionState,
  createMissionControlSessionStore,
  markMissionControlInputAcknowledged,
  missionControlInputNeedsAlert,
  missionControlSessionPath,
  reconcileMissionControlSession,
} from "../src/mission-control-session-store.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-bridge-mc-session-"));
const stateRoot = join(root, "state");
const workspaceA = join(root, "repo-a");
const workspaceB = join(root, "repo-b");
let now = Date.parse("2026-07-26T18:00:00.000Z");
const clock = () => now;
const repository = "veliqon/local-agent-bridge";
const lane = (id, overrides = {}) => ({
  id,
  repository,
  key: missionControlLaneKey(repository, id),
  status: "running",
  terminal: false,
  ...overrides,
});
const model = (lanes) => ({
  repositories: [{ id: repository }],
  portfolios: [{ id: "helm-one", repository }],
  collections: {
    active: lanes.filter((entry) => !entry.terminal && entry.status !== "needs_user"),
    needsYou: lanes.filter((entry) => entry.status === "needs_user"),
    queue: [], reviews: [], mergeTrain: [], history: lanes.filter((entry) => entry.terminal),
  },
});

try {
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  const store = createMissionControlSessionStore({ stateRoot, workspace: workspaceA, repository, now: clock });
  assert.equal((await store.load()).status, "missing");
  assert.equal(store.path, missionControlSessionPath(stateRoot, { workspace: workspaceA, repository }));
  assert.doesNotMatch(store.path, /veliqon|local-agent-bridge/u, "repository identity is not used as a path segment");

  const active = lane("active");
  const terminal = lane("done", { status: "merged", terminal: true, completionToken: "head:abc" });
  const needsUser = lane("decision", {
    status: "needs_user",
    attention: { required: true, claimId: "claim-1" },
  });
  let session = createMissionControlSessionState({
    navigation: {
      view: "needsYou",
      pane: "details",
      repository,
      portfolio: "helm-one",
      lane: needsUser.key,
      seenCompletions: { [terminal.key]: terminal.completionToken },
      laneOrderByScope: { [JSON.stringify(["needsYou", repository, "helm-one"])]: [needsUser.key] },
    },
    providerTranscript: "must be dropped",
    accessToken: "must be dropped",
  });
  assert.equal(missionControlInputNeedsAlert(session, needsUser), true);
  session = markMissionControlInputAcknowledged(session, needsUser);
  assert.equal(missionControlInputNeedsAlert(session, needsUser), false);
  assert.equal(missionControlInputNeedsAlert(session, { ...needsUser, terminal: true }), false, "terminal input never re-alerts");
  assert.equal(missionControlInputNeedsAlert(session, {
    ...needsUser,
    attention: { ...needsUser.attention, acknowledged: true },
  }), false, "source-acknowledged input never re-alerts");

  const saved = await store.save(session, { expectedRevision: 0 });
  assert.equal(saved.revision, 1);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  const raw = await readFile(store.path, "utf8");
  assert.doesNotMatch(raw, /must be dropped|accessToken/u);
  assert.equal(JSON.parse(raw).version, MISSION_CONTROL_SESSION_STORE_VERSION);
  assert.ok(Buffer.byteLength(raw, "utf8") <= MISSION_CONTROL_SESSION_MAX_BYTES);

  const loaded = await store.load();
  assert.equal(loaded.status, "loaded");
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.session.navigation.view, "needsYou");
  assert.equal(loaded.session.navigation.pane, "details");
  assert.equal(missionControlInputNeedsAlert(loaded.session, needsUser), false);

  // Workspace and repository scopes cannot observe each other's UI state.
  const otherWorkspace = createMissionControlSessionStore({ stateRoot, workspace: workspaceB, repository, now: clock });
  const otherRepository = createMissionControlSessionStore({ stateRoot, workspace: workspaceA, repository: "veliqon/other", now: clock });
  assert.equal((await otherWorkspace.load()).status, "missing");
  assert.equal((await otherRepository.load()).status, "missing");
  assert.notEqual(otherWorkspace.path, store.path);
  assert.notEqual(otherRepository.path, store.path);

  // Unknown and removed lanes cannot retain selection, while their bounded
  // input receipt survives a transient disappearance and prevents a re-alert.
  const reconciled = reconcileMissionControlSession(loaded.session, model([active, terminal]));
  assert.equal(reconciled.session.navigation.lane, null);
  assert.equal(reconciled.selectedLane, null);
  assert.equal(missionControlInputNeedsAlert(reconciled.session, needsUser), false);
  assert.equal(missionControlInputNeedsAlert(reconciled.session, { ...needsUser, attention: { required: true, claimId: "claim-2" } }), true,
    "a genuinely new request on the same lane has a new alert identity");

  // Atomic update serializes concurrent writers and preserves both mutations.
  await Promise.all([
    store.update(async (current) => ({
      ...current,
      navigation: { ...current.navigation, pane: "repositories" },
    })),
    store.update(async (current) => ({
      ...current,
      navigation: { ...current.navigation, view: "history" },
    })),
  ]);
  const afterConcurrent = await store.load();
  assert.equal(afterConcurrent.revision, 3);
  assert.equal(afterConcurrent.session.navigation.pane, "repositories");
  assert.equal(afterConcurrent.session.navigation.view, "history");
  await assert.rejects(store.save(session, { expectedRevision: 1 }), (error) => error.code === "REVISION_CONFLICT");

  // Partial JSON and checksum-valid-looking tampering fail soft to defaults;
  // the next atomic update recovers the same scope instead of stalling startup.
  await writeFile(store.path, '{"version":1,"partial":', { mode: 0o600 });
  const corrupt = await store.load();
  assert.equal(corrupt.status, "corrupt");
  assert.deepEqual(corrupt.session, createMissionControlSessionState());
  const recovered = await store.update((current) => ({
    ...current,
    navigation: { ...current.navigation, pane: "details" },
  }));
  assert.equal(recovered.recoveredFrom, "corrupt");
  assert.equal(recovered.revision, 1);
  assert.equal((await store.load()).status, "loaded");

  const tampered = JSON.parse(await readFile(store.path, "utf8"));
  tampered.navigation.pane = "work";
  await writeFile(store.path, `${JSON.stringify(tampered)}\n`);
  assert.equal((await store.load()).status, "corrupt", "payload checksum detects semantic tampering");

  // Oversized files and stale/future sessions also fail soft without parsing
  // attacker-controlled unbounded input.
  await writeFile(store.path, "x".repeat(MISSION_CONTROL_SESSION_MAX_BYTES + 1));
  assert.equal((await store.load()).status, "corrupt");
  await store.update((current) => current);
  now += 31 * 24 * 60 * 60 * 1_000;
  assert.equal((await store.load()).status, "stale");

  const boundedStore = createMissionControlSessionStore({ stateRoot, workspace: workspaceA, repository: "veliqon/bounded", now: clock });
  const receipts = Object.fromEntries(Array.from({ length: 700 }, (_, index) => [
    missionControlLaneKey(repository, `lane-${index}`),
    `claim-${index}`,
  ]));
  const bounded = await boundedStore.save(createMissionControlSessionState({ acknowledgedInputs: receipts }));
  assert.ok(Object.keys(bounded.session.acknowledgedInputs).length <= 512);
  assert.ok((await stat(boundedStore.path)).size <= MISSION_CONTROL_SESSION_MAX_BYTES);

  await boundedStore.clear();
  assert.equal((await boundedStore.load()).status, "missing");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Mission Control session store tests passed: atomic scoped persistence, bounds, corruption recovery, reconciliation, and alert acknowledgements.");
