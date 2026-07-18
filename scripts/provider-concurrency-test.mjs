import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireProviderCapacity,
  DEFAULT_PROVIDER_CONCURRENCY,
  detectProviderSelfDeadlock,
  loadProviderConcurrency,
  normalizeProviderConcurrency,
  ProviderSelfDeadlockError,
  releaseProviderCapacityForCollaboration,
} from "../src/provider-concurrency.mjs";

const root = await mkdtemp(join(tmpdir(), "agent-provider-capacity-"));
process.env.BRIDGE_COLLABORATION_DIR = root;
process.env.AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG = join(root, "missing-machine-policy.json");
const collaborationId = (suffix) => `bridge-00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

try {
  assert.deepEqual(normalizeProviderConcurrency({}), DEFAULT_PROVIDER_CONCURRENCY);
  assert.deepEqual(normalizeProviderConcurrency({ claude: { review: 3 } }).claude, {
    work: 1,
    review: 3,
  });
  assert.throws(() => normalizeProviderConcurrency({ claude: { review: 0 } }), /integer from 1 to 20/);

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
} finally {
  delete process.env.AGENT_BRIDGE_PROVIDER_CONCURRENCY_CONFIG;
  delete process.env.BRIDGE_COLLABORATION_DIR;
  await rm(root, { recursive: true, force: true });
}

console.log("Provider concurrency tests passed: config ceilings, independent role limits, parallel reviews, and automatic queued acquisition.");
