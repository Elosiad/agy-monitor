/**
 * "其他" (Other) Tab Hub:
 * - Master toggle for official quota viewing & querying (ON by default).
 * - Official Antigravity compliance overview (statusLine callback + host loopback LS,
 *   zero direct cloudcode-pa.googleapis.com calls).
 * - One-click official Antigravity CLI `statusLine` bridge installer & command copy.
 */

function translate(tFn, key, fallback, vars) {
  let raw = typeof tFn === "function" ? tFn(key, vars) : "";
  if (!raw || raw === key) raw = fallback;
  if (!vars) return raw;
  return String(raw).replace(/\{\{?(\w+)\}?\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : ""
  );
}

async function copyTextSafe(text) {
  const value = String(text || "");
  if (!value) return false;
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fallback below
    }
  }
  if (typeof document === "undefined" || !document.body) return false;
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  ta.style.left = "-9999px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    return Boolean(document.execCommand?.("copy"));
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

export function createOtherHub({ apiFetch, t, onQuotaEnabledChange, onLiteModeChange, onToast } = {}) {
  const toggleInput = document.getElementById("otherQuotaToggle");
  const statusBadgeEl = document.getElementById("otherQuotaStatusBadge");
  const channelValEl = document.getElementById("otherQuotaChannelVal");
  const guardValEl = document.getElementById("otherQuotaGuardVal");
  const scopeValEl = document.getElementById("otherQuotaScopeVal");
  const slBadgeEl = document.getElementById("otherStatusLineBadge");
  const slInstallBtn = document.getElementById("otherStatusLineInstallBtn");
  const slCopyBtn = document.getElementById("otherStatusLineCopyBtn");
  const slCmdInput = document.getElementById("otherStatusLineCmdInput");
  const quotaCardEl = document.getElementById("otherQuotaMasterCard");
  const liteCardEl = document.getElementById("otherLiteModeCard");
  const liteToggleInput = document.getElementById("otherLiteModeToggle");
  const liteBadgeEl = document.getElementById("otherLiteModeBadge");
  const liteEffectValEl = document.getElementById("otherLiteEffectVal");
  const liteCostValEl = document.getElementById("otherLiteCostVal");

  let translator = t;
  let busyToggle = false;
  let busyLite = false;
  let busySl = false;
  let destroyed = false;
  const cleanups = [];

  const state = {
    quotaQueryEnabled: true,
    liteMode: false,
    compliance: {
      quotaQueryEnabled: true,
      activeSource: "official_local_ls",
      hasLocalLs: true,
      directCloudCodeBlocked: true,
      statusLine: {
        configured: false,
        configuredByOther: false,
        fresh: false,
        slashCommand: "",
        command: "",
      },
    },
  };

  const tr = (key, fallback, vars) => translate(translator, key, fallback, vars);

  async function requestJson(url, options = {}) {
    const res = await apiFetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function render() {
    const enabled = state.quotaQueryEnabled !== false;
    const comp = state.compliance || {};
    const sl = comp.statusLine || {};

    if (toggleInput) {
      toggleInput.checked = enabled;
      toggleInput.disabled = busyToggle;
      toggleInput.setAttribute("aria-checked", String(enabled));
    }
    if (quotaCardEl) {
      quotaCardEl.classList.toggle("is-disabled", !enabled);
    }

    if (statusBadgeEl) {
      statusBadgeEl.className = `other-status-pill ${enabled ? "is-on" : "is-off"}`;
      statusBadgeEl.textContent = enabled
        ? tr("other.quotaBadgeOn", "已开启")
        : tr("other.quotaBadgeOff", "已关闭");
    }

    if (channelValEl) {
      if (!enabled) {
        channelValEl.textContent = tr("other.channelDisabled", "已停用");
      } else if (comp.activeSource === "official_statusline" || sl.fresh) {
        channelValEl.textContent = tr("other.channelStatusLine", "CLI 回调");
      } else if (comp.hasLocalLs || comp.activeSource === "official_local_ls") {
        channelValEl.textContent = tr("other.channelLocalLs", "本机官方");
      } else {
        channelValEl.textContent = tr("other.channelWaiting", "等待就绪");
      }
    }

    if (guardValEl) {
      guardValEl.textContent = tr("other.guardBlocked", "仅官方安全通道");
    }

    if (scopeValEl) {
      scopeValEl.textContent = enabled
        ? tr("other.scopeOn", "全局生效")
        : tr("other.scopeOff", "已隐藏额度栏");
    }

    if (slBadgeEl) {
      if (sl.fresh) {
        slBadgeEl.className = "other-status-pill is-on";
        slBadgeEl.textContent = tr("other.slBadgeFresh", "同步中");
      } else if (sl.configured) {
        slBadgeEl.className = "other-status-pill is-info";
        slBadgeEl.textContent = tr("other.slBadgeConfigured", "已配置");
      } else if (sl.configuredByOther) {
        slBadgeEl.className = "other-status-pill is-warn";
        slBadgeEl.textContent = tr("other.slBadgeCustom", "已有自定义");
      } else {
        slBadgeEl.className = "other-status-pill is-muted";
        slBadgeEl.textContent = tr("other.slBadgeIdle", "未接入");
      }
    }

    if (slInstallBtn) {
      slInstallBtn.disabled = busySl;
      slInstallBtn.classList.toggle("is-toggled", Boolean(sl.configured));
      slInstallBtn.textContent = busySl
        ? tr("other.slWorking", "处理中…")
        : sl.configured
          ? tr("other.slUninstallBtn", "移除配置")
          : tr("other.slInstallBtn", "一键配置");
    }

    const slashCmd = sl.slashCommand || "";
    if (slCmdInput) {
      slCmdInput.value = slashCmd;
      slCmdInput.hidden = !slashCmd;
    }
    if (slCopyBtn) {
      slCopyBtn.disabled = !slashCmd;
    }

    const liteEnabled = Boolean(state.liteMode);
    if (liteToggleInput) {
      liteToggleInput.checked = liteEnabled;
      liteToggleInput.disabled = busyLite;
      liteToggleInput.setAttribute("aria-checked", String(liteEnabled));
    }
    if (liteCardEl) {
      liteCardEl.classList.toggle("is-lite-active", liteEnabled);
    }
    if (liteBadgeEl) {
      liteBadgeEl.className = `other-status-pill ${liteEnabled ? "is-on" : "is-muted"}`;
      liteBadgeEl.textContent = liteEnabled
        ? tr("other.liteBadgeOn", "省显存")
        : tr("other.liteBadgeOff", "标准");
    }
    if (liteEffectValEl) {
      liteEffectValEl.textContent = liteEnabled
        ? tr("other.liteEffectOn", "已关闭模糊与装饰动效")
        : tr("other.liteEffectOff", "完整毛玻璃与动效");
    }
    if (liteCostValEl) {
      liteCostValEl.className = `other-meta-value${liteEnabled ? " is-safe" : ""}`;
      liteCostValEl.textContent = liteEnabled
        ? tr("other.liteCostOn", "低显存合成已激活")
        : tr("other.liteCostOff", "未启用（默认画质）");
    }
  }

  async function handleToggleQuota() {
    if (!toggleInput || busyToggle || destroyed) return;
    const nextEnabled = Boolean(toggleInput.checked);
    busyToggle = true;
    render();

    try {
      const res = await requestJson("/api/preferences/quota-query", {
        method: "POST",
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (destroyed) return;
      state.quotaQueryEnabled = res?.quotaQueryEnabled !== false;
      if (res?.quotaCompliance && typeof res.quotaCompliance === "object") {
        state.compliance = res.quotaCompliance;
      }
      onQuotaEnabledChange?.(state.quotaQueryEnabled, state.compliance);
      onToast?.(
        state.quotaQueryEnabled
          ? tr("other.toastQuotaEnabled", "已开启官方额度查看与同步")
          : tr("other.toastQuotaDisabled", "已彻底停止全部额度查询，界面空位已自动填充"),
        "success"
      );
    } catch (err) {
      if (destroyed) return;
      // Roll back checkbox to persisted state
      render();
      onToast?.(err?.message || tr("other.toastQuotaFailed", "切换额度查询开关失败"), "error");
    } finally {
      busyToggle = false;
      render();
    }
  }

  async function handleStatusLineToggle() {
    if (busySl || destroyed) return;
    const isConfigured = Boolean(state.compliance?.statusLine?.configured);
    busySl = true;
    render();

    try {
      const endpoint = isConfigured ? "/api/quota/statusline/uninstall" : "/api/quota/statusline/install";
      const res = await requestJson(endpoint, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (destroyed) return;
      if (res?.quotaCompliance && typeof res.quotaCompliance === "object") {
        state.compliance = res.quotaCompliance;
      } else if (res?.statusLine) {
        state.compliance = { ...state.compliance, statusLine: res.statusLine };
      }
      onToast?.(
        isConfigured
          ? tr("other.toastSlRemoved", "已移除 CLI statusLine 接入配置")
          : tr("other.toastSlInstalled", "已写入官方 CLI statusLine 回调桥接，运行 agy 时自动同步"),
        "success"
      );
    } catch (err) {
      if (destroyed) return;
      onToast?.(err?.message || tr("other.toastSlFailed", "配置官方 statusLine 失败"), "error");
    } finally {
      busySl = false;
      render();
    }
  }

  async function handleCopySlashCommand() {
    const cmd = state.compliance?.statusLine?.slashCommand || "";
    if (!cmd) return;
    const ok = await copyTextSafe(cmd);
    onToast?.(
      ok
        ? tr("other.toastCmdCopied", "已复制 /statusline 配置命令，可在 agy 终端直接运行")
        : tr("other.toastCmdCopyFailed", "复制失败，请手动选中命令复制"),
      ok ? "success" : "error"
    );
  }

  async function handleToggleLiteMode() {
    if (!liteToggleInput || busyLite || destroyed) return;
    const nextEnabled = Boolean(liteToggleInput.checked);
    busyLite = true;
    render();

    try {
      const res = await requestJson("/api/preferences/lite-mode", {
        method: "POST",
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (destroyed) return;
      state.liteMode = Boolean(res?.liteMode ?? nextEnabled);
      onLiteModeChange?.(state.liteMode);
      onToast?.(
        state.liteMode
          ? tr("other.toastLiteEnabled", "已开启轻量省显存模式，侧边栏与宿主已同步降耗")
          : tr("other.toastLiteDisabled", "已关闭轻量省显存模式，恢复完整视觉效果"),
        "success"
      );
    } catch (err) {
      if (destroyed) return;
      // Roll back checkbox to persisted state
      render();
      onToast?.(err?.message || tr("other.toastLiteFailed", "切换轻量省显存模式失败"), "error");
    } finally {
      busyLite = false;
      render();
    }
  }

  if (toggleInput) {
    const onChange = () => void handleToggleQuota();
    toggleInput.addEventListener("change", onChange);
    cleanups.push(() => toggleInput.removeEventListener("change", onChange));
  }
  if (liteToggleInput) {
    const onLiteChange = () => void handleToggleLiteMode();
    liteToggleInput.addEventListener("change", onLiteChange);
    cleanups.push(() => liteToggleInput.removeEventListener("change", onLiteChange));
  }
  if (slInstallBtn) {
    const onInstallClick = () => void handleStatusLineToggle();
    slInstallBtn.addEventListener("click", onInstallClick);
    cleanups.push(() => slInstallBtn.removeEventListener("click", onInstallClick));
  }
  if (slCopyBtn) {
    const onCopyClick = () => void handleCopySlashCommand();
    slCopyBtn.addEventListener("click", onCopyClick);
    cleanups.push(() => slCopyBtn.removeEventListener("click", onCopyClick));
  }

  render();

  return {
    updateFromPreferences(prefs) {
      if (!prefs || typeof prefs !== "object") return;
      if (typeof prefs.quotaQueryEnabled === "boolean") {
        state.quotaQueryEnabled = prefs.quotaQueryEnabled;
      }
      if (prefs.quotaCompliance && typeof prefs.quotaCompliance === "object") {
        state.compliance = prefs.quotaCompliance;
      }
      state.liteMode = Boolean(prefs.liteMode);
      render();
    },
    setQuotaEnabled(enabled, compliance = null) {
      state.quotaQueryEnabled = enabled !== false;
      if (compliance && typeof compliance === "object") {
        state.compliance = compliance;
      }
      render();
    },
    setLiteMode(enabled) {
      state.liteMode = Boolean(enabled);
      render();
    },
    setTranslator(nextT) {
      translator = nextT;
      render();
    },
    destroy() {
      destroyed = true;
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
