/**
 * Mastery ("掌握") real-time multi-agent collaboration & Codex-style journey builder.
 *
 * Reads Antigravity's native local files strictly read-only:
 * - `.system_generated/logs/transcript.jsonl` (main & sub-agent step logs)
 * - `.system_generated/subagents/*.json` (spawned subagent descriptors & live states)
 * - `.system_generated/swarm/members.json` & `board.jsonl` (swarm roster & @mention links)
 * - `.system_generated/messages/*.json` (direct agent-to-agent messages)
 *
 * Key invariants:
 * - Session total progress strictly follows the Main Agent (`session.progress = master.progress`).
 * - Parses `[AGY_PROGRESS|<pct>%|<summary>]` self-summary tags emitted by running agents via
 *   `PreInvocation` hook, stripping raw protocol brackets from human-readable timeline text.
 * - Auto-classifies tool calls into Codex-style collapsible groups (运行了命令 / 编辑了文件 /
 *   读取了文件 / 检索了资料 / 协同了子 Agent) with real `+add / -del` line diff counts.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_TRANSCRIPT_TAIL_BYTES = 1_500_000;
const PROGRESS_TAG_RE = /[\[\【]\s*AGY_PROGRESS\s*[|｜]\s*(\d{1,3})\s*%?\s*[|｜]\s*([^\]\】\r\n]+?)\s*[\]\】]/i;
const PROGRESS_TAG_GLOBAL_RE = /[\[\【]\s*AGY_PROGRESS\s*[|｜]\s*(\d{1,3})\s*%?\s*[|｜]\s*([^\]\】\r\n]+?)\s*[\]\】]/gi;

function clampPct(val, fallback = 0) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseTsMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? Math.trunc(raw) : Math.trunc(raw * 1000);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.trunc(ms);
  }
  return 0;
}

export function trimKidSummary(raw, maxLen = 10) {
  const cleaned = String(raw || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^[`"'【\[\s]+|[`"'】\]\s。，,.;；:：!！?？]+$/g, '')
    .trim();
  if (!cleaned) return '';
  const chars = Array.from(cleaned);
  return chars.length <= maxLen ? cleaned : chars.slice(0, maxLen).join('');
}

export function formatDurationZh(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '刚启动';
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

/**
 * Parse `[AGY_PROGRESS|65%|修好报错跑测试]` plus optional human-readable narrative.
 */
export function parseProgressTag(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null;
  const match = PROGRESS_TAG_RE.exec(rawText);
  if (!match) return null;
  const percent = clampPct(match[1], 0);
  const summary = trimKidSummary(match[2], 10);
  const narrative = rawText
    .replace(PROGRESS_TAG_GLOBAL_RE, '')
    .replace(/^\s*[-—:：·|]+\s*/, '')
    .trim();
  return {
    percent,
    summary,
    narrative,
  };
}

export function stripProgressTags(rawText) {
  if (typeof rawText !== 'string' || !rawText) return '';
  return rawText.replace(PROGRESS_TAG_GLOBAL_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

const MD_LINK_GLOBAL_RE = /!?\[([^\[\]\n]+)\]\(([^()\s\n]+(?:\([^()\s\n]*\)[^()\s\n]*)*)\)/g;
const BARE_FILE_URI_RE = /file:\/\/\/[^\s<>)"']+/gi;
const INLINE_MD_TOKEN_RE = /(`[^`\n]+`|\[[^\[\]\n]+\]\([^()\s\n]+(?:\([^()\s\n]*\)[^()\s\n]*)*\)|\*\*[^*\n]+\*\*|file:\/\/\/[^\s<>)"']+)/g;

function decodeFileBasename(rawUri) {
  let decoded = String(rawUri || '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep original on malformed percent escape
  }
  const clean = decoded.replace(/^file:\/\/\/+/i, '');
  const hashIdx = clean.indexOf('#');
  const filePart = hashIdx >= 0 ? clean.slice(0, hashIdx) : clean;
  const parts = filePart.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || clean;
}

/**
 * Strip Markdown syntax and verbose file:/// URLs into a clean single-line summary
 * suitable for overview collaboration cards, goals, and compact digests.
 */
export function stripMarkdownForPlainLine(rawText) {
  const cleaned = stripProgressTags(rawText);
  if (!cleaned) return '';
  return cleaned
    .replace(/\r\n?/g, '\n')
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(MD_LINK_GLOBAL_RE, (_, label) => String(label || '').replace(/^`(.+)`$/, '$1').replace(/^\*\*(.+)\*\*$/, '$1'))
    .replace(/\[([^\[\]\n]+)\]\(file:\/\/\/[^\s<>)"']*/gi, '$1')
    .replace(BARE_FILE_URI_RE, (uri) => decodeFileBasename(uri))
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/__([^_\n]+?)__/g, '$1')
    .replace(/\*([^*\n]+?)\*/g, '$1')
    .replace(/~~([^~\n]+?)~~/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean timeline Markdown while truncating on visible-text budget and safe token/line boundaries
 * so long percent-encoded file:/// links are never sliced mid-URL.
 */
export function sanitizeTimelineMarkdown(rawText, maxVisible = 3600) {
  const cleaned = stripProgressTags(rawText).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return '';

  const lines = cleaned.split('\n');
  const kept = [];
  let visibleUsed = 0;
  let inFence = false;
  let truncated = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isFenceLine = /^\s*```/.test(line);
    if (isFenceLine) {
      kept.push(line);
      inFence = !inFence;
      continue;
    }

    const lineVisibleLen = inFence ? line.trim().length : stripMarkdownForPlainLine(line).length;
    if (visibleUsed + lineVisibleLen <= maxVisible) {
      kept.push(line);
      visibleUsed += lineVisibleLen + (lineVisibleLen > 0 ? 1 : 0);
      continue;
    }

    // If nothing has been kept yet (single oversized paragraph), trim safely by inline tokens
    if (kept.length === 0 && !inFence) {
      const budget = Math.max(40, maxVisible - 1);
      const parts = line.split(INLINE_MD_TOKEN_RE);
      let acc = '';
      let accVis = 0;
      for (const part of parts) {
        if (!part) continue;
        const isToken =
          (part.startsWith('`') && part.endsWith('`')) ||
          (part.startsWith('[') && part.includes('](') && part.endsWith(')')) ||
          (part.startsWith('**') && part.endsWith('**')) ||
          /^file:\/\/\//i.test(part);
        const visLen = isToken ? stripMarkdownForPlainLine(part).length : part.length;
        if (accVis + visLen <= budget) {
          acc += part;
          accVis += visLen;
        } else {
          if (!isToken && accVis < budget) {
            acc += part.slice(0, Math.max(0, budget - accVis)).trimEnd();
          }
          break;
        }
      }
      if (acc.trim()) kept.push(acc.trimEnd());
    }

    truncated = true;
    break;
  }

  if (!truncated) return cleaned;
  if (inFence) {
    kept.push('```');
  }
  const result = kept.join('\n').trimEnd();
  if (!result) return `${stripMarkdownForPlainLine(cleaned).slice(0, Math.max(40, maxVisible - 1))}…`;
  return result.endsWith('```') ? `${result}\n…` : `${result}…`;
}

function extractUserUploadedImages(raw) {
  if (typeof raw !== 'string' || !raw.includes('ADDITIONAL_METADATA')) return [];
  const metaMatch = /<ADDITIONAL_METADATA>([\s\S]*?)<\/ADDITIONAL_METADATA>/i.exec(raw);
  if (!metaMatch) return [];
  const imgs = [];
  const lines = metaMatch[1].split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*[-*]\s+((?:[a-zA-Z]:[\\/]|\/)[^\r\n]+\.(?:png|jpe?g|webp|gif|bmp|avif|ico))\s*$/i.exec(line);
    if (m && m[1]) {
      imgs.push(m[1].trim());
    }
  }
  return imgs.slice(0, 6);
}

function stripUserRequestTags(raw) {
  if (typeof raw !== 'string') return '';
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(raw);
  const body = (m ? m[1] : raw)
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
    .trim();
  return body.replace(/\s+/g, ' ').slice(0, 260);
}

function shortBasename(filePath) {
  const s = String(filePath || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!s) return '';
  const parts = s.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function countLines(str) {
  if (typeof str !== 'string' || !str) return 0;
  return str.split(/\r?\n/).length;
}

/**
 * Classify a single Antigravity tool call into Codex-style semantic category & readable label.
 */
export function classifyToolCall(tc) {
  const rawName = String(tc?.name || '').trim();
  const name = rawName.toLowerCase();
  const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};

  if (name === 'run_command' || name === 'manage_task' || name === 'schedule') {
    const cmdText = String(args.CommandLine || args.toolSummary || args.Action || rawName).trim();
    const firstLine = cmdText.split(/\r?\n/).find((l) => l.trim()) || cmdText;
    return {
      category: 'cmd',
      categoryLabel: '运行了命令',
      kind: 'cmd',
      text: firstLine.slice(0, 120),
    };
  }

  if (name === 'edit_file' || name === 'write_file' || name === 'replace_file_content' || name === 'multi_replace_file_content') {
    const rawPath = String(args.Path || args.TargetFile || args.path || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    const targetPath = shortBasename(rawPath);
    let addCount = 0;
    let delCount = 0;
    if (name === 'write_file') {
      addCount = countLines(args.Content || '');
    } else if (typeof args.Replacement === 'string' || typeof args.Target === 'string') {
      addCount = countLines(args.Replacement || '');
      delCount = countLines(args.Target || '');
    } else if (typeof args.ReplacementContent === 'string' || typeof args.TargetContent === 'string') {
      addCount = countLines(args.ReplacementContent || '');
      delCount = countLines(args.TargetContent || '');
    } else if (Array.isArray(args.ReplacementChunks)) {
      for (const ch of args.ReplacementChunks) {
        if (!ch || typeof ch !== 'object') continue;
        addCount += countLines(ch.ReplacementContent || '');
        delCount += countLines(ch.TargetContent || '');
      }
    }
    return {
      category: 'edit',
      categoryLabel: '编辑了文件',
      kind: 'edit',
      text: targetPath ? `已编辑 ${targetPath}` : `编辑文件 (${rawName})`,
      ...(rawPath ? { filePath: rawPath } : {}),
      ...(addCount > 0 ? { add: `+${addCount}` } : {}),
      ...(delCount > 0 ? { del: `-${delCount}` } : {}),
    };
  }

  if (
    name === 'read_file' ||
    name === 'view_file' ||
    name === 'list_dir' ||
    name === 'find_by_name' ||
    name === 'grep_search' ||
    name === 'read_resource' ||
    name === 'list_resources'
  ) {
    const rawPath = String(args.Path || args.AbsolutePath || args.DirectoryPath || args.SearchPath || args.Uri || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    const targetPath = shortBasename(rawPath);
    const lineRange =
      args.StartLine && args.EndLine ? ` L${args.StartLine}-${args.EndLine}` : '';
    const query = args.Query || args.Pattern || '';
    let desc = targetPath ? `读取 ${targetPath}${lineRange}` : `查看文件 (${rawName})`;
    if (query) desc = `检索「${String(query).slice(0, 48)}」${targetPath ? ` @ ${targetPath}` : ''}`;
    return {
      category: 'read',
      categoryLabel: '读取了文件',
      kind: 'read',
      text: desc.slice(0, 120),
      ...(rawPath ? { filePath: rawPath } : {}),
    };
  }

  if (name === 'search_web' || name === 'read_url_content' || name === 'search_marketplace') {
    const q = String(args.query || args.Url || (Array.isArray(args.queries) ? args.queries.join(', ') : '') || rawName).trim();
    return {
      category: 'search',
      categoryLabel: '检索了资料',
      kind: 'search',
      text: q.slice(0, 120),
    };
  }

  if (
    name === 'invoke_subagent' ||
    name === 'send_message' ||
    name === 'manage_subagents' ||
    name === 'swarm' ||
    name === 'post_message' ||
    name === 'read_board' ||
    name === 'swarm_wait'
  ) {
    const syncVerbMap = {
      invoke_subagent: '派发子 Agent',
      send_message: '向协作方发消息',
      manage_subagents: '管理子 Agent',
      swarm: '调度蜂群成员',
      post_message: '在协作板发消息',
      read_board: '查看协作板消息',
      swarm_wait: '等待协作消息',
    };
    const verb = syncVerbMap[name] || '协同调度';
    const role = args.Role || args.name || args.Recipient || args.action || '';
    const msg = args.Prompt || args.Message || args.brief || args.text || '';
    const label = role ? `${verb}（${String(role).slice(0, 24)}）` : verb;
    const summary = msg ? `${label}：${String(msg).replace(/\s+/g, ' ').slice(0, 68)}` : label;
    return {
      category: 'sync',
      categoryLabel: '协同了子 Agent',
      kind: 'sync',
      text: summary.slice(0, 120),
    };
  }

  return {
    category: 'tool',
    categoryLabel: '调用了工具',
    kind: 'tool',
    text: rawName || 'tool_call',
  };
}

function buildActionGroupLabel(items) {
  const orderedLabels = [];
  const iconCounts = new Map();
  for (const item of items) {
    if (!orderedLabels.includes(item.categoryLabel)) {
      orderedLabels.push(item.categoryLabel);
    }
    iconCounts.set(item.category, (iconCounts.get(item.category) || 0) + 1);
  }
  const label = orderedLabels.slice(0, 2).join(' · ') || '执行了操作';
  let icon = 'cmd';
  if (iconCounts.has('edit')) icon = 'edit';
  else if (iconCounts.has('cmd')) icon = 'cmd';
  else if (iconCounts.has('read')) icon = 'read';
  else if (iconCounts.has('search')) icon = 'search';
  else if (iconCounts.has('sync')) icon = 'sync';
  return { label, icon };
}

function deriveHeuristicStatus(latestCategories, isCompleted, isSleep) {
  if (isCompleted) return '任务结束未读';
  if (isSleep) return '休眠待命';
  if (latestCategories.includes('edit')) return '改代码中';
  if (latestCategories.includes('cmd')) return '跑命令校验';
  if (latestCategories.includes('sync')) return '协同调度中';
  if (latestCategories.includes('search')) return '查资料中';
  if (latestCategories.includes('read')) return '读代码排查';
  return '思考推进中';
}

function deriveHeuristicProgress(turnPlannerSteps, hasEdit, hasCmdAfterEdit, isCompleted, isSleep) {
  if (isCompleted) return 100;
  if (turnPlannerSteps <= 0) return isSleep ? 0 : 8;
  if (hasEdit && hasCmdAfterEdit) return Math.min(92, 68 + turnPlannerSteps * 3);
  if (hasEdit) return Math.min(78, 42 + turnPlannerSteps * 4);
  return Math.min(55, 14 + turnPlannerSteps * 6);
}

async function readTailLines(filePath, maxBytes = MAX_TRANSCRIPT_TAIL_BYTES) {
  let fh = null;
  try {
    fh = await fsp.open(filePath, 'r');
    const st = await fh.stat();
    const size = st.size;
    if (size <= 0) return [];
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function readJsonFileSafe(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Parse a single agent's transcript.jsonl into Codex-style timeline steps + progress telemetry.
 */
export async function parseAgentJourney(
  brainDir,
  convId,
  {
    isMaster = true,
    isCompleted = false,
    isSleep = false,
    fallbackBrief = '',
    nowMs = Date.now(),
    externalSummary = null,
  } = {},
) {
  const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
  const lines = await readTailLines(transcriptPath);

  const parsedEntries = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') parsedEntries.push(obj);
    } catch {
      // skip incomplete trailing line
    }
  }

  // Locate current task run boundary while keeping prior turns & mid-run supplements in the timeline.
  // A USER_INPUT arriving after a PLANNER_RESPONSE that called tools is treated as a mid-run
  // supplement belonging to the active run so elapsed time & progress don't reset.
  let currentRunStartIdx = 0;
  let currentRunBrief = fallbackBrief || '';
  let latestUserBrief = '';
  const followupIndices = new Set();
  let lastPlannerHadTools = false;
  let seenAnyUser = false;

  for (let i = 0; i < parsedEntries.length; i += 1) {
    const entry = parsedEntries[i];
    if (entry.type === 'USER_INPUT' && entry.content) {
      const text = stripUserRequestTags(entry.content);
      if (!text) continue;
      latestUserBrief = text;
      if (isMaster) {
        if (seenAnyUser && lastPlannerHadTools) {
          followupIndices.add(i);
        } else {
          currentRunStartIdx = i;
          currentRunBrief = text;
        }
      } else if (!seenAnyUser) {
        currentRunStartIdx = i;
        currentRunBrief = text;
      } else {
        followupIndices.add(i);
      }
      seenAnyUser = true;
    } else if (entry.type === 'PLANNER_RESPONSE') {
      lastPlannerHadTools = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
    }
  }

  const brief = currentRunBrief || latestUserBrief || fallbackBrief || '';
  const timelineStartIdx = Math.min(currentRunStartIdx, Math.max(0, parsedEntries.length - 200));

  let turnStartMs = 0;
  let lastStepMs = 0;
  let latestTag = null;
  let openingThought = '';
  let turnPlannerSteps = 0;
  let hasEdit = false;
  let hasCmdAfterEdit = false;
  let latestCategories = [];
  let lastStepIndex = 0;
  let latestModel = '';

  const steps = [];
  let pendingActions = [];
  let pendingActionsStartStep = 0;
  let actionGroupSeq = 0;
  let currentRunStepStartIdx = 0;

  const flushActions = () => {
    if (pendingActions.length === 0) return;
    actionGroupSeq += 1;
    const { label, icon } = buildActionGroupLabel(pendingActions);
    steps.push({
      type: 'actions',
      id: `act-${pendingActionsStartStep}-${actionGroupSeq}`,
      icon,
      label,
      defaultOpen: false,
      items: pendingActions.map(({ kind, text, filePath, add, del }) => ({
        kind,
        text,
        ...(filePath ? { filePath } : {}),
        ...(add ? { add } : {}),
        ...(del ? { del } : {}),
      })),
    });
    pendingActions = [];
    pendingActionsStartStep = 0;
  };

  for (let i = timelineStartIdx; i < parsedEntries.length; i += 1) {
    const entry = parsedEntries[i];
    const inCurrentRun = i >= currentRunStartIdx;
    const ts = parseTsMs(entry.created_at);
    if (ts > 0) {
      if (inCurrentRun && !turnStartMs) turnStartMs = ts;
      if (ts > lastStepMs) lastStepMs = ts;
    }
    if (Number.isFinite(Number(entry.step_index))) {
      lastStepIndex = Math.max(lastStepIndex, Number(entry.step_index));
    }

    if (entry.type === 'USER_INPUT' && entry.content) {
      const userText = stripUserRequestTags(entry.content);
      const userImages = extractUserUploadedImages(entry.content);
      if (!userText && userImages.length === 0) continue;
      flushActions();
      const isFollowup = followupIndices.has(i);
      steps.push({
        type: 'user',
        text: userText,
        ...(userImages.length > 0 ? { images: userImages } : {}),
        isFollowup,
        label: isMaster ? (isFollowup ? '用户补充' : '用户布置任务') : '来自「主 Agent」派单',
        stepIndex: Number(entry.step_index || i),
      });
      if (i === currentRunStartIdx) {
        currentRunStepStartIdx = steps.length;
      }
      continue;
    }

    if (entry.type !== 'PLANNER_RESPONSE') continue;
    if (inCurrentRun) {
      turnPlannerSteps += 1;
    }
    if (typeof entry.model === 'string' && entry.model.trim()) {
      latestModel = entry.model.trim();
    }

    const rawContent = typeof entry.content === 'string' ? entry.content.trim() : '';

    // Parse [AGY_PROGRESS|pct%|summary] strictly from visible content (never leak private thinking prose)
    const tag = parseProgressTag(rawContent);

    if (tag) {
      if (inCurrentRun) {
        latestTag = tag;
        if (!openingThought && tag.narrative) {
          openingThought = stripMarkdownForPlainLine(tag.narrative).slice(0, 120);
        }
      }
      flushActions();
      const narrativeText = tag.narrative ? sanitizeTimelineMarkdown(tag.narrative) : '';
      steps.push({
        type: 'msg',
        text: narrativeText,
        progressPct: tag.percent,
        statusTag: tag.summary || '推进中',
      });
    } else if (rawContent) {
      flushActions();
      const formatted = sanitizeTimelineMarkdown(rawContent);
      if (formatted) {
        steps.push({
          type: 'msg',
          text: formatted,
        });
      }
    }

    const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
    if (toolCalls.length > 0) {
      if (pendingActions.length === 0) {
        pendingActionsStartStep = Number(entry.step_index || i);
      }
      if (inCurrentRun) {
        latestCategories = [];
      }
      for (const tc of toolCalls) {
        const classified = classifyToolCall(tc);
        if (inCurrentRun) {
          latestCategories.push(classified.category);
          if (classified.category === 'edit') hasEdit = true;
          if (classified.category === 'cmd' && hasEdit) hasCmdAfterEdit = true;
        }
        pendingActions.push(classified);
      }
    }
  }

  flushActions();

  // Merge third-party summary if available and newer/richer than local heuristics
  const ext = externalSummary && typeof externalSummary === 'object' ? externalSummary : null;
  if (ext?.openingThought && !openingThought) {
    openingThought = stripMarkdownForPlainLine(ext.openingThought).slice(0, 140);
    const openingStep = {
      type: 'msg',
      text: openingThought,
      isOpening: true,
    };
    const insertAt = Math.min(steps.length, Math.max(0, currentRunStepStartIdx));
    steps.splice(insertAt, 0, openingStep);
  }
  if (ext?.stageReport && !latestTag) {
    const report = sanitizeTimelineMarkdown(ext.stageReport, 360);
    if (report && !steps.some((s) => s.type === 'msg' && s.text === report)) {
      steps.push({
        type: 'msg',
        text: report,
      });
    }
  }

  // Keep all Codex action groups collapsed by default until the user manually clicks to expand.

  // Compute concise <=10 char kid-friendly status & progress %
  const extStatus = ext?.status ? trimKidSummary(ext.status, 10) : '';
  const tagStatus = latestTag?.summary ? trimKidSummary(latestTag.summary, 10) : '';
  const heuristicStatus = deriveHeuristicStatus(latestCategories, isCompleted, isSleep);
  const shortStatus = isCompleted
    ? '结束未读'
    : tagStatus || extStatus || heuristicStatus;

  const heuristicPct = deriveHeuristicProgress(
    turnPlannerSteps,
    hasEdit,
    hasCmdAfterEdit,
    isCompleted,
    isSleep,
  );
  let progress = heuristicPct;
  if (isCompleted) {
    progress = 100;
  } else if (latestTag && Number.isFinite(latestTag.percent)) {
    progress = latestTag.percent;
  } else if (ext && Number.isFinite(Number(ext.percent))) {
    progress = clampPct(ext.percent, heuristicPct);
  }

  // Build concise Chinese-first plain-text task line for collaboration card
  const lastActionGroup = [...steps].reverse().find((s) => s.type === 'actions');
  const lastMsg = [...steps].reverse().find((s) => s.type === 'msg');
  let rawTaskLine = '';
  if (latestTag?.narrative) {
    rawTaskLine = stripMarkdownForPlainLine(latestTag.narrative).slice(0, 88);
  } else if (ext?.stageReport) {
    rawTaskLine = stripMarkdownForPlainLine(ext.stageReport).slice(0, 88);
  } else if (openingThought) {
    rawTaskLine = stripMarkdownForPlainLine(openingThought).slice(0, 88);
  } else if (isCompleted && lastMsg) {
    rawTaskLine = stripMarkdownForPlainLine(lastMsg.text).slice(0, 88);
  } else if (lastActionGroup && lastActionGroup.items.length > 0) {
    const lastItem = lastActionGroup.items[lastActionGroup.items.length - 1];
    rawTaskLine = `${lastActionGroup.label}：${lastItem.text}`.slice(0, 88);
  } else if (lastMsg) {
    rawTaskLine = stripMarkdownForPlainLine(lastMsg.text).slice(0, 88);
  } else if (brief) {
    rawTaskLine = stripMarkdownForPlainLine(brief).slice(0, 88);
  } else {
    rawTaskLine = isSleep ? '当前休眠待命' : '正在推进当前任务';
  }

  let taskLine = rawTaskLine;
  if (taskLine && !/[\u4e00-\u9fff]/.test(taskLine)) {
    if (isCompleted) {
      if (/image|wallpaper|png|jpg|webp/i.test(taskLine)) {
        taskLine = '已完成图片生成，结果已回传主 Agent';
      } else if (/verif|check|test|audit|pass/i.test(taskLine)) {
        taskLine = '已完成核验，结果已回传主 Agent';
      } else if (lastActionGroup?.label) {
        taskLine = `已完成（${lastActionGroup.label}），结果已回传主 Agent`;
      } else {
        taskLine = '子任务已完成，结果已回传主 Agent';
      }
    } else if (isSleep) {
      taskLine = '当前休眠待命';
    } else if (lastActionGroup?.label) {
      taskLine = `正在执行：${lastActionGroup.label}`;
    } else {
      taskLine = '正在推进当前任务';
    }
  }

  const elapsedMs = turnStartMs > 0 ? Math.max(1000, (isCompleted && lastStepMs > turnStartMs ? lastStepMs : nowMs) - turnStartMs) : 0;
  const durationPrefix = isSleep ? '已休眠 ' : '用时 ';
  const duration = elapsedMs > 0 ? `${durationPrefix}${formatDurationZh(elapsedMs)}` : '刚启动';

  const foot = isCompleted
    ? '本角色任务已全部完成 · 等待你查收'
    : isSleep
      ? '当前处于休眠状态 · 等待唤醒后继续执行'
      : `正在执行中 · ${shortStatus}`;

  return {
    brief: brief || '当前会话任务',
    openingThought,
    shortStatus,
    progress,
    taskLine,
    duration,
    steps: steps.slice(-64),
    foot,
    stepCount: lastStepIndex || turnPlannerSteps,
    turnPlannerSteps,
    lastStepMs,
    latestModel,
    hasExplicitTag: Boolean(latestTag),
    recentDigest: buildCompactDigest(brief, steps),
  };
}

function buildCompactDigest(brief, steps) {
  const recent = steps.slice(-6).map((s) => {
    if (s.type === 'user') return `[${s.label || '用户'}] ${stripMarkdownForPlainLine(s.text).slice(0, 120)}`;
    if (s.type === 'msg') return `[汇报] ${stripMarkdownForPlainLine(s.text).slice(0, 140)}`;
    const sample = (s.items || []).slice(-3).map((it) => it.text).join('; ');
    return `[${s.label}] ${sample.slice(0, 160)}`;
  });
  return `任务：${stripMarkdownForPlainLine(brief).slice(0, 160)}\n最近步骤：\n${recent.join('\n')}`;
}

async function discoverSubagentsAndSwarm(brainDir, convId, parentIsRunning, subStatusById = {}) {
  const sysDir = path.join(brainDir, convId, '.system_generated');
  const swarmDir = path.join(sysDir, 'swarm');
  const subDir = path.join(sysDir, 'subagents');
  const msgDir = path.join(sysDir, 'messages');

  const subsByConv = new Map();
  const rosterNameToId = new Map();
  let swarmTitle = '';

  const resolveDbSubState = (subConvId) => {
    const dbSub = subStatusById && typeof subStatusById === 'object' ? subStatusById[subConvId] : null;
    if (!dbSub || typeof dbSub !== 'object') return null;
    if (dbSub.killed) return 'killed';
    if (dbSub.status === 'CASCADE_RUN_STATUS_RUNNING' || dbSub.notFullyIdle) return 'running';
    if (dbSub.status === 'CASCADE_RUN_STATUS_IDLE') return 'idle';
    return null;
  };

  // 1. Read swarm/members.json if present
  const membersDoc = await readJsonFileSafe(path.join(swarmDir, 'members.json'));
  if (membersDoc && typeof membersDoc === 'object') {
    if (typeof membersDoc.title === 'string') swarmTitle = membersDoc.title.trim();
    const members = membersDoc.members && typeof membersDoc.members === 'object' ? membersDoc.members : {};
    for (const [rosterName, info] of Object.entries(members)) {
      if (!info || typeof info !== 'object') continue;
      if (info.role === 'coordinator' || info.conversation_id === convId) {
        rosterNameToId.set(rosterName.toLowerCase(), 'coord');
        continue;
      }
      const subConvId = String(info.conversation_id || '').trim();
      if (!subConvId) continue;
      const nodeId = `sub-${subConvId}`;
      rosterNameToId.set(rosterName.toLowerCase(), nodeId);

      const phase = String(info.phase || info.desired_state || '').toUpperCase();
      const dbState = resolveDbSubState(subConvId);
      let stateKind = 'sleep';
      let authoritativeState = Boolean(dbState);
      if (info.killed || dbState === 'killed' || phase === 'STOPPED' || phase === 'DONE' || phase === 'COMPLETED') {
        stateKind = 'unread';
      } else if (dbState === 'running') {
        stateKind = 'running';
      } else if (dbState === 'idle') {
        stateKind = parentIsRunning ? 'sleep' : 'unread';
      } else if (parentIsRunning && (phase === 'RUNNING' || phase === 'WORKING')) {
        stateKind = 'running';
      } else if (!parentIsRunning) {
        stateKind = 'unread';
      }

      subsByConv.set(subConvId, {
        id: nodeId,
        convId: subConvId,
        rosterName,
        name: rosterName,
        typeName: 'worker',
        stateKind,
        authoritativeState,
        model: String(info.applied_model || info.model || ''),
        spawnStep: 0,
      });
    }
  }

  // 2. Read subagents/*.json
  try {
    const entries = await fsp.readdir(subDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      const doc = await readJsonFileSafe(path.join(subDir, ent.name));
      if (!doc || !doc.conversationId) continue;
      const subConvId = String(doc.conversationId).trim();
      const desc = doc.subagentDescriptor && typeof doc.subagentDescriptor === 'object' ? doc.subagentDescriptor : {};
      const roleTitle = String(desc.role || desc.typeName || subConvId.slice(0, 8)).trim();
      const rawState = String(doc.state || '').toUpperCase();
      const dbState = resolveDbSubState(subConvId);

      const existing = subsByConv.get(subConvId);
      if (existing) {
        if (roleTitle && !roleTitle.startsWith('Swarm Worker')) {
          existing.name = roleTitle;
        }
        existing.spawnStep = Number(doc.spawnStepIndex || existing.spawnStep || 0);
        if (dbState === 'running') {
          existing.stateKind = 'running';
          existing.authoritativeState = true;
        } else if (dbState === 'killed' || rawState.includes('KILLED') || rawState.includes('DONE') || rawState.includes('COMPLETED')) {
          existing.stateKind = 'unread';
        }
        continue;
      }

      let stateKind = 'sleep';
      const authoritativeState = Boolean(dbState);
      if (dbState === 'killed' || rawState.includes('DONE') || rawState.includes('COMPLETED') || rawState.includes('KILLED')) {
        stateKind = 'unread';
      } else if (dbState === 'running') {
        stateKind = 'running';
      } else if (dbState === 'idle') {
        stateKind = parentIsRunning ? 'sleep' : 'unread';
      } else if (!parentIsRunning) {
        stateKind = 'unread';
      } else if (rawState.includes('RUNNING') || rawState.includes('WORKING')) {
        stateKind = 'running';
      }

      const nodeId = `sub-${subConvId}`;
      subsByConv.set(subConvId, {
        id: nodeId,
        convId: subConvId,
        rosterName: desc.typeName || '',
        name: roleTitle,
        typeName: String(desc.typeName || 'subagent'),
        stateKind,
        authoritativeState,
        model: '',
        spawnStep: Number(doc.spawnStepIndex || 0),
      });
    }
  } catch {
    // No subagents directory
  }

  // 3. Read swarm/board.jsonl for peer-to-peer collaboration edges (@mentions)
  const peerEdgeSet = new Set();
  const peerEdges = [];
  try {
    const boardRaw = await fsp.readFile(path.join(swarmDir, 'board.jsonl'), 'utf8');
    const boardLines = boardRaw.split(/\r?\n/).filter(Boolean).slice(-200);
    for (const line of boardLines) {
      try {
        const msg = JSON.parse(line);
        const sender = String(msg.agent || '').toLowerCase();
        const fromId = rosterNameToId.get(sender);
        if (!fromId || fromId === 'coord') continue;
        const text = String(msg.text || '');
        for (const m of text.matchAll(/@([a-zA-Z0-9_-]+)/g)) {
          const targetId = rosterNameToId.get(m[1].toLowerCase());
          if (targetId && targetId !== 'coord' && targetId !== fromId) {
            const key = [fromId, targetId].sort().join('::');
            if (!peerEdgeSet.has(key)) {
              peerEdgeSet.add(key);
              peerEdges.push({
                type: 'peer',
                from: fromId,
                to: targetId,
                live: parentIsRunning,
                lane: peerEdges.length % 3,
              });
            }
          }
        }
      } catch {
        // skip malformed board line
      }
    }
  } catch {
    // No swarm board
  }

  // 4. Also check direct messages/*.json for sub-to-sub traffic
  try {
    const msgFiles = (await fsp.readdir(msgDir)).filter((f) => f.endsWith('.json')).slice(-80);
    const convToNodeId = new Map();
    for (const sub of subsByConv.values()) {
      convToNodeId.set(sub.convId, sub.id);
    }
    for (const mf of msgFiles) {
      const mdoc = await readJsonFileSafe(path.join(msgDir, mf));
      if (!mdoc) continue;
      const fromId = convToNodeId.get(String(mdoc.sender || ''));
      const toId = convToNodeId.get(String(mdoc.recipient || ''));
      if (fromId && toId && fromId !== toId) {
        const key = [fromId, toId].sort().join('::');
        if (!peerEdgeSet.has(key)) {
          peerEdgeSet.add(key);
          peerEdges.push({
            type: 'peer',
            from: fromId,
            to: toId,
            live: parentIsRunning,
            lane: peerEdges.length % 3,
          });
        }
      }
    }
  } catch {
    // No messages directory
  }

  const subs = [...subsByConv.values()]
    .sort((a, b) => (b.spawnStep || 0) - (a.spawnStep || 0))
    .slice(0, 8);

  return { subs, peerEdges, swarmTitle };
}

async function countActiveSubagentsQuick(brainDir, convId, parentIsRunning, subStatusById = {}) {
  if (!parentIsRunning) return 0;
  const sysDir = path.join(brainDir, convId, '.system_generated');
  let activeCount = 0;

  const isDbRunning = (cid) => {
    const row = subStatusById && typeof subStatusById === 'object' ? subStatusById[cid] : null;
    if (!row || row.killed) return null;
    return Boolean(row.status === 'CASCADE_RUN_STATUS_RUNNING' || row.notFullyIdle);
  };

  const membersDoc = await readJsonFileSafe(path.join(sysDir, 'swarm', 'members.json'));
  const seen = new Set();
  if (membersDoc?.members && typeof membersDoc.members === 'object') {
    for (const info of Object.values(membersDoc.members)) {
      if (!info || info.role === 'coordinator' || info.conversation_id === convId) continue;
      const cid = String(info.conversation_id || '').trim();
      if (cid) seen.add(cid);
      const dbRun = cid ? isDbRunning(cid) : null;
      if (dbRun !== null) {
        if (dbRun && !info.killed) activeCount += 1;
        continue;
      }
      const phase = String(info.phase || info.desired_state || '').toUpperCase();
      if (!info.killed && (phase === 'RUNNING' || phase === 'WORKING')) {
        activeCount += 1;
      }
    }
  }

  try {
    const files = await fsp.readdir(path.join(sysDir, 'subagents'));
    for (const fn of files) {
      if (!fn.endsWith('.json')) continue;
      const doc = await readJsonFileSafe(path.join(sysDir, 'subagents', fn));
      const cid = String(doc?.conversationId || '').trim();
      if (!cid || seen.has(cid)) continue;
      const dbRun = isDbRunning(cid);
      if (dbRun !== null) {
        if (dbRun) activeCount += 1;
        continue;
      }
      const st = String(doc.state || '').toUpperCase();
      if (st.includes('RUNNING') || st.includes('WORKING')) {
        activeCount += 1;
      }
    }
  } catch {
    // No subagents dir
  }
  return activeCount;
}

/**
 * Build complete Mastery snapshot for `/api/mastery`.
 */
export async function buildMasterySnapshot(
  paths,
  sessionsHub,
  {
    selectedSessionId = '',
    sessionsMeta = null,
    summariesCache = {},
    nowMs = Date.now(),
  } = {},
) {
  const brainDir = paths.brainDir;
  const subStatusById =
    sessionsHub?.subStatusById && typeof sessionsHub.subStatusById === 'object'
      ? sessionsHub.subStatusById
      : {};
  const lastSeenByConv =
    sessionsMeta?.lastSeenByConv && typeof sessionsMeta.lastSeenByConv === 'object'
      ? sessionsMeta.lastSeenByConv
      : sessionsMeta?.lastSeenModifiedMs && typeof sessionsMeta.lastSeenModifiedMs === 'object'
        ? sessionsMeta.lastSeenModifiedMs
        : {};
  const lastSeenByAgent =
    sessionsMeta?.lastSeenByAgent && typeof sessionsMeta.lastSeenByAgent === 'object'
      ? sessionsMeta.lastSeenByAgent
      : {};

  const rawFavoriteIds = Array.isArray(sessionsMeta?.favoriteIds)
    ? sessionsMeta.favoriteIds
    : Array.isArray(sessionsHub?.favorites)
      ? sessionsHub.favorites.map((f) => f?.id)
      : [];
  const favoriteIds = [...new Set(rawFavoriteIds.map((x) => String(x || '').trim()).filter(Boolean))];
  const favoriteIdSet = new Set(favoriteIds);

  const activeRaw = [
    ...(Array.isArray(sessionsHub?.active) ? sessionsHub.active : []),
    ...(Array.isArray(sessionsHub?.waiting) ? sessionsHub.waiting : []),
  ];
  const unreadRaw = Array.isArray(sessionsHub?.unread) ? sessionsHub.unread : [];
  const recentRaw = Array.isArray(sessionsHub?.recent) ? sessionsHub.recent : [];
  const favoritesRaw = Array.isArray(sessionsHub?.favorites) ? sessionsHub.favorites : [];
  const selectableRaw = Array.isArray(sessionsHub?.allSelectable) ? sessionsHub.allSelectable : [];

  const knownById = new Map();
  const mergeKnown = (arr) => {
    for (const item of arr) {
      if (!item?.id) continue;
      const prev = knownById.get(item.id);
      if (!prev) {
        knownById.set(item.id, { ...item });
      } else {
        const shortFallback = item.id.slice(0, 8);
        knownById.set(item.id, {
          ...prev,
          ...item,
          title: item.title && item.title !== shortFallback ? item.title : prev.title || item.title,
          workspace: item.workspace || prev.workspace,
          agoText: item.agoText || prev.agoText,
          modifiedMs: Math.max(Number(prev.modifiedMs || 0), Number(item.modifiedMs || 0)),
        });
      }
    }
  };
  mergeKnown(selectableRaw);
  mergeKnown(recentRaw);
  mergeKnown(favoritesRaw);
  mergeKnown(unreadRaw);
  mergeKnown(activeRaw);

  const seenIds = new Set();
  const activeList = [];
  const activeById = new Map();
  for (const s of activeRaw) {
    if (!s?.id || seenIds.has(s.id)) continue;
    seenIds.add(s.id);
    const entry = {
      ...knownById.get(s.id),
      ...s,
      masteryStatus: 'active',
      sessionIsRead: false,
      isFavorite: favoriteIdSet.has(s.id),
    };
    activeList.push(entry);
    activeById.set(s.id, entry);
  }
  activeList.sort((a, b) => (b.modifiedMs || 0) - (a.modifiedMs || 0));

  const unreadList = [];
  const unreadById = new Map();
  for (const s of unreadRaw) {
    if (!s?.id || seenIds.has(s.id)) continue;
    seenIds.add(s.id);
    const entry = {
      ...knownById.get(s.id),
      ...s,
      masteryStatus: 'unread',
      sessionIsRead: false,
      isFavorite: favoriteIdSet.has(s.id),
    };
    unreadList.push(entry);
    unreadById.set(s.id, entry);
  }
  unreadList.sort((a, b) => (b.modifiedMs || 0) - (a.modifiedMs || 0));

  // Always pin favorited sessions at the very top in saved favoriteIds order
  const pinnedList = [];
  const pinnedIdSet = new Set();
  for (const favId of favoriteIds) {
    if (pinnedIdSet.has(favId)) continue;
    if (activeById.has(favId)) {
      pinnedIdSet.add(favId);
      pinnedList.push({ ...activeById.get(favId), isFavorite: true });
    } else if (unreadById.has(favId)) {
      pinnedIdSet.add(favId);
      pinnedList.push({ ...unreadById.get(favId), isFavorite: true });
    } else if (knownById.has(favId)) {
      pinnedIdSet.add(favId);
      pinnedList.push({
        ...knownById.get(favId),
        masteryStatus: 'unread',
        isRecentFallback: false,
        sessionIsRead: true,
        isFavorite: true,
      });
    }
  }

  const nonPinnedActive = activeList.filter((s) => !pinnedIdSet.has(s.id));
  const nonPinnedUnread = unreadList.filter((s) => !pinnedIdSet.has(s.id));
  let nonPinnedList = [...nonPinnedActive, ...nonPinnedUnread];
  let isFallbackRecent = false;

  if (activeList.length === 0 && unreadList.length === 0) {
    const recentCap = pinnedList.length > 0 ? Math.max(3, 6 - pinnedList.length) : 6;
    const recentSeen = new Set(pinnedIdSet);
    for (const s of recentRaw) {
      if (nonPinnedList.length >= recentCap) break;
      if (!s?.id || recentSeen.has(s.id)) continue;
      recentSeen.add(s.id);
      nonPinnedList.push({
        ...s,
        masteryStatus: 'unread',
        isRecentFallback: true,
        sessionIsRead: true,
        isFavorite: false,
      });
    }
    isFallbackRecent = pinnedList.length === 0 && nonPinnedList.length > 0;
  } else {
    const nonPinnedCap = Math.max(8, 12 - pinnedList.length);
    nonPinnedList = nonPinnedList.slice(0, nonPinnedCap);
  }

  let candidateList = [...pinnedList, ...nonPinnedList];
  // Keep currently viewed session visible right after the user marks it read or unstars it
  if (selectedSessionId && !candidateList.some((c) => c.id === selectedSessionId)) {
    const justRead = knownById.get(selectedSessionId) || recentRaw.find((r) => r && r.id === selectedSessionId);
    if (justRead) {
      const nonPinnedCap = Math.max(8, 12 - pinnedList.length);
      if (nonPinnedList.length >= nonPinnedCap && candidateList.length > pinnedList.length) {
        candidateList.pop();
      }
      candidateList.push({
        ...justRead,
        masteryStatus: 'unread',
        isRecentFallback: false,
        sessionIsRead: true,
        isFavorite: favoriteIdSet.has(selectedSessionId),
      });
    }
  }

  const effectiveSelectedId =
    candidateList.some((s) => s.id === selectedSessionId)
      ? selectedSessionId
      : candidateList[0]?.id || '';

  const sessions = [];
  let detailSession = null;

  for (const s of candidateList) {
    const isActive = s.masteryStatus === 'active';
    const isSelected = s.id === effectiveSelectedId;
    const extMaster = summariesCache?.[`${s.id}:coord`] || summariesCache?.[s.id] || null;
    const convSeenMs = Number(lastSeenByConv[s.id] || 0);
    const agentSeenMs = Number(lastSeenByAgent[s.id] || 0);
    const sessionMarkedRead =
      !isActive &&
      (Boolean(s.sessionIsRead) ||
        (convSeenMs > 0 && convSeenMs >= Number(s.modifiedMs || 0)) ||
        (agentSeenMs > 0 && agentSeenMs >= Number(s.modifiedMs || 0)));

    if (isSelected) {
      const masterJourney = await parseAgentJourney(brainDir, s.id, {
        isMaster: true,
        isCompleted: !isActive,
        isSleep: false,
        fallbackBrief: s.title,
        nowMs,
        externalSummary: extMaster,
      });

      const { subs: rawSubs, peerEdges, swarmTitle } = await discoverSubagentsAndSwarm(
        brainDir,
        s.id,
        isActive,
        subStatusById,
      );

      const hydratedSubs = [];
      let runningSubCount = 0;
      let sleepSubCount = 0;
      let unreadSubCount = 0;
      let doneSubCount = 0;
      let hasRunningSwarmWorker = false;

      for (const rawSub of rawSubs) {
        const subCompleted = rawSub.stateKind === 'unread';
        const subSleep = rawSub.stateKind === 'sleep';
        const extSub = summariesCache?.[`${s.id}:${rawSub.convId}`] || summariesCache?.[rawSub.convId] || null;

        const subJourney = await parseAgentJourney(brainDir, rawSub.convId, {
          isMaster: false,
          isCompleted: subCompleted,
          isSleep: subSleep,
          fallbackBrief: rawSub.name,
          nowMs,
          externalSummary: extSub,
        });

        // Only apply heuristic recency demotion when authoritative DB status is absent
        let finalStateKind = rawSub.stateKind;
        if (isActive && finalStateKind === 'running' && !rawSub.authoritativeState && subJourney.lastStepMs > 0) {
          const idleMs = nowMs - subJourney.lastStepMs;
          if (idleMs > 90_000 && subJourney.turnPlannerSteps > 0) {
            finalStateKind = 'sleep';
          }
        }

        const subSeenMs = Number(lastSeenByAgent[rawSub.convId] || 0);
        const subIsRead =
          finalStateKind === 'unread' &&
          (sessionMarkedRead || (subSeenMs > 0 && subSeenMs >= Number(subJourney.lastStepMs || 0)));
        if (subIsRead) {
          finalStateKind = 'done';
        }

        if (finalStateKind === 'running') {
          runningSubCount += 1;
          if (rawSub.typeName === 'worker') hasRunningSwarmWorker = true;
        } else if (finalStateKind === 'sleep') {
          sleepSubCount += 1;
        } else if (finalStateKind === 'done') {
          doneSubCount += 1;
        } else {
          unreadSubCount += 1;
        }

        const stateLabel =
          finalStateKind === 'running'
            ? `运行中 · ${subJourney.shortStatus}`
            : finalStateKind === 'sleep'
              ? '休眠 · 待命'
              : finalStateKind === 'done'
                ? '任务结束'
                : '任务结束未读';

        const subFoot = subIsRead
          ? '本角色任务已结束 · 你已查阅'
          : finalStateKind === 'sleep'
            ? '当前休眠待命中 · 等待主 Agent 或协作消息唤醒'
            : subJourney.foot;

        hydratedSubs.push({
          id: rawSub.id,
          convId: rawSub.convId,
          name: rawSub.name,
          stateKind: finalStateKind,
          stateLabel,
          isRead: subIsRead,
          progress: finalStateKind === 'unread' || finalStateKind === 'done' ? 100 : subJourney.progress,
          task: subJourney.taskLine,
          stepCount: subJourney.stepCount,
          recentDigest: subJourney.recentDigest,
          journey: {
            briefFrom: '来自「主 Agent」派单',
            brief: subJourney.brief,
            duration: subJourney.duration,
            steps: subJourney.steps,
            foot: subFoot,
          },
        });
      }

      // Main Agent progress is the single source of truth for session total progress
      const masterSeenMs = Number(lastSeenByAgent[s.id] || 0);
      const masterIsRead =
        !isActive &&
        (sessionMarkedRead || (masterSeenMs > 0 && masterSeenMs >= Number(masterJourney.lastStepMs || 0)));

      const masterProgress = isActive ? masterJourney.progress : 100;
      const masterStateKind = isActive ? 'running' : masterIsRead ? 'done' : 'unread';
      const masterStateLabel = isActive
        ? `运行中 · ${masterJourney.shortStatus}`
        : masterIsRead
          ? '任务结束'
          : '任务结束未读';

      const busEdges = hydratedSubs.map((sub) => ({
        type: 'bus',
        from: 'coord',
        to: sub.id,
        dir: sub.stateKind === 'unread' || sub.stateKind === 'done' ? 'to-master' : 'to-sub',
        live: sub.stateKind === 'running',
      }));

      const summaryParts = [];
      if (masterJourney.stepCount > 0) {
        summaryParts.push(`主 Agent 第 ${masterJourney.stepCount} 步`);
      }
      if (hydratedSubs.length > 0) {
        if (runningSubCount > 0) summaryParts.push(`${runningSubCount} 运行中`);
        if (sleepSubCount > 0) summaryParts.push(`${sleepSubCount} 休眠`);
        if (unreadSubCount > 0) summaryParts.push(`${unreadSubCount} 结束未读`);
        if (doneSubCount > 0) summaryParts.push(`${doneSubCount} 任务结束`);
      } else {
        summaryParts.push(isActive ? '单 Agent 运行中' : masterIsRead ? '任务结束' : '任务结束未读');
      }

      const rowStatus = isActive ? 'active' : masterIsRead ? 'done' : 'unread';
      const rowEntry = {
        id: s.id,
        project: s.workspace || '全局',
        name: s.title || s.id.slice(0, 8),
        status: rowStatus,
        isRead: masterIsRead,
        isFavorite: Boolean(s.isFavorite),
        isRecentFallback: Boolean(s.isRecentFallback),
        modifiedMs: Number(s.modifiedMs || 0),
        tag: isActive ? masterJourney.shortStatus : masterIsRead ? '任务结束' : '结束未读',
        subAgentCount: runningSubCount,
        progress: masterProgress,
        timeLabel: s.agoText || '',
      };
      sessions.push(rowEntry);

      const goalSource = hasRunningSwarmWorker
        ? swarmTitle || masterJourney.openingThought || masterJourney.brief || rowEntry.name
        : masterJourney.openingThought || masterJourney.brief || rowEntry.name;

      detailSession = {
        ...rowEntry,
        goal: stripMarkdownForPlainLine(goalSource).slice(0, 140),
        summaryText: summaryParts.join(' · '),
        master: {
          id: 'coord',
          convId: s.id,
          name: '主 Agent',
          stateKind: masterStateKind,
          stateLabel: masterStateLabel,
          isRead: masterIsRead,
          progress: masterProgress,
          task: masterJourney.taskLine,
          stepCount: masterJourney.stepCount,
          recentDigest: masterJourney.recentDigest,
          journey: {
            briefFrom: '用户布置任务',
            brief: masterJourney.brief,
            duration: masterJourney.duration,
            steps: masterJourney.steps,
            foot: masterIsRead ? '本角色任务已结束 · 你已查阅' : masterJourney.foot,
          },
        },
        subs: hydratedSubs,
        edges: [...busEdges, ...peerEdges],
      };
    } else {
      // Lightweight list item hydration for non-selected sessions
      const [quickSubCount, quickJourney] = await Promise.all([
        countActiveSubagentsQuick(brainDir, s.id, isActive, subStatusById),
        parseAgentJourney(brainDir, s.id, {
          isMaster: true,
          isCompleted: !isActive,
          isSleep: false,
          fallbackBrief: s.title,
          nowMs,
          externalSummary: extMaster,
        }),
      ]);

      sessions.push({
        id: s.id,
        project: s.workspace || '全局',
        name: s.title || s.id.slice(0, 8),
        status: isActive ? 'active' : sessionMarkedRead ? 'done' : 'unread',
        isRead: sessionMarkedRead,
        isFavorite: Boolean(s.isFavorite),
        isRecentFallback: Boolean(s.isRecentFallback),
        modifiedMs: Number(s.modifiedMs || 0),
        tag: isActive ? quickJourney.shortStatus : sessionMarkedRead ? '任务结束' : '结束未读',
        subAgentCount: quickSubCount,
        progress: isActive ? quickJourney.progress : 100,
        timeLabel: s.agoText || '',
      });
    }
  }

  return {
    sessions,
    favoriteIds,
    favoriteCount: pinnedList.length,
    selectedSessionId: effectiveSelectedId,
    isFallbackRecent,
    activeCount: activeList.length,
    unreadCount: unreadList.length,
    detailSession,
  };
}

/**
 * Resolve a file:/// URI or absolute local path into a clean normalized OS path.
 * Rejects non-local protocols, relative paths, quotes, and control characters.
 */
const SAFE_DIRECT_OPEN_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

export function resolveLocalTargetPath(rawInput, { platform = process.platform } = {}) {
  if (typeof rawInput !== 'string') return '';
  let s = rawInput.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!s || /[\0\r\n"<>|]/.test(s)) return '';

  // Reject non-file schemes (http, https, javascript, mailto, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) && !/^file:\/\//i.test(s)) {
    return '';
  }
  if (/^(?:javascript|data|mailto|vbscript):/i.test(s)) {
    return '';
  }

  if (/^file:\/\//i.test(s)) {
    // Block remote UNC file://host/share URIs (only allow file:///... or file://localhost/...)
    if (/^file:\/\/(?!\/|localhost\/)/i.test(s)) {
      return '';
    }
    s = s.replace(/^file:\/\/localhost\//i, '/').replace(/^file:\/\/+/i, '/');
    // Strip #L10-L20 line anchors and ?query from file URIs
    const hashIdx = s.indexOf('#');
    if (hashIdx >= 0) s = s.slice(0, hashIdx);
    const queryIdx = s.indexOf('?');
    if (queryIdx >= 0) s = s.slice(0, queryIdx);
    try {
      s = decodeURIComponent(s);
    } catch {
      s = s.replace(/(?:%[0-9a-fA-F]{2})+/g, (seq) => {
        try {
          return decodeURIComponent(seq);
        } catch {
          return seq;
        }
      });
    }
    // Windows drive letter form `/D:/foo` -> `D:/foo`
    if (/^\/+[a-zA-Z]:[\\/]/.test(s)) {
      s = s.replace(/^\/+/, '');
    }
  } else {
    // Strip optional `:line(:col)` or `#L10-L20` suffix on plain file paths (preserving Windows drive colon!)
    s = s.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/(?<=[^\\/:]):\d+(?::\d+)?$/, '');
  }

  s = s.trim();
  if (!s || /[\0\r\n"<>|]/.test(s)) return '';

  // Block UNC paths (\\host\share or //host/share) to prevent outbound Windows SMB/NTLM leaks
  if (/^(?:\\\\|\/\/)/.test(s)) {
    return '';
  }

  const isWinDrive = /^[a-zA-Z]:[\\/]/.test(s);
  const isPosixAbs = s.startsWith('/');
  if (platform === 'win32') {
    if (!isWinDrive) return '';
    return path.win32.resolve(s);
  }
  if (isWinDrive) {
    return path.win32.resolve(s);
  }
  if (!isPosixAbs) return '';
  return path.posix.resolve(s);
}

/**
 * Open a local path in the native file manager:
 * - Directory -> enters the directory itself
 * - File -> opens its parent directory (selecting the file on Windows/macOS)
 * - Missing/deleted target -> walks up to the nearest existing parent directory
 */
export async function openLocalPathTarget(
  rawInput,
  { mode = 'folder', platform = process.platform, fsImpl = fsp, spawnImpl = spawn } = {},
) {
  const resolved = resolveLocalTargetPath(rawInput, { platform });
  if (!resolved) {
    return { ok: false, status: 400, error: '无效的本地文件或目录路径' };
  }

  const openMode = mode === 'file' ? 'file' : 'folder';
  const pathApi = platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(resolved) ? path.win32 : path.posix;
  let kind = 'missing';
  let stat = null;
  try {
    stat = await fsImpl.stat(resolved);
    kind = stat.isDirectory() ? 'directory' : 'file';
  } catch {
    kind = 'missing';
  }

  // Direct file open mode (strictly restricted to safe raster images to prevent arbitrary executable launch)
  if (openMode === 'file' && kind === 'file') {
    const ext = pathApi.extname(resolved).toLowerCase();
    if (!SAFE_DIRECT_OPEN_IMAGE_EXTS.has(ext)) {
      return { ok: false, status: 403, error: '出于安全限制，仅允许直接打开常见图片文件；其他文件请打开所在位置' };
    }
    try {
      let child = null;
      if (platform === 'win32') {
        child = spawnImpl('rundll32.exe', ['url.dll,FileProtocolHandler', resolved], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
      } else if (platform === 'darwin') {
        child = spawnImpl('open', [resolved], { detached: true, stdio: 'ignore' });
      } else {
        child = spawnImpl('xdg-open', [resolved], { detached: true, stdio: 'ignore' });
      }
      child?.on?.('error', () => {});
      child?.unref?.();
      return {
        ok: true,
        kind: 'file_open',
        targetPath: resolved,
        openedPath: resolved,
      };
    } catch (err) {
      return {
        ok: false,
        status: 500,
        error: err?.message || '打开目标文件失败',
      };
    }
  }

  let openDir = '';
  let selectFile = '';
  if (kind === 'directory') {
    openDir = resolved;
  } else if (kind === 'file') {
    openDir = pathApi.dirname(resolved);
    selectFile = resolved;
  } else {
    // Walk up parent directories (e.g. if a cleaned-up folder/file was deleted)
    let cur = pathApi.dirname(resolved);
    for (let depth = 0; depth < 8 && cur; depth += 1) {
      try {
        const pst = await fsImpl.stat(cur);
        if (pst.isDirectory()) {
          openDir = cur;
          kind = 'parent_fallback';
          break;
        }
      } catch {
        // continue walking up
      }
      const next = pathApi.dirname(cur);
      if (!next || next === cur) break;
      cur = next;
    }
  }

  if (!openDir) {
    return { ok: false, status: 404, error: '目标文件或上级目录不存在' };
  }

  try {
    let child = null;
    if (platform === 'win32') {
      if (selectFile) {
        // Windows Explorer reliably opens the parent folder and highlights the target file
        child = spawnImpl('explorer.exe', [`/select,"${selectFile}"`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
          windowsVerbatimArguments: true,
        });
      } else {
        child = spawnImpl('explorer.exe', [openDir], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
      }
    } else if (platform === 'darwin') {
      child = spawnImpl('open', selectFile ? ['-R', selectFile] : [openDir], {
        detached: true,
        stdio: 'ignore',
      });
    } else {
      child = spawnImpl('xdg-open', [openDir], {
        detached: true,
        stdio: 'ignore',
      });
    }
    child?.on?.('error', () => {});
    child?.unref?.();
    return {
      ok: true,
      kind,
      targetPath: resolved,
      openedPath: openDir,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.message || '打开系统文件管理器失败',
    };
  }
}
