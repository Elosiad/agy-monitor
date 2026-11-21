import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolvePaths } from './paths.mjs';

const RETRY_ERRORS = new Set(['EBUSY', 'EACCES', 'EPERM']);
const RETRY_DELAYS_MS = [25, 60, 140, 300];
const CHUNK_SIZE = 512 * 1024;
const MAX_LINE_BUFFER = 16 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn) {
  let lastErr;
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!err || !RETRY_ERRORS.has(err.code) || i === RETRY_DELAYS_MS.length) {
        throw err;
      }
      await sleep(RETRY_DELAYS_MS[i]);
    }
  }
  throw lastErr;
}

function toNonNegInt(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

function parseTimestampMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? Math.trunc(raw) : Math.trunc(raw * 1000);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

export function resolveDefaultBrainDir() {
  if (process.env.AGY_MONITOR_BRAIN_DIR) {
    return path.resolve(process.env.AGY_MONITOR_BRAIN_DIR);
  }
  return resolvePaths().brainDir;
}

export function resolveDefaultCacheDbPath() {
  if (process.env.AGY_MONITOR_CACHE_DB) {
    return path.resolve(process.env.AGY_MONITOR_CACHE_DB);
  }
  return resolvePaths().telemetryCacheDb;
}

/**
 * Ensures the SQLite telemetry cache schema exists and configures WAL concurrency.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureCacheSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 3000;

    CREATE TABLE IF NOT EXISTS session_watermarks (
      conv_id TEXT PRIMARY KEY,
      transcript_path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      byte_offset INTEGER NOT NULL,
      last_scan_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS step_ledger (
      conv_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      step_type TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      tool_calls_count INTEGER NOT NULL DEFAULT 0,
      content_chars INTEGER NOT NULL DEFAULT 0,
      thinking_chars INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      PRIMARY KEY (conv_id, step_index)
    );

    CREATE INDEX IF NOT EXISTS idx_step_ledger_created
      ON step_ledger(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_step_ledger_conv_time
      ON step_ledger(conv_id, created_at_ms);

    CREATE TABLE IF NOT EXISTS conv_latest_metrics (
      conv_id TEXT PRIMARY KEY,
      latest_model TEXT,
      latest_model_at_ms INTEGER NOT NULL DEFAULT 0,
      latest_context_tokens INTEGER NOT NULL DEFAULT 0,
      latest_uncached_input INTEGER NOT NULL DEFAULT 0,
      latest_cache_read INTEGER NOT NULL DEFAULT 0,
      latest_output_tokens INTEGER NOT NULL DEFAULT 0,
      user_chars_total INTEGER NOT NULL DEFAULT 0,
      tool_chars_total INTEGER NOT NULL DEFAULT 0,
      latest_speed_tok_s REAL,
      avg_speed_tok_s REAL,
      speed_source TEXT,
      speed_at_ms INTEGER NOT NULL DEFAULT 0,
      last_step_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scan_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function openCacheDb(cacheDbPath) {
  fs.mkdirSync(path.dirname(cacheDbPath), { recursive: true });
  const db = new DatabaseSync(cacheDbPath, { timeout: 3000 });
  ensureCacheSchema(db);
  return db;
}

const COLD_CONV_AGE_MS = 10 * 60 * 1000;
const COLD_RESCAN_MODULO = 5;

async function discoverTranscripts(brainDir, { coldCache = null, scanTick = 0, fullSweep = true } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(brainDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const nowMs = Date.now();
  const seenIds = coldCache ? new Set() : null;
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const convId = entry.name;
    if (convId.startsWith('.')) continue;
    if (seenIds) seenIds.add(convId);

    const cached = coldCache ? coldCache.get(convId) : null;
    if (
      !fullSweep &&
      cached &&
      nowMs - cached.mtimeMs > COLD_CONV_AGE_MS &&
      scanTick % COLD_RESCAN_MODULO !== 0
    ) {
      if (cached.exists) {
        results.push({
          convId,
          transcriptPath: cached.transcriptPath,
          mtimeMs: cached.mtimeMs,
          sizeBytes: cached.sizeBytes,
        });
      }
      continue;
    }

    const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      const st = await withRetry(() => fsp.stat(transcriptPath));
      if (st.isFile()) {
        const mtimeMs = Math.trunc(st.mtimeMs);
        const sizeBytes = st.size;
        if (coldCache) {
          coldCache.set(convId, { exists: true, transcriptPath, mtimeMs, sizeBytes });
        }
        results.push({
          convId,
          transcriptPath,
          mtimeMs,
          sizeBytes,
        });
      } else if (coldCache) {
        coldCache.set(convId, { exists: false, transcriptPath, mtimeMs: 0, sizeBytes: 0 });
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        if (coldCache) {
          coldCache.set(convId, { exists: false, transcriptPath, mtimeMs: 0, sizeBytes: 0 });
        }
        continue;
      }
      if (err && RETRY_ERRORS.has(err.code)) continue;
      throw err;
    }
  }
  if (coldCache && seenIds) {
    for (const key of coldCache.keys()) {
      if (!seenIds.has(key)) coldCache.delete(key);
    }
  }
  return results;
}

function parseLineToRow(convId, lineText, fallbackStepIndex) {
  const trimmed = lineText.trim();
  if (!trimmed) return null;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const stepIndex = Number.isInteger(obj.step_index) && obj.step_index >= 0
    ? obj.step_index
    : fallbackStepIndex;
  const stepType = typeof obj.type === 'string' && obj.type ? obj.type : 'GENERIC';
  const createdAtMs = parseTimestampMs(obj.created_at);
  const model = typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : null;
  const inputTokens = toNonNegInt(obj.input_tokens);
  const cacheReadTokens = toNonNegInt(obj.cache_read_tokens);
  const outputTokens = toNonNegInt(obj.output_tokens);
  const toolCallsCount = Array.isArray(obj.tool_calls) ? obj.tool_calls.length : 0;
  const contentChars = typeof obj.content === 'string' ? obj.content.length : 0;
  const thinkingChars = typeof obj.thinking === 'string' ? obj.thinking.length : 0;

  return {
    conv_id: convId,
    step_index: stepIndex,
    step_type: stepType,
    created_at_ms: createdAtMs,
    model,
    input_tokens: inputTokens,
    cache_read_tokens: cacheReadTokens,
    output_tokens: outputTokens,
    tool_calls_count: toolCallsCount,
    content_chars: contentChars,
    thinking_chars: thinkingChars,
  };
}

/**
 * Reads complete JSONL lines from startOffset up to file size without splitting UTF-8 or half-written lines.
 */
async function readDeltaLines(
  convId,
  filePath,
  startOffset,
  sizeBytes,
  mtimeMs,
  flushPartial,
  initialFallbackIndex = 0,
) {
  const rows = [];
  let cursor = startOffset;
  let leftover = Buffer.alloc(0);
  let fallbackIndex = Math.max(0, Number(initialFallbackIndex) || 0);

  const fh = await withRetry(() => fsp.open(filePath, 'r'));
  try {
    while (cursor < sizeBytes) {
      const toRead = Math.min(CHUNK_SIZE, sizeBytes - cursor);
      const chunk = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await withRetry(() => fh.read(chunk, 0, toRead, cursor));
      if (bytesRead <= 0) break;
      cursor += bytesRead;

      const slice = bytesRead === toRead ? chunk : chunk.subarray(0, bytesRead);
      const combined = leftover.length > 0 ? Buffer.concat([leftover, slice]) : slice;

      const lastNl = combined.lastIndexOf(0x0a);
      if (lastNl !== -1) {
        const completeBlock = combined.subarray(0, lastNl).toString('utf8');
        const lines = completeBlock.split(/\r?\n/);
        for (const line of lines) {
          const parsed = parseLineToRow(convId, line, fallbackIndex++);
          if (parsed) rows.push(parsed);
        }
        leftover = Buffer.from(combined.subarray(lastNl + 1));
      } else {
        if (combined.length > MAX_LINE_BUFFER) {
          // Oversized malformed line guard: discard unparseable giant buffer and advance cleanly.
          leftover = Buffer.alloc(0);
        } else {
          leftover = Buffer.from(combined);
        }
      }
    }
  } finally {
    await fh.close().catch(() => {});
  }

  let consumedBytes = cursor - leftover.length;

  // Handle a final line lacking trailing '\n' only if it is complete JSON and safe to consume.
  if (leftover.length > 0) {
    const trailingText = leftover.toString('utf8').trim();
    const isQuiet = flushPartial || (Date.now() - mtimeMs >= 500);
    if (trailingText && isQuiet && trailingText.endsWith('}')) {
      try {
        JSON.parse(trailingText);
        const parsed = parseLineToRow(convId, trailingText, fallbackIndex++);
        if (parsed) rows.push(parsed);
        consumedBytes = cursor;
      } catch {
        // Incomplete JSON write in progress: hold byte_offset at last newline.
      }
    }
  }

  return {
    rows,
    nextOffset: consumedBytes,
  };
}

function recomputeConvMetrics(db, convId) {
  const rows = db
    .prepare(
      `SELECT step_index, step_type, created_at_ms, model, input_tokens,
              cache_read_tokens, output_tokens, tool_calls_count, content_chars
       FROM step_ledger
       WHERE conv_id = ?
       ORDER BY step_index ASC`
    )
    .all(convId);

  if (!rows.length) {
    db.prepare(`DELETE FROM conv_latest_metrics WHERE conv_id = ?`).run(convId);
    return;
  }

  let latestModel = null;
  let latestModelAtMs = 0;
  let latestContextTokens = 0;
  let latestUncachedInput = 0;
  let latestCacheRead = 0;
  let latestOutputTokens = 0;
  let userCharsTotal = 0;
  let toolCharsTotal = 0;
  let latestSpeedTokS = null;
  let speedSource = null;
  let speedAtMs = 0;
  let lastStepAtMs = 0;

  let speedOutSum = 0;
  let speedSecSum = 0;
  const updateDurationStmt = db.prepare(
    `UPDATE step_ledger SET duration_ms = ? WHERE conv_id = ? AND step_index = ?`
  );

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.created_at_ms > lastStepAtMs) {
      lastStepAtMs = row.created_at_ms;
    }
    if (row.model) {
      latestModel = row.model;
      latestModelAtMs = row.created_at_ms;
    }

    if (row.step_type === 'CHECKPOINT') {
      // CHECKPOINT resets current conversation context segment breakdown, NEVER deletes step_ledger burn history.
      userCharsTotal = 0;
      toolCharsTotal = 0;
      const checkpointIn = row.input_tokens + row.cache_read_tokens;
      // Real Antigravity CHECKPOINT logs the summarizer call itself (input+cache = pre-compaction full context,
      // output = compacted summary). Estimate post-compaction occupancy from summary + system base instead of spiking to 100%.
      const looksLikeSummarizerCall =
        latestContextTokens > 0 &&
        checkpointIn >= latestContextTokens * 0.85 &&
        row.output_tokens > 0 &&
        row.output_tokens < checkpointIn * 0.5;
      latestUncachedInput = row.input_tokens;
      latestCacheRead = row.cache_read_tokens;
      latestOutputTokens = row.output_tokens;
      latestContextTokens = looksLikeSummarizerCall
        ? Math.min(checkpointIn, row.output_tokens + 12800)
        : checkpointIn;
      continue;
    }

    if (row.step_type === 'USER_INPUT') {
      userCharsTotal += row.content_chars;
    } else if (row.step_type === 'GENERIC' || row.step_type === 'ERROR_MESSAGE') {
      toolCharsTotal += row.content_chars;
    }

    if (row.step_type === 'PLANNER_RESPONSE') {
      const stepTotal = row.input_tokens + row.cache_read_tokens + row.output_tokens;
      if (stepTotal > 0) {
        latestUncachedInput = row.input_tokens;
        latestCacheRead = row.cache_read_tokens;
        latestOutputTokens = row.output_tokens;
        latestContextTokens = stepTotal;
      }
      if (row.tool_calls_count > 0) {
        toolCharsTotal += row.tool_calls_count * 120;
      }

      const next = rows[i + 1];
      if (
        row.output_tokens > 0 &&
        row.tool_calls_count > 0 &&
        next &&
        (next.step_type === 'GENERIC' ||
          next.step_type === 'ERROR_MESSAGE' ||
          next.step_type === 'CHECKPOINT')
      ) {
        const dt = next.created_at_ms - row.created_at_ms;
        if (dt >= 1000 && dt <= 180_000) {
          const tokPerSec = row.output_tokens / (dt / 1000);
          latestSpeedTokS = Number(tokPerSec.toFixed(1));
          speedSource = 'tool_step_e2e_est';
          speedAtMs = next.created_at_ms;
          speedOutSum += row.output_tokens;
          speedSecSum += dt / 1000;
          updateDurationStmt.run(dt, convId, row.step_index);
        }
      }
    }
  }

  const avgSpeedTokS =
    speedSecSum > 0 ? Number((speedOutSum / speedSecSum).toFixed(1)) : null;

  db.prepare(
    `INSERT INTO conv_latest_metrics (
       conv_id, latest_model, latest_model_at_ms,
       latest_context_tokens, latest_uncached_input, latest_cache_read, latest_output_tokens,
       user_chars_total, tool_chars_total,
       latest_speed_tok_s, avg_speed_tok_s, speed_source, speed_at_ms, last_step_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conv_id) DO UPDATE SET
       latest_model = excluded.latest_model,
       latest_model_at_ms = excluded.latest_model_at_ms,
       latest_context_tokens = excluded.latest_context_tokens,
       latest_uncached_input = excluded.latest_uncached_input,
       latest_cache_read = excluded.latest_cache_read,
       latest_output_tokens = excluded.latest_output_tokens,
       user_chars_total = excluded.user_chars_total,
       tool_chars_total = excluded.tool_chars_total,
       latest_speed_tok_s = excluded.latest_speed_tok_s,
       avg_speed_tok_s = excluded.avg_speed_tok_s,
       speed_source = excluded.speed_source,
       speed_at_ms = excluded.speed_at_ms,
       last_step_at_ms = excluded.last_step_at_ms`
  ).run(
    convId,
    latestModel,
    latestModelAtMs,
    latestContextTokens,
    latestUncachedInput,
    latestCacheRead,
    latestOutputTokens,
    userCharsTotal,
    toolCharsTotal,
    latestSpeedTokS,
    avgSpeedTokS,
    speedSource,
    speedAtMs,
    lastStepAtMs
  );
}

function computeDbEtag(db) {
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(input_tokens + cache_read_tokens + output_tokens), 0) AS tokSum,
              COALESCE(MAX(created_at_ms), 0) AS maxTs
       FROM step_ledger`
    )
    .get();
  const wm = db
    .prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(byte_offset), 0) AS offsetSum FROM session_watermarks`)
    .get();
  const raw = `${agg.cnt}:${agg.tokSum}:${agg.maxTs}:${wm.files}:${wm.offsetSum}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

const PREPARED_STMTS_BY_DB = new WeakMap();

function getPreparedStatements(db) {
  let stmts = PREPARED_STMTS_BY_DB.get(db);
  if (stmts) return stmts;
  stmts = {
    selectWatermark: db.prepare(
      `SELECT mtime_ms, size_bytes, byte_offset FROM session_watermarks WHERE conv_id = ?`
    ),
    selectMaxStep: db.prepare(
      `SELECT COALESCE(MAX(step_index), -1) AS max_idx FROM step_ledger WHERE conv_id = ?`
    ),
    deleteConvSteps: db.prepare(`DELETE FROM step_ledger WHERE conv_id = ?`),
    deleteConvMetrics: db.prepare(`DELETE FROM conv_latest_metrics WHERE conv_id = ?`),
    upsertStep: db.prepare(
      `INSERT INTO step_ledger (
         conv_id, step_index, step_type, created_at_ms, model,
         input_tokens, cache_read_tokens, output_tokens, tool_calls_count,
         content_chars, thinking_chars
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conv_id, step_index) DO UPDATE SET
         step_type = excluded.step_type,
         created_at_ms = excluded.created_at_ms,
         model = excluded.model,
         input_tokens = excluded.input_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         output_tokens = excluded.output_tokens,
         tool_calls_count = excluded.tool_calls_count,
         content_chars = excluded.content_chars,
         thinking_chars = excluded.thinking_chars`
    ),
    upsertWatermark: db.prepare(
      `INSERT INTO session_watermarks (
         conv_id, transcript_path, mtime_ms, size_bytes, byte_offset, last_scan_ms
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conv_id) DO UPDATE SET
         transcript_path = excluded.transcript_path,
         mtime_ms = excluded.mtime_ms,
         size_bytes = excluded.size_bytes,
         byte_offset = excluded.byte_offset,
         last_scan_ms = excluded.last_scan_ms`
    ),
    upsertMeta: db.prepare(
      `INSERT INTO scan_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ),
  };
  PREPARED_STMTS_BY_DB.set(db, stmts);
  return stmts;
}

function scanDbWithConnection(db, transcripts, { flushPartial = false } = {}) {
  return (async () => {
    const {
      selectWatermark,
      selectMaxStep,
      deleteConvSteps,
      deleteConvMetrics,
      upsertStep,
      upsertWatermark,
      upsertMeta,
    } = getPreparedStatements(db);

    const changedConvs = [];
    let updatedFiles = 0;
    let newSteps = 0;
    const nowMs = Date.now();

    for (const item of transcripts) {
      const prev = selectWatermark.get(item.convId);
      if (
        prev &&
        prev.mtime_ms === item.mtimeMs &&
        prev.size_bytes === item.sizeBytes &&
        prev.byte_offset === item.sizeBytes
      ) {
        continue;
      }

      const truncated = Boolean(prev && item.sizeBytes < prev.byte_offset);
      const startOffset = truncated ? 0 : prev ? prev.byte_offset : 0;
      const maxStepRow = truncated ? null : selectMaxStep.get(item.convId);
      const initialFallbackIdx =
        truncated || !prev ? 0 : Math.max(0, Number(maxStepRow?.max_idx ?? -1) + 1);

      const { rows, nextOffset } = await readDeltaLines(
        item.convId,
        item.transcriptPath,
        startOffset,
        item.sizeBytes,
        item.mtimeMs,
        flushPartial,
        initialFallbackIdx
      );

      if (!truncated && rows.length === 0 && prev && nextOffset === prev.byte_offset) {
        // Still update mtime/size watermark only if size didn't leave unread complete lines
        continue;
      }

      db.exec('BEGIN IMMEDIATE');
      try {
        if (truncated) {
          deleteConvSteps.run(item.convId);
          deleteConvMetrics.run(item.convId);
        }
        for (const r of rows) {
          upsertStep.run(
            r.conv_id,
            r.step_index,
            r.step_type,
            r.created_at_ms,
            r.model,
            r.input_tokens,
            r.cache_read_tokens,
            r.output_tokens,
            r.tool_calls_count,
            r.content_chars,
            r.thinking_chars
          );
        }
        upsertWatermark.run(
          item.convId,
          item.transcriptPath,
          item.mtimeMs,
          item.sizeBytes,
          nextOffset,
          nowMs
        );
        if (rows.length > 0 || truncated) {
          recomputeConvMetrics(db, item.convId);
          changedConvs.push(item.convId);
          updatedFiles += 1;
          newSteps += rows.length;
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Ignore rollback error
        }
        throw err;
      }
    }

    const prevEtagRow = db.prepare(`SELECT value FROM scan_meta WHERE key = 'etag'`).get();
    const etag = computeDbEtag(db);
    upsertMeta.run('etag', etag);
    upsertMeta.run('last_scan_ms', String(nowMs));

    return {
      scannedFiles: transcripts.length,
      updatedFiles,
      newSteps,
      changedConvs,
      etag,
      etagChanged: !prevEtagRow || prevEtagRow.value !== etag,
    };
  })();
}

/**
 * Performs a single incremental scan pass across all transcript.jsonl files.
 * Accepts either `(brainDir, cacheDbPath, options)` or `({ brainDir, cacheDbPath, flushPartial })`.
 */
export async function scanOnce(brainDirOrOpts, cacheDbPathArg, options = {}) {
  let brainDir;
  let cacheDbPath;
  let flushPartial = false;

  if (brainDirOrOpts && typeof brainDirOrOpts === 'object') {
    brainDir = brainDirOrOpts.brainDir || resolveDefaultBrainDir();
    cacheDbPath = brainDirOrOpts.cacheDbPath || resolveDefaultCacheDbPath();
    flushPartial = Boolean(brainDirOrOpts.flushPartial);
  } else {
    brainDir = brainDirOrOpts || resolveDefaultBrainDir();
    cacheDbPath = cacheDbPathArg || resolveDefaultCacheDbPath();
    flushPartial = Boolean(options.flushPartial);
  }

  const transcripts = await discoverTranscripts(brainDir);
  const db = openCacheDb(cacheDbPath);
  try {
    return await scanDbWithConnection(db, transcripts, { flushPartial });
  } finally {
    db.close();
  }
}

export { scanOnce as runIncrementalScanOnce };

async function runWorkerMain() {
  const brainDir = resolveDefaultBrainDir();
  const cacheDbPath = resolveDefaultCacheDbPath();
  const rawInterval = process.env.AGY_MONITOR_SCAN_INTERVAL_MS;
  const intervalMs = rawInterval === undefined ? 2500 : Number(rawInterval);

  const db = openCacheDb(cacheDbPath);
  const coldCache = new Map();
  let scanTick = 0;
  let shuttingDown = false;
  let inFlight = null;
  let timer = null;

  const triggerScan = (forceNotify = false) => {
    if (shuttingDown) return Promise.resolve(null);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        scanTick += 1;
        const transcripts = await discoverTranscripts(brainDir, {
          coldCache,
          scanTick,
          fullSweep: Boolean(forceNotify) || scanTick === 1,
        });
        const res = await scanDbWithConnection(db, transcripts, { flushPartial: false });
        if ((res.etagChanged || forceNotify) && process.connected && typeof process.send === 'function') {
          try {
            process.send({
              type: 'updated',
              etag: res.etag,
              changedConvs: res.changedConvs,
              newSteps: res.newSteps,
            });
          } catch {
            // Ignore IPC disconnect during shutdown
          }
        }
        return res;
      } catch (err) {
        if (process.connected && typeof process.send === 'function') {
          try {
            process.send({ type: 'error', message: err?.message || 'scan_error' });
          } catch {
            // Ignore IPC disconnect during shutdown
          }
        }
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    try {
      db.close();
    } catch {
      // Ignore close error on shutdown
    }
    process.exit(0);
  };

  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'rescan') {
      void triggerScan(Boolean(msg.forceNotify));
    } else if (msg.type === 'shutdown') {
      void shutdown();
    }
  });

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await triggerScan(true);

  if (Number.isFinite(intervalMs) && intervalMs > 0 && !shuttingDown) {
    timer = setInterval(() => {
      void triggerScan(false);
    }, Math.max(500, intervalMs));
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  void runWorkerMain();
}
