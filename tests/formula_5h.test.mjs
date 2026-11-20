import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import { scanOnce } from '../sidecars/agy_monitor/backend/scan_worker.mjs';
import {
  classifyUpstreamModelStatus,
  queryTelemetrySnapshot,
} from '../sidecars/agy_monitor/backend/telemetry.mjs';

async function setupTelemetryFixture(t, recordsByConv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-monitor-5h-'));
  const pluginRoot = path.join(root, 'plugin');
  const appDataDir = path.join(root, 'antigravity');
  const geminiConfigDir = path.join(root, 'config');

  fs.mkdirSync(path.join(pluginRoot, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(appDataDir, 'brain'), { recursive: true });
  fs.mkdirSync(geminiConfigDir, { recursive: true });

  for (const [convId, lines] of Object.entries(recordsByConv)) {
    const logsDir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const body = lines.map((obj) => JSON.stringify(obj)).join('\n') + '\n';
    fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), body, 'utf8');
  }

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const paths = resolvePaths({ pluginRoot, appDataDir, geminiConfigDir });
  const storage = createStorage(paths);
  await scanOnce(paths.brainDir, paths.telemetryCacheDb);
  return { paths, storage };
}

test('contextPie uses input_tokens + cache_read_tokens + output and keeps systemBase immutable across rules', async (t) => {
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const convId = 'conv-ctx-1';
  const { paths, storage } = await setupTelemetryFixture(t, {
    [convId]: [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: nowIso,
        model: 'gemini-4-hydrogen-xhigh',
        input_tokens: 12000,
        cache_read_tokens: 128000,
        output_tokens: 2500,
      },
    ],
  });

  await storage.updatePrefs({ activePromptId: 'official' });
  const snapOfficial = await queryTelemetrySnapshot(paths.telemetryCacheDb, storage, paths, {
    convId,
    scope: 'current',
    range: '30d',
    windowCap: 512000,
  });

  const baseSystem = snapOfficial.contextPie.segments.systemBase;
  assert.ok(baseSystem > 0, 'systemBase must reflect official base estimate');
  assert.equal(snapOfficial.contextPie.segments.rulesAddon, 0);
  assert.equal(snapOfficial.contextPie.totalUsed, 142500);

  fs.writeFileSync(paths.rulesFile, '中文工程约束规范：先给结论再附验证证据。\n'.repeat(20), 'utf8');
  await storage.updatePrefs({ activePromptId: 'official-zh-brief' });
  const snapWithRules = await queryTelemetrySnapshot(paths.telemetryCacheDb, storage, paths, {
    convId,
    scope: 'current',
    range: '30d',
    windowCap: 512000,
  });

  assert.equal(
    snapWithRules.contextPie.segments.systemBase,
    baseSystem,
    'systemBase must never be falsely reduced when switching presets',
  );
  assert.ok(snapWithRules.contextPie.segments.rulesAddon > 0);
  const seg = snapWithRules.contextPie.segments;
  assert.equal(
    seg.systemBase + seg.rulesAddon + seg.userHistory + seg.toolsAndOutputs + seg.remaining,
    snapWithRules.contextPie.windowCap,
  );
});

test('classifyUpstreamModelStatus returns no_baseline when unset, matches neon/hydrogen tiers, and detects downgrades', () => {
  assert.equal(classifyUpstreamModelStatus(null, 'gemini-4-hydrogen-xhigh'), 'no_baseline');
  assert.equal(classifyUpstreamModelStatus({}, 'gemini-4-neon-xhigh'), 'no_baseline');
  assert.equal(classifyUpstreamModelStatus({ id: 'gemini-4-neon-xhigh', tier: 'Extra' }, ''), 'unreported');
  assert.equal(
    classifyUpstreamModelStatus({ id: 'gemini-4-neon-xhigh', tier: 'Extra' }, 'gemini-4-neon-xhigh'),
    'match',
  );
  assert.equal(
    classifyUpstreamModelStatus({ id: 'gemini-4-neon-xhigh', tier: 'Extra' }, 'gemini-3-8-flash'),
    'downgrade_suspected',
  );
  assert.equal(
    classifyUpstreamModelStatus({ id: 'gemini-4-hydrogen-high', tier: 'High' }, 'gemini-4-hydrogen-xhigh'),
    'ab_or_alias',
  );
});

test('runtimeTelemetry detects upstream model mismatch, recovers legacy model=null as __unrecorded__, and prevents cross-conv / subagent hijacking', async (t) => {
  const nowMs = Date.now();
  const tOld = new Date(nowMs - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const t1 = new Date(nowMs - 20_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const t2 = new Date(nowMs - 10_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tSub = new Date(nowMs - 2_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const { paths, storage } = await setupTelemetryFixture(t, {
    'conv-main': [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: tOld,
        // Legacy pre-v2.33 row omitting `model`
        input_tokens: 4000,
        cache_read_tokens: 6000,
        output_tokens: 500,
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: t1,
        model: 'gemini-3-8-flash',
        input_tokens: 1000,
        cache_read_tokens: 5000,
        output_tokens: 1000,
        tool_calls: [{ name: 'run_command' }],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: t2,
        content: 'done',
      },
    ],
    'conv-subagent': [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: tSub,
        model: 'gemini-4-argon-high',
        input_tokens: 200,
        cache_read_tokens: 300,
        output_tokens: 50,
      },
    ],
  });

  await storage.updatePrefs({
    defaultModel: { id: 'gemini-4-hydrogen-xhigh', tier: 'Extra' },
  });

  // 1. Speed & downgrade detection + __unrecorded__ bucket recovery
  const snapMain = await queryTelemetrySnapshot(paths.telemetryCacheDb, storage, paths, {
    convId: 'conv-main',
    isExplicitConvId: true,
    topLevelConvIds: ['conv-main'],
    scope: 'current',
    range: '30d',
    windowCap: 512000,
  });

  assert.equal(snapMain.runtimeTelemetry.upstreamModelId, 'gemini-3-8-flash');
  assert.equal(snapMain.runtimeTelemetry.upstreamModelStatus, 'downgrade_suspected');
  assert.equal(snapMain.runtimeTelemetry.speedSource, 'tool_step_e2e_est');
  assert.ok(Math.abs(snapMain.runtimeTelemetry.latestTokPerSec - 100) <= 5);

  const unrec = snapMain.tokenUsage.models.find((m) => m.model === '__unrecorded__');
  assert.ok(unrec, 'model=null steps must be recovered under __unrecorded__');
  assert.equal(unrec.totalTokens, 10500);
  assert.equal(unrec.estimatedCostUsd, null);
  assert.equal(unrec.isUnpriced, true);
  assert.equal(snapMain.tokenUsage.totalTokens, 10500 + 7000);
  assert.equal(
    snapMain.availableModelsFromLogs.some((m) => m.id === '__unrecorded__'),
    false,
  );

  // 2. Follow Latest filtered to topLevelConvIds ignores newer subagent conv
  const snapFollow = await queryTelemetrySnapshot(paths.telemetryCacheDb, storage, paths, {
    convId: '',
    isExplicitConvId: false,
    topLevelConvIds: ['conv-main'],
    scope: 'global',
    range: '30d',
    windowCap: 512000,
  });
  assert.equal(snapFollow.activeConvId, 'conv-main');

  // 3. Explicit empty conversation must stay empty (never silently hijack conv-main or conv-subagent)
  const snapEmptyExplicit = await queryTelemetrySnapshot(paths.telemetryCacheDb, storage, paths, {
    convId: 'conv-brand-new',
    isExplicitConvId: true,
    topLevelConvIds: ['conv-main'],
    scope: 'current',
    range: 'today',
    windowCap: 512000,
  });
  assert.equal(snapEmptyExplicit.activeConvId, 'conv-brand-new');
  assert.equal(snapEmptyExplicit.contextPie.totalUsed, 0);
  assert.equal(snapEmptyExplicit.runtimeTelemetry.upstreamModelId, null);
  assert.equal(snapEmptyExplicit.runtimeTelemetry.upstreamModelStatus, 'unreported');
  assert.equal(snapEmptyExplicit.runtimeTelemetry.latestTokPerSec, null);

  const db = new DatabaseSync(paths.telemetryCacheDb, { readOnly: true });
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM step_ledger').get();
  db.close();
  assert.equal(row.cnt, 4);
});
