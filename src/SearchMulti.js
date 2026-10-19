/**
 * 多引擎網頁搜尋 (取代 Python 版的 ddgs 套件，GAS 無法安裝 Python 套件)
 * 依序嘗試 Bing → DuckDuckGo Lite → Mojeek，第一個有結果的就採用；
 * 作為 DuckDuckGo HTML 被機器人驗證擋下時的備援
 */

const BING_SEARCH_URL = 'https://www.bing.com/search';
const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/';
const MOJEEK_SEARCH_URL = 'https://www.mojeek.com/search';

/** Bing 轉址連結 (bing.com/ck/a?...&u=a1<base64url>) → 實際網址 */
function decodeBingUrl(href) {
  if (!href) return '';
  const m = /[?&]u=a1([^&]+)/.exec(href);
  if (!m || !/^https?:\/\/(www\.)?bing\.com\/ck\//.test(href)) return href;
  try {
    let b64 = m[1];
    while (b64.length % 4) b64 += '=';
    const url = Utilities.newBlob(Utilities.base64DecodeWebSafe(b64)).getDataAsString('UTF-8');
    return /^https?:\/\//.test(url) ? url : href;
  } catch (e) {
    return href;
  }
}

/** 解析 Bing 結果頁 → [{title, url, snippet}] */
function parseBingHtml(html, maxResults) {
  const results = [];
  for (const block of splitHtmlBlocks(html, /<li\b[^>]*class="b_algo"[^>]*>/i)) {
    const m = /<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(block);
    if (!m) continue;
    const title = htmlFragmentText(m[2]);
    const url = decodeBingUrl(getHtmlAttr(m[1], 'href'));
    if (!title || !/^https?:\/\//.test(url)) continue;
    const caption = findElementByClass(block, 'b_caption') || block;
    const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(caption);
    const snippet = truncateText(htmlFragmentText(p ? p[1] : ''), 300);
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** 解析 DuckDuckGo Lite 結果頁 (表格版) → [{title, url, snippet}] */
function parseDuckDuckGoLiteHtml(html, maxResults) {
  const links = findAnchors(html).filter((a) => /\bresult-link\b/.test(a.cls));
  const snippets = [];
  const re = /<td\b[^>]*class=["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(html)) !== null) snippets.push(htmlFragmentText(m[1]));

  const results = [];
  links.forEach((a, i) => {
    const title = htmlFragmentText(a.inner);
    const url = decodeDdgUrl(a.href);
    if (!title || !url || url.includes('duckduckgo.com/y.js') || results.length >= maxResults) return;
    results.push({ title, url, snippet: truncateText(snippets[i] || '', 300) });
  });
  return results;
}

/** 解析 Mojeek 結果頁 → [{title, url, snippet}] */
function parseMojeekHtml(html, maxResults) {
  const results = [];
  for (const block of splitHtmlBlocks(html, /<li\b[^>]*class="r\d+[^"]*"[^>]*>/i)) {
    const titleAnchor = findAnchors(block).find((a) => /\btitle\b/.test(a.cls));
    if (!titleAnchor) continue;
    const title = htmlFragmentText(titleAnchor.inner);
    const url = titleAnchor.href;
    if (!title || !/^https?:\/\//.test(url)) continue;
    const s = /<p\b[^>]*class=["']s["'][^>]*>([\s\S]*?)<\/p>/i.exec(block);
    results.push({ title, url, snippet: truncateText(htmlFragmentText(s ? s[1] : ''), 300) });
    if (results.length >= maxResults) break;
  }
  return results;
}

const MULTI_BACKENDS = [
  {
    name: 'Bing',
    request: (kw) => ({
      url: `${BING_SEARCH_URL}?q=${encodeURIComponent(kw)}&setlang=zh-Hant&cc=TW`,
      method: 'get',
    }),
    parse: parseBingHtml,
  },
  {
    name: 'DuckDuckGo Lite',
    request: (kw) => ({ url: DDG_LITE_URL, method: 'post', payload: { q: kw, kl: 'tw-tw' } }),
    parse: (html, max) => (isChallengePage(200, html) && !html.includes('result-link') ? [] : parseDuckDuckGoLiteHtml(html, max)),
  },
  {
    name: 'Mojeek',
    request: (kw) => ({ url: `${MOJEEK_SEARCH_URL}?q=${encodeURIComponent(kw)}`, method: 'get' }),
    parse: parseMojeekHtml,
  },
];

/** 多引擎搜尋：依序嘗試，回傳第一個有結果的引擎 → [{title, url, snippet}] */
function searchMulti(query, maxResults) {
  const keywords = extractSearchKeywords(query) || query;
  console.log(`🔍 [multi] 搜尋關鍵字: "${keywords}"`);
  for (const backend of MULTI_BACKENDS) {
    try {
      const req = backend.request(keywords);
      const resp = UrlFetchApp.fetch(req.url, {
        method: req.method,
        payload: req.payload,
        headers: SEARCH_HEADERS,
        muteHttpExceptions: true,
        followRedirects: true,
      });
      const code = resp.getResponseCode();
      if (code !== 200) {
        console.warn(`⚠️ [multi] ${backend.name} HTTP ${code}，換下一個引擎`);
        continue;
      }
      const results = backend.parse(resp.getContentText(), maxResults);
      if (results.length) {
        console.log(`✅ [multi] ${backend.name} 取得 ${results.length} 筆結果`);
        return results;
      }
      console.warn(`⚠️ [multi] ${backend.name} 無結果，換下一個引擎`);
    } catch (e) {
      console.warn(`⚠️ [multi] ${backend.name} 失敗: ${e}`);
    }
  }
  console.warn('⚠️ [multi] 所有引擎皆無結果');
  return [];
}
