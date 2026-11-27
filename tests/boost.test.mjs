import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createMonitorHandlers } from '../sidecars/agy_monitor/main.mjs';
import { buildFrontendBundle } from '../sidecars/agy_monitor/backend/bundle_builder.mjs';
import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import {
  BOOST_RULES_END,
  BOOST_RULES_START,
  COMPACT_MAX_BYTES,
  compactTextOutput,
  extractFileOutline,
  runApplyEdits,
  runBatchSearch,
  runChecks,
  runCompactCommand,
  runQuickOutline,
  runReadSlices,
} from '../sidecars/agy_monitor/backend/boost_tools.mjs';
import { createBoostMcpDispatcher } from '../sidecars/agy_monitor/backend/boost_mcp.mjs';
import { BOOST_ITEMS, createBoostHub } from '../sidecars/agy_monitor/frontend/components/boost_hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'sidecars', 'agy_monitor', 'frontend');
const BOOST_MCP_PATH = path.join(ROOT, 'sidecars', 'agy_monitor', 'backend', 'boost_mcp.mjs');

function makeTempPaths(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-boost-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    root: dir,
    paths: resolvePaths({
      appDataDir: path.join(dir, 'appData'),
      geminiConfigDir: path.join(dir, 'config'),
      pluginDataDir: path.join(dir, 'pluginData'),
      sidecarDataDir: path.join(dir, 'sidecarData'),
    }),
  };
}

test('boost preferences default all OFF, support single + bulk enable/disable, and preserve user rules in AGENTS.md', async (t) => {
  const { paths } = makeTempPaths(t);
  const store = createStorage(paths);
  const routes = createMonitorHandlers({ paths, storage: store });

  const initialPrefs = await routes.get('GET /api/preferences')({});
  assert.deepEqual(initialPrefs.boost, {
    batchOps: false,
    compactOutput: false,
    outlineFirst: false,
  });

  // Seed existing custom text in rules/AGENTS.md to verify non-destructive merge
  fs.mkdirSync(path.dirname(paths.rulesFile), { recursive: true });
  fs.writeFileSync(paths.rulesFile, '# My Existing Rule\nKeep this untouched.\n', 'utf8');

  // Enable one toggle
  const oneOn = await routes.get('POST /api/preferences/boost')({ batchOps: true });
  assert.equal(oneOn.ok, true);
  assert.deepEqual(oneOn.boost, { batchOps: true, compactOutput: false, outlineFirst: false });
  let rulesText = fs.readFileSync(paths.rulesFile, 'utf8');
  assert.match(rulesText, /My Existing Rule/);
  assert.match(rulesText, /boost_batch_search/);
  assert.doesNotMatch(rulesText, /boost_quick_outline/);

  // Bulk enable all
  const allOn = await routes.get('POST /api/preferences/boost')({ all: true });
  assert.equal(allOn.ok, true);
  assert.deepEqual(allOn.boost, { batchOps: true, compactOutput: true, outlineFirst: true });
  rulesText = fs.readFileSync(paths.rulesFile, 'utf8');
  assert.match(rulesText, /boost_batch_search/);
  assert.match(rulesText, /boost_quick_outline/);
  assert.match(rulesText, /boost_compact_run/);

  // Bulk disable all -> cleanly strips managed block while preserving existing rule
  const allOff = await routes.get('POST /api/preferences/boost')({ all: false });
  assert.equal(allOff.ok, true);
  assert.deepEqual(allOff.boost, { batchOps: false, compactOutput: false, outlineFirst: false });
  rulesText = fs.readFileSync(paths.rulesFile, 'utf8');
  assert.match(rulesText, /My Existing Rule/);
  assert.equal(rulesText.includes(BOOST_RULES_START), false);
  assert.equal(rulesText.includes(BOOST_RULES_END), false);
});

test('boost_tools: 8.8KB Head-Tail folding, batch search, atomic edits, concurrent checks, and symbol outline/slices', async (t) => {
  const { root } = makeTempPaths(t);
  const workDir = path.join(root, 'repo');
  fs.mkdirSync(workDir, { recursive: true });

  const jsFile = path.join(workDir, 'app.js');
  fs.writeFileSync(
    jsFile,
    [
      'export function alphaHelper(x) {',
      '  return x + 1;',
      '}',
      '',
      'export class BetaService {',
      '  run() { return alphaHelper(41); }',
      '}',
      '',
      'const gammaArrow = (v) => v * 2;',
    ].join('\r\n'),
    'utf8',
  );
  const pyFile = path.join(workDir, 'worker.py');
  fs.writeFileSync(pyFile, 'class QueueRunner:\n    pass\n\ndef compute_total(items):\n    return len(items)\n', 'utf8');

  // 1. Compact output strictly caps UTF-8 bytes <= 8800 and strips ANSI
  const noisy = `\x1b[31mERROR_HEAD_ROOT_CAUSE\x1b[0m\n${'middle noise line 0123456789\n'.repeat(600)}FINAL_SUMMARY_TAIL_OK`;
  const folded = compactTextOutput(noisy, { maxBytes: COMPACT_MAX_BYTES });
  assert.equal(folded.truncated, true);
  assert.ok(Buffer.byteLength(folded.text, 'utf8') <= COMPACT_MAX_BYTES);
  assert.equal(folded.text.includes('\x1b['), false);
  assert.match(folded.text, /ERROR_HEAD_ROOT_CAUSE/);
  assert.match(folded.text, /FINAL_SUMMARY_TAIL_OK/);

  // 2. Batch search (text + glob)
  const searchRes = await runBatchSearch({
    cwd: workDir,
    compact: true,
    queries: [
      { type: 'text', pattern: 'alphaHelper' },
      { type: 'glob', pattern: '*.py' },
    ],
  });
  assert.equal(searchRes.ok, true);
  assert.match(searchRes.text, /app\.js:1:/);
  assert.match(searchRes.text, /worker\.py/);

  // 3. Atomic multi-file edits: failed hunk leaves disk untouched; valid edit preserves CRLF
  const failEdit = await runApplyEdits({
    cwd: workDir,
    edits: [
      { path: 'app.js', hunks: [{ target: 'alphaHelper(41)', replacement: 'alphaHelper(99)' }] },
      { path: 'worker.py', hunks: [{ target: 'NON_EXISTENT_SYMBOL', replacement: 'nope' }] },
    ],
  });
  assert.equal(failEdit.ok, false);
  assert.equal(failEdit.filesModified, 0);
  assert.match(fs.readFileSync(jsFile, 'utf8'), /alphaHelper\(41\)/);

  const okEdit = await runApplyEdits({
    cwd: workDir,
    compact: true,
    edits: [{ path: 'app.js', hunks: [{ target: 'alphaHelper(41)', replacement: 'alphaHelper(99)' }] }],
    verify: 'node -e "console.log(123)"',
  });
  assert.equal(okEdit.ok, true);
  assert.equal(okEdit.filesModified, 1);
  const editedRaw = fs.readFileSync(jsFile, 'utf8');
  assert.match(editedRaw, /alphaHelper\(99\)/);
  assert.equal(editedRaw.includes('\r\n'), true, 'CRLF line endings must be preserved');

  // 4. Concurrent checks & standalone compact runner
  const chkRes = await runChecks({
    cwd: workDir,
    compact: true,
    commands: [
      { label: 'ok1', command: 'node -e "console.log(\'PASS_\' + \'VERBOSE_\' + \'HIDDEN\')"' },
      { label: 'ok2', command: 'node -e "process.exit(0)"' },
    ],
  });
  assert.equal(chkRes.ok, true);
  assert.equal(chkRes.passed, 2);
  assert.equal(chkRes.text.includes('PASS_VERBOSE_HIDDEN'), false, 'compact mode collapses passing stdout');

  const compactRun = await runCompactCommand({
    cwd: workDir,
    command: 'node -e "for (let i = 0; i < 600; i++) console.log(\'line-\' + i + \'-abcdefghijklmnopqrstuvwxyz\')"',
  });
  assert.equal(compactRun.ok, true);
  assert.equal(compactRun.truncated, true);
  assert.ok(Buffer.byteLength(compactRun.text, 'utf8') <= COMPACT_MAX_BYTES);

  // 5. Outline & targeted slices
  const outlineJs = extractFileOutline('app.js', editedRaw);
  assert.ok(outlineJs.symbols.some((s) => s.name === 'alphaHelper' && s.line === 1));
  assert.ok(outlineJs.symbols.some((s) => s.name === 'BetaService' && s.line === 5));
  assert.ok(outlineJs.symbols.some((s) => s.name === 'gammaArrow' && s.line === 9));

  const quickRes = await runQuickOutline({ cwd: workDir, paths: ['app.js', 'worker.py'], compact: true });
  assert.equal(quickRes.ok, true);
  assert.match(quickRes.text, /L1 \[fn\] alphaHelper/);
  assert.match(quickRes.text, /L4 \[def\] compute_total/);

  const sliceRes = await runReadSlices({
    cwd: workDir,
    compact: true,
    requests: [{ path: 'app.js', outline: true, ranges: [[5, 7]] }],
  });
  assert.equal(sliceRes.ok, true);
  assert.match(sliceRes.text, /5: export class BetaService/);
});

test('boost_mcp dynamically gates tools by user_prefs boost flags & works over stdio', async (t) => {
  const { paths } = makeTempPaths(t);
  let flags = { batchOps: false, compactOutput: false, outlineFirst: false };
  const dispatch = createBoostMcpDispatcher({ corePaths: paths, getBoostConfig: () => flags });

  // All OFF -> 0 tools exposed & calling returns isError
  let list = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(list.result.tools.length, 0);

  const blocked = await dispatch({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'boost_quick_outline', arguments: { paths: ['a.js'] } },
  });
  assert.equal(blocked.result.isError, true);

  // Enable only outlineFirst -> exposes 2 outline tools
  flags = { batchOps: false, compactOutput: false, outlineFirst: true };
  list = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(
    list.result.tools.map((x) => x.name),
    ['boost_quick_outline', 'boost_read_slices'],
  );

  // Enable all 3 -> exposes all 6 tools
  flags = { batchOps: true, compactOutput: true, outlineFirst: true };
  list = await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.equal(list.result.tools.length, 6);

  // Real stdio subprocess initialize + tools/list
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [BOOST_MCP_PATH],
      {
        timeout: 8000,
        env: { ...process.env, AGY_MONITOR_PLUGIN_DATA_DIR: paths.pluginDataDir },
      },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) +
        '\n' +
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) +
        '\n',
    );
    child.stdin.end();
  });
  const replies = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(replies.length, 2);
  assert.equal(replies[0].result.serverInfo.name, 'agy-monitor-boost-mcp');
  assert.deepEqual(replies[1].result.tools, [], 'fresh install defaults all boost tools OFF');
});

test('Boost Tab UI: <=30 char rows, <=100 char modal intros, bulk toggles, hover preview -> click fullscreen modal', async () => {
  // 1. Copy constraints & HTML/bundle integrity
  assert.equal(BOOST_ITEMS.length, 3);
  for (const item of BOOST_ITEMS) {
    const rowLen = item.title.length + item.shortDesc.length;
    assert.ok(rowLen <= 30, `row "${item.title}${item.shortDesc}" exceeds 30 chars (${rowLen})`);
    assert.ok(item.intro.length <= 100, `modal intro for "${item.key}" exceeds 100 chars (${item.intro.length})`);
  }

  const html = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf8');
  assert.match(html, /data-subnav="boost"/);
  assert.match(html, /id="panelBoost"/);
  assert.match(html, /id="boostEnableAllBtn"/);
  assert.match(html, /id="boostDisableAllBtn"/);
  assert.match(html, /id="boostHoverCard"/);
  assert.match(html, /id="boostDetailModal"/);

  const bundle = await buildFrontendBundle(FRONTEND_DIR);
  assert.equal(bundle.includes('createBoostHub'), true);
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'bundle-with-boost.js' }));

  // 2. Interactive DOM verification for hover mini-card -> click fullscreen modal + bulk toggles
  function makeEl(id = '', attrs = {}) {
    const listeners = new Map();
    const classes = new Set();
    const el = {
      id,
      attrs: { ...attrs },
      hidden: id === 'boostHoverCard' || id === 'boostDetailModal',
      checked: false,
      disabled: false,
      textContent: '',
      className: '',
      style: {},
      offsetHeight: 110,
      classList: {
        toggle(c, force) {
          if (force) classes.add(c);
          else classes.delete(c);
        },
        contains(c) {
          return classes.has(c);
        },
      },
      getAttribute(k) {
        return el.attrs[k] ?? null;
      },
      setAttribute(k, v) {
        el.attrs[k] = String(v);
      },
      getBoundingClientRect() {
        return { left: 280, right: 300, top: 120, bottom: 140, width: 20, height: 20 };
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type) || [];
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      },
      dispatch(type, ev = {}) {
        const event = { preventDefault() {}, stopPropagation() {}, target: el, ...ev };
        for (const fn of listeners.get(type) || []) fn(event);
      },
    };
    return el;
  }

  const toggles = BOOST_ITEMS.map((it) => makeEl(`toggle_${it.key}`, { 'data-boost-toggle': it.key }));
  const infoBtns = BOOST_ITEMS.map((it) => makeEl(`info_${it.key}`, { 'data-boost-info': it.key }));
  const panelEl = makeEl('panelBoost');
  panelEl.querySelectorAll = (sel) => {
    if (sel === '[data-boost-toggle]') return toggles;
    if (sel === '[data-boost-info]') return infoBtns;
    return [];
  };

  const elements = new Map(
    [
      panelEl,
      makeEl('boostCountBadge'),
      makeEl('boostEnableAllBtn'),
      makeEl('boostDisableAllBtn'),
      makeEl('boostHoverCard'),
      makeEl('boostHoverTitle'),
      makeEl('boostHoverText'),
      makeEl('boostDetailModal'),
      makeEl('boostDetailTitle'),
      makeEl('boostDetailStatus'),
      makeEl('boostDetailText'),
      makeEl('boostDetailToggleBtn'),
      makeEl('boostDetailCloseBtn'),
    ].map((e) => [e.id, e]),
  );

  const docListeners = new Map();
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    addEventListener(t, fn) {
      if (!docListeners.has(t)) docListeners.set(t, []);
      docListeners.get(t).push(fn);
    },
    removeEventListener(t, fn) {
      const l = docListeners.get(t) || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
  };
  globalThis.window = { innerWidth: 380, innerHeight: 700 };

  try {
    const sent = [];
    let currentBoost = { batchOps: false, compactOutput: false, outlineFirst: false };
    const apiFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      sent.push(body);
      if (typeof body.all === 'boolean') {
        currentBoost = { batchOps: body.all, compactOutput: body.all, outlineFirst: body.all };
      } else {
        currentBoost = { ...currentBoost, ...body };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, boost: currentBoost }) };
    };

    const hub = createBoostHub({ apiFetch });

    // Initial state: all OFF
    assert.equal(elements.get('boostCountBadge').textContent, '0/3');
    assert.equal(elements.get('boostDisableAllBtn').disabled, true);
    assert.equal(elements.get('boostEnableAllBtn').disabled, false);

    // Hover info button -> side mini hover card shows
    infoBtns[0].dispatch('mouseenter');
    assert.equal(elements.get('boostHoverCard').hidden, false);
    assert.equal(elements.get('boostHoverTitle').textContent, '打包合并做');
    assert.equal(elements.get('boostDetailModal').hidden, true);

    // Click info button -> hover card hides, fullscreen modal opens with <= 100-char intro
    infoBtns[0].dispatch('click');
    assert.equal(elements.get('boostHoverCard').hidden, true);
    assert.equal(elements.get('boostDetailModal').hidden, false);
    assert.equal(elements.get('boostDetailTitle').textContent, '打包合并做');
    assert.ok(elements.get('boostDetailText').textContent.length <= 100);

    // Escape closes fullscreen modal
    for (const fn of docListeners.get('keydown') || []) fn({ key: 'Escape' });
    assert.equal(elements.get('boostDetailModal').hidden, true);

    // Bulk Enable All & Disable All
    elements.get('boostEnableAllBtn').dispatch('click');
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(sent.at(-1), { all: true });
    assert.equal(elements.get('boostCountBadge').textContent, '3/3');
    assert.equal(toggles.every((t) => t.checked === true), true);

    elements.get('boostDisableAllBtn').dispatch('click');
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(sent.at(-1), { all: false });
    assert.equal(elements.get('boostCountBadge').textContent, '0/3');
    assert.equal(toggles.every((t) => t.checked === false), true);

    hub.destroy();
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});
