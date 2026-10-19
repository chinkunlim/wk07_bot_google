#!/usr/bin/env node
/**
 * 把 src/*.js 合併成單一檔案 Code.gs (npm run build)
 * - 不用 clasp 時，可以把 Code.gs 整份貼進 GAS 編輯器 (另外貼上 appsscript.json)
 * - 用 clasp 時推送的是 src/，Code.gs 不會上傳 (見 .claspignore)，兩者擇一，避免函式重複定義
 * npm test 會檢查 Code.gs 是否與 src/ 同步
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const OUT_FILE = path.join(ROOT, 'Code.gs');

function buildCode() {
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort();
  const header = [
    '/**',
    ' * Telegram AI Bot - Google Apps Script (Gemini API + 網路搜尋 + 轉接站)',
    ' * ⚠️ 此檔由 `npm run build` 從 src/*.js 自動產生，請修改 src/ 後重新產生',
    ` * 包含：${files.join(', ')}`,
    ' */',
    '',
  ].join('\n');
  const parts = files.map((file) => {
    const code = fs.readFileSync(path.join(SRC_DIR, file), 'utf8').trimEnd();
    return `// ${'='.repeat(20)} src/${file} ${'='.repeat(20)}\n\n${code}\n`;
  });
  return header + parts.join('\n');
}

if (require.main === module) {
  fs.writeFileSync(OUT_FILE, buildCode());
  console.log(`✅ 已產生 ${path.relative(process.cwd(), OUT_FILE)} (${fs.statSync(OUT_FILE).size} bytes)`);
}

module.exports = { buildCode, OUT_FILE };
