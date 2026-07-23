import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  appendEvent,
  collaborationDirectory,
  readCollaboration,
  updateCollaboration,
} from "./collaboration-store.mjs";
import { createPerformanceTimeline, markPerformanceMilestone, summarizePerformance } from "./performance-timeline.mjs";
import { signalUserAttention, wakeNeedsUser } from "./user-attention.mjs";

const ACTIVE_STATUSES = new Set(["queued", "running", "recovering", "cancelling"]);
const TERMINAL_STATUSES = new Set(["agreed", "needs_user", "turn_limit", "failed", "cancelled", "budget"]);
const ACTIONABLE_NEXT_ACTIONS = new Set(["chair_verify", "peer_review", "writer_fix", "continue"]);

export function wakeStateDirectory(root = process.cwd()) {
  return resolve(process.env.BRIDGE_COLLABORATION_DIR || collaborationDirectory(root));
}

export function coordinatorWorkspaceMatches(stateWorkspace, cwd) {
  const workspace = resolve(stateWorkspace || "/");
  const current = resolve(cwd || "/");
  return current === workspace
    || current.startsWith(`${workspace}/`)
    || workspace.startsWith(`${current}/.bridge/worktrees/`);
}

export function coordinatorProvider(state) {
  return state.chair?.provider || null;
}

export function coordinatorWakeSummary(state) {
  if (state.completion?.lastHandoff?.summary) return state.completion.lastHandoff.summary;
  if (state.decisionEscalation?.reason) return state.decisionEscalation.reason;
  if (state.error) return String(state.error).split("\n")[0].slice(0, 1_000);
  const lastDecision = state.decisions?.at(-1);
  if (lastDecision?.reason) return lastDecision.reason;
  return `Collaboration ${state.id} entered ${state.status}.`;
}

// The provider-neutral delivery outcome recorded for the bound head SHA, if any.
// This distinguishes succeeded / rejected / indeterminate / reconciled remote
// verification independently of the coarse collaboration status.
export function coordinatorDeliveryOutcome(state) {
  const outcome = state.completion?.delivery?.outcome ?? null;
  return outcome || null;
}

// A delivery whose remote verification is unproven (indeterminate) or was
// rejected must not be silently treated as a clean phase completion.
const DELIVERY_NEEDS_ATTENTION = new Set(["indeterminate", "rejected"]);

export function classifyCoordinatorWake(state) {
  if (!coordinatorProvider(state)) return null;
  const deliveryOutcome = coordinatorDeliveryOutcome(state);
  const withDelivery = (classification) => (
    deliveryOutcome ? { ...classification, deliveryOutcome } : classification
  );
  if (state.status === "needs_user" || state.completion?.nextAction === "needs_user") {
    return withDelivery({
      kind: "needs_user",
      actionable: false,
      nextAction: "needs_user",
      summary: coordinatorWakeSummary(state),
    });
  }
  if (state.completion?.acknowledged === false) {
    return withDelivery({
      kind: "handoff_ready",
      // A delivery needing attention makes the handoff actionable even when the
      // handoff's own nextAction would not, so the coordinator inspects it.
      actionable: ACTIONABLE_NEXT_ACTIONS.has(state.completion.nextAction)
        || DELIVERY_NEEDS_ATTENTION.has(deliveryOutcome),
      nextAction: DELIVERY_NEEDS_ATTENTION.has(deliveryOutcome)
        ? "writer_fix"
        : state.completion.nextAction,
      summary: coordinatorWakeSummary(state),
    });
  }
  if (TERMINAL_STATUSES.has(state.status)) {
    const nextAction = DELIVERY_NEEDS_ATTENTION.has(deliveryOutcome)
      ? "inspect"
      : state.status === "agreed"
        ? "chair_verify"
        : state.status === "turn_limit"
          ? "continue"
          : "inspect";
    return withDelivery({
      kind: state.status === "agreed" ? "phase_complete" : "phase_stopped",
      actionable: state.status !== "cancelled",
      nextAction,
      summary: coordinatorWakeSummary(state),
    });
  }
  return null;
}

function wakeKey(state, classification) {
  return [
    state.id,
    state.runSequence || 1,
    state.runtime?.turnCount || 0,
    state.completion?.sequence || 0,
    state.status,
    classification.kind,
    classification.nextAction,
    classification.deliveryOutcome || "none",
  ].join(":");
}

export async function enqueueCoordinatorWake(root, id, { force = false } = {}) {
  let created = false;
  const at = new Date().toISOString();
  const state = await updateCollaboration(root, id, (current) => {
    const classification = classifyCoordinatorWake(current);
    if (!classification) return current;
    const key = wakeKey(current, classification);
    if (!force && current.coordinatorWake?.key === key) return current;
    created = true;
    const performance = markPerformanceMilestone(
      current.performance || createPerformanceTimeline(current.createdAt || at),
      "coordinator_wake_enqueued",
      { at, metadata: { sequence: (current.coordinatorWake?.sequence || 0) + 1 } },
    );
    return {
      ...current,
      performance,
      performanceSummary: summarizePerformance(performance),
      coordinatorWake: {
        sequence: (current.coordinatorWake?.sequence || 0) + 1,
        key,
        provider: coordinatorProvider(current),
        sessionId: current.chair?.sessionId || null,
        workspace: current.workspace,
        kind: classification.kind,
        actionable: classification.actionable,
        nextAction: classification.nextAction,
        deliveryOutcome: classification.deliveryOutcome || null,
        summary: classification.summary,
        status: "pending",
        sourceStatus: current.status,
        sourceTurnCount: current.runtime?.turnCount || 0,
        sourceHandoffSequence: current.completion?.sequence || null,
        createdAt: at,
        deliveredAt: null,
        delivery: null,
        acknowledgedAt: null,
        acknowledgement: null,
      },
    };
  });
  if (created) {
    await appendEvent(root, id, {
      type: "coordinator_wake_queued",
      at,
      wake: state.coordinatorWake,
    });
    if (wakeNeedsUser(state)) {
      void signalUserAttention(root, id).catch(() => null);
    }
  }
  return state;
}

export async function markCoordinatorWakeDelivered(root, id, sequence, delivery) {
  const at = new Date().toISOString();
  let delivered = false;
  const state = await updateCollaboration(root, id, (current) => {
    const wake = current.coordinatorWake;
    if (!wake || wake.sequence !== sequence) {
      throw new Error(`Coordinator wake ${sequence} is not current for ${id}.`);
    }
    if (wake.status === "acknowledged") return current;
    delivered = true;
    const performance = markPerformanceMilestone(
      current.performance || createPerformanceTimeline(current.createdAt || at),
      "coordinator_wake_delivered",
      { at, metadata: { sequence } },
    );
    return {
      ...current,
      performance,
      performanceSummary: summarizePerformance(performance),
      coordinatorWake: {
        ...wake,
        status: "delivered",
        deliveredAt: at,
        delivery,
      },
    };
  });
  if (delivered) {
    await appendEvent(root, id, {
      type: "coordinator_wake_delivered",
      at,
      sequence,
      delivery,
    });
  }
  return state;
}

export async function acknowledgeCoordinatorWake(root, id, sequence, {
  provider,
  summary,
  action = "processed",
} = {}) {
  const at = new Date().toISOString();
  let acknowledged = false;
  const state = await updateCollaboration(root, id, (current) => {
    const wake = current.coordinatorWake;
    if (!wake || wake.sequence !== sequence) {
      throw new Error(`Coordinator wake ${sequence} is not current for ${id}.`);
    }
    if (provider && wake.provider !== provider) {
      throw new Error(`Coordinator wake ${sequence} belongs to ${wake.provider}, not ${provider}.`);
    }
    if (wake.status === "acknowledged") return current;
    acknowledged = true;
    const performance = markPerformanceMilestone(
      current.performance || createPerformanceTimeline(current.createdAt || at),
      "coordinator_wake_acknowledged",
      { at, metadata: { sequence, action } },
    );
    return {
      ...current,
      performance,
      performanceSummary: summarizePerformance(performance),
      coordinatorWake: {
        ...wake,
        status: "acknowledged",
        acknowledgedAt: at,
        acknowledgement: {
          provider: provider || wake.provider,
          summary: summary || "Coordinator processed the wake event.",
          action,
        },
      },
    };
  });
  if (acknowledged) {
    await appendEvent(root, id, {
      type: "coordinator_wake_acknowledged",
      at,
      sequence,
      acknowledgement: state.coordinatorWake.acknowledgement,
    });
  }
  return state;
}

export async function listCoordinatorStates({
  root = process.cwd(),
  provider,
  cwd = process.cwd(),
  includeInactive = false,
} = {}) {
  const directory = wakeStateDirectory(root);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const states = await Promise.all(names
    .filter((name) => /^bridge-[0-9a-f-]{36}\.json$/.test(name))
    .map(async (name) => {
      try {
        return JSON.parse(await readFile(resolve(directory, name), "utf8"));
      } catch {
        return null;
      }
    }));
  return states
    .filter(Boolean)
    .filter((state) => !provider || coordinatorProvider(state) === provider)
    .filter((state) => coordinatorWorkspaceMatches(state.workspace, cwd))
    .filter((state) => includeInactive
      || ACTIVE_STATUSES.has(state.status)
      || state.status === "indeterminate"
      || (
        state.runSequence
        && coordinatorProvider(state)
        && TERMINAL_STATUSES.has(state.status)
        && !state.coordinatorWake
      )
      || (state.coordinatorWake && state.coordinatorWake.status !== "acknowledged"))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function coordinatorHookDecision(states) {
  const pendingWake = states.find((state) => (
    state.coordinatorWake
    && state.coordinatorWake.status !== "acknowledged"
    && state.coordinatorWake.actionable
  ));
  if (pendingWake) {
    const wake = pendingWake.coordinatorWake;
    return {
      decision: "block",
      collaborationId: pendingWake.id,
      wake,
      reason: [
        `Collaboration ${pendingWake.id} has coordinator wake ${wake.sequence}: ${wake.kind}.`,
        wake.summary,
        `Call get_collaboration with detail "full", includeTurns sufficient for turns after ${Math.max(0, wake.sourceTurnCount - 1)}, and inspect the completion receipt.`,
        `Process next action "${wake.nextAction}", then call acknowledge_coordinator_wake for sequence ${wake.sequence}.`,
        "Do not end this coordinator turn while the wake remains actionable.",
      ].join(" "),
    };
  }
  const active = states.find((state) => ACTIVE_STATUSES.has(state.status));
  if (active) {
    return {
      decision: "block",
      collaborationId: active.id,
      wake: null,
      reason: [
        `Collaboration ${active.id} is still ${active.status}.`,
        "Continue monitoring it with separate get_collaboration calls using detail status, includeTurns 0, afterUpdatedAt, and waitSeconds 8 or less.",
        "Show changed narrative or lifecycle state, and do not finish the coordinator turn until the collaboration reaches a terminal state.",
      ].join(" "),
    };
  }
  const finalizing = states.find((state) => (
    state.runSequence
    && coordinatorProvider(state)
    && TERMINAL_STATUSES.has(state.status)
    && state.status !== "needs_user"
    && state.status !== "cancelled"
    && !state.coordinatorWake
  ));
  if (finalizing) {
    return {
      decision: "block",
      collaborationId: finalizing.id,
      wake: null,
      reason: [
        `Collaboration ${finalizing.id} reached ${finalizing.status}, but its durable coordinator wake is still being finalized.`,
        "Call get_collaboration again, process the resulting coordinatorWake, and acknowledge it before ending this coordinator turn.",
      ].join(" "),
    };
  }
  const protectedBoundary = states.find((state) => (
    state.status === "needs_user"
    || state.status === "indeterminate"
    || state.coordinatorWake?.kind === "needs_user"
  ));
  if (protectedBoundary) {
    return {
      decision: "allow",
      collaborationId: protectedBoundary.id,
      wake: protectedBoundary.coordinatorWake || null,
      systemMessage: protectedBoundary.status === "indeterminate"
        ? `Collaboration ${protectedBoundary.id} is indeterminate and requires inspection.`
        : `Collaboration ${protectedBoundary.id} requires user input; autonomous continuation is intentionally paused.`,
    };
  }
  return { decision: "allow", collaborationId: null, wake: null };
}

export async function currentCoordinatorState(root, id) {
  return readCollaboration(root, id);
}
