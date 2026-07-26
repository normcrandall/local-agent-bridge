import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PORTFOLIO_STATUS_GROUPS } from "./portfolio-status.mjs";
import { analyzePortfolio, normalizePortfolioFootprint, schedulingConflicts } from "./portfolio-scheduler.mjs";

const ID = /^helm-[0-9a-f-]{36}$/;

function paths(root, id) {
  if (!ID.test(id)) throw new Error(`Invalid portfolio ID: ${id}`);
  return { state: resolve(root, `${id}.json`), lock: resolve(root, `${id}.lock`) };
}

async function pause(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function acquireLock(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return async () => {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = Number.parseInt(await readFile(path, "utf8"), 10);
        let alive = false;
        if (Number.isInteger(owner) && owner > 1) {
          try { process.kill(owner, 0); alive = true; } catch (processError) { alive = processError.code === "EPERM"; }
        }
        const info = await stat(path);
        if ((!alive && Number.isInteger(owner)) || (!Number.isInteger(owner) && Date.now() - info.mtimeMs > 30_000)) {
          await unlink(path).catch(() => {});
          continue;
        }
      } catch {}
      await pause(10);
    }
  }
  throw new Error(`Timed out acquiring portfolio lock: ${path}`);
}

function repositoryKey(portfolio) {
  return String(portfolio.repository || portfolio.workspace || "unknown").trim().toLowerCase();
}

function repositoryLock(root, portfolio) {
  const digest = createHash("sha256").update(repositoryKey(portfolio)).digest("hex");
  return resolve(root, `repository-${digest}.lock`);
}

function refreshSchedule(state) {
  const schedule = analyzePortfolio({ items: state.items, maxParallel: state.maxParallel });
  const finished = state.items.every((item) => PORTFOLIO_STATUS_GROUPS.terminal.includes(item.status));
  const activeStatuses = [...PORTFOLIO_STATUS_GROUPS.active, ...PORTFOLIO_STATUS_GROUPS.integration];
  const hasActive = state.items.some((item) => activeStatuses.includes(item.status));
  return {
    ...state,
    status: finished ? "complete" : hasActive ? "running" : schedule.selected.length ? "ready" : "blocked",
    schedule,
  };
}

function findItem(portfolio, itemId) {
  const item = portfolio.items.find((candidate) => candidate.id === String(itemId));
  if (!item) throw new Error(`Portfolio item ${itemId} does not exist.`);
  return item;
}

function reservedItems(portfolios, key, { exceptPortfolioId = null, exceptItemId = null } = {}) {
  return portfolios.flatMap((portfolio) => repositoryKey(portfolio) === key
    ? portfolio.items
      .filter((item) => item.footprintReservation?.status === "reserved")
      .filter((item) => portfolio.id !== exceptPortfolioId || item.id !== String(exceptItemId))
      .map((item) => ({ portfolio, item: { ...item, footprint: item.actualFootprint || item.footprint } }))
    : []);
}

function reservationConflicts(candidate, reservations) {
  return reservations.flatMap(({ portfolio, item }) => schedulingConflicts(
    candidate,
    { ...item, portfolioId: portfolio.id },
  ).map((reason) => ({
    ...reason,
    portfolioId: portfolio.id,
    itemId: item.id,
    status: item.status,
    reservedAt: item.footprintReservation?.reservedAt || null,
  })));
}

function accuracy(predicted, actual) {
  const predictedValues = new Set([...(predicted.paths || []), ...(predicted.symbols || []).map((value) => `symbol:${value}`)]);
  const actualValues = new Set([...(actual.paths || []), ...(actual.symbols || []).map((value) => `symbol:${value}`)]);
  const matched = [...actualValues].filter((value) => predictedValues.has(value));
  return {
    predicted: predictedValues.size,
    actual: actualValues.size,
    matched: matched.length,
    precision: predictedValues.size ? matched.length / predictedValues.size : 1,
    recall: actualValues.size ? matched.length / actualValues.size : 1,
    unexpected: [...actualValues].filter((value) => !predictedValues.has(value)),
    unused: [...predictedValues].filter((value) => !actualValues.has(value)),
  };
}

function losesConflict(candidate, reservation) {
  const candidatePriority = Number(candidate.priority || 0);
  const otherPriority = Number(reservation.item.priority || 0);
  if (candidatePriority !== otherPriority) return candidatePriority < otherPriority;
  const candidateAt = candidate.footprintReservation?.reservedAt || "";
  const otherAt = reservation.item.footprintReservation?.reservedAt || "";
  return candidateAt >= otherAt;
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function createPortfolio(root, input) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const id = `helm-${randomUUID()}`;
  const now = new Date().toISOString();
  const state = { ...input, id, revision: 1, status: input.status || "planning", createdAt: now, updatedAt: now };
  await atomicWrite(paths(root, id).state, state);
  return state;
}

export async function readPortfolio(root, id) {
  return JSON.parse(await readFile(paths(root, id).state, "utf8"));
}

export async function updatePortfolio(root, id, expectedRevision, updater) {
  const target = paths(root, id);
  const release = await acquireLock(target.lock);
  try {
    const current = await readPortfolio(root, id);
    if (current.revision !== expectedRevision) {
      throw new Error(`Portfolio revision changed: expected ${expectedRevision}, current ${current.revision}.`);
    }
    const updated = await updater(structuredClone(current));
    const next = {
      ...updated,
      id: current.id,
      createdAt: current.createdAt,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(target.state, next);
    return next;
  } finally {
    await release();
  }
}

export async function listPortfolios(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files = (await readdir(root)).filter((name) => /^helm-[0-9a-f-]{36}\.json$/.test(name));
  const states = await Promise.all(files.map((name) => readPortfolio(root, name.slice(0, -5))));
  return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function listRepositoryFootprintReservations(root, portfolio) {
  const portfolios = await listPortfolios(root);
  const key = repositoryKey(portfolio);
  return portfolios.flatMap((owner) => repositoryKey(owner) === key
    ? owner.items
      .filter((item) => ["reserved", "parked"].includes(item.footprintReservation?.status))
      .map((item) => ({ owner, item }))
    : []).map(({ owner, item }) => ({
    repository: key,
    portfolioId: owner.id,
    itemId: item.id,
    status: item.status,
    stale: ![...PORTFOLIO_STATUS_GROUPS.active, ...PORTFOLIO_STATUS_GROUPS.integration].includes(item.status),
    reservation: item.footprintReservation,
    footprint: item.actualFootprint || item.footprint,
  }));
}

export async function updatePortfolioItemWithFootprintReservation(root, id, expectedRevision, itemId, patch, updater) {
  const inspected = await readPortfolio(root, id);
  const releaseRepository = await acquireLock(repositoryLock(root, inspected));
  try {
    const portfolios = await listPortfolios(root);
    const current = portfolios.find((portfolio) => portfolio.id === id);
    if (!current) throw new Error(`Portfolio ${id} does not exist.`);
    if (current.revision !== expectedRevision) {
      throw new Error(`Portfolio revision changed: expected ${expectedRevision}, current ${current.revision}.`);
    }
    const item = findItem(current, itemId);
    const active = [...PORTFOLIO_STATUS_GROUPS.active, ...PORTFOLIO_STATUS_GROUPS.integration].includes(patch.status);
    const wasActive = [...PORTFOLIO_STATUS_GROUPS.active, ...PORTFOLIO_STATUS_GROUPS.integration].includes(item.status);
    const currentSchedule = current.schedule || analyzePortfolio({ items: current.items, maxParallel: current.maxParallel });
    const scheduledItem = currentSchedule.selected?.find((candidate) => candidate.id === String(itemId)) || null;
    const derivedLookahead = item.phaseOrder !== null
      && item.phaseOrder !== undefined
      && currentSchedule.currentPhaseOrder !== null
      && currentSchedule.currentPhaseOrder !== undefined
      && Number(item.phaseOrder) > Number(currentSchedule.currentPhaseOrder);
    const activationProvenance = active && !wasActive
      ? {
          lookahead: scheduledItem?.lookahead === true || derivedLookahead,
          lookaheadFromPhase: scheduledItem?.lookaheadFromPhase
            || (derivedLookahead ? currentSchedule.currentPhase : null)
            || null,
        }
      : null;
    const terminal = PORTFOLIO_STATUS_GROUPS.terminal.includes(patch.status);
    let reservation = item.footprintReservation || null;
    if (active && reservation?.status !== "reserved") {
      const footprint = normalizePortfolioFootprint(item.actualFootprint || item.footprint || {}, item);
      const candidate = { ...item, portfolioId: id, footprint };
      const conflicts = reservationConflicts(candidate, reservedItems(portfolios, repositoryKey(current), {
        exceptPortfolioId: id,
        exceptItemId: itemId,
      }));
      if (conflicts.length) {
        const error = new Error(`Footprint reservation conflict for ${id}/${itemId}: ${conflicts.map((entry) => `${entry.type} with ${entry.portfolioId}/${entry.itemId} (${entry.detail})`).join("; ")}`);
        error.code = "FOOTPRINT_CONFLICT";
        error.conflicts = conflicts;
        throw error;
      }
      reservation = {
        ...(reservation || {}),
        id: reservation?.id || randomUUID(),
        version: footprint.version,
        repository: repositoryKey(current),
        status: "reserved",
        mode: "shadow",
        enforcement: "deterministic_hard_conflicts",
        reservedAt: reservation?.reservedAt || new Date().toISOString(),
        ...(reservation?.status === "parked" ? { resumedAt: new Date().toISOString() } : {}),
      };
    } else if (terminal && reservation?.status === "reserved") {
      reservation = {
        ...reservation,
        status: "released",
        releasedAt: new Date().toISOString(),
        releaseReason: patch.status,
      };
    }
    return updatePortfolio(root, id, expectedRevision, async (state) => {
      const updated = await updater({
        ...state,
        items: state.items.map((candidate) => candidate.id === String(itemId)
          ? { ...candidate, ...(reservation ? { footprintReservation: reservation } : {}) }
          : candidate),
      });
      if (!activationProvenance) return updated;
      return {
        ...updated,
        items: updated.items.map((candidate) => candidate.id === String(itemId)
          ? { ...candidate, ...activationProvenance }
          : candidate),
      };
    });
  } finally {
    await releaseRepository();
  }
}

export async function reconcilePortfolioItemFootprint(root, id, expectedRevision, itemId, actualInput, { phase = "work" } = {}) {
  const inspected = await readPortfolio(root, id);
  const releaseRepository = await acquireLock(repositoryLock(root, inspected));
  try {
    const portfolios = await listPortfolios(root);
    const current = portfolios.find((portfolio) => portfolio.id === id);
    if (!current) throw new Error(`Portfolio ${id} does not exist.`);
    if (current.revision !== expectedRevision) {
      throw new Error(`Portfolio revision changed: expected ${expectedRevision}, current ${current.revision}.`);
    }
    const item = findItem(current, itemId);
    if (item.footprintReservation?.status !== "reserved") throw new Error(`Portfolio item ${itemId} has no live footprint reservation.`);
    const actualFootprint = normalizePortfolioFootprint({
      ...actualInput,
      version: item.footprint?.version || actualInput?.version || 1,
    }, item.footprint || item);
    const candidate = { ...item, portfolioId: id, footprint: actualFootprint };
    const reservations = reservedItems(portfolios, repositoryKey(current), { exceptPortfolioId: id, exceptItemId: itemId });
    const conflicts = reservationConflicts(candidate, reservations);
    const conflictOwners = new Map(reservations.map((entry) => [`${entry.portfolio.id}:${entry.item.id}`, entry]));
    const losingOthers = new Map();
    let currentLoses = false;
    for (const conflict of conflicts) {
      const owner = conflictOwners.get(`${conflict.portfolioId}:${conflict.itemId}`);
      if (!owner) continue;
      if (losesConflict({ ...candidate, footprintReservation: item.footprintReservation }, owner)) currentLoses = true;
      else losingOthers.set(`${owner.portfolio.id}:${owner.item.id}`, owner);
    }
    if (currentLoses) losingOthers.clear();
    const samePortfolioLosers = new Set();
    for (const owner of losingOthers.values()) {
      if (owner.portfolio.id === id) {
        samePortfolioLosers.add(owner.item.id);
        continue;
      }
      await updatePortfolio(root, owner.portfolio.id, owner.portfolio.revision, (state) => refreshSchedule({
        ...state,
        items: state.items.map((other) => other.id === owner.item.id ? {
          ...other,
          status: "blocked",
          summary: `Parked after a newer actual footprint conflicted with higher-priority ${id}/${itemId}; work preserved.`,
          footprintReservation: {
            ...other.footprintReservation,
            status: "parked",
            parkedAt: new Date().toISOString(),
          },
          footprintConflict: { withPortfolioId: id, withItemId: String(itemId), detectedAt: new Date().toISOString(), phase },
        } : other),
      }));
    }
    const reconciledAt = new Date().toISOString();
    const updated = await updatePortfolio(root, id, expectedRevision, (state) => refreshSchedule({
      ...state,
      items: state.items.map((candidateItem) => {
        if (samePortfolioLosers.has(candidateItem.id)) return {
          ...candidateItem,
          status: "blocked",
          summary: `Parked after a newer actual footprint conflicted with higher-priority ${id}/${itemId}; work preserved.`,
          footprintReservation: {
            ...candidateItem.footprintReservation,
            status: "parked",
            parkedAt: reconciledAt,
          },
          footprintConflict: { withPortfolioId: id, withItemId: String(itemId), detectedAt: reconciledAt, phase },
        };
        return candidateItem.id === String(itemId) ? {
          ...candidateItem,
          ...(currentLoses ? {
            status: "blocked",
            summary: "Parked because its actual footprint conflicts with an older or higher-priority reserved lane; work preserved.",
            footprintReservation: {
              ...candidateItem.footprintReservation,
              status: "parked",
              parkedAt: reconciledAt,
            },
          } : {}),
          actualFootprint,
          footprintReconciliation: {
            phase,
            reconciledAt,
            accuracy: accuracy(normalizePortfolioFootprint(candidateItem.footprint || {}, candidateItem), actualFootprint),
            conflicts,
            disposition: currentLoses ? "parked" : losingOthers.size ? "continued_and_parked_conflicts" : "continued",
          },
        } : candidateItem;
      }),
    }));
    return { portfolio: updated, item: findItem(updated, itemId), parked: currentLoses, conflicts };
  } finally {
    await releaseRepository();
  }
}

export async function archivePortfolio(root, id, { expectedRevision = null } = {}) {
  const target = paths(root, id);
  const release = await acquireLock(target.lock);
  try {
    const state = await readPortfolio(root, id);
    if (!Number.isInteger(expectedRevision)) {
      throw new Error(`Cannot archive portfolio ${id}: an audited revision is required.`);
    }
    if (state.revision !== expectedRevision) {
      throw new Error(`Cannot archive portfolio ${id}: revision changed after cleanup audit.`);
    }
    const items = Array.isArray(state.items) ? state.items : [];
    const terminal = state.status === "complete"
      && items.every((item) => PORTFOLIO_STATUS_GROUPS.terminal.includes(item.status));
    if (!terminal) throw new Error(`Cannot archive portfolio ${id} while status is ${state.status || "unknown"}.`);
    const archive = resolve(root, "archive");
    await mkdir(archive, { recursive: true, mode: 0o700 });
    await rename(target.state, resolve(archive, `${id}.json`));
    return { id, archived: true, status: state.status, itemCount: items.length, archive };
  } finally {
    await release();
  }
}
