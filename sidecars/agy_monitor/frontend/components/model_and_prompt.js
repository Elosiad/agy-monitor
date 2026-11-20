/**
 * Global default model selector (read-only list + write-once on user click +
 * "New Chat with Default Model") and system prompt rules selector
 * (builtin presets, custom .md import with security feedback, and ? modal).
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const RULES_MAX_BYTES = 24000;

function translate(tFn, key, fallback, vars) {
  let raw = typeof tFn === "function" ? tFn(key, vars) : "";
  if (!raw || raw === key) raw = fallback;
  if (!vars) return raw;
  return String(raw).replace(/\{\{?(\w+)\}?\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : ""
  );
}

function isEnglishLocale(tFn) {
  if (typeof tFn?.getLang === "function") return tFn.getLang() === "en";
  if (typeof tFn?.lang === "string") return tFn.lang === "en";
  return typeof document !== "undefined" && document.documentElement?.lang === "en";
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

function createCheckSvg() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "m3.4 8.4 3.1 3.1 6.1-6.5");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

function normalizeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.model || "").trim();
  if (!id) return null;
  const name = String(raw.name || raw.label || id);
  const tiers = Array.isArray(raw.tiers) && raw.tiers.length > 0 ? raw.tiers.map(String) : null;
  const tier = raw.tier ? String(raw.tier) : "";
  const badge = raw.badge
    ? String(raw.badge)
    : raw.source === "observed"
      ? "Live"
      : raw.provider
        ? String(raw.provider)
        : "";
  return {
    id,
    name,
    tiers,
    tier,
    badge,
    source: raw.source || "catalog",
    disabled: Boolean(raw.disabled),
  };
}

function normalizePrompt(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  return {
    id,
    group: String(raw.group || (raw.builtin === false ? "custom" : "preset")),
    name: String(raw.name || id),
    nameEn: raw.nameEn ? String(raw.nameEn) : "",
    description: String(raw.description || raw.desc || ""),
    descriptionEn: raw.descriptionEn ? String(raw.descriptionEn) : "",
    tokens: Math.max(0, Number(raw.rulesTokens ?? raw.tokens ?? 0)),
    builtin: raw.builtin !== false,
    placeholder: Boolean(raw.placeholder),
  };
}

/**
 * Mounts global default model selector, new chat button, prompt rules dropdown,
 * .md importer, and ? security help modal.
 */
export function createModelAndPrompt({
  apiFetch,
  t,
  onModelChanged,
  onSessionCreated,
  onPromptChanged,
  onToast,
} = {}) {
  const modelSelector = document.getElementById("globalModelSelector");
  const modelBtn = document.getElementById("globalModelBtn");
  const modelDropdown = document.getElementById("globalModelDropdown");
  const modelActiveNameEl = document.getElementById("globalModelActiveName");
  const modelActiveTierEl = document.getElementById("globalModelActiveTier");
  const modelActiveBadgeEl = document.getElementById("globalModelActiveBadge");
  const newConvBtn = document.getElementById("newConvDefaultModelBtn");

  const promptSelector = document.getElementById("promptSelector");
  const promptBtn = document.getElementById("promptSelectBtn");
  const promptDropdown = document.getElementById("promptDropdown");
  const promptActiveNameEl = document.getElementById("promptActiveName");
  const promptActiveTokensEl = document.getElementById("promptActiveTokens");
  const promptImportBtn = document.getElementById("promptImportBtn");
  const promptMdInput = document.getElementById("promptMdInput");
  const promptHelpBtn = document.getElementById("promptHelpBtn");
  const promptImportStatusEl = document.getElementById("promptImportStatus");
  const promptHelpModal = document.getElementById("promptHelpModal");

  let translator = t;
  let models = [];
  let defaultModel = { id: "", tier: "" };
  let prompts = [];
  let activePromptId = "official";
  let isSavingModel = false;
  let isCreatingConv = false;
  let isSavingPrompt = false;
  let statusHideTimer = null;
  const cleanups = [];

  const tr = (key, fallback, vars) => translate(translator, key, fallback, vars);

  function getLocalizedPromptText(item) {
    const en = isEnglishLocale(translator);
    return {
      name: en && item.nameEn ? item.nameEn : item.name,
      desc: en && item.descriptionEn ? item.descriptionEn : item.description,
    };
  }

  function showInlineStatus(message, level = "info", autoHideMs = 0) {
    if (!promptImportStatusEl) return;
    if (statusHideTimer) {
      clearTimeout(statusHideTimer);
      statusHideTimer = null;
    }
    if (!message) {
      promptImportStatusEl.hidden = true;
      promptImportStatusEl.textContent = "";
      promptImportStatusEl.className = "inline-feedback";
      return;
    }
    const levelClass =
      level === "blocked"
        ? "is-blocked"
        : level === "error"
          ? "is-error"
          : level === "warning"
            ? "is-warning"
            : level === "success"
              ? "is-success"
              : "";
    promptImportStatusEl.className = `inline-feedback ${levelClass}`.trim();
    promptImportStatusEl.textContent = message;
    promptImportStatusEl.hidden = false;

    if (autoHideMs > 0) {
      statusHideTimer = setTimeout(() => {
        if (promptImportStatusEl) promptImportStatusEl.hidden = true;
      }, autoHideMs);
    }
  }

  function setModelDropdownOpen(open) {
    if (!modelDropdown || !modelSelector || !modelBtn) return;
    modelDropdown.hidden = !open;
    modelSelector.classList.toggle("is-open", open);
    modelBtn.setAttribute("aria-expanded", String(open));
  }

  function setPromptDropdownOpen(open) {
    if (!promptDropdown || !promptSelector || !promptBtn) return;
    promptDropdown.hidden = !open;
    promptSelector.classList.toggle("is-open", open);
    promptBtn.setAttribute("aria-expanded", String(open));
  }

  function getActiveModelRecord() {
    if (!defaultModel?.id) return null;
    return (
      models.find((m) => m.id === defaultModel.id) || {
        id: defaultModel.id,
        name: defaultModel.id,
        tier: defaultModel.tier || "",
        badge: "",
        disabled: false,
      }
    );
  }

  function renderModelTrigger() {
    const active = getActiveModelRecord();
    if (modelActiveNameEl) {
      modelActiveNameEl.textContent = active
        ? active.name
        : tr("model.notSet", "跟随宿主当前");
    }
    if (modelActiveTierEl) {
      modelActiveTierEl.textContent = active ? defaultModel.tier || active.tier || "" : "";
    }
    if (modelActiveBadgeEl) {
      const badge = active?.badge || "";
      modelActiveBadgeEl.textContent = badge;
      modelActiveBadgeEl.className = `global-model-status-tag${
        badge === "Notice" ? " is-notice" : ""
      }`;
    }
  }

  async function selectDefaultModel(model, tierOverride) {
    if (!model || model.disabled || isSavingModel) return;
    const nextTier = tierOverride !== undefined ? tierOverride : model.tier || "";
    const prev = { ...defaultModel };
    if (prev.id === model.id && prev.tier === nextTier) {
      setModelDropdownOpen(false);
      return;
    }

    defaultModel = { id: model.id, tier: nextTier };
    if (tierOverride !== undefined) model.tier = tierOverride;
    renderModelTrigger();
    renderModelOptions();
    setModelDropdownOpen(false);

    isSavingModel = true;
    try {
      const resp = await requestJson(apiFetch, "/api/model/default", {
        method: "POST",
        body: JSON.stringify({ modelId: model.id, tier: nextTier }),
      });
      if (resp?.ok === false) {
        throw new Error(resp.reason || resp.error || "save failed");
      }
      if (resp?.defaultModel) {
        defaultModel = {
          id: String(resp.defaultModel.id || model.id),
          tier: String(resp.defaultModel.tier ?? nextTier),
        };
      }
      renderModelTrigger();
      renderModelOptions();
      onModelChanged?.(defaultModel);
      onToast?.(
        tr("model.saved", "已记录全局默认模型：{model}", { model: model.name }),
        "success"
      );
    } catch (err) {
      defaultModel = prev;
      renderModelTrigger();
      renderModelOptions();
      onToast?.(tr("model.saveFailed", "保存默认模型失败"), "error");
    } finally {
      isSavingModel = false;
    }
  }

  function renderModelOptions() {
    if (!modelDropdown) return;
    modelDropdown.innerHTML = "";

    if (models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "favorite-add-empty";
      empty.textContent = tr("model.noModels", "暂未发现可用模型记录");
      modelDropdown.appendChild(empty);
      return;
    }

    models.forEach((model) => {
      const isActive = defaultModel.id === model.id;
      const optionRow = document.createElement("div");
      optionRow.className = `global-model-option${isActive ? " is-active" : ""}${
        model.disabled ? " is-disabled" : ""
      }`;
      optionRow.setAttribute("role", "option");
      optionRow.setAttribute("aria-selected", String(isActive));
      if (!model.disabled) optionRow.tabIndex = 0;

      const left = document.createElement("div");
      left.className = "global-model-option-left";

      const nameSpan = document.createElement("span");
      nameSpan.className = "global-model-option-name";
      nameSpan.textContent = model.name;
      nameSpan.title = model.id;
      left.appendChild(nameSpan);

      const effectiveTier = isActive && defaultModel.tier ? defaultModel.tier : model.tier;
      if (!model.tiers && effectiveTier) {
        const tierText = document.createElement("span");
        tierText.className = "global-model-option-tier-text";
        tierText.textContent = effectiveTier;
        left.appendChild(tierText);
      }

      const right = document.createElement("div");
      right.className = "global-model-option-right";

      if (model.tiers) {
        const tierGroup = document.createElement("div");
        tierGroup.className = "model-tier-pills";
        model.tiers.forEach((tierName) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = `model-tier-chip${effectiveTier === tierName ? " is-active" : ""}`;
          chip.textContent = tierName;
          chip.addEventListener("click", (e) => {
            e.stopPropagation();
            selectDefaultModel(model, tierName);
          });
          tierGroup.appendChild(chip);
        });
        right.appendChild(tierGroup);
      }

      if (model.badge) {
        const badgeSpan = document.createElement("span");
        const badgeClass =
          model.badge === "Notice"
            ? " is-notice"
            : model.badge === "Unavailable"
              ? " is-unavailable"
              : "";
        badgeSpan.className = `global-model-badge${badgeClass}`;
        badgeSpan.textContent = model.badge;
        right.appendChild(badgeSpan);
      }

      const checkSpan = document.createElement("span");
      checkSpan.className = "global-model-check";
      if (isActive) checkSpan.appendChild(createCheckSvg());
      right.appendChild(checkSpan);

      optionRow.appendChild(left);
      optionRow.appendChild(right);

      if (!model.disabled) {
        optionRow.addEventListener("click", (e) => {
          e.stopPropagation();
          selectDefaultModel(model);
        });
        optionRow.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectDefaultModel(model);
          }
        });
      }

      modelDropdown.appendChild(optionRow);
    });
  }

  function renderPromptTrigger() {
    const active = prompts.find((p) => p.id === activePromptId) || prompts[0] || null;
    if (!active) {
      if (promptActiveNameEl) promptActiveNameEl.textContent = tr("prompt.noPresets", "暂无可用规则预设");
      if (promptActiveTokensEl) promptActiveTokensEl.textContent = "+0";
      return;
    }
    const { name } = getLocalizedPromptText(active);
    if (promptActiveNameEl) {
      promptActiveNameEl.textContent = name;
      promptActiveNameEl.title = name;
    }
    if (promptActiveTokensEl) {
      promptActiveTokensEl.textContent = `+${Math.round(active.tokens).toLocaleString("en-US")}`;
    }
  }

  async function selectPromptPreset(item) {
    if (!item || isSavingPrompt) return;
    setPromptDropdownOpen(false);
    if (item.id === activePromptId) return;

    const prevId = activePromptId;
    activePromptId = item.id;
    renderPromptTrigger();
    renderPromptOptions();

    isSavingPrompt = true;
    try {
      const resp = await requestJson(apiFetch, "/api/prompts/select", {
        method: "POST",
        body: JSON.stringify({ presetId: item.id }),
      });
      if (resp?.ok === false || resp?.blocked) {
        throw new Error(resp.reason || resp.error || "select failed");
      }
      if (typeof resp?.rulesTokens === "number") {
        item.tokens = Math.max(0, resp.rulesTokens);
      }
      activePromptId = resp?.activePromptId || item.id;
      renderPromptTrigger();
      renderPromptOptions();

      const { name } = getLocalizedPromptText(item);
      showInlineStatus("");
      onPromptChanged?.(resp);
      onToast?.(tr("prompt.selectedToast", "已切换系统规则预设：{name}", { name }), "success");
    } catch (err) {
      activePromptId = prevId;
      renderPromptTrigger();
      renderPromptOptions();
      const msg = err?.message || tr("prompt.selectFailed", "切换规则预设失败");
      showInlineStatus(msg, "error", 5000);
      onToast?.(tr("prompt.selectFailed", "切换规则预设失败"), "error");
    } finally {
      isSavingPrompt = false;
    }
  }

  function renderPromptOptions() {
    if (!promptDropdown) return;
    promptDropdown.innerHTML = "";

    if (prompts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "favorite-add-empty";
      empty.textContent = tr("prompt.noPresets", "暂无可用规则预设");
      promptDropdown.appendChild(empty);
      return;
    }

    const groups = [
      {
        title: tr("prompt.groupBuiltin", "内置预设"),
        match: (p) => p.group !== "custom",
      },
      {
        title: tr("prompt.groupCustom", "已导入自定义规则"),
        match: (p) => p.group === "custom",
      },
    ];

    groups.forEach((group) => {
      const items = prompts.filter(group.match);
      if (items.length === 0) return;

      const groupLabel = document.createElement("div");
      groupLabel.className = "prompt-group-label";
      groupLabel.textContent = group.title;
      promptDropdown.appendChild(groupLabel);

      items.forEach((item) => {
        const isCurrent = item.id === activePromptId;
        const { name, desc } = getLocalizedPromptText(item);

        const optBtn = document.createElement("button");
        optBtn.type = "button";
        optBtn.className = `prompt-option${isCurrent ? " is-active" : ""}`;
        optBtn.setAttribute("role", "option");
        optBtn.setAttribute("aria-selected", String(isCurrent));
        optBtn.dataset.promptId = item.id;

        const main = document.createElement("span");
        main.className = "prompt-option-main";

        const indicator = document.createElement("span");
        indicator.className = "prompt-option-indicator";

        const texts = document.createElement("span");
        texts.className = "prompt-option-texts";

        const nameSpan = document.createElement("span");
        nameSpan.className = "prompt-option-name";
        nameSpan.textContent = name;
        nameSpan.title = desc ? `${name} — ${desc}` : name;

        const descSpan = document.createElement("span");
        descSpan.className = "prompt-option-desc";
        descSpan.textContent = desc;

        texts.appendChild(nameSpan);
        if (desc) texts.appendChild(descSpan);
        main.appendChild(indicator);
        main.appendChild(texts);

        const right = document.createElement("span");
        right.className = "prompt-option-right";

        if (item.group === "custom") {
          const badge = document.createElement("span");
          badge.className = "prompt-option-badge";
          badge.textContent = ".md";
          right.appendChild(badge);
        }

        const tokensSpan = document.createElement("span");
        tokensSpan.className = "prompt-option-tokens";
        tokensSpan.textContent = `+${Math.round(item.tokens).toLocaleString("en-US")}`;
        right.appendChild(tokensSpan);

        optBtn.appendChild(main);
        optBtn.appendChild(right);

        optBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          selectPromptPreset(item);
        });

        promptDropdown.appendChild(optBtn);
      });
    });
  }

  async function handleMdImport(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      if (!content.trim()) {
        const msg = tr("prompt.importEmpty", "所选 Markdown 文件内容为空");
        showInlineStatus(msg, "error");
        onToast?.(msg, "error");
        return;
      }

      const byteLen = typeof TextEncoder !== "undefined"
        ? new TextEncoder().encode(content).length
        : content.length;
      if (byteLen > RULES_MAX_BYTES) {
        const msg = tr(
          "prompt.importTooLarge",
          "文件超出单文件 24,000 字节 (UTF-8) 上限，请精简后再导入"
        );
        showInlineStatus(msg, "error");
        onToast?.(msg, "error");
        return;
      }

      if (promptImportBtn) promptImportBtn.disabled = true;
      try {
        const resp = await requestJson(apiFetch, "/api/prompts/import", {
          method: "POST",
          body: JSON.stringify({ filename: file.name, content }),
        });

        if (resp?.blocked || resp?.ok === false) {
          const reason = resp?.reason || resp?.error || tr("prompt.importFailed", "导入规则文件失败");
          const msg = tr("prompt.importBlocked", "安全风控已拦截该文件：{reason}", { reason });
          showInlineStatus(msg, "blocked");
          onToast?.(msg, "error");
          return;
        }

        const imported = normalizePrompt(resp?.preset);
        if (imported) {
          const existingIdx = prompts.findIndex((p) => p.id === imported.id);
          if (existingIdx >= 0) {
            prompts[existingIdx] = imported;
          } else {
            prompts.push(imported);
          }
          activePromptId = imported.id;
          renderPromptTrigger();
          renderPromptOptions();
        }

        const warnings = Array.isArray(resp?.warnings)
          ? resp.warnings.filter(Boolean)
          : resp?.warning
            ? [String(resp.warning)]
            : [];

        if (warnings.length > 0) {
          const msg = tr("prompt.importWarning", "规则已导入（存在提示）：{warning}", {
            warning: warnings.join(" "),
          });
          showInlineStatus(msg, "warning");
          onToast?.(msg, "info");
        } else {
          const presetName = imported ? getLocalizedPromptText(imported).name : file.name;
          const msg = tr("prompt.importSuccess", "已导入并启用规则预设：{name}（+{tokens} tokens）", {
            name: presetName,
            tokens: Math.round(imported?.tokens || 0).toLocaleString("en-US"),
          });
          showInlineStatus(msg, "success", 6000);
          onToast?.(msg, "success");
        }

        onPromptChanged?.(resp);
      } catch (err) {
        const errData = err?.data || {};
        if (errData.blocked) {
          const msg = tr("prompt.importBlocked", "安全风控已拦截该文件：{reason}", {
            reason: errData.reason || err.message,
          });
          showInlineStatus(msg, "blocked");
          onToast?.(msg, "error");
        } else {
          const msg = err?.message || tr("prompt.importFailed", "导入规则文件失败");
          showInlineStatus(msg, "error");
          onToast?.(msg, "error");
        }
      } finally {
        if (promptImportBtn) promptImportBtn.disabled = false;
      }
    };
    reader.readAsText(file, "UTF-8");
  }

  function openHelpModal() {
    if (!promptHelpModal) return;
    setModelDropdownOpen(false);
    setPromptDropdownOpen(false);
    promptHelpModal.hidden = false;
    const closeBtn = document.getElementById("promptHelpCloseBtn");
    setTimeout(() => closeBtn?.focus(), 0);
  }

  function closeHelpModal() {
    if (!promptHelpModal || promptHelpModal.hidden) return;
    promptHelpModal.hidden = true;
    promptHelpBtn?.focus();
  }

  // Event bindings
  if (modelBtn && modelDropdown) {
    const onModelBtnClick = (e) => {
      e.stopPropagation();
      setPromptDropdownOpen(false);
      setModelDropdownOpen(modelDropdown.hidden);
    };
    modelBtn.addEventListener("click", onModelBtnClick);
    cleanups.push(() => modelBtn.removeEventListener("click", onModelBtnClick));
  }

  let newConvDrawer = null;
  let newConvWarnEl = null;
  let newConvPromptInput = null;
  let newConvCancelBtn = null;
  let newConvConfirmBtn = null;

  function ensureNewConvDrawer() {
    if (newConvDrawer) return newConvDrawer;
    const modelRow = newConvBtn?.closest?.(".model-selector-row") || modelSelector?.closest?.(".model-selector-row");
    const hostParent = modelRow?.parentNode;
    if (!hostParent || typeof document === "undefined") return null;

    const existing = document.getElementById("newConvComposerBox");
    if (existing) {
      newConvDrawer = existing;
      newConvWarnEl = existing.querySelector(".new-conv-warn-text");
      newConvPromptInput = existing.querySelector("#newConvPromptInput");
      newConvCancelBtn = existing.querySelector("#newConvCancelBtn");
      newConvConfirmBtn = existing.querySelector("#newConvConfirmBtn");
      return newConvDrawer;
    }

    const box = document.createElement("div");
    box.id = "newConvComposerBox";
    box.className = "new-conv-composer-box";
    box.hidden = true;
    box.style.cssText = [
      "padding:8px 10px",
      "border-radius:8px",
      "background:var(--bg-elevated, #17161d)",
      "border:1px solid var(--border-subtle, #25242c)",
      "display:flex",
      "flex-direction:column",
      "gap:6px",
    ].join(";");

    const warn = document.createElement("div");
    warn.className = "new-conv-warn-text";
    warn.style.cssText = [
      "font-size:11px",
      "line-height:1.4",
      "padding:5px 8px",
      "border-radius:6px",
      "background:var(--accent-amber-bg, rgba(233,147,21,0.14))",
      "color:var(--accent-amber, #e99315)",
    ].join(";");

    const textarea = document.createElement("textarea");
    textarea.id = "newConvPromptInput";
    textarea.rows = 2;
    textarea.maxLength = 4000;
    textarea.style.cssText = [
      "width:100%",
      "resize:vertical",
      "min-height:46px",
      "padding:6px 8px",
      "border-radius:6px",
      "border:1px solid var(--border-subtle, #25242c)",
      "background:var(--bg-control, rgba(255,255,255,0.045))",
      "color:var(--text-primary, #e8e7ec)",
      "font-size:12px",
      "line-height:1.45",
      "outline:none",
    ].join(";");

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:6px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.id = "newConvCancelBtn";
    cancelBtn.type = "button";
    cancelBtn.className = "modal-secondary-btn";

    const confirmBtn = document.createElement("button");
    confirmBtn.id = "newConvConfirmBtn";
    confirmBtn.type = "button";
    confirmBtn.className = "modal-primary-btn";

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(warn);
    box.appendChild(textarea);
    box.appendChild(actions);

    hostParent.insertBefore(box, modelRow.nextSibling);

    newConvDrawer = box;
    newConvWarnEl = warn;
    newConvPromptInput = textarea;
    newConvCancelBtn = cancelBtn;
    newConvConfirmBtn = confirmBtn;

    const onCancel = () => {
      closeNewConvDrawer();
      newConvBtn?.focus();
    };
    const onConfirm = () => submitNewConversation();
    const onTextareaKeyDown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitNewConversation();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeNewConvDrawer();
        newConvBtn?.focus();
      }
    };

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    textarea.addEventListener("keydown", onTextareaKeyDown);
    cleanups.push(() => cancelBtn.removeEventListener("click", onCancel));
    cleanups.push(() => confirmBtn.removeEventListener("click", onConfirm));
    cleanups.push(() => textarea.removeEventListener("keydown", onTextareaKeyDown));

    syncNewConvDrawerLocale();
    return newConvDrawer;
  }

  function syncNewConvDrawerLocale() {
    if (!newConvDrawer) return;
    if (newConvWarnEl) {
      newConvWarnEl.textContent = tr(
        "model.newConvWarn",
        "将使用当前选定模型立即发送首条消息并消耗额度，不修改宿主左侧默认模型"
      );
    }
    if (newConvPromptInput) {
      newConvPromptInput.placeholder = tr(
        "model.newConvPromptPlaceholder",
        "输入首句指令（留空发送默认确认语）…"
      );
    }
    if (newConvCancelBtn) {
      newConvCancelBtn.textContent = tr("common.cancel", "取消");
    }
    if (newConvConfirmBtn) {
      newConvConfirmBtn.textContent = tr("model.newConvSubmit", "立即发起并发送");
    }
  }

  function openNewConvDrawer() {
    const drawer = ensureNewConvDrawer();
    if (!drawer) return false;
    setModelDropdownOpen(false);
    setPromptDropdownOpen(false);
    syncNewConvDrawerLocale();
    drawer.hidden = false;
    newConvBtn?.setAttribute("aria-expanded", "true");
    setTimeout(() => newConvPromptInput?.focus(), 0);
    return true;
  }

  function closeNewConvDrawer() {
    if (!newConvDrawer || newConvDrawer.hidden) return;
    newConvDrawer.hidden = true;
    newConvBtn?.setAttribute("aria-expanded", "false");
  }

  async function submitNewConversation() {
    if (isCreatingConv) return;
    isCreatingConv = true;
    if (newConvBtn) newConvBtn.disabled = true;
    if (newConvConfirmBtn) newConvConfirmBtn.disabled = true;
    const active = getActiveModelRecord();
    const modelLabel = active ? active.name : tr("model.notSet", "跟随宿主当前");
    const customPrompt = newConvPromptInput ? newConvPromptInput.value.trim() : "";

    try {
      const payload = { useDefaultModel: true };
      if (customPrompt) {
        payload.prompt = customPrompt;
      }
      const resp = await requestJson(apiFetch, "/api/sessions/new", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (resp?.ok === false) {
        throw new Error(resp.reason || resp.error || "failed");
      }
      if (newConvPromptInput) newConvPromptInput.value = "";
      closeNewConvDrawer();
      if (resp?.conversationId && typeof window !== "undefined") {
        window.sidecar?.ui?.toggleConversation?.(String(resp.conversationId));
      }
      onSessionCreated?.(resp);
      onToast?.(
        tr("model.createdConv", "已发送按默认模型新建对话指令（{model}）", {
          model: modelLabel,
        }),
        "success"
      );
    } catch (err) {
      onToast?.(
        err?.message ||
          tr("model.createConvFailed", "宿主环境暂不支持自动触发新建，请在左侧主栏手动新建对话"),
        "error"
      );
    } finally {
      isCreatingConv = false;
      if (newConvBtn) newConvBtn.disabled = false;
      if (newConvConfirmBtn) newConvConfirmBtn.disabled = false;
    }
  }

  if (newConvBtn) {
    newConvBtn.setAttribute("aria-expanded", "false");
    const onNewConvClick = () => {
      if (isCreatingConv) return;
      if (newConvDrawer && !newConvDrawer.hidden) {
        closeNewConvDrawer();
        return;
      }
      const opened = openNewConvDrawer();
      if (!opened) {
        submitNewConversation();
      }
    };
    newConvBtn.addEventListener("click", onNewConvClick);
    cleanups.push(() => newConvBtn.removeEventListener("click", onNewConvClick));
  }

  if (promptBtn && promptDropdown) {
    const onPromptBtnClick = (e) => {
      e.stopPropagation();
      setModelDropdownOpen(false);
      setPromptDropdownOpen(promptDropdown.hidden);
    };
    promptBtn.addEventListener("click", onPromptBtnClick);
    cleanups.push(() => promptBtn.removeEventListener("click", onPromptBtnClick));
  }

  if (promptImportBtn && promptMdInput) {
    const onImportClick = () => {
      setModelDropdownOpen(false);
      setPromptDropdownOpen(false);
      promptMdInput.click();
    };
    const onFileChange = () => {
      const file = promptMdInput.files && promptMdInput.files[0];
      promptMdInput.value = "";
      if (file) handleMdImport(file);
    };
    promptImportBtn.addEventListener("click", onImportClick);
    promptMdInput.addEventListener("change", onFileChange);
    cleanups.push(() => promptImportBtn.removeEventListener("click", onImportClick));
    cleanups.push(() => promptMdInput.removeEventListener("change", onFileChange));
  }

  if (promptHelpBtn) {
    const onHelpClick = () => openHelpModal();
    promptHelpBtn.addEventListener("click", onHelpClick);
    cleanups.push(() => promptHelpBtn.removeEventListener("click", onHelpClick));
  }

  if (promptHelpModal) {
    promptHelpModal.querySelectorAll("[data-modal-close]").forEach((el) => {
      const onCloseClick = () => closeHelpModal();
      el.addEventListener("click", onCloseClick);
      cleanups.push(() => el.removeEventListener("click", onCloseClick));
    });
  }

  const onDocClick = (e) => {
    if (modelSelector && !modelSelector.contains(e.target)) {
      setModelDropdownOpen(false);
    }
    if (promptSelector && !promptSelector.contains(e.target)) {
      setPromptDropdownOpen(false);
    }
  };

  const onDocKeyDown = (e) => {
    if (e.key !== "Escape") return;
    if (promptHelpModal && !promptHelpModal.hidden) {
      closeHelpModal();
      return;
    }
    if (newConvDrawer && !newConvDrawer.hidden) {
      closeNewConvDrawer();
      newConvBtn?.focus();
      return;
    }
    if (modelDropdown && !modelDropdown.hidden) {
      setModelDropdownOpen(false);
      modelBtn?.focus();
    }
    if (promptDropdown && !promptDropdown.hidden) {
      setPromptDropdownOpen(false);
      promptBtn?.focus();
    }
  };

  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKeyDown);
  cleanups.push(() => document.removeEventListener("click", onDocClick));
  cleanups.push(() => document.removeEventListener("keydown", onDocKeyDown));

  renderModelTrigger();
  renderModelOptions();
  renderPromptTrigger();
  renderPromptOptions();

  return {
    update(prefs) {
      if (!prefs || typeof prefs !== "object") return;
      if (Array.isArray(prefs.availableModels)) {
        models = prefs.availableModels.map(normalizeModel).filter(Boolean);
      }
      if (prefs.defaultModel !== undefined) {
        if (typeof prefs.defaultModel === "string") {
          defaultModel = { id: prefs.defaultModel, tier: "" };
        } else if (prefs.defaultModel && typeof prefs.defaultModel === "object") {
          defaultModel = {
            id: String(prefs.defaultModel.id || ""),
            tier: String(prefs.defaultModel.tier || ""),
          };
        } else {
          defaultModel = { id: "", tier: "" };
        }
      }
      if (Array.isArray(prefs.prompts)) {
        prompts = prefs.prompts.map(normalizePrompt).filter(Boolean);
      }
      if (prefs.activePromptId) {
        activePromptId = String(prefs.activePromptId);
      }
      renderModelTrigger();
      renderModelOptions();
      renderPromptTrigger();
      renderPromptOptions();
    },
    setTranslator(nextT) {
      translator = nextT;
      renderModelTrigger();
      renderModelOptions();
      renderPromptTrigger();
      renderPromptOptions();
      syncNewConvDrawerLocale();
    },
    destroy() {
      if (statusHideTimer) {
        clearTimeout(statusHideTimer);
        statusHideTimer = null;
      }
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
