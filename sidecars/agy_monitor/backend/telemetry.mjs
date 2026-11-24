import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { estimateTokens } from './presets_builtin.mjs';

const DAY_MS = 24 * 3600 * 1000;
const BASE_SYSTEM_ESTIMATE = 12800;

const MODEL_API_PRICING_PER_1M = [
  { match: 'flash', uncached: 0.30, cacheRead: 0.03, output: 2.50 },
  { match: 'opus', uncached: 5.00, cacheRead: 0.50, output: 25.00 },
  { match: 'sonnet', uncached: 3.00, cacheRead: 0.30, output: 15.00 },
  { match: 'hydrogen', uncached: 1.50, cacheRead: 0.15, output: 12.00 },
  { match: 'argon', uncached: 1.25, cacheRead: 0.125, output: 10.00 },
];

export function estimateModelCostUsd(modelId, uncachedInput, cacheRead, output) {
  const lower = String(modelId || '').toLowerCase();
  let rates = { uncached: 1.25, cacheRead: 0.125, output: 10.0 };
  for (const entry of MODEL_API_PRICING_PER_1M) {
    if (lower.includes(entry.match)) {
      rates = entry;
      break;
    }
  }
  const cost =
    (Math.max(0, uncachedInput) * rates.uncached +
      Math.max(0, cacheRead) * rates.cacheRead +
      Math.max(0, output) * rates.output) /
    1_000_000;
  return Number(cost.toFixed(4));
}

export function estimateTokensFromText(text) {
  return estimateTokens(text);
}

function extractModelVersion(modelStr) {
  const cleaned = String(modelStr || '')
    .toLowerCase()
    .replace(/(?:^|[-_\s/])20\d{6}(?=$|[-_\s/])/g, ' ')
    .replace(/(?:^|[-_\s/])\d+(?:k|m|b)(?=$|[-_\s/])/g, ' ');
  const m = cleaned.match(/(?:^|[-_\s/])(\d+)(?:[.-](\d{1,2}))?(?=$|[-_\s/])/);
  if (!m) return null;
  const major = Number(m[1]);
  const hasMinor = m[2] !== undefined;
  const minor = hasMinor ? Number(m[2]) : 0;
  if (!Number.isFinite(major)) return null;
  return { major, minor, hasMinor };
}

function hasExplicitAbMarker(modelStr) {
  return /(?:^|[-_\s/])(exp|experiment|control|trial|canary|shadow|ab)(?=$|[-_\s/])/i.test(
    String(modelStr || '')
  );
}

function modelFamilyAndRank(modelStr, tierStr = '') {
  const s = `${modelStr || ''} ${tierStr || ''}`
    .toLowerCase()
    .replace(/[()[\]]/g, ' ');
  let family = 'other';
  if (s.includes('hydrogen')) family = 'hydrogen';
  else if (s.includes('neon')) family = 'neon';
  else if (s.includes('argon')) family = 'argon';
  else if (s.includes('flash')) family = 'flash';
  else if (s.includes('opus')) family = 'opus';
  else if (s.includes('sonnet')) family = 'sonnet';
  else if (s.includes('haiku')) family = 'haiku';
  else if (s.includes('carbon')) family = 'carbon';
  else if (/\bultra\b/.test(s)) family = 'ultra';
  else if (/\bpro\b/.test(s)) family = 'pro';
  else if (/\bgpt\b/.test(s)) family = 'gpt';

  let rank = 2;
  let hasTier = false;
  if (/(?:^|[-_\s/])(xhigh|extra|max)(?=$|[-_\s/])/.test(s) || s.includes('xhigh')) {
    rank = 4;
    hasTier = true;
  } else if (/(?:^|[-_\s/])high(?=$|[-_\s/])/.test(s)) {
    rank = 3;
    hasTier = true;
  } else if (/(?:^|[-_\s/])(medium|med)(?=$|[-_\s/])/.test(s)) {
    rank = 2;
    hasTier = true;
  } else if (/(?:^|[-_\s/])(low|lite)(?=$|[-_\s/])/.test(s)) {
    rank = 1;
    hasTier = true;
  }

  return { family, rank, hasTier };
}

export function classifyUpstreamModelStatus(expectedDefaultModel, upstreamModelId) {
  if (!upstreamModelId) return 'unreported';
  const expectedId = expectedDefaultModel?.id;
  if (!expectedId) return 'no_baseline';

  const normExp = String(expectedId).trim().toLowerCase();
  const normAct = String(upstreamModelId).trim().toLowerCase();
  if (normExp && normExp === normAct) {
    return 'match';
  }

  // Only treat explicit tier keywords present in the model ID itself (or an explicit sub-tier suffix)
  // so models like claude-opus-4-6 with synthesized catalog tier='high' never falsely flag downgrade.
  const expIdInfo = modelFamilyAndRank(expectedId, '');
  const expTierOnly = !expIdInfo.hasTier && expectedDefaultModel?.tier
    ? (/(?:^|[-_])(?:opus|ultra)(?:$|[-_])/i.test(expectedId) ? '' : expectedDefaultModel.tier)
    : '';
  const exp = modelFamilyAndRank(expectedId, expTierOnly);
  const act = modelFamilyAndRank(upstreamModelId, '');

  const familyOrder = {
    haiku: 1,
    flash: 1,
    argon: 2,
    carbon: 2,
    other: 2,
    sonnet: 3,
    pro: 3,
    gpt: 3,
    hydrogen: 4,
    neon: 4,
    ultra: 5,
    opus: 5,
  };
  if (exp.family !== act.family) {
    if ((familyOrder[act.family] ?? 2) < (familyOrder[exp.family] ?? 2)) {
      return 'downgrade_suspected';
    }
    return 'ab_or_alias';
  }

  // Same family: check version downgrade/upgrade first (e.g. 2.5-flash < 3.8-flash)
  const expVer = extractModelVersion(normExp);
  const actVer = extractModelVersion(normAct);
  if (expVer && actVer) {
    if (
      actVer.major < expVer.major ||
      (actVer.major === expVer.major && expVer.hasMinor && actVer.hasMinor && actVer.minor < expVer.minor)
    ) {
      return 'downgrade_suspected';
    }
    if (
      actVer.major > expVer.major ||
      (actVer.major === expVer.major && expVer.hasMinor && actVer.hasMinor && actVer.minor > expVer.minor)
    ) {
      return 'ab_or_alias';
    }
  }

  // Upstream responseModel (e.g. gemini-3.8-flash-n, gemini-4-neon, gemini-4-hydrogen) normally omits
  // request effort tiers (low/medium/high/xhigh). Only compare tier ranks when BOTH sides explicitly carry a tier.
  if (exp.hasTier && act.hasTier) {
    if (act.rank < exp.rank) return 'downgrade_suspected';
    if (act.rank > exp.rank) return 'ab_or_alias';
  }

  // Explicit A/B experiment / control / trial suffixes on upstream responseModel (e.g. -exp-a, -control, -trial)
  if (hasExplicitAbMarker(normAct) && !hasExplicitAbMarker(normExp)) {
    return 'ab_or_alias';
  }

  return 'match';
}

function openReadOnlyCacheDb(cacheDbPath) {
  if (!cacheDbPath || !fs.existsSync(cacheDbPath)) return null;
  try {
    return new DatabaseSync(cacheDbPath, { readOnly: true, timeout: 1500 });
  } catch {
    return null;
  }
}

const rulesTokenCache = new Map();

async function readRulesAddonTokens(paths) {
  const candidates = [paths?.rulesFile, paths?.agentsMdPath].filter(Boolean);
  for (const fp of candidates) {
    try {
      const st = await fsp.stat(fp);
      const cached = rulesTokenCache.get(fp);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return cached.tokens;
      }
      const content = await fsp.readFile(fp, 'utf8');
      const tokens = estimateTokensFromText(content);
      if (rulesTokenCache.size > 16) rulesTokenCache.clear();
      rulesTokenCache.set(fp, { mtimeMs: st.mtimeMs, size: st.size, tokens });
      return tokens;
    } catch {
      // Missing optional rules file
    }
  }
  return 0;
}

function getRangeStartMs(range, nowMs) {
  if (range === 'today') {
    const d = new Date(nowMs);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  if (range === '7d') return nowMs - 7 * DAY_MS;
  return nowMs - 30 * DAY_MS;
}

/**
 * Queries real telemetry snapshot from telemetry_cache.db + user storage.
 */
export async function queryTelemetrySnapshot(cacheDbPath, storage, paths, opts = {}) {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const prefs = (await storage?.getPrefs?.()) || {};
  const rulesAddonTokens = await readRulesAddonTokens(paths);

  const scope = opts.scope === 'current' ? 'current' : 'global';
  const range = ['today', '7d', '30d'].includes(opts.range) ? opts.range : '30d';
  const windowCap = Number(opts.windowCap) || Number(prefs.windowCap) || 512000;
  const requestedConvId = opts.convId ? String(opts.convId).trim() : '';
  const isExplicitConvId =
    opts.isExplicitConvId !== undefined
      ? Boolean(opts.isExplicitConvId)
      : Boolean(requestedConvId);
  const topLevelConvIds = Array.isArray(opts.topLevelConvIds)
    ? [...new Set(opts.topLevelConvIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : null;

  const db = openReadOnlyCacheDb(cacheDbPath);
  try {
    let scanEtag = 'empty';
    let targetConvId = requestedConvId;
    let targetRow = null;
    let availableModelsFromLogs = [];
    let tokenModels = [];
    let latestSpeedRow = null;
    let latestModelRow = null;

    if (db) {
      try {
        const metaRow = db.prepare(`SELECT value FROM scan_meta WHERE key = 'etag'`).get();
        if (metaRow?.value) scanEtag = metaRow.value;

        if (targetConvId) {
          targetRow = db
            .prepare(`SELECT * FROM conv_latest_metrics WHERE conv_id = ?`)
            .get(targetConvId);
        } else if (!isExplicitConvId) {
          // Follow Latest fallback: strictly filter to top-level conversations when catalog is provided
          // so background subagent / swarm sessions never hijack the main context panel.
          if (topLevelConvIds !== null) {
            if (topLevelConvIds.length > 0) {
              const placeholders = topLevelConvIds.map(() => '?').join(', ');
              targetRow = db
                .prepare(
                  `SELECT * FROM conv_latest_metrics
                   WHERE conv_id IN (${placeholders})
                   ORDER BY last_step_at_ms DESC
                   LIMIT 1`
                )
                .get(...topLevelConvIds);
            }
          } else {
            targetRow = db
              .prepare(`SELECT * FROM conv_latest_metrics ORDER BY last_step_at_ms DESC LIMIT 1`)
              .get();
          }
          if (targetRow) {
            targetConvId = targetRow.conv_id;
          }
        }

        const latestCols = new Set(
          db
            .prepare(`PRAGMA table_info(conv_latest_metrics)`)
            .all()
            .map((c) => String(c.name || '').toLowerCase())
        );
        const hasUpstreamModelCols = latestCols.has('latest_upstream_model');
        const latestModelSelect = hasUpstreamModelCols
          ? `latest_model, latest_upstream_model, latest_requested_model, latest_requested_label`
          : `latest_model, NULL AS latest_upstream_model, NULL AS latest_requested_model, NULL AS latest_requested_label`;
        const latestModelWhere = hasUpstreamModelCols
          ? `((latest_upstream_model IS NOT NULL AND TRIM(latest_upstream_model) != '') OR (latest_model IS NOT NULL AND TRIM(latest_model) != ''))`
          : `(latest_model IS NOT NULL AND TRIM(latest_model) != '')`;

        if (topLevelConvIds !== null && topLevelConvIds.length > 0) {
          const placeholders = topLevelConvIds.map(() => '?').join(', ');
          latestSpeedRow = db
            .prepare(
              `SELECT latest_speed_tok_s, avg_speed_tok_s, speed_source
               FROM conv_latest_metrics
               WHERE latest_speed_tok_s IS NOT NULL AND conv_id IN (${placeholders})
               ORDER BY speed_at_ms DESC
               LIMIT 1`
            )
            .get(...topLevelConvIds);

          latestModelRow = db
            .prepare(
              `SELECT ${latestModelSelect}
               FROM conv_latest_metrics
               WHERE ${latestModelWhere} AND conv_id IN (${placeholders})
               ORDER BY latest_model_at_ms DESC
               LIMIT 1`
            )
            .get(...topLevelConvIds);
        } else if (topLevelConvIds === null) {
          latestSpeedRow = db
            .prepare(
              `SELECT latest_speed_tok_s, avg_speed_tok_s, speed_source
               FROM conv_latest_metrics
               WHERE latest_speed_tok_s IS NOT NULL
               ORDER BY speed_at_ms DESC
               LIMIT 1`
            )
            .get();

          latestModelRow = db
            .prepare(
              `SELECT ${latestModelSelect}
               FROM conv_latest_metrics
               WHERE ${latestModelWhere}
               ORDER BY latest_model_at_ms DESC
               LIMIT 1`
            )
            .get();
        }

        availableModelsFromLogs = db
          .prepare(
            `SELECT TRIM(model) AS model, MAX(created_at_ms) AS lastSeen, COUNT(*) AS calls
             FROM step_ledger
             WHERE model IS NOT NULL AND TRIM(model) != ''
             GROUP BY TRIM(model)
             ORDER BY lastSeen DESC`
          )
          .all()
          .map((r) => ({ id: r.model, calls: r.calls, lastSeenMs: r.lastSeen }));

        const sinceMs = getRangeStartMs(range, nowMs);
        const usageSql =
          scope === 'current' && targetConvId
            ? `SELECT COALESCE(NULLIF(TRIM(model), ''), '__unrecorded__') AS modelKey,
                      SUM(input_tokens) AS uncachedInput,
                      SUM(cache_read_tokens) AS cacheRead,
                      SUM(output_tokens) AS output
               FROM step_ledger
               WHERE step_type = 'PLANNER_RESPONSE'
                 AND conv_id = ?
                 AND created_at_ms >= ?
               GROUP BY modelKey`
            : `SELECT COALESCE(NULLIF(TRIM(model), ''), '__unrecorded__') AS modelKey,
                      SUM(input_tokens) AS uncachedInput,
                      SUM(cache_read_tokens) AS cacheRead,
                      SUM(output_tokens) AS output
               FROM step_ledger
               WHERE step_type = 'PLANNER_RESPONSE'
                 AND created_at_ms >= ?
               GROUP BY modelKey`;

        const usageRows =
          scope === 'current' && targetConvId
            ? db.prepare(usageSql).all(targetConvId, sinceMs)
            : db.prepare(usageSql).all(sinceMs);

        tokenModels = usageRows
          .map((r) => {
            const modelName = r.modelKey;
            const isUnrecorded = modelName === '__unrecorded__';
            const uncachedInput = Number(r.uncachedInput || 0);
            const cacheRead = Number(r.cacheRead || 0);
            const output = Number(r.output || 0);
            const totalTokens = uncachedInput + cacheRead + output;
            const totalIn = uncachedInput + cacheRead;
            const cacheHitPct = totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : 0;
            const estimatedCostUsd = isUnrecorded
              ? null
              : estimateModelCostUsd(modelName, uncachedInput, cacheRead, output);
            return {
              model: modelName,
              totalTokens,
              estimatedCostUsd,
              isUnpriced: isUnrecorded,
              uncachedInput,
              cacheRead,
              output,
              cacheHitPct,
            };
          })
          .sort((a, b) => b.totalTokens - a.totalTokens);
      } catch {
        // Transient SQLITE_BUSY or schema initialization race: degrade gracefully to empty telemetry
      }
    }

    // Build honest context pie segments preserving totalUsed exactness
    const totalUsed = targetRow ? Number(targetRow.latest_context_tokens || 0) : 0;
    let segments;
    if (totalUsed <= 0) {
      segments = {
        systemBase: 0,
        rulesAddon: 0,
        userHistory: 0,
        toolsAndOutputs: 0,
        remaining: windowCap,
      };
    } else {
      const systemBase = Math.min(totalUsed, BASE_SYSTEM_ESTIMATE);
      const afterBase = totalUsed - systemBase;
      const rulesAddon = Math.min(afterBase, rulesAddonTokens);
      const rest = Math.max(0, afterBase - rulesAddon);

      const uChars = Number(targetRow?.user_chars_total || 0);
      const tChars = Number(targetRow?.tool_chars_total || 0);
      const totalChars = uChars + tChars;
      const userShare = totalChars > 0 ? uChars / totalChars : 0.42;
      const userHistory = Math.round(rest * userShare);
      const toolsAndOutputs = Math.max(0, rest - userHistory);
      const remaining = Math.max(0, windowCap - totalUsed);

      segments = {
        systemBase,
        rulesAddon,
        userHistory,
        toolsAndOutputs,
        remaining,
      };
    }

    const grandTotalTokens = tokenModels.reduce((acc, m) => acc + m.totalTokens, 0);
    const grandCostUsd = tokenModels.reduce(
      (acc, m) => acc + (!m.isUnpriced && typeof m.estimatedCostUsd === 'number' ? m.estimatedCostUsd : 0),
      0
    );
    for (const m of tokenModels) {
      m.sharePct =
        grandTotalTokens > 0
          ? Number(((m.totalTokens / grandTotalTokens) * 100).toFixed(1))
          : 0;
    }

    const activeRow = targetRow || {};
    const hasSelectedConv = Boolean(targetConvId);
    const isEmptySelectedConv = Boolean(targetConvId && !targetRow);
    const rowIn = Number(activeRow.latest_uncached_input || 0);
    const rowCache = Number(activeRow.latest_cache_read || 0);
    const rowTotalIn = rowIn + rowCache;
    const globalTodayHit =
      tokenModels.length > 0 ? tokenModels[0].cacheHitPct : 0;
    const cacheHitPct = isEmptySelectedConv
      ? 0
      : rowTotalIn > 0
        ? Math.round((rowCache / rowTotalIn) * 100)
        : hasSelectedConv
          ? 0
          : globalTodayHit;

    // Never borrow another conversation's model or speed when a specific conversation is active.
    // Prefer authoritative upstream `responseModel` (`gen_metadata.#1.#19`) over transcript's requested slug.
    const modelSourceRow = isEmptySelectedConv
      ? null
      : activeRow.latest_upstream_model || activeRow.latest_model
        ? activeRow
        : hasSelectedConv
          ? null
          : latestModelRow || null;
    const rawUpstreamFromGen =
      typeof modelSourceRow?.latest_upstream_model === 'string' && modelSourceRow.latest_upstream_model.trim()
        ? modelSourceRow.latest_upstream_model.trim()
        : null;
    const rawTranscriptModel =
      typeof modelSourceRow?.latest_model === 'string' && modelSourceRow.latest_model.trim()
        ? modelSourceRow.latest_model.trim()
        : null;
    const requestedModelId = rawUpstreamFromGen
      ? (typeof modelSourceRow?.latest_requested_model === 'string' && modelSourceRow.latest_requested_model.trim()
          ? modelSourceRow.latest_requested_model.trim()
          : rawTranscriptModel)
      : null;
    const requestedModelLabel =
      typeof modelSourceRow?.latest_requested_label === 'string' && modelSourceRow.latest_requested_label.trim()
        ? modelSourceRow.latest_requested_label.trim()
        : null;

    const upstreamModelId = isEmptySelectedConv
      ? null
      : rawUpstreamFromGen || rawTranscriptModel || null;
    const upstreamModelSource = !upstreamModelId
      ? null
      : rawUpstreamFromGen
        ? 'conv_db_gen_metadata'
        : 'transcript_log';

    // When we have the exact step's requested model alongside upstream responseModel from conv DB,
    // compare against THAT step's actual requested model (never a stale plugin defaultModel preference).
    const comparisonBaseline =
      rawUpstreamFromGen && (requestedModelId || requestedModelLabel)
        ? { id: requestedModelId || requestedModelLabel, label: requestedModelLabel || undefined }
        : prefs.defaultModel;
    const upstreamModelStatus = classifyUpstreamModelStatus(
      comparisonBaseline,
      upstreamModelId
    );

    const etagSeed = `${scanEtag}|${targetConvId}|${isExplicitConvId ? 1 : 0}|${scope}|${range}|${windowCap}|${rulesAddonTokens}|${prefs.activePromptId || ''}|${prefs.defaultModel?.id || ''}|${upstreamModelId || ''}|${upstreamModelStatus}`;
    const etag = crypto.createHash('sha1').update(etagSeed).digest('hex').slice(0, 12);

    return {
      etag,
      activeConvId: targetConvId,
      contextPie: {
        conversationId: targetConvId,
        windowCap,
        totalUsed,
        percent: windowCap > 0 ? Math.round((totalUsed / windowCap) * 100) : 0,
        segments,
        configuredRulesTokens: rulesAddonTokens,
        isRulesEstimated: true,
      },
      tokenUsage: {
        scope,
        range,
        totalTokens: grandTotalTokens,
        estimatedApiRefCostUsd: Number(grandCostUsd.toFixed(2)),
        models: tokenModels,
      },
      runtimeTelemetry: {
        latestTokPerSec: isEmptySelectedConv
          ? null
          : activeRow.latest_speed_tok_s ?? (hasSelectedConv ? null : latestSpeedRow?.latest_speed_tok_s ?? null),
        avgTokPerSec: isEmptySelectedConv
          ? null
          : activeRow.avg_speed_tok_s ?? (hasSelectedConv ? null : latestSpeedRow?.avg_speed_tok_s ?? null),
        speedSource: isEmptySelectedConv
          ? null
          : activeRow.speed_source ?? (hasSelectedConv ? null : latestSpeedRow?.speed_source ?? null),
        upstreamModelId,
        upstreamModelStatus,
        upstreamModelSource,
        requestedModelId,
        requestedModelLabel,
        cacheHitPct,
      },
      availableModelsFromLogs,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close error
      }
    }
  }
}

/**
 * Batch-query lightweight context ring metrics for up to 16 recent top-level conversations
 * so multi-window Antigravity hosts can display independent per-window HUD rings.
 */
export function queryBatchConvHudMetrics(cacheDbPath, sessions = [], windowCap = 512000) {
  if (!Array.isArray(sessions) || sessions.length === 0) return [];
  const cap = Number(windowCap) || 512000;
  const top = sessions.filter((s) => s && s.id).slice(0, 16);
  if (top.length === 0) return [];

  const db = openReadOnlyCacheDb(cacheDbPath);
  const byId = new Map();
  if (db) {
    try {
      const latestCols = new Set(
        db
          .prepare(`PRAGMA table_info(conv_latest_metrics)`)
          .all()
          .map((c) => String(c.name || '').toLowerCase())
      );
      const upstreamSelect = latestCols.has('latest_upstream_model')
        ? 'latest_upstream_model'
        : 'NULL AS latest_upstream_model';
      const ids = top.map((s) => String(s.id));
      const placeholders = ids.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT conv_id, latest_model, ${upstreamSelect}, latest_context_tokens, latest_speed_tok_s,
                  latest_uncached_input, latest_cache_read
           FROM conv_latest_metrics
           WHERE conv_id IN (${placeholders})`,
        )
        .all(...ids);
      for (const r of rows) {
        if (r && r.conv_id) byId.set(String(r.conv_id), r);
      }
    } catch {
      // Non-fatal SQLite read error
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }

  return top.map((s) => {
    const row = byId.get(String(s.id));
    const used = Math.max(0, Math.round(Number(row?.latest_context_tokens || 0)));
    const percent = cap > 0 ? Math.max(0, Math.round((used / cap) * 100)) : 0;
    const rawSpeed = Number(row?.latest_speed_tok_s);
    const tokPerSec = Number.isFinite(rawSpeed) && rawSpeed > 0 ? Math.round(rawSpeed * 10) / 10 : null;
    const uncachedIn = Number(row?.latest_uncached_input || 0);
    const cacheRead = Number(row?.latest_cache_read || 0);
    const totalIn = uncachedIn + cacheRead;
    const cacheHitPct = totalIn > 0 ? Math.max(0, Math.min(100, Math.round((cacheRead / totalIn) * 100))) : null;
    return {
      id: String(s.id),
      title: String(s.title || '').trim(),
      workspace: String(s.workspace || '').trim(),
      percent,
      totalUsed: used,
      windowCap: cap,
      tokPerSec,
      cacheHitPct,
      upstreamModelId:
        (typeof row?.latest_upstream_model === 'string' && row.latest_upstream_model.trim()) ||
        (typeof row?.latest_model === 'string' ? row.latest_model.trim() : ''),
    };
  });
}

function classifyRequestStatus(stepType, rawStatus, errorText) {
  const upper = typeof rawStatus === 'string' ? rawStatus.trim().toUpperCase() : '';
  const err = typeof errorText === 'string' ? errorText.trim() : '';
  if (stepType === 'ERROR_MESSAGE' || upper === 'ERROR') {
    if (/stream\s+was\s+interrupted/i.test(err)) {
      return { status: 'error', statusLabel: '流中断' };
    }
    if (/\battempt\s+\d+/i.test(err)) {
      return { status: 'error', statusLabel: '重试失败' };
    }
    return { status: 'error', statusLabel: '失败' };
  }
  if (upper === 'RUNNING') {
    return { status: 'running', statusLabel: '进行中' };
  }
  return { status: 'ok', statusLabel: '成功' };
}

/**
 * Query paginated per-request LLM call records from telemetry_cache.db (step_ledger).
 * Strictly honest: TTFT (ttftMs) is returned as null unless exposed by host logs.
 */
export function queryRequestLogs(cacheDbPath, opts = {}) {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const scope = opts.scope === 'global' ? 'global' : 'current';
  const range = ['today', '7d', '30d'].includes(opts.range) ? opts.range : 'today';
  const convId = typeof opts.convId === 'string' ? opts.convId.trim() : '';
  const modelFilter = typeof opts.model === 'string' ? opts.model.trim() : '';
  const statusFilter = ['all', 'ok', 'error'].includes(opts.status) ? opts.status : 'all';
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(opts.limit) || 80)));
  const offset = Math.max(0, Math.trunc(Number(opts.offset) || 0));
  const convTitleMap = opts.convTitleMap instanceof Map ? opts.convTitleMap : null;

  const emptySummary = {
    totalCount: 0,
    okCount: 0,
    errorCount: 0,
    totalInput: 0,
    uncachedInput: 0,
    cacheRead: 0,
    totalOutput: 0,
    avgCacheHitPct: null,
    estimatedCostUsd: 0,
    hasUnpriced: false,
    avgTokPerSec: null,
  };

  if (scope === 'current' && (!convId || convId === '__new_conversation__')) {
    return {
      ok: true,
      scope,
      range,
      convId,
      model: modelFilter,
      status: statusFilter,
      limit,
      offset,
      totalCount: 0,
      hasMore: false,
      summary: emptySummary,
      models: [],
      items: [],
    };
  }

  const db = openReadOnlyCacheDb(cacheDbPath);
  if (!db) {
    return {
      ok: true,
      scope,
      range,
      convId,
      model: modelFilter,
      status: statusFilter,
      limit,
      offset,
      totalCount: 0,
      hasMore: false,
      summary: emptySummary,
      models: [],
      items: [],
    };
  }

  try {
    const cols = new Set(
      db
        .prepare(`PRAGMA table_info(step_ledger)`)
        .all()
        .map((c) => String(c.name || '').toLowerCase())
    );
    const hasStatus = cols.has('status');
    const hasErrorText = cols.has('error_text');
    const hasTtft = cols.has('ttft_ms');
    const hasUpstreamModel = cols.has('upstream_model');
    const hasRequestedLabel = cols.has('requested_model_label');

    const statusSelect = hasStatus ? 'status' : 'NULL AS status';
    const errorSelect = hasErrorText ? 'error_text' : 'NULL AS error_text';
    const ttftSelect = hasTtft ? 'ttft_ms' : 'NULL AS ttft_ms';
    const upstreamSelect = hasUpstreamModel ? 'upstream_model' : 'NULL AS upstream_model';
    const requestedLabelSelect = hasRequestedLabel
      ? 'requested_model_label'
      : 'NULL AS requested_model_label';
    const isErrorExpr = hasStatus
      ? `(step_type = 'ERROR_MESSAGE' OR UPPER(COALESCE(status, '')) = 'ERROR')`
      : `(step_type = 'ERROR_MESSAGE')`;

    const sinceMs = getRangeStartMs(range, nowMs);

    // 1. Available models in scope + range (independent of model/status filter so dropdown stays complete)
    const scopeWhere = [`step_type IN ('PLANNER_RESPONSE', 'ERROR_MESSAGE')`, `created_at_ms >= ?`];
    const scopeParams = [sinceMs];
    if (scope === 'current') {
      scopeWhere.push(`conv_id = ?`);
      scopeParams.push(convId);
    }
    const modelsSql = `
      SELECT CASE
               WHEN TRIM(COALESCE(model, '')) != '' THEN TRIM(model)
               WHEN step_type = 'PLANNER_RESPONSE' THEN '__unrecorded__'
               ELSE ''
             END AS modelKey,
             COUNT(*) AS calls
      FROM step_ledger
      WHERE ${scopeWhere.join(' AND ')}
      GROUP BY modelKey
      ORDER BY calls DESC
    `;
    const models = db
      .prepare(modelsSql)
      .all(...scopeParams)
      .filter((r) => Boolean(r.modelKey))
      .map((r) => ({ id: String(r.modelKey), calls: Number(r.calls || 0) }));

    // 2. Filtered predicates
    const whereParts = [...scopeWhere];
    const params = [...scopeParams];

    if (statusFilter === 'ok') {
      whereParts.push(`step_type = 'PLANNER_RESPONSE' AND NOT ${isErrorExpr}`);
    } else if (statusFilter === 'error') {
      whereParts.push(isErrorExpr);
    }

    if (modelFilter) {
      if (modelFilter === '__unrecorded__') {
        whereParts.push(`(model IS NULL OR TRIM(model) = '') AND step_type = 'PLANNER_RESPONSE'`);
      } else {
        whereParts.push(`TRIM(COALESCE(model, '')) = ?`);
        params.push(modelFilter);
      }
    }

    const whereSql = whereParts.join(' AND ');

    // 3. Aggregate summary across all matching rows
    const aggRow = db
      .prepare(
        `SELECT COUNT(*) AS totalCount,
                SUM(CASE WHEN ${isErrorExpr} THEN 1 ELSE 0 END) AS errorCount,
                COALESCE(SUM(input_tokens), 0) AS sumUncachedIn,
                COALESCE(SUM(cache_read_tokens), 0) AS sumCacheRead,
                COALESCE(SUM(output_tokens), 0) AS sumOutput,
                COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 500 AND output_tokens > 0 THEN output_tokens ELSE 0 END), 0) AS speedOutSum,
                COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 500 AND output_tokens > 0 THEN duration_ms ELSE 0 END), 0) AS speedDurMsSum
         FROM step_ledger
         WHERE ${whereSql}`
      )
      .get(...params);

    const costRows = db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(model), ''), '__unrecorded__') AS modelKey,
                step_type,
                COALESCE(SUM(input_tokens), 0) AS sumUncachedIn,
                COALESCE(SUM(cache_read_tokens), 0) AS sumCacheRead,
                COALESCE(SUM(output_tokens), 0) AS sumOutput
         FROM step_ledger
         WHERE ${whereSql}
         GROUP BY modelKey, step_type`
      )
      .all(...params);

    let estimatedCostUsd = 0;
    let hasUnpriced = false;
    for (const cr of costRows) {
      const mKey = String(cr.modelKey || '');
      const uIn = Number(cr.sumUncachedIn || 0);
      const cRead = Number(cr.sumCacheRead || 0);
      const out = Number(cr.sumOutput || 0);
      if (uIn === 0 && cRead === 0 && out === 0) continue;
      if (!mKey || mKey === '__unrecorded__') {
        hasUnpriced = true;
      } else {
        estimatedCostUsd += estimateModelCostUsd(mKey, uIn, cRead, out);
      }
    }

    const totalCount = Number(aggRow?.totalCount || 0);
    const errorCount = Number(aggRow?.errorCount || 0);
    const okCount = Math.max(0, totalCount - errorCount);
    const uncachedInput = Number(aggRow?.sumUncachedIn || 0);
    const cacheRead = Number(aggRow?.sumCacheRead || 0);
    const totalInput = uncachedInput + cacheRead;
    const totalOutput = Number(aggRow?.sumOutput || 0);
    const avgCacheHitPct = totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : null;
    const speedOutSum = Number(aggRow?.speedOutSum || 0);
    const speedDurMsSum = Number(aggRow?.speedDurMsSum || 0);
    const avgTokPerSec =
      speedDurMsSum > 0 && speedOutSum > 0
        ? Number((speedOutSum / (speedDurMsSum / 1000)).toFixed(1))
        : null;

    // 4. Paginated per-request rows
    const pageRows = db
      .prepare(
        `SELECT conv_id, step_index, step_type, created_at_ms, model,
                ${upstreamSelect}, ${requestedLabelSelect},
                input_tokens, cache_read_tokens, output_tokens, tool_calls_count,
                duration_ms, ${statusSelect}, ${errorSelect}, ${ttftSelect}
         FROM step_ledger
         WHERE ${whereSql}
         ORDER BY created_at_ms DESC, step_index DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    const items = pageRows.map((r) => {
      const rawModel = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : '';
      const rawUpstream =
        typeof r.upstream_model === 'string' && r.upstream_model.trim() ? r.upstream_model.trim() : '';
      const rawReqLabel =
        typeof r.requested_model_label === 'string' && r.requested_model_label.trim()
          ? r.requested_model_label.trim()
          : '';
      const isPlanner = r.step_type === 'PLANNER_RESPONSE';
      const modelDisplayKey = rawModel || (isPlanner ? '__unrecorded__' : '');
      const uIn = Math.max(0, Number(r.input_tokens || 0));
      const cRead = Math.max(0, Number(r.cache_read_tokens || 0));
      const totalIn = uIn + cRead;
      const out = Math.max(0, Number(r.output_tokens || 0));
      const cacheHitPct = totalIn > 0 ? Math.round((cRead / totalIn) * 100) : null;

      const rawDur = Number(r.duration_ms);
      const durationMs = Number.isFinite(rawDur) && rawDur > 0 ? Math.trunc(rawDur) : null;
      const rawTtft = Number(r.ttft_ms);
      const ttftMs = Number.isFinite(rawTtft) && rawTtft > 0 ? Math.trunc(rawTtft) : null;
      const tokPerSec =
        durationMs && durationMs >= 500 && out > 0
          ? Number((out / (durationMs / 1000)).toFixed(1))
          : null;

      const errText = typeof r.error_text === 'string' ? r.error_text.trim() : '';
      const { status: rowStatus, statusLabel } = classifyRequestStatus(
        r.step_type,
        r.status,
        errText
      );

      let costUsd = null;
      if (totalIn === 0 && out === 0) {
        costUsd = rowStatus === 'error' ? 0 : null;
      } else if (rawModel) {
        costUsd = estimateModelCostUsd(rawModel, uIn, cRead, out);
      }

      const convMeta = convTitleMap ? convTitleMap.get(String(r.conv_id)) : null;

      return {
        convId: String(r.conv_id || ''),
        convTitle: convMeta?.title || '',
        convWorkspace: convMeta?.workspace || '',
        stepIndex: Number(r.step_index || 0),
        createdAtMs: Number(r.created_at_ms || 0),
        model: modelDisplayKey,
        upstreamModel: rawUpstream || null,
        requestedModelLabel: rawReqLabel || null,
        uncachedInput: uIn,
        cacheRead: cRead,
        totalInput: totalIn,
        output: out,
        cacheHitPct,
        estimatedCostUsd: costUsd,
        ttftMs,
        durationMs,
        tokPerSec,
        status: rowStatus,
        statusLabel,
        errorText: errText,
        toolCallsCount: Number(r.tool_calls_count || 0),
      };
    });

    return {
      ok: true,
      scope,
      range,
      convId,
      model: modelFilter,
      status: statusFilter,
      limit,
      offset,
      totalCount,
      hasMore: offset + items.length < totalCount,
      summary: {
        totalCount,
        okCount,
        errorCount,
        totalInput,
        uncachedInput,
        cacheRead,
        totalOutput,
        avgCacheHitPct,
        estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
        hasUnpriced,
        avgTokPerSec,
      },
      models,
      items,
    };
  } catch {
    return {
      ok: true,
      scope,
      range,
      convId,
      model: modelFilter,
      status: statusFilter,
      limit,
      offset,
      totalCount: 0,
      hasMore: false,
      summary: emptySummary,
      models: [],
      items: [],
    };
  } finally {
    try {
      db.close();
    } catch {
      // Ignore close error
    }
  }
}
