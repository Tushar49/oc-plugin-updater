#!/usr/bin/env node
/**
 * oc-plugin-updater — cross-platform updater for OpenCode npm plugins.
 *
 * Reads the `plugin` array from OpenCode's config (opencode.jsonc / tui.json),
 * resolves target versions from the npm registry, resets OpenCode's plugin
 * package cache, and reinstalls with your chosen package manager (pnpm or npm).
 *
 * - Zero runtime dependencies (Node >= 18)
 * - Never writes OpenCode config files
 * - Path resolution: env vars > OS defaults > interactive prompt
 * - `--kill-blockers` kills processes holding package files locked
 *
 * Exit codes: 0 ok · 1 install/verify failure · 2 usage/path error · 3 files locked
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync,
  readdirSync, statSync, openSync, closeSync, renameSync,
} from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, env, platform, argv, exit } from 'node:process';

const VERSION = '0.1.0';
const IS_WIN = platform === 'win32';

/* ---------------------------------------------------------------- colors -- */

const tty = Boolean(stdout.isTTY) && !('NO_COLOR' in env);
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1'), dim = paint('2'), cyan = paint('36'),
  green = paint('32'), red = paint('31'), yellow = paint('33'), magenta = paint('35');

const TICK = tty ? '\u2713' : 'OK';
const CROSS = tty ? '\u2717' : 'X';
const DOT = tty ? '\u2500' : '-';

function banner() {
  const w = 54;
  const line = DOT.repeat(w);
  stdout.write(`\n ${cyan(line)}\n`);
  stdout.write(` ${bold('oc-plugin-updater')}  ${dim('v' + VERSION)}\n`);
  stdout.write(` ${dim('cross-platform OpenCode npm-plugin updater')}\n`);
  stdout.write(` ${cyan(line)}\n\n`);
}

function section(title) {
  stdout.write(` ${magenta(bold(title))}\n`);
}

function row(label, value) {
  stdout.write(`   ${dim(label.padEnd(9))}${value}\n`);
}

function indent(text, prefix = '     ') {
  return String(text).trimEnd().split(/\r?\n/).map((l) => prefix + l).join('\n');
}

/* ------------------------------------------------------------ cli parsing -- */

const flags = { killBlockers: false, help: false, configDir: null, cacheDir: null, pm: null, list: false, dryRun: false, yes: false, all: false, pick: false, selftest: false, clean: false, rollback: false, doctor: false, backup: false, registry: null, set: [], only: [], remove: [] };
{
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    const takeValue = () => {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === '' || value.startsWith('--')) {
        console.error(`Missing value for ${key}`);
        exit(2);
      }
      return value;
    };
    if (key === '--kill-blockers') flags.killBlockers = true;
    else if (key === '--help' || key === '-h') flags.help = true;
    else if (key === '--config-dir') flags.configDir = takeValue();
    else if (key === '--cache-dir') flags.cacheDir = takeValue();
    else if (key === '--pm') flags.pm = takeValue();
    else if (key === '--list') flags.list = true;
    else if (key === '--dry-run') flags.dryRun = true;
    else if (key === '--yes' || key === '-y') flags.yes = true;
    else if (key === '--all') flags.all = true;
    else if (key === '--pick') flags.pick = true;
    else if (key === '--selftest') flags.selftest = true;
    else if (key === '--clean') flags.clean = true;
    else if (key === '--rollback') flags.rollback = true;
    else if (key === '--doctor') flags.doctor = true;
    else if (key === '--backup') flags.backup = true;
    else if (key === '--registry') flags.registry = takeValue();
    else if (key === '--remove') flags.remove.push(takeValue());
    else if (key === '--set') flags.set.push(takeValue());
    else if (key === '--only') flags.only.push(takeValue());
    else {
      console.error(`Unknown option: ${arg}\nRun with --help for usage.`);
      exit(2);
    }
  }
  if (flags.pm && !['pnpm', 'npm'].includes(flags.pm)) {
    console.error(`Invalid --pm value: ${flags.pm} (expected: pnpm or npm)`);
    exit(2);
  }
  if (flags.pick && flags.list) {
    console.error('--pick cannot be combined with --list.');
    exit(2);
  }
  if (flags.pick && flags.yes) {
    console.error('--pick cannot be combined with --yes (the picker is interactive).');
    exit(2);
  }
  const modes = [flags.list, flags.pick, flags.clean, flags.rollback, flags.doctor, flags.remove.length > 0].filter(Boolean).length;
  if (modes > 1) {
    console.error('--list, --pick, --clean, --remove, --rollback and --doctor are separate modes; use one at a time.');
    exit(2);
  }
  if (flags.registry && !/^https?:\/\//i.test(flags.registry)) {
    console.error(`Invalid --registry URL: ${flags.registry} (expected http(s)://...)`);
    exit(2);
  }
}
const REGISTRY = (flags.registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
if (flags.help) {
  stdout.write(`
oc-plugin-updater — update OpenCode npm plugins without the installer TUI

Usage:
  node bin/cli.mjs [options]        # or: npx oc-plugin-updater  ·  pnpm dlx oc-plugin-updater
  updater.ps1 [options]             # Windows convenience shim

Options:
  --list               print the full version catalogue for each plugin and exit
  --pick               choose versions interactively (arrows, space, enter; needs a TTY)
  --set <name@ver>     target an exact version/tag for a plugin (repeatable)
  --clean              remove cached wrappers whose plugin is no longer in any config
  --remove <name>      delete a plugin's cached wrappers (config is never touched)
  --backup             snapshot wrappers to a backup dir before replacing them
  --rollback           restore the most recent backup of each updated wrapper
  --doctor             report paths, config generation, cache layout, locks, tools
  --registry <url>     use a custom npm registry (mirror) for lookups and installs
  --only <name>        process only the named plugin (repeatable)
  --dry-run            show what would change; touch nothing
  --yes, -y            skip the confirmation prompt (non-interactive)
  --all                with --list, show every version (default caps at 30)
  --pm <pnpm|npm>      package manager to use (asks when both are installed)
  --config-dir <path>  override OpenCode config directory detection
  --cache-dir <path>   override plugin package cache detection
  --kill-blockers      kill processes locking package files (asks first on a TTY)
  -h, --help           show this help

Path resolution (first existing wins; prompts when nothing is found):
  config  $OPENCODE_CONFIG_DIR > dirname($OPENCODE_CONFIG) > $XDG_CONFIG_HOME/opencode
          > ~/.config/opencode > %APPDATA%\\opencode / %LOCALAPPDATA%\\opencode (Windows)
  cache   $XDG_CACHE_HOME/opencode/packages > ~/.cache/opencode/packages
          > %LOCALAPPDATA%\\opencode\\packages > %APPDATA%\\opencode\\packages (Windows)

Config files are read-only for this tool. Never writes opencode.jsonc / tui.json.
`);
  exit(0);
}

/* --------------------------------------------------------------- prompts -- */

const rl = tty ? createInterface({ input: stdin, output: stdout }) : null;

async function ask(question, { defaultValue = '', validate } = {}) {
  for (;;) {
    const hint = defaultValue ? dim(` [${defaultValue}]`) : '';
    const answer = (await rl.question(`   ${question}${hint}: `)).trim() || defaultValue;
    const error = validate ? validate(answer) : null;
    if (!error) return answer;
    stdout.write(`   ${yellow('!')} ${error}\n`);
  }
}

async function confirm(question) {
  const answer = (await rl.question(`   ${question} ${dim('[y/N]')}: `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/* ------------------------------------------------------ path resolution --- */

const existsDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function configCandidates() {
  const list = [];
  if (env.OPENCODE_CONFIG_DIR) list.push(env.OPENCODE_CONFIG_DIR);
  if (env.OPENCODE_CONFIG) list.push(dirname(env.OPENCODE_CONFIG));
  if (env.XDG_CONFIG_HOME) list.push(join(env.XDG_CONFIG_HOME, 'opencode'));
  list.push(join(homedir(), '.config', 'opencode'));
  if (IS_WIN) {
    if (env.APPDATA) list.push(join(env.APPDATA, 'opencode'));
    if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'opencode'));
  }
  return [...new Set(list)];
}

function cacheCandidates(base) {
  const list = [];
  if (env.XDG_CACHE_HOME) list.push(join(env.XDG_CACHE_HOME, 'opencode', base));
  list.push(join(homedir(), '.cache', 'opencode', base));
  if (IS_WIN) {
    if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'opencode', base));
    if (env.APPDATA) list.push(join(env.APPDATA, 'opencode', base));
  }
  return [...new Set(list)];
}

const cacheHasEntries = (p) => { try { return readdirSync(p).length > 0; } catch { return false; } };

const configHasMarker = (dir) =>
  ['opencode.json', 'opencode.jsonc', 'tui.json', 'tui.jsonc'].some((f) => existsSync(join(dir, f)));

async function resolveDir(kind, candidates, markerFn) {
  const existing = candidates.filter(existsDir);
  const marked = existing.filter(markerFn);
  if (marked.length) return { path: marked[0], source: 'default' };
  if (existing.length) return { path: existing[0], source: 'default' };
  if (!rl) {
    throw Object.assign(
      new Error(`${kind} directory not found.`),
      { exitCode: 2, detail: `Candidates tried:\n  ${candidates.join('\n  ')}\nRun in an interactive terminal to enter the path manually.` },
    );
  }
  stdout.write(`   ${yellow('!')} ${kind} directory not found. Candidates tried:\n`);
  candidates.forEach((c) => stdout.write(`     ${dim(c)}\n`));
  const fallback = candidates[0];
  const path = await ask(`Enter ${kind} directory path`, {
    defaultValue: fallback,
    validate: (p) => (existsDir(p) ? null : `No such directory: ${p}`),
  });
  return { path, source: 'prompted' };
}

/* ---------------------------------------------------------------- jsonc --- */

function parseJsonc(text) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// Which config generation is in use — v1 `plugin`, v2 `plugins`, or both.
function configGeneration(configDir) {
  let hasV1 = false;
  let hasV2 = false;
  for (const f of ['opencode.jsonc', 'opencode.json', 'tui.json', 'tui.jsonc', 'cli.json']) {
    const path = join(configDir, f);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) continue;
    try {
      const cfg = parseJsonc(raw);
      if (cfg.plugin) hasV1 = true;
      if (cfg.plugins) hasV2 = true;
    } catch { /* parse errors surface in the normal run */ }
  }
  if (hasV1 && hasV2) return 'mixed';
  if (hasV2) return 'v2';
  if (hasV1) return 'v1';
  return 'unknown';
}

function readPluginSpecs(configDir) {
  const specs = new Set();
  const push = (entry) => {
    if (Array.isArray(entry)) { // v1 tuple: ["pkg", { options }]
      if (typeof entry[0] === 'string' && entry[0].trim()) specs.add(entry[0].trim());
      return;
    }
    if (typeof entry === 'string') {
      if (entry.trim()) specs.add(entry.trim());
      return;
    }
    if (entry && typeof entry === 'object') {
      for (const key of ['spec', 'package', 'name', 'id']) {
        if (typeof entry[key] === 'string' && entry[key].trim()) { specs.add(entry[key].trim()); return; }
      }
    }
  };
  for (const file of ['opencode.jsonc', 'opencode.json', 'tui.json', 'tui.jsonc']) {
    const path = join(configDir, file);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) continue; // some tools leave empty placeholder configs behind
    let cfg;
    try {
      cfg = parseJsonc(raw);
    } catch (err) {
      throw Object.assign(new Error(`Cannot parse ${path}: ${err.message}`), { exitCode: 2 });
    }
    for (const spec of cfg.plugin ?? []) push(spec);  // v1: array of strings
    for (const spec of cfg.plugins ?? []) push(spec); // v2: array of objects (defensive: strings too)
  }
  return [...specs];
}

/* ------------------------------------------------------------- registry --- */

function splitSpec(spec) {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash < 0) throw new Error(`Invalid plugin spec: ${spec}`);
    const at = spec.indexOf('@', slash);
    if (at < 0) return { name: spec, ref: 'latest' };
    return { name: spec.slice(0, at), ref: spec.slice(at + 1) };
  }
  const at = spec.indexOf('@');
  if (at < 0) return { name: spec, ref: 'latest' };
  return { name: spec.slice(0, at), ref: spec.slice(at + 1) };
}

// Local files/directories and URLs are not npm packages — the updater cannot install them.
function isLocalSpec(spec) {
  const s = String(spec).trim();
  if (/^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(s)) return true; // ./x  ../x  /x  C:\x
  if (/^(file|https?|git|git\+ssh|ssh):/i.test(s) || s.includes('://')) return true;
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(s); // ./plugin/local.ts
}

const SAFE_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const SAFE_VERSION_REF = /^[A-Za-z0-9._+-]+$/;

// Reject anything that could break the registry URL or be interpreted by a
// shell (Windows runs package managers through cmd.exe /c).
function assertSafeSpec(name, ref) {
  if (!SAFE_PACKAGE_NAME.test(name) || !SAFE_VERSION_REF.test(ref)) {
    throw Object.assign(new Error(`Unsafe package reference: ${name}@${ref}`), { exitCode: 2 });
  }
}

async function resolveTarget(name, ref) {
  const url = `${REGISTRY}/-/package/${name.replaceAll('/', '%2F')}/dist-tags`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const tags = await res.json();
      if (Object.hasOwn(tags, ref)) return { version: tags[ref], tag: ref, tags };
      return { version: ref, tag: null, tags };
    }
  } catch { /* fall through */ }
  if (/^\d+\.\d+\.\d+/.test(ref)) return { version: ref, tag: null, tags: null };
  throw Object.assign(new Error(`Could not resolve "${ref}" for ${name} from the npm registry.`), { exitCode: 1 });
}

/* ------------------------------------------------------ wrappers & locks -- */

function wrapperRoots(pkgRoot, name) {
  return readdirSync(pkgRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name === name || e.name.startsWith(name + '@')))
    .map((e) => join(pkgRoot, e.name));
}

// Installed version inside a wrapper, tolerating both cache generations:
// v1 `<wrapper>/node_modules/<name>` and v2 `<wrapper>/<timestamp>/node_modules/<name>`.
function installedVersionIn(wrapperRoot, name) {
  const pj = join(wrapperRoot, 'node_modules', name, 'package.json');
  if (existsSync(pj)) {
    try { return JSON.parse(readFileSync(pj, 'utf8')).version; } catch { return null; }
  }
  try {
    for (const e of readdirSync(wrapperRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
      const nested = join(wrapperRoot, e.name, 'node_modules', name, 'package.json');
      if (existsSync(nested)) {
        try { return JSON.parse(readFileSync(nested, 'utf8')).version; } catch { return null; }
      }
    }
  } catch { /* unreadable wrapper */ }
  return null;
}

function walkNativeFiles(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(dll|node)$/i.test(e.name)) found.push(p);
    }
  }
  return found;
}

const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;

function probeLocked(files) {
  if (!files.length || !IS_WIN) return []; // unix: deletion errors surface per-directory instead
  const list = files.map(psQuote).join(',');
  const cmd =
    `$ErrorActionPreference='SilentlyContinue'; ` +
    `foreach($f in @(${list})){ try { $fs=[System.IO.File]::Open($f,'Open','ReadWrite','None'); $fs.Close() } catch { Write-Output $f } }`;
  const res = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 30000 });
  return String(res.stdout ?? '').split(/\r?\n/).filter(Boolean);
}

function findBlockerPids(files) {
  if (IS_WIN) {
    const list = files.map(psQuote).join(',');
    const cmd =
      `$ErrorActionPreference='SilentlyContinue'; ` +
      `$paths=@(${list}); ` +
      `Get-Process | ForEach-Object { $proc=$_; try { foreach($m in $proc.Modules){ if($paths -contains $m.FileName){ Write-Output ("{0}|{1}" -f $proc.Id, $proc.ProcessName); break } } } catch {} }`;
    const res = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 60000 });
    return String(res.stdout ?? '').split(/\r?\n/).filter(Boolean).map((line) => {
      const [id, name] = line.split('|');
      return { pid: Number(id), name: name || 'unknown' };
    }).filter((p) => Number.isInteger(p.pid) && p.pid !== process.pid);
  }
  const lsof = spawnSync('lsof', ['-t', ...files], { encoding: 'utf8', timeout: 30000 });
  const pids = [...new Set(String(lsof.stdout ?? '').split(/\r?\n/).map(Number).filter(Boolean))];
  return pids.map((pid) => {
    const comm = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    return { pid, name: String(comm.stdout ?? '').trim() || 'unknown' };
  }).filter((p) => p.pid !== process.pid);
}

async function killBlockers(blockers) {
  stdout.write(`   ${yellow('!')} processes holding package files:\n`);
  blockers.forEach((b) => stdout.write(`     ${b.name} ${dim(`(pid ${b.pid})`)}\n`));
  if (rl && !(await confirm('Kill them?'))) {
    throw Object.assign(new Error('Aborted: blockers not killed.'), { exitCode: 3 });
  }
  for (const b of blockers) {
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(b.pid), '/F', '/T']);
    else { try { process.kill(b.pid, 'SIGTERM'); } catch { /* already gone */ } }
  }
  await new Promise((r) => setTimeout(r, 700));
  for (const b of blockers) {
    if (!IS_WIN) { try { process.kill(b.pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  stdout.write(`   ${green(TICK)} killed ${blockers.length} process(es)\n`);
}

/* ----------------------------------------------------- package manager --- */

// Shell-free subprocess helper. On Windows, package-manager commands are .cmd
// shims, so we invoke cmd.exe explicitly instead of shell:true — that keeps argv
// escaping intact and avoids Node's DEP0190 deprecation warning.
function runCommand(pm, args, cwd) {
  const options = { encoding: 'utf8', timeout: 300000 };
  if (cwd) options.cwd = cwd;
  if (IS_WIN) {
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    return spawnSync(comspec, ['/d', '/c', pm, ...args], options);
  }
  return spawnSync(pm, args, options);
}

function runInteractive(pm, args, cwd) {
  if (IS_WIN) {
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    return spawnSync(comspec, ['/d', '/c', pm, ...args], { cwd, stdio: 'inherit' });
  }
  return spawnSync(pm, args, { cwd, stdio: 'inherit' });
}

function availablePackageManagers() {
  return ['pnpm', 'npm'].filter((pm) => {
    const probe = runCommand(pm, ['--version']);
    return !probe.error && probe.status === 0;
  });
}

async function choosePackageManager(requested) {
  const available = availablePackageManagers();
  if (!available.length) {
    throw Object.assign(
      new Error('No package manager found (tried pnpm, npm).'),
      { exitCode: 2, detail: 'Install pnpm (https://pnpm.io/installation), or ensure npm is on PATH.' },
    );
  }
  if (requested) {
    if (!available.includes(requested)) {
      throw Object.assign(new Error(`--pm ${requested} is not installed or not on PATH.`), { exitCode: 2 });
    }
    return requested;
  }
  if (available.length === 1 || !rl || flags.yes) return available[0]; // pnpm preferred, npm fallback
  return ask(`Package manager to use ${dim(`(${available.join(' / ')})`)}`, {
    defaultValue: available[0],
    validate: (v) => (available.includes(v) ? null : `Choose one of: ${available.join(', ')}`),
  });
}

const SAVE_EXACT = { pnpm: ['--save-exact'], npm: ['--save-exact'] };

// pnpm >= 10 blocks dependency build scripts by default; the add still exits
// non-zero with this signature. We handle it inside the run instead of leaving
// the user at an external prompt.
const IGNORED_BUILDS = /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i;

async function resolveIgnoredBuilds(pm, dir, name) {
  stdout.write(`   ${yellow('!')} ${pm} blocked build scripts for ${name} (dependency build approval)\n`);
  const approveCmd = pm === 'npm' ? 'rebuild' : 'approve-builds';
  if (!rl || flags.yes) {
    stdout.write(`     ${dim(`run manually: cd "${dir}" && ${pm} ${approveCmd}`)}\n`);
    return false;
  }
  if (!(await confirm(`Run ${pm} ${approveCmd} now?`))) return false;
  stdout.write(`   ${dim(`running: ${pm} ${approveCmd} (in ${dir})`)}\n`);
  rl.pause();
  const res = runInteractive(pm, [approveCmd], dir);
  rl.resume();
  if (res.error || res.status !== 0) {
    stdout.write(`   ${red(CROSS)} ${pm} ${approveCmd} exited ${res.status ?? 'error'}\n`);
    return false;
  }
  stdout.write(`   ${green(TICK)} build scripts approved for ${name}\n`);
  return true;
}

async function installWith(pm, name, version, dir) {
  assertSafeSpec(name, version);
  writeFileSync(join(dir, 'package.json'),
    JSON.stringify({ name: name + '-opencode-plugin-wrapper', version: '0.0.0', private: true }, null, 2));
  const args = ['add', `${name}@${version}`, ...(SAVE_EXACT[pm] ?? ['--save-exact'])];
  if (flags.registry) args.push('--registry', flags.registry);
  const res = runCommand(pm, args, dir);
  const output = String(res.stdout ?? '') + String(res.stderr ?? '');
  if (output.trim()) stdout.write(indent(output));
  if (res.status === 0) return;
  if (pm === 'pnpm' && IGNORED_BUILDS.test(output)) {
    if (await resolveIgnoredBuilds(pm, dir, name)) return;
    throw Object.assign(
      new Error(`pnpm blocked build scripts for ${name}. Approve them, then re-run.`),
      { exitCode: 1 },
    );
  }
  throw Object.assign(new Error(`${pm} add ${name}@${version} failed (exit ${res.status}).`), { exitCode: 1 });
}

/* ------------------------------------------------------------- leftovers -- */

function reportLeftovers(configDir, pkgRoot, plans) {
  const items = [];
  const known = new Set(plans.map((p) => p.name));
  try {
    for (const e of readdirSync(pkgRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const base = e.name.replace(/@[^@]*$/, '');
      if (!known.has(base)) items.push(`cache: ${join(pkgRoot, e.name)} ${dim('(plugin not in config array — kept)')}`);
    }
  } catch { /* cache may be fully consumed */ }

  const manifest = join(configDir, 'package.json');
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      for (const field of ['dependencies', 'devDependencies', 'allowScripts']) {
        for (const key of Object.keys(pkg[field] ?? {})) {
          const base = key.replace(/@[^@]*$/, '');
          if (known.has(base)) items.push(`config: package.json ${field}["${key}"] ${dim('(stale — config not touched)')}`);
        }
      }
    } catch { /* unreadable manifest */ }
  }

  const stateRoots = [
    env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, 'opencode') : null,
    join(homedir(), '.local', 'state', 'opencode'),
    join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode'),
    configDir,
  ].filter(Boolean);
  for (const stateFile of ['plugin-meta.json']) {
    const hit = stateRoots.find((root) => existsSync(join(root, stateFile)));
    if (hit) items.push(`state: ${join(hit, stateFile)} ${dim('(OpenCode regenerates it)')}`);
  }

  if (items.length) {
    stdout.write(`\n ${magenta(bold('Leftovers (reported, not touched)'))}\n`);
    items.forEach((i) => stdout.write(`   ${dim('-')} ${i}\n`));
  }
}

/* ------------------------------------------------------------ catalogue --- */

function compareSemver(a, b) {
  const parse = (v) => {
    const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : null };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (!pa.pre && pb.pre) return 1;   // release > prerelease
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && !pb.pre) return 0;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) { if (Number(x) !== Number(y)) return Number(x) - Number(y); }
    else if (xn) return -1;          // numeric identifiers sort before alphanumeric
    else if (yn) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function fetchVersionList(name) {
  const url = `${REGISTRY}/${name.replaceAll('/', '%2F')}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { versions: Object.keys(data.versions ?? {}), tags: data['dist-tags'] ?? {} };
  } catch {
    return null;
  }
}

const CATALOGUE_CAP = 30;

async function printCatalogue(plans, showAll) {
  let ok = true;
  for (const p of plans) {
    const info = await fetchVersionList(p.name);
    if (!info) { ok = false; stdout.write(`\n   ${red(CROSS)} ${p.name}: registry lookup failed\n`); continue; }
    const tagByVersion = new Map();
    for (const [tag, ver] of Object.entries(info.tags)) if (!tagByVersion.has(ver)) tagByVersion.set(ver, tag);
    const sorted = info.versions.slice().sort((a, b) => compareSemver(b, a));
    const shown = showAll ? sorted : sorted.slice(0, CATALOGUE_CAP);
    const installedNote = p.installed
      ? (info.versions.includes(p.installed) ? '' : ` ${yellow('(not published)')}`)
      : '';
    stdout.write(`\n   ${bold(p.name)}  ${dim('installed')} ${p.installed ?? 'none'}${installedNote}\n`);
    for (const ver of shown) {
      const marks = [];
      if (ver === p.installed) marks.push(dim('current'));
      if (tagByVersion.has(ver)) marks.push(green(tagByVersion.get(ver)));
      stdout.write(`     ${ver}${marks.length ? '  ' + marks.join(' ') : ''}\n`);
    }
    if (shown.length < sorted.length) {
      stdout.write(`     ${dim(`… ${sorted.length - shown.length} more (use --all)`)}\n`);
    }
  }
  return ok;
}

/* --------------------------------------------------------------- picker --- */

function parseKeys(input) {
  const keys = [];
  const arrows = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\x1b') {
      const rest = input.slice(i);
      const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
      const ss3 = csi ? null : /^\x1bO([A-Za-z])/.exec(rest);
      const m = csi || ss3;
      if (m) {
        const final = csi ? m[2] : m[1];
        if (arrows[final]) keys.push({ type: arrows[final] });
        else if (csi && final === '~' && m[1] === '5') keys.push({ type: 'pageup' });
        else if (csi && final === '~' && m[1] === '6') keys.push({ type: 'pagedown' });
        else keys.push({ type: 'unknown' });
        i += m[0].length - 1;
        continue;
      }
      keys.push({ type: 'esc' });
      continue;
    }
    if (ch === '\r' || ch === '\n') keys.push({ type: 'enter' });
    else if (ch === '\x7f' || ch === '\b') keys.push({ type: 'backspace' });
    else if (ch === '\x03') keys.push({ type: 'ctrl-c' });
    else if (ch >= ' ') keys.push({ type: 'char', char: ch });
  }
  return keys;
}

function buildPickerRows(plans, lists, filter = '', showAll = false) {
  const rows = [];
  const needle = filter.trim().toLowerCase();
  plans.forEach((p, pi) => {
    const info = lists[pi];
    if (!info) { rows.push({ kind: 'error', plugin: pi, name: p.name }); return; }
    const tagByVersion = new Map();
    for (const [tag, ver] of Object.entries(info.tags)) {
      if (!tagByVersion.has(ver)) tagByVersion.set(ver, tag);
    }
    const sorted = info.versions.slice().sort((a, b) => compareSemver(b, a));
    const nameMatch = Boolean(needle) && p.name.toLowerCase().includes(needle);
    const matching = needle ? sorted.filter((v) => v.toLowerCase().includes(needle)) : sorted;
    const versions = nameMatch && !matching.length ? sorted : matching;
    if (needle && !versions.length) return;
    rows.push({ kind: 'header', plugin: pi, name: p.name });
    const shown = showAll ? versions : versions.slice(0, CATALOGUE_CAP);
    for (const ver of shown) {
      rows.push({ kind: 'version', plugin: pi, version: ver, tag: tagByVersion.get(ver) ?? null });
    }
  });
  return rows;
}

const isVersionRow = (r) => Boolean(r) && r.kind === 'version';

function firstVersionRow(rows) {
  return rows.findIndex(isVersionRow);
}

function stepCursor(rows, cursor, dir) {
  let i = cursor + dir;
  while (i >= 0 && i < rows.length) {
    if (isVersionRow(rows[i])) return i;
    i += dir;
  }
  return cursor;
}

function clampCursor(rows, cursor) {
  if (!rows.length) return -1;
  const i = Math.min(Math.max(cursor, 0), rows.length - 1);
  if (isVersionRow(rows[i])) return i;
  for (let d = 1; d < rows.length; d++) {
    if (isVersionRow(rows[i + d])) return i + d;
    if (isVersionRow(rows[i - d])) return i - d;
  }
  return -1;
}

function createPickerState(rows) {
  return {
    rows, cursor: firstVersionRow(rows), filter: '', filterMode: false,
    help: false, selected: new Map(), confirmed: false, cancelled: false,
  };
}

function pickerReduce(state, key) {
  const next = { ...state, selected: new Map(state.selected) };
  if (key.type === 'ctrl-c') { next.cancelled = true; return next; }
  if (key.type === 'esc') {
    if (state.filterMode) { next.filterMode = false; next.filter = ''; }
    else next.cancelled = true;
    return next;
  }
  if (key.type === 'enter') {
    if (state.filterMode) next.filterMode = false;
    else next.confirmed = true;
    return next;
  }
  if (key.type === 'up' || key.type === 'down' || key.type === 'pageup' || key.type === 'pagedown') {
    const dir = key.type === 'up' || key.type === 'pageup' ? -1 : 1;
    const steps = key.type === 'pageup' || key.type === 'pagedown' ? 10 : 1;
    let cursor = state.cursor;
    for (let n = 0; n < steps; n++) cursor = stepCursor(state.rows, cursor, dir);
    next.cursor = cursor;
    return next;
  }
  if (state.filterMode) {
    if (key.type === 'backspace') next.filter = state.filter.slice(0, -1);
    else if (key.type === 'char') next.filter = state.filter + key.char;
    return next;
  }
  if (key.type !== 'char') return next;
  if (key.char === 'j') next.cursor = stepCursor(state.rows, state.cursor, 1);
  else if (key.char === 'k') next.cursor = stepCursor(state.rows, state.cursor, -1);
  else if (key.char === '/') next.filterMode = true;
  else if (key.char === '?') next.help = !state.help;
  else if (key.char === 'q' || key.char === 'Q') next.cancelled = true;
  else if (key.char === ' ') {
    const row = state.rows[state.cursor];
    if (isVersionRow(row)) {
      if (state.selected.get(row.plugin)?.version === row.version) next.selected.delete(row.plugin);
      else next.selected.set(row.plugin, { version: row.version, tag: row.tag });
    }
  }
  return next;
}

function renderPicker(state, plans) {
  const lines = [];
  lines.push(`${bold('oc-plugin-updater')} ${dim('select versions')}`);
  lines.push(dim('up/down or j/k move · space select · enter confirm · esc cancel · / filter · ? help'));
  if (state.filterMode || state.filter) {
    lines.push(`${dim('filter:')} ${state.filter}${state.filterMode ? cyan('_') : ''}`);
  }
  lines.push('');
  for (const [i, r] of state.rows.entries()) {
    if (r.kind === 'header') {
      const p = plans[r.plugin];
      const picked = state.selected.get(r.plugin);
      const target = picked ? picked.version : p.version;
      const mark = picked ? green('*') : dim('o');
      const installed = p.installed ? `${dim('installed')} ${p.installed}` : dim('not installed');
      lines.push(`${mark} ${bold(p.name)}  ${installed}  ${dim('target')} ${bold(target)}`);
    } else if (r.kind === 'error') {
      lines.push(`  ${red(CROSS)} ${r.name} ${dim('registry lookup failed (keeps default target)')}`);
    } else {
      const p = plans[r.plugin];
      const picked = state.selected.get(r.plugin)?.version === r.version;
      const marks = [];
      if (r.version === p.installed) marks.push(dim('current'));
      if (r.tag) marks.push(green(r.tag));
      if (picked) marks.push(green('picked'));
      const cursor = i === state.cursor;
      lines.push(`${cursor ? cyan('>') : ' '} ${picked ? green('*') : ' '} ${r.version}${marks.length ? '  ' + marks.join(' ') : ''}`);
    }
  }
  if (state.help) {
    lines.push('');
    lines.push(dim('space sets the target version for the plugin under the cursor; unpicked plugins keep their default target.'));
  }
  lines.push('');
  return lines.join('\n');
}

function applyPickerSelection(plans, selected) {
  for (const [pi, pick] of selected) {
    const p = plans[pi];
    if (!p) continue;
    p.version = pick.version;
    p.tag = pick.tag;
    p.upToDate = p.installed === pick.version;
  }
}

async function runPicker(plans, lists, showAll) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw Object.assign(
      new Error('--pick needs an interactive terminal (stdin and stdout must be TTYs).'),
      { exitCode: 2, detail: 'Use --set name@version or --list in non-interactive shells.' },
    );
  }
  let state = createPickerState(buildPickerRows(plans, lists, '', showAll));
  if (state.cursor < 0) {
    throw Object.assign(new Error('No selectable versions (every registry lookup failed).'), { exitCode: 1 });
  }
  const hadRaw = typeof stdin.setRawMode === 'function';
  if (hadRaw) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdout.write('\x1b[?25l');
  const restore = () => {
    if (hadRaw) { try { stdin.setRawMode(false); } catch { /* ignore */ } }
    if (rl) rl.resume();
    stdout.write('\x1b[?25h');
  };
  try {
    for (;;) {
      stdout.write('\x1b[2J\x1b[H' + renderPicker(state, plans) + '\n');
      const chunk = await new Promise((resolve) => {
        const onData = (data) => { stdin.off('data', onData); resolve(String(data)); };
        stdin.on('data', onData);
      });
      for (const key of parseKeys(chunk)) {
        state = pickerReduce(state, key);
        state.rows = buildPickerRows(plans, lists, state.filter, showAll);
        state.cursor = clampCursor(state.rows, state.cursor);
        if (state.cancelled || state.confirmed) break;
      }
      if (state.cancelled || state.confirmed) break;
    }
  } finally {
    restore();
  }
  return state.cancelled ? null : state.selected;
}

/* ----------------------------------------------------------- maintenance -- */

const WRAPPER_DIR = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:@[A-Za-z0-9._+-]+)?$/;

function wrapperBase(dirName) {
  return dirName.replace(/@[^@]*$/, '');
}

function backupDirFor(cachePath) {
  return join(dirname(cachePath), 'oc-plugin-updater-backups');
}

// Abort (exit 3) when target files are held open, unless --dry-run (which never
// deletes) or --kill-blockers (which offers to kill the holders first).
async function ensureUnlocked(paths) {
  if (flags.dryRun) return;
  let locked = probeLocked(paths);
  if (locked.length && flags.killBlockers) {
    const blockers = findBlockerPids(locked);
    if (blockers.length) await killBlockers(blockers);
    locked = probeLocked(paths);
  }
  if (locked.length) {
    throw Object.assign(new Error(`${locked.length} file(s) are locked by running processes.`), {
      exitCode: 3,
      detail: 'Close OpenCode (or other holders) and re-run, or use --kill-blockers.',
    });
  }
}

function findOnPath(binaries) {
  const exts = IS_WIN ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const hits = [];
  for (const bin of binaries) {
    outer:
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = join(dir, bin + ext.toLowerCase());
        if (existsSync(p)) { hits.push({ bin, path: p }); break outer; }
      }
    }
  }
  return hits;
}

function binaryVersion(binPath) {
  const res = runCommand(binPath, ['--version']);
  const v = String(res.stdout ?? '').trim().split(/\r?\n/)[0];
  return res.error || res.status !== 0 || !v ? null : v;
}

function runDoctor(config, cache, localSpecs, npmSpecs) {
  section('Doctor');
  row('config', config.path);

  const files = ['opencode.jsonc', 'opencode.json', 'tui.json', 'tui.jsonc', 'cli.json'];
  const present = files.filter((f) => existsSync(join(config.path, f)));
  const emptyFiles = present.filter((f) => !readFileSync(join(config.path, f), 'utf8').trim());
  row('generation', configGeneration(config.path));
  row('files read', present.join(', ') || 'none');
  if (emptyFiles.length) row('empty files', emptyFiles.join(', ') + dim(' (skipped)'));
  row('npm specs', npmSpecs.join(', ') || 'none');
  if (localSpecs.length) row('local/URL specs', localSpecs.join(', ') + dim(' (skipped by the updater)'));

  const bins = findOnPath(['opencode', 'opencode2']);
  if (!bins.length) row('binaries', dim('opencode / opencode2 not found on PATH'));
  for (const b of bins) row(`bin ${b.bin}`, b.path + dim(` ${binaryVersion(b.path) ?? 'version unknown'}`));

  const wrappers = readdirSync(cache.path, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const stamped = wrappers.some((w) => {
    try { return readdirSync(join(cache.path, w)).some((d) => /^\d{10,}$/.test(d)); } catch { return false; }
  });
  const base = basename(cache.path);
  row('cache', cache.path);
  row('cache layout', (base === 'packages' ? 'v1 (packages)' : base === 'npm' ? 'v2 (npm)' : `custom (${base})`)
    + (stamped ? dim(' — timestamped installs') : ''));
  row('wrappers', wrappers.length ? wrappers.join(', ') : dim('none'));

  const lockFiles = wrappers.flatMap((w) => walkNativeFiles(join(cache.path, w)));
  const locked = probeLocked(lockFiles);
  row('locks', locked.length ? red(`${locked.length} file(s) locked`) : green('none'));

  for (const pm of ['pnpm', 'npm']) {
    const probe = runCommand(pm, ['--version']);
    row(`pm ${pm}`, probe.error || probe.status !== 0 ? dim('not found') : String(probe.stdout ?? '').trim());
  }
  if (flags.registry) row('registry', REGISTRY);

  const pseudo = npmSpecs.map((s) => ({ name: splitSpec(s).name }));
  reportLeftovers(config.path, cache.path, pseudo);
  stdout.write(`\n   ${green(TICK)} doctor complete — nothing was changed\n\n`);
  return 0;
}

async function runClean(config, cache, localSpecs, npmSpecs) {
  section('Clean');
  const known = new Set();
  for (const s of [...npmSpecs, ...localSpecs]) {
    const { name } = splitSpec(s);
    try { assertSafeSpec(name, 'latest'); known.add(name); } catch { /* unsafe names can never match wrappers */ }
  }

  let entries;
  try {
    entries = readdirSync(cache.path, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (err) {
    throw Object.assign(new Error(`Cannot read cache directory: ${err.message}`), { exitCode: 2 });
  }
  const nonWrapper = entries.filter((e) => !WRAPPER_DIR.test(e.name) || e.name === 'node_modules' || e.name.startsWith('.'));
  if (nonWrapper.length) stdout.write(`   ${dim('skipped (not plugin wrappers):')} ${nonWrapper.map((e) => e.name).join(', ')}\n`);

  const orphans = entries
    .filter((e) => WRAPPER_DIR.test(e.name) && e.name !== 'node_modules' && !e.name.startsWith('.') && !known.has(wrapperBase(e.name)))
    .map((e) => join(cache.path, e.name));
  if (!orphans.length) {
    stdout.write(`   ${green(TICK)} no orphans — every cached wrapper matches a configured plugin\n\n`);
    return 0;
  }
  stdout.write('   orphans (plugin no longer in any config):\n');
  orphans.forEach((c) => stdout.write(`     ${red('-')} ${c}\n`));

  if (!flags.dryRun) {
    if (!flags.yes && (!rl || !(await confirm(`Delete ${orphans.length} orphaned wrapper(s)?`)))) {
      stdout.write(`\n   ${rl ? dim('aborted by user') : red('refusing to proceed non-interactively (use --yes)')}\n\n`);
      return 0;
    }
    await ensureUnlocked(orphans.flatMap((c) => walkNativeFiles(c)));
    for (const c of orphans) {
      rmSync(c, { recursive: true, force: true });
      stdout.write(`   ${dim('-')} deleted ${c}\n`);
    }
  }
  stdout.write(flags.dryRun
    ? `\n   ${dim('dry run complete — no files changed')}\n\n`
    : `\n   ${green(bold(TICK))} clean complete\n\n`);
  return 0;
}

async function runRemove(cache) {
  section('Remove');
  const targets = new Set();
  for (const entry of flags.remove) {
    const { name } = splitSpec(entry);
    assertSafeSpec(name, 'latest');
    for (const root of wrapperRoots(cache.path, name)) targets.add(root);
  }
  if (!targets.size) {
    stdout.write(`   ${dim('no cached wrappers matched')} ${flags.remove.join(', ')}\n\n`);
    return 0;
  }
  [...targets].forEach((t) => stdout.write(`     ${red('-')} ${t}\n`));
  if (!flags.dryRun) {
    if (!flags.yes && (!rl || !(await confirm(`Delete ${targets.size} cached wrapper(s)? The OpenCode config is not touched.`)))) {
      stdout.write(`\n   ${rl ? dim('aborted by user') : red('refusing to proceed non-interactively (use --yes)')}\n\n`);
      return 0;
    }
    await ensureUnlocked([...targets].flatMap((t) => walkNativeFiles(t)));
    for (const t of targets) {
      rmSync(t, { recursive: true, force: true });
      stdout.write(`   ${dim('-')} deleted ${t}\n`);
    }
    stdout.write(`\n   ${yellow('!')} remember to remove ${flags.remove.join(', ')} from your OpenCode config (this tool never edits config)\n`);
  }
  stdout.write(flags.dryRun
    ? `\n   ${dim('dry run complete — no files changed')}\n\n`
    : `\n   ${green(bold(TICK))} remove complete\n\n`);
  return 0;
}

async function runRollback(cache) {
  section('Rollback');
  const bdir = backupDirFor(cache.path);
  const entries = existsSync(bdir)
    ? readdirSync(bdir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /@\d{12,}$/.test(e.name))
      .map((e) => ({ name: e.name, path: join(bdir, e.name), ts: e.name.match(/@(\d{12,})$/)[1] }))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    : [];
  if (!entries.length) {
    stdout.write(`   ${dim('no backups found at')} ${bdir}\n\n`);
    return 0;
  }
  const latest = new Map();
  for (const e of entries) {
    const base = e.name.replace(/@\d{12,}$/, '');
    if (!latest.has(base)) latest.set(base, e);
  }
  const restores = [...latest.entries()].map(([base, e]) => ({ base, backup: e.path, target: join(cache.path, base) }));
  restores.forEach((r) => stdout.write(`     ${cyan('~')} ${r.backup}\n         ${dim('->')} ${r.target}\n`));

  if (!flags.dryRun) {
    if (!flags.yes && (!rl || !(await confirm(`Restore ${restores.length} backup(s), replacing current wrappers?`)))) {
      stdout.write(`\n   ${rl ? dim('aborted by user') : red('refusing to proceed non-interactively (use --yes)')}\n\n`);
      return 0;
    }
    await ensureUnlocked(restores.filter((r) => existsSync(r.target)).flatMap((r) => walkNativeFiles(r.target)));
    for (const r of restores) {
      if (existsSync(r.target)) rmSync(r.target, { recursive: true, force: true });
      renameSync(r.backup, r.target);
      stdout.write(`   ${green(TICK)} restored ${r.base}\n`);
    }
  }
  stdout.write(flags.dryRun
    ? `\n   ${dim('dry run complete — no files changed')}\n\n`
    : `\n   ${green(bold(TICK))} rollback complete ${dim(`(older backups kept in ${bdir})`)}\n\n`);
  return 0;
}

/* -------------------------------------------------------------- selftest -- */

function runSelftest() {
  let passed = 0;
  let failed = 0;
  const check = (name, ok) => {
    if (ok) { passed++; stdout.write(`   ${green(TICK)} ${name}\n`); }
    else { failed++; stdout.write(`   ${red(CROSS)} ${name}\n`); }
  };

  check('parseKeys: up arrow', parseKeys('\x1b[A')[0]?.type === 'up');
  check('parseKeys: two keys in one chunk', parseKeys('\x1b[B\x1b[A').map((k) => k.type).join(',') === 'down,up');
  check('parseKeys: bare escape', parseKeys('\x1b')[0]?.type === 'esc');
  check('parseKeys: enter', parseKeys('\r')[0]?.type === 'enter');
  check('parseKeys: backspace', parseKeys('\x7f')[0]?.type === 'backspace');
  check('parseKeys: printable char', parseKeys('a')[0]?.char === 'a');

  check('spec: local paths detected', isLocalSpec('./plugin/local.ts') && isLocalSpec('../x') && isLocalSpec('file:./x') && isLocalSpec('C:\\x'));
  check('spec: url detected', isLocalSpec('https://example.com/p.ts'));
  check('spec: npm specs kept', !isLocalSpec('oh-my-openagent@latest') && !isLocalSpec('@scope/pkg') && !isLocalSpec('pkg'));

  check('wrappers: base name parsed', wrapperBase('oh-my-openagent@latest') === 'oh-my-openagent' && wrapperBase('@scope/pkg@1.0.0') === '@scope/pkg' && wrapperBase('pkg') === 'pkg');
  check('wrappers: candidate pattern', WRAPPER_DIR.test('pkg@latest') && WRAPPER_DIR.test('@scope/pkg') && WRAPPER_DIR.test('pkg'));

  const plans = [
    { name: 'alpha', version: '2.0.0', installed: '1.0.0' },
    { name: 'beta', version: '1.5.0', installed: null },
  ];
  const lists = [
    { versions: ['1.0.0', '2.0.0', '1.5.0'], tags: { latest: '2.0.0' } },
    { versions: ['1.5.0', '0.9.0'], tags: { latest: '1.5.0' } },
  ];
  const rows = buildPickerRows(plans, lists, '', false);
  check('rows: one header per plugin', rows.filter((r) => r.kind === 'header').length === 2);
  check('rows: versions sorted descending', rows.find((r) => r.kind === 'version' && r.plugin === 0)?.version === '2.0.0');
  check('rows: dist-tag attached', rows.find((r) => r.kind === 'version' && r.plugin === 1)?.tag === 'latest');
  check('rows: filter narrows versions', buildPickerRows(plans, lists, '1.5', false).filter((r) => r.kind === 'version').every((r) => r.version.includes('1.5')));
  check('render: plugins and cursor visible', renderPicker(createPickerState(rows), plans).includes('alpha') && renderPicker(createPickerState(rows), plans).includes('>'));

  let state = createPickerState(rows);
  check('state: cursor starts on a version', isVersionRow(rows[state.cursor]));
  const start = state.cursor;
  state = pickerReduce(state, { type: 'down' });
  check('reduce: down moves cursor', state.cursor !== start && isVersionRow(rows[state.cursor]));
  const row = state.rows[state.cursor];
  state = pickerReduce(state, { type: 'char', char: ' ' });
  check('reduce: space selects version', state.selected.get(row.plugin)?.version === row.version);
  state = pickerReduce(state, { type: 'char', char: ' ' });
  check('reduce: space toggles selection off', !state.selected.has(row.plugin));
  state = pickerReduce(state, { type: 'char', char: '/' });
  check('reduce: slash enters filter', state.filterMode === true);
  state = pickerReduce(state, { type: 'char', char: 'x' });
  check('reduce: filter appends chars', state.filter === 'x');
  state = pickerReduce(state, { type: 'backspace' });
  check('reduce: backspace removes chars', state.filter === '');
  state = pickerReduce(state, { type: 'esc' });
  check('reduce: esc leaves filter mode', state.filterMode === false && state.cancelled === false);
  state = pickerReduce(state, { type: 'esc' });
  check('reduce: esc cancels', state.cancelled === true);
  state = pickerReduce(createPickerState(rows), { type: 'enter' });
  check('reduce: enter confirms', state.confirmed === true);
  state = pickerReduce(createPickerState(rows), { type: 'ctrl-c' });
  check('reduce: ctrl-c cancels', state.cancelled === true);

  const applied = plans.map((p) => ({ ...p }));
  applyPickerSelection(applied, new Map([[0, { version: '1.5.0', tag: null }]]));
  check('apply: sets picked version', applied[0].version === '1.5.0');
  check('apply: recomputes upToDate', applied[0].upToDate === false);

  stdout.write(`\n   selftest: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

/* ---------------------------------------------------------------- main ---- */

async function main() {
  banner();

  for (const [flagName, value] of [['--config-dir', flags.configDir], ['--cache-dir', flags.cacheDir]]) {
    if (value && !existsDir(value)) {
      throw Object.assign(new Error(`${flagName} does not exist: ${value}`), { exitCode: 2 });
    }
  }

  section('Paths');
  const config = flags.configDir
    ? { path: flags.configDir, source: 'flag' }
    : await resolveDir('config', configCandidates(), configHasMarker);
  row('config', config.path + (config.source === 'prompted' ? dim(' (prompted)') : ''));

  const found = readPluginSpecs(config.path);
  const localSpecs = found.filter(isLocalSpec);
  const specs = found.filter((s) => !isLocalSpec(s));
  if (localSpecs.length) {
    stdout.write(`   ${yellow('!')} skipping local/URL plugin specs (not npm packages): ${localSpecs.join(', ')}\n`);
  }
  if (!specs.length) {
    throw Object.assign(new Error(
      localSpecs.length
        ? `Only local/URL plugin specs found in ${config.path} — nothing for this tool to update.`
        : `No plugin specs found in ${config.path}`,
    ), { exitCode: 2 });
  }
  row('plugins', specs.join(', '));

  // Cache base follows the config generation: v2 installs under `npm`, v1 under `packages`.
  const generation = configGeneration(config.path);
  const cacheBases = (generation === 'v2' || generation === 'mixed') ? ['npm', 'packages'] : ['packages', 'npm'];
  const cache = flags.cacheDir
    ? { path: flags.cacheDir, source: 'flag' }
    : await resolveDir('package cache', cacheBases.flatMap(cacheCandidates), cacheHasEntries);
  row('cache', cache.path + (cache.source === 'prompted' ? dim(' (prompted)') : ''));

  if (flags.doctor) return runDoctor(config, cache, localSpecs, specs);
  if (flags.clean) return runClean(config, cache, localSpecs, specs);
  if (flags.remove.length) return runRemove(cache);
  if (flags.rollback) return runRollback(cache);

  section('Versions');
  let plans = [];
  for (const spec of specs) {
    const { name, ref } = splitSpec(spec);
    assertSafeSpec(name, ref); // validated before any path or registry-URL use
    const target = await resolveTarget(name, ref);
    let installed = null;
    for (const root of wrapperRoots(cache.path, name)) {
      installed = installedVersionIn(root, name);
      if (installed) break;
    }
    plans.push({ spec, name, ...target, installed });
  }

  // --only: restrict processing to the named plugins.
  if (flags.only.length) {
    const wanted = new Set(flags.only.map((s) => s.trim()));
    const missing = [...wanted].filter((n) => !plans.some((p) => p.name === n));
    if (missing.length) stdout.write(`   ${yellow('!')} --only: not in config: ${missing.join(', ')}\n`);
    plans = plans.filter((p) => wanted.has(p.name));
    if (!plans.length) throw Object.assign(new Error('--only matched no configured plugins.'), { exitCode: 2 });
  }

  // --set name@version: override the target version for that plugin.
  for (const entry of flags.set) {
    const at = entry.lastIndexOf('@');
    if (at <= 0) throw Object.assign(new Error(`Invalid --set value: ${entry} (expected name@version)`), { exitCode: 2 });
    const setName = entry.slice(0, at);
    const setRef = entry.slice(at + 1);
    const hit = plans.find((p) => p.name === setName);
    if (!hit) throw Object.assign(new Error(`--set: ${setName} is not a selected/configured plugin.`), { exitCode: 2 });
    assertSafeSpec(setName, setRef);
    const t = await resolveTarget(setName, setRef);
    hit.version = t.version;
    hit.tag = t.tag;
    hit.upToDate = hit.installed === hit.version;
  }

  if (flags.list) {
    const ok = await printCatalogue(plans, flags.all);
    return ok ? 0 : 1;
  }

  if (flags.pick) {
    const lists = await Promise.all(plans.map((p) => fetchVersionList(p.name)));
    const selected = await runPicker(plans, lists, flags.all);
    if (!selected) {
      stdout.write(`\n   ${dim('aborted by user')}\n\n`);
      return 0;
    }
    applyPickerSelection(plans, selected);
  }

  const nameW = Math.max(...plans.map((p) => p.name.length), 7);
  stdout.write(`   ${dim('PLUGIN'.padEnd(nameW))}  ${dim('INSTALLED'.padEnd(22))}  ${dim('TARGET')}\n`);
  for (const p of plans) {
    const cur = p.installed
      ? (p.installed === p.version
        ? `${p.installed} ${dim('(current)')}`
        : `${p.installed} ${yellow('(current)')}`)
      : dim('not installed');
    const tgt = p.tag ? `${p.version} ${green(`(${p.tag})`)}` : p.version;
    stdout.write(`   ${p.name.padEnd(nameW)}  ${cur.padEnd(22)}  ${bold(tgt)}\n`);
    if (p.installed === p.version) p.upToDate = true;
  }
  const todo = plans.filter((p) => !p.upToDate);
  if (!todo.length) {
    stdout.write(`\n   ${green(TICK)} everything up to date — nothing to do\n\n`);
    reportLeftovers(config.path, cache.path, plans);
    return 0;
  }

  section('Safety');
  const nativeFiles = plans.flatMap((p) => wrapperRoots(cache.path, p.name).flatMap(walkNativeFiles));
  let locked = probeLocked(nativeFiles);
  if (locked.length) {
    stdout.write(`   ${yellow('!')} ${locked.length} package file(s) locked by a running process\n`);
    if (flags.killBlockers && !flags.dryRun) {
      const blockers = findBlockerPids(locked);
      if (!blockers.length) {
        throw Object.assign(new Error('Files are locked but no owning process could be identified.'), { exitCode: 3 });
      }
      await killBlockers(blockers);
      locked = probeLocked(locked);
    }
    if (locked.length && !flags.dryRun) {
      locked.forEach((f) => stdout.write(`     ${red(f)}\n`));
      throw Object.assign(new Error(
        'Package files are locked. Close OpenCode (or re-run with --kill-blockers) and try again.'),
        { exitCode: 3 });
    }
  } else {
    stdout.write(`   ${green(TICK)} no blocking locks\n`);
  }

  if (flags.dryRun) {
    section('Plan (dry run — nothing will change)');
    const pm = flags.pm ?? availablePackageManagers()[0] ?? '(none found)';
    for (const p of plans) {
      if (p.upToDate) { stdout.write(`   ${dim('-')} ${p.name} ${dim('skip (current)')}\n`); continue; }
      for (const root of wrapperRoots(cache.path, p.name)) stdout.write(`   ${dim('-')} would delete ${root}\n`);
      stdout.write(`   ${'+'} would install ${p.name}@${p.version} ${dim(`(${pm})`)}\n`);
    }
    if (locked.length) stdout.write(`   ${yellow('!')} locked right now — a real run would abort until OpenCode is closed\n`);
    stdout.write(`\n   ${dim('dry run complete — no files changed')}\n\n`);
    return 0;
  }

  if (rl && !flags.yes) {
    const ok = await confirm(`Update ${todo.length} plugin(s)? Old cached versions will be deleted.`);
    if (!ok) { stdout.write(`\n   ${dim('aborted by user')}\n\n`); return 0; }
  }

  section('Update');
  const pm = await choosePackageManager(flags.pm);
  row('manager', pm);
  if (flags.backup) row('backup', backupDirFor(cache.path));
  for (const p of plans) {
    if (p.upToDate) { stdout.write(`   ${dim('-')} ${p.name} ${dim('skip (current)')}\n`); continue; }
    let backupOf = null;
    for (const root of wrapperRoots(cache.path, p.name)) {
      if (flags.backup) {
        const bdir = backupDirFor(cache.path);
        mkdirSync(bdir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
        backupOf = join(bdir, `${basename(root)}@${stamp}`);
        renameSync(root, backupOf);
        stdout.write(`   ${dim('~')} backed up ${root} ${dim(`-> ${backupOf}`)}\n`);
      } else {
        rmSync(root, { recursive: true, force: true });
        stdout.write(`   ${dim('-')} deleted ${root}\n`);
      }
    }
    const dir = join(cache.path, p.spec);
    mkdirSync(dir, { recursive: true });
    stdout.write(`   ${'+'} ${p.name}@${p.version}\n`);
    try {
      await installWith(pm, p.name, p.version, dir);
    } catch (err) {
      if (backupOf && existsSync(backupOf)) {
        renameSync(backupOf, join(cache.path, basename(backupOf).replace(/@\d{12,}$/, '')));
        stdout.write(`   ${yellow('!')} install failed — previous wrapper restored\n`);
      }
      throw err;
    }
  }

  section('Verify');
  let failed = false;
  for (const p of plans) {
    let got = null;
    for (const root of wrapperRoots(cache.path, p.name)) {
      got = installedVersionIn(root, p.name);
      if (got) break;
    }
    if (got === p.version) stdout.write(`   ${green(TICK)} ${p.name} ${got}\n`);
    else { stdout.write(`   ${red(CROSS)} ${p.name} expected ${p.version}, got ${got ?? 'nothing'}\n`); failed = true; }
  }

  reportLeftovers(config.path, cache.path, plans);

  if (failed) throw Object.assign(new Error('Update finished with failures (see above).'), { exitCode: 1 });
  stdout.write(`\n   ${green(bold(TICK))} done — ${dim('restart OpenCode to load the new versions')}\n\n`);
  return 0;
}

if (flags.selftest) exit(runSelftest() ? 0 : 1);

main()
  .then((code) => exit(code))
  .catch((err) => {
    stdout.write(`\n   ${red(bold(CROSS))} ${err.message}\n`);
    if (err.detail) stdout.write(indent(err.detail) + '\n');
    stdout.write('\n');
    exit(err.exitCode ?? 1);
  })
  .finally(() => rl?.close());
