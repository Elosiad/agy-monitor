import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteText } from './paths.mjs';

const CSC_PATH = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const WPF_DIR = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF';
const COMPANION_ACTIVE_TTL_MS = 10_000;

let cachedDesktopInfo = null;
let compilePromise = null;

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Inspect only the current Node process's own Win32 thread desktop name.
 * Never touches or probes external processes or host internals.
 */
export async function detectOwnDesktopInfo({ force = false } = {}) {
  if (process.platform !== 'win32') {
    return { isWindows: false, desktopName: 'non-win32', canAutoLaunch: false, desktopIsolated: true };
  }
  if (process.env.AGY_MONITOR_SKIP_DESKTOP_PROBE === '1') {
    return { isWindows: true, desktopName: 'skipped', canAutoLaunch: false, desktopIsolated: true };
  }
  if (cachedDesktopInfo && !force) {
    return cachedDesktopInfo;
  }

  const psScript = [
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public class AgyDeskProbe {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint dwThreadId);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpn);',
    '  public static string Name() {',
    '    var sb = new StringBuilder(128); int n;',
    '    if (GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, sb, sb.Capacity, out n)) return sb.ToString();',
    '    return "unknown";',
    '  }',
    '}',
    '"@',
    '[AgyDeskProbe]::Name()',
  ].join('\n');

  try {
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encoded,
    ], { timeout: 6000 });
    const desktopName = String(stdout || '').trim() || 'unknown';
    const isDefaultDesktop = desktopName.toLowerCase() === 'default';
    cachedDesktopInfo = {
      isWindows: true,
      desktopName,
      canAutoLaunch: isDefaultDesktop,
      desktopIsolated: !isDefaultDesktop,
    };
  } catch {
    cachedDesktopInfo = {
      isWindows: true,
      desktopName: 'unknown',
      canAutoLaunch: false,
      desktopIsolated: true,
    };
  }
  return cachedDesktopInfo;
}

function buildLauncherVbsContent(exePath, dataDir, wallpapersDir) {
  const esc = (s) => String(s).replace(/"/g, '""');
  const cmd = `"${esc(exePath)}" --data-dir "${esc(dataDir)}" --assets-dir "${esc(wallpapersDir)}"`;
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "${esc(cmd)}", 0, False`,
    '',
  ].join('\r\n');
}

function buildLauncherCmdContent(vbsPath) {
  return [
    '@echo off',
    'chcp 65001 >nul',
    `start "" wscript.exe //Nologo "${vbsPath}"`,
    '',
  ].join('\r\n');
}

/**
 * Compile AgyBackdrop.cs -> agy_backdrop.exe when source changes and emit desktop launchers.
 */
export async function ensureBackdropAssets(paths) {
  if (process.platform !== 'win32') {
    return { supported: false, compiled: false, reason: 'Windows only' };
  }
  if (!paths?.backdropSourceFile || !fs.existsSync(paths.backdropSourceFile)) {
    return { supported: true, compiled: false, reason: 'Backdrop source missing' };
  }
  if (!fs.existsSync(CSC_PATH)) {
    return { supported: true, compiled: false, reason: '.NET Framework csc.exe missing' };
  }

  const doWork = async () => {
    const sourceBuf = await fsp.readFile(paths.backdropSourceFile);
    const sourceHash = crypto.createHash('sha1').update(sourceBuf).digest('hex');

    let prevHash = '';
    try {
      prevHash = (await fsp.readFile(paths.backdropHashFile, 'utf8')).trim();
    } catch {
      prevHash = '';
    }

    const exeExists = fs.existsSync(paths.backdropExeFile);
    let compiledNow = false;
    if (!exeExists || prevHash !== sourceHash) {
      await fsp.mkdir(paths.backdropBinDir, { recursive: true });
      const tmpExe = `${paths.backdropExeFile}.tmp.${process.pid}.exe`;
      try {
        await execFileAsync(CSC_PATH, [
          '/nologo',
          '/target:winexe',
          '/optimize+',
          `/out:${tmpExe}`,
          `/r:${path.join(WPF_DIR, 'PresentationCore.dll')}`,
          `/r:${path.join(WPF_DIR, 'PresentationFramework.dll')}`,
          `/r:${path.join(WPF_DIR, 'WindowsBase.dll')}`,
          `/r:${path.join(WPF_DIR, 'UIAutomationClient.dll')}`,
          `/r:${path.join(WPF_DIR, 'UIAutomationTypes.dll')}`,
          '/r:System.Xaml.dll',
          '/r:System.Windows.Forms.dll',
          '/r:System.Drawing.dll',
          '/r:System.Web.Extensions.dll',
          paths.backdropSourceFile,
        ], { timeout: 20000 });
        let replaced = false;
        try {
          await fsp.rename(tmpExe, paths.backdropExeFile);
          replaced = true;
        } catch {
          // If an older companion binary is currently running and locking the .exe, stop it cleanly before replacing
          if (fs.existsSync(paths.backdropExeFile)) {
            await execFileAsync(paths.backdropExeFile, ['--stop'], { timeout: 3000 }).catch(() => {});
          }
          for (let attempt = 0; attempt < 8 && !replaced; attempt += 1) {
            await new Promise((r) => setTimeout(r, 200));
            try {
              await fsp.rename(tmpExe, paths.backdropExeFile);
              replaced = true;
            } catch {
              try {
                await fsp.copyFile(tmpExe, paths.backdropExeFile);
                await fsp.rm(tmpExe, { force: true }).catch(() => {});
                replaced = true;
              } catch {
                // Retry while old process finishes releasing file handle
              }
            }
          }
          if (!replaced) {
            throw new Error('Failed to replace running agy_backdrop.exe');
          }
        }
        await atomicWriteText(paths.backdropHashFile, `${sourceHash}\n`);
        compiledNow = true;
      } catch (err) {
        await fsp.rm(tmpExe, { force: true }).catch(() => {});
        if (!fs.existsSync(paths.backdropExeFile)) {
          return {
            supported: true,
            compiled: false,
            error: err?.stderr || err?.stdout || err?.message || 'csc compile failed',
          };
        }
      }
    }

    await atomicWriteText(
      paths.backdropLauncherVbs,
      buildLauncherVbsContent(paths.backdropExeFile, paths.pluginDataDir, paths.wallpapersDir),
    );
    await atomicWriteText(
      paths.backdropLauncherCmd,
      buildLauncherCmdContent(paths.backdropLauncherVbs),
    );

    return {
      supported: true,
      compiled: true,
      compiledNow,
      exePath: paths.backdropExeFile,
      launcherVbsPath: paths.backdropLauncherVbs,
      launcherCmdPath: paths.backdropLauncherCmd,
    };
  };

  if (!compilePromise) {
    compilePromise = doWork().finally(() => {
      compilePromise = null;
    });
  }
  return compilePromise;
}

/**
 * Return live companion status combined with current desktop isolation state.
 */
export async function getBackdropStatus(paths, themes = {}) {
  const desk = await detectOwnDesktopInfo();
  const exeExists = Boolean(paths?.backdropExeFile && fs.existsSync(paths.backdropExeFile));

  let raw = null;
  if (paths?.backdropStatusFile) {
    try {
      const text = await fsp.readFile(paths.backdropStatusFile, 'utf8');
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
  }

  const nowMs = Date.now();
  const pid = Number(raw?.pid || 0);
  const updatedAtMs = Number(raw?.updatedAtMs || 0);
  const ageMs = updatedAtMs > 0 ? Math.max(0, nowMs - updatedAtMs) : Infinity;
  const running = Boolean(
    raw?.running === true && (ageMs <= COMPANION_ACTIVE_TTL_MS || isPidAlive(pid)),
  );

  const launcherCmdPath = paths?.backdropLauncherCmd || '';
  const launcherVbsPath = paths?.backdropLauncherVbs || '';
  const quickLaunchCommand = launcherVbsPath
    ? `wscript.exe //Nologo "${launcherVbsPath}"`
    : '';

  return {
    supported: process.platform === 'win32',
    compiled: exeExists,
    desktopName: desk.desktopName,
    desktopIsolated: desk.desktopIsolated,
    canAutoLaunch: desk.canAutoLaunch,
    running,
    activeEffect: running && Boolean(raw?.activeEffect),
    supportsLightbox: running && Boolean(raw?.supportsLightbox),
    paused: running && Boolean(raw?.paused),
    trackedCount: running ? Number(raw?.trackedCount || 0) : 0,
    appliedAlpha: running ? Number(raw?.appliedAlpha || 255) : 255,
    backdropEnabled: Boolean(themes?.backdropEnabled),
    hudEnabled: themes?.hudEnabled !== false,
    hostThemeMode: themes?.hostThemeMode === 'cdp' ? 'cdp' : 'backdrop',
    cdpPort: Number(themes?.cdpPort || 9229),
    hudVisible: running && Boolean(raw?.hudVisible),
    hudAnchorFound: running && Boolean(raw?.hudAnchorFound),
    hostBlendPct: Number(themes?.hostBlendPct ?? 18),
    hasWallpaper: Boolean(themes?.activeWallpaperId),
    launcherCmdPath,
    launcherVbsPath,
    quickLaunchCommand,
  };
}

/**
 * Prepare binaries/launchers and start or stop the backdrop companion when running on interactive desktop.
 */
export async function controlBackdropCompanion(paths, themes = {}, action = 'sync') {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: '贴背壁纸伴侣仅支持 Windows 桌面系统',
      status: await getBackdropStatus(paths, themes),
    };
  }

  const prep = await ensureBackdropAssets(paths);
  if (!prep.compiled) {
    return {
      ok: false,
      error: prep.error || prep.reason || '编译桌面壁纸伴侣失败',
      status: await getBackdropStatus(paths, themes),
    };
  }

  const desk = await detectOwnDesktopInfo();
  const current = await getBackdropStatus(paths, themes);

  const wantRunning =
    action === 'start'
      ? true
      : action === 'stop'
        ? false
        : action === 'sync'
          ? Boolean((themes?.backdropEnabled && themes?.activeWallpaperId) || themes?.hudEnabled !== false)
          : current.running;

  let launched = false;
  let stopped = false;

  if (desk.canAutoLaunch) {
    if (wantRunning && !current.running) {
      const child = spawn(
        paths.backdropExeFile,
        ['--data-dir', paths.pluginDataDir, '--assets-dir', paths.wallpapersDir],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();
      launched = true;
      await new Promise((r) => setTimeout(r, 350));
    } else if (!wantRunning && current.running) {
      await execFileAsync(paths.backdropExeFile, ['--stop'], { timeout: 5000 }).catch(() => {});
      stopped = true;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const nextStatus = await getBackdropStatus(paths, themes);
  return {
    ok: true,
    launched,
    stopped,
    requiresExternalLaunch: Boolean(wantRunning && !nextStatus.running && desk.desktopIsolated),
    status: nextStatus,
  };
}
