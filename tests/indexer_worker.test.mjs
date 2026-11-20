import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { scanOnce } from '../sidecars/agy_monitor/backend/scan_worker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.resolve(__dirname, '../sidecars/agy_monitor/backend/scan_worker.mjs');

function createWorkerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-monitor-idx-'));
  const brainDir = path.join(root, 'brain');
  const cacheDbPath = path.join(root, 'data', 'telemetry_cache.db');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(path.dirname(cacheDbPath), { recursive: true });

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, brainDir, cacheDbPath };
}

function writeConvLines(brainDir, convId, rawText) {
  const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, 'transcript.jsonl');
  fs.writeFileSync(filePath, rawText, 'utf8');
  return filePath;
}

test('scanOnce handles incremental byte-offset, incomplete trailing line, duplicate step_index, checkpoint, and truncation', async (t) => {
  const { brainDir, cacheDbPath } = createWorkerFixture(t);
  const convId = 'conv-worker-1';

  const line0 = JSON.stringify({
    step_index: 0,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'STREAMING',
    created_at: '2026-11-18T10:00:00Z',
    model: 'gemini-4-hydrogen-xhigh',
    input_tokens: 1000,
    cache_read_tokens: 0,
    output_tokens: 20,
  });
  const line0Done = JSON.stringify({
    step_index: 0,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-18T10:00:02Z',
    model: 'gemini-4-hydrogen-xhigh',
    input_tokens: 1000,
    cache_read_tokens: 0,
    output_tokens: 120,
  });
  const line1Partial = '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",';
  const line1Rest = '"created_at":"2026-11-18T10:00:05Z","model":"gemini-4-hydrogen-xhigh","input_tokens":500,"cache_read_tokens":1050,"output_tokens":80}\n';

  // 1. Initial write with duplicate step_index=0 plus a half-written trailing line WITHOUT newline
  const transcriptPath = writeConvLines(brainDir, convId, `${line0}\n${line0Done}\n${line1Partial}`);
  const pass1 = await scanOnce(brainDir, cacheDbPath);
  assert.equal(pass1.etagChanged, true);
  assert.equal(pass1.updatedFiles, 1);

  let db = new DatabaseSync(cacheDbPath, { readOnly: true });
  let steps = db.prepare('SELECT * FROM step_ledger WHERE conv_id = ? ORDER BY step_index').all(convId);
  let wm = db.prepare('SELECT * FROM session_watermarks WHERE conv_id = ?').get(convId);
  db.close();

  assert.equal(steps.length, 1, 'duplicate step_index=0 must be deduplicated into 1 ledger row');
  assert.equal(steps[0].output_tokens, 120, 'latest DONE row output must win without summing STREAMING row');
  assert.equal(wm.byte_offset, Buffer.byteLength(`${line0}\n${line0Done}\n`, 'utf8'));

  // 2. Finish trailing line with newline -> incremental scan picks up step_index=1 cleanly
  fs.appendFileSync(transcriptPath, line1Rest, 'utf8');
  const pass2 = await scanOnce(brainDir, cacheDbPath);
  assert.equal(pass2.etagChanged, true);

  db = new DatabaseSync(cacheDbPath, { readOnly: true });
  steps = db.prepare('SELECT * FROM step_ledger WHERE conv_id = ? ORDER BY step_index').all(convId);
  db.close();
  assert.equal(steps.length, 2);
  assert.equal(steps[1].output_tokens, 80);

  // 3. CHECKPOINT compacts active context size without wiping earlier step burn records
  const checkpointLine = JSON.stringify({
    step_index: 2,
    source: 'SYSTEM',
    type: 'CHECKPOINT',
    status: 'DONE',
    created_at: '2026-11-18T10:01:00Z',
    input_tokens: 900,
    cache_read_tokens: 100,
    output_tokens: 300,
  });
  fs.appendFileSync(transcriptPath, `${checkpointLine}\n`, 'utf8');
  await scanOnce(brainDir, cacheDbPath);

  db = new DatabaseSync(cacheDbPath, { readOnly: true });
  const latestMetrics = db.prepare('SELECT * FROM conv_latest_metrics WHERE conv_id = ?').get(convId);
  wm = db.prepare('SELECT * FROM session_watermarks WHERE conv_id = ?').get(convId);
  const sumRow = db
    .prepare(
      "SELECT SUM(input_tokens + cache_read_tokens + output_tokens) AS total_burn FROM step_ledger WHERE conv_id = ? AND step_type = 'PLANNER_RESPONSE'",
    )
    .get(convId);
  db.close();
  assert.equal(latestMetrics.latest_context_tokens, 1000, 'checkpoint resets current ctx occupancy');
  assert.equal(sumRow.total_burn, 1120 + 1630, 'historical PLANNER_RESPONSE burn stays intact across checkpoint');

  // 4. Truncation / log replacement (size < previous byte_offset) resets old ledger & scans from 0
  const smallerResetLine = JSON.stringify({
    step_index: 0,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-18T11:00:00Z',
    model: 'gemini-3-8-flash',
    input_tokens: 42,
    cache_read_tokens: 0,
    output_tokens: 8,
  });
  fs.writeFileSync(transcriptPath, `${smallerResetLine}\n`, 'utf8');
  assert.ok(fs.statSync(transcriptPath).size < wm.byte_offset);
  await scanOnce(brainDir, cacheDbPath);

  db = new DatabaseSync(cacheDbPath, { readOnly: true });
  steps = db.prepare('SELECT * FROM step_ledger WHERE conv_id = ? ORDER BY step_index').all(convId);
  db.close();
  assert.equal(steps.length, 1);
  assert.equal(steps[0].input_tokens, 42);
  assert.equal(steps[0].model, 'gemini-3-8-flash');
});

test('forked scan_worker process scans on startup, processes IPC rescan, and exits cleanly on shutdown', async (t) => {
  const { brainDir, cacheDbPath } = createWorkerFixture(t);
  const convPath = writeConvLines(
    brainDir,
    'conv-ipc-1',
    `${JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-18T12:00:00Z',
      model: 'gemini-4-argon',
      input_tokens: 300,
      cache_read_tokens: 700,
      output_tokens: 50,
    })}\n`,
  );

  const child = fork(WORKER_SCRIPT, [], {
    env: {
      ...process.env,
      AGY_MONITOR_BRAIN_DIR: brainDir,
      AGY_MONITOR_CACHE_DB: cacheDbPath,
      AGY_MONITOR_SCAN_INTERVAL_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  t.after(() => {
    if (!child.killed) {
      child.kill();
    }
  });

  const messages = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('scan_worker IPC timeout')), 8000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('message', (msg) => {
      messages.push(msg);
      if (messages.length === 1 && msg?.type === 'updated') {
        fs.appendFileSync(
          convPath,
          `${JSON.stringify({
            step_index: 1,
            source: 'MODEL',
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: '2026-11-18T12:00:10Z',
            model: 'gemini-4-argon',
            input_tokens: 100,
            cache_read_tokens: 950,
            output_tokens: 25,
          })}\n`,
          'utf8',
        );
        child.send({ type: 'rescan' });
      } else if (messages.length >= 2 && msg?.type === 'updated') {
        child.send({ type: 'shutdown' });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      assert.equal(code, 0);
      resolve();
    });
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, 'updated');
  assert.equal(messages[1].type, 'updated');
  assert.equal(messages[1].newSteps, 1);
  assert.notEqual(messages[0].etag, messages[1].etag);
});
