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

export function createOtherHub({ apiFetch, t, onQuotaEnabledChange, onToast } = {}) {
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

  let translator = t;
  let busyToggle = false;
  let busySl = false;
  let destroyed = false;
  const cleanups = [];

  const state = {
    quotaQueryEnabled: true,
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
        ? tr("other.quotaBadgeOn", "已开启 · 官方通道")
        : tr("other.quotaBadgeOff", "已关闭 · 零查询");
    }

    if (channelValEl) {
      if (!enabled) {
        channelValEl.textContent = tr("other.channelDisabled", "已全面停用");
      } else if (comp.activeSource === "official_statusline" || sl.fresh) {
        channelValEl.textContent = tr("other.channelStatusLine", "官方 CLI statusLine 回调");
      } else if (comp.hasLocalLs || comp.activeSource === "official_local_ls") {
        channelValEl.textContent = tr("other.channelLocalLs", "官方宿主本机回环服务");
      } else {
        channelValEl.textContent = tr("other.channelWaiting", "待宿主/CLI 通道就绪");
      }
    }

    if (guardValEl) {
      guardValEl.textContent = tr("other.guardBlocked", "已禁绝 cloudcode-pa 直连");
    }

    if (scopeValEl) {
      scopeValEl.textContent = enabled
        ? tr("other.scopeOn", "通用页 · 输入框 HUD · 账号页 · 桌宠")
        : tr("other.scopeOff", "已停查并自动填满所有空位");
    }

    if (slBadgeEl) {
      if (sl.fresh) {
        slBadgeEl.className = "other-status-pill is-on";
        slBadgeEl.textContent = tr("other.slBadgeFresh", "实时同步中");
      } else if (sl.configured) {
        slBadgeEl.className = "other-status-pill is-info";
        slBadgeEl.textContent = tr("other.slBadgeConfigured", "已接入 · 待 CLI 触发");
      } else if (sl.configuredByOther) {
        slBadgeEl.className = "other-status-pill is-warn";
        slBadgeEl.textContent = tr("other.slBadgeCustom", "已存在自定义配置");
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
          ? tr("other.slUninstallBtn", "移除 CLI 接入")
          : tr("other.slInstallBtn", "一键配置 CLI statusLine");
    }

    const slashCmd = sl.slashCommand || "";
    if (slCmdInput) {
      slCmdInput.value = slashCmd;
      slCmdInput.hidden = !slashCmd;
    }
    if (slCopyBtn) {
      slCopyBtn.disabled = !slashCmd;
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

  if (toggleInput) {
    const onChange = () => void handleToggleQuota();
    toggleInput.addEventListener("change", onChange);
    cleanups.push(() => toggleInput.removeEventListener("change", onChange));
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
      render();
    },
    setQuotaEnabled(enabled, compliance = null) {
      state.quotaQueryEnabled = enabled !== false;
      if (compliance && typeof compliance === "object") {
        state.compliance = compliance;
      }
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
