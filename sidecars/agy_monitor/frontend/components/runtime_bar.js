/**
 * Bottom runtime telemetry bar: generation speed (tok/s) and latest upstream model ID
 * with baseline comparison badge (no fabricated 5h quota pool estimator).
 */

function translate(tFn, key, zhFallback, enFallback, vars) {
  let raw = typeof tFn === "function" ? tFn(key, vars) : "";
  if (!raw || raw === key) {
    const lang = typeof tFn?.getLang === "function" ? tFn.getLang() : "zh-CN";
    raw = lang === "en" ? (enFallback ?? zhFallback) : zhFallback;
  }
  if (!vars) return raw;
  return String(raw).replace(/\{\{?(\w+)\}?\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : ""
  );
}

function formatSessionLabel(contextInfo, tr) {
  const title = typeof contextInfo?.activeConvTitle === "string" ? contextInfo.activeConvTitle.trim() : "";
  const id = typeof contextInfo?.activeConvId === "string" ? contextInfo.activeConvId.trim() : "";
  const rawName = title || (id ? id.slice(0, 8) : "");
  if (!rawName) return "";
  const shortName = rawName.length > 22 ? `${rawName.slice(0, 21)}…` : rawName;
  return contextInfo?.followLatest === false
    ? tr("runtime.lockedSessionTag", "已锁定 {title}", "Locked {title}", { title: shortName })
    : tr("runtime.followSessionTag", "跟随 {title}", "Following {title}", { title: shortName });
}

function renderSubSegments(el, segments) {
  if (!el) return;
  const fullText = segments.map((seg) => seg.text).join(" · ");
  el.textContent = "";
  segments.forEach((seg, idx) => {
    if (idx > 0) {
      const sep = document.createElement("span");
      sep.textContent = " · ";
      el.appendChild(sep);
    }
    const span = document.createElement("span");
    if (seg.highlight) {
      span.className =
        seg.tone === "model"
          ? "telemetry-sub-highlight is-model-tone"
          : "telemetry-sub-highlight is-speed-tone";
    }
    span.textContent = seg.text;
    el.appendChild(span);
  });
  el.title = fullText;
}

/**
 * Mounts the 2-column runtime telemetry bar onto #runtimeTelemetryRow DOM nodes.
 */
export function createRuntimeBar({ t } = {}) {
  const speedDot = document.getElementById("telemetrySpeedDot");
  const speedNumEl = document.getElementById("telemetrySpeedNum");
  const speedSubEl = document.getElementById("telemetrySpeedSub");

  const upstreamBadgeEl = document.getElementById("telemetryUpstreamBadge");
  const upstreamModelEl = document.getElementById("telemetryUpstreamModel");
  const upstreamSubEl = document.getElementById("telemetryUpstreamSub");

  let translator = t;
  let lastTelemetry = null;
  let lastContext = {};

  const tr = (key, zh, en, vars) => translate(translator, key, zh, en, vars);

  const renderSpeed = (telemetry, contextInfo) => {
    const latest = telemetry?.latestTokPerSec;
    const avg = telemetry?.avgTokPerSec;
    const source = telemetry?.speedSource;

    const hasLatest = typeof latest === "number" && Number.isFinite(latest) && latest > 0;
    if (speedDot) {
      speedDot.classList.toggle("is-idle", !hasLatest);
    }
    if (speedNumEl) {
      speedNumEl.textContent = hasLatest ? latest.toFixed(1) : "--";
    }
    if (speedSubEl) {
      const sessionTag = formatSessionLabel(contextInfo, tr);
      if (!hasLatest) {
        const waitingText = sessionTag
          ? `${tr("runtime.speedSampling", "等待首轮流式输出采样", "Waiting for streamed step sample")} · ${sessionTag}`
          : tr("runtime.speedSampling", "等待首轮流式输出采样", "Waiting for streamed step sample");
        speedSubEl.textContent = waitingText;
        speedSubEl.title = waitingText;
        return;
      }
      const sourceLabel =
        source === "conv_db_exact"
          ? tr("runtime.speedSourceExact", "会话精确耗时", "Exact turn timing")
          : source === "tool_step_e2e_est"
            ? tr("runtime.speedSourceTool", "工具步端到端参考", "Tool-step e2e est.")
            : tr("runtime.speedSourceRecent", "最近响应估算", "Recent step est.");
      const hasAvg = typeof avg === "number" && Number.isFinite(avg) && avg > 0;
      const segments = [{ text: sourceLabel, highlight: false }];
      if (hasAvg) {
        segments.push({
          text: tr("runtime.speedAvgOnly", "均值 {avg}", "Avg {avg}", { avg: avg.toFixed(1) }),
          highlight: true,
          tone: "speed",
        });
      }
      if (sessionTag) {
        segments.push({ text: sessionTag, highlight: false });
      }
      renderSubSegments(speedSubEl, segments);
    }
  };

  const renderUpstream = (telemetry) => {
    const modelId = telemetry?.upstreamModelId || "";
    const status = telemetry?.upstreamModelStatus || (modelId ? "no_baseline" : "unreported");
    const source = telemetry?.upstreamModelSource || "";
    const requestedDisplay = telemetry?.requestedModelLabel || telemetry?.requestedModelId || "";
    const cacheHitPct = telemetry?.cacheHitPct;

    if (upstreamModelEl) {
      const displayId =
        modelId || tr("runtime.upstreamNone", "尚无上游模型回传记录", "No upstream model logged yet");
      upstreamModelEl.textContent = displayId;
      upstreamModelEl.title =
        modelId && requestedDisplay && requestedDisplay.toLowerCase() !== modelId.toLowerCase()
          ? `${displayId} · ${tr("runtime.requestedModelTag", "请求 {model}", "Requested {model}", { model: requestedDisplay })}`
          : displayId;
      upstreamModelEl.classList.toggle(
        "is-alert",
        status === "downgrade_suspected" || status === "ab_or_alias"
      );
    }

    if (upstreamBadgeEl) {
      let badgeText = "";
      let badgeClass = "telemetry-status-pill";
      if (status === "match" && modelId) {
        badgeText = tr("runtime.statusMatch", "一致", "Match");
        badgeClass += " is-match";
      } else if (status === "downgrade_suspected") {
        badgeText = tr("runtime.statusDowngrade", "疑似降级", "Downgrade?");
        badgeClass += " is-danger";
      } else if (status === "ab_or_alias") {
        badgeText = tr("runtime.statusAlias", "灰测/别名", "A/B · Alias");
        badgeClass += " is-warning";
      } else if (status === "no_baseline" && modelId) {
        badgeText = tr("runtime.statusNoBaseline", "未设对照", "No Baseline");
        badgeClass += " is-muted";
      } else {
        badgeText = tr("runtime.statusUnreported", "未上报", "Unreported");
        badgeClass += " is-muted";
      }
      upstreamBadgeEl.className = badgeClass;
      upstreamBadgeEl.textContent = badgeText;
      upstreamBadgeEl.hidden = !badgeText;
    }

    if (upstreamSubEl) {
      const segments = [];
      if (typeof cacheHitPct === "number" && Number.isFinite(cacheHitPct)) {
        segments.push({
          text: tr("runtime.cacheHitSub", "缓存命中 {pct}%", "Cache hit {pct}%", {
            pct: Math.round(cacheHitPct),
          }),
          highlight: true,
          tone: "model",
        });
      }
      if (status === "downgrade_suspected") {
        segments.push({
          text:
            source === "conv_db_gen_metadata"
              ? tr("runtime.downgradeRequestedHint", "与本次请求模型不一致", "Differs from requested model")
              : tr("runtime.downgradeHint", "与默认选定模型不一致", "Differs from selected default"),
          highlight: false,
        });
      } else if (status === "ab_or_alias") {
        segments.push({
          text: tr("runtime.aliasHint", "检测到上游别名或灰测", "Upstream alias / A/B detected"),
          highlight: false,
        });
      } else if (status === "no_baseline" && modelId) {
        segments.push({
          text: tr("runtime.noBaselineHint", "未设发起偏好 · 仅读当前日志", "No launch baseline · logs only"),
          highlight: false,
        });
      } else if (status === "match" && requestedDisplay && requestedDisplay.toLowerCase() !== modelId.toLowerCase()) {
        segments.push({
          text: tr("runtime.requestedModelTag", "请求 {model}", "Requested {model}", {
            model: requestedDisplay,
          }),
          highlight: false,
        });
      }
      if (segments.length === 0) {
        segments.push({
          text: tr("runtime.upstreamSourceLog", "来自本地执行日志真实字段", "Read from local step logs"),
          highlight: false,
        });
      }
      renderSubSegments(upstreamSubEl, segments);
    }
  };

  const renderAll = () => {
    renderSpeed(lastTelemetry, lastContext);
    renderUpstream(lastTelemetry);
  };

  renderAll();

  return {
    update(runtimeTelemetry, contextInfo) {
      if (runtimeTelemetry && typeof runtimeTelemetry === "object") {
        lastTelemetry = runtimeTelemetry;
      }
      if (contextInfo && typeof contextInfo === "object") {
        lastContext = contextInfo;
      }
      renderAll();
    },
    setTranslator(nextT) {
      translator = nextT;
      renderAll();
    },
    destroy() {},
  };
}
