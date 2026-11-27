/**
 * Standalone TUN-free Proxy Manager for Antigravity (`agy-monitor`).
 *
 * Bridges Antigravity's dual network stacks without requiring OS-level TUN mode:
 *   1. Electron / Chromium UI (`--proxy-server`, `--proxy-bypass-list`, `session.defaultSession.setProxy`)
 *   2. Go `language_server` child process (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`,
 *      plus optional `GODEBUG=http2client=0` to avoid Go HTTP/2 proxy EOF drops).
 *
 * Design principles (zero external dependencies):
 *   - Default ON (`enabled: true`, `mode: 'auto'`, `url: ''`): automatically detects active
 *     Windows/macOS/env system proxy without disrupting direct-connection machines.
 *   - Custom proxy URL supports `http://`, `https://`, `socks5://`, `socks5h://` (mapping
 *     `socks5h:` -> `socks5:` for Chromium, and never setting `NODE_USE_ENV_PROXY=1`).
 *   - Loopback hosts (`localhost`, `127.0.0.1`, `::1`) are ALWAYS preserved in bypass lists so
 *     local Antigravity IPC / language_server / sidecar traffic never hits an external proxy.
 *   - Real HTTP `CONNECT` & SOCKS5 (RFC 1928/1929) tunnel probe verifies end-to-end reachability.
 */

import { execFileSync } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';

export const ALLOWED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);
export const MANDATORY_BYPASS_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);
export const DEFAULT_PROXY_BYPASS = MANDATORY_BYPASS_HOSTS.join(',');
export const DEFAULT_PROBE_HOST = 'daily-cloudcode-pa.googleapis.com';
export const DEFAULT_PROBE_PORT = 443;

export const DEFAULT_PROXY_CONFIG = Object.freeze({
  enabled: true,
  mode: 'auto',
  url: '',
  bypass: DEFAULT_PROXY_BYPASS,
  forceHttp1: false,
});

const UNSAFE_PROXY_CHAR_RE = /[\r\n\t\0"'`<>;|&\s]/;
const SYSTEM_PROXY_CACHE_TTL_MS = 5000;

let cachedSystemProxyUrl = '';
let cachedSystemProxyAtMs = 0;

export function clearSystemProxyCache() {
  cachedSystemProxyUrl = '';
  cachedSystemProxyAtMs = 0;
}

/**
 * Validate and normalize a proxy URL.
 * Accepts `http://`, `https://`, `socks5://`, `socks5h://`, or bare `host:port` (defaults to `http://`).
 * Empty input is valid and indicates auto-detection mode.
 */
export function normalizeProxyUrl(raw) {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) {
    return {
      ok: true,
      url: '',
      displayUrl: '',
      protocol: '',
      hostname: '',
      port: 0,
      host: '',
      username: '',
      password: '',
      hasAuth: false,
    };
  }
  if (input.length > 512) {
    return { ok: false, error: '代理地址过长（最多 512 字符）' };
  }
  if (UNSAFE_PROXY_CHAR_RE.test(input)) {
    return { ok: false, error: '代理地址包含非法空白或控制字符' };
  }

  let candidate = input;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    if (/^(?:\[[0-9a-fA-F:]+\]|[^/\s:]+):\d{1,5}$/.test(candidate)) {
      candidate = `http://${candidate}`;
    } else {
      return {
        ok: false,
        error: '代理地址格式无效，请使用 http://、https:// 或 socks5:// 开头（如 http://127.0.0.1:7897）',
      };
    }
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: '代理地址无法解析，请检查协议、主机与端口' };
  }

  const protocol = String(parsed.protocol || '').toLowerCase();
  if (!ALLOWED_PROXY_PROTOCOLS.has(protocol)) {
    return {
      ok: false,
      error: `不支持的代理协议「${protocol.replace(/:$/, '')}」，仅支持 http / https / socks5 / socks5h`,
    };
  }

  const hostname = String(parsed.hostname || '').trim();
  if (!hostname) {
    return { ok: false, error: '代理地址缺少主机名或 IP' };
  }

  const defaultPort = protocol === 'https:' ? 443 : protocol === 'http:' ? 80 : 1080;
  const portNum = parsed.port ? Number(parsed.port) : defaultPort;
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { ok: false, error: '代理端口必须为 1–65535 之间的整数' };
  }

  if (parsed.pathname && parsed.pathname !== '/') {
    return { ok: false, error: '代理地址不应包含路径后缀，仅需 协议://主机:端口' };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: '代理地址不应包含查询参数或片段' };
  }

  const formattedHost = hostname.includes(':') && !hostname.startsWith('[')
    ? `[${hostname}]`
    : hostname;
  const hostPort = `${formattedHost}:${portNum}`;

  const rawUser = parsed.username || '';
  const rawPass = parsed.password || '';
  let username = '';
  let password = '';
  try {
    username = rawUser ? decodeURIComponent(rawUser) : '';
    password = rawPass ? decodeURIComponent(rawPass) : '';
  } catch {
    username = rawUser;
    password = rawPass;
  }

  const hasAuth = Boolean(rawUser || rawPass);
  const authPrefix = hasAuth ? `${rawUser}${rawPass ? `:${rawPass}` : ''}@` : '';
  const normalizedUrl = `${protocol}//${authPrefix}${hostPort}`;
  const displayUrl = `${protocol}//${hasAuth ? '***@' : ''}${hostPort}`;

  return {
    ok: true,
    url: normalizedUrl,
    displayUrl,
    protocol,
    hostname: hostname.replace(/^\[|\]$/g, ''),
    port: portNum,
    host: hostPort,
    username,
    password,
    hasAuth,
  };
}

/**
 * Mask embedded credentials in a proxy URL so secrets never leak to UI, status files, or logs.
 */
export function maskProxyUrl(raw) {
  const res = normalizeProxyUrl(raw);
  if (res.ok) return res.displayUrl;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+)@/, '$1***@');
}

/**
 * Normalize bypass list, always preserving loopback addresses (`localhost`, `127.0.0.1`, `::1`).
 */
export function normalizeProxyBypass(raw) {
  const seen = new Set();
  const list = [];
  const push = (token) => {
    const clean = String(token || '')
      .trim()
      .replace(/^\[(::1)\]$/, '$1');
    if (!clean || clean.length > 160 || /[\r\n\t\0"'`<>&|]/.test(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(clean);
  };

  for (const mandatory of MANDATORY_BYPASS_HOSTS) {
    push(mandatory);
  }
  if (typeof raw === 'string' && raw.trim()) {
    for (const part of raw.split(/[,;\s]+/)) {
      push(part);
    }
  } else if (Array.isArray(raw)) {
    for (const part of raw) {
      push(part);
    }
  }
  return list.slice(0, 64).join(',');
}

/**
 * Normalize persisted proxy preference object (defaults to enabled=true, auto mode).
 */
export function normalizeProxyConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const enabled = typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_PROXY_CONFIG.enabled;
  const parsedUrl = normalizeProxyUrl(src.url);
  const url = parsedUrl.ok ? parsedUrl.url : '';
  const mode = url ? 'custom' : (src.mode === 'custom' ? 'auto' : 'auto');
  const bypass = normalizeProxyBypass(src.bypass);
  const forceHttp1 = src.forceHttp1 === true;

  return {
    enabled,
    mode,
    url,
    bypass,
    forceHttp1,
  };
}

/**
 * Build Chromium / Electron proxy rules from a parsed/normalized proxy URL & bypass list.
 * Maps `socks5h://` -> `socks5://` and omits embedded credentials (Chromium handles auth via `login`).
 */
export function buildChromiumProxyArgs(rawUrl, rawBypass = DEFAULT_PROXY_BYPASS) {
  const parsed = normalizeProxyUrl(rawUrl);
  const bypassCsv = normalizeProxyBypass(rawBypass);
  const chromiumBypass = bypassCsv
    .split(',')
    .filter(Boolean)
    .map((entry) => (entry === '::1' ? '[::1]' : entry))
    .join(';');

  if (!parsed.ok || !parsed.url) {
    return {
      chromiumServer: '',
      chromiumBypass,
      bypassCsv,
    };
  }

  const chromiumProto = parsed.protocol === 'socks5h:' ? 'socks5:' : parsed.protocol;
  const chromiumServer = `${chromiumProto}//${parsed.host}`;
  return {
    chromiumServer,
    chromiumBypass,
    bypassCsv,
  };
}

/**
 * Parse Windows Registry `ProxyServer` value (single `host:port` or `http=...;https=...;socks=...`).
 */
export function parseWindowsProxyServerValue(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text) return '';
  if (!text.includes('=')) {
    const norm = normalizeProxyUrl(text);
    return norm.ok ? norm.url : '';
  }

  const map = new Map();
  for (const part of text.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const val = part.slice(idx + 1).trim();
    if (key && val) map.set(key, val);
  }

  for (const [key, defaultProto] of [
    ['https', 'http://'],
    ['http', 'http://'],
    ['socks', 'socks5://'],
    ['socks5', 'socks5://'],
  ]) {
    const val = map.get(key);
    if (!val) continue;
    const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(val) ? val : `${defaultProto}${val}`;
    const norm = normalizeProxyUrl(candidate);
    if (norm.ok && norm.url) return norm.url;
  }
  return '';
}

/**
 * Parse macOS `scutil --proxy` output into a single normalized proxy URL.
 */
export function parseMacScutilProxyOutput(output) {
  const text = String(output || '');
  if (!text) return '';
  const readVal = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm').exec(text);
    return m ? m[1].trim() : '';
  };

  if (readVal('HTTPSEnable') === '1') {
    const host = readVal('HTTPSProxy');
    const port = readVal('HTTPSPort');
    if (host && port) {
      const norm = normalizeProxyUrl(`http://${host}:${port}`);
      if (norm.ok && norm.url) return norm.url;
    }
  }
  if (readVal('HTTPEnable') === '1') {
    const host = readVal('HTTPProxy');
    const port = readVal('HTTPPort');
    if (host && port) {
      const norm = normalizeProxyUrl(`http://${host}:${port}`);
      if (norm.ok && norm.url) return norm.url;
    }
  }
  if (readVal('SOCKSEnable') === '1') {
    const host = readVal('SOCKSProxy');
    const port = readVal('SOCKSPort');
    if (host && port) {
      const norm = normalizeProxyUrl(`socks5://${host}:${port}`);
      if (norm.ok && norm.url) return norm.url;
    }
  }
  return '';
}

/**
 * Synchronously detect the active OS/environment system proxy URL.
 * Safe and bounded (<1.5s timeout); returns '' on direct connection or error.
 */
export function detectSystemProxyUrlSync({
  env = process.env,
  platform = process.platform,
  execFileSyncFn = execFileSync,
  fresh = false,
  nowMs = Date.now(),
} = {}) {
  const useDefaultCache = env === process.env && platform === process.platform && execFileSyncFn === execFileSync;
  if (useDefaultCache && !fresh && cachedSystemProxyAtMs > 0 && nowMs - cachedSystemProxyAtMs < SYSTEM_PROXY_CACHE_TTL_MS) {
    return cachedSystemProxyUrl;
  }

  let detected = '';

  // 1. Check standard proxy environment variables (skip our own injected proxy so toggling auto reflects OS state)
  const injectedSelf = String(env?.AGY_MONITOR_INJECTED_PROXY || '').trim();
  const envKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  for (const key of envKeys) {
    const val = typeof env?.[key] === 'string' ? env[key].trim() : '';
    if (!val || (injectedSelf && val === injectedSelf)) continue;
    const norm = normalizeProxyUrl(val);
    if (norm.ok && norm.url) {
      detected = norm.url;
      break;
    }
  }

  // 2. Query OS system proxy settings when no external env proxy is present
  if (!detected && platform === 'win32') {
    try {
      const out = execFileSyncFn(
        'reg.exe',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const enableMatch = /^\s*ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/m.exec(out);
      const enabled = enableMatch ? parseInt(enableMatch[1], 16) === 1 : false;
      if (enabled) {
        const serverMatch = /^\s*ProxyServer\s+REG_SZ\s+(.+)$/m.exec(out);
        if (serverMatch && serverMatch[1]) {
          detected = parseWindowsProxyServerValue(serverMatch[1]);
        }
      }
    } catch {
      // Direct connection or restricted registry read
    }
  } else if (!detected && platform === 'darwin') {
    try {
      const out = execFileSyncFn('scutil', ['--proxy'], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      detected = parseMacScutilProxyOutput(out);
    } catch {
      // ignore
    }
  }

  if (useDefaultCache) {
    cachedSystemProxyUrl = detected;
    cachedSystemProxyAtMs = nowMs;
  }
  return detected;
}

/**
 * Resolve the effective runtime proxy specification from user prefs + system proxy detection.
 */
export function resolveEffectiveProxySpec(proxyConfig, { env = process.env, systemProxyUrl = null, fresh = false } = {}) {
  const cfg = normalizeProxyConfig(proxyConfig);
  const detectedSys =
    typeof systemProxyUrl === 'string'
      ? (normalizeProxyUrl(systemProxyUrl).url || '')
      : detectSystemProxyUrlSync({ env, fresh });

  let effectiveUrl = '';
  let source = 'none';
  if (cfg.enabled) {
    if (cfg.url) {
      effectiveUrl = cfg.url;
      source = 'custom';
    } else if (detectedSys) {
      effectiveUrl = detectedSys;
      source = 'system';
    }
  }

  const parsed = normalizeProxyUrl(effectiveUrl);
  const { chromiumServer, chromiumBypass, bypassCsv } = buildChromiumProxyArgs(effectiveUrl, cfg.bypass);
  const specKey = cfg.enabled && effectiveUrl
    ? `${effectiveUrl}|${bypassCsv}|${cfg.forceHttp1 ? 'h1' : 'h2'}`
    : 'direct';

  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    url: effectiveUrl,
    displayUrl: parsed.ok ? parsed.displayUrl : '',
    detectedSystemProxy: maskProxyUrl(detectedSys),
    source,
    bypass: bypassCsv,
    chromiumServer,
    chromiumBypass,
    forceHttp1: cfg.forceHttp1,
    specKey,
  };
}

/**
 * Inspect proxy runtime status by combining saved prefs, detected system proxy,
 * and native Electron main-process hook heartbeat.
 */
export function inspectProxyRuntimeStatus(
  proxyConfig,
  heartbeat = null,
  { env = process.env, systemProxyUrl = null, fresh = false, asarState = '' } = {},
) {
  const effective = resolveEffectiveProxySpec(proxyConfig, { env, systemProxyUrl, fresh });
  const hb = heartbeat && typeof heartbeat === 'object' ? heartbeat : {};
  const hookAlive = Boolean(hb.hookAlive);
  const startupKey = typeof hb.proxyStartupSpecKey === 'string' ? hb.proxyStartupSpecKey : '';
  const liveKey = typeof hb.proxySpecKey === 'string' ? hb.proxySpecKey : '';

  let state = 'disabled';
  let needsRestart = false;

  if (!effective.enabled) {
    state = 'disabled';
    // If Antigravity started with a proxy injected into Go language_server, turning it OFF needs a restart for Go LS.
    needsRestart = Boolean(hookAlive && startupKey && startupKey !== 'direct');
  } else if (!effective.url) {
    state = 'auto_direct';
    needsRestart = Boolean(hookAlive && startupKey && startupKey !== 'direct');
  } else if (hookAlive && startupKey === effective.specKey) {
    state = 'active';
    needsRestart = false;
  } else if (hookAlive && liveKey === effective.specKey) {
    state = 'partial_restart';
    needsRestart = true;
  } else {
    state = 'needs_restart';
    needsRestart = true;
  }

  return {
    state,
    enabled: effective.enabled,
    mode: effective.mode,
    source: effective.source,
    effectiveUrl: effective.displayUrl,
    detectedSystemProxy: effective.detectedSystemProxy,
    forceHttp1: effective.forceHttp1,
    bypass: effective.bypass,
    hookAlive,
    asarState: String(asarState || ''),
    needsRestart,
  };
}

function readSocketChunk(socket, deadlineMs) {
  return new Promise((resolve, reject) => {
    const remaining = Math.max(100, deadlineMs - Date.now());
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(chunk);
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('代理服务器提前关闭连接'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('代理响应超时'));
    }, remaining);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('end', onClose);
    };
    socket.once('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('end', onClose);
  });
}

async function readExactBytes(socket, count, deadlineMs, leftover = Buffer.alloc(0)) {
  const chunks = leftover.length > 0 ? [leftover] : [];
  let total = leftover.length;
  while (total < count) {
    const chunk = await readSocketChunk(socket, deadlineMs);
    chunks.push(chunk);
    total += chunk.length;
  }
  const merged = Buffer.concat(chunks, total);
  return {
    data: merged.subarray(0, count),
    rest: merged.subarray(count),
  };
}

const SOCKS5_REPLY_ERRORS = new Map([
  [0x01, 'SOCKS5 代理服务器内部故障'],
  [0x02, 'SOCKS5 代理规则拒绝连接'],
  [0x03, 'SOCKS5 目标网络不可达'],
  [0x04, 'SOCKS5 目标主机不可达'],
  [0x05, 'SOCKS5 目标连接被拒绝'],
  [0x06, 'SOCKS5 TTL 超时'],
  [0x07, 'SOCKS5 不支持 CONNECT 命令'],
  [0x08, 'SOCKS5 不支持的地址类型'],
]);

async function probeHttpConnect(parsed, { targetHost, targetPort, timeoutMs }) {
  const startedAt = Date.now();
  const deadlineMs = startedAt + timeoutMs;
  let socket = null;
  let reachable = false;

  try {
    socket = await new Promise((resolve, reject) => {
      const isTls = parsed.protocol === 'https:';
      const s = isTls
        ? tls.connect({
            host: parsed.hostname,
            port: parsed.port,
            servername: net.isIP(parsed.hostname) ? undefined : parsed.hostname,
            timeout: timeoutMs,
          })
        : net.connect({ host: parsed.hostname, port: parsed.port });

      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`连接代理超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      const onConnect = () => {
        clearTimeout(timer);
        s.removeListener('error', onError);
        resolve(s);
      };
      const onError = (err) => {
        clearTimeout(timer);
        s.destroy();
        reject(err);
      };
      s.once(isTls ? 'secureConnect' : 'connect', onConnect);
      s.once('error', onError);
    });
    reachable = true;

    const authority = `${targetHost}:${targetPort}`;
    const headers = [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      'Proxy-Connection: Keep-Alive',
      'User-Agent: agy-monitor-proxy-probe/1.0',
    ];
    if (parsed.hasAuth) {
      const token = Buffer.from(`${parsed.username}:${parsed.password}`, 'utf8').toString('base64');
      headers.push(`Proxy-Authorization: Basic ${token}`);
    }
    headers.push('', '');
    socket.write(headers.join('\r\n'));

    let responseText = '';
    while (!responseText.includes('\r\n\r\n') && responseText.length < 4096) {
      const chunk = await readSocketChunk(socket, deadlineMs);
      responseText += chunk.toString('latin1');
    }

    const statusLine = responseText.split('\r\n')[0] || '';
    const match = /^HTTP\/\d\.\d\s+(\d{3})\b(.*)$/i.exec(statusLine.trim());
    const statusCode = match ? Number(match[1]) : 0;
    const latencyMs = Math.max(1, Date.now() - startedAt);

    if (statusCode === 200) {
      return {
        ok: true,
        reachable: true,
        tunnelOk: true,
        statusCode,
        latencyMs,
        url: parsed.displayUrl,
        target: authority,
      };
    }
    if (statusCode === 407) {
      return {
        ok: false,
        reachable: true,
        tunnelOk: false,
        statusCode,
        latencyMs,
        url: parsed.displayUrl,
        error: '代理需要认证或用户名密码错误 (HTTP 407)',
      };
    }
    return {
      ok: false,
      reachable: true,
      tunnelOk: false,
      statusCode,
      latencyMs,
      url: parsed.displayUrl,
      error: statusCode ? `代理拒绝 CONNECT 隧道 (HTTP ${statusCode})` : '代理返回了非 HTTP 响应',
    };
  } catch (err) {
    return {
      ok: false,
      reachable,
      tunnelOk: false,
      latencyMs: Math.max(1, Date.now() - startedAt),
      url: parsed.displayUrl,
      error: err?.code === 'ECONNREFUSED'
        ? `代理端口未监听 (${parsed.host})`
        : err?.message || '连接代理失败',
    };
  } finally {
    try {
      socket?.destroy();
    } catch {
      // ignore
    }
  }
}

async function probeSocks5Connect(parsed, { targetHost, targetPort, timeoutMs }) {
  const startedAt = Date.now();
  const deadlineMs = startedAt + timeoutMs;
  let socket = null;
  let reachable = false;

  try {
    socket = await new Promise((resolve, reject) => {
      const s = net.connect({ host: parsed.hostname, port: parsed.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`连接 SOCKS5 代理超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      const onConnect = () => {
        clearTimeout(timer);
        s.removeListener('error', onError);
        resolve(s);
      };
      const onError = (err) => {
        clearTimeout(timer);
        s.destroy();
        reject(err);
      };
      s.once('connect', onConnect);
      s.once('error', onError);
    });
    reachable = true;

    const methods = parsed.hasAuth ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));

    let { data: greetResp, rest } = await readExactBytes(socket, 2, deadlineMs);
    if (greetResp[0] !== 0x05) {
      throw new Error('目标端口不是有效的 SOCKS5 代理');
    }
    const selectedMethod = greetResp[1];
    if (selectedMethod === 0xff) {
      throw new Error('SOCKS5 代理拒绝当前认证方式');
    }
    if (selectedMethod === 0x02) {
      if (!parsed.hasAuth) {
        throw new Error('SOCKS5 代理需要用户名和密码认证');
      }
      const userBuf = Buffer.from(parsed.username, 'utf8');
      const passBuf = Buffer.from(parsed.password, 'utf8');
      if (userBuf.length > 255 || passBuf.length > 255) {
        throw new Error('SOCKS5 认证凭据超出长度限制');
      }
      const authReq = Buffer.concat([
        Buffer.from([0x01, userBuf.length]),
        userBuf,
        Buffer.from([passBuf.length]),
        passBuf,
      ]);
      socket.write(authReq);
      const authResp = await readExactBytes(socket, 2, deadlineMs, rest);
      rest = authResp.rest;
      if (authResp.data[1] !== 0x00) {
        throw new Error('SOCKS5 用户名或密码认证失败');
      }
    }

    const hostBuf = Buffer.from(String(targetHost), 'utf8');
    if (hostBuf.length === 0 || hostBuf.length > 255) {
      throw new Error('探测目标域名无效');
    }
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    const ipKind = net.isIP(targetHost);
    let addrPart;
    if (ipKind === 4) {
      const octets = targetHost.split('.').map((n) => Number(n));
      addrPart = Buffer.from([0x01, ...octets]);
    } else {
      addrPart = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
    }
    const connectReq = Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]);
    socket.write(connectReq);

    const headResp = await readExactBytes(socket, 4, deadlineMs, rest);
    const rep = headResp.data[1];
    const latencyMs = Math.max(1, Date.now() - startedAt);

    if (headResp.data[0] !== 0x05) {
      return {
        ok: false,
        reachable: true,
        tunnelOk: false,
        latencyMs,
        url: parsed.displayUrl,
        error: 'SOCKS5 握手响应格式无效',
      };
    }
    if (rep !== 0x00) {
      return {
        ok: false,
        reachable: true,
        tunnelOk: false,
        latencyMs,
        url: parsed.displayUrl,
        error: SOCKS5_REPLY_ERRORS.get(rep) || `SOCKS5 连接失败 (0x${rep.toString(16)})`,
      };
    }
    return {
      ok: true,
      reachable: true,
      tunnelOk: true,
      latencyMs,
      url: parsed.displayUrl,
      target: `${targetHost}:${targetPort}`,
    };
  } catch (err) {
    return {
      ok: false,
      reachable,
      tunnelOk: false,
      latencyMs: Math.max(1, Date.now() - startedAt),
      url: parsed.displayUrl,
      error: err?.code === 'ECONNREFUSED'
        ? `SOCKS5 代理端口未监听 (${parsed.host})`
        : err?.message || 'SOCKS5 代理连通测试失败',
    };
  } finally {
    try {
      socket?.destroy();
    } catch {
      // ignore
    }
  }
}

/**
 * Perform a real end-to-end HTTP CONNECT or SOCKS5 tunnel connectivity test against targetHost:targetPort.
 */
export async function probeProxyConnectivity(
  rawUrl,
  {
    timeoutMs = 4500,
    targetHost = DEFAULT_PROBE_HOST,
    targetPort = DEFAULT_PROBE_PORT,
  } = {},
) {
  const parsed = normalizeProxyUrl(rawUrl);
  if (!parsed.ok) {
    return {
      ok: false,
      reachable: false,
      tunnelOk: false,
      latencyMs: 0,
      url: maskProxyUrl(rawUrl),
      error: parsed.error || '代理地址格式无效',
    };
  }
  if (!parsed.url) {
    return {
      ok: false,
      reachable: false,
      tunnelOk: false,
      latencyMs: 0,
      url: '',
      error: '未配置自定义代理且未检测到已开启的系统代理',
    };
  }
  const boundedTimeout = Math.max(400, Math.min(15000, Math.round(Number(timeoutMs) || 4500)));
  if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') {
    return probeSocks5Connect(parsed, { targetHost, targetPort, timeoutMs: boundedTimeout });
  }
  return probeHttpConnect(parsed, { targetHost, targetPort, timeoutMs: boundedTimeout });
}
