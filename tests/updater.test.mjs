import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import {
  REPO_URL,
  applyPluginUpdate,
  checkForUpdates,
  compareSemver,
  listOfficialReleases,
  openRepoInBrowser,
  parseStrictSemver,
  resetUpdateCheckCache,
} from '../sidecars/agy_monitor/backend/updater.mjs';

const execFileAsync = promisify(execFile);

function makeFakePluginEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-updater-test-'));
  const pluginRoot = path.join(root, 'installed');
  const pluginDataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'sidecars', 'agy_monitor'), { recursive: true });
  fs.mkdirSync(pluginDataDir, { recursive: true });

  fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({ name: 'agy-monitor', version: '1.0.0' }));
  fs.writeFileSync(path.join(pluginRoot, 'hooks.json'), '{}');
  fs.writeFileSync(path.join(pluginRoot, 'hooks', 'mastery_summary_hook.mjs'), '// old hook\n');
  fs.writeFileSync(path.join(pluginRoot, 'rules', 'AGENTS.md'), '# My Custom User Rule\n');
  fs.writeFileSync(path.join(pluginRoot, 'sidecars', 'agy_monitor', 'sidecar.json'), '{}');
  fs.writeFileSync(path.join(pluginRoot, 'sidecars', 'agy_monitor', 'main.mjs'), '// old main\n');
  fs.writeFileSync(path.join(pluginDataDir, 'themes.json'), JSON.stringify({ activeWallpaperId: 'wp-3' }));

  const paths = resolvePaths({
    pluginRoot,
    pluginDataDir,
    appDataDir: path.join(root, 'appData'),
    geminiConfigDir: path.join(root, 'config'),
    sidecarDataDir: path.join(root, 'sidecarData'),
  });

  t.after(() => {
    resetUpdateCheckCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, pluginRoot, pluginDataDir, paths };
}

test('compareSemver & checkForUpdates detect commit and semver updates accurately', async (t) => {
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
  assert.equal(compareSemver('v1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0', '1.2.0'), -1);

  const { paths, pluginDataDir } = makeFakePluginEnv(t);
  fs.writeFileSync(
    path.join(pluginDataDir, 'install_meta.json'),
    JSON.stringify({ version: '1.0.0', commitSha: 'aaaaaaa111111111111111111111111111111111', updatedAtMs: 1000 }),
  );

  const fakeFetchNewer = async (url) => {
    if (url.includes('/commits/main')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: 'bbbbbbb222222222222222222222222222222222',
          commit: { message: 'fix: prevent ghost hud\ndetails', committer: { date: '2026-11-20T09:00:00Z' } },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ tag_name: 'v1.0.1' }),
    };
  };

  const res = await checkForUpdates(paths, { force: true, fetchImpl: fakeFetchNewer, nowMs: 5000 });
  assert.equal(res.ok, true);
  assert.equal(res.hasUpdate, true);
  assert.equal(res.remoteSha, 'bbbbbbb');
  assert.equal(res.remoteVersion, '1.0.1');
  assert.equal(res.remoteMessage, 'fix: prevent ghost hud');
  assert.equal(res.repoUrl, REPO_URL);

  // Same SHA + same version -> up to date
  fs.writeFileSync(
    path.join(pluginDataDir, 'install_meta.json'),
    JSON.stringify({ version: '1.0.0', commitSha: 'bbbbbbb222222222222222222222222222222222', updatedAtMs: 5000 }),
  );
  const fakeFetchSame = async (url) => {
    if (url.includes('/commits/main')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: 'bbbbbbb222222222222222222222222222222222',
          commit: { message: 'same', committer: { date: '2026-11-20T09:00:00Z' } },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const sameRes = await checkForUpdates(paths, { force: true, fetchImpl: fakeFetchSame, nowMs: 6000 });
  assert.equal(sameRes.ok, true);
  assert.equal(sameRes.hasUpdate, false);

  // Same release semver (1.0.8 === 1.0.8) with a newer docs commit on main & stale 1.0.7 install_meta -> NOT an update
  fs.writeFileSync(path.join(paths.pluginRoot, 'plugin.json'), JSON.stringify({ name: 'agy-monitor', version: '1.0.8' }));
  fs.writeFileSync(
    path.join(pluginDataDir, 'install_meta.json'),
    JSON.stringify({ version: '1.0.7', commitSha: '078b23da94f272b459f289fefa799cda1b57006d', updatedAtMs: 1000 }),
  );
  const fakeFetchSameReleaseDiffSha = async (url) => {
    if (url.includes('/commits/main')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: '1752032999999999999999999999999999999999',
          commit: { message: 'docs: update README', committer: { date: '2026-11-21T20:30:00Z' } },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.0.8' }) };
  };
  const sameVerRes = await checkForUpdates(paths, { force: true, fetchImpl: fakeFetchSameReleaseDiffSha, nowMs: 7000 });
  assert.equal(sameVerRes.ok, true);
  assert.equal(sameVerRes.hasUpdate, false);

  // Local version ahead of remote release (1.0.9 > 1.0.8) -> NEVER prompt downgrade
  fs.writeFileSync(path.join(paths.pluginRoot, 'plugin.json'), JSON.stringify({ name: 'agy-monitor', version: '1.0.9' }));
  const aheadRes = await checkForUpdates(paths, { force: true, fetchImpl: fakeFetchSameReleaseDiffSha, nowMs: 8000 });
  assert.equal(aheadRes.ok, true);
  assert.equal(aheadRes.hasUpdate, false);
});

test('applyPluginUpdate mirrors validated zip while preserving rules/AGENTS.md and user settings, and openRepoInBrowser uses official URL', async (t) => {
  const { root, pluginRoot, pluginDataDir, paths } = makeFakePluginEnv(t);

  // Build a real valid zip archive matching GitHub's agy-monitor-main/ layout (>10KB payload)
  const stageDir = path.join(root, 'stage', 'agy-monitor-main');
  fs.mkdirSync(path.join(stageDir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'sidecars', 'agy_monitor'), { recursive: true });

  fs.writeFileSync(path.join(stageDir, 'plugin.json'), JSON.stringify({ name: 'agy-monitor', version: '1.1.0' }));
  fs.writeFileSync(path.join(stageDir, 'hooks.json'), '{"updated":true}');
  fs.writeFileSync(path.join(stageDir, 'hooks', 'mastery_summary_hook.mjs'), '// new hook v1.1.0\n');
  fs.writeFileSync(path.join(stageDir, 'rules', 'AGENTS.md'), '# Default Upstream Rule Should NOT Overwrite\n');
  fs.writeFileSync(path.join(stageDir, 'sidecars', 'agy_monitor', 'sidecar.json'), '{"v":2}');
  fs.writeFileSync(path.join(stageDir, 'sidecars', 'agy_monitor', 'main.mjs'), '// new main v1.1.0\n');
  // Pad an asset file with incompressible random bytes so zip exceeds 10KB minimum integrity guard
  fs.writeFileSync(path.join(stageDir, 'assets', 'payload.bin'), crypto.randomBytes(18 * 1024));

  const testZipPath = path.join(root, 'fake-release.zip');
  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${stageDir.replace(/'/g, "''")}' -DestinationPath '${testZipPath.replace(/'/g, "''")}' -Force`,
    ]);
  } else {
    await execFileAsync('zip', ['-rq', testZipPath, 'agy-monitor-main'], { cwd: path.join(root, 'stage') });
  }
  const zipBytes = fs.readFileSync(testZipPath);

  const fakeFetch = async (url) => {
    if (url.includes('/commits/main')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: 'ccccccc333333333333333333333333333333333',
          commit: { message: 'feat: release v1.1.0', committer: { date: '2026-11-20T10:00:00Z' } },
        }),
      };
    }
    if (url.includes('/releases/latest')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0' }) };
    }
    if (url.includes('/zip/refs/heads/main')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  let backdropCalled = false;
  const updRes = await applyPluginUpdate(paths, {
    fetchImpl: fakeFetch,
    ensureBackdropFn: async () => {
      backdropCalled = true;
      return { compiled: true };
    },
    nowMs: 999999,
  });

  assert.equal(updRes.ok, true);
  assert.equal(updRes.updated, true);
  assert.equal(updRes.version, '1.1.0');
  assert.equal(updRes.shortSha, 'ccccccc');
  if (process.platform === 'win32') {
    assert.equal(backdropCalled, true);
  }

  // Core files updated, user rules & user data strictly preserved
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'sidecars', 'agy_monitor', 'main.mjs'), 'utf8'), '// new main v1.1.0\n');
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'rules', 'AGENTS.md'), 'utf8'), '# My Custom User Rule\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pluginDataDir, 'themes.json'), 'utf8')).activeWallpaperId, 'wp-3');
  const meta = JSON.parse(fs.readFileSync(path.join(pluginDataDir, 'install_meta.json'), 'utf8'));
  assert.equal(meta.commitSha, 'ccccccc333333333333333333333333333333333');

  // openRepoInBrowser strictly launches official REPO_URL
  const launched = [];
  const openRes = openRepoInBrowser({
    platform: 'win32',
    spawnImpl: (cmd, args) => {
      launched.push({ cmd, args });
      return { unref() {} };
    },
  });
  assert.equal(openRes.ok, true);
  assert.equal(openRes.url, REPO_URL);
  assert.equal(launched[0].cmd, 'rundll32.exe');
  assert.deepEqual(launched[0].args, ['url.dll,FileProtocolHandler', REPO_URL]);
});

test('listOfficialReleases & applyPluginUpdate(targetVersion) support exact version rollback/upgrade and reject invalid semver', async (t) => {
  const { root, pluginRoot, pluginDataDir, paths } = makeFakePluginEnv(t);
  fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({ name: 'agy-monitor', version: '1.1.1' }));

  assert.equal(parseStrictSemver('v1.0.13'), '1.0.13');
  assert.equal(parseStrictSemver('1.1.1'), '1.1.1');
  assert.equal(parseStrictSemver('../evil'), '');
  assert.equal(parseStrictSemver('1.0.0;rm -rf'), '');

  // Reject invalid targetVersion before touching network
  const badRes = await applyPluginUpdate(paths, { targetVersion: '../evil' });
  assert.equal(badRes.ok, false);
  assert.equal(badRes.status, 400);

  // Build valid rollback tag zip for v1.0.13
  const stageDir = path.join(root, 'stage-rollback', 'agy-monitor-1.0.13');
  fs.mkdirSync(path.join(stageDir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'sidecars', 'agy_monitor'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'plugin.json'), JSON.stringify({ name: 'agy-monitor', version: '1.0.13' }));
  fs.writeFileSync(path.join(stageDir, 'hooks.json'), '{}');
  fs.writeFileSync(path.join(stageDir, 'hooks', 'mastery_summary_hook.mjs'), '// hook v1.0.13\n');
  fs.writeFileSync(path.join(stageDir, 'rules', 'AGENTS.md'), '# Upstream should not overwrite\n');
  fs.writeFileSync(path.join(stageDir, 'sidecars', 'agy_monitor', 'sidecar.json'), '{}');
  fs.writeFileSync(path.join(stageDir, 'sidecars', 'agy_monitor', 'main.mjs'), '// main v1.0.13\n');
  fs.writeFileSync(path.join(stageDir, 'assets', 'payload.bin'), crypto.randomBytes(18 * 1024));

  const rollbackZipPath = path.join(root, 'rollback-1.0.13.zip');
  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${stageDir.replace(/'/g, "''")}' -DestinationPath '${rollbackZipPath.replace(/'/g, "''")}' -Force`,
    ]);
  } else {
    await execFileAsync('zip', ['-rq', rollbackZipPath, 'agy-monitor-1.0.13'], {
      cwd: path.join(root, 'stage-rollback'),
    });
  }
  const zipBytes = fs.readFileSync(rollbackZipPath);

  const requestedUrls = [];
  const fakeFetch = async (url) => {
    const u = String(url);
    requestedUrls.push(u);
    if (u.includes('/releases?per_page=')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { tag_name: 'v1.0.13', name: 'v1.0.13', body: '- TTFT exact', published_at: '2026-11-22T10:00:00Z' },
          { tag_name: 'v1.1.1', name: 'v1.1.1', body: '- Changelog modal', published_at: '2026-11-24T08:00:00Z' },
          { tag_name: 'v9.9.9', draft: true, name: 'draft' },
        ],
      };
    }
    if (u.includes('/commits/main')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: 'ddddddd444444444444444444444444444444444',
          commit: { message: 'release v1.1.1', committer: { date: '2026-11-24T08:00:00Z' } },
        }),
      };
    }
    if (u.includes('/releases/latest')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.1' }) };
    }
    if (u.includes('/zip/refs/tags/v1.0.13')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const relList = await listOfficialReleases(paths, { force: true, fetchImpl: fakeFetch, nowMs: 10000 });
  assert.equal(relList.ok, true);
  assert.equal(relList.currentVersion, '1.1.1');
  assert.deepEqual(relList.releases.map((r) => r.version), ['1.1.1', '1.0.13']);

  const rbRes = await applyPluginUpdate(paths, {
    targetVersion: '1.0.13',
    fetchImpl: fakeFetch,
    ensureBackdropFn: async () => ({ compiled: true }),
    nowMs: 20000,
  });
  assert.equal(rbRes.ok, true);
  assert.equal(rbRes.action, 'rollback');
  assert.equal(rbRes.previousVersion, '1.1.1');
  assert.equal(rbRes.version, '1.0.13');
  assert.equal(rbRes.status.hasUpdate, true);
  assert.equal(rbRes.status.remoteVersion, '1.1.1');
  assert.ok(requestedUrls.some((u) => u.includes('/zip/refs/tags/v1.0.13')));
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'sidecars', 'agy_monitor', 'main.mjs'), 'utf8'), '// main v1.0.13\n');
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'rules', 'AGENTS.md'), 'utf8'), '# My Custom User Rule\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pluginDataDir, 'themes.json'), 'utf8')).activeWallpaperId, 'wp-3');
});
