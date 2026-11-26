/**
 * Downloadable Desktop Pet Pack Catalog & Verified Zero-Dependency Installer.
 *
 * Keeps the main plugin package lightweight by bundling only small preview images
 * inside the repository and downloading full multi-track frame animation packs
 * on demand from official GitHub Releases with strict allowlist, ZIP-bomb guards,
 * and SHA-256 integrity verification.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { proxyAwareFetch } from '../../backend/accounts.mjs';
import { detectRasterMagic } from './pet_storage.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.join(__dirname, 'assets');

const OFFICIAL_RELEASE_DOWNLOAD_PREFIX =
  'https://github.com/aishadiaodeqishui/agy-monitor/releases/download/';
const MAX_PET_PACK_ZIP_BYTES = 24 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 200;
const MAX_ZIP_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const VALID_OPTIONAL_TRACKS = ['running', 'unread', 'interact', 'walk', 'drag'];

export const DOWNLOADABLE_PET_CATALOG = Object.freeze([
  Object.freeze({
    id: 'gemini-neko',
    name: 'Gemini 猫娘',
    nameEn: 'Gemini Neko',
    previewFile: 'gemini-neko-preview.png',
    previewMime: 'image/png',
    fps: 18,
    trackCount: 6,
    frameCount: 144,
    sizeBytes: 9850394,
    sha256: 'fe799be25b7edf95e2a146b155304238521bb25a4ef06d81181c0e664503a15d',
    assetName: 'gemini-neko-pet-pack-v1.zip',
    downloadUrl:
      'https://github.com/aishadiaodeqishui/agy-monitor/releases/download/v1.1.9/gemini-neko-pet-pack-v1.zip',
  }),
]);

const CATALOG_BY_ID = new Map(DOWNLOADABLE_PET_CATALOG.map((item) => [item.id, item]));
const inFlightDownloads = new Map();

export function findCatalogPet(catalogId) {
  const clean = typeof catalogId === 'string' ? catalogId.trim() : '';
  return CATALOG_BY_ID.get(clean) || null;
}

function countCustomPetFrames(pet) {
  if (!pet || pet.kind !== 'frames') return 0;
  let total = Array.isArray(pet.frames) ? pet.frames.length : 0;
  if (pet.stateFrames && typeof pet.stateFrames === 'object') {
    for (const track of VALID_OPTIONAL_TRACKS) {
      if (Array.isArray(pet.stateFrames[track])) {
        total += pet.stateFrames[track].length;
      }
    }
  }
  return total;
}

export function findInstalledCatalogMatch(customPets, catalogItem) {
  if (!Array.isArray(customPets) || !catalogItem) return null;
  const byCatalogId = customPets.find((p) => p && p.catalogId === catalogItem.id);
  if (byCatalogId) return byCatalogId;
  // Backward-compatibility for local pets created before catalogId tagging
  return (
    customPets.find(
      (p) =>
        p &&
        p.kind === 'frames' &&
        (p.name === catalogItem.name || p.name === catalogItem.nameEn) &&
        countCustomPetFrames(p) >= Math.min(24, catalogItem.frameCount || 24),
    ) || null
  );
}

export function listCatalogWithStatus(customPets = []) {
  return DOWNLOADABLE_PET_CATALOG.map((item) => {
    const installedEntry = findInstalledCatalogMatch(customPets, item);
    return {
      id: item.id,
      name: item.name,
      nameEn: item.nameEn,
      fps: item.fps,
      trackCount: item.trackCount,
      frameCount: item.frameCount,
      sizeBytes: item.sizeBytes,
      assetName: item.assetName,
      installed: Boolean(installedEntry),
      installedPetId: installedEntry ? installedEntry.id : '',
      downloading: inFlightDownloads.has(item.id),
    };
  });
}

export async function readCatalogPreviewAsset(catalogId) {
  const item = findCatalogPet(catalogId);
  if (!item) return null;
  const cleanName = path.basename(item.previewFile);
  const fullPath = path.resolve(ASSETS_DIR, cleanName);
  const prefix = ASSETS_DIR.endsWith(path.sep) ? ASSETS_DIR : `${ASSETS_DIR}${path.sep}`;
  if (!fullPath.startsWith(prefix)) return null;
  try {
    const buf = await fs.readFile(fullPath);
    return { buf, mime: item.previewMime || 'image/png' };
  } catch {
    return null;
  }
}

function sanitizeZipEntryPath(rawName) {
  const normalized = String(rawName || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) return '';
  if (normalized.includes('\0') || /^[a-zA-Z]:/.test(normalized)) {
    throw Object.assign(new Error('压缩包包含非法路径'), { code: 'PATH_TRAVERSAL' });
  }
  const segs = normalized.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') {
      throw Object.assign(new Error('压缩包包含越界路径'), { code: 'PATH_TRAVERSAL' });
    }
  }
  return segs.join('/');
}

/**
 * Pure Node.js zero-dependency ZIP archive reader supporting Store (0) and Deflate (8),
 * with strict Zip-Slip and decompression-bomb guards.
 */
export function extractZipEntries(
  zipBuffer,
  { maxEntries = MAX_ZIP_ENTRIES, maxTotalBytes = MAX_ZIP_UNCOMPRESSED_BYTES } = {},
) {
  const buf = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer || []);
  if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw Object.assign(new Error('桌宠压缩包格式无效'), { code: 'INVALID_ARCHIVE' });
  }

  // Locate End of Central Directory (EOCD) signature 0x06054b50 from tail
  const searchStart = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= searchStart; i -= 1) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw Object.assign(new Error('桌宠压缩包缺少索引尾部'), { code: 'INVALID_ARCHIVE' });
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (totalEntries > maxEntries) {
    throw Object.assign(new Error('桌宠压缩包文件数量超出安全上限'), { code: 'PAYLOAD_TOO_LARGE' });
  }
  if (cdOffset + cdSize > buf.length) {
    throw Object.assign(new Error('桌宠压缩包索引损坏'), { code: 'INVALID_ARCHIVE' });
  }

  const entries = new Map();
  let cursor = cdOffset;
  let totalUncompressed = 0;

  for (let idx = 0; idx < totalEntries; idx += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw Object.assign(new Error('桌宠压缩包中央目录损坏'), { code: 'INVALID_ARCHIVE' });
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);

    const rawName = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith('/')) continue;
    const safeRel = sanitizeZipEntryPath(rawName);
    if (!safeRel) continue;

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw Object.assign(new Error('桌宠压缩包本地文件头损坏'), { code: 'INVALID_ARCHIVE' });
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw Object.assign(new Error('桌宠压缩包数据截断'), { code: 'INVALID_ARCHIVE' });
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxTotalBytes) {
      throw Object.assign(new Error('桌宠压缩包解压后体积超出安全上限'), { code: 'PAYLOAD_TOO_LARGE' });
    }

    const rawSlice = buf.subarray(dataStart, dataEnd);
    let fileBuf;
    if (method === 0) {
      fileBuf = Buffer.from(rawSlice);
    } else if (method === 8) {
      fileBuf = zlib.inflateRawSync(rawSlice, { maxOutputLength: maxTotalBytes });
    } else {
      throw Object.assign(new Error(`不支持的压缩方式 (${method})`), { code: 'INVALID_ARCHIVE' });
    }

    if (fileBuf.length > maxTotalBytes) {
      throw Object.assign(new Error('桌宠压缩包单文件体积超出安全上限'), { code: 'PAYLOAD_TOO_LARGE' });
    }
    entries.set(safeRel, fileBuf);
  }

  return entries;
}

function isAllowedOfficialDownloadUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (parsed.protocol !== 'https:') return false;
    return (
      parsed.href.startsWith(OFFICIAL_RELEASE_DOWNLOAD_PREFIX) ||
      parsed.hostname === 'github.com' ||
      parsed.hostname === 'codeload.github.com' ||
      parsed.hostname.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
}

async function fetchPackZipBuffer(url, { fetchImpl = proxyAwareFetch, allowAnyUrl = false, timeoutMs = 90_000 } = {}) {
  if (!allowAnyUrl && !String(url || '').startsWith(OFFICIAL_RELEASE_DOWNLOAD_PREFIX)) {
    throw Object.assign(new Error('仅允许从官方 GitHub Release 下载桌宠素材包'), { code: 'FORBIDDEN_URL' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let curUrl = String(url);
    let res = null;
    for (let hop = 0; hop < 5; hop += 1) {
      res = await fetchImpl(curUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'agy-monitor-pet-downloader' },
        redirect: 'follow',
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc =
          typeof res.headers?.get === 'function'
            ? res.headers.get('location')
            : res.headers?.location || res.headers?.Location;
        if (!loc) break;
        const nextUrl = new URL(String(loc), curUrl);
        if (!allowAnyUrl && !isAllowedOfficialDownloadUrl(nextUrl.toString())) {
          throw Object.assign(new Error('素材包重定向至非官方域名，已中止下载'), { code: 'FORBIDDEN_URL' });
        }
        curUrl = nextUrl.toString();
        continue;
      }
      break;
    }
    if (!res || !res.ok) {
      const status = res?.status || 502;
      throw Object.assign(
        new Error(
          status === 404
            ? '云端尚未找到该桌宠素材包，请确认网络或稍后再试'
            : `下载桌宠素材包失败 (HTTP ${status})`,
        ),
        { code: status === 404 ? 'NOT_FOUND' : 'DOWNLOAD_FAILED', status },
      );
    }
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length < 64 || buf.length > MAX_PET_PACK_ZIP_BYTES) {
      throw Object.assign(new Error('下载的桌宠素材包大小异常'), { code: 'PAYLOAD_TOO_LARGE' });
    }
    return buf;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw Object.assign(new Error('下载桌宠素材包超时，请检查网络连接或系统代理'), {
        code: 'DOWNLOAD_TIMEOUT',
        status: 504,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download, verify SHA-256, extract, and install a downloadable catalog pet into local petStore.
 */
export async function downloadAndInstallCatalogPet({
  catalogId,
  petStore,
  fetchImpl = proxyAwareFetch,
  overrideUrl = '',
  skipChecksum = false,
} = {}) {
  const item = findCatalogPet(catalogId);
  if (!item) {
    throw Object.assign(new Error('未找到对应的云端桌宠'), { code: 'NOT_FOUND' });
  }
  if (!petStore || typeof petStore.saveCustomPetFrameAnimation !== 'function') {
    throw Object.assign(new Error('桌宠存储未初始化'), { code: 'INTERNAL_ERROR' });
  }

  if (inFlightDownloads.has(item.id)) {
    return inFlightDownloads.get(item.id);
  }

  const task = (async () => {
    const targetUrl = overrideUrl || item.downloadUrl;
    const zipBuf = await fetchPackZipBuffer(targetUrl, {
      fetchImpl,
      allowAnyUrl: Boolean(overrideUrl),
    });

    if (!skipChecksum && item.sha256) {
      const actualSha = crypto.createHash('sha256').update(zipBuf).digest('hex');
      if (actualSha !== item.sha256.toLowerCase()) {
        throw Object.assign(new Error('桌宠素材包 SHA-256 校验失败，已中止安装'), {
          code: 'CHECKSUM_MISMATCH',
          status: 422,
        });
      }
    }

    const entries = extractZipEntries(zipBuf);
    const manifestBuf = entries.get('manifest.json');
    if (!manifestBuf) {
      throw Object.assign(new Error('桌宠素材包缺少 manifest.json'), { code: 'INVALID_ARCHIVE' });
    }
    let manifest;
    try {
      manifest = JSON.parse(manifestBuf.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      throw Object.assign(new Error('桌宠素材包 manifest.json 格式损坏'), { code: 'INVALID_ARCHIVE' });
    }

    const tracksObj = manifest?.tracks && typeof manifest.tracks === 'object' ? manifest.tracks : {};
    const decodeTrack = (relList) => {
      if (!Array.isArray(relList) || relList.length === 0) return [];
      return relList.map((relPath) => {
        const cleanRel = sanitizeZipEntryPath(relPath);
        const frameBuf = entries.get(cleanRel);
        if (!frameBuf) {
          throw Object.assign(new Error(`桌宠素材包缺少帧文件：${cleanRel}`), { code: 'INVALID_ARCHIVE' });
        }
        const sniffedMime = detectRasterMagic(frameBuf);
        if (!sniffedMime) {
          throw Object.assign(new Error(`桌宠素材包含无效位图帧：${cleanRel}`), {
            code: 'INVALID_IMAGE_MAGIC',
          });
        }
        return {
          mime: sniffedMime,
          base64: frameBuf.toString('base64'),
        };
      });
    };

    const idleFrames = decodeTrack(tracksObj.idle);
    if (idleFrames.length === 0) {
      throw Object.assign(new Error('桌宠素材包缺少待机动画帧'), { code: 'EMPTY_PAYLOAD' });
    }
    const stateFrames = {};
    for (const trackName of VALID_OPTIONAL_TRACKS) {
      const decoded = decodeTrack(tracksObj[trackName]);
      if (decoded.length > 0) {
        stateFrames[trackName] = decoded;
      }
    }

    const currentCfg = await petStore.getPetConfig();
    const existing = findInstalledCatalogMatch(currentCfg.customPets, item);

    const saved = await petStore.saveCustomPetFrameAnimation({
      id: existing ? existing.id : '',
      catalogId: item.id,
      name: typeof manifest?.name === 'string' && manifest.name.trim() ? manifest.name.trim() : item.name,
      fps: Number(manifest?.fps) || item.fps || 18,
      frames: idleFrames,
      stateFrames,
    });

    return {
      ok: true,
      catalogId: item.id,
      pet: saved.pet,
      petState: saved.petState,
    };
  })();

  inFlightDownloads.set(item.id, task);
  try {
    return await task;
  } finally {
    inFlightDownloads.delete(item.id);
  }
}
