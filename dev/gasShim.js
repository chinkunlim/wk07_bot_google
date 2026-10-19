/**
 * 在本機 Node 執行 GAS 程式碼的模擬環境 (測試與本機模擬共用)
 * - 把 src/*.js 全部載入同一個 vm context，等同 GAS 的共用全域命名空間
 * - 提供 PropertiesService / CacheService / LockService / Utilities / Session /
 *   UrlFetchApp / SpreadsheetApp / ContentService 的最小替身
 * 不需安裝任何套件；UrlFetchApp 預設不連網 (測試注入假 fetch，模擬模式改用 curl)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SRC_DIR = path.join(__dirname, '..', 'src');

// ===== HTTP 回應 =====

function makeResponse({ code = 200, headers = {}, body = '' }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  return {
    getResponseCode: () => code,
    getHeaders: () => headers,
    getContent: () => Array.from(buf),
    getContentText: (charset) => new TextDecoder(charset || 'utf-8').decode(buf),
    getBlob: () => makeBlob(Array.from(buf)),
  };
}

function makeBlob(bytes) {
  const buf = Buffer.from(bytes.map((b) => b & 0xff));
  return {
    getBytes: () => Array.from(buf),
    getDataAsString: (charset) => {
      const cs = String(charset || 'utf-8').toLowerCase();
      return new TextDecoder(cs === 'iso-8859-1' ? 'latin1' : cs).decode(buf);
    },
  };
}

/** 以 curl 實際連網 (同步，與 UrlFetchApp 行為一致)；只在本機模擬模式使用 */
function curlFetch(url, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-fetch-'));
  const headerFile = path.join(dir, 'h');
  const bodyFile = path.join(dir, 'b');
  const method = String(options.method || 'get').toUpperCase();
  const args = ['-sS', '--max-time', '60', '-X', method, '-D', headerFile, '-o', bodyFile, '-w', '%{http_code}'];
  if (options.followRedirects !== false) args.push('-L');
  const headers = Object.assign({}, options.headers || {});
  if (options.contentType) headers['Content-Type'] = options.contentType;
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  let input;
  if (options.payload !== undefined && options.payload !== null) {
    if (typeof options.payload === 'object') {
      for (const [k, v] of Object.entries(options.payload)) args.push('--data-urlencode', `${k}=${v}`);
    } else {
      args.push('--data-binary', '@-');
      input = String(options.payload);
    }
  }
  args.push(url);
  try {
    const code = Number(execFileSync('curl', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    // 有轉址時標頭檔含多段，取最後一段
    const blocks = fs.readFileSync(headerFile, 'latin1').trim().split(/\r?\n\r?\n/);
    const respHeaders = {};
    for (const line of blocks[blocks.length - 1].split(/\r?\n/).slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) respHeaders[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const body = fs.readFileSync(bodyFile);
    if (!options.muteHttpExceptions && code >= 400) {
      throw new Error(`Request failed for ${url} returned code ${code}`);
    }
    return makeResponse({ code, headers: respHeaders, body });
  } catch (e) {
    if (e.status !== undefined) throw new Error(`Exception: ${String(e.stderr || e.message).trim()}: ${url}`);
    throw e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function offlineFetch(url) {
  throw new Error(`測試環境不連網：${url}`);
}

// ===== 試算表替身 (記憶體) =====

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }

  getValue() {
    return this.getValues()[0][0];
  }

  setValues(values) {
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.rows.length <= idx) this.sheet.rows.push([]);
      line.forEach((v, c) => { this.sheet.rows[idx][this.col - 1 + c] = v; });
    });
    return this;
  }

  setValue(v) {
    return this.setValues([[v]]);
  }

  setNumberFormat() {
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
  }

  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols);
  }

  getLastRow() {
    return this.rows.length;
  }

  getLastColumn() {
    return this.rows.reduce((m, r) => Math.max(m, r.length), 0);
  }

  getMaxRows() {
    return 1000;
  }

  appendRow(values) {
    this.rows.push(values.slice());
    return this;
  }

  deleteRow(row) {
    this.rows.splice(row - 1, 1);
  }

  setFrozenRows() {}
}

class FakeSpreadsheet {
  constructor(name, id) {
    this.name = name;
    this.id = id;
    this.sheets = {};
  }

  getSheetByName(name) {
    return this.sheets[name] || null;
  }

  insertSheet(name) {
    this.sheets[name] = new FakeSheet(name);
    return this.sheets[name];
  }

  getId() {
    return this.id;
  }

  getUrl() {
    return `memory://spreadsheet/${this.id}`;
  }
}

// ===== 載入 GAS 程式碼 =====

/**
 * 建立 GAS 模擬環境並載入 src/*.js
 * options.props：指令碼屬性；options.fetch：UrlFetchApp.fetch 的實作 (預設不連網)
 * 回傳 {context, get(name), set(name, value), props, spreadsheets, logs}
 */
function loadGas(options = {}) {
  const props = Object.assign({}, options.props || {});
  const cache = new Map();
  const spreadsheets = {};
  const logs = [];
  let fetchImpl = options.fetch || offlineFetch;

  const record = (level) => (...args) => {
    logs.push({ level, text: args.join(' ') });
    if (options.verbose) console[level](...args);
  };

  const sandbox = {
    console: { log: record('log'), info: record('log'), warn: record('warn'), error: record('error') },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => Object.assign({}, props),
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        setProperties: (obj) => { for (const [k, v] of Object.entries(obj)) props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => {
          const hit = cache.get(k);
          if (!hit || hit.expires < Date.now()) return null;
          return hit.value;
        },
        put: (k, v, ttl = 600) => { cache.set(k, { value: String(v), expires: Date.now() + ttl * 1000 }); },
        remove: (k) => { cache.delete(k); },
      }),
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }),
    },
    Session: { getScriptTimeZone: () => 'Asia/Taipei' },
    Utilities: {
      formatDate: (date, tz, pattern) => {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
          }).formatToParts(date).map((p) => [p.type, p.value]),
        );
        return pattern
          .replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
          .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second)
          .replace(/'/g, '');
      },
      sleep: (ms) => { if (options.realSleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
      getUuid: () => crypto.randomUUID(),
      newBlob: (bytes) => makeBlob(Array.isArray(bytes) ? bytes : Array.from(Buffer.from(String(bytes)))),
      base64DecodeWebSafe: (s) => Array.from(Buffer.from(s, 'base64url')),
    },
    UrlFetchApp: {
      fetch: (url, opts) => fetchImpl(url, opts || {}),
      fetchAll: (requests) => requests.map((r) => fetchImpl(r.url, r)),
    },
    SpreadsheetApp: {
      create: (name) => {
        const id = `sheet-${Object.keys(spreadsheets).length + 1}`;
        spreadsheets[id] = new FakeSpreadsheet(name, id);
        return spreadsheets[id];
      },
      openById: (id) => {
        if (!spreadsheets[id]) spreadsheets[id] = new FakeSpreadsheet('opened', id);
        return spreadsheets[id];
      },
    },
    ContentService: { createTextOutput: (text) => ({ getContent: () => text }) },
  };

  const context = vm.createContext(sandbox);
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort();
  for (const file of files) {
    const code = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    vm.runInContext(code, context, { filename: `src/${file}` });
  }

  return {
    context,
    props,
    spreadsheets,
    logs,
    /** 取得全域名稱 (含 const / class) */
    get: (name) => vm.runInContext(name, context),
    /** 覆寫全域函式 (測試替換 Gemini / 搜尋等外部呼叫) */
    set: (name, value) => {
      context.__override = value;
      vm.runInContext(`${name} = __override`, context);
    },
    /** 修改指令碼屬性並清除設定快取 */
    setProps: (obj) => {
      Object.assign(props, obj);
      vm.runInContext('resetConfigCache_()', context);
    },
    setFetch: (fn) => { fetchImpl = fn; },
  };
}

module.exports = { loadGas, makeResponse, curlFetch };
