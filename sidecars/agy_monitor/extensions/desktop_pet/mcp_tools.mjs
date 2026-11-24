/**
 * MCP tools & local frame-import service for the Desktop Pet pluggable extension.
 *
 * Allows Antigravity's Gemini model to:
 *  - Inspect desktop pet state & existing custom animations (`pet_get_state`)
 *  - Slice AI-generated sprite sheets with automatic background removal (`pet_slice_sprite_sheet`)
 *  - Assemble & save multi-track frame animations directly from local files, base64, or sprite sheets (`pet_create_frame_animation`)
 *  - Trigger live preview in AGY Console + export interactive HTML & contact-sheet PNG previews (`pet_preview_animation`)
 *  - Toggle / configure the live Windows desktop pet (`pet_update_settings`)
 *  - Delete custom pets (`pet_delete`)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_PET_TRACK_FRAMES,
  createPetStorage,
  detectRasterMagic,
  resolvePetPaths,
} from './pet_storage.mjs';
import { getPetCompanionStatus, syncPetCompanion } from './pet_companion.mjs';
import {
  buildContactSheetPng,
  processSingleFrameBuffer,
  sliceSpriteSheetBuffer,
} from './sprite_processor.mjs';
import { exportPetPreviewFiles } from './preview_builder.mjs';

const SIDECAR_LINK = '[AGY 控制台](sidecar://agy-monitor/agy_monitor/)';
const MAX_RAW_SHEET_BYTES = 24 * 1024 * 1024;
const MAX_RAW_FRAME_BYTES = 12 * 1024 * 1024;
const VALID_TRACKS = ['idle', 'running', 'unread', 'interact', 'walk', 'drag'];

function isUncPath(raw) {
  const s = String(raw || '').trim();
  return s.startsWith('\\\\') || s.startsWith('//') || s.startsWith('\\\\?\\') || s.startsWith('\\\\.\\');
}

function isPathInsideBase(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const normBase = process.platform === 'win32' ? base.toLowerCase() : base;
  const normTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  const prefix = normBase.endsWith(path.sep) ? normBase : `${normBase}${path.sep}`;
  return normTarget === normBase || normTarget.startsWith(prefix);
}

async function resolveSafeSliceOutputDir(rawDir, petPaths) {
  const defaultBase = path.join(petPaths.pluginDataDir, 'pet_previews');
  await fs.mkdir(defaultBase, { recursive: true });
  if (!rawDir) {
    return path.join(defaultBase, `slices_${Date.now().toString(36)}`);
  }
  const clean = String(rawDir).trim();
  if (isUncPath(clean)) {
    throw Object.assign(new Error('output_dir 不允许使用 UNC 或设备路径'), { code: 'PATH_TRAVERSAL' });
  }
  const resolved = path.resolve(clean);
  const allowed = [defaultBase, os.tmpdir()];
  for (const r of [...allowed]) {
    const real = await fs.realpath(r).catch(() => null);
    if (real && !allowed.includes(real)) allowed.push(real);
  }
  if (!allowed.some((r) => isPathInsideBase(r, resolved))) {
    throw Object.assign(new Error('output_dir 必须位于插件预览目录或系统临时目录内'), {
      code: 'PATH_TRAVERSAL',
    });
  }
  let probe = resolved;
  while (true) {
    const lst = await fs.lstat(probe).catch(() => null);
    if (lst) {
      if (lst.isSymbolicLink()) {
        throw Object.assign(new Error('output_dir 禁止使用符号链接'), { code: 'PATH_TRAVERSAL' });
      }
      const realAnc = await fs.realpath(probe).catch(() => null);
      if (!realAnc || !allowed.some((r) => isPathInsideBase(r, realAnc))) {
        throw Object.assign(new Error('output_dir 符号链接越界'), { code: 'PATH_TRAVERSAL' });
      }
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return resolved;
}

export async function readSafeLocalRaster(rawPath, maxBytes = MAX_RAW_FRAME_BYTES) {
  const clean = String(rawPath || '').trim();
  if (!clean) {
    throw Object.assign(new Error('图片路径不能为空'), { code: 'EMPTY_PAYLOAD' });
  }
  if (isUncPath(clean)) {
    throw Object.assign(new Error('出于安全策略，已拒绝 UNC 网络路径'), { code: 'PATH_TRAVERSAL' });
  }
  const resolved = path.resolve(clean);
  const realPath = await fs.realpath(resolved).catch(() => null);
  if (!realPath) {
    throw Object.assign(new Error(`找不到本地图片文件: ${resolved}`), { code: 'NOT_FOUND' });
  }
  if (isUncPath(realPath)) {
    throw Object.assign(new Error('出于安全策略，已拒绝指向 UNC 网络路径的符号链接'), {
      code: 'PATH_TRAVERSAL',
    });
  }
  const st = await fs.stat(realPath).catch(() => null);
  if (!st || !st.isFile()) {
    throw Object.assign(new Error(`找不到本地图片文件: ${resolved}`), { code: 'NOT_FOUND' });
  }
  if (st.size <= 0 || st.size > maxBytes) {
    throw Object.assign(
      new Error(`图片文件大小超出限制 (${Math.round(maxBytes / 1048576)}MB): ${resolved}`),
      { code: 'PAYLOAD_TOO_LARGE' },
    );
  }
  const buf = await fs.readFile(realPath);
  const headText = buf.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (headText.startsWith('<svg') || headText.startsWith('<?xml') || headText.includes('<script')) {
    throw Object.assign(new Error('检测到 SVG/XML 文本头，出于安全策略已禁止导入'), {
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  }
  const mime = detectRasterMagic(buf);
  if (!mime) {
    throw Object.assign(new Error(`文件头不是合法的 PNG/JPEG/WEBP/GIF 位图: ${resolved}`), {
      code: 'INVALID_IMAGE_MAGIC',
    });
  }
  return { buf, mime, resolved: realPath };
}

async function resolveTrackItems(rawList, sheetSpec, defaults = {}) {
  const out = [];
  const bgMode = defaults.removeBackground ?? 'none';
  const bgTolerance = defaults.bgTolerance ?? 28;
  const trimAndAlign = Boolean(defaults.trimAndAlign);
  const maxSize = defaults.maxSize ?? 256;

  // 1. Optional sprite sheet for this track
  if (sheetSpec && typeof sheetSpec === 'object' && (sheetSpec.path || sheetSpec.base64)) {
    let rawBuf;
    if (sheetSpec.path) {
      const loaded = await readSafeLocalRaster(sheetSpec.path, MAX_RAW_SHEET_BYTES);
      rawBuf = loaded.buf;
    } else {
      const rawB64 = String(sheetSpec.base64 || '').replace(/^data:[^;,]+;base64,/i, '').trim();
      const maxB64Len = Math.ceil((MAX_RAW_SHEET_BYTES * 4) / 3) + 64;
      if (!rawB64 || rawB64.length > maxB64Len) {
        throw Object.assign(new Error('精灵表 base64 数据超出大小限制 (24MB)'), { code: 'PAYLOAD_TOO_LARGE' });
      }
      rawBuf = Buffer.from(rawB64, 'base64');
    }
    const sliced = await sliceSpriteSheetBuffer(rawBuf, {
      cols: sheetSpec.cols ?? 4,
      rows: sheetSpec.rows ?? 1,
      frameCount: sheetSpec.frame_count ?? sheetSpec.frameCount ?? null,
      removeBackground: sheetSpec.remove_background ?? sheetSpec.removeBackground ?? 'auto',
      bgTolerance: sheetSpec.bg_tolerance ?? sheetSpec.bgTolerance ?? bgTolerance,
      trimAndAlign:
        sheetSpec.trim_and_align !== undefined
          ? Boolean(sheetSpec.trim_and_align)
          : sheetSpec.trimAndAlign !== undefined
            ? Boolean(sheetSpec.trimAndAlign)
            : true,
      maxSize: sheetSpec.max_size ?? sheetSpec.maxSize ?? maxSize,
    });
    for (const fr of sliced.frames) {
      out.push({
        mime: 'image/png',
        base64: fr.pngBuffer.toString('base64'),
      });
    }
  }

  // 2. Optional explicit frame items (string path, { path }, { existingFilename }, or { base64, mime })
  if (Array.isArray(rawList)) {
    if (out.length + rawList.length > MAX_PET_TRACK_FRAMES) {
      throw Object.assign(new Error(`单条动画轨道最多支持 ${MAX_PET_TRACK_FRAMES} 帧`), {
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
    for (const item of rawList) {
      if (typeof item === 'string' && item.trim()) {
        const loaded = await readSafeLocalRaster(item.trim(), MAX_RAW_FRAME_BYTES);
        if (bgMode !== 'none' || trimAndAlign || loaded.mime !== 'image/png') {
          const proc = await processSingleFrameBuffer(loaded.buf, {
            removeBackground: bgMode,
            bgTolerance,
            trimAndAlign,
            maxSize,
          });
          out.push({ mime: 'image/png', base64: proc.pngBuffer.toString('base64') });
        } else {
          out.push({ mime: loaded.mime, base64: loaded.buf.toString('base64') });
        }
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      if (typeof item.existingFilename === 'string' && item.existingFilename.trim()) {
        out.push({ existingFilename: item.existingFilename.trim() });
        continue;
      }
      if (typeof item.path === 'string' && item.path.trim()) {
        const loaded = await readSafeLocalRaster(item.path.trim(), MAX_RAW_FRAME_BYTES);
        const itemBg = item.remove_background ?? item.removeBackground ?? bgMode;
        const itemAlign =
          item.trim_and_align !== undefined
            ? Boolean(item.trim_and_align)
            : item.trimAndAlign !== undefined
              ? Boolean(item.trimAndAlign)
              : trimAndAlign;
        if (itemBg !== 'none' || itemAlign || loaded.mime !== 'image/png') {
          const proc = await processSingleFrameBuffer(loaded.buf, {
            removeBackground: itemBg,
            bgTolerance: item.bg_tolerance ?? item.bgTolerance ?? bgTolerance,
            trimAndAlign: itemAlign,
            maxSize: item.max_size ?? item.maxSize ?? maxSize,
          });
          out.push({ mime: 'image/png', base64: proc.pngBuffer.toString('base64') });
        } else {
          out.push({ mime: loaded.mime, base64: loaded.buf.toString('base64') });
        }
        continue;
      }
      if (typeof item.base64 === 'string' && item.base64.trim()) {
        out.push({
          mime: item.mime || 'image/png',
          base64: item.base64,
        });
      }
    }
  }

  return out;
}

/**
 * Shared import handler used by both MCP `pet_create_frame_animation` and HTTP `POST /api/pet/frames/import-local`.
 */
export async function importPetFrameAnimation({ petStore, petPaths, args = {} }) {
  const defaults = {
    removeBackground: args.remove_background ?? args.removeBackground ?? 'none',
    bgTolerance: args.bg_tolerance ?? args.bgTolerance ?? 28,
    trimAndAlign: Boolean(args.trim_and_align ?? args.trimAndAlign ?? false),
    maxSize: args.max_size ?? args.maxSize ?? 256,
  };
  const sheets = args.sprite_sheets && typeof args.sprite_sheets === 'object'
    ? args.sprite_sheets
    : args.spriteSheets && typeof args.spriteSheets === 'object'
      ? args.spriteSheets
      : {};

  const idleList = await resolveTrackItems(
    args.idle_frames ?? args.frames ?? [],
    sheets.idle,
    defaults,
  );
  if (idleList.length === 0) {
    throw Object.assign(
      new Error('请至少提供 1 帧待机动画（通过 idle_frames 或 sprite_sheets.idle）'),
      { code: 'EMPTY_PAYLOAD' },
    );
  }

  const stateFrames = {};
  for (const track of ['running', 'unread', 'interact', 'walk', 'drag']) {
    const rawTrack = args[`${track}_frames`] ?? args.stateFrames?.[track] ?? [];
    const list = await resolveTrackItems(rawTrack, sheets[track], defaults);
    if (list.length > 0) stateFrames[track] = list;
  }

  const saved = await petStore.saveCustomPetFrameAnimation({
    id: typeof args.id === 'string' ? args.id.trim() : '',
    name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'AI 生成桌宠',
    fps: Number(args.fps) || 8,
    frames: idleList,
    stateFrames,
  });

  let petState = saved.petState;
  const wantActivate = args.activate !== false;
  const wantEnable = typeof args.enable_pet === 'boolean'
    ? args.enable_pet
    : typeof args.enablePet === 'boolean'
      ? args.enablePet
      : null;

  const patch = {};
  if (wantActivate && petState.activePetId !== saved.pet.id) {
    patch.activePetId = saved.pet.id;
  }
  if (wantEnable !== null) {
    patch.enabled = wantEnable;
  }
  if (Object.keys(patch).length > 0) {
    petState = await petStore.savePetConfig(patch);
  }

  const wantPreview = args.preview_now !== false && args.previewNow !== false;
  if (wantPreview) {
    petState = await petStore.triggerPreviewSignal({
      petId: saved.pet.id,
      track: VALID_TRACKS.includes(args.preview_track) ? args.preview_track : 'idle',
      openTab: true,
      activate: wantActivate,
      message:
        typeof args.preview_message === 'string' && args.preview_message.trim()
          ? args.preview_message.trim()
          : `✨ 新动画「${saved.pet.name}」已就绪，点击舞台可测试互动！`,
    });
  }

  let petCompanion = await getPetCompanionStatus(petPaths, petState);
  if (petState.enabled || wantEnable === false) {
    const syncRes = await syncPetCompanion(petPaths, petState, 'sync').catch(() => null);
    if (syncRes?.status) petCompanion = syncRes.status;
  }

  let previewFiles = null;
  if (args.generate_preview !== false && args.generatePreview !== false) {
    previewFiles = await exportPetPreviewFiles(petStore, saved.pet, {
      outputHtmlPath: typeof args.output_html_path === 'string' ? args.output_html_path : '',
      initialTrack: VALID_TRACKS.includes(args.preview_track) ? args.preview_track : 'idle',
      writeContactSheet: true,
    });
  }

  return {
    ok: true,
    pet: saved.pet,
    petState,
    petCompanion,
    preview: {
      livePreviewTriggered: wantPreview,
      sidecarLink: SIDECAR_LINK,
      ...(previewFiles || {}),
    },
  };
}

function summarizePetEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind || 'image',
    fps: entry.fps || null,
    tracks: entry.kind === 'frames'
      ? {
          idle: entry.frames?.length || 0,
          running: entry.stateFrames?.running?.length || 0,
          unread: entry.stateFrames?.unread?.length || 0,
          interact: entry.stateFrames?.interact?.length || 0,
          walk: entry.stateFrames?.walk?.length || 0,
          drag: entry.stateFrames?.drag?.length || 0,
        }
      : { idle: 1, running: 0, unread: 0, interact: 0, walk: 0, drag: 0 },
    createdAt: entry.createdAt || null,
  };
}

export function createMcpTools({ corePaths }) {
  const petPaths = resolvePetPaths(corePaths);
  const petStore = createPetStorage(petPaths);

  return [
    {
      definition: {
        name: 'pet_get_state',
        description:
          'Read the current AGY Desktop Pet state: enabled status, active pet ID, display mode, size/opacity, built-in pets, all custom pets/frame-animations (with track frame counts & FPS), and live Windows desktop companion status.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      async handler() {
        const petState = await petStore.getPetConfig();
        const petCompanion = await getPetCompanionStatus(petPaths, petState);
        return {
          ok: true,
          sidecarLink: SIDECAR_LINK,
          enabled: petState.enabled,
          activePetId: petState.activePetId,
          displayMode: petState.displayMode,
          size: petState.size,
          opacity: petState.opacity,
          alwaysOnTop: petState.alwaysOnTop,
          showSpeechBubble: petState.showSpeechBubble,
          bubbleTemplate: petState.bubbleTemplate,
          autoWander: petState.autoWander,
          selectable: petState.selectable,
          builtinPets: petState.builtinPets,
          customPets: petState.customPets.map(summarizePetEntry),
          petCompanion,
        };
      },
    },

    {
      definition: {
        name: 'pet_slice_sprite_sheet',
        description:
          'Slice a local sprite sheet image (horizontal strip or cols x rows grid, e.g. generated by image-generator) into clean transparent PNG frames with automatic solid/chroma background removal, unified bottom-centered alignment, and a checkerboard contact sheet PNG for visual inspection.',
        inputSchema: {
          type: 'object',
          required: ['image_path'],
          properties: {
            image_path: {
              type: 'string',
              description: 'Absolute local file path to the sprite sheet image (PNG/JPEG/WEBP/GIF).',
            },
            cols: {
              type: 'integer',
              description: 'Number of columns in the sprite sheet (default 4, range 1-32).',
              minimum: 1,
              maximum: 32,
            },
            rows: {
              type: 'integer',
              description: 'Number of rows in the sprite sheet (default 1, range 1-16).',
              minimum: 1,
              maximum: 16,
            },
            frame_count: {
              type: 'integer',
              description: 'Optional limit on total frames extracted (defaults to cols * rows).',
              minimum: 1,
              maximum: 48,
            },
            remove_background: {
              type: 'string',
              enum: ['auto', 'chroma', 'none'],
              description:
                'Background removal mode: "auto" (edge flood-fill + anti-aliased feathering, default), "chroma" (global solid color key), or "none".',
            },
            bg_tolerance: {
              type: 'integer',
              description: 'Background color match tolerance (4-100, default 28). Increase slightly for noisy JPEG/AI backgrounds.',
              minimum: 4,
              maximum: 100,
            },
            trim_and_align: {
              type: 'boolean',
              description: 'Unify scale and align character bottom-center across all frames to prevent animation jitter (default true).',
            },
            max_size: {
              type: 'integer',
              description: 'Target frame output size in pixels (48-512, default 256).',
              minimum: 48,
              maximum: 512,
            },
            output_dir: {
              type: 'string',
              description: 'Optional directory where sliced PNG frames and contact_sheet.png will be saved.',
            },
          },
        },
      },
      async handler(args) {
        const loaded = await readSafeLocalRaster(args.image_path, MAX_RAW_SHEET_BYTES);
        const sliced = await sliceSpriteSheetBuffer(loaded.buf, {
          cols: args.cols ?? 4,
          rows: args.rows ?? 1,
          frameCount: args.frame_count ?? null,
          removeBackground: args.remove_background ?? 'auto',
          bgTolerance: args.bg_tolerance ?? 28,
          trimAndAlign: args.trim_and_align !== false,
          maxSize: args.max_size ?? 256,
        });

        const outDir = await resolveSafeSliceOutputDir(args.output_dir, petPaths);
        await fs.mkdir(outDir, { recursive: true });

        const framePaths = [];
        for (let i = 0; i < sliced.frames.length; i += 1) {
          const fp = path.join(outDir, `frame_${String(i + 1).padStart(2, '0')}.png`);
          await fs.writeFile(fp, sliced.frames[i].pngBuffer);
          framePaths.push(fp);
        }

        const sheetPng = buildContactSheetPng(sliced.frames, { thumbSize: 128, columns: 6, padding: 8 });
        let contactSheetPath = '';
        if (sheetPng) {
          contactSheetPath = path.join(outDir, 'contact_sheet.png');
          await fs.writeFile(contactSheetPath, sheetPng);
        }

        return {
          ok: true,
          sourceWidth: sliced.sourceWidth,
          sourceHeight: sliced.sourceHeight,
          cols: sliced.cols,
          rows: sliced.rows,
          frameCount: framePaths.length,
          outputDir: outDir,
          framePaths,
          contactSheetPath,
        };
      },
    },

    {
      definition: {
        name: 'pet_create_frame_animation',
        description:
          'Create or update a multi-track Desktop Pet frame animation directly in AGY Console from local image file paths and/or sprite sheets (with automatic background removal & frame alignment). Automatically triggers live preview in the AGY Console panel and generates an interactive offline HTML preview + contact-sheet PNG.',
        inputSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            id: {
              type: 'string',
              description: 'Optional existing custom pet ID to update in-place.',
            },
            name: {
              type: 'string',
              description: 'Display name for the custom pet animation (e.g. "赛博柴犬").',
            },
            fps: {
              type: 'integer',
              description: 'Playback frame rate (1-30 FPS, default 8).',
              minimum: 1,
              maximum: 30,
            },
            idle_frames: {
              type: 'array',
              description: 'Array of local image file paths (or { path } / { base64, mime }) for the Idle track (required unless sprite_sheets.idle is provided).',
              items: { type: 'string' },
            },
            running_frames: {
              type: 'array',
              description: 'Optional array of local image file paths for the Agent Running / Thinking track.',
              items: { type: 'string' },
            },
            unread_frames: {
              type: 'array',
              description: 'Optional array of local image file paths for the Task Completed / Unread track.',
              items: { type: 'string' },
            },
            interact_frames: {
              type: 'array',
              description: 'Optional array of local image file paths for the User Pat / Interact track.',
              items: { type: 'string' },
            },
            walk_frames: {
              type: 'array',
              description: 'Optional array of local image file paths for the Autonomous Walking / Strolling track.',
              items: { type: 'string' },
            },
            drag_frames: {
              type: 'array',
              description: 'Optional array of local image file paths for the Dragging / Picked-up track.',
              items: { type: 'string' },
            },
            sprite_sheets: {
              type: 'object',
              description:
                'Optional sprite sheets per track ({ idle, running, unread, interact, walk, drag }). Each track object accepts { path, cols, rows, frame_count, remove_background, bg_tolerance, trim_and_align, max_size }.',
              properties: {
                idle: { type: 'object' },
                running: { type: 'object' },
                unread: { type: 'object' },
                interact: { type: 'object' },
                walk: { type: 'object' },
                drag: { type: 'object' },
              },
            },
            remove_background: {
              type: 'string',
              enum: ['auto', 'chroma', 'none'],
              description: 'Optional background removal for individual frame paths (default "none"; sprite sheets default to "auto").',
            },
            bg_tolerance: {
              type: 'integer',
              description: 'Background match tolerance (4-100, default 28).',
            },
            trim_and_align: {
              type: 'boolean',
              description: 'Whether to trim & center-align individual frame paths (default false; sprite sheets default to true).',
            },
            max_size: {
              type: 'integer',
              description: 'Max pixel dimension per saved frame (48-512, default 256).',
            },
            activate: {
              type: 'boolean',
              description: 'Set this pet as the active pet immediately (default true).',
            },
            enable_pet: {
              type: 'boolean',
              description: 'Optionally enable the live desktop/panel pet immediately (default leaves current enabled state unchanged).',
            },
            preview_now: {
              type: 'boolean',
              description: 'Signal the open AGY Console sidecar to switch to the Pet tab and preview this animation live (default true).',
            },
            preview_track: {
              type: 'string',
              enum: ['idle', 'running', 'unread', 'interact', 'walk', 'drag'],
              description: 'Initial track to preview (default "idle").',
            },
            preview_message: {
              type: 'string',
              description: 'Optional celebratory speech bubble text shown on the live preview stage.',
            },
            generate_preview: {
              type: 'boolean',
              description: 'Generate an offline interactive HTML player + contact-sheet PNG preview (default true).',
            },
            output_html_path: {
              type: 'string',
              description: 'Optional custom path for the generated interactive HTML preview file.',
            },
          },
        },
      },
      async handler(args) {
        const res = await importPetFrameAnimation({ petStore, petPaths, args });
        return {
          ok: true,
          pet: summarizePetEntry(res.pet),
          activePetId: res.petState.activePetId,
          enabled: res.petState.enabled,
          petCompanion: res.petCompanion,
          preview: res.preview,
        };
      },
    },

    {
      definition: {
        name: 'pet_preview_animation',
        description:
          'Trigger live animation preview for a custom or built-in pet in AGY Console (auto-opens the Pet tab and plays the selected track on stage) and export an interactive offline HTML preview player + checkerboard contact-sheet PNG.',
        inputSchema: {
          type: 'object',
          properties: {
            pet_id: {
              type: 'string',
              description: 'Target pet ID to preview (defaults to the currently active pet).',
            },
            track: {
              type: 'string',
              enum: ['idle', 'running', 'unread', 'interact', 'walk', 'drag'],
              description: 'Animation track to play in the preview (default "idle").',
            },
            message: {
              type: 'string',
              description: 'Optional speech bubble text shown during preview.',
            },
            open_tab: {
              type: 'boolean',
              description: 'Automatically switch AGY Console to the Pet tab (default true).',
            },
            enable_pet: {
              type: 'boolean',
              description: 'Optionally turn on the live desktop/panel pet at the same time.',
            },
            output_html_path: {
              type: 'string',
              description: 'Optional file path to save the standalone interactive HTML preview player.',
            },
          },
        },
      },
      async handler(args) {
        const current = await petStore.getPetConfig();
        const targetId =
          typeof args.pet_id === 'string' && args.pet_id.trim()
            ? args.pet_id.trim()
            : current.activePetId;
        const track = VALID_TRACKS.includes(args.track) ? args.track : 'idle';

        if (typeof args.enable_pet === 'boolean') {
          await petStore.savePetConfig({ enabled: args.enable_pet, activePetId: targetId });
        }

        const petState = await petStore.triggerPreviewSignal({
          petId: targetId,
          track,
          openTab: args.open_tab !== false,
          activate: true,
          message: typeof args.message === 'string' ? args.message : '',
        });

        let petCompanion = await getPetCompanionStatus(petPaths, petState);
        if (petState.enabled || args.enable_pet === false) {
          const syncRes = await syncPetCompanion(petPaths, petState, 'sync').catch(() => null);
          if (syncRes?.status) petCompanion = syncRes.status;
        }

        const customEntry = petState.customPets.find((p) => p.id === targetId);
        let previewFiles = null;
        if (customEntry) {
          previewFiles = await exportPetPreviewFiles(petStore, customEntry, {
            outputHtmlPath: typeof args.output_html_path === 'string' ? args.output_html_path : '',
            initialTrack: track,
            writeContactSheet: true,
          });
        }

        return {
          ok: true,
          petId: targetId,
          track,
          enabled: petState.enabled,
          sidecarLink: SIDECAR_LINK,
          petCompanion,
          ...(previewFiles ? { preview: previewFiles } : {}),
        };
      },
    },

    {
      definition: {
        name: 'pet_update_settings',
        description:
          'Update live AGY Desktop Pet settings (turn on/off, switch active pet, change displayMode auto/desktop/panel, size 60-500, opacity 40-100, alwaysOnTop, showSpeechBubble, autoWander, selectable/click-through, or reset_position) and sync the Windows floating pet immediately.',
        inputSchema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            active_pet_id: { type: 'string' },
            display_mode: { type: 'string', enum: ['auto', 'desktop', 'panel'] },
            size: { type: 'integer', minimum: 60, maximum: 500 },
            opacity: { type: 'integer', minimum: 40, maximum: 100 },
            always_on_top: { type: 'boolean' },
            show_speech_bubble: { type: 'boolean' },
            bubble_template: {
              type: 'string',
              description:
                'Custom popup bubble template supporting placeholders: {in}, {out}, {tps}, {pct}, {model}, {cache}, {unread}, {quota5h}, {quota7d}, and session progress list syntax [{schedule:<id>},{content:<id>}](active,unread). Example: "5h {quota5h}% · 周 {quota7d}%" or "[{schedule},{content}](active,unread)".',
            },
            auto_wander: { type: 'boolean' },
            selectable: {
              type: 'boolean',
              description: 'true = selectable & interactive; false = non-selectable click-through mode.',
            },
            reset_position: { type: 'boolean' },
          },
        },
      },
      async handler(args) {
        const patch = {};
        if (typeof args.enabled === 'boolean') patch.enabled = args.enabled;
        if (typeof args.active_pet_id === 'string' && args.active_pet_id.trim()) {
          patch.activePetId = args.active_pet_id.trim();
        }
        if (args.display_mode === 'auto' || args.display_mode === 'desktop' || args.display_mode === 'panel') {
          patch.displayMode = args.display_mode;
        }
        if (typeof args.size === 'number') patch.size = args.size;
        if (typeof args.opacity === 'number') patch.opacity = args.opacity;
        if (typeof args.always_on_top === 'boolean') patch.alwaysOnTop = args.always_on_top;
        if (typeof args.show_speech_bubble === 'boolean') patch.showSpeechBubble = args.show_speech_bubble;
        if (typeof args.bubble_template === 'string' && args.bubble_template.trim()) {
          patch.bubbleTemplate = args.bubble_template.trim();
        }
        if (typeof args.auto_wander === 'boolean') patch.autoWander = args.auto_wander;
        if (typeof args.selectable === 'boolean') patch.selectable = args.selectable;
        if (args.reset_position === true) {
          patch.posX = null;
          patch.posY = null;
        }
        const petState = await petStore.savePetConfig(patch);
        const syncRes = await syncPetCompanion(petPaths, petState, 'sync').catch(() => null);
        const petCompanion = syncRes?.status || (await getPetCompanionStatus(petPaths, petState));
        return {
          ok: true,
          sidecarLink: SIDECAR_LINK,
          enabled: petState.enabled,
          activePetId: petState.activePetId,
          displayMode: petState.displayMode,
          size: petState.size,
          opacity: petState.opacity,
          bubbleTemplate: petState.bubbleTemplate,
          autoWander: petState.autoWander,
          selectable: petState.selectable,
          petCompanion,
        };
      },
    },

    {
      definition: {
        name: 'pet_delete',
        description: 'Delete a custom Desktop Pet (and clean up all its frame image files). Built-in pets cannot be deleted.',
        inputSchema: {
          type: 'object',
          required: ['pet_id'],
          properties: {
            pet_id: {
              type: 'string',
              description: 'ID of the custom pet to delete.',
            },
          },
        },
      },
      async handler(args) {
        const res = await petStore.deleteCustomPetFile(args.pet_id);
        const syncRes = await syncPetCompanion(petPaths, res.petState, 'sync').catch(() => null);
        return {
          ok: true,
          deletedId: res.id,
          activePetId: res.petState.activePetId,
          remainingCustomPets: res.petState.customPets.map(summarizePetEntry),
          petCompanion: syncRes?.status || (await getPetCompanionStatus(petPaths, res.petState)),
        };
      },
    },
  ];
}

export default createMcpTools;
