/**
 * Safe GitHub update checker & one-click in-place updater for AGY Console (agy-monitor).
 *
 * - Strictly allowlisted to the official repository (zero arbitrary URL downloads).
 * - Zero npm dependencies (uses Node.js >= 22.5 built-in fetch + OS archive tools with shell: false).
 * - Preserves all user settings (plugin_data/agy-monitor/*.json) and rules/AGENTS.md.
 * - Single-flight update lock prevents concurrent overwrite races.
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { proxyAwareFetch } from './accounts.mjs';
import { ensureBackdropAssets } from './backdrop_manager.mjs';
import { atomicWriteJson } from './paths.mjs';
import { detectWindowsHostEnv } from './wsl_bridge.mjs';

export const REPO_OWNER = 'aishadiaodeqishui';
export const REPO_NAME = 'agy-monitor';
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
const GITHUB_COMMIT_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/main`;
const GITHUB_RELEASE_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const GITHUB_RELEASES_LIST_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=30`;
const GITHUB_ARCHIVE_ZIP_URL = `https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/zip/refs/heads/main`;

function buildTagArchiveZipUrl(cleanSemver) {
  return `https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/zip/refs/tags/v${cleanSemver}`;
}

export function parseStrictSemver(raw) {
  const m = String(raw || '').trim().match(/^v?(\d+\.\d+\.\d+)$/i);
  return m ? m[1] : '';
}

const CHECK_CACHE_TTL_MS = 10 * 60 * 1000;
const MIN_ARCHIVE_BYTES = 10 * 1024;
const MAX_ARCHIVE_BYTES = 30 * 1024 * 1024;

const ROOT_FILES = ['plugin.json', 'package.json', 'hooks.json', 'mcp_config.json', 'README.md'];
const OPTIONAL_ROOT_FILES = new Set(['mcp_config.json']);
const MIRROR_DIRS = ['assets', 'sidecars', 'hooks', 'skills'];
const REQUIRED_CORE_FILES = [
  'plugin.json',
  'hooks.json',
  'hooks/mastery_summary_hook.mjs',
  'sidecars/agy_monitor/sidecar.json',
  'sidecars/agy_monitor/main.mjs',
];

const checkCache = new Map();
const releasesCache = new Map();
let updateInFlight = null;

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function compareSemver(a, b) {
  const parse = (v) =>
    String(v || '0.0.0')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function readJsonSyncSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function readLocalInstallState(paths) {
  const pluginRoot = paths?.pluginRoot || '';
  const pluginDataDir = paths?.pluginDataDir || '';

  const manifest = pluginRoot ? readJsonSyncSafe(path.join(pluginRoot, 'plugin.json')) : null;
  const currentVersion =
    typeof manifest?.version === 'string' && manifest.version.trim()
      ? manifest.version.trim().replace(/^v/i, '')
      : '1.0.0';

  const metaPath = pluginDataDir ? path.join(pluginDataDir, 'install_meta.json') : '';
  const meta = metaPath ? readJsonSyncSafe(metaPath) : null;
  const metaVersion =
    typeof meta?.version === 'string' && meta.version.trim()
      ? meta.version.trim().replace(/^v/i, '')
      : '';
  // Discard stale install_meta.json commitSha when plugin.json was upgraded locally (e.g. via sync/installer)
  const metaStale = Boolean(metaVersion && compareSemver(currentVersion, metaVersion) > 0);
  const localFullSha =
    !metaStale && typeof meta?.commitSha === 'string' && /^[0-9a-f]{7,40}$/i.test(meta.commitSha.trim())
      ? meta.commitSha.trim().toLowerCase()
      : '';

  let localNewestMtimeMs = metaStale ? 0 : Number(meta?.updatedAtMs || 0);
  if (pluginRoot) {
    const probes = [
      path.join(pluginRoot, 'plugin.json'),
      path.join(pluginRoot, 'sidecars', 'agy_monitor', 'main.mjs'),
      path.join(pluginRoot, 'sidecars', 'agy_monitor', 'frontend', 'components', 'mastery_hub.js'),
      path.join(pluginRoot, 'sidecars', 'agy_monitor', 'backdrop', 'AgyBackdrop.cs'),
    ];
    for (const p of probes) {
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs > localNewestMtimeMs) localNewestMtimeMs = st.mtimeMs;
      } catch {
        // ignore missing probe file
      }
    }
  }

  return {
    currentVersion,
    localFullSha,
    localSha: localFullSha ? localFullSha.slice(0, 7) : '',
    localNewestMtimeMs,
    metaPath,
  };
}

function mirrorDirectoryInPlace(srcDir, destDir) {
  const srcExists = fs.existsSync(srcDir);
  const destStat = fs.lstatSync(destDir, { throwIfNoEntry: false });
  if (!srcExists) {
    if (destStat) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    return;
  }
  if (destStat && !destStat.isDirectory()) {
    fs.unlinkSync(destDir);
  }
  fs.mkdirSync(destDir, { recursive: true });

  const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((e) => e.name));

  for (const destEntry of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!srcNames.has(destEntry.name)) {
      fs.rmSync(path.join(destDir, destEntry.name), { recursive: true, force: true });
    }
  }

  for (const srcEntry of srcEntries) {
    if (srcEntry.isSymbolicLink()) continue;
    const srcChild = path.join(srcDir, srcEntry.name);
    const destChild = path.join(destDir, srcEntry.name);
    if (srcEntry.isDirectory()) {
      mirrorDirectoryInPlace(srcChild, destChild);
    } else {
      const destChildStat = fs.lstatSync(destChild, { throwIfNoEntry: false });
      if (destChildStat && destChildStat.isDirectory()) {
        fs.rmSync(destChild, { recursive: true, force: true });
      }
      fs.copyFileSync(srcChild, destChild);
    }
  }
}

async function fetchJsonWithTimeout(fetchImpl, url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agy-monitor-updater',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, data: null };
    }
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check GitHub main branch & latest release against local installed state.
 */
export async function checkForUpdates(
  paths,
  { force = false, fetchImpl = proxyAwareFetch, nowMs = Date.now() } = {},
) {
  const cacheKey = paths?.pluginRoot || 'default';
  const cached = checkCache.get(cacheKey);
  if (!force && cached && nowMs - cached.checkedAtMs < CHECK_CACHE_TTL_MS) {
    return { ...cached, cached: true };
  }

  const local = readLocalInstallState(paths);
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      repoUrl: REPO_URL,
      currentVersion: local.currentVersion,
      localSha: local.localSha,
      hasUpdate: false,
      error: '当前运行环境不支持网络检测',
      checkedAtMs: nowMs,
    };
  }

  try {
    const [commitRes, releaseRes] = await Promise.all([
      fetchJsonWithTimeout(fetchImpl, GITHUB_COMMIT_API, 7000),
      fetchJsonWithTimeout(fetchImpl, GITHUB_RELEASE_API, 6000).catch(() => ({ ok: false, data: null })),
    ]);

    if (!commitRes.ok || !commitRes.data?.sha) {
      const rateLimited = commitRes.status === 403 || commitRes.status === 429;
      return {
        ok: false,
        repoUrl: REPO_URL,
        currentVersion: local.currentVersion,
        localSha: local.localSha,
        hasUpdate: false,
        error: rateLimited ? 'GitHub 接口限流，请稍后再试' : '无法获取远程版本信息',
        checkedAtMs: nowMs,
      };
    }

    const remoteFullSha = String(commitRes.data.sha || '').trim().toLowerCase();
    const remoteSha = remoteFullSha.slice(0, 7);
    const remoteDate = String(
      commitRes.data?.commit?.committer?.date || commitRes.data?.commit?.author?.date || '',
    );
    const remoteDateMs = Date.parse(remoteDate) || 0;
    const rawMsg = String(commitRes.data?.commit?.message || '').trim();
    const remoteMessage = rawMsg.split(/\r?\n/)[0].slice(0, 120);

    const releaseTag =
      releaseRes?.ok && typeof releaseRes.data?.tag_name === 'string'
        ? releaseRes.data.tag_name.trim().replace(/^v/i, '')
        : '';
    const remoteVersion = releaseTag || local.currentVersion;

    let hasUpdate = false;
    if (releaseTag) {
      // Official release tag exists: strictly follow semver ordering so same-version docs commits
      // or local developer versions ahead of remote NEVER falsely trigger an update prompt.
      hasUpdate = compareSemver(releaseTag, local.currentVersion) > 0;
    } else {
      // Fallback when repository has no releases yet: require strictly newer remote commit timestamp
      const shaDiffers = Boolean(
        !local.localFullSha ||
          (remoteFullSha.length >= 7 &&
            !remoteFullSha.startsWith(local.localFullSha) &&
            !local.localFullSha.startsWith(remoteFullSha)),
      );
      if (shaDiffers && remoteDateMs > 0 && local.localNewestMtimeMs > 0) {
        hasUpdate = remoteDateMs > local.localNewestMtimeMs + 120_000;
      }
    }
    const payload = {
      ok: true,
      repoUrl: REPO_URL,
      currentVersion: local.currentVersion,
      localSha: local.localSha,
      remoteVersion,
      remoteSha,
      remoteFullSha,
      remoteDate,
      remoteMessage,
      hasUpdate,
      checkedAtMs: nowMs,
    };
    checkCache.set(cacheKey, payload);
    return payload;
  } catch (err) {
    return {
      ok: false,
      repoUrl: REPO_URL,
      currentVersion: local.currentVersion,
      localSha: local.localSha,
      hasUpdate: false,
      error: err?.name === 'AbortError' ? '连接 GitHub 超时，点击重试' : '无法连接 GitHub，点击重试',
      checkedAtMs: nowMs,
    };
  }
}

async function extractZipArchive(zipPath, extractDir, { platform = process.platform, execFileImpl = execFileAsync } = {}) {
  await fsp.mkdir(extractDir, { recursive: true });
  if (platform === 'win32') {
    try {
      await execFileImpl('tar.exe', ['-xf', zipPath, '-C', extractDir], { timeout: 25000 });
      return;
    } catch {
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(extractDir, { recursive: true });
      await execFileImpl(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
        ],
        { timeout: 30000 },
      );
      return;
    }
  }
  try {
    await execFileImpl('unzip', ['-q', '-o', zipPath, '-d', extractDir], { timeout: 25000 });
  } catch {
    await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(extractDir, { recursive: true });
    await execFileImpl('python3', ['-m', 'zipfile', '-e', zipPath, extractDir], { timeout: 25000 });
  }
}

function resolveExtractedPluginRoot(extractDir) {
  if (fs.existsSync(path.join(extractDir, 'plugin.json'))) {
    return extractDir;
  }
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const cand = path.join(extractDir, e.name);
    if (fs.existsSync(path.join(cand, 'plugin.json'))) {
      return cand;
    }
  }
  return '';
}

/**
 * List official GitHub releases for the Changelog modal so newer versions can be
 * discovered and upgraded directly from the announcement dialog.
 */
export async function listOfficialReleases(
  paths,
  { force = false, fetchImpl = proxyAwareFetch, nowMs = Date.now() } = {},
) {
  const local = readLocalInstallState(paths);
  const cacheKey = paths?.pluginRoot || 'default';
  const cached = releasesCache.get(cacheKey);
  if (!force && cached && nowMs - cached.fetchedAtMs < CHECK_CACHE_TTL_MS) {
    return {
      ...cached,
      currentVersion: local.currentVersion,
      cached: true,
    };
  }

  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      currentVersion: local.currentVersion,
      releases: [],
      fetchedAtMs: nowMs,
    };
  }

  try {
    const res = await fetchJsonWithTimeout(fetchImpl, GITHUB_RELEASES_LIST_API, 7000);
    if (!res.ok || !Array.isArray(res.data)) {
      return {
        ok: false,
        currentVersion: local.currentVersion,
        releases: cached?.releases || [],
        fetchedAtMs: nowMs,
      };
    }

    const releases = [];
    const seen = new Set();
    for (const rel of res.data) {
      if (!rel || rel.draft) continue;
      const version = parseStrictSemver(rel.tag_name);
      if (!version || seen.has(version)) continue;
      seen.add(version);
      const publishedAt = typeof rel.published_at === 'string' ? rel.published_at : '';
      const date = publishedAt ? publishedAt.slice(0, 10) : '';
      releases.push({
        version,
        tag: `v${version}`,
        date,
        title: typeof rel.name === 'string' ? rel.name.trim() : `v${version}`,
        body: typeof rel.body === 'string' ? rel.body : '',
        publishedAt,
      });
    }
    releases.sort((a, b) => compareSemver(b.version, a.version));

    const payload = {
      ok: true,
      currentVersion: local.currentVersion,
      releases,
      fetchedAtMs: nowMs,
    };
    releasesCache.set(cacheKey, payload);
    return payload;
  } catch {
    return {
      ok: false,
      currentVersion: local.currentVersion,
      releases: cached?.releases || [],
      fetchedAtMs: nowMs,
    };
  }
}

/**
 * Download official main archive OR a specific semver release tag (`targetVersion`) from GitHub,
 * validate integrity, mirror into installed pluginRoot while preserving user configs & rules/AGENTS.md,
 * and recompile Windows backdrop companion.
 */
export async function applyPluginUpdate(
  paths,
  {
    targetVersion = '',
    fetchImpl = proxyAwareFetch,
    execFileImpl = execFileAsync,
    ensureBackdropFn = ensureBackdropAssets,
    platform = process.platform,
    nowMs = Date.now(),
  } = {},
) {
  const rawTarget = String(targetVersion || '').trim();
  const cleanTarget = rawTarget ? parseStrictSemver(rawTarget) : '';
  if (rawTarget && !cleanTarget) {
    return { ok: false, status: 400, error: '无效的目标版本号格式（仅支持 X.Y.Z 语义化版本）' };
  }

  if (updateInFlight) {
    return updateInFlight;
  }

  const run = async () => {
    const pluginRoot = paths?.pluginRoot;
    if (!pluginRoot || !fs.existsSync(pluginRoot)) {
      return { ok: false, status: 400, error: '未找到本地插件安装目录' };
    }
    if (typeof fetchImpl !== 'function') {
      return { ok: false, status: 500, error: '当前运行环境不支持下载更新' };
    }

    const beforeLocal = readLocalInstallState(paths);
    const beforeVersion = beforeLocal.currentVersion;
    const isTargetMode = Boolean(cleanTarget);
    const action =
      isTargetMode && compareSemver(cleanTarget, beforeVersion) < 0 ? 'rollback' : 'update';
    const archiveUrl = isTargetMode ? buildTagArchiveZipUrl(cleanTarget) : GITHUB_ARCHIVE_ZIP_URL;

    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-monitor-update-'));
    try {
      const latestCheck = await checkForUpdates(paths, { force: true, fetchImpl, nowMs }).catch(() => ({
        ok: false,
      }));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      let zipBuf;
      try {
        let curUrl = archiveUrl;
        let dlRes = null;
        for (let hop = 0; hop < 4; hop += 1) {
          dlRes = await fetchImpl(curUrl, {
            method: 'GET',
            headers: { 'User-Agent': 'agy-monitor-updater' },
            redirect: 'follow',
            signal: controller.signal,
          });
          if ([301, 302, 303, 307, 308].includes(dlRes.status)) {
            const loc =
              typeof dlRes.headers?.get === 'function'
                ? dlRes.headers.get('location')
                : dlRes.headers?.location || dlRes.headers?.Location;
            if (!loc) break;
            const nextUrl = new URL(String(loc), curUrl);
            const allowedHost =
              nextUrl.protocol === 'https:' &&
              (nextUrl.hostname === 'codeload.github.com' ||
                nextUrl.hostname === 'github.com' ||
                nextUrl.hostname.endsWith('.githubusercontent.com'));
            if (!allowedHost) {
              return { ok: false, status: 502, error: '更新包重定向至非官方域名，已中止操作' };
            }
            curUrl = nextUrl.toString();
            continue;
          }
          break;
        }
        if (!dlRes || !dlRes.ok) {
          const code = dlRes?.status || 502;
          const msg =
            isTargetMode && code === 404
              ? `GitHub 上未找到版本 v${cleanTarget} 的发布归档`
              : `下载${action === 'rollback' ? '回退' : '更新'}包失败 (HTTP ${code})`;
          return { ok: false, status: code === 404 ? 404 : 502, error: msg };
        }
        const ab = await dlRes.arrayBuffer();
        zipBuf = Buffer.from(ab);
      } finally {
        clearTimeout(timer);
      }

      if (
        !zipBuf ||
        zipBuf.length < MIN_ARCHIVE_BYTES ||
        zipBuf.length > MAX_ARCHIVE_BYTES ||
        zipBuf[0] !== 0x50 ||
        zipBuf[1] !== 0x4b
      ) {
        return { ok: false, status: 502, error: '下载的更新压缩包格式或大小异常，已中止升级' };
      }

      const zipPath = path.join(tempRoot, 'update.zip');
      const extractDir = path.join(tempRoot, 'extracted');
      await fsp.writeFile(zipPath, zipBuf);
      await extractZipArchive(zipPath, extractDir, { platform, execFileImpl });

      const extractedRoot = resolveExtractedPluginRoot(extractDir);
      if (!extractedRoot) {
        return { ok: false, status: 500, error: '更新包结构异常：缺少 plugin.json' };
      }

      for (const rel of REQUIRED_CORE_FILES) {
        if (!fs.existsSync(path.join(extractedRoot, rel))) {
          return { ok: false, status: 500, error: `更新包校验失败：缺少核心文件 ${rel}` };
        }
      }

      // Back up existing official files/dirs before mirroring so any mid-copy failure can roll back cleanly
      const backupRoot = path.join(tempRoot, 'backup');
      fs.mkdirSync(backupRoot, { recursive: true });
      const backedUpFiles = [];
      const backedUpDirs = [];
      for (const rel of ROOT_FILES) {
        const curPath = path.join(pluginRoot, rel);
        if (fs.existsSync(curPath)) {
          fs.copyFileSync(curPath, path.join(backupRoot, rel));
          backedUpFiles.push(rel);
        }
      }
      for (const rel of MIRROR_DIRS) {
        const curDir = path.join(pluginRoot, rel);
        if (fs.existsSync(curDir)) {
          mirrorDirectoryInPlace(curDir, path.join(backupRoot, rel));
          backedUpDirs.push(rel);
        }
      }

      // Mirror official files in place while strictly preserving rules/AGENTS.md & plugin_data/*
      try {
        for (const rel of ROOT_FILES) {
          const src = path.join(extractedRoot, rel);
          const dest = path.join(pluginRoot, rel);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
          } else if (OPTIONAL_ROOT_FILES.has(rel) && fs.existsSync(dest)) {
            fs.rmSync(dest, { force: true });
          }
        }
        for (const rel of MIRROR_DIRS) {
          mirrorDirectoryInPlace(path.join(extractedRoot, rel), path.join(pluginRoot, rel));
        }
      } catch (mirrorErr) {
        for (const rel of backedUpFiles) {
          try {
            fs.copyFileSync(path.join(backupRoot, rel), path.join(pluginRoot, rel));
          } catch {
            // best-effort rollback
          }
        }
        for (const rel of backedUpDirs) {
          try {
            mirrorDirectoryInPlace(path.join(backupRoot, rel), path.join(pluginRoot, rel));
          } catch {
            // best-effort rollback
          }
        }
        throw mirrorErr;
      }

      // Initialize rules/AGENTS.md only if absent; never overwrite user rules
      const srcAgents = path.join(extractedRoot, 'rules', 'AGENTS.md');
      const destAgents = path.join(pluginRoot, 'rules', 'AGENTS.md');
      if (fs.existsSync(srcAgents) && !fs.existsSync(destAgents)) {
        fs.mkdirSync(path.dirname(destAgents), { recursive: true });
        fs.copyFileSync(srcAgents, destAgents);
      }

      const updatedManifest = readJsonSyncSafe(path.join(pluginRoot, 'plugin.json'));
      const nextVersion =
        cleanTarget ||
        (typeof updatedManifest?.version === 'string' && updatedManifest.version.trim()
          ? updatedManifest.version.trim().replace(/^v/i, '')
          : latestCheck.remoteVersion || '1.0.0');

      let backdropCompiled = false;
      const shouldCompileBackdrop =
        platform === 'win32' || detectWindowsHostEnv({ platform }).hasWindowsHost;
      if (shouldCompileBackdrop && typeof ensureBackdropFn === 'function') {
        const bd = await ensureBackdropFn(paths).catch(() => ({ compiled: false }));
        backdropCompiled = Boolean(bd?.compiled);
      }

      const metaPath = paths?.pluginDataDir ? path.join(paths.pluginDataDir, 'install_meta.json') : '';
      const prevMeta = metaPath ? readJsonSyncSafe(metaPath) : null;
      const prevFullSha =
        typeof prevMeta?.commitSha === 'string' && /^[0-9a-f]{7,40}$/i.test(prevMeta.commitSha.trim())
          ? prevMeta.commitSha.trim().toLowerCase()
          : '';
      const prevShortSha =
        typeof prevMeta?.shortSha === 'string' && prevMeta.shortSha.trim()
          ? prevMeta.shortSha.trim().toLowerCase()
          : prevFullSha.slice(0, 7);
      const nextFullSha = isTargetMode
        ? ''
        : latestCheck.ok && latestCheck.remoteFullSha
          ? latestCheck.remoteFullSha
          : prevFullSha;
      const nextShortSha = isTargetMode
        ? ''
        : latestCheck.ok && latestCheck.remoteSha
          ? latestCheck.remoteSha
          : prevShortSha;

      if (metaPath) {
        await atomicWriteJson(metaPath, {
          version: nextVersion,
          ...(isTargetMode ? { tag: `v${cleanTarget}` } : {}),
          commitSha: nextFullSha,
          shortSha: nextShortSha,
          updatedAtMs: nowMs,
        }).catch(() => {});
      }

      checkCache.delete(pluginRoot);
      const remoteLatestVersion =
        latestCheck.ok && latestCheck.remoteVersion ? latestCheck.remoteVersion : nextVersion;
      const hasNewerAfter = compareSemver(remoteLatestVersion, nextVersion) > 0;
      const nextStatus = {
        ok: true,
        repoUrl: REPO_URL,
        currentVersion: nextVersion,
        localSha: nextShortSha,
        remoteVersion: remoteLatestVersion,
        remoteSha: latestCheck.remoteSha || nextShortSha,
        remoteFullSha: latestCheck.remoteFullSha || nextFullSha,
        remoteDate: latestCheck.remoteDate || '',
        remoteMessage: latestCheck.remoteMessage || '',
        hasUpdate: hasNewerAfter,
        checkedAtMs: nowMs,
      };
      checkCache.set(pluginRoot, nextStatus);

      return {
        ok: true,
        updated: true,
        action,
        previousVersion: beforeVersion,
        targetVersion: nextVersion,
        needsReload: true,
        version: nextVersion,
        shortSha: nextShortSha,
        commitMessage: latestCheck.remoteMessage || '',
        backdropCompiled,
        status: nextStatus,
      };
    } catch (err) {
      return {
        ok: false,
        status: 500,
        error: err?.name === 'AbortError' ? '下载更新包超时，请检查网络后重试' : err?.message || '自动更新失败',
      };
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  };

  updateInFlight = run().finally(() => {
    updateInFlight = null;
  });
  return updateInFlight;
}

/**
 * Open the hardcoded official GitHub repository page in the OS default browser.
 */
export function openRepoInBrowser({ platform = process.platform, spawnImpl = spawn } = {}) {
  try {
    let child = null;
    if (platform === 'win32') {
      child = spawnImpl('rundll32.exe', ['url.dll,FileProtocolHandler', REPO_URL], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else if (platform === 'darwin') {
      child = spawnImpl('open', [REPO_URL], { detached: true, stdio: 'ignore' });
    } else {
      const hostInfo = detectWindowsHostEnv({ platform });
      const wslRundll =
        hostInfo.isWsl && hostInfo.winMountRoot
          ? `${hostInfo.winMountRoot}/Windows/System32/rundll32.exe`
          : '';
      if (wslRundll && fs.existsSync(wslRundll)) {
        child = spawnImpl(wslRundll, ['url.dll,FileProtocolHandler', REPO_URL], {
          detached: true,
          stdio: 'ignore',
        });
      } else {
        child = spawnImpl('xdg-open', [REPO_URL], { detached: true, stdio: 'ignore' });
      }
    }
    child?.on?.('error', () => {});
    child?.unref?.();
    return { ok: true, url: REPO_URL };
  } catch (err) {
    return { ok: false, status: 500, error: err?.message || '打开项目主页失败' };
  }
}

export function resetUpdateCheckCache() {
  checkCache.clear();
  releasesCache.clear();
}
