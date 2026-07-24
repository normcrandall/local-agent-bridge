const DEFAULT_WRITER_AGENTS = ["claude", "codex", "antigravity"];

export const PROVIDER_FAILURE_CLASSES = Object.freeze({
  INDETERMINATE: "indeterminate",
  TRANSIENT_CAPACITY: "transient_capacity",
  AUTHENTICATION: "authentication",
  PERMISSION: "permission",
  POLICY: "policy",
  CONFIGURATION: "configuration",
  INVALID_REQUEST: "invalid_request",
  QUOTA: "quota",
  TRANSPORT: "transport",
  PROVIDER_FAILURE: "provider_failure",
});

const DISPLAY_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  docker: "Docker Model Runner",
  ollama: "Ollama",
};

function matches(reason, pattern) {
  return pattern.test(String(reason || ""));
}

export function classifyProviderFailure(errorOrReason) {
  const reason = errorOrReason?.message || String(errorOrReason || "Unknown provider failure.");
  if (errorOrReason?.indeterminate) return PROVIDER_FAILURE_CLASSES.INDETERMINATE;

  // Classify deterministic failures before capacity language. Adapter errors such
  // as "model unavailable: --effort is required" must not enter a capacity loop.
  if (matches(reason, /permission denied|operation not permitted|not allowed|allowlist|sandbox|forbidden|(?:^|\D)403(?:\D|$)/i)) {
    return PROVIDER_FAILURE_CLASSES.PERMISSION;
  }
  if (matches(reason, /policy (?:denied|rejected|violation)|blocked by policy|not authorized by policy/i)) {
    return PROVIDER_FAILURE_CLASSES.POLICY;
  }
  if (matches(reason, /unauthorized|authentication|not authenticated|invalid (?:api )?(?:key|token)|expired (?:key|token)|login required|(?:^|\D)401(?:\D|$)/i)) {
    return PROVIDER_FAILURE_CLASSES.AUTHENTICATION;
  }
  if (matches(reason, /quota|rate limit|usage limit|billing|insufficient credits|spend limit|(?:^|\D)429(?:\D|$)/i)) {
    return PROVIDER_FAILURE_CLASSES.QUOTA;
  }
  if (matches(reason, /invalid model selection|(?:requires?|required) --effort|--effort (?:is )?required|failed to load .*config|malformed .*config|unknown (?:argument|option|flag)|unsupported (?:argument|option|flag)|not installed|command not found|ENOENT|no such file/i)) {
    return PROVIDER_FAILURE_CLASSES.CONFIGURATION;
  }
  if (matches(reason, /handoffPath|invalid (?:request|input|argument|schema)|validation error|Zod|unexpected (?:key|field)|must stay inside delegated workspace/i)) {
    return PROVIDER_FAILURE_CLASSES.INVALID_REQUEST;
  }
  if (matches(reason, /\boverload(?:ed)?\b|\bover[_ -]?capacity\b|\bat capacity\b|\bno capacity\b|\bhigh demand\b|\btemporarily unavailable\b|\bmodel\b[^\n]{0,80}\bunavailable\b|(?:^|\D)(?:503|529)(?:\D|$)/i)) {
    return PROVIDER_FAILURE_CLASSES.TRANSIENT_CAPACITY;
  }
  if (matches(reason, /connection closed|connection reset|ECONN|EPIPE|transport|MCP server|exited with|timed? out/i)) {
    return PROVIDER_FAILURE_CLASSES.TRANSPORT;
  }
  return PROVIDER_FAILURE_CLASSES.PROVIDER_FAILURE;
}

export function providerFailureRecord(agent, errorOrReason) {
  const reason = errorOrReason?.message || String(errorOrReason || "Unknown provider failure.");
  return {
    agent,
    failureClass: classifyProviderFailure(errorOrReason),
    reason,
  };
}

export function providerFailuresSummary(unavailableAgents, { prefix = "All requested providers failed" } = {}) {
  const failures = Object.entries(unavailableAgents || {});
  if (!failures.length) return `${prefix}: no provider failure details were recorded.`;
  return `${prefix}: ${failures.map(([agent, value]) => {
    const record = value && typeof value === "object"
      ? { reason: value.reason || "Unknown provider failure.", failureClass: value.failureClass || classifyProviderFailure(value.reason) }
      : { reason: String(value), failureClass: classifyProviderFailure(value) };
    return `${DISPLAY_NAMES[agent] || agent} (${record.failureClass}): ${record.reason}`;
  }).join("; ")}`;
}

export function allProviderFailuresAreTransientCapacity(unavailableAgents) {
  const failures = Object.values(unavailableAgents || {});
  return failures.length > 0 && failures.every((value) => {
    const failureClass = value && typeof value === "object"
      ? value.failureClass || classifyProviderFailure(value.reason)
      : classifyProviderFailure(value);
    return failureClass === PROVIDER_FAILURE_CLASSES.TRANSIENT_CAPACITY;
  });
}

export function normalizeProviderFailoverPolicy(policy) {
  return {
    enabled: policy?.enabled !== false,
    agents: [...new Set(policy?.agents?.length ? policy.agents : DEFAULT_WRITER_AGENTS)],
  };
}

export function resolveProviderFailoverRoster({ agents, mode, issueClaim, providerFailover }) {
  const requested = [...agents];
  const policy = normalizeProviderFailoverPolicy(providerFailover);
  if (mode !== "work" || !issueClaim || !policy.enabled) {
    return { agents: requested, policy };
  }
  return {
    agents: [...new Set([...requested, ...policy.agents])],
    policy,
  };
}
