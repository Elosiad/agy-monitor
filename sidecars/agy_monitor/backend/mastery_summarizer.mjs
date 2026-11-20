/**
 * Third-party summary model proxy & background scheduler for AGY Console "掌握" tab.
 *
 * - Supports OpenAI (`/v1/chat/completions`, `/v1/models`) and Anthropic (`/v1/messages`, `/v1/models`).
 * - Runs strictly in the Sidecar Node.js backend so API keys stay local and browser CORS never blocks.
 * - Background summarization triggers ONLY when `enabled === true && source === 'thirdparty'`,
 *   respects `frequency` (30s / 1m / 3m / 5m), and skips unchanged step counts to save quota.
 */

import fs from 'node:fs/promises';
import { atomicWriteJson } from './paths.mjs';
import { trimKidSummary } from './mastery.mjs';

const FREQ_MS = {
  '30s': 30_000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
};

const REQUEST_TIMEOUT_MS = 12_000;

function normalizeBaseUrl(rawUrl, protocol) {
  const fallback =
    protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
  const cleaned = String(rawUrl || fallback).trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error('接口地址格式无效，请以 http:// 或 https:// 开头');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http:// 或 https:// 协议地址');
  }
  return cleaned;
}

function buildModelsEndpoint(baseUrl) {
  return baseUrl.endsWith('/models') ? baseUrl : `${baseUrl}/models`;
}

function buildChatEndpoint(baseUrl, protocol) {
  if (protocol === 'anthropic') {
    return baseUrl.endsWith('/messages') ? baseUrl : `${baseUrl}/messages`;
  }
  return baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const latencyMs = Math.max(1, Date.now() - started);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, latencyMs, json, text };
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('请求超时，请检查接口地址与网络连通性');
    }
    throw new Error(err?.message || '网络请求失败');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch available model IDs from an OpenAI-compatible or Anthropic-compatible `/models` endpoint.
 */
export async function fetchThirdPartyModels({ protocol = 'openai', baseUrl, apiKey } = {}) {
  const proto = protocol === 'anthropic' ? 'anthropic' : 'openai';
  const normBase = normalizeBaseUrl(baseUrl, proto);
  const key = String(apiKey || '').trim();
  const endpoint = buildModelsEndpoint(normBase);

  const headers =
    proto === 'anthropic'
      ? {
          ...(key ? { 'x-api-key': key } : {}),
          'anthropic-version': '2023-06-01',
          Accept: 'application/json',
        }
      : {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          Accept: 'application/json',
        };

  const res = await fetchJsonWithTimeout(endpoint, { method: 'GET', headers }, 9000);
  if (!res.ok) {
    const detail = res.json?.error?.message || res.json?.message || `HTTP ${res.status}`;
    throw new Error(`拉取模型失败：${String(detail).slice(0, 120)}`);
  }

  const rawList = Array.isArray(res.json?.data)
    ? res.json.data
    : Array.isArray(res.json?.models)
      ? res.json.models
      : [];
  const models = [
    ...new Set(
      rawList
        .map((item) => (typeof item === 'string' ? item : item?.id || item?.name || ''))
        .map((s) => String(s).trim())
        .filter(Boolean),
    ),
  ].slice(0, 200);

  if (models.length === 0) {
    throw new Error('接口返回成功但未解析到可用模型列表');
  }
  return { ok: true, models, latencyMs: res.latencyMs };
}

function buildCompletionPayload({ protocol, model, thinking, systemPrompt, userPrompt, maxTokens = 220 }) {
  if (protocol === 'anthropic') {
    const budgetMap = { low: 1024, medium: 2048, high: 4096 };
    const body = {
      model,
      max_tokens: thinking && thinking !== 'off' ? Math.max(maxTokens, (budgetMap[thinking] || 1024) + 256) : maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    };
    if (thinking && thinking !== 'off' && budgetMap[thinking]) {
      body.thinking = { type: 'enabled', budget_tokens: budgetMap[thinking] };
    }
    return body;
  }

  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
  if (thinking && thinking !== 'off') {
    body.reasoning_effort = thinking;
  }
  return body;
}

function extractReplyText(protocol, json) {
  if (!json || typeof json !== 'object') return '';
  if (protocol === 'anthropic') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    return blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  const msg = json.choices?.[0]?.message?.content;
  if (typeof msg === 'string') return msg.trim();
  if (Array.isArray(msg)) {
    return msg.map((p) => p?.text || '').join('\n').trim();
  }
  return '';
}

/**
 * Send a minimal ping request to test connectivity and real round-trip latency.
 */
export async function testThirdPartyConnection({
  protocol = 'openai',
  baseUrl,
  apiKey,
  model,
  thinking = 'off',
} = {}) {
  const proto = protocol === 'anthropic' ? 'anthropic' : 'openai';
  const normBase = normalizeBaseUrl(baseUrl, proto);
  const key = String(apiKey || '').trim();
  const modelId = String(model || '').trim();
  if (!modelId) {
    throw new Error('请先选择或填写模型 ID');
  }

  const endpoint = buildChatEndpoint(normBase, proto);
  const headers =
    proto === 'anthropic'
      ? {
          'Content-Type': 'application/json',
          ...(key ? { 'x-api-key': key } : {}),
          'anthropic-version': '2023-06-01',
        }
      : {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        };

  const payload = buildCompletionPayload({
    protocol: proto,
    model: modelId,
    thinking: 'off',
    systemPrompt: 'Reply with OK only.',
    userPrompt: 'ping',
    maxTokens: 12,
  });

  const res = await fetchJsonWithTimeout(
    endpoint,
    { method: 'POST', headers, body: JSON.stringify(payload) },
    10_000,
  );
  if (!res.ok) {
    const detail = res.json?.error?.message || res.json?.message || `HTTP ${res.status}`;
    throw new Error(`连通测试失败 (${res.status})：${String(detail).slice(0, 120)}`);
  }

  return {
    ok: true,
    protocol: proto,
    model: modelId,
    latencyMs: res.latencyMs,
    thinking,
  };
}

function parseSummaryJson(rawText) {
  const s = String(rawText || '').trim();
  const m = /\{[\s\S]*\}/.exec(s);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    const status = trimKidSummary(parsed.status || '', 10);
    const percent = Math.max(0, Math.min(100, Math.round(Number(parsed.percent) || 0)));
    const openingThought = String(parsed.openingThought || '').trim().slice(0, 120);
    const stageReport = String(parsed.stageReport || '').trim().slice(0, 160);
    if (!status && !stageReport) return null;
    return { status, percent, openingThought, stageReport };
  } catch {
    return null;
  }
}

/**
 * Manages cached third-party summaries + non-blocking periodic summarization.
 */
export function createMasterySummarizer(paths, store) {
  let cache = null;
  const inFlightKeys = new Set();

  const loadCache = async () => {
    if (cache) return cache;
    try {
      const raw = await fs.readFile(paths.masterySummariesFile, 'utf8');
      const parsed = JSON.parse(raw);
      cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      cache = {};
    }
    return cache;
  };

  const saveCache = async () => {
    if (!cache || !paths?.masterySummariesFile) return;
    await atomicWriteJson(paths.masterySummariesFile, cache).catch(() => {});
  };

  const summarizeSingleAgent = async (cfg, cacheKey, agentDigest, stepCount) => {
    if (inFlightKeys.has(cacheKey)) return;
    inFlightKeys.add(cacheKey);
    try {
      const tp = cfg.thirdParty;
      const proto = tp.protocol === 'anthropic' ? 'anthropic' : 'openai';
      const normBase = normalizeBaseUrl(tp.baseUrl, proto);
      const endpoint = buildChatEndpoint(normBase, proto);
      const headers =
        proto === 'anthropic'
          ? {
              'Content-Type': 'application/json',
              ...(tp.apiKey ? { 'x-api-key': tp.apiKey } : {}),
              'anthropic-version': '2023-06-01',
            }
          : {
              'Content-Type': 'application/json',
              ...(tp.apiKey ? { Authorization: `Bearer ${tp.apiKey}` } : {}),
            };

      const systemPrompt =
        '你是中文进度翻译助手。无论输入日志是中文还是英文，所有输出字段都必须严格使用纯简体中文（严禁输出英文句子）。' +
        '请根据 Agent 日志输出严格 JSON（禁止 Markdown 代码块）：' +
        '{"status":"10字以内纯中文、给五岁孩童都能看懂的当前状态总结","percent":0到100整数,"openingThought":"约30字纯中文大白话表达对用户任务的理解和接下来要干什么","stageReport":"一句话直白中文阶段进展"}';

      const body = buildCompletionPayload({
        protocol: proto,
        model: tp.selectedModel,
        thinking: cfg.thinking,
        systemPrompt,
        userPrompt: agentDigest.slice(0, 2200),
        maxTokens: 240,
      });

      const res = await fetchJsonWithTimeout(
        endpoint,
        { method: 'POST', headers, body: JSON.stringify(body) },
        12_000,
      );
      if (!res.ok) return;
      const replyText = extractReplyText(proto, res.json);
      const parsed = parseSummaryJson(replyText);
      if (!parsed) return;

      const cur = await loadCache();
      cur[cacheKey] = {
        ...parsed,
        stepCount,
        updatedAtMs: Date.now(),
        model: tp.selectedModel,
      };
      await saveCache();
    } catch {
      // Non-fatal third-party summary error
    } finally {
      inFlightKeys.delete(cacheKey);
    }
  };

  const maybeSchedule = async (detailSession) => {
    if (!detailSession || detailSession.status !== 'active') return;
    const cfg = await store.getMasteryConfig();
    if (!cfg?.enabled || cfg.source !== 'thirdparty') return;
    if (!cfg.thirdParty?.baseUrl || !cfg.thirdParty?.selectedModel) return;

    const freqMs = FREQ_MS[cfg.frequency] || FREQ_MS['1m'];
    const cur = await loadCache();
    const nowMs = Date.now();

    const targets = [];
    if (detailSession.master) {
      targets.push({
        key: `${detailSession.id}:coord`,
        digest: detailSession.master.recentDigest || '',
        stepCount: Number(detailSession.master.stepCount || 0),
      });
    }
    for (const sub of detailSession.subs || []) {
      if (sub.stateKind === 'running') {
        targets.push({
          key: `${detailSession.id}:${sub.convId}`,
          digest: sub.recentDigest || '',
          stepCount: Number(sub.stepCount || 0),
        });
      }
    }

    for (const target of targets) {
      if (!target.digest) continue;
      const prev = cur[target.key];
      const elapsed = nowMs - Number(prev?.updatedAtMs || 0);
      const stepsChanged = !prev || target.stepCount !== prev.stepCount;
      if (elapsed >= freqMs && stepsChanged) {
        void summarizeSingleAgent(cfg, target.key, target.digest, target.stepCount);
      }
    }
  };

  return {
    getCache: loadCache,
    maybeSchedule,
  };
}
