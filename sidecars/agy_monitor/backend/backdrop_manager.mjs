import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteBuffer, atomicWriteText } from './paths.mjs';
import {
  detectWindowsHostEnv,
  resolveWindowsHostDirs,
  toWindowsPath,
} from './wsl_bridge.mjs';

const COMPANION_ACTIVE_TTL_MS = 10_000;

function writeUtf16LeBom(filePath, content) {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(content ?? ''), 'utf16le')]);
  return atomicWriteBuffer(filePath, buf);
}

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
 * In WSL2 with Windows Interop, Windows executables launched via Interop run
 * directly on the user's interactive Windows desktop.
 */
export async function detectOwnDesktopInfo({ force = false, exePath = '' } = {}) {
  const hostInfo = detectWindowsHostEnv();
  if (!hostInfo.hasWindowsHost) {
    return {
      isWindows: false,
      isWsl: false,
      desktopName: 'non-win32',
      canAutoLaunch: false,
      desktopIsolated: true,
    };
  }
  if (hostInfo.isWsl) {
    return {
      isWindows: true,
      isWsl: true,
      desktopName: 'wsl-interop',
      canAutoLaunch: true,
      desktopIsolated: false,
    };
  }
  if (process.env.AGY_MONITOR_SKIP_DESKTOP_PROBE === '1') {
    return {
      isWindows: true,
      isWsl: false,
      desktopName: 'skipped',
      canAutoLaunch: false,
      desktopIsolated: true,
    };
  }
  if (cachedDesktopInfo && !force) {
    return cachedDesktopInfo;
  }

  // Fast native path (~20ms): ask compiled agy_backdrop.exe directly instead of cold-starting PowerShell + csc Add-Type
  if (exePath && fs.existsSync(exePath)) {
    try {
      const { stdout } = await execFileAsync(exePath, ['--probe-desktop'], { timeout: 3000 });
      const desktopName = String(stdout || '').trim();
      if (desktopName && desktopName.toLowerCase() !== 'unknown') {
        const isDefaultDesktop = desktopName.toLowerCase() === 'default';
        cachedDesktopInfo = {
          isWindows: true,
          isWsl: false,
          desktopName,
          canAutoLaunch: isDefaultDesktop,
          desktopIsolated: !isDefaultDesktop,
        };
        return cachedDesktopInfo;
      }
    } catch {
      // Fall through to PowerShell probe when binary is older or busy
    }
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
    ], { timeout: 12000 });
    const desktopName = String(stdout || '').trim() || 'unknown';
    const isDefaultDesktop = desktopName.toLowerCase() === 'default';
    const resolved = {
      isWindows: true,
      isWsl: false,
      desktopName,
      canAutoLaunch: isDefaultDesktop,
      desktopIsolated: !isDefaultDesktop,
    };
    // Never poison cache on transient "unknown" probe failures
    if (desktopName.toLowerCase() !== 'unknown') {
      cachedDesktopInfo = resolved;
    }
    return resolved;
  } catch {
    return {
      isWindows: true,
      isWsl: false,
      desktopName: 'unknown',
      canAutoLaunch: false,
      desktopIsolated: true,
    };
  }
}

/**
 * Emergency opaque recovery: invoke agy_backdrop.exe --restore-opacity so any
 * Antigravity host window left translucent by a crashed companion is immediately restored.
 */
export async function restoreHostOpacityFallback(paths) {
  const hostInfo = detectWindowsHostEnv();
  if (!hostInfo.hasWindowsHost) return false;
  const rt = await resolveBackdropRuntimePaths(paths, hostInfo);
  if (!rt?.exePosix || !fs.existsSync(rt.exePosix)) return false;
  try {
    await execFileAsync(rt.exePosix, ['--restore-opacity'], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
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

export async function resolveBackdropRuntimePaths(paths, hostInfo = detectWindowsHostEnv()) {
  if (hostInfo.isNativeWindows) {
    return {
      binDirPosix: paths?.backdropBinDir || '',
      exePosix: paths?.backdropExeFile || '',
      exeWin: paths?.backdropExeFile || '',
      hashPosix: paths?.backdropHashFile || '',
      stagedSrcPosix: '',
      srcWin: paths?.backdropSourceFile || '',
      launcherVbsPosix: paths?.backdropLauncherVbs || '',
      launcherVbsWin: paths?.backdropLauncherVbs || '',
      launcherCmdPosix: paths?.backdropLauncherCmd || '',
      launcherCmdWin: paths?.backdropLauncherCmd || '',
      dataDirWin: paths?.pluginDataDir || '',
      assetsDirWin: paths?.wallpapersDir || '',
    };
  }

  const dirs = await resolveWindowsHostDirs(hostInfo);
  const dataDirWin = await toWindowsPath(paths?.pluginDataDir || '', hostInfo);
  const assetsDirWin = await toWindowsPath(paths?.wallpapersDir || '', hostInfo);

  if (dirs.stagingDirPosix && dirs.stagingDirWin) {
    const binDirPosix = `${dirs.stagingDirPosix}/bin`;
    const binDirWin = `${dirs.stagingDirWin}\\bin`;
    return {
      binDirPosix,
      exePosix: `${binDirPosix}/agy_backdrop.exe`,
      exeWin: `${binDirWin}\\agy_backdrop.exe`,
      hashPosix: `${binDirPosix}/agy_backdrop.sha1`,
      stagedSrcPosix: `${binDirPosix}/AgyBackdrop.cs`,
      srcWin: `${binDirWin}\\AgyBackdrop.cs`,
      launcherVbsPosix: `${dirs.stagingDirPosix}/launch_backdrop.vbs`,
      launcherVbsWin: `${dirs.stagingDirWin}\\launch_backdrop.vbs`,
      launcherCmdPosix: `${dirs.stagingDirPosix}/启动整机壁纸伴侣.cmd`,
      launcherCmdWin: `${dirs.stagingDirWin}\\启动整机壁纸伴侣.cmd`,
      dataDirWin,
      assetsDirWin,
    };
  }

  return {
    binDirPosix: paths?.backdropBinDir || '',
    exePosix: paths?.backdropExeFile || '',
    exeWin: await toWindowsPath(paths?.backdropExeFile || '', hostInfo),
    hashPosix: paths?.backdropHashFile || '',
    stagedSrcPosix: '',
    srcWin: await toWindowsPath(paths?.backdropSourceFile || '', hostInfo),
    launcherVbsPosix: paths?.backdropLauncherVbs || '',
    launcherVbsWin: await toWindowsPath(paths?.backdropLauncherVbs || '', hostInfo),
    launcherCmdPosix: paths?.backdropLauncherCmd || '',
    launcherCmdWin: await toWindowsPath(paths?.backdropLauncherCmd || '', hostInfo),
    dataDirWin,
    assetsDirWin,
  };
}

/**
 * Compile AgyBackdrop.cs -> agy_backdrop.exe when source changes and emit desktop launchers.
 * Supports both native Windows and Win + WSL2 via Windows Interop.
 */
export async function ensureBackdropAssets(paths) {
  const hostInfo = detectWindowsHostEnv();
  if (!hostInfo.hasWindowsHost) {
    return { supported: false, isWsl: false, compiled: false, reason: 'Windows only' };
  }
  if (!paths?.backdropSourceFile || !fs.existsSync(paths.backdropSourceFile)) {
    return { supported: true, isWsl: hostInfo.isWsl, compiled: false, reason: 'Backdrop source missing' };
  }
  if (!hostInfo.cscPath || !fs.existsSync(hostInfo.cscPath)) {
    return {
      supported: true,
      isWsl: hostInfo.isWsl,
      compiled: false,
      reason: '.NET Framework csc.exe missing',
    };
  }

  const doWork = async () => {
    if (paths?.pluginDataDir) {
      await fsp.mkdir(paths.pluginDataDir, { recursive: true }).catch(() => {});
    }
    const rt = await resolveBackdropRuntimePaths(paths, hostInfo);
    const sourceBuf = await fsp.readFile(paths.backdropSourceFile);
    const sourceHash = crypto.createHash('sha1').update(sourceBuf).digest('hex');

    let prevHash = '';
    try {
      prevHash = (await fsp.readFile(rt.hashPosix, 'utf8')).trim();
    } catch {
      prevHash = '';
    }

    const exeExists = Boolean(rt.exePosix && fs.existsSync(rt.exePosix));
    let compiledNow = false;
    if (!exeExists || prevHash !== sourceHash) {
      await fsp.mkdir(rt.binDirPosix, { recursive: true });
      if (rt.stagedSrcPosix) {
        await fsp.writeFile(rt.stagedSrcPosix, sourceBuf);
      }
      const tmpExePosix = `${rt.exePosix}.tmp.${process.pid}.exe`;
      const tmpExeWin = `${rt.exeWin}.tmp.${process.pid}.exe`;
      const wpfWin = hostInfo.wpfDirWin;
      try {
        await execFileAsync(hostInfo.cscPath, [
          '/nologo',
          '/codepage:65001',
          '/utf8output',
          '/target:winexe',
          '/optimize+',
          `/out:${tmpExeWin}`,
          `/r:${wpfWin}\\PresentationCore.dll`,
          `/r:${wpfWin}\\PresentationFramework.dll`,
          `/r:${wpfWin}\\WindowsBase.dll`,
          `/r:${wpfWin}\\UIAutomationClient.dll`,
          `/r:${wpfWin}\\UIAutomationTypes.dll`,
          '/r:System.Xaml.dll',
          '/r:System.Windows.Forms.dll',
          '/r:System.Drawing.dll',
          '/r:System.Web.Extensions.dll',
          rt.srcWin,
        ], { timeout: 25000 });
        let replaced = false;
        try {
          await fsp.rename(tmpExePosix, rt.exePosix);
          replaced = true;
        } catch {
          // If an older companion binary is currently running and locking the .exe, stop it cleanly before replacing
          if (fs.existsSync(rt.exePosix)) {
            await execFileAsync(rt.exePosix, ['--stop'], { timeout: 3000 }).catch(() => {});
          }
          for (let attempt = 0; attempt < 8 && !replaced; attempt += 1) {
            await new Promise((r) => setTimeout(r, 200));
            try {
              await fsp.rename(tmpExePosix, rt.exePosix);
              replaced = true;
            } catch {
              try {
                await fsp.copyFile(tmpExePosix, rt.exePosix);
                await fsp.rm(tmpExePosix, { force: true }).catch(() => {});
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
        await atomicWriteText(rt.hashPosix, `${sourceHash}\n`);
        compiledNow = true;
      } catch (err) {
        await fsp.rm(tmpExePosix, { force: true }).catch(() => {});
        return {
          supported: true,
          isWsl: hostInfo.isWsl,
          compiled: false,
          error: err?.stderr || err?.stdout || err?.message || 'csc compile failed',
        };
      }
    }

    await writeUtf16LeBom(
      rt.launcherVbsPosix,
      buildLauncherVbsContent(rt.exeWin, rt.dataDirWin, rt.assetsDirWin),
    );
    await atomicWriteText(
      rt.launcherCmdPosix,
      buildLauncherCmdContent(rt.launcherVbsWin),
    );

    return {
      supported: true,
      isWsl: hostInfo.isWsl,
      compiled: true,
      compiledNow,
      exePath: rt.exeWin,
      exePosixPath: rt.exePosix,
      launcherVbsPath: rt.launcherVbsWin,
      launcherCmdPath: rt.launcherCmdWin,
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
  const hostInfo = detectWindowsHostEnv();
  const rt = hostInfo.hasWindowsHost ? await resolveBackdropRuntimePaths(paths, hostInfo) : null;
  const exeExists = Boolean(rt?.exePosix && fs.existsSync(rt.exePosix));
  const desk = await detectOwnDesktopInfo({ exePath: exeExists ? rt.exePosix : '' });

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
  // On WSL2, raw.pid is a Windows PID that does not exist in Linux kernel; rely on heartbeat TTL.
  const pidAlive = hostInfo.isWsl ? true : (pid > 0 ? isPidAlive(pid) : true);
  const running = Boolean(
    raw?.running === true && ageMs <= COMPANION_ACTIVE_TTL_MS && pidAlive,
  );

  const launcherCmdPath = rt?.launcherCmdWin || paths?.backdropLauncherCmd || '';
  const launcherVbsPath = rt?.launcherVbsWin || paths?.backdropLauncherVbs || '';
  const quickLaunchCommand = launcherVbsPath
    ? `wscript.exe //Nologo "${launcherVbsPath}"`
    : '';

  return {
    supported: hostInfo.hasWindowsHost,
    isWsl: hostInfo.isWsl,
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
    zeroUiaMode: Boolean(themes?.zeroUiaMode),
    hostThemeMode:
      themes?.hostThemeMode === 'cdp' || themes?.hostThemeMode === 'backdrop' ? themes.hostThemeMode : 'inject',
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
  const hostInfo = detectWindowsHostEnv();
  if (!hostInfo.hasWindowsHost) {
    return {
      ok: false,
      error: '贴背壁纸伴侣仅支持 Windows 或 Win + WSL2 桌面环境',
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

  const rt = await resolveBackdropRuntimePaths(paths, hostInfo);
  const desk = await detectOwnDesktopInfo({ exePath: rt?.exePosix || '' });
  const current = await getBackdropStatus(paths, themes);

  const hostMode =
    themes?.hostThemeMode === 'cdp' || themes?.hostThemeMode === 'backdrop' ? themes.hostThemeMode : 'inject';
  const wantRunning =
    action === 'start'
      ? true
      : action === 'stop'
        ? false
        : action === 'sync'
          ? Boolean(
              (themes?.backdropEnabled && themes?.activeWallpaperId && hostMode === 'backdrop') ||
                (themes?.hudEnabled !== false && themes?.hudInjectionMode === 'uia' && !themes?.zeroUiaMode),
            )
          : current.running;

  let launched = false;
  let stopped = false;

  if (desk.canAutoLaunch) {
    if (wantRunning && !current.running) {
      const child = hostInfo.isWsl && hostInfo.wscriptPath
        ? spawn(hostInfo.wscriptPath, ['//Nologo', rt.launcherVbsWin], {
            detached: true,
            stdio: 'ignore',
          })
        : spawn(
            rt.exePosix,
            ['--data-dir', rt.dataDirWin, '--assets-dir', rt.assetsDirWin],
            { detached: true, stdio: 'ignore', windowsHide: true },
          );
      child.on('error', () => {});
      child.unref();
      launched = true;
      const maxWaitMs = hostInfo.isWsl ? 2200 : 1800;
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        const probe = await getBackdropStatus(paths, themes).catch(() => null);
        if (probe?.running) break;
      }
    } else if (!wantRunning && current.running) {
      await execFileAsync(rt.exePosix, ['--stop'], { timeout: 5000 }).catch(() => {});
      stopped = true;
      await new Promise((r) => setTimeout(r, 250));
      await execFileAsync(rt.exePosix, ['--restore-opacity'], { timeout: 4000 }).catch(() => {});
    } else if (!wantRunning && !current.running) {
      // Even when companion already died, ensure any residual translucent Antigravity window is restored opaque
      await execFileAsync(rt.exePosix, ['--restore-opacity'], { timeout: 4000 }).catch(() => {});
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
