import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { collaborationDirectory } from "./collaboration-store.mjs";

export const PROVIDER_NAMES = ["claude", "codex", "antigravity"];

// Issue #55: a collaboration that already holds every capacity slot for a
// provider/role would wait forever on its own live slot. Fail fast instead of
// registering a waiter that can never be satisfied.
export class ProviderSelfDeadlockError extends Error {
  constructor({ provider, role, collaborationId, limit, ownedSlots, reason, commands }) {
    super(reason
      ? `Collaboration ${collaborationId} would deadlock on its own live ${provider} ${role} capacity slot: ${reason}.`
      : `Collaboration ${collaborationId} already owns ${ownedSlots}/${limit} live ${provider} ${role} capacity slot${limit === 1 ? "" : "s"}; waiting would deadlock on its own slot.`);
    this.name = "ProviderSelfDeadlockError";
    this.code = "provider_self_deadlock";
    this.selfDeadlock = true;
    this.provider = provider;
    this.role = role;
    this.collaborationId = collaborationId;
    this.limit = limit;
    this.ownedSlots = ownedSlots;
    if (reason) this.reason = reason;
    if (commands) this.commands = commands;
  }
}

export function detectProviderSelfDeadlock({ ownedSlots, limit } = {}) {
  return Number.isInteger(ownedSlots) && Number.isInteger(limit) && ownedSlots >= limit;
}

// A verification command "exercises the same live provider-capacity pool" when running
// it would itself consume the same provider's live capacity — because it drives this
// broker's provider dispatch/capacity acquisition, or directly invokes the same provider
// CLI. Dispatching such a review would deadlock on the very slot this call holds.
//
// The match is STRUCTURAL, not substring-based: a name that merely appears in a file
// path or argument (e.g. `cat src/collaboration-bridge.mjs`, `grep provider-concurrency`)
// is never a match. Only a directly executed entrypoint counts.
const POOL_ENTRY_PACKAGE_SCRIPTS = new Set(["test:provider-concurrency"]);
const POOL_ENTRY_EXECUTABLES = new Set([
  "collaboration-worker.mjs",
  "collaboration-bridge.mjs",
  "bridge",
]);
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn"]);
const NODE_RUNNERS = new Set(["node", "node.exe"]);

function commandBasename(token) {
  const cleaned = String(token || "").replace(/^['"]|['"]$/g, "");
  const segments = cleaned.split(/[\\/]/);
  return segments[segments.length - 1] || cleaned;
}

export function verificationCommandReentersProviderPool(command, provider) {
  const tokens = String(command || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  // Skip a leading `env` and any leading VAR=value environment assignments.
  let index = 0;
  if (commandBasename(tokens[index]) === "env") index += 1;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  const head = tokens[index];
  if (!head) return false;
  const headName = commandBasename(head);
  const rest = tokens.slice(index + 1);
  const firstOperand = rest.find((token) => !token.startsWith("-"));

  // (a) Direct same-provider CLI invocation: `claude ...`, `/usr/local/bin/claude ...`.
  if (provider && headName === provider) return true;

  // (b) A known broker pool-entry executable, run directly or via node.
  if (POOL_ENTRY_EXECUTABLES.has(headName)) return true;
  if (NODE_RUNNERS.has(headName) && firstOperand && POOL_ENTRY_EXECUTABLES.has(commandBasename(firstOperand))) {
    return true;
  }

  // (c) A local package-script alias resolving to a known pool-entry gate.
  if (SCRIPT_RUNNERS.has(headName)) {
    const runIndex = rest.findIndex((token) => token === "run" || token === "run-script");
    const script = runIndex >= 0
      ? rest[runIndex + 1]
      : headName === "yarn"
        ? firstOperand
        : null;
    if (script && POOL_ENTRY_PACKAGE_SCRIPTS.has(script)) return true;
  }

  return false;
}

export function verificationCommandsReenteringPool({ provider, verificationCommands = [] } = {}) {
  return verificationCommands
    .map((command) => String(command || "").trim())
    .filter((command) => command && verificationCommandReentersProviderPool(command, provider));
}

// Worker/dispatch guard: run BEFORE acquiring capacity. If any verification command
// would re-enter the same live provider-capacity pool, fail fast with a typed
// provider_self_deadlock and register no waiter.
export function assertNoProviderPoolReentry({ provider, role, collaborationId, limit, verificationCommands = [] } = {}) {
  const reentrant = verificationCommandsReenteringPool({ provider, verificationCommands });
  if (reentrant.length) {
    throw new ProviderSelfDeadlockError({
      provider,
      role,
      collaborationId,
      limit,
      reason: `verification command re-enters the same live provider-capacity pool (${reentrant.join(", ")})`,
      commands: reentrant,
    });
  }
}
export const DEFAULT_PROVIDER_CONCURRENCY_CONFIG = resolve(
  homedir(),
  ".config/local-agent-bridge/provider-concurrency.json",
);
export const DEFAULT_PROVIDER_CONCURRENCY = Object.freeze({
  claude: Object.freeze({ work: 1, review: 2 }),
  codex: Object.freeze({ work: 1, review: 2 }),
  antigravity: Object.freeze({ work: 1, review: 2 }),
});

function capacity(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error(`${label} must be an integer from 1 to 20.`);
  }
  return value;
}

export function normalizeProviderConcurrency(value = {}, base = DEFAULT_PROVIDER_CONCURRENCY) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider concurrency must be an object.");
  }
  const unknown = Object.keys(value).filter((provider) => !PROVIDER_NAMES.includes(provider));
  if (unknown.length) throw new Error(`Unsupported provider concurrency entry: ${unknown[0]}.`);
  return Object.fromEntries(PROVIDER_NAMES.map((provider) => {
    const selected = value[provider] || {};
    if (typeof selected !== "object" || Array.isArray(selected)) {
      throw new Error(`Provider concurrency for ${provider} must be an object.`);
    }
    const unknownRoles = Object.keys(selected).filter((role) => !["work", "review"].includes(role));
    if (unknownRoles.length) throw new Error(`Unsupported ${provider} concurrency role: ${unknownRoles[0]}.`);
    return [provider, {
      work: capacity(selected.work ?? base[provider].work, `${provider}.work`),
      review: capacity(selected.review ?? base[provider].review, `${provider}.review`),
    }];
  }));
}

export async function loadProviderConcurrency({
  configPath = process.env.AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG
    || DEFAULT_PROVIDER_CONCURRENCY_CONFIG,
  overrides = {},
} = {}) {
  let configured = {};
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (parsed.version !== 1) throw new Error("Unsupported provider concurrency config version.");
    configured = parsed.providers || {};
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Unable to read provider concurrency config at ${configPath}: ${error.message}`);
    }
  }
  const machine = normalizeProviderConcurrency(configured);
  const requested = normalizeProviderConcurrency(overrides, machine);
  return Object.fromEntries(PROVIDER_NAMES.map((provider) => [provider, {
    work: Math.min(machine[provider].work, requested[provider].work),
    review: Math.min(machine[provider].review, requested[provider].review),
  }]));
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const content = typeof value === "string" ? value : JSON.stringify(value);
  await writeFile(temporary, `${content}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function acquireDirectoryLock(directory) {
  const path = resolve(directory, ".queue.lock");
  const lockId = randomUUID();
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, lockId })}\n`);
      return async () => {
        await handle.close().catch(() => {});
        try {
          const current = JSON.parse(await readFile(path, "utf8"));
          if (current.pid === process.pid && current.lockId === lockId) await unlink(path);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(path, "utf8"));
        if (!(await ownerAlive(owner.pid))) {
          await unlink(path).catch(() => {});
          continue;
        }
      } catch {
        try {
          const info = await stat(path);
          if (Date.now() - info.mtimeMs > 30_000) {
            await unlink(path).catch(() => {});
            continue;
          }
        } catch {}
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new Error(`Timed out registering provider capacity waiter in ${directory}.`);
}

async function registerWaiter(directory, entry) {
  const release = await acquireDirectoryLock(directory);
  try {
    const sequencePath = resolve(directory, ".sequence");
    let sequence = 0;
    try {
      sequence = Number.parseInt(await readFile(sequencePath, "utf8"), 10) || 0;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    sequence += 1;
    await atomicWrite(sequencePath, String(sequence));
    const waiterName = `${String(sequence).padStart(20, "0")}-${process.pid}-${randomUUID()}.wait`;
    const waiterPath = resolve(directory, waiterName);
    await atomicWrite(waiterPath, entry);
    return { waiterName, waiterPath };
  } finally {
    await release();
  }
}

async function collaborationStillOwnsCapacity(root, collaborationId) {
  try {
    const statePath = resolve(collaborationDirectory(root), `${collaborationId}.json`);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return ["queued", "running", "recovering", "cancelling", "indeterminate"].includes(state.status);
  } catch {
    return false;
  }
}

async function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function removeStaleEntry(root, path) {
  try {
    const entry = JSON.parse(await readFile(path, "utf8"));
    if (await collaborationStillOwnsCapacity(root, entry.collaborationId)) return false;
    if (await ownerAlive(entry.pid)) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs <= 30_000) return false;
      await unlink(path);
      return true;
    } catch {
      return false;
    }
  }
}

async function liveEntries(root, directory, suffix) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const names = (await readdir(directory)).filter((name) => name.endsWith(suffix)).sort();
  const live = [];
  for (const name of names) {
    const path = resolve(directory, name);
    if (!(await removeStaleEntry(root, path))) live.push({ name, path });
  }
  return live;
}

async function countOwnedSlots(root, directory, collaborationId) {
  let owned = 0;
  for (const entry of await liveEntries(root, directory, ".slot")) {
    try {
      const parsed = JSON.parse(await readFile(entry.path, "utf8"));
      if (parsed.collaborationId === collaborationId) owned += 1;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return owned;
}

export async function releaseProviderCapacityForCollaboration(root, collaborationId) {
  if (!/^bridge-[0-9a-f-]{36}$/.test(collaborationId || "")) {
    throw new Error("A valid collaborationId is required for provider capacity cleanup.");
  }
  let removed = 0;
  for (const provider of PROVIDER_NAMES) {
    for (const role of ["work", "review"]) {
      const directory = resolve(collaborationDirectory(root), "capacity", provider, role);
      let names = [];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const name of names.filter((entry) => entry.endsWith(".wait") || entry.endsWith(".slot"))) {
        const path = resolve(directory, name);
        try {
          const entry = JSON.parse(await readFile(path, "utf8"));
          const liveSlot = name.endsWith(".slot") && await ownerAlive(entry.pid);
          if (entry.collaborationId === collaborationId && !liveSlot) {
            await unlink(path);
            removed += 1;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  }
  return removed;
}

export async function acquireProviderCapacity(root, {
  provider,
  role,
  collaborationId,
  limits,
  onWait,
  pollMs = 200,
} = {}) {
  if (!PROVIDER_NAMES.includes(provider)) throw new Error(`Unsupported provider: ${provider}`);
  if (!["work", "review"].includes(role)) throw new Error(`Unsupported provider role: ${role}`);
  if (!/^bridge-[0-9a-f-]{36}$/.test(collaborationId || "")) {
    throw new Error("A valid collaborationId is required for provider capacity.");
  }
  const normalized = await loadProviderConcurrency({
    overrides: normalizeProviderConcurrency(limits),
  });
  const limit = normalized[provider][role];
  const directory = resolve(collaborationDirectory(root), "capacity", provider, role);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ownedSlots = await countOwnedSlots(root, directory, collaborationId);
  if (detectProviderSelfDeadlock({ ownedSlots, limit })) {
    throw new ProviderSelfDeadlockError({ provider, role, collaborationId, limit, ownedSlots });
  }
  const queuedAt = Date.now();
  const { waiterName, waiterPath } = await registerWaiter(directory, {
    collaborationId,
    pid: process.pid,
    provider,
    role,
    queuedAt: new Date(queuedAt).toISOString(),
  });
  const leaseId = randomUUID();
  let lastWaitNotice = 0;
  try {
    while (true) {
      const waiters = await liveEntries(root, directory, ".wait");
      const position = waiters.findIndex((entry) => entry.name === waiterName);
      if (position < 0) {
        throw new Error(`Provider capacity waiter disappeared for ${collaborationId}.`);
      }
      const slots = await liveEntries(root, directory, ".slot");
      const availableSlots = Math.max(0, limit - slots.length);
      if (position >= 0 && position < availableSlots) {
        for (let slot = 1; slot <= limit; slot += 1) {
          const slotPath = resolve(directory, `${slot}.slot`);
          try {
            const handle = await open(slotPath, "wx", 0o600);
            await handle.writeFile(`${JSON.stringify({
              collaborationId,
              pid: process.pid,
              provider,
              role,
              slot,
              leaseId,
              acquiredAt: new Date().toISOString(),
            })}\n`);
            await handle.close();
            await unlink(waiterPath).catch(() => {});
            let released = false;
            return {
              provider,
              role,
              slot,
              limit,
              release: async () => {
                if (released) return;
                released = true;
                try {
                  const current = JSON.parse(await readFile(slotPath, "utf8"));
                  if (current.collaborationId === collaborationId
                    && current.pid === process.pid
                    && current.leaseId === leaseId) {
                    await unlink(slotPath);
                  }
                } catch (error) {
                  if (error.code !== "ENOENT") throw error;
                }
              },
            };
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        }
      }
      const now = Date.now();
      if (onWait && (lastWaitNotice === 0 || now - lastWaitNotice >= 5_000)) {
        lastWaitNotice = now;
        await onWait({
          provider,
          role,
          limit,
          inUse: Math.min(slots.length, limit),
          position: Math.max(1, position + 1),
        });
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
  } catch (error) {
    await unlink(waiterPath).catch(() => {});
    throw error;
  }
}
