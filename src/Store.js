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
  [SHEET_LOGS]: ['timestamp', 'user_id', 'user_name', 'prompt', 'response', 'tokens', 'daily_count', 'model'],
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
    ]);
  } catch (e) {
    console.error(`寫入互動日誌失敗: ${e}`);
  }
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
