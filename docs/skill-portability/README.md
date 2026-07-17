# Portable skill profile v1

`bridge skills export` derives one versioned manifest from the canonical `skills/` catalog. The manifest records each skill's metadata and trigger, MCP capabilities, progress and completion contracts, permission and identity boundaries, referenced resources, target adapters, compatibility warnings, and content hashes. It contains no timestamps or absolute source paths, so identical inputs produce identical bytes.

Supported target profiles are Codex (`~/.codex/skills`), Claude Code (`~/.claude/skills`), Gemini/Antigravity App (`~/.gemini/config/skills`), and Antigravity CLI (`~/.gemini/antigravity-cli/skills`). Directory targets preserve resources. Claude and Gemini omit Codex-only `agents/openai.yaml`; the manifest retains its MCP requirements. The flat Antigravity CLI target reports a skill as unsupported when the skill needs packaged files beyond `SKILL.md` and Codex-only metadata.

The exporter adapts known `$skill-name` invocations to `/skill-name` for slash-command hosts. Unknown host syntax is a lint error rather than a guessed translation.

## Commands

```sh
bridge skills lint
bridge skills export
bridge skills export --skill take-the-helm --target codex --target gemini
bridge skills verify
bridge skills lint --verify-export
```

Use `--home <temporary-directory>` for clean-machine validation and `--format json` for automation. The manifest is written below the selected home at `.local/share/agent-bridge/skill-exports/manifest.v1.json`.

The validator rejects unsupported frontmatter, missing or escaping referenced files, symlinked resources, user-specific absolute paths, concrete machine or App identities, credential-like values, concrete collaboration IDs, unknown MCP servers, unadapted skill invocations, manifest paths outside the selected home, missing exports, changed source skills, and stale export hashes. Provider authentication, GitHub identity configuration, collaboration history, and machine-local configuration are never export inputs.
