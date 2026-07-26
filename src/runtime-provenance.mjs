import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const PROVENANCE_FILENAME = ".runtime-provenance.json";
export const PROVENANCE_VERSION = 1;
export const INSTALL_LOCK_FILENAME = ".install.lock";
const LOCK_STALE_MS = 30 * 60 * 1000;
const DIGEST_SKIPPED = new Set(["node_modules", ".git", PROVENANCE_FILENAME]);

export async function defaultGitRunner(args, { cwd }) {
  const { stdout } = await run("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function tryGit(runGit, args, cwd) {
  try {
    return (await runGit(args, { cwd })).trim();
  } catch {
    return null;
  }
}

/**
 * Describe the checkout a global install would be deployed from. A checkout with
 * no usable source-control metadata yields commit `null`, which the policy below
 * treats as unverifiable rather than as newest.
 */
export async function inspectSource({ sourceRoot, runGit = defaultGitRunner } = {}) {
  const commit = await tryGit(runGit, ["rev-parse", "HEAD"], sourceRoot);
  if (!commit) {
    return { root: sourceRoot, commit: null, ref: null, dirty: false, dirtyEntries: [], committedAt: null };
  }
  // Untracked files count as dirty: deployRuntime copies whole directories, so
  // an untracked file under src/ or scripts/ reaches the global runtime even
  // though no commit describes it.
  const status = await tryGit(runGit, ["status", "--porcelain", "--untracked-files=normal"], sourceRoot);
  const committedAt = await tryGit(runGit, ["show", "-s", "--format=%cI", commit], sourceRoot);
  const dirtyEntries = (status || "")
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort();
  return {
    root: sourceRoot,
    commit,
    ref: await tryGit(runGit, ["rev-parse", "--abbrev-ref", "HEAD"], sourceRoot),
    dirty: dirtyEntries.length > 0,
    dirtyEntries,
    committedAt: committedAt || null,
  };
}

/**
 * Whether `candidate` already contains `ancestor`. `null` means the source
 * checkout cannot see one of the commits at all, which is not the same as
 * "no".
 */
export async function containsCommit({ sourceRoot, ancestor, candidate, runGit = defaultGitRunner }) {
  if (!ancestor || !candidate) return null;
  if (ancestor === candidate) return true;
  for (const commit of [ancestor, candidate]) {
    const known = await tryGit(runGit, ["cat-file", "-e", `${commit}^{commit}`], sourceRoot);
    if (known === null) return null;
  }
  try {
    await runGit(["merge-base", "--is-ancestor", ancestor, candidate], { cwd: sourceRoot });
    return true;
  } catch (error) {
    return error?.code === 1 ? false : null;
  }
}

/**
 * Locate a real checkout that can prove whether the installed commit belongs
 * to main. Installed runtimes intentionally contain no Git metadata, so
 * callers provide durable provenance and current-workspace candidates instead
 * of attempting ancestry checks in the copied runtime itself.
 */
export async function locateCommitOnMain({
  ancestor,
  sourceRoots = [],
  candidates = ["main", "origin/main"],
  runGit = defaultGitRunner,
} = {}) {
  const roots = [...new Set(sourceRoots
    .filter((root) => typeof root === "string" && root.trim())
    .map((root) => resolve(root)))];
  let definitive = null;
  for (const sourceRoot of roots) {
    for (const candidate of candidates) {
      const contains = await containsCommit({ sourceRoot, ancestor, candidate, runGit });
      if (contains === true) return { contains, sourceRoot, candidate, checkedRoots: roots };
      if (contains === false && !definitive) definitive = { contains, sourceRoot, candidate, checkedRoots: roots };
    }
  }
  return definitive || { contains: null, sourceRoot: null, candidate: null, checkedRoots: roots };
}

/**
 * Both directions of containment, so a checkout that is strictly behind the
 * installed runtime is reported differently from one that merely diverged.
 */
export async function describeAncestry({ sourceRoot, installedCommit, incomingCommit, runGit = defaultGitRunner }) {
  const forward = await containsCommit({ sourceRoot, ancestor: installedCommit, candidate: incomingCommit, runGit });
  if (forward !== false) return { contains: forward, containedBy: forward === true ? null : forward };
  return {
    contains: false,
    containedBy: await containsCommit({ sourceRoot, ancestor: incomingCommit, candidate: installedCommit, runGit }),
  };
}

export async function readInstalledProvenance(runtimeRoot) {
  try {
    const parsed = JSON.parse(await readFile(resolve(runtimeRoot, PROVENANCE_FILENAME), "utf8"));
    return parsed?.version === PROVENANCE_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeInstalledProvenance(runtimeRoot, record) {
  const path = resolve(runtimeRoot, PROVENANCE_FILENAME);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return record;
}

export function buildProvenance({ source, installedAt, digest, entries }) {
  return {
    version: PROVENANCE_VERSION,
    commit: source.commit,
    ref: source.ref,
    dirty: source.dirty,
    dirtyEntries: source.dirtyEntries.slice(0, 50),
    sourceCommittedAt: source.committedAt,
    installedAt,
    installerPid: process.pid,
    installerHost: hostname(),
    installerWorkspace: source.root,
    entries: [...entries].sort(),
    digest,
  };
}

async function digestInto(hash, root, current) {
  const listing = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of listing) {
    if (DIGEST_SKIPPED.has(entry.name)) continue;
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) {
      await digestInto(hash, root, path);
      continue;
    }
    if (!entry.isFile()) continue;
    hash.update(`${relative(root, path)}\0`);
    hash.update(await readFile(path));
    hash.update("\0");
  }
}

/**
 * Content digest of a deployed tree, excluding installed dependencies and the
 * provenance record itself so the same source always digests identically.
 */
export async function computeRuntimeDigest(root) {
  const hash = createHash("sha256");
  await digestInto(hash, root, root);
  return hash.digest("hex");
}

/**
 * Default-deny policy for replacing the global runtime. Only a strictly
 * fast-forward, clean, verifiable source may overwrite an existing install;
 * everything else requires an explicit repair/force.
 */
export function evaluateDeployment({ installed, incoming, contains, containedBy = null, force = false }) {
  const allow = (code, reason) => ({ allowed: true, forced: false, code, reason });
  const deny = (code, reason, repair) => (force
    ? { allowed: true, forced: true, code, reason, repair }
    : { allowed: false, forced: false, code, reason, repair });

  if (incoming.dirty) {
    return deny("source_dirty",
      `source checkout ${incoming.root} has ${incoming.dirtyEntries.length} uncommitted change(s): ${incoming.dirtyEntries.slice(0, 5).join(", ")}`,
      "commit or stash the changes, or re-run with --force to deploy a known-dirty runtime");
  }
  if (!incoming.commit) {
    return deny("source_unversioned",
      `source checkout ${incoming.root} has no resolvable commit`,
      "deploy from a git checkout, or re-run with --force");
  }
  if (!installed) return allow("first_install", "no provenance recorded for the installed runtime");
  if (installed.dirty) {
    return allow("replaces_dirty_install",
      `installed runtime was deployed dirty from ${installed.commit ?? "an unversioned source"}`);
  }
  if (!installed.commit) return allow("replaces_unversioned_install", "installed runtime has no recorded commit");
  if (installed.commit === incoming.commit) {
    return allow("same_commit", `redeploying the installed commit ${incoming.commit}`);
  }
  if (contains === true) {
    return allow("fast_forward", `${incoming.commit} contains installed ${installed.commit}`);
  }
  if (contains === false && containedBy === true) {
    return deny("stale_source",
      `${incoming.commit} is strictly behind installed ${installed.commit}; deploying it would drop installed work`,
      "fast-forward the checkout onto the installed commit, or re-run with --force to repair a bad install");
  }
  if (contains === false) {
    return deny("divergent_source",
      `${incoming.commit} has diverged from installed ${installed.commit}; neither commit contains the other`,
      "merge or rebase onto the installed commit, or re-run with --force to deploy this branch runtime");
  }
  return deny("unverifiable_ancestry",
    `cannot determine whether ${incoming.commit} contains installed ${installed.commit} from ${incoming.root}`,
    "deploy from a checkout that can see both commits, or re-run with --force to repair");
}

async function pause(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Machine-level mutual exclusion for global installs. Concurrent installers
 * queue instead of interleaving. A lock whose same-host owner is gone is
 * reclaimed at once; a lock held by a live same-host owner is never reclaimed,
 * however long the install runs. Only an unattributable lock — a foreign host,
 * or a record with no usable pid — falls back to the age threshold.
 */
export async function acquireInstallLock({
  installRoot,
  path = resolve(installRoot, INSTALL_LOCK_FILENAME),
  attempts = 600,
  intervalMs = 100,
  staleMs = LOCK_STALE_MS,
  now = () => Date.now(),
  isAlive = alive,
} = {}) {
  const token = randomUUID();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, host: hostname(), token, acquiredAt: new Date(now()).toISOString() })}\n`);
      await handle.close();
      return async () => {
        try {
          const current = JSON.parse(await readFile(path, "utf8"));
          if (current.token === token) await unlink(path);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(await readFile(path, "utf8")); } catch {}
      const age = await stat(path).then((info) => now() - info.mtimeMs, () => 0);
      const sameHost = !owner?.host || owner.host === hostname();
      // A partially written lock parses to no pid; it belongs to an installer
      // that is mid-acquisition, so it is only ever reclaimed on age.
      const knownOwner = sameHost && Number.isInteger(owner?.pid) && owner.pid > 0;
      const deadOwner = knownOwner && !isAlive(owner.pid);
      const liveOwner = knownOwner && !deadOwner;
      if (deadOwner || (!liveOwner && age >= staleMs)) {
        await unlink(path).catch(() => {});
        continue;
      }
      await pause(intervalMs);
    }
  }
  const owner = await readFile(path, "utf8").catch(() => "unknown");
  throw new Error(`another global install holds ${path} (${owner.trim()}); retry once it finishes`);
}
