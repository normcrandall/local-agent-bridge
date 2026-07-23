# Codex ↔ Claude Code ↔ Antigravity ↔ local model bridge

This project connects cloud coding agents and an optional local reviewer through MCP without a hosted relay:

- **Claude Code → Codex:** Claude loads `.mcp.json`, which starts Codex's native MCP server and exposes `codex` and `codex-reply`.
- **Codex → Claude Code:** Codex loads `.codex/config.toml`, which starts the local adapter and exposes `ask_claude` and `continue_claude`.
- **Codex or Claude Code → Antigravity:** both load the Antigravity adapter, which exposes `ask_antigravity` and `continue_antigravity`.
- **Antigravity → Codex or Claude Code:** Antigravity's central MCP configuration can start the same Codex and Claude servers.
- **Any host → local Docker Model Runner or Ollama reviewer:** the review-only adapters expose `ask_docker`/`continue_docker` and `ask_ollama`/`continue_ollama` with bounded repository-inspection tools. Docker has strict priority: Ollama rejects status, start, and continuation calls whenever the selected Docker reviewer route is healthy. Neither can write, run shell commands, browse, commit, push, or become a writer.
- **Browser work:** both clients load a project-scoped, isolated Playwright MCP server. This is a shared capability, not a shared browser session.

The adapters shell out to the already-authenticated Claude Code and Antigravity CLIs. Exact Claude session IDs and Antigravity conversation IDs preserve continuity. Delegated prompts prohibit nested peer calls, preventing circular routing; working directories are constrained to this project. Calls from Codex require approval by default.

## Setup

```sh
npm install
docker desktop enable model-runner --tcp 12434
docker model pull ai/qwen3.6
# Optional secondary local backend:
ollama pull qwen3.6
npm run install:global
npm run doctor
npm run smoke
```

Then restart/reopen this project in Codex and Claude Code. Approve the project-scoped MCP server when Claude asks.

Restart `agy` as well. Its shared MCP file at `~/.gemini/config/mcp_config.json` now exposes `codex`, `claude_code`, `ollama`, `docker`, and `collaboration`; use `/mcp` inside Antigravity to inspect their status. This registration is global, while the service deliberately constrains delegated work to the selected workspace.

Restart Codex App, Claude App, and Antigravity App after setup. All three are registered with the persistent `collaboration` MCP server. Claude's ordinary Chat surface uses `~/Library/Application Support/Claude/claude_desktop_config.json`; its Code tab uses this project's `.mcp.json`.

Global launchers are installed under `~/.local/bin/agent-{claude,codex,antigravity,ollama,docker,collaboration,playwright}-mcp`, with runtime code under `~/.local/share/agent-bridge/runtime` and persistent collaboration state under `~/.local/share/agent-bridge/state`. CLI hosts use their current directory as the allowed workspace. GUI hosts set `AGENT_BRIDGE_WORKSPACE` explicitly because they do not have a reliable project working directory.

Global upgrades are staged and dependency-validated before the active runtime directory is replaced. If the machine supervisor is running, the installer refreshes only that supervisor process and waits for the replacement to adopt its live workers; it never terminates the workers. Active app MCP processes still require the documented app/CLI restart to load other updated server modules.

Claude CLI registers `codex`, `antigravity`, `ollama`, `docker`, `collaboration`, and `playwright` at user scope in `~/.claude.json`. Verify that they remain available outside a project with `(cd /tmp && claude mcp list)`. Project `.mcp.json` entries may coexist as team-shareable project defaults; Claude's scope precedence selects the applicable definition.

Codex App and CLI register `claude_code`, `antigravity`, `ollama`, `docker`, `collaboration`, and `playwright` globally in `~/.codex/config.toml`, pointing at the stable `~/.local/bin/agent-*-mcp` launchers. Verify the user scope outside any project with `(cd /tmp && codex mcp list)`. The global bridge workspace root is the user's home directory so the same servers can operate across projects; narrower trusted-project entries may override it.

Global setup also installs coordinator lifecycle hooks without replacing existing hook groups: Claude Code `Stop` and `SessionStart`, Codex `Stop` and `SessionStart`, and Antigravity/Gemini `AfterAgent` and `SessionStart`. The hooks inspect durable collaboration state, hold a native coordinator open while delegated work or an actionable completion remains, and restore an unprocessed wake after restart. They deliberately allow `needs_user` and `indeterminate` boundaries to stop.

Claude Code additionally receives the `collaboration_wake` MCP Channel. During the Channels research preview, start Claude with `claude-collab` instead of `claude` to receive live collaboration completion events inside the current session. Ordinary Claude sessions still receive the Stop/SessionStart safety hooks. Restart active Codex, Claude, and Antigravity sessions after `npm run install:global`.

### Local Docker Model Runner reviewer (preferred)

Docker Model Runner is the preferred local review backend. It is opt-in, independent from Ollama, and protected by the same hard review-only boundary. Docker Desktop 4.40+ on macOS supports Model Runner; enable host-side TCP access, pull a coding model, then copy the machine configuration:

```sh
docker desktop enable model-runner --tcp 12434
docker model pull ai/qwen3.6
mkdir -p ~/.config/local-agent-bridge
cp config/docker-model-runner.example.json ~/.config/local-agent-bridge/docker-model-runner.json
chmod 600 ~/.config/local-agent-bridge/docker-model-runner.json
```

The adapter uses Docker's documented Ollama-compatible loopback API at `http://127.0.0.1:12434`; `DOCKER_MODEL_RUNNER_MODEL` and `DOCKER_MODEL_RUNNER_HOST` are explicit machine overrides. Non-loopback endpoints are rejected because Docker Model Runner's local API is unauthenticated. Use `agents: ["docker"]` for local review. A mixed `docker`/`ollama` roster is safe because Ollama preflight reports unavailable while the selected Docker reviewer route is healthy. The MCP exposes `ask_docker`, durable `continue_docker`, and `get_docker_status`; state is stored owner-only under `~/.local/state/local-agent-bridge/docker-sessions`.

The machine supervisor keeps the selected local route warm. It preloads Docker with `docker model run --detach` every four minutes; only when Docker preflight fails does it send Ollama an empty generation request with `keep_alive: "30m"`. Set `AGENT_BRIDGE_KEEP_MODELS_WARM=0` to disable this, `AGENT_BRIDGE_MODEL_WARM_INTERVAL_MS` to change the interval, or `AGENT_BRIDGE_LOCAL_MODEL_KEEP_ALIVE` to change the Ollama residency request. `bridge supervisor status` exposes the latest `modelWarmth` result. A successful Docker preflight retains Docker priority even if its optional preload command fails.

Docker receives only bounded repository-state, file-read, literal-search, and Git-diff tools. It receives no shell, browser, verification-command, source-write, builder, commit, push, or merge capability. Both `APPROVE` and `REQUEST_CHANGES` publish only as non-authorizing PR comments during evaluation, so Docker contributes review evidence without unlocking or blocking a merge gate. Configure fallbacks under `providers.docker.fallbackModels` and disable a model machine-wide with `bridge models disable docker <model>`.

### Local Ollama reviewer (secondary)

Ollama is a review-only availability fallback. Its status, start, and continuation tools first probe the configured Docker reviewer and fail closed while Docker is healthy; selecting Ollama explicitly does not bypass this machine policy. Qwen 3.6 is the primary local-review model on both runtimes; Gemma remains a later model fallback for comparative evaluation. Configure the model and loopback endpoint by copying [`config/ollama.example.json`](config/ollama.example.json) to `~/.config/local-agent-bridge/ollama.json`; if the file is absent, the bridge uses `qwen3.6:latest` at `http://127.0.0.1:11434`. `OLLAMA_MODEL` and `OLLAMA_HOST` are explicit machine overrides. This release rejects non-loopback endpoints.

```sh
mkdir -p ~/.config/local-agent-bridge
cp config/ollama.example.json ~/.config/local-agent-bridge/ollama.json
chmod 600 ~/.config/local-agent-bridge/ollama.json
ollama pull qwen3.6
```

Use `agents: ["ollama"]` only when Docker Model Runner is unavailable, or include both local providers and let preflight suppress Ollama whenever Docker is healthy. In work mode, choose Claude, Codex, or Antigravity as the writer; schema and runtime guards prevent Ollama from being selected or promoted as writer. The local model receives only bounded read-only repository tools. It receives no shell, browser, source-write, builder, commit, push, or merge capability, and `verificationCommands` remain unavailable.

The adapter emits progress when the model inspects repository state, files, searches, or diffs. Conversation state is stored owner-only under `~/.local/state/local-agent-bridge/ollama-sessions`, keyed by the canonical workspace path, so `continue_ollama` preserves context when its MCP process restarts. Configure ordered memory/capacity fallbacks under `providers.ollama.fallbackModels` in [`config/model-fallbacks.example.json`](config/model-fallbacks.example.json). During the initial evaluation period, Ollama `APPROVE` and `REQUEST_CHANGES` verdicts are both published as non-authorizing PR `COMMENT` reviews, never as `agent-review=success`; inline findings and the original local verdict remain visible. This allows real review history without letting an unevaluated local model independently unlock or block a merge.

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

Provider call concurrency is machine-local. The built-in default permits five live work calls and ten concurrent read-only review calls per provider. To customize it:

```sh
mkdir -p ~/.config/local-agent-bridge
cp config/provider-concurrency.example.json ~/.config/local-agent-bridge/provider-concurrency.json
chmod 600 ~/.config/local-agent-bridge/provider-concurrency.json
```

Use self-contained writer checkouts and non-conflicting issue claims when multiple implementation sessions run concurrently. Each writer owns a private `.git`; review sessions remain read-only and may use lightweight linked worktrees with exact-head GitHub authorization, so the larger review pool can drain review-ready work without blocking writers. A work-mode delegation that targets an existing self-contained checkout adopts its contained Git metadata and grants that exact directory to the writer sandbox, including on continuation. An existing linked worktree is rejected before provider launch because safely committing would require access to another checkout's shared Git metadata; create a private writer checkout or recover the stopped lane first.

Claimed private-repository work is hydrated before provider launch. The broker reads the bound issue and non-lease comments through the builder App, excludes its own claim-status comment, and appends a bounded immutable snapshot to the writer task. Authoritative triage priority is limited to the issue author and repository owners, members, or collaborators; other comments remain visible as untrusted input. If the bounded snapshot omits content, its visible trailer directs the writer to request the remainder from the chair instead of silently proceeding or using ambient credentials. Hydration is intentionally limited to the one claimed issue, so parent, blocker, and prior-attempt context must be supplied by the chair. If the snapshot cannot be fetched, startup fails before a model receives the task or a claim is published.

On another computer, generate a new private key for the same App when possible, install the App on the required accounts, rerun the installation discovery command, and recreate the machine-local config. A securely transferred existing key also works, but it must remain outside the repository with mode `600`.

### Optional: use your own GitHub Apps

GitHub Apps give builder and reviewer activity distinct bot identities without storing a long-lived personal access token. This repository does not provide shared hosted identities: the Veliqon Apps used by the maintainers are private infrastructure and are not intended for installation by other users. The checked-in configuration is a generic template; each user creates and installs Apps owned by their own GitHub account or organization and keeps the real IDs and private-key paths under `~/.config/local-agent-bridge`.

The recommended setup for one GitHub account owner is four Apps: one builder plus one reviewer for each provider, for example `your-project-builder`, `your-project-claude-reviewer`, `your-project-codex-reviewer`, and `your-project-gemini-reviewer`. Provider-specific reviewers make the PR history show which model authored each review. A legacy shared reviewer App is supported, but it loses that distinction.

Make each App private by selecting **Only on this account**. A private App can be installed only on the personal account or organization that owns it. If the bridge must work across repositories owned by different accounts, create an owner-local App set for each account and keep their credentials/configuration separate. Select **Any account** only when you deliberately want a public App that other accounts can install. Never instruct users to install the maintainers' Apps or copy the maintainers' App IDs, installation IDs, or keys.

Create each App from **GitHub Settings → Developer settings → GitHub Apps → New GitHub App**:

- Turn off webhooks and OAuth unless another part of your system needs them.
- Select **Only on this account** by default. Treat **Any account** as an explicit public-distribution decision, not a portability shortcut.
- Builder repository permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Issues: Read and write**, and **Metadata: Read-only**. Grant **Workflows: Read and write** only if the builder must intentionally modify workflow files.
- Reviewer repository permissions: **Contents: Read-only**, **Pull requests: Read and write**, and **Metadata: Read-only**. These permissions are sufficient for the App to submit a formal exact-head PR review.
- **Commit statuses: Read and write** is optional. Add it only when a repository explicitly requires the `agent-review` commit-status context. After changing an installed App's permissions, approve the installation's requested permission update for every personal account or organization where it is installed; changing the App definition alone does not upgrade existing installation tokens.
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

Set `"compatibility": { "allowPatFallback": false }` in the machine-local config (or `GITHUB_REVIEW_ALLOW_PAT_FALLBACK=0`) when a repository requires App-only identity. This is now the recommended default. The bridge validates the minted installation token's role permissions before exposing any operation: builder requires Contents, Pull requests, and Issues write plus Metadata read; reviewer requires Contents read, Pull requests write, and Metadata read. Missing roles, owners, repositories, permissions, keys, and identity mismatches fail closed with the affected role named. A reviewer without Commit statuses write still publishes its formal review; the verifier prints a warning that `agent-review` publication is unavailable. A legacy PAT reviewer may post only a non-gating `COMMENT`; it cannot `APPROVE`, `REQUEST_CHANGES`, or publish the machine-review status.

To let a real person satisfy the bridge's merge gate, add their GitHub login to the optional machine-local policy:

```json
{
  "mergePolicy": {
    "trustedHumanReviewers": ["your-github-login"],
    "autonomousMergeRepositories": ["your-account/*", "your-organization/*"]
  }
}
```

These are policies, not credentials. `trustedHumanReviewers` lists people whose exact-head approval may satisfy the builder gate. `autonomousMergeRepositories` grants native coordinators standing authority to call the broker's exact-head `merge_pull_request` tool for one repository or an owner's repositories using `owner/*`; omit it to require a user-owned merge action. The builder reads the complete paginated GitHub review record directly and accepts only an `APPROVED` review attached to the exact authorized head SHA. An approval on an older commit, a later `CHANGES_REQUESTED` or `DISMISSED` review on that head, an outstanding change request from another trusted human, an unlisted account, or the builder bot's identity does not satisfy the gate. Each installation should list its own maintainers; never publish maintainer-specific logins in a shared skill.

### Choose an opt-in GitHub merge-enforcement tier

Paid GitHub protection features are not required. The portable default keeps merge authorization in the bridge:

```json
{
  "github": {
    "mergeEnforcement": "broker"
  }
}
```

Choose one machine-local mode:

| Mode | Behavior |
| --- | --- |
| `broker` | Default. The bridge requires exact-head review and authorizes the exact merge locally. GitHub does not independently require the agent-review gate; workflows must verify any CI that is not protected by GitHub. |
| `branch-protection` | Require repository branch protection whose `agent-review` check is bound to a configured reviewer App ID. The builder App needs optional **Administration: Read-only** so the bridge can verify this protection before merging. |
| `organization-ruleset` | Require an active organization ruleset whose `agent-review` check is bound to a configured reviewer App ID. Organization-level rulesets currently require GitHub Team or Enterprise. |
| `auto` | Inspect the pull request's base branch and select organization ruleset, then branch protection, then broker. Every downgrade is included in the merge receipt and doctor report. |

Explicit GitHub modes fail closed when their App-bound check cannot be verified. `auto` is the only mode that downgrades, and it never treats an unbound check name as trusted. A selected reviewer App must have **Commit statuses: Read and write** to publish the required `agent-review` context. These modes inspect existing GitHub configuration only; the bridge never creates or changes branch protection or rulesets.

Produce a credential-free verification snapshot and give it to the read-only policy doctor:

```bash
npm run github-app:verify -- owner/repository --json > /tmp/github-verification.json
bridge doctor --workspace /path/to/repository --github-verification /tmp/github-verification.json --json
```

Omit `github.mergeEnforcement` for the same behavior as `broker`. This preserves compatibility for existing installations and users without paid GitHub plans.

### Enforce agent review without a human-identity bypass

GitHub's required approving-review count is a human collaboration rule: an approval must come from a person with the required repository access. Do not use an owner PAT to turn an agent verdict into that human approval. For repositories where agents have standing merge authority, configure the target branch or ruleset as follows:

1. Require pull requests and all repository CI checks.
2. Set the required human approval count to zero unless the repository genuinely requires a human decision.
3. Choose one machine-review gate: either accept the configured reviewer App's formal exact-head approval, or require the `agent-review` commit-status context and grant Commit statuses write to each reviewer App. Do not grant Commit statuses write to the builder App.
4. Require conversations to be resolved and prevent administrators/owners and the builder App from bypassing the ruleset.

Every provider-specific reviewer App submits a formal review at the exact authorized head. When the optional status permission is present, `APPROVE` also publishes `agent-review=success`, `REQUEST_CHANGES` publishes failure, and `COMMENT` publishes pending. The bound builder checks formal reviewer-App decisions first and needs no Commit statuses permission when an exact-head App approval exists; it consults `agent-review` only as a fallback when that App has no formal decision. It accepts either that exact-head approval, the trusted `agent-review=success` fallback, or an exact-head `APPROVED` review from a configured `mergePolicy.trustedHumanReviewers` login. GitHub still enforces CI and the ruleset. If a repository keeps a nonzero human approval count, the pipeline pauses until the person actually reviews; it never manufactures that approval through an owner PAT or administrator bypass.

Review publication is preflighted before a delegated PR-review turn. Before any model starts, the broker also proves that the review workspace `HEAD` equals the full authorized PR head SHA; a short, stale, or mismatched head fails closed even when publication is degraded. The broker distinguishes model availability from reviewer-App availability, orders publishable reviewers before local-only reviewers, and records the reason whenever an App is unbound or lacks permissions. An unbound model can still complete its read-only review and durable handoff; its output is labeled local-only and cannot claim a formal GitHub review. When no requested reviewer App can publish, the collaboration degrades to local review evidence and explicitly requires an exact-head approval from a configured trusted human. Autonomous skills pass the preferred reviewer and eligible non-writer fallbacks in one roster, so a transport failure advances to another provider without consuming a successful-review turn. If a publishable reviewer fails after preflight, the broker removes that publication path and recomputes the human-approval requirement; a publication that already succeeded remains recorded. Explicit single-provider handoffs remain single-provider and fail visibly rather than silently substituting a peer.

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
npm run test:installed-runtime
npm run test:runtime-deployment
npm run test:skills
npm run test:collaboration
```

To verify the real Codex sandbox/Git boundary rather than only the adapter contract, run the opt-in acceptance probe:

```sh
AGENT_BRIDGE_LIVE_CODEX_WRITER=1 npm run test:codex-writer-commit:live
```

It creates temporary local repositories, asks the installed Codex binary to make and commit one file under standard `workspace-write`, proves the commit used a private `.git`, and removes the fixtures.

Restart Codex App, Claude App, Antigravity App, and their CLI sessions after the checks pass.

### Optional: move collaboration history

Portable collaboration records and JSONL transcripts live under `~/.local/share/agent-bridge/state`. Copy that directory only if the history matters. The transcript remains readable, but resuming an old provider session may fail unless that provider's corresponding local conversation state also exists on the new computer. Starting fresh collaborations is safer.

In short: move the repository and `~/.agents`, authenticate providers afresh, run the installer, replace absolute paths, verify, and restart. The remaining portability gap is automatic MCP re-registration; `npm run install:global` does not currently rewrite every application's existing config file.

Ten canonical skills provide the same visible vocabulary in Codex, Claude, and Antigravity:

- `ask-agent`: announce and perform one named peer handoff.
- `run-roundtable`: start and actively monitor a persistent collaboration.
- `show-collaboration`: render status and turn history as a timeline.
- `replay-collaboration`: replay incident records and identify next safe actions.
- `goal-loop`: build toward verified completion through bounded, resumable council cycles.
- `pair-program`: rotate implementation and review roles with preflight, worktrees, visible progress, recovery, CI, budgets, and review reconciliation.
- `collaboration-doctor`: audit the effective workspace, provider, permission, fallback, skill, budget, and GitHub App policy without changing it.
- `take-the-helm`: give the council operational ownership of a goal or queue, schedule independent issues into parallel worktree lanes, and serialize integration through a bridge-owned merge train. Self-sequences new work (review follow-ups, `council-wayfinder` decomposition output), decomposes oversized items via `council-wayfinder`, applies a two-tier review circuit-breaker (5-round follow-up → extracted ticket, 12-round → council disposition), runs in wave/phase/end-to-end modes, and requires reviewers to include a proposed fix.
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
$collaboration-doctor Audit whether Codex and Antigravity can deliver this repository safely
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

For native-chair runs, the broker also writes a durable `coordinatorWake` when a delegated phase stops. It records the coordinator provider, monotonic sequence, source turn, summary, next action, delivery adapter, and acknowledgement. Host hooks hold the coordinator open while collaboration state is advancing or an actionable wake remains; if the exact same state retries without progress, they yield safely and rely on durable SessionStart recovery instead of creating an infinite host loop. Claude's optional Channel pushes the same receipt into a live session. The chair fetches the new turn, performs the exact next action, then calls `acknowledge_coordinator_wake`. Continuation and native-chair completion are rejected while an actionable wake is unacknowledged. `needs_user` and `indeterminate` wakes are non-actionable by design.

## Complete skill catalog

### Bridge-native skills

These skills are supplied by this project and installed across Codex, Claude, and Antigravity.

| Skill | Purpose |
| --- | --- |
| `ask-agent` | Send one bounded task or review to a named peer with a visible handoff receipt. |
| `run-roundtable` | Run and monitor a persistent Claude–Codex–Antigravity collaboration. |
| `show-collaboration` | Display collaboration status, skipped providers, turns, and history. |
| `replay-collaboration` | Replay incident records and identify next safe actions. |
| `goal-loop` | Build toward explicit completion criteria through bounded plan, implement, review, fix, and verification cycles. |
| `pair-program` | Rotate one writer and independent reviewers across tasks, worktrees, CI, and formal PR reviews. |
| `collaboration-doctor` | Render a read-only effective-policy matrix with fail-closed findings and least-authority remediations before delegation. |
| `take-the-helm` | Autonomously schedule safe parallel issue lanes, arbitrate conflicts, and integrate exact PR heads through a serialized merge train while preserving narrow escalation boundaries. Self-sequences new work, decomposes oversized items via council-wayfinder, applies a two-tier review circuit-breaker, supports wave/phase/end-to-end run modes, and requires proposed-fix reviews. |
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

> Start a persistent collaboration with Claude, Codex, and Antigravity. Claude plans, Codex implements as the only writer, and Antigravity reviews. Use configured non-Fable models and return the collaboration ID immediately.

The app calls `start_collaboration` and returns an ID such as `bridge-<uuid>`. In another app, ask:

> Get collaboration `bridge-<uuid>` and show its latest turns.

If the agents need a decision or another phase:

> Continue collaboration `bridge-<uuid>` with this answer: <answer>.

The common tools are:

- `start_collaboration`: starts a detached bounded run and returns immediately.
- `get_collaboration`: reads status and recent turns; supports a 30-second long poll.
- `continue_collaboration`: resumes the exact Claude, Codex, Antigravity, and persisted local Docker/Ollama sessions.
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

All Codex, Claude, and Antigravity MCP clients on the machine submit durable runs to one local collaboration-worker supervisor. The supervisor is double-forked before the initiating MCP call returns, so closing or restarting one host app cannot reap its workers or workers started by another host. It preserves the existing per-workspace leases and per-provider concurrency limits, adopts command-and-start-time-matched workers after its own restart, retries transient OS identity-probe failures, and records every observed worker exit in the collaboration transcript. Repeated unavailable probes and confirmed mismatches remain fail-closed and never authorize a replacement worker.

The supervisor state directory is forced to owner-only `0700`; on Unix the endpoint is created under a restrictive umask and fixed to `0600`. Worker launches do not forward the caller's full environment. The client and supervisor independently retain only basic runtime keys plus the documented bridge/provider/tool families: `AGENT_BRIDGE_*`, `BRIDGE_*`, `CLAUDE_*`, `ANTHROPIC_*`, `AWS_*` for Bedrock, `CLOUD_ML_REGION` plus `GOOGLE_*`/`CLOUDSDK_*`/`VERTEX_*` for Vertex, `CODEX_*`, `OPENAI_*`, `AGY_*`, `ANTIGRAVITY_*`, `GEMINI_*`, `GH_*`, `GITHUB_*`, `GIT_*`, `MCP_*`, Node/package-manager configuration, locale, proxy/CA settings, and executable/home/temp discovery. Arbitrary project secrets are dropped before IPC and are never written to supervisor state. A process that disappears before writing a terminal outcome becomes `indeterminate` with `Worker exited without a terminal receipt`; a later cancellation does not erase that original incident from `replay_incident`.

Inspect or safely replace the supervisor without touching its workers:

```sh
bridge supervisor status
bridge supervisor refresh
```

### Parallel portfolios and bridge-owned merge trains

`take-the-helm` uses a durable portfolio ledger under `~/.local/share/agent-bridge/state/portfolios`. Each issue declares hard blockers, temporary conflict edges, expected path ownership, exclusive resources, priority, and verification commands. `plan_portfolio` rejects dependency cycles and greedily selects the highest-priority non-conflicting frontier up to `maxParallel`, which defaults to two. A selected implementation issue receives one writer and one self-contained checkout under `.bridge/writer-checkouts`; its Git index, refs, and objects do not alias the source repository. Review-only lanes may still use linked worktrees under `.bridge/worktrees`. Provider execution uses role-specific semaphores: the machine default is five live work calls and ten concurrent read-only review calls per provider. Excess calls remain queued in FIFO order with `runtime.activeCall.phase: waiting_capacity` and start automatically when a compatible slot is released.

The machine policy lives at `~/.config/local-agent-bridge/provider-concurrency.json` and is a hard ceiling. `start_collaboration.providerConcurrency` may lower it for one collaboration but cannot raise it; `continue_collaboration` preserves the resolved limits unless supplied a lower replacement. Lower work concurrency when the safe frontier, worktree isolation, or exclusive resources cannot support five writers; submit review-ready PRs immediately instead of holding them in the chair.

Passing branch CI or opening a PR does not satisfy a hard dependency that requires merged behavior. Verified PR heads enter the bridge-owned merge train. They stop consuming writer capacity but continue reserving overlapping paths and exclusive resources until merged or repaired. Only one candidate may hold the integration slot. The chair combines the exact PR head with the current target SHA in a disposable worktree, runs the lane and repository integration gates, and records either a current validation or an arbitration dossier. `authorize_portfolio_merge` fails if the target or head changed and does not itself grant merge authority; the configured builder App still requires standing repository authority or explicit authorization for that exact head.

After GitHub merges the authorized PR, `record_portfolio_merge` advances the target SHA, invalidates every remaining combined validation, marks the issue merged, and recomputes the frontier. Textual, structural, semantic, and requirement conflicts use two read-only advocates, a third-model arbiter when available, and exactly one resolution writer. The repaired PR receives a new head, tests, reviews, and queue entry. GitHub remains the source of truth for PRs, reviews, checks, and the final merge while the bridge owns ordering, combined validation, recovery, and conflict decisions.

`get_collaboration` is compact by default: `detail: status` and `includeTurns: 0` omit the original brief, command arrays, preflight data, and completed turn bodies. Poll with `afterUpdatedAt`; when `runtime.turnCount` advances, request new output once with `detail: full`, a bounded `includeTurns`, and `afterTurn`. `runtime.activeCall.summary` is the narrative status, `summaryAt` says when that narrative changed, and `heartbeatAt` independently proves process liveness. `summarySource` distinguishes the broker's initial placeholder from provider-authored or adapter-observed work. A fresh heartbeat never makes an old narrative current.

Make every heartbeat poll a separate `get_collaboration` call with `waitSeconds: 8` or less. Poll cadence and display cadence are deliberately different: show narrative or lifecycle changes immediately, but rate-limit liveness-only output to one compact line per 60 seconds and never repeat an unchanged status card. Do not replace broker polling with one long-running Bash, sleep, `gh`, or PR watcher: host CLIs generally redraw their status UI only after a tool call returns. Check GitHub after the broker reports a completed turn or terminal state.

A native chair no longer has to infer that a peer finished from a stale heartbeat. Terminal phases enqueue `coordinatorWake`; the installed Stop/AfterAgent hook blocks the host while state is advancing and surfaces actionable completion, while SessionStart re-injects an unprocessed wake after a restart. A repeated Stop against an unchanged signature is allowed to exit so a broken host cannot loop forever; the wake remains durable. Claude's `collaboration_wake` Channel provides a live push path when launched through `claude-collab`. These mechanisms complement bounded broker polling; they do not create hidden shell pollers or bypass protected user/indeterminate boundaries.

### Evidence reuse, compact continuations, and performance timing

The broker stores content-addressed evidence under its owner-only state directory. Repository maps and diffs are keyed by repository plus exact base/head SHA. Claimed-issue and comment reads use a short 30-second cache so concurrent startup avoids duplicate GitHub calls without treating mutable issue text as permanently immutable. Authorization-critical PR state, review state, checks, and merge state are always read fresh.

Each participant receives the full task only on its first turn. Resumed turns carry a compact delta containing the latest unseen peer evidence, current repository/diff evidence, and any newly reusable verification receipts. Runtime `promptMetrics` reports full versus delta prompts, characters sent, estimated tokens, and avoided repeated characters.

Verification may be reused only from a recorded receipt whose repository, exact head SHA, command, working directory, and environment fingerprint all match. The workspace must also be clean, the command must have exited zero, and its attestation must be `authoritative` or `observed`; claimed results and failures never suppress a gate. Claude and Codex adapters automatically return observed results for exact declared review commands, and the worker persists successful review results only after pinning recapture to the collaboration's original head and proving that the environment fingerprint is unchanged. Ambiguous provider results without an explicit success signal are discarded. Mutable work-mode observations are intentionally not minted as receipts because a command may have run before the writer's final edit or commit. Failed, undeclared, malformed, dirty-worktree, moved-head, changed-environment, and work-mode observations are recorded as skipped events instead of reusable evidence. `record_verification_receipt` remains available for chair or CI evidence and defaults to `claimed`, so callers must explicitly attest evidence they actually observed before reuse. Collaboration state reports reused receipts, commands still pending, avoided command count, and estimated avoided milliseconds. Claude retains a narrow permission to rerun a reused command when it explicitly rejects a receipt; Docker and Ollama may consume the receipt as static review evidence only when every gate is removed from their effective dispatch, and must request fresh verification if they reject it. If any pending command remains, the local-provider capability boundary rejects them before launch.

`get_collaboration` exposes `performanceSummary` and the bounded underlying timeline. Active spans cover queueing, capacity wait, provider startup, first progress, provider execution, inference, tools, tests, review publication, builder publication, and cleanup. Dead-time spans make the handoff pipeline visible:

- `completion_to_wake`: provider completion to wake creation.
- `wake_delivery`: wake creation to host delivery.
- `wake_acknowledgement`: delivery to coordinator acknowledgement, or enqueue to acknowledgement when no external delivery adapter exists.
- `handoff_to_chair_acknowledgement`: structured provider handoff to chair acknowledgement when no wake channel drives the transition.
- `wake_to_review`: acknowledgement to review start.
- `formal_review_to_portfolio_review`: formal review publication to the portfolio recording that exact-head review as complete.
- `merge_coordinator_wait`: portfolio review completion to the coordinator beginning merge validation.
- `merge_ci_validation`: serialized integration validation start to its recorded outcome.
- `merge_policy_wait`: successful validation to exact-head merge authorization.
- `github_merge_execution`: authorization to the remotely recorded GitHub merge.

Use these spans to distinguish model/tool latency from orchestration stalls. `activeTimeMs` and `deadTimeMs` are wall-clock time across the union of their respective intervals, so nested or overlapping spans are not double-counted. `attributedActiveTimeMs` and `attributedDeadTimeMs` retain summed per-span attribution for breakdowns. A formal-review milestone is recorded only after an observed successful bound publication—not merely because the provider had publication capability. Cache metrics include hits, misses, refreshes, avoided loads, avoided commands, and estimated avoided test time; mutable or security-sensitive GitHub checks are deliberately excluded from cache reuse.

A timeout or lost transport becomes `indeterminate`, not unavailable. The broker preserves writer ownership and blocks replacement work in that workspace until the user inspects the provider/workspace and explicitly cancels. Only a confirmed provider failure permits removal from the rotation; cancellation terminates the detached process group.

Delegated peer processes inherit a recursion marker. If a participant tries to start or continue another persistent collaboration through its own MCP tools, the nested mutation is rejected; only the active broker routes turns.

When Codex App, Claude Code, or Antigravity is already doing the primary work, pass `chair` with its provider, optional session ID, exact workspace, and exposed capabilities. The broker records that participant as `native-chair` and removes the same provider from delegated agents by default. Set `allowSameProviderDelegation: true` only for an intentional second session. Chair-owned implementation stays in the host; the broker phase calls peers for review, and `record_native_chair_turn` attaches the host's artifact and verification receipt to the same portable history.

For reversible technical uncertainty, enable `decisionPolicy`. Participants may emit a validated `DECISION:` envelope containing alternatives, selection, confidence, dissent, rollback path, and owner. The policy bounds the dialogue and records one concise receipt. Money, legal/compliance, external authorization, destructive/irreversible actions, and explicit user-owned choices always become `needs_user`; repository policy may add escalation categories but can never remove the baseline or expand permissions.

In work mode, `writer` defaults to the starting agent. The designated writer receives edit permissions; every other participant is forced into review mode at both the prompt and provider-tool layers. A workspace lease prevents two persistent work-mode collaborations from editing this project simultaneously. Review-only collaborations may still run concurrently.

Provider capacity is acquired for every turn, not merely when the collaboration starts. This means a coordinator may call the same provider repeatedly and several portfolios may share it safely. Work and review limits are independent, so an active writer does not consume a review slot. A transport-indeterminate call keeps its capacity reservation until the collaboration is explicitly cancelled or otherwise reconciled.

Model fields are optional. Omitting them preserves each provider's configured model. Explicit values pass through unchanged except for the Claude Fable policy: the bridge runtime denies Fable unless the user's current request explicitly asks for Fable by name. Saved defaults, earlier requests, aliases, and fallback chains do not grant permission. Without that explicit request, the runtime preserves any configured non-Fable Claude model, substitutes `claude-opus-4-8[1m]` if the configured/default model resolves to Fable, and removes Fable from the Claude fallback chain.

`modelFallbacks.claude`, `modelFallbacks.codex`, `modelFallbacks.antigravity`, `modelFallbacks.docker`, and `modelFallbacks.ollama` are optional. Omitting them loads the machine-local overload policy; an explicit provider array replaces that policy for the collaboration. Overload retries happen inside one provider turn, so they do not consume another broker turn or trigger writer reassignment.

Autonomous work lanes should pass all eligible providers in one ordered roster and identify one preferred writer. If that writer is confirmed unavailable, the broker moves ownership to the next eligible provider without changing the private checkout. Existing collaborations retain their recorded workspace across restarts. To rescue an older stopped work collaboration from a linked worktree, inspect its exact workspace and HEAD, call `recover_writer_checkout` with both fences, and then continue the same collaboration. Recovery rebuilds the lane from its recorded base, migrates committed, staged, deleted, modified, and untracked changes into private Git custody, and retains the original linked worktree as evidence. `cleanup_writer_checkout` removes a stopped private checkout only after exact workspace and HEAD inspection; it refuses dirty state unless `discardChanges: true` is explicit. Both operations atomically reserve the collaboration as `indeterminate` before touching the filesystem, so a concurrent continuation cannot start a worker in a checkout being moved or removed; an interrupted operation leaves a durable reconciliation marker instead of guessing ownership. If the full roster is exhausted by transient model-capacity failures, the collaboration enters visible `recovering` state and retries according to `providerRecovery` (three attempts at 15, 60, and 180 seconds by default). Each recovery attempt begins with the provider's preferred configured model and then follows its downgrade chain, allowing automatic upgrade when capacity returns. Authentication, permission, quota, configuration, command, and indeterminate transport failures are not retried. `wait_for_portfolio_lane` races the desired head advancement against handoff, failure, cancellation, indeterminate ownership, and recovery so coordinators cannot park on a success-only signal.

## Effective collaboration policy doctor

Bare `bridge doctor` retains the installation and registration checks. Add policy options to audit one exact delegation without changing configuration, permissions, credentials, the repository, or any provider session:

```bash
bridge doctor \
  --workspace /path/to/repo \
  --host codex \
  --providers codex,antigravity \
  --mode work \
  --role writer \
  --profile deliver \
  --require-fallback \
  --builder-operation create_branch \
  --builder-operation push_branch \
  --builder-operation ensure_pull_request

bridge doctor --workspace /path/to/repo --host claude --providers codex,antigravity --mode review --require-review-app --json
```

The human view and versioned JSON report contain the same request, provider matrix, finding counts, authoritative sources, impacts, and least-authority remediations. Failures block the complete request, constraints remove or limit a provider while allowing a degraded roster, and notices remain optional. Use `--strict-provider` only for a provider that must participate; optional budgets and overload fallbacks are not errors unless explicitly required.

The doctor detects missing or stale MCP transports, unavailable CLIs, browser mismatches, incompatible overload fallback chains, exact-command allowlist gaps, unavailable skill capabilities, missing budgets, unsafe PAT compatibility, reviewer/builder identity overlap, missing or unverifiable GitHub App bindings and scopes, and the configured versus effective GitHub merge-enforcement tier. Live App scope and explicit GitHub enforcement remain fail-closed unless supplied by a trusted read-only verification snapshot; `npm run github-app:verify -- OWNER/REPO --json` emits that snapshot without granting or changing permissions. Broker-only enforcement is a visible notice, not an installation failure. Neither report contains token values, private keys, full prompts, or credential-bearing remote URLs. `--input snapshot.json` exists for hermetic incident replay and tests, not as proof of current machine state.

## Pair-programming operations

Use `$pair-program` when Claude, Codex, and optionally Antigravity should alternate implementation and review across tasks. The installed global `bridge` CLI exposes the operational controls used by that skill:

```bash
bridge capabilities
bridge preflight --workspace /path/to/repo --agents claude,codex --mode work --profile deliver
bridge roles --task 12 --agents claude,codex # --task-number is also accepted
bridge status
bridge mission-control # alias: bridge mc
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
- Work-mode collaborations create a self-contained task checkout before any provider starts; review-mode collaborations retain linked-worktree behavior.
- Preflight records provider capabilities, repository state, work profile, branch, and remote readiness.
- Provider capability preflight probes each installed binary and its relevant subcommands, caches by absolute path/version/size/mtime, and builds new-session and resume argv independently. `bridge capabilities` shows the negotiated matrix and whether it came from a live probe or cache; required missing features stop before model invocation and optional flags are omitted.
- Status combines provider heartbeat/summary, writer, branch, PR/CI, and known usage.
- Mission Control is a live, read-only terminal dashboard over the same persisted control plane. It groups collaborations and portfolio lanes by GitHub repository (including linked worktrees), shows the active provider and role, narrative freshness versus heartbeat freshness, handoff/coordinator state, issue/PR/branch details, merge-train blockers, timing, and a compact event timeline. It never starts providers or polls GitHub.
- Run `bridge mc` in a terminal. Use `j`/`k` or the arrow keys to move, `a` to toggle attention-only versus terminal history, `r` to refresh, and `q` to exit. Use `bridge mc --snapshot` for logs and scripts, `bridge mc --json` for machine-readable state, `bridge mc --repo OWNER/REPO` to focus one repository, and `bridge mc --all` to include terminal history. Non-interactive output automatically uses snapshot mode.
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

The peer model override is passed directly through MCP after the collaboration skill applies the Claude Fable policy. The host model is selected by its CLI session. A model selected only for an unrelated terminal session is not a saved provider default; pass it explicitly when the bridge starts a separate delegated process. If a Claude host is already running Fable without an explicit Fable request in the current task, switch it to a non-Fable model before invoking the skill.

#### Provider overload fallback

Claude Code, Codex, Antigravity, Docker Model Runner, and Ollama capacity failures can fall through an ordered chain inside the same delegated turn without breaking the collaboration or rotating its writer. The caller may pass `fallbackModels` on a provider's direct tools or use the corresponding `modelFallbacks.<provider>` field on `start_collaboration` and `continue_collaboration`:

```json
{
  "models": {
    "claude": "claude-opus-4-8",
    "codex": "gpt-5.6-sol",
    "antigravity": "Gemini 3.1 Pro (High)",
    "docker": "ai/qwen3.6",
    "ollama": "qwen3.6:latest"
  },
  "modelFallbacks": {
    "claude": ["claude-opus-4-6", "claude-sonnet-5"],
    "codex": ["gpt-5.6-terra"],
    "antigravity": ["Gemini 3.1 Pro (Low)", "Gemini 3.5 Flash (High)"],
    "docker": ["ai/qwen3-coder", "ai/devstral-small-2", "ai/qwen2.5-coder", "ai/gemma4:31B"],
    "ollama": ["qwen3-coder:30b", "qwen3.5:27b", "gemma4:31b", "gemma4:latest"]
  }
}
```

For a machine-wide default, copy [`config/model-fallbacks.example.json`](config/model-fallbacks.example.json) to `~/.config/local-agent-bridge/model-fallbacks.json` and edit the provider lists. Configured primary models remain unchanged. Claude Code receives its ordered chain through the native `--fallback-model` option. After an explicit Codex overload, a new delegated turn retries from a fresh thread with the original task, while `codex-reply` retains the caller's established thread; both forms repeat the original prompt and tell the fallback to preserve completed workspace work. Passing a provider's `[]` disables the machine policy for one collaboration.

```sh
chmod 600 ~/.config/local-agent-bridge/model-fallbacks.json
```

Codex and Antigravity emit a visible downgrade narrative and record `requestedModel`, selected `model`, `fallbackUsed`, and `attemptedModels` in turn metadata. Claude Code owns its native retry and session continuity while the bridge records the configured fallback policy in turn metadata. None of these paths use model fallback for authentication, permission, quota, configuration, ordinary command failure, timeout, or lost transport. If a chain is exhausted, the final error names every attempted model so the broker can continue with another available provider.

#### Machine-wide model deny policy

Disable a model once for every new delegated bridge turn instead of repeating the choice in Codex, Claude, and Antigravity chats:

```sh
bridge models disable claude fable
bridge models disable codex gpt-5.6-sol
bridge models disable antigravity "Gemini 3.1 Pro (High)"
bridge models disable docker "ai/qwen3-coder"
bridge models disable ollama "gemma4:latest"
bridge models status
```

Re-enable a model with the same provider and model name:

```sh
bridge models enable claude fable
```

The commands atomically maintain the mode-`0600` file `~/.config/local-agent-bridge/model-policy.json`. The file contains no credentials and may be copied to another machine; [`config/model-policy.example.json`](config/model-policy.example.json) shows its versioned format. Provider names are `claude`, `codex`, `antigravity`, `docker`, and `ollama`. Model comparisons are case-insensitive exact matches, except the Claude entry `fable`, which blocks the whole Fable alias family.

The deny policy is read for every new direct MCP call and every provider turn started by a persistent collaboration, so changing it does not require an app or MCP restart. It does not interrupt an in-flight turn. A native host chat in Codex App, Claude Code, or Antigravity owns its already-selected host model; switch that chat's model or begin a new host chat if the host itself is using a newly disabled model.

A machine deny is stronger than a per-request override. For example, `allowFable: true` cannot use Fable while `claude fable` is disabled globally. After Fable is re-enabled globally, the existing safety rule still requires the current user request to ask for Fable explicitly. When a disabled primary has an allowed configured fallback, the bridge promotes that fallback before launching the provider and emits a routing narrative. When every requested candidate is disabled, the call fails immediately with a command to inspect or repair the policy instead of waiting for a provider timeout.

The bridge can inspect Claude's saved/environment model and Codex's top-level `config.toml`/environment model. Antigravity exposes an environment-selected model through `AGY_MODEL`, `ANTIGRAVITY_MODEL`, or `GEMINI_MODEL`; its opaque app-selected default cannot be named before launch, so set one of those variables or pass an explicit model when a strict Antigravity default guarantee is required.

#### Explicit Fable opt-in

Fable is never selected, inherited, or used as a fallback by the collaboration skills or raw bridge tools unless the user's current request explicitly asks for Fable by name. A saved Fable setting or earlier request is not permission. When the current request does explicitly opt in, announce that exception before starting and pass `allowClaudeFable: true` to that collaboration phase or `allowFable: true` to that direct Claude call. These flags default to false, and collaboration continuation resets authorization rather than inheriting it. For example, a user may explicitly request that Fable plan, a selected Codex model implement, and Fable review:

```sh
claude --model fable
```

```text
/agent-dialogue --claude-model fable --codex-model <codex-model> Fable plans, Codex implements, then Fable reviews: <task>
```

Or the user may explicitly request that a selected Codex model plan, Fable implement, and Codex review:

```text
$agent-dialogue --codex-model <active-codex-model> --claude-model fable Codex plans, Fable implements, then Codex reviews: <task>
```

The explicitly requested inverse arrangement also works from Claude Code after selecting Fable with `/model fable`:

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
- Any primary → delegated Ollama uses bounded local repository tools and authors the same envelope. During evaluation, both approval and requests for changes are deliberately published as non-authorizing comments.
- Any primary → delegated Docker Model Runner uses the same bounded local repository tools and non-authorizing review envelope, and is preferred over Ollama when both local backends are available.

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

The delegated tool mints a short-lived token from the provider-specific reviewer App (`claude`, `codex`, or `antigravity`/Gemini), or reads the backward-compatible `~/.config/ghtoken` fallback when no reviewer App is configured. A caller may still pin `expectedLogin` for a strict single-identity flow. Credentials never enter the prompt, skill, transcript, or MCP response. Before posting it verifies the token login, exact current PR head, and every inline-comment path. The App submits a formal GitHub review (`APPROVE`, `REQUEST_CHANGES`, or `COMMENT`), optionally publishes an exact-head `agent-review` commit status when permitted, records the receipt in the handoff, and uses content markers to avoid duplicate work. A PAT fallback is comment-only and produces no gate. A re-review must refresh `headSha`.

Writer-side PR delivery uses a separate `githubBuilder` authorization bound to one repository, expected bot login, current head SHA, optional PR, and an explicit `allowedOperations` list. Claude and Codex receive only `github_builder` tools; Antigravity returns a validated operation envelope that the broker executes unchanged outside model context. Supported actions are create/update the designated PR, read/reply/resolve exact review threads, mark ready, merge the exact PR at the exact head SHA, create a bound feature branch, fast-forward a bound feature branch, and replace a bot-owned feature-branch head with an exact old/new SHA lease. Every mutation rechecks the per-operation allowlist, identity, repository/ref/head binding, protected/default-branch state, and payload constraints, then returns a remotely verified durable receipt. Branch replacement is separately allowlisted as `replace_branch`; it is unavailable by default and never exposes raw force-push access. Before merge, the builder requires an exact-head approval from a configured reviewer App, `agent-review=success` from that App, or an exact-head approval from a configured trusted human. The default allowlist excludes `merge` and every branch mutation; normal goal-loop and pair-program runs stop at a green reviewed PR unless the user explicitly adds the required exact-head operation.

Native coordinators use collaboration `merge_pull_request` instead of shelling out to `gh pr merge`. The tool mints the configured builder App credential, requires the repository to match machine-local `mergePolicy.autonomousMergeRepositories`, pins the full PR head SHA, and applies the same independent-review and GitHub-rule checks. This removes the need for a broad Claude Bash allow rule while keeping autonomous merges fail-closed and auditable.

## Local Council Control Plane

The bridge provides a strictly read-only local council control plane query and reporting interface over collaboration and portfolio state directories.

### Commands & Output Format
- `node scripts/bridge-ops.mjs status`: Returns a stable versioned JSON payload conforming to schema version `1.0.0`.
- `node scripts/bridge-ops.mjs status --human` (or `--format=human`): Outputs a structured, console-friendly text representation of all matching active lanes.

### Filters & Options
The control plane accepts the following CLI filters:
- `--workspace <path>`: Filters lanes by matching or subdirectory path under the workspace root.
- `--status <status>`: Filters by lifecycle phase (e.g. `running`, `ready`, `failed`, `agreed`).
- `--provider <name>`: Filters lanes where the specified provider is a writer or participant.
- `--portfolio <id>`: Filters lanes belonging to a specific portfolio milestones scope.
- `--include-archived` (or `--archive`): Explicit opt-in required to read/query archived records stored under `archive/`.

### Sensitive-Data Boundary
To prevent leakages, the control plane is strictly read-only, makes no external network calls, does not mutate repository state, and filters out:
- Full turn bodies, prompt transcripts, and credentials.
- Unbounded sensitive paths.
- Pending decisions and budget/escalation statuses (mapped instead to bounded metadata fields).

## Browser boundary

The Codex/ChatGPT desktop built-in browser cannot be passed through this bridge: it is not available to Codex CLI, and `codex mcp-server` is a CLI surface. The configured Playwright MCP server gives both agents an isolated Chrome instance instead. It does not inherit cookies, accounts, or tabs from the Codex browser or your normal Chrome profile.

## Safety defaults

- Codex prompts before running a Claude bridge tool.
- Claude review delegation uses locked-down `dontAsk` mode: reads are allowed, only declared `verificationCommands` may use Bash, and only one declared `handoffPath` may be written.
- Claude work delegation also uses locked-down `dontAsk` mode. Choose `workProfile: implement` for local development through commit, or `workProfile: deliver` when the repository's one-implementer policy also assigns push and PR creation. Profiles use Claude Code's current `Bash(command:*)` prefix syntax and cover common tests, package managers, checksums, Git, and bounded `gh pr` lifecycle commands. The broker grants `--add-dir` only for a self-contained writer checkout's private `.git`; a parent repository's shared `.git` is never granted. Broad `gh api` and unbound `gh pr merge` access remain excluded. An exact merge command is accepted only as `gh pr merge <number> --<merge|rebase|squash> --match-head-commit <40-character SHA> [--delete-branch]`; the bridge rejects unpinned, cross-repository, or shell-composed variants before Claude starts. Pass another exact `workCommands` entry for an unusual endpoint. Commands outside the profile and exact additions fail immediately instead of prompting or timing out.
- Codex delegation defaults to `sandbox: read-only` with non-interactive permissions. A designated Codex writer uses `workspace-write`; `workProfile: implement` keeps network disabled, while `workProfile: deliver` enables network for the authorized push and bounded PR lifecycle. The writer's private `.git` is passed as an additional `sandbox_workspace_write.writable_roots` entry, including on continued turns, without exposing the source repository's shared Git metadata. The broker infers this grant for an existing self-contained work workspace and rejects linked/shared Git custody before any provider starts; Collaboration Doctor reports the same `git-custody` blocker during read-only preflight.
- Delegated `codex mcp-server` processes run with an isolated bridge-owned `CODEX_HOME`. The bridge links the existing Codex authentication file, atomically reconciles provider credential rotation, and mirrors only safe model defaults; it does not inherit global MCP servers, plugins, notifications, hooks, project trust entries, app tooling, or skills. This prevents completed collaborations from leaving recursive bridge adapter groups behind while preserving the user-configured model. Requested browser and bound GitHub-review servers are injected as complete, task-scoped definitions.
- An explicit `permissionProfile: yolo` remains available for work mode and maps to Claude Code permission bypass, Codex `danger-full-access` with approvals disabled, and Antigravity auto-approval without its terminal sandbox. Additionally, an Antigravity review carrying `verificationCommands` automatically uses `--dangerously-skip-permissions`: `agy` exposes no exact non-interactive command grant, and the owner-selected policy prefers a working command-running reviewer over removing Antigravity from the roster. Static Antigravity reviews remain sandboxed. Claude keeps exact command grants, and Codex command-running reviews remain fail-closed.
- Nested MCP is disabled in delegated Claude sessions.
- Antigravity continuations use the exact `conversationId`, never the global `--continue` shortcut. When supported, a per-call `--log-file` supplies session-bound recovery; older CLIs fall back to the cwd cache and report continuation as best effort.
- Antigravity review maps to `plan` and work maps to `accept-edits`. Standard calls use its terminal sandbox; command-running reviews automatically use unrestricted tool approval and receive the exact coordinator verification commands in their prompt.
- Delegated Claude sessions only receive Playwright when `browser: true`; the browser uses an isolated profile.
- Review mode exposes no general GitHub access. When repository policy explicitly requires reviewer-authored PR feedback, `githubReview` adds one target-bound `submit_pr_review` tool. It obtains a repository-scoped credential from the active provider's configured reviewer App, with the mode-600 `~/.config/ghtoken` available only as an unconfigured-App fallback. Outside model context it verifies the required login, rejects stale head SHAs and paths outside the diff, and idempotently submits one formal review with general and inline comments.
- The bound review publisher cannot push, merge, label, edit issues, access another repository or PR, or use the chair's personal GitHub identity.
- `turnTimeoutSeconds` is a per-model inactivity limit. Provider progress resets that limit, while a fallback chain remains hard-bounded to the limit multiplied by its permitted model attempts (primary plus at most five fallbacks).

## Overrides

- `CLAUDE_BIN`: absolute path to `claude` for the Codex-to-Claude adapter.
- `NODE_BIN`: absolute path to Node.js for the adapter launcher.
- `CODEX_BRIDGE_CODEX_BIN`: absolute path to a working `codex` binary for Claude-to-Codex.
- `AGY_BIN`: absolute path to the Antigravity CLI executable.
- `AGENT_BRIDGE_KEEP_MODELS_WARM`: `0` disables supervisor-managed local-model warming; `1` forces it on (it is on by default outside tests).
- `AGENT_BRIDGE_MODEL_WARM_INTERVAL_MS`: local-model warm tick interval; defaults to four minutes.
- `AGENT_BRIDGE_LOCAL_MODEL_KEEP_ALIVE`: Ollama `keep_alive` value used by review calls and warm ticks; defaults to `30m`.

The global Codex CLI is installed and verified. The project MCP wrapper also retains the ChatGPT.app-bundled binary as a fallback.
