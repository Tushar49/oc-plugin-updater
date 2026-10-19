<div align="center">

# oc-plugin-updater

**Update your OpenCode npm plugins from one command — no installer TUI, zero config edits.**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#requirements)
[![Status](https://img.shields.io/badge/status-pre--release-orange.svg)](#)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

</div>

---

## The problem

OpenCode installs npm plugins with Bun at startup and caches them locally. Once a wrapper is cached, a bare `@latest` entry can keep resolving to the version that was downloaded first — even across restarts. There is **no official `opencode plugin update` command**, and the plugin-installer flow asks for choices you may not want to make.

## What this does

`oc-plugin-updater` is a small, dependency-free Node CLI that:

1. **Reads** the plugin list from your OpenCode config — the `plugin` (v1) and `plugins` (v2) shapes, across `opencode.jsonc` / `opencode.json` and the `tui.json(c)` variants.
2. **Resolves** the target version from the npm registry and shows `(current)` vs `(latest)` per plugin.
3. **Probes** for locked package files *before* deleting anything.
4. **Reinstalls** with **pnpm or npm** — you choose.
5. **Verifies** the result and reports leftovers it deliberately does not touch.

Your config files are never written to.

## Requirements

- Node.js **>= 18**
- `pnpm` or `npm` on `PATH` (both are supported; you pick which one runs)

## Usage

Zero-install (after publish):

```bash
npx oc-plugin-updater
# or
pnpm dlx oc-plugin-updater
```

From a checkout:

```bash
node bin/cli.mjs
```

Windows convenience shim:

```powershell
.\updater.ps1
```

### Explore and dry-run

```bash
node bin/cli.mjs --list                 # full version catalogue per plugin
node bin/cli.mjs --list --all           # every published version
node bin/cli.mjs --dry-run              # show the plan, change nothing
node bin/cli.mjs --set oh-my-openagent@5.1.20 --only oh-my-openagent --dry-run
```

### Pick versions interactively

```bash
node bin/cli.mjs --pick                 # choose targets with arrow keys
node bin/cli.mjs --pick --dry-run       # try the picker without touching the cache
```

`--pick` opens a full-screen picker: `↑`/`↓` (or `j`/`k`) move, `/` filters versions,
`Space` sets the target for the highlighted plugin, `Enter` confirms, `Esc` cancels, `?` shows help.
Unpicked plugins keep their default target. It requires a TTY; in scripts, use `--set` instead.

### Maintenance toolkit

```bash
node bin/cli.mjs --doctor                 # what does this machine look like?
node bin/cli.mjs --clean --dry-run        # which cached wrappers are orphans?
node bin/cli.mjs --clean                  # delete orphans (asks; --yes to skip)
node bin/cli.mjs --remove old-plugin      # drop a plugin's wrappers, keep config read-only
node bin/cli.mjs --rollback               # undo the last backed-up update
node bin/cli.mjs --backup                 # update with a safety snapshot first
node bin/cli.mjs --registry http://localhost:4873   # point lookups+installs at a mirror
```

`--backup` stores the previous wrapper in `oc-plugin-updater-backups/` next to the
cache directory. If an install fails, the previous wrapper is restored automatically;
`--rollback` restores the newest backup per wrapper on demand. Destructive modes
(`--clean`, `--remove`, `--rollback`) refuse to run non-interactively without `--yes`.

### Flags

| Flag | Description |
| --- | --- |
| `--list` | Print the full version catalogue per plugin and exit. |
| `--pick` | Choose target versions in an interactive picker (requires a TTY). |
| `--set <name@version>` | Target an exact version/tag for a plugin (repeatable). |
| `--only <name>` | Process only the named plugin (repeatable). |
| `--clean` | Remove cached wrappers whose plugin is no longer in any config. |
| `--remove <name>` | Delete a plugin's cached wrappers (config is never touched). |
| `--backup` | Snapshot wrappers to a backup dir before replacing them; a failed install auto-restores. |
| `--rollback` | Restore the most recent backup of each updated wrapper. |
| `--doctor` | Report paths, config generation (v1/v2), cache layout, locks, tools. |
| `--registry <url>` | Use a custom npm registry (mirror) for lookups and installs. |
| `--dry-run` | Show what would change; touches nothing. |
| `--yes`, `-y` | Skip the confirmation prompt (non-interactive). |
| `--all` | With `--list`, show every version (default caps at 30). |
| `--pm <pnpm\|npm>` | Package manager to use. When both are installed, the CLI asks. |
| `--config-dir <path>` | Override config-directory detection. |
| `--cache-dir <path>` | Override package-cache detection. |
| `--kill-blockers` | Find and kill processes holding package files. Asks for confirmation on a TTY. |
| `-h`, `--help` | Show usage. |

Exit codes: `0` success · `1` install/verify failure · `2` usage/path error · `3` files locked.

## How paths are detected

First existing candidate wins. When nothing is found, an interactive terminal is prompted for the path; otherwise the candidate list is printed and the run stops.

| | Detection order |
| --- | --- |
| **Config** | `$OPENCODE_CONFIG_DIR` → `dirname($OPENCODE_CONFIG)` → `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode` → `%APPDATA%\opencode` / `%LOCALAPPDATA%\opencode` (Windows) |
| **Package cache** | `packages` / `npm` bases under: `$XDG_CACHE_HOME/opencode` → `~/.cache/opencode` → `%LOCALAPPDATA%\opencode` / `%APPDATA%\opencode` (Windows). The base follows your config generation: v2 `plugins` configs prefer `npm`, v1 `plugin` configs prefer `packages`; both are tried automatically. |

Use `--config-dir` / `--cache-dir` to bypass detection entirely.

## OpenCode v1 and v2

Both config generations are read:

| | v1 | v2 |
| --- | --- | --- |
| Plugin list | `plugin`: array of strings / tuples | `plugins`: array of strings or objects |
| Terminal config | `tui.json(c)` | `cli.json` |
| Terminal settings file | layered | single global |

Config fields that v2 keeps for compatibility are still detected; the tool does not care which generation is installed.

Local-path plugin specs (for example `./plugin/local.ts` in a v2 `plugins` entry, or a v1 `[pkg, options]` tuple)
are not npm packages: they are skipped with a visible note instead of aborting the run. v2 semantics worth knowing:
exact version pins are immutable in v2, and `opencode plugin update <pkg>` exists there.

## Safety model

- **Never writes config.** `opencode.jsonc`, `tui.json`, `cli.json` — read-only, forever.
- **Never deletes while locked.** A lock probe runs first; the run aborts with exit code `3` instead of leaving a half-deleted cache.
- **`--kill-blockers` is opt-in** and always names the processes it is about to kill.
- **Leftovers are reported, not touched**: other cached plugins, stale manifest pins, and OpenCode state files are listed so you can decide.

## Troubleshooting

**"Package files are locked"** — OpenCode is running and has native plugin files loaded. Close it, or re-run with `--kill-blockers`.

**"node not found"** — the shim needs `node` on `PATH`. If you use a Node version manager, start the shell through it, or call `node bin/cli.mjs` directly.

**Versions look stale after updating** — OpenCode's startup installer may re-lay wrappers; the target version is what matters. Re-run the CLI to verify.

## Development

- Branch `main` is the public surface; branch `dev` carries active work plus `_archive/` (plans, notes).
- Zero runtime dependencies — Node builtins only.
- See [`AGENTS.md`](AGENTS.md) for contributor/agent conventions and [`CHANGELOG.md`](CHANGELOG.md) for release history.

## Contributing

Issues and PRs welcome. Keep contributions focused, cross-platform, and dependency-free.

## License

[MIT](LICENSE)
