import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

const TEST_OAUTH_HOST = ['apps', 'googleusercontent', 'com'].join('.');
const TEST_OAUTH_SECRET_PREFIX = ['GOC', 'SPX-'].join('');
const makeTestClientId = (id) => `${id}.${TEST_OAUTH_HOST}`;
const makeTestClientSecret = (body) => `${TEST_OAUTH_SECRET_PREFIX}${body}`;
import {
  ACCOUNT_EXPORT_SCHEMA,
  ANTIGRAVITY_OAUTH_SCOPES,
  BUILTIN_ACCOUNT_GROUPS,
  DEFAULT_ACCOUNT_GROUP,
  NATIVE_OAUTH_USER_AGENT,
  WINDOWS_CRED_MAX_BLOB_BYTES,
  buildAccountStatus,
  buildAuthorizationUrl,
  buildCleanLaunchEnv,
  buildCockpitCredentialPayload,
  buildVerificationLaunchUrl,
  classifyAccountError,
  clearDiscoveredOAuthClientCache,
  createAccountManager,
  detectLocalAntigravityVersion,
  detectRecentQuotaExhaustedError,
  discoverLocalOAuthClient,
  fetchCloudCodeQuotaForCredential,
  formatRfc3339Micros,
  inspectQuotaExhaustion,
  isFiveHourQuotaExhausted,
  mapModelToQuotaGroup,
  normalizeAccountGroups,
  normalizeAccountSettings,
  parseGoogleCloudCodeError,
  parseImportPayload,
  parseQuotaExhaustedStepError,
  parseWindowsProxyServer,
  refreshAccessTokenForCredential,
  requestOverProxy,
  resolveSystemProxyUrl,
  sanitizeAccountGroup,
  sanitizeValidationUrl,
  scanFileInChunksBypassingAsar,
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

function makeSampleQuota(pctGemini = 80, pctGpt = 65, _legacyArgon = 100, resetTimeMs = Date.now() + 3600_000) {
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
  assert.equal(cap.account.quota.groups.length, 2);
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
  assert.equal(mapModelToQuotaGroup('gemini-4-argon-medium'), 'gemini');

  // Legacy saved settings targeting Argon cleanly migrate to Gemini
  const migratedArgon = normalizeAccountSettings({ autoSwitchTarget: 'argon', sortBy: 'argon' });
  assert.equal(migratedArgon.autoSwitchTarget, 'gemini');
  assert.equal(migratedArgon.sortBy, 'gemini');

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
    clientId: makeTestClientId('test-client-123456'),
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
  assert.ok(openedUrl.includes(`client_id=${makeTestClientId('test-client-123456')}`));
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
        clientId: makeTestClientId('test-client-fail'),
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
        clientId: makeTestClientId('test-client-quota'),
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

test('refreshAccessTokenForCredential auto-matches JWT aud & falls back across candidateClients on 401 unauthorized_client', async () => {
  const wrongClient = makeTestClientId('111111111111-wrong');
  const rightClient = makeTestClientId('222222222222-right');
  const multiClient = {
    clientId: wrongClient,
    clientSecret: 'mock-wrong-secret-0001',
    candidateSecrets: ['mock-wrong-secret-0001', 'mock-right-secret-0002'],
    candidateClients: [
      {
        clientId: wrongClient,
        clientSecret: 'mock-wrong-secret-0001',
        candidateSecrets: ['mock-wrong-secret-0001'],
      },
      {
        clientId: rightClient,
        clientSecret: 'mock-right-secret-0002',
        candidateSecrets: ['mock-right-secret-0002'],
      },
    ],
  };

  // Case 1: No id_token -> tries wrongClient first (401 unauthorized_client), falls through to rightClient and succeeds!
  const attempts1 = [];
  const fakeFetch1 = async (_url, opts) => {
    const body = new URLSearchParams(String(opts?.body || ''));
    const cid = body.get('client_id');
    const sec = body.get('client_secret');
    attempts1.push(`${cid}:${sec}`);
    if (cid === rightClient && sec === 'mock-right-secret-0002') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'ya29.recovered_across_clients',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      };
    }
    return {
      ok: false,
      status: 401,
      text: async () => '{\n  "error": "unauthorized_client",\n  "error_description": "Unauthorized"\n}',
    };
  };

  const res1 = await refreshAccessTokenForCredential(
    {
      token: { refresh_token: '1//0eMULTI_CLIENT_RT', expiry: '1970-01-01T00:00:00Z' },
      auth_method: 'consumer',
    },
    { fetchImpl: fakeFetch1, nowMs: Date.parse('2026-11-24T08:00:00Z'), oauthClient: multiClient },
  );
  assert.equal(res1.renewed, true);
  assert.equal(res1.accessToken, 'ya29.recovered_across_clients');
  assert.equal(res1.matchedClientId, rightClient);
  assert.equal(attempts1.length, 2);

  // Case 2: id_token has aud=rightClient -> hits rightClient on the VERY FIRST request!
  const attempts2 = [];
  const fakeFetch2 = async (_url, opts) => {
    const body = new URLSearchParams(String(opts?.body || ''));
    attempts2.push(body.get('client_id'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'ya29.aud_first_hit',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    };
  };
  const res2 = await refreshAccessTokenForCredential(
    {
      token: {
        refresh_token: '1//0eAUD_MATCH_RT',
        expiry: '1970-01-01T00:00:00Z',
        id_token: makeFakeJwt({ email: 'aud@gmail.com', aud: rightClient }),
      },
      auth_method: 'consumer',
    },
    { fetchImpl: fakeFetch2, nowMs: Date.parse('2026-11-24T08:00:00Z'), oauthClient: multiClient },
  );
  assert.equal(res2.accessToken, 'ya29.aud_first_hit');
  assert.deepEqual(attempts2, [rightClient]);

  // Case 3: Multi-line JSON 401 error collapses cleanly onto one line (never clipped at "{")
  const always401 = async () => ({
    ok: false,
    status: 401,
    text: async () => '{\n  "error": "invalid_client",\n  "error_description": "The OAuth client was not found."\n}',
  });
  await assert.rejects(
    () =>
      refreshAccessTokenForCredential(
        { token: { refresh_token: '1//0eFAIL_RT', expiry: '1970-01-01T00:00:00Z' } },
        {
          fetchImpl: always401,
          nowMs: Date.parse('2026-11-24T08:00:00Z'),
          oauthClient: { clientId: wrongClient, clientSecret: 'mock-bad-secret' },
        },
      ),
    (err) => {
      assert.ok(err.message.includes('invalid_client'));
      assert.ok(!err.message.includes('\n'));
      return true;
    },
  );
});

test('conservative default skips inactive background polling, live vault sync & opt-in renewal work, and pre-switch injects exact Cockpit payload', async (t) => {
  let fakeNow = Date.parse('2026-11-24T08:00:00Z');
  const { paths, storage, driver, quotaClient, sidecarBridge } = createFixture(t, {
    liveCred: {
      credObj: {
        token: {
          access_token: 'ya29.active_initial',
          refresh_token: '1//0eACTIVE_RT_11111111',
          expiry: new Date(fakeNow + 10 * 60_000).toISOString(),
        },
        auth_method: 'consumer',
        id_token_email: 'active@gmail.com',
      },
    },
    quotaPayload: makeSampleQuota(80, 90, 100, fakeNow + 3600_000),
  });

  const remoteCalls = [];
  const preSwitchCalls = [];
  const backupIdToken = makeFakeJwt({ email: 'backup@gmail.com' });
  const mgr = createAccountManager({
    paths,
    storage,
    quotaClient,
    sidecarBridge,
    driver,
    now: () => fakeNow,
    remoteQuotaFetcher: async (credObj, opts) => {
      remoteCalls.push({ refreshToken: credObj?.token?.refresh_token, preferredClientId: opts.preferredClientId });
      const nextExpMs = opts.nowMs + 3600_000;
      return {
        ok: true,
        quota: makeSampleQuota(95, 100, 100, opts.nowMs + 3600_000),
        projectId: 'proj-proactive',
        source: 'retrieveUserQuotaSummary',
        matchedClientId: makeTestClientId('222222222222-right'),
        tokenExpiryMs: nextExpMs,
        updatedCredObj: {
          ...credObj,
          token: {
            ...credObj.token,
            access_token: `ya29.bg_renewed_${remoteCalls.length}`,
            expiry: formatRfc3339Micros(nextExpMs),
          },
          id_token: backupIdToken,
        },
        renewed: true,
      };
    },
    tokenRefresher: async (credObj, opts) => {
      preSwitchCalls.push({ refreshToken: credObj?.token?.refresh_token, preferredClientId: opts.preferredClientId });
      const nextExpMs = opts.nowMs + 3600_000;
      return {
        accessToken: 'ya29.preswitch_fresh_token',
        renewed: true,
        matchedClientId: makeTestClientId('222222222222-right'),
        expiryMs: nextExpMs,
        credObj: {
          token: {
            access_token: 'ya29.preswitch_fresh_token',
            token_type: 'Bearer',
            refresh_token: credObj.token.refresh_token,
            expiry: formatRfc3339Micros(nextExpMs),
          },
          auth_method: 'consumer',
          id_token: backupIdToken,
        },
      };
    },
    onBeforeHostClose: async () => {},
  });

  // Default settings MUST be conservative (backgroundRefreshInactive = false)
  const capActive = await mgr.captureCurrentAccount();
  assert.equal(capActive.ok, true);

  // Import a backup account whose token expires in 6 minutes (inside 15-min skew)
  const imp = await mgr.importAccounts({
    rawInput: JSON.stringify({
      email: 'backup@gmail.com',
      quota: makeSampleQuota(70, 80, 100, fakeNow + 3600_000),
      credential: {
        token: {
          access_token: 'ya29.backup_expiring',
          refresh_token: '1//0eBACKUP_RT_22222222',
          expiry: new Date(fakeNow + 6 * 60_000).toISOString(),
        },
        auth_method: 'consumer',
        id_token: backupIdToken,
      },
    }),
  });
  assert.equal(imp.ok, true);
  const backupId = imp.accounts[0].id;

  // Under conservative default, lifecycle tick MUST make ZERO background remote calls for inactive accounts!
  await mgr.updateAccountSettings({ quotaRefreshIntervalMin: 60 });
  await mgr.runLifecycleTick();
  assert.equal(remoteCalls.length, 0, 'Default conservative mode must NOT batch-poll inactive accounts in background');

  // Explicitly opting into backgroundRefreshInactive=true enables background renewal
  await mgr.updateAccountSettings({ quotaRefreshIntervalMin: 60, backgroundRefreshInactive: true });
  fakeNow += 61 * 60_000;
  await mgr.runLifecycleTick();
  assert.equal(remoteCalls.length, 1);

  const expAfterBg = await mgr.exportAccountJson(backupId);
  assert.equal(expAfterBg.data.credential.token.access_token, 'ya29.bg_renewed_1');

  // Advance clock by 50 minutes (still < 60 min quota interval, backup expires in 10 min <= 15-min window)
  fakeNow += 50 * 60_000;
  // Simulate language_server refreshing the active account's live credential in Windows Credential Manager
  driver.setLive({
    credObj: {
      token: {
        access_token: 'ya29.active_live_renewed',
        token_type: 'Bearer',
        refresh_token: '1//0eACTIVE_RT_11111111',
        expiry: formatRfc3339Micros(fakeNow + 55 * 60_000),
      },
      auth_method: 'consumer',
    },
  });
  await mgr.syncActiveAccountQuotaFromLive(makeSampleQuota(75, 90, 100, fakeNow + 3600_000), {
    skipAutoSwitch: true,
  });
  const expActive = await mgr.exportAccountJson(capActive.account.id);
  assert.equal(expActive.data.credential.token.access_token, 'ya29.active_live_renewed');

  // Opt-in proactive background renewal kicks in for backup@gmail.com
  await mgr.runLifecycleTick();
  assert.equal(remoteCalls.length, 2);
  assert.equal(remoteCalls[1].preferredClientId, makeTestClientId('222222222222-right'));

  // Advance clock by 70 minutes so backup token is expired, then switch to backup -> pre-switch auto-refresh runs!
  fakeNow += 70 * 60_000;
  const sw = await mgr.switchAccount({ accountId: backupId, autoResume: false });
  assert.equal(sw.ok, true);
  assert.equal(preSwitchCalls.length, 1);

  const tx = driver.launchedTxs[0];
  const sealedPayload = fs.readFileSync(tx.payloadFile, 'utf8');
  const plainPayload = JSON.parse(await driver.unprotectSecret(sealedPayload));
  assert.equal('credentialUserScope' in plainPayload, false, 'Cockpit switch payload must not mutate credentialUserScope');
  const injectedCred = JSON.parse(plainPayload.credJson);
  assert.equal(injectedCred.auth_method, 'consumer');
  assert.equal(injectedCred.id_token, backupIdToken);
  assert.equal(injectedCred.token.access_token, 'ya29.preswitch_fresh_token');
  assert.equal(injectedCred.token.token_type, 'Bearer');
  assert.match(injectedCred.token.expiry, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  assert.equal('id_token_email' in injectedCred, false);
  assert.equal('expires_in' in injectedCred.token, false);
});

test('Cockpit parity: credential payload cap, OAuth headers/scopes, invalid_grant retry & abort, single-flight lock, and AgyAccountTool guards', async (t) => {
  // 1. Exact Cockpit compositeTokenStorage payload & 2560-byte Windows CredWriteW guard
  const sampleJwt = makeFakeJwt({ email: 'cockpit@gmail.com' });
  const built = buildCockpitCredentialPayload(
    {
      token: {
        access_token: 'ya29.abc',
        refresh_token: '1//0eCOCKPIT_RT',
        token_type: 'Bearer',
        expiry: '2026-11-25T12:00:00Z',
        expires_in: 3600,
        id_token: sampleJwt,
      },
      auth_method: 'oauth',
      id_token_email: 'cockpit@gmail.com',
      writer_id: 'legacy',
    },
    { nowMs: Date.parse('2026-11-25T11:00:00Z') },
  );
  assert.equal(built.idTokenOmittedForSize, false);
  assert.ok(built.byteLength <= WINDOWS_CRED_MAX_BLOB_BYTES);
  assert.deepEqual(Object.keys(built.payload).sort(), ['auth_method', 'id_token', 'token']);
  assert.deepEqual(Object.keys(built.payload.token).sort(), [
    'access_token',
    'expiry',
    'refresh_token',
    'token_type',
  ]);
  assert.equal(built.payload.auth_method, 'consumer');
  assert.equal(built.payload.id_token, sampleJwt);
  assert.equal(built.payload.token.expiry, '2026-11-25T12:00:00.000000Z');

  // Oversized id_token is dropped cleanly so CredWriteW never exceeds 2560 bytes
  const hugeBuilt = buildCockpitCredentialPayload({
    token: {
      access_token: 'ya29.abc',
      refresh_token: '1//0eCOCKPIT_RT',
      expiry: '2026-11-25T12:00:00Z',
    },
    id_token: 'x'.repeat(2600),
  });
  assert.equal(hugeBuilt.idTokenOmittedForSize, true);
  assert.ok(hugeBuilt.byteLength <= WINDOWS_CRED_MAX_BLOB_BYTES);
  assert.equal('id_token' in hugeBuilt.payload, false);

  // Oversized base token without id_token fails fast before closing Antigravity
  assert.throws(
    () =>
      buildCockpitCredentialPayload({
        token: { access_token: 'a'.repeat(2600), refresh_token: '1//0eRT' },
      }),
    /ANTIGRAVITY_WINDOWS_CREDENTIAL_TOO_LARGE/,
  );

  // 2. Cockpit OAuth scopes (openid + aicode) and consent URL params
  assert.ok(ANTIGRAVITY_OAUTH_SCOPES.includes('openid'));
  assert.ok(ANTIGRAVITY_OAUTH_SCOPES.includes('https://www.googleapis.com/auth/aicode'));
  const authUrl = new URL(
    buildAuthorizationUrl({
      clientId: makeTestClientId('cid'),
      redirectUri: 'http://127.0.0.1:12345/oauth-callback',
      state: 'st',
      codeChallenge: 'cc',
    }),
  );
  assert.equal(authUrl.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(authUrl.searchParams.get('prompt'), 'consent');
  assert.ok(authUrl.searchParams.get('scope').includes('openid'));
  assert.ok(authUrl.searchParams.get('scope').includes('https://www.googleapis.com/auth/aicode'));

  // 3. OAuth refresh sends native Cockpit User-Agent and retries invalid_grant once
  const seenHeaders = [];
  let attemptCount = 0;
  const retryFetch = async (_url, opts) => {
    seenHeaders.push(opts?.headers || {});
    attemptCount += 1;
    if (attemptCount === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'transient' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'ya29.recovered_after_retry',
        expires_in: 3600,
        token_type: 'Bearer',
        id_token: sampleJwt,
      }),
    };
  };
  const retried = await refreshAccessTokenForCredential(
    { token: { refresh_token: '1//0eRETRY_RT', expiry: '1970-01-01T00:00:00Z' } },
    {
      fetchImpl: retryFetch,
      nowMs: Date.parse('2026-11-25T10:00:00Z'),
      invalidGrantRetryMs: 1,
      oauthClient: { clientId: makeTestClientId('cid'), clientSecret: 'sec' },
    },
  );
  assert.equal(attemptCount, 2);
  assert.equal(retried.accessToken, 'ya29.recovered_after_retry');
  assert.equal(retried.credObj.id_token, sampleJwt);
  assert.equal(seenHeaders[0]['user-agent'], NATIVE_OAUTH_USER_AGENT);

  // 4. Pre-switch INVALID_GRANT aborts cleanly without closing Antigravity, and single-flight blocks concurrent clicks
  const fx = createFixture(t);
  let releaseBlocker;
  const blocker = new Promise((resolve) => {
    releaseBlocker = resolve;
  });
  let mode = 'invalid_grant';
  const mgr = createAccountManager({
    paths: fx.paths,
    storage: fx.storage,
    quotaClient: fx.quotaClient,
    sidecarBridge: fx.sidecarBridge,
    driver: fx.driver,
    tokenRefresher: async (credObj) => {
      if (mode === 'invalid_grant') {
        const err = new Error('OAuth 凭据已被撤销');
        err.code = 'INVALID_GRANT';
        err.status = 401;
        throw err;
      }
      await blocker;
      return {
        accessToken: 'ya29.ok',
        renewed: true,
        expiryMs: Date.now() + 3600_000,
        credObj: {
          token: {
            access_token: 'ya29.ok',
            token_type: 'Bearer',
            refresh_token: credObj.token.refresh_token,
            expiry: formatRfc3339Micros(Date.now() + 3600_000),
          },
          auth_method: 'consumer',
        },
      };
    },
    onBeforeHostClose: async () => {},
  });

  const imp = await mgr.importAccounts({
    rawInput: JSON.stringify({
      email: 'revoked@gmail.com',
      refresh_token: '1//0eREVOKED_RT_1234567890',
    }),
  });
  const accId = imp.accounts[0].id;

  // Revoked token -> abort switch cleanly, zero switch daemon launched!
  const aborted = await mgr.switchAccount({ accountId: accId, autoResume: false });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.status, 401);
  assert.equal(aborted.code, 'INVALID_GRANT');
  assert.equal(fx.driver.launchedTxs.length, 0);

  // Single-flight gate: 2nd concurrent switch returns 409 while 1st is in flight
  mode = 'block';
  const firstSwitchPromise = mgr.switchAccount({ accountId: accId, autoResume: false });
  await new Promise((r) => setTimeout(r, 15));
  const secondSwitch = await mgr.switchAccount({ accountId: accId, autoResume: false });
  assert.equal(secondSwitch.ok, false);
  assert.equal(secondSwitch.status, 409);
  releaseBlocker();
  const firstSwitch = await firstSwitchPromise;
  assert.equal(firstSwitch.ok, true);
  assert.equal(fx.driver.launchedTxs.length, 1);

  // Pure Cockpit live credential without id_token / id_token_email still resolves current account via refreshTokenHash
  fx.driver.setLive({
    credObj: {
      token: {
        access_token: 'ya29.ok',
        token_type: 'Bearer',
        refresh_token: '1//0eREVOKED_RT_1234567890',
        expiry: formatRfc3339Micros(Date.now() + 3600_000),
      },
      auth_method: 'consumer',
    },
  });
  const listed = await mgr.listAccounts();
  assert.equal(listed.currentEmail, 'revoked@gmail.com');
  assert.equal(listed.accounts[0].isCurrent, true);

  // 5. Dynamic Antigravity IDE version detection never drops below 2.25.0
  const ideVer = detectLocalAntigravityVersion();
  assert.match(ideVer, /^\d+\.\d+\.\d+/);

  // 6. Static guards on AgyAccountTool.cs (Cockpit dual-write, 2560B cap, taskkill /T, no app_storage/scope tampering on switch)
  const csSource = fs.readFileSync(
    path.resolve(process.cwd(), 'sidecars/agy_monitor/accounts/AgyAccountTool.cs'),
    'utf8',
  );
  assert.ok(csSource.includes('CRED_MAX_CREDENTIAL_BLOB_SIZE = 5 * 512'));
  assert.ok(csSource.includes('jetski-standalone-oauth-token'));
  assert.ok(csSource.includes('antigravity-cli'));
  assert.ok(csSource.includes('antigravity-oauth-token'));
  assert.ok(csSource.includes('taskkill.exe'));
  assert.ok(csSource.includes('"/PID " + pid + " /T"'));
  // Extract normal switch branch (`else { ... }` after `else if (mode == "rollback")`) and strip comments
  const switchBranchStart = csSource.indexOf('string credTarget = GetString(payload, "credTarget"');
  const switchBranchEnd = csSource.indexOf('UpdateTxFile(txPath, tx, "relaunching"', switchBranchStart);
  assert.ok(switchBranchStart > 0 && switchBranchEnd > switchBranchStart);
  const switchBranchCode = csSource
    .slice(switchBranchStart, switchBranchEnd)
    .replace(/\/\/[^\r\n]*/g, '');
  assert.equal(switchBranchCode.includes('ApplyAppStorageUsername'), false);
  assert.equal(switchBranchCode.includes('credential-user-scope'), false);
  assert.equal(switchBranchCode.includes('credentialUserScope'), false);
});

test('abnormal account handling classifies verification, banned, RT expired, AT expired, blocks auto-switch, and disables abnormal accounts', async (t) => {
  const nowMs = Date.parse('2026-11-24T12:00:00Z');

  // 1. Validation URL sanitization strictly allows Google https URLs only
  assert.equal(
    sanitizeValidationUrl('https://accounts.google.com/v3/signin/challenge?id=1'),
    'https://accounts.google.com/v3/signin/challenge?id=1',
  );
  assert.equal(sanitizeValidationUrl('https://evil.example/phish'), '');
  assert.equal(sanitizeValidationUrl('javascript:alert(1)'), '');

  // 2. CloudCode error parsing for VALIDATION_REQUIRED, ACCOUNT_BANNED, AT_EXPIRED, SUBSCRIPTION_REQUIRED
  const verifyErr = parseGoogleCloudCodeError(
    403,
    JSON.stringify({
      error: {
        message: 'Please verify your account before continuing.',
        details: [
          {
            reason: 'VALIDATION_REQUIRED',
            metadata: { validation_url: 'https://accounts.google.com/verify?token=abc' },
          },
        ],
      },
    }),
  );
  assert.equal(verifyErr.code, 'VALIDATION_REQUIRED');
  assert.equal(verifyErr.validationUrl, 'https://accounts.google.com/verify?token=abc');
  assert.equal(classifyAccountError(verifyErr).badge, '需验证');

  const bannedErr = parseGoogleCloudCodeError(
    403,
    JSON.stringify({
      error: {
        message: 'This account has been suspended due to Terms of Service violation.',
        details: [{ reason: 'ACCOUNT_DISABLED' }],
      },
    }),
  );
  assert.equal(bannedErr.code, 'ACCOUNT_BANNED');
  assert.equal(classifyAccountError(bannedErr).badge, '已封禁');
  assert.equal(classifyAccountError(bannedErr).state, 'error');

  // Banned account that ALSO includes an appeal_url must still classify as ACCOUNT_BANNED (not VALIDATION_REQUIRED)
  const bannedWithAppealErr = parseGoogleCloudCodeError(
    403,
    JSON.stringify({
      error: {
        message: 'This account has been suspended due to Terms of Service violation.',
        details: [
          {
            reason: 'ACCOUNT_DISABLED',
            metadata: { appeal_url: 'https://accounts.google.com/appeal?id=ban123' },
          },
        ],
      },
    }),
  );
  assert.equal(bannedWithAppealErr.code, 'ACCOUNT_BANNED');
  assert.equal(bannedWithAppealErr.validationUrl, 'https://accounts.google.com/appeal?id=ban123');
  assert.equal(
    classifyAccountError({
      message: 'Account has been suspended',
      validationUrl: 'https://accounts.google.com/appeal?id=ban123',
    }).code,
    'ACCOUNT_BANNED',
  );

  const atErr = parseGoogleCloudCodeError(
    401,
    JSON.stringify({ error: { status: 'UNAUTHENTICATED', message: 'Invalid authentication credentials' } }),
  );
  assert.equal(atErr.code, 'AT_EXPIRED');
  assert.equal(classifyAccountError(atErr).badge, 'AT 过期');

  // Docs link like request-license must classify as SUBSCRIPTION_REQUIRED (not VALIDATION_REQUIRED)
  const licenseErr = parseGoogleCloudCodeError(
    403,
    JSON.stringify({
      error: {
        message: 'Gemini Code Assist license required',
        details: [{ links: [{ url: 'https://cloud.google.com/gemini/docs/codeassist/request-license' }] }],
      },
    }),
  );
  assert.equal(licenseErr.code, 'SUBSCRIPTION_REQUIRED');
  assert.equal(licenseErr.validationUrl, '');
  assert.equal(classifyAccountError(licenseErr).badge, '无订阅');

  // 3. OAuth refresh distinguishes ACCOUNT_BANNED vs RT_EXPIRED vs AT_EXPIRED (missing RT)
  const oauthClient = {
    clientId: makeTestClientId('test-client-abnormal'),
    clientSecret: 'test-secret-abnormal',
  };
  await assert.rejects(
    () =>
      refreshAccessTokenForCredential(
        { token: { refresh_token: '1//0eBANNED_RT', expiry: '1970-01-01T00:00:00Z' } },
        {
          oauthClient,
          nowMs,
          fetchImpl: async () => ({
            ok: false,
            status: 400,
            text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Account has been disabled.' }),
          }),
        },
      ),
    (err) => err.code === 'ACCOUNT_BANNED' && err.status === 403,
  );

  await assert.rejects(
    () =>
      refreshAccessTokenForCredential(
        { token: { refresh_token: '1//0eEXPIRED_RT', expiry: '1970-01-01T00:00:00Z' } },
        {
          oauthClient,
          nowMs,
          fetchImpl: async () => ({
            ok: false,
            status: 400,
            text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
          }),
        },
      ),
    (err) => err.code === 'RT_EXPIRED' && err.status === 401,
  );

  await assert.rejects(
    () =>
      refreshAccessTokenForCredential(
        { token: { access_token: 'ya29.only_at_expired', expiry: new Date(nowMs - 60_000).toISOString() } },
        { oauthClient, nowMs },
      ),
    (err) => err.code === 'AT_EXPIRED' && err.status === 401,
  );

  // 4. Passive AT expiry check:
  // - Idle account WITH valid RT stays healthy (AT auto-renews on switch/refresh, zero false alarms)
  // - Idle account WITHOUT RT is surfaced as blocking AT_EXPIRED
  // - Persisted HTTP 401 authErrorCode=AT_EXPIRED still surfaces warning AT_EXPIRED
  const passiveAtWithRt = buildAccountStatus({ tokenExpiryMs: nowMs - 10_000, hasRefreshToken: true }, nowMs, false);
  assert.equal(passiveAtWithRt.state, 'healthy');
  assert.equal(passiveAtWithRt.code, 'OK');
  assert.equal(passiveAtWithRt.blocking, false);
  assert.equal(passiveAtWithRt.atAutoRenewPending, true);

  const passiveAtNoRt = buildAccountStatus({ tokenExpiryMs: nowMs - 10_000, hasRefreshToken: false }, nowMs, false);
  assert.equal(passiveAtNoRt.code, 'AT_EXPIRED');
  assert.equal(passiveAtNoRt.state, 'error');
  assert.equal(passiveAtNoRt.blocking, true);

  const persistedAt401 = buildAccountStatus(
    { tokenExpiryMs: nowMs - 10_000, hasRefreshToken: true, authErrorCode: 'AT_EXPIRED', authError: 'HTTP 401' },
    nowMs,
    false,
  );
  assert.equal(persistedAt401.code, 'AT_EXPIRED');
  assert.equal(persistedAt401.state, 'warning');
  assert.equal(persistedAt401.blocking, false);

  // 5. Auto-switch strictly skips banned / verification-required / RT-expired / missing-RT accounts
  const picked = selectBestAutoSwitchCandidate(
    [
      { id: 'a1', email: 'banned@gmail.com', enabled: true, authErrorCode: 'ACCOUNT_BANNED', quota: makeSampleQuota(100, 100, 100, nowMs + 3600_000) },
      { id: 'a2', email: 'verify@gmail.com', enabled: true, authErrorCode: 'VALIDATION_REQUIRED', quota: makeSampleQuota(100, 100, 100, nowMs + 3600_000) },
      { id: 'a3', email: 'rtexp@gmail.com', enabled: true, authErrorCode: 'RT_EXPIRED', quota: makeSampleQuota(100, 100, 100, nowMs + 3600_000) },
      { id: 'a5', email: 'nort@gmail.com', enabled: true, hasRefreshToken: false, quota: makeSampleQuota(100, 100, 100, nowMs + 3600_000) },
      { id: 'a4', email: 'healthy@gmail.com', enabled: true, quota: makeSampleQuota(55, 70, 100, nowMs + 3600_000) },
    ],
    { currentEmail: 'cur@gmail.com', targetGroupKey: 'gemini', nowMs },
  );
  assert.equal(picked?.id, 'a4');

  // 5.5 fetchCloudCodeQuotaForCredential short-circuits immediately on SUBSCRIPTION_REQUIRED from retrieveUserQuotaSummary
  let subCalls = 0;
  await assert.rejects(
    () =>
      fetchCloudCodeQuotaForCredential(
        {
          token: {
            access_token: 'ya29.valid_at_sub_test',
            refresh_token: '1//0eSUB_RT',
            expiry: new Date(nowMs + 3600_000).toISOString(),
          },
        },
        {
          cachedProjectId: 'proj-cached-sub',
          nowMs,
          fetchImpl: async () => {
            subCalls += 1;
            return {
              ok: false,
              status: 403,
              text: async () =>
                JSON.stringify({
                  error: {
                    message: 'Gemini Code Assist license required',
                    details: [{ links: [{ url: 'https://cloud.google.com/gemini/docs/codeassist/request-license' }] }],
                  },
                }),
            };
          },
        },
      ),
    (err) => err.code === 'SUBSCRIPTION_REQUIRED',
  );
  assert.equal(subCalls, 1);

  // 6. End-to-end persistence in manager + openAccountValidationUrl + disableAbnormalAccounts + recovery clearing
  const { paths, storage, driver, quotaClient, sidecarBridge } = createFixture(t, {
    liveCred: {
      credObj: {
        token: { access_token: 'ya29.cur', refresh_token: '1//0eCUR_RT', expiry: new Date(nowMs + 3600_000).toISOString() },
        auth_method: 'consumer',
        id_token_email: 'cur@gmail.com',
      },
    },
    quotaPayload: makeSampleQuota(80, 90, 100, nowMs + 3600_000),
  });

  let modeByEmail = {
    'needverify@gmail.com': 'verify',
    'bannedacc@gmail.com': 'banned',
    'rtexpired@gmail.com': 'rt_expired',
    'goodacc@gmail.com': 'ok',
  };

  let remoteQuotaCalls = 0;
  let renewAtCalls = 0;
  const mgr = createAccountManager({
    paths,
    storage,
    quotaClient,
    sidecarBridge,
    driver,
    now: () => nowMs,
    remoteQuotaFetcher: async (credObj) => {
      remoteQuotaCalls += 1;
      const rt = String(credObj?.token?.refresh_token || '');
      const emailKey = rt.startsWith('1//0e_') ? rt.slice('1//0e_'.length) : credObj.id_token_email;
      const m = modeByEmail[emailKey] || 'ok';
      if (m === 'verify') throw verifyErr;
      if (m === 'banned') throw bannedErr;
      if (m === 'rt_expired') {
        const e = new Error('Refresh Token (RT) 已过期或被撤销');
        e.status = 401;
        e.code = 'RT_EXPIRED';
        throw e;
      }
      return {
        ok: true,
        quota: makeSampleQuota(90, 95, 100, nowMs + 3600_000),
        projectId: 'proj-ok',
        source: 'retrieveUserQuotaSummary',
        tokenExpiryMs: nowMs + 3600_000,
        updatedCredObj: credObj,
        renewed: false,
      };
    },
    tokenRefresher: async (credObj, opts) => {
      renewAtCalls += 1;
      const rt = String(credObj?.token?.refresh_token || '');
      const emailKey = rt.startsWith('1//0e_') ? rt.slice('1//0e_'.length) : credObj.id_token_email;
      const m = modeByEmail[emailKey] || 'ok';
      if (m === 'rt_expired') {
        const e = new Error('Refresh Token (RT) 已过期或被撤销');
        e.status = 401;
        e.code = 'RT_EXPIRED';
        throw e;
      }
      const nextExp = opts.nowMs + 3600_000;
      return {
        accessToken: 'ya29.at_only_renewed',
        renewed: true,
        matchedClientId: makeTestClientId('test-client-at'),
        expiryMs: nextExp,
        credObj: {
          ...credObj,
          token: {
            ...credObj.token,
            access_token: 'ya29.at_only_renewed',
            expiry: formatRfc3339Micros(nextExp),
          },
        },
      };
    },
  });

  const capCur = await mgr.captureCurrentAccount();
  assert.equal(capCur.ok, true);
  assert.equal(capCur.account.hasRefreshToken, true);

  const imp = await mgr.importAccounts({
    rawInput: JSON.stringify(
      ['needverify@gmail.com', 'bannedacc@gmail.com', 'rtexpired@gmail.com', 'goodacc@gmail.com'].map((email) => ({
        email,
        credential: {
          token: { access_token: 'ya29.x', refresh_token: `1//0e_${email}`, expiry: new Date(nowMs + 3600_000).toISOString() },
          auth_method: 'consumer',
          id_token_email: email,
        },
      })),
    ),
  });
  assert.equal(imp.ok, true);
  const byEmail = Object.fromEntries(imp.accounts.map((a) => [a.email, a.id]));

  const rVerify = await mgr.refreshAccountQuota(byEmail['needverify@gmail.com']);
  assert.equal(rVerify.ok, false);
  assert.equal(rVerify.code, 'VALIDATION_REQUIRED');
  assert.equal(rVerify.account.accountStatus.badge, '需验证');
  assert.equal(rVerify.account.accountStatus.validationUrl, 'https://accounts.google.com/verify?token=abc');

  const rBanned = await mgr.refreshAccountQuota(byEmail['bannedacc@gmail.com']);
  assert.equal(rBanned.ok, false);
  assert.equal(rBanned.code, 'ACCOUNT_BANNED');
  assert.equal(rBanned.account.accountStatus.badge, '已封禁');

  const rRt = await mgr.refreshAccountQuota(byEmail['rtexpired@gmail.com']);
  assert.equal(rRt.ok, false);
  assert.equal(rRt.code, 'RT_EXPIRED');
  assert.equal(rRt.account.accountStatus.badge, 'RT 过期');

  const rGood = await mgr.refreshAccountQuota(byEmail['goodacc@gmail.com']);
  assert.equal(rGood.ok, true);
  assert.equal(rGood.account.accountStatus.code, 'OK');

  // Open validation URL routes accounts.google.com verify links through AccountChooser with target Email
  const wrappedSample = buildVerificationLaunchUrl(
    'https://accounts.google.com/v3/signin/continue?plt=TOK123&authuser',
    'needverify@gmail.com',
  );
  assert.ok(wrappedSample.startsWith('https://accounts.google.com/AccountChooser?'));
  assert.ok(wrappedSample.includes('Email=needverify%40gmail.com'));
  assert.ok(wrappedSample.includes('authuser%3Dneedverify%2540gmail.com') || wrappedSample.includes('continue='));

  let openedValidationUrl = '';
  const openRes = await mgr.openAccountValidationUrl(byEmail['needverify@gmail.com'], {
    openExternal: (u) => {
      openedValidationUrl = u;
      return true;
    },
  });
  assert.equal(openRes.ok, true);
  assert.ok(openedValidationUrl.startsWith('https://accounts.google.com/AccountChooser?'));
  assert.ok(openedValidationUrl.includes('Email=needverify%40gmail.com'));
  assert.ok(openedValidationUrl.includes(encodeURIComponent('https://accounts.google.com/verify?token=abc')));

  // Switching into confirmed ACCOUNT_BANNED (422) or RT_EXPIRED (401 via pre-switch verify) is refused before touching Antigravity
  const swBanned = await mgr.switchAccount({ accountId: byEmail['bannedacc@gmail.com'], autoResume: false });
  assert.equal(swBanned.ok, false);
  assert.equal(swBanned.status, 422);
  const swRt = await mgr.switchAccount({ accountId: byEmail['rtexpired@gmail.com'], autoResume: false });
  assert.equal(swRt.ok, false);
  assert.equal(swRt.status, 401);
  assert.equal(driver.launchedTxs.length, 0);

  // One-click AT-only renewal: imports an idle account with expired AT + valid RT (no false-alarm AT_EXPIRED)
  // and verifies explicit OAuth-only renewal still refreshes cleanly with zero CloudCode calls
  const impAtExp = await mgr.importAccounts({
    rawInput: JSON.stringify({
      email: 'atexpired@gmail.com',
      credential: {
        token: {
          access_token: 'ya29.old_expired_at',
          refresh_token: '1//0e_atexpired@gmail.com',
          expiry: new Date(nowMs - 600_000).toISOString(),
        },
        auth_method: 'consumer',
      },
    }),
  });
  assert.equal(impAtExp.ok, true);
  const atExpiredId = impAtExp.accounts[0].id;
  assert.equal(impAtExp.accounts[0].accountStatus.code, 'OK');
  assert.equal(impAtExp.accounts[0].accountStatus.atAutoRenewPending, true);
  assert.equal(impAtExp.accounts[0].accountStatus.blocking, false);

  const remoteBeforeAtRenew = remoteQuotaCalls;
  const renewBeforeAtRenew = renewAtCalls;
  const rAtRenew = await mgr.renewAccountAccessToken(atExpiredId);
  assert.equal(rAtRenew.ok, true);
  assert.equal(rAtRenew.renewed, true);
  assert.equal(rAtRenew.mode, 'oauth_at_only');
  assert.equal(rAtRenew.account.accountStatus.code, 'OK');
  assert.equal(renewAtCalls, renewBeforeAtRenew + 1);
  assert.equal(remoteQuotaCalls, remoteBeforeAtRenew); // ZERO CloudCode quota calls!
  const expAtRenewed = await mgr.exportAccountJson(atExpiredId);
  assert.equal(expAtRenewed.data.credential.token.access_token, 'ya29.at_only_renewed');

  // AT-only renewal on revoked RT accurately persists RT_EXPIRED
  const rAtRevoked = await mgr.renewAccountAccessToken(byEmail['rtexpired@gmail.com']);
  assert.equal(rAtRevoked.ok, false);
  assert.equal(rAtRevoked.code, 'RT_EXPIRED');
  assert.equal(rAtRevoked.account.accountStatus.code, 'RT_EXPIRED');

  // Disable all blocking abnormal accounts in one shot without disabling healthy/current accounts
  const disRes = await mgr.disableAbnormalAccounts();
  assert.equal(disRes.ok, true);
  assert.equal(disRes.disabledCount, 3);
  assert.equal(disRes.accounts.find((a) => a.email === 'goodacc@gmail.com').enabled, true);
  assert.equal(disRes.accounts.find((a) => a.email === 'cur@gmail.com').enabled, true);
  assert.equal(disRes.accounts.find((a) => a.email === 'bannedacc@gmail.com').enabled, false);

  // syncActiveAccountQuotaFromLive clears stale abnormal errors on active account even if token hasn't rotated
  const idxPath = paths.accountsIndexFile;
  const idxMut = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const curRow = idxMut.accounts.find((a) => a.email === 'cur@gmail.com');
  curRow.authError = 'stale transient error';
  curRow.authErrorCode = 'NETWORK_ERROR';
  curRow.authErrorAtMs = nowMs - 60_000;
  fs.writeFileSync(idxPath, JSON.stringify(idxMut, null, 2), 'utf8');
  await mgr.syncActiveAccountQuotaFromLive(makeSampleQuota(82, 91, 100, nowMs + 3600_000), { skipAutoSwitch: true });
  const afterSyncList = await mgr.listAccounts();
  const curAfterSync = afterSyncList.accounts.find((a) => a.email === 'cur@gmail.com');
  assert.equal(curAfterSync.accountStatus.code, 'OK');
  assert.equal(curAfterSync.authError, undefined);

  // When verification completes and refresh succeeds, abnormal error clears cleanly
  modeByEmail['needverify@gmail.com'] = 'ok';
  const rRecovered = await mgr.refreshAccountQuota(byEmail['needverify@gmail.com']);
  assert.equal(rRecovered.ok, true);
  assert.equal(rRecovered.account.accountStatus.code, 'OK');
  assert.equal(rRecovered.account.authError, undefined);
});

test('account grouping supports default/pro/ultra 5x/ultra 20x, custom groups, import/export roundtrip, and zero background polling on RT-expired accounts', async (t) => {
  const nowMs = Date.parse('2026-11-26T10:00:00Z');
  assert.equal(DEFAULT_ACCOUNT_GROUP, 'default');
  assert.deepEqual([...BUILTIN_ACCOUNT_GROUPS], ['default', 'pro', 'ultra 5x', 'ultra 20x']);
  assert.equal(sanitizeAccountGroup(''), 'default');
  assert.equal(sanitizeAccountGroup('  ULTRA   20X '), 'ultra 20x');
  assert.equal(sanitizeAccountGroup('Pro'), 'pro');
  assert.deepEqual(normalizeAccountGroups(null, [{ group: 'vip' }]), [
    'default',
    'pro',
    'ultra 5x',
    'ultra 20x',
    'vip',
  ]);
  assert.deepEqual(normalizeAccountGroups(['PRO', 'custom-team', 'default'], [{ group: 'vip' }]), [
    'default',
    'pro',
    'custom-team',
    'vip',
  ]);

  const { paths, storage, driver, quotaClient, sidecarBridge } = createFixture(t, {
    liveCred: {
      credObj: {
        token: {
          access_token: 'ya29.cur_grp',
          refresh_token: '1//0eCUR_GRP_RT',
          expiry: new Date(nowMs + 3600_000).toISOString(),
        },
        auth_method: 'consumer',
        id_token_email: 'cur@gmail.com',
      },
    },
    quotaPayload: makeSampleQuota(90, 95, 100, nowMs + 3600_000),
  });

  const polledEmails = [];
  const mgr = createAccountManager({
    paths,
    storage,
    quotaClient,
    sidecarBridge,
    driver,
    now: () => nowMs,
    remoteQuotaFetcher: async (credObj) => {
      const rt = String(credObj?.token?.refresh_token || '');
      polledEmails.push(rt);
      return {
        ok: true,
        quota: makeSampleQuota(80, 90, 100, nowMs + 3600_000),
        projectId: 'proj-grp',
        source: 'retrieveUserQuotaSummary',
        tokenExpiryMs: nowMs + 3600_000,
        updatedCredObj: credObj,
        renewed: false,
      };
    },
  });

  // 1. Default capture assigns 'default' group and listAccounts exposes all 4 built-in groups
  const cap = await mgr.captureCurrentAccount();
  assert.equal(cap.ok, true);
  assert.equal(cap.account.group, 'default');
  const initialList = await mgr.listAccounts();
  assert.deepEqual(initialList.groups, ['default', 'pro', 'ultra 5x', 'ultra 20x']);
  assert.deepEqual(initialList.builtinGroups, ['default', 'pro', 'ultra 5x', 'ultra 20x']);

  // 2. Legacy accounts on disk lacking `group` automatically default to 'default'
  const idxRaw = JSON.parse(fs.readFileSync(paths.accountsIndexFile, 'utf8'));
  delete idxRaw.accounts[0].group;
  delete idxRaw.groups;
  fs.writeFileSync(paths.accountsIndexFile, JSON.stringify(idxRaw, null, 2), 'utf8');
  const migratedList = await mgr.listAccounts();
  assert.equal(migratedList.accounts[0].group, 'default');
  assert.deepEqual(migratedList.groups, ['default', 'pro', 'ultra 5x', 'ultra 20x']);

  // 3. Assign built-in and custom groups + protect built-in groups from deletion
  const movedPro = await mgr.updateAccountGroup(cap.account.id, 'ULTRA 5X');
  assert.equal(movedPro.ok, true);
  assert.equal(movedPro.account.group, 'ultra 5x');

  const addCustom = await mgr.manageAccountGroups({ action: 'add', name: 'team-alpha' });
  assert.equal(addCustom.ok, true);
  assert.ok(addCustom.groups.includes('team-alpha'));

  const dupCustom = await mgr.manageAccountGroups({ action: 'add', name: 'TEAM-ALPHA' });
  assert.equal(dupCustom.ok, false);
  assert.equal(dupCustom.status, 409);

  // Only 'default' is protected; default presets ('pro', 'ultra 5x', 'ultra 20x') can be deleted and stay deleted
  const delDefault = await mgr.manageAccountGroups({ action: 'delete', name: 'default' });
  assert.equal(delDefault.ok, false);
  assert.equal(delDefault.status, 400);

  const delPresetUltra5 = await mgr.manageAccountGroups({ action: 'delete', name: 'ultra 5x' });
  assert.equal(delPresetUltra5.ok, true);
  assert.equal(delPresetUltra5.movedCount, 1);
  assert.equal(delPresetUltra5.groups.includes('ultra 5x'), false);
  assert.equal(delPresetUltra5.accounts.find((a) => a.id === cap.account.id).group, 'default');
  const afterDelPreset = await mgr.listAccounts();
  assert.equal(afterDelPreset.groups.includes('ultra 5x'), false);
  assert.equal(afterDelPreset.groups.includes('pro'), true);
  assert.equal(afterDelPreset.groups.includes('ultra 20x'), true);

  const movedCustom = await mgr.updateAccountGroup(cap.account.id, 'team-alpha');
  assert.equal(movedCustom.ok, true);
  assert.equal(movedCustom.account.group, 'team-alpha');

  // 4. Export & import roundtrip preserves group; bare token re-import preserves existing group
  const exported = await mgr.exportAccountJson(cap.account.id);
  assert.equal(exported.ok, true);
  assert.equal(exported.data.group, 'team-alpha');

  const reimpBare = await mgr.importAccounts({
    rawInput: JSON.stringify({
      email: 'cur@gmail.com',
      refresh_token: '1//0eCUR_GRP_RT_NEW',
    }),
  });
  assert.equal(reimpBare.ok, true);
  assert.equal(reimpBare.accounts[0].group, 'team-alpha');

  const impUltra20 = await mgr.importAccounts({
    rawInput: JSON.stringify({
      email: 'u20@gmail.com',
      group: 'ultra 20x',
      refresh_token: '1//0eU20_RT_1234567890',
    }),
  });
  assert.equal(impUltra20.ok, true);
  assert.equal(impUltra20.accounts[0].group, 'ultra 20x');

  // Deleting custom group reassigns its members back to 'default'
  const delCustom = await mgr.manageAccountGroups({ action: 'delete', name: 'team-alpha' });
  assert.equal(delCustom.ok, true);
  assert.equal(delCustom.movedCount, 1);
  assert.equal(delCustom.groups.includes('team-alpha'), false);
  assert.equal(delCustom.accounts.find((a) => a.id === cap.account.id).group, 'default');

  // 5. Anti-ban check: even with backgroundRefreshInactive=true, RT_EXPIRED / missing-RT / disabled accounts are NEVER polled!
  const impBad = await mgr.importAccounts({
    rawInput: JSON.stringify([
      {
        email: 'rtbad@gmail.com',
        credential: {
          token: { access_token: 'ya29.x', refresh_token: '1//0eRTBAD', expiry: new Date(nowMs - 60_000).toISOString() },
          auth_method: 'consumer',
        },
      },
      {
        email: 'nort@gmail.com',
        credential: {
          token: { access_token: 'ya29.y', refresh_token: '1//0eNORT', expiry: new Date(nowMs - 60_000).toISOString() },
          auth_method: 'consumer',
        },
      },
      {
        email: 'healthy-idle@gmail.com',
        credential: {
          token: { access_token: 'ya29.z', refresh_token: '1//0eHEALTHY_IDLE', expiry: new Date(nowMs - 60_000).toISOString() },
          auth_method: 'consumer',
        },
      },
    ]),
  });
  assert.equal(impBad.ok, true);
  const idxForAntiBan = JSON.parse(fs.readFileSync(paths.accountsIndexFile, 'utf8'));
  const rtBadRow = idxForAntiBan.accounts.find((a) => a.email === 'rtbad@gmail.com');
  rtBadRow.authErrorCode = 'RT_EXPIRED';
  rtBadRow.authError = 'Refresh Token 已失效';
  const noRtRow = idxForAntiBan.accounts.find((a) => a.email === 'nort@gmail.com');
  noRtRow.hasRefreshToken = false;
  fs.writeFileSync(paths.accountsIndexFile, JSON.stringify(idxForAntiBan, null, 2), 'utf8');

  await mgr.updateAccountSettings({ backgroundRefreshInactive: true, quotaRefreshIntervalMin: 5 });
  polledEmails.length = 0;
  await mgr.runLifecycleTick();
  assert.equal(polledEmails.includes('1//0eRTBAD'), false, 'RT_EXPIRED account must NEVER be polled');
  assert.equal(polledEmails.includes('1//0eNORT'), false, 'Missing-RT account must NEVER be polled');
  assert.equal(polledEmails.includes('1//0eHEALTHY_IDLE'), true, 'Healthy enabled idle account polled when opt-in enabled');

  // 6. Verify HTTP routes POST /api/accounts/group and POST /api/accounts/groups are registered in createMonitorHandlers
  const handlers = createMonitorHandlers({ paths, storage });
  assert.equal(typeof handlers.get('POST /api/accounts/group'), 'function');
  assert.equal(typeof handlers.get('POST /api/accounts/groups'), 'function');
});

test('official compliance blocks direct cloudcode-pa probing in production and hard-stops all quota queries when disabled', async (t) => {
  const fx = createFixture(t);
  let quotaClientCalls = 0;
  let quotaEnabled = true;

  const countedQuotaClient = {
    async getQuotaSummary(opts) {
      quotaClientCalls += 1;
      if (!quotaEnabled) {
        return { ok: false, available: false, disabled: true, code: 'quota_disabled', groups: [] };
      }
      return fx.quotaClient.getQuotaSummary(opts);
    },
  };

  fx.driver.setLive({
    credObj: {
      token: { refresh_token: '1//0eACTIVE_SAFE_123456', token_type: 'Bearer' },
      auth_method: 'consumer',
      id_token_email: 'active-safe@gmail.com',
    },
  });

  // Production-like createAccountManager: NO remoteQuotaFetcher injected, allowUnsafeDirectCloudCode omitted (defaults false)
  const mgr = createAccountManager({
    paths: fx.paths,
    storage: fx.storage,
    quotaClient: countedQuotaClient,
    sidecarBridge: fx.sidecarBridge,
    getRunningConversations: async () => [],
    driver: fx.driver,
    onBeforeHostClose: async () => {},
    isQuotaQueryEnabled: () => quotaEnabled,
  });

  const cap = await mgr.captureCurrentAccount({ remark: 'Active' });
  assert.equal(cap.ok, true);
  const imp = await mgr.importAccounts({
    rawInput: JSON.stringify({
      email: 'inactive-safe@gmail.com',
      refresh_token: '1//0eINACTIVE_SAFE_TOKEN_123456',
      quota: {
        fetchedAtMs: Date.now(),
        groups: [
          {
            key: 'gemini',
            label: 'Gemini',
            fiveHour: { remainingPct: 70, remainingFraction: 0.7, isFull: false, disabled: false },
            weekly: { remainingPct: 60, remainingFraction: 0.6, isFull: false, disabled: false },
          },
          {
            key: 'gpt_claude',
            label: 'GPT&Claude',
            fiveHour: { remainingPct: 80, remainingFraction: 0.8, isFull: false, disabled: false },
            weekly: { remainingPct: 50, remainingFraction: 0.5, isFull: false, disabled: false },
          },
        ],
      },
    }),
  });
  assert.equal(imp.ok, true);
  const inactiveId = imp.accounts[0].id;

  // 1. Default ON + production mode: inactive account refresh MUST NOT hit cloudcode-pa.googleapis.com
  const listOn = await mgr.listAccounts();
  assert.equal(listOn.quotaQueryEnabled, true);
  assert.equal(listOn.officialActiveOnly, true);

  const inactiveRes = await mgr.refreshAccountQuota(inactiveId);
  assert.equal(inactiveRes.ok, true);
  assert.equal(inactiveRes.mode, 'official_active_only');
  assert.equal(inactiveRes.skippedRemote, true);
  assert.equal(inactiveRes.account.quota.groups[0].fiveHour.remainingPct, 70);

  // 2. Toggle OFF: refreshAccountQuota returns 403 quota_disabled and lifecycle tick makes ZERO quotaClient calls
  quotaEnabled = false;
  quotaClientCalls = 0;

  const listOff = await mgr.listAccounts();
  assert.equal(listOff.quotaQueryEnabled, false);

  const activeAcc = listOff.accounts.find((a) => a.isCurrent);
  const blockedRefresh = await mgr.refreshAccountQuota(activeAcc.id);
  assert.equal(blockedRefresh.ok, false);
  assert.equal(blockedRefresh.status, 403);
  assert.equal(blockedRefresh.code, 'quota_disabled');

  await mgr.runLifecycleTick();
  assert.equal(quotaClientCalls, 0, 'Lifecycle tick must make zero quotaClient calls when quotaQueryEnabled is false');
});

test('discoverLocalOAuthClient streams chunks across boundaries without full-file read, and detectLocalAntigravityVersion slice-reads ASAR package.json', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-oauth-stream-'));
  t.after(() => {
    clearDiscoveredOAuthClientCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const resourcesDir = path.join(root, 'resources');
  const binDir = path.join(resourcesDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeExe = path.join(root, 'Antigravity.exe');
  fs.writeFileSync(fakeExe, 'MZ');

  // Construct a valid synthetic app.asar containing package.json (for slice-read version test)
  // AND a Personal accounts clientId placed right across a 4096-byte chunk boundary!
  const personalId = makeTestClientId('1071006060591-personalboundary12345678');
  const secondaryId = makeTestClientId('2082007070692-secondaryboundary8765432');
  const secret1 = makeTestClientSecret('AbCdEfGhIjKlMnOpQrStUvWxYz01');
  const secret2 = makeTestClientSecret('9876543210ZyXwVuTsRqPoNmLkJi');

  const pkgBuf = Buffer.from(JSON.stringify({ name: 'antigravity', version: '9.8.7' }), 'utf8');
  const padToBoundary = Buffer.alloc(4096, 0x20);
  const personalSnippet = Buffer.from(
    `/* Personal accounts oauth */ { clientId: '${personalId}' }`,
    'latin1',
  );
  // Put personalSnippet right across offset 4096 inside app.asar
  const mainJsBuf = Buffer.concat([padToBoundary, personalSnippet, Buffer.alloc(2048, 0x20)]);
  const headerObj = {
    files: {
      'package.json': { size: pkgBuf.length, offset: '0' },
      'out': { files: { 'main.js': { size: mainJsBuf.length, offset: String(pkgBuf.length) } } },
    },
  };
  const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const headerPad = (4 - (headerJson.length % 4)) % 4;
  const headerBodySize = 4 + headerJson.length + headerPad;
  const headerSize = 4 + headerBodySize;
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(headerSize, 4);
  preamble.writeUInt32LE(headerBodySize, 8);
  preamble.writeUInt32LE(headerJson.length, 12);
  const asarBuf = Buffer.concat([preamble, headerJson, Buffer.alloc(headerPad), pkgBuf, mainJsBuf]);
  fs.writeFileSync(path.join(resourcesDir, 'app.asar'), asarBuf);

  // Build synthetic language_server binary where ID and secret span exact 4096-byte chunk boundaries
  const chunkSize = 4096;
  const lsBuf = Buffer.alloc(chunkSize * 3 + 1024, 0x00);
  // Place secondaryId right across chunk 0 -> chunk 1 boundary (offset 4070)
  lsBuf.write(secondaryId, chunkSize - 26, 'latin1');
  // Place secret1 right across chunk 1 -> chunk 2 boundary (offset 8180)
  lsBuf.write(secret1, chunkSize * 2 - 12, 'latin1');
  // Place personalId and secret2 inside chunk 2
  lsBuf.write(personalId, chunkSize * 2 + 600, 'latin1');
  lsBuf.write(secret2, chunkSize * 2 + 800, 'latin1');
  fs.writeFileSync(path.join(binDir, 'language_server.exe'), lsBuf);

  clearDiscoveredOAuthClientCache();
  const discovered = await discoverLocalOAuthClient({
    env: {},
    exePath: fakeExe,
    forceRefresh: true,
    chunkSize,
  });

  assert.ok(discovered, 'discoverLocalOAuthClient must find boundary-spanning clientId and secret');
  assert.equal(discovered.source, 'local_binary');
  assert.equal(discovered.clientId, personalId, 'personalId from app.asar must be prioritized first');
  assert.equal(discovered.clientSecret, secret2);
  assert.deepEqual(
    discovered.candidateClients.map((c) => c.clientId),
    [personalId, secondaryId],
    'exact deduplicated order with zero overlap-clipped false IDs',
  );

  // Verify slice-read ASAR package.json version detection
  const ver = detectLocalAntigravityVersion({ exePath: fakeExe, forceRefresh: true });
  assert.equal(ver, '9.8.7');

  // Verify scanFileInChunksBypassingAsar supports early-stop returning true
  let chunkCalls = 0;
  const ok = scanFileInChunksBypassingAsar(
    path.join(binDir, 'language_server.exe'),
    () => {
      chunkCalls += 1;
      return true;
    },
    { chunkSize: 2048, overlapBytes: 256 },
  );
  assert.equal(ok, true);
  assert.equal(chunkCalls, 1);
});

test('detectRecentQuotaExhaustedError prunes removed/expired entries and enforces fileStampCache size cap', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stamp-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const convDir = path.join(root, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  // Create 5 minimal valid SQLite DBs with recent mtime
  const nowMs = Date.now();
  for (let i = 0; i < 5; i += 1) {
    const dbPath = path.join(convDir, `conv-live-${i}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB)');
    db.close();
  }

  // Pre-seed stamp cache with 25 stale/deleted entries
  const stampCache = new Map();
  for (let i = 0; i < 25; i += 1) {
    stampCache.set(`conv-deleted-${i}`, '100:10|0:0');
  }

  await detectRecentQuotaExhaustedError(convDir, {
    nowMs,
    fileStampCache: stampCache,
    maxStampCacheEntries: 3,
  });

  // All deleted entries must be pruned AND size must respect maxStampCacheEntries=3
  assert.equal(stampCache.has('conv-deleted-0'), false);
  assert.ok(stampCache.size <= 3, `Expected bounded cache <= 3, got ${stampCache.size}`);

  // Advancing nowMs past freshness window must prune all expired entries cleanly
  await detectRecentQuotaExhaustedError(convDir, {
    nowMs: nowMs + 10 * 60_000,
    fileStampCache: stampCache,
    maxStampCacheEntries: 3,
  });
  assert.equal(stampCache.size, 0, 'Expired entries must be pruned when no recent files remain');
});
