---
name: collaboration-doctor
description: Audit the effective local collaboration policy for an exact workspace, host, provider roster, role, mode, work profile, browser requirement, fallback policy, command allowlist, budget, skill, and GitHub App identity before delegation. Use when an agent handoff is failing, permissions or reviewer identities are unclear, a workflow may stall on unavailable providers, or the user wants a read-only preflight with human and versioned JSON findings plus least-authority remediations.
---

# Collaboration Doctor

Diagnose the policy that will actually govern one delegation. Report constraints; never repair or broaden authority during the audit.

## Establish the exact request

Resolve and announce:

- absolute workspace and calling host;
- selected providers and any provider that is mandatory;
- review or work mode, reviewer or writer role, and exact/implement/deliver work profile;
- standard or explicitly user-authorized yolo permission profile;
- required browser, skill, overload fallback, budget, commands, builder operations, and reviewer publication.

Do not infer capabilities from another app or provider. An isolated delegated browser is not the Codex App browser or a signed-in desktop profile.

## Run the read-only audit

Use the installed bridge command. Supplying policy options selects the effective-policy doctor; bare `bridge doctor` remains the installation doctor.

```bash
bridge doctor \
  --workspace /absolute/path/to/repository \
  --host codex \
  --providers codex,antigravity \
  --mode work \
  --role writer \
  --profile deliver \
  --require-fallback \
  --builder-operation create_branch \
  --builder-operation push_branch \
  --builder-operation ensure_pull_request
```

Add `--strict-provider <name>` only when that exact provider is required. Add one `--required-command '<exact command>'` and matching `--allow-command '<provider>=<exact command>'` receipt for each unusual shell requirement. Use `--skill <name>`, `--browser`, `--require-review-app`, `--require-fallback`, `--require-budget`, and the matching budget ceiling flags only when the workflow requires them.

For a versioned machine-readable receipt, rerun the same command with `--json`. The human and JSON reports must describe the same matrix, findings, and counts. Use `--input <snapshot.json>` only for a hermetic replay or regression fixture; do not present fixture output as a live machine audit.

## Interpret fail-closed findings

- **Failure** blocks the complete requested role.
- **Constraint** removes or limits one provider but may leave a safe degraded roster.
- **Notice** is optional context and must not be promoted to an error.

Every finding must name its authoritative source, provider or role, impact, and least-authority remediation. Treat configured-but-unverified GitHub App scopes as unverifiable. A separate `npm run github-app:verify -- OWNER/REPO` may confirm live App identity and required base scopes; it does not grant permissions. Do not enable PAT fallback to make a review or merge gate pass.

If no provider is eligible, stop before delegation. If one or more remain eligible, state the degraded roster and continue only when the requested workflow permits that consensus level. Intentional restrictions are constraints. Optional budgets and fallback chains are notices unless the request made them required.

## Preserve the boundary

The doctor must not:

- change configuration, install or restart MCP servers, mint credentials, or alter allowlists;
- print tokens, private keys, full prompts, or credential-bearing remote URLs;
- start delegated work, publish GitHub feedback, or mutate the repository;
- convert missing evidence into assumed permission.

Return the result, eligible roster, blocking finding codes, least-authority remediations, and exact command used. Apply changes only in a separately authorized task, then rerun the same audit.
