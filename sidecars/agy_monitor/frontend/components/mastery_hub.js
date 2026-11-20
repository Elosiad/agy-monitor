/**
 * Mastery ("掌握") tab controller:
 * - Top flat session process bar (active first -> completed unread, right progress ring follows Main Agent)
 * - Summary model row (default OFF; single radio "自身模型" vs "第三方模型" modal; expanded frequency & thinking)
 * - View 1: Task total progress (follows Main Agent) + Left-Master / Right-Sub 3-state SVG collaboration graph
 * - View 2: Codex-style Agent execution journey (brief, opening thought & summaries, collapsible classified actions)
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const POLL_INTERVAL_MS = 2000;

const PROTOCOL_PRESETS = {
  openai: {
    name: "OpenAI",
    hint: "兼容 OpenAI / DeepSeek / 中转站 / 本地 Ollama",
    urlPlaceholder: "https://api.openai.com/v1",
    keyPlaceholder: "sk-...",
    models: [
      "gpt-4o-mini",
      "gpt-4.1-nano",
      "gpt-4.1-mini",
      "deepseek-chat",
      "qwen-turbo-latest",
      "glm-4.5-air",
    ],
  },
  anthropic: {
    name: "Anthropic",
    hint: "兼容 Anthropic Messages / Claude 官方及代理中转",
    urlPlaceholder: "https://api.anthropic.com/v1",
    keyPlaceholder: "sk-ant-...",
    models: [
      "claude-3-5-haiku-latest",
      "claude-haiku-4-5",
      "claude-3-7-sonnet-latest",
      "claude-sonnet-4-5",
    ],
  },
};

function makeSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  return el;
}

function buildActionIconSvg(kind) {
  const svg = makeSvgEl("svg", {
    width: 13,
    height: 13,
    viewBox: "0 0 16 16",
    fill: "none",
    "aria-hidden": "true",
  });
  if (kind === "edit") {
    svg.appendChild(
      makeSvgEl("path", {
        d: "M11.6 2.6a1.5 1.5 0 0 1 2.1 2.1L6.2 12.2l-3 .8.8-3 7.6-7.4z",
        stroke: "currentColor",
        "stroke-width": "1.35",
        "stroke-linejoin": "round",
      })
    );
  } else if (kind === "read") {
    svg.appendChild(
      makeSvgEl("path", {
        d: "M4 2.5h5.5L13 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z",
        stroke: "currentColor",
        "stroke-width": "1.3",
        "stroke-linejoin": "round",
      })
    );
    svg.appendChild(
      makeSvgEl("path", {
        d: "M5.5 8.5h5M5.5 11h3.5",
        stroke: "currentColor",
        "stroke-width": "1.25",
        "stroke-linecap": "round",
      })
    );
  } else if (kind === "search") {
    svg.appendChild(
      makeSvgEl("circle", {
        cx: "7.2",
        cy: "7.2",
        r: "4.2",
        stroke: "currentColor",
        "stroke-width": "1.3",
      })
    );
    svg.appendChild(
      makeSvgEl("path", {
        d: "M10.4 10.4L13.5 13.5",
        stroke: "currentColor",
        "stroke-width": "1.35",
        "stroke-linecap": "round",
      })
    );
  } else if (kind === "sync") {
    svg.appendChild(
      makeSvgEl("path", {
        d: "M3 5.5h9.5M9.5 3l3 2.5-3 2.5M13 10.5H3.5M6.5 8l-3 2.5 3 2.5",
        stroke: "currentColor",
        "stroke-width": "1.25",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })
    );
  } else {
    svg.appendChild(
      makeSvgEl("rect", {
        x: "1.8",
        y: "2.6",
        width: "12.4",
        height: "10.8",
        rx: "2.2",
        stroke: "currentColor",
        "stroke-width": "1.3",
      })
    );
    svg.appendChild(
      makeSvgEl("path", {
        d: "M5 6.4l2.2 1.8L5 10",
        stroke: "currentColor",
        "stroke-width": "1.3",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })
    );
    svg.appendChild(
      makeSvgEl("path", {
        d: "M8.5 10h2.5",
        stroke: "currentColor",
        "stroke-width": "1.3",
        "stroke-linecap": "round",
      })
    );
  }
  return svg;
}

const MD_INLINE_RE =
  /(?:`([^`\n]+)`|\[([^\[\]\n]+)\]\(([^()\s\n]+(?:\([^()\s\n]*\)[^()\s\n]*)*)\)|\[([^\[\]\n]+)\]\((file:\/\/\/[^\s<>)"']*)|\*\*([^*\n]+)\*\*|(file:\/\/\/[^\s<>)"']+))/g;

function decodeDisplayUrl(rawUrl) {
  const cleaned = String(rawUrl || "").replace(/%[0-9a-fA-F]?$/, "");
  let decoded = cleaned;
  try {
    decoded = decodeURIComponent(cleaned);
  } catch {
    decoded = cleaned.replace(/(?:%[0-9a-fA-F]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
  return decoded.replace(/^file:\/\/\/+/i, "");
}

function extractFileUriLabel(rawUrl) {
  const decoded = decodeDisplayUrl(rawUrl);
  const hashIdx = decoded.indexOf("#");
  const filePart = hashIdx >= 0 ? decoded.slice(0, hashIdx) : decoded;
  const anchor = hashIdx >= 0 ? decoded.slice(hashIdx) : "";
  const parts = filePart.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = parts[parts.length - 1] || decoded;
  return anchor && anchor.length <= 18 ? `${base}${anchor}` : base;
}

function appendPlainSpan(parent, text) {
  if (!text) return;
  const span = document.createElement("span");
  span.textContent = text;
  parent.appendChild(span);
}

function appendMarkdownInline(parent, text) {
  const src = String(text || "");
  if (!src) return;
  MD_INLINE_RE.lastIndex = 0;
  let lastIdx = 0;
  let match;
  while ((match = MD_INLINE_RE.exec(src)) !== null) {
    if (match.index > lastIdx) {
      appendPlainSpan(parent, src.slice(lastIdx, match.index));
    }
    if (match[1] !== undefined) {
      const code = document.createElement("code");
      code.className = "mad-md-code";
      code.textContent = match[1];
      parent.appendChild(code);
    } else if ((match[2] !== undefined && match[3] !== undefined) || (match[4] !== undefined && match[5] !== undefined)) {
      const rawLabel = (match[2] !== undefined ? match[2] : match[4]).trim();
      const rawTarget = match[3] !== undefined ? match[3] : match[5];
      const unwrappedCode = /^`(.+)`$/.exec(rawLabel);
      const cleanLabel = (unwrappedCode ? unwrappedCode[1] : rawLabel).replace(/^\*\*(.+)\*\*$/, "$1");
      const chip = document.createElement("span");
      const looksLikeFile = Boolean(unwrappedCode) || /\.[a-z0-9]{1,8}(?::\d+|#L\d+)?$/i.test(cleanLabel);
      chip.className = `mad-md-link${looksLikeFile ? " is-code" : ""}`;
      chip.textContent = cleanLabel || extractFileUriLabel(rawTarget);
      chip.title = decodeDisplayUrl(rawTarget);
      parent.appendChild(chip);
    } else if (match[6] !== undefined) {
      const strong = document.createElement("strong");
      strong.className = "mad-md-bold";
      strong.textContent = match[6].trim();
      parent.appendChild(strong);
    } else if (match[7] !== undefined) {
      const chip = document.createElement("span");
      chip.className = "mad-md-link is-code";
      chip.textContent = extractFileUriLabel(match[7]);
      chip.title = decodeDisplayUrl(match[7]);
      parent.appendChild(chip);
    }
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < src.length) {
    appendPlainSpan(parent, src.slice(lastIdx));
  }
}

/**
 * Pure-DOM, zero-innerHTML lightweight Markdown renderer for Codex journey messages.
 * Supports headings, paragraphs, nested bullet/ordered lists, blockquotes, fenced code,
 * **bold**, `inline code`, and [label](url) / file:/// link chips.
 */
function renderSafeMarkdown(container, rawText) {
  container.textContent = "";
  const lines = String(rawText || "").replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  let fenceLines = [];

  const flushFence = () => {
    const pre = document.createElement("pre");
    pre.className = "mad-md-pre";
    const code = document.createElement("code");
    code.className = "mad-md-pre-code";
    code.textContent = fenceLines.join("\n");
    pre.appendChild(code);
    container.appendChild(pre);
    fenceLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      if (inFence) {
        flushFence();
        inFence = false;
      } else {
        inFence = true;
        fenceLines = [];
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    if (!line.trim()) continue;

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      const hr = document.createElement("div");
      hr.className = "mad-md-hr";
      container.appendChild(hr);
      continue;
    }

    const headingMatch = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const h = document.createElement("div");
      h.className = "mad-md-heading";
      appendMarkdownInline(h, headingMatch[2]);
      container.appendChild(h);
      continue;
    }

    const quoteMatch = /^\s*>\s?(.*)$/.exec(line);
    if (quoteMatch) {
      const q = document.createElement("div");
      q.className = "mad-md-quote";
      appendMarkdownInline(q, quoteMatch[1]);
      container.appendChild(q);
      continue;
    }

    const ulMatch = /^(\s*)[-*+•]\s+(.+)$/.exec(line);
    if (ulMatch) {
      const indent = ulMatch[1].replace(/\t/g, "  ").length;
      const li = document.createElement("div");
      li.className = `mad-md-li${indent >= 2 ? " is-nested" : ""}`;
      const bullet = document.createElement("span");
      bullet.className = "mad-md-bullet";
      bullet.textContent = indent >= 2 ? "◦" : "•";
      const body = document.createElement("div");
      body.className = "mad-md-li-body";
      appendMarkdownInline(body, ulMatch[2]);
      li.appendChild(bullet);
      li.appendChild(body);
      container.appendChild(li);
      continue;
    }

    const olMatch = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line);
    if (olMatch) {
      const indent = olMatch[1].replace(/\t/g, "  ").length;
      const li = document.createElement("div");
      li.className = `mad-md-li is-ordered${indent >= 2 ? " is-nested" : ""}`;
      const num = document.createElement("span");
      num.className = "mad-md-bullet is-num";
      num.textContent = `${olMatch[2]}.`;
      const body = document.createElement("div");
      body.className = "mad-md-li-body";
      appendMarkdownInline(body, olMatch[3]);
      li.appendChild(num);
      li.appendChild(body);
      container.appendChild(li);
      continue;
    }

    const p = document.createElement("div");
    p.className = "mad-md-p";
    appendMarkdownInline(p, line);
    container.appendChild(p);
  }

  if (inFence && fenceLines.length > 0) {
    flushFence();
  }
}

function buildChevronSvg() {
  const svg = makeSvgEl("svg", {
    width: 11,
    height: 11,
    viewBox: "0 0 12 12",
    fill: "none",
    "aria-hidden": "true",
  });
  svg.appendChild(
    makeSvgEl("path", {
      d: "M4.2 2.6L7.8 6l-3.6 3.4",
      stroke: "currentColor",
      "stroke-width": "1.35",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    })
  );
  return svg;
}

function createProgressRing(progress, status, size = 15) {
  const r = 6.2;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Number(progress) || 0));
  const dashLen = (pct / 100) * circ;
  const isActive = status === "active";
  const isDone = status === "done";

  const wrap = document.createElement("span");
  wrap.className = "mv-f-ring";
  wrap.title = isActive ? `主 Agent 进度 ${pct}%` : isDone ? "任务结束（已读）100%" : "任务结束未读 100%";

  const svg = makeSvgEl("svg", {
    width: size,
    height: size,
    viewBox: "0 0 18 18",
    "aria-hidden": "true",
  });
  svg.appendChild(
    makeSvgEl("circle", {
      class: "mv-f-ring-track",
      cx: 9,
      cy: 9,
      r,
      fill: "none",
      "stroke-width": 2.4,
    })
  );
  const arcMod = isActive ? "" : isDone ? " is-done" : " is-unread";
  svg.appendChild(
    makeSvgEl("circle", {
      class: `mv-f-ring-arc${arcMod}`,
      cx: 9,
      cy: 9,
      r,
      fill: "none",
      "stroke-width": 2.4,
      "stroke-dasharray": `${dashLen.toFixed(2)} ${circ.toFixed(2)}`,
      "stroke-linecap": "round",
      transform: "rotate(-90 9 9)",
    })
  );
  wrap.appendChild(svg);
  return wrap;
}

function createStatePill(stateKind, stateLabel) {
  const pill = document.createElement("span");
  pill.className = `mg-state-pill is-${stateKind || "unread"}`;
  if (stateKind === "sleep") {
    const moon = document.createElement("span");
    moon.className = "mg-pill-moon";
    moon.textContent = "☾";
    pill.appendChild(moon);
  } else {
    const dot = document.createElement("span");
    dot.className = "mg-pill-dot";
    pill.appendChild(dot);
  }
  const textSpan = document.createElement("span");
  textSpan.textContent = stateLabel || "";
  pill.appendChild(textSpan);
  return pill;
}

function createArrowMarker(id, colorClass) {
  const marker = makeSvgEl("marker", {
    id,
    viewBox: "0 0 8 8",
    refX: "6.4",
    refY: "4",
    markerWidth: "5.5",
    markerHeight: "5.5",
    orient: "auto",
  });
  marker.appendChild(
    makeSvgEl("path", {
      d: "M 1 1.2 L 7 4 L 1 6.8 z",
      class: `mg-marker-fill ${colorClass}`,
    })
  );
  return marker;
}

function glyphForActionKind(kind) {
  if (kind === "edit") return "✎";
  if (kind === "read") return "📄";
  if (kind === "search") return "🔍";
  if (kind === "sync") return "⇄";
  if (kind === "tool") return "⚙";
  return ">_";
}

async function callJson(apiFetch, url, options = {}) {
  const res = await apiFetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || data?.reason || `HTTP ${res.status}`);
  }
  return data;
}

export function createMasteryHub({ apiFetch, onToast } = {}) {
  const overviewViewEl = document.getElementById("masteryOverviewView");
  const detailViewEl = document.getElementById("masteryDetailView");
  const madBackBtn = document.getElementById("madBackBtn");
  const madRoleBadgeEl = document.getElementById("madRoleBadge");
  const madAgentNameEl = document.getElementById("madAgentName");
  const madStateSlotEl = document.getElementById("madStateSlot");
  const madSessionCrumbEl = document.getElementById("madSessionCrumb");
  const madDurationEl = document.getElementById("madDuration");
  const madTimelineEl = document.getElementById("madTimeline");

  const listEl = document.getElementById("masteryCliList");
  const totalCountEl = document.getElementById("masteryTotalCount");
  const summaryEl = document.getElementById("masteryStatusSummary");

  const overviewPctEl = document.getElementById("masteryOverviewPct");
  const overviewSummaryEl = document.getElementById("masteryOverviewSummary");
  const totalFillBarEl = document.getElementById("masteryTotalFillBar");
  const overviewGoalEl = document.getElementById("masteryOverviewGoal");

  const graphStageEl = document.getElementById("masteryGraphStage");
  const graphSvgEl = document.getElementById("masteryGraphSvg");
  const colMasterEl = document.getElementById("masteryColMaster");
  const colSubsEl = document.getElementById("masteryColSubs");

  // Summary model row controls (single radio "自身模型" + "第三方模型")
  const msmRowEl = document.getElementById("masterySummaryModelRow");
  const msmEnableToggle = document.getElementById("msmEnableToggle");
  const msmSourceTag = document.getElementById("msmSourceTag");
  const msmSelfBtn = document.getElementById("msmSelfBtn");
  const msmThirdPartyBtn = document.getElementById("msmThirdPartyBtn");
  const msmThirdPartyLabel = document.getElementById("msmThirdPartyLabel");
  const msmExtraRow = document.getElementById("msmExtraRow");
  const msmThinkGroup = document.getElementById("msmThinkGroup");
  const freqBtns = Array.from(document.querySelectorAll("[data-msm-freq]"));
  const thinkBtns = Array.from(document.querySelectorAll("[data-msm-think]"));

  // Third-party configuration modal
  const modalBackdrop = document.getElementById("masteryThirdPartyModal");
  const tpCloseBtn = document.getElementById("tpModalCloseBtn");
  const tpCancelBtn = document.getElementById("tpCancelBtn");
  const tpSaveBtn = document.getElementById("tpSaveBtn");
  const tpProtoBtns = Array.from(document.querySelectorAll("[data-tp-proto]"));
  const tpProtoHint = document.getElementById("tpProtoHint");
  const tpUrlInput = document.getElementById("tpBaseUrlInput");
  const tpKeyInput = document.getElementById("tpApiKeyInput");
  const tpToggleKeyBtn = document.getElementById("tpToggleKeyBtn");
  const tpModelSelect = document.getElementById("tpModelSelect");
  const tpFetchBtn = document.getElementById("tpFetchModelsBtn");
  const tpFetchStatus = document.getElementById("tpFetchStatus");
  const tpTestConnBtn = document.getElementById("tpTestConnBtn");
  const tpTestResult = document.getElementById("tpTestResult");

  const cleanups = [];
  let destroyed = false;
  let tabActive = false;
  let pollTimer = null;
  let inFlight = false;
  let resizeObserver = null;

  let selectedSessionId = "";
  let detailAgentKey = ""; // "" when in overview; e.g. "coord" or "sub-xxxx" when in View 2
  let hoveredAgentId = null;
  let lastSnapshot = null;
  let configState = {
    enabled: true,
    source: "self",
    frequency: "1m",
    thinking: "low",
    thirdParty: {
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      hasApiKey: false,
      apiKeyMasked: "",
      fetchedModels: [...PROTOCOL_PRESETS.openai.models],
      selectedModel: "gpt-4o-mini",
    },
  };

  let draftProto = "openai";
  let draftModels = [...PROTOCOL_PRESETS.openai.models];
  const nodeElMap = new Map();
  const expandedGroupState = new Map();
  let lastRenderedTimelineKey = "";
  let lastRenderedTimelineSig = "";

  const on = (el, evt, fn, opts) => {
    if (!el || typeof el.addEventListener !== "function") return;
    el.addEventListener(evt, fn, opts);
    cleanups.push(() => el.removeEventListener(evt, fn, opts));
  };

  const renderConfigRow = () => {
    const isEnabled = Boolean(configState.enabled);
    const isThirdParty = configState.source === "thirdparty";
    const tp = configState.thirdParty || {};
    const protoPreset = PROTOCOL_PRESETS[tp.protocol] || PROTOCOL_PRESETS.openai;
    const tpModel = tp.selectedModel || protoPreset.models[0];

    if (msmRowEl) msmRowEl.classList.toggle("is-off", !isEnabled);
    if (msmEnableToggle) msmEnableToggle.checked = isEnabled;
    if (msmExtraRow) msmExtraRow.hidden = !isEnabled;

    if (msmSelfBtn) {
      const selfActive = isEnabled && !isThirdParty;
      msmSelfBtn.classList.toggle("is-active", selfActive);
      msmSelfBtn.setAttribute("aria-checked", String(selfActive));
    }

    if (msmThirdPartyBtn) {
      const tpActive = isEnabled && isThirdParty;
      msmThirdPartyBtn.classList.toggle("is-active", tpActive);
      msmThirdPartyBtn.setAttribute("aria-checked", String(tpActive));
      msmThirdPartyBtn.title = isThirdParty
        ? `${isEnabled ? "已启用" : "已配置（当前关闭）"} ${protoPreset.name}：${tpModel}（点击修改）`
        : "自定义第三方总结模型（OpenAI / Anthropic 协议）";
    }
    if (msmThirdPartyLabel) {
      msmThirdPartyLabel.textContent = isThirdParty ? `第三方 · ${tpModel}` : "第三方模型";
    }

    if (msmSourceTag) {
      if (!isEnabled) {
        msmSourceTag.textContent = "已关闭";
        msmSourceTag.className = "msm-source-tag is-off";
      } else if (isThirdParty) {
        msmSourceTag.textContent = `第三方 · ${protoPreset.name}`;
        msmSourceTag.className = "msm-source-tag is-thirdparty";
      } else {
        msmSourceTag.textContent = "自身模型";
        msmSourceTag.className = "msm-source-tag";
      }
    }

    freqBtns.forEach((btn) => {
      const active = btn.getAttribute("data-msm-freq") === configState.frequency;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", String(active));
    });

    if (msmThinkGroup) {
      msmThinkGroup.classList.toggle("is-self-note", !isThirdParty);
      msmThinkGroup.title = isThirdParty
        ? "设置第三方总结模型的思维推理强度"
        : "使用 Agent 自身模型时沿用当前会话档位；切换第三方模型后可独立控制";
    }
    thinkBtns.forEach((btn) => {
      const active = btn.getAttribute("data-msm-think") === configState.thinking;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", String(active));
    });
  };

  const saveConfigPatch = async (patch, { toastText = "" } = {}) => {
    try {
      const res = await callJson(apiFetch, "/api/mastery/config", {
        method: "POST",
        body: JSON.stringify(patch),
      });
      if (res?.config) {
        configState = res.config;
        renderConfigRow();
      }
      if (toastText) onToast?.(toastText, "success");
      return res?.config || null;
    } catch (err) {
      onToast?.(err?.message || "保存总结模型配置失败", "error");
      return null;
    }
  };

  const updateEdgeFocus = () => {
    if (!graphStageEl || !graphSvgEl) return;
    const focusId = hoveredAgentId;
    graphStageEl.classList.toggle("has-focus", Boolean(focusId));
    graphSvgEl.querySelectorAll(".mg-edge-group").forEach((g) => {
      const from = g.getAttribute("data-from");
      const to = g.getAttribute("data-to");
      const type = g.getAttribute("data-type");
      const stateKind = g.getAttribute("data-state") || "unread";
      const isLive = g.getAttribute("data-live") === "1";
      const isRelated = Boolean(focusId) && (from === focusId || to === focusId);
      g.classList.toggle("is-highlighted", isRelated);

      const basePath = g.querySelector(".mg-edge-path");
      if (basePath) {
        if (type === "bus") {
          const markerMap = {
            running: "url(#mgArrowRunning)",
            sleep: "url(#mgArrowSleep)",
            unread: "url(#mgArrowUnread)",
            done: "url(#mgArrowDone)",
          };
          basePath.setAttribute("marker-end", markerMap[stateKind] || "url(#mgArrowDone)");
        } else {
          basePath.setAttribute(
            "marker-end",
            isRelated
              ? "url(#mgArrowPeerHi)"
              : isLive
                ? "url(#mgArrowPeerLive)"
                : "url(#mgArrowPeerIdle)"
          );
        }
      }
    });
  };

  const drawGraphEdges = () => {
    const session = lastSnapshot?.detailSession;
    if (!session || !graphStageEl || !graphSvgEl) return;
    if (detailViewEl && !detailViewEl.hidden) return;

    const stageRect = graphStageEl.getBoundingClientRect();
    if (!stageRect || stageRect.width < 10 || stageRect.height < 10) return;

    graphSvgEl.setAttribute("viewBox", `0 0 ${stageRect.width} ${stageRect.height}`);
    graphSvgEl.textContent = "";

    const edges = Array.isArray(session.edges) ? session.edges : [];
    if (edges.length === 0) return;

    const defs = makeSvgEl("defs");
    defs.appendChild(createArrowMarker("mgArrowRunning", "is-running"));
    defs.appendChild(createArrowMarker("mgArrowSleep", "is-sleep"));
    defs.appendChild(createArrowMarker("mgArrowUnread", "is-unread"));
    defs.appendChild(createArrowMarker("mgArrowDone", "is-done"));
    defs.appendChild(createArrowMarker("mgArrowPeerIdle", "is-peer-idle"));
    defs.appendChild(createArrowMarker("mgArrowPeerLive", "is-peer-live"));
    defs.appendChild(createArrowMarker("mgArrowPeerHi", "is-peer-hi"));
    graphSvgEl.appendChild(defs);

    const subStateMap = new Map((session.subs || []).map((sub) => [sub.id, sub.stateKind]));

    const getBox = (id) => {
      const el = nodeElMap.get(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left - stageRect.left,
        right: r.right - stageRect.left,
        top: r.top - stageRect.top,
        bottom: r.bottom - stageRect.top,
        width: r.width,
        height: r.height,
        cy: r.top - stageRect.top + r.height / 2,
      };
    };

    const busEdges = edges.filter((e) => e.type === "bus");
    const busIndexMap = new Map(busEdges.map((e, idx) => [e, idx]));

    edges.forEach((edge) => {
      const fromBox = getBox(edge.from);
      const toBox = getBox(edge.to);
      if (!fromBox || !toBox) return;

      const edgeState = edge.type === "bus" ? subStateMap.get(edge.to) || "unread" : "peer";

      const g = makeSvgEl("g", {
        class: `mg-edge-group is-${edge.type} is-${edgeState}${edge.live ? " is-live" : ""}`,
        "data-from": edge.from,
        "data-to": edge.to,
        "data-type": edge.type,
        "data-state": edgeState,
        "data-live": edge.live ? "1" : "0",
      });

      let pathD = "";
      let startX = 0;
      let startY = 0;

      if (edge.type === "bus") {
        const busIdx = busIndexMap.get(edge) || 0;
        const busTotal = Math.max(1, busEdges.length);
        const ratio = busTotal === 1 ? 0.5 : 0.24 + (0.52 * busIdx) / (busTotal - 1);

        const masterX = fromBox.right + 2;
        const masterY = fromBox.top + fromBox.height * ratio;
        const subX = toBox.left - 3;
        const subY = toBox.cy;
        const spanX = Math.max(20, subX - masterX);

        if (edge.dir === "to-master") {
          const sx = toBox.left - 2;
          const sy = subY;
          const ex = fromBox.right + 3;
          const ey = masterY;
          pathD = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${(sx - spanX * 0.48).toFixed(1)} ${sy.toFixed(1)}, ${(ex + spanX * 0.52).toFixed(1)} ${ey.toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}`;
          startX = sx;
          startY = sy;
        } else {
          pathD = `M ${masterX.toFixed(1)} ${masterY.toFixed(1)} C ${(masterX + spanX * 0.52).toFixed(1)} ${masterY.toFixed(1)}, ${(subX - spanX * 0.48).toFixed(1)} ${subY.toFixed(1)}, ${subX.toFixed(1)} ${subY.toFixed(1)}`;
          startX = masterX;
          startY = masterY;
        }
      } else {
        const sx = fromBox.right + 2;
        const sy = fromBox.cy;
        const ex = toBox.right + 3;
        const ey = toBox.cy;
        const railX = Math.min(
          stageRect.width - 5,
          Math.max(fromBox.right, toBox.right) + 13 + (edge.lane || 0) * 11
        );
        const dirY = ey >= sy ? 1 : -1;
        const rad = Math.min(7, Math.abs(ey - sy) / 2, Math.max(2, railX - Math.max(sx, ex)));

        pathD = [
          `M ${sx.toFixed(1)} ${sy.toFixed(1)}`,
          `L ${(railX - rad).toFixed(1)} ${sy.toFixed(1)}`,
          `Q ${railX.toFixed(1)} ${sy.toFixed(1)} ${railX.toFixed(1)} ${(sy + dirY * rad).toFixed(1)}`,
          `L ${railX.toFixed(1)} ${(ey - dirY * rad).toFixed(1)}`,
          `Q ${railX.toFixed(1)} ${ey.toFixed(1)} ${(railX - rad).toFixed(1)} ${ey.toFixed(1)}`,
          `L ${ex.toFixed(1)} ${ey.toFixed(1)}`,
        ].join(" ");
        startX = sx;
        startY = sy;
      }

      g.appendChild(makeSvgEl("path", { class: "mg-edge-path", d: pathD }));
      g.appendChild(makeSvgEl("path", { class: "mg-edge-flow", d: pathD }));
      g.appendChild(
        makeSvgEl("circle", {
          class: "mg-port-dot",
          cx: startX.toFixed(1),
          cy: startY.toFixed(1),
          r: "2.4",
        })
      );
      graphSvgEl.appendChild(g);
    });

    updateEdgeFocus();
  };

  const renderAgentTimeline = (agent, isMaster, session, { preserveScroll = false } = {}) => {
    if (!madTimelineEl || !agent || !session) return;
    const journey = agent.journey || {};

    if (madRoleBadgeEl) {
      madRoleBadgeEl.textContent = isMaster ? "主 Agent" : "次 Agent";
      madRoleBadgeEl.className = `mad-role-badge${isMaster ? "" : " is-sub"}`;
    }
    if (madAgentNameEl) madAgentNameEl.textContent = agent.name || (isMaster ? "主 Agent" : "子 Agent");
    if (madStateSlotEl) {
      madStateSlotEl.textContent = "";
      madStateSlotEl.appendChild(createStatePill(agent.stateKind, agent.stateLabel));
    }
    if (madSessionCrumbEl) {
      madSessionCrumbEl.textContent = `所属会话：[${session.project}] ${session.name}`;
      madSessionCrumbEl.title = `${session.project} / ${session.name}`;
    }
    if (madDurationEl) {
      madDurationEl.textContent = `${journey.duration || ""} · 进度 ${agent.progress}%`;
    }

    const steps =
      Array.isArray(journey.steps) && journey.steps.length > 0
        ? journey.steps
        : [{ type: "msg", text: agent.task || "等待下一步输出…" }];

    const timelineKey = `${session.id}:${agent.id}`;
    const lastStep = steps[steps.length - 1];
    const timelineSig = [
      timelineKey,
      agent.stateKind || "",
      journey.brief || "",
      journey.duration || "",
      journey.foot || "",
      steps.length,
      lastStep?.type || "",
      lastStep?.id || "",
      lastStep?.text || "",
      Array.isArray(lastStep?.items) ? lastStep.items.length : 0,
    ].join("|");

    if (preserveScroll && timelineKey === lastRenderedTimelineKey && timelineSig === lastRenderedTimelineSig) {
      return;
    }

    const prevScrollTop = Number(madTimelineEl.scrollTop || 0);
    const prevScrollHeight = Number(madTimelineEl.scrollHeight || 0);
    const prevClientHeight = Number(madTimelineEl.clientHeight || 0);
    const wasNearBottom =
      prevScrollHeight <= prevClientHeight + 48 ||
      prevScrollHeight - prevScrollTop - prevClientHeight <= 48;

    madTimelineEl.textContent = "";

    const hasInlineUserSteps = steps.some((s) => s.type === "user");
    if (!hasInlineUserSteps && journey.brief) {
      const brief = document.createElement("div");
      brief.className = "mad-brief";
      const briefLabel = document.createElement("span");
      briefLabel.className = "mad-brief-label";
      briefLabel.textContent = journey.briefFrom || (isMaster ? "用户布置任务" : "来自「主 Agent」派单");
      const briefText = document.createElement("div");
      briefText.textContent = journey.brief;
      brief.appendChild(briefLabel);
      brief.appendChild(briefText);
      madTimelineEl.appendChild(brief);
    }

    if (journey.duration) {
      const elapsed = document.createElement("div");
      elapsed.className = "mad-elapsed-head";
      elapsed.textContent = journey.duration;
      madTimelineEl.appendChild(elapsed);
    }

    steps.forEach((step, idx) => {
      if (step.type === "user") {
        const brief = document.createElement("div");
        brief.className = `mad-brief${step.isFollowup ? " is-followup" : ""}`;
        const briefLabel = document.createElement("span");
        briefLabel.className = "mad-brief-label";
        briefLabel.textContent =
          step.label || (step.isFollowup ? "用户补充" : isMaster ? "用户布置任务" : "来自「主 Agent」派单");
        const briefText = document.createElement("div");
        briefText.textContent = step.text || "";
        brief.appendChild(briefLabel);
        brief.appendChild(briefText);
        madTimelineEl.appendChild(brief);
      } else if (step.type === "msg") {
        const p = document.createElement("div");
        p.className = "mad-msg";
        renderSafeMarkdown(p, step.text);
        madTimelineEl.appendChild(p);
      } else if (step.type === "actions") {
        const groupKey = `${session.id}:${agent.id}:${step.id || idx}:${step.label}`;
        const isOpenInitial = Boolean(expandedGroupState.get(groupKey));

        const group = document.createElement("div");
        group.className = `mad-action-group${isOpenInitial ? " is-open" : ""}`;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "mad-action-toggle";
        toggle.setAttribute("aria-expanded", String(isOpenInitial));

        const iconSpan = document.createElement("span");
        iconSpan.className = "mad-action-icon";
        iconSpan.appendChild(buildActionIconSvg(step.icon));

        const labelSpan = document.createElement("span");
        labelSpan.textContent = step.label || "运行了命令";

        const countSpan = document.createElement("span");
        countSpan.className = "mad-action-count";
        countSpan.textContent = `${(step.items || []).length} 项`;

        const chevron = document.createElement("span");
        chevron.className = "mad-action-chevron";
        chevron.appendChild(buildChevronSvg());

        toggle.appendChild(iconSpan);
        toggle.appendChild(labelSpan);
        toggle.appendChild(countSpan);
        toggle.appendChild(chevron);

        const list = document.createElement("div");
        list.className = "mad-action-list";

        (step.items || []).forEach((item) => {
          const row = document.createElement("div");
          row.className = "mad-action-item";

          const glyph = document.createElement("span");
          glyph.className = "mad-item-glyph";
          glyph.textContent = glyphForActionKind(item.kind);

          const text = document.createElement("span");
          text.className = "mad-item-text";
          text.textContent = item.text || "";
          text.title = item.text || "";

          row.appendChild(glyph);
          row.appendChild(text);

          if (item.add || item.del) {
            const diff = document.createElement("span");
            diff.className = "mad-item-diff";
            if (item.add) {
              const add = document.createElement("span");
              add.className = "mad-diff-add";
              add.textContent = item.add;
              diff.appendChild(add);
            }
            if (item.del) {
              const del = document.createElement("span");
              del.className = "mad-diff-del";
              del.textContent = item.del;
              diff.appendChild(del);
            }
            row.appendChild(diff);
          }

          list.appendChild(row);
        });

        toggle.addEventListener("click", () => {
          const isOpen = group.classList.toggle("is-open");
          toggle.setAttribute("aria-expanded", String(isOpen));
          expandedGroupState.set(groupKey, isOpen);
        });

        group.appendChild(toggle);
        group.appendChild(list);
        madTimelineEl.appendChild(group);
      }
    });

    if (journey.foot) {
      const foot = document.createElement("div");
      foot.className = `mad-live-foot is-${agent.stateKind || "unread"}`;
      if (agent.stateKind === "sleep") {
        foot.textContent = `☾ ${journey.foot}`;
      } else {
        const dot = document.createElement("span");
        dot.className = "mad-live-dot";
        const footText = document.createElement("span");
        footText.textContent = journey.foot;
        foot.appendChild(dot);
        foot.appendChild(footText);
      }
      madTimelineEl.appendChild(foot);
    }

    lastRenderedTimelineKey = timelineKey;
    lastRenderedTimelineSig = timelineSig;
    const shouldSnapBottom = !preserveScroll || wasNearBottom;
    const applyScroll = () => {
      if (destroyed || !madTimelineEl) return;
      const h = Number(madTimelineEl.scrollHeight || 0);
      madTimelineEl.scrollTop = shouldSnapBottom ? h : prevScrollTop;
    };
    applyScroll();
    if (shouldSnapBottom && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => applyScroll());
    }
  };

  const openAgentDetail = (agent, isMaster, session) => {
    if (!overviewViewEl || !detailViewEl) return;
    hoveredAgentId = null;
    detailAgentKey = isMaster ? "coord" : agent.id;

    // Clicking a completed Agent marks it as read ("任务结束" gray instead of "任务结束未读" green)
    if (agent.stateKind === "unread" && !agent.isRead) {
      agent.isRead = true;
      agent.stateKind = "done";
      agent.stateLabel = "任务结束";
      if (agent.journey) {
        agent.journey.foot = "本角色任务已结束 · 你已查阅";
      }
      const allCompletedRead =
        (!session.master || session.master.stateKind !== "unread") &&
        (session.subs || []).every((s) => s.stateKind !== "unread");
      const shouldMarkSessionRead = Boolean(isMaster || allCompletedRead);
      if (shouldMarkSessionRead && session.status !== "active") {
        session.isRead = true;
        session.status = "done";
        session.tag = "任务结束";
        const row = (lastSnapshot?.sessions || []).find((r) => r.id === session.id);
        if (row) {
          row.isRead = true;
          row.status = "done";
          row.tag = "任务结束";
        }
      }
      if (typeof apiFetch === "function") {
        void callJson(apiFetch, "/api/mastery/mark-read", {
          method: "POST",
          body: JSON.stringify({
            sessionId: session.id,
            agentConvId: agent.convId || session.id,
            markSessionRead: shouldMarkSessionRead,
            modifiedMs: session.modifiedMs || Date.now(),
          }),
        }).catch(() => {});
      }
    }

    overviewViewEl.hidden = true;
    detailViewEl.hidden = false;
    renderAgentTimeline(agent, isMaster, session, { preserveScroll: false });
  };

  const closeAgentDetail = () => {
    if (!overviewViewEl || !detailViewEl || detailViewEl.hidden) return;
    detailAgentKey = "";
    detailViewEl.hidden = true;
    overviewViewEl.hidden = false;
    hoveredAgentId = null;
    if (lastSnapshot) {
      renderSnapshot(lastSnapshot);
    }
    void refreshMastery();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => drawGraphEdges());
    }
  };

  const bindNodeInteraction = (btn, agent, isMaster, session) => {
    btn.title = `点击查看「${agent.name}」的执行历程`;
    btn.addEventListener("click", () => openAgentDetail(agent, isMaster, session));
    btn.addEventListener("mouseenter", () => {
      hoveredAgentId = agent.id;
      updateEdgeFocus();
    });
    btn.addEventListener("mouseleave", () => {
      hoveredAgentId = null;
      updateEdgeFocus();
    });
    nodeElMap.set(agent.id, btn);
  };

  const createMasterNodeEl = (master, session) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `mg-node is-master is-${master.stateKind}`;
    btn.dataset.agentId = master.id;

    const top = document.createElement("div");
    top.className = "mg-master-top";
    const badge = document.createElement("span");
    badge.className = "mg-tier-badge is-master";
    badge.textContent = "主 Agent";
    const pct = document.createElement("span");
    pct.className = "mg-master-pct";
    pct.textContent = `${master.progress}%`;
    top.appendChild(badge);
    top.appendChild(pct);

    const name = document.createElement("div");
    name.className = "mg-master-name";
    name.textContent = master.name;

    const state = createStatePill(master.stateKind, master.stateLabel);

    const task = document.createElement("div");
    task.className = "mg-master-task";
    task.textContent = master.task;

    const bar = document.createElement("div");
    bar.className = "mg-node-bottom-bar";
    const fill = document.createElement("div");
    fill.className = `mg-node-bottom-fill is-${master.stateKind}`;
    fill.style.width = `${master.progress}%`;
    bar.appendChild(fill);

    btn.appendChild(top);
    btn.appendChild(name);
    btn.appendChild(state);
    btn.appendChild(task);
    btn.appendChild(bar);
    bindNodeInteraction(btn, master, true, session);
    return btn;
  };

  const createSubNodeEl = (sub, session) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `mg-node is-sub is-${sub.stateKind}`;
    btn.dataset.agentId = sub.id;

    const top = document.createElement("div");
    top.className = "mg-sub-top";

    const idWrap = document.createElement("span");
    idWrap.className = "mg-sub-id";
    const badge = document.createElement("span");
    badge.className = "mg-tier-badge is-sub";
    badge.textContent = "次";
    const name = document.createElement("span");
    name.className = "mg-sub-name";
    name.textContent = sub.name;
    idWrap.appendChild(badge);
    idWrap.appendChild(name);

    const right = document.createElement("span");
    right.className = "mg-sub-right";
    const state = createStatePill(sub.stateKind, sub.stateLabel);
    const pct = document.createElement("span");
    pct.className = "mg-sub-pct";
    pct.textContent = `${sub.progress}%`;
    right.appendChild(state);
    right.appendChild(pct);

    top.appendChild(idWrap);
    top.appendChild(right);

    const task = document.createElement("div");
    task.className = "mg-sub-task";
    task.textContent = sub.task;

    const bar = document.createElement("div");
    bar.className = "mg-node-bottom-bar";
    const fill = document.createElement("div");
    fill.className = `mg-node-bottom-fill is-${sub.stateKind}`;
    fill.style.width = `${sub.progress}%`;
    bar.appendChild(fill);

    btn.appendChild(top);
    btn.appendChild(task);
    btn.appendChild(bar);
    bindNodeInteraction(btn, sub, false, session);
    return btn;
  };

  const renderSnapshot = (snap) => {
    if (!snap) return;
    lastSnapshot = snap;
    if (snap.config) {
      configState = snap.config;
      renderConfigRow();
    }
    if (snap.selectedSessionId) {
      selectedSessionId = snap.selectedSessionId;
    }

    const sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
    const activeCount = Number(snap.activeCount || 0);
    const unreadCount = Number(snap.unreadCount || 0);

    if (totalCountEl) totalCountEl.textContent = String(sessions.length);
    if (summaryEl) {
      summaryEl.textContent = snap.isFallbackRecent
        ? `当前无活动/未读 · 显示最近 ${sessions.length} 条会话`
        : `${activeCount} 运行中 · ${unreadCount} 任务结束未读`;
    }

    if (listEl) {
      listEl.textContent = "";
      if (sessions.length === 0) {
        const empty = document.createElement("div");
        empty.className = "mastery-empty-tip";
        empty.textContent = "暂无可追踪会话，发起任意对话后将自动显示";
        listEl.appendChild(empty);
      } else {
        sessions.forEach((s) => {
          const isSelected = s.id === selectedSessionId;
          const rowStatus = s.status === "active" ? "active" : s.status === "done" || s.isRead ? "done" : "unread";
          const rowMod = `is-${rowStatus}`;

          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `mv-f-row ${rowMod}${isSelected ? " is-selected" : ""}`;
          btn.setAttribute("role", "option");
          btn.setAttribute("aria-selected", String(isSelected));
          btn.title = `${s.project} / ${s.name} · ${s.tag} (主 Agent 进度 ${s.progress}%)`;

          const lamp = document.createElement("span");
          lamp.className = `mv-f-lamp ${rowMod}`;

          const subCount = document.createElement("span");
          subCount.className = `mv-f-subcount${s.subAgentCount === 0 ? " is-zero" : ""}`;
          subCount.textContent = String(s.subAgentCount || 0);
          subCount.title =
            s.subAgentCount > 0
              ? `当前运行中子 Agent：${s.subAgentCount} 个`
              : "当前无运行中的子 Agent";

          const proj = document.createElement("span");
          proj.className = "mv-f-proj";
          proj.textContent = `[${s.project}]`;

          const name = document.createElement("span");
          name.className = "mv-f-name";
          name.textContent = s.name;

          const status = document.createElement("span");
          status.className = `mv-f-status${rowStatus === "active" ? "" : ` ${rowMod}`}`;
          status.textContent = s.tag;

          const ring = createProgressRing(s.progress, rowStatus, 15);

          const cursor = document.createElement("span");
          cursor.className = "mv-f-cursor";
          cursor.textContent = isSelected ? "◀" : "";

          btn.appendChild(lamp);
          btn.appendChild(subCount);
          btn.appendChild(proj);
          btn.appendChild(name);
          btn.appendChild(status);
          btn.appendChild(ring);
          btn.appendChild(cursor);

          btn.addEventListener("click", () => {
            if (selectedSessionId === s.id && !detailAgentKey) return;
            selectedSessionId = s.id;
            hoveredAgentId = null;
            if (detailAgentKey) closeAgentDetail();
            void refreshMastery({ force: true });
          });

          listEl.appendChild(btn);
        });
      }
    }

    const session = snap.detailSession;
    if (!session) {
      if (overviewPctEl) overviewPctEl.textContent = "0%";
      if (overviewSummaryEl) overviewSummaryEl.textContent = "等待活动会话";
      if (totalFillBarEl) totalFillBarEl.style.width = "0%";
      if (overviewGoalEl) overviewGoalEl.textContent = "";
      if (colMasterEl) colMasterEl.textContent = "";
      if (colSubsEl) colSubsEl.textContent = "";
      if (graphSvgEl) graphSvgEl.textContent = "";
      return;
    }

    const isDone = session.status === "done" || Boolean(session.isRead);
    const isUnread = session.status !== "active" && !isDone;
    const masterProgress = session.master ? session.master.progress : session.progress;

    if (overviewPctEl) {
      overviewPctEl.textContent = `${masterProgress}%`;
      overviewPctEl.classList.toggle("is-unread", isUnread);
      overviewPctEl.classList.toggle("is-done", isDone);
    }
    if (overviewSummaryEl) {
      overviewSummaryEl.textContent = session.summaryText || "";
    }
    if (totalFillBarEl) {
      totalFillBarEl.style.width = `${masterProgress}%`;
      totalFillBarEl.classList.toggle("is-unread", isUnread);
      totalFillBarEl.classList.toggle("is-done", isDone);
    }
    if (overviewGoalEl) {
      overviewGoalEl.textContent = `当前目标：${session.goal || session.name}`;
      overviewGoalEl.title = session.goal || session.name;
    }

    nodeElMap.clear();
    if (colMasterEl) {
      colMasterEl.textContent = "";
      if (session.master) {
        colMasterEl.appendChild(createMasterNodeEl(session.master, session));
      }
    }
    if (colSubsEl) {
      colSubsEl.textContent = "";
      const subs = Array.isArray(session.subs) ? session.subs : [];
      if (subs.length === 0) {
        const solo = document.createElement("div");
        solo.className = "mastery-solo-note";
        solo.textContent = "当前为单 Agent 独立执行（无派生子 Agent），点击左侧「主 Agent」查看完整类 Codex 历程";
        colSubsEl.appendChild(solo);
      } else {
        subs.forEach((sub) => colSubsEl.appendChild(createSubNodeEl(sub, session)));
      }
    }

    // If user is currently inside View 2, keep timeline live-synced in place
    if (detailAgentKey && detailViewEl && !detailViewEl.hidden) {
      const targetAgent =
        detailAgentKey === "coord"
          ? session.master
          : (session.subs || []).find((sub) => sub.id === detailAgentKey);
      if (targetAgent) {
        renderAgentTimeline(targetAgent, detailAgentKey === "coord", session, {
          preserveScroll: true,
        });
      }
    } else if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => drawGraphEdges());
    }
  };

  const refreshMastery = async () => {
    if (destroyed || inFlight || typeof apiFetch !== "function") return;
    inFlight = true;
    try {
      const qs = selectedSessionId ? `?sessionId=${encodeURIComponent(selectedSessionId)}` : "";
      const data = await callJson(apiFetch, `/api/mastery${qs}`);
      if (destroyed) return;
      renderSnapshot(data);
    } catch {
      // Non-fatal refresh error
    } finally {
      inFlight = false;
    }
  };

  const stopPolling = () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const startPolling = () => {
    if (pollTimer !== null || destroyed || !tabActive) return;
    pollTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshMastery();
    }, POLL_INTERVAL_MS);
  };

  // ========== Third-Party Modal Logic ==========
  const populateModelSelect = (models, selectedValue) => {
    if (!tpModelSelect) return;
    tpModelSelect.textContent = "";
    const list = Array.isArray(models) && models.length ? models : ["gpt-4o-mini"];
    list.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      tpModelSelect.appendChild(opt);
    });
    tpModelSelect.value = selectedValue && list.includes(selectedValue) ? selectedValue : list[0];
  };

  const applyProtocolUi = (proto, resetUrlIfDefault) => {
    draftProto = proto === "anthropic" ? "anthropic" : "openai";
    const preset = PROTOCOL_PRESETS[draftProto];
    tpProtoBtns.forEach((btn) => {
      const active = btn.getAttribute("data-tp-proto") === draftProto;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    if (tpProtoHint) tpProtoHint.textContent = preset.hint;
    if (tpUrlInput) {
      tpUrlInput.placeholder = preset.urlPlaceholder;
      if (resetUrlIfDefault) {
        const cur = tpUrlInput.value.trim();
        if (
          !cur ||
          cur === PROTOCOL_PRESETS.openai.urlPlaceholder ||
          cur === PROTOCOL_PRESETS.anthropic.urlPlaceholder
        ) {
          tpUrlInput.value = preset.urlPlaceholder;
        }
      }
    }
    if (tpKeyInput) {
      tpKeyInput.placeholder = configState.thirdParty?.hasApiKey
        ? `已保存 (${configState.thirdParty.apiKeyMasked || "****"})，留空则沿用`
        : preset.keyPlaceholder;
    }
  };

  const openThirdPartyModal = () => {
    if (!modalBackdrop) return;
    const tp = configState.thirdParty || {};
    draftProto = tp.protocol === "anthropic" ? "anthropic" : "openai";
    const preset = PROTOCOL_PRESETS[draftProto];
    draftModels =
      Array.isArray(tp.fetchedModels) && tp.fetchedModels.length
        ? [...tp.fetchedModels]
        : [...preset.models];

    if (tpUrlInput) tpUrlInput.value = tp.baseUrl || preset.urlPlaceholder;
    if (tpKeyInput) {
      tpKeyInput.value = "";
      tpKeyInput.type = "password";
    }
    if (tpToggleKeyBtn) tpToggleKeyBtn.textContent = "显示";

    applyProtocolUi(draftProto, false);
    populateModelSelect(draftModels, tp.selectedModel);

    if (tpFetchStatus) {
      tpFetchStatus.textContent = `当前列表 ${draftModels.length} 个模型，点击右侧拉取最新列表`;
      tpFetchStatus.className = "tp-fetch-status";
    }
    if (tpTestResult) {
      tpTestResult.textContent = "";
      tpTestResult.className = "tp-test-result";
    }
    modalBackdrop.hidden = false;
  };

  const closeThirdPartyModal = () => {
    if (modalBackdrop) modalBackdrop.hidden = true;
  };

  // ========== Bind UI Events ==========
  on(madBackBtn, "click", closeAgentDetail);

  on(
    document,
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      if (modalBackdrop && !modalBackdrop.hidden) {
        e.stopImmediatePropagation?.();
        closeThirdPartyModal();
      } else if (detailViewEl && !detailViewEl.hidden) {
        closeAgentDetail();
      }
    },
    true
  );

  on(msmEnableToggle, "change", () => {
    const nextEnabled = Boolean(msmEnableToggle.checked);
    configState.enabled = nextEnabled;
    renderConfigRow();
    void saveConfigPatch({ enabled: nextEnabled });
  });

  on(msmSelfBtn, "click", () => {
    configState.enabled = true;
    configState.source = "self";
    renderConfigRow();
    void saveConfigPatch(
      { enabled: true, source: "self" },
      { toastText: "已启用自身模型自总结（保留原会话缓存命中）" }
    );
  });

  on(msmThirdPartyBtn, "click", openThirdPartyModal);
  on(tpCloseBtn, "click", closeThirdPartyModal);
  on(tpCancelBtn, "click", closeThirdPartyModal);
  on(modalBackdrop, "click", (e) => {
    if (e.target === modalBackdrop) closeThirdPartyModal();
  });

  freqBtns.forEach((btn) => {
    on(btn, "click", () => {
      const val = btn.getAttribute("data-msm-freq");
      if (!val || val === configState.frequency) return;
      configState.frequency = val;
      renderConfigRow();
      void saveConfigPatch({ frequency: val });
    });
  });

  thinkBtns.forEach((btn) => {
    on(btn, "click", () => {
      const val = btn.getAttribute("data-msm-think");
      if (!val || val === configState.thinking) return;
      configState.thinking = val;
      renderConfigRow();
      void saveConfigPatch({ thinking: val });
    });
  });

  tpProtoBtns.forEach((btn) => {
    on(btn, "click", () => {
      const nextProto = btn.getAttribute("data-tp-proto") || "openai";
      if (nextProto === draftProto) return;
      applyProtocolUi(nextProto, true);
      draftModels = [...(PROTOCOL_PRESETS[nextProto] || PROTOCOL_PRESETS.openai).models];
      populateModelSelect(draftModels, draftModels[0]);
      if (tpFetchStatus) {
        tpFetchStatus.textContent = `已切换至 ${PROTOCOL_PRESETS[draftProto].name} 协议，可点击获取模型`;
        tpFetchStatus.className = "tp-fetch-status";
      }
      if (tpTestResult) {
        tpTestResult.textContent = "";
        tpTestResult.className = "tp-test-result";
      }
    });
  });

  on(tpToggleKeyBtn, "click", () => {
    if (!tpKeyInput) return;
    const showing = tpKeyInput.type === "text";
    tpKeyInput.type = showing ? "password" : "text";
    tpToggleKeyBtn.textContent = showing ? "显示" : "隐藏";
  });

  on(tpFetchBtn, "click", async () => {
    const baseUrl = tpUrlInput ? tpUrlInput.value.trim() : "";
    const apiKey = tpKeyInput ? tpKeyInput.value.trim() : "";
    tpFetchBtn.disabled = true;
    tpFetchBtn.textContent = "获取中...";
    if (tpFetchStatus) {
      tpFetchStatus.textContent = "正在通过本机后端请求 /models ...";
      tpFetchStatus.className = "tp-fetch-status";
    }
    try {
      const res = await callJson(apiFetch, "/api/mastery/thirdparty/models", {
        method: "POST",
        body: JSON.stringify({ protocol: draftProto, baseUrl, apiKey }),
      });
      if (Array.isArray(res?.models) && res.models.length > 0) {
        draftModels = res.models;
        populateModelSelect(draftModels, draftModels[0]);
        if (tpFetchStatus) {
          tpFetchStatus.textContent = `✓ 已实时拉取 ${draftModels.length} 个模型 (${res.latencyMs || 0}ms)`;
          tpFetchStatus.className = "tp-fetch-status is-ok";
        }
      }
    } catch (err) {
      if (tpFetchStatus) {
        tpFetchStatus.textContent = err?.message || "拉取模型失败，已保留当前列表";
        tpFetchStatus.className = "tp-fetch-status is-warn";
      }
    } finally {
      tpFetchBtn.disabled = false;
      tpFetchBtn.textContent = "获取模型";
    }
  });

  on(tpTestConnBtn, "click", async () => {
    const baseUrl = tpUrlInput ? tpUrlInput.value.trim() : "";
    const apiKey = tpKeyInput ? tpKeyInput.value.trim() : "";
    const model = tpModelSelect ? tpModelSelect.value : "";
    if (!baseUrl) {
      if (tpTestResult) {
        tpTestResult.textContent = "请先填写接口地址";
        tpTestResult.className = "tp-test-result is-err";
      }
      return;
    }
    tpTestConnBtn.disabled = true;
    tpTestConnBtn.textContent = "测试中...";
    if (tpTestResult) {
      tpTestResult.textContent = "正在检测接口连通性...";
      tpTestResult.className = "tp-test-result";
    }
    try {
      const res = await callJson(apiFetch, "/api/mastery/thirdparty/test", {
        method: "POST",
        body: JSON.stringify({
          protocol: draftProto,
          baseUrl,
          apiKey,
          model,
          thinking: configState.thinking,
        }),
      });
      if (tpTestResult) {
        tpTestResult.textContent = `✓ ${PROTOCOL_PRESETS[draftProto].name} 连通正常 · ${model} (${res.latencyMs}ms)`;
        tpTestResult.className = "tp-test-result is-ok";
      }
    } catch (err) {
      if (tpTestResult) {
        tpTestResult.textContent = err?.message || "连通测试失败";
        tpTestResult.className = "tp-test-result is-err";
      }
    } finally {
      tpTestConnBtn.disabled = false;
      tpTestConnBtn.textContent = "测试连通";
    }
  });

  on(tpSaveBtn, "click", async () => {
    const baseUrl =
      (tpUrlInput ? tpUrlInput.value.trim() : "") || PROTOCOL_PRESETS[draftProto].urlPlaceholder;
    const apiKey = tpKeyInput ? tpKeyInput.value.trim() : "";
    const selectedModel = tpModelSelect ? tpModelSelect.value : draftModels[0] || "gpt-4o-mini";

    const saved = await saveConfigPatch(
      {
        enabled: true,
        source: "thirdparty",
        thirdParty: {
          protocol: draftProto,
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          fetchedModels: [...draftModels],
          selectedModel,
        },
      },
      { toastText: `已保存并启用第三方总结模型：${selectedModel}` }
    );
    if (saved) {
      closeThirdPartyModal();
      void refreshMastery();
    }
  });

  if (typeof ResizeObserver !== "undefined" && graphStageEl) {
    resizeObserver = new ResizeObserver(() => drawGraphEdges());
    resizeObserver.observe(graphStageEl);
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    on(window, "resize", () => drawGraphEdges());
  }

  renderConfigRow();

  return {
    setTabActive(active) {
      tabActive = Boolean(active);
      if (tabActive) {
        void refreshMastery();
        startPolling();
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => drawGraphEdges());
        }
      } else {
        stopPolling();
      }
    },
    refresh() {
      if (tabActive) {
        void refreshMastery();
      }
    },
    setTranslator() {},
    destroy() {
      destroyed = true;
      stopPolling();
      resizeObserver?.disconnect?.();
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
