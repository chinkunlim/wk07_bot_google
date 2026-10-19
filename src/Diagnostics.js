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
