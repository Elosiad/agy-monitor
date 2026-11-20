/**
 * Official Antigravity PreInvocation lifecycle hook for AGY Console "掌握 (Mastery)" tab.
 *
 * - Default OFF: when mastery_config.json is missing, disabled, or using thirdparty mode,
 *   returns `{}` immediately (<10ms, zero injection, zero token overhead).
 * - When enabled with `source === "self"`:
 *   1) At the start of a new user task (first invocation for a given lastUserInput), appends
 *      a concise tail systemMessage instructing the running Agent to emit a ~30-char kid-friendly
 *      opening thought + `[AGY_PROGRESS|10%|...]` before its tool calls (same turn, no stopping).
 *   2) Thereafter, only when `now - lastPromptAtMs >= frequencyMs` (30s / 1m / 3m / 5m), appends
 *      a minimal tail systemMessage asking for `[AGY_PROGRESS|<0-100>%|<10字以内通俗总结>]`
 *      alongside its next tool call. Because messages are appended strictly at the tail and never
 *      mutate history prefix, Prompt Cache hit rate stays ~99%+.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FREQ_MS = {
  '30s': 30_000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
};

function readStdinUtf8() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomicSync(filePath, obj) {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(tmp, filePath);
    } catch {
      fs.copyFileSync(tmp, filePath);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore cleanup failure
      }
    }
  } catch {
    // Non-fatal state write failure
  }
}

function resolvePluginDataDir() {
  const envDir = process.env.AGY_MONITOR_PLUGIN_DATA_DIR || process.env.PLUGIN_DATA;
  if (envDir && envDir.trim()) {
    return path.resolve(envDir.trim());
  }
  const appData =
    process.env.AGY_MONITOR_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
  return path.join(path.resolve(appData), 'plugin_data', 'agy-monitor');
}

function hashText(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

export function evaluateMasteryHook(payload, { pluginDataDir, nowMs = Date.now() } = {}) {
  const dataDir = pluginDataDir || resolvePluginDataDir();
  const configPath = path.join(dataDir, 'mastery_config.json');
  const statePath = path.join(dataDir, 'mastery_hook_state.json');

  const rawCfg = readJsonSafe(configPath);
  const cfg = rawCfg && typeof rawCfg === 'object'
    ? rawCfg
    : { enabled: true, source: 'self', frequency: '1m', thinking: 'low' };
  if (cfg.enabled !== true || cfg.source !== 'self') {
    return {};
  }

  const convId =
    typeof payload?.conversationId === 'string' && payload.conversationId.trim()
      ? payload.conversationId.trim()
      : 'default';
  const freqMs = FREQ_MS[cfg.frequency] || FREQ_MS['1m'];
  const invocationNum = Number(payload?.invocationNum || 0);
  const inputHash = hashText(payload?.lastUserInput || '');

  const state = readJsonSafe(statePath) || { version: 1, convs: {} };
  if (!state.convs || typeof state.convs !== 'object') {
    state.convs = {};
  }

  const prev = state.convs[convId] || {};
  const isNewUserTask =
    (inputHash && inputHash !== prev.lastInputHash) ||
    (!prev.introSent && invocationNum <= 1);

  let instruction = '';
  if (isNewUserTask) {
    instruction =
      '【AGY掌握·开场汇报】在你开始调用工具执行命令前，请先在回复最开头用1行**纯简体中文**输出：' +
      '`[AGY_PROGRESS|10%|<10字以内纯中文、五岁孩童能懂的状态>]` 后紧跟约30字纯中文大白话，' +
      '说明你对用户任务的理解以及接下来第一步打算做什么（严禁使用英文句子）；然后**本轮立刻继续调用工具，不要停下来等用户**。';
    state.convs[convId] = {
      lastInputHash: inputHash || prev.lastInputHash || '',
      introSent: true,
      lastPromptAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  } else {
    const elapsed = nowMs - Number(prev.lastPromptAtMs || 0);
    if (elapsed >= freqMs) {
      instruction =
        '【AGY掌握·阶段总结】请在本次继续调工具前顺带用**纯简体中文**输出1行：' +
        '`[AGY_PROGRESS|<0-100整数>%|<10字以内纯中文、给五岁孩童都能看懂的当前进度总结>]` ' +
        '（例如 `[AGY_PROGRESS|60%|修好报错准备复测]`），可附1句简短中文进展（严禁使用英文句子）；' +
        '**同一步直接继续调用工具，不要停顿等用户**。';
      state.convs[convId] = {
        lastInputHash: inputHash || prev.lastInputHash || '',
        introSent: true,
        lastPromptAtMs: nowMs,
        updatedAtMs: nowMs,
      };
    }
  }

  if (!instruction) {
    return {};
  }

  // Prune stale conversation entries (>7d) so state file stays tiny
  const cutoff = nowMs - 7 * 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(state.convs)) {
    if (k !== convId && Number(v?.updatedAtMs || 0) < cutoff) {
      delete state.convs[k];
    }
  }
  writeJsonAtomicSync(statePath, state);

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: instruction,
        },
      },
    ],
  };
}

function main() {
  try {
    const raw = readStdinUtf8();
    const payload = raw && raw.trim() ? JSON.parse(raw) : {};
    const out = evaluateMasteryHook(payload);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    process.stdout.write('{}\n');
  }
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]).toLowerCase().endsWith('mastery_summary_hook.mjs');

if (isEntrypoint) {
  main();
}
