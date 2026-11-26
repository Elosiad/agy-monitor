import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteBuffer, atomicWriteJson } from './paths.mjs';

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const VALID_LANGUAGES = new Set(['zh-CN', 'en']);
export const VALID_WP_FITS = new Set(['cover', 'contain']);

const ALLOWED_IMAGE_MIMES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

export const BUILTIN_PALETTES = Object.freeze([
  Object.freeze({
    id: 'default',
    name: '默认深空',
    nameEn: 'Default Deep',
    builtin: true,
    colors: Object.freeze({
      accent: '#5B8CFF',
      contrast: '#E5A84B',
      tertiary: '#3DC2A7',
      canvas: '#14161D',
      chrome: '#1B1E28',
      bubble: '#212533',
    }),
  }),
  Object.freeze({
    id: 'cinnabar',
    name: '朱砂暗红',
    nameEn: 'Cinnabar Dark',
    builtin: true,
    colors: Object.freeze({
      accent: '#E05A4E',
      contrast: '#E5B567',
      tertiary: '#45B8AC',
      canvas: '#191516',
      chrome: '#221C1D',
      bubble: '#292123',
    }),
  }),
  Object.freeze({
    id: 'forest',
    name: '冷杉森绿',
    nameEn: 'Pine Forest',
    builtin: true,
    colors: Object.freeze({
      accent: '#4CAF7A',
      contrast: '#D9A05B',
      tertiary: '#5BB5C9',
      canvas: '#131A17',
      chrome: '#1A2420',
      bubble: '#202D28',
    }),
  }),
  Object.freeze({
    id: 'cobalt',
    name: '钴蓝夜海',
    nameEn: 'Cobalt Night',
    builtin: true,
    colors: Object.freeze({
      accent: '#3B9EFF',
      contrast: '#F2994A',
      tertiary: '#7C6FE6',
      canvas: '#121822',
      chrome: '#18202D',
      bubble: '#1F293A',
    }),
  }),
  Object.freeze({
    id: 'plum',
    name: '幽兰紫雾',
    nameEn: 'Orchid Mist',
    builtin: true,
    colors: Object.freeze({
      accent: '#9B72F2',
      contrast: '#E69F66',
      tertiary: '#48C4B0',
      canvas: '#18131E',
      chrome: '#211B29',
      bubble: '#2A2234',
    }),
  }),
]);

export const BUILTIN_WALLPAPERS = Object.freeze([
  Object.freeze({
    id: 'wp-1',
    name: '星海夜行电车',
    nameEn: 'Starry Night Train',
    builtin: true,
    file: 'wp-1.webp',
    thumb: 'wp-1-thumb.webp',
  }),
  Object.freeze({
    id: 'wp-2',
    name: '雨夜霓虹街巷',
    nameEn: 'Rainy Neon Alley',
    builtin: true,
    file: 'wp-2.webp',
    thumb: 'wp-2-thumb.webp',
  }),
  Object.freeze({
    id: 'wp-3',
    name: '月下绯樱神社',
    nameEn: 'Moonlit Sakura Shrine',
    builtin: true,
    file: 'wp-3.webp',
    thumb: 'wp-3-thumb.webp',
  }),
  Object.freeze({
    id: 'wp-4',
    name: '天台观星少女',
    nameEn: 'Rooftop Stargazer',
    builtin: true,
    file: 'wp-4.webp',
    thumb: 'wp-4-thumb.webp',
  }),
  Object.freeze({
    id: 'wp-5',
    name: '暮色海滨车站',
    nameEn: 'Twilight Seaside Station',
    builtin: true,
    file: 'wp-5.webp',
    thumb: 'wp-5-thumb.webp',
  }),
]);

const BUILTIN_PALETTE_IDS = new Set(BUILTIN_PALETTES.map((p) => p.id));
const COLOR_KEYS = ['accent', 'contrast', 'tertiary', 'canvas', 'chrome', 'bubble'];

function clonePalette(p) {
  return {
    id: p.id,
    name: p.name,
    ...(p.nameEn ? { nameEn: p.nameEn } : {}),
    builtin: Boolean(p.builtin),
    colors: { ...p.colors },
  };
}

function defaultPrefs() {
  return {
    version: 1,
    language: 'zh-CN',
    windowCap: 512000,
    contextWindowCap: 512000,
    defaultModel: null,
    activePromptId: 'official',
    followLatestSession: true,
    quotaQueryEnabled: true,
    memoryGuard: {
      autoTrimEnabled: true,
      thresholdMb: 1800,
      intervalMin: 10,
    },
  };
}

function defaultSessionsMeta(nowMs = Date.now()) {
  return {
    version: 1,
    favoriteIds: [],
    favoriteTitles: {},
    lastSeenModifiedMs: {},
    lastSeenByConv: {},
    firstTrackWatermarkMs: nowMs,
    initializedAtMs: nowMs,
  };
}

function defaultThemesState() {
  return {
    version: 1,
    activePaletteId: 'default',
    colors: { ...BUILTIN_PALETTES[0].colors },
    customPalettes: [],
    followHostTheme: true,
    syncGlobal: true,
    backdropEnabled: true,
    hudEnabled: true,
    hudInjectionMode: 'asar',
    hudAutoReinject: true,
    zeroUiaMode: false,
    hostThemeMode: 'inject',
    cdpPort: 9229,
    hostBlendPct: 25,
    activeWallpaperId: 'wp-1',
    customWallpapers: [],
    opacity: 100,
    blur: 0,
    dim: 0,
    radius: 10,
    fit: 'cover',
  };
}

function defaultQuotaAnchors() {
  return {
    version: 1,
    currentCalibration: null,
    anchorRawTokens: null,
    anchorWeightedTokens: null,
    lastConsumedPct: null,
    lastBurnRawAtCal: null,
    lastBurnEqAtCal: null,
    calibratedAtMs: null,
    resetAtMs: null,
    sampleCount: 0,
    history: [],
    modelWeights: {},
  };
}

const VALID_MASTERY_SOURCES = new Set(['self', 'thirdparty']);
const VALID_MASTERY_FREQS = new Set(['30s', '1m', '3m', '5m']);
const VALID_MASTERY_THINKING = new Set(['off', 'low', 'medium', 'high']);
const VALID_TP_PROTOCOLS = new Set(['openai', 'anthropic']);

const DEFAULT_TP_MODELS = {
  openai: [
    'gpt-4o-mini',
    'gpt-4.1-nano',
    'gpt-4.1-mini',
    'deepseek-chat',
    'qwen-turbo-latest',
    'glm-4.5-air',
  ],
  anthropic: [
    'claude-3-5-haiku-latest',
    'claude-haiku-4-5',
    'claude-3-7-sonnet-latest',
    'claude-sonnet-4-5',
  ],
};

function defaultMasteryConfig() {
  return {
    version: 1,
    enabled: false,
    source: 'self',
    frequency: '1m',
    thinking: 'low',
    thirdParty: {
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      fetchedModels: [...DEFAULT_TP_MODELS.openai],
      selectedModel: 'gpt-4o-mini',
    },
  };
}

function normalizeMasteryConfig(raw) {
  const base = defaultMasteryConfig();
  if (!raw || typeof raw !== 'object') return base;
  const tpRaw = raw.thirdParty && typeof raw.thirdParty === 'object' ? raw.thirdParty : {};
  const protocol = VALID_TP_PROTOCOLS.has(tpRaw.protocol) ? tpRaw.protocol : base.thirdParty.protocol;
  const fallbackModels = DEFAULT_TP_MODELS[protocol] || DEFAULT_TP_MODELS.openai;
  const fetchedModels = Array.isArray(tpRaw.fetchedModels)
    ? [...new Set(tpRaw.fetchedModels.map((m) => String(m || '').trim()).filter(Boolean))].slice(0, 200)
    : [];
  const finalModels = fetchedModels.length > 0 ? fetchedModels : [...fallbackModels];
  const selectedModel =
    typeof tpRaw.selectedModel === 'string' && tpRaw.selectedModel.trim()
      ? tpRaw.selectedModel.trim().slice(0, 120)
      : finalModels[0];
  const rawUrl = typeof tpRaw.baseUrl === 'string' ? tpRaw.baseUrl.trim() : '';
  const defaultUrl = protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';

  return {
    version: 1,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    source: VALID_MASTERY_SOURCES.has(raw.source) ? raw.source : 'self',
    frequency: VALID_MASTERY_FREQS.has(raw.frequency) ? raw.frequency : '1m',
    thinking: VALID_MASTERY_THINKING.has(raw.thinking) ? raw.thinking : 'low',
    thirdParty: {
      protocol,
      baseUrl: rawUrl ? rawUrl.slice(0, 300) : defaultUrl,
      apiKey: typeof tpRaw.apiKey === 'string' ? tpRaw.apiKey.trim().slice(0, 512) : '',
      fetchedModels: finalModels,
      selectedModel,
    },
  };
}

function maskSecretKey(rawKey) {
  const k = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!k) return '';
  if (k.length <= 8) return `${k.slice(0, 2)}****`;
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

export function sanitizePublicMasteryConfig(cfg) {
  const norm = normalizeMasteryConfig(cfg);
  return {
    version: norm.version,
    enabled: norm.enabled,
    source: norm.source,
    frequency: norm.frequency,
    thinking: norm.thinking,
    thirdParty: {
      protocol: norm.thirdParty.protocol,
      baseUrl: norm.thirdParty.baseUrl,
      hasApiKey: Boolean(norm.thirdParty.apiKey),
      apiKeyMasked: maskSecretKey(norm.thirdParty.apiKey),
      fetchedModels: [...norm.thirdParty.fetchedModels],
      selectedModel: norm.thirdParty.selectedModel,
    },
  };
}

const TRANSIENT_FS_READ_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);

async function readJsonSafe(filePath, { throwOnIoError = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      try {
        return { exists: true, data: JSON.parse(raw) };
      } catch (parseErr) {
        return { exists: true, data: null, parseError: parseErr };
      }
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { exists: false, data: null };
      }
      if (TRANSIENT_FS_READ_CODES.has(err?.code) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
        continue;
      }
      if (throwOnIoError) {
        throw err;
      }
      return { exists: true, data: null, readError: err };
    }
  }
  return { exists: true, data: null };
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function sanitizeColors(input, fallback) {
  const out = { ...fallback };
  if (!input || typeof input !== 'object') {
    return out;
  }
  for (const key of COLOR_KEYS) {
    if (typeof input[key] === 'string' && HEX_COLOR_RE.test(input[key].trim())) {
      out[key] = input[key].trim().toUpperCase();
    }
  }
  return out;
}

function validateStrictColors(colors) {
  if (!colors || typeof colors !== 'object') {
    throw Object.assign(new Error('colors object is required'), { code: 'INVALID_COLORS' });
  }
  const normalized = {};
  for (const key of COLOR_KEYS) {
    const val = typeof colors[key] === 'string' ? colors[key].trim() : '';
    if (!HEX_COLOR_RE.test(val)) {
      throw Object.assign(new Error(`Invalid #RRGGBB color for "${key}"`), {
        code: 'INVALID_COLOR',
      });
    }
    normalized[key] = val.toUpperCase();
  }
  return normalized;
}

function detectImageTypeByMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
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
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: GIF87a / GIF89a
  const head6 = buffer.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return 'image/gif';
  }
  // WEBP: RIFF....WEBP
  const riff = buffer.subarray(0, 4).toString('ascii');
  const webp = buffer.subarray(8, 12).toString('ascii');
  if (riff === 'RIFF' && webp === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function sanitizeDisplayName(name, fallback = 'Untitled') {
  const cleaned = String(name ?? '')
    .replace(/[\r\n\t\x00-\x1f]/g, ' ')
    .trim()
    .slice(0, 64);
  return cleaned || fallback;
}

function makeSlugId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function assertInsideDir(baseDir, candidatePath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(candidatePath);
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  if (!resolvedTarget.startsWith(prefix)) {
    throw Object.assign(new Error('Path escapes allowed storage directory'), {
      code: 'PATH_TRAVERSAL',
    });
  }
  return resolvedTarget;
}

function decodeAndVerifyRaster(rawMimeInput, rawBase64Input, maxBytes) {
  const rawMime = String(rawMimeInput ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (rawMime && !ALLOWED_IMAGE_MIMES.has(rawMime)) {
    throw Object.assign(
      new Error('Unsupported wallpaper MIME type; only PNG/JPEG/WEBP/GIF are allowed'),
      { code: 'UNSUPPORTED_MEDIA_TYPE' },
    );
  }

  let payload = String(rawBase64Input ?? '').trim();
  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/is.exec(payload);
  if (dataUrlMatch) {
    const embeddedMime = dataUrlMatch[1].trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIMES.has(embeddedMime)) {
      throw Object.assign(new Error('Unsupported embedded image MIME type'), {
        code: 'UNSUPPORTED_MEDIA_TYPE',
      });
    }
    payload = dataUrlMatch[2];
  } else if (!rawMime) {
    throw Object.assign(
      new Error('Unsupported wallpaper MIME type; only PNG/JPEG/WEBP/GIF are allowed'),
      { code: 'UNSUPPORTED_MEDIA_TYPE' },
    );
  }

  if (!payload) {
    throw Object.assign(new Error('Empty wallpaper payload'), { code: 'EMPTY_PAYLOAD' });
  }
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes) {
    throw Object.assign(
      new Error(`Wallpaper file size must be between 1B and ${maxBytes} bytes`),
      { code: 'PAYLOAD_TOO_LARGE' },
    );
  }

  const sniffedMime = detectImageTypeByMagic(buffer);
  if (!sniffedMime || !ALLOWED_IMAGE_MIMES.has(sniffedMime)) {
    throw Object.assign(
      new Error('Invalid image magic bytes; file does not match PNG/JPEG/WEBP/GIF'),
      { code: 'INVALID_IMAGE_MAGIC' },
    );
  }
  return { buffer, sniffedMime, ext: ALLOWED_IMAGE_MIMES.get(sniffedMime) };
}

/**
 * Create serialized persistent JSON + asset storage backed by plugin_data/agy-monitor.
 */
export function createStorage(paths) {
  const queues = new Map();

  function enqueue(key, task) {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(task, task);
    queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  function normalizePrefs(raw) {
    const base = defaultPrefs();
    if (!raw || typeof raw !== 'object') return base;
    const capCandidate = raw.windowCap ?? raw.contextWindowCap;
    const windowCap =
      typeof capCandidate === 'number' && Number.isFinite(capCandidate) && capCandidate >= 1000
        ? Math.round(capCandidate)
        : base.windowCap;

    let defaultModel = null;
    if (raw.defaultModel && typeof raw.defaultModel === 'object' && raw.defaultModel.id) {
      defaultModel = {
        id: String(raw.defaultModel.id).slice(0, 128),
        ...(raw.defaultModel.label ? { label: String(raw.defaultModel.label).slice(0, 128) } : {}),
        tier: String(raw.defaultModel.tier || 'standard').slice(0, 48),
      };
    }

    const rawGuard = raw.memoryGuard && typeof raw.memoryGuard === 'object' ? raw.memoryGuard : {};
    const memoryGuard = {
      autoTrimEnabled:
        typeof rawGuard.autoTrimEnabled === 'boolean'
          ? rawGuard.autoTrimEnabled
          : base.memoryGuard.autoTrimEnabled,
      thresholdMb: clampInt(rawGuard.thresholdMb, 800, 16384, base.memoryGuard.thresholdMb),
      intervalMin: clampInt(rawGuard.intervalMin, 5, 180, base.memoryGuard.intervalMin),
    };

    return {
      version: 1,
      language: VALID_LANGUAGES.has(raw.language) ? raw.language : base.language,
      windowCap,
      contextWindowCap: windowCap,
      defaultModel,
      activePromptId:
        typeof raw.activePromptId === 'string' && raw.activePromptId.trim()
          ? raw.activePromptId.trim()
          : base.activePromptId,
      followLatestSession:
        typeof raw.followLatestSession === 'boolean'
          ? raw.followLatestSession
          : base.followLatestSession,
      quotaQueryEnabled:
        typeof raw.quotaQueryEnabled === 'boolean'
          ? raw.quotaQueryEnabled
          : base.quotaQueryEnabled,
      memoryGuard,
    };
  }

  function normalizeSessionsMeta(raw, fallbackNow = Date.now()) {
    const base = defaultSessionsMeta(fallbackNow);
    if (!raw || typeof raw !== 'object') return base;

    const watermark = Number.isFinite(Number(raw.firstTrackWatermarkMs))
      ? Number(raw.firstTrackWatermarkMs)
      : Number.isFinite(Number(raw.initializedAtMs))
        ? Number(raw.initializedAtMs)
        : base.firstTrackWatermarkMs;

    const mergedMap = {};
    for (const source of [raw.lastSeenModifiedMs, raw.lastSeenByConv]) {
      if (source && typeof source === 'object') {
        for (const [convId, ts] of Object.entries(source)) {
          const num = Number(ts);
          if (convId && Number.isFinite(num) && num >= 0) {
            mergedMap[convId] = Math.max(mergedMap[convId] || 0, num);
          }
        }
      }
    }

    const favIds = Array.isArray(raw.favoriteIds)
      ? Array.from(new Set(raw.favoriteIds.map((id) => String(id).trim()).filter(Boolean)))
      : [];

    const favTitles = {};
    if (raw.favoriteTitles && typeof raw.favoriteTitles === 'object') {
      for (const [k, v] of Object.entries(raw.favoriteTitles)) {
        if (k && typeof v === 'string' && v.trim()) {
          favTitles[k] = v.trim().slice(0, 160);
        }
      }
    }

    const seenAgents = {};
    if (raw.lastSeenByAgent && typeof raw.lastSeenByAgent === 'object') {
      for (const [agentId, ts] of Object.entries(raw.lastSeenByAgent)) {
        const num = Number(ts);
        if (agentId && Number.isFinite(num) && num >= 0) {
          seenAgents[agentId] = Math.max(seenAgents[agentId] || 0, num);
        }
      }
    }

    return {
      version: 1,
      favoriteIds: favIds,
      favoriteTitles: favTitles,
      lastSeenModifiedMs: mergedMap,
      lastSeenByConv: { ...mergedMap },
      lastSeenByAgent: seenAgents,
      firstTrackWatermarkMs: watermark,
      initializedAtMs: watermark,
    };
  }

  function normalizeThemes(raw) {
    const base = defaultThemesState();
    const safeRaw = raw && typeof raw === 'object' ? raw : {};

    const customPalettes = [];
    const seenIds = new Set(BUILTIN_PALETTE_IDS);
    if (Array.isArray(safeRaw.customPalettes)) {
      for (const item of safeRaw.customPalettes) {
        if (!item || typeof item !== 'object') continue;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        customPalettes.push({
          id,
          name: sanitizeDisplayName(item.name, id),
          builtin: false,
          colors: sanitizeColors(item.colors, base.colors),
          createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
        });
      }
    }

    const palettes = [
      ...BUILTIN_PALETTES.map(clonePalette),
      ...customPalettes.map(clonePalette),
    ];

    const rawActivePaletteId =
      typeof safeRaw.activePaletteId === 'string' ? safeRaw.activePaletteId.trim() : '';
    const activePaletteId =
      rawActivePaletteId === 'custom' || seenIds.has(rawActivePaletteId)
        ? rawActivePaletteId
        : base.activePaletteId;

    const customWallpapers = [];
    const seenWpIds = new Set();
    if (Array.isArray(safeRaw.customWallpapers)) {
      for (const wp of safeRaw.customWallpapers) {
        if (!wp || typeof wp !== 'object') continue;
        const id = typeof wp.id === 'string' ? wp.id.trim() : '';
        const filename = typeof wp.filename === 'string' ? path.basename(wp.filename) : '';
        if (!id || !filename || seenWpIds.has(id)) continue;
        seenWpIds.add(id);
        const thumbFilename =
          typeof wp.thumbFilename === 'string' && wp.thumbFilename.trim()
            ? path.basename(wp.thumbFilename)
            : '';
        customWallpapers.push({
          id,
          name: sanitizeDisplayName(wp.name, filename),
          filename,
          ...(thumbFilename ? { thumbFilename } : {}),
          mime: ALLOWED_IMAGE_MIMES.has(wp.mime) ? wp.mime : 'image/png',
          builtin: false,
          createdAt: Number.isFinite(Number(wp.createdAt)) ? Number(wp.createdAt) : Date.now(),
        });
      }
    }

    const validBuiltinWpIds = new Set(BUILTIN_WALLPAPERS.map((w) => w.id));
    let activeWallpaperId = base.activeWallpaperId;
    if (safeRaw.activeWallpaperId === null || safeRaw.activeWallpaperId === '') {
      activeWallpaperId = null;
    } else if (
      typeof safeRaw.activeWallpaperId === 'string' &&
      (validBuiltinWpIds.has(safeRaw.activeWallpaperId) || seenWpIds.has(safeRaw.activeWallpaperId))
    ) {
      activeWallpaperId = safeRaw.activeWallpaperId;
    } else if (safeRaw.activeWallpaperId !== undefined) {
      activeWallpaperId = null;
    }

    const followHostTheme =
      typeof safeRaw.followHostTheme === 'boolean'
        ? safeRaw.followHostTheme
        : typeof safeRaw.syncGlobal === 'boolean'
          ? safeRaw.syncGlobal
          : base.followHostTheme;

    const backdropEnabled =
      typeof safeRaw.backdropEnabled === 'boolean'
        ? safeRaw.backdropEnabled
        : base.backdropEnabled;

    const hudEnabled =
      typeof safeRaw.hudEnabled === 'boolean'
        ? safeRaw.hudEnabled
        : base.hudEnabled;

    const hudInjectionMode =
      safeRaw.hudInjectionMode === 'cdp' || safeRaw.hudInjectionMode === 'uia' || safeRaw.hudInjectionMode === 'asar'
        ? safeRaw.hudInjectionMode
        : base.hudInjectionMode;

    const hudAutoReinject =
      typeof safeRaw.hudAutoReinject === 'boolean'
        ? safeRaw.hudAutoReinject
        : base.hudAutoReinject;

    const zeroUiaMode =
      typeof safeRaw.zeroUiaMode === 'boolean'
        ? safeRaw.zeroUiaMode
        : base.zeroUiaMode;

    const hostThemeMode =
      safeRaw.hostThemeMode === 'cdp' || safeRaw.hostThemeMode === 'backdrop' || safeRaw.hostThemeMode === 'inject'
        ? safeRaw.hostThemeMode
        : base.hostThemeMode;
    const cdpPort = clampInt(safeRaw.cdpPort, 1024, 65535, base.cdpPort);

    return {
      version: 1,
      activePaletteId,
      colors: sanitizeColors(safeRaw.colors, base.colors),
      palettes,
      customPalettes,
      builtinWallpapers: BUILTIN_WALLPAPERS.map((w) => ({ ...w })),
      followHostTheme,
      syncGlobal: followHostTheme,
      backdropEnabled,
      hudEnabled,
      hudInjectionMode,
      hudAutoReinject,
      zeroUiaMode,
      hostThemeMode,
      cdpPort,
      hostBlendPct: clampInt(safeRaw.hostBlendPct, 5, 42, base.hostBlendPct),
      activeWallpaperId,
      customWallpapers,
      opacity: clampInt(safeRaw.opacity, 0, 100, base.opacity),
      blur: clampInt(safeRaw.blur, 0, 24, base.blur),
      dim: clampInt(safeRaw.dim, 0, 85, base.dim),
      radius: clampInt(safeRaw.radius, 4, 18, base.radius),
      fit: VALID_WP_FITS.has(safeRaw.fit) ? safeRaw.fit : base.fit,
    };
  }

  function serializeThemesForDisk(state) {
    return {
      version: 1,
      activePaletteId: state.activePaletteId,
      colors: state.colors,
      customPalettes: state.customPalettes,
      followHostTheme: Boolean(state.followHostTheme ?? state.syncGlobal),
      syncGlobal: Boolean(state.followHostTheme ?? state.syncGlobal),
      backdropEnabled: Boolean(state.backdropEnabled),
      hudEnabled: state.hudEnabled !== false,
      hudInjectionMode:
        state.hudInjectionMode === 'cdp' || state.hudInjectionMode === 'uia' ? state.hudInjectionMode : 'asar',
      hudAutoReinject: state.hudAutoReinject !== false,
      zeroUiaMode: Boolean(state.zeroUiaMode),
      hostThemeMode:
        state.hostThemeMode === 'cdp' || state.hostThemeMode === 'backdrop' ? state.hostThemeMode : 'inject',
      cdpPort: clampInt(state.cdpPort, 1024, 65535, 9229),
      hostBlendPct: clampInt(state.hostBlendPct, 5, 42, 25),
      activeWallpaperId: state.activeWallpaperId,
      customWallpapers: state.customWallpapers,
      opacity: state.opacity,
      blur: state.blur,
      dim: state.dim,
      radius: state.radius,
      fit: state.fit,
    };
  }

  function normalizeCustomPresets(raw) {
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.presets) ? raw.presets : [];
    const seen = new Set();
    const out = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const content = typeof item.content === 'string' ? item.content : '';
      out.push({
        id,
        name: sanitizeDisplayName(item.name || item.filename, id),
        filename: item.filename ? path.basename(String(item.filename)) : `${id}.md`,
        group: 'custom',
        content,
        tokens: Number.isFinite(Number(item.tokens)) ? Number(item.tokens) : 0,
        bytes: Buffer.byteLength(content, 'utf8'),
        builtin: false,
        createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
      });
    }
    return out;
  }

  function normalizeQuotaAnchors(raw) {
    const base = defaultQuotaAnchors();
    if (!raw || typeof raw !== 'object') return base;
    return {
      ...base,
      ...raw,
      version: 1,
      sampleCount: Number.isFinite(Number(raw.sampleCount)) ? Number(raw.sampleCount) : 0,
      history: Array.isArray(raw.history) ? raw.history.slice(-32) : [],
      modelWeights:
        raw.modelWeights && typeof raw.modelWeights === 'object' ? { ...raw.modelWeights } : {},
    };
  }

  return {
    async getPrefs() {
      return enqueue('prefs', async () => {
        const { exists, data } = await readJsonSafe(paths.userPrefsFile);
        const normalized = normalizePrefs(data);
        if (!exists) {
          await atomicWriteJson(paths.userPrefsFile, normalized);
        }
        return normalized;
      });
    },

    async updatePrefs(patch = {}) {
      return enqueue('prefs', async () => {
        const { data } = await readJsonSafe(paths.userPrefsFile, { throwOnIoError: true });
        const current = normalizePrefs(data);
        const resolvedCap = patch.windowCap ?? patch.contextWindowCap ?? current.windowCap;
        const mergedGuard =
          patch.memoryGuard && typeof patch.memoryGuard === 'object'
            ? { ...current.memoryGuard, ...patch.memoryGuard }
            : current.memoryGuard;
        const next = normalizePrefs({
          ...current,
          ...patch,
          windowCap: resolvedCap,
          contextWindowCap: resolvedCap,
          memoryGuard: mergedGuard,
        });
        await atomicWriteJson(paths.userPrefsFile, next);
        return next;
      });
    },

    async getSessionsMeta() {
      return enqueue('sessionsMeta', async () => {
        const { exists, data } = await readJsonSafe(paths.sessionsMetaFile);
        const normalized = normalizeSessionsMeta(data);
        if (!exists) {
          await atomicWriteJson(paths.sessionsMetaFile, normalized);
        }
        return normalized;
      });
    },

    async updateSessionsMeta(patchOrUpdater) {
      return enqueue('sessionsMeta', async () => {
        const { data } = await readJsonSafe(paths.sessionsMetaFile, { throwOnIoError: true });
        const current = normalizeSessionsMeta(data);
        const draft =
          typeof patchOrUpdater === 'function'
            ? patchOrUpdater(current)
            : {
                ...current,
                ...(patchOrUpdater && typeof patchOrUpdater === 'object' ? patchOrUpdater : {}),
                lastSeenModifiedMs: {
                  ...current.lastSeenModifiedMs,
                  ...(patchOrUpdater?.lastSeenModifiedMs || {}),
                  ...(patchOrUpdater?.lastSeenByConv || {}),
                },
                lastSeenByAgent: {
                  ...current.lastSeenByAgent,
                  ...(patchOrUpdater?.lastSeenByAgent || {}),
                },
                favoriteTitles: {
                  ...current.favoriteTitles,
                  ...(patchOrUpdater?.favoriteTitles || {}),
                },
              };
        const next = normalizeSessionsMeta(draft, current.firstTrackWatermarkMs);
        await atomicWriteJson(paths.sessionsMetaFile, next);
        return next;
      });
    },

    async getThemes() {
      return enqueue('themes', async () => {
        const { exists, data } = await readJsonSafe(paths.themesFile);
        const normalized = normalizeThemes(data);
        if (!exists) {
          await atomicWriteJson(paths.themesFile, serializeThemesForDisk(normalized));
        }
        return normalized;
      });
    },

    async saveThemes(nextState) {
      return enqueue('themes', async () => {
        const { data } = await readJsonSafe(paths.themesFile, { throwOnIoError: true });
        const current = normalizeThemes(data);
        const hasFollowFlag = typeof nextState?.followHostTheme === 'boolean';
        const hasSyncFlag = typeof nextState?.syncGlobal === 'boolean';
        const resolvedFollow = hasFollowFlag
          ? nextState.followHostTheme
          : hasSyncFlag
            ? nextState.syncGlobal
            : current.followHostTheme;
        const merged = {
          ...current,
          ...(nextState && typeof nextState === 'object' ? nextState : {}),
          followHostTheme: resolvedFollow,
          syncGlobal: resolvedFollow,
          customPalettes: Array.isArray(nextState?.customPalettes)
            ? nextState.customPalettes
            : current.customPalettes,
          customWallpapers: Array.isArray(nextState?.customWallpapers)
            ? nextState.customWallpapers
            : current.customWallpapers,
        };
        const normalized = normalizeThemes(merged);
        await atomicWriteJson(paths.themesFile, serializeThemesForDisk(normalized));
        return normalized;
      });
    },

    async addCustomPalette({ id, name, colors }) {
      return enqueue('themes', async () => {
        const { data } = await readJsonSafe(paths.themesFile, { throwOnIoError: true });
        const current = normalizeThemes(data);
        const cleanName = sanitizeDisplayName(name, '');
        if (!cleanName) {
          throw Object.assign(new Error('Palette name is required'), { code: 'INVALID_NAME' });
        }
        const validatedColors = validateStrictColors(colors);
        const requestedId = typeof id === 'string' ? id.trim() : '';
        if (requestedId && BUILTIN_PALETTE_IDS.has(requestedId)) {
          throw Object.assign(new Error('Cannot overwrite built-in palette'), {
            code: 'BUILTIN_PALETTE',
          });
        }
        const paletteId = requestedId || makeSlugId('custom');
        const palette = {
          id: paletteId,
          name: cleanName,
          builtin: false,
          colors: validatedColors,
          createdAt: Date.now(),
        };

        const filtered = current.customPalettes.filter((p) => p.id !== paletteId);
        filtered.push(palette);

        const next = normalizeThemes({
          ...current,
          activePaletteId: paletteId,
          colors: validatedColors,
          customPalettes: filtered,
        });
        await atomicWriteJson(paths.themesFile, serializeThemesForDisk(next));
        return { palette, themes: next };
      });
    },

    async deleteCustomPalette(paletteId) {
      return enqueue('themes', async () => {
        const targetId = String(paletteId ?? '').trim();
        if (!targetId) {
          throw Object.assign(new Error('Palette ID is required'), { code: 'INVALID_ID' });
        }
        if (BUILTIN_PALETTE_IDS.has(targetId)) {
          throw Object.assign(new Error('Cannot delete built-in palette'), {
            code: 'BUILTIN_PALETTE',
          });
        }
        const { data } = await readJsonSafe(paths.themesFile, { throwOnIoError: true });
        const current = normalizeThemes(data);
        const remaining = current.customPalettes.filter((p) => p.id !== targetId);
        if (remaining.length === current.customPalettes.length) {
          throw Object.assign(new Error('Custom palette not found'), { code: 'NOT_FOUND' });
        }

        const resetActive = current.activePaletteId === targetId;
        const next = normalizeThemes({
          ...current,
          customPalettes: remaining,
          activePaletteId: resetActive ? 'default' : current.activePaletteId,
          colors: resetActive ? { ...BUILTIN_PALETTES[0].colors } : current.colors,
        });
        await atomicWriteJson(paths.themesFile, serializeThemesForDisk(next));
        return { deleted: true, id: targetId, themes: next };
      });
    },

    async saveCustomWallpaperFile({ name, mime, base64, thumbBase64, thumbMime }) {
      return enqueue('themes', async () => {
        const mainImg = decodeAndVerifyRaster(mime, base64, MAX_WALLPAPER_BYTES);
        let thumbImg = null;
        if (typeof thumbBase64 === 'string' && thumbBase64.trim()) {
          thumbImg = decodeAndVerifyRaster(thumbMime || mainImg.sniffedMime, thumbBase64, MAX_THUMBNAIL_BYTES);
        }

        const id = makeSlugId('cwp');
        const filename = `${id}.${mainImg.ext}`;
        const targetPath = assertInsideDir(paths.customWallpapersDir, path.join(paths.customWallpapersDir, filename));
        await atomicWriteBuffer(targetPath, mainImg.buffer);

        let thumbFilename = '';
        if (thumbImg) {
          thumbFilename = `${id}-thumb.${thumbImg.ext}`;
          const thumbPath = assertInsideDir(
            paths.customWallpapersDir,
            path.join(paths.customWallpapersDir, thumbFilename),
          );
          await atomicWriteBuffer(thumbPath, thumbImg.buffer);
        }

        const { data } = await readJsonSafe(paths.themesFile, { throwOnIoError: true });
        const current = normalizeThemes(data);
        const entry = {
          id,
          name: sanitizeDisplayName(name, filename),
          filename,
          ...(thumbFilename ? { thumbFilename } : {}),
          mime: mainImg.sniffedMime,
          builtin: false,
          createdAt: Date.now(),
        };
        const next = normalizeThemes({
          ...current,
          activeWallpaperId: id,
          customWallpapers: [...current.customWallpapers, entry],
        });
        await atomicWriteJson(paths.themesFile, serializeThemesForDisk(next));
        return { wallpaper: entry, themes: next };
      });
    },

    async deleteCustomWallpaperFile(wallpaperId) {
      return enqueue('themes', async () => {
        const targetId = String(wallpaperId ?? '').trim();
        if (!targetId) {
          throw Object.assign(new Error('Wallpaper ID is required'), { code: 'INVALID_ID' });
        }
        const { data } = await readJsonSafe(paths.themesFile, { throwOnIoError: true });
        const current = normalizeThemes(data);
        const found = current.customWallpapers.find((w) => w.id === targetId);
        if (!found) {
          throw Object.assign(new Error('Custom wallpaper not found'), { code: 'NOT_FOUND' });
        }

        const targetPath = assertInsideDir(
          paths.customWallpapersDir,
          path.join(paths.customWallpapersDir, path.basename(found.filename)),
        );
        await fs.rm(targetPath, { force: true });

        if (found.thumbFilename) {
          const thumbPath = assertInsideDir(
            paths.customWallpapersDir,
            path.join(paths.customWallpapersDir, path.basename(found.thumbFilename)),
          );
          await fs.rm(thumbPath, { force: true });
        }

        const remaining = current.customWallpapers.filter((w) => w.id !== targetId);
        const next = normalizeThemes({
          ...current,
          customWallpapers: remaining,
          activeWallpaperId: current.activeWallpaperId === targetId ? null : current.activeWallpaperId,
        });
        await atomicWriteJson(paths.themesFile, serializeThemesForDisk(next));
        return { deleted: true, id: targetId, themes: next };
      });
    },

    async getCustomPresets() {
      return enqueue('customPresets', async () => {
        const { exists, data } = await readJsonSafe(paths.customPresetsFile);
        const normalized = normalizeCustomPresets(data);
        if (!exists) {
          await atomicWriteJson(paths.customPresetsFile, normalized);
        }
        return normalized;
      });
    },

    async addCustomPreset({ id, name, filename, content, sanitizedContent, tokens }) {
      return enqueue('customPresets', async () => {
        const { data } = await readJsonSafe(paths.customPresetsFile, { throwOnIoError: true });
        const current = normalizeCustomPresets(data);
        const finalContent =
          typeof sanitizedContent === 'string'
            ? sanitizedContent
            : typeof content === 'string'
              ? content
              : '';
        const presetId = typeof id === 'string' && id.trim() ? id.trim() : makeSlugId('custom-md');
        const cleanFilename = filename ? path.basename(String(filename)) : `${presetId}.md`;
        const entry = {
          id: presetId,
          name: sanitizeDisplayName(name || cleanFilename.replace(/\.(md|markdown)$/i, ''), cleanFilename),
          filename: cleanFilename,
          group: 'custom',
          content: finalContent,
          tokens: Number.isFinite(Number(tokens)) ? Number(tokens) : 0,
          bytes: Buffer.byteLength(finalContent, 'utf8'),
          builtin: false,
          createdAt: Date.now(),
        };

        const filtered = current.filter((p) => p.id !== presetId);
        filtered.push(entry);
        await atomicWriteJson(paths.customPresetsFile, filtered);
        return entry;
      });
    },

    async deleteCustomPreset(presetId) {
      return enqueue('customPresets', async () => {
        const targetId = String(presetId ?? '').trim();
        const { data } = await readJsonSafe(paths.customPresetsFile, { throwOnIoError: true });
        const current = normalizeCustomPresets(data);
        const remaining = current.filter((p) => p.id !== targetId);
        await atomicWriteJson(paths.customPresetsFile, remaining);
        return { deleted: remaining.length < current.length, id: targetId };
      });
    },

    async getQuotaAnchors() {
      return enqueue('quotaAnchors', async () => {
        const { exists, data } = await readJsonSafe(paths.quotaAnchorsFile);
        const normalized = normalizeQuotaAnchors(data);
        if (!exists) {
          await atomicWriteJson(paths.quotaAnchorsFile, normalized);
        }
        return normalized;
      });
    },

    async saveQuotaAnchors(nextAnchors = {}) {
      return enqueue('quotaAnchors', async () => {
        const { data } = await readJsonSafe(paths.quotaAnchorsFile, { throwOnIoError: true });
        const current = normalizeQuotaAnchors(data);
        const merged = normalizeQuotaAnchors({
          ...current,
          ...(nextAnchors && typeof nextAnchors === 'object' ? nextAnchors : {}),
        });
        await atomicWriteJson(paths.quotaAnchorsFile, merged);
        return merged;
      });
    },

    async getMasteryConfig() {
      return enqueue('masteryConfig', async () => {
        const { exists, data } = await readJsonSafe(paths.masteryConfigFile);
        const normalized = normalizeMasteryConfig(data);
        if (!exists) {
          await atomicWriteJson(paths.masteryConfigFile, normalized);
        }
        return normalized;
      });
    },

    async getPublicMasteryConfig() {
      const cfg = await this.getMasteryConfig();
      return sanitizePublicMasteryConfig(cfg);
    },

    async updateMasteryConfig(patch = {}) {
      return enqueue('masteryConfig', async () => {
        const { data } = await readJsonSafe(paths.masteryConfigFile, { throwOnIoError: true });
        const current = normalizeMasteryConfig(data);
        const tpPatch =
          patch && typeof patch === 'object' && patch.thirdParty && typeof patch.thirdParty === 'object'
            ? patch.thirdParty
            : null;

        let nextApiKey = current.thirdParty.apiKey;
        if (tpPatch) {
          if (tpPatch.clearApiKey === true) {
            nextApiKey = '';
          } else if (typeof tpPatch.apiKey === 'string' && tpPatch.apiKey.trim()) {
            nextApiKey = tpPatch.apiKey.trim();
          }
        }

        const merged = normalizeMasteryConfig({
          ...current,
          ...(patch && typeof patch === 'object' ? patch : {}),
          thirdParty: {
            ...current.thirdParty,
            ...(tpPatch || {}),
            apiKey: nextApiKey,
          },
        });
        await atomicWriteJson(paths.masteryConfigFile, merged);
        return merged;
      });
    },
  };
}
