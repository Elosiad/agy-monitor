/**
 * Mastery ("掌握") tab controller:
 * - Top flat session process bar (active first -> completed unread, right progress ring follows Main Agent)
 * - Summary model row (default OFF; single radio "自身模型" vs "第三方模型" modal; expanded frequency & thinking)
 * - View 1: Task total progress (follows Main Agent) + Left-Master / Right-Sub 3-state SVG collaboration graph
 * - View 2: Codex-style Agent execution journey (brief, opening thought & summaries, collapsible classified actions)
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const POLL_INTERVAL_MS = 2000;
const LOCAL_IMAGE_CACHE_MAX = 16;
const COMPOSER_DRAFT_MAX_SESSIONS = 12;

const PROTOCOL_PRESETS = {
  openai: {
    name: "OpenAI",
    hint: "兼容 OpenAI / DeepSeek / 中转站 / 本地 Ollama",
    urlPlaceholder: "https://api.openai.com/v1",
    keyPlaceholder: "sk-...",
    models: [
      "gpt-4o-mini",
      "gpt-4.1-nano",
      "gpt-4.1-mini",
      "deepseek-chat",
      "qwen-turbo-latest",
      "glm-4.5-air",
    ],
  },
  anthropic: {
    name: "Anthropic",
    hint: "兼容 Anthropic Messages / Claude 官方及代理中转",
    urlPlaceholder: "https://api.anthropic.com/v1",
    keyPlaceholder: "sk-ant-...",
    models: [
      "claude-3-5-haiku-latest",
      "claude-haiku-4-5",
      "claude-3-7-sonnet-latest",
      "claude-sonnet-4-5",
    ],
  },
};

function makeSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  return el;
}

function buildStarIconSvg(filled) {
  const svg = makeSvgEl("svg", {
    width: 11,
    height: 11,
    viewBox: "0 0 16 16",
    fill: filled ? "currentColor" : "none",
    "aria-hidden": "true",
  });
  svg.appendChild(
    makeSvgEl("path", {
      d: "m8 2.2 1.8 3.65 4.03.59-2.91 2.84.69 4.01L8 11.4l-3.61 1.89.69-4.01-2.91-2.84 4.03-.59L8 2.2Z",
      stroke: "currentColor",
      "stroke-width": "1.25",
      "stroke-linejoin": "round",
    })
  );
  return svg;
}

function buildActionIconSvg(kind) {
  const svg = makeSvgEl("svg", {
    width: 13,
    height: 13,
    viewBox: "0 0 16 16",
    fill: "none",
    "aria-hidden": "true",
  });
  if (kind === "edit") {
    svg.appendChild(
      makeSvgEl("path", {
        d: "M11.6 2.6a1.5 1.5 0 0 1 2.1 2.1L6.2 12.2l-3 .8.8-3 7.6-7.4z",
        stroke: "currentColor",
        "stroke-width": "1.35",
        "stroke-linejoin": "round",
      })
    );
  } else if (kind === "read") {
    svg.appendChild(
      makeSvgEl("path", {
        d: "M4 2.5h5.5L13 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z",
        stroke: "currentColor",
        "stroke-width": "1.3",
        "stroke-linejoin": "round",
      })
    );
    svg.appendChild(
      makeSvgEl("path", {
        d: "M5.5 8.5h5M5.5 11h3.5",
        stroke: "currentColor",
        "stroke-width": "1.25",
        "stroke-linecap": "round",
      })
    );
  } else if (kind === "search") {
    svg.appendChild(
      makeSvgEl("circle", {
        cx: "7.2",
        cy: "7.2",
        r: "4.2",
        stroke: "currentColor",
        "stroke-width": "1.3",
      })
    );
    svg.appendChild(
      makeSvgEl("path", {
        d: "M10.4 10.4L13.5 13.5",
        stroke: "currentColor",
        "stroke-width": "1.35",
        "stroke-linecap": "round",
      })
    );
  } else if (kind === "sync") {
    svg.appendChild(
      makeSvgEl("path", {
        d: "M3 5.5h9.5M9.5 3l3 2.5-3 2.5M13 10.5H3.5M6.5 8l-3 2.5 3 2.5",
        stroke: "currentColor",
        "stroke-width": "1.25",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })
    );
  } else {
    svg.appendChild(
      makeSvgEl("rect", {
        x: "1.8",
        y: "2.6",
        width: "12.4",
        height: "10.8",
        rx: "2.2",
        stroke: "currentColor",
        "stroke-width": "1.3",
      })
    );
    svg.appendChild(
      makeSvgEl("path", {
        d: "M5 6.4l2.2 1.8L5 10",
        stroke: "currentColor",
        "stroke-width": "1.3",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })
    );
    svg.appendChild(
      makeSvgEl("path", {
        d: "M8.5 10h2.5",
        stroke: "currentColor",
        "stroke-width": "1.3",
        "stroke-linecap": "round",
      })
    );
  }
  return svg;
}

const RASTER_IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp)(?:[?#].*)?$/i;

function looksLikeLocalAbsPath(raw) {
  const s = String(raw || "").trim();
  if (!s || /[\r\n<>"]/.test(s)) return false;
  if (/^file:\/\/(?:\/|localhost\/)/i.test(s)) return true;
  if (/^[a-zA-Z]:[\\/][^\s*?"<>|]+$/.test(s)) return true;
  if (/^\/(?:Users|home|var|tmp|opt|etc|mnt|Volumes)\/[^\s]+$/.test(s)) return true;
  return false;
}

function isLocalRasterImageTarget(raw) {
  if (!looksLikeLocalAbsPath(raw)) return false;
  const decoded = decodeDisplayUrl(raw);
  return RASTER_IMAGE_EXT_RE.test(decoded);
}

function isSafeHttpUrl(raw) {
  return /^https?:\/\/[^\s<>"]+$/i.test(String(raw || "").trim());
}

function buildPathIconSvg(isImage = false) {
  const svg = makeSvgEl("svg", {
    width: 11,
    height: 11,
    viewBox: "0 0 16 16",
    fill: "none",
    "aria-hidden": "true",
    class: "mad-path-icon",
  });
  if (isImage) {
    svg.appendChild(
      makeSvgEl("rect", {
        x: "2",
        y: "3",
        width: "12",
        height: "10",
        rx: "1.8",
        stroke: "currentColor",
        "stroke-width": "1.35",
      })
    );
    svg.appendChild(
      makeSvgEl("circle", {
        cx: "5.8",
        cy: "6.4",
        r: "1.1",
        fill: "currentColor",
      })
    );
    svg.appendChild(
      makeSvgEl("path", {
        d: "M3 11.4l3.1-3 2.3 2.1 1.9-1.7 2.7 2.6",
        stroke: "currentColor",
        "stroke-width": "1.25",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })
    );
  } else {
    svg.appendChild(
      makeSvgEl("path", {
        d: "M2.2 4.4A1.4 1.4 0 0 1 3.6 3h3l1.3 1.4h4.5a1.4 1.4 0 0 1 1.4 1.4v5.8a1.4 1.4 0 0 1-1.4 1.4H3.6a1.4 1.4 0 0 1-1.4-1.4V4.4z",
        stroke: "currentColor",
        "stroke-width": "1.3",
        "stroke-linejoin": "round",
      })
    );
  }
  return svg;
}

function decodeDisplayUrl(rawUrl) {
  const cleaned = String(rawUrl || "").replace(/%[0-9a-fA-F]?$/, "");
  let decoded = cleaned;
  try {
    decoded = decodeURIComponent(cleaned);
  } catch {
    decoded = cleaned.replace(/(?:%[0-9a-fA-F]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
  const stripped = decoded.replace(/^file:\/\/localhost\//i, "/").replace(/^file:\/\/\/+/i, "");
  return /^\/+[a-zA-Z]:[\\/]/.test(stripped) ? stripped.replace(/^\/+/, "") : stripped;
}

function extractFileUriLabel(rawUrl) {
  const decoded = decodeDisplayUrl(rawUrl);
  const hashIdx = decoded.indexOf("#");
  const filePart = hashIdx >= 0 ? decoded.slice(0, hashIdx) : decoded;
  const anchor = hashIdx >= 0 ? decoded.slice(hashIdx) : "";
  const parts = filePart.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = parts[parts.length - 1] || decoded;
  return anchor && anchor.length <= 18 ? `${base}${anchor}` : base;
}

function appendPlainSpan(parent, text) {
  if (!text) return;
  const span = document.createElement("span");
  span.textContent = text;
  parent.appendChild(span);
}

function createLocalPathChip(label, rawTarget, ctx, { isCode = true, isImage = false } = {}) {
  const displayPath = decodeDisplayUrl(rawTarget);
  const el = document.createElement(ctx?.onOpenPath ? "button" : "span");
  if (el.tagName === "BUTTON") {
    el.type = "button";
  }
  el.className = `mad-md-link${isCode ? " is-code" : ""}${ctx?.onOpenPath ? " is-path" : ""}`;
  el.appendChild(buildPathIconSvg(isImage));
  const txt = document.createElement("span");
  txt.textContent = label || extractFileUriLabel(rawTarget);
  el.appendChild(txt);
  el.title = ctx?.onOpenPath ? `点击打开目录：${displayPath}` : displayPath;
  if (ctx?.onOpenPath) {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctx.onOpenPath(rawTarget);
    });
  }
  return el;
}

function createInlineImageChip(label, rawTarget, ctx) {
  const displayPath = decodeDisplayUrl(rawTarget);
  const cleanLabel = label || extractFileUriLabel(rawTarget);
  const clickable = typeof ctx?.loadLocalImage === "function" || typeof ctx?.onOpenPath === "function";
  const el = document.createElement(clickable ? "button" : "span");
  if (el.tagName === "BUTTON") {
    el.type = "button";
  }
  el.className = `mad-md-link is-code is-img-ref${clickable ? " is-path" : ""}`;
  el.appendChild(buildPathIconSvg(true));
  const txt = document.createElement("span");
  txt.textContent = cleanLabel;
  el.appendChild(txt);
  el.title = typeof ctx?.loadLocalImage === "function"
    ? `${cleanLabel}（点击放大预览）`
    : (ctx?.onOpenPath ? `点击打开目录：${displayPath}` : displayPath);
  if (clickable) {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof ctx?.loadLocalImage === "function" && typeof ctx?.onPreviewImage === "function") {
        Promise.resolve(ctx.loadLocalImage(rawTarget))
          .then((url) => {
            if (url) {
              ctx.onPreviewImage({ url, targetPath: rawTarget, label: cleanLabel });
            } else if (ctx?.onOpenPath) {
              ctx.onOpenPath(rawTarget);
            }
          })
          .catch(() => {
            if (ctx?.onOpenPath) ctx.onOpenPath(rawTarget);
          });
      } else if (ctx?.onOpenPath) {
        ctx.onOpenPath(rawTarget);
      }
    });
  }
  return el;
}

function createLocalImagePreview(label, rawTarget, ctx, { removeOnFail = false } = {}) {
  const cleanLabel = label || extractFileUriLabel(rawTarget);

  if (typeof ctx?.loadLocalImage !== "function") {
    return createLocalPathChip(cleanLabel, rawTarget, ctx, { isCode: true, isImage: true });
  }

  const wrap = document.createElement("span");
  wrap.className = "mad-md-img-wrap";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mad-md-img-card";
  btn.title = `${cleanLabel}（点击放大预览）`;

  const img = document.createElement("img");
  img.className = "mad-md-img-el";
  img.alt = cleanLabel;
  img.loading = "lazy";

  const zoomBadge = document.createElement("span");
  zoomBadge.className = "mad-md-img-zoom-badge";
  zoomBadge.setAttribute("aria-hidden", "true");
  zoomBadge.appendChild(buildActionIconSvg("search"));

  btn.appendChild(img);
  btn.appendChild(zoomBadge);

  let loadedUrl = "";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof ctx?.onPreviewImage === "function" && loadedUrl) {
      ctx.onPreviewImage({ url: loadedUrl, targetPath: rawTarget, label: cleanLabel });
    } else if (ctx?.onOpenPath) {
      ctx.onOpenPath(rawTarget);
    }
  });

  wrap.appendChild(btn);

  const fallbackToChip = () => {
    if (!wrap.isConnected && !wrap.parentNode) return;
    if (removeOnFail) {
      const parentGallery = wrap.parentNode;
      wrap.remove();
      if (parentGallery && parentGallery.classList?.contains("mad-md-img-gallery") && parentGallery.childElementCount === 0) {
        parentGallery.remove();
      }
      return;
    }
    wrap.textContent = "";
    wrap.appendChild(createLocalPathChip(cleanLabel, rawTarget, ctx, { isCode: true, isImage: true }));
  };

  img.addEventListener("error", fallbackToChip);
  Promise.resolve(ctx.loadLocalImage(rawTarget))
    .then((url) => {
      if (url) {
        loadedUrl = url;
        img.src = url;
      } else {
        fallbackToChip();
      }
    })
    .catch(fallbackToChip);

  return wrap;
}

function appendInlineImageToken(parent, label, rawTarget, ctx) {
  const cleanLabel = label || extractFileUriLabel(rawTarget);
  if (typeof ctx?.collectImage === "function" && typeof ctx?.loadLocalImage === "function") {
    ctx.collectImage(cleanLabel, rawTarget);
    parent.appendChild(createInlineImageChip(cleanLabel, rawTarget, ctx));
    return;
  }
  parent.appendChild(createLocalImagePreview(cleanLabel, rawTarget, ctx));
}

function findMatchingInlineClose(src, startIdx, delim) {
  let i = startIdx;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") {
      const endTick = src.indexOf("`", i + 1);
      if (endTick > i) {
        i = endTick + 1;
        continue;
      }
    }
    if (src.startsWith(delim, i)) {
      return i;
    }
    i += 1;
  }
  return -1;
}

function parseLinkTargetAt(src, openParenIdx) {
  let depth = 1;
  let i = openParenIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (depth === 0) return i;
    i += 1;
  }
  return -1;
}

function appendMarkdownInline(parent, text, ctx = {}, depth = 0) {
  const src = String(text || "");
  if (!src) return;
  if (depth > 4) {
    appendPlainSpan(parent, src);
    return;
  }

  let i = 0;
  let plainBuf = "";
  const flushPlain = () => {
    if (plainBuf) {
      appendPlainSpan(parent, plainBuf);
      plainBuf = "";
    }
  };

  while (i < src.length) {
    const ch = src[i];

    // Escaped markdown punctuation
    if (ch === "\\" && i + 1 < src.length && /[\\`*_{}\[\]()#+\-.!~|]/.test(src[i + 1])) {
      plainBuf += src[i + 1];
      i += 2;
      continue;
    }

    // Inline code `...`
    if (ch === "`") {
      const closeIdx = src.indexOf("`", i + 1);
      if (closeIdx > i + 1) {
        const inner = src.slice(i + 1, closeIdx);
        flushPlain();
        if (isLocalRasterImageTarget(inner)) {
          appendInlineImageToken(parent, extractFileUriLabel(inner), inner, ctx);
        } else if (looksLikeLocalAbsPath(inner)) {
          parent.appendChild(createLocalPathChip(inner, inner, ctx, { isCode: true }));
        } else {
          const code = document.createElement("code");
          code.className = "mad-md-code";
          code.textContent = inner;
          parent.appendChild(code);
        }
        i = closeIdx + 1;
        continue;
      }
    }

    // Markdown image ![alt](url) or link [label](url)
    if ((ch === "!" && src[i + 1] === "[") || ch === "[") {
      const isImgSyntax = ch === "!";
      const openBracket = isImgSyntax ? i + 1 : i;
      const closeBracket = src.indexOf("]", openBracket + 1);
      if (closeBracket > openBracket && src[closeBracket + 1] === "(") {
        const closeParen = parseLinkTargetAt(src, closeBracket + 1);
        if (closeParen > closeBracket + 2) {
          const rawLabel = src.slice(openBracket + 1, closeBracket).trim();
          const rawTarget = src.slice(closeBracket + 2, closeParen).trim().replace(/^<|>$/g, "");
          const unwrappedCode = /^`(.+)`$/.exec(rawLabel);
          const cleanLabel = (unwrappedCode ? unwrappedCode[1] : rawLabel).replace(/^\*\*(.+)\*\*$/, "$1").trim();

          flushPlain();
          if (isLocalRasterImageTarget(rawTarget)) {
            appendInlineImageToken(parent, cleanLabel || extractFileUriLabel(rawTarget), rawTarget, ctx);
          } else if (looksLikeLocalAbsPath(rawTarget)) {
            const looksLikeFile =
              Boolean(unwrappedCode) || /[\\/]/.test(cleanLabel) || /\.[a-z0-9]{1,8}(?::\d+|#L\d+)?$/i.test(cleanLabel);
            parent.appendChild(createLocalPathChip(cleanLabel || extractFileUriLabel(rawTarget), rawTarget, ctx, { isCode: looksLikeFile }));
          } else if (isSafeHttpUrl(rawTarget)) {
            const a = document.createElement("a");
            a.className = "mad-md-link is-web";
            a.href = rawTarget;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = cleanLabel || rawTarget;
            a.title = rawTarget;
            parent.appendChild(a);
          } else {
            const chip = document.createElement("span");
            chip.className = "mad-md-link";
            chip.textContent = cleanLabel || rawTarget;
            chip.title = rawTarget;
            parent.appendChild(chip);
          }
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Bold **...** or __...__ (recursively parses nested links, code, italic!)
    if ((ch === "*" && src[i + 1] === "*") || (ch === "_" && src[i + 1] === "_")) {
      const delim = src.slice(i, i + 2);
      const closeIdx = findMatchingInlineClose(src, i + 2, delim);
      if (closeIdx > i + 2) {
        const inner = src.slice(i + 2, closeIdx);
        if (inner.trim()) {
          flushPlain();
          const strong = document.createElement("strong");
          strong.className = "mad-md-bold";
          appendMarkdownInline(strong, inner, ctx, depth + 1);
          parent.appendChild(strong);
          i = closeIdx + 2;
          continue;
        }
      }
    }

    // Strikethrough ~~...~~
    if (ch === "~" && src[i + 1] === "~") {
      const closeIdx = findMatchingInlineClose(src, i + 2, "~~");
      if (closeIdx > i + 2) {
        const inner = src.slice(i + 2, closeIdx);
        if (inner.trim()) {
          flushPlain();
          const del = document.createElement("del");
          del.className = "mad-md-del";
          appendMarkdownInline(del, inner, ctx, depth + 1);
          parent.appendChild(del);
          i = closeIdx + 2;
          continue;
        }
      }
    }

    // Italic *...* (avoid matching list bullets or bare spaces)
    if (ch === "*" && src[i + 1] !== "*" && src[i + 1] !== " ") {
      const closeIdx = findMatchingInlineClose(src, i + 1, "*");
      if (closeIdx > i + 1 && src[closeIdx - 1] !== " ") {
        const inner = src.slice(i + 1, closeIdx);
        if (inner.trim()) {
          flushPlain();
          const em = document.createElement("em");
          em.className = "mad-md-em";
          appendMarkdownInline(em, inner, ctx, depth + 1);
          parent.appendChild(em);
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // Bare file:/// URI
    if ((ch === "f" || ch === "F") && /^file:\/\/\//i.test(src.slice(i, i + 8))) {
      const m = /^file:\/\/\/[^\s<>)"']+/.exec(src.slice(i));
      if (m) {
        const uri = m[0].replace(/[.,;:!?。，；：！？]+$/, "");
        flushPlain();
        if (isLocalRasterImageTarget(uri)) {
          appendInlineImageToken(parent, extractFileUriLabel(uri), uri, ctx);
        } else {
          parent.appendChild(createLocalPathChip(extractFileUriLabel(uri), uri, ctx, { isCode: true }));
        }
        i += uri.length;
        continue;
      }
    }

    // Bare https:// or http:// URL
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(src.slice(i, i + 8))) {
      const m = /^https?:\/\/[^\s<>)"']+/.exec(src.slice(i));
      if (m) {
        const url = m[0].replace(/[.,;:!?。，；：！？]+$/, "");
        flushPlain();
        const a = document.createElement("a");
        a.className = "mad-md-link is-web";
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = url;
        a.title = url;
        parent.appendChild(a);
        i += url.length;
        continue;
      }
    }

    plainBuf += ch;
    i += 1;
  }

  flushPlain();
}

function splitTableRow(line) {
  let trimmed = String(line || "").trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((c) => c.trim());
}

function isTableSeparatorLine(line) {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function parseTableAlignments(line) {
  return splitTableRow(line).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

const ALERT_LABEL_MAP = {
  NOTE: { cls: "is-note", label: "说明" },
  TIP: { cls: "is-tip", label: "提示" },
  IMPORTANT: { cls: "is-important", label: "重要" },
  WARNING: { cls: "is-warning", label: "注意" },
  CAUTION: { cls: "is-caution", label: "警示" },
};

function hasNonImageProse(node) {
  if (!node || !node.childNodes) return false;
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      if (String(child.nodeValue || "").replace(/[\s,，、;；·|+]+/g, "").length > 0) return true;
    } else if (child.nodeType === 1) {
      if (child.classList?.contains("is-img-ref")) continue;
      if (child.tagName === "SPAN" && !child.childElementCount) {
        if (String(child.textContent || "").replace(/[\s,，、;；·|+]+/g, "").length > 0) return true;
      } else if (hasNonImageProse(child)) {
        return true;
      }
    }
  }
  return false;
}

function appendBlockContentWithGallery(hostEl, rawLine, ctx = {}) {
  const collected = [];
  const seen = new Set();
  const textWrap = document.createElement("div");
  textWrap.className = "mad-md-inline-text";

  const collectCtx = {
    ...ctx,
    collectImage(label, rawTarget) {
      const key = String(rawTarget || "").trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      collected.push({ label, rawTarget });
    },
  };

  appendMarkdownInline(textWrap, rawLine, collectCtx);
  if (collected.length === 0) {
    while (textWrap.firstChild) {
      hostEl.appendChild(textWrap.firstChild);
    }
    return { standaloneGallery: null, images: collected };
  }

  const hasProse = hasNonImageProse(textWrap);
  if (hasProse) {
    hostEl.appendChild(textWrap);
  }

  const gallery = document.createElement("div");
  gallery.className = "mad-md-img-gallery";
  collected.forEach(({ label, rawTarget }) => {
    gallery.appendChild(createLocalImagePreview(label, rawTarget, ctx, { removeOnFail: hasProse }));
  });
  hostEl.appendChild(gallery);
  return { standaloneGallery: hasProse ? null : gallery, images: collected };
}

/**
 * Pure-DOM, zero-innerHTML native Antigravity Markdown renderer for Codex journey messages.
 * Supports headings (H1-H6), GFM tables, alert callouts, blockquotes, fenced code with language,
 * task/bullet/ordered lists, nested bold/italic/strikethrough/inline-code, clickable local path chips,
 * and clean grouped local raster image galleries below prose lines.
 */
function renderSafeMarkdown(container, rawText, ctx = {}) {
  container.textContent = "";
  const lines = String(rawText || "").replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  let fenceLang = "";
  let fenceLines = [];

  const flushFence = () => {
    const pre = document.createElement("pre");
    pre.className = "mad-md-pre";
    if (fenceLang) {
      const head = document.createElement("div");
      head.className = "mad-md-pre-head";
      head.textContent = fenceLang;
      pre.appendChild(head);
    }
    const code = document.createElement("code");
    code.className = "mad-md-pre-code";
    code.textContent = fenceLines.join("\n");
    pre.appendChild(code);
    container.appendChild(pre);
    fenceLines = [];
    fenceLang = "";
  };

  let fenceTickLen = 3;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inFence) {
      const closeRe = new RegExp(`^\\s*\`{${fenceTickLen},}\\s*$`);
      if (closeRe.test(line)) {
        flushFence();
        inFence = false;
      } else {
        fenceLines.push(line);
      }
      continue;
    }
    const openMatch = /^\s*(`{3,})([^\n`]*)$/.exec(line);
    if (openMatch) {
      inFence = true;
      fenceTickLen = openMatch[1].length;
      const infoToken = String(openMatch[2] || "").trim().split(/\s+/)[0] || "";
      fenceLang = /^[a-zA-Z0-9_+#.-]+$/.test(infoToken) ? infoToken : "";
      fenceLines = [];
      continue;
    }
    if (!line.trim()) continue;

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      const hr = document.createElement("div");
      hr.className = "mad-md-hr";
      container.appendChild(hr);
      continue;
    }

    // GFM Markdown table
    if (line.includes("|") && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      const headers = splitTableRow(line);
      const aligns = parseTableAlignments(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;

      const wrap = document.createElement("div");
      wrap.className = "mad-md-table-wrap";
      const table = document.createElement("table");
      table.className = "mad-md-table";

      const thead = document.createElement("thead");
      const htr = document.createElement("tr");
      headers.forEach((hText, colIdx) => {
        const th = document.createElement("th");
        if (aligns[colIdx]) th.style.textAlign = aligns[colIdx];
        appendMarkdownInline(th, hText, ctx);
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);

      if (rows.length > 0) {
        const tbody = document.createElement("tbody");
        rows.forEach((row) => {
          const tr = document.createElement("tr");
          for (let c = 0; c < headers.length; c += 1) {
            const td = document.createElement("td");
            if (aligns[c]) td.style.textAlign = aligns[c];
            appendMarkdownInline(td, row[c] || "", ctx);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
      }
      wrap.appendChild(table);
      container.appendChild(wrap);
      continue;
    }

    const headingMatch = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length);
      const h = document.createElement("div");
      h.className = `mad-md-heading is-h${level}`;
      appendMarkdownInline(h, headingMatch[2], ctx);
      container.appendChild(h);
      continue;
    }

    // Blockquote & GitHub/Antigravity callout alert (> [!TIP] / > [!WARNING] etc.)
    const quoteMatch = /^\s*>\s?(.*)$/.exec(line);
    if (quoteMatch) {
      const alertHeader = /^\[\!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(quoteMatch[1].trim());
      if (alertHeader) {
        const meta = ALERT_LABEL_MAP[alertHeader[1].toUpperCase()] || ALERT_LABEL_MAP.NOTE;
        const alertBox = document.createElement("div");
        alertBox.className = `mad-md-alert ${meta.cls}`;
        const titleEl = document.createElement("div");
        titleEl.className = "mad-md-alert-title";
        titleEl.textContent = meta.label;
        alertBox.appendChild(titleEl);
        const bodyLines = [];
        if (alertHeader[2]) bodyLines.push(alertHeader[2]);
        while (i + 1 < lines.length && /^\s*>\s?(.*)$/.test(lines[i + 1])) {
          i += 1;
          bodyLines.push(/^\s*>\s?(.*)$/.exec(lines[i])[1]);
        }
        bodyLines.forEach((bl) => {
          if (!bl.trim()) return;
          const pLine = document.createElement("div");
          pLine.className = "mad-md-alert-body";
          appendBlockContentWithGallery(pLine, bl, ctx);
          alertBox.appendChild(pLine);
        });
        container.appendChild(alertBox);
        continue;
      }

      const q = document.createElement("div");
      q.className = "mad-md-quote";
      appendBlockContentWithGallery(q, quoteMatch[1], ctx);
      container.appendChild(q);
      continue;
    }

    // Task list item (- [x] / - [ ])
    const taskMatch = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (taskMatch) {
      const indent = taskMatch[1].replace(/\t/g, "  ").length;
      const checked = taskMatch[2].toLowerCase() === "x";
      const li = document.createElement("div");
      li.className = `mad-md-li is-task${indent >= 2 ? " is-nested" : ""}`;
      const box = document.createElement("span");
      box.className = `mad-md-checkbox${checked ? " is-checked" : ""}`;
      box.textContent = checked ? "✓" : "";
      const body = document.createElement("div");
      body.className = "mad-md-li-body";
      appendBlockContentWithGallery(body, taskMatch[3], ctx);
      li.appendChild(box);
      li.appendChild(body);
      container.appendChild(li);
      continue;
    }

    const ulMatch = /^(\s*)[-*+•]\s+(.+)$/.exec(line);
    if (ulMatch) {
      const indent = ulMatch[1].replace(/\t/g, "  ").length;
      const li = document.createElement("div");
      li.className = `mad-md-li${indent >= 2 ? " is-nested" : ""}`;
      const bullet = document.createElement("span");
      bullet.className = "mad-md-bullet";
      bullet.textContent = indent >= 2 ? "◦" : "•";
      const body = document.createElement("div");
      body.className = "mad-md-li-body";
      appendBlockContentWithGallery(body, ulMatch[2], ctx);
      li.appendChild(bullet);
      li.appendChild(body);
      container.appendChild(li);
      continue;
    }

    const olMatch = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line);
    if (olMatch) {
      const indent = olMatch[1].replace(/\t/g, "  ").length;
      const li = document.createElement("div");
      li.className = `mad-md-li is-ordered${indent >= 2 ? " is-nested" : ""}`;
      const num = document.createElement("span");
      num.className = "mad-md-bullet is-num";
      num.textContent = `${olMatch[2]}.`;
      const body = document.createElement("div");
      body.className = "mad-md-li-body";
      appendBlockContentWithGallery(body, olMatch[3], ctx);
      li.appendChild(num);
      li.appendChild(body);
      container.appendChild(li);
      continue;
    }

    const p = document.createElement("div");
    p.className = "mad-md-p";
    const blockRes = appendBlockContentWithGallery(p, line, ctx);
    // Merge consecutive standalone image lines into one side-by-side gallery row
    if (
      blockRes.standaloneGallery &&
      container.lastElementChild?.classList?.contains("mad-md-img-gallery") &&
      container.lastElementChild.classList.contains("is-standalone")
    ) {
      while (blockRes.standaloneGallery.firstChild) {
        container.lastElementChild.appendChild(blockRes.standaloneGallery.firstChild);
      }
      continue;
    }
    if (blockRes.standaloneGallery) {
      blockRes.standaloneGallery.classList.add("is-standalone");
      container.appendChild(blockRes.standaloneGallery);
      continue;
    }
    container.appendChild(p);
  }

  if (inFence && fenceLines.length > 0) {
    flushFence();
  }
}

function buildChevronSvg() {
  const svg = makeSvgEl("svg", {
    width: 11,
    height: 11,
    viewBox: "0 0 12 12",
    fill: "none",
    "aria-hidden": "true",
  });
  svg.appendChild(
    makeSvgEl("path", {
      d: "M4.2 2.6L7.8 6l-3.6 3.4",
      stroke: "currentColor",
      "stroke-width": "1.35",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    })
  );
  return svg;
}

function createProgressRing(progress, status, size = 15) {
  const r = 6.2;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Number(progress) || 0));
  const dashLen = (pct / 100) * circ;
  const isActive = status === "active";
  const isDone = status === "done";

  const wrap = document.createElement("span");
  wrap.className = "mv-f-ring";
  wrap.title = isActive ? `主 Agent 进度 ${pct}%` : isDone ? "任务结束（已读）100%" : "任务结束未读 100%";

  const svg = makeSvgEl("svg", {
    width: size,
    height: size,
    viewBox: "0 0 18 18",
    "aria-hidden": "true",
  });
  svg.appendChild(
    makeSvgEl("circle", {
      class: "mv-f-ring-track",
      cx: 9,
      cy: 9,
      r,
      fill: "none",
      "stroke-width": 2.4,
    })
  );
  const arcMod = isActive ? "" : isDone ? " is-done" : " is-unread";
  svg.appendChild(
    makeSvgEl("circle", {
      class: `mv-f-ring-arc${arcMod}`,
      cx: 9,
      cy: 9,
      r,
      fill: "none",
      "stroke-width": 2.4,
      "stroke-dasharray": `${dashLen.toFixed(2)} ${circ.toFixed(2)}`,
      "stroke-linecap": "round",
      transform: "rotate(-90 9 9)",
    })
  );
  wrap.appendChild(svg);
  return wrap;
}

function createStatePill(stateKind, stateLabel) {
  const pill = document.createElement("span");
  pill.className = `mg-state-pill is-${stateKind || "unread"}`;
  if (stateKind === "sleep") {
    const moon = document.createElement("span");
    moon.className = "mg-pill-moon";
    moon.textContent = "☾";
    pill.appendChild(moon);
  } else {
    const dot = document.createElement("span");
    dot.className = "mg-pill-dot";
    pill.appendChild(dot);
  }
  const textSpan = document.createElement("span");
  textSpan.textContent = stateLabel || "";
  pill.appendChild(textSpan);
  return pill;
}

function createArrowMarker(id, colorClass) {
  const marker = makeSvgEl("marker", {
    id,
    viewBox: "0 0 8 8",
    refX: "6.4",
    refY: "4",
    markerWidth: "5.5",
    markerHeight: "5.5",
    orient: "auto",
  });
  marker.appendChild(
    makeSvgEl("path", {
      d: "M 1 1.2 L 7 4 L 1 6.8 z",
      class: `mg-marker-fill ${colorClass}`,
    })
  );
  return marker;
}

function glyphForActionKind(kind) {
  if (kind === "edit") return "✎";
  if (kind === "read") return "📄";
  if (kind === "search") return "🔍";
  if (kind === "sync") return "⇄";
  if (kind === "tool") return "⚙";
  return ">_";
}

async function callJson(apiFetch, url, options = {}) {
  const res = await apiFetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || data?.reason || `HTTP ${res.status}`);
  }
  return data;
}

export function createMasteryHub({ apiFetch, onSelectConversation, onFavoritesChanged, onToast } = {}) {
  const overviewViewEl = document.getElementById("masteryOverviewView");
  const detailViewEl = document.getElementById("masteryDetailView");
  const madBackBtn = document.getElementById("madBackBtn");
  const madJumpSessionBtn = document.getElementById("madJumpSessionBtn");
  const madRoleBadgeEl = document.getElementById("madRoleBadge");
  const madAgentNameEl = document.getElementById("madAgentName");
  const madStateSlotEl = document.getElementById("madStateSlot");
  const madSessionCrumbEl = document.getElementById("madSessionCrumb");
  const madDurationEl = document.getElementById("madDuration");
  const madTimelineEl = document.getElementById("madTimeline");
  const madComposerDock = document.getElementById("madComposerDock");
  const madSlashMenu = document.getElementById("madSlashMenu");
  const madComposerGlass = document.getElementById("madComposerGlass");
  const madAttachStrip = document.getElementById("madAttachStrip");
  const madComposerInput = document.getElementById("madComposerInput");
  const madComposerFileInput = document.getElementById("madComposerFileInput");
  const madComposerAttachBtn = document.getElementById("madComposerAttachBtn");
  const madComposerSlashBtn = document.getElementById("madComposerSlashBtn");
  const madComposerCmdChip = document.getElementById("madComposerCmdChip");
  const madComposerSendBtn = document.getElementById("madComposerSendBtn");

  const listEl = document.getElementById("masteryCliList");
  const totalCountEl = document.getElementById("masteryTotalCount");
  const summaryEl = document.getElementById("masteryStatusSummary");

  const overviewPctEl = document.getElementById("masteryOverviewPct");
  const overviewSummaryEl = document.getElementById("masteryOverviewSummary");
  const overviewJumpBtn = document.getElementById("masteryOverviewJumpBtn");
  const totalFillBarEl = document.getElementById("masteryTotalFillBar");
  const overviewGoalEl = document.getElementById("masteryOverviewGoal");

  const graphStageEl = document.getElementById("masteryGraphStage");
  const graphSvgEl = document.getElementById("masteryGraphSvg");
  const colMasterEl = document.getElementById("masteryColMaster");
  const colSubsEl = document.getElementById("masteryColSubs");

  // Summary model row controls (single radio "自身模型" + "第三方模型")
  const msmRowEl = document.getElementById("masterySummaryModelRow");
  const msmEnableToggle = document.getElementById("msmEnableToggle");
  const msmSourceTag = document.getElementById("msmSourceTag");
  const msmSelfBtn = document.getElementById("msmSelfBtn");
  const msmThirdPartyBtn = document.getElementById("msmThirdPartyBtn");
  const msmThirdPartyLabel = document.getElementById("msmThirdPartyLabel");
  const msmExtraRow = document.getElementById("msmExtraRow");
  const msmThinkGroup = document.getElementById("msmThinkGroup");
  const freqBtns = Array.from(document.querySelectorAll("[data-msm-freq]"));
  const thinkBtns = Array.from(document.querySelectorAll("[data-msm-think]"));

  // Third-party configuration modal
  const modalBackdrop = document.getElementById("masteryThirdPartyModal");
  const tpCloseBtn = document.getElementById("tpModalCloseBtn");
  const tpCancelBtn = document.getElementById("tpCancelBtn");
  const tpSaveBtn = document.getElementById("tpSaveBtn");
  const tpProtoBtns = Array.from(document.querySelectorAll("[data-tp-proto]"));
  const tpProtoHint = document.getElementById("tpProtoHint");
  const tpUrlInput = document.getElementById("tpBaseUrlInput");
  const tpKeyInput = document.getElementById("tpApiKeyInput");
  const tpToggleKeyBtn = document.getElementById("tpToggleKeyBtn");
  const tpModelSelect = document.getElementById("tpModelSelect");
  const tpFetchBtn = document.getElementById("tpFetchModelsBtn");
  const tpFetchStatus = document.getElementById("tpFetchStatus");
  const tpTestConnBtn = document.getElementById("tpTestConnBtn");
  const tpTestResult = document.getElementById("tpTestResult");

  const cleanups = [];
  let destroyed = false;
  let tabActive = false;
  let pollTimer = null;
  let inFlight = false;
  let resizeObserver = null;

  let selectedSessionId = "";
  let detailAgentKey = ""; // "" when in overview; e.g. "coord" or "sub-xxxx" when in View 2
  let hoveredAgentId = null;
  let lastSnapshot = null;
  let activeDetailSession = null;
  let configState = {
    enabled: false,
    source: "self",
    frequency: "1m",
    thinking: "low",
    thirdParty: {
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      hasApiKey: false,
      apiKeyMasked: "",
      fetchedModels: [...PROTOCOL_PRESETS.openai.models],
      selectedModel: "gpt-4o-mini",
    },
  };
  let configMutationSeq = 0;
  let configSaveInFlight = 0;
  let favoriteIdsState = [];
  let favoriteMutationSeq = 0;
  let favoriteSaveInFlight = 0;

  let draftProto = "openai";
  let draftModels = [...PROTOCOL_PRESETS.openai.models];
  const nodeElMap = new Map();
  const expandedGroupState = new Map();
  const localImageUrlCache = new Map();
  const createdObjectUrls = new Set();
  let lastRenderedConfigSig = "";
  let lastRenderedListSig = "";
  let lastRenderedGraphSig = "";
  let lastRenderedTimelineKey = "";
  let lastRenderedTimelineSig = "";

  // ========== Main Agent Frosted-Glass Composer State ==========
  const FALLBACK_SLASH_COMMANDS = [
    {
      name: "swarm",
      category: "builtin",
      badge: "Swarm",
      description: "(Preview & Quota Heavy) 启动多 Agent 协作集群并行处理任务",
    },
    { name: "plan", category: "builtin", badge: "官方", description: "先勘查代码与上下文，制定分步实现计划" },
    { name: "goal", category: "builtin", badge: "官方", description: "围绕单一目标持续深度推进并严格验收" },
    { name: "boost", category: "builtin", badge: "官方", description: "开启深度思考、多视角审视与严格校验模式" },
    { name: "grill-me", category: "builtin", badge: "官方", description: "通过交互式追问逐步对齐设计决策" },
    { name: "teamwork", category: "builtin", badge: "官方", description: "将大型项目拆分为多角色协作团队并行推进" },
    { name: "compact", category: "builtin", badge: "官方", description: "总结压缩上下文要点，释放窗口空间" },
    { name: "schedule", category: "builtin", badge: "官方", description: "在当前会话中设置定时或倒计时任务" },
    { name: "browser", category: "builtin", badge: "官方", description: "委派内置浏览器子 Agent 访问与交互网页" },
    { name: "learn", category: "builtin", badge: "官方", description: "总结经验教训并沉淀为后续规则偏好" },
  ];
  const COMPOSER_ALLOWED_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
  ]);
  const COMPOSER_EXT_MIMES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  const COMPOSER_MAX_IMAGES = 6;
  const COMPOSER_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  let composerCommands = [...FALLBACK_SLASH_COMMANDS];
  let composerCommandsLoaded = false;
  let composerSending = false;
  let composerCurrentSessionId = "";
  let composerAttachments = [];
  const composerDraftBySession = new Map();
  let slashMatches = [];
  let slashActiveIndex = 0;
  let slashTokenRange = null; // { start, end }
  let composerRefreshTimer = null;

  const resolveComposerImageMime = (file) => {
    const rawType = String(file?.type || "").trim().toLowerCase();
    if (rawType === "image/jpg") return "image/jpeg";
    if (COMPOSER_ALLOWED_MIMES.has(rawType)) return rawType;
    if (!rawType) {
      const name = String(file?.name || "").trim().toLowerCase();
      const dot = name.lastIndexOf(".");
      if (dot >= 0 && COMPOSER_EXT_MIMES[name.slice(dot)]) {
        return COMPOSER_EXT_MIMES[name.slice(dot)];
      }
    }
    return "";
  };

  const ensureComposerCommandsLoaded = async () => {
    if (composerCommandsLoaded || typeof apiFetch !== "function") return;
    composerCommandsLoaded = true;
    try {
      const res = await callJson(apiFetch, "/api/mastery/composer/commands");
      if (!destroyed && Array.isArray(res?.commands) && res.commands.length > 0) {
        composerCommands = res.commands;
        if (madSlashMenu && !madSlashMenu.hidden) {
          refreshSlashMenu();
        }
      }
    } catch {
      composerCommandsLoaded = false;
    }
  };

  const autoResizeComposerInput = () => {
    if (!madComposerInput) return;
    try {
      madComposerInput.style.height = "auto";
      const sh = Number(madComposerInput.scrollHeight || 0);
      if (sh > 0) {
        madComposerInput.style.height = `${Math.max(40, Math.min(144, sh))}px`;
      }
    } catch {
      // Ignore in miniDom test environment
    }
  };

  const getAttachmentBase64 = (att) => {
    if (!att) return "";
    if (att.base64) return att.base64;
    if (typeof att.dataUrl === "string") {
      const comma = att.dataUrl.indexOf(",");
      return comma >= 0 ? att.dataUrl.slice(comma + 1) : "";
    }
    return "";
  };

  const getAttachmentDataUrl = (att) => {
    if (!att) return "";
    const b64 = getAttachmentBase64(att);
    if (!b64) return "";
    return `data:${att.mime || "image/png"};base64,${b64}`;
  };

  const saveCurrentComposerDraft = () => {
    if (!composerCurrentSessionId || !madComposerInput) return;
    const text = String(madComposerInput.value || "");
    if (!text && composerAttachments.length === 0) {
      composerDraftBySession.delete(composerCurrentSessionId);
      return;
    }
    // Store one canonical base64 representation per attachment and maintain bounded LRU sessions
    composerDraftBySession.delete(composerCurrentSessionId);
    composerDraftBySession.set(composerCurrentSessionId, {
      text,
      attachments: composerAttachments.map((att) => ({
        id: att.id,
        name: att.name,
        mime: att.mime,
        size: att.size,
        base64: getAttachmentBase64(att),
      })),
    });
    while (composerDraftBySession.size > COMPOSER_DRAFT_MAX_SESSIONS) {
      const oldestSessionId = composerDraftBySession.keys().next().value;
      if (oldestSessionId === undefined) break;
      composerDraftBySession.delete(oldestSessionId);
    }
  };

  const updateComposerCommandChip = () => {
    if (!madComposerCmdChip || !madComposerInput) return;
    const val = String(madComposerInput.value || "").trimStart();
    const m = /^\/([a-zA-Z0-9_-]{1,48})(?=\s|$)/.exec(val);
    if (!m) {
      madComposerCmdChip.hidden = true;
      madComposerCmdChip.textContent = "";
      madComposerCmdChip.classList.remove("is-swarm");
      return;
    }
    const cmdName = m[1].toLowerCase();
    const known = composerCommands.find((c) => String(c.name || "").toLowerCase() === cmdName);
    madComposerCmdChip.hidden = false;
    madComposerCmdChip.classList.toggle("is-swarm", cmdName === "swarm");
    madComposerCmdChip.textContent = cmdName === "swarm" ? "⚡ /swarm" : `/${known ? known.name : m[1]}`;
    madComposerCmdChip.title = known?.description || `斜杠命令 /${m[1]}`;
  };

  const updateComposerSendState = () => {
    if (!madComposerSendBtn) return;
    const hasText = Boolean(madComposerInput && String(madComposerInput.value || "").trim());
    const hasImgs = composerAttachments.length > 0;
    const canSend =
      !composerSending &&
      detailAgentKey === "coord" &&
      Boolean(activeDetailSession?.id) &&
      (hasText || hasImgs);
    madComposerSendBtn.disabled = !canSend;
    madComposerSendBtn.classList.toggle("is-sending", composerSending);
  };

  const renderComposerAttachments = () => {
    if (!madAttachStrip) return;
    madAttachStrip.textContent = "";
    if (composerAttachments.length === 0) {
      madAttachStrip.hidden = true;
      updateComposerSendState();
      return;
    }
    madAttachStrip.hidden = false;
    composerAttachments.forEach((att, idx) => {
      const item = document.createElement("div");
      item.className = "mad-attach-item";

      const thumbBtn = document.createElement("button");
      thumbBtn.type = "button";
      thumbBtn.className = "mad-attach-thumb-btn";
      thumbBtn.title = `点击大图预览：${att.name}`;
      const img = document.createElement("img");
      img.className = "mad-attach-thumb";
      img.src = getAttachmentDataUrl(att);
      img.alt = att.name || "附件图片";
      thumbBtn.appendChild(img);
      thumbBtn.addEventListener("click", () => {
        openWebviewLightbox({ url: getAttachmentDataUrl(att), label: att.name || `图片 ${idx + 1}` });
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "mad-attach-remove";
      removeBtn.setAttribute("aria-label", `移除图片 ${att.name || idx + 1}`);
      removeBtn.title = "移除图片";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        composerAttachments = composerAttachments.filter((entry) => entry.id !== att.id);
        saveCurrentComposerDraft();
        renderComposerAttachments();
      });

      item.appendChild(thumbBtn);
      item.appendChild(removeBtn);
      madAttachStrip.appendChild(item);
    });
    updateComposerSendState();
  };

  const closeSlashMenu = () => {
    slashMatches = [];
    slashTokenRange = null;
    slashActiveIndex = 0;
    if (madSlashMenu) {
      madSlashMenu.hidden = true;
      madSlashMenu.textContent = "";
    }
  };

  const applySlashSelection = (cmd) => {
    if (!cmd || !madComposerInput) return;
    const raw = String(madComposerInput.value || "");
    const range = slashTokenRange || { start: 0, end: raw.length };
    const before = raw.slice(0, range.start);
    const after = raw.slice(range.end);
    const insertion = `/${cmd.name}${after.startsWith(" ") ? "" : " "}`;
    madComposerInput.value = `${before}${insertion}${after}`;
    const nextCaret = before.length + insertion.length;
    try {
      madComposerInput.focus();
      madComposerInput.setSelectionRange?.(nextCaret, nextCaret);
    } catch {
      // Ignore selection API errors in test DOM
    }
    closeSlashMenu();
    autoResizeComposerInput();
    saveCurrentComposerDraft();
    updateComposerCommandChip();
    updateComposerSendState();
  };

  const renderSlashMenu = () => {
    if (!madSlashMenu) return;
    if (!slashMatches.length) {
      closeSlashMenu();
      return;
    }
    madSlashMenu.textContent = "";
    slashMatches.forEach((cmd, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `mad-slash-item${idx === slashActiveIndex ? " is-active" : ""}`;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(idx === slashActiveIndex));

      const badge = document.createElement("span");
      const badgeMod =
        cmd.name === "swarm" ? " is-swarm" : cmd.category === "skill" ? " is-skill" : "";
      badge.className = `mad-slash-badge${badgeMod}`;
      badge.textContent = cmd.badge || (cmd.category === "skill" ? "技能" : "官方");

      const name = document.createElement("span");
      name.className = "mad-slash-name";
      name.textContent = `/${cmd.name}`;

      const desc = document.createElement("span");
      desc.className = "mad-slash-desc";
      desc.textContent = cmd.description || "";
      desc.title = cmd.description || "";

      btn.appendChild(badge);
      btn.appendChild(name);
      btn.appendChild(desc);

      btn.addEventListener("mouseenter", () => {
        if (slashActiveIndex === idx) return;
        slashActiveIndex = idx;
        Array.from(madSlashMenu.children).forEach((child, cIdx) => {
          child.classList.toggle("is-active", cIdx === slashActiveIndex);
          child.setAttribute("aria-selected", String(cIdx === slashActiveIndex));
        });
      });
      btn.addEventListener("mousedown", (e) => {
        // Prevent textarea blur before selection completes
        e.preventDefault();
      });
      btn.addEventListener("click", () => applySlashSelection(cmd));

      madSlashMenu.appendChild(btn);
    });
    madSlashMenu.hidden = false;
  };

  const refreshSlashMenu = ({ forceAll = false } = {}) => {
    if (!madComposerInput || !madSlashMenu) return;
    const val = String(madComposerInput.value || "");
    const caret =
      typeof madComposerInput.selectionStart === "number"
        ? madComposerInput.selectionStart
        : val.length;
    const prefix = val.slice(0, caret);
    const match = /(?:^|\s)(\/([a-zA-Z0-9_-]*))$/.exec(prefix);
    if (!match && !forceAll) {
      closeSlashMenu();
      return;
    }

    const query = match ? String(match[2] || "").toLowerCase() : "";
    const tokenLen = match ? match[1].length : 0;
    slashTokenRange = match
      ? { start: caret - tokenLen, end: caret }
      : { start: caret, end: caret };

    const filtered = !query
      ? [...composerCommands]
      : composerCommands
          .filter(
            (c) =>
              String(c.name || "").toLowerCase().includes(query) ||
              String(c.description || "").toLowerCase().includes(query)
          )
          .sort((a, b) => {
            const an = String(a.name || "").toLowerCase();
            const bn = String(b.name || "").toLowerCase();
            const aStarts = an.startsWith(query) ? 0 : 1;
            const bStarts = bn.startsWith(query) ? 0 : 1;
            if (aStarts !== bStarts) return aStarts - bStarts;
            return an.localeCompare(bn);
          });

    slashMatches = filtered.slice(0, 10);
    slashActiveIndex = 0;
    renderSlashMenu();
  };

  const addComposerImageFiles = (filesLike) => {
    const files = Array.from(filesLike || []).filter(Boolean);
    if (!files.length) return;

    const remaining = COMPOSER_MAX_IMAGES - composerAttachments.length;
    if (remaining <= 0) {
      onToast?.(`单次最多附加 ${COMPOSER_MAX_IMAGES} 张图片`, "error");
      return;
    }
    const accepted = files.slice(0, remaining);
    if (files.length > remaining) {
      onToast?.(`单次最多附加 ${COMPOSER_MAX_IMAGES} 张图片，已截取前 ${remaining} 张`, "info");
    }

    accepted.forEach((file, idx) => {
      const mime = resolveComposerImageMime(file);
      if (!mime) {
        onToast?.("仅支持粘贴或上传 PNG / JPEG / WEBP / GIF 位图图片", "error");
        return;
      }
      if (Number(file.size || 0) > COMPOSER_MAX_IMAGE_BYTES) {
        onToast?.("单张图片请勿超过 8 MB", "error");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (destroyed) return;
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        const comma = dataUrl.indexOf(",");
        const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
        if (!base64) return;
        if (composerAttachments.length >= COMPOSER_MAX_IMAGES) return;
        composerAttachments.push({
          id: `att-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name || `pasted-${composerAttachments.length + 1}.png`,
          mime,
          size: Number(file.size || 0),
          base64,
        });
        saveCurrentComposerDraft();
        renderComposerAttachments();
      };
      reader.onerror = () => {
        if (!destroyed) onToast?.("读取图片附件失败", "error");
      };
      reader.readAsDataURL(file);
    });
  };

  const syncComposerDockVisibility = (isMaster, session) => {
    if (!madComposerDock) return;
    const targetSessionId = isMaster && session?.id ? String(session.id) : "";
    if (!targetSessionId) {
      saveCurrentComposerDraft();
      closeSlashMenu();
      madComposerDock.hidden = true;
      composerCurrentSessionId = "";
      updateComposerSendState();
      return;
    }

    if (composerCurrentSessionId !== targetSessionId) {
      saveCurrentComposerDraft();
      composerCurrentSessionId = targetSessionId;
      const savedDraft = composerDraftBySession.get(targetSessionId);
      if (savedDraft) {
        composerDraftBySession.delete(targetSessionId);
        composerDraftBySession.set(targetSessionId, savedDraft);
      }
      if (madComposerInput) {
        madComposerInput.value = savedDraft ? savedDraft.text : "";
        autoResizeComposerInput();
      }
      composerAttachments = savedDraft ? [...savedDraft.attachments] : [];
      closeSlashMenu();
      renderComposerAttachments();
      updateComposerCommandChip();
    }

    madComposerDock.hidden = false;
    updateComposerSendState();
    void ensureComposerCommandsLoaded();
  };

  const sendComposerMessage = async () => {
    if (composerSending || detailAgentKey !== "coord" || !activeDetailSession?.id) return;
    const convId = String(activeDetailSession.id).trim();
    const prompt = madComposerInput ? String(madComposerInput.value || "").trim() : "";
    if (!prompt && composerAttachments.length === 0) return;
    if (typeof apiFetch !== "function") return;

    composerSending = true;
    closeSlashMenu();
    updateComposerSendState();

    const payloadImages = composerAttachments.map((att) => ({
      name: att.name,
      mime: att.mime,
      base64: getAttachmentBase64(att),
    }));

    try {
      const res = await callJson(apiFetch, "/api/mastery/composer/send", {
        method: "POST",
        body: JSON.stringify({
          conversationId: convId,
          prompt,
          images: payloadImages,
        }),
      });
      if (destroyed) return;

      if (madComposerInput) {
        madComposerInput.value = "";
        autoResizeComposerInput();
      }
      composerAttachments = [];
      composerDraftBySession.delete(convId);
      renderComposerAttachments();
      updateComposerCommandChip();

      const cmdTag = res?.matchedCommand ? `/${res.matchedCommand}` : "";
      onToast?.(
        cmdTag === "/swarm"
          ? "已向主 Agent 发送 /swarm 协作指令"
          : cmdTag
            ? `已向主 Agent 发送 ${cmdTag} 指令`
            : payloadImages.length > 0
              ? `已发送消息与 ${payloadImages.length} 张图片给主 Agent`
              : "已发送指令给主 Agent",
        "success"
      );

      void refreshMastery({ force: true });
      clearTimeout(composerRefreshTimer);
      composerRefreshTimer = setTimeout(() => {
        if (!destroyed && tabActive) {
          void refreshMastery({ force: true });
        }
      }, 1200);
    } catch (err) {
      if (destroyed) return;
      onToast?.(err?.message || "发送消息失败，请稍后重试", "error");
    } finally {
      composerSending = false;
      if (!destroyed) {
        updateComposerSendState();
      }
    }
  };

  const jumpToSession = (session) => {
    const targetId = String(session?.id || selectedSessionId || "").trim();
    if (!targetId) return;
    const title = String(session?.name || session?.title || targetId.slice(0, 8));
    const workspace =
      session?.project && session.project !== "全局" ? String(session.project) : "";

    if (typeof apiFetch === "function") {
      void callJson(apiFetch, "/api/sessions/focus", {
        method: "POST",
        body: JSON.stringify({
          conversationId: targetId,
          title,
          workspace,
        }),
      }).catch(() => {});
    }

    try {
      if (typeof window !== "undefined") {
        window.sidecar?.ui?.toggleConversation?.(targetId);
      }
    } catch {
      // Ignore host postMessage error in standalone preview
    }

    onSelectConversation?.({ id: targetId, title, workspace });
    onToast?.(`已跳转到会话：${title}`, "success");
  };

  const openLocalPath = async (rawTarget, { mode = "folder" } = {}) => {
    if (!rawTarget || typeof apiFetch !== "function") return;
    try {
      await callJson(apiFetch, "/api/mastery/open-path", {
        method: "POST",
        body: JSON.stringify({ targetPath: String(rawTarget), mode: mode === "file" ? "file" : "folder" }),
      });
    } catch (err) {
      onToast?.(err?.message || (mode === "file" ? "无法打开目标文件" : "无法打开目标目录"), "error");
    }
  };

  const revokeObjectUrlSafe = (url) => {
    if (!url || !createdObjectUrls.has(url)) return;
    createdObjectUrls.delete(url);
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
  };

  const evictLocalImageEntry = (key) => {
    if (!localImageUrlCache.has(key)) return;
    const oldPromise = localImageUrlCache.get(key);
    localImageUrlCache.delete(key);
    Promise.resolve(oldPromise).then((oldUrl) => revokeObjectUrlSafe(oldUrl));
  };

  const clearLocalImageCache = ({ keepKeys = null } = {}) => {
    const keep = keepKeys instanceof Set ? keepKeys : null;
    for (const key of Array.from(localImageUrlCache.keys())) {
      if (keep && keep.has(key)) continue;
      evictLocalImageEntry(key);
    }
    if (!keep) {
      for (const u of Array.from(createdObjectUrls)) {
        revokeObjectUrlSafe(u);
      }
    }
  };

  const loadLocalImage = (rawTarget) => {
    const key = String(rawTarget || "").trim();
    if (!key || typeof apiFetch !== "function") {
      return Promise.resolve("");
    }
    if (localImageUrlCache.has(key)) {
      const cached = localImageUrlCache.get(key);
      // Maintain true LRU recency order
      localImageUrlCache.delete(key);
      localImageUrlCache.set(key, cached);
      return cached;
    }
    while (localImageUrlCache.size >= LOCAL_IMAGE_CACHE_MAX) {
      const oldestKey = localImageUrlCache.keys().next().value;
      if (oldestKey === undefined) break;
      evictLocalImageEntry(oldestKey);
    }
    const req = Promise.resolve()
      .then(async () => {
        // Use JSON dataUrl mode so both Electron window.sidecar.fetch IPC and standard HTTP fetch work identically
        const res = await apiFetch(
          `/api/mastery/local-image?format=json&path=${encodeURIComponent(key)}`
        );
        if (!res || !res.ok) return "";
        const ct = String(res.headers?.get?.("content-type") || "").toLowerCase();
        if (typeof res.json === "function" && (!ct || ct.includes("json"))) {
          const data = await res.json().catch(() => null);
          if (data && typeof data.dataUrl === "string" && data.dataUrl.startsWith("data:image/")) {
            return data.dataUrl;
          }
          return "";
        }
        if (typeof res.blob === "function" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
          const blob = await res.blob();
          if (!blob || blob.size === 0 || destroyed) return "";
          const objUrl = URL.createObjectURL(blob);
          createdObjectUrls.add(objUrl);
          return objUrl;
        }
        return "";
      })
      .catch(() => "")
      .then((result) => {
        if (!result && localImageUrlCache.get(key) === req) {
          localImageUrlCache.delete(key);
        }
        return result;
      });
    localImageUrlCache.set(key, req);
    return req;
  };

  // ========== Image Lightbox Preview Modal (Zoom + Pan + Open File / Open Folder) ==========
  const lightboxBackdrop = document.getElementById("madImageLightbox");
  const lightboxCloseBtn = document.getElementById("madLightboxCloseBtn");
  const lightboxStage = document.getElementById("madLightboxStage");
  const lightboxImg = document.getElementById("madLightboxImg");
  const lightboxName = document.getElementById("madLightboxName");
  const lightboxZoomOutBtn = document.getElementById("madLightboxZoomOutBtn");
  const lightboxZoomResetBtn = document.getElementById("madLightboxZoomResetBtn");
  const lightboxZoomInBtn = document.getElementById("madLightboxZoomInBtn");
  const lightboxOpenFileBtn = document.getElementById("madLightboxOpenFileBtn");
  const lightboxOpenFolderBtn = document.getElementById("madLightboxOpenFolderBtn");

  let lightboxTargetPath = "";
  let lightboxScale = 1;
  let lightboxTx = 0;
  let lightboxTy = 0;
  let lightboxDragging = false;
  let lightboxDragStartX = 0;
  let lightboxDragStartY = 0;
  let lightboxDragOriginTx = 0;
  let lightboxDragOriginTy = 0;

  const applyLightboxTransform = () => {
    if (!lightboxImg) return;
    lightboxImg.style.transform = `translate3d(${lightboxTx.toFixed(1)}px, ${lightboxTy.toFixed(1)}px, 0) scale(${lightboxScale.toFixed(3)})`;
    lightboxImg.classList.toggle("is-zoomed", lightboxScale > 1.02);
    if (lightboxZoomResetBtn) {
      lightboxZoomResetBtn.textContent = `${Math.round(lightboxScale * 100)}%`;
    }
  };

  const setLightboxZoom = (nextScale) => {
    lightboxScale = Math.max(0.25, Math.min(5, Number(nextScale) || 1));
    if (lightboxScale <= 1.02) {
      lightboxTx = 0;
      lightboxTy = 0;
    }
    applyLightboxTransform();
  };

  const openWebviewLightbox = ({ url, targetPath, label } = {}) => {
    if (!lightboxBackdrop || !lightboxImg || !url) {
      if (targetPath) void openLocalPath(targetPath, { mode: "folder" });
      return;
    }
    lightboxTargetPath = String(targetPath || "");
    lightboxScale = 1;
    lightboxTx = 0;
    lightboxTy = 0;
    lightboxDragging = false;
    lightboxImg.classList.remove("is-dragging");
    lightboxImg.src = url;
    lightboxImg.alt = label || "";
    if (lightboxName) {
      lightboxName.textContent = label || extractFileUriLabel(lightboxTargetPath);
      lightboxName.title = decodeDisplayUrl(lightboxTargetPath);
    }
    applyLightboxTransform();
    lightboxBackdrop.hidden = false;
  };

  const openImageLightbox = ({ url, targetPath, label } = {}) => {
    const cleanPath = String(targetPath || "").trim();
    const cleanLabel = label || extractFileUriLabel(cleanPath);
    if (cleanPath && typeof apiFetch === "function") {
      void callJson(apiFetch, "/api/mastery/lightbox-preview", {
        method: "POST",
        body: JSON.stringify({ targetPath: cleanPath, label: cleanLabel }),
      })
        .then((res) => {
          if (destroyed) return;
          if (res?.mode === "native") return;
          openWebviewLightbox({ url, targetPath: cleanPath, label: cleanLabel });
        })
        .catch(() => {
          if (!destroyed) {
            openWebviewLightbox({ url, targetPath: cleanPath, label: cleanLabel });
          }
        });
      return;
    }
    openWebviewLightbox({ url, targetPath: cleanPath, label: cleanLabel });
  };

  const closeImageLightbox = () => {
    if (!lightboxBackdrop || lightboxBackdrop.hidden) return;
    lightboxBackdrop.hidden = true;
    lightboxDragging = false;
    lightboxImg?.classList.remove("is-dragging");
    if (lightboxImg) lightboxImg.src = "";
    lightboxTargetPath = "";
  };

  const mdCtx = {
    onOpenPath: (target) => {
      void openLocalPath(target, { mode: "folder" });
    },
    onPreviewImage: (info) => {
      openImageLightbox(info);
    },
    loadLocalImage,
  };

  const on = (el, evt, fn, opts) => {
    if (!el || typeof el.addEventListener !== "function") return;
    el.addEventListener(evt, fn, opts);
    cleanups.push(() => el.removeEventListener(evt, fn, opts));
  };

  const buildConfigSignature = (cfg) => {
    const c = cfg || {};
    const tp = c.thirdParty || {};
    const models = Array.isArray(tp.fetchedModels) ? tp.fetchedModels.join(",") : "";
    return [
      Boolean(c.enabled),
      c.source || "self",
      c.frequency || "1m",
      c.thinking || "low",
      tp.protocol || "openai",
      tp.baseUrl || "",
      Boolean(tp.hasApiKey),
      tp.apiKeyMasked || "",
      tp.selectedModel || "",
      models,
    ].join("|");
  };

  const buildSessionsListSignature = (sessions, selId, activeCount, unreadCount, isFallbackRecent) => {
    const parts = [
      String(selId || ""),
      String(activeCount),
      String(unreadCount),
      isFallbackRecent ? "1" : "0",
      String(sessions.length),
    ];
    for (let i = 0; i < sessions.length; i += 1) {
      const s = sessions[i];
      parts.push(
        `${s.id}\x1f${s.status || ""}\x1f${s.isRead ? 1 : 0}\x1f${s.isFavorite ? 1 : 0}\x1f${s.subAgentCount || 0}\x1f${s.project || ""}\x1f${s.name || ""}\x1f${s.tag || ""}\x1f${s.progress ?? 0}`
      );
    }
    return parts.join("\x1e");
  };

  const buildWorkspaceGraphSignature = (session) => {
    if (!session) return "__empty__";
    const m = session.master;
    const subs = Array.isArray(session.subs) ? session.subs : [];
    const edges = Array.isArray(session.edges) ? session.edges : [];
    const parts = [
      String(session.id || ""),
      String(session.status || ""),
      session.isRead ? "1" : "0",
      String(session.progress ?? 0),
      String(session.summaryText || ""),
      String(session.goal || ""),
      String(session.name || ""),
      String(session.project || ""),
      m
        ? `${m.id}\x1f${m.name || ""}\x1f${m.stateKind || ""}\x1f${m.stateLabel || ""}\x1f${m.progress ?? 0}\x1f${m.task || ""}`
        : "",
      String(subs.length),
    ];
    for (let i = 0; i < subs.length; i += 1) {
      const sub = subs[i];
      parts.push(
        `${sub.id}\x1f${sub.name || ""}\x1f${sub.stateKind || ""}\x1f${sub.stateLabel || ""}\x1f${sub.progress ?? 0}\x1f${sub.task || ""}`
      );
    }
    parts.push(String(edges.length));
    for (let i = 0; i < edges.length; i += 1) {
      const e = edges[i];
      parts.push(`${e.type || ""}\x1f${e.from || ""}\x1f${e.to || ""}\x1f${e.dir || ""}\x1f${e.lane || 0}\x1f${e.live ? 1 : 0}`);
    }
    return parts.join("\x1e");
  };

  const renderConfigRow = () => {
    lastRenderedConfigSig = buildConfigSignature(configState);
    const isEnabled = Boolean(configState.enabled);
    const isThirdParty = configState.source === "thirdparty";
    const tp = configState.thirdParty || {};
    const protoPreset = PROTOCOL_PRESETS[tp.protocol] || PROTOCOL_PRESETS.openai;
    const tpModel = tp.selectedModel || protoPreset.models[0];

    if (msmRowEl) msmRowEl.classList.toggle("is-off", !isEnabled);
    if (msmEnableToggle) msmEnableToggle.checked = isEnabled;
    if (msmExtraRow) msmExtraRow.hidden = !isEnabled;

    if (msmSelfBtn) {
      const selfActive = isEnabled && !isThirdParty;
      msmSelfBtn.classList.toggle("is-active", selfActive);
      msmSelfBtn.setAttribute("aria-checked", String(selfActive));
    }

    if (msmThirdPartyBtn) {
      const tpActive = isEnabled && isThirdParty;
      msmThirdPartyBtn.classList.toggle("is-active", tpActive);
      msmThirdPartyBtn.setAttribute("aria-checked", String(tpActive));
      msmThirdPartyBtn.title = isThirdParty
        ? `${isEnabled ? "已启用" : "已配置（当前关闭）"} ${protoPreset.name}：${tpModel}（点击修改）`
        : "自定义第三方总结模型（OpenAI / Anthropic 协议）";
    }
    if (msmThirdPartyLabel) {
      msmThirdPartyLabel.textContent = isThirdParty ? `第三方 · ${tpModel}` : "第三方模型";
    }

    if (msmSourceTag) {
      if (!isEnabled) {
        msmSourceTag.textContent = "已关闭";
        msmSourceTag.className = "msm-source-tag is-off";
      } else if (isThirdParty) {
        msmSourceTag.textContent = `第三方 · ${protoPreset.name}`;
        msmSourceTag.className = "msm-source-tag is-thirdparty";
      } else {
        msmSourceTag.textContent = "自身模型";
        msmSourceTag.className = "msm-source-tag";
      }
    }

    freqBtns.forEach((btn) => {
      const active = btn.getAttribute("data-msm-freq") === configState.frequency;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", String(active));
    });

    if (msmThinkGroup) {
      msmThinkGroup.classList.toggle("is-self-note", !isThirdParty);
      msmThinkGroup.title = isThirdParty
        ? "设置第三方总结模型的思维推理强度"
        : "使用 Agent 自身模型时沿用当前会话档位；切换第三方模型后可独立控制";
    }
    thinkBtns.forEach((btn) => {
      const active = btn.getAttribute("data-msm-think") === configState.thinking;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", String(active));
    });
  };

  const saveConfigPatch = async (patch, { toastText = "", toastType = "success", refreshAfter = false } = {}) => {
    const reqSeq = ++configMutationSeq;
    configSaveInFlight += 1;
    try {
      const res = await callJson(apiFetch, "/api/mastery/config", {
        method: "POST",
        body: JSON.stringify(patch),
      });
      if (res?.config && reqSeq === configMutationSeq) {
        configState = res.config;
        renderConfigRow();
      }
      if (toastText) onToast?.(toastText, toastType);
      if (refreshAfter) {
        void refreshMastery();
      }
      return res?.config || null;
    } catch (err) {
      onToast?.(err?.message || "保存总结模型配置失败", "error");
      if (reqSeq === configMutationSeq) {
        void refreshMastery();
      }
      return null;
    } finally {
      configSaveInFlight = Math.max(0, configSaveInFlight - 1);
    }
  };

  const updateEdgeFocus = () => {
    if (!graphStageEl || !graphSvgEl) return;
    const focusId = hoveredAgentId;
    graphStageEl.classList.toggle("has-focus", Boolean(focusId));
    graphSvgEl.querySelectorAll(".mg-edge-group").forEach((g) => {
      const from = g.getAttribute("data-from");
      const to = g.getAttribute("data-to");
      const type = g.getAttribute("data-type");
      const stateKind = g.getAttribute("data-state") || "unread";
      const isLive = g.getAttribute("data-live") === "1";
      const isRelated = Boolean(focusId) && (from === focusId || to === focusId);
      g.classList.toggle("is-highlighted", isRelated);

      const basePath = g.querySelector(".mg-edge-path");
      if (basePath) {
        if (type === "bus") {
          const markerMap = {
            running: "url(#mgArrowRunning)",
            sleep: "url(#mgArrowSleep)",
            unread: "url(#mgArrowUnread)",
            done: "url(#mgArrowDone)",
          };
          basePath.setAttribute("marker-end", markerMap[stateKind] || "url(#mgArrowDone)");
        } else {
          basePath.setAttribute(
            "marker-end",
            isRelated
              ? "url(#mgArrowPeerHi)"
              : isLive
                ? "url(#mgArrowPeerLive)"
                : "url(#mgArrowPeerIdle)"
          );
        }
      }
    });
  };

  const drawGraphEdges = () => {
    const session = lastSnapshot?.detailSession;
    if (!session || !graphStageEl || !graphSvgEl) return;
    if (detailViewEl && !detailViewEl.hidden) return;

    const stageRect = graphStageEl.getBoundingClientRect();
    if (!stageRect || stageRect.width < 10 || stageRect.height < 10) return;

    graphSvgEl.setAttribute("viewBox", `0 0 ${stageRect.width} ${stageRect.height}`);
    graphSvgEl.textContent = "";

    const edges = Array.isArray(session.edges) ? session.edges : [];
    if (edges.length === 0) return;

    const defs = makeSvgEl("defs");
    defs.appendChild(createArrowMarker("mgArrowRunning", "is-running"));
    defs.appendChild(createArrowMarker("mgArrowSleep", "is-sleep"));
    defs.appendChild(createArrowMarker("mgArrowUnread", "is-unread"));
    defs.appendChild(createArrowMarker("mgArrowDone", "is-done"));
    defs.appendChild(createArrowMarker("mgArrowPeerIdle", "is-peer-idle"));
    defs.appendChild(createArrowMarker("mgArrowPeerLive", "is-peer-live"));
    defs.appendChild(createArrowMarker("mgArrowPeerHi", "is-peer-hi"));
    graphSvgEl.appendChild(defs);

    const subStateMap = new Map((session.subs || []).map((sub) => [sub.id, sub.stateKind]));

    const getBox = (id) => {
      const el = nodeElMap.get(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left - stageRect.left,
        right: r.right - stageRect.left,
        top: r.top - stageRect.top,
        bottom: r.bottom - stageRect.top,
        width: r.width,
        height: r.height,
        cy: r.top - stageRect.top + r.height / 2,
      };
    };

    const busEdges = edges.filter((e) => e.type === "bus");
    const busIndexMap = new Map(busEdges.map((e, idx) => [e, idx]));

    edges.forEach((edge) => {
      const fromBox = getBox(edge.from);
      const toBox = getBox(edge.to);
      if (!fromBox || !toBox) return;

      const edgeState = edge.type === "bus" ? subStateMap.get(edge.to) || "unread" : "peer";

      const g = makeSvgEl("g", {
        class: `mg-edge-group is-${edge.type} is-${edgeState}${edge.live ? " is-live" : ""}`,
        "data-from": edge.from,
        "data-to": edge.to,
        "data-type": edge.type,
        "data-state": edgeState,
        "data-live": edge.live ? "1" : "0",
      });

      let pathD = "";
      let startX = 0;
      let startY = 0;

      if (edge.type === "bus") {
        const busIdx = busIndexMap.get(edge) || 0;
        const busTotal = Math.max(1, busEdges.length);
        const ratio = busTotal === 1 ? 0.5 : 0.24 + (0.52 * busIdx) / (busTotal - 1);

        const masterX = fromBox.right + 2;
        const masterY = fromBox.top + fromBox.height * ratio;
        const subX = toBox.left - 3;
        const subY = toBox.cy;
        const spanX = Math.max(20, subX - masterX);

        if (edge.dir === "to-master") {
          const sx = toBox.left - 2;
          const sy = subY;
          const ex = fromBox.right + 3;
          const ey = masterY;
          pathD = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${(sx - spanX * 0.48).toFixed(1)} ${sy.toFixed(1)}, ${(ex + spanX * 0.52).toFixed(1)} ${ey.toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}`;
          startX = sx;
          startY = sy;
        } else {
          pathD = `M ${masterX.toFixed(1)} ${masterY.toFixed(1)} C ${(masterX + spanX * 0.52).toFixed(1)} ${masterY.toFixed(1)}, ${(subX - spanX * 0.48).toFixed(1)} ${subY.toFixed(1)}, ${subX.toFixed(1)} ${subY.toFixed(1)}`;
          startX = masterX;
          startY = masterY;
        }
      } else {
        const sx = fromBox.right + 2;
        const sy = fromBox.cy;
        const ex = toBox.right + 3;
        const ey = toBox.cy;
        const railX = Math.min(
          stageRect.width - 5,
          Math.max(fromBox.right, toBox.right) + 13 + (edge.lane || 0) * 11
        );
        const dirY = ey >= sy ? 1 : -1;
        const rad = Math.min(7, Math.abs(ey - sy) / 2, Math.max(2, railX - Math.max(sx, ex)));

        pathD = [
          `M ${sx.toFixed(1)} ${sy.toFixed(1)}`,
          `L ${(railX - rad).toFixed(1)} ${sy.toFixed(1)}`,
          `Q ${railX.toFixed(1)} ${sy.toFixed(1)} ${railX.toFixed(1)} ${(sy + dirY * rad).toFixed(1)}`,
          `L ${railX.toFixed(1)} ${(ey - dirY * rad).toFixed(1)}`,
          `Q ${railX.toFixed(1)} ${ey.toFixed(1)} ${(railX - rad).toFixed(1)} ${ey.toFixed(1)}`,
          `L ${ex.toFixed(1)} ${ey.toFixed(1)}`,
        ].join(" ");
        startX = sx;
        startY = sy;
      }

      g.appendChild(makeSvgEl("path", { class: "mg-edge-path", d: pathD }));
      g.appendChild(makeSvgEl("path", { class: "mg-edge-flow", d: pathD }));
      g.appendChild(
        makeSvgEl("circle", {
          class: "mg-port-dot",
          cx: startX.toFixed(1),
          cy: startY.toFixed(1),
          r: "2.4",
        })
      );
      graphSvgEl.appendChild(g);
    });

    updateEdgeFocus();
  };

  const renderAgentTimeline = (agent, isMaster, session, { preserveScroll = false } = {}) => {
    if (!madTimelineEl || !agent || !session) return;
    const journey = agent.journey || {};

    const steps =
      Array.isArray(journey.steps) && journey.steps.length > 0
        ? journey.steps
        : [{ type: "msg", text: agent.task || "等待下一步输出…" }];

    const timelineKey = `${session.id}:${agent.id}`;
    const lastStep = steps[steps.length - 1];
    let totalTextLen = 0;
    let totalItemCount = 0;
    for (let i = 0; i < steps.length; i += 1) {
      const st = steps[i];
      if (typeof st?.text === "string") totalTextLen += st.text.length;
      if (Array.isArray(st?.items)) totalItemCount += st.items.length;
    }
    const timelineSig = [
      timelineKey,
      isMaster ? "1" : "0",
      agent.name || "",
      agent.stateKind || "",
      agent.stateLabel || "",
      agent.progress ?? "",
      session.project || "",
      session.name || "",
      journey.brief || "",
      journey.duration || "",
      journey.foot || "",
      steps.length,
      totalTextLen,
      totalItemCount,
      lastStep?.type || "",
      lastStep?.id || "",
      lastStep?.statusTag || "",
      lastStep?.progressPct ?? "",
      lastStep?.text || "",
      Array.isArray(lastStep?.images) ? lastStep.images.length : 0,
      Array.isArray(lastStep?.items) ? lastStep.items.length : 0,
    ].join("|");

    if (preserveScroll && timelineKey === lastRenderedTimelineKey && timelineSig === lastRenderedTimelineSig) {
      return;
    }

    if (madRoleBadgeEl) {
      madRoleBadgeEl.textContent = isMaster ? "主 Agent" : "次 Agent";
      madRoleBadgeEl.className = `mad-role-badge${isMaster ? "" : " is-sub"}`;
    }
    if (madAgentNameEl) madAgentNameEl.textContent = agent.name || (isMaster ? "主 Agent" : "子 Agent");
    if (madStateSlotEl) {
      madStateSlotEl.textContent = "";
      madStateSlotEl.appendChild(createStatePill(agent.stateKind, agent.stateLabel));
    }
    if (madSessionCrumbEl) {
      madSessionCrumbEl.textContent = `所属会话：[${session.project}] ${session.name}`;
      madSessionCrumbEl.title = `${session.project} / ${session.name}`;
    }
    if (madJumpSessionBtn) {
      madJumpSessionBtn.hidden = !session.id;
      madJumpSessionBtn.title = `跳转到所属会话：[${session.project}] ${session.name}`;
    }
    if (madDurationEl) {
      madDurationEl.textContent = `${journey.duration || ""} · 进度 ${agent.progress}%`;
    }

    const prevScrollTop = Number(madTimelineEl.scrollTop || 0);
    const prevScrollHeight = Number(madTimelineEl.scrollHeight || 0);
    const prevClientHeight = Number(madTimelineEl.clientHeight || 0);
    const wasNearBottom =
      prevScrollHeight <= prevClientHeight + 48 ||
      prevScrollHeight - prevScrollTop - prevClientHeight <= 48;

    madTimelineEl.textContent = "";

    const hasInlineUserSteps = steps.some((s) => s.type === "user");
    if (!hasInlineUserSteps && journey.brief) {
      const brief = document.createElement("div");
      brief.className = "mad-brief";
      const briefLabel = document.createElement("span");
      briefLabel.className = "mad-brief-label";
      briefLabel.textContent = journey.briefFrom || (isMaster ? "用户布置任务" : "来自「主 Agent」派单");
      const briefText = document.createElement("div");
      briefText.textContent = journey.brief;
      brief.appendChild(briefLabel);
      brief.appendChild(briefText);
      madTimelineEl.appendChild(brief);
    }

    if (journey.duration) {
      const elapsed = document.createElement("div");
      elapsed.className = "mad-elapsed-head";
      elapsed.textContent = journey.duration;
      madTimelineEl.appendChild(elapsed);
    }

    steps.forEach((step, idx) => {
      if (step.type === "user") {
        const brief = document.createElement("div");
        brief.className = `mad-brief${step.isFollowup ? " is-followup" : ""}`;
        const briefLabel = document.createElement("span");
        briefLabel.className = "mad-brief-label";
        briefLabel.textContent =
          step.label || (step.isFollowup ? "用户补充" : isMaster ? "用户布置任务" : "来自「主 Agent」派单");
        brief.appendChild(briefLabel);
        if (step.text) {
          const briefText = document.createElement("div");
          briefText.textContent = step.text;
          brief.appendChild(briefText);
        }
        if (Array.isArray(step.images) && step.images.length > 0) {
          const imgRow = document.createElement("div");
          imgRow.className = "mad-brief-images";
          step.images.forEach((imgPath) => {
            imgRow.appendChild(createLocalImagePreview(extractFileUriLabel(imgPath), imgPath, mdCtx));
          });
          brief.appendChild(imgRow);
        }
        madTimelineEl.appendChild(brief);
      } else if (step.type === "msg") {
        let statusTag = typeof step.statusTag === "string" ? step.statusTag.trim() : "";
        let progressPct =
          typeof step.progressPct === "number" && Number.isFinite(step.progressPct)
            ? Math.max(0, Math.min(100, Math.round(step.progressPct)))
            : null;
        let bodyText = String(step.text || "");

        // Backward-compatibility: strip legacy glued prefix `【摘要 · 55%】` into standalone spotlight card
        const legacyPrefix = /^【([^】\r\n]+?)\s*[·|｜]\s*(\d{1,3})%】\s*/.exec(bodyText);
        if (legacyPrefix) {
          if (!statusTag) statusTag = legacyPrefix[1].trim();
          if (progressPct === null) progressPct = Math.max(0, Math.min(100, Number(legacyPrefix[2]) || 0));
          bodyText = bodyText.slice(legacyPrefix[0].length).trimStart();
        }

        const p = document.createElement("div");
        p.className = `mad-msg${statusTag || progressPct !== null ? " has-progress" : ""}`;

        if (statusTag || progressPct !== null) {
          const pctVal = progressPct !== null ? progressPct : 0;
          const isComplete = pctVal >= 100;
          const badge = document.createElement("div");
          badge.className = `mad-progress-callout${isComplete ? " is-complete" : ""}`;

          const dot = document.createElement("span");
          dot.className = "mad-progress-dot";

          const title = document.createElement("span");
          title.className = "mad-progress-title";
          title.textContent = statusTag || (isComplete ? "阶段完成" : "阶段推进");

          const pctPill = document.createElement("span");
          pctPill.className = "mad-progress-pct";
          pctPill.textContent = `${pctVal}%`;

          const bar = document.createElement("span");
          bar.className = "mad-progress-bar";
          const fill = document.createElement("span");
          fill.className = "mad-progress-bar-fill";
          fill.style.width = `${pctVal}%`;
          bar.appendChild(fill);

          badge.appendChild(dot);
          badge.appendChild(title);
          badge.appendChild(pctPill);
          badge.appendChild(bar);
          p.appendChild(badge);
        }

        if (bodyText.trim()) {
          const body = document.createElement("div");
          body.className = "mad-msg-body";
          renderSafeMarkdown(body, bodyText, mdCtx);
          p.appendChild(body);
        }

        madTimelineEl.appendChild(p);
      } else if (step.type === "actions") {
        const groupKey = `${session.id}:${agent.id}:${step.id || idx}:${step.label}`;
        const isOpenInitial = Boolean(expandedGroupState.get(groupKey));

        const group = document.createElement("div");
        group.className = `mad-action-group${isOpenInitial ? " is-open" : ""}`;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "mad-action-toggle";
        toggle.setAttribute("aria-expanded", String(isOpenInitial));

        const iconSpan = document.createElement("span");
        iconSpan.className = "mad-action-icon";
        iconSpan.appendChild(buildActionIconSvg(step.icon));

        const labelSpan = document.createElement("span");
        labelSpan.textContent = step.label || "运行了命令";

        const countSpan = document.createElement("span");
        countSpan.className = "mad-action-count";
        countSpan.textContent = `${(step.items || []).length} 项`;

        const chevron = document.createElement("span");
        chevron.className = "mad-action-chevron";
        chevron.appendChild(buildChevronSvg());

        toggle.appendChild(iconSpan);
        toggle.appendChild(labelSpan);
        toggle.appendChild(countSpan);
        toggle.appendChild(chevron);

        const list = document.createElement("div");
        list.className = "mad-action-list";

        (step.items || []).forEach((item) => {
          const hasOpenableFile = Boolean(item.filePath && looksLikeLocalAbsPath(item.filePath));
          const row = document.createElement(hasOpenableFile ? "button" : "div");
          if (row.tagName === "BUTTON") {
            row.type = "button";
          }
          row.className = `mad-action-item${hasOpenableFile ? " is-clickable" : ""}`;

          const glyph = document.createElement("span");
          glyph.className = "mad-item-glyph";
          glyph.textContent = glyphForActionKind(item.kind);

          const text = document.createElement("span");
          text.className = "mad-item-text";
          text.textContent = item.text || "";
          text.title = hasOpenableFile ? `点击打开所在目录：${item.filePath}` : item.text || "";

          row.appendChild(glyph);
          row.appendChild(text);

          if (hasOpenableFile) {
            row.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              void openLocalPath(item.filePath);
            });
          }

          if (item.add || item.del) {
            const diff = document.createElement("span");
            diff.className = "mad-item-diff";
            if (item.add) {
              const add = document.createElement("span");
              add.className = "mad-diff-add";
              add.textContent = item.add;
              diff.appendChild(add);
            }
            if (item.del) {
              const del = document.createElement("span");
              del.className = "mad-diff-del";
              del.textContent = item.del;
              diff.appendChild(del);
            }
            row.appendChild(diff);
          }

          list.appendChild(row);
        });

        toggle.addEventListener("click", () => {
          const isOpen = group.classList.toggle("is-open");
          toggle.setAttribute("aria-expanded", String(isOpen));
          expandedGroupState.set(groupKey, isOpen);
        });

        group.appendChild(toggle);
        group.appendChild(list);
        madTimelineEl.appendChild(group);
      }
    });

    if (journey.foot) {
      const foot = document.createElement("div");
      foot.className = `mad-live-foot is-${agent.stateKind || "unread"}`;
      if (agent.stateKind === "sleep") {
        foot.textContent = `☾ ${journey.foot}`;
      } else {
        const dot = document.createElement("span");
        dot.className = "mad-live-dot";
        const footText = document.createElement("span");
        footText.textContent = journey.foot;
        foot.appendChild(dot);
        foot.appendChild(footText);
      }
      madTimelineEl.appendChild(foot);
    }

    lastRenderedTimelineKey = timelineKey;
    lastRenderedTimelineSig = timelineSig;
    const shouldSnapBottom = !preserveScroll || wasNearBottom;
    const applyScroll = () => {
      if (destroyed || !madTimelineEl) return;
      const h = Number(madTimelineEl.scrollHeight || 0);
      madTimelineEl.scrollTop = shouldSnapBottom ? h : prevScrollTop;
    };
    applyScroll();
    if (shouldSnapBottom && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => applyScroll());
    }
  };

  const openAgentDetail = (agent, isMaster, session) => {
    if (!overviewViewEl || !detailViewEl) return;
    hoveredAgentId = null;
    detailAgentKey = isMaster ? "coord" : agent.id;

    // Clicking a completed Agent marks it as read ("任务结束" gray instead of "任务结束未读" green)
    if (agent.stateKind === "unread" && !agent.isRead) {
      agent.isRead = true;
      agent.stateKind = "done";
      agent.stateLabel = "任务结束";
      if (agent.journey) {
        agent.journey.foot = "本角色任务已结束 · 你已查阅";
      }
      const allCompletedRead =
        (!session.master || session.master.stateKind !== "unread") &&
        (session.subs || []).every((s) => s.stateKind !== "unread");
      const shouldMarkSessionRead = Boolean(isMaster || allCompletedRead);
      if (shouldMarkSessionRead && session.status !== "active") {
        session.isRead = true;
        session.status = "done";
        session.tag = "任务结束";
        const row = (lastSnapshot?.sessions || []).find((r) => r.id === session.id);
        if (row) {
          row.isRead = true;
          row.status = "done";
          row.tag = "任务结束";
        }
      }
      if (typeof apiFetch === "function") {
        void callJson(apiFetch, "/api/mastery/mark-read", {
          method: "POST",
          body: JSON.stringify({
            sessionId: session.id,
            agentConvId: agent.convId || session.id,
            markSessionRead: shouldMarkSessionRead,
            modifiedMs: session.modifiedMs || Date.now(),
          }),
        }).catch(() => {});
      }
    }

    overviewViewEl.hidden = true;
    detailViewEl.hidden = false;
    syncComposerDockVisibility(isMaster, session);
    renderAgentTimeline(agent, isMaster, session, { preserveScroll: false });
  };

  const closeAgentDetail = () => {
    if (!overviewViewEl || !detailViewEl || detailViewEl.hidden) return;
    detailAgentKey = "";
    syncComposerDockVisibility(false, null);
    detailViewEl.hidden = true;
    overviewViewEl.hidden = false;
    hoveredAgentId = null;
    if (lastSnapshot) {
      renderSnapshot(lastSnapshot);
    }
    void refreshMastery();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => drawGraphEdges());
    }
  };

  const bindNodeInteraction = (btn, agent, isMaster, session) => {
    const agentId = agent.id;
    btn.title = `点击查看「${agent.name}」的执行历程`;
    btn.addEventListener("click", () => {
      const liveSession = activeDetailSession || session;
      const liveAgent = isMaster
        ? liveSession?.master || agent
        : (liveSession?.subs || []).find((sub) => sub.id === agentId) || agent;
      openAgentDetail(liveAgent, isMaster, liveSession);
    });
    btn.addEventListener("mouseenter", () => {
      hoveredAgentId = agentId;
      updateEdgeFocus();
    });
    btn.addEventListener("mouseleave", () => {
      hoveredAgentId = null;
      updateEdgeFocus();
    });
    nodeElMap.set(agentId, btn);
  };

  const createMasterNodeEl = (master, session) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `mg-node is-master is-${master.stateKind}`;
    btn.dataset.agentId = master.id;

    const top = document.createElement("div");
    top.className = "mg-master-top";
    const badge = document.createElement("span");
    badge.className = "mg-tier-badge is-master";
    badge.textContent = "主 Agent";
    const pct = document.createElement("span");
    pct.className = "mg-master-pct";
    pct.textContent = `${master.progress}%`;
    top.appendChild(badge);
    top.appendChild(pct);

    const name = document.createElement("div");
    name.className = "mg-master-name";
    name.textContent = master.name;

    const state = createStatePill(master.stateKind, master.stateLabel);

    const task = document.createElement("div");
    task.className = "mg-master-task";
    task.textContent = master.task;

    const bar = document.createElement("div");
    bar.className = "mg-node-bottom-bar";
    const fill = document.createElement("div");
    fill.className = `mg-node-bottom-fill is-${master.stateKind}`;
    fill.style.width = `${master.progress}%`;
    bar.appendChild(fill);

    btn.appendChild(top);
    btn.appendChild(name);
    btn.appendChild(state);
    btn.appendChild(task);
    btn.appendChild(bar);
    bindNodeInteraction(btn, master, true, session);
    return btn;
  };

  const createSubNodeEl = (sub, session) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `mg-node is-sub is-${sub.stateKind}`;
    btn.dataset.agentId = sub.id;

    const top = document.createElement("div");
    top.className = "mg-sub-top";

    const idWrap = document.createElement("span");
    idWrap.className = "mg-sub-id";
    const badge = document.createElement("span");
    badge.className = "mg-tier-badge is-sub";
    badge.textContent = "次";
    const name = document.createElement("span");
    name.className = "mg-sub-name";
    name.textContent = sub.name;
    idWrap.appendChild(badge);
    idWrap.appendChild(name);

    const right = document.createElement("span");
    right.className = "mg-sub-right";
    const state = createStatePill(sub.stateKind, sub.stateLabel);
    const pct = document.createElement("span");
    pct.className = "mg-sub-pct";
    pct.textContent = `${sub.progress}%`;
    right.appendChild(state);
    right.appendChild(pct);

    top.appendChild(idWrap);
    top.appendChild(right);

    const task = document.createElement("div");
    task.className = "mg-sub-task";
    task.textContent = sub.task;

    const bar = document.createElement("div");
    bar.className = "mg-node-bottom-bar";
    const fill = document.createElement("div");
    fill.className = `mg-node-bottom-fill is-${sub.stateKind}`;
    fill.style.width = `${sub.progress}%`;
    bar.appendChild(fill);

    btn.appendChild(top);
    btn.appendChild(task);
    btn.appendChild(bar);
    bindNodeInteraction(btn, sub, false, session);
    return btn;
  };

  let selectionSeq = 0;
  let pendingRefresh = false;

  const applyFavoriteOrderOverlay = (sessionsList, favIds) => {
    const favOrder = new Map();
    favIds.forEach((id, idx) => favOrder.set(String(id), idx));
    const statusRank = (item) =>
      item.status === "active" ? 0 : item.status === "done" || item.isRead ? 2 : 1;
    return sessionsList
      .map((item) => ({
        ...item,
        isFavorite: favOrder.has(item.id),
      }))
      .sort((a, b) => {
        const aFav = favOrder.has(a.id);
        const bFav = favOrder.has(b.id);
        if (aFav && bFav) return favOrder.get(a.id) - favOrder.get(b.id);
        if (aFav !== bFav) return aFav ? -1 : 1;
        const rankDiff = statusRank(a) - statusRank(b);
        if (rankDiff !== 0) return rankDiff;
        return Number(b.modifiedMs || 0) - Number(a.modifiedMs || 0);
      });
  };

  const toggleFavoriteSession = async (session) => {
    const id = String(session?.id || "").trim();
    if (!id || typeof apiFetch !== "function") return;
    const reqFavSeq = ++favoriteMutationSeq;
    favoriteSaveInFlight += 1;
    const prevIds = [...favoriteIdsState];
    const willFavorite = !prevIds.includes(id);
    const nextIds = willFavorite ? [...prevIds, id] : prevIds.filter((item) => item !== id);
    favoriteIdsState = nextIds;

    const favoriteTitles = {};
    if (willFavorite && session?.name && session.name !== id.slice(0, 8)) {
      favoriteTitles[id] = String(session.name);
    }

    if (lastSnapshot && Array.isArray(lastSnapshot.sessions)) {
      const optimisticSessions = applyFavoriteOrderOverlay(lastSnapshot.sessions, nextIds);
      renderSnapshot({
        ...lastSnapshot,
        sessions: optimisticSessions,
        favoriteIds: nextIds,
        favoriteCount: optimisticSessions.filter((item) => item.isFavorite).length,
      });
    }

    try {
      const resp = await callJson(apiFetch, "/api/sessions/favorites", {
        method: "POST",
        body: JSON.stringify({ favoriteIds: nextIds, favoriteTitles }),
      });
      if (destroyed) return;
      if (reqFavSeq === favoriteMutationSeq) {
        if (Array.isArray(resp?.favoriteIds)) {
          favoriteIdsState = resp.favoriteIds.map(String);
        }
        onFavoritesChanged?.([...favoriteIdsState]);
        const displayName = session?.name || id.slice(0, 8);
        onToast?.(
          willFavorite ? `已设为常用会话并置顶：${displayName}` : `已取消常用会话：${displayName}`,
          "info"
        );
      }
    } catch {
      if (destroyed) return;
      if (reqFavSeq === favoriteMutationSeq) {
        favoriteIdsState = prevIds;
        onToast?.("同步常用会话失败", "error");
      }
    } finally {
      favoriteSaveInFlight = Math.max(0, favoriteSaveInFlight - 1);
      if (!destroyed && reqFavSeq === favoriteMutationSeq) {
        void refreshMastery({ force: true });
      }
    }
  };

  const renderSnapshot = (snap, { reqCfgSeq = null, reqSelSeq = null, reqFavSeq = null } = {}) => {
    if (!snap) return;
    const isStaleSelection = reqSelSeq !== null && reqSelSeq !== selectionSeq;
    if (isStaleSelection) return;
    lastSnapshot = snap;
    const allowConfigHydrate =
      configSaveInFlight === 0 && (reqCfgSeq === null || reqCfgSeq === configMutationSeq);
    if (snap.config && allowConfigHydrate) {
      const nextConfigSig = buildConfigSignature(snap.config);
      configState = snap.config;
      if (nextConfigSig !== lastRenderedConfigSig) {
        renderConfigRow();
      }
    }
    const allowFavoriteHydrate =
      favoriteSaveInFlight === 0 && (reqFavSeq === null || reqFavSeq === favoriteMutationSeq);
    if (allowFavoriteHydrate) {
      if (Array.isArray(snap.favoriteIds)) {
        favoriteIdsState = snap.favoriteIds.map(String);
      } else if (Array.isArray(snap.sessions)) {
        favoriteIdsState = snap.sessions.filter((item) => item.isFavorite).map((item) => String(item.id));
      }
    }
    if (snap.selectedSessionId && reqSelSeq === null) {
      selectedSessionId = snap.selectedSessionId;
    } else if (snap.selectedSessionId && reqSelSeq === selectionSeq) {
      selectedSessionId = snap.selectedSessionId;
    }

    const rawSessions = Array.isArray(snap.sessions) ? snap.sessions : [];
    const sessions = allowFavoriteHydrate
      ? rawSessions
      : applyFavoriteOrderOverlay(rawSessions, favoriteIdsState);
    const activeCount = Number(snap.activeCount || 0);
    const unreadCount = Number(snap.unreadCount || 0);
    const favCount = sessions.filter((item) => Boolean(item.isFavorite)).length;

    const nextListSig = buildSessionsListSignature(
      sessions,
      selectedSessionId,
      activeCount,
      unreadCount,
      snap.isFallbackRecent
    );
    if (nextListSig !== lastRenderedListSig) {
      lastRenderedListSig = nextListSig;
      if (totalCountEl) totalCountEl.textContent = String(sessions.length);
      if (summaryEl) {
        if (favCount > 0) {
          summaryEl.textContent =
            activeCount > 0 || unreadCount > 0
              ? `${favCount} 常用置顶 · ${activeCount} 运行中 · ${unreadCount} 任务结束未读`
              : `${favCount} 常用置顶 · 无运行中/未读`;
        } else {
          summaryEl.textContent = snap.isFallbackRecent
            ? `当前无活动/未读 · 显示最近 ${sessions.length} 条会话`
            : `${activeCount} 运行中 · ${unreadCount} 任务结束未读`;
        }
      }

      if (listEl) {
        listEl.textContent = "";
        if (sessions.length === 0) {
          const empty = document.createElement("div");
          empty.className = "mastery-empty-tip";
          empty.textContent = "暂无可追踪会话，发起任意对话后将自动显示";
          listEl.appendChild(empty);
        } else {
          const hasNonFav = sessions.some((item) => !item.isFavorite);
          let lastFavIndex = -1;
          if (hasNonFav) {
            sessions.forEach((item, idx) => {
              if (item.isFavorite) lastFavIndex = idx;
            });
          }

          sessions.forEach((s, idx) => {
            const isSelected = s.id === selectedSessionId;
            const isFav = Boolean(s.isFavorite);
            const isFavDivider = idx === lastFavIndex;
            const rowStatus = s.status === "active" ? "active" : s.status === "done" || s.isRead ? "done" : "unread";
            const rowMod = `is-${rowStatus}`;

            const row = document.createElement("div");
            row.className = `mv-f-row ${rowMod}${isSelected ? " is-selected" : ""}${isFav ? " is-favorite" : ""}${isFavDivider ? " is-fav-divider" : ""}`;
            row.setAttribute("role", "option");
            row.setAttribute("tabindex", "0");
            row.setAttribute("aria-selected", String(isSelected));
            row.title = `${isFav ? "★ 常用置顶 · " : ""}${s.project} / ${s.name} · ${s.tag} (主 Agent 进度 ${s.progress}%)`;

            const lamp = document.createElement("span");
            lamp.className = `mv-f-lamp ${rowMod}`;

            const favBtn = document.createElement("button");
            favBtn.type = "button";
            favBtn.className = `mv-f-fav-btn${isFav ? " is-favorited" : ""}`;
            favBtn.setAttribute("aria-label", isFav ? "取消常用会话" : "设为常用会话并置顶");
            favBtn.setAttribute("aria-pressed", String(isFav));
            favBtn.title = isFav ? "点击取消常用会话" : "点击设为常用会话（始终置顶）";
            favBtn.appendChild(buildStarIconSvg(isFav));
            favBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              void toggleFavoriteSession(s);
            });

            const subCount = document.createElement("span");
            subCount.className = `mv-f-subcount${s.subAgentCount === 0 ? " is-zero" : ""}`;
            subCount.textContent = String(s.subAgentCount || 0);
            subCount.title =
              s.subAgentCount > 0
                ? `当前运行中子 Agent：${s.subAgentCount} 个`
                : "当前无运行中的子 Agent";

            const proj = document.createElement("span");
            proj.className = "mv-f-proj";
            proj.textContent = `[${s.project}]`;

            const name = document.createElement("span");
            name.className = "mv-f-name";
            name.textContent = s.name;

            const status = document.createElement("span");
            status.className = `mv-f-status${rowStatus === "active" ? "" : ` ${rowMod}`}`;
            status.textContent = s.tag;

            const ring = createProgressRing(s.progress, rowStatus, 15);

            const cursor = document.createElement("span");
            cursor.className = "mv-f-cursor";
            cursor.textContent = isSelected ? "◀" : "";

            row.appendChild(lamp);
            row.appendChild(favBtn);
            row.appendChild(subCount);
            row.appendChild(proj);
            row.appendChild(name);
            row.appendChild(status);
            row.appendChild(ring);
            row.appendChild(cursor);

            const selectRow = () => {
              if (selectedSessionId === s.id && !detailAgentKey) return;
              selectionSeq += 1;
              selectedSessionId = s.id;
              hoveredAgentId = null;
              if (detailAgentKey) closeAgentDetail();
              void refreshMastery({ force: true });
            };

            row.addEventListener("click", selectRow);
            row.addEventListener("keydown", (e) => {
              if (e.target && e.target.closest?.(".mv-f-fav-btn")) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                selectRow();
              }
            });

            listEl.appendChild(row);
          });
        }
      }
    }

    const session = snap.detailSession;
    activeDetailSession = session || null;
    const nextGraphSig = buildWorkspaceGraphSignature(session);
    const graphChanged = nextGraphSig !== lastRenderedGraphSig;

    if (!session) {
      if (graphChanged) {
        lastRenderedGraphSig = nextGraphSig;
        if (overviewPctEl) overviewPctEl.textContent = "0%";
        if (overviewSummaryEl) overviewSummaryEl.textContent = "等待活动会话";
        if (overviewJumpBtn) overviewJumpBtn.hidden = true;
        if (madJumpSessionBtn) madJumpSessionBtn.hidden = true;
        if (totalFillBarEl) totalFillBarEl.style.width = "0%";
        if (overviewGoalEl) overviewGoalEl.textContent = "";
        if (colMasterEl) colMasterEl.textContent = "";
        if (colSubsEl) colSubsEl.textContent = "";
        if (graphSvgEl) graphSvgEl.textContent = "";
        nodeElMap.clear();
      }
      return;
    }

    if (graphChanged) {
      lastRenderedGraphSig = nextGraphSig;
      const isDone = session.status === "done" || Boolean(session.isRead);
      const isUnread = session.status !== "active" && !isDone;
      const masterProgress = session.master ? session.master.progress : session.progress;

      if (overviewPctEl) {
        overviewPctEl.textContent = `${masterProgress}%`;
        overviewPctEl.classList.toggle("is-unread", isUnread);
        overviewPctEl.classList.toggle("is-done", isDone);
      }
      if (overviewSummaryEl) {
        overviewSummaryEl.textContent = session.summaryText || "";
      }
      if (overviewJumpBtn) {
        overviewJumpBtn.hidden = !session.id;
        overviewJumpBtn.title = `在 Antigravity 中跳转到会话：[${session.project}] ${session.name}`;
      }
      if (totalFillBarEl) {
        totalFillBarEl.style.width = `${masterProgress}%`;
        totalFillBarEl.classList.toggle("is-unread", isUnread);
        totalFillBarEl.classList.toggle("is-done", isDone);
      }
      if (overviewGoalEl) {
        overviewGoalEl.textContent = `当前目标：${session.goal || session.name}`;
        overviewGoalEl.title = session.goal || session.name;
      }

      nodeElMap.clear();
      if (colMasterEl) {
        colMasterEl.textContent = "";
        if (session.master) {
          colMasterEl.appendChild(createMasterNodeEl(session.master, session));
        }
      }
      if (colSubsEl) {
        colSubsEl.textContent = "";
        const subs = Array.isArray(session.subs) ? session.subs : [];
        if (subs.length === 0) {
          const solo = document.createElement("div");
          solo.className = "mastery-solo-note";
          solo.textContent = "当前为单 Agent 独立执行（无派生子 Agent），点击左侧「主 Agent」查看完整类 Codex 历程";
          colSubsEl.appendChild(solo);
        } else {
          subs.forEach((sub) => colSubsEl.appendChild(createSubNodeEl(sub, session)));
        }
      }
    }

    // If user is currently inside View 2, keep timeline live-synced in place
    if (detailAgentKey && detailViewEl && !detailViewEl.hidden) {
      const targetAgent =
        detailAgentKey === "coord"
          ? session.master
          : (session.subs || []).find((sub) => sub.id === detailAgentKey);
      if (targetAgent) {
        syncComposerDockVisibility(detailAgentKey === "coord", session);
        renderAgentTimeline(targetAgent, detailAgentKey === "coord", session, {
          preserveScroll: true,
        });
      }
    } else if (graphChanged && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => drawGraphEdges());
    }
  };

  const refreshMastery = async ({ force = false } = {}) => {
    if (destroyed || typeof apiFetch !== "function") return;
    if (inFlight) {
      if (force) pendingRefresh = true;
      return;
    }
    inFlight = true;
    const reqCfgSeq = configMutationSeq;
    const reqSelSeq = selectionSeq;
    const reqFavSeq = favoriteMutationSeq;
    try {
      const qs = selectedSessionId ? `?sessionId=${encodeURIComponent(selectedSessionId)}` : "";
      const data = await callJson(apiFetch, `/api/mastery${qs}`);
      if (destroyed) return;
      renderSnapshot(data, { reqCfgSeq, reqSelSeq, reqFavSeq });
    } catch {
      // Non-fatal refresh error
    } finally {
      inFlight = false;
      if (pendingRefresh && !destroyed) {
        pendingRefresh = false;
        void refreshMastery({ force: false });
      }
    }
  };

  const stopPolling = () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const startPolling = () => {
    if (pollTimer !== null || destroyed || !tabActive) return;
    pollTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshMastery();
    }, POLL_INTERVAL_MS);
  };

  // ========== Third-Party Modal Logic ==========
  let tpModalSeq = 0;
  let tpSaveInFlight = false;

  const populateModelSelect = (models, selectedValue) => {
    if (!tpModelSelect) return;
    tpModelSelect.textContent = "";
    const list = Array.isArray(models) && models.length ? models : ["gpt-4o-mini"];
    list.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      tpModelSelect.appendChild(opt);
    });
    tpModelSelect.value = selectedValue && list.includes(selectedValue) ? selectedValue : list[0];
  };

  const applyProtocolUi = (proto, resetUrlIfDefault) => {
    draftProto = proto === "anthropic" ? "anthropic" : "openai";
    const preset = PROTOCOL_PRESETS[draftProto];
    tpProtoBtns.forEach((btn) => {
      const active = btn.getAttribute("data-tp-proto") === draftProto;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    if (tpProtoHint) tpProtoHint.textContent = preset.hint;
    if (tpUrlInput) {
      tpUrlInput.placeholder = preset.urlPlaceholder;
      if (resetUrlIfDefault) {
        const cur = tpUrlInput.value.trim();
        if (
          !cur ||
          cur === PROTOCOL_PRESETS.openai.urlPlaceholder ||
          cur === PROTOCOL_PRESETS.anthropic.urlPlaceholder
        ) {
          tpUrlInput.value = preset.urlPlaceholder;
        }
      }
    }
    if (tpKeyInput) {
      tpKeyInput.placeholder = configState.thirdParty?.hasApiKey
        ? `已保存 (${configState.thirdParty.apiKeyMasked || "****"})，留空则沿用`
        : preset.keyPlaceholder;
    }
  };

  const openThirdPartyModal = () => {
    if (!modalBackdrop) return;
    tpModalSeq += 1;
    const tp = configState.thirdParty || {};
    draftProto = tp.protocol === "anthropic" ? "anthropic" : "openai";
    const preset = PROTOCOL_PRESETS[draftProto];
    draftModels =
      Array.isArray(tp.fetchedModels) && tp.fetchedModels.length
        ? [...tp.fetchedModels]
        : [...preset.models];

    if (tpUrlInput) tpUrlInput.value = tp.baseUrl || preset.urlPlaceholder;
    if (tpKeyInput) {
      tpKeyInput.value = "";
      tpKeyInput.type = "password";
    }
    if (tpToggleKeyBtn) tpToggleKeyBtn.textContent = "显示";

    applyProtocolUi(draftProto, false);
    populateModelSelect(draftModels, tp.selectedModel);

    if (tpFetchStatus) {
      tpFetchStatus.textContent = `当前列表 ${draftModels.length} 个模型，点击右侧拉取最新列表`;
      tpFetchStatus.className = "tp-fetch-status";
    }
    if (tpTestResult) {
      tpTestResult.textContent = "";
      tpTestResult.className = "tp-test-result";
    }
    modalBackdrop.hidden = false;
  };

  const closeThirdPartyModal = () => {
    tpModalSeq += 1;
    if (modalBackdrop) modalBackdrop.hidden = true;
  };

  // ========== Bind UI Events ==========
  on(madBackBtn, "click", closeAgentDetail);
  on(overviewJumpBtn, "click", () => jumpToSession(activeDetailSession));
  on(madJumpSessionBtn, "click", () => jumpToSession(activeDetailSession));

  on(
    document,
    "keydown",
    (e) => {
      if (!tabActive) return;
      if (lightboxBackdrop && !lightboxBackdrop.hidden) {
        if (e.key === "Escape") {
          e.stopImmediatePropagation?.();
          closeImageLightbox();
        } else if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          setLightboxZoom(lightboxScale * 1.25);
        } else if (e.key === "-") {
          e.preventDefault();
          setLightboxZoom(lightboxScale / 1.25);
        } else if (e.key === "0") {
          e.preventDefault();
          setLightboxZoom(1);
        }
        return;
      }
      if (e.key !== "Escape") return;
      if (madSlashMenu && !madSlashMenu.hidden) {
        e.stopImmediatePropagation?.();
        closeSlashMenu();
        return;
      }
      if (typeof document !== "undefined" && document.activeElement === madComposerInput) {
        e.stopImmediatePropagation?.();
        madComposerInput?.blur?.();
        return;
      }
      if (modalBackdrop && !modalBackdrop.hidden) {
        e.stopImmediatePropagation?.();
        closeThirdPartyModal();
      } else if (detailViewEl && !detailViewEl.hidden) {
        closeAgentDetail();
      }
    },
    true
  );

  // ========== Main Agent Frosted-Glass Composer Events ==========
  on(madComposerInput, "input", () => {
    autoResizeComposerInput();
    saveCurrentComposerDraft();
    updateComposerCommandChip();
    updateComposerSendState();
    refreshSlashMenu();
  });

  on(madComposerInput, "click", () => {
    refreshSlashMenu();
  });

  on(madComposerInput, "keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const menuOpen = Boolean(madSlashMenu && !madSlashMenu.hidden && slashMatches.length > 0);
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashActiveIndex = (slashActiveIndex + 1) % slashMatches.length;
        renderSlashMenu();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashActiveIndex = (slashActiveIndex - 1 + slashMatches.length) % slashMatches.length;
        renderSlashMenu();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        applySlashSelection(slashMatches[slashActiveIndex] || slashMatches[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSlashMenu();
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      void sendComposerMessage();
    }
  });

  on(madComposerInput, "paste", (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const pastedImages = [];
    if (cd.items && cd.items.length > 0) {
      for (let i = 0; i < cd.items.length; i += 1) {
        const it = cd.items[i];
        if (it && it.kind === "file" && String(it.type || "").toLowerCase().startsWith("image/")) {
          const f = it.getAsFile?.();
          if (f) pastedImages.push(f);
        }
      }
    } else if (cd.files && cd.files.length > 0) {
      for (let i = 0; i < cd.files.length; i += 1) {
        const f = cd.files[i];
        if (f && String(f.type || "").toLowerCase().startsWith("image/")) {
          pastedImages.push(f);
        }
      }
    }
    if (pastedImages.length > 0) {
      const plainText = typeof cd.getData === "function" ? cd.getData("text/plain") : "";
      if (!plainText) {
        e.preventDefault();
      }
      addComposerImageFiles(pastedImages);
    }
  });

  on(madComposerAttachBtn, "click", () => {
    madComposerFileInput?.click?.();
  });

  on(madComposerFileInput, "change", () => {
    if (madComposerFileInput?.files?.length) {
      addComposerImageFiles(madComposerFileInput.files);
      madComposerFileInput.value = "";
    }
  });

  on(madComposerSlashBtn, "click", () => {
    if (!madComposerInput) return;
    if (madSlashMenu && !madSlashMenu.hidden) {
      closeSlashMenu();
      madComposerInput.focus?.();
      return;
    }
    void ensureComposerCommandsLoaded();
    const cur = String(madComposerInput.value || "");
    if (!cur.trimStart().startsWith("/")) {
      madComposerInput.value = cur ? `/${cur}` : "/";
      try {
        madComposerInput.focus();
        madComposerInput.setSelectionRange?.(1, 1);
      } catch {}
      autoResizeComposerInput();
      saveCurrentComposerDraft();
      updateComposerCommandChip();
      updateComposerSendState();
    } else {
      madComposerInput.focus?.();
    }
    refreshSlashMenu({ forceAll: true });
  });

  on(madComposerSendBtn, "click", () => {
    void sendComposerMessage();
  });

  on(madComposerGlass, "dragover", (e) => {
    e.preventDefault();
    madComposerGlass?.classList.add("is-dragover");
  });

  on(madComposerGlass, "dragleave", (e) => {
    if (e.target === madComposerGlass) {
      madComposerGlass?.classList.remove("is-dragover");
    }
  });

  on(madComposerGlass, "drop", (e) => {
    e.preventDefault();
    madComposerGlass?.classList.remove("is-dragover");
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      addComposerImageFiles(files);
    }
  });

  on(document, "click", (e) => {
    if (!madSlashMenu || madSlashMenu.hidden) return;
    const t = e.target;
    if (
      t &&
      typeof t.closest === "function" &&
      (t.closest("#madSlashMenu") || t.closest("#madComposerSlashBtn") || t.closest("#madComposerInput"))
    ) {
      return;
    }
    closeSlashMenu();
  });

  // Lightbox zoom, pan, close, open-file & open-folder controls
  on(lightboxCloseBtn, "click", closeImageLightbox);
  on(lightboxBackdrop, "click", (e) => {
    if (e.target === lightboxBackdrop || e.target === lightboxStage) {
      closeImageLightbox();
    }
  });
  on(lightboxZoomOutBtn, "click", () => setLightboxZoom(lightboxScale / 1.25));
  on(lightboxZoomInBtn, "click", () => setLightboxZoom(lightboxScale * 1.25));
  on(lightboxZoomResetBtn, "click", () => setLightboxZoom(1));
  on(lightboxImg, "dblclick", (e) => {
    e.preventDefault();
    setLightboxZoom(lightboxScale > 1.1 ? 1 : 2);
  });
  on(
    lightboxStage,
    "wheel",
    (e) => {
      if (!lightboxBackdrop || lightboxBackdrop.hidden) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.16 : 1 / 1.16;
      setLightboxZoom(lightboxScale * factor);
    },
    { passive: false }
  );
  on(lightboxImg, "pointerdown", (e) => {
    if (e.button !== 0 || lightboxScale <= 1.02) return;
    e.preventDefault();
    lightboxDragging = true;
    lightboxDragStartX = e.clientX;
    lightboxDragStartY = e.clientY;
    lightboxDragOriginTx = lightboxTx;
    lightboxDragOriginTy = lightboxTy;
    lightboxImg.classList.add("is-dragging");
    lightboxImg.setPointerCapture?.(e.pointerId);
  });
  on(lightboxImg, "pointermove", (e) => {
    if (!lightboxDragging) return;
    lightboxTx = lightboxDragOriginTx + (e.clientX - lightboxDragStartX);
    lightboxTy = lightboxDragOriginTy + (e.clientY - lightboxDragStartY);
    applyLightboxTransform();
  });
  const endLightboxDrag = () => {
    if (!lightboxDragging) return;
    lightboxDragging = false;
    lightboxImg?.classList.remove("is-dragging");
  };
  on(lightboxImg, "pointerup", endLightboxDrag);
  on(lightboxImg, "pointercancel", endLightboxDrag);
  on(lightboxOpenFileBtn, "click", () => {
    if (lightboxTargetPath) void openLocalPath(lightboxTargetPath, { mode: "file" });
  });
  on(lightboxOpenFolderBtn, "click", () => {
    if (lightboxTargetPath) void openLocalPath(lightboxTargetPath, { mode: "folder" });
  });

  on(msmEnableToggle, "change", () => {
    const nextEnabled = Boolean(msmEnableToggle.checked);
    configState.enabled = nextEnabled;
    renderConfigRow();
    const isTp = configState.source === "thirdparty";
    void saveConfigPatch(
      { enabled: nextEnabled },
      {
        toastText: nextEnabled
          ? isTp
            ? "已开启第三方总结模型"
            : "已开启自身模型总结（下一轮对话起生效）"
          : "已关闭总结模型（后续回复将停止输出进度汇报）",
        toastType: nextEnabled ? "success" : "info",
        refreshAfter: true,
      }
    );
  });

  on(msmSelfBtn, "click", () => {
    configState.enabled = true;
    configState.source = "self";
    renderConfigRow();
    void saveConfigPatch(
      { enabled: true, source: "self" },
      { toastText: "已启用自身模型自总结（保留原会话缓存命中）" }
    );
  });

  on(msmThirdPartyBtn, "click", openThirdPartyModal);
  on(tpCloseBtn, "click", closeThirdPartyModal);
  on(tpCancelBtn, "click", closeThirdPartyModal);
  on(modalBackdrop, "click", (e) => {
    if (e.target === modalBackdrop) closeThirdPartyModal();
  });

  freqBtns.forEach((btn) => {
    on(btn, "click", () => {
      const val = btn.getAttribute("data-msm-freq");
      if (!val || val === configState.frequency) return;
      configState.frequency = val;
      renderConfigRow();
      void saveConfigPatch({ frequency: val });
    });
  });

  thinkBtns.forEach((btn) => {
    on(btn, "click", () => {
      const val = btn.getAttribute("data-msm-think");
      if (!val || val === configState.thinking) return;
      configState.thinking = val;
      renderConfigRow();
      void saveConfigPatch({ thinking: val });
    });
  });

  tpProtoBtns.forEach((btn) => {
    on(btn, "click", () => {
      const nextProto = btn.getAttribute("data-tp-proto") || "openai";
      if (nextProto === draftProto) return;
      tpModalSeq += 1;
      applyProtocolUi(nextProto, true);
      draftModels = [...(PROTOCOL_PRESETS[nextProto] || PROTOCOL_PRESETS.openai).models];
      populateModelSelect(draftModels, draftModels[0]);
      if (tpFetchStatus) {
        tpFetchStatus.textContent = `已切换至 ${PROTOCOL_PRESETS[draftProto].name} 协议，可点击获取模型`;
        tpFetchStatus.className = "tp-fetch-status";
      }
      if (tpTestResult) {
        tpTestResult.textContent = "";
        tpTestResult.className = "tp-test-result";
      }
    });
  });

  on(tpToggleKeyBtn, "click", () => {
    if (!tpKeyInput) return;
    const showing = tpKeyInput.type === "text";
    tpKeyInput.type = showing ? "password" : "text";
    tpToggleKeyBtn.textContent = showing ? "显示" : "隐藏";
  });

  on(tpFetchBtn, "click", async () => {
    const reqSeq = tpModalSeq;
    const reqProto = draftProto;
    const prevSelected = tpModelSelect ? tpModelSelect.value : "";
    const baseUrl = tpUrlInput ? tpUrlInput.value.trim() : "";
    const apiKey = tpKeyInput ? tpKeyInput.value.trim() : "";
    tpFetchBtn.disabled = true;
    tpFetchBtn.textContent = "获取中...";
    if (tpFetchStatus) {
      tpFetchStatus.textContent = "正在通过本机后端请求 /models ...";
      tpFetchStatus.className = "tp-fetch-status";
    }
    try {
      const res = await callJson(apiFetch, "/api/mastery/thirdparty/models", {
        method: "POST",
        body: JSON.stringify({ protocol: reqProto, baseUrl, apiKey }),
      });
      if (destroyed || reqSeq !== tpModalSeq) return;
      if (Array.isArray(res?.models) && res.models.length > 0) {
        draftModels = res.models;
        const preferredModel =
          prevSelected && draftModels.includes(prevSelected) ? prevSelected : draftModels[0];
        populateModelSelect(draftModels, preferredModel);
        if (tpFetchStatus) {
          tpFetchStatus.textContent = `✓ 已实时拉取 ${draftModels.length} 个模型 (${res.latencyMs || 0}ms)`;
          tpFetchStatus.className = "tp-fetch-status is-ok";
        }
      }
    } catch (err) {
      if (destroyed || reqSeq !== tpModalSeq) return;
      if (tpFetchStatus) {
        tpFetchStatus.textContent = err?.message || "拉取模型失败，已保留当前列表";
        tpFetchStatus.className = "tp-fetch-status is-warn";
      }
    } finally {
      if (!destroyed) {
        tpFetchBtn.disabled = false;
        tpFetchBtn.textContent = "获取模型";
      }
    }
  });

  on(tpTestConnBtn, "click", async () => {
    const reqSeq = tpModalSeq;
    const reqProto = draftProto;
    const baseUrl = tpUrlInput ? tpUrlInput.value.trim() : "";
    const apiKey = tpKeyInput ? tpKeyInput.value.trim() : "";
    const model = tpModelSelect ? tpModelSelect.value : "";
    if (!baseUrl) {
      if (tpTestResult) {
        tpTestResult.textContent = "请先填写接口地址";
        tpTestResult.className = "tp-test-result is-err";
      }
      return;
    }
    tpTestConnBtn.disabled = true;
    tpTestConnBtn.textContent = "测试中...";
    if (tpTestResult) {
      tpTestResult.textContent = "正在检测接口连通性...";
      tpTestResult.className = "tp-test-result";
    }
    try {
      const res = await callJson(apiFetch, "/api/mastery/thirdparty/test", {
        method: "POST",
        body: JSON.stringify({
          protocol: reqProto,
          baseUrl,
          apiKey,
          model,
          thinking: configState.thinking,
        }),
      });
      if (destroyed || reqSeq !== tpModalSeq) return;
      if (tpTestResult) {
        tpTestResult.textContent = `✓ ${(PROTOCOL_PRESETS[reqProto] || PROTOCOL_PRESETS.openai).name} 连通正常 · ${model} (${res.latencyMs}ms)`;
        tpTestResult.className = "tp-test-result is-ok";
      }
    } catch (err) {
      if (destroyed || reqSeq !== tpModalSeq) return;
      if (tpTestResult) {
        tpTestResult.textContent = err?.message || "连通测试失败";
        tpTestResult.className = "tp-test-result is-err";
      }
    } finally {
      if (!destroyed) {
        tpTestConnBtn.disabled = false;
        tpTestConnBtn.textContent = "测试连通";
      }
    }
  });

  on(tpSaveBtn, "click", async () => {
    if (tpSaveInFlight) return;
    tpSaveInFlight = true;
    if (tpSaveBtn) tpSaveBtn.disabled = true;
    const baseUrl =
      (tpUrlInput ? tpUrlInput.value.trim() : "") || PROTOCOL_PRESETS[draftProto].urlPlaceholder;
    const apiKey = tpKeyInput ? tpKeyInput.value.trim() : "";
    const selectedModel = tpModelSelect ? tpModelSelect.value : draftModels[0] || "gpt-4o-mini";

    try {
      const saved = await saveConfigPatch(
        {
          enabled: true,
          source: "thirdparty",
          thirdParty: {
            protocol: draftProto,
            baseUrl,
            ...(apiKey ? { apiKey } : {}),
            fetchedModels: [...draftModels],
            selectedModel,
          },
        },
        { toastText: `已保存并启用第三方总结模型：${selectedModel}` }
      );
      if (saved && !destroyed) {
        closeThirdPartyModal();
        void refreshMastery();
      }
    } finally {
      tpSaveInFlight = false;
      if (!destroyed && tpSaveBtn) tpSaveBtn.disabled = false;
    }
  });

  if (typeof ResizeObserver !== "undefined" && graphStageEl) {
    resizeObserver = new ResizeObserver(() => drawGraphEdges());
    resizeObserver.observe(graphStageEl);
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    on(window, "resize", () => drawGraphEdges());
  }

  renderConfigRow();

  return {
    setTabActive(active) {
      const wasActive = tabActive;
      tabActive = Boolean(active);
      if (tabActive) {
        void refreshMastery();
        startPolling();
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => drawGraphEdges());
        }
      } else {
        stopPolling();
        if (wasActive) {
          clearLocalImageCache();
        }
      }
    },
    refresh(opts) {
      if (tabActive) {
        return refreshMastery(opts);
      }
      return undefined;
    },
    loadLocalImage,
    clearImageCache(opts) {
      clearLocalImageCache(opts);
    },
    getCacheStats() {
      return {
        imageCacheSize: localImageUrlCache.size,
        imageCacheMax: LOCAL_IMAGE_CACHE_MAX,
        imageCacheKeys: Array.from(localImageUrlCache.keys()),
        composerDraftCount: composerDraftBySession.size,
        composerDraftMax: COMPOSER_DRAFT_MAX_SESSIONS,
        composerDraftKeys: Array.from(composerDraftBySession.keys()),
        composerDrafts: Array.from(composerDraftBySession.entries()).map(([id, d]) => ({
          id,
          text: d.text,
          attachments: d.attachments,
        })),
      };
    },
    setTranslator() {},
    destroy() {
      destroyed = true;
      clearTimeout(composerRefreshTimer);
      stopPolling();
      resizeObserver?.disconnect?.();
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
      clearLocalImageCache();
      composerDraftBySession.clear();
      composerAttachments = [];
    },
  };
}
