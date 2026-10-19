# ☁️ Telegram AI Bot — Google Apps Script 版

把 Python + Ollama 版本 ([chinkunlim/wk06_local_bot](https://github.com/chinkunlim/wk06_local_bot)) 移植到 **Google Apps Script (GAS)**，功能對齊：

| 功能 | Python 版 | GAS 版 |
|---|---|---|
| 模型 | 本機 Ollama | **Gemini API** (API key) |
| 收訊息 | 長輪詢 (long polling) | **Webhook** (`doPost`) |
| 搜尋判斷 | `router` / `tools` | 相同 (`SEARCH_DECISION`) |
| 搜尋引擎 | DuckDuckGo HTML、Google News RSS、ddgs 備援 | DuckDuckGo HTML、Google News RSS、**multi** 備援 (Bing → DuckDuckGo Lite → Mojeek) |
| 網頁內文摘錄 | httpx + BeautifulSoup | `UrlFetchApp.fetchAll` + regex |
| 對話記憶 / 配額 / 日誌 | 本機 JSON 檔 | **Google 試算表** (History / Quota / Logs 分頁) |
| 設定 | `.env` | **指令碼屬性** (Script Properties) |
| 指令 | /start /help /status /reset /models /search /news | 相同 (`/models` 改列 Gemini 模型) |
| 模擬模式 | `--simulate` | `npm run simulate` (本機) / `simulate()` (GAS 編輯器) |
| 測試 | pytest | `npm test` (Node 內建 test runner，零依賴) |

> **為什麼不能用 Ollama？** GAS 跑在 Google 的伺服器，連不到你電腦上的 `localhost:11434`，所以改用 Gemini API。
> **為什麼不用 Gemini 內建的 Google 搜尋 (grounding)？** 免費額度無法使用，因此保留自建搜尋。

## 📁 結構

```
gas/
├── appsscript.json       # GAS 設定：時區 Asia/Taipei、Web App 權限、OAuth scopes
├── src/                  # 推送到 GAS 的程式碼 (所有檔案共用全域命名空間)
│   ├── Main.js           # doPost webhook 入口、setWebhook / deleteWebhook / getWebhookInfo
│   ├── Handler.js        # 指令路由、processQuery、router / tools 搜尋判斷、回覆組裝
│   ├── Telegram.js       # Telegram Bot API (送出 / 編輯訊息，HTML 失敗改純文字)
│   ├── Gemini.js         # Gemini generateContent、Function Calling、搜尋判斷 JSON、提示詞
│   ├── Store.js          # 試算表：對話歷史、配額 (LockService)、日誌、update 去重
│   ├── Config.js         # 指令碼屬性、預設值、驗證、setupProperties()
│   ├── Search.js         # 搜尋引擎工廠、主引擎 → 備援
│   ├── SearchDuckDuckGo.js / SearchGoogleNews.js / SearchMulti.js
│   ├── PageFetch.js      # 讀取結果網頁、依關鍵字摘錄內文
│   ├── Keywords.js       # 搜尋關鍵字清洗、摘錄比對詞
│   ├── Format.js         # Markdown → Telegram HTML、長訊息切段
│   ├── Html.js           # HTML 實體 / 標籤工具
│   └── Diagnostics.js    # checkEnv()、testGemini()、testSearch()、simulate()
├── dev/
│   ├── gasShim.js        # 在 Node 模擬 GAS 全域物件 (測試與本機模擬共用)
│   └── simulate.js       # 本機互動模擬
└── test/                 # npm test
```

## 🧼 不污染本機環境

- 所有指令都在 `gas/` 內執行，`clasp` 只裝在 `gas/node_modules` (不用 `npm install -g`)
- clasp 的登入憑證存在 `gas/.clasprc.json` (各 npm script 都帶 `-A .clasprc.json`)，**不會**寫到 `~/.clasprc.json`
- `.clasp.json`、`.clasprc.json`、`.env`、`node_modules/` 都已加入 `gas/.gitignore`
- 測試與本機模擬只用 Node 內建模組；要完全移除就刪掉 `gas/node_modules` 與 `gas/.clasprc.json`

需求：Node.js 20 以上、`curl` (本機模擬用，macOS 內建)。

## 🚀 部署步驟

### 1. 安裝與測試

```bash
cd gas
npm install
npm test
```

### 2. 取得金鑰

- **Gemini API key**：<https://aistudio.google.com/apikey>
- **Telegram Bot Token**：找 @BotFather
- **你的 Telegram User ID**：找 @userinfobot

### 3. (選用) 本機先模擬

```bash
cp .env.example .env    # 填入 GEMINI_API_KEY
npm run simulate
```

### 4. 建立 GAS 專案並推送

第一次使用要先到 <https://script.google.com/home/usersettings> 開啟「Google Apps Script API」。

```bash
npm run login     # 瀏覽器登入 Google，憑證存到 gas/.clasprc.json
cp appsscript.json appsscript.json.bak   # create 會用預設值 (美國時區、無 webapp 設定) 覆蓋 manifest，先備份
npm run create    # 建立新的 GAS 專案，產生 gas/.clasp.json
mv appsscript.json.bak appsscript.json   # 還原專案的 manifest
npm run push      # 推送 src/ 與 appsscript.json
npm run open      # 開啟 GAS 編輯器
```

已有 GAS 專案時，可改為複製 `.clasp.json.example` 為 `.clasp.json` 並填入 scriptId。

### 5. 設定指令碼屬性

1. GAS 編輯器選擇函式 `setupProperties` → 執行 (第一次會要求授權：外部連線、試算表)
2. 「專案設定 → 指令碼屬性」填入：`TELEGRAM_BOT_TOKEN`、`ALLOWED_USER_IDS`、`GEMINI_API_KEY`
3. 再執行一次 `setupProperties`，看到 `✅ 設定檢查通過`；`checkEnv`、`testGemini`、`testSearch` 可進一步確認

### 6. 部署 Web App 並設定 Webhook

1. 編輯器「部署 → 新增部署作業 → 網頁應用程式」：執行身分「我」、存取權「所有人」(也可用 `npm run deploy`)
2. 複製 `/exec` 結尾的網址，填入指令碼屬性 `WEBHOOK_URL` (學校 / 公司帳號的網址會多一段 `/a/<網域>/`，也可以用；`/dev` 結尾是編輯者專用的測試網址，Telegram 連不到)
3. 執行 `setWebhook` (會自動產生 `WEBHOOK_SECRET`、註冊 Telegram 指令選單)
4. 到 Telegram 傳 `/start` 給你的 bot

> 修改程式後：`npm run push`，再「部署 → 管理部署作業 → 編輯 → 新版本」(或 `npm run deploy -- -i <deploymentId>`)，**網址不變**、不必重設 webhook。
> 只改指令碼屬性 (模型、搜尋引擎、配額…) 不需重新部署，下一則訊息就生效。

## ⚙️ 指令碼屬性

| 屬性 | 預設 | 說明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (必填) | @BotFather 取得 |
| `ALLOWED_USER_IDS` | (必填) | 白名單，逗號分隔 |
| `GEMINI_API_KEY` | (必填) | Google AI Studio 取得 |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | 主模型，`/models` 可查可用模型 |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.1-flash-lite,gemini-3.6-flash` | 主模型額度用完 (429) 或過載 (503) 時依序改用，留空停用；頁尾會標示 `(備援)` |
| `GEMINI_RETRIES` | `1` | 最後一個模型回 429 / 5xx 時的重試次數 (建議等待 > 20 秒則不重試) |
| `GEMINI_MAX_OUTPUT_TOKENS` | `4096` | 回答長度上限 (含思考 token) |
| `SEARCH_DECISION` | `router` | `router`：先判斷要不要搜；`tools`：原生 Function Calling |
| `SEARCH_ENGINE` | `duckduckgo` | `duckduckgo` \| `google_news` \| `multi` |
| `SEARCH_FALLBACK_ENGINE` | `multi` | 主引擎無結果 / 被擋時使用，留空停用 |
| `SEARCH_FETCH_PAGES` | `2` | 讀取前 N 筆網頁內文 (0 = 只用摘要) |
| `SEARCH_PAGE_CHARS` | `2000` | 每頁內文摘錄上限 |
| `SEARCH_MAX_RESULTS` | `4` | 每次搜尋結果數 |
| `MAX_HISTORY_TURNS` | `4` | 對話記憶輪數 |
| `MAX_DAILY_REQUESTS` | `50` | 每人每日提問上限 |
| `SPREADSHEET_ID` | (自動) | 資料試算表，留空時自動建立 |
| `WEBHOOK_URL` | | Web App `/exec` 網址 |
| `WEBHOOK_SECRET` | (自動) | `setWebhook` 產生，驗證請求來自 Telegram |
| `SIM_QUERY` / `SIM_SEARCH` | | 編輯器 `simulate()` / `testSearch()` 用的問題，多題用 `||` 分隔 |

## 🔧 GAS 與 Python 版的差異

- **同步執行**：GAS 沒有 async；「正在輸入…」改在每個耗時步驟前送一次，不再背景循環
- **重複的 update**：GAS Web App 會回 302 轉址，處理較久時 Telegram 可能重送；以 `CacheService` 記錄 `update_id` 去重
- **6 分鐘上限**：單次執行最多 6 分鐘；工具循環最多 3 輪、網頁以 `fetchAll` 平行讀取
- **Webhook 驗證**：GAS 讀不到 `X-Telegram-Bot-Api-Secret-Token` 標頭，改用網址參數 `?secret=`
- **Gemini 3 的 thoughtSignature**：tools 模式把模型回傳的 content 原封不動送回；router 模式不偽造工具呼叫，把搜尋結果附在使用者訊息後
- **備援模型**：免費額度按模型分開計算；主模型 429 時不等待直接換下一個模型，用完的模型以 `CacheService` 暫停 (每日額度 1 小時、每分鐘限制依建議秒數)
- **ddgs 套件無法使用**：以 `multi` 引擎 (Bing / DuckDuckGo Lite / Mojeek HTML 解析) 取代

## 🐛 除錯

| 現象 | 排查 |
|---|---|
| Bot 沒反應 | 執行 `getWebhookInfo` 看最後錯誤；「執行作業」頁看 doPost 紀錄；確認部署的是最新版本 |
| `Conflict: terminated by other getUpdates request` | Python 版還在跑 (長輪詢)。兩者只能擇一；改回 Python 版前先執行 `deleteWebhook` |
| `Gemini API 使用量已達上限` | 主模型與所有備援模型的免費額度都用完了；額度按模型分開計算，可在 `GEMINI_FALLBACK_MODELS` 多加幾個模型，或改 `tools` (`router` 每題呼叫 2 次) |
| 找不到模型 | `/models` 或 `checkEnv` 查可用模型，修改 `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS` |
| 搜尋都沒結果 | 執行 `testSearch` 看各引擎在 Google 機房的結果；DuckDuckGo 被擋會冷卻 10 分鐘並改用備援 |
| 配額日期不對 | `appsscript.json` 的 `timeZone` 應為 `Asia/Taipei` |
| 想看對話 / 配額 / 日誌 | `setupProperties` 或 `checkEnv` 會印出資料試算表網址 |
