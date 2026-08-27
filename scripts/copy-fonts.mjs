/**
 * 拷贝自托管字体（latin + latin-ext 的 variable woff2）到 public/fonts/
 * 不依赖 Google Fonts（国内不可达），字体随 Worker Assets 一并分发。
 * 中文字符不含在 these 子集内，会回落到系统字体（微软雅黑等）。
 */
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, "public", "fonts");

// 需要的文件：latin + latin-ext 子集、variable（wght）normal/italic
const WANTED = new Set([
  // JetBrains Mono Variable
  "jetbrains-mono-latin-wght-normal.woff2",
  "jetbrains-mono-latin-ext-wght-normal.woff2",
  "jetbrains-mono-latin-wght-italic.woff2",
  "jetbrains-mono-latin-ext-wght-italic.woff2",
  // Source Serif 4 Variable
  "source-serif-4-latin-wght-normal.woff2",
  "source-serif-4-latin-ext-wght-normal.woff2",
  "source-serif-4-latin-wght-italic.woff2",
  "source-serif-4-latin-ext-wght-italic.woff2",
]);

const PLAN = {
  "@fontsource-variable/jetbrains-mono": [],
  "@fontsource-variable/source-serif-4": [],
};

mkdirSync(dest, { recursive: true });

let copied = 0;
for (const pkg of Object.keys(PLAN)) {
  const filesDir = join(root, "node_modules", pkg, "files");
  for (const file of readdirSync(filesDir)) {
    if (WANTED.has(file)) {
      copyFileSync(join(filesDir, file), join(dest, file));
      copied++;
    }
  }
}
console.log(`copied ${copied} font files → public/fonts/`);
if (copied !== WANTED.size) {
  console.error(`WARN: 期望 ${WANTED.size} 个文件，实际 ${copied} 个`);
  process.exit(1);
}
