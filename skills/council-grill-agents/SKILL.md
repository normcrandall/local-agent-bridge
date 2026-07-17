---
name: council-grill-agents
description: Cross-examine Claude, Codex, and Antigravity to produce a defensible answer without interviewing the user. Use when a question, plan, design, diagnosis, or recommendation should be pressure-tested through rotating answerer, challenger, and verifier roles until claims are supported, revised, rejected, or explicitly unresolved.
---

# Council Grill Agents

Grill the models, not the user. Turn a loose question or proposed answer into a bounded evidence-driven cross-examination and return the strongest surviving answer with dissent intact.

Keep `council-grill-me` separate: that workflow asks the human one question at a time. This workflow asks peer agents one question at a time and normally requires no human response.

## Frame the examination

Infer the question, decision, constraints, workspace, and desired output from the conversation and repository. State:

- the exact question to resolve;
- what a useful answer must decide or explain;
- known facts and source-of-truth artifacts;
- constraints and unacceptable outcomes;
- the stopping condition and default budget.

Default to at most nine cross-examination questions and twelve completed agent turns. Stop earlier when no material unresolved objection remains. Expand the budget only when the user explicitly asks for a deeper examination.

Resolve reversible technical ambiguity among the agents. Ask the user only for money, legal or compliance exposure, missing authorization or credentials, destructive external action, or an explicitly user-owned choice that evidence cannot decide.

## Start visibly

Use `$run-roundtable`, backed by the persistent `collaboration` MCP. Include Claude, Codex, and Antigravity. Pass the current host as `chair` with its provider and absolute workspace so the chair participates natively and only peers are delegated. Omit model overrides so each provider uses the user's configured model and fallback policy, subject to the Claude policy below. Use review mode unless the user separately authorizes a final artifact mutation.

Claude model policy: Never select, inherit, or fall back to Fable unless the user's current request explicitly asks for Fable by name. Saved settings, earlier requests, session history, aliases, and caller-supplied fallback chains do not count. Preserve any configured non-Fable Claude model. If the configured or default Claude model resolves to Fable without that permission, override it with `claude-opus-4-8[1m]` and remove Fable from `modelFallbacks.claude`. Announce an explicitly authorized Fable use before starting. For that authorized phase only, pass `allowClaudeFable: true` to collaboration or `allowFable: true` to a direct Claude call. Never set either field otherwise; authorization resets on every collaboration continuation.

Enable `browser: true` only when current external evidence or a rendered application is necessary. Give every participant the same self-contained evidence packet. Prevent circular delegation; agents answer the chair and never call one another.

Before starting, display:

```text
COUNCIL AGENT GRILL STARTING
Question: <exact question>
Workspace: <absolute path>
Participants: Claude, Codex, Antigravity
Chair: <provider>
Mode: review; no source writer
Protocol: rotating answerer, challenger, verifier
Budget: <=9 questions; <=12 completed agent turns
Tool: collaboration.start_collaboration
Models: provider configured
Browser: off | isolated
```

Return the `collaborationId` immediately. Poll with `detail: status`, `includeTurns: 0`, `afterUpdatedAt`, and `waitSeconds: 8`. Fetch completed output once when `runtime.turnCount` advances. Show changed provider-authored narrative from `runtime.activeCall.summary`; rate-limit heartbeat-only output to one compact line per 60 seconds. Never leave the user at a static “Calling …” message or repeat unchanged summaries. Never substitute a long-running Bash, sleep, `gh`, or PR polling loop for broker polling.

## Collect sealed opening answers

Before any model sees peer conclusions, require each participant to answer independently with:

1. its proposed answer or decision;
2. the three most important supporting claims;
3. evidence for each claim, citing repository locations or primary sources when available;
4. assumptions and confidence;
5. the strongest counterargument;
6. what evidence would falsify or materially change its position.

Do not request hidden chain-of-thought. Require concise conclusions, evidence, assumptions, and uncertainty.

## Maintain the claim ledger

Normalize the opening answers into a ledger. Do not erase minority positions or merge superficially similar claims.

```text
Claim: <testable statement>
Source: <agent>
Evidence: <artifact or citation>
Assumptions: <explicit assumptions>
Challenge: <strongest unresolved objection>
Status: proposed | supported | revised | rejected | unresolved
Confidence: low | medium | high
Dissent: <agent and concise reason>
```

Verify cheap factual claims directly against the workspace before spending an agent question on them. Use current primary sources for unstable external facts. A citation proves only what the source actually supports.

## Cross-examine one question at a time

Choose the highest-leverage unresolved claim: the one whose failure would most change the answer. For each cycle, assign and rotate three roles:

- **Answerer** defends or revises the claim with evidence.
- **Challenger** asks exactly one specific, falsifiable question targeting its weakest assumption, missing evidence, counterexample, or failure mode.
- **Verifier** checks the evidence, identifies what remains unproven, and recommends the ledger status.

Do not let one provider remain verifier in consecutive cycles when three are available. The chair may occupy any role and records the result after each cycle.

Each question must be answerable and decision-relevant. Ban compound questions, rhetorical attacks, requests for confidence without evidence, and endless restatements. The answerer must answer the question asked before adding qualifications. The challenger may receive one focused follow-up only when the answer introduces a new blocking assumption.

After the answer, give the verifier the exact claim, question, response, and cited evidence. The verifier returns one of:

- **supported** — evidence withstands the challenge;
- **revised** — a narrower or different claim survives;
- **rejected** — the claim fails and must not support the final answer;
- **unresolved** — missing evidence remains material.

Evidence outranks eloquence and majority vote. Update the ledger, then select the next highest-leverage unresolved claim. Do not revisit a settled claim unless new contradictory evidence appears.

## Converge without false consensus

End the grill when:

- every claim necessary to the answer is supported or revised;
- remaining unresolved claims would not change the recommendation and are disclosed; or
- the budget is exhausted.

Full consensus requires explicit acceptance from all three available participants after seeing the surviving answer. Two providers may produce **degraded consensus**. One provider produces a **single-agent conclusion**. Never convert a turn limit, silence, or majority vote into consensus.

If agents disagree, the chair selects the best-supported conclusion when the choice is reversible and records the dissent, confidence, and rollback or validation path. Escalate only at the human-intervention boundaries defined above.

## Produce the answer

Return:

1. **Answer** — the concise conclusion or decision.
2. **Why it survived** — supported claims and decisive evidence.
3. **What changed** — claims revised or rejected during grilling.
4. **Dissent and uncertainty** — unresolved objections, confidence, and missing evidence.
5. **Validation or rollback** — the next check when the answer remains uncertain.
6. **Examination receipt** — participant roles, questions used, budget, consensus level, collaboration ID, and terminal status.

Do not dump the entire transcript unless requested. Summarize each decisive challenge and link to the persistent collaboration history.

By default, make no code, documentation, issue, or pull-request changes. If the user requested a final artifact, wait until the answer is settled, designate exactly one writer or publisher, preserve the claim ledger as provenance, and verify the artifact against the surviving answer.

## Degrade and recover

Preflight all providers. For a confirmed unavailable provider, display `PROVIDER SKIPPED`, its reason, the remaining agents, and collaboration ID. Continue with two models or one model and label the result accurately. Rotate answerer and challenger roles among the available providers; when only one remains, the chair must independently verify claims rather than simulate a debate.

A timeout or lost transport is indeterminate; inspect or explicitly cancel before assuming failure. A recognized overload uses configured model fallbacks within the same turn. Do not repeatedly retry an unavailable provider. Stop only when no provider remains or a human-intervention boundary is reached.
