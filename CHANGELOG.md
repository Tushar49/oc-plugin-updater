# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MIT `LICENSE`, package metadata (`repository`, `homepage`, `bugs`), and a `prepublishOnly` syntax gate.
- Repo promotion roadmap in `_archive/development/plans/` (dev branch only).
- In-flow pnpm build approval: on `ERR_PNPM_IGNORED_BUILDS`, the run offers to execute `approve-builds` in the wrapper so the update completes without an external prompt.

### Changed

- Project renamed to **`oc-plugin-updater`** across package name, bin, banner, and docs — the previous npm name was taken and deprecated.
- Commit metadata normalized to a neutral project identity with no co-author trailers.
- Subprocesses no longer use `shell: true`; on Windows package-manager commands run through an explicit `cmd.exe /d /c` (removes the `DEP0190` deprecation warning and unescaped-argument risk).

### Planned

- Version catalogue: list all published versions per plugin, with `(current)` and `(latest)` markers.
- Interactive version picker (TUI) with filter and multi-select.
- Test suite + CI matrix (Windows / macOS / Linux × Node 18 / 20 / 22).

## [0.1.0] - 2026-10-08

### Added

- Single-file cross-platform CLI (`bin/cli.mjs`) with zero runtime dependencies (Node >= 18).
- Config discovery: `OPENCODE_CONFIG_DIR`, `dirname(OPENCODE_CONFIG)`, `$XDG_CONFIG_HOME/opencode`, `~/.config/opencode`, `%APPDATA%\opencode`, `%LOCALAPPDATA%\opencode`, plus an interactive prompt fallback.
- Package-cache discovery: `$XDG_CACHE_HOME/opencode/packages`, `~/.cache/opencode/packages`, `%LOCALAPPDATA%\opencode\packages`, `%APPDATA%\opencode\packages`.
- Reads both OpenCode config generations: v1 `plugin` and v2 `plugins` (strings and objects), across `opencode.jsonc`, `opencode.json`, `tui.json`, `cli.json`.
- Version resolution from npm dist-tags with `(current)` / `(latest)` markers.
- Pre-deletion lock probe with clean abort (exit code `3`).
- `--kill-blockers`: Windows (`Get-Process` module scan + `taskkill`) and Unix (`lsof` + signals), with TTY confirmation.
- Package-manager choice between **pnpm** and **npm** (`--pm`), asked interactively when both are installed.
- Path overrides: `--config-dir`, `--cache-dir`.
- Post-update verification and a leftovers report that never touches config.
- Windows shim (`updater.ps1`).
