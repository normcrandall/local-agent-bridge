// Issue #55: the live narrative must carry (a) an explicit capacity-wait reason and
// (b) the active verification command when a provider is running one. These pure
// builders keep the worker's activeCall assembly deterministic and testable.

import { normalizeVerificationAllowlist } from "./verification-allowlist.mjs";

// Explicit reason for a capacity wait, including which slots are occupied and why the
// call is queued rather than dispatched.
export function capacityWaitNarrative({ agent, role, limit, inUse, position } = {}) {
  const occupied = `${inUse}/${limit} ${agent} ${role} slot${limit === 1 ? "" : "s"} in use`;
  const reason = position > 1
    ? `all ${limit} ${agent} ${role} capacity slot${limit === 1 ? "" : "s"} are occupied; queued at position ${position}`
    : `all ${limit} ${agent} ${role} capacity slot${limit === 1 ? "" : "s"} are occupied; next to acquire`;
  return {
    summary: `Waiting for ${agent} ${role} capacity (${occupied}; ${reason}).`,
    reason,
    capacity: { role, limit, inUse, position },
  };
}

// Detect which coordinator verification command a provider progress line is running,
// so the narrative can name the active command. Matches when the progress summary
// mentions an allowlisted command verbatim (longest match wins to avoid a prefix
// command shadowing a more specific one).
export function activeVerificationCommand(progressSummary, verificationCommands = []) {
  if (typeof progressSummary !== "string" || !progressSummary) return null;
  const allowlist = normalizeVerificationAllowlist(verificationCommands)
    .slice()
    .sort((a, b) => b.length - a.length);
  for (const command of allowlist) {
    if (progressSummary.includes(command)) return command;
  }
  return null;
}

// Fold the active verification command into a running-provider summary. When a command
// is active the narrative names it explicitly; otherwise the provider summary passes
// through unchanged.
export function verificationNarrative({ agent, providerSummary, command } = {}) {
  if (!command) {
    return { summary: providerSummary, verificationCommand: null };
  }
  return {
    summary: `${agent} is running verification command \`${command}\`: ${providerSummary}`,
    verificationCommand: command,
  };
}
