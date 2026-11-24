/**
 * Generic zero-coupling extension discovery & loader for agy-monitor.
 *
 * Scans `sidecars/agy_monitor/extensions/<name>/index.mjs` at startup.
 * - Deleting `extensions/` or setting `AGY_DISABLE_EXTENSIONS=1` disables all extensions cleanly.
 * - Adding new extensions requires zero modifications to core files.
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function extensionsDisabled() {
  return process.env.AGY_DISABLE_EXTENSIONS === '1' || process.env.AGY_DISABLE_EXTENSIONS === 'true';
}

let cachedExtensions = null;

export async function loadInstalledExtensions({ force = false } = {}) {
  if (extensionsDisabled()) return [];
  if (cachedExtensions && !force) return cachedExtensions;

  const loaded = [];
  try {
    const entries = await fs.readdir(__dirname, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();

    for (const dirName of dirs) {
      const entryFile = path.join(__dirname, dirName, 'index.mjs');
      if (!fsSync.existsSync(entryFile)) continue;
      try {
        const mod = await import(pathToFileURL(entryFile).href);
        const ext = mod?.default || Object.values(mod || {}).find((v) => v && typeof v === 'object' && v.id);
        if (ext && typeof ext === 'object') {
          loaded.push({
            id: ext.id || dirName,
            dir: path.join(__dirname, dirName),
            ...ext,
          });
        }
      } catch (err) {
        console.warn(`[extensions] failed to load "${dirName}": ${err?.message || err}`);
      }
    }
  } catch {
    // Missing extensions directory -> run core cleanly without extensions
  }

  cachedExtensions = loaded;
  return loaded;
}

export function getLoadedExtensionsSync() {
  if (extensionsDisabled()) return [];
  return Array.isArray(cachedExtensions) ? cachedExtensions : [];
}

function stripTopLevelExports(source) {
  return String(source || '').replace(
    /^export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm,
    '',
  );
}

/**
 * Compile all discovered extension frontend scripts into classic IIFE blocks that
 * register themselves on `window.__agyExtensions`.
 */
export async function buildFrontendExtensionsChunk() {
  if (extensionsDisabled()) return '';
  const chunks = [];
  try {
    const entries = await fs.readdir(__dirname, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();

    for (const dirName of dirs) {
      const feDir = path.join(__dirname, dirName, 'frontend');
      if (!fsSync.existsSync(feDir)) continue;
      const files = (await fs.readdir(feDir)).filter((f) => f.endsWith('.js')).sort();
      if (files.length === 0) continue;

      // Put *_i18n.js helper files first so extension main script can call them directly
      files.sort((a, b) => {
        const ai = a.includes('i18n') ? 0 : 1;
        const bi = b.includes('i18n') ? 0 : 1;
        return ai !== bi ? ai - bi : a.localeCompare(b);
      });

      const sources = await Promise.all(
        files.map((f) => fs.readFile(path.join(feDir, f), 'utf8')),
      );
      const mergedBody = sources.map((src) => stripTopLevelExports(src)).join('\n\n');
      const mountMatch = /\bfunction\s+(mount[A-Za-z0-9_]*Extension)\s*\(/.exec(mergedBody);
      if (!mountMatch) continue;
      const mountFnName = mountMatch[1];

      chunks.push(
        `(function () {\n` +
          `  "use strict";\n` +
          `${mergedBody}\n` +
          `  if (typeof window !== "undefined") {\n` +
          `    window.__agyExtensions = Array.isArray(window.__agyExtensions) ? window.__agyExtensions : [];\n` +
          `    window.__agyExtensions.push({ id: ${JSON.stringify(dirName)}, mount: ${mountFnName} });\n` +
          `  }\n` +
          `})();`,
      );
    }
  } catch {
    return '';
  }

  return chunks.join('\n\n');
}
