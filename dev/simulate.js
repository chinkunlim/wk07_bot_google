#!/usr/bin/env node
/**
 * 本機模擬模式 (對應 Python 版 --simulate)：不部署、不接 Telegram，
 * 在終端機打字提問，走與 GAS 相同的 processQuery 流程。
 * - Gemini、搜尋、網頁讀取真的連網 (以 curl 代替 UrlFetchApp)
 * - 對話歷史 / 配額存在記憶體，結束即清除
 * 設定來源：gas/.env (KEY=VALUE，至少需要 GEMINI_API_KEY)，或同名環境變數
 *
 * 注意：在本機連網的 IP 與 Google 機房不同，搜尋引擎是否被擋要以 GAS 的 testSearch() 為準
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { loadGas, curlFetch } = require('./gasShim');

const ENV_FILE = path.join(__dirname, '..', '.env');
const QUIT_WORDS = ['quit', 'exit', 'q', '離開', '結束'];
const SIM_USER_ID = 0;

function loadEnv() {
  const props = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) props[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const key of Object.keys(process.env)) {
    if (/^(GEMINI_|SEARCH_|MAX_)/.test(key)) props[key] = process.env[key];
  }
  return props;
}

function timestamp() {
  return new Date().toTimeString().slice(0, 8);
}

function main() {
  const g = loadGas({ props: loadEnv(), fetch: curlFetch, realSleep: true });
  // GAS 日誌改印到終端機 (加上時間)
  const print = (level) => (...args) => console[level](`[${timestamp()}] ${args.join(' ')}`);
  g.context.console = { log: print('log'), info: print('log'), warn: print('warn'), error: print('error') };

  const cfg = g.get('getConfig')();
  const errors = g.get('validateConfig')(cfg, false);
  if (errors.length) {
    errors.forEach((e) => console.error(`❌ ${e}`));
    console.error(`\n請建立 ${ENV_FILE}，內容例如：\nGEMINI_API_KEY=你的金鑰`);
    process.exit(1);
  }
  console.log(
    `模擬模式：不接 Telegram。模型 ${cfg.GEMINI_MODELS.join(' → ')}，搜尋 ${cfg.SEARCH_ENGINE} ` +
    `(備援 ${cfg.SEARCH_FALLBACK_ENGINE || '無'})，判斷方式 ${cfg.SEARCH_DECISION}`,
  );
  console.log('打一句話按 Enter，bot 會回；/reset 清除記憶、/status 看額度、quit 結束。\n');

  const createConsoleContext = g.get('createConsoleContext');
  const processQuery = g.get('processQuery');
  const htmlToPlain = g.get('htmlToPlain');
  let count = 0;

  // 狀態訊息顯示為「⏳」，最終回覆 (含錯誤) 完整印出
  g.set('sendStatus', (ctx, msg) => console.log(`   ⏳ ${htmlToPlain(msg)}`));
  g.set('sendFinalResponse', (ctx, msg) => {
    ctx.statusMessageId = null;
    console.log('\n🤖 bot 回覆：\n' + htmlToPlain(msg) + '\n');
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => rl.question('📱 你：', (line) => {
    const text = line.trim();
    if (QUIT_WORDS.includes(text.toLowerCase())) {
      rl.close();
      return;
    }
    if (text === '/reset') {
      g.get('clearConversationHistory')(SIM_USER_ID);
      console.log('🧹 對話記憶已清空\n');
    } else if (text === '/status') {
      const st = g.get('getQuotaStatus')(SIM_USER_ID);
      console.log(`📊 今日已用 ${st.current} 次，剩餘 ${st.remaining} 次\n`);
    } else if (text) {
      const quota = g.get('checkAndConsumeQuota')(SIM_USER_ID);
      if (!quota.allowed) {
        console.log(quota.message + '\n');
      } else {
        count += 1;
        // 顯示程式實際收到的文字，若與畫面上打的不同可立即發現
        console.log(`[${timestamp()}] 📩 收到：「${text}」(${text.length} 字)，交給 ${cfg.GEMINI_MODEL}…`);
        processQuery(createConsoleContext(SIM_USER_ID, count), text, quota);
      }
    }
    ask();
  });
  rl.on('close', () => console.log('模擬結束。'));
  ask();
}

main();
