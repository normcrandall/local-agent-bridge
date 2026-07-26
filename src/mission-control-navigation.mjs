import { missionControlLaneKey, requiredIdentifier } from "./mission-control-event-protocol.mjs";

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
const MAX_LANE_ORDER_ENTRIES = 256;
const MAX_RECEIPTS = 512;
const MAX_LANE_KEY_LENGTH = (512 * 2) + 1;
const MAX_TOKEN_LENGTH = 2_048;
// JSON escaping can expand each protocol-valid identifier character to six
// bytes, so two 512-character components need more than their raw size.
const MAX_SCOPE_LENGTH = 8_192;

function cleanIdentifier(value) {
  try {
    return requiredIdentifier(value, "navigation identifier");
  } catch {
    return null;
  }
}

function cleanLaneKey(value) {
  if (typeof value !== "string" || value.length > MAX_LANE_KEY_LENGTH) return null;
  const separator = value.indexOf("\0");
  if (separator < 1 || separator !== value.lastIndexOf("\0")) return null;
  try {
    return missionControlLaneKey(value.slice(0, separator), value.slice(separator + 1));
  } catch {
    return null;
  }
}

function cleanToken(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TOKEN_LENGTH || /[\0\r\n]/u.test(value)) return null;
  return value;
}

function cleanScope(value) {
  if (typeof value !== "string" || !value || value.length > MAX_SCOPE_LENGTH || /[\0\r\n]/u.test(value)) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 3 || !MISSION_CONTROL_NAVIGATION_VIEWS.includes(parsed[0])) return null;
    const repository = parsed[1] == null ? null : cleanIdentifier(parsed[1]);
    const portfolio = parsed[2] == null ? null : cleanIdentifier(parsed[2]);
    if ((parsed[1] != null && !repository) || (parsed[2] != null && !portfolio)) return null;
    return JSON.stringify([parsed[0], repository, portfolio]);
  } catch {
    return null;
  }
}

function laneKey(lane) {
  try {
    return missionControlLaneKey(lane?.repository, lane?.id);
  } catch {
    return null;
  }
}

function declaredPortfolioId(value) {
  return cleanIdentifier(value?.portfolioId ?? value?.id);
}

function lanePortfolioId(value) {
  return cleanIdentifier(value?.portfolio?.portfolioId ?? value?.portfolio?.id ?? value?.portfolioId);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function bounded(values, normalize, limit = MAX_ORDER_ENTRIES) {
  return unique((Array.isArray(values) ? values : []).map(normalize)).slice(0, limit);
}

function nearest(previousOrder, previousSelection, currentOrder) {
  if (!currentOrder.length) return null;
  if (previousSelection && currentOrder.includes(previousSelection)) return previousSelection;
  const previousIndex = previousOrder.indexOf(previousSelection);
  if (previousIndex < 0) return currentOrder[0];
  return currentOrder[Math.min(previousIndex, currentOrder.length - 1)];
}

function stableOrder(previousOrder, currentIds, normalize) {
  const current = new Set(currentIds);
  const retained = bounded(previousOrder, normalize).filter((id) => current.has(id));
  const retainedSet = new Set(retained);
  return [...retained, ...currentIds.filter((id) => !retainedSet.has(id))];
}

function collection(model, view) {
  if (view !== "portfolios") return Array.isArray(model?.collections?.[view]) ? model.collections[view] : [];
  const collections = model?.collections || {};
  const combined = ["active", "needsYou", "queue", "history"]
    .flatMap((name) => Array.isArray(collections[name]) ? collections[name] : []);
  const seen = new Set();
  return combined.filter((lane) => {
    const key = laneKey(lane);
    if (!key || seen.has(key) || !lanePortfolioId(lane)) return false;
    seen.add(key);
    return true;
  });
}

function repositoriesFor(model) {
  const declared = (Array.isArray(model?.repositories) ? model.repositories : [])
    .map((entry) => cleanIdentifier(typeof entry === "string" ? entry : entry?.id));
  const lanes = Object.values(model?.collections || {}).flatMap((entries) => Array.isArray(entries) ? entries : []);
  return unique([...declared, ...lanes.map((lane) => cleanIdentifier(lane?.repository))]);
}

function portfoliosFor(model, repository) {
  const declared = Array.isArray(model?.portfolios)
    ? model.portfolios
    : Object.values(model?.portfolios || {});
  const fromCollections = Object.values(model?.collections || {})
    .flatMap((entries) => Array.isArray(entries) ? entries : []);
  const declaredIds = declared
    .filter((entry) => !repository || cleanIdentifier(entry?.repository) === repository)
    .map(declaredPortfolioId);
  const laneIds = fromCollections
    .filter((entry) => !repository || cleanIdentifier(entry?.repository) === repository)
    .map(lanePortfolioId);
  return unique([...declaredIds, ...laneIds]);
}

function scopeKey(state) {
  return JSON.stringify([state.view, state.repository, state.portfolio]);
}

function safeReceipts(receipts) {
  if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)) return {};
  return Object.fromEntries(Object.entries(receipts)
    .map(([key, token]) => [cleanLaneKey(key), cleanToken(token)])
    .filter(([key, token]) => key && token)
    .slice(-MAX_RECEIPTS));
}

function safeOrders(orders) {
  if (!orders || typeof orders !== "object" || Array.isArray(orders)) return {};
  return Object.fromEntries(Object.entries(orders)
    .map(([key, values]) => [cleanScope(key), bounded(values, cleanLaneKey, MAX_LANE_ORDER_ENTRIES)])
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
    repository: cleanIdentifier(overrides.repository),
    portfolio: cleanIdentifier(overrides.portfolio),
    lane: cleanLaneKey(overrides.lane),
    repositoryOrder: bounded(overrides.repositoryOrder, cleanIdentifier),
    portfolioOrder: bounded(overrides.portfolioOrder, cleanIdentifier),
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
  const repositories = stableOrder(state.repositoryOrder, repositoriesFor(model), cleanIdentifier);
  const repository = state.repository == null
    ? null
    : nearest(state.repositoryOrder, state.repository, repositories);

  const portfolioIds = stableOrder(state.portfolioOrder, portfoliosFor(model, repository), cleanIdentifier);
  const portfolio = state.portfolio == null
    ? null
    : nearest(state.portfolioOrder, state.portfolio, portfolioIds);
  const scoped = { ...state, repository, portfolio };
  const scope = scopeKey(scoped);
  const candidates = collection(model, state.view).filter((lane) => {
    if (repository && cleanIdentifier(lane.repository) !== repository) return false;
    if (portfolio && lanePortfolioId(lane) !== portfolio) return false;
    return Boolean(laneKey(lane));
  });
  const candidateByKey = new Map(candidates.map((lane) => [laneKey(lane), lane]));
  const candidateIds = unique(candidates.map(laneKey));
  const previousLaneOrder = state.laneOrderByScope[scope] || [];
  const laneOrder = stableOrder(previousLaneOrder, candidateIds, cleanLaneKey);
  const lane = nearest(previousLaneOrder, state.lane, laneOrder);

  return {
    state: {
      ...scoped,
      lane,
      repositoryOrder: repositories.slice(0, MAX_ORDER_ENTRIES),
      portfolioOrder: portfolioIds.slice(0, MAX_ORDER_ENTRIES),
      laneOrderByScope: Object.fromEntries([
        ...Object.entries(state.laneOrderByScope).filter(([key]) => key !== scope),
        [scope, laneOrder.slice(0, MAX_LANE_ORDER_ENTRIES)],
      ]),
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
    next.repository = cleanIdentifier(patch.repository);
    next.portfolio = null;
    next.lane = null;
  }
  if (Object.hasOwn(patch, "portfolio")) {
    next.portfolio = cleanIdentifier(patch.portfolio);
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
  const token = cleanToken(lane?.completionToken);
  return lane?.terminal === true && Boolean(key && token && state?.seenCompletions?.[key] !== token);
}

export function markMissionControlCompletionSeen(state, lane) {
  const key = laneKey(lane);
  const token = cleanToken(lane?.completionToken);
  if (lane?.terminal !== true || !key || !token) throw new Error("A terminal lane key and completion token are required.");
  const previousReceipts = Object.entries(state?.seenCompletions || {}).filter(([receiptKey]) => receiptKey !== key);
  return createMissionControlNavigationState({
    ...state,
    seenCompletions: Object.fromEntries([...previousReceipts, [key, token]]),
  });
}

/** Serialize only bounded navigation identities; model/provider content is never accepted. */
export function serializeMissionControlNavigation(state, { now = Date.now() } = {}) {
  const safe = structuredClone(createMissionControlNavigationState(state));
  const savedAt = new Date(now).toISOString();
  const render = () => JSON.stringify({ ...safe, savedAt });
  let serialized = render();
  const shedOldest = (record) => {
    const oldest = Object.keys(record)[0];
    if (!oldest) return false;
    delete record[oldest];
    return true;
  };
  const shedOldestInactiveScope = () => {
    const activeScope = scopeKey(safe);
    const oldest = Object.keys(safe.laneOrderByScope).find((key) => key !== activeScope);
    if (!oldest) return false;
    delete safe.laneOrderByScope[oldest];
    return true;
  };
  while (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) {
    if (!shedOldestInactiveScope()
      && !safe.repositoryOrder.shift()
      && !safe.portfolioOrder.shift()
      && !shedOldest(safe.laneOrderByScope)
      && !shedOldest(safe.seenCompletions)) {
      throw new Error("Mission Control navigation state exceeds the persistence limit.");
    }
    serialized = render();
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
