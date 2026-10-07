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

1. **Reads** the plugin list from your OpenCode config — `plugin` (v1) and `plugins` (v2) shapes, across `opencode.jsonc`, `opencode.json`, `tui.json`, `cli.json`.
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

### Flags

| Flag | Description |
| --- | --- |
| `--list` | Print the full version catalogue per plugin and exit. |
| `--set <name@version>` | Target an exact version/tag for a plugin (repeatable). |
| `--only <name>` | Process only the named plugin (repeatable). |
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
| **Package cache** | `$XDG_CACHE_HOME/opencode/packages` → `~/.cache/opencode/packages` → `%LOCALAPPDATA%\opencode\packages` → `%APPDATA%\opencode\packages` (Windows) |

Use `--config-dir` / `--cache-dir` to bypass detection entirely.

## OpenCode v1 and v2

Both config generations are read:

| | v1 | v2 |
| --- | --- | --- |
| Plugin list | `plugin`: array of strings / tuples | `plugins`: array of strings or objects |
| Terminal config | `tui.json(c)` | `cli.json` |
| Terminal settings file | layered | single global |

Config fields that v2 keeps for compatibility are still detected; the tool does not care which generation is installed.

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
