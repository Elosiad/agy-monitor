import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { parseStepMetadataTiming, scanOnce } from '../sidecars/agy_monitor/backend/scan_worker.mjs';
import { queryRequestLogs } from '../sidecars/agy_monitor/backend/telemetry.mjs';

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

function encodeVarint(val) {
  let n = BigInt(val);
  const bytes = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    bytes.push(b);
  } while (n > 0n);
  return Buffer.from(bytes);
}

function encodeLenField(fieldNum, payloadBuf) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(payloadBuf.length), payloadBuf]);
}

function encodeTimestamp(sec, nanos = 0) {
  const parts = [encodeVarint((1 << 3) | 0), encodeVarint(sec)];
  if (nanos > 0) {
    parts.push(encodeVarint((2 << 3) | 0), encodeVarint(nanos));
  }
  return Buffer.concat(parts);
}

test('extracts exact TTFT and total duration (including final text turn) from conversations SQLite metadata', async (t) => {
  const { root, brainDir, cacheDbPath } = createWorkerFixture(t);
  const conversationsDir = path.join(root, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });
  const convId = 'conv-exact-timing';

  const t0Sec = 1795335900;
  // Direct f1/f6/f7 timing test + corrupt buffer safety
  const directMeta = Buffer.concat([
    encodeLenField(1, encodeTimestamp(t0Sec, 100_000_000)),
    encodeLenField(6, encodeTimestamp(t0Sec + 5, 450_000_000)),
    encodeLenField(7, encodeTimestamp(t0Sec + 18, 940_000_000)),
  ]);
  const parsedDirect = parseStepMetadataTiming(directMeta);
  assert.equal(parsedDirect.ttftMs, 5350);
  assert.equal(parsedDirect.durationMs, 18840);
  assert.equal(parseStepMetadataTiming(Buffer.from([0xff, 0xff, 0xff])), null);

  // Write transcript with a tool step AND a final pure-text reply (tool_calls = 0)
  const lines = [
    JSON.stringify({
      step_index: 10,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(t0Sec * 1000).toISOString(),
      model: 'gemini-4-neon-xhigh',
      input_tokens: 1000,
      cache_read_tokens: 99000,
      output_tokens: 500,
      tool_calls: [{ name: 'read_file' }],
    }),
    JSON.stringify({
      step_index: 11,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: new Date((t0Sec + 11) * 1000).toISOString(),
      content: 'file contents',
    }),
    JSON.stringify({
      step_index: 12,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date((t0Sec + 20) * 1000).toISOString(),
      model: 'gemini-4-neon-xhigh',
      input_tokens: 1200,
      cache_read_tokens: 99800,
      output_tokens: 1676,
    }),
  ].join('\n') + '\n';
  writeConvLines(brainDir, convId, lines);

  // First scan WITHOUT conversations/<convId>.db (simulates legacy cache before backfill)
  await scanOnce(brainDir, cacheDbPath);
  let logs = await queryRequestLogs(cacheDbPath, {
    scope: 'current',
    convId,
    range: '30d',
    nowMs: (t0Sec + 60) * 1000,
  });
  assert.equal(logs.items.length, 2);
  // Top row (step 12, pure text reply) had no next tool step -> durationMs/ttftMs null before conv db exists
  assert.equal(logs.items[0].stepIndex, 12);
  assert.equal(logs.items[0].ttftMs, null);
  assert.equal(logs.items[0].durationMs, null);

  // Now create conversations/<convId>.db with exact protobuf timings for BOTH step 10 and final step 12
  const convDbPath = path.join(conversationsDir, `${convId}.db`);
  const convDb = new DatabaseSync(convDbPath);
  convDb.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)`);
  const step10Meta = Buffer.concat([
    encodeLenField(1, encodeTimestamp(t0Sec, 0)),
    encodeLenField(6, encodeTimestamp(t0Sec + 8, 850_000_000)),
    encodeLenField(7, encodeTimestamp(t0Sec + 11, 860_000_000)),
  ]);
  const step12Meta = Buffer.concat([
    encodeLenField(1, encodeTimestamp(t0Sec + 20, 0)),
    encodeLenField(6, encodeTimestamp(t0Sec + 25, 350_000_000)),
    encodeLenField(7, encodeTimestamp(t0Sec + 38, 840_000_000)),
  ]);
  convDb.prepare(`INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, 3, ?)`).run(10, step10Meta);
  convDb.prepare(`INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, 3, ?)`).run(12, step12Meta);
  convDb.close();

  // Re-run scanOnce without modifying transcript.jsonl -> one-time backfill must populate BOTH rows!
  await scanOnce(brainDir, cacheDbPath);
  logs = await queryRequestLogs(cacheDbPath, {
    scope: 'current',
    convId,
    range: '30d',
    nowMs: (t0Sec + 60) * 1000,
  });
  assert.equal(logs.items.length, 2);
  assert.equal(logs.items[0].stepIndex, 12);
  assert.equal(logs.items[0].ttftMs, 5350);
  assert.equal(logs.items[0].durationMs, 18840);
  assert.equal(logs.items[0].tokPerSec, 89.0);

  assert.equal(logs.items[1].stepIndex, 10);
  assert.equal(logs.items[1].ttftMs, 8850);
  assert.equal(logs.items[1].durationMs, 11860);
  assert.equal(logs.items[1].tokPerSec, 42.2);

  // Verify conv_latest_metrics also upgraded to exact speed from final step 12
  const cacheDb = new DatabaseSync(cacheDbPath, { readOnly: true });
  const latest = cacheDb.prepare(`SELECT latest_speed_tok_s, speed_source FROM conv_latest_metrics WHERE conv_id = ?`).get(convId);
  cacheDb.close();
  assert.equal(latest.latest_speed_tok_s, 89.0);
  assert.equal(latest.speed_source, 'conv_db_exact');
});
