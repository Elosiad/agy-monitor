import { mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');

const PLUGIN_NAME = 'agy-monitor';
const SIDECAR_NAME = 'agy_monitor';

/**
 * Derive Antigravity's appData directory and optional sidecarData directory
 * from ANTIGRAVITY_EXECUTABLE_DATA_DIR when launched by the host.
 * Under Antigravity, ANTIGRAVITY_EXECUTABLE_DATA_DIR is typically
 * `<appData>/sidecar_data/<plugin>/<sidecar>/data`.
 */
function inferFromExecutableDataDir(rawDir) {
  if (!rawDir) {
    return { appDataDir: null, sidecarDataDir: null };
  }
  const resolved = path.resolve(rawDir);
  let cursor = resolved;
  while (cursor && cursor !== path.dirname(cursor)) {
    if (path.basename(cursor) === 'sidecar_data') {
      return {
        appDataDir: path.dirname(cursor),
        sidecarDataDir: resolved,
      };
    }
    cursor = path.dirname(cursor);
  }
  return {
    appDataDir: resolved,
    sidecarDataDir: null,
  };
}

/**
 * Resolve all filesystem paths used by the agy_monitor sidecar.
 * Supports explicit overrides (for isolated unit tests) and AGY_MONITOR_* env vars.
 */
export function resolvePaths(overrides = {}) {
  const pluginRoot = path.resolve(overrides.pluginRoot || DEFAULT_PLUGIN_ROOT);
  const envExecDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  const inferred = inferFromExecutableDataDir(envExecDataDir);

  const defaultAppData = path.join(os.homedir(), '.gemini', 'antigravity');
  const appDataDir = path.resolve(
    overrides.appDataDir ||
      process.env.AGY_MONITOR_APP_DATA_DIR ||
      inferred.appDataDir ||
      defaultAppData,
  );

  const geminiConfigDir = path.resolve(
    overrides.geminiConfigDir ||
      process.env.AGY_MONITOR_CONFIG_DIR ||
      path.join(os.homedir(), '.gemini', 'config'),
  );

  const pluginDataDir = path.resolve(
    overrides.pluginDataDir ||
      process.env.AGY_MONITOR_PLUGIN_DATA_DIR ||
      path.join(appDataDir, 'plugin_data', PLUGIN_NAME),
  );

  const sidecarDataDir = path.resolve(
    overrides.sidecarDataDir ||
      process.env.AGY_MONITOR_SIDECAR_DATA_DIR ||
      inferred.sidecarDataDir ||
      path.join(appDataDir, 'sidecar_data', PLUGIN_NAME, SIDECAR_NAME, 'data'),
  );

  const brainDir = path.resolve(
    overrides.brainDir ||
      process.env.AGY_MONITOR_BRAIN_DIR ||
      path.join(appDataDir, 'brain'),
  );

  const customWallpapersDir = path.resolve(
    overrides.customWallpapersDir || path.join(pluginDataDir, 'wallpapers'),
  );

  const telemetryCacheDb = path.resolve(
    overrides.telemetryCacheDb ||
      overrides.cacheDbPath ||
      process.env.AGY_MONITOR_CACHE_DB ||
      path.join(sidecarDataDir, 'telemetry_cache.db'),
  );
  const rulesFile = path.resolve(
    overrides.rulesFile ||
      overrides.agentsMdPath ||
      path.join(pluginRoot, 'rules', 'AGENTS.md'),
  );
  const hostConfigJson = path.resolve(
    overrides.hostConfigJson ||
      overrides.hostConfigPath ||
      path.join(geminiConfigDir, 'config.json'),
  );
  const summariesDb = path.resolve(
    overrides.summariesDb ||
      overrides.summariesDbPath ||
      path.join(appDataDir, 'conversation_summaries.db'),
  );

  const paths = {
    pluginRoot,
    rulesDir: path.join(pluginRoot, 'rules'),
    rulesFile,
    agentsMdPath: rulesFile,
    assetsDir: path.resolve(overrides.assetsDir || path.join(pluginRoot, 'assets')),
    wallpapersDir: path.resolve(overrides.wallpapersDir || path.join(pluginRoot, 'assets', 'wallpapers')),
    frontendDir: path.resolve(overrides.frontendDir || path.join(pluginRoot, 'sidecars', SIDECAR_NAME, 'frontend')),
    backdropSourceFile: path.resolve(
      overrides.backdropSourceFile ||
        path.join(pluginRoot, 'sidecars', SIDECAR_NAME, 'backdrop', 'AgyBackdrop.cs'),
    ),

    appDataDir,
    geminiConfigDir,
    hostConfigJson,
    hostConfigPath: hostConfigJson,

    pluginDataDir,
    customWallpapersDir,
    backdropBinDir: path.join(pluginDataDir, 'bin'),
    backdropExeFile: path.join(pluginDataDir, 'bin', 'agy_backdrop.exe'),
    backdropHashFile: path.join(pluginDataDir, 'bin', 'agy_backdrop.sha1'),
    backdropStatusFile: path.join(pluginDataDir, 'backdrop_status.json'),
    lightboxCmdFile: path.join(pluginDataDir, 'lightbox_cmd.json'),
    hudTelemetryFile: path.join(pluginDataDir, 'hud_telemetry.json'),
    hudActiveViewFile: path.join(pluginDataDir, 'hud_active_view.json'),
    backdropLauncherVbs: path.join(pluginDataDir, 'launch_backdrop.vbs'),
    backdropLauncherCmd: path.join(pluginDataDir, '启动整机壁纸伴侣.cmd'),
    cdpLauncherVbs: path.join(pluginDataDir, 'launch_antigravity_cdp.vbs'),
    cdpLauncherCmd: path.join(pluginDataDir, '启动_Antigravity_高清壁纸模式_CDP.cmd'),
    cdpShortcutLnk: path.join(pluginDataDir, 'Antigravity (高清壁纸).lnk'),
    userPrefsFile: path.join(pluginDataDir, 'user_prefs.json'),
    sessionsMetaFile: path.join(pluginDataDir, 'sessions_meta.json'),
    themesFile: path.join(pluginDataDir, 'themes.json'),
    customPresetsFile: path.join(pluginDataDir, 'presets_custom.json'),
    quotaAnchorsFile: path.join(pluginDataDir, 'quota_anchors.json'),
    masteryConfigFile: path.join(pluginDataDir, 'mastery_config.json'),
    masteryHookStateFile: path.join(pluginDataDir, 'mastery_hook_state.json'),
    masterySummariesFile: path.join(pluginDataDir, 'mastery_summaries.json'),

    sidecarDataDir,
    telemetryCacheDb,
    cacheDbPath: telemetryCacheDb,

    brainDir,
    summariesDb,
    summariesDbPath: summariesDb,
    pbtxtPath: path.resolve(overrides.pbtxtPath || path.join(appDataDir, 'antigravity_state.pbtxt')),
  };

  if (overrides.createDirs !== false) {
    mkdirSync(paths.pluginDataDir, { recursive: true });
    mkdirSync(paths.customWallpapersDir, { recursive: true });
    mkdirSync(paths.sidecarDataDir, { recursive: true });
  }

  return paths;
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(tmpPath, targetPath, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fs.rename(tmpPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_RENAME_CODES.has(err?.code) || i === attempts - 1) {
        throw err;
      }
      await sleep(20 * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * Atomically write raw Buffer content via sibling temp file + rename.
 */
export async function atomicWriteBuffer(filePath, buffer) {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = `${target}.tmp.${suffix}`;

  try {
    await fs.writeFile(tmpPath, buffer);
    await renameWithRetry(tmpPath, target);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Atomically write UTF-8 text via sibling temp file + rename.
 */
export async function atomicWriteText(filePath, text) {
  const payload = Buffer.from(String(text ?? ''), 'utf8');
  await atomicWriteBuffer(filePath, payload);
}

/**
 * Atomically write JSON data (pretty-printed with trailing newline).
 */
export async function atomicWriteJson(filePath, obj) {
  const serialized = `${JSON.stringify(obj, null, 2)}\n`;
  await atomicWriteText(filePath, serialized);
}
