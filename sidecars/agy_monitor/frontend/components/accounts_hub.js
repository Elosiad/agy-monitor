/**
 * Multi-Account Management Hub (`accounts` top-level tab):
 * - Top toolbar: OAuth 授权 / Token/Json 导入 / 设置 + DPAPI badge & rollback
 * - Account list items: email, 2 quota groups (Gemini / GPT&Claude),
 *   enable/disable toggle, switch account (with auto-resume), delete,
 *   export JSON, edit remark, and refresh quota.
 */

const DEFAULT_GROUPS = [
  { key: "gemini", label: "Gemini" },
  { key: "gpt_claude", label: "GPT&Claude" },
];

const SORT_FIELDS = [
  { key: "email", shortLabel: "a-z", label: "a-z（邮箱首字母）" },
  { key: "gemini", shortLabel: "Gemini", label: "Gemini 额度" },
  { key: "gpt_claude", shortLabel: "GPTClaude", label: "GPTClaude 额度" },
  { key: "lastUsed", shortLabel: "上次使用", label: "上一次使用时间" },
];

const DEFAULT_RESUME_PROMPT =
  "已切换账号并重启完成，请检查刚才中断前的上下文与本地文件改动状态，直接继续完成剩余任务。";

function getGroupSortScore(acc, groupKey, nowMs) {
  const groups = Array.isArray(acc?.quota?.groups) ? acc.quota.groups : [];
  const g = groups.find((item) => item && item.key === groupKey) || null;
  if (!g) return { primary: -1, secondary: -1 };
  const readPct = (b) => {
    if (!b || b.disabled) return -1;
    if (b.resetPassed || (!b.isFull && b.resetTimeMs && b.resetTimeMs <= nowMs)) return 100;
    if (b.remainingPct !== null && b.remainingPct !== undefined && Number.isFinite(Number(b.remainingPct))) {
      return Math.max(0, Math.min(100, Number(b.remainingPct)));
    }
    return -1;
  };
  const p5h = readPct(g.fiveHour);
  const pw = readPct(g.weekly);
  return {
    primary: p5h >= 0 ? p5h : pw,
    secondary: pw,
  };
}

function sortAccountsList(accounts, sortBy = "lastUsed", sortOrder = "desc", nowMs = Date.now()) {
  const list = Array.isArray(accounts) ? accounts.slice() : [];
  const dir = sortOrder === "asc" ? 1 : -1;

  list.sort((a, b) => {
    if (sortBy === "email") {
      const cmp = String(a?.email || "").localeCompare(String(b?.email || ""), "en", {
        sensitivity: "base",
      });
      return cmp * dir;
    }

    if (sortBy === "gemini" || sortBy === "gpt_claude") {
      const sa = getGroupSortScore(a, sortBy, nowMs);
      const sb = getGroupSortScore(b, sortBy, nowMs);
      // Always keep accounts without quota snapshot at the end so unknown rows don't obscure real quotas
      const aHas = sa.primary >= 0;
      const bHas = sb.primary >= 0;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (sa.primary !== sb.primary) return (sa.primary - sb.primary) * dir;
      if (sa.secondary !== sb.secondary) return (sa.secondary - sb.secondary) * dir;
      return String(a?.email || "").localeCompare(String(b?.email || ""), "en", { sensitivity: "base" });
    }

    // Default: lastUsed
    const ta = Number(a?.lastUsedAtMs || 0);
    const tb = Number(b?.lastUsedAtMs || 0);
    if (ta !== tb) return (ta - tb) * dir;
    const ua = Number(a?.updatedAtMs || 0);
    const ub = Number(b?.updatedAtMs || 0);
    if (ua !== ub) return (ua - ub) * dir;
    return String(a?.email || "").localeCompare(String(b?.email || ""), "en", { sensitivity: "base" });
  });

  return list;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatClock(tsMs) {
  const ts = Number(tsMs);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatCountdownShort(resetTimeMs, nowMs) {
  const ts = Number(resetTimeMs);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const diffMs = ts - nowMs;
  if (diffMs <= 0) return "已过重置";
  const mins = Math.ceil(diffMs / 60_000);
  const days = Math.floor(mins / (24 * 60));
  const hours = Math.floor((mins % (24 * 60)) / 60);
  const remMins = mins % 60;
  if (days >= 1) return hours > 0 ? `${days}天${hours}时` : `${days}天`;
  if (hours >= 1) return remMins > 0 ? `${hours}时${remMins}分` : `${hours}小时`;
  return `${mins}分`;
}

function resolveBucketTone(bucket) {
  if (!bucket || bucket.disabled || bucket.remainingPct === null || bucket.remainingPct === undefined) {
    return "is-na";
  }
  if (bucket.resetPassed) return "is-healthy";
  const pct = Number(bucket.remainingPct);
  if (!Number.isFinite(pct)) return "is-na";
  if (pct < 20) return "is-danger";
  if (pct < 50) return "is-warn";
  return "is-healthy";
}

function createSvgIcon(pathD, extra = "") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  if (extra) svg.setAttribute("class", extra);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", pathD);
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

export function createAccountsHub({
  apiFetch,
  onToast,
} = {}) {
  const panelEl = document.getElementById("panelAccounts");
  const listEl = document.getElementById("accList");
  const countBadgeEl = document.getElementById("accCountBadge");
  const vaultBadgeEl = document.getElementById("accVaultBadge");
  const vaultTextEl = document.getElementById("accVaultText");
  const rollbackBtn = document.getElementById("accRollbackBtn");
  const summaryCardEl = document.getElementById("accSummaryCard");
  const summaryMetaEl = document.getElementById("accSummaryMeta");
  const summaryHintEl = document.getElementById("accSummaryHint");
  const summaryGridEl = document.getElementById("accSummaryGrid");
  const statusBannerEl = document.getElementById("accStatusBanner");
  const statusTextEl = document.getElementById("accStatusText");
  const statusCancelBtn = document.getElementById("accStatusCancelBtn");

  // Top action buttons
  const oauthBtn = document.getElementById("accOauthBtn");
  const importBtn = document.getElementById("accImportBtn");
  const settingsBtn = document.getElementById("accSettingsBtn");
  const sortWrap = document.getElementById("accSortWrap");
  const sortBtn = document.getElementById("accSortBtn");
  const sortBtnLabel = document.getElementById("accSortBtnLabel");
  const sortMenu = document.getElementById("accSortMenu");

  // Modals
  const modals = {
    oauth: document.getElementById("accOauthModal"),
    import: document.getElementById("accImportModal"),
    settings: document.getElementById("accSettingsModal"),
    remark: document.getElementById("accRemarkModal"),
    export: document.getElementById("accExportModal"),
    delete: document.getElementById("accDeleteModal"),
  };

  // Settings modal controls
  const settingRefreshMinInput = document.getElementById("accSettingRefreshMinInput");
  const settingAutoTargetSelect = document.getElementById("accSettingAutoTargetSelect");
  const settingAutoToggleBtn = document.getElementById("accSettingAutoToggleBtn");
  const settingAutoToggleText = document.getElementById("accSettingAutoToggleText");
  const settingsSaveBtn = document.getElementById("accSettingsSaveBtn");

  // OAuth modal controls
  const oauthCurrentHintEl = document.getElementById("accOauthCurrentHint");
  const captureRemarkInput = document.getElementById("accCaptureRemarkInput");
  const captureCurrentBtn = document.getElementById("accCaptureCurrentBtn");
  const startOfficialOauthBtn = document.getElementById("accStartOfficialOauthBtn");
  const startDirectOauthBtn = document.getElementById("accStartDirectOauthBtn");
  const directOauthInitialRow = document.getElementById("accDirectOauthInitialRow");
  const directOauthProgress = document.getElementById("accDirectOauthProgress");
  const directOauthStatusText = document.getElementById("accDirectOauthStatusText");
  const directOauthRetryLink = document.getElementById("accDirectOauthRetryLink");
  const directOauthCancelBtn = document.getElementById("accDirectOauthCancelBtn");

  // Import modal controls
  const importTextarea = document.getElementById("accImportTextarea");
  const importEmailInput = document.getElementById("accImportEmailInput");
  const importRemarkInput = document.getElementById("accImportRemarkInput");
  const importFileBtn = document.getElementById("accImportFileBtn");
  const importFileInput = document.getElementById("accImportFileInput");
  const importErrorEl = document.getElementById("accImportError");
  const importSubmitBtn = document.getElementById("accImportSubmitBtn");

  // Remark modal controls
  const remarkEmailLabelEl = document.getElementById("accRemarkEmailLabel");
  const remarkInput = document.getElementById("accRemarkInput");
  const remarkSaveBtn = document.getElementById("accRemarkSaveBtn");

  // Export modal controls
  const exportTextarea = document.getElementById("accExportTextarea");
  const exportCopyBtn = document.getElementById("accExportCopyBtn");
  const exportDownloadBtn = document.getElementById("accExportDownloadBtn");

  // Delete modal controls
  const deleteEmailTextEl = document.getElementById("accDeleteEmailText");
  const deleteConfirmBtn = document.getElementById("accDeleteConfirmBtn");

  let destroyed = false;
  let tabActive = false;
  let pollTimer = null;
  let directOauthPollTimer = null;
  let loading = false;
  let switchingAccountId = "";
  let lastNotifiedResumeMs = 0;
  let lastNotifiedOauthMs = 0;
  let lastNotifiedAutoSwitchMs = 0;
  let draftAutoSwitchEnabled = false;
  let activeRemarkAccount = null;
  let activeDeleteAccount = null;
  let activeExportPayload = { filename: "agy-account.json", jsonText: "" };
  const refreshingIds = new Set();
  const togglingIds = new Set();
  const cleanups = [];

  const state = {
    supported: true,
    dpapiProtected: true,
    currentEmail: "",
    hasLiveCredential: false,
    accounts: [],
    settings: {
      quotaRefreshIntervalMin: 5,
      autoSwitchTarget: "gemini",
      autoSwitchEnabled: false,
      sortBy: "lastUsed",
      sortOrder: "desc",
    },
    backupCount: 0,
    lastTransaction: null,
    pendingResume: null,
    pendingOauth: null,
  };

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

  function resetDirectOauthUI() {
    if (directOauthInitialRow) directOauthInitialRow.hidden = false;
    if (directOauthProgress) directOauthProgress.hidden = true;
    if (startDirectOauthBtn) startDirectOauthBtn.disabled = false;
    if (directOauthRetryLink) directOauthRetryLink.href = "#";
    if (directOauthStatusText) {
      directOauthStatusText.textContent = "已在浏览器中打开授权页，等待完成登录与许可…";
    }
    if (directOauthPollTimer) {
      clearInterval(directOauthPollTimer);
      directOauthPollTimer = null;
    }
  }

  function openModal(key) {
    const el = modals[key];
    if (!el) return;
    el.hidden = false;
  }

  function closeModal(key) {
    const el = modals[key];
    if (!el) return;
    el.hidden = true;
    if (key === "oauth") {
      resetDirectOauthUI();
    }
  }

  function closeAllModals() {
    Object.keys(modals).forEach((k) => closeModal(k));
  }

  function buildQuotaGroupCell(groupDef, storedGroup, nowMs) {
    const cell = document.createElement("div");
    cell.className = "acc-quota-cell";
    cell.setAttribute("data-quota-group", groupDef.key);

    const head = document.createElement("div");
    head.className = "acc-quota-head";
    const dot = document.createElement("span");
    dot.className = `quota-group-dot is-${groupDef.key}`;
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "acc-quota-name";
    name.textContent = storedGroup?.label || groupDef.label;
    head.appendChild(dot);
    head.appendChild(name);
    cell.appendChild(head);

    const b5 = storedGroup?.fiveHour || null;
    const bw = storedGroup?.weekly || null;

    const buildLine = (labelText, bucket) => {
      const tone = resolveBucketTone(bucket);
      const row = document.createElement("div");
      row.className = `acc-quota-line ${tone}`;

      const lbl = document.createElement("span");
      lbl.className = "acc-quota-win";
      lbl.textContent = labelText;

      const track = document.createElement("span");
      track.className = "acc-quota-bar";
      const fill = document.createElement("span");
      fill.className = "acc-quota-bar-fill";
      const hasVal = Boolean(
        bucket && !bucket.disabled && bucket.remainingPct !== null && bucket.remainingPct !== undefined,
      );
      const displayPct = hasVal ? (bucket.resetPassed ? 100 : Math.max(0, Math.min(100, Number(bucket.remainingPct)))) : 0;
      fill.style.width = hasVal ? `${displayPct}%` : "0%";
      track.appendChild(fill);

      const pctEl = document.createElement("span");
      pctEl.className = "acc-quota-pct";
      if (!bucket || bucket.disabled) {
        pctEl.textContent = "—";
      } else if (bucket.resetPassed) {
        pctEl.textContent = "待同步";
      } else if (hasVal) {
        pctEl.textContent = `${Math.round(Number(bucket.remainingPct))}%`;
      } else {
        pctEl.textContent = "—";
      }

      row.appendChild(lbl);
      row.appendChild(track);
      row.appendChild(pctEl);
      return row;
    };

    cell.appendChild(buildLine("5h", b5));
    cell.appendChild(buildLine("周", bw));

    const tips = [storedGroup?.displayName || storedGroup?.label || groupDef.label];
    const pushTip = (tag, b) => {
      if (!b || b.disabled) {
        tips.push(`${tag}：暂无数据`);
        return;
      }
      if (b.resetPassed) {
        tips.push(`${tag}：已过重置时间（${formatClock(b.resetTimeMs)}），切入后自动同步`);
        return;
      }
      const pctStr = b.remainingPctExact !== null && b.remainingPctExact !== undefined
        ? `${b.remainingPctExact}%`
        : b.remainingPct !== null && b.remainingPct !== undefined
          ? `${b.remainingPct}%`
          : "—";
      if (b.isFull) {
        tips.push(`${tag}：${pctStr}（满额可用）`);
      } else if (b.resetTimeMs) {
        tips.push(`${tag}：${pctStr} · ${formatCountdownShort(b.resetTimeMs, nowMs)}后重置 (${formatClock(b.resetTimeMs)})`);
      } else {
        tips.push(`${tag}：${pctStr}`);
      }
    };
    pushTip("5小时", b5);
    pushTip("周额度", bw);
    cell.title = tips.join("\n");

    return cell;
  }

  function renderStatusBanner() {
    if (!statusBannerEl || !statusTextEl) return;
    if (state.pendingResume) {
      statusBannerEl.hidden = false;
      statusBannerEl.className = "acc-status-banner is-info";
      const convs = Array.isArray(state.pendingResume.conversations) ? state.pendingResume.conversations : [];
      const firstTitle = convs[0]?.title || convs[0]?.id?.slice(0, 8) || "活动会话";
      const label = convs.length > 1 ? `${convs.length} 个运行中会话` : `「${firstTitle}」`;
      statusTextEl.textContent = `等待新账号 ${state.pendingResume.targetEmail || ""} 就绪，随后自动继续 ${label}…`;
      if (statusCancelBtn) {
        statusCancelBtn.textContent = "取消续跑";
        statusCancelBtn.setAttribute("data-banner-action", "cancel-resume");
        statusCancelBtn.hidden = false;
      }
      return;
    }
    if (state.pendingOauth) {
      statusBannerEl.hidden = false;
      statusBannerEl.className = "acc-status-banner is-info";
      const capturedCount = Array.isArray(state.pendingOauth.capturedEmails)
        ? state.pendingOauth.capturedEmails.length
        : 0;
      const suffix = capturedCount > 0 ? `（本次已自动收录 ${capturedCount} 个新号）` : "";
      statusTextEl.textContent = `无感新号监听中（不关 AGY）：直接在左下角退出并用新号 OAuth 登录，完成后 2 秒内自动收录${suffix}`;
      if (statusCancelBtn) {
        statusCancelBtn.textContent = "停止监听";
        statusCancelBtn.setAttribute("data-banner-action", "stop-oauth-watch");
        statusCancelBtn.hidden = false;
      }
      return;
    }
    if (
      state.lastTransaction &&
      (state.lastTransaction.stage === "failed" || state.lastTransaction.stage === "relaunch_failed") &&
      state.lastTransaction.error
    ) {
      statusBannerEl.hidden = false;
      statusBannerEl.className = "acc-status-banner is-warn";
      statusTextEl.textContent = `上次切号异常：${state.lastTransaction.error}`;
      if (statusCancelBtn) statusCancelBtn.hidden = true;
      return;
    }
    statusBannerEl.hidden = true;
  }

  function renderHeaderMeta() {
    if (countBadgeEl) {
      countBadgeEl.textContent = `${state.accounts.length} 个账号`;
    }
    if (vaultBadgeEl && vaultTextEl) {
      vaultBadgeEl.classList.toggle("is-unsupported", !state.supported);
      vaultTextEl.textContent = state.supported ? "DPAPI 加密保护" : "仅支持 Windows";
    }
    if (rollbackBtn) {
      rollbackBtn.hidden = !(state.supported && state.backupCount > 0);
    }
  }

  function renderAccountList() {
    if (!listEl) return;
    const nowMs = Date.now();
    listEl.innerHTML = "";

    if (!Array.isArray(state.accounts) || state.accounts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "acc-empty-card";

      const title = document.createElement("div");
      title.className = "acc-empty-title";
      title.textContent = "暂未保存任何账号";

      const desc = document.createElement("div");
      desc.className = "acc-empty-desc";
      desc.textContent = state.currentEmail
        ? `检测到当前已登录 ${state.currentEmail}，点击上方「OAuth 授权」可一键加密收录，或通过「Token/Json 导入」批量添加。`
        : "点击上方「OAuth 授权」收录当前账号/授权新账号，或点击「Token/Json 导入」粘贴凭证。";

      const quickBtn = document.createElement("button");
      quickBtn.type = "button";
      quickBtn.className = "acc-primary-btn";
      quickBtn.textContent = state.currentEmail ? "一键收录当前账号" : "OAuth 授权添加";
      quickBtn.addEventListener("click", () => {
        if (state.currentEmail) {
          void handleCaptureCurrent();
        } else {
          openOauthModal();
        }
      });

      empty.appendChild(title);
      empty.appendChild(desc);
      empty.appendChild(quickBtn);
      listEl.appendChild(empty);
      return;
    }

    const sortedAccounts = sortAccountsList(
      state.accounts,
      state.settings.sortBy,
      state.settings.sortOrder,
      nowMs,
    );

    sortedAccounts.forEach((acc) => {
      const card = document.createElement("article");
      card.className = "acc-item-card";
      card.setAttribute("role", "listitem");
      card.setAttribute("data-account-id", acc.id);
      if (acc.isCurrent) card.classList.add("is-current");
      if (!acc.enabled) card.classList.add("is-disabled");

      // Row 1: Identity (Email + Status badges + Remark)
      const topRow = document.createElement("div");
      topRow.className = "acc-item-head";

      const idLeft = document.createElement("div");
      idLeft.className = "acc-item-identity";

      const statusDot = document.createElement("span");
      statusDot.className = `acc-item-dot ${acc.isCurrent ? "is-current" : acc.enabled ? "is-enabled" : "is-disabled"}`;
      statusDot.setAttribute("aria-hidden", "true");

      const emailEl = document.createElement("span");
      emailEl.className = "acc-item-email";
      emailEl.textContent = acc.email;
      emailEl.title = acc.email;

      idLeft.appendChild(statusDot);
      idLeft.appendChild(emailEl);

      if (acc.isCurrent) {
        const curBadge = document.createElement("span");
        curBadge.className = "acc-badge is-current";
        curBadge.textContent = "当前使用";
        idLeft.appendChild(curBadge);
      }
      if (!acc.enabled) {
        const disBadge = document.createElement("span");
        disBadge.className = "acc-badge is-disabled";
        disBadge.textContent = "已禁用";
        idLeft.appendChild(disBadge);
      }
      if (acc.remark) {
        const remarkChip = document.createElement("span");
        remarkChip.className = "acc-remark-chip";
        remarkChip.textContent = acc.remark;
        remarkChip.title = `备注：${acc.remark}`;
        idLeft.appendChild(remarkChip);
      }

      const idRight = document.createElement("div");
      idRight.className = "acc-item-meta";
      if (acc.quota?.fetchedAtMs) {
        const syncTime = document.createElement("span");
        syncTime.className = "acc-quota-sync-time";
        syncTime.textContent = `额度 ${formatClock(acc.quota.fetchedAtMs)}`;
        idRight.appendChild(syncTime);
      }

      topRow.appendChild(idLeft);
      topRow.appendChild(idRight);
      card.appendChild(topRow);

      // Row 2: Three quota categories (Gemini / GPT&Claude / Argon)
      const quotaRow = document.createElement("div");
      quotaRow.className = "acc-quota-grid";
      const groupsByKey = new Map();
      if (Array.isArray(acc.quota?.groups)) {
        acc.quota.groups.forEach((g) => {
          if (g && g.key) groupsByKey.set(g.key, g);
        });
      }
      DEFAULT_GROUPS.forEach((def) => {
        quotaRow.appendChild(buildQuotaGroupCell(def, groupsByKey.get(def.key) || null, nowMs));
      });
      card.appendChild(quotaRow);

      // Row 3: Action buttons (Switch, Refresh Quota, Enable/Disable, Remark, Export JSON, Delete)
      const actionsRow = document.createElement("div");
      actionsRow.className = "acc-item-actions";

      // 1. Switch button (immediate direct switch without confirmation modal)
      const isSwitchingThis = switchingAccountId === acc.id;
      const switchBtn = document.createElement("button");
      switchBtn.type = "button";
      switchBtn.className = `acc-act-btn is-switch${acc.isCurrent ? " is-active-now" : ""}${isSwitchingThis ? " is-spinning" : ""}`;
      switchBtn.disabled = acc.isCurrent || !acc.enabled || !state.supported || Boolean(switchingAccountId);
      switchBtn.appendChild(createSvgIcon("M3 6h9.5M9.5 3.2L12.5 6l-3 2.8M13 10H3.5M6.5 7.2L3.5 10l3 2.8"));
      const switchLabel = document.createElement("span");
      switchLabel.textContent = acc.isCurrent ? "使用中" : isSwitchingThis ? "切换中…" : "切换账号";
      switchBtn.appendChild(switchLabel);
      switchBtn.title = acc.isCurrent
        ? "当前正使用该账号"
        : !acc.enabled
          ? "已禁用账号不可切换，请先启用"
          : "点击直接切换至该账号并自动重启（仅续跑真正运行中的活动会话）";
      switchBtn.addEventListener("click", () => void handleSwitchAccountDirect(acc));
      actionsRow.appendChild(switchBtn);

      // 2. Refresh quota button
      const isRefreshing = refreshingIds.has(acc.id);
      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = `acc-act-btn${isRefreshing ? " is-spinning" : ""}`;
      refreshBtn.disabled = isRefreshing;
      refreshBtn.appendChild(createSvgIcon("M13.3 8a5.3 5.3 0 1 1-1.45-3.65M13.3 2.8v2.7h-2.7"));
      const refreshLabel = document.createElement("span");
      refreshLabel.textContent = isRefreshing ? "刷新中" : "刷新额度";
      refreshBtn.appendChild(refreshLabel);
      refreshBtn.title = acc.isCurrent
        ? "立即实时同步该账号官方额度并同步最新凭证"
        : "自动续签凭证并实时同步该账号官方额度";
      refreshBtn.addEventListener("click", () => void handleRefreshQuota(acc));
      actionsRow.appendChild(refreshBtn);

      // 3. Enable / Disable toggle button
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = `acc-act-btn is-toggle ${acc.enabled ? "is-on" : "is-off"}`;
      toggleBtn.disabled = togglingIds.has(acc.id);
      toggleBtn.setAttribute("aria-pressed", String(Boolean(acc.enabled)));
      const toggleDot = document.createElement("span");
      toggleDot.className = "acc-toggle-dot";
      toggleDot.setAttribute("aria-hidden", "true");
      const toggleLabel = document.createElement("span");
      toggleLabel.textContent = acc.enabled ? "已启用" : "已禁用";
      toggleBtn.appendChild(toggleDot);
      toggleBtn.appendChild(toggleLabel);
      toggleBtn.title = acc.enabled ? "点击禁用该账号" : "点击启用该账号";
      toggleBtn.addEventListener("click", () => void handleToggleEnabled(acc));
      actionsRow.appendChild(toggleBtn);

      // 4. Write remark button
      const remarkBtn = document.createElement("button");
      remarkBtn.type = "button";
      remarkBtn.className = "acc-act-btn";
      remarkBtn.appendChild(createSvgIcon("M11.6 2.8l1.6 1.6-7.4 7.4-2.2.6.6-2.2 7.4-7.4Z"));
      const remarkLabel = document.createElement("span");
      remarkLabel.textContent = "写备注";
      remarkBtn.appendChild(remarkLabel);
      remarkBtn.title = acc.remark ? `编辑备注（当前：${acc.remark}）` : "添加账号备注";
      remarkBtn.addEventListener("click", () => openRemarkModal(acc));
      actionsRow.appendChild(remarkBtn);

      // 5. Export JSON button
      const exportBtn = document.createElement("button");
      exportBtn.type = "button";
      exportBtn.className = "acc-act-btn";
      exportBtn.appendChild(createSvgIcon("M8 10.6V3.2M5.2 5.8 8 3l2.8 2.8M2.8 11.4v1.4a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-1.4"));
      const exportLabel = document.createElement("span");
      exportLabel.textContent = "导出 JSON";
      exportBtn.appendChild(exportLabel);
      exportBtn.title = "导出该账号的完整凭证 JSON（用于备份或迁移）";
      exportBtn.addEventListener("click", () => void handleExportJson(acc));
      actionsRow.appendChild(exportBtn);

      // 6. Delete button
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "acc-act-btn is-danger";
      deleteBtn.appendChild(createSvgIcon("M3.2 4.5h9.6M6.2 4.5V3.1a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.4M4.8 4.5l.5 8.2a1 1 0 0 0 1 .9h3.4a1 1 0 0 0 1-.9l.5-8.2"));
      const deleteLabel = document.createElement("span");
      deleteLabel.textContent = "删除";
      deleteBtn.appendChild(deleteLabel);
      deleteBtn.title = "从本地加密库删除该账号";
      deleteBtn.addEventListener("click", () => openDeleteModal(acc));
      actionsRow.appendChild(deleteBtn);

      card.appendChild(actionsRow);
      listEl.appendChild(card);
    });
  }

  function renderSortControls() {
    const curField =
      SORT_FIELDS.find((f) => f.key === state.settings.sortBy) || SORT_FIELDS[SORT_FIELDS.length - 1];
    const isAsc = state.settings.sortOrder === "asc";
    if (sortBtnLabel) {
      sortBtnLabel.textContent = `排序: ${curField.shortLabel} ${isAsc ? "↑" : "↓"}`;
    }
    if (sortMenu) {
      sortMenu.querySelectorAll("[data-sort-order]").forEach((btn) => {
        const active = btn.getAttribute("data-sort-order") === state.settings.sortOrder;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      sortMenu.querySelectorAll("[data-sort-by]").forEach((btn) => {
        const active = btn.getAttribute("data-sort-by") === state.settings.sortBy;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-checked", String(active));
      });
    }
  }

  function renderQuotaSummaryCard() {
    if (!summaryCardEl || !summaryGridEl) return;
    const allAccounts = Array.isArray(state.accounts) ? state.accounts : [];
    if (allAccounts.length === 0) {
      summaryCardEl.hidden = true;
      summaryGridEl.innerHTML = "";
      return;
    }

    const nowMs = Date.now();
    const enabledAccounts = allAccounts.filter((acc) => acc && acc.enabled !== false);
    const pool = enabledAccounts;
    summaryCardEl.hidden = false;

    if (summaryMetaEl) {
      summaryMetaEl.textContent =
        enabledAccounts.length === allAccounts.length
          ? `共 ${allAccounts.length} 个账号`
          : `已启用 ${enabledAccounts.length} / ${allAccounts.length} 个账号`;
    }
    if (summaryHintEl) {
      summaryHintEl.textContent = `总容量 ${pool.length * 100}%`;
    }

    const aggregateBucket = (groupKey, field) => {
      let sumPct = 0;
      let totalCapPct = 0;
      let counted = 0;
      let resetPassedCount = 0;

      for (const acc of pool) {
        const groups = Array.isArray(acc?.quota?.groups) ? acc.quota.groups : [];
        const g = groups.find((item) => item && item.key === groupKey) || null;
        const b = g ? g[field] : null;
        if (!b || b.disabled) continue;

        const isResetPassed = Boolean(
          b.resetPassed || (!b.isFull && b.resetTimeMs && b.resetTimeMs <= nowMs),
        );
        let pct = null;
        if (isResetPassed) {
          pct = 100;
          resetPassedCount += 1;
        } else if (
          b.remainingPct !== null &&
          b.remainingPct !== undefined &&
          Number.isFinite(Number(b.remainingPct))
        ) {
          pct = Math.max(0, Math.min(100, Number(b.remainingPct)));
        }

        if (pct !== null) {
          sumPct += pct;
          totalCapPct += 100;
          counted += 1;
        }
      }

      if (counted === 0 || totalCapPct <= 0) {
        return {
          hasData: false,
          sumPct: 0,
          totalCapPct: 0,
          ratioPct: 0,
          counted: 0,
          resetPassedCount: 0,
        };
      }

      const ratioPct = Math.max(0, Math.min(100, (sumPct / totalCapPct) * 100));
      return {
        hasData: true,
        sumPct: Math.round(sumPct),
        totalCapPct,
        ratioPct,
        counted,
        resetPassedCount,
      };
    };

    const resolveTotalTone = (agg) => {
      if (!agg || !agg.hasData) return "is-na";
      if (agg.ratioPct < 20) return "is-danger";
      if (agg.ratioPct < 50) return "is-warn";
      return "is-healthy";
    };

    summaryGridEl.innerHTML = "";
    DEFAULT_GROUPS.forEach((def) => {
      const agg5h = aggregateBucket(def.key, "fiveHour");
      const aggWeekly = aggregateBucket(def.key, "weekly");

      const cell = document.createElement("div");
      cell.className = "acc-quota-cell acc-summary-cell";
      cell.setAttribute("data-quota-group", def.key);

      const head = document.createElement("div");
      head.className = "acc-quota-head";
      const dot = document.createElement("span");
      dot.className = `quota-group-dot is-${def.key}`;
      dot.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "acc-quota-name";
      name.textContent = def.label;
      head.appendChild(dot);
      head.appendChild(name);
      cell.appendChild(head);

      const buildTotalLine = (winLabel, agg) => {
        const tone = resolveTotalTone(agg);
        const row = document.createElement("div");
        row.className = `acc-quota-line acc-summary-line ${tone}`;

        const lbl = document.createElement("span");
        lbl.className = "acc-quota-win";
        lbl.textContent = winLabel;

        const track = document.createElement("span");
        track.className = "acc-quota-bar";
        const fill = document.createElement("span");
        fill.className = "acc-quota-bar-fill";
        fill.style.width = agg.hasData ? `${agg.ratioPct.toFixed(1)}%` : "0%";
        track.appendChild(fill);

        const pctEl = document.createElement("span");
        pctEl.className = "acc-quota-pct acc-summary-pct";
        pctEl.textContent = agg.hasData ? `${agg.sumPct}/${agg.totalCapPct}%` : "—";

        row.appendChild(lbl);
        row.appendChild(track);
        row.appendChild(pctEl);
        return row;
      };

      cell.appendChild(buildTotalLine("5h", agg5h));
      cell.appendChild(buildTotalLine("周", aggWeekly));

      const tipLines = [`${def.label} · 全部启用账号总余量`];
      const pushAggTip = (label, agg) => {
        if (!agg.hasData) {
          tipLines.push(`${label}：暂无已采集数据`);
          return;
        }
        const avg = Math.round(agg.ratioPct);
        const resetNote = agg.resetPassedCount > 0 ? `（含 ${agg.resetPassedCount} 个已过重置按 100% 计）` : "";
        tipLines.push(`${label}：${agg.sumPct}% / ${agg.totalCapPct}%（均值 ${avg}% · 计入 ${agg.counted} 个账号）${resetNote}`);
      };
      pushAggTip("5小时", agg5h);
      pushAggTip("周额度", aggWeekly);
      cell.title = tipLines.join("\n");

      summaryGridEl.appendChild(cell);
    });
  }

  function renderAll() {
    renderHeaderMeta();
    renderSortControls();
    renderQuotaSummaryCard();
    renderStatusBanner();
    renderAccountList();
  }

  async function persistSettingsPatch(patch, { silent = true } = {}) {
    try {
      const res = await requestJson("/api/accounts/settings", {
        method: "POST",
        body: JSON.stringify(patch),
      });
      if (res?.settings) {
        state.settings = { ...state.settings, ...res.settings };
      }
      return res;
    } catch (err) {
      if (!silent) {
        onToast?.(err?.message || "保存设置失败", "error");
      }
      return null;
    }
  }

  async function refresh({ silent = false } = {}) {
    if (destroyed || loading) return null;
    loading = true;
    try {
      const data = await requestJson("/api/accounts", { method: "GET" });
      if (destroyed) return null;
      state.supported = data.supported !== false;
      state.dpapiProtected = Boolean(data.dpapiProtected);
      state.currentEmail = String(data.currentEmail || "");
      state.hasLiveCredential = Boolean(data.hasLiveCredential);
      state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
      if (data.settings && typeof data.settings === "object") {
        state.settings = {
          quotaRefreshIntervalMin:
            data.settings.quotaRefreshIntervalMin !== undefined
              ? Number(data.settings.quotaRefreshIntervalMin)
              : 5,
          autoSwitchTarget: String(data.settings.autoSwitchTarget || "gemini"),
          autoSwitchEnabled: Boolean(data.settings.autoSwitchEnabled),
          sortBy: String(data.settings.sortBy || "lastUsed"),
          sortOrder: data.settings.sortOrder === "asc" ? "asc" : "desc",
        };
      }
      state.backupCount = Number(data.backupCount || 0);
      state.lastTransaction = data.lastTransaction || null;
      state.pendingResume = data.pendingResume || null;
      state.pendingOauth = data.pendingOauth || null;

      // Notify once if post-restart auto-resume, OAuth capture, or auto-switch just happened
      const rr = data.lastResumeResult;
      if (rr && Number(rr.resumedAtMs) > lastNotifiedResumeMs) {
        lastNotifiedResumeMs = Number(rr.resumedAtMs);
        if (rr.ok) {
          onToast?.(`已切换至 ${rr.targetEmail || "新账号"} 并自动继续活动会话任务`, "success");
        } else if (rr.error) {
          onToast?.(`自动续跑提示：${rr.error}`, "error");
        }
      }
      const oc = data.lastOauthCaptureResult;
      if (oc && Number(oc.capturedAtMs) > lastNotifiedOauthMs) {
        lastNotifiedOauthMs = Number(oc.capturedAtMs);
        if (oc.ok) {
          onToast?.(`已通过官方 OAuth 自动收录新账号：${oc.email}`, "success");
        }
      }
      const asr = data.lastAutoSwitchResult;
      if (asr && Number(asr.atMs) > lastNotifiedAutoSwitchMs) {
        lastNotifiedAutoSwitchMs = Number(asr.atMs);
        if (asr.ok) {
          const reasonPrefix =
            asr.triggerReason === "quota_error"
              ? "检测到额度为空报错"
              : asr.triggerReason === "weekly"
                ? "周额度已耗尽"
                : "5h 额度已耗尽";
          onToast?.(`${reasonPrefix}，已自动切换至最高额度账号：${asr.toEmail}`, "info");
        } else if (asr.message) {
          onToast?.(asr.message, "error");
        }
      }

      renderAll();
      syncPolling();
      return data;
    } catch (err) {
      if (!silent) {
        onToast?.(err?.message || "加载账号列表失败", "error");
      }
      return null;
    } finally {
      loading = false;
    }
  }

  function syncPolling() {
    const needFastPoll = Boolean(state.pendingResume || state.pendingOauth);
    if ((tabActive || needFastPoll) && !pollTimer && !destroyed) {
      pollTimer = setInterval(() => {
        if (destroyed) return;
        if (tabActive || state.pendingResume || state.pendingOauth) {
          void refresh({ silent: true });
        }
      }, needFastPoll ? 2500 : 12_000);
    } else if (!tabActive && !needFastPoll && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function openOauthModal() {
    resetDirectOauthUI();
    if (oauthCurrentHintEl) {
      oauthCurrentHintEl.textContent = state.currentEmail
        ? `当前检测到已登录账号：${state.currentEmail}。点击下方按钮立即加密收录并同步官方实时额度。`
        : "未检测到活跃登录凭据。请先登录 Antigravity，或使用下方「打开浏览器授权新号」。";
    }
    if (captureRemarkInput) captureRemarkInput.value = "";
    openModal("oauth");
  }

  async function handleCaptureCurrent() {
    if (captureCurrentBtn) captureCurrentBtn.disabled = true;
    try {
      const remark = captureRemarkInput ? captureRemarkInput.value.trim() : "";
      const res = await requestJson("/api/accounts/capture", {
        method: "POST",
        body: JSON.stringify({ remark }),
      });
      closeModal("oauth");
      onToast?.(
        res.isNew
          ? `已加密收录账号：${res.account?.email || ""}`
          : `已更新账号凭证与额度：${res.account?.email || ""}`,
        "success",
      );
      await refresh({ silent: true });
    } catch (err) {
      onToast?.(err?.message || "捕获当前账号失败", "error");
    } finally {
      if (captureCurrentBtn) captureCurrentBtn.disabled = false;
    }
  }

  async function handleStartDirectOauth() {
    if (startDirectOauthBtn) startDirectOauthBtn.disabled = true;
    try {
      const remark = captureRemarkInput ? captureRemarkInput.value.trim() : "";
      const res = await requestJson("/api/accounts/oauth-direct/start", {
        method: "POST",
        body: JSON.stringify({ remark }),
      });
      if (directOauthInitialRow) directOauthInitialRow.hidden = true;
      if (directOauthProgress) directOauthProgress.hidden = false;
      if (directOauthRetryLink && res.authUrl) {
        directOauthRetryLink.href = res.authUrl;
      }
      if (directOauthStatusText) {
        directOauthStatusText.textContent = "已在浏览器中打开授权页，等待完成登录与许可…";
      }

      if (directOauthPollTimer) clearInterval(directOauthPollTimer);
      directOauthPollTimer = setInterval(async () => {
        try {
          const pollRes = await requestJson("/api/accounts/oauth-direct/status");
          if (pollRes.status === "exchanging_token") {
            if (directOauthStatusText) {
              directOauthStatusText.textContent = "已收到 Google 回调，正在通过网络换取凭据并加密入库…";
            }
          } else if (pollRes.status === "success") {
            clearInterval(directOauthPollTimer);
            directOauthPollTimer = null;
            closeModal("oauth");
            resetDirectOauthUI();
            const email = pollRes.result?.account?.email || "";
            onToast?.(
              pollRes.result?.isNew
                ? `🎉 账号 ${email} 官方授权成功并已加密入库！`
                : `🎉 账号 ${email} 凭证已更新并同步！`,
              "success",
            );
            await refresh({ silent: true });
          } else if (pollRes.status === "error" || pollRes.status === "timeout") {
            clearInterval(directOauthPollTimer);
            directOauthPollTimer = null;
            resetDirectOauthUI();
            onToast?.(pollRes.error || "授权未完成", "error");
          }
        } catch {}
      }, 1500);
    } catch (err) {
      resetDirectOauthUI();
      onToast?.(err?.message || "启动浏览器 OAuth 授权失败", "error");
    }
  }

  async function handleCancelDirectOauth() {
    try {
      await requestJson("/api/accounts/oauth-direct/cancel", { method: "POST" });
    } catch {}
    resetDirectOauthUI();
    onToast?.("已取消 OAuth 授权", "info");
  }

  async function handleStartOfficialOauth() {
    await handleStartDirectOauth();
  }

  function openImportModal() {
    if (importTextarea) importTextarea.value = "";
    if (importEmailInput) importEmailInput.value = "";
    if (importRemarkInput) importRemarkInput.value = "";
    if (importErrorEl) {
      importErrorEl.textContent = "";
      importErrorEl.hidden = true;
    }
    openModal("import");
    importTextarea?.focus?.();
  }

  async function handleImportSubmit() {
    const rawInput = importTextarea ? importTextarea.value.trim() : "";
    if (!rawInput) {
      if (importErrorEl) {
        importErrorEl.textContent = "请先粘贴账号 JSON 或 refresh_token";
        importErrorEl.hidden = false;
      }
      return;
    }
    if (importErrorEl) importErrorEl.hidden = true;
    if (importSubmitBtn) importSubmitBtn.disabled = true;
    try {
      const res = await requestJson("/api/accounts/import", {
        method: "POST",
        body: JSON.stringify({
          rawInput,
          email: importEmailInput ? importEmailInput.value.trim() : "",
          remark: importRemarkInput ? importRemarkInput.value.trim() : "",
        }),
      });
      closeModal("import");
      onToast?.(
        `导入完成：新增 ${res.addedCount || 0} 个，更新 ${res.updatedCount || 0} 个`,
        "success",
      );
      await refresh({ silent: true });
    } catch (err) {
      if (importErrorEl) {
        importErrorEl.textContent = err?.message || "导入失败";
        importErrorEl.hidden = false;
      }
    } finally {
      if (importSubmitBtn) importSubmitBtn.disabled = false;
    }
  }

  async function handleSwitchAccountDirect(acc) {
    if (!acc || !acc.id || switchingAccountId) return;
    switchingAccountId = acc.id;
    renderAccountList();
    try {
      const res = await requestJson("/api/accounts/switch", {
        method: "POST",
        body: JSON.stringify({
          accountId: acc.id,
          autoResume: true,
          resumePrompt: DEFAULT_RESUME_PROMPT,
        }),
      });
      const count = Number(res.autoResumeCount || 0);
      onToast?.(
        count > 0
          ? `正在安全切换至 ${acc.email} 并自动重启（就绪后自动续跑 ${count} 个运行中会话）…`
          : `正在安全切换至 ${acc.email} 并自动重启 Antigravity…`,
        "info",
      );
    } catch (err) {
      switchingAccountId = "";
      renderAccountList();
      onToast?.(err?.message || "切换账号失败", "error");
    }
  }

  async function handleToggleEnabled(acc) {
    if (togglingIds.has(acc.id)) return;
    togglingIds.add(acc.id);
    renderAccountList();
    try {
      const nextEnabled = !acc.enabled;
      const res = await requestJson("/api/accounts/toggle", {
        method: "POST",
        body: JSON.stringify({ accountId: acc.id, enabled: nextEnabled }),
      });
      const idx = state.accounts.findIndex((a) => a.id === acc.id);
      if (idx >= 0 && res.account) {
        state.accounts[idx] = res.account;
      }
      onToast?.(nextEnabled ? `已启用 ${acc.email}` : `已禁用 ${acc.email}`, "success");
    } catch (err) {
      onToast?.(err?.message || "更新启用状态失败", "error");
    } finally {
      togglingIds.delete(acc.id);
      renderQuotaSummaryCard();
      renderAccountList();
    }
  }

  function openRemarkModal(acc) {
    activeRemarkAccount = acc;
    if (remarkEmailLabelEl) remarkEmailLabelEl.textContent = `账号：${acc.email}`;
    if (remarkInput) remarkInput.value = acc.remark || "";
    openModal("remark");
    remarkInput?.focus?.();
    remarkInput?.select?.();
  }

  async function handleSaveRemark() {
    if (!activeRemarkAccount) return;
    if (remarkSaveBtn) remarkSaveBtn.disabled = true;
    try {
      const remark = remarkInput ? remarkInput.value.trim() : "";
      const res = await requestJson("/api/accounts/remark", {
        method: "POST",
        body: JSON.stringify({ accountId: activeRemarkAccount.id, remark }),
      });
      const idx = state.accounts.findIndex((a) => a.id === activeRemarkAccount.id);
      if (idx >= 0 && res.account) {
        state.accounts[idx] = res.account;
      }
      closeModal("remark");
      renderAccountList();
      onToast?.("账号备注已保存", "success");
    } catch (err) {
      onToast?.(err?.message || "保存备注失败", "error");
    } finally {
      if (remarkSaveBtn) remarkSaveBtn.disabled = false;
    }
  }

  async function handleExportJson(acc) {
    try {
      const res = await requestJson("/api/accounts/export", {
        method: "POST",
        body: JSON.stringify({ accountId: acc.id }),
      });
      activeExportPayload = {
        filename: res.filename || "agy-account.json",
        jsonText: res.jsonText || JSON.stringify(res.data || {}, null, 2),
      };
      if (exportTextarea) exportTextarea.value = activeExportPayload.jsonText;
      openModal("export");
    } catch (err) {
      onToast?.(err?.message || "导出 JSON 失败", "error");
    }
  }

  async function handleRefreshQuota(acc) {
    if (refreshingIds.has(acc.id)) return;
    refreshingIds.add(acc.id);
    renderAccountList();
    try {
      const res = await requestJson("/api/accounts/refresh-quota", {
        method: "POST",
        body: JSON.stringify({ accountId: acc.id }),
      });
      const idx = state.accounts.findIndex((a) => a.id === acc.id);
      if (idx >= 0 && res.account) {
        state.accounts[idx] = res.account;
      }
      onToast?.(res.message || "已刷新账号额度", res.mode === "live" ? "success" : "info");
    } catch (err) {
      onToast?.(err?.message || "刷新额度失败", "error");
    } finally {
      refreshingIds.delete(acc.id);
      renderQuotaSummaryCard();
      renderAccountList();
    }
  }

  function openDeleteModal(acc) {
    activeDeleteAccount = acc;
    if (deleteEmailTextEl) deleteEmailTextEl.textContent = acc.email;
    openModal("delete");
  }

  async function handleConfirmDelete() {
    if (!activeDeleteAccount) return;
    if (deleteConfirmBtn) deleteConfirmBtn.disabled = true;
    try {
      await requestJson("/api/accounts/delete", {
        method: "POST",
        body: JSON.stringify({ accountId: activeDeleteAccount.id }),
      });
      state.accounts = state.accounts.filter((a) => a.id !== activeDeleteAccount.id);
      closeModal("delete");
      renderAll();
      onToast?.(`已删除账号：${activeDeleteAccount.email}`, "success");
    } catch (err) {
      onToast?.(err?.message || "删除账号失败", "error");
    } finally {
      if (deleteConfirmBtn) deleteConfirmBtn.disabled = false;
    }
  }

  async function handleRollbackBackup() {
    if (rollbackBtn) rollbackBtn.disabled = true;
    try {
      await requestJson("/api/accounts/rollback", {
        method: "POST",
        body: JSON.stringify({}),
      });
      onToast?.("正在回滚至最近一次切号前备份并重启 Antigravity…", "info");
    } catch (err) {
      onToast?.(err?.message || "回滚失败", "error");
    } finally {
      if (rollbackBtn) rollbackBtn.disabled = false;
    }
  }

  async function handleStatusBannerAction() {
    const action = statusCancelBtn?.getAttribute("data-banner-action") || "cancel-resume";
    if (action === "stop-oauth-watch") {
      try {
        await requestJson("/api/accounts/oauth-watch/stop", {
          method: "POST",
          body: JSON.stringify({}),
        });
        state.pendingOauth = null;
        renderStatusBanner();
        syncPolling();
        onToast?.("已停止新号自动监听", "info");
      } catch (err) {
        onToast?.(err?.message || "停止监听失败", "error");
      }
      return;
    }
    try {
      await requestJson("/api/accounts/cancel-resume", {
        method: "POST",
        body: JSON.stringify({}),
      });
      state.pendingResume = null;
      renderStatusBanner();
      syncPolling();
      onToast?.("已取消待执行的自动续跑任务", "info");
    } catch (err) {
      onToast?.(err?.message || "取消失败", "error");
    }
  }

  function renderSettingsAutoToggle() {
    if (!settingAutoToggleBtn || !settingAutoToggleText) return;
    settingAutoToggleBtn.classList.toggle("is-on", draftAutoSwitchEnabled);
    settingAutoToggleBtn.classList.toggle("is-off", !draftAutoSwitchEnabled);
    settingAutoToggleBtn.setAttribute("aria-pressed", String(draftAutoSwitchEnabled));
    settingAutoToggleText.textContent = draftAutoSwitchEnabled ? "已启用" : "已弃用";
  }

  function openSettingsModal() {
    if (settingRefreshMinInput) {
      settingRefreshMinInput.value = String(
        Number.isFinite(Number(state.settings.quotaRefreshIntervalMin))
          ? Number(state.settings.quotaRefreshIntervalMin)
          : 5,
      );
    }
    if (settingAutoTargetSelect) {
      settingAutoTargetSelect.value = state.settings.autoSwitchTarget || "gemini";
    }
    draftAutoSwitchEnabled = Boolean(state.settings.autoSwitchEnabled);
    renderSettingsAutoToggle();
    openModal("settings");
  }

  async function handleSaveSettings() {
    if (settingsSaveBtn) settingsSaveBtn.disabled = true;
    try {
      const rawMin = settingRefreshMinInput ? Number(settingRefreshMinInput.value) : 5;
      const quotaRefreshIntervalMin = Number.isFinite(rawMin)
        ? Math.max(0, Math.min(1440, Math.round(rawMin)))
        : 5;
      const autoSwitchTarget = settingAutoTargetSelect ? settingAutoTargetSelect.value : "gemini";
      const res = await persistSettingsPatch(
        {
          quotaRefreshIntervalMin,
          autoSwitchTarget,
          autoSwitchEnabled: draftAutoSwitchEnabled,
        },
        { silent: false },
      );
      if (res?.ok) {
        closeModal("settings");
        const targetLabel = autoSwitchTarget === "gpt_claude" ? "Claude" : "Gemini";
        const refreshDesc =
          quotaRefreshIntervalMin > 0 ? `每 ${quotaRefreshIntervalMin} min 自动刷新` : "已关闭定时刷新";
        const autoDesc = draftAutoSwitchEnabled
          ? `已开启 ${targetLabel} 5h/周耗尽及额度报错自动切号`
          : "自动切号已关闭";
        onToast?.(`设置已保存：${refreshDesc}，${autoDesc}`, "success");
      }
    } finally {
      if (settingsSaveBtn) settingsSaveBtn.disabled = false;
    }
  }

  function applySortChange(nextSortBy, nextSortOrder) {
    state.settings.sortBy = nextSortBy;
    state.settings.sortOrder = nextSortOrder;
    renderSortControls();
    renderAccountList();
    void persistSettingsPatch({ sortBy: nextSortBy, sortOrder: nextSortOrder }, { silent: true });
  }

  function cycleSortField() {
    const curIdx = SORT_FIELDS.findIndex((f) => f.key === state.settings.sortBy);
    const nextField = SORT_FIELDS[(curIdx + 1) % SORT_FIELDS.length];
    applySortChange(nextField.key, state.settings.sortOrder);
  }

  function bindClick(el, fn) {
    if (!el) return;
    el.addEventListener("click", fn);
    cleanups.push(() => el.removeEventListener("click", fn));
  }

  bindClick(oauthBtn, openOauthModal);
  bindClick(importBtn, openImportModal);
  bindClick(settingsBtn, openSettingsModal);
  bindClick(sortBtn, cycleSortField);
  bindClick(settingAutoToggleBtn, () => {
    draftAutoSwitchEnabled = !draftAutoSwitchEnabled;
    renderSettingsAutoToggle();
  });
  bindClick(settingsSaveBtn, () => void handleSaveSettings());
  bindClick(rollbackBtn, () => void handleRollbackBackup());
  bindClick(statusCancelBtn, () => void handleStatusBannerAction());

  if (sortMenu) {
    const onSortMenuClick = (e) => {
      const orderBtn = e.target?.closest?.("[data-sort-order]");
      if (orderBtn) {
        const nextOrder = orderBtn.getAttribute("data-sort-order") === "asc" ? "asc" : "desc";
        applySortChange(state.settings.sortBy, nextOrder);
        return;
      }
      const fieldBtn = e.target?.closest?.("[data-sort-by]");
      if (fieldBtn) {
        const nextBy = fieldBtn.getAttribute("data-sort-by") || "lastUsed";
        applySortChange(nextBy, state.settings.sortOrder);
      }
    };
    sortMenu.addEventListener("click", onSortMenuClick);
    cleanups.push(() => sortMenu.removeEventListener("click", onSortMenuClick));
  }

  if (sortWrap && sortBtn) {
    const onEnter = () => sortBtn.setAttribute("aria-expanded", "true");
    const onLeave = () => sortBtn.setAttribute("aria-expanded", "false");
    sortWrap.addEventListener("mouseenter", onEnter);
    sortWrap.addEventListener("mouseleave", onLeave);
    cleanups.push(() => sortWrap.removeEventListener("mouseenter", onEnter));
    cleanups.push(() => sortWrap.removeEventListener("mouseleave", onLeave));
  }

  bindClick(captureCurrentBtn, () => void handleCaptureCurrent());
  bindClick(startOfficialOauthBtn, () => void handleStartOfficialOauth());
  bindClick(startDirectOauthBtn, () => void handleStartDirectOauth());
  bindClick(directOauthCancelBtn, () => void handleCancelDirectOauth());
  bindClick(importSubmitBtn, () => void handleImportSubmit());
  bindClick(importFileBtn, () => importFileInput?.click());
  bindClick(remarkSaveBtn, () => void handleSaveRemark());
  bindClick(deleteConfirmBtn, () => void handleConfirmDelete());

  if (importFileInput) {
    const onFileChange = () => {
      const file = importFileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (importTextarea && typeof reader.result === "string") {
          importTextarea.value = reader.result;
          if (importErrorEl) importErrorEl.hidden = true;
        }
      };
      reader.readAsText(file, "utf-8");
      importFileInput.value = "";
    };
    importFileInput.addEventListener("change", onFileChange);
    cleanups.push(() => importFileInput.removeEventListener("change", onFileChange));
  }

  if (remarkInput) {
    const onRemarkKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleSaveRemark();
      }
    };
    remarkInput.addEventListener("keydown", onRemarkKey);
    cleanups.push(() => remarkInput.removeEventListener("keydown", onRemarkKey));
  }

  bindClick(exportCopyBtn, async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(activeExportPayload.jsonText);
      } else if (exportTextarea) {
        exportTextarea.select();
        document.execCommand("copy");
      }
      onToast?.("已复制账号 JSON 到剪贴板", "success");
    } catch {
      onToast?.("复制失败，请手动选中文本复制", "error");
    }
  });

  bindClick(exportDownloadBtn, () => {
    try {
      const blob = new Blob([activeExportPayload.jsonText], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = activeExportPayload.filename || "agy-account.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onToast?.(`已导出 ${a.download}`, "success");
    } catch {
      onToast?.("下载失败，请使用「复制 JSON」", "error");
    }
  });

  // Wire all modal close buttons & backdrops
  if (typeof document !== "undefined") {
    const closeEls = document.querySelectorAll("[data-acc-modal-close]");
    closeEls.forEach((el) => {
      const key = el.getAttribute("data-acc-modal-close");
      const onClose = () => closeModal(key);
      el.addEventListener("click", onClose);
      cleanups.push(() => el.removeEventListener("click", onClose));
    });

    const onEsc = (e) => {
      if (e.key === "Escape") {
        const anyOpen = Object.values(modals).some((m) => m && !m.hidden);
        if (anyOpen) closeAllModals();
      }
    };
    document.addEventListener("keydown", onEsc);
    cleanups.push(() => document.removeEventListener("keydown", onEsc));
  }

  // Render empty skeleton immediately; initial fetch runs on tab activation or post-ready idle check
  if (panelEl) {
    renderAll();
  }

  return {
    refresh,
    setTabActive(isActive) {
      tabActive = Boolean(isActive);
      if (tabActive) {
        void refresh({ silent: true });
      }
      syncPolling();
    },
    destroy() {
      destroyed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (directOauthPollTimer) {
        clearInterval(directOauthPollTimer);
        directOauthPollTimer = null;
      }
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
