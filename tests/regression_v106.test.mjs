import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { scanOnce } from '../sidecars/agy_monitor/backend/scan_worker.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import { queryBatchConvHudMetrics, queryTelemetrySnapshot } from '../sidecars/agy_monitor/backend/telemetry.mjs';
import { createMonitorHandlers } from '../sidecars/agy_monitor/main.mjs';

function makeTempFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-reg106-test-'));
  const paths = resolvePaths({
    appDataDir: path.join(root, 'appData'),
    geminiConfigDir: path.join(root, 'config'),
    pluginDataDir: path.join(root, 'pluginData'),
    sidecarDataDir: path.join(root, 'sidecarData'),
    brainDir: path.join(root, 'brain'),
  });
  const storage = createStorage(paths);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, paths, storage };
}

function writeTranscript(brainDir, convId, rows) {
  const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, 'transcript.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
}

test('v1.0.6 CHECKPOINT summarizer call estimates compacted context instead of spiking to 100%', async (t) => {
  const { paths, storage } = makeTempFixture(t);
  const convId = 'conv-ckpt-real';
  writeTranscript(paths.brainDir, convId, [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-21T01:00:00Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 4000,
      cache_read_tokens: 505000,
      output_tokens: 1200,
    },
    {
      step_index: 2,
      type: 'CHECKPOINT',
      created_at: '2026-11-21T01:01:00Z',
      input_tokens: 3227,
      cache_read_tokens: 511575,
      output_tokens: 8145,
    },
  ]);

  await scanOnce(paths.brainDir, paths.telemetryCacheDb);
  const snap = await queryTelemetrySnapshot(paths.telemetryCacheDb, storage, paths, {
    convId,
    isExplicitConvId: true,
    scope: 'current',
    range: '30d',
    windowCap: 512000,
  });

  // Post-compaction estimate: 8145 summary + 12800 system base = 20945 (~4%), NOT 514802 (101%)
  assert.equal(snap.contextPie.totalUsed, 20945);
  assert.ok(snap.contextPie.percent < 10, `expected <10% after compaction, got ${snap.contextPie.percent}%`);
});

test('v1.0.6 pure-chat conversation never borrows tok/s or model from another conversation', async (t) => {
  const { paths, storage } = makeTempFixture(t);
  writeTranscript(paths.brainDir, 'conv-tool-fast', [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-21T01:00:00Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 1000,
      cache_read_tokens: 9000,
      output_tokens: 1000,
      tool_calls: [{ name: 'run_command' }],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      created_at: '2026-11-21T01:00:10Z',
      content: 'ok',
    },
  ]);
  writeTranscript(paths.brainDir, 'conv-pure-chat', [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-21T01:05:00Z',
      model: 'claude-opus-4-6',
      input_tokens: 2000,
      cache_read_tokens: 0,
      output_tokens: 300,
    },
  ]);

  await scanOnce(paths.brainDir, paths.telemetryCacheDb);
  const snap = await queryTelemetrySnapshot(paths.telemetryCacheDb, storage, paths, {
    convId: 'conv-pure-chat',
    isExplicitConvId: true,
    topLevelConvIds: ['conv-tool-fast', 'conv-pure-chat'],
    scope: 'current',
    range: '30d',
    windowCap: 512000,
  });

  assert.equal(snap.runtimeTelemetry.upstreamModelId, 'claude-opus-4-6');
  assert.equal(snap.runtimeTelemetry.latestTokPerSec, null, 'Pure-chat conv must not inherit speed from conv-tool-fast');

  // Batch HUD metrics support independent dual-window percentages (including >100%)
  const batch = queryBatchConvHudMetrics(
    paths.telemetryCacheDb,
    [
      { id: 'conv-tool-fast', title: 'Fast Tool Run', workspace: 'projA' },
      { id: 'conv-pure-chat', title: 'Pure Chat', workspace: 'projB' },
    ],
    8000,
  );
  assert.equal(batch.length, 2);
  assert.equal(batch[0].percent, 138, 'Batch HUD metrics preserve uncapped >100% matching General Pie');
  assert.equal(batch[1].tokPerSec, null);
});

test('v1.0.6 blank New Conversation header resets HUD telemetry to 0% instead of keeping previous session', async (t) => {
  const { paths, storage } = makeTempFixture(t);
  writeTranscript(paths.brainDir, 'conv-prev', [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-21T02:00:00Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 50000,
      cache_read_tokens: 200000,
      output_tokens: 500,
    },
  ]);
  await scanOnce(paths.brainDir, paths.telemetryCacheDb);

  fs.writeFileSync(
    paths.hudActiveViewFile,
    JSON.stringify({
      workspace: '',
      title: 'New Conversation',
      isNewConversation: true,
      source: 'uia_header',
      updatedAtMs: Date.now() + 5000,
    }),
    'utf8',
  );

  const routes = createMonitorHandlers({ paths, storage });
  const snapHandler = routes.get('GET /api/snapshot');
  const snap = await snapHandler({ scope: 'current', range: '30d' });
  assert.equal(snap.contextPie.totalUsed, 0);
  assert.equal(snap.contextPie.percent, 0);

  // Give async hud.writePayload a tick to flush hud_telemetry.json
  await new Promise((r) => setTimeout(r, 60));
  const hudJson = JSON.parse(fs.readFileSync(paths.hudTelemetryFile, 'utf8'));
  assert.equal(hudJson.percent, 0);
  assert.equal(hudJson.totalUsed, 0);
  assert.equal(hudJson.upstreamModelId, '');
});
