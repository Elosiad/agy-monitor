import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildChromiumProxyArgs,
  DEFAULT_PROXY_CONFIG,
  detectSystemProxyUrlSync,
  inspectProxyRuntimeStatus,
  maskProxyUrl,
  normalizeProxyBypass,
  normalizeProxyConfig,
  normalizeProxyUrl,
  parseMacScutilProxyOutput,
  parseWindowsProxyServerValue,
  probeProxyConnectivity,
  resolveEffectiveProxySpec,
} from '../sidecars/agy_monitor/backend/proxy_manager.mjs';
import { buildFrontendBundle } from '../sidecars/agy_monitor/backend/bundle_builder.mjs';
import { buildMainHookScript, NATIVE_HUD_VERSION, readNativeHudHeartbeat } from '../sidecars/agy_monitor/backend/hud_injector.mjs';
import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import { createMonitorHandlers } from '../sidecars/agy_monitor/main.mjs';

test('proxy_manager: defaults enabled=true, normalizes URLs/credentials/bypass, and maps socks5h->socks5 for Chromium', () => {
  assert.equal(DEFAULT_PROXY_CONFIG.enabled, true);
  assert.equal(DEFAULT_PROXY_CONFIG.mode, 'auto');

  const normDefault = normalizeProxyConfig(undefined);
  assert.equal(normDefault.enabled, true);
  assert.equal(normDefault.mode, 'auto');
  assert.equal(normDefault.url, '');
  assert.equal(normDefault.bypass, 'localhost,127.0.0.1,::1');
  assert.equal(normDefault.forceHttp1, false);

  // Shorthand host:port -> http://host:port
  const bare = normalizeProxyUrl('127.0.0.1:7897');
  assert.equal(bare.ok, true);
  assert.equal(bare.url, 'http://127.0.0.1:7897');
  assert.equal(bare.displayUrl, 'http://127.0.0.1:7897');

  // Auth masking & socks5h -> socks5 Chromium mapping
  const socksAuth = normalizeProxyUrl('socks5h://alice:s3cr3t@127.0.0.1:1080');
  assert.equal(socksAuth.ok, true);
  assert.equal(socksAuth.hasAuth, true);
  assert.equal(socksAuth.username, 'alice');
  assert.equal(socksAuth.password, 's3cr3t');
  assert.equal(socksAuth.displayUrl, 'socks5h://***@127.0.0.1:1080');
  assert.equal(maskProxyUrl('http://u:p@127.0.0.1:7890'), 'http://***@127.0.0.1:7890');

  const chrom = buildChromiumProxyArgs('socks5h://alice:s3cr3t@127.0.0.1:1080', 'example.internal; 10.0.0.0/8');
  assert.equal(chrom.chromiumServer, 'socks5://127.0.0.1:1080');
  assert.equal(chrom.bypassCsv, 'localhost,127.0.0.1,::1,example.internal,10.0.0.0/8');
  assert.equal(chrom.chromiumBypass, 'localhost;127.0.0.1;[::1];example.internal;10.0.0.0/8');

  // Mandatory loopback hosts cannot be stripped
  assert.equal(normalizeProxyBypass(''), 'localhost,127.0.0.1,::1');
  assert.equal(normalizeProxyBypass('*.corp.local'), 'localhost,127.0.0.1,::1,*.corp.local');

  // Reject invalid schemes, control characters, paths, bad ports
  assert.equal(normalizeProxyUrl('ftp://127.0.0.1:21').ok, false);
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7897/path').ok, false);
  assert.equal(normalizeProxyUrl('http://127.0.0.1:99999').ok, false);
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7897;calc').ok, false);
  assert.equal(normalizeProxyUrl('not-a-proxy').ok, false);
});

test('proxy_manager: OS system proxy parsers (Windows Registry & macOS scutil) and effective spec resolution', () => {
  assert.equal(parseWindowsProxyServerValue('127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(
    parseWindowsProxyServerValue('http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892'),
    'http://127.0.0.1:7891',
  );
  assert.equal(parseWindowsProxyServerValue('socks=127.0.0.1:10808'), 'socks5://127.0.0.1:10808');

  assert.equal(
    parseMacScutilProxyOutput('<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n  HTTPPort : 7897\n}'),
    'http://127.0.0.1:7897',
  );
  assert.equal(
    parseMacScutilProxyOutput('<dictionary> {\n  SOCKSEnable : 1\n  SOCKSProxy : 127.0.0.1\n  SOCKSPort : 1080\n}'),
    'socks5://127.0.0.1:1080',
  );

  // Skip self-injected proxy env so auto-detect reads real OS state
  const detectedFromWinReg = detectSystemProxyUrlSync({
    env: {
      AGY_MONITOR_INJECTED_PROXY: 'http://127.0.0.1:9999',
      HTTPS_PROXY: 'http://127.0.0.1:9999',
    },
    platform: 'win32',
    execFileSyncFn: () =>
      '    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7897\r\n',
  });
  assert.equal(detectedFromWinReg, 'http://127.0.0.1:7897');

  // Auto mode with system proxy -> source='system'
  const autoWithSys = resolveEffectiveProxySpec(DEFAULT_PROXY_CONFIG, {
    systemProxyUrl: 'http://127.0.0.1:7897',
  });
  assert.equal(autoWithSys.source, 'system');
  assert.equal(autoWithSys.url, 'http://127.0.0.1:7897');

  // Auto mode with NO system proxy -> clean direct ('none')
  const autoDirect = resolveEffectiveProxySpec(DEFAULT_PROXY_CONFIG, {
    systemProxyUrl: '',
  });
  assert.equal(autoDirect.source, 'none');
  assert.equal(autoDirect.url, '');
  assert.equal(autoDirect.specKey, 'direct');

  // Runtime status transitions
  const activeStatus = inspectProxyRuntimeStatus(
    { enabled: true, url: 'http://127.0.0.1:7897', forceHttp1: true },
    {
      hookAlive: true,
      proxyStartupSpecKey: 'http://127.0.0.1:7897|localhost,127.0.0.1,::1|h1',
      proxySpecKey: 'http://127.0.0.1:7897|localhost,127.0.0.1,::1|h1',
    },
    { systemProxyUrl: '' },
  );
  assert.equal(activeStatus.state, 'active');
  assert.equal(activeStatus.needsRestart, false);

  const partialStatus = inspectProxyRuntimeStatus(
    { enabled: true, url: 'http://127.0.0.1:7897', forceHttp1: false },
    {
      hookAlive: true,
      proxyStartupSpecKey: 'direct',
      proxySpecKey: 'http://127.0.0.1:7897|localhost,127.0.0.1,::1|h2',
    },
    { systemProxyUrl: '' },
  );
  assert.equal(partialStatus.state, 'partial_restart');
  assert.equal(partialStatus.needsRestart, true);
});

test('proxy_manager: live HTTP CONNECT & SOCKS5 (with auth) tunnel connectivity probes', async () => {
  // 1. Local mock HTTP CONNECT proxy (accepts Basic auth user:pass)
  let capturedConnectLine = '';
  let capturedAuthHeader = '';
  const httpProxy = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      const lines = buf.split('\r\n');
      capturedConnectLine = lines[0] || '';
      capturedAuthHeader = lines.find((l) => /^Proxy-Authorization:/i.test(l)) || '';
      const expected = `Basic ${Buffer.from('bob:pw123').toString('base64')}`;
      if (capturedAuthHeader.includes(expected)) {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      } else {
        socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      }
      socket.end();
    });
  });
  await new Promise((resolve) => httpProxy.listen(0, '127.0.0.1', resolve));
  const httpPort = httpProxy.address().port;

  // 2. Local mock SOCKS5 proxy supporting RFC 1929 user/pass auth
  const socksProxy = net.createServer((socket) => {
    let stage = 0;
    socket.on('data', (chunk) => {
      if (stage === 0) {
        assert.equal(chunk[0], 0x05);
        const methods = chunk.subarray(2, 2 + chunk[1]);
        if (methods.includes(0x02)) {
          stage = 1;
          socket.write(Buffer.from([0x05, 0x02]));
        } else {
          stage = 2;
          socket.write(Buffer.from([0x05, 0x00]));
        }
      } else if (stage === 1) {
        const ulen = chunk[1];
        const user = chunk.subarray(2, 2 + ulen).toString('utf8');
        const plen = chunk[2 + ulen];
        const pass = chunk.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
        if (user === 'suser' && pass === 'spass') {
          stage = 2;
          socket.write(Buffer.from([0x01, 0x00]));
        } else {
          socket.write(Buffer.from([0x01, 0x01]));
          socket.end();
        }
      } else if (stage === 2) {
        assert.equal(chunk[0], 0x05);
        assert.equal(chunk[1], 0x01); // CONNECT
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x01, 0xbb]));
        socket.end();
      }
    });
  });
  await new Promise((resolve) => socksProxy.listen(0, '127.0.0.1', resolve));
  const socksPort = socksProxy.address().port;

  try {
    const okHttp = await probeProxyConnectivity(`http://bob:pw123@127.0.0.1:${httpPort}`, {
      targetHost: 'daily-cloudcode-pa.googleapis.com',
      targetPort: 443,
      timeoutMs: 2500,
    });
    assert.equal(okHttp.ok, true);
    assert.equal(okHttp.reachable, true);
    assert.equal(okHttp.tunnelOk, true);
    assert.equal(okHttp.url, `http://***@127.0.0.1:${httpPort}`);
    assert.match(capturedConnectLine, /^CONNECT daily-cloudcode-pa\.googleapis\.com:443 HTTP\/1\.1$/);

    const badAuthHttp = await probeProxyConnectivity(`http://bob:wrong@127.0.0.1:${httpPort}`, {
      timeoutMs: 2500,
    });
    assert.equal(badAuthHttp.ok, false);
    assert.equal(badAuthHttp.reachable, true);
    assert.equal(badAuthHttp.statusCode, 407);

    const okSocks = await probeProxyConnectivity(`socks5h://suser:spass@127.0.0.1:${socksPort}`, {
      targetHost: 'daily-cloudcode-pa.googleapis.com',
      targetPort: 443,
      timeoutMs: 2500,
    });
    assert.equal(okSocks.ok, true);
    assert.equal(okSocks.tunnelOk, true);
    assert.equal(okSocks.url, `socks5h://***@127.0.0.1:${socksPort}`);

    const badAuthSocks = await probeProxyConnectivity(`socks5://suser:nope@127.0.0.1:${socksPort}`, {
      timeoutMs: 2500,
    });
    assert.equal(badAuthSocks.ok, false);
    assert.equal(badAuthSocks.reachable, true);
  } finally {
    await new Promise((r) => httpProxy.close(r));
    await new Promise((r) => socksProxy.close(r));
  }
});

test('proxy integration: storage default ON, API validation/persistence, native main hook, and Other tab top placement', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-proxy-int-'));
  try {
    const paths = resolvePaths({
      appDataDir: path.join(tmpDir, 'appdata'),
      geminiConfigDir: path.join(tmpDir, 'config'),
      hostAsarPath: path.join(tmpDir, 'missing-app.asar'),
    });
    const storage = createStorage(paths);

    // 1. Default prefs have proxy.enabled === true
    const initPrefs = await storage.getPrefs();
    assert.equal(initPrefs.proxy.enabled, true);
    assert.equal(initPrefs.proxy.mode, 'auto');

    // 2. Sidecar API routes
    const routes = createMonitorHandlers({ paths, storage });
    const getPrefs = routes.get('GET /api/preferences');
    const postProxy = routes.get('POST /api/preferences/proxy');
    const postTest = routes.get('POST /api/proxy/test');
    assert.equal(typeof postProxy, 'function');
    assert.equal(typeof postTest, 'function');

    const prefResp = await getPrefs();
    assert.equal(prefResp.proxy.enabled, true);
    assert.equal(typeof prefResp.proxyStatus.state, 'string');

    // Reject malformed URL with HTTP 400
    const badResp = await postProxy({ url: 'ftp://bad.host:21' });
    assert.equal(badResp.status, 400);

    // Persist custom proxy + forceHttp1
    const savedResp = await postProxy({
      enabled: true,
      url: 'socks5h://127.0.0.1:7897',
      forceHttp1: true,
    });
    assert.equal(savedResp.ok, true);
    assert.equal(savedResp.proxy.enabled, true);
    assert.equal(savedResp.proxy.mode, 'custom');
    assert.equal(savedResp.proxy.url, 'socks5h://127.0.0.1:7897');
    assert.equal(savedResp.proxy.forceHttp1, true);

    // Toggle off preserves saved URL
    const offResp = await postProxy({ enabled: false });
    assert.equal(offResp.ok, true);
    assert.equal(offResp.proxy.enabled, false);
    assert.equal(offResp.proxy.url, 'socks5h://127.0.0.1:7897');
    assert.equal(offResp.proxyStatus.state, 'disabled');

    // Heartbeat exposes proxy telemetry fields
    fs.mkdirSync(path.dirname(paths.nativeHudStatusFile), { recursive: true });
    fs.writeFileSync(
      paths.nativeHudStatusFile,
      JSON.stringify({
        version: NATIVE_HUD_VERSION,
        pid: 1234,
        mountedCount: 1,
        proxyActive: true,
        proxyEnabled: true,
        proxyDisplayUrl: 'http://127.0.0.1:7897',
        proxySpecKey: 'http://127.0.0.1:7897|localhost,127.0.0.1,::1|h2',
        proxyStartupSpecKey: 'http://127.0.0.1:7897|localhost,127.0.0.1,::1|h2',
        proxyForceHttp1: false,
        updatedAtMs: Date.now(),
      }),
      'utf8',
    );
    const hb = readNativeHudHeartbeat(paths);
    assert.equal(hb.proxyActive, true);
    assert.equal(hb.proxyDisplayUrl, 'http://127.0.0.1:7897');

    // 3. Native Electron main-process hook parses cleanly & never sets NODE_USE_ENV_PROXY
    const mainHookSrc = buildMainHookScript();
    assert.doesNotThrow(() => new vm.Script(mainHookSrc, { filename: 'agy-monitor-hud-main.js' }));
    assert.match(mainHookSrc, /proxy-server/);
    assert.match(mainHookSrc, /proxy-bypass-list/);
    assert.match(mainHookSrc, /http2client=0/);
    assert.match(mainHookSrc, /defaultSession\.setProxy/);
    assert.doesNotMatch(mainHookSrc, /NODE_USE_ENV_PROXY/);

    // 4. HTML places #otherProxyCard at the VERY TOP of #panelOther (before #otherQuotaMasterCard) & default checked
    const frontendDir = path.resolve(process.cwd(), 'sidecars/agy_monitor/frontend');
    const html = fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8');
    const panelStart = html.indexOf('id="panelOther"');
    const proxyCardIdx = html.indexOf('id="otherProxyCard"', panelStart);
    const quotaCardIdx = html.indexOf('id="otherQuotaMasterCard"', panelStart);
    assert.ok(panelStart > 0 && proxyCardIdx > panelStart && quotaCardIdx > proxyCardIdx);
    assert.match(html, /id="otherProxyToggle"[\s\S]{0,120}\bchecked\b/);

    // 5. Frontend bundle compiles cleanly with updated other_hub.js
    const bundle = await buildFrontendBundle(frontendDir);
    assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'bundle.js' }));
    assert.match(bundle, /otherProxyToggle/);
    assert.match(bundle, /\/api\/preferences\/proxy/);
    assert.match(bundle, /\/api\/proxy\/test/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
