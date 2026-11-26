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

const DEFAULT_ACCOUNT_GROUP = "default";
const BUILTIN_ACCOUNT_GROUPS = ["default", "pro", "ultra 5x", "ultra 20x"];
const BUILTIN_ACCOUNT_GROUP_SET = new Set(BUILTIN_ACCOUNT_GROUPS);
const ALL_GROUPS_KEY = "__all__";
const IDLE_POLL_INTERVAL_MS = 30_000;
const FAST_POLL_INTERVAL_MS = 2_500;

function normalizeAccGroup(raw) {
  const cleaned = String(raw || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  if (!cleaned) return DEFAULT_ACCOUNT_GROUP;
  const builtin = BUILTIN_ACCOUNT_GROUPS.find((g) => g.toLowerCase() === cleaned.toLowerCase());
  return builtin || cleaned;
}

function getGroupToneClass(groupName) {
  const lower = normalizeAccGroup(groupName).toLowerCase();
  if (lower === "pro") return "is-group-pro";
  if (lower === "ultra 5x") return "is-group-ultra5";
  if (lower === "ultra 20x") return "is-group-ultra20";
  if (lower === "default") return "is-group-default";
  return "is-group-custom";
}

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

function resolveAccountStatus(acc, nowMs = Date.now()) {
  if (acc?.accountStatus && typeof acc.accountStatus === "object" && acc.accountStatus.code) {
    return acc.accountStatus;
  }
  const rawCode = String(acc?.authErrorCode || "").trim().toUpperCase();
  const msg = String(acc?.authError || "").trim();
  const validationUrl = typeof acc?.authValidationUrl === "string" ? acc.authValidationUrl.trim() : "";
  if (rawCode || msg) {
    let code = rawCode === "INVALID_GRANT" ? "RT_EXPIRED" : rawCode;
    if (!code) {
      if (/validation_required|verify\s+(?:your\s+)?account|要求验证/i.test(msg)) {
        code = "VALIDATION_REQUIRED";
      } else if (/account_disabled|account_suspended|account_banned|tos_violation|封禁|停用/i.test(msg)) {
        code = "ACCOUNT_BANNED";
      } else if (validationUrl) {
        code = "VALIDATION_REQUIRED";
      } else if (/invalid_grant|refresh\s*token|rt\s*已过期/i.test(msg)) {
        code = "RT_EXPIRED";
      } else if (/missing_refresh_token|缺少\s*(?:refresh_token|rt)/i.test(msg)) {
        code = "MISSING_REFRESH_TOKEN";
      } else if (/access\s*token|at\s*已过期|unauthenticated/i.test(msg)) {
        code = "AT_EXPIRED";
      } else if (/subscription_required|订阅权限/i.test(msg)) {
        code = "SUBSCRIPTION_REQUIRED";
      } else if (/代理|网络|超时|timeout|econnrefused/i.test(msg)) {
        code = "NETWORK_ERROR";
      } else {
        code = "API_ERROR";
      }
    }
    const isErr =
      code === "ACCOUNT_BANNED" ||
      code === "RT_EXPIRED" ||
      code === "MISSING_REFRESH_TOKEN" ||
      code === "CLIENT_MISMATCH";
    const badgeMap = {
      VALIDATION_REQUIRED: "需验证",
      ACCOUNT_BANNED: "已封禁",
      RT_EXPIRED: "RT 过期",
      MISSING_REFRESH_TOKEN: "缺少 RT",
      AT_EXPIRED: "AT 过期",
      SUBSCRIPTION_REQUIRED: "无订阅",
      CLIENT_MISMATCH: "客户端异常",
      NETWORK_ERROR: "网络异常",
      API_ERROR: "接口异常",
    };
    return {
      state: isErr ? "error" : "warning",
      code,
      badge: badgeMap[code] || "账号异常",
      blocking:
        code === "ACCOUNT_BANNED" ||
        code === "VALIDATION_REQUIRED" ||
        code === "RT_EXPIRED" ||
        code === "MISSING_REFRESH_TOKEN" ||
        code === "SUBSCRIPTION_REQUIRED",
      message: msg || "账号状态异常，请点击刷新查看详情",
      validationUrl,
      detectedAtMs: Number(acc?.authErrorAtMs) || 0,
    };
  }
  const expMs = Number(acc?.tokenExpiryMs) || 0;
  if (!acc?.isCurrent && expMs > 0 && expMs <= nowMs) {
    const missingRt = acc?.hasRefreshToken === false;
    if (missingRt) {
      return {
        state: "error",
        code: "AT_EXPIRED",
        badge: "AT 过期 · 无 RT",
        blocking: true,
        message: "Access Token (AT) 已过期且缺少 Refresh Token (RT)，请重新授权或导入",
        detectedAtMs: expMs,
      };
    }
    return {
      state: "healthy",
      code: "OK",
      badge: "正常",
      blocking: false,
      message: "",
      detectedAtMs: 0,
      atAutoRenewPending: true,
    };
  }
  if (!acc?.isCurrent && acc?.hasRefreshToken === false) {
    return {
      state: "error",
      code: "MISSING_REFRESH_TOKEN",
      badge: "缺少 RT",
      blocking: true,
      message: "缺少 Refresh Token (RT)，AT 过期后将无法自动续签，建议重新授权",
      detectedAtMs: Number(acc?.updatedAtMs) || 0,
    };
  }
  return { state: "healthy", code: "OK", badge: "正常", blocking: false, message: "", detectedAtMs: 0 };
}

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) return false;
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back to execCommand when async gesture activation expires inside iframe/Electron
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
  const groupBarEl = document.getElementById("accGroupBar");
  const groupPillsEl = document.getElementById("accGroupPills");
  const addGroupToggleBtn = document.getElementById("accAddGroupToggleBtn");
  const addGroupForm = document.getElementById("accAddGroupForm");
  const addGroupInput = document.getElementById("accAddGroupInput");
  const addGroupSubmitBtn = document.getElementById("accAddGroupSubmitBtn");
  const addGroupCancelBtn = document.getElementById("accAddGroupCancelBtn");
  const filterBarEl = document.getElementById("accFilterBar");
  const filterGroupEl = document.getElementById("accFilterGroup");
  const filterCountAllEl = document.getElementById("accFilterCountAll");
  const filterCountHealthyEl = document.getElementById("accFilterCountHealthy");
  const filterCountAbnormalEl = document.getElementById("accFilterCountAbnormal");
  const renewAtBtn = document.getElementById("accRenewAtBtn");
  const renewAtLabelEl = document.getElementById("accRenewAtLabel");
  const batchRefreshBtn = document.getElementById("accBatchRefreshBtn");
  const batchRefreshLabelEl = document.getElementById("accBatchRefreshLabel");
  const disableAbnormalBtn = document.getElementById("accDisableAbnormalBtn");
  const disableAbnormalLabelEl = document.getElementById("accDisableAbnormalLabel");

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
  const settingsQuotaPausedNote = document.getElementById("accSettingsQuotaPausedNote");
  const settingRefreshMinInput = document.getElementById("accSettingRefreshMinInput");
  const settingBgInactiveToggleBtn = document.getElementById("accSettingBgInactiveToggleBtn");
  const settingBgInactiveToggleText = document.getElementById("accSettingBgInactiveToggleText");
  const settingAutoTargetSelect = document.getElementById("accSettingAutoTargetSelect");
  const settingAutoToggleBtn = document.getElementById("accSettingAutoToggleBtn");
  const settingAutoToggleText = document.getElementById("accSettingAutoToggleText");
  const settingsSaveBtn = document.getElementById("accSettingsSaveBtn");

  // OAuth modal controls
  const oauthCurrentHintEl = document.getElementById("accOauthCurrentHint");
  const captureGroupSelect = document.getElementById("accCaptureGroupSelect");
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
  const importGroupSelect = document.getElementById("accImportGroupSelect");
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
  let quotaQueryEnabled = true;
  let officialActiveOnly = true;
  let pollTimer = null;
  let pollIntervalMs = 0;
  let directOauthPollTimer = null;
  let loading = false;
  let switchingAccountId = "";
  let lastNotifiedResumeMs = 0;
  let lastNotifiedOauthMs = 0;
  let lastNotifiedAutoSwitchMs = 0;
  let draftAutoSwitchEnabled = false;
  let draftBgRefreshInactive = false;
  let activeRemarkAccount = null;
  let activeDeleteAccount = null;
  let activeExportPayload = { filename: "agy-account.json", jsonText: "" };
  let activeGroup = ALL_GROUPS_KEY;
  let activeFilter = "all";
  let lastListRenderSig = "";
  let lastSummaryRenderSig = "";
  let batchRefreshing = false;
  let batchProgressText = "";
  let batchRenewingAt = false;
  let renewAtProgressText = "";
  const refreshingIds = new Set();
  const renewingAtIds = new Set();
  const togglingIds = new Set();
  const updatingGroupIds = new Set();
  const openingValidationIds = new Set();
  const openedValidationIds = new Set();
  const copiedValidationIds = new Set();
  const pulsingCardIds = new Set();
  const cleanups = [];

  const state = {
    supported: true,
    dpapiProtected: true,
    currentEmail: "",
    hasLiveCredential: false,
    accounts: [],
    groups: [...BUILTIN_ACCOUNT_GROUPS],
    builtinGroups: [...BUILTIN_ACCOUNT_GROUPS],
    settings: {
      quotaRefreshIntervalMin: 5,
      autoSwitchTarget: "gemini",
      autoSwitchEnabled: false,
      backgroundRefreshInactive: false,
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

  function getEffectiveGroups() {
    const out = [DEFAULT_ACCOUNT_GROUP];
    const seen = new Set([DEFAULT_ACCOUNT_GROUP]);
    const push = (raw) => {
      const clean = normalizeAccGroup(raw);
      const lower = clean.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      out.push(clean);
    };
    const sourceGroups = Array.isArray(state.groups) && state.groups.length > 0
      ? state.groups
      : BUILTIN_ACCOUNT_GROUPS;
    sourceGroups.forEach((g) => push(g));
    if (Array.isArray(state.accounts)) {
      state.accounts.forEach((acc) => {
        if (acc && acc.group) push(acc.group);
      });
    }
    return out;
  }

  function getGroupFilteredAccounts() {
    const allAccounts = Array.isArray(state.accounts) ? state.accounts : [];
    if (activeGroup === ALL_GROUPS_KEY) return allAccounts;
    const targetLower = activeGroup.toLowerCase();
    return allAccounts.filter((acc) => normalizeAccGroup(acc?.group).toLowerCase() === targetLower);
  }

  function populateGroupSelect(selectEl, selectedValue) {
    if (!selectEl) return;
    const groups = getEffectiveGroups();
    const targetVal = normalizeAccGroup(selectedValue || DEFAULT_ACCOUNT_GROUP);
    selectEl.innerHTML = "";
    groups.forEach((g) => {
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      if (g.toLowerCase() === targetVal.toLowerCase()) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    });
    selectEl.value = groups.find((g) => g.toLowerCase() === targetVal.toLowerCase()) || DEFAULT_ACCOUNT_GROUP;
  }

  function syncModalGroupSelects() {
    const preferred = activeGroup !== ALL_GROUPS_KEY ? activeGroup : DEFAULT_ACCOUNT_GROUP;
    populateGroupSelect(captureGroupSelect, captureGroupSelect?.value || preferred);
    populateGroupSelect(importGroupSelect, importGroupSelect?.value || preferred);
  }

  function renderGroupBar() {
    if (!groupBarEl || !groupPillsEl) return;
    const groups = getEffectiveGroups();
    if (
      activeGroup !== ALL_GROUPS_KEY &&
      !groups.some((g) => g.toLowerCase() === activeGroup.toLowerCase())
    ) {
      activeGroup = ALL_GROUPS_KEY;
    }

    const allAccounts = Array.isArray(state.accounts) ? state.accounts : [];
    const countByGroup = new Map();
    for (const acc of allAccounts) {
      const key = normalizeAccGroup(acc?.group).toLowerCase();
      countByGroup.set(key, (countByGroup.get(key) || 0) + 1);
    }

    groupPillsEl.innerHTML = "";

    const makePill = ({ key, label, count, isProtected, toneClass }) => {
      const isActive =
        key === ALL_GROUPS_KEY
          ? activeGroup === ALL_GROUPS_KEY
          : activeGroup !== ALL_GROUPS_KEY && activeGroup.toLowerCase() === key.toLowerCase();

      const wrap = document.createElement("div");
      wrap.className = `acc-group-pill-wrap${isActive ? " is-active" : ""}`;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `acc-group-pill ${toneClass}${isActive ? " is-active" : ""}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(isActive));
      btn.setAttribute("data-acc-group", key);

      const textEl = document.createElement("span");
      textEl.className = "acc-group-pill-name";
      textEl.textContent = label;
      btn.appendChild(textEl);

      const cntEl = document.createElement("span");
      cntEl.className = "acc-filter-count";
      cntEl.textContent = String(count);
      btn.appendChild(cntEl);

      btn.addEventListener("click", () => {
        if (activeGroup === key) return;
        activeGroup = key;
        renderGroupBar();
        renderQuotaSummaryCard({ force: true });
        renderFilterBar();
        renderAccountList({ force: true });
      });

      wrap.appendChild(btn);

      if (!isProtected && key !== ALL_GROUPS_KEY) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "acc-group-del-btn";
        delBtn.textContent = "×";
        delBtn.title = `删除分组「${label}」（该组账号将自动移回 default）`;
        delBtn.setAttribute("aria-label", `删除分组 ${label}`);
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          void handleDeleteGroup(label);
        });
        wrap.appendChild(delBtn);
      }

      return wrap;
    };

    groupPillsEl.appendChild(
      makePill({
        key: ALL_GROUPS_KEY,
        label: "全部",
        count: allAccounts.length,
        isProtected: true,
        toneClass: "is-group-all",
      }),
    );

    groups.forEach((g) => {
      const isProtected = g.toLowerCase() === DEFAULT_ACCOUNT_GROUP;
      groupPillsEl.appendChild(
        makePill({
          key: g,
          label: g,
          count: countByGroup.get(g.toLowerCase()) || 0,
          isProtected,
          toneClass: getGroupToneClass(g),
        }),
      );
    });
  }

  function buildListRenderSignature(nowMs) {
    const groups = getEffectiveGroups();
    const list = Array.isArray(state.accounts) ? state.accounts : [];
    const compactAccounts = list.map((acc) => {
      const st = resolveAccountStatus(acc, nowMs);
      const qGroups = Array.isArray(acc?.quota?.groups)
        ? acc.quota.groups.map((g) => [
            g?.key || "",
            g?.fiveHour?.remainingPct ?? null,
            Boolean(g?.fiveHour?.resetPassed),
            Boolean(g?.fiveHour?.disabled),
            g?.weekly?.remainingPct ?? null,
            Boolean(g?.weekly?.resetPassed),
            Boolean(g?.weekly?.disabled),
          ])
        : null;
      return [
        acc?.id || "",
        acc?.email || "",
        acc?.remark || "",
        normalizeAccGroup(acc?.group),
        acc?.enabled !== false,
        Boolean(acc?.isCurrent),
        Number(acc?.lastUsedAtMs || 0),
        Number(acc?.updatedAtMs || 0),
        st.code || "",
        st.state || "",
        st.badge || "",
        st.message || "",
        st.validationUrl || "",
        Number(acc?.quota?.fetchedAtMs || 0),
        qGroups,
      ];
    });
    return JSON.stringify({
      supported: state.supported,
      quotaQueryEnabled,
      officialActiveOnly,
      currentEmail: state.currentEmail,
      activeGroup,
      activeFilter,
      sortBy: getEffectiveSortBy(),
      sortOrder: state.settings.sortOrder,
      groups,
      switchingAccountId,
      refreshing: [...refreshingIds].sort(),
      renewingAt: [...renewingAtIds].sort(),
      toggling: [...togglingIds].sort(),
      updatingGroup: [...updatingGroupIds].sort(),
      openingValidation: [...openingValidationIds].sort(),
      openedValidation: [...openedValidationIds].sort(),
      copiedValidation: [...copiedValidationIds].sort(),
      pulsing: [...pulsingCardIds].sort(),
      accounts: compactAccounts,
    });
  }

  function isUserInteractingInsideList() {
    if (typeof document === "undefined" || !listEl) return false;
    const active = document.activeElement;
    if (!active || !listEl.contains(active)) return false;
    const tag = String(active.tagName || "").toUpperCase();
    return tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA";
  }

  function renderAccountList({ force = false } = {}) {
    if (!listEl) return;
    if (!force && isUserInteractingInsideList()) return;
    const nowMs = Date.now();
    const renderSig = buildListRenderSignature(nowMs);
    if (!force && renderSig === lastListRenderSig) return;
    lastListRenderSig = renderSig;
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

    const groupScoped = getGroupFilteredAccounts();
    const sortedAccounts = sortAccountsList(
      groupScoped,
      getEffectiveSortBy(),
      state.settings.sortOrder,
      nowMs,
    );

    const visibleAccounts = sortedAccounts.filter((acc) => {
      if (activeFilter === "all") return true;
      const st = resolveAccountStatus(acc, nowMs);
      const isAbnormal = st.state !== "healthy";
      return activeFilter === "abnormal" ? isAbnormal : !isAbnormal;
    });

    if (visibleAccounts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "acc-empty-card";
      const title = document.createElement("div");
      title.className = "acc-empty-title";
      const inSpecificGroup = activeGroup !== ALL_GROUPS_KEY;
      title.textContent =
        activeFilter === "abnormal"
          ? inSpecificGroup
            ? `分组「${activeGroup}」没有异常账号`
            : "当前没有异常账号"
          : inSpecificGroup && groupScoped.length === 0
            ? `分组「${activeGroup}」暂无账号`
            : "当前筛选条件下无账号";
      const desc = document.createElement("div");
      desc.className = "acc-empty-desc";
      desc.textContent =
        activeFilter === "abnormal"
          ? "当前范围已检测账号状态良好，如需重新核验可点击上方「一键检测全部」。"
          : inSpecificGroup
            ? "可在账号卡片顶部切换分组将其移入此处，或点击下方按钮查看全部分组。"
            : "点击「全部」查看所有已保存账号。";
      empty.appendChild(title);
      empty.appendChild(desc);
      if (inSpecificGroup) {
        const showAllBtn = document.createElement("button");
        showAllBtn.type = "button";
        showAllBtn.className = "acc-secondary-btn";
        showAllBtn.textContent = "查看全部分组";
        showAllBtn.addEventListener("click", () => {
          activeGroup = ALL_GROUPS_KEY;
          activeFilter = "all";
          renderAll({ force: true });
        });
        empty.appendChild(showAllBtn);
      }
      listEl.appendChild(empty);
      return;
    }

    const allGroupOptions = getEffectiveGroups();

    visibleAccounts.forEach((acc) => {
      const accStatus = resolveAccountStatus(acc, nowMs);
      const isAbnormal = accStatus.state !== "healthy";
      const accGroup = normalizeAccGroup(acc.group);

      const card = document.createElement("article");
      card.className = "acc-item-card";
      card.setAttribute("role", "listitem");
      card.setAttribute("data-account-id", acc.id);
      card.setAttribute("data-account-group", accGroup);
      if (accStatus.code && accStatus.code !== "OK") {
        card.setAttribute("data-account-status", accStatus.code);
      }
      if (acc.isCurrent) card.classList.add("is-current");
      if (!acc.enabled) card.classList.add("is-disabled");
      if (accStatus.state === "error") card.classList.add("is-abnormal-error");
      else if (accStatus.state === "warning") card.classList.add("is-abnormal-warn");
      if (pulsingCardIds.has(acc.id)) card.classList.add("is-trigger-pulse");

      // Row 1: Identity (Email + Status badges + Group selector + Remark)
      const topRow = document.createElement("div");
      topRow.className = "acc-item-head";

      const idLeft = document.createElement("div");
      idLeft.className = "acc-item-identity";

      const statusDot = document.createElement("span");
      const dotClass =
        accStatus.state === "error"
          ? "is-error"
          : accStatus.state === "warning"
            ? "is-warn"
            : acc.isCurrent
              ? "is-current"
              : acc.enabled
                ? "is-enabled"
                : "is-disabled";
      statusDot.className = `acc-item-dot ${dotClass}`;
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
      if (isAbnormal) {
        const errBadge = document.createElement("span");
        errBadge.className = `acc-badge ${accStatus.state === "error" ? "is-error" : "is-warn"}`;
        errBadge.textContent = accStatus.badge || "异常";
        errBadge.title = accStatus.message || accStatus.badge;
        idLeft.appendChild(errBadge);
      }
      if (!acc.enabled) {
        const disBadge = document.createElement("span");
        disBadge.className = "acc-badge is-disabled";
        disBadge.textContent = "已禁用";
        idLeft.appendChild(disBadge);
      }

      // Inline account group selector pill
      const groupSelect = document.createElement("select");
      groupSelect.className = `acc-group-select ${getGroupToneClass(accGroup)}`;
      groupSelect.setAttribute("aria-label", `切换 ${acc.email} 的分组`);
      groupSelect.title = `当前分组：${accGroup}（点击切换分组）`;
      groupSelect.disabled = updatingGroupIds.has(acc.id);
      allGroupOptions.forEach((g) => {
        const opt = document.createElement("option");
        opt.value = g;
        opt.textContent = g;
        if (g.toLowerCase() === accGroup.toLowerCase()) {
          opt.selected = true;
        }
        groupSelect.appendChild(opt);
      });
      groupSelect.value =
        allGroupOptions.find((g) => g.toLowerCase() === accGroup.toLowerCase()) || DEFAULT_ACCOUNT_GROUP;
      groupSelect.addEventListener("change", () => {
        const nextGroup = groupSelect.value;
        if (normalizeAccGroup(nextGroup).toLowerCase() === accGroup.toLowerCase()) return;
        void handleChangeAccountGroup(acc, nextGroup);
      });
      idLeft.appendChild(groupSelect);

      if (acc.remark) {
        const remarkChip = document.createElement("span");
        remarkChip.className = "acc-remark-chip";
        remarkChip.textContent = acc.remark;
        remarkChip.title = `备注：${acc.remark}`;
        idLeft.appendChild(remarkChip);
      }

      const idRight = document.createElement("div");
      idRight.className = "acc-item-meta";
      if (quotaQueryEnabled && acc.quota?.fetchedAtMs) {
        const syncTime = document.createElement("span");
        syncTime.className = "acc-quota-sync-time";
        syncTime.textContent = `额度 ${formatClock(acc.quota.fetchedAtMs)}`;
        idRight.appendChild(syncTime);
      }

      topRow.appendChild(idLeft);
      topRow.appendChild(idRight);
      card.appendChild(topRow);

      // Row 2: Two quota categories (Gemini / GPT&Claude) — omitted cleanly when global quota viewing is OFF
      if (quotaQueryEnabled) {
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
      }

      // Row 2.5: Abnormal error detail banner with contextual recovery action
      if (isAbnormal && accStatus.message) {
        const alertBar = document.createElement("div");
        alertBar.className = `acc-item-alert ${accStatus.state === "error" ? "is-error" : "is-warn"}`;
        alertBar.setAttribute("role", "alert");
        if (accStatus.detectedAtMs) {
          alertBar.title = `检测时间：${formatClock(accStatus.detectedAtMs)}`;
        }

        const alertMain = document.createElement("div");
        alertMain.className = "acc-item-alert-main";
        const iconPath =
          accStatus.state === "error"
            ? "M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2ZM8 5v3.5M8 10.9h.01"
            : "M8 2.4 13.8 12.8H2.2L8 2.4ZM8 6.3v3M8 11.1h.01";
        alertMain.appendChild(createSvgIcon(iconPath, "acc-item-alert-icon"));

        const alertText = document.createElement("span");
        alertText.className = "acc-item-alert-text";
        alertText.textContent = accStatus.message;
        alertMain.appendChild(alertText);
        alertBar.appendChild(alertMain);

        if (accStatus.code === "VALIDATION_REQUIRED" && accStatus.validationUrl) {
          const actionGroup = document.createElement("div");
          actionGroup.className = "acc-item-alert-actions";

          const isOpening = openingValidationIds.has(acc.id);
          const isOpened = openedValidationIds.has(acc.id);
          const verifyBtn = document.createElement("button");
          verifyBtn.type = "button";
          verifyBtn.className = `acc-item-alert-btn${isOpening ? " is-launching" : isOpened ? " is-done" : ""}`;
          verifyBtn.disabled = isOpening;
          if (isOpening) {
            verifyBtn.appendChild(createSvgIcon("M13.3 8a5.3 5.3 0 1 1-1.45-3.65", "acc-alert-spin-icon"));
            const lbl = document.createElement("span");
            lbl.textContent = "打开中…";
            verifyBtn.appendChild(lbl);
          } else if (isOpened) {
            verifyBtn.appendChild(createSvgIcon("M3.2 8.4 6.6 11.6 12.8 4.6", "acc-alert-check-icon"));
            const lbl = document.createElement("span");
            lbl.textContent = "已打开";
            verifyBtn.appendChild(lbl);
          } else {
            const lbl = document.createElement("span");
            lbl.textContent = "去验证";
            verifyBtn.appendChild(lbl);
            verifyBtn.appendChild(createSvgIcon("M5 11 11 5M6.2 5H11v4.8", "acc-alert-arrow-icon"));
          }
          verifyBtn.title = "刷新验证链接并跳转至对应邮箱的 Google 登录与验证页";
          verifyBtn.addEventListener("click", () => void handleOpenValidationUrl(acc, accStatus.validationUrl));
          actionGroup.appendChild(verifyBtn);

          const isCopied = copiedValidationIds.has(acc.id);
          const copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = `acc-item-alert-btn is-icon-only${isCopied ? " is-done" : ""}`;
          copyBtn.disabled = isOpening;
          copyBtn.appendChild(
            createSvgIcon(
              isCopied
                ? "M3.2 8.4 6.6 11.6 12.8 4.6"
                : "M5.5 5.5h6.8a1 1 0 0 1 1 1v6.8a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1ZM3.7 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.7",
              isCopied ? "acc-alert-check-icon" : "",
            ),
          );
          copyBtn.title = "复制验证链接（方便粘贴到无痕窗口或对应账号的浏览器配置中验证）";
          copyBtn.setAttribute("aria-label", "复制验证链接");
          copyBtn.addEventListener("click", () => void handleCopyValidationUrl(acc, accStatus.validationUrl));
          actionGroup.appendChild(copyBtn);

          alertBar.appendChild(actionGroup);
        } else if (
          accStatus.code === "RT_EXPIRED" ||
          accStatus.code === "MISSING_REFRESH_TOKEN" ||
          (accStatus.code === "AT_EXPIRED" && accStatus.blocking)
        ) {
          const reauthBtn = document.createElement("button");
          reauthBtn.type = "button";
          reauthBtn.className = "acc-item-alert-btn";
          reauthBtn.textContent = "重新授权";
          reauthBtn.title = "打开 OAuth 授权窗口重新获取有效凭证";
          reauthBtn.addEventListener("click", () => {
            triggerCardPulse(acc.id);
            openOauthModal();
          });
          alertBar.appendChild(reauthBtn);
        } else if (accStatus.code === "AT_EXPIRED" && !accStatus.blocking) {
          const isRenewing = renewingAtIds.has(acc.id) || refreshingIds.has(acc.id);
          const renewBtn = document.createElement("button");
          renewBtn.type = "button";
          renewBtn.className = `acc-item-alert-btn${isRenewing ? " is-launching" : ""}`;
          renewBtn.disabled = isRenewing;
          if (isRenewing) {
            renewBtn.appendChild(createSvgIcon("M13.3 8a5.3 5.3 0 1 1-1.45-3.65", "acc-alert-spin-icon"));
          }
          const lbl = document.createElement("span");
          lbl.textContent = isRenewing ? "续签中…" : "立即续签";
          renewBtn.appendChild(lbl);
          renewBtn.title = "仅使用保存的 RT 立即续签 AT（不触发额度接口，低风控）";
          renewBtn.addEventListener("click", () => {
            triggerCardPulse(acc.id);
            void handleRenewSingleAt(acc);
          });
          alertBar.appendChild(renewBtn);
        }

        card.appendChild(alertBar);
      }

      // Row 3: Action buttons (Switch, Refresh Quota, Enable/Disable, Remark, Export JSON, Delete)
      const actionsRow = document.createElement("div");
      actionsRow.className = "acc-item-actions";

      // 1. Switch button (immediate direct switch without confirmation modal)
      const isSwitchingThis = switchingAccountId === acc.id;
      const isSwitchBlocked =
        accStatus.code === "ACCOUNT_BANNED" ||
        accStatus.code === "RT_EXPIRED" ||
        accStatus.code === "MISSING_REFRESH_TOKEN" ||
        (accStatus.code === "AT_EXPIRED" && accStatus.blocking);
      const switchBtn = document.createElement("button");
      switchBtn.type = "button";
      switchBtn.className = `acc-act-btn is-switch${acc.isCurrent ? " is-active-now" : ""}${isSwitchingThis ? " is-spinning" : ""}`;
      switchBtn.disabled =
        acc.isCurrent || !acc.enabled || isSwitchBlocked || !state.supported || Boolean(switchingAccountId);
      switchBtn.appendChild(createSvgIcon("M3 6h9.5M9.5 3.2L12.5 6l-3 2.8M13 10H3.5M6.5 7.2L3.5 10l3 2.8"));
      const switchLabel = document.createElement("span");
      switchLabel.textContent = acc.isCurrent ? "使用中" : isSwitchingThis ? "切换中…" : "切换账号";
      switchBtn.appendChild(switchLabel);
      switchBtn.title = acc.isCurrent
        ? "当前正使用该账号"
        : !acc.enabled
          ? "已禁用账号不可切换，请先启用"
          : isSwitchBlocked
            ? accStatus.code === "ACCOUNT_BANNED"
              ? "该账号已被 Google 封禁或停用，不可切换"
              : "该账号凭据已过期或缺少 RT，请先重新授权后再切换"
            : "点击直接切换至该账号并自动重启（仅续跑真正运行中的活动会话）";
      switchBtn.addEventListener("click", () => void handleSwitchAccountDirect(acc));
      actionsRow.appendChild(switchBtn);

      // 2. Refresh quota button (hidden when global quota viewing is disabled so remaining buttons fill full width)
      if (quotaQueryEnabled) {
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
          ? "立即通过官方通道同步当前账号实时额度"
          : officialActiveOnly
            ? "官方合规模式：已禁绝直连 cloudcode-pa，未激活账号切入后自动同步官方额度"
            : "自动续签凭证并实时同步该账号官方额度";
        refreshBtn.addEventListener("click", () => void handleRefreshQuota(acc));
        actionsRow.appendChild(refreshBtn);
      }

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

  function getVisibleSortFields() {
    return SORT_FIELDS.filter(
      (f) => quotaQueryEnabled || (f.key !== "gemini" && f.key !== "gpt_claude"),
    );
  }

  function getEffectiveSortBy() {
    const raw = state.settings.sortBy || "lastUsed";
    if (!quotaQueryEnabled && (raw === "gemini" || raw === "gpt_claude")) {
      return "lastUsed";
    }
    return raw;
  }

  function renderSortControls() {
    const effectiveSortBy = getEffectiveSortBy();
    const curField =
      SORT_FIELDS.find((f) => f.key === effectiveSortBy) || SORT_FIELDS[SORT_FIELDS.length - 1];
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
        const key = btn.getAttribute("data-sort-by");
        const isQuotaSort = key === "gemini" || key === "gpt_claude";
        btn.hidden = !quotaQueryEnabled && isQuotaSort;
        const active = key === effectiveSortBy;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-checked", String(active));
      });
    }
  }

  function renderQuotaSummaryCard({ force = false } = {}) {
    if (!summaryCardEl || !summaryGridEl) return;
    if (!quotaQueryEnabled) {
      summaryCardEl.hidden = true;
      summaryGridEl.innerHTML = "";
      lastSummaryRenderSig = "";
      return;
    }
    const allAccounts = getGroupFilteredAccounts();
    if (allAccounts.length === 0) {
      summaryCardEl.hidden = true;
      summaryGridEl.innerHTML = "";
      lastSummaryRenderSig = "";
      return;
    }

    const nowMs = Date.now();
    const enabledAccounts = allAccounts.filter((acc) => acc && acc.enabled !== false);
    const abnormalCount = allAccounts.filter((acc) => resolveAccountStatus(acc, nowMs).state !== "healthy").length;
    const pool = enabledAccounts.filter((acc) => !resolveAccountStatus(acc, nowMs).blocking);
    summaryCardEl.hidden = false;

    const groupPrefix = activeGroup !== ALL_GROUPS_KEY ? `分组「${activeGroup}」 · ` : "";
    if (summaryMetaEl) {
      const baseText =
        enabledAccounts.length === allAccounts.length
          ? `${groupPrefix}共 ${allAccounts.length} 个账号`
          : `${groupPrefix}已启用 ${enabledAccounts.length} / ${allAccounts.length} 个账号`;
      summaryMetaEl.textContent = abnormalCount > 0 ? `${baseText} · 异常 ${abnormalCount} 个` : baseText;
    }
    if (summaryHintEl) {
      summaryHintEl.textContent = `可用总容量 ${pool.length * 100}%`;
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

    const aggByKey = DEFAULT_GROUPS.map((def) => ({
      def,
      agg5h: aggregateBucket(def.key, "fiveHour"),
      aggWeekly: aggregateBucket(def.key, "weekly"),
    }));
    const summarySig = JSON.stringify({
      activeGroup,
      total: allAccounts.length,
      enabled: enabledAccounts.length,
      abnormal: abnormalCount,
      pool: pool.length,
      aggs: aggByKey.map((x) => [x.agg5h, x.aggWeekly]),
    });
    if (!force && summarySig === lastSummaryRenderSig) return;
    lastSummaryRenderSig = summarySig;

    summaryGridEl.innerHTML = "";
    aggByKey.forEach(({ def, agg5h, aggWeekly }) => {

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

  function renderFilterBar() {
    if (!filterBarEl) return;
    const totalAccounts = Array.isArray(state.accounts) ? state.accounts : [];
    if (totalAccounts.length === 0) {
      filterBarEl.hidden = true;
      return;
    }
    filterBarEl.hidden = false;
    const allAccounts = getGroupFilteredAccounts();
    const nowMs = Date.now();
    let healthyCount = 0;
    let abnormalCount = 0;
    let enabledBlockingCount = 0;
    let renewableAtCount = 0;
    for (const acc of allAccounts) {
      const st = resolveAccountStatus(acc, nowMs);
      if (st.state === "healthy") {
        healthyCount += 1;
      } else {
        abnormalCount += 1;
        if (acc.enabled !== false && !acc.isCurrent && st.blocking) {
          enabledBlockingCount += 1;
        }
        if (acc.enabled !== false && st.code === "AT_EXPIRED" && !st.blocking) {
          renewableAtCount += 1;
        }
      }
    }
    if (filterCountAllEl) filterCountAllEl.textContent = String(allAccounts.length);
    if (filterCountHealthyEl) filterCountHealthyEl.textContent = String(healthyCount);
    if (filterCountAbnormalEl) filterCountAbnormalEl.textContent = String(abnormalCount);

    if (filterGroupEl) {
      filterGroupEl.querySelectorAll("[data-acc-filter]").forEach((btn) => {
        const key = btn.getAttribute("data-acc-filter") || "all";
        const active = key === activeFilter;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", String(active));
        if (key === "abnormal") {
          btn.classList.toggle("has-abnormal", abnormalCount > 0);
        }
      });
    }
    if (renewAtBtn) {
      renewAtBtn.hidden = renewableAtCount === 0 && !batchRenewingAt;
      renewAtBtn.disabled = batchRenewingAt || batchRefreshing;
      renewAtBtn.classList.toggle("is-spinning", batchRenewingAt);
    }
    if (renewAtLabelEl) {
      renewAtLabelEl.textContent = batchRenewingAt
        ? renewAtProgressText || "续签 AT 中…"
        : `一键刷新 AT (${renewableAtCount})`;
    }
    if (batchRefreshBtn) {
      batchRefreshBtn.hidden = !quotaQueryEnabled;
      batchRefreshBtn.disabled = batchRefreshing || batchRenewingAt;
      batchRefreshBtn.classList.toggle("is-spinning", batchRefreshing);
      if (officialActiveOnly) {
        batchRefreshBtn.title = "官方合规模式：仅通过官方通道刷新当前登录账号额度（不直连 cloudcode-pa 探测未激活账号）";
      }
    }
    if (batchRefreshLabelEl) {
      batchRefreshLabelEl.textContent = batchRefreshing
        ? batchProgressText || "检测中…"
        : officialActiveOnly
          ? "刷新当前额度"
          : "一键检测全部";
    }
    if (disableAbnormalBtn) {
      disableAbnormalBtn.hidden = enabledBlockingCount === 0;
      disableAbnormalBtn.disabled = batchRefreshing || batchRenewingAt;
    }
    if (disableAbnormalLabelEl) {
      disableAbnormalLabelEl.textContent = `禁用异常 (${enabledBlockingCount})`;
    }
  }

  function renderAll({ force = true } = {}) {
    if (panelEl) {
      panelEl.classList.toggle("is-quota-disabled", !quotaQueryEnabled);
    }
    renderHeaderMeta();
    renderSortControls();
    renderGroupBar();
    renderQuotaSummaryCard({ force });
    renderStatusBanner();
    renderFilterBar();
    renderAccountList({ force });
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
      if (typeof data.quotaQueryEnabled === "boolean") {
        quotaQueryEnabled = data.quotaQueryEnabled;
      }
      if (typeof data.officialActiveOnly === "boolean") {
        officialActiveOnly = data.officialActiveOnly;
      }
      state.currentEmail = String(data.currentEmail || "");
      state.hasLiveCredential = Boolean(data.hasLiveCredential);
      state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
      if (Array.isArray(data.groups) && data.groups.length > 0) {
        state.groups = data.groups;
      }
      if (Array.isArray(data.builtinGroups) && data.builtinGroups.length > 0) {
        state.builtinGroups = data.builtinGroups;
      }
      if (data.settings && typeof data.settings === "object") {
        state.settings = {
          quotaRefreshIntervalMin:
            data.settings.quotaRefreshIntervalMin !== undefined
              ? Number(data.settings.quotaRefreshIntervalMin)
              : 5,
          autoSwitchTarget: String(data.settings.autoSwitchTarget || "gemini"),
          autoSwitchEnabled: Boolean(data.settings.autoSwitchEnabled),
          backgroundRefreshInactive: Boolean(data.settings.backgroundRefreshInactive),
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

      renderAll({ force: !silent });
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
    const shouldPoll = (tabActive || needFastPoll) && !destroyed;
    const targetMs = needFastPoll ? FAST_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    if (!shouldPoll) {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
        pollIntervalMs = 0;
      }
      return;
    }
    if (pollTimer && pollIntervalMs === targetMs) return;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    pollIntervalMs = targetMs;
    pollTimer = setInterval(() => {
      if (destroyed) return;
      if (tabActive || state.pendingResume || state.pendingOauth) {
        void refresh({ silent: true });
      }
    }, targetMs);
  }

  function openOauthModal() {
    resetDirectOauthUI();
    if (oauthCurrentHintEl) {
      oauthCurrentHintEl.textContent = state.currentEmail
        ? `当前检测到已登录账号：${state.currentEmail}。点击下方按钮立即加密收录并同步官方实时额度。`
        : "未检测到活跃登录凭据。请先登录 Antigravity，或使用下方「打开浏览器授权新号」。";
    }
    if (captureRemarkInput) captureRemarkInput.value = "";
    populateGroupSelect(
      captureGroupSelect,
      activeGroup !== ALL_GROUPS_KEY ? activeGroup : DEFAULT_ACCOUNT_GROUP,
    );
    openModal("oauth");
  }

  async function handleCaptureCurrent() {
    if (captureCurrentBtn) captureCurrentBtn.disabled = true;
    try {
      const remark = captureRemarkInput ? captureRemarkInput.value.trim() : "";
      const group = captureGroupSelect ? captureGroupSelect.value : DEFAULT_ACCOUNT_GROUP;
      const res = await requestJson("/api/accounts/capture", {
        method: "POST",
        body: JSON.stringify({ remark, group }),
      });
      closeModal("oauth");
      onToast?.(
        res.isNew
          ? `已加密收录账号：${res.account?.email || ""}`
          : `已更新账号凭证与额度：${res.account?.email || ""}`,
        "success",
      );
      await refresh({ silent: false });
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
      const group = captureGroupSelect ? captureGroupSelect.value : DEFAULT_ACCOUNT_GROUP;
      const res = await requestJson("/api/accounts/oauth-direct/start", {
        method: "POST",
        body: JSON.stringify({ remark, group }),
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
    populateGroupSelect(
      importGroupSelect,
      activeGroup !== ALL_GROUPS_KEY ? activeGroup : DEFAULT_ACCOUNT_GROUP,
    );
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
      const selectedGroup = importGroupSelect ? importGroupSelect.value : DEFAULT_ACCOUNT_GROUP;
      const res = await requestJson("/api/accounts/import", {
        method: "POST",
        body: JSON.stringify({
          rawInput,
          email: importEmailInput ? importEmailInput.value.trim() : "",
          remark: importRemarkInput ? importRemarkInput.value.trim() : "",
          group: selectedGroup !== DEFAULT_ACCOUNT_GROUP ? selectedGroup : "",
        }),
      });
      closeModal("import");
      onToast?.(
        `导入完成：新增 ${res.addedCount || 0} 个，更新 ${res.updatedCount || 0} 个`,
        "success",
      );
      await refresh({ silent: false });
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
      renderFilterBar();
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
      renderAccountList({ force: true });
      onToast?.("账号备注已保存", "success");
    } catch (err) {
      onToast?.(err?.message || "保存备注失败", "error");
    } finally {
      if (remarkSaveBtn) remarkSaveBtn.disabled = false;
    }
  }

  async function handleChangeAccountGroup(acc, nextGroup) {
    if (!acc || !acc.id || updatingGroupIds.has(acc.id)) return;
    updatingGroupIds.add(acc.id);
    try {
      const res = await requestJson("/api/accounts/group", {
        method: "POST",
        body: JSON.stringify({ accountId: acc.id, group: nextGroup }),
      });
      const idx = state.accounts.findIndex((a) => a.id === acc.id);
      if (idx >= 0 && res.account) {
        state.accounts[idx] = res.account;
      }
      if (Array.isArray(res.groups) && res.groups.length > 0) {
        state.groups = res.groups;
      }
      onToast?.(`已将 ${acc.email} 移至分组「${res.account?.group || nextGroup}」`, "success");
    } catch (err) {
      onToast?.(err?.message || "修改账号分组失败", "error");
    } finally {
      updatingGroupIds.delete(acc.id);
      renderAll({ force: true });
    }
  }

  function closeAddGroupForm() {
    if (addGroupForm) addGroupForm.hidden = true;
    if (addGroupToggleBtn) addGroupToggleBtn.hidden = false;
    if (addGroupInput) addGroupInput.value = "";
  }

  function openAddGroupForm() {
    if (addGroupToggleBtn) addGroupToggleBtn.hidden = true;
    if (addGroupForm) addGroupForm.hidden = false;
    if (addGroupInput) {
      addGroupInput.value = "";
      addGroupInput.focus?.();
    }
  }

  async function handleAddGroupSubmit() {
    const rawName = addGroupInput ? addGroupInput.value.trim() : "";
    if (!rawName) {
      onToast?.("请输入分组名称", "error");
      addGroupInput?.focus?.();
      return;
    }
    if (addGroupSubmitBtn) addGroupSubmitBtn.disabled = true;
    try {
      const res = await requestJson("/api/accounts/groups", {
        method: "POST",
        body: JSON.stringify({ action: "add", name: rawName }),
      });
      if (Array.isArray(res.groups) && res.groups.length > 0) {
        state.groups = res.groups;
      }
      closeAddGroupForm();
      syncModalGroupSelects();
      renderGroupBar();
      renderAccountList({ force: true });
      onToast?.(`已新建分组「${res.group || rawName}」`, "success");
    } catch (err) {
      onToast?.(err?.message || "新建分组失败", "error");
    } finally {
      if (addGroupSubmitBtn) addGroupSubmitBtn.disabled = false;
    }
  }

  async function handleDeleteGroup(groupName) {
    if (!groupName || groupName.toLowerCase() === DEFAULT_ACCOUNT_GROUP) return;
    try {
      const res = await requestJson("/api/accounts/groups", {
        method: "POST",
        body: JSON.stringify({ action: "delete", name: groupName }),
      });
      if (Array.isArray(res.groups) && res.groups.length > 0) {
        state.groups = res.groups;
      }
      if (Array.isArray(res.accounts)) {
        state.accounts = res.accounts;
      }
      if (activeGroup !== ALL_GROUPS_KEY && activeGroup.toLowerCase() === groupName.toLowerCase()) {
        activeGroup = ALL_GROUPS_KEY;
      }
      syncModalGroupSelects();
      renderAll({ force: true });
      const moved = Number(res.movedCount || 0);
      onToast?.(
        moved > 0
          ? `已删除分组「${groupName}」，其中 ${moved} 个账号已移回 default`
          : `已删除分组「${groupName}」`,
        "success",
      );
    } catch (err) {
      onToast?.(err?.message || "删除分组失败", "error");
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

  async function handleRefreshQuota(acc, { silentToast = false } = {}) {
    if (!quotaQueryEnabled) {
      return { ok: false, skipped: true };
    }
    if (refreshingIds.has(acc.id)) return { ok: false, skipped: true };
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
      if (!silentToast) {
        onToast?.(res.message || "已刷新账号额度", res.mode === "live" ? "success" : "info");
      }
      return { ok: true, account: res.account || null };
    } catch (err) {
      const idx = state.accounts.findIndex((a) => a.id === acc.id);
      if (idx >= 0 && err?.data?.account) {
        state.accounts[idx] = err.data.account;
      }
      if (!silentToast) {
        onToast?.(err?.message || "刷新额度失败", "error");
      }
      return { ok: false, error: err?.message || "刷新额度失败", code: err?.data?.code || "" };
    } finally {
      refreshingIds.delete(acc.id);
      renderQuotaSummaryCard();
      renderFilterBar();
      renderAccountList();
    }
  }

  function triggerCardPulse(accountId) {
    if (!accountId) return;
    pulsingCardIds.add(accountId);
    renderAccountList();
    setTimeout(() => {
      if (destroyed) return;
      pulsingCardIds.delete(accountId);
      const cardEl = listEl?.querySelector?.(`[data-account-id="${accountId}"]`);
      if (cardEl) cardEl.classList.remove("is-trigger-pulse");
    }, 560);
  }

  async function handleOpenValidationUrl(acc, fallbackUrl = "") {
    if (!acc || !acc.id || openingValidationIds.has(acc.id)) return;
    openingValidationIds.add(acc.id);
    openedValidationIds.delete(acc.id);
    pulsingCardIds.add(acc.id);
    renderAccountList();
    setTimeout(() => {
      if (destroyed) return;
      pulsingCardIds.delete(acc.id);
      const cardEl = listEl?.querySelector?.(`[data-account-id="${acc.id}"]`);
      if (cardEl) cardEl.classList.remove("is-trigger-pulse");
    }, 560);

    try {
      const res = await requestJson("/api/accounts/open-validation-url", {
        method: "POST",
        body: JSON.stringify({
          accountId: acc.id,
          fallbackUrl: fallbackUrl || acc.accountStatus?.validationUrl || "",
        }),
      });
      if (res?.alreadyVerified && res.account) {
        const idx = state.accounts.findIndex((a) => a.id === acc.id);
        if (idx >= 0) state.accounts[idx] = res.account;
        onToast?.(res.message || `${acc.email} 已完成验证，额度已恢复正常`, "success");
        return;
      }
      const targetUrl = res?.validationUrl || fallbackUrl || "";
      if (res?.opened === false && /^https:\/\//i.test(targetUrl)) {
        try {
          window.open(targetUrl, "_blank", "noopener,noreferrer");
        } catch {}
        const copied = await copyTextToClipboard(targetUrl);
        onToast?.(
          copied
            ? `已复制 ${acc.email} 的验证链接并尝试打开浏览器`
            : `已尝试打开 ${acc.email} 的 Google 验证页面`,
          "info",
        );
      } else {
        onToast?.(
          `已打开 ${acc.email} 的验证页（如浏览器未登录该邮箱，请先登录对应邮箱后将自动进入验证）`,
          "success",
        );
      }
      openedValidationIds.add(acc.id);
      setTimeout(() => {
        if (destroyed) return;
        openedValidationIds.delete(acc.id);
        renderAccountList();
      }, 1800);
    } catch (err) {
      const urlToTry = err?.data?.validationUrl || fallbackUrl || acc.accountStatus?.validationUrl || "";
      if (/^https:\/\//i.test(urlToTry)) {
        try {
          window.open(urlToTry, "_blank", "noopener,noreferrer");
          const copied = await copyTextToClipboard(urlToTry);
          openedValidationIds.add(acc.id);
          setTimeout(() => {
            if (destroyed) return;
            openedValidationIds.delete(acc.id);
            renderAccountList();
          }, 1800);
          onToast?.(
            copied
              ? `已尝试直接打开并复制 ${acc.email} 的验证链接`
              : `已尝试直接打开 ${acc.email} 的验证链接`,
            "info",
          );
          return;
        } catch {}
      }
      onToast?.(err?.message || "打开验证页面失败", "error");
    } finally {
      openingValidationIds.delete(acc.id);
      pulsingCardIds.delete(acc.id);
      renderQuotaSummaryCard();
      renderFilterBar();
      renderAccountList();
    }
  }

  async function handleCopyValidationUrl(acc, fallbackUrl = "") {
    if (!acc || !acc.id) return;
    triggerCardPulse(acc.id);
    try {
      const res = await requestJson("/api/accounts/open-validation-url", {
        method: "POST",
        body: JSON.stringify({
          accountId: acc.id,
          fallbackUrl: fallbackUrl || acc.accountStatus?.validationUrl || "",
          copyOnly: true,
        }),
      });
      if (res?.alreadyVerified && res.account) {
        const idx = state.accounts.findIndex((a) => a.id === acc.id);
        if (idx >= 0) state.accounts[idx] = res.account;
        renderAll();
        onToast?.(res.message || `${acc.email} 已完成验证，额度已恢复正常`, "success");
        return;
      }
      const targetUrl = res?.validationUrl || fallbackUrl || "";
      if (!targetUrl) {
        onToast?.("暂无可复制的验证链接", "error");
        return;
      }
      const copied = await copyTextToClipboard(targetUrl);
      if (!copied) {
        onToast?.("复制失败，请点击「去验证」直接打开或手动复制", "error");
        return;
      }
      pulsingCardIds.delete(acc.id);
      copiedValidationIds.add(acc.id);
      renderAccountList();
      setTimeout(() => {
        if (destroyed) return;
        copiedValidationIds.delete(acc.id);
        renderAccountList();
      }, 1800);
      onToast?.(`已复制 ${acc.email} 的验证链接，可粘贴到无痕窗口登录该邮箱完成验证`, "success");
    } catch (err) {
      onToast?.(err?.message || "复制验证链接失败", "error");
    }
  }

  async function handleRenewSingleAt(acc, { silentToast = false } = {}) {
    if (!acc || !acc.id || renewingAtIds.has(acc.id)) return { ok: false, skipped: true };
    renewingAtIds.add(acc.id);
    renderAccountList();
    try {
      const res = await requestJson("/api/accounts/renew-at", {
        method: "POST",
        body: JSON.stringify({ accountId: acc.id, forceRefresh: true }),
      });
      const idx = state.accounts.findIndex((a) => a.id === acc.id);
      if (idx >= 0 && res.account) {
        state.accounts[idx] = res.account;
      }
      if (!silentToast) {
        onToast?.(res.message || `已续签 ${acc.email} 的 AT`, "success");
      }
      return { ok: true, account: res.account || null };
    } catch (err) {
      const idx = state.accounts.findIndex((a) => a.id === acc.id);
      if (idx >= 0 && err?.data?.account) {
        state.accounts[idx] = err.data.account;
      }
      if (!silentToast) {
        onToast?.(err?.message || "续签 AT 失败", "error");
      }
      return { ok: false, error: err?.message || "续签 AT 失败", code: err?.data?.code || "" };
    } finally {
      renewingAtIds.delete(acc.id);
      renderQuotaSummaryCard();
      renderFilterBar();
      renderAccountList();
    }
  }

  async function handleBatchRenewAt() {
    if (batchRenewingAt || batchRefreshing) return;
    const nowMs = Date.now();
    const targets = getGroupFilteredAccounts().filter((a) => {
      if (!a || a.enabled === false) return false;
      const st = resolveAccountStatus(a, nowMs);
      return st.code === "AT_EXPIRED" && !st.blocking;
    });
    if (targets.length === 0) {
      onToast?.("当前没有需要续签 AT 的已启用账号", "info");
      return;
    }
    batchRenewingAt = true;
    let done = 0;
    let okCount = 0;
    let failCount = 0;
    renewAtProgressText = `续签 AT 0/${targets.length}`;
    renderFilterBar();

    try {
      // Strictly sequential OAuth-only AT refresh with 1s pacing (no CloudCode quota probe)
      for (let i = 0; i < targets.length && !destroyed; i += 1) {
        const acc = targets[i];
        const r = await handleRenewSingleAt(acc, { silentToast: true });
        done += 1;
        if (r?.ok) okCount += 1;
        else if (!r?.skipped) failCount += 1;
        renewAtProgressText = `续签 AT ${done}/${targets.length}`;
        renderFilterBar();
        if (i < targets.length - 1 && !destroyed) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      onToast?.(
        failCount > 0
          ? `AT 续签完成：${okCount} 个已刷新，${failCount} 个失败（已标出具体原因）`
          : `AT 续签完成：全部 ${okCount} 个账号已刷新有效`,
        failCount > 0 ? "info" : "success",
      );
    } finally {
      batchRenewingAt = false;
      renewAtProgressText = "";
      renderAll();
    }
  }

  async function handleBatchRefreshAll() {
    if (!quotaQueryEnabled || batchRefreshing || batchRenewingAt) return;
    const nowMs = Date.now();
    // Skip blocking abnormal accounts; under official active-only compliance, only refresh the live active account
    const targets = getGroupFilteredAccounts().filter(
      (a) =>
        a &&
        a.enabled !== false &&
        (!officialActiveOnly || a.isCurrent) &&
        !resolveAccountStatus(a, nowMs).blocking,
    );
    if (targets.length === 0) {
      onToast?.(
        officialActiveOnly
          ? "官方合规模式：仅同步当前登录账号额度，未激活账号切入后自动更新"
          : "暂无可安全检测的已启用账号（异常账号请单独处理）",
        "info",
      );
      return;
    }
    batchRefreshing = true;
    let done = 0;
    let okCount = 0;
    let failCount = 0;
    batchProgressText = `检测中 0/${targets.length}`;
    renderFilterBar();

    try {
      // Strictly sequential with 1.2s pacing between accounts to prevent burst risk-control triggers
      for (let i = 0; i < targets.length && !destroyed; i += 1) {
        const acc = targets[i];
        const r = await handleRefreshQuota(acc, { silentToast: true });
        done += 1;
        if (r?.ok) okCount += 1;
        else if (!r?.skipped) failCount += 1;
        batchProgressText = `检测中 ${done}/${targets.length}`;
        renderFilterBar();
        if (i < targets.length - 1 && !destroyed) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
      }
      onToast?.(
        failCount > 0
          ? `检测完成：${okCount} 个正常，${failCount} 个异常（已标出具体原因）`
          : `检测完成：全部 ${okCount} 个账号状态正常`,
        failCount > 0 ? "info" : "success",
      );
    } finally {
      batchRefreshing = false;
      batchProgressText = "";
      renderAll();
    }
  }

  async function handleDisableAbnormal() {
    try {
      const res = await requestJson("/api/accounts/disable-abnormal", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (Array.isArray(res.accounts)) {
        state.accounts = res.accounts;
      }
      renderAll();
      onToast?.(
        res.disabledCount > 0 ? `已一键禁用 ${res.disabledCount} 个异常账号` : "当前没有需要禁用的异常账号",
        res.disabledCount > 0 ? "success" : "info",
      );
    } catch (err) {
      onToast?.(err?.message || "禁用异常账号失败", "error");
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
    if (settingAutoToggleBtn && settingAutoToggleText) {
      settingAutoToggleBtn.classList.toggle("is-on", draftAutoSwitchEnabled);
      settingAutoToggleBtn.classList.toggle("is-off", !draftAutoSwitchEnabled);
      settingAutoToggleBtn.setAttribute("aria-pressed", String(draftAutoSwitchEnabled));
      settingAutoToggleText.textContent = draftAutoSwitchEnabled ? "已启用" : "已弃用";
    }
    if (settingBgInactiveToggleBtn && settingBgInactiveToggleText) {
      settingBgInactiveToggleBtn.classList.toggle("is-on", draftBgRefreshInactive);
      settingBgInactiveToggleBtn.classList.toggle("is-off", !draftBgRefreshInactive);
      settingBgInactiveToggleBtn.setAttribute("aria-pressed", String(draftBgRefreshInactive));
      settingBgInactiveToggleText.textContent = draftBgRefreshInactive ? "已启用" : "已关闭";
    }
  }

  function syncSettingsQuotaPausedUi() {
    if (settingsQuotaPausedNote) {
      settingsQuotaPausedNote.hidden = quotaQueryEnabled;
    }
    if (modals.settings) {
      modals.settings.querySelectorAll(".acc-setting-card").forEach((card) => {
        card.classList.toggle("is-quota-paused", !quotaQueryEnabled);
      });
    }
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
    draftBgRefreshInactive = Boolean(state.settings.backgroundRefreshInactive);
    renderSettingsAutoToggle();
    syncSettingsQuotaPausedUi();
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
          backgroundRefreshInactive: draftBgRefreshInactive,
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
    const visibleFields = getVisibleSortFields();
    if (visibleFields.length === 0) return;
    const curIdx = visibleFields.findIndex((f) => f.key === getEffectiveSortBy());
    const nextField = visibleFields[(curIdx + 1) % visibleFields.length];
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
  bindClick(settingBgInactiveToggleBtn, () => {
    draftBgRefreshInactive = !draftBgRefreshInactive;
    renderSettingsAutoToggle();
  });
  bindClick(settingsSaveBtn, () => void handleSaveSettings());
  bindClick(rollbackBtn, () => void handleRollbackBackup());
  bindClick(statusCancelBtn, () => void handleStatusBannerAction());
  bindClick(renewAtBtn, () => void handleBatchRenewAt());
  bindClick(batchRefreshBtn, () => void handleBatchRefreshAll());
  bindClick(disableAbnormalBtn, () => void handleDisableAbnormal());
  bindClick(addGroupToggleBtn, openAddGroupForm);
  bindClick(addGroupSubmitBtn, () => void handleAddGroupSubmit());
  bindClick(addGroupCancelBtn, closeAddGroupForm);

  if (addGroupInput) {
    const onGroupInputKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleAddGroupSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeAddGroupForm();
      }
    };
    addGroupInput.addEventListener("keydown", onGroupInputKey);
    cleanups.push(() => addGroupInput.removeEventListener("keydown", onGroupInputKey));
  }

  if (filterGroupEl) {
    const onFilterClick = (e) => {
      const pill = e.target?.closest?.("[data-acc-filter]");
      if (!pill) return;
      const nextFilter = pill.getAttribute("data-acc-filter") || "all";
      if (nextFilter === activeFilter) return;
      activeFilter = nextFilter;
      renderFilterBar();
      renderAccountList({ force: true });
    };
    filterGroupEl.addEventListener("click", onFilterClick);
    cleanups.push(() => filterGroupEl.removeEventListener("click", onFilterClick));
  }

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
    const copied = await copyTextToClipboard(activeExportPayload.jsonText);
    if (copied) {
      onToast?.("已复制账号 JSON 到剪贴板", "success");
    } else {
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
    renderAll({ force: true });
  }

  return {
    refresh,
    setQuotaEnabled(nextEnabled) {
      const normalized = nextEnabled !== false;
      quotaQueryEnabled = normalized;
      syncSettingsQuotaPausedUi();
      renderAll({ force: true });
    },
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
        pollIntervalMs = 0;
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
