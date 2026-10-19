# AGENTS.md - Telegram AI Bot (GAS + 轉接站) 開發指南

本文件為 AI Agents 與開發者提供本專案的架構、程式碼慣例與維護原則。
使用說明見 `README.md`；決策理由見 `DECISIONS.md`；已知問題見 `KNOWN_ISSUES.md`；開發與部署流程見 `WORKFLOW_GUIDE.md`。

---

## 1. 專案概要

```
📱 Telegram ◀── getUpdates ── 💻 轉接站 relay/relay.js (使用者電腦，印出每一題)
     ▲                              │ POST ?action=ask&token=WEBHOOK_SECRET
     │                              ▼
     └── 回覆 (含來源) ──── ☁️ GAS (src/*.js → Code.gs)：白名單 → 額度 → 搜尋判斷 → 搜尋 + 讀網頁 → Gemini
```

- **GAS** 負責所有邏輯與金鑰 (Gemini API key、試算表)；**轉接站**只負責拿訊息、轉交、印出
- **GAS 獨立模式**：Telegram webhook → `doPost` 直接處理 (轉接站 Ctrl+C 時自動切回)，電腦關機也能回
- 前身是 W6 的 Python + Ollama 版 ([chinkunlim/wk06_local_bot](https://github.com/chinkunlim/wk06_local_bot))，提示詞、Markdown 轉換、關鍵字清洗、內文摘錄演算法由它逐行移植

## 2. 核心原則

- **金鑰不進程式碼**：GAS 設定只從指令碼屬性讀取 (`getConfig()`)；本機只有 `.env` (gitignore)。commit 前掃描 (見 §7)
- **`src/` 是唯一原始碼**：`Code.gs` 由 `npm run build` 產生，不要手改
- **GAS 與 Node 都要能跑**：`src/` 只能用 GAS 內建服務與標準 JS，不能 `require`；Node 端靠 `dev/gasShim.js` 提供替身
- **不污染本機**：依賴只裝在專案 `node_modules`，clasp 一律帶 `-A .clasprc.json`
- **使用者面向的錯誤要友善**：回覆說明與「本次不計入額度」，堆疊只寫日誌；處理失敗要 `refundQuota`

## 3. 模組分工

| 檔案 | 職責 | 關鍵函式 |
|---|---|---|
| `src/Main.js` | 入口：`doPost` (Telegram webhook / 轉接站 ask)、`doGet` 健康檢查、webhook 管理 | `doPost()`, `doGet()`, `setWebhook()`, `deleteWebhook()`, `getWebhookInfo()`, `isWebAppExecUrl()` |
| `src/Relay.js` | 轉接站 ask 介面、回覆與過程紀錄的擷取 | `relayAsk()`, `traceLog()`, `traceWarn()` |
| `src/Handler.js` | 指令路由、查詢處理、搜尋判斷、工具循環、回覆組裝 | `handleUpdate()`, `processQuery()`, `runQuery()`, `routerSearch()`, `toolLoop()`, `finalizeResponse()` |
| `src/Telegram.js` | Telegram Bot API (失敗不拋例外)、對話情境 | `telegramApi()`, `tgSendMessage()`, `tgEditMessageText()`, `createTelegramContext()` |
| `src/Gemini.js` | 提示詞、Gemini REST、Function Calling、備援模型 | `geminiGenerate()`, `decideSearch()`, `listGeminiModels()`, `SYSTEM_PROMPT`, `ROUTER_PROMPT`, `SEARCH_TOOL` |
| `src/Store.js` | 試算表 (歷史 / 配額 / 日誌)、LockService、update 去重 | `getConversationHistory()`, `checkAndConsumeQuota()`, `refundQuota()`, `logInteraction()`, `isDuplicateUpdate()` |
| `src/Config.js` | 指令碼屬性、預設值、驗證 | `getConfig()`, `buildConfig()`, `validateConfig()`, `setupProperties()` |
| `src/Search.js` | 搜尋引擎註冊表、主引擎 → 備援 | `search()`, `formatResults()`, `getSearchEngines()` |
| `src/SearchDuckDuckGo.js` / `SearchGoogleNews.js` / `SearchMulti.js` | 各引擎抓取與 HTML / RSS 解析 | `searchDuckDuckGo()`, `searchGoogleNews()`, `searchMulti()`, `parse*()` |
| `src/PageFetch.js` | 讀取結果網頁、依關鍵字摘錄 | `enrichResults()`, `extractRelevantText()`, `htmlToLines()` |
| `src/Keywords.js` | 搜尋關鍵字清洗、摘錄比對詞 | `extractSearchKeywords()`, `queryKeywords()` |
| `src/Format.js` / `Html.js` | Markdown → Telegram HTML、切段、HTML 工具 | `markdownToHtml()`, `splitMessage()`, `htmlToPlain()` |
| `src/Diagnostics.js` | GAS 編輯器用的檢查與模擬 | `checkEnv()`, `testGemini()`, `testSearch()`, `simulate()` |
| `relay/relay.js` | 轉接站 (Node，零套件，用 curl) | `createRelay()`, `loadEnv()`, `validateEnv()` |
| `dev/gasShim.js` | 在 Node 模擬 GAS 全域物件；curl 版 UrlFetchApp | `loadGas()`, `curlFetch()`, `makeResponse()` |
| `dev/build.js` / `dev/simulate.js` | 產生 `Code.gs` / 本機互動模擬 | `buildCode()` |

## 4. 程式碼規範

### 4.1 GAS 全域命名空間
- 所有 `src/*.js` 共用一個全域範圍，**函式與常數名稱不可重複**
- **頂層程式碼不可引用其他檔案的常數或呼叫其他檔案的函式** (載入順序不保證)；跨檔引用寫在函式內 (例：`getSearchEngines()` 以函式回傳註冊表)
- 同一檔案內的函式宣告可在頂層引用 (會被提升)，例如 `COMMAND_HANDLERS`
- 私有函式以 `_` 結尾 (`getSheet_`)，與 GAS 慣例一致；GAS 編輯器的函式選單會隱藏它們

### 4.2 同步與外部呼叫
- GAS 沒有 async：`UrlFetchApp` 一律帶 `muteHttpExceptions: true`，自行檢查狀態碼
- 失敗不中斷流程：搜尋、讀網頁、Telegram 發送失敗要記錄並繼續 (Telegram 函式回傳 `null` / `false`)
- Gemini 錯誤一律轉成 `GeminiError` (含 `status`)，由 `geminiErrorMessage()` 轉成使用者訊息

### 4.3 日誌
- 一般日誌：`console.log / warn / error`
- **使用者在轉接站應該看到的處理步驟** (搜尋判斷、搜尋引擎、結果數、讀網頁、換模型) 用 `traceLog()` / `traceWarn()`，它們會在處理轉接站請求時一併回傳
- 不可把金鑰、完整 webhook 網址 (含 secret) 寫進日誌

### 4.4 Gemini 相容性
- 內部訊息直接用 Gemini `contents` 格式 (`user` / `model`)
- tools 模式要把模型回傳的 `content` **原封不動**加回 (保留 `thoughtSignature`)；**不可自己偽造 functionCall**
- 不設定 temperature (Gemini 3 建議用預設值)

### 4.5 Webhook 回應 (重要)
- **回給 Telegram 的 `doPost` 回應一律用 `webhookResponse_()` (HtmlService)**，不可用 `ContentService`
- `ContentService` 的輸出會被 GAS 302 轉址到 googleusercontent.com，Telegram 不跟隨轉址、視為失敗，重試間隔越拉越長，bot 最後不回 (ISSUE-001、ADR-012)
- 轉接站的 ask 介面要回 JSON，可用 `ContentService` (轉接站的 curl 會跟隨 302)
- `test/relay.test.js` 檢查所有 Telegram 路徑都回 HtmlService

### 4.6 Telegram 輸出
- 訊息一律用 HTML parse mode；模型輸出經 `markdownToHtml()` 轉換；超過 4000 字以 `splitMessage()` 切段
- 送出失敗 (can't parse entities) 自動改送純文字

### 4.7 修改共用邏輯
提示詞、Markdown 轉換、關鍵字清洗、內文摘錄源自 Python 版；修改時保持行為一致，並更新對應測試 (`test/format.test.js`、`test/pageFetch.test.js`)。

## 5. 常見修改場景

| 需求 | 修改 | 備註 |
|---|---|---|
| 換模型 / 備援模型 | 指令碼屬性 `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS` | 不需部署；`/models` 查可用模型 |
| 改回答風格 | `src/Gemini.js` → `SYSTEM_PROMPT` | 需 push + 新版本 |
| 改何時搜尋 | `src/Gemini.js` → `ROUTER_PROMPT` (router) / `SEARCH_TOOL`、`SEARCH_RULES_TOOLS` (tools) | 同上 |
| 新增搜尋引擎 | 新增 `src/SearchXxx.js` (`searchXxx(query, max)` + 解析函式)，在 `getSearchEngines()` 註冊，`SUPPORTED_SEARCH_ENGINES` 加入名稱，`test/search.test.js` 加 fixture 測試 | |
| 新增 Telegram 指令 | `src/Handler.js` 新增 `cmdXxx(ctx, args)`、加入 `COMMAND_HANDLERS`；`src/Main.js` → `BOT_COMMANDS`；`cmdHelp` 與 README 指令表 | 執行 `setWebhook` 重新註冊指令選單 |
| 新增設定 | `src/Config.js` → `CONFIG_DEFAULTS` (數字加入 `CONFIG_INT_KEYS`、金鑰加入 `CONFIG_SECRET_KEYS`)、`validateConfig`；README 屬性表 | |
| 新增 GAS 服務 | `appsscript.json` → `oauthScopes`；`dev/gasShim.js` 加替身 | 需重新授權 |
| 改轉接站顯示 | `relay/relay.js` → `handle()` | 不需部署 GAS，重開轉接站 |

## 6. 除錯檢查清單

| 現象 | 排查 |
|---|---|
| bot 不回 | 轉接站有沒有在跑 (`pgrep -fl relay/relay.js`)；沒有時 webhook 是否指向 GAS (`getWebhookInfo`，ISSUE-005)；`getWebhookInfo` 出現 `302` 代表 webhook 回應被改成了 ContentService (ISSUE-001) |
| 改了程式沒生效 | 開 `/exec` 確認健康檢查文字；部署是否建立新版本 (ISSUE-002)；是否被舊編輯器分頁蓋回 (ISSUE-003) |
| 轉接站「收到網頁而不是 JSON」 | 存取權不是「所有人」或部署非新版 (ISSUE-008、002) |
| 回答不完整或沒有來源 | `SEARCH_FETCH_PAGES` / `SEARCH_PAGE_CHARS`；GAS 執行 `testSearch` |
| 搜尋判斷不合理 | 轉接站視窗的 `🧭 搜尋判斷`；調整 `ROUTER_PROMPT` |
| 不確定是 GAS 還是 Telegram 的問題 | GAS 編輯器執行 `simulate` (不經過 Telegram)；能答就是投遞問題 |

## 7. 驗證

```bash
npm test          # 86 項：格式、搜尋解析、Gemini、儲存、端對端 (假網路)、轉接站、Code.gs 同步
npm run build     # 修改 src/ 後重新產生 Code.gs (否則 npm test 失敗)
npm run simulate  # 本機真的連 Gemini 與搜尋 (需 .env 的 GEMINI_API_KEY)
```

commit 前掃描金鑰 (應無輸出)：
```bash
git grep --cached -nE "AIza[0-9A-Za-z_-]{20,}|[0-9]{8,10}:AA[0-9A-Za-z_-]{30,}|gh[op]_[0-9A-Za-z]{20,}|ya29\." -- ':!*.png'
```

部署後在 GAS 編輯器 (先重新整理) 執行 `checkEnv`、`simulate`；開 `/exec` 確認版本字樣。

## 8. 版本控管

- 分支：`main`；較大的改動用 `feature/*`、`fix/*`、`docs/*`
- 提交：Conventional Commits (`feat:` `fix:` `docs:` `refactor:` `chore:` `test:`)
- 發布：更新 `package.json` 版本與 `CHANGELOG.md`；架構性改變補 `DECISIONS.md`；新問題補 `KNOWN_ISSUES.md`
- 不可進版控：`.env`、`.clasp.json`、`.clasprc.json`、`.relay-data/`、`node_modules/`
