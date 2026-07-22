import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const INDEX_VERSION = 1;
const LOCK_STALE_MS = 30_000;
const REUSABLE_ATTESTATIONS = new Set(["authoritative", "observed"]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function serialized(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return createHash("sha256").update(serialized(value)).digest("hex");
}

function validateScope(scope = {}) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new Error("Evidence scope must be an object.");
  if (scope.repository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repository)) {
    throw new Error("Evidence repository scope must be owner/name.");
  }
  for (const field of ["headSha", "baseSha"]) {
    if (scope[field] !== undefined && !/^[0-9a-f]{40}$/i.test(scope[field])) {
      throw new Error(`${field} must be a 40-character Git SHA.`);
    }
  }
  return canonicalize(scope);
}

function identity({ kind, key, scope }) {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(kind || "")) throw new Error("Evidence kind must be a stable snake_case name.");
  if (!String(key || "").trim()) throw new Error("Evidence key is required.");
  return digest({ kind, key: String(key), scope: validateScope(scope) });
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function pause(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function acquireLock(path) {
  const token = randomUUID();
  for (let attempt = 0; attempt < 1_400; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`);
      return async () => {
        await handle.close().catch(() => {});
        try {
          const current = JSON.parse(await readFile(path, "utf8"));
          if (current.token === token) await unlink(path);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const rawOwner = await readFile(path, "utf8");
        let owner = null;
        try { owner = JSON.parse(rawOwner); } catch { owner = { pid: Number.parseInt(rawOwner, 10) }; }
        let ownerAlive = false;
        if (Number.isInteger(owner?.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
            ownerAlive = true;
          } catch (processError) {
            ownerAlive = processError.code === "EPERM";
          }
        }
        const info = await stat(path);
        if (!ownerAlive && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(path).catch(() => {});
          continue;
        }
      } catch {}
      await pause(25);
    }
  }
  throw new Error(`Timed out acquiring evidence-store lock: ${path}`);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function verificationKey({ command, cwd, environmentFingerprint }) {
  return serialized({ command: String(command), cwd: String(cwd || "."), environmentFingerprint: String(environmentFingerprint) });
}

export function createEvidenceStore({ directory, now = () => new Date().toISOString() } = {}) {
  if (!directory) throw new Error("Evidence store directory is required.");
  const root = resolve(directory);
  const objects = resolve(root, "objects");
  const indexPath = resolve(root, "index.json");
  const lockPath = resolve(root, "index.lock");
  const counters = { hits: 0, misses: 0, writes: 0, avoidedLoads: 0, refreshes: 0 };
  const inFlightLoads = new Map();

  async function initialize() {
    await mkdir(objects, { recursive: true, mode: 0o700 });
  }

  async function readIndex() {
    const index = await readJson(indexPath, { version: INDEX_VERSION, entries: {} });
    if (index.version !== INDEX_VERSION || !index.entries || typeof index.entries !== "object") {
      throw new Error("Unsupported evidence-store index.");
    }
    return index;
  }

  async function put({ kind, key, scope = {}, value, source = "unknown", metadata = {} }) {
    await initialize();
    const normalizedScope = validateScope(scope);
    const entryId = identity({ kind, key, scope: normalizedScope });
    const recordedAt = now();
    const object = { version: 1, kind, key: String(key), scope: normalizedScope, source, recordedAt, metadata, value };
    const objectDigest = digest(object);
    const objectPath = resolve(objects, `${objectDigest}.json`);
    // Publish immutable objects with a same-directory rename. Concurrent writers of
    // the same digest have identical bytes, so replacing the destination is safe and
    // readers can never observe a partially flushed JSON document.
    await atomicJson(objectPath, object);
    const release = await acquireLock(lockPath);
    try {
      const index = await readIndex();
      index.entries[entryId] = {
        id: entryId,
        kind,
        key: String(key),
        scope: normalizedScope,
        source,
        recordedAt,
        digest: objectDigest,
      };
      await atomicJson(indexPath, index);
    } finally {
      await release();
    }
    counters.writes += 1;
    return { ...object, digest: objectDigest };
  }

  async function get({ kind, key, scope = {} }) {
    await initialize();
    const entryId = identity({ kind, key, scope });
    const index = await readIndex();
    const entry = index.entries[entryId];
    if (!entry) {
      counters.misses += 1;
      return null;
    }
    try {
      const object = JSON.parse(await readFile(resolve(objects, `${entry.digest}.json`), "utf8"));
      counters.hits += 1;
      return { ...object, digest: entry.digest };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      counters.misses += 1;
      return null;
    }
  }

  async function getOrLoad({ kind, key, scope = {}, source = "unknown", metadata = {}, maxAgeMs = null, load }) {
    if (typeof load !== "function") throw new Error("Evidence cache load callback is required.");
    if (maxAgeMs !== null && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)) {
      throw new Error("Evidence cache maxAgeMs must be a non-negative number or null.");
    }
    const loadId = `${identity({ kind, key, scope })}:${maxAgeMs ?? "unbounded"}`;
    const existing = inFlightLoads.get(loadId);
    if (existing) {
      counters.avoidedLoads += 1;
      return { ...(await existing), cache: "coalesced" };
    }
    const operation = (async () => {
      const cached = await get({ kind, key, scope });
      const cachedAt = cached ? Date.parse(cached.recordedAt) : Number.NaN;
      const currentAt = Date.parse(now());
      const fresh = cached && (maxAgeMs === null || (
        Number.isFinite(cachedAt)
        && Number.isFinite(currentAt)
        && currentAt - cachedAt <= maxAgeMs
      ));
      if (fresh) {
        counters.avoidedLoads += 1;
        return { ...cached, cache: "hit" };
      }
      if (cached) counters.refreshes += 1;
      const value = await load();
      return { ...(await put({ kind, key, scope, source, metadata, value })), cache: cached ? "refresh" : "miss" };
    })();
    inFlightLoads.set(loadId, operation);
    try {
      return await operation;
    } finally {
      if (inFlightLoads.get(loadId) === operation) inFlightLoads.delete(loadId);
    }
  }

  async function recordVerificationReceipt(receipt) {
    const required = ["repository", "headSha", "command", "environmentFingerprint", "startedAt", "completedAt", "source", "attestation"];
    for (const field of required) if (!String(receipt?.[field] ?? "").trim()) throw new Error(`Verification receipt ${field} is required.`);
    if (!Number.isInteger(receipt.exitCode)) throw new Error("Verification receipt exitCode must be an integer.");
    const startedAt = Date.parse(receipt.startedAt);
    const completedAt = Date.parse(receipt.completedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
      throw new Error("Verification receipt timestamps must be valid and completedAt must not precede startedAt.");
    }
    const scope = validateScope({ repository: receipt.repository, headSha: receipt.headSha });
    const key = verificationKey(receipt);
    return put({ kind: "verification_receipt", key, scope, source: receipt.source, value: { ...receipt, cwd: receipt.cwd || "." } });
  }

  async function findReusableVerification(query) {
    const scope = validateScope({ repository: query.repository, headSha: query.headSha });
    const found = await get({ kind: "verification_receipt", key: verificationKey(query), scope });
    if (!found) return null;
    const receipt = found.value;
    if (receipt.exitCode !== 0 || !REUSABLE_ATTESTATIONS.has(receipt.attestation)) return null;
    return receipt;
  }

  async function manifest(scope = {}) {
    await initialize();
    const normalizedScope = validateScope(scope);
    const index = await readIndex();
    const entries = Object.values(index.entries)
      .filter((entry) => serialized(entry.scope) === serialized(normalizedScope))
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key));
    return { version: INDEX_VERSION, scope: normalizedScope, entries };
  }

  return {
    put,
    get,
    getOrLoad,
    recordVerificationReceipt,
    findReusableVerification,
    manifest,
    metrics: () => ({ ...counters }),
  };
}
