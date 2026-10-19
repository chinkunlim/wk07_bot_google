// 網頁內文擷取 (對應 test/test_page_fetch.py) 與關鍵字處理
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, makeResponse } = require('../dev/gasShim');

const g = loadGas({ props: { GEMINI_API_KEY: 'k' } });
const isFetchable = g.get('isFetchable');
const htmlToLines = g.get('htmlToLines');
const queryKeywords = g.get('queryKeywords');
const extractRelevantText = g.get('extractRelevantText');
const extractSearchKeywords = g.get('extractSearchKeywords');

const TEACHER_PAGE = `
<html><head><title>陳文盛助理教授</title><script>var x = 1;</script></head>
<body>
<nav><a>首頁</a><a>通識課程查詢</a></nav>
<div>跳到主要內容區</div>
<h2>陳文盛助理教授</h2>
<p>研究室：理工二館C306</p>
<h3>學歷</h3><p>國立東華大學 資訊工程學系 博士</p>
<h3>經歷</h3><p>台灣東部地震中心專案研究員</p>
${Array.from({ length: 30 }, (_, i) => `<p>無關段落 ${i} ${'填充文字'.repeat(20)}</p>`).join('')}
<h3>開設課程</h3>
<p>初級程式設計-Python，中級程式設計-Python 資訊科技與應用</p>
<h3>個人著作</h3><p>Multiple Object Tracking using YOLO-based Detector</p>
<footer>版權所有</footer>
</body></html>`;

test('isFetchable 排除無法讀取的網站與檔案', () => {
  assert.ok(isFetchable('https://genedu.ndhu.edu.tw/p/412-1076-18517.php?Lang=zh-tw'));
  assert.ok(!isFetchable('https://news.google.com/rss/articles/abc'));
  assert.ok(!isFetchable('https://www.youtube.com/watch?v=1'));
  assert.ok(!isFetchable('https://example.com/file.pdf'));
  assert.ok(!isFetchable('javascript:void(0)'));
});

test('htmlToLines 移除腳本、導覽、頁尾', () => {
  const text = htmlToLines(TEACHER_PAGE).join('\n');
  assert.ok(!text.includes('var x'));
  assert.ok(!text.includes('通識課程查詢'));
  assert.ok(!text.includes('版權所有'));
  assert.ok(text.includes('開設課程'));
});

test('queryKeywords 含 2-gram、不拆數字', () => {
  const kws = queryKeywords('東華大學 陳文盛老師 課程');
  assert.ok(kws.includes('陳文盛老師') && kws.includes('陳文') && kws.includes('課程'));
  const kws2 = queryKeywords('東華大學通識中心陳文盛老師115-1課程');
  assert.ok(kws2.includes('115-1') && kws2.includes('陳文'));
  assert.ok(!kws2.includes('11') && !kws2.includes('15') && !kws2.includes('5-'));
});

test('摘錄在上限內保留課程段落', () => {
  const lines = htmlToLines(TEACHER_PAGE);
  assert.ok(lines.join('\n').length > 1500);
  const excerpt = extractRelevantText(lines, '東華大學 陳文盛 課程', 400);
  assert.ok(excerpt.length <= 400);
  assert.ok(excerpt.includes('開設課程'));
  assert.ok(excerpt.includes('中級程式設計-Python'));
});

test('全文放得下就全給', () => {
  const lines = ['標題', '人工智慧概論', '和AI一起寫程式'];
  assert.equal(extractRelevantText(lines, '陳文盛 課程', 100), lines.join('\n'));
});

test('短清單項目優先於長段落', () => {
  const names = ['人工智慧概論', '資訊科技與應用', '創客入門–智慧生活裝置實作', '和AI一起寫程式：創意生活應用'];
  const lines = ['陳文盛 115-1 課程入口', ...names, ...Array.from({ length: 5 }, () => '公告 ' + '很長的公告內容'.repeat(30))];
  const excerpt = extractRelevantText(lines, '陳文盛老師115-1課程', 300);
  for (const name of names) assert.ok(excerpt.includes(name), name);
  assert.ok(excerpt.length <= 300);
});

test('沒有命中時從開頭取', () => {
  assert.ok(extractRelevantText(['第一行', '第二行'], '完全不相關', 100).startsWith('第一行'));
});

test('enrichResults 只讀前 N 筆可讀取的網頁', () => {
  const fetched = [];
  g.setFetch((url) => {
    fetched.push(url);
    return makeResponse({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<p>內文 ${url}</p>` });
  });
  const results = [
    { title: 'G', url: 'https://news.google.com/rss/articles/x' },
    { title: 'A', url: 'https://a.com/' },
    { title: 'B', url: 'https://b.com/' },
    { title: 'C', url: 'https://c.com/' },
  ];
  g.get('enrichResults')(results, 'q', 2, 100);
  assert.deepEqual(fetched, ['https://a.com/', 'https://b.com/']);
  assert.equal(results[0].content, undefined);
  assert.equal(results[3].content, undefined);
  assert.equal(results[1].content, '內文 https://a.com/');
});

test('enrichResults 依 meta charset 解碼 big5、略過非 HTML', () => {
  const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]); // 「中文」
  g.setFetch((url) => (url.includes('pdf-like')
    ? makeResponse({ headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' })
    : makeResponse({
      headers: { 'Content-Type': 'text/html' },
      body: Buffer.concat([Buffer.from('<meta charset="big5"><p>'), big5, Buffer.from('</p>')]),
    })));
  const results = [{ url: 'https://old.edu.tw/' }, { url: 'https://x.com.tw/pdf-like' }];
  g.get('enrichResults')(results, '中文', 2, 100);
  assert.equal(results[0].content, '中文');
  assert.equal(results[1].content, undefined);
});

test('enrichResults 平行讀取失敗時逐一重試', () => {
  const ctx = g.context;
  const originalFetchAll = ctx.UrlFetchApp.fetchAll;
  ctx.UrlFetchApp.fetchAll = () => { throw new Error('DNS error'); };
  g.setFetch((url) => {
    if (url.includes('bad')) throw new Error('DNS error');
    return makeResponse({ headers: { 'content-type': 'text/html' }, body: '<p>好的內文</p>' });
  });
  const results = [{ url: 'https://bad.example/' }, { url: 'https://good.example/' }];
  g.get('enrichResults')(results, 'q', 2, 100);
  ctx.UrlFetchApp.fetchAll = originalFetchAll;
  assert.equal(results[0].content, undefined);
  assert.equal(results[1].content, '好的內文');
});

test('extractSearchKeywords 移除贅詞、保留專有名詞與符號', () => {
  assert.equal(extractSearchKeywords('請問東華大學陳文盛老師115-1開什麼課？'), '東華大學陳文盛老師115-1');
  assert.equal(extractSearchKeywords('C++ 和 C# 的差別 llama3.1'), 'C++ C# 的差別 llama3.1');
  assert.equal(extractSearchKeywords('/search 今天台北天氣如何'), '台北天氣');
  assert.equal(extractSearchKeywords('和平紀念公園在哪裡呢'), '和平紀念公園在哪裡');
});
