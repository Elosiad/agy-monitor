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
      disabled: false,
      files: [],
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
