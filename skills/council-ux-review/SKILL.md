---
name: council-ux-review
description: Challenge the rendered UI and end-to-end user experience of any existing application with independent Claude, Codex, and Antigravity browser reviews, cross-verification, evidence-backed consensus, and prioritized GitHub issues. Use for UX audits, UI critiques, accessibility and responsive reviews, workflow friction discovery, design consistency checks, or requests to find product-experience improvements.
---

# Council UX Review

Audit the application people actually experience. Keep the three reviews independent until critique, reproduce findings before publication, and reject aesthetic preference that lacks a violated UX principle, observable friction, or user and business impact.

## Acknowledge before doing anything else

Your first action after this skill is selected must be a user-visible message. Do not inspect the repository, reason silently, start a server, open a browser, or delegate first. Emit:

```text
UX REVIEW · ORIENTING
Done: review accepted
Now: resolving the application, workspace, journeys, and rendered target
Next: render the application, then start independent council passes
Coverage: 0 journeys; providers not started
Collaboration: pending
```

This receipt proves the native host has actually begun executing the skill. If it never appears, the host model has not produced its first output and no collaboration heartbeat can exist yet. From a normal terminal, the user can bypass that native pre-output gap with `bridge start council-ux-review --workspace <absolute-path> [--url <url>]`; `bridge watchdog --thread latest --watch --notify` can separately alert when a Codex task remains in that pre-first-output state.

## Establish the review target

Resolve the application URL, repository, supported users, core jobs, design system, and issue tracker from the workspace before asking the user. Start a documented local development target when that is a normal safe repository operation; never deploy or alter production.

Read product documentation, routes, UI architecture, accessibility guidance, existing issues, recent UI changes, and available user feedback. Build a compact journey matrix covering the highest-value paths and applicable states:

- first visit, comprehension, onboarding, and activation;
- navigation, search, discovery, and returning-user tasks;
- primary create, edit, purchase, submit, or completion flow;
- loading, empty, validation, error, permission, offline, and success states;
- desktop and narrow mobile viewports;
- keyboard-only use, visible focus, zoom or reflow, labels, contrast, motion, and assistive semantics where observable.

Use provided test accounts or fixtures. Never use a personal signed-in browser profile without explicit authorization. If authentication or unavailable data blocks a journey, record the coverage gap instead of inventing the state.

## Keep the review visible

Milestone updates are mandatory. Send the first user-visible update before repository inspection, server startup, browser work, or delegation. Then update immediately whenever the phase, active participant, completed journey count, coverage, blocker, or next action changes. Never allow more than 60 seconds of active work without a visible update.

Use compact receipts rather than repeating the review brief:

```text
UX REVIEW · <ORIENTING | RENDERING | CHAIR PASS | COUNCIL PASS | VERIFYING | PUBLISHING>
Done: <newly completed evidence or count>
Now: <active participant and concrete activity>
Next: <next observable milestone>
Coverage: <journeys completed/total; desktop/mobile; providers completed/available>
Collaboration: <id once available>
```

Required visible milestones are:

1. orientation started and the target being resolved;
2. application rendered, or the exact rendering blocker and fallback;
3. chair browser pass started and each major journey or viewport completed;
4. collaboration started with its ID and current participant;
5. every peer completion as `PEER FINISHED: <provider> — <one-sentence result>`;
6. cross-verification started and candidate counts accepted, rejected, or unresolved;
7. issue drafting started with the verified finding count;
8. issue publication progress, including `ISSUES · PUBLISHING <current>/<total>`;
9. reread verification completed and the terminal result.

For a long operation with no new narrative, emit one liveness line at the 60-second boundary naming the current phase, active participant or operation, elapsed time, and next expected signal. Do not invent progress, repeat an unchanged narrative card, expose private reasoning, or print every eight-second poll.

## Review the rendered app

Set `browser: true` on the persistent collaboration so delegated agents receive isolated Playwright browsers. The browsers do not share cookies, storage, or tabs; provide repeatable setup steps and seed state to every participant. The chair uses its own available browser tools for its native pass.

If the application cannot be rendered after reasonable diagnosis, continue with a clearly labeled source-only review, publish no finding that depends on unseen visual behavior, and report the missing coverage. Never claim a rendered or accessibility audit from source inspection alone.

Use at least one representative desktop viewport and one narrow mobile viewport. Capture screenshots for spatial or visual findings when supported. For behavioral findings, prefer exact reproduction steps and observed state over screenshots alone.

## Start the council visibly

Use `$run-roundtable`, backed by the persistent `collaboration` MCP. Include Claude, Codex, and Antigravity. Pass the current host as `chair` with its provider and absolute workspace so the chair contributes natively and only peers are delegated. Omit model overrides to preserve the user's configured models and fallback policy, subject to the Claude policy below. Use review mode; no participant edits source code.

Claude model policy: Never select, inherit, or fall back to Fable unless the user's current request explicitly asks for Fable by name. Saved settings, earlier requests, session history, aliases, and caller-supplied fallback chains do not count. Preserve any configured non-Fable Claude model. If the configured or default Claude model resolves to Fable without that permission, override it with `claude-opus-4-8[1m]` and remove Fable from `modelFallbacks.claude`. Announce an explicitly authorized Fable use before starting.

Before starting, display:

```text
COUNCIL UX REVIEW STARTING
Application: <name and URL>
Workspace: <absolute path>
Repository: <owner/repo>
Participants: Claude, Codex, Antigravity
Chair: <provider>
Mode: review; browser enabled; no source writer
Journeys: <summary>
Viewports: <desktop and mobile>
Tool: collaboration.start_collaboration
Issue publisher: chair using configured repository identity
Models: provider configured
```

Return the `collaborationId` immediately. Poll with `detail: status`, `includeTurns: 0`, `afterUpdatedAt`, and `waitSeconds: 8`. Fetch completed output once when `runtime.turnCount` advances. Show changed provider-authored narrative from `runtime.activeCall.summary`; rate-limit heartbeat-only output to one compact line per 60 seconds. Never leave the user at a static “Calling …” message or repeat unchanged summaries. Never substitute a long-running Bash, sleep, `gh`, or PR polling loop for broker polling.

When `runtime.turnCount` advances, announce the completed provider immediately before beginning another poll or chair-side analysis. Fetch that turn once, summarize its new evidence, update the provider completion count, and state the next participant or verification action. A terminal broker status must produce a visible terminal receipt; do not silently move into synthesis.

Require each provider to end its completed turn with one structured `HANDOFF:` JSON receipt containing `outcome`, `summary`, `artifacts`, `verification`, `remaining`, and `nextAction`. Treat the broker's handoff sequence as the completion signal. The chair must independently check the claimed evidence, call `acknowledge_handoff` with that exact sequence, and only then continue the collaboration or report verified completion. Never infer completion solely from silence, a terminal process, a pull request appearing, or an unchanged heartbeat.

## Run independent passes

Give every participant the same journey matrix and evidence packet. Assign distinct primary lenses while requiring everyone to flag critical problems outside their lens:

1. **Task and comprehension advocate** — information architecture, findability, content clarity, onboarding, cognitive load, task efficiency, error prevention, recovery, and user confidence.
2. **Interaction and accessibility advocate** — controls, forms, keyboard and focus behavior, semantics, responsive and touch behavior, state transitions, resilience, and applicable accessibility expectations.
3. **Visual and product advocate** — hierarchy, readability, density, consistency, design-system use, perceived performance, trust, delight, and alignment with retention, acquisition, overhead, and ROI.

Each participant must actually traverse assigned journeys before reporting. Require every candidate finding to contain:

- route, viewport, state, and preconditions;
- minimal reproduction steps;
- expected versus observed experience;
- evidence: screenshot, DOM or accessibility observation, console/network fact, or repeatable behavior;
- affected user and task;
- violated principle, design-system rule, or accessibility expectation;
- severity, frequency or reach, confidence, and business impact;
- smallest outcome-focused correction and how it will be validated.

Do not infer frequency, conversion, churn, or accessibility conformance without evidence. Do not prescribe an implementation merely because the source makes one convenient.

## Challenge and verify

After all independent passes complete, normalize duplicates without erasing distinct evidence. Give the combined list back to every available participant. Require them to:

- reproduce findings outside their own pass;
- challenge severity and user impact;
- distinguish defect, usability improvement, accessibility concern, and visual polish;
- identify false positives caused by seed data, browser isolation, unsupported environments, or personal taste;
- propose a smaller correction when the original scope is excessive;
- check open and recently closed issues for duplicates.

A finding reaches full consensus only when all three participants accept the observation, user impact, severity, and issue scope after challenge. Two participants may establish **degraded consensus**. One participant produces a **single-agent observation**, never consensus. Objective critical findings may survive one dissent when the chair independently reproduces them; preserve the dissent in the issue.

Classify verified findings:

- **P0 — blocked or unsafe:** a core journey cannot complete, data or money is at risk, or the product is unusable for a required access mode.
- **P1 — major friction:** a core journey is likely to fail, mislead, or exclude users.
- **P2 — meaningful improvement:** recurring friction, inconsistency, or comprehension cost with a clear correction.
- **P3 — polish:** limited-scope visual or interaction refinement with defensible user value.

Do not publish speculative findings. Preserve unverified observations in the final report, not as `ready-for-agent` work.

## Publish one issue per outcome

The user invoking this skill authorizes creation of planning issues, not code changes. Exactly one publisher—the chair—creates or updates issues using the repository's configured identity. Prefer a user-configured GitHub App or connector and never embed maintainer-specific identities or credentials. Apply the repository's existing labels; create new UI or UX labels only when repository policy permits it.

Create issues in severity and dependency order. Merge findings only when one correction and one validation plan resolve them together. Split an oversized correction into tracer-bullet issues with explicit blocking links. Apply `ready-for-agent` only when reproduction, expected behavior, and acceptance criteria are complete.

Before the first write, announce the number and order of issues to publish. After each issue creation or update, show its number, title, severity, and remaining count. If publication pauses or fails, identify the exact issue and retain the unpublished drafts instead of leaving the user at the last browser or council status.

Use this issue body:

```markdown
## UX review provenance

- Council: <collaboration id>
- Consensus: full | degraded (<providers>) | single-agent observation (<provider>)
- Severity: P0 | P1 | P2 | P3

## Affected experience

- User and task: <who is trying to do what>
- Route: <URL or route>
- Viewport and state: <dimensions, state, and preconditions>

## Reproduction

1. <minimal step>

## Expected and observed

**Expected:** <outcome>

**Observed:** <evidence-backed behavior>

## Evidence

<screenshot or artifact links and concrete observations>

## Impact

<user consequence, applicable UX or accessibility principle, and business outcome>

## Scope

### In
- <smallest outcome-focused correction>

### Out
- <explicit exclusions>

## Acceptance criteria

- [ ] <observable behavior at named viewport or state>
- [ ] <keyboard, accessibility, responsive, or recovery criterion when applicable>

## Validation

<exact journey and states to retest>

## Dissent or uncertainty

<none, or preserved objection and missing evidence>
```

After publication, reread every issue from GitHub. Verify reproduction steps, evidence links, labels, dependencies, acceptance criteria, and duplicates. The issue tracker is the source of truth.

## Degrade and recover

Preflight all providers. For a confirmed unavailable provider, display `PROVIDER SKIPPED`, its reason, remaining agents, and collaboration ID. Continue with two models or one model and label the evidence level accurately. A timeout or lost transport is indeterminate; inspect or explicitly cancel before assuming failure. A recognized overload uses configured model fallbacks within the same turn.

Do not repeatedly retry an unavailable provider. Stop only when no provider remains, the app cannot be inspected in any defensible form, publishing authorization is absent, or money, legal or compliance, credentials, destructive action, or another explicit authorization boundary requires the user. If publication fails, retain exact issue drafts and receipts so it can resume without repeating the review.

## Finish

Report:

1. journeys, states, viewports, and coverage gaps;
2. each participant's strongest findings and material disagreements;
3. verified findings ordered by severity;
4. rejected or unverified observations and why;
5. created GitHub issues and dependencies;
6. collaboration ID, consensus level, and terminal status.

Do not claim consensus, accessibility conformance, or complete coverage beyond the evidence collected.
