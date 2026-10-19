/**
 * 搜尋引擎工廠 - 統一介面 (移植自 search/__init__.py)
 */

/** 註冊的搜尋引擎 (以函式回傳，避免 GAS 檔案載入順序造成未定義) */
function getSearchEngines() {
  return {
    duckduckgo: { name: 'DuckDuckGo HTML', search: searchDuckDuckGo, format: formatWebResults },
    google_news: { name: 'Google News RSS', search: searchGoogleNews, format: formatNewsResults },
    multi: { name: '多引擎 (Bing / DuckDuckGo Lite / Mojeek)', search: searchMulti, format: formatWebResults },
  };
}

function resolveEngineName_(engineName) {
  const engines = getSearchEngines();
  const configured = getConfig().SEARCH_ENGINE;
  const name = engineName || configured;
  if (engines[name]) return name;
  const fallback = engines[configured] ? configured : 'duckduckgo';
  console.warn(`未知搜尋引擎: ${name}, 改用: ${fallback}`);
  return fallback;
}

function searchWith_(name, query, maxResults) {
  const eng = getSearchEngines()[name];
  console.log(`🔍 使用搜尋引擎: ${eng.name}`);
  const results = eng.search(query, maxResults);
  // 標記來源引擎，formatResults 才能用對應格式
  results.forEach((r) => { r.source_engine = name; });
  return results;
}

/**
 * 統一搜尋介面
 * 主引擎無結果 (含 DuckDuckGo 被機器人驗證擋下) 時，改用 SEARCH_FALLBACK_ENGINE
 */
function search(query, maxResults, engine) {
  const cfg = getConfig();
  const name = resolveEngineName_(engine);
  const max = maxResults || cfg.SEARCH_MAX_RESULTS;
  let results = searchWith_(name, query, max);

  const fallback = cfg.SEARCH_FALLBACK_ENGINE;
  if (!results.length && fallback && fallback !== name && getSearchEngines()[fallback]) {
    console.warn(`↪️ ${name} 無結果，改用備援搜尋引擎: ${fallback}`);
    results = searchWith_(fallback, query, max);
  }
  return results;
}

/** 統一格式化介面 (未指定 engine 時依結果的來源引擎選擇格式) */
function formatResults(results, engine) {
  if (!engine && results && results.length) engine = results[0].source_engine;
  const engines = getSearchEngines();
  const eng = engines[engine] || engines.duckduckgo;
  return eng.format(results);
}
