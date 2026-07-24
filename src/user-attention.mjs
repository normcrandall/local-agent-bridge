import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import { access, chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { attentionRequestAt, attentionRequestIsFresh } from "./attention-state.mjs";
import { repositoryForLane } from "./mission-control.mjs";
import {
  appendEvent,
  collaborationDirectory,
  listCollaborations,
  readCollaboration,
  updateCollaboration,
} from "./collaboration-store.mjs";

const execFileAsync = promisify(execFile);
const SKIP_UPDATE = Symbol("skip-user-attention-update");
const TERMINAL_NOTIFIER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/node-notifier/vendor/mac.noindex/terminal-notifier.app/Contents/MacOS/terminal-notifier",
);

export const DEFAULT_ATTENTION_REMINDER_MS = 15 * 60 * 1000;
export const ATTENTION_CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
export const ATTENTION_RETRY_BASE_MS = 60 * 1000;

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

export function attentionRepository(state) {
  return state.repository
    || state.github?.repository
    || state.issueClaim?.repository
    || state.githubReview?.repository
    || state.githubBuilder?.repository
    || null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export async function createAttentionAction(root, state, { home = homedir() } = {}) {
  const repository = attentionRepository(state);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) return null;
  const directory = resolve(collaborationDirectory(root), "attention-actions");
  const digest = createHash("sha256").update(repository).digest("hex").slice(0, 16);
  const path = resolve(directory, `mission-control-${digest}.command`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory).catch(() => null);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) return null;
  if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) return null;
  await chmod(directory, 0o700);
  const hardenedDirectory = await lstat(directory).catch(() => null);
  if (!hardenedDirectory || (hardenedDirectory.mode & 0o077) !== 0) return null;

  const bridge = resolve(home, ".local/bin/bridge");
  const sourceMissionControl = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/mission-control.mjs");
  const bridgeInstalled = await access(bridge, fsConstants.X_OK).then(() => true).catch(() => false);
  const launch = bridgeInstalled
    ? `${shellQuote(bridge)} mc --attention --repo ${shellQuote(repository)}`
    : `${shellQuote(process.execPath)} ${shellQuote(sourceMissionControl)} --attention --repo ${shellQuote(repository)}`;
  await writeFile(path, `#!/bin/zsh\nexec ${launch}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return pathToFileURL(path).href;
}

export function attentionMessage(state, { actionUrl = null, environment = process.env } = {}) {
  const repository = attentionRepository(state);
  const workspace = state.workspace?.split("/").filter(Boolean).at(-1) || "unknown workspace";
  const bridge = clean(state.id || "unknown bridge", 24);
  const generic = String(environment.AGENT_BRIDGE_ATTENTION_DETAIL || "").toLowerCase() === "generic";
  return {
    title: "Agent Bridge needs your input",
    subtitle: generic ? "Protected decision" : clean(`${repository || workspace} · ${bridge}`, 120),
    body: generic
      ? "A provider stopped at a protected decision. Click Show or run: bridge mc --attention"
      : `A provider stopped at a protected decision. Open: bridge mc --attention${repository ? ` --repo ${repository}` : ""}`,
    actionUrl,
    group: `${state.id || "bridge"}:${state.coordinatorWake?.sequence || 0}`,
  };
}

function notificationEnvironment(environment = process.env) {
  const allowed = ["HOME", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY", "LANG", "LC_ALL"];
  return Object.fromEntries([
    ...allowed.filter((key) => environment[key]).map((key) => [key, environment[key]]),
    ["PATH", "/usr/bin:/bin"],
  ]);
}

export async function deliverAttentionNotification(message, {
  platform = process.platform,
  run = execFileAsync,
  environment = process.env,
} = {}) {
  if (!notificationsEnabled(environment)) return { delivered: false, adapter: "disabled", reason: "disabled_by_policy" };
  if (platform === "darwin") {
    if (!existsSync(TERMINAL_NOTIFIER)) {
      const script = `display notification ${JSON.stringify(message.body)} with title ${JSON.stringify(message.title)} subtitle ${JSON.stringify(message.subtitle)} sound name "Glass"`;
      await run("/usr/bin/osascript", ["-e", script], {
        timeout: 5_000,
        windowsHide: true,
        env: notificationEnvironment(environment),
      });
      return { delivered: true, adapter: "macos_notification_center", actionable: false };
    }
    const args = [
      "-title", message.title,
      "-subtitle", message.subtitle,
      "-message", message.body,
      "-sound", "Glass",
      "-group", message.group || "agent-bridge-attention",
    ];
    if (message.actionUrl) args.push("-open", message.actionUrl);
    await run(TERMINAL_NOTIFIER, args, {
      timeout: 5_000,
      windowsHide: true,
      env: notificationEnvironment(environment),
    });
    return { delivered: true, adapter: "macos_terminal_notifier", actionable: Boolean(message.actionUrl) };
  }
  if (platform === "linux") {
    await run("/usr/bin/notify-send", ["--urgency=critical", "--app-name=Agent Bridge", message.title, `${message.subtitle}\n${message.body}`], {
      timeout: 5_000,
      windowsHide: true,
      env: notificationEnvironment(environment),
    });
    return { delivered: true, adapter: "freedesktop_notification" };
  }
  return { delivered: false, adapter: "durable_only", reason: `unsupported_platform_${platform}` };
}

export function wakeNeedsUser(state) {
  const wake = state.coordinatorWake;
  const lifecycle = String(state.status || state.lifecyclePhase || "").toLowerCase();
  return lifecycle === "needs_user"
    && !state.runtime?.activeCall
    && wake
    && wake.status !== "acknowledged"
    && (wake.kind === "needs_user" || wake.nextAction === "needs_user");
}

export function attentionNeedsUser(state) {
  return Boolean(wakeNeedsUser(state));
}

function attentionReceipt(state) {
  return state.coordinatorWake?.userAttention || null;
}

function withAttentionReceipt(state, receipt) {
  return {
    ...state,
    coordinatorWake: { ...state.coordinatorWake, userAttention: receipt },
  };
}

function retryDelay(attention, reminderMs) {
  if (attention?.status === "delivered") return reminderMs;
  const exponent = Math.max(0, Math.min(8, (attention?.attempt || 1) - 1));
  return Math.min(reminderMs, ATTENTION_RETRY_BASE_MS * (2 ** exponent));
}

export async function signalUserAttention(root, id, {
  now = Date.now(),
  reminderMs = DEFAULT_ATTENTION_REMINDER_MS,
  force = false,
  platform = process.platform,
  run = execFileAsync,
  environment = process.env,
  clock = () => Date.now(),
} = {}) {
  const claimId = randomUUID();
  const at = new Date(now).toISOString();
  let claimed = false;
  let claimedState = null;
  try {
    await updateCollaboration(root, id, (current) => {
      if (!attentionNeedsUser(current)) throw SKIP_UPDATE;
      const requestedAt = attentionRequestAt(current);
      const storedAttention = attentionReceipt(current);
      const attention = storedAttention?.requestedAt && storedAttention.requestedAt !== requestedAt
        ? null
        : storedAttention;
      if (attention?.status === "delivered") throw SKIP_UPDATE;
      if (!notificationsEnabled(environment) && attention?.reason === "disabled_by_policy") throw SKIP_UPDATE;
      if (attention?.reason?.startsWith("unsupported_platform_")) throw SKIP_UPDATE;
      const activeClaim = attention?.status === "sending"
        && now - dateMs(attention.claimedAt) < ATTENTION_CLAIM_TIMEOUT_MS;
      const attemptedRecently = attention?.lastAttemptAt
        && now - dateMs(attention.lastAttemptAt) < retryDelay(attention, reminderMs);
      if (activeClaim || (!force && attemptedRecently)) throw SKIP_UPDATE;
      claimed = true;
      claimedState = current;
      return withAttentionReceipt(current, {
        ...(attention || {}),
        status: "sending",
        claimId,
        claimedAt: at,
        attempt: (attention?.attempt || 0) + 1,
        lastAttemptAt: at,
        requestedAt,
      });
    });
  } catch (caught) {
    if (caught !== SKIP_UPDATE) throw caught;
  }
  if (!claimed) return { delivered: false, reason: "not_due_or_not_needed" };

  let delivery;
  let error = null;
  try {
    const repository = await repositoryForLane({
      repository: attentionRepository(claimedState),
      workspace: claimedState.workspace,
    });
    const notificationState = { ...claimedState, repository };
    const actionUrl = platform === "darwin"
      ? await createAttentionAction(root, notificationState).catch(() => null)
      : null;
    delivery = await deliverAttentionNotification(attentionMessage(notificationState, { actionUrl, environment }), { platform, run, environment });
  } catch (caught) {
    error = clean(caught.message || caught, 500);
    delivery = { delivered: false, adapter: platform === "darwin" ? "macos_terminal_notifier" : "platform_notification", reason: error };
  }
  const completedAt = new Date(clock()).toISOString();
  let finalized = false;
  try {
    await updateCollaboration(root, id, (current) => {
      const attention = attentionReceipt(current);
      if (attention?.claimId !== claimId) throw SKIP_UPDATE;
      finalized = true;
      return withAttentionReceipt(current, {
        ...attention,
        status: delivery.delivered ? "delivered" : "failed",
        adapter: delivery.adapter,
        lastDeliveredAt: delivery.delivered ? completedAt : attention.lastDeliveredAt || null,
        completedAt,
        error,
        reason: delivery.reason || null,
      });
    });
  } catch (caught) {
    if (caught !== SKIP_UPDATE) throw caught;
  }
  if (finalized) {
    await appendEvent(root, id, {
      type: "user_attention_signalled",
      at: completedAt,
      wakeSequence: claimedState.coordinatorWake?.sequence || null,
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
    if (summary.status !== "needs_user" || summary.coordinatorWake?.kind !== "needs_user") continue;
    const state = await readCollaboration(root, summary.id).catch(() => null);
    if (!state || !attentionNeedsUser(state)) continue;
    if (!options.force && !attentionRequestIsFresh(state, options.now)) continue;
    const result = await signalUserAttention(root, state.id, options);
    if (result.reason !== "not_due_or_not_needed") {
      results.push({ collaborationId: state.id, ...result });
    }
  }
  return results;
}
