import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildHostWallpaperCss,
  buildMainHookScript,
  buildNativeHudRendererScript,
  buildNativeWallpaperEngineScript,
  computeAsarIntegrity,
  extractAsarFile,
  inspectNativeHudState,
  installNativeHud,
  NATIVE_HUD_VERSION,
  parseAsar,
  readDevToolsActivePort,
  readNativeHudHeartbeat,
  repackAsarInMemory,
  restoreStockAsar,
  stageLiveWallpaperCss,
} from '../sidecars/agy_monitor/backend/hud_injector.mjs';
import { isAntigravityAppTarget } from '../sidecars/agy_monitor/backend/cdp_theme_bridge.mjs';
import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import { createMonitorHandlers } from '../sidecars/agy_monitor/main.mjs';

function buildSyntheticAsar(filesMap) {
  const root = { files: {} };
  const chunks = [];
  let offset = 0;

  for (const [relPath, content] of Object.entries(filesMap)) {
    const segs = relPath.split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      if (!cur.files[segs[i]]) cur.files[segs[i]] = { files: {} };
      cur = cur.files[segs[i]];
    }
    const leaf = segs[segs.length - 1];
    if (content && typeof content === 'object' && content.unpacked === true) {
      cur.files[leaf] = { size: content.size || 12, unpacked: true };
      continue;
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    cur.files[leaf] = {
      size: buf.length,
      offset: String(offset),
      integrity: computeAsarIntegrity(buf),
    };
    chunks.push(buf);
    offset += buf.length;
  }

  const jsonBuf = Buffer.from(JSON.stringify(root), 'utf8');
  const alignedLen = (jsonBuf.length + 3) & ~3;
  const headerBuf = Buffer.alloc(16 + alignedLen);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(alignedLen + 8, 4);
  headerBuf.writeUInt32LE(alignedLen + 4, 8);
  headerBuf.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(headerBuf, 16);
  return Buffer.concat([headerBuf, ...chunks], headerBuf.length + offset);
}

test('hud_injector: ASAR repack, install, upgrade auto-reinject, and stock restore roundtrip', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-asar-'));
  try {
    const asarPath = path.join(tmpDir, 'app.asar');
    const devToolsFile = path.join(tmpDir, 'DevToolsActivePort');
    fs.writeFileSync(devToolsFile, '19234\n/devtools/browser/test\n', 'utf8');

    const stockV1 = buildSyntheticAsar({
      'package.json': JSON.stringify({ name: 'antigravity', version: '2.35.1', main: 'dist/main.js' }),
      'dist/main.js': '"use strict";\nconsole.log("stock main 2.35.1");\n',
      'dist/extra.bin': Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      'node_modules/native.node': { unpacked: true, size: 64 },
    });
    fs.writeFileSync(asarPath, stockV1);

    const paths = resolvePaths({
      appDataDir: path.join(tmpDir, 'appdata'),
      geminiConfigDir: path.join(tmpDir, 'config'),
      hostAsarPath: asarPath,
      devToolsActivePortFile: devToolsFile,
    });

    // 1. DevToolsActivePort & initial stock inspection
    assert.equal(await readDevToolsActivePort(paths), 19234);
    const before = await inspectNativeHudState(paths);
    assert.equal(before.state, 'stock');
    assert.equal(before.appVersion, '2.35.1');
    assert.equal(before.devToolsPort, 19234);

    // 2. Install persistent HUD into app.asar
    const inst = await installNativeHud(paths);
    assert.equal(inst.ok, true);
    assert.equal(inst.diskWritten, true);
    assert.equal(inst.status.state, 'installed');
    assert.equal(inst.status.installedVersion, NATIVE_HUD_VERSION);
    assert.equal(fs.existsSync(inst.backupPath), true);
    assert.equal(fs.existsSync(paths.nativeHudRendererFile), true);
    assert.equal(fs.existsSync(paths.nativeWallpaperEngineFile), true);

    // Verify integrity & preserved untouched / unpacked files inside repacked ASAR
    const parsedAfter = parseAsar(fs.readFileSync(asarPath));
    const patchedMain = extractAsarFile(parsedAfter, 'dist/main.js').toString('utf8');
    assert.match(patchedMain, /require\("\.\/agy-monitor-hud-main"\)/);
    assert.match(patchedMain, /stock main 2\.35\.1/);
    assert.deepEqual(extractAsarFile(parsedAfter, 'dist/extra.bin'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    assert.equal(parsedAfter.root.files.node_modules.files['native.node'].unpacked, true);
    assert.equal(parsedAfter.root.files.dist.files['agy-monitor-hud-main.js'].integrity.algorithm, 'SHA256');
    assert.equal(parsedAfter.root.files.dist.files['agy-monitor-wallpaper.js'].integrity.algorithm, 'SHA256');

    // 3. Idempotent second run reports alreadyUpToDate
    const inst2 = await installNativeHud(paths);
    assert.equal(inst2.ok, true);
    assert.equal(inst2.alreadyUpToDate, true);

    // 4. Simulate Antigravity official update to 2.36.0 wiping app.asar back to stock
    const stockV2 = buildSyntheticAsar({
      'package.json': JSON.stringify({ name: 'antigravity', version: '2.36.0', main: 'dist/main.js' }),
      'dist/main.js': '"use strict";\nconsole.log("stock main 2.36.0");\n',
    });
    fs.writeFileSync(asarPath, stockV2);
    const afterUpdate = await inspectNativeHudState(paths);
    assert.equal(afterUpdate.state, 'stock');
    assert.equal(afterUpdate.appVersion, '2.36.0');

    // Auto-reinject refreshes backup to 2.36.0 stock and re-patches cleanly
    const reinj = await installNativeHud(paths);
    assert.equal(reinj.ok, true);
    assert.equal(reinj.status.state, 'installed');
    assert.equal(reinj.status.appVersion, '2.36.0');
    const reinjMain = extractAsarFile(parseAsar(fs.readFileSync(asarPath)), 'dist/main.js').toString('utf8');
    assert.match(reinjMain, /stock main 2\.36\.0/);

    // 5. Restore stock restores 2.36.0 (NOT stale 2.35.1!)
    const restored = await restoreStockAsar(paths);
    assert.equal(restored.ok, true);
    assert.equal(restored.diskWritten, true);
    assert.equal(restored.status.state, 'stock');
    assert.equal(restored.status.appVersion, '2.36.0');
    const restoredParsed = parseAsar(fs.readFileSync(asarPath));
    const restoredMain = extractAsarFile(restoredParsed, 'dist/main.js').toString('utf8');
    assert.doesNotMatch(restoredMain, /agy-monitor-hud-main/);
    assert.match(restoredMain, /stock main 2\.36\.0/);
    assert.equal(restoredParsed.root.files.dist.files['agy-monitor-wallpaper.js'], undefined);

    // 6. Direct repackAsarInMemory sanity
    const repacked = repackAsarInMemory(stockV2, new Map([['dist/hello.txt', Buffer.from('world')]]), new Set());
    assert.equal(extractAsarFile(parseAsar(repacked), 'dist/hello.txt').toString('utf8'), 'world');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('hud_injector: embedded scripts are valid JS, support Scheme 3 persistent wallpaper, and default to asar+inject', async () => {
  const rendererSrc = buildNativeHudRendererScript();
  const wallpaperSrc = buildNativeWallpaperEngineScript();
  const mainSrc = buildMainHookScript();
  assert.doesNotThrow(() => new vm.Script(rendererSrc, { filename: 'agy-monitor-hud.js' }));
  assert.doesNotThrow(() => new vm.Script(wallpaperSrc, { filename: 'agy-monitor-wallpaper.js' }));
  assert.doesNotThrow(() => new vm.Script(mainSrc, { filename: 'agy-monitor-hud-main.js' }));
  assert.match(rendererSrc, /attachShadow/);
  assert.match(rendererSrc, /\.agy-composer-footer/);
  assert.match(rendererSrc, /permissions-selector-trigger/);
  assert.match(rendererSrc, /agy-monitor-native-hud-portal/);
  assert.match(rendererSrc, /quota-pill/);
  assert.match(rendererSrc, /showQuota/);
  assert.match(rendererSrc, /账号剩余额度/);
  assert.match(rendererSrc, /backdrop-filter:\s*blur\(16px\)/);
  assert.match(wallpaperSrc, /__agyMonitorWallpaper/);
  assert.match(wallpaperSrc, /__agyMonLayerEngine/);
  assert.match(wallpaperSrc, /agy-monitor-native-hud/);
  assert.match(mainSrc, /remote-debugging-port/);
  assert.match(mainSrc, /web-contents-created/);
  assert.match(rendererSrc, /computeHudBudget/);
  assert.match(rendererSrc, /data-collapsed="1"/);
  assert.match(rendererSrc, /data-compact-ring/);
  assert.match(rendererSrc, /data-qhover/);
  assert.match(rendererSrc, /mCacheSeg/);
  assert.doesNotMatch(rendererSrc, /title="点击选择底部显示项"/);
  assert.match(mainSrc, /native_wallpaper\.css/);

  const cssSample = buildHostWallpaperCss(
    { opacity: 80, blur: 6, dim: 20, hostBlendPct: 25, fit: 'cover', colors: { canvas: '#14161D', accent: '#5B8CFF' } },
    'data:image/webp;base64,AAAA',
  );
  assert.match(cssSample, /--card:/);
  assert.match(cssSample, /--shell-canvas:\s*transparent/);
  assert.match(cssSample, /\.bg-card/);
  assert.match(cssSample, /bg-sidebar\[style\*="sticky"\]/);
  assert.match(cssSample, /\.sticky\.bg-background/);
  assert.match(cssSample, /sticky-main/);
  assert.match(cssSample, /background-attachment:\s*fixed/);
  assert.match(cssSample, /html::before/);
  const injectorSource = fs.readFileSync(
    path.resolve(process.cwd(), 'sidecars/agy_monitor/backend/hud_injector.mjs'),
    'utf8',
  );
  assert.match(injectorSource, /original-fs/);
  assert.match(cssSample, /data:image\/webp;base64,AAAA/);
  assert.match(cssSample, /blur\(6px\)/);
  assert.match(cssSample, /\.bg-sidebar/);
  assert.match(cssSample, /\.surface-composer-card/);
  assert.match(cssSample, /backdrop-filter:\s*blur\(20px\)/);
  assert.match(cssSample, /scrim-clear/);
  assert.match(cssSample, /iframe\[src\*="agy-monitor"\]/);
  assert.doesNotMatch(cssSample, /0\.96\) !important/);

  // Never inject host wallpaper/HUD into plugin:// sidecar iframes (prevents duplicate wallpaper inside AGY Console)
  assert.equal(
    isAntigravityAppTarget({
      type: 'iframe',
      url: 'plugin://agy-monitor--agy_monitor-63521/?token=abc',
      title: 'plugin://agy-monitor--agy_monitor-63521/?token=abc',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/1',
    }),
    false,
  );
  assert.equal(
    isAntigravityAppTarget({
      type: 'iframe',
      url: 'plugin://swarm--swarm_board-49902/?token=abc',
      title: 'plugin://swarm--swarm_board-49902/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/2',
    }),
    false,
  );
  assert.equal(
    isAntigravityAppTarget({
      type: 'page',
      url: 'https://127.0.0.1:54966/c/123?project=abc&tab=sidecar__agy-monitor%2Fagy_monitor__%2F',
      title: 'Test - Antigravity',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/3',
    }),
    true,
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-routes-'));
  try {
    const asarPath = path.join(tmpDir, 'app.asar');
    fs.writeFileSync(
      asarPath,
      buildSyntheticAsar({
        'package.json': JSON.stringify({ name: 'antigravity', version: '2.35.1', main: 'dist/main.js' }),
        'dist/main.js': '"use strict";\nconsole.log("ok");\n',
      }),
    );
    const paths = resolvePaths({
      appDataDir: path.join(tmpDir, 'appdata'),
      geminiConfigDir: path.join(tmpDir, 'config'),
      hostAsarPath: asarPath,
      devToolsActivePortFile: path.join(tmpDir, 'missing_dt'),
    });
    const storage = createStorage(paths);
    const themes = await storage.getThemes();
    assert.equal(themes.hudEnabled, true);
    assert.equal(themes.hudInjectionMode, 'asar');
    assert.equal(themes.hudAutoReinject, true);
    assert.equal(themes.hostThemeMode, 'inject');

    // Stage live wallpaper CSS for Scheme 3 (inject) and verify clear on backdrop/disabled
    const stagedOn = await stageLiveWallpaperCss(paths, themes);
    assert.equal(stagedOn.staged, true);
    assert.equal(stagedOn.hasCss, true);
    assert.equal(fs.existsSync(paths.nativeWallpaperCssFile), true);
    assert.match(fs.readFileSync(paths.nativeWallpaperCssFile, 'utf8'), /html::before/);

    const stagedOff = await stageLiveWallpaperCss(paths, { ...themes, hostThemeMode: 'backdrop' });
    assert.equal(stagedOff.staged, true);
    assert.equal(stagedOff.hasCss, false);
    assert.equal(fs.readFileSync(paths.nativeWallpaperCssFile, 'utf8'), '');

    // Heartbeat freshness check (HUD + Wallpaper tracked independently)
    fs.writeFileSync(
      paths.nativeHudStatusFile,
      JSON.stringify({ version: NATIVE_HUD_VERSION, pid: 1234, mountedCount: 1, wallpaperCount: 1, updatedAtMs: Date.now() }),
    );
    const hb = readNativeHudHeartbeat(paths);
    assert.equal(hb.alive, true);
    assert.equal(hb.hookAlive, true);
    assert.equal(hb.wallpaperAlive, true);
    assert.equal(hb.wallpaperCount, 1);

    const fakeCdp = {
      sync: async () => ({ connected: false, hudInjected: false, styleApplied: false, port: 9229 }),
      getStatus: () => ({ connected: false, hudInjected: false, styleApplied: false, port: 9229 }),
      isHudInjected: () => false,
      updateHudData: async () => false,
    };
    const routes = createMonitorHandlers({
      paths,
      storage,
      cdpBridge: fakeCdp,
      hudPublisher: { refreshFromDb: async () => {} },
    });

    // Scheme 3 backdrop action installs app.asar hook and stages live CSS
    const backdropActionHandler = routes.get('POST /api/theme/backdrop/action');
    assert.equal(typeof backdropActionHandler, 'function');
    const injectRes = await backdropActionHandler({ action: 'inject_sync', hostThemeMode: 'inject' });
    assert.equal(injectRes.ok, true);
    assert.equal(injectRes.themeState.hostThemeMode, 'inject');
    assert.equal(injectRes.status.nativeHud.state, 'installed');
    assert.match(fs.readFileSync(paths.nativeWallpaperCssFile, 'utf8'), /html::before/);

    const installHandler = routes.get('POST /api/hud/native/action');
    assert.equal(typeof installHandler, 'function');
    const statusHandler = routes.get('GET /api/hud/native/status');
    const statusRes = await statusHandler();
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.config.hudInjectionMode, 'asar');
    assert.equal(statusRes.nativeHud.state, 'installed');

    // Restore stock restores app.asar, switches hostThemeMode off inject, and clears staged CSS
    const restoreRes = await installHandler({ action: 'restore' });
    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.nativeHud.state, 'stock');
    assert.equal(restoreRes.themeState.hostThemeMode, 'backdrop');
    assert.equal(fs.readFileSync(paths.nativeWallpaperCssFile, 'utf8'), '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('hud_injector: main hook wallpaper cleanup does not leak global window.el', () => {
  const mainSrc = buildMainHookScript();
  assert.doesNotMatch(mainSrc, /var el = document\.getElementById\("agy-monitor-cdp-theme"\)/);

  const match = mainSrc.match(
    /\.executeJavaScript\(\s*'([^']*agy-monitor-cdp-theme[^']*)'/,
  );
  assert.ok(match, 'expected wallpaper cleanup executeJavaScript expression in buildMainHookScript');

  const sentinelFn = () => 'host-el-intact';
  const ctx = {
    el: sentinelFn,
    document: { getElementById: () => null },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(match[1], ctx);

  assert.equal(ctx.window.el, sentinelFn);
  assert.equal(ctx.el, sentinelFn);
});
