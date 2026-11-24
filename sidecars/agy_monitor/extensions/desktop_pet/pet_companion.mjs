/**
 * Independent Windows companion manager for the Desktop Pet extension.
 * Compiles extensions/desktop_pet/AgyDesktopPet.cs -> agy_desktop_pet.exe on demand
 * and manages its lifecycle completely independently of AgyBackdrop.
 */

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteBuffer, atomicWriteText } from '../../backend/paths.mjs';
import { detectWindowsHostEnv, resolveWindowsHostDirs, toWindowsPath } from '../../backend/wsl_bridge.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PET_SOURCE_FILE = path.join(__dirname, 'AgyDesktopPet.cs');
const PET_ACTIVE_TTL_MS = 10_000;

let cachedDesktopInfo = null;
let compilePromise = null;

function writeUtf16LeBom(filePath, content) {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(content ?? ''), 'utf16le')]);
  return atomicWriteBuffer(filePath, buf);
}

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

function buildLauncherVbs(exePath, dataDir) {
  const esc = (s) => String(s).replace(/"/g, '""');
  const cmd = `"${esc(exePath)}" --data-dir "${esc(dataDir)}"`;
  return ['Set sh = CreateObject("WScript.Shell")', `sh.Run "${esc(cmd)}", 0, False`, ''].join('\r\n');
}

async function resolvePetRuntimePaths(petPaths, hostInfo = detectWindowsHostEnv()) {
  if (hostInfo.isNativeWindows) {
    return {
      binDirPosix: petPaths.petBinDir,
      exePosix: petPaths.petExeFile,
      exeWin: petPaths.petExeFile,
      hashPosix: petPaths.petHashFile,
      stagedSrcPosix: '',
      srcWin: PET_SOURCE_FILE,
      launcherVbsPosix: petPaths.petLauncherVbs,
      launcherVbsWin: petPaths.petLauncherVbs,
      dataDirWin: petPaths.pluginDataDir,
    };
  }
  const dirs = await resolveWindowsHostDirs(hostInfo);
  const dataDirWin = await toWindowsPath(petPaths.pluginDataDir, hostInfo);
  if (dirs.stagingDirPosix && dirs.stagingDirWin) {
    const binDirPosix = `${dirs.stagingDirPosix}/bin`;
    const binDirWin = `${dirs.stagingDirWin}\\bin`;
    return {
      binDirPosix,
      exePosix: `${binDirPosix}/agy_desktop_pet.exe`,
      exeWin: `${binDirWin}\\agy_desktop_pet.exe`,
      hashPosix: `${binDirPosix}/agy_desktop_pet.sha1`,
      stagedSrcPosix: `${binDirPosix}/AgyDesktopPet.cs`,
      srcWin: `${binDirWin}\\AgyDesktopPet.cs`,
      launcherVbsPosix: `${dirs.stagingDirPosix}/launch_desktop_pet.vbs`,
      launcherVbsWin: `${dirs.stagingDirWin}\\launch_desktop_pet.vbs`,
      dataDirWin,
    };
  }
  return {
    binDirPosix: petPaths.petBinDir,
    exePosix: petPaths.petExeFile,
    exeWin: await toWindowsPath(petPaths.petExeFile, hostInfo),
    hashPosix: petPaths.petHashFile,
    stagedSrcPosix: '',
    srcWin: await toWindowsPath(PET_SOURCE_FILE, hostInfo),
    launcherVbsPosix: petPaths.petLauncherVbs,
    launcherVbsWin: await toWindowsPath(petPaths.petLauncherVbs, hostInfo),
    dataDirWin,
  };
}

async function detectDesktopAccess(exePath = '') {
  const hostInfo = detectWindowsHostEnv();
  if (!hostInfo.hasWindowsHost) {
    return { isWindows: false, isWsl: false, canAutoLaunch: false, desktopIsolated: true };
  }
  if (hostInfo.isWsl) {
    return { isWindows: true, isWsl: true, canAutoLaunch: true, desktopIsolated: false };
  }
  if (process.env.AGY_MONITOR_SKIP_DESKTOP_PROBE === '1') {
    return { isWindows: true, isWsl: false, canAutoLaunch: false, desktopIsolated: true };
  }
  if (cachedDesktopInfo) return cachedDesktopInfo;

  if (exePath && fs.existsSync(exePath)) {
    try {
      const { stdout } = await execFileAsync(exePath, ['--probe-desktop'], { timeout: 3000 });
      const desktopName = String(stdout || '').trim();
      if (desktopName && desktopName.toLowerCase() !== 'unknown') {
        const isDefault = desktopName.toLowerCase() === 'default';
        cachedDesktopInfo = {
          isWindows: true,
          isWsl: false,
          canAutoLaunch: isDefault,
          desktopIsolated: !isDefault,
        };
        return cachedDesktopInfo;
      }
    } catch {
      // Fall back to default interactive desktop check
    }
  }
  return { isWindows: true, isWsl: false, canAutoLaunch: true, desktopIsolated: false };
}

export async function ensurePetCompanionAssets(petPaths) {
  const hostInfo = detectWindowsHostEnv();
  if (!hostInfo.hasWindowsHost) {
    return { supported: false, compiled: false, reason: 'Windows only' };
  }
  if (!fs.existsSync(PET_SOURCE_FILE)) {
    return { supported: true, compiled: false, reason: 'AgyDesktopPet.cs missing' };
  }
  if (!hostInfo.cscPath || !fs.existsSync(hostInfo.cscPath)) {
    return { supported: true, compiled: false, reason: '.NET Framework csc.exe missing' };
  }

  const doWork = async () => {
    await fsp.mkdir(petPaths.pluginDataDir, { recursive: true }).catch(() => {});
    const rt = await resolvePetRuntimePaths(petPaths, hostInfo);
    const sourceBuf = await fsp.readFile(PET_SOURCE_FILE);
    const sourceHash = crypto.createHash('sha1').update(sourceBuf).digest('hex');

    let prevHash = '';
    try {
      prevHash = (await fsp.readFile(rt.hashPosix, 'utf8')).trim();
    } catch {
      prevHash = '';
    }

    const exeExists = Boolean(rt.exePosix && fs.existsSync(rt.exePosix));
    if (!exeExists || prevHash !== sourceHash) {
      await fsp.mkdir(rt.binDirPosix, { recursive: true });
      if (rt.stagedSrcPosix) {
        await fsp.writeFile(rt.stagedSrcPosix, sourceBuf);
      }
      const tmpExePosix = `${rt.exePosix}.tmp.${process.pid}.exe`;
      const tmpExeWin = `${rt.exeWin}.tmp.${process.pid}.exe`;
      const wpfWin = hostInfo.wpfDirWin;
      try {
        await execFileAsync(
          hostInfo.cscPath,
          [
            '/nologo',
            '/target:winexe',
            '/optimize+',
            `/out:${tmpExeWin}`,
            `/r:${wpfWin}\\PresentationCore.dll`,
            `/r:${wpfWin}\\PresentationFramework.dll`,
            `/r:${wpfWin}\\WindowsBase.dll`,
            '/r:System.Xaml.dll',
            '/r:System.Windows.Forms.dll',
            '/r:System.Drawing.dll',
            '/r:System.Web.Extensions.dll',
            rt.srcWin,
          ],
          { timeout: 25000 },
        );
        let replaced = false;
        try {
          await fsp.rename(tmpExePosix, rt.exePosix);
          replaced = true;
        } catch {
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
                // Retry while old process exits
              }
            }
          }
          if (!replaced) throw new Error('Failed to replace running agy_desktop_pet.exe');
        }
        await atomicWriteText(rt.hashPosix, `${sourceHash}\n`);
      } catch (err) {
        await fsp.rm(tmpExePosix, { force: true }).catch(() => {});
        return {
          supported: true,
          compiled: false,
          error: err?.stderr || err?.stdout || err?.message || 'csc compile failed',
        };
      }
    }

    await writeUtf16LeBom(rt.launcherVbsPosix, buildLauncherVbs(rt.exeWin, rt.dataDirWin));
    return {
      supported: true,
      compiled: true,
      exePath: rt.exeWin,
      exePosixPath: rt.exePosix,
    };
  };

  if (!compilePromise) {
    compilePromise = doWork().finally(() => {
      compilePromise = null;
    });
  }
  return compilePromise;
}

export async function getPetCompanionStatus(petPaths, petConfig = null) {
  const hostInfo = detectWindowsHostEnv();
  const rt = hostInfo.hasWindowsHost ? await resolvePetRuntimePaths(petPaths, hostInfo) : null;
  const exeExists = Boolean(rt?.exePosix && fs.existsSync(rt.exePosix));
  const desk = await detectDesktopAccess(exeExists ? rt.exePosix : '');

  let raw = null;
  if (petPaths?.petStatusFile) {
    try {
      const text = (await fsp.readFile(petPaths.petStatusFile, 'utf8')).replace(/^\uFEFF/, '');
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
  }

  const nowMs = Date.now();
  const pid = Number(raw?.pid || 0);
  const updatedAtMs = Number(raw?.updatedAtMs || 0);
  const ageMs = updatedAtMs > 0 ? Math.max(0, nowMs - updatedAtMs) : Infinity;
  const pidAlive = hostInfo.isWsl ? true : pid > 0 ? isPidAlive(pid) : true;
  const running = Boolean(raw?.running === true && ageMs <= PET_ACTIVE_TTL_MS && pidAlive);

  return {
    supported: hostInfo.hasWindowsHost,
    isWsl: hostInfo.isWsl,
    compiled: exeExists,
    canAutoLaunch: desk.canAutoLaunch,
    desktopIsolated: desk.desktopIsolated,
    running,
    supportsPet: hostInfo.hasWindowsHost,
    petEnabled: Boolean(petConfig ? petConfig.enabled : raw?.petEnabled),
    petVisible: running && Boolean(raw?.petVisible),
  };
}

export async function syncPetCompanion(petPaths, petConfig, action = 'sync') {
  const hostInfo = detectWindowsHostEnv();
  if (!hostInfo.hasWindowsHost) {
    return { ok: false, status: await getPetCompanionStatus(petPaths, petConfig) };
  }

  const wantRunning =
    action === 'start'
      ? true
      : action === 'stop'
        ? false
        : Boolean(petConfig?.enabled && petConfig?.displayMode !== 'panel');

  const rt = await resolvePetRuntimePaths(petPaths, hostInfo);
  const current = await getPetCompanionStatus(petPaths, petConfig);

  if (!wantRunning) {
    if (current.running && rt?.exePosix && fs.existsSync(rt.exePosix)) {
      await execFileAsync(rt.exePosix, ['--stop'], { timeout: 4000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: true, status: await getPetCompanionStatus(petPaths, petConfig) };
  }

  const prep = await ensurePetCompanionAssets(petPaths);
  if (!prep.compiled) {
    return { ok: false, error: prep.error || prep.reason, status: await getPetCompanionStatus(petPaths, petConfig) };
  }

  const desk = await detectDesktopAccess(rt.exePosix);
  if (desk.canAutoLaunch && !current.running) {
    const child =
      hostInfo.isWsl && hostInfo.wscriptPath
        ? spawn(hostInfo.wscriptPath, ['//Nologo', rt.launcherVbsWin], {
            detached: true,
            stdio: 'ignore',
          })
        : spawn(rt.exePosix, ['--data-dir', rt.dataDirWin], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
    child.on('error', () => {});
    child.unref();

    const deadline = Date.now() + (hostInfo.isWsl ? 2200 : 1800);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 180));
      const probe = await getPetCompanionStatus(petPaths, petConfig).catch(() => null);
      if (probe?.running) break;
    }
  }

  return { ok: true, status: await getPetCompanionStatus(petPaths, petConfig) };
}
