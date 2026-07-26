import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

export const COLLABORATION_REUSE_DIMENSIONS = Object.freeze([
  "requestedProviderRoster",
  "startAgent",
  "explicitModels",
  "modelFallbacks",
  "allowClaudeFable",
  "handoffPath",
  "githubReviewerIdentityConstraints",
]);

function clean(value) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeProviderValues(values = {}, { lists = false } = {}) {
  return Object.fromEntries(Object.keys(values || {}).sort().flatMap((provider) => {
    const value = values[provider];
    if (lists) {
      if (!Array.isArray(value)) return [];
      return [[provider, value.map((entry) => clean(entry))]];
    }
    const normalized = clean(value);
    return normalized ? [[provider, normalized]] : [];
  }));
}

function canonicalReviewerLogin(value) {
  const login = clean(value).toLowerCase().replace(/\[bot\]$/i, "");
  return login ? `${login}[bot]` : null;
}

function reviewerIdentityConstraints(githubReview = null) {
  if (!githubReview) return { expectedLogin: null, expectedLogins: {} };
  return {
    expectedLogin: canonicalReviewerLogin(githubReview.expectedLogin),
    expectedLogins: Object.fromEntries(Object.keys(githubReview.expectedLogins || {}).sort().flatMap((provider) => {
      const login = canonicalReviewerLogin(githubReview.expectedLogins[provider]);
      return login ? [[provider, login]] : [];
    })),
  };
}

export function collaborationReuseCompatibility({
  workspace,
  agents = [],
  startAgent = null,
  models = {},
  modelFallbacks = {},
  allowClaudeFable = false,
  handoffPath = null,
  githubReview = null,
} = {}) {
  const requestedProviderRoster = (agents || []).map((agent) => clean(agent));
  return {
    requestedProviderRoster,
    startAgent: clean(startAgent) || requestedProviderRoster[0] || null,
    explicitModels: normalizeProviderValues(models),
    modelFallbacks: normalizeProviderValues(modelFallbacks, { lists: true }),
    allowClaudeFable: allowClaudeFable === true,
    handoffPath: handoffPath ? resolve(workspace, handoffPath) : null,
    githubReviewerIdentityConstraints: reviewerIdentityConstraints(githubReview),
  };
}

export function collaborationTarget(input = {}) {
  const repository = input.issueClaim?.repository || input.githubReview?.repository || input.githubBuilder?.repository || null;
  if (input.issueClaim?.issueNumber) return { repository, kind: "issue", number: input.issueClaim.issueNumber, headSha: input.issueClaim.headSha || null };
  if (input.githubReview?.prNumber) return { repository, kind: "pr", number: input.githubReview.prNumber, headSha: input.githubReview.headSha || null };
  if (input.githubBuilder?.prNumber) return { repository, kind: "pr", number: input.githubBuilder.prNumber, headSha: input.githubBuilder.headSha || null };
  return null;
}

export function collaborationIdentity({
  workspace,
  mode,
  writer = null,
  issueClaim = null,
  githubReview = null,
  githubBuilder = null,
  resumeKey = null,
  agents = [],
  startAgent = null,
  models = {},
  modelFallbacks = {},
  allowClaudeFable = false,
  handoffPath = null,
} = {}) {
  const explicit = clean(resumeKey);
  const target = collaborationTarget({ issueClaim, githubReview, githubBuilder });
  if (!explicit && !target) return null;
  const scope = explicit
    ? ["explicit", explicit, resolve(workspace)]
    : [target.repository, target.kind, target.number, target.headSha || "unbound", mode || "review", writer || "review", resolve(workspace)];
  const compatibility = collaborationReuseCompatibility({
    workspace,
    agents,
    startAgent,
    models,
    modelFallbacks,
    allowClaudeFable,
    handoffPath,
    githubReview,
  });
  return createHash("sha256").update(`${scope.join("\0")}\0${JSON.stringify(compatibility)}`).digest("hex");
}

export function collaborationAlias(state = {}) {
  const target = collaborationTarget(state);
  const repository = target?.repository || state.repository || `local/${basename(state.workspace || "workspace")}`;
  const subject = target ? `${target.kind === "issue" ? "#" : "PR-"}${target.number}` : state.resumeKey || String(state.id || "lane").replace(/^bridge-/, "").slice(0, 8);
  const role = state.writer ? `${state.writer}-writer` : `${state.runtime?.activeCall?.agent || state.startAgent || "council"}-review`;
  return `${repository}:${subject}:${role}`;
}
