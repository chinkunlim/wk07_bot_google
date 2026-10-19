/**
 * Google News RSS 搜尋 (移植自 search/google_news.py)
 * 穩定、免費、支援繁體中文、適合新聞類即時資訊
 */

const GOOGLE_NEWS_RSS_URL = 'https://news.google.com/rss/search';
const NEWS_STOP_WORDS = ['最新', '新聞', '評價', '如何', '什麼', '請問', '查詢', '台灣', '今天', '今年'];

/**
 * 智慧相關性過濾：支援中文子詞素與 2-gram 柔性比對
 * 防範複合名詞過度誤殺，同時杜絕無關雜訊
 */
function filterRelevantArticles(articles, keyword) {
  if (!articles || !articles.length) return [];
  if (!keyword) return articles;

  const subTokens = [];
  const add = (t) => {
    if (t.length >= 2 && !NEWS_STOP_WORDS.includes(t) && !subTokens.includes(t)) subTokens.push(t);
  };

  for (let raw of keyword.split(/\s+/)) {
    raw = raw.trim();
    if (!raw || NEWS_STOP_WORDS.includes(raw.toLowerCase())) continue;
    // 去除常見地域前綴
    if (raw.length > 2) add(raw.replace(/^(台灣|全台|中華)/, ''));
    add(raw);
    // 長度 >= 3 自動提煉 2-gram
    if (raw.length >= 3) {
      for (let j = 0; j < raw.length - 1; j++) add(raw.slice(j, j + 2));
    }
  }

  if (!subTokens.length) return articles;

  const relevant = articles.filter((art) => {
    const content = `${art.title || ''} ${art.description || ''}`.toLowerCase();
    return subTokens.some((token) => content.includes(token.toLowerCase()));
  });
  console.log(
    `🎯 [GoogleNews] 相關性校驗: 原始 ${articles.length} 則 ➔ 命中 ${relevant.length} 則 (詞素: ${subTokens.join(', ')})`,
  );
  return relevant;
}

/** 移除 HTML 標籤 (RSS description 為實體編碼的 HTML，需先解碼再移除標籤) */
function cleanNewsHtml(raw) {
  if (!raw) return '';
  let text = decodeHtmlEntities(raw);
  text = text.replace(/<[^>]+>/g, ' ');
  // Google News 常見雙重編碼 (&amp;nbsp;)，再解碼一次
  text = decodeHtmlEntities(text).replace(/ /g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function rssTag_(item, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(item);
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim();
}

/** 解析 Google News RSS XML → [{title, url, pubDate, description}] */
function parseNewsRss(xmlText, maxResults, keyword) {
  const articles = [];
  const items = (xmlText.match(/<item>[\s\S]*?<\/item>/gi) || []).slice(0, 8); // 多抓一些再過濾
  for (const item of items) {
    const title = rssTag_(item, 'title');
    if (!title) continue;
    articles.push({
      title: decodeHtmlEntities(title).replace(/ /g, ' '),
      url: decodeHtmlEntities(rssTag_(item, 'link')),
      pubDate: rssTag_(item, 'pubDate'),
      description: truncateText(cleanNewsHtml(rssTag_(item, 'description')), 200),
    });
  }

  const relevant = filterRelevantArticles(articles, keyword);
  if (!relevant.length) {
    console.warn(`⚠️ [GoogleNews] 無相關新聞: "${keyword}"`);
    return [];
  }
  return relevant.slice(0, maxResults);
}

/** 使用 Google News RSS 搜尋 → [{title, url, pubDate, description}] */
function searchGoogleNews(query, maxResults) {
  const keyword = extractSearchKeywords(query) || query;
  console.log(`🔍 [GoogleNews] 搜尋關鍵字: "${keyword}"`);
  const url = `${GOOGLE_NEWS_RSS_URL}?q=${encodeURIComponent(keyword)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  try {
    const resp = UrlFetchApp.fetch(url, {
      headers: { 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) {
      console.error(`❌ [GoogleNews] HTTP ${resp.getResponseCode()}`);
      return [];
    }
    return parseNewsRss(resp.getContentText('UTF-8'), maxResults, keyword);
  } catch (e) {
    console.error(`❌ [GoogleNews] 搜尋失敗: ${e}`);
    return [];
  }
}

/** 格式化新聞結果給模型 */
function formatNewsResults(results) {
  if (!results || !results.length) return '（無搜尋結果）';
  const lines = ['【即時新聞檢索結果】'];
  results.forEach((r, i) => {
    lines.push(`\n【新聞 ${i + 1}】`);
    lines.push(`標題：${r.title}`);
    lines.push(`時間：${r.pubDate || '未知'}`);
    lines.push(`網址：${r.url}`);
    if (r.description) lines.push(`摘要：${r.description}`);
    if (r.content) lines.push(`內文摘錄：\n${r.content}`);
  });
  return lines.join('\n');
}
