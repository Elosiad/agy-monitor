import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import { createMonitorHandlers } from '../sidecars/agy_monitor/main.mjs';
import { buildFrontendBundle } from '../sidecars/agy_monitor/backend/bundle_builder.mjs';
import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import { createPetStorage, resolvePetPaths } from '../sidecars/agy_monitor/extensions/desktop_pet/pet_storage.mjs';
import { getPetCompanionStatus } from '../sidecars/agy_monitor/extensions/desktop_pet/pet_companion.mjs';
import {
  buildContactSheetPng,
  decodePng,
  encodePng,
  sliceSpriteSheetBuffer,
} from '../sidecars/agy_monitor/extensions/desktop_pet/sprite_processor.mjs';
import {
  createMcpDispatcher,
  loadExtensionMcpTools,
} from '../sidecars/agy_monitor/extensions/mcp_bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'sidecars', 'agy_monitor', 'frontend');
const PET_CS = path.join(ROOT, 'sidecars', 'agy_monitor', 'extensions', 'desktop_pet', 'AgyDesktopPet.cs');
const MCP_BRIDGE_PATH = path.join(ROOT, 'sidecars', 'agy_monitor', 'extensions', 'mcp_bridge.mjs');

const VALID_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU9sAAAAASUVORK5CYII=';
const VALID_GIF_BASE64 =
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function makeTempPaths(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pet-ext-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return resolvePaths({
    appDataDir: path.join(dir, 'appData'),
    geminiConfigDir: path.join(dir, 'config'),
    pluginDataDir: path.join(dir, 'pluginData'),
    sidecarDataDir: path.join(dir, 'sidecarData'),
  });
}

test('pluggable isolation: AGY_DISABLE_EXTENSIONS=1 removes pet routes & frontend extension cleanly without breaking core', async (t) => {
  const prev = process.env.AGY_DISABLE_EXTENSIONS;
  process.env.AGY_DISABLE_EXTENSIONS = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.AGY_DISABLE_EXTENSIONS;
    else process.env.AGY_DISABLE_EXTENSIONS = prev;
  });

  const paths = makeTempPaths(t);
  const store = createStorage(paths);
  const routes = createMonitorHandlers({ paths, storage: store });
  assert.equal(routes.has('GET /api/pet'), false);
  assert.equal(routes.has('POST /api/pet/save'), false);
  assert.equal(routes.has('POST /api/pet/frames/save'), false);

  const bundle = await buildFrontendBundle(FRONTEND_DIR);
  assert.equal(bundle.includes('mountDesktopPetExtension'), false);
  new vm.Script(bundle, { filename: 'bundle-core-only.js' });
});

test('desktop_pet extension storage: defaults off, persists settings, validates PNG/GIF, blocks SVG, and handles UTF-8 BOM', async (t) => {
  const paths = makeTempPaths(t);
  const petPaths = resolvePetPaths(paths);
  const petStore = createPetStorage(petPaths);

  const initial = await petStore.getPetConfig();
  assert.equal(initial.enabled, false);
  assert.equal(initial.activePetId, 'neko');
  assert.equal(initial.displayMode, 'auto');
  assert.equal(initial.builtinPets.length, 3);
  assert.ok(fs.existsSync(petPaths.petConfigFile));

  // BOM compatibility
  fs.writeFileSync(
    petPaths.petConfigFile,
    '\uFEFF' + JSON.stringify({ version: 1, enabled: true, activePetId: 'mecha', displayMode: 'panel', size: 120 }),
    'utf8',
  );
  const loadedBom = await petStore.getPetConfig();
  assert.equal(loadedBom.enabled, true);
  assert.equal(loadedBom.activePetId, 'mecha');
  assert.equal(loadedBom.size, 120);

  fs.writeFileSync(
    petPaths.petStatusFile,
    '\uFEFF' + JSON.stringify({ pid: process.pid, running: true, supportsPet: true, petEnabled: true, petVisible: true, updatedAtMs: Date.now() }),
    'utf8',
  );
  const st = await getPetCompanionStatus(petPaths, loadedBom);
  assert.equal(st.running, true);
  assert.equal(st.petVisible, true);

  // Reject SVG upload
  await assert.rejects(
    () =>
      petStore.saveCustomPetFile({
        name: 'evil',
        mime: 'image/svg+xml',
        base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64'),
      }),
    (err) => err?.code === 'UNSUPPORTED_MEDIA_TYPE',
  );

  const uploaded = await petStore.saveCustomPetFile({
    name: '舞动小猫',
    mime: 'image/gif',
    base64: VALID_GIF_BASE64,
  });
  assert.equal(uploaded.pet.mime, 'image/gif');
  assert.equal(uploaded.petState.activePetId, uploaded.pet.id);

  const deleted = await petStore.deleteCustomPetFile(uploaded.pet.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.petState.activePetId, 'neko');
});

test('desktop_pet extension HTTP routes: single upload, multi-track frame animation CRUD, edit reuse & orphan cleanup', async (t) => {
  const prevSkip = process.env.AGY_MONITOR_SKIP_DESKTOP_PROBE;
  process.env.AGY_MONITOR_SKIP_DESKTOP_PROBE = '1';
  t.after(() => {
    if (prevSkip === undefined) delete process.env.AGY_MONITOR_SKIP_DESKTOP_PROBE;
    else process.env.AGY_MONITOR_SKIP_DESKTOP_PROBE = prevSkip;
  });

  const paths = makeTempPaths(t);
  const petPaths = resolvePetPaths(paths);
  const store = createStorage(paths);
  const routes = createMonitorHandlers({ paths, storage: store });

  assert.equal(routes.has('GET /api/pet'), true);
  assert.equal(routes.has('GET /extensions/desktop_pet/desktop_pet.css'), true);

  const cssRes = await routes.get('GET /extensions/desktop_pet/desktop_pet.css')({});
  assert.equal(cssRes.status, 200);
  assert.equal(cssRes.contentType, 'text/css; charset=utf-8');

  const saveRes = await routes.get('POST /api/pet/save')({
    petState: { enabled: true, activePetId: 'ghost', displayMode: 'panel', size: 115 },
  });
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.petState.enabled, true);
  assert.equal(saveRes.petState.activePetId, 'ghost');

  // Block SVG in frame animation save
  const badRes = await routes.get('POST /api/pet/frames/save')({
    name: 'bad-frames',
    fps: 10,
    frames: [{ mime: 'image/svg+xml', base64: Buffer.from('<svg></svg>').toString('base64') }],
  });
  assert.equal(badRes.status, 415);

  // Create multi-track frame animation
  const created = await routes.get('POST /api/pet/frames/save')({
    name: '像素小猫',
    fps: 12,
    frames: [
      { mime: 'image/png', base64: VALID_PNG_BASE64 },
      { mime: 'image/gif', base64: VALID_GIF_BASE64 },
    ],
    stateFrames: {
      running: [{ mime: 'image/png', base64: VALID_PNG_BASE64 }],
      interact: [{ mime: 'image/gif', base64: VALID_GIF_BASE64 }],
    },
  });
  assert.equal(created.ok, true);
  assert.equal(created.pet.kind, 'frames');
  assert.equal(created.pet.fps, 12);
  assert.equal(created.pet.frames.length, 2);

  const frame0 = created.pet.frames[0].filename;
  const frame1 = created.pet.frames[1].filename;
  const asset0 = await routes.get('GET /api/ext/pet/asset')({ id: created.pet.id, file: frame0 });
  assert.equal(asset0.status, 200);
  assert.equal(asset0.contentType, 'image/png');

  const badAsset = await routes.get('GET /api/ext/pet/asset')({ id: created.pet.id, file: 'missing.png' });
  assert.equal(badAsset.status, 404);

  // Edit existing frame animation: reuse frame0, drop frame1 -> frame1 file deleted
  const edited = await routes.get('POST /api/pet/frames/save')({
    id: created.pet.id,
    name: '像素小猫 v2',
    fps: 6,
    frames: [{ existingFilename: frame0 }],
    stateFrames: {},
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.pet.name, '像素小猫 v2');
  assert.equal(edited.pet.fps, 6);
  assert.equal(fs.existsSync(path.join(petPaths.customPetsDir, frame0)), true);
  assert.equal(fs.existsSync(path.join(petPaths.customPetsDir, frame1)), false);

  const deleted = await routes.get('POST /api/pet/delete')({ petId: created.pet.id });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.petState.activePetId, 'neko');
  assert.equal(fs.existsSync(path.join(petPaths.customPetsDir, frame0)), false);
});

test('desktop_pet standalone C# companion & bundled frontend script integrity', async () => {
  const src = fs.readFileSync(PET_CS, 'utf8');
  assert.match(src, /class\s+DesktopPetWindow\s*:\s*Window/);
  assert.match(src, /new\s+UTF8Encoding\(false\)/, 'AgyDesktopPet.cs must write UTF-8 without BOM');
  assert.match(src, /GifBitmapDecoder/, 'AgyDesktopPet.cs must support animated GIF');
  assert.match(src, /LoadCustomFramesIfNeeded/, 'AgyDesktopPet.cs must support multi-track frame animations');

  const bundle = await buildFrontendBundle(FRONTEND_DIR);
  assert.equal(bundle.includes('mountDesktopPetExtension'), true);
  assert.equal(/\b(import|export)\s+(?:function|const|\{)/.test(bundle), false);
  new vm.Script(bundle, { filename: 'bundle-with-ext.js' });
});

function makeSyntheticSpriteSheetPng(cols = 4, cellW = 32, cellH = 32) {
  const width = cols * cellW;
  const height = cellH;
  const rgba = new Uint8Array(width * height * 4);
  // Fill pure magenta background (#FF00FF)
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 0;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = 255;
  }
  // Draw distinct colored foreground square in each cell
  for (let c = 0; c < cols; c += 1) {
    const xStart = c * cellW + 8;
    const yStart = 8 + (c % 2) * 2;
    for (let y = yStart; y < yStart + 16; y += 1) {
      for (let x = xStart; x < xStart + 16; x += 1) {
        const o = (y * width + x) * 4;
        rgba[o] = 30 + c * 40;
        rgba[o + 1] = 160;
        rgba[o + 2] = 240;
        rgba[o + 3] = 255;
      }
    }
  }
  return encodePng(width, height, rgba);
}

test('sprite_processor slices 4x1 sprite sheet, removes solid background, aligns frames, and builds contact sheet', async () => {
  const sheetPng = makeSyntheticSpriteSheetPng(4, 32, 32);
  const sliced = await sliceSpriteSheetBuffer(sheetPng, {
    cols: 4,
    rows: 1,
    removeBackground: 'auto',
    trimAndAlign: true,
    maxSize: 64,
  });
  assert.equal(sliced.frames.length, 4);
  for (const fr of sliced.frames) {
    assert.equal(fr.width, 64);
    assert.equal(fr.height, 64);
    const dec = decodePng(fr.pngBuffer);
    assert.equal(dec.width, 64);
    assert.equal(dec.height, 64);
    // Top-left corner must be transparent after background removal
    assert.equal(dec.data[3], 0, 'corner background pixel must become transparent');
    // Center pixel must remain opaque foreground
    const centerOff = (32 * 64 + 32) * 4;
    assert.equal(dec.data[centerOff + 3], 255, 'foreground character center must stay opaque');
  }
  const contactPng = buildContactSheetPng(sliced.frames, { thumbSize: 64, columns: 4 });
  assert.ok(Buffer.isBuffer(contactPng));
  const decSheet = decodePng(contactPng);
  assert.ok(decSheet.width > 256 && decSheet.height > 64);
});

test('MCP bridge & desktop_pet MCP tools: slice, create animation, preview HTML, update settings, security & stdio roundtrip', async (t) => {
  const paths = makeTempPaths(t);
  const workDir = path.join(paths.pluginDataDir, 'ai_gen');
  fs.mkdirSync(workDir, { recursive: true });

  const sheetPath = path.join(workDir, 'shiba_idle_sheet.png');
  fs.writeFileSync(sheetPath, makeSyntheticSpriteSheetPng(4, 32, 32));
  const runFramePath = path.join(workDir, 'shiba_run_1.png');
  fs.writeFileSync(runFramePath, makeSyntheticSpriteSheetPng(1, 32, 32));
  const svgPath = path.join(workDir, 'evil.svg');
  fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  // 1. AGY_DISABLE_EXTENSIONS=1 exposes 0 MCP tools cleanly
  process.env.AGY_DISABLE_EXTENSIONS = '1';
  const disabledTools = await loadExtensionMcpTools({ corePaths: paths });
  delete process.env.AGY_DISABLE_EXTENSIONS;
  assert.equal(disabledTools.length, 0);

  // 2. Load tools & test MCP dispatcher
  const tools = await loadExtensionMcpTools({ corePaths: paths });
  const dispatch = createMcpDispatcher(tools);
  const initResp = await dispatch({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26' },
  });
  assert.equal(initResp.result.protocolVersion, '2025-03-26');

  const listResp = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const toolNames = listResp.result.tools.map((x) => x.name);
  assert.ok(toolNames.includes('pet_get_state'));
  assert.ok(toolNames.includes('pet_slice_sprite_sheet'));
  assert.ok(toolNames.includes('pet_create_frame_animation'));
  assert.ok(toolNames.includes('pet_preview_animation'));
  assert.ok(toolNames.includes('pet_update_settings'));
  assert.ok(toolNames.includes('pet_delete'));

  const callTool = async (name, args = {}) => {
    const resp = await dispatch({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return {
      isError: Boolean(resp.result?.isError),
      data: JSON.parse(resp.result.content[0].text),
    };
  };

  // 3. Slice sprite sheet tool
  const sliceRes = await callTool('pet_slice_sprite_sheet', {
    image_path: sheetPath,
    cols: 4,
    rows: 1,
    remove_background: 'auto',
    max_size: 64,
  });
  assert.equal(sliceRes.isError, false);
  assert.equal(sliceRes.data.ok, true);
  assert.equal(sliceRes.data.frameCount, 4);
  assert.equal(fs.existsSync(sliceRes.data.contactSheetPath), true);
  assert.equal(fs.existsSync(sliceRes.data.framePaths[0]), true);

  // 4. Create multi-track frame animation directly via sprite_sheets + running_frames
  const createRes = await callTool('pet_create_frame_animation', {
    name: '赛博小柴犬',
    fps: 10,
    sprite_sheets: {
      idle: { path: sheetPath, cols: 4, rows: 1, remove_background: 'auto', max_size: 64 },
    },
    running_frames: [runFramePath],
    remove_background: 'auto',
    trim_and_align: true,
    max_size: 64,
    preview_now: true,
    preview_track: 'idle',
  });
  assert.equal(createRes.isError, false);
  assert.equal(createRes.data.ok, true);
  assert.equal(createRes.data.pet.name, '赛博小柴犬');
  assert.equal(createRes.data.pet.tracks.idle, 4);
  assert.equal(createRes.data.pet.tracks.running, 1);
  assert.equal(createRes.data.preview.livePreviewTriggered, true);
  assert.equal(fs.existsSync(createRes.data.preview.htmlPath), true);
  assert.equal(fs.existsSync(createRes.data.preview.contactSheetPath), true);
  assert.match(createRes.data.preview.sidecarLink, /sidecar:\/\/agy-monitor\/agy_monitor\//);

  const htmlText = fs.readFileSync(createRes.data.preview.htmlPath, 'utf8');
  assert.match(htmlText, /赛博小柴犬/);
  assert.match(htmlText, /data:image\/png;base64,/);

  // 5. Preview animation tool + HTTP preview-html route
  const previewRes = await callTool('pet_preview_animation', {
    pet_id: createRes.data.pet.id,
    track: 'running',
    message: '正在努力写代码！',
  });
  assert.equal(previewRes.isError, false);
  assert.equal(previewRes.data.track, 'running');

  const storage = createStorage(paths);
  const routes = createMonitorHandlers({ paths, storage });
  const previewHtmlResp = await routes.get('GET /api/pet/preview-html')({ id: createRes.data.pet.id, track: 'running' });
  assert.equal(previewHtmlResp.status, 200);
  assert.match(String(previewHtmlResp.body), /赛博小柴犬/);

  // 6. Security: SVG & UNC path rejected
  const svgErr = await callTool('pet_slice_sprite_sheet', { image_path: svgPath });
  assert.equal(svgErr.isError, true);
  const uncErr = await callTool('pet_slice_sprite_sheet', { image_path: '\\\\127.0.0.1\\share\\pet.png' });
  assert.equal(uncErr.isError, true);

  // 7. Delete custom pet cleanly
  const delRes = await callTool('pet_delete', { pet_id: createRes.data.pet.id });
  assert.equal(delRes.isError, false);
  assert.equal(delRes.data.activePetId, 'neko');

  // 8. Real stdio subprocess roundtrip (matching Antigravity MCP launcher)
  const stdioOut = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [MCP_BRIDGE_PATH], { timeout: 8000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) +
        '\n' +
        JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list' }) +
        '\n',
    );
    child.stdin.end();
  });
  const lines = stdioOut
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, 10);
  assert.equal(lines[1].id, 11);
  assert.ok(lines[1].result.tools.some((x) => x.name === 'pet_create_frame_animation'));
});
