import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { evaluateMasteryHook } from '../hooks/mastery_summary_hook.mjs';
import {
  buildMasterySnapshot,
  classifyToolCall,
  openLocalPathTarget,
  parseAgentJourney,
  resolveLocalTargetPath,
} from '../sidecars/agy_monitor/backend/mastery.mjs';
import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';
import { createStorage } from '../sidecars/agy_monitor/backend/storage.mjs';
import { classifyUpstreamModelStatus } from '../sidecars/agy_monitor/backend/telemetry.mjs';

function makeTempEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-reg105-test-'));
  const paths = resolvePaths({
    appDataDir: path.join(root, 'appData'),
    geminiConfigDir: path.join(root, 'config'),
    pluginDataDir: path.join(root, 'pluginData'),
    sidecarDataDir: path.join(root, 'sidecarData'),
    brainDir: path.join(root, 'brain'),
  });
  const storage = createStorage(paths);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, paths, storage };
}

test('v1.0.5 mastery: authoritative subStatusById keeps live subagents running beyond 90s and ignores stale swarmTitle', async (t) => {
  const { paths } = makeTempEnv(t);
  const convId = 'conv-live-sub-001';
  const subId = 'sub-audit-live-001';
  const masterSys = path.join(paths.brainDir, convId, '.system_generated');
  const subDir = path.join(masterSys, 'subagents');
  const swarmDir = path.join(masterSys, 'swarm');
  const masterLogsDir = path.join(masterSys, 'logs');
  const subLogsDir = path.join(paths.brainDir, subId, '.system_generated', 'logs');
  fs.mkdirSync(subDir, { recursive: true });
  fs.mkdirSync(swarmDir, { recursive: true });
  fs.mkdirSync(masterLogsDir, { recursive: true });
  fs.mkdirSync(subLogsDir, { recursive: true });

  // Stale old swarm metadata from an earlier completed run (no active swarm workers)
  fs.writeFileSync(
    path.join(swarmDir, 'state.json'),
    JSON.stringify({
      title: '旧的已结束蜂群标题',
      members: {
        coordinator: { conversation_id: convId, role: 'coordinator', phase: 'WAITING' },
      },
    }),
    'utf8',
  );

  // Subagent file with SUBAGENT_STATE_ALIVE (same state Antigravity uses for both running & idle)
  fs.writeFileSync(
    path.join(subDir, `${subId}.json`),
    JSON.stringify({
      conversationId: subId,
      role: 'Backend & Hook Bug Auditor',
      typeName: 'research',
      state: 'SUBAGENT_STATE_ALIVE',
    }),
    'utf8',
  );

  const nowMs = Date.now();
  const staleIso = new Date(nowMs - 180_000).toISOString();
  fs.writeFileSync(
    path.join(masterLogsDir, 'transcript.jsonl'),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: staleIso,
      content: '[AGY_PROGRESS|25%|主任务正在排查中]\n\n正在排查全仓问题。',
    }) + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(subLogsDir, 'transcript.jsonl'),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: staleIso,
      content: '正在逐文件审计代码。',
    }) + '\n',
    'utf8',
  );
  // Force mtime older than 90s to verify authoritative DB status overrides the 90s heuristic
  const oldTime = new Date(nowMs - 180_000);
  fs.utimesSync(path.join(subLogsDir, 'transcript.jsonl'), oldTime, oldTime);

  const snapshot = await buildMasterySnapshot(
    paths,
    {
      active: [
        {
          id: convId,
          title: '全仓排雷任务',
          workspace: 'agy-plugin',
          stepCount: 10,
          modifiedMs: nowMs,
          agoText: '刚刚',
        },
      ],
      waiting: [],
      unread: [],
      recent: [],
      subStatusById: {
        [subId]: {
          parentId: convId,
          status: 'CASCADE_RUN_STATUS_RUNNING',
          notFullyIdle: true,
          killed: false,
          stepCount: 4,
          modifiedMs: nowMs,
        },
      },
    },
    { selectedSessionId: convId, nowMs },
  );

  assert.equal(snapshot.detailSession.goal.includes('旧的已结束蜂群标题'), false, 'Stale swarmTitle must not override active goal');
  assert.equal(snapshot.detailSession.subs.length, 1);
  assert.equal(snapshot.detailSession.subs[0].stateKind, 'running', 'Authoritative CASCADE_RUN_STATUS_RUNNING must stay running even >90s');
});

test('v1.0.5 mastery: thinking tags never leak prose or discard visible content, and replace_file_content computes +/- diff', async (t) => {
  const { paths } = makeTempEnv(t);
  const convId = 'conv-think-002';
  const logsDir = path.join(paths.brainDir, convId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, 'transcript.jsonl'),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-21T01:00:00Z',
      thinking: '内心思考提到 [AGY_PROGRESS|99%|这是内部思考标签]\n这里有很多内部草稿内容不应该泄露',
      content: '真正的最终回复内容在这里。',
    }) + '\n',
    'utf8',
  );

  const journey = await parseAgentJourney(paths.brainDir, convId, { isMaster: true, isCompleted: true });
  const msg = journey.steps.find((s) => s.type === 'msg');
  assert.ok(msg, 'Visible message step must be preserved');
  assert.equal(msg.text, '真正的最终回复内容在这里。');
  assert.equal(msg.statusTag || '', '');
  assert.equal(msg.text.includes('内部草稿'), false);

  const editItem = classifyToolCall({
    name: 'replace_file_content',
    args: {
      TargetFile: 'd:/repo/app.js',
      TargetContent: 'const a = 1;\nconst b = 2;',
      ReplacementContent: 'const a = 1;\nconst b = 3;\nconst c = 4;',
    },
  });
  assert.equal(editItem.categoryLabel, '编辑了文件');
  assert.equal(editItem.add, '+3');
  assert.equal(editItem.del, '-2');

  const multiItem = classifyToolCall({
    name: 'multi_replace_file_content',
    args: {
      TargetFile: 'd:/repo/app.js',
      ReplacementChunks: [
        { TargetContent: 'x', ReplacementContent: 'x1\nx2' },
        { TargetContent: 'y1\ny2', ReplacementContent: 'y' },
      ],
    },
  });
  assert.equal(multiItem.categoryLabel, '编辑了文件');
  assert.equal(multiItem.add, '+3');
  assert.equal(multiItem.del, '-3');
});

test('v1.0.5 security: UNC paths rejected and mode=file blocks non-image executables', async (t) => {
  const { root } = makeTempEnv(t);
  const exePath = path.join(root, 'fake.exe');
  fs.writeFileSync(exePath, 'MZ', 'utf8');

  assert.equal(resolveLocalTargetPath('\\\\evil-host\\share\\a.png', { platform: 'win32' }), '');
  assert.equal(resolveLocalTargetPath('//evil-host/share/a.png', { platform: 'win32' }), '');
  assert.equal(resolveLocalTargetPath('file://evil-host/share/a.png', { platform: 'win32' }), '');

  let spawned = false;
  const res = await openLocalPathTarget(exePath, {
    mode: 'file',
    platform: 'win32',
    spawnImpl: () => {
      spawned = true;
      return { on() {}, unref() {} };
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(spawned, false, 'mode=file must never launch executables');
});

test('v1.0.5 telemetry: opus and ultra exact model matches never falsely flag downgrade_suspected', () => {
  assert.equal(
    classifyUpstreamModelStatus({ id: 'claude-opus-4-6', tier: 'high' }, 'claude-opus-4-6'),
    'match',
  );
  assert.equal(
    classifyUpstreamModelStatus({ id: 'gemini-3-ultra', tier: 'high' }, 'gemini-3-ultra'),
    'match',
  );
  assert.equal(
    classifyUpstreamModelStatus({ id: 'claude-opus-4-6', tier: 'ultra' }, 'claude-opus-4-6-20260201'),
    'match',
  );
});

test('v1.0.5 hook: per-conversation hook_state isolates concurrent subagents without overwriting each other', async (t) => {
  const { paths, storage } = makeTempEnv(t);
  await storage.updateMasteryConfig({ enabled: true, source: 'self', frequency: '1m' });

  const outA = evaluateMasteryHook(
    { conversationId: 'conv-a', invocationNum: 1, lastUserInput: '任务A' },
    { pluginDataDir: paths.pluginDataDir, nowMs: 2_000_000 },
  );
  const outB = evaluateMasteryHook(
    { conversationId: 'conv-b', invocationNum: 1, lastUserInput: '任务B' },
    { pluginDataDir: paths.pluginDataDir, nowMs: 2_000_500 },
  );
  assert.match(outA.injectSteps?.[0]?.systemMessage?.systemMessage || '', /开场汇报/);
  assert.match(outB.injectSteps?.[0]?.systemMessage?.systemMessage || '', /开场汇报/);

  const stateDir = path.join(paths.pluginDataDir, 'hook_state');
  assert.ok(fs.existsSync(path.join(stateDir, 'conv-a.json')));
  assert.ok(fs.existsSync(path.join(stateDir, 'conv-b.json')));
});
