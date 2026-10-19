/**
 * 搜尋關鍵字處理
 * - extractSearchKeywords：把口語提問清成搜尋關鍵字 (移植自 search/duckduckgo.py)
 * - queryKeywords：網頁內文摘錄用的比對詞 (移植自 search/page_fetch.py)
 */

const SEARCH_STOP_PHRASES = [
  '請問', '請告訴我', '我想知道', '你知道', '有沒有', '可以跟我說',
  '幫我查', '幫我搜尋', '搜尋', '查詢', '一下', '什麼是', '是誰',
  '是多少', '多少個', '多少面', '數量', '結果', '如何', '怎麼樣',
  '評價是什麼', '評價如何', '推薦嗎', '好不好', '可以選嗎',
  '開什麼課', '有哪些課', '相關的', '有關的', '表現如何',
  '今天的', '今天', '今日', '明天的', '明天', '昨天的', '昨天',
  '今年的', '今年', '最近的', '最近', '最新的', '最新', '目前的', '目前', '現在',
  '新聞', '即時', '即時新聞',
];

const SEARCH_PARTICLES = ['的', '了', '和', '與', '在', '之', '個', '嗎', '呢', '啊', '吧', '請'];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 從使用者提問中提取核心搜尋關鍵字
 * 移除常見提問詞彙、標點符號
 */
function extractSearchKeywords(query) {
  if (!query) return '';

  // 移除指令前綴
  query = query.replace(/^(\/search|\/news)\s*/i, '').trim();

  // 將標點符號替換為空格 (保留 C++、C#、llama3.1 這類詞內符號)
  query = query.replace(/[。，！？!?,\n/；;:：、～~—_()（）「」『』《》@=*&^%$]+/g, ' ');
  query = query.replace(/(?<![\p{L}\p{N}_])\.|\.(?![\p{L}\p{N}_])/gu, ' ');
  query = query.replace(/(?<![\p{L}\p{N}_+])\++/gu, ' ');
  query = query.replace(/(?<![\p{L}\p{N}_])#(?![\p{L}\p{N}_])/gu, ' ');

  // 移除常見提問贅詞
  for (const phrase of SEARCH_STOP_PHRASES) {
    query = query.replace(new RegExp(escapeRegExp(phrase), 'gi'), ' ');
  }

  // 清理助詞：只移除獨立的助詞與句尾疑問詞，不從詞內剝字 (避免「和平」→「平」)
  const words = query.split(/\s+/)
    .map((w) => w.replace(/[嗎呢]+$/, ''))
    .filter((w) => w && !SEARCH_PARTICLES.includes(w));

  // 去重並取前 5 個關鍵字
  const unique = [];
  const seen = new Set();
  for (const w of words) {
    if (!seen.has(w.toLowerCase())) {
      seen.add(w.toLowerCase());
      unique.push(w);
    }
  }
  return unique.slice(0, 5).join(' ');
}

/**
 * 問題關鍵字 (中文無空白斷詞)：
 * - 英數詞整段保留，例如「115-1」「Python」
 * - 中文連續字串保留原詞並拆成 2-gram，例如「陳文盛老師」也能命中「陳文盛」
 * 不拆英數字，避免「11」「15」這類片段命中所有含數字的段落
 */
function queryKeywords(query) {
  const keywords = new Set();
  for (const run of query.match(/[A-Za-z0-9][A-Za-z0-9.\-+#]*/g) || []) {
    if (run.length >= 2) keywords.add(run);
  }
  for (const run of query.match(/[一-鿿]+/g) || []) {
    if (run.length >= 2) keywords.add(run);
    if (run.length >= 3) {
      for (let i = 0; i < run.length - 1; i++) keywords.add(run.slice(i, i + 2));
    }
  }
  return Array.from(keywords).sort((a, b) => b.length - a.length);
}
