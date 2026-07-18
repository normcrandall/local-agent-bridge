# Issue #71 — Machine-level worker supervisor: review verdict

**Reviewer:** Claude Code (read-only delegated review)
**Scope:** Complete uncommitted diff vs `origin/main` — double-forked machine-level
collaboration-worker supervisor, durable worker-exit receipts, incident-replay preservation.
**Date:** 2026-07-18

## Verdict

**APPROVE.** All declared runnable gates pass, and the two headline security fixes are verified
by executing regression tests. The single prior blocker (Finding 1 — a `test:collaboration`
teardown race) is fixed and the gate is now green. The supervisor design achieves its goals:
one machine-level daemon shared across hosts, durable receipted exits, incident preservation,
fail-closed against duplicate writers, no cross-host environment bleed, and correct cancellation
classification. Remaining items (Findings 2–5) are non-blocking follow-ups.

## Verification gates (this branch, macOS)

| Gate | Result |
|------|--------|
| `npm run test:supervisor` | PASS |
| `npm run test:replay` | PASS (incl. fixture 14, cancellation preserves worker disappearance) |
| `npm run test:cleanup` | PASS |
| `npm run test:coordinator-wake` | PASS |
| `npm run test:secrets` | PASS |
| `npm run test:skills` | PASS |
| `npm run smoke` | PASS |
| `npm run test:collaboration` | PASS (re-run after Finding 1 fix — clean exit 0, no `ENOTEMPTY`) |
| `npm run test:provider-concurrency` | Not run — excluded by instruction (chair ran it; a delegated provider review would intentionally trip the self-deadlock guard) |

## Confirmed-fixed (previously-blocking) items

- **Environment bleed / cross-host credential leak — FIXED.** Worker spawn no longer layers
  the supervisor's inherited process environment: `scripts/collaboration-supervisor.mjs:193-200`
  builds `env: { ...(workerEnvironment || {}), BRIDGE_* }` with **no** `...process.env` base.
  Proven by regression test: `scripts/worker-supervisor-test.mjs:77,82,95` sets
  `FIRST_HOST_ONLY_SECRET` on host 1, unsets it on host 2, and asserts the host-2 worker sees
  `firstHostOnlySecret === null`. Gate passes.
- **Duplicate-writer fail-closed guard — PRESENT and correct.**
  `scripts/collaboration-supervisor.mjs:170-182`: when a recorded `workerPid` is live but its
  command/start identity cannot be verified, `startWorker` throws and starts **no** replacement;
  when the pid is dead it records an exit receipt and throws for recovery. This closes both the
  Windows (`/bin/ps` absent) and transient-`ps`-failure duplicate-writer paths.
  Verified it does **not** regress normal `continue`: `clearTerminalRuntime`
  (`src/collaboration-cleanup.mjs:13-14`) nulls `workerPid`/`workerOwner` on every terminal
  status, so a follow-on start takes the `workerPid == null` spawn path; the guard only fires
  for a non-terminal collaboration whose live pid is unverifiable — exactly the case to block.
- **Cancellation is not misclassified as an incident — correct.** `cancel_collaboration`
  persists `status: "cancelling" / cancelRequested: true` *before* reaping
  (`src/collaboration-bridge.mjs:1516-1523`), so `recordWorkerExit`'s terminal check
  (`scripts/collaboration-supervisor.mjs:78-81`) reads the cancelling state from disk and writes
  `terminalReceipt: true` without flipping to `indeterminate`. Covered by
  `scripts/worker-supervisor-test.mjs:107-127`.
- **Exit-evidence durability / incident preservation — correct.** Receipt dedup is
  reentrancy-safe (`entry.receipted` set synchronously before any await,
  `collaboration-supervisor.mjs:68-69`); child-exit vs. 1s-poll paths are mutually exclusive
  (`:288` guards on `!entry.child`); a later `cancelled` event does not erase a prior
  `worker_disappeared` (`src/incident-replay.mjs:257-299`, fixture 14).

---

## Findings (severity-ordered)

### 1. RESOLVED (was BLOCKER, test-only) — `test:collaboration` teardown race deleted the state dir while the supervisor was still shutting down
- **File:** `scripts/collaboration-test.mjs:711-725`
- **Was:** Teardown SIGTERM'd the supervisor and immediately `rm`'d the state dir without waiting
  for exit; the supervisor's `shutdown()` (`scripts/collaboration-supervisor.mjs:305-314`)
  asynchronously rewrote `supervisor.json` (atomic `*.tmp` + rename) and unlinked the socket into
  the directory mid-delete, so `rmdir` saw a non-empty directory → deterministic
  `ENOTEMPTY`, exit 1 (reproduced twice with distinct temp dirs).
- **Fix (verified in tree):** After `process.kill(supervisor.pid, "SIGTERM")`, teardown now polls
  `process.kill(supervisor.pid, 0)` (treating `EPERM` as alive, breaking on `ESRCH`) for up to
  ~2s before `rm` (`collaboration-test.mjs:714-724`) — the same wait-for-exit pattern as
  `worker-supervisor-test.mjs`.
- **Result:** `npm run test:collaboration` re-run passes with clean exit 0; no `ENOTEMPTY`.

### 2. FOLLOW-UP (portability, non-blocking for a macOS bridge) — Windows has no adoption/identity fencing; live Windows collaborations cannot be resumed after a supervisor restart
- **Files:** `scripts/collaboration-supervisor.mjs:41-58` (`processCommand`/`processStartIdentity`
  shell out to `/bin/ps`), consumed by `recordedWorkerAlive` (`:49-58`) and the `startWorker`
  guard (`:170-182`).
- **Behavior:** On Windows `/bin/ps` does not exist, so `recordedWorkerAlive` is always false. For
  a still-live recorded worker, `startWorker` now (correctly) **throws** instead of duplicating —
  so this is **safe** (no duplicate writer, no cross-host interference), but adoption after a
  supervisor restart is **unavailable**: a `continue` on a running Windows collaboration errors and
  requires manual recovery.
- **Classification:** Not a blocker for this macOS-targeted bridge. Recommend a tracked
  portability follow-up: use a platform-native process-identity probe on Windows
  (e.g. `wmic`/`Get-CimInstance Win32_Process` for command line + creation date, or a native API)
  so adoption works there too.

### 3. LOW (availability nit, correctly fail-closed) — transient `ps` failure on macOS turns a legitimate resume into a hard error
- **File:** `scripts/collaboration-supervisor.mjs:41-47`, `:170-172`.
- **Behavior:** If `/bin/ps` momentarily returns empty for a genuinely-alive worker (load,
  sandboxing), `recordedWorkerAlive` is false while `processAlive` is true, so `startWorker` throws
  "…command or start identity does not match; no replacement was started." This is the correct
  safety choice (never duplicate a writer), but it converts a transient hiccup into an operator
  recovery step.
- **Proposed fix (optional):** Retry `processCommand`/`processStartIdentity` a couple of times
  (short backoff) before declaring an identity mismatch; treat an empty `ps` result as
  *indeterminate/alive* for fencing rather than *mismatch*, so a live owned worker is adopted.

### 4. LOW — Unix-socket permission set after bind (bind→chmod window)
- **File:** `scripts/collaboration-supervisor.mjs:271-275`.
- **Behavior:** `server.listen(endpoint)` creates the socket under the process umask; `chmod 0o600`
  runs only afterward. There is a small window where the socket exists with umask perms. Largely
  contained because the parent state directory is created `0o700`
  (`src/worker-supervisor-client.mjs:58`), but the containment depends on the directory not
  pre-existing with looser permissions (`mkdir` will not tighten an existing dir).
- **Proposed fix:** Set the umask around `listen`, or bind to a temp path chmod'd to `0o600` and
  `rename` it into place; and/or assert the state directory mode is `0o700` on startup.

### 5. INFO — full caller environment (incl. secrets) still transits the Unix socket
- **File:** `src/worker-supervisor-client.mjs:140` sends `workerEnvironment: process.env` to the
  supervisor over the socket. Post-fix this is used only as the worker's env base (Finding "fixed"
  above), which is correct, but the entire environment — including credentials — is serialized to
  JSON and passed through IPC to the shared daemon. Acceptable under the single-UID,
  `0o600`-socket trust model; noted so the trust assumption is explicit. Consider forwarding only
  an allowlisted set of keys if the trust boundary ever widens.

---

## Bottom line

**APPROVE.** The supervisor design achieves its goals — one machine-level daemon shared across
hosts, durable receipted exits, incident preservation, fail-closed against duplicate writers, no
cross-host environment bleed, and correct cancellation classification — and all 8 runnable
declared gates pass (`test:provider-concurrency` was run separately by the chair). The prior
blocker (Finding 1) is fixed and `test:collaboration` is green. Findings 2–5 are non-blocking
follow-ups: Windows process-identity adoption (safe/fail-closed, currently unavailable),
transient-`ps` availability retry, the socket bind→chmod window, and the full-environment IPC
note.
