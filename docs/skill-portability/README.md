# Portable skill profile v1

`bridge skills export` derives one versioned manifest from the canonical `skills/` catalog. The manifest records each skill's metadata, MCP capabilities, progress and completion contracts, permission and identity boundaries, referenced resources, target adapters, compatibility warnings, and content hashes. Each skill's `description` doubles as its invocation trigger text, so the profile carries no separate trigger field. It contains no timestamps or absolute source paths, so identical inputs produce identical bytes.

Supported target profiles are Codex (`~/.codex/skills`), Claude Code (`~/.claude/skills`), Gemini/Antigravity App (`~/.gemini/config/skills`), and Antigravity CLI (`~/.gemini/antigravity-cli/skills`). Directory targets preserve resources. Claude and Gemini omit Codex-only `agents/openai.yaml`; the manifest retains its MCP requirements. The flat Antigravity CLI target reports a skill as unsupported when the skill needs packaged files beyond `SKILL.md` and Codex-only metadata.

The exporter adapts known `$skill-name` invocations to `/skill-name` for slash-command hosts. Unknown host syntax is a lint error rather than a guessed translation.

A full export rebuilds the manifest from the whole catalog. A filtered export (`--skill`/`--target`) merges into the existing manifest: entries outside the selection are preserved unchanged so `bridge skills verify` keeps checking them, and a filtered export against an existing but unreadable manifest fails instead of discarding prior records. Skills that no longer exist in the source catalog are pruned on every export: their manifest entries are dropped and their exported directories and flat files are removed from the known target roots.

Exports and verification never follow symlinks below the selected home. Every existing path component under the home — target roots, exported skill directories and files, the manifest and its parent directories — must be a real file or directory; a symlinked segment aborts the export or is reported as an `export-symlink` finding. Homes that deliberately symlink a target root (for example a dotfiles-managed `~/.codex`) are unsupported as export destinations.

## Commands

```sh
bridge skills lint
bridge skills export
bridge skills export --skill take-the-helm --target codex --target gemini
bridge skills verify
bridge skills lint --verify-export
```

Use `--home <temporary-directory>` for clean-machine validation and `--format json` for automation. The manifest is written below the selected home at `.local/share/agent-bridge/skill-exports/manifest.v1.json`.

The validator rejects unsupported frontmatter, missing or escaping referenced files, symlinked resources, user-specific absolute paths, concrete machine or App identities, credential-like values, concrete collaboration IDs, unknown MCP servers, unadapted skill invocations, manifest paths outside the selected home, symlinked export paths, missing exports, changed source skills, and stale export hashes. Provider authentication, GitHub identity configuration, collaboration history, and machine-local configuration are never export inputs.
