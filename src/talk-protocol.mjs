import { normalizeHandoff } from "./handoff-protocol.mjs";
import {
  extractAndSaveCapsuleBeforeObserve,
  redactSecretsAndInjectionFromText,
} from "./context-capsule.mjs";

const STATUSES = new Set(["CONTINUE", "AGREED", "NEEDS_USER"]);
export const KNOWN_AGENTS = ["claude", "codex", "antigravity", "docker", "ollama"];
export const WRITER_AGENTS = ["claude", "codex", "antigravity"];
export const DEFAULT_AGENTS = [...WRITER_AGENTS];
const MAX_CAPSULE_PROTOCOL_RETRIES = 2;

const DISPLAY_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  docker: "Docker Model Runner",
  ollama: "Ollama",
};

export function agentName(agent) {
  if (!DISPLAY_NAMES[agent]) throw new Error(`Unknown agent: ${agent}`);
  return DISPLAY_NAMES[agent];
}

export function parseStatus(message) {
  const matches = [...message.matchAll(/^STATUS:\s*(CONTINUE|AGREED|NEEDS_USER)(?:\s+[—-]\s*[^\r\n]+)?\s*$/gim)];
  const status = matches.at(-1)?.[1]?.toUpperCase() || "CONTINUE";
  return STATUSES.has(status) ? status : "CONTINUE";
}

export function parseHandoffEnvelope(message) {
  const lines = String(message || "").split("\n").filter((line) => /^HANDOFF:\s*/i.test(line));
  if (!lines.length) return null;
  if (lines.length > 1) {
    throw new Error("Multiple HANDOFF lines are not allowed.");
  }
  const raw = lines.at(-1).replace(/^HANDOFF:\s*/i, "");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("HANDOFF must contain valid single-line JSON."); }
  return normalizeHandoff(parsed);
}

export function parseDecisionEnvelope(message) {
  const lines = String(message || "").split("\n").filter((line) => /^DECISION:\s*/i.test(line));
  if (!lines.length) return null;
  const raw = lines.at(-1).replace(/^DECISION:\s*/i, "");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("DECISION must contain valid single-line JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("DECISION must be a JSON object.");
  return parsed;
}

function capsuleProtocolErrorCode(error) {
  const reason = error?.message || String(error);
  if (/Multiple HANDOFF/i.test(reason)) return "multiple_handoffs";
  if (/size|hard cap/i.test(reason)) return "size_limit";
  if (/source/i.test(reason)) return "missing_fact_source";
  if (/allowlist|allowlisted|unrecognized key/i.test(reason)) return "schema_allowlist";
  if (/marker.*missing/i.test(reason)) return "missing_capsule_file";
  return "invalid_capsule";
}

function capsuleProtocolRetryMessage(code, attempt) {
  return [
    `Context capsule protocol error (${code}); the response was rejected before observation.`,
    `Retry ${attempt}/${MAX_CAPSULE_PROTOCOL_RETRIES}: emit exactly one HANDOFF line with a schema-valid capsule, explicit sources for every fact, and content within the configured size cap.`,
    "STATUS: CONTINUE",
  ].join("\n");
}

export function validateAgents(agents, startAgent) {
  if (!Array.isArray(agents) || agents.length < 1 || agents.length > KNOWN_AGENTS.length) {
    throw new Error(`agents must contain one to ${KNOWN_AGENTS.length} supported agents.`);
  }
  if (new Set(agents).size !== agents.length || agents.some((agent) => !KNOWN_AGENTS.includes(agent))) {
    throw new Error(`agents must be unique values from: ${KNOWN_AGENTS.join(", ")}.`);
  }
  if (!agents.includes(startAgent)) throw new Error("startAgent must be included in agents.");
}

function protocol(agent, agents, mode, browser, writer) {
  const peers = agents.filter((candidate) => candidate !== agent).map(agentName).join(" and ");
  let access = "This dialogue is read-only. Inspect and discuss the workspace, but do not edit files.";
  if (mode === "work" && writer === agent) {
    access = "You are the only writer. You may edit the shared workspace when useful and must state exactly which files you changed.";
  } else if (mode === "work" && writer) {
    access = `${agentName(writer)} is the only writer. You are a read-only planner or reviewer and must not edit files.`;
  } else if (mode === "work") {
    access = "You may edit the shared workspace when useful. State exactly which files you changed; do not overlap edits another participant is making.";
  }
  const browserAccess = browser
    ? "Use an available isolated browser only when the task needs it. It has no signed-in user profile."
    : "Do not use browser tools in this dialogue.";

  const audience = peers
    ? `speaking directly to ${peers} through a local turn broker`
    : "working as the only currently available participant through a local turn broker";

  return `You are ${agentName(agent)} ${audience}.

${access}
${browserAccess}

Conversation rules:
- Address the other participants, not the user.
- Advance the task: propose, challenge, verify, or synthesize. Do not merely agree.
- Before each long-running phase, emit a brief user-visible progress sentence stating the phase, what you are doing, and what comes next. Keep it factual and do not expose private reasoning.
- Do not invoke another participant through MCP; the broker delivers each message.
- Keep each turn focused and under 700 words.
- When resolving a concrete choice, emit one single-line receipt before STATUS using: DECISION: {"question":"...","category":"reversible_technical","alternatives":["..."],"decision":"...","confidence":0.8,"dissent":[],"rollbackPath":"...","owner":"agent-name"}. Protected categories are escalated; this never grants new authority.
- When your bounded assignment is ready to hand back, emit one validated single-line receipt before STATUS using: HANDOFF: {"outcome":"completed|blocked|needs_review|continue","summary":"...","artifacts":["..."],"verification":["..."],"commit":null,"pullRequest":null,"remaining":[],"nextAction":"chair_verify|peer_review|writer_fix|continue|needs_user"}. Report only observed evidence. Use outcome completed with nextAction chair_verify when the chair should independently verify completion.
- End with exactly one bare status line and no suffix or explanation on that line. Put any explanation immediately before it. Choose one literal marker:
  STATUS: CONTINUE
  STATUS: AGREED
  STATUS: NEEDS_USER`;
}

export function firstTurnPrompt({ agent, agents, task, mode, browser, writer }) {
  return `${protocol(agent, agents, mode, browser, writer)}

Shared task:
${task}

You have the first turn. Establish a concrete direction, identify the highest-risk uncertainty, and give the other participants something specific to evaluate.`;
}

export function replyPrompt({ agent, agents, task, previousAgent, previousMessage, mode, browser, writer }) {
  const previousName = previousAgent ? agentName(previousAgent) : "the user";
  return `${protocol(agent, agents, mode, browser, writer)}

Shared task:
${task}

Latest message from ${previousName}:
---
${previousMessage}
---

Respond directly. Check claims against the workspace when relevant, resolve disagreements with evidence, and move toward a concrete outcome.`;
}

export async function runConversation({
  task,
  maxTurns = 6,
  agents = ["claude", "codex"],
  startAgent = agents[0],
  mode = "review",
  browser = false,
  writer = null,
  initialState = null,
  send,
  onTurn = async () => {},
  onState = async () => {},
  onAgentUnavailable = async () => {},
  shouldStop = async () => false,
  workspace = null,
  collaborationId = null,
}) {
  if (!task?.trim()) throw new Error("A task is required.");
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) {
    throw new Error("maxTurns must be an integer from 1 to 20.");
  }
  validateAgents(agents, startAgent);
  if (!["review", "work"].includes(mode)) throw new Error("mode must be review or work.");
  if (writer && !agents.includes(writer)) throw new Error("writer must be included in agents.");
  if (writer && !WRITER_AGENTS.includes(writer)) throw new Error(`${agentName(writer)} is review-only and cannot be selected as writer.`);

  const activeAgents = [...agents];
  const unavailableAgents = { ...(initialState?.unavailableAgents || {}) };
  const sessions = {
    ...Object.fromEntries(agents.map((agent) => [agent, null])),
    ...(initialState?.sessions || {}),
  };
  const requestedNextAgent = initialState?.nextAgent || startAgent;
  const nextAgent = activeAgents.includes(requestedNextAgent) ? requestedNextAgent : activeAgents[0];
  let agentIndex = activeAgents.indexOf(nextAgent);
  let previousMessage = initialState?.previousMessage ?? null;
  let previousAgent = initialState?.previousAgent ?? null;
  let agreementStreak = initialState?.agreementStreak ?? 0;
  let totalTurnCount = initialState?.turnCount ?? 0;
  let effectiveWriter = writer;
  const turns = [];
  const capsuleProtocolRetries = Object.fromEntries(agents.map((agent) => [agent, 0]));

  const stateSnapshot = () => ({
    sessions: { ...sessions },
    nextAgent: activeAgents.length ? activeAgents[agentIndex] : null,
    availableAgents: [...activeAgents],
    unavailableAgents: { ...unavailableAgents },
    writer: effectiveWriter,
    previousMessage,
    previousAgent,
    agreementStreak,
    turnCount: totalTurnCount,
  });

  let completedTurns = 0;
  while (completedTurns < maxTurns && activeAgents.length) {
    const stopReason = await shouldStop();
    if (stopReason) {
      return { reason: stopReason === true ? "cancelled" : stopReason, turns, sessions, state: stateSnapshot() };
    }
    const number = totalTurnCount + 1;
    const agent = activeAgents[agentIndex];
    const prompt = previousMessage === null
      ? firstTurnPrompt({ agent, agents: activeAgents, task, mode, browser, writer: effectiveWriter })
      : replyPrompt({ agent, agents: activeAgents, task, previousAgent, previousMessage, mode, browser, writer: effectiveWriter });
    const agentMode = ["ollama", "docker"].includes(agent) || (mode === "work" && effectiveWriter && agent !== effectiveWriter) ? "review" : mode;
    let response;
    try {
      response = await send({ agent, prompt, sessionId: sessions[agent], mode: agentMode, browser });
      if (!response?.message?.trim()) throw new Error(`${agent} returned an empty message.`);
    } catch (error) {
      const reason = error?.message || String(error);
      if (error?.indeterminate) {
        const state = stateSnapshot();
        state.activeCall = {
          ...(initialState?.activeCall || {}),
          agent,
          status: "indeterminate",
          summary: reason,
          heartbeatAt: new Date().toISOString(),
        };
        await onState(state);
        return { reason: "indeterminate", error: reason, turns, sessions, state };
      }
      unavailableAgents[agent] = reason;
      activeAgents.splice(agentIndex, 1);
      if (agentIndex >= activeAgents.length) agentIndex = 0;
      agreementStreak = 0;
      if (effectiveWriter === agent) {
        effectiveWriter = activeAgents.find((candidate) => WRITER_AGENTS.includes(candidate)) || null;
        if (!effectiveWriter) {
          await onAgentUnavailable({ agent, reason, availableAgents: [...activeAgents], writer: null });
          const state = stateSnapshot();
          await onState(state);
          return {
            reason: "failed",
            error: "No write-capable provider is currently available; remaining participants are review-only.",
            turns,
            sessions,
            state,
          };
        }
      }
      await onAgentUnavailable({
        agent,
        reason,
        availableAgents: [...activeAgents],
        writer: effectiveWriter,
      });
      const state = stateSnapshot();
      await onState(state);
      if (!activeAgents.length) {
        return {
          reason: "failed",
          error: "No requested model is currently available.",
          turns,
          sessions,
          state,
        };
      }
      continue;
    }
    sessions[agent] = response.sessionId || sessions[agent];

    try {
      if (workspace && collaborationId) {
        const { sanitizedMessage } = await extractAndSaveCapsuleBeforeObserve(response.message, {
          agent,
          turn: number,
          workspace,
          collaborationId,
        });
        response.message = sanitizedMessage;
      } else {
        response.message = redactSecretsAndInjectionFromText(response.message);
      }
      capsuleProtocolRetries[agent] = 0;
    } catch (error) {
      const attempt = capsuleProtocolRetries[agent] + 1;
      capsuleProtocolRetries[agent] = attempt;
      const code = capsuleProtocolErrorCode(error);
      const message = capsuleProtocolRetryMessage(code, attempt);
      const turn = {
        number,
        agent,
        message,
        status: "CONTINUE",
        sessionId: sessions[agent],
        metadata: response.metadata || null,
        decision: null,
        handoff: null,
        handoffError: null,
        protocolError: { code, attempt, maxAttempts: MAX_CAPSULE_PROTOCOL_RETRIES },
      };
      turns.push(turn);
      agreementStreak = 0;
      previousMessage = message;
      previousAgent = agent;
      totalTurnCount = number;
      const state = stateSnapshot();
      await onTurn(turn);
      await onState(state, turn);

      const afterTurnStop = await shouldStop();
      if (afterTurnStop) {
        return { reason: afterTurnStop === true ? "cancelled" : afterTurnStop, turns, sessions, state };
      }
      if (attempt >= MAX_CAPSULE_PROTOCOL_RETRIES) {
        return {
          reason: "turn_limit",
          error: `Context capsule protocol retries exhausted for ${agent}.`,
          turns,
          sessions,
          state,
        };
      }
      continue;
    }

    const status = parseStatus(response.message);
    let handoff = null;
    let handoffError = null;
    try { handoff = parseHandoffEnvelope(response.message); }
    catch (error) { handoffError = error.message; }
    let decision = null;
    try { decision = parseDecisionEnvelope(response.message); }
    catch (error) { decision = { invalid: error.message }; }
    const turn = {
      number,
      agent,
      message: response.message,
      status,
      sessionId: sessions[agent],
      metadata: response.metadata || null,
      decision,
      handoff,
      handoffError,
    };
    turns.push(turn);
    agreementStreak = status === "AGREED" ? agreementStreak + 1 : 0;
    previousMessage = response.message;
    previousAgent = agent;
    agentIndex = (agentIndex + 1) % activeAgents.length;
    totalTurnCount = number;
    completedTurns += 1;
    const state = stateSnapshot();
    await onTurn(turn);
    await onState(state, turn);

    if (status === "NEEDS_USER") return { reason: "needs_user", turns, sessions, state };
    const afterTurnStop = await shouldStop();
    if (afterTurnStop) return { reason: afterTurnStop === true ? "cancelled" : afterTurnStop, turns, sessions, state };
    if (agreementStreak >= activeAgents.length) return { reason: "agreed", turns, sessions, state };
  }

  return { reason: "turn_limit", turns, sessions, state: stateSnapshot() };
}
