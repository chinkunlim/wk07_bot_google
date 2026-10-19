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
    reply: (text, parseMode) => tgSendMessage(chatId, text, parseMode),
    edit: (messageId, text, parseMode) => tgEditMessageText(chatId, messageId, text, parseMode),
    typing: () => tgSendChatAction(chatId, 'typing'),
  };
}
