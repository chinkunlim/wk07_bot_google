// 轉接站：GAS 的 ?action=ask 介面、轉接站程式 (relay/relay.js)、單一檔案 Code.gs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadGas, makeResponse } = require('../dev/gasShim');
const { buildCode, OUT_FILE } = require('../dev/build');
const { createRelay, validateEnv } = require('../relay/relay');

const USER = 111;
const TOKEN = '123456:' + 'A'.repeat(35);
const SECRET = 's3cret';
const EXEC_URL = 'https://script.google.com/macros/s/AKfyTEST/exec';

function makeUpdate(id, text) {
  return { update_id: id, message: { message_id: 1, text, chat: { id: USER }, from: { id: USER, first_name: '小明' } } };
}

/** GAS 環境 + 假 Telegram / Gemini */
function setupGas(props, options) {
  const g = loadGas(Object.assign({
    props: Object.assign({
      TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USER_IDS: String(USER), GEMINI_API_KEY: 'k', WEBHOOK_SECRET: SECRET,
      SEARCH_FETCH_PAGES: '0',
    }, props || {}),
  }, options || {}));
  const telegram = [];
  const geminiReplies = [];
  g.setFetch((url, opts) => {
    if (url.startsWith('https://api.telegram.org/')) {
      telegram.push({ method: url.split('/').pop(), payload: JSON.parse(opts.payload) });
      return makeResponse({ body: JSON.stringify({ ok: true, result: { message_id: 1 } }) });
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      return makeResponse({ body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: geminiReplies.shift() }] } }] }) });
    }
    return makeResponse({ code: 404, body: '' });
  });
  const ask = (token, update) => {
    const out = g.get('doPost')({
      parameter: { action: 'ask', token },
      postData: { contents: JSON.stringify(update) },
    });
    assert.equal(out.getMimeType(), 'application/json');
    return JSON.parse(out.getContent());
  };
  return { g, telegram, geminiReplies, ask };
}

test('GAS ?action=ask：處理訊息、直接回覆 Telegram、回傳回覆與過程紀錄', () => {
  const t = setupGas();
  t.geminiReplies.push('{"need_search": false, "query": ""}', '**你好**！');
  const res = t.ask(SECRET, makeUpdate(1, '你好'));
  assert.equal(res.ok, true);
  assert.equal(res.replies.length, 1);
  assert.ok(res.replies[0].startsWith('你好！'));
  assert.ok(res.logs.some((l) => l.includes('🧭 搜尋判斷')));
  assert.ok(t.telegram.some((c) => c.method === 'editMessageText' && c.payload.text.startsWith('<b>你好</b>')));
});

test('GAS ?action=ask：指令的回覆也會回傳；token 不符被拒；重複的 update 略過', () => {
  const t = setupGas();
  const res = t.ask(SECRET, makeUpdate(2, '/help'));
  assert.ok(res.replies[0].includes('使用說明'));

  const bad = t.ask('wrong', makeUpdate(3, '/help'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /token 不符/);

  const dup = t.ask(SECRET, makeUpdate(2, '/help'));
  assert.equal(dup.duplicate, true);
  assert.equal(t.telegram.filter((c) => c.method === 'sendMessage').length, 1);
});

test('traceLog：轉接站請求以外只寫日誌，不累積', () => {
  const t = setupGas();
  t.g.get('traceLog')('🔍 測試');
  assert.ok(t.g.logs.some((l) => l.text === '🔍 測試'));
  t.ask(SECRET, makeUpdate(4, '/help'));
  t.g.get('traceLog')('之後');
  assert.equal(t.g.get('RELAY_CAPTURE_'), null);
});

test('Telegram webhook (GAS 獨立模式) 仍可直接處理', () => {
  const t = setupGas();
  t.g.get('doPost')({ parameter: { secret: SECRET }, postData: { contents: JSON.stringify(makeUpdate(5, '/help')) } });
  assert.equal(t.telegram.filter((c) => c.method === 'sendMessage').length, 1);
  assert.match(t.g.get('doGet')().getContent(), /v2\.4/);
});

test('日誌標示請求來源 (webhook / 轉接站)', () => {
  const t = setupGas();
  t.g.get('doPost')({ parameter: { secret: SECRET }, postData: { contents: JSON.stringify(makeUpdate(30, '/help')) } });
  t.ask(SECRET, makeUpdate(31, '/help'));
  const texts = t.g.logs.map((l) => l.text);
  assert.ok(texts.includes('📨 來源：Telegram webhook (GAS 獨立模式)，update 30'));
  assert.ok(texts.includes('🛰️ 來源：轉接站，update 31'));
});

test('Logs 記錄請求來源；doGet ?action=recent 以 token 取得最近提問', () => {
  const t = setupGas();
  t.geminiReplies.push('{"need_search": false, "query": ""}', '答一', '{"need_search": false, "query": ""}', '答二');
  t.g.get('doPost')({ parameter: { secret: SECRET }, postData: { contents: JSON.stringify(makeUpdate(40, '第一題')) } });
  t.ask(SECRET, makeUpdate(41, '第二題'));
  const recent = (token) => JSON.parse(t.g.get('doGet')({ parameter: { action: 'recent', token, n: '5' } }).getContent());
  const res = recent(SECRET);
  assert.equal(res.ok, true);
  assert.deepEqual(res.items.map((i) => [i.prompt, i.source]), [['第二題', 'relay'], ['第一題', 'webhook']]);
  assert.match(res.items[1].sourceLabel, /GAS 獨立模式/);
  assert.equal(recent('wrong').ok, false);
});

test('舊版 Logs 分頁 (沒有 source 欄) 會補上標題列', () => {
  const t = setupGas();
  const ss = t.g.get('getSpreadsheet_')();
  ss.insertSheet('Logs').appendRow(['timestamp', 'user_id', 'user_name', 'prompt', 'response', 'tokens', 'daily_count', 'model']);
  t.g.get('logInteraction')({ userId: 1, prompt: 'x', source: 'webhook' });
  assert.equal(ss.getSheetByName('Logs').rows[0][8], 'source');
});

test('Telegram webhook 一律回 HtmlService (HTTP 200)，不用會被 302 轉址的 ContentService', () => {
  const t = setupGas();
  const post = (secret, update) => t.g.get('doPost')({
    parameter: { secret }, postData: { contents: JSON.stringify(update) },
  });
  assert.equal(post(SECRET, makeUpdate(20, '/help')).service, 'HtmlService');
  assert.equal(post(SECRET, makeUpdate(20, '/help')).service, 'HtmlService'); // 重複
  assert.equal(post('wrong', makeUpdate(21, '/help')).service, 'HtmlService'); // secret 不符
  assert.equal(t.g.get('doPost')({ parameter: { secret: SECRET }, postData: { contents: '不是 JSON' } }).service, 'HtmlService');
  // 轉接站的 ask 介面回 JSON (轉接站會跟隨 302)
  assert.equal(t.g.get('doPost')({
    parameter: { action: 'ask', token: SECRET }, postData: { contents: JSON.stringify(makeUpdate(22, '/help')) },
  }).service, 'ContentService');
});

test('轉接站：把 update 交給 GAS、印出題目與回覆 (端對端，假網路)', () => {
  const gas = setupGas();
  gas.geminiReplies.push('{"need_search": false, "query": ""}', '花蓮有七星潭。');
  const lines = [];
  const http = (url, opts) => {
    if (url.startsWith(EXEC_URL)) {
      const token = new URL(url).searchParams.get('token');
      const out = gas.g.get('doPost')({
        parameter: { action: 'ask', token },
        postData: { contents: opts.payload },
      });
      return makeResponse({ body: out.getContent() });
    }
    return makeResponse({ body: JSON.stringify({ ok: true, result: { message_id: 9 } }) });
  };
  const relay = createRelay(
    { TELEGRAM_BOT_TOKEN: TOKEN, WEBHOOK_URL: EXEC_URL, WEBHOOK_SECRET: SECRET },
    { http, log: (l) => lines.push(l) },
  );
  relay.handle(makeUpdate(6, '查 花蓮景點'), 1);
  const out = lines.join('\n');
  assert.match(out, /📩 第 1 題｜小明 \(111\)：查 花蓮景點/);
  assert.match(out, /🧭 搜尋判斷/);
  assert.match(out, /🤖 回覆：\n {4}花蓮有七星潭。/);
  assert.match(out, /✅ 完成/);
});

test('轉接站：GAS 失敗 (例如收到登入頁) 時印出原因並通知使用者', () => {
  const sent = [];
  const lines = [];
  const http = (url, opts) => {
    if (url.startsWith(EXEC_URL)) return makeResponse({ body: '<html>login</html>' });
    sent.push(JSON.parse(opts.payload));
    return makeResponse({ body: JSON.stringify({ ok: true, result: {} }) });
  };
  const relay = createRelay(
    { TELEGRAM_BOT_TOKEN: TOKEN, WEBHOOK_URL: EXEC_URL, WEBHOOK_SECRET: SECRET },
    { http, log: (l) => lines.push(l) },
  );
  relay.handle(makeUpdate(7, '你好'), 1);
  assert.match(lines.join('\n'), /存取權為「所有人」/);
  assert.equal(sent[0].chat_id, USER);
});

test('轉接站設定驗證', () => {
  assert.deepEqual(validateEnv({ TELEGRAM_BOT_TOKEN: TOKEN, WEBHOOK_URL: EXEC_URL, WEBHOOK_SECRET: SECRET }), []);
  const errors = validateEnv({ WEBHOOK_URL: 'https://script.google.com/macros/s/x/dev' }).join('\n');
  for (const key of ['TELEGRAM_BOT_TOKEN', 'WEBHOOK_URL', 'WEBHOOK_SECRET']) assert.ok(errors.includes(key), key);
});

test('Code.gs 與 src/ 同步 (修改 src/ 後請執行 npm run build)', () => {
  assert.equal(fs.readFileSync(OUT_FILE, 'utf8'), buildCode());
});

test('單獨載入 Code.gs 即可運作 (貼進 GAS 編輯器的情境)', () => {
  const t = setupGas({}, { files: [OUT_FILE] });
  const res = t.ask(SECRET, makeUpdate(8, '/help'));
  assert.ok(res.replies[0].includes('使用說明'));
  assert.equal(typeof t.g.get('setWebhook'), 'function');
});
