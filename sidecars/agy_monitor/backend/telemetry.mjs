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

function modelFamilyAndRank(modelStr, tierStr = '') {
  const s = `${modelStr || ''} ${tierStr || ''}`.toLowerCase();
  let family = 'other';
  if (s.includes('hydrogen')) family = 'hydrogen';
  else if (s.includes('neon')) family = 'neon';
  else if (s.includes('argon')) family = 'argon';
  else if (s.includes('flash')) family = 'flash';
  else if (s.includes('opus')) family = 'opus';
  else if (s.includes('sonnet')) family = 'sonnet';
  else if (s.includes('carbon')) family = 'carbon';

  let rank = 2;
  let hasTier = false;
  if (s.includes('xhigh') || s.includes('extra') || s.includes('max')) {
    rank = 4;
    hasTier = true;
  } else if (s.includes('high')) {
    rank = 3;
    hasTier = true;
  } else if (s.includes('medium') || s.includes('med')) {
    rank = 2;
    hasTier = true;
  } else if (s.includes('low') || s.includes('lite')) {
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

  const familyOrder = { flash: 1, argon: 2, sonnet: 3, hydrogen: 4, neon: 4, opus: 5, other: 2, carbon: 2 };
  if (exp.family !== act.family) {
    if ((familyOrder[act.family] ?? 2) < (familyOrder[exp.family] ?? 2)) {
      return 'downgrade_suspected';
    }
    return 'ab_or_alias';
  }
  if (!exp.hasTier) return 'match';
  if (act.rank < exp.rank) return 'downgrade_suspected';
  if (act.rank > exp.rank) return 'ab_or_alias';
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

async function readRulesAddonTokens(paths) {
  const candidates = [paths?.rulesFile, paths?.agentsMdPath].filter(Boolean);
  for (const fp of candidates) {
    try {
      const content = await fsp.readFile(fp, 'utf8');
      return estimateTokensFromText(content);
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
              `SELECT latest_model
               FROM conv_latest_metrics
               WHERE latest_model IS NOT NULL AND TRIM(latest_model) != '' AND conv_id IN (${placeholders})
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
              `SELECT latest_model
               FROM conv_latest_metrics
               WHERE latest_model IS NOT NULL AND TRIM(latest_model) != ''
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
        : globalTodayHit;

    const upstreamModelId = isEmptySelectedConv
      ? null
      : activeRow.latest_model || latestModelRow?.latest_model || null;
    const upstreamModelStatus = classifyUpstreamModelStatus(
      prefs.defaultModel,
      upstreamModelId
    );

    const etagSeed = `${scanEtag}|${targetConvId}|${isExplicitConvId ? 1 : 0}|${scope}|${range}|${windowCap}|${rulesAddonTokens}|${prefs.activePromptId || ''}|${prefs.defaultModel?.id || ''}`;
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
          : activeRow.latest_speed_tok_s ?? latestSpeedRow?.latest_speed_tok_s ?? null,
        avgTokPerSec: isEmptySelectedConv
          ? null
          : activeRow.avg_speed_tok_s ?? latestSpeedRow?.avg_speed_tok_s ?? null,
        speedSource: isEmptySelectedConv
          ? null
          : activeRow.speed_source ?? latestSpeedRow?.speed_source ?? null,
        upstreamModelId,
        upstreamModelStatus,
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
