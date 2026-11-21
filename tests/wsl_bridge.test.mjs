import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  WSL_CDP_TUNNEL_SOURCE,
  createWslCdpLocalProxy,
  detectWindowsHostEnv,
  resolveWslGatewayIp,
  toWindowsPath,
  winPathToWslPosix,
} from '../sidecars/agy_monitor/backend/wsl_bridge.mjs';
import {
  buildCdpThemeCss,
  isAntigravityAppTarget,
  rewriteTargetWsUrl,
} from '../sidecars/agy_monitor/backend/cdp_theme_bridge.mjs';

const execFileAsync = promisify(execFile);

test('detectWindowsHostEnv & WSL2 path helpers handle native Win, pure Linux, /mnt/c and custom /c mounts', async () => {
  const nativeWin = detectWindowsHostEnv({ platform: 'win32', env: {} });
  assert.equal(nativeWin.isNativeWindows, true);
  assert.equal(nativeWin.isWsl, false);
  assert.equal(nativeWin.hasWindowsHost, true);

  const pureLinux = detectWindowsHostEnv({
    platform: 'linux',
    env: {},
    procVersion: 'Linux version 6.6.0-generic (ubuntu)',
    fsExists: () => false,
  });
  assert.equal(pureLinux.isWsl, false);
  assert.equal(pureLinux.hasWindowsHost, false);

  const wslMnt = detectWindowsHostEnv({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' },
    procVersion: 'Linux version 5.15.153.1-microsoft-standard-WSL2',
    fsExists: (p) => p.startsWith('/mnt/c/Windows/'),
  });
  assert.equal(wslMnt.isWsl, true);
  assert.equal(wslMnt.hasWindowsHost, true);
  assert.equal(wslMnt.winMountRoot, '/mnt/c');
  assert.equal(wslMnt.mountBase, '/mnt');
  assert.equal(
    wslMnt.cscPath,
    '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );

  // Drive conversion both ways
  assert.equal(
    winPathToWslPosix('C:\\Users\\Alice\\AppData\\Local', wslMnt),
    '/mnt/c/Users/Alice/AppData/Local',
  );
  assert.equal(
    await toWindowsPath('/mnt/c/Users/Alice/file.txt', wslMnt),
    'C:\\Users\\Alice\\file.txt',
  );
  // Ext4 path conversion via wslpath & fallback
  assert.equal(
    await toWindowsPath('/home/alice/.gemini/antigravity', wslMnt, {
      execImpl: async () => ({
        stdout: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\.gemini\\antigravity\n',
      }),
    }),
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\.gemini\\antigravity',
  );
  assert.equal(
    await toWindowsPath('/home/alice/fallback', wslMnt, {
      execImpl: async () => {
        throw new Error('wslpath missing');
      },
    }),
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\fallback',
  );
  // Non-existent leaf path walks up to nearest existing parent for wslpath -w (even when distroName is empty)
  assert.equal(
    await toWindowsPath(
      '/home/alice/.gemini/antigravity/plugin_data/agy-monitor',
      { ...wslMnt, distroName: '' },
      {
        execImpl: async (_cmd, args) => {
          if (args[1] === '/home/alice') {
            return { stdout: '\\\\wsl.localhost\\Ubuntu\\home\\alice\n' };
          }
          throw new Error('No such file or directory');
        },
      },
    ),
    '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.gemini\\antigravity\\plugin_data\\agy-monitor',
  );

  // Custom root=/ mount (/c)
  const wslRootC = detectWindowsHostEnv({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Debian' },
    procVersion: 'Linux version 6.1.0-microsoft-standard-WSL2',
    fsExists: (p) => p.startsWith('/c/Windows/'),
  });
  assert.equal(wslRootC.winMountRoot, '/c');
  assert.equal(wslRootC.mountBase, '');
  assert.equal(winPathToWslPosix('C:\\Users\\Bob', wslRootC), '/c/Users/Bob');
  assert.equal(await toWindowsPath('/c/Users/Bob/test.cmd', wslRootC), 'C:\\Users\\Bob\\test.cmd');

  // Gateway IP extraction from /proc/net/route (little-endian 172.24.0.1 = 010018AC) and /etc/resolv.conf
  const routeSample = [
    'Iface\tDestination\tGateway \tFlags',
    'eth0\t00000000\t010018AC\t0003',
  ].join('\n');
  assert.equal(resolveWslGatewayIp({ procNetRoute: routeSample, resolvConf: '' }), '172.24.0.1');
  assert.equal(
    resolveWslGatewayIp({ procNetRoute: '', resolvConf: 'nameserver 172.28.112.1\n' }),
    '172.28.112.1',
  );
});

test('isAntigravityAppTarget allows WSL Remote https://127.0.0.1:<port> host pages while blocking sidecar & external sites', () => {
  // 1. WSL Remote main workbench window
  assert.equal(
    isAntigravityAppTarget({
      type: 'page',
      url: 'https://127.0.0.1:41982/?tkn=abc',
      title: 'my-project [WSL: Ubuntu] - Antigravity',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/WSL1',
    }),
    true,
  );
  assert.equal(
    isAntigravityAppTarget({
      type: 'page',
      url: 'https://localhost:41982/workbench',
      title: 'Antigravity',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/WSL2',
    }),
    true,
  );

  // 2. Native Electron host window
  assert.equal(
    isAntigravityAppTarget({
      type: 'page',
      url: 'vscode-file://vscode-app/c:/app/workbench.html',
      title: 'agy-plugin - Antigravity',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/WIN1',
    }),
    true,
  );

  // 3. Reject AGY Monitor's own sidecar console & iframes
  assert.equal(
    isAntigravityAppTarget({
      type: 'iframe',
      url: 'http://127.0.0.1:51234/',
      title: 'Antigravity Monitor',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/SIDECAR1',
    }),
    false,
  );
  assert.equal(
    isAntigravityAppTarget({
      type: 'page',
      url: 'http://127.0.0.1:51234/',
      title: 'Antigravity Monitor',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/SIDECAR2',
    }),
    false,
  );

  // 4. Reject unrelated localhost dev servers & external sites
  assert.equal(
    isAntigravityAppTarget({
      type: 'page',
      url: 'http://localhost:3000/',
      title: 'Vite App',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/DEV1',
    }),
    false,
  );
  assert.equal(
    isAntigravityAppTarget({
      type: 'page',
      url: 'https://github.com/aishadiaodeqishui/agy-monitor',
      title: 'Antigravity Issue',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/EXT1',
    }),
    false,
  );

  // 5. WebSocket debugger URL rewrite for WSL2 tunnel/gateway
  assert.equal(
    rewriteTargetWsUrl('ws://127.0.0.1:9229/devtools/page/ABC', 9229, '127.0.0.1', 54321),
    'ws://127.0.0.1:54321/devtools/page/ABC',
  );
  assert.equal(
    rewriteTargetWsUrl('ws://localhost:9229/devtools/page/XYZ', 9229, '172.24.0.1', 9229),
    'ws://172.24.0.1:9229/devtools/page/XYZ',
  );

  // 6. Enhanced Scheme 2 CSS lifts workbench shell & light/dark surfaces while protecting popups
  const css = buildCdpThemeCss(
    { opacity: 80, blur: 2, dim: 20, hostBlendPct: 25, colors: { canvas: '#f7f7f9', chrome: '#ececf0', bubble: '#ffffff', accent: '#5b8cff' } },
    'data:image/webp;base64,AA==',
  );
  assert.match(css, /\.monaco-workbench/);
  assert.match(css, /\.monaco-editor-background/);
  assert.match(css, /\.part\.auxiliarybar/);
  assert.match(css, /\[data-agy-mon-layer="surface-soft"\]/);
  assert.match(css, /\.monaco-hover/);
});

test('WSL CDP loopback tunnel C# binary compiles cleanly and proxies HTTP /json/list end-to-end', async (t) => {
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  if (process.platform !== 'win32' || !fs.existsSync(csc)) {
    t.skip('Windows .NET csc.exe not available in this environment');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wsl-tunnel-test-'));
  let proxy = null;
  let mockCdpServer = null;
  t.after(async () => {
    try {
      proxy?.close();
    } catch {}
    try {
      mockCdpServer?.closeAllConnections?.();
      mockCdpServer?.close();
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 });
  });

  const csPath = path.join(tmpDir, 'AgyWslCdpTunnel.cs');
  const exePath = path.join(tmpDir, 'agy_wsl_cdp_tunnel.exe');
  fs.writeFileSync(csPath, WSL_CDP_TUNNEL_SOURCE, 'utf8');

  await execFileAsync(csc, ['/nologo', '/target:exe', '/optimize+', `/out:${exePath}`, csPath], {
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(fs.existsSync(exePath), true);

  // Spin up mock Windows-side CDP /json/list HTTP server on an ephemeral loopback port
  const fakeTargets = [
    {
      type: 'page',
      url: 'https://127.0.0.1:41982/',
      title: 'demo [WSL: Ubuntu] - Antigravity',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/TUNNEL1',
    },
  ];
  mockCdpServer = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(fakeTargets));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  // Also handle real RFC6455 WebSocket upgrade (echoing a JSON-RPC CDP reply frame)
  mockCdpServer.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    const key = String(req.headers['sec-websocket-key'] || '');
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('data', (buf) => {
      if (!buf || buf.length < 6) return;
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x08) {
        socket.end();
        return;
      }
      if (opcode !== 0x01) return;
      const payloadLen = buf[1] & 0x7f;
      const mask = buf.subarray(2, 6);
      const raw = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i += 1) {
        raw[i] = buf[6 + i] ^ mask[i % 4];
      }
      const msg = JSON.parse(raw.toString('utf8'));
      const replyBytes = Buffer.from(
        JSON.stringify({ id: msg.id, result: { value: 'wsl-cdp-ok' } }),
        'utf8',
      );
      const header = Buffer.from([0x81, replyBytes.length]);
      socket.write(Buffer.concat([header, replyBytes]));
    });
  });
  await new Promise((resolve) => mockCdpServer.listen(0, '127.0.0.1', resolve));
  const targetPort = mockCdpServer.address().port;

  proxy = await createWslCdpLocalProxy(targetPort, { tunnelExePosix: exePath });
  assert.ok(proxy && proxy.localPort > 0);

  // 1. HTTP /json/list through tunnel
  const resp = await fetch(`http://127.0.0.1:${proxy.localPort}/json/list`, {
    headers: { Connection: 'close' },
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.deepEqual(body, fakeTargets);

  // 2. Real full-duplex WebSocket JSON-RPC through tunnel
  const wsUrl = rewriteTargetWsUrl(
    `ws://127.0.0.1:${targetPort}/devtools/page/TUNNEL1`,
    targetPort,
    '127.0.0.1',
    proxy.localPort,
  );
  const wsReply = await new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('WS tunnel timeout'));
    }, 3000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate' }));
    });
    ws.addEventListener('message', (ev) => {
      clearTimeout(timer);
      const parsed = JSON.parse(String(ev.data || '{}'));
      ws.close();
      resolve(parsed);
    });
    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  assert.deepEqual(wsReply, { id: 7, result: { value: 'wsl-cdp-ok' } });
});
