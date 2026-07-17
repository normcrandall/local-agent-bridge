import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportSkills, lintSkillCatalog, verifySkillExport } from "./skill-portability.mjs";

const root = resolve(import.meta.dirname, "..");
const home = process.env.HOME || homedir();
const verifyInstalledSkills = process.env.AGENT_BRIDGE_VERIFY_INSTALLED_SKILLS === "1";
const canonicalCodexDialoguePath = resolve(root, ".agents/skills/agent-dialogue/SKILL.md");
const canonicalClaudeDialoguePath = resolve(root, "assets/skills/claude/agent-dialogue/SKILL.md");
const [canonicalCodexDialogue, canonicalClaudeDialogue] = await Promise.all([
  readFile(canonicalCodexDialoguePath, "utf8"),
  readFile(canonicalClaudeDialoguePath, "utf8"),
]);
let codex = canonicalCodexDialogue;
let claude = canonicalClaudeDialogue;
if (verifyInstalledSkills) {
  [codex, claude] = await Promise.all([
    readFile(resolve(home, ".codex/skills/agent-dialogue/SKILL.md"), "utf8"),
    readFile(resolve(home, ".claude/skills/agent-dialogue/SKILL.md"), "utf8"),
  ]);
}
const claudeFablePolicy = /Never select, inherit, or fall back to Fable unless the user's current request explicitly asks for Fable by name/;

if (verifyInstalledSkills) {
  assert.equal(codex, canonicalCodexDialogue, "Codex agent-dialogue skill is stale");
  assert.equal(claude, canonicalClaudeDialogue, "Claude agent-dialogue skill is stale");
}

for (const [name, content] of [["Codex", codex], ["Claude", claude]]) {
  assert.match(content, /^---\n[\s\S]+?\n---\n/);
  assert.match(content, /name: agent-dialogue/);
  assert.match(content, /description: .+/);
  assert.doesNotMatch(content, /TODO/);
  assert.match(content, /at most three|Make at most three/i);
  assert.match(content, /STATUS: NEEDS_USER/);
  assert.match(content, claudeFablePolicy);
  console.log(`${name} agent-dialogue skill: valid`);
}

assert.match(codex, /`ask_claude`/);
assert.match(codex, /`continue_claude`/);
assert.match(codex, /--claude-model/);
assert.match(codex, /--codex-model/);
assert.match(codex, /model: <claude-model>/);
assert.match(codex, /flag is absent, omit the MCP `model` field/);
assert.match(codex, /githubReview/);
assert.match(codex, /allowFable: true/);
assert.match(claude, /mcp__codex__codex/);
assert.match(claude, /mcp__codex__codex-reply/);
assert.match(claude, /\$ARGUMENTS/);
assert.match(claude, /--claude-model/);
assert.match(claude, /--codex-model/);
assert.match(claude, /\/model <alias-or-id>/);
assert.match(claude, /flag is absent, omit the MCP `model` field/);
assert.match(claude, /allowFable: true/);

console.log("CLI dialogue skill tests passed without invoking either model.");

const bridgeSkillNames = (await readdir(resolve(root, "skills"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const portableHome = await mkdtemp(join(tmpdir(), "agent-bridge-skill-export-"));
const firstPortableExport = await exportSkills({ homeRoot: portableHome, sourceRoot: root });
const secondPortableExport = await exportSkills({ homeRoot: portableHome, sourceRoot: root });
assert.deepEqual(secondPortableExport, firstPortableExport, "Skill export is not deterministic");
const catalogLint = await lintSkillCatalog({ sourceRoot: root, exportedHome: portableHome });
assert.deepEqual(catalogLint.findings, [], `Portable catalog lint failed: ${JSON.stringify(catalogLint.findings)}`);
assert.equal((await verifySkillExport({ homeRoot: portableHome })).ok, true);
assert.equal(firstPortableExport.profileVersion, 1);
for (const target of ["codex", "claude", "gemini", "antigravity-cli"]) {
  assert.ok(firstPortableExport.targets[target], `Missing portable target ${target}`);
  assert.ok(firstPortableExport.exports[target]["take-the-helm"].supported);
}
assert.equal(
  firstPortableExport.exports.claude["ask-agent"].files.some((file) => file.path.endsWith("agents/openai.yaml")),
  false,
  "Claude export leaked Codex-only openai.yaml",
);
assert.deepEqual(firstPortableExport.skills["ask-agent"].requiredCapabilities.mcpServers, ["antigravity", "claude_code", "codex"]);
assert.doesNotMatch(JSON.stringify(firstPortableExport), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(
  await readFile(resolve(portableHome, ".claude/skills/show-collaboration/SKILL.md"), "utf8"),
  /`\/ask-agent`/,
);

const stalePath = resolve(portableHome, ".codex/skills/ask-agent/SKILL.md");
await writeFile(stalePath, `${await readFile(stalePath, "utf8")}\nmodified\n`);
const staleVerification = await verifySkillExport({ homeRoot: portableHome });
assert.equal(staleVerification.ok, false);
assert.ok(staleVerification.findings.some((item) => item.code === "stale-export"));
await exportSkills({ homeRoot: portableHome, sourceRoot: root });

const escapedManifest = JSON.parse(await readFile(resolve(portableHome, ".local/share/agent-bridge/skill-exports/manifest.v1.json"), "utf8"));
escapedManifest.exports.codex["ask-agent"].files[0].path = "../../outside-home";
await writeFile(
  resolve(portableHome, ".local/share/agent-bridge/skill-exports/manifest.v1.json"),
  `${JSON.stringify(escapedManifest, null, 2)}\n`,
);
const escapedVerification = await verifySkillExport({ homeRoot: portableHome });
assert.ok(escapedVerification.findings.some((item) => item.code === "export-path-escape"));
await exportSkills({ homeRoot: portableHome, sourceRoot: root });

const brokenSource = await mkdtemp(join(tmpdir(), "agent-bridge-broken-skill-"));
const brokenSkillRoot = resolve(brokenSource, "skills/broken-skill");
await mkdir(resolve(brokenSkillRoot, "agents"), { recursive: true });
await writeFile(resolve(brokenSkillRoot, "SKILL.md"), `---
name: broken-skill
description: Broken portability fixture
version: 1
---
Use $missing-skill and [the missing resource](assets/missing.md).
Do not copy /Users/example/private, example-reviewer[bot], ${"github" + "_pat_" + "1".repeat(20)},
${hostname()}, or bridge-deadbeef-0000-4000-8000-000000000000.
`);
await writeFile(resolve(brokenSkillRoot, "agents/openai.yaml"), `dependencies:
  tools:
    - type: "mcp"
      value: "missing_server"
`);
const brokenCodes = new Set((await lintSkillCatalog({ sourceRoot: brokenSource })).findings.map((item) => item.code));
for (const code of [
  "unsupported-metadata",
  "missing-resource",
  "absolute-local-path",
  "machine-identity",
  "embedded-app-identity",
  "embedded-credential",
  "collaboration-history",
  "unresolved-tool",
  "unadapted-invocation",
]) assert.ok(brokenCodes.has(code), `Broken fixture did not trigger ${code}`);
await rm(brokenSource, { recursive: true, force: true });

const resourceSource = await mkdtemp(join(tmpdir(), "agent-bridge-resource-skill-"));
const resourceSkillRoot = resolve(resourceSource, "skills/resource-skill");
await mkdir(resolve(resourceSkillRoot, "assets"), { recursive: true });
await writeFile(resolve(resourceSkillRoot, "SKILL.md"), `---
name: resource-skill
description: Valid resource portability fixture
---
Read [the template](assets/template.md).
`);
await writeFile(resolve(resourceSkillRoot, "assets/template.md"), "portable template\n");
const resourceExport = await exportSkills({ homeRoot: portableHome, sourceRoot: resourceSource });
assert.equal(resourceExport.exports.codex["resource-skill"].supported, true);
assert.equal(resourceExport.exports["antigravity-cli"]["resource-skill"].supported, false);
assert.match(resourceExport.exports["antigravity-cli"]["resource-skill"].unsupported[0], /cannot package resources/);
await rm(resourceSource, { recursive: true, force: true });
await exportSkills({ homeRoot: portableHome, sourceRoot: root });

const driftSource = await mkdtemp(join(tmpdir(), "agent-bridge-drift-skill-"));
const driftSkillRoot = resolve(driftSource, "skills/drift-skill");
const driftHome = await mkdtemp(join(tmpdir(), "agent-bridge-drift-home-"));
await mkdir(driftSkillRoot, { recursive: true });
await writeFile(resolve(driftSkillRoot, "SKILL.md"), `---
name: drift-skill
description: Source drift fixture
---
Original source.
`);
await exportSkills({ homeRoot: driftHome, sourceRoot: driftSource });
assert.equal((await verifySkillExport({ homeRoot: driftHome, sourceRoot: driftSource })).ok, true);
await writeFile(resolve(driftSkillRoot, "SKILL.md"), `---
name: drift-skill
description: Source drift fixture
---
Changed source.
`);
const driftVerification = await verifySkillExport({ homeRoot: driftHome, sourceRoot: driftSource });
assert.ok(driftVerification.findings.some((item) => item.code === "stale-source"));
await rm(driftSource, { recursive: true, force: true });
await rm(driftHome, { recursive: true, force: true });

const unsafeSource = await mkdtemp(join(tmpdir(), "agent-bridge-unsafe-skill-"));
const unsafeSkillRoot = resolve(unsafeSource, "skills/unsafe-skill");
await mkdir(resolve(unsafeSkillRoot, "assets"), { recursive: true });
await writeFile(resolve(unsafeSource, "outside.md"), "outside\n");
await writeFile(resolve(unsafeSkillRoot, "SKILL.md"), `---
name: unsafe-skill
description: Unsafe resource fixture
---
Read [outside](../../outside.md) and [linked](assets/linked.md).
`);
await symlink(resolve(unsafeSource, "outside.md"), resolve(unsafeSkillRoot, "assets/linked.md"));
const unsafeCodes = new Set((await lintSkillCatalog({ sourceRoot: unsafeSource })).findings.map((item) => item.code));
assert.ok(unsafeCodes.has("resource-path-escape"));
assert.ok(unsafeCodes.has("symlink-resource"));
await rm(unsafeSource, { recursive: true, force: true });

const globalSkillRoots = [
  resolve(portableHome, ".codex/skills"),
  resolve(portableHome, ".claude/skills"),
  resolve(portableHome, ".gemini/config/skills"),
];
const adaptForSlashCommands = (content) => content.replace(/\$([a-z][a-z0-9-]+)/g, (original, name) => (
  bridgeSkillNames.includes(name) ? `/${name}` : original
));

for (const name of bridgeSkillNames) {
  const canonical = await readFile(resolve(root, "skills", name, "SKILL.md"), "utf8");
  assert.match(canonical, new RegExp(`name: ${name}`));
  assert.doesNotMatch(canonical, /TODO/);
  if (/\bClaude\b/.test(canonical)) {
    assert.match(canonical, claudeFablePolicy, `${name} can invoke Claude but lacks the deny-by-default Fable policy`);
    assert.match(canonical, /allowClaudeFable: true|allowFable: true/, `${name} does not explain the explicit runtime opt-in`);
  }
  for (const [index, skillRoot] of globalSkillRoots.entries()) {
    const installed = await readFile(resolve(skillRoot, name, "SKILL.md"), "utf8");
    assert.equal(installed, index === 0 ? canonical : adaptForSlashCommands(canonical), `${name} is stale under ${skillRoot}`);
  }
  const antigravityCli = await readFile(
    resolve(portableHome, ".gemini/antigravity-cli/skills", `${name}.md`),
    "utf8",
  );
  assert.equal(antigravityCli, adaptForSlashCommands(canonical), `${name} is stale for Antigravity CLI`);
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

const collaborationDoctor = await readFile(resolve(root, "skills/collaboration-doctor/SKILL.md"), "utf8");
for (const term of [
  "bridge doctor",
  "--workspace",
  "--providers",
  "--strict-provider",
  "--required-command",
  "--allow-command",
  "--builder-operation",
  "--require-review-app",
  "--require-fallback",
  "--require-budget",
  "--json",
  "--input",
  "least-authority",
]) assert.ok(collaborationDoctor.includes(term), `collaboration-doctor skill is missing ${term}`);
assert.match(collaborationDoctor, /read-only/i);
assert.match(collaborationDoctor, /must not:[\s\S]*change configuration/);
assert.match(collaborationDoctor, /Do not enable PAT fallback/);
assert.match(collaborationDoctor, /no provider is eligible/);
assert.doesNotMatch(collaborationDoctor, /TODO/);

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
const localBridge = await readFile(resolve(root, "bridge"), "utf8");
assert.match(localBridge, /\n  skills\)\n/);
assert.match(localBridge, /scripts\/collaboration-doctor\.mjs/);
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
const aiHeroSkillEntries = await readdir(resolve(home, ".agents/skills"), { withFileTypes: true }).catch((error) => {
  if (error?.code === "ENOENT") return [];
  throw error;
});
const aiHeroSkillNames = aiHeroSkillEntries
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

const pathExists = (path) => stat(path).then(() => true, (error) => (error.code === "ENOENT" ? false : Promise.reject(error)));

const mergeSource = await mkdtemp(join(tmpdir(), "agent-bridge-merge-skill-"));
const mergeHome = await mkdtemp(join(tmpdir(), "agent-bridge-merge-home-"));
const mergeManifestPath = resolve(mergeHome, ".local/share/agent-bridge/skill-exports/manifest.v1.json");
const writeMergeSkill = async (name, body) => {
  const skillRoot = resolve(mergeSource, "skills", name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(resolve(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture\n---\n${body}\n`);
};
await writeMergeSkill("alpha-skill", "Alpha body.");
await writeMergeSkill("beta-skill", "Beta body.");
const fullMerge = await exportSkills({ homeRoot: mergeHome, sourceRoot: mergeSource });
assert.equal(fullMerge.skills["alpha-skill"].trigger, undefined, "Profile must not duplicate description as trigger");
assert.equal(fullMerge.skills["alpha-skill"].description, "alpha-skill fixture");
const manifestBytesA = await readFile(mergeManifestPath, "utf8");
await exportSkills({ homeRoot: mergeHome, sourceRoot: mergeSource });
assert.equal(await readFile(mergeManifestPath, "utf8"), manifestBytesA, "Manifest bytes must be deterministic across repeated exports");

const partialMerge = await exportSkills({ homeRoot: mergeHome, sourceRoot: mergeSource, skillNames: ["alpha-skill"], targets: ["codex"] });
assert.ok(partialMerge.skills["beta-skill"], "Partial export must preserve non-selected skill profiles");
assert.ok(partialMerge.exports.claude["beta-skill"], "Partial export must preserve non-selected targets");
assert.ok(partialMerge.exports.codex["beta-skill"], "Partial export must preserve non-selected skills in a selected target");
assert.deepEqual(partialMerge, fullMerge, "A no-change partial export must merge back to the full manifest");

await writeFile(resolve(mergeHome, ".claude/skills/beta-skill/SKILL.md"), "tampered\n");
await exportSkills({ homeRoot: mergeHome, sourceRoot: mergeSource, skillNames: ["alpha-skill"], targets: ["codex"] });
const tamperedMergeVerification = await verifySkillExport({ homeRoot: mergeHome, sourceRoot: mergeSource });
assert.ok(
  tamperedMergeVerification.findings.some((item) => item.skill === "beta-skill" && item.code === "stale-export"),
  "Tampered non-selected export must stay detectable after a partial export",
);
await rm(resolve(mergeHome, ".gemini/antigravity-cli/skills/beta-skill.md"));
const deletedMergeVerification = await verifySkillExport({ homeRoot: mergeHome, sourceRoot: mergeSource });
assert.ok(
  deletedMergeVerification.findings.some((item) => item.skill === "beta-skill" && item.code === "missing-export"),
  "Deleted non-selected export must stay detectable after a partial export",
);
await exportSkills({ homeRoot: mergeHome, sourceRoot: mergeSource });
assert.equal((await verifySkillExport({ homeRoot: mergeHome, sourceRoot: mergeSource })).ok, true);

await rm(resolve(mergeSource, "skills/beta-skill"), { recursive: true, force: true });
const prunedMerge = await exportSkills({ homeRoot: mergeHome, sourceRoot: mergeSource, skillNames: ["alpha-skill"], targets: ["codex"] });
assert.equal(prunedMerge.skills["beta-skill"], undefined, "Deleted catalog skill must be pruned from the manifest");
assert.equal(prunedMerge.exports.claude["beta-skill"], undefined);
assert.equal(await pathExists(resolve(mergeHome, ".claude/skills/beta-skill")), false, "Orphaned directory export must be removed");
assert.equal(await pathExists(resolve(mergeHome, ".gemini/antigravity-cli/skills/beta-skill.md")), false, "Orphaned flat export must be removed");
assert.equal((await verifySkillExport({ homeRoot: mergeHome, sourceRoot: mergeSource })).ok, true);

await writeFile(mergeManifestPath, "not json\n");
await assert.rejects(
  exportSkills({ homeRoot: mergeHome, sourceRoot: mergeSource, skillNames: ["alpha-skill"], targets: ["codex"] }),
  /partial-export-manifest/,
  "A partial export over an unreadable manifest must fail closed",
);
await exportSkills({ homeRoot: mergeHome, sourceRoot: mergeSource });
assert.equal((await verifySkillExport({ homeRoot: mergeHome, sourceRoot: mergeSource })).ok, true);

const symlinkHome = await mkdtemp(join(tmpdir(), "agent-bridge-symlink-home-"));
const symlinkOutside = await mkdtemp(join(tmpdir(), "agent-bridge-symlink-outside-"));

await symlink(symlinkOutside, resolve(symlinkHome, ".codex"));
await assert.rejects(
  exportSkills({ homeRoot: symlinkHome, sourceRoot: mergeSource }),
  /export-symlink/,
  "A symlinked directory-target root must abort the export",
);
await rm(resolve(symlinkHome, ".codex"));
await rm(resolve(symlinkHome, ".gemini"), { recursive: true, force: true });
await rm(resolve(symlinkHome, ".claude"), { recursive: true, force: true });

await mkdir(resolve(symlinkHome, ".gemini/antigravity-cli/skills"), { recursive: true });
await writeFile(resolve(symlinkOutside, "target.md"), "outside\n");
await symlink(resolve(symlinkOutside, "target.md"), resolve(symlinkHome, ".gemini/antigravity-cli/skills/alpha-skill.md"));
await assert.rejects(
  exportSkills({ homeRoot: symlinkHome, sourceRoot: mergeSource }),
  /export-symlink/,
  "A symlinked flat export file must abort the export",
);
await rm(resolve(symlinkHome, ".gemini"), { recursive: true, force: true });
await rm(resolve(symlinkHome, ".claude"), { recursive: true, force: true });

await mkdir(resolve(symlinkOutside, "share"), { recursive: true });
await mkdir(resolve(symlinkHome, ".local"), { recursive: true });
await symlink(resolve(symlinkOutside, "share"), resolve(symlinkHome, ".local/share"));
await assert.rejects(
  exportSkills({ homeRoot: symlinkHome, sourceRoot: mergeSource }),
  /export-symlink/,
  "A symlinked manifest parent must abort the export",
);
await rm(resolve(symlinkHome, ".local"), { recursive: true, force: true });

await mkdir(resolve(symlinkHome, ".local/share/agent-bridge/skill-exports"), { recursive: true });
await writeFile(resolve(symlinkOutside, "manifest.v1.json"), "{}\n");
await symlink(resolve(symlinkOutside, "manifest.v1.json"), resolve(symlinkHome, ".local/share/agent-bridge/skill-exports/manifest.v1.json"));
await assert.rejects(
  exportSkills({ homeRoot: symlinkHome, sourceRoot: mergeSource }),
  /export-symlink/,
  "A symlinked manifest file must abort the export",
);
const manifestSymlinkVerification = await verifySkillExport({ homeRoot: symlinkHome, sourceRoot: mergeSource });
assert.ok(
  manifestSymlinkVerification.findings.some((item) => item.code === "export-symlink"),
  "Verification must reject a symlinked manifest instead of following it",
);
await rm(resolve(symlinkHome, ".local"), { recursive: true, force: true });

await exportSkills({ homeRoot: symlinkHome, sourceRoot: mergeSource });
assert.equal((await verifySkillExport({ homeRoot: symlinkHome, sourceRoot: mergeSource })).ok, true);
const alphaCodexDir = resolve(symlinkHome, ".codex/skills/alpha-skill");
await rm(alphaCodexDir, { recursive: true, force: true });
await mkdir(resolve(symlinkOutside, "alpha-skill"), { recursive: true });
await writeFile(
  resolve(symlinkOutside, "alpha-skill/SKILL.md"),
  await readFile(resolve(mergeSource, "skills/alpha-skill/SKILL.md")),
);
await symlink(resolve(symlinkOutside, "alpha-skill"), alphaCodexDir);
const readSymlinkVerification = await verifySkillExport({ homeRoot: symlinkHome, sourceRoot: mergeSource });
assert.ok(
  readSymlinkVerification.findings.some((item) => item.code === "export-symlink" && item.path === ".codex/skills/alpha-skill/SKILL.md"),
  "Verification must reject symlinked export paths even when the linked content hash matches",
);

await rm(mergeSource, { recursive: true, force: true });
await rm(mergeHome, { recursive: true, force: true });
await rm(symlinkHome, { recursive: true, force: true });
await rm(symlinkOutside, { recursive: true, force: true });
console.log("Partial-export merge, orphan cleanup, and symlink-rejection tests passed.");

console.log("Portable bridge skill sources and exports are valid.");
if (verifyInstalledSkills) {
  console.log("Installed bridge skills are synchronized across Codex and Claude.");
}
await rm(portableHome, { recursive: true, force: true });
