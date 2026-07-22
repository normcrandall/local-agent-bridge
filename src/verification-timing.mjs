export function createVerificationTimingTracker({ onStart, onFinish } = {}) {
  if (typeof onStart !== "function" || typeof onFinish !== "function") {
    throw new Error("Verification timing tracker requires start and finish callbacks.");
  }
  const active = new Map();
  let sequence = 0;

  return {
    async observe({ command, finished = false, at, metadata = {} } = {}) {
      if (!command) return null;
      if (finished) {
        const entry = active.get(command);
        if (!entry) return null;
        active.delete(command);
        await onFinish({ ...entry, at, metadata: { ...(entry.metadata || {}), ...metadata } });
        return { action: "finish", ...entry };
      }
      if (active.has(command)) return null;
      sequence += 1;
      const entry = { command, key: `tests:${sequence}`, at, metadata };
      active.set(command, entry);
      await onStart(entry);
      return { action: "start", ...entry };
    },

    async finishAll({ at, metadata = {} } = {}) {
      const entries = [...active.values()];
      active.clear();
      for (const entry of entries) {
        await onFinish({ ...entry, at, metadata: { ...(entry.metadata || {}), ...metadata } });
      }
      return entries.length;
    },

    activeCommands() {
      return [...active.keys()];
    },
  };
}
