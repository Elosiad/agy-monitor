/**
 * Generates self-contained interactive HTML preview players and contact-sheet PNGs
 * for custom Desktop Pet frame animations so users (and Gemini) can preview results anywhere.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildContactSheetPng, decodeRasterToRgba } from './sprite_processor.mjs';

const TRACK_META = [
  { key: 'idle', label: '待机 (Idle)' },
  { key: 'running', label: '思考中 (Running)' },
  { key: 'unread', label: '任务完成 (Unread)' },
  { key: 'interact', label: '互动摸头 (Interact)' },
  { key: 'walk', label: '自主移动 (Walk)' },
  { key: 'drag', label: '拖拽中 (Drag)' },
];

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Load all tracks of a custom pet entry into base64 data URLs + optional RGBA frames for contact sheet.
 */
export async function loadPetTracksMedia(petStore, entry, { decodeForContactSheet = false } = {}) {
  const tracks = { idle: [], running: [], unread: [], interact: [], walk: [], drag: [] };
  const decodedAll = [];

  const readTrack = async (trackKey, list) => {
    for (const fr of list || []) {
      if (!fr?.filename) continue;
      const asset = await petStore.readSafePetAsset(fr.filename);
      if (!asset?.buf) continue;
      const mime = asset.mime || fr.mime || 'image/png';
      tracks[trackKey].push({
        filename: fr.filename,
        mime,
        dataUrl: `data:${mime};base64,${asset.buf.toString('base64')}`,
      });
      if (decodeForContactSheet) {
        try {
          const dec = await decodeRasterToRgba(asset.buf);
          decodedAll.push({ width: dec.width, height: dec.height, rgba: dec.data, track: trackKey });
        } catch {
          // Skip non-decodable frames for contact sheet
        }
      }
    }
  };

  if (entry.kind === 'frames') {
    await readTrack('idle', entry.frames || []);
    await readTrack('running', entry.stateFrames?.running || []);
    await readTrack('unread', entry.stateFrames?.unread || []);
    await readTrack('interact', entry.stateFrames?.interact || []);
    await readTrack('walk', entry.stateFrames?.walk || []);
    await readTrack('drag', entry.stateFrames?.drag || []);
  } else if (entry.filename) {
    await readTrack('idle', [{ filename: entry.filename, mime: entry.mime || 'image/png' }]);
  }

  return { tracks, decodedAll };
}

/**
 * Build a self-contained offline interactive HTML animation preview document.
 */
export function buildInteractivePreviewHtml(entry, tracks, { initialTrack = 'idle' } = {}) {
  const safeName = escapeHtml(entry?.name || entry?.id || 'Desktop Pet');
  const initialFps = Math.max(1, Math.min(30, Number(entry?.fps) || 8));
  const payload = {
    id: entry?.id || '',
    name: entry?.name || entry?.id || 'Desktop Pet',
    fps: initialFps,
    initialTrack: tracks[initialTrack]?.length ? initialTrack : 'idle',
    tracks,
    trackMeta: TRACK_META,
  };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeName} · 桌宠帧动画实时预览</title>
<style>
  :root {
    --bg: #0f131c;
    --panel: #171c28;
    --border: rgba(255,255,255,0.1);
    --text: #eef2ff;
    --muted: #94a3b8;
    --accent: #7c6cff;
    --accent-soft: rgba(124,108,255,0.18);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: radial-gradient(circle at top, #1b2234, var(--bg) 62%);
    color: var(--text);
    font-family: "Segoe UI", "PingFang SC", system-ui, -apple-system, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    width: min(680px, 100%);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 18px;
    box-shadow: 0 22px 54px rgba(0,0,0,0.45);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .title { font-size: 16px; font-weight: 700; margin: 0; }
  .meta { font-size: 12px; color: var(--muted); }
  .tracks {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .btn {
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.04);
    color: var(--text);
    border-radius: 999px;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
    transition: all 140ms ease;
  }
  .btn:hover { background: rgba(255,255,255,0.09); }
  .btn.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .stage {
    position: relative;
    height: 240px;
    border-radius: 14px;
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    user-select: none;
  }
  .stage.bg-checker {
    background-image:
      linear-gradient(45deg, #252b3b 25%, transparent 25%),
      linear-gradient(-45deg, #252b3b 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #252b3b 75%),
      linear-gradient(-45deg, transparent 75%, #252b3b 75%);
    background-size: 20px 20px;
    background-position: 0 0, 0 10px, 10px -10px, -10px 0;
    background-color: #1b202d;
  }
  .stage.bg-dark { background: #0d1017; }
  .stage.bg-light { background: #f3f5fa; }
  .stage img {
    max-width: 196px;
    max-height: 196px;
    object-fit: contain;
    image-rendering: auto;
    transition: transform 140ms ease;
    filter: drop-shadow(0 8px 18px rgba(0,0,0,0.32));
  }
  .badge {
    position: absolute;
    left: 12px;
    bottom: 10px;
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 999px;
    background: rgba(15,19,28,0.78);
    color: #e2e8f0;
    border: 1px solid rgba(255,255,255,0.12);
  }
  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .sliders {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--muted);
  }
  .sliders label { display: inline-flex; align-items: center; gap: 6px; }
  .strip {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 6px 2px;
  }
  .thumb {
    flex: 0 0 auto;
    width: 64px;
    height: 64px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: #1d2332;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    cursor: pointer;
    padding: 4px;
  }
  .thumb.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .thumb span {
    position: absolute;
    right: 4px;
    bottom: 2px;
    font-size: 10px;
    color: #cbd5e1;
    background: rgba(0,0,0,0.55);
    border-radius: 4px;
    padding: 0 4px;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <div>
        <h1 class="title" id="petTitle"></h1>
        <div class="meta" id="petMeta"></div>
      </div>
      <div class="tracks" id="bgSwitch">
        <button class="btn active" data-bg="bg-checker" type="button">透明棋盘</button>
        <button class="btn" data-bg="bg-dark" type="button">深色背景</button>
        <button class="btn" data-bg="bg-light" type="button">浅色背景</button>
      </div>
    </div>

    <div class="tracks" id="trackBar"></div>

    <div class="stage bg-checker" id="stage">
      <img id="stageImg" alt="preview" />
      <div class="badge" id="frameBadge"></div>
    </div>

    <div class="controls">
      <div class="tracks">
        <button class="btn active" id="playBtn" type="button">暂停</button>
        <button class="btn" id="prevBtn" type="button">上一帧</button>
        <button class="btn" id="nextBtn" type="button">下一帧</button>
      </div>
      <div class="sliders">
        <label>帧率 <input id="fpsRange" type="range" min="1" max="30" /> <strong id="fpsVal"></strong></label>
        <label>缩放 <input id="scaleRange" type="range" min="60" max="500" value="100" /> <strong id="scaleVal">100%</strong></label>
      </div>
    </div>

    <div class="strip" id="strip"></div>
  </div>

<script>
(function () {
  var DATA = ${safeJsonForScript(payload)};
  var trackKey = DATA.initialTrack || "idle";
  var fps = DATA.fps || 8;
  var playing = true;
  var frameIdx = 0;
  var timer = null;

  var titleEl = document.getElementById("petTitle");
  var metaEl = document.getElementById("petMeta");
  var trackBar = document.getElementById("trackBar");
  var stage = document.getElementById("stage");
  var stageImg = document.getElementById("stageImg");
  var frameBadge = document.getElementById("frameBadge");
  var playBtn = document.getElementById("playBtn");
  var prevBtn = document.getElementById("prevBtn");
  var nextBtn = document.getElementById("nextBtn");
  var fpsRange = document.getElementById("fpsRange");
  var fpsVal = document.getElementById("fpsVal");
  var scaleRange = document.getElementById("scaleRange");
  var scaleVal = document.getElementById("scaleVal");
  var strip = document.getElementById("strip");

  titleEl.textContent = DATA.name;
  fpsRange.value = String(fps);
  fpsVal.textContent = fps + " FPS";

  function getList(k) {
    var list = DATA.tracks[k];
    if (Array.isArray(list) && list.length > 0) return list;
    return DATA.tracks.idle || [];
  }

  function renderFrame() {
    var list = getList(trackKey);
    if (!list.length) return;
    frameIdx = ((frameIdx % list.length) + list.length) % list.length;
    stageImg.src = list[frameIdx].dataUrl;
    frameBadge.textContent = trackKey.toUpperCase() + " · #" + (frameIdx + 1) + " / " + list.length + " · " + fps + " FPS";
    var thumbs = strip.querySelectorAll(".thumb");
    for (var i = 0; i < thumbs.length; i += 1) {
      thumbs[i].classList.toggle("active", i === frameIdx);
    }
  }

  function renderStrip() {
    strip.textContent = "";
    var list = getList(trackKey);
    for (var i = 0; i < list.length; i += 1) {
      (function (idx) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "thumb" + (idx === frameIdx ? " active" : "");
        var im = document.createElement("img");
        im.src = list[idx].dataUrl;
        im.alt = "Frame " + (idx + 1);
        var sp = document.createElement("span");
        sp.textContent = String(idx + 1);
        btn.appendChild(im);
        btn.appendChild(sp);
        btn.addEventListener("click", function () {
          frameIdx = idx;
          renderFrame();
        });
        strip.appendChild(btn);
      })(i);
    }
  }

  function renderTrackBar() {
    trackBar.textContent = "";
    var total = 0;
    for (var i = 0; i < DATA.trackMeta.length; i += 1) {
      var m = DATA.trackMeta[i];
      var cnt = (DATA.tracks[m.key] || []).length;
      total += cnt;
      (function (meta, count) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "btn" + (trackKey === meta.key ? " active" : "");
        b.disabled = count === 0;
        b.textContent = meta.label + " (" + count + ")";
        b.addEventListener("click", function () {
          trackKey = meta.key;
          frameIdx = 0;
          renderTrackBar();
          renderStrip();
          renderFrame();
        });
        trackBar.appendChild(b);
      })(m, cnt);
    }
    metaEl.textContent = "ID: " + DATA.id + " · 共 " + total + " 帧 · AGY Desktop Pet Studio";
  }

  function restartTimer() {
    if (timer) clearInterval(timer);
    timer = null;
    if (!playing) return;
    timer = setInterval(function () {
      var list = getList(trackKey);
      if (list.length <= 1) return;
      frameIdx = (frameIdx + 1) % list.length;
      renderFrame();
    }, Math.max(33, Math.round(1000 / Math.max(1, fps))));
  }

  playBtn.addEventListener("click", function () {
    playing = !playing;
    playBtn.textContent = playing ? "暂停" : "播放";
    playBtn.classList.toggle("active", playing);
    restartTimer();
  });
  prevBtn.addEventListener("click", function () {
    playing = false;
    playBtn.textContent = "播放";
    playBtn.classList.remove("active");
    restartTimer();
    frameIdx -= 1;
    renderFrame();
  });
  nextBtn.addEventListener("click", function () {
    playing = false;
    playBtn.textContent = "播放";
    playBtn.classList.remove("active");
    restartTimer();
    frameIdx += 1;
    renderFrame();
  });
  fpsRange.addEventListener("input", function () {
    fps = Math.max(1, Math.min(30, Number(fpsRange.value) || 8));
    fpsVal.textContent = fps + " FPS";
    renderFrame();
    restartTimer();
  });
  scaleRange.addEventListener("input", function () {
    var sc = Math.max(60, Math.min(500, Number(scaleRange.value) || 100));
    scaleVal.textContent = sc + "%";
    stageImg.style.transform = "scale(" + (sc / 100).toFixed(2) + ")";
  });

  var bgBtns = document.querySelectorAll("#bgSwitch .btn");
  for (var j = 0; j < bgBtns.length; j += 1) {
    bgBtns[j].addEventListener("click", function (ev) {
      var targetBg = ev.currentTarget.getAttribute("data-bg");
      stage.className = "stage " + targetBg;
      for (var k = 0; k < bgBtns.length; k += 1) {
        bgBtns[k].classList.toggle("active", bgBtns[k] === ev.currentTarget);
      }
    });
  }

  renderTrackBar();
  renderStrip();
  renderFrame();
  restartTimer();
})();
</script>
</body>
</html>`;
}

/**
 * Write both an interactive HTML preview and a checkerboard contact-sheet PNG to disk.
 */
export async function exportPetPreviewFiles(
  petStore,
  entry,
  {
    outputDir,
    outputHtmlPath = '',
    initialTrack = 'idle',
    writeContactSheet = true,
  } = {},
) {
  const safeId = String(entry?.id || 'pet').replace(/[^a-zA-Z0-9_-]/g, '_');
  const previewDir = outputDir
    ? path.resolve(outputDir)
    : path.join(petStore.paths.pluginDataDir, 'pet_previews');
  await fs.mkdir(previewDir, { recursive: true });

  const { tracks, decodedAll } = await loadPetTracksMedia(petStore, entry, {
    decodeForContactSheet: writeContactSheet,
  });
  const html = buildInteractivePreviewHtml(entry, tracks, { initialTrack });
  const htmlPath = outputHtmlPath
    ? path.resolve(outputHtmlPath)
    : path.join(previewDir, `preview_${safeId}.html`);
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(htmlPath, html, 'utf8');

  let contactSheetPath = '';
  if (writeContactSheet && decodedAll.length > 0) {
    const pngBuf = buildContactSheetPng(decodedAll, { thumbSize: 128, columns: 6, padding: 8 });
    if (pngBuf) {
      contactSheetPath = path.join(previewDir, `contact_sheet_${safeId}.png`);
      await fs.writeFile(contactSheetPath, pngBuf);
    }
  }

  return {
    htmlPath,
    contactSheetPath,
    frameCounts: {
      idle: tracks.idle.length,
      running: tracks.running.length,
      unread: tracks.unread.length,
      interact: tracks.interact.length,
      walk: tracks.walk.length,
      drag: tracks.drag.length,
    },
  };
}
