/**
 * DuckDuckGo HTML 搜尋 (移植自 search/duckduckgo.py)
 * 免費、無需 API Key；被機器人驗證擋下時冷卻 10 分鐘，由備援引擎接手
 */

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
// 被機器人驗證擋下後，暫停使用 DuckDuckGo 的秒數 (避免持續請求延長封鎖)
const DDG_BLOCK_COOLDOWN_SECONDS = 600;
const DDG_BLOCK_CACHE_KEY = 'ddg_blocked_until';

// 模擬瀏覽器的標頭 (GAS 會在 User-Agent 後附加 Google-Apps-Script 字樣)
const SEARCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
};

/** 是否處於封鎖冷卻期 */
function isDdgBlocked() {
  const until = Number(CacheService.getScriptCache().get(DDG_BLOCK_CACHE_KEY) || 0);
  return Date.now() < until;
}

function markDdgBlocked(seconds) {
  seconds = seconds || DDG_BLOCK_COOLDOWN_SECONDS;
  CacheService.getScriptCache().put(DDG_BLOCK_CACHE_KEY, String(Date.now() + seconds * 1000), seconds);
}

/**
 * 判斷是否為機器人驗證頁
 * DuckDuckGo 限流時回傳 HTTP 202 + anomaly 頁面，而非搜尋結果
 */
function isChallengePage(statusCode, text) {
  if (text.includes('result__body')) return false;
  return statusCode === 202 || text.toLowerCase().includes('anomaly');
}

/** DuckDuckGo 連結：//duckduckgo.com/l/?uddg=<實際網址> → 實際網址 */
function decodeDdgUrl(href) {
  if (!href) return '';
  let url = href;
  if (url.startsWith('//')) url = 'https:' + url;
  else if (url.startsWith('/')) url = 'https://duckduckgo.com' + url;
  const m = /[?&]uddg=([^&]+)/.exec(url);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return url;
    }
  }
  return url;
}

/** 解析 DuckDuckGo HTML 版結果頁 → [{title, url, snippet}] */
function parseDuckDuckGoHtml(html, maxResults) {
  const results = [];
  const blocks = splitHtmlBlocks(html, /<div\b[^>]*class="[^"]*\bresult__body\b[^"]*"[^>]*>/i);
  for (const block of blocks) {
    const anchors = findAnchors(block);
    const titleAnchor =
      anchors.find((a) => /\bresult__a\b/.test(a.cls)) ||
      anchors.find((a) => /\bresult__url\b/.test(a.cls));
    if (!titleAnchor) continue;

    const title = htmlFragmentText(titleAnchor.inner);
    const url = decodeDdgUrl(titleAnchor.href);
    // 廣告 (y.js 轉址) 略過
    if (!title || !url || url.includes('duckduckgo.com/y.js')) continue;

    const snippet = truncateText(htmlFragmentText(findElementByClass(block, 'result__snippet')), 300);
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** 使用 DuckDuckGo HTML 版搜尋 → [{title, url, snippet}] */
function searchDuckDuckGo(query, maxResults) {
  const keywords = extractSearchKeywords(query) || query;

  if (isDdgBlocked()) {
    console.log('⏸️ [DuckDuckGo] 封鎖冷卻中，略過');
    return [];
  }

  console.log(`🔍 [DuckDuckGo] 搜尋關鍵字: "${keywords}"`);
  try {
    const resp = UrlFetchApp.fetch(DDG_HTML_URL, {
      method: 'post',
      payload: { q: keywords, kl: 'tw-tw' },
      headers: SEARCH_HEADERS,
      muteHttpExceptions: true,
      followRedirects: true,
    });
    const code = resp.getResponseCode();
    const text = resp.getContentText();

    if (isChallengePage(code, text)) {
      markDdgBlocked();
      console.warn(
        `🚫 [DuckDuckGo] 被機器人驗證擋下 (HTTP ${code})，${DDG_BLOCK_COOLDOWN_SECONDS / 60} 分鐘內暫停使用`,
      );
      return [];
    }
    if (code < 200 || code >= 300) {
      console.error(`❌ [DuckDuckGo] HTTP ${code}`);
      return [];
    }

    const results = parseDuckDuckGoHtml(text, maxResults);
    console.log(`✅ [DuckDuckGo] 取得 ${results.length} 筆結果`);
    return results;
  } catch (e) {
    console.error(`❌ [DuckDuckGo] 搜尋失敗: ${e}`);
    return [];
  }
}

/** 將網頁搜尋結果格式化為給模型參考的文字 */
function formatWebResults(results) {
  if (!results || !results.length) return '（無搜尋結果）';
  const lines = ['【即時搜尋結果】'];
  results.forEach((r, i) => {
    lines.push(`\n【結果 ${i + 1}】`);
    lines.push(`標題：${r.title}`);
    lines.push(`網址：${r.url}`);
    if (r.snippet) lines.push(`摘要：${r.snippet}`);
    if (r.content) lines.push(`內文摘錄：\n${r.content}`);
  });
  return lines.join('\n');
}
