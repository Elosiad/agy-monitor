/**
 * Builds a clean, standalone GitHub Release ZIP package in `dist/`.
 *
 * The resulting ZIP contains a single top-level `agy-monitor-v<version>/` folder
 * so end users simply download -> extract -> double-click `install.cmd` (Windows)
 * or run `./install.sh` (macOS/Linux).
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const RELEASE_ROOT_FILES = [
  'plugin.json',
  'package.json',
  'hooks.json',
  'mcp_config.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'install.cmd',
  'uninstall.cmd',
  'install.sh',
  'uninstall.sh',
];

const RELEASE_DIRS = [
  'assets',
  'hooks',
  'rules',
  'sidecars',
  'skills',
];

const RELEASE_SCRIPTS = [
  'scripts/sync_to_plugins.mjs',
  'scripts/install.mjs',
  'scripts/uninstall.mjs',
  'scripts/install.ps1',
];

function copyDirClean(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirClean(srcPath, destPath);
    } else {
      // Never ship compiled binaries or temp artifacts inside source release ZIP
      if (/\.(exe|tmp|log|bak)$/i.test(entry.name)) continue;
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function packRelease({ repoRoot = REPO_ROOT, outDir = path.join(REPO_ROOT, 'dist') } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = String(pkg.version || '1.0.0').trim();
  const folderName = `agy-monitor-v${version}`;
  const stageDir = path.join(outDir, folderName);
  const zipPath = path.join(outDir, `${folderName}.zip`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  for (const rel of RELEASE_ROOT_FILES) {
    const src = path.join(repoRoot, rel);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required release file: ${rel}`);
    }
    const dest = path.join(stageDir, rel);
    if (rel.endsWith('.cmd')) {
      const normalized = fs.readFileSync(src, 'utf8').replace(/\r?\n/g, '\r\n');
      fs.writeFileSync(dest, normalized, 'utf8');
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  for (const relDir of RELEASE_DIRS) {
    const src = path.join(repoRoot, relDir);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required release directory: ${relDir}`);
    }
    copyDirClean(src, path.join(stageDir, relDir));
  }

  fs.mkdirSync(path.join(stageDir, 'scripts'), { recursive: true });
  for (const relScript of RELEASE_SCRIPTS) {
    const src = path.join(repoRoot, relScript);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required installer script: ${relScript}`);
    }
    fs.copyFileSync(src, path.join(stageDir, relScript));
  }

  // Always ship clean empty rules/AGENTS.md placeholder in public release package
  fs.mkdirSync(path.join(stageDir, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'rules', 'AGENTS.md'), '', 'utf8');

  if (process.platform === 'win32') {
    const psCmd = `Compress-Archive -LiteralPath '${stageDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      windowsHide: true,
      stdio: 'inherit',
    });
  } else {
    execFileSync('zip', ['-qr', zipPath, folderName], {
      cwd: outDir,
      stdio: 'inherit',
    });
  }

  // Clean up unzipped staging folder after creating archive
  fs.rmSync(stageDir, { recursive: true, force: true });

  const zipBuf = fs.readFileSync(zipPath);
  const sha256 = crypto.createHash('sha256').update(zipBuf).digest('hex');
  const sizeKB = Math.round((zipBuf.length / 1024) * 10) / 10;

  return {
    ok: true,
    version,
    zipPath,
    sizeBytes: zipBuf.length,
    sizeKB,
    sha256,
  };
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
  const result = packRelease();
  console.log(JSON.stringify(result, null, 2));
}
