import fs from 'node:fs/promises';
import { atomicWriteText } from './paths.mjs';
import { mergeBoostRulesIntoContent } from './boost_tools.mjs';
import { BUILTIN_PRESETS, RULES_MAX_BYTES, estimateTokens, getBuiltinPresetById } from './presets_builtin.mjs';
import { HEX_COLOR_RE } from './storage.mjs';

export { RULES_MAX_BYTES };

const YAML_FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const PLACEHOLDER_MODEL_RE = /^MODEL_PLACEHOLDER_/i;

const BLOCK_RULES = [
  {
    code: 'SPOOFED_SYSTEM_TAG',
    pattern:
      /<\/?(?:system|system_instruction|system-instruction|system_prompt|instructions|developer|assistant|human|tool_definition|function_calls|invoke)\b[^>]*>/i,
    reason: '检测到伪造 <system> / <instructions> 等系统或工具协议标签，已拦截以防提示词注入或触发风控。',
  },
  {
    code: 'DELIMITER_SPOOF',
    pattern: /<<\/?SYS>>|\[\/?INST\]|<\|(?:im_start|im_end|system|endoftext)\|>/i,
    reason: '检测到模型对话边界伪造标记（如 <<SYS>>、[INST]、<|im_start|>），已拦截。',
  },
  {
    code: 'OVERRIDE_DIRECTIVE',
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:previous|prior|above|system|builtin|official)\s+(?:instructions|prompts?|rules?)\b/i,
    reason: '检测到覆盖官方内置指令的高危越权语句，已拦截。',
  },
  {
    code: 'THIRD_PARTY_HARNESS_OR_PROXY',
    pattern:
      /(?:\bdsh\b|\bpi-(?:coding-agent|antigravity|agent|mono)\b|\bYou\s+are\s+(?:Claude\s+Code|Codex\s+CLI|Cursor\s+Agent|OpenCode)\b|antigravity[-_\s]*reverse[-_\s]*proxy|reverse[-_\s]*proxy[-_\s]*(?:prompt|header|spoof)|x-goog-api-client|anti[-_\s]*ban\s+(?:header|prompt)|\*\*\*\s*Begin\s+Patch\b|反代提示词|绕过封号|伪造官方系统提示词)/i,
    reason:
      '检测到 dsh / pi-coding-agent / 反代提示词或第三方 Harness 特征文本（存在官方提示词匹配封号风险），已拦截。',
  },
  {
    code: 'SCRIPT_INJECTION',
    pattern: /<script\b[^>]*>|javascript\s*:/i,
    reason: '检测到脚本执行或 javascript: 伪协议内容，已拦截。',
  },
];

/**
 * Canonical agentapi tier fallbacks shown only as non-authoritative baseline choices
 * alongside real observed telemetry model IDs.
 */
const AGENTAPI_FALLBACK_TIERS = Object.freeze([
  Object.freeze({
    id: 'pro',
    label: 'Pro (agentapi 高阶档)',
    labelEn: 'Pro (agentapi tier)',
    provider: 'Antigravity',
    tier: 'pro',
    source: 'agentapi_tier',
  }),
  Object.freeze({
    id: 'flash',
    label: 'Flash (agentapi 快速档)',
    labelEn: 'Flash (agentapi tier)',
    provider: 'Antigravity',
    tier: 'fast',
    source: 'agentapi_tier',
  }),
  Object.freeze({
    id: 'flash_lite',
    label: 'Flash Lite (agentapi 轻量档)',
    labelEn: 'Flash Lite (agentapi tier)',
    provider: 'Antigravity',
    tier: 'fast',
    source: 'agentapi_tier',
  }),
]);

/**
 * Inspect Markdown rule content before saving or writing rules/AGENTS.md.
 * Enforces strict UTF-8 byte budget (<= 24,000 bytes) and blocks spoofed system headers / proxy fingerprints.
 */
export function inspectMarkdownSecurity(rawContent) {
  if (typeof rawContent !== 'string') {
    const reason = '规则内容必须是 UTF-8 纯文本字符串。';
    return {
      safe: false,
      ok: false,
      blocked: true,
      reason,
      reasons: [reason],
      warnings: [],
      bytes: 0,
      sanitized: '',
      sanitizedContent: '',
    };
  }

  if (rawContent.includes('\x00')) {
    const reason = '检测到二进制空字节 (NUL)，已拒绝导入。';
    return {
      safe: false,
      ok: false,
      blocked: true,
      reason,
      reasons: [reason],
      warnings: [],
      bytes: Buffer.byteLength(rawContent, 'utf8'),
      sanitized: '',
      sanitizedContent: '',
    };
  }

  const warnings = [];
  let sanitized = rawContent.replace(/\r\n?/g, '\n');

  const stripped = sanitized.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  if (stripped !== sanitized) {
    sanitized = stripped;
    warnings.push('检测到不可见零宽字符，已自动剔除。');
  }

  const bytes = Buffer.byteLength(sanitized, 'utf8');
  if (bytes > RULES_MAX_BYTES) {
    const reason = `规则文件 UTF-8 体积为 ${bytes.toLocaleString('en-US')} 字节，已超过官方单文件 ${RULES_MAX_BYTES.toLocaleString('en-US')} 字节上限（中文每字约 3 字节）。请精简后重试。`;
    return {
      safe: false,
      ok: false,
      blocked: true,
      reason,
      reasons: [reason],
      warnings,
      bytes,
      sanitized: '',
      sanitizedContent: '',
    };
  }

  if (YAML_FRONTMATTER_RE.test(sanitized)) {
    warnings.push('AGENTS.md 不支持 YAML frontmatter 元数据，官方加载器将其视为普通文本。');
  }

  const matchedReasons = [];
  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(sanitized)) {
      matchedReasons.push(rule.reason);
    }
  }

  if (matchedReasons.length > 0) {
    return {
      safe: false,
      ok: false,
      blocked: true,
      reason: matchedReasons[0],
      reasons: matchedReasons,
      warnings,
      bytes,
      sanitized: '',
      sanitizedContent: '',
    };
  }

  return {
    safe: true,
    ok: true,
    blocked: false,
    reason: null,
    reasons: [],
    warnings,
    bytes,
    sanitized,
    sanitizedContent: sanitized,
  };
}

/**
 * Validate and atomically write rules/AGENTS.md for the active preset.
 * Note: official preset writes an empty rules/AGENTS.md (+0 tokens).
 */
export async function applyRulesPreset(paths, presetInput, options = {}) {
  const preset =
    typeof presetInput === 'string'
      ? getBuiltinPresetById(presetInput) || { id: presetInput, content: '' }
      : presetInput || BUILTIN_PRESETS[0];

  const mergedRaw =
    options && Object.prototype.hasOwnProperty.call(options, 'boost')
      ? mergeBoostRulesIntoContent(preset.content ?? '', options.boost)
      : (preset.content ?? '');

  const inspection = inspectMarkdownSecurity(mergedRaw);
  if (!inspection.safe || inspection.blocked) {
    return {
      ok: false,
      blocked: true,
      presetId: preset.id || 'unknown',
      rulesFile: paths.rulesFile,
      bytes: inspection.bytes,
      tokens: 0,
      reason: inspection.reason,
      reasons: inspection.reasons,
      warnings: inspection.warnings,
    };
  }

  if (Buffer.byteLength(inspection.sanitized, 'utf8') > RULES_MAX_BYTES) {
    return {
      ok: false,
      blocked: true,
      presetId: preset.id || 'unknown',
      rulesFile: paths.rulesFile,
      bytes: inspection.bytes,
      tokens: 0,
      reason: `规则体积超过 ${RULES_MAX_BYTES} 字节限制`,
      reasons: [`规则体积超过 ${RULES_MAX_BYTES} 字节限制`],
      warnings: inspection.warnings,
    };
  }

  await atomicWriteText(paths.rulesFile, inspection.sanitized);

  return {
    ok: true,
    blocked: false,
    presetId: preset.id || 'custom',
    rulesFile: paths.rulesFile,
    bytes: inspection.bytes,
    tokens: estimateTokens(inspection.sanitized),
    warnings: inspection.warnings,
  };
}

/**
 * Update only the managed Boost rules block inside rules/AGENTS.md while preserving
 * whatever user/preset rules currently exist.
 */
export async function syncBoostRules(paths, boost) {
  let existing = '';
  try {
    existing = await fs.readFile(paths.rulesFile, 'utf8');
  } catch {
    existing = '';
  }
  const merged = mergeBoostRulesIntoContent(existing, boost);
  const inspection = inspectMarkdownSecurity(merged);
  if (!inspection.safe || inspection.blocked) {
    return {
      ok: false,
      blocked: true,
      rulesFile: paths.rulesFile,
      bytes: inspection.bytes,
      tokens: 0,
      reason: inspection.reason,
    };
  }
  await atomicWriteText(paths.rulesFile, inspection.sanitized);
  return {
    ok: true,
    blocked: false,
    rulesFile: paths.rulesFile,
    bytes: inspection.bytes,
    tokens: estimateTokens(inspection.sanitized),
  };
}

function relativeLuminance(hex) {
  const clean = hex.slice(1);
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Pure JSON preview builder for Antigravity customThemeSeedsDark / Light.
 * Performs strict #RRGGBB validation with zero disk I/O to user config.json.
 */
export function buildHostThemeSeedsPreview(colors) {
  if (!colors || typeof colors !== 'object') {
    return { ok: false, error: 'Colors object is required' };
  }

  for (const reqKey of ['canvas', 'accent']) {
    if (typeof colors[reqKey] !== 'string' || !HEX_COLOR_RE.test(colors[reqKey].trim())) {
      return { ok: false, error: `Invalid #RRGGBB color for "${reqKey}"` };
    }
  }

  for (const optKey of ['contrast', 'tertiary', 'chrome', 'bubble', 'foregroundOverride']) {
    if (colors[optKey] !== undefined) {
      if (typeof colors[optKey] !== 'string' || !HEX_COLOR_RE.test(colors[optKey].trim())) {
        return { ok: false, error: `Invalid #RRGGBB color for "${optKey}"` };
      }
    }
  }

  const background = colors.canvas.trim().toUpperCase();
  const primary = colors.accent.trim().toUpperCase();
  const isLight = relativeLuminance(background) >= 0.5;
  const targetKey = isLight ? 'customThemeSeedsLight' : 'customThemeSeedsDark';
  const foregroundOverride =
    typeof colors.foregroundOverride === 'string'
      ? colors.foregroundOverride.trim().toUpperCase()
      : isLight
        ? '#1A1D26'
        : '#E8EBF4';

  const seed = {
    background,
    primary,
    foregroundOverride,
  };

  return {
    ok: true,
    targetKey,
    seed,
    configSnippet: {
      userSettings: {
        [targetKey]: seed,
      },
    },
  };
}

/**
 * Disabled non-writing compatibility stub:
 * Direct writes to ~/.gemini/config/config.json are prohibited to avoid LS RMW races.
 * Never reads or modifies host config.json, app.asar, or .pbtxt.
 */
export async function syncHostThemeSeeds(_paths, colors, _syncGlobal = true) {
  const preview = buildHostThemeSeedsPreview(colors);
  if (!preview.ok) {
    return {
      ok: false,
      hostThemeSynced: false,
      synced: false,
      error: preview.error,
    };
  }
  return {
    ok: true,
    hostThemeSynced: false,
    synced: false,
    skipped: true,
    disabledReason: 'host_config_write_prohibited',
    preview,
  };
}

/**
 * Read-only inspection of antigravity_state.pbtxt for last_selected_agent_model hint.
 * Ignores protobuf MODEL_PLACEHOLDER_* placeholder enum values. Strictly read-only.
 */
const hostModelHintCache = new Map();

export async function readHostModelHint(paths) {
  const fp = paths?.pbtxtPath;
  if (!fp) return null;
  try {
    const st = await fs.stat(fp);
    const cached = hostModelHintCache.get(fp);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.value;
    }
    const raw = await fs.readFile(fp, 'utf8');
    const match = /^\s*last_selected_agent_model:\s*"?([A-Za-z0-9_.-]+)"?/m.exec(raw);
    const value = match ? match[1].trim() : '';
    const resolved = !value || PLACEHOLDER_MODEL_RE.test(value) ? null : value;
    if (hostModelHintCache.size > 16) hostModelHintCache.clear();
    hostModelHintCache.set(fp, { mtimeMs: st.mtimeMs, size: st.size, value: resolved });
    return resolved;
  } catch {
    return null;
  }
}

const TIER_FAST_RE = /(?:^|[-_])(?:flash|mini|haiku|lite)(?:$|[-_])/;
const TIER_HIGH_RE = /(?:^|[-_])(?:opus|ultra|xhigh|high|tiered)(?:$|[-_])/;
const TIER_PRO_RE = /(?:^|[-_])(?:pro|sonnet|thinking)(?:$|[-_])/;

export function inferProviderAndTier(modelId) {
  const lower = String(modelId).toLowerCase();
  let provider = 'Other';
  if (lower.includes('gemini')) provider = 'Google';
  else if (lower.includes('claude')) provider = 'Anthropic';
  else if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) provider = 'OpenAI';

  let tier = 'standard';
  if (TIER_FAST_RE.test(lower)) {
    tier = 'fast';
  } else if (TIER_HIGH_RE.test(lower)) {
    tier = 'high';
  } else if (TIER_PRO_RE.test(lower)) {
    tier = 'pro';
  }

  return { provider, tier };
}

/**
 * Return known models from telemetry-observed IDs merged with canonical agentapi fallback tiers.
 * Filters out synthetic '__unrecorded__' bucket and ignores MODEL_PLACEHOLDER_* pbtxt hints.
 */
export async function listKnownModels(paths, observedModels = []) {
  const hostHint = await readHostModelHint(paths);
  const byId = new Map();

  if (Array.isArray(observedModels)) {
    for (const item of observedModels) {
      const id = typeof item === 'string' ? item.trim() : String(item?.id || item?.model || '').trim();
      if (!id || id === '__unrecorded__' || PLACEHOLDER_MODEL_RE.test(id) || byId.has(id)) continue;
      const inferred = inferProviderAndTier(id);
      byId.set(id, {
        id,
        label: typeof item === 'object' && item?.label ? String(item.label) : id,
        provider: typeof item === 'object' && item?.provider ? String(item.provider) : inferred.provider,
        tier: typeof item === 'object' && item?.tier ? String(item.tier) : inferred.tier,
        source: 'observed',
        ...(hostHint ? { hostHint } : {}),
      });
    }
  }

  for (const fallbackTier of AGENTAPI_FALLBACK_TIERS) {
    if (!byId.has(fallbackTier.id)) {
      byId.set(fallbackTier.id, {
        ...fallbackTier,
        ...(hostHint ? { hostHint } : {}),
      });
    }
  }

  return Array.from(byId.values());
}
