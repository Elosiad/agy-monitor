/**
 * Release Notes / Changelog Modal (`#changelogModal`) triggered from the top
 * navigation bar button (`#changelogBtn`).
 *
 * - Renders the full version history from newest to oldest using pure DOM nodes
 *   (zero innerHTML interpolation).
 * - Merges newer official GitHub releases from `/api/update/releases` when online.
 * - Provides per-version interactive action buttons:
 *   - Newer version  -> "更新" (downloads & installs that exact release tag)
 *   - Current version -> "当前版本" (disabled indicator)
 *   - Older version  -> "回退" (downloads & rolls back to that exact release tag)
 */

const BUILTIN_CHANGELOG_ENTRIES = Object.freeze([
  {
    version: "1.1.2",
    date: "2026-11-24",
    title: "可插拔 AI 桌宠工作室（PR #3）、桌宠气泡实时额度变量 {quota} & 安全/DPI/生命周期全面加固",
    items: [
      "合入来自 @GreenNa717 的可插拔桌面宠物扩展（PR #3）：独立「桌宠」分页、顶栏快捷开关、6 轨道自定义帧动画工作室、MCP 工具链与 AI 生图制帧技能（默认关闭、零后台常驻进程，支持 AGY_DISABLE_EXTENSIONS=1 完全隔离）。",
      "桌宠弹出气泡新增实时额度变量 {quota} 与「模型 + 额度」快捷预设：自动按当前模型匹配对应池（Gemini / GPT&Claude）展示 5h/周剩余额度，面板预览与 Windows 桌面悬浮宠全链路实时同步。",
      "全面安全与资源加固：为 PNG 解码补齐尺寸与解压上限防炸弹、收紧精灵表与离线预览 HTML 输出路径并校验符号链接、为预览页增加严格 CSP 与 nosniff、拦截原始 customPets 覆写；打包/更新/卸载脚本全面同步 mcp_config.json、skills/ 与桌宠伴侣进程清理。",
      "加固 Windows 桌宠伴侣与前端兼容性：新增父进程 + Antigravity 宿主防孤儿退出守卫、休眠/锁屏/分辨率切换恢复、Per-Monitor 高分屏 DPI 坐标换算与配置合并写入；修复窄屏挤出公告按钮、浮窗遮挡弹窗、重复动画定义与隐藏时定时器空跑问题。",
    ],
  },
  {
    version: "1.1.1",
    date: "2026-11-24",
    title: "更新公告弹窗（支持单版本更新/回退）、OAuth 自动续签防 401、移除 Argon 双列适配 & 回退切模型秒级响应",
    items: [
      "顶部导航栏新增「更新公告」快捷按钮与全版本历史弹窗，每个版本均提供「更新 / 回退 / 当前版本」一键切换按钮。",
      "修复 Electron 运行环境下读取 app.asar 失败导致的 OAuth 客户端 401 误报，支持多客户端与 JWT aud 自动匹配，并将刷新额度、后台保鲜、切号前注入与当前号同步全面升级为自动续签凭证。",
      "适配官方配额策略调整：移除已并入 Gemini 池的独立 Argon 额度统计，重调通用页与账号页双列卡片尺寸与间距。",
      "修复对话回退重跑复用旧 step_index 时尾部旧分支残留导致模型与速率长时间不刷新的缓存问题，并自动自愈历史记录。",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-11-24",
    title: "多账号安全管理与自动切号（账号分页）、掌握页发消息输入框 & 真实上游模型校正",
    items: [
      "新增「账号」分页：Windows DPAPI 硬件级加密保险库，支持当前号一键捕获、浏览器官方 OAuth 一键直连授权（PKCE + 自动走系统 HTTP/SOCKS5 代理）、Token/JSON 批量导入导出。",
      "接入官方 CloudCode 实时配额刷新，支持全部账号 5 小时与周额度同步、顶部总余量汇总卡片、多维排序与响应式多列卡片网格。",
      "支持一键安全切号（自动备份与回滚）及 5h/周耗尽或额度为空报错自动切号，重启后仅自动续跑真正运行中的会话。",
      "「掌握」页集成消息发送输入框（支持附件图片、/swarm 与自定义技能），上游真实模型精准核验，壁纸伴侣同步兼容 Antigravity_Original 进程。",
    ],
  },
  {
    version: "1.0.13",
    date: "2026-11-22",
    title: "请求记录真实首字 (TTFT) 与全量精确耗时打通 & 伴侣冷启动探测优化",
    items: [
      "只读解析本地会话数据库纳秒级时间戳，为每条请求（含末轮纯文本回复）补全精确首字延迟 (TTFT)、总耗时与 tok 速度。",
      "底栏与悬浮 HUD 优先采用精确耗时计算生成速率，悬停可查看「首字 + 生成」拆分详情。",
      "桌面壁纸伴侣拉起探测升级为 200ms 短轮询（最长 1.8s / WSL 2.2s），消除高负载冷启动误判。",
    ],
  },
  {
    version: "1.0.12",
    date: "2026-11-22",
    title: "桌面伴侣防崩与防闪黑加固、HUD 多会话实时同步与分屏防误隐",
    items: [
      "修复 WinEvent 子元素误触发与 Z 序高频重排引发的壁纸反复闪黑、主窗残留半透明透底及弹窗重入崩溃。",
      "接入 Windows 休眠与锁屏事件自动还原主窗不透明度，唤醒后自动重贴壁纸，并加入 15 秒轻量看门狗自愈。",
      "前景控制台切换会话实时同步底部 HUD 并拦截隐藏 iframe 抢占；收严全屏遮挡判定，修复分屏误隐圆环。",
    ],
  },
  {
    version: "1.0.11",
    date: "2026-11-22",
    title: "官方原生 5 小时与周配额圆环看板 & 顶栏等高锁定",
    items: [
      "免配置、免 CDP 静默直连本地语言服务，在模型 Token 用量下方实时展示 5 小时与周剩余配额圆环及精确重置倒计时。",
      "锁定顶部双列等高，展开任意多个模型用量明细仅在卡片内滚动，彻底消除页面跳动与底栏挤压。",
    ],
  },
  {
    version: "1.0.10",
    date: "2026-11-21",
    title: "方案二侧边栏防叠色、WSL2 NAT 隧道加固与分页防越界",
    items: [
      "CDP 方案二升级由外向内图层遍历，避免侧边栏多层半透明叠加发灰遮挡壁纸。",
      "加固 WSL2 NAT 回环隧道响应完整性、自更新重编伴侣与请求记录翻页防越界回退。",
    ],
  },
  {
    version: "1.0.9",
    date: "2026-11-21",
    title: "Win + WSL2（含 NAT）全屏美化适配、单次请求记录明细弹窗与掌握页升级",
    items: [
      "完整适配 Win + WSL2 环境，新增免管理员权限、免防火墙弹窗的 NAT 回环隧道支持贴背伴侣与 CDP 透明覆盖。",
      "新增「请求记录」明细弹窗，支持 10 项单次请求指标展示与范围/时间/模型/状态筛选分页。",
      "「掌握」页支持常用会话置顶与行内星标双向同步、连续本地图片并排画廊及严格语义化版本检测。",
    ],
  },
  {
    version: "1.0.8",
    date: "2026-11-21",
    title: "全屏多高度排版、窄输入框分级压缩、全屏遮挡联动与性能优化",
    items: [
      "宽屏居中收束与多高度自适应布局，覆盖通用、掌握与美化全页面；全屏控制台自动隐藏底部 HUD 圆环。",
      "输入框过窄时按优先级整段收起模型名 / 缓存 / 速率，不再半截截断或遮挡模型下拉框。",
      "优化伴侣图片流式解码与空闲内存回收、后端 SQLite 语句缓存与冷热会话分级扫描。",
    ],
  },
  {
    version: "1.0.7",
    date: "2026-11-21",
    title: "底部状态栏自由勾选弹窗、悬停打开指引与双屏防覆盖熔断",
    items: [
      "点击底部上下文圆环弹出配置菜单，支持自由勾选生成速率 / 缓存命中 / 上游模型 / 上下文占用。",
      "新增悬停图解指引「如何打开 AGY 控制台」，引入双屏 Z-Order 严格后置熔断与中文配额弹窗避让。",
    ],
  },
  {
    version: "1.0.6",
    date: "2026-11-21",
    title: "GPU 硬件加速贴背、VSync 跟窗与 10 项上下文圆环精度修复",
    items: [
      "贴背伴侣升级硬件加速渲染与 VSync 原子同步跟窗，补全异常退出自动还原主窗不透明度。",
      "修复 CHECKPOINT 摘要占比虚高、纯文本对话借用他会话速率及新建空白对话重置 0% 等 10 项精度问题。",
    ],
  },
  {
    version: "1.0.5",
    date: "2026-11-21",
    title: "子 Agent 实时状态、安全路径校验与多 DPI 稳定性加固",
    items: [
      "接入权威子 Agent 运行状态，修复长任务超 90 秒误判结束与思考标签内容泄露，补全精确行数增减统计。",
      "强化本地路径安全校验（拒绝 UNC 与可执行文件直开），按会话隔离 Hook 状态并修复多 DPI 灯箱偏移。",
    ],
  },
  {
    version: "1.0.4",
    date: "2026-11-20",
    title: "定时总结默认关闭与状态竞态修复",
    items: [
      "「掌握」页定时总结改为默认关闭、按需开启，统一 PLUGIN_DATA 读取路径并修复中途开启无响应与轮询竞态。",
    ],
  },
  {
    version: "1.0.3",
    date: "2026-11-20",
    title: "原生 100% 不透明 WPF 全窗图片灯箱",
    items: [
      "点击「掌握」页内联图片即可在 Windows 下拉起不透明原生全窗灯箱，支持滚轮缩放、拖拽平移与定位文件目录。",
    ],
  },
  {
    version: "1.0.2",
    date: "2026-11-20",
    title: "「掌握」页内联图片缩略图预览",
    items: [
      "自动提取并内联渲染对话历程中的本地图片预览网格与可缩放预览浮层。",
    ],
  },
  {
    version: "1.0.1",
    date: "2026-11-20",
    title: "顶栏一键自更新、GitHub 入口、跳转会话与防孤儿悬浮窗",
    items: [
      "顶栏新增自动检测更新/一键升级按钮与 GitHub 仓库入口；「掌握」页支持一键跳转原会话，修复重入孤儿 HUD 窗。",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-11-20",
    title: "首个开源正式版",
    items: [
      "首发交付「通用（上下文饼图 / Token 消耗 / 速率与模型对照 / 会话管理）」「掌握（多 Agent 协作网 / 类 Codex 历程）」「美化（撞色主题 / 壁纸 / 贴背伴侣与底部 HUD）」三大模块及全平台一键安装卸载脚本。",
    ],
  },
]);

function normalizeVersionText(v) {
  return String(v || "")
    .trim()
    .replace(/^v/i, "");
}

function compareSemverLocal(a, b) {
  const parse = (v) =>
    normalizeVersionText(v)
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function parseReleaseBodyToItems(bodyText, fallbackTitle) {
  const lines = String(bodyText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const items = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) || /^---+$/.test(line) || /^!\[/.test(line) || /^\|/.test(line)) {
      continue;
    }
    const cleaned = line
      .replace(/^[-*•]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();
    if (cleaned.length >= 4) {
      items.push(cleaned);
    }
    if (items.length >= 6) break;
  }
  if (items.length === 0 && fallbackTitle) {
    items.push(fallbackTitle);
  }
  return items;
}

async function requestChangelogJson(apiFetch, url, options = {}) {
  const fetcher =
    typeof apiFetch === "function"
      ? apiFetch
      : typeof window !== "undefined" && typeof window.sidecar?.fetch === "function"
        ? window.sidecar.fetch
        : null;
  if (!fetcher) {
    throw new Error("请求通道暂不可用");
  }
  const res = await fetcher(url, options);
  if (res && typeof res.json === "function") {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
  }
  return res ?? {};
}

export function createChangelogModal({
  apiFetch,
  t,
  initialVersion = "1.1.2",
  onVersionApplied,
  onToast,
} = {}) {
  const modal = document.getElementById("changelogModal");
  const listEl = document.getElementById("changelogList");
  const currentVerBadge = document.getElementById("changelogCurrentVer");
  const footerMetaEl = document.getElementById("changelogFooterMeta");
  const triggerBtn = document.getElementById("changelogBtn");

  let translator = typeof t === "function" ? t : (k) => k;
  let currentVersion = normalizeVersionText(initialVersion) || BUILTIN_CHANGELOG_ENTRIES[0].version;
  let mergedEntries = BUILTIN_CHANGELOG_ENTRIES.slice();
  let isOpen = false;
  let applyingVersion = "";
  let applyingAction = "";
  let remoteFetched = false;
  let destroyed = false;
  const cleanups = [];

  const tr = (key, fallback, vars) => {
    let raw = typeof translator === "function" ? translator(key, vars) : "";
    if (!raw || raw === key) raw = fallback;
    if (!vars) return raw;
    return String(raw).replace(/\{\{?(\w+)\}?\}/g, (_, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : ""
    );
  };

  function mergeRemoteReleases(remoteList) {
    if (!Array.isArray(remoteList) || remoteList.length === 0) return;
    const byVer = new Map();
    for (const entry of BUILTIN_CHANGELOG_ENTRIES) {
      byVer.set(normalizeVersionText(entry.version), entry);
    }
    let changed = false;
    for (const rel of remoteList) {
      const ver = normalizeVersionText(rel?.version || rel?.tag);
      if (!ver || byVer.has(ver)) continue;
      const title = String(rel?.title || `v${ver}`)
        .replace(/^v?\d+\.\d+\.\d+\s*[-—–:]?\s*/i, "")
        .trim() || `版本 v${ver}`;
      byVer.set(ver, {
        version: ver,
        date: String(rel?.date || "").slice(0, 10) || "",
        title,
        items: parseReleaseBodyToItems(rel?.body, title),
      });
      changed = true;
    }
    if (changed) {
      mergedEntries = Array.from(byVer.values()).sort((a, b) => compareSemverLocal(b.version, a.version));
    }
  }

  async function syncRemoteReleases({ force = false } = {}) {
    if (destroyed) return;
    if (remoteFetched && !force) return;
    try {
      const data = await requestChangelogJson(
        apiFetch,
        `/api/update/releases${force ? "?force=1" : ""}`,
        { method: "GET" }
      );
      if (destroyed) return;
      remoteFetched = true;
      if (data?.currentVersion) {
        const cleanCur = normalizeVersionText(data.currentVersion);
        if (cleanCur) currentVersion = cleanCur;
      }
      if (Array.isArray(data?.releases)) {
        mergeRemoteReleases(data.releases);
      }
      render();
    } catch {
      // Offline or rate-limited: builtin changelog remains fully usable
    }
  }

  async function handleVersionAction(targetVer, isRollback) {
    if (destroyed || applyingVersion) return;
    const cleanTarget = normalizeVersionText(targetVer);
    if (!cleanTarget) return;

    applyingVersion = cleanTarget;
    applyingAction = isRollback ? "rollback" : "update";
    render();

    const verb = isRollback ? "回退" : "更新";
    onToast?.(`正在从 GitHub 下载并${verb}至 v${cleanTarget}…`, "info");

    try {
      const res = await requestChangelogJson(apiFetch, "/api/update/apply", {
        method: "POST",
        body: JSON.stringify({ targetVersion: cleanTarget }),
      });
      if (destroyed) return;
      if (res && res.ok) {
        const installedVer = normalizeVersionText(res.version || cleanTarget) || cleanTarget;
        currentVersion = installedVer;
        applyingVersion = "";
        applyingAction = "";
        render();
        onVersionApplied?.(res);
        onToast?.(
          `已${verb}至 v${installedVer}！已保留全部配置，请重载插件或重启 Antigravity 生效`,
          "success"
        );
      } else {
        applyingVersion = "";
        applyingAction = "";
        render();
        onToast?.(res?.error || `${verb}至 v${cleanTarget} 失败，请稍后重试`, "error");
      }
    } catch (err) {
      if (destroyed) return;
      applyingVersion = "";
      applyingAction = "";
      render();
      onToast?.(err?.message || `${verb}至 v${cleanTarget} 失败，请检查网络连接`, "error");
    }
  }

  function render() {
    if (currentVerBadge) {
      currentVerBadge.textContent = `v${currentVersion}`;
    }
    if (footerMetaEl) {
      footerMetaEl.textContent = tr("changelog.versionCount", "共 {count} 个版本", {
        count: mergedEntries.length,
      });
    }
    if (!listEl) return;
    listEl.innerHTML = "";

    mergedEntries.forEach((entry, idx) => {
      const isLatest = idx === 0;
      const cmp = compareSemverLocal(entry.version, currentVersion);
      const isCurrent = cmp === 0;
      const isUpgrade = cmp > 0;
      const isRollback = cmp < 0;
      const isApplyingThis = applyingVersion === normalizeVersionText(entry.version);

      const card = document.createElement("article");
      card.className = `changelog-entry${isLatest ? " is-latest" : ""}${isCurrent ? " is-current" : ""}`;
      card.setAttribute("data-version", entry.version);

      const head = document.createElement("div");
      head.className = "changelog-entry-head";

      const headLeft = document.createElement("div");
      headLeft.className = "changelog-entry-tags";

      const verPill = document.createElement("span");
      verPill.className = "changelog-ver-pill";
      verPill.textContent = `v${entry.version}`;
      headLeft.appendChild(verPill);

      if (isLatest) {
        const latestBadge = document.createElement("span");
        latestBadge.className = "changelog-badge is-latest";
        latestBadge.textContent = tr("changelog.latestBadge", "最新");
        headLeft.appendChild(latestBadge);
      }

      if (entry.date) {
        const dateEl = document.createElement("span");
        dateEl.className = "changelog-entry-date";
        dateEl.textContent = entry.date;
        headLeft.appendChild(dateEl);
      }

      const headRight = document.createElement("div");
      headRight.className = "changelog-entry-right";

      const actionBtn = document.createElement("button");
      actionBtn.type = "button";
      actionBtn.setAttribute("data-changelog-action-version", entry.version);

      if (isCurrent) {
        actionBtn.className = "changelog-ver-action-btn is-current";
        actionBtn.disabled = true;
        actionBtn.setAttribute("data-changelog-action", "current");
        actionBtn.textContent = tr("changelog.currentBadge", "当前版本");
        actionBtn.title = `当前已安装 v${entry.version}`;
      } else if (isUpgrade) {
        actionBtn.className = `changelog-ver-action-btn is-upgrade${isApplyingThis ? " is-busy" : ""}`;
        actionBtn.disabled = Boolean(applyingVersion);
        actionBtn.setAttribute("data-changelog-action", "upgrade");
        actionBtn.textContent = isApplyingThis
          ? tr("changelog.actionUpgrading", "更新中…")
          : tr("changelog.actionUpgrade", "更新");
        actionBtn.title = `点击下载并更新至 v${entry.version}（保留个人配置与规则）`;
        actionBtn.addEventListener("click", () => void handleVersionAction(entry.version, false));
      } else if (isRollback) {
        actionBtn.className = `changelog-ver-action-btn is-rollback${isApplyingThis ? " is-busy" : ""}`;
        actionBtn.disabled = Boolean(applyingVersion);
        actionBtn.setAttribute("data-changelog-action", "rollback");
        actionBtn.textContent = isApplyingThis
          ? tr("changelog.actionRollingBack", "回退中…")
          : tr("changelog.actionRollback", "回退");
        actionBtn.title = `点击下载并回退至历史版本 v${entry.version}（保留个人配置与规则）`;
        actionBtn.addEventListener("click", () => void handleVersionAction(entry.version, true));
      }

      headRight.appendChild(actionBtn);
      head.appendChild(headLeft);
      head.appendChild(headRight);
      card.appendChild(head);

      const titleEl = document.createElement("h4");
      titleEl.className = "changelog-entry-title";
      titleEl.textContent = entry.title;
      card.appendChild(titleEl);

      const ul = document.createElement("ul");
      ul.className = "changelog-entry-list";
      (entry.items || []).forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        ul.appendChild(li);
      });
      card.appendChild(ul);

      listEl.appendChild(card);
    });
  }

  function open() {
    if (!modal) return;
    render();
    modal.hidden = false;
    isOpen = true;
    if (listEl) listEl.scrollTop = 0;
    if (triggerBtn) triggerBtn.setAttribute("aria-expanded", "true");
    void syncRemoteReleases({ force: false });
  }

  function close() {
    if (!modal) return;
    modal.hidden = true;
    isOpen = false;
    if (triggerBtn) triggerBtn.setAttribute("aria-expanded", "false");
  }

  if (triggerBtn) {
    triggerBtn.setAttribute("aria-haspopup", "dialog");
    triggerBtn.setAttribute("aria-expanded", "false");
    const onOpen = () => open();
    triggerBtn.addEventListener("click", onOpen);
    cleanups.push(() => triggerBtn.removeEventListener("click", onOpen));
  }

  if (modal) {
    const closeTargets = modal.querySelectorAll("[data-changelog-close]");
    closeTargets.forEach((el) => {
      const onClose = () => close();
      el.addEventListener("click", onClose);
      cleanups.push(() => el.removeEventListener("click", onClose));
    });
  }

  if (typeof document !== "undefined") {
    const onKeyDown = (e) => {
      if (isOpen && e.key === "Escape") {
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    cleanups.push(() => document.removeEventListener("keydown", onKeyDown));
  }

  render();

  return {
    open,
    close,
    setCurrentVersion(ver) {
      const clean = normalizeVersionText(ver);
      if (clean && clean !== currentVersion) {
        currentVersion = clean;
        render();
      }
    },
    setTranslator(nextT) {
      if (typeof nextT === "function") {
        translator = nextT;
        render();
      }
    },
    syncRemoteReleases,
    getEntries() {
      return mergedEntries;
    },
    destroy() {
      destroyed = true;
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}
