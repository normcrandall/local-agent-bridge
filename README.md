# Codex ↔ Claude Code ↔ Antigravity bridge

This project connects the two local coding agents through MCP without API keys or a hosted relay:

- **Claude Code → Codex:** Claude loads `.mcp.json`, which starts Codex's native MCP server and exposes `codex` and `codex-reply`.
- **Codex → Claude Code:** Codex loads `.codex/config.toml`, which starts the local adapter and exposes `ask_claude` and `continue_claude`.
- **Codex or Claude Code → Antigravity:** both load the Antigravity adapter, which exposes `ask_antigravity` and `continue_antigravity`.
- **Antigravity → Codex or Claude Code:** Antigravity's central MCP configuration can start the same Codex and Claude servers.
- **Browser work:** both clients load a project-scoped, isolated Playwright MCP server. This is a shared capability, not a shared browser session.

The adapters shell out to the already-authenticated Claude Code and Antigravity CLIs. Exact Claude session IDs and Antigravity conversation IDs preserve continuity. Delegated prompts prohibit nested peer calls, preventing circular routing; working directories are constrained to this project. Calls from Codex require approval by default.

## Setup

```sh
npm install
npm run install:global
npm run doctor
npm run smoke
```

Then restart/reopen this project in Codex and Claude Code. Approve the project-scoped MCP server when Claude asks.

Restart `agy` as well. Its shared MCP file at `~/.gemini/config/mcp_config.json` now exposes `codex`, `claude_code`, and `collaboration`; use `/mcp` inside Antigravity to inspect their status. This registration is global, while the service deliberately constrains delegated work to this bridge project.

Restart Codex App, Claude App, and Antigravity App after setup. All three are registered with the persistent `collaboration` MCP server. Claude's ordinary Chat surface uses `~/Library/Application Support/Claude/claude_desktop_config.json`; its Code tab uses this project's `.mcp.json`.

Global launchers are installed under `~/.local/bin/agent-{claude,codex,antigravity,collaboration,playwright}-mcp`, with runtime code under `~/.local/share/agent-bridge/runtime` and persistent collaboration state under `~/.local/share/agent-bridge/state`. CLI hosts use their current directory as the allowed workspace. GUI hosts set `AGENT_BRIDGE_WORKSPACE` explicitly because they do not have a reliable project working directory.

Claude CLI registers `codex`, `antigravity`, `collaboration`, and `playwright` at user scope in `~/.claude.json`. Verify that they remain available outside a project with `(cd /tmp && claude mcp list)`. Project `.mcp.json` entries may coexist as team-shareable project defaults; Claude's scope precedence selects the applicable definition.

Codex App and CLI register `claude_code`, `antigravity`, `collaboration`, and `playwright` globally in `~/.codex/config.toml`, pointing at the stable `~/.local/bin/agent-*-mcp` launchers. Verify the user scope outside any project with `(cd /tmp && codex mcp list)`. The global bridge workspace root is the user's home directory so the same servers can operate across projects; narrower trusted-project entries may override it.

## Move the bridge to another computer

The bridge repository is the portable source of truth for its runtime and `council-*` skills. Provider authentication, MCP registrations, the original AI Hero skills, and collaboration history are machine-local.

### 1. Move the repository

Put this directory in a Git repository, copy it with AirDrop or external storage, or transfer it with `rsync`. Preserve executable bits and hidden directories such as `.codex`, `.claude`, and `.agents`.

```sh
git clone <bridge-repository> agent-bridge
cd agent-bridge
```

Do not copy `node_modules`; recreate it on the destination.

### 2. Install and authenticate the providers

Install Node.js, Codex, Claude Code, and Antigravity on the new computer. Launch each provider directly and sign in there. Do not move authentication tokens by copying all of `~/.codex`, `~/.claude`, or `~/.gemini`; those directories contain unrelated machine-local state and may contain credentials.

If reviewer-authored GitHub reviews are required, either configure your own GitHub App as described below or securely provision a dedicated bot token separately at `~/.config/ghtoken`. Restrict static tokens to the user:

```sh
chmod 600 ~/.config/ghtoken
```

Do not commit tokens, GitHub App private keys, or the populated machine-local App config to the bridge repository.

On another computer, generate a new private key for the same App when possible, install the App on the required accounts, rerun the installation discovery command, and recreate the machine-local config. A securely transferred existing key also works, but it must remain outside the repository with mode `600`.

### Optional: use your own GitHub Apps

GitHub Apps give builder and reviewer activity distinct bot identities without storing a long-lived personal access token. This repository does not provide shared hosted identities: the Veliqon Apps used by the maintainers are private infrastructure and are not intended for installation by other users. The checked-in configuration is a generic template; each user creates and installs Apps owned by their own GitHub account or organization and keeps the real IDs and private-key paths under `~/.config/local-agent-bridge`.

The recommended setup for one GitHub account owner is four Apps: one builder plus one reviewer for each provider, for example `your-project-builder`, `your-project-claude-reviewer`, `your-project-codex-reviewer`, and `your-project-gemini-reviewer`. Provider-specific reviewers make the PR history show which model authored each review. A legacy shared reviewer App is supported, but it loses that distinction.

Make each App private by selecting **Only on this account**. A private App can be installed only on the personal account or organization that owns it. If the bridge must work across repositories owned by different accounts, create an owner-local App set for each account and keep their credentials/configuration separate. Select **Any account** only when you deliberately want a public App that other accounts can install. Never instruct users to install the maintainers' Apps or copy the maintainers' App IDs, installation IDs, or keys.

Create each App from **GitHub Settings → Developer settings → GitHub Apps → New GitHub App**:

- Turn off webhooks and OAuth unless another part of your system needs them.
- Select **Only on this account** by default. Treat **Any account** as an explicit public-distribution decision, not a portability shortcut.
- Builder repository permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Issues: Read and write**, and **Metadata: Read-only**. Grant **Workflows: Read and write** only if the builder must intentionally modify workflow files.
- Reviewer repository permissions: **Contents: Read-only**, **Pull requests: Read and write**, **Commit statuses: Read and write**, and **Metadata: Read-only**.
- Generate a private key, move it outside the repository, and restrict it with `chmod 600`.
- Install the App on each account or organization, preferably for selected repositories.

Discover the installation IDs after installing an App:

```sh
npm run github-app:installations -- \
  --app-id YOUR_APP_ID \
  --private-key ~/.config/local-agent-bridge/github-apps/your-app.pem
```

Copy [`config/github-apps.example.json`](config/github-apps.example.json) to `~/.config/local-agent-bridge/github-apps.json`, replace every placeholder, and run:

```sh
chmod 600 ~/.config/local-agent-bridge/github-apps.json
chmod 600 ~/.config/local-agent-bridge/github-apps/*.pem
```

The `installations` keys are GitHub account or organization names and the values are the installation IDs printed by the discovery command. Role selection is based on the repository owner, so one config can cover personal and organization repositories.

The bound PR-review publisher automatically selects `roles.reviewers.claude`, `.codex`, or `.antigravity` for the active reviewer. A legacy singular `roles.reviewer` entry remains supported. It falls back to `~/.config/ghtoken` only when no reviewer App is configured; if a configured App fails authentication, it stops rather than silently posting as another identity.

Identity configuration belongs in the machine-local JSON file, not in a collaboration skill. Skills should normally pass only the repository, PR number, and exact head SHA:

```json
{
  "githubReview": {
    "repository": "owner/repository",
    "prNumber": 123,
    "headSha": "0123456789abcdef0123456789abcdef01234567"
  }
}
```

The broker then selects the active provider's locally configured reviewer App. Use `expectedLogin` for one strict identity, or `expectedLogins.claude`, `.codex`, and `.antigravity` for strict provider-specific pins, only when repository policy requires exact bot names. These fields are policy assertions, not credentials. When moving a skill to another computer or sharing it publicly, leave them out so the receiving user supplies their own identities through `~/.config/local-agent-bridge/github-apps.json`.

The `github-app:run` wrapper may retry an allowlisted issue command or narrowly non-authorizing PR command (`create`, `comment`, `ready`, `close`, or `reopen`) once with `~/.config/ghtoken` when GitHub explicitly rejects the App for insufficient permission. It prints the identity transition, never retries ordinary failures, and never exposes either credential. PAT fallback is categorically blocked for pushes, merges, PR edits/retargeting, formal PR reviews, status/check publication, branch or ruleset changes, arbitrary `gh api`, and unknown commands. Set `GITHUB_APP_ALLOW_PAT_FALLBACK=0` or disable `compatibility.allowPatFallback` to remove the remaining compatibility path. Override the mode-600 token path with `AGENT_BRIDGE_GITHUB_PAT_FILE`.

Set `"compatibility": { "allowPatFallback": false }` in the machine-local config (or `GITHUB_REVIEW_ALLOW_PAT_FALLBACK=0`) when a repository requires App-only identity. This is now the recommended default. The bridge validates the minted installation token's role permissions before exposing any operation: builder requires Contents, Pull requests, and Issues write plus Metadata read; reviewer requires Contents read, Pull requests and Commit statuses write, and Metadata read. Missing roles, owners, repositories, permissions, keys, and identity mismatches fail closed with the affected role named. A legacy PAT reviewer may post only a non-gating `COMMENT`; it cannot `APPROVE`, `REQUEST_CHANGES`, or publish the machine-review status.

To let a real person satisfy the bridge's merge gate, add their GitHub login to the optional machine-local policy:

```json
{
  "mergePolicy": {
    "trustedHumanReviewers": ["your-github-login"]
  }
}
```

These are identities, not credentials. The builder reads the complete paginated GitHub review record directly and accepts only an `APPROVED` review attached to the exact authorized head SHA. An approval on an older commit, a later `CHANGES_REQUESTED` or `DISMISSED` review on that head, an outstanding change request from another trusted human, an unlisted account, or the builder bot's identity does not satisfy the gate. Each installation should list its own maintainers; never publish maintainer-specific logins in a shared skill.

### Enforce agent review without a human-identity bypass

GitHub's required approving-review count is a human collaboration rule: an approval must come from a person with the required repository access. Do not use an owner PAT to turn an agent verdict into that human approval. For repositories where agents have standing merge authority, configure the target branch or ruleset as follows:

1. Require pull requests and all repository CI checks.
2. Set the required human approval count to zero unless the repository genuinely requires a human decision.
3. Require the commit status context `agent-review` on the exact PR head. When several provider-specific reviewer Apps rotate, select any source in GitHub and rely on the builder's configured-reviewer identity check; do not grant Commit statuses write to the builder App.
4. Require conversations to be resolved and prevent administrators/owners and the builder App from bypassing the ruleset.

Every provider-specific reviewer App publishes `agent-review=success` only after its exact-head formal `APPROVE`; `REQUEST_CHANGES` publishes failure and `COMMENT` publishes pending. The bound builder independently requires either that trusted App status or an exact-head `APPROVED` review from a configured `mergePolicy.trustedHumanReviewers` login. GitHub still enforces CI and the ruleset. If a repository keeps a nonzero human approval count, the pipeline pauses until the person actually reviews; it never manufactures that approval through an owner PAT or administrator bypass.

Review publication is preflighted before a delegated PR-review turn. The broker distinguishes model availability from reviewer-App availability, orders publishable reviewers before local-only reviewers, and records the reason whenever an App is unbound or lacks permissions. An unbound model can still complete its read-only review and durable handoff; its output is labeled local-only and cannot claim a formal GitHub review. When no requested reviewer App can publish, the collaboration degrades to local review evidence and explicitly requires an exact-head approval from a configured trusted human. Autonomous skills pass the preferred reviewer and eligible non-writer fallbacks in one roster, so a transport failure advances to another provider without consuming a successful-review turn. Explicit single-provider handoffs remain single-provider and fail visibly rather than silently substituting a peer.

After changing App permissions or installing the Apps on another account, verify the live installation without exposing credentials:

```bash
npm run github-app:verify -- OWNER/REPO
```

`doctor` validates local configuration and key hygiene only; `github-app:verify` mints short-lived installation tokens and checks the actual builder and provider-reviewer permissions accepted for that repository owner.

For a bounded builder-side GitHub CLI command, mint a short-lived repository-scoped token at execution time:

```sh
npm run github-app:run -- builder owner/repository -- gh pr view 123
npm run github-app:run -- reviewer:codex owner/repository -- gh pr view 123
```

Use `reviewer:claude`, `reviewer:codex`, or `reviewer:antigravity` to select a provider-specific reviewer identity. Plain `reviewer` remains available for the legacy singular reviewer configuration. The wrapper injects `GH_TOKEN` and `GITHUB_TOKEN` into only that child process and never prints the token. This authenticates `gh` and tools that honor those variables; it does not replace SSH credentials for a raw `git push`.

### 3. Restore Matt Pocock's original AI Hero skills

The original workflows referenced by this project were created by Matt Pocock for [AI Hero](https://www.aihero.dev/) and are maintained in his [Skills for Real Engineers repository on GitHub](https://github.com/mattpocock/skills). This bridge does not vendor or replace those skills; it adds optional multi-model orchestration around an installed upstream copy.

The council companions load their original workflows from `~/.agents/skills`. For an exact copy of the current selection, transfer the canonical skill store:

```sh
rsync -a ~/.agents/ <new-computer>:~/.agents/
```

Alternatively, install a fresh selection from [Matt's upstream repository](https://github.com/mattpocock/skills) and verify that `~/.agents/skills/grill-me/SKILL.md` and the other originals exist:

```sh
npx skills@latest add mattpocock/skills
```

The upstream installer lets you select skills and target agents interactively. The bridge owns only the `council-*` companions; it does not vendor or silently modify the upstream originals.

### 4. Install the bridge runtime and companion skills

From the transferred repository:

```sh
npm install
npm run install:global
```

This recreates the launchers under `~/.local/bin`, runtime under `~/.local/share/agent-bridge/runtime`, and bridge/council skills for Codex, Claude, Antigravity App, and Antigravity CLI.

### 5. Replace machine-specific paths and register MCP servers

The current project files `.codex/config.toml` and `.mcp.json`, plus GUI MCP configuration, contain absolute paths from the computer where they were generated. Replace the old home and repository paths with the destination paths. Check for leftovers with:

```sh
rg -n '/Users/' .codex/config.toml .mcp.json
```

Re-register or update these machine-local configurations:

- Claude CLI: `~/.claude.json`
- Claude App: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Antigravity: `~/.gemini/config/mcp_config.json`
- Codex: the project `.codex/config.toml` or the destination's global Codex MCP configuration

Each registration should point to the corresponding destination launcher under `~/.local/bin/agent-*-mcp`. GUI registrations must set `AGENT_BRIDGE_WORKSPACE` to the destination repository or intended workspace.

### 6. Verify and restart

```sh
npm run doctor
npm run smoke
npm run test:skills
npm run test:collaboration
```

Restart Codex App, Claude App, Antigravity App, and their CLI sessions after the checks pass.

### Optional: move collaboration history

Portable collaboration records and JSONL transcripts live under `~/.local/share/agent-bridge/state`. Copy that directory only if the history matters. The transcript remains readable, but resuming an old provider session may fail unless that provider's corresponding local conversation state also exists on the new computer. Starting fresh collaborations is safer.

In short: move the repository and `~/.agents`, authenticate providers afresh, run the installer, replace absolute paths, verify, and restart. The remaining portability gap is automatic MCP re-registration; `npm run install:global` does not currently rewrite every application's existing config file.

Nine canonical skills provide the same visible vocabulary in Codex, Claude, and Antigravity:

- `ask-agent`: announce and perform one named peer handoff.
- `run-roundtable`: start and actively monitor a persistent collaboration.
- `show-collaboration`: render status and turn history as a timeline.
- `goal-loop`: build toward verified completion through bounded, resumable council cycles.
- `pair-program`: rotate implementation and review roles with preflight, worktrees, visible progress, recovery, CI, budgets, and review reconciliation.
- `take-the-helm`: give the council operational ownership of a goal or queue, schedule independent issues into parallel worktree lanes, and serialize integration through a bridge-owned merge train.
- `council-discovery`: inspect an existing product and systematically scan competitors and substitutes across the web, reach evidence-backed feature consensus around retention, acquisition, maintainability, overhead, and ROI, then publish implementation-ready GitHub issues through Wayfinder.
- `council-grill-agents`: make the chair cross-examine peer LLM answers through rotating answerer, challenger, and verifier roles without interviewing the user.
- `council-ux-review`: challenge the rendered UI and end-to-end UX with three independent browser reviews, cross-verification, and prioritized GitHub issues.

The installer copies them to `~/.codex/skills`, `~/.claude/skills`, and `~/.gemini/config/skills`; it also installs Antigravity CLI-compatible markdown commands under `~/.gemini/antigravity-cli/skills`. Restart or begin a new session in each app after installation.

Twenty-four additive `council-*` companions bring Claude, Codex, and Antigravity into selected workflows from [Matt Pocock's skills](https://github.com/mattpocock/skills) without changing the originals:

- Planning and design: `council-grill-me`, `council-grill-with-docs`, `council-loop-me`, `council-decision-mapping`, `council-design-an-interface`, `council-domain-modeling`, `council-improve-codebase-architecture`, `council-prototype`, and `council-wayfinder`.
- Engineering and research: `council-diagnosing-bugs`, `council-implement`, `council-research`, `council-review`, `council-tdd`, `council-triage`, and `council-wizard`.
- Artifacts and writing: `council-to-issues`, `council-to-prd`, `council-to-questionnaire`, `council-to-spec`, `council-to-tickets`, `council-ubiquitous-language`, `council-edit-article`, and `council-writing-shape`.

Each companion loads the corresponding original from `~/.agents/skills`, preserves its gates and output contract, then adds independent model passes, one-writer enforcement, a portable collaboration ID, and an eight-second progress heartbeat. The broker preflights providers and skips failures instead of failing the collaboration: three, two, or one available model can finish the phase, with degraded results and writer reassignment shown explicitly. Only zero available providers stops the run. Run the original name for the unchanged single-agent workflow or the `council-` name for the multi-model version.

Example invocations:

```text
$ask-agent --to claude --mode review Review the current diff
/ask-agent --to codex --mode work Implement the approved plan
$run-roundtable --agents claude,codex,antigravity --writer codex Plan, implement, and review this change
/show-collaboration bridge-<uuid>
$goal-loop --writer codex --max-cycles 4 Build the feature and satisfy the verification checklist
$take-the-helm Own this milestone and work every ready issue to its authorized completion boundary
$council-discovery Find and publish the strongest next features for this app
$council-grill-agents Cross-examine the council on whether this architecture will scale
$council-ux-review Challenge the UI and UX of this application
$council-grill-me Stress-test this architecture before we commit
/council-review Review the current branch with all three models
```

Codex uses the `$skill-name` form. Claude and Antigravity expose the same names as slash commands. Each skill prints a receipt before delegation with the selected peer, exact MCP operation, mode, workspace, browser setting, and model behavior, then prints the returned session or collaboration ID and completion state. This keeps a handoff visible instead of making it feel like a black box.

### Deterministic UX-review start and native-turn watchdog

A skill cannot print a heartbeat until the host model produces its first assistant output. If Codex App accepts a task but remains blank before that output, the collaboration broker has not started and has nothing to report. For an operationally deterministic start, launch the workflow from a normal terminal:

```sh
bridge start council-ux-review --workspace /absolute/path/to/repository --url http://127.0.0.1:3000
```

The command starts the durable broker directly, immediately prints its portable collaboration ID, follows lifecycle changes, shows changed provider narrative, and prints every newly completed turn once. Add `--no-follow` to detach after startup. Provider polling remains at eight seconds or less, while unchanged liveness is printed no more than once per minute.

To observe a Codex App or CLI task that may be stuck before its first model output, run:

```sh
bridge watchdog --thread latest --watch --notify
```

The watchdog reads the local Codex task trace and distinguishes `pre-first-output` silence from responsive or terminal work. It can send a macOS notification after the threshold (60 seconds by default); it cannot inject a message into, retry, or change the model of an already running closed-source app turn. Use `--thread <task-id>` to pin a task and `--threshold-seconds <n>` to change the alert boundary.

### Structured completion receipts

Delegated providers end completed turns with a single-line `HANDOFF:` JSON receipt. The broker parses and persists its outcome, summary, artifacts, verification, remaining work, and requested next action as a monotonically numbered handoff. A terminal provider state is therefore not treated as verified completion by itself.

The chair checks the claimed workspace, tests, pull request, or other evidence and calls `acknowledge_handoff` with the exact sequence. Until that acknowledgement is recorded, `continue_collaboration` and native-chair completion receipts are rejected. Status output shows the current handoff sequence, acknowledgement state, and next action, so the caller has a machine-readable and user-visible finish boundary.

## Complete skill catalog

### Bridge-native skills

These skills are supplied by this project and installed across Codex, Claude, and Antigravity.

| Skill | Purpose |
| --- | --- |
| `ask-agent` | Send one bounded task or review to a named peer with a visible handoff receipt. |
| `run-roundtable` | Run and monitor a persistent Claude–Codex–Antigravity collaboration. |
| `show-collaboration` | Display collaboration status, skipped providers, turns, and history. |
| `goal-loop` | Build toward explicit completion criteria through bounded plan, implement, review, fix, and verification cycles. |
| `pair-program` | Rotate one writer and independent reviewers across tasks, worktrees, CI, and formal PR reviews. |
| `take-the-helm` | Autonomously schedule safe parallel issue lanes, arbitrate conflicts, and integrate exact PR heads through a serialized merge train while preserving narrow escalation boundaries. |
| `council-discovery` | Scan the web-wide competitive landscape and publish Wayfinder-backed features grounded in product, market, retention, acquisition, maintainability, overhead, and ROI evidence. |
| `council-grill-agents` | Cross-examine model answers one question at a time and return the strongest evidence-backed conclusion with dissent. |
| `council-ux-review` | Inspect rendered journeys across desktop, mobile, and accessibility states, then publish verified UX issues. |
| `agent-dialogue` | Run a bounded, chair-hosted Codex–Claude dialogue inside the current CLI. The installer publishes it globally to Codex and Claude; Antigravity remains a council participant rather than a dialogue host. |

### Installed Matt Pocock's AI Hero skills and council options

Credit for the original skills belongs to Matt Pocock and the upstream contributors. See [AI Hero](https://www.aihero.dev/) for Matt's work and [mattpocock/skills](https://github.com/mattpocock/skills) for the source repository. The originals live under `~/.agents/skills` and remain unchanged. “Available” means this bridge installs a working `council-*` companion. “Candidate” means the original is installed but the companion has not been built yet. “Single-agent” identifies routing, reference, setup, or mechanical utilities where a council would normally add little value.

| Original skill | What it does | Multi-model option |
| --- | --- | --- |
| `ask-matt` | Routes a request to the appropriate AI Hero workflow. | Candidate: council-aware routing |
| `claude-handoff` | Hands a bounded task directly to Claude Code. | Single-agent routing utility |
| `code-review` | Aliases the review workflow for discoverability. | Covered by `council-review` |
| `codebase-design` | Designs deeper module interfaces, seams, and testable boundaries. | Candidate: `council-codebase-design` |
| `decision-mapping` | Turns a loose idea into sequenced investigation tickets. | Available: `council-decision-mapping` |
| `design-an-interface` | Produces radically different API or module-interface designs. | Available: `council-design-an-interface` |
| `diagnosing-bugs` | Runs an evidence-first diagnosis loop for bugs and regressions. | Available: `council-diagnosing-bugs` |
| `domain-modeling` | Sharpens domain terminology, boundaries, and decisions. | Available: `council-domain-modeling` |
| `edit-article` | Restructures and tightens an article draft. | Available: `council-edit-article` |
| `find-skills` | Finds installable skills for a requested capability. | Single-agent router |
| `git-guardrails-claude-code` | Adds Claude Code hooks that block dangerous Git commands. | Single-agent setup utility |
| `grill-me` | Relentlessly interviews the user to sharpen a plan or design. | Available: `council-grill-me` |
| `grill-with-docs` | Grills a design while maintaining ADRs and a glossary. | Available: `council-grill-with-docs` |
| `grilling` | Provides the underlying stress-test interview workflow. | Covered by `council-grill-me` |
| `handoff` | Compacts a conversation into a document another agent can resume. | Candidate: `council-handoff` |
| `implement` | Implements work from a PRD or issue set. | Available: `council-implement` |
| `improve-codebase-architecture` | Finds architectural deepening opportunities and produces a visual report. | Available: `council-improve-codebase-architecture` |
| `loop-me` | Discovers recurring loops and turns them into implementation-ready workflow specs. | Available: `council-loop-me` |
| `migrate-to-shoehorn` | Mechanically migrates test fixtures to `@total-typescript/shoehorn`. | Single-agent utility |
| `obsidian-vault` | Searches and maintains an Obsidian vault. | Single-agent utility |
| `prototype` | Builds a throwaway prototype to resolve design uncertainty. | Available: `council-prototype` |
| `qa` | Runs conversational QA and files discovered issues. | Candidate: `council-qa` |
| `request-refactor-plan` | Interviews for and publishes a small-commit refactor plan. | Candidate: `council-request-refactor-plan` |
| `research` | Investigates a question against primary sources and writes a cited Markdown artifact. | Available: `council-research` |
| `resolving-merge-conflicts` | Resolves an active merge or rebase conflict. | Candidate: `council-resolving-merge-conflicts` with one writer |
| `review` | Reviews changes against repository standards and the originating specification. | Available: `council-review` |
| `scaffold-exercises` | Creates course exercise, solution, and explainer structures. | Candidate: `council-scaffold-exercises` |
| `setup-matt-pocock-skills` | Configures issue tracking, triage labels, and domain-document conventions. | Single-agent setup utility |
| `setup-pre-commit` | Installs formatting, type-checking, and test hooks. | Single-agent setup utility |
| `setup-ts-deep-modules` | Configures TypeScript deep-module conventions. | Single-agent setup utility |
| `tdd` | Implements features or fixes through red–green–refactor. | Available: `council-tdd` |
| `teach` | Teaches a concept within the current workspace. | Candidate: `council-teach` |
| `to-issues` | Decomposes a plan or PRD into tracer-bullet issues. | Available: `council-to-issues` |
| `to-prd` | Turns the current conversation into a publishable PRD. | Available: `council-to-prd` |
| `to-questionnaire` | Produces an async discovery questionnaire for a knowledgeable recipient. | Available: `council-to-questionnaire` |
| `to-spec` | Synthesizes the current conversation into a specification for the issue tracker. | Available: `council-to-spec` |
| `to-tickets` | Decomposes a plan into tracer-bullet tickets with explicit blocking edges. | Available: `council-to-tickets` |
| `triage` | Moves issues and external PRs through the configured triage state machine. | Available: `council-triage` |
| `ubiquitous-language` | Creates and hardens a DDD-style terminology glossary. | Available: `council-ubiquitous-language` |
| `wayfinder` | Maps and resolves decision tickets for work larger than one agent context. | Available: `council-wayfinder` |
| `wizard` | Authors an interactive Bash guide for manual setup or migrations. | Available: `council-wizard` |
| `writing-beats` | Builds an article as a choose-your-own-path sequence of beats. | Candidate: `council-writing-beats` |
| `writing-fragments` | Interviews for raw claims, vignettes, and ideas before structuring them. | Candidate: `council-writing-fragments` |
| `writing-great-skills` | Provides reference guidance for authoring predictable skills. | Single-agent reference |
| `writing-shape` | Turns notes or fragments into a coherent article structure. | Available: `council-writing-shape` |

### Every currently available council companion

`council-discovery`, `council-grill-agents`, and `council-ux-review` are bridge-native rather than overlays on one upstream skill. Discovery composes Wayfinder and ticket decomposition; agent grilling composes rotating cross-examination and claim verification; UX review composes isolated browser inspection, independent critique, cross-verification, and issue publication.

```text
council-discovery
council-decision-mapping
council-design-an-interface
council-diagnosing-bugs
council-domain-modeling
council-edit-article
council-grill-me
council-grill-agents
council-grill-with-docs
council-implement
council-improve-codebase-architecture
council-loop-me
council-prototype
council-research
council-review
council-tdd
council-to-issues
council-to-prd
council-to-questionnaire
council-to-spec
council-to-tickets
council-triage
council-ubiquitous-language
council-ux-review
council-wayfinder
council-wizard
council-writing-shape
```

Invoke an original for the existing single-agent behavior or add the `council-` prefix for an available multi-model companion. Council skills attempt Claude, Codex, and Antigravity, continue with whatever subset is available, and expose provider skips and progress to the user.

## Persistent collaboration across desktop apps

The collaboration service lets one app start a detached roundtable and another app inspect or continue it using the same provider sessions. The chair app can close while the worker continues.

Ask any configured app:

> Start a persistent collaboration with Claude, Codex, and Antigravity. Claude plans, Codex implements as the only writer, and Antigravity reviews. Use configured models and return the collaboration ID immediately.

The app calls `start_collaboration` and returns an ID such as `bridge-<uuid>`. In another app, ask:

> Get collaboration `bridge-<uuid>` and show its latest turns.

If the agents need a decision or another phase:

> Continue collaboration `bridge-<uuid>` with this answer: <answer>.

The common tools are:

- `start_collaboration`: starts a detached bounded run and returns immediately.
- `get_collaboration`: reads status and recent turns; supports a 30-second long poll.
- `continue_collaboration`: resumes the exact Claude, Codex, and Antigravity sessions.
- `cancel_collaboration`: terminates the detached worker process group, including the active provider adapter.
- `list_collaborations`: finds recent portable IDs.
- `record_native_chair_turn`: records work performed in the current host session without spawning the same provider again.
- `record_decision`: records or escalates a bounded decision receipt.
- `plan_portfolio` / `create_portfolio`: validate a dependency and conflict graph, compute safe execution waves, and create a durable `helm-<uuid>` ledger.
- `get_portfolio` / `list_portfolios` / `update_portfolio_item`: inspect and update revision-controlled issue lanes across host apps.
- `enqueue_portfolio_merge` / `begin_portfolio_merge_validation` / `record_portfolio_merge_validation`: serialize combined-state validation and record conflict arbitration dossiers.
- `authorize_portfolio_merge` / `record_portfolio_merge`: enforce current target and PR head SHAs before a separately authorized GitHub merge, then release newly unblocked work.
- `recover_portfolio_merge_validation` / `refresh_portfolio_target`: release an inspected interrupted validation slot or reconcile an external target advance while invalidating stale combined results.
- `archive_collaboration` / `prune_collaborations`: retain terminal history without leaving live-looking status groups.

State and JSONL transcripts live under `~/.local/share/agent-bridge/state`. A collaboration records provider session IDs, next speaker, agreement streak, selected agents, models, workspace, cumulative turn count, and an `activeCall` record. While a provider works, `activeCall` contains the provider, phase, automatic liveness heartbeat, elapsed time, and latest provider-authored or adapter-observed summary.

### Parallel portfolios and bridge-owned merge trains

`take-the-helm` uses a durable portfolio ledger under `~/.local/share/agent-bridge/state/portfolios`. Each issue declares hard blockers, temporary conflict edges, expected path ownership, exclusive resources, priority, and verification commands. `plan_portfolio` rejects dependency cycles and greedily selects the highest-priority non-conflicting frontier up to `maxParallel`, which defaults to two. A selected issue receives one writer and one isolated worktree; implementation collaborations use distinct providers so one provider is not active in multiple lanes at once. Reviews are scheduled after writer handoffs using providers that did not author the lane.

Passing branch CI or opening a PR does not satisfy a hard dependency that requires merged behavior. Verified PR heads enter the bridge-owned merge train. They stop consuming writer capacity but continue reserving overlapping paths and exclusive resources until merged or repaired. Only one candidate may hold the integration slot. The chair combines the exact PR head with the current target SHA in a disposable worktree, runs the lane and repository integration gates, and records either a current validation or an arbitration dossier. `authorize_portfolio_merge` fails if the target or head changed and does not itself grant merge authority; the configured builder App still requires standing repository authority or explicit authorization for that exact head.

After GitHub merges the authorized PR, `record_portfolio_merge` advances the target SHA, invalidates every remaining combined validation, marks the issue merged, and recomputes the frontier. Textual, structural, semantic, and requirement conflicts use two read-only advocates, a third-model arbiter when available, and exactly one resolution writer. The repaired PR receives a new head, tests, reviews, and queue entry. GitHub remains the source of truth for PRs, reviews, checks, and the final merge while the bridge owns ordering, combined validation, recovery, and conflict decisions.

`get_collaboration` is compact by default: `detail: status` and `includeTurns: 0` omit the original brief, command arrays, preflight data, and completed turn bodies. Poll with `afterUpdatedAt`; when `runtime.turnCount` advances, request new output once with `detail: full`, a bounded `includeTurns`, and `afterTurn`. `runtime.activeCall.summary` is the narrative status, `summaryAt` says when that narrative changed, and `heartbeatAt` independently proves process liveness. `summarySource` distinguishes the broker's initial placeholder from provider-authored or adapter-observed work. A fresh heartbeat never makes an old narrative current.

Make every heartbeat poll a separate `get_collaboration` call with `waitSeconds: 8` or less. Poll cadence and display cadence are deliberately different: show narrative or lifecycle changes immediately, but rate-limit liveness-only output to one compact line per 60 seconds and never repeat an unchanged status card. Do not replace broker polling with one long-running Bash, sleep, `gh`, or PR watcher: host CLIs generally redraw their status UI only after a tool call returns. Check GitHub after the broker reports a completed turn or terminal state.

A timeout or lost transport becomes `indeterminate`, not unavailable. The broker preserves writer ownership and blocks replacement work in that workspace until the user inspects the provider/workspace and explicitly cancels. Only a confirmed provider failure permits removal from the rotation; cancellation terminates the detached process group.

Delegated peer processes inherit a recursion marker. If a participant tries to start or continue another persistent collaboration through its own MCP tools, the nested mutation is rejected; only the active broker routes turns.

When Codex App, Claude Code, or Antigravity is already doing the primary work, pass `chair` with its provider, optional session ID, exact workspace, and exposed capabilities. The broker records that participant as `native-chair` and removes the same provider from delegated agents by default. Set `allowSameProviderDelegation: true` only for an intentional second session. Chair-owned implementation stays in the host; the broker phase calls peers for review, and `record_native_chair_turn` attaches the host's artifact and verification receipt to the same portable history.

For reversible technical uncertainty, enable `decisionPolicy`. Participants may emit a validated `DECISION:` envelope containing alternatives, selection, confidence, dissent, rollback path, and owner. The policy bounds the dialogue and records one concise receipt. Money, legal/compliance, external authorization, destructive/irreversible actions, and explicit user-owned choices always become `needs_user`; repository policy may add escalation categories but can never remove the baseline or expand permissions.

In work mode, `writer` defaults to the starting agent. The designated writer receives edit permissions; every other participant is forced into review mode at both the prompt and provider-tool layers. A workspace lease prevents two persistent work-mode collaborations from editing this project simultaneously. Review-only collaborations may still run concurrently.

Model fields are optional. Omitting them preserves each provider's configured model. Explicit values pass through unchanged.

`modelFallbacks.claude` and `modelFallbacks.codex` are also optional. Omitting them loads the machine-local overload policy; an explicit provider array replaces that policy for the collaboration. Overload retries happen inside one provider turn, so they do not consume another broker turn or trigger writer reassignment.

## Pair-programming operations

Use `$pair-program` when Claude, Codex, and optionally Antigravity should alternate implementation and review across tasks. The installed global `bridge` CLI exposes the operational controls used by that skill:

```bash
bridge capabilities
bridge preflight --workspace /path/to/repo --agents claude,codex --mode work --profile deliver
bridge roles --task 12 --agents claude,codex # --task-number is also accepted
bridge status
bridge recover bridge-<uuid>
bridge archive bridge-<uuid>
bridge prune --older-than-days 30
bridge worktree --workspace /path/to/repo --task task-12 --branch task-12 --base main
bridge ci --workspace /path/to/repo --pr 12
bridge reconcile --reviews reviews.json
bridge usage --id bridge-<uuid> --max-cost 10 --max-tokens 500000
bridge bundle --output ~/agent-bridge-transfer # --destination is also accepted
```

- Role rotation is deterministic but never overrides an explicit writer or transfers an active task.
- Work-mode collaborations can create an isolated task worktree before any provider starts.
- Preflight records provider capabilities, repository state, work profile, branch, and remote readiness.
- Provider capability preflight probes each installed binary and its relevant subcommands, caches by absolute path/version/size/mtime, and builds new-session and resume argv independently. `bridge capabilities` shows the negotiated matrix and whether it came from a live probe or cache; required missing features stop before model invocation and optional flags are omitted.
- Status combines provider heartbeat/summary, writer, branch, PR/CI, and known usage.
- Recovery is inspect-first; marking indeterminate or cancelling requires an explicit flag.
- `ciTracking.prNumber` refreshes hosted checks after completed turns.
- Structured reviews reconcile into accepted, disputed, and rejected evidence rather than majority vote.
- Optional cost, token, and elapsed-time budgets stop after the current turn.
- Portable bundles exclude credentials, tokens, collaboration state, `.git`, `.bridge`, and `node_modules`; authenticate providers fresh on the destination computer.
- Terminal transitions atomically clear active-call and worker metadata. Restart reconciliation never kills a process: it clears proven terminal leftovers, retains ambiguous ownership as `indeterminate`, and explains the safe inspect/cancel path. Archive/prune operations touch terminal records only.

## Let them talk

### Inside either CLI

Start Claude Code in the project and invoke:

```text
/agent-dialogue Review the current diff with Codex and agree on the real defects
```

Claude remains the host and calls one persistent Codex thread up to three times. The complete exchange stays visible in Claude Code.

Start Codex in the project with `codex` and invoke:

```text
$agent-dialogue Review the current diff with Claude and agree on the real defects
```

Codex remains the host and calls one persistent Claude session up to three times. The complete exchange stays visible in Codex.

Antigravity can be the host too. Start `agy` in this project and ask it to use the `codex` or `claude_code` MCP tools for a bounded review or handoff. Keep routing in the host: a delegated peer must not call another peer recursively.

The host CLI is both participant and chair, so this mode is convenient but not perfectly neutral. Use the external broker below when you want deterministic alternation and a separate transcript.

#### Select models and assign roles

Model flags are optional. With no flags, the bridge omits the MCP `model` property and each delegated CLI uses the model from that user's saved provider settings or environment:

```text
/agent-dialogue <task>
$agent-dialogue <task>
```

Use flags only for a one-run override. Values are passed through unchanged, and can be any alias or full model ID available to the corresponding account:

```text
/agent-dialogue --codex-model <codex-model> --claude-model <active-claude-model> <task>
```

```text
$agent-dialogue --claude-model <claude-model> --codex-model <active-codex-model> <task>
```

When the requested host model is not already active, launch or switch it first:

```sh
claude --model <claude-model>
codex -m <codex-model>
```

The peer model override is passed directly through MCP. The host model is selected by its CLI session. A model selected only for an unrelated terminal session is not a saved provider default; pass it explicitly when the bridge starts a separate delegated process.

#### Provider overload fallback

Claude Code and Codex model-capacity failures can fall through an ordered chain inside the same delegated turn without breaking the collaboration or rotating its writer. The caller may pass `fallbackModels` on either provider's direct tools or use `modelFallbacks.claude` and `modelFallbacks.codex` on `start_collaboration` and `continue_collaboration`:

```json
{
  "models": {
    "claude": "claude-opus-4-8",
    "codex": "gpt-5.6-sol"
  },
  "modelFallbacks": {
    "claude": ["claude-opus-4-6", "claude-sonnet-5"],
    "codex": ["gpt-5.6-terra"]
  }
}
```

For a machine-wide default, copy [`config/model-fallbacks.example.json`](config/model-fallbacks.example.json) to `~/.config/local-agent-bridge/model-fallbacks.json` and edit the provider lists. Configured primary models remain unchanged. Claude Code receives its ordered chain through the native `--fallback-model` option. After an explicit Codex overload, a new delegated turn retries from a fresh thread with the original task, while `codex-reply` retains the caller's established thread; both forms repeat the original prompt and tell the fallback to preserve completed workspace work. Passing a provider's `[]` disables the machine policy for one collaboration.

```sh
chmod 600 ~/.config/local-agent-bridge/model-fallbacks.json
```

Codex emits a visible downgrade narrative and records `requestedModel`, selected `model`, `fallbackUsed`, and `attemptedModels` in turn metadata. Claude Code owns its native retry and session continuity while the bridge records the configured fallback policy in turn metadata. Neither path uses model fallback for authentication, permission, quota, configuration, ordinary command failure, timeout, or lost transport. If the Codex chain is exhausted, the final error names every attempted model so the broker can continue with another available provider.

For example, Fable plans, a selected Codex model implements, and Fable reviews:

```sh
claude --model fable
```

```text
/agent-dialogue --claude-model fable --codex-model <codex-model> Fable plans, Codex implements, then Fable reviews: <task>
```

Or a selected Codex model plans, Fable implements, and Codex reviews:

```text
$agent-dialogue --codex-model <active-codex-model> --claude-model fable Codex plans, Fable implements, then Codex reviews: <task>
```

The inverse arrangement also works from Claude Code after selecting Fable with `/model fable`:

```text
/agent-dialogue --codex-model <codex-model> --claude-model fable Codex plans, Fable implements, then Codex reviews: <task>
```

Only the designated implementer receives write access. The planner remains read-only and performs the final review against the diff and verification results.

### External broker

Use the turn broker when you want an actual bounded dialogue rather than a single handoff:

```sh
./bridge talk "Review the current diff together and agree on the real defects"
```

The broker rotates through persistent sessions for the selected agents, prints each turn, and saves a JSONL transcript under `.bridge/conversations/`. Every turn must end with one of three states:

- `CONTINUE`: another turn is useful.
- `AGREED`: the agent believes the result is ready; every selected agent must agree consecutively to stop.
- `NEEDS_USER`: stop and return one concrete decision to you.

The default is six read-only turns. Additional modes are explicit:

```sh
./bridge talk --turns 10 "Stress-test this architecture"
./bridge talk --claude-model <claude-model> --codex-model <codex-model> "Compare approaches"
./bridge talk --agents claude,codex,antigravity "Triangulate this architecture"
./bridge talk --agents codex,antigravity --start antigravity "Review this implementation"
./bridge talk --agents claude,codex,antigravity --antigravity-model "Gemini 3.1 Pro (High)" "Compare approaches"
./bridge talk --work "Implement this task sequentially, then cross-review it"
./bridge talk --browser "Reproduce this UI bug together"
```

`--work` lets the selected agents edit sequentially inside the workspace. `--browser` supplies isolated browser access where the selected CLI supports it. The hard 20-turn maximum prevents unbounded agent loops and surprise usage.

Antigravity model labels are passed through unchanged. If `--antigravity-model` is omitted, `agy` uses the model from the user's Antigravity settings. The same omit-by-default rule applies to Claude and Codex.

Validate model strings and options without invoking either provider. Omitting both flags reports `default`, meaning provider-configured rather than bridge-selected:

```sh
./bridge talk --dry-run --claude-model <claude-model> --codex-model <codex-model> "Task"
```

## Use it

In Codex:

> Ask Claude to independently review the authentication changes. Use review mode and return only actionable findings.

In Claude Code:

> Ask Codex to review this diff in read-only mode and explain any correctness risks.

In either Codex or Claude Code:

> Ask Antigravity to review this plan with the configured model. Use review mode and return only concrete risks.

For a browser task in either client:

> Use the Playwright browser to open the local app, reproduce the reported issue, and return screenshots and exact reproduction steps.

When Codex delegates a browser task to Claude, it calls `ask_claude` with `browser: true`. When Claude delegates one to Codex, it asks the `codex` tool to use the project Playwright MCP tools.

Both agents share the same working tree, so avoid asking both to edit overlapping files at the same time. The durable collaboration rules live in `AGENTS.md` and `CLAUDE.md`.

## Review and handoff protocol

The intended loop is implementer → independent reviewer → implementer:

1. The implementer completes the task and tests.
2. The reviewer receives the objective, acceptance criteria, explicit diff/files, and verification commands.
3. The reviewer runs read-only and reports findings by severity with file/line references.
4. The implementer verifies findings, fixes valid issues, and requests a focused re-review in the same delegated session.

Either agent can also delegate a bounded implementation task in write mode. Give it non-overlapping file ownership and explicit acceptance criteria.

### Reviewer-authored GitHub reviews

When repository policy says the PR is the source of truth, both directions produce reviewer-authored PR history:

- Claude primary → delegated Codex uses the connected GitHub integration.
- Codex primary → delegated Claude receives bound `github_review.write_handoff` and `github_review.submit_pr_review` tools.
- Claude primary → delegated Codex receives the same two bound tools while its source sandbox remains read-only.
- Claude or Codex primary → delegated Antigravity authors a strict handoff/review envelope; the broker validates it and publishes that exact payload through the same target-bound bot adapter because `agy` has no per-session MCP injection.

The caller passes an exact PR authorization object. Omit `expectedLogin` to select the active provider's configured reviewer App automatically:

```json
{
  "githubReview": {
    "repository": "owner/repository",
    "prNumber": 4,
    "headSha": "0123456789abcdef0123456789abcdef01234567"
  }
}
```

The delegated tool mints a short-lived token from the provider-specific reviewer App (`claude`, `codex`, or `antigravity`/Gemini), or reads the backward-compatible `~/.config/ghtoken` fallback when no reviewer App is configured. A caller may still pin `expectedLogin` for a strict single-identity flow. Credentials never enter the prompt, skill, transcript, or MCP response. Before posting it verifies the token login, exact current PR head, and every inline-comment path. The App submits a formal GitHub review (`APPROVE`, `REQUEST_CHANGES`, or `COMMENT`) and an exact-head `agent-review` commit status, records both in the handoff, and uses content markers to avoid duplicate work. A PAT fallback is comment-only and produces no gate. A re-review must refresh `headSha`.

Writer-side PR delivery uses a separate `githubBuilder` authorization bound to one repository, expected bot login, current head SHA, optional PR, and an explicit `allowedOperations` list. Claude and Codex receive only `github_builder` tools; Antigravity returns a validated operation envelope that the broker executes unchanged outside model context. Supported actions are create/update the designated PR, read/reply/resolve exact review threads, mark ready, and merge the exact PR at the exact head SHA. Every mutation rechecks the per-operation allowlist, identity, and head state and returns an idempotent receipt. Before merge, the builder requires either `agent-review=success` on that head from a configured reviewer App or an exact-head approval from a configured trusted human. The default allowlist excludes `merge`; normal goal-loop and pair-program runs stop at a green reviewed PR unless the user explicitly adds `merge` and authorizes the SHA-pinned merge.

## Browser boundary

The Codex/ChatGPT desktop built-in browser cannot be passed through this bridge: it is not available to Codex CLI, and `codex mcp-server` is a CLI surface. The configured Playwright MCP server gives both agents an isolated Chrome instance instead. It does not inherit cookies, accounts, or tabs from the Codex browser or your normal Chrome profile.

## Safety defaults

- Codex prompts before running a Claude bridge tool.
- Claude review delegation uses locked-down `dontAsk` mode: reads are allowed, only declared `verificationCommands` may use Bash, and only one declared `handoffPath` may be written.
- Claude work delegation also uses locked-down `dontAsk` mode. Choose `workProfile: implement` for local development through commit, or `workProfile: deliver` when the repository's one-implementer policy also assigns push and PR creation. Profiles use Claude Code's current `Bash(command:*)` prefix syntax and cover common tests, package managers, checksums, Git, and bounded `gh pr` lifecycle commands. Broad `gh api` and unbound `gh pr merge` access remain excluded. An exact merge command is accepted only as `gh pr merge <number> --<merge|rebase|squash> --match-head-commit <40-character SHA> [--delete-branch]`; the bridge rejects unpinned, cross-repository, or shell-composed variants before Claude starts. Pass another exact `workCommands` entry for an unusual endpoint. Commands outside the profile and exact additions fail immediately instead of prompting or timing out.
- Codex delegation defaults to `sandbox: read-only` with non-interactive permissions. A designated Codex writer uses `workspace-write`; `workProfile: implement` keeps network disabled, while `workProfile: deliver` enables network for the authorized push and bounded PR lifecycle.
- Delegated `codex mcp-server` processes run with an isolated bridge-owned `CODEX_HOME`. The bridge links the existing Codex authentication file, atomically reconciles provider credential rotation, and mirrors only safe model defaults; it does not inherit global MCP servers, plugins, notifications, hooks, project trust entries, app tooling, or skills. This prevents completed collaborations from leaving recursive bridge adapter groups behind while preserving the user-configured model. Requested browser and bound GitHub-review servers are injected as complete, task-scoped definitions.
- An explicit `permissionProfile: yolo` is available only in work mode. It maps to Claude Code permission bypass, Codex `danger-full-access` with approvals disabled, and Antigravity auto-approval without its terminal sandbox. It is never inferred, is recorded in collaboration status/history, and does not apply to reviewers. The default remains `standard`.
- Nested MCP is disabled in delegated Claude sessions.
- Antigravity continuations use the exact `conversationId`, never the global `--continue` shortcut. When supported, a per-call `--log-file` supplies session-bound recovery; older CLIs fall back to the cwd cache and report continuation as best effort.
- Antigravity delegation always uses its terminal sandbox; review maps to `plan`, work maps to `accept-edits`.
- Delegated Claude sessions only receive Playwright when `browser: true`; the browser uses an isolated profile.
- Review mode exposes no general GitHub access. When repository policy explicitly requires reviewer-authored PR feedback, `githubReview` adds one target-bound `submit_pr_review` tool. It obtains a repository-scoped credential from the active provider's configured reviewer App, with the mode-600 `~/.config/ghtoken` available only as an unconfigured-App fallback. Outside model context it verifies the required login, rejects stale head SHAs and paths outside the diff, and idempotently submits one formal review with general and inline comments.
- The bound review publisher cannot push, merge, label, edit issues, access another repository or PR, or use the chair's personal GitHub identity.
- `turnTimeoutSeconds` is a per-model inactivity limit. Provider progress resets that limit, while a fallback chain remains hard-bounded to the limit multiplied by its permitted model attempts (primary plus at most five fallbacks).

## Overrides

- `CLAUDE_BIN`: absolute path to `claude` for the Codex-to-Claude adapter.
- `NODE_BIN`: absolute path to Node.js for the adapter launcher.
- `CODEX_BRIDGE_CODEX_BIN`: absolute path to a working `codex` binary for Claude-to-Codex.
- `AGY_BIN`: absolute path to the Antigravity CLI executable.

The global Codex CLI is installed and verified. The project MCP wrapper also retains the ChatGPT.app-bundled binary as a fallback.
