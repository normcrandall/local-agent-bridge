// Issue #55: coordinator-supplied verificationCommands are an explicit allowlist
// for every provider request path. Any command that would reach a provider grant
// but is not on the coordinator allowlist fails deterministically before dispatch.

export class ProviderCommandNotAllowlistedError extends Error {
  constructor(command, allowlist) {
    super(`Command is not on the coordinator verification allowlist and cannot be dispatched: ${command}`);
    this.name = "ProviderCommandNotAllowlistedError";
    this.code = "provider_command_not_allowlisted";
    this.command = command;
    this.allowlist = allowlist;
  }
}

// Fail-closed provider capability boundary. Only providers whose request path can
// express an *enforceable exact command grant* (Claude: `--allowedTools Bash(cmd)` +
// `--permission-mode dontAsk`) may run a bounded command-running review. Codex (sandbox
// mode only) and Antigravity (no command grant at all) cannot restrict a reviewer to the
// exact allowlist, so they are rejected before dispatch when verification commands are
// present; they remain eligible for static review that carries no verification commands.
export const PROVIDERS_ENFORCING_EXACT_COMMAND_GRANTS = Object.freeze(["claude"]);

export function providerEnforcesExactCommandGrants(provider) {
  return PROVIDERS_ENFORCING_EXACT_COMMAND_GRANTS.includes(provider);
}

export class ProviderCommandGrantUnsupportedError extends Error {
  constructor(provider, commands) {
    super(`Provider ${provider} cannot enforce an exact command grant, so it may not run a bounded command-running review (${commands.length} verification command${commands.length === 1 ? "" : "s"}). It remains eligible for static review with no verification commands.`);
    this.name = "ProviderCommandGrantUnsupportedError";
    this.code = "provider_command_grant_unsupported";
    this.provider = provider;
    this.commands = commands;
  }
}

// Assert, before dispatch, that a provider is allowed to run this request's verification
// commands. Throws for a command-running review on a provider that cannot enforce exact
// grants. Static review (no verification commands) and work mode pass through.
export function assertProviderVerificationCapability({ provider, mode, verificationCommands = [] } = {}) {
  const commands = normalizeVerificationAllowlist(verificationCommands);
  if (mode === "review" && commands.length && !providerEnforcesExactCommandGrants(provider)) {
    throw new ProviderCommandGrantUnsupportedError(provider, commands);
  }
  return commands;
}

// Coordinator commands are single-line, trimmed, non-empty strings. Normalization is
// deterministic (stable order, de-duplicated) so admission is order-independent.
export function normalizeVerificationAllowlist(commands = []) {
  if (!Array.isArray(commands)) {
    throw new Error("Verification allowlist must be an array of command strings.");
  }
  const seen = new Set();
  const normalized = [];
  for (const command of commands) {
    if (typeof command !== "string") {
      throw new Error("Verification allowlist entries must be strings.");
    }
    const trimmed = command.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

// The effective allowlist for a provider request path. Review paths may run only the
// coordinator verification gates; work paths additionally cover the coordinator work
// commands (which the work profile authorizes). Both are coordinator-supplied.
export function effectiveCommandAllowlist({ mode, verificationCommands = [], workCommands = [] } = {}) {
  const verification = normalizeVerificationAllowlist(verificationCommands);
  if (mode === "work") {
    return normalizeVerificationAllowlist([...workCommands, ...verification]);
  }
  return verification;
}

export function isCommandAllowlisted(allowlist, command) {
  if (typeof command !== "string") return false;
  return normalizeVerificationAllowlist(allowlist).includes(command.trim());
}

// Admit one candidate command against the allowlist, or fail deterministically.
export function admitProviderCommand(allowlist, command) {
  const normalizedAllowlist = normalizeVerificationAllowlist(allowlist);
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (!trimmed || !normalizedAllowlist.includes(trimmed)) {
    throw new ProviderCommandNotAllowlistedError(String(command), normalizedAllowlist);
  }
  return trimmed;
}

// Admit every command that is about to become a provider grant. Returns the admitted
// commands in a deterministic order; throws before dispatch on the first unlisted one.
export function admitProviderCommands({ mode, verificationCommands = [], workCommands = [], candidates } = {}) {
  const allowlist = effectiveCommandAllowlist({ mode, verificationCommands, workCommands });
  const requested = candidates === undefined ? allowlist : normalizeVerificationAllowlist(candidates);
  return requested.map((command) => admitProviderCommand(allowlist, command));
}
