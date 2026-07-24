import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

function clean(value) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export function collaborationTarget(input = {}) {
  const repository = input.issueClaim?.repository || input.githubReview?.repository || input.githubBuilder?.repository || null;
  if (input.issueClaim?.issueNumber) return { repository, kind: "issue", number: input.issueClaim.issueNumber, headSha: input.issueClaim.headSha || null };
  if (input.githubReview?.prNumber) return { repository, kind: "pr", number: input.githubReview.prNumber, headSha: input.githubReview.headSha || null };
  if (input.githubBuilder?.prNumber) return { repository, kind: "pr", number: input.githubBuilder.prNumber, headSha: input.githubBuilder.headSha || null };
  return null;
}

export function collaborationIdentity({ workspace, mode, writer = null, issueClaim = null, githubReview = null, githubBuilder = null, resumeKey = null } = {}) {
  const explicit = clean(resumeKey);
  const target = collaborationTarget({ issueClaim, githubReview, githubBuilder });
  if (!explicit && !target) return null;
  const parts = explicit
    ? ["explicit", explicit, resolve(workspace)]
    : [target.repository, target.kind, target.number, target.headSha || "unbound", mode || "review", writer || "review", resolve(workspace)];
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function collaborationAlias(state = {}) {
  const target = collaborationTarget(state);
  const repository = target?.repository || state.repository || `local/${basename(state.workspace || "workspace")}`;
  const subject = target ? `${target.kind === "issue" ? "#" : "PR-"}${target.number}` : state.resumeKey || String(state.id || "lane").replace(/^bridge-/, "").slice(0, 8);
  const role = state.writer ? `${state.writer}-writer` : `${state.runtime?.activeCall?.agent || state.startAgent || "council"}-review`;
  return `${repository}:${subject}:${role}`;
}
