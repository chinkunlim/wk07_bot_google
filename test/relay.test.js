// 轉接站佇列 (doPost 排隊、doGet 輪詢) 與單一檔案 Code.gs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadGas, makeResponse } = require('../dev/gasShim');
const { buildCode, OUT_FILE } = require('../dev/build');

const USER = 111;
const TOKEN = '123456:' + 'A'.repeat(35);
const SECRET = 's3cret';

function setup(props, options) {
  const g = loadGas(Object.assign({
    props: Object.assign({
      TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USER_IDS: String(USER), GEMINI_API_KEY: 'k', WEBHOOK_SECRET: SECRET,
    }, props || {}),
  }, options || {}));
  const telegram = [];
  g.setFetch((url, opts) => {
    if (url.startsWith('https://api.telegram.org/')) {
      telegram.push({ method: url.split('/').pop(), payload: JSON.parse(opts.payload) });
      return makeResponse({ body: JSON.stringify({ ok: true, result: { message_id: 1 } }) });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  let updateId = 1;
  const post = (text) => g.get('doPost')({
    parameter: { secret: SECRET },
    postData: {
      contents: JSON.stringify({
        update_id: updateId++,
        message: { message_id: 1, text, chat: { id: USER }, from: { id: USER, first_name: '小明' } },
      }),
    },
  });
  const poll = (token) => JSON.parse(g.get('doGet')({ parameter: { action: 'poll', token } }).getContent());
  return { g, telegram, post, poll };
}

test('轉接站離線：GAS 直接回答', () => {
  const t = setup();
  t.post('/help');
  assert.equal(t.telegram.length, 1);
  assert.ok(t.telegram[0].payload.text.includes('使用說明'));
  assert.ok(t.g.get('doGet')({ parameter: {} }).getContent().includes('轉接站離線'));
});

test('轉接站輪詢後在線：題目排隊、GAS 不回答；下次輪詢取走並清空', () => {
  const t = setup();
  assert.deepEqual(t.poll(SECRET), { ok: true, updates: [] });
  assert.ok(t.g.get('doGet')({ parameter: {} }).getContent().includes('轉接站在線'));

  t.post('查 台北天氣');
  t.post('/help');
  assert.equal(t.telegram.length, 0);

  const res = t.poll(SECRET);
  assert.equal(res.ok, true);
  assert.deepEqual(res.updates.map((u) => u.message.text), ['查 台北天氣', '/help']);
  assert.deepEqual(t.poll(SECRET).updates, []);
});

test('輪詢 token 不符被拒，也不會把轉接站標記為在線', () => {
  const t = setup();
  const res = t.poll('wrong');
  assert.equal(res.ok, false);
  assert.match(res.error, /token 不符/);
  t.post('/help');
  assert.equal(t.telegram.length, 1);
});

test('RELAY_MODE=off：一律由 GAS 回答，輪詢回傳說明', () => {
  const t = setup({ RELAY_MODE: 'off' });
  const res = t.poll(SECRET);
  assert.equal(res.ok, false);
  assert.match(res.error, /RELAY_MODE=off/);
  t.post('/help');
  assert.equal(t.telegram.length, 1);
});

test('轉接站超過 30 秒沒輪詢 → 視為離線，GAS 接手', () => {
  const t = setup();
  t.poll(SECRET);
  const cache = t.g.context.CacheService.getScriptCache();
  cache.put('relay_last_seen', String(Date.now() - 31000));
  t.post('/help');
  assert.equal(t.telegram.length, 1);
});

test('轉接站端：拿到的 update 交給同一套 handleUpdate 處理並回覆 Telegram', () => {
  const gas = setup();
  gas.poll(SECRET);
  gas.post('/start');
  const [update] = gas.poll(SECRET).updates;

  const relay = setup();
  relay.g.get('handleUpdate')(update);
  assert.equal(relay.telegram.length, 1);
  assert.ok(relay.telegram[0].payload.text.includes('歡迎使用'));
});

test('RELAY_MODE 驗證', () => {
  const g = loadGas();
  const errors = g.get('validateConfig')(g.get('buildConfig')({ GEMINI_API_KEY: 'k', RELAY_MODE: 'yes' }), false);
  assert.ok(errors.some((e) => e.includes('RELAY_MODE=yes')));
});

test('轉接站資料存檔：重開後保留對話記憶', () => {
  const dataFile = require('node:path').join(require('node:os').tmpdir(), `relay-test-${process.pid}.json`);
  try {
    const first = setup({ MAX_HISTORY_TURNS: '2' }, { dataFile });
    first.g.get('saveConversationTurn')(USER, '問', '答');
    first.g.save();
    const second = setup({ MAX_HISTORY_TURNS: '2' }, { dataFile });
    assert.equal(second.g.get('getConversationHistory')(USER)[1].content, '答');
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
});

test('Code.gs 與 src/ 同步 (修改 src/ 後請執行 npm run build)', () => {
  assert.equal(fs.readFileSync(OUT_FILE, 'utf8'), buildCode());
});

test('單獨載入 Code.gs 即可運作 (貼進 GAS 編輯器的情境)', () => {
  const t = setup({}, { files: [OUT_FILE] });
  t.post('/help');
  assert.equal(t.telegram.length, 1);
  assert.equal(typeof t.g.get('setWebhook'), 'function');
});
