// Markdown → Telegram HTML、訊息切段 (對應 test/test_markdown.py、test_handler_utils.py)
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../dev/gasShim');

const g = loadGas();
const markdownToHtml = g.get('markdownToHtml');
const splitMessage = g.get('splitMessage');
const htmlToPlain = g.get('htmlToPlain');
// vm 內建立的陣列與測試的陣列屬於不同 realm，比較前轉成一般 JSON
const plain = (x) => JSON.parse(JSON.stringify(x));

test('基本語法', () => {
  for (const [md, expected] of [
    ['**粗體**', '<b>粗體</b>'],
    ['*斜體*', '<i>斜體</i>'],
    ['`行內程式碼`', '<code>行內程式碼</code>'],
    ['[連結](https://example.com)', '<a href="https://example.com">連結</a>'],
  ]) {
    assert.ok(markdownToHtml(md).includes(expected), `${md} -> ${markdownToHtml(md)}`);
  }
});

test('程式碼區塊移除語言標記並跳脫', () => {
  const result = markdownToHtml('```python\nprint("<hello>")\n```');
  assert.equal(result, '<pre><code>print("&lt;hello&gt;")</code></pre>');
});

test('標題與項目符號', () => {
  assert.equal(markdownToHtml('## 二級標題'), '<b>二級標題</b>');
  const result = markdownToHtml('- 項目一\n- 項目二\n* 項目三\n  - 子項目');
  assert.equal((result.match(/•/g) || []).length, 3);
  assert.ok(result.includes('    ◦ 子項目'));
});

test('複雜混合', () => {
  const result = markdownToHtml('**標題**\n\n這是*斜體*和**粗體**文字。\n\n- 項目一\n\n`print("code")`\n\n[Google](https://google.com)\n');
  for (const s of ['<b>標題</b>', '<i>斜體</i>', '<b>粗體</b>', '• 項目一', '<code>print("code")</code>',
    '<a href="https://google.com">Google</a>']) {
    assert.ok(result.includes(s), s);
  }
});

test('未閉合粗體自動補齊', () => {
  assert.ok(markdownToHtml('這是**粗體沒閉合').includes('<b>粗體沒閉合</b>'));
});

test('HTML 跳脫與保留 Telegram 標籤', () => {
  assert.equal(markdownToHtml('5 < 10 & 3 > 2'), '5 &lt; 10 &amp; 3 &gt; 2');
  assert.equal(markdownToHtml('`a<b>`'), '<code>a&lt;b&gt;</code>');
  assert.equal(markdownToHtml('<b>粗</b>'), '<b>粗</b>');
});

test('網址中的底線不被當成斜體、中文詞內底線不轉換', () => {
  assert.equal(markdownToHtml('https://a.com/x_y_z'), 'https://a.com/x_y_z');
  assert.equal(markdownToHtml('snake_case_name'), 'snake_case_name');
  assert.equal(markdownToHtml('中文_不是斜體_中文'), '中文_不是斜體_中文');
});

test('短訊息不切段', () => {
  assert.deepEqual(plain(splitMessage('hello')), ['hello']);
});

test('依換行切段且每段不超過上限', () => {
  const text = Array.from({ length: 100 }, (_, i) => `第 ${i} 行 ${'字'.repeat(50)}`).join('\n');
  const chunks = splitMessage(text, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 500));
  assert.equal(chunks.join('\n'), text);
});

test('單行超長硬切', () => {
  const chunks = splitMessage('a'.repeat(1200), 500);
  assert.deepEqual(plain(chunks.map((c) => c.length)), [500, 500, 200]);
});

test('htmlToPlain 移除標籤並還原實體', () => {
  assert.equal(htmlToPlain('<b>5 &lt; 10</b> &amp; <a href="x">連結</a>'), '5 < 10 & 連結');
});
