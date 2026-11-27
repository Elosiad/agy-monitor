/**
 * Zero-dependency Boost tools engine for AGY Console ("增强" Tab):
 * 1. batchOps       - Batched multi-query search, atomic multi-file edits (+ verify), concurrent checks
 * 2. compactOutput  - Strict <= 8.8 KB UTF-8 Head-Tail output compression & ANSI/noise stripping
 * 3. outlineFirst   - Multi-language symbol outlines & targeted line-range slice reading
 *
 * All three features default to OFF (zero overhead until explicitly enabled by the user).
 */

import { execFile, spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BOOST_CONFIG = Object.freeze({
  batchOps: false,
  compactOutput: false,
  outlineFirst: false,
});

export const COMPACT_MAX_BYTES = 8800;
export const GENEROUS_MAX_BYTES = 40000;

export const BOOST_RULES_START = '<!-- AGY-MONITOR-BOOST:START -->';
export const BOOST_RULES_END = '<!-- AGY-MONITOR-BOOST:END -->';

const MAX_SEARCH_QUERIES = 20;
const MAX_EDIT_FILES = 50;
const MAX_CHECK_COMMANDS = 12;
const MAX_OUTLINE_FILES = 40;
const MAX_WALK_FILES = 3000;
const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
]);

const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'rev-parse',
  'ls-files',
  'blame',
  'shortlog',
  'describe',
  'tag',
  'remote',
]);

const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function normalizeBoostConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_BOOST_CONFIG };
  }
  return {
    batchOps: raw.batchOps === true,
    compactOutput: raw.compactOutput === true,
    outlineFirst: raw.outlineFirst === true,
  };
}

export function hasAnyBoostEnabled(boost) {
  const b = normalizeBoostConfig(boost);
  return b.batchOps || b.compactOutput || b.outlineFirst;
}

/**
 * Strip ANSI escape codes, normalize spinner CR frames, collapse blank lines,
 * and strictly enforce a UTF-8 byte budget using Head-Tail folding.
 */
export function stripAnsiAndNoise(rawText) {
  const text = String(rawText ?? '')
    .replace(ANSI_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/[^\n]*\r(?!\n)/g, '')
    .replace(/\n{3,}/g, '\n\n');
  return text.trimEnd();
}

function sliceUtf8Head(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

function sliceUtf8Tail(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
}

export function compactTextOutput(rawText, { maxBytes = COMPACT_MAX_BYTES } = {}) {
  const limit = Math.max(256, Math.floor(Number(maxBytes) || COMPACT_MAX_BYTES));
  const cleaned = stripAnsiAndNoise(rawText);
  const totalBytes = Buffer.byteLength(cleaned, 'utf8');
  if (totalBytes <= limit) {
    return { text: cleaned, truncated: false, originalBytes: totalBytes, outputBytes: totalBytes };
  }

  const markerEstimate = 96;
  const budget = Math.max(128, limit - markerEstimate);
  const headBudget = Math.floor(budget * 0.48);
  const tailBudget = Math.max(64, budget - headBudget);

  let head = sliceUtf8Head(cleaned, headBudget);
  const lastNl = head.lastIndexOf('\n');
  if (lastNl > Math.floor(head.length * 0.5)) {
    head = head.slice(0, lastNl);
  }

  let tail = sliceUtf8Tail(cleaned, tailBudget);
  const firstNl = tail.indexOf('\n');
  if (firstNl >= 0 && firstNl < Math.floor(tail.length * 0.4)) {
    tail = tail.slice(firstNl + 1);
  }

  const keptBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  const omittedBytes = Math.max(1, totalBytes - keptBytes);
  const marker = `\n... [已折叠 ${omittedBytes} 字节，仅保留首尾关键信息] ...\n`;
  let combined = `${head}${marker}${tail}`;
  if (Buffer.byteLength(combined, 'utf8') > limit) {
    const tightHead = sliceUtf8Head(head, Math.max(48, Math.floor((limit - Buffer.byteLength(marker, 'utf8')) * 0.48)));
    const tightTail = sliceUtf8Tail(tail, Math.max(48, limit - Buffer.byteLength(marker, 'utf8') - Buffer.byteLength(tightHead, 'utf8')));
    combined = `${tightHead}${marker}${tightTail}`;
  }

  return {
    text: combined,
    truncated: true,
    originalBytes: totalBytes,
    outputBytes: Buffer.byteLength(combined, 'utf8'),
  };
}

function resolveSafePath(cwd, targetPath) {
  const baseDir = path.resolve(cwd || process.cwd());
  if (!targetPath || typeof targetPath !== 'string') return baseDir;
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(baseDir, targetPath);
  return resolved;
}

function globToRegex(pattern) {
  let pat = String(pattern || '').trim().replace(/\\/g, '/');
  if (!pat) return /.*/i;
  if (!/[*?[\]{}]/.test(pat)) {
    const escaped = pat.replace(/[.+^$|()\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  }
  let out = '^';
  for (let i = 0; i < pat.length; i += 1) {
    const ch = pat[i];
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (pat[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('.+^$|()\\'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '$';
  try {
    return new RegExp(out, 'i');
  } catch {
    return /.*/i;
  }
}

async function walkFiles(rootDir, { maxFiles = MAX_WALK_FILES } = {}) {
  const files = [];
  const queue = [rootDir];
  while (queue.length > 0 && files.length < maxFiles) {
    const cur = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (files.length >= maxFiles) break;
      if (ent.name.startsWith('.') && ent.name !== '.github' && ent.name !== '.env.example') {
        if (ent.isDirectory()) continue;
      }
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(ent.name)) queue.push(full);
      } else if (ent.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

function execFileSimple(cmd, args, { cwd, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err ? err.message : '',
        });
      },
    );
  });
}

function runShellCommand(command, { cwd, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const isWin = process.platform === 'win32';
    const child = spawn(
      isWin ? 'powershell.exe' : '/bin/sh',
      isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command],
      { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const outChunks = [];
    const errChunks = [];
    let totalBytes = 0;
    const capBytes = 1024 * 1024;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, Math.max(1000, Math.min(120000, timeoutMs)));

    child.stdout?.on('data', (d) => {
      if (totalBytes < capBytes) {
        outChunks.push(d);
        totalBytes += d.length;
      }
    });
    child.stderr?.on('data', (d) => {
      if (totalBytes < capBytes) {
        errChunks.push(d);
        totalBytes += d.length;
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        timedOut,
        durationMs: Date.now() - start,
        output: err?.message || 'spawn failed',
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      const combined = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '');
      resolve({
        ok: !timedOut && code === 0,
        exitCode: timedOut ? 124 : Number(code ?? 1),
        timedOut,
        durationMs: Date.now() - start,
        output: combined,
      });
    });
  });
}

function tokenizeSimpleArgs(str) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || ''))) !== null) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
}

/**
 * 1A. Batched heterogeneous search (text / regex / glob / read-only git).
 */
export async function runBatchSearch({ queries = [], cwd = process.cwd(), compact = false } = {}) {
  const list = Array.isArray(queries) ? queries.slice(0, MAX_SEARCH_QUERIES) : [];
  if (list.length === 0) {
    return { ok: false, error: 'queries 数组不能为空' };
  }
  const baseCwd = path.resolve(cwd || process.cwd());
  const maxBytes = compact ? COMPACT_MAX_BYTES : GENEROUS_MAX_BYTES;
  const fileCache = new Map();

  const getFilesForDir = async (dir) => {
    if (!fileCache.has(dir)) {
      fileCache.set(dir, await walkFiles(dir));
    }
    return fileCache.get(dir);
  };

  const results = await Promise.all(
    list.map(async (q, idx) => {
      const type = String(q?.type || 'text').toLowerCase();
      const pattern = String(q?.pattern || '').trim();
      const targetDir = resolveSafePath(baseCwd, q?.path || '');
      const limit = Math.max(1, Math.min(50, Number(q?.maxResults) || 20));
      const globRe = q?.glob ? globToRegex(q.glob) : null;

      if (!pattern) {
        return { index: idx, type, ok: false, error: 'pattern 不能为空' };
      }

      if (type === 'git') {
        const tokens = tokenizeSimpleArgs(pattern);
        const sub = (tokens[0] || '').toLowerCase();
        if (!ALLOWED_GIT_SUBCOMMANDS.has(sub)) {
          return { index: idx, type, pattern, ok: false, error: `只允许只读 git 子命令，已拒绝: ${sub || '(empty)'}` };
        }
        const r = await execFileSimple('git', tokens, { cwd: targetDir, timeoutMs: 12000 });
        return {
          index: idx,
          type,
          pattern,
          ok: r.ok,
          output: stripAnsiAndNoise(r.stdout || r.stderr),
        };
      }

      const files = await getFilesForDir(targetDir);

      if (type === 'glob' || type === 'fuzzy') {
        const re =
          type === 'fuzzy'
            ? new RegExp(
                pattern
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                  .join('.*'),
                'i',
              )
            : globToRegex(pattern);
        const matched = [];
        for (const f of files) {
          const rel = path.relative(targetDir, f).replace(/\\/g, '/');
          if (re.test(rel) || re.test(path.basename(rel))) {
            matched.push(rel);
            if (matched.length >= limit) break;
          }
        }
        return { index: idx, type, pattern, ok: true, count: matched.length, matches: matched };
      }

      let matcher;
      if (type === 'regex') {
        try {
          matcher = new RegExp(pattern, q?.caseSensitive ? '' : 'i');
        } catch (err) {
          return { index: idx, type, pattern, ok: false, error: `无效正则: ${err?.message || err}` };
        }
      } else {
        const needle = q?.caseSensitive ? pattern : pattern.toLowerCase();
        matcher = {
          test: (line) => (q?.caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle)),
        };
      }

      const hits = [];
      const filesOnly = q?.outputMode === 'files_with_matches';
      for (const f of files) {
        if (hits.length >= limit) break;
        const rel = path.relative(targetDir, f).replace(/\\/g, '/');
        if (globRe && !globRe.test(rel) && !globRe.test(path.basename(rel))) continue;
        let stat;
        try {
          stat = await fs.stat(f);
        } catch {
          continue;
        }
        if (stat.size > MAX_FILE_READ_BYTES) continue;
        let content;
        try {
          content = await fs.readFile(f, 'utf8');
        } catch {
          continue;
        }
        if (content.includes('\x00')) continue;
        const lines = content.split(/\r?\n/);
        for (let ln = 0; ln < lines.length; ln += 1) {
          if (matcher.test(lines[ln])) {
            if (filesOnly) {
              hits.push(rel);
              break;
            }
            hits.push(`${rel}:${ln + 1}: ${lines[ln].trim().slice(0, 180)}`);
            if (hits.length >= limit) break;
          }
        }
      }
      return { index: idx, type, pattern, ok: true, count: hits.length, matches: hits };
    }),
  );

  const lines = [];
  for (const r of results) {
    lines.push(`[#${r.index + 1} ${r.type} "${r.pattern || ''}"] ${r.ok ? 'OK' : `ERR: ${r.error}`}`);
    if (Array.isArray(r.matches)) {
      if (r.matches.length === 0) lines.push('  (无匹配)');
      else r.matches.forEach((m) => lines.push(`  ${m}`));
    } else if (r.output) {
      lines.push(r.output);
    }
  }

  const folded = compactTextOutput(lines.join('\n'), { maxBytes });
  return {
    ok: true,
    queryCount: list.length,
    compact,
    truncated: folded.truncated,
    outputBytes: folded.outputBytes,
    text: folded.text,
  };
}

/**
 * 1B. Atomic multi-file multi-hunk edits with optional inline verification command.
 */
export async function runApplyEdits({
  edits = [],
  cwd = process.cwd(),
  dryRun = false,
  verify = '',
  compact = false,
} = {}) {
  const list = Array.isArray(edits) ? edits.slice(0, MAX_EDIT_FILES) : [];
  if (list.length === 0) {
    return { ok: false, error: 'edits 数组不能为空' };
  }

  const baseCwd = path.resolve(cwd || process.cwd());
  const maxBytes = compact ? COMPACT_MAX_BYTES : GENEROUS_MAX_BYTES;
  const staged = [];
  const errors = [];

  for (let idx = 0; idx < list.length; idx += 1) {
    const item = list[idx];
    const relOrAbs = String(item?.path || '').trim();
    if (!relOrAbs) {
      errors.push(`#${idx + 1}: path 不能为空`);
      continue;
    }
    const fullPath = resolveSafePath(baseCwd, relOrAbs);

    if (typeof item.content === 'string' && item.create) {
      staged.push({ fullPath, relPath: path.relative(baseCwd, fullPath) || relOrAbs, nextContent: item.content, created: true, hunksApplied: 1 });
      continue;
    }

    let raw;
    try {
      raw = await fs.readFile(fullPath, 'utf8');
    } catch (err) {
      errors.push(`${relOrAbs}: 读取失败 (${err?.code || err?.message})`);
      continue;
    }

    const usesCrlf = raw.includes('\r\n');
    let text = raw.replace(/\r\n/g, '\n');
    const hunks = Array.isArray(item.hunks) ? item.hunks : [];
    if (hunks.length === 0) {
      errors.push(`${relOrAbs}: hunks 不能为空`);
      continue;
    }

    let fileFailed = false;
    for (let hi = 0; hi < hunks.length; hi += 1) {
      const h = hunks[hi];
      const target = String(h?.target ?? '').replace(/\r\n/g, '\n');
      const replacement = String(h?.replacement ?? '').replace(/\r\n/g, '\n');
      if (!target) {
        errors.push(`${relOrAbs} hunk #${hi + 1}: target 不能为空`);
        fileFailed = true;
        break;
      }

      if (h?.replaceAll) {
        if (!text.includes(target)) {
          errors.push(`${relOrAbs} hunk #${hi + 1}: 未找到匹配文本`);
          fileFailed = true;
          break;
        }
        text = text.split(target).join(replacement);
        continue;
      }

      let searchStart = 0;
      let searchEnd = text.length;
      if (Number.isInteger(h?.startLine) && h.startLine > 1) {
        const lines = text.split('\n');
        searchStart = lines.slice(0, h.startLine - 1).join('\n').length + (h.startLine > 1 ? 1 : 0);
      }
      if (Number.isInteger(h?.endLine) && h.endLine > 0) {
        const lines = text.split('\n');
        searchEnd = lines.slice(0, h.endLine).join('\n').length;
      }

      const slice = text.slice(searchStart, searchEnd);
      const pos = slice.indexOf(target);
      if (pos === -1) {
        errors.push(`${relOrAbs} hunk #${hi + 1}: 未找到匹配文本`);
        fileFailed = true;
        break;
      }
      const absPos = searchStart + pos;
      text = text.slice(0, absPos) + replacement + text.slice(absPos + target.length);
    }

    if (!fileFailed) {
      staged.push({
        fullPath,
        relPath: path.relative(baseCwd, fullPath) || relOrAbs,
        nextContent: usesCrlf ? text.replace(/\n/g, '\r\n') : text,
        created: false,
        hunksApplied: hunks.length,
      });
    }
  }

  // Atomic guarantee: if any file failed validation, touch 0 files on disk
  if (errors.length > 0) {
    const foldedErr = compactTextOutput(`原子校验失败（0 个文件被修改）：\n${errors.join('\n')}`, { maxBytes });
    return { ok: false, filesModified: 0, errors, text: foldedErr.text };
  }

  if (!dryRun) {
    for (const s of staged) {
      await fs.mkdir(path.dirname(s.fullPath), { recursive: true });
      await fs.writeFile(s.fullPath, s.nextContent, 'utf8');
    }
  }

  const summaryLines = staged.map(
    (s) => `${dryRun ? '[dryRun] ' : ''}${s.created ? 'CREATE' : 'EDIT'} ${s.relPath} (${s.hunksApplied} hunk${s.hunksApplied > 1 ? 's' : ''})`,
  );

  let verifyResult = null;
  if (!dryRun && typeof verify === 'string' && verify.trim()) {
    verifyResult = await runShellCommand(verify.trim(), { cwd: baseCwd, timeoutMs: 60000 });
    summaryLines.push(
      `[verify] ${verifyResult.ok ? 'PASS' : `FAIL (exit ${verifyResult.exitCode})`} (${verifyResult.durationMs}ms)`,
    );
    if (!verifyResult.ok || !compact) {
      if (verifyResult.output) summaryLines.push(verifyResult.output);
    }
  }

  const folded = compactTextOutput(summaryLines.join('\n'), { maxBytes });
  return {
    ok: !verifyResult || verifyResult.ok,
    dryRun: Boolean(dryRun),
    filesModified: dryRun ? 0 : staged.length,
    truncated: folded.truncated,
    outputBytes: folded.outputBytes,
    text: folded.text,
  };
}

/**
 * 1C. Concurrent shell checks with bounded pool and Head-Tail error folding.
 */
export async function runChecks({
  commands = [],
  cwd = process.cwd(),
  concurrency = 4,
  timeoutSec = 45,
  compact = false,
} = {}) {
  const list = Array.isArray(commands)
    ? commands
        .slice(0, MAX_CHECK_COMMANDS)
        .map((c, idx) =>
          typeof c === 'string'
            ? { label: `cmd#${idx + 1}`, command: c.trim() }
            : { label: String(c?.label || `cmd#${idx + 1}`), command: String(c?.command || '').trim() },
        )
        .filter((c) => c.command)
    : [];

  if (list.length === 0) {
    return { ok: false, error: 'commands 数组不能为空' };
  }

  const baseCwd = path.resolve(cwd || process.cwd());
  const poolSize = Math.max(1, Math.min(6, Number(concurrency) || 4));
  const timeoutMs = Math.max(1000, Math.min(120000, (Number(timeoutSec) || 45) * 1000));
  const maxBytes = compact ? COMPACT_MAX_BYTES : GENEROUS_MAX_BYTES;

  const outcomes = new Array(list.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      const item = list[idx];
      const res = await runShellCommand(item.command, { cwd: baseCwd, timeoutMs });
      outcomes[idx] = { ...item, ...res };
    }
  };

  await Promise.all(Array.from({ length: Math.min(poolSize, list.length) }, () => worker()));

  const allOk = outcomes.every((o) => o.ok);
  const lines = [];
  for (const o of outcomes) {
    const status = o.ok ? 'PASS' : o.timedOut ? 'TIMEOUT' : `FAIL(exit ${o.exitCode})`;
    lines.push(`[${o.label}] ${status} (${o.durationMs}ms) — ${o.command}`);
    if (!o.ok || !compact) {
      if (o.output) lines.push(stripAnsiAndNoise(o.output));
    }
  }

  const folded = compactTextOutput(lines.join('\n'), { maxBytes });
  return {
    ok: allOk,
    passed: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    compact,
    truncated: folded.truncated,
    outputBytes: folded.outputBytes,
    text: folded.text,
  };
}

/**
 * 2. Standalone compact command runner (strictly <= 8.8 KB UTF-8 Head-Tail folding).
 */
export async function runCompactCommand({ command = '', cwd = process.cwd(), timeoutSec = 45 } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) {
    return { ok: false, error: 'command 不能为空' };
  }
  const baseCwd = path.resolve(cwd || process.cwd());
  const timeoutMs = Math.max(1000, Math.min(120000, (Number(timeoutSec) || 45) * 1000));
  const res = await runShellCommand(cmd, { cwd: baseCwd, timeoutMs });
  const header = `[${res.ok ? 'PASS' : `FAIL exit ${res.exitCode}`}] (${res.durationMs}ms) ${cmd}`;
  const raw = res.output ? `${header}\n${res.output}` : header;
  const folded = compactTextOutput(raw, { maxBytes: COMPACT_MAX_BYTES });
  return {
    ok: res.ok,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    truncated: folded.truncated,
    originalBytes: folded.originalBytes,
    outputBytes: folded.outputBytes,
    text: folded.text,
  };
}

/**
 * 3A. Multi-language symbol outline extractor (JS/TS/Python/Go/Rust/C#/Java/Swift/C++/CSS/HTML/MD/JSON/YAML).
 */
export function extractFileOutline(filePath, content) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const lines = String(content || '').split(/\r?\n/);
  const symbols = [];
  const push = (lineNo, kind, name) => {
    symbols.push({ line: lineNo, kind, name: String(name || '').trim().slice(0, 120) });
  };

  if (ext === '.json') {
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s{0,2}"([^"]{1,80})"\s*:/.exec(lines[i]);
      if (m) push(i + 1, 'key', m[1]);
    }
  } else if (ext === '.md' || ext === '.markdown') {
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(#{1,4})\s+(.+)$/.exec(lines[i]);
      if (m) push(i + 1, `h${m[1].length}`, m[2]);
    }
  } else if (ext === '.py') {
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(lines[i]);
      if (m && m[1].length <= 4) push(i + 1, m[2].includes('class') ? 'class' : 'def', m[3]);
    }
  } else if (ext === '.go') {
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(?:func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*)\s+(?:struct|interface))/.exec(lines[i]);
      if (m) push(i + 1, m[1] ? 'func' : 'type', m[1] || m[2]);
    }
  } else if (ext === '.rs') {
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/.exec(lines[i]);
      if (m) push(i + 1, m[1], m[2]);
    }
  } else if (ext === '.css' || ext === '.scss' || ext === '.less') {
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^([.#@][A-Za-z0-9_-][^{,;]{0,80})\s*\{/.exec(lines[i]);
      if (m) push(i + 1, 'rule', m[1].trim());
    }
  } else if (ext === '.cs' || ext === '.java' || ext === '.kt' || ext === '.swift') {
    for (let i = 0; i < lines.length; i += 1) {
      const m =
        /^\s*(?:public|private|protected|internal|final|static|override|async|open|sealed|\s)*(class|struct|interface|enum|func|void|[\w<>?\[\]]+)\s+([A-Za-z_]\w*)\s*(?:\(|[:{<])/.exec(
          lines[i],
        );
      if (m && !['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else'].includes(m[2])) {
        push(i + 1, m[1], m[2]);
      }
    }
  } else {
    // JS / TS / JSX / TSX / MJS / CJS / generic fallback
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      let m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line);
      if (m) {
        push(i + 1, 'fn', m[1]);
        continue;
      }
      m = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (m) {
        push(i + 1, m[1], m[2]);
        continue;
      }
      m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(line);
      if (m) {
        push(i + 1, 'const', m[1]);
        continue;
      }
      m = /^\s*(?:test|it|describe)\s*\(\s*['"`]([^'"`]{1,80})['"`]/.exec(line);
      if (m) {
        push(i + 1, 'test', m[1]);
      }
    }
  }

  return { lineCount: lines.length, symbols };
}

export async function runQuickOutline({ paths: filePaths = [], cwd = process.cwd(), compact = false } = {}) {
  const list = Array.isArray(filePaths) ? filePaths.slice(0, MAX_OUTLINE_FILES) : [];
  if (list.length === 0) {
    return { ok: false, error: 'paths 数组不能为空' };
  }
  const baseCwd = path.resolve(cwd || process.cwd());
  const maxBytes = compact ? COMPACT_MAX_BYTES : GENEROUS_MAX_BYTES;
  const outLines = [];

  for (const rawPath of list) {
    const full = resolveSafePath(baseCwd, String(rawPath || '').trim());
    const rel = path.relative(baseCwd, full).replace(/\\/g, '/') || String(rawPath);
    let content;
    try {
      const st = await fs.stat(full);
      if (st.size > MAX_FILE_READ_BYTES) {
        outLines.push(`${rel}: (跳过，文件超过 2MB)`);
        continue;
      }
      content = await fs.readFile(full, 'utf8');
    } catch (err) {
      outLines.push(`${rel}: 读取失败 (${err?.code || err?.message})`);
      continue;
    }
    const { lineCount, symbols } = extractFileOutline(full, content);
    outLines.push(`== ${rel} (${lineCount} 行, ${symbols.length} 符号) ==`);
    if (symbols.length === 0) {
      outLines.push('  (未检测到顶层符号)');
    } else {
      for (const s of symbols.slice(0, 80)) {
        outLines.push(`  L${s.line} [${s.kind}] ${s.name}`);
      }
      if (symbols.length > 80) outLines.push(`  ... 其余 ${symbols.length - 80} 个符号已省略`);
    }
  }

  const folded = compactTextOutput(outLines.join('\n'), { maxBytes });
  return {
    ok: true,
    fileCount: list.length,
    compact,
    truncated: folded.truncated,
    outputBytes: folded.outputBytes,
    text: folded.text,
  };
}

/**
 * 3B. Targeted multi-file line-slice reader (with optional outline header).
 */
export async function runReadSlices({ requests = [], cwd = process.cwd(), compact = false } = {}) {
  const list = Array.isArray(requests) ? requests.slice(0, 20) : [];
  if (list.length === 0) {
    return { ok: false, error: 'requests 数组不能为空' };
  }
  const baseCwd = path.resolve(cwd || process.cwd());
  const maxBytes = compact ? COMPACT_MAX_BYTES : GENEROUS_MAX_BYTES;
  const outLines = [];

  for (const req of list) {
    const rawPath = String(req?.path || '').trim();
    if (!rawPath) continue;
    const full = resolveSafePath(baseCwd, rawPath);
    const rel = path.relative(baseCwd, full).replace(/\\/g, '/') || rawPath;
    let content;
    try {
      content = await fs.readFile(full, 'utf8');
    } catch (err) {
      outLines.push(`${rel}: 读取失败 (${err?.code || err?.message})`);
      continue;
    }
    const lines = content.split(/\r?\n/);
    if (req?.outline) {
      const { symbols } = extractFileOutline(full, content);
      outLines.push(`== ${rel} 大纲 (${lines.length} 行) ==`);
      symbols.slice(0, 40).forEach((s) => outLines.push(`  L${s.line} [${s.kind}] ${s.name}`));
    }
    const ranges = Array.isArray(req?.ranges)
      ? req.ranges
      : Number.isInteger(req?.startLine)
        ? [[req.startLine, req.endLine || req.startLine + 60]]
        : [];
    for (const r of ranges.slice(0, 8)) {
      const s = Math.max(1, Math.min(lines.length, Number(Array.isArray(r) ? r[0] : r?.startLine) || 1));
      const e = Math.max(s, Math.min(lines.length, Number(Array.isArray(r) ? r[1] : r?.endLine) || s + 60));
      outLines.push(`-- ${rel}:L${s}-L${e} --`);
      for (let i = s - 1; i < e; i += 1) {
        outLines.push(`${i + 1}: ${lines[i]}`);
      }
    }
  }

  const folded = compactTextOutput(outLines.join('\n'), { maxBytes });
  return {
    ok: true,
    requestCount: list.length,
    compact,
    truncated: folded.truncated,
    outputBytes: folded.outputBytes,
    text: folded.text,
  };
}

/**
 * Build a compact managed rules block appended to rules/AGENTS.md only for enabled boost features.
 * Returns empty string when all 3 features are OFF (+0 tokens).
 */
export function buildBoostRulesBlock(rawBoost) {
  const boost = normalizeBoostConfig(rawBoost);
  if (!hasAnyBoostEnabled(boost)) return '';

  const lines = [
    BOOST_RULES_START,
    '## AGY 增强加速规则（用户已按需启用）',
  ];
  if (boost.batchOps) {
    lines.push(
      '- **打包合并做**：需要执行多处检索、多文件关联修改或多项检查时，优先使用 `boost_mcp` 批量工具合并为单次调用：`boost_batch_search({ queries })`（支持 text/regex/glob/fuzzy/只读 git）、`boost_apply_edits({ edits, verify })`（原子多文件编辑并可顺带校验）、`boost_run_checks({ commands })`（并发运行检查）。',
    );
  }
  if (boost.outlineFirst) {
    lines.push(
      '- **先目录再精读**：面对超过 300 行的未知大文件，优先用 `boost_quick_outline({ paths })` 提取函数/类行号目录，再用 `boost_read_slices({ requests })` 或定向行号读取目标片段，避免盲目整文件读入上下文。',
    );
  }
  if (boost.compactOutput) {
    lines.push(
      '- **压输出砍废话**：长日志构建或测试优先使用 `boost_compact_run({ command })`（或 `boost_run_checks`），输出自动剥离噪声并首尾折叠在 8.8 KB 内，避免大段日志撑爆上下文或落盘触发额外轮次。',
    );
  }
  lines.push(BOOST_RULES_END);
  return lines.join('\n');
}

export function stripBoostRulesBlock(content) {
  const raw = String(content ?? '').replace(/\r\n?/g, '\n');
  const startIdx = raw.indexOf(BOOST_RULES_START);
  const endIdx = raw.indexOf(BOOST_RULES_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return raw;
  }
  const before = raw.slice(0, startIdx).replace(/\n+$/, '');
  const after = raw.slice(endIdx + BOOST_RULES_END.length).replace(/^\n+/, '');
  if (!before && !after) return '';
  if (!before) return `${after}\n`;
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}\n`;
}

export function mergeBoostRulesIntoContent(baseContent, boost) {
  const cleanBase = stripBoostRulesBlock(baseContent).trimEnd();
  const block = buildBoostRulesBlock(boost);
  if (!block) {
    return cleanBase ? `${cleanBase}\n` : '';
  }
  if (!cleanBase) {
    return `${block}\n`;
  }
  return `${cleanBase}\n\n${block}\n`;
}

export function readBoostConfigSync(prefsFile) {
  try {
    if (!prefsFile || !fsSync.existsSync(prefsFile)) {
      return { ...DEFAULT_BOOST_CONFIG };
    }
    const parsed = JSON.parse(fsSync.readFileSync(prefsFile, 'utf8'));
    return normalizeBoostConfig(parsed?.boost);
  } catch {
    return { ...DEFAULT_BOOST_CONFIG };
  }
}
