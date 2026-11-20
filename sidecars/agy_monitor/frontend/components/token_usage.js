/**
 * Model token usage breakdown with Global/Current x Today/7d/30d filters,
 * accordion details (cache hit/miss/output), and API reference cost estimate
 * (marked clearly as reference only with zero subscription billing).
 */

const SVG_NS = "http://www.w3.org/2000/svg";

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
export function createTokenUsage({ t, onFilterChange } = {}) {
  const card = document.querySelector(".token-usage-card");
  const container = document.getElementById("tokenModelsList");
  const totalCountEl = document.getElementById("tokenTotalCount");
  const totalCostEl = document.getElementById("tokenTotalCost");
  const filterTabs = card ? card.querySelectorAll(".card-title-filters .filter-tab") : [];

  let translator = t;
  let activeScope = "current";
  let activeRange = "today";
  let lastSnapshot = null;
  let hasUserToggled = false;
  const expandedNames = new Set();
  const cleanups = [];

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
    },
    destroy() {
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
