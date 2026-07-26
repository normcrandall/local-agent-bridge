import { PORTFOLIO_STATUS_GROUPS } from "./portfolio-status.mjs";

const TERMINAL = new Set(PORTFOLIO_STATUS_GROUPS.terminal);
const ACTIVE = new Set(PORTFOLIO_STATUS_GROUPS.active);
const INTEGRATION = new Set(PORTFOLIO_STATUS_GROUPS.integration);
const PAUSED = new Set(PORTFOLIO_STATUS_GROUPS.paused);
export const DEFAULT_MAX_PARALLEL = 5;

function strings(value) {
  return [...new Set((value || []).map((item) => String(item).trim()).filter(Boolean))];
}

function contracts(value) {
  return (value || []).map((contract) => {
    if (typeof contract === "string") return { name: contract.trim(), mode: "write", fingerprint: null };
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new Error("Footprint contracts must be strings or objects.");
    const name = String(contract.name || "").trim();
    if (!name) throw new Error("Every footprint contract requires a name.");
    const mode = String(contract.mode || "write").trim();
    if (!["read", "write"].includes(mode)) throw new Error(`Unsupported footprint contract mode: ${mode}`);
    return { name, mode, fingerprint: contract.fingerprint ? String(contract.fingerprint) : null };
  }).filter((contract) => contract.name);
}

export function normalizePortfolioFootprint(value = {}, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A portfolio footprint must be an object.");
  const version = Number(value.version || 1);
  if (!Number.isInteger(version) || version < 1) throw new Error("A portfolio footprint version must be a positive integer.");
  return {
    version,
    paths: strings(value.paths ?? fallback.paths).map((path) => path.replace(/^\.\//, "").replace(/\/+$/, "")),
    symbols: strings(value.symbols),
    contracts: contracts(value.contracts),
    resources: strings(value.resources ?? fallback.resources),
    blockers: strings(value.blockers ?? fallback.blockedBy),
    evidence: value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence)
      ? structuredClone(value.evidence)
      : {},
  };
}

function normalizeItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Portfolio items must be objects.");
  const id = String(value.id || "").trim();
  if (!id) throw new Error("Every portfolio item requires an id.");
  const normalized = {
    ...value,
    id,
    title: String(value.title || id),
    status: value.status || "ready",
    priority: Number.isFinite(Number(value.priority)) ? Number(value.priority) : 0,
    phase: value.phase ? String(value.phase).trim() : null,
    phaseOrder: Number.isFinite(Number(value.phaseOrder)) ? Number(value.phaseOrder) : 0,
    blockedBy: strings(value.blockedBy),
    conflictsWith: strings(value.conflictsWith),
    paths: strings(value.paths).map((path) => path.replace(/^\.\//, "").replace(/\/+$/, "")),
    resources: strings(value.resources),
  };
  return {
    ...normalized,
    footprint: normalizePortfolioFootprint(value.footprint || {}, normalized),
  };
}

function schedulingOrder(left, right) {
  return left.phaseOrder - right.phaseOrder
    || right.priority - left.priority
    || String(left.phase || "").localeCompare(String(right.phase || ""))
    || left.id.localeCompare(right.id);
}

export function normalizePortfolioItems(items) {
  if (!Array.isArray(items)) throw new Error("Portfolio items must be an array.");
  const normalized = items.map(normalizeItem);
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error("Portfolio item ids must be unique.");
  return normalized;
}

function dependencyCycles(items) {
  const ids = new Set(items.map((item) => item.id));
  const dependencies = new Map(items.map((item) => [item.id, item.blockedBy.filter((id) => ids.has(id))]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];
  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of dependencies.get(id) || []) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const item of items) visit(item.id);
  return cycles;
}

function pathOverlap(left, right) {
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function schedulingConflicts(left, right) {
  if (left.id === right.id) {
    if (left.portfolioId && right.portfolioId && left.portfolioId !== right.portfolioId) {
      return [{ type: "duplicate", with: right.id, detail: `issue is already reserved by ${right.portfolioId}` }];
    }
    return [];
  }
  const reasons = [];
  const leftConflicts = strings(left.conflictsWith);
  const rightConflicts = strings(right.conflictsWith);
  if (leftConflicts.includes(right.id) || rightConflicts.includes(left.id)) {
    reasons.push({ type: "conflict", with: right.id, detail: "explicit conflict edge" });
  }
  const leftFootprint = normalizePortfolioFootprint(left.footprint || {}, left);
  const rightFootprint = normalizePortfolioFootprint(right.footprint || {}, right);
  const resource = leftFootprint.resources.find((candidate) => rightFootprint.resources.includes(candidate));
  if (resource) reasons.push({ type: "resource", with: right.id, detail: resource });
  for (const leftPath of leftFootprint.paths) {
    const rightPath = rightFootprint.paths.find((candidate) => pathOverlap(leftPath, candidate));
    if (rightPath) {
      reasons.push({ type: "path", with: right.id, detail: `${leftPath} overlaps ${rightPath}` });
      break;
    }
  }
  const symbol = leftFootprint.symbols.find((candidate) => rightFootprint.symbols.includes(candidate));
  if (symbol) reasons.push({ type: "symbol", with: right.id, detail: symbol });
  for (const leftContract of leftFootprint.contracts) {
    const rightContract = rightFootprint.contracts.find((candidate) => candidate.name === leftContract.name);
    if (!rightContract || (leftContract.mode === "read" && rightContract.mode === "read")) continue;
    if (leftContract.fingerprint && rightContract.fingerprint && leftContract.fingerprint === rightContract.fingerprint) continue;
    reasons.push({
      type: "contract",
      with: right.id,
      detail: `${leftContract.name} has incompatible ${leftContract.mode}/${rightContract.mode} intent`,
    });
  }
  return reasons;
}

function triageCandidates(items, limit = 2) {
  return items
    .filter((item) => !TERMINAL.has(item.status) && !ACTIVE.has(item.status) && !INTEGRATION.has(item.status) && !PAUSED.has(item.status))
    .filter((item) => item.triageStatus !== "triaged")
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .slice(0, limit);
}

export function analyzePortfolio({ items, maxParallel = DEFAULT_MAX_PARALLEL } = {}) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 20) throw new Error("maxParallel must be an integer from 1 to 20.");
  const normalized = normalizePortfolioItems(items || []);
  const cycles = dependencyCycles(normalized);
  if (cycles.length) throw new Error(`Portfolio dependency cycle detected: ${cycles[0].join(" -> ")}`);
  const byId = new Map(normalized.map((item) => [item.id, item]));
  const completed = new Set(normalized.filter((item) => TERMINAL.has(item.status)).map((item) => item.id));
  const active = normalized.filter((item) => ACTIVE.has(item.status));
  const integration = normalized.filter((item) => INTEGRATION.has(item.status));
  const blocked = [];
  const ready = [];
  for (const item of normalized) {
    if (TERMINAL.has(item.status) || ACTIVE.has(item.status) || INTEGRATION.has(item.status)) continue;
    if (PAUSED.has(item.status)) {
      blocked.push({ ...item, reasons: [{ type: "status", detail: `item status is ${item.status}` }] });
      continue;
    }
    const unsatisfied = item.blockedBy.filter((dependency) => !completed.has(dependency));
    if (unsatisfied.length) {
      blocked.push({
        ...item,
        reasons: unsatisfied.map((dependency) => ({
          type: "dependency",
          with: dependency,
          detail: byId.has(dependency) ? "dependency is not complete" : "external dependency is not proven complete",
        })),
      });
    } else ready.push(item);
  }
  ready.sort(schedulingOrder);
  const selected = [];
  const deferred = [];
  const capacity = Math.max(0, maxParallel - active.length);
  const unfinished = normalized.filter((item) => !TERMINAL.has(item.status));
  const currentPhaseOrder = unfinished.length
    ? Math.min(...unfinished.map((item) => item.phaseOrder))
    : null;
  const currentPhase = currentPhaseOrder === null
    ? null
    : [...unfinished]
      .filter((item) => item.phaseOrder === currentPhaseOrder)
      .sort(schedulingOrder)[0]?.phase || null;
  for (const item of ready) {
    const conflicts = [...active, ...integration, ...selected].flatMap((other) => schedulingConflicts(item, other));
    if (conflicts.length) deferred.push({ ...item, reasons: conflicts });
    else if (selected.length >= capacity) deferred.push({ ...item, reasons: [{ type: "capacity", detail: `maxParallel ${maxParallel} reached` }] });
    else {
      const lookahead = currentPhaseOrder !== null && item.phaseOrder > currentPhaseOrder;
      selected.push({
        ...item,
        lookahead,
        lookaheadFromPhase: lookahead ? currentPhase : null,
      });
    }
  }
  return {
    maxParallel,
    capacity,
    currentPhase,
    currentPhaseOrder,
    active,
    integration,
    ready,
    selected,
    blocked,
    deferred,
    triageAhead: triageCandidates(normalized),
  };
}

export function buildExecutionWaves({ items, maxParallel = DEFAULT_MAX_PARALLEL } = {}) {
  let current = normalizePortfolioItems(items || []);
  const waves = [];
  const maximumWaves = current.length + 1;
  for (let attempt = 0; attempt < maximumWaves; attempt += 1) {
    const analysis = analyzePortfolio({ items: current, maxParallel });
    if (!analysis.selected.length) break;
    const ids = analysis.selected.map((item) => item.id);
    waves.push(ids);
    const selected = new Set(ids);
    current = current.map((item) => selected.has(item.id) ? { ...item, status: "merged" } : item);
  }
  return waves;
}
