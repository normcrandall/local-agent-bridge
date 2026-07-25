# Delivery policy

`src/delivery-policy.mjs` resolves one effective delivery policy per workspace. Collaboration,
scheduling, publication, review, merge, cleanup, and Mission Control read the same resolved
values through `policy.surfaces` instead of each re-deriving policy from raw config files.

## Precedence

Weakest to strongest authority:

1. `protected_invariant` — bridge rules no layer may relax.
2. `machine_default` — this machine's model policy, concurrency ceilings, and GitHub App identities.
3. `repository_policy` — `.agent-bridge/delivery-policy.json` in the workspace.
4. `workspace_recipe` — `.agent-bridge/workspace-recipes.json`, gated by the machine-local approvals file.
5. `per_run_narrowing` — the `options` passed to `resolveDeliveryPolicy`.

A later layer may only **narrow** authority. A concurrency value may be lowered, never raised;
delivery may move from `github-governed` to `local-only`, never the other way; the `deniedModels`
and `deniedProviders` lists may grow, never shrink. Those two are the only roster keys a
repository may author, because they only ever remove candidates from the machine roster —
`providerAllowlist` and `enabledModels` are rejected outright. Every ignored attempt is recorded in that decision's `considered` list and
printed by the explain report, so a silently dropped override is always visible.

## Ownership

| Machine owns | Repository owns |
| --- | --- |
| Provider allowlist | Product facts |
| Model allowlist | Lifecycle mappings |
| Concurrency ceilings | Verification roles |
| Identities, installations, secrets | Path and resource rules |
| | Narrower concurrency |

Per-run input owns nothing; it may only narrow.

## Delivery profiles

- `github-governed` — a builder App and at least one reviewer App are configured. Publication,
  review-status publication, and merge surfaces are enabled.
- `local-only` — the explicit profile for workspaces without GitHub delivery. Handoffs stay local
  and no GitHub surface is enabled. A repository or per-run layer may always select it; neither can
  select `github-governed` when the machine has not configured the App pair.

## Rejected repository configuration

Repository-authored policy may never carry credentials. Keys naming tokens, secrets, passwords,
private keys, app IDs, installation IDs, or bot logins are dropped before merge, as are values that
look like a PEM block, a GitHub token, a private-key path, or a maintainer-specific `name[bot]`
identity. Each drop appears in `policy.rejections` with its origin and reason; resolution continues
with the machine value.

## Explain output

```
./bridge policy explain                       # human-readable report
./bridge policy explain --json                # stable explain document
./bridge policy explain --workspace /path     # any worktree
npm run explain:policy -- --json              # same output without the CLI wrapper
```

The JSON document contains `precedence`, `ownership`, `sources`, every `decision` with its `value`,
`source`, `detail`, and `considered` candidates, all `rejections`, and the per-surface views.

## Compatibility

No existing configuration file changes shape. The resolver reads the current
`model-policy.json`, `provider-concurrency.json`, `github-apps.json`, and
`workspace-recipes.json` through their own modules, so machine model denials, concurrency
ceilings, App identities, and recipe approvals keep their existing semantics. Repository
concurrency entries accept both `work`/`review` and the older `workLimit`/`reviewLimit` spellings.
`policy.provenance` and `policy.securityRejections` remain as aliases of `policy.decisions` and
`policy.rejections`.
