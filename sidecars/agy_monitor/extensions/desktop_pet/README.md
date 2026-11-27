# 桌宠可插拔扩展 (`desktop_pet`)

`sidecars/agy_monitor/extensions/desktop_pet/` 是为 **AGY 控制台 (`agy-monitor`)** 打造的高内聚、低耦合可插拔桌宠扩展。

- **即插即用、删除无痕**：全部后端路由、独立存储、前端页面、多语言词典、帧动画工作室、精灵表抠图切帧引擎、MCP 工具集与 Windows / macOS 独立桌宠伴侣均收拢在本目录中。删除本目录或设置环境变量 `AGY_DISABLE_EXTENSIONS=1` 后，主分支核心功能与测试仍 100% 正常运行。
- **默认关闭、零额外开销**：桌宠默认关闭；关闭状态下不启动任何桌面伴侣进程。

---

## 核心特性

### 1. 独立「桌宠」分页 & 顶栏快捷开关
- 在「美化」右侧动态注入独立的 **「桌宠」** 分页，并在控制台顶栏提供一键启停胶囊按钮（窄屏自动折叠适配，防排版错位）。
- 内置 **实时预览舞台**，支持点击测试互动，并在舞台下方提供 `自动跟随 / 待机 / 思考 / 完成 / 互动 / 漫步 / 拖拽` 一键切轨试播。
- 支持 **智能切换 / 桌面悬浮 / 面板内** 三种显示模式，非桌面环境自动降级至面板内悬浮显示。

### 2. 造型素材与 6 轨道自定义帧动画工作室
- **内置 3 款动态矢量萌宠**：暗夜小黑猫（`neko`）、赛博小幽灵（`ghost`）、机甲小助手（`mecha`），实时联动当前主题强调色。
- **单图 / GIF 动图导入**：支持上传 PNG / JPEG / WEBP / GIF（安全校验真实文件头魔数，严格拦截 SVG / XML 注入）。
- **自定义帧动画工作室**：
  - 支持批量多选序列帧上传，或直接导入横向精灵图按列数自动切帧；
  - 支持自定义播放帧率（`1 ~ 30 FPS`）与 **6 条独立状态轨道**：
    - `idle`（默认待机，必填）
    - `running`（Agent 思考运行中）
    - `unread`（任务完成 / 未读）
    - `interact`（点击摸头互动）
    - `walk`（自主桌面漫步）
    - `drag`（鼠标拖拽中）
  - 留空的可选轨道会自动回退至 `idle` 轨道；编辑与删除时自动清理孤儿帧文件。

### 3. Windows / macOS 原生透明桌面宠 & 丰富物理动效（`AgyDesktopPet.cs` / `AgyDesktopPetMac.swift`）
- **Windows 原生伴侣（`AgyDesktopPet.cs`）**：独立于壁纸伴侣的轻量 WPF 透明进程（`agy_desktop_pet.exe`），使用系统自带 `.NET Framework` 零 SDK 编译：
  - **拖拽动画**：按住左键拖拽时播放 `drag` 轨道，叠加实时速度驱动的钟摆晃动（`-24° ~ +24°`）与悬垂拉伸，松手落地触发弹性压扁回弹。
  - **自主移动动画**：待机空闲时自动在屏幕工作区内匀速散步并左右镜像朝向，播放 `walk` 轨道与轻快步伐起伏；支持一键开关「自主桌面漫步」。
  - **自定义弹出气泡内容 & 硬件加速 60fps 动效**：支持内置 6 套快捷预设（`输入输出 Token`、`实时 TPS`、`Token + TPS`、`模型 + 上下文`、`完整遥测`、`可爱台词`）及自由编辑任意文案与动态占位符（`{in}`、`{out}`、`{tps}`、`{pct}`、`{model}`、`{cache}`、`{unread}`）；原生弹窗气泡启用 `BitmapCache` 纹理缓存 + WPF 硬件合成 `BackEase / CubicEase` 原生动画与 60fps 渲染计时，彻底消除卡顿。
  - **互动动画**：单击摸头触发 `interact` 轨道、弹性蹦跳与向上飘散的 `✨ / ♥ / ★` 互动粒子；双击查看本次输入/输出 Token 与上下文占比。
  - **超大尺寸调节（`60% ~ 500%`）**：支持在控制台滑块、右键菜单或 MCP 工具中自由缩放，位图解码针对大尺寸优化保持清晰。
- **macOS 原生伴侣（`AgyDesktopPetMac.swift`）**：基于 AppKit `NSPanel`（`.nonactivatingPanel` 无边框透明悬浮窗、全桌面空间 `.canJoinAllSpaces`），零外部依赖，使用系统自带 `swiftc` 按需编译为 `bin/agy_desktop_pet_mac`；完整支持 3 款内置矢量宠（主题联动配色）、单图 / GIF 动图、6 轨道帧动画、拖拽钟摆物理与落地回弹、2D 自主桌面漫步、气泡模板 DSL、`NSMenu` 右键菜单及鼠标穿透（`ignoresMouseEvents`）悬停 `🔒 解锁` 浮标。

### 4. 主题联动自定义右键菜单
- 彻底替换系统默认灰白菜单，实时读取 `themes.json` 的 `chrome / bubble / accent / tertiary / radius` 并自动适配深浅主题：
  - 弹出带 `160ms` 缩放淡入动效，悬停行带柔和色彩过渡；
  - **二级菜单「🐾 切换桌宠 ›」**：主菜单顶部收拢为单行入口（显示当前生效造型胶囊），悬停或点击后在侧边展开独立二级浮窗（靠近屏幕边缘时自动向左翻转，列表过多自动滚动）选择内置萌宠与全部自定义帧动画/单图，切换时实时生效且不挤占主菜单空间；
  - **桌宠大小（`60% ~ 500%`）**：支持 `− / +` 实时步进调节（200% 以下步进 10%，200% 以上步进 25%），点击百分比一键恢复 `100%`；
  - **流畅过渡胶囊开关**：`允许被选中`、`自主桌面漫步`、`显示互动气泡`、`桌面置顶悬浮` 采用 `220ms CubicEase` 滑动过渡开关，**点击切换不关闭选项框**；
  - **可选中 / 不可选中（游戏防误触穿透）双状态**：控制台「桌宠 → 选中状态」与右键菜单均支持一键切换 **`可以被选中`**（正常拖拽/摸头/右键）与 **`不可选中（穿透）`**（Windows 级 `WS_EX_TRANSPARENT` 鼠标穿透，边跑 AI 边打游戏时点击桌宠本体完全穿透不抢焦点）；锁定状态下将光标移至桌宠上时，头顶会浮现一枚独立的不抢焦点主题 **🔒 锁图标**，点击后平滑切换为 **🔓 解锁态**并立即恢复桌宠交互；
  - **移动自动关闭**：拖拽/移动桌宠或右键拖动超过 4px 时自动关闭右键菜单；另提供一键「召回默认位置」与「关闭桌宠」。

---

## Antigravity MCP API 与 Gemini 自动生图做动画

插件根目录的 [`mcp_config.json`](../../../../mcp_config.json) 通过通用零耦合扩展桥 [`mcp_bridge.mjs`](../mcp_bridge.mjs) 向 Antigravity 内的 Gemini 模型暴露 **`agy-monitor_desktop_pet_mcp`** 工具集，并随插件内置 [`desktop-pet-animator`](../../../../skills/desktop-pet-animator/SKILL.md) 技能。

### MCP 工具清单

| 工具名 | 功能说明 |
| :--- | :--- |
| `pet_get_state` | 读取当前桌宠开关、生效造型、自定义帧动画列表（各轨道帧数与 FPS）、`autoWander` 与桌面伴侣运行状态 |
| `pet_slice_sprite_sheet` | 零依赖切分本地精灵表（`cols × rows`），内置边缘洪水填充/色度键自动抠图（`auto` / `chroma` / `none`）、防抖动脚底居中对齐，并输出棋盘格 `contact_sheet.png` 供视觉验收 |
| `pet_create_frame_animation` | 直接从本地帧路径、Base64 或多轨道 `sprite_sheets`（`idle/running/unread/interact/walk/drag`）创建或热更新帧动画，自动触发控制台实时预览并导出离线交互 HTML 播放器 |
| `pet_preview_animation` | 通知打开的 AGY 控制台自动切换到「桌宠」分页并试播指定轨道，同时重新导出离线交互 HTML 预览页与接触表 PNG |
| `pet_update_settings` | 调节开关（`enabled`）、造型（`active_pet_id`）、显示模式（`auto/desktop/panel`）、大小（`60–500`）、不透明度（`40–100`）、置顶、气泡、`auto_wander` 与重置位置 |
| `pet_delete` | 删除指定自定义桌宠并清理所有关联帧文件 |

### 配套本地 HTTP 接口（Sidecar 扩展路由）
- `GET /api/pet` — 读取桌宠配置与伴侣状态
- `POST /api/pet/save` — 保存桌宠配置并同步桌面伴侣
- `POST /api/pet/upload` — 上传自定义单图 / GIF
- `POST /api/pet/frames/save` — 保存多轨道自定义帧动画
- `POST /api/pet/frames/import-local` — 从本地路径或精灵表切帧抠图并导入
- `POST /api/pet/preview` — 触发控制台实时预览信号并导出预览文件
- `GET /api/pet/preview-html?id=<petId>&track=<track>` — 获取离线可交互 HTML 预览器
- `POST /api/pet/delete` — 删除自定义桌宠
- `GET /api/ext/pet/asset?id=<petId>&file=<filename>` — 安全读取位图素材

### 对话示例（让 Gemini 自动生图并预览）
在 Antigravity 对话框中直接输入：
> 「帮我调用生图画一只像素风明日方舟能天使（待机、思考、漫步、拖拽轨道），做好动画后预览给我看」

Gemini 会自动调用 `image-generator` 生成纯色背景规范精灵表 → 通过 `pet_slice_sprite_sheet` 切帧抠图并自检接触表 → 调用 `pet_create_frame_animation` 写入插件并联动控制台与离线 HTML 实时预览。

---

## 数据存储与安全边界

- **独立数据路径**（均位于 `~/.gemini/antigravity/plugin_data/agy-monitor/`）：
  - `pet_config.json` / `pet_status.json` — 扩展独立配置与伴侣心跳状态（不污染核心 `user_prefs.json` 与 `themes.json`）
  - `pets/` — 已保存的自定义桌宠图片与动画帧
  - `pet_previews/` — AI 切帧输出、接触表 PNG 与离线交互 HTML 预览文件
  - `bin/agy_desktop_pet.exe` / `bin/agy_desktop_pet_mac` — 独立预编译桌面宠程序（分别用于 Windows / macOS）
- **安全策略**：所有位图均进行真实文件头魔数校验（仅允许 PNG/JPEG/WEBP/GIF），严格拦截 SVG/XML 注入、路径穿越与 UNC 网络路径（`\\server\share`）。

---

## 禁用或移除扩展

- **临时禁用全部扩展**：启动前设置环境变量 `AGY_DISABLE_EXTENSIONS=1`，所有扩展路由、前端注入与 MCP 工具自动静默关闭。
- **彻底卸载桌宠功能**：直接删除 `sidecars/agy_monitor/extensions/desktop_pet/` 目录即可，主分支核心代码零报错。
