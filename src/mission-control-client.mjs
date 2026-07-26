import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import {
  createMissionControlEventState,
  reduceMissionControlEvent,
} from "./mission-control-event-reducer.mjs";
import { projectMissionControlViewModel } from "./mission-control-view-model.mjs";
import {
  createMissionControlNavigationState,
  reconcileMissionControlNavigation,
} from "./mission-control-navigation.mjs";
import {
  getMissionControlEventSnapshot,
  readMissionControlEvents,
} from "./worker-supervisor-client.mjs";

function textFrom(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  return typeof text === "string" ? text : JSON.stringify(result.structuredContent || {});
}

export async function callMissionControlAction({ runtimeRoot, workspaceRoot = runtimeRoot, stateRoot, name, arguments: input }) {
  const client = new Client({ name: "agent-bridge-mission-control", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(runtimeRoot, "src/collaboration-bridge.mjs")],
    cwd: runtimeRoot,
    env: { ...process.env, BRIDGE_RUNTIME_ROOT: runtimeRoot, BRIDGE_WORKSPACE_ROOT: workspaceRoot, BRIDGE_COLLABORATION_DIR: stateRoot },
  });
  try {
    await client.connect(transport, { timeout: 5_000 });
    const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 30_000 });
    if (result.isError) throw new Error(textFrom(result));
    return result.structuredContent || { message: textFrom(result) };
  } finally {
    await client.close().catch(() => {});
  }
}

const DEFAULT_SUBSCRIPTION_WAIT_MS = 5_000;
const DEFAULT_SUBSCRIPTION_BATCH = 100;

function delay(ms, signal) {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Stateful Mission Control subscription client.
 *
 * The reducer state owns the durable in-process cursor. A transport failure does
 * not advance it, so reconnect repeats the exact read. A server-declared gap (or
 * a reducer-discovered ordering violation) performs one bounded snapshot resync.
 * At most one render notification is emitted for a subscription batch, even when
 * that batch contains the maximum 100 deltas.
 */
export function createMissionControlSubscriptionClient({
  runtimeRoot,
  workspaceRoot = runtimeRoot,
  stateRoot,
  waitMs = DEFAULT_SUBSCRIPTION_WAIT_MS,
  maxEvents = DEFAULT_SUBSCRIPTION_BATCH,
  reconnectDelayMs = 250,
  navigationState = createMissionControlNavigationState(),
  snapshotReader = getMissionControlEventSnapshot,
  eventReader = readMissionControlEvents,
  onUpdate = () => {},
  onError = () => {},
} = {}) {
  if (!runtimeRoot) throw new Error("Mission Control subscription requires runtimeRoot.");
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5_000) {
    throw new Error("Mission Control subscription wait must be between 0 and 5000ms.");
  }
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 100) {
    throw new Error("Mission Control subscription batch must be between 1 and 100.");
  }
  if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 0 || reconnectDelayMs > 60_000) {
    throw new Error("Mission Control reconnect delay must be between 0 and 60000ms.");
  }

  const transport = { runtimeRoot, workspaceRoot, stateDirectory: stateRoot };
  let eventState = null;
  let viewModel = null;
  let navigation = createMissionControlNavigationState(navigationState);
  let stopped = false;
  let running = null;
  let redrawCount = 0;
  let reconnectCount = 0;
  let resyncCount = 0;
  let consecutiveResyncs = 0;

  const publish = async (reason, eventCount = 0) => {
    viewModel = projectMissionControlViewModel(eventState, viewModel?.clientState || {});
    const reconciled = reconcileMissionControlNavigation(navigation, viewModel);
    navigation = reconciled.state;
    redrawCount += 1;
    await onUpdate({
      reason,
      eventCount,
      eventState,
      viewModel,
      navigation: reconciled,
      checkpoint: { streamId: eventState.streamId, cursor: eventState.cursor },
    });
  };

  const resync = async (reason = "snapshot", signal) => {
    const snapshot = await snapshotReader({ ...transport, signal });
    eventState = createMissionControlEventState(snapshot);
    if (reason !== "bootstrap") resyncCount += 1;
    await publish(reason, 0);
    return { status: reason, eventCount: 0, cursor: eventState.cursor };
  };

  const pollOnce = async ({ signal } = {}) => {
    if (stopped) return { status: "stopped", eventCount: 0, cursor: eventState?.cursor ?? null };
    if (!eventState) return resync("bootstrap", signal);
    const result = await eventReader({
      ...transport,
      streamId: eventState.streamId,
      cursor: eventState.cursor,
      maxEvents,
      waitMs,
      signal,
    });
    if (result.resyncRequired) return resync(`resync:${result.reason || "server_requested"}`, signal);
    if (!Array.isArray(result.events) || result.events.length === 0) {
      return { status: "idle", eventCount: 0, cursor: eventState.cursor };
    }

    let next = eventState;
    for (const event of result.events) {
      next = reduceMissionControlEvent(next, event);
      if (next.sync?.status === "resync_required") {
        return resync(`resync:${next.sync.reason || "reducer_requested"}`, signal);
      }
    }
    eventState = next;
    await publish("events", result.events.length);
    return { status: result.hasMore ? "more" : "events", eventCount: result.events.length, cursor: eventState.cursor };
  };

  const run = ({ signal } = {}) => {
    if (running) return running;
    running = (async () => {
      while (!stopped && !signal?.aborted) {
        try {
          const result = await pollOnce({ signal });
          if (result.status === "more") {
            consecutiveResyncs = 0;
            continue;
          }
          if (result.status.startsWith("resync:")) {
            consecutiveResyncs += 1;
            const backoffMs = Math.min(5_000, Math.max(25, reconnectDelayMs) * (2 ** Math.min(4, consecutiveResyncs - 1)));
            await delay(backoffMs, signal);
            continue;
          }
          consecutiveResyncs = 0;
        } catch (error) {
          if (stopped || signal?.aborted) break;
          reconnectCount += 1;
          await onError(error, { checkpoint: eventState ? { streamId: eventState.streamId, cursor: eventState.cursor } : null });
          await delay(reconnectDelayMs, signal);
        }
      }
    })().finally(() => { running = null; });
    return running;
  };

  return {
    pollOnce,
    run,
    stop() { stopped = true; },
    get snapshot() {
      return {
        stopped,
        eventState,
        viewModel,
        navigation,
        checkpoint: eventState ? { streamId: eventState.streamId, cursor: eventState.cursor } : null,
        redrawCount,
        reconnectCount,
        resyncCount,
        consecutiveResyncs,
      };
    },
    setNavigation(next) { navigation = createMissionControlNavigationState(next); },
  };
}
