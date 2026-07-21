import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireProviderCapacity,
  assertNoProviderPoolReentry,
  DEFAULT_PROVIDER_CONCURRENCY,
  detectProviderSelfDeadlock,
  loadProviderConcurrency,
  normalizeProviderConcurrency,
  ProviderSelfDeadlockError,
  releaseProviderCapacityForCollaboration,
  verificationCommandReentersProviderPool,
  verificationCommandsReenteringPool,
} from "../src/provider-concurrency.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-provider-capacity-"));
process.env.BRIDGE_COLLABORATION_DIR = root;
process.env.AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG = join(root, "missing-machine-policy.json");
const collaborationId = (suffix) => `bridge-00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

// Deterministic FIFO ordering barrier: wait until at least `count` waiter files are
// registered in a capacity directory before starting the next queued acquisition, so
// waiter sequence never depends on concurrent call scheduling.
async function waitForWaiterCount(directory, count) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    let names = [];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (names.filter((name) => name.endsWith(".wait")).length >= count) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for ${count} capacity waiter(s) in ${directory}.`);
}
const claudeReviewCapacityDir = join(root, "capacity", "claude", "review");

try {
  assert.deepEqual(DEFAULT_PROVIDER_CONCURRENCY, {
    claude: { work: 5, review: 10 },
    codex: { work: 5, review: 10 },
    antigravity: { work: 5, review: 10 },
    ollama: { work: 1, review: 10 },
  });
  assert.deepEqual(normalizeProviderConcurrency({}), DEFAULT_PROVIDER_CONCURRENCY);
  assert.deepEqual(normalizeProviderConcurrency({ claude: { review: 3 } }).claude, {
    work: 5,
    review: 3,
  });
  assert.throws(() => normalizeProviderConcurrency({ claude: { review: 0 } }), /integer from 1 to 20/);
  await assert.rejects(
    acquireProviderCapacity(root, {
      provider: "ollama",
      role: "work",
      collaborationId: collaborationId("99"),
      limits: DEFAULT_PROVIDER_CONCURRENCY,
    }),
    /review-only.*work capacity/,
  );

  const configPath = join(root, "provider-concurrency.json");
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    providers: {
      claude: { work: 1, review: 4 },
      codex: { work: 1, review: 3 },
      antigravity: { work: 1, review: 2 },
    },
  })}\n`, { mode: 0o600 });
  const configured = await loadProviderConcurrency({
    configPath,
    overrides: { claude: { review: 6 }, codex: { review: 2 } },
  });
  assert.equal(configured.claude.review, 4);
  assert.equal(configured.codex.review, 2);

  const limits = normalizeProviderConcurrency({ claude: { work: 1, review: 2 } });
  const first = await acquireProviderCapacity(root, {
    provider: "claude",
    role: "review",
    collaborationId: collaborationId("1"),
    limits,
    pollMs: 10,
  });
  const second = await acquireProviderCapacity(root, {
    provider: "claude",
    role: "review",
    collaborationId: collaborationId("2"),
    limits,
    pollMs: 10,
  });
  assert.notEqual(first.slot, second.slot);

  let thirdAcquired = false;
  let fourthAcquired = false;
  const thirdPromise = acquireProviderCapacity(root, {
    provider: "claude",
    role: "review",
    collaborationId: collaborationId("3"),
    limits,
    pollMs: 10,
  }).then((lease) => {
    thirdAcquired = true;
    return lease;
  });
  // Register the third waiter before starting the fourth so FIFO order is deterministic
  // and never relies on concurrent call scheduling.
  await waitForWaiterCount(claudeReviewCapacityDir, 1);
  const fourthPromise = acquireProviderCapacity(root, {
    provider: "claude",
    role: "review",
    collaborationId: collaborationId("5"),
    limits,
    pollMs: 10,
  }).then((lease) => {
    fourthAcquired = true;
    return lease;
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
  assert.equal(thirdAcquired, false);
  assert.equal(fourthAcquired, false);

  const vanishedPromise = acquireProviderCapacity(root, {
    provider: "claude",
    role: "review",
    collaborationId: collaborationId("7"),
    limits,
    pollMs: 10,
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  assert.equal(await releaseProviderCapacityForCollaboration(root, collaborationId("7")), 1);
  await assert.rejects(vanishedPromise, /waiter disappeared/);

  const work = await acquireProviderCapacity(root, {
    provider: "claude",
    role: "work",
    collaborationId: collaborationId("4"),
    limits,
    pollMs: 10,
  });
  assert.equal(work.slot, 1);
  await work.release();

  await first.release();
  const third = await thirdPromise;
  assert.equal(thirdAcquired, true);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
  assert.equal(fourthAcquired, false);
  await second.release();
  const fourth = await fourthPromise;
  await third.release();
  await fourth.release();

  const cancelled = await acquireProviderCapacity(root, {
    provider: "codex",
    role: "review",
    collaborationId: collaborationId("6"),
    limits,
    pollMs: 10,
  });
  assert.equal(await releaseProviderCapacityForCollaboration(root, collaborationId("6")), 0);
  await cancelled.release();

  const ceilingConfigPath = join(root, "provider-concurrency-ceiling.json");
  await writeFile(ceilingConfigPath, `${JSON.stringify({
    version: 1,
    providers: {
      claude: { work: 1, review: 1 },
    },
  })}\n`, { mode: 0o600 });
  process.env.AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG = ceilingConfigPath;
  const ceilingFirst = await acquireProviderCapacity(root, {
    provider: "claude",
    role: "review",
    collaborationId: collaborationId("8"),
    limits: normalizeProviderConcurrency({ claude: { review: 3 } }),
    pollMs: 10,
  });
  let ceilingSecondAcquired = false;
  const ceilingSecondPromise = acquireProviderCapacity(root, {
    provider: "claude",
    role: "review",
    collaborationId: collaborationId("9"),
    limits: normalizeProviderConcurrency({ claude: { review: 3 } }),
    pollMs: 10,
  }).then((lease) => {
    ceilingSecondAcquired = true;
    return lease;
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
  assert.equal(ceilingFirst.limit, 1);
  assert.equal(ceilingSecondAcquired, false);
  await ceilingFirst.release();
  const ceilingSecond = await ceilingSecondPromise;
  await ceilingSecond.release();

  // Issue #55: same-owner fast rejection. A collaboration that already holds every
  // slot for a provider/role must fail fast with a typed self-deadlock error rather
  // than register a waiter that can never be satisfied.
  assert.equal(detectProviderSelfDeadlock({ ownedSlots: 1, limit: 1 }), true);
  assert.equal(detectProviderSelfDeadlock({ ownedSlots: 0, limit: 1 }), false);
  assert.equal(detectProviderSelfDeadlock({ ownedSlots: 2, limit: 2 }), true);

  const selfOwner = collaborationId("a");
  const selfLimits = normalizeProviderConcurrency({ antigravity: { work: 1, review: 2 } });
  const held = await acquireProviderCapacity(root, {
    provider: "antigravity",
    role: "work",
    collaborationId: selfOwner,
    limits: selfLimits,
    pollMs: 10,
  });
  const beforeReject = Date.now();
  await assert.rejects(
    acquireProviderCapacity(root, {
      provider: "antigravity",
      role: "work",
      collaborationId: selfOwner,
      limits: selfLimits,
      pollMs: 10,
    }),
    (error) => error instanceof ProviderSelfDeadlockError
      && error.code === "provider_self_deadlock"
      && error.selfDeadlock === true,
  );
  // Fast rejection: it must not have polled/waited on a registered waiter.
  assert.ok(Date.now() - beforeReject < 200);

  // Issue #55: deterministic lease release and immediate slot reacquisition. Releasing
  // frees the exact slot, which the next owner reacquires immediately.
  const heldSlot = held.slot;
  await held.release();
  const reacquired = await acquireProviderCapacity(root, {
    provider: "antigravity",
    role: "work",
    collaborationId: collaborationId("b"),
    limits: selfLimits,
    pollMs: 10,
  });
  assert.equal(reacquired.slot, heldSlot);
  await reacquired.release();

  // The same holds for a cancel-style release: releasing a lease frees the slot for the
  // next owner without any residual waiter.
  const cancelOwner = collaborationId("c");
  const cancelLease = await acquireProviderCapacity(root, {
    provider: "antigravity",
    role: "work",
    collaborationId: cancelOwner,
    limits: selfLimits,
    pollMs: 10,
  });
  assert.equal(await releaseProviderCapacityForCollaboration(root, cancelOwner), 0);
  await cancelLease.release();
  const afterCancel = await acquireProviderCapacity(root, {
    provider: "antigravity",
    role: "work",
    collaborationId: collaborationId("d"),
    limits: selfLimits,
    pollMs: 10,
  });
  assert.equal(afterCancel.slot, heldSlot);
  await afterCancel.release();

  // Issue #55: a verification command that re-enters the same live provider-capacity pool
  // must fail fast with provider_self_deadlock BEFORE any waiter/slot is registered.
  // Positive: local package-script alias to the pool gate, direct provider CLI, node/
  // direct execution of a broker pool-entry script, the ./bridge CLI, wrapper forms.
  assert.equal(verificationCommandReentersProviderPool("npm run test:provider-concurrency", "claude"), true);
  assert.equal(verificationCommandReentersProviderPool("yarn test:provider-concurrency", "claude"), true);
  assert.equal(verificationCommandReentersProviderPool("pnpm test:provider-concurrency", "claude"), true);
  assert.equal(verificationCommandReentersProviderPool("pnpm run test:provider-concurrency --silent", "claude"), true);
  assert.equal(verificationCommandReentersProviderPool("claude -p review", "claude"), true);
  assert.equal(verificationCommandReentersProviderPool("/usr/local/bin/claude review", "claude"), true);
  assert.equal(verificationCommandReentersProviderPool("env NODE_ENV=test claude -p review", "claude"), true);
  assert.equal(verificationCommandReentersProviderPool("node scripts/collaboration-worker.mjs bridge-1", "claude"), true);
  assert.equal(verificationCommandReentersProviderPool("./bridge talk hello", "claude"), true);
  assert.equal(verificationCommandReentersProviderPool("codex exec review", "codex"), true);

  // Negative: same substrings appearing only as file-path/argument data, unrelated
  // gates, and a cross-provider CLI that cannot deadlock on this provider's slot.
  assert.equal(verificationCommandReentersProviderPool("npm run test:collaboration", "claude"), false);
  assert.equal(verificationCommandReentersProviderPool("npm test:provider-concurrency", "claude"), false);
  assert.equal(verificationCommandReentersProviderPool("pnpm install", "claude"), false);
  assert.equal(verificationCommandReentersProviderPool("grep -rn provider-concurrency src", "claude"), false);
  assert.equal(verificationCommandReentersProviderPool("cat src/collaboration-bridge.mjs", "claude"), false);
  assert.equal(verificationCommandReentersProviderPool("eslint src/provider-concurrency.mjs", "claude"), false);
  assert.equal(verificationCommandReentersProviderPool("node scripts/lint.mjs --rule provider-concurrency", "claude"), false);
  assert.equal(verificationCommandReentersProviderPool("echo start_collaboration && cat notes/claude.md", "claude"), false);
  assert.equal(verificationCommandReentersProviderPool("codex exec review", "claude"), false);
  assert.deepEqual(
    verificationCommandsReenteringPool({
      provider: "claude",
      verificationCommands: ["npm test", "npm run test:provider-concurrency", "cat src/collaboration-bridge.mjs"],
    }),
    ["npm run test:provider-concurrency"],
  );

  // Mirror the worker's pre-dispatch ordering: guard first, then acquire. When the guard
  // trips, capacity is never touched — no waiter or slot is created for the collaboration.
  const reentryOwner = collaborationId("e");
  const reentryDir = join(root, "capacity", "claude", "review");
  const beforeNames = await readdir(reentryDir).catch(() => []);
  const beforeWait = beforeNames.filter((name) => name.endsWith(".wait")).length;
  const beforeSlot = beforeNames.filter((name) => name.endsWith(".slot")).length;
  let reentryError = null;
  try {
    assertNoProviderPoolReentry({
      provider: "claude",
      role: "review",
      collaborationId: reentryOwner,
      limit: 2,
      verificationCommands: ["npm run test:provider-concurrency"],
    });
    // Unreached in the worker: acquisition only runs when the guard passes.
    const leaked = await acquireProviderCapacity(root, {
      provider: "claude",
      role: "review",
      collaborationId: reentryOwner,
      limits,
      pollMs: 10,
    });
    await leaked.release();
  } catch (error) {
    reentryError = error;
  }
  assert.ok(reentryError instanceof ProviderSelfDeadlockError);
  assert.equal(reentryError.code, "provider_self_deadlock");
  assert.equal(reentryError.selfDeadlock, true);
  assert.deepEqual(reentryError.commands, ["npm run test:provider-concurrency"]);
  const afterNames = await readdir(reentryDir).catch(() => []);
  assert.equal(afterNames.filter((name) => name.endsWith(".wait")).length, beforeWait);
  assert.equal(afterNames.filter((name) => name.endsWith(".slot")).length, beforeSlot);
} finally {
  delete process.env.AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG;
  delete process.env.BRIDGE_COLLABORATION_DIR;
  await rm(root, { recursive: true, force: true });
}

console.log("Provider concurrency tests passed: config ceilings, independent role limits, parallel reviews, and automatic queued acquisition.");
