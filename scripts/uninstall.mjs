/**
 * Clean uninstaller for AGY Console (agy-monitor).
 *
 * - Stops the optional Windows/macOS companions if running.
 * - Restores stock Antigravity app.asar when patched and cleans runtime staged injection files.
 * - Removes ~/.gemini/config/plugins/agy-monitor.
 * - Preserves ~/.gemini/antigravity/plugin_data/agy-monitor user preferences/themes/wallpapers by default
 *   (pass --purge-data to also delete saved preferences, themes & wallpapers).
 * - Never touches ~/.gemini/config/config.json.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreStockAsarSync } from '../sidecars/agy_monitor/backend/hud_injector.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_TARGET_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-monitor');
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-monitor');
const DEFAULT_SIDECAR_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-monitor');

const RUNTIME_STAGED_FILES = [
  'native_wallpaper.css',
  'native_hud_renderer.js',
  'native_wallpaper_engine.js',
  'native_host_i18n.js',
  'native_hud_status.json',
  'hud_telemetry.json',
  'hud_active_view.json',
];

function rmDirSyncWithRetry(dirPath, attempts = 12, delayMs = 200) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(err?.code) || i === attempts - 1) {
        throw err;
      }
      Atomics.wait(sab, 0, 0, delayMs);
    }
  }
  if (lastErr) throw lastErr;
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

export function uninstallPlugin({
  targetDir = DEFAULT_TARGET_DIR,
  pluginDataDir = DEFAULT_DATA_DIR,
  sidecarDataDir = DEFAULT_SIDECAR_DATA_DIR,
  hostAsarPath = undefined,
  purgeData = false,
  silent = false,
} = {}) {
  const log = (...args) => {
    if (!silent) console.log(...args);
  };

  log('');
  log('========================================================');
  log('   AGY 控制台 (agy-monitor) 卸载程序');
  log('========================================================');

  // Step 1: Stop Windows or macOS companions cleanly before removing files
  const backdropExe = path.join(pluginDataDir, 'bin', 'agy_backdrop.exe');
  const petExe = path.join(pluginDataDir, 'bin', 'agy_desktop_pet.exe');
  const petMacBin = path.join(pluginDataDir, 'bin', 'agy_desktop_pet_mac');
  if (process.platform === 'win32' && (fs.existsSync(backdropExe) || fs.existsSync(petExe))) {
    if (fs.existsSync(backdropExe)) {
      try {
        execFileSync(backdropExe, ['--stop'], { timeout: 4000, windowsHide: true, stdio: 'ignore' });
        log('[1/4] 已停止 Windows 整机壁纸伴侣进程');
      } catch {
        log('[1/4] 整机壁纸伴侣当前未运行');
      }
    }
    if (fs.existsSync(petExe)) {
      try {
        execFileSync(petExe, ['--stop'], { timeout: 4000, windowsHide: true, stdio: 'ignore' });
        log('[1/4] 已停止 Windows 桌宠伴侣进程');
      } catch {
        log('[1/4] 桌宠伴侣当前未运行');
      }
    }
  } else if (process.platform === 'darwin' && fs.existsSync(petMacBin)) {
    try {
      execFileSync(petMacBin, ['--stop', '--data-dir', pluginDataDir], { timeout: 4000, stdio: 'ignore' });
      log('[1/4] 已停止 macOS 桌宠伴侣进程');
    } catch {
      log('[1/4] macOS 桌宠伴侣当前未运行');
    }
  } else {
    log('[1/4] 无需停止外部伴侣进程');
  }

  // Step 2: Restore stock app.asar (when explicitly targeted or running default Windows uninstall)
  // and clean runtime staged injection files without deleting saved user config.
  let asarRestored = false;
  let asarPendingRestart = false;
  const isDefaultDataDir = path.resolve(pluginDataDir) === path.resolve(DEFAULT_DATA_DIR);
  const shouldRestoreHostAsar =
    typeof hostAsarPath === 'string' || (isDefaultDataDir && process.platform === 'win32');

  if (shouldRestoreHostAsar) {
    try {
      const asarRes = restoreStockAsarSync({
        pluginDataDir,
        ...(typeof hostAsarPath === 'string' ? { hostAsarPath } : {}),
      });
      asarRestored = Boolean(asarRes?.ok && asarRes?.diskWritten);
      asarPendingRestart = Boolean(asarRes?.pendingRestart && !asarRes?.diskWritten);
      if (asarRestored) {
        log(`[2/4] 已还原 Antigravity 原版 app.asar：${asarRes.asarPath}`);
      } else if (asarRes?.alreadyStock) {
        log('[2/4] Antigravity app.asar 已为原版，无需还原');
      } else if (asarPendingRestart) {
        log('[2/4] app.asar 当前被运行中的 Antigravity 占用，内置钩子已进入休眠；关闭客户端后再次运行卸载即可还原原版');
      } else {
        log('[2/4] 未检测到需要还原的 app.asar');
      }
    } catch {
      log('[2/4] 还原 app.asar 时跳过（客户端可能正在运行，内置钩子已进入休眠）');
    }
  } else {
    log('[2/4] 已跳过系统 app.asar 还原（非默认安装环境）');
  }

  if (!purgeData && fs.existsSync(pluginDataDir)) {
    for (const fileName of RUNTIME_STAGED_FILES) {
      try {
        fs.rmSync(path.join(pluginDataDir, fileName), { force: true });
      } catch {
        // ignore
      }
    }
  }

  let removedPlugin = false;
  const st = fs.lstatSync(targetDir, { throwIfNoEntry: false });
  if (st) {
    if (st.isSymbolicLink()) {
      try {
        fs.rmdirSync(targetDir);
      } catch {
        fs.unlinkSync(targetDir);
      }
    } else {
      rmDirSyncWithRetry(targetDir);
    }
    removedPlugin = true;
    log(`[3/4] 已移除插件目录：${targetDir}`);
  } else {
    log(`[3/4] 未检测到已安装的插件目录：${targetDir}`);
  }

  let purgedData = false;
  if (purgeData) {
    if (fs.existsSync(pluginDataDir)) {
      rmDirSyncWithRetry(pluginDataDir);
      purgedData = true;
    }
    if (fs.existsSync(sidecarDataDir)) {
      rmDirSyncWithRetry(sidecarDataDir);
      purgedData = true;
    }
    log('[4/4] 已彻底清除个人配置、自定义壁纸与本地缓存数据');
  } else {
    log(`[4/4] 已保留个人配置与壁纸目录（已清理运行时注入缓存）：${pluginDataDir}`);
    log('      （如需连同个人配置一并清空，可追加参数 --purge-data）');
  }

  log('');
  log('✓ 卸载完成。如 Antigravity 正在运行，重启一次即可彻底清理面板缓存。');
  log('');

  return {
    ok: true,
    removedPlugin,
    purgedData,
    asarRestored,
    asarPendingRestart,
    targetDir,
    pluginDataDir,
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    if (arg.startsWith('--target=')) opts.targetDir = arg.slice('--target='.length);
    else if (arg.startsWith('--data-dir=')) opts.pluginDataDir = arg.slice('--data-dir='.length);
    else if (arg === '--purge-data') opts.purgeData = true;
    else if (arg === '--json') opts.json = true;
  }
  return opts;
}

const isEntrypoint = isSameEntrypoint(process.argv[1], __filename);

if (isEntrypoint) {
  const opts = parseCliArgs(process.argv.slice(2));
  const res = uninstallPlugin({ ...opts, silent: Boolean(opts.json) });
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
  }
}
