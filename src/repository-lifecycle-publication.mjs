export async function publishRepositoryLifecycleCheckpoint({
  checkpoint,
  entry,
  currentMetadata,
  client,
  workspaceRoot,
  refreshClaimLease,
  releaseClaimLease,
} = {}) {
  if (!checkpoint || !entry || !currentMetadata) throw new Error("Checkpoint, outbox entry, and current metadata are required.");
  if (checkpoint.kind !== "release" && !checkpoint.terminal
    && checkpoint.headSha && checkpoint.headSha !== currentMetadata.headSha) {
    return { skipped: "superseded_head", currentHeadSha: currentMetadata.headSha };
  }
  if (checkpoint.kind === "release") {
    return releaseClaimLease({
      client,
      issueNumber: entry.binding.issueNumber,
      collaborationId: checkpoint.collaborationId,
      outcome: checkpoint.phase,
      workspaceRoot,
    });
  }
  return refreshClaimLease({
    client,
    issueNumber: entry.binding.issueNumber,
    collaborationId: checkpoint.collaborationId,
    workspaceRoot,
    phase: checkpoint.phase,
    summary: checkpoint.summary,
    writer: checkpoint.writer,
    writerFailover: checkpoint.previousWriter
      ? { from: checkpoint.previousWriter, to: checkpoint.writer, reason: "provider failover" }
      : null,
    ...currentMetadata,
  });
}

export function repositoryJournalPublicationState(inspection) {
  const pending = inspection?.pending || [];
  const deadLetter = inspection?.deadLetter || [];
  return {
    pendingPublications: pending.length,
    deadLetterPublications: deadLetter.length,
    offline: pending.some((entry) => entry.status === "backoff"),
    attentionRequired: deadLetter.length > 0,
    publicationState: deadLetter.length > 0
      ? "authority_required"
      : pending.length > 0
        ? "offline"
        : "synchronized",
  };
}
