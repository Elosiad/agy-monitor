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
import { createModelAndPrompt } from "./components/model_and_prompt.js";
import { createSessionsHub } from "./components/sessions_hub.js";
import { createRuntimeBar } from "./components/runtime_bar.js";
import { createMasteryHub } from "./components/mastery_hub.js";
import { createThemeStudio } from "./components/theme_studio.js";

const POLL_INTERVAL_MS = 1000;

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
  const manualRefreshBtn = document.getElementById("manualRefreshBtn");
  const toastBanner = document.getElementById("toastBanner");

  let translator = createTranslator("zh-CN");
  let toastTimer = null;
  let pollTimer = null;
  let snapshotInFlight = false;
  let pendingForcedRefresh = false;
  let destroyed = false;
  const cleanups = [];

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
      if (state.followLatest && hostConvId) {
        params.set("hostConvId", hostConvId);
      }
      if (syncHud) {
        params.set("syncHud", "1");
      }
      if (force) {
        params.set("force", "1");
      }
      const data = await fetchJson(`/api/snapshot?${params.toString()}`);
      if (destroyed) return;

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
        components.sessionsHub?.update(data.sessionsHub, nextConvId);
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
    t: translator,
    onFilterChange: ({ scope, range }) => {
      state.scope = scope || "current";
      state.range = range || "today";
      refreshSnapshot({ force: true });
    },
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

  if (manualRefreshBtn) {
    const onManualRefresh = () => {
      refreshPreferences();
      refreshSnapshot({ force: true, syncHud: true });
      components.masteryHub?.refresh?.();
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

  function startPolling() {
    if (pollTimer !== null || destroyed) return;
    pollTimer = setInterval(() => {
      if (!isPanelVisible()) return;
      refreshSnapshot({ force: false, syncHud: false });
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
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

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      releaseAutoSwitchLock();
      stopPolling();
    } else {
      releaseAutoSwitchLock();
      state.etag = "";
      refreshSnapshot({ force: false, syncHud: true });
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
        refreshSnapshot({ force: false, syncHud: true });
      }
    };
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    cleanups.push(() => window.removeEventListener("blur", onWindowBlur));
    cleanups.push(() => window.removeEventListener("focus", onWindowFocus));
  }

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
  ]).finally(() => {
    startPolling();
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
