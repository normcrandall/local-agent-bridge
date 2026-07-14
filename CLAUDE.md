# Claude Code collaboration guidance

Codex is available through the project MCP server named `codex`. Antigravity is available through the project MCP server named `antigravity`.

Prefer the installed collaboration skills as the user-facing interface. Announce the skill and the exact peer or broker it will call before starting:

- Use `/ask-agent` for one bounded handoff or review.
- Use `/run-roundtable` for a persistent multi-agent collaboration.
- Use `/show-collaboration` to inspect, monitor, or resume collaboration history.
- Use `/goal-loop` to build toward explicit completion criteria through bounded plan, implement, review, and verification cycles.
- Use a `/council-*` companion when the user wants an installed AI Hero workflow run by Claude, Codex, and Antigravity together. The original skill remains the single-agent option.

The raw MCP tools are the implementation layer behind these skills. Invoke them directly only when a skill is unavailable or the user explicitly asks for the low-level tool.

For a dialogue hosted in the current Claude Code CLI, use `/agent-dialogue`. Use `./bridge talk "<task>"` only when the user wants a neutral external broker and a standalone JSONL transcript. Do not simulate an unbounded back-and-forth through nested MCP calls.

For a persistent collaboration that can be inspected or resumed from Claude App, Codex App, or Antigravity App, use the `collaboration` MCP server. Start with `start_collaboration`, keep its returned `collaborationId`, poll with `get_collaboration`, answer or begin another phase with `continue_collaboration`, and cancel with `cancel_collaboration`. The call is asynchronous and survives the chair app closing.

Poll with separate `get_collaboration` calls using `detail: status`, `includeTurns: 0`, `afterUpdatedAt`, and `waitSeconds: 8` or less. Never substitute a long-running Bash, sleep, `gh`, or PR polling loop: a blocking shell tool prevents Claude Code from refreshing its status line. Treat `runtime.activeCall.summary` as narrative status and show it with its `summaryAt` age when it changes; `summarySource: broker` is only a placeholder, while `provider_or_adapter` is observed work. Render lifecycle or narrative changes immediately; if only heartbeat or elapsed time changed, emit at most one compact liveness line per 60 seconds. Consult GitHub only after the broker reports a completed turn or terminal state.

- Use the `codex` tool for an independent second opinion, review, or bounded delegated task.
- Use `ask_antigravity` for a bounded Gemini/Antigravity second opinion and `continue_antigravity` only with its returned `conversationId`.
- Start with `sandbox: read-only` for analysis and review.
- For requested implementation, use `sandbox: workspace-write` and `approval-policy: on-request`.
- For browser work, use the project `playwright` MCP tools directly. When handing a browser task to Codex, explicitly ask it to use the project Playwright tools. The Codex app's built-in browser is not available through `codex mcp-server`.
- Give Codex a self-contained prompt with the relevant paths, constraints, and expected output.
- A Claude review delegated through the bridge may run only declared `verificationCommands` and write only its declared `handoffPath`; source edits remain outside review mode, and posting is unavailable unless `githubReview` is explicitly present.
- A Claude work delegation may edit workspace files. `workProfile: implement` covers normal local development through commit; `workProfile: deliver` additionally covers push and bounded PR lifecycle operations. Exact `workCommands` remain additive for unusual tools.
- When `githubReview` is present, the delegated Claude reviewer receives one target-bound PR-review tool backed by the dedicated bot token. It must write the handoff first and publish its own general and inline review comments.
- Continue a session with `codex-reply` and the returned `threadId` when continuity matters.
- Do not ask Codex to invoke Claude. Circular delegation is prohibited.
- Do not ask Antigravity to invoke Claude or Codex. The host or external broker owns participant routing.
- Treat Codex's output as advice until it is verified against the workspace and tests.
- Omit provider model overrides unless the user explicitly requests one; the persistent broker preserves each provider's configured model by default.

For implementation followed by review:

1. Finish the implementation and relevant tests first.
2. Call `codex` with `sandbox: read-only` and ask it to inspect the explicit diff or file list without editing.
3. Require findings ordered by severity with file and line references.
4. Validate each finding locally before changing code.
5. Use `codex-reply` with the original `threadId` for a focused re-review after fixes.
