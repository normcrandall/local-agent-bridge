import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// Validate that `requested` names a file that stays inside the delegated
// working directory, following symlinks on the nearest existing ancestor so a
// link cannot smuggle the path outside the workspace. Returns the absolute
// candidate path. Performs no writes.
export function resolveContainedHandoffPath(cwd, requested, { label = "handoffPath" } = {}) {
  if (!requested) return null;
  if (isAbsolute(requested)) throw new Error(`${label} must be relative to the delegated working directory.`);
  // Canonicalize the workspace root so a symlinked mount (e.g. macOS /var ->
  // /private/var) does not make a contained path look like an escape.
  const base = realpathSync(cwd);
  const candidate = resolve(base, requested);
  const fromWorkspace = relative(base, candidate);
  if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
    throw new Error(`${label} must stay inside the delegated working directory.`);
  }

  let existing = existsSync(candidate) ? candidate : dirname(candidate);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const actual = realpathSync(existing);
  const actualFromWorkspace = relative(base, actual);
  if (
    actualFromWorkspace === ".."
    || actualFromWorkspace.startsWith(`..${sep}`)
    || isAbsolute(actualFromWorkspace)
  ) {
    throw new Error(`${label} resolves outside the delegated working directory.`);
  }
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    throw new Error(`${label} must name a file, not a directory.`);
  }
  return candidate;
}

// Validate containment first, then create the handoff's parent directories
// recursively. Parent directories are only ever created after the path is
// proven to stay within the delegated workspace.
export function ensureContainedHandoffPath(cwd, requested, options = {}) {
  const candidate = resolveContainedHandoffPath(cwd, requested, options);
  if (!candidate) return null;
  mkdirSync(dirname(candidate), { recursive: true, mode: 0o700 });
  return candidate;
}
