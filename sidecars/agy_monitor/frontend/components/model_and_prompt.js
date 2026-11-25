/**
 * System prompt rules selector (builtin presets, custom .md import with security
 * feedback, and ? security help modal).
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
 * Mounts prompt rules dropdown, .md importer, and ? security help modal.
 */
export function createModelAndPrompt({
  apiFetch,
  t,
  onPromptChanged,
  onToast,
} = {}) {
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
  let prompts = [];
  let activePromptId = "official";
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

  function setPromptDropdownOpen(open) {
    if (!promptDropdown || !promptSelector || !promptBtn) return;
    promptDropdown.hidden = !open;
    promptSelector.classList.toggle("is-open", open);
    promptBtn.setAttribute("aria-expanded", String(open));
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

  if (promptBtn && promptDropdown) {
    const onPromptBtnClick = (e) => {
      e.stopPropagation();
      setPromptDropdownOpen(promptDropdown.hidden);
    };
    promptBtn.addEventListener("click", onPromptBtnClick);
    cleanups.push(() => promptBtn.removeEventListener("click", onPromptBtnClick));
  }

  if (promptImportBtn && promptMdInput) {
    const onImportClick = () => {
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
    if (promptDropdown && !promptDropdown.hidden) {
      setPromptDropdownOpen(false);
      promptBtn?.focus();
    }
  };

  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKeyDown);
  cleanups.push(() => document.removeEventListener("click", onDocClick));
  cleanups.push(() => document.removeEventListener("keydown", onDocKeyDown));

  renderPromptTrigger();
  renderPromptOptions();

  return {
    update(prefs) {
      if (!prefs || typeof prefs !== "object") return;
      if (Array.isArray(prefs.prompts)) {
        prompts = prefs.prompts.map(normalizePrompt).filter(Boolean);
      }
      if (prefs.activePromptId) {
        activePromptId = String(prefs.activePromptId);
      }
      renderPromptTrigger();
      renderPromptOptions();
    },
    setTranslator(nextT) {
      translator = nextT;
      renderPromptTrigger();
      renderPromptOptions();
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
