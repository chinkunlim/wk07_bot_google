/**
 * 網頁內文擷取 - 搜尋後讀取前幾筆結果的網頁，摘錄與問題相關的段落給模型
 * (移植自 search/page_fetch.py；BeautifulSoup → regex，httpx 並行 → UrlFetchApp.fetchAll)
 */

const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

// 無法直接讀取內文的網站 (需 JavaScript 轉址或登入)
const PAGE_SKIP_HOSTS = ['news.google.com', 'duckduckgo.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'x.com', 'twitter.com', 'threads.net'];
const PAGE_SKIP_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.jpg', '.png'];
const PAGE_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
// 移除這些標籤 (含內容)：腳本、樣式、導覽列等雜訊
const PAGE_NOISE_TAGS = ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'svg', 'iframe'];
// 命中行之後一併保留的行數 (例如「開設課程」標題後接課程清單)
const CONTEXT_LINES = 3;
// 短行 (標題、清單項目) 的長度門檻
const SHORT_LINE = 60;

function isFetchable(url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)/i.exec(url || '');
  if (!m) return false;
  if (!['http', 'https'].includes(m[1].toLowerCase())) return false;
  const host = m[2].toLowerCase().replace(/:\d+$/, '');
  if (PAGE_SKIP_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return false;
  const path = m[3].toLowerCase();
  return !PAGE_SKIP_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** 移除腳本、導覽等雜訊，回傳去重後的文字行 */
function htmlToLines(html) {
  let text = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of PAGE_NOISE_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), '\n');
  }
  // 每個標籤都視為分隔 (同 BeautifulSoup get_text('\n'))
  text = decodeHtmlEntities(text.replace(/<[^>]+>/g, '\n'));

  const lines = [];
  const seen = new Set();
  for (let line of text.split('\n')) {
    line = line.replace(/\s+/g, ' ').trim();
    if (line && !seen.has(line)) {
      seen.add(line);
      lines.push(line.slice(0, 300));
    }
  }
  return lines;
}

/**
 * 在字數上限內挑選內文，依原文順序組合：
 * 1. 全文放得下就全給
 * 2. 命中關鍵字的行 (越長的關鍵字權重越高) 連同其後 CONTEXT_LINES 個短行
 * 3. 其餘短行：標題、清單項目、課程名稱多為短行，即使沒命中關鍵字也常是答案
 * 4. 其餘長段落 (公告、內文)
 */
function extractRelevantText(lines, query, maxChars) {
  const full = lines.join('\n');
  if (full.length <= maxChars) return full;

  const keywords = queryKeywords(query);
  const scores = lines.map((line) => keywords.reduce((sum, k) => sum + (line.includes(k) ? k.length : 0), 0));

  const chosen = new Set();
  let total = 0;
  const take = (j) => {
    if (chosen.has(j)) return true;
    const cost = lines[j].length + 1;
    if (total + cost > maxChars) return false;
    chosen.add(j);
    total += cost;
    return true;
  };

  const matched = scores
    .map((sc, i) => i)
    .filter((i) => scores[i])
    .sort((a, b) => scores[b] - scores[a] || a - b);
  for (const i of matched) {
    take(i);
    for (let j = i + 1; j < Math.min(i + 1 + CONTEXT_LINES, lines.length); j++) {
      if (lines[j].length <= SHORT_LINE) take(j);
    }
  }

  lines.forEach((line, j) => {
    if (line.length <= SHORT_LINE) take(j);
  });

  for (let j = 0; j < lines.length; j++) take(j);

  return Array.from(chosen).sort((a, b) => a - b).map((j) => lines[j]).join('\n');
}

function getHeader_(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}

/** 依 Content-Type 或 <meta charset> 決定編碼 (big5 等舊站) */
function detectCharset_(contentType, bytes) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType);
  if (fromHeader) return fromHeader[1];
  const head = Utilities.newBlob(bytes.slice(0, 4096)).getDataAsString('ISO-8859-1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : 'UTF-8';
}

/** 網頁回應 → 相關內文摘錄；非 HTML 或失敗回傳空字串 */
function pageTextFromResponse(resp, query, maxChars) {
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) return '';
  const contentType = getHeader_(resp.getHeaders(), 'Content-Type');
  if (!contentType.includes('html') && !contentType.includes('text/plain')) return '';

  let bytes = resp.getContent();
  if (bytes.length > PAGE_MAX_DOWNLOAD_BYTES) bytes = bytes.slice(0, PAGE_MAX_DOWNLOAD_BYTES);
  let html;
  try {
    html = Utilities.newBlob(bytes).getDataAsString(detectCharset_(contentType, bytes));
  } catch (e) {
    html = Utilities.newBlob(bytes).getDataAsString('UTF-8');
  }
  return extractRelevantText(htmlToLines(html), query, maxChars);
}

/** 抓取多個網頁 (fetchAll 平行)；單一網址連線失敗時改逐一抓取，失敗的回傳 null */
function fetchPages_(urls) {
  const requests = urls.map((url) => ({
    url: url,
    method: 'get',
    headers: PAGE_HEADERS,
    muteHttpExceptions: true,
    followRedirects: true,
  }));
  try {
    return UrlFetchApp.fetchAll(requests);
  } catch (e) {
    console.log(`📄 平行讀取失敗，改逐一讀取: ${e}`);
    return requests.map((req) => {
      try {
        return UrlFetchApp.fetch(req.url, req);
      } catch (err) {
        console.log(`📄 讀取網頁失敗 ${req.url.slice(0, 80)}: ${err}`);
        return null;
      }
    });
  }
}

/** 為前 N 筆可讀取的結果加上 content (網頁內文摘錄)，就地修改並回傳 */
function enrichResults(results, query, pages, maxChars) {
  const cfg = getConfig();
  pages = pages === undefined || pages === null ? cfg.SEARCH_FETCH_PAGES : pages;
  maxChars = maxChars === undefined || maxChars === null ? cfg.SEARCH_PAGE_CHARS : maxChars;
  const targets = results.filter((r) => isFetchable(r.url || '')).slice(0, pages);
  if (!targets.length) return results;

  const responses = fetchPages_(targets.map((r) => r.url));
  targets.forEach((r, i) => {
    if (!responses[i]) return;
    try {
      const text = pageTextFromResponse(responses[i], query, maxChars);
      if (text) r.content = text;
    } catch (e) {
      console.log(`📄 解析網頁失敗 ${r.url.slice(0, 80)}: ${e}`);
    }
  });
  console.log(`📄 已讀取 ${targets.filter((r) => r.content).length}/${targets.length} 個網頁內文`);
  return results;
}
