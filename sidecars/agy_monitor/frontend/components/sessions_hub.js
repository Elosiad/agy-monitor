/**
 * Four-column sessions hub (Active, Unread Done, Recent Activity, Favorites).
 * Handles host window switching via window.sidecar.ui.toggleConversation,
 * immediate mark-read syncing, and drag/reorder/star/add favorites persistence.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

function translate(tFn, key, fallback, vars) {
  let raw = typeof tFn === "function" ? tFn(key, vars) : "";
  if (!raw || raw === key) raw = fallback;
  if (!vars) return raw;
  return String(raw).replace(/\{\{?(\w+)\}?\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : ""
  );
}

async function requestJson(apiFetch, url, options) {
  const fetcher =
    typeof apiFetch === "function"
      ? apiFetch
      : typeof window !== "undefined" && typeof window.sidecar?.fetch === "function"
        ? window.sidecar.fetch
        : null;
  if (!fetcher) {
    throw new Error("window.sidecar.fetch is unavailable");
  }
  const res = await fetcher(url, options);
  if (res && typeof res.json === "function") {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.reason || data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  return res ?? {};
}

function makeSvg(size, paths, extra = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", extra.fill || "none");
  svg.setAttribute("aria-hidden", "true");

  paths.forEach((def) => {
    const node = document.createElementNS(SVG_NS, def.tag || "path");
    Object.entries(def.attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
    svg.appendChild(node);
  });
  return svg;
}

function createFolderIcon() {
  return makeSvg(10, [
    {
      attrs: {
        d: "M2 4.5a1.3 1.3 0 0 1 1.3-1.3h3l1.3 1.4h5.1A1.3 1.3 0 0 1 14 5.9v5.6a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 11.5V4.5Z",
        stroke: "currentColor",
        "stroke-width": "1.35",
      },
    },
  ]);
}

function createStarIcon(filled) {
  return makeSvg(
    11,
    [
      {
        attrs: {
          d: "m8 2.2 1.8 3.65 4.03.59-2.91 2.84.69 4.01L8 11.4l-3.61 1.89.69-4.01-2.91-2.84 4.03-.59L8 2.2Z",
          stroke: "currentColor",
          "stroke-width": "1.25",
          "stroke-linejoin": "round",
        },
      },
    ],
    { fill: filled ? "currentColor" : "none" }
  );
}

function createCheckIcon() {
  return makeSvg(11, [
    {
      attrs: {
        d: "m3.4 8.4 3.1 3.1 6.1-6.5",
        stroke: "currentColor",
        "stroke-width": "1.4",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
    },
  ]);
}

function createDragHandleIcon() {
  const dots = [
    [5.5, 4],
    [10.5, 4],
    [5.5, 8],
    [10.5, 8],
    [5.5, 12],
    [10.5, 12],
  ];
  return makeSvg(
    10,
    dots.map(([cx, cy]) => ({
      tag: "circle",
      attrs: { cx, cy, r: 1, fill: "currentColor" },
    }))
  );
}

function createArrowIcon(direction) {
  return makeSvg(10, [
    {
      attrs: {
        d: direction === "up" ? "M4.2 9.8 8 6l3.8 3.8" : "M4.2 6.2 8 10l3.8-3.8",
        stroke: "currentColor",
        "stroke-width": "1.5",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
    },
  ]);
}

function createCloseIcon() {
  return makeSvg(10, [
    {
      attrs: {
        d: "m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6",
        stroke: "currentColor",
        "stroke-width": "1.4",
        "stroke-linecap": "round",
      },
    },
  ]);
}

function extractWorkspaceName(rawWorkspace, fallbackLabel) {
  if (!rawWorkspace || typeof rawWorkspace !== "string") return fallbackLabel;
  let cleaned = rawWorkspace.trim().replace(/^file:\/+/i, "");
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // Keep original if malformed URI encoding
  }
  cleaned = cleaned.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : fallbackLabel;
}

/**
 * Mounts the four-column sessions hub onto #sessionsHubRow DOM nodes.
 */
export function createSessionsHub({
  apiFetch,
  t,
  onSelectConversation,
  onFavoritesChanged,
  onMarkRead,
  onToast,
} = {}) {
  const activeListEl = document.getElementById("activeSessionsList");
  const unreadListEl = document.getElementById("unreadSessionsList");
  const recentListEl = document.getElementById("recentSessionsList");
  const favoriteListEl = document.getElementById("favoriteSessionsList");
  const activeCountEl = document.getElementById("activeSessionsCount");
  const unreadCountEl = document.getElementById("unreadSessionsCount");
  const recentCountEl = document.getElementById("recentSessionsCount");
  const favoriteCountEl = document.getElementById("favoriteSessionsCount");
  const favoriteAddWrap = document.getElementById("favoriteAddWrap");
  const favoriteAddBtn = document.getElementById("favoriteAddBtn");
  const favoriteAddDropdown = document.getElementById("favoriteAddDropdown");
  const feedbackEl = document.getElementById("sessionsFeedback");

  let translator = t;
  let activeConvId = "";
  let hubData = {
    active: [],
    unread: [],
    recent: [],
    favorites: [],
    allSelectable: [],
  };
  let favoriteIds = [];
  let dragSourceId = null;
  let isDragging = false;
  let feedbackTimer = null;
  const locallyReadModifiedMs = new Map();
  const knownTitleMap = new Map();
  const cleanups = [];

  const tr = (key, fallback, vars) => translate(translator, key, fallback, vars);

  function showFeedback(text) {
    if (feedbackEl) {
      if (feedbackTimer) {
        clearTimeout(feedbackTimer);
        feedbackTimer = null;
      }
      feedbackEl.textContent = text;
      feedbackEl.hidden = false;
      feedbackTimer = setTimeout(() => {
        if (feedbackEl) feedbackEl.hidden = true;
      }, 2800);
    }
    onToast?.(text, "info");
  }

  function buildSessionLookup() {
    const map = new Map();
    const lists = [
      hubData.favorites,
      hubData.active,
      hubData.unread,
      hubData.recent,
      hubData.allSelectable,
    ];
    lists.forEach((arr) => {
      if (!Array.isArray(arr)) return;
      arr.forEach((item) => {
        if (item && item.id && !map.has(item.id)) {
          map.set(item.id, item);
        } else if (item && item.id) {
          const prev = map.get(item.id);
          map.set(item.id, {
            ...prev,
            ...item,
            title: item.title || prev.title,
            workspace: item.workspace || prev.workspace,
          });
        }
      });
    });
    return map;
  }

  function createFolderBadge(workspaceRaw) {
    const label = extractWorkspaceName(
      workspaceRaw,
      tr("sessions.unknownWorkspace", "全局或未绑定工作区")
    );
    const badge = document.createElement("span");
    badge.className = "session-folder";
    badge.title = label;
    badge.appendChild(createFolderIcon());
    const textSpan = document.createElement("span");
    textSpan.className = "session-folder-text";
    textSpan.textContent = label;
    badge.appendChild(textSpan);
    return badge;
  }

  let favoritesSeq = 0;
  let favoritesInFlight = 0;
  let destroyed = false;
  let lastAddMenuSig = "";

  async function syncFavorites(nextIds) {
    const reqSeq = ++favoritesSeq;
    favoritesInFlight += 1;
    const prevIds = [...favoriteIds];
    favoriteIds = [...new Set(nextIds.map(String).filter(Boolean))];
    const lookup = buildSessionLookup();
    const favoriteTitles = {};
    favoriteIds.forEach((id) => {
      const rec = lookup.get(id);
      const title = rec?.title && rec.title !== id.slice(0, 8) ? rec.title : knownTitleMap.get(id);
      if (title) {
        favoriteTitles[id] = String(title);
      }
    });
    renderAll();

    try {
      const resp = await requestJson(apiFetch, "/api/sessions/favorites", {
        method: "POST",
        body: JSON.stringify({ favoriteIds, favoriteTitles }),
      });
      if (destroyed) return;
      if (resp?.ok === false) {
        throw new Error(resp.reason || resp.error || "favorites sync failed");
      }
      if (reqSeq === favoritesSeq && Array.isArray(resp?.favoriteIds)) {
        favoriteIds = resp.favoriteIds.map(String);
        renderAll();
      }
      if (reqSeq === favoritesSeq) {
        onFavoritesChanged?.([...favoriteIds]);
      }
    } catch {
      if (destroyed) return;
      if (reqSeq === favoritesSeq) {
        favoriteIds = prevIds;
        renderAll();
        onToast?.(tr("sessions.favoritesSyncFailed", "同步常用会话列表失败"), "error");
      }
    } finally {
      favoritesInFlight = Math.max(0, favoritesInFlight - 1);
    }
  }

  function toggleFavorite(id) {
    if (!id) return;
    const nextIds = favoriteIds.includes(id)
      ? favoriteIds.filter((item) => item !== id)
      : [...favoriteIds, id];
    syncFavorites(nextIds);
  }

  function moveFavorite(id, delta) {
    const idx = favoriteIds.indexOf(id);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= favoriteIds.length) return;
    const next = [...favoriteIds];
    const [moved] = next.splice(idx, 1);
    next.splice(targetIdx, 0, moved);
    syncFavorites(next);
  }

  async function markSessionRead(session, showNotice = false) {
    if (!session?.id) return;
    const modifiedMs = Number(session.modifiedMs) || Date.now();
    locallyReadModifiedMs.set(session.id, modifiedMs);
    renderAll();

    try {
      await requestJson(apiFetch, "/api/sessions/mark-read", {
        method: "POST",
        body: JSON.stringify({ conversationId: session.id, modifiedMs }),
      });
      if (destroyed) return;
      if (showNotice) {
        showFeedback(tr("sessions.markedReadNotice", "已标记为已读"));
      }
      onMarkRead?.(session);
    } catch {
      // Silently ignore transient mark-read failure; next snapshot poll reconciles
    }
  }

  function activateSession(session) {
    if (!session?.id) return;
    const title = String(session.title || tr("sessions.untitled", "未命名对话"));
    activeConvId = session.id;

    // Persist exact clicked UUID to sidecar before host switches/remounts the sidecar pane
    void requestJson(apiFetch, "/api/sessions/focus", {
      method: "POST",
      body: JSON.stringify({
        conversationId: String(session.id),
        title,
        workspace: String(session.workspace || ""),
      }),
    }).catch(() => {});

    try {
      if (typeof window !== "undefined") {
        window.sidecar?.ui?.toggleConversation?.(String(session.id));
      }
    } catch {
      // Ignore host postMessage error in standalone browser preview
    }

    showFeedback(tr("sessions.switchedNotice", "已发送切换对话指令：{title}", { title }));
    markSessionRead(session, false);
    onSelectConversation?.(session);
  }

  function bindRowActivation(row, session) {
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.addEventListener("click", (e) => {
      if (e.target && typeof e.target.closest === "function" && e.target.closest("button")) {
        return;
      }
      activateSession(session);
    });
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activateSession(session);
      }
    });
  }

  function createStandardRow(session, mode) {
    const title = String(session.title || tr("sessions.untitled", "未命名对话"));
    const isCurrent = Boolean(activeConvId && session.id === activeConvId);
    const isWaiting = session.status === "waiting";
    const isRunning = !isWaiting && (session.status === "running" || mode === "active");
    const isUnread = mode === "unread";
    const isFav = favoriteIds.includes(session.id);

    const row = document.createElement("div");
    row.className = `session-row${isCurrent ? " is-active-conv" : ""}`;
    row.dataset.sessionId = session.id;
    bindRowActivation(row, session);

    const dot = document.createElement("span");
    dot.className = `session-status-dot ${
      isRunning ? "is-running" : isWaiting ? "is-waiting" : isUnread ? "is-unread" : "is-idle"
    }`;

    const folderBadge = createFolderBadge(session.workspace);

    const nameSpan = document.createElement("span");
    nameSpan.className = "session-name";
    nameSpan.textContent = title;
    nameSpan.title = `${extractWorkspaceName(session.workspace, "")} / ${title}`.replace(/^ \/ /, "");

    const metaSpan = document.createElement("span");
    metaSpan.className = `session-meta-tag${
      isRunning ? " is-running" : isWaiting ? " is-waiting" : ""
    }`;
    metaSpan.textContent = isRunning
      ? tr("sessions.runningTag", "运行中")
      : isWaiting
        ? tr("sessions.waitingTag", "等待/收尾")
        : String(session.agoText || "");

    const actions = document.createElement("div");
    actions.className = "session-row-actions";

    if (isUnread) {
      const readBtn = document.createElement("button");
      readBtn.type = "button";
      readBtn.className = "session-action-btn";
      readBtn.title = tr("sessions.markReadBtn", "标为已读");
      readBtn.setAttribute("aria-label", tr("sessions.markReadBtn", "标为已读"));
      readBtn.appendChild(createCheckIcon());
      readBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        markSessionRead(session, true);
      });
      actions.appendChild(readBtn);
    }

    const starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = `session-action-btn${isFav ? " is-favorited" : ""}`;
    const starTitle = isFav
      ? tr("sessions.favRemoveBtn", "移出常用")
      : tr("sessions.favAddBtn", "收藏");
    starBtn.title = starTitle;
    starBtn.setAttribute("aria-label", starTitle);
    starBtn.appendChild(createStarIcon(isFav));
    starBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(session.id);
    });
    actions.appendChild(starBtn);

    row.appendChild(dot);
    row.appendChild(folderBadge);
    row.appendChild(nameSpan);
    row.appendChild(metaSpan);
    row.appendChild(actions);
    return row;
  }

  function createFavoriteRow(session, index, total) {
    const title = String(session.title || tr("sessions.untitled", "未命名对话"));
    const isCurrent = Boolean(activeConvId && session.id === activeConvId);

    const row = document.createElement("div");
    row.className = `session-row${isCurrent ? " is-active-conv" : ""}`;
    row.draggable = true;
    row.dataset.sessionId = session.id;
    bindRowActivation(row, session);

    const handle = document.createElement("span");
    handle.className = "session-drag-handle";
    handle.title = tr("sessions.dragHint", "可上移 / 下移调整顺序");
    handle.appendChild(createDragHandleIcon());

    const folderBadge = createFolderBadge(session.workspace);

    const nameSpan = document.createElement("span");
    nameSpan.className = "session-name";
    nameSpan.textContent = title;
    nameSpan.title = `${extractWorkspaceName(session.workspace, "")} / ${title}`.replace(/^ \/ /, "");

    const actions = document.createElement("div");
    actions.className = "session-row-actions";

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "session-action-btn";
    upBtn.title = tr("sessions.moveUp", "上移");
    upBtn.setAttribute("aria-label", tr("sessions.moveUp", "上移"));
    upBtn.disabled = index === 0;
    upBtn.appendChild(createArrowIcon("up"));
    upBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      moveFavorite(session.id, -1);
    });

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "session-action-btn";
    downBtn.title = tr("sessions.moveDown", "下移");
    downBtn.setAttribute("aria-label", tr("sessions.moveDown", "下移"));
    downBtn.disabled = index === total - 1;
    downBtn.appendChild(createArrowIcon("down"));
    downBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      moveFavorite(session.id, 1);
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "session-action-btn";
    removeBtn.title = tr("sessions.favRemoveBtn", "移出常用");
    removeBtn.setAttribute("aria-label", tr("sessions.favRemoveBtn", "移出常用"));
    removeBtn.appendChild(createCloseIcon());
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(session.id);
    });

    actions.appendChild(upBtn);
    actions.appendChild(downBtn);
    actions.appendChild(removeBtn);

    row.addEventListener("dragstart", (e) => {
      dragSourceId = session.id;
      isDragging = true;
      row.classList.add("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", session.id);
      }
    });

    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (dragSourceId && dragSourceId !== session.id) {
        row.classList.add("is-drag-over");
      }
    });

    row.addEventListener("dragleave", () => {
      row.classList.remove("is-drag-over");
    });

    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("is-drag-over");
      isDragging = false;
      if (!dragSourceId || dragSourceId === session.id) return;
      const fromIdx = favoriteIds.indexOf(dragSourceId);
      const toIdx = favoriteIds.indexOf(session.id);
      dragSourceId = null;
      if (fromIdx < 0 || toIdx < 0) return;
      const next = [...favoriteIds];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      syncFavorites(next);
    });

    row.addEventListener("dragend", () => {
      isDragging = false;
      dragSourceId = null;
      favoriteListEl?.querySelectorAll(".session-row").forEach((el) => {
        el.classList.remove("is-dragging", "is-drag-over");
      });
    });

    row.appendChild(handle);
    row.appendChild(folderBadge);
    row.appendChild(nameSpan);
    row.appendChild(actions);
    return row;
  }

  function renderEmptyTip(container, text) {
    const tip = document.createElement("div");
    tip.className = "session-empty-tip";
    tip.textContent = text;
    container.appendChild(tip);
  }

  function renderFavoriteAddMenu(lookup, { force = false } = {}) {
    if (!favoriteAddDropdown) return;

    const candidates = [];
    const seen = new Set();
    const pools = [
      ...(Array.isArray(hubData.allSelectable) ? hubData.allSelectable : []),
      ...(Array.isArray(hubData.active) ? hubData.active : []),
      ...(Array.isArray(hubData.unread) ? hubData.unread : []),
      ...(Array.isArray(hubData.recent) ? hubData.recent : []),
    ];
    pools.forEach((item) => {
      if (!item?.id || seen.has(item.id) || favoriteIds.includes(item.id)) return;
      seen.add(item.id);
      candidates.push(lookup.get(item.id) || item);
    });

    const sig = candidates.map((c) => `${c.id}:${c.title || ""}:${c.workspace || ""}`).join("|");
    if (!force && !favoriteAddDropdown.hidden && sig === lastAddMenuSig) {
      return;
    }
    lastAddMenuSig = sig;
    favoriteAddDropdown.innerHTML = "";

    if (candidates.length === 0) {
      const empty = document.createElement("div");
      empty.className = "favorite-add-empty";
      empty.textContent = tr("sessions.allInFavorites", "近期会话均已加入常用列表");
      favoriteAddDropdown.appendChild(empty);
      return;
    }

    candidates.forEach((session) => {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "favorite-add-option";
      opt.setAttribute("role", "option");

      const folderBadge = createFolderBadge(session.workspace);
      const nameSpan = document.createElement("span");
      nameSpan.className = "session-name";
      nameSpan.textContent = String(session.title || tr("sessions.untitled", "未命名对话"));

      opt.appendChild(folderBadge);
      opt.appendChild(nameSpan);
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        setAddMenuOpen(false);
        toggleFavorite(session.id);
      });

      favoriteAddDropdown.appendChild(opt);
    });
  }

  function setAddMenuOpen(open) {
    if (!favoriteAddWrap || !favoriteAddBtn || !favoriteAddDropdown) return;
    if (open) {
      renderFavoriteAddMenu(buildSessionLookup(), { force: true });
    }
    favoriteAddDropdown.hidden = !open;
    favoriteAddWrap.classList.toggle("is-open", open);
    favoriteAddBtn.setAttribute("aria-expanded", String(open));
  }

  function renderAll() {
    if (!activeListEl || !unreadListEl || !recentListEl || !favoriteListEl) return;
    const lookup = buildSessionLookup();

    const activeItems = Array.isArray(hubData.active) ? hubData.active : [];
    const unreadItems = (Array.isArray(hubData.unread) ? hubData.unread : []).filter((s) => {
      const seenMs = locallyReadModifiedMs.get(s.id);
      return !(seenMs && Number(s.modifiedMs || 0) <= seenMs);
    });
    const recentItems = Array.isArray(hubData.recent) ? hubData.recent : [];
    const favoriteItems = favoriteIds
      .map((id) => lookup.get(id) || { id, title: id.slice(0, 8), workspace: "", modifiedMs: 0 })
      .filter(Boolean);

    activeListEl.innerHTML = "";
    unreadListEl.innerHTML = "";
    recentListEl.innerHTML = "";

    if (activeCountEl) activeCountEl.textContent = String(activeItems.length);
    if (unreadCountEl) unreadCountEl.textContent = String(unreadItems.length);
    if (recentCountEl) recentCountEl.textContent = String(recentItems.length);
    if (favoriteCountEl) favoriteCountEl.textContent = String(favoriteItems.length);

    if (activeItems.length === 0) {
      renderEmptyTip(activeListEl, tr("sessions.emptyActive", "暂无运行中会话"));
    } else {
      activeItems.forEach((s) => activeListEl.appendChild(createStandardRow(s, "active")));
    }

    if (unreadItems.length === 0) {
      renderEmptyTip(unreadListEl, tr("sessions.emptyUnread", "暂无未读完成会话"));
    } else {
      unreadItems.forEach((s) => unreadListEl.appendChild(createStandardRow(s, "unread")));
    }

    if (recentItems.length === 0) {
      renderEmptyTip(recentListEl, tr("sessions.emptyRecent", "暂无最近对话记录"));
    } else {
      recentItems.forEach((s) => recentListEl.appendChild(createStandardRow(s, "recent")));
    }

    if (!isDragging) {
      favoriteListEl.innerHTML = "";
      if (favoriteItems.length === 0) {
        renderEmptyTip(
          favoriteListEl,
          tr("sessions.emptyFavorites", "点击“加入”固定常用会话")
        );
      } else {
        favoriteItems.forEach((s, idx) =>
          favoriteListEl.appendChild(createFavoriteRow(s, idx, favoriteItems.length))
        );
      }
    }

    renderFavoriteAddMenu(lookup);
  }

  if (favoriteAddWrap && favoriteAddBtn && favoriteAddDropdown) {
    const onAddBtnClick = (e) => {
      e.stopPropagation();
      setAddMenuOpen(favoriteAddDropdown.hidden);
    };
    const onDocClick = (e) => {
      if (!favoriteAddWrap.contains(e.target)) {
        setAddMenuOpen(false);
      }
    };
    const onDocKeyDown = (e) => {
      if (e.key === "Escape" && !favoriteAddDropdown.hidden) {
        setAddMenuOpen(false);
        favoriteAddBtn.focus();
      }
    };

    favoriteAddBtn.addEventListener("click", onAddBtnClick);
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onDocKeyDown);
    cleanups.push(() => favoriteAddBtn.removeEventListener("click", onAddBtnClick));
    cleanups.push(() => document.removeEventListener("click", onDocClick));
    cleanups.push(() => document.removeEventListener("keydown", onDocKeyDown));
  }

  renderAll();

  return {
    update(sessionsHub, nextActiveConvId) {
      if (typeof nextActiveConvId === "string") {
        activeConvId = nextActiveConvId;
      }
      if (sessionsHub && typeof sessionsHub === "object") {
        hubData = {
          active: Array.isArray(sessionsHub.active) ? sessionsHub.active : [],
          unread: Array.isArray(sessionsHub.unread) ? sessionsHub.unread : [],
          recent: Array.isArray(sessionsHub.recent) ? sessionsHub.recent : [],
          favorites: Array.isArray(sessionsHub.favorites) ? sessionsHub.favorites : [],
          allSelectable: Array.isArray(sessionsHub.allSelectable) ? sessionsHub.allSelectable : [],
        };
        [
          ...hubData.active,
          ...hubData.unread,
          ...hubData.recent,
          ...hubData.favorites,
          ...hubData.allSelectable,
        ].forEach((item) => {
          if (item?.id && item?.title && item.title !== item.id.slice(0, 8)) {
            knownTitleMap.set(String(item.id), String(item.title));
          }
        });
        if (favoritesInFlight === 0) {
          favoriteIds = hubData.favorites.map((s) => String(s.id)).filter(Boolean);
        }

        // Prune local optimistic read entries once backend caught up
        const unreadIdSet = new Set(hubData.unread.map((s) => s.id));
        for (const id of locallyReadModifiedMs.keys()) {
          if (!unreadIdSet.has(id)) {
            locallyReadModifiedMs.delete(id);
          }
        }
      }
      renderAll();
    },
    setTranslator(nextT) {
      translator = nextT;
      renderAll();
    },
    destroy() {
      destroyed = true;
      if (feedbackTimer) {
        clearTimeout(feedbackTimer);
        feedbackTimer = null;
      }
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
