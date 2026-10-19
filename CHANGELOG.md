# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MIT `LICENSE`, package metadata (`repository`, `homepage`, `bugs`), and a `prepublishOnly` syntax gate.
- Repo promotion roadmap in `_archive/development/plans/` (dev branch only).
- In-flow pnpm build approval: on `ERR_PNPM_IGNORED_BUILDS`, the run offers to execute `approve-builds` in the wrapper so the update completes without an external prompt.
- `--list` version catalogue with `(current)`, `(latest)`, dist-tag, and `(not published)` markers (`--all` for the full list).
- `--set <name@version>`, `--only <name>`, `--dry-run`, and `--yes` for scripted and non-interactive runs.
- `--pick`: interactive version picker (arrow/j/k navigation, `/` filter, `Space` select, `Enter` confirm, `Esc` cancel, `?` help) with a `--selftest` harness for its pure logic.
- Maintenance toolkit: `--clean` (orphan prune), `--remove <name>`, `--backup`/`--rollback` (failed installs auto-restore the previous wrapper), `--doctor` (paths, v1/v2 generation, cache layout, binaries, locks, package managers), and `--registry <url>` for mirror support.
- `--notify`: check-only mode — exit 4 when updates exist, 0 when current; safe for cron/launchd/Task Scheduler.
- `--json`: machine-readable output for `--list`, `--notify` and `--dry-run`.
- `--git-pull`: `git pull --ff-only` the config directory before reading it (webdex parity).
- `--completions bash|zsh|pwsh`: shell completion scripts, plus a compact man page at `docs/oc-plugin-updater.1`.
- Library API: `import { updatePlugins, checkUpdates } from 'oc-plugin-updater'` (package `exports` added; importing no longer runs the CLI).
- Private-registry auth: `~/.npmrc` `_authToken` entries are sent as Bearer headers to matching hosts (npm, GitHub Packages, Verdaccio).
- Test suite (`node:test`, `npm test`) and a GitHub Actions matrix (ubuntu/macOS/windows × Node 18/20/22).
- Spec classification: local-path/URL plugin specs (v2 `./plugin/local.ts`, `file:`/URLs) are skipped with a visible note; v1 tuple entries (`[pkg, options]`) are read instead of silently ignored.
- Strict package name/version validation for `--set` and installs, blocking registry-URL and shell-metacharacter injection.

### Changed

- Project renamed to **`oc-plugin-updater`** across package name, bin, banner, and docs — the previous npm name was taken and deprecated.
- Commit metadata normalized to a neutral project identity with no co-author trailers.
- Subprocesses no longer use `shell: true`; on Windows package-manager commands run through an explicit `cmd.exe /d /c` (removes the `DEP0190` deprecation warning and unescaped-argument risk).
- `--list` exits non-zero when any registry lookup fails; `--yes` no longer prompts for pnpm build approval (prints the manual command instead).
- Plugin specs are validated before any registry-URL or cache-path use, closing a path-traversal vector from config-supplied specs.

- The package cache is resolved per config generation: v2 `plugins` configs prefer the `npm` cache base, v1 `plugin` configs prefer `packages`; both are tried automatically.
- Installed versions are detected in both cache generations — v1 `node_modules/<pkg>` and v2 `<timestamp>/node_modules/<pkg>` — so v2 caches report real installed versions and the verify step accepts them.
### Fixed

- Empty config files (for example a 0-byte `tui.json` placeholder) are skipped instead of crashing with `Unexpected end of JSON input`; unparsable configs now name the file in the error.

### Planned

- Unit test suite + CI matrix (Windows / macOS / Linux × Node 18 / 20 / 22).
- v2 verification on a real v2 install: package-cache layout, `opencode2` binary detection in `--doctor`.

## [0.1.0] - 2026-10-08

### Added

- Single-file cross-platform CLI (`bin/cli.mjs`) with zero runtime dependencies (Node >= 18).
- Config discovery: `OPENCODE_CONFIG_DIR`, `dirname(OPENCODE_CONFIG)`, `$XDG_CONFIG_HOME/opencode`, `~/.config/opencode`, `%APPDATA%\opencode`, `%LOCALAPPDATA%\opencode`, plus an interactive prompt fallback.
- Package-cache discovery: `$XDG_CACHE_HOME/opencode/packages`, `~/.cache/opencode/packages`, `%LOCALAPPDATA%\opencode\packages`, `%APPDATA%\opencode\packages`.
- Reads both OpenCode config generations: v1 `plugin` and v2 `plugins` (strings and objects), across `opencode.jsonc`, `opencode.json`, `tui.json`, and `tui.jsonc`.
- Version resolution from npm dist-tags with `(current)` / `(latest)` markers.
- Pre-deletion lock probe with clean abort (exit code `3`).
- `--kill-blockers`: Windows (`Get-Process` module scan + `taskkill`) and Unix (`lsof` + signals), with TTY confirmation.
- Package-manager choice between **pnpm** and **npm** (`--pm`), asked interactively when both are installed.
- Path overrides: `--config-dir`, `--cache-dir`.
- Post-update verification and a leftovers report that never touches config.
- Windows shim (`updater.ps1`).
