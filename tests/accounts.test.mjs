import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';
import {
  ACCOUNT_EXPORT_SCHEMA,
  buildCleanLaunchEnv,
  createAccountManager,
  fetchCloudCodeQuotaForCredential,
  inspectQuotaExhaustion,
  isFiveHourQuotaExhausted,
  mapModelToQuotaGroup,
  normalizeAccountSettings,
  parseImportPayload,
  parseQuotaExhaustedStepError,
  parseWindowsProxyServer,
  requestOverProxy,
  resolveSystemProxyUrl,
  selectBestAutoSwitchCandidate,
  shouldBypassProxy,
} from '../sidecars/agy_monitor/backend/accounts.mjs';
import { buildFrontendBundle } from '../sidecars/agy_monitor/backend/bundle_builder.mjs';
import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import { createMonitorHandlers } from '../sidecars/agy_monitor/main.mjs';

function makeFakeJwt(payloadObj) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  return `${header}.${payload}.sig`;
}

function createMockDriver(initialLive = null) {
  let live = initialLive;
  const launchedTxs = [];
  const prefix = 'MOCK_DPAPI_SEALED::';

  return {
    launchedTxs,
    setLive(next) {
      live = next;
    },
    isSupported() {
      return true;
    },
    getRoamingDir() {
      return path.join(os.tmpdir(), 'mock-agy-roaming');
    },
    async ensureReady() {
      return { supported: true, compiled: true, exePath: 'mock.exe' };
    },
    async readLiveCredential() {
      if (!live) return { found: false };
      return {
        found: true,
        credTarget: 'gemini:antigravity',
        credUserName: 'antigravity',
        credPersist: 2,
        credJson: JSON.stringify(live.credObj),
        credentialUserScope: live.scope || 'scope_abc123',
        lastWrittenUtc: new Date().toISOString(),
      };
    },
    async protectSecret(plainText) {
      return prefix + Buffer.from(String(plainText), 'utf8').toString('base64');
    },
    async unprotectSecret(cipherText) {
      assert.ok(String(cipherText).startsWith(prefix), 'Expected sealed ciphertext');
      return Buffer.from(String(cipherText).slice(prefix.length), 'base64').toString('utf8');
    },
    async detectAntigravityLaunchConfig() {
      return {
        exePath: 'C:\\Mock\\Antigravity.exe',
        launchArgs: '--remote-debugging-port=9229',
        workDir: 'C:\\Mock',
      };
    },
    async launchSwitchDaemon(txPath) {
      launchedTxs.push(JSON.parse(fs.readFileSync(txPath, 'utf8')));
      return { ok: true, launched: true };
    },
  };
}

function createFixture(t, { liveCred = null, quotaPayload = null, sendLog = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-accounts-test-'));
  const paths = resolvePaths({
    appDataDir: path.join(root, 'antigravity'),
    geminiConfigDir: path.join(root, 'config'),
    pluginDataDir: path.join(root, 'antigravity', 'plugin_data', 'agy-monitor'),
    sidecarDataDir: path.join(root, 'antigravity', 'sidecar_data', 'agy-monitor', 'agy_monitor', 'data'),
  });
  const storage = createStorage(paths);
  const driver = createMockDriver(liveCred);

  let currentQuota = quotaPayload;
  const quotaClient = {
    setQuota(q) {
      currentQuota = q;
    },
    async getQuotaSummary() {
      return currentQuota || { ok: false, available: false, groups: [] };
    },
  };

  const sidecarBridge = {
    sendMessage(convId, message) {
      sendLog.push({ convId, message });
      return { ok: true };
    },
  };

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, paths, storage, driver, quotaClient, sidecarBridge };
}

function makeSampleQuota(pctGemini = 80, pctGpt = 65, pctArgon = 100, resetTimeMs = Date.now() + 3600_000) {
  return {
    ok: true,
    available: true,
    fetchedAtMs: Date.now(),
    groups: [
      {
        key: 'gemini',
        label: 'Gemini',
        displayName: 'Gemini Models',
        fiveHour: { remainingFraction: pctGemini / 100, remainingPct: pctGemini, remainingPctExact: pctGemini, resetTimeMs, isFull: pctGemini === 100, disabled: false },
        weekly: { remainingFraction: 0.9, remainingPct: 90, remainingPctExact: 90, resetTimeMs: resetTimeMs + 86400_000, isFull: false, disabled: false },
      },
      {
        key: 'gpt_claude',
        label: 'GPT&Claude',
        displayName: 'Claude and GPT models',
        fiveHour: { remainingFraction: pctGpt / 100, remainingPct: pctGpt, remainingPctExact: pctGpt, resetTimeMs, isFull: pctGpt === 100, disabled: false },
        weekly: { remainingFraction: 0.75, remainingPct: 75, remainingPctExact: 75, resetTimeMs: resetTimeMs + 86400_000, isFull: false, disabled: false },
      },
      {
        key: 'argon',
        label: 'Argon',
        displayName: 'Gemini 4 Argon',
        fiveHour: { remainingFraction: pctArgon / 100, remainingPct: pctArgon, remainingPctExact: pctArgon, resetTimeMs: null, isFull: pctArgon === 100, disabled: false },
        weekly: null,
      },
    ],
  };
}

test('parseImportPayload supports exported JSON, raw Antigravity JSON, JWT email, and batch refresh tokens', () => {
  // 1. Raw Antigravity credential JSON
  const r1 = parseImportPayload(
    JSON.stringify({
      token: { access_token: 'ya29.test', refresh_token: '1//0eRawRefreshToken123456', token_type: 'Bearer' },
      auth_method: 'oauth',
      id_token_email: 'alice@gmail.com',
    }),
  );
  assert.equal(r1.ok, true);
  assert.equal(r1.items.length, 1);
  assert.equal(r1.items[0].email, 'alice@gmail.com');

  // 2. Flat JSON with id_token JWT email auto-extraction
  const jwt = makeFakeJwt({ email: 'jwt.user@gmail.com' });
  const r2 = parseImportPayload(
    JSON.stringify({ refresh_token: '1//0eJwtRefreshToken123456', id_token: jwt }),
    { fallbackRemark: 'JWT号' },
  );
  assert.equal(r2.ok, true);
  assert.equal(r2.items[0].email, 'jwt.user@gmail.com');
  assert.equal(r2.items[0].remark, 'JWT号');

  // 3. Multi-line CSV/plain refresh_token batch
  const r3 = parseImportPayload(
    'bob@gmail.com,1//0eBobToken123456789012,备用1\ncarol@gmail.com,1//0eCarolToken1234567890,备用2',
  );
  assert.equal(r3.ok, true);
  assert.equal(r3.items.length, 2);
  assert.equal(r3.items[0].email, 'bob@gmail.com');
  assert.equal(r3.items[0].remark, '备用1');
  assert.equal(r3.items[1].email, 'carol@gmail.com');

  // 4. Reject invalid JSON / empty input
  assert.equal(parseImportPayload('').ok, false);
  assert.equal(parseImportPayload('{invalid-json').ok, false);
  assert.equal(parseImportPayload(JSON.stringify({ email: 'no-token@gmail.com' })).ok, false);
});

test('capture, encrypted vault isolation, remark, toggle, export/import roundtrip, quota refresh, and delete', async (t) => {
  const secretToken = '1//0eSUPER_SECRET_REFRESH_TOKEN_999';
  const { paths, storage, driver, quotaClient, sidecarBridge } = createFixture(t, {
    liveCred: {
      credObj: {
        token: { access_token: 'ya29.live_access', refresh_token: secretToken, token_type: 'Bearer' },
        auth_method: 'oauth',
        id_token_email: 'main@gmail.com',
      },
      scope: 'scope_main_001',
    },
    quotaPayload: makeSampleQuota(82, 55, 100),
  });

  const remoteCalls = [];
  const mgr = createAccountManager({
    paths,
    storage,
    quotaClient,
    sidecarBridge,
    driver,
    remoteQuotaFetcher: async (credObj, opts) => {
      remoteCalls.push({ refreshToken: credObj?.token?.refresh_token, cachedProjectId: opts?.cachedProjectId });
      return {
        ok: true,
        quota: makeSampleQuota(77, 88, 95),
        projectId: 'proj-remote-123',
        source: 'retrieveUserQuotaSummary',
        updatedCredObj: {
          ...credObj,
          token: {
            ...credObj.token,
            access_token: 'ya29.renewed_remote_token',
            expiry: new Date(Date.now() + 3600_000).toISOString(),
          },
        },
        renewed: true,
      };
    },
    onBeforeHostClose: async () => {},
  });

  // 1. Capture current live account
  const cap = await mgr.captureCurrentAccount({ remark: '主力 Pro' });
  assert.equal(cap.ok, true);
  assert.equal(cap.isNew, true);
  assert.equal(cap.account.email, 'main@gmail.com');
  assert.equal(cap.account.remark, '主力 Pro');
  assert.equal(cap.account.isCurrent, true);
  assert.equal(cap.account.quota.groups.length, 3);
  assert.equal(cap.account.quota.groups[0].fiveHour.remainingPct, 82);

  // 2. Verify zero plaintext token on disk (neither index nor encrypted vault contains raw token)
  const indexRaw = fs.readFileSync(paths.accountsIndexFile, 'utf8');
  const vaultRaw = fs.readFileSync(paths.accountsVaultFile, 'utf8');
  assert.equal(indexRaw.includes(secretToken), false);
  assert.equal(indexRaw.includes('ya29.live_access'), false);
  assert.equal(vaultRaw.includes(secretToken), false);
  assert.ok(vaultRaw.startsWith('MOCK_DPAPI_SEALED::'));

  // 3. Edit remark & toggle enabled
  const rem = await mgr.updateAccountRemark(cap.account.id, '改名主力');
  assert.equal(rem.ok, true);
  assert.equal(rem.account.remark, '改名主力');

  const dis = await mgr.toggleAccountEnabled(cap.account.id, false);
  assert.equal(dis.ok, true);
  assert.equal(dis.account.enabled, false);

  // Disabled account cannot be switched to
  const blockedSwitch = await mgr.switchAccount({ accountId: cap.account.id });
  assert.equal(blockedSwitch.ok, false);
  assert.equal(blockedSwitch.status, 400);

  await mgr.toggleAccountEnabled(cap.account.id, true);

  // 4. Export JSON & verify schema + re-import into a second account
  const exp = await mgr.exportAccountJson(cap.account.id);
  assert.equal(exp.ok, true);
  assert.equal(exp.data.schema, ACCOUNT_EXPORT_SCHEMA);
  assert.equal(exp.data.email, 'main@gmail.com');
  assert.equal(exp.data.credential.token.refresh_token, secretToken);

  const pastReset = Date.now() - 60_000;
  const secondImp = await mgr.importAccounts({
    rawInput: JSON.stringify({
      email: 'backup@gmail.com',
      remark: '备用小号',
      credential: {
        token: { refresh_token: '1//0eBACKUP_REFRESH_TOKEN_777', token_type: 'Bearer' },
        auth_method: 'oauth',
        id_token_email: 'backup@gmail.com',
      },
      quota: makeSampleQuota(10, 40, 100, pastReset),
    }),
  });
  assert.equal(secondImp.ok, true);
  assert.equal(secondImp.addedCount, 1);
  const backupId = secondImp.accounts[0].id;

  // 5. Refresh quota on live account (live RPC) vs non-current account (real Cockpit-Tools remote OAuth CloudCode fetch)
  quotaClient.setQuota(makeSampleQuota(44, 33, 99));
  const liveRef = await mgr.refreshAccountQuota(cap.account.id);
  assert.equal(liveRef.ok, true);
  assert.equal(liveRef.mode, 'live');
  assert.equal(liveRef.account.quota.groups[0].fiveHour.remainingPct, 44);

  const remoteRef = await mgr.refreshAccountQuota(backupId);
  assert.equal(remoteRef.ok, true);
  assert.equal(remoteRef.mode, 'remote_oauth');
  assert.equal(remoteRef.account.quota.groups[0].fiveHour.remainingPct, 77);
  assert.equal(remoteRef.account.quota.groups[1].fiveHour.remainingPct, 88);
  assert.equal(remoteCalls.length, 1);
  assert.equal(remoteCalls[0].refreshToken, '1//0eBACKUP_REFRESH_TOKEN_777');

  // Verify renewed access_token was sealed back into DPAPI vault and projectId cached
  const expBackup = await mgr.exportAccountJson(backupId);
  assert.equal(expBackup.data.credential.token.access_token, 'ya29.renewed_remote_token');

  // 6. Delete second account
  const del = await mgr.deleteAccount(backupId);
  assert.equal(del.ok, true);
  const listed = await mgr.listAccounts();
  assert.equal(listed.accounts.length, 1);
});

test('buildCleanLaunchEnv strips ELECTRON_RUN_AS_NODE and sidecar env vars while preserving OS env', () => {
  const cleaned = buildCleanLaunchEnv({
    PATH: 'C:\\Windows\\System32',
    APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    NODE_OPTIONS: '--max-old-space-size=4096',
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1234',
    AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP: '1',
    VSCODE_PID: '999',
  });
  assert.equal(cleaned.PATH, 'C:\\Windows\\System32');
  assert.equal(cleaned.APPDATA, 'C:\\Users\\Test\\AppData\\Roaming');
  assert.equal('ELECTRON_RUN_AS_NODE' in cleaned, false);
  assert.equal('ELECTRON_NO_ATTACH_CONSOLE' in cleaned, false);
  assert.equal('NODE_OPTIONS' in cleaned, false);
  assert.equal('ANTIGRAVITY_LS_ADDRESS' in cleaned, false);
  assert.equal('AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP' in cleaned, false);
  assert.equal('VSCODE_PID' in cleaned, false);
});

test('detached switch NEVER wakes finished sessions, and resumes ONLY genuinely running sessions At-Most-Once', async (t) => {
  const sendLog = [];
  const { paths, storage, driver, quotaClient, sidecarBridge } = createFixture(t, {
    liveCred: {
      credObj: {
        token: { refresh_token: '1//0eACCOUNT_A_TOKEN_11111111', token_type: 'Bearer' },
        auth_method: 'consumer',
        id_token_email: 'a@gmail.com',
      },
    },
    quotaPayload: makeSampleQuota(5, 20, 100),
    sendLog,
  });

  let runningList = [];
  const mgr = createAccountManager({
    paths,
    storage,
    quotaClient,
    sidecarBridge,
    getRunningConversations: async () => runningList,
    driver,
    onBeforeHostClose: async () => {},
  });

  await mgr.captureCurrentAccount({ remark: '号A' });
  const imp = await mgr.importAccounts({
    rawInput: JSON.stringify({
      email: 'b@gmail.com',
      remark: '号B',
      refresh_token: '1//0eACCOUNT_B_TOKEN_22222222',
    }),
  });
  const accB = imp.accounts[0];

  // Case 1: Only finished/idle/waiting sessions exist -> MUST NOT schedule auto-resume
  runningList = [
    { id: 'conv-finished-1', title: '已结束任务', status: 'idle' },
    { id: 'conv-waiting-2', title: '等待回复', status: 'waiting' },
  ];
  const swNoActive = await mgr.switchAccount({ accountId: accB.id, autoResume: true });
  assert.equal(swNoActive.ok, true);
  assert.equal(swNoActive.autoResumeScheduled, false);
  assert.equal(swNoActive.autoResumeCount, 0);
  assert.equal(fs.existsSync(paths.accountPendingResumeFile), false);

  // Case 2: Two genuinely running conversations + one finished conversation -> resume ONLY the 2 running ones
  runningList = [
    { id: 'conv-running-1', title: '修复支付模块', status: 'running' },
    { id: 'conv-finished-3', title: '旧任务', status: 'idle' },
    { id: 'conv-running-2', title: '并发构建测试', status: 'running' },
  ];
  const sw = await mgr.switchAccount({
    accountId: accB.id,
    autoResume: true,
    resumePrompt: '请接着继续任务',
  });
  assert.equal(sw.ok, true);
  assert.equal(sw.switching, true);
  assert.equal(sw.autoResumeScheduled, true);
  assert.equal(sw.autoResumeCount, 2);
  assert.equal(driver.launchedTxs.length, 2);
  assert.equal(driver.launchedTxs[1].launchArgs, '--remote-debugging-port=9229');
  assert.equal(driver.launchedTxs[1].targetEmail, 'b@gmail.com');

  // Switch payload on disk must be DPAPI sealed (no plaintext token)
  const payloadText = fs.readFileSync(driver.launchedTxs[1].payloadFile, 'utf8');
  assert.equal(payloadText.includes('1//0eACCOUNT_B_TOKEN_22222222'), false);

  // Simulate restart: before quota RPC is ready, lifecycle tick MUST NOT send resume message
  quotaClient.setQuota({ ok: false, available: false, groups: [] });
  await mgr.runLifecycleTick();
  assert.equal(sendLog.length, 0);

  // Now simulate switched account B authenticated and quota RPC returning 200
  driver.setLive({
    credObj: {
      token: { refresh_token: '1//0eACCOUNT_B_TOKEN_22222222', token_type: 'Bearer' },
      auth_method: 'consumer',
      id_token_email: 'b@gmail.com',
    },
  });
  quotaClient.setQuota(makeSampleQuota(100, 100, 100));

  await mgr.runLifecycleTick();
  assert.equal(sendLog.length, 2);
  assert.deepEqual(
    sendLog.map((x) => x.convId),
    ['conv-running-1', 'conv-running-2'],
  );
  assert.equal(sendLog[0].message, '请接着继续任务');

  // Repeated ticks MUST NOT re-send (strict At-Most-Once)
  await mgr.runLifecycleTick();
  await mgr.runLifecycleTick();
  assert.equal(sendLog.length, 2);

  // Account B's quota should also have been auto-synced on resume
  const listed = await mgr.listAccounts();
  const bAfter = listed.accounts.find((a) => a.email === 'b@gmail.com');
  assert.equal(bAfter.isCurrent, true);
  assert.equal(bAfter.quota.groups[0].fiveHour.remainingPct, 100);
});

test('non-destructive OAuth watch NEVER closes Antigravity and continuously auto-captures newly signed-in accounts', async (t) => {
  const { paths, storage, driver, quotaClient, sidecarBridge } = createFixture(t, {
    liveCred: {
      credObj: {
        token: { refresh_token: '1//0eOLD_USER_TOKEN_11111111', token_type: 'Bearer' },
        auth_method: 'consumer',
        id_token_email: 'old@gmail.com',
      },
    },
    quotaPayload: makeSampleQuota(60, 70, 80),
  });

  const remoteCalls = [];
  const mgr = createAccountManager({
    paths,
    storage,
    quotaClient,
    sidecarBridge,
    driver,
    remoteQuotaFetcher: async (credObj, opts) => {
      remoteCalls.push({ refreshToken: credObj?.token?.refresh_token, cachedProjectId: opts?.cachedProjectId });
      return {
        ok: true,
        quota: makeSampleQuota(77, 88, 95),
        projectId: 'proj-remote-123',
        source: 'retrieveUserQuotaSummary',
        updatedCredObj: {
          ...credObj,
          token: {
            ...credObj.token,
            access_token: 'ya29.renewed_remote_token',
            expiry: new Date(Date.now() + 3600_000).toISOString(),
          },
        },
        renewed: true,
      };
    },
    onBeforeHostClose: async () => {},
  });

  const watchRes = await mgr.startOauthWatch();
  assert.equal(watchRes.ok, true);
  assert.equal(watchRes.watching, true);
  // CRITICAL: Must NEVER close or restart Antigravity!
  assert.equal(driver.launchedTxs.length, 0);

  // Old account must have been auto-captured into vault first
  const midList = await mgr.listAccounts();
  assert.equal(midList.accounts.length, 1);
  assert.equal(midList.accounts[0].email, 'old@gmail.com');
  assert.ok(midList.pendingOauth);

  // User signs into 1st new Google account without closing AGY
  driver.setLive({
    credObj: {
      token: { refresh_token: '1//0eNEW_OAUTH_TOKEN_33333333', token_type: 'Bearer' },
      auth_method: 'consumer',
      id_token_email: 'newpro1@gmail.com',
    },
    scope: 'scope_new_1',
  });
  quotaClient.setQuota(makeSampleQuota(100, 100, 100));
  await mgr.runLifecycleTick();

  // User signs into 2nd new Google account in the same watch session
  driver.setLive({
    credObj: {
      token: { refresh_token: '1//0eNEW_OAUTH_TOKEN_44444444', token_type: 'Bearer' },
      auth_method: 'consumer',
      id_token_email: 'newpro2@gmail.com',
    },
    scope: 'scope_new_2',
  });
  await mgr.runLifecycleTick();

  const finalList = await mgr.listAccounts();
  assert.equal(finalList.accounts.length, 3);
  assert.ok(finalList.accounts.some((a) => a.email === 'newpro1@gmail.com' && a.source === 'oauth'));
  assert.ok(finalList.accounts.some((a) => a.email === 'newpro2@gmail.com' && a.source === 'oauth'));
  assert.equal(finalList.lastOauthCaptureResult?.email, 'newpro2@gmail.com');

  await mgr.stopOauthWatch();
  const afterStop = await mgr.listAccounts();
  assert.equal(afterStop.pendingOauth, null);
});

test('HTTP routes and frontend bundle cleanly expose accounts hub', async (t) => {
  const { paths, storage, driver, quotaClient, sidecarBridge } = createFixture(t, {
    liveCred: {
      credObj: {
        token: { refresh_token: '1//0eHTTP_ROUTE_TOKEN_444444', token_type: 'Bearer' },
        auth_method: 'oauth',
        id_token_email: 'route@gmail.com',
      },
    },
    quotaPayload: makeSampleQuota(91, 88, 100),
  });

  const routes = createMonitorHandlers({
    paths,
    storage,
    quotaClient,
    sidecarBridge,
    accountDriver: driver,
  });

  assert.ok(routes.has('GET /api/accounts'));
  assert.ok(routes.has('POST /api/accounts/settings'));
  assert.ok(routes.has('POST /api/accounts/capture'));
  assert.ok(routes.has('POST /api/accounts/oauth-add'));
  assert.ok(routes.has('POST /api/accounts/oauth-watch/stop'));
  assert.ok(routes.has('POST /api/accounts/import'));
  assert.ok(routes.has('POST /api/accounts/toggle'));
  assert.ok(routes.has('POST /api/accounts/remark'));
  assert.ok(routes.has('POST /api/accounts/delete'));
  assert.ok(routes.has('POST /api/accounts/export'));
  assert.ok(routes.has('POST /api/accounts/refresh-quota'));
  assert.ok(routes.has('POST /api/accounts/switch'));
  assert.ok(routes.has('GET /components/accounts_hub.js'));

  const setRes = await routes.get('POST /api/accounts/settings')({
    quotaRefreshIntervalMin: 10,
    autoSwitchTarget: 'claude',
    autoSwitchEnabled: true,
    sortBy: 'gemini',
    sortOrder: 'asc',
  });
  assert.equal(setRes.ok, true);
  assert.equal(setRes.settings.quotaRefreshIntervalMin, 10);
  assert.equal(setRes.settings.autoSwitchTarget, 'gpt_claude');
  assert.equal(setRes.settings.autoSwitchEnabled, true);
  assert.equal(setRes.settings.sortBy, 'gemini');
  assert.equal(setRes.settings.sortOrder, 'asc');

  const capRes = await routes.get('POST /api/accounts/capture')({ remark: '接口测活' });
  assert.equal(capRes.ok, true);
  assert.equal(capRes.account.email, 'route@gmail.com');

  const expRes = await routes.get('POST /api/accounts/export')({ accountId: capRes.account.id });
  assert.equal(expRes.headers?.['Cache-Control'], 'no-store');
  const expBody = JSON.parse(expRes.body);
  assert.equal(expBody.data.email, 'route@gmail.com');

  // Verify frontend bundle compiles with zero syntax errors and includes accounts_hub
  const bundle = await buildFrontendBundle(paths.frontendDir);
  assert.ok(bundle.includes('createAccountsHub'));
  assert.doesNotThrow(() => new Function(bundle));
});

test('auto-switch settings, highest-quota candidate selection, and 0-quota exclusion rules', async (t) => {
  const s = normalizeAccountSettings({
    quotaRefreshIntervalMin: 9999,
    autoSwitchTarget: 'Claude',
    autoSwitchEnabled: true,
    sortBy: 'email',
    sortOrder: 'ASC',
  });
  assert.equal(s.quotaRefreshIntervalMin, 1440);
  assert.equal(s.autoSwitchTarget, 'gpt_claude');
  assert.equal(s.autoSwitchEnabled, true);
  assert.equal(s.sortBy, 'email');
  assert.equal(s.sortOrder, 'asc');

  const future = Date.now() + 3600_000;
  const exhaustedGemini = makeSampleQuota(0, 80, 100, future);
  const healthyGemini = makeSampleQuota(15, 80, 100, future);
  assert.equal(isFiveHourQuotaExhausted(exhaustedGemini, 'gemini'), true);
  assert.equal(isFiveHourQuotaExhausted(healthyGemini, 'gemini'), false);
  // Already-passed reset time should NOT be treated as exhausted
  assert.equal(isFiveHourQuotaExhausted(makeSampleQuota(0, 80, 100, Date.now() - 10_000), 'gemini'), false);

  const makeWithWeekly = (pct5h, pctWeekly) => {
    const q = makeSampleQuota(pct5h, 50, 100, future);
    q.groups[0].weekly = {
      remainingFraction: pctWeekly / 100,
      remainingPct: pctWeekly,
      remainingPctExact: pctWeekly,
      resetTimeMs: future + 86400_000,
      isFull: pctWeekly === 100,
      disabled: false,
    };
    return q;
  };

  const candidates = [
    { id: 'cur', email: 'cur@gmail.com', enabled: true, quota: makeWithWeekly(0, 80) },
    { id: 'disabled-high', email: 'dis@gmail.com', enabled: false, quota: makeWithWeekly(100, 100) },
    { id: 'zero-weekly', email: 'zw@gmail.com', enabled: true, quota: makeWithWeekly(95, 0) },
    { id: 'zero-5h', email: 'z5@gmail.com', enabled: true, quota: makeWithWeekly(0, 95) },
    { id: 'mid-ok', email: 'mid@gmail.com', enabled: true, quota: makeWithWeekly(60, 70), lastUsedAtMs: 100 },
    { id: 'best-ok', email: 'best@gmail.com', enabled: true, quota: makeWithWeekly(88, 90), lastUsedAtMs: 200 },
  ];

  const picked = selectBestAutoSwitchCandidate(candidates, {
    currentEmail: 'cur@gmail.com',
    targetGroupKey: 'gemini',
  });
  assert.equal(picked?.id, 'best-ok');

  // If only 0-weekly / 0-5h / disabled accounts remain, MUST return null
  const nonePicked = selectBestAutoSwitchCandidate(candidates.slice(0, 4), {
    currentEmail: 'cur@gmail.com',
    targetGroupKey: 'gemini',
  });
  assert.equal(nonePicked, null);

  // End-to-end auto-switch trigger during lifecycle tick when 5h hits 0%
  const { paths, storage, driver, quotaClient, sidecarBridge } = createFixture(t, {
    liveCred: {
      credObj: {
        token: { refresh_token: '1//0eCUR_TOKEN_1111111111', token_type: 'Bearer' },
        auth_method: 'consumer',
        id_token_email: 'cur@gmail.com',
      },
    },
    quotaPayload: makeWithWeekly(0, 50),
  });

  const mgr = createAccountManager({
    paths,
    storage,
    quotaClient,
    sidecarBridge,
    getRunningConversations: async () => [{ id: 'conv-live-99', title: '运行中任务', status: 'running' }],
    driver,
    onBeforeHostClose: async () => {},
  });

  await mgr.captureCurrentAccount({ remark: '当前耗尽号' });
  await mgr.importAccounts({
    rawInput: JSON.stringify([
      {
        email: 'zero-week@gmail.com',
        refresh_token: '1//0eZW_TOKEN_2222222222',
        quota: makeWithWeekly(99, 0),
      },
      {
        email: 'zero-5h@gmail.com',
        refresh_token: '1//0eZ5_TOKEN_3333333333',
        quota: makeWithWeekly(0, 99),
      },
      {
        email: 'mid-alt@gmail.com',
        refresh_token: '1//0eMID_TOKEN_4444444444',
        quota: makeWithWeekly(55, 80),
      },
      {
        email: 'top-alt@gmail.com',
        refresh_token: '1//0eTOP_TOKEN_5555555555',
        quota: makeWithWeekly(92, 85),
      },
    ]),
  });

  await mgr.updateAccountSettings({
    quotaRefreshIntervalMin: 5,
    autoSwitchTarget: 'gemini',
    autoSwitchEnabled: true,
  });

  await mgr.runLifecycleTick();
  assert.equal(driver.launchedTxs.length, 1);
  assert.equal(driver.launchedTxs[0].targetEmail, 'top-alt@gmail.com');

  // Cooldown must prevent duplicate trigger on immediate next tick
  await mgr.runLifecycleTick();
  assert.equal(driver.launchedTxs.length, 1);
});

function encVarint(val) {
  let n = BigInt(val);
  const bytes = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    bytes.push(b);
  } while (n > 0n);
  return Buffer.from(bytes);
}

function encLen(fieldNum, buf) {
  return Buffer.concat([encVarint((fieldNum << 3) | 2), encVarint(buf.length), buf]);
}

function encStr(fieldNum, text) {
  return encLen(fieldNum, Buffer.from(text, 'utf8'));
}

function encVar(fieldNum, val) {
  return Buffer.concat([encVarint((fieldNum << 3) | 0), encVarint(val)]);
}

function encStepMetaTs(sec) {
  return encLen(1, encVar(1, sec));
}

function encQuotaErrorPayload({
  shortMessage = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 115h53m10s.',
  detailMessage = 'RESOURCE_EXHAUSTED (code 429): Individual quota reached.',
  errorId = 'ea0c9e73-c7b4-4d10-b9f2-1e21513ef626-7137',
  httpCode = 429,
  rpcDetailJson = JSON.stringify({
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason: 'QUOTA_EXHAUSTED',
    domain: 'cloudcode-pa.googleapis.com',
    metadata: { model: 'gemini-4-neon-xhigh', quotaResetDelay: '115h53m10s' },
  }),
} = {}) {
  const details = Buffer.concat([
    shortMessage ? encStr(1, shortMessage) : Buffer.alloc(0),
    detailMessage ? encStr(2, detailMessage) : Buffer.alloc(0),
    errorId ? encStr(6, errorId) : Buffer.alloc(0),
    httpCode ? encVar(7, httpCode) : Buffer.alloc(0),
    rpcDetailJson ? encStr(10, rpcDetailJson) : Buffer.alloc(0),
  ]);
  return encLen(24, encLen(3, details));
}

test('auto-switch triggers on weekly quota = 0% AND fresh step_type=17 QUOTA_EXHAUSTED error (only when enabled, zero restart loops)', async (t) => {
  const future = Date.now() + 3600_000;
  const makeQuota = (g5h, gWk, c5h = 80, cWk = 80) => ({
    ok: true,
    available: true,
    fetchedAtMs: Date.now(),
    groups: [
      {
        key: 'gemini',
        label: 'Gemini',
        displayName: 'Gemini Models',
        fiveHour: { remainingFraction: g5h / 100, remainingPct: g5h, remainingPctExact: g5h, resetTimeMs: future, isFull: g5h === 100, disabled: false },
        weekly: { remainingFraction: gWk / 100, remainingPct: gWk, remainingPctExact: gWk, resetTimeMs: future + 86400_000, isFull: gWk === 100, disabled: false },
      },
      {
        key: 'gpt_claude',
        label: 'GPT&Claude',
        displayName: 'Claude and GPT models',
        fiveHour: { remainingFraction: c5h / 100, remainingPct: c5h, remainingPctExact: c5h, resetTimeMs: future, isFull: c5h === 100, disabled: false },
        weekly: { remainingFraction: cWk / 100, remainingPct: cWk, remainingPctExact: cWk, resetTimeMs: future + 86400_000, isFull: cWk === 100, disabled: false },
      },
      {
        key: 'argon',
        label: 'Argon',
        displayName: 'Gemini 4 Argon',
        fiveHour: null,
        weekly: { remainingFraction: 1, remainingPct: 100, remainingPctExact: 100, resetTimeMs: future + 86400_000, isFull: true, disabled: false },
      },
    ],
  });

  // 1. Weekly exhaustion unit checks (5h still positive, weekly = 0 -> exhausted with reason='weekly')
  assert.deepEqual(inspectQuotaExhaustion(makeQuota(61, 0), 'gemini'), { exhausted: true, reason: 'weekly' });
  assert.deepEqual(inspectQuotaExhaustion(makeQuota(0, 50), 'gemini'), { exhausted: true, reason: 'five_hour' });
  assert.deepEqual(inspectQuotaExhaustion(makeQuota(61, 27), 'gemini'), { exhausted: false, reason: null });
  assert.equal(mapModelToQuotaGroup('gemini-4-neon-xhigh'), 'gemini');
  assert.equal(mapModelToQuotaGroup('claude-opus-4-6'), 'gpt_claude');
  assert.equal(mapModelToQuotaGroup('gemini-4-argon-medium'), 'argon');

  // 2. Protobuf parser recognizes QUOTA_EXHAUSTED and rejects transient 503/network errors
  const nowSec = Math.floor(Date.now() / 1000);
  const parsedQuotaErr = parseQuotaExhaustedStepError(
    encStepMetaTs(nowSec),
    encQuotaErrorPayload(),
    { convId: 'conv-halted', stepIndex: 7137 },
  );
  assert.equal(parsedQuotaErr?.errorId, 'ea0c9e73-c7b4-4d10-b9f2-1e21513ef626-7137');
  assert.equal(parsedQuotaErr?.model, 'gemini-4-neon-xhigh');
  assert.equal(parsedQuotaErr?.quotaGroup, 'gemini');

  const parsed503 = parseQuotaExhaustedStepError(
    encStepMetaTs(nowSec),
    encQuotaErrorPayload({
      shortMessage: 'API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high',
      detailMessage: 'UNAVAILABLE (code 503): No capacity available',
      httpCode: 503,
      rpcDetailJson: '',
    }),
    { convId: 'conv-503', stepIndex: 10 },
  );
  assert.equal(parsed503, null, 'Transient 503 capacity error must NOT trigger quota auto-switch');

  // 3. Weekly quota = 0% triggers auto-switch via lifecycle tick when autoSwitchEnabled=true
  const weeklyFx = createFixture(t, {
    liveCred: {
      credObj: {
        token: { refresh_token: '1//0eWEEK_CUR_TOKEN_1111111', token_type: 'Bearer' },
        auth_method: 'consumer',
        id_token_email: 'week-empty@gmail.com',
      },
    },
    quotaPayload: makeQuota(55, 0),
  });
  const weeklyMgr = createAccountManager({
    paths: weeklyFx.paths,
    storage: weeklyFx.storage,
    quotaClient: weeklyFx.quotaClient,
    sidecarBridge: weeklyFx.sidecarBridge,
    getRunningConversations: async () => [],
    driver: weeklyFx.driver,
    onBeforeHostClose: async () => {},
  });
  await weeklyMgr.captureCurrentAccount();
  await weeklyMgr.importAccounts({
    rawInput: JSON.stringify([
      { email: 'week-backup@gmail.com', refresh_token: '1//0eWEEK_BK_TOKEN_2222222', quota: makeQuota(90, 80) },
    ]),
  });
  // Disabled -> must NOT switch
  await weeklyMgr.runLifecycleTick();
  assert.equal(weeklyFx.driver.launchedTxs.length, 0);

  // Enable auto-switch -> must switch on weekly=0%
  await weeklyMgr.updateAccountSettings({ autoSwitchEnabled: true, autoSwitchTarget: 'gemini', quotaRefreshIntervalMin: 5 });
  await weeklyMgr.syncActiveAccountQuotaFromLive(makeQuota(55, 0));
  // Wait microtask tick for fire-and-forget auto-switch in syncActiveAccountQuotaFromLive
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(weeklyFx.driver.launchedTxs.length, 1);
  assert.equal(weeklyFx.driver.launchedTxs[0].targetEmail, 'week-backup@gmail.com');
  assert.equal((await weeklyMgr.listAccounts()).lastAutoSwitchResult?.triggerReason, 'weekly');

  // 4. Fresh step_type=17 QUOTA_EXHAUSTED error triggers auto-switch, schedules resume for halted conv, and never loops after restart
  const errFx = createFixture(t, {
    liveCred: {
      credObj: {
        token: { refresh_token: '1//0eERR_CUR_TOKEN_1111111', token_type: 'Bearer' },
        auth_method: 'consumer',
        id_token_email: 'err-cur@gmail.com',
      },
    },
    // Quota RPC still shows non-zero (lagged), proving error-triggered switch does NOT wait for RPC to hit 0%
    quotaPayload: makeQuota(12, 10, 90, 90),
  });
  const errMgr = createAccountManager({
    paths: errFx.paths,
    storage: errFx.storage,
    quotaClient: errFx.quotaClient,
    sidecarBridge: errFx.sidecarBridge,
    getRunningConversations: async () => [], // Conversation halted on error so status is no longer 'running'
    driver: errFx.driver,
    onBeforeHostClose: async () => {},
  });
  await errMgr.captureCurrentAccount();
  await errMgr.importAccounts({
    rawInput: JSON.stringify([
      { email: 'err-backup-best@gmail.com', refresh_token: '1//0eERR_BK1_TOKEN_2222222', quota: makeQuota(85, 75, 40, 40) },
      { email: 'err-backup-zero@gmail.com', refresh_token: '1//0eERR_BK2_TOKEN_3333333', quota: makeQuota(99, 0, 99, 99) },
    ]),
  });

  // Seed conversations/conv-quota-halted.db with a fresh step_type=17 QUOTA_EXHAUSTED row
  fs.mkdirSync(errFx.paths.conversationsDir, { recursive: true });
  const convDbPath = path.join(errFx.paths.conversationsDir, 'conv-quota-halted.db');
  const convDb = new DatabaseSync(convDbPath);
  convDb.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)`);
  convDb
    .prepare(`INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, 3, ?, ?)`)
    .run(7137, 17, encStepMetaTs(Math.floor(Date.now() / 1000)), encQuotaErrorPayload());
  convDb.close();

  // Disabled -> must NOT switch even with fresh QUOTA_EXHAUSTED error
  await errMgr.runLifecycleTick();
  assert.equal(errFx.driver.launchedTxs.length, 0);

  // Enable auto-switch (with quotaRefreshIntervalMin=0 to prove error watcher works independently of periodic refresh!)
  await errMgr.updateAccountSettings({ autoSwitchEnabled: true, autoSwitchTarget: 'gemini', quotaRefreshIntervalMin: 0 });
  await errMgr.runLifecycleTick();
  assert.equal(errFx.driver.launchedTxs.length, 1);
  assert.equal(errFx.driver.launchedTxs[0].targetEmail, 'err-backup-best@gmail.com');

  // Verify the halted conversation was scheduled for At-Most-Once auto-resume after restart!
  const pendingResume = JSON.parse(fs.readFileSync(errFx.paths.accountPendingResumeFile, 'utf8'));
  assert.deepEqual(
    pendingResume.conversations.map((c) => c.id),
    ['conv-quota-halted'],
  );

  // Simulate post-restart new AccountManager instance on the switched backup account -> MUST NOT re-trigger on step 7137!
  errFx.driver.setLive({
    credObj: {
      token: { refresh_token: '1//0eERR_BK1_TOKEN_2222222', token_type: 'Bearer' },
      auth_method: 'consumer',
      id_token_email: 'err-backup-best@gmail.com',
    },
  });
  const restartedMgr = createAccountManager({
    paths: errFx.paths,
    storage: errFx.storage,
    quotaClient: errFx.quotaClient,
    sidecarBridge: errFx.sidecarBridge,
    getRunningConversations: async () => [],
    driver: errFx.driver,
    onBeforeHostClose: async () => {},
  });
  await restartedMgr.runLifecycleTick();
  assert.equal(errFx.driver.launchedTxs.length, 1, 'Restarted sidecar must NEVER re-trigger on already-handled quota error');
});

test('direct browser OAuth starts loopback server, builds official consent URL, captures callback, and seals into vault', async (t) => {
  const fx = createFixture(t);
  let openedUrl = '';
  const fakeFetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('oauth2.googleapis.com/token')) {
      return {
        ok: true,
        json: async () => ({
          access_token: 'fake_access_tok_123',
          refresh_token: '1//0e_fake_direct_oauth_refresh_token_xyz',
          expires_in: 3600,
          id_token: makeFakeJwt({ email: 'new-direct-oauth@gmail.com' }),
        }),
      };
    }
    if (urlStr.includes('googleapis.com/oauth2/v2/userinfo')) {
      return {
        ok: true,
        json: async () => ({
          email: 'new-direct-oauth@gmail.com',
          name: 'Direct OAuth User',
        }),
      };
    }
    return { ok: false, status: 404, text: async () => 'Not Found' };
  };

  const mgr = createAccountManager({
    paths: fx.paths,
    storage: fx.storage,
    quotaClient: fx.quotaClient,
    sidecarBridge: fx.sidecarBridge,
    getRunningConversations: async () => [],
    driver: fx.driver,
    onBeforeHostClose: async () => {},
  });

  const mockOauthClient = {
    clientId: 'test-client-123456.apps.googleusercontent.com',
    clientSecret: 'test-client-secret-fixture',
  };
  const startRes = await mgr.startDirectBrowserOauth(
    { remark: 'Direct Test' },
    {
      fetch: fakeFetch,
      oauthClient: mockOauthClient,
      openExternal: (url) => {
        openedUrl = url;
      },
    },
  );

  assert.equal(startRes.ok, true);
  assert.equal(startRes.status, 'waiting_user_auth');
  assert.ok(startRes.port > 0);
  assert.ok(openedUrl.includes('accounts.google.com/o/oauth2/v2/auth'));
  assert.ok(openedUrl.includes('client_id=test-client-123456.apps.googleusercontent.com'));
  assert.ok(openedUrl.includes('redirect_uri=http'));
  assert.ok(openedUrl.includes('code_challenge='));

  const pendingStatus = mgr.getDirectBrowserOauthStatus();
  assert.equal(pendingStatus.ok, true);
  assert.equal(pendingStatus.status, 'waiting_user_auth');

  const urlObj = new URL(openedUrl);
  const state = urlObj.searchParams.get('state');

  const callbackRes = await fetch(
    `http://127.0.0.1:${startRes.port}/oauth-callback?state=${state}&code=4/fake_auth_code_9876`,
  );
  assert.equal(callbackRes.status, 200);
  const html = await callbackRes.text();
  assert.ok(html.includes('官方授权并入库成功'));
  assert.ok(html.includes('new-direct-oauth@gmail.com'));

  const finalStatus = mgr.getDirectBrowserOauthStatus();
  assert.equal(finalStatus.status, 'success');
  assert.equal(finalStatus.result.ok, true);
  assert.equal(finalStatus.result.account.email, 'new-direct-oauth@gmail.com');

  const list = await mgr.listAccounts();
  const added = list.accounts.find((a) => a.email === 'new-direct-oauth@gmail.com');
  assert.ok(added);
  assert.equal(added.remark, 'Direct Test');
  assert.equal(added.authMethod, 'consumer');

  await mgr.cancelDirectBrowserOauth();
});

test('direct browser OAuth returns 502 error HTML to browser and preserves error status when token exchange fails', async (t) => {
  const fx = createFixture(t);
  let openedUrl = '';
  const failingFetch = async () => {
    throw new Error('通过系统代理 (http://127.0.0.1:7897) 访问 Google 服务失败：ECONNREFUSED');
  };

  const mgr = createAccountManager({
    paths: fx.paths,
    storage: fx.storage,
    quotaClient: fx.quotaClient,
    sidecarBridge: fx.sidecarBridge,
    getRunningConversations: async () => [],
    driver: fx.driver,
    onBeforeHostClose: async () => {},
  });

  const startRes = await mgr.startDirectBrowserOauth(
    {},
    {
      fetch: failingFetch,
      oauthClient: {
        clientId: 'test-client-fail.apps.googleusercontent.com',
        clientSecret: 'test-secret-fail',
      },
      openExternal: (url) => {
        openedUrl = url;
      },
    },
  );
  const state = new URL(openedUrl).searchParams.get('state');

  const callbackRes = await fetch(
    `http://127.0.0.1:${startRes.port}/oauth-callback?state=${state}&code=4/fail_code`,
  );
  assert.equal(callbackRes.status, 502);
  const html = await callbackRes.text();
  assert.ok(html.includes('Google 账号授权失败'));
  assert.ok(html.includes('127.0.0.1:7897'));

  const errStatus = mgr.getDirectBrowserOauthStatus();
  assert.equal(errStatus.status, 'error');
  assert.ok(errStatus.error.includes('127.0.0.1:7897'));

  await mgr.cancelDirectBrowserOauth();
});

test('system proxy resolver parses env/Windows Registry proxy formats and routes requests through HTTP proxy', async (t) => {
  assert.equal(parseWindowsProxyServer('127.0.0.1:7897', 'https:'), 'http://127.0.0.1:7897');
  assert.equal(
    parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:10808', 'https:'),
    'http://127.0.0.1:7891',
  );
  assert.equal(
    parseWindowsProxyServer('socks=127.0.0.1:10808', 'https:'),
    'socks5://127.0.0.1:10808',
  );

  assert.equal(shouldBypassProxy('127.0.0.1', ''), true);
  assert.equal(shouldBypassProxy('localhost', ''), true);
  assert.equal(shouldBypassProxy('intranet', '<local>'), true);
  assert.equal(shouldBypassProxy('api.corp.local', '*.corp.local'), true);
  assert.equal(shouldBypassProxy('oauth2.googleapis.com', 'localhost;127.*;*.local'), false);

  const envProxy = await resolveSystemProxyUrl('https://oauth2.googleapis.com/token', {
    env: { HTTPS_PROXY: '127.0.0.1:7897' },
    platform: 'linux',
  });
  assert.equal(envProxy, 'http://127.0.0.1:7897');

  const regProxy = await resolveSystemProxyUrl('https://oauth2.googleapis.com/token', {
    env: {},
    platform: 'win32',
    readWindowsProxy: async () => ({
      enabled: true,
      proxyServer: '127.0.0.1:7897',
      proxyOverride: 'localhost;127.*;<local>',
    }),
  });
  assert.equal(regProxy, 'http://127.0.0.1:7897');

  const bypassed = await resolveSystemProxyUrl('https://oauth2.googleapis.com/token', {
    env: { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'googleapis.com' },
    platform: 'win32',
  });
  assert.equal(bypassed, null);

  // Spin up a real loopback HTTP proxy and confirm requestOverProxy routes through it
  let seenProxiedUrl = '';
  let seenBody = '';
  const proxyServer = http.createServer((req, res) => {
    seenProxiedUrl = req.url || '';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proxied: true, target: seenProxiedUrl }));
    });
  });
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => proxyServer.close());

  const { port } = proxyServer.address();
  const proxiedRes = await requestOverProxy(
    'http://example.invalid/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code',
    },
    `http://127.0.0.1:${port}`,
    5000,
  );
  assert.equal(proxiedRes.ok, true);
  const payload = await proxiedRes.json();
  assert.equal(payload.proxied, true);
  assert.equal(seenProxiedUrl, 'http://example.invalid/token');
  assert.equal(seenBody, 'grant_type=authorization_code');
});

test('fetchCloudCodeQuotaForCredential refreshes OAuth token, loads project, fetches retrieveUserQuotaSummary, and falls back to fetchAvailableModels', async () => {
  const seenCalls = [];
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url);
    seenCalls.push(u);
    if (u.includes('oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'ya29.fresh_access_token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      };
    }
    if (u.includes('v1internal:loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          cloudaicompanionProject: 'proj-cockpit-42',
          paidTier: { id: 'g1-pro-tier' },
        }),
      };
    }
    if (u.includes('v1internal:retrieveUserQuotaSummary')) {
      const body = JSON.parse(String(opts.body || '{}'));
      assert.equal(body.project, 'proj-cockpit-42');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.78, resetTime: '2026-11-24T05:00:00Z' },
                { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.94, resetTime: '2026-11-30T22:00:00Z' },
              ],
            },
            {
              displayName: 'Claude and GPT models',
              buckets: [
                { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-24T05:00:00Z' },
                { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.49, resetTime: '2026-12-01T00:00:00Z' },
              ],
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };

  const res = await fetchCloudCodeQuotaForCredential(
    {
      token: { refresh_token: '1//0eTEST_REFRESH_TOKEN', expiry: '1970-01-01T00:00:00Z' },
      auth_method: 'consumer',
    },
    {
      fetchImpl: fakeFetch,
      nowMs: Date.parse('2026-11-24T01:00:00Z'),
      oauthClient: {
        clientId: 'test-client-quota.apps.googleusercontent.com',
        clientSecret: 'test-secret-quota',
      },
    },
  );

  assert.equal(res.ok, true);
  assert.equal(res.projectId, 'proj-cockpit-42');
  assert.equal(res.source, 'retrieveUserQuotaSummary');
  assert.equal(res.renewed, true);
  assert.equal(res.updatedCredObj.token.access_token, 'ya29.fresh_access_token');
  assert.equal(res.quota.groups[0].key, 'gemini');
  assert.equal(res.quota.groups[0].fiveHour.remainingPct, 78);
  assert.equal(res.quota.groups[0].weekly.remainingPct, 94);
  assert.equal(res.quota.groups[1].key, 'gpt_claude');
  assert.equal(res.quota.groups[1].weekly.remainingPct, 49);
  assert.ok(seenCalls.some((u) => u.includes('daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary')));

  // Fallback to fetchAvailableModels when retrieveUserQuotaSummary returns empty groups
  const fallbackFetch = async (url) => {
    const u = String(url);
    if (u.includes('v1internal:loadCodeAssist')) {
      return { ok: true, status: 200, json: async () => ({ cloudaicompanionProject: 'proj-fb' }) };
    }
    if (u.includes('v1internal:retrieveUserQuotaSummary')) {
      return { ok: true, status: 200, json: async () => ({ groups: [] }) };
    }
    if (u.includes('v1internal:fetchAvailableModels')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: {
            'gemini-4-neon': { quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-24T06:00:00Z' } },
            'claude-sonnet-4-5': { quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-24T06:00:00Z' } },
          },
        }),
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const fbRes = await fetchCloudCodeQuotaForCredential(
    {
      token: {
        access_token: 'ya29.still_valid',
        refresh_token: '1//0eTEST_REFRESH_TOKEN',
        expiry: '2026-11-24T03:00:00Z',
      },
      auth_method: 'consumer',
    },
    { fetchImpl: fallbackFetch, nowMs: Date.parse('2026-11-24T01:00:00Z') },
  );
  assert.equal(fbRes.ok, true);
  assert.equal(fbRes.source, 'fetchAvailableModels');
  assert.equal(fbRes.quota.groups.find((g) => g.key === 'gemini').fiveHour.remainingPct, 65);
  assert.equal(fbRes.quota.groups.find((g) => g.key === 'gpt_claude').fiveHour.remainingPct, 90);
});
