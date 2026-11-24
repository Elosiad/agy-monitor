/**
 * Desktop Pet Pluggable Extension Entry Point.
 *
 * Self-contained backend + static asset registration + Windows companion lifecycle.
 * Removing this directory leaves the core agy-monitor application 100% functional.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectCustomPetFilenames,
  createPetStorage,
  resolvePetPaths,
} from './pet_storage.mjs';
import {
  ensurePetCompanionAssets,
  getPetCompanionStatus,
  syncPetCompanion,
} from './pet_companion.mjs';
import { importPetFrameAnimation } from './mcp_tools.mjs';
import {
  buildInteractivePreviewHtml,
  exportPetPreviewFiles,
  loadPetTracksMedia,
} from './preview_builder.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function mapPetErrorStatus(err) {
  const code = err?.code;
  if (code === 'UNSUPPORTED_MEDIA_TYPE' || code === 'INVALID_IMAGE_MAGIC') return 415;
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  if (code === 'NOT_FOUND') return 404;
  if (
    code === 'INVALID_ID' ||
    code === 'EMPTY_PAYLOAD' ||
    code === 'BUILTIN_PALETTE' ||
    code === 'PATH_TRAVERSAL'
  ) {
    return 400;
  }
  return 500;
}

export const desktopPetExtension = {
  id: 'desktop_pet',
  frontendDir: FRONTEND_DIR,

  registerRoutes({ register, paths, makeResponse, errorResponse }) {
    const petPaths = resolvePetPaths(paths);
    const petStore = createPetStorage(petPaths);

    // Serve self-contained extension CSS
    register('GET', '/extensions/desktop_pet/desktop_pet.css', async () => {
      try {
        const css = await fs.readFile(path.join(FRONTEND_DIR, 'desktop_pet.css'));
        return makeResponse(css, {
          status: 200,
          contentType: 'text/css; charset=utf-8',
          headers: { 'Cache-Control': 'no-cache' },
        });
      } catch {
        return makeResponse('Not found', { status: 404, contentType: 'text/plain' });
      }
    });

    // Serve custom pet single image or frame asset under extension-owned namespace
    register('GET', '/api/ext/pet/asset', async (data = {}) => {
      try {
        const id = String(data.id || '').trim();
        const reqFile = typeof data.file === 'string' && data.file.trim() ? path.basename(data.file.trim()) : '';
        if (!SAFE_ID_RE.test(id)) {
          return errorResponse(400, '非法桌宠资源 ID');
        }
        const cfg = await petStore.getPetConfig();
        const entry = cfg.customPets.find((p) => p.id === id);
        if (!entry) {
          return errorResponse(404, '未找到自定义桌宠');
        }

        let targetFile = entry.filename;
        if (reqFile) {
          const allowed = collectCustomPetFilenames(entry);
          if (!allowed.has(reqFile)) {
            return errorResponse(404, '未找到指定动画帧');
          }
          targetFile = reqFile;
        }

        const res = await petStore.readSafePetAsset(targetFile);
        if (res?.forbidden) {
          return errorResponse(403, '不支持的非位图扩展名');
        }
        if (!res?.buf) {
          return errorResponse(404, '桌宠图片文件已丢失');
        }
        return makeResponse(res.buf, {
          status: 200,
          contentType: res.mime,
          headers: {
            'Cache-Control': 'private, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch (err) {
        return errorResponse(mapPetErrorStatus(err), err);
      }
    });

    register('GET', '/api/pet', async () => {
      try {
        const petState = await petStore.getPetConfig();
        const petCompanion = await getPetCompanionStatus(petPaths, petState);
        return { ok: true, petState, petCompanion };
      } catch (err) {
        return errorResponse(mapPetErrorStatus(err), err);
      }
    });

    register('POST', '/api/pet/save', async (data = {}) => {
      const incoming =
        data.petState && typeof data.petState === 'object'
          ? data.petState
          : data && typeof data === 'object'
            ? data
            : {};
      try {
        const petState = await petStore.savePetConfig(incoming);
        const syncRes = await syncPetCompanion(petPaths, petState, 'sync').catch(() => null);
        const petCompanion = syncRes?.status || (await getPetCompanionStatus(petPaths, petState));
        return { ok: true, petState, petCompanion };
      } catch (err) {
        return errorResponse(mapPetErrorStatus(err), err);
      }
    });

    register('POST', '/api/pet/upload', async (data = {}) => {
      try {
        const saved = await petStore.saveCustomPetFile({
          name: data.name || '自定义桌宠',
          mime: data.mime,
          base64: data.base64,
        });
        const petCompanion = await getPetCompanionStatus(petPaths, saved.petState);
        return { ok: true, pet: saved.pet, petState: saved.petState, petCompanion };
      } catch (err) {
        return errorResponse(mapPetErrorStatus(err), err);
      }
    });

    register('POST', '/api/pet/frames/save', async (data = {}) => {
      try {
        const saved = await petStore.saveCustomPetFrameAnimation({
          id: typeof data.id === 'string' ? data.id.trim() : '',
          name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '自定义帧动画',
          fps: Number(data.fps) || 8,
          frames: Array.isArray(data.frames) ? data.frames : [],
          stateFrames: data.stateFrames && typeof data.stateFrames === 'object' ? data.stateFrames : {},
        });
        const petCompanion = await getPetCompanionStatus(petPaths, saved.petState);
        return { ok: true, pet: saved.pet, petState: saved.petState, petCompanion };
      } catch (err) {
        return errorResponse(mapPetErrorStatus(err), err);
      }
    });

    register('POST', '/api/pet/frames/import-local', async (data = {}) => {
      try {
        // Strip caller-specified output paths over HTTP so preview files always stay inside pluginDataDir
        const safeArgs = data && typeof data === 'object' ? { ...data } : {};
        delete safeArgs.output_html_path;
        delete safeArgs.outputHtmlPath;
        delete safeArgs.outputDir;
        delete safeArgs.output_dir;
        return await importPetFrameAnimation({ petStore, petPaths, args: safeArgs });
      } catch (err) {
        return errorResponse(mapPetErrorStatus(err), err);
      }
    });

    register('POST', '/api/pet/preview', async (data = {}) => {
      try {
        const current = await petStore.getPetConfig();
        const targetId =
          typeof data.petId === 'string' && data.petId.trim()
            ? data.petId.trim()
            : typeof data.pet_id === 'string' && data.pet_id.trim()
              ? data.pet_id.trim()
              : current.activePetId;
        const track = typeof data.track === 'string' ? data.track : 'idle';
        const explicitEnable =
          typeof data.enablePet === 'boolean'
            ? data.enablePet
            : typeof data.enable_pet === 'boolean'
              ? data.enable_pet
              : null;
        if (explicitEnable !== null) {
          await petStore.savePetConfig({
            enabled: explicitEnable,
            activePetId: targetId,
          });
        }
        const petState = await petStore.triggerPreviewSignal({
          petId: targetId,
          track,
          openTab: data.openTab !== false && data.open_tab !== false,
          activate: data.activate !== false,
          message: typeof data.message === 'string' ? data.message : '',
        });
        let petCompanion = await getPetCompanionStatus(petPaths, petState);
        if (petState.enabled || explicitEnable === false) {
          const syncRes = await syncPetCompanion(petPaths, petState, 'sync').catch(() => null);
          if (syncRes?.status) petCompanion = syncRes.status;
        }
        const customEntry = petState.customPets.find((p) => p.id === targetId);
        let preview = null;
        if (customEntry && data.exportFiles !== false) {
          preview = await exportPetPreviewFiles(petStore, customEntry, {
            initialTrack: track,
            writeContactSheet: true,
          });
        }
        return { ok: true, petId: targetId, track, petState, petCompanion, preview };
      } catch (err) {
        return errorResponse(mapPetErrorStatus(err), err);
      }
    });

    register('GET', '/api/pet/preview-html', async (data = {}) => {
      try {
        const cfg = await petStore.getPetConfig();
        const targetId = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : cfg.activePetId;
        if (!SAFE_ID_RE.test(targetId)) {
          return errorResponse(400, '非法桌宠资源 ID');
        }
        const entry = cfg.customPets.find((p) => p.id === targetId);
        if (!entry) {
          return errorResponse(404, '未找到对应的自定义桌宠动画');
        }
        const { tracks } = await loadPetTracksMedia(petStore, entry, { decodeForContactSheet: false });
        const html = buildInteractivePreviewHtml(entry, tracks, {
          initialTrack: typeof data.track === 'string' ? data.track : 'idle',
        });
        return makeResponse(html, {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: {
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy':
              "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
          },
        });
      } catch (err) {
        return errorResponse(mapPetErrorStatus(err), err);
      }
    });

    register('POST', '/api/pet/delete', async (data = {}) => {
      const petId = typeof data.petId === 'string' ? data.petId.trim() : '';
      if (!petId) {
        return errorResponse(400, 'petId 不能为空');
      }
      try {
        const res = await petStore.deleteCustomPetFile(petId);
        let petCompanion = await getPetCompanionStatus(petPaths, res.petState);
        if (res.petState.enabled) {
          const syncRes = await syncPetCompanion(petPaths, res.petState, 'sync').catch(() => null);
          if (syncRes?.status) petCompanion = syncRes.status;
        }
        return { ok: true, petState: res.petState, petCompanion };
      } catch (err) {
        return errorResponse(mapPetErrorStatus(err), err);
      }
    });
  },

  async onStart({ paths, skipWorker }) {
    if (skipWorker) return;
    const petConfigPath = path.join(paths.pluginDataDir, 'pet_config.json');
    try {
      const raw = (await fs.readFile(petConfigPath, 'utf8')).replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.enabled !== true || parsed.displayMode === 'panel') return;
    } catch {
      // Never create pet_config.json or spawn companion on startup when pet was never enabled
      return;
    }
    const petPaths = resolvePetPaths(paths);
    const petStore = createPetStorage(petPaths);
    const petState = await petStore.getPetConfig().catch(() => null);
    if (petState?.enabled && petState?.displayMode !== 'panel') {
      void syncPetCompanion(petPaths, petState, 'sync').catch(() => {});
    }
  },

  async onShutdown({ paths, skipWorker }) {
    if (skipWorker) return;
    const petPaths = resolvePetPaths(paths);
    await syncPetCompanion(petPaths, { enabled: false }, 'stop').catch(() => {});
  },

  async onInstall(corePaths) {
    const petPaths = resolvePetPaths(corePaths);
    return ensurePetCompanionAssets(petPaths);
  },
};

export default desktopPetExtension;
