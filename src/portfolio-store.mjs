import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PORTFOLIO_STATUS_GROUPS } from "./portfolio-status.mjs";

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
