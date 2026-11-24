/**
 * Synchronizes the plugin repository into ~/.gemini/config/plugins/agy-monitor
 * as a real directory copy (replacing Windows junctions/symlinks that Go's
 * filepath.WalkDir / os.ReadDir skips).
 *
 * - Mirror-cleans `assets/` and `sidecars/` before copying so deleted source files
 *   (e.g. removed legacy modules) do not linger in the installed copy.
 * - Preserves an existing target `rules/AGENTS.md` unless `resetRules` / `--reset-rules`
 *   is explicitly specified, so user-selected prompt rules survive upgrades.
 * - Never modifies ~/.gemini/config/config.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SOURCE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TARGET_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agy-monitor');

const ROOT_FILES = ['plugin.json', 'package.json', 'hooks.json', 'mcp_config.json', 'README.md'];
const MIRROR_DIRS = ['assets', 'sidecars', 'hooks', 'skills'];

function removeExistingSafely(targetDir) {
  const st = fs.lstatSync(targetDir, { throwIfNoEntry: false });
  if (!st) return 'absent';

  if (st.isSymbolicLink()) {
    try {
      fs.rmdirSync(targetDir);
    } catch {
      fs.unlinkSync(targetDir);
    }
    return 'unlinked_symlink_or_junction';
  }

  if (st.isDirectory()) {
    // Keep target root folder when it is already a real directory to avoid EPERM on open handles
    return 'kept_directory_for_mirror';
  }

  fs.unlinkSync(targetDir);
  return 'removed_file';
}

function mirrorDirectoryInPlace(srcDir, destDir) {
  const srcExists = fs.existsSync(srcDir);
  const destStat = fs.lstatSync(destDir, { throwIfNoEntry: false });
  if (!srcExists) {
    if (destStat) {
      fs.rmSync(destDir, { recursive: true, force: true });
      return true;
    }
    return false;
  }

  if (destStat && !destStat.isDirectory()) {
    fs.unlinkSync(destDir);
  }
  fs.mkdirSync(destDir, { recursive: true });

  const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((e) => e.name));

  let prunedAny = false;
  for (const destEntry of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!srcNames.has(destEntry.name)) {
      fs.rmSync(path.join(destDir, destEntry.name), { recursive: true, force: true });
      prunedAny = true;
    }
  }

  for (const srcEntry of srcEntries) {
    const srcChild = path.join(srcDir, srcEntry.name);
    const destChild = path.join(destDir, srcEntry.name);
    if (srcEntry.isDirectory()) {
      if (mirrorDirectoryInPlace(srcChild, destChild)) {
        prunedAny = true;
      }
    } else {
      const destChildStat = fs.lstatSync(destChild, { throwIfNoEntry: false });
      if (destChildStat && destChildStat.isDirectory()) {
        fs.rmSync(destChild, { recursive: true, force: true });
        prunedAny = true;
      }
      fs.copyFileSync(srcChild, destChild);
    }
  }

  return prunedAny;
}

export function syncPluginToConfig({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetDir = DEFAULT_TARGET_DIR,
  resetRules = false,
} = {}) {
  const src = path.resolve(sourceRoot);
  const dest = path.resolve(targetDir);

  if (src === dest) {
    throw new Error('Source and target plugin directories cannot be identical');
  }

  const prevAction = removeExistingSafely(dest);
  fs.mkdirSync(dest, { recursive: true });

  const copied = [];
  const prunedDirs = [];

  for (const rel of ROOT_FILES) {
    const fromPath = path.join(src, rel);
    if (!fs.existsSync(fromPath)) continue;
    fs.copyFileSync(fromPath, path.join(dest, rel));
    copied.push(rel);
  }

  for (const rel of MIRROR_DIRS) {
    const fromPath = path.join(src, rel);
    const toPath = path.join(dest, rel);
    const pruned = mirrorDirectoryInPlace(fromPath, toPath);
    if (pruned) {
      prunedDirs.push(rel);
    }
    if (fs.existsSync(fromPath)) {
      copied.push(rel);
    }
  }

  // Protect active target rules/AGENTS.md unless missing or --reset-rules is set
  const srcRulesDir = path.join(src, 'rules');
  const destRulesDir = path.join(dest, 'rules');
  fs.mkdirSync(destRulesDir, { recursive: true });
  let rulesStatus = 'missing_source';
  const srcAgents = path.join(srcRulesDir, 'AGENTS.md');
  const destAgents = path.join(destRulesDir, 'AGENTS.md');
  if (fs.existsSync(srcAgents)) {
    const destExists = fs.existsSync(destAgents);
    if (!destExists || resetRules) {
      fs.copyFileSync(srcAgents, destAgents);
      copied.push('rules/AGENTS.md');
      rulesStatus = destExists ? 'reset' : 'initialized';
    } else {
      rulesStatus = 'preserved_existing';
    }
  }

  return {
    sourceRoot: src,
    targetDir: dest,
    prevAction,
    prunedDirs,
    copied,
    rulesStatus,
  };
}

function parseCliArgs(argv) {
  let targetDir = DEFAULT_TARGET_DIR;
  let sourceRoot = DEFAULT_SOURCE_ROOT;
  let resetRules = false;
  for (const arg of argv) {
    if (arg.startsWith('--target=')) {
      targetDir = arg.slice('--target='.length);
    } else if (arg.startsWith('--source=')) {
      sourceRoot = arg.slice('--source='.length);
    } else if (arg === '--reset-rules') {
      resetRules = true;
    }
  }
  return { sourceRoot, targetDir, resetRules };
}

function isSameEntrypoint(argvPath, modulePath) {
  if (typeof argvPath !== 'string' || !argvPath) return false;
  try {
    const a = fs.realpathSync(path.resolve(argvPath));
    const b = fs.realpathSync(modulePath);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    const a = path.resolve(argvPath);
    return process.platform === 'win32' ? a.toLowerCase() === modulePath.toLowerCase() : a === modulePath;
  }
}

const isEntrypoint = isSameEntrypoint(process.argv[1], __filename);

if (isEntrypoint) {
  const opts = parseCliArgs(process.argv.slice(2));
  const result = syncPluginToConfig(opts);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
