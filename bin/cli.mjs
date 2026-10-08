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
  readdirSync, statSync, openSync, closeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
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

const flags = { killBlockers: false, help: false, configDir: null, cacheDir: null, pm: null, list: false, dryRun: false, yes: false, all: false, set: [], only: [] };
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
}
if (flags.help) {
  stdout.write(`
oc-plugin-updater — update OpenCode npm plugins without the installer TUI

Usage:
  node bin/cli.mjs [options]        # or: npx oc-plugin-updater  ·  pnpm dlx oc-plugin-updater
  updater.ps1 [options]             # Windows convenience shim

Options:
  --list               print the full version catalogue for each plugin and exit
  --set <name@ver>     target an exact version/tag for a plugin (repeatable)
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

function cacheCandidates() {
  const list = [];
  if (env.XDG_CACHE_HOME) list.push(join(env.XDG_CACHE_HOME, 'opencode', 'packages'));
  list.push(join(homedir(), '.cache', 'opencode', 'packages'));
  if (IS_WIN) {
    if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'opencode', 'packages'));
    if (env.APPDATA) list.push(join(env.APPDATA, 'opencode', 'packages'));
  }
  return [...new Set(list)];
}

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

function readPluginSpecs(configDir) {
  const specs = new Set();
  const push = (entry) => {
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
    const cfg = parseJsonc(readFileSync(path, 'utf8'));
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
  const url = `https://registry.npmjs.org/-/package/${name.replaceAll('/', '%2F')}/dist-tags`;
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
  const url = `https://registry.npmjs.org/${name.replaceAll('/', '%2F')}`;
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
  const cache = flags.cacheDir
    ? { path: flags.cacheDir, source: 'flag' }
    : await resolveDir('package cache', cacheCandidates(), () => true);
  row('cache', cache.path + (cache.source === 'prompted' ? dim(' (prompted)') : ''));

  const specs = readPluginSpecs(config.path);
  if (!specs.length) throw Object.assign(new Error(`No plugin specs found in ${config.path}`), { exitCode: 2 });
  row('plugins', specs.join(', '));

  section('Versions');
  let plans = [];
  for (const spec of specs) {
    const { name, ref } = splitSpec(spec);
    assertSafeSpec(name, ref); // validated before any path or registry-URL use
    const target = await resolveTarget(name, ref);
    let installed = null;
    for (const root of wrapperRoots(cache.path, name)) {
      const pj = join(root, 'node_modules', name, 'package.json');
      if (existsSync(pj)) {
        try { installed = JSON.parse(readFileSync(pj, 'utf8')).version; } catch { /* skip */ }
        break;
      }
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
  for (const p of plans) {
    if (p.upToDate) { stdout.write(`   ${dim('-')} ${p.name} ${dim('skip (current)')}\n`); continue; }
    for (const root of wrapperRoots(cache.path, p.name)) {
      rmSync(root, { recursive: true, force: true });
      stdout.write(`   ${dim('-')} deleted ${root}\n`);
    }
    const dir = join(cache.path, p.spec);
    mkdirSync(dir, { recursive: true });
    stdout.write(`   ${'+'} ${p.name}@${p.version}\n`);
    await installWith(pm, p.name, p.version, dir);
  }

  section('Verify');
  let failed = false;
  for (const p of plans) {
    const pj = join(cache.path, p.spec, 'node_modules', p.name, 'package.json');
    let got = null;
    try { got = JSON.parse(readFileSync(pj, 'utf8')).version; } catch { /* missing */ }
    if (got === p.version) stdout.write(`   ${green(TICK)} ${p.name} ${got}\n`);
    else { stdout.write(`   ${red(CROSS)} ${p.name} expected ${p.version}, got ${got ?? 'nothing'}\n`); failed = true; }
  }

  reportLeftovers(config.path, cache.path, plans);

  if (failed) throw Object.assign(new Error('Update finished with failures (see above).'), { exitCode: 1 });
  stdout.write(`\n   ${green(bold(TICK))} done — ${dim('restart OpenCode to load the new versions')}\n\n`);
  return 0;
}

main()
  .then((code) => exit(code))
  .catch((err) => {
    stdout.write(`\n   ${red(bold(CROSS))} ${err.message}\n`);
    if (err.detail) stdout.write(indent(err.detail) + '\n');
    stdout.write('\n');
    exit(err.exitCode ?? 1);
  })
  .finally(() => rl?.close());
