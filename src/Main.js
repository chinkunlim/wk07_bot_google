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
