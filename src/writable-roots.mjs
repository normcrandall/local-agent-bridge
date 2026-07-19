import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function resolveContainedWritableRoots(workspace, requestedRoots = [], { label = "Writable root" } = {}) {
  const actualWorkspace = realpathSync(resolve(workspace));
  const roots = [];
  for (const requested of requestedRoots || []) {
    const candidate = resolve(actualWorkspace, requested);
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
      throw new Error(`${label} does not exist or is not a directory: ${candidate}`);
    }
    const actual = realpathSync(candidate);
    const fromWorkspace = relative(actualWorkspace, actual);
    if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
      throw new Error(`${label} must stay inside the delegated workspace: ${actual}`);
    }
    if (!roots.includes(actual)) roots.push(actual);
  }
  return roots;
}
