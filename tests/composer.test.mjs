import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  composeOutboundMessage,
  listSlashCommands,
  matchLeadingSlashCommand,
  saveComposerImages,
} from '../sidecars/agy_monitor/backend/composer.mjs';
import { buildMasterySnapshot } from '../sidecars/agy_monitor/backend/mastery.mjs';
import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import { createMonitorHandlers } from '../sidecars/agy_monitor/main.mjs';

// Minimal valid 1x1 PNG buffer
const TINY_PNG_BUF = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-monitor-composer-'));
  const appDataDir = path.join(root, 'antigravity');
  const geminiConfigDir = path.join(root, 'config');
  const pluginDataDir = path.join(appDataDir, 'plugin_data', 'agy-monitor');
  const sidecarDataDir = path.join(appDataDir, 'sidecar_data', 'agy-monitor', 'agy_monitor', 'data');
  fs.mkdirSync(path.join(appDataDir, 'builtin', 'skills', 'native_swarm'), { recursive: true });
  fs.writeFileSync(
    path.join(appDataDir, 'builtin', 'skills', 'native_swarm', 'SKILL.md'),
    '---\nname: swarm\ndescription: Run parallel swarm\n---\n# Swarm\n',
    'utf8',
  );
  fs.mkdirSync(path.join(geminiConfigDir, 'skills', 'codex'), { recursive: true });
  fs.writeFileSync(
    path.join(geminiConfigDir, 'skills', 'codex', 'SKILL.md'),
    '---\nname: codex\ndescription: Orchestrate Codex worker\n---\n# Codex\n',
    'utf8',
  );

  const paths = resolvePaths({
    appDataDir,
    geminiConfigDir,
    pluginDataDir,
    sidecarDataDir,
  });

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, paths };
}

test('composer discovers /swarm and custom skills, validates raster images, and formats outbound prompt', async (t) => {
  const { paths } = createFixture(t);

  const cmds = await listSlashCommands(paths, { force: true });
  assert.ok(cmds.length >= 10);
  assert.equal(cmds[0].name, 'swarm');
  assert.ok(cmds[0].skillPath.endsWith(path.join('native_swarm', 'SKILL.md')));
  assert.ok(cmds.some((c) => c.name === 'codex' && c.category === 'skill'));

  const matched = matchLeadingSlashCommand('/swarm 并发排查登录和支付两个模块', cmds);
  assert.equal(matched?.name, 'swarm');

  // Block SVG & spoofed non-image payloads
  const svgRes = await saveComposerImages(paths, [
    { name: 'evil.svg', mime: 'image/svg+xml', base64: Buffer.from('<svg></svg>').toString('base64') },
  ]);
  assert.equal(svgRes.ok, false);
  assert.equal(svgRes.status, 403);

  const fakePngRes = await saveComposerImages(paths, [
    { name: 'fake.png', mime: 'image/png', base64: Buffer.from('<svg onload=alert(1)>').toString('base64') },
  ]);
  assert.equal(fakePngRes.ok, false);
  assert.equal(fakePngRes.status, 403);

  // Accept valid PNG
  const okRes = await saveComposerImages(paths, [
    { name: 'screen.png', mime: 'image/png', base64: TINY_PNG_BUF.toString('base64') },
  ]);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.saved.length, 1);
  assert.ok(fs.existsSync(okRes.saved[0].filePath));

  const outMsg = composeOutboundMessage({
    prompt: '/swarm 并发排查两个接口',
    savedImages: okRes.saved,
    slashCommand: matched,
  });
  assert.match(outMsg, /^\/swarm 并发排查两个接口/);
  assert.match(outMsg, /\[AGY_CONSOLE_CMD:\/swarm\]/);
  assert.match(outMsg, /native_swarm/);
  assert.match(outMsg, /\[AGY_CONSOLE_IMAGES\]/);
  assert.ok(outMsg.includes(okRes.saved[0].filePath.replace(/\\/g, '/')));
});

test('POST /api/mastery/composer/send dispatches via official sidecarBridge.sendMessage and timeline renders it cleanly', async (t) => {
  const { paths } = createFixture(t);
  const storage = createStorage(paths);
  const sentCalls = [];
  let rescanCount = 0;

  const routes = createMonitorHandlers({
    paths,
    storage,
    triggerRescan: () => {
      rescanCount += 1;
    },
    sidecarBridge: {
      getConfig: () => ({ projectId: '', conversationId: 'conv-host-1' }),
      getConversationMetadata: async (convId) => ({
        response: {
          conversationMetadata: {
            metadata: { projectId: `proj-for-${convId}` },
          },
        },
      }),
      sendMessage: async (conversationId, message, opts) => {
        sentCalls.push({ conversationId, message, opts });
        return { delivered: true };
      },
    },
  });

  const getCmds = routes.get('GET /api/mastery/composer/commands');
  const sendHandler = routes.get('POST /api/mastery/composer/send');
  assert.equal(typeof getCmds, 'function');
  assert.equal(typeof sendHandler, 'function');

  const cmdResp = await getCmds({});
  assert.equal(cmdResp.ok, true);
  assert.equal(cmdResp.commands[0].name, 'swarm');

  // Empty payload rejected
  const emptyResp = await sendHandler({ conversationId: 'conv-main-001', prompt: '   ', images: [] });
  assert.equal(emptyResp.status, 400);

  // Valid /swarm + image payload dispatched
  const sendResp = await sendHandler({
    conversationId: 'conv-main-001',
    prompt: '/swarm 修复首页样式问题',
    images: [{ name: 'shot.png', mime: 'image/png', base64: TINY_PNG_BUF.toString('base64') }],
  });
  assert.equal(sendResp.ok, true);
  assert.equal(sendResp.matchedCommand, 'swarm');
  assert.equal(sendResp.savedImages.length, 1);
  assert.equal(rescanCount, 1);
  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].conversationId, 'conv-main-001');
  assert.equal(sentCalls[0].opts.title, 'AGY 控制台');
  assert.equal(sentCalls[0].opts.projectId, 'proj-for-conv-main-001');

  // Verify mastery.mjs parses the delivered SYSTEM_MESSAGE back into a clean user bubble + image gallery
  const convDir = path.join(paths.brainDir, 'conv-main-001', '.system_generated', 'logs');
  fs.mkdirSync(convDir, { recursive: true });
  const trLines = [
    JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-23T02:00:00Z',
      content: '<USER_REQUEST>初始任务</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T02:00:05Z',
      content: '已完成初始任务。',
    }),
    JSON.stringify({
      step_index: 3,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: '2026-11-23T02:01:00Z',
      content: `[Message] title="AGY 控制台" content=${sentCalls[0].message}`,
    }),
  ].join('\n');
  fs.writeFileSync(path.join(convDir, 'transcript.jsonl'), `${trLines}\n`, 'utf8');

  const snap = await buildMasterySnapshot(
    paths,
    {
      running: [],
      unread: [],
      recent: [
        {
          id: 'conv-main-001',
          title: 'Main Session',
          workspace: 'agy-plugin',
          modifiedMs: Date.now(),
          status: 'done',
        },
      ],
      favorites: [],
      favoriteIds: [],
      allSelectable: [],
    },
    { selectedSessionId: 'conv-main-001' },
  );

  const userSteps = (snap.detailSession?.master?.journey?.steps || []).filter((s) => s.type === 'user');
  const dispatchedBubble = userSteps.find((s) => s.label === '来自 AGY 控制台');
  assert.ok(dispatchedBubble, 'Dispatched composer message should appear as a user bubble in Main Agent timeline');
  assert.equal(dispatchedBubble.text, '/swarm 修复首页样式问题');
  assert.equal(dispatchedBubble.images?.length, 1);
  assert.equal(dispatchedBubble.images[0], sendResp.savedImages[0].filePath.replace(/\\/g, '/'));
});
