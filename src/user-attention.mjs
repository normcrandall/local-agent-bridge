import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendEvent,
  listCollaborations,
  readCollaboration,
  updateCollaboration,
} from "./collaboration-store.mjs";

const execFileAsync = promisify(execFile);
const SKIP_UPDATE = Symbol("skip-user-attention-update");

export const DEFAULT_ATTENTION_REMINDER_MS = 15 * 60 * 1000;
export const ATTENTION_CLAIM_TIMEOUT_MS = 2 * 60 * 1000;

function clean(value, limit = 300) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function dateMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function notificationsEnabled(environment = process.env) {
  return !["0", "false", "off", "no"].includes(String(environment.AGENT_BRIDGE_ATTENTION_NOTIFICATIONS || "").toLowerCase());
}

export function attentionMessage(state) {
  const wake = state.coordinatorWake;
  const repository = state.github?.repository || state.issueClaim?.repository || null;
  const workspace = state.workspace?.split("/").filter(Boolean).at(-1) || "unknown workspace";
  return {
    title: "Agent Bridge needs your input",
    subtitle: clean(repository || workspace, 120),
    // Notification previews may be visible on a locked screen. Keep the body
    // generic; the durable collaboration receipt remains the source of detail.
    body: "A collaboration is paused at a protected decision. Open Mission Control with: bridge mc --attention",
  };
}

export async function deliverAttentionNotification(message, {
  platform = process.platform,
  run = execFileAsync,
  environment = process.env,
} = {}) {
  if (!notificationsEnabled(environment)) return { delivered: false, adapter: "disabled", reason: "disabled_by_policy" };
  if (platform === "darwin") {
    const script = [
      "on run argv",
      "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv) sound name \"Glass\"",
      "end run",
    ].join("\n");
    await run("/usr/bin/osascript", ["-e", script, "--", message.body, message.title, message.subtitle], {
      timeout: 5_000,
      windowsHide: true,
    });
    return { delivered: true, adapter: "macos_notification_center" };
  }
  if (platform === "linux") {
    await run("notify-send", ["--urgency=critical", "--app-name=Agent Bridge", message.title, `${message.subtitle}\n${message.body}`], {
      timeout: 5_000,
      windowsHide: true,
    });
    return { delivered: true, adapter: "freedesktop_notification" };
  }
  return { delivered: false, adapter: "durable_only", reason: `unsupported_platform_${platform}` };
}

function wakeNeedsUser(state) {
  const wake = state.coordinatorWake;
  return wake
    && wake.status !== "acknowledged"
    && (wake.kind === "needs_user" || wake.nextAction === "needs_user" || state.status === "needs_user");
}

export async function signalUserAttention(root, id, {
  now = Date.now(),
  reminderMs = DEFAULT_ATTENTION_REMINDER_MS,
  force = false,
  platform = process.platform,
  run = execFileAsync,
  environment = process.env,
} = {}) {
  const claimId = randomUUID();
  const at = new Date(now).toISOString();
  let claimed = false;
  let claimedState = null;
  try {
    await updateCollaboration(root, id, (current) => {
      if (!wakeNeedsUser(current)) throw SKIP_UPDATE;
      const attention = current.coordinatorWake.userAttention || null;
      const activeClaim = attention?.status === "sending"
        && now - dateMs(attention.claimedAt) < ATTENTION_CLAIM_TIMEOUT_MS;
      const remindedRecently = attention?.lastDeliveredAt
        && now - dateMs(attention.lastDeliveredAt) < reminderMs;
      if (activeClaim || (!force && remindedRecently)) throw SKIP_UPDATE;
      claimed = true;
      claimedState = current;
      return {
        ...current,
        coordinatorWake: {
          ...current.coordinatorWake,
          userAttention: {
            ...(attention || {}),
            status: "sending",
            claimId,
            claimedAt: at,
            attempt: (attention?.attempt || 0) + 1,
            lastAttemptAt: at,
          },
        },
      };
    });
  } catch (caught) {
    if (caught !== SKIP_UPDATE) throw caught;
  }
  if (!claimed) return { delivered: false, reason: "not_due_or_not_needed" };

  let delivery;
  let error = null;
  try {
    delivery = await deliverAttentionNotification(attentionMessage(claimedState), { platform, run, environment });
  } catch (caught) {
    error = clean(caught.message || caught, 500);
    delivery = { delivered: false, adapter: platform === "darwin" ? "macos_notification_center" : "platform_notification", reason: error };
  }
  const completedAt = new Date(now).toISOString();
  let finalized = false;
  try {
    await updateCollaboration(root, id, (current) => {
      if (current.coordinatorWake?.userAttention?.claimId !== claimId) throw SKIP_UPDATE;
      finalized = true;
      return {
        ...current,
        coordinatorWake: {
          ...current.coordinatorWake,
          userAttention: {
            ...current.coordinatorWake.userAttention,
            status: delivery.delivered ? "delivered" : "failed",
            adapter: delivery.adapter,
            lastDeliveredAt: delivery.delivered ? completedAt : current.coordinatorWake.userAttention.lastDeliveredAt || null,
            completedAt,
            error,
            reason: delivery.reason || null,
          },
        },
      };
    });
  } catch (caught) {
    if (caught !== SKIP_UPDATE) throw caught;
  }
  if (finalized) {
    await appendEvent(root, id, {
      type: "user_attention_signalled",
      at: completedAt,
      wakeSequence: claimedState.coordinatorWake.sequence,
      delivered: delivery.delivered,
      adapter: delivery.adapter,
      reason: delivery.reason || null,
    }).catch(() => {});
  }
  return delivery;
}

export async function scanPendingUserAttention(root, options = {}) {
  const summaries = await listCollaborations(root, { limit: 10_000 });
  const results = [];
  for (const summary of summaries) {
    if (summary.status !== "needs_user" && summary.coordinatorWake?.kind !== "needs_user") continue;
    const state = await readCollaboration(root, summary.id).catch(() => null);
    if (!state || !wakeNeedsUser(state)) continue;
    results.push({ collaborationId: state.id, ...(await signalUserAttention(root, state.id, options)) });
  }
  return results;
}
