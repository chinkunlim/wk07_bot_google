/**
 * 轉接站佇列：GAS 當公開的 webhook 收件站，電腦上的轉接站 (relay/relay.js) 來拿題目
 *
 *   Telegram ──webhook──▶ GAS doPost ──排隊──▶ 佇列 ◀──每 2 秒輪詢── 轉接站 (你的電腦)
 *                                                                    │ 印出題目、搜尋、Gemini
 *   Telegram ◀───────────────────── 直接回覆 ─────────────────────────┘
 *
 * 轉接站離線 (超過 RELAY_OFFLINE_SECONDS 沒來輪詢) 時，GAS 自己回答，bot 不會停擺
 * 轉接站在家用網路搜尋，避開搜尋引擎對 Google 機房 IP 的封鎖，也沒有 GAS 6 分鐘執行上限
 */

const RELAY_QUEUE_KEY = 'relay_queue';
const RELAY_LAST_SEEN_KEY = 'relay_last_seen';
// 轉接站超過這麼久沒輪詢就視為離線
const RELAY_OFFLINE_SECONDS = 30;
const RELAY_MAX_QUEUE = 50;
const RELAY_CACHE_SECONDS = 21600;

/** RELAY_MODE=auto 且轉接站最近有來輪詢 */
function isRelayOnline() {
  if (getConfig().RELAY_MODE !== 'auto') return false;
  const last = Number(CacheService.getScriptCache().get(RELAY_LAST_SEEN_KEY) || 0);
  return Date.now() - last < RELAY_OFFLINE_SECONDS * 1000;
}

function readRelayQueue_(cache) {
  try {
    return JSON.parse(cache.get(RELAY_QUEUE_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

/** 把 Telegram update 排入佇列給轉接站 */
function enqueueRelayUpdate(update) {
  const cache = CacheService.getScriptCache();
  withScriptLock_(() => {
    const queue = readRelayQueue_(cache);
    queue.push(update);
    cache.put(RELAY_QUEUE_KEY, JSON.stringify(queue.slice(-RELAY_MAX_QUEUE)), RELAY_CACHE_SECONDS);
  });
}

/** 轉接站取走所有排隊中的 update，並記錄它還活著 */
function takeRelayUpdates() {
  const cache = CacheService.getScriptCache();
  return withScriptLock_(() => {
    cache.put(RELAY_LAST_SEEN_KEY, String(Date.now()), RELAY_CACHE_SECONDS);
    const queue = readRelayQueue_(cache);
    if (queue.length) cache.remove(RELAY_QUEUE_KEY);
    return queue;
  });
}

function jsonOutput_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

/** doGet?action=poll&token=WEBHOOK_SECRET → {ok, updates} */
function relayPoll(token) {
  const secret = getConfig().WEBHOOK_SECRET;
  if (!secret || token !== secret) {
    console.warn('轉接站 token 不符，拒絕輪詢');
    return jsonOutput_({ ok: false, error: 'token 不符：轉接站 .env 的 WEBHOOK_SECRET 要與指令碼屬性相同' });
  }
  if (getConfig().RELAY_MODE !== 'auto') {
    return jsonOutput_({ ok: false, error: 'RELAY_MODE=off：指令碼屬性改為 auto 才會把題目交給轉接站' });
  }
  const updates = takeRelayUpdates();
  if (updates.length) console.log(`📤 轉接站取走 ${updates.length} 題`);
  return jsonOutput_({ ok: true, updates });
}
