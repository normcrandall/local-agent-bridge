#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

export const councilSkills = [
  {
    base: "grill-me",
    description: "Relentlessly interview and sharpen a plan or design using independent challenges from Claude, Codex, and Antigravity. Use when the user wants the AI Hero grill-me workflow with multiple model perspectives and visible handoffs.",
    kind: "interview",
  },
  {
    base: "grill-with-docs",
    description: "Relentlessly interview a plan or design with Claude, Codex, and Antigravity while preserving the original decision-document workflow. Use when the user wants multi-model grilling plus ADR or glossary capture.",
    kind: "interview",
  },
  {
    base: "decision-mapping",
    description: "Turn a loose idea into a sequenced investigation map using independent Claude, Codex, and Antigravity analysis. Use when decisions, unknowns, and ticket ordering need multi-model challenge.",
    kind: "analysis",
  },
  {
    base: "design-an-interface",
    description: "Generate and compare radically different module interfaces using Claude, Codex, and Antigravity. Use when exploring APIs, module seams, or several competing interface designs.",
    kind: "diverge",
  },
  {
    base: "diagnosing-bugs",
    description: "Diagnose difficult bugs and performance regressions with independent hypotheses from Claude, Codex, and Antigravity while preserving the original evidence-first loop. Use for broken, failing, flaky, or slow behavior.",
    kind: "analysis",
  },
  {
    base: "domain-modeling",
    description: "Build and challenge a domain model with Claude, Codex, and Antigravity while preserving the original terminology and ADR workflow. Use for domain language, boundaries, entities, and architectural decisions.",
    kind: "analysis",
  },
  {
    base: "implement",
    description: "Implement a PRD or issue set with exactly one writing model and independent reviews from the other models. Use when the user wants the AI Hero implement workflow with visible Claude, Codex, and Antigravity collaboration.",
    kind: "execute",
  },
  {
    base: "improve-codebase-architecture",
    description: "Find and compare codebase architecture improvements with Claude, Codex, and Antigravity while preserving the original report and grilling workflow. Use for deepening modules or evaluating architectural seams.",
    kind: "diverge",
  },
  {
    base: "prototype",
    description: "Explore competing prototype directions with Claude, Codex, and Antigravity, then build one with a single writer. Use when a throwaway prototype should test a design or business-logic question.",
    kind: "execute",
  },
  {
    base: "review",
    description: "Review a branch, diff, or pull request independently with Claude, Codex, and Antigravity, then reconcile findings by evidence and severity. Use for cross-model standards and specification review.",
    kind: "analysis",
  },
  {
    base: "tdd",
    description: "Run the original test-driven workflow with one writer and Claude, Codex, and Antigravity peer checkpoints. Use for red-green-refactor work, feature implementation, or bug fixes requiring integration tests.",
    kind: "execute",
  },
  {
    base: "to-issues",
    description: "Break a plan, spec, or PRD into tracer-bullet issues and cross-review the decomposition with Claude, Codex, and Antigravity before publishing. Use when issue boundaries or sequencing need stronger validation.",
    kind: "publish",
  },
  {
    base: "to-prd",
    description: "Synthesize a PRD from the current conversation and cross-review it with Claude, Codex, and Antigravity before publishing. Use when assumptions, requirements, or acceptance criteria need multi-model verification.",
    kind: "publish",
  },
  {
    base: "triage",
    description: "Triage issues or external pull requests with independent Claude, Codex, and Antigravity verification while preserving the original state machine. Use for difficult classification, reproduction, or agent-ready briefs.",
    kind: "analysis",
  },
  {
    base: "ubiquitous-language",
    description: "Extract and reconcile domain terminology with Claude, Codex, and Antigravity before updating the ubiquitous-language glossary. Use for DDD language, ambiguous terms, or canonical naming.",
    kind: "publish",
  },
  {
    base: "edit-article",
    description: "Edit and restructure an article through independent Claude, Codex, and Antigravity passes, then synthesize one coherent revision. Use when prose needs multi-model editorial judgment.",
    kind: "writing",
  },
  {
    base: "writing-shape",
    description: "Shape raw material into an article using competing structures from Claude, Codex, and Antigravity while preserving the original conversational workflow. Use when choosing openings, beats, formats, or narrative direction.",
    kind: "writing",
  },
];

const focusByKind = {
  interview: `Keep the chair in control of the interview. Ask the user exactly one question at a time as required by the base skill. At each major answer, ask the council to identify the strongest unresolved assumption and propose the next question; synthesize those suggestions instead of dumping three interviews on the user. Do not write documents until the base skill permits it.`,
  analysis: `Give every participant the same evidence and require an independent assessment before showing any peer conclusion. Ask them for falsifiable claims, file and line evidence when applicable, and explicit disagreement. Reconcile by evidence rather than majority vote. Preserve every feedback-loop, validation, and user checkpoint in the base skill.`,
  diverge: `Assign each participant a genuinely different design direction and require concrete interfaces, tradeoffs, and failure modes. Keep proposals independent through the divergence phase. Compare them only afterward, preserving meaningful minority options instead of blending everything into a generic compromise.`,
  execute: `Use work mode with exactly one writer. Default the writer to the model corresponding to the chair app unless the user selects another. All other participants remain read-only reviewers. Plan and validate first, let the writer make the change once, then have the other participants inspect the actual diff and test evidence. Never allow concurrent overlapping edits.`,
  publish: `Draft in review mode first. Require all participants to challenge scope, missing acceptance criteria, sequencing, and unsupported assumptions. Show the reconciled draft to the user when the base skill requires confirmation. Only one designated writer may publish or modify the final artifact, and only after the original workflow's authorization gates.`,
  writing: `Ask each participant for a distinct editorial lens: structure, reader clarity, and voice or argument. Preserve the author's intent and require concrete proposed changes. Synthesize one coherent draft; do not concatenate three rewrites or erase deliberate style without explaining the tradeoff.`,
};

function title(value) {
  return value.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function skillMarkdown(skill) {
  const name = `council-${skill.base}`;
  return `---
name: ${name}
description: ${skill.description}
---

# Council ${title(skill.base)}

Apply the installed AI Hero \`${skill.base}\` workflow with a visible three-model council. This is an additive overlay; never edit or replace the original skill.

## Load the base workflow

Read \`~/.agents/skills/${skill.base}/SKILL.md\` completely before acting. Follow every ordering rule, evidence gate, confirmation point, and output contract in that skill. If it is missing, stop and report the missing path instead of improvising a substitute.

## Start visibly

Use \`$run-roundtable\` as the collaboration protocol. If skill composition is unavailable, call the equivalent \`collaboration\` MCP operations directly. Include Claude, Codex, and Antigravity unless the user explicitly excludes one. Pass the current host as \`chair\` with its provider and absolute workspace, keep its work in the native session, and delegate only to peers; same-provider delegation requires an explicit user request. Omit model overrides so every provider uses the model currently configured by the user.

Resolve exact repository gates and a project-relative Claude handoff file, normally under \`.bridge/handoffs/\`. Pass them as \`verificationCommands\` and \`handoffPath\` to every collaboration phase. Claude's review session may run only those gates and write only that handoff file; source edits and arbitrary shell commands remain denied.

When Claude is the designated work-mode writer, select \`workProfile: implement\` for local ownership through commit or \`workProfile: deliver\` when repository policy also assigns push and PR ownership. Use additive exact \`workCommands\` only for unusual repository-specific tools; commands outside the profile and additions remain denied.

Use the same profile distinction for a Codex writer: \`implement\` keeps network disabled and \`deliver\` enables the authorized push/PR lifecycle. Pin every council run to an explicit absolute workspace; changing the chair CLI directory does not migrate stored collaboration state.

For pull-request work, read repository policy. When it requires the reviewer to mirror findings to the PR, resolve the repository, PR number, and current head SHA and pass them as \`githubReview\`. Omit identity fields so the broker selects each provider's user-owned reviewer App from machine-local configuration. Use \`expectedLogin\` or \`expectedLogins\` only when repository policy explicitly pins exact bots. Never embed App IDs, installation IDs, keys, tokens, or maintainer-specific identities in the skill. The designated Claude, Codex, or Antigravity reviewer must author the handoff first, then one formal review with a general verdict and inline actionable findings. Claude/Codex use pre-bound tools; Antigravity returns a validated envelope published unchanged by the bound broker adapter. The writer never receives review publication authority. Refresh the head SHA for each re-review; never fall back to the chair's personal GitHub identity.

Before starting, display:

\`\`\`text
COUNCIL WORKFLOW STARTING
Workflow: ${skill.base}
Participants: Claude, Codex, Antigravity
Mode: <review or work>
Writer: none | <one agent>
Models: provider configured
Tool: collaboration.start_collaboration
Progress: heartbeat every 8 seconds while a peer is working
Progress summary: latest provider-authored summary plus independent process heartbeat
Verification commands: none | <exact commands>
Claude handoff: <project-relative path>
PR review: off | <repository>#<number>@<head SHA> using provider-configured identities | strict pins <bot logins>
\`\`\`

Return the \`collaborationId\` immediately. Routine polls must use \`detail: status\`, \`includeTurns: 0\`, the last \`updatedAt\` as \`afterUpdatedAt\`, and at most \`waitSeconds: 8\`. Track the last displayed \`runtime.turnCount\`; only when it increases, make one history call with \`detail: full\` and \`afterTurn\` set to the last displayed turn. Never repeat the original task or old turn bodies on heartbeat polls. Treat \`runtime.activeCall.summary\` as narrative status and show it with its \`summaryAt\` age when the narrative or lifecycle changes; \`summarySource: broker\` is a placeholder and \`provider_or_adapter\` is observed work. If only heartbeat or elapsed time changes, emit at most one compact liveness line per 60 seconds. Never invent a summary or expose chain-of-thought. Never leave the user at a static “Calling …” message.

Never substitute a long-running Bash, sleep, gh, or PR polling loop for broker polling. A blocking shell watcher prevents the host CLI from redrawing its status line. Make each \`get_collaboration\` call separately and let it return within eight seconds. Poll cadence is not display cadence: never repeat an unchanged narrative card. Check GitHub only after the broker reports a completed turn or terminal state.

## Degrade gracefully

Request all three providers, but do not require all three to proceed. The broker preflights each participant. Remove a provider only after a confirmed failure. A timeout or lost transport is \`indeterminate\`: preserve its writer ownership, block replacement work in that workspace, and require inspection or explicit cancellation. For a confirmed unavailable provider, immediately display:

\`\`\`text
PROVIDER SKIPPED
Provider: <agent>
Reason: <concise error>
Continuing with: <available agents>
Writer: <unchanged or reassigned agent>
Collaboration: <id>
\`\`\`

Do not repeatedly retry an unavailable provider in the same phase. Continue with two models or one model; clearly label the result as degraded rather than full council consensus. If the work-mode writer is unavailable before its next turn, reassign the single-writer role to an available participant and disclose the change. Stop only when no requested provider is available, or when the base workflow itself requires user input.

A recognized model overload is not provider unavailability. Preserve caller-supplied \`modelFallbacks.claude\` and \`modelFallbacks.codex\`, or omit them so machine-local policies apply. Claude Code uses native fallback; Codex retries through the bridge. Keep the same turn and writer, and only treat a provider as unavailable after its ordered chain is exhausted.

## Apply the council pattern

${focusByKind[skill.kind]}

Give participants a self-contained task containing the workspace, base workflow name, current phase, evidence or artifacts, constraints, and expected output. Prevent circular delegation: participants advise or perform their assigned writer role but do not call one another.

## Reconcile and finish

Report:

1. Each participant's completed contribution in one or two sentences.
2. Agreements and unresolved disagreements.
3. Which conclusions survived local evidence or tests.
4. Any mutation made by the single writer.
5. The portable collaboration ID and terminal status.

Do not claim consensus merely because a turn limit was reached. Treat peer output as advice until checked against the workspace and the base skill's completion criteria.
`;
}

function openaiYaml(skill) {
  const name = `council-${skill.base}`;
  return `interface:
  display_name: "Council ${title(skill.base)}"
  short_description: "Run ${skill.base} with a three-model council"
  default_prompt: "Use $${name} with Claude, Codex, and Antigravity for this task."
dependencies:
  tools:
    - type: "mcp"
      value: "collaboration"
      description: "Persistent Claude, Codex, and Antigravity broker"
policy:
  allow_implicit_invocation: true
`;
}

for (const skill of councilSkills) {
  const directory = resolve(root, "skills", `council-${skill.base}`);
  await mkdir(resolve(directory, "agents"), { recursive: true });
  await writeFile(resolve(directory, "SKILL.md"), skillMarkdown(skill));
  await writeFile(resolve(directory, "agents/openai.yaml"), openaiYaml(skill));
}

console.log(`Generated ${councilSkills.length} council skills.`);
