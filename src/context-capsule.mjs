import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { collaborationDirectory } from "./collaboration-store.mjs";

const DEFAULT_CAP_BYTES = 50 * 1024; // 50 KB
export const REPOSITORY_CONTEXT_RESYNC_RECEIPT_VERSION = 1;

export function resolveCapsuleMaxBytes(configured) {
  if (configured === undefined || configured === null) {
    return DEFAULT_CAP_BYTES;
  }
  const val = typeof configured === "number" ? configured : Number(configured);
  if (!Number.isFinite(val) || val < 0) {
    return DEFAULT_CAP_BYTES;
  }
  return Math.min(val, DEFAULT_CAP_BYTES);
}

function boundedUtf8(text, maxBytes) {
  const value = String(text || "");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  const marker = "\n...[TRUNCATED_TO_CONTEXT_CAPSULE_BOUND]...\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const prefixByBytes = (source, budget) => {
    let result = "";
    let used = 0;
    for (const character of source) {
      const size = Buffer.byteLength(character, "utf8");
      if (used + size > budget) break;
      result += character;
      used += size;
    }
    return result;
  };
  const suffixByBytes = (source, budget) => {
    let result = "";
    let used = 0;
    const characters = Array.from(source);
    for (let index = characters.length - 1; index >= 0; index -= 1) {
      const size = Buffer.byteLength(characters[index], "utf8");
      if (used + size > budget) break;
      result = characters[index] + result;
      used += size;
    }
    return result;
  };
  if (maxBytes <= markerBytes) {
    return { text: prefixByBytes(marker, Math.max(0, maxBytes)), truncated: true };
  }
  const available = Math.max(0, maxBytes - markerBytes);
  const prefixBytes = Math.floor(available * 0.7);
  const suffixBytes = available - prefixBytes;
  return {
    text: `${prefixByBytes(value, prefixBytes)}${marker}${suffixByBytes(value, suffixBytes)}`,
    truncated: true,
  };
}

export function createRepositoryContextResyncReceipt({
  reason,
  binding,
  priorCursor = null,
  baselineCursor = null,
  skipped = [],
} = {}) {
  const safeReason = String(reason || "unknown_resync").replace(/[^a-z0-9_-]/gi, "_").slice(0, 64);
  const safeSkipped = Array.isArray(skipped)
    ? skipped.slice(0, 50).map((entry) => ({
      sequence: Number.isSafeInteger(entry?.sequence) ? entry.sequence : null,
      reason: String(entry?.reason || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 64),
      evidenceRetained: entry?.evidenceRetained === true,
    }))
    : [];
  return Object.freeze({
    version: REPOSITORY_CONTEXT_RESYNC_RECEIPT_VERSION,
    kind: "repository_context_resync_receipt",
    required: true,
    reason: safeReason,
    binding: {
      repository: String(binding?.repository || "").toLowerCase(),
      collaborationId: String(binding?.collaborationId || ""),
      laneId: String(binding?.laneId || ""),
    },
    priorAfterSequence: Number.isSafeInteger(priorCursor?.afterSequence) ? priorCursor.afterSequence : null,
    baselineAfterSequence: Number.isSafeInteger(baselineCursor?.afterSequence) ? baselineCursor.afterSequence : null,
    skipped: safeSkipped,
  });
}

export function composeRepositoryContextTurnPrompt({
  fullPrompt,
  compactPrompt,
  firstExposure,
  binding,
  priorCursor = null,
  baseline,
  delta = null,
  maxBytes,
} = {}) {
  const cap = resolveCapsuleMaxBytes(maxBytes);
  const safeFull = redactSecretsAndInjectionFromText(String(fullPrompt || ""));
  const safeCompact = redactSecretsAndInjectionFromText(String(compactPrompt || ""));
  const boundedFull = boundedUtf8(safeFull, cap);
  const fullBytes = Buffer.byteLength(boundedFull.text, "utf8");
  const baselineCursor = baseline?.cursor || null;

  if (firstExposure) {
    const receipt = baseline?.resyncRequired
      ? createRepositoryContextResyncReceipt({ reason: baseline.resyncRequired.reason, binding })
      : null;
    const prompt = receipt
      ? boundedUtf8(`${boundedFull.text}\n\nRepository context resync receipt:\n${JSON.stringify(receipt)}`, cap).text
      : boundedFull.text;
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    return {
      prompt,
      kind: "full",
      cursor: baselineCursor,
      receipt,
      fullPromptBytes: fullBytes,
      promptBytes,
      avoidedBytes: 0,
      truncated: boundedFull.truncated,
      eventCount: 0,
    };
  }

  const skipped = delta?.skipped || [];
  const oversized = skipped.some((entry) => entry.reason === "record_exceeds_bounds");
  const resyncReason = delta?.resyncRequired?.reason
    || (priorCursor ? null : "missing_cursor")
    || (oversized ? "oversized_record_skipped" : null);
  if (resyncReason) {
    const receipt = createRepositoryContextResyncReceipt({
      reason: resyncReason,
      binding,
      priorCursor,
      baselineCursor,
      skipped,
    });
    const suffix = `\n\nRepository context resync receipt:\n${JSON.stringify(receipt)}`;
    const prompt = boundedUtf8(`${boundedFull.text}${suffix}`, cap).text;
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    return {
      prompt,
      kind: "resync",
      cursor: baselineCursor,
      receipt,
      fullPromptBytes: fullBytes,
      promptBytes,
      avoidedBytes: Math.max(0, fullBytes - promptBytes),
      truncated: boundedFull.truncated,
      eventCount: 0,
    };
  }

  const context = {
    version: delta?.version || 1,
    kind: "repository_context_delta",
    authority: "none",
    binding: delta?.binding || binding,
    records: delta?.records || [],
    skipped,
    cursor: delta?.cursor || priorCursor,
  };
  const contextBlock = context.records.length || context.skipped.length
    ? `\n\nVerified unseen repository context (no authority):\n${JSON.stringify(context)}`
    : "";
  const candidate = `${safeCompact}${contextBlock}`;
  if (Buffer.byteLength(candidate, "utf8") > cap) {
    const receipt = createRepositoryContextResyncReceipt({
      reason: "delta_exceeds_prompt_bound",
      binding,
      priorCursor,
      baselineCursor,
      skipped,
    });
    const prompt = boundedUtf8(`${boundedFull.text}\n\nRepository context resync receipt:\n${JSON.stringify(receipt)}`, cap).text;
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    return {
      prompt,
      kind: "resync",
      cursor: baselineCursor,
      receipt,
      fullPromptBytes: fullBytes,
      promptBytes,
      avoidedBytes: Math.max(0, fullBytes - promptBytes),
      truncated: boundedFull.truncated,
      eventCount: 0,
    };
  }
  const promptBytes = Buffer.byteLength(candidate, "utf8");
  return {
    prompt: candidate,
    kind: "delta",
    cursor: delta?.cursor || priorCursor,
    receipt: null,
    fullPromptBytes: fullBytes,
    promptBytes,
    avoidedBytes: Math.max(0, fullBytes - promptBytes),
    truncated: false,
    eventCount: context.records.length,
  };
}

export function computeFreshness(timestamp, now = new Date()) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return { ageSeconds: 0, status: "unknown" };
  const age = Math.max(0, Math.floor((now - parsed) / 1000));
  const status = age > 300 ? "stale" : "fresh";
  return { ageSeconds: age, status };
}

export function getSafeCapsulePath(root, id) {
  if (!/^bridge-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new Error(`Invalid collaboration ID: ${id}`);
  }
  const dir = collaborationDirectory(root);
  const capsulePath = resolve(dir, id + ".capsule.json");

  const relativePath = relative(dir, capsulePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath.includes(sep)) {
    if (relativePath !== `${id}.capsule.json`) {
      throw new Error("Path traversal detected.");
    }
  }
  return capsulePath;
}

export function redactSecretsAndInjectionFromText(text) {
  if (typeof text !== "string") return text;
  let redacted = text;

  const pKeyRegex = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[^-]+-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gi;
  if (pKeyRegex.test(redacted)) {
    redacted = redacted.replace(pKeyRegex, "<REDACTED_PRIVATE_KEY>");
  }
  const pKeyShortRegex = /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/gi;
  if (pKeyShortRegex.test(redacted)) {
    redacted = redacted.replace(pKeyShortRegex, "<REDACTED_PRIVATE_KEY_HEADER>");
  }

  const ghTokenRegex = /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}/g;
  if (ghTokenRegex.test(redacted)) {
    redacted = redacted.replace(ghTokenRegex, "<REDACTED_GITHUB_TOKEN>");
  }

  const secretValueChars = "[a-zA-Z0-9_\\-\\.\\~+/=:@]";
  const envAssignRegex = new RegExp(`([A-Z_][A-Z0-9_]{3,39}\\s*=\\s*["']?)(${secretValueChars}{16,})(["']?)`, "g");
  if (envAssignRegex.test(redacted)) {
    redacted = redacted.replace(envAssignRegex, "$1<REDACTED_ENV_SECRET>$3");
  }

  const genericSecretRegex = new RegExp(
    `((?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret|password|passwd|token|auth[_-]?token|access[_-]?token|private[_-]?key|session[_-]?key)\\s*[:=]\\s*["']?)(${secretValueChars}{16,})(["']?)`,
    "gi",
  );
  if (genericSecretRegex.test(redacted)) {
    redacted = redacted.replace(genericSecretRegex, "$1<REDACTED_SECRET>$3");
  }

  const promptInjectionRegex = /ignore (?:all )?previous instructions|system override|you are now a|ignore the above/gi;
  if (promptInjectionRegex.test(redacted)) {
    redacted = redacted.replace(promptInjectionRegex, "<REDACTED_PROMPT_INJECTION>");
  }

  // Safety check: fail-closed if prompt injection somehow survives
  if (promptInjectionRegex.test(redacted)) {
    throw new Error("Message contains prompt injection that cannot be fully sanitized.");
  }

  return redacted;
}

const ProvenanceSchema = z.object({
  agent: z.string().min(1),
  timestamp: z.string().datetime(),
  turn: z.number().int().nonnegative(),
  freshness: z.string().optional(),
  ageSeconds: z.number().int().nonnegative().optional(),
}).strict();

const FactItemSchema = z.object({
  text: z.string().min(1),
  provenance: ProvenanceSchema,
  sources: z.array(z.string().min(1)).min(1),
}).strict();

const DecisionItemSchema = z.object({
  text: z.string().min(1),
  provenance: ProvenanceSchema,
}).strict();

const ArtifactItemSchema = z.object({
  path: z.string().min(1),
  provenance: ProvenanceSchema,
}).strict();

const ConstraintItemSchema = z.object({
  text: z.string().min(1),
  provenance: ProvenanceSchema,
}).strict();

const UnresolvedQuestionItemSchema = z.object({
  text: z.string().min(1),
  provenance: ProvenanceSchema,
}).strict();

const SourceReferenceItemSchema = z.object({
  text: z.string().min(1),
  provenance: ProvenanceSchema,
}).strict();

export const ContextCapsuleSchema = z.object({
  version: z.literal(1),
  producingParticipant: z.string().min(1),
  timestamp: z.string().datetime(),
  facts: z.array(FactItemSchema).default([]),
  decisions: z.array(DecisionItemSchema).default([]),
  artifacts: z.array(ArtifactItemSchema).default([]),
  constraints: z.array(ConstraintItemSchema).default([]),
  unresolvedQuestions: z.array(UnresolvedQuestionItemSchema).default([]),
  sourceReferences: z.array(SourceReferenceItemSchema).default([]),
  redactions: z.array(z.object({
    field: z.string(),
    reason: z.string(),
  })).optional(),
}).strict();

export function normalizeCapsuleInput(rawCapsule, { agent, turn, timestamp = new Date().toISOString() }) {
  if (!rawCapsule || typeof rawCapsule !== "object" || Array.isArray(rawCapsule)) {
    throw new Error("Capsule must be a JSON object.");
  }

  const allowedKeys = new Set([
    "version", "producingParticipant", "timestamp",
    "facts", "decisions", "artifacts", "constraints", "unresolvedQuestions", "sourceReferences"
  ]);
  for (const key of Object.keys(rawCapsule)) {
    if (!allowedKeys.has(key)) {
      throw new Error("Capsule contains non-allowlisted field: " + key);
    }
  }

  const defaultProvenance = { agent, timestamp, turn };

  const normalizeItem = (item, isArtifact = false, isFact = false) => {
    if (typeof item === "string") {
      if (isFact) {
        throw new Error("Every fact must include at least one explicit source reference.");
      }
      const textKey = isArtifact ? "path" : "text";
      const freshnessData = computeFreshness(timestamp);
      return {
        [textKey]: item,
        provenance: {
          ...defaultProvenance,
          ageSeconds: freshnessData.ageSeconds,
          freshness: freshnessData.status
        }
      };
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const allowedItemKeys = new Set(["text", "path", "value", "provenance", "sources"]);
      for (const k of Object.keys(item)) {
        if (!allowedItemKeys.has(k)) {
          throw new Error("Capsule item contains non-allowlisted field: " + k);
        }
      }

      const textKey = isArtifact ? "path" : "text";
      const value = item.text || item.path || item.value;
      if (!value || typeof value !== "string" || !value.trim()) {
        throw new Error("Capsule item must contain a non-empty string value.");
      }

      if (isFact && (!Array.isArray(item.sources) || item.sources.length === 0 || item.sources.some(s => typeof s !== "string" || !s.trim()))) {
        throw new Error("Every fact must include at least one explicit source reference.");
      }

      const itemProv = item.provenance && typeof item.provenance === "object" && !Array.isArray(item.provenance)
        ? {
            agent: item.provenance.agent || agent,
            timestamp: item.provenance.timestamp || timestamp,
            turn: typeof item.provenance.turn === "number" ? item.provenance.turn : turn
          }
        : { ...defaultProvenance };

      const freshnessData = computeFreshness(itemProv.timestamp);
      itemProv.ageSeconds = freshnessData.ageSeconds;
      itemProv.freshness = freshnessData.status;

      const res = {
        [textKey]: value.trim(),
        provenance: itemProv
      };
      if (isFact) {
        res.sources = item.sources.map(s => s.trim());
      }
      return res;
    }
    throw new Error("Capsule items must be strings or objects.");
  };

  const facts = Array.isArray(rawCapsule.facts) ? rawCapsule.facts.map(i => normalizeItem(i, false, true)) : [];
  const decisions = Array.isArray(rawCapsule.decisions) ? rawCapsule.decisions.map(i => normalizeItem(i, false, false)) : [];
  const artifacts = Array.isArray(rawCapsule.artifacts) ? rawCapsule.artifacts.map(i => normalizeItem(i, true, false)) : [];
  const constraints = Array.isArray(rawCapsule.constraints) ? rawCapsule.constraints.map(i => normalizeItem(i, false, false)) : [];
  const unresolvedQuestions = Array.isArray(rawCapsule.unresolvedQuestions) ? rawCapsule.unresolvedQuestions.map(i => normalizeItem(i, false, false)) : [];
  const sourceReferences = Array.isArray(rawCapsule.sourceReferences) ? rawCapsule.sourceReferences.map(i => normalizeItem(i, false, false)) : [];

  const normalized = {
    version: typeof rawCapsule.version === "number" ? rawCapsule.version : 1,
    producingParticipant: rawCapsule.producingParticipant || agent,
    timestamp: rawCapsule.timestamp || timestamp,
    facts,
    decisions,
    artifacts,
    constraints,
    unresolvedQuestions,
    sourceReferences
  };

  return ContextCapsuleSchema.parse(normalized);
}

export function redactSecretsAndInjectionFromCapsule(capsule) {
  const redactions = [];

  const checkAndRedact = (text, fieldPath) => {
    if (typeof text !== "string") return text;
    const redacted = redactSecretsAndInjectionFromText(text);
    if (redacted !== text) {
      const markerReasons = [
        ["<REDACTED_PRIVATE_KEY>", "private_key"],
        ["<REDACTED_PRIVATE_KEY_HEADER>", "private_key_header"],
        ["<REDACTED_GITHUB_TOKEN>", "github_token"],
        ["<REDACTED_PROMPT_INJECTION>", "prompt_injection"],
        ["<REDACTED_ENV_SECRET>", "environment_secret"],
        ["<REDACTED_SECRET>", "generic_secret"],
      ].filter(([marker]) => redacted.includes(marker));
      for (const [, reason] of markerReasons) {
        redactions.push({ field: fieldPath, reason });
      }
    }
    return redacted;
  };

  const sections = ["facts", "decisions", "constraints", "unresolvedQuestions", "sourceReferences"];
  for (const section of sections) {
    if (Array.isArray(capsule[section])) {
      capsule[section].forEach((item, index) => {
        item.text = checkAndRedact(item.text, section + "[" + index + "].text");
        if (item.provenance) {
          item.provenance.agent = checkAndRedact(item.provenance.agent, section + "[" + index + "].provenance.agent");
        }
        if (section === "facts" && Array.isArray(item.sources)) {
          item.sources = item.sources.map((src, srcIndex) =>
            checkAndRedact(src, "facts[" + index + "].sources[" + srcIndex + "]")
          );
        }
      });
    }
  }

  if (Array.isArray(capsule.artifacts)) {
    capsule.artifacts.forEach((item, index) => {
      item.path = checkAndRedact(item.path, "artifacts[" + index + "].path");
      if (item.provenance) {
        item.provenance.agent = checkAndRedact(item.provenance.agent, "artifacts[" + index + "].provenance.agent");
      }
    });
  }

  capsule.producingParticipant = checkAndRedact(capsule.producingParticipant, "producingParticipant");

  if (redactions.length > 0) {
    capsule.redactions = [...(capsule.redactions || []), ...redactions];
  }

  return { capsule, redactions };
}

export function getSerializedSizeAndEnforceCap(capsule, configuredMaxBytes = undefined) {
  const serialized = JSON.stringify(capsule);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");

  const maxAllowedBytes = resolveCapsuleMaxBytes(configuredMaxBytes);

  if (sizeBytes > maxAllowedBytes) {
    throw new Error("Context capsule size (" + sizeBytes + " bytes) exceeds the configured hard cap (" + maxAllowedBytes + " bytes).");
  }

  return { serialized, sizeBytes };
}

function writeCapsuleAtomically(capsulePath, serialized) {
  const temporaryPath = `${capsulePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serialized, { mode: 0o600 });
    renameSync(temporaryPath, capsulePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export async function saveContextCapsule(root, id, rawCapsule, { agent, turn, configMaxBytes }) {
  const capsulePath = getSafeCapsulePath(root, id);
  const dir = dirname(capsulePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const normalized = normalizeCapsuleInput(rawCapsule, { agent, turn });
  const { capsule: redactedCapsule } = redactSecretsAndInjectionFromCapsule(normalized);
  const { serialized } = getSerializedSizeAndEnforceCap(redactedCapsule, configMaxBytes);

  writeCapsuleAtomically(capsulePath, serialized);
}

export async function readContextCapsule(root, id, sections = null) {
  const capsulePath = getSafeCapsulePath(root, id);
  if (!existsSync(capsulePath)) {
    return null;
  }

  const content = readFileSync(capsulePath, "utf8");

  const envCap = process.env.BRIDGE_CAPSULE_MAX_BYTES;
  const maxAllowedBytes = resolveCapsuleMaxBytes(envCap);
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > maxAllowedBytes) {
    throw new Error("Capsule exceeds size limit of " + maxAllowedBytes + " bytes.");
  }

  const parsed = JSON.parse(content);
  if (parsed.version !== 1) {
    throw new Error("Unsupported schema version: " + parsed.version);
  }

  const validated = ContextCapsuleSchema.parse(parsed);

  // Re-compute provenance freshness/ageSeconds at read time using current system clock
  const now = new Date();
  const sectionsToRecompute = ["facts", "decisions", "artifacts", "constraints", "unresolvedQuestions", "sourceReferences"];
  for (const s of sectionsToRecompute) {
    if (Array.isArray(validated[s])) {
      validated[s].forEach(item => {
        if (item.provenance) {
          const fresh = computeFreshness(item.provenance.timestamp, now);
          item.provenance.ageSeconds = fresh.ageSeconds;
          item.provenance.freshness = fresh.status;
        }
      });
    }
  }

  const { capsule: redacted } = redactSecretsAndInjectionFromCapsule(validated);

  if (!sections || !Array.isArray(sections)) {
    return redacted;
  }

  const allowedSections = new Set([
    "facts", "decisions", "artifacts", "constraints", "unresolvedQuestions", "sourceReferences"
  ]);
  const result = {
    version: redacted.version,
    producingParticipant: redacted.producingParticipant,
    timestamp: redacted.timestamp,
  };

  if (redacted.redactions) {
    result.redactions = redacted.redactions;
  }
  for (const section of sections) {
    if (allowedSections.has(section)) {
      result[section] = redacted[section] || [];
    }
  }

  return result;
}

export async function extractAndSaveCapsuleBeforeObserve(message, { agent, turn, workspace, collaborationId }) {
  if (typeof message !== "string") {
    return { sanitizedMessage: message, hasCapsule: false };
  }

  const lines = message.split("\n");
  const handoffLines = lines.filter(line => /^HANDOFF:\s*/i.test(line));
  if (handoffLines.length > 1) {
    throw new Error("Multiple HANDOFF lines are not allowed.");
  }

  const redactedMessage = redactSecretsAndInjectionFromText(message);

  const redactedLines = redactedMessage.split("\n");
  let handoffLineIndex = -1;
  let handoffObj = null;

  for (let i = 0; i < redactedLines.length; i++) {
    if (/^HANDOFF:\s*/i.test(redactedLines[i])) {
      handoffLineIndex = i;
      const raw = redactedLines[i].replace(/^HANDOFF:\s*/i, "");
      try {
        handoffObj = JSON.parse(raw);
      } catch {}
      break;
    }
  }

  if (handoffLineIndex === -1 || !handoffObj || typeof handoffObj !== "object" || Array.isArray(handoffObj)) {
    return { sanitizedMessage: redactedMessage, hasCapsule: false };
  }

  if (handoffObj.capsule !== undefined) {
    const rawCapsule = handoffObj.capsule;

    if (rawCapsule === "<capsule-available>") {
      const capsulePath = getSafeCapsulePath(workspace, collaborationId);
      if (!existsSync(capsulePath)) {
        throw new Error("Capsule marker references a missing capsule file.");
      }
      return { sanitizedMessage: redactedMessage, hasCapsule: true };
    }

    const normalized = normalizeCapsuleInput(rawCapsule, { agent, turn });
    const { capsule: redacted } = redactSecretsAndInjectionFromCapsule(normalized);

    const configMaxBytes = process.env.BRIDGE_CAPSULE_MAX_BYTES;
    const { serialized } = getSerializedSizeAndEnforceCap(redacted, configMaxBytes);

    const capsulePath = getSafeCapsulePath(workspace, collaborationId);
    const dir = dirname(capsulePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeCapsuleAtomically(capsulePath, serialized);

    const safeHandoffObj = { ...handoffObj, capsule: "<capsule-available>" };
    redactedLines[handoffLineIndex] = "HANDOFF: " + JSON.stringify(safeHandoffObj);
    const sanitizedMessage = redactedLines.join("\n");

    return { sanitizedMessage, hasCapsule: true };
  }

  return { sanitizedMessage: redactedMessage, hasCapsule: false };
}
