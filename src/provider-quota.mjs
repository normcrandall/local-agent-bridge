import { spawn } from "node:child_process";

export const PROVIDER_QUOTA_REFRESH_MS = 60_000;
export const PROVIDER_QUOTA_MAX_STALE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

const hostedProvider = (provider) => ({
  provider,
  status: "unavailable",
  observedAt: null,
  lastAttemptAt: null,
  windows: { fiveHour: null, week: null },
});

const localProvider = (provider) => ({
  provider,
  status: "local",
  observedAt: null,
  lastAttemptAt: null,
  windows: { fiveHour: null, week: null },
});

export function emptyProviderQuotaSnapshot(now = Date.now()) {
  return {
    refreshMs: PROVIDER_QUOTA_REFRESH_MS,
    updatedAt: null,
    lastAttemptAt: new Date(now).toISOString(),
    providers: {
      codex: hostedProvider("codex"),
      claude: hostedProvider("claude"),
      antigravity: hostedProvider("antigravity"),
      docker: localProvider("docker"),
      ollama: localProvider("ollama"),
    },
  };
}

function boundedPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function quotaWindow({ usedPercent, windowMinutes = null, resetsAt = null, resetsText = null } = {}) {
  const used = boundedPercent(usedPercent);
  if (used === null) return null;
  return {
    usedPercent: used,
    remainingPercent: 100 - used,
    windowMinutes: windowMinutes !== null && windowMinutes !== undefined && Number.isFinite(Number(windowMinutes)) ? Number(windowMinutes) : null,
    resetsAt: resetsAt !== null && resetsAt !== undefined && Number.isFinite(Number(resetsAt)) ? Number(resetsAt) : null,
    resetsText: resetsText || null,
  };
}

function commandJsonLines(command, args, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd,
  signal,
  onStart,
  accept,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const onAbort = () => finish(new Error(`${command} quota probe cancelled`));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!child.killed) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`${command} quota probe timed out`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    child.on("error", (error) => finish(error));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1_048_576) return finish(new Error(`${command} quota response was too large`));
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        try {
          const result = accept?.(message, child);
          if (result?.done === true) return finish(null, result.value);
        } catch (error) {
          return finish(error);
        }
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      const detail = String(stderr || stdout).trim().slice(0, 240);
      finish(new Error(`${command} quota probe exited ${code}${detail ? `: ${detail}` : ""}`));
    });
    try { onStart?.(child); } catch (error) { finish(error); }
  });
}

export async function collectCodexQuota({
  command = process.env.CODEX_BIN || "codex",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now(),
  signal,
} = {}) {
  const result = await commandJsonLines(command, ["app-server", "--stdio"], {
    timeoutMs,
    signal,
    onStart(child) {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "bridge-mission-control", title: "Bridge Mission Control", version: "0.2.0" },
          capabilities: { experimentalApi: true },
        },
      })}\n`);
    },
    accept(message, child) {
      const isResponse = Object.hasOwn(message, "result") || Object.hasOwn(message, "error");
      if (message.id === 1 && isResponse) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" })}\n`);
      }
      if (message.id === 2 && message.error) throw new Error(message.error.message || "Codex rate-limit request failed");
      if (message.id === 2 && isResponse) return { done: true, value: message.result };
      return undefined;
    },
  });
  return parseCodexRateLimits(result, now);
}

export function parseCodexRateLimits(result, now = Date.now()) {
  const limits = result?.rateLimits || {};
  const windows = [limits.primary, limits.secondary].filter(Boolean);
  const findWindow = (minutes) => windows.find((window) => Number(window.windowDurationMins) === minutes);
  const parseWindow = (window) => window ? quotaWindow({
    usedPercent: window.usedPercent,
    windowMinutes: window.windowDurationMins,
    resetsAt: window.resetsAt,
  }) : null;
  const fiveHour = parseWindow(findWindow(300));
  const week = parseWindow(findWindow(10_080));
  const observedAt = new Date(now).toISOString();
  return {
    provider: "codex",
    status: fiveHour || week ? "available" : "unavailable",
    source: "codex_app_server",
    observedAt,
    lastAttemptAt: observedAt,
    plan: limits.planType || null,
    windows: {
      fiveHour,
      week,
    },
  };
}

export function parseClaudeUsage(resultText) {
  const text = String(resultText || "");
  const parseLine = (pattern, windowMinutes) => {
    const match = text.match(pattern);
    if (!match) return null;
    return quotaWindow({ usedPercent: match[1], windowMinutes, resetsText: match[2]?.trim() || null });
  };
  return {
    fiveHour: parseLine(/Current session:\s*(\d+)% used\s*·\s*resets\s+([^\n]+)/i, 300),
    week: parseLine(/Current week \(all models\):\s*(\d+)% used\s*·\s*resets\s+([^\n]+)/i, 10_080),
  };
}

export async function collectClaudeQuota({
  command = process.env.CLAUDE_BIN || "claude",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now(),
  signal,
} = {}) {
  const result = await commandJsonLines(command, ["--safe-mode", "--no-session-persistence", "-p", "--output-format", "json", "/usage"], {
    timeoutMs,
    signal,
    accept(message) {
      if (message.type === "result" || typeof message.result === "string") return { done: true, value: message };
      return undefined;
    },
  });
  if (result?.num_turns !== 0) {
    const error = new Error("Claude /usage did not return a zero-turn result; automatic quota probing was disabled");
    error.permanent = true;
    throw error;
  }
  const windows = parseClaudeUsage(result?.result);
  const observedAt = new Date(now).toISOString();
  return {
    provider: "claude",
    status: windows.fiveHour || windows.week ? "available" : "unavailable",
    source: "claude_usage_command",
    observedAt,
    lastAttemptAt: observedAt,
    windows,
  };
}

function safeError(error) {
  return String(error?.message || error || "quota unavailable").replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

export function createProviderQuotaMonitor({
  refreshMs = PROVIDER_QUOTA_REFRESH_MS,
  maxStaleMs = PROVIDER_QUOTA_MAX_STALE_MS,
  now = () => Date.now(),
  collectors = {
    codex: collectCodexQuota,
    claude: collectClaudeQuota,
  },
} = {}) {
  let current = emptyProviderQuotaSnapshot(now());
  current.refreshMs = refreshMs;
  let refreshPromise = null;
  let activeController = null;
  const disabledProviders = new Set();

  const refresh = async () => {
    if (refreshPromise) return refreshPromise;
    const startedAt = now();
    activeController = new AbortController();
    refreshPromise = (async () => {
      const entries = Object.entries(collectors);
      const nextProviders = { ...current.providers };
      const results = await Promise.allSettled(entries.map(async ([provider, collector]) => {
        if (disabledProviders.has(provider)) {
          const error = new Error(`${provider} quota probing is disabled after an unsafe response`);
          error.permanent = true;
          throw error;
        }
        return [provider, await collector({ now: startedAt, signal: activeController.signal })];
      }));
      for (let index = 0; index < results.length; index += 1) {
        const provider = entries[index][0];
        const result = results[index];
        if (result.status === "fulfilled") {
          const [, observation] = result.value;
          nextProviders[provider] = observation;
          continue;
        }
        const previous = current.providers[provider] || hostedProvider(provider);
        if (result.reason?.permanent) disabledProviders.add(provider);
        const observedAt = Date.parse(previous.observedAt || "");
        const retainStale = !result.reason?.permanent
          && (previous.status === "available" || previous.status === "stale")
          && Number.isFinite(observedAt)
          && startedAt - observedAt <= maxStaleMs;
        nextProviders[provider] = {
          ...previous,
          status: retainStale ? "stale" : "unavailable",
          observedAt: retainStale ? previous.observedAt : null,
          windows: retainStale ? previous.windows : { fiveHour: null, week: null },
          lastAttemptAt: new Date(startedAt).toISOString(),
          error: safeError(result.reason),
        };
      }
      const completedAt = now();
      current = {
        refreshMs,
        updatedAt: new Date(completedAt).toISOString(),
        lastAttemptAt: new Date(startedAt).toISOString(),
        providers: nextProviders,
      };
      return current;
    })().finally(() => {
      refreshPromise = null;
      activeController = null;
    });
    return refreshPromise;
  };

  return {
    async snapshot({ waitForRefresh = false, force = false } = {}) {
      const lastAttempt = Date.parse(current.lastAttemptAt || "") || 0;
      const due = force || !current.updatedAt || now() - lastAttempt >= refreshMs;
      if (due) {
        const pending = refresh();
        if (waitForRefresh) await pending;
      }
      return current;
    },
    refresh,
    stop() {
      activeController?.abort();
    },
  };
}
