# AGENTS.md

Guidance for AI coding agents and contributors working in this repository.

## What this is

A single-file, cross-platform CLI that updates OpenCode npm plugins: it reads the plugin list from OpenCode's config, resets the cached plugin wrappers, and reinstalls target versions with pnpm or npm. It never writes OpenCode config.

## Layout

```
bin/cli.mjs        the entire tool (single file, zero dependencies)
updater.ps1        Windows convenience shim — keep it thin, no logic
package.json       no dependencies; keep it that way
README.md          user-facing docs
CHANGELOG.md       Keep a Changelog history
_archive/          development notes and plans — tracked on `dev` only
```

## Commands

```bash
node --check bin/cli.mjs        # syntax gate
node bin/cli.mjs --help         # usage
node bin/cli.mjs                # run (needs OpenCode closed, or --kill-blockers)
```

## Hard rules

1. **Zero runtime dependencies.** Use Node builtins only (`node:fs`, `node:path`, `node:child_process`, ...).
2. **Never write OpenCode config files.** They are read-only inputs.
3. **No hardcoded absolute paths, usernames, emails, or personal data** anywhere in tracked files. Examples use `~/.config/opencode`-style placeholders or environment variables.
4. **Probe before deleting.** Windows keeps loaded native files locked; check locks first and abort cleanly.
5. **Stay scriptable.** Honor `NO_COLOR`; never prompt on a non-TTY; exit codes are part of the contract (`0/1/2/3`).
6. **Windows-safe subprocesses.** Spawn `.cmd` shims through the shell on Windows.

## Branches

- `main` — stable, public surface. **Never contains `_archive/`.**
- `dev` — active development. **Tracks `_archive/`** with plans and notes.
- **Promotion** from `dev` to `main` is a curated commit: bring the intended file changes, never `_archive/`. Do not straight-merge `dev` into `main`.

## Style

- ESM modules (`.mjs`), 2-space indentation, single quotes.
- Small pure helpers separated from IO so logic stays unit-testable.
- Human-readable output grouped in labelled sections; details on one aligned line where possible.
- Comments explain *why*, not *what*.

## Before committing

- `node --check bin/cli.mjs` passes.
- A real run reaches the expected section (versions/lock handling) and exits with the documented code.
- No new personal data or drive-letter paths: scan tracked files.
