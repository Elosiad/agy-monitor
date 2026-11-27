/**
 * One-click cross-platform installer for AGY Console (agy-monitor).
 *
 * - Zero npm dependencies (Node.js >= 22.5.0 built-ins only).
 * - Copies real files into ~/.gemini/config/plugins/agy-monitor (upgrade-safe:
 *   preserves existing rules/AGENTS.md and all user settings).
 * - Seeds default preferences/themes/mastery config on fresh installs only.
 * - On Windows, pre-compiles the optional desktop backdrop & composer HUD
 *   companion using built-in .NET Framework csc.exe (zero SDK needed).
 * - Never touches Antigravity app.asar or ~/.gemini/config/config.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { syncPluginToConfig } from './sync_to_plugins.mjs';
import { atomicWriteJson, resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import { ensureBackdropAssets } from '../sidecars/agy_monitor/backend/backdrop_manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SOURCE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TARGET_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-monitor');

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5;

export function checkNodeVersion(versionStr = process.versions.node) {
  const parts = String(versionStr || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  const [major = 0, minor = 0] = parts;
  const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  return {
    ok,
    current: versionStr,
    required: `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`,
  };
}

export async function installPlugin({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetDir = DEFAULT_TARGET_DIR,
  resetRules = false,
  skipBackdropCompile = false,
  pathsOverrides = {},
  silent = false,
} = {}) {
  const log = (...args) => {
    if (!silent) console.log(...args);
  };

  const ver = checkNodeVersion();
  if (!ver.ok) {
    throw new Error(
      `需要 Node.js >= ${ver.required}（当前版本 v${ver.current}）。请前往 https://nodejs.org 安装最新 LTS 版本后重试。`,
    );
  }

  log('');
  log('========================================================');
  log('   AGY 控制台 (agy-monitor) 一键安装程序');
  log('========================================================');
  log(`[1/4] 检测到 Node.js v${ver.current} (满足 >= ${ver.required})`);

  const syncRes = syncPluginToConfig({ sourceRoot, targetDir, resetRules });
  log(`[2/4] 插件文件已部署至：${syncRes.targetDir}`);
  if (syncRes.rulesStatus === 'preserved_existing') {
    log('      ✓ 检测到升级安装，已完整保留你原有的 Prompt 规则与个人设置');
  }

  // Verify essential plugin entrypoints exist in target directory
  const requiredRelPaths = [
    'plugin.json',
    'hooks.json',
    'hooks/mastery_summary_hook.mjs',
    'sidecars/agy_monitor/sidecar.json',
    'sidecars/agy_monitor/main.mjs',
  ];
  for (const rel of requiredRelPaths) {
    const full = path.join(syncRes.targetDir, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`安装校验失败：缺少核心文件 ${rel}`);
    }
  }

  // Seed default user settings if missing (never overwrites existing user modifications)
  const paths = resolvePaths({
    pluginRoot: syncRes.targetDir,
    ...pathsOverrides,
  });
  const storage = createStorage(paths);
  const existedBefore = {
    prefs: fs.existsSync(paths.userPrefsFile),
    themes: fs.existsSync(paths.themesFile),
    mastery: fs.existsSync(paths.masteryConfigFile),
  };
  await Promise.all([
    storage.getPrefs(),
    storage.getThemes(),
    storage.getMasteryConfig(),
  ]);
  const seeded = Object.entries(existedBefore)
    .filter(([, existed]) => !existed)
    .map(([k]) => k);
  log(
    seeded.length > 0
      ? `[3/4] 已写入默认配置（${seeded.join(' / ')}），后续界面修改将自动保存`
      : '[3/4] 已保留你现有的个人配置（后续修改自动保存）',
  );

  let backdropResult = { supported: process.platform === 'win32', compiled: false, skipped: true };
  if (process.platform === 'win32' && !skipBackdropCompile) {
    backdropResult = await ensureBackdropAssets(paths);
    if (backdropResult.compiled) {
      log('[4/4] Windows 整机壁纸 & 输入框圆环伴侣已预编译就绪');
    } else {
      log(`[4/4] 整机壁纸伴侣跳过预编译（${backdropResult.reason || backdropResult.error || '首次打开面板时自动重试'}）`);
    }
  } else {
    log('[4/4] 当前平台无需编译 Windows 壁纸伴侣，控制台面板已就绪');
  }

  // Optional pluggable extension install hooks (never blocks core install)
  if (!skipBackdropCompile) {
    try {
      const extLoader = await import('../sidecars/agy_monitor/extensions/loader.mjs');
      const exts = await extLoader.loadInstalledExtensions();
      for (const ext of exts) {
        if (typeof ext?.onInstall === 'function') {
          const extRes = await ext.onInstall(paths).catch(() => null);
          if (process.platform === 'darwin' && ext?.id === 'desktop_pet' && extRes) {
            if (extRes.compiled) {
              log('      ✓ macOS 原生桌面桌宠伴侣已预编译就绪');
            } else if (extRes.reason || extRes.error) {
              log(`      ! macOS 桌宠伴侣跳过预编译（${extRes.reason || extRes.error}）`);
            }
          }
        }
      }
    } catch {
      // Extensions optional
    }
  }

  // Record installed version in install_meta.json so the update badge matches local ZIP installs accurately
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(syncRes.targetDir, 'plugin.json'), 'utf8'));
    const installedVersion =
      typeof manifest?.version === 'string' && manifest.version.trim()
        ? manifest.version.trim().replace(/^v/i, '')
        : '1.0.0';
    const metaPath = path.join(paths.pluginDataDir, 'install_meta.json');
    let prevMeta = null;
    try {
      prevMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      prevMeta = null;
    }
    const prevVersion = typeof prevMeta?.version === 'string' ? prevMeta.version.trim().replace(/^v/i, '') : '';
    const keepSha = prevVersion === installedVersion && typeof prevMeta?.commitSha === 'string';
    await atomicWriteJson(metaPath, {
      version: installedVersion,
      commitSha: keepSha ? prevMeta.commitSha : '',
      shortSha: keepSha ? (prevMeta.shortSha || prevMeta.commitSha.slice(0, 7)) : '',
      updatedAtMs: Date.now(),
    });
  } catch {
    // Non-fatal metadata update failure
  }

  log('');
  log('✓ 安装完成！零侵入设计，未修改任何 Antigravity 宿主核心文件。');
  log('');
  log('下一步（只需 10 秒）：');
  log('  1. 打开 Antigravity');
  log('  2. 点击左侧 Customizations -> Plugins');
  log('  3. 找到「AGY 控制台 (agy-monitor)」并打开开关');
  log('     （如之前已开启过，关闭再重新开启一次即可加载最新版本）');
  log('');

  return {
    ok: true,
    nodeVersion: ver.current,
    targetDir: syncRes.targetDir,
    rulesStatus: syncRes.rulesStatus,
    pluginDataDir: paths.pluginDataDir,
    seededDefaults: seeded,
    backdrop: backdropResult,
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    if (arg.startsWith('--target=')) opts.targetDir = arg.slice('--target='.length);
    else if (arg.startsWith('--source=')) opts.sourceRoot = arg.slice('--source='.length);
    else if (arg === '--reset-rules') opts.resetRules = true;
    else if (arg === '--skip-backdrop') opts.skipBackdropCompile = true;
    else if (arg === '--json') opts.json = true;
  }
  return opts;
}

function isSameEntrypoint(argvPath, modulePath) {
  if (typeof argvPath !== 'string' || !argvPath) return false;
  try {
    const a = fs.realpathSync(path.resolve(argvPath));
    const b = fs.realpathSync(modulePath);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    const a = path.resolve(argvPath);
    return process.platform === 'win32' ? a.toLowerCase() === modulePath.toLowerCase() : a === modulePath;
  }
}

const isEntrypoint = isSameEntrypoint(process.argv[1], __filename);

if (isEntrypoint) {
  const opts = parseCliArgs(process.argv.slice(2));
  try {
    const res = await installPlugin({ ...opts, silent: Boolean(opts.json) });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    }
  } catch (err) {
    console.error(`\n✗ 安装失败：${err?.message || err}\n`);
    process.exit(1);
  }
}
