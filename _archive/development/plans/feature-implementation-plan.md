# opencode-plugin-updater — Feature Implementation Plan

**Status:** P0 (core updater) implemented. This plan covers P1–P5.
**Hard rule:** no hardcoded paths anywhere in this repo. All examples use `~/.config/opencode`-style placeholders or environment variables only.

---

## 1. Overview

Goal: a public, cross-platform, external CLI that updates OpenCode npm plugins (the `plugin` array in OpenCode's config) — the community counterpart to `opencode-models-discovery`. Install once, then `pnpm dlx <package>` / `npx <package>` to update. No installer TUI, never writes OpenCode config files.

## 2. Current state — P0 (shipped in this repo)

`bin/cli.mjs`, zero runtime dependencies, Node >= 18:

- **Path resolution:** env (`OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`) → OS defaults (`~/.config/opencode`, `%APPDATA%\opencode`, `~/.cache/opencode/packages`, `%LOCALAPPDATA%\opencode\packages`) → interactive prompt on a TTY, actionable candidate list when non-TTY.
- **Specs:** JSONC-safe read of the `plugin` array from `opencode.jsonc`/`opencode.json`/`tui.json`/`tui.jsonc` (union). Config is strictly read-only.
- **Versions:** npm registry dist-tags → target version; display marks `(current)` / `(latest)`.
- **Safety:** native-file lock probe (PowerShell `File.Open` exclusive on Windows; per-directory errors on Unix) **before any deletion**; `--kill-blockers` finds owning processes (Windows: `Get-Process` module scan → `taskkill /F /T`; Unix: `lsof` → SIGTERM/SIGKILL) with TTY confirmation.
- **Update:** deletes all cache wrappers for a plugin (`name`, `name@tag`), reinstalls via package manager preference **pnpm → bun → npm** with save-exact.
- **Aftermath:** version verification + **Leftovers report** (cache dirs of plugins not in config, stale config `package.json` pins, opencode state files) — reported, never touched.
- **Output:** ANSI sections/table, `NO_COLOR` respected, non-TTY safe.
- **Entry points:** `bin/cli.mjs` (cross-platform), `updater.ps1` (thin Windows shim → node), `package.json` bin (`opencode-plugin-updater`).

Exit codes: `0` ok · `1` install/verify failure · `2` usage/path error · `3` files locked.

## 3. P1 — Version catalogue + non-interactive version choice

**Data sources**
- `GET https://registry.npmjs.org/-/package/<name>/dist-tags` → `{ latest, beta, next, ... }`.
- Packument with `Accept: application/vnd.npm.install-v1+json` (abbreviated, fast) → all versions; semver descending sort; prereleases flagged.

**Display contract** (extends the current table):

```text
PLUGIN                    INSTALLED            TARGET
oh-my-openagent           4.19.4 (current)     5.1.22 (latest)
opencode-models-discovery 1.6.1  (current)     1.8.0 (latest)
```

Edge markers: installed == target → single line `(current)`; installed version absent from registry → `(not published)` warning (local patch/revert case); dist-tag other than latest → `(beta)`/`(next)` chip.

**Flags (non-TTY contract):**
- `--list` — print catalogue and exit (no changes).
- `--set <plugin>@<version>` — pin an exact version instead of latest.
- `--yes` — skip the interactive confirmation (for scripts/CI).

## 4. P2 — Interactive TUI picker (oh-my-openagent reference)

**Research findings (evidence from oh-my-openagent 4.19.4 package):**
- Its TUI is built on **`@opentui/core` + `@opentui/solid` (0.2.16)** — the same opentui stack the OpenCode host TUI uses; its `dist/tui.js` registers slot renderers through OpenCode's `TuiSlotPlugin` API (solid-component style), plus an imperative `solid.createElement` path.
- Consequence: an opentui-based picker would look host-identical, but ships **native binaries** (`opentui.dll` etc.) — the exact class of locked file our lock-probe/kill-blockers already fights, and it couples us to opencode's bundled opentui version.

**Options matrix**

| Option | Deps | Native bins | Look & feel | Risk |
|---|---|---|---|---|
| a. `@opentui/core` | heavy | yes | host-identical | self-inflicted file locks; version coupling |
| b. zero-dep ANSI raw-mode picker (readline) | none | no | clean custom | hand-rolled keys/resize |
| c. `@inquirer/prompts` | small | no | standard | less "beautiful" |

**Decision:** build **(b)** first — preserves the zero-dependency promise and lock-free footprint. Spike **(a)** later behind an experimental flag if host-identical visuals are wanted; keep **(c)** as fallback.

**Picker UX spec**
- Keys: `↑`/`↓` + `j`/`k`, `PgUp`/`PgDn`, `/` filter-as-you-type, `Space` toggle (multi-select for "update these"), `Enter` confirm, `Esc` cancel, `?` help line.
- Visuals: column-aligned rows; chips — `(latest)` green, `(beta)` yellow, `(current)` dim; cursor highlight row; cursor hide/show around redraws; resize-safe; `NO_COLOR`/non-TTY → fall back to flags (`--list`, `--set`, `--yes`).
- Structure: pure functions (filter/sort/render-string) separated from IO (raw-mode input) so unit tests need no terminal.

## 5. P3 — Kill-blockers hardening

- Add `--kill-blockers --dry-run`: print owner processes, change nothing.
- After kill: wait-for-release loop (probe every 500 ms, ≤ 5 s) before deleting.
- Exclude self and parent PIDs always; optional Sysinternals `handle.exe` fast path when present on PATH.
- Unix: if `lsof` missing, fail with instruction instead of guessing.

## 6. P4 — Tests + CI

- `node:test` units: `parseJsonc` (line/block comments, trailing commas, `//` inside strings), `splitSpec` (scoped / unversioned / `@tag` / exact version), candidate ordering with env overrides, `(current)`/`(latest)` marker rendering.
- GitHub Actions matrix: `ubuntu / macos / windows × node 18 / 20 / 22` → `node --check`, unit tests, `--help` smoke run.
- Regression gate: CI grep for drive letters and usernames in tracked files (hardcoded-path rule).

## 7. P5 — Public repository + distribution

1. `LICENSE` (MIT) + `README.md` (usage, flag reference, per-OS path table, troubleshooting: OpenCode's startup auto-installer may re-lay wrappers — benign, re-run to verify; Windows locks → `--kill-blockers`).
2. First commits (after user review of this plan).
3. `gh repo create <suggested-name> --public --source . --push` — name candidates following the `opencode-models-discovery` convention: **`opencode-plugin-updater`** (matches package name).
4. npm publish → enables `pnpm dlx opencode-plugin-updater` / `npx opencode-plugin-updater` one-liners.
5. PR to OpenCode docs ecosystem page (`opencode.ai/docs/ecosystem` → Plugins) for discoverability.
6. Versioning: semver; stay `0.x` until the picker (P2) ships; tag releases in git.

## 8. Repo hygiene rules

- **No hardcoded paths** — enforced by CI grep + review.
- `_archive/` is gitignored: working notes/plans live there, never committed (this file included).
- OpenCode config files are read-only, forever. The tool's only writes are inside the package cache (plus its own repo).

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| OpenCode startup reconciles wrappers with its own installer (npm/bun layout) | Versions unchanged → benign; verification step re-run detects drift; document |
| Registry outage/latency | 15 s timeouts, clear error, exact-version specs still installable |
| Windows file locks while OpenCode runs | Pre-deletion probe; abort exit 3; `--kill-blockers` |
| pnpm symlink/junction layout vs plugin loader | Node require resolves symlinks; smoke-verified on Windows in P0 |
| opentui native lock (if P2 option a chosen later) | Keep behind experimental flag; default stays zero-dep |

## 10. Acceptance criteria (definition of done)

1. Fresh clone on Windows/macOS/Linux updates all configured plugins current→latest with `OK` verification.
2. Missing config/cache path → candidates printed → TTY prompt; non-TTY → actionable error (no hang).
3. Locked files → nothing deleted, exit 3; with `--kill-blockers` → owners killed after confirmation, update proceeds.
4. P2 picker shows `(current)`/`(latest)` chips and installs the chosen version; `--list`/`--set` cover scripts.
5. CI green on full matrix; zero hardcoded paths in tracked files.
6. Public GitHub repo + npm package + ecosystem docs PR.

## 11. Milestones

| Milestone | Contents | Status |
|---|---|---|
| M1 | Core CLI (this repo: paths, probe, kill, install, verify, leftovers) | **done** |
| M2 | Version catalogue + `--list`/`--set`/`--yes` | pending |
| M3 | Interactive picker TUI (option b) + opentui spike | pending |
| M4 | Tests + CI matrix | pending |
| M5 | LICENSE/README, git commits, public repo, npm publish, docs PR | pending |

**Git sequence:** `git init` immediately after this plan lands → commits after review → public publish last (M5).

## 12. Naming research — 2026-10-08

Registry (npm dist-tags) + ecosystem check:

| Candidate | npm status | Notes |
| --- | --- | --- |
| `opencode-plugin-updater` | **taken (deprecated)** | forebay's archived repo; name blocked |
| `opencode-plugin-update-kit` | taken | alfaoz |
| `opencode-plugin-manager` | taken | optix2000 |
| `oc-plugin-updater` | **available** | concise `oc-*` CLI convention |
| `opencode-plugin-sync` | available | "sync" implies state-aware |
| `opencode-plugin-refresh` | available | action-oriented |
| `opencode-updater` | available | broadest scope |
| `opencode-plugin-cli` · `opencode-plugins-cli` · `opencode-plugin-doctor` | available | — |

Competitive landscape: all four known repos are tiny (0–1 stars), two archived/orphaned; none is a standalone cross-platform CLI with pre-delete lock handling. No official `opencode plugin update` command exists in the CLI.

Recommendation: publish under an available name (top pick `oc-plugin-updater`); keep the GitHub repo name aligned with the chosen package name.

