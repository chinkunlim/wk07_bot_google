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
