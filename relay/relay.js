#!/usr/bin/env node
/**
 * 轉接站：在你的電腦上執行，向 Telegram 拿訊息、交給 GAS 回答，並把每一題印在視窗上
 *
 *   📱 Telegram ◀──getUpdates 長輪詢── 💻 轉接站 (本程式)
 *                                          │ POST ?action=ask&token=WEBHOOK_SECRET
 *                                          ▼
 *                                   ☁️ GAS (Code.gs)：搜尋 + Gemini → 直接回覆 Telegram
 *
 * 為什麼由轉接站主動拿訊息：GAS 網頁應用程式一律回 302，Telegram webhook 把它當成失敗並拉長重試間隔，
 * 訊息會越來越慢、最後卡住；改用 getUpdates 就沒有這個問題。
 * 啟動時移除 webhook (getUpdates 與 webhook 不能並存)；Ctrl+C 結束時把 webhook 設回 GAS，
 * 電腦關機期間改由 GAS 獨立回答 (RELAY_RESTORE_WEBHOOK=false 可停用)。
 *
 * 設定：gas/.env，需要 TELEGRAM_BOT_TOKEN、WEBHOOK_URL (/exec 網址)、WEBHOOK_SECRET (與 GAS 指令碼屬性相同)
 * 只用 Node 內建模組與 curl，不需安裝套件
 */
const fs = require('node:fs');
const path = require('node:path');
const { curlFetch } = require('../dev/gasShim');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const LONG_POLL_SECONDS = 25;
const ERROR_BACKOFF_SECONDS = 5;
// GAS 單次執行上限 6 分鐘
const ASK_TIMEOUT_SECONDS = 360;
const LINE = '─'.repeat(60);

function loadEnv(file) {
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const key of ['TELEGRAM_BOT_TOKEN', 'WEBHOOK_URL', 'WEBHOOK_SECRET', 'RELAY_RESTORE_WEBHOOK']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function validateEnv(env) {
  const errors = [];
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(env.TELEGRAM_BOT_TOKEN || '')) {
    errors.push('TELEGRAM_BOT_TOKEN 未設定或格式不對 (與 GAS 指令碼屬性相同)');
  }
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(env.WEBHOOK_URL || '')) {
    errors.push('WEBHOOK_URL 需為 GAS 網頁應用程式的 /exec 網址');
  }
  if (!env.WEBHOOK_SECRET) errors.push('WEBHOOK_SECRET 未設定 (到 GAS 指令碼屬性複製；先在 GAS 執行 setWebhook 產生)');
  return errors;
}

const time = () => new Date().toTimeString().slice(0, 8);
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const indent = (text) => String(text).replace(/^/gm, '    ');

/** 建立轉接站 (http 預設 curl；測試時可注入假的) */
function createRelay(env, options = {}) {
  const http = options.http || curlFetch;
  const log = options.log || ((line) => console.log(line));
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

  function telegram(method, payload, timeoutSeconds) {
    const resp = http(`${api}/${method}`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true,
      timeoutSeconds: timeoutSeconds || 30,
    });
    const data = JSON.parse(resp.getContentText());
    if (!data.ok) throw new Error(`Telegram ${method}：${data.description}`);
    return data.result;
  }

  /** 把一則 update 交給 GAS，回傳 GAS 的 JSON 結果 */
  function ask(update) {
    const url = `${env.WEBHOOK_URL}?action=ask&token=${encodeURIComponent(env.WEBHOOK_SECRET)}`;
    const resp = http(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(update),
      muteHttpExceptions: true,
      timeoutSeconds: ASK_TIMEOUT_SECONDS,
    });
    const text = resp.getContentText();
    try {
      return JSON.parse(text);
    } catch (e) {
      const hint = /<html/i.test(text)
        ? '收到網頁而不是 JSON：確認網頁應用程式存取權為「所有人」，且部署的是新版本'
        : `GAS 回應 HTTP ${resp.getResponseCode()}：${text.slice(0, 100)}`;
      return { ok: false, error: hint };
    }
  }

  /** 處理一則 update：印出題目 → 交給 GAS → 印出過程與回覆 */
  function handle(update, index) {
    const msg = update.message || {};
    const from = msg.from || {};
    log(`\n${LINE}`);
    log(`[${time()}] 📩 第 ${index} 題｜${from.first_name || from.username || '匿名'} (${from.id})：${msg.text}`);
    log(`[${time()}]    ☁️  交給 GAS 處理…`);
    const started = Date.now();
    const result = ask(update);
    if (!result.ok) {
      log(`[${time()}] ❌ GAS 處理失敗：${result.error}`);
      try {
        telegram('sendMessage', { chat_id: msg.chat.id, text: '❌ 轉接站無法取得回答，請稍後再試。' });
      } catch (e) {
        log(`[${time()}]    (通知使用者失敗：${e.message})`);
      }
    } else if (result.duplicate) {
      log(`[${time()}]    (這則已處理過，略過)`);
    } else {
      for (const line of result.logs || []) log(`[${time()}]    ${line}`);
      for (const reply of result.replies || []) log(`[${time()}] 🤖 回覆：\n${indent(reply)}`);
    }
    log(`[${time()}] ✅ 完成 (${((Date.now() - started) / 1000).toFixed(1)} 秒)`);
    log(LINE);
  }

  return { telegram, ask, handle };
}

async function main() {
  const env = loadEnv(ENV_FILE);
  const errors = validateEnv(env);
  if (errors.length) {
    errors.forEach((e) => console.error(`❌ ${e}`));
    console.error(`\n請在 ${ENV_FILE} 設定上述欄位 (範本見 .env.example)`);
    process.exit(1);
  }
  const relay = createRelay(env);
  const restoreWebhook = env.RELAY_RESTORE_WEBHOOK !== 'false';

  const me = relay.telegram('getMe');
  console.log(LINE);
  console.log('🛰️  Telegram 轉接站啟動');
  console.log(`   Bot：@${me.username}`);
  console.log(`   GAS：${env.WEBHOOK_URL.replace(/\/s\/([^/]{6})[^/]+\//, '/s/$1…/')}`);
  console.log('   向 Telegram 拿訊息 → 交給 GAS (搜尋 + Gemini) 回答；Ctrl+C 結束');
  console.log(LINE);

  // getUpdates 與 webhook 不能並存；保留未處理的訊息 (電腦關機期間的提問會在這裡補答)
  relay.telegram('deleteWebhook', { drop_pending_updates: false });
  console.log(`[${time()}] ✅ 已切換為轉接站模式，等待訊息…`);

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
  });

  let offset = 0;
  let count = 0;
  while (!stopping) {
    let updates = [];
    try {
      updates = relay.telegram('getUpdates', {
        offset, timeout: LONG_POLL_SECONDS, allowed_updates: ['message'],
      }, LONG_POLL_SECONDS + 15);
    } catch (e) {
      if (stopping) break;
      console.error(`[${time()}] ⚠️  向 Telegram 拿訊息失敗：${e.message}`);
      await sleep(ERROR_BACKOFF_SECONDS);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      if (!update.message || typeof update.message.text !== 'string') continue;
      count += 1;
      relay.handle(update, count);
    }
    // 讓 Ctrl+C 有機會被處理
    await sleep(0.05);
  }

  console.log(`\n[${time()}] 🛑 轉接站結束`);
  // 確認已處理的訊息，避免下次重複回答
  if (offset) {
    try {
      relay.telegram('getUpdates', { offset, timeout: 0 });
    } catch (e) {
      // 忽略
    }
  }
  if (restoreWebhook) {
    try {
      relay.telegram('setWebhook', {
        url: `${env.WEBHOOK_URL}?secret=${env.WEBHOOK_SECRET}`,
        allowed_updates: ['message'],
        max_connections: 10,
      });
      console.log(`[${time()}] ☁️  已把 webhook 設回 GAS：電腦關機期間由 GAS 獨立回答`);
    } catch (e) {
      console.error(`[${time()}] ⚠️  設回 webhook 失敗：${e.message} (可在 GAS 執行 setWebhook)`);
    }
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`❌ 轉接站錯誤：${e.message}`);
    process.exit(1);
  });
}

module.exports = { createRelay, loadEnv, validateEnv };
