/**
 * AGY Memory Management Modal (`#memoryModal`) and topbar RAM status pill (`#memoryStatusBtn`).
 *
 * - Renders live per-group Antigravity & plugin memory usage, smart diagnostics,
 *   one-click safe working-set trim, companion restart, Zero-UIA toggle, and auto-trim guard.
 * - Strictly pure DOM construction (zero innerHTML interpolation, zero raw fetch calls).
 */

const MEMORY_POLL_MS = 30_000;
const THRESHOLD_PRESETS = Object.freeze([1500, 1800, 2500, 3500]);

function formatMemCompact(mb) {
  const n = Number(mb);
  if (!Number.isFinite(n) || n <= 0) return "--";
  if (n >= 1024) {
    return `${(n / 1024).toFixed(n >= 10240 ? 1 : 2)}G`;
  }
  return `${Math.round(n)}M`;
}

function formatMemDetail(mb) {
  const n = Number(mb);
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  if (n >= 1024) {
    return `${(n / 1024).toFixed(2)} GB`;
  }
  return `${Math.round(n)} MB`;
}

function formatUptimeShort(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

async function requestMemoryJson(apiFetch, url, options = {}) {
  const fetcher =
    typeof apiFetch === "function"
      ? apiFetch
      : typeof window !== "undefined" && typeof window.sidecar?.fetch === "function"
        ? window.sidecar.fetch
        : null;
  if (!fetcher) {
    throw new Error("请求通道暂不可用");
  }
  const res = await fetcher(url, options);
  if (res && typeof res.json === "function") {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
  }
  return res ?? {};
}

export function createMemoryModal({ apiFetch, t, onToast } = {}) {
  const triggerBtn = document.getElementById("memoryStatusBtn");
  const triggerLabel = document.getElementById("memoryStatusLabel");
  const modal = document.getElementById("memoryModal");
  const healthBadge = document.getElementById("memoryHealthBadge");
  const refreshBtn = document.getElementById("memoryRefreshBtn");
  const kpiPrivateWsEl = document.getElementById("memKpiPrivateWs");
  const kpiCommitEl = document.getElementById("memKpiCommit");
  const kpiSystemEl = document.getElementById("memKpiSystem");
  const kpiFreedEl = document.getElementById("memKpiFreed");
  const optimizeBtn = document.getElementById("memOptimizeBtn");
  const restartBtn = document.getElementById("memRestartCompanionsBtn");
  const diagnosticsList = document.getElementById("memDiagnosticsList");
  const groupsList = document.getElementById("memGroupsList");
  const topProcsList = document.getElementById("memTopProcsList");
  const zeroUiaToggle = document.getElementById("memZeroUiaToggle");
  const autoTrimToggle = document.getElementById("memAutoTrimToggle");
  const thresholdRow = document.getElementById("memThresholdRow");
  const footerMetaEl = document.getElementById("memoryFooterMeta");

  let translator = typeof t === "function" ? t : (k) => k;
  let lastStatus = null;
  let isOpen = false;
  let loading = false;
  let optimizing = false;
  let restarting = false;
  let savingSettings = false;
  let pollTimer = null;
  let destroyed = false;
  const cleanups = [];

  const tr = (key, fallback, vars) => {
    let raw = typeof translator === "function" ? translator(key, vars) : "";
    if (!raw || raw === key) raw = fallback;
    if (!vars) return raw;
    return String(raw).replace(/\{\{?(\w+)\}?\}/g, (_, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : ""
    );
  };

  function isVisible() {
    if (typeof document === "undefined") return true;
    return document.visibilityState !== "hidden";
  }

  function renderPill() {
    if (!triggerBtn || !triggerLabel) return;
    triggerBtn.classList.remove("is-healthy", "is-elevated", "is-high");
    if (!lastStatus || !lastStatus.summary) {
      triggerLabel.textContent = tr("nav.memoryLoading", "RAM --");
      return;
    }
    const totalMb = lastStatus.summary.totalPrivateWsMb || 0;
    const level = lastStatus.level || "healthy";
    triggerBtn.classList.add(`is-${level}`);
    triggerLabel.textContent = formatMemCompact(totalMb);
    const sys = lastStatus.system || {};
    const sysHint =
      sys.totalMb > 0
        ? ` · ${tr("memory.pillSystem", "系统占用 {pct}%", { pct: sys.loadPct || 0 })}`
        : "";
    triggerBtn.title = `${tr("memory.pillTooltip", "AGY 专用物理内存：{mem}（{count} 个进程）", {
      mem: formatMemDetail(totalMb),
      count: lastStatus.summary.processCount || 0,
    })}${sysHint}`;
  }

  function renderDiagnostics(diags) {
    if (!diagnosticsList) return;
    diagnosticsList.textContent = "";
    const items = Array.isArray(diags) ? diags : [];
    if (items.length === 0) {
      diagnosticsList.hidden = true;
      return;
    }
    diagnosticsList.hidden = false;

    for (const d of items) {
      const card = document.createElement("div");
      card.className = `mem-diag-card is-${d.level || "info"}`;

      const textWrap = document.createElement("div");
      textWrap.className = "mem-diag-text";

      const titleEl = document.createElement("div");
      titleEl.className = "mem-diag-title";
      const detailEl = document.createElement("div");
      detailEl.className = "mem-diag-detail";

      const data = d.data || {};
      if (d.code === "uia_active_restart_hint") {
        titleEl.textContent = tr("memory.diagUiaTitle", "主程序内存偏高（无障碍监听已开启）");
        detailEl.textContent = tr(
          "memory.diagUiaRestartDetail",
          "主程序当前占 {mainMb}。已开启省内存开关，重启一次软件即可释放。",
          { mainMb: formatMemDetail(data.mainMb), commitMb: formatMemDetail(data.mainCommitMb) }
        );
      } else if (d.code === "uia_active_enable_zero_uia") {
        titleEl.textContent = tr("memory.diagUiaTitle", "主程序内存偏高（无障碍监听已开启）");
        detailEl.textContent = tr(
          "memory.diagUiaEnableDetail",
          "主程序当前占 {mainMb}，建议开启下方「禁用无障碍监听」防止内存持续上涨。",
          { mainMb: formatMemDetail(data.mainMb) }
        );
      } else if (d.code === "companion_bloat") {
        titleEl.textContent = tr("memory.diagCompanionTitle", "伴侣进程占用偏高：{name}", {
          name: data.name || "agy_backdrop",
        });
        detailEl.textContent = tr(
          "memory.diagCompanionDetail",
          "当前占 {wsMb}（已运行 {hours}h），点重启可立即回落。",
          {
            wsMb: formatMemDetail(data.privateWsMb),
            commitMb: formatMemDetail(data.privateCommitMb),
            hours: data.uptimeHours || 0,
          }
        );
      } else if (d.code === "large_conv_db") {
        titleEl.textContent = tr("memory.diagLargeDbTitle", "单个会话记录较大（{size}）", {
          size: formatMemDetail(data.sizeMb),
        });
        detailEl.textContent = tr(
          "memory.diagLargeDbDetail",
          "超长对话会增加内存占用，建议执行 /compact 或开新对话。"
        );
      } else if (d.code === "many_renderers") {
        titleEl.textContent = tr("memory.diagRenderersTitle", "后台视图进程较多（{count} 个）", {
          count: data.count || 0,
        });
        detailEl.textContent = tr(
          "memory.diagRenderersDetail",
          "共占 {wsMb}，关闭闲置标签或点上方「一键释放」即可。",
          { wsMb: formatMemDetail(data.privateWsMb) }
        );
      } else if (d.code === "high_system_pressure") {
        titleEl.textContent = tr("memory.diagSysPressureTitle", "整机物理内存紧张（已用 {pct}%）", {
          pct: data.loadPct || 0,
        });
        detailEl.textContent = tr(
          "memory.diagSysPressureDetail",
          "系统剩余可用物理内存仅 {avail} / {total}，建议立即释放空闲工作集。",
          { avail: formatMemDetail(data.availableMb), total: formatMemDetail(data.totalMb) }
        );
      } else {
        titleEl.textContent = String(d.code || d.id || "");
        detailEl.textContent = "";
      }

      textWrap.appendChild(titleEl);
      if (detailEl.textContent) textWrap.appendChild(detailEl);
      card.appendChild(textWrap);

      if (d.action === "restart_companions" || d.action === "optimize_now") {
        const actBtn = document.createElement("button");
        actBtn.type = "button";
        actBtn.className = "mem-diag-action-btn";
        actBtn.textContent =
          d.action === "restart_companions"
            ? tr("memory.actionRestartShort", "重启伴侣")
            : tr("memory.actionOptimizeShort", "立即释放");
        actBtn.disabled = optimizing || restarting;
        actBtn.addEventListener("click", () => {
          if (d.action === "restart_companions") {
            void handleRestartCompanions();
          } else {
            void handleOptimizeNow();
          }
        });
        card.appendChild(actBtn);
      }

      diagnosticsList.appendChild(card);
    }
  }

  function renderGroups(status) {
    if (!groupsList) return;
    groupsList.textContent = "";
    const groups = status?.groups || {};
    const totalMb = Math.max(1, Number(status?.summary?.totalPrivateWsMb) || 1);

    const defs = [
      { key: "hostMain", label: tr("memory.groupHostMain", "Antigravity 主进程"), tone: "blue" },
      { key: "hostRenderers", label: tr("memory.groupRenderers", "渲染与 GPU 进程"), tone: "purple" },
      { key: "languageServer", label: tr("memory.groupLangServer", "语言服务 (language_server)"), tone: "amber" },
      { key: "pluginSelf", label: tr("memory.groupPluginSelf", "AGY 控制台与伴侣 (本插件)"), tone: "teal" },
      { key: "otherExtensions", label: tr("memory.groupOtherExt", "其他扩展与子进程"), tone: "muted" },
    ];

    for (const def of defs) {
      const g = groups[def.key] || { privateWsMb: 0, privateCommitMb: 0, count: 0 };
      const pct = Math.max(0, Math.min(100, Math.round((g.privateWsMb / totalMb) * 100)));

      const row = document.createElement("div");
      row.className = "mem-group-row";

      const head = document.createElement("div");
      head.className = "mem-group-head";

      const nameWrap = document.createElement("div");
      nameWrap.className = "mem-group-name-wrap";

      const nameEl = document.createElement("span");
      nameEl.className = "mem-group-name";
      nameEl.textContent = def.label;
      nameWrap.appendChild(nameEl);

      const cntEl = document.createElement("span");
      cntEl.className = "mem-group-count";
      cntEl.textContent = tr("memory.procCountShort", "{count} 进程", { count: g.count || 0 });
      nameWrap.appendChild(cntEl);

      if (def.key === "hostMain" && g.uiaLoaded) {
        const uiaTag = document.createElement("span");
        uiaTag.className = "mem-uia-tag";
        uiaTag.textContent = tr("memory.uiaLoadedTag", "UIA 已加载");
        nameWrap.appendChild(uiaTag);
      }

      const valWrap = document.createElement("div");
      valWrap.className = "mem-group-vals";

      const wsEl = document.createElement("span");
      wsEl.className = "mem-group-ws";
      wsEl.textContent = formatMemDetail(g.privateWsMb);
      valWrap.appendChild(wsEl);

      if (g.privateCommitMb > 0) {
        const cmEl = document.createElement("span");
        cmEl.className = "mem-group-commit";
        cmEl.textContent = `${tr("memory.commitShort", "提交")} ${formatMemDetail(g.privateCommitMb)}`;
        valWrap.appendChild(cmEl);
      }

      head.appendChild(nameWrap);
      head.appendChild(valWrap);

      const track = document.createElement("div");
      track.className = "mem-bar-track";
      const fill = document.createElement("div");
      fill.className = `mem-bar-fill is-${def.tone}`;
      fill.style.width = `${g.privateWsMb > 0 ? Math.max(2, pct) : 0}%`;
      track.appendChild(fill);

      row.appendChild(head);
      row.appendChild(track);
      groupsList.appendChild(row);
    }
  }

  function renderTopProcesses(status) {
    if (!topProcsList) return;
    topProcsList.textContent = "";
    const procs = Array.isArray(status?.topProcesses) ? status.topProcesses : [];
    if (procs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mem-empty-hint";
      empty.textContent = tr("memory.noProcesses", "暂未检测到进程数据");
      topProcsList.appendChild(empty);
      return;
    }

    for (const p of procs) {
      const row = document.createElement("div");
      row.className = "mem-proc-row";

      const left = document.createElement("div");
      left.className = "mem-proc-left";
      const nameEl = document.createElement("span");
      nameEl.className = "mem-proc-name";
      nameEl.textContent = p.name || "process";
      const pidEl = document.createElement("span");
      pidEl.className = "mem-proc-pid";
      pidEl.textContent = `PID ${p.pid}`;
      left.appendChild(nameEl);
      left.appendChild(pidEl);
      if (p.uiaLoaded) {
        const tag = document.createElement("span");
        tag.className = "mem-uia-tag is-mini";
        tag.textContent = "UIA";
        left.appendChild(tag);
      }

      const right = document.createElement("div");
      right.className = "mem-proc-right";
      const wsEl = document.createElement("span");
      wsEl.className = "mem-proc-ws";
      wsEl.textContent = formatMemDetail(p.privateWsMb);
      const metaEl = document.createElement("span");
      metaEl.className = "mem-proc-meta";
      metaEl.textContent = p.uptimeSec > 0 ? formatUptimeShort(p.uptimeSec) : "";
      right.appendChild(wsEl);
      if (metaEl.textContent) right.appendChild(metaEl);

      row.appendChild(left);
      row.appendChild(right);
      topProcsList.appendChild(row);
    }
  }

  function renderSettings(status) {
    const settings = status?.settings || {};
    const zeroUia = Boolean(settings.zeroUiaMode);
    const guard = settings.memoryGuard || { autoTrimEnabled: true, thresholdMb: 1800, intervalMin: 10 };

    if (zeroUiaToggle) {
      zeroUiaToggle.checked = zeroUia;
      zeroUiaToggle.disabled = savingSettings;
    }
    if (autoTrimToggle) {
      autoTrimToggle.checked = Boolean(guard.autoTrimEnabled);
      autoTrimToggle.disabled = savingSettings;
    }
    if (thresholdRow) {
      thresholdRow.textContent = "";
      const activeThreshold = Number(guard.thresholdMb) || 1800;
      for (const mb of THRESHOLD_PRESETS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `mem-threshold-chip${activeThreshold === mb ? " is-active" : ""}`;
        btn.textContent = `${(mb / 1000).toFixed(1)}G`;
        btn.disabled = savingSettings || !guard.autoTrimEnabled;
        btn.addEventListener("click", () => {
          void handleUpdateSettings({ thresholdMb: mb });
        });
        thresholdRow.appendChild(btn);
      }
    }
  }

  function renderModal() {
    renderPill();
    if (!modal) return;
    const st = lastStatus;

    if (healthBadge) {
      healthBadge.classList.remove("is-healthy", "is-elevated", "is-high");
      const level = st?.level || "healthy";
      healthBadge.classList.add(`is-${level}`);
      healthBadge.textContent =
        level === "high"
          ? tr("memory.levelHigh", "压力偏高")
          : level === "elevated"
            ? tr("memory.levelElevated", "中等占用")
            : tr("memory.levelHealthy", "运行轻快");
    }

    if (kpiPrivateWsEl) {
      kpiPrivateWsEl.textContent = st?.summary ? formatMemDetail(st.summary.totalPrivateWsMb) : "--";
    }
    if (kpiCommitEl) {
      kpiCommitEl.textContent = st?.summary ? formatMemDetail(st.summary.totalPrivateCommitMb) : "--";
    }
    if (kpiSystemEl) {
      const sys = st?.system;
      kpiSystemEl.textContent =
        sys && sys.totalMb > 0
          ? `${formatMemCompact(sys.availableMb)} (${sys.loadPct}%)`
          : "--";
    }
    if (kpiFreedEl) {
      const lastOpt = st?.lastOptimize;
      kpiFreedEl.textContent = lastOpt ? formatMemDetail(lastOpt.freedMb) : "--";
    }

    if (optimizeBtn) {
      optimizeBtn.disabled = optimizing || restarting;
      optimizeBtn.textContent = optimizing
        ? tr("memory.optimizing", "正在安全瘦身…")
        : tr("memory.optimizeBtn", "⚡ 一键释放全量内存");
    }
    if (restartBtn) {
      restartBtn.disabled = optimizing || restarting;
      restartBtn.textContent = restarting
        ? tr("memory.restartingCompanions", "正在重启伴侣…")
        : tr("memory.restartCompanionsBtn", "♻️ 重启伴侣进程");
    }
    if (refreshBtn) {
      refreshBtn.classList.toggle("is-spinning", loading);
    }

    renderDiagnostics(st?.diagnostics);
    renderGroups(st);
    renderTopProcesses(st);
    renderSettings(st);

    if (footerMetaEl) {
      const autoStats = st?.autoGuardStats;
      if (st?.supportedScope === "self-only") {
        footerMetaEl.textContent = tr(
          "memory.footerSelfOnly",
          "当前环境仅监控插件自身进程；Windows 下支持全量 AGY 进程瘦身。"
        );
      } else if (autoStats && autoStats.autoRunCount > 0) {
        footerMetaEl.textContent = tr(
          "memory.footerAutoCount",
          "仅安全压缩空闲工作集与缓存，不中断会话 · 已自动守护 {count} 次",
          { count: autoStats.autoRunCount }
        );
      } else {
        footerMetaEl.textContent = tr(
          "memory.footerSafeNote",
          "仅安全压缩空闲工作集与缓存，不关闭窗口、不中断运行中会话。"
        );
      }
    }
  }

  async function refresh({ force = false } = {}) {
    if (destroyed || loading) return lastStatus;
    loading = true;
    if (isOpen) renderModal();
    try {
      const data = await requestMemoryJson(
        apiFetch,
        `/api/memory/status${force ? "?force=1" : ""}`,
        { method: "GET" }
      );
      if (destroyed) return null;
      if (data && data.ok) {
        lastStatus = data;
      }
    } catch {
      // Keep last known snapshot silently on transient poll errors
    } finally {
      loading = false;
      if (!destroyed) {
        renderModal();
      }
    }
    return lastStatus;
  }

  async function handleOptimizeNow() {
    if (destroyed || optimizing || restarting) return;
    optimizing = true;
    renderModal();
    try {
      const res = await requestMemoryJson(apiFetch, "/api/memory/optimize", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (destroyed) return;
      if (res && res.ok) {
        if (res.status) lastStatus = res.status;
        const opt = res.optimize || {};
        onToast?.(
          tr("memory.optimizeSuccess", "已安全瘦身 {count} 个进程，释放 {freed}（当前 {after}）", {
            count: opt.trimmedCount || 0,
            freed: formatMemDetail(opt.freedMb || 0),
            after: formatMemDetail(opt.afterMb || 0),
          }),
          "success"
        );
      } else {
        onToast?.(res?.error || tr("memory.optimizeFailed", "内存释放失败"), "error");
      }
    } catch (err) {
      onToast?.(err?.message || tr("memory.optimizeFailed", "内存释放失败"), "error");
    } finally {
      optimizing = false;
      if (!destroyed) renderModal();
    }
  }

  async function handleRestartCompanions() {
    if (destroyed || optimizing || restarting) return;
    restarting = true;
    renderModal();
    try {
      const res = await requestMemoryJson(apiFetch, "/api/memory/restart-companions", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (destroyed) return;
      if (res && res.ok) {
        if (res.status) lastStatus = res.status;
        onToast?.(tr("memory.restartSuccess", "已重启插件伴侣进程，内存已回落"), "success");
      } else {
        onToast?.(res?.error || tr("memory.restartFailed", "重启伴侣进程失败"), "error");
      }
    } catch (err) {
      onToast?.(err?.message || tr("memory.restartFailed", "重启伴侣进程失败"), "error");
    } finally {
      restarting = false;
      if (!destroyed) renderModal();
    }
  }

  async function handleUpdateSettings(patch) {
    if (destroyed || savingSettings) return;
    savingSettings = true;
    renderModal();
    try {
      const res = await requestMemoryJson(apiFetch, "/api/memory/settings", {
        method: "POST",
        body: JSON.stringify(patch),
      });
      if (destroyed) return;
      if (res && res.ok) {
        if (res.status) lastStatus = res.status;
        onToast?.(tr("memory.settingsSaved", "内存优化策略已保存"), "success");
      } else {
        onToast?.(res?.error || tr("memory.settingsSaveFailed", "保存内存设置失败"), "error");
      }
    } catch (err) {
      onToast?.(err?.message || tr("memory.settingsSaveFailed", "保存内存设置失败"), "error");
    } finally {
      savingSettings = false;
      if (!destroyed) renderModal();
    }
  }

  function open() {
    if (!modal || destroyed) return;
    isOpen = true;
    modal.hidden = false;
    renderModal();
    void refresh({ force: true });
  }

  function close() {
    if (!modal) return;
    isOpen = false;
    modal.hidden = true;
  }

  if (triggerBtn) {
    const onOpenClick = () => open();
    triggerBtn.addEventListener("click", onOpenClick);
    cleanups.push(() => triggerBtn.removeEventListener("click", onOpenClick));
  }

  if (modal) {
    const closeTargets = modal.querySelectorAll("[data-memory-close]");
    closeTargets.forEach((el) => {
      const onCloseClick = () => close();
      el.addEventListener("click", onCloseClick);
      cleanups.push(() => el.removeEventListener("click", onCloseClick));
    });
  }

  if (refreshBtn) {
    const onRefClick = () => void refresh({ force: true });
    refreshBtn.addEventListener("click", onRefClick);
    cleanups.push(() => refreshBtn.removeEventListener("click", onRefClick));
  }

  if (optimizeBtn) {
    const onOptClick = () => void handleOptimizeNow();
    optimizeBtn.addEventListener("click", onOptClick);
    cleanups.push(() => optimizeBtn.removeEventListener("click", onOptClick));
  }

  if (restartBtn) {
    const onResClick = () => void handleRestartCompanions();
    restartBtn.addEventListener("click", onResClick);
    cleanups.push(() => restartBtn.removeEventListener("click", onResClick));
  }

  if (zeroUiaToggle) {
    const onZeroUiaChange = () => {
      void handleUpdateSettings({ zeroUiaMode: Boolean(zeroUiaToggle.checked) });
    };
    zeroUiaToggle.addEventListener("change", onZeroUiaChange);
    cleanups.push(() => zeroUiaToggle.removeEventListener("change", onZeroUiaChange));
  }

  if (autoTrimToggle) {
    const onAutoTrimChange = () => {
      void handleUpdateSettings({ autoTrimEnabled: Boolean(autoTrimToggle.checked) });
    };
    autoTrimToggle.addEventListener("change", onAutoTrimChange);
    cleanups.push(() => autoTrimToggle.removeEventListener("change", onAutoTrimChange));
  }

  if (typeof document !== "undefined") {
    const onKeyDown = (e) => {
      if (isOpen && e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    cleanups.push(() => document.removeEventListener("keydown", onKeyDown));
  }

  function schedulePoll() {
    if (destroyed) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      if (destroyed) return;
      if (isVisible()) {
        void refresh({ force: false }).finally(() => schedulePoll());
      } else {
        schedulePoll();
      }
    }, MEMORY_POLL_MS);
  }

  // Defer initial poll slightly so first-paint telemetry loads first
  pollTimer = setTimeout(() => {
    if (!destroyed && isVisible()) {
      void refresh({ force: false }).finally(() => schedulePoll());
    } else if (!destroyed) {
      schedulePoll();
    }
  }, 1500);

  return {
    open,
    close,
    refresh,
    setTranslator(nextT) {
      if (typeof nextT === "function") {
        translator = nextT;
        renderModal();
      }
    },
    destroy() {
      destroyed = true;
      clearTimeout(pollTimer);
      pollTimer = null;
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
