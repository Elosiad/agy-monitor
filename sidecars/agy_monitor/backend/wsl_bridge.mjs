import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const NATIVE_CSC_PATH = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const NATIVE_WPF_DIR = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF';

const WSL_CDP_TUNNEL_CS = `using System;
using System.IO;
using System.Net.Sockets;
using System.Threading;

class AgyWslCdpTunnel {
  static int Main(string[] args) {
    int port = 9229;
    string host = "127.0.0.1";
    if (args.Length >= 1) int.TryParse(args[0], out port);
    if (args.Length >= 2 && !string.IsNullOrEmpty(args[1])) host = args[1];
    if (port < 1024 || port > 65535) return 2;

    try {
      using (var client = new TcpClient()) {
        var ar = client.BeginConnect(host, port, null, null);
        if (!ar.AsyncWaitHandle.WaitOne(1500)) return 3;
        client.EndConnect(ar);
        client.NoDelay = true;

        using (var net = client.GetStream())
        using (var stdin = Console.OpenStandardInput())
        using (var stdout = Console.OpenStandardOutput()) {
          var tIn = new Thread(() => {
            try {
              byte[] buf = new byte[16384];
              int n;
              while ((n = stdin.Read(buf, 0, buf.Length)) > 0) {
                net.Write(buf, 0, n);
                net.Flush();
              }
              try { client.Client.Shutdown(SocketShutdown.Send); } catch {}
            } catch {}
          });
          tIn.IsBackground = true;
          tIn.Start();

          try {
            byte[] buf = new byte[16384];
            int n;
            while ((n = net.Read(buf, 0, buf.Length)) > 0) {
              stdout.Write(buf, 0, n);
              stdout.Flush();
            }
          } catch {}
          try { client.Close(); } catch {}
        }
      }
      return 0;
    } catch {
      return 4;
    }
  }
}
`;

export const WSL_CDP_TUNNEL_SOURCE = WSL_CDP_TUNNEL_CS;

let cachedHostEnv = null;
let cachedWinDirs = null;
let tunnelCompilePromise = null;
const winPathCache = new Map();

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export function resetWslBridgeCache() {
  cachedHostEnv = null;
  cachedWinDirs = null;
  tunnelCompilePromise = null;
  winPathCache.clear();
}

/**
 * Detect whether the current runtime is native Windows or WSL2 with Windows Interop.
 * Supports dependency injection for deterministic unit tests on any OS.
 */
export function detectWindowsHostEnv(overrides = null) {
  const useCache = !overrides;
  if (useCache && cachedHostEnv) return cachedHostEnv;

  const platform = overrides?.platform ?? process.platform;
  const env = overrides?.env ?? process.env;
  const fsExists = overrides?.fsExists ?? ((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  if (platform === 'win32') {
    const info = {
      isNativeWindows: true,
      isWsl: false,
      hasWindowsHost: true,
      interopAvailable: true,
      distroName: '',
      winMountRoot: '',
      mountBase: '',
      cscPath: NATIVE_CSC_PATH,
      wpfDirWin: NATIVE_WPF_DIR,
      wscriptPath: 'wscript.exe',
      powershellPath: 'powershell.exe',
      cmdPath: 'cmd.exe',
    };
    if (useCache) cachedHostEnv = info;
    return info;
  }

  if (platform === 'linux') {
    let procVersion = overrides?.procVersion;
    if (procVersion === undefined) {
      try {
        procVersion = fs.readFileSync('/proc/version', 'utf8');
      } catch {
        procVersion = '';
      }
    }
    const isWsl = Boolean(
      env?.WSL_DISTRO_NAME ||
      env?.WSL_INTEROP ||
      /microsoft|wsl/i.test(String(procVersion || '')),
    );
    if (!isWsl) {
      const info = {
        isNativeWindows: false,
        isWsl: false,
        hasWindowsHost: false,
        interopAvailable: false,
        distroName: '',
        winMountRoot: '',
        mountBase: '',
        cscPath: '',
        wpfDirWin: NATIVE_WPF_DIR,
        wscriptPath: '',
        powershellPath: '',
        cmdPath: '',
      };
      if (useCache) cachedHostEnv = info;
      return info;
    }

    const mountCandidates = [
      env?.AGY_MONITOR_WSL_WIN_ROOT,
      '/mnt/c',
      '/c',
    ].filter(Boolean);

    let winMountRoot = '';
    for (const cand of mountCandidates) {
      const clean = String(cand).replace(/\/+$/, '');
      if (
        fsExists(`${clean}/Windows/System32/wscript.exe`) ||
        fsExists(`${clean}/Windows/System32/cmd.exe`) ||
        fsExists(`${clean}/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe`)
      ) {
        winMountRoot = clean;
        break;
      }
    }

    const mountBase = winMountRoot
      ? winMountRoot === '/c'
        ? ''
        : path.posix.dirname(winMountRoot)
      : '/mnt';

    const cscPath = winMountRoot
      ? `${winMountRoot}/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe`
      : '';
    const wscriptPath = winMountRoot ? `${winMountRoot}/Windows/System32/wscript.exe` : '';
    const powershellPath = winMountRoot
      ? `${winMountRoot}/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`
      : '';
    const cmdPath = winMountRoot ? `${winMountRoot}/Windows/System32/cmd.exe` : '';

    const interopAvailable = Boolean(
      winMountRoot && (fsExists(wscriptPath) || fsExists(cmdPath) || fsExists(cscPath)),
    );

    const info = {
      isNativeWindows: false,
      isWsl: true,
      hasWindowsHost: interopAvailable,
      interopAvailable,
      distroName: String(env?.WSL_DISTRO_NAME || '').trim(),
      winMountRoot,
      mountBase,
      cscPath,
      wpfDirWin: NATIVE_WPF_DIR,
      wscriptPath,
      powershellPath,
      cmdPath,
    };
    if (useCache) cachedHostEnv = info;
    return info;
  }

  const info = {
    isNativeWindows: false,
    isWsl: false,
    hasWindowsHost: false,
    interopAvailable: false,
    distroName: '',
    winMountRoot: '',
    mountBase: '',
    cscPath: '',
    wpfDirWin: NATIVE_WPF_DIR,
    wscriptPath: '',
    powershellPath: '',
    cmdPath: '',
  };
  if (useCache) cachedHostEnv = info;
  return info;
}

/**
 * Convert a Windows drive path (e.g. C:\Users\foo) to its WSL mount path (/mnt/c/Users/foo).
 */
export function winPathToWslPosix(winPath, hostInfo = detectWindowsHostEnv()) {
  if (!winPath || typeof winPath !== 'string') return '';
  const trimmed = winPath.trim();
  if (!trimmed) return '';
  if (hostInfo.isNativeWindows) return trimmed;
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(trimmed);
  if (m) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, '/').replace(/^\/+/, '');
    const prefix = hostInfo.mountBase ? `${hostInfo.mountBase}/${drive}` : `/${drive}`;
    return rest ? `${prefix}/${rest}` : prefix;
  }
  return trimmed.replace(/\\/g, '/');
}

/**
 * Convert a Linux/WSL path to a Windows path suitable for Windows .exe / .vbs / .lnk tools.
 */
export async function toWindowsPath(inputPath, hostInfo = detectWindowsHostEnv(), { execImpl } = {}) {
  if (!inputPath || typeof inputPath !== 'string') return '';
  const trimmed = inputPath.trim();
  if (!trimmed) return '';
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed)) {
    return trimmed.replace(/\//g, '\\');
  }
  if (hostInfo.isNativeWindows) {
    return path.resolve(trimmed);
  }
  if (!hostInfo.isWsl) return trimmed;

  const cacheKey = `${hostInfo.distroName}|${hostInfo.mountBase}|${trimmed}`;
  if (!execImpl && winPathCache.has(cacheKey)) {
    return winPathCache.get(cacheKey);
  }

  // Fast pure-JS conversion for mounted Windows drives (/mnt/c/... or /c/...)
  const basePrefix = hostInfo.mountBase ? `${hostInfo.mountBase}/` : '/';
  if (trimmed.startsWith(basePrefix)) {
    const after = trimmed.slice(basePrefix.length);
    const m = /^([a-zA-Z])(?:\/(.*))?$/.exec(after);
    if (m) {
      const drive = m[1].toUpperCase();
      const rest = (m[2] || '').replace(/\//g, '\\');
      const win = rest ? `${drive}:\\${rest}` : `${drive}:\\`;
      if (!execImpl) winPathCache.set(cacheKey, win);
      return win;
    }
  }

  // Official WSL path conversion for ext4 paths (/home/... -> \\wsl.localhost\<distro>\home\...)
  const runner = execImpl || execFileAsync;
  try {
    const { stdout } = await runner('wslpath', ['-w', trimmed], { timeout: 3000 });
    const converted = String(stdout || '').trim();
    if (converted) {
      if (!execImpl) winPathCache.set(cacheKey, converted);
      return converted;
    }
  } catch {
    // Fallback below
  }

  if (hostInfo.distroName) {
    const rel = trimmed.replace(/^\/+/, '').replace(/\//g, '\\');
    const unc = `\\\\wsl.localhost\\${hostInfo.distroName}\\${rel}`;
    if (!execImpl) winPathCache.set(cacheKey, unc);
    return unc;
  }

  return trimmed;
}

/**
 * Resolve Windows user directories (%LOCALAPPDATA%, %ProgramFiles%) and a clean NTFS staging dir
 * for WSL2 helper binaries & shortcuts (avoiding UNC execution issues with cmd.exe / .lnk).
 */
export async function resolveWindowsHostDirs(hostInfo = detectWindowsHostEnv(), { execImpl } = {}) {
  const useCache = !execImpl;
  if (useCache && cachedWinDirs) return cachedWinDirs;

  if (hostInfo.isNativeWindows) {
    const localAppDataWin = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const programFilesWin = process.env.ProgramFiles || 'C:\\Program Files';
    const res = {
      localAppDataWin,
      localAppDataPosix: localAppDataWin,
      programFilesWin,
      programFilesPosix: programFilesWin,
      stagingDirWin: '',
      stagingDirPosix: '',
    };
    if (useCache) cachedWinDirs = res;
    return res;
  }

  if (!hostInfo.isWsl || !hostInfo.hasWindowsHost) {
    return {
      localAppDataWin: '',
      localAppDataPosix: '',
      programFilesWin: '',
      programFilesPosix: '',
      stagingDirWin: '',
      stagingDirPosix: '',
    };
  }

  let localAppDataWin = '';
  let programFilesWin = 'C:\\Program Files';
  const runner = execImpl || execFileAsync;

  if (hostInfo.cmdPath) {
    try {
      const { stdout } = await runner(
        hostInfo.cmdPath,
        ['/d', '/c', 'echo %LOCALAPPDATA%^|%ProgramFiles%'],
        { timeout: 4000 },
      );
      const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
      const [lad, pf] = line.split('|').map((s) => String(s || '').trim());
      if (lad && !lad.includes('%LOCALAPPDATA%') && /^[a-zA-Z]:\\/.test(lad)) {
        localAppDataWin = lad;
      }
      if (pf && !pf.includes('%ProgramFiles%') && /^[a-zA-Z]:\\/.test(pf)) {
        programFilesWin = pf;
      }
    } catch {
      // Fallback below
    }
  }

  if (!localAppDataWin && hostInfo.winMountRoot) {
    // Fallback: inspect /mnt/c/Users/* for a real user directory with AppData/Local
    try {
      const usersDir = `${hostInfo.winMountRoot}/Users`;
      const skip = new Set(['Public', 'Default', 'Default User', 'All Users']);
      const entries = fs.readdirSync(usersDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || skip.has(e.name)) continue;
        const cand = `${usersDir}/${e.name}/AppData/Local`;
        if (fs.existsSync(cand)) {
          localAppDataWin = `C:\\Users\\${e.name}\\AppData\\Local`;
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  const localAppDataPosix = localAppDataWin ? winPathToWslPosix(localAppDataWin, hostInfo) : '';
  const programFilesPosix = programFilesWin ? winPathToWslPosix(programFilesWin, hostInfo) : '';
  const stagingDirWin = localAppDataWin ? `${localAppDataWin}\\agy-monitor-wsl` : '';
  const stagingDirPosix = stagingDirWin ? winPathToWslPosix(stagingDirWin, hostInfo) : '';

  const res = {
    localAppDataWin,
    localAppDataPosix,
    programFilesWin,
    programFilesPosix,
    stagingDirWin,
    stagingDirPosix,
  };
  if (useCache) cachedWinDirs = res;
  return res;
}

/**
 * Resolve Windows host IP seen from WSL2 NAT mode (fallback when Interop tunnel is unavailable).
 */
export function resolveWslGatewayIp({ procNetRoute, resolvConf } = {}) {
  // 1. Prefer Linux kernel default gateway from /proc/net/route (works even with custom DNS)
  try {
    const routeTxt =
      procNetRoute !== undefined ? procNetRoute : fs.readFileSync('/proc/net/route', 'utf8');
    const lines = String(routeTxt || '').trim().split(/\r?\n/).slice(1);
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 3 && cols[1] === '00000000' && /^[0-9a-fA-F]{8}$/.test(cols[2])) {
        const hex = cols[2];
        const b1 = parseInt(hex.slice(6, 8), 16);
        const b2 = parseInt(hex.slice(4, 6), 16);
        const b3 = parseInt(hex.slice(2, 4), 16);
        const b4 = parseInt(hex.slice(0, 2), 16);
        if (b1 > 0 && !(b1 === 127 && b2 === 0 && b3 === 0 && b4 === 1)) {
          return `${b1}.${b2}.${b3}.${b4}`;
        }
      }
    }
  } catch {
    // Fallback to /etc/resolv.conf
  }

  try {
    const resolvTxt =
      resolvConf !== undefined ? resolvConf : fs.readFileSync('/etc/resolv.conf', 'utf8');
    const m = /^\s*nameserver\s+(\d{1,3}(?:\.\d{1,3}){3})\b/m.exec(String(resolvTxt || ''));
    if (m && m[1] && !m[1].startsWith('127.')) {
      return m[1];
    }
  } catch {
    // ignore
  }
  return '';
}

/**
 * Compile the lightweight Windows-side TCP loopback tunnel (agy_wsl_cdp_tunnel.exe)
 * so WSL2 NAT mode can reach Windows 127.0.0.1:<cdpPort> with zero admin rights & zero firewall rules.
 */
export async function ensureWslCdpTunnelBinary(hostInfo = detectWindowsHostEnv()) {
  if (!hostInfo.hasWindowsHost || !hostInfo.cscPath) {
    return { ok: false, exePosix: '', exeWin: '', reason: 'Windows csc.exe unavailable' };
  }
  if (!fs.existsSync(hostInfo.cscPath)) {
    return { ok: false, exePosix: '', exeWin: '', reason: 'csc.exe missing' };
  }

  const doCompile = async () => {
    const dirs = await resolveWindowsHostDirs(hostInfo);
    const binDirPosix = hostInfo.isNativeWindows
      ? path.join(dirs.localAppDataPosix, 'agy-monitor-wsl', 'bin')
      : dirs.stagingDirPosix
        ? `${dirs.stagingDirPosix}/bin`
        : '';
    const binDirWin = hostInfo.isNativeWindows
      ? path.join(dirs.localAppDataWin, 'agy-monitor-wsl', 'bin')
      : dirs.stagingDirWin
        ? `${dirs.stagingDirWin}\\bin`
        : '';

    if (!binDirPosix || !binDirWin) {
      return { ok: false, exePosix: '', exeWin: '', reason: 'Windows staging dir unavailable' };
    }

    const srcHash = crypto.createHash('sha1').update(WSL_CDP_TUNNEL_CS).digest('hex');
    const exePosix = hostInfo.isNativeWindows
      ? path.join(binDirPosix, 'agy_wsl_cdp_tunnel.exe')
      : `${binDirPosix}/agy_wsl_cdp_tunnel.exe`;
    const exeWin = `${binDirWin}\\agy_wsl_cdp_tunnel.exe`;
    const hashPosix = hostInfo.isNativeWindows
      ? path.join(binDirPosix, 'agy_wsl_cdp_tunnel.sha1')
      : `${binDirPosix}/agy_wsl_cdp_tunnel.sha1`;
    const srcPosix = hostInfo.isNativeWindows
      ? path.join(binDirPosix, 'AgyWslCdpTunnel.cs')
      : `${binDirPosix}/AgyWslCdpTunnel.cs`;
    const srcWin = `${binDirWin}\\AgyWslCdpTunnel.cs`;

    let prevHash = '';
    try {
      prevHash = (await fsp.readFile(hashPosix, 'utf8')).trim();
    } catch {
      prevHash = '';
    }

    if (fs.existsSync(exePosix) && prevHash === srcHash) {
      return { ok: true, exePosix, exeWin, compiledNow: false };
    }

    await fsp.mkdir(binDirPosix, { recursive: true });
    await fsp.writeFile(srcPosix, WSL_CDP_TUNNEL_CS, 'utf8');
    const tmpExePosix = `${exePosix}.tmp.${process.pid}.exe`;
    const tmpExeWin = `${exeWin}.tmp.${process.pid}.exe`;

    try {
      await execFileAsync(
        hostInfo.cscPath,
        ['/nologo', '/target:exe', '/optimize+', `/out:${tmpExeWin}`, srcWin],
        { timeout: 15000 },
      );
      await fsp.rename(tmpExePosix, exePosix);
      await fsp.writeFile(hashPosix, `${srcHash}\n`, 'utf8');
      return { ok: true, exePosix, exeWin, compiledNow: true };
    } catch (err) {
      await fsp.rm(tmpExePosix, { force: true }).catch(() => {});
      return {
        ok: false,
        exePosix: '',
        exeWin: '',
        reason: err?.stderr || err?.stdout || err?.message || 'tunnel compile failed',
      };
    }
  };

  if (!tunnelCompilePromise) {
    tunnelCompilePromise = doCompile().finally(() => {
      tunnelCompilePromise = null;
    });
  }
  return tunnelCompilePromise;
}

/**
 * Start a local loopback TCP proxy inside WSL2 that pipes each TCP socket directly
 * into a Windows-side agy_wsl_cdp_tunnel.exe connecting to Windows 127.0.0.1:<targetPort>.
 * Supports both HTTP (/json/list) and full-duplex WebSocket CDP sessions cleanly.
 */
export async function createWslCdpLocalProxy(targetPort, { tunnelExePosix, hostInfo = detectWindowsHostEnv() } = {}) {
  const port = Math.min(65535, Math.max(1024, Math.round(Number(targetPort) || 9229)));
  let exePath = tunnelExePosix || '';
  if (!exePath) {
    const compiled = await ensureWslCdpTunnelBinary(hostInfo);
    if (!compiled.ok || !compiled.exePosix) {
      return null;
    }
    exePath = compiled.exePosix;
  }

  const activeChildren = new Set();
  const activeSockets = new Set();
  let closed = false;

  const server = net.createServer((socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    activeSockets.add(socket);

    const child = spawn(exePath, [String(port), '127.0.0.1'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    activeChildren.add(child);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      activeSockets.delete(socket);
      activeChildren.delete(child);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      try {
        if (!child.killed && child.exitCode === null) {
          child.kill();
        }
      } catch {
        // ignore
      }
    };

    socket.on('error', cleanup);
    socket.on('close', cleanup);
    child.on('error', cleanup);
    child.on('exit', () => {
      try {
        socket.end();
      } catch {
        // ignore
      }
      const t = setTimeout(cleanup, 25);
      if (typeof t.unref === 'function') t.unref();
    });

    if (child.stdin && child.stdout) {
      child.stdin.on('error', () => {});
      child.stdout.on('error', () => {});
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
    } else {
      cleanup();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const localPort = typeof addr === 'object' && addr ? addr.port : 0;
  if (typeof server.unref === 'function') {
    server.unref();
  }

  return {
    localPort,
    targetPort: port,
    close() {
      if (closed) return;
      closed = true;
      for (const s of activeSockets) {
        try {
          s.destroy();
        } catch {
          // ignore
        }
      }
      activeSockets.clear();
      for (const c of activeChildren) {
        try {
          c.kill();
        } catch {
          // ignore
        }
      }
      activeChildren.clear();
      try {
        server.close();
      } catch {
        // ignore
      }
    },
  };
}
