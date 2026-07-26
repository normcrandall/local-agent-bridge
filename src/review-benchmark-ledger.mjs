import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeReviewEnvelope } from "./review-benchmark-model.mjs";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function serialized(record) {
  return JSON.stringify(stable(record));
}

export function benchmarkRecordIdentity(record) {
  const normalized = normalizeReviewEnvelope(record);
  return `${normalized.repository}\u0000${normalized.headSha}\u0000${normalized.provider}\u0000${normalized.runId}`;
}

async function acquireLock(path) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        const timeout = new Error(`timed out acquiring benchmark ledger lock: ${lockPath}`);
        timeout.code = "BENCHMARK_LEDGER_LOCK_TIMEOUT";
        throw timeout;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

export async function readReviewBenchmarkLedger(path) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return contents.split("\n").filter(Boolean).map((line, index) => {
    try {
      return normalizeReviewEnvelope(JSON.parse(line));
    } catch (error) {
      error.message = `invalid benchmark ledger record at line ${index + 1}: ${error.message}`;
      throw error;
    }
  });
}

export async function appendReviewBenchmarkRecord(path, input) {
  const record = normalizeReviewEnvelope(input);
  await mkdir(dirname(path), { recursive: true });
  const release = await acquireLock(path);
  try {
    const records = await readReviewBenchmarkLedger(path);
    const identity = benchmarkRecordIdentity(record);
    const prior = records.find((entry) => benchmarkRecordIdentity(entry) === identity);
    if (prior) {
      if (serialized(prior) === serialized(record)) {
        return Object.freeze({ appended: false, idempotent: true, record: prior });
      }
      const conflict = new Error(`conflicting benchmark record identity: ${identity}`);
      conflict.code = "BENCHMARK_RECORD_CONFLICT";
      throw conflict;
    }
    const handle = await open(path, "a", 0o600);
    try {
      await handle.write(`${serialized(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return Object.freeze({ appended: true, idempotent: false, record });
  } finally {
    await release();
  }
}
