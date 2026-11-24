/**
 * Antigravity Monitor Sidecar entry point.
 *
 * Hosts the AUX_PANE Web UI, serves verified static/image assets, isolates
 * JSONL transcript indexing in a background scan_worker child process, and
 * delegates persistence/telemetry/security logic to backend/* modules.
 */

import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  applyRulesPreset,
  buildHostThemeSeedsPreview,
  inspectMarkdownSecurity,
  listKnownModels,
} from './backend/config_sync.mjs';
import {
  controlBackdropCompanion,
  ensureBackdropAssets,
  getBackdropStatus,
  restoreHostOpacityFallback,
} from './backend/backdrop_manager.mjs';
import { createCdpThemeBridge, ensureCdpLauncher } from './backend/cdp_theme_bridge.mjs';
import { buildFrontendBundle } from './backend/bundle_builder.mjs';
import {
  buildMasterySnapshot,
  openLocalPathTarget,
  resolveLocalTargetPath,
} from './backend/mastery.mjs';
import {
  composeOutboundMessage,
  listSlashCommands,
  matchLeadingSlashCommand,
  MAX_COMPOSER_PROMPT_CHARS,
  saveComposerImages,
} from './backend/composer.mjs';
import {
  createMasterySummarizer,
  fetchThirdPartyModels,
  testThirdPartyConnection,
} from './backend/mastery_summarizer.mjs';
import { atomicWriteJson, resolvePaths } from './backend/paths.mjs';
import { BUILTIN_PRESETS, estimateTokens } from './backend/presets_builtin.mjs';
import { markRead, querySessionsHub, setFavorites } from './backend/sessions.mjs';
import {
  BUILTIN_WALLPAPERS,
  createStorage,
  sanitizePublicMasteryConfig,
} from './backend/storage.mjs';
import {
  queryBatchConvHudMetrics,
  queryRequestLogs,
  queryTelemetrySnapshot,
} from './backend/telemetry.mjs';
import { createQuotaClient } from './backend/quota.mjs';
import { createAccountManager, ensureAccountTool } from './backend/accounts.mjs';
import {
  applyPluginUpdate,
  checkForUpdates,
  openRepoInBrowser,
} from './backend/updater.mjs';
import { detectWindowsHostEnv, toWindowsPath } from './backend/wsl_bridge.mjs';

// Optional pluggable extensions (absent or disabled -> zero effect on core)
let installedExtensions = [];
try {
  const extLoader = await import('./extensions/loader.mjs');
  installedExtensions = await extLoader.loadInstalledExtensions();
} catch {
  installedExtensions = [];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'backend', 'scan_worker.mjs');

const SAFE_ASSET_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const BUILTIN_WP_ID_SET = new Set(BUILTIN_WALLPAPERS.map((wp) => wp.id));
const ALLOWED_WINDOW_CAPS = new Set([256000, 512000, 1000000]);
const VALID_SCOPES = new Set(['global', 'current']);
const VALID_RANGES = new Set(['today', '7d', '30d']);
const VALID_LANGUAGES = new Set(['zh-CN', 'en']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_THUMB_UPLOAD_BYTES = 2 * 1024 * 1024;

const ALLOWED_RASTER_EXT_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

const ALLOWED_UPLOAD_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

const STATIC_ASSETS = new Map([
  ['/', { relPath: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/index.html', { relPath: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/styles.css', { relPath: 'styles.css', contentType: 'text/css; charset=utf-8' }],
  ['/boot_guard.js', { relPath: 'boot_guard.js', contentType: 'application/javascript; charset=utf-8' }],
  ['/app.js', { relPath: 'app.js', contentType: 'application/javascript; charset=utf-8' }],
  ['/i18n.js', { relPath: 'i18n.js', contentType: 'application/javascript; charset=utf-8' }],
  [
    '/components/context_pie.js',
    { relPath: 'components/context_pie.js', contentType: 'application/javascript; charset=utf-8' },
  ],
  [
    '/components/token_usage.js',
    { relPath: 'components/token_usage.js', contentType: 'application/javascript; charset=utf-8' },
  ],
  [
    '/components/quota_cards.js',
    { relPath: 'components/quota_cards.js', contentType: 'application/javascript; charset=utf-8' },
  ],
  [
    '/components/model_and_prompt.js',
    {
      relPath: 'components/model_and_prompt.js',
      contentType: 'application/javascript; charset=utf-8',
    },
  ],
  [
    '/components/sessions_hub.js',
    { relPath: 'components/sessions_hub.js', contentType: 'application/javascript; charset=utf-8' },
  ],
  [
    '/components/runtime_bar.js',
    { relPath: 'components/runtime_bar.js', contentType: 'application/javascript; charset=utf-8' },
  ],
  [
    '/components/mastery_hub.js',
    { relPath: 'components/mastery_hub.js', contentType: 'application/javascript; charset=utf-8' },
  ],
  [
    '/components/accounts_hub.js',
    { relPath: 'components/accounts_hub.js', contentType: 'application/javascript; charset=utf-8' },
  ],
  [
    '/components/theme_studio.js',
    { relPath: 'components/theme_studio.js', contentType: 'application/javascript; charset=utf-8' },
  ],
]);

/**
 * Resolve sidecar_sdk dynamically, falling back to AGY's global config directory
 * when executed outside the AGY host loader hook.
 */
async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {
    const sdkUrl = pathToFileURL(
      path.join(os.homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs'),
    ).href;
    return await import(sdkUrl);
  }
}

/**
 * Strip Windows/POSIX file paths and avoid leaking stack traces in HTTP errors.
 */
export function sanitizeErrorMessage(err, fallback = '操作失败，请稍后重试') {
  const raw = typeof err === 'string' ? err : err?.message;
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const cleaned = raw
    .replace(/[A-Za-z]:\\[^\s"'`<>]+/g, '[path]')
    .replace(/\/(?:Users|home|var|tmp|opt|etc)\/[^\s"'`<>]+/g, '[path]')
    .split('\n')[0]
    .trim();
  return cleaned ? cleaned.slice(0, 240) : fallback;
}

function makeResponse(ResponseCtor, body, { status = 200, contentType = 'application/json', headers } = {}) {
  const payload =
    typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  if (typeof ResponseCtor === 'function') {
    return new ResponseCtor(payload, { status, contentType, headers });
  }
  return { status, contentType, body: payload, headers };
}

function errorResponse(ResponseCtor, status, error, extra = {}) {
  return makeResponse(
    ResponseCtor,
    { ok: false, error: sanitizeErrorMessage(error), ...extra },
    { status, contentType: 'application/json; charset=utf-8' },
  );
}

/**
 * Ensure relative asset path remains strictly inside rootDir without traversal.
 */
export function resolveSafeAssetPath(rootDir, relativeName) {
  if (!rootDir || typeof relativeName !== 'string' || !relativeName) {
    return null;
  }
  if (relativeName.includes('\x00') || relativeName.includes('..') || path.isAbsolute(relativeName)) {
    return null;
  }
  const base = path.resolve(rootDir);
  const candidate = path.resolve(base, relativeName);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (candidate !== base && !candidate.startsWith(prefix)) {
    return null;
  }
  return candidate;
}

/**
 * Sniff image magic bytes to allow only safe raster formats (PNG, JPEG, WEBP, GIF).
 */
export function detectRasterMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  const gifSig = buffer.subarray(0, 6).toString('ascii');
  if (gifSig === 'GIF87a' || gifSig === 'GIF89a') {
    return 'image/gif';
  }
  return null;
}

/**
 * Validate wallpaper uploads strictly against raster-only rules (block SVG XSS).
 */
export function validateRasterUpload({ name, mime, base64, maxBytes = MAX_UPLOAD_BYTES } = {}) {
  const normalizedMime = String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!normalizedMime || normalizedMime.includes('svg') || !ALLOWED_UPLOAD_MIMES.has(normalizedMime)) {
    return {
      ok: false,
      status: 415,
      error: '仅支持 PNG、JPEG、WEBP 或 GIF 位图壁纸，已禁止 SVG 上传',
    };
  }

  let rawPayload = typeof base64 === 'string' ? base64.trim() : '';
  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/is.exec(rawPayload);
  if (dataUrlMatch) {
    const embeddedMime = dataUrlMatch[1].trim().toLowerCase();
    if (embeddedMime.includes('svg') || !ALLOWED_UPLOAD_MIMES.has(embeddedMime)) {
      return {
        ok: false,
        status: 415,
        error: '仅支持 PNG、JPEG、WEBP 或 GIF 位图壁纸，已禁止 SVG 上传',
      };
    }
    rawPayload = dataUrlMatch[2].trim();
  }

  if (!rawPayload) {
    return { ok: false, status: 400, error: '壁纸图片内容不能为空' };
  }

  const buffer = Buffer.from(rawPayload, 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes) {
    const limitLabel =
      maxBytes >= 1048576
        ? `${Math.round(maxBytes / 1048576)}MB`
        : `${Math.round(maxBytes / 1024)}KB`;
    return {
      ok: false,
      status: 413,
      error: `壁纸文件大小必须在 1B 到 ${limitLabel} 之间`,
    };
  }

  const headText = buffer.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (headText.startsWith('<svg') || headText.startsWith('<?xml') || headText.includes('<script')) {
    return {
      ok: false,
      status: 415,
      error: '检测到 XML/SVG 文本头，出于安全策略已禁止上传',
    };
  }

  const sniffedMime = detectRasterMagic(buffer);
  if (!sniffedMime) {
    return {
      ok: false,
      status: 415,
      error: '文件头校验失败：仅接受真实 PNG、JPEG、WEBP 或 GIF 位图',
    };
  }

  const cleanName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : '自定义壁纸';
  return {
    ok: true,
    name: cleanName,
    mime: sniffedMime,
    base64: rawPayload,
  };
}

function deriveMarkdownTitle(content, filename) {
  const lines = String(content || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const h1 = /^#\s+(.+)$/.exec(trimmed);
    if (h1 && h1[1].trim()) {
      return h1[1].trim().slice(0, 80);
    }
    break;
  }
  const base = path.basename(String(filename || 'custom.md'));
  return base.replace(/\.(md|markdown)$/i, '').trim().slice(0, 80) || '自定义规则';
}

function buildCombinedEtag(telemetryEtag, sessionsHub, activeConvId = '') {
  const digestSeed = JSON.stringify({
    c: activeConvId || '',
    t: telemetryEtag || 'empty',
    a: (sessionsHub?.active || []).map((s) => `${s.id}:${s.status}:${s.modifiedMs}`),
    w: (sessionsHub?.waiting || []).map((s) => `${s.id}:${s.status}:${s.modifiedMs}`),
    u: (sessionsHub?.unread || []).map((s) => `${s.id}:${s.modifiedMs}`),
    r: (sessionsHub?.recent || []).slice(0, 8).map((s) => `${s.id}:${s.status}:${s.modifiedMs}`),
    f: (sessionsHub?.favorites || []).map((s) => `${s.id}:${s.title}`),
  });
  return crypto.createHash('sha1').update(digestSeed).digest('hex').slice(0, 14);
}

function extractCreatedConvId(resp) {
  if (!resp || typeof resp !== 'object') return null;
  return (
    resp.conversationId ||
    resp.conversation_id ||
    resp.response?.conversationId ||
    resp.response?.conversation_id ||
    resp.conversation?.conversationId ||
    resp.conversation?.id ||
    null
  );
}

function mapStorageErrorStatus(err) {
  const code = err?.code;
  if (code === 'UNSUPPORTED_MEDIA_TYPE' || code === 'INVALID_IMAGE_MAGIC') return 415;
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  if (code === 'NOT_FOUND') return 404;
  if (
    code === 'INVALID_NAME' ||
    code === 'INVALID_ID' ||
    code === 'INVALID_COLOR' ||
    code === 'EMPTY_PAYLOAD' ||
    code === 'BUILTIN_PALETTE'
  ) {
    return 400;
  }
  return 500;
}

function normalizeViewTitle(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveViewedConvInfo(paths, sessionsHub) {
  const viewFile = paths?.hudActiveViewFile;
  if (!viewFile) return { convId: '', isNewConversation: false, source: '', updatedAtMs: 0, ageMs: Infinity };

  let doc = null;
  try {
    const text = await fs.readFile(viewFile, 'utf8');
    doc = JSON.parse(text);
  } catch {
    return { convId: '', isNewConversation: false, source: '', updatedAtMs: 0, ageMs: Infinity };
  }
  if (!doc || typeof doc !== 'object') return { convId: '', isNewConversation: false, source: '', updatedAtMs: 0, ageMs: Infinity };

  const updatedAtMs = Number(doc.updatedAtMs || 0);
  const ageMs = updatedAtMs > 0 ? Math.max(0, Date.now() - updatedAtMs) : Infinity;
  if (updatedAtMs > 0 && ageMs > 12 * 3600 * 1000) {
    return { convId: '', isNewConversation: false, source: '', updatedAtMs: 0, ageMs };
  }

  const source = typeof doc.source === 'string' ? doc.source : '';
  if (doc.isNewConversation === true) {
    return { convId: '', isNewConversation: true, source, updatedAtMs, ageMs };
  }
  const exactConvId = typeof doc.conversationId === 'string' ? doc.conversationId.trim() : '';
  if (exactConvId) {
    return { convId: exactConvId, isNewConversation: false, source, updatedAtMs, ageMs };
  }

  const all = Array.isArray(sessionsHub?.allSelectable) ? sessionsHub.allSelectable : [];
  if (all.length === 0) return { convId: '', isNewConversation: false, source, updatedAtMs, ageMs };

  const rawTitle = normalizeViewTitle(doc.title);
  const rawWorkspace = normalizeViewTitle(doc.workspace).toLowerCase();
  if (!rawTitle || rawTitle.length < 2) return { convId: '', isNewConversation: false, source, updatedAtMs, ageMs };

  const targetLow = rawTitle.toLowerCase();
  if (targetLow === 'new conversation' || targetLow === '新建对话') {
    return { convId: '', isNewConversation: true, source, updatedAtMs, ageMs };
  }

  const isEllipsized = /(?:\.{2,}|…)$/.test(rawTitle);
  const stripped = rawTitle.replace(/(?:\.{2,}|…)+$/, '').trim();
  const strippedLow = stripped.toLowerCase();

  const workspaceMatches = (s) => {
    if (!rawWorkspace) return false;
    const ws = normalizeViewTitle(s?.workspace).toLowerCase();
    return Boolean(ws && (ws === rawWorkspace || ws.startsWith(rawWorkspace) || rawWorkspace.startsWith(ws)));
  };

  // 1. Exact title match (prefer matching workspace, then latest modifiedMs)
  const exact = all
    .filter((s) => normalizeViewTitle(s?.title).toLowerCase() === targetLow)
    .sort((a, b) => {
      const wm = Number(workspaceMatches(b)) - Number(workspaceMatches(a));
      if (wm !== 0) return wm;
      return (b.modifiedMs || 0) - (a.modifiedMs || 0);
    });
  if (exact.length > 0 && exact[0]?.id) {
    return { convId: String(exact[0].id), isNewConversation: false, source, updatedAtMs, ageMs };
  }

  // 2. Ellipsized prefix match (e.g. "Antigravity Tool Improve..." -> "Antigravity Tool Improvement Ideas")
  if (strippedLow.length >= 4) {
    const prefix = all
      .filter((s) => {
        const st = normalizeViewTitle(s?.title).toLowerCase();
        if (!st) return false;
        return st.startsWith(strippedLow) || (isEllipsized && strippedLow.startsWith(st));
      })
      .sort((a, b) => {
        const wm = Number(workspaceMatches(b)) - Number(workspaceMatches(a));
        if (wm !== 0) return wm;
        return (b.modifiedMs || 0) - (a.modifiedMs || 0);
      });
    if (prefix.length > 0 && prefix[0]?.id) {
      return { convId: String(prefix[0].id), isNewConversation: false, source, updatedAtMs, ageMs };
    }
  }

  return { convId: '', isNewConversation: false, source, updatedAtMs: 0, ageMs };
}

async function resolveViewedConvId(paths, sessionsHub) {
  const info = await resolveViewedConvInfo(paths, sessionsHub);
  return info.convId;
}

function pickFollowLatestTopLevelConvId(sessionsHub, viewedConvId = '') {
  if (viewedConvId === '__new_conversation__') {
    return '';
  }
  if (viewedConvId) {
    return String(viewedConvId);
  }
  const buckets = [
    sessionsHub?.active,
    sessionsHub?.waiting,
    sessionsHub?.unread,
    sessionsHub?.recent,
    sessionsHub?.allSelectable,
  ];
  for (const list of buckets) {
    if (Array.isArray(list) && list.length > 0 && list[0]?.id) {
      return String(list[0].id);
    }
  }
  return '';
}

async function readSafeCustomAssetFile(customWallpapersDir, filename) {
  const cleanName = path.basename(String(filename || ''));
  if (!cleanName) return null;
  const ext = path.extname(cleanName).toLowerCase();
  const mime = ALLOWED_RASTER_EXT_MIME.get(ext);
  if (!mime) return { forbidden: true };
  const resolved = resolveSafeAssetPath(customWallpapersDir, cleanName);
  if (!resolved) return { forbidden: true };
  try {
    const buf = await fs.readFile(resolved);
    return { buf, mime };
  } catch {
    return null;
  }
}

function createHudTelemetryPublisher(paths, store, cdpBridge = null) {
  let lastSig = '';
  let inFlight = false;
  let queued = false;
  let lastHostConvId = '';
  let lastHostConvAtMs = 0;

  const setActiveHostConv = (convId) => {
    const id = typeof convId === 'string' ? convId.trim() : '';
    if (!id) return;
    lastHostConvId = id;
    lastHostConvAtMs = Date.now();
  };

  const isActiveHostConv = (convId) => {
    const id = typeof convId === 'string' ? convId.trim() : '';
    return Boolean(id && lastHostConvId && id === lastHostConvId);
  };

  let writeChain = Promise.resolve();
  let lastSessionsSnapshot = [];
  let lastActiveSessionCount = 0;
  let lastUnreadSessionCount = 0;
  const writePayload = (
    telemetry,
    { sessionsHudList = null, forceEmpty = false, activeSessionCount = null, unreadSessionCount = null } = {},
  ) => {
    if (!paths?.hudTelemetryFile || (!telemetry && !forceEmpty)) return Promise.resolve();
    writeChain = writeChain.then(async () => {
      const pie = forceEmpty ? {} : (telemetry?.contextPie || {});
      const rt = forceEmpty ? {} : (telemetry?.runtimeTelemetry || {});
      const cap = Number(pie.windowCap) || Number((await store?.getPrefs?.().catch(() => null))?.windowCap) || 512000;
      const used = forceEmpty ? 0 : Math.max(0, Math.round(Number(pie.totalUsed) || 0));
      const percent = cap > 0 ? Math.max(0, Math.round((used / cap) * 100)) : 0;
      const tokPerSec =
        !forceEmpty &&
        typeof rt.latestTokPerSec === 'number' &&
        Number.isFinite(rt.latestTokPerSec) &&
        rt.latestTokPerSec > 0
          ? Math.round(rt.latestTokPerSec * 10) / 10
          : null;
      const cacheHitPct =
        !forceEmpty &&
        used > 0 &&
        typeof rt.cacheHitPct === 'number' &&
        Number.isFinite(rt.cacheHitPct)
          ? Math.max(0, Math.min(100, Math.round(rt.cacheHitPct)))
          : null;
      const upstreamModelId = !forceEmpty && typeof rt.upstreamModelId === 'string' ? rt.upstreamModelId.trim() : '';
      const upstreamModelStatus = !forceEmpty && typeof rt.upstreamModelStatus === 'string' ? rt.upstreamModelStatus : 'unreported';
      const latestInputTokens = !forceEmpty ? Math.max(0, Math.round(Number(rt.latestInputTokens) || 0)) : 0;
      const latestUncachedInputTokens = !forceEmpty ? Math.max(0, Math.round(Number(rt.latestUncachedInputTokens) || 0)) : 0;
      const latestCacheReadTokens = !forceEmpty ? Math.max(0, Math.round(Number(rt.latestCacheReadTokens) || 0)) : 0;
      const latestOutputTokens = !forceEmpty ? Math.max(0, Math.round(Number(rt.latestOutputTokens) || 0)) : 0;
      const latestStepAtMs = !forceEmpty ? Math.max(0, Math.round(Number(rt.latestStepAtMs) || 0)) : 0;
      const activeConvId = forceEmpty ? '' : (typeof telemetry?.activeConvId === 'string' ? telemetry.activeConvId : '');

      if (Array.isArray(sessionsHudList)) {
        lastSessionsSnapshot = sessionsHudList;
      }
      if (typeof activeSessionCount === 'number' && Number.isFinite(activeSessionCount)) {
        lastActiveSessionCount = Math.max(0, Math.round(activeSessionCount));
      }
      if (typeof unreadSessionCount === 'number' && Number.isFinite(unreadSessionCount)) {
        lastUnreadSessionCount = Math.max(0, Math.round(unreadSessionCount));
      }
      const agentState =
        lastActiveSessionCount > 0 ? 'running' : lastUnreadSessionCount > 0 ? 'unread' : 'idle';

      const payload = {
        activeConvId,
        percent,
        totalUsed: used,
        windowCap: cap,
        tokPerSec,
        latestInputTokens,
        latestUncachedInputTokens,
        latestCacheReadTokens,
        latestOutputTokens,
        latestStepAtMs,
        cacheHitPct,
        upstreamModelId,
        upstreamModelStatus,
        activeSessionCount: lastActiveSessionCount,
        unreadSessionCount: lastUnreadSessionCount,
        agentState,
        cdpHudActive: false,
        sessions: lastSessionsSnapshot,
        updatedAtMs: Date.now(),
      };

      if (cdpBridge && typeof cdpBridge.updateHudData === 'function') {
        const injected = await cdpBridge.updateHudData(payload).catch(() => false);
        payload.cdpHudActive = Boolean(injected || cdpBridge.isHudInjected?.());
      }

      const sessionsSig = lastSessionsSnapshot
        .map((s) => `${s.id}:${s.percent}:${s.tokPerSec ?? ''}:${s.cacheHitPct ?? ''}:${s.upstreamModelId}`)
        .join(',');
      const sig = `${activeConvId}|${percent}|${used}|${cap}|${tokPerSec ?? ''}|${latestInputTokens}|${latestOutputTokens}|${latestStepAtMs}|${cacheHitPct ?? ''}|${upstreamModelId}|${upstreamModelStatus}|${lastActiveSessionCount}|${lastUnreadSessionCount}|${payload.cdpHudActive ? 1 : 0}|${sessionsSig}`;
      if (sig === lastSig) return;

      try {
        await atomicWriteJson(paths.hudTelemetryFile, payload);
        lastSig = sig;
      } catch {
        // Retry next tick without advancing lastSig
      }
    });
    return writeChain;
  };

  const resolveActiveConv = (topLevelIdSet, viewedInfo) => {
    // Explicit blank New Conversation detected in foreground header -> immediately reset HUD to 0%
    if (viewedInfo?.isNewConversation && (viewedInfo.updatedAtMs || 0) >= lastHostConvAtMs) {
      return '__new_conversation__';
    }
    // Arbitrate by latest foreground timestamp: sidebar UIA header / sidecar_focus vs foreground hostConvId
    if (viewedInfo?.convId && (viewedInfo.updatedAtMs || 0) > lastHostConvAtMs) {
      return viewedInfo.convId;
    }
    if (lastHostConvId && topLevelIdSet.has(lastHostConvId)) {
      return lastHostConvId;
    }
    if (viewedInfo?.convId) {
      return viewedInfo.convId;
    }
    return '';
  };

  const refreshFromDb = async () => {
    if (!paths?.hudTelemetryFile) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      const [sessionsHub, prefs] = await Promise.all([
        querySessionsHub(paths.summariesDbPath, store, {}),
        store.getPrefs(),
      ]);
      const allSelectable = Array.isArray(sessionsHub?.allSelectable) ? sessionsHub.allSelectable : [];
      const topLevelConvIds = allSelectable.map((s) => s.id).filter(Boolean);
      const topLevelIdSet = new Set(topLevelConvIds);
      const windowCap = Number(prefs?.windowCap) || 512000;
      const sessionsHudList = queryBatchConvHudMetrics(paths.cacheDbPath, allSelectable, windowCap);

      const activeSessionCount = Array.isArray(sessionsHub?.active) ? sessionsHub.active.length : 0;
      const unreadSessionCount = Array.isArray(sessionsHub?.unread) ? sessionsHub.unread.length : 0;

      const viewedInfo = await resolveViewedConvInfo(paths, sessionsHub);
      const viewedConvId = resolveActiveConv(topLevelIdSet, viewedInfo);
      if (viewedConvId === '__new_conversation__') {
        await writePayload(
          { contextPie: { windowCap, totalUsed: 0 }, runtimeTelemetry: {} },
          { sessionsHudList, forceEmpty: true, activeSessionCount, unreadSessionCount },
        );
        return;
      }

      const followConvId = pickFollowLatestTopLevelConvId(sessionsHub, viewedConvId);
      const telemetry = await queryTelemetrySnapshot(paths.cacheDbPath, store, paths, {
        convId: followConvId || '',
        isExplicitConvId: Boolean(viewedConvId),
        followLatest: !viewedConvId,
        topLevelConvIds: topLevelConvIds.length > 0 ? topLevelConvIds : undefined,
        scope: 'current',
        range: '30d',
      });
      await writePayload(telemetry, { sessionsHudList, activeSessionCount, unreadSessionCount });
    } catch {
      // Non-fatal HUD publish failure
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void refreshFromDb();
      }
    }
  };

  return { writePayload, refreshFromDb, setActiveHostConv, isActiveHostConv, resolveActiveConv };
}

/**
 * Create all sidecar HTTP route handlers with injected dependencies so both
 * SidecarApp runtime and isolated unit tests can invoke them safely.
 */
export function createMonitorHandlers({
  paths,
  storage,
  ResponseCtor = null,
  sidecarBridge = null,
  triggerRescan = null,
  hudPublisher = null,
  cdpBridge = null,
  quotaClient = null,
  accountManager = null,
  accountDriver = null,
} = {}) {
  const resolvedPaths = paths || resolvePaths();
  const store = storage || createStorage(resolvedPaths);
  const cdp = cdpBridge || createCdpThemeBridge(resolvedPaths);
  const hud = hudPublisher || createHudTelemetryPublisher(resolvedPaths, store, cdp);
  const quota = quotaClient || createQuotaClient();
  const accounts =
    accountManager ||
    createAccountManager({
      paths: resolvedPaths,
      storage: store,
      quotaClient: quota,
      sidecarBridge,
      getRunningConversations: async () => {
        const hub = await querySessionsHub(resolvedPaths.summariesDbPath, store, {});
        return Array.isArray(hub?.active)
          ? hub.active.filter((s) => s && s.id && s.status === 'running')
          : [];
      },
      driver: accountDriver,
    });
  const masterySummarizer = createMasterySummarizer(resolvedPaths, store);
  const consoleViewports = new Map();
  let lastViewportDiskSig = '';
  let lastViewportDiskWriteMs = 0;
  const routes = new Map();

  const flushConsoleViewportFile = async (force = false) => {
    if (!resolvedPaths.consoleViewportFile) return;
    const now = Date.now();
    let bestPhysW = 0;
    let bestPhysH = 0;
    let bestOuterW = 0;
    let anyVisible = false;
    for (const [id, entry] of consoleViewports.entries()) {
      if (!entry || now - (entry.updatedAtMs || 0) > 8000) {
        consoleViewports.delete(id);
        continue;
      }
      if (entry.visible && entry.physW > 0) {
        anyVisible = true;
        if (entry.physW > bestPhysW) {
          bestPhysW = entry.physW;
          bestPhysH = entry.physH || 0;
          bestOuterW = entry.outerW || 0;
        }
      }
    }
    const sig = `${anyVisible ? 1 : 0}|${Math.round(bestPhysW / 4)}|${Math.round(bestOuterW / 8)}`;
    if (!force && sig === lastViewportDiskSig && (!anyVisible || now - lastViewportDiskWriteMs < 3000)) {
      return;
    }
    lastViewportDiskSig = sig;
    lastViewportDiskWriteMs = now;
    await atomicWriteJson(resolvedPaths.consoleViewportFile, {
      visible: anyVisible,
      physW: bestPhysW,
      physH: bestPhysH,
      outerW: bestOuterW,
      updatedAtMs: now,
    }).catch(() => {});
  };

  const register = (method, routePath, handler) => {
    routes.set(`${method.toUpperCase()} ${routePath}`, handler);
  };

  for (const [routePath, meta] of STATIC_ASSETS.entries()) {
    register('GET', routePath, async () => {
      const target = resolveSafeAssetPath(resolvedPaths.frontendDir, meta.relPath);
      if (!target) {
        return makeResponse(ResponseCtor, 'Forbidden', { status: 403, contentType: 'text/plain' });
      }
      try {
        const content = await fs.readFile(target);
        return makeResponse(ResponseCtor, content, {
          status: 200,
          contentType: meta.contentType,
          headers: { 'Cache-Control': 'no-cache' },
        });
      } catch {
        return makeResponse(ResponseCtor, 'Not found', { status: 404, contentType: 'text/plain' });
      }
    });
  }

  register('GET', '/bundle.js', async () => {
    try {
      const bundle = await buildFrontendBundle(resolvedPaths.frontendDir);
      return makeResponse(ResponseCtor, bundle, {
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        headers: { 'Cache-Control': 'no-cache' },
      });
    } catch (err) {
      return errorResponse(ResponseCtor, 500, sanitizeErrorMessage(err, '无法构建前端脚本'));
    }
  });

  register('GET', '/api/asset', async (data = {}) => {
    const kind = String(data.kind || '').trim();
    const id = String(data.id || '').trim();
    const isThumb = data.thumb === '1' || data.thumb === 'true' || data.thumb === true;

    if (kind === 'logo') {
      const logoPath = resolveSafeAssetPath(resolvedPaths.assetsDir, 'logo.svg');
      if (!logoPath) {
        return errorResponse(ResponseCtor, 403, '非法资源路径');
      }
      try {
        const buf = await fs.readFile(logoPath);
        return makeResponse(ResponseCtor, buf, {
          status: 200,
          contentType: 'image/svg+xml; charset=utf-8',
          headers: {
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch {
        return errorResponse(ResponseCtor, 404, '未找到图标资源');
      }
    }

    if (!SAFE_ASSET_ID_RE.test(id)) {
      return errorResponse(ResponseCtor, 400, '非法资源 ID');
    }

    if (kind === 'builtin_wp') {
      if (!BUILTIN_WP_ID_SET.has(id)) {
        return errorResponse(ResponseCtor, 404, '未知内置壁纸 ID');
      }
      const fileName = isThumb ? `${id}-thumb.webp` : `${id}.webp`;
      const wpPath = resolveSafeAssetPath(resolvedPaths.wallpapersDir, fileName);
      if (!wpPath) {
        return errorResponse(ResponseCtor, 403, '非法壁纸路径');
      }
      try {
        const buf = await fs.readFile(wpPath);
        return makeResponse(ResponseCtor, buf, {
          status: 200,
          contentType: 'image/webp',
          headers: {
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch {
        return errorResponse(ResponseCtor, 404, '壁纸文件不存在');
      }
    }

    if (kind === 'custom_wp') {
      const themes = await store.getThemes();
      const entry = themes.customWallpapers.find((w) => w.id === id);
      if (!entry) {
        return errorResponse(ResponseCtor, 404, '未找到自定义壁纸');
      }

      if (isThumb && entry.thumbFilename) {
        const thumbRes = await readSafeCustomAssetFile(
          resolvedPaths.customWallpapersDir,
          entry.thumbFilename,
        );
        if (thumbRes?.forbidden) {
          return errorResponse(ResponseCtor, 403, '不支持的非位图缩略图扩展名');
        }
        if (thumbRes?.buf) {
          return makeResponse(ResponseCtor, thumbRes.buf, {
            status: 200,
            contentType: thumbRes.mime,
            headers: {
              'Cache-Control': 'private, max-age=3600',
              'X-Content-Type-Options': 'nosniff',
            },
          });
        }
      }

      const fullRes = await readSafeCustomAssetFile(resolvedPaths.customWallpapersDir, entry.filename);
      if (fullRes?.forbidden) {
        return errorResponse(ResponseCtor, 403, '不支持的非位图壁纸扩展名');
      }
      if (!fullRes?.buf) {
        return errorResponse(ResponseCtor, 404, '自定义壁纸文件已丢失');
      }
      return makeResponse(ResponseCtor, fullRes.buf, {
        status: 200,
        contentType: fullRes.mime,
        headers: {
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    return errorResponse(ResponseCtor, 400, '不支持的资源类型');
  });

  register('GET', '/api/snapshot', async (data = {}) => {
    if (data.force === '1' || data.force === 'true') {
      triggerRescan?.();
    }

    const scope = VALID_SCOPES.has(data.scope) ? data.scope : 'global';
    const range = VALID_RANGES.has(data.range) ? data.range : '30d';
    const requestedCap = Number(data.windowCap);
    const windowCap = ALLOWED_WINDOW_CAPS.has(requestedCap) ? requestedCap : undefined;

    const explicitConvId =
      typeof data.convId === 'string' && data.convId.trim() ? data.convId.trim() : '';
    const rawHostConvId =
      typeof data.hostConvId === 'string' && data.hostConvId.trim() ? data.hostConvId.trim() : '';
    const syncHud = data.syncHud === '1' || data.syncHud === 'true' || data.syncHud === true;

    // Query top-level sessions first so Follow Latest never gets hijacked by subagent/swarm sessions
    const sessionsHub = await querySessionsHub(resolvedPaths.summariesDbPath, store, {});
    const hasTopLevelCatalog =
      Array.isArray(sessionsHub?.allSelectable) && sessionsHub.allSelectable.length > 0;
    const topLevelConvIds = (sessionsHub?.allSelectable || []).map((s) => s.id).filter(Boolean);
    const topLevelIdSet = new Set(topLevelConvIds);

    let viewedConvId = '';
    if (!explicitConvId) {
      if (rawHostConvId && topLevelIdSet.has(rawHostConvId)) {
        // Visible sidecar webview's own host conversation UUID is real-time ground truth for this pane;
        // ONLY foreground events (syncHud=1 on mount/focus/hover) update the shared composer HUD,
        // preventing hidden per-conversation background iframes from fighting over hud_telemetry.json!
        viewedConvId = rawHostConvId;
        if (syncHud) {
          hud.setActiveHostConv?.(rawHostConvId);
        }
      } else {
        const viewedInfo = await resolveViewedConvInfo(resolvedPaths, sessionsHub);
        viewedConvId =
          typeof hud.resolveActiveConv === 'function'
            ? hud.resolveActiveConv(topLevelIdSet, viewedInfo)
            : viewedInfo.convId || '';
      }
    }
    const isNewConv = viewedConvId === '__new_conversation__';
    const followConvId = pickFollowLatestTopLevelConvId(sessionsHub, viewedConvId);

    const targetConvId = explicitConvId || followConvId || '';
    const isExplicitConvId = Boolean(explicitConvId);

    const telemetry = await queryTelemetrySnapshot(resolvedPaths.cacheDbPath, store, resolvedPaths, {
      convId: isNewConv ? '__new_conversation__' : targetConvId,
      isExplicitConvId: isExplicitConvId || Boolean(viewedConvId),
      followLatest: !isExplicitConvId && !viewedConvId,
      topLevelConvIds: hasTopLevelCatalog ? topLevelConvIds : undefined,
      scope,
      range,
      windowCap,
    });

    if (
      !isExplicitConvId &&
      (syncHud || !rawHostConvId || Boolean(rawHostConvId && hud.isActiveHostConv?.(rawHostConvId)))
    ) {
      void hud.writePayload(telemetry, {
        forceEmpty: isNewConv,
        activeSessionCount: Array.isArray(sessionsHub?.active) ? sessionsHub.active.length : 0,
        unreadSessionCount: Array.isArray(sessionsHub?.unread) ? sessionsHub.unread.length : 0,
      });
    }

    const observedModels =
      Array.isArray(telemetry.availableModelsFromLogs) && telemetry.availableModelsFromLogs.length > 0
        ? telemetry.availableModelsFromLogs
        : telemetry.tokenUsage?.models || [];
    const availableModels = await listKnownModels(resolvedPaths, observedModels);

    const etag = buildCombinedEtag(telemetry.etag, sessionsHub, telemetry.activeConvId);

    if (data.etag && String(data.etag) === etag) {
      return { unchanged: true, etag };
    }

    return {
      unchanged: false,
      etag,
      followLatest: !isExplicitConvId,
      activeConvId: telemetry.activeConvId,
      contextPie: telemetry.contextPie,
      tokenUsage: telemetry.tokenUsage,
      sessionsHub,
      runtimeTelemetry: telemetry.runtimeTelemetry,
      availableModels,
    };
  });

  register('GET', '/api/telemetry/requests', async (data = {}) => {
    const scope = VALID_SCOPES.has(data.scope) ? data.scope : 'current';
    const range = VALID_RANGES.has(data.range) ? data.range : 'today';
    const model = typeof data.model === 'string' ? data.model.trim().slice(0, 128) : '';
    const status = ['all', 'ok', 'error'].includes(data.status) ? data.status : 'all';
    const limit = Number(data.limit) || 80;
    const offset = Number(data.offset) || 0;

    const explicitConvId =
      typeof data.convId === 'string' && data.convId.trim() ? data.convId.trim() : '';
    const rawHostConvId =
      typeof data.hostConvId === 'string' && data.hostConvId.trim() ? data.hostConvId.trim() : '';

    const sessionsHub = await querySessionsHub(resolvedPaths.summariesDbPath, store, {});
    const convTitleMap = new Map();
    const indexSessions = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const s of arr) {
        if (!s?.id) continue;
        const prev = convTitleMap.get(s.id);
        convTitleMap.set(s.id, {
          title: s.title || prev?.title || '',
          workspace: s.workspace || prev?.workspace || '',
        });
      }
    };
    indexSessions(sessionsHub?.allSelectable);
    indexSessions(sessionsHub?.recent);
    indexSessions(sessionsHub?.favorites);
    indexSessions(sessionsHub?.unread);
    indexSessions(sessionsHub?.active);

    let resolvedConvId = explicitConvId;
    if (scope === 'current' && !resolvedConvId) {
      const topLevelConvIds = (sessionsHub?.allSelectable || []).map((s) => s.id).filter(Boolean);
      const topLevelIdSet = new Set(topLevelConvIds);
      let viewedConvId = '';
      if (rawHostConvId && topLevelIdSet.has(rawHostConvId)) {
        viewedConvId = rawHostConvId;
      } else {
        const viewedInfo = await resolveViewedConvInfo(resolvedPaths, sessionsHub);
        viewedConvId =
          typeof hud.resolveActiveConv === 'function'
            ? hud.resolveActiveConv(topLevelIdSet, viewedInfo)
            : viewedInfo.convId || '';
      }
      resolvedConvId =
        viewedConvId === '__new_conversation__'
          ? '__new_conversation__'
          : pickFollowLatestTopLevelConvId(sessionsHub, viewedConvId) || '';
    }

    return queryRequestLogs(resolvedPaths.cacheDbPath, {
      scope,
      range,
      convId: resolvedConvId,
      model,
      status,
      limit,
      offset,
      convTitleMap,
    });
  });

  register('GET', '/api/quota', async (data = {}) => {
    const force = data.force === '1' || data.force === 'true' || data.force === true;
    const summary = await quota.getQuotaSummary({ force });
    if (summary?.ok && Array.isArray(summary.groups) && summary.groups.length > 0) {
      void accounts.syncActiveAccountQuotaFromLive(summary).catch(() => {});
    }
    return summary;
  });

  register('POST', '/api/rescan', async () => {
    triggerRescan?.();
    return { ok: true };
  });

  register('GET', '/api/preferences', async () => {
    const [prefs, themes, customPresets] = await Promise.all([
      store.getPrefs(),
      store.getThemes(),
      store.getCustomPresets(),
    ]);

    let observedModels = [];
    try {
      const snap = await queryTelemetrySnapshot(resolvedPaths.cacheDbPath, store, resolvedPaths, {
        scope: 'global',
        range: '30d',
      });
      observedModels = snap.availableModelsFromLogs || [];
    } catch {
      observedModels = [];
    }

    const [availableModels, rawBackdropStatus] = await Promise.all([
      listKnownModels(resolvedPaths, observedModels),
      getBackdropStatus(resolvedPaths, themes),
    ]);
    const backdropStatus = {
      ...rawBackdropStatus,
      cdp: cdp.getStatus(themes),
    };
    const seedsPreview = buildHostThemeSeedsPreview(themes.colors);

    return {
      language: prefs.language,
      windowCap: prefs.windowCap,
      defaultModel: prefs.defaultModel,
      activePromptId: prefs.activePromptId,
      prompts: [...BUILTIN_PRESETS, ...customPresets],
      themeState: {
        ...themes,
        hostThemeSynced: false,
      },
      backdropStatus,
      ...(seedsPreview.ok ? { seedsPreview } : {}),
      availableModels,
    };
  });

  register('POST', '/api/model/default', async (data = {}) => {
    const modelId = typeof data.modelId === 'string' ? data.modelId.trim() : '';
    if (!modelId || modelId.length > 128) {
      return errorResponse(ResponseCtor, 400, '模型 ID 无效');
    }
    const tier = typeof data.tier === 'string' && data.tier.trim() ? data.tier.trim().slice(0, 48) : 'standard';
    const label = typeof data.label === 'string' && data.label.trim() ? data.label.trim().slice(0, 128) : undefined;

    const updated = await store.updatePrefs({
      defaultModel: { id: modelId, tier, ...(label ? { label } : {}) },
    });
    return { ok: true, defaultModel: updated.defaultModel };
  });

  register('POST', '/api/sessions/new', async (data = {}) => {
    const prefs = await store.getPrefs();
    const useDefault = data.useDefaultModel !== false;
    const requestedModel =
      typeof data.modelId === 'string' && data.modelId.trim()
        ? data.modelId.trim()
        : typeof data.model === 'string' && data.model.trim()
          ? data.model.trim()
          : '';
    const model =
      requestedModel || (useDefault && prefs.defaultModel?.id ? prefs.defaultModel.id : 'flash');
    const prompt =
      typeof data.prompt === 'string' && data.prompt.trim()
        ? data.prompt.trim()
        : '请先确认当前工作区上下文并等待我的具体指令。';
    const projectId =
      typeof data.projectId === 'string' && data.projectId.trim()
        ? data.projectId.trim()
        : sidecarBridge?.getConfig?.()?.projectId;

    if (typeof sidecarBridge?.startConversation !== 'function') {
      return errorResponse(ResponseCtor, 503, '当前运行环境不支持通过 agentapi 新建对话');
    }

    try {
      const resp = await sidecarBridge.startConversation(prompt, { model, projectId });
      const conversationId = extractCreatedConvId(resp);
      return {
        ok: true,
        conversationId,
        model,
        dispatchedPrompt: true,
        hostDefaultModified: false,
      };
    } catch (err) {
      return errorResponse(
        ResponseCtor,
        502,
        `宿主暂无法自动拉起新对话：${sanitizeErrorMessage(err, 'agentapi 调用失败')}`,
      );
    }
  });

  register('POST', '/api/prompts/select', async (data = {}) => {
    const presetId = typeof data.presetId === 'string' ? data.presetId.trim() : '';
    if (!presetId) {
      return errorResponse(ResponseCtor, 400, 'presetId 不能为空');
    }

    const customPresets = await store.getCustomPresets();
    const allPresets = [...BUILTIN_PRESETS, ...customPresets];
    const target = allPresets.find((p) => p.id === presetId);
    if (!target) {
      return errorResponse(ResponseCtor, 404, '未找到指定的系统规则预设');
    }

    const applied = await applyRulesPreset(resolvedPaths, target);
    if (!applied.ok || applied.blocked) {
      return {
        ok: false,
        blocked: true,
        reason: applied.reason || '规则安全校验未通过',
        warnings: applied.warnings || [],
      };
    }

    await store.updatePrefs({ activePromptId: target.id });
    return {
      ok: true,
      activePromptId: target.id,
      rulesTokens: applied.tokens,
      warnings: applied.warnings || [],
    };
  });

  register('POST', '/api/prompts/import', async (data = {}) => {
    const rawFilename = typeof data.filename === 'string' ? data.filename.trim() : 'custom.md';
    const cleanFilename = path.basename(rawFilename) || 'custom.md';
    if (!/\.(md|markdown)$/i.test(cleanFilename)) {
      return {
        ok: false,
        blocked: true,
        reason: '仅支持导入 .md 或 .markdown 纯文本文件。',
        warnings: [],
      };
    }

    const inspection = inspectMarkdownSecurity(data.content);
    if (!inspection.safe || inspection.blocked) {
      return {
        ok: false,
        blocked: true,
        reason: inspection.reason || '检测到不安全指令或风控敏感特征，已拦截导入。',
        reasons: inspection.reasons || [],
        warnings: inspection.warnings || [],
      };
    }

    const displayName =
      typeof data.name === 'string' && data.name.trim()
        ? data.name.trim().slice(0, 80)
        : deriveMarkdownTitle(inspection.sanitized, cleanFilename);
    const tokens = estimateTokens(inspection.sanitized);

    const saved = await store.addCustomPreset({
      name: displayName,
      filename: cleanFilename,
      sanitizedContent: inspection.sanitized,
      tokens,
    });

    const applied = await applyRulesPreset(resolvedPaths, saved);
    if (!applied.ok || applied.blocked) {
      return {
        ok: false,
        blocked: true,
        reason: applied.reason || '规则写入受限',
        warnings: applied.warnings || [],
      };
    }

    await store.updatePrefs({ activePromptId: saved.id });
    return {
      ok: true,
      preset: saved,
      rulesTokens: applied.tokens,
      warnings: [...(inspection.warnings || []), ...(applied.warnings || [])],
    };
  });

  register('POST', '/api/sessions/focus', async (data = {}) => {
    const conversationId = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
    if (!conversationId || conversationId.length > 128) {
      return errorResponse(ResponseCtor, 400, 'conversationId 不能为空');
    }
    const title = typeof data.title === 'string' ? data.title.trim().slice(0, 160) : '';
    const workspace = typeof data.workspace === 'string' ? data.workspace.trim().slice(0, 160) : '';
    if (resolvedPaths.hudActiveViewFile) {
      await atomicWriteJson(resolvedPaths.hudActiveViewFile, {
        conversationId,
        workspace,
        title,
        source: 'sidecar_focus',
        updatedAtMs: Date.now(),
      }).catch(() => {});
    }
    hud.setActiveHostConv?.(conversationId);
    await hud.refreshFromDb();
    return { ok: true, conversationId };
  });

  register('POST', '/api/hud/console-viewport', async (data = {}) => {
    const paneId =
      typeof data.paneId === 'string' && data.paneId.trim()
        ? data.paneId.trim().slice(0, 40)
        : 'default';
    const visible = Boolean(data.visible);
    const physW = visible ? Math.max(0, Math.min(16384, Math.round(Number(data.physW) || 0))) : 0;
    const physH = visible ? Math.max(0, Math.min(16384, Math.round(Number(data.physH) || 0))) : 0;
    const outerW = visible ? Math.max(0, Math.min(16384, Math.round(Number(data.outerW) || 0))) : 0;
    if (visible && physW > 0) {
      consoleViewports.set(paneId, {
        visible: true,
        physW,
        physH,
        outerW,
        updatedAtMs: Date.now(),
      });
    } else {
      consoleViewports.delete(paneId);
    }
    await flushConsoleViewportFile(false);
    return { ok: true, visible: Boolean(visible && physW > 0), physW };
  });

  register('POST', '/api/sessions/mark-read', async (data = {}) => {
    const conversationId = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
    if (!conversationId) {
      return errorResponse(ResponseCtor, 400, 'conversationId 不能为空');
    }
    const res = await markRead(store, {
      conversationId,
      modifiedMs: data.modifiedMs,
    });
    return { ok: true, conversationId: res.conversationId, modifiedMs: res.modifiedMs };
  });

  register('POST', '/api/sessions/favorites', async (data = {}) => {
    if (!Array.isArray(data.favoriteIds)) {
      return errorResponse(ResponseCtor, 400, 'favoriteIds 必须为数组');
    }
    const favoriteTitles =
      data.favoriteTitles && typeof data.favoriteTitles === 'object' && !Array.isArray(data.favoriteTitles)
        ? data.favoriteTitles
        : undefined;
    const res = await setFavorites(store, {
      favoriteIds: data.favoriteIds,
      favoriteTitles,
    });
    return { ok: true, favoriteIds: res.favoriteIds };
  });

  register('POST', '/api/preferences/window-cap', async (data = {}) => {
    const cap = Number(data.windowCap);
    if (!ALLOWED_WINDOW_CAPS.has(cap)) {
      return errorResponse(ResponseCtor, 400, '仅支持 256k / 512k / 1M 上下文窗口上限');
    }
    await store.updatePrefs({ windowCap: cap });
    void hud.refreshFromDb();
    return { ok: true, windowCap: cap };
  });

  register('GET', '/api/mastery', async (data = {}) => {
    const requestedSessionId =
      typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
    const [sessionsHub, sessionsMeta, summariesCache, publicCfg] = await Promise.all([
      querySessionsHub(resolvedPaths.summariesDbPath, store, {}),
      store.getSessionsMeta(),
      masterySummarizer.getCache(),
      store.getPublicMasteryConfig(),
    ]);
    const snapshot = await buildMasterySnapshot(resolvedPaths, sessionsHub, {
      selectedSessionId: requestedSessionId,
      sessionsMeta,
      summariesCache: publicCfg.enabled && publicCfg.source === 'thirdparty' ? summariesCache : {},
    });
    if (snapshot.detailSession && publicCfg.enabled && publicCfg.source === 'thirdparty') {
      void masterySummarizer.maybeSchedule(snapshot.detailSession);
    }
    return {
      ok: true,
      ...snapshot,
      config: publicCfg,
    };
  });

  register('POST', '/api/mastery/mark-read', async (data = {}) => {
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
    const agentConvId = typeof data.agentConvId === 'string' ? data.agentConvId.trim() : '';
    const markSessionRead = Boolean(data.markSessionRead);
    const ts = Math.max(Date.now(), Number(data.modifiedMs) || 0);
    if (!sessionId && !agentConvId) {
      return errorResponse(ResponseCtor, 400, 'sessionId 或 agentConvId 不能为空');
    }

    await store.updateSessionsMeta((current) => {
      const nextAgents = { ...(current.lastSeenByAgent || {}) };
      if (agentConvId) {
        nextAgents[agentConvId] = Math.max(nextAgents[agentConvId] || 0, ts);
      }
      const nextConvs = { ...(current.lastSeenModifiedMs || {}) };
      if (markSessionRead && sessionId) {
        nextConvs[sessionId] = Math.max(nextConvs[sessionId] || 0, ts);
      }
      return {
        ...current,
        lastSeenByAgent: nextAgents,
        lastSeenModifiedMs: nextConvs,
        lastSeenByConv: nextConvs,
      };
    });
    return { ok: true, sessionId, agentConvId, markSessionRead };
  });

  register('POST', '/api/mastery/open-path', async (data = {}) => {
    const rawTarget =
      typeof data.targetPath === 'string'
        ? data.targetPath
        : typeof data.path === 'string'
          ? data.path
          : '';
    const mode = data.mode === 'file' ? 'file' : 'folder';
    const result = await openLocalPathTarget(rawTarget, { mode });
    if (!result.ok) {
      return errorResponse(ResponseCtor, result.status || 400, result.error || '打开路径失败');
    }
    return result;
  });

  register('GET', '/api/mastery/local-image', async (data = {}) => {
    const rawTarget = typeof data.path === 'string' ? data.path : '';
    const format = typeof data.format === 'string' ? data.format.trim().toLowerCase() : '';
    const resolved = resolveLocalTargetPath(rawTarget);
    if (!resolved) {
      return errorResponse(ResponseCtor, 400, '无效的图片路径');
    }
    const ext = path.extname(resolved).toLowerCase();
    const isBmp = ext === '.bmp';
    if (!ALLOWED_RASTER_EXT_MIME.has(ext) && !isBmp) {
      return errorResponse(ResponseCtor, 403, '仅允许预览常见位图图片格式');
    }
    try {
      const st = await fs.stat(resolved);
      if (!st.isFile() || st.size <= 0 || st.size > 15 * 1024 * 1024) {
        return errorResponse(ResponseCtor, 404, '图片文件不存在或超出预览大小限制');
      }
      const buf = await fs.readFile(resolved);
      let mime = detectRasterMagic(buf);
      if (!mime && isBmp && buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
        mime = 'image/bmp';
      }
      if (!mime) {
        return errorResponse(ResponseCtor, 415, '文件内容不是有效的位图图片');
      }
      if (format === 'json') {
        return {
          ok: true,
          mime,
          size: buf.length,
          dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        };
      }
      return makeResponse(ResponseCtor, buf, {
        status: 200,
        contentType: mime,
        headers: {
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=60',
        },
      });
    } catch {
      return errorResponse(ResponseCtor, 404, '图片文件不存在或无法读取');
    }
  });

  register('POST', '/api/mastery/lightbox-preview', async (data = {}) => {
    const rawTarget =
      typeof data.targetPath === 'string'
        ? data.targetPath
        : typeof data.path === 'string'
          ? data.path
          : '';
    const rawLabel = typeof data.label === 'string' ? data.label.trim().slice(0, 180) : '';
    const resolved = resolveLocalTargetPath(rawTarget);
    if (!resolved) {
      return errorResponse(ResponseCtor, 400, '无效的图片路径');
    }
    const ext = path.extname(resolved).toLowerCase();
    const isBmp = ext === '.bmp';
    if (!ALLOWED_RASTER_EXT_MIME.has(ext) && !isBmp) {
      return errorResponse(ResponseCtor, 403, '仅允许预览常见位图图片格式');
    }
    try {
      const st = await fs.stat(resolved);
      if (!st.isFile() || st.size <= 0 || st.size > 15 * 1024 * 1024) {
        return errorResponse(ResponseCtor, 404, '图片文件不存在或超出预览大小限制');
      }
    } catch {
      return errorResponse(ResponseCtor, 404, '图片文件不存在或无法读取');
    }

    const hostEnv = detectWindowsHostEnv();
    if (hostEnv.hasWindowsHost && resolvedPaths.lightboxCmdFile) {
      try {
        const themes = await store.getThemes();
        const status = await getBackdropStatus(resolvedPaths, themes);
        if (status.running && status.supportsLightbox && status.trackedCount > 0) {
          const winImagePath = hostEnv.isWsl ? await toWindowsPath(resolved, hostEnv) : resolved;
          const cmd = {
            id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            ts: Date.now(),
            path: winImagePath || resolved,
            label: rawLabel || path.basename(resolved),
          };
          await atomicWriteJson(resolvedPaths.lightboxCmdFile, cmd);
          return { ok: true, mode: 'native', path: resolved, id: cmd.id };
        }
      } catch {
        // Fall through cleanly to in-sidecar webview lightbox
      }
    }

    return { ok: true, mode: 'webview', path: resolved };
  });

  register('GET', '/api/mastery/composer/commands', async () => {
    const commands = await listSlashCommands(resolvedPaths);
    return { ok: true, commands };
  });

  register('POST', '/api/mastery/composer/send', async (data = {}) => {
    const conversationId =
      typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
    if (!conversationId || !/^[a-zA-Z0-9_-]{4,128}$/.test(conversationId)) {
      return errorResponse(ResponseCtor, 400, '目标会话 ID 无效');
    }

    const rawPrompt = typeof data.prompt === 'string' ? data.prompt : '';
    const prompt = rawPrompt.replace(/\r\n?/g, '\n').trim();
    if (prompt.length > MAX_COMPOSER_PROMPT_CHARS) {
      return errorResponse(ResponseCtor, 400, `提示词过长，请控制在 ${MAX_COMPOSER_PROMPT_CHARS} 字符以内`);
    }

    const rawImages = Array.isArray(data.images) ? data.images : [];
    if (!prompt && rawImages.length === 0) {
      return errorResponse(ResponseCtor, 400, '请输入提示词或粘贴至少一张图片');
    }

    if (typeof sidecarBridge?.sendMessage !== 'function') {
      return errorResponse(ResponseCtor, 503, '当前运行环境不支持通过 agentapi 向会话发送消息');
    }

    const savedImgRes = await saveComposerImages(resolvedPaths, rawImages);
    if (!savedImgRes.ok) {
      return errorResponse(ResponseCtor, savedImgRes.status || 400, savedImgRes.error || '保存粘贴图片失败');
    }

    const commands = await listSlashCommands(resolvedPaths);
    const slashCommand = matchLeadingSlashCommand(prompt, commands);
    const outboundMessage = composeOutboundMessage({
      prompt,
      savedImages: savedImgRes.saved,
      slashCommand,
    });

    let projectId =
      typeof data.projectId === 'string' && data.projectId.trim()
        ? data.projectId.trim()
        : sidecarBridge?.getConfig?.()?.projectId || '';
    if (!projectId && typeof sidecarBridge?.getConversationMetadata === 'function') {
      try {
        const metaResp = await sidecarBridge.getConversationMetadata(conversationId);
        const metaEvent =
          metaResp?.response?.conversationMetadata || metaResp?.response?.conversation_metadata;
        const resolvedProj =
          metaEvent?.metadata?.projectId || metaEvent?.metadata?.project_id || '';
        if (resolvedProj) projectId = resolvedProj;
      } catch {
        // Non-fatal: proceed without explicit projectId override
      }
    }

    try {
      const resp = await sidecarBridge.sendMessage(conversationId, outboundMessage, {
        title: 'AGY 控制台',
        ...(projectId ? { projectId } : {}),
      });
      triggerRescan?.();
      return {
        ok: true,
        conversationId,
        savedImages: savedImgRes.saved,
        matchedCommand: slashCommand?.name || null,
        response: resp && typeof resp === 'object' ? resp : {},
      };
    } catch (err) {
      return errorResponse(
        ResponseCtor,
        502,
        `发送消息失败：${sanitizeErrorMessage(err, 'agentapi send-message 调用失败')}`,
      );
    }
  });

  register('POST', '/api/mastery/config', async (data = {}) => {
    try {
      const updated = await store.updateMasteryConfig(data);
      return {
        ok: true,
        config: sanitizePublicMasteryConfig(updated),
      };
    } catch (err) {
      return errorResponse(ResponseCtor, 400, sanitizeErrorMessage(err, '保存掌握页配置失败'));
    }
  });

  const resolveSameOriginSavedKey = (saved, rawBaseUrl, rawApiKey) => {
    if (typeof rawApiKey === 'string' && rawApiKey.trim()) {
      return rawApiKey.trim();
    }
    const candidate = typeof rawBaseUrl === 'string' && rawBaseUrl.trim() ? rawBaseUrl.trim() : '';
    if (!candidate) return saved.thirdParty.apiKey;
    try {
      const a = new URL(candidate);
      const b = new URL(saved.thirdParty.baseUrl);
      if (a.origin.toLowerCase() === b.origin.toLowerCase()) {
        return saved.thirdParty.apiKey;
      }
    } catch {
      // Malformed URL: never attach saved API key
    }
    return '';
  };

  register('POST', '/api/mastery/thirdparty/models', async (data = {}) => {
    try {
      const saved = await store.getMasteryConfig();
      const protocol =
        data.protocol === 'anthropic' || data.protocol === 'openai'
          ? data.protocol
          : saved.thirdParty.protocol;
      const baseUrl =
        typeof data.baseUrl === 'string' && data.baseUrl.trim()
          ? data.baseUrl.trim()
          : saved.thirdParty.baseUrl;
      const apiKey = resolveSameOriginSavedKey(saved, data.baseUrl, data.apiKey);
      const result = await fetchThirdPartyModels({ protocol, baseUrl, apiKey });
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, 400, sanitizeErrorMessage(err, '拉取模型列表失败'));
    }
  });

  register('POST', '/api/mastery/thirdparty/test', async (data = {}) => {
    try {
      const saved = await store.getMasteryConfig();
      const protocol =
        data.protocol === 'anthropic' || data.protocol === 'openai'
          ? data.protocol
          : saved.thirdParty.protocol;
      const baseUrl =
        typeof data.baseUrl === 'string' && data.baseUrl.trim()
          ? data.baseUrl.trim()
          : saved.thirdParty.baseUrl;
      const apiKey = resolveSameOriginSavedKey(saved, data.baseUrl, data.apiKey);
      const model =
        typeof data.model === 'string' && data.model.trim()
          ? data.model.trim()
          : saved.thirdParty.selectedModel;
      const thinking =
        typeof data.thinking === 'string' && data.thinking.trim()
          ? data.thinking.trim()
          : saved.thinking;
      const result = await testThirdPartyConnection({
        protocol,
        baseUrl,
        apiKey,
        model,
        thinking,
      });
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, 400, sanitizeErrorMessage(err, '连通测试失败'));
    }
  });

  register('GET', '/api/theme/backdrop/status', async () => {
    const [themes, prefs] = await Promise.all([store.getThemes(), store.getPrefs()]);
    const rawStatus = await getBackdropStatus(resolvedPaths, themes);
    const cdpStatus =
      themes.hostThemeMode === 'cdp'
        ? await cdp.sync(themes, { hostLanguage: prefs.language })
        : cdp.getStatus(themes);
    return {
      ok: true,
      status: {
        ...rawStatus,
        cdp: cdpStatus,
      },
    };
  });

  register('POST', '/api/theme/backdrop/action', async (data = {}) => {
    const action = typeof data.action === 'string' ? data.action.trim() : 'prepare';
    const patch = {};
    if (typeof data.backdropEnabled === 'boolean') {
      patch.backdropEnabled = data.backdropEnabled;
    } else if (action === 'start') {
      patch.backdropEnabled = true;
    } else if (action === 'stop') {
      patch.backdropEnabled = false;
    }
    if (typeof data.hudEnabled === 'boolean') {
      patch.hudEnabled = data.hudEnabled;
    }
    if (data.hostThemeMode === 'cdp' || data.hostThemeMode === 'backdrop') {
      patch.hostThemeMode = data.hostThemeMode;
    }
    if (typeof data.cdpPort === 'number' && Number.isFinite(data.cdpPort)) {
      patch.cdpPort = data.cdpPort;
    }
    if (typeof data.hostBlendPct === 'number' && Number.isFinite(data.hostBlendPct)) {
      patch.hostBlendPct = data.hostBlendPct;
    }

    const [themes, prefs] = await Promise.all([
      Object.keys(patch).length > 0 ? store.saveThemes(patch) : store.getThemes(),
      store.getPrefs(),
    ]);
    const effectiveCompanionAction =
      action === 'stop' && themes.hudEnabled !== false ? 'sync' : action;
    const [result, cdpStatus] = await Promise.all([
      action === 'cdp_sync'
        ? getBackdropStatus(resolvedPaths, themes).then((status) => ({ ok: true, status }))
        : controlBackdropCompanion(resolvedPaths, themes, effectiveCompanionAction),
      cdp.sync(themes, { hostLanguage: prefs.language }),
    ]);
    void hud.refreshFromDb();
    return {
      ...result,
      status: {
        ...(result.status || {}),
        cdp: cdpStatus,
      },
      themeState: {
        ...themes,
        hostThemeSynced: false,
      },
    };
  });

  register('POST', '/api/theme/save', async (data = {}) => {
    const incomingState = data.themeState && typeof data.themeState === 'object' ? data.themeState : {};
    const saveAsName =
      typeof data.saveAsNewPaletteName === 'string' ? data.saveAsNewPaletteName.trim() : '';

    try {
      let themes = await store.saveThemes(incomingState);
      if (saveAsName) {
        const created = await store.addCustomPalette({
          name: saveAsName,
          colors: incomingState.colors || themes.colors,
        });
        themes = created.themes;
      }

      const [prefs, initialBdStatus] = await Promise.all([
        store.getPrefs(),
        getBackdropStatus(resolvedPaths, themes),
      ]);
      let backdropStatus = initialBdStatus;
      const wantRunning = Boolean(
        (themes.backdropEnabled && themes.activeWallpaperId) || themes.hudEnabled !== false,
      );
      if (backdropStatus.canAutoLaunch && backdropStatus.compiled && wantRunning !== backdropStatus.running) {
        const ctrl = await controlBackdropCompanion(resolvedPaths, themes, 'sync').catch(() => null);
        if (ctrl?.status) {
          backdropStatus = ctrl.status;
        }
      }

      const cdpStatus = await cdp
        .sync(themes, { hostLanguage: prefs.language })
        .catch(() => cdp.getStatus(themes));
      const seedsPreview = buildHostThemeSeedsPreview(themes.colors);
      return {
        ok: true,
        themeState: themes,
        hostThemeSynced: false,
        backdropStatus: {
          ...backdropStatus,
          cdp: cdpStatus,
        },
        ...(seedsPreview.ok ? { seedsPreview } : {}),
      };
    } catch (err) {
      return errorResponse(ResponseCtor, mapStorageErrorStatus(err), err);
    }
  });

  register('POST', '/api/theme/palette/delete', async (data = {}) => {
    const paletteId = typeof data.paletteId === 'string' ? data.paletteId.trim() : '';
    if (!paletteId) {
      return errorResponse(ResponseCtor, 400, 'paletteId 不能为空');
    }
    try {
      const res = await store.deleteCustomPalette(paletteId);
      return { ok: true, themeState: res.themes, hostThemeSynced: false };
    } catch (err) {
      return errorResponse(ResponseCtor, mapStorageErrorStatus(err), err);
    }
  });

  register('POST', '/api/theme/wallpaper/upload', async (data = {}) => {
    const check = validateRasterUpload({
      name: data.name,
      mime: data.mime,
      base64: data.base64,
    });
    if (!check.ok) {
      return errorResponse(ResponseCtor, check.status, check.error);
    }

    let thumbPayload = null;
    if (typeof data.thumbBase64 === 'string' && data.thumbBase64.trim()) {
      const thumbCheck = validateRasterUpload({
        name: 'thumb',
        mime: data.thumbMime || check.mime,
        base64: data.thumbBase64,
        maxBytes: MAX_THUMB_UPLOAD_BYTES,
      });
      if (!thumbCheck.ok) {
        return errorResponse(ResponseCtor, thumbCheck.status, thumbCheck.error);
      }
      thumbPayload = {
        thumbBase64: thumbCheck.base64,
        thumbMime: thumbCheck.mime,
      };
    }

    try {
      const saved = await store.saveCustomWallpaperFile({
        name: check.name,
        mime: check.mime,
        base64: check.base64,
        ...(thumbPayload || {}),
      });
      return { ok: true, wallpaper: saved.wallpaper, themeState: saved.themes };
    } catch (err) {
      return errorResponse(ResponseCtor, mapStorageErrorStatus(err), err);
    }
  });

  register('POST', '/api/theme/wallpaper/delete', async (data = {}) => {
    const wallpaperId = typeof data.wallpaperId === 'string' ? data.wallpaperId.trim() : '';
    if (!wallpaperId) {
      return errorResponse(ResponseCtor, 400, 'wallpaperId 不能为空');
    }
    try {
      const res = await store.deleteCustomWallpaperFile(wallpaperId);
      return { ok: true, themeState: res.themes };
    } catch (err) {
      return errorResponse(ResponseCtor, mapStorageErrorStatus(err), err);
    }
  });

  register('POST', '/api/language', async (data = {}) => {
    const language = typeof data.language === 'string' ? data.language.trim() : '';
    if (!VALID_LANGUAGES.has(language)) {
      return errorResponse(ResponseCtor, 400, '不支持的语言代码，仅支持 zh-CN 或 en');
    }
    await store.updatePrefs({ language });
    const themes = await store.getThemes();
    const cdpStatus = await cdp.syncHostLanguage(language, themes).catch(() => cdp.getStatus(themes));
    return { ok: true, language, cdp: cdpStatus };
  });

  register('GET', '/api/update/status', async (data = {}) => {
    const force = data.force === '1' || data.force === 'true' || data.force === true;
    return checkForUpdates(resolvedPaths, { force });
  });

  register('POST', '/api/update/apply', async () => {
    const result = await applyPluginUpdate(resolvedPaths);
    if (!result.ok) {
      return errorResponse(ResponseCtor, result.status || 500, result.error || '自动更新失败');
    }
    return result;
  });

  register('POST', '/api/update/open-repo', async () => {
    const result = openRepoInBrowser();
    if (!result.ok) {
      return errorResponse(ResponseCtor, result.status || 500, result.error || '打开项目主页失败');
    }
    return result;
  });

  // ---- Multi-Account Management (DPAPI Vault + Detached Safe Switch + Auto-Resume) ----
  register('GET', '/api/accounts', async () => {
    try {
      return await accounts.listAccounts();
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/settings', async (data = {}) => {
    try {
      const result = await accounts.updateAccountSettings(data);
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '保存账号设置失败');
      }
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/capture', async (data = {}) => {
    try {
      const result = await accounts.captureCurrentAccount({
        remark: typeof data.remark === 'string' ? data.remark : '',
        source: 'capture',
      });
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '捕获当前账号失败');
      }
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/oauth-add', async () => {
    try {
      const result = await accounts.startOauthWatch();
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '开启 OAuth 新号监听失败');
      }
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/oauth-watch/stop', async () => {
    try {
      return await accounts.stopOauthWatch();
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/oauth-direct/start', async (data = {}) => {
    try {
      const remark = typeof data.remark === 'string' ? data.remark : '';
      const result = await accounts.startDirectBrowserOauth({ remark });
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '开启浏览器 OAuth 授权失败');
      }
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('GET', '/api/accounts/oauth-direct/status', async () => {
    try {
      return accounts.getDirectBrowserOauthStatus();
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/oauth-direct/cancel', async () => {
    try {
      return await accounts.cancelDirectBrowserOauth();
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/import', async (data = {}) => {
    try {
      const result = await accounts.importAccounts({
        rawInput: data.rawInput ?? data.text ?? data.payload ?? '',
        email: typeof data.email === 'string' ? data.email : '',
        remark: typeof data.remark === 'string' ? data.remark : '',
      });
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '导入账号失败');
      }
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/toggle', async (data = {}) => {
    try {
      const result = await accounts.toggleAccountEnabled(data.accountId, data.enabled);
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '切换账号启用状态失败');
      }
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/remark', async (data = {}) => {
    try {
      const result = await accounts.updateAccountRemark(data.accountId, data.remark ?? '');
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '保存备注失败');
      }
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/delete', async (data = {}) => {
    try {
      const result = await accounts.deleteAccount(data.accountId);
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '删除账号失败');
      }
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/export', async (data = {}) => {
    try {
      const result = await accounts.exportAccountJson(data.accountId);
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '导出账号 JSON 失败');
      }
      return makeResponse(ResponseCtor, result, {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/refresh-quota', async (data = {}) => {
    try {
      const result = await accounts.refreshAccountQuota(data.accountId);
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '刷新账号额度失败', {
          account: result.account || null,
        });
      }
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/switch', async (data = {}) => {
    try {
      const result = await accounts.switchAccount({
        accountId: data.accountId,
        autoResume: data.autoResume !== false,
        resumePrompt: typeof data.resumePrompt === 'string' ? data.resumePrompt : undefined,
      });
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '切换账号失败');
      }
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/rollback', async () => {
    try {
      const result = await accounts.rollbackLatestBackup();
      if (!result.ok) {
        return errorResponse(ResponseCtor, result.status || 400, result.error || '回滚备份失败');
      }
      return result;
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  register('POST', '/api/accounts/cancel-resume', async () => {
    try {
      return await accounts.cancelPendingResume();
    } catch (err) {
      return errorResponse(ResponseCtor, err?.status || 500, err);
    }
  });

  // Mount optional pluggable extensions (each isolated in extensions/<name>/)
  if (process.env.AGY_DISABLE_EXTENSIONS !== '1' && process.env.AGY_DISABLE_EXTENSIONS !== 'true') {
    for (const ext of installedExtensions) {
      if (typeof ext?.registerRoutes !== 'function') continue;
      try {
        ext.registerRoutes({
          register,
          paths: resolvedPaths,
          storage: store,
          makeResponse: (body, opts) => makeResponse(ResponseCtor, body, opts),
          errorResponse: (status, err, extra) => errorResponse(ResponseCtor, status, err, extra),
        });
      } catch (err) {
        console.warn(`[extensions] route registration failed for "${ext.id}": ${err?.message || err}`);
      }
    }
  }

  return routes;
}

function spawnWorkerSupervisor(paths, { scanIntervalMs = 2000, onUpdated } = {}) {
  let child = null;
  let stopped = false;
  let restartTimer = null;
  let backoffMs = 500;

  const launch = () => {
    if (stopped) return;
    child = fork(WORKER_PATH, [], {
      execArgv: [],
      env: {
        ...process.env,
        AGY_MONITOR_BRAIN_DIR: paths.brainDir,
        AGY_MONITOR_CONVERSATIONS_DIR: paths.conversationsDir,
        AGY_MONITOR_CACHE_DB: paths.cacheDbPath,
        AGY_MONITOR_SCAN_INTERVAL_MS: String(scanIntervalMs),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    child.stdout?.on('data', (buf) => {
      const line = buf.toString('utf8').trim();
      if (line) console.log(`[scan_worker] ${line}`);
    });
    child.stderr?.on('data', (buf) => {
      const line = buf.toString('utf8').trim();
      if (line) console.error(`[scan_worker] ${line}`);
    });
    child.on('error', (err) => {
      console.error(`[scan_worker] process error: ${err?.message || err}`);
    });
    child.on('message', (msg) => {
      if (msg?.type === 'updated') {
        backoffMs = 500;
        onUpdated?.(msg);
      } else if (msg?.type === 'error') {
        console.error(`[scan_worker] ${msg.message || 'unknown worker error'}`);
      }
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopped) return;
      console.warn(`[scan_worker] exited (code=${code}, signal=${signal}); restarting in ${backoffMs}ms`);
      restartTimer = setTimeout(() => {
        backoffMs = Math.min(backoffMs * 2, 10000);
        launch();
      }, backoffMs);
      restartTimer.unref?.();
    });
  };

  launch();

  return {
    rescan() {
      if (child && child.connected) {
        try {
          child.send({ type: 'rescan', forceNotify: true });
        } catch {
          // Ignore transient IPC disconnect while worker restarts
        }
      }
    },
    async stop() {
      stopped = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (!child) return;
      const proc = child;
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore kill error
          }
          resolve();
        }, 2000);
        proc.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        try {
          if (proc.connected) {
            proc.send({ type: 'shutdown' });
          } else {
            proc.kill('SIGTERM');
          }
        } catch {
          clearTimeout(timeout);
          resolve();
        }
      });
    },
  };
}

/**
 * Attach permissive loopback CORS headers and token-free OPTIONS preflight handling
 * so sandboxed AUX_PANE iframes (opaque "null" origin) can load ES modules and fetch
 * with X-Sidecar-Token, while preserving token checks on state-changing requests.
 */
function attachCorsAndPreflight(server) {
  if (!server || typeof server.listeners !== 'function') return;
  const existing = server.listeners('request');
  if (existing.length === 0) return;
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');
    res.setHeader('Access-Control-Max-Age', '600');
    if (String(req.method || '').toUpperCase() === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    for (const listener of existing) {
      listener.call(server, req, res);
    }
  });
}

/**
 * Boot the Antigravity Sidecar server + background transcript scan_worker.
 */
export async function startSidecarServer({
  pathsOverrides = {},
  scanIntervalMs = 2000,
  skipWorker = false,
} = {}) {
  const { SidecarApp, Response } = await loadSidecarSdk();
  const app = new SidecarApp();
  const paths = resolvePaths(pathsOverrides);
  const storage = createStorage(paths);
  let hudPublisher = null;
  const cdpBridge = createCdpThemeBridge(paths, {
    onHudStateChange() {
      void hudPublisher?.refreshFromDb?.();
    },
  });
  hudPublisher = createHudTelemetryPublisher(paths, storage, cdpBridge);

  let latestWorkerEtag = '';
  const worker = skipWorker
    ? { rescan() {}, async stop() {} }
    : spawnWorkerSupervisor(paths, {
        scanIntervalMs,
        onUpdated(msg) {
          if (msg?.etag) latestWorkerEtag = String(msg.etag);
          void hudPublisher.refreshFromDb();
        },
      });

  const sidecarBridgeObj = {
    getConfig: () => app.config,
    startConversation: (message, opts) => app.startConversation(message, opts),
    sendMessage: (conversationId, message, opts) => app.sendMessage(conversationId, message, opts),
    getConversationMetadata: (conversationId) => app.getConversationMetadata(conversationId),
  };
  const sharedQuotaClient = createQuotaClient();
  const sharedAccountManager = createAccountManager({
    paths,
    storage,
    quotaClient: sharedQuotaClient,
    sidecarBridge: sidecarBridgeObj,
    getRunningConversations: async () => {
      const hub = await querySessionsHub(paths.summariesDbPath, storage, {});
      return Array.isArray(hub?.active)
        ? hub.active.filter((s) => s && s.id && s.status === 'running')
        : [];
    },
  });

  const routes = createMonitorHandlers({
    paths,
    storage,
    ResponseCtor: Response,
    sidecarBridge: sidecarBridgeObj,
    triggerRescan: () => worker.rescan(),
    hudPublisher,
    cdpBridge,
    quotaClient: sharedQuotaClient,
    accountManager: sharedAccountManager,
  });

  for (const [key, handler] of routes.entries()) {
    const spaceIdx = key.indexOf(' ');
    const method = key.slice(0, spaceIdx);
    const routePath = key.slice(spaceIdx + 1);
    if (method === 'GET' && routePath === '/') {
      app.page('/', handler);
    } else {
      app.api(routePath, handler, method);
    }
  }

  const server = await app.run();
  attachCorsAndPreflight(server);

  // Materialize default preferences/themes/mastery config on first run (never overwrites user changes)
  void Promise.all([
    storage.getPrefs(),
    storage.getThemes(),
    storage.getMasteryConfig(),
  ]).catch(() => {});

  if (process.env.AGY_DISABLE_EXTENSIONS !== '1' && process.env.AGY_DISABLE_EXTENSIONS !== 'true') {
    for (const ext of installedExtensions) {
      if (typeof ext?.onStart === 'function') {
        void Promise.resolve(ext.onStart({ paths, storage, skipWorker })).catch(() => {});
      }
    }
  }

  void hudPublisher.refreshFromDb();

  let activeViewWatcher = null;
  let activeViewTimer = null;
  if (!skipWorker && paths.pluginDataDir) {
    try {
      activeViewWatcher = fsSync.watch(paths.pluginDataDir, (_evt, filename) => {
        if (!filename || String(filename).toLowerCase() === 'hud_active_view.json') {
          clearTimeout(activeViewTimer);
          activeViewTimer = setTimeout(() => {
            void hudPublisher.refreshFromDb();
          }, 25);
        }
      });
      activeViewWatcher.on?.('error', () => {});
    } catch {
      activeViewWatcher = null;
    }
  }

  const startupHostEnv = detectWindowsHostEnv();
  let companionWatchdogTimer = null;
  let companionRestartFailures = 0;
  let companionWatchdogBusy = false;

  const ensureCompanionHealthy = async () => {
    if (companionWatchdogBusy) return;
    companionWatchdogBusy = true;
    try {
      const themes = await storage.getThemes();
      const wantStart = Boolean(
        (themes.backdropEnabled && themes.activeWallpaperId) || themes.hudEnabled !== false,
      );
      if (!wantStart) {
        companionRestartFailures = 0;
        return;
      }
      const status = await getBackdropStatus(paths, themes);
      if (status.running) {
        companionRestartFailures = 0;
        return;
      }
      if (!status.canAutoLaunch) {
        return;
      }
      if (companionRestartFailures < 3) {
        const res = await controlBackdropCompanion(paths, themes, 'start');
        if (res?.status?.running) {
          companionRestartFailures = 0;
        } else {
          companionRestartFailures += 1;
          if (companionRestartFailures >= 3) {
            // Stop retry storm and guarantee host windows are never left translucent
            await restoreHostOpacityFallback(paths);
          }
        }
      }
    } catch {
      // Non-fatal watchdog tick
    } finally {
      companionWatchdogBusy = false;
    }
  };

  if (!skipWorker && startupHostEnv.hasWindowsHost) {
    void (async () => {
      try {
        await ensureBackdropAssets(paths);
        await ensureAccountTool(paths).catch(() => {});
        const [themes, prefs] = await Promise.all([storage.getThemes(), storage.getPrefs()]);
        await ensureCdpLauncher(paths, themes.cdpPort);
        await cdpBridge.sync(themes, { hostLanguage: prefs.language, probeForLang: true });
        await hudPublisher.refreshFromDb();
        await ensureCompanionHealthy();
      } catch {
        // Non-fatal backdrop companion prep error
      }
    })();

    sharedAccountManager.startLifecycleWatcher({ intervalMs: 2000 });

    companionWatchdogTimer = setInterval(() => {
      void ensureCompanionHealthy();
    }, 15_000);
    companionWatchdogTimer.unref?.();
  }

  const shutdown = async () => {
    clearTimeout(activeViewTimer);
    sharedAccountManager.stopLifecycleWatcher();
    if (companionWatchdogTimer) {
      clearInterval(companionWatchdogTimer);
      companionWatchdogTimer = null;
    }
    try {
      activeViewWatcher?.close?.();
    } catch {
      // Ignore watcher close error
    }
    await cdpBridge.dispose().catch(() => {});
    for (const ext of installedExtensions) {
      if (typeof ext?.onShutdown === 'function') {
        await Promise.resolve(ext.onShutdown({ paths, storage, skipWorker })).catch(() => {});
      }
    }
    if (!skipWorker && startupHostEnv.hasWindowsHost) {
      try {
        const themes = await storage.getThemes();
        const status = await getBackdropStatus(paths, themes);
        if (status.canAutoLaunch && status.running) {
          await controlBackdropCompanion(paths, themes, 'stop');
        }
      } catch {
        // Ignore companion shutdown error
      }
    }
    await worker.stop();
    await app.close();
  };

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  return {
    app,
    server,
    paths,
    storage,
    getLatestWorkerEtag: () => latestWorkerEtag,
    shutdown,
  };
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  await startSidecarServer();
}
