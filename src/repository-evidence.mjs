import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "uv.lock", "poetry.lock"];
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

async function git(workspace, args, { maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  const result = await run("git", args, { cwd: workspace, maxBuffer });
  return result.stdout.trim();
}

function isMaxBufferError(error) {
  return error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    || /maxBuffer|stdout maxBuffer length exceeded/i.test(error?.message || "");
}

async function gitPayload(workspace, args, { maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  try {
    return { value: await git(workspace, args, { maxBuffer }), complete: true, error: null };
  } catch (error) {
    if (!isMaxBufferError(error)) throw error;
    return { value: "", complete: false, error: error.code || "git-output-too-large" };
  }
}

export async function readRepositoryHead(workspace) {
  return git(workspace, ["rev-parse", "HEAD"]);
}

export async function captureActualRepositoryFootprint({ workspace, baseSha = null } = {}) {
  if (!workspace) throw new Error("Actual repository footprint capture requires a workspace.");
  const headSha = await readRepositoryHead(workspace);
  const committed = baseSha
    ? (await gitPayload(workspace, ["diff", "--name-only", `${baseSha}...${headSha}`])).value.split("\n").filter(Boolean)
    : [];
  const unstaged = (await gitPayload(workspace, ["diff", "--name-only"])).value.split("\n").filter(Boolean);
  const staged = (await gitPayload(workspace, ["diff", "--cached", "--name-only"])).value.split("\n").filter(Boolean);
  const untracked = (await gitPayload(workspace, ["ls-files", "--others", "--exclude-standard"])).value.split("\n").filter(Boolean);
  return {
    version: 1,
    paths: [...new Set([...committed, ...staged, ...unstaged, ...untracked])].sort(),
    symbols: [],
    contracts: [],
    resources: [],
    blockers: [],
    evidence: {
      source: "git",
      baseSha,
      headSha,
      dirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
      capturedAt: new Date().toISOString(),
    },
  };
}

export function isMissingRepositoryHead(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}`;
  return /ambiguous argument ['"]?HEAD|unknown revision or path not in the working tree|bad revision ['"]?HEAD|Needed a single revision/i.test(message);
}

export function repositoryFromRemote(remote) {
  const value = String(remote || "").trim().replace(/\.git$/, "");
  const https = value.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (https) return https[1];
  const ssh = value.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (ssh) return ssh[1];
  return null;
}

export async function readRepositoryIdentity(workspace) {
  const remote = await git(workspace, ["remote", "get-url", "origin"]).catch(() => "");
  return repositoryFromRemote(remote);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertRepositoryEvidenceHead({ expectedHeadSha, observedHeadSha } = {}) {
  if (!expectedHeadSha || !observedHeadSha || observedHeadSha !== expectedHeadSha) {
    const error = new Error(`Repository evidence head mismatch: expected ${expectedHeadSha || "unknown"}, observed ${observedHeadSha || "unknown"}.`);
    error.code = "VERIFICATION_HEAD_CHANGED";
    throw error;
  }
  return observedHeadSha;
}

async function environmentFingerprint(workspace, headSha, files, status, maxBuffer) {
  const lockfiles = files.filter((file) => LOCKFILES.includes(file) || LOCKFILES.some((name) => file.endsWith(`/${name}`)));
  const parts = [`node:${process.version}`];
  for (const file of lockfiles.sort()) {
    try {
      parts.push(`${file}:${sha256(await git(workspace, ["show", `${headSha}:${file}`]))}`);
    } catch {
      parts.push(`${file}:unavailable`);
    }
  }
  let worktreeDiff = "";
  let complete = status.complete;
  try {
    worktreeDiff = await git(workspace, ["diff", "--binary", "HEAD"], { maxBuffer });
  } catch (error) {
    complete = false;
    worktreeDiff = `unavailable:${error.code || error.name || "git-diff-failed"}`;
  }
  parts.push(`status:${status.complete ? sha256(status.value) : `unavailable:${status.error}`}`);
  parts.push(`worktree:${sha256(worktreeDiff)}`);
  return { digest: sha256(parts.join("\n")), complete };
}

export async function captureRepositoryEvidence({
  workspace,
  store,
  snapshotCache = null,
  repository,
  headSha,
  baseSha = null,
  allowMissingHead = false,
  evidenceMaxBuffer = DEFAULT_MAX_BUFFER,
} = {}) {
  if (!workspace || !store) throw new Error("Repository evidence requires a workspace and EvidenceStore.");
  let observedHead;
  try {
    observedHead = await readRepositoryHead(workspace);
  } catch (error) {
    if (allowMissingHead && isMissingRepositoryHead(error)) return null;
    throw error;
  }
  const exactHead = headSha || observedHead;
  assertRepositoryEvidenceHead({ expectedHeadSha: exactHead, observedHeadSha: observedHead });
  const remote = await git(workspace, ["remote", "get-url", "origin"]).catch(() => "");
  const durableRepository = repository || repositoryFromRemote(remote);
  const resolvedRepository = durableRepository || `local/${sha256(workspace).slice(0, 16)}`;
  // A repository snapshot journal lives in git-common-dir and is shared by
  // every linked worktree. Never bind that shared journal to a workspace-local
  // synthetic identity: a later governed lane would otherwise encounter a
  // permanent repository mismatch. Local-only evidence retains its existing
  // per-workspace EvidenceStore fallback.
  const repositorySnapshotCache = durableRepository ? snapshotCache : null;
  const headScope = { repository: resolvedRepository, headSha: exactHead };
  const diffScope = { ...headScope, ...(baseSha ? { baseSha } : {}) };

  const mapLoader = async () => {
      const tracked = await gitPayload(workspace, ["ls-tree", "-r", "--name-only", exactHead], { maxBuffer: evidenceMaxBuffer });
      return {
        files: tracked.complete ? tracked.value.split("\n").filter(Boolean) : [],
        complete: tracked.complete,
        error: tracked.error,
      };
    };
  const map = repositorySnapshotCache
    ? await repositorySnapshotCache.getOrLoad({
      repository: resolvedRepository,
      kind: "repository_map",
      subject: "tracked_files",
      headSha: exactHead,
      freshnessMs: 24 * 60 * 60_000,
      trustClass: "local-derived",
      load: async () => ({ data: await mapLoader(), sourceRevision: 1 }),
    })
    : await store.getOrLoad({
      kind: "repository_map",
      key: "tracked_files",
      scope: headScope,
      source: "git",
      load: mapLoader,
    });

  const diff = baseSha
    ? repositorySnapshotCache
      ? await repositorySnapshotCache.getOrLoad({
        repository: resolvedRepository,
        kind: "diff",
        subject: `base:${baseSha}`,
        headSha: exactHead,
        freshnessMs: 24 * 60 * 60_000,
        trustClass: "local-derived",
        load: async () => ({
          data: await loadDiff(),
          sourceRevision: 1,
        }),
      })
      : await store.getOrLoad({
        kind: "repository_diff",
        key: `${baseSha}..${exactHead}`,
        scope: diffScope,
        source: "git",
        load: loadDiff,
      })
    : null;

  async function loadDiff() {
        const files = await gitPayload(workspace, ["diff", "--name-only", baseSha, exactHead], { maxBuffer: evidenceMaxBuffer });
        const nameStatus = await gitPayload(workspace, ["diff", "--name-status", baseSha, exactHead], { maxBuffer: evidenceMaxBuffer });
        const stat = await gitPayload(workspace, ["diff", "--stat", baseSha, exactHead], { maxBuffer: evidenceMaxBuffer });
        return {
          files: files.complete ? files.value.split("\n").filter(Boolean) : [],
          nameStatus: nameStatus.complete ? nameStatus.value.split("\n").filter(Boolean) : [],
          stat: stat.value,
          complete: files.complete && nameStatus.complete && stat.complete,
          errors: [files.error, nameStatus.error, stat.error].filter(Boolean),
        };
  }
  const status = await gitPayload(workspace, ["status", "--porcelain=v1"], { maxBuffer: evidenceMaxBuffer });
  const environment = await environmentFingerprint(workspace, exactHead, map.value.files, status, evidenceMaxBuffer);
  assertRepositoryEvidenceHead({ expectedHeadSha: exactHead, observedHeadSha: await readRepositoryHead(workspace) });

  const repositoryMapComplete = map.value.complete !== false;
  const diffComplete = !diff || diff.value.complete !== false;

  return {
    repository: resolvedRepository,
    headSha: exactHead,
    baseSha,
    fileCount: map.value.files.length,
    changedFiles: diff?.value.files || [],
    repositoryMapComplete,
    diffComplete,
    clean: status.complete && status.value.length === 0 && environment.complete && repositoryMapComplete && diffComplete,
    environmentFingerprint: environment.digest,
    environmentFingerprintComplete: environment.complete,
    digests: { repositoryMap: map.digest, diff: diff?.digest || null },
    cache: { repositoryMap: map.cache, diff: diff?.cache || null },
    cacheMetrics: repositorySnapshotCache?.metrics?.() || store.metrics(),
  };
}

export function formatRepositoryEvidence(evidence, { maxFiles = 100 } = {}) {
  if (!evidence) return "";
  const changed = evidence.changedFiles.slice(0, maxFiles);
  const omitted = Math.max(0, evidence.changedFiles.length - changed.length);
  return [
    "Broker-cached exact-head evidence (reuse this before remapping the repository):",
    `- Repository: ${evidence.repository}`,
    `- Head: ${evidence.headSha}`,
    ...(evidence.baseSha ? [`- Base: ${evidence.baseSha}`] : []),
    `- Tracked files: ${evidence.repositoryMapComplete === false ? "unavailable (capture output exceeded the safe limit)" : evidence.fileCount}`,
    `- Changed files: ${evidence.diffComplete === false ? "unavailable (capture output exceeded the safe limit)" : `${changed.length ? changed.join(", ") : "none"}${omitted ? ` (${omitted} more cached)` : ""}`}`,
    `- Repository-map digest: ${evidence.digests.repositoryMap}`,
    ...(evidence.digests.diff ? [`- Diff digest: ${evidence.digests.diff}`] : []),
  ].join("\n");
}
