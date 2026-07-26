import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createRepositoryJournal } from "./repository-journal.mjs";
import { createRepositoryJournalOutbox } from "./repository-journal-outbox.mjs";
import { compactGitHubLifecycleSummary } from "./github-lifecycle.mjs";

export const REPOSITORY_RUNTIME_JOURNAL_VERSION = 1;

export function shouldCheckpointWorkerFailure(error) {
  return error?.code !== "REPOSITORY_LIFECYCLE_PUBLICATION_REJECTED";
}

const SHA = /^[0-9a-f]{40}$/i;
const TERMINAL_PHASES = new Set(["completed", "failed", "indeterminate", "cancelled", "obsolete", "merged"]);

function required(value, name, maximum = 256) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${name} must be a non-empty string no longer than ${maximum} characters.`);
  return normalized;
}

function repositoryName(value) {
  const normalized = required(value, "repository").toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)) throw new Error("repository must be an owner/name identifier.");
  return normalized;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function exactHead(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).toLowerCase();
  if (!SHA.test(normalized)) throw new Error("headSha must be an exact 40-character Git SHA when supplied.");
  return normalized;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compactPhase(value) {
  const phase = required(value, "phase", 64).toLowerCase();
  if (["running", "working", "provider_progress", "turn"].includes(phase)) return "working";
  if (["review", "reviewing", "verification", "verifying"].includes(phase)) return "reviewing";
  return phase;
}

export function repositoryRuntimeJournalDirectory(workspace) {
  const actualWorkspace = resolve(required(workspace, "workspace", 4_096));
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: actualWorkspace,
    encoding: "utf8",
  });
  if (common.status !== 0 || !common.stdout.trim()) {
    throw new Error(`Unable to locate repository Git metadata for ${actualWorkspace}.`);
  }
  return resolve(common.stdout.trim(), "agent-bridge", "repository-runtime");
}

function normalizedCheckpoint(input) {
  const phase = compactPhase(input.phase);
  const headSha = exactHead(input.headSha);
  const terminal = input.terminal === true || TERMINAL_PHASES.has(phase);
  const checkpoint = {
    version: REPOSITORY_RUNTIME_JOURNAL_VERSION,
    kind: input.kind === "release" ? "release" : "refresh",
    collaborationId: required(input.collaborationId, "collaborationId", 128),
    phase,
    writer: input.writer ? required(input.writer, "writer", 64) : null,
    previousWriter: input.previousWriter ? required(input.previousWriter, "previousWriter", 64) : null,
    headSha,
    branch: input.branch ? required(input.branch, "branch", 256) : null,
    summary: compactGitHubLifecycleSummary({ phase, writer: input.writer || null, summary: input.summary, terminal }),
    terminal,
  };
  return checkpoint;
}

function checkpointKey(checkpoint) {
  // A phase/head/writer is one compact GitHub checkpoint. Heartbeat-only summary
  // changes deliberately collapse to the first durable checkpoint instead of
  // creating an unbounded remote-comment queue.
  return [
    "collaboration-checkpoint",
    checkpoint.collaborationId,
    checkpoint.kind,
    checkpoint.phase,
    checkpoint.writer || "unassigned",
    checkpoint.previousWriter || "unchanged",
    checkpoint.headSha || "unbound",
    checkpoint.terminal ? digest(checkpoint.summary).slice(0, 16) : "current",
  ].join(":");
}

function retryAfterMilliseconds(error) {
  const raw = error?.retryAfterSeconds
    ?? error?.retryAfter
    ?? error?.response?.headers?.get?.("retry-after")
    ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(String(raw));
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function failureDetails(error) {
  const statusCode = [error?.status, error?.statusCode, error?.cause?.status]
    .find((candidate) => Number.isInteger(candidate)) || null;
  const code = String(error?.code || error?.cause?.code || "");
  const message = String(error?.message || error || "invalid request").slice(0, 1_024);
  const retryAfterMs = retryAfterMilliseconds(error);
  const rateLimited = statusCode === 429
    || (statusCode === 403 && (retryAfterMs !== null || /secondary rate limit|rate limit|abuse detection/i.test(message)));
  let kind = "invalid_request";
  if (rateLimited) kind = "rate_limit";
  else if (statusCode >= 500) kind = "server";
  else if (statusCode === 401) kind = "authentication";
  else if (statusCode === 403) kind = "authorization";
  else if (/TIMEOUT|ABORT|ETIMEDOUT/i.test(code)) kind = "timeout";
  else if (/ECONN|ENET|EAI_AGAIN|FETCH|SOCKET|UND_ERR_/i.test(code)
    || (error instanceof TypeError && /fetch failed|network|socket|terminated/i.test(String(error.message)))) kind = "network";
  return { kind, statusCode, message, ...(retryAfterMs === null ? {} : { retryAfterMs }) };
}

export function createRepositoryRuntimeJournal({
  workspace,
  repository,
  issueNumber,
  pullRequestNumber = null,
  directory = null,
  now = () => new Date().toISOString(),
  leaseMs,
  maxAttempts,
  baseBackoffMs,
  maxBackoffMs,
  terminalHorizonMs,
} = {}) {
  const binding = {
    repository: repositoryName(repository),
    issueNumber: positiveInteger(issueNumber, "issueNumber"),
    pullRequestNumber: pullRequestNumber === null ? null : positiveInteger(pullRequestNumber, "pullRequestNumber"),
  };
  const journalRoot = directory || resolve(repositoryRuntimeJournalDirectory(workspace), `issue-${binding.issueNumber}`);
  const journal = createRepositoryJournal({ directory: journalRoot, now });
  const outbox = createRepositoryJournalOutbox({
    journal,
    now,
    ...(leaseMs === undefined ? {} : { leaseMs }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(baseBackoffMs === undefined ? {} : { baseBackoffMs }),
    ...(maxBackoffMs === undefined ? {} : { maxBackoffMs }),
    ...(terminalHorizonMs === undefined ? {} : { terminalHorizonMs }),
  });

  async function enqueue(checkpointInput) {
    const checkpoint = normalizedCheckpoint(checkpointInput);
    const idempotencyKey = checkpointKey(checkpoint);
    const payload = { repositoryRuntime: checkpoint };
    const result = await outbox.enqueue({
      ...binding,
      headSha: checkpoint.headSha,
      operation: "collaboration_checkpoint",
      idempotencyKey,
      payload,
    });
    return { ...result, checkpoint, checkpointDigest: digest(payload) };
  }

  async function publishPending({ workerId, publish, limit = 25 } = {}) {
    if (typeof publish !== "function") throw new Error("publish must be a function.");
    const claimed = await outbox.claim({ workerId: required(workerId, "workerId", 256), limit });
    const results = [];
    for (const entry of claimed) {
      try {
        const receipt = await publish(structuredClone(entry.payload.repositoryRuntime), structuredClone(entry));
        await outbox.ack({ leaseId: entry.lease.leaseId, headSha: entry.binding.headSha });
        results.push({ idempotencyKey: entry.idempotencyKey, status: "published", receipt: receipt || null });
      } catch (error) {
        const failure = await outbox.fail({ leaseId: entry.lease.leaseId, failure: failureDetails(error) });
        results.push({
          idempotencyKey: entry.idempotencyKey,
          status: failure.terminal ? "dead_letter" : "retry_scheduled",
          retryAt: failure.retryAt,
          error: String(error?.message || error),
        });
      }
    }
    return results;
  }

  async function redriveAuthorityFailures({ authorityRestored = false, maxRedrives = 1 } = {}) {
    if (!authorityRestored) return { redriven: 0, eligible: 0, exhausted: 0 };
    if (!Number.isInteger(maxRedrives) || maxRedrives < 0) {
      throw new Error("maxRedrives must be a non-negative integer.");
    }
    const inspection = await outbox.inspect();
    const eligible = inspection.deadLetter.filter((entry) => {
      const classification = entry.failure?.classification;
      const statusCode = entry.failure?.statusCode;
      return ["authentication", "authorization"].includes(classification)
        && [401, 403].includes(statusCode)
        && entry.redriveCount < maxRedrives;
    });
    const redriven = [];
    for (const entry of eligible) {
      try {
        redriven.push(await outbox.requeue({ idempotencyKey: entry.idempotencyKey }));
      } catch (error) {
        // Another worker may have restored this exact entry after our snapshot.
        if (error?.code !== "ENTRY_NOT_DEAD_LETTER") throw error;
      }
    }
    const authorityFailures = inspection.deadLetter.filter((entry) => {
      const classification = entry.failure?.classification;
      return ["authentication", "authorization"].includes(classification)
        && [401, 403].includes(entry.failure?.statusCode);
    });
    return {
      redriven: redriven.length,
      eligible: eligible.length,
      exhausted: authorityFailures.length - eligible.length,
    };
  }

  return Object.freeze({
    binding,
    journal,
    outbox,
    enqueue,
    publishPending,
    redriveAuthorityFailures,
    inspect: outbox.inspect,
    retain: outbox.retain,
  });
}
