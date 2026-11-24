/**
 * Whole-Antigravity Memory Telemetry, Diagnostics & Safe Reclaim Engine.
 *
 * - On Windows (and WSL2 via Interop): queries real per-process Private Working Set,
 *   Private Committed bytes, parent-child topology, and `uiautomationcore.dll` module
 *   presence via native `agy_backdrop.exe --memory-snapshot` (~250ms, zero PowerShell).
 * - One-click & auto-guard safe memory trim:
 *   1. Releases plugin internal caches, Node GC (if exposed), and SQLite `PRAGMA shrink_memory`.
 *   2. Signals running C# companions (`agy_backdrop` & `agy_desktop_pet`) to run Gen-2 GC +
 *      Finalizers + Working Set trim.
 *   3. Calls Win32 `EmptyWorkingSet` safely across Antigravity host, language server,
 *      plugin companions, and child extension processes (never kills processes or drops data).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  controlBackdropCompanion,
  ensureBackdropAssets,
  getBackdropStatus,
  resolveBackdropRuntimePaths,
} from './backdrop_manager.mjs';
import { detectWindowsHostEnv } from './wsl_bridge.mjs';

const SNAPSHOT_TTL_MS = 2500;
const CONV_DB_SCAN_TTL_MS = 15_000;
const AUTO_GUARD_TICK_MS = 60_000;

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
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

function round1(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 10) / 10;
}

function isHostProcessName(name) {
  const low = String(name || '').toLowerCase();
  return low === 'antigravity' || low === 'antigravity_original';
}

function isCompanionProcessName(name) {
  const low = String(name || '').toLowerCase();
  return low === 'agy_backdrop' || low === 'agy_desktop_pet' || low === 'agy_account_tool';
}

function isLanguageServerName(name) {
  return String(name || '').toLowerCase().startsWith('language_server');
}

function buildFallbackSelfSnapshot(extraPids = []) {
  const mem = process.memoryUsage();
  const rssMb = round1((mem.rss || 0) / (1024 * 1024));
  const totalMb = Math.round((os.totalmem?.() || 0) / (1024 * 1024));
  const availMb = Math.round((os.freemem?.() || 0) / (1024 * 1024));
  const loadPct = totalMb > 0 ? Math.max(0, Math.min(100, Math.round(((totalMb - availMb) / totalMb) * 100))) : 0;
  return {
    ok: true,
    ts: Date.now(),
    supportedScope: 'self-only',
    system: { totalMb, availableMb: availMb, loadPct },
    totalPrivateWsMb: rssMb,
    totalWorkingSetMb: rssMb,
    totalPrivateCommitMb: rssMb,
    processCount: 1,
    processes: [
      {
        pid: process.pid,
        ppid: process.ppid || 0,
        name: 'node',
        hasMainWindow: false,
        uiaLoaded: false,
        privateWsMb: rssMb,
        workingSetMb: rssMb,
        privateCommitMb: rssMb,
        uptimeSec: Math.round(process.uptime?.() || 0),
        isPluginSelf: true,
        extraPidsCount: extraPids.length,
      },
    ],
  };
}

/**
 * Classify raw process metrics into logical Antigravity memory buckets.
 */
export function classifyMemorySnapshot(rawSnap, { extraPidSet = new Set(), largestConvDb = null, zeroUiaMode = true } = {}) {
  const processes = Array.isArray(rawSnap?.processes) ? rawSnap.processes : [];
  const hostPidSet = new Set();
  const parentOfAgySet = new Set();
  for (const p of processes) {
    if (!p) continue;
    const pid = Number(p.pid);
    const ppid = Number(p.ppid);
    if (isHostProcessName(p.name) && Number.isInteger(pid) && pid > 0) {
      hostPidSet.add(pid);
    }
    if (Number.isInteger(ppid) && ppid > 0 && (isHostProcessName(p.name) || isLanguageServerName(p.name))) {
      parentOfAgySet.add(ppid);
    }
  }
  const hasRealMainParent = [...hostPidSet].some((pid) => parentOfAgySet.has(pid));

  const groups = {
    hostMain: { key: 'hostMain', privateWsMb: 0, privateCommitMb: 0, count: 0, pids: [], uiaLoaded: false },
    hostRenderers: { key: 'hostRenderers', privateWsMb: 0, privateCommitMb: 0, count: 0, pids: [] },
    languageServer: { key: 'languageServer', privateWsMb: 0, privateCommitMb: 0, count: 0, pids: [] },
    pluginSelf: { key: 'pluginSelf', privateWsMb: 0, privateCommitMb: 0, count: 0, pids: [], companions: [] },
    otherExtensions: { key: 'otherExtensions', privateWsMb: 0, privateCommitMb: 0, count: 0, pids: [] },
  };

  let totalPrivateWsMb = 0;
  let totalWorkingSetMb = 0;
  let totalPrivateCommitMb = 0;
  let mainUiaLoaded = false;
  let bloatedCompanion = null;

  const normalizedProcs = [];

  for (const p of processes) {
    if (!p || typeof p !== 'object') continue;
    const pid = Number(p.pid) || 0;
    const ppid = Number(p.ppid) || 0;
    const name = String(p.name || 'unknown');
    const privWs = round1(p.privateWsMb);
    const ws = round1(p.workingSetMb || privWs);
    const commit = round1(p.privateCommitMb);
    const uiaLoaded = Boolean(p.uiaLoaded);
    const hasMainWindow = Boolean(p.hasMainWindow);
    const uptimeSec = Math.max(0, Math.round(Number(p.uptimeSec) || 0));

    totalPrivateWsMb += privWs;
    totalWorkingSetMb += ws;
    totalPrivateCommitMb += commit;

    let groupKey = 'otherExtensions';
    if (isCompanionProcessName(name) || extraPidSet.has(pid) || p.isPluginSelf) {
      groupKey = 'pluginSelf';
      if (isCompanionProcessName(name)) {
        groups.pluginSelf.companions.push({
          pid,
          name,
          privateWsMb: privWs,
          privateCommitMb: commit,
          uptimeSec,
        });
        if ((privWs >= 120 || commit >= 250) && (!bloatedCompanion || privWs > bloatedCompanion.privateWsMb)) {
          bloatedCompanion = { pid, name, privateWsMb: privWs, privateCommitMb: commit, uptimeSec };
        }
      }
    } else if (isLanguageServerName(name)) {
      groupKey = 'languageServer';
    } else if (isHostProcessName(name)) {
      const isRootHost =
        hasMainWindow ||
        parentOfAgySet.has(pid) ||
        (!hasRealMainParent && !hostPidSet.has(ppid) && (privWs >= 20 || commit >= 30 || groups.hostMain.count === 0));
      if (isRootHost) {
        groupKey = 'hostMain';
        if (uiaLoaded) {
          groups.hostMain.uiaLoaded = true;
          mainUiaLoaded = true;
        }
      } else {
        groupKey = 'hostRenderers';
        if (uiaLoaded) {
          mainUiaLoaded = true;
        }
      }
    } else {
      groupKey = 'otherExtensions';
    }

    const bucket = groups[groupKey];
    bucket.privateWsMb = round1(bucket.privateWsMb + privWs);
    bucket.privateCommitMb = round1(bucket.privateCommitMb + commit);
    bucket.count += 1;
    bucket.pids.push(pid);

    normalizedProcs.push({
      pid,
      ppid,
      name,
      group: groupKey,
      hasMainWindow,
      uiaLoaded,
      privateWsMb: privWs,
      workingSetMb: ws,
      privateCommitMb: commit,
      uptimeSec,
    });
  }

  totalPrivateWsMb = round1(totalPrivateWsMb);
  totalWorkingSetMb = round1(totalWorkingSetMb);
  totalPrivateCommitMb = round1(totalPrivateCommitMb);

  const system = {
    totalMb: Math.round(Number(rawSnap?.system?.totalMb) || 0),
    availableMb: Math.round(Number(rawSnap?.system?.availableMb) || 0),
    loadPct: Math.max(0, Math.min(100, Math.round(Number(rawSnap?.system?.loadPct) || 0))),
  };

  let level = 'healthy';
  if (totalPrivateWsMb >= 2000 || system.loadPct >= 90) {
    level = 'high';
  } else if (totalPrivateWsMb >= 1200 || system.loadPct >= 80) {
    level = 'elevated';
  }

  const diagnostics = [];
  if (mainUiaLoaded) {
    diagnostics.push({
      id: 'uia_axtree_loaded',
      level: 'warn',
      code: zeroUiaMode ? 'uia_active_restart_hint' : 'uia_active_enable_zero_uia',
      data: {
        mainMb: groups.hostMain.privateWsMb,
        mainCommitMb: groups.hostMain.privateCommitMb,
        zeroUiaMode: Boolean(zeroUiaMode),
      },
    });
  }
  if (bloatedCompanion) {
    diagnostics.push({
      id: 'companion_bloat',
      level: 'warn',
      code: 'companion_bloat',
      action: 'restart_companions',
      data: {
        name: bloatedCompanion.name,
        privateWsMb: bloatedCompanion.privateWsMb,
        privateCommitMb: bloatedCompanion.privateCommitMb,
        uptimeHours: Math.round((bloatedCompanion.uptimeSec / 3600) * 10) / 10,
      },
    });
  }
  if (largestConvDb && largestConvDb.sizeMb >= 80) {
    diagnostics.push({
      id: 'large_conv_db',
      level: 'info',
      code: 'large_conv_db',
      data: {
        convId: largestConvDb.convId,
        sizeMb: largestConvDb.sizeMb,
      },
    });
  }
  if (groups.hostRenderers.count >= 8) {
    diagnostics.push({
      id: 'many_renderers',
      level: 'info',
      code: 'many_renderers',
      data: {
        count: groups.hostRenderers.count,
        privateWsMb: groups.hostRenderers.privateWsMb,
      },
    });
  }
  if (system.loadPct >= 88 && system.totalMb > 0) {
    diagnostics.push({
      id: 'high_system_pressure',
      level: 'danger',
      code: 'high_system_pressure',
      action: 'optimize_now',
      data: {
        loadPct: system.loadPct,
        availableMb: system.availableMb,
        totalMb: system.totalMb,
      },
    });
  }

  const topProcesses = normalizedProcs
    .slice()
    .sort((a, b) => b.privateWsMb - a.privateWsMb)
    .slice(0, 8);

  return {
    ok: true,
    ts: Number(rawSnap?.ts) || Date.now(),
    supported: rawSnap?.supportedScope !== 'self-only',
    supportedScope: rawSnap?.supportedScope || 'full-windows',
    level,
    system,
    summary: {
      totalPrivateWsMb,
      totalWorkingSetMb,
      totalPrivateCommitMb,
      processCount: normalizedProcs.length,
    },
    groups,
    topProcesses,
    largestConvDb,
    diagnostics,
  };
}

async function scanLargestConversationDb(conversationsDir) {
  if (!conversationsDir) return null;
  let entries;
  try {
    entries = await fsp.readdir(conversationsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.db')) continue;
    const fp = path.join(conversationsDir, ent.name);
    try {
      const st = await fsp.stat(fp);
      if (!best || st.size > best.sizeBytes) {
        best = {
          convId: ent.name.slice(0, -3),
          sizeBytes: st.size,
          sizeMb: round1(st.size / (1024 * 1024)),
        };
      }
    } catch {
      // Ignore transient locked/removed files
    }
  }
  return best;
}

/**
 * Create whole-AGY memory monitor & safe optimizer service.
 */
export function createMemoryManager({
  paths,
  storage,
  getExtraPids = null,
  onShrinkInternal = null,
  onRestartCompanions = null,
  driver = null,
} = {}) {
  let cachedStatus = null;
  let cachedAtMs = 0;
  let snapshotInFlight = null;
  let optimizeInFlight = null;
  let cachedConvDb = null;
  let cachedConvDbAtMs = 0;
  let lastOptimize = null;
  let autoGuardTimer = null;
  let autoGuardCount = 0;
  let lastAutoTrimAtMs = 0;

  const collectExtraPids = () => {
    const pids = new Set([process.pid]);
    try {
      const extra = typeof getExtraPids === 'function' ? getExtraPids() : [];
      if (Array.isArray(extra)) {
        for (const p of extra) {
          const n = Number(p);
          if (Number.isInteger(n) && n > 0) pids.add(n);
        }
      }
    } catch {
      // Ignore extra pid callback error
    }
    return pids;
  };

  async function resolveHelperExe() {
    const hostInfo = detectWindowsHostEnv();
    if (!hostInfo.hasWindowsHost) return null;
    const rt = await resolveBackdropRuntimePaths(paths, hostInfo);
    if (rt?.exePosix && fs.existsSync(rt.exePosix)) {
      return rt.exePosix;
    }
    const ensured = await ensureBackdropAssets(paths).catch(() => null);
    if (ensured?.compiled && ensured.exePosixPath && fs.existsSync(ensured.exePosixPath)) {
      return ensured.exePosixPath;
    }
    return null;
  }

  async function invokeNativeSnapshot(extraPidSet) {
    if (driver && typeof driver.captureSnapshot === 'function') {
      return driver.captureSnapshot([...extraPidSet]);
    }
    const exePath = await resolveHelperExe();
    if (!exePath) {
      return buildFallbackSelfSnapshot([...extraPidSet]);
    }
    try {
      const args = ['--memory-snapshot'];
      if (extraPidSet.size > 0) {
        args.push('--extra-pids', [...extraPidSet].join(','));
      }
      const { stdout } = await execFileAsync(exePath, args, { timeout: 8000 });
      const parsed = JSON.parse(String(stdout || '').trim());
      if (parsed && parsed.ok) {
        return { ...parsed, supportedScope: 'full-windows' };
      }
    } catch {
      // Fall back to self-only snapshot when companion binary is busy/outdated
    }
    return buildFallbackSelfSnapshot([...extraPidSet]);
  }

  async function invokeNativeTrim(extraPidSet) {
    if (driver && typeof driver.trimMemory === 'function') {
      return driver.trimMemory([...extraPidSet]);
    }
    const exePath = await resolveHelperExe();
    if (!exePath) {
      const snap = buildFallbackSelfSnapshot([...extraPidSet]);
      return {
        ok: true,
        trimmedCount: 1,
        failedCount: 0,
        beforeTotalPrivateWsMb: snap.totalPrivateWsMb,
        afterTotalPrivateWsMb: snap.totalPrivateWsMb,
        freedMb: 0,
        snapshot: snap,
      };
    }
    const args = ['--trim-memory'];
    if (extraPidSet.size > 0) {
      args.push('--extra-pids', [...extraPidSet].join(','));
    }
    const { stdout } = await execFileAsync(exePath, args, { timeout: 12000 });
    const parsed = JSON.parse(String(stdout || '').trim());
    if (!parsed || !parsed.ok) {
      throw new Error('内存释放工具返回异常结果');
    }
    if (parsed.snapshot) {
      parsed.snapshot.supportedScope = 'full-windows';
    }
    return parsed;
  }

  async function getLargestConvDbCached() {
    const now = Date.now();
    if (cachedConvDbAtMs > 0 && now - cachedConvDbAtMs < CONV_DB_SCAN_TTL_MS) {
      return cachedConvDb;
    }
    cachedConvDb = await scanLargestConversationDb(paths?.conversationsDir);
    cachedConvDbAtMs = now;
    return cachedConvDb;
  }

  async function buildEnrichedStatus(rawSnap) {
    const [prefs, themes, largestConvDb] = await Promise.all([
      storage?.getPrefs?.().catch(() => ({})) || Promise.resolve({}),
      storage?.getThemes?.().catch(() => ({})) || Promise.resolve({}),
      getLargestConvDbCached(),
    ]);
    const zeroUiaMode = Boolean(themes?.zeroUiaMode);
    const memoryGuard = prefs?.memoryGuard || {
      autoTrimEnabled: true,
      thresholdMb: 1800,
      intervalMin: 10,
    };
    const extraPidSet = collectExtraPids();
    const classified = classifyMemorySnapshot(rawSnap, {
      extraPidSet,
      largestConvDb,
      zeroUiaMode,
    });
    return {
      ...classified,
      settings: {
        zeroUiaMode,
        memoryGuard,
      },
      lastOptimize,
      autoGuardStats: {
        enabled: Boolean(memoryGuard.autoTrimEnabled),
        autoRunCount: autoGuardCount,
        lastAutoTrimAtMs,
      },
    };
  }

  async function getStatus({ force = false } = {}) {
    const now = Date.now();
    if (!force && cachedStatus && now - cachedAtMs < SNAPSHOT_TTL_MS) {
      return cachedStatus;
    }
    if (snapshotInFlight && !force) {
      return snapshotInFlight;
    }
    const work = (async () => {
      const extraPidSet = collectExtraPids();
      const rawSnap = await invokeNativeSnapshot(extraPidSet);
      const status = await buildEnrichedStatus(rawSnap);
      cachedStatus = status;
      cachedAtMs = Date.now();
      return status;
    })();
    const wrapped = work.finally(() => {
      if (snapshotInFlight === wrapped) snapshotInFlight = null;
    });
    snapshotInFlight = wrapped;
    return wrapped;
  }

  async function optimizeNow({ reason = 'manual' } = {}) {
    if (optimizeInFlight) return optimizeInFlight;
    const run = (async () => {
      try {
        await Promise.resolve(onShrinkInternal?.()).catch(() => {});
        if (typeof global.gc === 'function') {
          try {
            global.gc();
          } catch {
            // Ignore GC error
          }
        }
        const extraPidSet = collectExtraPids();
        const trimRes = await invokeNativeTrim(extraPidSet);
        const now = Date.now();
        const record = {
          atMs: now,
          reason,
          beforeMb: round1(trimRes.beforeTotalPrivateWsMb),
          afterMb: round1(trimRes.afterTotalPrivateWsMb),
          freedMb: round1(trimRes.freedMb),
          trimmedCount: Math.max(0, Math.round(Number(trimRes.trimmedCount) || 0)),
          failedCount: Math.max(0, Math.round(Number(trimRes.failedCount) || 0)),
        };
        lastOptimize = record;
        if (reason === 'auto') {
          autoGuardCount += 1;
          lastAutoTrimAtMs = now;
        }
        const rawAfter = trimRes.snapshot || (await invokeNativeSnapshot(extraPidSet));
        const status = await buildEnrichedStatus(rawAfter);
        cachedStatus = status;
        cachedAtMs = Date.now();
        return { ok: true, optimize: record, status };
      } catch (err) {
        return {
          ok: false,
          error: err?.message || '内存释放失败',
        };
      }
    })();
    const wrapped = run.finally(() => {
      if (optimizeInFlight === wrapped) optimizeInFlight = null;
    });
    optimizeInFlight = wrapped;
    return wrapped;
  }

  async function restartCompanions() {
    if (typeof onRestartCompanions === 'function') {
      await onRestartCompanions();
    } else if (driver && typeof driver.restartCompanions === 'function') {
      await driver.restartCompanions();
    } else {
      const hostInfo = detectWindowsHostEnv();
      if (hostInfo.hasWindowsHost) {
        const themes = (await storage?.getThemes?.().catch(() => ({}))) || {};
        // Ensure latest Zero-UIA binary is compiled before restarting
        await ensureBackdropAssets(paths).catch(() => {});
        await controlBackdropCompanion(paths, themes, 'stop').catch(() => {});
        const wantBackdrop = Boolean(
          (themes.backdropEnabled && themes.activeWallpaperId) || themes.hudEnabled !== false,
        );
        if (wantBackdrop) {
          const st = await getBackdropStatus(paths, themes).catch(() => null);
          if (st?.canAutoLaunch) {
            await controlBackdropCompanion(paths, themes, 'start').catch(() => {});
          }
        }
        // Best-effort restart Desktop Pet companion if installed and enabled
        try {
          const petStorageMod = await import('../extensions/desktop_pet/pet_storage.mjs');
          const petCompMod = await import('../extensions/desktop_pet/pet_companion.mjs');
          const petPaths = petStorageMod.resolvePetPaths(paths);
          const petCfg = await petStorageMod.readPetConfig(petPaths);
          const petSt = await petCompMod.getPetCompanionStatus(petPaths, petCfg);
          if (petSt.running || (petCfg.enabled && petCfg.displayMode !== 'panel')) {
            await petCompMod.syncPetCompanion(petPaths, petCfg, 'stop').catch(() => {});
            if (petCfg.enabled && petCfg.displayMode !== 'panel') {
              await petCompMod.syncPetCompanion(petPaths, petCfg, 'start').catch(() => {});
            }
          }
        } catch {
          // Desktop pet extension absent or disabled
        }
      }
    }
    await new Promise((r) => setTimeout(r, 450));
    const status = await getStatus({ force: true });
    return { ok: true, status };
  }

  async function updateSettings(patch = {}) {
    if (!patch || typeof patch !== 'object') {
      return { ok: false, error: '无效的内存设置参数' };
    }
    if (typeof patch.zeroUiaMode === 'boolean' && storage?.saveThemes) {
      await storage.saveThemes({ zeroUiaMode: patch.zeroUiaMode });
    }
    const guardPatch = {};
    if (typeof patch.autoTrimEnabled === 'boolean') {
      guardPatch.autoTrimEnabled = patch.autoTrimEnabled;
    }
    if (patch.thresholdMb !== undefined) {
      const n = Number(patch.thresholdMb);
      if (Number.isFinite(n)) guardPatch.thresholdMb = Math.max(800, Math.min(16384, Math.round(n)));
    }
    if (patch.intervalMin !== undefined) {
      const n = Number(patch.intervalMin);
      if (Number.isFinite(n)) guardPatch.intervalMin = Math.max(5, Math.min(180, Math.round(n)));
    }
    if (Object.keys(guardPatch).length > 0 && storage?.updatePrefs) {
      await storage.updatePrefs({ memoryGuard: guardPatch });
    }
    const status = await getStatus({ force: true });
    return { ok: true, settings: status.settings, status };
  }

  async function runAutoGuardTick() {
    try {
      const prefs = (await storage?.getPrefs?.().catch(() => null)) || {};
      const guard = prefs.memoryGuard;
      if (!guard || !guard.autoTrimEnabled) return { triggered: false, reason: 'disabled' };
      const cooldownMs = Math.max(5, Number(guard.intervalMin) || 10) * 60_000;
      const now = Date.now();
      if (lastAutoTrimAtMs > 0 && now - lastAutoTrimAtMs < cooldownMs) {
        return { triggered: false, reason: 'cooldown' };
      }
      if (lastOptimize && now - lastOptimize.atMs < Math.min(cooldownMs, 3 * 60_000)) {
        return { triggered: false, reason: 'recent_manual_trim' };
      }
      const status = await getStatus({ force: true });
      const thresholdMb = Math.max(800, Number(guard.thresholdMb) || 1800);
      if (status.summary.totalPrivateWsMb >= thresholdMb) {
        const res = await optimizeNow({ reason: 'auto' });
        return { triggered: true, result: res };
      }
      return { triggered: false, reason: 'below_threshold', currentMb: status.summary.totalPrivateWsMb };
    } catch {
      return { triggered: false, reason: 'error' };
    }
  }

  function startAutoGuard({ tickMs = AUTO_GUARD_TICK_MS } = {}) {
    if (autoGuardTimer) return;
    const interval = Math.max(10_000, Number(tickMs) || AUTO_GUARD_TICK_MS);
    autoGuardTimer = setInterval(() => {
      void runAutoGuardTick();
    }, interval);
    autoGuardTimer.unref?.();
  }

  function stopAutoGuard() {
    if (autoGuardTimer) {
      clearInterval(autoGuardTimer);
      autoGuardTimer = null;
    }
  }

  return {
    getStatus,
    optimizeNow,
    restartCompanions,
    updateSettings,
    runAutoGuardTick,
    startAutoGuard,
    stopAutoGuard,
  };
}
