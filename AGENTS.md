# Codex collaboration guidance

Claude Code is available through the `claude_code` MCP server. Antigravity is available through the `antigravity` MCP server.

Prefer the installed collaboration skills as the user-facing interface. Announce the skill and the exact peer or broker it will call before starting:

- Use `$ask-agent` for one bounded handoff or review.
- Use `$run-roundtable` for a persistent multi-agent collaboration.
- Use `$show-collaboration` to inspect, monitor, or resume collaboration history.
- Use `$goal-loop` to build toward explicit completion criteria through bounded plan, implement, review, and verification cycles.
- Use `$pair-program` for rotating Claude/Codex/Antigravity implementer and reviewer roles with preflight, worktree isolation, CI tracking, budgets, recovery, and formal PR reviews.
- Use a `$council-*` companion when the user wants an installed AI Hero workflow run by Claude, Codex, and Antigravity together. The original skill remains the single-agent option.

The raw MCP tools are the implementation layer behind these skills. Invoke them directly only when a skill is unavailable or the user explicitly asks for the low-level tool.

For a dialogue hosted in the current Codex CLI, use `$agent-dialogue`. Use `./bridge talk "<task>"` only when the user wants a neutral external broker and a standalone JSONL transcript. Do not simulate an unbounded back-and-forth through nested MCP calls.

For a persistent collaboration that can be inspected or resumed from Codex App, Claude App, or Antigravity App, use the `collaboration` MCP server. Start with `start_collaboration`, keep its returned `collaborationId`, poll with `get_collaboration`, answer or begin another phase with `continue_collaboration`, and cancel with `cancel_collaboration`. The call is asynchronous and survives the chair app closing.

Poll compactly: use `detail: status`, `includeTurns: 0`, `afterUpdatedAt`, and a bounded `waitSeconds`. Track `runtime.turnCount`; only when it advances, fetch new completed output once with `detail: full`, a bounded `includeTurns`, and `afterTurn` set to the last displayed turn. Do not repeat the original task or old turn bodies on heartbeat-only polls.

Never substitute a long-running Bash, sleep, `gh`, or PR polling loop for broker polling. Make separate `get_collaboration` calls that return within eight seconds so the host CLI can redraw between heartbeats. Consult GitHub only after the broker reports a completed turn or terminal state.

- Use `ask_claude` for an independent second opinion, review, or bounded delegated task.
- Use `ask_antigravity` for a bounded Gemini/Antigravity second opinion and `continue_antigravity` only with its returned `conversationId`.
- Default to `mode: review`. Use `mode: work` only when the user asked for implementation and concurrent edits will not conflict.
- Set `browser: true` only when the delegated task needs browser interaction. This supplies an isolated Playwright browser, not the Codex app's built-in browser or a signed-in profile.
- Give Claude a self-contained prompt with the relevant paths, constraints, and expected output.
- For Claude review calls, pass exact gates as `verificationCommands` and one project-relative artifact as `handoffPath`; this permits gate execution and that single handoff write while source remains read-only.
- For Claude work calls, choose `workProfile: implement` for local ownership through commit or `workProfile: deliver` when Claude also owns push and pull-request delivery. Use additive exact `workCommands` only for unusual repository-specific tools. Work mode permits file edits but denies commands outside the profile and explicit additions.
- For Codex work calls, use the same profiles: `implement` grants workspace writes with network disabled; `deliver` enables network for authorized push and pull-request delivery.
- Always pass the explicit absolute workspace when starting collaboration. Existing sessions retain their original workspace, writer, and work profile even if the chair CLI later changes directories.
- If repository policy makes the PR the review source of truth, pass `githubReview` with the exact repository, PR number, current head SHA, and required bot login. The delegated Claude, Codex, or Antigravity reviewer must author its handoff and formal review. Claude/Codex use bound tools; Antigravity returns a validated envelope published unchanged by the bound broker adapter. Never repost through a personal GitHub identity.
- Use `continue_claude` only with the returned session ID.
- Do not ask Claude to invoke Codex. The bridge disables nested MCP, and circular delegation is prohibited.
- Do not ask Antigravity to invoke Codex or Claude. The broker owns participant routing.
- Treat Claude's output as advice until it is verified against the workspace and tests.
- Omit provider model overrides unless the user explicitly requests one; the persistent broker preserves each provider's configured model by default.

For implementation followed by review:

1. Finish the implementation and relevant tests first.
2. Ask Claude in `review` mode to inspect the explicit diff or file list without editing.
3. Require findings ordered by severity with file and line references.
4. Validate each finding locally before changing code.
5. Use `continue_claude` for a focused re-review after fixes.
