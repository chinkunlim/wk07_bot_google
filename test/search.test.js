// 搜尋引擎解析、DuckDuckGo 封鎖冷卻、備援切換 (對應 test/test_search*.py；離線)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas, makeResponse } = require('../dev/gasShim');

const plain = (x) => JSON.parse(JSON.stringify(x));
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const DDG_HTML = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.ndhu.edu.tw%2Fcourse%3Fid%3D1&amp;rut=abc">東華大學 <b>課程</b> 查詢</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">陳文盛老師 開設 <b>初級程式設計</b> &amp; 人工智慧概論</a>
  </div>
</div>
<div class="result result--ad">
  <div class="links_main result__body">
    <h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">廣告</a></h2>
  </div>
</div>
<div class="result">
  <div class="links_main result__body">
    <h2 class="result__title"><a class="result__a" href="https://example.com/b">第二筆</a></h2>
    <a class="result__snippet">${'長'.repeat(400)}</a>
  </div>
</div>`;

const DDG_LITE_HTML = `
<table>
<tr><td>1.&nbsp;</td><td><a rel="nofollow" href="https://a.example/page" class='result-link'>標題 A</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>摘要 <b>A</b></td></tr>
<tr><td>2.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example%2F" class='result-link'>標題 B</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>摘要 B</td></tr>
</table>`;

const MOJEEK_HTML = `
<ul class="results-standard">
<li class="r1"><a class="ob" href="https://m.example/1">m.example</a><h2><a class="title" href="https://m.example/1">Mojeek 一</a></h2><p class="s">摘要一</p></li>
<li class="r2"><a class="ob" href="https://m.example/2">m.example</a><h2><a class="title" href="https://m.example/2">Mojeek 二</a></h2><p class="s">摘要二</p></li>
</ul>`;

const NEWS_RSS = `<?xml version="1.0" encoding="UTF-8"?><rss><channel>
<item><title>台積電 法說會 營收創新高 - 中央社</title><link>https://news.google.com/rss/articles/A?oc=5</link>
<pubDate>Mon, 19 Oct 2026 02:00:00 GMT</pubDate>
<description>&lt;a href="https://x"&gt;台積電法說會&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font&gt;中央社&lt;/font&gt;</description></item>
<item><title>颱風動態 &amp; 停班停課</title><link>https://news.google.com/rss/articles/B</link><pubDate>x</pubDate><description>颱風</description></item>
</channel></rss>`;

test('DuckDuckGo：解析結果、還原 uddg 網址、略過廣告、截斷摘要', () => {
  const g = loadGas();
  const results = plain(g.get('parseDuckDuckGoHtml')(DDG_HTML, 4));
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    title: '東華大學 課程 查詢',
    url: 'https://www.ndhu.edu.tw/course?id=1',
    snippet: '陳文盛老師 開設 初級程式設計 & 人工智慧概論',
  });
  assert.equal(results[1].url, 'https://example.com/b');
  assert.equal(results[1].snippet.length, 303);
  assert.equal(g.get('parseDuckDuckGoHtml')(DDG_HTML, 1).length, 1);
});

test('DuckDuckGo：機器人驗證頁觸發 10 分鐘冷卻，冷卻期間不再請求', () => {
  const g = loadGas({ props: { GEMINI_API_KEY: 'k' } });
  const isChallengePage = g.get('isChallengePage');
  assert.ok(isChallengePage(202, '<html>anomaly-modal</html>'));
  assert.ok(isChallengePage(200, '<script src="anomaly.js"></script>'));
  assert.ok(!isChallengePage(200, DDG_HTML));

  let calls = 0;
  g.setFetch(() => {
    calls += 1;
    return makeResponse({ code: 202, body: '<div class="anomaly-modal"></div>' });
  });
  assert.equal(g.get('searchDuckDuckGo')('台灣 天氣', 4).length, 0);
  assert.ok(g.get('isDdgBlocked')());
  assert.equal(g.get('searchDuckDuckGo')('台灣 天氣', 4).length, 0);
  assert.equal(calls, 1);
});

test('Bing：解析真實結果頁 (fixture)、還原 base64 轉址網址', () => {
  const g = loadGas();
  const results = plain(g.get('parseBingHtml')(fixture('bing.html'), 4));
  assert.equal(results.length, 3);
  assert.equal(results[0].title, '國立東華大學 NDHU, National Dong Hwa University - NDHU');
  assert.equal(results[0].url, 'https://www.ndhu.edu.tw/');
  assert.ok(results[1].url.startsWith('https://zh.wikipedia.org/'));
  assert.ok(results[0].snippet.includes('花東縱谷'));
});

test('DuckDuckGo Lite 與 Mojeek 解析', () => {
  const g = loadGas();
  assert.deepEqual(plain(g.get('parseDuckDuckGoLiteHtml')(DDG_LITE_HTML, 4)), [
    { title: '標題 A', url: 'https://a.example/page', snippet: '摘要 A' },
    { title: '標題 B', url: 'https://b.example/', snippet: '摘要 B' },
  ]);
  assert.deepEqual(plain(g.get('parseMojeekHtml')(MOJEEK_HTML, 1)), [
    { title: 'Mojeek 一', url: 'https://m.example/1', snippet: '摘要一' },
  ]);
});

test('multi：Bing 失敗時改用下一個引擎', () => {
  const g = loadGas();
  const tried = [];
  g.setFetch((url) => {
    tried.push(url.split('?')[0]);
    if (url.includes('bing.com')) return makeResponse({ code: 503, body: '' });
    return makeResponse({ body: DDG_LITE_HTML });
  });
  const results = g.get('searchMulti')('東華大學', 4);
  assert.equal(results.length, 2);
  assert.deepEqual(plain(tried), ['https://www.bing.com/search', 'https://lite.duckduckgo.com/lite/']);
});

test('Google News：解析 RSS、解碼實體、相關性過濾', () => {
  const g = loadGas();
  const results = plain(g.get('parseNewsRss')(NEWS_RSS, 4, '台積電 法說會'));
  assert.equal(results.length, 1);
  assert.equal(results[0].title, '台積電 法說會 營收創新高 - 中央社');
  assert.equal(results[0].description, '台積電法說會 中央社');
  assert.equal(results[0].url, 'https://news.google.com/rss/articles/A?oc=5');

  const all = plain(g.get('parseNewsRss')(NEWS_RSS, 4, ''));
  assert.equal(all[1].title, '颱風動態 & 停班停課');
});

test('filterRelevantArticles：2-gram 柔性比對、去除地域前綴', () => {
  const g = loadGas();
  const filter = g.get('filterRelevantArticles');
  const arts = [{ title: '高雄 捷運 延伸', description: '' }, { title: '無關新聞', description: '' }];
  assert.equal(filter(arts, '台灣高雄捷運').length, 1);
  assert.equal(filter(arts, '最新 新聞').length, 2); // 只有停用詞 → 不過濾
});

test('search：主引擎無結果時改用備援，並標記來源引擎', () => {
  const g = loadGas({ props: { SEARCH_ENGINE: 'duckduckgo', SEARCH_FALLBACK_ENGINE: 'google_news' } });
  g.setFetch((url) => {
    if (url.includes('duckduckgo')) return makeResponse({ code: 202, body: 'anomaly' });
    return makeResponse({ body: NEWS_RSS });
  });
  const results = g.get('search')('台積電 法說會');
  assert.equal(results.length, 1);
  assert.equal(results[0].source_engine, 'google_news');
  const text = g.get('formatResults')(results);
  assert.ok(text.startsWith('【即時新聞檢索結果】'));
  assert.ok(text.includes('時間：Mon, 19 Oct 2026'));
});

test('formatResults：含內文摘錄、無結果訊息', () => {
  const g = loadGas();
  const formatResults = g.get('formatResults');
  const text = formatResults([{ title: 'T', url: 'https://t.com', snippet: 's', content: '開設課程：Python', source_engine: 'multi' }]);
  assert.ok(text.includes('內文摘錄：\n開設課程：Python'));
  assert.ok(text.includes('標題：T'));
  assert.equal(formatResults([]), '（無搜尋結果）');
});
