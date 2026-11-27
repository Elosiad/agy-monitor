/**
 * Unified Antigravity Host UI Chinese Localization Engine (Dual-Channel: Native Persistent + CDP).
 *
 * Incorporates curated MIT-licensed UI localization dictionaries from:
 * - yiheng8023/antigravity-chinese (MIT License)
 * - antigravity-cn-community/Antigravity-Chinese-Localization (MIT License)
 * See THIRD_PARTY_NOTICES.md for full attribution and license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DICT_FILE = path.join(__dirname, 'host_i18n_dict.json');

export const HOST_I18N_VERSION = '2.0.0';

let cachedBundle = null;
let cachedSelfContainedScript = '';
let cachedApplyExpr = '';

export function clearHostI18nCache() {
  cachedBundle = null;
  cachedSelfContainedScript = '';
  cachedApplyExpr = '';
}

export function loadHostI18nBundle() {
  if (cachedBundle) return cachedBundle;
  try {
    const raw = fs.readFileSync(DICT_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    const exact = parsed && typeof parsed.exact === 'object' && parsed.exact ? parsed.exact : {};
    const patterns = Array.isArray(parsed?.patterns) ? parsed.patterns : [];
    cachedBundle = {
      version: HOST_I18N_VERSION,
      exact,
      patterns,
    };
  } catch {
    cachedBundle = {
      version: HOST_I18N_VERSION,
      exact: {},
      patterns: [],
    };
  }
  return cachedBundle;
}

/**
 * Pure Node translation helper sharing the same matching pipeline as the injected browser runtime
 * (used by automated tests to verify dictionary & pattern accuracy).
 */
export function translateHostTextForTest(raw, bundle = loadHostI18nBundle()) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 360 || !/[A-Za-z]/.test(trimmed)) return null;

  const exact = bundle?.exact || {};
  const patterns = Array.isArray(bundle?.patterns) ? bundle.patterns : [];

  const replaceTrimmed = (text, sub, fixed) => {
    if (text === sub) return fixed;
    const idx = text.indexOf(sub);
    return idx === -1 ? fixed : text.slice(0, idx) + fixed + text.slice(idx + sub.length);
  };
  const fmtDur = (s) =>
    String(s || '')
      .trim()
      .replace(/^<\s*1\s*m(?:in(?:ute)?s?)?$/i, '不到 1 分钟')
      .replace(/(\d+)\s*d(?:ays?)?\b/gi, '$1天')
      .replace(/(\d+)\s*h(?:(?:ou)?rs?)?\b/gi, '$1小时')
      .replace(/(\d+)\s*m(?:in(?:ute)?s?)?\b(?!\s*o)/gi, '$1分')
      .replace(/(\d+)\s*s(?:ec(?:ond)?s?)?\b/gi, '$1秒')
      .replace(/\s+/g, '');

  if (trimmed === 'NEW') return replaceTrimmed(raw, trimmed, '新');
  if (Object.prototype.hasOwnProperty.call(exact, trimmed)) {
    return replaceTrimmed(raw, trimmed, exact[trimmed]);
  }
  const normalized = trimmed.replace(/\s+/g, ' ');
  if (normalized !== trimmed && Object.prototype.hasOwnProperty.call(exact, normalized)) {
    return replaceTrimmed(raw, trimmed, exact[normalized]);
  }
  if (trimmed.length >= 3 && !(trimmed === trimmed.toUpperCase() && trimmed.length <= 4)) {
    const lower = normalized.toLowerCase();
    for (const k of Object.keys(exact)) {
      if (k.toLowerCase() === lower) {
        return replaceTrimmed(raw, trimmed, exact[k]);
      }
    }
  }
  let m;
  if ((m = /^Thought for\s+([\d\w\s<]+)$/i.exec(normalized))) {
    return replaceTrimmed(raw, trimmed, '已思考 ' + fmtDur(m[1]));
  }
  if ((m = /^Worked for\s+([\d\w\s<]+)$/i.exec(normalized))) {
    return replaceTrimmed(raw, trimmed, '已工作 ' + fmtDur(m[1]));
  }
  if ((m = /^Resets in\s+([\d\w\s<]+)$/i.exec(normalized))) {
    return replaceTrimmed(raw, trimmed, fmtDur(m[1]) + ' 后重置');
  }
  if (normalized.length <= 220) {
    for (let i = 0; i < patterns.length; i += 1) {
      const entry = patterns[i];
      try {
        const re = new RegExp(entry[0], entry[2] || '');
        if (re.test(normalized)) {
          const out = normalized.replace(re, entry[1]);
          if (out && out !== normalized) {
            return replaceTrimmed(raw, trimmed, out);
          }
        }
      } catch {
        // skip
      }
    }
  }
  return null;
}

/**
 * Browser runtime installer (versioned, zero-reflow protected, shadow-DOM aware, reversible).
 * Exposes `window.__agyMonitorHostI18n` and preserves legacy `window.__agyMonI18n` / `window.__agyHostI18nApplied`.
 */
export function buildHostI18nRuntimeScript() {
  return `(function(){
  var VERSION = ${JSON.stringify(HOST_I18N_VERSION)};
  if (window.__agyMonitorHostI18n && window.__agyMonitorHostI18n.version === VERSION) {
    return;
  }
  // Cleanly stop & restore any older v1 host translator before mounting v2
  try {
    if (window.__agyMonitorHostI18n && typeof window.__agyMonitorHostI18n.stop === 'function') {
      window.__agyMonitorHostI18n.stop();
    } else if (window.__agyMonI18n && typeof window.__agyMonI18n.stop === 'function') {
      window.__agyMonI18n.stop();
    }
  } catch (e) {}

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, KBD: 1, SAMP: 1, VAR: 1,
    SVG: 1, MATH: 1, 'MJX-CONTAINER': 1, CODE: 1, PRE: 1, INPUT: 1, TEXTAREA: 1
  };
  var LITERAL_TAGS = { CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, SVG: 1, MATH: 1, 'MJX-CONTAINER': 1 };
  var HUD_IDS = {
    'agy-monitor-native-hud': 1,
    'agy-monitor-native-hud-portal': 1,
    'agy-monitor-cdp-hud': 1
  };
  var UI_MARKDOWN_CHROME = { 'toast-notification': 1, 'nux-card': 1 };
  var SYSTEM_DROP_IDS = { all: 1, pinned: 1, standalone: 1, 'main-section-header': 1, 'section-coordinator': 1 };
  var SYSTEM_PROJECT_LABELS = {
    'show all': 1, '显示全部': 1,
    'not in project': 1, '未归入项目': 1,
    'conversations': 1, '全部对话': 1, 'all conversations': 1,
    'pinned conversations': 1, '置顶对话': 1,
    'projects': 1, '项目': 1,
    'workspaces': 1, '工作区': 1,
    'give feedback': 1, 'provide feedback': 1, '提交反馈': 1,
    'unknown project': 1, '未知项目': 1,
    'no project': 1, 'standalone': 1, 'independent': 1,
    'select a project': 1, 'all projects': 1, 'all workspaces': 1
  };
  var CODE_CLASS_RE = /(?:^|\\s)(?:monaco-|xterm|cm-|prism-|hljs|shiki|syntax-|token(?:\\s|$)|code-block|diff-line)/i;

  function isFontIcon(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.classList && (el.classList.contains('google-symbols') || el.classList.contains('material-symbols-outlined'))) {
      return true;
    }
    if (el.hasAttribute && (el.hasAttribute('data-project-icon') || el.hasAttribute('data-project-glyph') || el.hasAttribute('data-icon'))) {
      return true;
    }
    return false;
  }

  function hasAncestorTestId(el, map) {
    var cur = el;
    var depth = 0;
    while (cur && cur !== document.body && depth < 12) {
      if (cur.getAttribute) {
        var tid = cur.getAttribute('data-testid');
        if (tid && map[tid]) return true;
      }
      cur = cur.parentElement;
      depth++;
    }
    return false;
  }

  function isSystemProjectHeader(headerEl) {
    if (!headerEl || headerEl.nodeType !== 1) return false;
    var wrap = headerEl.closest ? headerEl.closest('[data-sidebar-section-drop-id]') : null;
    if (wrap) {
      var dropId = wrap.getAttribute('data-sidebar-section-drop-id') || '';
      if (SYSTEM_DROP_IDS[dropId] || dropId.indexOf('status-') === 0 || dropId.indexOf('location-') === 0) {
        return true;
      }
      if (dropId) return false;
    }
    var txt = (headerEl.textContent || '').trim().toLowerCase();
    return Boolean(txt && SYSTEM_PROJECT_LABELS[txt]);
  }

  function isUserSettingsProjectNav(el) {
    if (!el || el.nodeType !== 1 || !el.closest) return false;
    var btn = el.closest('button[data-testid^="settings-nav-item-"]');
    if (!btn) return false;
    var label = (btn.textContent || '').trim().toLowerCase();
    if (SYSTEM_PROJECT_LABELS[label]) return false;
    var tid = btn.getAttribute('data-testid') || '';
    // Official top settings sections have simple known ids; project ids are paths/uuids/workspace slugs
    if (/^settings-nav-item-(general|application|app|appearance|shortcuts|keyboard|notifications|models|model|browser|permissions|security|account|developer|advanced|privacy|about|feedback|plugins|skills|mcp|tools|editor|terminal|network|proxy|remote|voice|agent)$/i.test(tid)) {
      return false;
    }
    // Check if preceded by a Projects / Workspaces heading inside settings nav
    var prev = btn.previousElementSibling;
    var hops = 0;
    while (prev && hops < 40) {
      var tag = (prev.tagName || '').toUpperCase();
      if (tag === 'H2' || tag === 'H3' || (prev.getAttribute && prev.getAttribute('role') === 'heading') || (prev.classList && prev.classList.contains('uppercase'))) {
        var ht = (prev.textContent || '').trim().toLowerCase();
        if (ht === 'projects' || ht === 'workspaces' || ht === '项目' || ht === '工作区') return true;
        return false;
      }
      if (prev.querySelector) {
        var h = prev.querySelector('h2,h3');
        if (h) {
          var h2t = (h.textContent || '').trim().toLowerCase();
          if (h2t === 'projects' || h2t === 'workspaces' || h2t === '项目' || h2t === '工作区') return true;
          return false;
        }
      }
      prev = prev.previousElementSibling;
      hops++;
    }
    return false;
  }

  function replaceTrimmed(text, trimmed, fixed) {
    if (text === trimmed) return fixed;
    var idx = text.indexOf(trimmed);
    if (idx === -1) return fixed;
    return text.slice(0, idx) + fixed + text.slice(idx + trimmed.length);
  }

  function fmtDur(s) {
    return String(s || '')
      .trim()
      .replace(/^<\\s*1\\s*m(?:in(?:ute)?s?)?$/i, '不到 1 分钟')
      .replace(/(\\d+)\\s*d(?:ays?)?\\b/gi, '$1天')
      .replace(/(\\d+)\\s*h(?:(?:ou)?rs?)?\\b/gi, '$1小时')
      .replace(/(\\d+)\\s*m(?:in(?:ute)?s?)?\\b(?!\\s*o)/gi, '$1分')
      .replace(/(\\d+)\\s*s(?:ec(?:ond)?s?)?\\b/gi, '$1秒')
      .replace(/\\s+/g, '');
  }

  var state = {
    active: false,
    exact: null,
    lowerMap: null,
    compiledPatterns: null,
    rawPatterns: null,
    stringCache: new Map(),
    origText: new Map(),
    origAttr: new Map(),
    translatedNodes: new WeakMap(),
    skipCache: new WeakMap(),
    observers: [],
    observedRoots: new WeakSet(),
    pending: new Set(),
    flushTimer: null,
    visHandler: null,
    focusHandler: null
  };

  function cacheSet(k, v) {
    if (state.stringCache.has(k)) {
      state.stringCache.delete(k);
    } else if (state.stringCache.size >= 4000) {
      var oldest = state.stringCache.keys().next().value;
      if (oldest !== undefined) state.stringCache.delete(oldest);
    }
    state.stringCache.set(k, v);
  }

  function getCompiledPatterns() {
    if (state.compiledPatterns) return state.compiledPatterns;
    var list = [];
    var raw = state.rawPatterns || [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (!Array.isArray(item) || item.length < 2) continue;
      try {
        list.push({ re: new RegExp(item[0], item[2] || ''), rep: item[1] });
      } catch (e) {}
    }
    state.compiledPatterns = list;
    return list;
  }

  function translateString(raw) {
    if (!raw || typeof raw !== 'string') return null;
    if (raw.length > 400) return null;
    var trimmed = raw.trim();
    if (!trimmed || trimmed.length > 360 || !/[A-Za-z]/.test(trimmed)) return null;

    if (state.stringCache.has(trimmed)) {
      var cached = state.stringCache.get(trimmed);
      return cached === null ? null : replaceTrimmed(raw, trimmed, cached);
    }

    var exact = state.exact;
    if (!exact) return null;

    if (trimmed === 'NEW') {
      cacheSet(trimmed, '新');
      return replaceTrimmed(raw, trimmed, '新');
    }

    if (Object.prototype.hasOwnProperty.call(exact, trimmed)) {
      var hit = exact[trimmed];
      cacheSet(trimmed, hit);
      return replaceTrimmed(raw, trimmed, hit);
    }

    var normalized = trimmed.replace(/\\s+/g, ' ');
    if (normalized !== trimmed && Object.prototype.hasOwnProperty.call(exact, normalized)) {
      var hitNorm = exact[normalized];
      cacheSet(trimmed, hitNorm);
      return replaceTrimmed(raw, trimmed, hitNorm);
    }

    if (state.lowerMap && normalized.length >= 3 && !(normalized === normalized.toUpperCase() && normalized.length <= 4)) {
      var lowHit = state.lowerMap.get(normalized.toLowerCase());
      if (lowHit) {
        cacheSet(trimmed, lowHit);
        return replaceTrimmed(raw, trimmed, lowHit);
      }
    }

    var m;
    if ((m = /^Thought for\\s+([\\d\\w\\s<]+)$/i.exec(normalized))) {
      var tOut = '已思考 ' + fmtDur(m[1]);
      cacheSet(trimmed, tOut);
      return replaceTrimmed(raw, trimmed, tOut);
    }
    if ((m = /^Worked for\\s+([\\d\\w\\s<]+)$/i.exec(normalized))) {
      var wOut = '已工作 ' + fmtDur(m[1]);
      cacheSet(trimmed, wOut);
      return replaceTrimmed(raw, trimmed, wOut);
    }
    if ((m = /^Resets in\\s+([\\d\\w\\s<]+)$/i.exec(normalized))) {
      var rOut = fmtDur(m[1]) + ' 后重置';
      cacheSet(trimmed, rOut);
      return replaceTrimmed(raw, trimmed, rOut);
    }

    if (normalized.length <= 220) {
      var pats = getCompiledPatterns();
      for (var i = 0; i < pats.length; i++) {
        var p = pats[i];
        if (p.re.test(normalized)) {
          var out = normalized.replace(p.re, p.rep);
          if (out && out !== normalized) {
            cacheSet(trimmed, out);
            return replaceTrimmed(raw, trimmed, out);
          }
        }
      }
    }

    cacheSet(trimmed, null);
    return null;
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;

    if (el.isContentEditable || (el.getAttribute && (
      el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('role') === 'textbox' ||
      el.getAttribute('data-lexical-editor') === 'true'
    ))) {
      return true;
    }

    var tag = (el.tagName || '').toUpperCase();
    if (SKIP_TAGS[tag] || isFontIcon(el)) {
      state.skipCache.set(el, true);
      return true;
    }

    if (el.id && HUD_IDS[el.id]) {
      state.skipCache.set(el, true);
      return true;
    }

    // Allow thinking collapsible trigger pill ("Thought for 4s")
    if (el.closest && el.closest('button[data-testid="thinking-collapsible-trigger"]')) {
      return false;
    }

    // Allow queued/user action decorators outside message body
    if (el.closest && el.closest('[data-testid="queued-decorators"],[data-testid="user-message-actions"]')) {
      if (!el.closest('[data-testid="user-message-content"]')) return false;
    }

    // Protect user project header cards (allow system group headers like Pinned / Show All)
    var projHeader = el.closest ? el.closest('[data-testid="project-header"],button[data-project-card="true"]') : null;
    if (projHeader && !isSystemProjectHeader(projHeader)) {
      return true;
    }

    // Protect user project items listed under Projects in Settings sidebar
    if (isUserSettingsProjectNav(el)) {
      return true;
    }

    if (state.skipCache.has(el)) {
      return state.skipCache.get(el);
    }

    var cur = el;
    var skip = false;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (state.skipCache.has(cur)) {
        skip = state.skipCache.get(cur);
        break;
      }
      if (cur.id && HUD_IDS[cur.id]) { skip = true; break; }
      var cTag = (cur.tagName || '').toUpperCase();
      if (LITERAL_TAGS[cTag] || isFontIcon(cur)) { skip = true; break; }

      if (cur.getAttribute) {
        var tid = cur.getAttribute('data-testid');
        if (tid === 'user-message-content' || tid === 'assistant-markdown' || tid === 'markdown-content') {
          skip = true; break;
        }
        if (cur.hasAttribute('data-markdown-root') && !hasAncestorTestId(cur, UI_MARKDOWN_CHROME)) {
          skip = true; break;
        }
        if (
          cur.getAttribute('contenteditable') === 'true' ||
          cur.getAttribute('role') === 'textbox' ||
          cur.getAttribute('role') === 'code' ||
          cur.getAttribute('data-lexical-editor') === 'true' ||
          cur.hasAttribute('data-language') ||
          cur.hasAttribute('data-code') ||
          cur.hasAttribute('data-line') ||
          cur.hasAttribute('data-line-number')
        ) {
          skip = true; break;
        }
      }

      if (cur.classList && (
        cur.classList.contains('user-message') ||
        cur.classList.contains('group/user-input-step') ||
        cur.classList.contains('thought-content') ||
        cur.classList.contains('thinking-content') ||
        cur.classList.contains('thought-box') ||
        cur.classList.contains('monaco-editor') ||
        cur.classList.contains('editor-instance') ||
        cur.classList.contains('xterm') ||
        cur.classList.contains('cm-editor') ||
        cur.classList.contains('katex') ||
        cur.classList.contains('katex-display') ||
        cur.classList.contains('katex-html') ||
        cur.classList.contains('mjx-container')
      )) {
        skip = true; break;
      }

      if (cur.parentElement && cur.parentElement.querySelector) {
        var trig = cur.parentElement.querySelector(':scope > button[data-testid="thinking-collapsible-trigger"]');
        if (trig && cur !== trig && (!trig.contains || !trig.contains(cur))) {
          skip = true; break;
        }
      }

      if (cur.className && typeof cur.className === 'string') {
        var lc = cur.className.toLowerCase();
        if (lc.indexOf('code-line') !== -1 || lc.indexOf('view-line') !== -1 || CODE_CLASS_RE.test(cur.className)) {
          skip = true; break;
        }
      }

      cur = cur.parentElement;
    }

    state.skipCache.set(el, skip);
    return skip;
  }

  function setTextSafe(node, nextVal) {
    var cur = node.nodeValue;
    if (cur === nextVal) return;
    if (!state.origText.has(node)) state.origText.set(node, cur);
    node.nodeValue = nextVal;
    state.translatedNodes.set(node, nextVal);
  }

  function processTextNode(node) {
    if (!node || node.nodeType !== 3) return;
    var parent = node.parentElement;
    if (!parent || shouldSkipElement(parent)) return;
    var cur = node.nodeValue;
    if (!cur || !cur.trim()) return;
    if (state.translatedNodes.get(node) === cur) return;
    var tr = translateString(cur);
    if (tr && tr !== cur) {
      setTextSafe(node, tr);
    } else {
      state.translatedNodes.set(node, cur);
    }
  }

  function processElementAttrs(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.id && HUD_IDS[el.id]) return;
    var tag = (el.tagName || '').toUpperCase();
    var isInputLike = tag === 'INPUT' || tag === 'TEXTAREA';
    if (isInputLike) {
      if (el.parentElement && shouldSkipElement(el.parentElement)) return;
    } else if (shouldSkipElement(el)) {
      return;
    }
    var attrs = ['placeholder', 'aria-label', 'title'];
    for (var i = 0; i < attrs.length; i++) {
      var k = attrs[i];
      var val = el.getAttribute(k);
      if (!val) continue;
      var tr = translateString(val);
      if (tr && tr !== val) {
        var rec = state.origAttr.get(el);
        if (!rec) {
          rec = {};
          state.origAttr.set(el, rec);
        }
        if (!Object.prototype.hasOwnProperty.call(rec, k)) rec[k] = val;
        el.setAttribute(k, tr);
      }
    }
  }

  // Handle React split inline-link sentences (e.g. "Scan the code..., or <a>copy link</a>.")
  // without mutating element structure so React Fiber stays 100% intact.
  function tryCombinedSentence(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return false;
    var kids = el.childNodes;
    if (!kids || kids.length < 2 || kids.length > 7) return false;
    if (shouldSkipElement(el)) return false;

    var hasInlineEl = false;
    var full = '';
    var slots = [];
    for (var i = 0; i < kids.length; i++) {
      var ch = kids[i];
      if (ch.nodeType === 3) {
        full += ch.nodeValue || '';
        slots.push({ type: 'text', node: ch });
      } else if (ch.nodeType === 1) {
        var cTag = (ch.tagName || '').toUpperCase();
        if (LITERAL_TAGS[cTag] || isFontIcon(ch)) return false;
        if (!ch.childNodes || ch.childNodes.length !== 1 || ch.firstChild.nodeType !== 3) return false;
        var aTxt = (ch.firstChild.nodeValue || '').trim();
        if (!aTxt) return false;
        hasInlineEl = true;
        full += ch.firstChild.nodeValue || '';
        slots.push({ type: 'anchor', node: ch, textNode: ch.firstChild, raw: aTxt });
      } else {
        return false;
      }
    }
    if (!hasInlineEl) return false;
    var key = full.trim();
    if (!key || key.length > 260 || !/[A-Za-z]/.test(key)) return false;

    var translated = translateString(key);
    if (!translated || translated === key) return false;

    // Match each anchor inside the translated sentence (either original or translated anchor text)
    var probe = 0;
    var anchors = [];
    for (var j = 0; j < slots.length; j++) {
      if (slots[j].type !== 'anchor') continue;
      var s = slots[j];
      var aTr = translateString(s.raw) || s.raw;
      var idx = translated.indexOf(aTr, probe);
      var used = aTr;
      if (idx < 0 && aTr !== s.raw) {
        idx = translated.indexOf(s.raw, probe);
        used = s.raw;
      }
      if (idx < 0) return false;
      s.start = idx;
      s.end = idx + used.length;
      s.nextText = used;
      probe = s.end;
      anchors.push(s);
    }
    if (anchors.length === 0) return false;

    var aIdx = 0;
    var cursor = 0;
    for (var k = 0; k < slots.length; k++) {
      var slot = slots[k];
      if (slot.type === 'anchor') {
        setTextSafe(slot.textNode, slot.nextText);
        cursor = slot.end;
        aIdx++;
      } else {
        var segEnd = aIdx < anchors.length ? anchors[aIdx].start : translated.length;
        setTextSafe(slot.node, translated.slice(cursor, segEnd));
        cursor = segEnd;
      }
    }
    return true;
  }

  function scanRoot(root) {
    if (!root || !state.active) return;
    if (root.nodeType === 3) {
      processTextNode(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (root.id && HUD_IDS[root.id]) return;
      var rTag = (root.tagName || '').toUpperCase();
      if (rTag === 'INPUT' || rTag === 'TEXTAREA') {
        processElementAttrs(root);
        return;
      }
      if (shouldSkipElement(root)) return;
      processElementAttrs(root);
      if (root.shadowRoot) {
        observeRoot(root.shadowRoot);
        scanRoot(root.shadowRoot);
      }
      tryCombinedSentence(root);
    }

    if (root.querySelectorAll) {
      var attrEls = root.querySelectorAll('[placeholder],[aria-label],[title]');
      for (var i = 0; i < attrEls.length; i++) processElementAttrs(attrEls[i]);

      var inlineContainers = root.querySelectorAll('p,div,span,label,li');
      for (var c = 0; c < inlineContainers.length; c++) {
        var ic = inlineContainers[c];
        if (ic.childNodes && ic.childNodes.length >= 2 && ic.childNodes.length <= 7 && ic.firstElementChild) {
          tryCombinedSentence(ic);
        }
      }
    }

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    var cur;
    while ((cur = walker.nextNode())) {
      if (cur.nodeType === 3) {
        processTextNode(cur);
      } else if (cur.nodeType === 1 && cur.shadowRoot) {
        observeRoot(cur.shadowRoot);
        scanRoot(cur.shadowRoot);
      }
    }
  }

  function pruneDisconnected() {
    if (state.origText.size > 800) {
      state.origText.forEach(function(_, node) {
        if (!node || !node.isConnected) state.origText.delete(node);
      });
    }
    if (state.origAttr.size > 300) {
      state.origAttr.forEach(function(_, el) {
        if (!el || !el.isConnected) state.origAttr.delete(el);
      });
    }
  }

  function flushPending() {
    state.flushTimer = null;
    if (!state.active || document.hidden) return;
    if (state.pending.size === 0) return;

    var roots = [];
    state.pending.forEach(function(node) {
      if (!node || !node.isConnected) return;
      var p = node.parentElement;
      while (p) {
        if (state.pending.has(p)) return;
        p = p.parentElement;
      }
      roots.push(node);
    });
    state.pending.clear();

    for (var i = 0; i < roots.length; i++) {
      scanRoot(roots[i]);
    }
    pruneDisconnected();
  }

  function scheduleFlush() {
    if (!state.active || document.hidden || state.flushTimer) return;
    state.flushTimer = setTimeout(flushPending, 60);
  }

  function observeRoot(root) {
    if (!root || state.observedRoots.has(root)) return;
    state.observedRoots.add(root);
    var obs = new MutationObserver(function(muts) {
      if (!state.active) return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData' && m.target) {
          state.translatedNodes.delete(m.target);
          state.pending.add(m.target);
        } else if (m.type === 'childList' && m.addedNodes) {
          for (var j = 0; j < m.addedNodes.length; j++) {
            state.pending.add(m.addedNodes[j]);
          }
        } else if (m.type === 'attributes' && m.target) {
          state.pending.add(m.target);
        }
      }
      if (state.pending.size > 0) scheduleFlush();
    });
    try {
      obs.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['placeholder', 'aria-label', 'title']
      });
      state.observers.push(obs);
    } catch (e) {}
  }

  function applyBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') return false;
    var exact = bundle.exact || {};
    var lowerMap = new Map();
    var keys = Object.keys(exact);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var lk = k.toLowerCase();
      if (!lowerMap.has(lk)) lowerMap.set(lk, exact[k]);
    }

    state.exact = exact;
    state.lowerMap = lowerMap;
    state.rawPatterns = Array.isArray(bundle.patterns) ? bundle.patterns : [];
    state.compiledPatterns = null;
    state.stringCache.clear();
    state.skipCache = new WeakMap();
    state.translatedNodes = new WeakMap();
    state.active = true;

    if (document.body) {
      scanRoot(document.body);
      observeRoot(document.body);
    }

    if (!state.visHandler) {
      state.visHandler = function() {
        if (state.active && !document.hidden && document.body) {
          scanRoot(document.body);
        }
      };
      document.addEventListener('visibilitychange', state.visHandler);
    }
    if (!state.focusHandler) {
      state.focusHandler = function() {
        if (state.active && !document.hidden && document.body) {
          scanRoot(document.body);
        }
      };
      window.addEventListener('focus', state.focusHandler);
    }

    window.__agyHostI18nApplied = true;
    return true;
  }

  function rescan() {
    if (!state.active || !document.body) return false;
    scanRoot(document.body);
    observeRoot(document.body);
    window.__agyHostI18nApplied = true;
    return true;
  }

  function stop() {
    state.active = false;
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    state.pending.clear();
    for (var i = 0; i < state.observers.length; i++) {
      try { state.observers[i].disconnect(); } catch (e) {}
    }
    state.observers = [];
    state.observedRoots = new WeakSet();

    if (state.visHandler) {
      try { document.removeEventListener('visibilitychange', state.visHandler); } catch (e) {}
      state.visHandler = null;
    }
    if (state.focusHandler) {
      try { window.removeEventListener('focus', state.focusHandler); } catch (e) {}
      state.focusHandler = null;
    }

    state.origText.forEach(function(val, node) {
      try { if (node && node.isConnected) node.nodeValue = val; } catch (e) {}
    });
    state.origText.clear();

    state.origAttr.forEach(function(rec, el) {
      try {
        if (!el || !el.isConnected) return;
        Object.keys(rec).forEach(function(k) { el.setAttribute(k, rec[k]); });
      } catch (e) {}
    });
    state.origAttr.clear();
    state.stringCache.clear();
    state.translatedNodes = new WeakMap();
    state.skipCache = new WeakMap();

    delete window.__agyHostI18nApplied;
    return true;
  }

  var api = {
    version: VERSION,
    apply: applyBundle,
    rescan: rescan,
    stop: stop,
    isApplied: function() { return Boolean(state.active); }
  };
  window.__agyMonitorHostI18n = api;
  window.__agyMonI18n = api;
})();`;
}

/**
 * Self-contained script that installs the runtime AND applies the full MIT dictionary bundle.
 * Used for native persistent `native_host_i18n.js` staging and one-time CDP bootstrap.
 */
export function buildHostI18nSelfContainedScript() {
  if (cachedSelfContainedScript) return cachedSelfContainedScript;
  const bundle = loadHostI18nBundle();
  cachedSelfContainedScript = `${buildHostI18nRuntimeScript()}
;(function(){
  if (window.__agyMonitorHostI18n && typeof window.__agyMonitorHostI18n.apply === 'function') {
    window.__agyMonitorHostI18n.apply(${JSON.stringify(bundle)});
  }
})();`;
  return cachedSelfContainedScript;
}

export function buildHostI18nApplyExpr() {
  if (cachedApplyExpr) return cachedApplyExpr;
  cachedApplyExpr = `(function(){
  if (window.__agyMonitorHostI18n && window.__agyMonitorHostI18n.version === ${JSON.stringify(HOST_I18N_VERSION)} && window.__agyMonitorHostI18n.isApplied()) {
    window.__agyMonitorHostI18n.rescan();
    return true;
  }
  ${buildHostI18nSelfContainedScript()}
  return Boolean(window.__agyHostI18nApplied);
})()`;
  return cachedApplyExpr;
}

export function buildHostI18nRescanExpr() {
  return `(function(){
  if (window.__agyMonitorHostI18n && window.__agyMonitorHostI18n.version === ${JSON.stringify(HOST_I18N_VERSION)} && window.__agyMonitorHostI18n.isApplied()) {
    window.__agyMonitorHostI18n.rescan();
    return true;
  }
  return false;
})()`;
}

export function buildHostI18nRestoreExpr() {
  return `(function(){
  if (window.__agyMonitorHostI18n && typeof window.__agyMonitorHostI18n.stop === 'function') {
    window.__agyMonitorHostI18n.stop();
  } else if (window.__agyMonI18n && typeof window.__agyMonI18n.stop === 'function') {
    window.__agyMonI18n.stop();
  }
  return true;
})()`;
}
