# ☁️ Telegram AI Bot — Google Apps Script + 轉接站

Telegram 聊天機器人：**Google Apps Script (GAS)** 當公開的 webhook 收件站，**電腦上的轉接站**拿題目、上網搜尋、呼叫 **Gemini** 回答，回覆附上搜尋來源。
由 W6 的 Python + Ollama 本機版 ([chinkunlim/wk06_local_bot](https://github.com/chinkunlim/wk06_local_bot)) 改寫而來。

| 檔案 | 是什麼 |
|---|---|
| [`Code.gs`](Code.gs) | **Apps Script 程式** (單一檔案，可直接貼進 GAS 編輯器；由 `src/*.js` 合併產生) |
| [`relay/relay.js`](relay/relay.js) | **轉接站程式** (在你的電腦上跑，每一題都印在視窗上) |
| [`appsscript.json`](appsscript.json) | GAS 專案設定 (台北時區、網頁應用程式權限) |
| `src/` | `Code.gs` 的原始碼，依功能分檔 (clasp 推送的是這裡) |
| `test/` | 自動測試 (`npm test`，86 項) |

## 🧭 架構

```
 📱 Telegram ──webhook──▶ GAS doPost (Code.gs)
                              │ 轉接站在線？
                    ┌─── 是 ──┴── 否 (離線超過 30 秒) ───┐
                    ▼                                    ▼
             排入佇列 (CacheService)              GAS 自己回答 (備援)
                    ▲                                    │
      每 2 秒輪詢 doGet?action=poll                       │
                    │                                    │
 💻 轉接站 relay.js (你的電腦)                             │
    印出題目 → 搜尋判斷 → 搜尋 + 讀網頁 → Gemini            │
                    │                                    │
 📱 Telegram ◀──────┴──── 回覆 (含搜尋來源、模型、秒數、額度) ┘
```

- **為什麼需要 GAS**：Telegram webhook 需要公開的 https 網址；GAS 部署成網頁應用程式就有，不用開 cloudflared 通道，也不用電腦有固定 IP
- **為什麼需要轉接站**：搜尋引擎 (DuckDuckGo、Bing) 常擋 Google 機房的 IP，在家用網路搜尋比較穩；轉接站也沒有 GAS 單次 6 分鐘的執行上限，而且每題都印在視窗上，方便看 bot 在做什麼
- **轉接站關掉也能用**：GAS 發現轉接站超過 30 秒沒來拿題目，就自己回答
- GAS 和轉接站執行的是**同一份程式** (`src/*.js`)：轉接站用 `dev/gasShim.js` 在 Node 模擬 GAS 環境，所以指令、白名單、配額、回答流程完全一樣

## 📦 怎麼裝

需要：Node.js 20 以上、`curl` (macOS 內建)、Google 帳號、Telegram。

1. **下載與安裝** (套件只裝在專案資料夾，不裝全域)
   ```bash
   git clone https://github.com/chinkunlim/wk07_bot_google.git
   cd wk07_bot_google
   npm install
   npm test
   ```
2. **準備三樣東西**
   - Gemini API key：<https://aistudio.google.com/apikey>
   - Telegram Bot Token：Telegram 找 **@BotFather** → `/newbot`
   - 你的 Telegram User ID：找 **@userinfobot**
3. **建立 GAS 專案**，二選一：
   - **A. 貼上 (最簡單)**：到 <https://script.google.com> 新增專案，把 [`Code.gs`](Code.gs) 整份貼進 `程式碼.gs`；「專案設定」勾選「在編輯器中顯示 appsscript.json」，把 [`appsscript.json`](appsscript.json) 的內容貼進去
   - **B. clasp (用指令推送)**：先到 <https://script.google.com/home/usersettings> 開啟「Google Apps Script API」
     ```bash
     npm run login                            # 登入 Google，憑證存在本資料夾的 .clasprc.json
     cp appsscript.json appsscript.json.bak   # create 會用預設值覆蓋設定檔，先備份
     npm run create                           # 建立 GAS 專案
     mv appsscript.json.bak appsscript.json   # 還原設定檔
     npm run push                             # 推送 src/ 與 appsscript.json
     ```
4. **設定 GAS 指令碼屬性** (金鑰只放這裡，不寫在程式碼裡)
   1. GAS 編輯器執行 `setupProperties` (第一次會要求授權；出現「Google 尚未驗證」點「進階 → 前往」)
   2. 「專案設定 → 指令碼屬性」填 `TELEGRAM_BOT_TOKEN`、`ALLOWED_USER_IDS`、`GEMINI_API_KEY`
   3. 再執行一次 `setupProperties`，看到 `✅ 設定檢查通過`；`checkEnv` 會檢查模型與 Telegram Bot
5. **部署並接上 Telegram**
   1. 「部署 → 新增部署作業 → 網頁應用程式」：執行身分「我」、存取權「**所有人**」
   2. 複製 `/exec` 結尾的網址，填入指令碼屬性 `WEBHOOK_URL`
   3. 執行 `setWebhook` (會自動產生 `WEBHOOK_SECRET`、註冊指令選單)
6. **設定轉接站**
   ```bash
   cp .env.example .env
   ```
   在 `.env` 填入與指令碼屬性相同的 `GEMINI_API_KEY`、`TELEGRAM_BOT_TOKEN`、`ALLOWED_USER_IDS`、`WEBHOOK_URL`、`WEBHOOK_SECRET` (`.env` 已被 `.gitignore` 排除，不會上傳)

> 在 GAS 編輯器裡，函式選單只列出**目前開啟的檔案**的函式：用 clasp 推送時 `setupProperties` 在 `src/Config.gs`、`setWebhook` 在 `src/Main.gs`、`checkEnv` / `testSearch` 在 `src/Diagnostics.gs`；用貼上的方式則都在 `程式碼.gs`。

## ▶️ 怎麼跑

```bash
npm run relay
```

視窗會顯示「✅ 已連上 GAS，等待題目…」。用手機傳訊息給 bot，例如：

- `查 台北今天天氣` → 轉接站印出題目、搜尋過程與回覆；手機收到回答，最後附「🔍 搜尋來源」
- `/start`、`/help`、`/search 關鍵字`、`/news`、`/status` (今日額度)、`/reset` (清除記憶)、`/models` (可用模型)

轉接站視窗範例：
```
[14:02:11] 📩 第 1 題｜小明 (123456789)：查 台北今天天氣
[14:02:12]    🧭 搜尋判斷: {"need_search":true,"query":"台北 今天 天氣"}
[14:02:12]    🔍 [DuckDuckGo] 搜尋關鍵字: "台北 天氣"
[14:02:13]    ✅ [DuckDuckGo] 取得 4 筆結果
[14:02:14]    📄 已讀取 2/2 個網頁內文
[14:02:16] 🤖 回覆：
    台北今天多雲時晴，氣溫 24–29 度…
    🔍 搜尋來源：
    • 臺北市 - 中央氣象署
[14:02:16] ✅ 完成 (5.2 秒)
```

`Ctrl+C` 關掉轉接站後，約 30 秒內 GAS 會自己接手回答。

其他執行方式：

| 指令 | 用途 |
|---|---|
| `npm run simulate` | 不接 Telegram，在終端機直接打字問 bot (只需要 `GEMINI_API_KEY`) |
| `npm test` | 自動測試 (不連網、不需金鑰) |
| `npm run build` | 修改 `src/` 後重新產生 `Code.gs` |
| `npm run push` | 用 clasp 把 `src/` 推到 GAS (之後要「部署 → 管理部署作業 → 新版本」才會生效) |

## ✏️ 我改了什麼

和 W6 的 Python + Ollama 本機版相比：

| | W6 本機版 | W7 這個版本 |
|---|---|---|
| 收訊息 | 電腦用 long polling 向 Telegram 拉訊息 | **GAS webhook** 收訊息，轉接站向 GAS 拿題目 |
| 模型 | 本機 Ollama (llama3.1) | **Gemini API** (`gemini-3.5-flash-lite`)；額度用完 (429) 自動改用備援模型 |
| 電腦關機時 | bot 停擺 | **GAS 自己回答** |
| 搜尋 | DuckDuckGo、Google News、ddgs 備援 | DuckDuckGo、Google News、**multi 備援** (Bing → DuckDuckGo Lite → Mojeek)，搜尋後讀前 2 筆網頁內文 |
| 資料 | 本機 JSON 檔 | GAS：**Google 試算表** (對話、配額、日誌)；轉接站：本機 `.relay-data/` |
| 設定與金鑰 | `.env` | GAS **指令碼屬性**；轉接站 `.env` (不進版控) |
| 程式語言 | Python | JavaScript (GAS V8)，GAS 與轉接站共用同一份程式 |
| 測試 | pytest | Node 內建 test runner，86 項 (模擬 GAS 環境，不連網) |

細節：

- **搜尋判斷**：沿用 W6 的 router 模式，先讓模型輸出 JSON `{need_search, query}`，寫程式、翻譯、閒聊不搜尋；也可切換成原生 Function Calling (`SEARCH_DECISION=tools`)
- **Gemini 3 的工具呼叫**：Gemini 3 的工具呼叫帶有模型產生的簽章 (thoughtSignature)，不能像 W6 那樣自己假造一筆工具呼叫，所以 router 模式改成把搜尋結果附在使用者問題後面
- **防重複回答**：GAS 處理較久時 Telegram 會重送同一則訊息，用 `update_id` 去重
- **安全**：webhook 與轉接站輪詢都要帶 `WEBHOOK_SECRET`，否則拒絕；白名單外的人只會看到自己的 User ID
- **時區**：配額與「今天日期」固定用台北時間

## 🖼️ 執行畫面

| 手機：bot 回答「查 …」並附來源 | 電腦：轉接站印出同一題 |
|---|---|
| ![手機畫面](docs/phone.png) | ![轉接站畫面](docs/relay.png) |

## ⚙️ 指令碼屬性 (設定)

| 屬性 | 預設 | 說明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (必填) | @BotFather 取得 |
| `ALLOWED_USER_IDS` | (必填) | 白名單，逗號分隔 |
| `GEMINI_API_KEY` | (必填) | Google AI Studio 取得 |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | 主模型，`/models` 可查可用模型 |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.1-flash-lite,gemini-3.6-flash` | 主模型額度用完 (429) 或過載 (503) 時依序改用，留空停用；頁尾標示 `(備援)` |
| `GEMINI_RETRIES` | `1` | 最後一個模型回 429 / 5xx 時的重試次數 |
| `GEMINI_MAX_OUTPUT_TOKENS` | `4096` | 回答長度上限 (含思考 token) |
| `SEARCH_DECISION` | `router` | `router`：先判斷要不要搜；`tools`：原生 Function Calling |
| `SEARCH_ENGINE` | `duckduckgo` | `duckduckgo` \| `google_news` \| `multi` |
| `SEARCH_FALLBACK_ENGINE` | `multi` | 主引擎無結果 / 被擋時使用，留空停用 |
| `SEARCH_FETCH_PAGES` | `2` | 讀取前 N 筆網頁內文 (0 = 只用摘要) |
| `SEARCH_PAGE_CHARS` | `2000` | 每頁內文摘錄上限 |
| `SEARCH_MAX_RESULTS` | `4` | 每次搜尋結果數 |
| `MAX_HISTORY_TURNS` | `4` | 對話記憶輪數 |
| `MAX_DAILY_REQUESTS` | `50` | 每人每日提問上限 |
| `RELAY_MODE` | `auto` | `auto`：轉接站在線時交給它；`off`：一律 GAS 回答 |
| `SPREADSHEET_ID` | (自動) | 資料試算表，留空時自動建立 |
| `WEBHOOK_URL` | | 網頁應用程式 `/exec` 網址 |
| `WEBHOOK_SECRET` | (自動) | `setWebhook` 產生，驗證 Telegram 與轉接站 |
| `SIM_QUERY` / `SIM_SEARCH` | | 編輯器 `simulate()` / `testSearch()` 用的問題 |

只改指令碼屬性不需重新部署，下一則訊息就生效。轉接站讀 `.env`，修改後重開轉接站。

## 🐛 除錯

| 現象 | 排查 |
|---|---|
| 手機傳訊息沒反應 | GAS 執行 `getWebhookInfo` 看最後錯誤；「執行作業」頁看 `doPost` 紀錄；確認部署的是最新版本 |
| 轉接站顯示「收到網頁而不是 JSON」 | 網頁應用程式的存取權不是「所有人」，或改了程式沒部署新版本。學校帳號若只能選「網域內使用者」，請改用個人 Gmail |
| 轉接站顯示「token 不符」 | `.env` 的 `WEBHOOK_SECRET` 要和指令碼屬性完全相同 |
| 轉接站開著但 GAS 自己回答 | 轉接站剛啟動 / 剛恢復連線，下一題就會交給它；或 `RELAY_MODE` 被設成 `off` |
| `setWebhook` 說網址要 `/exec` | `WEBHOOK_URL` 填了 `/dev` 測試網址或沒填；用部署後拿到的 `/exec` 網址 |
| `Conflict: terminated by other getUpdates request` | W6 Python 版還在跑 (long polling)，兩者只能擇一 |
| `Gemini API 使用量已達上限` | 主模型與備援模型的免費額度都用完了，可在 `GEMINI_FALLBACK_MODELS` 多加模型 |
| 搜尋都沒結果 | GAS 執行 `testSearch` 看各引擎在 Google 機房的結果；有開轉接站時搜尋在你的電腦上進行 |

## 🧼 不污染電腦環境

- clasp 裝在專案的 `node_modules`，不用 `npm install -g`；登入憑證存在專案內的 `.clasprc.json`，不寫到家目錄
- `.clasp.json`、`.clasprc.json`、`.env`、`.relay-data/`、`node_modules/` 都在 `.gitignore`
- 要完全移除：刪掉整個資料夾即可
