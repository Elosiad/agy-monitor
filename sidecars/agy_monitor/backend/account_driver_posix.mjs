/**
 * Cross-platform native credential driver for macOS Keychain & Linux Secret Service,
 * plus shared `app_storage.json` onboarding state sync & `go-keyring-base64:` unwrapping.
 *
 * Security guarantees (zero external dependencies):
 * - Zero CLI argument secret exposure:
 *   - macOS writes via `/usr/bin/security -i` (stdin) for compact blobs and JXA
 *     `Security.framework` (stdin, preserving Apple `teamid:EQHXZ8M8AV` partition ACL)
 *     for larger blobs exceeding interactive line limits.
 *   - Linux reads/writes via `secret-tool lookup` / `secret-tool store` (stdin).
 * - Vault secrets & one-time switch payloads are sealed with AES-256-GCM using a random
 *   32-byte master key stored exclusively inside the OS Keychain / Secret Service.
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteText } from './paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ACTIVE_KEYRING_SERVICE = 'gemini';
export const ACTIVE_KEYRING_ACCOUNT = 'antigravity';
export const VAULT_MASTER_SERVICE = 'agy-monitor-vault-key';
export const VAULT_MASTER_ACCOUNT = 'master';
export const GO_KEYRING_B64_PREFIX = 'go-keyring-base64:';
export const AES_GCM_ENVELOPE_PREFIX = 'v1:aes256gcm:';

const SAFE_EMAIL_RE = /^[^\s@"'`\\;|$<>]{1,120}@[^\s@"'`\\;|$<>]{1,120}\.[^\s@"'`\\;|$<>]{1,63}$/;
const BASE64_BODY_RE = /^[A-Za-z0-9+/=]+$/;

/**
 * Transparently unwrap Go `zalando/go-keyring` `go-keyring-base64:` wrapper if present.
 */
export function unwrapGoKeyringPayload(rawText, maxDepth = 2) {
  let cur = typeof rawText === 'string' ? rawText.trim() : '';
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!cur.startsWith(GO_KEYRING_B64_PREFIX)) break;
    const compact = cur.slice(GO_KEYRING_B64_PREFIX.length).replace(/\s+/g, '');
    if (!compact || !BASE64_BODY_RE.test(compact)) break;
    try {
      const decoded = Buffer.from(compact, 'base64');
      const next = decoded.toString('utf8').trim();
      decoded.fill(0);
      if (!next) break;
      cur = next;
    } catch {
      break;
    }
  }
  return cur;
}

/**
 * Resolve Antigravity's desktop user-data directory (`app_storage.json` parent) per OS.
 */
export function resolveAntigravityUserDataDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (platform === 'win32') {
    const appData = env?.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Antigravity');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Antigravity');
  }
  const xdgConfig = env?.XDG_CONFIG_HOME || path.join(home, '.config');
  const candidates = [path.join(xdgConfig, 'Antigravity'), path.join(xdgConfig, 'antigravity')];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'app_storage.json')) || fs.existsSync(dir)) {
        return dir;
      }
    } catch {
      // ignore
    }
  }
  return candidates[0];
}

/**
 * Resolve Antigravity executable / .app bundle on macOS & Linux.
 */
export function resolvePosixAntigravityApp({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  execPath = process.execPath,
} = {}) {
  const agentExe = String(env?.ANTIGRAVITY_AGENTAPI_EXE || '').trim();
  if (platform === 'darwin') {
    for (const seed of [agentExe, execPath].filter(Boolean)) {
      let cur = path.dirname(seed);
      while (cur && cur !== path.dirname(cur)) {
        if (/^Antigravity.*\.app$/i.test(path.basename(cur)) && fs.existsSync(cur)) {
          return cur;
        }
        cur = path.dirname(cur);
      }
    }
    for (const candidate of ['/Applications/Antigravity.app', path.join(home, 'Applications', 'Antigravity.app')]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return '';
  }

  if (env?.APPIMAGE && fs.existsSync(env.APPIMAGE)) return env.APPIMAGE;
  if (agentExe) {
    const candidate = path.join(path.dirname(path.dirname(path.dirname(agentExe))), 'antigravity');
    if (fs.existsSync(candidate)) return candidate;
  }
  if (execPath && /^antigravity$/i.test(path.basename(execPath)) && fs.existsSync(execPath)) {
    return execPath;
  }
  for (const candidate of ['/usr/share/antigravity/antigravity', '/opt/Antigravity/antigravity', '/usr/bin/antigravity']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * Read Antigravity's `app_storage.json` onboarding identity (`lastLoginUsername` / `lastLoginIsGcpTos`).
 */
export function readAppStorageOnboarding(roamingDir) {
  if (!roamingDir) return null;
  const storagePath = path.join(roamingDir, 'app_storage.json');
  try {
    if (!fs.existsSync(storagePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rawEmail =
      parsed['agy.onboarding.lastLoginUsername'] ??
      parsed['jetski.onboarding.lastLoginUsername'] ??
      '';
    const rawTos =
      parsed['agy.onboarding.lastLoginIsGcpTos'] ??
      parsed['jetski.onboarding.lastLoginIsGcpTos'];
    const email = String(rawEmail || '').trim().toLowerCase();
    const isGcpTos =
      rawTos === true || rawTos === 'true'
        ? true
        : rawTos === false || rawTos === 'false'
          ? false
          : null;
    return {
      storagePath,
      email: SAFE_EMAIL_RE.test(email) ? email : '',
      isGcpTos,
      rawEmail: typeof rawEmail === 'string' ? rawEmail : '',
      rawTos: rawTos === undefined ? null : rawTos,
    };
  } catch {
    return null;
  }
}

/**
 * Atomically sync `agy.onboarding.lastLoginUsername` (and optional `agy.onboarding.lastLoginIsGcpTos`)
 * into `app_storage.json` so switching back to an already-onboarded account never re-prompts the ToS modal.
 * Preserves every other field in `app_storage.json` untouched.
 */
export function applyAppStorageOnboarding(roamingDir, { email = '', isGcpTos = null } = {}) {
  if (!roamingDir) return { ok: false, skipped: true, reason: 'no_roaming_dir' };
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!SAFE_EMAIL_RE.test(cleanEmail)) {
    return { ok: false, skipped: true, reason: 'invalid_email' };
  }
  const storagePath = path.join(roamingDir, 'app_storage.json');
  if (!fs.existsSync(storagePath)) {
    return { ok: false, skipped: true, reason: 'missing_app_storage' };
  }
  try {
    const raw = fs.readFileSync(storagePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, skipped: true, reason: 'invalid_json_root' };
    }
    parsed['agy.onboarding.lastLoginUsername'] = cleanEmail;
    if (typeof isGcpTos === 'boolean') {
      parsed['agy.onboarding.lastLoginIsGcpTos'] = String(isGcpTos);
    }
    const tmpPath = `${storagePath}.agy.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpPath, storagePath);
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
    return { ok: true, storagePath, email: cleanEmail, isGcpTos };
  } catch (err) {
    return { ok: false, skipped: false, reason: err?.message || 'write_failed' };
  }
}

/**
 * Build JXA (`osascript -l JavaScript`) script for silent macOS Keychain read via stdin.
 */
export function buildMacKeychainReadScript({ service, account }) {
  return [
    "ObjC.import('Foundation');",
    "ObjC.import('Security');",
    "ObjC.import('stdlib');",
    "let step = 'init';",
    'try {',
    "  if (typeof ObjC.bindFunction === 'function') {",
    "    ObjC.bindFunction('SecKeychainSetUserInteractionAllowed', ['int', ['bool']]);",
    "    ObjC.bindFunction('SecItemCopyMatching', ['int', ['id', 'id*']]);",
    '  }',
    "  if (typeof $.SecKeychainSetUserInteractionAllowed === 'function') $.SecKeychainSetUserInteractionAllowed(false);",
    "  const isRef = v => Boolean(v) && (Object.prototype.toString.call(v) === '[object Ref]' || String(v) === '[object Ref]');",
    "  const toObj = v => (isRef(v) && typeof ObjC.castRefToObject === 'function' ? ObjC.castRefToObject(v) : v);",
    `  const service = $(${JSON.stringify(String(service || ''))});`,
    `  const account = $(${JSON.stringify(String(account || ''))});`,
    "  const kClass = toObj($.kSecClass) || $('class');",
    "  const kGenp = toObj($.kSecClassGenericPassword) || $('genp');",
    "  const kSvc = toObj($.kSecAttrService) || $('svce');",
    "  const kAcct = toObj($.kSecAttrAccount) || $('acct');",
    "  const kRetData = toObj($.kSecReturnData) || $('r_Data');",
    "  const kMatchLimit = toObj($.kSecMatchLimit) || $('m_Limit');",
    "  const kMatchOne = toObj($.kSecMatchLimitOne) || $('m_LimitOne');",
    '  const query = $.NSMutableDictionary.alloc.init;',
    '  query.setObjectForKey(kGenp, kClass);',
    '  query.setObjectForKey(service, kSvc);',
    '  query.setObjectForKey(account, kAcct);',
    '  query.setObjectForKey($.NSNumber.numberWithBool(true), kRetData);',
    '  query.setObjectForKey(kMatchOne, kMatchLimit);',
    "  step = 'copy-matching';",
    '  const outRef = Ref();',
    '  const status = $.SecItemCopyMatching(query, outRef);',
    '  if (status !== 0) { console.log(step + " OSStatus " + status); $.exit(1); }',
    '  const dataObj = toObj(outRef[0]);',
    '  if (!dataObj || (typeof dataObj.isNil === \'function\' && dataObj.isNil())) { console.log("empty data"); $.exit(1); }',
    '  const b64 = ObjC.unwrap(dataObj.base64EncodedStringWithOptions(0));',
    '  const outData = $(b64 + "\\n").dataUsingEncoding($.NSUTF8StringEncoding);',
    '  $.NSFileHandle.fileHandleWithStandardOutput.writeData(outData);',
    '} catch (e) {',
    '  console.log(step + " exception: " + e);',
    '  $.exit(1);',
    '}',
  ].join('\n') + '\n';
}

/**
 * Build JXA (`osascript -l JavaScript`) script for macOS Keychain write via stdin
 * (handles >4KB payloads cleanly and configures `teamid:EQHXZ8M8AV` partition ACL for Antigravity).
 */
export function buildMacKeychainWriteScript({ service, account, dataBase64 }) {
  return [
    "ObjC.import('Foundation');",
    "ObjC.import('Security');",
    "ObjC.import('stdlib');",
    "let step = 'init';",
    'try {',
    "  if (typeof ObjC.bindFunction === 'function') {",
    "    ObjC.bindFunction('SecItemUpdate', ['int', ['id', 'id']]);",
    "    ObjC.bindFunction('SecItemAdd', ['int', ['id', 'void*']]);",
    "    ObjC.bindFunction('SecTrustedApplicationCreateFromPath', ['int', ['string', 'id*']]);",
    "    ObjC.bindFunction('SecAccessCreate', ['int', ['id', 'id', 'id*']]);",
    "    ObjC.bindFunction('SecAccessCopyMatchingACLList', ['id', ['id', 'id']]);",
    "    ObjC.bindFunction('SecACLSetContents', ['int', ['id', 'void*', 'id', 'int']]);",
    "    ObjC.bindFunction('SecACLCreateWithSimpleContents', ['int', ['id', 'void*', 'id', 'int', 'id*']]);",
    "    ObjC.bindFunction('SecACLUpdateAuthorizations', ['int', ['id', 'id']]);",
    '  }',
    "  const isRef = v => Boolean(v) && (Object.prototype.toString.call(v) === '[object Ref]' || String(v) === '[object Ref]');",
    "  const toObj = v => (isRef(v) && typeof ObjC.castRefToObject === 'function' ? ObjC.castRefToObject(v) : v);",
    `  const service = $(${JSON.stringify(String(service || ''))});`,
    `  const account = $(${JSON.stringify(String(account || ''))});`,
    `  const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(${JSON.stringify(String(dataBase64 || ''))}), 0);`,
    '  if (!data || data.isNil()) { console.log("invalid base64 payload"); $.exit(1); }',
    "  const kClass = toObj($.kSecClass) || $('class');",
    "  const kGenp = toObj($.kSecClassGenericPassword) || $('genp');",
    "  const kSvc = toObj($.kSecAttrService) || $('svce');",
    "  const kAcct = toObj($.kSecAttrAccount) || $('acct');",
    "  const kVal = toObj($.kSecValueData) || $('v_Data');",
    '  const kAccess = toObj($.kSecAttrAccess);',
    '  const query = $.NSMutableDictionary.alloc.init;',
    '  query.setObjectForKey(kGenp, kClass);',
    '  query.setObjectForKey(service, kSvc);',
    '  query.setObjectForKey(account, kAcct);',
    '  const attrs = $.NSMutableDictionary.alloc.init;',
    '  attrs.setObjectForKey(data, kVal);',
    "  step = 'update';",
    '  let status = $.SecItemUpdate(query, attrs);',
    '  if (status === -25300) {',
    '    const addQuery = query.mutableCopy;',
    '    addQuery.setObjectForKey(data, kVal);',
    '    const list = $.NSMutableArray.alloc.init;',
    "    for (const p of ['/usr/bin/osascript', '/usr/bin/security']) {",
    '      const app = Ref();',
    '      status = $.SecTrustedApplicationCreateFromPath(p, app);',
    '      if (status !== 0) break;',
    '      list.addObject(toObj(app[0]));',
    '    }',
    '    if (status === 0) {',
    '      const access = Ref();',
    '      status = $.SecAccessCreate(service, list, access);',
    '      if (status === 0) {',
    '        const accessObj = toObj(access[0]);',
    "        const kPart = toObj($.kSecACLAuthorizationPartitionID) || $('ACLAuthorizationPartitionID');",
    '        const partitionXml = $(\'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Partitions</key><array><string>apple-tool:</string><string>apple:</string><string>teamid:EQHXZ8M8AV</string></array></dict></plist>\');',
    '        const existingAcls = $.SecAccessCopyMatchingACLList(accessObj, kPart);',
    '        if (existingAcls && (!existingAcls.isNil || !existingAcls.isNil()) && existingAcls.count > 0) {',
    '          status = $.SecACLSetContents(existingAcls.objectAtIndex(0), null, partitionXml, 0);',
    '        } else {',
    '          const aclRef = Ref();',
    '          status = $.SecACLCreateWithSimpleContents(accessObj, null, partitionXml, 0, aclRef);',
    '          if (status === 0) {',
    '            const auths = $.NSMutableArray.alloc.init;',
    '            auths.addObject(kPart);',
    '            status = $.SecACLUpdateAuthorizations(toObj(aclRef[0]), auths);',
    '          }',
    '        }',
    '        if (status === 0 && kAccess) {',
    '          addQuery.setObjectForKey(accessObj, kAccess);',
    '          status = $.SecItemAdd(addQuery, null);',
    '          if (status === -25299) status = $.SecItemUpdate(query, attrs);',
    '        }',
    '      }',
    '    }',
    '  }',
    '  if (status !== 0) { console.log(step + " OSStatus " + status); $.exit(1); }',
    '} catch (e) {',
    '  console.log(step + " exception: " + e);',
    '  $.exit(1);',
    '}',
  ].join('\n') + '\n';
}

export function sealAes256Gcm(plainText, keyBuf) {
  if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== 32) {
    throw new Error('AES-256-GCM 密钥无效');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText || ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${AES_GCM_ENVELOPE_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function openAes256Gcm(sealed, keyBuf) {
  if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== 32) {
    throw new Error('AES-256-GCM 密钥无效');
  }
  const raw = String(sealed || '').trim();
  if (!raw.startsWith(AES_GCM_ENVELOPE_PREFIX)) {
    throw new Error('加密凭据格式不匹配');
  }
  const parts = raw.slice(AES_GCM_ENVELOPE_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('加密凭据结构损坏');
  }
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const ct = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Create a native macOS Keychain / Linux Secret Service client (zero CLI argv secret exposure).
 */
export function createPosixKeychainClient({
  platform = process.platform,
  env = process.env,
  runSpawn = spawnSync,
} = {}) {
  const backend =
    platform === 'darwin'
      ? 'darwin-keychain'
      : platform === 'linux'
        ? 'linux-secret-service'
        : 'unsupported';

  let cachedProbe = null;
  let cachedMasterKey = null;

  function probe({ force = false } = {}) {
    if (cachedProbe && !force) return cachedProbe;
    if (platform === 'darwin') {
      const res = runSpawn('/usr/bin/security', ['help'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 3000,
      });
      if (res?.error?.code === 'ENOENT') {
        cachedProbe = { supported: false, backend, reason: '未检测到 macOS /usr/bin/security 工具' };
      } else {
        cachedProbe = { supported: true, backend, reason: '' };
      }
      return cachedProbe;
    }
    if (platform === 'linux') {
      const res = runSpawn('secret-tool', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
      });
      if (res?.error?.code === 'ENOENT') {
        cachedProbe = {
          supported: false,
          backend,
          reason: '未安装 secret-tool（libsecret-tools），请先安装以启用 Linux 系统密钥环',
        };
        return cachedProbe;
      }
      if (!env?.DBUS_SESSION_BUS_ADDRESS && !env?.DISPLAY && !env?.WAYLAND_DISPLAY) {
        cachedProbe = {
          supported: false,
          backend,
          reason: '未检测到桌面密钥环服务（Linux Secret Service 不可用）',
        };
        return cachedProbe;
      }
      cachedProbe = { supported: true, backend, reason: '' };
      return cachedProbe;
    }
    cachedProbe = { supported: false, backend, reason: '当前系统不支持 POSIX 原生凭据库' };
    return cachedProbe;
  }

  function readSecret(service, account, { preferJxa = false } = {}) {
    const cap = probe();
    if (!cap.supported) return null;

    if (platform === 'darwin') {
      const readViaJxa = () => {
        const script = buildMacKeychainReadScript({ service, account });
        const res = runSpawn('/usr/bin/osascript', ['-l', 'JavaScript'], {
          input: script,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 8000,
        });
        if (res.status !== 0 || !res.stdout) return null;
        const b64 = Buffer.from(res.stdout).toString('utf8').trim();
        if (!b64) return null;
        try {
          return Buffer.from(b64, 'base64').toString('utf8');
        } catch {
          return null;
        }
      };
      const readViaSecurity = () => {
        const res = runSpawn('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 8000,
        });
        if (res.status !== 0 || !res.stdout) return null;
        return Buffer.from(res.stdout).toString('utf8').replace(/[\r\n]+$/, '');
      };
      if (preferJxa) {
        const j = readViaJxa();
        return j !== null ? j : readViaSecurity();
      }
      const s = readViaSecurity();
      return s !== null ? s : readViaJxa();
    }

    const res = runSpawn('secret-tool', ['lookup', 'service', service, 'username', account], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    return Buffer.from(res.stdout).toString('utf8');
  }

  function writeSecret(service, account, plainText, { label = 'AGY Monitor' } = {}) {
    const cap = probe();
    if (!cap.supported) {
      return { ok: false, error: cap.reason || '当前系统不支持原生凭据库' };
    }
    const text = String(plainText ?? '');
    const buf = Buffer.from(text, 'utf8');

    try {
      if (platform === 'darwin') {
        const cmdPrefix = `add-generic-password -U -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -X `;
        const hexCmdBytes = Buffer.byteLength(cmdPrefix, 'utf8') + buf.length * 2 + 1;
        const singleQuoteSafe = /^[\x20-\x7e]+$/.test(text) && !text.includes("'");
        const rawCmd = singleQuoteSafe
          ? `add-generic-password -U -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -w '${text}'\n`
          : '';
        let writeRes;
        if (hexCmdBytes < 3800) {
          const cmd = `${cmdPrefix}${buf.toString('hex')}\n`;
          writeRes = runSpawn('/usr/bin/security', ['-i'], {
            input: cmd,
            stdio: ['pipe', 'ignore', 'pipe'],
            timeout: 8000,
          });
        } else if (rawCmd && Buffer.byteLength(rawCmd, 'utf8') < 3800) {
          writeRes = runSpawn('/usr/bin/security', ['-i'], {
            input: rawCmd,
            stdio: ['pipe', 'ignore', 'pipe'],
            timeout: 8000,
          });
        } else {
          const script = buildMacKeychainWriteScript({
            service,
            account,
            dataBase64: buf.toString('base64'),
          });
          writeRes = runSpawn('/usr/bin/osascript', ['-l', 'JavaScript'], {
            input: script,
            stdio: ['pipe', 'ignore', 'pipe'],
            timeout: 8000,
          });
        }
        if (writeRes.status !== 0) {
          return { ok: false, error: String(writeRes.stderr || '').trim() || '写入 macOS 钥匙串失败' };
        }
        return { ok: true };
      }

      const writeRes = runSpawn(
        'secret-tool',
        ['store', `--label=${label}`, 'service', service, 'username', account],
        {
          input: buf,
          stdio: ['pipe', 'ignore', 'pipe'],
          timeout: 8000,
        },
      );
      if (writeRes.status !== 0) {
        return { ok: false, error: String(writeRes.stderr || '').trim() || '写入 Linux 密钥环失败' };
      }
      return { ok: true };
    } finally {
      buf.fill(0);
    }
  }

  function deleteSecret(service, account) {
    const cap = probe();
    if (!cap.supported) return { ok: false, error: cap.reason };
    if (platform === 'darwin') {
      const res = runSpawn('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], {
        stdio: 'ignore',
        timeout: 8000,
      });
      return { ok: res.status === 0 || res.status === 44 };
    }
    const res = runSpawn('secret-tool', ['clear', 'service', service, 'username', account], {
      stdio: 'ignore',
      timeout: 8000,
    });
    return { ok: res.status === 0 };
  }

  function getOrCreateVaultMasterKey() {
    if (cachedMasterKey && cachedMasterKey.length === 32) {
      return cachedMasterKey;
    }
    const existing = readSecret(VAULT_MASTER_SERVICE, VAULT_MASTER_ACCOUNT, { preferJxa: true });
    if (existing) {
      const decoded = Buffer.from(existing.trim(), 'base64');
      if (decoded.length === 32) {
        cachedMasterKey = decoded;
        return cachedMasterKey;
      }
    }
    const freshKey = crypto.randomBytes(32);
    const saved = writeSecret(VAULT_MASTER_SERVICE, VAULT_MASTER_ACCOUNT, freshKey.toString('base64'), {
      label: 'AGY Monitor Vault Master Key',
    });
    if (!saved.ok) {
      throw new Error(saved.error || '无法在系统密钥库中初始化保险库主密钥');
    }
    cachedMasterKey = freshKey;
    return cachedMasterKey;
  }

  return {
    backend,
    probe,
    readSecret,
    writeSecret,
    deleteSecret,
    getOrCreateVaultMasterKey,
  };
}

/**
 * Create a POSIX (macOS Keychain / Linux Secret Service) account driver matching
 * `createWindowsAccountDriver`'s interface.
 */
export function createPosixAccountDriver(
  paths,
  storage,
  {
    platform = process.platform,
    env = process.env,
    home = os.homedir(),
    execPath = process.execPath,
    runSpawn = spawnSync,
    spawnProcess = spawn,
    cleanLaunchEnvFn = null,
  } = {},
) {
  const keychain = createPosixKeychainClient({ platform, env, runSpawn });
  const roamingDir = resolveAntigravityUserDataDir({ platform, env, home });
  const geminiDir = path.join(home, '.gemini');
  const fallbackTokenPath = path.join(geminiDir, 'jetski-standalone-oauth-token');
  const workerPath = path.resolve(__dirname, '..', 'accounts', 'switch_worker.mjs');

  return {
    backend: keychain.backend,
    isSupported() {
      return keychain.probe().supported;
    },
    getUnsupportedReason() {
      return keychain.probe().reason || '当前系统不支持原生凭据库';
    },
    getRoamingDir() {
      return roamingDir;
    },
    async ensureReady() {
      const cap = keychain.probe();
      return {
        supported: cap.supported,
        compiled: cap.supported,
        backend: cap.backend,
        exePath: '',
        reason: cap.reason || '',
      };
    },
    async readLiveCredential() {
      const fromKeyring = keychain.readSecret(ACTIVE_KEYRING_SERVICE, ACTIVE_KEYRING_ACCOUNT);
      if (fromKeyring && fromKeyring.trim()) {
        const unwrapped = unwrapGoKeyringPayload(fromKeyring);
        return {
          found: true,
          source: keychain.backend,
          credTarget: `${ACTIVE_KEYRING_SERVICE}:${ACTIVE_KEYRING_ACCOUNT}`,
          credUserName: ACTIVE_KEYRING_ACCOUNT,
          credPersist: 2,
          credJson: unwrapped,
          roamingDir,
        };
      }
      // Fallback to ~/.gemini/jetski-standalone-oauth-token
      try {
        if (fs.existsSync(fallbackTokenPath)) {
          const raw = (await fsp.readFile(fallbackTokenPath, 'utf8')).trim();
          if (raw) {
            return {
              found: true,
              source: 'desktop_fallback',
              credTarget: `${ACTIVE_KEYRING_SERVICE}:${ACTIVE_KEYRING_ACCOUNT}`,
              credUserName: ACTIVE_KEYRING_ACCOUNT,
              credPersist: 2,
              credJson: unwrapGoKeyringPayload(raw),
              roamingDir,
            };
          }
        }
      } catch {
        // ignore
      }
      return { found: false, roamingDir };
    },
    async writeLiveCredential(credJson) {
      const clean = String(credJson || '').trim();
      if (!clean) throw new Error('目标凭据 JSON 不能为空');
      const written = keychain.writeSecret(ACTIVE_KEYRING_SERVICE, ACTIVE_KEYRING_ACCOUNT, clean, {
        label: 'Antigravity OAuth Credential',
      });
      if (!written.ok) {
        throw new Error(written.error || '写入系统密钥库失败');
      }
      await atomicWriteText(fallbackTokenPath, clean);
      const cliDir = path.join(geminiDir, 'antigravity-cli');
      if (fs.existsSync(cliDir)) {
        await atomicWriteText(path.join(cliDir, 'antigravity-oauth-token'), clean);
      }
      return { ok: true };
    },
    async protectSecret(plainText) {
      const key = keychain.getOrCreateVaultMasterKey();
      return sealAes256Gcm(plainText, key);
    },
    async unprotectSecret(cipherText) {
      const key = keychain.getOrCreateVaultMasterKey();
      return openAes256Gcm(cipherText, key);
    },
    async detectAntigravityLaunchConfig() {
      const appPath = resolvePosixAntigravityApp({ platform, env, home, execPath });
      let launchArgs = '';
      if (storage?.getThemes) {
        try {
          const themes = await storage.getThemes();
          const cdpPort = Number(themes?.cdpPort || 9229);
          const wantCdp = Boolean(themes?.backdropEnabled && themes?.activeWallpaperId);
          if (wantCdp && Number.isInteger(cdpPort) && cdpPort >= 1024 && cdpPort <= 65535) {
            launchArgs = `--remote-debugging-port=${cdpPort}`;
          }
        } catch {
          // ignore
        }
      }
      return {
        exePath: appPath,
        launchArgs,
        workDir: appPath ? path.dirname(appPath) : home,
      };
    },
    async launchSwitchDaemon(txPath) {
      const baseClean = typeof cleanLaunchEnvFn === 'function' ? cleanLaunchEnvFn(env) : { ...env };
      const workerEnv = {
        ...baseClean,
        ELECTRON_RUN_AS_NODE: '1',
      };
      const child = spawnProcess(execPath, [workerPath, txPath], {
        detached: true,
        stdio: 'ignore',
        env: workerEnv,
      });
      child?.unref?.();
      return { ok: true, launched: true, method: 'static-node-worker', backend: keychain.backend };
    },
  };
}
