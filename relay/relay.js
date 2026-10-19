#!/usr/bin/env node
/**
 * 轉接站：在你的電腦上執行，向 GAS 拿 Telegram 題目、在本機搜尋與呼叫 Gemini、直接回覆 Telegram
 *
 *   Telegram ──webhook──▶ GAS (Code.gs) ──佇列──▶ 轉接站 (本程式，每 2 秒輪詢)
 *                                                  │ 印出題目 → 搜尋 → 讀網頁 → Gemini
 *   Telegram ◀──────────── 回覆 (含來源) ───────────┘
 *
 * 與 GAS 跑同一份 src/*.js (dev/gasShim.js 模擬 GAS 環境)，所以回答流程、指令、白名單、配額完全一致
 * 設定：gas/.env (見 .env.example)，需 TELEGRAM_BOT_TOKEN、ALLOWED_USER_IDS、GEMINI_API_KEY、
 *       WEBHOOK_URL (/exec 網址)、WEBHOOK_SECRET (與 GAS 指令碼屬性相同)
 * 對話記憶與配額存在 gas/.relay-data/ (已加入 .gitignore)
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadGas, curlFetch } = require('../dev/gasShim');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const DATA_FILE = path.join(ROOT, '.relay-data', 'sheets.json');
const POLL_SECONDS = 2;
const ERROR_BACKOFF_SECONDS = 10;

function loadEnv() {
  const props = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) props[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const key of Object.keys(process.env)) {
    if (/^(TELEGRAM_|ALLOWED_|GEMINI_|SEARCH_|MAX_|WEBHOOK_)/.test(key)) props[key] = process.env[key];
  }
  return props;
}

const sleep = (seconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
const time = () => new Date().toTimeString().slice(0, 8);
const line = '─'.repeat(60);

/** 向 GAS 拿排隊中的題目 → updates 陣列；失敗時拋出可讀的錯誤 */
function poll(url, secret) {
  const resp = curlFetch(`${url}?action=poll&token=${encodeURIComponent(secret)}`, { muteHttpExceptions: true });
  const text = resp.getContentText();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // 存取權限不是「所有人」時，GAS 會回 Google 登入頁 (HTML)
    const hint = /<html/i.test(text) ? '：收到網頁而不是 JSON，請確認 Web App「誰可以存取」為「所有人」並已部署新版本' : '';
    throw new Error(`GAS 回應 HTTP ${resp.getResponseCode()}${hint}`);
  }
  if (!data.ok) throw new Error(data.error || 'GAS 拒絕輪詢');
  return data.updates || [];
}

function main() {
  const g = loadGas({ props: loadEnv(), fetch: curlFetch, realSleep: true, dataFile: DATA_FILE });
  const print = (level) => (...args) => console[level](`[${time()}]    ${args.join(' ')}`);
  g.context.console = { log: print('log'), info: print('log'), warn: print('warn'), error: print('error') };

  const cfg = g.get('getConfig')();
  const errors = g.get('validateConfig')(cfg, true);
  if (!cfg.WEBHOOK_URL) errors.push('WEBHOOK_URL 未設定 (GAS 部署的 /exec 網址)');
  if (!cfg.WEBHOOK_SECRET) errors.push('WEBHOOK_SECRET 未設定 (複製 GAS 指令碼屬性的值；先在 GAS 執行 setWebhook 產生)');
  if (errors.length) {
    errors.forEach((e) => console.error(`❌ ${e}`));
    console.error(`\n請在 ${ENV_FILE} 設定上述欄位 (範本見 .env.example)`);
    process.exit(1);
  }

  // 最終回覆同時印在轉接站視窗
  const htmlToPlain = g.get('htmlToPlain');
  const sendFinalResponse = g.get('sendFinalResponse');
  g.set('sendFinalResponse', (ctx, text) => {
    console.log(`[${time()}] 🤖 回覆：\n${htmlToPlain(text).replace(/^/gm, '    ')}`);
    sendFinalResponse(ctx, text);
  });
  const handleUpdate = g.get('handleUpdate');

  console.log(line);
  console.log('🛰️  Telegram 轉接站啟動');
  console.log(`   GAS：${cfg.WEBHOOK_URL.replace(/\/s\/([^/]{6})[^/]+\//, '/s/$1…/')}`);
  console.log(`   模型：${cfg.GEMINI_MODELS.join(' → ')}`);
  console.log(`   搜尋：${cfg.SEARCH_ENGINE} (備援 ${cfg.SEARCH_FALLBACK_ENGINE || '無'})，判斷方式 ${cfg.SEARCH_DECISION}`);
  console.log(`   每 ${POLL_SECONDS} 秒向 GAS 拿題目；Ctrl+C 結束 (結束後由 GAS 直接回答)`);
  console.log(line);

  let count = 0;
  let connected = false;
  for (;;) {
    let updates = [];
    try {
      updates = poll(cfg.WEBHOOK_URL, cfg.WEBHOOK_SECRET);
      if (!connected) {
        console.log(`[${time()}] ✅ 已連上 GAS，等待題目…`);
        connected = true;
      }
    } catch (e) {
      console.error(`[${time()}] ⚠️  輪詢失敗：${e.message}`);
      connected = false;
      sleep(ERROR_BACKOFF_SECONDS);
      continue;
    }

    for (const update of updates) {
      const msg = update.message || {};
      const from = msg.from || {};
      count += 1;
      console.log(`\n${line}`);
      console.log(`[${time()}] 📩 第 ${count} 題｜${from.first_name || from.username || '匿名'} (${from.id})：${msg.text}`);
      const started = Date.now();
      try {
        handleUpdate(update);
      } catch (e) {
        console.error(`[${time()}] ❌ 處理失敗：${e.stack || e}`);
      }
      g.save();
      console.log(`[${time()}] ✅ 完成 (${((Date.now() - started) / 1000).toFixed(1)} 秒)`);
      console.log(line);
    }
    sleep(POLL_SECONDS);
  }
}

main();
