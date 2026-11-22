import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { scanOnce } from '../sidecars/agy_monitor/backend/scan_worker.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import { createMonitorHandlers } from '../sidecars/agy_monitor/main.mjs';

function makeTempFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-sync-test-'));
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

test('HUD telemetry tracks active foreground hostConvId continuously while blocking hidden iframe hijack', async (t) => {
  const { paths, storage } = makeTempFixture(t);
  const convBg = 'conv-bg-running';
  const convFg = 'conv-fg-active';

  // Background conversation: 9.0 tok/s (90 output tokens over 10s), newer timestamp
  writeTranscript(paths.brainDir, convBg, [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T06:00:00Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 1000,
      cache_read_tokens: 100000,
      output_tokens: 90,
      tool_calls: [{ name: 'run_command' }],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      created_at: '2026-11-22T06:00:10Z',
      content: 'ok',
    },
  ]);

  // Foreground conversation: 20.0 tok/s (200 output tokens over 10s)
  writeTranscript(paths.brainDir, convFg, [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T05:59:00Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 2000,
      cache_read_tokens: 400000,
      output_tokens: 200,
      tool_calls: [{ name: 'run_command' }],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      created_at: '2026-11-22T05:59:10Z',
      content: 'ok',
    },
  ]);

  await scanOnce(paths.brainDir, paths.telemetryCacheDb);

  // Seed summaries DB via minimal sqlite so sessionsHub.allSelectable recognizes both top-level convs
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(paths.summariesDbPath), { recursive: true });
  const sumDb = new DatabaseSync(paths.summariesDbPath);
  sumDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      parent_conversation_id TEXT DEFAULT '',
      killed INTEGER DEFAULT 0,
      title TEXT,
      preview TEXT DEFAULT '',
      step_count INTEGER DEFAULT 2,
      last_modified_time INTEGER,
      workspace_uris TEXT,
      status TEXT,
      not_fully_idle INTEGER DEFAULT 0
    );
  `);
  const insert = sumDb.prepare(
    'INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, status) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(convBg, '飞镖乱斗程序对战赛', 1795327900000, '["file:///d:/work/bg"]', 'CASCADE_RUN_STATUS_RUNNING');
  insert.run(convFg, 'Antigravity Tool Improvement Ideas', 1795327800000, '["file:///d:/work/fg"]', 'CASCADE_RUN_STATUS_IDLE');
  sumDb.close();

  const routes = createMonitorHandlers({ paths, storage });
  const getSnapshot = routes.get('GET /api/snapshot');
  assert.ok(getSnapshot);

  // 1. Foreground panel focuses convFg (syncHud=1) -> HUD immediately writes convFg (20.0 tok/s)
  await getSnapshot({ scope: 'current', range: 'today', hostConvId: convFg, syncHud: '1' });
  await new Promise((r) => setTimeout(r, 40));
  let hudDoc = JSON.parse(fs.readFileSync(paths.hudTelemetryFile, 'utf8'));
  assert.equal(hudDoc.activeConvId, convFg);
  assert.equal(hudDoc.tokPerSec, 20);

  // 2. Hidden background iframe polls convBg WITHOUT syncHud -> MUST NOT hijack HUD
  await getSnapshot({ scope: 'current', range: 'today', hostConvId: convBg, syncHud: '0' });
  await new Promise((r) => setTimeout(r, 40));
  hudDoc = JSON.parse(fs.readFileSync(paths.hudTelemetryFile, 'utf8'));
  assert.equal(hudDoc.activeConvId, convFg, 'Hidden background iframe must not hijack foreground HUD');
  assert.equal(hudDoc.tokPerSec, 20);

  // 3. Foreground convFg produces a new faster turn (40.0 tok/s) and regular poll (syncHud=0) arrives -> HUD updates immediately!
  writeTranscript(paths.brainDir, convFg, [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T05:59:00Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 2000,
      cache_read_tokens: 400000,
      output_tokens: 200,
      tool_calls: [{ name: 'run_command' }],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      created_at: '2026-11-22T05:59:10Z',
      content: 'ok',
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T06:01:00Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 3000,
      cache_read_tokens: 420000,
      output_tokens: 400,
      tool_calls: [{ name: 'run_command' }],
    },
    {
      step_index: 4,
      type: 'GENERIC',
      created_at: '2026-11-22T06:01:10Z',
      content: 'ok',
    },
  ]);
  await scanOnce(paths.brainDir, paths.telemetryCacheDb);
  await getSnapshot({ scope: 'current', range: 'today', hostConvId: convFg, syncHud: '0' });
  await new Promise((r) => setTimeout(r, 40));
  hudDoc = JSON.parse(fs.readFileSync(paths.hudTelemetryFile, 'utf8'));
  assert.equal(hudDoc.activeConvId, convFg);
  assert.equal(hudDoc.tokPerSec, 40, 'Active foreground poll must push updated tok/s to HUD without waiting for hover');

  // 4. Garbage title written into hud_active_view.json must never kick HUD back to convBg
  fs.writeFileSync(
    paths.hudActiveViewFile,
    JSON.stringify({ workspace: '', title: 'Analyzed', isNewConversation: false, source: 'uia_header', updatedAtMs: Date.now() }),
    'utf8',
  );
  await getSnapshot({ scope: 'current', range: 'today', hostConvId: convFg, syncHud: '0' });
  await new Promise((r) => setTimeout(r, 40));
  hudDoc = JSON.parse(fs.readFileSync(paths.hudTelemetryFile, 'utf8'));
  assert.equal(hudDoc.activeConvId, convFg);
  assert.equal(hudDoc.tokPerSec, 40);
});
