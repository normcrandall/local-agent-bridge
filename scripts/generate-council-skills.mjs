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
    base: "loop-me",
    description: "Discover and specify recurring workflows through a stateful interview challenged by Claude, Codex, and Antigravity. Use when the user wants multi-model scrutiny while turning life or work loops into implementation-ready workflow specs.",
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
    base: "research",
    description: "Research a question against primary sources with independent Claude, Codex, and Antigravity investigation, then reconcile the evidence into one cited Markdown artifact. Use when source quality or competing interpretations merit multi-model verification.",
    kind: "analysis",
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
    base: "to-questionnaire",
    description: "Turn a knowledge gap into a decision-ready questionnaire challenged by Claude, Codex, and Antigravity before one writer creates the Markdown artifact. Use when another person holds facts or decisions the user needs to extract asynchronously.",
    kind: "publish",
  },
  {
    base: "to-prd",
    description: "Synthesize a PRD from the current conversation and cross-review it with Claude, Codex, and Antigravity before publishing. Use when assumptions, requirements, or acceptance criteria need multi-model verification.",
    kind: "publish",
  },
  {
    base: "to-spec",
    description: "Synthesize the current conversation into a specification cross-reviewed by Claude, Codex, and Antigravity before one writer publishes it. Use when testing seams, requirements, or implementation decisions need multi-model challenge without restarting the interview.",
    kind: "publish",
  },
  {
    base: "to-tickets",
    description: "Break a plan or specification into tracer-bullet tickets and reconcile blocking edges with Claude, Codex, and Antigravity before one writer publishes them. Use when slice boundaries, sequencing, or expand-contract migrations need multi-model review.",
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
    base: "wayfinder",
    description: "Chart and resolve a large decision map with independent Claude, Codex, and Antigravity investigation while preserving the one-ticket-per-session frontier. Use when a destination spans more than one agent context and the route is still obscured by unresolved decisions.",
    kind: "analysis",
  },
  {
    base: "wizard",
    description: "Design and verify an interactive setup or migration wizard with Claude, Codex, and Antigravity review and exactly one script writer. Use when a human procedure needs precise browser steps, secret handling, confirmations, and a reusable Bash guide.",
    kind: "execute",
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

Use \`$run-roundtable\` as the collaboration protocol. If skill composition is unavailable, call the equivalent \`collaboration\` MCP operations directly. Include Claude, Codex, and Antigravity unless the user explicitly excludes one. Pass the current host as \`chair\` with its provider and absolute workspace, keep its work in the native session, and delegate only to peers; same-provider delegation requires an explicit user request. Omit model overrides so every provider uses the model currently configured by the user, subject to the Claude policy below.

Claude model policy: Never select, inherit, or fall back to Fable unless the user's current request explicitly asks for Fable by name. Saved settings, earlier requests, session history, aliases, and caller-supplied fallback chains do not count. Preserve any configured non-Fable Claude model. If the configured or default Claude model resolves to Fable without that permission, override it with \`claude-opus-5\` and remove Fable from \`modelFallbacks.claude\`. Announce an explicitly authorized Fable use before starting. For that authorized phase only, pass \`allowClaudeFable: true\` to collaboration or \`allowFable: true\` to a direct Claude call. Never set either field otherwise; authorization resets on every collaboration continuation.

Resolve exact repository gates and a project-relative Claude handoff file, normally under \`.bridge/handoffs/\`. Pass them as \`verificationCommands\` and \`handoffPath\` to every collaboration phase. Claude's review session may run only those gates and write only that handoff file; source edits and arbitrary shell commands remain denied. The broker plans verification per provider: Codex, Docker, and Ollama automatically receive a static exact-head review with the commands withheld, while local/full and hosted CI remain separate evidence. Do not manually restart those providers without commands after this downgrade.

When Claude is the designated work-mode writer, select \`workProfile: implement\` for local ownership through commit or \`workProfile: deliver\` when repository policy also assigns push and PR ownership. Use additive exact \`workCommands\` only for unusual repository-specific tools; commands outside the profile and additions remain denied.

Use the same profile distinction for a Codex writer: \`implement\` keeps network disabled and \`deliver\` enables the authorized push/PR lifecycle. Pin every council run to an explicit absolute workspace; changing the chair CLI directory does not migrate stored collaboration state.

For pull-request work, read repository policy. When it requires the reviewer to mirror findings to the PR, resolve the repository, PR number, and current head SHA and pass them as \`githubReview\`. Omit identity fields so the broker selects each provider's user-owned reviewer App from machine-local configuration. Use \`expectedLogin\` or \`expectedLogins\` only when repository policy explicitly pins exact bots. Never embed App IDs, installation IDs, keys, tokens, or maintainer-specific identities in the skill. The designated Claude, Codex, or Antigravity reviewer must author the handoff first, then one formal review with a general verdict and inline actionable findings. Claude/Codex use pre-bound tools; Antigravity returns a validated envelope published unchanged by the bound broker adapter. The writer never receives review publication authority. Refresh the head SHA for each re-review; never fall back to the chair's personal GitHub identity.

For an autonomous PR-review leg, keep all eligible non-writer providers in one ordered roster and set \`maxTurns\` to the number of successful reviews required. A failed provider does not consume a turn. The broker preflights reviewer-App publication, runs publishable identities first, and treats an unbound reviewer as local-only rather than discarding its model review. If every App is unavailable, preserve the durable local findings and require an exact-head approval from a configured trusted human instead of terminating. Use a single candidate only when the user explicitly pins that provider.${skill.base === "review" ? `

When adding a local reviewer, use Docker Model Runner whenever it is available. Ollama is an availability fallback only and must be suppressed while Docker preflight is healthy. Both are hard review-only, receive no verification commands, and produce non-authorizing advisory review history only.` : ""}

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

For a declared native chair, treat terminal \`coordinatorWake\` as the durable resume signal. Fetch the new turn, perform its \`nextAction\`, then call \`acknowledge_coordinator_wake\` with the exact sequence before another phase or native-chair receipt. Stop/AfterAgent hooks hold the coordinator open while actionable work remains and SessionStart restores missed wakes. Never acknowledge without processing. Let \`needs_user\` and \`indeterminate\` stop because they are protected boundaries.

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

A recognized model overload is not provider unavailability. Preserve caller-supplied \`modelFallbacks.claude\` only after applying the Claude model policy above, and preserve \`modelFallbacks.codex\`; otherwise omit them so machine-local policies apply. Claude Code uses native fallback; Codex retries through the bridge. Keep the same turn and writer, and only treat a provider as unavailable after its ordered chain is exhausted.

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
