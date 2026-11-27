/**
 * Pure static Node.js detached switch & rollback worker (`switch_worker.mjs`).
 *
 * Designed for AV-friendliness and zero console window flash across Windows, macOS, and Linux:
 * - Zero dynamically generated `.vbs` (`wscript.exe`) or PowerShell scripts.
 * - Windows graceful close uses a single `taskkill.exe /PID ... /T` (no /F), escalating only
 *   lingering processes via Node built-in `process.kill(pid)`.
 * - Delegates Windows DPAPI + `CredWriteW` strictly to compiled `agy_account_tool.exe --apply-switch-tx`,
 *   or handles macOS Keychain / Linux Secret Service natively via `account_driver_posix.mjs`.
 * - Atomically syncs `app_storage.json` onboarding fields (`lastLoginUsername` / `lastLoginIsGcpTos`)
 *   for already-onboarded accounts after Antigravity exits, with automatic rollback on failure.
 * - Relaunches Antigravity detached with a clean environment (`ELECTRON_RUN_AS_NODE` stripped).
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_KEYRING_ACCOUNT,
  ACTIVE_KEYRING_SERVICE,
  applyAppStorageOnboarding,
  createPosixKeychainClient,
  openAes256Gcm,
  readAppStorageOnboarding,
  sealAes256Gcm,
  unwrapGoKeyringPayload,
} from '../backend/account_driver_posix.mjs';

const BLOCKED_ENV_EXACT = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_NO_ASAR',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
]);

const WIN_ANTIGRAVITY_IMAGES = ['Antigravity.exe', 'Antigravity IDE.exe', 'Antigravity_Original.exe'];
const WIN_LS_IMAGES = ['language_server.exe'];
const SAFE_WIN_USER_RE = /^[\w .-]{1,64}$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function atomicWriteJsonSync(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(obj, null, 2);
  try {
    fs.writeFileSync(tmpPath, text, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.writeFileSync(filePath, text, { encoding: 'utf8', mode: 0o600 });
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

function atomicWriteUtf8Sync(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, String(content ?? ''), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.writeFileSync(filePath, String(content ?? ''), { encoding: 'utf8', mode: 0o600 });
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

function updateTxStage(txPath, tx, stage, errorMsg = '') {
  tx.stage = stage;
  tx.updatedAtMs = Date.now();
  if (errorMsg) {
    tx.error = String(errorMsg);
  }
  try {
    atomicWriteJsonSync(txPath, tx);
  } catch {
    // non-fatal
  }
}

/**
 * Parse `launchArgs` string (e.g. `--remote-debugging-port=9229 --foo="bar baz"`) into argv array.
 */
export function parseLaunchArgsString(rawArgs) {
  const input = String(rawArgs || '').trim();
  if (!input) return [];
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Build a clean relaunch environment with Electron/sidecar pollution removed.
 */
export function buildCleanWorkerEnv(baseEnv = process.env) {
  const clean = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v === undefined) continue;
    const upper = String(k).toUpperCase();
    if (
      BLOCKED_ENV_EXACT.has(upper) ||
      upper.startsWith('ANTIGRAVITY_') ||
      upper.startsWith('AGY_') ||
      upper.startsWith('VSCODE_')
    ) {
      continue;
    }
    clean[k] = v;
  }
  return clean;
}

/**
 * Parse CSV output of `tasklist.exe /FO CSV /NH` into unique PIDs for matching image names.
 */
export function parseWindowsTasklistPids(stdout, { excludePids = new Set(), imageNames = WIN_ANTIGRAVITY_IMAGES } = {}) {
  const allowed = new Set(imageNames.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean));
  const pids = [];
  const seen = new Set();
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const match = /^"([^"]+)","(\d+)"/.exec(rawLine.trim());
    if (!match || !allowed.has(match[1].toLowerCase())) continue;
    const pid = Number(match[2]);
    if (!Number.isInteger(pid) || pid <= 0 || excludePids.has(pid) || seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
  }
  return pids;
}

function listWindowsImagePids(imageNames, { excludePids = new Set(), env = process.env, runSpawn = spawnSync } = {}) {
  const all = new Set();
  const rawUser = typeof env?.USERNAME === 'string' ? env.USERNAME.trim() : '';
  const safeUser = SAFE_WIN_USER_RE.test(rawUser) ? rawUser : '';

  for (const imageName of imageNames) {
    const query = (user) => {
      const args = ['/FI', `IMAGENAME eq ${imageName}`];
      if (user) args.push('/FI', `USERNAME eq ${user}`);
      args.push('/FO', 'CSV', '/NH');
      return runSpawn('tasklist.exe', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 6000,
      });
    };
    let res = safeUser ? query(safeUser) : null;
    if (!res || res.error || res.status !== 0 || !String(res.stdout || '').trim()) {
      res = query('');
    }
    if (res && !res.error && res.status === 0) {
      for (const pid of parseWindowsTasklistPids(res.stdout, { excludePids, imageNames: [imageName] })) {
        all.add(pid);
      }
    }
  }
  return [...all];
}

function listPosixHostPids({ platform, targetExe, excludePids = new Set(), runSpawn = spawnSync } = {}) {
  const args = platform === 'darwin' ? ['-axo', 'pid=,args='] : ['-eo', 'pid=,args='];
  const res = runSpawn('ps', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  if (!res || res.error || res.status !== 0) return [];

  const targetNorm = String(targetExe || '').trim();
  const matchPrefixes = [];
  if (platform === 'darwin' && targetNorm) {
    matchPrefixes.push(`${targetNorm}/Contents/MacOS/`);
    matchPrefixes.push(`${targetNorm}/Contents/Resources/bin/language_server`);
  } else if (targetNorm) {
    matchPrefixes.push(targetNorm);
    matchPrefixes.push(path.join(path.dirname(targetNorm), 'resources', 'bin', 'language_server'));
  }

  const pids = [];
  for (const line of String(res.stdout || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2].trim();
    if (!Number.isInteger(pid) || pid <= 0 || excludePids.has(pid)) continue;
    if (cmd.includes('switch_worker.mjs')) continue;
    const matched = matchPrefixes.some((p) => p && cmd.startsWith(p));
    if (matched) pids.push(pid);
  }
  return pids;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function closeHostProcesses({
  platform,
  targetExe,
  excludePids,
  env,
  runSpawn,
  gracefulTimeoutMs = 8000,
  forceTimeoutMs = 3500,
  pollMs = 200,
  listHostPidsOverride = null,
}) {
  const listAll = () => {
    if (typeof listHostPidsOverride === 'function') {
      return listHostPidsOverride();
    }
    if (platform === 'win32') {
      const appPids = listWindowsImagePids(WIN_ANTIGRAVITY_IMAGES, { excludePids, env, runSpawn });
      const lsPids = listWindowsImagePids(WIN_LS_IMAGES, { excludePids, env, runSpawn });
      return [...new Set([...appPids, ...lsPids])];
    }
    return listPosixHostPids({ platform, targetExe, excludePids, runSpawn });
  };

  const initial = listAll();
  if (initial.length === 0) return;

  if (platform === 'win32') {
    try {
      runSpawn(
        'taskkill.exe',
        [...initial.flatMap((pid) => ['/PID', String(pid)]), '/T'],
        { stdio: 'ignore', windowsHide: true, timeout: 4000 },
      );
    } catch {
      // ignore
    }
  } else {
    for (const pid of initial) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  const gracefulDeadline = Date.now() + gracefulTimeoutMs;
  while (Date.now() < gracefulDeadline) {
    if (listAll().length === 0) {
      await sleep(350);
      return;
    }
    await sleep(pollMs);
  }

  const remaining = listAll();
  for (const pid of remaining) {
    try {
      process.kill(pid, platform === 'win32' ? undefined : 'SIGKILL');
    } catch {
      // ignore
    }
  }

  const forceDeadline = Date.now() + forceTimeoutMs;
  while (Date.now() < forceDeadline) {
    if (listAll().length === 0) break;
    await sleep(Math.min(pollMs, 150));
  }
  await sleep(350);
}

function captureFileTextSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { exists: false, text: '' };
    return { exists: true, text: fs.readFileSync(filePath, 'utf8') };
  } catch {
    return { exists: false, text: '' };
  }
}

function restoreFileTextSafe(filePath, snap) {
  if (!filePath || !snap) return;
  if (!snap.exists) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
    return;
  }
  atomicWriteUtf8Sync(filePath, snap.text || '');
}

function applyPosixTransaction(tx, { platform, env, home, runSpawn }) {
  const keychain = createPosixKeychainClient({ platform, env, runSpawn });
  const key = keychain.getOrCreateVaultMasterKey();
  const geminiDir = tx.geminiDir || path.join(home, '.gemini');
  const fallbackPath = path.join(geminiDir, 'jetski-standalone-oauth-token');
  const cliDir = path.join(geminiDir, 'antigravity-cli');
  const cliPath = fs.existsSync(cliDir) ? path.join(cliDir, 'antigravity-oauth-token') : '';

  const captureSnapshot = () => {
    const rawKeyring = keychain.readSecret(ACTIVE_KEYRING_SERVICE, ACTIVE_KEYRING_ACCOUNT);
    const onboarding = readAppStorageOnboarding(tx.roamingDir);
    return {
      keyring: rawKeyring !== null ? { exists: true, value: rawKeyring } : { exists: false, value: '' },
      desktopFallback: captureFileTextSafe(fallbackPath),
      cliSessionPath: cliPath,
      cliSession: cliPath ? captureFileTextSafe(cliPath) : null,
      onboardingBackup: onboarding ? { email: onboarding.email, isGcpTos: onboarding.isGcpTos } : null,
    };
  };

  const restoreSnapshot = (snap) => {
    if (!snap) return;
    if (snap.keyring?.exists) {
      keychain.writeSecret(ACTIVE_KEYRING_SERVICE, ACTIVE_KEYRING_ACCOUNT, snap.keyring.value, {
        label: 'Antigravity OAuth Credential',
      });
    }
    if (snap.desktopFallback) restoreFileTextSafe(fallbackPath, snap.desktopFallback);
    if (snap.cliSession && (snap.cliSessionPath || cliPath)) {
      restoreFileTextSafe(snap.cliSessionPath || cliPath, snap.cliSession);
    }
    if (snap.onboardingBackup?.email && tx.roamingDir) {
      applyAppStorageOnboarding(tx.roamingDir, snap.onboardingBackup);
    }
  };

  const preSnap = captureSnapshot();
  if (tx.backupFile) {
    try {
      atomicWriteUtf8Sync(tx.backupFile, sealAes256Gcm(JSON.stringify(preSnap), key));
    } catch {
      // non-fatal backup error
    }
  }

  try {
    if (tx.mode === 'rollback') {
      if (!tx.restoreBackupFile || !fs.existsSync(tx.restoreBackupFile)) {
        throw new Error('回滚备份快照文件不存在');
      }
      const cipherText = fs.readFileSync(tx.restoreBackupFile, 'utf8').trim();
      const snap = JSON.parse(openAes256Gcm(cipherText, key));
      restoreSnapshot(snap);
      return { ok: true, preSnap };
    }

    if (!tx.payloadFile || !fs.existsSync(tx.payloadFile)) {
      throw new Error('切号加密载荷文件缺失');
    }
    const cipherText = fs.readFileSync(tx.payloadFile, 'utf8').trim();
    const payload = JSON.parse(openAes256Gcm(cipherText, key));
    const credJson = String(payload?.credJson || '').trim();
    if (!credJson) {
      throw new Error('目标账号凭据内容为空');
    }

    // Anti-cross-account verification right before committing to native Keychain/Secret Service
    if (tx.targetEmail) {
      try {
        const parsedCred = JSON.parse(credJson);
        const embeddedEmail = String(parsedCred?.id_token_email || '').trim().toLowerCase();
        if (embeddedEmail && embeddedEmail !== String(tx.targetEmail).trim().toLowerCase()) {
          throw new Error(`防串号拦截：载荷邮箱 ${embeddedEmail} 与目标账号 ${tx.targetEmail} 不一致`);
        }
      } catch (e) {
        if (e?.message?.startsWith('防串号拦截')) throw e;
      }
    }

    const writeRes = keychain.writeSecret(ACTIVE_KEYRING_SERVICE, ACTIVE_KEYRING_ACCOUNT, credJson, {
      label: 'Antigravity OAuth Credential',
    });
    if (!writeRes.ok) {
      throw new Error(writeRes.error || '写入系统密钥库失败');
    }

    // Read-back verification
    const readBack = keychain.readSecret(ACTIVE_KEYRING_SERVICE, ACTIVE_KEYRING_ACCOUNT);
    if (!readBack || unwrapGoKeyringPayload(readBack).trim() !== credJson) {
      throw new Error('系统密钥库回读校验不一致');
    }

    atomicWriteUtf8Sync(fallbackPath, credJson);
    tx.desktopFallbackSynced = true;
    if (cliPath) {
      atomicWriteUtf8Sync(cliPath, credJson);
      tx.cliSessionSynced = true;
    }
    if (tx.onboardingSync?.email && tx.roamingDir) {
      const obRes = applyAppStorageOnboarding(tx.roamingDir, tx.onboardingSync);
      tx.onboardingSynced = Boolean(obRes.ok);
    }
    return { ok: true, preSnap };
  } catch (err) {
    try {
      restoreSnapshot(preSnap);
    } catch {
      // ignore rollback failure
    }
    throw err;
  }
}

async function relaunchTarget({
  platform,
  exePath,
  launchArgs,
  workDir,
  cleanEnv,
  spawnProcess,
  verifyDelayMs = 1200,
  runSpawn = spawnSync,
  excludePids = new Set(),
  skipAliveCheck = false,
}) {
  if (!exePath) return 0;
  const parsedArgs = parseLaunchArgsString(launchArgs);

  const attemptSpawn = (argsToPass) => {
    try {
      if (platform === 'darwin') {
        const openArgs = ['-n', '-a', exePath, ...(argsToPass.length ? ['--args', ...argsToPass] : [])];
        const child = spawnProcess('/usr/bin/open', openArgs, {
          env: cleanEnv,
          detached: true,
          stdio: 'ignore',
        });
        child?.unref?.();
        return child?.pid || 1;
      }
      const child = spawnProcess(exePath, argsToPass, {
        cwd: workDir && fs.existsSync(workDir) ? workDir : path.dirname(exePath),
        env: cleanEnv,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child?.unref?.();
      return child?.pid || 0;
    } catch {
      return 0;
    }
  };

  let pid = attemptSpawn(parsedArgs);
  if (skipAliveCheck) return pid || 1;
  await sleep(verifyDelayMs);

  const isRunningNow = () => {
    if (pid > 0 && isPidAlive(pid)) return true;
    if (platform === 'win32') {
      return listWindowsImagePids(WIN_ANTIGRAVITY_IMAGES, { excludePids, env: cleanEnv, runSpawn }).length > 0;
    }
    return listPosixHostPids({ platform, targetExe: exePath, excludePids, runSpawn }).length > 0;
  };

  if (isRunningNow()) return pid || 1;

  // Retry once without extra args in case custom args caused early exit
  if (parsedArgs.length > 0) {
    pid = attemptSpawn([]);
    await sleep(verifyDelayMs);
    if (isRunningNow()) return pid || 1;
  }
  return 0;
}

/**
 * Execute a queued switch or rollback transaction file end-to-end.
 */
export async function runSwitchTransaction(txPath, deps = {}) {
  if (!txPath || !fs.existsSync(txPath)) {
    return { ok: false, reason: 'tx_not_found' };
  }
  let tx;
  try {
    tx = JSON.parse(fs.readFileSync(txPath, 'utf8'));
  } catch {
    return { ok: false, reason: 'tx_parse_error' };
  }
  if (!tx || typeof tx !== 'object') {
    return { ok: false, reason: 'tx_invalid' };
  }

  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const home = deps.home || os.homedir();
  const runSpawn = deps.runSpawn || spawnSync;
  const spawnProcess = deps.spawnProcess || spawn;
  const settleMs = deps.settleMs ?? 400;
  const verifyDelayMs = deps.verifyDelayMs ?? 1200;
  const excludePids = new Set([process.pid, process.ppid].filter((n) => Number.isInteger(n) && n > 0));

  updateTxStage(txPath, tx, 'worker_started');
  if (tx.ackFile) {
    try {
      atomicWriteJsonSync(tx.ackFile, {
        id: tx.id || '',
        pid: process.pid,
        state: 'ready',
        atMs: Date.now(),
      });
    } catch {
      // non-fatal
    }
  }

  await sleep(settleMs);

  let preOnboarding = null;
  try {
    updateTxStage(txPath, tx, 'closing_host');
    await closeHostProcesses({
      platform,
      targetExe: tx.antigravityExe || '',
      excludePids,
      env,
      runSpawn,
      gracefulTimeoutMs: deps.gracefulTimeoutMs ?? 8000,
      forceTimeoutMs: deps.forceTimeoutMs ?? 3500,
      pollMs: deps.pollMs ?? 200,
      listHostPidsOverride: deps.listHostPids,
    });

    updateTxStage(txPath, tx, 'applying');
    if (tx.roamingDir) {
      preOnboarding = readAppStorageOnboarding(tx.roamingDir);
    }

    if (platform === 'win32') {
      const toolExe = String(tx.accountToolExe || '').trim();
      if (!toolExe || !fs.existsSync(toolExe)) {
        throw new Error('未找到 Windows 凭据助手 agy_account_tool.exe');
      }
      const applyRes = runSpawn(toolExe, ['--apply-switch-tx', txPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 20000,
      });
      if (applyRes.error || applyRes.status !== 0) {
        let errDetail = String(applyRes.stderr || applyRes.stdout || applyRes.error?.message || '').trim();
        try {
          const parsedErr = JSON.parse(String(applyRes.stdout || '{}'));
          if (parsedErr?.error) errDetail = parsedErr.error;
        } catch {
          // keep raw error text
        }
        throw new Error(errDetail || 'Windows 凭据写入失败');
      }
      // Reload tx metadata updated by AgyAccountTool.exe
      try {
        const refreshed = JSON.parse(fs.readFileSync(txPath, 'utf8'));
        if (refreshed && typeof refreshed === 'object') Object.assign(tx, refreshed);
      } catch {
        // ignore
      }

      // Gated app_storage.json onboarding sync AFTER Antigravity exited & credential verified
      if (tx.mode === 'switch' && tx.onboardingSync?.email && tx.roamingDir) {
        const obRes = applyAppStorageOnboarding(tx.roamingDir, tx.onboardingSync);
        tx.onboardingSynced = Boolean(obRes.ok);
      }
      if (tx.mode === 'switch' && preOnboarding?.email && tx.backupFile) {
        // Persist onboarding companion metadata next to backup snapshot for clean rollback
        try {
          atomicWriteJsonSync(`${tx.backupFile}.onboarding.json`, {
            email: preOnboarding.email,
            isGcpTos: preOnboarding.isGcpTos,
          });
        } catch {
          // non-fatal
        }
      }
      if (tx.mode === 'rollback' && tx.restoreBackupFile && tx.roamingDir) {
        const obBackupPath = `${tx.restoreBackupFile}.onboarding.json`;
        if (fs.existsSync(obBackupPath)) {
          try {
            const savedOb = JSON.parse(fs.readFileSync(obBackupPath, 'utf8'));
            if (savedOb?.email) {
              applyAppStorageOnboarding(tx.roamingDir, savedOb);
            }
          } catch {
            // non-fatal
          }
        }
      }
    } else {
      applyPosixTransaction(tx, { platform, env, home, runSpawn });
    }

    if (tx.payloadFile) {
      try {
        if (fs.existsSync(tx.payloadFile)) fs.unlinkSync(tx.payloadFile);
      } catch {
        // ignore
      }
    }

    updateTxStage(txPath, tx, 'relaunching');
    const cleanEnv = buildCleanWorkerEnv(env);
    const relaunchedPid = await relaunchTarget({
      platform,
      exePath: tx.antigravityExe || '',
      launchArgs: tx.launchArgs || '',
      workDir: tx.workDir || '',
      cleanEnv,
      spawnProcess,
      verifyDelayMs,
      runSpawn,
      excludePids,
      skipAliveCheck: Boolean(deps.skipAliveCheck),
    });
    tx.relaunchedPid = relaunchedPid;
    updateTxStage(
      txPath,
      tx,
      relaunchedPid > 0 ? 'done' : 'relaunch_failed',
      relaunchedPid > 0 ? '' : 'Antigravity 未能保持运行，请手动重新启动',
    );
    return { ok: relaunchedPid > 0, relaunchedPid, tx };
  } catch (err) {
    if (tx.payloadFile) {
      try {
        if (fs.existsSync(tx.payloadFile)) fs.unlinkSync(tx.payloadFile);
      } catch {
        // ignore
      }
    }
    if (preOnboarding?.email && tx.roamingDir) {
      try {
        applyAppStorageOnboarding(tx.roamingDir, preOnboarding);
      } catch {
        // ignore
      }
    }
    const errMsg = err?.message || String(err);
    updateTxStage(txPath, tx, 'failed', errMsg);
    // Always bring Antigravity back so user is never left stranded with IDE closed
    try {
      const cleanEnv = buildCleanWorkerEnv(env);
      await relaunchTarget({
        platform,
        exePath: tx.antigravityExe || '',
        launchArgs: tx.launchArgs || '',
        workDir: tx.workDir || '',
        cleanEnv,
        spawnProcess,
        verifyDelayMs: Math.min(verifyDelayMs, 600),
        runSpawn,
        excludePids,
        skipAliveCheck: Boolean(deps.skipAliveCheck),
      });
    } catch {
      // ignore
    }
    return { ok: false, error: errMsg, tx };
  }
}

function isDirectEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    const a = fs.realpathSync(path.resolve(process.argv[1]));
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isDirectEntrypoint()) {
  runSwitchTransaction(process.argv[2]).then(
    (res) => {
      process.exitCode = res?.ok ? 0 : 1;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
