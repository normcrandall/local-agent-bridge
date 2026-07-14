# Claude Code collaboration guidance

Codex is available through the project MCP server named `codex`. Antigravity is available through the project MCP server named `antigravity`.

Prefer the installed collaboration skills as the user-facing interface. Announce the skill and the exact peer or broker it will call before starting:

- Use `/ask-agent` for one bounded handoff or review.
- Use `/run-roundtable` for a persistent multi-agent collaboration.
- Use `/show-collaboration` to inspect, monitor, or resume collaboration history.
- Use `/goal-loop` to build toward explicit completion criteria through bounded plan, implement, review, and verification cycles.
- Use `/council-discovery` to inspect an existing app and relevant public competitors, reconcile evidence-backed feature proposals from Claude, Codex, and Antigravity, and publish implementation-ready GitHub issues through Wayfinder.
- Use `/council-ux-review` to challenge a rendered application's UI and end-to-end UX with independent browser passes, cross-verification, and prioritized GitHub issues.
- Use a `/council-*` companion when the user wants an installed AI Hero workflow run by Claude, Codex, and Antigravity together. The original skill remains the single-agent option.

The raw MCP tools are the implementation layer behind these skills. Invoke them directly only when a skill is unavailable or the user explicitly asks for the low-level tool.

For a dialogue hosted in the current Claude Code CLI, use `/agent-dialogue`. Use `./bridge talk "<task>"` only when the user wants a neutral external broker and a standalone JSONL transcript. Do not simulate an unbounded back-and-forth through nested MCP calls.

For a persistent collaboration that can be inspected or resumed from Claude App, Codex App, or Antigravity App, use the `collaboration` MCP server. Start with `start_collaboration`, keep its returned `collaborationId`, poll with `get_collaboration`, answer or begin another phase with `continue_collaboration`, and cancel with `cancel_collaboration`. The call is asynchronous and survives the chair app closing.

When this Claude Code session is participating, pass `chair: { provider: "claude", workspace: <absolute workspace> }` so the broker calls only peers and records Claude work with `record_native_chair_turn`; do not create a second Claude session unless the user explicitly requests same-provider delegation. Use `decisionPolicy` for bounded reversible technical choices. Money, legal/compliance, authorization expansion, destructive external actions, and explicit user-owned choices always require the user.

Poll with separate `get_collaboration` calls using `detail: status`, `includeTurns: 0`, `afterUpdatedAt`, and `waitSeconds: 8` or less. Never substitute a long-running Bash, sleep, `gh`, or PR polling loop: a blocking shell tool prevents Claude Code from refreshing its status line. Treat `runtime.activeCall.summary` as narrative status and show it with its `summaryAt` age when it changes; `summarySource: broker` is only a placeholder, while `provider_or_adapter` is observed work. Render lifecycle or narrative changes immediately; if only heartbeat or elapsed time changed, emit at most one compact liveness line per 60 seconds. Consult GitHub only after the broker reports a completed turn or terminal state.

- Use the `codex` tool for an independent second opinion, review, or bounded delegated task.
- Use `ask_antigravity` for a bounded Gemini/Antigravity second opinion and `continue_antigravity` only with its returned `conversationId`.
- Start with `sandbox: read-only` for analysis and review.
- For requested implementation, use `sandbox: workspace-write` and `approval-policy: on-request`.
- For browser work, use the project `playwright` MCP tools directly. When handing a browser task to Codex, explicitly ask it to use the project Playwright tools. The Codex app's built-in browser is not available through `codex mcp-server`.
- Give Codex a self-contained prompt with the relevant paths, constraints, and expected output.
- A Claude review delegated through the bridge may run only declared `verificationCommands` and write only its declared `handoffPath`; source edits remain outside review mode, and posting is unavailable unless `githubReview` is explicitly present.
- A Claude work delegation may edit workspace files. `workProfile: implement` covers normal local development through commit; `workProfile: deliver` additionally covers push and bounded PR lifecycle operations. Exact `workCommands` remain additive for unusual tools.
- When `githubReview` is present, the delegated reviewer receives one target-bound PR-review tool backed by its provider-specific reviewer App. Omit `expectedLogin` to select that identity automatically, or set it to pin a strict bot login. It must write the handoff first and publish its own general and inline review comments.
- When a writer is authorized for PR delivery, pass `githubBuilder` bound to the exact repository, builder App login, head SHA, PR/ref, and explicit `allowedOperations`. Use its tools instead of broad `gh` access; omit `merge` unless the user explicitly authorizes the exact-head merge.
- For chair-owned GitHub operations, try the configured App identity first. If GitHub explicitly denies that App for insufficient permission and PAT fallback is enabled, retry the exact same operation once with the configured PAT, announce the identity change, and record which identity completed it. Do not use fallback to broaden the requested operation or bypass a non-permission failure.
- Continue a session with `codex-reply` and the returned `threadId` when continuity matters.
- Do not ask Codex to invoke Claude. Circular delegation is prohibited.
- Do not ask Antigravity to invoke Claude or Codex. The host or external broker owns participant routing.
- Treat Codex's output as advice until it is verified against the workspace and tests.
- Omit provider model overrides unless the user explicitly requests one; the persistent broker preserves each provider's configured model by default.
- Preserve caller-supplied `modelFallbacks.claude` and `modelFallbacks.codex` across collaboration phases. If omitted, let each adapter use the machine-local policy. Claude Code uses its native fallback option; Codex repeats the original ask and preserves an established continuation thread when applicable. A recognized overload stays within the same turn; show any downgrade narrative and do not mark the provider unavailable or reassign its writer unless the ordered chain is exhausted. Never use model fallback for authentication, permission, quota, configuration, timeout, or transport errors.

For implementation followed by review:

1. Finish the implementation and relevant tests first.
2. Call `codex` with `sandbox: read-only` and ask it to inspect the explicit diff or file list without editing.
3. Require findings ordered by severity with file and line references.
4. Validate each finding locally before changing code.
5. Use `codex-reply` with the original `threadId` for a focused re-review after fixes.
