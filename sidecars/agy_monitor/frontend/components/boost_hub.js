/**
 * "增强" (Boost) Tab Hub:
 * - Three independent opt-in AI acceleration toggles (ALL OFF by default):
 *   1. batchOps      ("打包合并做")
 *   2. compactOutput ("压输出砍废话")
 *   3. outlineFirst  ("先目录再精读")
 * - Top bar with one-click Enable All / Disable All buttons.
 * - Each row stays ultra-clean (<= 30 chars) with a dedicated small info button:
 *   hover -> side mini preview card; click -> fullscreen detail modal (<= 100 chars).
 */

export const BOOST_ITEMS = Object.freeze([
  Object.freeze({
    key: "batchOps",
    title: "打包合并做",
    shortDesc: "批量搜代码、改文件并顺手跑测试",
    intro:
      "启用后为 AI 提供批量搜索、多文件原子编辑与并发检查工具。AI 一次调用就能同时查多处代码、改多个文件并顺手校验，减少来回轮次，更快更省额度。",
  }),
  Object.freeze({
    key: "compactOutput",
    title: "压输出砍废话",
    shortDesc: "折叠日志限 8.8KB，只留报错重点",
    intro:
      "启用后自动剥离终端乱码与冗余过程日志，把输出严格折叠在 8.8KB 以内，只保留首尾关键报错与摘要。防止大段日志撑爆上下文，也避免触发额外轮次。",
  }),
  Object.freeze({
    key: "outlineFirst",
    title: "先目录再精读",
    shortDesc: "先扫函数大纲，不硬塞整文件",
    intro:
      "启用后为 AI 提供多语言符号大纲与按行切片工具。读大文件前先扫描函数、类与配置行号目录，再只读目标片段，不整文件硬塞，省额度又保缓存命中。",
  }),
]);

const BOOST_ITEM_BY_KEY = new Map(BOOST_ITEMS.map((item) => [item.key, item]));

export function createBoostHub({ apiFetch, onBoostChange, onToast } = {}) {
  const panelEl = document.getElementById("panelBoost");
  const countBadgeEl = document.getElementById("boostCountBadge");
  const enableAllBtn = document.getElementById("boostEnableAllBtn");
  const disableAllBtn = document.getElementById("boostDisableAllBtn");
  const hoverCardEl = document.getElementById("boostHoverCard");
  const hoverTitleEl = document.getElementById("boostHoverTitle");
  const hoverTextEl = document.getElementById("boostHoverText");
  const modalEl = document.getElementById("boostDetailModal");
  const modalTitleEl = document.getElementById("boostDetailTitle");
  const modalStatusEl = document.getElementById("boostDetailStatus");
  const modalTextEl = document.getElementById("boostDetailText");
  const modalToggleBtn = document.getElementById("boostDetailToggleBtn");
  const modalCloseBtn = document.getElementById("boostDetailCloseBtn");

  const state = {
    boost: {
      batchOps: false,
      compactOutput: false,
      outlineFirst: false,
    },
    busy: false,
    hoveredKey: "",
    modalKey: "",
  };

  let hoverHideTimer = null;
  let destroyed = false;
  const cleanups = [];

  async function postBoost(payload) {
    const res = await apiFetch("/api/preferences/boost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function countEnabled() {
    let n = 0;
    for (const item of BOOST_ITEMS) {
      if (state.boost[item.key]) n += 1;
    }
    return n;
  }

  function render() {
    const enabledCount = countEnabled();
    const total = BOOST_ITEMS.length;

    if (countBadgeEl) {
      countBadgeEl.textContent = `${enabledCount}/${total}`;
      countBadgeEl.className = `other-status-pill ${enabledCount > 0 ? "is-on" : "is-muted"}`;
    }

    if (enableAllBtn) {
      enableAllBtn.disabled = state.busy || enabledCount === total;
    }
    if (disableAllBtn) {
      disableAllBtn.disabled = state.busy || enabledCount === 0;
    }

    if (panelEl) {
      panelEl.querySelectorAll("[data-boost-toggle]").forEach((input) => {
        const key = input.getAttribute("data-boost-toggle");
        const on = Boolean(state.boost[key]);
        input.checked = on;
        input.disabled = state.busy;
        input.setAttribute("aria-checked", String(on));
        const row = input.closest?.(".boost-row");
        if (row) row.classList.toggle("is-enabled", on);
      });
    }

    if (state.modalKey && modalEl && !modalEl.hidden) {
      renderModalContent(state.modalKey);
    }
  }

  function renderModalContent(key) {
    const item = BOOST_ITEM_BY_KEY.get(key);
    if (!item) return;
    const on = Boolean(state.boost[key]);
    if (modalTitleEl) modalTitleEl.textContent = item.title;
    if (modalTextEl) modalTextEl.textContent = item.intro;
    if (modalStatusEl) {
      modalStatusEl.textContent = on ? "已启用" : "已关闭";
      modalStatusEl.className = `other-status-pill ${on ? "is-on" : "is-muted"}`;
    }
    if (modalToggleBtn) {
      modalToggleBtn.disabled = state.busy;
      modalToggleBtn.textContent = on ? "关闭此功能" : "立即启用";
      modalToggleBtn.classList.toggle("is-primary", !on);
    }
  }

  function hideHoverCardImmediate() {
    if (hoverHideTimer) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }
    state.hoveredKey = "";
    if (hoverCardEl) hoverCardEl.hidden = true;
  }

  function scheduleHideHoverCard() {
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => {
      hoverHideTimer = null;
      state.hoveredKey = "";
      if (hoverCardEl) hoverCardEl.hidden = true;
    }, 120);
  }

  function positionHoverCard(anchorEl) {
    if (!hoverCardEl || !anchorEl || typeof anchorEl.getBoundingClientRect !== "function") return;
    const rect = anchorEl.getBoundingClientRect();
    const vw = typeof window !== "undefined" ? window.innerWidth || 380 : 380;
    const vh = typeof window !== "undefined" ? window.innerHeight || 640 : 640;
    const cardW = Math.min(236, Math.max(176, vw - 24));
    hoverCardEl.style.width = `${cardW}px`;

    // Prefer placing cleanly to the left of the info button (or below if narrow)
    let left = rect.left - cardW - 8;
    let top = rect.top - 6;
    if (left < 10) {
      left = Math.max(10, Math.min(vw - cardW - 10, rect.right - cardW));
      top = rect.bottom + 6;
    }
    const estH = hoverCardEl.offsetHeight || 110;
    if (top + estH > vh - 10) {
      top = Math.max(10, vh - estH - 10);
    }
    hoverCardEl.style.left = `${Math.round(left)}px`;
    hoverCardEl.style.top = `${Math.round(top)}px`;
  }

  function showHoverCard(key, anchorEl) {
    if (destroyed || !hoverCardEl) return;
    if (modalEl && !modalEl.hidden) return;
    const item = BOOST_ITEM_BY_KEY.get(key);
    if (!item) return;
    if (hoverHideTimer) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }
    state.hoveredKey = key;
    if (hoverTitleEl) hoverTitleEl.textContent = item.title;
    if (hoverTextEl) hoverTextEl.textContent = item.intro;
    hoverCardEl.hidden = false;
    positionHoverCard(anchorEl);
  }

  function openFullscreenModal(key) {
    const item = BOOST_ITEM_BY_KEY.get(key);
    if (!item || !modalEl) return;
    hideHoverCardImmediate();
    state.modalKey = key;
    renderModalContent(key);
    modalEl.hidden = false;
  }

  function closeFullscreenModal() {
    state.modalKey = "";
    if (modalEl) modalEl.hidden = true;
  }

  async function applyBoostPatch(payload, toastMessage) {
    if (state.busy || destroyed) return;
    const prev = { ...state.boost };
    if (typeof payload.all === "boolean") {
      state.boost = {
        batchOps: payload.all,
        compactOutput: payload.all,
        outlineFirst: payload.all,
      };
    } else {
      state.boost = { ...state.boost, ...payload };
    }
    state.busy = true;
    render();

    try {
      const res = await postBoost(payload);
      if (destroyed) return;
      if (res?.boost && typeof res.boost === "object") {
        state.boost = {
          batchOps: res.boost.batchOps === true,
          compactOutput: res.boost.compactOutput === true,
          outlineFirst: res.boost.outlineFirst === true,
        };
      }
      onBoostChange?.(state.boost, res);
      if (toastMessage) onToast?.(toastMessage, "success");
    } catch (err) {
      if (destroyed) return;
      state.boost = prev;
      onToast?.(err?.message || "保存增强设置失败", "error");
    } finally {
      state.busy = false;
      render();
    }
  }

  if (enableAllBtn) {
    const onEnableAll = () => void applyBoostPatch({ all: true }, "已启用全部 3 项增强功能");
    enableAllBtn.addEventListener("click", onEnableAll);
    cleanups.push(() => enableAllBtn.removeEventListener("click", onEnableAll));
  }

  if (disableAllBtn) {
    const onDisableAll = () => void applyBoostPatch({ all: false }, "已关闭全部增强功能");
    disableAllBtn.addEventListener("click", onDisableAll);
    cleanups.push(() => disableAllBtn.removeEventListener("click", onDisableAll));
  }

  if (panelEl) {
    panelEl.querySelectorAll("[data-boost-toggle]").forEach((input) => {
      const key = input.getAttribute("data-boost-toggle");
      const item = BOOST_ITEM_BY_KEY.get(key);
      const onChange = () => {
        const nextVal = Boolean(input.checked);
        void applyBoostPatch(
          { [key]: nextVal },
          nextVal ? `已开启「${item?.title || key}」` : `已关闭「${item?.title || key}」`
        );
      };
      input.addEventListener("change", onChange);
      cleanups.push(() => input.removeEventListener("change", onChange));
    });

    panelEl.querySelectorAll("[data-boost-info]").forEach((btn) => {
      const key = btn.getAttribute("data-boost-info");
      const onEnter = () => showHoverCard(key, btn);
      const onLeave = () => scheduleHideHoverCard();
      const onClick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openFullscreenModal(key);
      };
      btn.addEventListener("mouseenter", onEnter);
      btn.addEventListener("focus", onEnter);
      btn.addEventListener("mouseleave", onLeave);
      btn.addEventListener("blur", onLeave);
      btn.addEventListener("click", onClick);
      cleanups.push(() => {
        btn.removeEventListener("mouseenter", onEnter);
        btn.removeEventListener("focus", onEnter);
        btn.removeEventListener("mouseleave", onLeave);
        btn.removeEventListener("blur", onLeave);
        btn.removeEventListener("click", onClick);
      });
    });
  }

  if (hoverCardEl) {
    const onCardEnter = () => {
      if (hoverHideTimer) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
      }
    };
    const onCardLeave = () => scheduleHideHoverCard();
    const onCardClick = () => {
      if (state.hoveredKey) openFullscreenModal(state.hoveredKey);
    };
    hoverCardEl.addEventListener("mouseenter", onCardEnter);
    hoverCardEl.addEventListener("mouseleave", onCardLeave);
    hoverCardEl.addEventListener("click", onCardClick);
    cleanups.push(() => {
      hoverCardEl.removeEventListener("mouseenter", onCardEnter);
      hoverCardEl.removeEventListener("mouseleave", onCardLeave);
      hoverCardEl.removeEventListener("click", onCardClick);
    });
  }

  if (modalCloseBtn) {
    const onClose = () => closeFullscreenModal();
    modalCloseBtn.addEventListener("click", onClose);
    cleanups.push(() => modalCloseBtn.removeEventListener("click", onClose));
  }

  if (modalToggleBtn) {
    const onModalToggle = () => {
      if (!state.modalKey) return;
      const key = state.modalKey;
      const item = BOOST_ITEM_BY_KEY.get(key);
      const nextVal = !state.boost[key];
      void applyBoostPatch(
        { [key]: nextVal },
        nextVal ? `已开启「${item?.title || key}」` : `已关闭「${item?.title || key}」`
      );
    };
    modalToggleBtn.addEventListener("click", onModalToggle);
    cleanups.push(() => modalToggleBtn.removeEventListener("click", onModalToggle));
  }

  if (modalEl) {
    const onBackdropClick = (ev) => {
      if (ev.target === modalEl) closeFullscreenModal();
    };
    modalEl.addEventListener("click", onBackdropClick);
    cleanups.push(() => modalEl.removeEventListener("click", onBackdropClick));
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    const onKeyDown = (ev) => {
      if (ev.key === "Escape" && modalEl && !modalEl.hidden) {
        closeFullscreenModal();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    cleanups.push(() => document.removeEventListener("keydown", onKeyDown));
  }

  render();

  return {
    updateFromPreferences(prefs) {
      if (!prefs || typeof prefs !== "object") return;
      const b = prefs.boost && typeof prefs.boost === "object" ? prefs.boost : {};
      state.boost = {
        batchOps: b.batchOps === true,
        compactOutput: b.compactOutput === true,
        outlineFirst: b.outlineFirst === true,
      };
      render();
    },
    setTabActive(active) {
      if (!active) {
        hideHoverCardImmediate();
        closeFullscreenModal();
      }
    },
    destroy() {
      destroyed = true;
      hideHoverCardImmediate();
      closeFullscreenModal();
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
