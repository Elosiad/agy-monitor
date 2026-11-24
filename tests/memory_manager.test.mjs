import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import {
  classifyMemorySnapshot,
  createMemoryManager,
} from '../sidecars/agy_monitor/backend/memory_manager.mjs';
import { createMonitorHandlers } from '../sidecars/agy_monitor/main.mjs';

async function makeTempEnv() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-mem-test-'));
  const pluginDataDir = path.join(tmpDir, 'plugin_data');
  const conversationsDir = path.join(tmpDir, 'conversations');
  await fs.mkdir(pluginDataDir, { recursive: true });
  await fs.mkdir(conversationsDir, { recursive: true });
  const paths = resolvePaths({
    pluginDataDir,
    conversationsDir,
    brainDir: path.join(tmpDir, 'brain'),
  });
  const storage = createStorage(paths);
  return {
    tmpDir,
    paths,
    storage,
    async cleanup() {
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

test('classifyMemorySnapshot groups host main, renderers, language_server, pluginSelf, and diagnostics accurately', () => {
  const rawSnap = {
    ok: true,
    ts: 1795525000000,
    supportedScope: 'full-windows',
    system: { totalMb: 16177, availableMb: 620, loadPct: 96 },
    processes: [
      {
        pid: 37280,
        ppid: 48608,
        name: 'Antigravity',
        hasMainWindow: false,
        uiaLoaded: true,
        privateWsMb: 1795.3,
        workingSetMb: 1931.4,
        privateCommitMb: 3421.6,
        uptimeSec: 25441,
      },
      {
        pid: 48936,
        ppid: 37280,
        name: 'Antigravity',
        hasMainWindow: false,
        uiaLoaded: false,
        privateWsMb: 494.0,
        workingSetMb: 567.1,
        privateCommitMb: 590.1,
        uptimeSec: 25440,
      },
      {
        pid: 18036,
        ppid: 37280,
        name: 'Antigravity',
        hasMainWindow: false,
        uiaLoaded: false,
        privateWsMb: 237.9,
        workingSetMb: 286.5,
        privateCommitMb: 682.4,
        uptimeSec: 25441,
      },
      {
        pid: 12304,
        ppid: 37280,
        name: 'language_server',
        hasMainWindow: false,
        uiaLoaded: false,
        privateWsMb: 771.0,
        workingSetMb: 827.5,
        privateCommitMb: 927.7,
        uptimeSec: 25441,
      },
      {
        pid: 13408,
        ppid: 42784,
        name: 'agy_backdrop',
        hasMainWindow: false,
        uiaLoaded: false,
        privateWsMb: 370.2,
        workingSetMb: 398.0,
        privateCommitMb: 945.2,
        uptimeSec: 42489,
      },
      {
        pid: 9001,
        ppid: 37280,
        name: 'node',
        hasMainWindow: false,
        uiaLoaded: false,
        privateWsMb: 45.5,
        workingSetMb: 62.0,
        privateCommitMb: 54.0,
        uptimeSec: 3600,
      },
      {
        pid: 9002,
        ppid: 37280,
        name: 'node',
        hasMainWindow: false,
        uiaLoaded: false,
        privateWsMb: 60.0,
        workingSetMb: 70.0,
        privateCommitMb: 75.0,
        uptimeSec: 3600,
      },
    ],
  };

  const result = classifyMemorySnapshot(rawSnap, {
    extraPidSet: new Set([9001]),
    largestConvDb: { convId: 'conv-huge', sizeBytes: 150 * 1024 * 1024, sizeMb: 150.0 },
    zeroUiaMode: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.level, 'high');
  assert.equal(result.groups.hostMain.count, 1);
  assert.equal(result.groups.hostMain.privateWsMb, 1795.3);
  assert.equal(result.groups.hostMain.uiaLoaded, true);
  assert.equal(result.groups.hostRenderers.count, 2);
  assert.equal(result.groups.hostRenderers.privateWsMb, 731.9);
  assert.equal(result.groups.languageServer.count, 1);
  assert.equal(result.groups.languageServer.privateWsMb, 771);
  assert.equal(result.groups.pluginSelf.count, 2);
  assert.equal(result.groups.pluginSelf.privateWsMb, 415.7);
  assert.equal(result.groups.otherExtensions.count, 1);
  assert.equal(result.groups.otherExtensions.privateWsMb, 60);
  assert.equal(result.topProcesses[0].pid, 37280);

  const diagIds = new Set(result.diagnostics.map((d) => d.id));
  assert.ok(diagIds.has('uia_axtree_loaded'));
  assert.ok(diagIds.has('companion_bloat'));
  assert.ok(diagIds.has('large_conv_db'));
  assert.ok(diagIds.has('high_system_pressure'));
  const uiaDiag = result.diagnostics.find((d) => d.id === 'uia_axtree_loaded');
  assert.equal(uiaDiag.code, 'uia_active_restart_hint');
});

test('memory HTTP routes persist zeroUiaMode/memoryGuard settings, trim memory, and run auto-guard safely', async () => {
  const env = await makeTempEnv();
  try {
    let currentMainMb = 2100;
    let trimCalls = 0;
    let restartCalls = 0;
    let shrinkCalls = 0;

    const mockDriver = {
      async captureSnapshot() {
        return {
          ok: true,
          ts: Date.now(),
          supportedScope: 'full-windows',
          system: { totalMb: 16384, availableMb: 2048, loadPct: 87 },
          processes: [
            {
              pid: 1001,
              ppid: 1,
              name: 'Antigravity',
              hasMainWindow: true,
              uiaLoaded: false,
              privateWsMb: currentMainMb,
              workingSetMb: currentMainMb + 80,
              privateCommitMb: currentMainMb + 400,
              uptimeSec: 1200,
            },
            {
              pid: 1002,
              ppid: 1001,
              name: 'agy_backdrop',
              hasMainWindow: false,
              uiaLoaded: false,
              privateWsMb: 38.5,
              workingSetMb: 52.0,
              privateCommitMb: 44.0,
              uptimeSec: 1200,
            },
          ],
        };
      },
      async trimMemory() {
        trimCalls += 1;
        const before = currentMainMb + 38.5;
        currentMainMb = 920;
        const after = currentMainMb + 38.5;
        return {
          ok: true,
          trimmedCount: 2,
          failedCount: 0,
          beforeTotalPrivateWsMb: before,
          afterTotalPrivateWsMb: after,
          freedMb: Math.round((before - after) * 10) / 10,
          snapshot: await mockDriver.captureSnapshot(),
        };
      },
      async restartCompanions() {
        restartCalls += 1;
      },
    };

    const manager = createMemoryManager({
      paths: env.paths,
      storage: env.storage,
      onShrinkInternal: () => {
        shrinkCalls += 1;
      },
      driver: mockDriver,
    });

    const routes = createMonitorHandlers({
      paths: env.paths,
      storage: env.storage,
      memoryManager: manager,
    });

    // 1. Default status & defaults persistence
    const initialStatus = await routes.get('GET /api/memory/status')({ force: '1' });
    assert.equal(initialStatus.ok, true);
    assert.equal(initialStatus.settings.zeroUiaMode, false);
    assert.equal(initialStatus.settings.memoryGuard.autoTrimEnabled, true);
    assert.equal(initialStatus.settings.memoryGuard.thresholdMb, 1800);
    assert.equal(initialStatus.summary.totalPrivateWsMb, 2138.5);

    // 2. Update settings & verify disk persistence across themes.json + user_prefs.json
    const updated = await routes.get('POST /api/memory/settings')({
      zeroUiaMode: true,
      autoTrimEnabled: true,
      thresholdMb: 1500,
      intervalMin: 15,
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.settings.zeroUiaMode, true);
    assert.equal(updated.settings.memoryGuard.thresholdMb, 1500);
    assert.equal(updated.settings.memoryGuard.intervalMin, 15);

    const savedThemes = await env.storage.getThemes();
    const savedPrefs = await env.storage.getPrefs();
    assert.equal(savedThemes.zeroUiaMode, true);
    assert.equal(savedPrefs.memoryGuard.thresholdMb, 1500);

    // 3. Auto-guard tick triggers because 2138.5 MB >= 1500 MB threshold
    const guardRes1 = await manager.runAutoGuardTick();
    assert.equal(guardRes1.triggered, true);
    assert.equal(trimCalls, 1);
    assert.equal(shrinkCalls, 1);
    assert.equal(guardRes1.result.optimize.freedMb, 1180);

    // 4. Second auto-guard tick is skipped due to cooldown
    const guardRes2 = await manager.runAutoGuardTick();
    assert.equal(guardRes2.triggered, false);
    assert.equal(guardRes2.reason, 'cooldown');

    // 5. Manual optimize & restart companions routes
    currentMainMb = 1400;
    const optRes = await routes.get('POST /api/memory/optimize')({});
    assert.equal(optRes.ok, true);
    assert.equal(trimCalls, 2);
    assert.equal(optRes.optimize.freedMb, 480);

    const restartRes = await routes.get('POST /api/memory/restart-companions')({});
    assert.equal(restartRes.ok, true);
    assert.equal(restartCalls, 1);
  } finally {
    await env.cleanup();
  }
});
