import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createRepositoryJournal } from "./repository-journal.mjs";
import { repositoryRuntimeJournalDirectory } from "./repository-runtime-journal.mjs";

const directoryCache = new Map();
const recordCache = new Map();

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function journalDirectory(workspace, issueNumber) {
  const key = resolve(workspace);
  let root = directoryCache.get(key);
  if (!root) {
    root = repositoryRuntimeJournalDirectory(key);
    directoryCache.set(key, root);
  }
  return resolve(root, `issue-${issueNumber}`);
}

async function latestCheckpoint(lane) {
  if (!lane?.workspace || !lane?.issueNumber || !lane?.repository || !lane?.id) return null;
  let directory;
  try {
    directory = journalDirectory(lane.workspace, lane.issueNumber);
  } catch {
    return null;
  }
  const path = resolve(directory, "repository-journal.jsonl");
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const cached = recordCache.get(path);
  const records = cached?.mtimeMs === info.mtimeMs && cached?.size === info.size
    ? cached.records
    : await createRepositoryJournal({ directory }).read();
  if (records !== cached?.records) recordCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, records });
  const record = [...records].reverse().find((entry) => (
    entry.payload?.repositoryRuntime?.collaborationId === lane.id
  )) || null;
  return record;
}

export function applyRepositoryJournalCheckpoint(lane, record) {
  const checkpoint = record?.payload?.repositoryRuntime;
  if (!checkpoint || checkpoint.collaborationId !== lane.id) return lane;
  const journal = {
    source: "repository_journal",
    sequence: record.sequence,
    digest: record.digest,
    recordedAt: record.recordedAt,
    binding: structuredClone(record.binding),
    phase: checkpoint.phase,
    terminal: checkpoint.terminal === true,
  };
  const journalIsNewer = timestamp(record.recordedAt) >= timestamp(lane.updatedAt);
  // Terminal is not an authority override: a newer control-plane receipt may
  // represent recovery or resumed work after this journal checkpoint.
  const useCheckpoint = journalIsNewer;
  return {
    ...lane,
    repositoryJournal: { ...(lane.repositoryJournal || {}), ...journal },
    ...(useCheckpoint ? {
      lifecyclePhase: checkpoint.phase || lane.lifecyclePhase,
      writer: checkpoint.writer || lane.writer,
      headSha: checkpoint.headSha || lane.headSha,
      branch: checkpoint.branch || lane.branch,
      updatedAt: timestamp(record.recordedAt) > timestamp(lane.updatedAt) ? record.recordedAt : lane.updatedAt,
      narrative: checkpoint.summary ? {
        ...(lane.narrative || {}),
        summary: checkpoint.summary,
        updatedAt: record.recordedAt,
        source: "repository_journal",
        isPlaceholder: false,
      } : lane.narrative,
    } : {}),
  };
}

export async function projectRepositoryJournalState(lanes, { concurrency = 12 } = {}) {
  const values = Array.isArray(lanes) ? lanes : [];
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      try {
        output[index] = applyRepositoryJournalCheckpoint(values[index], await latestCheckpoint(values[index]));
      } catch (error) {
        output[index] = {
          ...values[index],
          repositoryJournal: {
            ...(values[index].repositoryJournal || {}),
            source: "repository_journal",
            status: "degraded",
            error: String(error?.message || error).slice(0, 300),
          },
        };
      }
    }
  }));
  return output;
}

export function clearMissionControlJournalCache() {
  directoryCache.clear();
  recordCache.clear();
}
