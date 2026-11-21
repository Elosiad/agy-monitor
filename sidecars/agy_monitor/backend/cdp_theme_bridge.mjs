import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteBuffer, atomicWriteJson, atomicWriteText } from './paths.mjs';
import {
  createWslCdpLocalProxy,
  detectWindowsHostEnv,
  resolveWindowsHostDirs,
  resolveWslGatewayIp,
  toWindowsPath,
} from './wsl_bridge.mjs';

const execFileAsync = promisify(execFile);

const STYLE_ELEMENT_ID = 'agy-monitor-cdp-theme';
const HUD_ELEMENT_ID = 'agy-monitor-cdp-hud';
const HUD_POPOVER_ID = 'agy-monitor-cdp-hud-popover';
const HUD_GUIDE_ID = 'agy-monitor-cdp-hud-guide';
const HUD_STYLE_ID = 'agy-monitor-cdp-hud-style';
const DEFAULT_CDP_PORT = 9229;

function normalizeHudDisplayConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    showSpeed: src.showSpeed !== false,
    showCacheHit: src.showCacheHit !== false,
    showModel: src.showModel !== false,
    showContext: src.showContext !== false,
    updatedAtMs: Number.isFinite(Number(src.updatedAtMs)) ? Number(src.updatedAtMs) : 0,
  };
}

const EXT_TO_MIME = new Map([
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
]);

const launcherSignatureCache = new Map();

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parseHexRgb(hex, fallback = [7, 7, 9]) {
  if (typeof hex !== 'string') return fallback;
  const s = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return fallback;
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

function escapeVbsString(str) {
  return String(str || '').replace(/"/g, '""');
}

let cachedResolvedExeWin = '';
let cachedLauncherSnapshot = null;

/**
 * Locate Antigravity's desktop executable on Windows (or via WSL2 mount).
 */
export function findAntigravityExePath() {
  const hostInfo = detectWindowsHostEnv();
  if (!hostInfo.hasWindowsHost) return '';
  if (hostInfo.isWsl) {
    return cachedResolvedExeWin || '';
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    path.join(localAppData, 'Programs', 'antigravity', 'Antigravity.exe'),
    path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
    path.join(programFiles, 'Antigravity', 'Antigravity.exe'),
  ];
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand)) return cand;
    } catch {
      // ignore probe error
    }
  }
  return candidates[0];
}

async function resolveAntigravityExePathAsync(hostInfo = detectWindowsHostEnv()) {
  if (!hostInfo.hasWindowsHost) return { exeWin: '', exeFound: false };
  if (hostInfo.isNativeWindows) {
    const exeWin = findAntigravityExePath();
    return { exeWin, exeFound: Boolean(exeWin && fs.existsSync(exeWin)) };
  }
  const dirs = await resolveWindowsHostDirs(hostInfo);
  const candidates = [];
  if (dirs.localAppDataWin && dirs.localAppDataPosix) {
    candidates.push(
      {
        win: `${dirs.localAppDataWin}\\Programs\\antigravity\\Antigravity.exe`,
        posix: `${dirs.localAppDataPosix}/Programs/antigravity/Antigravity.exe`,
      },
      {
        win: `${dirs.localAppDataWin}\\Programs\\Antigravity\\Antigravity.exe`,
        posix: `${dirs.localAppDataPosix}/Programs/Antigravity/Antigravity.exe`,
      },
    );
  }
  if (dirs.programFilesWin && dirs.programFilesPosix) {
    candidates.push({
      win: `${dirs.programFilesWin}\\Antigravity\\Antigravity.exe`,
      posix: `${dirs.programFilesPosix}/Antigravity/Antigravity.exe`,
    });
  }
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand.posix)) {
        cachedResolvedExeWin = cand.win;
        return { exeWin: cand.win, exeFound: true };
      }
    } catch {
      // ignore
    }
  }
  const fallback = candidates[0]?.win || '';
  cachedResolvedExeWin = fallback;
  return { exeWin: fallback, exeFound: false };
}

async function createWindowsShortcutLnk({
  lnkPosix,
  lnkWin,
  targetPath,
  args,
  workingDir,
  description,
  hostInfo = detectWindowsHostEnv(),
}) {
  if (!hostInfo.hasWindowsHost || !lnkPosix || !lnkWin || !targetPath) return false;
  const helperVbsPosix = `${lnkPosix}.mk.vbs`;
  const helperVbsWin = `${lnkWin}.mk.vbs`;
  const script = [
    'Set sh = CreateObject("WScript.Shell")',
    `Set sc = sh.CreateShortcut("${escapeVbsString(lnkWin)}")`,
    `sc.TargetPath = "${escapeVbsString(targetPath)}"`,
    `sc.Arguments = "${escapeVbsString(args)}"`,
    `sc.WorkingDirectory = "${escapeVbsString(workingDir)}"`,
    `sc.IconLocation = "${escapeVbsString(targetPath)},0"`,
    `sc.Description = "${escapeVbsString(description)}"`,
    'sc.WindowStyle = 1',
    'sc.Save',
    '',
  ].join('\r\n');

  try {
    await fsp.mkdir(path.dirname(lnkPosix), { recursive: true });
    // WScript reads UTF-16LE BOM cleanly even with Chinese characters in path/description
    const bomBuf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]);
    await fsp.writeFile(helperVbsPosix, bomBuf);
    await execFileAsync(hostInfo.wscriptPath || 'wscript.exe', ['//Nologo', helperVbsWin], {
      windowsHide: true,
      timeout: 6000,
    });
    return fs.existsSync(lnkPosix);
  } catch {
    return false;
  } finally {
    await fsp.rm(helperVbsPosix, { force: true }).catch(() => {});
  }
}

/**
 * Emit zero-console desktop launchers (.lnk native shortcut + silent .vbs + self-closing .cmd)
 * that start Antigravity with --remote-debugging-port without leaving any cmd window open
 * and without touching app.asar or any installation files.
 * Supports both native Windows and Win + WSL2 via Windows NTFS staging dir.
 */
export async function ensureCdpLauncher(paths, cdpPort = DEFAULT_CDP_PORT) {
  const hostInfo = detectWindowsHostEnv();
  const port = clampInt(cdpPort, 1024, 65535, DEFAULT_CDP_PORT);
  const { exeWin, exeFound } = await resolveAntigravityExePathAsync(hostInfo);
  const cdpArg = `--remote-debugging-port=${port}`;

  let launcherVbsPosix = paths?.cdpLauncherVbs || '';
  let launcherVbsWin = launcherVbsPosix;
  let launcherCmdPosix = paths?.cdpLauncherCmd || '';
  let launcherCmdWin = launcherCmdPosix;
  let shortcutLnkPosix = paths?.cdpShortcutLnk || '';
  let shortcutLnkWin = shortcutLnkPosix;

  if (hostInfo.isWsl && hostInfo.hasWindowsHost) {
    const dirs = await resolveWindowsHostDirs(hostInfo);
    if (dirs.stagingDirPosix && dirs.stagingDirWin) {
      launcherVbsPosix = `${dirs.stagingDirPosix}/launch_antigravity_cdp.vbs`;
      launcherVbsWin = `${dirs.stagingDirWin}\\launch_antigravity_cdp.vbs`;
      launcherCmdPosix = `${dirs.stagingDirPosix}/启动_Antigravity_高清壁纸模式_CDP.cmd`;
      launcherCmdWin = `${dirs.stagingDirWin}\\启动_Antigravity_高清壁纸模式_CDP.cmd`;
      shortcutLnkPosix = `${dirs.stagingDirPosix}/Antigravity (高清壁纸).lnk`;
      shortcutLnkWin = `${dirs.stagingDirWin}\\Antigravity (高清壁纸).lnk`;
    } else {
      launcherVbsWin = await toWindowsPath(launcherVbsPosix, hostInfo);
      launcherCmdWin = await toWindowsPath(launcherCmdPosix, hostInfo);
      shortcutLnkWin = await toWindowsPath(shortcutLnkPosix, hostInfo);
    }
  }

  const launchCommand = launcherVbsWin
    ? `wscript.exe //Nologo "${launcherVbsWin}"`
    : exeWin
      ? `"${exeWin}" ${cdpArg}`
      : '';

  const cacheKey = `${exeWin}|${port}|${launcherVbsWin}|${launcherCmdWin}|${shortcutLnkWin}`;
  const allExist =
    !hostInfo.hasWindowsHost ||
    ((!launcherVbsPosix || fs.existsSync(launcherVbsPosix)) &&
      (!launcherCmdPosix || fs.existsSync(launcherCmdPosix)) &&
      (!shortcutLnkPosix || fs.existsSync(shortcutLnkPosix)));

  if (
    hostInfo.hasWindowsHost &&
    exeWin &&
    (!allExist || launcherSignatureCache.get(launcherCmdWin || shortcutLnkWin) !== cacheKey)
  ) {
    if (launcherVbsPosix) {
      await fsp.mkdir(path.dirname(launcherVbsPosix), { recursive: true }).catch(() => {});
      const vbsContent = [
        'Set sh = CreateObject("WScript.Shell")',
        `sh.Run """${escapeVbsString(exeWin)}"" ${cdpArg}", 1, False`,
        '',
      ].join('\r\n');
      const vbsBuf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbsContent, 'utf16le')]);
      await atomicWriteBuffer(launcherVbsPosix, vbsBuf).catch(() => {});
    }

    if (launcherCmdPosix) {
      await fsp.mkdir(path.dirname(launcherCmdPosix), { recursive: true }).catch(() => {});
      const cmdContent = launcherVbsWin
        ? [
            '@echo off',
            'chcp 65001 >nul',
            'rem 静默无黑窗启动 Antigravity 高清壁纸模式 (纯 CSS CDP 通道，不修改 app.asar)',
            `start "" wscript.exe //Nologo "${launcherVbsWin}"`,
            'exit /b 0',
            '',
          ].join('\r\n')
        : [
            '@echo off',
            'chcp 65001 >nul',
            `start "" /b "${exeWin}" ${cdpArg}`,
            'exit /b 0',
            '',
          ].join('\r\n');
      await atomicWriteText(launcherCmdPosix, cmdContent).catch(() => {});
    }

    if (shortcutLnkPosix && shortcutLnkWin) {
      const workDirWin = exeWin.replace(/[\\/][^\\/]+$/, '');
      await createWindowsShortcutLnk({
        lnkPosix: shortcutLnkPosix,
        lnkWin: shortcutLnkWin,
        targetPath: exeWin,
        args: cdpArg,
        workingDir: workDirWin,
        description: `Antigravity (高清壁纸 CDP :${port})`,
        hostInfo,
      });
    }

    launcherSignatureCache.set(launcherCmdWin || shortcutLnkWin, cacheKey);
  }

  const info = {
    port,
    exePath: exeWin,
    exeFound,
    launcherVbsPath: launcherVbsWin,
    launcherCmdPath: launcherCmdWin,
    shortcutLnkPath: shortcutLnkPosix && fs.existsSync(shortcutLnkPosix) ? shortcutLnkWin : '',
    launchCommand,
    directArgs: cdpArg,
  };
  cachedLauncherSnapshot = info;
  return info;
}

/**
 * Build surgical pure-CSS wallpaper & palette styling for Antigravity's Electron shell.
 * Uses the exact same optical veil formula as Scheme 1 + AGY Console so wallpaper brightness
 * matches 1:1 while keeping all text, code, icons, and popovers 100% solid & crisp.
 */
export function buildCdpThemeCss(themes = {}, wallpaperDataUri = '') {
  const opacity = clampInt(themes.opacity, 0, 100, 32);
  const blur = clampInt(themes.blur, 0, 24, 4);
  const dim = clampInt(themes.dim, 0, 85, 52);
  const hostBlendPct = clampInt(themes.hostBlendPct, 5, 42, 18);
  const fit = themes.fit === 'contain' ? 'contain' : 'cover';

  const colors = themes.colors && typeof themes.colors === 'object' ? themes.colors : {};
  const [cr, cg, cb] = parseHexRgb(colors.canvas, [7, 7, 9]);
  const [chr, chg, chb] = parseHexRgb(colors.chrome, [17, 16, 21]);
  const [br, bg, bb] = parseHexRgb(colors.bubble, [19, 19, 23]);
  const accent =
    typeof colors.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(colors.accent)
      ? colors.accent
      : '#3570e4';

  const wpOpacity = (opacity / 100).toFixed(3);
  const dimFrac = dim / 100;
  const blendFrac = hostBlendPct / 100;
  // Exact optical match to Scheme 1 & AGY Console: single unified veil on html::after
  const totalVeilAlpha = Math.max(0.28, Math.min(0.96, 1 - (1 - dimFrac) * blendFrac)).toFixed(3);
  const sidebarTintAlpha = Math.max(0.14, Math.min(0.36, 0.30 - blendFrac * 0.28)).toFixed(3);
  const softSurfaceAlpha = Math.max(0.18, Math.min(0.48, 0.40 - blendFrac * 0.34)).toFixed(3);
  const composerAlpha = Math.max(0.68, Math.min(0.90, 0.86 - blendFrac * 0.32)).toFixed(3);
  const safeUrl = wallpaperDataUri ? `url("${wallpaperDataUri}")` : 'none';

  return `
/* Antigravity Monitor · Scheme 2 Pure-CSS Wallpaper (Zero app.asar edits) */
html {
  background-color: rgb(${cr}, ${cg}, ${cb}) !important;
  --agy-mon-accent: ${accent};
}

html::before {
  content: "" !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: 0 !important;
  pointer-events: none !important;
  background-image: ${safeUrl} !important;
  background-position: center center !important;
  background-repeat: no-repeat !important;
  background-size: ${fit} !important;
  opacity: ${wpOpacity} !important;
  filter: ${blur > 0 ? `blur(${blur}px)` : 'none'} !important;
  transform: ${blur > 0 ? 'scale(1.04)' : 'none'} !important;
  will-change: opacity, filter !important;
}

html::after {
  content: "" !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: 0 !important;
  pointer-events: none !important;
  background: rgba(${cr}, ${cg}, ${cb}, ${totalVeilAlpha}) !important;
}

body {
  position: relative !important;
  z-index: 1 !important;
  background: transparent !important;
  background-color: transparent !important;
}

body > #root,
body > #app,
body > div:first-of-type {
  background-color: transparent !important;
}

/* Workbench & WSL Remote shell surfaces (clears stubborn opaque light/dark chrome panels) */
.monaco-workbench,
.monaco-workbench .part,
.monaco-workbench .part > .content,
.monaco-workbench .part.titlebar,
.monaco-workbench .part.statusbar,
.monaco-workbench .part.activitybar,
.monaco-workbench .part.panel,
.monaco-workbench .part.editor > .content .editor-group-container,
.monaco-workbench .part.editor > .content .editor-group-container > .title,
.monaco-workbench .part.editor > .content .editor-group-container > .title .tabs-and-actions-container,
.monaco-workbench .part.editor > .content .editor-group-container > .title .tabs-container,
.monaco-workbench .part.editor > .content .editor-group-container > .title .editor-actions,
.monaco-workbench .part.editor > .content .editor-group-container > .editor-container,
.monaco-editor,
.monaco-editor-background,
.monaco-editor .margin,
.monaco-editor .inputarea.ime-input,
.monaco-pane-view .pane > .pane-header,
.monaco-list .monaco-list-rows,
.breadcrumbs-control {
  background-color: transparent !important;
  background-image: none !important;
}

.monaco-workbench .part.sidebar,
.monaco-workbench .part.auxiliarybar {
  background-color: rgba(${chr}, ${chg}, ${chb}, ${sidebarTintAlpha}) !important;
}

.monaco-workbench .part.editor > .content .editor-group-container > .title .tabs-container > .tab.active {
  background-color: rgba(${br}, ${bg}, ${bb}, ${softSurfaceAlpha}) !important;
}

/* Auto-discovered opaque structural shell containers (zero stacked double veils) */
[data-agy-mon-layer="transparent"] {
  background-color: transparent !important;
  background-image: none !important;
}

[data-agy-mon-layer="sidebar"] {
  background-color: rgba(${chr}, ${chg}, ${chb}, ${sidebarTintAlpha}) !important;
  background-image: none !important;
}

[data-agy-mon-layer="surface-soft"] {
  background-color: rgba(${br}, ${bg}, ${bb}, ${softSurfaceAlpha}) !important;
  background-image: none !important;
}

[data-agy-mon-layer="composer"] {
  background-color: rgba(${br}, ${bg}, ${bb}, ${composerAlpha}) !important;
  backdrop-filter: blur(10px) !important;
}

/* Protect popups, dropdowns, dialogs, menus, hover widgets, and tooltips with crisp opaque surfaces */
[role="dialog"],
[role="alertdialog"],
[role="menu"],
[role="listbox"],
[role="tooltip"],
[data-radix-popper-content-wrapper] > *,
[data-sonner-toast],
.monaco-hover,
.suggest-widget,
.quick-input-widget,
.context-view .monaco-menu {
  background-color: rgba(${chr}, ${chg}, ${chb}, 0.96) !important;
  backdrop-filter: blur(14px) !important;
}
`.trim();
}

export function isAntigravityAppTarget(target) {
  if (!target || !target.webSocketDebuggerUrl) return false;
  const tType = String(target.type || '').toLowerCase();
  if (tType !== 'page' && tType !== 'webview' && tType !== 'iframe') return false;
  const url = String(target.url || '').trim();
  const low = url.toLowerCase();
  const title = String(target.title || '').trim();
  const lowTitle = title.toLowerCase();
  if (!low) return false;
  if (
    low.startsWith('devtools://') ||
    low.startsWith('chrome-extension://') ||
    low.startsWith('chrome://') ||
    low.startsWith('about:') ||
    low.startsWith('blob:') ||
    low.startsWith('data:')
  ) {
    return false;
  }
  // Never inject host wallpaper into AGY Monitor's own sidecar console
  if (
    lowTitle === 'antigravity monitor' ||
    lowTitle === 'agy 控制台' ||
    low.includes('/agy_monitor')
  ) {
    return false;
  }
  // Local loopback HTTP/HTTPS targets: allow Antigravity WSL Remote / Web workbench host pages
  // (e.g. https://127.0.0.1:<port>/... with title "... - Antigravity" or "Antigravity"),
  // while still rejecting sidecar webviews and unrelated local dev servers.
  const isLoopbackHttp =
    low.startsWith('https://127.0.0.1:') ||
    low.startsWith('https://localhost:') ||
    low.startsWith('http://127.0.0.1:') ||
    low.startsWith('http://localhost:');
  if (isLoopbackHttp) {
    if (tType !== 'page') return false;
    return (
      lowTitle === 'antigravity' ||
      lowTitle.endsWith(' - antigravity') ||
      lowTitle.includes('antigravity')
    );
  }
  if (low.startsWith('https://') || low.startsWith('http://')) {
    return false;
  }
  return true;
}

export function rewriteTargetWsUrl(wsUrl, activePort, proxyHost, proxyPort) {
  if (typeof wsUrl !== 'string' || !wsUrl) return '';
  if (!proxyHost || !proxyPort) return wsUrl;
  try {
    const parsed = new URL(wsUrl);
    const isLocalHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    const portNum = Number(parsed.port || activePort);
    if (isLocalHost && portNum === Number(activePort)) {
      parsed.hostname = proxyHost;
      parsed.port = String(proxyPort);
      return parsed.toString();
    }
  } catch {
    // Fallback string replace below
  }
  return wsUrl.replace(
    new RegExp(`^(wss?:\\/\\/)(?:127\\.0\\.0\\.1|localhost):${Number(activePort)}\\b`, 'i'),
    `$1${proxyHost}:${Number(proxyPort)}`,
  );
}

function buildApplyThemeAndScanExpr(cssText) {
  return `(function(){
    var styleId = ${JSON.stringify(STYLE_ELEMENT_ID)};
    var el = document.getElementById(styleId);
    if (!el) {
      el = document.createElement('style');
      el.id = styleId;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = ${JSON.stringify(cssText)};

    if (window.__agyMonLayerEngine && window.__agyMonLayerEngine.version !== 2) {
      try { window.__agyMonLayerEngine.stop(); } catch (e) {}
    }

    if (!window.__agyMonLayerEngine) {
      var probeCtx = null;
      function parseBgRgba(raw) {
        if (!raw || raw === 'transparent' || raw === 'rgba(0, 0, 0, 0)') return null;
        var m = /^rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:\\s*[,/]\\s*([\\d.]+%?))?\\s*\\)$/i.exec(raw);
        if (m) {
          var a = 1;
          if (m[4] !== undefined) {
            a = m[4].indexOf('%') >= 0 ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
          }
          return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a: a };
        }
        var cs = /^color\\(\\s*srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+%?))?\\s*\\)$/i.exec(raw);
        if (cs) {
          var ca = 1;
          if (cs[4] !== undefined) {
            ca = cs[4].indexOf('%') >= 0 ? parseFloat(cs[4]) / 100 : parseFloat(cs[4]);
          }
          return {
            r: Math.round(parseFloat(cs[1]) * 255),
            g: Math.round(parseFloat(cs[2]) * 255),
            b: Math.round(parseFloat(cs[3]) * 255),
            a: ca
          };
        }
        try {
          if (!probeCtx) {
            var cv = document.createElement('canvas');
            cv.width = 1;
            cv.height = 1;
            probeCtx = cv.getContext('2d', { willReadFrequently: true });
          }
          if (probeCtx) {
            probeCtx.clearRect(0, 0, 1, 1);
            probeCtx.fillStyle = raw;
            probeCtx.fillRect(0, 0, 1, 1);
            var px = probeCtx.getImageData(0, 0, 1, 1).data;
            return { r: px[0], g: px[1], b: px[2], a: px[3] / 255 };
          }
        } catch (e) {}
        return null;
      }

      var SKIP_TAGS = {
        HTML: 1, BODY: 1, SCRIPT: 1, STYLE: 1, LINK: 1, META: 1,
        SVG: 1, IMG: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1,
        IFRAME: 1, WEBVIEW: 1, PRE: 1, CODE: 1, TABLE: 1,
        BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, A: 1
      };
      var PROTECT_SEL = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"],[data-radix-popper-content-wrapper],[data-sonner-toast],.monaco-hover,.suggest-widget,.quick-input-widget,.context-view,pre,code,#' + ${JSON.stringify(HUD_ELEMENT_ID)};
      var LANDMARK_SEL = 'header,nav,aside,main,footer,[role="main"],[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"],.part,.pane-body,.editor-group-container,.tabs-and-actions-container,.breadcrumbs-control';

      function evaluateNode(node, vw, vh) {
        if (!node || node.nodeType !== 1) return 0;
        if (SKIP_TAGS[node.tagName]) return 0;
        if (node.getAttribute('data-agy-mon-layer')) return 0;
        if (node.closest && node.closest(PROTECT_SEL)) return 0;

        var rect = node.getBoundingClientRect();
        if (!rect || rect.width < 44 || rect.height < 20) return 0;

        var st = window.getComputedStyle(node);
        var bg = parseBgRgba(st.backgroundColor);
        var hasGradientBg = Boolean(st.backgroundImage && st.backgroundImage.indexOf('gradient(') >= 0);
        if ((!bg || bg.a < 0.35) && !hasGradientBg) return 0;

        // Skip vivid accent banners/pills; lift neutral dark & light chrome/surfaces (incl. light blue-gray tints)
        if (bg && bg.a >= 0.35) {
          var chroma = Math.max(bg.r, bg.g, bg.b) - Math.min(bg.r, bg.g, bg.b);
          if (chroma > 52) return 0;
        }

        var isLeftSidebar =
          rect.left <= 56 &&
          rect.width >= 44 &&
          rect.width <= Math.min(440, vw * 0.40) &&
          rect.height >= vh * 0.34;
        var isRightSidebar =
          rect.right >= vw - 56 &&
          rect.width >= 44 &&
          rect.width <= Math.min(460, vw * 0.42) &&
          rect.height >= vh * 0.34;
        var isTopBar =
          rect.top <= 130 &&
          rect.height <= 116 &&
          rect.width >= Math.min(180, vw * 0.22);
        var isBottomBar =
          rect.bottom >= vh - 48 &&
          rect.height <= Math.max(120, vh * 0.42) &&
          rect.width >= Math.min(180, vw * 0.22);
        var isMainPane =
          rect.width >= Math.min(180, vw * 0.16) &&
          rect.height >= Math.min(120, vh * 0.16);

        if (isLeftSidebar || isRightSidebar) {
          var hasSidebarAnc = node.parentElement && node.parentElement.closest('[data-agy-mon-layer="sidebar"]');
          node.setAttribute('data-agy-mon-layer', hasSidebarAnc ? 'transparent' : 'sidebar');
          return 1;
        }
        if (isTopBar || isBottomBar || isMainPane) {
          node.setAttribute('data-agy-mon-layer', 'transparent');
          return 1;
        }
        return 0;
      }

      function scanLayers() {
        var vw = window.innerWidth || 0;
        var vh = window.innerHeight || 0;
        if (vw < 300 || vh < 200) return 0;

        var xs = [
          12,
          Math.min(44, Math.floor(vw * 0.04)),
          Math.floor(vw * 0.12),
          Math.floor(vw * 0.26),
          Math.floor(vw * 0.42),
          Math.floor(vw * 0.58),
          Math.floor(vw * 0.74),
          Math.floor(vw * 0.88),
          Math.max(0, vw - 16)
        ];
        var ys = [
          12,
          44,
          84,
          Math.floor(vh * 0.18),
          Math.floor(vh * 0.34),
          Math.floor(vh * 0.52),
          Math.floor(vh * 0.70),
          Math.floor(vh * 0.85),
          Math.max(0, vh - 14)
        ];

        var seen = new Set();
        var tagged = 0;

        for (var xi = 0; xi < xs.length; xi++) {
          for (var yi = 0; yi < ys.length; yi++) {
            var stack = document.elementsFromPoint(xs[xi], ys[yi]);
            for (var si = 0; si < stack.length; si++) {
              var node = stack[si];
              if (!node || seen.has(node)) continue;
              seen.add(node);
              tagged += evaluateNode(node, vw, vh);
            }
          }
        }

        try {
          var landmarks = document.querySelectorAll(LANDMARK_SEL);
          for (var li = 0; li < landmarks.length; li++) {
            var lm = landmarks[li];
            if (!lm || seen.has(lm)) continue;
            seen.add(lm);
            tagged += evaluateNode(lm, vw, vh);
          }
        } catch (e) {}

        return tagged;
      }

      var timer = setInterval(scanLayers, 1100);
      var onResize = function() { setTimeout(scanLayers, 40); };
      window.addEventListener('resize', onResize, { passive: true });
      var mutTimer = null;
      var layerObserver = null;
      if (typeof MutationObserver === 'function' && document.body) {
        layerObserver = new MutationObserver(function() {
          if (mutTimer) return;
          mutTimer = setTimeout(function() {
            mutTimer = null;
            scanLayers();
          }, 32);
        });
        layerObserver.observe(document.body, { childList: true, subtree: true });
      }

      window.__agyMonLayerEngine = {
        version: 2,
        scan: scanLayers,
        stop: function() {
          clearInterval(timer);
          if (mutTimer) { clearTimeout(mutTimer); mutTimer = null; }
          if (layerObserver) { layerObserver.disconnect(); layerObserver = null; }
          window.removeEventListener('resize', onResize);
          var nodes = document.querySelectorAll('[data-agy-mon-layer]');
          for (var i = 0; i < nodes.length; i++) {
            nodes[i].removeAttribute('data-agy-mon-layer');
          }
          delete window.__agyMonLayerEngine;
        }
      };
    }

    window.__agyMonLayerEngine.scan();
    return true;
  })()`;
}

function buildRemoveThemeExpr() {
  return `(function(){
    if (window.__agyMonLayerEngine && typeof window.__agyMonLayerEngine.stop === 'function') {
      window.__agyMonLayerEngine.stop();
    }
    var el = document.getElementById(${JSON.stringify(STYLE_ELEMENT_ID)});
    if (el && el.parentNode) el.parentNode.removeChild(el);
    return true;
  })()`;
}

function buildHudSyncExpr(hudPayload, accentColor, displayConfig = null, guideImageDataUri = '') {
  const disp = normalizeHudDisplayConfig(displayConfig);
  const safePayload = JSON.stringify({
    percent: clampInt(hudPayload?.percent, 0, 999, 0),
    totalUsed: Math.max(0, Math.round(Number(hudPayload?.totalUsed) || 0)),
    windowCap: Math.max(1, Math.round(Number(hudPayload?.windowCap) || 512000)),
    tokPerSec:
      typeof hudPayload?.tokPerSec === 'number' && Number.isFinite(hudPayload.tokPerSec) && hudPayload.tokPerSec > 0
        ? hudPayload.tokPerSec
        : null,
    cacheHitPct:
      typeof hudPayload?.cacheHitPct === 'number' && Number.isFinite(hudPayload.cacheHitPct)
        ? clampInt(hudPayload.cacheHitPct, 0, 100, 0)
        : null,
    upstreamModelId: typeof hudPayload?.upstreamModelId === 'string' ? hudPayload.upstreamModelId : '',
    accent:
      typeof accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(accentColor)
        ? accentColor
        : '#5b8cff',
    display: disp,
    guideImageDataUri: typeof guideImageDataUri === 'string' ? guideImageDataUri : '',
  });

  return `(function(data){
    var HUD_ID = ${JSON.stringify(HUD_ELEMENT_ID)};
    var POP_ID = ${JSON.stringify(HUD_POPOVER_ID)};
    var GUIDE_ID = ${JSON.stringify(HUD_GUIDE_ID)};
    var STYLE_ID = ${JSON.stringify(HUD_STYLE_ID)};

    if (!document.getElementById(STYLE_ID)) {
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = [
        '#' + HUD_ID + ' { display: inline-flex; align-items: center; gap: 5px; flex: 0 1 auto; min-width: 0; max-width: 390px; margin-left: auto; margin-right: 4px; font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif; user-select: none; }',
        '#' + HUD_ID + ' .agy-hud-ring-pill { display: inline-flex; align-items: center; height: 22px; padding: 0 3px; border-radius: 999px; border: 1px solid transparent; background: transparent; cursor: pointer; flex-shrink: 0; transition: background 0.14s ease, border-color 0.14s ease, padding 0.14s ease; }',
        '#' + HUD_ID + ' .agy-hud-ring-pill:hover { background: rgba(22, 24, 32, 0.90); border-color: rgba(255, 255, 255, 0.22); padding: 0 7px 0 5px; }',
        '#' + HUD_ID + ' .agy-hud-pct { max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap; font-size: 11px; font-weight: 600; color: #eae9ef; font-variant-numeric: tabular-nums; margin-left: 0; transition: max-width 0.14s ease, opacity 0.12s ease, margin-left 0.14s ease; }',
        '#' + HUD_ID + ' .agy-hud-ring-pill:hover .agy-hud-pct { max-width: 52px; opacity: 1; margin-left: 5px; }',
        '#' + HUD_ID + ' .agy-hud-meta-pill { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(19, 21, 28, 0.78); cursor: pointer; min-width: 0; max-width: 320px; overflow: hidden; transition: background 0.14s ease, border-color 0.14s ease; }',
        '#' + HUD_ID + ' .agy-hud-meta-pill:hover { background: rgba(28, 31, 41, 0.94); border-color: rgba(255, 255, 255, 0.28); }',
        '#' + HUD_ID + ' .agy-hud-speed, #' + HUD_ID + ' .agy-hud-cache { font-size: 11px; font-weight: 400; line-height: 1; color: #e2e1e8; white-space: nowrap; flex-shrink: 0; font-variant-numeric: tabular-nums; }',
        '#' + HUD_ID + ' .agy-hud-cache { font-size: 10.5px; color: #b8dfcf; }',
        '#' + HUD_ID + ' .agy-hud-dot { font-size: 11px; color: rgba(255, 255, 255, 0.42); flex-shrink: 0; }',
        '#' + HUD_ID + ' .agy-hud-model { font-size: 11px; color: #b6b5c0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }',
        '#' + HUD_ID + ' .agy-hud-empty-pill { display: none; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.16); background: rgba(22,24,32,0.82); color: #c7c7d4; font-size: 12px; cursor: pointer; flex-shrink: 0; }',
        '#' + HUD_ID + ' .agy-hud-empty-pill:hover { background: rgba(34,38,50,0.94); border-color: rgba(255,255,255,0.30); color: #ffffff; }',
        '#' + POP_ID + ' { position: fixed; z-index: 2147483640; width: 238px; padding: 8px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.14); background: rgba(22,24,33,0.97); box-shadow: 0 12px 32px rgba(0,0,0,0.52); color: #eae9f0; font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif; user-select: none; backdrop-filter: blur(14px); }',
        '#' + POP_ID + ' .agy-pop-head { display: flex; align-items: center; justify-content: space-between; padding: 3px 6px 7px; border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 4px; }',
        '#' + POP_ID + ' .agy-pop-title { font-size: 11.5px; font-weight: 600; color: #dcdce6; }',
        '#' + POP_ID + ' .agy-pop-badge { font-size: 11px; font-weight: 600; color: #9ec0ff; font-variant-numeric: tabular-nums; }',
        '#' + POP_ID + ' .agy-pop-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 6px 6px; border: 0; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; text-align: left; }',
        '#' + POP_ID + ' .agy-pop-row:hover { background: rgba(255,255,255,0.07); }',
        '#' + POP_ID + ' .agy-pop-left { display: inline-flex; align-items: center; gap: 8px; min-width: 0; flex-shrink: 0; }',
        '#' + POP_ID + ' .agy-pop-box { width: 15px; height: 15px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.28); background: rgba(255,255,255,0.04); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 10px; font-weight: 700; color: #fff; }',
        '#' + POP_ID + ' .agy-pop-row[data-checked="1"] .agy-pop-box { border-color: transparent; background: var(--agy-pop-accent, #5b8cff); }',
        '#' + POP_ID + ' .agy-pop-lbl { font-size: 12px; color: #e8e8f0; }',
        '#' + POP_ID + ' .agy-pop-val { font-size: 11px; color: #9a9cae; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 112px; font-variant-numeric: tabular-nums; }',
        '#' + POP_ID + ' .agy-pop-foot { margin-top: 5px; padding-top: 5px; border-top: 1px solid rgba(255,255,255,0.08); }',
        '#' + POP_ID + ' .agy-pop-guide-row { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 26px; padding: 0 7px 0 6px; border: 0; border-radius: 7px; background: rgba(255,255,255,0.045); color: #bac2d6; font-size: 11.5px; cursor: pointer; }',
        '#' + POP_ID + ' .agy-pop-guide-row:hover, #' + POP_ID + ' .agy-pop-guide-row[data-pinned="1"] { background: rgba(255,255,255,0.11); color: #f0f4ff; }',
        '#' + POP_ID + ' .agy-pop-q { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 999px; background: rgba(255,255,255,0.12); font-size: 10px; font-weight: 700; color: #bac6e4; }',
        '#' + GUIDE_ID + ' { position: fixed; z-index: 2147483641; width: 306px; padding: 8px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.16); background: rgba(20,22,31,0.98); box-shadow: 0 14px 36px rgba(0,0,0,0.62); pointer-events: none; font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif; }',
        '#' + GUIDE_ID + ' .agy-guide-cap { font-size: 11px; font-weight: 600; color: #dae0f2; margin: 0 2px 7px; }',
        '#' + GUIDE_ID + ' .agy-guide-img { display: block; width: 100%; aspect-ratio: 784 / 439; object-fit: cover; border-radius: 8px; border: 1px solid rgba(255,255,255,0.14); }'
      ].join('\\n');
      (document.head || document.documentElement).appendChild(st);
    }

    function fmtTokK(n) {
      var v = Math.max(0, Number(n) || 0);
      if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\\.0$/, '') + 'M';
      if (v >= 1000) return Math.round(v / 1000) + 'k';
      return String(v);
    }

    function getDisplayState() {
      var cur = window.__agyMonHudDisplay;
      var incoming = data.display || { showSpeed: true, showCacheHit: true, showModel: true, showContext: true, updatedAtMs: 0 };
      if (!cur || ((incoming.updatedAtMs || 0) > (cur.updatedAtMs || 0) && !window.__agyMonHudDisplayDirty)) {
        cur = {
          showSpeed: incoming.showSpeed !== false,
          showCacheHit: incoming.showCacheHit !== false,
          showModel: incoming.showModel !== false,
          showContext: incoming.showContext !== false,
          updatedAtMs: incoming.updatedAtMs || 0
        };
        window.__agyMonHudDisplay = cur;
      }
      return cur;
    }

    function hideGuideCard() {
      var g = document.getElementById(GUIDE_ID);
      if (g && g.parentNode) g.parentNode.removeChild(g);
    }

    function showGuideCard(popEl) {
      var d = window.__agyMonHudLatestData || data;
      if (!popEl || !d || !d.guideImageDataUri) return;
      hideGuideCard();
      var g = document.createElement('div');
      g.id = GUIDE_ID;
      g.innerHTML =
        '<div class="agy-guide-cap">打开方式：右上角 Plugins → AGY 控制台</div>' +
        '<img class="agy-guide-img" alt="AGY 控制台打开指引" />';
      var imgEl = g.querySelector('.agy-guide-img');
      if (imgEl) imgEl.src = d.guideImageDataUri;
      document.body.appendChild(g);
      var pr = popEl.getBoundingClientRect();
      var vw = window.innerWidth || 1200;
      var vh = window.innerHeight || 800;
      var gw = g.offsetWidth || 306;
      var gh = g.offsetHeight || 202;
      var left = Math.round(pr.right + 6);
      if (left + gw > vw - 8) {
        left = Math.max(8, Math.round(pr.left - gw - 6));
      }
      var top = Math.round(pr.bottom - gh);
      if (top < 8) top = 8;
      if (top + gh > vh - 8) top = Math.max(8, vh - gh - 8);
      g.style.left = left + 'px';
      g.style.top = top + 'px';
    }

    function closePopover() {
      hideGuideCard();
      var pop = document.getElementById(POP_ID);
      if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    }

    function applyHudDisplayToDom(hudEl, effectiveWidth) {
      if (!hudEl) return;
      var disp = getDisplayState();
      var ringBtn = hudEl.querySelector('.agy-hud-ring-pill');
      var metaBtn = hudEl.querySelector('.agy-hud-meta-pill');
      var emptyBtn = hudEl.querySelector('.agy-hud-empty-pill');
      var speedEl = hudEl.querySelector('.agy-hud-speed');
      var dot1 = hudEl.querySelector('.agy-hud-dot-1');
      var cacheEl = hudEl.querySelector('.agy-hud-cache');
      var dot2 = hudEl.querySelector('.agy-hud-dot-2');
      var modelEl = hudEl.querySelector('.agy-hud-model');

      var anyMeta = disp.showSpeed || disp.showCacheHit || disp.showModel;
      var anyAll = disp.showContext || anyMeta;
      var showModel = disp.showModel && !(effectiveWidth > 0 && effectiveWidth < 520);
      var showCache = disp.showCacheHit && !(effectiveWidth > 0 && effectiveWidth < 430);
      var showSpeed = disp.showSpeed && !(effectiveWidth > 0 && effectiveWidth < 370);
      var anyVisibleMeta = showSpeed || showCache || showModel;
      if (ringBtn) ringBtn.style.display = disp.showContext ? 'inline-flex' : 'none';
      if (emptyBtn) emptyBtn.style.display = (disp.showContext || anyVisibleMeta) ? 'none' : 'inline-flex';
      if (speedEl) speedEl.style.display = showSpeed ? 'inline' : 'none';
      if (cacheEl) cacheEl.style.display = showCache ? 'inline' : 'none';
      if (modelEl) modelEl.style.display = showModel ? 'inline' : 'none';
      if (dot1) dot1.style.display = (showSpeed && (showCache || showModel)) ? 'inline' : 'none';
      if (dot2) dot2.style.display = (showCache && showModel) ? 'inline' : 'none';
      if (metaBtn) {
        metaBtn.style.display = anyVisibleMeta ? 'inline-flex' : 'none';
      }
      if (hudEl) {
        hudEl.style.display = (effectiveWidth > 0 && effectiveWidth < 260) ? 'none' : 'inline-flex';
      }
    }

    function refreshPopoverContents() {
      var pop = document.getElementById(POP_ID);
      if (!pop) return;
      var disp = getDisplayState();
      var d = window.__agyMonHudLatestData || data;
      pop.style.setProperty('--agy-pop-accent', d.accent || '#5b8cff');
      var badge = pop.querySelector('.agy-pop-badge');
      if (badge) badge.textContent = Math.max(0, Math.min(999, Math.round(Number(d.percent) || 0))) + '%';
      var valMap = {
        showSpeed: (typeof d.tokPerSec === 'number' && d.tokPerSec > 0)
          ? ((d.tokPerSec >= 100 ? Math.round(d.tokPerSec) : d.tokPerSec.toFixed(1)) + ' tok/s')
          : '--',
        showCacheHit: (typeof d.cacheHitPct === 'number') ? (d.cacheHitPct + '%') : '--',
        showModel: d.upstreamModelId || '--',
        showContext: d.totalUsed > 0 ? (fmtTokK(d.totalUsed) + ' / ' + fmtTokK(d.windowCap)) : '0%'
      };
      var rows = pop.querySelectorAll('.agy-pop-row');
      for (var i = 0; i < rows.length; i++) {
        var key = rows[i].getAttribute('data-key');
        var checked = Boolean(disp[key]);
        rows[i].setAttribute('data-checked', checked ? '1' : '0');
        var box = rows[i].querySelector('.agy-pop-box');
        if (box) box.textContent = checked ? '✓' : '';
        var val = rows[i].querySelector('.agy-pop-val');
        if (val && Object.prototype.hasOwnProperty.call(valMap, key)) val.textContent = valMap[key];
      }
    }

    function togglePopover(anchorEl) {
      var existing = document.getElementById(POP_ID);
      if (existing) {
        closePopover();
        return;
      }
      var pop = document.createElement('div');
      pop.id = POP_ID;
      pop.innerHTML =
        '<div class="agy-pop-head"><span class="agy-pop-title">底部状态栏显示</span><span class="agy-pop-badge">0%</span></div>' +
        '<button type="button" class="agy-pop-row" data-key="showSpeed"><span class="agy-pop-left"><span class="agy-pop-box"></span><span class="agy-pop-lbl">生成速率</span></span><span class="agy-pop-val">--</span></button>' +
        '<button type="button" class="agy-pop-row" data-key="showCacheHit"><span class="agy-pop-left"><span class="agy-pop-box"></span><span class="agy-pop-lbl">缓存命中</span></span><span class="agy-pop-val">--</span></button>' +
        '<button type="button" class="agy-pop-row" data-key="showModel"><span class="agy-pop-left"><span class="agy-pop-box"></span><span class="agy-pop-lbl">上游模型</span></span><span class="agy-pop-val">--</span></button>' +
        '<button type="button" class="agy-pop-row" data-key="showContext"><span class="agy-pop-left"><span class="agy-pop-box"></span><span class="agy-pop-lbl">上下文占用</span></span><span class="agy-pop-val">0%</span></button>' +
        '<div class="agy-pop-foot"><button type="button" class="agy-pop-guide-row" data-pinned="0"><span class="agy-pop-left"><span class="agy-pop-q">?</span><span>如何打开 AGY 控制台</span></span><span>▸</span></button></div>';

      var guideBtn = pop.querySelector('.agy-pop-guide-row');
      if (guideBtn) {
        guideBtn.addEventListener('mouseenter', function() { showGuideCard(pop); });
        guideBtn.addEventListener('mouseleave', function() {
          if (guideBtn.getAttribute('data-pinned') !== '1') hideGuideCard();
        });
        guideBtn.addEventListener('click', function(ev) {
          ev.stopPropagation();
          var nextPin = guideBtn.getAttribute('data-pinned') !== '1';
          guideBtn.setAttribute('data-pinned', nextPin ? '1' : '0');
          if (nextPin) showGuideCard(pop);
          else hideGuideCard();
        });
      }

      pop.addEventListener('click', function(ev) {
        ev.stopPropagation();
        var row = ev.target && ev.target.closest ? ev.target.closest('.agy-pop-row') : null;
        if (row) {
          var key = row.getAttribute('data-key');
          var disp = getDisplayState();
          disp[key] = !disp[key];
          disp.updatedAtMs = Date.now();
          window.__agyMonHudDisplay = disp;
          window.__agyMonHudDisplayDirty = {
            showSpeed: disp.showSpeed,
            showCacheHit: disp.showCacheHit,
            showModel: disp.showModel,
            showContext: disp.showContext,
            updatedAtMs: disp.updatedAtMs
          };
          refreshPopoverContents();
          applyHudDisplayToDom(document.getElementById(HUD_ID), window.__agyMonHudLastCardWidth || 0);
        }
      });

      document.body.appendChild(pop);
      refreshPopoverContents();

      var rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
      var vw = window.innerWidth || 1200;
      var vh = window.innerHeight || 800;
      var pw = pop.offsetWidth || 238;
      var ph = pop.offsetHeight || 204;
      var left = rect ? Math.round(rect.left + rect.width / 2 - pw / 2) : Math.round(vw - pw - 16);
      var top = rect ? Math.round(rect.top - ph - 8) : Math.round(vh - ph - 48);
      if (left < 10) left = 10;
      if (left + pw > vw - 10) left = Math.max(10, vw - pw - 10);
      if (top < 10) top = rect ? Math.min(vh - ph - 10, Math.round(rect.bottom + 8)) : 10;
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';

      if (!window.__agyMonHudPopDismissInstalled) {
        window.__agyMonHudPopDismissInstalled = true;
        window.__agyMonHudPopDocClick = function(ev) {
          var p = document.getElementById(POP_ID);
          if (!p) return;
          var h = document.getElementById(HUD_ID);
          if (p.contains(ev.target) || (h && h.contains(ev.target))) return;
          closePopover();
        };
        window.__agyMonHudPopKeyDown = function(ev) {
          if (ev.key === 'Escape') closePopover();
        };
        document.addEventListener('mousedown', window.__agyMonHudPopDocClick, true);
        document.addEventListener('keydown', window.__agyMonHudPopKeyDown, true);
      }
    }

    function findComposerAnchor() {
      var vh = window.innerHeight || 0;
      var vw = window.innerWidth || 0;
      if (vh < 240 || vw < 320) return null;

      var inputs = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
      var bestInput = null;
      var bestBottom = -1;
      for (var i = 0; i < inputs.length; i++) {
        var ir = inputs[i].getBoundingClientRect();
        if (!ir || ir.width < 160 || ir.height < 16) continue;
        if (ir.bottom < vh - 280 || ir.top > vh - 12) continue;
        if (ir.bottom > bestBottom) {
          bestBottom = ir.bottom;
          bestInput = inputs[i];
        }
      }
      if (!bestInput) return null;

      var card = bestInput;
      var chosenBtn = null;
      var cardRect = null;
      var MODE_RE = /turbo|planning|fast|auto|strict|review|proceed|sandbox|permission|ask|极速|规划|快速|自动|严格|审查|权限/i;
      var MIC_RE = /microphone|voice|dictate|speech|audio|麦克风|语音/i;
      var SEND_RE = /send|stop|submit|cancel|发送|停止/i;

      for (var up = 0; up < 6 && card && card.parentElement && card.parentElement !== document.body; up++) {
        card = card.parentElement;
        var cr = card.getBoundingClientRect();
        if (cr.height < 52 || cr.height > 360 || cr.width < 200) continue;
        var btns = card.querySelectorAll('button');
        if (btns.length < 3) continue;

        var modeBtn = null, micBtn = null, sendBtn = null;
        var rightRowBtns = [];
        for (var bi = 0; bi < btns.length; bi++) {
          var b = btns[bi];
          if (b.closest && b.closest('#' + HUD_ID)) continue;
          var br = b.getBoundingClientRect();
          if (!br || br.width < 14 || br.height < 14 || br.top < cr.top + cr.height * 0.35) continue;
          rightRowBtns.push({ el: b, r: br });
          var label = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).trim();
          if (!modeBtn && MODE_RE.test(label) && br.width <= 170) modeBtn = b;
          else if (!micBtn && MIC_RE.test(label) && br.width <= 56) micBtn = b;
          else if (!sendBtn && SEND_RE.test(label) && br.width <= 56) sendBtn = b;
        }

        // If Turbo collapsed into an unlabeled shield icon directly to the left of Mic, anchor before it
        if (!modeBtn && micBtn) {
          var mr = micBtn.getBoundingClientRect();
          var mcy = (mr.top + mr.bottom) / 2;
          for (var ri = 0; ri < rightRowBtns.length; ri++) {
            var cand = rightRowBtns[ri];
            if (cand.el === micBtn) continue;
            var ccy = (cand.r.top + cand.r.bottom) / 2;
            if (Math.abs(ccy - mcy) <= 12 && cand.r.right <= mr.left + 2 && mr.left - cand.r.right <= 24 && cand.r.width <= 52) {
              modeBtn = cand.el;
              break;
            }
          }
        }

        chosenBtn = modeBtn || micBtn || sendBtn;
        if (chosenBtn) {
          cardRect = cr;
          break;
        }
      }

      if (!chosenBtn || !chosenBtn.parentElement) return null;
      return { parent: chosenBtn.parentElement, before: chosenBtn, cardWidth: cardRect ? cardRect.width : 0 };
    }

    function isBadHeaderTitle(txt) {
      if (!txt || txt.length < 2 || txt.length > 120) return true;
      if (txt.indexOf('[AGY_PROGRESS') >= 0) return true;
      var low = txt.toLowerCase();
      if (low === 'antigravity' || low === 'workspace' || low === 'view' || low === 'window' || low === 'swarm' || low === 'agy 控制台') return true;
      return false;
    }

    function readActiveView() {
      var vh = window.innerHeight || 0;
      var vw = window.innerWidth || 0;
      if (vh < 240 || vw < 320) return null;
      var nodes = document.querySelectorAll('header *, nav *, [role="banner"] *, button, span, div');
      var parts = [];
      for (var i = 0; i < nodes.length && parts.length < 28; i++) {
        var el = nodes[i];
        if (el.children && el.children.length > 0) continue;
        var txt = (el.textContent || '').trim();
        if (!txt || txt.length > 140) continue;
        var r = el.getBoundingClientRect();
        if (!r || r.top < 18 || r.bottom > 86 || r.left < 150 || r.right > vw - 90 || r.height > 40) continue;
        parts.push({ x: r.left, text: txt });
      }
      parts.sort(function(a, b) { return a.x - b.x; });
      for (var p = 0; p < parts.length; p++) {
        var s = parts[p].text;
        var low = s.toLowerCase();
        if (low === 'new conversation' || low === '新建对话') {
          return { workspace: '', title: s, isNewConversation: true };
        }
        var idx = s.indexOf(' / ');
        if (idx > 0 && idx < s.length - 3) {
          var t1 = s.slice(idx + 3).trim();
          if (!isBadHeaderTitle(t1)) {
            return { workspace: s.slice(0, idx).trim(), title: t1, isNewConversation: false };
          }
        }
        if (s === '/' && p + 1 < parts.length) {
          var t2 = parts[p + 1].text;
          if (!isBadHeaderTitle(t2)) {
            return { workspace: p > 0 ? parts[p - 1].text : '', title: t2, isNewConversation: false };
          }
        }
      }
      return null;
    }

    window.__agyMonHudLatestData = data;
    var anchor = findComposerAnchor();
    var hud = document.getElementById(HUD_ID);
    var focused = typeof document.hasFocus === 'function' ? Boolean(document.hasFocus()) : true;
    var dirtyPatch = window.__agyMonHudDisplayDirty || null;
    if (dirtyPatch) window.__agyMonHudDisplayDirty = null;

    if (!anchor) {
      if (hud && hud.parentNode) hud.parentNode.removeChild(hud);
      closePopover();
      return { hudInjected: false, activeView: readActiveView(), focused: focused, displayPatch: dirtyPatch };
    }

    if (!hud) {
      hud = document.createElement('div');
      hud.id = HUD_ID;

      var ringPill = document.createElement('button');
      ringPill.type = 'button';
      ringPill.className = 'agy-hud-ring-pill';
      ringPill.title = '点击选择底部显示项';
      ringPill.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">' +
          '<circle cx="8" cy="8" r="6" fill="none" stroke="rgba(255,255,255,0.24)" stroke-width="2"></circle>' +
          '<circle class="agy-hud-arc" cx="8" cy="8" r="6" fill="none" stroke="#5b8cff" stroke-width="2" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="37.7" stroke-dashoffset="37.7" style="opacity:0"></circle>' +
        '</svg>' +
        '<span class="agy-hud-pct">0%</span>';
      ringPill.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        togglePopover(hud);
      });

      var metaPill = document.createElement('button');
      metaPill.type = 'button';
      metaPill.className = 'agy-hud-meta-pill';
      metaPill.title = '点击选择底部显示项';
      metaPill.innerHTML =
        '<span class="agy-hud-speed">-- tok/s</span>' +
        '<span class="agy-hud-dot agy-hud-dot-1">·</span>' +
        '<span class="agy-hud-cache">缓存 --</span>' +
        '<span class="agy-hud-dot agy-hud-dot-2">·</span>' +
        '<span class="agy-hud-model">--</span>';
      metaPill.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        togglePopover(hud);
      });

      var emptyPill = document.createElement('button');
      emptyPill.type = 'button';
      emptyPill.className = 'agy-hud-empty-pill';
      emptyPill.title = '点击选择底部显示项';
      emptyPill.textContent = '···';
      emptyPill.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        togglePopover(hud);
      });

      hud.appendChild(ringPill);
      hud.appendChild(metaPill);
      hud.appendChild(emptyPill);
    }

    if (hud.parentElement !== anchor.parent || hud.nextSibling !== anchor.before) {
      anchor.parent.insertBefore(hud, anchor.before);
    }

    var rawPct = Math.max(0, Math.min(999, Math.round(Number(data.percent) || 0)));
    var clampedArcPct = Math.min(100, rawPct);
    var arcColor = rawPct >= 90 ? '#ef5350' : (rawPct >= 75 ? '#e99315' : (data.accent || '#5b8cff'));
    var circ = 2 * Math.PI * 6;
    var offset = circ * (1 - clampedArcPct / 100);
    var arc = hud.querySelector('.agy-hud-arc');
    if (arc) {
      arc.setAttribute('stroke', arcColor);
      arc.setAttribute('stroke-dashoffset', offset.toFixed(2));
      arc.style.opacity = rawPct > 0 ? '1' : '0';
    }
    var pctEl = hud.querySelector('.agy-hud-pct');
    if (pctEl) pctEl.textContent = rawPct + '%';

    var speedEl = hud.querySelector('.agy-hud-speed');
    if (speedEl) {
      if (typeof data.tokPerSec === 'number' && data.tokPerSec > 0) {
        speedEl.textContent = (data.tokPerSec >= 100 ? Math.round(data.tokPerSec) : data.tokPerSec.toFixed(1)) + ' tok/s';
      } else {
        speedEl.textContent = '-- tok/s';
      }
    }
    var cacheEl = hud.querySelector('.agy-hud-cache');
    if (cacheEl) {
      cacheEl.textContent = typeof data.cacheHitPct === 'number' ? ('缓存 ' + data.cacheHitPct + '%') : '缓存 --';
    }
    var modelEl = hud.querySelector('.agy-hud-model');
    if (modelEl) {
      modelEl.textContent = data.upstreamModelId || '--';
    }

    // Measure full composer card width rather than the narrow button-group flex wrapper
    var effectiveWidth = anchor.cardWidth || (anchor.parent.getBoundingClientRect ? anchor.parent.getBoundingClientRect().width : 0);
    window.__agyMonHudLastCardWidth = effectiveWidth;
    applyHudDisplayToDom(hud, effectiveWidth);
    refreshPopoverContents();

    if (!window.__agyMonHudObserver && typeof MutationObserver === 'function' && document.body) {
      var hudObsTimer = null;
      var hudObs = new MutationObserver(function() {
        if (document.getElementById(HUD_ID)) return;
        if (hudObsTimer) return;
        hudObsTimer = setTimeout(function() {
          hudObsTimer = null;
          var nextAnchor = findComposerAnchor();
          if (nextAnchor && hud && hud.parentElement !== nextAnchor.parent) {
            nextAnchor.parent.insertBefore(hud, nextAnchor.before);
          }
        }, 40);
      });
      hudObs.observe(document.body, { childList: true, subtree: true });
      window.__agyMonHudObserver = hudObs;
    }

    return { hudInjected: true, activeView: readActiveView(), focused: focused, displayPatch: dirtyPatch };
  })(${safePayload})`;
}

function buildRemoveHudExpr() {
  return `(function(){
    if (window.__agyMonHudObserver) {
      try { window.__agyMonHudObserver.disconnect(); } catch (e) {}
      delete window.__agyMonHudObserver;
    }
    if (window.__agyMonHudPopDocClick) {
      document.removeEventListener('mousedown', window.__agyMonHudPopDocClick, true);
      delete window.__agyMonHudPopDocClick;
    }
    if (window.__agyMonHudPopKeyDown) {
      document.removeEventListener('keydown', window.__agyMonHudPopKeyDown, true);
      delete window.__agyMonHudPopKeyDown;
    }
    delete window.__agyMonHudPopDismissInstalled;
    var g = document.getElementById(${JSON.stringify(HUD_GUIDE_ID)});
    if (g && g.parentNode) g.parentNode.removeChild(g);
    var pop = document.getElementById(${JSON.stringify(HUD_POPOVER_ID)});
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    var el = document.getElementById(${JSON.stringify(HUD_ELEMENT_ID)});
    if (el && el.parentNode) el.parentNode.removeChild(el);
    var st = document.getElementById(${JSON.stringify(HUD_STYLE_ID)});
    if (st && st.parentNode) st.parentNode.removeChild(st);
    return true;
  })()`;
}

const HOST_UI_ZH_DICT = Object.freeze({
  // Left Sidebar & Navigation
  'New Conversation': '新建对话',
  'New conversation': '新建对话',
  Automations: '自动化',
  Customizations: '自定义配置',
  Projects: '项目',
  Settings: '设置',
  Plugins: '插件',
  Skills: '技能',
  Rules: '规则',
  Workflows: '工作流',
  'MCP Servers': 'MCP 服务',
  Marketplace: '插件市场',
  Search: '搜索',
  History: '历史记录',
  Archived: '已归档',
  'Open Folder': '打开文件夹',
  'Add Project': '添加项目',
  'Open Project': '打开项目',

  // Composer, Model & Usage Popups
  'Ask anything, @ to mention, / for actions': '输入任意内容，@ 引用上下文，/ 唤起操作',
  'Ask anything...': '输入任意内容…',
  Model: '模型',
  Models: '模型',
  'View Usage': '查看额度',
  Usage: '额度用量',
  'Gemini Models': 'Gemini 模型',
  'Claude and GPT models': 'Claude 与 GPT 模型',
  'Weekly limit': '每周限额',
  '5h limit': '5小时限额',
  'Daily limit': '每日限额',
  New: '新',
  Notice: '提示',
  Unavailable: '不可用',
  Turbo: '极速',
  Planning: '规划',
  Fast: '快速',
  Auto: '自动',
  Strict: '严格',
  'Request review': '请求审查',
  'Request Review': '请求审查',
  'Always Proceed': '始终继续',
  'Review Policy': '审查策略',
  Review: '审查',

  // Common Buttons, Tabs & Dialogs
  Accept: '接受',
  'Accept All': '全部接受',
  'Accept all': '全部接受',
  Reject: '拒绝',
  'Reject All': '全部拒绝',
  'Reject all': '全部拒绝',
  Approve: '批准',
  Allow: '允许',
  'Allow Once': '仅允许一次',
  'Always Allow': '始终允许',
  Deny: '拒绝',
  Cancel: '取消',
  Continue: '继续',
  Retry: '重试',
  Copy: '复制',
  Copied: '已复制',
  Edit: '编辑',
  Delete: '删除',
  Rename: '重命名',
  Save: '保存',
  Close: '关闭',
  Done: '完成',
  Apply: '应用',
  Reset: '重置',
  Refresh: '刷新',
  Install: '安装',
  Installed: '已安装',
  Uninstall: '卸载',
  Enable: '启用',
  Disable: '禁用',
  Enabled: '已启用',
  Disabled: '已禁用',
  Restart: '重启',
  Reload: '重新加载',
  Open: '打开',
  Show: '显示',
  Hide: '隐藏',
  More: '更多',
  Clear: '清除',
  Stop: '停止',
  Send: '发送',
  Submit: '提交',
  Confirm: '确认',
  Back: '返回',
  Next: '下一步',
  'Files Changed': '已修改文件',
  'No files changed': '暂无文件变更',
  'View diff': '查看差异',
  Terminal: '终端',
  Output: '输出',
  Problems: '问题',
  Browser: '浏览器',
  Preview: '预览',
  Artifacts: '产物',
  Swarm: '蜂群协作',
  Thinking: '思考中',
  Working: '执行中',
  Running: '运行中',
  Waiting: '等待中',
  Completed: '已完成',
  Failed: '已失败',
  Cancelled: '已取消',

  // Settings View
  General: '通用',
  Appearance: '外观',
  Theme: '主题',
  Dark: '深色',
  Light: '浅色',
  System: '跟随系统',
  Account: '账号',
  'Sign out': '退出登录',
  'Sign Out': '退出登录',
  'Sign in': '登录',
  'Sign In': '登录',
  Permissions: '权限',
  Security: '安全',
  Sandbox: '沙箱',
  Notifications: '通知',
  Sound: '提示音',
  'Keyboard Shortcuts': '快捷键',
  About: '关于',
  'Check for Updates': '检查更新',
  Updates: '更新',
  Privacy: '隐私',
  Advanced: '高级',
  Agent: '智能体',
  Editor: '编辑器',
  Workspace: '工作区',
  Extensions: '扩展',
  Tools: '工具',
  Network: '网络',
  Proxy: '代理',
  Logs: '日志',
  Diagnostics: '诊断',
});

function buildHostI18nApplyExpr() {
  return `(function(dict){
    if (!window.__agyMonI18n) {
      var origText = new Map();
      var origAttr = new Map();
      var hudId = ${JSON.stringify(HUD_ELEMENT_ID)};
      var SKIP_ANC = 'pre,code,textarea,input,script,style,svg,[contenteditable="true"],#' + hudId;

      function fmtDur(s) {
        return String(s || '')
          .replace(/(\\d+)\\s*d\\b/gi, '$1天')
          .replace(/(\\d+)\\s*h\\b/gi, '$1小时')
          .replace(/(\\d+)\\s*m\\b/gi, '$1分')
          .replace(/(\\d+)\\s*s\\b/gi, '$1秒')
          .replace(/\\s+/g, '');
      }

      function translateExact(raw) {
        if (!raw || raw.length > 96) return null;
        var trimmed = raw.trim();
        if (!trimmed) return null;
        if (Object.prototype.hasOwnProperty.call(dict, trimmed)) {
          return raw.replace(trimmed, dict[trimmed]);
        }
        var m;
        if ((m = /^(\\d+)\\s+files?\\s+changed$/i.exec(trimmed))) {
          return raw.replace(trimmed, m[1] + ' 个文件已变更');
        }
        if ((m = /^Thought for\\s+([\\d\\w\\s]+)$/i.exec(trimmed))) {
          return raw.replace(trimmed, '已思考 ' + fmtDur(m[1]));
        }
        if ((m = /^Worked for\\s+([\\d\\w\\s]+)$/i.exec(trimmed))) {
          return raw.replace(trimmed, '已工作 ' + fmtDur(m[1]));
        }
        if ((m = /^(\\d+)%\\s+left$/i.exec(trimmed))) {
          return raw.replace(trimmed, '剩余 ' + m[1] + '%');
        }
        if ((m = /^Resets in\\s+([\\d\\w\\s]+)$/i.exec(trimmed))) {
          return raw.replace(trimmed, fmtDur(m[1]) + ' 后重置');
        }
        if ((m = /^(\\d+)\\s*(?:secs?|s)\\s+ago$/i.exec(trimmed))) {
          return raw.replace(trimmed, m[1] + ' 秒前');
        }
        if ((m = /^(\\d+)\\s*(?:mins?|m)\\s+ago$/i.exec(trimmed))) {
          return raw.replace(trimmed, m[1] + ' 分钟前');
        }
        if ((m = /^(\\d+)\\s*(?:hours?|h)\\s+ago$/i.exec(trimmed))) {
          return raw.replace(trimmed, m[1] + ' 小时前');
        }
        if ((m = /^(\\d+)\\s*(?:days?|d)\\s+ago$/i.exec(trimmed))) {
          return raw.replace(trimmed, m[1] + ' 天前');
        }
        return null;
      }

      function processTextNode(node) {
        if (!node || node.nodeType !== 3) return;
        var parent = node.parentElement;
        if (!parent) return;
        if (parent.closest && parent.closest(SKIP_ANC)) return;
        var cur = node.nodeValue;
        var translated = translateExact(cur);
        if (translated && translated !== cur) {
          if (!origText.has(node)) origText.set(node, cur);
          node.nodeValue = translated;
        }
      }

      function processElementAttrs(el) {
        if (!el || el.nodeType !== 1) return;
        if (el.id === hudId || (el.closest && el.closest('#' + hudId))) return;
        var attrs = ['placeholder', 'aria-label', 'title'];
        for (var i = 0; i < attrs.length; i++) {
          var k = attrs[i];
          var val = el.getAttribute(k);
          if (!val) continue;
          var tr = translateExact(val);
          if (tr && tr !== val) {
            var rec = origAttr.get(el);
            if (!rec) {
              rec = {};
              origAttr.set(el, rec);
            }
            if (!Object.prototype.hasOwnProperty.call(rec, k)) rec[k] = val;
            el.setAttribute(k, tr);
          }
        }
      }

      function scanRoot(root) {
        if (!root) return;
        if (root.nodeType === 3) {
          processTextNode(root);
          return;
        }
        if (root.nodeType !== 1) return;
        if (root.id === hudId || (root.closest && root.closest('#' + hudId))) return;
        processElementAttrs(root);
        var phs = root.querySelectorAll ? root.querySelectorAll('[placeholder],[aria-label],[title]') : [];
        for (var i = 0; i < phs.length; i++) processElementAttrs(phs[i]);
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var tn;
        while ((tn = walker.nextNode())) {
          processTextNode(tn);
        }
      }

      var pending = new Set();
      var flushTimer = null;
      function pruneDisconnected() {
        if (origText.size > 400) {
          origText.forEach(function(_, node) {
            if (!node || !node.isConnected) origText.delete(node);
          });
        }
        if (origAttr.size > 200) {
          origAttr.forEach(function(_, el) {
            if (!el || !el.isConnected) origAttr.delete(el);
          });
        }
      }
      function flushPending() {
        flushTimer = null;
        var list = Array.from(pending);
        pending.clear();
        for (var i = 0; i < list.length; i++) {
          scanRoot(list[i]);
        }
        pruneDisconnected();
      }

      var observer = new MutationObserver(function(muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'characterData' && m.target) {
            pending.add(m.target);
          } else if (m.type === 'childList' && m.addedNodes) {
            for (var j = 0; j < m.addedNodes.length; j++) {
              pending.add(m.addedNodes[j]);
            }
          }
        }
        if (pending.size > 0 && !flushTimer) {
          flushTimer = setTimeout(flushPending, 60);
        }
      });

      if (document.body) {
        scanRoot(document.body);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }

      window.__agyHostI18nApplied = true;
      window.__agyMonI18n = {
        rescan: function() { if (document.body) scanRoot(document.body); },
        stop: function() {
          observer.disconnect();
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          pending.clear();
          origText.forEach(function(val, node) {
            try { if (node && node.isConnected) node.nodeValue = val; } catch (e) {}
          });
          origText.clear();
          origAttr.forEach(function(rec, el) {
            try {
              if (!el || !el.isConnected) return;
              Object.keys(rec).forEach(function(k) { el.setAttribute(k, rec[k]); });
            } catch (e) {}
          });
          origAttr.clear();
          delete window.__agyHostI18nApplied;
          delete window.__agyMonI18n;
        }
      };
    } else {
      window.__agyHostI18nApplied = true;
      window.__agyMonI18n.rescan();
    }
    return true;
  })(${JSON.stringify(HOST_UI_ZH_DICT)})`;
}

function buildHostI18nRestoreExpr() {
  return `(function(){
    if (window.__agyMonI18n && typeof window.__agyMonI18n.stop === 'function') {
      window.__agyMonI18n.stop();
    }
    return true;
  })()`;
}

/**
 * Create a lightweight multi-target CDP bridge that:
 * 1) Injects Scheme 2 pure-CSS wallpaper across ALL Antigravity app targets with self-discovering layer lifting;
 * 2) Renders a 120fps native inline composer HUD when CDP is connected (zero drag lag!);
 * 3) Provides reversible in-memory Chinese UI localization for Antigravity host without editing app.asar.
 */
export function createCdpThemeBridge(paths, { onHudStateChange = null } = {}) {
  /** @type {Map<string, { ws: WebSocket, wsUrl: string, title: string, url: string, type: string, cssApplied: boolean, hudInjected: boolean, hostLocalized: boolean }>} */
  const sessions = new Map();
  const connectingUrls = new Set();
  let lastError = '';
  let activePort = DEFAULT_CDP_PORT;
  let activeTransport = 'direct';
  let wslProxy = null;
  let cmdSeq = 1;
  let retryTimer = null;
  let retryTickCount = 0;
  let hudTickTimer = null;
  let latestThemes = null;
  let latestHostLanguage = 'zh-CN';
  let latestHudData = null;
  let lastActiveViewKey = '';
  let lastNotifiedHudInjected = false;
  let disposed = false;

  const notifyHudStateIfChanged = () => {
    const next = isHudInjected();
    if (next !== lastNotifiedHudInjected) {
      lastNotifiedHudInjected = next;
      try {
        onHudStateChange?.(next);
      } catch {
        // Ignore callback error
      }
    }
  };

  let cachedWpId = '';
  let cachedWpMtime = 0;
  let cachedWpDataUri = '';

  const closeAllSessions = () => {
    for (const entry of sessions.values()) {
      try {
        entry.ws.close();
      } catch {
        // ignore close error
      }
    }
    sessions.clear();
  };

  const hasOpenSessions = () => {
    for (const entry of sessions.values()) {
      if (entry.ws && entry.ws.readyState === 1) return true;
    }
    return false;
  };

  const isAnyStyleApplied = () => {
    for (const entry of sessions.values()) {
      if (entry.ws && entry.ws.readyState === 1 && entry.cssApplied) return true;
    }
    return false;
  };

  const isHudInjected = () => {
    for (const entry of sessions.values()) {
      if (entry.ws && entry.ws.readyState === 1 && entry.hudInjected) return true;
    }
    return false;
  };

  const isAnyHostLocalized = () => {
    for (const entry of sessions.values()) {
      if (entry.ws && entry.ws.readyState === 1 && entry.hostLocalized) return true;
    }
    return false;
  };

  const resolveWallpaperDataUri = async (themes) => {
    const wpId = typeof themes?.activeWallpaperId === 'string' ? themes.activeWallpaperId.trim() : '';
    if (!wpId) return '';

    let filePath = '';
    if (/^wp-\d+$/i.test(wpId) && paths?.wallpapersDir) {
      filePath = path.join(paths.wallpapersDir, `${path.basename(wpId)}.webp`);
    } else if (Array.isArray(themes?.customWallpapers) && paths?.customWallpapersDir) {
      const match = themes.customWallpapers.find((w) => w && w.id === wpId && w.filename);
      if (match) {
        filePath = path.join(paths.customWallpapersDir, path.basename(match.filename));
      }
    }
    if (!filePath) return '';

    try {
      const st = await fsp.stat(filePath);
      if (wpId === cachedWpId && st.mtimeMs === cachedWpMtime && cachedWpDataUri) {
        return cachedWpDataUri;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = EXT_TO_MIME.get(ext) || 'image/webp';
      const buf = await fsp.readFile(filePath);
      cachedWpId = wpId;
      cachedWpMtime = st.mtimeMs;
      cachedWpDataUri = `data:${mime};base64,${buf.toString('base64')}`;
      return cachedWpDataUri;
    } catch {
      return '';
    }
  };

  let cachedGuideMtime = -1;
  let cachedGuideDataUri = '';
  const resolveGuideImageDataUri = async () => {
    const filePath = paths?.assetsDir ? path.join(paths.assetsDir, 'open_console_guide.jpg') : '';
    if (!filePath) return '';
    try {
      const st = await fsp.stat(filePath);
      if (st.mtimeMs === cachedGuideMtime && cachedGuideDataUri) {
        return cachedGuideDataUri;
      }
      const buf = await fsp.readFile(filePath);
      cachedGuideMtime = st.mtimeMs;
      cachedGuideDataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
      return cachedGuideDataUri;
    } catch {
      return '';
    }
  };

  const sendEvaluateOn = (entry, expression) =>
    new Promise((resolve, reject) => {
      const sock = entry?.ws;
      if (!sock || sock.readyState !== 1) {
        reject(new Error('CDP WebSocket not open'));
        return;
      }
      const id = cmdSeq++;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        sock.removeEventListener?.('message', onMsg);
        sock.removeEventListener?.('close', onClose);
        sock.removeEventListener?.('error', onError);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const succeed = (val) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      };

      const timer = setTimeout(() => {
        fail(new Error('CDP evaluate timeout'));
      }, 1500);

      const onClose = () => fail(new Error('CDP WebSocket closed'));
      const onError = () => fail(new Error('CDP WebSocket error'));

      const onMsg = (evt) => {
        try {
          const parsed = JSON.parse(String(evt.data || ''));
          if (parsed.id === id) {
            if (parsed.error) {
              fail(new Error(parsed.error.message || 'CDP error'));
            } else if (parsed.result?.exceptionDetails) {
              const exMsg =
                parsed.result.exceptionDetails.exception?.description ||
                parsed.result.exceptionDetails.text ||
                'CDP evaluation exception';
              fail(new Error(exMsg));
            } else {
              succeed(parsed.result);
            }
          }
        } catch {
          // ignore non-matching frames
        }
      };

      sock.addEventListener('message', onMsg);
      sock.addEventListener('close', onClose);
      sock.addEventListener('error', onError);
      try {
        sock.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true },
          }),
        );
      } catch (err) {
        fail(err instanceof Error ? err : new Error('CDP send failed'));
      }
    });

  const openSession = (target) =>
    new Promise((resolve) => {
      const url = target.webSocketDebuggerUrl;
      if (disposed || !url) {
        resolve(null);
        return;
      }
      const existing = sessions.get(url);
      if (existing && existing.ws && existing.ws.readyState === 1) {
        existing.title = String(target.title || existing.title || '');
        resolve(existing);
        return;
      }
      if (connectingUrls.has(url)) {
        resolve(null);
        return;
      }
      connectingUrls.add(url);

      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        connectingUrls.delete(url);
        resolve(val);
      };

      try {
        const sock = new globalThis.WebSocket(url);
        const openTimer = setTimeout(() => {
          try {
            sock.close();
          } catch {
            // ignore
          }
          finish(null);
        }, 750);

        sock.addEventListener('open', () => {
          clearTimeout(openTimer);
          if (disposed) {
            try {
              sock.close();
            } catch {
              // ignore
            }
            finish(null);
            return;
          }
          const prev = sessions.get(url);
          if (prev && prev.ws && prev.ws !== sock) {
            try {
              prev.ws.close();
            } catch {
              // ignore
            }
          }
          const entry = {
            ws: sock,
            wsUrl: url,
            title: String(target.title || ''),
            url: String(target.url || ''),
            type: String(target.type || 'page'),
            cssApplied: false,
            hudInjected: false,
            hostLocalized: false,
          };
          sessions.set(url, entry);
          finish(entry);
        });

        sock.addEventListener('close', () => {
          clearTimeout(openTimer);
          const cur = sessions.get(url);
          if (cur && cur.ws === sock) {
            sessions.delete(url);
            notifyHudStateIfChanged();
          }
          finish(null);
        });

        sock.addEventListener('error', () => {
          clearTimeout(openTimer);
          finish(null);
        });
      } catch {
        finish(null);
      }
    });

  const fetchTargetsFrom = async (host, port, timeoutMs = 450) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${host}:${port}/json/list`, {
        signal: controller.signal,
        headers: { Connection: 'close' },
      });
      if (!res.ok) {
        return { ok: false, status: res.status, targets: [] };
      }
      const json = await res.json();
      return { ok: true, status: 200, targets: Array.isArray(json) ? json : [] };
    } catch {
      return { ok: false, status: 0, targets: [] };
    } finally {
      clearTimeout(timer);
    }
  };

  const closeWslProxy = () => {
    if (wslProxy) {
      try {
        wslProxy.close();
      } catch {
        // ignore
      }
      wslProxy = null;
    }
  };

  const ensureConnected = async (port) => {
    if (disposed || typeof globalThis.WebSocket !== 'function') {
      lastError = '当前 Node 环境缺少 WebSocket 客户端';
      return false;
    }

    const nextPort = clampInt(port, 1024, 65535, DEFAULT_CDP_PORT);
    if (wslProxy && wslProxy.targetPort !== nextPort) {
      closeWslProxy();
    }
    activePort = nextPort;
    const hostInfo = detectWindowsHostEnv();

    let targets = [];
    let wsRewriteHost = '';
    let wsRewritePort = 0;

    // Tier 1: Direct loopback (native Windows, WSL2 mirrored mode, or manual port forwarding)
    const directRes = await fetchTargetsFrom('127.0.0.1', activePort, hostInfo.isWsl ? 300 : 450);
    if (directRes.ok) {
      targets = directRes.targets;
      activeTransport = 'direct';
    } else if (hostInfo.isWsl && hostInfo.hasWindowsHost) {
      // Tier 2: WSL2 NAT zero-config Interop tunnel (reaches Windows 127.0.0.1:<port> with zero firewall/admin config)
      if (!wslProxy) {
        wslProxy = await createWslCdpLocalProxy(activePort, { hostInfo }).catch(() => null);
      }
      let tunnelOk = false;
      if (wslProxy && wslProxy.localPort > 0) {
        const tunRes = await fetchTargetsFrom('127.0.0.1', wslProxy.localPort, 1800);
        if (tunRes.ok) {
          targets = tunRes.targets;
          wsRewriteHost = '127.0.0.1';
          wsRewritePort = wslProxy.localPort;
          activeTransport = 'wsl_tunnel';
          tunnelOk = true;
        }
      }

      // Tier 3: Fallback to WSL2 NAT Windows gateway IP (if user bound --remote-debugging-address=0.0.0.0)
      if (!tunnelOk) {
        const gwIp = resolveWslGatewayIp();
        if (gwIp) {
          const gwRes = await fetchTargetsFrom(gwIp, activePort, 450);
          if (gwRes.ok) {
            targets = gwRes.targets;
            wsRewriteHost = gwIp;
            wsRewritePort = activePort;
            activeTransport = 'wsl_gateway';
            tunnelOk = true;
          }
        }
      }

      if (!tunnelOk) {
        lastError = `未检测到 Windows 侧 CDP 端口 ${activePort}（WSL2 NAT 已自动启用桥接，请用调试参数启动 Windows 版 Antigravity）`;
        return false;
      }
    } else {
      lastError =
        directRes.status > 0
          ? `CDP 端口 ${activePort} 返回 HTTP ${directRes.status}`
          : `未检测到本地 CDP 端口 ${activePort}`;
      return false;
    }

    const matched = targets
      .filter(isAntigravityAppTarget)
      .map((t) =>
        wsRewriteHost && wsRewritePort
          ? {
              ...t,
              webSocketDebuggerUrl: rewriteTargetWsUrl(
                t.webSocketDebuggerUrl,
                activePort,
                wsRewriteHost,
                wsRewritePort,
              ),
            }
          : t,
      );
    if (matched.length === 0) {
      lastError = `端口 ${activePort} 上未找到 Antigravity 主窗口目标`;
      return false;
    }

    const liveUrls = new Set(matched.map((t) => t.webSocketDebuggerUrl));
    for (const [u, entry] of sessions.entries()) {
      if (!liveUrls.has(u) || entry.ws.readyState !== 1) {
        try {
          entry.ws.close();
        } catch {
          // ignore
        }
        sessions.delete(u);
      }
    }

    await Promise.allSettled(matched.map((t) => openSession(t)));
    if (!hasOpenSessions()) {
      lastError = '连接 CDP WebSocket 超时';
      return false;
    }

    lastError = '';
    return true;
  };

  const applyCssAll = async (cssText) => {
    const expr = buildApplyThemeAndScanExpr(cssText);
    await Promise.allSettled(
      [...sessions.values()].map(async (entry) => {
        if (entry.ws.readyState !== 1) return;
        await sendEvaluateOn(entry, expr);
        entry.cssApplied = true;
      }),
    );
  };

  const removeCssAll = async () => {
    const expr = buildRemoveThemeExpr();
    await Promise.allSettled(
      [...sessions.values()].map(async (entry) => {
        if (entry.ws.readyState === 1) {
          await sendEvaluateOn(entry, expr).catch(() => {});
        }
        entry.cssApplied = false;
      }),
    );
  };

  const maybeWriteActiveView = async (view, { focused = true } = {}) => {
    if (!view || !paths?.hudActiveViewFile) return;
    if (sessions.size > 1 && !focused) return;
    const isNewConv = Boolean(view.isNewConversation);
    const title = String(view.title || '').trim();
    const workspace = String(view.workspace || '').trim();
    if (!isNewConv && (!title || title.length < 2)) return;
    const key = isNewConv ? '__new_conversation__' : `${workspace}|${title}`;
    if (key === lastActiveViewKey) return;

    // Preserve recent explicit sidecar_focus selections from being clobbered by title-only DOM reads
    try {
      const existingRaw = await fsp.readFile(paths.hudActiveViewFile, 'utf8');
      const existing = JSON.parse(existingRaw);
      if (
        existing &&
        existing.source === 'sidecar_focus' &&
        typeof existing.conversationId === 'string' &&
        existing.conversationId.trim()
      ) {
        const ageMs = Date.now() - Number(existing.updatedAtMs || 0);
        if (ageMs >= 0 && ageMs < 3000) {
          return;
        }
        if (!isNewConv && String(existing.title || '').trim().toLowerCase() === title.toLowerCase()) {
          lastActiveViewKey = key;
          return;
        }
      }
    } catch {
      // ignore missing/corrupt active view file
    }

    lastActiveViewKey = key;
    await atomicWriteJson(paths.hudActiveViewFile, {
      workspace,
      title,
      isNewConversation: isNewConv,
      source: 'cdp_header',
      updatedAtMs: Date.now(),
    }).catch(() => {});
  };

  const readHudDisplayConfig = async () => {
    if (!paths?.hudDisplayFile) return normalizeHudDisplayConfig(null);
    try {
      const raw = await fsp.readFile(paths.hudDisplayFile, 'utf8');
      return normalizeHudDisplayConfig(JSON.parse(raw));
    } catch {
      return normalizeHudDisplayConfig(null);
    }
  };

  const syncHudAll = async () => {
    if (disposed || !hasOpenSessions()) {
      notifyHudStateIfChanged();
      return false;
    }
    const hudEnabled = latestThemes?.hudEnabled !== false;
    if (!hudEnabled) {
      const rem = buildRemoveHudExpr();
      await Promise.allSettled(
        [...sessions.values()].map(async (entry) => {
          if (entry.ws.readyState === 1) {
            await sendEvaluateOn(entry, rem).catch(() => {});
          }
          entry.hudInjected = false;
        }),
      );
      notifyHudStateIfChanged();
      return false;
    }

    const accent = latestThemes?.colors?.accent || '#5b8cff';
    const displayCfg = await readHudDisplayConfig();
    const guideDataUri = await resolveGuideImageDataUri();
    const expr = buildHudSyncExpr(latestHudData || {}, accent, displayCfg, guideDataUri);
    let anyInjected = false;
    let latestPatch = null;
    await Promise.allSettled(
      [...sessions.values()].map(async (entry) => {
        if (entry.ws.readyState !== 1) return;
        const res = await sendEvaluateOn(entry, expr).catch(() => null);
        const val = res?.result?.value;
        entry.hudInjected = Boolean(val?.hudInjected);
        if (entry.hudInjected) anyInjected = true;
        if (val?.activeView) {
          await maybeWriteActiveView(val.activeView, { focused: val?.focused !== false });
        }
        if (val?.displayPatch && typeof val.displayPatch === 'object') {
          const normPatch = normalizeHudDisplayConfig(val.displayPatch);
          if (!latestPatch || normPatch.updatedAtMs >= latestPatch.updatedAtMs) {
            latestPatch = normPatch;
          }
        }
      }),
    );
    if (latestPatch && paths?.hudDisplayFile) {
      await atomicWriteJson(paths.hudDisplayFile, latestPatch).catch(() => {});
    }
    notifyHudStateIfChanged();
    return anyInjected;
  };

  const removeHudAll = async () => {
    const rem = buildRemoveHudExpr();
    await Promise.allSettled(
      [...sessions.values()].map(async (entry) => {
        if (entry.ws.readyState === 1) {
          await sendEvaluateOn(entry, rem).catch(() => {});
        }
        entry.hudInjected = false;
      }),
    );
    notifyHudStateIfChanged();
  };

  const applyHostI18nAll = async () => {
    const expr = buildHostI18nApplyExpr();
    await Promise.allSettled(
      [...sessions.values()].map(async (entry) => {
        if (entry.ws.readyState !== 1) return;
        try {
          await sendEvaluateOn(entry, expr);
          entry.hostLocalized = true;
        } catch {
          entry.hostLocalized = false;
        }
      }),
    );
  };

  const restoreHostI18nAll = async () => {
    const expr = buildHostI18nRestoreExpr();
    await Promise.allSettled(
      [...sessions.values()].map(async (entry) => {
        if (entry.ws.readyState === 1) {
          await sendEvaluateOn(entry, expr).catch(() => {});
        }
        entry.hostLocalized = false;
      }),
    );
  };

  const applyCurrentHostLang = async () => {
    if (!hasOpenSessions()) return;
    if (latestHostLanguage === 'zh-CN') {
      await applyHostI18nAll();
    } else {
      await restoreHostI18nAll();
    }
  };

  const probeSessionMarkers = async (needCss, needI18n) => {
    const probeExpr = `(function(){ return { hasCss: Boolean(document.getElementById(${JSON.stringify(STYLE_ELEMENT_ID)})), hasI18n: Boolean(window.__agyHostI18nApplied) }; })()`;
    let needsResync = false;
    await Promise.allSettled(
      [...sessions.values()].map(async (entry) => {
        if (entry.ws.readyState !== 1) return;
        const res = await sendEvaluateOn(entry, probeExpr).catch(() => null);
        const val = res?.result?.value;
        if (!val) return;
        if (needCss && !val.hasCss) {
          entry.cssApplied = false;
          needsResync = true;
        }
        if (needI18n && !val.hasI18n) {
          entry.hostLocalized = false;
          needsResync = true;
        }
      }),
    );
    return needsResync;
  };

  const ensureLoops = (wantCdp) => {
    if (wantCdp && !retryTimer && !disposed) {
      retryTimer = setInterval(() => {
        if (disposed || !latestThemes) return;
        const stillWant =
          latestThemes.hostThemeMode === 'cdp' ||
          (hasOpenSessions() && latestHostLanguage === 'zh-CN');
        if (!stillWant) {
          clearInterval(retryTimer);
          retryTimer = null;
          return;
        }
        retryTickCount += 1;
        const needCss =
          latestThemes.hostThemeMode === 'cdp' &&
          Boolean(latestThemes.backdropEnabled) &&
          Boolean(latestThemes.activeWallpaperId);
        const needI18n = latestHostLanguage === 'zh-CN';
        if (!hasOpenSessions() || (needCss && !isAnyStyleApplied()) || (needI18n && !isAnyHostLocalized())) {
          void sync(latestThemes, { hostLanguage: latestHostLanguage });
          return;
        }
        // Periodically detect newly opened windows & Ctrl+R page reloads whose DOM lost injected nodes
        if (retryTickCount % 3 === 0) {
          void (async () => {
            const lostMarkers = await probeSessionMarkers(needCss, needI18n);
            if (disposed || !latestThemes) return;
            if (lostMarkers) {
              await sync(latestThemes, { hostLanguage: latestHostLanguage });
              return;
            }
            const prevCount = sessions.size;
            const ok = await ensureConnected(activePort);
            if (!disposed && ok && sessions.size > prevCount) {
              await sync(latestThemes, { hostLanguage: latestHostLanguage });
            }
          })();
        }
      }, 2200);
      if (typeof retryTimer.unref === 'function') retryTimer.unref();
    } else if (!wantCdp && retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
      retryTickCount = 0;
    }

    if (wantCdp && !hudTickTimer && !disposed) {
      hudTickTimer = setInterval(() => {
        if (disposed || !hasOpenSessions()) return;
        if (latestThemes?.hostThemeMode === 'cdp') {
          void syncHudAll();
        }
      }, 900);
      if (typeof hudTickTimer.unref === 'function') hudTickTimer.unref();
    } else if (!wantCdp && hudTickTimer) {
      clearInterval(hudTickTimer);
      hudTickTimer = null;
    }
  };

  const updateHudData = async (hudPayload) => {
    latestHudData = hudPayload || null;
    if (disposed || !hasOpenSessions() || latestThemes?.hostThemeMode !== 'cdp') return false;
    return await syncHudAll();
  };

  const sync = async (themes = {}, options = {}) => {
    if (disposed) return getStatus(themes);
    latestThemes = themes;
    if (options.hostLanguage === 'zh-CN' || options.hostLanguage === 'en') {
      latestHostLanguage = options.hostLanguage;
    }
    const port = clampInt(themes.cdpPort, 1024, 65535, DEFAULT_CDP_PORT);
    if (port !== activePort && sessions.size > 0) {
      await restoreHostI18nAll().catch(() => {});
      await removeCssAll().catch(() => {});
      await removeHudAll().catch(() => {});
      closeAllSessions();
    }
    activePort = port;
    await ensureCdpLauncher(paths, port);

    const isCdpMode = themes.hostThemeMode === 'cdp';
    const wantCdpCss =
      isCdpMode &&
      Boolean(themes.backdropEnabled) &&
      Boolean(themes.activeWallpaperId);
    const shouldConnect = isCdpMode || Boolean(options.probeForLang) || hasOpenSessions();

    if (!shouldConnect) {
      ensureLoops(false);
      return getStatus(themes);
    }

    const ok = await ensureConnected(port);
    ensureLoops(isCdpMode || (hasOpenSessions() && latestHostLanguage === 'zh-CN'));
    if (!ok) {
      return getStatus(themes);
    }

    try {
      if (wantCdpCss) {
        const dataUri = await resolveWallpaperDataUri(themes);
        if (!dataUri) {
          await removeCssAll();
        } else {
          const css = buildCdpThemeCss(themes, dataUri);
          await applyCssAll(css);
        }
      } else {
        await removeCssAll();
      }

      if (isCdpMode) {
        await syncHudAll();
      } else {
        await removeHudAll();
      }

      await applyCurrentHostLang();
    } catch (err) {
      lastError = err?.message || 'CDP 样式应用失败';
    }
    return getStatus(themes);
  };

  const syncHostLanguage = async (language, themes = latestThemes || {}) => {
    latestHostLanguage = language === 'en' ? 'en' : 'zh-CN';
    return await sync(themes, { hostLanguage: latestHostLanguage, probeForLang: true });
  };

  const getStatus = (themes = latestThemes || {}) => {
    const hostInfo = detectWindowsHostEnv();
    const port = clampInt(themes?.cdpPort, 1024, 65535, activePort || DEFAULT_CDP_PORT);
    const exePath = cachedLauncherSnapshot?.exePath || findAntigravityExePath();
    const connected = hasOpenSessions();
    let title = '';
    for (const entry of sessions.values()) {
      if (entry.ws.readyState === 1 && entry.title) {
        title = entry.title;
        break;
      }
    }
    const lnkPath = cachedLauncherSnapshot?.shortcutLnkPath || paths?.cdpShortcutLnk || '';
    const vbsPath = cachedLauncherSnapshot?.launcherVbsPath || paths?.cdpLauncherVbs || '';
    const cmdPath = cachedLauncherSnapshot?.launcherCmdPath || paths?.cdpLauncherCmd || '';
    return {
      supported: hostInfo.hasWindowsHost,
      isWsl: hostInfo.isWsl,
      transport: activeTransport,
      port,
      connected,
      targetCount: sessions.size,
      styleApplied: Boolean(connected && isAnyStyleApplied()),
      hudInjected: Boolean(connected && isHudInjected()),
      hostLanguage: latestHostLanguage,
      hostLocalized: Boolean(connected && isAnyHostLocalized()),
      targetTitle: connected ? title : '',
      shortcutLnkPath: lnkPath,
      launcherVbsPath: vbsPath,
      launcherCmdPath: cmdPath,
      launchCommand:
        cachedLauncherSnapshot?.launchCommand ||
        (vbsPath
          ? `wscript.exe //Nologo "${vbsPath}"`
          : exePath
            ? `"${exePath}" --remote-debugging-port=${port}`
            : ''),
      lastError: connected ? '' : lastError,
    };
  };

  const dispose = async () => {
    disposed = true;
    ensureLoops(false);
    await restoreHostI18nAll().catch(() => {});
    await removeCssAll().catch(() => {});
    await removeHudAll().catch(() => {});
    closeAllSessions();
    closeWslProxy();
  };

  return {
    sync,
    syncHostLanguage,
    updateHudData,
    isHudInjected,
    getStatus,
    dispose,
  };
}
