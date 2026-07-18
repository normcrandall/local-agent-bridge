import { randomUUID } from "node:crypto";
import { access, chmod, cp, mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function deployRuntime({
  sourceRoot,
  installRoot,
  runtimeRoot,
  entries,
  installDependencies,
}) {
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  await chmod(installRoot, 0o700);
  const suffix = `${process.pid}-${randomUUID()}`;
  const stagedRuntime = resolve(installRoot, `.runtime-stage-${suffix}`);
  const previousRuntime = resolve(installRoot, `.runtime-previous-${suffix}`);
  let previousMoved = false;
  let activated = false;
  let succeeded = false;

  try {
    await mkdir(stagedRuntime, { recursive: true, mode: 0o700 });
    for (const name of entries) {
      await cp(resolve(sourceRoot, name), resolve(stagedRuntime, name), { recursive: true });
    }
    await installDependencies(stagedRuntime);

    if (await exists(runtimeRoot)) {
      await rename(runtimeRoot, previousRuntime);
      previousMoved = true;
    }
    await rename(stagedRuntime, runtimeRoot);
    activated = true;
    await chmod(runtimeRoot, 0o700);
    succeeded = true;
    return { runtimeRoot, replaced: previousMoved };
  } catch (error) {
    if (activated) await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
    if (previousMoved) await rename(previousRuntime, runtimeRoot).catch(() => {});
    throw error;
  } finally {
    await rm(stagedRuntime, { recursive: true, force: true });
    if (succeeded) await rm(previousRuntime, { recursive: true, force: true });
  }
}
