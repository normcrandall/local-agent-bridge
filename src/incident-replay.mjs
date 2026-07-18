import fs from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import readline from "node:readline";
import { collaborationDirectory } from "./collaboration-store.mjs";

export function redactSensitiveData(data) {
  if (typeof data === "string") {
    let result = data;
    result = result.replace(/github_pat_[a-zA-Z0-9_]+/g, "[REDACTED_GITHUB_PAT]");
    result = result.replace(/gh[pousr]_[a-zA-Z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]");
    result = result.replace(/-----BEGIN[A-Z ]+PRIVATE KEY-----\n[\s\S]+?-----END[A-Z ]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
    result = result.replace(/(https?:\/\/)[^/:]+:[^/]+@/g, "$1[REDACTED_CREDENTIALS]@");
    return result;
  }
  if (Array.isArray(data)) {
    return data.map(redactSensitiveData);
  }
  if (data !== null && typeof data === "object") {
    const redacted = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("token") || lowerKey.includes("key") || lowerKey.includes("password") || lowerKey.includes("secret") || lowerKey.includes("pat")) {
        redacted[key] = "[REDACTED]";
      } else {
        redacted[key] = redactSensitiveData(value);
      }
    }
    return redacted;
  }
  return data;
}

export async function locateCollaborationFiles(root, id) {
  const dir = collaborationDirectory(root);
  const activeState = resolve(dir, `${id}.json`);
  const activeTranscript = resolve(dir, `${id}.jsonl`);
  const archivedState = resolve(dir, "archive", `${id}.json`);
  const archivedTranscript = resolve(dir, "archive", `${id}.jsonl`);

  try {
    await stat(activeTranscript);
    return { statePath: activeState, transcriptPath: activeTranscript, archived: false };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  try {
    await stat(archivedTranscript);
    return { statePath: archivedState, transcriptPath: archivedTranscript, archived: true };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  throw new Error(`Collaboration files not found for ID: ${id}`);
}

async function readStateSafely(path) {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function parseTranscriptIncremental(path) {
  const events = [];
  try {
    const fileStream = fs.createReadStream(path);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber++;
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        event._line = lineNumber;
        event._source = `transcript.jsonl:${lineNumber}`;
        events.push(event);
      } catch (err) {
        events.push({
          type: "malformed_event",
          _line: lineNumber,
          _source: `transcript.jsonl:${lineNumber}`,
          raw: line,
          error: err.message
        });
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return events;
}

async function parseBuilderReceiptsIncremental(workspace, state) {
  const receipts = [];
  const receiptPath = resolve(workspace, ".bridge", "github-builder-receipts.jsonl");
  try {
    await stat(receiptPath);
  } catch {
    return [];
  }

  try {
    const fileStream = fs.createReadStream(receiptPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber++;
      if (!line.trim()) continue;
      try {
        const receipt = JSON.parse(line);
        receipt._line = lineNumber;
        receipt._source = `github-builder-receipts.jsonl:${lineNumber}`;

        const matchesRepo = (receipt.repository && (
          receipt.repository === state?.issueClaim?.repository ||
          receipt.repository === state?.githubReview?.repository ||
          receipt.repository === state?.githubBuilder?.repository
        ));
        const matchesContext = (
          (state?.issueClaim?.issueNumber && receipt.issueNumber === state.issueClaim.issueNumber) ||
          (state?.githubBuilder?.ref && receipt.ref === state.githubBuilder.ref) ||
          (state?.githubReview?.headSha && (receipt.requestedSha === state.githubReview.headSha || receipt.sha === state.githubReview.headSha)) ||
          (state?.githubBuilder?.headSha && (receipt.requestedSha === state.githubBuilder.headSha || receipt.sha === state.githubBuilder.headSha))
        );
        if (matchesRepo && matchesContext) {
          receipts.push(receipt);
        }
      } catch (err) {
        // Safe to ignore malformed entries in builder receipts
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return receipts;
}

function getEventTimestamp(event) {
  const at = event.at || event.recordedAt || event.createdAt || event.timestamp;
  if (!at) return 0;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeAndSortEvents(transcriptEvents, builderReceipts) {
  const mappedReceipts = builderReceipts.map(r => ({
    ...r,
    type: "github_receipt",
    at: r.recordedAt
  }));

  const all = [...transcriptEvents, ...mappedReceipts];
  all.sort((a, b) => {
    const timeA = getEventTimestamp(a);
    const timeB = getEventTimestamp(b);
    if (timeA !== timeB) return timeA - timeB;

    const matchA = a._source?.match(/^([^:]+):(\d+)$/);
    const matchB = b._source?.match(/^([^:]+):(\d+)$/);
    if (matchA && matchB) {
      const fileA = matchA[1];
      const lineA = parseInt(matchA[2], 10);
      const fileB = matchB[1];
      const lineB = parseInt(matchB[2], 10);
      if (fileA !== fileB) {
        return fileA.localeCompare(fileB);
      }
      return lineA - lineB;
    }
    return String(a._source || "").localeCompare(String(b._source || ""));
  });
  return all;
}

export async function replayIncident(root, id) {
  const { statePath, transcriptPath, archived } = await locateCollaborationFiles(root, id);
  const state = await readStateSafely(statePath);
  const rawTranscriptEvents = await parseTranscriptIncremental(transcriptPath);

  let builderReceipts = [];
  if (state?.workspace) {
    builderReceipts = await parseBuilderReceiptsIncremental(state.workspace, state);
  }

  const timeline = redactSensitiveData(mergeAndSortEvents(rawTranscriptEvents, builderReceipts));
  const redactedState = redactSensitiveData(state);

  const observedFacts = [];
  const contributingFactors = [];
  const unprovenHypotheses = [];
  const remediationSteps = [];

  let classification = "unknown";
  let lastConfirmedState = redactedState?.status || "unknown";
  let unresolvedOwnership = "unknown";
  let nextSafeAction = "none";

  const hasMalformed = timeline.some(e => e.type === "malformed_event");
  const hasFinished = timeline.some(e => e.type === "run_finished");
  const hasFailed = timeline.some(e => e.type === "run_failed");
  const hasStarted = timeline.some(e => e.type === "run_started");
  const workerExitWithoutReceipt = timeline.find(e => e.type === "worker_exit" && e.terminalReceipt === false);
  const reconciledMissingWorker = timeline.find(e => e.type === "cleanup_reconciled" && e.action === "mark-indeterminate");
  const hasWorkerDisappearance = Boolean(workerExitWithoutReceipt || reconciledMissingWorker);
  const hasIndeterminate = timeline.some(e => e.type === "agent_indeterminate" || e.type === "recovery_marked_indeterminate") || redactedState?.status === "indeterminate";
  const hasPermissionErr = timeline.some(e => {
    const msg = String(e.error || e.reason || e.message || "").toLowerCase();
    return msg.includes("eperm") ||
           msg.includes("permission denied") ||
           msg.includes("eacces") ||
           msg.includes("unauthorized") ||
           /(?:invalid|expired|missing|bad|denied|error).*token|token.*(?:invalid|expired|missing|bad|denied|error)/i.test(msg);
  });
  const hasOverload = timeline.some(e => e.type === "provider_recovery_scheduled" || String(e.error || e.reason || "").toLowerCase().includes("high demand") || String(e.error || e.reason || "").toLowerCase().includes("rate limit"));
  const hasWakeQueued = timeline.some(e => e.type === "coordinator_wake_queued");
  const hasWakeAck = timeline.some(e => e.type === "coordinator_wake_acknowledged");

  if (redactedState) {
    observedFacts.push({
      description: `State status is '${redactedState.status}' updated at ${redactedState.updatedAt}`,
      source: "state.json"
    });
  }
  if (hasStarted) {
    const startEvent = timeline.find(e => e.type === "run_started");
    observedFacts.push({
      description: `Worker run started at ${startEvent.at} with PID ${startEvent.pid}`,
      source: startEvent._source
    });
  }
  if (hasFinished) {
    const finEvent = timeline.find(e => e.type === "run_finished");
    observedFacts.push({
      description: `Worker run finished at ${finEvent.at} with reason '${finEvent.reason}'`,
      source: finEvent._source
    });
  }
  if (hasFailed) {
    const failEvent = timeline.find(e => e.type === "run_failed");
    observedFacts.push({
      description: `Worker run failed at ${failEvent.at} with error '${failEvent.error}'`,
      source: failEvent._source
    });
  }
  if (workerExitWithoutReceipt) {
    observedFacts.push({
      description: `Worker PID ${workerExitWithoutReceipt.pid} exited without a terminal receipt${workerExitWithoutReceipt.signal ? ` after signal ${workerExitWithoutReceipt.signal}` : ""}`,
      source: workerExitWithoutReceipt._source
    });
  } else if (reconciledMissingWorker) {
    observedFacts.push({
      description: "Reconciliation found that the recorded worker no longer existed before a terminal receipt was written",
      source: reconciledMissingWorker._source
    });
  }
  if (hasPermissionErr) {
    const permEvent = timeline.find(e => {
      const msg = String(e.error || e.reason || e.message || "").toLowerCase();
      return msg.includes("eperm") ||
             msg.includes("permission denied") ||
             msg.includes("eacces") ||
             msg.includes("unauthorized") ||
             /(?:invalid|expired|missing|bad|denied|error).*token|token.*(?:invalid|expired|missing|bad|denied|error)/i.test(msg);
    });
    observedFacts.push({
      description: `Permission or configuration failure observed: '${permEvent.error || permEvent.reason || permEvent.message}'`,
      source: permEvent._source
    });
  }

  if (hasMalformed) {
    classification = "truncated_history";
    lastConfirmedState = "running";
    unresolvedOwnership = "system";
    nextSafeAction = "inspect_recovery";
    contributingFactors.push("History ends abruptly or contains malformed JSONLines at the end.");
    remediationSteps.push("Check log file integrity, inspect local workspace lock status, and run bridge recover to clear any stale worker locks.");
  } else if (hasWorkerDisappearance) {
    classification = "worker_disappeared";
    lastConfirmedState = "indeterminate";
    unresolvedOwnership = "system";
    nextSafeAction = "inspect_recovery";
    contributingFactors.push("The worker process disappeared before recording a terminal outcome; a later cancellation does not erase that original incident.");
    remediationSteps.push("Inspect the workspace and provider state before replacement work. Verify the machine supervisor and the durable worker-exit receipt, then recover or cancel the preserved owner explicitly.");
  } else if (hasIndeterminate) {
    classification = "indeterminate_mutation";
    lastConfirmedState = "indeterminate";
    unresolvedOwnership = "ambiguous";
    nextSafeAction = "inspect_recovery";
    contributingFactors.push("Worker lost connection to the provider or state was explicitly marked indeterminate.");
    remediationSteps.push("Inspect the workspace and provider state manually. Use bridge recover <id> to check ownership, and do not start replacement work.");
  } else if (hasPermissionErr) {
    classification = "permission_denial";
    lastConfirmedState = "failed";
    unresolvedOwnership = "user";
    nextSafeAction = "doctor";
    contributingFactors.push("Command failed due to EPERM or directory read/write restrictions.");
    remediationSteps.push("Verify that the correct GitHub App permissions are configured, check directory read/write access, and run bridge doctor.");
  } else if (hasOverload) {
    classification = "overload_fallback";
    lastConfirmedState = "recovering";
    unresolvedOwnership = "provider";
    nextSafeAction = "requeue";
    contributingFactors.push("High demand or rate limit occurred at the provider level, prompting fallback retry loops.");
    remediationSteps.push("Ensure model fallback chains are correct, wait for capacity to recover, and requeue the collaboration.");
  } else if (redactedState?.status === "agreed" || redactedState?.status === "completed" || (hasFinished && timeline.find(e => e.type === "run_finished")?.reason === "completed")) {
    if (hasWakeQueued && !hasWakeAck) {
      classification = "lost_completion_wake";
      lastConfirmedState = "completed";
      unresolvedOwnership = "chair";
      nextSafeAction = "acknowledge_wake";
      contributingFactors.push("The work completed but the completion wake was not acknowledged by the chair.");
      remediationSteps.push("Call acknowledge_coordinator_wake to process the wake and progress the lane.");
    } else {
      classification = "clean_completion";
      lastConfirmedState = "completed";
      unresolvedOwnership = "none";
      nextSafeAction = "none";
      contributingFactors.push("All execution steps completed cleanly.");
      remediationSteps.push("None required; the task is successfully completed.");
    }
  } else if (["failed", "cancelled"].includes(redactedState?.status)) {
    const isCleanedUp = redactedState?.cleanup?.workerLeaseReleased && redactedState?.cleanup?.workspaceLeaseReleased;
    if (!isCleanedUp) {
      classification = "orphan_cleanup";
      lastConfirmedState = "failed";
      unresolvedOwnership = "system";
      nextSafeAction = "recover_cancel";
      contributingFactors.push("Collaboration terminated in a failed or cancelled state, but locks were not released or cleanup was incomplete.");
      remediationSteps.push("Run bridge recover <id> --cancel to explicitly terminate any remaining processes and release file locks.");
    } else {
      classification = "failed_or_cancelled";
      lastConfirmedState = redactedState.status;
      unresolvedOwnership = "none";
      nextSafeAction = "none";
      contributingFactors.push("Collaboration terminated with a known failure or cancellation without lock leaks.");
    }
  } else if (redactedState?.status === "running" && redactedState?.runtime?.activeCall?.summarySource === "broker") {
    classification = "stale_narrative";
    lastConfirmedState = "running";
    unresolvedOwnership = "provider";
    nextSafeAction = "monitor";
    contributingFactors.push("Active call summary is a generic broker placeholder, indicating the provider has not updated its narrative.");
    remediationSteps.push("Monitor the progress via get_collaboration or status; check the provider process logs for activity.");
  }

  const issueDraft = {
    title: `[Incident Replay] Collaboration ${id} - ${classification.toUpperCase()}`,
    body: `Incident replay report for collaboration \`${id}\`.

- **Classification**: ${classification}
- **Last Confirmed State**: ${lastConfirmedState}
- **Unresolved Ownership**: ${unresolvedOwnership}
- **Next Safe Action**: ${nextSafeAction}

### Observed Facts:
${observedFacts.map(f => `- ${f.description} (Source: \`${f.source}\`)`).join("\n")}

### Remediation Steps:
${remediationSteps.map(s => `- ${s}`).join("\n")}
`
  };

  return {
    collaborationId: id,
    archived,
    classification,
    observed: {
      status: redactedState?.status || "unknown",
      hasTurns: timeline.some(e => e.type === "turn"),
      lastEvent: timeline.length ? {
        type: timeline[timeline.length - 1].type,
        at: timeline[timeline.length - 1].at || timeline[timeline.length - 1].recordedAt || null,
        source: timeline[timeline.length - 1]._source
      } : null,
      facts: observedFacts
    },
    inferred: {
      contributingFactors,
      unprovenHypotheses
    },
    remediation: {
      lastConfirmedState,
      unresolvedOwnership,
      nextSafeAction,
      steps: remediationSteps,
      issueDraft
    },
    state: redactedState,
    timeline
  };
}

export function formatReplayHuman(report) {
  const lines = [];
  lines.push(`================================================================================`);
  lines.push(`Incident Replay: Collaboration ${report.collaborationId}`);
  lines.push(`Classification:  ${report.classification.toUpperCase()}`);
  lines.push(`Archived:        ${report.archived}`);
  lines.push(`================================================================================`);
  lines.push("");
  lines.push("Observed Facts:");
  for (const fact of report.observed.facts) {
    lines.push(`- [CITED] ${fact.description}`);
    lines.push(`  (Stable Ref: ${fact.source})`);
  }
  lines.push("");
  lines.push("Inferred Contributing Factors & Hypotheses:");
  if (report.inferred.contributingFactors.length) {
    for (const factor of report.inferred.contributingFactors) {
      lines.push(`- ${factor}`);
    }
  } else {
    lines.push("- None identified.");
  }
  lines.push("");
  lines.push("Remediation & Next Steps:");
  lines.push(`- Last Confirmed State: ${report.remediation.lastConfirmedState}`);
  lines.push(`- Unresolved Ownership: ${report.remediation.unresolvedOwnership}`);
  lines.push(`- Next Safe Action:     ${report.remediation.nextSafeAction}`);
  lines.push("");
  lines.push("Recommended Actions:");
  for (const step of report.remediation.steps) {
    lines.push(`- ${step}`);
  }
  lines.push("");
  lines.push("Remediation Issue Draft:");
  lines.push(`Title: ${report.remediation.issueDraft.title}`);
  lines.push(`Body:\n${report.remediation.issueDraft.body}`);
  lines.push("--------------------------------------------------------------------------------");
  return lines.join("\n");
}
