export async function resolveVerificationPlan({ store, repositoryEvidence, commands = [], cwd = "." } = {}) {
  const normalized = [...new Set(commands.map((command) => String(command).trim()).filter(Boolean))];
  if (!store || !repositoryEvidence?.clean) {
    return { reusable: [], pendingCommands: normalized, avoidedCommands: 0, estimatedAvoidedMs: 0 };
  }
  const reusable = [];
  const pendingCommands = [];
  for (const command of normalized) {
    const receipt = await store.findReusableVerification({
      repository: repositoryEvidence.repository,
      headSha: repositoryEvidence.headSha,
      command,
      cwd,
      environmentFingerprint: repositoryEvidence.environmentFingerprint,
    });
    if (receipt) reusable.push(receipt);
    else pendingCommands.push(command);
  }
  const estimatedAvoidedMs = reusable.reduce((total, receipt) => {
    const started = Date.parse(receipt.startedAt);
    const completed = Date.parse(receipt.completedAt);
    return total + (Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : 0);
  }, 0);
  return { reusable, pendingCommands, avoidedCommands: reusable.length, estimatedAvoidedMs };
}

export async function persistObservedVerificationResults({
  store,
  repositoryEvidence,
  results = [],
  authorizedCommands = [],
  provider,
  cwd = ".",
} = {}) {
  if (!store) throw new Error("Observed verification persistence requires an EvidenceStore.");
  const authorized = new Set(authorizedCommands.map((command) => String(command).trim()).filter(Boolean));
  if (!repositoryEvidence?.clean) {
    return { recorded: [], skipped: results.map((result) => ({ command: result?.command || null, reason: "workspace_not_clean" })) };
  }
  const recorded = [];
  const skipped = [];
  for (const result of results) {
    const command = String(result?.command || "").trim();
    let reason = null;
    if (!authorized.has(command)) reason = "command_not_authorized";
    else if (result?.exitCode !== 0) reason = "command_failed";
    else if (!/^[0-9a-f]{64}$/i.test(result?.outputDigest || "")) reason = "invalid_output_digest";
    if (reason) {
      skipped.push({ command: command || null, reason });
      continue;
    }
    const stored = await store.recordVerificationReceipt({
      repository: repositoryEvidence.repository,
      headSha: repositoryEvidence.headSha,
      command,
      cwd,
      environmentFingerprint: repositoryEvidence.environmentFingerprint,
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      source: provider || "provider",
      provider: provider || null,
      attestation: "observed",
      outputDigest: result.outputDigest,
      outputSummary: result.outputSummary || null,
    });
    recorded.push(stored.value);
  }
  return { recorded, skipped };
}

export function formatReusableVerification(receipts = []) {
  if (!receipts.length) return "";
  return [
    "Broker-attested verification receipts reused at this exact clean head (do not rerun unless you distrust a receipt or need fresh evidence):",
    ...receipts.map((receipt) => `- ${receipt.command}: exit ${receipt.exitCode}, ${receipt.source}/${receipt.attestation}, completed ${receipt.completedAt}, output ${receipt.outputDigest || "not recorded"}`),
    "Claude retains permission to rerun a listed gate after explicitly rejecting its receipt; other providers must request fresh verification when their capability boundary cannot run it.",
  ].join("\n");
}
