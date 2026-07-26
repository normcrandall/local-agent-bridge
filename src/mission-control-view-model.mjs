import { createHash } from "node:crypto";
import { missionControlLaneKey } from "./mission-control-event-protocol.mjs";
import { requiresCoordinatorAction, requiresHumanAttention } from "./human-attention-policy.mjs";

export const MISSION_CONTROL_VIEW_TABS = Object.freeze([
  "active",
  "needsYou",
  "queue",
  "reviews",
  "mergeTrain",
  "history",
]);

const ACTIVE = new Set([
  "running", "working", "recovering", "cancelling", "implementing", "validating",
  "reviewing", "integrating", "arbitrating", "publishing",
]);
const QUEUED = new Set([
  "ready", "queued", "waiting", "waiting_capacity", "blocked", "claimed", "planned",
  "pending", "paused", "turn_limit",
]);
const TERMINAL = new Set([
  "agreed", "cancelled", "closed", "complete", "completed", "failed", "merged",
  "superseded", "done", "budget", "indeterminate",
]);
const REVIEW = new Set(["review", "reviewing", "changes_requested", "approved", "re_review"]);
const MERGE_TRAIN = new Set([
  "merge_ready", "queued_for_merge", "merge_queued", "validating", "integrating",
  "arbitrating", "authorized", "merging",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function dateMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function laneStatus(lane) {
  return clean(lane.lifecycle?.phase || lane.lifecyclePhase || lane.status || lane.phase || "unknown").toLowerCase();
}

function laneKey(lane) {
  return missionControlLaneKey(lane.repository, lane.id);
}

function laneText(lane) {
  return [lane.mode, lane.role, lane.kind, lane.task, lane.alias, lane.nextAction]
    .map(clean)
    .join(" ")
    .toLowerCase();
}

function isReview(lane, status) {
  if (REVIEW.has(status)) return true;
  if (clean(lane.mode).toLowerCase() === "review" || clean(lane.role).toLowerCase() === "reviewer") return true;
  return /(?:^|\W)(?:re-?review|reviewer|reviewing)(?:\W|$)/u.test(laneText(lane));
}

function isMergeTrain(lane, status) {
  if (MERGE_TRAIN.has(status)) return true;
  const portfolioStatus = clean(lane.portfolio?.status).toLowerCase();
  if (MERGE_TRAIN.has(portfolioStatus)) return true;
  return lane.mergeTrain?.queued === true || lane.mergeTrain?.status != null;
}

function isTerminal(lane, status) {
  const portfolioStatus = clean(lane.portfolio?.status).toLowerCase();
  return lane.archived === true || TERMINAL.has(status) || TERMINAL.has(portfolioStatus);
}

function completionToken(lane) {
  const identities = [
    ["completion-sequence", lane.completion?.sequence],
    ["completion-id", lane.completion?.id],
    ["completion-at", lane.completion?.completedAt],
    ["terminal-id", lane.terminalId],
    ["terminal-at", lane.terminalAt ?? lane.completedAt ?? lane.finishedAt ?? lane.stoppedAt],
    ["merge-commit", lane.github?.mergeCommitSha],
    ["github-head", lane.github?.headSha],
    ["head", lane.headSha],
  ];
  for (const [kind, value] of identities) {
    const identity = clean(value);
    if (identity) return `${kind}:${identity}`;
  }

  // updatedAt and narrative/heartbeat data are deliberately excluded: they can
  // change after completion without representing a new terminal outcome.
  const stableFacts = JSON.stringify({
    lane: laneKey(lane),
    status: laneStatus(lane),
    createdAt: clean(lane.createdAt) || null,
    startedAt: clean(lane.startedAt) || null,
    runId: clean(lane.runId ?? lane.runtime?.runId) || null,
    attempt: Number.isSafeInteger(lane.attempt) ? lane.attempt : null,
    outcome: clean(lane.completion?.lastHandoff?.outcome ?? lane.outcome).toLowerCase() || null,
  });
  return `terminal-facts:${createHash("sha256").update(stableFacts).digest("hex")}`;
}

function compareCreated(left, right) {
  const repository = left.repository.localeCompare(right.repository);
  if (repository) return repository;
  const leftCreated = dateMs(left.createdAt);
  const rightCreated = dateMs(right.createdAt);
  if (leftCreated !== rightCreated) {
    if (!leftCreated) return 1;
    if (!rightCreated) return -1;
    return leftCreated - rightCreated;
  }
  return left.key.localeCompare(right.key);
}

function orderActive(active, previousOrder, presentKeys) {
  const retained = (Array.isArray(previousOrder) ? previousOrder : []).filter((key) => presentKeys.has(key));
  const retainedSet = new Set(retained);
  const appended = active.filter((lane) => !retainedSet.has(lane.key)).sort(compareCreated).map((lane) => lane.key);
  const order = [...retained, ...appended];
  const rank = new Map(order.map((key, index) => [key, index]));
  return {
    lanes: [...active].sort((left, right) => rank.get(left.key) - rank.get(right.key)),
    order,
  };
}

function normalizedLane(lane, acknowledgedDone) {
  const status = laneStatus(lane);
  const key = laneKey(lane);
  const token = completionToken(lane);
  const terminal = isTerminal(lane, status);
  return {
    ...structuredClone(lane),
    key,
    status,
    terminal,
    doneUnseen: terminal && acknowledgedDone?.[key] !== token,
    completionToken: token,
  };
}

function collectionForTab(collections, tab) {
  return collections[tab] || [];
}

function selectPresent(preferred, values, identity) {
  if (preferred != null && values.some((value) => identity(value) === preferred)) return preferred;
  return values.length ? identity(values[0]) : null;
}

function repositoryRollups(repositories, lanes) {
  const rollups = new Map(repositories.map((repository) => [repository.id, {
    ...structuredClone(repository),
    active: 0,
    needsYou: 0,
    waiting: 0,
    stopped: 0,
    doneUnseen: 0,
  }]));
  for (const lane of lanes) {
    const rollup = rollups.get(lane.repository) || {
      id: lane.repository,
      active: 0,
      needsYou: 0,
      waiting: 0,
      stopped: 0,
      doneUnseen: 0,
    };
    if (lane.category === "active") rollup.active += 1;
    if (lane.category === "needsYou") rollup.needsYou += 1;
    if (lane.category === "queue") rollup.waiting += 1;
    if (lane.category === "history" && lane.terminal && !["merged", "complete", "completed", "done", "closed", "agreed"].includes(lane.status)) {
      rollup.stopped += 1;
    }
    if (lane.doneUnseen) rollup.doneUnseen += 1;
    rollups.set(lane.repository, rollup);
  }
  return [...rollups.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Project reducer-owned event state into the operator-facing Mission Control model.
 * The returned clientState is the only state callers retain between projections.
 */
export function projectMissionControlViewModel(eventState, clientState = {}) {
  if (!eventState || typeof eventState !== "object") throw new Error("Mission Control event state is required.");
  const acknowledgedDone = { ...(clientState.acknowledgedDone || {}) };
  const lanes = Object.values(eventState.lanes || {}).map((lane) => normalizedLane(lane, acknowledgedDone));

  for (const lane of lanes) {
    if (requiresHumanAttention(lane)) lane.category = "needsYou";
    else if (requiresCoordinatorAction(lane)) lane.category = "queue";
    else if (lane.status === "needs_user") lane.category = "history";
    else if (lane.terminal) lane.category = "history";
    else if (ACTIVE.has(lane.status)) lane.category = "active";
    else if (QUEUED.has(lane.status)) lane.category = "queue";
    else lane.category = "queue";
    lane.doneUnseen = lane.category === "history" && lane.doneUnseen;
  }

  const activeOrder = orderActive(
    lanes.filter((lane) => lane.category === "active"),
    clientState.activeOrder,
    new Set(lanes.map((lane) => lane.key)),
  );
  const stable = (values) => [...values].sort(compareCreated);
  const collections = {
    active: activeOrder.lanes,
    needsYou: stable(lanes.filter((lane) => lane.category === "needsYou")),
    queue: stable(lanes.filter((lane) => lane.category === "queue")),
    reviews: stable(lanes.filter((lane) => !lane.terminal && isReview(lane, lane.status))),
    mergeTrain: stable(lanes.filter((lane) => !lane.terminal && isMergeTrain(lane, lane.status))),
    history: stable(lanes.filter((lane) => lane.category === "history")),
  };

  const repositories = repositoryRollups(Object.values(eventState.repositories || {}), lanes);
  const selectedRepository = selectPresent(
    clientState.selectedRepository,
    repositories,
    (repository) => repository.id,
  );
  const selectedTab = MISSION_CONTROL_VIEW_TABS.includes(clientState.selectedTab)
    ? clientState.selectedTab
    : "active";
  const selectable = collectionForTab(collections, selectedTab)
    .filter((lane) => !selectedRepository || lane.repository === selectedRepository);
  const selectedLane = selectPresent(clientState.selectedLane, selectable, (lane) => lane.key);

  const nextClientState = {
    ...structuredClone(clientState),
    activeOrder: activeOrder.order,
    acknowledgedDone,
    selectedRepository,
    selectedTab,
    selectedLane,
  };

  return {
    version: 1,
    streamId: eventState.streamId ?? null,
    cursor: eventState.cursor ?? null,
    updatedAt: eventState.updatedAt ?? null,
    sync: structuredClone(eventState.sync || null),
    repositories,
    portfolios: Object.values(eventState.portfolios || {}).map((portfolio) => structuredClone(portfolio)),
    tabs: MISSION_CONTROL_VIEW_TABS,
    collections,
    selection: {
      repository: selectedRepository,
      tab: selectedTab,
      lane: selectedLane,
    },
    clientState: nextClientState,
  };
}

/** Mark one terminal lane's current completion receipt as seen, locally. */
export function acknowledgeMissionControlDone(clientState, lane) {
  if (!lane || typeof lane !== "object") throw new Error("A terminal Mission Control lane is required.");
  if (!(lane.terminal ?? isTerminal(lane, laneStatus(lane)))) {
    throw new Error("Only a terminal Mission Control lane can be acknowledged as seen.");
  }
  const key = lane.key || laneKey(lane);
  const token = lane.completionToken ?? completionToken(lane);
  if (!key || !clean(token)) throw new Error("The lane has no acknowledgeable completion receipt.");
  return {
    ...structuredClone(clientState || {}),
    acknowledgedDone: {
      ...(clientState?.acknowledgedDone || {}),
      [key]: clean(token),
    },
  };
}

export const projectMissionControlView = projectMissionControlViewModel;
export const acknowledgeMissionControlCompletion = acknowledgeMissionControlDone;
