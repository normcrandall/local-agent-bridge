const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REQUIRED_PR_SECTIONS = Object.freeze(["outcome", "scope", "verification", "follow-ups"]);
const NONE_PATTERN = /^(?:none|n\/a|not applicable)[.!]?$/i;

function normalized(value) {
  return String(value || "").trim();
}

function headingSections(body) {
  const sections = new Map();
  let current = null;
  for (const line of normalized(body).split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (heading) {
      current = heading[1].trim().toLowerCase();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }
  return new Map([...sections].map(([key, lines]) => [key, lines.join("\n").trim()]));
}

export function githubIssueUrl(repository, issueNumber) {
  if (!REPOSITORY_PATTERN.test(repository || "")) throw new Error("GitHub delivery requires owner/name repository identity.");
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("GitHub delivery requires a positive issue number.");
  return `https://github.com/${repository}/issues/${issueNumber}`;
}

export function assertGithubGovernedWorkStart({
  policy,
  requestedProfile = null,
  mode,
  issueTarget = null,
  issueClaim = null,
  issueContext = null,
  githubBuilder = null,
  worktree = null,
} = {}) {
  if (!policy?.deliveryProfile) throw new Error("GitHub delivery preflight requires a resolved delivery policy.");
  const profile = policy.deliveryProfile;
  if (mode !== "work") return { profile, governed: profile === "github-governed" };

  if (profile === "local-only") {
    const explicitlyLocal = requestedProfile === "local-only"
      || policy.decisions?.deliveryProfile?.source === "repository_policy";
    if (!explicitlyLocal) {
      throw new Error("Local-only implementation requires an explicit deliveryProfile=local-only run or repository policy; an unavailable GitHub route may not silently downgrade implementation delivery.");
    }
    if (githubBuilder || issueClaim || issueTarget) {
      throw new Error("Local-only implementation cannot carry a GitHub builder, issue claim, or issue target. Start a github-governed lane for GitHub delivery.");
    }
    return { profile, governed: false, explicit: true };
  }

  const target = issueClaim || issueTarget;
  if (!target?.repository || !target?.issueNumber) {
    throw new Error("GitHub-governed implementation must start from a hydrated GitHub issueTarget or issueClaim.");
  }
  if (!issueContext) {
    throw new Error(`GitHub-governed implementation cannot start until ${target.repository}#${target.issueNumber} is hydrated through the bound builder App.`);
  }
  if (!githubBuilder) {
    throw new Error("GitHub-governed implementation must use a bound githubBuilder and deliver through a pull request.");
  }
  if (githubBuilder.repository !== target.repository) {
    throw new Error(`GitHub builder repository ${githubBuilder.repository} does not match hydrated issue ${target.repository}#${target.issueNumber}.`);
  }
  if (worktree?.strategy !== "self-contained") {
    throw new Error("GitHub-governed implementation requires a self-contained writer checkout.");
  }
  return {
    profile,
    governed: true,
    repository: target.repository,
    issueNumber: target.issueNumber,
    issueUrl: githubIssueUrl(target.repository, target.issueNumber),
    exactHeadRequired: true,
    prOnly: true,
  };
}

export function governedContinuationBuilder({ deliveryPolicy, currentBuilder, replacementBuilder, issueTarget } = {}) {
  if (deliveryPolicy?.profile !== "github-governed") return replacementBuilder || currentBuilder || null;
  if (!currentBuilder || !issueTarget?.repository || !issueTarget?.issueNumber) {
    throw new Error("A GitHub-governed continuation requires its original builder and immutable issue target.");
  }
  const candidate = replacementBuilder || currentBuilder;
  if (candidate.repository !== currentBuilder.repository || candidate.repository !== issueTarget.repository) {
    throw new Error("GitHub-governed continuation cannot change the builder repository or issue target.");
  }
  if (replacementBuilder?.headRef && currentBuilder.headRef && replacementBuilder.headRef !== currentBuilder.headRef) {
    throw new Error("GitHub-governed continuation cannot change its bound publication branch.");
  }
  if (replacementBuilder?.baseRef && currentBuilder.baseRef && replacementBuilder.baseRef !== currentBuilder.baseRef) {
    throw new Error("GitHub-governed continuation cannot change its bound pull-request base branch.");
  }
  return {
    ...candidate,
    repository: currentBuilder.repository,
    issueNumber: issueTarget.issueNumber,
    headRef: currentBuilder.headRef || candidate.headRef,
    baseRef: currentBuilder.baseRef || candidate.baseRef,
  };
}

export function validateGithubGovernedPullRequest({ repository, issueNumber, body, headSha } = {}) {
  const issueUrl = githubIssueUrl(repository, issueNumber);
  if (!SHA_PATTERN.test(headSha || "")) throw new Error("GitHub-governed publication requires the exact 40-character published head SHA.");
  const text = normalized(body);
  const issueReference = new RegExp(`(?:${issueUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b)`, "i");
  if (!issueReference.test(text)) {
    throw new Error(`GitHub-governed PR description must link and close ${repository}#${issueNumber}.`);
  }
  const sections = headingSections(text);
  for (const required of REQUIRED_PR_SECTIONS) {
    if (!sections.get(required)) throw new Error(`GitHub-governed PR description requires a non-empty '${required}' heading.`);
  }
  if (/^(?:none|not run|not tested|n\/a)[.!]?$/i.test(sections.get("verification"))) {
    throw new Error("GitHub-governed PR verification must name risk-based evidence; 'none' or 'not run' is not sufficient.");
  }
  const followUps = sections.get("follow-ups");
  const issueLinks = [...followUps.matchAll(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/[1-9][0-9]*/gi)].map((match) => match[0]);
  if (!NONE_PATTERN.test(followUps) && issueLinks.length === 0) {
    throw new Error("Material follow-up work must link a durable GitHub issue; otherwise write 'None' under Follow-ups.");
  }
  return {
    version: 1,
    profile: "github-governed",
    repository,
    issueNumber,
    issueUrl,
    headSha: headSha.toLowerCase(),
    outcome: sections.get("outcome"),
    scope: sections.get("scope"),
    verification: sections.get("verification"),
    followUpIssues: issueLinks,
  };
}

export function deliveryIssueSummary(receipt, { prNumber, prUrl } = {}) {
  return [
    "<!-- agent-bridge-delivery:v1 -->",
    "### GitHub-governed delivery",
    `- PR: [#${prNumber}](${prUrl})`,
    `- Exact published head: \`${receipt.headSha}\``,
    `- Outcome: ${receipt.outcome}`,
    `- Scope: ${receipt.scope}`,
    `- Verification: ${receipt.verification}`,
    `- Follow-ups: ${receipt.followUpIssues.length ? receipt.followUpIssues.join(", ") : "None"}`,
  ].join("\n");
}

export function mergedDeliverySummary({ prNumber, prUrl, headSha, mergedSha }) {
  if (!SHA_PATTERN.test(headSha || "") || !SHA_PATTERN.test(mergedSha || "")) {
    throw new Error("Merged delivery receipt requires exact head and merged SHAs.");
  }
  return [
    "<!-- agent-bridge-merge:v1 -->",
    "### Delivery merged",
    `- PR: [#${prNumber}](${prUrl})`,
    `- Approved exact head: \`${headSha.toLowerCase()}\``,
    `- Merged SHA: \`${mergedSha.toLowerCase()}\``,
  ].join("\n");
}
