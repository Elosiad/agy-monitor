import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildHostI18nApplyExpr,
  buildHostI18nRescanExpr,
  buildHostI18nRestoreExpr,
  buildHostI18nRuntimeScript,
  buildHostI18nSelfContainedScript,
  clearHostI18nCache,
  HOST_I18N_VERSION,
  loadHostI18nBundle,
  translateHostTextForTest,
} from '../sidecars/agy_monitor/backend/host_i18n.mjs';
import {
  buildMainHookScript,
  stageLiveHudAssets,
} from '../sidecars/agy_monitor/backend/hud_injector.mjs';
import { resolvePaths } from '../sidecars/agy_monitor/backend/paths.mjs';

test('host_i18n dictionary integrity: MIT curated bundle covers screenshot UI terms and dynamic patterns', () => {
  clearHostI18nCache();
  const bundle = loadHostI18nBundle();
  assert.equal(bundle.version, HOST_I18N_VERSION);
  assert.ok(Object.keys(bundle.exact).length > 6000, 'merged MIT exact dictionary should exceed 6000 entries');
  assert.ok(bundle.patterns.length > 300, 'validated dynamic regex patterns should exceed 300 entries');

  // Verify all key UI terms reported missing in user screenshots
  const mustTranslate = [
    ['View', '视图'],
    ['Window', '窗口'],
    ['Pinned Conversations', '置顶对话'],
    ['Show All', '显示全部'],
    ['Not in Project', '未归入项目'],
    ['Conversations', '全部对话'],
    ['Give Feedback', '提交反馈'],
    ['Application', '应用设置'],
    ['Shortcuts', '快捷键'],
    ['Interface Layout', '界面布局'],
    ['Knowledge Work', '知识工作'],
    ['Software Engineering', '软件工程'],
    ['This computer', '本机'],
    ['Remote', '远程'],
    ['Input Box', '输入框'],
    ['Queued messages', '排队消息'],
    ['Queue', '排队发送'],
    ['Send Immediately', '立即发送'],
    ['Prevent sleep', '防止系统休眠'],
    ['Keep in menu bar', '常驻菜单栏/托盘'],
    ['Remote Control', '远程控制'],
    ['Enable Remote Control', '启用远程控制'],
    ['Device name', '设备名称'],
    ['Notification settings', '通知设置'],
    ['copy link', '复制链接'],
  ];
  for (const [en, expected] of mustTranslate) {
    assert.equal(translateHostTextForTest(en, bundle), expected, `expected "${en}" -> "${expected}"`);
  }

  // Dynamic patterns & duration formatters
  assert.equal(translateHostTextForTest('Thought for 4s', bundle), '已思考 4秒');
  assert.equal(translateHostTextForTest('Worked for 1m 12s', bundle), '已工作 1分12秒');
  assert.equal(translateHostTextForTest('3 files changed', bundle), '3 个文件已变更');
  assert.equal(translateHostTextForTest('Resets in 2h 15m', bundle), '2小时15分 后重置');
  assert.equal(translateHostTextForTest('Show 5 More', bundle), '再显示 5 项');
  assert.equal(translateHostTextForTest('2 selected', bundle), '已选 2 项');
  assert.equal(translateHostTextForTest('  Application  ', bundle), '  应用设置  ');
  // Pure non-English / empty text returns null
  assert.equal(translateHostTextForTest('已经翻译好了', bundle), null);
});

function createMiniDom() {
  class MiniClassList {
    constructor(el) {
      this._el = el;
    }
    _list() {
      return String(this._el.className || '').split(/\s+/).filter(Boolean);
    }
    contains(c) {
      return this._list().includes(c);
    }
  }

  class MiniNode {
    constructor(nodeType, tagName = '', value = '') {
      this.nodeType = nodeType;
      this.tagName = tagName;
      this.nodeValue = value;
      this.parentElement = null;
      this.childNodes = [];
      this.attributes = new Map();
      this.id = '';
      this.className = '';
      this.isConnected = true;
      this.isContentEditable = false;
      this.classList = new MiniClassList(this);
    }
    appendChild(child) {
      child.parentElement = this;
      this.childNodes.push(child);
      return child;
    }
    contains(target) {
      let cur = target;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get firstElementChild() {
      return this.childNodes.find((c) => c.nodeType === 1) || null;
    }
    get previousElementSibling() {
      if (!this.parentElement) return null;
      const sibs = this.parentElement.childNodes.filter((c) => c.nodeType === 1);
      const idx = sibs.indexOf(this);
      return idx > 0 ? sibs[idx - 1] : null;
    }
    get textContent() {
      if (this.nodeType === 3) return this.nodeValue;
      return this.childNodes.map((c) => c.textContent).join('');
    }
    setAttribute(k, v) {
      const s = String(v);
      this.attributes.set(k, s);
      if (k === 'id') this.id = s;
      if (k === 'class') this.className = s;
    }
    getAttribute(k) {
      return this.attributes.has(k) ? this.attributes.get(k) : null;
    }
    hasAttribute(k) {
      return this.attributes.has(k);
    }
    matches(sel) {
      return sel.split(',').some((part) => {
        const s = part.trim();
        if (!s) return false;
        if (s.startsWith('#')) return this.id === s.slice(1);
        const mTagAttr = /^([a-z0-9-]+)?\[([a-z0-9-]+)(?:(\^?=)"([^"]*)")?\]$/i.exec(s);
        if (mTagAttr) {
          if (mTagAttr[1] && this.tagName.toUpperCase() !== mTagAttr[1].toUpperCase()) return false;
          const attrVal = this.getAttribute(mTagAttr[2]);
          if (attrVal === null) return false;
          if (!mTagAttr[3]) return true;
          return mTagAttr[3] === '^=' ? attrVal.startsWith(mTagAttr[4]) : attrVal === mTagAttr[4];
        }
        return this.tagName.toUpperCase() === s.toUpperCase();
      });
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.nodeType === 1 && cur.matches(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const ch of n.childNodes) {
          if (ch.nodeType === 1) {
            if (ch.matches(sel)) out.push(ch);
            walk(ch);
          }
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) {
      if (sel.startsWith(':scope > ')) {
        const sub = sel.slice(':scope > '.length);
        return this.childNodes.find((c) => c.nodeType === 1 && c.matches(sub)) || null;
      }
      return this.querySelectorAll(sel)[0] || null;
    }
  }

  const el = (tag, attrs = {}, children = []) => {
    const node = new MiniNode(1, tag.toUpperCase());
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const ch of children) {
      node.appendChild(typeof ch === 'string' ? new MiniNode(3, '', ch) : ch);
    }
    return node;
  };
  const body = el('body');
  const document = {
    body,
    documentElement: el('html', {}, [body]),
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    createTreeWalker(root) {
      const list = [];
      const visit = (n) => {
        for (const ch of n.childNodes) {
          list.push(ch);
          if (ch.nodeType === 1) visit(ch);
        }
      };
      visit(root);
      let idx = 0;
      return {
        nextNode() {
          return idx < list.length ? list[idx++] : null;
        },
      };
    },
  };
  return { el, body, document };
}

test('host_i18n browser runtime protects code/chat/icons/projects, translates split sentences, and restores English cleanly', () => {
  const { el, body, document } = createMiniDom();

  // Translatable UI elements
  const navBtn = el('button', { 'data-testid': 'settings-nav-item-application' }, ['Application']);
  const searchInput = el('input', { placeholder: 'Search...' });
  const splitPara = el('p', {}, [
    'Scan the code to open this device in Remote Control, or ',
    el('a', {}, ['copy link']),
    '.',
  ]);
  const thinkTrigger = el('button', { 'data-testid': 'thinking-collapsible-trigger' }, ['Thought for 4s']);
  const thinkBody = el('div', {}, ['Application View Window']);
  const thinkWrap = el('div', {}, [thinkTrigger, thinkBody]);

  // Strictly protected elements (must NEVER be translated)
  const codeEl = el('code', {}, ['Application']);
  const userMsg = el('div', { 'data-testid': 'user-message-content' }, ['Application View Window']);
  const mdRoot = el('div', { 'data-markdown-root': 'true' }, [el('p', {}, ['Remote Control'])]);
  const fontIcon = el('span', { class: 'google-symbols' }, ['folder']);
  const userProjectCard = el('button', { 'data-project-card': 'true' }, ['Window']);
  const hudBox = el('div', { id: 'agy-monitor-native-hud' }, ['Application']);

  for (const node of [navBtn, searchInput, splitPara, thinkWrap, codeEl, userMsg, mdRoot, fontIcon, userProjectCard, hudBox]) {
    body.appendChild(node);
  }

  let legacyStopped = false;
  const sandbox = {
    document,
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.__agyMonI18n = {
    stop() {
      legacyStopped = true;
    },
  };

  vm.runInNewContext(buildHostI18nApplyExpr(), sandbox, { filename: 'host_i18n_apply.js' });

  assert.equal(legacyStopped, true, 'v2 installer must stop legacy v1 __agyMonI18n cleanly');
  assert.equal(sandbox.__agyHostI18nApplied, true);
  assert.equal(sandbox.__agyMonitorHostI18n.version, HOST_I18N_VERSION);

  // Translatable UI assertions
  assert.equal(navBtn.textContent, '应用设置');
  assert.equal(searchInput.getAttribute('placeholder'), '搜索...');
  assert.equal(splitPara.textContent, '扫码在远程控制中打开此设备，或复制链接。');
  assert.equal(splitPara.childNodes[1].tagName, 'A', 'inline <a> element must remain intact for React Fiber');
  assert.equal(thinkTrigger.textContent, '已思考 4秒');

  // Protected zone assertions
  assert.equal(thinkBody.textContent, 'Application View Window', 'thinking body sibling must stay untouched');
  assert.equal(codeEl.textContent, 'Application');
  assert.equal(userMsg.textContent, 'Application View Window');
  assert.equal(mdRoot.textContent, 'Remote Control');
  assert.equal(fontIcon.textContent, 'folder', 'google-symbols icon ligature must stay untouched');
  assert.equal(userProjectCard.textContent, 'Window', 'user project card name must stay untouched');
  assert.equal(hudBox.textContent, 'Application', 'AGY Monitor native HUD must stay untouched');

  // Rescan fast-path returns true
  const rescanOk = vm.runInNewContext(buildHostI18nRescanExpr(), sandbox, { filename: 'host_i18n_rescan.js' });
  assert.equal(rescanOk, true);

  // Restore cleanly returns everything to English
  vm.runInNewContext(buildHostI18nRestoreExpr(), sandbox, { filename: 'host_i18n_restore.js' });
  assert.equal(sandbox.__agyHostI18nApplied, undefined);
  assert.equal(navBtn.textContent, 'Application');
  assert.equal(searchInput.getAttribute('placeholder'), 'Search...');
  assert.equal(splitPara.textContent, 'Scan the code to open this device in Remote Control, or copy link.');
  assert.equal(thinkTrigger.textContent, 'Thought for 4s');
});

test('host_i18n scripts parse cleanly and stageLiveHudAssets writes native_host_i18n.js with hash skip', async (t) => {
  assert.doesNotThrow(() => new vm.Script(buildHostI18nRuntimeScript(), { filename: 'host_i18n_runtime.js' }));
  assert.doesNotThrow(() => new vm.Script(buildHostI18nSelfContainedScript(), { filename: 'host_i18n_self.js' }));
  const mainHook = buildMainHookScript();
  assert.doesNotThrow(() => new vm.Script(mainHook, { filename: 'agy-monitor-hud-main.js' }));
  assert.match(mainHook, /native_host_i18n\.js/);
  assert.match(mainHook, /wantHostI18n/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-host-i18n-stage-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const paths = resolvePaths({
    appDataDir: path.join(tmp, 'appData'),
    geminiConfigDir: path.join(tmp, 'config'),
    pluginDataDir: path.join(tmp, 'pluginData'),
    sidecarDataDir: path.join(tmp, 'sidecarData'),
  });

  const first = await stageLiveHudAssets(paths, null, {});
  assert.equal(first.staged, true);
  const stagedFile = path.join(paths.pluginDataDir, 'native_host_i18n.js');
  assert.equal(fs.existsSync(stagedFile), true);
  assert.ok(fs.statSync(stagedFile).size > 200_000);

  const second = await stageLiveHudAssets(paths, null, {});
  assert.equal(second.skipped, true, 'unchanged native_host_i18n.js must not be rewritten');
});
