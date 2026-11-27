/**
 * Antigravity official quota reader.
 *
 * Strictly uses official Antigravity channels only (NEVER directly calls
 * remote internal `cloudcode-pa.googleapis.com` APIs):
 * 1. Priority 1 (Zero extra RPC): Passive local snapshot produced by
 *    Antigravity CLI's official `statusLine` callback hook
 *    (`~/.gemini/antigravity-cli/settings.json` -> `statusLine.command`).
 * 2. Priority 2 (Desktop host native loopback): Local Antigravity Language
 *    Server Connect-RPC endpoint
 *    `/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`
 *    using the host-injected loopback address (`ANTIGRAVITY_LS_ADDRESS`) and
 *    CSRF token (`ANTIGRAVITY_CSRF_TOKEN`), with TTL caching and strict
 *    global disable support.
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { atomicWriteJson, atomicWriteText } from './paths.mjs';

const QUOTA_RPC_PATH =
  '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const USER_STATUS_RPC_PATH =
  '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const MAX_RESPONSE_BYTES = 512 * 1024;
const ALLOWED_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEFAULT_STATUSLINE_MAX_AGE_MS = 180_000;
const STATUSLINE_BRIDGE_MARKER = 'agy_statusline_bridge.mjs';

/**
 * Parse and validate `ANTIGRAVITY_LS_ADDRESS` strictly against loopback hosts.
 */
export function parseLsAddress(rawAddress) {
  const raw = typeof rawAddress === 'string' ? rawAddress.trim() : '';
  if (!raw) return null;

  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  const protocol = parsed.protocol === 'https:' ? 'https' : parsed.protocol === 'http:' ? 'http' : '';
  if (!protocol) return null;

  const rawHost = String(parsed.hostname || '').toLowerCase();
  if (!ALLOWED_LOOPBACK_HOSTS.has(rawHost)) {
    return null;
  }
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

  const port = Number(parsed.port || (protocol === 'https' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return { protocol, hostname, port };
}

function clampFraction(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function normalizeBucket(raw, nowMs) {
  if (!raw || typeof raw !== 'object') return null;

  const bucketId = typeof raw.bucketId === 'string'
    ? raw.bucketId.trim()
    : typeof raw.bucket_id === 'string'
      ? raw.bucket_id.trim()
      : '';
  const windowRaw = typeof raw.window === 'string' ? raw.window.trim().toLowerCase() : '';
  const displayName = typeof raw.displayName === 'string'
    ? raw.displayName.trim()
    : typeof raw.display_name === 'string'
      ? raw.display_name.trim()
      : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const disabled = Boolean(raw.disabled);

  const fractionRaw =
    raw.remainingFraction !== undefined
      ? raw.remainingFraction
      : raw.remaining_fraction !== undefined
        ? raw.remaining_fraction
        : null;
  const remainingFraction = clampFraction(fractionRaw);
  const remainingPct = remainingFraction === null ? null : Math.round(remainingFraction * 100);
  const remainingPctExact =
    remainingFraction === null ? null : Math.round(remainingFraction * 1000) / 10;

  const resetTime = typeof raw.resetTime === 'string'
    ? raw.resetTime.trim()
    : typeof raw.reset_time === 'string'
      ? raw.reset_time.trim()
      : '';
  let parsedResetMs = resetTime ? Date.parse(resetTime) : Number.NaN;
  if (!Number.isFinite(parsedResetMs)) {
    const resetInSec = Number(raw.reset_in_seconds ?? raw.resetInSeconds);
    if (Number.isFinite(resetInSec) && resetInSec > 0) {
      parsedResetMs = nowMs + Math.round(resetInSec * 1000);
    }
  }
  const resetTimeMs = Number.isFinite(parsedResetMs) ? parsedResetMs : null;

  let windowKind = 'other';
  const lowerBucketId = bucketId.toLowerCase();
  if (
    windowRaw === '5h' ||
    windowRaw.includes('5h') ||
    windowRaw.includes('5-hour') ||
    windowRaw.includes('five_hour') ||
    lowerBucketId.includes('5h') ||
    lowerBucketId.includes('5-hour') ||
    lowerBucketId.includes('five_hour')
  ) {
    windowKind = '5h';
  } else if (
    windowRaw === 'weekly' ||
    windowRaw.includes('week') ||
    windowRaw === '7d' ||
    lowerBucketId.includes('weekly') ||
    lowerBucketId.includes('week') ||
    lowerBucketId.includes('7d')
  ) {
    windowKind = 'weekly';
  }

  // Official UI omits countdown when remainingFraction is exact 1.0 with no usage description
  const isFull =
    remainingFraction !== null && remainingFraction >= 0.99999 && !description;
  const remainingMs =
    resetTimeMs !== null ? Math.max(0, resetTimeMs - nowMs) : null;

  return {
    bucketId,
    window: windowKind,
    rawWindow: windowRaw || windowKind,
    displayName,
    description,
    disabled,
    remainingFraction,
    remainingPct,
    remainingPctExact,
    resetTime: resetTime || (resetTimeMs ? new Date(resetTimeMs).toISOString() : ''),
    resetTimeMs,
    remainingMs,
    isFull,
  };
}

function classifyQuotaGroup(rawGroup, index) {
  const displayName = typeof rawGroup?.displayName === 'string'
    ? rawGroup.displayName.trim()
    : typeof rawGroup?.display_name === 'string'
      ? rawGroup.display_name.trim()
      : '';
  const lowerName = displayName.toLowerCase();
  const buckets = Array.isArray(rawGroup?.buckets) ? rawGroup.buckets : [];
  const bucketIds = buckets
    .map((b) => String(b?.bucketId || b?.bucket_id || '').toLowerCase())
    .join(' ');

  if (lowerName.includes('argon') || bucketIds.includes('argon')) {
    return { key: 'argon', label: 'Argon', order: 2, deprecated: true };
  }
  if (
    lowerName.includes('claude') ||
    lowerName.includes('gpt') ||
    lowerName.includes('3p') ||
    bucketIds.includes('3p-') ||
    bucketIds.includes('claude') ||
    bucketIds.includes('gpt')
  ) {
    return { key: 'gpt_claude', label: 'GPT&Claude', order: 1 };
  }
  if (lowerName.includes('gemini') || bucketIds.includes('gemini')) {
    return { key: 'gemini', label: 'Gemini', order: 0 };
  }

  const fallbackLabel = displayName ? displayName.slice(0, 16) : `Group ${index + 1}`;
  const fallbackKey =
    lowerName.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `group_${index + 1}`;
  return { key: fallbackKey, label: fallbackLabel, order: 10 + index };
}

/**
 * Normalize raw RetrieveUserQuotaSummaryResponse into compact UI-ready groups.
 */
export function normalizeQuotaSummary(payload, nowMs = Date.now(), { source = 'official_local_ls' } = {}) {
  const root =
    payload && typeof payload === 'object' && payload.response && typeof payload.response === 'object'
      ? payload.response
      : payload && typeof payload === 'object'
        ? payload
        : {};

  const rawGroups = Array.isArray(root.groups) ? root.groups : [];
  const groups = rawGroups
    .map((rawGroup, index) => {
      const meta = classifyQuotaGroup(rawGroup, index);
      if (meta.deprecated) return null;
      const displayName = typeof rawGroup?.displayName === 'string'
        ? rawGroup.displayName.trim()
        : typeof rawGroup?.display_name === 'string'
          ? rawGroup.display_name.trim()
          : meta.label;
      const description = typeof rawGroup?.description === 'string' ? rawGroup.description.trim() : '';
      const rawBuckets = Array.isArray(rawGroup?.buckets) ? rawGroup.buckets : [];
      const normalizedBuckets = rawBuckets
        .map((b) => normalizeBucket(b, nowMs))
        .filter(Boolean);

      const fiveHour = normalizedBuckets.find((b) => b.window === '5h') || null;
      const weekly = normalizedBuckets.find((b) => b.window === 'weekly') || null;

      return {
        key: meta.key,
        label: meta.label,
        order: meta.order,
        displayName,
        description,
        fiveHour,
        weekly,
        buckets: normalizedBuckets,
      };
    })
    .filter(Boolean);

  // Sort consistently: Gemini -> GPT&Claude -> any additional groups
  groups.sort((a, b) => a.order - b.order);

  // Strip internal sort field from public output
  const cleanGroups = groups.map(({ order: _order, ...rest }) => rest);

  return {
    ok: true,
    available: cleanGroups.length > 0,
    stale: false,
    source,
    fetchedAtMs: nowMs,
    description: typeof root.description === 'string' ? root.description.trim() : '',
    groups: cleanGroups,
  };
}

/**
 * Normalize official Antigravity CLI `statusLine` JSON payload into the standard
 * quota summary shape.
 *
 * Official docs schema (`https://antigravity.google/docs/cli/statusline`):
 * `{ quota: { "gemini-5h": { remaining_fraction, reset_time, reset_in_seconds, disabled }, ... }, email, plan_tier }`
 */
export function normalizeStatusLineQuota(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  const quotaMap = payload.quota;
  if (!quotaMap || typeof quotaMap !== 'object' || Array.isArray(quotaMap)) return null;

  const baseNow = Number.isFinite(Number(payload.updatedAtMs)) && Number(payload.updatedAtMs) > 0
    ? Number(payload.updatedAtMs)
    : nowMs;

  const groupedRaw = new Map();
  for (const [bucketId, entry] of Object.entries(quotaMap)) {
    if (!entry || typeof entry !== 'object') continue;
    const idLower = String(bucketId || '').trim().toLowerCase();
    if (!idLower || idLower.includes('argon')) continue;

    let groupKey = '';
    let displayName = '';
    if (idLower.includes('3p') || idLower.includes('claude') || idLower.includes('gpt')) {
      groupKey = 'gpt_claude';
      displayName = 'Claude and GPT models';
    } else if (idLower.includes('gemini')) {
      groupKey = 'gemini';
      displayName = 'Gemini Models';
    } else {
      groupKey = idLower.replace(/-(5h|weekly|7d|daily)$/i, '') || 'other';
      displayName = groupKey;
    }

    if (!groupedRaw.has(groupKey)) {
      groupedRaw.set(groupKey, { displayName, buckets: [] });
    }
    groupedRaw.get(groupKey).buckets.push({
      bucketId,
      remainingFraction: entry.remaining_fraction ?? entry.remainingFraction,
      resetTime: entry.reset_time ?? entry.resetTime ?? '',
      resetInSeconds: entry.reset_in_seconds ?? entry.resetInSeconds,
      disabled: Boolean(entry.disabled),
    });
  }

  if (groupedRaw.size === 0) return null;

  const normalized = normalizeQuotaSummary(
    { groups: [...groupedRaw.values()] },
    baseNow,
    { source: 'official_statusline' },
  );
  if (!normalized.available) return null;

  return {
    ...normalized,
    source: 'official_statusline',
    ...(typeof payload.email === 'string' && payload.email.trim() ? { email: payload.email.trim() } : {}),
    ...(typeof payload.plan_tier === 'string' && payload.plan_tier.trim()
      ? { planTier: payload.plan_tier.trim() }
      : {}),
  };
}

/**
 * Read a fresh official statusLine quota snapshot from disk if available.
 */
export function readStatusLineQuotaFile(
  filePath,
  { maxAgeMs = DEFAULT_STATUSLINE_MAX_AGE_MS, nowMs = Date.now() } = {},
) {
  if (!filePath || typeof filePath !== 'string') return null;
  try {
    if (!fsSync.existsSync(filePath)) return null;
    const stat = fsSync.statSync(filePath);
    if (!stat.isFile() || stat.size <= 2 || stat.size > MAX_RESPONSE_BYTES) return null;
    const raw = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
    const updatedAtMs = Number(raw?.updatedAtMs || stat.mtimeMs || 0);
    const ageMs = updatedAtMs > 0 ? Math.max(0, nowMs - updatedAtMs) : Infinity;
    if (maxAgeMs > 0 && ageMs > maxAgeMs) {
      return null;
    }
    const normalized = normalizeStatusLineQuota({ ...raw, updatedAtMs }, nowMs);
    if (!normalized) return null;
    return {
      ...normalized,
      fetchedAtMs: updatedAtMs || nowMs,
      ageMs,
    };
  } catch {
    return null;
  }
}

/**
 * Build the lightweight official Antigravity CLI `statusLine` bridge script.
 * It reads official stdin JSON piped by `agy`, saves ONLY sanitized quota metadata
 * atomically to `official_statusline_quota.json`, and renders a clean status line.
 */
export function buildStatusLineBridgeScript(outputJsonPath) {
  const safeOutPath = JSON.stringify(path.resolve(outputJsonPath));
  return [
    '#!/usr/bin/env node',
    '// Official Antigravity CLI statusLine bridge for AGY Console (zero extra RPC).',
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    '',
    `const OUT_FILE = ${safeOutPath};`,
    '',
    'function fmtTok(n) {',
    '  const v = Number(n) || 0;',
    "  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;",
    "  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;",
    '  return String(Math.round(v));',
    '}',
    '',
    'function fmtDur(sec) {',
    '  const s = Math.max(0, Math.round(Number(sec) || 0));',
    "  if (s <= 0) return '';",
    '  const d = Math.floor(s / 86400);',
    '  const h = Math.floor((s % 86400) / 3600);',
    '  const m = Math.floor((s % 3600) / 60);',
    "  if (d > 0) return `${d}d ${h}h`;",
    "  if (h > 0) return `${h}h ${m}m`;",
    "  return `${Math.max(1, m)}m`;",
    '}',
    '',
    'let raw = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { raw += c; });',
    'process.stdin.on("end", () => {',
    '  let data = null;',
    '  try { data = JSON.parse(raw); } catch { data = null; }',
    '  if (!data || typeof data !== "object") return;',
    '  if (data.quota && typeof data.quota === "object") {',
    '    try {',
    '      fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });',
    '      const snap = {',
    '        updatedAtMs: Date.now(),',
    '        email: typeof data.email === "string" ? data.email : "",',
    '        plan_tier: typeof data.plan_tier === "string" ? data.plan_tier : "",',
    '        quota: data.quota,',
    '      };',
    '      const tmp = `${OUT_FILE}.tmp.${process.pid}`;',
    '      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2) + "\\n", "utf8");',
    '      fs.renameSync(tmp, OUT_FILE);',
    '    } catch {}',
    '  }',
    '  const cw = data.context_window || {};',
    '  const inTok = Number(cw.total_input_tokens) || 0;',
    '  const outTok = Number(cw.total_output_tokens) || 0;',
    '  const cur = cw.current_usage || {};',
    '  const cacheRead = Number(cur.cache_read_input_tokens) || 0;',
    '  const curIn = Number(cur.input_tokens) || 0;',
    '  const hitPct = curIn + cacheRead > 0 ? Math.round((cacheRead / (curIn + cacheRead)) * 100) : null;',
    '  const parts = [`Tokens: ${fmtTok(inTok)}↑ ${fmtTok(outTok)}↓`];',
    '  if (hitPct !== null) parts.push(`Cache: ${hitPct}%`);',
    '  const q = data.quota && typeof data.quota === "object" ? data.quota : {};',
    '  const b5 = q["gemini-5h"] || q["3p-5h"];',
    '  const bw = q["gemini-weekly"] || q["3p-weekly"];',
    '  if (b5 && typeof b5.remaining_fraction === "number") {',
    '    const r5 = fmtDur(b5.reset_in_seconds);',
    '    parts.push(`5h: ${(b5.remaining_fraction * 100).toFixed(1)}%${r5 ? ` (${r5})` : ""}`);',
    '  }',
    '  if (bw && typeof bw.remaining_fraction === "number") {',
    '    const rw = fmtDur(bw.reset_in_seconds);',
    '    parts.push(`7d: ${(bw.remaining_fraction * 100).toFixed(1)}%${rw ? ` (${rw})` : ""}`);',
    '  }',
    '  process.stdout.write(parts.join(" | "));',
    '});',
    '',
  ].join('\n');
}

/**
 * Inspect whether the official Antigravity CLI `statusLine` bridge is configured
 * and whether a fresh official snapshot is currently available on disk.
 */
export function inspectOfficialStatusLine(paths = {}, nowMs = Date.now()) {
  const settingsFile = paths?.antigravityCliSettingsFile || '';
  const scriptFile = paths?.officialStatusLineScriptFile || '';
  const quotaFile = paths?.officialStatusLineQuotaFile || '';
  const commandStr = scriptFile ? `node "${scriptFile}"` : '';

  let cliDirExists = false;
  let configured = false;
  let configuredByOther = false;
  let existingCommand = '';

  if (settingsFile) {
    try {
      cliDirExists = fsSync.existsSync(path.dirname(settingsFile));
      if (fsSync.existsSync(settingsFile)) {
        const parsed = JSON.parse(fsSync.readFileSync(settingsFile, 'utf8'));
        const sl = parsed?.statusLine;
        if (sl && typeof sl === 'object' && typeof sl.command === 'string' && sl.command.trim()) {
          existingCommand = sl.command.trim();
          const enabled = sl.enabled !== false;
          if (enabled && existingCommand.includes(STATUSLINE_BRIDGE_MARKER)) {
            configured = true;
          } else if (enabled) {
            configuredByOther = true;
          }
        }
      }
    } catch {
      // Ignore malformed settings file
    }
  }

  let lastUpdatedAtMs = 0;
  let fresh = false;
  if (quotaFile && fsSync.existsSync(quotaFile)) {
    try {
      const stat = fsSync.statSync(quotaFile);
      const parsed = JSON.parse(fsSync.readFileSync(quotaFile, 'utf8'));
      lastUpdatedAtMs = Number(parsed?.updatedAtMs || stat.mtimeMs || 0);
      fresh = Boolean(
        readStatusLineQuotaFile(quotaFile, { maxAgeMs: DEFAULT_STATUSLINE_MAX_AGE_MS, nowMs }),
      );
    } catch {
      lastUpdatedAtMs = 0;
      fresh = false;
    }
  }

  return {
    cliDirExists,
    configured,
    configuredByOther,
    existingCommand,
    scriptFile,
    quotaFile,
    settingsFile,
    command: commandStr,
    slashCommand: commandStr ? `/statusline ${commandStr}` : '',
    lastUpdatedAtMs,
    fresh,
  };
}

/**
 * Write the official statusLine bridge script and safely register it in
 * `~/.gemini/antigravity-cli/settings.json` while preserving all existing keys.
 */
export async function installOfficialStatusLineHook(paths = {}) {
  const settingsFile = paths?.antigravityCliSettingsFile || '';
  const scriptFile = paths?.officialStatusLineScriptFile || '';
  const quotaFile = paths?.officialStatusLineQuotaFile || '';
  if (!settingsFile || !scriptFile || !quotaFile) {
    return { ok: false, error: '缺少 statusLine 路径配置' };
  }

  await atomicWriteText(scriptFile, buildStatusLineBridgeScript(quotaFile));

  let settings = {};
  try {
    const raw = await fs.readFile(settingsFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return { ok: false, error: '读取 ~/.gemini/antigravity-cli/settings.json 失败，请检查文件格式' };
    }
  }

  const command = `node "${scriptFile}"`;
  const nextSettings = {
    ...settings,
    statusLine: {
      ...(settings.statusLine && typeof settings.statusLine === 'object' ? settings.statusLine : {}),
      type: 'command',
      command,
      enabled: true,
    },
  };
  await atomicWriteJson(settingsFile, nextSettings);

  return {
    ok: true,
    statusLine: inspectOfficialStatusLine(paths),
  };
}

/**
 * Remove our official statusLine bridge entry from `~/.gemini/antigravity-cli/settings.json`
 * without touching any other CLI configuration.
 */
export async function uninstallOfficialStatusLineHook(paths = {}) {
  const settingsFile = paths?.antigravityCliSettingsFile || '';
  if (!settingsFile) {
    return { ok: false, error: '缺少 CLI settings.json 路径' };
  }

  try {
    const raw = await fs.readFile(settingsFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const cmd = typeof parsed?.statusLine?.command === 'string' ? parsed.statusLine.command : '';
      if (cmd.includes(STATUSLINE_BRIDGE_MARKER)) {
        delete parsed.statusLine;
        await atomicWriteJson(settingsFile, parsed);
      }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return { ok: false, error: '更新 ~/.gemini/antigravity-cli/settings.json 失败' };
    }
  }

  return {
    ok: true,
    statusLine: inspectOfficialStatusLine(paths),
  };
}

/**
 * Extract subscription tier metadata from official local Language Server
 * `GetUserStatus` payload. Prefers `userTier` over `planInfo.planName` because
 * `planInfo.planName` often falls back to generic "Pro" even on Ultra plans.
 */
export function extractTierFromUserStatus(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const userStatus =
    payload.userStatus && typeof payload.userStatus === 'object'
      ? payload.userStatus
      : payload.user_status && typeof payload.user_status === 'object'
        ? payload.user_status
        : payload;
  const userTier =
    userStatus?.userTier && typeof userStatus.userTier === 'object'
      ? userStatus.userTier
      : userStatus?.user_tier && typeof userStatus.user_tier === 'object'
        ? userStatus.user_tier
        : null;
  const planStatus =
    userStatus?.planStatus && typeof userStatus.planStatus === 'object'
      ? userStatus.planStatus
      : userStatus?.plan_status && typeof userStatus.plan_status === 'object'
        ? userStatus.plan_status
        : null;
  const planInfo =
    planStatus?.planInfo && typeof planStatus.planInfo === 'object'
      ? planStatus.planInfo
      : planStatus?.plan_info && typeof planStatus.plan_info === 'object'
        ? planStatus.plan_info
        : null;

  const pickStr = (...vals) => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  const rawTierId = pickStr(userTier?.id, planInfo?.tierId, planInfo?.tier_id, planInfo?.teamsTier, planInfo?.teams_tier);
  const rawTierName = pickStr(
    userTier?.preferredName,
    userTier?.preferred_name,
    userTier?.name,
    userTier?.description,
    planInfo?.planDisplayName,
    planInfo?.plan_display_name,
    planInfo?.planName,
    planInfo?.plan_name,
  );
  const planTier = rawTierName || rawTierId;
  if (!planTier) return null;
  return {
    planTier,
    rawTierId,
    rawTierName: rawTierName || rawTierId,
  };
}

/**
 * Perform a local Connect-RPC HTTP(S) call to Antigravity Language Server.
 */
function callLocalLsConnectRpc({
  address,
  csrfToken,
  rpcPath,
  timeoutMs = 3500,
} = {}) {
  return new Promise((resolve, reject) => {
    const parsed = parseLsAddress(address);
    if (!parsed) {
      const err = new Error('ANTIGRAVITY_LS_ADDRESS 无效或非本机回环地址');
      err.code = 'invalid_address';
      reject(err);
      return;
    }
    const token = typeof csrfToken === 'string' ? csrfToken.trim() : '';
    if (!token) {
      const err = new Error('缺少宿主注入的 ANTIGRAVITY_CSRF_TOKEN');
      err.code = 'missing_token';
      reject(err);
      return;
    }

    const transport = parsed.protocol === 'https' ? https : http;
    const body = '{}';
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: rpcPath,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': token,
      },
    };
    if (parsed.protocol === 'https') {
      reqOptions.rejectUnauthorized = false;
    }

    const req = transport.request(reqOptions, (res) => {
      const chunks = [];
      let totalBytes = 0;

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          const err = new Error('配额接口响应体积超出安全上限');
          err.code = 'response_too_large';
          finish(err);
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        const rawText = Buffer.concat(chunks).toString('utf8');
        let parsedJson = null;
        try {
          parsedJson = rawText ? JSON.parse(rawText) : {};
        } catch {
          parsedJson = null;
        }

        const status = Number(res.statusCode || 0);
        if (status < 200 || status >= 300) {
          const rpcMsg =
            typeof parsedJson?.message === 'string' && parsedJson.message.trim()
              ? parsedJson.message.trim()
              : `HTTP ${status}`;
          const err = new Error(rpcMsg);
          err.status = status;
          err.code =
            typeof parsedJson?.code === 'string' && parsedJson.code.trim()
              ? parsedJson.code.trim()
              : `http_${status}`;
          finish(err);
          return;
        }

        if (!parsedJson || typeof parsedJson !== 'object') {
          const err = new Error('配额接口返回了无效 JSON');
          err.code = 'invalid_json';
          finish(err);
          return;
        }
        finish(null, parsedJson);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const err = new Error('连接本地配额服务超时');
      err.code = 'timeout';
      finish(err);
    });

    req.on('error', (err) => {
      const wrapped = new Error(err?.message || '连接本地配额服务失败');
      wrapped.code = err?.code || 'network_error';
      finish(wrapped);
    });

    req.write(body);
    req.end();
  });
}

export function callRetrieveUserQuotaSummary({
  address,
  csrfToken,
  timeoutMs = 3500,
} = {}) {
  return callLocalLsConnectRpc({
    address,
    csrfToken,
    rpcPath: QUOTA_RPC_PATH,
    timeoutMs,
  });
}

export function callGetUserStatus({
  address,
  csrfToken,
  timeoutMs = 2500,
} = {}) {
  return callLocalLsConnectRpc({
    address,
    csrfToken,
    rpcPath: USER_STATUS_RPC_PATH,
    timeoutMs,
  });
}

/**
 * Create a cached, coalesced official quota reader bound to the current process env
 * and optional official `statusLine` local snapshot file.
 */
export function createQuotaClient({
  paths = null,
  env = process.env,
  ttlMs = 60_000,
  minForceIntervalMs = 5_000,
  statusLineMaxAgeMs = DEFAULT_STATUSLINE_MAX_AGE_MS,
  timeoutMs = 3_500,
  fetcher = callRetrieveUserQuotaSummary,
  userStatusFetcher = undefined,
  isEnabled = null,
  now = () => Date.now(),
} = {}) {
  const effectiveUserStatusFetcher =
    typeof userStatusFetcher === 'function'
      ? userStatusFetcher
      : userStatusFetcher === null
        ? null
        : fetcher === callRetrieveUserQuotaSummary
          ? callGetUserStatus
          : null;
  let cached = null;
  let lastAttemptAtMs = 0;
  let inFlight = null;
  let lastSource = '';

  async function checkEnabled() {
    if (typeof isEnabled !== 'function') return true;
    try {
      return (await isEnabled()) !== false;
    } catch {
      return true;
    }
  }

  async function getQuotaSummary({ force = false } = {}) {
    const currentNow = now();

    if (!(await checkEnabled())) {
      lastSource = 'disabled';
      return {
        ok: false,
        disabled: true,
        available: false,
        stale: false,
        source: 'disabled',
        code: 'quota_disabled',
        error: '已在「其他」页关闭额度查看与查询',
        fetchedAtMs: currentNow,
        groups: [],
      };
    }

    // Priority 1: Passive official Antigravity CLI statusLine snapshot (zero extra RPCs!)
    const slFile = paths?.officialStatusLineQuotaFile || '';
    if (slFile) {
      const slQuota = readStatusLineQuotaFile(slFile, {
        maxAgeMs: statusLineMaxAgeMs,
        nowMs: currentNow,
      });
      if (slQuota && slQuota.available) {
        cached = slQuota;
        lastSource = 'official_statusline';
        return slQuota;
      }
    }

    if (cached) {
      const age = currentNow - cached.fetchedAtMs;
      if (!force && age >= 0 && age < ttlMs) {
        return cached;
      }
      if (force && currentNow - lastAttemptAtMs < minForceIntervalMs) {
        return cached;
      }
    }

    if (inFlight) {
      return inFlight;
    }

    const address = env?.ANTIGRAVITY_LS_ADDRESS || '';
    const csrfToken = env?.ANTIGRAVITY_CSRF_TOKEN || '';

    if (!address || !csrfToken) {
      return {
        ok: false,
        available: false,
        stale: false,
        source: 'none',
        code: 'env_unavailable',
        error: '当前运行环境未注入宿主官方配额通道（也可在「其他」页接入官方 CLI statusLine）',
        fetchedAtMs: currentNow,
        groups: [],
      };
    }

    lastAttemptAtMs = currentNow;
    inFlight = (async () => {
      try {
        const raw = await fetcher({ address, csrfToken, timeoutMs });
        const normalized = normalizeQuotaSummary(raw, now(), { source: 'official_local_ls' });
        if (effectiveUserStatusFetcher) {
          try {
            const statusPayload = await effectiveUserStatusFetcher({
              address,
              csrfToken,
              timeoutMs: Math.min(timeoutMs, 2500),
            });
            const tierMeta = extractTierFromUserStatus(statusPayload);
            if (tierMeta?.planTier) {
              normalized.planTier = tierMeta.planTier;
              normalized.rawTierName = tierMeta.rawTierName;
              if (tierMeta.rawTierId) normalized.rawTierId = tierMeta.rawTierId;
            }
          } catch {
            // Optional tier lookup must never fail quota summary
          }
        }
        cached = normalized;
        lastSource = 'official_local_ls';
        return normalized;
      } catch (err) {
        const code = typeof err?.code === 'string' ? err.code : 'fetch_failed';
        const message =
          typeof err?.message === 'string' && err.message.trim()
            ? err.message.trim().slice(0, 180)
            : '获取官方配额失败';
        if (cached) {
          return {
            ...cached,
            stale: true,
            code,
            error: message,
          };
        }
        return {
          ok: false,
          available: false,
          stale: false,
          source: 'official_local_ls',
          code,
          error: message,
          fetchedAtMs: now(),
          groups: [],
        };
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  function clearCache() {
    cached = null;
    lastAttemptAtMs = 0;
  }

  function getComplianceStatus(opts = {}) {
    let resolvedEnabled;
    if (typeof opts?.enabled === 'boolean') {
      resolvedEnabled = opts.enabled;
    } else if (typeof isEnabled === 'function') {
      try {
        const res = isEnabled();
        resolvedEnabled = typeof res === 'boolean' ? res : lastSource !== 'disabled';
      } catch {
        resolvedEnabled = true;
      }
    } else {
      resolvedEnabled = lastSource !== 'disabled';
    }
    const sl = inspectOfficialStatusLine(paths, now());
    const hasLocalLs = Boolean(parseLsAddress(env?.ANTIGRAVITY_LS_ADDRESS || '') && String(env?.ANTIGRAVITY_CSRF_TOKEN || '').trim());
    const activeSource = !resolvedEnabled
      ? 'disabled'
      : sl.fresh
        ? 'official_statusline'
        : lastSource && lastSource !== 'disabled'
          ? lastSource
          : hasLocalLs
            ? 'official_local_ls'
            : 'none';
    return {
      quotaQueryEnabled: Boolean(resolvedEnabled),
      activeSource,
      hasLocalLs,
      directCloudCodeBlocked: true,
      statusLine: sl,
    };
  }

  return {
    getQuotaSummary,
    clearCache,
    getComplianceStatus,
  };
}
