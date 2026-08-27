# md.ink — Cloudflare Worker Markdown 编辑器

左写右看、满视口、无 banner 的 Markdown 编辑器：左侧编辑、右侧实时预览，中间分隔条可拖拽（双击复位 50/50）。

## 功能

- **原生 HTML 兼容**：`<tr>`、`<br>`、`<table>` 等原样透传渲染（markdown-it `html: true`）
- **数学公式**：MathJax v4，支持 `\(...\)` `$...$`（行内）与 `$$...$$` `\[...\]`（块级）
- **格式化渲染**：标题 / 表格 / 引用 / 列表 / 代码块等
- **代码上色**：highlight.js 按语言高亮
- **滚动同步**：编辑区与预览区按行联动
- **亮 / 暗主题**：跟随系统，右下角小按钮手动切换（记忆选择）
- **草稿自动保存**：localStorage，刷新自动恢复
- **无 banner**：满视口双栏，唯一 UI 是分隔缝与主题按钮

## 技术栈

- Cloudflare **Workers Assets**（`wrangler.jsonc` 配置，`not_found_handling: single-page-application`）
- markdown-it v15（html:true + typographer + 自定义 highlight）
- MathJax v4（`mathjax@4/tex-chtml.js`，CDN 加载）
- highlight.js v11（打包进 bundle）
- 字体：自托管 JetBrains Mono / Source Serif 4（variable woff2，随 Worker 分发，**不依赖 Google Fonts**，国内可达）；中文回落到系统字体（微软雅黑）
- 前端资源由 esbuild 打包，部署后无构建依赖

## 开发

```bash
npm install          # 首次
npm run build        # esbuild: src/app.js → public/app.js
npm run dev          # 构建 + wrangler dev（http://localhost:8787）
```

本地冒烟测试（需先启动 dev 服务器，用本机 Edge/Chrome 无头验证）：

```bash
npx wrangler dev --port 8787
node scripts/verify.mjs
```

## 部署

```bash
npm run deploy       # 构建 + wrangler deploy（需先 wrangler login）
```

默认域名 `https://md-editor-ink.<你的子域>.workers.dev`。若名称被占用，改 `wrangler.jsonc` 里的 `name`。

## 目录结构

```
├── wrangler.jsonc       # Worker 配置（Assets + SPA 回退）
├── package.json         # scripts: build / dev / deploy
├── src/
│   ├── index.js         # Worker 入口（/api/health + env.ASSETS.fetch）
│   └── app.js           # 应用源码（渲染管线 / 滚动同步 / 拖拽 / 主题 / 草稿）
├── public/              # Workers Assets 目录（直接分发）
│   ├── index.html       # SPA 壳 + MathJax v4 配置
│   ├── app.css          # 设计系统（亮/暗主题、预览排版、代码高亮）
│   └── app.js           # esbuild 构建产物（勿手改）
└── scripts/verify.mjs   # 端到端冒烟测试
```

## 安全说明

`html: true` 会原样透传任意 HTML。这是支持 `<tr>` 等原生标签的代价：**请只在可信内容上使用本工具**。若日后要公开给他人粘贴内容，需加 DOMPurify 白名单消毒（会损失部分原生 HTML 能力）。
