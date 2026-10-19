/**
 * Telegram AI Bot - Google Apps Script (Gemini API + 網路搜尋 + 轉接站)
 * ⚠️ 此檔由 `npm run build` 從 src/*.js 自動產生，請修改 src/ 後重新產生
 * 包含：Config.js, Diagnostics.js, Format.js, Gemini.js, Handler.js, Html.js, Keywords.js, Main.js, PageFetch.js, Relay.js, Search.js, SearchDuckDuckGo.js, SearchGoogleNews.js, SearchMulti.js, Store.js, Telegram.js
 */
// ==================== src/Config.js ====================

/**
 * 設定：讀取 Script Properties (取代 Python 版的 .env)
 * GAS 編輯器 → 專案設定 → 指令碼屬性，或執行 setupProperties() 自動補上預設值
 */

const SUPPORTED_SEARCH_ENGINES = ['duckduckgo', 'google_news', 'multi'];
const SUPPORTED_SEARCH_DECISIONS = ['router', 'tools'];

// 字串預設值；數字欄位於 getConfig 轉型
const CONFIG_DEFAULTS = {
  // === Telegram ===
  TELEGRAM_BOT_TOKEN: '',
  ALLOWED_USER_IDS: '',
  // Web App 部署網址 (/exec 結尾)；setWebhook() 會用它設定 Telegram webhook
  WEBHOOK_URL: '',
  // 驗證 webhook 請求來源 (setWebhook() 自動產生，放在網址 ?secret=)
  WEBHOOK_SECRET: '',

  // === Gemini ===
  GEMINI_API_KEY: '',
  GEMINI_MODEL: 'gemini-3.5-flash-lite',
  // 主模型額度用完 (429) 或過載 (503) 時依序改用的備援模型 (逗號分隔，留空停用)
  // 免費額度按模型分開計算，多備援幾個可以撐更久
  GEMINI_FALLBACK_MODELS: 'gemini-3.1-flash-lite,gemini-3.6-flash',
  // 最後一個可用模型回 429 / 5xx 時的重試次數
  GEMINI_RETRIES: '1',
  GEMINI_MAX_OUTPUT_TOKENS: '4096',

  // === 搜尋 ===
  // duckduckgo | google_news | multi (Bing → DuckDuckGo Lite → Mojeek 依序嘗試)
  SEARCH_ENGINE: 'duckduckgo',
  // 主引擎無結果或 DuckDuckGo 被機器人驗證擋下時改用 (留空停用)
  SEARCH_FALLBACK_ENGINE: 'multi',
  // 搜尋後讀取前 N 筆結果的網頁內文給模型 (0 = 只用搜尋摘要)
  SEARCH_FETCH_PAGES: '2',
  // 每頁內文摘錄上限字數
  SEARCH_PAGE_CHARS: '2000',
  SEARCH_MAX_RESULTS: '4',
  // router：模型先輸出 JSON 判斷要不要搜尋；tools：原生 Function Calling
  SEARCH_DECISION: 'router',

  // === 對話 / 配額 ===
  MAX_HISTORY_TURNS: '4',
  MAX_DAILY_REQUESTS: '50',

  // === 儲存 ===
  // 對話歷史 / 配額 / 日誌的試算表；留空時第一次執行自動建立並寫回
  SPREADSHEET_ID: '',
};

const CONFIG_INT_KEYS = [
  'GEMINI_RETRIES', 'GEMINI_MAX_OUTPUT_TOKENS', 'SEARCH_FETCH_PAGES', 'SEARCH_PAGE_CHARS',
  'SEARCH_MAX_RESULTS', 'MAX_HISTORY_TURNS', 'MAX_DAILY_REQUESTS',
];

// 機密欄位：記錄設定時遮蔽
const CONFIG_SECRET_KEYS = ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'WEBHOOK_SECRET'];

/** 解析逗號分隔的 User ID，回傳 {ids, invalid} */
function parseUserIds(raw) {
  const ids = [];
  const invalid = [];
  for (let x of String(raw || '').split(',')) {
    x = x.trim();
    if (!x) continue;
    if (/^-?\d+$/.test(x)) ids.push(Number(x));
    else invalid.push(x);
  }
  return { ids, invalid };
}

/** 由原始字串屬性建立設定物件 (純函式，方便測試) */
function buildConfig(props) {
  const cfg = {};
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    const raw = props[key];
    cfg[key] = raw === undefined || raw === null ? CONFIG_DEFAULTS[key] : String(raw).trim();
  }
  for (const key of CONFIG_INT_KEYS) {
    const n = parseInt(cfg[key], 10);
    cfg[key] = Number.isNaN(n) ? parseInt(CONFIG_DEFAULTS[key], 10) : n;
  }
  const { ids, invalid } = parseUserIds(cfg.ALLOWED_USER_IDS);
  cfg.ALLOWED_USER_IDS = ids;
  cfg.INVALID_USER_IDS = invalid;
  // 依序嘗試的模型：主模型在前，備援去重
  cfg.GEMINI_MODELS = [cfg.GEMINI_MODEL]
    .concat(cfg.GEMINI_FALLBACK_MODELS.split(',').map((m) => m.trim()))
    .filter((m, i, all) => m && all.indexOf(m) === i);
  return cfg;
}

let CONFIG_CACHE_ = null;

/** 取得設定 (同一次執行內快取；修改屬性後下一次請求即生效，不需重新部署) */
function getConfig() {
  if (!CONFIG_CACHE_) {
    CONFIG_CACHE_ = buildConfig(PropertiesService.getScriptProperties().getProperties());
  }
  return CONFIG_CACHE_;
}

function resetConfigCache_() {
  CONFIG_CACHE_ = null;
}

/** 驗證必要設定 (模擬模式不需要 Telegram 相關設定) */
function validateConfig(cfg, requireTelegram) {
  if (requireTelegram === undefined) requireTelegram = true;
  const errors = [];
  if (requireTelegram) {
    if (!cfg.TELEGRAM_BOT_TOKEN) {
      errors.push('TELEGRAM_BOT_TOKEN 未設定');
    } else if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(cfg.TELEGRAM_BOT_TOKEN)) {
      errors.push('TELEGRAM_BOT_TOKEN 格式不對 (應為「數字:一串英數字」，從 @BotFather 複製)');
    }
    if (!cfg.ALLOWED_USER_IDS.length) errors.push('ALLOWED_USER_IDS 未設定 (至少需一個用戶 ID)');
    if (cfg.INVALID_USER_IDS.length) {
      errors.push(`ALLOWED_USER_IDS 含非數字項目: ${cfg.INVALID_USER_IDS.join(', ')}`);
    }
  }
  if (!cfg.GEMINI_API_KEY) errors.push('GEMINI_API_KEY 未設定 (到 https://aistudio.google.com/apikey 建立)');
  if (!SUPPORTED_SEARCH_DECISIONS.includes(cfg.SEARCH_DECISION)) {
    errors.push(`SEARCH_DECISION=${cfg.SEARCH_DECISION} 不支援 (可用: ${SUPPORTED_SEARCH_DECISIONS.join(' | ')})`);
  }
  if (cfg.SEARCH_FALLBACK_ENGINE && !SUPPORTED_SEARCH_ENGINES.includes(cfg.SEARCH_FALLBACK_ENGINE)) {
    errors.push(
      `SEARCH_FALLBACK_ENGINE=${cfg.SEARCH_FALLBACK_ENGINE} 不支援 ` +
      `(可用: ${SUPPORTED_SEARCH_ENGINES.join(' | ')}，或留空停用)`,
    );
  }
  if (!SUPPORTED_SEARCH_ENGINES.includes(cfg.SEARCH_ENGINE)) {
    errors.push(`SEARCH_ENGINE=${cfg.SEARCH_ENGINE} 不支援 (可用: ${SUPPORTED_SEARCH_ENGINES.join(' | ')})`);
  }
  return errors;
}

/** 遮蔽機密，用於日誌 */
function maskSecret(value) {
  if (!value) return '(未設定)';
  return value.length <= 8 ? '****' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * 【編輯器執行】補上缺少的屬性 (使用預設值)，並列出目前設定與驗證結果
 * 第一次執行也會跳出授權視窗 (外部連線、試算表)
 */
function setupProperties() {
  const store = PropertiesService.getScriptProperties();
  const current = store.getProperties();
  const missing = {};
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    if (current[key] === undefined) missing[key] = CONFIG_DEFAULTS[key];
  }
  if (Object.keys(missing).length) {
    store.setProperties(missing);
    console.log(`已新增 ${Object.keys(missing).length} 個屬性：${Object.keys(missing).join(', ')}`);
  }
  resetConfigCache_();
  const cfg = getConfig();
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    const value = CONFIG_SECRET_KEYS.includes(key) ? maskSecret(current[key] || '') : cfg[key];
    console.log(`${key} = ${Array.isArray(value) ? value.join(',') : value}`);
  }
  const errors = validateConfig(cfg, true);
  if (errors.length) {
    errors.forEach((e) => console.warn(`❌ ${e}`));
    console.warn('請到「專案設定 → 指令碼屬性」填入上述欄位後再執行一次 setupProperties()');
  } else {
    console.log('✅ 設定檢查通過');
  }
  // 順便建立資料試算表
  console.log(`📊 資料試算表：${getSpreadsheet_().getUrl()}`);
  return errors;
}

// ==================== src/Diagnostics.js ====================

/**
 * 編輯器可執行的檢查與模擬 (對應 Python 版的 check_env.py 與 --simulate)
 * GAS 編輯器上方選擇函式 → 執行，結果看「執行紀錄」
 */

// 模擬模式使用的假使用者 ID (不與真實 Telegram ID 衝突)
const SIM_USER_ID = 0;
// 未設定 SIM_QUERY 屬性時的示範問題：閒聊 (不搜尋)、即時資訊 (搜尋)、追問 (歷史)
const SIM_DEFAULT_QUERIES = ['你好，請用一句話介紹你自己', '今天台灣有什麼重要新聞？', '第一則可以再說詳細一點嗎？'];

/** 主控台版的對話情境：狀態與回覆印到執行紀錄 */
function createConsoleContext(userId, updateId, printer) {
  printer = printer || ((line) => console.log(line));
  let nextId = 1;
  return {
    updateId: updateId,
    chatId: userId,
    userId: userId,
    firstName: '模擬使用者',
    userName: '模擬使用者',
    statusMessageId: null,
    reply: (text) => {
      printer(`🤖 ${htmlToPlain(text)}`);
      nextId += 1;
      return nextId;
    },
    edit: (messageId, text) => {
      printer(`🤖 ${htmlToPlain(text)}`);
      return true;
    },
    typing: () => {},
  };
}

/**
 * 【編輯器執行】模擬模式：不接 Telegram，用同一套流程回答
 * 問題來源：指令碼屬性 SIM_QUERY (多題用 || 分隔)，未設定則用示範問題
 */
function simulate() {
  const cfg = getConfig();
  const errors = validateConfig(cfg, false);
  if (errors.length) {
    errors.forEach((e) => console.error(`❌ ${e}`));
    return;
  }
  console.log(
    `模擬模式：模型 ${cfg.GEMINI_MODELS.join(' → ')}，搜尋 ${cfg.SEARCH_ENGINE} ` +
    `(備援 ${cfg.SEARCH_FALLBACK_ENGINE || '無'})，判斷方式 ${cfg.SEARCH_DECISION}`,
  );
  const raw = PropertiesService.getScriptProperties().getProperty('SIM_QUERY');
  const queries = raw ? raw.split('||').map((q) => q.trim()).filter(Boolean) : SIM_DEFAULT_QUERIES;

  REQUEST_SOURCE_ = 'simulate';
  // 每次模擬都是新的對話，避免上次的內容混進回答
  clearConversationHistory(SIM_USER_ID);
  queries.forEach((text, i) => {
    console.log(`📱 你：${text}`);
    const ctx = createConsoleContext(SIM_USER_ID, i + 1);
    const cmd = parseCommand(text);
    if (cmd) {
      // 模擬模式不檢查白名單，直接執行指令
      const handler = COMMAND_HANDLERS[cmd.command];
      if (handler && ['start', 'help', 'models'].includes(cmd.command)) handler(ctx, cmd.args);
      else if (cmd.command === 'reset') clearConversationHistory(SIM_USER_ID);
      else console.log(`模擬模式僅支援 /start /help /models /reset 與一般提問`);
      return;
    }
    const quota = checkAndConsumeQuota(SIM_USER_ID);
    if (!quota.allowed) {
      console.log(quota.message);
      return;
    }
    processQuery(ctx, text, quota);
  });
  console.log('模擬結束。');
}

/** 【編輯器執行】環境檢查：設定、Gemini 模型、Telegram Bot、webhook */
function checkEnv() {
  const cfg = getConfig();
  let ok = true;
  const errors = validateConfig(cfg, true);
  if (errors.length) {
    ok = false;
    errors.forEach((e) => console.error(`❌ ${e}`));
  } else {
    console.log('✅ 指令碼屬性設定完整');
  }

  if (cfg.GEMINI_API_KEY) {
    try {
      const names = listGeminiModels().map((m) => m.name);
      cfg.GEMINI_MODELS.forEach((model, i) => {
        const role = i === 0 ? 'GEMINI_MODEL' : 'GEMINI_FALLBACK_MODELS';
        if (names.includes(model)) {
          console.log(`✅ Gemini 模型可用：${model} (${role})`);
        } else {
          ok = false;
          console.error(`❌ 找不到模型 ${model} (${role})，可用：${names.join(', ')}`);
        }
      });
    } catch (e) {
      ok = false;
      console.error(`❌ Gemini API 無法使用：${e.message || e}`);
    }
  }

  if (cfg.TELEGRAM_BOT_TOKEN) {
    const me = telegramApi('getMe', {});
    if (me.ok) console.log(`✅ Telegram Bot：@${me.result.username}`);
    else {
      ok = false;
      console.error(`❌ Telegram Token 無效：${me.description}`);
    }
    getWebhookInfo();
  }

  try {
    console.log(`✅ 資料試算表：${getSpreadsheet_().getUrl()}`);
  } catch (e) {
    ok = false;
    console.error(`❌ 無法開啟資料試算表：${e.message || e}`);
  }
  console.log(ok ? '🎉 環境檢查通過' : '⚠️ 請修正上述問題');
  return ok;
}

/** 【編輯器執行】測試 Gemini：一般回答、搜尋判斷、Function Calling */
function testGemini() {
  const today = getTodayDateStr();
  const hello = geminiGenerate([{ role: 'user', parts: [{ text: '用一句話說你好' }] }], {
    systemInstruction: buildSystemPrompt('router', today),
  });
  console.log(`一般回答 (${hello.model})：${hello.text}`);
  console.log(`token 用量：${JSON.stringify(hello.usage)}`);

  for (const q of ['今天台北天氣如何？', '幫我寫一個 Python 的 hello world']) {
    const d = decideSearch([{ role: 'user', parts: [{ text: q }] }], today);
    console.log(`搜尋判斷「${q}」→ ${JSON.stringify({ need_search: d.need_search, query: d.query })}`);
  }

  const tool = geminiGenerate([{ role: 'user', parts: [{ text: '幫我查今天的台股收盤' }] }], {
    systemInstruction: buildSystemPrompt('tools', today),
    tools: [SEARCH_TOOL],
  });
  console.log(`Function Calling：${JSON.stringify(tool.functionCalls)}`);
}

/** 【編輯器執行】在 Google 機房測試各搜尋引擎與網頁內文讀取 (屬性 SIM_SEARCH 可指定關鍵字) */
function testSearch() {
  const query = PropertiesService.getScriptProperties().getProperty('SIM_SEARCH') || '東華大學 陳文盛 課程';
  const engines = getSearchEngines();
  for (const name of Object.keys(engines)) {
    const results = engines[name].search(query, 4);
    console.log(`【${name}】${results.length} 筆`);
    results.forEach((r) => console.log(`  - ${r.title.slice(0, 60)}\n    ${r.url}`));
  }
  const results = search(query);
  if (results.length) {
    enrichResults(results, query);
    console.log(formatResults(results).slice(0, 3000));
  } else {
    console.warn('⚠️ 主引擎與備援皆無結果');
  }
}

// ==================== src/Format.js ====================

/**
 * Telegram 訊息格式：Markdown → Telegram HTML、長訊息切段、HTML 退回純文字
 * (逐行移植自 bot/handler.py 的 markdown_to_html / split_message / html_to_plain)
 */

// Telegram 單則訊息上限 4096 字元，保留緩衝
const TELEGRAM_MAX_LENGTH = 4000;

/** 將 Markdown 轉換為 Telegram 支援的 HTML */
function markdownToHtml(text) {
  if (!text) return '';

  // ===== 階段 0: 保護所有特殊標記 =====
  const protectedMap = {};
  let protId = 0;
  const store = (content) => {
    const key = `__PROTECTED_${protId}__`;
    protId += 1;
    protectedMap[key] = content;
    return key;
  };
  const protect = (match) => store(match);

  // 保護程式碼區塊
  text = text.replace(/```[\s\S]*?```/g, protect);
  // 保護行內程式碼
  text = text.replace(/`[^`\n]+`/g, protect);
  // 保護已有的 Telegram 支援 HTML 標籤 (其餘 < > 如 "5 < 10" 需跳脫)
  text = text.replace(
    /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|tg-spoiler|blockquote)(?:\s[^<>]*)?>/g,
    protect,
  );

  // ===== 階段 1: HTML 跳脫 =====
  text = escapeHtml(text);

  // 保護超連結與網址，避免網址內的 _ * 被斜體/粗體規則破壞
  // [text](url)：文字仍可含粗體，網址直接保護
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, label, url) => `<a href="${store(url)}">${label}</a>`,
  );
  // 純網址 (不在 href="..." 內)
  text = text.replace(/(?<!href=")https?:\/\/[^\s<>()（）。，、；：！？「」]+/g, protect);

  // ===== 階段 2: 處理 Markdown =====
  // 粗體 **text** (處理未閉合)
  const boldCount = (text.match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) text += '**';
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // 斜體 *text* 或 _text_ (Python \w 會比對中文，JS 以 \p{L}\p{N} 對應)
  text = text.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, '$1<i>$2</i>$3');
  text = text.replace(
    new RegExp(`(^|[^_\\p{L}\\p{N}])_([^_\\n]+)_([^_\\p{L}\\p{N}]|$)`, 'gu'),
    '$1<i>$2</i>$3',
  );

  // 標題 # text -> <b>text</b>
  text = text.replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>');

  // 項目符號 - * + 開頭；有縮排 (空白或 tab) 的視為子項目
  text = text.replace(/^[*\-+][ \t]+(.+)$/gm, '• $1');
  text = text.replace(/^[ \t]+[*\-+][ \t]+(.+)$/gm, '    ◦ $1');

  // 分割線
  text = text.replace(/^---+$/gm, '──────────────');

  // ===== 階段 3: 還原受保護內容 =====
  const restoreProtected = (key) => {
    if (!(key in protectedMap)) return key;
    const content = protectedMap[key];
    // 程式碼區塊
    if (content.startsWith('```') && content.endsWith('```')) {
      let code = content.slice(3, -3);
      // 移除語言指定符
      const lines = code.split('\n');
      if (lines.length && lines[0].trim() && !lines[0].trim().includes(' ')) {
        code = lines.slice(1).join('\n');
      }
      return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
    }
    // 行內程式碼
    if (content.startsWith('`') && content.endsWith('`')) {
      return `<code>${escapeHtml(content.slice(1, -1))}</code>`;
    }
    // HTML 標籤、網址直接還原
    return content;
  };

  // 受保護內容可能互相巢狀 (如連結文字含行內程式碼)，重複還原
  for (let i = 0; i < 3; i++) {
    const restored = text.replace(/__PROTECTED_\d+__/g, restoreProtected);
    if (restored === text) break;
    text = restored;
  }

  return text;
}

/** 依換行切割過長訊息，單行超長則硬切 */
function splitMessage(text, limit) {
  limit = limit || TELEGRAM_MAX_LENGTH;
  if (text.length <= limit) return [text];

  const chunks = [];
  let current = '';
  for (let line of text.split('\n')) {
    while (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** 移除 HTML 標籤並還原實體 (HTML 解析失敗時的退路) */
function htmlToPlain(text) {
  return decodeHtmlEntities(String(text).replace(/<[^>]+>/g, ''));
}

// ==================== src/Gemini.js ====================

/**
 * Gemini API 客戶端 - 支援 Function Calling (移植自 llm/ollama_client.py)
 * 內部訊息直接使用 Gemini 原生 contents 格式：
 *   {role: 'user' | 'model', parts: [{text} | {functionCall} | {functionResponse}]}
 * Gemini 3 會在 functionCall part 附上 thoughtSignature，必須原封不動送回，
 * 所以工具循環直接把模型回傳的 content 加回 contents，不做轉換。
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// 429 回傳的建議等待秒數超過此值就不重試 (避免 Telegram 等太久)
const GEMINI_MAX_RETRY_DELAY_SECONDS = 20;
// 這些狀態改用下一個備援模型：429 額度用完、503 模型過載
const GEMINI_FALLBACK_STATUSES = [429, 503];
const GEMINI_EXHAUSTED_CACHE_PREFIX = 'gemini_exhausted_';

// 搜尋工具定義 (Function Calling)
const SEARCH_TOOL = {
  name: 'search_web',
  description:
    '搜尋網路資訊。用於：即時資料 (新聞、今天/最近發生的事、天氣、股價、匯率、比賽結果)、' +
    '特定人物/學校/公司/店家/產品的具體資料 (開課、聯絡方式、價格、營業時間、規格)、' +
    '地方資訊 (景點、美食、住宿、交通、活動)，' +
    '以及使用者明確要求「查/搜尋/找」的內容。' +
    '程式、數學、翻譯、寫作、概念解釋、歷史常識、閒聊等問題請直接回答，不要呼叫此工具。',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description:
          '搜尋關鍵字，請提取核心實體名詞，避免包含「請問」、「怎麼樣」等贅詞。' +
          '例如：「台灣 亞運 金牌」而非「請問台灣在亞運獲得多少金牌」',
      },
    },
    required: ['query'],
  },
};

// 系統提示詞 ({today}、{search_rules} 由 buildSystemPrompt 填入)
const SYSTEM_PROMPT = `你是專業、友善且樂於助人的智慧助理，請用清晰、有條理且自然的繁體中文回答 (使用者要求翻譯或指定其他語言時，依其要求輸出)。
今天日期：{today}

{search_rules}

【搜尋後如何回答】
- 搜尋結果只是參考資料，請直接回答使用者原本的問題，用自己的話整理
- 不要說「我選擇結果 1」、「根據搜尋結果」之類的話，也不要列出來源或連結 (系統會自動附上)
- 搜尋結果含「內文摘錄」時以內文為準，完整列出相關項目 (例如全部課程)，不要只挑一兩項
- 同名同姓時，只採用與使用者描述相符 (單位、系所) 的資料
- 問題指定學期、年份或日期 (如 115-1、2026 年) 時，只列出符合該時間的資料，不要混入其他學期的舊資料
- 若搜尋結果與問題無關，忽略它，改用自己的知識回答並說明無法取得即時資料

【回答格式】
- 直接回應使用者的要求，例如翻譯就只給譯文
- 數學計算先逐步列出過程 (例如把乘數拆開：123 × 456 = 123 × 400 + 123 × 56)，最後再給答案
- 內容較多時，重點用條列式與粗體標題；清單每項一行為主，只補充使用者需要的細節
- 不要在每一項附網址 (系統會在最後附來源)，保持精簡，避免冗長重複
- 程式碼放在 \`\`\` 程式碼區塊中
`;

// tools 模式：模型自己決定何時呼叫 search_web
const SEARCH_RULES_TOOLS = `【何時搜尋】
預設直接用你自己的知識回答。以下情況才呼叫 \`search_web\`：
- 即時資料：新聞、今天/近期事件、天氣、股價、匯率、比賽結果
- 特定對象的具體資料：某位老師開的課、某間學校/公司/店家的聯絡方式、價格、營業時間、產品規格 (你不可能確實知道，不要猜)
- 地方資訊：某地的景點、美食、餐廳、住宿、交通、活動推薦
- 使用者明確要求「幫我查」「搜尋」「找一下」
- 不要搜尋：寫程式、數學計算、翻譯、寫作、解釋概念或原理、歷史與常識、打招呼閒聊、比較或分析使用者提供的內容`;

// router 模式：搜尋已由 decideSearch 決定，回答階段沒有工具可用
const SEARCH_RULES_ROUTER = `【搜尋】
系統會在需要時先搜尋並把結果提供給你；沒有搜尋結果時，直接用你自己的知識完整回答。`;

// 搜尋判斷 (router 模式)：先讓模型輸出 JSON 決定要不要搜尋，再回答
const ROUTER_PROMPT = `今天日期：{today}
判斷回答使用者最新的問題是否需要上網搜尋即時資訊 (可參考前文理解指代)。
需要搜尋 (need_search=true)：
- 即時資料：新聞、今天/最近發生的事、天氣、股價、匯率、比賽結果
- 特定人物、學校、公司、店家、產品的具體資料：開設課程、聯絡方式、價格、營業時間、規格、最新動態
- 地方資訊：某地的景點、美食、餐廳、住宿、交通、活動推薦
- 使用者明確要求「查」「搜尋」「找」
不需要搜尋：寫程式、數學、翻譯、寫作、解釋概念、歷史常識、閒聊、分析使用者提供的內容。
query 規則：保留能鎖定對象的專有名詞 (人名、單位、學校)，例如「東華大學 陳文盛 課程」。
只輸出 JSON：{"need_search": true 或 false, "query": "搜尋關鍵字，不需要時為空字串"}`;

const ROUTER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    need_search: { type: 'BOOLEAN' },
    query: { type: 'STRING' },
  },
  required: ['need_search', 'query'],
};

// router 模式把搜尋結果附在使用者訊息後面的前導語
const ROUTER_RESULTS_PREFIX = '（系統已為這個問題上網搜尋，以下為搜尋結果，請參考後回答上面的問題）\n';

/** Gemini API 錯誤 (status = HTTP 狀態碼；0 表示連線失敗 / 逾時) */
class GeminiError extends Error {
  constructor(message, status, retryDelaySeconds) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.retryDelaySeconds = retryDelaySeconds || 0;
  }
}

/** 產生含今日日期與搜尋規則的系統提示詞 */
function buildSystemPrompt(decision, today) {
  const rules = decision === 'tools' ? SEARCH_RULES_TOOLS : SEARCH_RULES_ROUTER;
  return SYSTEM_PROMPT.replace('{today}', today).replace('{search_rules}', rules);
}

/** 對話歷史 ({role: user|assistant, content}) → Gemini contents */
function historyToContents(history) {
  return (history || []).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

/** 取出候選回覆的文字 (略過思考摘要) */
function extractCandidateText(content) {
  const parts = (content && content.parts) || [];
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

/** 取出 functionCall 清單：[{id, name, args}] */
function extractFunctionCalls(content) {
  const parts = (content && content.parts) || [];
  return parts
    .filter((p) => p.functionCall)
    .map((p) => ({
      id: p.functionCall.id || '',
      name: p.functionCall.name,
      args: p.functionCall.args && typeof p.functionCall.args === 'object' ? p.functionCall.args : {},
    }));
}

/** 解析 router 輸出的 JSON；失敗視為不搜尋 */
function parseRouterDecision(text) {
  try {
    // 偶爾模型仍包上 ```json ... ```
    const cleaned = String(text || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
    const data = JSON.parse(cleaned);
    return {
      need_search: data.need_search === true || data.need_search === 'true',
      query: String(data.query || '').trim(),
    };
  } catch (e) {
    console.warn(`搜尋判斷 JSON 解析失敗，視為不搜尋: ${JSON.stringify(text)}`);
    return { need_search: false, query: '' };
  }
}

/** 累加 token 用量 (usageMetadata) */
function addUsage(total, usage) {
  if (!usage) return total;
  for (const key of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']) {
    if (usage[key]) total[key] = (total[key] || 0) + usage[key];
  }
  return total;
}

/** 從 429 錯誤內容取出建議等待秒數 (RetryInfo.retryDelay，如 "17s") */
function parseRetryDelaySeconds(errorBody) {
  const details = (errorBody && errorBody.error && errorBody.error.details) || [];
  for (const d of details) {
    if (d.retryDelay) {
      const n = parseFloat(String(d.retryDelay));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
}

/**
 * 呼叫 Gemini REST API；429 / 5xx 依 GEMINI_RETRIES 重試
 * allowRetry=false：還有備援模型時不等待重試，直接交給呼叫者換模型
 */
function geminiRequest_(path, method, payload, allowRetry) {
  if (allowRetry === undefined) allowRetry = true;
  const cfg = getConfig();
  if (!cfg.GEMINI_API_KEY) throw new GeminiError('GEMINI_API_KEY 未設定', 401);
  const options = {
    method: method,
    headers: { 'x-goog-api-key': cfg.GEMINI_API_KEY },
    muteHttpExceptions: true,
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  for (let attempt = 0; ; attempt++) {
    let resp;
    try {
      resp = UrlFetchApp.fetch(`${GEMINI_API_BASE}/${path}`, options);
    } catch (e) {
      throw new GeminiError(`Gemini 連線失敗: ${e.message || e}`, 0);
    }
    const code = resp.getResponseCode();
    const text = resp.getContentText();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (e) {
      body = null;
    }
    if (code >= 200 && code < 300 && body) return body;

    const message = (body && body.error && body.error.message) || text.slice(0, 300);
    const retryDelay = code === 429 ? parseRetryDelaySeconds(body) : 0;
    const retryable = code === 429 || code >= 500;
    if (allowRetry && retryable && attempt < cfg.GEMINI_RETRIES && retryDelay <= GEMINI_MAX_RETRY_DELAY_SECONDS) {
      const waitSeconds = retryDelay || 2 * (attempt + 1);
      console.warn(`Gemini HTTP ${code}，${waitSeconds} 秒後重試: ${message}`);
      Utilities.sleep(Math.ceil(waitSeconds * 1000));
      continue;
    }
    console.error(`Gemini HTTP 錯誤: ${code} - ${message}`);
    throw new GeminiError(message, code, retryDelay);
  }
}

/** 模型暫停使用的秒數：每日額度用完或建議等待很久 → 1 小時；每分鐘限制 → 建議等待秒數 */
function geminiExhaustedSeconds(err) {
  if (err.status === 503) return 60;
  if (/per ?day|daily/i.test(err.message || '') || err.retryDelaySeconds > 60) return 3600;
  return Math.max(Math.ceil(err.retryDelaySeconds || 60), 10);
}

function markGeminiModelExhausted_(model, err) {
  const seconds = geminiExhaustedSeconds(err);
  CacheService.getScriptCache().put(GEMINI_EXHAUSTED_CACHE_PREFIX + model, '1', seconds);
  traceWarn(`⏸️ ${model} 暫停使用 ${seconds} 秒 (HTTP ${err.status})`);
}

/** 依序排列要嘗試的模型：最近額度用完的排到後面 (全部用完時仍會照順序嘗試) */
function orderGeminiModels_(models) {
  const cache = CacheService.getScriptCache();
  const exhausted = (m) => Boolean(cache.get(GEMINI_EXHAUSTED_CACHE_PREFIX + m));
  return models.filter((m) => !exhausted(m)).concat(models.filter(exhausted));
}

/**
 * 依序嘗試模型呼叫 generateContent：遇 429 / 503 改用下一個備援模型
 * 回傳 {data, model}
 */
function generateWithFallback_(models, payload) {
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const isLast = i === models.length - 1;
    try {
      const path = `models/${encodeURIComponent(model)}:generateContent`;
      return { data: geminiRequest_(path, 'post', payload, isLast), model: model };
    } catch (e) {
      const switchable = e instanceof GeminiError && GEMINI_FALLBACK_STATUSES.includes(e.status);
      if (switchable) markGeminiModelExhausted_(model, e);
      if (!switchable || isLast) throw e;
      traceWarn(`↪️ 改用備援模型 ${models[i + 1]}`);
    }
  }
  throw new GeminiError('沒有可用的 Gemini 模型', 404);
}

/**
 * 支援 Function Calling 的對話
 * options: {systemInstruction, tools (functionDeclarations 陣列), toolMode, maxTokens, responseSchema, model}
 * 未指定 options.model 時依 GEMINI_MODEL → GEMINI_FALLBACK_MODELS 順序嘗試
 * 回傳: {content, text, functionCalls, usage, finishReason, model (實際使用的模型)}
 */
function geminiGenerate(contents, options) {
  options = options || {};
  const cfg = getConfig();
  const payload = {
    contents: contents,
    // Gemini 3 建議維持預設 temperature (1.0)，調低可能造成重複或推理變差，所以不設定
    generationConfig: { maxOutputTokens: options.maxTokens || cfg.GEMINI_MAX_OUTPUT_TOKENS },
  };
  if (options.systemInstruction) {
    payload.systemInstruction = { parts: [{ text: options.systemInstruction }] };
  }
  if (options.tools && options.tools.length) {
    payload.tools = [{ functionDeclarations: options.tools }];
    // NONE：contents 已含工具呼叫但要求模型直接回答 (工具循環達上限時)
    payload.toolConfig = { functionCallingConfig: { mode: options.toolMode || 'AUTO' } };
  }
  if (options.responseSchema) {
    payload.generationConfig.responseMimeType = 'application/json';
    payload.generationConfig.responseSchema = options.responseSchema;
  }

  const models = options.model ? [options.model] : orderGeminiModels_(cfg.GEMINI_MODELS);
  const { data, model } = generateWithFallback_(models, payload);
  const candidate = (data.candidates || [])[0];
  if (!candidate) {
    const reason = (data.promptFeedback && data.promptFeedback.blockReason) || '無候選回覆';
    console.warn(`Gemini 未產生回覆: ${reason}`);
    return { content: null, text: '', functionCalls: [], usage: data.usageMetadata, finishReason: reason, model };
  }
  const content = candidate.content || { role: 'model', parts: [] };
  if (!content.role) content.role = 'model';
  return {
    content: content,
    text: extractCandidateText(content),
    functionCalls: extractFunctionCalls(content),
    usage: data.usageMetadata,
    finishReason: candidate.finishReason || '',
    model: model,
  };
}

/**
 * 讓模型判斷是否需要搜尋 (router 模式)
 * contents: 最近幾輪對話 + 使用者問題 (Gemini contents 格式)
 * 回傳: {need_search, query, usage, model}；解析失敗視為不搜尋
 */
function decideSearch(contents, today) {
  const result = geminiGenerate(contents, {
    systemInstruction: ROUTER_PROMPT.replace('{today}', today),
    responseSchema: ROUTER_SCHEMA,
    maxTokens: 1024,
  });
  const decision = parseRouterDecision(result.text);
  decision.usage = result.usage;
  decision.model = result.model;
  return decision;
}

/** 列出可用於 generateContent 的模型 */
function listGeminiModels() {
  const models = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const query = `models?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const data = geminiRequest_(query, 'get', null);
    for (const m of data.models || []) {
      if ((m.supportedGenerationMethods || []).includes('generateContent')) {
        models.push({
          name: String(m.name || '').replace(/^models\//, ''),
          displayName: m.displayName || '',
          inputTokenLimit: m.inputTokenLimit || 0,
        });
      }
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return models;
}

// ==================== src/Handler.js ====================

/**
 * Telegram Bot 主處理器 - 整合對話、搜尋、LLM 呼叫 (移植自 bot/handler.py)
 * ctx (對話情境) 由 createTelegramContext / 模擬模式提供：
 *   {updateId, chatId, userId, firstName, userName, statusMessageId, reply(), edit(), typing()}
 */

const MAX_TOOL_ROUNDS = 3;
const HTML = 'HTML';

// ===== 訊息發送 =====

/** 發送或更新狀態訊息 */
function sendStatus(ctx, text) {
  if (ctx.statusMessageId && ctx.edit(ctx.statusMessageId, text, HTML)) return;
  // 編輯失敗則發送新訊息
  const id = ctx.reply(text, HTML);
  if (id) ctx.statusMessageId = id;
  else console.warn('發送狀態訊息失敗');
}

/** 發送最終回覆 (替換狀態訊息，過長自動分段) */
function sendFinalResponse(ctx, text) {
  captureRelayReply_(text);
  const statusId = ctx.statusMessageId;
  ctx.statusMessageId = null;
  const chunks = splitMessage(text);
  chunks.forEach((chunk, i) => {
    if (i === 0 && statusId) {
      if (ctx.edit(statusId, chunk, HTML)) return;
      console.warn('編輯訊息失敗，改發送新訊息');
    }
    if (!ctx.reply(chunk, HTML)) console.error(`發送回覆失敗 (第 ${i + 1}/${chunks.length} 段)`);
  });
}

/** 發送錯誤訊息 */
function sendError(ctx, text) {
  sendFinalResponse(ctx, `❌ <b>錯誤</b>\n\n${text}`);
}

/** 檢查白名單，未授權則回覆並回傳 false */
function ensureAuthorized(ctx) {
  if (isUserAuthorized(ctx.userId)) return true;
  console.log(`User ${ctx.userId} not authorized`);
  ctx.reply(
    '⛔ <b>存取受限</b>\n\n' +
    '抱歉，您尚未加入授權白名單。\n' +
    `您的 Telegram User ID：<code>${ctx.userId}</code>\n\n` +
    '請聯繫管理員將您的 ID 加入 <code>ALLOWED_USER_IDS</code>。',
    HTML,
  );
  return false;
}

// ===== 指令處理器 =====

function cmdStart(ctx) {
  const cfg = getConfig();
  ctx.reply(
    '👋 <b>歡迎使用雲端 AI 助理！</b>\n\n' +
    `你好，${escapeHtml(ctx.firstName)}！我是運行在 Google Apps Script 上的 AI 助理。\n\n` +
    '🔧 <b>技術架構：</b>\n' +
    `• 模型：<code>${escapeHtml(cfg.GEMINI_MODEL)}</code> (via Gemini API)\n` +
    `• 搜尋：<code>${escapeHtml(cfg.SEARCH_ENGINE)}</code>\n` +
    `• 對話記憶：最近 ${cfg.MAX_HISTORY_TURNS} 輪\n\n` +
    '📌 <b>常用指令：</b>\n' +
    '/search <code>關鍵字</code> - 即時搜尋並總結\n' +
    '/news - 查看最新新聞頭條\n' +
    '/status - 查詢今日剩餘額度\n' +
    '/reset - 清除對話記憶\n' +
    '/models - 列出可用的 Gemini 模型\n' +
    '/help - 顯示完整說明\n\n' +
    '請直接傳送文字向我提問！',
    HTML,
  );
}

function cmdHelp(ctx) {
  ctx.reply(
    '📖 <b>雲端 AI 助理使用說明</b>\n\n' +
    '• <b>一般提問</b>：直接輸入問題，我會根據上下文回答\n' +
    '• <b>自動搜尋</b>：需要即時資訊 (新聞、天氣、特定人物或店家資料) 時，我會自動搜尋網路\n' +
    '• <b>/search <code>關鍵字</code></b>：主動搜尋特定主題\n' +
    '• <b>/news</b>：瀏覽最新新聞頭條\n' +
    '• <b>/status</b>：查看今日已用/剩餘額度\n' +
    '• <b>/reset</b>：清除對話記憶，開啟新話題\n' +
    '• <b>/models</b>：查看可用的 Gemini 模型\n' +
    '• <b>/help</b>：顯示本說明',
    HTML,
  );
}

function cmdStatus(ctx) {
  if (!ensureAuthorized(ctx)) return;
  const status = getQuotaStatus(ctx.userId);
  ctx.reply(
    '📊 <b>今日使用額度</b>\n\n' +
    `📅 日期：${status.date}\n` +
    `📈 已使用：<b>${status.current}</b> 次\n` +
    `🎯 剩餘：<b>${status.remaining}</b> 次\n` +
    `🔒 每日上限：${status.max} 次\n\n` +
    '<i>額度於每日午夜 00:00 自動重置</i>',
    HTML,
  );
}

function cmdReset(ctx) {
  if (!ensureAuthorized(ctx)) return;
  clearConversationHistory(ctx.userId);
  ctx.reply('🧹 <b>對話記憶已清空！</b>\n\n接下來的提問將以全新視角為您解答。', HTML);
}

function cmdModels(ctx) {
  if (!ensureAuthorized(ctx)) return;
  const cfg = getConfig();
  const current = cfg.GEMINI_MODEL;
  const fallbacks = cfg.GEMINI_MODELS.slice(1);
  sendStatus(ctx, '🔍 正在查詢可用的 Gemini 模型...');
  try {
    const models = listGeminiModels();
    if (!models.length) {
      sendFinalResponse(ctx, '⚠️ 查無可用模型，請確認 <code>GEMINI_API_KEY</code> 是否正確');
      return;
    }
    const lines = ['📦 <b>可用的 Gemini 模型：</b>\n'];
    for (const m of models) {
      const mark = m.name === current ? ' 👉' : fallbacks.includes(m.name) ? ' ↪️' : '';
      const ctxSize = m.inputTokenLimit ? ` (${Math.round(m.inputTokenLimit / 1000)}K)` : '';
      lines.push(`• <code>${escapeHtml(m.name)}</code>${ctxSize}${mark}`);
    }
    lines.push(`\n目前使用：<b>${escapeHtml(current)}</b>`);
    if (fallbacks.length) lines.push(`額度用完時依序改用：${fallbacks.map(escapeHtml).join(' → ')}`);
    lines.push('\n💡 切換模型：修改指令碼屬性 <code>GEMINI_MODEL</code> / <code>GEMINI_FALLBACK_MODELS</code> (下一則訊息即生效)');
    sendFinalResponse(ctx, lines.join('\n'));
  } catch (e) {
    console.error(`查詢模型失敗: ${e.stack || e}`);
    sendError(ctx, `查詢模型失敗: ${escapeHtml(String(e.message || e))}`);
  }
}

function cmdSearch(ctx, args) {
  if (!ensureAuthorized(ctx)) return;
  // 先檢查參數，空查詢不扣額度
  const query = (args || '').trim();
  if (!query) {
    ctx.reply('請提供搜尋關鍵字，例如：<code>/search 台灣 亞運 金牌</code>', HTML);
    return;
  }
  const quota = checkAndConsumeQuota(ctx.userId);
  if (!quota.allowed) {
    sendError(ctx, quota.message);
    return;
  }
  processQuery(ctx, query, quota);
}

function cmdNews(ctx) {
  if (!ensureAuthorized(ctx)) return;
  const quota = checkAndConsumeQuota(ctx.userId);
  if (!quota.allowed) {
    sendError(ctx, quota.message);
    return;
  }
  processQuery(ctx, '最新新聞頭條', quota);
}

/** 處理一般文字訊息 */
function handleMessage(ctx, text) {
  if (!ensureAuthorized(ctx)) return;
  if (!text) return;
  const quota = checkAndConsumeQuota(ctx.userId);
  if (!quota.allowed) {
    sendError(ctx, quota.message);
    return;
  }
  processQuery(ctx, text, quota);
}

/** 解析指令：「/search@MyBot 台灣」→ {command: 'search', args: '台灣'}；非指令回傳 null */
function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text || '');
  if (!m) return null;
  return { command: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

const COMMAND_HANDLERS = {
  start: cmdStart,
  help: cmdHelp,
  status: cmdStatus,
  reset: cmdReset,
  models: cmdModels,
  search: cmdSearch,
  news: cmdNews,
};

/** Telegram update 路由 (只處理文字訊息；未知指令忽略，同 Python 版的 ~filters.COMMAND) */
function handleUpdate(update) {
  const message = update && update.message;
  if (!message || typeof message.text !== 'string' || !message.chat) return;
  const ctx = createTelegramContext(update);
  routeText(ctx, message.text.trim());
}

function routeText(ctx, text) {
  const cmd = parseCommand(text);
  if (cmd) {
    const handler = COMMAND_HANDLERS[cmd.command];
    if (handler) handler(ctx, cmd.args);
    else console.log(`忽略未知指令: /${cmd.command}`);
    return;
  }
  handleMessage(ctx, text);
}

// ===== 核心處理邏輯 =====

/** Gemini 錯誤 → 給使用者的友善訊息 */
function geminiErrorMessage(err) {
  const model = escapeHtml(getConfig().GEMINI_MODEL);
  switch (err.status) {
    case 0:
      return '無法連線到 Gemini API，請稍後再試。本次不計入額度。';
    case 429:
      return 'Gemini API 使用量已達上限 (主模型與備援模型的免費額度都已用完)，請稍後再試。本次不計入額度。';
    case 503:
      return 'Gemini 模型目前過載，請稍後再試。本次不計入額度。';
    case 400:
      if (/api key/i.test(err.message)) return '<code>GEMINI_API_KEY</code> 無效，請管理員確認設定。';
      return 'Gemini 無法處理這個請求，請換個問法再試。本次不計入額度。';
    case 401:
    case 403:
      return '<code>GEMINI_API_KEY</code> 無效或沒有權限，請管理員確認設定。';
    case 404:
      return `找不到模型 <code>${model}</code>，請用 /models 查看可用模型並修改 <code>GEMINI_MODEL</code>。`;
    default:
      return 'Gemini 服務暫時無法使用，請稍後再試。本次不計入額度。';
  }
}

/** 處理使用者查詢；失敗時回覆友善訊息並退還額度 */
function processQuery(ctx, userQuery, quota) {
  ctx.typing();
  try {
    runQuery(ctx, userQuery, quota);
  } catch (e) {
    console.error(`處理查詢失敗: ${e.stack || e}`);
    refundQuota(ctx.userId);
    if (e instanceof GeminiError) sendError(ctx, geminiErrorMessage(e));
    else sendError(ctx, '處理您的問題時發生錯誤，請稍後再試。本次不計入額度。');
  } finally {
    ctx.statusMessageId = null;
  }
}

/** 執行 search_web，回傳 {content: 給模型的內容, record: 搜尋紀錄 | null}；失敗不中斷流程 */
function runSearchTool(args) {
  const query = String((args && args.query) || '').trim();
  if (!query) return { content: '錯誤：search_web 需要 query 參數', record: null };
  traceLog(`🔧 模型呼叫搜尋: "${query}"`);
  const cfg = getConfig();
  let results;
  try {
    results = search(query, cfg.SEARCH_MAX_RESULTS);
  } catch (e) {
    console.error(`搜尋失敗: ${query}: ${e.stack || e}`);
    return { content: '（搜尋失敗，請根據既有知識回答並說明無法取得即時資料）', record: null };
  }
  if (results.length && cfg.SEARCH_FETCH_PAGES > 0) {
    try {
      enrichResults(results, query);
    } catch (e) {
      console.error(`讀取網頁內文失敗，改用搜尋摘要: ${e.stack || e}`);
    }
  }
  const formatted = formatResults(results);
  return { content: formatted, record: { query, results, formatted } };
}

/** 搜尋判斷 (router / tools) + 最終回答 */
function runQuery(ctx, userQuery, quota) {
  const started = Date.now();
  const cfg = getConfig();
  const today = getTodayDateStr();
  const usage = {};

  // 發送初始狀態
  sendStatus(ctx, '🤔 思考中...');

  // 取得對話歷史並構建訊息
  const history = getConversationHistory(ctx.userId);
  const systemInstruction = buildSystemPrompt(cfg.SEARCH_DECISION, today);
  const contents = historyToContents(history).concat([{ role: 'user', parts: [{ text: userQuery }] }]);
  const toolResults = [];

  let reply = null;
  // 最終回答實際使用的模型 (可能是備援模型)，顯示在頁尾
  let answerModel = cfg.GEMINI_MODEL;
  if (cfg.SEARCH_DECISION === 'router') {
    routerSearch(ctx, history, userQuery, contents, toolResults, usage, today);
  } else {
    const loop = toolLoop(ctx, contents, toolResults, usage, systemInstruction);
    reply = loop.reply;
    answerModel = loop.model || answerModel;
  }

  if (reply === null) {
    // 依 contents (含搜尋結果) 產生最終回答，此時不再讓模型呼叫工具
    if (toolResults.length) {
      sendStatus(ctx, '🧠 整理回答中...');
      ctx.typing();
    }
    const usesTools = contents.some((c) => c.parts.some((p) => p.functionCall));
    const final = geminiGenerate(contents, {
      systemInstruction,
      tools: usesTools ? [SEARCH_TOOL] : null,
      toolMode: 'NONE',
    });
    addUsage(usage, final.usage);
    reply = final.text;
    answerModel = final.model;
  }

  if (!reply) {
    refundQuota(ctx.userId);
    sendError(ctx, '模型未產生回覆，本次不計入額度。');
    return;
  }

  finalizeResponse(ctx, userQuery, reply, toolResults, quota, usage, (Date.now() - started) / 1000, answerModel);
}

/** router 模式：模型先判斷要不要搜尋，需要則搜尋並把結果附在使用者訊息後 */
function routerSearch(ctx, history, userQuery, contents, toolResults, usage, today) {
  // 帶最近 2 輪對話，讓「那明天呢？」這類追問也能判斷
  const recent = historyToContents(history.slice(-4)).concat([{ role: 'user', parts: [{ text: userQuery }] }]);
  const decision = decideSearch(recent, today);
  addUsage(usage, decision.usage);
  traceLog(`🧭 搜尋判斷: ${JSON.stringify({ need_search: decision.need_search, query: decision.query })}`);
  if (!decision.need_search) return;

  const query = decision.query || userQuery;
  sendStatus(ctx, '🔍 正在搜尋資訊...');
  const { content, record } = runSearchTool({ query });
  if (record) toolResults.push(record);
  // Gemini 3 的 functionCall 需附模型產生的 thoughtSignature，無法自行偽造工具呼叫，
  // 所以把搜尋結果作為使用者訊息的附加段落
  contents[contents.length - 1].parts.push({ text: ROUTER_RESULTS_PREFIX + content });
}

/**
 * tools 模式：原生 Function Calling 循環 (最多 3 輪)
 * 回傳 {reply, model}：模型不呼叫工具時 reply 為其回答；達上限則 reply 為 null 由呼叫者產生最終回答
 */
function toolLoop(ctx, contents, toolResults, usage, systemInstruction) {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = geminiGenerate(contents, { systemInstruction, tools: [SEARCH_TOOL] });
    addUsage(usage, resp.usage);

    // 沒有工具呼叫，直接回覆 (空字串交由呼叫者處理)
    if (!resp.functionCalls.length) return { reply: resp.text, model: resp.model };

    sendStatus(ctx, `🔍 正在搜尋資訊 (第 ${round + 1} 輪)...`);
    // 模型的工具呼叫原封不動加回 (含 thoughtSignature)
    contents.push(resp.content);

    const responseParts = resp.functionCalls.map((call) => {
      let content;
      if (call.name === 'search_web') {
        const res = runSearchTool(call.args);
        if (res.record) toolResults.push(res.record);
        content = res.content;
      } else {
        console.warn(`未知工具: ${call.name}`);
        content = `錯誤：未知工具 ${call.name}`;
      }
      const functionResponse = { name: call.name, response: { result: content } };
      if (call.id) functionResponse.id = call.id;
      return { functionResponse };
    });
    contents.push({ role: 'user', parts: responseParts });
  }
  return { reply: null, model: null };
}

/** 完成回覆：加上來源、模型與耗時、額度，並儲存歷史 */
function finalizeResponse(ctx, userQuery, assistantReply, toolResults, quota, usage, elapsedSeconds, model) {
  const cfg = getConfig();
  model = model || cfg.GEMINI_MODEL;
  // 格式化來源
  let sourcesText = '';
  if (toolResults.length) {
    sourcesText = '\n\n🔍 <b>搜尋來源：</b>';
    const seen = new Set();
    for (const tr of toolResults) {
      for (const r of tr.results.slice(0, 3)) {
        const url = r.url || '';
        if (url && !seen.has(url)) {
          seen.add(url);
          const title = escapeHtml((r.title || '來源').slice(0, 60));
          sourcesText += `\n• <a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${title}</a>`;
        }
      }
    }
  }

  // 加上模型、耗時與額度資訊
  const timing = elapsedSeconds !== undefined && elapsedSeconds !== null ? `${Math.round(elapsedSeconds)} 秒・` : '';
  const modelLabel = escapeHtml(model) + (model !== cfg.GEMINI_MODEL ? ' (備援)' : '');
  const footer =
    `\n\n<i>(Gemini ${modelLabel}・${timing}` +
    `本日已提問: ${quota.current}/${quota.max})</i>`;

  sendFinalResponse(ctx, markdownToHtml(assistantReply) + sourcesText + footer);

  saveConversationTurn(ctx.userId, userQuery, assistantReply);
  logInteraction({
    userId: ctx.userId,
    userName: ctx.userName,
    prompt: userQuery,
    response: assistantReply,
    tokens: usage,
    dailyCount: quota.current,
    model: model,
    source: REQUEST_SOURCE_,
  });
}

// ==================== src/Html.js ====================

/**
 * HTML 工具：實體解碼、跳脫、去標籤、屬性擷取
 * GAS 沒有 BeautifulSoup / DOM，搜尋結果與網頁內文都用這裡的 regex 工具解析
 */

const HTML_NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  times: '×', divide: '÷', yen: '¥', euro: '€', pound: '£', cent: '¢', deg: '°',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', shy: '',
};

/** 解碼 HTML/XML 實體 (具名、十進位、十六進位)，不認得的保留原樣 */
function decodeHtmlEntities(text) {
  if (!text) return '';
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!code || code > 0x10ffff) return m;
      return String.fromCodePoint(code);
    }
    const named = HTML_NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}

/** Telegram HTML 需要跳脫的三個字元 */
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 去除標籤並解碼實體，空白正規化為單一空格
 * 標籤直接移除不補空格 (同 BeautifulSoup get_text(strip=True))，避免「國立<strong>東華</strong>」變成「國立 東華」
 */
function htmlFragmentText(fragment) {
  if (!fragment) return '';
  const text = decodeHtmlEntities(String(fragment).replace(/<[^>]+>/g, ''));
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 從標籤屬性字串取出屬性值 (支援雙引號、單引號、無引號)，並解碼實體 */
function getHtmlAttr(attrs, name) {
  const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = re.exec(attrs || '');
  if (!m) return '';
  return decodeHtmlEntities(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
}

/** 列出片段中所有 <a>：[{attrs, href, cls, inner}] */
function findAnchors(fragment) {
  const anchors = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(fragment || '')) !== null) {
    anchors.push({
      attrs: m[1],
      href: getHtmlAttr(m[1], 'href'),
      cls: getHtmlAttr(m[1], 'class'),
      inner: m[2],
    });
  }
  return anchors;
}

/** 依 class 名稱找第一個元素的內部 HTML (同名標籤不巢狀時適用) */
function findElementByClass(fragment, className) {
  const re = new RegExp(
    '<([a-z0-9]+)\\b[^>]*class\\s*=\\s*["\'][^"\']*\\b' + className + '\\b[^"\']*["\'][^>]*>([\\s\\S]*?)</\\1>',
    'i',
  );
  const m = re.exec(fragment || '');
  return m ? m[2] : '';
}

/** 把 HTML 依某個開頭標記切成區塊 (每個區塊從該標記之後到下一個標記之前) */
function splitHtmlBlocks(html, startPattern) {
  const parts = String(html || '').split(startPattern);
  return parts.slice(1);
}

/** 截斷摘要 (與 Python 版一致：超過上限加 ...) */
function truncateText(text, limit) {
  return text.length > limit ? text.slice(0, limit) + '...' : text;
}

// ==================== src/Keywords.js ====================

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

// ==================== src/Main.js ====================

/**
 * 程式入口：Telegram webhook (取代 Python 版的長輪詢 bot/main.py)
 * 部署為 Web App 後，Telegram 每則訊息會 POST 到 doPost
 */

// 這次請求的來源 (webhook / relay / simulate)，寫進 Logs 分頁的 source 欄
let REQUEST_SOURCE_ = '';

const BOT_COMMANDS = [
  { command: 'start', description: '開始使用' },
  { command: 'search', description: '即時搜尋並總結' },
  { command: 'news', description: '最新新聞頭條' },
  { command: 'status', description: '今日剩餘額度' },
  { command: 'reset', description: '清除對話記憶' },
  { command: 'models', description: '可用的 Gemini 模型' },
  { command: 'help', description: '使用說明' },
];

/**
 * POST 入口
 * - ?action=ask&token=...：電腦上的轉接站送來的訊息 (主要模式，見 Relay.js)，回傳 JSON
 * - ?secret=...：Telegram webhook (GAS 獨立模式，setWebhook 設定)
 * 錯誤只寫日誌；Telegram 路徑一律回 HtmlService (HTTP 200)，見 webhookResponse_
 */
function doPost(e) {
  const params = (e && e.parameter) || {};
  if (params.action === 'ask') return relayDoPost_(e);

  let update = null;
  try {
    const cfg = getConfig();
    // GAS 讀不到 X-Telegram-Bot-Api-Secret-Token 標頭，改以網址參數驗證來源
    if (cfg.WEBHOOK_SECRET && (!e || !e.parameter || e.parameter.secret !== cfg.WEBHOOK_SECRET)) {
      console.warn('webhook secret 不符，忽略請求');
      return webhookResponse_('forbidden');
    }
    update = JSON.parse(e.postData.contents);
    // 執行作業的紀錄與 Logs 分頁都記下這則是從哪裡來的 (證明當時是 GAS 獨立模式)
    REQUEST_SOURCE_ = 'webhook';
    console.log(`📨 來源：Telegram webhook (GAS 獨立模式)，update ${update.update_id}`);
    if (isDuplicateUpdate(update.update_id)) {
      console.log(`重複的 update ${update.update_id}，略過`);
      return webhookResponse_('ok');
    }
    handleUpdate(update);
  } catch (err) {
    // 全域錯誤處理：記錄堆疊，盡量回覆使用者
    console.error(`未處理的例外: ${err.stack || err}`);
    const chatId = update && update.message && update.message.chat && update.message.chat.id;
    if (chatId) tgSendMessage(chatId, '❌ 發生未預期的錯誤，請稍後再試。', null);
  }
  return webhookResponse_('ok');
}

/**
 * 回給 Telegram webhook 的回應：必須用 HtmlService
 * ContentService 的輸出會被 GAS 302 轉址到 script.googleusercontent.com，Telegram 不跟隨轉址，
 * 視為投遞失敗並逐次拉長重試間隔，bot 會越來越慢、最後不回；HtmlService 由 script.google.com 直接回 200
 */
function webhookResponse_(text) {
  return HtmlService.createHtmlOutput(text);
}

/** 轉接站的請求：處理訊息並回傳 JSON (回覆內容與過程紀錄，讓轉接站印出)；轉接站會跟隨 302，可用 ContentService */
function relayDoPost_(e) {
  let result;
  try {
    const update = JSON.parse((e.postData && e.postData.contents) || '{}');
    REQUEST_SOURCE_ = 'relay';
    console.log(`🛰️ 來源：轉接站，update ${update.update_id}`);
    result = relayAsk(e.parameter.token, update);
  } catch (err) {
    console.error(`轉接站請求處理失敗: ${err.stack || err}`);
    result = { ok: false, error: String(err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * GET 入口
 * - ?action=recent&token=WEBHOOK_SECRET&n=5：最近 n 則提問與來源 (npm run mode 用)，回傳 JSON
 * - 其他：健康檢查，瀏覽器開啟 Web App 網址會看到這段文字 (版本字樣用來確認部署的是新版)
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.action === 'recent') {
    const secret = getConfig().WEBHOOK_SECRET;
    const result = !secret || params.token !== secret
      ? { ok: false, error: 'token 不符：.env 的 WEBHOOK_SECRET 要與 GAS 指令碼屬性相同' }
      : { ok: true, items: getRecentInteractions(Math.min(Math.max(parseInt(params.n, 10) || 5, 1), 20)) };
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput('Telegram AI Bot (Google Apps Script) is running. v2.4');
}

/**
 * 是否為 Web App 正式部署網址 (/exec 結尾)
 * 個人帳號：https://script.google.com/macros/s/<id>/exec
 * Workspace (學校、公司) 帳號：https://script.google.com/a/<網域>/macros/s/<id>/exec
 *                          或 https://script.google.com/a/macros/<網域>/s/<id>/exec
 * /dev 結尾是編輯者專用的測試網址，Telegram 無法存取
 */
function isWebAppExecUrl(url) {
  return /^https:\/\/script\.google\.com\/(?:a\/[^/]+\/macros|a\/macros\/[^/]+|macros)\/s\/[^/]+\/exec$/.test(url || '');
}

/**
 * 【編輯器執行】設定 Telegram webhook 指向這個 Web App，並註冊指令選單
 * 先「部署 → 新增部署 → 網頁應用程式」，把 /exec 網址填入 WEBHOOK_URL 屬性
 */
function setWebhook() {
  const cfg = getConfig();
  const errors = validateConfig(cfg, true);
  if (errors.length) throw new Error(`設定不完整：\n${errors.join('\n')}`);

  const url = cfg.WEBHOOK_URL;
  if (!url) {
    throw new Error('WEBHOOK_URL 未設定：請先「部署 → 新增部署作業 → 網頁應用程式」，把 /exec 結尾的網址填入指令碼屬性 WEBHOOK_URL');
  }
  if (!isWebAppExecUrl(url)) {
    const hint = url.endsWith('/dev') ? ' (/dev 是測試網址，請改用部署後拿到的 /exec 網址)' : '';
    throw new Error(`WEBHOOK_URL 需為 Web App 部署網址 (.../macros/s/.../exec)，目前：${url}${hint}`);
  }

  let secret = cfg.WEBHOOK_SECRET;
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '');
    PropertiesService.getScriptProperties().setProperty('WEBHOOK_SECRET', secret);
    cfg.WEBHOOK_SECRET = secret;
  }

  const res = telegramApi('setWebhook', {
    url: `${url}?secret=${secret}`,
    allowed_updates: ['message'],
    drop_pending_updates: true,
    max_connections: 10,
  });
  if (!res.ok) throw new Error(`setWebhook 失敗: ${res.description}`);
  console.log(`✅ Webhook 已設定：${url}`);

  const cmds = telegramApi('setMyCommands', { commands: BOT_COMMANDS });
  console.log(cmds.ok ? '✅ 指令選單已註冊' : `⚠️ 指令選單註冊失敗: ${cmds.description}`);
  getWebhookInfo();
}

/** 【編輯器執行】移除 webhook (改回 Python 長輪詢版前必須執行，否則會 Conflict) */
function deleteWebhook() {
  const res = telegramApi('deleteWebhook', { drop_pending_updates: true });
  console.log(res.ok ? '✅ Webhook 已移除' : `❌ 移除失敗: ${res.description}`);
}

/** 【編輯器執行】查看 webhook 狀態 (pending 數量、最後錯誤) */
function getWebhookInfo() {
  const res = telegramApi('getWebhookInfo', {});
  if (!res.ok) {
    console.error(`❌ 查詢失敗: ${res.description}`);
    return null;
  }
  const info = res.result;
  // 不印出含 secret 的完整網址
  console.log(`網址：${String(info.url || '(未設定)').replace(/\?secret=.*/, '?secret=****')}`);
  console.log(`待處理更新：${info.pending_update_count}`);
  if (info.last_error_message) {
    const when = info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : '';
    console.log(`最後錯誤：${info.last_error_message} (${when})`);
  }
  return info;
}

// ==================== src/PageFetch.js ====================

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
  traceLog(`📄 已讀取 ${targets.filter((r) => r.content).length}/${targets.length} 個網頁內文`);
  return results;
}

// ==================== src/Relay.js ====================

/**
 * 轉接站介面：電腦上的轉接站 (relay/relay.js) 把 Telegram 訊息交給 GAS 回答
 *
 *   📱 Telegram ◀──getUpdates 長輪詢── 💻 轉接站 (你的電腦，印出每一題)
 *                                          │ POST ?action=ask&token=WEBHOOK_SECRET
 *                                          ▼
 *                                   ☁️ GAS doPost → 搜尋 + Gemini → 回覆 Telegram
 *                                          │ 回傳 {replies, logs} 給轉接站印出
 *
 * 轉接站模式讓每一題、搜尋過程與回覆即時印在電腦視窗；轉接站關掉時 webhook 設回 GAS (GAS 獨立模式)，
 * Telegram 直接送到 doPost 處理，兩種模式都穩定 (webhook 回應用 HtmlService，見 Main.js webhookResponse_)。
 */

let RELAY_CAPTURE_ = null;

/** 處理轉接站送來的 update，回傳 {ok, replies, logs, seconds} */
function relayAsk(token, update) {
  const secret = getConfig().WEBHOOK_SECRET;
  if (!secret || token !== secret) {
    console.warn('轉接站 token 不符，拒絕');
    return { ok: false, error: 'token 不符：轉接站 .env 的 WEBHOOK_SECRET 要與 GAS 指令碼屬性相同' };
  }
  if (!update || !update.message) return { ok: false, error: '缺少 Telegram update' };
  if (isDuplicateUpdate(update.update_id)) return { ok: true, duplicate: true, replies: [], logs: [] };

  const started = Date.now();
  const capture = { replies: [], messages: [], logs: [] };
  RELAY_CAPTURE_ = capture;
  try {
    handleUpdate(update);
  } finally {
    RELAY_CAPTURE_ = null;
  }
  return {
    ok: true,
    // 最終回覆；指令 (/start 等) 沒有經過 sendFinalResponse，改用最後一則送出的訊息
    replies: capture.replies.length ? capture.replies : capture.messages.slice(-1),
    logs: capture.logs,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

/** 記錄最終回覆 (純文字) 給轉接站印出 */
function captureRelayReply_(html) {
  if (RELAY_CAPTURE_) RELAY_CAPTURE_.replies.push(htmlToPlain(html));
}

/** 記錄送到 Telegram 的每則訊息 (含狀態訊息) */
function captureRelayMessage_(html) {
  if (RELAY_CAPTURE_) RELAY_CAPTURE_.messages.push(htmlToPlain(html));
}

/**
 * 處理過程的重點紀錄 (搜尋判斷、搜尋引擎、讀網頁、換模型)：寫入日誌，並在轉接站請求時一併回傳印出
 * GAS 不允許覆寫 console，所以這些步驟改呼叫 traceLog / traceWarn
 */
function traceLog(message) {
  console.log(message);
  if (RELAY_CAPTURE_) RELAY_CAPTURE_.logs.push(message);
}

function traceWarn(message) {
  console.warn(message);
  if (RELAY_CAPTURE_) RELAY_CAPTURE_.logs.push(message);
}

// ==================== src/Search.js ====================

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
  traceLog(`🔍 使用搜尋引擎: ${eng.name}`);
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
    traceWarn(`↪️ ${name} 無結果，改用備援搜尋引擎: ${fallback}`);
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

// ==================== src/SearchDuckDuckGo.js ====================

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

  traceLog(`🔍 [DuckDuckGo] 搜尋關鍵字: "${keywords}"`);
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
      traceWarn(
        `🚫 [DuckDuckGo] 被機器人驗證擋下 (HTTP ${code})，${DDG_BLOCK_COOLDOWN_SECONDS / 60} 分鐘內暫停使用`,
      );
      return [];
    }
    if (code < 200 || code >= 300) {
      console.error(`❌ [DuckDuckGo] HTTP ${code}`);
      return [];
    }

    const results = parseDuckDuckGoHtml(text, maxResults);
    traceLog(`✅ [DuckDuckGo] 取得 ${results.length} 筆結果`);
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

// ==================== src/SearchGoogleNews.js ====================

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
  traceLog(`🔍 [GoogleNews] 搜尋關鍵字: "${keyword}"`);
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

// ==================== src/SearchMulti.js ====================

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
  traceLog(`🔍 [multi] 搜尋關鍵字: "${keywords}"`);
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
        traceWarn(`⚠️ [multi] ${backend.name} HTTP ${code}，換下一個引擎`);
        continue;
      }
      const results = backend.parse(resp.getContentText(), maxResults);
      if (results.length) {
        traceLog(`✅ [multi] ${backend.name} 取得 ${results.length} 筆結果`);
        return results;
      }
      traceWarn(`⚠️ [multi] ${backend.name} 無結果，換下一個引擎`);
    } catch (e) {
      traceWarn(`⚠️ [multi] ${backend.name} 失敗: ${e}`);
    }
  }
  console.warn('⚠️ [multi] 所有引擎皆無結果');
  return [];
}

// ==================== src/Store.js ====================

/**
 * 對話歷史、白名單、配額、互動日誌 (移植自 bot/conversation.py)
 * 本地 JSON 檔 → Google 試算表 (History / Quota / Logs 三個分頁)
 * threading.Lock → LockService (同一個 script 的所有請求互斥)
 */

const SHEET_HISTORY = 'History';
const SHEET_QUOTA = 'Quota';
const SHEET_LOGS = 'Logs';
const SHEET_HEADERS = {
  [SHEET_HISTORY]: ['user_id', 'history_json', 'updated_at'],
  [SHEET_QUOTA]: ['date', 'user_id', 'count'],
  [SHEET_LOGS]: ['timestamp', 'user_id', 'user_name', 'prompt', 'response', 'tokens', 'daily_count', 'model', 'source'],
};
// 這些欄位存成純文字，避免試算表把日期、長數字自動轉型
const SHEET_TEXT_COLUMNS = {
  [SHEET_HISTORY]: [1, 2],
  [SHEET_QUOTA]: [1, 2],
  [SHEET_LOGS]: [2],
};
// 單一儲存格上限 50000 字元，保留緩衝
const HISTORY_CELL_LIMIT = 45000;
const LOCK_TIMEOUT_MS = 15000;
// Telegram 重送同一個 update 時去重 (秒)
const UPDATE_DEDUP_SECONDS = 21600;

let SPREADSHEET_CACHE_ = null;

/** 取得資料試算表；SPREADSHEET_ID 未設定時自動建立並寫回屬性 */
function getSpreadsheet_() {
  if (SPREADSHEET_CACHE_) return SPREADSHEET_CACHE_;
  const cfg = getConfig();
  let ss = null;
  if (cfg.SPREADSHEET_ID) {
    ss = SpreadsheetApp.openById(cfg.SPREADSHEET_ID);
  } else {
    ss = SpreadsheetApp.create('Telegram AI Bot 資料');
    PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
    cfg.SPREADSHEET_ID = ss.getId();
    console.log(`📊 已建立資料試算表：${ss.getUrl()}`);
  }
  SPREADSHEET_CACHE_ = ss;
  return ss;
}

/** 取得分頁，不存在則建立並寫入標題列 */
function getSheet_(name) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    const headers = SHEET_HEADERS[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    for (const col of SHEET_TEXT_COLUMNS[name] || []) {
      sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@');
    }
  } else if (sheet.getLastColumn() < SHEET_HEADERS[name].length) {
    // 舊版建立的分頁少了新欄位 (例如 Logs 的 source)，補上標題列
    const headers = SHEET_HEADERS[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

/** 讀取標題列以外的所有資料列 */
function getDataRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
}

/** 儲存格轉字串 (日期格式化為 yyyy-MM-dd) */
function cellToString_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, getTimeZone_(), 'yyyy-MM-dd');
  return String(value);
}

/** 以 script lock 執行 (取不到鎖時拋出例外，由呼叫者處理) */
function withScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getTimeZone_() {
  return Session.getScriptTimeZone() || 'Asia/Taipei';
}

/** 取得今天日期字串 (YYYY-MM-DD，依 appsscript.json 時區) */
function getTodayDateStr() {
  return Utilities.formatDate(new Date(), getTimeZone_(), 'yyyy-MM-dd');
}

function nowIsoString_() {
  return Utilities.formatDate(new Date(), getTimeZone_(), "yyyy-MM-dd'T'HH:mm:ss");
}

// ===== 白名單 =====

/** 檢查使用者是否在白名單內 */
function isUserAuthorized(userId) {
  return getConfig().ALLOWED_USER_IDS.includes(Number(userId));
}

// ===== 對話歷史 =====

/** 歷史紀錄 → 模型訊息 (過濾空內容，只保留最近 N 輪) */
function historyTurnsToMessages(turns, maxTurns) {
  const valid = [];
  for (const turn of turns || []) {
    if (String(turn.user || '').trim() && String(turn.assistant || '').trim()) {
      valid.push({ role: 'user', content: turn.user });
      valid.push({ role: 'assistant', content: turn.assistant });
    }
  }
  const maxMessages = maxTurns * 2;
  return valid.length > maxMessages ? valid.slice(-maxMessages) : valid;
}

/** 加入一輪對話並截斷到 maxTurns，序列化後不超過單一儲存格上限 */
function appendHistoryTurn(turns, userMsg, assistantMsg, maxTurns, timestamp) {
  let history = (turns || []).concat([{ user: userMsg, assistant: assistantMsg, timestamp }]);
  if (history.length > maxTurns) history = history.slice(-maxTurns);
  while (history.length > 1 && JSON.stringify(history).length > HISTORY_CELL_LIMIT) {
    history = history.slice(1);
  }
  if (JSON.stringify(history).length > HISTORY_CELL_LIMIT) {
    const last = history[history.length - 1];
    last.assistant = last.assistant.slice(0, HISTORY_CELL_LIMIT - last.user.length - 200);
  }
  return history;
}

/** 找到使用者在 History 分頁的列號 (2 起算)，找不到回傳 0 */
function findHistoryRow_(sheet, userId) {
  const rows = getDataRows_(sheet);
  const idx = rows.findIndex((r) => cellToString_(r[0]) === String(userId));
  return idx === -1 ? 0 : idx + 2;
}

function readHistoryTurns_(sheet, row) {
  if (!row) return [];
  try {
    return JSON.parse(sheet.getRange(row, 2).getValue() || '[]');
  } catch (e) {
    console.error(`讀取對話歷史失敗 (row=${row}): ${e}`);
    return [];
  }
}

/**
 * 取得使用者對話歷史
 * 回傳格式: [{role: 'user', content: '...'}, {role: 'assistant', content: '...'}, ...]
 */
function getConversationHistory(userId) {
  try {
    const sheet = getSheet_(SHEET_HISTORY);
    const turns = readHistoryTurns_(sheet, findHistoryRow_(sheet, userId));
    return historyTurnsToMessages(turns, getConfig().MAX_HISTORY_TURNS);
  } catch (e) {
    console.error(`讀取對話歷史失敗 (user_id=${userId}): ${e}`);
    return [];
  }
}

/** 儲存一輪對話 */
function saveConversationTurn(userId, userMsg, assistantMsg) {
  if (!String(userMsg).trim() || !String(assistantMsg).trim()) return;
  try {
    withScriptLock_(() => {
      const sheet = getSheet_(SHEET_HISTORY);
      const row = findHistoryRow_(sheet, userId);
      const history = appendHistoryTurn(
        readHistoryTurns_(sheet, row), userMsg, assistantMsg, getConfig().MAX_HISTORY_TURNS, nowIsoString_(),
      );
      const values = [[String(userId), JSON.stringify(history), nowIsoString_()]];
      if (row) sheet.getRange(row, 1, 1, 3).setValues(values);
      else sheet.appendRow(values[0]);
    });
  } catch (e) {
    console.error(`儲存對話歷史失敗 (user_id=${userId}): ${e}`);
  }
}

/** 清除使用者對話歷史 */
function clearConversationHistory(userId) {
  try {
    withScriptLock_(() => {
      const sheet = getSheet_(SHEET_HISTORY);
      const row = findHistoryRow_(sheet, userId);
      if (row) sheet.deleteRow(row);
    });
    console.log(`已清除使用者 ${userId} 的對話歷史`);
  } catch (e) {
    console.error(`清除對話歷史失敗: ${e}`);
  }
}

// ===== 配額 =====

/** 找到今日配額列 → {row, count}；row=0 表示尚無紀錄 */
function findQuotaRow_(sheet, today, userId) {
  const rows = getDataRows_(sheet);
  const idx = rows.findIndex((r) => cellToString_(r[0]) === today && cellToString_(r[1]) === String(userId));
  if (idx === -1) return { row: 0, count: 0 };
  return { row: idx + 2, count: Number(rows[idx][2]) || 0 };
}

/**
 * 檢查並消耗配額
 * 回傳: {allowed, current, remaining, max, message?}
 */
function checkAndConsumeQuota(userId) {
  const today = getTodayDateStr();
  const maxLimit = getConfig().MAX_DAILY_REQUESTS;
  return withScriptLock_(() => {
    const sheet = getSheet_(SHEET_QUOTA);
    const { row, count } = findQuotaRow_(sheet, today, userId);
    if (count >= maxLimit) {
      return {
        allowed: false,
        current: count,
        remaining: 0,
        max: maxLimit,
        message: `⚠️ 今日免費提問次數已達上限 (${maxLimit}/${maxLimit} 次)。額度將於明天自動重置！`,
      };
    }
    const newCount = count + 1;
    if (row) sheet.getRange(row, 3).setValue(newCount);
    else sheet.appendRow([today, String(userId), newCount]);
    return { allowed: true, current: newCount, remaining: Math.max(0, maxLimit - newCount), max: maxLimit };
  });
}

/** 查詢配額狀態 (不消耗) */
function getQuotaStatus(userId) {
  const today = getTodayDateStr();
  const maxLimit = getConfig().MAX_DAILY_REQUESTS;
  const { count } = findQuotaRow_(getSheet_(SHEET_QUOTA), today, userId);
  return { date: today, current: count, remaining: Math.max(0, maxLimit - count), max: maxLimit };
}

/** 退還一次配額 (處理失敗時呼叫，避免使用者因系統錯誤被扣次數) */
function refundQuota(userId) {
  try {
    withScriptLock_(() => {
      const sheet = getSheet_(SHEET_QUOTA);
      const { row, count } = findQuotaRow_(sheet, getTodayDateStr(), userId);
      if (row && count > 0) sheet.getRange(row, 3).setValue(count - 1);
    });
  } catch (e) {
    console.error(`退還配額失敗: ${e}`);
  }
}

/** 【編輯器執行 / 除錯用】重置特定使用者今日配額 */
function resetUserQuota(userId) {
  withScriptLock_(() => {
    const sheet = getSheet_(SHEET_QUOTA);
    const { row } = findQuotaRow_(sheet, getTodayDateStr(), userId);
    if (row) {
      sheet.deleteRow(row);
      console.log(`已重置使用者 ${userId} 的今日配額`);
    }
  });
}

// ===== 日誌 =====

/** 記錄互動到 Logs 分頁 */
function logInteraction(record) {
  try {
    const response = String(record.response || '');
    getSheet_(SHEET_LOGS).appendRow([
      nowIsoString_(),
      String(record.userId),
      record.userName || '',
      record.prompt || '',
      response.length > 500 ? response.slice(0, 500) + '...' : response, // 避免日誌過大
      JSON.stringify(record.tokens || {}),
      record.dailyCount || 0,
      record.model || '',
      record.source || '',
    ]);
  } catch (e) {
    console.error(`寫入互動日誌失敗: ${e}`);
  }
}

/** 請求來源代碼 → 顯示文字 */
const REQUEST_SOURCE_LABELS = {
  webhook: '📨 Telegram webhook (GAS 獨立模式)',
  relay: '🛰️ 轉接站',
  simulate: '🧪 編輯器 simulate',
};

/** 最近 n 則提問 (不含回覆內容)：[{time, userName, prompt, model, source, sourceLabel}] */
function getRecentInteractions(n) {
  const rows = getDataRows_(getSheet_(SHEET_LOGS)).slice(-n);
  return rows.reverse().map((r) => ({
    // 試算表會把時間欄自動轉成日期型別，要連時分秒一起格式化
    time: r[0] instanceof Date ? Utilities.formatDate(r[0], getTimeZone_(), 'yyyy-MM-dd HH:mm:ss') : String(r[0]).replace('T', ' '),
    userName: String(r[2] || ''),
    prompt: String(r[3] || '').slice(0, 60),
    model: String(r[7] || ''),
    source: String(r[8] || ''),
    sourceLabel: REQUEST_SOURCE_LABELS[r[8]] || '(未記錄來源)',
  }));
}

// ===== Webhook 去重 =====

/**
 * 同一個 update_id 是否已處理過
 * GAS Web App 會回 302 轉址，處理較久時 Telegram 可能重送同一則 update
 */
function isDuplicateUpdate(updateId) {
  if (updateId === undefined || updateId === null) return false;
  const cache = CacheService.getScriptCache();
  const key = `update_${updateId}`;
  return withScriptLock_(() => {
    if (cache.get(key)) return true;
    cache.put(key, '1', UPDATE_DEDUP_SECONDS);
    return false;
  });
}

// ==================== src/Telegram.js ====================

/**
 * Telegram Bot API 封裝 (UrlFetchApp 同步呼叫)
 * 取代 python-telegram-bot；失敗不拋例外，回傳 {ok: false, description}，避免單一發送失敗中斷主流程
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** 呼叫 Telegram Bot API → {ok, result, description, error_code} */
function telegramApi(method, payload) {
  const token = getConfig().TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN 未設定' };
  try {
    const resp = UrlFetchApp.fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true,
    });
    const data = JSON.parse(resp.getContentText());
    if (!data.ok) console.warn(`Telegram ${method} 失敗: ${data.error_code} ${data.description}`);
    return data;
  } catch (e) {
    console.warn(`Telegram ${method} 連線失敗: ${e}`);
    return { ok: false, description: String(e) };
  }
}

function isParseError_(res) {
  return !res.ok && /can't parse entities/i.test(res.description || '');
}

/** 發送訊息；HTML 解析失敗時改送純文字。回傳 message_id 或 null */
function tgSendMessage(chatId, text, parseMode) {
  const payload = { chat_id: chatId, text: text, link_preview_options: { is_disabled: true } };
  if (parseMode) payload.parse_mode = parseMode;
  let res = telegramApi('sendMessage', payload);
  if (!res.ok && parseMode && res.error_code === 400) {
    console.warn(`HTML 解析失敗，改送純文字: ${res.description}`);
    res = telegramApi('sendMessage', { chat_id: chatId, text: htmlToPlain(text), link_preview_options: { is_disabled: true } });
  }
  return res.ok ? res.result.message_id : null;
}

/** 編輯訊息；HTML 解析失敗時改送純文字。回傳是否成功 */
function tgEditMessageText(chatId, messageId, text, parseMode) {
  const payload = { chat_id: chatId, message_id: messageId, text: text, link_preview_options: { is_disabled: true } };
  if (parseMode) payload.parse_mode = parseMode;
  let res = telegramApi('editMessageText', payload);
  if (parseMode && isParseError_(res)) {
    console.warn(`HTML 解析失敗，改送純文字: ${res.description}`);
    res = telegramApi('editMessageText', {
      chat_id: chatId, message_id: messageId, text: htmlToPlain(text), link_preview_options: { is_disabled: true },
    });
  }
  // 內容相同時 Telegram 回 400 message is not modified，視為成功
  return res.ok || /message is not modified/i.test(res.description || '');
}

/** 顯示「正在輸入…」(約維持 5 秒) */
function tgSendChatAction(chatId, action) {
  telegramApi('sendChatAction', { chat_id: chatId, action: action || 'typing' });
}

/**
 * Telegram 對話情境：Handler 只透過這幾個方法與使用者互動，模擬模式換成主控台版本即可
 */
function createTelegramContext(update) {
  const message = update.message;
  const user = message.from || {};
  const chatId = message.chat.id;
  return {
    updateId: update.update_id,
    chatId: chatId,
    userId: user.id,
    firstName: user.first_name || '',
    userName: user.first_name || user.username || '匿名',
    statusMessageId: null,
    reply: (text, parseMode) => {
      captureRelayMessage_(text);
      return tgSendMessage(chatId, text, parseMode);
    },
    edit: (messageId, text, parseMode) => {
      captureRelayMessage_(text);
      return tgEditMessageText(chatId, messageId, text, parseMode);
    },
    typing: () => tgSendChatAction(chatId, 'typing'),
  };
}
