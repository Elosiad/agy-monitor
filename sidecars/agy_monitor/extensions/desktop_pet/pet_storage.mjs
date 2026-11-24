/**
 * Standalone persistence & raster/frame-animation storage for the Desktop Pet extension.
 * Keeps all pet state strictly isolated from core storage.mjs and paths.mjs.
 */

import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteBuffer, atomicWriteJson } from '../../backend/paths.mjs';

export const BUILTIN_PETS = Object.freeze([
  Object.freeze({ id: 'neko', name: '暗夜小黑猫', nameEn: 'Night Neko', builtin: true }),
  Object.freeze({ id: 'ghost', name: '赛博小幽灵', nameEn: 'Cyber Ghost', builtin: true }),
  Object.freeze({ id: 'mecha', name: '机甲小助手', nameEn: 'AGY Bot', builtin: true }),
]);

const BUILTIN_PET_IDS = new Set(BUILTIN_PETS.map((p) => p.id));
const VALID_DISPLAY_MODES = new Set(['auto', 'desktop', 'panel']);
const VALID_STATE_TRACKS = ['running', 'unread', 'interact', 'walk', 'drag'];
const ALLOWED_IMAGE_MIMES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);
const ALLOWED_RASTER_EXT_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);
const TRANSIENT_FS_READ_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);

export const MAX_PET_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PET_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_PET_TRACK_FRAMES = 48;
export const MAX_PET_TOTAL_FRAMES = 144;

export function resolvePetPaths(corePaths) {
  const pluginDataDir = path.resolve(corePaths?.pluginDataDir || '.');
  const customPetsDir = path.join(pluginDataDir, 'pets');
  const petBinDir = path.join(pluginDataDir, 'bin');
  mkdirSync(pluginDataDir, { recursive: true });
  mkdirSync(customPetsDir, { recursive: true });
  return {
    pluginDataDir,
    customPetsDir,
    petConfigFile: path.join(pluginDataDir, 'pet_config.json'),
    petStatusFile: path.join(pluginDataDir, 'pet_status.json'),
    petBinDir,
    petExeFile: path.join(petBinDir, 'agy_desktop_pet.exe'),
    petHashFile: path.join(petBinDir, 'agy_desktop_pet.sha1'),
    petLauncherVbs: path.join(pluginDataDir, 'launch_desktop_pet.vbs'),
    hudTelemetryFile: corePaths?.hudTelemetryFile || path.join(pluginDataDir, 'hud_telemetry.json'),
    themesFile: corePaths?.themesFile || path.join(pluginDataDir, 'themes.json'),
  };
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function normalizeCoord(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  return Math.max(-16000, Math.min(32000, Math.round(num)));
}

function sanitizeDisplayName(name, fallback = '自定义桌宠') {
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
    throw Object.assign(new Error('Path escapes allowed pet storage directory'), {
      code: 'PATH_TRAVERSAL',
    });
  }
  return resolvedTarget;
}

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

export function decodeAndVerifyRaster(rawMimeInput, rawBase64Input, maxBytes) {
  const rawMime = String(rawMimeInput ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (rawMime === 'image/jpg') {
    // accept jpeg alias
  } else if (rawMime && (rawMime.includes('svg') || !ALLOWED_IMAGE_MIMES.has(rawMime))) {
    throw Object.assign(
      new Error('仅支持 PNG、JPEG、WEBP 或 GIF 位图，已禁止 SVG 上传'),
      { code: 'UNSUPPORTED_MEDIA_TYPE' },
    );
  }

  let payload = String(rawBase64Input ?? '').trim();
  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/is.exec(payload);
  if (dataUrlMatch) {
    const embeddedMime = dataUrlMatch[1].trim().toLowerCase();
    if (embeddedMime !== 'image/jpg' && (embeddedMime.includes('svg') || !ALLOWED_IMAGE_MIMES.has(embeddedMime))) {
      throw Object.assign(new Error('仅支持 PNG、JPEG、WEBP 或 GIF 位图，已禁止 SVG 上传'), {
        code: 'UNSUPPORTED_MEDIA_TYPE',
      });
    }
    payload = dataUrlMatch[2].trim();
  } else if (!rawMime) {
    throw Object.assign(new Error('仅支持 PNG、JPEG、WEBP 或 GIF 位图'), {
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  }

  if (!payload) {
    throw Object.assign(new Error('图片内容不能为空'), { code: 'EMPTY_PAYLOAD' });
  }
  const maxBase64Chars = Math.ceil((maxBytes * 4) / 3) + 64;
  if (payload.length > maxBase64Chars) {
    throw Object.assign(
      new Error(`文件大小必须在 1B 到 ${Math.round(maxBytes / 1048576)}MB 之间`),
      { code: 'PAYLOAD_TOO_LARGE' },
    );
  }
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes) {
    throw Object.assign(
      new Error(`文件大小必须在 1B 到 ${Math.round(maxBytes / 1048576)}MB 之间`),
      { code: 'PAYLOAD_TOO_LARGE' },
    );
  }

  const headText = buffer.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (headText.startsWith('<svg') || headText.startsWith('<?xml') || headText.includes('<script')) {
    throw Object.assign(new Error('检测到 XML/SVG 文本头，出于安全策略已禁止上传'), {
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  }

  const sniffedMime = detectRasterMagic(buffer);
  if (!sniffedMime || !ALLOWED_IMAGE_MIMES.has(sniffedMime)) {
    throw Object.assign(new Error('文件头校验失败：仅接受真实 PNG、JPEG、WEBP 或 GIF 位图'), {
      code: 'INVALID_IMAGE_MAGIC',
    });
  }
  return { buffer, sniffedMime, ext: ALLOWED_IMAGE_MIMES.get(sniffedMime) };
}

async function readJsonSafe(filePath, { throwOnIoError = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const raw = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
      try {
        return { exists: true, data: JSON.parse(raw) };
      } catch (parseErr) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
          continue;
        }
        if (throwOnIoError) throw parseErr;
        return { exists: true, data: null, parseError: parseErr };
      }
    } catch (err) {
      if (err?.code === 'ENOENT') return { exists: false, data: null };
      if (TRANSIENT_FS_READ_CODES.has(err?.code) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
        continue;
      }
      if (throwOnIoError) throw err;
      return { exists: true, data: null, readError: err };
    }
  }
  return { exists: true, data: null };
}

export const DEFAULT_BUBBLE_TEMPLATE = '入 {in} · 出 {out}';

function sanitizeBubbleTemplate(raw, fallback = DEFAULT_BUBBLE_TEMPLATE) {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[\r\n\t\x00-\x1f]/g, ' ').trim().slice(0, 160);
  return cleaned || fallback;
}

function defaultPetConfig() {
  return {
    version: 1,
    enabled: false,
    activePetId: 'neko',
    customPets: [],
    displayMode: 'auto',
    size: 100,
    opacity: 95,
    alwaysOnTop: true,
    showSpeechBubble: true,
    bubbleTemplate: DEFAULT_BUBBLE_TEMPLATE,
    autoWander: true,
    selectable: true,
    posX: null,
    posY: null,
    updatedAt: 0,
    previewSignal: null,
  };
}

function normalizePreviewSignal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const validTracks = new Set(['idle', 'running', 'unread', 'interact', 'walk', 'drag']);
  const track = validTracks.has(raw.track) ? raw.track : 'idle';
  return {
    petId: typeof raw.petId === 'string' ? raw.petId.trim().slice(0, 64) : '',
    track,
    openTab: raw.openTab !== false,
    message: typeof raw.message === 'string' ? raw.message.replace(/[\r\n\t\x00-\x1f]/g, ' ').trim().slice(0, 120) : '',
    ts: Math.round(ts),
  };
}

function normalizeFrameList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const fr of rawList) {
    if (!fr || typeof fr !== 'object') continue;
    const filename = typeof fr.filename === 'string' ? path.basename(fr.filename) : '';
    if (!filename) continue;
    out.push({
      filename,
      mime: ALLOWED_IMAGE_MIMES.has(fr.mime) ? fr.mime : 'image/png',
    });
    if (out.length >= MAX_PET_TRACK_FRAMES) break;
  }
  return out;
}

export function collectCustomPetFilenames(entry) {
  const set = new Set();
  if (!entry || typeof entry !== 'object') return set;
  if (typeof entry.filename === 'string' && entry.filename) {
    set.add(path.basename(entry.filename));
  }
  for (const fr of entry.frames || []) {
    if (fr?.filename) set.add(path.basename(fr.filename));
  }
  if (entry.stateFrames && typeof entry.stateFrames === 'object') {
    for (const track of VALID_STATE_TRACKS) {
      for (const fr of entry.stateFrames[track] || []) {
        if (fr?.filename) set.add(path.basename(fr.filename));
      }
    }
  }
  return set;
}

function normalizePetConfig(raw) {
  const base = defaultPetConfig();
  const safeRaw = raw && typeof raw === 'object' ? raw : {};

  const customPets = [];
  const seenIds = new Set(BUILTIN_PET_IDS);
  if (Array.isArray(safeRaw.customPets)) {
    for (const item of safeRaw.customPets) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || seenIds.has(id)) continue;

      const isFrames = item.kind === 'frames' || (Array.isArray(item.frames) && item.frames.length > 0);
      if (isFrames) {
        const frames = normalizeFrameList(item.frames);
        if (frames.length === 0) continue;
        const stateFrames = {};
        if (item.stateFrames && typeof item.stateFrames === 'object') {
          for (const track of VALID_STATE_TRACKS) {
            const list = normalizeFrameList(item.stateFrames[track]);
            if (list.length > 0) stateFrames[track] = list;
          }
        }
        seenIds.add(id);
        customPets.push({
          id,
          name: sanitizeDisplayName(item.name, id),
          kind: 'frames',
          fps: clampInt(item.fps, 1, 30, 8),
          filename: frames[0].filename,
          mime: frames[0].mime,
          frames,
          stateFrames,
          builtin: false,
          createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
        });
        continue;
      }

      const filename = typeof item.filename === 'string' ? path.basename(item.filename) : '';
      if (!filename) continue;
      seenIds.add(id);
      customPets.push({
        id,
        name: sanitizeDisplayName(item.name, filename),
        kind: 'image',
        filename,
        mime: ALLOWED_IMAGE_MIMES.has(item.mime) ? item.mime : 'image/png',
        builtin: false,
        createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
      });
    }
  }

  const rawActiveId = typeof safeRaw.activePetId === 'string' ? safeRaw.activePetId.trim() : '';
  const activePetId = rawActiveId && seenIds.has(rawActiveId) ? rawActiveId : base.activePetId;
  const displayMode = VALID_DISPLAY_MODES.has(safeRaw.displayMode)
    ? safeRaw.displayMode
    : base.displayMode;

  return {
    version: 1,
    enabled: typeof safeRaw.enabled === 'boolean' ? safeRaw.enabled : base.enabled,
    activePetId,
    builtinPets: BUILTIN_PETS.map((p) => ({ ...p })),
    customPets,
    displayMode,
    size: clampInt(safeRaw.size, 60, 500, base.size),
    opacity: clampInt(safeRaw.opacity, 40, 100, base.opacity),
    alwaysOnTop: typeof safeRaw.alwaysOnTop === 'boolean' ? safeRaw.alwaysOnTop : base.alwaysOnTop,
    showSpeechBubble:
      typeof safeRaw.showSpeechBubble === 'boolean'
        ? safeRaw.showSpeechBubble
        : base.showSpeechBubble,
    bubbleTemplate: sanitizeBubbleTemplate(safeRaw.bubbleTemplate, base.bubbleTemplate),
    autoWander:
      typeof safeRaw.autoWander === 'boolean'
        ? safeRaw.autoWander
        : base.autoWander,
    selectable:
      typeof safeRaw.selectable === 'boolean'
        ? safeRaw.selectable
        : base.selectable,
    posX: normalizeCoord(safeRaw.posX),
    posY: normalizeCoord(safeRaw.posY),
    updatedAt: Number.isFinite(Number(safeRaw.updatedAt)) ? Math.round(Number(safeRaw.updatedAt)) : 0,
    previewSignal: normalizePreviewSignal(safeRaw.previewSignal),
  };
}

function serializePetConfig(state) {
  return {
    version: 1,
    enabled: Boolean(state.enabled),
    activePetId: state.activePetId,
    customPets: state.customPets,
    displayMode: VALID_DISPLAY_MODES.has(state.displayMode) ? state.displayMode : 'auto',
    size: clampInt(state.size, 60, 500, 100),
    opacity: clampInt(state.opacity, 40, 100, 95),
    alwaysOnTop: state.alwaysOnTop !== false,
    showSpeechBubble: state.showSpeechBubble !== false,
    bubbleTemplate: sanitizeBubbleTemplate(state.bubbleTemplate, DEFAULT_BUBBLE_TEMPLATE),
    autoWander: state.autoWander !== false,
    selectable: state.selectable !== false,
    posX: normalizeCoord(state.posX),
    posY: normalizeCoord(state.posY),
    updatedAt: Number.isFinite(Number(state.updatedAt)) ? Math.round(Number(state.updatedAt)) : Date.now(),
    previewSignal: normalizePreviewSignal(state.previewSignal),
  };
}

export function createPetStorage(petPaths) {
  let queue = Promise.resolve();
  const enqueue = (task) => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  return {
    paths: petPaths,

    async getPetConfig() {
      return enqueue(async () => {
        const { exists, data } = await readJsonSafe(petPaths.petConfigFile);
        const normalized = normalizePetConfig(data);
        if (!exists) {
          await atomicWriteJson(petPaths.petConfigFile, serializePetConfig(normalized));
        }
        return normalized;
      });
    },

    async savePetConfig(patch = {}) {
      return enqueue(async () => {
        const { data } = await readJsonSafe(petPaths.petConfigFile, { throwOnIoError: true });
        const current = normalizePetConfig(data);
        const safePatch = patch && typeof patch === 'object' ? { ...patch } : {};
        // customPets must ONLY be modified via dedicated upload/frames/delete handlers
        delete safePatch.customPets;
        const merged = {
          ...current,
          ...safePatch,
          customPets: current.customPets,
          updatedAt: Date.now(),
        };
        const normalized = normalizePetConfig(merged);
        await atomicWriteJson(petPaths.petConfigFile, serializePetConfig(normalized));
        return normalized;
      });
    },

    async triggerPreviewSignal({ petId = '', track = 'idle', openTab = true, message = '', activate = true } = {}) {
      return enqueue(async () => {
        const { data } = await readJsonSafe(petPaths.petConfigFile, { throwOnIoError: true });
        const current = normalizePetConfig(data);
        const targetId = typeof petId === 'string' && petId.trim() ? petId.trim() : current.activePetId;
        const now = Date.now();
        const next = normalizePetConfig({
          ...current,
          activePetId: activate ? targetId : current.activePetId,
          updatedAt: now,
          previewSignal: {
            petId: targetId,
            track,
            openTab: openTab !== false,
            message,
            ts: now,
          },
        });
        await atomicWriteJson(petPaths.petConfigFile, serializePetConfig(next));
        return next;
      });
    },

    async saveCustomPetFile({ name, mime, base64 }) {
      return enqueue(async () => {
        const img = decodeAndVerifyRaster(mime, base64, MAX_PET_IMAGE_BYTES);
        const id = makeSlugId('cpet');
        const filename = `${id}.${img.ext}`;
        const targetPath = assertInsideDir(petPaths.customPetsDir, path.join(petPaths.customPetsDir, filename));
        await atomicWriteBuffer(targetPath, img.buffer);

        const { data } = await readJsonSafe(petPaths.petConfigFile, { throwOnIoError: true });
        const current = normalizePetConfig(data);
        const entry = {
          id,
          name: sanitizeDisplayName(name, filename),
          kind: 'image',
          filename,
          mime: img.sniffedMime,
          builtin: false,
          createdAt: Date.now(),
        };
        const next = normalizePetConfig({
          ...current,
          activePetId: id,
          customPets: [...current.customPets, entry],
          updatedAt: Date.now(),
        });
        await atomicWriteJson(petPaths.petConfigFile, serializePetConfig(next));
        return { pet: entry, petState: next };
      });
    },

    async saveCustomPetFrameAnimation({ id, name, fps = 8, frames = [], stateFrames = {} } = {}) {
      return enqueue(async () => {
        const { data } = await readJsonSafe(petPaths.petConfigFile, { throwOnIoError: true });
        const current = normalizePetConfig(data);

        const requestedId = typeof id === 'string' ? id.trim() : '';
        if (requestedId && BUILTIN_PET_IDS.has(requestedId)) {
          throw Object.assign(new Error('Cannot overwrite built-in pet'), { code: 'BUILTIN_PALETTE' });
        }
        const existingEntry = requestedId
          ? current.customPets.find((p) => p.id === requestedId) || null
          : null;
        const allowedExistingFiles = existingEntry ? collectCustomPetFilenames(existingEntry) : new Set();
        const existingMimeByFile = new Map();
        if (existingEntry) {
          if (existingEntry.filename) existingMimeByFile.set(existingEntry.filename, existingEntry.mime);
          for (const fr of existingEntry.frames || []) {
            if (fr?.filename) existingMimeByFile.set(fr.filename, fr.mime);
          }
          for (const track of VALID_STATE_TRACKS) {
            for (const fr of existingEntry.stateFrames?.[track] || []) {
              if (fr?.filename) existingMimeByFile.set(fr.filename, fr.mime);
            }
          }
        }

        const rawIdle = Array.isArray(frames) ? frames : [];
        if (rawIdle.length === 0) {
          throw Object.assign(new Error('请至少添加 1 帧待机动画图片'), { code: 'EMPTY_PAYLOAD' });
        }
        if (rawIdle.length > MAX_PET_TRACK_FRAMES) {
          throw Object.assign(new Error(`单轨道最多支持 ${MAX_PET_TRACK_FRAMES} 帧`), {
            code: 'PAYLOAD_TOO_LARGE',
          });
        }

        const petId = existingEntry ? existingEntry.id : makeSlugId('cpetf');
        const resolvedFps = clampInt(fps, 1, 30, 8);
        const writtenNewFiles = [];
        let totalFrameCount = 0;

        const processTrack = async (trackName, inputList) => {
          if (!Array.isArray(inputList) || inputList.length === 0) return [];
          if (inputList.length > MAX_PET_TRACK_FRAMES) {
            throw Object.assign(new Error(`单轨道最多支持 ${MAX_PET_TRACK_FRAMES} 帧`), {
              code: 'PAYLOAD_TOO_LARGE',
            });
          }
          const out = [];
          for (let idx = 0; idx < inputList.length; idx += 1) {
            totalFrameCount += 1;
            if (totalFrameCount > MAX_PET_TOTAL_FRAMES) {
              throw Object.assign(new Error(`单个桌宠最多支持 ${MAX_PET_TOTAL_FRAMES} 帧`), {
                code: 'PAYLOAD_TOO_LARGE',
              });
            }
            const item = inputList[idx];
            if (!item || typeof item !== 'object') {
              throw Object.assign(new Error('帧数据格式无效'), { code: 'EMPTY_PAYLOAD' });
            }
            const reuseFile =
              typeof item.existingFilename === 'string' && item.existingFilename.trim()
                ? path.basename(item.existingFilename.trim())
                : '';
            if (reuseFile && allowedExistingFiles.has(reuseFile)) {
              out.push({
                filename: reuseFile,
                mime: existingMimeByFile.get(reuseFile) || 'image/png',
              });
              continue;
            }
            const img = decodeAndVerifyRaster(item.mime, item.base64, MAX_PET_FRAME_BYTES);
            const rand = Math.random().toString(36).slice(2, 6);
            const filename = `${petId}-${trackName}-${idx}-${Date.now().toString(36)}-${rand}.${img.ext}`;
            const targetPath = assertInsideDir(
              petPaths.customPetsDir,
              path.join(petPaths.customPetsDir, filename),
            );
            await atomicWriteBuffer(targetPath, img.buffer);
            writtenNewFiles.push(targetPath);
            out.push({ filename, mime: img.sniffedMime });
          }
          return out;
        };

        let nextFrames;
        const nextStateFrames = {};
        try {
          nextFrames = await processTrack('idle', rawIdle);
          const rawStateObj = stateFrames && typeof stateFrames === 'object' ? stateFrames : {};
          for (const track of VALID_STATE_TRACKS) {
            const processed = await processTrack(track, rawStateObj[track]);
            if (processed.length > 0) nextStateFrames[track] = processed;
          }
        } catch (err) {
          for (const fp of writtenNewFiles) {
            await fs.rm(fp, { force: true }).catch(() => {});
          }
          throw err;
        }

        const entry = {
          id: petId,
          name: sanitizeDisplayName(name, '自定义帧动画'),
          kind: 'frames',
          fps: resolvedFps,
          filename: nextFrames[0].filename,
          mime: nextFrames[0].mime,
          frames: nextFrames,
          stateFrames: nextStateFrames,
          builtin: false,
          createdAt: existingEntry ? existingEntry.createdAt : Date.now(),
        };

        const nextCustomPets = existingEntry
          ? current.customPets.map((p) => (p.id === petId ? entry : p))
          : [...current.customPets, entry];

        const next = normalizePetConfig({
          ...current,
          activePetId: petId,
          customPets: nextCustomPets,
          updatedAt: Date.now(),
        });
        await atomicWriteJson(petPaths.petConfigFile, serializePetConfig(next));

        if (existingEntry) {
          const nextFiles = collectCustomPetFilenames(entry);
          for (const oldFile of allowedExistingFiles) {
            if (!nextFiles.has(oldFile)) {
              const oldPath = assertInsideDir(
                petPaths.customPetsDir,
                path.join(petPaths.customPetsDir, oldFile),
              );
              await fs.rm(oldPath, { force: true }).catch(() => {});
            }
          }
        }

        return { pet: entry, petState: next };
      });
    },

    async deleteCustomPetFile(petId) {
      return enqueue(async () => {
        const targetId = String(petId ?? '').trim();
        if (!targetId) {
          throw Object.assign(new Error('Pet ID is required'), { code: 'INVALID_ID' });
        }
        if (BUILTIN_PET_IDS.has(targetId)) {
          throw Object.assign(new Error('Cannot delete built-in pet'), { code: 'BUILTIN_PALETTE' });
        }
        const { data } = await readJsonSafe(petPaths.petConfigFile, { throwOnIoError: true });
        const current = normalizePetConfig(data);
        const found = current.customPets.find((p) => p.id === targetId);
        if (!found) {
          throw Object.assign(new Error('Custom pet not found'), { code: 'NOT_FOUND' });
        }

        for (const fname of collectCustomPetFilenames(found)) {
          const targetPath = assertInsideDir(
            petPaths.customPetsDir,
            path.join(petPaths.customPetsDir, path.basename(fname)),
          );
          await fs.rm(targetPath, { force: true }).catch(() => {});
        }

        const remaining = current.customPets.filter((p) => p.id !== targetId);
        const next = normalizePetConfig({
          ...current,
          customPets: remaining,
          activePetId: current.activePetId === targetId ? 'neko' : current.activePetId,
          updatedAt: Date.now(),
        });
        await atomicWriteJson(petPaths.petConfigFile, serializePetConfig(next));
        return { deleted: true, id: targetId, petState: next };
      });
    },

    async readSafePetAsset(filename) {
      const cleanName = path.basename(String(filename || ''));
      if (!cleanName || cleanName === '.' || cleanName === '..') return null;
      const ext = path.extname(cleanName).toLowerCase();
      const mime = ALLOWED_RASTER_EXT_MIME.get(ext);
      if (!mime) return { forbidden: true };
      const resolved = assertInsideDir(petPaths.customPetsDir, path.join(petPaths.customPetsDir, cleanName));
      try {
        const lst = await fs.lstat(resolved);
        if (lst.isSymbolicLink() || !lst.isFile()) return null;
        const [realBase, realTarget] = await Promise.all([
          fs.realpath(petPaths.customPetsDir),
          fs.realpath(resolved),
        ]);
        const normBase = process.platform === 'win32' ? realBase.toLowerCase() : realBase;
        const normTarget = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget;
        const prefix = normBase.endsWith(path.sep) ? normBase : `${normBase}${path.sep}`;
        if (!normTarget.startsWith(prefix)) return null;
        const buf = await fs.readFile(realTarget);
        return { buf, mime };
      } catch {
        return null;
      }
    },
  };
}
