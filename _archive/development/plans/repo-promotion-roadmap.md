# oc-plugin-updater — Repo Promotion Roadmap

**Status:** living document (dev branch only — `_archive/` is git-ignored on `main`)
**Goal:** grow this from a working updater CLI into the reference tool for OpenCode plugin maintenance, and promote the repository as a public project.

---

## 1. Positioning

A standalone, cross-platform CLI that updates OpenCode npm plugins by resetting the plugin package cache and reinstalling — with pre-delete lock handling, package-manager choice, and no config writes. It fills a verified gap: **there is no official `opencode plugin update` command**, and every known alternative is an in-app plugin or a library.

## 2. Competitive parity matrix

| Capability | forebay/opencode-plugin-updater (archived) | Glaicer/supercode-plugin-updater | webdex-uk/…config-auto-updater | alfaoz/…update-kit | **us** |
| --- | --- | --- | --- | --- | --- |
| Standalone CLI | ✗ plugin | ✗ TUI plugin | ✗ plugin | ✗ library | **✓** |
| Cross-platform | partial | ✓ | partial | n/a | **✓** |
| Lock-aware pre-delete | ✗ | ✗ | ✗ | ✗ | **✓** |
| Package-manager choice (pnpm/npm) | ✗ | ✗ | ✗ | ✗ | **✓** |
| Scheduled/auto check | ✓ (poll repo list) | ✓ (daily, notify) | ✗ | ✗ | planned |
| In-app notify + apply on restart | n/a | ✓ | ✗ | n/a | planned (`--notify`) |
| Config-dir git sync | ✗ | ✗ | ✓ | ✗ | planned (optional) |
| Programmatic library API | ✗ | ✗ | ✗ | ✓ | planned |
| Version picker UI | ✗ | partial | ✗ | ✗ | planned (TUI) |
| Cleanup / orphan prune | ✗ | ✗ | ✗ | ✗ | planned |
| Handles pnpm build-script approval | ✗ | ✗ | ✗ | ✗ | planned (P0.5) |

**Where we already lead:** external, cross-platform, zero-dependency, lock-safe, pm-choice, leftovers reporting, config read-only. **Where we lag:** scheduled checks, in-app notification, TUI version selection, library API, cleanup utilities. **First gap closed:** unattended pnpm build-script approval (P0.5) — no competitor handles it.

## 3. Feature roadmap

### P0.5 — Update pipeline hardening (decided)

- **APPROVED — in-flow build approval:** detect pnpm's `ERR_PNPM_IGNORED_BUILDS` after `pnpm add` and run `pnpm approve-builds` in the wrapper (or retry with the allow-build flag) so the update completes inside the tool instead of leaving the user at an external prompt. No known alternative handles this — our clearest functional differentiator.
- **REJECTED — pre-emptive allow-list:** do not write `onlyBuiltDependencies` before install.
- **REJECTED — automatic atomic swap:** keep delete-then-install; no temp-dir + swap.
- **APPROVED — shell-free subprocesses:** replace `shell: true` with an explicit `cmd.exe /d /c` invocation on Windows; removes the `DEP0190` deprecation warning and the unescaped-argument risk.
- **REJECTED — workspace isolation:** no special handling for pnpm's `pnpm-workspace.yaml` side effects in v1.

### P1 — Version control surface
- `--list`: full version catalogue per plugin (registry `dist-tags` + abbreviated packument), semver-sorted, marked `(current)` / `(latest)` / `(beta)` / `(not published)`.
- `--set <plugin>@<version>`: pin an exact target; `--latest <plugin>` to bump one plugin only.
- `--dry-run`: print the full plan (deletes, installs) and change nothing.
- `--yes`: non-interactive confirmation for CI.

### P2 — Interactive TUI picker
- Arrow/j/k navigation, `/` filter-as-you-type, `Space` multi-select, `Enter` confirm, `Esc` cancel, `?` help.
- Colour chips for `latest`/`beta`/`current`; `NO_COLOR` + non-TTY fall back to P1 flags.
- Engine options researched: `@opentui/core` (host-identical look; ships native binaries → lock/kill friction) vs zero-dep ANSI raw-mode picker. **Decision: zero-dep picker first**; opentui spike behind `--tui=opentui`.

### P3 — Maintenance toolkit
- `--clean`: remove cache wrappers for plugins no longer in any config (orphan prune).
- `--remove <plugin>`: uninstall a plugin from the cache (and optionally from the config with explicit consent).
- `--backup` / `--rollback`: snapshot the previous wrapper before replacing; restore on failure.
- `--doctor`: report detected paths, layout, config generation (v1/v2), lock owners, and stale manifest pins.
- `--offline`: operate with a local registry mirror / cached manifest.

### P4 — Integrations & parity
- `--notify`: check on a schedule (Task Scheduler / launchd / cron sample) and print/desktop-notify when updates exist.
- Optional config-dir git sync (webdex parity) behind an explicit flag.
- Library export (`import { updatePlugins } from 'oc-plugin-updater'`) for embedding (alfaoz parity).
- Shell completions (bash/zsh/pwsh) + man page.

### P5 — Robustness
- Handle both cache layouts (`packages/<spec>/node_modules/<name>` and flat `node_modules/<name>`).
- Multi-registry support (npm, GitHub Packages, private mirrors) with per-registry auth passthrough.
- Structured `--json` output for automation.

## 4. UI/UX plan

- Section-based output (Paths / Versions / Safety / Update / Verify / Leftovers) — already shipped.
- Enhancements: progress spinner for installs, aligned diff-style `old → new` rows, final summary table, `--quiet` and `--verbose` levels.
- TUI: implement as pure render functions + IO layer so it is unit-testable without a terminal.

## 5. Quality & release engineering

- `node:test` unit suite: JSONC parser, spec splitting, path candidate ordering, marker rendering, v1/v2 config shapes.
- GitHub Actions matrix: `ubuntu / macos / windows × node 18 / 20 / 22` → `node --check`, unit tests, `--help` smoke.
- Release flow: bump version → update CHANGELOG → tag → `npm publish --access public` from a clean checkout.
- Regression gate: CI grep for hardcoded drive-letter paths and personal identifiers.

## 6. Repository promotion plan

1. **Branch discipline** — `main` = public surface (never `_archive/`); `dev` = work in progress. Promotion is a curated commit, not a straight merge.
2. **Docs** — README badges + usage; AGENTS.md for contributors; CHANGELOG per Keep a Changelog.
3. **Community** — submit to the OpenCode ecosystem/docs plugin list; open issues for the parity items above so contributors can claim them.
4. **Release artifacts** — GitHub Releases mirroring CHANGELOG; npm publish enables `npx oc-plugin-updater` / `pnpm dlx oc-plugin-updater`.
5. **Discoverability** — concise tagline, topic tags (`opencode`, `plugins`, `cli`, `updater`), example GIF of the run, comparison table vs the alternatives.
6. **Governance** — CONTRIBUTING.md, issue/PR templates, semantic versioning policy.

## 7. Milestones

| Milestone | Contents | Exit criteria |
| --- | --- | --- |
| M1 (done) | Core CLI, docs, license, branches | `node --check` clean; run reaches versions + lock handling |
| M2 | P0.5 pipeline hardening (build-approval) | Failed build triggers in-flow `pnpm approve-builds`; run completes without an external prompt |
| M2b | P1 flags (`--list`/`--set`/`--dry-run`/`--yes`) | Catalogue prints; chosen version installs |
| M3 | P2 TUI picker | Arrows/filter/select work; non-TTY fallback intact |
| M4 | P3 maintenance toolkit | `--clean`/`--doctor`/`--backup` verified on real cache |
| M5 | Tests + CI + first npm release | CI green on matrix; `npx oc-plugin-updater` works |
| M6 | Ecosystem listing + parity items | Listed in docs ecosystem; notify/library shipped |

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| OpenCode startup re-lays wrappers after updates | Verify step detects drift; document; version is what matters |
| Native file locks on Windows | Pre-delete probe; `--kill-blockers` |
| Plugin API/format changes (OpenCode v2) | Read both `plugin` and `plugins`; track `cli.json`; follow upstream migration guide |
| Name collisions on npm | Monitor registry; name reserved as `oc-plugin-updater` |
| TUI complexity creep | Zero-dep renderer first; opentui behind a flag |
| pnpm blocks dependency build scripts (observed with oh-my-openagent) | P0.5: detect `ERR_PNPM_IGNORED_BUILDS`, run `pnpm approve-builds` in-flow |
