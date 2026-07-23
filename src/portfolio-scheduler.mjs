import { PORTFOLIO_STATUS_GROUPS } from "./portfolio-status.mjs";

const TERMINAL = new Set(PORTFOLIO_STATUS_GROUPS.terminal);
const ACTIVE = new Set(PORTFOLIO_STATUS_GROUPS.active);
const INTEGRATION = new Set(PORTFOLIO_STATUS_GROUPS.integration);
const PAUSED = new Set(PORTFOLIO_STATUS_GROUPS.paused);

function strings(value) {
  return [...new Set((value || []).map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Portfolio items must be objects.");
  const id = String(value.id || "").trim();
  if (!id) throw new Error("Every portfolio item requires an id.");
  return {
    ...value,
    id,
    title: String(value.title || id),
    status: value.status || "ready",
    priority: Number.isFinite(Number(value.priority)) ? Number(value.priority) : 0,
    blockedBy: strings(value.blockedBy),
    conflictsWith: strings(value.conflictsWith),
    paths: strings(value.paths).map((path) => path.replace(/^\.\//, "").replace(/\/+$/, "")),
    resources: strings(value.resources),
  };
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
  if (left.id === right.id) return [];
  const reasons = [];
  if (left.conflictsWith.includes(right.id) || right.conflictsWith.includes(left.id)) {
    reasons.push({ type: "conflict", with: right.id, detail: "explicit conflict edge" });
  }
  const resource = left.resources.find((candidate) => right.resources.includes(candidate));
  if (resource) reasons.push({ type: "resource", with: right.id, detail: resource });
  for (const leftPath of left.paths) {
    const rightPath = right.paths.find((candidate) => pathOverlap(leftPath, candidate));
    if (rightPath) {
      reasons.push({ type: "path", with: right.id, detail: `${leftPath} overlaps ${rightPath}` });
      break;
    }
  }
  return reasons;
}

export function analyzePortfolio({ items, maxParallel = 2 } = {}) {
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
  ready.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const selected = [];
  const deferred = [];
  const capacity = Math.max(0, maxParallel - active.length);
  for (const item of ready) {
    const conflicts = [...active, ...integration, ...selected].flatMap((other) => schedulingConflicts(item, other));
    if (conflicts.length) deferred.push({ ...item, reasons: conflicts });
    else if (selected.length >= capacity) deferred.push({ ...item, reasons: [{ type: "capacity", detail: `maxParallel ${maxParallel} reached` }] });
    else selected.push(item);
  }
  return { maxParallel, capacity, active, integration, ready, selected, blocked, deferred };
}

export function buildExecutionWaves({ items, maxParallel = 2 } = {}) {
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
