import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildHudDeltaExpr,
  buildHudMountExpr,
  clearCdpBridgeCaches,
  createCdpThemeBridge,
  getNativeHudScriptSignature,
} from '../sidecars/agy_monitor/backend/cdp_theme_bridge.mjs';
import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { scanOnce } from '../sidecars/agy_monitor/backend/scan_worker.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import { createMonitorHandlers } from '../sidecars/agy_monitor/main.mjs';

function makeTempFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-sync-test-'));
  const paths = resolvePaths({
    appDataDir: path.join(root, 'appData'),
    geminiConfigDir: path.join(root, 'config'),
    pluginDataDir: path.join(root, 'pluginData'),
    sidecarDataDir: path.join(root, 'sidecarData'),
    brainDir: path.join(root, 'brain'),
  });
  const storage = createStorage(paths);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, paths, storage };
}

function writeTranscript(brainDir, convId, rows) {
  const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, 'transcript.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
}

test('HUD telemetry tracks active foreground hostConvId continuously while blocking hidden iframe hijack', async (t) => {
  const { paths, storage } = makeTempFixture(t);
  const convBg = 'conv-bg-running';
  const convFg = 'conv-fg-active';

  // Background conversation: 9.0 tok/s (90 output tokens over 10s), newer timestamp
  writeTranscript(paths.brainDir, convBg, [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T06:00:00Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 1000,
      cache_read_tokens: 100000,
      output_tokens: 90,
      tool_calls: [{ name: 'run_command' }],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      created_at: '2026-11-22T06:00:10Z',
      content: 'ok',
    },
  ]);

  // Foreground conversation: 20.0 tok/s (200 output tokens over 10s)
  writeTranscript(paths.brainDir, convFg, [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T05:59:00Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 2000,
      cache_read_tokens: 400000,
      output_tokens: 200,
      tool_calls: [{ name: 'run_command' }],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      created_at: '2026-11-22T05:59:10Z',
      content: 'ok',
    },
  ]);

  await scanOnce(paths.brainDir, paths.telemetryCacheDb);

  // Seed summaries DB via minimal sqlite so sessionsHub.allSelectable recognizes both top-level convs
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(paths.summariesDbPath), { recursive: true });
  const sumDb = new DatabaseSync(paths.summariesDbPath);
  sumDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      parent_conversation_id TEXT DEFAULT '',
      killed INTEGER DEFAULT 0,
      title TEXT,
      preview TEXT DEFAULT '',
      step_count INTEGER DEFAULT 2,
      last_modified_time INTEGER,
      workspace_uris TEXT,
      status TEXT,
      not_fully_idle INTEGER DEFAULT 0
    );
  `);
  const insert = sumDb.prepare(
    'INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, status) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(convBg, '飞镖乱斗程序对战赛', 1795327900000, '["file:///d:/work/bg"]', 'CASCADE_RUN_STATUS_RUNNING');
  insert.run(convFg, 'Antigravity Tool Improvement Ideas', 1795327800000, '["file:///d:/work/fg"]', 'CASCADE_RUN_STATUS_IDLE');
  sumDb.close();

  const routes = createMonitorHandlers({ paths, storage });
  const getSnapshot = routes.get('GET /api/snapshot');
  assert.ok(getSnapshot);

  // 1. Foreground panel focuses convFg (syncHud=1) -> HUD immediately writes convFg (20.0 tok/s)
  await getSnapshot({ scope: 'current', range: 'today', hostConvId: convFg, syncHud: '1' });
  await new Promise((r) => setTimeout(r, 40));
  let hudDoc = JSON.parse(fs.readFileSync(paths.hudTelemetryFile, 'utf8'));
  assert.equal(hudDoc.activeConvId, convFg);
  assert.equal(hudDoc.tokPerSec, 20);

  // 2. Hidden background iframe polls convBg WITHOUT syncHud -> MUST NOT hijack HUD
  await getSnapshot({ scope: 'current', range: 'today', hostConvId: convBg, syncHud: '0' });
  await new Promise((r) => setTimeout(r, 40));
  hudDoc = JSON.parse(fs.readFileSync(paths.hudTelemetryFile, 'utf8'));
  assert.equal(hudDoc.activeConvId, convFg, 'Hidden background iframe must not hijack foreground HUD');
  assert.equal(hudDoc.tokPerSec, 20);

  // 3. Foreground convFg produces a new faster turn (40.0 tok/s) and regular poll (syncHud=0) arrives -> HUD updates immediately!
  writeTranscript(paths.brainDir, convFg, [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T05:59:00Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 2000,
      cache_read_tokens: 400000,
      output_tokens: 200,
      tool_calls: [{ name: 'run_command' }],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      created_at: '2026-11-22T05:59:10Z',
      content: 'ok',
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T06:01:00Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 3000,
      cache_read_tokens: 420000,
      output_tokens: 400,
      tool_calls: [{ name: 'run_command' }],
    },
    {
      step_index: 4,
      type: 'GENERIC',
      created_at: '2026-11-22T06:01:10Z',
      content: 'ok',
    },
  ]);
  await scanOnce(paths.brainDir, paths.telemetryCacheDb);
  await getSnapshot({ scope: 'current', range: 'today', hostConvId: convFg, syncHud: '0' });
  await new Promise((r) => setTimeout(r, 40));
  hudDoc = JSON.parse(fs.readFileSync(paths.hudTelemetryFile, 'utf8'));
  assert.equal(hudDoc.activeConvId, convFg);
  assert.equal(hudDoc.tokPerSec, 40, 'Active foreground poll must push updated tok/s to HUD without waiting for hover');

  // 4. Garbage title written into hud_active_view.json must never kick HUD back to convBg
  fs.writeFileSync(
    paths.hudActiveViewFile,
    JSON.stringify({ workspace: '', title: 'Analyzed', isNewConversation: false, source: 'uia_header', updatedAtMs: Date.now() }),
    'utf8',
  );
  await getSnapshot({ scope: 'current', range: 'today', hostConvId: convFg, syncHud: '0' });
  await new Promise((r) => setTimeout(r, 40));
  hudDoc = JSON.parse(fs.readFileSync(paths.hudTelemetryFile, 'utf8'));
  assert.equal(hudDoc.activeConvId, convFg);
  assert.equal(hudDoc.tokPerSec, 40);
});

test('CDP bridge sends lightweight delta HUD updates when mounted, falls back cleanly on reload, toggles liteMode, and releases caches', async (t) => {
  clearCdpBridgeCaches();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cdp-delta-test-'));
  const wpDir = path.join(root, 'wallpapers');
  const assetsDir = path.join(root, 'assets');
  fs.mkdirSync(wpDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  const wpFile = path.join(wpDir, 'wp-1.webp');
  const guideFile = path.join(assetsDir, 'open_console_guide.jpg');
  fs.writeFileSync(wpFile, Buffer.from('FAKE_CDP_WEBP_PAYLOAD_1234'));
  fs.writeFileSync(guideFile, Buffer.from('FAKE_CDP_GUIDE_JPEG_5678'.repeat(200)));

  // 1. Unit-verify mount vs delta expression size and reload/signature-change fallback
  const scriptSig = getNativeHudScriptSignature();
  const fakeGuideUri = 'data:image/jpeg;base64,' + 'A'.repeat(24000);
  const mountExpr = buildHudMountExpr(
    { activeConvId: 'c1', percent: 42, totalUsed: 200000, windowCap: 512000, tokPerSec: 32.5 },
    '#5b8cff',
    null,
    fakeGuideUri,
    { bubbleColor: '#212533', hostBlendPct: 25, liteMode: false },
  );
  const deltaExpr = buildHudDeltaExpr(
    { activeConvId: 'c1', percent: 45, totalUsed: 220000, windowCap: 512000, tokPerSec: 38.0 },
    '#5b8cff',
    null,
    { bubbleColor: '#212533', hostBlendPct: 25, liteMode: true },
    { includeGuide: false, scriptSig },
  );
  assert.ok(mountExpr.length > 45_000, `expected full mount expression > 45KB, got ${mountExpr.length}`);
  assert.ok(deltaExpr.length < 2_000, `expected lightweight delta expression < 2KB, got ${deltaExpr.length}`);
  assert.doesNotMatch(deltaExpr, /attachShadow/, 'delta expression must not re-serialize full renderer script');
  assert.doesNotMatch(deltaExpr, /guideImageDataUri/, 'delta expression must omit guide image base64');

  // Verify delta fallback behavior in a clean VM context
  const vmCtx = { window: {} };
  vmCtx.window = vmCtx;
  vm.createContext(vmCtx);
  const unmountedRes = vm.runInContext(deltaExpr, vmCtx);
  assert.equal(unmountedRes.needsMount, true, 'missing window.__agyMonitorNativeHud must trigger mount fallback');

  let lastUpdatePayload = null;
  vmCtx.__agyMonitorNativeHud = {
    version: scriptSig.split(':')[0],
    scriptSig,
    update(payload) {
      lastUpdatePayload = payload;
      return { hudInjected: true, activeView: null, focused: true, displayPatch: null };
    },
  };
  const mountedDeltaRes = vm.runInContext(deltaExpr, vmCtx);
  assert.equal(mountedDeltaRes.hudInjected, true);
  assert.equal(mountedDeltaRes.needsMount, undefined);
  assert.equal(lastUpdatePayload.percent, 45);
  assert.equal(lastUpdatePayload.liteMode, true);

  vmCtx.__agyMonitorNativeHud.scriptSig = 'stale-signature';
  const staleSigRes = vm.runInContext(deltaExpr, vmCtx);
  assert.equal(staleSigRes.needsMount, true, 'mismatched scriptSig must trigger mount fallback');

  // 2. End-to-end bridge test over mock loopback /json/list + mock WebSocket
  const evalLog = [];
  let pageHasHud = false;
  let pageMountedSig = '';
  let lastAppliedCss = '';
  let lastSyncedPayload = null;

  const targetWsUrl = 'ws://127.0.0.1:1/devtools/page/mock-1';
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            type: 'page',
            url: 'https://127.0.0.1:54966/c/test-1',
            title: 'Mock - Antigravity',
            webSocketDebuggerUrl: targetWsUrl,
          },
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const cdpPort = httpServer.address().port;

  const OrigWebSocket = globalThis.WebSocket;
  const origReadFile = fsp.readFile;

  class MockCdpWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this._listeners = new Map();
      queueMicrotask(() => {
        this.readyState = 1;
        this._emit('open', {});
      });
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this._listeners.get(type)?.delete(fn);
    }
    _emit(type, evt) {
      for (const fn of [...(this._listeners.get(type) || [])]) fn(evt);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      const expr = String(msg?.params?.expression || '');
      evalLog.push(expr);
      let value = true;

      const parseTrailingArg = (code) => {
        const idx = code.lastIndexOf('})(');
        if (idx < 0 || !code.endsWith(')')) return null;
        try {
          return JSON.parse(code.slice(idx + 3, -1));
        } catch {
          return null;
        }
      };

      if (expr.includes('window.__agyMonitorWallpaper.apply')) {
        const parsedCss = parseTrailingArg(expr);
        if (typeof parsedCss === 'string') {
          lastAppliedCss = parsedCss;
        }
        value = true;
      } else if (expr.includes("typeof hud.update !== 'function'") || expr.includes('hud.update(data)')) {
        if (!pageHasHud || pageMountedSig !== scriptSig) {
          value = { needsMount: true, hudInjected: false };
        } else {
          lastSyncedPayload = parseTrailingArg(expr);
          value = { hudInjected: true, activeView: null, focused: true, displayPatch: null };
        }
      } else if (expr.includes('window.__agyMonitorNativeHud.sync(data)')) {
        pageHasHud = true;
        pageMountedSig = scriptSig;
        lastSyncedPayload = parseTrailingArg(expr);
        value = {
          hudInjected: true,
          mountedSig: scriptSig,
          activeView: null,
          focused: true,
          displayPatch: null,
        };
      } else if (expr.includes('window.__agyMonitorNativeHud.dispose')) {
        pageHasHud = false;
        pageMountedSig = '';
        value = true;
      }

      queueMicrotask(() => {
        this._emit('message', {
          data: JSON.stringify({ id: msg.id, result: { result: { type: 'object', value } } }),
        });
      });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this._emit('close', {});
    }
  }

  let wpReads = 0;
  let guideReads = 0;
  let bridge = null;
  t.after(async () => {
    if (bridge) await bridge.dispose().catch(() => {});
    globalThis.WebSocket = OrigWebSocket;
    fsp.readFile = origReadFile;
    clearCdpBridgeCaches();
    await new Promise((resolve) => httpServer.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  globalThis.WebSocket = MockCdpWebSocket;
  fsp.readFile = async function spyReadFile(target, ...rest) {
    const resolved = path.resolve(String(target));
    if (resolved === path.resolve(wpFile)) wpReads += 1;
    if (resolved === path.resolve(guideFile)) guideReads += 1;
    return origReadFile.call(this, target, ...rest);
  };

  const paths = resolvePaths({
    appDataDir: path.join(root, 'appData'),
    geminiConfigDir: path.join(root, 'config'),
    wallpapersDir: wpDir,
    assetsDir,
    allowLiveCdp: true,
  });

  const themes = {
    hostThemeMode: 'cdp',
    cdpPort,
    backdropEnabled: true,
    activeWallpaperId: 'wp-1',
    hudEnabled: true,
    hudInjectionMode: 'cdp',
    opacity: 70,
    blur: 6,
    dim: 25,
    hostBlendPct: 24,
    fit: 'cover',
    colors: { canvas: '#111218', chrome: '#171922', bubble: '#1d202b', accent: '#5b8cff' },
  };

  bridge = createCdpThemeBridge(paths);

  // First sync mounts HUD (full script + guide base64) and applies normal CSS
  const st1 = await bridge.sync(themes, { hostLanguage: 'en', liteMode: false });
  assert.equal(st1.connected, true);
  assert.equal(st1.hudInjected, true);
  assert.equal(st1.styleApplied, true);
  assert.equal(st1.liteMode, false);
  assert.match(lastAppliedCss, /backdrop-filter:\s*blur\(20px\)/);
  assert.equal(wpReads, 1);
  assert.equal(guideReads, 1);
  assert.ok(
    evalLog.some((e) => e.includes('window.__agyMonitorNativeHud.sync(data)') && e.length > 45_000),
    'initial mount must send full renderer script',
  );

  // Subsequent 900ms-style HUD telemetry update sends ONLY lightweight delta payload!
  evalLog.length = 0;
  const okDelta = await bridge.updateHudData({ activeConvId: 'c2', percent: 68, totalUsed: 340000, windowCap: 512000, tokPerSec: 55.2 });
  assert.equal(okDelta, true);
  assert.equal(evalLog.length, 1, 'mounted HUD tick must execute a single delta evaluate');
  assert.ok(evalLog[0].length < 2_000, `expected delta eval < 2KB, got ${evalLog[0].length}`);
  assert.match(evalLog[0], /hud\.update\(data\)/);
  assert.doesNotMatch(evalLog[0], /attachShadow/);
  assert.equal(lastSyncedPayload.percent, 68);
  assert.equal(lastSyncedPayload.guideImageDataUri, undefined, 'delta tick must not re-send guide image base64');
  assert.equal(guideReads, 1);

  // Simulate Ctrl+R page reload (window.__agyMonitorNativeHud wiped) -> clean automatic fallback to full mount in same tick!
  pageHasHud = false;
  pageMountedSig = '';
  evalLog.length = 0;
  const okReload = await bridge.updateHudData({ activeConvId: 'c2', percent: 72, totalUsed: 360000, windowCap: 512000, tokPerSec: 60.0 });
  assert.equal(okReload, true);
  assert.equal(evalLog.length, 2, 'reloaded target must try delta then cleanly fall back to full mount');
  assert.ok(evalLog[0].length < 2_000);
  assert.ok(evalLog[1].length > 45_000 && evalLog[1].includes('window.__agyMonitorNativeHud.sync(data)'));
  assert.equal(lastSyncedPayload.percent, 72);

  // Toggle liteMode = true -> immediately applies liteMode CSS and updates HUD payload
  evalLog.length = 0;
  const stLite = await bridge.sync(themes, { hostLanguage: 'en', liteMode: true });
  assert.equal(stLite.liteMode, true);
  assert.doesNotMatch(lastAppliedCss, /backdrop-filter:\s*blur\(/);
  assert.doesNotMatch(lastAppliedCss, /background-attachment:\s*fixed/);
  assert.match(lastAppliedCss, /backdrop-filter:\s*none\s*!important/);
  assert.equal(lastSyncedPayload.liteMode, true);

  // clearCdpBridgeCaches() clears cached wallpaper/guide base64 so next wallpaper read or remount reads fresh from disk
  clearCdpBridgeCaches();
  pageHasHud = false;
  pageMountedSig = '';
  await bridge.sync(themes, { hostLanguage: 'en', liteMode: true });
  assert.equal(wpReads, 2, 'clearCdpBridgeCaches must release cached wallpaper base64');
  assert.equal(guideReads, 2, 'clearCdpBridgeCaches must release cached guide base64');

  // Disabling wallpaper releases cached wallpaper base64 automatically
  await bridge.sync({ ...themes, activeWallpaperId: '' }, { hostLanguage: 'en', liteMode: true });
  await bridge.sync(themes, { hostLanguage: 'en', liteMode: true });
  assert.equal(wpReads, 3, 'disabling wallpaper must release cached wallpaper base64');

  // syncHostLanguage must honor 3rd arg options.liteMode and themes.liteMode without clobbering back to initial false
  const freshBridge = createCdpThemeBridge(paths);
  t.after(async () => {
    await freshBridge.dispose().catch(() => {});
  });
  lastAppliedCss = '';
  const langRes1 = await freshBridge.syncHostLanguage('en', { ...themes, liteMode: true }, { liteMode: true });
  assert.equal(langRes1.liteMode, true, 'syncHostLanguage must honor options.liteMode=true on fresh bridge');
  assert.doesNotMatch(lastAppliedCss, /backdrop-filter:\s*blur\(/);
  assert.match(lastAppliedCss, /backdrop-filter:\s*none\s*!important/);

  const freshBridge2 = createCdpThemeBridge(paths);
  t.after(async () => {
    await freshBridge2.dispose().catch(() => {});
  });
  lastAppliedCss = '';
  const langRes2 = await freshBridge2.syncHostLanguage('en', { ...themes, liteMode: true });
  assert.equal(langRes2.liteMode, true, 'syncHostLanguage must honor themes.liteMode=true when options omitted');
  assert.doesNotMatch(lastAppliedCss, /backdrop-filter:\s*blur\(/);
});
