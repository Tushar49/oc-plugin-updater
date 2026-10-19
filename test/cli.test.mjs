import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseJsonc, splitSpec, isLocalSpec, compareSemver, wrapperBase, WRAPPER_DIR,
  parseKeys, pickerReduce, buildPickerRows, clampCursor, applyPickerSelection,
  createPickerState, isVersionRow, configGeneration, npmrcTokenFor,
} from '../bin/cli.mjs';

test('parseJsonc strips comments and trailing commas', () => {
  const cfg = parseJsonc(`{
    // v1 list
    "plugin": ["a", /* block */ "b"],
    "nested": { "x": 1, },
  }`);
  assert.deepEqual(cfg.plugin, ['a', 'b']);
  assert.equal(cfg.nested.x, 1);
});

test('parseJsonc keeps comment-like text inside strings', () => {
  const cfg = parseJsonc('{ "url": "https://example.com//x" }');
  assert.equal(cfg.url, 'https://example.com//x');
});

test('splitSpec handles bare, pinned, scoped and scoped-pinned specs', () => {
  assert.deepEqual(splitSpec('pkg'), { name: 'pkg', ref: 'latest' });
  assert.deepEqual(splitSpec('pkg@1.2.3'), { name: 'pkg', ref: '1.2.3' });
  assert.deepEqual(splitSpec('@scope/pkg'), { name: '@scope/pkg', ref: 'latest' });
  assert.deepEqual(splitSpec('@scope/pkg@beta'), { name: '@scope/pkg', ref: 'beta' });
  assert.deepEqual(splitSpec('@scope/pkg@1.0.0+meta'), { name: '@scope/pkg', ref: '1.0.0+meta' });
});

test('isLocalSpec classifies paths, URLs and packages', () => {
  for (const s of ['./p.ts', '../p', 'file:./p', 'https://x/y', 'git+ssh://x', 'C:\\p']) {
    assert.equal(isLocalSpec(s), true, s);
  }
  for (const s of ['pkg', 'pkg@1.0.0', '@scope/pkg', 'pkg@latest']) {
    assert.equal(isLocalSpec(s), false, s);
  }
});

test('compareSemver orders releases above prereleases', () => {
  assert.ok(compareSemver('1.2.3', '1.10.0') < 0);
  assert.ok(compareSemver('2.0.0-rc.1', '2.0.0') < 0);
  assert.ok(compareSemver('2.0.0-rc.1', '2.0.0-rc.2') < 0);
  assert.ok(compareSemver('1.0.0-1', '1.0.0-alpha') < 0);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
});

test('wrapperBase strips refs and WRAPPER_DIR accepts wrapper names', () => {
  assert.equal(wrapperBase('pkg@latest'), 'pkg');
  assert.equal(wrapperBase('@scope/pkg@1.0.0'), '@scope/pkg');
  assert.equal(wrapperBase('pkg'), 'pkg');
  assert.ok(WRAPPER_DIR.test('pkg@latest'));
  assert.ok(WRAPPER_DIR.test('@scope/pkg'));
  assert.ok(!WRAPPER_DIR.test(''));
});

test('parseKeys tokenizes arrows, escapes and printable input', () => {
  assert.deepEqual(parseKeys('\x1b[A').map((k) => k.type), ['up']);
  assert.deepEqual(parseKeys('\x1b[B\x1b[A').map((k) => k.type), ['down', 'up']);
  assert.equal(parseKeys('\x1b')[0].type, 'esc');
  assert.equal(parseKeys('\r')[0].type, 'enter');
  assert.equal(parseKeys('\x7f')[0].type, 'backspace');
  assert.equal(parseKeys('a')[0].char, 'a');
});

function fixturePicker() {
  const plans = [
    { name: 'alpha', version: '2.0.0', installed: '1.0.0' },
    { name: 'beta', version: '1.5.0', installed: null },
  ];
  const lists = [
    { versions: ['1.0.0', '2.0.0', '1.5.0'], tags: { latest: '2.0.0' } },
    { versions: ['1.5.0', '0.9.0'], tags: { latest: '1.5.0' } },
  ];
  const rows = buildPickerRows(plans, lists, '', false);
  return { plans, lists, rows, state: createPickerState(rows) };
}

test('picker rows sort descending and carry dist-tags', () => {
  const { rows } = fixturePicker();
  assert.equal(rows.filter((r) => r.kind === 'header').length, 2);
  assert.equal(rows.find((r) => r.kind === 'version' && r.plugin === 0).version, '2.0.0');
  assert.equal(rows.find((r) => r.kind === 'version' && r.plugin === 1).tag, 'latest');
  assert.ok(isVersionRow(rows[createPickerState(rows).cursor]));
});

test('picker filter narrows version rows', () => {
  const { plans, lists } = fixturePicker();
  const filtered = buildPickerRows(plans, lists, '1.5', false)
    .filter((r) => r.kind === 'version');
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((r) => r.version.includes('1.5')));
});

test('picker reducer moves, selects, toggles, filters, cancels and confirms', () => {
  const { rows, state } = fixturePicker();
  const start = state.cursor;
  let s = pickerReduce(state, { type: 'down' });
  assert.notEqual(s.cursor, start);
  const row = rows[s.cursor];
  s = pickerReduce(s, { type: 'char', char: ' ' });
  assert.equal(s.selected.get(row.plugin)?.version, row.version);
  s = pickerReduce(s, { type: 'char', char: ' ' });
  assert.ok(!s.selected.has(row.plugin));
  s = pickerReduce(s, { type: 'char', char: '/' });
  assert.equal(s.filterMode, true);
  s = pickerReduce(s, { type: 'char', char: 'x' });
  assert.equal(s.filter, 'x');
  s = pickerReduce(s, { type: 'backspace' });
  assert.equal(s.filter, '');
  s = pickerReduce(s, { type: 'esc' });
  assert.equal(s.filterMode, false);
  s = pickerReduce(s, { type: 'esc' });
  assert.equal(s.cancelled, true);
  assert.equal(pickerReduce(createPickerState(rows), { type: 'enter' }).confirmed, true);
  assert.equal(pickerReduce(createPickerState(rows), { type: 'ctrl-c' }).cancelled, true);
  assert.ok(clampCursor(rows, 999) <= rows.length - 1);
});

test('applyPickerSelection sets version and recomputes upToDate', () => {
  const plans = [{ name: 'a', version: '2.0.0', installed: '1.5.0' }];
  applyPickerSelection(plans, new Map([[0, { version: '1.5.0', tag: null }]]));
  assert.equal(plans[0].version, '1.5.0');
  assert.equal(plans[0].upToDate, true);
});

test('configGeneration reports v1, v2, mixed and unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocpu-test-'));
  const empty = mkdtempSync(join(tmpdir(), 'ocpu-empty-'));
  try {
    writeFileSync(join(dir, 'opencode.jsonc'), '{ "plugins": ["pkg"] }');
    writeFileSync(join(dir, 'tui.json'), '');
    assert.equal(configGeneration(dir), 'v2');
    writeFileSync(join(dir, 'tui.jsonc'), '{ "plugin": ["pkg"] }');
    assert.equal(configGeneration(dir), 'mixed');
    rmSync(join(dir, 'opencode.jsonc'));
    assert.equal(configGeneration(dir), 'v1');
    assert.equal(configGeneration(empty), 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('npmrcTokenFor matches hosts, tolerates ports, rejects mismatches', () => {
  const npmrc = [
    '//npm.pkg.github.com/:_authToken=gh-token',
    '//localhost:4873:_authToken=local-token',
    'registry=https://registry.npmjs.org/',
  ].join('\n');
  assert.equal(npmrcTokenFor(npmrc, 'https://npm.pkg.github.com/pkg'), 'gh-token');
  assert.equal(npmrcTokenFor(npmrc, 'http://localhost:4873/pkg'), 'local-token');
  assert.equal(npmrcTokenFor(npmrc, 'https://registry.npmjs.org/pkg'), null);
  assert.equal(npmrcTokenFor('', 'https://x/y'), null);
  assert.equal(npmrcTokenFor('bad', 'not a url'), null);
});
