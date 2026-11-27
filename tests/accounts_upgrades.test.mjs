import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AES_GCM_ENVELOPE_PREFIX,
  GO_KEYRING_B64_PREFIX,
  applyAppStorageOnboarding,
  buildMacKeychainReadScript,
  buildMacKeychainWriteScript,
  createPosixAccountDriver,
  createPosixKeychainClient,
  openAes256Gcm,
  readAppStorageOnboarding,
  resolveAntigravityUserDataDir,
  sealAes256Gcm,
  unwrapGoKeyringPayload,
} from '../sidecars/agy_monitor/backend/account_driver_posix.mjs';
import {
  buildCleanWorkerEnv,
  parseLaunchArgsString,
  parseWindowsTasklistPids,
  runSwitchTransaction,
} from '../sidecars/agy_monitor/accounts/switch_worker.mjs';
import {
  checkCrossAccountCollision,
  createAccountManager,
  createPlatformAccountDriver,
  ensureAccountTool,
} from '../sidecars/agy_monitor/backend/accounts.mjs';
import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';

test('onboarding sync: reads/writes app_storage.json atomically without touching unrelated keys', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-onboarding-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const storagePath = path.join(tmpDir, 'app_storage.json');
  fs.writeFileSync(
    storagePath,
    JSON.stringify(
      {
        'agy.theme': 'dark',
        'jetski.onboarding.lastLoginUsername': 'legacy@gmail.com',
        'jetski.onboarding.lastLoginIsGcpTos': 'true',
        nested: { keep: 123 },
      },
      null,
      2,
    ),
    'utf8',
  );

  const before = readAppStorageOnboarding(tmpDir);
  assert.equal(before.email, 'legacy@gmail.com');
  assert.equal(before.isGcpTos, true);

  const applied = applyAppStorageOnboarding(tmpDir, { email: 'Returning@Gmail.com', isGcpTos: false });
  assert.equal(applied.ok, true);

  const afterDisk = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  assert.equal(afterDisk['agy.onboarding.lastLoginUsername'], 'returning@gmail.com');
  assert.equal(afterDisk['agy.onboarding.lastLoginIsGcpTos'], 'false');
  assert.equal(afterDisk['agy.theme'], 'dark');
  assert.deepEqual(afterDisk.nested, { keep: 123 });

  const afterRead = readAppStorageOnboarding(tmpDir);
  assert.equal(afterRead.email, 'returning@gmail.com');
  assert.equal(afterRead.isGcpTos, false);
});

test('cross-platform native keyring: macOS Keychain stdin/JXA (zero argv secrets) & Linux Secret Service', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-posix-cred-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 1. go-keyring-base64: unwrapping & AES-256-GCM envelope
  const sampleJson = JSON.stringify({ token: { refresh_token: '1//0ePOSIX_RT' }, id_token_email: 'mac@gmail.com' });
  const wrapped = `${GO_KEYRING_B64_PREFIX}${Buffer.from(sampleJson, 'utf8').toString('base64')}`;
  assert.equal(unwrapGoKeyringPayload(wrapped), sampleJson);

  const key = crypto.randomBytes(32);
  const sealed = sealAes256Gcm('super-secret-vault-json', key);
  assert.ok(sealed.startsWith(AES_GCM_ENVELOPE_PREFIX));
  assert.equal(openAes256Gcm(sealed, key), 'super-secret-vault-json');

  // 2. macOS Keychain mock: compact payloads use `/usr/bin/security -i` via stdin, >3.8KB uses JXA stdin with Google TeamID ACL
  const macStore = new Map();
  const macCalls = [];
  const macSpawn = (cmd, args, opts = {}) => {
    macCalls.push({ cmd, args, hasInput: Boolean(opts.input) });
    // SECURITY INVARIANT: secrets must NEVER appear in CLI args
    for (const a of args || []) {
      assert.equal(String(a).includes('1//0e'), false, 'Secret leaked into CLI argv!');
    }
    if (cmd === '/usr/bin/security' && args[0] === 'help') return { status: 0 };
    if (cmd === '/usr/bin/security' && args[0] === '-i') {
      const line = String(opts.input || '').trim();
      const mHex = /add-generic-password -U -s "([^"]+)" -a "([^"]+)" -X ([0-9a-f]+)/i.exec(line);
      if (mHex) {
        macStore.set(`${mHex[1]}::${mHex[2]}`, Buffer.from(mHex[3], 'hex').toString('utf8'));
        return { status: 0, stderr: '' };
      }
      const mRaw = /add-generic-password -U -s "([^"]+)" -a "([^"]+)" -w '([^']*)'/i.exec(line);
      if (mRaw) {
        macStore.set(`${mRaw[1]}::${mRaw[2]}`, mRaw[3]);
        return { status: 0, stderr: '' };
      }
      return { status: 1, stderr: 'unparsed security -i command' };
    }
    if (cmd === '/usr/bin/security' && args[0] === 'find-generic-password') {
      const svc = args[args.indexOf('-s') + 1];
      const acct = args[args.indexOf('-a') + 1];
      const val = macStore.get(`${svc}::${acct}`);
      return val !== undefined ? { status: 0, stdout: Buffer.from(`${val}\n`, 'utf8') } : { status: 44 };
    }
    if (cmd === '/usr/bin/osascript') {
      const script = String(opts.input || '');
      const svcMatch = /const service = \$\("([^"]+)"\)/.exec(script);
      const acctMatch = /const account = \$\("([^"]+)"\)/.exec(script);
      const dataMatch = /initWithBase64EncodedStringOptions\(\$\("([^"]+)"\)/.exec(script);
      if (svcMatch && acctMatch && dataMatch) {
        assert.ok(script.includes('teamid:EQHXZ8M8AV'), 'JXA write must preserve Antigravity partition ACL');
        macStore.set(`${svcMatch[1]}::${acctMatch[1]}`, Buffer.from(dataMatch[1], 'base64').toString('utf8'));
        return { status: 0, stdout: Buffer.alloc(0), stderr: '' };
      }
      if (svcMatch && acctMatch) {
        const val = macStore.get(`${svcMatch[1]}::${acctMatch[1]}`);
        return val !== undefined
          ? { status: 0, stdout: Buffer.from(`${Buffer.from(val, 'utf8').toString('base64')}\n`, 'utf8') }
          : { status: 1 };
      }
      return { status: 1 };
    }
    return { status: 1 };
  };

  assert.ok(buildMacKeychainReadScript({ service: 'gemini', account: 'antigravity' }).includes('SecItemCopyMatching'));
  assert.ok(
    buildMacKeychainWriteScript({ service: 'gemini', account: 'antigravity', dataBase64: 'e30=' }).includes(
      'teamid:EQHXZ8M8AV',
    ),
  );

  const macDriver = createPosixAccountDriver(
    resolvePaths({ appDataDir: path.join(tmpDir, 'appdata'), geminiConfigDir: path.join(tmpDir, 'cfg') }),
    null,
    { platform: 'darwin', home: tmpDir, env: {}, runSpawn: macSpawn },
  );
  assert.equal(macDriver.backend, 'darwin-keychain');
  assert.equal(macDriver.isSupported(), true);

  // Protect/unprotect seals via Keychain master key
  const macSealed = await macDriver.protectSecret('hello-mac-vault');
  assert.equal(await macDriver.unprotectSecret(macSealed), 'hello-mac-vault');

  // Compact write -> security -i, large (>4KB) write -> JXA stdin
  await macDriver.writeLiveCredential(sampleJson);
  const liveRead = await macDriver.readLiveCredential();
  assert.equal(liveRead.found, true);
  assert.equal(liveRead.credJson, sampleJson);

  const bigCred = JSON.stringify({
    token: { access_token: 'ya29.' + 'a'.repeat(4200), refresh_token: '1//0eBIG_MAC_RT' },
    id_token_email: 'big@gmail.com',
  });
  await macDriver.writeLiveCredential(bigCred);
  assert.ok(macCalls.some((c) => c.cmd === '/usr/bin/osascript' && c.hasInput));
  assert.equal((await macDriver.readLiveCredential()).credJson, bigCred);

  // 3. Linux Secret Service mock (`secret-tool` stdin) + headless missing-session refusal
  const headlessLinux = createPosixKeychainClient({
    platform: 'linux',
    env: {},
    runSpawn: () => ({ status: 0 }),
  });
  assert.equal(headlessLinux.probe().supported, false);

  const linuxStore = new Map();
  const linuxSpawn = (cmd, args, opts = {}) => {
    assert.equal(cmd, 'secret-tool');
    for (const a of args || []) {
      assert.equal(String(a).includes('1//0e'), false, 'Secret leaked into secret-tool argv!');
    }
    if (args[0] === '--version') return { status: 0, stdout: 'secret-tool 0.21' };
    if (args[0] === 'store') {
      const svc = args[args.indexOf('service') + 1];
      const user = args[args.indexOf('username') + 1];
      linuxStore.set(`${svc}::${user}`, Buffer.from(opts.input || '').toString('utf8'));
      return { status: 0 };
    }
    if (args[0] === 'lookup') {
      const svc = args[args.indexOf('service') + 1];
      const user = args[args.indexOf('username') + 1];
      const val = linuxStore.get(`${svc}::${user}`);
      return val !== undefined ? { status: 0, stdout: Buffer.from(val, 'utf8') } : { status: 1 };
    }
    return { status: 1 };
  };

  const linuxDriver = createPosixAccountDriver(
    resolvePaths({ appDataDir: path.join(tmpDir, 'appdata2'), geminiConfigDir: path.join(tmpDir, 'cfg2') }),
    null,
    { platform: 'linux', home: tmpDir, env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/bus' }, runSpawn: linuxSpawn },
  );
  assert.equal(linuxDriver.backend, 'linux-secret-service');
  assert.equal(linuxDriver.isSupported(), true);
  assert.equal(resolveAntigravityUserDataDir({ platform: 'darwin', home: '/Users/demo' }).endsWith('Antigravity'), true);

  const linuxSealed = await linuxDriver.protectSecret('hello-linux-vault');
  assert.equal(await linuxDriver.unprotectSecret(linuxSealed), 'hello-linux-vault');
  await linuxDriver.writeLiveCredential(wrapped);
  assert.equal((await linuxDriver.readLiveCredential()).credJson, sampleJson);

  // Platform factory picks appropriate driver
  assert.equal(createPlatformAccountDriver(resolvePaths({ appDataDir: tmpDir }), null, { platform: 'darwin', runSpawn: macSpawn }).backend, 'darwin-keychain');
});

test('anti-cross-account guards block email/refreshHash collision before switch and self-heal on post-restart switchMismatch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mismatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const roamingDir = path.join(root, 'roaming');
  fs.mkdirSync(roamingDir, { recursive: true });
  fs.writeFileSync(
    path.join(roamingDir, 'app_storage.json'),
    JSON.stringify({
      'agy.onboarding.lastLoginUsername': 'alice@gmail.com',
      'agy.onboarding.lastLoginIsGcpTos': 'true',
    }),
    'utf8',
  );

  let liveCred = {
    token: { access_token: 'ya29.alice', refresh_token: '1//0eALICE_RT_UNIQUE', expiry: new Date(Date.now() + 3600_000).toISOString() },
    auth_method: 'consumer',
    id_token_email: 'alice@gmail.com',
  };
  const launchedTxs = [];
  const driver = {
    backend: 'mock-driver',
    isSupported: () => true,
    getRoamingDir: () => roamingDir,
    async ensureReady() {
      return { supported: true, compiled: true, exePath: 'mock_tool.exe' };
    },
    async readLiveCredential() {
      return { found: true, credJson: JSON.stringify(liveCred) };
    },
    async protectSecret(txt) {
      return 'SEALED::' + Buffer.from(txt, 'utf8').toString('base64');
    },
    async unprotectSecret(c) {
      return Buffer.from(c.slice('SEALED::'.length), 'base64').toString('utf8');
    },
    async detectAntigravityLaunchConfig() {
      return { exePath: 'C:\\Mock\\Antigravity.exe', launchArgs: '', workDir: 'C:\\Mock' };
    },
    async launchSwitchDaemon(txPath) {
      launchedTxs.push(JSON.parse(fs.readFileSync(txPath, 'utf8')));
      return { ok: true, launched: true };
    },
  };

  let nowMs = Date.parse('2026-11-27T11:00:00Z');
  const paths = resolvePaths({
    appDataDir: path.join(root, 'antigravity'),
    geminiConfigDir: path.join(root, 'config'),
  });
  const mgr = createAccountManager({
    paths,
    storage: createStorage(paths),
    driver,
    now: () => nowMs,
    onBeforeHostClose: async () => {},
  });

  // 1. Capture live Alice -> captures onboardingAccepted + isGcpTos from app_storage.json
  const capAlice = await mgr.captureCurrentAccount();
  assert.equal(capAlice.ok, true);

  // 2. Import Bob with a duplicate refresh_token matching Alice -> switch MUST abort with 409 CREDENTIAL_MISMATCH!
  const impDup = await mgr.importAccounts({
    rawInput: JSON.stringify({
      email: 'bob@gmail.com',
      credential: {
        token: { access_token: 'ya29.dup', refresh_token: '1//0eALICE_RT_UNIQUE', expiry: new Date(nowMs + 3600_000).toISOString() },
        auth_method: 'consumer',
        id_token_email: 'bob@gmail.com',
      },
    }),
  });
  assert.equal(impDup.ok, true);
  const bobId = impDup.accounts[0].id;
  const blockedDup = await mgr.switchAccount({ accountId: bobId, autoResume: false });
  assert.equal(blockedDup.ok, false);
  assert.equal(blockedDup.status, 409);
  assert.equal(blockedDup.code, 'CREDENTIAL_MISMATCH');
  assert.equal(launchedTxs.length, 0);

  // Direct unit check on embedded email mismatch
  const emailCheck = checkCrossAccountCollision([], {
    targetId: 'acc_x',
    targetEmail: 'carol@gmail.com',
    targetCredObj: { id_token_email: 'wrong@gmail.com' },
    targetRefreshHash: 'abc123',
  });
  assert.equal(emailCheck.ok, false);
  assert.equal(emailCheck.code, 'CREDENTIAL_MISMATCH');

  // 3. Re-import Bob with his own unique RT & switch -> succeeds, omits onboardingSync (un-onboarded import)
  await mgr.importAccounts({
    rawInput: JSON.stringify({
      email: 'bob@gmail.com',
      credential: {
        token: { access_token: 'ya29.bob', refresh_token: '1//0eBOB_RT_UNIQUE', expiry: new Date(nowMs + 3600_000).toISOString() },
        auth_method: 'consumer',
        id_token_email: 'bob@gmail.com',
      },
    }),
  });
  const swBob = await mgr.switchAccount({ accountId: bobId, autoResume: false });
  assert.equal(swBob.ok, true);
  assert.equal(launchedTxs.length, 1);
  assert.equal(launchedTxs[0].onboardingSync, undefined);

  // 4. Simulate Antigravity restarting into Alice (mismatch!) after tx stage='done' -> self-heals & poisons Bob's slot!
  const txOnDisk = JSON.parse(fs.readFileSync(paths.accountSwitchTxFile, 'utf8'));
  txOnDisk.stage = 'done';
  txOnDisk.updatedAtMs = nowMs + 1000;
  fs.writeFileSync(paths.accountSwitchTxFile, JSON.stringify(txOnDisk, null, 2), 'utf8');
  nowMs += 2000;

  const afterMismatch = await mgr.listAccounts();
  assert.equal(afterMismatch.lastSwitchMismatch?.expectedEmail, 'bob@gmail.com');
  assert.equal(afterMismatch.lastSwitchMismatch?.actualEmail, 'alice@gmail.com');
  const bobAfter = afterMismatch.accounts.find((a) => a.id === bobId);
  assert.equal(bobAfter.accountStatus.code, 'CREDENTIAL_MISMATCH');
  assert.equal(bobAfter.accountStatus.blocking, true);

  // Subsequent attempt to switch to poisoned Bob is blocked until re-authorized!
  const blockedPoisoned = await mgr.switchAccount({ accountId: bobId, autoResume: false });
  assert.equal(blockedPoisoned.ok, false);
  assert.equal(blockedPoisoned.status, 409);
  assert.equal(blockedPoisoned.code, 'CREDENTIAL_MISMATCH');

  // 5. Switching to already-onboarded Alice carries onboardingSync with email + isGcpTos=true
  const swAlice = await mgr.switchAccount({ accountId: capAlice.account.id, autoResume: false });
  assert.equal(swAlice.ok, true);
  assert.deepEqual(launchedTxs.at(-1).onboardingSync, {
    email: 'alice@gmail.com',
    isGcpTos: true,
  });
});

test('static pure-Node switch_worker.mjs handles taskkill/relaunch without VBS/PowerShell and AgyAccountTool.cs compiles cleanly', async (t) => {
  // 1. Helpers sanity
  assert.deepEqual(parseLaunchArgsString('--remote-debugging-port=9229 --user-data="C:\\My Dir"'), [
    '--remote-debugging-port=9229',
    '--user-data=C:\\My Dir',
  ]);
  assert.deepEqual(
    parseWindowsTasklistPids('"Antigravity.exe","1234","Console","1","100 K"\r\n"notepad.exe","555","Console","1","10 K"\r\n', {
      excludePids: new Set([9999]),
    }),
    [1234],
  );
  const cleaned = buildCleanWorkerEnv({
    PATH: 'C:\\Windows',
    ELECTRON_RUN_AS_NODE: '1',
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9999',
    AGY_MONITOR_TOKEN: 'secret',
  });
  assert.equal(cleaned.PATH, 'C:\\Windows');
  assert.equal('ELECTRON_RUN_AS_NODE' in cleaned, false);
  assert.equal('ANTIGRAVITY_LS_ADDRESS' in cleaned, false);
  assert.equal('AGY_MONITOR_TOKEN' in cleaned, false);

  // 2. Verify accounts.mjs no longer launches wscript.exe or writes run_switch_daemon.vbs
  const accountsSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'sidecars/agy_monitor/backend/accounts.mjs'),
    'utf8',
  );
  assert.equal(accountsSrc.includes("spawn('wscript.exe'"), false, 'Must not spawn wscript.exe');
  assert.ok(accountsSrc.includes('STATIC_SWITCH_WORKER_PATH'), 'Must spawn static switch_worker.mjs');

  // 3. End-to-end mocked runSwitchTransaction on win32 verifying taskkill, --apply-switch-tx, app_storage sync, and clean relaunch
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-worker-tx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const roamingDir = path.join(root, 'roaming');
  fs.mkdirSync(roamingDir, { recursive: true });
  fs.writeFileSync(
    path.join(roamingDir, 'app_storage.json'),
    JSON.stringify({ 'agy.onboarding.lastLoginUsername': 'old@gmail.com', keepMe: true }),
    'utf8',
  );
  const fakeToolExe = path.join(root, 'agy_account_tool.exe');
  fs.writeFileSync(fakeToolExe, 'MZ');
  const fakePayload = path.join(root, 'payload.dat');
  fs.writeFileSync(fakePayload, 'SEALED');
  const backupFile = path.join(root, 'pre.bak.dat');
  const txPath = path.join(root, 'switch_transaction.json');
  fs.writeFileSync(
    txPath,
    JSON.stringify({
      id: 'tx_worker_test',
      mode: 'switch',
      stage: 'queued',
      targetEmail: 'new@gmail.com',
      roamingDir,
      antigravityExe: 'C:\\Mock\\Antigravity.exe',
      launchArgs: '--remote-debugging-port=9229',
      workDir: 'C:\\Mock',
      accountToolExe: fakeToolExe,
      onboardingSync: { email: 'new@gmail.com', isGcpTos: true },
      payloadFile: fakePayload,
      backupFile,
    }),
    'utf8',
  );

  const runCalls = [];
  const spawnCalls = [];
  let hostAliveChecks = 0;
  const res = await runSwitchTransaction(txPath, {
    platform: 'win32',
    env: { PATH: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1' },
    settleMs: 1,
    verifyDelayMs: 1,
    pollMs: 1,
    skipAliveCheck: true,
    listHostPids: () => {
      hostAliveChecks += 1;
      return hostAliveChecks === 1 ? [4321] : [];
    },
    runSpawn: (cmd, args) => {
      runCalls.push({ cmd, args });
      return { status: 0, stdout: '{"ok":true}', stderr: '' };
    },
    spawnProcess: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, env: opts.env, detached: opts.detached });
      return { pid: 8888, unref() {} };
    },
  });

  assert.equal(res.ok, true);
  assert.ok(runCalls.some((c) => c.cmd === 'taskkill.exe' && c.args.includes('/PID') && c.args.includes('4321')));
  assert.ok(runCalls.some((c) => c.cmd === fakeToolExe && c.args[0] === '--apply-switch-tx'));
  assert.equal(fs.existsSync(fakePayload), false, 'One-time payload must be removed');
  assert.equal(fs.existsSync(`${backupFile}.onboarding.json`), true, 'Onboarding backup must be saved');
  assert.equal(readAppStorageOnboarding(roamingDir).email, 'new@gmail.com');
  assert.equal(readAppStorageOnboarding(roamingDir).isGcpTos, true);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, 'C:\\Mock\\Antigravity.exe');
  assert.deepEqual(spawnCalls[0].args, ['--remote-debugging-port=9229']);
  assert.equal('ELECTRON_RUN_AS_NODE' in spawnCalls[0].env, false);
  assert.equal(spawnCalls[0].detached, true);

  // 4. On Windows, verify AgyAccountTool.cs compiles cleanly with --apply-switch-tx support
  if (process.platform === 'win32') {
    const compilePaths = resolvePaths({ appDataDir: path.join(root, 'compile-appdata') });
    const compiled = await ensureAccountTool(compilePaths);
    assert.equal(compiled.compiled, true, compiled.reason || 'AgyAccountTool.cs failed to compile');
  }
});
