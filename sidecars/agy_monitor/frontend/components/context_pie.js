/**
 * Context usage pie chart, honest legend breakdown (official base + rules addon),
 * hover tooltip, and window cap selector (256k / 512k / 1M).
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const CX = 80;
const CY = 80;
const RADIUS = 68;

const WINDOW_CAPS = [
  { key: "256k", cap: 256000 },
  { key: "512k", cap: 512000 },
  { key: "1M", cap: 1000000 },
];

const SEGMENT_META = [
  { id: "systemBase", color: "var(--pie-system-base, var(--accent-blue, #5B8DEF))" },
  { id: "rulesAddon", color: "var(--pie-rules-addon, var(--accent-purple, #9D6BFF))" },
  { id: "userHistory", color: "var(--pie-user-history, var(--accent-teal, #2EC4B6))" },
  { id: "toolsAndOutputs", color: "var(--pie-tools-outputs, var(--accent-amber, #E59824))" },
  { id: "remaining", color: "var(--pie-unused, var(--border-subtle, #343340))" },
];

function translate(tFn, key, fallback, vars) {
  let raw = typeof tFn === "function" ? tFn(key, vars) : "";
  if (!raw || raw === key) raw = fallback;
  if (!vars) return raw;
  return String(raw).replace(/\{\{?(\w+)\}?\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : ""
  );
}

async function requestJson(apiFetch, url, options) {
  const fetcher =
    typeof apiFetch === "function"
      ? apiFetch
      : typeof window !== "undefined" && typeof window.sidecar?.fetch === "function"
        ? window.sidecar.fetch
        : null;
  if (!fetcher) {
    throw new Error("window.sidecar.fetch is unavailable");
  }
  const res = await fetcher(url, options);
  if (res && typeof res.json === "function") {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.reason || data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  return res ?? {};
}

function resolveWindowConfig(capOrKey) {
  if (typeof capOrKey === "string") {
    const byKey = WINDOW_CAPS.find((item) => item.key.toLowerCase() === capOrKey.toLowerCase());
    if (byKey) return byKey;
  }
  const num = Number(capOrKey);
  return WINDOW_CAPS.find((item) => item.cap === num) || WINDOW_CAPS[1];
}

function polarToCartesian(centerX, centerY, radius, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(rad),
    y: centerY + radius * Math.sin(rad),
  };
}

function buildSectorPath(startAngle, endAngle) {
  const span = endAngle - startAngle;
  if (span <= 0.05) return "";
  const clampedEnd = span >= 359.99 ? startAngle + 359.99 : endAngle;
  const start = polarToCartesian(CX, CY, RADIUS, clampedEnd);
  const end = polarToCartesian(CX, CY, RADIUS, startAngle);
  const largeArc = clampedEnd - startAngle <= 180 ? "0" : "1";
  return [
    "M", CX, CY,
    "L", end.x.toFixed(3), end.y.toFixed(3),
    "A", RADIUS, RADIUS, 0, largeArc, 1, start.x.toFixed(3), start.y.toFixed(3),
    "Z",
  ].join(" ");
}

/**
 * Mounts the context pie component onto the #panelGeneral DOM nodes.
 */
export function createContextPie({ apiFetch, t, onWindowCapChange, onToast } = {}) {
  const svg = document.getElementById("contextPieSvg");
  const legend = document.getElementById("pieLegend");
  const stage = document.getElementById("pieStage");
  const tooltip = document.getElementById("pieTooltip");
  const tooltipDot = document.getElementById("pieTooltipDot");
  const tooltipLabel = document.getElementById("pieTooltipLabel");
  const tooltipCount = document.getElementById("pieTooltipCount");
  const tooltipPct = document.getElementById("pieTooltipPct");
  const summaryLine = document.getElementById("contextSummaryLine");
  const windowSelector = document.getElementById("windowSelector");
  const windowBadgeBtn = document.getElementById("windowBadgeBtn");
  const windowBadgeLabel = document.getElementById("windowBadgeLabel");
  const windowDropdown = document.getElementById("windowDropdown");

  let translator = t;
  let activeCap = 512000;
  let configuredRulesTokens = null;
  let latestPie = {
    windowCap: 512000,
    totalUsed: 0,
    percent: 0,
    segments: {
      systemBase: 0,
      rulesAddon: 0,
      userHistory: 0,
      toolsAndOutputs: 0,
      remaining: 512000,
    },
    isRulesEstimated: true,
  };
  let slices = [];
  let currentAngles = SEGMENT_META.map((_, idx) => (idx === SEGMENT_META.length - 1 ? 360 : 0));
  let animFrameId = null;
  let hoveredSliceId = null;
  let isSavingCap = false;

  const sliceEls = new Map();
  const legendEls = new Map();
  const legendLabelEls = new Map();
  const cleanups = [];

  const tr = (key, fallback, vars) => translate(translator, key, fallback, vars);

  function getSegmentLabel(id, value, forTooltip = false) {
    const formatted = Math.max(0, Math.round(value)).toLocaleString("en-US");
    switch (id) {
      case "systemBase":
        return tr("pie.segSystemBase", "系统底座");
      case "rulesAddon":
        return forTooltip
          ? tr("pie.segRulesAddon", "规则增量")
          : tr("pie.segRulesAddonFormatted", "规则增量 (+{tokens})", { tokens: formatted });
      case "userHistory":
        return tr("pie.segUserHistory", "用户与对话历史");
      case "toolsAndOutputs":
        return tr("pie.segToolsOutputs", "工具与输出");
      case "remaining":
      default:
        return tr("pie.segRemaining", "剩余可用");
    }
  }

  function resolveConfiguredRulesTokens() {
    if (typeof configuredRulesTokens === "number" && Number.isFinite(configuredRulesTokens)) {
      return Math.max(0, Math.round(configuredRulesTokens));
    }
    const badgeEl = typeof document !== "undefined" ? document.getElementById("promptActiveTokens") : null;
    if (badgeEl && badgeEl.textContent) {
      const parsed = Number(String(badgeEl.textContent).replace(/[^\d]/g, ""));
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return 0;
  }

  function buildSlices(pieData, capOverride) {
    const cap = Number(capOverride || pieData?.windowCap || activeCap) || 512000;
    const segs = pieData?.segments || {};
    const rawTotal = Number(pieData?.totalUsed);
    const hasExplicitZero = Number.isFinite(rawTotal) && rawTotal <= 0;

    const systemBase = hasExplicitZero ? 0 : Math.max(0, Number(segs.systemBase) || 0);
    const rulesAddon = hasExplicitZero ? 0 : Math.max(0, Number(segs.rulesAddon) || 0);
    const userHistory = hasExplicitZero ? 0 : Math.max(0, Number(segs.userHistory) || 0);
    const toolsAndOutputs = hasExplicitZero ? 0 : Math.max(0, Number(segs.toolsAndOutputs) || 0);
    const segUsedSum = systemBase + rulesAddon + userHistory + toolsAndOutputs;
    const totalUsed = Number.isFinite(rawTotal) ? Math.max(0, rawTotal) : segUsedSum;
    const remaining = Math.max(0, cap - totalUsed);

    const values = { systemBase, rulesAddon, userHistory, toolsAndOutputs, remaining };
    return {
      cap,
      totalUsed,
      list: SEGMENT_META.map((meta) => ({
        id: meta.id,
        color: meta.color,
        value: values[meta.id],
        label: getSegmentLabel(meta.id, values[meta.id], false),
        tooltipLabel: getSegmentLabel(meta.id, values[meta.id], true),
      })),
    };
  }

  function computeTargetAngles(sliceList, cap, totalUsed) {
    const denominator = Math.max(cap, totalUsed, 1);
    return sliceList.map((item) => (item.value / denominator) * 360);
  }

  function applyAngles(angles) {
    let cursor = -90;
    slices.forEach((slice, idx) => {
      const span = angles[idx] || 0;
      const endAngle = cursor + span;
      const path = sliceEls.get(slice.id);
      if (path) {
        const d = buildSectorPath(cursor, endAngle);
        if (d) {
          path.setAttribute("d", d);
          path.style.display = "";
        } else {
          path.removeAttribute("d");
          path.style.display = "none";
        }
      }
      cursor = endAngle;
    });
  }

  function updateSummaryAndLegend(cap, totalUsed) {
    const pct = cap > 0 ? Math.round((totalUsed / cap) * 100) : 0;
    if (summaryLine) {
      summaryLine.textContent = tr("pie.summaryFormat", "{used} / {cap} ({pct}%)", {
        used: Math.round(totalUsed).toLocaleString("en-US"),
        cap: Math.round(cap).toLocaleString("en-US"),
        pct,
      });
      summaryLine.classList.toggle("is-over-limit", totalUsed > cap);
    }

    slices.forEach((slice) => {
      const labelEl = legendLabelEls.get(slice.id);
      if (labelEl) {
        labelEl.textContent = slice.label;
      }
      const legendEl = legendEls.get(slice.id);
      if (legendEl) {
        legendEl.title = `${slice.tooltipLabel}: ${Math.round(slice.value).toLocaleString("en-US")} ${tr("pie.tokensUnit", "tokens")}`;
      }
      const path = sliceEls.get(slice.id);
      if (path) {
        const slicePct = cap > 0 ? ((slice.value / cap) * 100).toFixed(1) : "0.0";
        path.setAttribute(
          "aria-label",
          `${slice.tooltipLabel}: ${Math.round(slice.value).toLocaleString("en-US")} (${slicePct}%)`
        );
      }
    });
  }

  let lastHoverX = null;
  let lastHoverY = null;

  function showSliceHover(sliceId, clientX, clientY) {
    if (!stage || !tooltip) return;
    const slice = slices.find((item) => item.id === sliceId);
    if (!slice) return;
    hoveredSliceId = sliceId;
    if (typeof clientX === "number" && typeof clientY === "number") {
      lastHoverX = clientX;
      lastHoverY = clientY;
    }
    const useX = typeof clientX === "number" ? clientX : lastHoverX;
    const useY = typeof clientY === "number" ? clientY : lastHoverY;

    stage.classList.add("has-hover");
    sliceEls.forEach((el, id) => el.classList.toggle("is-hovered", id === slice.id));
    legendEls.forEach((el, id) => el.classList.toggle("is-hovered", id === slice.id));

    const pct = activeCap > 0 ? ((slice.value / activeCap) * 100).toFixed(1) : "0.0";
    const numStr = Math.round(slice.value).toLocaleString("en-US");
    const countText =
      slice.id === "rulesAddon"
        ? `+${numStr} ${tr("pie.tokensUnit", "tokens")}`
        : `${numStr} ${tr("pie.tokensUnit", "tokens")}`;

    if (tooltipDot) tooltipDot.style.background = slice.color;
    if (tooltipLabel) tooltipLabel.textContent = slice.tooltipLabel;
    if (tooltipCount) tooltipCount.textContent = countText;
    if (tooltipPct) tooltipPct.textContent = `${pct}%`;

    tooltip.classList.add("is-visible");
    tooltip.setAttribute("aria-hidden", "false");

    if (typeof useX === "number" && typeof useY === "number") {
      const stageRect = stage.getBoundingClientRect();
      const tipWidth = tooltip.offsetWidth || 156;
      const tipHeight = tooltip.offsetHeight || 48;
      let left = useX - stageRect.left;
      let top = useY - stageRect.top - tipHeight - 10;

      const minLeft = tipWidth / 2 + 4;
      const maxLeft = Math.max(minLeft, stageRect.width - tipWidth / 2 - 4);
      left = Math.min(Math.max(left, minLeft), maxLeft);
      if (top < 0) top = useY - stageRect.top + 14;

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      tooltip.style.transform = "translate(-50%, 0)";
    } else {
      tooltip.style.left = "50%";
      tooltip.style.top = "4px";
      tooltip.style.transform = "translate(-50%, 0)";
    }
  }

  function clearSliceHover() {
    hoveredSliceId = null;
    lastHoverX = null;
    lastHoverY = null;
    if (!stage || !tooltip) return;
    stage.classList.remove("has-hover");
    sliceEls.forEach((el) => el.classList.remove("is-hovered"));
    legendEls.forEach((el) => el.classList.remove("is-hovered"));
    tooltip.classList.remove("is-visible");
    tooltip.setAttribute("aria-hidden", "true");
  }

  function syncWindowBadge(cap) {
    const cfg = resolveWindowConfig(cap);
    activeCap = cfg.cap;
    if (windowBadgeLabel) {
      windowBadgeLabel.textContent = tr("pie.windowBadge", "{label} 窗口", { label: cfg.key });
    }
    if (windowDropdown) {
      windowDropdown.querySelectorAll(".window-option").forEach((opt) => {
        const optCap = Number(opt.getAttribute("data-cap"));
        const optKey = opt.getAttribute("data-window");
        const isCurrent = optCap === cfg.cap || optKey === cfg.key;
        opt.classList.toggle("is-active", isCurrent);
        opt.setAttribute("aria-selected", String(isCurrent));
      });
    }
  }

  function animatePieRefresh() {
    const built = buildSlices(latestPie, activeCap);
    slices = built.list;
    updateSummaryAndLegend(built.cap, built.totalUsed);

    const fromAngles = currentAngles.length === slices.length
      ? [...currentAngles]
      : slices.map(() => 0);
    const targetAngles = computeTargetAngles(slices, built.cap, built.totalUsed);

    if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    if (typeof requestAnimationFrame !== "function") {
      currentAngles = targetAngles;
      applyAngles(currentAngles);
      return;
    }

    const duration = 240;
    const startTime = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      currentAngles = fromAngles.map((from, i) => from + (targetAngles[i] - from) * eased);
      applyAngles(currentAngles);
      if (progress < 1) {
        animFrameId = requestAnimationFrame(step);
      } else {
        currentAngles = targetAngles;
        animFrameId = null;
      }
    };
    animFrameId = requestAnimationFrame(step);
  }

  function initDom() {
    if (!svg || !legend) return;
    svg.innerHTML = "";
    legend.innerHTML = "";

    const built = buildSlices(latestPie, activeCap);
    slices = built.list;
    currentAngles = computeTargetAngles(slices, built.cap, built.totalUsed);

    slices.forEach((slice) => {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("fill", slice.color);
      path.setAttribute("stroke", "var(--pie-slice-stroke, var(--bg-canvas, #070709))");
      path.setAttribute("stroke-width", "1.6");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("class", "pie-slice");
      path.setAttribute("data-slice-id", slice.id);
      path.setAttribute("tabindex", "0");

      path.addEventListener("mouseenter", (e) => showSliceHover(slice.id, e.clientX, e.clientY));
      path.addEventListener("mousemove", (e) => showSliceHover(slice.id, e.clientX, e.clientY));
      path.addEventListener("mouseleave", clearSliceHover);
      path.addEventListener("focus", () => showSliceHover(slice.id));
      path.addEventListener("blur", clearSliceHover);

      svg.appendChild(path);
      sliceEls.set(slice.id, path);

      const legendItem = document.createElement("div");
      legendItem.className = "legend-item";
      legendItem.setAttribute("data-slice-id", slice.id);

      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = slice.color;

      const labelSpan = document.createElement("span");
      labelSpan.className = "legend-label";
      labelSpan.textContent = slice.label;

      legendItem.appendChild(swatch);
      legendItem.appendChild(labelSpan);
      legendItem.addEventListener("mouseenter", () => showSliceHover(slice.id));
      legendItem.addEventListener("mouseleave", clearSliceHover);

      legend.appendChild(legendItem);
      legendEls.set(slice.id, legendItem);
      legendLabelEls.set(slice.id, labelSpan);
    });

    applyAngles(currentAngles);
    updateSummaryAndLegend(built.cap, built.totalUsed);
    syncWindowBadge(activeCap);
  }

  function initWindowDropdown() {
    if (!windowSelector || !windowBadgeBtn || !windowDropdown) return;

    const setDropdownOpen = (open) => {
      windowDropdown.hidden = !open;
      windowSelector.classList.toggle("is-open", open);
      windowBadgeBtn.setAttribute("aria-expanded", String(open));
    };

    const onBadgeClick = (e) => {
      e.stopPropagation();
      setDropdownOpen(windowDropdown.hidden);
    };
    windowBadgeBtn.addEventListener("click", onBadgeClick);
    cleanups.push(() => windowBadgeBtn.removeEventListener("click", onBadgeClick));

    windowDropdown.querySelectorAll(".window-option").forEach((opt) => {
      const onOptClick = async (e) => {
        e.stopPropagation();
        const rawCap = opt.getAttribute("data-cap") || opt.getAttribute("data-window");
        const nextCfg = resolveWindowConfig(rawCap);
        setDropdownOpen(false);
        if (nextCfg.cap === activeCap || isSavingCap) return;

        const prevCap = activeCap;
        syncWindowBadge(nextCfg.cap);
        animatePieRefresh();

        isSavingCap = true;
        try {
          const resp = await requestJson(apiFetch, "/api/preferences/window-cap", {
            method: "POST",
            body: JSON.stringify({ windowCap: nextCfg.cap }),
          });
          if (resp?.ok === false) {
            throw new Error(resp.reason || resp.error || "save failed");
          }
          onWindowCapChange?.(nextCfg.cap);
          onToast?.(
            tr("pie.windowSaved", "已切换上下文窗口上限为 {label}", { label: nextCfg.key }),
            "success"
          );
        } catch (err) {
          syncWindowBadge(prevCap);
          animatePieRefresh();
          onToast?.(tr("pie.windowSaveFailed", "保存窗口上限失败"), "error");
        } finally {
          isSavingCap = false;
        }
      };
      opt.addEventListener("click", onOptClick);
      cleanups.push(() => opt.removeEventListener("click", onOptClick));
    });

    const onDocClick = (e) => {
      if (!windowSelector.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    const onDocKeyDown = (e) => {
      if (e.key === "Escape" && !windowDropdown.hidden) {
        setDropdownOpen(false);
        windowBadgeBtn.focus();
      }
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onDocKeyDown);
    cleanups.push(() => document.removeEventListener("click", onDocClick));
    cleanups.push(() => document.removeEventListener("keydown", onDocKeyDown));
  }

  initDom();
  initWindowDropdown();

  return {
    update(contextPie, windowCap, options) {
      if (contextPie && typeof contextPie === "object") {
        latestPie = contextPie;
        if (typeof contextPie.configuredRulesTokens === "number") {
          configuredRulesTokens = Math.max(0, Math.round(contextPie.configuredRulesTokens));
        } else if (typeof contextPie.pendingRulesTokens === "number") {
          configuredRulesTokens = Math.max(0, Math.round(contextPie.pendingRulesTokens));
        }
      }
      if (options && typeof options.configuredRulesTokens === "number") {
        configuredRulesTokens = Math.max(0, Math.round(options.configuredRulesTokens));
      }
      const nextCap = Number(windowCap || contextPie?.windowCap || activeCap) || activeCap;
      syncWindowBadge(nextCap);
      animatePieRefresh();
      if (hoveredSliceId) {
        showSliceHover(hoveredSliceId);
      }
    },
    setConfiguredRulesTokens(tokens) {
      if (typeof tokens === "number" && Number.isFinite(tokens)) {
        configuredRulesTokens = Math.max(0, Math.round(tokens));
        const built = buildSlices(latestPie, activeCap);
        updateSummaryAndLegend(built.cap, built.totalUsed);
      }
    },
    setTranslator(nextT) {
      translator = nextT;
      syncWindowBadge(activeCap);
      const built = buildSlices(latestPie, activeCap);
      slices = built.list;
      updateSummaryAndLegend(built.cap, built.totalUsed);
      if (hoveredSliceId) {
        showSliceHover(hoveredSliceId);
      }
    },
    destroy() {
      if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
