export const DEFAULT_LANG = 'zh-CN';
export const SUPPORTED_LANGS = Object.freeze(['zh-CN', 'en']);

export const DICT = Object.freeze({
  'zh-CN': Object.freeze({
    // Navigation & Global Status
    'nav.ariaLabel': '插件功能导航',
    'nav.general': '通用',
    'nav.mastery': '掌握',
    'nav.theme': '美化',
    'nav.refreshTitle': '立即刷新（触发增量重扫）',
    'nav.repoTitle': '打开项目 GitHub 主页 (aishadiaodeqishui/agy-monitor)',
    'nav.updateCheck': '检查更新',
    'nav.updateChecking': '检测中…',
    'nav.updateLatest': '已最新',
    'nav.updateAvailable': '有更新',
    'nav.updating': '更新中…',
    'nav.updatedReload': '已更新·重载生效',

    'status.syncing': '同步中…',
    'status.live': '实时监控中',
    'status.paused': '已暂停',
    'status.error': '连接异常',
    'status.noActiveConv': '暂无活动会话',
    'status.offline': '离线或等待扫描',
    'status.followLatest': '跟随最新会话',
    'status.lockedSession': '已锁定会话',
    'status.followLatestTitle': '点击切换「跟随最新顶层会话」或「锁定当前会话」',

    // Common Controls
    'common.close': '关闭',
    'common.gotIt': '我知道了',
    'common.cancel': '取消',
    'common.save': '保存',
    'common.delete': '删除',

    // Context Pie Card
    'pie.ariaLabel': '上下文占用情况',
    'pie.title': '上下文占用',
    'pie.windowTitle': '切换上下文窗口上限',
    'pie.windowBadge': '{label} 窗口',
    'pie.summaryFormat': '{used} / {cap} ({pct}%)',
    'pie.segSystemBase': '系统底座',
    'pie.segRulesAddon': 'Rules 规则增量',
    'pie.segRulesAddonFormatted': '规则增量 (+{tokens})',
    'pie.segUserHistory': '用户与对话历史',
    'pie.segToolsOutputs': '工具与执行输出',
    'pie.segRemaining': '剩余可用空间',
    'pie.tokensUnit': 'tokens',
    'pie.windowSaved': '已将显示窗口上限切换为 {label}',
    'pie.windowSaveFailed': '切换上下文上限失败',

    // Model Token Usage Card
    'usage.ariaLabel': '各模型 Token 用量',
    'usage.title': '模型 Token 用量',
    'usage.scopeGlobal': '全局',
    'usage.scopeCurrent': '当前',
    'usage.rangeToday': '今天',
    'usage.range7d': '近七天',
    'usage.range30d': '近一个月',
    'usage.cacheHit': '缓存命中',
    'usage.cacheMiss': '缓存未命中',
    'usage.output': '输出',
    'usage.empty': '当前筛选范围暂无模型用量记录',
    'usage.totalTokens': '总消耗',
    'usage.sharePct': '占比 {pct}%',
    'usage.unrecordedModel': '历史未记录模型（v2.33前）',
    'usage.unpricedRef': '未定价参考',

    // Global Default Model & New Conversation
    'model.defaultLabel': '发起模型偏好',
    'model.loading': '读取可用模型…',
    'model.newConvTitle': '使用选定模型立即发起新对话（需发送首句）',
    'model.newConvBtn': '发起新对话',
    'model.newConvWarn': '将使用当前选定模型立即发送首条消息并消耗额度，不修改宿主左侧默认模型',
    'model.newConvPromptPlaceholder': '输入首句指令（留空发送默认确认语）…',
    'model.newConvSubmit': '立即发起并发送',
    'model.unavailable': '尚未设定默认模型',
    'model.saved': '已保存插件快捷发起模型：{model}（不改写宿主原生设置）',
    'model.saveFailed': '保存模型偏好失败',
    'model.creatingConv': '正在向宿主发送首句并发起新对话…',
    'model.createdConv': '已用 {model} 发起新对话并发送首句',
    'model.createConvFailed': '宿主暂不支持自动发起，请在左侧主栏手动新建对话',
    'model.noModels': '暂未发现可用模型记录',
    'model.notSet': '跟随当前选择',
    'model.tierPro': 'Pro',
    'model.tierFlash': 'Fast',
    'model.tierHigh': 'High',
    'model.tierStandard': 'Standard',

    // System Prompt Presets & .md Import
    'prompt.label': '全局 Rules 预设',
    'prompt.importTitle': '导入 .md 文件新增规则预设',
    'prompt.importBtn': '导入 .md',
    'prompt.helpTitle': '格式说明与安全提醒',
    'prompt.groupBuiltin': '内置预设',
    'prompt.groupCustom': '已导入自定义规则',
    'prompt.importEmpty': '所选 Markdown 文件内容为空',
    'prompt.importTooLarge': '文件超出单文件 24,000 字节 (UTF-8) 上限，请精简后再导入',
    'prompt.importSuccess': '已导入并写入全局 rules/AGENTS.md：{name}（+{tokens} tokens，下轮生效）',
    'prompt.importWarning': '规则已导入（存在提示）：{warning}',
    'prompt.importBlocked': '安全风控已拦截该文件：{reason}',
    'prompt.importFailed': '导入规则文件失败',
    'prompt.selectedToast': '已切换全局规则预设：{name}（下轮对话生效）',
    'prompt.selectFailed': '切换规则预设失败',
    'prompt.noPresets': '暂无可用规则预设',
    'prompt.deletePreset': '删除自定义规则',
    'prompt.scopeNotice': '非空预设将写入受控全局 rules/AGENTS.md（ALWAYS_ON，≤24KB），下一轮对话起生效。',

    // Prompt Help & Security Modal
    'promptModal.title': '系统提示词导入说明（.md 格式与安全提醒）',
    'promptModal.formatTitle': '基础格式要求',
    'promptModal.formatDesc':
      '支持 UTF-8 编码的 .md / .markdown 纯文本文件（严格不超过 24,000 字节）。首行可使用「# 方案名称」作为预设显示名，未填写时自动取文件名。',
    'promptModal.scopeTitle': '生效范围说明',
    'promptModal.scopeDesc':
      '在 Antigravity 原生插件机制下，所选预设会作为全局 ALWAYS_ON 附加规则写入受控 rules/AGENTS.md（下一轮对话起生效），无法删改或替换官方内置系统底座，因此饼图会诚实拆分为「官方底座」与「规则增量」。',
    'promptModal.securityTitle': '重要防风控安全提醒',
    'promptModal.securityDesc':
      '官方正持续通过提示词与工具调用特征匹配打击未授权反代接口及 dsh、PI（pi-coding-agent）等第三方 Harness 外壳。日常请优先选用「官方原版」或近官方行为规范预设，切勿导入包含 <system> 伪造标签、第三方客户端工具协议或反代/Harness 特征头的内容（后端将自动拦截高危特征）。',

    // Sessions Hub (4 Columns)
    'sessions.activeTitle': '活动会话',
    'sessions.activeSub': '运行中',
    'sessions.unreadTitle': '已完成未读',
    'sessions.unreadSub': '待查看',
    'sessions.recentTitle': '最近活动',
    'sessions.recentSub': '完成时间降序',
    'sessions.favoritesTitle': '常用会话',
    'sessions.addFavorite': '加入',
    'sessions.runningTag': '运行中',
    'sessions.waitingTag': '等待/收尾',
    'sessions.markReadBtn': '标为已读',
    'sessions.favAddBtn': '收藏',
    'sessions.favRemoveBtn': '移出常用',
    'sessions.dragHint': '可上移 / 下移调整顺序',
    'sessions.moveUp': '上移',
    'sessions.moveDown': '下移',
    'sessions.emptyActive': '暂无运行中会话',
    'sessions.emptyUnread': '暂无未读完成会话',
    'sessions.emptyRecent': '暂无最近对话记录',
    'sessions.emptyFavorites': '点击“加入”固定常用会话',
    'sessions.allInFavorites': '近期会话均已加入常用列表',
    'sessions.switchedNotice': '已发送切换对话指令：{title}',
    'sessions.markedReadNotice': '已标记为已读',
    'sessions.favoritesSyncFailed': '同步常用会话列表失败',
    'sessions.unknownWorkspace': '全局或未绑定工作区',
    'sessions.untitled': '未命名对话',

    // Runtime Telemetry Bar (Generation Speed + Upstream Model)
    'runtime.speedLabel': '生成速率',
    'runtime.upstreamLabel': '最近一次上游真实返回模型',
    'runtime.speedUnitTokS': 'tok/s',
    'runtime.speedIdle': '当前空闲',
    'runtime.speedSampling': '等待首轮流式输出采样',
    'runtime.speedSourceTool': '工具步端到端参考',
    'runtime.speedSourceRecent': '最近响应估算',
    'runtime.speedAvgOnly': '均值 {avg}',
    'runtime.speedSubWithAvg': '{source} · 均值 {avg}',
    'runtime.speedSubWithSession': '{source} · 均值 {avg} · {session}',
    'runtime.followSessionTag': '跟随 {title}',
    'runtime.lockedSessionTag': '已锁定 {title}',
    'runtime.upstreamNone': '尚无上游模型回传记录',
    'runtime.upstreamSourceLog': '来自本地执行日志真实字段',
    'runtime.statusMatch': '一致',
    'runtime.statusDowngrade': '疑似降级',
    'runtime.statusAlias': '灰测/别名',
    'runtime.statusNoBaseline': '未设对照',
    'runtime.statusUnreported': '未上报',
    'runtime.cacheHitSub': '缓存命中 {pct}%',
    'runtime.noBaselineHint': '未设发起偏好 · 仅读当前日志',
    'runtime.downgradeHint': '与默认选定模型不一致',
    'runtime.aliasHint': '检测到上游别名或灰测',

    // Mastery Tab (Placeholder)
    'mastery.title': '掌握',
    'mastery.desc':
      '此分页用于配置上下文压缩阈值、执行过程实时汇报与拦截控制等深度功能，待后续步骤定稿。',

    // Theme Studio & Honest Capability Boundary Card
    'theme.colorTitle': '色调',
    'theme.colorSub': '本面板配色定制与明暗反色适配',
    'theme.syncTitle': '开启后仅监听宿主明暗主题事件（不读写 config.json）',
    'theme.syncHostBtn': '跟随宿主明暗',
    'theme.resetBtn': '还原默认',
    'theme.saveNamePlaceholder': '为当前调色方案命名并保存…',
    'theme.savePaletteBtn': '保存方案',
    'theme.previewLabel': '样式示例区',
    'theme.previewBubbleText': '已开启撞色视觉配置',
    'theme.previewBadgeText': '运行中',
    'theme.previewMetricText': '上下文 53%',
    'theme.colorAccent': '主强调色',
    'theme.colorContrast': '次撞色',
    'theme.colorTertiary': '辅助点缀',
    'theme.colorCanvas': '主画布背景',
    'theme.colorChrome': '边框与顶栏',
    'theme.colorBubble': '卡片与气泡',
    'theme.customPaletteSaved': '已保存自定义配色方案：{name}',
    'theme.customPaletteDeleted': '已删除自定义配色方案',
    'theme.customPaletteNameRequired': '请先输入自定义方案名称',
    'theme.customPaletteDeleteBlocked': '内置配色方案不可删除',
    'theme.customPaletteSaveFailed': '保存配色方案失败',
    'theme.customPaletteDeleteFailed': '删除配色方案失败',
    'theme.customBadge': '自定义',
    'theme.builtinBadge': '内置',
    'theme.exportSeedsBtn': '导出 Seeds 参考',
    'theme.exportSeedsCopied': '已复制官方 Seeds JSON 参考配置',

    'theme.wallpaperTitle': '图片壁纸',
    'theme.wallpaperNone': '未启用壁纸',
    'theme.wallpaperRandom': '随机壁纸',
    'theme.wallpaperUpload': '自定义图片',
    'theme.wallpaperClear': '清除',
    'theme.wallpaperDeleteBtn': '删除壁纸',
    'theme.wallpaperUploaded': '已上传并应用自定义壁纸：{name}',
    'theme.wallpaperSvgBlocked': '安全限制：禁止上传 SVG 图片，仅支持 PNG/JPEG/WEBP/GIF 位图',
    'theme.uploadTooLarge': '壁纸图片请勿超过 8 MB',
    'theme.wallpaperUploadFailed': '上传壁纸失败',
    'theme.wallpaperDeleted': '已删除自定义壁纸',
    'theme.wallpaperSaved': '壁纸设置已更新',
    'theme.opacity': '透明度',
    'theme.blur': '模糊度',
    'theme.dim': '暗度遮罩',
    'theme.radius': '圆角柔化',
    'theme.fitLabel': '壁纸适配',
    'theme.fitCover': '铺满裁剪',
    'theme.fitContain': '完整居中',

    'backdrop.title': '整机壁纸方案',
    'backdrop.toggleBtn': '启用整机壁纸',
    'backdrop.modeLabel': '渲染方案',
    'backdrop.modeBackdrop': '方案一 · 贴背微透',
    'backdrop.modeCdp': '方案二 · CDP 高清纯CSS',
    'backdrop.blendLabel': '整机壁纸透显度（主窗柔和透明）',
    'backdrop.blendLabelCdp': '底层壁纸透出强度（文字 100% 锐利）',
    'backdrop.statusRunning': '伴侣运行中（{count} 窗）',
    'backdrop.statusPaused': '伴侣已暂停',
    'backdrop.statusStandby': '待选壁纸',
    'backdrop.statusOff': '未开启',
    'backdrop.statusIsolated': '待桌面启动',
    'backdrop.statusPreparing': '准备就绪',
    'backdrop.statusUnsupported': '仅支持 Windows',
    'backdrop.statusCdpConnected': 'CDP 已直连 (:{port})',
    'backdrop.statusCdpWait': '待 CDP 启动 (:{port})',
    'backdrop.descAuto': '方案一：在 Antigravity 窗口正后方贴合壁纸并微透主窗（零侵入、无需重启 AGY）。',
    'backdrop.descRunning': '方案一在线（追踪 {count} 窗 · 主窗不透明度 {alpha}%）；若觉得文字偏柔可切换方案二。',
    'backdrop.descIsolated': '官方插件进程在隔离沙箱中；复制右侧启动命令（Win+R）或双击「{path}」启动一次即可常驻托盘。',
    'backdrop.descNoWallpaper': '请先在上方选择或上传一张壁纸，即可点亮整机背景。',
    'backdrop.descCdpConnected': '方案二已连通本地 CDP (:{port})：全窗底层壁纸与 120fps 原生输入框 HUD 已启用，文字/代码 100% 锐利。',
    'backdrop.descCdpWait': '方案二需带调试参数启动：完全退出 AGY 后双击无黑窗快捷方式「{path}」（可固定到任务栏，或给原有 AGY 快捷方式目标追加 --remote-debugging-port={port}）。',
    'backdrop.copyCmdBtn': '复制启动命令',
    'backdrop.cmdCopied': '已复制启动命令：按 Win+R 粘贴运行即可启动',
    'backdrop.cdpCmdCopied': '已复制无黑窗启动命令：完全退出 Antigravity 后按 Win+R 粘贴运行，或追加到原快捷方式目标',
    'backdrop.cmdCopyFailed': '复制失败，请手工运行：{cmd}',
    'backdrop.enabledToast': '已开启整机壁纸联动',
    'backdrop.disabledToast': '已关闭整机壁纸，Antigravity 恢复原生背景',
    'backdrop.modeSwitchedBackdrop': '已切回方案一（贴背微透窗）',
    'backdrop.modeSwitchedCdp': '已切换到方案二（CDP 高清纯 CSS，主窗文字已恢复 100% 实心）',

    'theme.languageTitle': '宿主界面语言',
    'theme.languageSub': '仅切换 Antigravity 宿主界面（需 CDP 连通），本控制台固定中文',
    'theme.languageSaved': '已切换 Antigravity 宿主界面为：{lang}',
    'theme.languageSavedWaitCdp': '已保存宿主语言为「{lang}」（使用方案二 CDP 启动 Antigravity 后自动生效）',
    'theme.languageSaveFailed': '保存语言设置失败',

    'theme.boundaryTitle': '能力范围与官方沙箱边界说明',
    'theme.boundaryThemeLabel': '主题配色与明暗跟随',
    'theme.boundarySynced': '仅监听宿主明暗',
    'theme.boundaryUnsynced': '完全独立配色',
    'theme.boundaryThemeDesc':
      '所有颜色方案与浅色画布高对比反色均在插件面板内生效；开启「跟随宿主明暗」后仅只读响应宿主 theme-change 事件，不直接写 ~/.gemini/config/config.json。',
    'theme.boundaryWallpaperLabel': '整机壁纸（贴背伴侣）',
    'theme.boundaryPanelOnly': '需 CDP 通道',
    'theme.boundaryBackdropBadge': '零侵入桌面伴侣',
    'theme.boundaryWallpaperDesc':
      '严格遵守不篡改 app.asar 的红线：方案一通过外置桌面贴背窗与系统微透实现，方案二通过本地 CDP 通道纯 CSS 注入底层壁纸并保持文字 100% 锐利。',
    'theme.boundaryLangLabel': 'Antigravity 宿主界面汉化',
    'theme.boundaryLangDesc':
      '上方语言开关仅切换 Antigravity 宿主界面文案（不改 app.asar，通过 CDP 内存无损词典替换，切回 English 即秒还原）；AGY 控制台本身固定显示简体中文。',
  }),

  en: Object.freeze({
    // Navigation & Global Status
    'nav.ariaLabel': 'Plugin Navigation',
    'nav.general': 'General',
    'nav.mastery': 'Mastery',
    'nav.theme': 'Studio',
    'nav.refreshTitle': 'Refresh Now (Triggers Incremental Rescan)',
    'nav.repoTitle': 'Open GitHub Repository (aishadiaodeqishui/agy-monitor)',
    'nav.updateCheck': 'Check Update',
    'nav.updateChecking': 'Checking…',
    'nav.updateLatest': 'Up to date',
    'nav.updateAvailable': 'Update',
    'nav.updating': 'Updating…',
    'nav.updatedReload': 'Updated · Reload',

    'status.syncing': 'Syncing…',
    'status.live': 'Live',
    'status.paused': 'Paused',
    'status.error': 'Sync Error',
    'status.noActiveConv': 'No Active Session',
    'status.offline': 'Idle / Waiting',
    'status.followLatest': 'Follow Latest',
    'status.lockedSession': 'Locked',
    'status.followLatestTitle': 'Toggle between Follow Latest top-level chat and Locked chat',

    // Common Controls
    'common.close': 'Close',
    'common.gotIt': 'Got it',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.delete': 'Delete',

    // Context Pie Card
    'pie.ariaLabel': 'Context Usage Overview',
    'pie.title': 'Context Usage',
    'pie.windowTitle': 'Switch Context Window Cap',
    'pie.windowBadge': '{label} Window',
    'pie.summaryFormat': '{used} / {cap} ({pct}%)',
    'pie.segSystemBase': 'System Base',
    'pie.segRulesAddon': 'Rules Add-on',
    'pie.segRulesAddonFormatted': 'Rules Add-on (+{tokens})',
    'pie.segUserHistory': 'User & Chat History',
    'pie.segToolsOutputs': 'Tools & Outputs',
    'pie.segRemaining': 'Remaining Budget',
    'pie.tokensUnit': 'tokens',
    'pie.windowSaved': 'Display window cap switched to {label}',
    'pie.windowSaveFailed': 'Failed to update context window cap',

    // Model Token Usage Card
    'usage.ariaLabel': 'Model Token Usage',
    'usage.title': 'Model Token Usage',
    'usage.scopeGlobal': 'Global',
    'usage.scopeCurrent': 'Current',
    'usage.rangeToday': 'Today',
    'usage.range7d': '7 Days',
    'usage.range30d': '30 Days',
    'usage.cacheHit': 'Cache Hit',
    'usage.cacheMiss': 'Cache Miss',
    'usage.output': 'Output',
    'usage.empty': 'No model token usage recorded for this filter',
    'usage.totalTokens': 'Total Tokens',
    'usage.sharePct': '{pct}% share',
    'usage.unrecordedModel': 'Unrecorded Model (pre-v2.33)',
    'usage.unpricedRef': 'Unpriced',

    // Global Default Model & New Conversation
    'model.defaultLabel': 'Preferred Launch Model',
    'model.loading': 'Loading models…',
    'model.newConvTitle': 'Start New Chat Immediately with Selected Model',
    'model.newConvBtn': 'Start Chat',
    'model.newConvWarn': 'Sends first prompt immediately & consumes quota; does not change host sidebar default',
    'model.newConvPromptPlaceholder': 'Optional opening prompt (leave blank for default)…',
    'model.newConvSubmit': 'Send & Start',
    'model.unavailable': 'No Default Selected',
    'model.saved': 'Saved plugin quick-launch model: {model} (host sidebar unchanged)',
    'model.saveFailed': 'Failed to save model preference',
    'model.creatingConv': 'Sending opening prompt to start new chat…',
    'model.createdConv': 'Started new chat and sent prompt with {model}',
    'model.createConvFailed': 'Host could not auto-start chat; please start one from the left sidebar',
    'model.noModels': 'No model records detected yet',
    'model.notSet': 'Use Current Selection',
    'model.tierPro': 'Pro',
    'model.tierFlash': 'Fast',
    'model.tierHigh': 'High',
    'model.tierStandard': 'Standard',

    // System Prompt Presets & .md Import
    'prompt.label': 'Global Rules Preset',
    'prompt.importTitle': 'Import .md File as New Rules Preset',
    'prompt.importBtn': 'Import .md',
    'prompt.helpTitle': 'Format Guide & Safety Notice',
    'prompt.groupBuiltin': 'Built-in Presets',
    'prompt.groupCustom': 'Custom Imported Rules',
    'prompt.importEmpty': 'Selected Markdown file is empty',
    'prompt.importTooLarge': 'File exceeds the 24,000-byte (UTF-8) single-file limit',
    'prompt.importSuccess': 'Imported and wrote global rules/AGENTS.md: {name} (+{tokens} tokens next turn)',
    'prompt.importWarning': 'Imported with warning: {warning}',
    'prompt.importBlocked': 'Blocked by security guard: {reason}',
    'prompt.importFailed': 'Failed to import Markdown rules',
    'prompt.selectedToast': 'Switched global rules preset: {name} (active next turn)',
    'prompt.selectFailed': 'Failed to switch rules preset',
    'prompt.noPresets': 'No rules presets available',
    'prompt.deletePreset': 'Delete custom preset',
    'prompt.scopeNotice': 'Non-empty presets write to global ALWAYS_ON rules/AGENTS.md (<=24KB) starting next turn.',

    // Prompt Help & Security Modal
    'promptModal.title': 'Rules Import Guide (.md Format & Safety Notice)',
    'promptModal.formatTitle': 'Format Requirements',
    'promptModal.formatDesc':
      'Accepts UTF-8 plain text .md / .markdown files strictly within 24,000 bytes. The first "# Title" heading becomes the display name if present.',
    'promptModal.scopeTitle': 'How Rules Apply',
    'promptModal.scopeDesc':
      'Under Antigravity plugin rules, selected presets write global ALWAYS_ON guidelines into controlled rules/AGENTS.md (active next turn) without removing or replacing native system instructions, so the pie chart honestly splits Official Base and Rules Add-on.',
    'promptModal.securityTitle': 'Important Anti-Risk Safety Warning',
    'promptModal.securityDesc':
      'Official systems actively detect unauthorized reverse-proxy headers and third-party harness signatures such as dsh or PI (pi-coding-agent). Stick to the Official Base or benign behavioral rules; never import spoofed <system> tags, conflicting tool schemas, or proxy headers (automatically blocked here).',

    // Sessions Hub (4 Columns)
    'sessions.activeTitle': 'Active Chats',
    'sessions.activeSub': 'Running',
    'sessions.unreadTitle': 'Unread Done',
    'sessions.unreadSub': 'To Review',
    'sessions.recentTitle': 'Recent Activity',
    'sessions.recentSub': 'Latest First',
    'sessions.favoritesTitle': 'Favorites',
    'sessions.addFavorite': 'Add',
    'sessions.runningTag': 'Running',
    'sessions.waitingTag': 'Waiting',
    'sessions.markReadBtn': 'Mark Read',
    'sessions.favAddBtn': 'Pin',
    'sessions.favRemoveBtn': 'Unpin',
    'sessions.dragHint': 'Use Move Up / Down to reorder',
    'sessions.moveUp': 'Move Up',
    'sessions.moveDown': 'Move Down',
    'sessions.emptyActive': 'No active sessions',
    'sessions.emptyUnread': 'No unread completed sessions',
    'sessions.emptyRecent': 'No recent sessions',
    'sessions.emptyFavorites': 'Click "Add" to pin favorite sessions',
    'sessions.allInFavorites': 'All recent sessions are already pinned',
    'sessions.switchedNotice': 'Sent focus command: {title}',
    'sessions.markedReadNotice': 'Marked as read',
    'sessions.favoritesSyncFailed': 'Failed to save favorites list',
    'sessions.unknownWorkspace': 'Global / Unbound Workspace',
    'sessions.untitled': 'Untitled Session',

    // Runtime Telemetry Bar (Generation Speed + Upstream Model)
    'runtime.speedLabel': 'Generation Speed',
    'runtime.upstreamLabel': 'Last Upstream Reported Model',
    'runtime.speedUnitTokS': 'tok/s',
    'runtime.speedIdle': 'Idle',
    'runtime.speedSampling': 'Waiting for streamed step sample',
    'runtime.speedSourceTool': 'Tool-step e2e est.',
    'runtime.speedSourceRecent': 'Recent step est.',
    'runtime.speedAvgOnly': 'Avg {avg}',
    'runtime.speedSubWithAvg': '{source} · Avg {avg}',
    'runtime.speedSubWithSession': '{source} · Avg {avg} · {session}',
    'runtime.followSessionTag': 'Following {title}',
    'runtime.lockedSessionTag': 'Locked {title}',
    'runtime.upstreamNone': 'No upstream model logged yet',
    'runtime.upstreamSourceLog': 'Read from local step logs',
    'runtime.statusMatch': 'Match',
    'runtime.statusDowngrade': 'Downgrade?',
    'runtime.statusAlias': 'A/B · Alias',
    'runtime.statusNoBaseline': 'No Baseline',
    'runtime.statusUnreported': 'Unreported',
    'runtime.cacheHitSub': 'Cache hit {pct}%',
    'runtime.noBaselineHint': 'No launch baseline · logs only',
    'runtime.downgradeHint': 'Differs from selected default',
    'runtime.aliasHint': 'Upstream alias / A/B detected',

    // Mastery Tab (Placeholder)
    'mastery.title': 'Mastery',
    'mastery.desc':
      'Reserved for future context compression thresholds, live step progress controls, and interception policies.',

    // Theme Studio & Honest Capability Boundary Card
    'theme.colorTitle': 'Color Palette',
    'theme.colorSub': 'Panel Accent Pairing & Auto Contrast',
    'theme.syncTitle': 'Follow host light/dark theme events only (never writes config.json)',
    'theme.syncHostBtn': 'Follow Host Mode',
    'theme.resetBtn': 'Reset Default',
    'theme.saveNamePlaceholder': 'Name & save current custom palette…',
    'theme.savePaletteBtn': 'Save Palette',
    'theme.previewLabel': 'Live Preview',
    'theme.previewBubbleText': 'Contrast palette enabled',
    'theme.previewBadgeText': 'Running',
    'theme.previewMetricText': 'Context 53%',
    'theme.colorAccent': 'Primary Accent',
    'theme.colorContrast': 'Secondary Accent',
    'theme.colorTertiary': 'Tertiary Accent',
    'theme.colorCanvas': 'Canvas Background',
    'theme.colorChrome': 'Chrome & Header',
    'theme.colorBubble': 'Cards & Bubbles',
    'theme.customPaletteSaved': 'Saved custom palette: {name}',
    'theme.customPaletteDeleted': 'Deleted custom palette',
    'theme.customPaletteNameRequired': 'Please enter a palette name first',
    'theme.customPaletteDeleteBlocked': 'Built-in palettes cannot be deleted',
    'theme.customPaletteSaveFailed': 'Failed to save custom palette',
    'theme.customPaletteDeleteFailed': 'Failed to delete custom palette',
    'theme.customBadge': 'Custom',
    'theme.builtinBadge': 'Built-in',
    'theme.exportSeedsBtn': 'Export Seeds JSON',
    'theme.exportSeedsCopied': 'Copied official Seeds JSON reference',

    'theme.wallpaperTitle': 'Wallpapers',
    'theme.wallpaperNone': 'No wallpaper active',
    'theme.wallpaperRandom': 'Random',
    'theme.wallpaperUpload': 'Upload Image',
    'theme.wallpaperClear': 'Clear',
    'theme.wallpaperDeleteBtn': 'Delete Wallpaper',
    'theme.wallpaperUploaded': 'Uploaded and applied wallpaper: {name}',
    'theme.wallpaperSvgBlocked': 'Security rule: SVG uploads are blocked; use PNG, JPEG, WEBP, or GIF',
    'theme.uploadTooLarge': 'Wallpaper image must be <= 8 MB',
    'theme.wallpaperUploadFailed': 'Failed to upload wallpaper',
    'theme.wallpaperDeleted': 'Deleted custom wallpaper',
    'theme.wallpaperSaved': 'Wallpaper settings updated',
    'theme.opacity': 'Opacity',
    'theme.blur': 'Blur',
    'theme.dim': 'Dim Overlay',
    'theme.radius': 'Corner Radius',
    'theme.fitLabel': 'Image Fit',
    'theme.fitCover': 'Fill & Crop',
    'theme.fitContain': 'Fit Centered',

    'backdrop.title': 'Whole-Window Wallpaper',
    'backdrop.toggleBtn': 'Enable Whole-Window Wallpaper',
    'backdrop.modeLabel': 'Render Mode',
    'backdrop.modeBackdrop': 'Mode 1 · Backdrop Window',
    'backdrop.modeCdp': 'Mode 2 · CDP Crisp CSS',
    'backdrop.blendLabel': 'Desktop Blend (Soft Host Translucency)',
    'backdrop.blendLabelCdp': 'Wallpaper Show-Through (100% Crisp Text)',
    'backdrop.statusRunning': 'Active ({count} win)',
    'backdrop.statusPaused': 'Paused in Tray',
    'backdrop.statusStandby': 'Pick Wallpaper',
    'backdrop.statusOff': 'Disabled',
    'backdrop.statusIsolated': 'Run on Desktop',
    'backdrop.statusPreparing': 'Ready',
    'backdrop.statusUnsupported': 'Windows Only',
    'backdrop.statusCdpConnected': 'CDP Linked (:{port})',
    'backdrop.statusCdpWait': 'Wait CDP (:{port})',
    'backdrop.descAuto': 'Mode 1 renders the active wallpaper behind Antigravity with soft translucency (no restart needed).',
    'backdrop.descRunning': 'Mode 1 active ({count} win · {alpha}% opacity); switch to Mode 2 if you prefer 100% crisp text.',
    'backdrop.descIsolated': 'Sidecar runs inside an isolated sandbox; copy & run the launch command (Win+R) or double-click "{path}" once.',
    'backdrop.descNoWallpaper': 'Select or upload a wallpaper above to light up the whole-window background.',
    'backdrop.descCdpConnected': 'Mode 2 linked via localhost CDP (:{port}): full-window CSS wallpaper & 120fps native HUD active, text 100% sharp.',
    'backdrop.descCdpWait': 'Mode 2 requires remote-debugging launch: fully quit AGY, then double-click the console-free shortcut "{path}" (or append --remote-debugging-port={port} to your existing AGY shortcut).',
    'backdrop.copyCmdBtn': 'Copy Launch Cmd',
    'backdrop.cmdCopied': 'Launch command copied: press Win+R, paste & run',
    'backdrop.cdpCmdCopied': 'Console-free CDP command copied: fully quit Antigravity, then paste in Win+R',
    'backdrop.cmdCopyFailed': 'Copy failed; run manually: {cmd}',
    'backdrop.enabledToast': 'Whole-window wallpaper enabled',
    'backdrop.disabledToast': 'Whole-window wallpaper disabled; Antigravity restored',
    'backdrop.modeSwitchedBackdrop': 'Switched to Mode 1 (Backdrop Window)',
    'backdrop.modeSwitchedCdp': 'Switched to Mode 2 (CDP Crisp CSS; host opacity restored 100%)',

    'theme.languageTitle': 'Host UI Language',
    'theme.languageSub': 'Switches Antigravity host UI only (via CDP); Console stays Chinese',
    'theme.languageSaved': 'Switched Antigravity host UI language to: {lang}',
    'theme.languageSavedWaitCdp': 'Saved host language "{lang}" (auto-applies once Antigravity runs with CDP Mode 2)',
    'theme.languageSaveFailed': 'Failed to save language preference',

    'theme.boundaryTitle': 'Capability Scope & Sandbox Boundaries',
    'theme.boundaryThemeLabel': 'Panel Colors & Theme Follow',
    'theme.boundarySynced': 'Follows Host Mode',
    'theme.boundaryUnsynced': 'Independent Palette',
    'theme.boundaryThemeDesc':
      'Palettes and automatic light/dark contrast apply inside this panel; "Follow Host Mode" reads host theme-change events without touching ~/.gemini/config/config.json.',
    'theme.boundaryWallpaperLabel': 'Whole-Window Wallpaper (Backdrop)',
    'theme.boundaryPanelOnly': 'Requires CDP',
    'theme.boundaryBackdropBadge': 'Non-Invasive Companion',
    'theme.boundaryWallpaperDesc':
      'Strictly preserves app.asar integrity: Mode 1 uses an external behind-window companion, and Mode 2 uses localhost CDP pure CSS for 100% sharp text.',
    'theme.boundaryLangLabel': 'Antigravity Host UI Localization',
    'theme.boundaryLangDesc':
      'The language switch above translates Antigravity host UI in memory via CDP without touching app.asar (instant revert to English), while AGY Console stays fixed in Simplified Chinese.',
  }),
});

export const TRANSLATIONS = DICT;

/**
 * Verified Antigravity 2.0 host UI glossary (for reference and consistent terminology).
 */
export const HOST_UI_DICTIONARY = Object.freeze({
  'View Usage': '查看用量',
  Reset: '重置',
  Weekly: '每周',
  Planning: '规划模式',
  Fast: '快速模式',
  Turbo: '极速自动模式',
  'Request review': '请求审查',
  'Always Proceed': '始终继续',
  'Files Changed': '已修改文件',
  'Review Policy': '审查策略',
  'New Conversation': '新建对话',
  Settings: '设置',
  Plugins: '插件',
  Customizations: '自定义配置',
});

let activeLang = DEFAULT_LANG;

export function normalizeLang(lang) {
  return lang === 'en' ? 'en' : DEFAULT_LANG;
}

export function setLanguage(lang) {
  activeLang = normalizeLang(lang);
  return activeLang;
}

export function getLanguage() {
  return activeLang;
}

function formatMessage(template, vars = {}) {
  if (typeof template !== 'string') return '';
  if (!vars || typeof vars !== 'object') return template;
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}|\{([a-zA-Z0-9_.-]+)\}/g, (match, doubleKey, singleKey) => {
    const k = doubleKey || singleKey;
    if (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] !== undefined && vars[k] !== null) {
      return String(vars[k]);
    }
    return match;
  });
}

export function translateWithLang(lang, key, vars = {}) {
  const normalized = normalizeLang(lang);
  const pack = DICT[normalized] || DICT[DEFAULT_LANG];
  const fallbackPack = DICT[DEFAULT_LANG];
  const template = pack[key] ?? fallbackPack[key] ?? key;
  return formatMessage(template, vars);
}

/**
 * Create a bound translator `t(key, vars)` with `.lang`, `.setLang()`, `.getLang()`.
 */
export function createTranslator(initialLang = DEFAULT_LANG) {
  let boundLang = normalizeLang(initialLang);

  function tBound(key, vars = {}) {
    return translateWithLang(boundLang, key, vars);
  }

  tBound.getLang = () => boundLang;
  tBound.setLang = (nextLang) => {
    boundLang = normalizeLang(nextLang);
    return boundLang;
  };
  Object.defineProperty(tBound, 'lang', {
    get: () => boundLang,
  });

  return tBound;
}

export function t(key, vars = {}, langOverride) {
  return translateWithLang(langOverride || activeLang, key, vars);
}

/**
 * Apply translations to all static DOM elements carrying data-i18n* attributes.
 */
export function applyDomI18n(root, translatorOrLang) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const translateFn =
    typeof translatorOrLang === 'function'
      ? translatorOrLang
      : createTranslator(translatorOrLang || activeLang);

  const langCode = typeof translateFn.getLang === 'function' ? translateFn.getLang() : activeLang;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = langCode;
  }

  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key) {
      el.textContent = translateFn(key);
    }
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const key = el.getAttribute('data-i18n-title');
    if (key) {
      el.setAttribute('title', translateFn(key));
    }
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) {
      el.setAttribute('placeholder', translateFn(key));
    }
  }
  for (const el of root.querySelectorAll('[data-i18n-aria], [data-i18n-aria-label]')) {
    const key = el.getAttribute('data-i18n-aria') || el.getAttribute('data-i18n-aria-label');
    if (key) {
      el.setAttribute('aria-label', translateFn(key));
    }
  }
}
