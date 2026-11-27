import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'sidecars', 'agy_monitor', 'frontend');
const INDEX_HTML_PATH = path.join(FRONTEND_DIR, 'index.html');
const STYLES_CSS_PATH = path.join(FRONTEND_DIR, 'styles.css');
const I18N_PATH = path.join(FRONTEND_DIR, 'i18n.js');

const VOID_TAGS = new Set(['meta', 'link', 'input', 'img', 'br', 'hr', 'path']);

function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function createMiniDom(htmlText) {
  function makeStyle() {
    const props = new Map();
    const styleObj = {
      setProperty(k, v) {
        props.set(String(k), String(v));
      },
      getPropertyValue(k) {
        return props.get(String(k)) || '';
      },
      removeProperty(k) {
        props.delete(String(k));
      },
      _props: props,
    };
    return new Proxy(styleObj, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return props.get(String(prop)) || '';
      },
      set(target, prop, val) {
        if (prop in target) target[prop] = val;
        else props.set(String(prop), String(val));
        return true;
      },
    });
  }

  function makeClassList(el) {
    const parse = () =>
      new Set(
        String(el.attributes.class || '')
          .split(/\s+/)
          .filter(Boolean),
      );
    const commit = (set) => {
      el.attributes.class = Array.from(set).join(' ');
    };
    return {
      add(...cls) {
        const s = parse();
        cls.forEach((c) => c && s.add(c));
        commit(s);
      },
      remove(...cls) {
        const s = parse();
        cls.forEach((c) => s.delete(c));
        commit(s);
      },
      toggle(c, force) {
        const s = parse();
        const next = force === undefined ? !s.has(c) : Boolean(force);
        if (next) s.add(c);
        else s.delete(c);
        commit(s);
        return next;
      },
      contains(c) {
        return parse().has(c);
      },
    };
  }

  function matchesSelector(el, single) {
    const s = single.trim();
    if (!s) return false;
    // Split chained simple selectors like button.filter-tab[data-scope][data-range] or .a.b
    const attrMatches = [...s.matchAll(/\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]*)["']?)?\]/g)];
    let rest = s.replace(/\[[^\]]+\]/g, '');
    const idMatch = rest.match(/#([a-zA-Z0-9_-]+)/);
    if (idMatch) {
      if (el.id !== idMatch[1]) return false;
      rest = rest.replace(/#[a-zA-Z0-9_-]+/g, '');
    }
    const classMatches = [...rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
    rest = rest.replace(/\.[a-zA-Z0-9_-]+/g, '').trim();
    if (rest && el.tagName.toLowerCase() !== rest.toLowerCase()) return false;
    for (const cls of classMatches) {
      if (!el.classList.contains(cls)) return false;
    }
    for (const am of attrMatches) {
      const attrName = am[1];
      const attrVal = am[2];
      if (!el.hasAttribute(attrName)) return false;
      if (attrVal !== undefined && el.getAttribute(attrName) !== attrVal) return false;
    }
    return true;
  }

  function matchesDescendantSelector(el, selector) {
    const parts = selector.trim().split(/\s+/).filter(Boolean);
    if (!parts.length || !matchesSelector(el, parts[parts.length - 1])) return false;
    let cur = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      while (cur && !matchesSelector(cur, parts[i])) {
        cur = cur.parentElement;
      }
      if (!cur) return false;
      cur = cur.parentElement;
    }
    return true;
  }

  function makeElement(tagName) {
    const listeners = new Map();
    const el = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      attributes: {},
      children: [],
      parentElement: null,
      style: makeStyle(),
      _text: '',
      _value: '',
      _checked: false,
      disabled: false,
      files: [],
      get checked() {
        return this._checked || 'checked' in this.attributes;
      },
      set checked(v) {
        this._checked = Boolean(v);
        if (this._checked) this.attributes.checked = '';
        else delete this.attributes.checked;
      },
      get id() {
        return this.attributes.id || '';
      },
      set id(v) {
        this.attributes.id = String(v);
      },
      get className() {
        return this.attributes.class || '';
      },
      set className(v) {
        this.attributes.class = String(v);
      },
      get hidden() {
        return 'hidden' in this.attributes;
      },
      set hidden(v) {
        if (v) this.attributes.hidden = '';
        else delete this.attributes.hidden;
      },
      get value() {
        return this._value || this.attributes.value || '';
      },
      set value(v) {
        this._value = String(v);
        this.attributes.value = String(v);
      },
      get textContent() {
        if (this.children.length === 0) return this._text;
        return this._text + this.children.map((c) => c.textContent).join('');
      },
      set textContent(v) {
        this.children = [];
        this._text = String(v ?? '');
      },
      get innerHTML() {
        return '';
      },
      set innerHTML(v) {
        if (v !== '') throw new Error(`Unexpected non-empty innerHTML write: ${v}`);
        this.children = [];
        this._text = '';
      },
      get title() {
        return this.attributes.title || '';
      },
      set title(v) {
        this.attributes.title = String(v);
      },
      get tabIndex() {
        return Number(this.attributes.tabindex || 0);
      },
      set tabIndex(v) {
        this.attributes.tabindex = String(v);
      },
      setAttribute(name, val) {
        this.attributes[String(name)] = String(val);
      },
      getAttribute(name) {
        const k = String(name);
        return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, String(name));
      },
      removeAttribute(name) {
        delete this.attributes[String(name)];
      },
      appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
      },
      contains(other) {
        if (other === this) return true;
        return this.children.some((c) => c.contains(other));
      },
      closest(selector) {
        let cur = this;
        while (cur) {
          if (selector.split(',').some((part) => matchesDescendantSelector(cur, part))) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(selector) {
        const selectors = selector.split(',').map((s) => s.trim()).filter(Boolean);
        const out = [];
        const walk = (node) => {
          for (const child of node.children) {
            if (selectors.some((sel) => matchesDescendantSelector(child, sel))) {
              out.push(child);
            }
            walk(child);
          }
        };
        walk(this);
        return out;
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      dispatchEvent(evt) {
        const event = {
          type: evt.type,
          target: evt.target || this,
          currentTarget: this,
          key: evt.key || '',
          clientX: evt.clientX || 0,
          clientY: evt.clientY || 0,
          stopPropagation() {},
          preventDefault() {},
          ...evt,
        };
        for (const fn of [...(listeners.get(event.type) || [])]) {
          fn(event);
        }
      },
      click() {
        this.dispatchEvent({ type: 'click', target: this });
      },
      focus() {},
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 320, height: 240, right: 320, bottom: 240 };
      },
    };
    el.classList = makeClassList(el);
    el.dataset = new Proxy(
      {},
      {
        get(_, key) {
          const kebab = String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
          return el.attributes[`data-${kebab}`];
        },
        set(_, key, val) {
          const kebab = String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
          el.attributes[`data-${kebab}`] = String(val);
          return true;
        },
      },
    );
    return el;
  }

  const documentElement = makeElement('html');
  const head = makeElement('head');
  const body = makeElement('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  // Parse body markup from real index.html
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(htmlText);
  const bodyHtml = bodyMatch ? bodyMatch[1] : htmlText;
  const cleaned = bodyHtml.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '');

  const stack = [body];
  const tokenRe = /<\/?([a-zA-Z0-9:-]+)([^>]*)>|([^<]+)/g;
  for (const m of cleaned.matchAll(tokenRe)) {
    if (m[3]) {
      const txt = decodeHtmlEntities(m[3].replace(/\s+/g, ' '));
      if (txt.trim()) stack[stack.length - 1]._text += txt;
      continue;
    }
    const full = m[0];
    const tag = m[1].toLowerCase();
    const attrsStr = m[2] || '';
    if (full.startsWith('</')) {
      if (stack.length > 1 && stack[stack.length - 1].tagName.toLowerCase() === tag) {
        stack.pop();
      }
      continue;
    }
    const el = makeElement(tag);
    for (const am of attrsStr.matchAll(/([a-zA-Z0-9:-]+)(?:="([^"]*)"|='([^']*)')?/g)) {
      el.setAttribute(am[1], decodeHtmlEntities(am[2] ?? am[3] ?? ''));
    }
    stack[stack.length - 1].appendChild(el);
    const selfClosing = VOID_TAGS.has(tag) || attrsStr.trim().endsWith('/');
    if (!selfClosing) {
      stack.push(el);
    }
  }

  const docListeners = new Map();
  const document = {
    documentElement,
    head,
    body,
    readyState: 'loading',
    visibilityState: 'visible',
    createElement(tag) {
      return makeElement(tag);
    },
    createElementNS(_ns, tag) {
      return makeElement(tag);
    },
    getElementById(id) {
      return documentElement.querySelector(`#${id}`);
    },
    querySelector(sel) {
      return documentElement.querySelector(sel);
    },
    querySelectorAll(sel) {
      return documentElement.querySelectorAll(sel);
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    dispatchEvent(evt) {
      for (const fn of [...(docListeners.get(evt.type) || [])]) {
        fn(evt);
      }
    },
  };
  return { document };
}

test('frontend static contracts: 100% i18n keys, zero fake host claims, zero hardcoded CSS hex outside :root, zero raw fetch', async () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const css = fs.readFileSync(STYLES_CSS_PATH, 'utf8');
  const { DICT } = await import(pathToFileURL(I18N_PATH).href);

  // 1. Check no obsolete host-injection or deceptive placeholder text remains
  const forbiddenPatterns = [
    /hostWallpaperSyncBadge/,
    /hostLangSyncBadge/,
    /theme\.boundaryBridgeActive/,
    /已接入整机热联动/,
    /host_bridge|patch_host_asar|host_injector/,
    />Gemini 4 Hydrogen</,
    /quotaCalibrateModal/,
    /quotaCalibrateBtn/,
    /contextPieNote/,
    /tokenCostHint/,
    /linuxdo-3141927/,
    /系统底座为官方固定估算/,
    /纯订阅不扣费/,
  ];
  const filesToScan = [
    INDEX_HTML_PATH,
    I18N_PATH,
    path.join(FRONTEND_DIR, 'app.js'),
    ...fs.readdirSync(path.join(FRONTEND_DIR, 'components')).map((f) => path.join(FRONTEND_DIR, 'components', f)),
  ];
  for (const fp of filesToScan) {
    const content = fs.readFileSync(fp, 'utf8');
    for (const pat of forbiddenPatterns) {
      assert.equal(pat.test(content), false, `Forbidden legacy pattern ${pat} found in ${path.basename(fp)}`);
    }
    // Check no component bypasses window.sidecar.fetch / apiFetch with bare fetch(
    if (fp.endsWith('.js') && path.basename(fp) !== 'app.js' && path.basename(fp) !== 'i18n.js') {
      assert.equal(
        /\|\|\s*fetch\b|window\.fetch\b|\bfetch\s*\(/.test(content),
        false,
        `Unexpected raw fetch in ${path.basename(fp)}`,
      );
    }
  }

  // 2. Check all data-i18n* and JS t()/tr() keys exist in both zh-CN and en
  const allKeys = new Set([...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]));
  for (const fp of filesToScan.filter((f) => f.endsWith('.js') && !f.endsWith('i18n.js'))) {
    const js = fs.readFileSync(fp, 'utf8');
    for (const m of js.matchAll(/\b(?:tr|translator|t)\(\s*["']([a-zA-Z0-9_.]+)["']/g)) {
      allKeys.add(m[1]);
    }
  }
  const missingZh = [...allKeys].filter((k) => !(k in DICT['zh-CN']));
  const missingEn = [...allKeys].filter((k) => !(k in DICT.en));
  assert.deepEqual(missingZh, [], `Missing zh-CN i18n keys: ${missingZh.join(', ')}`);
  assert.deepEqual(missingEn, [], `Missing en i18n keys: ${missingEn.join(', ')}`);

  // 3. Styles: zero hardcoded hex outside :root and dropdown constrained for 360px container
  const cssNoRoot = css.replace(/:root\s*\{[\s\S]*?\}/, '');
  const hexMatches = [...cssNoRoot.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  assert.deepEqual(hexMatches, []);
  assert.match(css, /max-width:\s*calc\(100cqw\s*-\s*28px\)/);
});

test('mountMonitorApp E2E DOM behavior: Follow Latest, force=1, honest no_baseline badge, desktop backdrop toggle, light canvas inversion, and XSS safety', async (t) => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const { document } = createMiniDom(html);

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    Headers: globalThis.Headers,
  };

  const windowListeners = new Map();
  const requests = [];
  const toggleCalls = [];
  const xssTitle = '<img src=x onerror=alert(1)> Session';
  const xssModel = '<script>window.__xss=1</script>model-x';

  let snapshotRound = 0;
  const mockPrefs = {
    language: 'zh-CN',
    windowCap: 512000,
    defaultModel: { id: 'gemini-4-hydrogen-xhigh', tier: 'high' },
    activePromptId: 'official',
    prompts: [
      { id: 'official', name: '官方原版', group: 'official', tokens: 0, bytes: 0 },
      { id: 'custom-xss', name: '<script>evil()</script>Rule', group: 'custom', tokens: 42, bytes: 100 },
    ],
    themeState: {
      activePaletteId: 'default',
      colors: {
        accent: '#3570e4',
        contrast: '#e99315',
        tertiary: '#2ec4b6',
        canvas: '#070709',
        chrome: '#111015',
        bubble: '#131317',
      },
      syncGlobal: true,
      backdropEnabled: true,
      hostThemeMode: 'backdrop',
      hostBlendPct: 18,
      activeWallpaperId: 'wp-4',
      customWallpapers: [],
      opacity: 32,
      blur: 4,
      dim: 52,
      radius: 12,
      fit: 'cover',
    },
    backdropStatus: {
      supported: true,
      compiled: true,
      desktopIsolated: true,
      running: false,
      trackedCount: 0,
      appliedAlpha: 255,
      backdropEnabled: true,
      hostThemeMode: 'backdrop',
      hostBlendPct: 18,
      hasWallpaper: true,
      quickLaunchCommand: 'wscript.exe //Nologo "C:\\demo\\launch_backdrop.vbs"',
    },
    availableModels: [{ id: 'flash', label: 'Flash', provider: 'Google', tier: 'fast' }],
  };

  const makeMockSnapshot = () => {
    snapshotRound += 1;
    const isSecond = snapshotRound >= 2;
    return {
      unchanged: false,
      etag: `etag-${snapshotRound}`,
      activeConvId: isSecond ? 'conv-latest-2' : 'conv-latest-1',
      contextPie: {
        conversationId: isSecond ? 'conv-latest-2' : 'conv-latest-1',
        windowCap: 512000,
        totalUsed: 0,
        percent: 0,
        segments: { systemBase: 0, rulesAddon: 0, userHistory: 0, toolsAndOutputs: 0, remaining: 512000 },
      },
      tokenUsage: {
        scope: 'global',
        range: '30d',
        totalTokens: 5000,
        estimatedApiRefCostUsd: 0,
        models: [
          {
            model: '__unrecorded__',
            totalTokens: 3000,
            estimatedCostUsd: null,
            isUnpriced: true,
            uncachedInput: 1000,
            cacheRead: 1500,
            output: 500,
            cacheHitPct: 60,
          },
          {
            model: xssModel,
            totalTokens: 2000,
            estimatedCostUsd: 0.01,
            uncachedInput: 500,
            cacheRead: 1000,
            output: 500,
            cacheHitPct: 67,
          },
        ],
      },
      sessionsHub: {
        active: [{ id: 'conv-latest-1', title: xssTitle, workspace: 'ws', status: 'running', modifiedMs: 1000 }],
        unread: [],
        recent: [{ id: 'conv-latest-2', title: 'Recent Clean', workspace: 'ws', status: 'waiting', modifiedMs: 2000 }],
        favorites: [],
        allSelectable: [],
      },
      runtimeTelemetry: {
        latestTokPerSec: 88.4,
        avgTokPerSec: 70.0,
        speedSource: 'tool_step_e2e_est',
        upstreamModelId: xssModel,
        upstreamModelStatus: snapshotRound === 1 ? 'no_baseline' : 'match',
        cacheHitPct: 60,
      },
      availableModels: [
        { id: 'flash', label: 'Flash', provider: 'Google', tier: 'fast' },
        { id: xssModel, label: xssModel, provider: 'Google', tier: 'high' },
      ],
    };
  };

  const mockQuota = {
    ok: true,
    available: true,
    stale: false,
    fetchedAtMs: Date.now(),
    groups: [
      {
        key: 'gemini',
        label: 'Gemini',
        displayName: 'Gemini Models',
        description: 'Gemini 4 Neon, Gemini 3.8 Flash',
        fiveHour: {
          bucketId: 'gemini-5h',
          window: '5h',
          remainingFraction: 0.919,
          remainingPct: 92,
          remainingPctExact: 91.9,
          resetTimeMs: Date.now() + 4 * 3600_000 + 47 * 60_000,
          isFull: false,
          disabled: false,
        },
        weekly: {
          bucketId: 'gemini-weekly',
          window: 'weekly',
          remainingFraction: 0.61,
          remainingPct: 61,
          remainingPctExact: 61,
          resetTimeMs: Date.now() + 6 * 86400_000 + 8 * 3600_000,
          isFull: false,
          disabled: false,
        },
      },
      {
        key: 'gpt_claude',
        label: 'GPT&Claude',
        displayName: 'Claude and GPT models',
        description: 'Claude Opus 5.5, GPT-OSS 120B',
        fiveHour: {
          bucketId: '3p-5h',
          window: '5h',
          remainingFraction: 1,
          remainingPct: 100,
          remainingPctExact: 100,
          resetTimeMs: Date.now() + 5 * 3600_000,
          isFull: true,
          disabled: false,
        },
        weekly: {
          bucketId: '3p-weekly',
          window: 'weekly',
          remainingFraction: 0.27,
          remainingPct: 27,
          remainingPctExact: 27,
          resetTimeMs: Date.now() + 3 * 86400_000 + 2 * 3600_000,
          isFull: false,
          disabled: false,
        },
      },
      {
        key: 'argon',
        label: 'Argon',
        displayName: 'Gemini 4 Argon',
        description: 'Argon weekly bucket',
        fiveHour: null,
        weekly: {
          bucketId: 'gemini-argon-wtu-weekly',
          window: 'weekly',
          remainingFraction: 0.9997,
          remainingPct: 100,
          remainingPctExact: 100,
          resetTimeMs: Date.now() + 6 * 86400_000 + 11 * 3600_000,
          isFull: false,
          disabled: false,
        },
      },
    ],
  };

  const mockWindow = {
    location: { search: '?token=tok-1&conversationId=conv-boot' },
    sidecar: {
      conversationId: 'conv-boot',
      async fetch(url, options = {}) {
        requests.push({ url: String(url), method: options.method || 'GET', body: options.body || null });
        const payload = url.startsWith('/api/preferences')
          ? mockPrefs
          : url.startsWith('/api/quota')
            ? mockQuota
            : url.startsWith('/api/update/releases')
              ? {
                  ok: true,
                  currentVersion: '1.1.1',
                  releases: [
                    {
                      version: '1.2.0',
                      tag: 'v1.2.0',
                      date: '2026-11-25',
                      title: 'v1.2.0 Next Release',
                      body: '- Upcoming cool feature',
                    },
                  ],
                }
              : url.startsWith('/api/update/apply')
                ? (() => {
                    const parsedBody = options.body ? JSON.parse(String(options.body)) : {};
                    const ver = parsedBody.targetVersion || '1.1.1';
                    return {
                      ok: true,
                      updated: true,
                      action: ver === '1.1.0' ? 'rollback' : 'update',
                      version: ver,
                      status: { currentVersion: ver, remoteVersion: '1.2.0', hasUpdate: ver !== '1.2.0' },
                    };
                  })()
                : makeMockSnapshot();
        return {
          ok: true,
          status: 200,
          async json() {
            return payload;
          },
        };
      },
      onWorkspaceChange() {
        return () => {};
      },
      ui: {
        toggleConversation(arg) {
          toggleCalls.push(arg);
        },
      },
    },
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      windowListeners.get(type)?.delete(fn);
    },
  };

  globalThis.document = document;
  globalThis.window = mockWindow;

  const { mountMonitorApp } = await import(`${pathToFileURL(path.join(FRONTEND_DIR, 'app.js')).href}?test=${Date.now()}`);
  const controller = mountMonitorApp();

  t.after(() => {
    controller?.destroy?.();
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
  });

  await controller.readyPromise;

  // 1. Follow Latest kept requested convId="" and default filter is current + today
  const firstSnapReq = requests.find((r) => r.url.startsWith('/api/snapshot'));
  assert.ok(firstSnapReq);
  const firstParams = new URL(`http://local${firstSnapReq.url}`).searchParams;
  assert.equal(firstParams.get('convId'), '');
  assert.equal(firstParams.get('scope'), 'current');
  assert.equal(firstParams.get('range'), 'today');
  assert.equal(controller.state.followLatest, true);
  assert.equal(controller.state.lockedConvId, '');

  // First snapshot had no_baseline => badge says 未设对照 (NOT misleading 一致)
  assert.equal(document.getElementById('telemetryUpstreamBadge').textContent, '未设对照');

  // Second poll in Follow Latest still requests convId="" (not frozen to 'conv-latest-1')
  await controller.refreshSnapshot({ force: false });
  const snapReqs = requests.filter((r) => r.url.startsWith('/api/snapshot'));
  assert.equal(new URL(`http://local${snapReqs[1].url}`).searchParams.get('convId'), '');
  assert.equal(document.getElementById('telemetryUpstreamBadge').textContent, '一致');

  // 2. Manual refresh button triggers force=1 and refreshes models from snapshot
  document.getElementById('manualRefreshBtn').click();
  await new Promise((r) => setTimeout(r, 15));
  const forcedReq = requests.filter((r) => r.url.startsWith('/api/snapshot')).pop();
  assert.equal(new URL(`http://local${forcedReq.url}`).searchParams.get('force'), '1');
  assert.ok(controller.state.preferences.availableModels.some((m) => m.id === xssModel));

  // 3. Desktop backdrop companion status + quick launch command + blend slider & toggle
  assert.equal(document.getElementById('backdropBlendVal').textContent, '18%');
  assert.equal(document.getElementById('copyBackdropCmdBtn').hidden, false);
  assert.equal(document.getElementById('backdropCmdInput').hidden, false);
  assert.ok(document.getElementById('backdropCmdInput').value.includes('launch_backdrop.vbs'));

  document.getElementById('backdropToggleBtn').click();
  await new Promise((r) => setTimeout(r, 15));
  const bdReq = requests.find((r) => r.url.startsWith('/api/theme/backdrop/action'));
  assert.ok(bdReq);
  assert.equal(JSON.parse(bdReq.body).backdropEnabled, false);

  // 4. Read-only theme-change light background triggers dark text token inversion
  for (const fn of windowListeners.get('message') || []) {
    fn({ data: { type: 'theme-change', payload: { cssVariables: { '--background': '#f5f7fa', '--foreground': '#1a1d26' } } } });
  }
  assert.equal(document.documentElement.classList.contains('is-light-canvas'), true);
  const textColor = document.documentElement.style.getPropertyValue('--text-primary');
  assert.ok(textColor && textColor !== '#e8e7ec', `Expected dark ink text for light canvas, got ${textColor}`);

  // 5. Clicking session row sends pure string id via toggleConversation and locks session
  const firstSessionRow = document.getElementById('activeSessionsList').children[0];
  firstSessionRow.click();
  assert.equal(toggleCalls[0], 'conv-latest-1');
  assert.equal(controller.state.followLatest, false);
  assert.equal(controller.state.lockedConvId, 'conv-latest-1');

  // 6. XSS safety: no <script> or untrusted <img> injected by titles, models, or prompt presets
  const allDomText = document.body.textContent;
  assert.ok(allDomText.includes(xssTitle));
  assert.equal(document.querySelectorAll('script').length, 0);
  const activeSessionEl = document.getElementById('activeSessionsList');
  const tokenModelsEl = document.getElementById('tokenModelsList');
  const promptDropdownEl = document.getElementById('promptDropdown');
  assert.equal(activeSessionEl.querySelectorAll('img, script').length, 0);
  assert.equal(tokenModelsEl.querySelectorAll('img, script').length, 0);
  assert.equal(promptDropdownEl.querySelectorAll('img, script').length, 0);
  for (const img of document.querySelectorAll('img')) {
    assert.equal(img.getAttribute('onerror'), null);
    assert.notEqual(img.getAttribute('src'), 'x');
  }
  assert.ok(tokenModelsEl.textContent.includes('历史未记录模型'));
  assert.ok(tokenModelsEl.textContent.includes('未定价参考'));

  // 7. Native quota cards strip renders Gemini / GPT&Claude (dropping legacy Argon) with rings and click-to-refresh
  const quotaStripEl = document.getElementById('quotaCardsStrip');
  assert.ok(quotaStripEl);
  assert.equal(quotaStripEl.children.length, 2);
  assert.ok(quotaStripEl.textContent.includes('Gemini'));
  assert.ok(quotaStripEl.textContent.includes('GPT&Claude'));
  assert.equal(quotaStripEl.textContent.includes('Argon'), false);
  assert.ok(quotaStripEl.textContent.includes('92%'));
  assert.ok(quotaStripEl.textContent.includes('61%'));
  assert.ok(quotaStripEl.textContent.includes('27%'));
  assert.ok(quotaStripEl.textContent.includes('满额可用'));
  assert.equal(quotaStripEl.querySelectorAll('svg').length, 4);
  quotaStripEl.children[0].click();
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(requests.some((r) => r.url === '/api/quota?force=1'));

  // 8. Topbar changelog button opens release notes modal with per-version 更新 / 当前版本 / 回退 buttons
  const changelogBtn = document.getElementById('changelogBtn');
  const changelogModal = document.getElementById('changelogModal');
  assert.ok(changelogBtn && changelogModal);
  assert.equal(changelogModal.hidden, true);
  changelogBtn.click();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(changelogModal.hidden, false);

  const btn120 = changelogModal.querySelector('[data-changelog-action-version="1.2.0"]');
  const btn111 = changelogModal.querySelector('[data-changelog-action-version="1.1.1"]');
  const btn110 = changelogModal.querySelector('[data-changelog-action-version="1.1.0"]');
  assert.equal(btn120?.textContent, '更新');
  assert.equal(btn111?.textContent, '当前版本');
  assert.equal(btn111?.disabled, true);
  assert.equal(btn110?.textContent, '回退');

  // Clicking 回退 on v1.1.0 posts targetVersion='1.1.0' and immediately flips v1.1.0 -> 当前版本 & v1.1.1 -> 更新
  btn110.click();
  await new Promise((r) => setTimeout(r, 25));
  const applyReq = requests.find((r) => r.url === '/api/update/apply');
  assert.ok(applyReq);
  assert.equal(JSON.parse(String(applyReq.body)).targetVersion, '1.1.0');
  assert.equal(changelogModal.querySelector('[data-changelog-action-version="1.1.0"]')?.textContent, '当前版本');
  assert.equal(changelogModal.querySelector('[data-changelog-action-version="1.1.1"]')?.textContent, '更新');
});

test('buildFrontendBundle compiles valid non-module classic script and mounts cleanly', async () => {
  const { buildFrontendBundle } = await import(
    pathToFileURL(path.join(ROOT, 'sidecars', 'agy_monitor', 'backend', 'bundle_builder.mjs')).href
  );
  const bundleCode = await buildFrontendBundle(FRONTEND_DIR);
  assert.equal(/\b(import|export)\s+(?:function|const|\{)/.test(bundleCode), false);
  const script = new vm.Script(bundleCode, { filename: 'bundle.js' });

  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const { document } = createMiniDom(html);
  document.readyState = 'interactive';

  const requests = [];
  const win = {
    location: { search: '?token=tok-vm', pathname: '/' },
    sidecar: {
      conversationId: 'conv-vm',
      async fetch(url) {
        requests.push(String(url));
        const body = url.startsWith('/api/preferences')
          ? { language: 'zh-CN', windowCap: 512000, prompts: [], themeState: {}, availableModels: [] }
          : {
              unchanged: false,
              etag: 'vm-1',
              activeConvId: 'conv-vm',
              contextPie: { windowCap: 512000, totalUsed: 0, percent: 0, segments: {} },
              tokenUsage: { scope: 'global', range: '30d', totalTokens: 0, estimatedApiRefCostUsd: 0, models: [] },
              sessionsHub: { active: [{ id: 'conv-vm', title: 'VM Session', status: 'running' }], unread: [], recent: [], favorites: [], allSelectable: [] },
              runtimeTelemetry: { latestTokPerSec: 50, avgTokPerSec: 45, upstreamModelId: 'gemini-4-neon-xhigh', upstreamModelStatus: 'no_baseline' },
              availableModels: [],
            };
        return { ok: true, status: 200, async json() { return body; } };
      },
      onWorkspaceChange() { return () => {}; },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const sandbox = vm.createContext({
    window: win,
    document,
    Headers,
    URL,
    URLSearchParams,
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    Map,
    Set,
  });
  sandbox.globalThis = sandbox;
  script.runInContext(sandbox);

  assert.equal(win.__agyBundleExecuted, true);
  assert.equal(win.__agyMonitorMounted, true);
  const controller = win.__agyMonitorMount?.();
  await controller?.readyPromise;
  controller?.destroy?.();

  assert.ok(requests.some((u) => u.startsWith('/api/preferences')));
  assert.ok(requests.some((u) => u.startsWith('/api/snapshot')));
  assert.equal(document.getElementById('activeConvName').textContent, 'VM Session');
});

test('Other tab & quota master toggle: default ON, turning OFF stops all /api/quota calls and adapts general + accounts UI', async (t) => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const { document } = createMiniDom(html);

  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
  };

  let quotaEnabled = true;
  const requests = [];
  const mockAccounts = {
    ok: true,
    supported: true,
    dpapiProtected: true,
    quotaQueryEnabled: true,
    officialActiveOnly: true,
    currentEmail: 'alice@gmail.com',
    hasLiveCredential: true,
    groups: ['default', 'pro'],
    builtinGroups: ['default', 'pro'],
    settings: {
      quotaRefreshIntervalMin: 5,
      autoSwitchTarget: 'gemini',
      autoSwitchEnabled: false,
      backgroundRefreshInactive: false,
      sortBy: 'gemini',
      sortOrder: 'desc',
    },
    accounts: [
      {
        id: 'acc-1',
        email: 'alice@gmail.com',
        group: 'pro',
        enabled: true,
        isCurrent: true,
        remark: 'Main',
        quota: {
          fetchedAtMs: Date.now(),
          groups: [
            {
              key: 'gemini',
              label: 'Gemini',
              fiveHour: { remainingPct: 88, isFull: false, disabled: false },
              weekly: { remainingPct: 60, isFull: false, disabled: false },
            },
          ],
        },
      },
    ],
  };

  const buildCompliance = () => ({
    quotaQueryEnabled: quotaEnabled,
    activeSource: quotaEnabled ? 'official_local_ls' : 'disabled',
    hasLocalLs: true,
    directCloudCodeBlocked: true,
    statusLine: { configured: false, configuredByOther: false, fresh: false, slashCommand: '/statusline' },
  });

  const mockWindow = {
    location: { search: '?token=tok-other' },
    sidecar: {
      conversationId: 'conv-other',
      async fetch(url, options = {}) {
        const u = String(url);
        requests.push({ url: u, method: options.method || 'GET', body: options.body || null });
        if (u === '/api/preferences/quota-query' && options.method === 'POST') {
          const body = JSON.parse(String(options.body || '{}'));
          quotaEnabled = body.enabled !== false;
          mockAccounts.quotaQueryEnabled = quotaEnabled;
          return {
            ok: true,
            status: 200,
            async json() {
              return { ok: true, quotaQueryEnabled: quotaEnabled, quotaCompliance: buildCompliance() };
            },
          };
        }
        if (u.startsWith('/api/preferences')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                language: 'zh-CN',
                windowCap: 512000,
                quotaQueryEnabled: quotaEnabled,
                quotaCompliance: buildCompliance(),
                prompts: [],
                themeState: {},
                availableModels: [],
              };
            },
          };
        }
        if (u.startsWith('/api/accounts')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { ...mockAccounts, quotaQueryEnabled: quotaEnabled };
            },
          };
        }
        if (u.startsWith('/api/quota')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ok: true,
                available: true,
                source: 'official_local_ls',
                groups: [
                  {
                    key: 'gemini',
                    label: 'Gemini',
                    fiveHour: { remainingFraction: 0.9, remainingPct: 90, isFull: false, disabled: false },
                    weekly: { remainingFraction: 0.7, remainingPct: 70, isFull: false, disabled: false },
                  },
                ],
              };
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              unchanged: false,
              etag: 'e-other',
              activeConvId: 'conv-other',
              quotaQueryEnabled: quotaEnabled,
              contextPie: { windowCap: 512000, totalUsed: 1000, percent: 1, segments: {} },
              tokenUsage: { scope: 'current', range: 'today', totalTokens: 1000, models: [] },
              sessionsHub: { active: [], unread: [], recent: [], favorites: [], allSelectable: [] },
              runtimeTelemetry: { latestTokPerSec: null, upstreamModelId: '', upstreamModelStatus: 'no_baseline' },
              availableModels: [],
            };
          },
        };
      },
      onWorkspaceChange() {
        return () => {};
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  globalThis.document = document;
  globalThis.window = mockWindow;

  const { mountMonitorApp } = await import(`${pathToFileURL(path.join(FRONTEND_DIR, 'app.js')).href}?other=${Date.now()}`);
  const controller = mountMonitorApp();
  t.after(() => {
    controller?.destroy?.();
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
  });

  await controller.readyPromise;
  await controller.components.accountsHub.refresh({ silent: true });

  // 1. Default ON state
  const otherTabBtn = document.querySelector('[data-subnav="other"]');
  const otherPanel = document.getElementById('panelOther');
  const toggleEl = document.getElementById('otherQuotaToggle');
  const usageCard = document.querySelector('.token-usage-card');
  const quotaStrip = document.getElementById('quotaCardsStrip');
  const accPanel = document.getElementById('panelAccounts');
  const accSummaryCard = document.getElementById('accSummaryCard');
  const accBatchBtn = document.getElementById('accBatchRefreshBtn');
  const accList = document.getElementById('accList');

  assert.ok(otherTabBtn && otherPanel && toggleEl);
  assert.equal(toggleEl.checked, true);
  assert.equal(quotaStrip.hidden, false);
  assert.equal(usageCard.classList.contains('is-quota-disabled'), false);
  assert.equal(accPanel.classList.contains('is-quota-disabled'), false);
  assert.equal(accSummaryCard.hidden, false);
  assert.equal(accBatchBtn.hidden, false);
  assert.equal(accList.querySelectorAll('.acc-quota-grid').length, 1);

  // 2. Switch to "其他" tab and turn master toggle OFF
  otherTabBtn.click();
  assert.equal(otherPanel.hidden, false);

  const quotaCallsBeforeOff = requests.filter((r) => r.url.startsWith('/api/quota')).length;
  assert.ok(quotaCallsBeforeOff >= 1);

  toggleEl.checked = false;
  toggleEl.dispatchEvent({ type: 'change', target: toggleEl });
  await new Promise((r) => setTimeout(r, 25));

  const postToggle = requests.find((r) => r.url === '/api/preferences/quota-query' && r.method === 'POST');
  assert.ok(postToggle);
  assert.equal(JSON.parse(String(postToggle.body)).enabled, false);

  // Verify seamless UI fill across General + Accounts panels
  assert.equal(quotaStrip.hidden, true);
  assert.equal(usageCard.classList.contains('is-quota-disabled'), true);
  assert.equal(accPanel.classList.contains('is-quota-disabled'), true);
  assert.equal(accSummaryCard.hidden, true);
  assert.equal(accBatchBtn.hidden, true);
  assert.equal(accList.querySelectorAll('.acc-quota-grid').length, 0);
  assert.equal(accList.querySelectorAll('.acc-quota-sync-time').length, 0);
  assert.equal(accList.textContent.includes('刷新额度'), false);
  assert.equal(accList.querySelectorAll('.acc-act-btn').length, 5);
  assert.equal(document.querySelector('[data-sort-by="gemini"]').hidden, true);
  assert.equal(document.querySelector('[data-sort-by="gpt_claude"]').hidden, true);

  // Clicking manual refresh while OFF must trigger ZERO /api/quota requests
  const quotaCallsRightAfterOff = requests.filter((r) => r.url.startsWith('/api/quota')).length;
  document.getElementById('manualRefreshBtn').click();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(
    requests.filter((r) => r.url.startsWith('/api/quota')).length,
    quotaCallsRightAfterOff,
    'Manual refresh while quota switch is OFF must never call /api/quota',
  );

  // 3. Turn toggle back ON -> restores strip & resumes /api/quota fetch
  toggleEl.checked = true;
  toggleEl.dispatchEvent({ type: 'change', target: toggleEl });
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(quotaStrip.hidden, false);
  assert.equal(usageCard.classList.contains('is-quota-disabled'), false);
  assert.equal(accPanel.classList.contains('is-quota-disabled'), false);
  assert.equal(accSummaryCard.hidden, false);
  assert.equal(accBatchBtn.hidden, false);
  assert.equal(accList.querySelectorAll('.acc-quota-grid').length, 1);
  assert.ok(
    requests.filter((r) => r.url.startsWith('/api/quota')).length > quotaCallsRightAfterOff,
    'Turning quota switch back ON must resume /api/quota fetch',
  );
});

test('Issue #7 CSS & shared-wallpaper GPU texture elimination: display:none, backgroundImage=none, .mg-edge-flow active-only animation, and body.lite-mode rules', async (t) => {
  const css = fs.readFileSync(STYLES_CSS_PATH, 'utf8');
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  // 1. CSS static assertions for shared wallpaper display:none
  const backdropSharedBlock = /body\.host-backdrop-shared\s+\.workspace-wallpaper-layer\s*\{([^}]*)\}/.exec(css);
  assert.ok(backdropSharedBlock, 'Missing body.host-backdrop-shared .workspace-wallpaper-layer block');
  assert.match(backdropSharedBlock[1], /display:\s*none\s*!important/);
  assert.match(backdropSharedBlock[1], /opacity:\s*0\s*!important/);

  const cssSharedBlock = /body\.host-css-shared\s+\.workspace-wallpaper-layer\s*\{([^}]*)\}/.exec(css);
  assert.ok(cssSharedBlock, 'Missing body.host-css-shared .workspace-wallpaper-layer block');
  assert.match(cssSharedBlock[1], /display:\s*none\s*!important/);
  assert.match(cssSharedBlock[1], /opacity:\s*0\s*!important/);

  // 2. CSS static assertions for .mg-edge-flow active-only animation
  const edgeFlowBase = /\.mg-edge-flow\s*\{([^}]*)\}/.exec(css);
  assert.ok(edgeFlowBase, 'Missing .mg-edge-flow base rule');
  assert.equal(/\banimation\s*:/.test(edgeFlowBase[1]), false, '.mg-edge-flow must not animate while idle/invisible');
  const edgeFlowActive = /\.mg-edge-group\.is-live\s+\.mg-edge-flow,\s*\.mg-edge-group\.is-highlighted\s+\.mg-edge-flow\s*\{([^}]*)\}/.exec(css);
  assert.ok(edgeFlowActive, 'Missing active .mg-edge-flow rule');
  assert.match(edgeFlowActive[1], /animation:\s*mgDashFlow/);

  // 3. CSS static assertions for body.lite-mode
  assert.match(css, /body\.lite-mode\s+\.acc-item-card[\s\S]*?backdrop-filter:\s*none\s*!important/);
  assert.match(css, /body\.lite-mode\s+\.bg-card[\s\S]*?backdrop-filter:\s*none\s*!important/);
  assert.match(css, /body\.lite-mode\s+\.modal-dialog[\s\S]*?-webkit-backdrop-filter:\s*none\s*!important/);
  assert.match(css, /html\.is-light-canvas\s+body\.lite-mode/);

  // 4. Runtime theme_studio shared-mode texture drop + clean restore
  const { document } = createMiniDom(html);
  const prevGlobals = { document: globalThis.document, window: globalThis.window };
  globalThis.document = document;
  globalThis.window = { location: { pathname: '/' }, addEventListener() {}, removeEventListener() {} };

  const { createThemeStudio } = await import(
    `${pathToFileURL(path.join(FRONTEND_DIR, 'components', 'theme_studio.js')).href}?shared=${Date.now()}`
  );
  const studio = createThemeStudio({
    apiFetch: async () => ({ ok: true, status: 200, async json() { return { ok: true }; } }),
  });
  t.after(() => {
    studio.destroy();
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
  });

  const wpLayer = document.getElementById('workspaceWallpaperLayer');
  assert.ok(wpLayer);

  // Standalone (not shared): wallpaper backgroundImage is set
  studio.update({
    themeState: { activeWallpaperId: 'wp-2', backdropEnabled: false, hostThemeMode: 'inject' },
    backdropStatus: { running: false, cdp: { styleApplied: false, connected: false }, nativeHud: { heartbeat: { wallpaperAlive: false } } },
  });
  assert.equal(document.body.classList.contains('has-wallpaper'), true);
  assert.equal(document.body.classList.contains('host-css-shared'), false);
  assert.equal(document.body.classList.contains('host-backdrop-shared'), false);
  assert.match(wpLayer.style.backgroundImage, /kind=builtin_wp&id=wp-2/);

  // Shared via host CSS inject: backgroundImage dropped to 'none'
  studio.update({
    themeState: { activeWallpaperId: 'wp-2', backdropEnabled: true, hostThemeMode: 'inject' },
    backdropStatus: { running: false, cdp: { styleApplied: true, connected: true }, nativeHud: { heartbeat: { wallpaperAlive: true } } },
  });
  assert.equal(document.body.classList.contains('host-css-shared'), true);
  assert.equal(document.body.classList.contains('has-wallpaper'), false);
  assert.equal(wpLayer.style.backgroundImage, 'none');

  // Shared via host backdrop companion: backgroundImage also dropped to 'none'
  studio.update({
    themeState: { activeWallpaperId: 'wp-2', backdropEnabled: true, hostThemeMode: 'backdrop' },
    backdropStatus: { running: true, paused: false, cdp: { styleApplied: false, connected: false } },
  });
  assert.equal(document.body.classList.contains('host-backdrop-shared'), true);
  assert.equal(document.body.classList.contains('host-css-shared'), false);
  assert.equal(wpLayer.style.backgroundImage, 'none');

  // Exit shared mode (paused companion): backgroundImage cleanly restored
  studio.update({
    themeState: { activeWallpaperId: 'wp-2', backdropEnabled: true, hostThemeMode: 'backdrop' },
    backdropStatus: { running: true, paused: true, cdp: { styleApplied: false, connected: false } },
  });
  assert.equal(document.body.classList.contains('host-backdrop-shared'), false);
  assert.equal(document.body.classList.contains('has-wallpaper'), true);
  assert.match(wpLayer.style.backgroundImage, /kind=builtin_wp&id=wp-2/);
});

test('Custom wallpaper upload helper: caps longest edge at 2560px, transcodes to WebP, and preserves safe fallbacks', async () => {
  const {
    computeCappedDimensions,
    isAnimatedGifBytes,
    isAnimatedWebpBytes,
    optimizeWallpaperUpload,
  } = await import(
    `${pathToFileURL(path.join(FRONTEND_DIR, 'components', 'theme_studio.js')).href}?wp=${Date.now()}`
  );

  // Dimension capping without upscaling
  assert.deepEqual(computeCappedDimensions(3840, 2160, 2560), { width: 2560, height: 1440, resized: true });
  assert.deepEqual(computeCappedDimensions(2000, 4000, 2560), { width: 1280, height: 2560, resized: true });
  assert.deepEqual(computeCappedDimensions(1920, 1080, 2560), { width: 1920, height: 1080, resized: false });

  // 1. Oversized 4K PNG -> resized to 2560x1440 WebP @ 0.86 quality
  let drawnArgs = null;
  let encodedArgs = null;
  let finalCanvasSize = null;
  const origLargeBase64 = 'A'.repeat(400);
  const mockSmallWebpBase64 = 'UklGRsmallwebp';
  const resLarge = await optimizeWallpaperUpload({
    dataUrl: `data:image/png;base64,${origLargeBase64}`,
    base64: origLargeBase64,
    mime: 'image/png',
    loadImage: async () => ({ naturalWidth: 3840, naturalHeight: 2160 }),
    createCanvas: () => {
      const c = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage(_img, x, y, w, h) {
            drawnArgs = { x, y, w, h };
          },
        }),
        toDataURL(mime, quality) {
          encodedArgs = { mime, quality, w: c.width, h: c.height };
          return `data:image/webp;base64,${mockSmallWebpBase64}`;
        },
      };
      finalCanvasSize = c;
      return c;
    },
  });
  assert.equal(resLarge.transcoded, true);
  assert.equal(resLarge.resized, true);
  assert.equal(resLarge.mime, 'image/webp');
  assert.equal(resLarge.base64, mockSmallWebpBase64);
  assert.deepEqual(drawnArgs, { x: 0, y: 0, w: 2560, h: 1440 });
  assert.equal(encodedArgs.mime, 'image/webp');
  assert.equal(encodedArgs.quality, 0.86);
  assert.equal(finalCanvasSize.width, 0);
  assert.equal(finalCanvasSize.height, 0);

  // 2. Fallback when WebP output is larger than original
  const resLarger = await optimizeWallpaperUpload({
    dataUrl: 'data:image/jpeg;base64,SHORT',
    base64: 'SHORT',
    mime: 'image/jpeg',
    loadImage: async () => ({ naturalWidth: 1280, naturalHeight: 720 }),
    createCanvas: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => `data:image/webp;base64,${'W'.repeat(120)}`,
    }),
  });
  assert.equal(resLarger.transcoded, false);
  assert.equal(resLarger.reason, 'larger_than_original');
  assert.equal(resLarger.mime, 'image/jpeg');
  assert.equal(resLarger.base64, 'SHORT');

  // 3. Fallback when WebP encoding fails / unsupported (browser falls back to PNG data URL)
  const resUnsupported = await optimizeWallpaperUpload({
    dataUrl: `data:image/jpeg;base64,${origLargeBase64}`,
    base64: origLargeBase64,
    mime: 'image/jpeg',
    loadImage: async () => ({ naturalWidth: 3000, naturalHeight: 2000 }),
    createCanvas: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => 'data:image/png;base64,NOTWEBP',
    }),
  });
  assert.equal(resUnsupported.transcoded, false);
  assert.equal(resUnsupported.reason, 'webp_unsupported');
  assert.equal(resUnsupported.mime, 'image/jpeg');

  // 4. Animated GIF detection & safe passthrough
  const animGifBytes = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // LSD (no GCT)
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x00, // Frame 1
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x00, // Frame 2
    0x3b,
  ]);
  assert.equal(isAnimatedGifBytes(animGifBytes), true);
  const gifB64 = Buffer.from(animGifBytes).toString('base64');
  let gifLoadCalled = false;
  const resAnimGif = await optimizeWallpaperUpload({
    dataUrl: `data:image/gif;base64,${gifB64}`,
    base64: gifB64,
    mime: 'image/gif',
    loadImage: async () => {
      gifLoadCalled = true;
      return { naturalWidth: 4000, naturalHeight: 4000 };
    },
  });
  assert.equal(gifLoadCalled, false);
  assert.equal(resAnimGif.transcoded, false);
  assert.equal(resAnimGif.reason, 'animated_gif');
  assert.equal(resAnimGif.mime, 'image/gif');

  // 5. Animated WebP detection (VP8X animation flag 0x02) & safe passthrough
  const animWebpBytes = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, // RIFF
    0x57, 0x45, 0x42, 0x50, // WEBP
    0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, // VP8X chunk (size 10)
    0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Animation bit set
  ]);
  assert.equal(isAnimatedWebpBytes(animWebpBytes), true);
  const webpB64 = Buffer.from(animWebpBytes).toString('base64');
  const resAnimWebp = await optimizeWallpaperUpload({
    dataUrl: `data:image/webp;base64,${webpB64}`,
    base64: webpB64,
    mime: 'image/webp',
  });
  assert.equal(resAnimWebp.transcoded, false);
  assert.equal(resAnimWebp.reason, 'animated_webp');
});

test('Other tab Lite Mode toggle: default OFF, toggles body.lite-mode via /api/preferences/lite-mode, and rolls back on failure', async (t) => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const { document } = createMiniDom(html);
  const prevGlobals = { document: globalThis.document, window: globalThis.window };

  let persistedLiteMode = false;
  let failNextLitePost = false;
  const requests = [];

  const mockWindow = {
    location: { search: '?token=tok-lite' },
    sidecar: {
      conversationId: 'conv-lite',
      async fetch(url, options = {}) {
        const u = String(url);
        requests.push({ url: u, method: options.method || 'GET', body: options.body || null });
        if (u === '/api/preferences/lite-mode' && options.method === 'POST') {
          if (failNextLitePost) {
            failNextLitePost = false;
            return {
              ok: false,
              status: 500,
              async json() { return { ok: false, error: 'Simulated save failure' }; },
            };
          }
          const body = JSON.parse(String(options.body || '{}'));
          persistedLiteMode = Boolean(body.enabled);
          return {
            ok: true,
            status: 200,
            async json() { return { ok: true, liteMode: persistedLiteMode }; },
          };
        }
        if (u.startsWith('/api/preferences')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                language: 'zh-CN',
                windowCap: 512000,
                quotaQueryEnabled: true,
                liteMode: persistedLiteMode,
                prompts: [],
                themeState: {},
                availableModels: [],
              };
            },
          };
        }
        if (u.startsWith('/api/quota')) {
          return { ok: true, status: 200, async json() { return { ok: true, available: false, groups: [] }; } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              unchanged: false,
              etag: 'e-lite',
              activeConvId: 'conv-lite',
              contextPie: { windowCap: 512000, totalUsed: 0, percent: 0, segments: {} },
              tokenUsage: { scope: 'current', range: 'today', totalTokens: 0, models: [] },
              sessionsHub: { active: [], unread: [], recent: [], favorites: [], allSelectable: [] },
              runtimeTelemetry: { latestTokPerSec: null, upstreamModelId: '', upstreamModelStatus: 'no_baseline' },
              availableModels: [],
            };
          },
        };
      },
      onWorkspaceChange() { return () => {}; },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  globalThis.document = document;
  globalThis.window = mockWindow;

  const { mountMonitorApp } = await import(`${pathToFileURL(path.join(FRONTEND_DIR, 'app.js')).href}?lite=${Date.now()}`);
  const controller = mountMonitorApp();
  t.after(() => {
    controller?.destroy?.();
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
  });

  await controller.readyPromise;

  const liteToggle = document.getElementById('otherLiteModeToggle');
  const liteBadge = document.getElementById('otherLiteModeBadge');
  const liteCard = document.getElementById('otherLiteModeCard');
  assert.ok(liteToggle && liteBadge && liteCard);

  // Default OFF
  assert.equal(liteToggle.checked, false);
  assert.equal(document.body.classList.contains('lite-mode'), false);
  assert.equal(controller.state.liteMode, false);
  assert.equal(liteBadge.classList.contains('is-muted'), true);

  // Turn ON
  liteToggle.checked = true;
  liteToggle.dispatchEvent({ type: 'change', target: liteToggle });
  await new Promise((r) => setTimeout(r, 25));

  const postOn = requests.find((r) => r.url === '/api/preferences/lite-mode' && r.method === 'POST');
  assert.ok(postOn);
  assert.equal(JSON.parse(String(postOn.body)).enabled, true);
  assert.equal(document.body.classList.contains('lite-mode'), true);
  assert.equal(controller.state.liteMode, true);
  assert.equal(liteToggle.checked, true);
  assert.equal(liteBadge.classList.contains('is-on'), true);

  // Failure rollback when attempting to turn OFF
  failNextLitePost = true;
  liteToggle.checked = false;
  liteToggle.dispatchEvent({ type: 'change', target: liteToggle });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(liteToggle.checked, true, 'Toggle should roll back to persisted ON state on error');
  assert.equal(document.body.classList.contains('lite-mode'), true);
  assert.equal(document.getElementById('toastBanner').classList.contains('is-error'), true);

  // Cleanly turn OFF
  liteToggle.checked = false;
  liteToggle.dispatchEvent({ type: 'change', target: liteToggle });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(document.body.classList.contains('lite-mode'), false);
  assert.equal(controller.state.liteMode, false);
  assert.equal(liteToggle.checked, false);
  assert.equal(liteBadge.classList.contains('is-muted'), true);
});

test('Mastery hub optimizations: unchanged polls skip DOM rebuild, image cache enforces 16-entry LRU, composer drafts store canonical base64 with LRU cap', async (t) => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const { document } = createMiniDom(html);
  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    FileReader: globalThis.FileReader,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };

  let snapProgress = 42;
  const makeMasteryPayload = (sessionId = 'sess-1') => ({
    selectedSessionId: sessionId,
    activeCount: 1,
    unreadCount: 0,
    favoriteIds: [],
    sessions: [
      {
        id: sessionId,
        project: 'demo',
        name: `Session ${sessionId}`,
        status: 'active',
        isRead: false,
        isFavorite: false,
        subAgentCount: 1,
        tag: '运行中',
        progress: snapProgress,
      },
    ],
    detailSession: {
      id: sessionId,
      project: 'demo',
      name: `Session ${sessionId}`,
      status: 'active',
      isRead: false,
      progress: snapProgress,
      summaryText: 'Running',
      goal: 'Optimize VRAM',
      master: {
        id: 'coord',
        name: 'Coordinator',
        stateKind: 'running',
        stateLabel: '运行中',
        progress: snapProgress,
        task: 'Coordinating',
        journey: {
          brief: 'Test brief',
          duration: '1m',
          foot: 'Working',
          steps: [{ type: 'msg', id: 's1', text: `Progress ${snapProgress}%` }],
        },
      },
      subs: [
        {
          id: 'sub-1',
          name: 'worker-1',
          stateKind: 'running',
          stateLabel: '运行中',
          progress: snapProgress,
          task: 'Working',
          journey: { steps: [{ type: 'msg', id: 'w1', text: 'Sub step' }] },
        },
      ],
      edges: [{ type: 'bus', from: 'coord', to: 'sub-1', dir: 'to-sub', live: true }],
    },
  });

  let currentSessionId = 'sess-1';
  const apiFetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/mastery/local-image')) {
      const p = new URL(`http://local${u}`).searchParams.get('path') || '';
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async json() { return { dataUrl: `data:image/png;base64,IMG_${p}` }; },
      };
    }
    if (u.startsWith('/api/mastery/composer/commands')) {
      return { ok: true, status: 200, async json() { return { commands: [] }; } };
    }
    if (u.startsWith('/api/mastery')) {
      return { ok: true, status: 200, async json() { return makeMasteryPayload(currentSessionId); } };
    }
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };

  globalThis.document = document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
  globalThis.FileReader = class MockFileReader {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,${file._b64}`;
      this.onload?.();
    }
  };

  const { createMasteryHub } = await import(
    `${pathToFileURL(path.join(FRONTEND_DIR, 'components', 'mastery_hub.js')).href}?mh=${Date.now()}`
  );
  const hub = createMasteryHub({ apiFetch });
  t.after(() => {
    hub.destroy();
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
    globalThis.FileReader = prevGlobals.FileReader;
    globalThis.requestAnimationFrame = prevGlobals.requestAnimationFrame;
  });

  // 1. Poll signature skips redundant DOM rebuilds when payload is unchanged
  hub.setTabActive(true);
  await new Promise((r) => setTimeout(r, 20));
  const listEl = document.getElementById('masteryCliList');
  const colMaster = document.getElementById('masteryColMaster');
  const firstRowNode = listEl.children[0];
  const firstMasterNode = colMaster.children[0];
  assert.ok(firstRowNode && firstMasterNode);

  await hub.refresh();
  assert.equal(listEl.children[0], firstRowNode, 'Unchanged poll must reuse existing CLI list row DOM node');
  assert.equal(colMaster.children[0], firstMasterNode, 'Unchanged poll must reuse existing master graph card DOM node');

  // When payload changes, DOM updates cleanly
  snapProgress = 75;
  await hub.refresh();
  assert.notEqual(listEl.children[0], firstRowNode, 'Changed poll must rebuild updated CLI list row');
  assert.notEqual(colMaster.children[0], firstMasterNode, 'Changed poll must rebuild updated master graph card');

  // Also verify unchanged poll in View 2 (detail timeline) skips rebuilding #madTimeline DOM
  document.getElementById('masteryColMaster').children[0].click();
  const timelineEl = document.getElementById('madTimeline');
  const firstTimelineChild = timelineEl.children[0];
  assert.ok(firstTimelineChild);
  await hub.refresh();
  assert.equal(timelineEl.children[0], firstTimelineChild, 'Unchanged poll in detail view must reuse existing timeline DOM');
  document.getElementById('madBackBtn').click();
  await new Promise((r) => setTimeout(r, 5));

  // 2. localImageUrlCache enforces 16-entry LRU cap + clean clearing
  for (let i = 1; i <= 16; i += 1) {
    await hub.loadLocalImage(`C:/imgs/pic-${i}.png`);
  }
  // Touch pic-1 so pic-2 becomes the LRU victim
  await hub.loadLocalImage('C:/imgs/pic-1.png');
  for (let i = 17; i <= 18; i += 1) {
    await hub.loadLocalImage(`C:/imgs/pic-${i}.png`);
  }
  const imgStats = hub.getCacheStats();
  assert.equal(imgStats.imageCacheMax, 16);
  assert.equal(imgStats.imageCacheSize, 16);
  assert.ok(imgStats.imageCacheKeys.includes('C:/imgs/pic-1.png'), 'Recently accessed entry must stay in LRU cache');
  assert.equal(imgStats.imageCacheKeys.includes('C:/imgs/pic-2.png'), false, 'Oldest untouched entry must be evicted');

  hub.clearImageCache();
  assert.equal(hub.getCacheStats().imageCacheSize, 0);

  // 3. Composer drafts store canonical base64 only (no duplicate dataUrl) & cap sessions at 12 LRU
  const composerInput = document.getElementById('madComposerInput');
  const fileInput = document.getElementById('madComposerFileInput');
  const attachStrip = document.getElementById('madAttachStrip');

  // Open master detail view for 14 different sessions, attaching an image on session 14
  for (let i = 1; i <= 14; i += 1) {
    currentSessionId = `sess-${i}`;
    await hub.refresh({ force: true });
    const masterBtn = document.getElementById('masteryColMaster').children[0];
    masterBtn.click();
    composerInput.value = `draft-${i}`;
    composerInput.dispatchEvent({ type: 'input', target: composerInput });
    if (i === 14) {
      fileInput.files = [{ name: 'shot.png', type: 'image/png', size: 128, _b64: 'QUJDRA==' }];
      fileInput.dispatchEvent({ type: 'change', target: fileInput });
    }
    document.getElementById('madBackBtn').click();
    await new Promise((r) => setTimeout(r, 5));
  }

  const draftStats = hub.getCacheStats();
  assert.equal(draftStats.composerDraftMax, 12);
  assert.equal(draftStats.composerDraftCount, 12, 'Composer drafts must be capped at 12 LRU sessions');
  assert.equal(draftStats.composerDraftKeys.includes('sess-1'), false);
  assert.equal(draftStats.composerDraftKeys.includes('sess-2'), false);
  assert.equal(draftStats.composerDraftKeys.includes('sess-14'), true);

  const draft14 = draftStats.composerDrafts.find((d) => d.id === 'sess-14');
  assert.ok(draft14 && draft14.attachments.length === 1);
  assert.equal(draft14.attachments[0].base64, 'QUJDRA==');
  assert.equal('dataUrl' in draft14.attachments[0], false, 'Attachment must not duplicate dataUrl alongside base64');
  // Re-open sess-14 and verify preview <img src> lazily derives dataUrl
  document.getElementById('masteryColMaster').children[0].click();
  const thumbImg = attachStrip.querySelector('img');
  assert.equal(thumbImg?.getAttribute?.('src') || thumbImg?.src, 'data:image/png;base64,QUJDRA==');
});

test('Accounts Hub weighted quota summary (Ultra 20x=2000%, Ultra 5x=500%, Plus=100%) and inline tier selector', async (t) => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const { document } = createMiniDom(html);
  const prevGlobals = {
    document: globalThis.document,
    window: globalThis.window,
  };

  const nowMs = Date.now();
  const makeQuota = (g5, gw, c5, cw) => ({
    fetchedAtMs: nowMs,
    groups: [
      {
        key: 'gemini',
        label: 'Gemini',
        fiveHour: { remainingPct: g5, resetTimeMs: nowMs + 3600_000, disabled: false, isFull: g5 === 100 },
        weekly: { remainingPct: gw, resetTimeMs: nowMs + 86400_000, disabled: false, isFull: gw === 100 },
      },
      {
        key: 'gpt_claude',
        label: 'GPT&Claude',
        fiveHour: { remainingPct: c5, resetTimeMs: nowMs + 3600_000, disabled: false, isFull: c5 === 100 },
        weekly: { remainingPct: cw, resetTimeMs: nowMs + 86400_000, disabled: false, isFull: cw === 100 },
      },
    ],
  });

  const accounts = [
    {
      id: 'acc-u20',
      email: 'u20@gmail.com',
      group: 'default',
      tier: 'ultra_20x',
      tierSource: 'manual',
      quotaWeight: 20,
      enabled: true,
      isCurrent: true,
      accountStatus: { state: 'healthy', code: 'OK', blocking: false },
      quota: makeQuota(50, 100, 50, 100),
    },
    {
      id: 'acc-u5',
      email: 'u5@gmail.com',
      group: 'default',
      tier: 'ultra_5x',
      tierSource: 'manual',
      quotaWeight: 5,
      enabled: true,
      isCurrent: false,
      accountStatus: { state: 'healthy', code: 'OK', blocking: false },
      quota: makeQuota(80, 60, 80, 60),
    },
    {
      id: 'acc-plus',
      email: 'plus@gmail.com',
      group: 'default',
      tier: 'plus',
      tierSource: 'auto',
      quotaWeight: 1,
      enabled: true,
      isCurrent: false,
      accountStatus: { state: 'healthy', code: 'OK', blocking: false },
      quota: makeQuota(100, 100, 100, 100),
    },
  ];

  const tierPosts = [];
  const apiFetch = async (url, options = {}) => {
    if (url === '/api/accounts') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            supported: true,
            quotaQueryEnabled: true,
            officialActiveOnly: true,
            currentEmail: 'u20@gmail.com',
            accounts,
            groups: ['default', 'pro', 'ultra 5x', 'ultra 20x'],
            settings: { sortBy: 'lastUsed', sortOrder: 'desc' },
          };
        },
      };
    }
    if (url === '/api/accounts/tier' && options.method === 'POST') {
      const body = JSON.parse(String(options.body || '{}'));
      tierPosts.push(body);
      const target = accounts.find((a) => a.id === body.accountId);
      if (target) {
        target.tier = body.tier;
        target.tierSource = body.tier ? 'manual' : '';
        target.quotaWeight = body.tier === 'ultra_20x' ? 20 : body.tier === 'ultra_5x' ? 5 : 1;
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, account: target };
        },
      };
    }
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };

  globalThis.document = document;
  globalThis.window = {
    location: { search: '' },
    addEventListener() {},
    removeEventListener() {},
  };

  const { createAccountsHub } = await import(
    `${pathToFileURL(path.join(FRONTEND_DIR, 'components', 'accounts_hub.js')).href}?tier=${Date.now()}`
  );
  const hub = createAccountsHub({ apiFetch, onToast() {} });
  t.after(() => {
    hub?.destroy?.();
    globalThis.document = prevGlobals.document;
    globalThis.window = prevGlobals.window;
  });

  await hub.refresh({ silent: true });

  // Total pool capacity = 2000% + 500% + 100% = 2600%
  assert.equal(document.getElementById('accSummaryHint').textContent, '可用总容量 2600%');
  // Gemini 5h = 50*20 + 80*5 + 100*1 = 1000 + 400 + 100 = 1500/2600%
  // Gemini weekly = 100*20 + 60*5 + 100*1 = 2000 + 300 + 100 = 2400/2600%
  const summaryText = document.getElementById('accSummaryGrid').textContent;
  assert.ok(summaryText.includes('1500/2600%'), `Expected weighted 5h 1500/2600%, got: ${summaryText}`);
  assert.ok(summaryText.includes('2400/2600%'), `Expected weighted weekly 2400/2600%, got: ${summaryText}`);

  // Changing Plus card's inline tier select to Ultra 5x updates total capacity to 3000%
  const tierSelects = document.getElementById('accList').querySelectorAll('.acc-tier-select');
  assert.equal(tierSelects.length, 3);
  const plusSelect = tierSelects.find((sel) => sel.value === 'plus');
  assert.ok(plusSelect, 'Expected inline tier selector with value="plus"');
  plusSelect.value = 'ultra_5x';
  plusSelect.dispatchEvent({ type: 'change', target: plusSelect });
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(tierPosts.length, 1);
  assert.deepEqual(tierPosts[0], { accountId: 'acc-plus', tier: 'ultra_5x' });
  assert.equal(document.getElementById('accSummaryHint').textContent, '可用总容量 3000%');
  assert.ok(document.getElementById('accSummaryGrid').textContent.includes('1900/3000%'));
});
