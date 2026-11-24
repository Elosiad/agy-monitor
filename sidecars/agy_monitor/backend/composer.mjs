/**
 * Mastery Agent Detail composer helpers:
 * - Official slash-command & local skill discovery (for `/` autocomplete menu)
 * - Validated raster image attachment persistence inside plugin_data/composer_media
 * - Outbound prompt formatting for official `agentapi send-message` delivery
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MAX_COMPOSER_IMAGES = 6;
export const MAX_COMPOSER_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_COMPOSER_PROMPT_CHARS = 32_000;
const MAX_STORED_MEDIA_FILES = 120;
const COMMAND_CACHE_TTL_MS = 30_000;

export const ALLOWED_COMPOSER_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

const MIME_TO_EXT = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
});

/**
 * Curated official Antigravity slash commands shown in the `/` autocomplete popup.
 */
const BUILTIN_SLASH_COMMANDS = Object.freeze([
  Object.freeze({
    name: 'swarm',
    category: 'builtin',
    badge: 'Swarm',
    builtinSkillDir: 'native_swarm',
    description:
      '(Preview & Quota Heavy) 启动多 Agent 协作集群并行处理任务，通过共享协作板实时同步进度',
    hint: '请加载内置 native_swarm 技能，按 Swarm Coordinator 协议拆分子任务并通过 swarm 工具并发调度多 Agent 协作完成。',
  }),
  Object.freeze({
    name: 'plan',
    category: 'builtin',
    badge: '官方',
    description: '先勘查代码与上下文，产出清晰的分步实现计划并在确认后再动手修改',
    hint: '请先执行只读调研并给出结构化分步实现方案，等确认后再改动代码。',
  }),
  Object.freeze({
    name: 'goal',
    category: 'builtin',
    badge: '官方',
    description: '围绕当前目标深度持续推进并反复验证，直至目标彻底完成',
    hint: '请围绕以下目标持续推进并做完整验证，直至全部达成后再汇报。',
  }),
  Object.freeze({
    name: 'boost',
    category: 'builtin',
    badge: '官方',
    description: '开启深度思考、战略拆解、多视角审视与严格验收流程处理复杂工程任务',
    hint: '请以深度思考、多视角审视和严格回归验收的标准完成以下复杂任务。',
  }),
  Object.freeze({
    name: 'grill-me',
    category: 'builtin',
    badge: '官方',
    description: '通过简明交互式追问逐步对齐架构方案与关键设计决策',
    hint: '请先通过简明的多轮提问与我逐项对齐需求边界和关键设计决策，再进入实现。',
  }),
  Object.freeze({
    name: 'teamwork',
    category: 'builtin',
    badge: '官方',
    description: '将大型任务拆分为多角色协作团队分工并行完成',
    hint: '请将该任务拆分为多个清晰模块并组织多 Agent 分工协作完成。',
  }),
  Object.freeze({
    name: 'compact',
    category: 'builtin',
    badge: '官方',
    description: '总结提炼当前会话上下文要点，便于精简记忆与继续推进',
    hint: '请简明总结当前会话的核心上下文、已完成项与待办项。',
  }),
  Object.freeze({
    name: 'schedule',
    category: 'builtin',
    badge: '官方',
    description: '在当前会话中设置一次性倒计时或周期定时提醒任务',
    hint: '请使用内置 schedule 工具按以下要求安排定时或周期任务。',
  }),
  Object.freeze({
    name: 'browser',
    category: 'builtin',
    badge: '官方',
    description: '委派内置浏览器子 Agent 访问网页、交互操作或检索实时页面信息',
    hint: '请委派内置 browser 子 Agent 完成以下网页访问与交互任务。',
  }),
  Object.freeze({
    name: 'learn',
    category: 'builtin',
    badge: '官方',
    description: '总结本次排查与修正经验，沉淀为可复用的规则或习惯',
    hint: '请提炼本次任务的关键经验教训，并给出可沉淀的规则或配置建议。',
  }),
]);

export function detectComposerImageMagic(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function parseSkillFrontmatter(rawText) {
  if (typeof rawText !== 'string') return { name: '', description: '' };
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(rawText);
  if (!match) return { name: '', description: '' };
  const block = match[1];
  const nameMatch = /^\s*name\s*:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(block);
  const descInline = /^\s*description\s*:\s*(?!>[-+]?\s*$|[-|]\s*$)["']?(.+?)["']?\s*$/m.exec(block);
  let desc = descInline ? descInline[1].trim() : '';
  if (!desc) {
    const folded = /^\s*description\s*:\s*[>|][-+]?\s*\r?\n((?:[ \t]+[^\r\n]*\r?\n?)+)/m.exec(block);
    if (folded) {
      desc = folded[1]
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ');
    }
  }
  return {
    name: nameMatch ? nameMatch[1].trim() : '',
    description: desc.slice(0, 180),
  };
}

const commandCacheByKey = new Map();

/**
 * Discover official built-in slash commands plus locally installed user skills
 * under `~/.gemini/config/skills` (strictly read-only, short TTL cached).
 */
export async function listSlashCommands(paths = {}, { force = false } = {}) {
  const appDataDir = paths?.appDataDir || '';
  const geminiConfigDir = paths?.geminiConfigDir || '';
  const cacheKey = `${appDataDir}|${geminiConfigDir}`;
  const cached = commandCacheByKey.get(cacheKey);
  const now = Date.now();
  if (!force && cached && now - cached.ts < COMMAND_CACHE_TTL_MS) {
    return cached.items;
  }

  const results = [];
  const seen = new Set();

  // 1. Official built-in slash commands (pinned first, with /swarm at index 0)
  for (const item of BUILTIN_SLASH_COMMANDS) {
    let skillPath = '';
    if (item.builtinSkillDir && appDataDir) {
      const candidate = path.join(appDataDir, 'builtin', 'skills', item.builtinSkillDir, 'SKILL.md');
      if (fs.existsSync(candidate)) {
        skillPath = candidate;
      }
    }
    seen.add(item.name.toLowerCase());
    results.push({
      name: item.name,
      category: item.category,
      badge: item.badge,
      description: item.description,
      hint: item.hint,
      ...(skillPath ? { skillPath } : {}),
    });
  }

  // 2. Local custom skills under ~/.gemini/config/skills/<dir>/SKILL.md
  if (geminiConfigDir) {
    const skillsRoot = path.join(geminiConfigDir, 'skills');
    try {
      const entries = await fsp.readdir(skillsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md');
        try {
          const text = await fsp.readFile(skillFile, 'utf8');
          const meta = parseSkillFrontmatter(text);
          const rawName = (meta.name || entry.name)
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '');
          if (!rawName || seen.has(rawName)) continue;
          seen.add(rawName);
          results.push({
            name: rawName,
            category: 'skill',
            badge: '技能',
            description: meta.description || `调用本地技能 ${rawName}`,
            skillPath: skillFile,
          });
        } catch {
          // Skip unreadable skill folder
        }
      }
    } catch {
      // No local skills folder
    }
  }

  commandCacheByKey.set(cacheKey, { ts: now, items: results });
  return results;
}

/**
 * Match a leading `/command` token from user prompt text against known commands.
 */
export function matchLeadingSlashCommand(promptText, commands = []) {
  const trimmed = String(promptText || '').trimStart();
  const m = /^\/([a-zA-Z0-9_-]{1,48})(?=\s|$)/.exec(trimmed);
  if (!m) return null;
  const cmdName = m[1].toLowerCase();
  const known = (Array.isArray(commands) ? commands : []).find(
    (c) => String(c?.name || '').toLowerCase() === cmdName
  );
  return known || { name: cmdName, category: 'custom', badge: '命令', description: '' };
}

async function pruneOldComposerMedia(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const files = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const full = path.join(dirPath, ent.name);
      try {
        const st = await fsp.stat(full);
        files.push({ full, mtimeMs: st.mtimeMs });
      } catch {
        // Ignore stat race
      }
    }
    if (files.length <= MAX_STORED_MEDIA_FILES) return;
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of files.slice(MAX_STORED_MEDIA_FILES)) {
      await fsp.rm(stale.full, { force: true }).catch(() => {});
    }
  } catch {
    // Non-fatal cleanup
  }
}

/**
 * Validate and persist pasted/attached raster images to plugin_data/composer_media.
 */
export async function saveComposerImages(paths, rawImages = []) {
  if (!Array.isArray(rawImages) || rawImages.length === 0) {
    return { ok: true, saved: [] };
  }
  if (rawImages.length > MAX_COMPOSER_IMAGES) {
    return {
      ok: false,
      status: 400,
      error: `单次最多附加 ${MAX_COMPOSER_IMAGES} 张图片`,
    };
  }

  const mediaDir =
    paths?.composerMediaDir ||
    (paths?.pluginDataDir ? path.join(paths.pluginDataDir, 'composer_media') : '');
  if (!mediaDir) {
    return { ok: false, status: 500, error: '未配置图片缓存目录' };
  }

  const decodedItems = [];
  for (let i = 0; i < rawImages.length; i += 1) {
    const item = rawImages[i];
    if (!item || typeof item !== 'object') {
      return { ok: false, status: 400, error: '图片附件格式无效' };
    }
    const rawMime = String(item.mime || '').trim().toLowerCase();
    if (rawMime && !ALLOWED_COMPOSER_IMAGE_MIMES.has(rawMime)) {
      return {
        ok: false,
        status: 403,
        error: '仅支持 PNG / JPEG / WEBP / GIF 位图图片（已拦截 SVG 等格式）',
      };
    }
    const rawB64 = typeof item.base64 === 'string' ? item.base64.trim() : '';
    const cleanB64 = rawB64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').replace(/\s+/g, '');
    if (!cleanB64) {
      return { ok: false, status: 400, error: '图片内容为空' };
    }
    const estimatedBytes = Math.floor((cleanB64.length * 3) / 4);
    if (estimatedBytes > MAX_COMPOSER_IMAGE_BYTES + 1024) {
      return { ok: false, status: 413, error: '单张粘贴图片不能超过 8 MB' };
    }
    const buf = Buffer.from(cleanB64, 'base64');
    if (buf.length === 0 || buf.length > MAX_COMPOSER_IMAGE_BYTES) {
      return { ok: false, status: 413, error: '图片体积超出 8 MB 上限或内容为空' };
    }
    const headText = buf.subarray(0, Math.min(buf.length, 256)).toString('utf8').toLowerCase();
    if (headText.includes('<svg') || headText.includes('<script')) {
      return { ok: false, status: 403, error: '安全限制：禁止发送 SVG 或脚本内容' };
    }
    const detectedMime = detectComposerImageMagic(buf);
    if (!detectedMime) {
      return { ok: false, status: 415, error: '无法识别为有效的 PNG / JPEG / WEBP / GIF 图片' };
    }
    const cleanName = String(item.name || `paste-${i + 1}`)
      .replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]+/g, '_')
      .slice(0, 48);
    decodedItems.push({ buf, mime: detectedMime, name: cleanName });
  }

  await fsp.mkdir(mediaDir, { recursive: true });
  const saved = [];
  const now = Date.now();
  for (let i = 0; i < decodedItems.length; i += 1) {
    const { buf, mime, name } = decodedItems[i];
    const ext = MIME_TO_EXT[mime] || '.png';
    const fileName = `img-${now}-${i + 1}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const filePath = path.join(mediaDir, fileName);
    await fsp.writeFile(filePath, buf);
    saved.push({
      filePath,
      mime,
      size: buf.length,
      name,
    });
  }

  void pruneOldComposerMedia(mediaDir);
  return { ok: true, saved };
}

/**
 * Format the outbound prompt delivered via official `agentapi send-message`.
 * Preserves the exact user prompt, adds structured local image paths for `read_file`,
 * and attaches official skill/workflow execution guidance when a slash command is invoked.
 */
export function composeOutboundMessage({ prompt = '', savedImages = [], slashCommand = null } = {}) {
  const userText = String(prompt || '').replace(/\r\n?/g, '\n').trim();
  const blocks = [];

  if (userText) {
    blocks.push(userText);
  } else if (savedImages.length > 0) {
    blocks.push('请查看以下用户附加的图片并结合当前上下文处理。');
  }

  if (slashCommand && slashCommand.name) {
    const guideParts = [];
    if (slashCommand.skillPath) {
      guideParts.push(`请先用 read_file 读取并严格遵循技能文件：${slashCommand.skillPath}`);
    }
    if (slashCommand.hint) {
      guideParts.push(slashCommand.hint);
    }
    if (guideParts.length > 0) {
      blocks.push(`[AGY_CONSOLE_CMD:/${slashCommand.name}] ${guideParts.join(' ')}`);
    }
  }

  if (Array.isArray(savedImages) && savedImages.length > 0) {
    const imgLines = savedImages.map((img) => `- ${String(img.filePath || '').replace(/\\/g, '/')}`);
    blocks.push(`[AGY_CONSOLE_IMAGES]\n请使用 read_file 查看用户粘贴的图片附件：\n${imgLines.join('\n')}\n[/AGY_CONSOLE_IMAGES]`);
  }

  return blocks.join('\n\n');
}
