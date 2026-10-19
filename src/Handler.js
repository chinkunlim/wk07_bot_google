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
  });
}
