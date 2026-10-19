#!/usr/bin/env node
/**
 * 查詢 bot 目前的運作模式 (npm run mode)
 *
 * 判斷依據是 Telegram 官方的 getWebhookInfo：
 * - webhook 指向 GAS → GAS 獨立模式。此時 Telegram 不允許任何程式用 getUpdates 拿訊息
 *   (會回 409 Conflict)，所以轉接站不可能在處理訊息
 * - webhook 未設定 → 轉接站模式 (轉接站啟動時會移除 webhook)
 * 另外列出本機有沒有轉接站程序，以及 GAS 部署的版本字樣
 *
 * 設定：專案資料夾的 .env (TELEGRAM_BOT_TOKEN、WEBHOOK_URL)；不會印出 Token 與 secret
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { curlFetch } = require('./gasShim');
const { loadEnv } = require('../relay/relay');

const env = loadEnv(path.join(__dirname, '..', '.env'));
if (!env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ .env 缺少 TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const api = (method) => JSON.parse(
  curlFetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { muteHttpExceptions: true }).getContentText(),
);
const fmtTime = (unix) => new Date(unix * 1000).toLocaleString('zh-TW', { hour12: false });
const mask = (url) => url.replace(/\?.*$/, '?secret=****').replace(/\/s\/([^/]{6})[^/]+\//, '/s/$1…/');

const me = api('getMe');
const info = api('getWebhookInfo');
if (!me.ok || !info.ok) {
  console.error(`❌ Telegram API 錯誤：${(me.description || info.description)}`);
  process.exit(1);
}
const hook = info.result;

let relayPids = '';
try {
  relayPids = execFileSync('pgrep', ['-f', 'relay/relay.js'], { encoding: 'utf8' }).trim();
} catch (e) {
  relayPids = '';
}

const base = (env.WEBHOOK_URL || '').replace(/\?.*$/, '');
const pointsToGas = Boolean(hook.url) && base && hook.url.startsWith(base);

console.log(`查詢時間：${new Date().toLocaleString('zh-TW', { hour12: false })}`);
console.log(`Bot：@${me.result.username}`);
console.log(`Telegram webhook：${hook.url ? mask(hook.url) : '(未設定)'}`);
console.log(`待處理訊息：${hook.pending_update_count}`);
if (hook.last_error_message) console.log(`最後錯誤：${hook.last_error_message} (${fmtTime(hook.last_error_date)})`);
console.log(`本機轉接站程序：${relayPids ? `執行中 (PID ${relayPids.split('\n').join(', ')})` : '沒有'}`);
if (base) {
  try {
    console.log(`GAS 版本：${curlFetch(base, { muteHttpExceptions: true }).getContentText().slice(0, 80)}`);
  } catch (e) {
    console.log(`GAS 版本：(無法連線：${e.message})`);
  }
}
console.log('');
if (pointsToGas) {
  console.log('➡️  目前是【GAS 獨立模式】：Telegram 把訊息直接送到 GAS，轉接站沒有在處理訊息');
  console.log('    (webhook 設定期間 Telegram 拒絕 getUpdates，轉接站即使開著也拿不到訊息)');
} else if (!hook.url) {
  console.log(`➡️  目前是【轉接站模式】：webhook 已移除，訊息由轉接站拿取${relayPids ? '' : ' — 但本機沒有轉接站在跑，訊息會暫存在 Telegram (最多 24 小時)'}`);
} else {
  console.log('⚠️  webhook 指向的不是 .env 的 WEBHOOK_URL，請確認設定');
}
