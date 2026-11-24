/**
 * Self-contained Desktop Pet Frontend Extension.
 * Dynamically injects its own stylesheet, nav tab, header toggle, settings panel,
 * frame-animation studio modal, and panel-fallback pet into the AGY Console DOM.
 * Zero static HTML/CSS/i18n footprint required in core files.
 */

const BUILTIN_PETS = [
  { id: "neko", nameKey: "pet.builtinNeko" },
  { id: "ghost", nameKey: "pet.builtinGhost" },
  { id: "mecha", nameKey: "pet.builtinMecha" },
];

const DEFAULT_BUBBLE_TEMPLATE = "入 {in} · 出 {out}";
const BUBBLE_PRESETS = [
  { id: "tokens", labelKey: "pet.bubblePresetTokens", tpl: "入 {in} · 出 {out}" },
  { id: "tps", labelKey: "pet.bubblePresetTps", tpl: "⚡ {tps} tok/s" },
  { id: "tokens_tps", labelKey: "pet.bubblePresetTokensTps", tpl: "入 {in} · 出 {out} · {tps}t/s" },
  { id: "context", labelKey: "pet.bubblePresetContext", tpl: "{model} · 上下文 {pct}%" },
  { id: "quota", labelKey: "pet.bubblePresetQuota", tpl: "{model} · {quota}" },
  { id: "full", labelKey: "pet.bubblePresetFull", tpl: "{model} · 入 {in} 出 {out} ({pct}%)" },
  { id: "cute", labelKey: "pet.bubblePresetCute", tpl: "摸摸头~ 能量满格 ✨ ({pct}%)" },
];
const BUBBLE_VARS = ["{in}", "{out}", "{tps}", "{pct}", "{model}", "{cache}", "{unread}", "{quota}"];

const BUILTIN_PET_IDS = new Set(BUILTIN_PETS.map((p) => p.id));
const ALLOWED_PET_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const EXT_TO_PET_MIME = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
});
const MAX_PET_UPLOAD_BYTES = 8 * 1024 * 1024;
const SVG_NS = "http://www.w3.org/2000/svg";

function resolveExtUrl(relPath) {
  const basePath =
    typeof window !== "undefined" && typeof window.location?.pathname === "string"
      ? window.location.pathname.replace(/[^/]*$/, "")
      : "/";
  const prefix = basePath && basePath !== "/" ? basePath.replace(/\/+$/, "") : "";
  const clean = String(relPath || "").replace(/^\/+/, "");
  return `${prefix}/${clean}`;
}

function getExtPetAssetUrl(id, file = "") {
  const params = new URLSearchParams({ id: String(id) });
  if (file) params.set("file", String(file));
  return `${resolveExtUrl("api/ext/pet/asset")}?${params.toString()}`;
}

async function fetchExtPetApi(apiFetch, url, options = {}) {
  const fetcher = apiFetch || (typeof window !== "undefined" ? window.sidecar?.fetch : null);
  if (typeof fetcher !== "function") throw new Error("window.sidecar.fetch unavailable");
  const res = await fetcher(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.reason || data?.error || `HTTP ${res.status}`);
  }
  return data;
}

function resolvePetUploadMime(file) {
  const rawType = String(file?.type || "").trim().toLowerCase();
  if (rawType === "image/jpg") return "image/jpeg";
  if (ALLOWED_PET_MIME.has(rawType)) return rawType;
  if (!rawType) {
    const name = String(file?.name || "").trim().toLowerCase();
    const dot = name.lastIndexOf(".");
    if (dot >= 0 && EXT_TO_PET_MIME[name.slice(dot)]) return EXT_TO_PET_MIME[name.slice(dot)];
  }
  return "";
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === false) return;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k === "hidden") node.hidden = Boolean(v);
    else node.setAttribute(k, v === true ? "" : String(v));
  });
  (Array.isArray(children) ? children : [children]).forEach((ch) => {
    if (ch) node.appendChild(ch);
  });
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, String(v)));
  return node;
}

function makeIconSvg(w, h, viewBox, paths, strokeMode = true) {
  const svg = svgEl("svg", {
    width: String(w),
    height: String(h),
    viewBox,
    fill: strokeMode ? "none" : "currentColor",
    "aria-hidden": "true",
  });
  paths.forEach(([tag, attrs]) => svg.appendChild(svgEl(tag, attrs)));
  return svg;
}

function createPawSvg() {
  const svg = makeIconSvg(
    12,
    12,
    "0 0 16 16",
    [
      ["circle", { cx: "4.2", cy: "5.6", r: "1.45" }],
      ["circle", { cx: "7.0", cy: "3.8", r: "1.45" }],
      ["circle", { cx: "10.2", cy: "4.2", r: "1.4" }],
      ["circle", { cx: "12.2", cy: "6.6", r: "1.35" }],
      ["path", { d: "M5.1 9.4c0-1.5 1.3-2.6 2.9-2.6s2.9 1.1 2.9 2.6c0 1.4-.9 2.5-2.1 2.5-.4 0-.6-.2-.8-.2s-.4.2-.8.2c-1.2 0-2.1-1.1-2.1-2.5Z" }],
    ],
    false
  );
  svg.setAttribute("class", "pet-quick-icon");
  return svg;
}

function createDeleteSvg() {
  return makeIconSvg(10, 10, "0 0 16 16", [
    ["path", { d: "m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" }],
  ]);
}

function createEditSvg() {
  return makeIconSvg(10, 10, "0 0 16 16", [
    ["path", { d: "M11.2 2.4a1.6 1.6 0 0 1 2.3 2.3L6 12.2l-3.2.9.9-3.2 7.5-7.5Z", stroke: "currentColor", "stroke-width": "1.35", "stroke-linejoin": "round" }],
  ]);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader !== "function") {
      reject(new Error("FileReader unavailable"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function sliceHorizontalSpriteSheet(dataUrl, cols) {
  return new Promise((resolve, reject) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const count = Math.max(2, Math.min(32, Math.round(Number(cols) || 4)));
          const natW = img.naturalWidth || img.width || 0;
          const natH = img.naturalHeight || img.height || 0;
          if (natW < count || natH < 2) {
            reject(new Error("Image too small to slice"));
            return;
          }
          const cellW = Math.floor(natW / count);
          const outW = Math.min(320, cellW);
          const outH = Math.max(1, Math.round((natH * outW) / cellW));
          const canvas = document.createElement("canvas");
          canvas.width = outW;
          canvas.height = outH;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("Canvas unavailable"));
            return;
          }
          const frames = [];
          for (let i = 0; i < count; i += 1) {
            ctx.clearRect(0, 0, outW, outH);
            ctx.drawImage(img, i * cellW, 0, cellW, natH, 0, 0, outW, outH);
            const url = canvas.toDataURL("image/png");
            const comma = url.indexOf(",");
            frames.push({
              mime: "image/png",
              base64: comma >= 0 ? url.slice(comma + 1) : "",
              previewUrl: url,
            });
          }
          resolve(frames);
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("Failed to decode image"));
      img.src = dataUrl;
    } catch (err) {
      reject(err);
    }
  });
}

function buildBuiltinPetSvg(kind, { compact = false, mood = "idle" } = {}) {
  const size = compact ? 50 : 88;
  const svg = svgEl("svg", {
    viewBox: "0 0 112 112",
    width: String(size),
    height: String(size),
    class: `pet-vector-svg is-pet-${kind} is-mood-${mood}`,
    "aria-hidden": "true",
  });
  svg.appendChild(svgEl("ellipse", { cx: "56", cy: "101", rx: "30", ry: "6", class: "pet-svg-shadow" }));

  if (kind === "ghost") {
    svg.appendChild(svgEl("ellipse", { cx: "56", cy: "17", rx: "19", ry: "5", class: "pet-svg-accent-stroke pet-part-halo", fill: "none", "stroke-width": "2.8" }));
    svg.appendChild(svgEl("path", { d: "M 26,56 C 26,28 86,28 86,56 L 86,87 C 81,93 74,84 68,90 C 62,95 56,85 50,90 C 44,95 38,84 32,90 C 28,93 26,89 26,87 Z", class: "pet-svg-ghost-body", "stroke-width": "2" }));
    svg.appendChild(svgEl("path", { d: "M 26,59 Q 17,64 23,71 M 86,59 Q 95,64 89,71", class: "pet-svg-accent-stroke", fill: "none", "stroke-width": "3", "stroke-linecap": "round" }));
    const eyeRy = mood === "sleep" ? "1.6" : "6.5";
    svg.appendChild(svgEl("ellipse", { cx: "45.5", cy: "51.5", rx: "5.5", ry: eyeRy, class: "pet-svg-dark-eye pet-part-eye" }));
    svg.appendChild(svgEl("ellipse", { cx: "66.5", cy: "51.5", rx: "5.5", ry: eyeRy, class: "pet-svg-dark-eye pet-part-eye" }));
    if (mood !== "sleep") {
      svg.appendChild(svgEl("circle", { cx: "47", cy: "49", r: "2", class: "pet-svg-accent-fill" }));
      svg.appendChild(svgEl("circle", { cx: "68", cy: "49", r: "2", class: "pet-svg-accent-fill" }));
    }
    svg.appendChild(svgEl("ellipse", { cx: "36.5", cy: "60.5", rx: "4.5", ry: "2.5", class: "pet-svg-blush" }));
    svg.appendChild(svgEl("ellipse", { cx: "75.5", cy: "60.5", rx: "4.5", ry: "2.5", class: "pet-svg-blush" }));
    svg.appendChild(svgEl("path", { d: mood === "unread" ? "M 49,60 Q 56,68 63,60" : "M 51,61 Q 56,65.5 61,61", class: "pet-svg-dark-stroke", fill: "none", "stroke-width": "2", "stroke-linecap": "round" }));
    return svg;
  }

  if (kind === "mecha") {
    const antennaGroup = svgEl("g", { class: "pet-part-tail" });
    antennaGroup.appendChild(svgEl("path", { d: "M 56,26 L 56,14", class: "pet-svg-dark-stroke", fill: "none", "stroke-width": "3", "stroke-linecap": "round" }));
    antennaGroup.appendChild(svgEl("circle", { cx: "56", cy: "12", r: "5", class: "pet-svg-accent-fill" }));
    svg.appendChild(antennaGroup);
    svg.appendChild(svgEl("ellipse", { cx: "56", cy: "93", rx: "17", ry: "4", class: "pet-svg-thruster" }));
    svg.appendChild(svgEl("rect", { x: "34", y: "68", width: "44", height: "24", rx: "11", class: "pet-svg-mecha-shell", "stroke-width": "1.6" }));
    svg.appendChild(svgEl("circle", { cx: "56", cy: "80", r: "4.5", class: "pet-svg-accent-fill" }));
    svg.appendChild(svgEl("rect", { x: "19", y: "38", width: "8", height: "20", rx: "4", class: "pet-svg-accent-fill" }));
    svg.appendChild(svgEl("rect", { x: "85", y: "38", width: "8", height: "20", rx: "4", class: "pet-svg-accent-fill" }));
    svg.appendChild(svgEl("rect", { x: "25", y: "25", width: "62", height: "46", rx: "18", class: "pet-svg-mecha-shell", "stroke-width": "1.8" }));
    svg.appendChild(svgEl("rect", { x: "32", y: "34", width: "48", height: "28", rx: "10", class: "pet-svg-visor" }));
    const faceTxt = svgEl("text", { x: "56", y: "53", "text-anchor": "middle", class: "pet-svg-visor-text" });
    faceTxt.textContent = mood === "running" ? "> <" : mood === "unread" ? "★ ★" : mood === "sleep" ? "- -" : "• •";
    svg.appendChild(faceTxt);
    return svg;
  }

  // neko
  svg.appendChild(svgEl("path", { d: "M 78,80 C 96,78 103,60 95,48 C 91,42 84,48 88,54 C 92,60 88,70 76,73", class: "pet-svg-neko-tail pet-part-tail", fill: "none", "stroke-width": "7.5", "stroke-linecap": "round" }));
  svg.appendChild(svgEl("path", { d: "M 31,62 C 26,80 31,96 56,96 C 81,96 86,80 81,62 Z", class: "pet-svg-neko-body", "stroke-width": "1.6" }));
  svg.appendChild(svgEl("path", { d: "M 37,65 Q 56,72 75,65", class: "pet-svg-accent-stroke", fill: "none", "stroke-width": "4", "stroke-linecap": "round" }));
  svg.appendChild(svgEl("circle", { cx: "56", cy: "70", r: "4", class: "pet-svg-gold-fill" }));
  svg.appendChild(svgEl("path", { d: "M 31,42 L 26,18 L 46,31 Z", class: "pet-svg-neko-body", "stroke-width": "1.5" }));
  svg.appendChild(svgEl("path", { d: "M 81,42 L 86,18 L 66,31 Z", class: "pet-svg-neko-body", "stroke-width": "1.5" }));
  svg.appendChild(svgEl("path", { d: "M 32,37 L 30,24 L 42,32 Z", class: "pet-svg-blush-strong" }));
  svg.appendChild(svgEl("path", { d: "M 80,37 L 82,24 L 70,32 Z", class: "pet-svg-blush-strong" }));
  svg.appendChild(svgEl("ellipse", { cx: "56", cy: "47", rx: "29", ry: "23", class: "pet-svg-neko-body", "stroke-width": "1.6" }));
  const nekoEyeRy = mood === "sleep" ? "1.4" : "5.5";
  svg.appendChild(svgEl("ellipse", { cx: "43.5", cy: "46.5", rx: "5.5", ry: nekoEyeRy, class: "pet-svg-gold-fill pet-part-eye" }));
  svg.appendChild(svgEl("ellipse", { cx: "68.5", cy: "46.5", rx: "5.5", ry: nekoEyeRy, class: "pet-svg-gold-fill pet-part-eye" }));
  if (mood !== "sleep") {
    svg.appendChild(svgEl("circle", { cx: "45", cy: "45", r: "1.9", class: "pet-svg-spark" }));
    svg.appendChild(svgEl("circle", { cx: "70", cy: "45", r: "1.9", class: "pet-svg-spark" }));
  }
  svg.appendChild(svgEl("ellipse", { cx: "37", cy: "54", rx: "4", ry: "2.2", class: "pet-svg-blush" }));
  svg.appendChild(svgEl("ellipse", { cx: "75", cy: "54", rx: "4", ry: "2.2", class: "pet-svg-blush" }));
  svg.appendChild(svgEl("path", { d: "M 54,51 L 58,51 L 56,53.5 Z", class: "pet-svg-blush-strong" }));
  svg.appendChild(svgEl("path", { d: "M 51,55 Q 53.5,58 56,55 Q 58.5,58 61,55", class: "pet-svg-light-stroke", fill: "none", "stroke-width": "1.4", "stroke-linecap": "round" }));
  svg.appendChild(svgEl("path", { d: "M 22,47 L 31,48 M 21,52 L 31,52 M 81,48 L 90,47 M 81,52 L 91,52", class: "pet-svg-whisker", fill: "none", "stroke-width": "1.2", "stroke-linecap": "round" }));
  svg.appendChild(svgEl("ellipse", { cx: "44.5", cy: "92.5", rx: "6.5", ry: "4.5", class: "pet-svg-neko-body", "stroke-width": "1.2" }));
  svg.appendChild(svgEl("ellipse", { cx: "67.5", cy: "92.5", rx: "6.5", ry: "4.5", class: "pet-svg-neko-body", "stroke-width": "1.2" }));
  return svg;
}

/**
 * Dynamically builds and injects all Desktop Pet UI elements into the host panel.
 */
function buildExtensionDom(tr) {
  const injectedNodes = [];
  const head = document.head;
  if (head && !document.getElementById("agyExtDesktopPetCss")) {
    const cssLink = el("link", {
      id: "agyExtDesktopPetCss",
      rel: "stylesheet",
      href: resolveExtUrl("extensions/desktop_pet/desktop_pet.css"),
    });
    head.appendChild(cssLink);
    injectedNodes.push(cssLink);
  }

  // 1. Header Tab Button ("桌宠") right after "美化"
  const tabsGroup = document.querySelector(".monitor-subnav .subnav-tabs-group");
  const petTabLabel = el("span", { text: tr("nav.pet") });
  const petTabBtn = el(
    "button",
    { class: "subnav-tab", type: "button", role: "tab", "data-subnav": "pet", "aria-selected": "false" },
    [petTabLabel]
  );
  if (tabsGroup) {
    tabsGroup.appendChild(petTabBtn);
    injectedNodes.push(petTabBtn);
  }

  // 2. Header Quick Toggle Button
  const metaRight = document.querySelector(".monitor-subnav .subnav-meta-right");
  const quickToggleLabel = el("span", { class: "pet-quick-label", id: "petQuickToggleLabel", text: tr("pet.quickToggleLabel") });
  const quickToggleBtn = el(
    "button",
    {
      class: "pet-quick-btn",
      id: "petQuickToggleBtn",
      type: "button",
      "aria-pressed": "false",
      title: tr("pet.quickToggleTitle"),
      "aria-label": tr("pet.quickToggleTitle"),
    },
    [el("span", { class: "pet-quick-dot", "aria-hidden": "true" }), createPawSvg(), quickToggleLabel]
  );
  if (metaRight) {
    if (metaRight.children && metaRight.children.length > 0 && typeof metaRight.insertBefore === "function") {
      metaRight.insertBefore(quickToggleBtn, metaRight.children[0]);
    } else {
      metaRight.appendChild(quickToggleBtn);
    }
    injectedNodes.push(quickToggleBtn);
  }

  // 3. Dedicated Pet Tab Panel (#panelPet)
  const statusBadge = el("span", { class: "boundary-badge is-disabled", id: "petStatusBadge", text: tr("pet.statusOff") });
  const toggleLabel = el("span", { id: "petToggleLabel", text: tr("pet.toggleOff") });
  const toggleBtn = el("button", { class: "theme-pill-btn", id: "petToggleBtn", type: "button", "aria-pressed": "false" }, [
    el("span", { class: "theme-toggle-dot", "aria-hidden": "true" }),
    toggleLabel,
  ]);
  const patTestBtn = el("button", { class: "theme-pill-btn", id: "petPatTestBtn", type: "button", text: tr("pet.patBtn") });
  const resetPosBtn = el("button", { class: "theme-pill-btn", id: "petResetPosBtn", type: "button", text: tr("pet.resetPosBtn") });

  const previewBubble = el("div", { class: "pet-preview-bubble", id: "petPreviewBubble", role: "status", "aria-live": "polite", hidden: true });
  const previewVisual = el("div", { class: "pet-preview-visual", id: "petPreviewVisual" });
  const previewActor = el("div", { class: "pet-preview-actor", id: "petPreviewActor", role: "button", tabindex: "0" }, [previewVisual]);
  const previewTrackBtns = [
    el("button", { class: "pet-preview-track-btn is-active", type: "button", "data-preview-track": "auto", text: tr("pet.previewTrackAuto") }),
    el("button", { class: "pet-preview-track-btn", type: "button", "data-preview-track": "idle", text: tr("pet.previewTrackIdle") }),
    el("button", { class: "pet-preview-track-btn", type: "button", "data-preview-track": "running", text: tr("pet.previewTrackRunning") }),
    el("button", { class: "pet-preview-track-btn", type: "button", "data-preview-track": "unread", text: tr("pet.previewTrackUnread") }),
    el("button", { class: "pet-preview-track-btn", type: "button", "data-preview-track": "interact", text: tr("pet.previewTrackInteract") }),
    el("button", { class: "pet-preview-track-btn", type: "button", "data-preview-track": "walk", text: tr("pet.previewTrackWalk") }),
    el("button", { class: "pet-preview-track-btn", type: "button", "data-preview-track": "drag", text: tr("pet.previewTrackDrag") }),
  ];
  const previewTrackBar = el("div", { class: "pet-preview-track-bar", id: "petPreviewTrackBar", hidden: true }, previewTrackBtns);
  const previewStage = el("div", { class: "pet-preview-stage", id: "petPreviewStage" }, [
    previewBubble,
    previewActor,
    el("span", { class: "pet-preview-caption", text: tr("pet.previewCaption") }),
    previewTrackBar,
  ]);
  const statusHint = el("div", { class: "pet-status-hint", id: "petStatusHint", text: tr("pet.hintOff") });

  const sectionOverview = el("section", { class: "theme-section desktop-pet-section", id: "desktopPetSection" }, [
    el("div", { class: "theme-section-header" }, [
      el("div", { class: "theme-section-title-group" }, [
        el("div", { class: "pet-title-line" }, [
          el("span", { class: "theme-section-title", text: tr("pet.sectionTitle") }),
          statusBadge,
        ]),
        el("span", { class: "theme-section-sub", text: tr("pet.sectionSub") }),
      ]),
      el("div", { class: "theme-section-actions" }, [toggleBtn, patTestBtn, resetPosBtn]),
    ]),
    previewStage,
    statusHint,
  ]);

  // Card 2: Gallery & Custom Uploads / Frame Animations
  const framesCreateBtn = el("button", { class: "theme-pill-btn is-primary", id: "petFramesCreateBtn", type: "button" }, [
    makeIconSvg(11, 11, "0 0 16 16", [
      ["rect", { x: "2", y: "3", width: "12", height: "10", rx: "1.6", stroke: "currentColor", "stroke-width": "1.3" }],
      ["path", { d: "M5.5 3v10M10.5 3v10M2 6.5h3.5M10.5 6.5H14M2 9.5h3.5M10.5 9.5H14", stroke: "currentColor", "stroke-width": "1.2" }],
    ]),
    el("span", { text: tr("pet.framesCreateBtn") }),
  ]);
  const uploadBtn = el("button", { class: "theme-pill-btn", id: "petUploadBtn", type: "button" }, [
    makeIconSvg(11, 11, "0 0 16 16", [
      ["path", { d: "M8 10.8V3.2M5.2 6l2.8-2.8L10.8 6M2.8 11.4v1.1a1.2 1.2 0 0 0 1.2 1.2h8a1.2 1.2 0 0 0 1.2-1.2v-1.1", stroke: "currentColor", "stroke-width": "1.35", "stroke-linecap": "round", "stroke-linejoin": "round" }],
    ]),
    el("span", { text: tr("pet.uploadBtn") }),
  ]);
  const fileInput = el("input", { type: "file", id: "petFileInput", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
  const galleryRow = el("div", { class: "pet-gallery-row", id: "petGalleryRow", role: "listbox" });

  const sectionGallery = el("section", { class: "theme-section" }, [
    el("div", { class: "theme-section-header" }, [
      el("div", { class: "theme-section-title-group" }, [
        el("span", { class: "theme-section-title", text: tr("pet.galleryTitle") }),
        el("span", { class: "theme-section-sub", text: tr("pet.gallerySub") }),
      ]),
      el("div", { class: "theme-section-actions" }, [framesCreateBtn, uploadBtn, fileInput]),
    ]),
    galleryRow,
  ]);

  // Card 3: Display & Interaction Settings
  const modeBtns = [
    el("button", { class: "filter-tab is-active", type: "button", "data-pet-mode": "auto", "aria-selected": "true", text: tr("pet.modeAuto") }),
    el("button", { class: "filter-tab", type: "button", "data-pet-mode": "desktop", "aria-selected": "false", text: tr("pet.modeDesktop") }),
    el("button", { class: "filter-tab", type: "button", "data-pet-mode": "panel", "aria-selected": "false", text: tr("pet.modePanel") }),
  ];
  const selectBtns = [
    el("button", { class: "filter-tab is-active", type: "button", "data-pet-selectable": "true", "aria-selected": "true", text: tr("pet.selectOn") }),
    el("button", { class: "filter-tab", type: "button", "data-pet-selectable": "false", "aria-selected": "false", text: tr("pet.selectOff") }),
  ];
  const topmostBtn = el("button", { class: "theme-pill-btn is-toggled", id: "petTopmostBtn", type: "button", "aria-pressed": "true" }, [
    el("span", { class: "theme-toggle-dot", "aria-hidden": "true" }),
    el("span", { text: tr("pet.topmostBtn") }),
  ]);
  const bubbleBtn = el("button", { class: "theme-pill-btn is-toggled", id: "petBubbleBtn", type: "button", "aria-pressed": "true" }, [
    el("span", { class: "theme-toggle-dot", "aria-hidden": "true" }),
    el("span", { text: tr("pet.bubbleBtn") }),
  ]);
  const wanderBtn = el("button", { class: "theme-pill-btn is-toggled", id: "petWanderBtn", type: "button", "aria-pressed": "true" }, [
    el("span", { class: "theme-toggle-dot", "aria-hidden": "true" }),
    el("span", { text: tr("pet.wanderBtn") }),
  ]);
  const sizeVal = el("span", { class: "theme-slider-val", id: "petSizeVal", text: "100%" });
  const sizeInput = el("input", { class: "theme-range", id: "petSizeInput", type: "range", min: "60", max: "500", value: "100" });
  const opacityVal = el("span", { class: "theme-slider-val", id: "petOpacityVal", text: "95%" });
  const opacityInput = el("input", { class: "theme-range", id: "petOpacityInput", type: "range", min: "40", max: "100", value: "95" });

  const bubblePresetBtns = BUBBLE_PRESETS.map((p) =>
    el("button", {
      class: p.tpl === DEFAULT_BUBBLE_TEMPLATE ? "pet-bubble-preset-chip is-active" : "pet-bubble-preset-chip",
      type: "button",
      "data-bubble-tpl": p.tpl,
      text: tr(p.labelKey),
    })
  );
  const bubbleTplInput = el("input", {
    class: "custom-palette-input",
    id: "petBubbleTemplateInput",
    type: "text",
    maxlength: "160",
    value: DEFAULT_BUBBLE_TEMPLATE,
    placeholder: tr("pet.bubbleTplPlaceholder"),
  });
  const bubbleTestBtn = el("button", {
    class: "theme-pill-btn",
    id: "petBubbleTestBtn",
    type: "button",
    text: tr("pet.bubbleTplTestBtn"),
  });
  const bubbleVarBtns = BUBBLE_VARS.map((v) =>
    el("button", { class: "pet-bubble-var-chip", type: "button", "data-bubble-var": v, text: v })
  );
  const bubbleTplCard = el("div", { class: "pet-bubble-tpl-card", id: "petBubbleTplCard" }, [
    el("div", { class: "pet-bubble-tpl-head" }, [
      el("span", { class: "theme-sub-label", text: tr("pet.bubbleTplTitle") }),
    ]),
    el("div", { class: "pet-bubble-presets-row" }, bubblePresetBtns),
    el("div", { class: "pet-bubble-tpl-input-row" }, [bubbleTplInput, bubbleTestBtn]),
    el("div", { class: "pet-bubble-vars-row" }, [
      el("span", { class: "pet-bubble-var-hint", text: tr("pet.bubbleVarHint") }),
      ...bubbleVarBtns,
    ]),
  ]);

  const sectionBehavior = el("section", { class: "theme-section" }, [
    el("div", { class: "theme-section-header" }, [
      el("div", { class: "theme-section-title-group" }, [
        el("span", { class: "theme-section-title", text: tr("pet.behaviorTitle") }),
        el("span", { class: "theme-section-sub", text: tr("pet.behaviorSub") }),
      ]),
    ]),
    el("div", { class: "pet-options-bar" }, [
      el("div", { class: "wallpaper-options-row" }, [
        el("span", { class: "theme-sub-label", text: tr("pet.modeLabel") }),
        el("div", { class: "filter-tab-group", id: "petDisplayModeGroup", role: "tablist" }, modeBtns),
      ]),
      el("div", { class: "wallpaper-options-row" }, [
        el("span", { class: "theme-sub-label", text: tr("pet.selectLabel") }),
        el("div", { class: "filter-tab-group", id: "petSelectableGroup", role: "tablist" }, selectBtns),
      ]),
      el("div", { class: "pet-behavior-toggles" }, [topmostBtn, bubbleBtn, wanderBtn]),
    ]),
    el("div", { class: "pet-sliders-grid" }, [
      el("label", { class: "theme-slider-item" }, [
        el("span", { class: "theme-slider-head" }, [el("span", { text: tr("pet.sizeLabel") }), sizeVal]),
        sizeInput,
      ]),
      el("label", { class: "theme-slider-item" }, [
        el("span", { class: "theme-slider-head" }, [el("span", { text: tr("pet.opacityLabel") }), opacityVal]),
        opacityInput,
      ]),
    ]),
    bubbleTplCard,
    el("div", { class: "pet-tips-grid" }, [
      el("span", { class: "pet-tip-chip", text: tr("pet.tipDrag") }),
      el("span", { class: "pet-tip-chip", text: tr("pet.tipClick") }),
      el("span", { class: "pet-tip-chip", text: tr("pet.tipDblClick") }),
      el("span", { class: "pet-tip-chip", text: tr("pet.tipRightClick") }),
    ]),
  ]);

  const panelPet = el(
    "div",
    { class: "monitor-tab-panel monitor-pet-panel", id: "panelPet", "data-subnav-panel": "pet", hidden: true },
    [sectionOverview, sectionGallery, sectionBehavior]
  );
  const dashboard = document.getElementById("monitorDashboard");
  if (dashboard) {
    dashboard.appendChild(panelPet);
    injectedNodes.push(panelPet);
  }

  // 4. Custom Frame Animation Studio Modal (#petFramesModal)
  const framesBackdrop = el("div", { class: "modal-backdrop", id: "petFramesBackdrop" });
  const framesModalTitle = el("h3", { class: "modal-title", id: "petFramesModalTitle", text: tr("pet.framesModalTitle") });
  const framesCloseBtn = el("button", { class: "modal-close-btn", id: "petFramesCloseBtn", type: "button", "aria-label": tr("common.close") }, [
    makeIconSvg(13, 13, "0 0 16 16", [
      ["path", { d: "m4 4 8 8M12 4l-8 8", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" }],
    ]),
  ]);
  const framesPreviewImg = el("img", { class: "pet-frames-preview-img", id: "petFramesPreviewImg", alt: "", hidden: true, draggable: "false" });
  const framesPreviewEmpty = el("span", { class: "pet-frames-preview-empty", id: "petFramesPreviewEmpty", text: tr("pet.framesPreviewEmpty") });
  const framesPreviewMeta = el("span", { class: "pet-frames-preview-meta", id: "petFramesPreviewMeta", text: "0 / 0" });
  const framesPlayToggleBtn = el("button", { class: "theme-pill-btn", id: "petFramesPlayToggleBtn", type: "button", text: tr("pet.framesPlayPauseBtn") });
  const framesNameInput = el("input", { class: "custom-palette-input", id: "petFramesNameInput", type: "text", maxlength: "48", placeholder: tr("pet.framesNamePlaceholder") });
  const framesFpsVal = el("span", { class: "theme-slider-val", id: "petFramesFpsVal", text: "8 FPS · 125ms/帧" });
  const framesFpsInput = el("input", { class: "theme-range", id: "petFramesFpsInput", type: "range", min: "1", max: "30", value: "8" });
  const framesAddBtn = el("button", { class: "theme-pill-btn is-primary", id: "petFramesAddBtn", type: "button", text: tr("pet.framesAddBtn") });
  const framesSheetColsInput = el("input", { class: "pet-frames-cols-input", id: "petFramesSheetColsInput", type: "number", min: "2", max: "32", value: "4" });
  const framesSheetBtn = el("button", { class: "theme-pill-btn", id: "petFramesSheetBtn", type: "button", text: tr("pet.framesSheetBtn") });
  const framesClearTrackBtn = el("button", { class: "theme-pill-btn", id: "petFramesClearTrackBtn", type: "button", text: tr("pet.framesClearTrackBtn") });
  const framesFilesInput = el("input", { type: "file", id: "petFramesFilesInput", accept: "image/png,image/jpeg,image/webp,image/gif", multiple: true, hidden: true });
  const framesSheetFileInput = el("input", { type: "file", id: "petFramesSheetFileInput", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });

  const makeTrackTab = (key, labelKey, isActive = false) =>
    el(
      "button",
      { class: isActive ? "pet-track-tab is-active" : "pet-track-tab", type: "button", role: "tab", "data-pet-track": key, "aria-selected": String(isActive) },
      [el("span", { text: tr(labelKey) }), el("span", { class: "pet-track-count", "data-pet-track-count": key, text: "0" })]
    );
  const framesTrackTabs = [
    makeTrackTab("idle", "pet.framesTrackIdle", true),
    makeTrackTab("running", "pet.framesTrackRunning", false),
    makeTrackTab("unread", "pet.framesTrackUnread", false),
    makeTrackTab("interact", "pet.framesTrackInteract", false),
    makeTrackTab("walk", "pet.framesTrackWalk", false),
    makeTrackTab("drag", "pet.framesTrackDrag", false),
  ];
  const framesTrackHint = el("div", { class: "pet-frames-track-hint", id: "petFramesTrackHint", hidden: true, text: tr("pet.framesTrackOptionalHint") });
  const framesGrid = el("div", { class: "pet-frames-grid", id: "petFramesGrid" });
  const framesCancelBtn = el("button", { class: "theme-pill-btn", id: "petFramesCancelBtn", type: "button", text: tr("common.cancel") });
  const framesSaveBtn = el("button", { class: "modal-primary-btn", id: "petFramesSaveBtn", type: "button", text: tr("pet.framesSaveBtn") });

  const framesModal = el("div", { class: "modal-overlay pet-frames-modal-overlay", id: "petFramesModal", hidden: true, role: "dialog", "aria-modal": "true" }, [
    framesBackdrop,
    el("div", { class: "modal-dialog pet-frames-dialog" }, [
      el("div", { class: "modal-header" }, [
        el("div", { class: "pet-frames-title-wrap" }, [
          framesModalTitle,
          el("span", { class: "pet-frames-sub", text: tr("pet.framesModalSub") }),
        ]),
        framesCloseBtn,
      ]),
      el("div", { class: "modal-body pet-frames-body" }, [
        el("div", { class: "pet-frames-top-grid" }, [
          el("div", { class: "pet-frames-preview-card" }, [
            el("div", { class: "pet-frames-preview-box" }, [framesPreviewImg, framesPreviewEmpty]),
            el("div", { class: "pet-frames-preview-foot" }, [framesPreviewMeta, framesPlayToggleBtn]),
          ]),
          el("div", { class: "pet-frames-meta-col" }, [
            el("label", { class: "pet-frames-field" }, [
              el("span", { class: "pet-frames-field-label", text: tr("pet.framesNameLabel") }),
              framesNameInput,
            ]),
            el("label", { class: "theme-slider-item" }, [
              el("span", { class: "theme-slider-head" }, [el("span", { text: tr("pet.framesFpsLabel") }), framesFpsVal]),
              framesFpsInput,
            ]),
            el("div", { class: "pet-frames-sheet-row" }, [
              framesAddBtn,
              el("div", { class: "pet-frames-sheet-group" }, [
                el("label", { class: "pet-frames-cols-label", for: "petFramesSheetColsInput", text: tr("pet.framesSheetCols") }),
                framesSheetColsInput,
                framesSheetBtn,
              ]),
              framesClearTrackBtn,
              framesFilesInput,
              framesSheetFileInput,
            ]),
          ]),
        ]),
        el("div", { class: "pet-frames-tracks-bar", role: "tablist" }, framesTrackTabs),
        framesTrackHint,
        framesGrid,
      ]),
      el("div", { class: "modal-footer pet-frames-footer" }, [framesCancelBtn, framesSaveBtn]),
    ]),
  ]);

  // 5. Panel Fallback Floating Pet (#panelPetStage)
  const panelBubble = el("div", { class: "panel-pet-bubble", id: "panelPetBubble", role: "status", "aria-live": "polite", hidden: true });
  const panelCloseBtn = el("button", { class: "panel-pet-close-btn", id: "panelPetCloseBtn", type: "button", title: tr("pet.panelCloseTitle"), "aria-label": tr("pet.panelCloseTitle"), text: "×" });
  const panelVisual = el("div", { class: "panel-pet-visual", id: "panelPetVisual" });
  const panelMoodBadge = el("span", { class: "panel-pet-mood-badge", id: "panelPetMoodBadge", hidden: true, "aria-hidden": "true" });
  const panelBody = el("div", { class: "panel-pet-body", id: "panelPetBody", role: "button", tabindex: "0" }, [
    panelCloseBtn,
    panelVisual,
    panelMoodBadge,
  ]);
  const panelStage = el("div", { class: "panel-pet-stage", id: "panelPetStage", hidden: true }, [panelBubble, panelBody]);

  const shell = document.getElementById("auxPaneShell") || document.body;
  if (shell) {
    shell.appendChild(framesModal);
    shell.appendChild(panelStage);
    injectedNodes.push(framesModal, panelStage);
  }

  return {
    injectedNodes,
    petTabBtn,
    panelPet,
    quickToggleBtn,
    statusBadge,
    toggleBtn,
    toggleLabel,
    uploadBtn,
    fileInput,
    galleryRow,
    modeBtns,
    selectBtns,
    topmostBtn,
    bubbleBtn,
    wanderBtn,
    patTestBtn,
    resetPosBtn,
    previewStage,
    previewActor,
    previewVisual,
    previewBubble,
    previewTrackBar,
    previewTrackBtns,
    sizeInput,
    sizeVal,
    opacityInput,
    opacityVal,
    bubblePresetBtns,
    bubbleTplInput,
    bubbleTestBtn,
    bubbleVarBtns,
    statusHint,
    panelStage,
    panelBubble,
    panelBody,
    panelVisual,
    panelMoodBadge,
    panelCloseBtn,
    framesCreateBtn,
    framesModal,
    framesBackdrop,
    framesModalTitle,
    framesCloseBtn,
    framesCancelBtn,
    framesSaveBtn,
    framesNameInput,
    framesFpsInput,
    framesFpsVal,
    framesPreviewImg,
    framesPreviewEmpty,
    framesPreviewMeta,
    framesPlayToggleBtn,
    framesAddBtn,
    framesFilesInput,
    framesSheetColsInput,
    framesSheetBtn,
    framesSheetFileInput,
    framesClearTrackBtn,
    framesTrackTabs,
    framesTrackHint,
    framesGrid,
  };
}

export function mountDesktopPetExtension(ctx = {}) {
  const { apiFetch, showToast, registerSubnavTab, activateTab, getLanguage } = ctx;
  const tr = createPetTranslator(typeof getLanguage === "function" ? getLanguage() : "zh-CN");
  const dom = buildExtensionDom(tr);

  let destroyed = false;
  let saveTimer = null;
  let statusRecheckTimer = null;
  let bubbleTimer = null;
  let hopTimer = null;
  let previewBubbleTimer = null;
  let previewHopTimer = null;
  let stageFrameTimer = null;
  let stageFrameIndex = 0;
  let stageFrameKey = "";
  let interactUntilMs = 0;
  let interactTimer = null;
  let previewTrackOverride = "auto";
  let lastKnownUpdatedAt = 0;
  let lastHandledPreviewTs = 0;
  let lastServerPollMs = 0;
  let editorPreviewTimer = null;
  let editorPreviewIndex = 0;
  let editorPlaying = true;
  let editorSaving = false;
  let persistInFlight = false;
  let persistQueued = false;
  let lastAutoMood = "";
  let lastShownTurnSig = "";
  let hasInitialTurnBaseline = false;
  let renderedPanelVisualKey = "";
  let renderedPreviewVisualKey = "";
  let patCounter = 0;
  const cleanups = [];

  const formatTokenCount = (n) => {
    const num = Math.max(0, Math.round(Number(n) || 0));
    if (num < 1000) return String(num);
    if (num < 100000) return `${(num / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    if (num < 1000000) return `${Math.round(num / 1000)}k`;
    return `${(num / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  };

  const state = {
    enabled: false,
    activePetId: "neko",
    customPets: [],
    displayMode: "auto",
    size: 100,
    opacity: 95,
    alwaysOnTop: true,
    showSpeechBubble: true,
    bubbleTemplate: DEFAULT_BUBBLE_TEMPLATE,
    autoWander: true,
    selectable: true,
    posX: null,
    posY: null,
    petCompanion: null,
    telemetry: {
      activeCount: 0,
      unreadCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      tokPerSec: null,
      cacheHitPct: null,
      model: "",
      stepAtMs: 0,
      contextPct: 0,
      quota: null,
    },
    panelPos: null,
  };

  const normalizeCompactQuota = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const clampPct = (v) =>
      v !== null && v !== undefined && Number.isFinite(Number(v))
        ? Math.max(0, Math.min(100, Math.round(Number(v))))
        : null;
    if (Array.isArray(raw.groups)) {
      const pickBucket = (b) => (b && !b.disabled ? clampPct(b.remainingPct) : null);
      const gem = raw.groups.find((g) => g?.key === "gemini") || null;
      const claude = raw.groups.find((g) => g?.key === "gpt_claude") || null;
      const out = {
        gemini5h: pickBucket(gem?.fiveHour),
        geminiWeekly: pickBucket(gem?.weekly),
        claude5h: pickBucket(claude?.fiveHour),
        claudeWeekly: pickBucket(claude?.weekly),
      };
      return out.gemini5h === null && out.geminiWeekly === null && out.claude5h === null && out.claudeWeekly === null
        ? null
        : out;
    }
    const out = {
      gemini5h: clampPct(raw.gemini5h),
      geminiWeekly: clampPct(raw.geminiWeekly),
      claude5h: clampPct(raw.claude5h),
      claudeWeekly: clampPct(raw.claudeWeekly),
    };
    return out.gemini5h === null && out.geminiWeekly === null && out.claude5h === null && out.claudeWeekly === null
      ? null
      : out;
  };

  const formatPoolQuota = (fiveH, weekly) => {
    const has5h = typeof fiveH === "number" && Number.isFinite(fiveH);
    const hasW = typeof weekly === "number" && Number.isFinite(weekly);
    if (has5h && hasW) return `5h ${fiveH}%/周 ${weekly}%`;
    if (has5h) return `5h ${fiveH}%`;
    if (hasW) return `周 ${weekly}%`;
    return "";
  };

  const formatQuotaValue = (q, model) => {
    if (!q) return "--";
    const gText = formatPoolQuota(q.gemini5h, q.geminiWeekly);
    const cText = formatPoolQuota(q.claude5h, q.claudeWeekly);
    if (!gText && !cText) return "--";
    const m = String(model || "").toLowerCase();
    const isClaudeOrGpt = /\b(claude|gpt|sonnet|opus|haiku|openai|o1|o3|o4)\b|claude|gpt-|sonnet|opus|haiku/.test(m);
    const isGemini = /gemini|argon|flash|neon|hydrogen|carbon|ultra/.test(m);
    if (isClaudeOrGpt) return cText || gText || "--";
    if (isGemini) return gText || cText || "--";
    const gMain = typeof q.gemini5h === "number" ? q.gemini5h : q.geminiWeekly;
    const cMain = typeof q.claude5h === "number" ? q.claude5h : q.claudeWeekly;
    if (typeof gMain === "number" && typeof cMain === "number") {
      return `G ${gMain}% · C ${cMain}%`;
    }
    return gText || cText || "--";
  };

  const renderBubbleTemplate = (tpl = state.bubbleTemplate) => {
    const raw = typeof tpl === "string" && tpl.trim() ? tpl.trim() : DEFAULT_BUBBLE_TEMPLATE;
    const inStr = formatTokenCount(state.telemetry.inputTokens);
    const outStr = formatTokenCount(state.telemetry.outputTokens);
    const tpsStr =
      typeof state.telemetry.tokPerSec === "number" && Number.isFinite(state.telemetry.tokPerSec) && state.telemetry.tokPerSec > 0
        ? state.telemetry.tokPerSec.toFixed(1)
        : "--";
    const pctStr = String(Math.max(0, Math.round(state.telemetry.contextPct || 0)));
    const modelStr = state.telemetry.model || "待机";
    const cacheStr =
      typeof state.telemetry.cacheHitPct === "number" && Number.isFinite(state.telemetry.cacheHitPct)
        ? String(Math.round(state.telemetry.cacheHitPct))
        : "--";
    const unreadStr = String(Math.max(0, state.telemetry.unreadCount || 0));
    const quotaStr = formatQuotaValue(state.telemetry.quota, state.telemetry.model);
    return raw
      .replaceAll("{in}", inStr)
      .replaceAll("{out}", outStr)
      .replaceAll("{tps}", tpsStr)
      .replaceAll("{pct}", pctStr)
      .replaceAll("{model}", modelStr)
      .replaceAll("{cache}", cacheStr)
      .replaceAll("{unread}", unreadStr)
      .replaceAll("{quota}", quotaStr);
  };

  const editorState = {
    open: false,
    editingId: "",
    name: "",
    fps: 8,
    activeTrack: "idle",
    tracks: { idle: [], running: [], unread: [], interact: [], walk: [], drag: [] },
  };

  const resolveMood = () => {
    if (state.telemetry.activeCount > 0) return "running";
    if (state.telemetry.unreadCount > 0) return "unread";
    return "idle";
  };

  const isDesktopPetActive = () => {
    const comp = state.petCompanion || {};
    if (!state.enabled || state.displayMode === "panel") return false;
    return Boolean(comp.running && (comp.petVisible || comp.supportsPet));
  };

  const shouldShowPanelPet = () => {
    if (!state.enabled) return false;
    if (state.displayMode === "panel") return true;
    if (state.displayMode === "desktop") return false;
    return !isDesktopPetActive();
  };

  const buildSavePayload = () => ({
    enabled: Boolean(state.enabled),
    activePetId: state.activePetId || "neko",
    displayMode: state.displayMode || "auto",
    size: Number(state.size) || 100,
    opacity: Number(state.opacity) || 95,
    alwaysOnTop: Boolean(state.alwaysOnTop),
    showSpeechBubble: Boolean(state.showSpeechBubble),
    bubbleTemplate: typeof state.bubbleTemplate === "string" && state.bubbleTemplate.trim() ? state.bubbleTemplate.trim() : DEFAULT_BUBBLE_TEMPLATE,
    autoWander: Boolean(state.autoWander),
    selectable: Boolean(state.selectable),
  });

  const resolveActiveFrameUrls = (pet, { allowOverride = true } = {}) => {
    if (!pet || pet.kind !== "frames" || !Array.isArray(pet.frames) || pet.frames.length === 0) return [];
    let chosen = pet.frames;
    if (allowOverride && previewTrackOverride !== "auto") {
      if (previewTrackOverride === "idle") {
        chosen = pet.frames;
      } else if (
        Array.isArray(pet.stateFrames?.[previewTrackOverride]) &&
        pet.stateFrames[previewTrackOverride].length > 0
      ) {
        chosen = pet.stateFrames[previewTrackOverride];
      }
    } else if (Date.now() < interactUntilMs && Array.isArray(pet.stateFrames?.interact) && pet.stateFrames.interact.length > 0) {
      chosen = pet.stateFrames.interact;
    } else {
      const mood = resolveMood();
      if (mood === "running" && Array.isArray(pet.stateFrames?.running) && pet.stateFrames.running.length > 0) {
        chosen = pet.stateFrames.running;
      } else if (mood === "unread" && Array.isArray(pet.stateFrames?.unread) && pet.stateFrames.unread.length > 0) {
        chosen = pet.stateFrames.unread;
      }
    }
    return chosen.map((fr) => getExtPetAssetUrl(pet.id, fr.filename));
  };

  const syncStageFramePlayback = () => {
    const activeCustom = state.customPets.find((p) => p.id === state.activePetId);
    const isFrames = Boolean(activeCustom && activeCustom.kind === "frames" && activeCustom.frames?.length > 0);
    const previewVisible = !dom.panelPet.hidden;
    const panelVisible = shouldShowPanelPet();
    if (!isFrames || (!previewVisible && !panelVisible)) {
      if (stageFrameTimer !== null) {
        clearInterval(stageFrameTimer);
        stageFrameTimer = null;
      }
      stageFrameKey = "";
      stageFrameIndex = 0;
      return;
    }
    const previewUrls = previewVisible ? resolveActiveFrameUrls(activeCustom, { allowOverride: true }) : [];
    const panelUrls = panelVisible ? resolveActiveFrameUrls(activeCustom, { allowOverride: false }) : [];
    const fps = Math.max(1, Math.min(30, Number(activeCustom.fps) || 8));
    const key = `${activeCustom.id}|${fps}|p:${previewUrls.join(",")}|f:${panelUrls.join(",")}`;
    const applyIdx = (idx, curPreviewUrls, curPanelUrls) => {
      if (!dom.panelPet.hidden && curPreviewUrls.length > 0) {
        const pImg = dom.previewVisual.querySelector("img");
        if (pImg) pImg.src = curPreviewUrls[idx % curPreviewUrls.length];
      }
      if (shouldShowPanelPet() && curPanelUrls.length > 0) {
        const fImg = dom.panelVisual.querySelector("img");
        if (fImg) fImg.src = curPanelUrls[idx % curPanelUrls.length];
      }
    };
    if (key !== stageFrameKey) {
      stageFrameKey = key;
      stageFrameIndex = 0;
      applyIdx(0, previewUrls, panelUrls);
      if (stageFrameTimer !== null) {
        clearInterval(stageFrameTimer);
        stageFrameTimer = null;
      }
      if (previewUrls.length > 1 || panelUrls.length > 1) {
        stageFrameTimer = setInterval(() => {
          if (destroyed) return;
          const curPreviewVis = !dom.panelPet.hidden;
          const curPanelVis = shouldShowPanelPet();
          if (!curPreviewVis && !curPanelVis) {
            clearInterval(stageFrameTimer);
            stageFrameTimer = null;
            stageFrameKey = "";
            return;
          }
          const live = state.customPets.find((p) => p.id === state.activePetId);
          if (!live || live.kind !== "frames") return;
          const livePreviewUrls = curPreviewVis ? resolveActiveFrameUrls(live, { allowOverride: true }) : [];
          const livePanelUrls = curPanelVis ? resolveActiveFrameUrls(live, { allowOverride: false }) : [];
          if (livePreviewUrls.length === 0 && livePanelUrls.length === 0) return;
          stageFrameIndex += 1;
          applyIdx(stageFrameIndex, livePreviewUrls, livePanelUrls);
        }, Math.max(33, Math.round(1000 / fps)));
      }
    }
  };

  const showPanelBubble = (text, durationMs = 3400) => {
    if (!state.showSpeechBubble || !text) return;
    clearTimeout(bubbleTimer);
    dom.panelBubble.textContent = String(text);
    dom.panelBubble.hidden = false;
    bubbleTimer = setTimeout(() => {
      if (!destroyed) dom.panelBubble.hidden = true;
    }, durationMs);
  };

  const showPreviewBubble = (text, durationMs = 3200) => {
    if (!text) return;
    clearTimeout(previewBubbleTimer);
    dom.previewBubble.textContent = String(text);
    dom.previewBubble.hidden = false;
    previewBubbleTimer = setTimeout(() => {
      if (!destroyed) dom.previewBubble.hidden = true;
    }, durationMs);
  };

  const renderPreviewStage = () => {
    const mood = resolveMood();
    const scale = Math.max(0.6, Math.min(5.0, (Number(state.size) || 100) / 100));
    const opacityNum = Math.max(0.4, Math.min(1, (Number(state.opacity) || 95) / 100));
    dom.previewStage.style.setProperty("--pet-preview-scale", Math.min(1.22, Math.max(0.72, scale)).toFixed(2));
    dom.previewStage.style.setProperty("--pet-preview-opacity", opacityNum.toFixed(2));
    dom.previewStage.classList.toggle("is-pet-enabled", Boolean(state.enabled));
    dom.previewActor.classList.toggle("is-mood-running", mood === "running");
    dom.previewActor.classList.toggle("is-mood-unread", mood === "unread");
    dom.previewActor.classList.toggle("is-mood-idle", mood === "idle");

    const activeCustom = state.customPets.find((p) => p.id === state.activePetId);
    const isFramePet = Boolean(activeCustom && activeCustom.kind === "frames" && activeCustom.frames?.length > 0);
    dom.previewTrackBar.hidden = !isFramePet;
    if (isFramePet) {
      dom.previewTrackBtns.forEach((btn) => {
        const key = btn.getAttribute("data-preview-track");
        const count =
          key === "auto"
            ? 1
            : key === "idle"
              ? activeCustom.frames?.length || 0
              : activeCustom.stateFrames?.[key]?.length || 0;
        btn.disabled = key !== "auto" && count === 0;
        btn.classList.toggle("is-active", previewTrackOverride === key);
      });
    } else if (previewTrackOverride !== "auto") {
      previewTrackOverride = "auto";
    }
    const nextKey = activeCustom
      ? `custom:${activeCustom.id}:${activeCustom.kind || "image"}:${activeCustom.filename || ""}`
      : `builtin:${state.activePetId}:${mood}`;
    if (nextKey !== renderedPreviewVisualKey) {
      dom.previewVisual.textContent = "";
      if (activeCustom) {
        const img = el("img", {
          class: "panel-pet-custom-img",
          src:
            activeCustom.kind === "frames" && activeCustom.frames?.[0]?.filename
              ? getExtPetAssetUrl(activeCustom.id, activeCustom.frames[0].filename)
              : getExtPetAssetUrl(activeCustom.id),
          alt: activeCustom.name || activeCustom.id,
          draggable: "false",
        });
        dom.previewVisual.appendChild(img);
      } else {
        const kind = BUILTIN_PET_IDS.has(state.activePetId) ? state.activePetId : "neko";
        dom.previewVisual.appendChild(buildBuiltinPetSvg(kind, { compact: false, mood }));
      }
      renderedPreviewVisualKey = nextKey;
    }
    syncStageFramePlayback();
  };

  const renderPanelPet = () => {
    const show = shouldShowPanelPet();
    dom.panelStage.hidden = !show;
    dom.panelStage.classList.toggle("is-unselectable", !state.selectable);
    if (!show) {
      dom.panelBubble.hidden = true;
      syncStageFramePlayback();
      return;
    }
    const mood = resolveMood();
    const scale = Math.max(0.6, Math.min(5.0, (Number(state.size) || 100) / 100));
    const opacityNum = Math.max(0.4, Math.min(1, (Number(state.opacity) || 95) / 100));
    dom.panelStage.style.setProperty("--pet-scale", scale.toFixed(2));
    dom.panelStage.style.setProperty("--pet-opacity", opacityNum.toFixed(2));
    dom.panelBody.classList.toggle("is-mood-running", mood === "running");
    dom.panelBody.classList.toggle("is-mood-unread", mood === "unread");
    dom.panelBody.classList.toggle("is-mood-idle", mood === "idle");

    if (mood === "running") {
      dom.panelMoodBadge.textContent = "⚡";
      dom.panelMoodBadge.className = "panel-pet-mood-badge is-running";
      dom.panelMoodBadge.hidden = false;
    } else if (mood === "unread") {
      dom.panelMoodBadge.textContent = "★";
      dom.panelMoodBadge.className = "panel-pet-mood-badge is-unread";
      dom.panelMoodBadge.hidden = false;
    } else {
      dom.panelMoodBadge.hidden = true;
    }

    const activeCustom = state.customPets.find((p) => p.id === state.activePetId);
    const nextKey = activeCustom
      ? `custom:${activeCustom.id}:${activeCustom.kind || "image"}:${activeCustom.filename || ""}`
      : `builtin:${state.activePetId}:${mood}`;
    if (nextKey !== renderedPanelVisualKey) {
      dom.panelVisual.textContent = "";
      if (activeCustom) {
        const img = el("img", {
          class: "panel-pet-custom-img",
          src:
            activeCustom.kind === "frames" && activeCustom.frames?.[0]?.filename
              ? getExtPetAssetUrl(activeCustom.id, activeCustom.frames[0].filename)
              : getExtPetAssetUrl(activeCustom.id),
          alt: activeCustom.name || activeCustom.id,
          draggable: "false",
        });
        dom.panelVisual.appendChild(img);
      } else {
        const kind = BUILTIN_PET_IDS.has(state.activePetId) ? state.activePetId : "neko";
        dom.panelVisual.appendChild(buildBuiltinPetSvg(kind, { compact: false, mood }));
      }
      renderedPanelVisualKey = nextKey;
    }
    syncStageFramePlayback();

    if (state.panelPos) {
      dom.panelStage.style.left = `${state.panelPos.x}px`;
      dom.panelStage.style.top = `${state.panelPos.y}px`;
      dom.panelStage.style.right = "auto";
      dom.panelStage.style.bottom = "auto";
    }
    if (!state.showSpeechBubble) dom.panelBubble.hidden = true;
  };

  const triggerInteract = (announceToastIfDesktop = false, allowPreviewWhenOff = false) => {
    if (!state.enabled && !allowPreviewWhenOff) {
      if (announceToastIfDesktop) showToast?.(tr("pet.hintOff"), "info");
      return;
    }
    interactUntilMs = Date.now() + 1400;
    syncStageFramePlayback();
    clearTimeout(interactTimer);
    interactTimer = setTimeout(() => {
      if (!destroyed) syncStageFramePlayback();
    }, 1450);

    const msg = renderBubbleTemplate(state.bubbleTemplate);

    dom.previewActor.classList.remove("is-hopping");
    clearTimeout(previewHopTimer);
    dom.previewActor.classList.add("is-hopping");
    previewHopTimer = setTimeout(() => dom.previewActor.classList.remove("is-hopping"), 620);
    showPreviewBubble(msg, 3400);

    if (state.enabled && shouldShowPanelPet()) {
      dom.panelBody.classList.remove("is-hopping");
      clearTimeout(hopTimer);
      dom.panelBody.classList.add("is-hopping");
      hopTimer = setTimeout(() => dom.panelBody.classList.remove("is-hopping"), 620);
      showPanelBubble(msg, 3600);
    } else if (announceToastIfDesktop && state.enabled) {
      showToast?.(msg, "info");
    }
  };

  const renderGallery = () => {
    dom.galleryRow.textContent = "";
    BUILTIN_PETS.forEach((pet) => {
      const isSelected = state.activePetId === pet.id;
      const card = el(
        "button",
        {
          type: "button",
          class: isSelected ? "pet-choice-card is-active" : "pet-choice-card",
          role: "option",
          "aria-selected": String(isSelected),
          "data-pet-id": pet.id,
        },
        [
          el("div", { class: "pet-choice-preview" }, [buildBuiltinPetSvg(pet.id, { compact: true, mood: "idle" })]),
          el("span", { class: "pet-choice-name", text: tr(pet.nameKey) }),
        ]
      );
      card.addEventListener("click", () => {
        state.activePetId = pet.id;
        renderAll();
        schedulePersist(true);
      });
      dom.galleryRow.appendChild(card);
    });

    state.customPets.forEach((cp) => {
      const isSelected = state.activePetId === cp.id;
      const cardChildren = [
        el("div", { class: "pet-choice-preview" }, [
          el("img", {
            class: "pet-choice-img",
            src:
              cp.kind === "frames" && cp.frames?.[0]?.filename
                ? getExtPetAssetUrl(cp.id, cp.frames[0].filename)
                : getExtPetAssetUrl(cp.id),
            alt: cp.name || cp.id,
            draggable: "false",
          }),
        ]),
        el("span", { class: "pet-choice-name", text: cp.name || cp.id }),
      ];
      if (cp.kind === "frames") {
        const totalFrames =
          (cp.frames?.length || 0) +
          (cp.stateFrames?.running?.length || 0) +
          (cp.stateFrames?.unread?.length || 0) +
          (cp.stateFrames?.interact?.length || 0) +
          (cp.stateFrames?.walk?.length || 0) +
          (cp.stateFrames?.drag?.length || 0);
        cardChildren.push(
          el("span", {
            class: "pet-choice-frames-tag",
            text: tr("pet.framesBadge", { count: Math.max(1, totalFrames), fps: Number(cp.fps) || 8 }),
          })
        );
      }

      const card = el(
        "button",
        {
          type: "button",
          class: isSelected ? "pet-choice-card is-custom is-active" : "pet-choice-card is-custom",
          role: "option",
          "aria-selected": String(isSelected),
          "data-pet-id": cp.id,
        },
        cardChildren
      );
      card.addEventListener("click", () => {
        state.activePetId = cp.id;
        renderAll();
        schedulePersist(true);
      });

      const actions = [];
      if (cp.kind === "frames") {
        const editBtn = el(
          "button",
          { type: "button", class: "pet-choice-action-btn is-edit", title: tr("pet.framesEditBtn"), "aria-label": tr("pet.framesEditBtn") },
          [createEditSvg()]
        );
        editBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          openFramesModal(cp);
        });
        actions.push(editBtn);
      }
      const delBtn = el(
        "button",
        { type: "button", class: "pet-choice-action-btn is-del", title: tr("pet.customDeleteBtn"), "aria-label": tr("pet.customDeleteBtn") },
        [createDeleteSvg()]
      );
      delBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        void handleDeleteCustomPet(cp.id);
      });
      actions.push(delBtn);

      dom.galleryRow.appendChild(
        el("div", { class: "pet-choice-wrap" }, [card, el("div", { class: "pet-choice-float-actions" }, actions)])
      );
    });
  };

  const renderControls = () => {
    const enabled = Boolean(state.enabled);
    const desktopActive = isDesktopPetActive();
    const comp = state.petCompanion || {};

    dom.quickToggleBtn.classList.toggle("is-enabled", enabled);
    dom.quickToggleBtn.setAttribute("aria-pressed", String(enabled));
    dom.toggleBtn.classList.toggle("is-toggled", enabled);
    dom.toggleBtn.setAttribute("aria-pressed", String(enabled));
    dom.toggleLabel.textContent = enabled ? tr("pet.toggleOn") : tr("pet.toggleOff");

    let badgeCls = "boundary-badge is-disabled";
    let badgeText = tr("pet.statusOff");
    if (enabled) {
      if (desktopActive) {
        badgeCls = "boundary-badge is-synced";
        badgeText = tr("pet.statusDesktopActive");
      } else if (state.displayMode === "panel" || comp.supported === false) {
        badgeCls = "boundary-badge is-synced";
        badgeText = tr("pet.statusPanelActive");
      } else {
        badgeCls = "boundary-badge is-scoped";
        badgeText = tr("pet.statusPanelActive");
      }
    }
    dom.statusBadge.className = badgeCls;
    dom.statusBadge.textContent = badgeText;

    if (!enabled) dom.statusHint.textContent = tr("pet.hintOff");
    else if (desktopActive) dom.statusHint.textContent = tr("pet.hintDesktopActive");
    else if (state.displayMode === "panel") dom.statusHint.textContent = tr("pet.hintPanelFallback");
    else dom.statusHint.textContent = tr("pet.hintDesktopWait");

    dom.modeBtns.forEach((btn) => {
      const active = btn.getAttribute("data-pet-mode") === state.displayMode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    dom.selectBtns.forEach((btn) => {
      const wantSel = btn.getAttribute("data-pet-selectable") === "true";
      const active = Boolean(state.selectable) === wantSel;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });

    dom.topmostBtn.classList.toggle("is-toggled", Boolean(state.alwaysOnTop));
    dom.topmostBtn.setAttribute("aria-pressed", String(Boolean(state.alwaysOnTop)));
    dom.bubbleBtn.classList.toggle("is-toggled", Boolean(state.showSpeechBubble));
    dom.bubbleBtn.setAttribute("aria-pressed", String(Boolean(state.showSpeechBubble)));
    dom.wanderBtn.classList.toggle("is-toggled", Boolean(state.autoWander));
    dom.wanderBtn.setAttribute("aria-pressed", String(Boolean(state.autoWander)));
    dom.sizeInput.value = String(state.size);
    dom.sizeVal.textContent = `${state.size}%`;
    dom.opacityInput.value = String(state.opacity);
    dom.opacityVal.textContent = `${state.opacity}%`;
    if (typeof document !== "undefined" && document.activeElement !== dom.bubbleTplInput) {
      dom.bubbleTplInput.value = state.bubbleTemplate || DEFAULT_BUBBLE_TEMPLATE;
    }
    dom.bubblePresetBtns.forEach((btn) => {
      const tpl = btn.getAttribute("data-bubble-tpl") || "";
      btn.classList.toggle("is-active", tpl === (state.bubbleTemplate || DEFAULT_BUBBLE_TEMPLATE));
    });
  };

  const renderAll = () => {
    renderControls();
    renderGallery();
    renderPreviewStage();
    renderPanelPet();
  };

  const applyServerPetState = (petState) => {
    if (!petState || typeof petState !== "object") return;
    if (typeof petState.enabled === "boolean") state.enabled = petState.enabled;
    if (typeof petState.activePetId === "string" && petState.activePetId.trim()) {
      state.activePetId = petState.activePetId.trim();
    }
    if (Array.isArray(petState.customPets)) {
      state.customPets = petState.customPets.map((p) => ({ ...p }));
    }
    if (petState.displayMode === "auto" || petState.displayMode === "desktop" || petState.displayMode === "panel") {
      state.displayMode = petState.displayMode;
    }
    if (typeof petState.size === "number" && Number.isFinite(petState.size)) {
      state.size = Math.max(60, Math.min(500, Math.round(petState.size)));
    }
    if (typeof petState.opacity === "number" && Number.isFinite(petState.opacity)) {
      state.opacity = Math.max(40, Math.min(100, Math.round(petState.opacity)));
    }
    if (typeof petState.alwaysOnTop === "boolean") state.alwaysOnTop = petState.alwaysOnTop;
    if (typeof petState.showSpeechBubble === "boolean") state.showSpeechBubble = petState.showSpeechBubble;
    if (typeof petState.bubbleTemplate === "string" && petState.bubbleTemplate.trim()) {
      state.bubbleTemplate = petState.bubbleTemplate.trim();
    }
    if (typeof petState.autoWander === "boolean") state.autoWander = petState.autoWander;
    if (typeof petState.selectable === "boolean") state.selectable = petState.selectable;
  };

  const handlePreviewSignal = (signal) => {
    if (!signal || typeof signal !== "object") return;
    const ts = Number(signal.ts) || 0;
    if (ts <= 0 || ts <= lastHandledPreviewTs) return;
    lastHandledPreviewTs = ts;
    // Only auto-trigger UI jump for fresh signals emitted within the last 60s
    if (Date.now() - ts > 60000) return;
    if (signal.petId) {
      state.activePetId = signal.petId;
    }
    if (
      signal.track === "idle" ||
      signal.track === "running" ||
      signal.track === "unread" ||
      signal.track === "interact" ||
      signal.track === "walk" ||
      signal.track === "drag"
    ) {
      previewTrackOverride = signal.track;
    }
    renderedPreviewVisualKey = "";
    renderedPanelVisualKey = "";
    stageFrameKey = "";
    renderAll();
    if (signal.openTab !== false && typeof activateTab === "function") {
      activateTab("pet");
    }
    const matched = state.customPets.find((p) => p.id === state.activePetId);
    const bubbleText = signal.message || tr("pet.aiPreviewReadyToast", { name: matched?.name || state.activePetId });
    dom.previewActor.classList.remove("is-hopping");
    clearTimeout(previewHopTimer);
    dom.previewActor.classList.add("is-hopping");
    previewHopTimer = setTimeout(() => dom.previewActor.classList.remove("is-hopping"), 620);
    showPreviewBubble(bubbleText, 4800);
    showToast?.(tr("pet.aiPreviewReadyToast", { name: matched?.name || state.activePetId }), "success");
  };

  const refreshFromServer = async ({ fromPoll = false } = {}) => {
    try {
      lastServerPollMs = Date.now();
      const resp = await fetchExtPetApi(apiFetch, "/api/pet");
      if (destroyed) return;
      if (!resp?.petState) return;
      const incomingUpdatedAt = Number(resp.petState.updatedAt) || 0;
      const incomingSignalTs = Number(resp.petState.previewSignal?.ts) || 0;
      const changed = !fromPoll || incomingUpdatedAt !== lastKnownUpdatedAt || incomingSignalTs > lastHandledPreviewTs;
      if (incomingUpdatedAt > 0) lastKnownUpdatedAt = incomingUpdatedAt;
      if (changed) {
        applyServerPetState(resp.petState);
        if (resp?.petCompanion) state.petCompanion = resp.petCompanion;
        renderedPreviewVisualKey = "";
        renderedPanelVisualKey = "";
        stageFrameKey = "";
        renderAll();
      } else if (resp?.petCompanion) {
        state.petCompanion = resp.petCompanion;
        renderControls();
      }
      if (resp.petState.previewSignal) {
        handlePreviewSignal(resp.petState.previewSignal);
      }
    } catch {
      // Non-fatal extension refresh failure
    }
  };

  const persistNow = async ({ notifyToggle = false, nextEnabled = null, extraPatch = null, customToast = "" } = {}) => {
    if (destroyed) return;
    if (persistInFlight) {
      persistQueued = true;
      return;
    }
    persistInFlight = true;
    try {
      const payload = { ...buildSavePayload(), ...(extraPatch || {}) };
      const resp = await fetchExtPetApi(apiFetch, "/api/pet/save", {
        method: "POST",
        body: JSON.stringify({ petState: payload }),
      });
      if (destroyed) return;
      if (resp?.petState) applyServerPetState(resp.petState);
      if (resp?.petCompanion) state.petCompanion = resp.petCompanion;
      renderAll();

      if (state.enabled && state.displayMode !== "panel" && state.petCompanion?.supported && !isDesktopPetActive()) {
        clearTimeout(statusRecheckTimer);
        statusRecheckTimer = setTimeout(() => {
          if (!destroyed) void refreshFromServer();
        }, 650);
      }

      if (customToast) {
        showToast?.(customToast, "success");
      } else if (notifyToggle) {
        const isOn = typeof nextEnabled === "boolean" ? nextEnabled : Boolean(state.enabled);
        showToast?.(isOn ? tr("pet.enabledToast") : tr("pet.disabledToast"), "success");
        if (isOn && shouldShowPanelPet()) triggerInteract(false);
      }
    } catch (err) {
      showToast?.(err?.message || tr("pet.saveFailed"), "error");
    } finally {
      persistInFlight = false;
      if (persistQueued && !destroyed) {
        persistQueued = false;
        void persistNow();
      }
    }
  };

  const schedulePersist = (immediate = false, opts = {}) => {
    clearTimeout(saveTimer);
    if (immediate) {
      void persistNow(opts);
      return;
    }
    saveTimer = setTimeout(() => void persistNow(opts), 180);
  };

  const togglePetEnabled = () => {
    const nextEnabled = !state.enabled;
    state.enabled = nextEnabled;
    renderAll();
    schedulePersist(true, { notifyToggle: true, nextEnabled });
  };

  const handleUploadPetFile = async (file) => {
    if (!file) return;
    const rawMime = String(file.type || "").toLowerCase();
    const fileName = String(file.name || "");
    if (rawMime.includes("svg") || /\.svg$/i.test(fileName)) {
      showToast?.(tr("pet.uploadSvgBlocked"), "error");
      return;
    }
    const mime = resolvePetUploadMime(file);
    if (!mime) {
      showToast?.(tr("pet.uploadSvgBlocked"), "error");
      return;
    }
    if (typeof file.size === "number" && file.size > MAX_PET_UPLOAD_BYTES) {
      showToast?.(tr("pet.uploadTooLarge"), "error");
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const comma = dataUrl.indexOf(",");
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      const cleanName = fileName.replace(/\.[a-z0-9]+$/i, "").trim().slice(0, 48) || "自定义桌宠";
      const resp = await fetchExtPetApi(apiFetch, "/api/pet/upload", {
        method: "POST",
        body: JSON.stringify({ name: cleanName, mime, base64 }),
      });
      if (destroyed) return;
      if (resp?.petState) applyServerPetState(resp.petState);
      if (resp?.petCompanion) state.petCompanion = resp.petCompanion;
      renderAll();
      showToast?.(tr("pet.uploadedToast", { name: resp?.pet?.name || cleanName }), "success");
    } catch (err) {
      showToast?.(err?.message || tr("pet.uploadFailed"), "error");
    }
  };

  const handleDeleteCustomPet = async (petId) => {
    try {
      const resp = await fetchExtPetApi(apiFetch, "/api/pet/delete", {
        method: "POST",
        body: JSON.stringify({ petId }),
      });
      if (destroyed) return;
      if (resp?.petState) applyServerPetState(resp.petState);
      if (resp?.petCompanion) state.petCompanion = resp.petCompanion;
      renderAll();
      showToast?.(tr("pet.deletedToast"), "success");
    } catch (err) {
      showToast?.(err?.message || tr("pet.deleteFailed"), "error");
    }
  };

  // ========== Frame Animation Studio Modal ==========
  const stopEditorPreviewTimer = () => {
    if (editorPreviewTimer !== null) {
      clearInterval(editorPreviewTimer);
      editorPreviewTimer = null;
    }
  };

  const getActiveTrackList = () => editorState.tracks[editorState.activeTrack] || editorState.tracks.idle;

  const updateEditorPreviewFrame = () => {
    const list = getActiveTrackList();
    if (!list || list.length === 0) {
      dom.framesPreviewImg.hidden = true;
      dom.framesPreviewImg.removeAttribute("src");
      dom.framesPreviewEmpty.hidden = false;
      dom.framesPreviewMeta.textContent = "0 / 0";
      return;
    }
    if (editorPreviewIndex >= list.length) editorPreviewIndex = 0;
    dom.framesPreviewEmpty.hidden = true;
    dom.framesPreviewImg.hidden = false;
    dom.framesPreviewImg.src = list[editorPreviewIndex].previewUrl;
    dom.framesPreviewMeta.textContent = `${editorPreviewIndex + 1} / ${list.length}`;
  };

  const restartEditorPreviewTimer = () => {
    stopEditorPreviewTimer();
    updateEditorPreviewFrame();
    if (!editorState.open || !editorPlaying) return;
    const list = getActiveTrackList();
    if (!list || list.length <= 1) return;
    editorPreviewTimer = setInterval(() => {
      if (destroyed || !editorState.open || !editorPlaying) return;
      const cur = getActiveTrackList();
      if (!cur || cur.length <= 1) return;
      editorPreviewIndex = (editorPreviewIndex + 1) % cur.length;
      updateEditorPreviewFrame();
    }, Math.max(33, Math.round(1000 / Math.max(1, Math.min(30, editorState.fps)))));
  };

  const renderFramesEditor = () => {
    dom.framesModalTitle.textContent = editorState.editingId
      ? tr("pet.framesModalTitleEdit")
      : tr("pet.framesModalTitle");
    if (dom.framesNameInput.value !== editorState.name) dom.framesNameInput.value = editorState.name;
    const fps = Math.max(1, Math.min(30, Number(editorState.fps) || 8));
    editorState.fps = fps;
    dom.framesFpsInput.value = String(fps);
    dom.framesFpsVal.textContent = tr("pet.framesFpsVal", { fps, ms: Math.round(1000 / fps) });
    dom.framesPlayToggleBtn.textContent = editorPlaying ? tr("pet.framesPlayPauseBtn") : tr("pet.framesPlayResumeBtn");
    dom.framesSaveBtn.disabled = editorSaving;
    dom.framesSaveBtn.textContent = editorSaving ? tr("pet.framesSavingBtn") : tr("pet.framesSaveBtn");

    dom.framesTrackTabs.forEach((tab) => {
      const k = tab.getAttribute("data-pet-track");
      const active = k === editorState.activeTrack;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      const cnt = tab.querySelector("[data-pet-track-count]");
      if (cnt && k && editorState.tracks[k]) cnt.textContent = String(editorState.tracks[k].length);
    });
    dom.framesTrackHint.hidden = editorState.activeTrack === "idle";

    dom.framesGrid.textContent = "";
    const list = getActiveTrackList();
    if (!list || list.length === 0) {
      dom.framesGrid.appendChild(el("div", { class: "pet-frames-empty", text: tr("pet.framesTrackEmpty") }));
    } else {
      list.forEach((fr, idx) => {
        const leftBtn = el("button", { type: "button", class: "pet-frame-ctrl-btn", title: tr("pet.framesMoveLeft"), text: "←" });
        leftBtn.disabled = idx === 0;
        leftBtn.addEventListener("click", () => {
          if (idx <= 0) return;
          const tmp = list[idx - 1];
          list[idx - 1] = list[idx];
          list[idx] = tmp;
          renderFramesEditor();
        });
        const rightBtn = el("button", { type: "button", class: "pet-frame-ctrl-btn", title: tr("pet.framesMoveRight"), text: "→" });
        rightBtn.disabled = idx === list.length - 1;
        rightBtn.addEventListener("click", () => {
          if (idx >= list.length - 1) return;
          const tmp = list[idx + 1];
          list[idx + 1] = list[idx];
          list[idx] = tmp;
          renderFramesEditor();
        });
        const rmBtn = el("button", { type: "button", class: "pet-frame-ctrl-btn is-danger", title: tr("pet.framesRemoveFrame"), text: "×" });
        rmBtn.addEventListener("click", () => {
          list.splice(idx, 1);
          editorPreviewIndex = Math.min(editorPreviewIndex, Math.max(0, list.length - 1));
          renderFramesEditor();
        });
        dom.framesGrid.appendChild(
          el("div", { class: "pet-frame-item" }, [
            el("span", { class: "pet-frame-index", text: `#${idx + 1}` }),
            el("div", { class: "pet-frame-thumb-wrap" }, [
              el("img", { class: "pet-frame-thumb", src: fr.previewUrl, alt: `#${idx + 1}`, draggable: "false" }),
            ]),
            el("div", { class: "pet-frame-controls" }, [leftBtn, rightBtn, rmBtn]),
          ])
        );
      });
    }
    restartEditorPreviewTimer();
  };

  function openFramesModal(existingPet = null) {
    editorState.open = true;
    editorState.editingId = existingPet?.id ? String(existingPet.id) : "";
    editorState.name = existingPet?.name ? String(existingPet.name) : "";
    editorState.fps = Math.max(1, Math.min(30, Number(existingPet?.fps) || 8));
    editorState.activeTrack = "idle";
    editorPlaying = true;
    editorPreviewIndex = 0;

    const mapExisting = (petId, list) =>
      Array.isArray(list)
        ? list
            .filter((fr) => fr && fr.filename)
            .map((fr) => ({
              existingFilename: fr.filename,
              mime: fr.mime || "image/png",
              previewUrl: getExtPetAssetUrl(petId, fr.filename),
            }))
        : [];

    if (existingPet && existingPet.kind === "frames") {
      editorState.tracks = {
        idle: mapExisting(existingPet.id, existingPet.frames),
        running: mapExisting(existingPet.id, existingPet.stateFrames?.running),
        unread: mapExisting(existingPet.id, existingPet.stateFrames?.unread),
        interact: mapExisting(existingPet.id, existingPet.stateFrames?.interact),
        walk: mapExisting(existingPet.id, existingPet.stateFrames?.walk),
        drag: mapExisting(existingPet.id, existingPet.stateFrames?.drag),
      };
    } else {
      editorState.tracks = { idle: [], running: [], unread: [], interact: [], walk: [], drag: [] };
    }
    dom.framesModal.hidden = false;
    renderFramesEditor();
  }

  const closeFramesModal = () => {
    editorState.open = false;
    stopEditorPreviewTimer();
    editorState.tracks = { idle: [], running: [], unread: [], interact: [], walk: [], drag: [] };
    dom.framesGrid.textContent = "";
    dom.framesModal.hidden = true;
  };

  const appendFramesToActiveTrack = (newItems) => {
    const list = getActiveTrackList();
    const room = Math.max(0, 48 - list.length);
    if (newItems.length > room) showToast?.(tr("pet.framesLimitReached"), "info");
    newItems.slice(0, room).forEach((it) => list.push(it));
    renderFramesEditor();
  };

  const handleBatchAddFrames = async (fileList) => {
    const files = Array.from(fileList || []).sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" })
    );
    const added = [];
    for (const file of files) {
      const rawMime = String(file.type || "").toLowerCase();
      if (rawMime.includes("svg") || /\.svg$/i.test(String(file.name || ""))) {
        showToast?.(tr("pet.uploadSvgBlocked"), "error");
        continue;
      }
      const mime = resolvePetUploadMime(file);
      if (!mime) continue;
      if (typeof file.size === "number" && file.size > 4 * 1024 * 1024) {
        showToast?.(tr("pet.uploadTooLarge"), "error");
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const comma = dataUrl.indexOf(",");
        added.push({ mime, base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, previewUrl: dataUrl });
      } catch {
        // skip
      }
    }
    if (added.length > 0 && !destroyed) {
      if (!editorState.name && files[0]?.name) {
        editorState.name = String(files[0].name).replace(/[\s_-]*\d*\.[a-z0-9]+$/i, "").trim().slice(0, 48);
      }
      appendFramesToActiveTrack(added);
    }
  };

  const handleSpriteSheetImport = async (file) => {
    if (!file) return;
    if (String(file.type || "").toLowerCase().includes("svg") || /\.svg$/i.test(String(file.name || ""))) {
      showToast?.(tr("pet.uploadSvgBlocked"), "error");
      return;
    }
    const mime = resolvePetUploadMime(file);
    if (!mime) {
      showToast?.(tr("pet.uploadSvgBlocked"), "error");
      return;
    }
    if (typeof file.size === "number" && file.size > MAX_PET_UPLOAD_BYTES) {
      showToast?.(tr("pet.uploadTooLarge"), "error");
      return;
    }
    const cols = Math.max(2, Math.min(32, Math.round(Number(dom.framesSheetColsInput.value) || 4)));
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const sliced = await sliceHorizontalSpriteSheet(dataUrl, cols);
      if (destroyed) return;
      if (!editorState.name && file.name) {
        editorState.name = String(file.name).replace(/\.[a-z0-9]+$/i, "").trim().slice(0, 48);
      }
      appendFramesToActiveTrack(sliced);
      showToast?.(tr("pet.framesSheetDone", { count: sliced.length }), "success");
    } catch {
      showToast?.(tr("pet.framesSheetFailed"), "error");
    }
  };

  const saveFramesAnimationNow = async () => {
    if (editorSaving) return;
    if (!editorState.tracks.idle || editorState.tracks.idle.length === 0) {
      showToast?.(tr("pet.framesNeedIdle"), "error");
      return;
    }
    const serializeTrack = (list) =>
      (list || []).map((fr) => (fr.existingFilename ? { existingFilename: fr.existingFilename } : { mime: fr.mime, base64: fr.base64 }));

    editorSaving = true;
    renderFramesEditor();
    try {
      const payload = {
        ...(editorState.editingId ? { id: editorState.editingId } : {}),
        name: (editorState.name || "").trim() || "自定义帧动画",
        fps: editorState.fps,
        frames: serializeTrack(editorState.tracks.idle),
        stateFrames: {
          running: serializeTrack(editorState.tracks.running),
          unread: serializeTrack(editorState.tracks.unread),
          interact: serializeTrack(editorState.tracks.interact),
          walk: serializeTrack(editorState.tracks.walk),
          drag: serializeTrack(editorState.tracks.drag),
        },
      };
      const resp = await fetchExtPetApi(apiFetch, "/api/pet/frames/save", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (destroyed) return;
      if (resp?.petState) applyServerPetState(resp.petState);
      if (resp?.petCompanion) state.petCompanion = resp.petCompanion;
      closeFramesModal();
      renderAll();
      showToast?.(tr("pet.framesSavedToast", { name: resp?.pet?.name || payload.name }), "success");
    } catch (err) {
      showToast?.(err?.message || tr("pet.framesSaveFailed"), "error");
    } finally {
      editorSaving = false;
      if (editorState.open && !destroyed) renderFramesEditor();
    }
  };

  // Register tab with core nav system
  if (typeof registerSubnavTab === "function") {
    registerSubnavTab("pet", dom.petTabBtn, dom.panelPet, () => {
      void refreshFromServer();
    });
  }

  // Bind all controls
  const listen = (target, type, fn) => {
    if (!target) return;
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };

  listen(dom.quickToggleBtn, "click", togglePetEnabled);
  listen(dom.toggleBtn, "click", togglePetEnabled);
  listen(dom.uploadBtn, "click", () => dom.fileInput.click());
  listen(dom.fileInput, "change", () => {
    const f = dom.fileInput.files?.[0];
    dom.fileInput.value = "";
    if (f) void handleUploadPetFile(f);
  });
  dom.modeBtns.forEach((btn) =>
    listen(btn, "click", () => {
      const m = btn.getAttribute("data-pet-mode");
      if (m !== "auto" && m !== "desktop" && m !== "panel") return;
      state.displayMode = m;
      renderAll();
      schedulePersist(true);
    })
  );
  dom.selectBtns.forEach((btn) =>
    listen(btn, "click", () => {
      const nextSelectable = btn.getAttribute("data-pet-selectable") === "true";
      if (Boolean(state.selectable) === nextSelectable) return;
      state.selectable = nextSelectable;
      renderAll();
      schedulePersist(true, {
        customToast: nextSelectable ? tr("pet.selectOnToast") : tr("pet.selectOffToast"),
      });
    })
  );
  listen(dom.topmostBtn, "click", () => {
    state.alwaysOnTop = !state.alwaysOnTop;
    renderAll();
    schedulePersist(true);
  });
  listen(dom.bubbleBtn, "click", () => {
    state.showSpeechBubble = !state.showSpeechBubble;
    renderAll();
    schedulePersist(true);
  });
  listen(dom.wanderBtn, "click", () => {
    state.autoWander = !state.autoWander;
    renderAll();
    schedulePersist(true);
  });
  listen(dom.patTestBtn, "click", () => triggerInteract(true, true));
  listen(dom.previewActor, "click", () => triggerInteract(false, true));
  dom.previewTrackBtns.forEach((btn) =>
    listen(btn, "click", () => {
      const track = btn.getAttribute("data-preview-track") || "auto";
      previewTrackOverride = track;
      stageFrameKey = "";
      renderPreviewStage();
    })
  );
  listen(dom.previewActor, "keydown", (evt) => {
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      triggerInteract(false, true);
    }
  });
  listen(dom.resetPosBtn, "click", () => {
    state.posX = null;
    state.posY = null;
    state.panelPos = null;
    dom.panelStage.style.left = "";
    dom.panelStage.style.top = "";
    dom.panelStage.style.right = "";
    dom.panelStage.style.bottom = "";
    renderPanelPet();
    schedulePersist(true, { extraPatch: { posX: null, posY: null }, customToast: tr("pet.resetPosToast") });
  });
  listen(dom.sizeInput, "input", () => {
    state.size = Math.max(60, Math.min(500, Number(dom.sizeInput.value) || 100));
    renderControls();
    renderPreviewStage();
    renderPanelPet();
    schedulePersist(false);
  });
  listen(dom.opacityInput, "input", () => {
    state.opacity = Math.max(40, Math.min(100, Number(dom.opacityInput.value) || 95));
    renderControls();
    renderPreviewStage();
    renderPanelPet();
    schedulePersist(false);
  });
  dom.bubblePresetBtns.forEach((btn) =>
    listen(btn, "click", () => {
      const tpl = btn.getAttribute("data-bubble-tpl") || DEFAULT_BUBBLE_TEMPLATE;
      state.bubbleTemplate = tpl;
      dom.bubbleTplInput.value = tpl;
      renderControls();
      triggerInteract(false, true);
      schedulePersist(true);
    })
  );
  listen(dom.bubbleTplInput, "input", () => {
    state.bubbleTemplate = String(dom.bubbleTplInput.value || "").slice(0, 160) || DEFAULT_BUBBLE_TEMPLATE;
    renderControls();
    schedulePersist(false);
  });
  listen(dom.bubbleTestBtn, "click", () => {
    state.bubbleTemplate = String(dom.bubbleTplInput.value || "").trim().slice(0, 160) || DEFAULT_BUBBLE_TEMPLATE;
    renderControls();
    triggerInteract(false, true);
    schedulePersist(true);
  });
  dom.bubbleVarBtns.forEach((btn) =>
    listen(btn, "click", () => {
      const token = btn.getAttribute("data-bubble-var") || "";
      if (!token) return;
      const cur = String(dom.bubbleTplInput.value || "");
      const sep = cur && !cur.endsWith(" ") ? " " : "";
      const next = (cur + sep + token).slice(0, 160);
      dom.bubbleTplInput.value = next;
      state.bubbleTemplate = next;
      renderControls();
      schedulePersist(false);
    })
  );
  listen(dom.panelCloseBtn, "click", (evt) => {
    evt.stopPropagation();
    if (state.enabled) togglePetEnabled();
  });

  // Panel fallback drag & click
  {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    listen(dom.panelBody, "mousedown", (evt) => {
      if (evt.target && dom.panelCloseBtn.contains(evt.target)) return;
      if (typeof evt.button === "number" && evt.button !== 0) return;
      dragging = true;
      moved = false;
      startX = evt.clientX || 0;
      startY = evt.clientY || 0;
      const rect = dom.panelStage.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      dom.panelBody.classList.add("is-dragging");
    });
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      listen(window, "mousemove", (evt) => {
        if (!dragging) return;
        const dx = (evt.clientX || 0) - startX;
        const dy = (evt.clientY || 0) - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        if (!moved) return;
        const maxX = Math.max(8, (window.innerWidth || 420) - 110);
        const maxY = Math.max(40, (window.innerHeight || 600) - 120);
        state.panelPos = {
          x: Math.max(8, Math.min(maxX, Math.round(origLeft + dx))),
          y: Math.max(40, Math.min(maxY, Math.round(origTop + dy))),
        };
        dom.panelStage.style.left = `${state.panelPos.x}px`;
        dom.panelStage.style.top = `${state.panelPos.y}px`;
        dom.panelStage.style.right = "auto";
        dom.panelStage.style.bottom = "auto";
      });
      listen(window, "mouseup", () => {
        if (!dragging) return;
        dragging = false;
        dom.panelBody.classList.remove("is-dragging");
        if (!moved) triggerInteract(false);
      });
      listen(window, "blur", () => {
        if (!dragging) return;
        dragging = false;
        dom.panelBody.classList.remove("is-dragging");
      });
    }
    listen(dom.panelBody, "keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        triggerInteract(false);
      }
    });
  }

  // Modal bindings
  listen(dom.framesCreateBtn, "click", () => openFramesModal(null));
  listen(dom.framesCloseBtn, "click", closeFramesModal);
  listen(dom.framesCancelBtn, "click", closeFramesModal);
  listen(dom.framesBackdrop, "click", closeFramesModal);
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    listen(document, "keydown", (evt) => {
      if (editorState.open && evt.key === "Escape") {
        evt.preventDefault();
        closeFramesModal();
      }
    });
  }
  listen(dom.framesSaveBtn, "click", () => void saveFramesAnimationNow());
  listen(dom.framesNameInput, "input", () => {
    editorState.name = String(dom.framesNameInput.value || "").slice(0, 48);
  });
  listen(dom.framesFpsInput, "input", () => {
    editorState.fps = Math.max(1, Math.min(30, Number(dom.framesFpsInput.value) || 8));
    renderFramesEditor();
  });
  listen(dom.framesPlayToggleBtn, "click", () => {
    editorPlaying = !editorPlaying;
    renderFramesEditor();
  });
  listen(dom.framesAddBtn, "click", () => dom.framesFilesInput.click());
  listen(dom.framesFilesInput, "change", () => {
    const files = dom.framesFilesInput.files;
    dom.framesFilesInput.value = "";
    if (files && files.length > 0) void handleBatchAddFrames(files);
  });
  listen(dom.framesSheetBtn, "click", () => dom.framesSheetFileInput.click());
  listen(dom.framesSheetFileInput, "change", () => {
    const f = dom.framesSheetFileInput.files?.[0];
    dom.framesSheetFileInput.value = "";
    if (f) void handleSpriteSheetImport(f);
  });
  listen(dom.framesClearTrackBtn, "click", () => {
    editorState.tracks[editorState.activeTrack] = [];
    editorPreviewIndex = 0;
    renderFramesEditor();
  });
  dom.framesTrackTabs.forEach((tab) =>
    listen(tab, "click", () => {
      const k = tab.getAttribute("data-pet-track");
      if (!k || !editorState.tracks[k]) return;
      editorState.activeTrack = k;
      editorPreviewIndex = 0;
      renderFramesEditor();
    })
  );

  renderAll();
  void refreshFromServer();

  return {
    id: "desktop_pet",
    onSnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== "object") return;
      const nextQuota = normalizeCompactQuota(snapshot.quota) || state.telemetry.quota;
      state.telemetry = {
        activeCount: Array.isArray(snapshot.sessionsHub?.active) ? snapshot.sessionsHub.active.length : 0,
        unreadCount: Array.isArray(snapshot.sessionsHub?.unread) ? snapshot.sessionsHub.unread.length : 0,
        inputTokens: Math.max(0, Math.round(Number(snapshot.runtimeTelemetry?.latestInputTokens) || 0)),
        outputTokens: Math.max(0, Math.round(Number(snapshot.runtimeTelemetry?.latestOutputTokens) || 0)),
        tokPerSec:
          typeof snapshot.runtimeTelemetry?.latestTokPerSec === "number" && Number.isFinite(snapshot.runtimeTelemetry.latestTokPerSec)
            ? snapshot.runtimeTelemetry.latestTokPerSec
            : null,
        cacheHitPct:
          typeof snapshot.runtimeTelemetry?.cacheHitPct === "number" && Number.isFinite(snapshot.runtimeTelemetry.cacheHitPct)
            ? snapshot.runtimeTelemetry.cacheHitPct
            : null,
        model: typeof snapshot.runtimeTelemetry?.upstreamModelId === "string" ? snapshot.runtimeTelemetry.upstreamModelId.trim() : "",
        stepAtMs: Math.max(0, Math.round(Number(snapshot.runtimeTelemetry?.latestStepAtMs) || 0)),
        contextPct:
          typeof snapshot.contextPie?.percent === "number" && Number.isFinite(snapshot.contextPie.percent)
            ? snapshot.contextPie.percent
            : 0,
        quota: nextQuota,
      };
      const nextMood = resolveMood();
      if (!dom.panelPet.hidden) renderPreviewStage();
      renderPanelPet();
      const pollIntervalMs = state.enabled || !dom.panelPet.hidden ? 2200 : 15000;
      if (!persistInFlight && !editorState.open && Date.now() - lastServerPollMs >= pollIntervalMs) {
        void refreshFromServer({ fromPoll: true });
      }
      const hasTok = state.telemetry.inputTokens > 0 || state.telemetry.outputTokens > 0;
      const turnSig = hasTok ? `${state.telemetry.stepAtMs}|${state.telemetry.inputTokens}|${state.telemetry.outputTokens}` : "";
      const newTurn = Boolean(turnSig && turnSig !== lastShownTurnSig);
      if (newTurn) {
        lastShownTurnSig = turnSig;
        if (hasInitialTurnBaseline) {
          const turnMsg = renderBubbleTemplate(state.bubbleTemplate);
          if (!dom.panelPet.hidden) showPreviewBubble(turnMsg, 5500);
          if (state.enabled && shouldShowPanelPet()) showPanelBubble(turnMsg, 6000);
        }
        hasInitialTurnBaseline = true;
      } else if (!hasInitialTurnBaseline) {
        hasInitialTurnBaseline = true;
      }

      if (state.enabled && shouldShowPanelPet() && nextMood !== lastAutoMood) {
        lastAutoMood = nextMood;
        if (!newTurn && (nextMood === "running" || nextMood === "unread")) {
          showPanelBubble(renderBubbleTemplate(state.bubbleTemplate), 4800);
        }
      }
    },
    onQuota(quotaData) {
      const compact = normalizeCompactQuota(quotaData);
      if (compact) {
        state.telemetry.quota = compact;
      }
    },
    onPreferences() {
      if (Date.now() - lastServerPollMs > 1200) {
        void refreshFromServer();
      }
    },
    onTabChange(tabKey) {
      if (tabKey === "pet") {
        renderPreviewStage();
        if (!persistInFlight && Date.now() - lastServerPollMs > 1200) {
          void refreshFromServer({ fromPoll: true });
        }
        if (!state.telemetry.quota) {
          void fetchExtPetApi(apiFetch, "/api/quota")
            .then((qData) => {
              if (destroyed) return;
              const compact = normalizeCompactQuota(qData);
              if (compact) state.telemetry.quota = compact;
            })
            .catch(() => {});
        }
      } else {
        syncStageFramePlayback();
      }
    },
    onLanguageChange(lang) {
      tr.setLang(lang);
      renderAll();
    },
    destroy() {
      destroyed = true;
      clearTimeout(saveTimer);
      clearTimeout(statusRecheckTimer);
      clearTimeout(bubbleTimer);
      clearTimeout(hopTimer);
      clearTimeout(previewBubbleTimer);
      clearTimeout(previewHopTimer);
      clearTimeout(interactTimer);
      if (stageFrameTimer !== null) {
        clearInterval(stageFrameTimer);
        stageFrameTimer = null;
      }
      stopEditorPreviewTimer();
      editorState.tracks = { idle: [], running: [], unread: [], interact: [], walk: [], drag: [] };
      dom.framesGrid.textContent = "";
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
      dom.injectedNodes.forEach((node) => {
        try { node.remove(); } catch {}
      });
    },
  };
}
