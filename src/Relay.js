/**
 * 轉接站介面：電腦上的轉接站 (relay/relay.js) 把 Telegram 訊息交給 GAS 回答
 *
 *   📱 Telegram ◀──getUpdates 長輪詢── 💻 轉接站 (你的電腦，印出每一題)
 *                                          │ POST ?action=ask&token=WEBHOOK_SECRET
 *                                          ▼
 *                                   ☁️ GAS doPost → 搜尋 + Gemini → 回覆 Telegram
 *                                          │ 回傳 {replies, logs} 給轉接站印出
 *
 * 為什麼不讓 Telegram 直接 webhook 到 GAS：GAS 網頁應用程式一律回 302 轉址，
 * Telegram 把 302 當成失敗並逐次拉長重試間隔，訊息會越來越慢、最後卡住。
 * 轉接站主動向 Telegram 拿訊息就沒有這個問題；GAS 獨立模式 (setWebhook) 仍保留作為備援。
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
