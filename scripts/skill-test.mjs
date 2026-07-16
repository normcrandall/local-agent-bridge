import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const canonicalCodexDialoguePath = resolve(root, ".agents/skills/agent-dialogue/SKILL.md");
const canonicalClaudeDialoguePath = resolve(root, "assets/skills/claude/agent-dialogue/SKILL.md");
const codexPath = resolve(process.env.HOME, ".codex/skills/agent-dialogue/SKILL.md");
const claudePath = resolve(process.env.HOME, ".claude/skills/agent-dialogue/SKILL.md");
const [canonicalCodexDialogue, canonicalClaudeDialogue, codex, claude] = await Promise.all([
  readFile(canonicalCodexDialoguePath, "utf8"),
  readFile(canonicalClaudeDialoguePath, "utf8"),
  readFile(codexPath, "utf8"),
  readFile(claudePath, "utf8"),
]);

assert.equal(codex, canonicalCodexDialogue, "Codex agent-dialogue skill is stale");
assert.equal(claude, canonicalClaudeDialogue, "Claude agent-dialogue skill is stale");

for (const [name, content] of [["Codex", codex], ["Claude", claude]]) {
  assert.match(content, /^---\n[\s\S]+?\n---\n/);
  assert.match(content, /name: agent-dialogue/);
  assert.match(content, /description: .+/);
  assert.doesNotMatch(content, /TODO/);
  assert.match(content, /at most three|Make at most three/i);
  assert.match(content, /STATUS: NEEDS_USER/);
  console.log(`${name} agent-dialogue skill: valid`);
}

assert.match(codex, /`ask_claude`/);
assert.match(codex, /`continue_claude`/);
assert.match(codex, /--claude-model/);
assert.match(codex, /--codex-model/);
assert.match(codex, /model: <claude-model>/);
assert.match(codex, /flag is absent, omit the MCP `model` field/);
assert.match(codex, /githubReview/);
assert.match(claude, /mcp__codex__codex/);
assert.match(claude, /mcp__codex__codex-reply/);
assert.match(claude, /\$ARGUMENTS/);
assert.match(claude, /--claude-model/);
assert.match(claude, /--codex-model/);
assert.match(claude, /\/model <alias-or-id>/);
assert.match(claude, /flag is absent, omit the MCP `model` field/);

console.log("CLI dialogue skill tests passed without invoking either model.");

const bridgeSkillNames = (await readdir(resolve(root, "skills"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const globalSkillRoots = [
  resolve(process.env.HOME, ".codex/skills"),
  resolve(process.env.HOME, ".claude/skills"),
  resolve(process.env.HOME, ".gemini/config/skills"),
];

for (const name of bridgeSkillNames) {
  const canonical = await readFile(resolve(root, "skills", name, "SKILL.md"), "utf8");
  assert.match(canonical, new RegExp(`name: ${name}`));
  assert.doesNotMatch(canonical, /TODO/);
  for (const skillRoot of globalSkillRoots) {
    const installed = await readFile(resolve(skillRoot, name, "SKILL.md"), "utf8");
    assert.equal(installed, canonical, `${name} is stale under ${skillRoot}`);
  }
  const antigravityCli = await readFile(
    resolve(process.env.HOME, ".gemini/antigravity-cli/skills", `${name}.md`),
    "utf8",
  );
  assert.equal(antigravityCli, canonical, `${name} is stale for Antigravity CLI`);
}

const askAgent = await readFile(resolve(root, "skills/ask-agent/SKILL.md"), "utf8");
assert.match(askAgent, /HANDOFF/);
assert.match(askAgent, /exact MCP tool/);
assert.match(askAgent, /ask_claude/);
assert.match(askAgent, /codex-reply/);
assert.match(askAgent, /ask_antigravity/);
assert.match(askAgent, /verificationCommands/);
assert.match(askAgent, /handoffPath/);
assert.match(askAgent, /githubReview/);
assert.match(askAgent, /summaryAt/);
assert.match(askAgent, /one compact liveness line per 60 seconds/);
assert.match(askAgent, /Never repeat an unchanged narrative card/);
assert.match(askAgent, /maxTurns: 1/);
assert.match(askAgent, /workCommands/);
assert.match(askAgent, /workProfile/);
assert.match(askAgent, /Pass the current host as `chair`/);
assert.match(askAgent, /provider's user-owned reviewer App/);
assert.match(askAgent, /agent-review/);
assert.match(askAgent, /never switch to a personal token/i);
assert.doesNotMatch(askAgent, /~\/.config\/ghtoken|required bot login/);
for (const term of ["detail: status", "includeTurns: 0", "afterTurn"]) assert.ok(askAgent.includes(term));
assert.match(askAgent, /Never substitute a long-running Bash, sleep, gh, or PR polling loop/);

const roundtable = await readFile(resolve(root, "skills/run-roundtable/SKILL.md"), "utf8");
assert.match(roundtable, /ROUNDTABLE STARTING/);
assert.match(roundtable, /get_collaboration/);
assert.match(roundtable, /waitSeconds/);
assert.match(roundtable, /verificationCommands/);
assert.match(roundtable, /handoffPath/);
assert.match(roundtable, /githubReview/);
assert.match(roundtable, /workCommands/);
assert.match(roundtable, /workProfile/);
assert.match(roundtable, /activeCall/);
assert.match(roundtable, /indeterminate/);
assert.match(roundtable, /provider's user-owned reviewer App/);
assert.match(roundtable, /PAT compatibility is comment-only/);
assert.doesNotMatch(roundtable, /~\/.config\/ghtoken|required bot login/);
for (const term of ["detail: status", "includeTurns: 0", "afterTurn"]) assert.ok(roundtable.includes(term));
assert.match(roundtable, /Never substitute a long-running Bash, sleep, gh, or PR polling loop/);

const history = await readFile(resolve(root, "skills/show-collaboration/SKILL.md"), "utf8");
assert.match(history, /audit timeline/);
assert.match(history, /list_collaborations/);
assert.match(history, /get_collaboration/);
assert.match(history, /activeCall/);
assert.match(history, /`\$ask-agent`, roundtable, goal-loop, pair-program, and council calls use the persistent collaboration ledger/);
assert.match(history, /waitSeconds: 8/);
assert.doesNotMatch(history, /waitSeconds: 20/);
for (const term of ["detail: status", "includeTurns: 0", "afterTurn"]) assert.ok(history.includes(term));

const pairProgram = await readFile(resolve(root, "skills/pair-program/SKILL.md"), "utf8");
for (const term of ["bridge capabilities", "bridge preflight", "bridge roles", "worktree", "ciTracking", "bridge reconcile", "budget", "bridge recover", "githubReview"]) {
  assert.ok(pairProgram.includes(term), `pair-program skill is missing ${term}`);
}
for (const term of ["detail: status", "includeTurns: 0", "afterTurn"]) assert.ok(pairProgram.includes(term));
assert.match(pairProgram, /Never substitute a long-running Bash, sleep, gh, or PR polling loop/);
assert.match(pairProgram, /acknowledge_coordinator_wake/);
assert.match(pairProgram, /provider-specific, user-owned Apps/);
assert.match(pairProgram, /agent-review=success/);
assert.match(pairProgram, /never replace the App with a personal PAT/);

const goalLoop = await readFile(resolve(root, "skills/goal-loop/SKILL.md"), "utf8");
assert.match(goalLoop, /GOAL LOOP STARTING/);
assert.match(goalLoop, /LOOP CHECKPOINT/);
assert.match(goalLoop, /GOAL COMPLETE/);
assert.match(goalLoop, /continue_collaboration/);
assert.match(goalLoop, /Two consecutive cycles/);
assert.match(goalLoop, /waitSeconds: 8/);
assert.match(goalLoop, /PROVIDER SKIPPED/);
assert.match(goalLoop, /verificationCommands/);
assert.match(goalLoop, /handoffPath/);
assert.match(goalLoop, /githubReview/);
assert.match(goalLoop, /workCommands/);
assert.match(goalLoop, /workProfile/);
assert.match(goalLoop, /activeCall/);
assert.match(goalLoop, /indeterminate/);
assert.match(goalLoop, /provider's user-owned App/);
assert.match(goalLoop, /agent-review=success/);
assert.match(goalLoop, /never retry the merge or review through a personal PAT/);
for (const term of ["detail: status", "includeTurns: 0", "afterTurn"]) assert.ok(goalLoop.includes(term));
assert.match(goalLoop, /Never substitute a long-running Bash, sleep, gh, or PR polling loop/);
assert.match(goalLoop, /acknowledge_coordinator_wake/);

const readme = await readFile(resolve(root, "README.md"), "utf8");
const claudeGuidance = await readFile(resolve(root, "CLAUDE.md"), "utf8");
const codexGuidance = await readFile(resolve(root, "AGENTS.md"), "utf8");
for (const guidance of [claudeGuidance, codexGuidance]) {
  assert.match(guidance, /Never substitute a long-running Bash, sleep/);
  assert.match(guidance, /get_collaboration/);
  assert.match(guidance, /acknowledge_coordinator_wake/);
}
assert.match(readme, /collaboration_wake/);
assert.match(readme, /coordinatorWake/);
assert.match(readme, /Do not replace broker polling with one long-running Bash/);
const aiHeroSkillNames = (await readdir(resolve(process.env.HOME, ".agents/skills"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
for (const name of aiHeroSkillNames) {
  assert.ok(readme.includes(`\`${name}\``), `README skill catalog is missing ${name}`);
}
for (const name of bridgeSkillNames) {
  assert.ok(readme.includes(`\`${name}\``), `README skill catalog is missing ${name}`);
}

const councilSkillNames = bridgeSkillNames.filter((name) => name.startsWith("council-"));
assert.equal(councilSkillNames.length, 27);
for (const name of [
  "council-loop-me",
  "council-research",
  "council-to-questionnaire",
  "council-to-spec",
  "council-to-tickets",
  "council-wayfinder",
  "council-wizard",
]) assert.ok(councilSkillNames.includes(name), `Missing newly supported council skill ${name}`);
const bridgeNativeCouncilSkillNames = new Set(["council-discovery", "council-grill-agents", "council-ux-review"]);
const generatedCouncilSkillNames = councilSkillNames.filter((name) => !bridgeNativeCouncilSkillNames.has(name));
for (const name of generatedCouncilSkillNames) {
  const content = await readFile(resolve(root, "skills", name, "SKILL.md"), "utf8");
  assert.match(content, /\.agents\/skills\/.+\/SKILL\.md/);
  assert.match(content, /Claude, Codex, and Antigravity/);
  assert.match(content, /waitSeconds: 8/);
  assert.match(content, /Never leave the user at a static/);
  assert.match(content, /Never substitute a long-running Bash, sleep, gh, or PR polling loop/);
  assert.match(content, /acknowledge_coordinator_wake/);
  assert.match(content, /PROVIDER SKIPPED/);
  assert.match(content, /Continue with two models or one model/);
  assert.match(content, /verificationCommands/);
  assert.match(content, /handoffPath/);
  assert.match(content, /githubReview/);
  assert.match(content, /workCommands/);
  assert.match(content, /workProfile/);
  assert.match(content, /exactly one writer|single writer|one designated writer/);
  assert.match(content, /Pass the current host as `chair`/);
  assert.match(content, /provider's user-owned reviewer App/);
  assert.doesNotMatch(content, /required bot login|as <bot login>/);
}

const councilDiscovery = await readFile(resolve(root, "skills/council-discovery/SKILL.md"), "utf8");
for (const term of [
  ".agents/skills/wayfinder/SKILL.md",
  ".agents/skills/to-tickets/SKILL.md",
  "Claude, Codex, and Antigravity",
  "collaboration.start_collaboration",
  "waitSeconds: 8",
  "wayfinder:map",
  "ready-for-agent",
  "degraded consensus",
  "single-agent recommendation",
  "exactly one publisher",
  "read back and verified",
  "Keep customers",
  "Win customers",
  "Improve maintainability",
  "Reduce overhead",
  "Increase ROI",
  "Primary lens",
  "ROI hypothesis",
  "Direct competitors",
  "Adjacent substitutes",
  "Aspirational benchmarks",
  "browser: true",
  "observed behavior, a vendor claim, or an attributed external signal",
  "Strategic posture",
  "parity | differentiation | substitute response | deliberate non-adoption",
  "A competitor has it",
  "Category lane",
  "Substitute lane",
  "Signal lane",
  "at least eight credible products",
  "at least two materially different query families",
  "two consecutive materially different query families",
  "search saturation",
  "landscape ledger",
  "Search-result snippets and rankings",
  "SEO comparison pages",
  "Landscape coverage",
]) assert.ok(councilDiscovery.includes(term), `Council discovery is missing ${term}`);
assert.match(councilDiscovery, /full consensus/i);
assert.match(councilDiscovery, /Never leave the user at a static/);
assert.match(councilDiscovery, /Never substitute a long-running Bash, sleep/);
assert.match(councilDiscovery, /Continue with two models or one model/);
assert.match(councilDiscovery, /Do not edit product code/);

const councilGrillAgents = await readFile(resolve(root, "skills/council-grill-agents/SKILL.md"), "utf8");
for (const term of [
  "Claude, Codex, and Antigravity",
  "collaboration.start_collaboration",
  "waitSeconds: 8",
  "Grill the models, not the user",
  "Answerer",
  "Challenger",
  "Verifier",
  "asks exactly one specific, falsifiable question",
  "Claim:",
  "supported | revised | rejected | unresolved",
  "degraded consensus",
  "single-agent conclusion",
  "at most nine cross-examination questions",
  "make no code, documentation, issue, or pull-request changes",
]) assert.ok(councilGrillAgents.includes(term), `Council agent grill is missing ${term}`);
assert.match(councilGrillAgents, /full consensus/i);
assert.match(councilGrillAgents, /Never leave the user at a static/);
assert.match(councilGrillAgents, /Never substitute a long-running Bash, sleep/);
assert.match(councilGrillAgents, /Continue with two models or one model/);
assert.match(councilGrillAgents, /exactly one writer or publisher/);

const councilUxReview = await readFile(resolve(root, "skills/council-ux-review/SKILL.md"), "utf8");
for (const term of [
  "Claude, Codex, and Antigravity",
  "collaboration.start_collaboration",
  "browser: true",
  "waitSeconds: 8",
  "desktop viewport",
  "mobile viewport",
  "keyboard-only",
  "full consensus",
  "degraded consensus",
  "single-agent observation",
  "ready-for-agent",
  "P0 — blocked or unsafe",
  "reread every issue from GitHub",
  "Milestone updates are mandatory",
  "Never allow more than 60 seconds",
  "UX REVIEW · <ORIENTING | RENDERING | CHAIR PASS | COUNCIL PASS | VERIFYING | PUBLISHING>",
  "PEER FINISHED: <provider>",
  "ISSUES · PUBLISHING <current>/<total>",
  "announce the completed provider immediately",
  "Your first action after this skill is selected must be a user-visible message",
  "bridge start council-ux-review",
  "bridge watchdog --thread latest",
  "acknowledge_handoff",
  "HANDOFF:",
]) assert.ok(councilUxReview.includes(term), `Council UX review is missing ${term}`);
assert.match(councilUxReview, /exactly one publisher/i);
assert.match(councilUxReview, /Never leave the user at a static/);
assert.match(councilUxReview, /Never substitute a long-running Bash, sleep/);
assert.match(councilUxReview, /Continue with two models or one model/);
assert.match(councilUxReview, /no participant edits source code/i);
assert.match(councilUxReview, /Do not claim consensus, accessibility conformance, or complete coverage/);

const takeTheHelm = await readFile(resolve(root, "skills/take-the-helm/SKILL.md"), "utf8");
for (const term of [
  "goal-loop",
  "pair-program",
  "council-grill-agents",
  "show-collaboration",
  "Claude, Codex, and Antigravity",
  "collaboration.start_collaboration",
  "waitSeconds: 8",
  "Material financial exposure",
  "Legal or potentially illegal activity",
  "Missing authority",
  "Destructive or irreversible external action",
  "Explicitly user-owned choice",
  "Genuinely unanswerable",
  "Exhaust the resolution ladder",
  "Assign exactly one writer",
  "full consensus",
  "degraded consensus",
  "single-agent provisional result",
  "Do not ask “what next?”",
  "Reconstruct intent from Git history",
  "merged pull requests",
  "linked issues",
  "reversions",
  "Treat history as evidence, not permanent policy",
  "commit and pull-request history",
  "plan_portfolio",
  "create_portfolio",
  "maxParallel: 2",
  "dependency edge",
  "conflict edge",
  "path reservation",
  "resource reservation",
  "Run parallel issue lanes",
  "configured live review limit per provider",
  "wakes the oldest queued call automatically",
  "work: 1, review: 2",
  "enqueue_portfolio_merge",
  "begin_portfolio_merge_validation",
  "authorize_portfolio_merge",
  "record_portfolio_merge",
  "recover_portfolio_merge_validation",
  "refresh_portfolio_target",
  "Serialize integration through the bridge merge train",
  "two read-only advocates and a third-model arbiter",
  "HELM <portfolio-id>",
]) assert.ok(takeTheHelm.includes(term), `Take the helm is missing ${term}`);
assert.match(takeTheHelm, /Never leave the user at a static/);
assert.match(takeTheHelm, /Never substitute a long-running Bash, sleep/);
assert.match(takeTheHelm, /Merge only when repository policy contains standing auto-merge authority or the exact head SHA has been explicitly authorized/);
assert.match(takeTheHelm, /native coordinator calls collaboration `merge_pull_request`/);
assert.match(takeTheHelm, /Every wait is a race/);
assert.match(takeTheHelm, /wait_for_portfolio_lane/);
assert.match(takeTheHelm, /every eligible provider.*`recovering`/si);
assert.match(takeTheHelm, /Claude, Codex, and Antigravity/);
assert.match(takeTheHelm, /agent-review=success/);
assert.match(takeTheHelm, /never use an owner PAT bypass/);
assert.match(takeTheHelm, /Routine uncertainty.*is not an escalation/);
assert.match(takeTheHelm, /Continue with two models or one model/);

console.log("Global bridge skills are synchronized across Codex, Claude, Antigravity App, and Antigravity CLI.");
