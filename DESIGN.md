# Cloudflare Worker Markdown 编辑器 — 设计文档

> 状态：设计阶段（尚未写代码）｜日期：2026-08-27

## 1. 项目概述

在 Cloudflare Workers 上部署一个**纯前端**的 Markdown 编辑/预览网页应用：

- 左侧编辑、右侧实时预览，中间分隔条**可拖拽调整**宽度
- 无顶部 banner、无多余 UI，最大化利用视口空间
- 原生兼容 HTML 语法（`<tr>`、`<br>`、整段 `<table>` 等直接透传）
- 完整支持数学公式（`\(...\)`、`$...$`、`$$...$$`、`\[...\]`）
- Markdown 格式化渲染（标题、加粗、列表、表格、引用、代码块、行内代码等），代码块**语法高亮**
- 编辑区与预览区**滚动同步**联动

所有渲染在**浏览器端**完成，Worker 只负责把单页应用（HTML/CSS/JS）分发出去。这也意味着部署后几乎零服务端成本、无数据库依赖，个人使用完全免费额度内。

---

## 2. 参考页分析（debugpage）

用户提供的离线参考页 `第一批-ocr困难样本标注-赛柯思 1 Round QA.html`（一个 Vue 构建的 OCR 标注工具）经逆向分析，其 Markdown 渲染方案如下，**本项目的技术路线以它为准**：

| 组件 | 参考页实现 | 关键点 |
|---|---|---|
| Markdown 解析 | **markdown-it** | 配置 `{ html: true, typographer: true, quotes: "“”‘’", highlight: ... }` |
| 原生 HTML 支持 | 由 `html: true` 开启 | 这是 `<tr>`、`<br>`、`<table>` 等原生 HTML 能直接渲染的根本原因 |
| 数学公式 | **MathJax 3**（`tex-chtml.js`，来自 jsdelivr CDN） | `window.MathJax = { tex: { inlineMath: [["$","$"], ["\\(","\\)"]] } }` |
| 公式刷新 | 渲染后调 `MathJax.typesetPromise([previewEl])` | 只重排版预览容器，不整页扫描 |
| 代码高亮 | prism 系 | markdown-it 的 `highlight` 回调返回高亮后的 HTML |
| 滚动同步 | markdown-it 自定义 renderer 规则 | 给段落/标题附加 `data-line`，编辑区↔预览区按行号联动滚动 |
| 编辑框 | `<textarea>` | 简单可靠，无重型编辑器依赖 |

**参考页渲染流程**（本项目照搬这个管线）：

```
textarea 输入
   │  debounce 防抖（约 200ms）
   ▼
markdown-it.render(text)   // html:true → 输出含原生 HTML
   ▼
previewDiv.innerHTML = html
   ▼
MathJax.typesetPromise([previewDiv])   // 公式排版
```

---

## 3. 技术选型

### 3.1 Worker 架构：单 Worker 静态分发

采用**经典单 Worker 模式**：一个 `src/index.js` 作为路由入口，把 `public/` 下的静态资源（HTML/CSS/JS）作为 `Response` 返回。不引入 KV / Durable Objects / Pages Assets，把复杂度压到最低。

```
请求 GET /
  └─ Worker 路由
       ├─ /        → index.html（SPA 壳）
       ├─ /app.js  → 打包后的应用 JS（含 markdown-it 等）
       └─ /app.css → 应用样式
```

为什么不用别的：
- **Pages + `_worker.js`**：功能相同但配置更多，无收益
- **Workers Assets**：较新特性，生态/文档仍偏新，先保持经典模式，日后可平滑迁移
- **Durable Objects / KV 存文档**：用户未要求服务端持久化，v1 不引入（见 §4.4 扩展）

### 3.2 库选型（对照参考页）

| 用途 | 选型 | 理由 / 与参考页对照 |
|---|---|---|
| Markdown 解析 | **markdown-it**（默认 preset） | 与参考页一致；默认 preset 已含 table、strikethrough 等格式化能力；`html: true` 复刻原生 HTML 兼容 |
| 数学公式 | **MathJax 4** `tex-chtml.js` | 参考页用的 v3（含 `/es5`）已过时；v4 用 `mathjax@4/tex-chtml.js`，配置兼容，原生支持 `\(...\)`、`\[...\]`、`$...$`、`$$...$$` |
| 代码高亮 | **highlight.js** | 在 markdown-it `highlight` 回调里返回 `hljs.highlight(code, {language}).value`；比 prism 接入更简单 |
| 编辑器 | **原生 `<textarea>`** | 与参考页一致；零依赖、最省空间 |
| 样式 | 手写 CSS（无框架） | 极简，不用 antd（参考页用 antd 是因为它是标注工具） |
| XSS 防护 | **默认关闭** | 见 §4.5 安全说明 |

### 3.3 依赖加载策略

- **打包进 Worker**（本地 esbuild 打包成 `/app.js`）：markdown-it、highlight.js、应用自身逻辑。离线可开发调试，部署后不依赖第三方 CDN。
- **运行时 CDN 加载**：仅 MathJax（`https://cdn.jsdelivr.net/npm/mathjax@4/tex-chtml.js`）。原因：MathJax 体积大且依赖一批 woff 数学字体，打包进 Worker 会显著增大资产；CDN 加载可保持 Worker 小巧。MathJax 加载前页面照常可用（公式先显示为源码文本，加载完成后自动排版）。

---

## 4. 功能需求

### 4.1 P0 — 核心（本次实现）

| # | 功能 | 说明 |
|---|---|---|
| F1 | 左编辑 / 右预览 | 等宽分割，编辑区 `<textarea>`，预览区滚动容器 |
| F2 | 可拖拽分隔条 | 拖中间分隔条调整左右宽度，松开记忆比例；**双击分隔条复位 50/50**；比例存 localStorage |
| F3 | 实时预览（防抖） | 输入后 ~200ms 防抖渲染；预览区滚动条独立滚动 |
| F4 | 原生 HTML 兼容 | `html: true`，`<tr>`、`<br>`、`<table>`、任意标签透传渲染 |
| F5 | 数学公式 | `\(...\)` `$...$` 行内 + `$$...$$` `\[...\]` 块级；渲染后 `typesetPromise` 刷新 |
| F6 | 格式化文本 | 标题/粗斜体/列表/引用/表格/代码块/行内代码/分隔线/链接/图片 |
| F7 | 无 banner 极简布局 | 满视口（100vh），无顶部栏、无多余按钮，仅有拖拽分隔条 |
| F8 | 本地草稿自动保存 | 输入内容存 localStorage，刷新/重开自动恢复 |
| F9 | 亮 / 暗主题 | 默认跟随 `prefers-color-scheme`；页面内极小开关手动切换，不占 banner |
| F10 | 编辑↔预览滚动同步 | 复刻参考页 `data-line` 机制：段落/标题带行号锚点，编辑区滚动时预览区跟随到对应行（反之亦然） |
| F11 | 代码上色 | 代码块按语言语法高亮（highlight.js），含行内代码与围栏代码块 |

### 4.2 明确不做（v1）

- 不做服务端渲染 / 服务端 Markdown 处理 —— 全部客户端渲染
- 不做登录、账号、多用户
- 不做富文本工具栏 —— 用户核心诉求是"最大化界面空间"+"Markdown 原生态"
- 不做所见即所得 —— 编辑/预览分离正是用户要求
- 不做代码块复制按钮、富文本工具栏等额外增强 —— 按用户要求，功能范围以 §4.1 P0 清单为准（编辑/预览 + 公式 + HTML 兼容 + 格式化 + 亮暗主题 + 滚动同步 + 代码上色）
- 不做服务端持久化、分享链接、PDF 导出、文件导入/导出、编辑器升级（CodeMirror）、公式引擎替换（KaTeX）—— 均为未来可能项，本期不实现

### 4.3 安全说明（重要）

参考页 `html: true` 意味着原始 HTML 会原样进 DOM。本项目**默认不消毒（不引入 DOMPurify）**，以完整复刻参考页的原生 HTML 兼容性 —— 这对粘贴含 `<table>/<tr>` 的 OCR 标注内容是刚需。

- 使用场景为**个人笔记/本地工具**时无风险（内容即用户自己输入的）
- 若日后公开分享该站点给他人使用、允许他人粘贴任意内容，存在 XSS 风险 → 届时增加"安全模式"开关：用 **DOMPurify** 白名单消毒（默认保留 `table/tr/td/th` 等标签），但需说明该模式会丢弃部分脚本类标签
- 该开关默认关闭，不影响 F4 原生 HTML 兼容

---

## 5. UI/UX 设计

### 5.1 布局

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┌──────────────────────┬║┬──────────────────────────────┐  │
│  │                      │║│                              │  │
│  │    编辑器 (textarea)  │║│   预览 (markdown-preview)   │  │
│  │    等宽字体           │║│   styled 渲染结果           │  │
│  │                      │║│                              │  │
│  │                      │║│                              │  │
│  └──────────────────────┴║┴──────────────────────────────┘  │
│                          ║  ← 可拖拽分隔条（双击复位 50/50）  │
└─────────────────────────────────────────────────────────────┘
       100vh 满视口，无任何 banner / 头部 / 脚部
```

- 编辑区：等宽字体（自托管 **JetBrains Mono Variable**，中文回落微软雅黑），浅底色与预览区分；行内 padding 18px
- 预览区：正文 **Source Serif 4 Variable**（拉丁/数字衬线）+ 微软雅黑（中文），复用参考页 `markdown-preview` 样式骨架（表格边框、斑马纹、引用块、代码块背景、标题层级）
- 分隔条：宽 ~6px，hover 时高亮（主题色），cursor: col-resize
- 宽度比例：localStorage 存 `splitRatio`（默认 0.5），拖拽时用 `pointermove` 更新（节流 ~60fps），松手写入存储

### 5.2 交互细节

| 交互 | 行为 |
|---|---|
| 拖分隔条 | 左/右宽度按比例变化，最小宽度 20%，防止拖没 |
| 双击分隔条 | 复位 50/50 |
| 键盘 | 无自定义快捷键（v1），Tab 键默认输入即可 |
| 主题 | 默认跟随 `prefers-color-scheme`；页面内极小开关手动切换，存 localStorage |
| 滚动同步 | 编辑区滚动 → 预览跟随到对应行（反之亦然）；基于 markdown-it 渲染时附加的 `data-line` 锚点，可开关 |
| 代码上色 | markdown-it `highlight` 回调里用 highlight.js 给代码块上色，未识别语言走默认样式 |
| 草稿 | 每次输入 debounce 写入 localStorage；首次打开若有草稿直接载入 |

### 5.3 页面 `<head>` 要点

- `<title>`：简洁名称（如 "MD Editor"）
- 无 meta 花活；`<meta name="viewport">` 适配窄屏（窄屏时两栏可改为上下堆叠或保持左右 + 横向滚动——v1 保持左右，最小宽度用百分比兜底）

---

## 6. 目录结构

```
md-editor-worker/
├── DESIGN.md              # 本文档
├── README.md              # 使用 / 开发 / 部署说明
├── wrangler.jsonc         # Worker 配置（推荐格式：name / main / compatibility_date / assets）
├── package.json           # scripts: build(esbuild) / dev(wrangler dev) / deploy
├── src/
│   ├── index.js           # Worker 入口：/api/health + env.ASSETS.fetch（Assets binding）
│   └── app.js             # 应用源码：渲染管线 / 滚动同步 / 拖拽 / 主题 / 草稿
├── public/                # Workers Assets 目录（直接分发）
│   ├── index.html         # SPA 壳（结构 + 主题预置 + MathJax v4 CDN）
│   ├── app.css            # 设计系统：布局 / 分隔缝 / 预览排版 / 亮暗主题 / 代码高亮
│   └── app.js             # esbuild 构建产物（勿手改，由 npm run build 生成）
└── scripts/verify.mjs     # 端到端冒烟测试（playwright-core + 本机 Edge/Chrome）
```

> 注：若采用 wrangler 内置打包，`app.js` 可通过 esbuild 在 `wrangler dev/deploy` 时由 `public/index.html` 引用的入口 bundle 生成；最终形态在编码阶段定稿，上面是目标结构。

---

## 7. 开发环境搭建

本机已确认就绪（无需再安装）：

```
node     v24.18.1   ✓
npm      11.16.0    ✓
wrangler 4.126.0    ✓（npx wrangler）
```

**本地调试**（Worker 网站开发标准流程）：

```bash
cd md-editor-worker
npm install -D wrangler          # 若未安装则安装；已具备则跳过
npx wrangler dev                 # 启动本地开发服务器 http://localhost:8787
```

- `wrangler dev` 提供热重载，浏览器直接打开 `localhost:8787` 即可调试；无浏览器时也可 `curl localhost:8787/` 验证 Worker 返回 HTML
- MathJax 走 CDN，本地开发需联网；其余全部本地打包，无网络也能渲染 Markdown

**部署**（需要 Cloudflare 账号，用户确认后再执行）：

```bash
npx wrangler login                # 浏览器授权
npx wrangler deploy               # 发布到 workers.dev
```

---

## 8. 部署方案

- 账号：用户个人 Cloudflare 账号（需登录授权）
- 域名：默认 `https://<worker-name>.<subdomain>.workers.dev`，后续可绑自定义域名
- 免费额度：个人使用完全够（每日 10 万请求）
- 无后台数据库，无需任何环境变量/Secret

---

## 9. 实施里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| M0 | 搭建骨架：wrangler.jsonc + Worker 路由 + 静态壳 | `wrangler dev` 打开页面显示空编辑器/预览两栏 |
| M1 | 渲染管线：markdown-it（html:true）+ 防抖实时预览 | 输入 Markdown 即时渲染；`<table><tr>` 原生显示 |
| M2 | MathJax 接入：CDN 加载 + typesetPromise 刷新 | `\(\time\)`、`$x^2$`、`$$...$$` 正确显示为公式 |
| M3 | 布局与交互：满视口、无 banner、拖拽分隔条、双击复位、比例记忆 | 拖拽流畅；刷新后比例保持 |
| M4 | 完成度：格式化样式 + 代码上色 + 滚动同步 + 亮/暗主题 + 草稿保存 | 代码块按语言高亮；滚动联动正常；表格/引用/代码块样式美观；主题切换正常；刷新恢复内容 |
| M5 | 部署：`wrangler login` + `wrangler deploy` | 线上 URL 可访问，功能一致 |

---

## 10. 风险与注意事项

| 风险 | 影响 | 对策 |
|---|---|---|
| `html: true` 的 XSS 面 | 若公开给他人粘贴内容存在注入风险 | 默认个人使用无碍；文档明确标注，后续可加 DOMPurify 开关（§4.5） |
| MathJax 依赖 jsdelivr CDN | CDN 故障时公式不排版 | 公式源码仍可见、Markdown 不受影响；可后续自托管 MathJax 到 Worker |
| 超大文档性能 | 整篇重渲染 + MathJax 重排版可能卡顿 | debounce 200ms；必要时再评估增量渲染 |
| 本地 dev 需要联网 | 拉取 MathJax CDN 需网络 | 其余逻辑离线可用；可自托管规避 |
| 窄屏体验 | 左右分栏在手机上偏挤 | v1 保持左右分栏（个人桌面工具），后续可加窄屏堆叠 |

---

*参考：离线网页 `../debugpage/第一批-ocr困难样本标注-赛柯思 1 Round QA.html`（markdown-it + html:true + MathJax3 tex-chtml + prism 高亮 + data-line 滚动同步）*
