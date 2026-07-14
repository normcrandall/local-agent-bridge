---
name: council-discovery
description: Discover valuable new features for an existing application with independent Claude, Codex, and Antigravity analysis, reconcile them into evidence-backed consensus, and publish implementation-ready GitHub issues through a Wayfinder decision map. Use for product discovery, roadmap expansion, feature ideation grounded in an existing codebase, or requests asking what an app should build next.
---

# Council Discovery

Find the strongest next features for an existing app. Use Wayfinder as the decision record, keep the three model passes independent until critique, and publish only candidates that survive evidence, duplication, feasibility, and consensus checks.

## Load the governing workflows

Read these installed skills completely before acting:

- `~/.agents/skills/wayfinder/SKILL.md`
- `~/.agents/skills/to-tickets/SKILL.md`

Follow Wayfinder's naming, map, ticket, blocking, frontier, fog-of-war, and one-decision-ticket-per-session rules. Use `to-tickets` only after the feature portfolio decision is resolved; its output is delivery work, not Wayfinder decision tickets. If either skill is missing, report the exact path and continue with the available workflow only, explicitly labeling the degraded result.

## Establish the product baseline

Treat the existing product as evidence, not a blank-page prompt. Before proposing features:

1. Read the product documentation, domain glossary, ADRs, current routes or capabilities, tests, recent history, and architecture boundaries.
2. Inspect open and recently closed issues and pull requests so proposals do not duplicate planned, rejected, or shipped work.
3. Inspect the rendered app when a safe runnable target exists. Use an isolated browser unless the user explicitly authorizes a signed-in profile.
4. Use analytics, feedback, support notes, or research only when present or accessible. Never invent demand, usage, or customer quotes.
5. Summarize current users, core jobs, strengths, gaps, constraints, and known roadmap items as the shared evidence packet.

Do not edit product code. This workflow creates planning artifacts and issues only.

## Chart one Wayfinder decision

Name the destination as: an evidence-backed, prioritized feature portfolio with implementation-ready GitHub issues for the selected features.

Create one `wayfinder:map` issue using the base template. Create one child decision ticket named for the portfolio question, such as **Choose the next product features**, with:

```markdown
## Question

Which new features should this application build next, based on current product evidence, user value, strategic fit, feasibility, and non-duplication?
```

Put uncertain areas that cannot yet be phrased as decisions in **Not yet specified**. Create separate Wayfinder research tickets only for facts that genuinely block the portfolio decision. Do not create one decision ticket per feature: the portfolio selection is the single decision resolved in this session.

## Start the council visibly

Use `$run-roundtable`, backed by the persistent `collaboration` MCP. Include Claude, Codex, and Antigravity. Pass the current host as `chair` with its provider and absolute workspace so the host contributes natively and only peers are delegated. Omit model overrides so each provider uses the user's configured model and fallback policy.

Before starting, display:

```text
COUNCIL DISCOVERY STARTING
Product: <name>
Workspace: <absolute path>
Repository: <owner/repo>
Participants: Claude, Codex, Antigravity
Chair: <provider>
Mode: review; no source-code writer
Tool: collaboration.start_collaboration
Wayfinder map: <pending or URL>
Decision ticket: <pending or URL>
Issue publisher: chair using configured repository identity
Models: provider configured
```

Return the `collaborationId` immediately. Poll with `detail: status`, `includeTurns: 0`, `afterUpdatedAt`, and `waitSeconds: 8`. Fetch completed output once when `runtime.turnCount` advances. Show changed provider-authored narrative from `runtime.activeCall.summary`; rate-limit heartbeat-only output to one compact line per 60 seconds. Never leave the user at a static “Calling …” message or repeat unchanged summaries. Never substitute a long-running Bash, sleep, `gh`, or PR polling loop for broker polling.

## Run the discovery phases

Give every participant the same baseline packet. Prevent circular delegation. Run these phases in the same persistent collaboration:

### 1. Independent proposals

Before seeing peer conclusions, each participant proposes at most five features. Require for each:

- target user and unmet job;
- concrete evidence from the app, repository, tracker, or cited primary research;
- user outcome and why the feature belongs in this product;
- smallest coherent version;
- likely implementation seams and dependencies, without brittle file-level design;
- primary risk, disconfirming evidence, and how success would be measured.

Novelty alone is not value. Reject generic AI additions, speculative demand, and features already represented in the tracker unless the proposal materially changes the outcome or scope.

### 2. Adversarial critique

Reveal the normalized candidate set only after all independent proposals complete. Have every participant challenge every surviving candidate for:

- duplication or conflict with current behavior and issues;
- weak or fabricated evidence;
- poor product fit or unclear beneficiary;
- disproportionate complexity, security, privacy, accessibility, or operational cost;
- missing prerequisite decisions;
- a smaller or stronger alternative.

The chair verifies factual claims against the workspace and tracker. Evidence outranks votes.

### 3. Consensus selection

A candidate reaches consensus only when every available participant, after critique, explicitly accepts:

- the problem and beneficiary;
- the evidence that the problem exists;
- the scoped user outcome;
- feasibility at the proposed size;
- measurable acceptance criteria;
- absence of unresolved blocking objections or duplicate issues.

Resolve reversible technical tradeoffs through the configured decision policy. Ask the user only for money, legal or compliance exposure, missing authorization or credentials, destructive external action, or an explicitly user-owned product choice.

Do not average scores into false agreement. A blocking objection must be resolved with evidence or the feature remains in Wayfinder fog/research; it is not published as ready work. Rank accepted features by user value, confidence, strategic fit, effort, and dependency order.

Full consensus requires all three providers. Two providers may produce **degraded consensus**. One provider may produce a **single-agent recommendation**. Continue with the available providers, but never relabel either degraded state as three-model consensus.

## Resolve Wayfinder and publish delivery issues

Post the consensus portfolio as the decision ticket's resolution comment, close that ticket, and append one linked gist to the map's **Decisions so far**. Preserve rejected candidates and unresolved blockers only where Wayfinder requires them: in the resolution rationale, a research ticket, or **Not yet specified**.

Then convert each accepted feature into delivery work. If a feature fits one agent context, create one GitHub issue. If it is larger, apply the `to-tickets` tracer-bullet and expand-contract rules and create a dependency-linked issue set. Delivery issues are not children of the Wayfinder map; each links back to the map and portfolio decision as provenance.

Use the repository's configured issue-tracker identity. Prefer a user-configured GitHub App or connector; when this bridge's generic App runner is configured, the chair may use it for the exact repository. Never embed or assume maintainer-specific App names, IDs, tokens, or logins. Called agents advise; exactly one publisher—the chair—creates issues, preventing duplicates and identity ambiguity.

Create issues in dependency order. Apply `ready-for-agent` only when no unresolved decision blocks implementation. Use this body:

```markdown
## Discovery provenance

- Wayfinder map: <link>
- Portfolio decision: <link>
- Council: <collaboration id>
- Consensus: full | degraded (<providers>) | single-agent recommendation (<provider>)

## Problem and evidence

<Who has what problem, with links or repository evidence.>

## User outcome

<Externally observable result, not an implementation mechanism.>

## Scope

### In
- <smallest coherent behavior>

### Out
- <explicit exclusions>

## Acceptance criteria

- [ ] <observable, testable behavior>

## Dependencies

- <blocking issue links, or none>

## Validation

<How product behavior and success will be checked.>

## Risks and constraints

<Security, privacy, accessibility, migration, operational, or product risks.>
```

Avoid code snippets and volatile file paths. After creation, reread every issue from GitHub, verify links, labels, blocking edges, and acceptance criteria, and deduplicate once more.

## Degrade and recover

Preflight all providers. For a confirmed unavailable provider, display `PROVIDER SKIPPED`, its reason, the remaining agents, and the collaboration ID. Continue with two models or one model. Treat timeout or lost transport as indeterminate, not unavailable; inspect or explicitly cancel before replacing ownership. Recognized overload uses configured model fallbacks within the same turn and does not remove the provider until its chain is exhausted.

Do not repeatedly retry an unavailable provider. Stop only when no provider remains, publishing authorization is absent, or a required human-intervention boundary is reached. If issue publication fails, retain the resolved Wayfinder decision and return exact issue drafts plus the failure receipt so publication can resume without repeating discovery.

## Finish

Report:

1. the Wayfinder map and resolved portfolio decision;
2. proposals from each provider and the material objections;
3. accepted, rejected, and deferred candidates with evidence;
4. consensus level and unavailable providers;
5. every created GitHub issue in dependency order;
6. the portable collaboration ID and terminal status.

The issue tracker is the source of truth. Do not claim completion until the published issues have been read back and verified.
