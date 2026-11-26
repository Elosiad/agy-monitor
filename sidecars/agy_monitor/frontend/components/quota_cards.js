/**
 * Native Antigravity quota cards strip (Gemini / GPT&Claude).
 *
 * Displays official 5-hour and weekly remaining quota rings with live reset
 * countdowns directly beneath the Model Token Usage list.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const RING_RADIUS = 10.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const AUTO_POLL_MS = 120_000;
const COUNTDOWN_TICK_MS = 30_000;
const ACTIVITY_REFRESH_DEBOUNCE_MS = 15_000;

const DEFAULT_GROUPS = [
  { key: "gemini", label: "Gemini", displayName: "Gemini Models" },
  { key: "gpt_claude", label: "GPT&Claude", displayName: "Claude and GPT models" },
];

function translate(tFn, key, fallback, vars) {
  let raw = typeof tFn === "function" ? tFn(key, vars) : "";
  if (!raw || raw === key) raw = fallback;
  if (!vars) return raw;
  return String(raw).replace(/\{\{?(\w+)\}?\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : ""
  );
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatLocalResetClock(resetTimeMs) {
  const ts = Number(resetTimeMs);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatResetCountdown(resetTimeMs, nowMs, tr) {
  const ts = Number(resetTimeMs);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { short: tr("quota.ready", "可用"), long: "" };
  }
  const diffMs = ts - nowMs;
  if (diffMs <= 0) {
    return {
      short: tr("quota.resettingSoon", "即将重置"),
      long: tr("quota.resettingSoon", "即将重置"),
    };
  }
  const totalMinutes = Math.ceil(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;

  if (days >= 1) {
    const short =
      hours > 0
        ? tr("quota.resetDaysHours", "{d}天{h}时重置", { d: days, h: hours })
        : tr("quota.resetDaysOnly", "{d}天后重置", { d: days });
    const long =
      hours > 0 ? `${days}天${hours}小时后` : `${days}天后`;
    return { short, long };
  }
  if (hours >= 1) {
    const short =
      mins > 0
        ? tr("quota.resetHoursMins", "{h}时{m}分重置", { h: hours, m: mins })
        : tr("quota.resetHoursOnly", "{h}小时重置", { h: hours });
    const long =
      mins > 0 ? `${hours}小时${mins}分钟后` : `${hours}小时后`;
    return { short, long };
  }
  if (mins >= 1) {
    const short = tr("quota.resetMinsOnly", "{m}分钟重置", { m: mins });
    return { short, long: `${mins}分钟后` };
  }
  return {
    short: tr("quota.resettingSoon", "即将重置"),
    long: tr("quota.resettingSoon", "即将重置"),
  };
}

function resolveHealthClass(bucket) {
  if (!bucket || bucket.disabled || bucket.remainingFraction === null || bucket.remainingFraction === undefined) {
    return "is-na";
  }
  const pct = Number(bucket.remainingPct);
  if (!Number.isFinite(pct)) return "is-na";
  if (pct < 20) return "is-danger";
  if (pct < 50) return "is-warn";
  return "is-healthy";
}

function createRingSvg(fraction, isAvailable) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "quota-ring-svg");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("viewBox", "0 0 28 28");
  svg.setAttribute("aria-hidden", "true");

  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("class", "quota-ring-track");
  track.setAttribute("cx", "14");
  track.setAttribute("cy", "14");
  track.setAttribute("r", String(RING_RADIUS));
  track.setAttribute("fill", "none");
  svg.appendChild(track);

  if (isAvailable) {
    const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
    const dashOffset = RING_CIRCUMFERENCE * (1 - clamped);

    const fill = document.createElementNS(SVG_NS, "circle");
    fill.setAttribute("class", "quota-ring-fill");
    fill.setAttribute("cx", "14");
    fill.setAttribute("cy", "14");
    fill.setAttribute("r", String(RING_RADIUS));
    fill.setAttribute("fill", "none");
    fill.setAttribute("transform", "rotate(-90 14 14)");
    fill.setAttribute("stroke-dasharray", RING_CIRCUMFERENCE.toFixed(2));
    fill.setAttribute("stroke-dashoffset", dashOffset.toFixed(2));
    svg.appendChild(fill);
  }

  return svg;
}

async function requestQuotaJson(apiFetch, url) {
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
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
  }
  return res ?? {};
}

/**
 * Mounts the 3-column official quota strip onto #quotaCardsStrip.
 */
export function createQuotaCards({ apiFetch, t, onQuotaUpdate, initialEnabled = true, deferStart = false } = {}) {
  const container = document.getElementById("quotaCardsStrip");

  let translator = t;
  let enabled = initialEnabled !== false;
  let state = {
    phase: "loading", // loading | ready | unavailable | disabled
    stale: false,
    source: "",
    error: "",
    fetchedAtMs: 0,
    groups: [],
  };
  let inFlight = false;
  let destroyed = false;
  let pollTimer = null;
  let tickTimer = null;
  let activityTimer = null;
  let lastNotifiedTokens = null;
  const cleanups = [];

  const tr = (key, fallback, vars) => translate(translator, key, fallback, vars);

  function stopTimers() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (activityTimer !== null) {
      clearTimeout(activityTimer);
      activityTimer = null;
    }
  }

  function buildRowElement(group, bucket, windowKind, nowMs) {
    const isFiveHour = windowKind === "5h";
    const titleLabel = isFiveHour
      ? tr("quota.fiveHour", "5小时")
      : tr("quota.weekly", "周额度");

    const row = document.createElement("div");
    const hasBucket = Boolean(bucket && !bucket.disabled && bucket.remainingFraction !== null && bucket.remainingFraction !== undefined);
    const healthClass = state.phase === "ready" ? resolveHealthClass(bucket) : "is-na";
    row.className = `quota-metric-row ${healthClass}`;

    const ringWrap = document.createElement("span");
    ringWrap.className = "quota-ring-wrap";
    ringWrap.appendChild(createRingSvg(hasBucket ? bucket.remainingFraction : 0, state.phase === "ready" && hasBucket));

    const body = document.createElement("div");
    body.className = "quota-metric-body";

    const titleLine = document.createElement("div");
    titleLine.className = "quota-metric-title";

    const nameEl = document.createElement("span");
    nameEl.className = "quota-metric-name";
    nameEl.textContent = titleLabel;

    const pctEl = document.createElement("span");
    pctEl.className = "quota-metric-pct";

    const labelEl = document.createElement("div");
    labelEl.className = "quota-metric-label";

    if (state.phase === "loading") {
      pctEl.textContent = "…";
      labelEl.textContent = tr("quota.loading", "读取中…");
    } else if (state.phase !== "ready") {
      pctEl.textContent = "—";
      labelEl.textContent = tr("quota.unavailable", "暂不可用");
    } else if (!bucket) {
      pctEl.textContent = "—";
      labelEl.textContent = tr("quota.noSeparateLimit", "无独立限额");
    } else if (bucket.disabled) {
      pctEl.textContent = "—";
      labelEl.textContent = tr("quota.disabled", "未启用");
    } else {
      const pctNum = Number.isFinite(Number(bucket.remainingPct)) ? Number(bucket.remainingPct) : 0;
      pctEl.textContent = `${pctNum}%`;

      if (bucket.isFull) {
        labelEl.textContent = tr("quota.fullAvailable", "满额可用");
      } else if (bucket.resetTimeMs) {
        const cd = formatResetCountdown(bucket.resetTimeMs, nowMs, tr);
        labelEl.textContent = cd.short;
      } else {
        labelEl.textContent = tr("quota.fullAvailable", "满额可用");
      }
    }

    titleLine.appendChild(nameEl);
    titleLine.appendChild(pctEl);
    body.appendChild(titleLine);
    body.appendChild(labelEl);

    row.appendChild(ringWrap);
    row.appendChild(body);

    // Rich hover tooltip with exact remaining fraction, local reset time, and group description
    const tipParts = [`${group.displayName || group.label} · ${titleLabel}`];
    if (state.phase === "ready" && bucket && !bucket.disabled) {
      const exactText =
        bucket.remainingPctExact !== null && bucket.remainingPctExact !== undefined
          ? `${bucket.remainingPctExact}%`
          : `${bucket.remainingPct ?? 0}%`;
      if (bucket.isFull) {
        tipParts.push(tr("quota.tipFull", "剩余：{pct}（满额可用）", { pct: exactText }));
      } else if (bucket.resetTimeMs) {
        const cd = formatResetCountdown(bucket.resetTimeMs, nowMs, tr);
        const clock = formatLocalResetClock(bucket.resetTimeMs);
        tipParts.push(
          tr("quota.tipReset", "剩余：{pct} · 将于 {clock} 重置（{after}）", {
            pct: exactText,
            clock,
            after: cd.long || cd.short,
          })
        );
      } else {
        tipParts.push(tr("quota.tipPctOnly", "剩余：{pct}", { pct: exactText }));
      }
    } else if (state.phase === "ready" && !bucket) {
      tipParts.push(tr("quota.tipNoSeparate", "当前分组未单独设置该周期限额"));
    } else if (state.phase === "unavailable" && state.error) {
      tipParts.push(state.error);
    }
    if (group.description) {
      tipParts.push(group.description);
    }
    if (state.source === "official_statusline") {
      tipParts.push(tr("quota.sourceStatusLine", "数据来源：官方 CLI statusLine 回调（零额外请求）"));
    } else if (state.source === "official_local_ls") {
      tipParts.push(tr("quota.sourceLocalLs", "数据来源：Antigravity 官方本机语言服务"));
    }
    tipParts.push(tr("quota.tipClickRefresh", "点击卡片立即刷新官方配额"));
    row.title = tipParts.join("\n");

    return row;
  }

  function syncCardLayoutClass() {
    const usageCard = container?.closest?.(".token-usage-card") || null;
    if (usageCard) {
      usageCard.classList.toggle("is-quota-disabled", !enabled);
    }
    if (container) {
      container.hidden = !enabled;
    }
  }

  function render() {
    if (!container) return;
    syncCardLayoutClass();
    if (!enabled) {
      container.innerHTML = "";
      container.classList.remove("is-loading", "is-stale", "is-unavailable", "is-refreshing");
      return;
    }
    const nowMs = Date.now();
    const activeGroups =
      state.phase === "ready" && Array.isArray(state.groups)
        ? state.groups.filter((g) => g && g.key !== "argon")
        : [];
    const groupsToRender =
      activeGroups.length > 0
        ? activeGroups
        : DEFAULT_GROUPS.map((g) => ({ ...g, description: "", fiveHour: null, weekly: null }));

    container.classList.toggle("is-loading", state.phase === "loading" || inFlight);
    container.classList.toggle("is-stale", Boolean(state.stale));
    container.classList.toggle("is-unavailable", state.phase === "unavailable");

    container.innerHTML = "";

    groupsToRender.forEach((group) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "quota-card";
      card.setAttribute("data-quota-group", String(group.key || "other"));
      card.setAttribute(
        "aria-label",
        `${group.label || group.displayName || "Quota"} ${tr("quota.cardAria", "配额余量，点击刷新")}`
      );

      const head = document.createElement("div");
      head.className = "quota-card-head";

      const dot = document.createElement("span");
      dot.className = `quota-group-dot is-${String(group.key || "other")}`;
      dot.setAttribute("aria-hidden", "true");

      const title = document.createElement("span");
      title.className = "quota-card-title";
      title.textContent = String(group.label || group.displayName || "");

      head.appendChild(dot);
      head.appendChild(title);

      const rows = document.createElement("div");
      rows.className = "quota-card-rows";
      rows.appendChild(buildRowElement(group, group.fiveHour || null, "5h", nowMs));
      rows.appendChild(buildRowElement(group, group.weekly || null, "weekly", nowMs));

      card.appendChild(head);
      card.appendChild(rows);

      card.addEventListener("click", () => {
        void refresh({ force: true });
      });

      container.appendChild(card);
    });
  }

  async function refresh({ force = false } = {}) {
    if (destroyed || !container || !enabled || inFlight) return null;
    inFlight = true;
    container.classList.add("is-refreshing");

    try {
      const data = await requestQuotaJson(apiFetch, `/api/quota${force ? "?force=1" : ""}`);
      if (destroyed || !enabled) return null;
      if (data && data.disabled) {
        setEnabled(false);
        return data;
      }
      if (data && data.ok && Array.isArray(data.groups) && data.groups.length > 0) {
        state = {
          phase: "ready",
          stale: Boolean(data.stale),
          source: typeof data.source === "string" ? data.source : "",
          error: data.error ? String(data.error) : "",
          fetchedAtMs: Number(data.fetchedAtMs) || Date.now(),
          groups: data.groups,
        };
        onQuotaUpdate?.(data);
      } else if (state.phase === "ready" && state.groups.length > 0) {
        state = {
          ...state,
          stale: true,
          error: String(data?.error || ""),
        };
      } else {
        state = {
          phase: "unavailable",
          stale: false,
          source: typeof data?.source === "string" ? data.source : "",
          error: String(data?.error || ""),
          fetchedAtMs: Date.now(),
          groups: [],
        };
      }
      render();
      return data;
    } catch (err) {
      if (destroyed || !enabled) return null;
      if (state.phase === "ready" && state.groups.length > 0) {
        state = {
          ...state,
          stale: true,
          error: err?.message ? String(err.message) : "",
        };
      } else {
        state = {
          phase: "unavailable",
          stale: false,
          error: err?.message ? String(err.message) : "",
          fetchedAtMs: Date.now(),
          groups: [],
        };
      }
      render();
      return null;
    } finally {
      inFlight = false;
      if (container) {
        container.classList.remove("is-refreshing");
        container.classList.toggle("is-loading", state.phase === "loading");
      }
    }
  }

  function isVisible() {
    if (typeof document === "undefined") return true;
    return document.visibilityState !== "hidden";
  }

  function startTimers() {
    if (!enabled || destroyed) return;
    if (pollTimer === null) {
      pollTimer = setInterval(() => {
        if (!destroyed && enabled && isVisible()) {
          void refresh({ force: false });
        }
      }, AUTO_POLL_MS);
    }
    if (tickTimer === null) {
      tickTimer = setInterval(() => {
        if (destroyed || !enabled || !isVisible() || state.phase !== "ready") return;
        const nowMs = Date.now();
        const needsReFetch = state.groups.some((g) => {
          const b5 = g.fiveHour;
          const bw = g.weekly;
          return (
            (b5 && !b5.isFull && b5.resetTimeMs && b5.resetTimeMs <= nowMs) ||
            (bw && !bw.isFull && bw.resetTimeMs && bw.resetTimeMs <= nowMs)
          );
        });
        if (needsReFetch) {
          void refresh({ force: true });
        } else {
          render();
        }
      }, COUNTDOWN_TICK_MS);
    }
  }

  function setEnabled(nextEnabled, { fetchNow = false } = {}) {
    const target = nextEnabled !== false;
    const prev = enabled;
    enabled = target;
    if (!enabled) {
      stopTimers();
      state = {
        phase: "disabled",
        stale: false,
        source: "disabled",
        error: "",
        fetchedAtMs: 0,
        groups: [],
      };
      render();
      onQuotaUpdate?.(null);
      return Promise.resolve(null);
    }
    if (!prev || state.phase === "disabled") {
      state = {
        phase: "loading",
        stale: false,
        source: "",
        error: "",
        fetchedAtMs: 0,
        groups: [],
      };
    }
    render();
    startTimers();
    if (fetchNow) {
      return refresh({ force: false });
    }
    return Promise.resolve(null);
  }

  function notifyTokenActivity(totalTokens) {
    if (!enabled || destroyed) return;
    const n = Number(totalTokens);
    if (!Number.isFinite(n)) return;
    if (lastNotifiedTokens === null) {
      lastNotifiedTokens = n;
      return;
    }
    if (n === lastNotifiedTokens) return;
    lastNotifiedTokens = n;
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
      activityTimer = null;
      if (!destroyed && enabled && isVisible()) {
        void refresh({ force: true });
      }
    }, ACTIVITY_REFRESH_DEBOUNCE_MS);
  }

  // Initial skeleton render + timers (deferred when app.js gates on /api/preferences first)
  render();
  if (!deferStart && enabled) {
    startTimers();
  }

  return {
    refresh,
    setEnabled,
    isEnabled: () => enabled,
    notifyTokenActivity,
    setTranslator(nextT) {
      translator = nextT;
      render();
    },
    destroy() {
      destroyed = true;
      stopTimers();
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
