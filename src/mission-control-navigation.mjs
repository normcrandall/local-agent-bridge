export const MISSION_CONTROL_NAVIGATION_VERSION = 1;
export const MISSION_CONTROL_NAVIGATION_VIEWS = Object.freeze([
  "active",
  "needsYou",
  "queue",
  "reviews",
  "mergeTrain",
  "history",
  "portfolios",
]);
export const MISSION_CONTROL_NAVIGATION_PANES = Object.freeze(["repositories", "work", "details"]);

const DEFAULT_VIEW = "active";
const DEFAULT_PANE = "work";
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_SERIALIZED_BYTES = 64 * 1_024;
const MAX_ORDER_ENTRIES = 256;
const MAX_RECEIPTS = 512;
const MAX_ID_LENGTH = 256;

function cleanId(value) {
  if (typeof value !== "string") return null;
  const valueClean = value.trim();
  return valueClean && valueClean.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f]/u.test(valueClean)
    ? valueClean
    : null;
}

function laneKey(lane) {
  const explicit = cleanId(lane?.key);
  if (explicit) return explicit;
  const repository = cleanId(lane?.repository);
  const id = cleanId(lane?.id);
  return repository && id ? `${repository}:${id}` : id;
}

function portfolioId(value) {
  return cleanId(value?.portfolio?.portfolioId ?? value?.portfolio?.id ?? value?.portfolioId ?? value?.id);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function boundedIds(values, limit = MAX_ORDER_ENTRIES) {
  return unique((Array.isArray(values) ? values : []).map(cleanId)).slice(0, limit);
}

function nearest(previousOrder, previousSelection, currentOrder) {
  if (!currentOrder.length) return null;
  if (previousSelection && currentOrder.includes(previousSelection)) return previousSelection;
  const previousIndex = previousOrder.indexOf(previousSelection);
  if (previousIndex < 0) return currentOrder[0];
  return currentOrder[Math.min(previousIndex, currentOrder.length - 1)];
}

function stableOrder(previousOrder, currentIds) {
  const current = new Set(currentIds);
  const retained = boundedIds(previousOrder).filter((id) => current.has(id));
  const retainedSet = new Set(retained);
  return [...retained, ...currentIds.filter((id) => !retainedSet.has(id))].slice(0, MAX_ORDER_ENTRIES);
}

function collection(model, view) {
  if (view !== "portfolios") return Array.isArray(model?.collections?.[view]) ? model.collections[view] : [];
  const collections = model?.collections || {};
  const combined = ["active", "needsYou", "queue", "history"]
    .flatMap((name) => Array.isArray(collections[name]) ? collections[name] : []);
  const seen = new Set();
  return combined.filter((lane) => {
    const key = laneKey(lane);
    if (!key || seen.has(key) || !portfolioId(lane)) return false;
    seen.add(key);
    return true;
  });
}

function repositoriesFor(model) {
  const declared = (Array.isArray(model?.repositories) ? model.repositories : [])
    .map((entry) => cleanId(typeof entry === "string" ? entry : entry?.id));
  const lanes = Object.values(model?.collections || {}).flatMap((entries) => Array.isArray(entries) ? entries : []);
  return unique([...declared, ...lanes.map((lane) => cleanId(lane?.repository))]);
}

function portfoliosFor(model, repository) {
  const declared = Array.isArray(model?.portfolios)
    ? model.portfolios
    : Object.values(model?.portfolios || {});
  const fromCollections = Object.values(model?.collections || {})
    .flatMap((entries) => Array.isArray(entries) ? entries : []);
  return unique([...declared, ...fromCollections]
    .filter((entry) => !repository || cleanId(entry?.repository) === repository)
    .map(portfolioId));
}

function scopeKey(state) {
  return [state.view, state.repository || "*", state.portfolio || "*"].join("|");
}

function safeReceipts(receipts) {
  if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)) return {};
  return Object.fromEntries(Object.entries(receipts)
    .map(([key, token]) => [cleanId(key), cleanId(token)])
    .filter(([key, token]) => key && token)
    .slice(-MAX_RECEIPTS));
}

function safeOrders(orders) {
  if (!orders || typeof orders !== "object" || Array.isArray(orders)) return {};
  return Object.fromEntries(Object.entries(orders)
    .map(([key, values]) => [cleanId(key), boundedIds(values)])
    .filter(([key, values]) => key && values.length)
    .slice(-MAX_ORDER_ENTRIES));
}

export function createMissionControlNavigationState(overrides = {}) {
  const view = MISSION_CONTROL_NAVIGATION_VIEWS.includes(overrides.view) ? overrides.view : DEFAULT_VIEW;
  const pane = MISSION_CONTROL_NAVIGATION_PANES.includes(overrides.pane) ? overrides.pane : DEFAULT_PANE;
  return {
    version: MISSION_CONTROL_NAVIGATION_VERSION,
    view,
    pane,
    repository: cleanId(overrides.repository),
    portfolio: cleanId(overrides.portfolio),
    lane: cleanId(overrides.lane),
    repositoryOrder: boundedIds(overrides.repositoryOrder),
    portfolioOrder: boundedIds(overrides.portfolioOrder),
    laneOrderByScope: safeOrders(overrides.laneOrderByScope),
    seenCompletions: safeReceipts(overrides.seenCompletions),
  };
}

/**
 * Reconcile local navigation with a policy-neutral Mission Control projection.
 * Existing rows retain their prior order, so heartbeat/narrative timestamps
 * cannot move focus. If focus disappears, the row at its former index wins,
 * falling back to the preceding final row when the list became shorter.
 */
export function reconcileMissionControlNavigation(previous, model) {
  const state = createMissionControlNavigationState(previous);
  const repositories = stableOrder(state.repositoryOrder, repositoriesFor(model));
  const repository = state.repository == null
    ? null
    : nearest(state.repositoryOrder, state.repository, repositories);

  const portfolioIds = stableOrder(state.portfolioOrder, portfoliosFor(model, repository));
  const portfolio = state.portfolio == null
    ? null
    : nearest(state.portfolioOrder, state.portfolio, portfolioIds);
  const scoped = { ...state, repository, portfolio };
  const scope = scopeKey(scoped);
  const candidates = collection(model, state.view).filter((lane) => {
    if (repository && cleanId(lane.repository) !== repository) return false;
    if (portfolio && portfolioId(lane) !== portfolio) return false;
    return Boolean(laneKey(lane));
  });
  const candidateByKey = new Map(candidates.map((lane) => [laneKey(lane), lane]));
  const candidateIds = unique(candidates.map(laneKey));
  const previousLaneOrder = state.laneOrderByScope[scope] || [];
  const laneOrder = stableOrder(previousLaneOrder, candidateIds);
  const lane = nearest(previousLaneOrder, state.lane, laneOrder);

  return {
    state: {
      ...scoped,
      lane,
      repositoryOrder: repositories,
      portfolioOrder: portfolioIds,
      laneOrderByScope: { ...state.laneOrderByScope, [scope]: laneOrder },
    },
    repositories,
    portfolios: portfolioIds,
    lanes: laneOrder.map((key) => candidateByKey.get(key)).filter(Boolean),
    selectedLane: lane ? candidateByKey.get(lane) || null : null,
  };
}

export function updateMissionControlNavigation(state, patch = {}) {
  const next = createMissionControlNavigationState({ ...state, ...patch });
  if (Object.hasOwn(patch, "repository")) {
    next.repository = cleanId(patch.repository);
    next.portfolio = null;
    next.lane = null;
  }
  if (Object.hasOwn(patch, "portfolio")) {
    next.portfolio = cleanId(patch.portfolio);
    next.lane = null;
  }
  if (Object.hasOwn(patch, "view")) next.lane = null;
  return next;
}

export function moveMissionControlLane(state, model, delta) {
  const reconciled = reconcileMissionControlNavigation(state, model);
  if (!reconciled.lanes.length) return reconciled.state;
  const current = reconciled.lanes.findIndex((lane) => laneKey(lane) === reconciled.state.lane);
  const offset = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const index = Math.min(Math.max(0, current + offset), reconciled.lanes.length - 1);
  return { ...reconciled.state, lane: laneKey(reconciled.lanes[index]) };
}

export function missionControlCompletionIsUnseen(state, lane) {
  const key = laneKey(lane);
  const token = cleanId(lane?.completionToken);
  return Boolean(key && token && state?.seenCompletions?.[key] !== token);
}

export function markMissionControlCompletionSeen(state, lane) {
  const key = laneKey(lane);
  const token = cleanId(lane?.completionToken);
  if (!key || !token) throw new Error("A lane key and completion token are required.");
  return createMissionControlNavigationState({
    ...state,
    seenCompletions: { ...state?.seenCompletions, [key]: token },
  });
}

/** Serialize only bounded navigation identities; model/provider content is never accepted. */
export function serializeMissionControlNavigation(state, { now = Date.now() } = {}) {
  const safe = createMissionControlNavigationState(state);
  const serialized = JSON.stringify({ ...safe, savedAt: new Date(now).toISOString() });
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) {
    throw new Error("Mission Control navigation state exceeds the persistence limit.");
  }
  return serialized;
}

export function restoreMissionControlNavigation(serialized, {
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const defaults = createMissionControlNavigationState();
  try {
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) return defaults;
    const parsed = JSON.parse(serialized);
    if (!parsed || parsed.version !== MISSION_CONTROL_NAVIGATION_VERSION) return defaults;
    const savedAt = Date.parse(parsed.savedAt || "");
    if (!Number.isFinite(savedAt) || savedAt > now + 60_000 || now - savedAt > maxAgeMs) return defaults;
    return createMissionControlNavigationState(parsed);
  } catch {
    return defaults;
  }
}
