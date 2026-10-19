// 端對端：doPost → 指令路由 → 搜尋判斷 → Gemini → Telegram 回覆 (假網路，對應 test/e2e_bot.py)
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, makeResponse } = require('../dev/gasShim');

const USER = 111;
const STRANGER = 999;
const TOKEN = '123456:' + 'A'.repeat(35);
const BING_HTML = `<li class="b_algo"><h2><a href="https://weather.example/taipei">台北天氣預報</a></h2>
<div class="b_caption"><p>今日晴時多雲 28 度</p></div></li>`;

/**
 * 建立假網路：Telegram 呼叫記錄在 sent；Gemini 依序回傳 geminiReplies
 */
function setup(props, geminiReplies) {
  const g = loadGas({
    props: Object.assign({
      TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USER_IDS: String(USER), GEMINI_API_KEY: 'k',
      GEMINI_MODEL: 'gemini-test', SEARCH_ENGINE: 'multi', SEARCH_FALLBACK_ENGINE: '',
      SEARCH_FETCH_PAGES: '1', WEBHOOK_SECRET: 's3cret',
    }, props || {}),
  });
  const sent = [];
  const geminiBodies = [];
  let nextMessageId = 500;
  g.setFetch((url, opts) => {
    if (url.startsWith('https://api.telegram.org/')) {
      const method = url.split('/').pop();
      const payload = JSON.parse(opts.payload);
      sent.push({ method, payload });
      const result = method === 'sendMessage' ? { message_id: nextMessageId++ } : true;
      return makeResponse({ body: JSON.stringify({ ok: true, result }) });
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiBodies.push(JSON.parse(opts.payload));
      const reply = geminiReplies.shift();
      if (reply instanceof Error) return makeResponse({ code: 429, body: JSON.stringify({ error: { message: reply.message } }) });
      const parts = typeof reply === 'string' ? [{ text: reply }] : reply;
      return makeResponse({
        body: JSON.stringify({
          candidates: [{ content: { role: 'model', parts } }],
          usageMetadata: { totalTokenCount: 10 },
        }),
      });
    }
    if (url.includes('bing.com')) return makeResponse({ body: BING_HTML });
    if (url.startsWith('https://weather.example/')) {
      return makeResponse({ headers: { 'Content-Type': 'text/html' }, body: '<h1>台北</h1><p>週一 晴 28 度</p>' });
    }
    return makeResponse({ code: 404, body: '' });
  });
  let updateId = 1;
  const post = (text, from, secret) => g.get('doPost')({
    parameter: { secret: secret === undefined ? 's3cret' : secret },
    postData: {
      contents: JSON.stringify({
        update_id: updateId++,
        message: { message_id: 1, text, chat: { id: from || USER }, from: { id: from || USER, first_name: '小明' } },
      }),
    },
  });
  const texts = () => sent.filter((s) => s.method === 'sendMessage' || s.method === 'editMessageText').map((s) => s.payload.text);
  return { g, sent, geminiBodies, post, texts };
}

test('/start 不需白名單；未授權使用者提問被拒且不呼叫 Gemini', () => {
  const t = setup({}, []);
  t.post('/start', STRANGER);
  assert.ok(t.texts()[0].includes('歡迎使用雲端 AI 助理'));
  assert.ok(t.texts()[0].includes('gemini-test'));
  t.post('你好', STRANGER);
  assert.ok(t.texts()[1].includes('存取受限'));
  assert.ok(t.texts()[1].includes(String(STRANGER)));
  assert.equal(t.geminiBodies.length, 0);
});

test('webhook secret 不符時忽略；重複 update 只處理一次', () => {
  const t = setup({}, ['答']);
  t.post('/help', USER, 'wrong');
  assert.equal(t.sent.length, 0);
  const body = { parameter: { secret: 's3cret' }, postData: { contents: JSON.stringify({ update_id: 77, message: { text: '/help', chat: { id: USER }, from: { id: USER } } }) } };
  t.g.get('doPost')(body);
  t.g.get('doPost')(body);
  assert.equal(t.texts().length, 1);
});

test('router：不需搜尋 → 直接回答、狀態訊息被編輯成最終回覆、存歷史與日誌', () => {
  const t = setup({}, ['{"need_search": false, "query": ""}', '**你好**！我是助理。']);
  t.post('你好');
  const status = t.sent.find((s) => s.method === 'sendMessage');
  assert.equal(status.payload.text, '🤔 思考中...');
  assert.equal(t.sent.filter((s) => s.method === 'sendMessage').length, 1);
  const final = t.sent.filter((s) => s.method === 'editMessageText').pop();
  assert.equal(final.payload.message_id, 500); // 狀態訊息 (第一則送出的 id) 被編輯成最終回覆
  assert.ok(final.payload.text.startsWith('<b>你好</b>！我是助理。'));
  assert.ok(final.payload.text.includes('Gemini gemini-test'));
  assert.ok(final.payload.text.includes('本日已提問: 1/50'));
  assert.ok(!final.payload.text.includes('搜尋來源'));
  // 最終回答不帶工具
  assert.equal(t.geminiBodies[1].tools, undefined);
  const history = t.g.get('getConversationHistory')(USER);
  assert.equal(history[1].content, '**你好**！我是助理。');
  const logs = Object.values(t.g.spreadsheets)[0].getSheetByName('Logs').rows;
  assert.equal(logs[1][5], '{"totalTokenCount":20}');
});

test('router：需要搜尋 → 搜尋結果與網頁內文附在問題後、回覆附來源', () => {
  const t = setup({}, ['{"need_search": true, "query": "台北 天氣"}', '台北今天晴，28 度。']);
  t.post('台北今天天氣如何？');
  const finalBody = t.geminiBodies[1];
  const userParts = finalBody.contents[finalBody.contents.length - 1].parts;
  assert.equal(userParts[0].text, '台北今天天氣如何？');
  assert.ok(userParts[1].text.includes('【即時搜尋結果】'));
  assert.ok(userParts[1].text.includes('內文摘錄：\n台北\n週一 晴 28 度'));
  assert.ok(!finalBody.systemInstruction.parts[0].text.includes('search_web'));
  const final = t.texts().pop();
  assert.ok(final.includes('🔍 <b>搜尋來源：</b>'));
  assert.ok(final.includes('<a href="https://weather.example/taipei">台北天氣預報</a>'));
  assert.ok(t.texts().includes('🔍 正在搜尋資訊...'));
});

test('router：追問時帶入對話歷史', () => {
  const t = setup({}, ['{"need_search": false, "query": ""}', '第一個答案', '{"need_search": false, "query": ""}', '第二個答案']);
  t.post('第一個問題');
  t.post('那第二個呢？');
  const routerBody = t.geminiBodies[2];
  assert.deepEqual(routerBody.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(routerBody.contents[1].parts[0].text, '第一個答案');
});

test('tools：模型呼叫 search_web → functionResponse 回傳、保留 thoughtSignature', () => {
  const t = setup({ SEARCH_DECISION: 'tools' }, [
    [{ functionCall: { name: 'search_web', args: { query: '台北 天氣' }, id: 'call-1' }, thoughtSignature: 'SIG' }],
    '台北晴天。',
  ]);
  t.post('台北天氣');
  assert.equal(t.geminiBodies[0].tools[0].functionDeclarations[0].name, 'search_web');
  const second = t.geminiBodies[1].contents;
  assert.equal(second[1].role, 'model');
  assert.equal(second[1].parts[0].thoughtSignature, 'SIG');
  const fr = second[2].parts[0].functionResponse;
  assert.equal(fr.name, 'search_web');
  assert.equal(fr.id, 'call-1');
  assert.ok(fr.response.result.includes('台北天氣預報'));
  assert.ok(t.texts().pop().includes('搜尋來源'));
  assert.ok(t.texts().includes('🔍 正在搜尋資訊 (第 1 輪)...'));
});

test('tools：連續 3 輪都呼叫工具 → 以 toolMode NONE 產生最終回答', () => {
  const call = [{ functionCall: { name: 'search_web', args: { query: 'x' } } }];
  const t = setup({ SEARCH_DECISION: 'tools', SEARCH_FETCH_PAGES: '0' }, [call, call, call, '最後答案']);
  t.post('一直搜尋');
  assert.equal(t.geminiBodies.length, 4);
  assert.equal(t.geminiBodies[3].toolConfig.functionCallingConfig.mode, 'NONE');
  assert.ok(t.texts().pop().startsWith('最後答案'));
});

test('Gemini 429 (沒有備援模型) → 友善訊息並退還額度', () => {
  const t = setup({ GEMINI_RETRIES: '0', GEMINI_FALLBACK_MODELS: '' }, [new Error('quota exceeded')]);
  t.post('你好');
  const final = t.texts().pop();
  assert.ok(final.includes('❌ <b>錯誤</b>'));
  assert.ok(final.includes('使用量已達上限'));
  assert.equal(t.g.get('getQuotaStatus')(USER).current, 0);
});

test('模型沒有產生回覆 → 錯誤訊息並退還額度', () => {
  const t = setup({}, ['{"need_search": false, "query": ""}', '']);
  t.post('你好');
  assert.ok(t.texts().pop().includes('模型未產生回覆'));
  assert.equal(t.g.get('getQuotaStatus')(USER).current, 0);
});

test('配額用盡時不呼叫 Gemini', () => {
  const t = setup({ MAX_DAILY_REQUESTS: '1' }, ['{"need_search": false, "query": ""}', '答']);
  t.post('第一題');
  t.post('第二題');
  assert.ok(t.texts().pop().includes('已達上限'));
  assert.equal(t.geminiBodies.length, 2);
});

test('/search 空關鍵字不扣額度；/status、/reset、/news、/models', () => {
  const t = setup({}, ['{"need_search": true, "query": "新聞"}', '今日頭條…']);
  t.post('/search');
  assert.ok(t.texts().pop().includes('請提供搜尋關鍵字'));
  t.post('/status');
  assert.ok(t.texts().pop().includes('已使用：<b>0</b> 次'));
  t.post('/news@MyBot');
  assert.equal(t.geminiBodies[0].contents.pop().parts[0].text, '最新新聞頭條');
  t.post('/reset');
  assert.ok(t.texts().pop().includes('對話記憶已清空'));
  assert.equal(t.g.get('getConversationHistory')(USER).length, 0);
  t.post('/unknown');
  assert.ok(t.texts().pop().includes('對話記憶已清空'));
});

test('/models 列出模型並標示目前使用', () => {
  const t = setup({}, []);
  t.g.set('listGeminiModels', () => [{ name: 'gemini-test', inputTokenLimit: 1048576 }, { name: 'gemini-other' }]);
  t.post('/models');
  const final = t.texts().pop();
  assert.ok(final.includes('<code>gemini-test</code> (1049K) 👉'));
  assert.ok(final.includes('<code>gemini-other</code>'));
});

test('長回覆自動分段，第一段編輯狀態訊息、其餘新訊息', () => {
  const long = Array.from({ length: 200 }, (_, i) => `第 ${i} 行：${'內容'.repeat(15)}`).join('\n');
  const t = setup({}, ['{"need_search": false, "query": ""}', long]);
  t.post('寫很長的內容');
  const edits = t.sent.filter((s) => s.method === 'editMessageText');
  const sends = t.sent.filter((s) => s.method === 'sendMessage');
  assert.ok(edits.length >= 1);
  assert.ok(sends.length >= 2); // 狀態訊息 + 後續段落
  assert.ok([...edits, ...sends].every((s) => s.payload.text.length <= 4096));
});

test('HTML 解析失敗時改送純文字', () => {
  const t = setup({}, []);
  let first = true;
  const ctx = t.g.context;
  const original = ctx.UrlFetchApp.fetch;
  ctx.UrlFetchApp.fetch = (url, opts) => {
    if (url.endsWith('/sendMessage') && first) {
      first = false;
      return makeResponse({ body: JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }) });
    }
    return original(url, opts);
  };
  const id = t.g.get('tgSendMessage')(USER, '<b>壞掉的 &lt;HTML</b>', 'HTML');
  assert.ok(id);
  const retry = t.sent.pop();
  assert.equal(retry.payload.text, '壞掉的 <HTML');
  assert.equal(retry.payload.parse_mode, undefined);
});

test('parseCommand', () => {
  const g = loadGas();
  const parse = g.get('parseCommand');
  assert.deepEqual(JSON.parse(JSON.stringify(parse('/search@MyBot 台灣 亞運'))), { command: 'search', args: '台灣 亞運' });
  assert.equal(parse('你好 /search'), null);
});

test('主模型 429 → 備援模型回答，頁尾標示 (備援)、日誌記錄實際模型', () => {
  const t = setup({ GEMINI_FALLBACK_MODELS: 'gemini-backup' }, [
    new Error('quota exceeded'), // router 判斷：主模型 429 → 改用備援
    '{"need_search": false, "query": ""}',
    '備援模型的答案',
  ]);
  t.post('你好');
  const final = t.texts().pop();
  assert.ok(final.startsWith('備援模型的答案'));
  assert.ok(final.includes('Gemini gemini-backup (備援)'));
  const logs = Object.values(t.g.spreadsheets)[0].getSheetByName('Logs').rows;
  assert.equal(logs[0][7], 'model');
  assert.equal(logs[1][7], 'gemini-backup');
  assert.equal(t.g.get('getQuotaStatus')(USER).current, 1);
});

test('/models 標示主模型與備援模型', () => {
  const t = setup({ GEMINI_FALLBACK_MODELS: 'gemini-backup' }, []);
  t.g.set('listGeminiModels', () => [{ name: 'gemini-test' }, { name: 'gemini-backup' }]);
  t.post('/models');
  const final = t.texts().pop();
  assert.ok(final.includes('<code>gemini-test</code> 👉'));
  assert.ok(final.includes('<code>gemini-backup</code> ↪️'));
  assert.ok(final.includes('額度用完時依序改用：gemini-backup'));
});

test('isWebAppExecUrl：個人與 Workspace (學校) 網址都接受，/dev 不接受', () => {
  const g = loadGas();
  const ok = g.get('isWebAppExecUrl');
  assert.ok(ok('https://script.google.com/macros/s/AKfycbx123/exec'));
  assert.ok(ok('https://script.google.com/a/gms.ndhu.edu.tw/macros/s/AKfycbx123/exec'));
  assert.ok(ok('https://script.google.com/a/macros/gms.ndhu.edu.tw/s/AKfycbx123/exec'));
  assert.ok(!ok('https://script.google.com/a/gms.ndhu.edu.tw/macros/s/AKfycbx123/dev'));
  assert.ok(!ok('https://example.com/macros/s/x/exec'));
  assert.ok(!ok(''));
});

test('setWebhook：未設定 / /dev 網址給出明確說明；正確網址會設定 webhook 並產生 secret', () => {
  const t = setup({ WEBHOOK_SECRET: '' }, []);
  assert.throws(() => t.g.get('setWebhook')(), /WEBHOOK_URL 未設定/);

  t.g.setProps({ WEBHOOK_URL: 'https://script.google.com/a/gms.ndhu.edu.tw/macros/s/AKfy/dev' });
  assert.throws(() => t.g.get('setWebhook')(), /\/dev 是測試網址/);

  const url = 'https://script.google.com/a/gms.ndhu.edu.tw/macros/s/AKfy/exec';
  t.g.setProps({ WEBHOOK_URL: url });
  t.g.get('setWebhook')();
  const call = t.sent.find((s) => s.method === 'setWebhook');
  assert.ok(t.g.props.WEBHOOK_SECRET);
  assert.equal(call.payload.url, `${url}?secret=${t.g.props.WEBHOOK_SECRET}`);
  assert.ok(t.sent.some((s) => s.method === 'setMyCommands'));
});
