# AGY 控制台 (`agy-monitor`)

> 为 **Antigravity** 打造的零侵入侧边栏控制台插件：集 **实时遥测与配额分析（通用）**、**多 Agent 协作网与类 Codex 历程追踪（掌握）**、**撞色主题与整机壁纸/输入框圆环 HUD（美化）** 于一体。
>
> **零外部 npm 依赖** · **不修改 Antigravity 核心文件（`app.asar` / `config.json`）** · **开箱即用，改动自动保存**

---

## 核心功能

### 1. 通用（Telemetry & Sessions）
- **实时上下文饼图**：拆解系统底座、规则附加、对话历史与工具输出占比，支持 `256k / 512k / 1M` 窗口上限切换。
- **Token 消耗与 5h 配额估算**：按今日/7天/30天统计当前会话与全局各模型消耗，自动估算参考 API 费用与 5 小时配额余量。
- **实时生成速率与真实模型对照**：展示实时/平均 `tok/s`、Prompt Cache 缓存命中率，以及上游真实返回模型与前端选定模型的一致性核验。
- **会话管理与 Prompt 规则**：支持跟随最新会话/锁定会话、活动/未读/收藏会话一键切换，内置多套 Prompt 规则与自定义 Markdown 规则（带安全校验）。
- 
<img width="1920" height="1080" alt="cfe47dc0153eabfd1e7e2512c6199019" src="https://github.com/user-attachments/assets/f45a5312-cacb-4816-a047-f77c683f0cf0" />

### 2. 掌握（Multi-Agent Mastery）
- **会话进程总览**：按活动运行中、任务结束未读（翠绿）、任务结束已读（沉静灰）清晰分层，右侧进度环实时同步主 Agent 进度。
- **主次协作关系网**：自动读取本地 `subagents` / `swarm` / `messages` 数据，可视化呈现左主右次协作拓扑、主次往来箭头与次级协作连线。
- **类 Codex 内容历程**：点击任意主/次 Agent 即可进入多轮完整历程（运行中补充消息不清空历史），自动分类折叠操作组（运行了命令 / 编辑了文件 `+add -del` / 读取了文件 / 检索了资料 / 协同了子 Agent），支持安全 Markdown 渲染与文件芯片悬停预览。
- **双模式定时总结（默认关闭 · 按需开启）**：
  - **自身模型模式（每分钟 · 思维低）**：开启后通过官方 `PreInvocation` Hook 仅在尾部轻量化追加提示，几乎不破坏原会话 KV 缓存命中率；自动输出约 30 字开场思考与 10 字以内通俗进度总结；关闭后立即生效。
  - **第三方模型模式**：支持 OpenAI / Anthropic 双协议自定义接口、本机保存 API Key、实时拉取 `/models` 与连通测速。

<img width="1920" height="1080" alt="91061725f97fd1d4087d2f940c8c2fba" src="https://github.com/user-attachments/assets/2294b5e6-d128-41d6-96fe-4483f32cc8af" />
<img width="1920" height="1080" alt="77423415c71d65d4cfba6332449db742" src="https://github.com/user-attachments/assets/38066d89-9ad9-4fb1-9163-c2bfa0466fb5" />
<img width="836" height="420" alt="7a51323271d83629f0c8e4796d1ca484" src="https://github.com/user-attachments/assets/dbf75067-ef77-415d-99ad-52062f2e4b8d" />


### 3. 美化（Theme & Backdrop Studio）
- **撞色主题引擎**：内置「极昼原版」等 5 套精选方案，支持 6 项核心色自定义、方案保存、随宿主明暗自动反色。
- **图片壁纸 & Windows 整机壁纸**：内置 5 张高清壁纸（默认启用「星海夜行电车」），支持自定义上传图片、透明度/模糊度/暗度遮罩/圆角调节；Windows 下自动通过系统自带 `.NET` 编译轻量伴侣程序，提供 **方案一：贴背微透（默认 25%）**、**方案二：CDP 高清纯 CSS** 以及 **输入框上下文圆环 + 实时速度悬浮 HUD**（自动适配双屏多 DPI）。

<img width="1920" height="1080" alt="ff9e0805cd6335cbb0a53afd3a58fc51" src="https://github.com/user-attachments/assets/d69f30ed-d0e4-417b-889b-2e02ed64dec6" />


---

## 最简单安装方式（三选一）

> **运行环境**：只需已安装 **Node.js >= 22.5.0**（Windows 双击安装器若检测到缺失会自动提示通过 `winget` 一键装好，无需手动配置）。

### 方式一：下载 Release 压缩包，双击即装（推荐 · 最无脑）

1. 前往 [Releases 最新版本页面](https://github.com/aishadiaodeqishui/agy-monitor/releases/latest) 下载 `agy-monitor-v*.zip` 并解压到任意文件夹。
2. 运行安装器：
   - **Windows**：直接双击根目录的 **`install.cmd`**
   - **macOS / Linux**：终端进入解压目录执行 `chmod +x install.sh && ./install.sh`
3. 打开 **Antigravity** -> 左侧 **Customizations -> Plugins** -> 打开 **「AGY 控制台 (`agy-monitor`)」** 开关即可使用！

### 方式二：终端一行命令安装（无需手动下载）

- **Windows (PowerShell)**：
  ```powershell
  irm https://raw.githubusercontent.com/aishadiaodeqishui/agy-monitor/main/scripts/install.ps1 | iex
  ```
- **macOS / Linux**：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/aishadiaodeqishui/agy-monitor/main/install.sh | bash
  ```

### 方式三：Git Clone 安装（开发者）

```bash
git clone https://github.com/aishadiaodeqishui/agy-monitor.git
cd agy-monitor
node scripts/install.mjs
```

---

## 默认设置与自动保存

首次安装即自动启用以下精选默认配置，**你在界面中做的任何改动都会实时自动保存到本机 `~/.gemini/antigravity/plugin_data/agy-monitor/`，升级插件也不会丢失**：

- **通用**：简体中文、512k 上下文窗口上限、自动跟随最新会话
- **掌握**：定时总结默认关闭（可随时一键开启「自身模型」或「第三方模型」）、操作分组默认收起
- **美化**：极昼原版配色、壁纸「星海夜行电车」（透明度 100% / 模糊 0px / 暗度 0% / 圆角 10px / 铺满裁剪）、Windows 整机壁纸方案一（透显度 25%）与输入框圆环 HUD 开启

---

## 升级与卸载

- **升级**：重新运行 `install.cmd` / `./install.sh` / `node scripts/install.mjs` 即可覆盖升级，个人配置与 Prompt 规则完整保留。
- **卸载**：
  - **Windows**：双击 **`uninstall.cmd`**（或运行 `node scripts/uninstall.mjs`）
  - **macOS / Linux**：运行 `chmod +x uninstall.sh && ./uninstall.sh`
  - 默认保留你的个人配置与自定义壁纸目录；如需彻底清除数据，执行 `node scripts/uninstall.mjs --purge-data`。

---

## 开发与打包发布

```bash
# 运行全量单元测试（零外部依赖）
npm test

# 同步当前源码到本机 Antigravity 插件目录
npm run sync

# 打包可直接上传 GitHub Releases 的独立 ZIP（输出到 dist/）
npm run pack
```

---

## 零侵入安全说明

- 严格遵守 Antigravity 官方插件规范，仅安装在 `~/.gemini/config/plugins/agy-monitor`。
- **绝不修改** Antigravity 安装目录、`app.asar` 或宿主 `~/.gemini/config/config.json`。
- 所有本地会话与数据库均以只读方式读取，所有第三方 API Key 仅保存在本机 `plugin_data` 目录，绝不上传或外传。

## 社区支持

https://linux.do
