import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const codexPath = resolve(root, ".agents/skills/agent-dialogue/SKILL.md");
const claudePath = resolve(root, ".claude/skills/agent-dialogue/SKILL.md");
const [codex, claude] = await Promise.all([
  readFile(codexPath, "utf8"),
  readFile(claudePath, "utf8"),
]);

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
assert.match(pairProgram, /provider-specific, user-owned Apps/);

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
for (const term of ["detail: status", "includeTurns: 0", "afterTurn"]) assert.ok(goalLoop.includes(term));
assert.match(goalLoop, /Never substitute a long-running Bash, sleep, gh, or PR polling loop/);

const readme = await readFile(resolve(root, "README.md"), "utf8");
const claudeGuidance = await readFile(resolve(root, "CLAUDE.md"), "utf8");
const codexGuidance = await readFile(resolve(root, "AGENTS.md"), "utf8");
for (const guidance of [claudeGuidance, codexGuidance]) {
  assert.match(guidance, /Never substitute a long-running Bash, sleep/);
  assert.match(guidance, /get_collaboration/);
}
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
assert.equal(councilSkillNames.length, 24);
for (const name of [
  "council-loop-me",
  "council-research",
  "council-to-questionnaire",
  "council-to-spec",
  "council-to-tickets",
  "council-wayfinder",
  "council-wizard",
]) assert.ok(councilSkillNames.includes(name), `Missing newly supported council skill ${name}`);
for (const name of councilSkillNames) {
  const content = await readFile(resolve(root, "skills", name, "SKILL.md"), "utf8");
  assert.match(content, /\.agents\/skills\/.+\/SKILL\.md/);
  assert.match(content, /Claude, Codex, and Antigravity/);
  assert.match(content, /waitSeconds: 8/);
  assert.match(content, /Never leave the user at a static/);
  assert.match(content, /Never substitute a long-running Bash, sleep, gh, or PR polling loop/);
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

console.log("Global bridge skills are synchronized across Codex, Claude, Antigravity App, and Antigravity CLI.");
