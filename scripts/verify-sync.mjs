import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const CANDIDATES = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'];
const executablePath = CANDIDATES.find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 880 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
const dbg = () => page.evaluate(() => ({ es: document.querySelector('#editor .cm-scroller').scrollTop, ps: document.getElementById('preview').scrollTop, syncOn: localStorage.getItem('md-editor.sync') }));
const editorBox = () => page.locator('#editor').boundingBox();
const prevBox = () => page.locator('#preview').boundingBox();
let pass = 0, fail = 0;
const S = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  [' + x + ']' : ''}`); c ? pass++ : fail++; };

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

// ============ 用例A：长行文档（核心 bug） ============
await page.evaluate(() => window.__md.set('## 标题一\n\n' + '很长很长'.repeat(20000) + '\n\n## 标题二\n\n结尾'));
await page.waitForTimeout(1500);
const eb = await editorBox();
await page.mouse.move(eb.x + 300, eb.y + 300);
for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 600);
await page.waitForTimeout(500);
let d = await dbg();
console.log('A 编辑滚后:', JSON.stringify(d));
S('A 长行：编辑→预览 预览被带动', d.ps > 100, `ps=${d.ps}`);

// 预览→编辑
const pb = await prevBox();
await page.mouse.move(pb.x + 300, pb.y + 300);
for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -600);
await page.waitForTimeout(500);
d = await dbg();
console.log('A 预览滚后:', JSON.stringify(d));
S('A 长行：预览→编辑 编辑被带动', d.es < 30000, `es=${d.es}`);

// ============ 用例B：普通文档回归 ============
const parts = [];
for (let i = 0; i < 200; i++) parts.push(`## 第 ${i} 节`, '', `段落内容内容内容。`, '');
await page.evaluate((t) => window.__md.set(t), parts.join('\n'));
await page.waitForTimeout(1200);
await page.evaluate(() => { document.querySelector('#editor .cm-scroller').scrollTop = 0; document.getElementById('preview').scrollTop = 0; });
await page.waitForTimeout(300);
const eb2 = await editorBox();
await page.mouse.move(eb2.x + 300, eb2.y + 300);
for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 500);
await page.waitForTimeout(500);
d = await dbg();
console.log('B 普通滚后:', JSON.stringify(d));
S('B 普通文档：编辑→预览 同步', d.es > 100 && d.ps > 100, `es=${d.es} ps=${d.ps}`);

// 预览→编辑
const pb2 = await prevBox();
await page.mouse.move(pb2.x + 300, pb2.y + 300);
for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -500);
await page.waitForTimeout(500);
d = await dbg();
console.log('B 普通预览滚后:', JSON.stringify(d));
S('B 普通文档：预览→编辑 同步', d.ps < (await page.evaluate(() => document.getElementById('preview').scrollHeight)) - 500, `ps=${d.ps}`);

// ============ 用例C：开关切换回归 ============
await page.click('#btnSync'); // 关
d = await dbg();
S('C 关闭后存储为 0', d.syncOn === '0');
await page.click('#btnSync'); // 开
d = await dbg();
S('C 重开后存储为 1', d.syncOn === '1');
await page.evaluate(() => { document.querySelector('#editor .cm-scroller').scrollTop = 0; document.getElementById('preview').scrollTop = 0; });
await page.waitForTimeout(300);
const eb3 = await editorBox();
await page.mouse.move(eb3.x + 300, eb3.y + 300);
for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 500);
await page.waitForTimeout(500);
d = await dbg();
S('C 开关后 编辑→预览 仍同步', d.ps > 100, `es=${d.es} ps=${d.ps}`);

// ============ 用例D：长行 + 开关 ============
await page.evaluate(() => window.__md.set('## 标题一\n\n' + '很长很长'.repeat(15000) + '\n\n结尾'));
await page.waitForTimeout(1200);
await page.evaluate(() => { document.querySelector('#editor .cm-scroller').scrollTop = 0; document.getElementById('preview').scrollTop = 0; });
await page.waitForTimeout(300);
await page.click('#btnSync'); await page.click('#btnSync'); // 关→开
const eb4 = await editorBox();
await page.mouse.move(eb4.x + 300, eb4.y + 300);
for (let i = 0; i < 25; i++) await page.mouse.wheel(0, 600);
await page.waitForTimeout(500);
d = await dbg();
console.log('D 长行开关后:', JSON.stringify(d));
S('D 长行+开关后 编辑→预览 同步', d.ps > 100, `es=${d.es} ps=${d.ps}`);

// ============ 用例E：纯 HTML（单行原生表格，无 data-line 锚点 → 比例兜底） ============
const rows = [];
for (let i = 0; i < 40; i++) {
  rows.push(`<tr><td>字段${i}</td><td>污染物名称及排放标准：综合排放标准废气锰铅镍铬</td><td>数值${i * 3.5}</td><td>单位</td></tr>`);
}
const htmlDoc = `<table><tr><th>序号</th><th>项目</th><th>标准值</th><th>备注</th></tr>${rows.join('')}</table>`;
await page.evaluate((t) => window.__md.set(t), htmlDoc);
await page.waitForTimeout(1000);
let eAnchors = await page.evaluate(() => document.querySelectorAll('#preview [data-line]').length);
S('E 纯HTML 无锚点（触发比例兜底）', eAnchors === 0, `anchors=${eAnchors}`);
await page.evaluate(() => { document.querySelector('#editor .cm-scroller').scrollTop = 0; document.getElementById('preview').scrollTop = 0; });
await page.waitForTimeout(300);
const eb5 = await editorBox();
await page.mouse.move(eb5.x + 300, eb5.y + 300);
for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 600);
await page.waitForTimeout(500);
d = await dbg();
S('E 纯HTML 编辑→预览 同步', d.es > 100 && d.ps > 100, `es=${d.es} ps=${d.ps}`);
const pbE = await prevBox();
await page.mouse.move(pbE.x + 300, pbE.y + 300);
for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -600);
await page.waitForTimeout(500);
d = await dbg();
S('E 纯HTML 预览→编辑 同步', d.es < 500, `es=${d.es}`);

console.log('\nJS 错误:', errors.length ? errors.join(' | ') : '(无)');
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
