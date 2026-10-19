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
