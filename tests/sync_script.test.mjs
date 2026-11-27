import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { syncPluginToConfig } from '../scripts/sync_to_plugins.mjs';
import { installPlugin } from '../scripts/install.mjs';
import { uninstallPlugin } from '../scripts/uninstall.mjs';
import {
  computeAsarIntegrity,
  inspectNativeHudState,
  installNativeHud,
} from '../sidecars/agy_monitor/backend/hud_injector.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNC_SCRIPT = path.resolve(__dirname, '../scripts/sync_to_plugins.mjs');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sync-test-'));
  const sourceRoot = path.join(root, 'source');
  const targetDir = path.join(root, 'target');

  fs.mkdirSync(path.join(sourceRoot, 'assets', 'wallpapers'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'sidecars', 'agy_monitor', 'backend'), { recursive: true });

  fs.writeFileSync(path.join(sourceRoot, 'plugin.json'), '{"name":"agy-monitor"}\n', 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"agy-monitor"}\n', 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'assets', 'logo.svg'), '<svg/>', 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'rules', 'AGENTS.md'), '', 'utf8');
  fs.writeFileSync(
    path.join(sourceRoot, 'sidecars', 'agy_monitor', 'main.mjs'),
    '// clean main\n',
    'utf8',
  );

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, sourceRoot, targetDir };
}

test('syncPluginToConfig mirror-cleans legacy files in assets/sidecars while protecting target rules/AGENTS.md', (t) => {
  const { sourceRoot, targetDir } = makeFixture(t);

  // Simulate legacy installed copy containing stale host_bridge.mjs and active user rule
  const legacyBackend = path.join(targetDir, 'sidecars', 'agy_monitor', 'backend');
  const legacyAssets = path.join(targetDir, 'assets');
  const targetRulesDir = path.join(targetDir, 'rules');
  fs.mkdirSync(legacyBackend, { recursive: true });
  fs.mkdirSync(legacyAssets, { recursive: true });
  fs.mkdirSync(targetRulesDir, { recursive: true });

  const staleHostBridge = path.join(legacyBackend, 'host_bridge.mjs');
  const staleAsset = path.join(legacyAssets, 'old.txt');
  const targetRulesPath = path.join(targetRulesDir, 'AGENTS.md');
  fs.writeFileSync(staleHostBridge, 'stale code', 'utf8');
  fs.writeFileSync(staleAsset, 'old asset', 'utf8');
  fs.writeFileSync(targetRulesPath, '# 用户已启用规则\n- 保持中文简报。\n', 'utf8');

  const res = syncPluginToConfig({ sourceRoot, targetDir });
  assert.equal(res.prevAction, 'kept_directory_for_mirror');
  assert.deepEqual(res.prunedDirs.sort(), ['assets', 'sidecars']);
  assert.equal(res.rulesStatus, 'preserved_existing');
  assert.equal(fs.existsSync(staleHostBridge), false, 'deleted source files must be pruned from target');
  assert.equal(fs.existsSync(staleAsset), false);
  assert.equal(
    fs.readFileSync(targetRulesPath, 'utf8'),
    '# 用户已启用规则\n- 保持中文简报。\n',
    'existing user rules/AGENTS.md must not be overwritten',
  );
  assert.equal(fs.existsSync(path.join(targetDir, 'sidecars', 'agy_monitor', 'main.mjs')), true);

  // Explicit resetRules overwrites target rules/AGENTS.md
  const resetRes = syncPluginToConfig({ sourceRoot, targetDir, resetRules: true });
  assert.equal(resetRes.rulesStatus, 'reset');
  assert.equal(fs.readFileSync(targetRulesPath, 'utf8'), '');
});

test('syncPluginToConfig initializes missing rules/AGENTS.md, unlinks junctions safely, and guards identical src/dest', (t) => {
  const { root, sourceRoot, targetDir } = makeFixture(t);
  const junctionTarget = path.join(root, 'junction-target');
  fs.symlinkSync(sourceRoot, junctionTarget, process.platform === 'win32' ? 'junction' : 'dir');

  // CLI smoke check with --source / --target replacing junction with real directory
  const stdout = execFileSync(
    process.execPath,
    [SYNC_SCRIPT, `--source=${sourceRoot}`, `--target=${junctionTarget}`],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.prevAction, 'unlinked_symlink_or_junction');
  assert.equal(parsed.rulesStatus, 'initialized');
  assert.equal(fs.lstatSync(junctionTarget).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(junctionTarget).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(sourceRoot, 'plugin.json')), true);

  // Identical source and target throws
  assert.throws(
    () => syncPluginToConfig({ sourceRoot, targetDir: sourceRoot }),
    /identical/,
  );

  // Fresh targetDir works cleanly
  const fresh = syncPluginToConfig({ sourceRoot, targetDir });
  assert.equal(fresh.prevAction, 'absent');
  assert.equal(fresh.rulesStatus, 'initialized');
});

test('installPlugin seeds pinned defaults on fresh install, preserves modified user settings on upgrade, and uninstallPlugin cleans cleanly', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-install-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const repoRoot = path.resolve(__dirname, '..');
  const targetDir = path.join(root, 'plugins', 'agy-monitor');
  const pluginDataDir = path.join(root, 'plugin_data', 'agy-monitor');
  const sidecarDataDir = path.join(root, 'sidecar_data', 'agy-monitor');

  // 1. Fresh install -> deploys plugin & seeds exact pinned default settings
  const res1 = await installPlugin({
    sourceRoot: repoRoot,
    targetDir,
    skipBackdropCompile: true,
    silent: true,
    pathsOverrides: {
      appDataDir: path.join(root, 'appData'),
      geminiConfigDir: path.join(root, 'config'),
      pluginDataDir,
      sidecarDataDir,
      brainDir: path.join(root, 'brain'),
    },
  });
  assert.equal(res1.ok, true);
  assert.deepEqual(res1.seededDefaults.sort(), ['mastery', 'prefs', 'themes']);

  const masteryCfg = JSON.parse(fs.readFileSync(path.join(pluginDataDir, 'mastery_config.json'), 'utf8'));
  const themesCfg = JSON.parse(fs.readFileSync(path.join(pluginDataDir, 'themes.json'), 'utf8'));
  const prefsCfg = JSON.parse(fs.readFileSync(path.join(pluginDataDir, 'user_prefs.json'), 'utf8'));
  assert.equal(masteryCfg.enabled, false);
  assert.equal(masteryCfg.source, 'self');
  assert.equal(masteryCfg.frequency, '1m');
  assert.equal(masteryCfg.thinking, 'low');
  assert.equal(themesCfg.activeWallpaperId, 'wp-1');
  assert.equal(themesCfg.backdropEnabled, true);
  assert.equal(themesCfg.hostBlendPct, 25);
  assert.equal(themesCfg.opacity, 100);
  assert.equal(themesCfg.blur, 0);
  assert.equal(themesCfg.dim, 0);
  assert.equal(themesCfg.radius, 10);
  assert.equal(prefsCfg.language, 'zh-CN');
  assert.equal(prefsCfg.windowCap, 512000);

  // 2. Simulate user customizing settings, then re-running installer (upgrade) -> MUST preserve user changes
  fs.writeFileSync(
    path.join(pluginDataDir, 'mastery_config.json'),
    JSON.stringify({ ...masteryCfg, enabled: true, frequency: '3m' }, null, 2),
    'utf8',
  );
  const res2 = await installPlugin({
    sourceRoot: repoRoot,
    targetDir,
    skipBackdropCompile: true,
    silent: true,
    pathsOverrides: {
      appDataDir: path.join(root, 'appData'),
      geminiConfigDir: path.join(root, 'config'),
      pluginDataDir,
      sidecarDataDir,
      brainDir: path.join(root, 'brain'),
    },
  });
  assert.deepEqual(res2.seededDefaults, []);
  const masteryAfterUpgrade = JSON.parse(fs.readFileSync(path.join(pluginDataDir, 'mastery_config.json'), 'utf8'));
  assert.equal(masteryAfterUpgrade.enabled, true);
  assert.equal(masteryAfterUpgrade.frequency, '3m');

  // 3. Uninstall default preserves plugin_data; --purge-data removes it
  const un1 = uninstallPlugin({ targetDir, pluginDataDir, sidecarDataDir, purgeData: false, silent: true });
  assert.equal(un1.removedPlugin, true);
  assert.equal(un1.purgedData, false);
  assert.equal(fs.existsSync(targetDir), false);
  assert.equal(fs.existsSync(pluginDataDir), true);

  const un2 = uninstallPlugin({ targetDir, pluginDataDir, sidecarDataDir, purgeData: true, silent: true });
  assert.equal(un2.purgedData, true);
  assert.equal(fs.existsSync(pluginDataDir), false);
});

test('uninstallPlugin: restores patched host app.asar, cleans runtime staged files, and preserves user config', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-uninstall-asar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const targetDir = path.join(root, 'plugins', 'agy-monitor');
  const pluginDataDir = path.join(root, 'plugin_data', 'agy-monitor');
  const sidecarDataDir = path.join(root, 'sidecar_data', 'agy-monitor');
  const asarPath = path.join(root, 'app.asar');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(pluginDataDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'plugin.json'), '{"name":"agy-monitor"}\n', 'utf8');
  fs.writeFileSync(path.join(pluginDataDir, 'user_prefs.json'), '{"language":"zh-CN"}\n', 'utf8');
  fs.writeFileSync(path.join(pluginDataDir, 'themes.json'), '{"activeWallpaperId":"wp-1"}\n', 'utf8');

  // Build minimal synthetic stock app.asar
  const pkgBuf = Buffer.from(JSON.stringify({ name: 'antigravity', version: '2.39.0', main: 'dist/main.js' }), 'utf8');
  const mainBuf = Buffer.from('"use strict";\nconsole.log("stock 2.39.0");\n', 'utf8');
  const asarRoot = {
    files: {
      'package.json': { size: pkgBuf.length, offset: '0', integrity: computeAsarIntegrity(pkgBuf) },
      dist: {
        files: {
          'main.js': { size: mainBuf.length, offset: String(pkgBuf.length), integrity: computeAsarIntegrity(mainBuf) },
        },
      },
    },
  };
  const jsonBuf = Buffer.from(JSON.stringify(asarRoot), 'utf8');
  const alignedLen = (jsonBuf.length + 3) & ~3;
  const headerBuf = Buffer.alloc(16 + alignedLen);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(alignedLen + 8, 4);
  headerBuf.writeUInt32LE(alignedLen + 4, 8);
  headerBuf.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(headerBuf, 16);
  fs.writeFileSync(asarPath, Buffer.concat([headerBuf, pkgBuf, mainBuf]));

  // Patch app.asar + stage runtime live assets
  const inst = await installNativeHud({
    pluginDataDir,
    hostAsarPath: asarPath,
    devToolsActivePortFile: path.join(root, 'missing_dt'),
    nativeHudStatusFile: path.join(pluginDataDir, 'native_hud_status.json'),
  });
  assert.equal(inst.ok, true);
  assert.equal(inst.status.state, 'installed');
  fs.writeFileSync(path.join(pluginDataDir, 'native_wallpaper.css'), 'html{}', 'utf8');
  fs.writeFileSync(path.join(pluginDataDir, 'native_hud_status.json'), '{}', 'utf8');

  // Run synchronous uninstall targeting synthetic hostAsarPath
  const res = uninstallPlugin({
    targetDir,
    pluginDataDir,
    sidecarDataDir,
    hostAsarPath: asarPath,
    purgeData: false,
    silent: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.removedPlugin, true);
  assert.equal(res.asarRestored, true);
  assert.equal(res.purgedData, false);

  const after = await inspectNativeHudState({
    pluginDataDir,
    hostAsarPath: asarPath,
    devToolsActivePortFile: path.join(root, 'missing_dt'),
  });
  assert.equal(after.state, 'stock');
  assert.equal(fs.existsSync(path.join(pluginDataDir, 'native_wallpaper.css')), false);
  assert.equal(fs.existsSync(path.join(pluginDataDir, 'native_hud_renderer.js')), false);
  assert.equal(fs.existsSync(path.join(pluginDataDir, 'native_host_i18n.js')), false);
  assert.equal(fs.existsSync(path.join(pluginDataDir, 'native_hud_status.json')), false);
  assert.equal(fs.existsSync(path.join(pluginDataDir, 'user_prefs.json')), true);
  assert.equal(fs.existsSync(path.join(pluginDataDir, 'themes.json')), true);
});
