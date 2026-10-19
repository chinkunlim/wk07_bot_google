// 設定解析、對話歷史、配額、日誌、webhook 去重 (對應 test/test_settings.py、test_conversation.py)
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../dev/gasShim');

const plain = (x) => JSON.parse(JSON.stringify(x));
const VALID_TOKEN = '123456:' + 'A'.repeat(35);

test('parseUserIds 分出有效與無效項目', () => {
  const g = loadGas();
  assert.deepEqual(plain(g.get('parseUserIds')(' 123, -456 ,abc,, 7x ')), { ids: [123, -456], invalid: ['abc', '7x'] });
});

test('buildConfig：預設值、數字轉型、錯誤數字退回預設', () => {
  const g = loadGas();
  const cfg = g.get('buildConfig')({ MAX_DAILY_REQUESTS: '10', SEARCH_PAGE_CHARS: 'abc', ALLOWED_USER_IDS: '1,2' });
  assert.equal(cfg.MAX_DAILY_REQUESTS, 10);
  assert.equal(cfg.SEARCH_PAGE_CHARS, 2000);
  assert.equal(cfg.SEARCH_ENGINE, 'duckduckgo');
  assert.deepEqual(plain(cfg.ALLOWED_USER_IDS), [1, 2]);
});

test('validateConfig 檢查必要欄位與可用值', () => {
  const g = loadGas();
  const build = g.get('buildConfig');
  const validate = g.get('validateConfig');
  const ok = build({ TELEGRAM_BOT_TOKEN: VALID_TOKEN, ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k' });
  assert.deepEqual(plain(validate(ok, true)), []);

  const bad = build({ TELEGRAM_BOT_TOKEN: 'abc', ALLOWED_USER_IDS: 'x', SEARCH_ENGINE: 'ddgs', SEARCH_DECISION: 'auto' });
  const errors = validate(bad, true).join('\n');
  for (const s of ['TELEGRAM_BOT_TOKEN 格式不對', 'ALLOWED_USER_IDS 未設定', '非數字項目: x', 'GEMINI_API_KEY',
    'SEARCH_ENGINE=ddgs', 'SEARCH_DECISION=auto']) {
    assert.ok(errors.includes(s), s);
  }
  // 模擬模式不需要 Telegram 設定
  assert.deepEqual(plain(validate(build({ GEMINI_API_KEY: 'k' }), false)), []);
});

test('setupProperties 補上預設值並自動建立試算表', () => {
  const g = loadGas({ props: { GEMINI_API_KEY: 'k' } });
  g.get('setupProperties')();
  assert.equal(g.props.SEARCH_DECISION, 'router');
  assert.equal(g.props.GEMINI_API_KEY, 'k');
  assert.ok(g.props.SPREADSHEET_ID);
});

test('配額：消耗、達上限拒絕、退還、查詢', () => {
  const g = loadGas({ props: { MAX_DAILY_REQUESTS: '2' } });
  const consume = g.get('checkAndConsumeQuota');
  assert.equal(consume(1).current, 1);
  const second = consume(1);
  assert.deepEqual(plain(second), { allowed: true, current: 2, remaining: 0, max: 2 });
  const third = consume(1);
  assert.equal(third.allowed, false);
  assert.ok(third.message.includes('已達上限'));
  // 其他使用者不受影響
  assert.equal(consume(2).current, 1);

  g.get('refundQuota')(1);
  const status = g.get('getQuotaStatus')(1);
  assert.equal(status.current, 1);
  assert.equal(status.remaining, 1);
  assert.match(status.date, /^\d{4}-\d{2}-\d{2}$/);

  g.get('resetUserQuota')(1);
  assert.equal(g.get('getQuotaStatus')(1).current, 0);
});

test('對話歷史：保留最近 N 輪、略過空內容、清除', () => {
  const g = loadGas({ props: { MAX_HISTORY_TURNS: '2' } });
  const save = g.get('saveConversationTurn');
  const get = g.get('getConversationHistory');
  assert.deepEqual(plain(get(5)), []);
  save(5, '問1', '答1');
  save(5, '問2', '答2');
  save(5, '問3', '答3');
  save(5, '', '空的不存');
  assert.deepEqual(plain(get(5)).map((m) => m.content), ['問2', '答2', '問3', '答3']);
  assert.equal(get(5)[1].role, 'assistant');
  assert.deepEqual(plain(get(6)), []);
  g.get('clearConversationHistory')(5);
  assert.deepEqual(plain(get(5)), []);
});

test('appendHistoryTurn 超過儲存格上限時丟棄舊輪', () => {
  const g = loadGas();
  const append = g.get('appendHistoryTurn');
  const big = '字'.repeat(20000);
  let turns = [];
  for (let i = 0; i < 4; i++) turns = append(turns, `問${i}`, big, 10, 't');
  assert.ok(JSON.stringify(turns).length <= g.get('HISTORY_CELL_LIMIT'));
  assert.equal(turns[turns.length - 1].user, '問3');
});

test('logInteraction 寫入 Logs 分頁並截斷長回覆', () => {
  const g = loadGas();
  g.get('logInteraction')({ userId: 9, userName: '小明', prompt: '問', response: 'x'.repeat(600), tokens: { totalTokenCount: 3 }, dailyCount: 1 });
  const ss = Object.values(g.spreadsheets)[0];
  const rows = ss.getSheetByName('Logs').rows;
  assert.deepEqual(rows[0], ['timestamp', 'user_id', 'user_name', 'prompt', 'response', 'tokens', 'daily_count', 'model', 'source']);
  assert.equal(rows[1][1], '9');
  assert.equal(rows[1][4].length, 503);
  assert.equal(rows[1][5], '{"totalTokenCount":3}');
});

test('isDuplicateUpdate 同一個 update_id 只處理一次', () => {
  const g = loadGas();
  const dup = g.get('isDuplicateUpdate');
  assert.equal(dup(100), false);
  assert.equal(dup(100), true);
  assert.equal(dup(101), false);
});

test('白名單', () => {
  const g = loadGas({ props: { ALLOWED_USER_IDS: '11,22' } });
  assert.ok(g.get('isUserAuthorized')(22));
  assert.ok(!g.get('isUserAuthorized')(33));
});
