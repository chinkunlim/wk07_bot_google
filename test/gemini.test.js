// Gemini 客戶端：訊息轉換、請求格式、重試、錯誤 (對應 test/test_ollama.py；離線)
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, makeResponse } = require('../dev/gasShim');

const plain = (x) => JSON.parse(JSON.stringify(x));

function geminiReply(parts, extra) {
  return makeResponse({
    body: JSON.stringify(Object.assign({
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }, extra || {})),
  });
}

test('historyToContents：assistant → model', () => {
  const g = loadGas();
  assert.deepEqual(plain(g.get('historyToContents')([
    { role: 'user', content: '問' }, { role: 'assistant', content: '答' },
  ])), [
    { role: 'user', parts: [{ text: '問' }] },
    { role: 'model', parts: [{ text: '答' }] },
  ]);
});

test('extractCandidateText 略過思考摘要；extractFunctionCalls 取出參數', () => {
  const g = loadGas();
  const content = {
    parts: [
      { text: '思考中', thought: true },
      { text: '答案' },
      { functionCall: { name: 'search_web', args: { query: '台北 天氣' }, id: 'c1' }, thoughtSignature: 'sig' },
    ],
  };
  assert.equal(g.get('extractCandidateText')(content), '答案');
  assert.deepEqual(plain(g.get('extractFunctionCalls')(content)), [{ id: 'c1', name: 'search_web', args: { query: '台北 天氣' } }]);
});

test('parseRouterDecision：JSON、程式碼區塊包裝、解析失敗視為不搜尋', () => {
  const g = loadGas();
  const parse = g.get('parseRouterDecision');
  assert.deepEqual(plain(parse('{"need_search": true, "query": " 台北 天氣 "}')), { need_search: true, query: '台北 天氣' });
  assert.deepEqual(plain(parse('```json\n{"need_search": false, "query": ""}\n```')), { need_search: false, query: '' });
  assert.deepEqual(plain(parse('不是 JSON')), { need_search: false, query: '' });
});

test('buildSystemPrompt 依判斷方式帶入規則與日期', () => {
  const g = loadGas();
  const build = g.get('buildSystemPrompt');
  assert.ok(build('tools', '2026-10-19').includes('今天日期：2026-10-19'));
  assert.ok(build('tools', '2026-10-19').includes('search_web'));
  assert.ok(!build('router', '2026-10-19').includes('search_web'));
});

test('geminiGenerate：請求格式 (API key 標頭、systemInstruction、工具)', () => {
  const g = loadGas({ props: { GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-test' } });
  let captured;
  g.setFetch((url, opts) => {
    captured = { url, opts };
    return geminiReply([{ text: '你好' }]);
  });
  const res = g.get('geminiGenerate')([{ role: 'user', parts: [{ text: 'hi' }] }], {
    systemInstruction: 'SYS',
    tools: [g.get('SEARCH_TOOL')],
  });
  assert.equal(res.text, '你好');
  assert.equal(res.usage.totalTokenCount, 15);
  assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(captured.opts.headers['x-goog-api-key'], 'test-key');
  const body = JSON.parse(captured.opts.payload);
  assert.equal(body.systemInstruction.parts[0].text, 'SYS');
  assert.equal(body.tools[0].functionDeclarations[0].name, 'search_web');
  assert.equal(body.toolConfig.functionCallingConfig.mode, 'AUTO');
  assert.equal(body.generationConfig.temperature, undefined);
});

test('decideSearch：使用 JSON schema 並回傳判斷', () => {
  const g = loadGas({ props: { GEMINI_API_KEY: 'k' } });
  let body;
  g.setFetch((url, opts) => {
    body = JSON.parse(opts.payload);
    return geminiReply([{ text: '{"need_search": true, "query": "台北 天氣"}' }]);
  });
  const d = g.get('decideSearch')([{ role: 'user', parts: [{ text: '台北天氣' }] }], '2026-10-19');
  assert.equal(d.need_search, true);
  assert.equal(d.query, '台北 天氣');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.systemInstruction.parts[0].text.includes('2026-10-19'));
});

test('429 依 retryDelay 重試一次後成功 (沒有備援模型時)', () => {
  const g = loadGas({ props: { GEMINI_API_KEY: 'k', GEMINI_RETRIES: '1', GEMINI_FALLBACK_MODELS: '' } });
  let calls = 0;
  g.setFetch(() => {
    calls += 1;
    if (calls === 1) {
      return makeResponse({
        code: 429,
        body: JSON.stringify({ error: { code: 429, message: 'quota', details: [{ retryDelay: '3s' }] } }),
      });
    }
    return geminiReply([{ text: 'ok' }]);
  });
  assert.equal(g.get('geminiGenerate')([{ role: 'user', parts: [{ text: 'hi' }] }]).text, 'ok');
  assert.equal(calls, 2);
});

test('錯誤轉成 GeminiError (含狀態碼)；建議等待過久不重試', () => {
  const g = loadGas({ props: { GEMINI_API_KEY: 'k', GEMINI_RETRIES: '2', GEMINI_FALLBACK_MODELS: '' } });
  let calls = 0;
  g.setFetch(() => {
    calls += 1;
    return makeResponse({
      code: 429,
      body: JSON.stringify({ error: { code: 429, message: 'daily quota', details: [{ retryDelay: '3600s' }] } }),
    });
  });
  assert.throws(() => g.get('geminiGenerate')([]), (e) => e.name === 'GeminiError' && e.status === 429);
  assert.equal(calls, 1);

  g.setFetch(() => { throw new Error('Address unavailable'); });
  assert.throws(() => g.get('geminiGenerate')([]), (e) => e.status === 0);

  g.setFetch(() => makeResponse({ code: 404, body: JSON.stringify({ error: { message: 'model not found' } }) }));
  assert.throws(() => g.get('geminiGenerate')([]), (e) => e.status === 404 && /model not found/.test(e.message));
});

test('沒有候選回覆 (安全封鎖) 回傳空文字', () => {
  const g = loadGas({ props: { GEMINI_API_KEY: 'k' } });
  g.setFetch(() => makeResponse({ body: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) }));
  const res = g.get('geminiGenerate')([]);
  assert.equal(res.text, '');
  assert.equal(res.finishReason, 'SAFETY');
});

test('listGeminiModels：分頁並只保留 generateContent 模型', () => {
  const g = loadGas({ props: { GEMINI_API_KEY: 'k' } });
  g.setFetch((url) => makeResponse({
    body: JSON.stringify(url.includes('pageToken')
      ? { models: [{ name: 'models/b', supportedGenerationMethods: ['generateContent'] }] }
      : {
        models: [
          { name: 'models/a', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000 },
          { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
        ],
        nextPageToken: 'p2',
      }),
  }));
  assert.deepEqual(plain(g.get('listGeminiModels')().map((m) => m.name)), ['a', 'b']);
});

test('addUsage 累加 token', () => {
  const g = loadGas();
  const total = {};
  g.get('addUsage')(total, { promptTokenCount: 3, totalTokenCount: 5 });
  g.get('addUsage')(total, { promptTokenCount: 2, totalTokenCount: 4 });
  assert.deepEqual(plain(total), { promptTokenCount: 5, totalTokenCount: 9 });
});

// ===== 429 自動切換備援模型 =====

const modelOf = (url) => /models\/([^:]+):generateContent/.exec(url)[1];
const quota429 = (message) => makeResponse({
  code: 429,
  body: JSON.stringify({ error: { code: 429, message: message || 'quota exceeded', details: [{ retryDelay: '30s' }] } }),
});

test('GEMINI_MODELS：主模型在前、備援去重、留空只有主模型', () => {
  const g = loadGas();
  const build = g.get('buildConfig');
  assert.deepEqual(plain(build({ GEMINI_MODEL: 'a', GEMINI_FALLBACK_MODELS: ' b, a ,,c ' }).GEMINI_MODELS), ['a', 'b', 'c']);
  assert.deepEqual(plain(build({ GEMINI_MODEL: 'a', GEMINI_FALLBACK_MODELS: '' }).GEMINI_MODELS), ['a']);
  assert.equal(build({}).GEMINI_MODELS.length, 3);
});

test('主模型 429 → 不等待直接改用備援，回傳實際模型；之後先用備援', () => {
  const g = loadGas({ props: { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'main', GEMINI_FALLBACK_MODELS: 'backup1,backup2' } });
  const tried = [];
  g.setFetch((url) => {
    tried.push(modelOf(url));
    return modelOf(url) === 'main' ? quota429() : geminiReply([{ text: `from ${modelOf(url)}` }]);
  });
  const res = g.get('geminiGenerate')([{ role: 'user', parts: [{ text: 'hi' }] }]);
  assert.equal(res.text, 'from backup1');
  assert.equal(res.model, 'backup1');
  assert.deepEqual(plain(tried), ['main', 'backup1']);

  // main 已記為額度用完 → 下一次直接從 backup1 開始
  tried.length = 0;
  assert.equal(g.get('geminiGenerate')([]).model, 'backup1');
  assert.deepEqual(plain(tried), ['backup1']);
});

test('503 過載也切換；400 / 404 不切換', () => {
  const g = loadGas({ props: { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'main', GEMINI_FALLBACK_MODELS: 'backup' } });
  g.setFetch((url) => (modelOf(url) === 'main'
    ? makeResponse({ code: 503, body: JSON.stringify({ error: { message: 'overloaded' } }) })
    : geminiReply([{ text: 'ok' }])));
  assert.equal(g.get('geminiGenerate')([]).model, 'backup');

  for (const code of [400, 404]) {
    const g2 = loadGas({ props: { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'main', GEMINI_FALLBACK_MODELS: 'backup' } });
    const tried = [];
    g2.setFetch((url) => {
      tried.push(modelOf(url));
      return makeResponse({ code, body: JSON.stringify({ error: { message: 'bad' } }) });
    });
    assert.throws(() => g2.get('geminiGenerate')([]), (e) => e.status === code);
    assert.deepEqual(plain(tried), ['main']);
  }
});

test('所有模型都 429 → 拋出 429；明確指定 model 時只用該模型', () => {
  const g = loadGas({ props: { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'main', GEMINI_FALLBACK_MODELS: 'b1,b2', GEMINI_RETRIES: '0' } });
  const tried = [];
  g.setFetch((url) => {
    tried.push(modelOf(url));
    return quota429();
  });
  assert.throws(() => g.get('geminiGenerate')([]), (e) => e.status === 429);
  assert.deepEqual(plain(tried), ['main', 'b1', 'b2']);

  tried.length = 0;
  assert.throws(() => g.get('geminiGenerate')([], { model: 'only' }), (e) => e.status === 429);
  assert.deepEqual(plain(tried), ['only']);
});

test('暫停秒數：每日額度 1 小時、每分鐘限制依建議等待', () => {
  const g = loadGas();
  const seconds = g.get('geminiExhaustedSeconds');
  const GeminiError = g.get('GeminiError');
  assert.equal(seconds(new GeminiError('Quota exceeded for GenerateRequestsPerDayPerProjectPerModel', 429, 30)), 3600);
  assert.equal(seconds(new GeminiError('per minute', 429, 30)), 30);
  assert.equal(seconds(new GeminiError('per minute', 429, 0)), 60);
  assert.equal(seconds(new GeminiError('overloaded', 503, 0)), 60);
});
