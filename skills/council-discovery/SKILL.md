---
name: council-discovery
description: Discover valuable new features for an existing application with independent Claude, Codex, and Antigravity analysis, a systematic web-wide competitor and substitute landscape scan, evidence-backed consensus, and implementation-ready GitHub issues through a Wayfinder decision map. Ground every recommendation in customer retention, customer acquisition, maintainability, reduced operating overhead, or increased ROI. Use for product discovery, competitive landscape and feature analysis, roadmap expansion, feature ideation grounded in an existing codebase, or requests asking what an app should build next.
---

# Council Discovery

Find the strongest next features for an existing app. Use Wayfinder as the decision record, keep the three model passes independent until critique, and publish only candidates that survive evidence, business-outcome, duplication, feasibility, and consensus checks.

## Use the five business lenses

Evaluate every enhancement against these outcomes:

1. **Keep customers** — improve activation, successful use, trust, reliability, engagement, renewal, or switching resistance for customers the product should retain.
2. **Win customers** — remove adoption barriers, strengthen differentiation, shorten time-to-value, improve conversion, or reach a valuable new segment.
3. **Improve maintainability** — reduce complexity, fragility, cognitive load, defect risk, or time required to change and operate the product safely.
4. **Reduce overhead** — remove recurring manual work, support burden, infrastructure waste, operational toil, or avoidable delivery cost.
5. **Increase ROI** — increase measurable value or revenue relative to build and ongoing cost, including faster payback and better use of existing capabilities.

Require one primary lens for every candidate and list any secondary lenses. A feature may support multiple lenses, but do not double-count the same benefit. Reject a candidate that cannot make a credible, evidence-backed contribution to at least one lens. Do not invent financial values, conversion rates, churn, or usage data. When measurements are unavailable, state assumptions, use a directional hypothesis, and define the metric needed to validate it.

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
5. Summarize current users, core jobs, strengths, gaps, constraints, known roadmap items, and available signals for retention, acquisition, maintainability, operating overhead, and ROI as the shared evidence packet.

Do not edit product code. This workflow creates planning artifacts and issues only.

## Add competitive evidence when useful

Run a web landscape scan when the product has a public market, even when the user names no competitors. Skip it only for a genuinely private internal tool, a market with no discoverable public alternatives, or when the user explicitly excludes web research; state the reason and coverage loss.

Search broadly before choosing what to compare deeply. Build a discovery pool of at least eight credible products when the market supports it, then shortlist three to six representative products for detailed comparison:

- **Direct competitors** solve the same core job for a similar customer.
- **Adjacent substitutes** solve the job through a different workflow or category.
- **Aspirational benchmarks** demonstrate an unusually effective interaction, operating model, or capability relevant to this product.

Prefer products named by the user, but never stop there. Give the three participants independent search lanes before sharing names:

1. **Category lane** — direct competitors found through category terms, job-to-be-done synonyms, buyer language, comparison searches, and relevant marketplaces or directories.
2. **Substitute lane** — adjacent workflows, manual alternatives, platform features, open-source options, emerging entrants, and products serving the same outcome from another category.
3. **Signal lane** — current reviews, community discussions, support complaints, app-store feedback, changelogs, launch announcements, integration ecosystems, and “alternative to” searches that reveal demand or movement.

Each lane must use at least two materially different query families. Vary user vocabulary, geography, segment, and language when the product scope makes them relevant. Search-result snippets and rankings discover candidates; they are not evidence by themselves.

Merge the independent pools only after all lanes complete. Deduplicate renamed, acquired, white-label, regional, and parent/subsidiary products. Classify every credible candidate and explain exclusions. If fewer than eight credible products exist, retain the smaller pool and list the queries and exclusion reasons rather than padding it with irrelevant names.

Continue discovery until search saturation: two consecutive materially different query families produce no new credible competitor or substitute. Cap the scan when further searching is unlikely to change the representative shortlist; record the uncovered regions, languages, segments, paid surfaces, and authentication boundaries.

Verify shortlisted products through public product surfaces, official documentation, changelogs, pricing, demos, and first-party case studies. Sample independent market signals for each important capability when available. Treat SEO comparison pages, affiliate rankings, anonymous claims, and vendor-authored competitor pages as leads requiring corroboration. Record the URL, publication or update date when visible, access date, plan or edition, geography when relevant, and whether each statement is observed behavior, a vendor claim, or an attributed external signal.

Set `browser: true` for competitive phases so peers can inspect public product experiences in isolated browsers. Do not sign up, purchase, bypass access controls, accept legal terms, scrape prohibited surfaces, or use private credentials without explicit authorization. Pricing, packaging, and product capabilities change; verify them during the run instead of relying on model memory.

Maintain a compact landscape ledger:

```text
Query family: <intent and representative query>
Lane: category | substitute | signal
Candidates found: <names>
Candidate classification: direct | adjacent | benchmark | excluded
Sources checked: <URLs with source type and dates>
Coverage: <segment, geography, language, plan, and access limits>
New information: yes | no
```

For each relevant capability, capture:

- which user job it supports and how the competitor implements the outcome;
- whether our product has an equivalent, a weaker path, a deliberate omission, or a differentiating alternative;
- evidence that the capability is table stakes, a differentiator, or merely vendor positioning;
- switching, adoption, maintenance, operating-cost, and ROI implications;
- what should be learned without copying proprietary expression, content, or visual design.

“A competitor has it” is not evidence that this product should build it. Require a credible customer or business mechanism. Prefer differentiated outcomes over checklist parity; recommend parity only when its absence creates a demonstrated adoption, retention, trust, or interoperability barrier.

## Chart one Wayfinder decision

Name the destination as: an evidence-backed, prioritized feature portfolio that improves customer retention, acquisition, maintainability, operating overhead, or ROI, with implementation-ready GitHub issues for the selected features.

Create one `wayfinder:map` issue using the base template. Create one child decision ticket named for the portfolio question, such as **Choose the next product features**, with:

```markdown
## Question

Which new features should this application build next, based on current product evidence and their ability to keep customers, win customers, improve maintainability, reduce overhead, or increase ROI?
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
Competitive research: off | on (<products>)
Browser: isolated public-product research when competitive research is on
Web landscape: <lanes, candidate count, shortlist count, and saturation status>
Tool: collaboration.start_collaboration
Wayfinder map: <pending or URL>
Decision ticket: <pending or URL>
Issue publisher: chair using configured repository identity
Models: provider configured
```

Return the `collaborationId` immediately. Poll with `detail: status`, `includeTurns: 0`, `afterUpdatedAt`, and `waitSeconds: 8`. Fetch completed output once when `runtime.turnCount` advances. Show changed provider-authored narrative from `runtime.activeCall.summary`; rate-limit heartbeat-only output to one compact line per 60 seconds. Never leave the user at a static “Calling …” message or repeat unchanged summaries. Never substitute a long-running Bash, sleep, `gh`, or PR polling loop for broker polling.

## Run the discovery phases

Give every participant the same baseline packet. Prevent circular delegation. Run these phases in the same persistent collaboration:

### 0. Independent web landscape

When competitive research applies, run the category, substitute, and signal lanes independently. Do not seed one participant with another participant's product list. Consolidate only after each lane returns its queries, candidates, classifications, source types, exclusions, and coverage limits. The chair verifies the shortlist and attaches the landscape ledger to the Wayfinder portfolio resolution.

### 1. Independent proposals

Before seeing peer conclusions, each participant proposes at most five features. Require for each:

- target user and unmet job;
- concrete evidence from the app, repository, tracker, or cited primary research;
- competitive evidence when applicable, labeled as observed behavior, vendor claim, or attributed third-party signal;
- strategic posture: parity, differentiation, substitute response, or deliberate non-adoption;
- user outcome and why the feature belongs in this product;
- primary business lens, secondary lenses, expected mechanism, and metric or proxy;
- directional benefit, implementation and operating cost, and the assumptions behind the ROI hypothesis;
- smallest coherent version;
- likely implementation seams and dependencies, without brittle file-level design;
- primary risk, disconfirming evidence, and how success would be measured.

Novelty alone is not value. Reject generic AI additions, speculative demand, and features already represented in the tracker unless the proposal materially changes the outcome or scope.

### 2. Adversarial critique

Reveal the normalized candidate set only after all independent proposals complete. Have every participant challenge every surviving candidate for:

- duplication or conflict with current behavior and issues;
- cargo-cult parity, stale competitor evidence, or copying that weakens product differentiation;
- a competitor comparison that targets a different user, plan, geography, or job;
- weak or fabricated evidence;
- poor product fit or unclear beneficiary;
- a business-lens claim that lacks a credible mechanism, evidence, or measurable signal;
- likely gains that are outweighed by implementation cost, ongoing cost, or harm to another lens;
- disproportionate complexity, security, privacy, accessibility, or operational cost;
- missing prerequisite decisions;
- a smaller or stronger alternative.

The chair verifies factual claims against the workspace and tracker. Evidence outranks votes.

### 3. Consensus selection

A candidate reaches consensus only when every available participant, after critique, explicitly accepts:

- the problem and beneficiary;
- the evidence that the problem exists;
- when competition is material, the relevance and freshness of the comparison plus the chosen parity or differentiation posture;
- whether the web scan reached the stated pool and saturation threshold, or transparently documented why it could not;
- the primary business lens and credible mechanism connecting the enhancement to that outcome;
- the scoped user outcome;
- feasibility at the proposed size;
- measurable acceptance criteria;
- a validation metric or proxy and a bounded ROI hypothesis without fabricated numbers;
- absence of unresolved blocking objections or duplicate issues.

Resolve reversible technical tradeoffs through the configured decision policy. Ask the user only for money, legal or compliance exposure, missing authorization or credentials, destructive external action, or an explicitly user-owned product choice.

Do not average scores into false agreement. A blocking objection must be resolved with evidence or the feature remains in Wayfinder fog/research; it is not published as ready work. Rank accepted features by primary business outcome, expected magnitude, confidence, time-to-value, implementation cost, ongoing cost, strategic fit, and dependency order. Prefer the smallest feature that creates a measurable outcome. Record material tradeoffs when a gain in one lens may weaken another.

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

## Business outcome

- Primary lens: keep customers | win customers | maintainability | reduce overhead | increase ROI
- Secondary lenses: <none or list>
- Expected mechanism: <how this enhancement creates the outcome>
- Metric or proxy: <how the outcome will be measured>
- ROI hypothesis: <directional benefit, build and ongoing cost, assumptions, and expected time-to-value>

## Competitive context

- Products reviewed: <names, plans or editions, and access dates, or not applicable>
- Landscape coverage: <query lanes, candidate pool, shortlist, saturation, segments, geographies, languages, and access limits>
- Evidence: <links labeled observed behavior, vendor claim, or attributed third-party signal>
- Strategic posture: parity | differentiation | substitute response | deliberate non-adoption
- Why this belongs here: <customer and business mechanism; never only “a competitor has it”>

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

<How product behavior and the stated business outcome will be checked.>

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
3. the web landscape ledger, candidate pool, shortlist, saturation result, and coverage gaps;
4. accepted, rejected, and deferred candidates with evidence, primary business lens, ROI hypothesis, and competitive posture when applicable;
5. consensus level and unavailable providers;
6. every created GitHub issue in dependency order;
7. the portable collaboration ID and terminal status.

The issue tracker is the source of truth. Do not claim completion until the published issues have been read back and verified.
