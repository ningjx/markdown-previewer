/**
 * md.ink — 应用逻辑
 *
 * 渲染管线（与参考页 debugpage 一致，且用最新版库）：
 *   CodeMirror 输入 → debounce → markdown-it.render(html:true) → preview.innerHTML
 *        → MathJax.typesetPromise([preview])
 *
 * 编辑器为 CodeMirror 6（Markdown + 内嵌 HTML 语法高亮，支持 fenced 代码块高亮）。
 */
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, keymap, placeholder, drawSelection } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  HighlightStyle,
  LanguageDescription,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { tags } from "@lezer/highlight";
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

// 未标注语言的代码块，用 highlight.js 自动检测；收窄候选集以减少误判
const AUTO_LANGS = [
  "python", "javascript", "typescript", "sql", "json", "xml", "bash", "shell",
  "java", "c", "cpp", "go", "rust", "css", "scss", "markdown", "yaml", "ini",
  "php", "ruby", "swift", "kotlin", "lua",
];

const md = new MarkdownIt({
  html: true, // 原生 HTML 直通：<tr> <br> <table> 等原样渲染（与参考页一致）
  linkify: true,
  typographer: true,
  quotes: "“”‘’",
  highlight(code, lang) {
    let value = "";
    let usedLang = "";
    try {
      if (lang && hljs.getLanguage(lang)) {
        // 显式标注且库中存在的语言 → 精确高亮
        usedLang = lang;
        value = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } else if (!lang) {
        // 未标注语言 → 自动检测；中文/普通文本会返回纯文本，不误上色
        const res = hljs.highlightAuto(code, AUTO_LANGS, { ignoreIllegals: true });
        usedLang = res.language || "";
        value = res.value;
      } else {
        // 标注了库中不存在的语言 → 交给默认转义
        return "";
      }
    } catch (_) {
      return "";
    }
    return `<pre class="hljs"><code class="hljs language-${md.utils.escapeHtml(usedLang)}">${value}</code></pre>`;
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
const editorEl = document.getElementById("editor");
const preview = document.getElementById("preview");
const divider = document.getElementById("divider");
const btnTheme = document.getElementById("btnTheme");

/* ============================================================
 * 渲染 + 公式排版
 * ============================================================ */

function render() {
  preview.innerHTML = renderDoc(getValue());
  typeset();
}

const RENDER_DELAY = 150;
let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, RENDER_DELAY);
}

// MathJax v4 异步排版；只处理预览容器。
// MathJax 尚未加载时（typesetPromise 未就绪）跳过——就绪兜底见 init 末尾。
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
    localStorage.setItem(DRAFT_KEY, getValue());
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
 * CodeMirror 编辑器
 * ============================================================ */

const PLACEHOLDER_TEXT =
  "在这里书写 Markdown…\n\n" +
  "原生 HTML（如 <table><tr><td>…</td></tr></table>）与数学公式" +
  "（\\(E=mc^2\\)、$x^2$、$$x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$$）都会实时渲染。\n\n" +
  "粘贴 HTML 后点上方「格式化」可自动排版。";

// 编辑器 token 颜色走 CSS 变量（.tok-* 类），亮/暗主题随 data-theme 自动切换
const editorHighlighter = HighlightStyle.define([
  { tag: tags.keyword, class: "tok-keyword" },
  { tag: [tags.string, tags.regexp], class: "tok-string" },
  { tag: [tags.number, tags.bool, tags.atom], class: "tok-number" },
  { tag: tags.comment, class: "tok-comment" },
  { tag: [tags.typeName, tags.className, tags.namespace], class: "tok-type" },
  { tag: [tags.propertyName, tags.attributeName], class: "tok-attr" },
  { tag: tags.function(tags.variableName), class: "tok-func" },
  { tag: [tags.tagName, tags.angleBracket], class: "tok-tag" },
  { tag: [tags.variableName, tags.definition(tags.variableName)], class: "tok-var" },
  { tag: tags.strong, class: "tok-strong" },
  { tag: tags.emphasis, class: "tok-em" },
  { tag: tags.strikethrough, class: "tok-del" },
  { tag: tags.heading, class: "tok-heading" },
  { tag: [tags.link, tags.url], class: "tok-link" },
  { tag: tags.quote, class: "tok-quote" },
  { tag: tags.monospace, class: "tok-code" },
  { tag: [tags.meta, tags.processingInstruction], class: "tok-meta" },
]);

// fenced 代码块在编辑区内的语言支持（首批：JS/Python）
const editorCodeLangs = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "javascript", "jsx"],
    support: javascript(),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py", "python"],
    support: python(),
  }),
];

let view;

function getValue() {
  return view.state.doc.toString();
}

function setValue(text) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
}

// 编辑器内容变化 → 防抖渲染 + 定时存草稿
const updateListener = EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    scheduleRender();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, SAVE_DELAY);
  }
});

function baseExtensions() {
  return [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    indentOnInput(),
    bracketMatching(),
    drawSelection(),
    updateListener,
    markdown({ htmlTagLanguage: html(), codeLanguages: editorCodeLangs }),
    syntaxHighlighting(editorHighlighter),
    placeholder(PLACEHOLDER_TEXT),
  ];
}

function createEditor(initialDoc) {
  view = new EditorView({
    parent: editorEl,
    state: EditorState.create({
      doc: initialDoc,
      extensions: baseExtensions(),
    }),
  });
  // 供测试/调试读取与写入
  window.__md = { get: getValue, set: setValue };
  // 自托管字体加载完成后重测布局，避免行高错位
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => view.requestMeasure()).catch(() => {});
  }
}

/* ============================================================
 * 编辑 ↔ 预览 滚动同步（data-line 锚点，CodeMirror 精确行定位）
 * ============================================================ */

let syncing = false;

const lineHeight = 22; // 与 CSS 中 .cm-scroller 的 line-height 一致（仅供预览侧参考）

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

function syncEditorToPreview() {
  // CodeMirror 视口顶部可视行（自动换行时也是正确的视觉行）
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
  const lineNo = view.state.doc.lineAt(block.from).number; // 1 基源行号
  const anchor = previewAnchorAt(lineNo - 1);
  if (!anchor) return;
  const target = anchor.offsetTop - preview.clientHeight * 0.15;
  if (Math.abs(preview.scrollTop - target) > 2) {
    preview.scrollTop = target;
  }
}

function syncPreviewToEditor() {
  let line = null;
  for (const el of preview.querySelectorAll("[data-line]")) {
    if (el.offsetTop >= preview.scrollTop) {
      line = parseInt(el.dataset.line, 10);
      break;
    }
  }
  if (line == null) return;
  if (line < 0 || line >= view.state.doc.lines) return;
  const docLine = view.state.doc.line(line + 1); // data-line 是 0 基，doc.line 是 1 基
  const block = view.lineBlockAt(docLine.from);
  if (Math.abs(view.scrollDOM.scrollTop - block.top) > 2) {
    view.scrollDOM.scrollTop = block.top;
  }
}

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
 * 自动换行（默认开，记忆选择；CodeMirror 通过扩展重配置）
 * ============================================================ */

const WRAP_KEY = "md-editor.wrap";
let wrapOn = true;
try {
  wrapOn = localStorage.getItem(WRAP_KEY) !== "0";
} catch (_) {}

const btnWrap = document.getElementById("btnWrap");

function applyWrap() {
  view.dispatch({
    effects: StateEffect.reconfigure.of([
      ...baseExtensions(),
      ...(wrapOn ? [EditorView.lineWrapping] : []),
    ]),
  });
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
  const src = getValue();
  if (!src.trim()) return;
  const out = looksLikeHtml(src) ? formatHtml(src) : cleanText(src);
  setValue(out);
  flashStatus(looksLikeHtml(src) ? "HTML 已美化" : "空白已清理");
  saveDraft();
  render();
});

/* ============================================================
 * 一键复制：把编辑区全部内容写入剪贴板
 * ============================================================ */

const btnCopy = document.getElementById("btnCopy");

btnCopy.addEventListener("click", async () => {
  const text = getValue();
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
  setValue(text);
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
  setValue("");
  saveDraft();
  render();
  flashStatus("已清空");
});

/* ============================================================
 * 亮 / 暗主题
 * 初始 data-theme 已由 index.html 的内联脚本在首屏前设置。
 * 颜色全部走 CSS 变量，切换 data-theme 即生效，无需重配编辑器。
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

let initialDoc = "";
try {
  const draft = localStorage.getItem(DRAFT_KEY);
  if (draft != null) initialDoc = draft;
} catch (_) {}

createEditor(initialDoc);
applyWrap();
render();

// 编辑器滚动联动（等 view 创建后再挂）
view.scrollDOM.addEventListener("scroll", () => {
  if (syncing || !syncOn) return;
  syncing = true;
  syncEditorToPreview();
  requestAnimationFrame(() => {
    syncing = false;
  });
});

// 预览滚动联动：// syncing 标志阻断"程序滚动 → scroll 事件 → 反向程序滚动"的反馈环
preview.addEventListener("scroll", () => {
  if (syncing || !syncOn) return;
  syncing = true;
  syncPreviewToEditor();
  requestAnimationFrame(() => {
    syncing = false;
  });
});

// MathJax 兜底：若初次渲染时 CDN 尚未就绪，等就绪后补排版一次，
// 避免出现"粘贴了 \(\times\) 却一直显示原始文本"的情况。
(function ensureMathJaxTypeset() {
  if (window.MathJax?.startup?.promise) {
    window.MathJax.startup.promise.then(() => typeset()).catch(() => {});
  } else {
    setTimeout(ensureMathJaxTypeset, 300);
  }
})();