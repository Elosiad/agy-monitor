/**
 * Clean uninstaller for AGY Console (agy-monitor).
 *
 * - Stops the optional Windows backdrop companion if running.
 * - Removes ~/.gemini/config/plugins/agy-monitor.
 * - Preserves ~/.gemini/antigravity/plugin_data/agy-monitor by default
 *   (pass --purge-data to also delete saved preferences, themes & wallpapers).
 * - Never touches ~/.gemini/config/config.json.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_TARGET_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-monitor');
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-monitor');
const DEFAULT_SIDECAR_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agy-monitor');

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

  // Stop Windows backdrop companion cleanly before removing files
  const backdropExe = path.join(pluginDataDir, 'bin', 'agy_backdrop.exe');
  if (process.platform === 'win32' && fs.existsSync(backdropExe)) {
    try {
      execFileSync(backdropExe, ['--stop'], { timeout: 4000, windowsHide: true, stdio: 'ignore' });
      log('[1/3] 已停止 Windows 整机壁纸伴侣进程');
    } catch {
      log('[1/3] 整机壁纸伴侣当前未运行');
    }
  } else {
    log('[1/3] 无需停止外部伴侣进程');
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
    log(`[2/3] 已移除插件目录：${targetDir}`);
  } else {
    log(`[2/3] 未检测到已安装的插件目录：${targetDir}`);
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
    log('[3/3] 已彻底清除个人配置、自定义壁纸与本地缓存数据');
  } else {
    log(`[3/3] 已保留个人配置与壁纸目录：${pluginDataDir}`);
    log('      （如需连同个人配置一并清空，可追加参数 --purge-data）');
  }

  log('');
  log('✓ 卸载完成。如 Antigravity 正在运行，重启一次即可彻底清理面板缓存。');
  log('');

  return {
    ok: true,
    removedPlugin,
    purgedData,
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
