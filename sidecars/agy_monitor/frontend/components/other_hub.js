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
  const proxyCardEl = document.getElementById("otherProxyCard");
  const proxyToggleInput = document.getElementById("otherProxyToggle");
  const proxyBadgeEl = document.getElementById("otherProxyBadge");
  const proxyBodyEl = document.getElementById("otherProxyBody");
  const proxyUrlInput = document.getElementById("otherProxyUrlInput");
  const proxySaveBtn = document.getElementById("otherProxySaveBtn");
  const proxyTestBtn = document.getElementById("otherProxyTestBtn");
  const proxyHttp1Input = document.getElementById("otherProxyHttp1Toggle");
  const proxyHintEl = document.getElementById("otherProxyHint");

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
  let busyProxy = false;
  let busyProxyTest = false;
  let proxyUrlDirty = false;
  let busyToggle = false;
  let busyLite = false;
  let busySl = false;
  let destroyed = false;
  const cleanups = [];

  const state = {
    proxy: {
      enabled: true,
      mode: "auto",
      url: "",
      bypass: "localhost,127.0.0.1,::1",
      forceHttp1: false,
    },
    proxyStatus: null,
    proxyTest: null,
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

  function renderProxy() {
    const proxy = state.proxy || {};
    const ps = state.proxyStatus || {};
    const enabled = proxy.enabled !== false;

    if (proxyToggleInput) {
      proxyToggleInput.checked = enabled;
      proxyToggleInput.disabled = busyProxy;
      proxyToggleInput.setAttribute("aria-checked", String(enabled));
    }
    if (proxyCardEl) {
      proxyCardEl.classList.toggle("is-proxy-active", enabled);
      proxyCardEl.classList.toggle("is-disabled", !enabled);
    }
    if (proxyBodyEl) {
      proxyBodyEl.hidden = !enabled;
    }
    if (proxyUrlInput && !proxyUrlDirty && document.activeElement !== proxyUrlInput) {
      proxyUrlInput.value = typeof proxy.url === "string" ? proxy.url : "";
    }
    if (proxyUrlInput) {
      proxyUrlInput.disabled = busyProxy;
    }
    if (proxyHttp1Input) {
      proxyHttp1Input.checked = Boolean(proxy.forceHttp1);
      proxyHttp1Input.disabled = busyProxy;
    }
    if (proxySaveBtn) {
      proxySaveBtn.disabled = busyProxy;
      proxySaveBtn.textContent = busyProxy
        ? tr("other.slWorking", "处理中…")
        : tr("other.proxySaveBtn", "保存");
    }
    if (proxyTestBtn) {
      proxyTestBtn.disabled = busyProxyTest || busyProxy;
      proxyTestBtn.textContent = busyProxyTest
        ? tr("other.proxyTesting", "测速中…")
        : tr("other.proxyTestBtn", "测速");
    }

    if (proxyBadgeEl) {
      const runtimeState = ps.state || (enabled ? "on" : "disabled");
      if (!enabled || runtimeState === "disabled") {
        proxyBadgeEl.className = "other-status-pill is-off";
        proxyBadgeEl.textContent = tr("other.proxyBadgeOff", "已关闭");
        proxyBadgeEl.title = "";
      } else if (runtimeState === "active") {
        proxyBadgeEl.className = "other-status-pill is-on";
        proxyBadgeEl.textContent = tr("other.proxyBadgeLive", "已生效");
        proxyBadgeEl.title = ps.effectiveUrl || "";
      } else if (runtimeState === "partial_restart") {
        proxyBadgeEl.className = "other-status-pill is-info";
        proxyBadgeEl.textContent = tr("other.proxyBadgeRestart", "重启全生效");
        proxyBadgeEl.title = "窗口流量已热切换，重启 Antigravity 后语言服务同步生效";
      } else if (runtimeState === "needs_restart") {
        proxyBadgeEl.className = "other-status-pill is-warn";
        proxyBadgeEl.textContent = tr("other.proxyBadgeNeedsRestart", "重启生效");
        proxyBadgeEl.title = "配置已写入，重启 Antigravity 后生效";
      } else if (runtimeState === "auto_direct") {
        proxyBadgeEl.className = "other-status-pill is-muted";
        proxyBadgeEl.textContent = tr("other.proxyBadgeDirect", "自动直连");
        proxyBadgeEl.title = "未检测到系统代理，当前直连";
      } else {
        proxyBadgeEl.className = "other-status-pill is-on";
        proxyBadgeEl.textContent = tr("other.proxyBadgeOn", "已开启");
        proxyBadgeEl.title = "";
      }
    }

    if (proxyHintEl) {
      proxyHintEl.classList.remove("is-ok", "is-err", "is-warn");
      if (state.proxyTest) {
        const res = state.proxyTest;
        if (res.ok) {
          proxyHintEl.classList.add("is-ok");
          const ms = Number(res.latencyMs) || 0;
          proxyHintEl.textContent = `✓ 隧道正常 · ${ms}ms`;
          proxyHintEl.title = `${res.url || ""} → ${res.target || ""}`;
        } else {
          proxyHintEl.classList.add("is-err");
          proxyHintEl.textContent = `✕ ${res.error || "连接失败"}`;
          proxyHintEl.title = res.error || "";
        }
      } else if (!enabled) {
        proxyHintEl.textContent = tr("other.proxyHintOff", "已关闭免 TUN 代理");
        proxyHintEl.title = "";
      } else if (ps.source === "custom" && ps.effectiveUrl) {
        const suffix = ps.needsRestart ? " · 重启生效" : "";
        if (ps.needsRestart) proxyHintEl.classList.add("is-warn");
        proxyHintEl.textContent = `${ps.effectiveUrl}${suffix}`;
        proxyHintEl.title = proxyHintEl.textContent;
      } else if (ps.source === "system" && ps.effectiveUrl) {
        const suffix = ps.needsRestart ? " · 重启生效" : "";
        if (ps.needsRestart) proxyHintEl.classList.add("is-warn");
        proxyHintEl.textContent = `系统代理 ${ps.effectiveUrl}${suffix}`;
        proxyHintEl.title = proxyHintEl.textContent;
      } else {
        proxyHintEl.textContent = tr("other.proxyHintDirect", "未开系统代理，当前直连");
        proxyHintEl.title = "留空将自动跟随系统代理；也可手动填写 http:// 或 socks5:// 地址实现纯独立代理";
      }
    }
  }

  function render() {
    renderProxy();
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

  async function saveProxyPatch(patch, { successToast = "" } = {}) {
    if (busyProxy || destroyed) return false;
    busyProxy = true;
    state.proxyTest = null;
    render();
    try {
      const res = await requestJson("/api/preferences/proxy", {
        method: "POST",
        body: JSON.stringify(patch),
      });
      if (destroyed) return false;
      if (res?.proxy && typeof res.proxy === "object") {
        state.proxy = { ...state.proxy, ...res.proxy };
      }
      if (res?.proxyStatus && typeof res.proxyStatus === "object") {
        state.proxyStatus = res.proxyStatus;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "url")) {
        proxyUrlDirty = false;
      }
      const needRestartSuffix = state.proxyStatus?.needsRestart ? "（重启 Antigravity 后完全生效）" : "";
      if (successToast) {
        onToast?.(`${successToast}${needRestartSuffix}`, "success");
      }
      return true;
    } catch (err) {
      if (destroyed) return false;
      render();
      onToast?.(err?.message || tr("other.toastProxyFailed", "保存免 TUN 代理设置失败"), "error");
      return false;
    } finally {
      busyProxy = false;
      render();
    }
  }

  async function handleToggleProxy() {
    if (!proxyToggleInput || busyProxy || destroyed) return;
    const nextEnabled = Boolean(proxyToggleInput.checked);
    await saveProxyPatch(
      { enabled: nextEnabled },
      {
        successToast: nextEnabled
          ? tr("other.toastProxyEnabled", "已开启免 TUN 代理")
          : tr("other.toastProxyDisabled", "已关闭免 TUN 代理"),
      }
    );
  }

  async function handleSaveProxyUrl() {
    if (busyProxy || destroyed) return;
    const rawUrl = proxyUrlInput ? proxyUrlInput.value.trim() : "";
    const forceHttp1 = proxyHttp1Input ? Boolean(proxyHttp1Input.checked) : Boolean(state.proxy?.forceHttp1);
    await saveProxyPatch(
      { enabled: true, url: rawUrl, forceHttp1 },
      {
        successToast: rawUrl
          ? tr("other.toastProxySavedCustom", "已保存独立代理地址")
          : tr("other.toastProxySavedAuto", "已切换为自动识别系统代理"),
      }
    );
  }

  async function handleToggleProxyHttp1() {
    if (!proxyHttp1Input || busyProxy || destroyed) return;
    const nextHttp1 = Boolean(proxyHttp1Input.checked);
    await saveProxyPatch(
      { forceHttp1: nextHttp1 },
      {
        successToast: nextHttp1
          ? tr("other.toastProxyHttp1On", "已开启强制 HTTP/1.1（修复 Go HTTP/2 EOF）")
          : tr("other.toastProxyHttp1Off", "已恢复默认 HTTP/2"),
      }
    );
  }

  async function handleTestProxy() {
    if (busyProxyTest || busyProxy || destroyed) return;
    busyProxyTest = true;
    state.proxyTest = null;
    render();
    try {
      const rawUrl = proxyUrlInput ? proxyUrlInput.value.trim() : "";
      const res = await requestJson("/api/proxy/test", {
        method: "POST",
        body: JSON.stringify({ url: rawUrl }),
      });
      if (destroyed) return;
      state.proxyTest = res;
      if (res?.ok) {
        onToast?.(`代理隧道畅通（${res.latencyMs || 0}ms）`, "success");
      } else {
        onToast?.(res?.error || tr("other.toastProxyTestFailed", "代理连通测试失败"), "error");
      }
    } catch (err) {
      if (destroyed) return;
      state.proxyTest = { ok: false, error: err?.message || "代理连通测试失败" };
      onToast?.(err?.message || tr("other.toastProxyTestFailed", "代理连通测试失败"), "error");
    } finally {
      busyProxyTest = false;
      render();
    }
  }

  if (proxyToggleInput) {
    const onProxyToggle = () => void handleToggleProxy();
    proxyToggleInput.addEventListener("change", onProxyToggle);
    cleanups.push(() => proxyToggleInput.removeEventListener("change", onProxyToggle));
  }
  if (proxyUrlInput) {
    const onUrlInput = () => {
      proxyUrlDirty = true;
      state.proxyTest = null;
    };
    const onUrlKeyDown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleSaveProxyUrl();
      }
    };
    proxyUrlInput.addEventListener("input", onUrlInput);
    proxyUrlInput.addEventListener("keydown", onUrlKeyDown);
    cleanups.push(() => {
      proxyUrlInput.removeEventListener("input", onUrlInput);
      proxyUrlInput.removeEventListener("keydown", onUrlKeyDown);
    });
  }
  if (proxySaveBtn) {
    const onSaveClick = () => void handleSaveProxyUrl();
    proxySaveBtn.addEventListener("click", onSaveClick);
    cleanups.push(() => proxySaveBtn.removeEventListener("click", onSaveClick));
  }
  if (proxyTestBtn) {
    const onTestClick = () => void handleTestProxy();
    proxyTestBtn.addEventListener("click", onTestClick);
    cleanups.push(() => proxyTestBtn.removeEventListener("click", onTestClick));
  }
  if (proxyHttp1Input) {
    const onHttp1Change = () => void handleToggleProxyHttp1();
    proxyHttp1Input.addEventListener("change", onHttp1Change);
    cleanups.push(() => proxyHttp1Input.removeEventListener("change", onHttp1Change));
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
      if (prefs.proxy && typeof prefs.proxy === "object") {
        state.proxy = { ...state.proxy, ...prefs.proxy };
      }
      if (prefs.proxyStatus && typeof prefs.proxyStatus === "object") {
        state.proxyStatus = prefs.proxyStatus;
      }
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
