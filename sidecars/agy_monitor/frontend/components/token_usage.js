/**
 * Model token usage breakdown with Global/Current x Today/7d/30d filters,
 * accordion details (cache hit/miss/output), and API reference cost estimate
 * (marked clearly as reference only with zero subscription billing).
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const REQ_PAGE_SIZE = 80;

function translate(tFn, key, fallback, vars) {
  let raw = typeof tFn === "function" ? tFn(key, vars) : "";
  if (!raw || raw === key) raw = fallback;
  if (!vars) return raw;
  return String(raw).replace(/\{\{?(\w+)\}?\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : ""
  );
}

function formatUsd(val) {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return "$0.00";
  if (num < 0.01) return `$${num.toFixed(4)}`;
  if (num < 1) return `$${num.toFixed(4).replace(/0{1,2}$/, "")}`;
  return `$${num.toFixed(2)}`;
}

function formatRowCostUsd(val) {
  if (val === null || val === undefined) return "—";
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) return "—";
  if (num === 0) return "$0.00";
  if (num < 0.01) return `$${num.toFixed(4)}`;
  if (num < 1) return `$${num.toFixed(3)}`;
  return `$${num.toFixed(2)}`;
}

function formatCompactTokens(val) {
  const n = Math.max(0, Number(val) || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toLocaleString("en-US");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatRequestTime(ms) {
  const ts = Number(ms);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { short: "—", full: "" };
  }
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const timePart = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const datePart = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const full = `${d.getFullYear()}-${datePart} ${timePart}`;
  return {
    short: sameDay ? timePart : `${datePart} ${timePart}`,
    full,
  };
}

function formatDurationMs(ms) {
  if (ms === null || ms === undefined) return "—";
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const mins = Math.floor(n / 60_000);
  const secs = Math.round((n % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatTtftMs(ms) {
  if (ms === null || ms === undefined) return "—";
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

async function requestJson(apiFetch, url) {
  const fetcher =
    typeof apiFetch === "function"
      ? apiFetch
      : typeof window !== "undefined" && typeof window.sidecar?.fetch === "function"
        ? window.sidecar.fetch
        : null;
  if (!fetcher) {
    throw new Error("window.sidecar.fetch is unavailable");
  }
  const res = await fetcher(url, { method: "GET" });
  if (res && typeof res.json === "function") {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.reason || data?.error || `HTTP ${res.status}`);
    }
    return data;
  }
  return res ?? {};
}

function createSvgIcon(kind) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS(SVG_NS, "path");
  if (kind === "spark") {
    svg.setAttribute("class", "model-spark-icon");
    path.setAttribute("d", "M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4 8 1.5Z");
    path.setAttribute("fill", "currentColor");
  } else {
    svg.setAttribute("class", "model-chevron");
    path.setAttribute("d", "M6 4.2 9.8 8 6 11.8");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.45");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
  }
  svg.appendChild(path);
  return svg;
}

function createDetailRow({ label, pillText, pillClass, valueText }) {
  const row = document.createElement("div");
  row.className = "model-detail-row";

  const labelGroup = document.createElement("span");
  labelGroup.className = "detail-label-group";

  const labelSpan = document.createElement("span");
  labelSpan.textContent = label;
  labelGroup.appendChild(labelSpan);

  if (pillText) {
    const pill = document.createElement("span");
    pill.className = `detail-rate-pill ${pillClass || ""}`.trim();
    pill.textContent = pillText;
    labelGroup.appendChild(pill);
  }

  const valueSpan = document.createElement("span");
  valueSpan.className = "detail-value";
  valueSpan.textContent = valueText;

  row.appendChild(labelGroup);
  row.appendChild(valueSpan);
  return row;
}

/**
 * Mounts the model token usage component onto the #panelGeneral DOM nodes.
 */
export function createTokenUsage({ apiFetch, t, onFilterChange, getActiveConvContext, onToast } = {}) {
  const card = document.querySelector(".token-usage-card");
  const container = document.getElementById("tokenModelsList");
  const totalCountEl = document.getElementById("tokenTotalCount");
  const totalCostEl = document.getElementById("tokenTotalCost");
  const filterTabs = card ? card.querySelectorAll(".card-title-filters .filter-tab") : [];

  // Per-request records modal DOM nodes
  const openRequestsBtn = document.getElementById("tokenRequestsBtn");
  const reqModal = document.getElementById("tokenRequestsModal");
  const reqScopeBadgeEl = document.getElementById("reqModalScopeBadge");
  const reqRefreshBtn = document.getElementById("reqModalRefreshBtn");
  const reqModelSelect = document.getElementById("reqModelFilter");
  const reqSummaryBar = document.getElementById("reqSummaryBar");
  const reqTableBody = document.getElementById("reqTableBody");
  const reqTableWrap = document.getElementById("reqTableWrap");
  const reqPrevPageBtn = document.getElementById("reqPrevPageBtn");
  const reqNextPageBtn = document.getElementById("reqNextPageBtn");
  const reqPageInfoEl = document.getElementById("reqPageInfo");
  const reqCloseEls = reqModal ? reqModal.querySelectorAll("[data-req-modal-close]") : [];
  const reqScopeTabs = reqModal ? reqModal.querySelectorAll("[data-req-scope]") : [];
  const reqRangeTabs = reqModal ? reqModal.querySelectorAll("[data-req-range]") : [];
  const reqStatusTabs = reqModal ? reqModal.querySelectorAll("[data-req-status]") : [];

  let translator = t;
  let activeScope = "current";
  let activeRange = "today";
  let lastSnapshot = null;
  let hasUserToggled = false;
  let destroyed = false;
  const expandedNames = new Set();
  const cleanups = [];

  const reqState = {
    open: false,
    scope: "current",
    range: "today",
    status: "all",
    model: "",
    page: 0,
    totalCount: 0,
    fetchSeq: 0,
    lastData: null,
  };

  const tr = (key, fallback, vars) => translate(translator, key, fallback, vars);

  // Read initial active tabs from DOM
  filterTabs.forEach((tab) => {
    if (tab.classList.contains("is-active")) {
      if (tab.dataset.scope) activeScope = tab.dataset.scope;
      if (tab.dataset.range) activeRange = tab.dataset.range;
    }
  });

  function syncFilterDom() {
    filterTabs.forEach((tab) => {
      let isCurrent = false;
      if (tab.dataset.scope) isCurrent = tab.dataset.scope === activeScope;
      if (tab.dataset.range) isCurrent = tab.dataset.range === activeRange;
      tab.classList.toggle("is-active", isCurrent);
      tab.setAttribute("aria-selected", String(isCurrent));
    });
  }

  function render() {
    if (!container) return;
    const data = lastSnapshot || { totalTokens: 0, estimatedApiRefCostUsd: 0, models: [] };
    const totalTokens = Math.max(0, Number(data.totalTokens) || 0);
    const totalCostUsd = Number(data.estimatedApiRefCostUsd) || 0;
    const models = Array.isArray(data.models) ? data.models : [];

    if (totalCountEl) {
      totalCountEl.textContent = Math.round(totalTokens).toLocaleString("en-US");
    }
    const hasUnpriced = models.some(
      (m) => Boolean(m?.isUnpriced) || m?.estimatedCostUsd === null || m?.estimatedCostUsd === undefined
    );
    const hasPriced = models.some(
      (m) => !m?.isUnpriced && m?.estimatedCostUsd !== null && m?.estimatedCostUsd !== undefined
    );
    if (totalCostEl) {
      if (models.length > 0 && hasUnpriced && !hasPriced) {
        totalCostEl.textContent = tr("usage.unpricedRef", "未定价参考");
        totalCostEl.title = "";
      } else if (hasUnpriced) {
        totalCostEl.textContent = `${formatUsd(totalCostUsd)}+`;
        totalCostEl.title = "";
      } else {
        totalCostEl.textContent = formatUsd(totalCostUsd);
        totalCostEl.title = "";
      }
    }

    container.innerHTML = "";

    if (models.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "token-empty-tip";
      emptyEl.textContent = tr("usage.empty", "当前筛选范围暂无模型用量");
      container.appendChild(emptyEl);
      return;
    }

    if (!hasUserToggled && expandedNames.size === 0 && models[0]?.model) {
      expandedNames.add(String(models[0].model));
    }

    models.forEach((m) => {
      const rawModelKey = String(m.model || m.name || "unknown");
      const isUnrecorded = rawModelKey === "__unrecorded__";
      const isUnpriced =
        Boolean(m.isUnpriced) || m.estimatedCostUsd === null || m.estimatedCostUsd === undefined;
      const displayName = isUnrecorded
        ? tr("usage.unrecordedModel", "历史未记录模型（v2.33前）")
        : rawModelKey;
      const costText = isUnpriced
        ? tr("usage.unpricedRef", "未定价参考")
        : formatUsd(m.estimatedCostUsd);

      const modelTotal = Math.max(0, Number(m.totalTokens) || 0);
      const cacheRead = Math.max(0, Number(m.cacheRead) || 0);
      const uncachedInput = Math.max(0, Number(m.uncachedInput) || 0);
      const output = Math.max(0, Number(m.output) || 0);
      const totalInput = cacheRead + uncachedInput;

      const hitPct = Number.isFinite(Number(m.cacheHitPct))
        ? Math.min(100, Math.max(0, Math.round(Number(m.cacheHitPct))))
        : (totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0);
      const missPct = totalInput > 0 ? Math.max(0, 100 - hitPct) : 0;

      const rawShare = Number.isFinite(Number(m.sharePct))
        ? Number(m.sharePct)
        : (totalTokens > 0 ? (modelTotal / totalTokens) * 100 : 0);
      const barWidth = modelTotal > 0 ? Math.min(100, Math.max(1.5, rawShare)) : 0;
      const isExpanded = expandedNames.has(rawModelKey);

      const item = document.createElement("div");
      item.className = `model-item${isExpanded ? " is-expanded" : ""}`;

      const headerBtn = document.createElement("button");
      headerBtn.type = "button";
      headerBtn.className = "model-header";
      headerBtn.setAttribute("aria-expanded", String(isExpanded));

      const headerTop = document.createElement("div");
      headerTop.className = "model-header-top";

      const nameWrap = document.createElement("div");
      nameWrap.className = "model-name-wrap";
      nameWrap.appendChild(createSvgIcon("chevron"));
      nameWrap.appendChild(createSvgIcon("spark"));

      const nameSpan = document.createElement("span");
      nameSpan.className = "model-item-name";
      nameSpan.title = displayName;
      nameSpan.textContent = displayName;
      nameWrap.appendChild(nameSpan);

      const metricsRight = document.createElement("div");
      metricsRight.className = "model-metrics-right";

      const tokensSpan = document.createElement("span");
      tokensSpan.className = "model-item-tokens";
      tokensSpan.textContent = Math.round(modelTotal).toLocaleString("en-US");

      const costSpan = document.createElement("span");
      costSpan.className = "model-item-cost";
      costSpan.textContent = costText;

      metricsRight.appendChild(tokensSpan);
      metricsRight.appendChild(costSpan);

      headerTop.appendChild(nameWrap);
      headerTop.appendChild(metricsRight);

      const barTrack = document.createElement("div");
      barTrack.className = "model-bar-track";
      const barFill = document.createElement("div");
      barFill.className = "model-bar-fill";
      barFill.style.width = `${barWidth.toFixed(2)}%`;
      barTrack.appendChild(barFill);

      headerBtn.appendChild(headerTop);
      headerBtn.appendChild(barTrack);

      const details = document.createElement("div");
      details.className = "model-details";
      details.appendChild(
        createDetailRow({
          label: tr("usage.cacheHit", "输入 (缓存命中)"),
          pillText: `${hitPct}%`,
          pillClass: "detail-rate-hit",
          valueText: Math.round(cacheRead).toLocaleString("en-US"),
        })
      );
      details.appendChild(
        createDetailRow({
          label: tr("usage.cacheMiss", "输入 (缓存未命中)"),
          pillText: `${missPct}%`,
          pillClass: "detail-rate-miss",
          valueText: Math.round(uncachedInput).toLocaleString("en-US"),
        })
      );
      details.appendChild(
        createDetailRow({
          label: tr("usage.output", "输出"),
          valueText: Math.round(output).toLocaleString("en-US"),
        })
      );

      headerBtn.addEventListener("click", () => {
        hasUserToggled = true;
        const nextExpanded = !item.classList.contains("is-expanded");
        item.classList.toggle("is-expanded", nextExpanded);
        headerBtn.setAttribute("aria-expanded", String(nextExpanded));
        if (nextExpanded) {
          expandedNames.add(rawModelKey);
        } else {
          expandedNames.delete(rawModelKey);
        }
      });

      item.appendChild(headerBtn);
      item.appendChild(details);
      container.appendChild(item);
    });
  }

  filterTabs.forEach((tab) => {
    const onTabClick = () => {
      const nextScope = tab.dataset.scope || activeScope;
      const nextRange = tab.dataset.range || activeRange;
      if (nextScope === activeScope && nextRange === activeRange) return;

      activeScope = nextScope;
      activeRange = nextRange;
      syncFilterDom();
      onFilterChange?.({ scope: activeScope, range: activeRange });
    };
    tab.addEventListener("click", onTabClick);
    cleanups.push(() => tab.removeEventListener("click", onTabClick));
  });

  // ========== Per-Request Logs Modal ==========
  function syncReqModalFilterDom() {
    reqScopeTabs.forEach((btn) => {
      const cur = btn.getAttribute("data-req-scope") === reqState.scope;
      btn.classList.toggle("is-active", cur);
      btn.setAttribute("aria-selected", String(cur));
    });
    reqRangeTabs.forEach((btn) => {
      const cur = btn.getAttribute("data-req-range") === reqState.range;
      btn.classList.toggle("is-active", cur);
      btn.setAttribute("aria-selected", String(cur));
    });
    reqStatusTabs.forEach((btn) => {
      const cur = btn.getAttribute("data-req-status") === reqState.status;
      btn.classList.toggle("is-active", cur);
      btn.setAttribute("aria-selected", String(cur));
    });
    if (reqScopeBadgeEl) {
      const scopeLabel =
        reqState.scope === "global"
          ? tr("usage.scopeGlobal", "全局")
          : tr("usage.scopeCurrent", "当前");
      const rangeLabel =
        reqState.range === "today"
          ? tr("usage.rangeToday", "今天")
          : reqState.range === "7d"
            ? tr("usage.range7d", "近七天")
            : tr("usage.range30d", "近一个月");
      const ctx = typeof getActiveConvContext === "function" ? getActiveConvContext() : null;
      const convSuffix =
        reqState.scope === "current" && ctx?.convTitle && ctx.convTitle !== "同步中…"
          ? ` · ${ctx.convTitle}`
          : "";
      reqScopeBadgeEl.textContent = `${scopeLabel} · ${rangeLabel}${convSuffix}`;
      reqScopeBadgeEl.title = reqScopeBadgeEl.textContent;
    }
  }

  function renderReqMessageRow(text, isError = false) {
    if (!reqTableBody) return;
    reqTableBody.textContent = "";
    const trEl = document.createElement("tr");
    trEl.className = "req-empty-row";
    const td = document.createElement("td");
    td.setAttribute("colspan", "10");
    td.className = isError ? "req-empty-cell is-error" : "req-empty-cell";
    td.textContent = text;
    trEl.appendChild(td);
    reqTableBody.appendChild(trEl);
  }

  function renderReqSummary(summary) {
    if (!reqSummaryBar) return;
    reqSummaryBar.textContent = "";
    const s = summary || {};
    const totalCount = Number(s.totalCount || 0);
    const errorCount = Number(s.errorCount || 0);
    const hitText =
      s.avgCacheHitPct === null || s.avgCacheHitPct === undefined ? "—" : `${s.avgCacheHitPct}%`;
    const costText =
      s.hasUnpriced && Number(s.estimatedCostUsd || 0) === 0
        ? tr("usage.unpricedRef", "未定价参考")
        : s.hasUnpriced
          ? `${formatUsd(s.estimatedCostUsd)}+`
          : formatUsd(s.estimatedCostUsd);
    const speedText =
      s.avgTokPerSec !== null && s.avgTokPerSec !== undefined
        ? `${Number(s.avgTokPerSec).toFixed(1)} tok/s`
        : "—";

    const chips = [
      {
        label: "请求数",
        value: errorCount > 0 ? `${totalCount}（异常 ${errorCount}）` : String(totalCount),
        mod: errorCount > 0 ? "is-warn" : "",
      },
      { label: "总输入", value: formatCompactTokens(s.totalInput || 0) },
      { label: "总输出", value: formatCompactTokens(s.totalOutput || 0) },
      { label: "平均命中", value: hitText, mod: Number(s.avgCacheHitPct) >= 70 ? "is-hit" : "" },
      { label: "估算费用", value: costText },
      { label: "均速", value: speedText },
    ];

    chips.forEach((chip) => {
      const box = document.createElement("div");
      box.className = `req-summary-chip${chip.mod ? ` ${chip.mod}` : ""}`;
      const lbl = document.createElement("span");
      lbl.className = "req-summary-label";
      lbl.textContent = chip.label;
      const val = document.createElement("span");
      val.className = "req-summary-val";
      val.textContent = chip.value;
      box.appendChild(lbl);
      box.appendChild(val);
      reqSummaryBar.appendChild(box);
    });
  }

  function renderReqModelOptions(models) {
    if (!reqModelSelect) return;
    const prevVal = reqState.model;
    reqModelSelect.textContent = "";

    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = tr("usage.reqAllModels", "全部模型");
    reqModelSelect.appendChild(allOpt);

    const list = Array.isArray(models) ? models : [];
    let hasPrev = prevVal === "";
    list.forEach((m) => {
      const id = String(m?.id || "");
      if (!id) return;
      if (id === prevVal) hasPrev = true;
      const opt = document.createElement("option");
      opt.value = id;
      const label =
        id === "__unrecorded__"
          ? tr("usage.unrecordedModel", "历史未记录模型（v2.33前）")
          : id;
      opt.textContent = `${label} (${Number(m.calls || 0)})`;
      reqModelSelect.appendChild(opt);
    });

    if (prevVal && !hasPrev) {
      const staleOpt = document.createElement("option");
      staleOpt.value = prevVal;
      staleOpt.textContent = prevVal;
      reqModelSelect.appendChild(staleOpt);
    }
    reqModelSelect.value = prevVal;
  }

  function renderReqRows(data) {
    if (!reqTableBody) return;
    const items = Array.isArray(data?.items) ? data.items : [];
    const totalCount = Number(data?.totalCount || 0);
    reqState.totalCount = totalCount;

    renderReqSummary(data?.summary);
    renderReqModelOptions(data?.models);

    const totalPages = Math.max(1, Math.ceil(totalCount / REQ_PAGE_SIZE));
    const curPage = Math.min(reqState.page, totalPages - 1);
    reqState.page = Math.max(0, curPage);

    if (reqPageInfoEl) {
      reqPageInfoEl.textContent =
        totalCount > 0
          ? `第 ${reqState.page + 1} / ${totalPages} 页 · 共 ${totalCount.toLocaleString("en-US")} 条`
          : "0 / 0";
    }
    if (reqPrevPageBtn) reqPrevPageBtn.disabled = reqState.page <= 0;
    if (reqNextPageBtn) reqNextPageBtn.disabled = !data?.hasMore;

    if (items.length === 0) {
      renderReqMessageRow(tr("usage.reqEmpty", "当前筛选条件下暂无请求记录"));
      return;
    }

    reqTableBody.textContent = "";
    items.forEach((row) => {
      const trEl = document.createElement("tr");
      trEl.className = `req-row is-${row.status || "ok"}`;

      // 1. 时间
      const timeInfo = formatRequestTime(row.createdAtMs);
      const tdTime = document.createElement("td");
      tdTime.className = "col-time is-mono";
      tdTime.textContent = timeInfo.short;
      const convMeta = row.convTitle
        ? `${row.convWorkspace ? `[${row.convWorkspace}] ` : ""}${row.convTitle}`
        : row.convId
          ? row.convId.slice(0, 8)
          : "";
      tdTime.title = [timeInfo.full, convMeta, `#${row.stepIndex}`].filter(Boolean).join(" · ");

      // 2. model_id
      const tdModel = document.createElement("td");
      tdModel.className = "col-model";
      const modelSpan = document.createElement("span");
      modelSpan.className = "req-model-pill is-mono";
      const modelDisplay =
        row.model === "__unrecorded__"
          ? tr("usage.unrecordedModel", "历史未记录模型（v2.33前）")
          : row.model || "—";
      modelSpan.textContent = modelDisplay;
      modelSpan.title = modelDisplay;
      tdModel.appendChild(modelSpan);

      // 3. 输入 (总输入 = 缓存命中 + 未命中)
      const tdIn = document.createElement("td");
      tdIn.className = "col-num is-mono";
      tdIn.textContent = row.totalInput > 0 ? row.totalInput.toLocaleString("en-US") : "0";
      if (row.totalInput > 0) {
        tdIn.title = `总输入 ${row.totalInput.toLocaleString("en-US")}（缓存命中 ${row.cacheRead.toLocaleString("en-US")} + 未命中 ${row.uncachedInput.toLocaleString("en-US")}）`;
      }

      // 4. 输出
      const tdOut = document.createElement("td");
      tdOut.className = "col-num is-mono";
      tdOut.textContent = row.output > 0 ? row.output.toLocaleString("en-US") : "0";

      // 5. 缓存命中率
      const tdHit = document.createElement("td");
      tdHit.className = "col-center";
      if (row.cacheHitPct === null || row.cacheHitPct === undefined) {
        tdHit.textContent = "—";
        tdHit.classList.add("is-muted");
      } else {
        const hitPill = document.createElement("span");
        const hitPct = Number(row.cacheHitPct);
        const hitTier = hitPct >= 70 ? "is-high" : hitPct >= 30 ? "is-mid" : "is-low";
        hitPill.className = `req-hit-pill ${hitTier}`;
        hitPill.textContent = `${hitPct}%`;
        tdHit.appendChild(hitPill);
      }

      // 6. 费用
      const tdCost = document.createElement("td");
      tdCost.className = "col-num is-mono";
      tdCost.textContent = formatRowCostUsd(row.estimatedCostUsd);
      if (row.estimatedCostUsd === null) {
        tdCost.classList.add("is-muted");
        tdCost.title = tr("usage.unpricedRef", "未定价参考");
      } else {
        tdCost.title = "按 API 公开单价估算参考";
      }

      // 7. 首字 (TTFT)
      const tdTtft = document.createElement("td");
      tdTtft.className = "col-num is-mono";
      tdTtft.textContent = formatTtftMs(row.ttftMs);
      if (!row.ttftMs) {
        tdTtft.classList.add("is-muted");
        tdTtft.title = "宿主日志未暴露流式首字时间 (TTFT)";
      }

      // 8. 耗时
      const tdDur = document.createElement("td");
      tdDur.className = "col-num is-mono";
      tdDur.textContent = formatDurationMs(row.durationMs);
      if (!row.durationMs) {
        tdDur.classList.add("is-muted");
        tdDur.title =
          row.status === "error"
            ? "异常中断请求未记录完整耗时"
            : "纯文本回复结束步，宿主日志未记录精确结束时刻";
      } else {
        tdDur.title = `工具步端到端耗时 ${row.durationMs}ms`;
      }

      // 9. tok速度
      const tdSpeed = document.createElement("td");
      tdSpeed.className = "col-num is-mono";
      if (row.tokPerSec !== null && row.tokPerSec !== undefined) {
        tdSpeed.textContent = `${Number(row.tokPerSec).toFixed(1)}`;
        tdSpeed.title = `${Number(row.tokPerSec).toFixed(1)} tok/s（输出 ${row.output} tokens / ${(row.durationMs / 1000).toFixed(1)}s）`;
      } else {
        tdSpeed.textContent = "—";
        tdSpeed.classList.add("is-muted");
      }

      // 10. 状态
      const tdStatus = document.createElement("td");
      tdStatus.className = "col-status";
      const badge = document.createElement("span");
      badge.className = `req-status-badge is-${row.status || "ok"}`;
      const dot = document.createElement("span");
      dot.className = "req-status-dot";
      const labelSpan = document.createElement("span");
      labelSpan.textContent = row.statusLabel || (row.status === "error" ? "失败" : "成功");
      badge.appendChild(dot);
      badge.appendChild(labelSpan);
      if (row.errorText) {
        badge.title = row.errorText;
      } else if (row.toolCallsCount > 0) {
        badge.title = `包含 ${row.toolCallsCount} 次工具调用`;
      }
      tdStatus.appendChild(badge);

      trEl.appendChild(tdTime);
      trEl.appendChild(tdModel);
      trEl.appendChild(tdIn);
      trEl.appendChild(tdOut);
      trEl.appendChild(tdHit);
      trEl.appendChild(tdCost);
      trEl.appendChild(tdTtft);
      trEl.appendChild(tdDur);
      trEl.appendChild(tdSpeed);
      trEl.appendChild(tdStatus);
      reqTableBody.appendChild(trEl);
    });
  }

  async function fetchRequestLogs() {
    if (!reqState.open || destroyed) return;
    const seq = ++reqState.fetchSeq;
    syncReqModalFilterDom();
    if (reqRefreshBtn) reqRefreshBtn.classList.add("is-spinning");
    renderReqMessageRow(tr("usage.reqLoading", "正在加载请求记录…"));

    try {
      const ctx = typeof getActiveConvContext === "function" ? getActiveConvContext() : {};
      const qs = new URLSearchParams({
        scope: reqState.scope,
        range: reqState.range,
        status: reqState.status,
        limit: String(REQ_PAGE_SIZE),
        offset: String(reqState.page * REQ_PAGE_SIZE),
      });
      if (reqState.model) qs.set("model", reqState.model);
      if (reqState.scope === "current") {
        if (ctx?.convId) qs.set("convId", String(ctx.convId));
        if (ctx?.hostConvId) qs.set("hostConvId", String(ctx.hostConvId));
      }
      const data = await requestJson(apiFetch, `/api/telemetry/requests?${qs.toString()}`);
      if (destroyed || !reqState.open || seq !== reqState.fetchSeq) return;
      const fetchedTotal = Number(data?.totalCount || 0);
      const fetchedItems = Array.isArray(data?.items) ? data.items : [];
      if (fetchedTotal > 0 && fetchedItems.length === 0 && reqState.page > 0) {
        reqState.page = Math.max(0, Math.ceil(fetchedTotal / REQ_PAGE_SIZE) - 1);
        void fetchRequestLogs();
        return;
      }
      reqState.lastData = data;
      renderReqRows(data);
      if (reqTableWrap) reqTableWrap.scrollTop = 0;
    } catch (err) {
      if (destroyed || !reqState.open || seq !== reqState.fetchSeq) return;
      const msg = err?.message || tr("usage.reqLoadError", "加载请求记录失败");
      renderReqMessageRow(msg, true);
      onToast?.(msg, "error");
    } finally {
      if (reqRefreshBtn && seq === reqState.fetchSeq) {
        reqRefreshBtn.classList.remove("is-spinning");
      }
    }
  }

  function openRequestsModal() {
    if (!reqModal) return;
    reqState.open = true;
    reqState.scope = activeScope;
    reqState.range = activeRange;
    reqState.status = "all";
    reqState.model = "";
    reqState.page = 0;
    reqModal.hidden = false;
    void fetchRequestLogs();
  }

  function closeRequestsModal() {
    if (!reqModal || !reqState.open) return;
    reqState.open = false;
    reqState.fetchSeq += 1;
    reqModal.hidden = true;
  }

  if (openRequestsBtn) {
    const onOpenClick = () => openRequestsModal();
    openRequestsBtn.addEventListener("click", onOpenClick);
    cleanups.push(() => openRequestsBtn.removeEventListener("click", onOpenClick));
  }

  reqCloseEls.forEach((el) => {
    const onCloseClick = () => closeRequestsModal();
    el.addEventListener("click", onCloseClick);
    cleanups.push(() => el.removeEventListener("click", onCloseClick));
  });

  if (reqRefreshBtn) {
    const onRefreshClick = () => void fetchRequestLogs();
    reqRefreshBtn.addEventListener("click", onRefreshClick);
    cleanups.push(() => reqRefreshBtn.removeEventListener("click", onRefreshClick));
  }

  reqScopeTabs.forEach((btn) => {
    const onScopeClick = () => {
      const next = btn.getAttribute("data-req-scope");
      if (!next || next === reqState.scope) return;
      reqState.scope = next;
      reqState.page = 0;
      void fetchRequestLogs();
    };
    btn.addEventListener("click", onScopeClick);
    cleanups.push(() => btn.removeEventListener("click", onScopeClick));
  });

  reqRangeTabs.forEach((btn) => {
    const onRangeClick = () => {
      const next = btn.getAttribute("data-req-range");
      if (!next || next === reqState.range) return;
      reqState.range = next;
      reqState.page = 0;
      void fetchRequestLogs();
    };
    btn.addEventListener("click", onRangeClick);
    cleanups.push(() => btn.removeEventListener("click", onRangeClick));
  });

  reqStatusTabs.forEach((btn) => {
    const onStatusClick = () => {
      const next = btn.getAttribute("data-req-status");
      if (!next || next === reqState.status) return;
      reqState.status = next;
      reqState.page = 0;
      void fetchRequestLogs();
    };
    btn.addEventListener("click", onStatusClick);
    cleanups.push(() => btn.removeEventListener("click", onStatusClick));
  });

  if (reqModelSelect) {
    const onModelChange = () => {
      reqState.model = reqModelSelect.value || "";
      reqState.page = 0;
      void fetchRequestLogs();
    };
    reqModelSelect.addEventListener("change", onModelChange);
    cleanups.push(() => reqModelSelect.removeEventListener("change", onModelChange));
  }

  if (reqPrevPageBtn) {
    const onPrev = () => {
      if (reqState.page <= 0) return;
      reqState.page -= 1;
      void fetchRequestLogs();
    };
    reqPrevPageBtn.addEventListener("click", onPrev);
    cleanups.push(() => reqPrevPageBtn.removeEventListener("click", onPrev));
  }

  if (reqNextPageBtn) {
    const onNext = () => {
      if (!reqState.lastData?.hasMore) return;
      reqState.page += 1;
      void fetchRequestLogs();
    };
    reqNextPageBtn.addEventListener("click", onNext);
    cleanups.push(() => reqNextPageBtn.removeEventListener("click", onNext));
  }

  const onKeyDown = (e) => {
    if (e.key === "Escape" && reqState.open) {
      e.stopImmediatePropagation?.();
      closeRequestsModal();
    }
  };
  document.addEventListener("keydown", onKeyDown, true);
  cleanups.push(() => document.removeEventListener("keydown", onKeyDown, true));

  render();

  return {
    update(tokenUsage) {
      if (tokenUsage && typeof tokenUsage === "object") {
        lastSnapshot = tokenUsage;
      }
      render();
    },
    getFilter() {
      return { scope: activeScope, range: activeRange };
    },
    setFilter({ scope, range } = {}) {
      if (scope) activeScope = scope;
      if (range) activeRange = range;
      syncFilterDom();
    },
    setTranslator(nextT) {
      translator = nextT;
      render();
      if (reqState.open && reqState.lastData) {
        syncReqModalFilterDom();
        renderReqRows(reqState.lastData);
      }
    },
    destroy() {
      destroyed = true;
      closeRequestsModal();
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
