/**
 * md.ink — 应用逻辑
 *
 * 渲染管线（与参考页 debugpage 一致，且用最新版库）：
 *   输入 → debounce → markdown-it.render(html:true) → preview.innerHTML
 *        → MathJax.typesetPromise([preview])
 */
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";

/* ============================================================
 * Markdown 渲染管线
 * ============================================================ */

// markdown-it 会把 \( \[ \] \) 的反斜杠当作转义符删除，
// 导致 MathJax 看不到 \(...\) / \[...\] 定界符。
// 渲染前用占位符保护这四个反斜杠，渲染完再还原成 \。
const MATH_BS = "";

function renderDoc(src) {
  const protectedSrc = src.replace(/\\([\[\]()])/g, MATH_BS + "$1");
  const html = md.render(protectedSrc);
  return html.replaceAll(MATH_BS, "\\");
}

const md = new MarkdownIt({
  html: true, // 原生 HTML 直通：<tr> <br> <table> 等原样渲染（与参考页一致）
  linkify: true,
  typographer: true,
  quotes: "“”‘’",
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const value = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        return `<pre class="hljs"><code class="hljs language-${md.utils.escapeHtml(lang)}">${value}</code></pre>`;
      } catch (_) {
        /* 语言无效则回落到默认转义 */
      }
    }
    return ""; // 交给 markdown-it 默认 <pre><code> 转义
  },
});

// 给块级元素附加 data-line（源文档行号），供滚动同步使用。
// 复用参考页的机制：markdown-it token 的 .map 给出源行区间。
function annotateLine(tokens, idx, options, env, slf) {
  const token = tokens[idx];
  if (token.map && token.level === 0) {
    token.attrJoin("class", "line");
    token.attrSet("data-line", String(token.map[0]));
  }
}
function withLine(rule) {
  return function (tokens, idx, options, env, slf) {
    annotateLine(tokens, idx, options, env, slf);
    // 部分块级类型（paragraph_open / heading_open 等）没有显式规则，
    // 默认由 renderer.renderToken 兜底渲染（markdown-it v15 行为）。
    const render = rule || slf.renderToken.bind(slf);
    return render(tokens, idx, options);
  };
}
[
  "paragraph_open",
  "heading_open",
  "blockquote_open",
  "bullet_list_open",
  "ordered_list_open",
  "list_item_open",
  "table_open",
  "fence",
  "hr",
].forEach((name) => {
  md.renderer.rules[name] = withLine(md.renderer.rules[name]);
});

/* ============================================================
 * DOM
 * ============================================================ */

const app = document.getElementById("app");
const editor = document.getElementById("editor");
const preview = document.getElementById("preview");
const divider = document.getElementById("divider");
const btnTheme = document.getElementById("btnTheme");

/* ============================================================
 * 「格式化」按钮：HTML → 缩进美化；纯文本 → 清理多余空白
 * ============================================================ */

const VOID_TAGS = new Set([
  "br", "hr", "img", "input", "meta", "link", "area", "base", "col",
  "embed", "source", "track", "wbr",
]);

function looksLikeHtml(src) {
  return /<[a-zA-Z][a-zA-Z0-9]*(\s|>)/.test(src);
}

// 把（通常是粘贴来的单行/乱缩进）HTML 重排为 2 空格缩进的多行结构
function formatHtml(src) {
  const tokens = src.match(/<\/?[^>]*>|[^<]+/g) || [];
  const lines = [];
  let depth = 0;
  for (const tok of tokens) {
    if (tok.startsWith("</")) {
      depth = Math.max(0, depth - 1);
      lines.push("  ".repeat(depth) + tok);
    } else if (tok.startsWith("<")) {
      const m = tok.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/);
      const tag = m ? m[1].toLowerCase() : null;
      lines.push("  ".repeat(depth) + tok);
      // 自闭合 / 空元素不增加层级
      if (tag && !VOID_TAGS.has(tag) && !/\/\s*>$/.test(tok)) depth++;
    } else {
      // 标签之间的文本：压平多余空白，保留换行
      const text = tok.replace(/\s+/g, " ").trim();
      if (text) lines.push("  ".repeat(depth) + text);
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// 纯文本：去行尾空格、折叠 3 连以上空行为 2 连
function cleanText(src) {
  return (
    src
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

let statusTimer = null;
function flashStatus(msg) {
  const el = document.getElementById("tbStatus");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

document.getElementById("btnFormat").addEventListener("click", () => {
  const src = editor.value;
  if (!src.trim()) return;
  editor.value = looksLikeHtml(src) ? formatHtml(src) : cleanText(src);
  flashStatus(looksLikeHtml(src) ? "HTML 已美化" : "空白已清理");
  saveDraft();
  render();
});

/* ============================================================
 * 自动换行（默认开，记忆选择）
 * ============================================================ */

const WRAP_KEY = "md-editor.wrap";
let wrapOn = true;
try {
  wrapOn = localStorage.getItem(WRAP_KEY) !== "0";
} catch (_) {}

const btnWrap = document.getElementById("btnWrap");

function applyWrap() {
  editor.classList.toggle("nowrap", !wrapOn);
  btnWrap.classList.toggle("active", wrapOn);
  btnWrap.setAttribute("aria-pressed", String(wrapOn));
}

btnWrap.addEventListener("click", () => {
  wrapOn = !wrapOn;
  applyWrap();
  try {
    localStorage.setItem(WRAP_KEY, wrapOn ? "1" : "0");
  } catch (_) {}
});

applyWrap();

/* ============================================================
 * 一键复制：把编辑区全部内容写入剪贴板
 * ============================================================ */

const btnCopy = document.getElementById("btnCopy");

btnCopy.addEventListener("click", async () => {
  const text = editor.value;
  if (!text) {
    flashStatus("编辑器是空的");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    flashStatus("已复制全部内容");
  } catch (_) {
    // 降级：临时 textarea + execCommand（非安全上下文等场景）
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      flashStatus("已复制全部内容");
    } catch (_) {
      flashStatus("复制失败，请手动全选复制");
    }
    ta.remove();
  }
});

/* ============================================================
 * 粘贴：读取剪贴板并替换（清空）编辑区内容
 * ============================================================ */

const btnPaste = document.getElementById("btnPaste");

btnPaste.addEventListener("click", async () => {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (_) {
    flashStatus("无法读取剪贴板（权限或浏览器限制），请 Ctrl+V 粘贴");
    return;
  }
  if (!text) {
    flashStatus("剪贴板是空的");
    return;
  }
  editor.value = text;
  saveDraft();
  render();
  flashStatus("已替换为剪贴板内容");
});

/* ============================================================
 * 清空：清掉编辑区内容 + 已保存草稿（二次确认防误点）
 * ============================================================ */

const btnClear = document.getElementById("btnClear");
let clearArmed = false;
let clearTimer = null;

btnClear.addEventListener("click", () => {
  if (!clearArmed) {
    // 第一次点击：进入待确认状态，2.5s 内再点一次才真正清空
    clearArmed = true;
    btnClear.textContent = "确认清空？";
    btnClear.classList.add("danger");
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      clearArmed = false;
      btnClear.textContent = "清空";
      btnClear.classList.remove("danger");
    }, 2500);
    return;
  }
  clearArmed = false;
  clearTimeout(clearTimer);
  btnClear.textContent = "清空";
  btnClear.classList.remove("danger");
  editor.value = "";
  saveDraft();
  render();
  flashStatus("已清空");
});

/* ============================================================
 * 滚动同步开关（默认开，记忆选择）
 * ============================================================ */

const SYNC_KEY = "md-editor.sync";
let syncOn = true;
try {
  syncOn = localStorage.getItem(SYNC_KEY) !== "0";
} catch (_) {}

const btnSync = document.getElementById("btnSync");

function applySync() {
  btnSync.classList.toggle("active", syncOn);
  btnSync.setAttribute("aria-pressed", String(syncOn));
}

btnSync.addEventListener("click", () => {
  syncOn = !syncOn;
  applySync();
  try {
    localStorage.setItem(SYNC_KEY, syncOn ? "1" : "0");
  } catch (_) {}
});

applySync();

/* ============================================================
 * 渲染 + 公式排版
 * ============================================================ */

function render() {
  preview.innerHTML = renderDoc(editor.value);
  typeset();
}

const RENDER_DELAY = 150;
let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, RENDER_DELAY);
}

// MathJax v4 异步排版；只处理预览容器。
// MathJax 尚未加载时（typesetPromise 未就绪）跳过——加载完成后会自行排版首屏。
async function typeset() {
  try {
    if (window.MathJax?.typesetPromise) {
      await window.MathJax.typesetPromise([preview]);
    }
  } catch (err) {
    console.error("MathJax typeset failed:", err);
  }
}

/* ============================================================
 * 草稿自动保存（localStorage）
 * ============================================================ */

const DRAFT_KEY = "md-editor.draft";
const SAVE_DELAY = 400;
let saveTimer = null;

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, editor.value);
  } catch (_) {
    /* 隐私模式等场景下静默失败 */
  }
}

/* ============================================================
 * 分隔条：拖拽调整 + 双击复位 + 比例记忆
 * ============================================================ */

const SPLIT_KEY = "md-editor.split";
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

let ratio = 0.5;
try {
  const saved = parseFloat(localStorage.getItem(SPLIT_KEY));
  if (Number.isFinite(saved)) ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, saved));
} catch (_) {}

function applySplit() {
  app.style.setProperty("--split", ratio * 100 + "%");
}

function persistSplit() {
  try {
    localStorage.setItem(SPLIT_KEY, String(ratio));
  } catch (_) {}
}

let dragging = false;

divider.addEventListener("pointerdown", (e) => {
  dragging = true;
  divider.setPointerCapture(e.pointerId);
  divider.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  e.preventDefault();
});

divider.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const rect = app.getBoundingClientRect();
  ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, (e.clientX - rect.left) / rect.width));
  applySplit();
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  divider.classList.remove("dragging");
  document.body.style.cursor = "";
  persistSplit();
}

divider.addEventListener("pointerup", endDrag);
divider.addEventListener("pointercancel", endDrag);

divider.addEventListener("dblclick", () => {
  ratio = 0.5;
  applySplit();
  persistSplit();
});

/* ============================================================
 * 编辑 ↔ 预览 滚动同步（data-line 锚点）
 * ============================================================ */

const lineHeight = 22; // 与 CSS 中 #editor 的 line-height 保持一致
let syncing = false;

// 编辑区可视顶部对应的源行号（textarea 无换行，行号 = scrollTop / 行高）
function editorTopLine() {
  return Math.floor(editor.scrollTop / lineHeight);
}

// 找到源行号 ≤ line 的最后一个锚点元素（预览中最近的对应位置）
function previewAnchorAt(line) {
  let best = null;
  for (const el of preview.querySelectorAll("[data-line]")) {
    const n = parseInt(el.dataset.line, 10);
    if (n <= line) best = el;
    else break;
  }
  return best;
}

// 自动换行时行号与像素不再一一对应，改用比例映射（双向都稳）
function proportionalSync() {
  const maxE = editor.scrollHeight - editor.clientHeight;
  const maxP = preview.scrollHeight - preview.clientHeight;
  if (maxE <= 0 || maxP <= 0) return;
  const ratio = editor.scrollTop / maxE;
  const target = ratio * maxP;
  if (Math.abs(preview.scrollTop - target) > 2) preview.scrollTop = target;
}

function syncEditorToPreview() {
  if (wrapOn) return proportionalSync();
  const el = previewAnchorAt(editorTopLine());
  if (!el) return;
  const target = el.offsetTop - preview.clientHeight * 0.15;
  if (Math.abs(preview.scrollTop - target) > 2) {
    preview.scrollTop = target;
  }
}

function syncPreviewToEditor() {
  if (wrapOn) {
    const maxP = preview.scrollHeight - preview.clientHeight;
    const maxE = editor.scrollHeight - editor.clientHeight;
    if (maxP <= 0 || maxE <= 0) return;
    const target = (preview.scrollTop / maxP) * maxE;
    if (Math.abs(editor.scrollTop - target) > 2) editor.scrollTop = target;
    return;
  }
  let line = null;
  for (const el of preview.querySelectorAll("[data-line]")) {
    if (el.offsetTop >= preview.scrollTop) {
      line = parseInt(el.dataset.line, 10);
      break;
    }
  }
  if (line == null) return;
  const target = line * lineHeight;
  if (Math.abs(editor.scrollTop - target) > 2) {
    editor.scrollTop = target;
  }
}

// syncing 标志阻断"程序滚动 → scroll 事件 → 反向程序滚动"的反馈环
editor.addEventListener("scroll", () => {
  if (syncing || !syncOn) return;
  syncing = true;
  syncEditorToPreview();
  requestAnimationFrame(() => {
    syncing = false;
  });
});

preview.addEventListener("scroll", () => {
  if (syncing || !syncOn) return;
  syncing = true;
  syncPreviewToEditor();
  requestAnimationFrame(() => {
    syncing = false;
  });
});

/* ============================================================
 * 亮 / 暗主题
 * 初始 data-theme 已由 index.html 的内联脚本在首屏前设置。
 * ============================================================ */

const THEME_KEY = "md-editor.theme";

btnTheme.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (_) {}
});

// 未手动选过主题时，跟随系统变化
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", (e) => {
    try {
      if (!localStorage.getItem(THEME_KEY)) {
        document.documentElement.dataset.theme = e.matches ? "dark" : "light";
      }
    } catch (_) {}
  });

/* ============================================================
 * 初始化
 * ============================================================ */

applySplit();

try {
  const draft = localStorage.getItem(DRAFT_KEY);
  if (draft != null) editor.value = draft;
} catch (_) {}

render();

// MathJax 兜底：若初次渲染时 CDN 尚未就绪，等就绪后补排版一次，
// 避免出现"粘贴了 \(\times\) 却一直显示原始文本"的情况。
(function ensureMathJaxTypeset() {
  if (window.MathJax?.startup?.promise) {
    window.MathJax.startup.promise.then(() => typeset()).catch(() => {});
  } else {
    setTimeout(ensureMathJaxTypeset, 300);
  }
})();

editor.addEventListener("input", () => {
  scheduleRender();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, SAVE_DELAY);
});
