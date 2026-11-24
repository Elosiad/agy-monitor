/**
 * Antigravity Monitor frontend entrypoint:
 * wires window.sidecar.fetch ETag polling, i18n switching, subnav tabs,
 * and all 6 UI components.
 */

import {
  applyDomI18n,
  createTranslator,
  normalizeLang,
  setLanguage as setGlobalLanguage,
} from "./i18n.js";
import { createContextPie } from "./components/context_pie.js";
import { createTokenUsage } from "./components/token_usage.js";
import { createQuotaCards } from "./components/quota_cards.js";
import { createModelAndPrompt } from "./components/model_and_prompt.js";
import { createSessionsHub } from "./components/sessions_hub.js";
import { createRuntimeBar } from "./components/runtime_bar.js";
import { createMasteryHub } from "./components/mastery_hub.js";
import { createAccountsHub } from "./components/accounts_hub.js";
import { createThemeStudio } from "./components/theme_studio.js";
import { createChangelogModal } from "./components/changelog_modal.js";

const POLL_ACTIVE_MS = 1200;
const POLL_IDLE_MS = 2500;

function resolveRequestUrl(url) {
  const raw = String(url || "");
  if (!raw.startsWith("/api/")) return raw;
  if (typeof window === "undefined") return raw;
  const pathname = window.location?.pathname || "";
  if (!pathname || pathname === "/" || pathname === "/index.html") {
    return raw;
  }
  const baseDir = pathname.endsWith("/") ? pathname : pathname.replace(/[^/]*$/, "");
  if (!baseDir || baseDir === "/") return raw;
  return `${baseDir}${raw.slice(1)}`;
}

function apiFetch(url, options = {}) {
  const targetUrl = resolveRequestUrl(url);
  if (typeof window !== "undefined" && window.sidecar && typeof window.sidecar.fetch === "function") {
    return window.sidecar.fetch(targetUrl, options);
  }
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!headers.has("x-sidecar-token") && typeof window !== "undefined" && window.location?.search) {
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) headers.set("x-sidecar-token", token);
  }
  return fetch(targetUrl, { ...options, headers });
}

async function fetchJson(url, options = {}) {
  const res = await apiFetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.reason || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function haveModelsChanged(prevList, nextList) {
  if (!Array.isArray(nextList)) return false;
  if (!Array.isArray(prevList) || prevList.length !== nextList.length) return true;
  for (let i = 0; i < nextList.length; i += 1) {
    if ((prevList[i]?.id || "") !== (nextList[i]?.id || "")) return true;
  }
  return false;
}

function findSessionTitle(sessionsHub, convId) {
  if (!sessionsHub || !convId) return "";
  const pools = [
    ...(Array.isArray(sessionsHub.active) ? sessionsHub.active : []),
    ...(Array.isArray(sessionsHub.unread) ? sessionsHub.unread : []),
    ...(Array.isArray(sessionsHub.recent) ? sessionsHub.recent : []),
    ...(Array.isArray(sessionsHub.favorites) ? sessionsHub.favorites : []),
    ...(Array.isArray(sessionsHub.allSelectable) ? sessionsHub.allSelectable : []),
  ];
  const matched = pools.find((item) => item && item.id === convId);
  return matched?.title ? String(matched.title) : "";
}

function initSubnavTabs(cleanups, onTabChange) {
  const tabs = document.querySelectorAll(".monitor-subnav .subnav-tab");
  const panels = document.querySelectorAll(".monitor-tab-panel[data-subnav-panel]");

  tabs.forEach((btn) => {
    const onTabClick = () => {
      const targetKey = btn.getAttribute("data-subnav");
      tabs.forEach((tab) => {
        const isCurrent = tab === btn;
        tab.classList.toggle("is-active", isCurrent);
        tab.setAttribute("aria-selected", String(isCurrent));
      });
      panels.forEach((panel) => {
        panel.hidden = panel.getAttribute("data-subnav-panel") !== targetKey;
      });
      onTabChange?.(targetKey);
    };
    btn.addEventListener("click", onTabClick);
    cleanups.push(() => btn.removeEventListener("click", onTabClick));
  });
}

let activeController = null;

/**
 * Mounts the Antigravity Monitor frontend controller once DOM is ready.
 */
export function mountMonitorApp() {
  if (activeController) return activeController;

  const followModeBtn = document.getElementById("followModeBtn");
  const followModeLabel = document.getElementById("followModeLabel");
  const activeConvChip = document.getElementById("activeConvChip");
  const activeConvNameEl = document.getElementById("activeConvName");
  const updateStatusBtn = document.getElementById("updateStatusBtn");
  const updateStatusLabel = document.getElementById("updateStatusLabel");
  const repoLinkBtn = document.getElementById("repoLinkBtn");
  const manualRefreshBtn = document.getElementById("manualRefreshBtn");
  const toastBanner = document.getElementById("toastBanner");

  let translator = createTranslator("zh-CN");
  let toastTimer = null;
  let updateCheckTimer = null;
  let pollTimer = null;
  let snapshotInFlight = false;
  let pendingForcedRefresh = false;
  let lastSyncedHostConvId = "";
  let destroyed = false;
  const cleanups = [];

  const updateState = {
    phase: "idle", // idle | checking | latest | available | updating | updated | error
    currentVersion: "1.1.1",
    remoteVersion: "",
    remoteSha: "",
    remoteMessage: "",
    hasUpdate: false,
    needsReload: false,
    error: "",
  };

  const state = {
    language: "zh-CN",
    followLatest: true,
    lockedConvId: "",
    autoLockedForSwitch: false,
    displayConvId: "",
    scope: "current",
    range: "today",
    etag: "",
    preferences: null,
    snapshot: null,
    configuredRulesTokens: 0,
  };

  function resolveConfiguredRulesTokens(prefs) {
    if (!prefs || !Array.isArray(prefs.prompts)) return state.configuredRulesTokens || 0;
    const active = prefs.prompts.find((p) => p && p.id === prefs.activePromptId);
    if (active && typeof active.tokens === "number") return active.tokens;
    return state.configuredRulesTokens || 0;
  }

  function showToast(message, level = "info") {
    if (!toastBanner || !message) return;
    clearTimeout(toastTimer);
    toastBanner.textContent = String(message);
    toastBanner.className = "toast-banner";
    if (level === "success") toastBanner.classList.add("is-success");
    if (level === "error") toastBanner.classList.add("is-error");
    toastBanner.hidden = false;
    toastTimer = setTimeout(() => {
      toastBanner.hidden = true;
    }, 2800);
  }

  function updateFollowModeUi() {
    if (!followModeBtn) return;
    const isFollowing = Boolean(state.followLatest);
    followModeBtn.classList.toggle("is-following", isFollowing);
    followModeBtn.classList.toggle("is-locked", !isFollowing);
    followModeBtn.setAttribute("aria-pressed", String(isFollowing));
    if (followModeLabel) {
      followModeLabel.textContent = translator(
        isFollowing ? "status.followLatest" : "status.lockedSession"
      );
    }
  }

  function updateActiveConvBadge(convIdOverride, titleOverride) {
    if (!activeConvNameEl) return;
    const convId =
      convIdOverride !== undefined
        ? convIdOverride
        : state.displayConvId || state.snapshot?.activeConvId || state.lockedConvId || "";
    const resolvedTitle =
      titleOverride || findSessionTitle(state.snapshot?.sessionsHub, convId);
    if (resolvedTitle) {
      activeConvNameEl.textContent = resolvedTitle;
      if (activeConvChip) activeConvChip.title = `${resolvedTitle} (${convId})`;
    } else if (convId) {
      activeConvNameEl.textContent = convId.slice(0, 8);
      if (activeConvChip) activeConvChip.title = convId;
    } else {
      activeConvNameEl.textContent = translator("status.noActiveConv");
      if (activeConvChip) activeConvChip.title = "";
    }
  }

  const components = {};

  initSubnavTabs(cleanups, (tabKey) => {
    components.masteryHub?.setTabActive?.(tabKey === "mastery");
    components.accountsHub?.setTabActive?.(tabKey === "accounts");
    if (tabKey === "theme") {
      components.themeStudio?.refreshBackdropStatus?.();
    }
  });
  applyDomI18n(document, translator);

  function applyLanguage(nextLang) {
    const normalized = normalizeLang(nextLang);
    state.language = normalized;
    setGlobalLanguage(normalized);
    translator.setLang(normalized);
    applyDomI18n(document, translator);

    Object.values(components).forEach((comp) => {
      if (comp && typeof comp.setTranslator === "function") {
        comp.setTranslator(translator);
      }
    });
    updateFollowModeUi();
    updateActiveConvBadge();
    renderUpdateButtonUi?.();
  }

  async function refreshPreferences() {
    try {
      const prefs = await fetchJson("/api/preferences");
      if (destroyed) return null;
      state.preferences = prefs;
      state.configuredRulesTokens = resolveConfiguredRulesTokens(prefs);
      components.contextPie?.setConfiguredRulesTokens?.(state.configuredRulesTokens);
      // AGY Console UI stays fixed in zh-CN; language setting exclusively controls Antigravity host UI via CDP.
      components.themeStudio?.update(prefs);
      components.modelAndPrompt?.update(prefs);
      const dispId = state.displayConvId || state.snapshot?.activeConvId || state.lockedConvId || "";
      components.runtimeBar?.update(state.snapshot?.runtimeTelemetry, {
        activeConvId: dispId,
        activeConvTitle: findSessionTitle(state.snapshot?.sessionsHub, dispId),
        followLatest: state.followLatest,
      });
      if (prefs.windowCap) {
        components.contextPie?.update(state.snapshot?.contextPie, prefs.windowCap, {
          configuredRulesTokens: state.configuredRulesTokens,
        });
      }
      return prefs;
    } catch {
      return null;
    }
  }

  async function refreshSnapshot({ force = false, syncHud = false } = {}) {
    if (destroyed) return;
    if (snapshotInFlight) {
      if (force) pendingForcedRefresh = true;
      return;
    }
    snapshotInFlight = true;
    if (force && manualRefreshBtn) {
      manualRefreshBtn.classList.add("is-spinning");
    }

    try {
      const requestedConvId = state.followLatest ? "" : state.lockedConvId || "";
      const hostConvId =
        typeof window !== "undefined"
          ? String(
              window.sidecar?.conversationId ||
                new URLSearchParams(window.location?.search || "").get("conversationId") ||
                ""
            ).trim()
          : "";
      const params = new URLSearchParams({
        convId: requestedConvId,
        scope: state.scope,
        range: state.range,
        etag: force ? "" : state.etag || "",
      });
      const effectiveSyncHud =
        syncHud ||
        Boolean(
          state.followLatest &&
            hostConvId &&
            hostConvId !== lastSyncedHostConvId &&
            isPanelVisible()
        );
      if (state.followLatest && hostConvId) {
        params.set("hostConvId", hostConvId);
      }
      if (effectiveSyncHud) {
        params.set("syncHud", "1");
        if (hostConvId) lastSyncedHostConvId = hostConvId;
      }
      if (force) {
        params.set("force", "1");
      }
      const data = await fetchJson(`/api/snapshot?${params.toString()}`);
      if (destroyed) return;
      // Discard stale poll response when user already changed scope/range/session while request was in flight
      if (pendingForcedRefresh) return;

      if (data && !data.unchanged) {
        const nextConvId = String(
          data.activeConvId || (!state.followLatest ? state.lockedConvId : "")
        );

        if (
          Array.isArray(data.availableModels) &&
          haveModelsChanged(state.preferences?.availableModels, data.availableModels)
        ) {
          if (state.preferences) {
            state.preferences.availableModels = data.availableModels;
          }
          components.modelAndPrompt?.update({ availableModels: data.availableModels });
        }

        const effectiveCap =
          data.contextPie?.windowCap || state.preferences?.windowCap || 512000;

        components.contextPie?.update(data.contextPie, effectiveCap, {
          configuredRulesTokens: state.configuredRulesTokens,
        });
        components.tokenUsage?.update(data.tokenUsage);
        components.quotaCards?.notifyTokenActivity?.(data.tokenUsage?.totalTokens);
        components.sessionsHub?.update(data.sessionsHub, nextConvId);
        lastKnownActiveCount = Array.isArray(data.sessionsHub?.active)
          ? data.sessionsHub.active.length
          : 0;
        components.runtimeBar?.update(data.runtimeTelemetry, {
          activeConvId: nextConvId,
          activeConvTitle: findSessionTitle(data.sessionsHub, nextConvId),
          followLatest: state.followLatest,
        });
        state.snapshot = data;
        state.etag = String(data.etag || "");
        // Keep Follow Latest unpinned across polls unless user explicitly locked a conversation
        state.displayConvId = nextConvId;
        updateFollowModeUi();
        updateActiveConvBadge(state.displayConvId);
      }
    } catch (err) {
      if (activeConvNameEl && !state.snapshot) {
        const offlineText = translator("status.offline");
        const reason = err?.message ? String(err.message).slice(0, 36) : "";
        activeConvNameEl.textContent = reason ? `${offlineText} (${reason})` : offlineText;
        if (activeConvChip) {
          activeConvChip.title = err?.message ? String(err.message) : offlineText;
        }
      }
    } finally {
      snapshotInFlight = false;
      if (manualRefreshBtn) {
        manualRefreshBtn.classList.remove("is-spinning");
      }
      if (pendingForcedRefresh && !destroyed) {
        pendingForcedRefresh = false;
        refreshSnapshot({ force: true });
      }
    }
  }

  components.contextPie = createContextPie({
    apiFetch,
    t: translator,
    onWindowCapChange: (nextCap) => {
      if (state.preferences) {
        state.preferences.windowCap = nextCap;
      }
      refreshSnapshot({ force: true });
    },
    onToast: showToast,
  });

  components.tokenUsage = createTokenUsage({
    apiFetch,
    t: translator,
    getActiveConvContext: () => ({
      convId: state.followLatest
        ? state.displayConvId || state.snapshot?.activeConvId || ""
        : state.lockedConvId || state.displayConvId || "",
      hostConvId:
        typeof window !== "undefined" && window.sidecar?.conversationId
          ? String(window.sidecar.conversationId).trim()
          : "",
      convTitle: activeConvNameEl ? activeConvNameEl.textContent.trim() : "",
    }),
    onFilterChange: ({ scope, range }) => {
      state.scope = scope || "current";
      state.range = range || "today";
      refreshSnapshot({ force: true });
    },
    onToast: showToast,
  });

  components.quotaCards = createQuotaCards({
    apiFetch,
    t: translator,
  });

  components.modelAndPrompt = createModelAndPrompt({
    apiFetch,
    t: translator,
    onModelChanged: (defaultModel) => {
      if (state.preferences && defaultModel) {
        state.preferences.defaultModel = defaultModel;
      }
      refreshSnapshot({ force: true });
    },
    onSessionCreated: (resp) => {
      if (resp?.conversationId) {
        state.followLatest = false;
        state.lockedConvId = String(resp.conversationId);
        state.displayConvId = state.lockedConvId;
        updateFollowModeUi();
        updateActiveConvBadge(state.lockedConvId);
      }
      refreshSnapshot({ force: true });
    },
    onPromptChanged: async (resp) => {
      if (typeof resp?.rulesTokens === "number") {
        state.configuredRulesTokens = resp.rulesTokens;
        components.contextPie?.setConfiguredRulesTokens?.(resp.rulesTokens);
      }
      await refreshPreferences();
      if (resp?.rulesTokens !== undefined && state.snapshot?.contextPie?.segments) {
        state.snapshot.contextPie.segments.rulesAddon = resp.rulesTokens;
      }
      refreshSnapshot({ force: true });
    },
    onToast: showToast,
  });

  const handleConversationSelected = (session) => {
    const nextId = typeof session === "string" ? session : session?.id;
    if (!nextId) return;
    state.followLatest = false;
    state.lockedConvId = String(nextId);
    state.autoLockedForSwitch = true;
    state.displayConvId = state.lockedConvId;
    updateFollowModeUi();
    updateActiveConvBadge(state.lockedConvId, session?.title);
    refreshSnapshot({ force: true });
  };

  components.sessionsHub = createSessionsHub({
    apiFetch,
    t: translator,
    onSelectConversation: handleConversationSelected,
    onFavoritesChanged: () => {
      refreshSnapshot({ force: true });
      components.masteryHub?.refresh?.({ force: true });
    },
    onMarkRead: () => {
      refreshSnapshot({ force: true });
    },
    onToast: showToast,
  });

  components.runtimeBar = createRuntimeBar({
    t: translator,
  });

  components.masteryHub = createMasteryHub({
    apiFetch,
    onSelectConversation: handleConversationSelected,
    onFavoritesChanged: () => {
      refreshSnapshot({ force: true });
    },
    onToast: showToast,
  });

  components.accountsHub = createAccountsHub({
    apiFetch,
    onToast: showToast,
  });

  components.themeStudio = createThemeStudio({
    apiFetch,
    t: translator,
    onThemeApplied: (themePayload) => {
      if (state.preferences) {
        state.preferences.themeState = themePayload;
      }
    },
    onLanguageChange: () => {
      // Language selector switches Antigravity host UI only; AGY Console stays fixed in Simplified Chinese.
    },
    onToast: showToast,
  });

  components.changelogModal = createChangelogModal({
    apiFetch,
    t: translator,
    initialVersion: updateState.currentVersion,
    onToast: showToast,
    onVersionApplied: (res) => {
      if (!res || !res.ok) return;
      updateState.currentVersion = String(res.version || updateState.currentVersion);
      if (res.status?.remoteVersion) {
        updateState.remoteVersion = String(res.status.remoteVersion);
      }
      updateState.remoteSha = String(res.shortSha || updateState.remoteSha || "");
      updateState.hasUpdate = Boolean(res.status?.hasUpdate);
      updateState.needsReload = true;
      updateState.phase = "updated";
      renderUpdateButtonUi();
    },
  });

  // Sync initial filter state from tokenUsage DOM
  const initialFilter = components.tokenUsage.getFilter?.();
  if (initialFilter) {
    state.scope = initialFilter.scope || "current";
    state.range = initialFilter.range || "today";
  }

  updateFollowModeUi();

  if (followModeBtn) {
    const onFollowToggle = () => {
      state.autoLockedForSwitch = false;
      if (state.followLatest) {
        const lockTarget =
          state.displayConvId ||
          state.snapshot?.activeConvId ||
          (typeof window !== "undefined" ? String(window.sidecar?.conversationId || "") : "");
        if (!lockTarget) return;
        state.followLatest = false;
        state.lockedConvId = String(lockTarget);
        state.displayConvId = state.lockedConvId;
      } else {
        state.followLatest = true;
        state.lockedConvId = "";
      }
      updateFollowModeUi();
      refreshSnapshot({ force: true });
    };
    followModeBtn.addEventListener("click", onFollowToggle);
    cleanups.push(() => followModeBtn.removeEventListener("click", onFollowToggle));
  }

  function renderUpdateButtonUi() {
    if (!updateStatusBtn || !updateStatusLabel) return;
    updateStatusBtn.classList.remove("is-latest", "is-available", "is-updating", "is-updated");
    updateStatusBtn.disabled = updateState.phase === "checking" || updateState.phase === "updating";

    if (updateState.phase === "checking") {
      updateStatusLabel.textContent = translator("nav.updateChecking");
      updateStatusBtn.title = "正在连接 GitHub 检测最新版本…";
    } else if (updateState.phase === "updating") {
      updateStatusBtn.classList.add("is-updating");
      updateStatusLabel.textContent = translator("nav.updating");
      updateStatusBtn.title = "正在从 GitHub 下载并部署最新版本…";
    } else if (updateState.phase === "updated") {
      updateStatusBtn.classList.add("is-updated");
      updateStatusLabel.textContent = translator("nav.updatedReload");
      updateStatusBtn.title = `已更新至 v${updateState.currentVersion}${updateState.remoteSha ? ` (${updateState.remoteSha})` : ""}，点击重载面板（或重启 Antigravity 加载新版后端）`;
    } else if (updateState.phase === "available" && updateState.hasUpdate) {
      updateStatusBtn.classList.add("is-available");
      updateStatusLabel.textContent = translator("nav.updateAvailable");
      const summary = updateState.remoteMessage ? `\n最新提交：${updateState.remoteMessage}` : "";
      const verHint = updateState.remoteSha ? ` (${updateState.remoteSha})` : "";
      updateStatusBtn.title = `发现新版本 v${updateState.remoteVersion || updateState.currentVersion}${verHint}，点击一键更新！${summary}`;
    } else if (updateState.phase === "latest") {
      updateStatusBtn.classList.add("is-latest");
      updateStatusLabel.textContent = translator("nav.updateLatest");
      updateStatusBtn.title = `当前已是最新版本 v${updateState.currentVersion}${updateState.remoteSha ? ` (${updateState.remoteSha})` : ""}（点击重新检测）`;
    } else {
      updateStatusLabel.textContent = translator("nav.updateCheck");
      updateStatusBtn.title = updateState.error || "点击检测 GitHub 是否有新版本";
    }
  }

  async function checkPluginUpdate({ force = false, notify = false } = {}) {
    if (destroyed || updateState.phase === "updating" || updateState.phase === "checking") return;
    updateState.phase = "checking";
    updateState.error = "";
    renderUpdateButtonUi();

    try {
      const data = await fetchJson(`/api/update/status${force ? "?force=1" : ""}`);
      if (destroyed) return;
      if (data && data.ok) {
        updateState.currentVersion = String(data.currentVersion || "1.1.1");
        components.changelogModal?.setCurrentVersion?.(updateState.currentVersion);
        updateState.remoteVersion = String(data.remoteVersion || updateState.currentVersion);
        updateState.remoteSha = String(data.remoteSha || "");
        updateState.remoteMessage = String(data.remoteMessage || "");
        updateState.hasUpdate = Boolean(data.hasUpdate);
        updateState.phase = updateState.hasUpdate ? "available" : "latest";
        updateState.error = "";
        renderUpdateButtonUi();
        if (notify) {
          if (updateState.hasUpdate) {
            showToast(
              `发现新版本 (${updateState.remoteSha || updateState.remoteVersion})，再次点击「有更新」即可一键更新`,
              "success"
            );
          } else {
            showToast(`当前已是最新版本 v${updateState.currentVersion}`, "success");
          }
        }
      } else {
        updateState.hasUpdate = false;
        updateState.phase = "error";
        updateState.error = String(data?.error || "检测更新失败，点击重试");
        renderUpdateButtonUi();
        if (notify) showToast(updateState.error, "error");
      }
    } catch {
      if (destroyed) return;
      updateState.hasUpdate = false;
      updateState.phase = "error";
      updateState.error = "无法连接更新服务，点击重试";
      renderUpdateButtonUi();
      if (notify) showToast(updateState.error, "error");
    }
  }

  async function applyPluginUpdateNow() {
    if (destroyed || updateState.phase === "updating") return;
    updateState.phase = "updating";
    renderUpdateButtonUi();
    showToast("正在从 GitHub 下载并部署最新版本…", "info");

    try {
      const res = await fetchJson("/api/update/apply", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (destroyed) return;
      if (res && res.ok) {
        updateState.currentVersion = String(res.version || updateState.remoteVersion || updateState.currentVersion);
        components.changelogModal?.setCurrentVersion?.(updateState.currentVersion);
        updateState.remoteSha = String(res.shortSha || updateState.remoteSha || "");
        updateState.hasUpdate = false;
        updateState.needsReload = true;
        updateState.phase = "updated";
        renderUpdateButtonUi();
        showToast(
          `更新成功 (${updateState.remoteSha || `v${updateState.currentVersion}`})！已保留全部配置，请重载插件或重启 Antigravity 生效`,
          "success"
        );
      } else {
        updateState.phase = "available";
        renderUpdateButtonUi();
        showToast(res?.error || "自动更新失败，请稍后重试", "error");
      }
    } catch (err) {
      if (destroyed) return;
      updateState.phase = "available";
      renderUpdateButtonUi();
      showToast(err?.message || "自动更新失败，请检查网络连接", "error");
    }
  }

  if (updateStatusBtn) {
    const onUpdateClick = () => {
      if (updateState.phase === "checking" || updateState.phase === "updating") return;
      if (updateState.phase === "available" && updateState.hasUpdate) {
        void applyPluginUpdateNow();
      } else if (updateState.phase === "updated" && updateState.needsReload) {
        if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
          window.location.reload();
        }
      } else {
        void checkPluginUpdate({ force: true, notify: true });
      }
    };
    updateStatusBtn.addEventListener("click", onUpdateClick);
    cleanups.push(() => updateStatusBtn.removeEventListener("click", onUpdateClick));
  }

  if (repoLinkBtn) {
    const onRepoClick = (e) => {
      e.preventDefault();
      void fetchJson("/api/update/open-repo", {
        method: "POST",
        body: JSON.stringify({}),
      }).catch(() => {
        if (typeof window !== "undefined" && typeof window.open === "function") {
          window.open(repoLinkBtn.href, "_blank", "noopener,noreferrer");
        }
      });
    };
    repoLinkBtn.addEventListener("click", onRepoClick);
    cleanups.push(() => repoLinkBtn.removeEventListener("click", onRepoClick));
  }

  if (manualRefreshBtn) {
    const onManualRefresh = () => {
      refreshPreferences();
      refreshSnapshot({ force: true, syncHud: true });
      components.quotaCards?.refresh?.({ force: true });
      components.masteryHub?.refresh?.();
      components.accountsHub?.refresh?.({ silent: true });
    };
    manualRefreshBtn.addEventListener("click", onManualRefresh);
    cleanups.push(() => manualRefreshBtn.removeEventListener("click", onManualRefresh));
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const onWindowMessage = (event) => {
      if (event?.data?.type === "theme-change") {
        components.themeStudio?.applyHostTheme?.(event.data?.payload?.cssVariables);
      }
    };
    window.addEventListener("message", onWindowMessage);
    cleanups.push(() => window.removeEventListener("message", onWindowMessage));
  }

  if (typeof window !== "undefined" && window.sidecar && typeof window.sidecar.onWorkspaceChange === "function") {
    window.sidecar.onWorkspaceChange(() => {
      refreshSnapshot({ force: true });
    });
  }

  function isPanelVisible() {
    if (typeof document === "undefined") return true;
    if (document.visibilityState === "hidden") return false;
    if (typeof window !== "undefined") {
      if (typeof window.innerWidth === "number" && typeof window.innerHeight === "number") {
        if (window.innerWidth < 10 || window.innerHeight < 10) return false;
      }
    }
    return true;
  }

  let lastKnownActiveCount = 1;
  let currentPollDelayMs = POLL_ACTIVE_MS;

  function scheduleNextPoll() {
    if (destroyed) return;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    const nextMs = lastKnownActiveCount > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    currentPollDelayMs = nextMs;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (destroyed) return;
      if (!isPanelVisible()) {
        scheduleNextPoll();
        return;
      }
      Promise.resolve(refreshSnapshot({ force: false, syncHud: false })).finally(() => {
        scheduleNextPoll();
      });
    }, nextMs);
  }

  function startPolling() {
    if (pollTimer !== null || destroyed) return;
    scheduleNextPoll();
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function releaseAutoSwitchLock() {
    if (!state.autoLockedForSwitch) return;
    state.autoLockedForSwitch = false;
    state.followLatest = true;
    state.lockedConvId = "";
    state.etag = "";
    updateFollowModeUi();
  }

  const paneViewportId = `vp_${Math.random().toString(36).slice(2, 10)}`;
  let viewportReportTimer = null;
  let viewportHeartbeatTimer = null;
  let lastReportedPhysW = -1;
  let lastReportedVisible = null;

  function readConsoleViewport() {
    if (typeof window === "undefined") {
      return { visible: false, physW: 0, physH: 0, outerW: 0 };
    }
    const vis =
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      (Number(window.innerWidth) || 0) > 0 &&
      (Number(window.innerHeight) || 0) > 0;
    if (!vis) {
      return { visible: false, physW: 0, physH: 0, outerW: 0 };
    }
    const dpr = Math.max(0.5, Math.min(4, Number(window.devicePixelRatio) || 1));
    return {
      visible: true,
      physW: Math.round((Number(window.innerWidth) || 0) * dpr),
      physH: Math.round((Number(window.innerHeight) || 0) * dpr),
      outerW: Math.round((Number(window.outerWidth) || 0) * dpr),
    };
  }

  function isFullscreenConsoleViewport(vp) {
    if (!vp || !vp.visible || !vp.physW) return false;
    if (vp.outerW > 0) {
      return vp.physW >= Math.round(vp.outerW * 0.60);
    }
    return vp.physW >= 1100;
  }

  function syncViewportHeartbeat(vp) {
    if (destroyed) return;
    const needHeartbeat = isFullscreenConsoleViewport(vp);
    if (needHeartbeat && !viewportHeartbeatTimer) {
      viewportHeartbeatTimer = setInterval(() => {
        if (destroyed) return;
        sendConsoleViewport({ force: true });
      }, 3600);
    } else if (!needHeartbeat && viewportHeartbeatTimer) {
      clearInterval(viewportHeartbeatTimer);
      viewportHeartbeatTimer = null;
    }
  }

  function sendConsoleViewport({ force = false, forceHidden = false } = {}) {
    if (destroyed || typeof apiFetch !== "function") return;
    const rawVp = forceHidden
      ? { visible: false, physW: 0, physH: 0, outerW: 0 }
      : readConsoleViewport();
    const isFullCover = isFullscreenConsoleViewport(rawVp);
    const vp = isFullCover ? rawVp : { visible: false, physW: 0, physH: 0, outerW: rawVp.outerW || 0 };
    syncViewportHeartbeat(vp);
    if (!vp.visible && !lastReportedVisible) {
      return;
    }
    if (
      !force &&
      vp.visible === lastReportedVisible &&
      Math.abs(vp.physW - lastReportedPhysW) < 4
    ) {
      return;
    }
    lastReportedVisible = vp.visible;
    lastReportedPhysW = vp.physW;
    Promise.resolve(
      apiFetch("/api/hud/console-viewport", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paneId: paneViewportId,
          visible: vp.visible,
          physW: vp.physW,
          physH: vp.physH,
          outerW: vp.outerW,
        }),
      })
    ).catch(() => {});
  }

  function scheduleConsoleViewportReport() {
    if (destroyed) return;
    if (viewportReportTimer) clearTimeout(viewportReportTimer);
    viewportReportTimer = setTimeout(() => {
      viewportReportTimer = null;
      sendConsoleViewport({ force: false });
    }, 32);
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      releaseAutoSwitchLock();
      stopPolling();
      sendConsoleViewport({ force: true, forceHidden: true });
    } else {
      releaseAutoSwitchLock();
      state.etag = "";
      sendConsoleViewport({ force: true });
      refreshSnapshot({ force: false, syncHud: true });
      components.quotaCards?.refresh?.({ force: false });
      startPolling();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const onWindowBlur = () => {
      releaseAutoSwitchLock();
    };
    const onWindowFocus = () => {
      releaseAutoSwitchLock();
      if (isPanelVisible()) {
        state.etag = "";
        sendConsoleViewport({ force: false });
        refreshSnapshot({ force: false, syncHud: true });
        components.quotaCards?.refresh?.({ force: false });
      }
    };
    const onWindowResize = () => {
      scheduleConsoleViewportReport();
    };
    const onWindowHide = () => {
      sendConsoleViewport({ force: true, forceHidden: true });
    };
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("resize", onWindowResize, { passive: true });
    window.addEventListener("pagehide", onWindowHide);
    window.addEventListener("beforeunload", onWindowHide);
    cleanups.push(() => window.removeEventListener("blur", onWindowBlur));
    cleanups.push(() => window.removeEventListener("focus", onWindowFocus));
    cleanups.push(() => window.removeEventListener("resize", onWindowResize));
    cleanups.push(() => window.removeEventListener("pagehide", onWindowHide));
    cleanups.push(() => window.removeEventListener("beforeunload", onWindowHide));
  }
  if (typeof ResizeObserver === "function" && typeof document !== "undefined" && document.documentElement) {
    const vpRo = new ResizeObserver(() => scheduleConsoleViewportReport());
    vpRo.observe(document.documentElement);
    cleanups.push(() => vpRo.disconnect());
  }
  sendConsoleViewport({ force: true });

  const auxPaneShell = document.getElementById("auxPaneShell");
  if (auxPaneShell && typeof auxPaneShell.addEventListener === "function") {
    let lastHoverSyncAt = 0;
    const onPaneEnter = () => {
      if (!isPanelVisible()) return;
      const now = Date.now();
      if (now - lastHoverSyncAt < 800) return;
      lastHoverSyncAt = now;
      refreshSnapshot({ force: false, syncHud: true });
    };
    auxPaneShell.addEventListener("pointerenter", onPaneEnter);
    cleanups.push(() => auxPaneShell.removeEventListener("pointerenter", onPaneEnter));
  }

  // Initial load & start polling
  if (typeof window !== "undefined") {
    window.__agyMonitorMounted = true;
  }
  const readyPromise = Promise.all([
    refreshPreferences(),
    refreshSnapshot({ force: true, syncHud: true }),
    components.quotaCards?.refresh?.({ force: false }),
  ]).finally(() => {
    startPolling();
    if (!destroyed && updateStatusBtn) {
      updateCheckTimer = setTimeout(() => {
        if (!destroyed) {
          void checkPluginUpdate({ force: false, notify: false });
          void components.accountsHub?.refresh?.({ silent: true });
        }
      }, 1200);
    }
  });

  activeController = {
    state,
    components,
    readyPromise,
    refreshPreferences,
    refreshSnapshot,
    applyLanguage,
    destroy() {
      destroyed = true;
      stopPolling();
      clearTimeout(toastTimer);
      clearTimeout(updateCheckTimer);
      clearTimeout(viewportReportTimer);
      clearInterval(viewportHeartbeatTimer);
      viewportHeartbeatTimer = null;
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
      Object.values(components).forEach((comp) => comp?.destroy?.());
      activeController = null;
    },
  };
  return activeController;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountMonitorApp, { once: true });
  } else {
    mountMonitorApp();
  }
}
