# CHANGELOG

本專案遵循 [Semantic Versioning](https://semver.org/) 與 [Keep a Changelog](https://keepachangelog.com/) 規範。
前身為 W6 的 Python + Ollama 本機版 ([chinkunlim/wk06_local_bot](https://github.com/chinkunlim/wk06_local_bot)，最後版本 1.0.3)，本 repo 從 GAS 移植版重新起算版本。

---

## [2.2.0] - 2026-10-19

### 修復
- 🎯 **GAS 獨立模式穩定了 (ISSUE-001 根治)**：Telegram webhook 的回應從 `ContentService` 改為 `HtmlService` (`webhookResponse_()`)，GAS 直接回 HTTP 200，不再被 302 轉址；Telegram 不再判定投遞失敗、拉長重試間隔。不開轉接站、電腦關機時 bot 也能穩定回答
  - 原因是對照使用者 W5 / W6 的 GAS bot (用 `HtmlService` 回應) 找到的；2.0.0 時「GAS 一律回 302、無法改變」的判斷是錯的
  - 實測：模擬 Telegram 請求回 200；不開轉接站連續提問全部回答、Telegram 待處理數為 0

### 變更
- 轉接站保留為「在電腦上觀察每一題與搜尋過程」的模式，不再是穩定運作的必要條件
- `doGet` 健康檢查字樣改為 `v2.2`
- 更正 README、DECISIONS (新增 ADR-012，更正 ADR-007、008)、KNOWN_ISSUES、AGENTS、WORKFLOW_GUIDE 中關於 302 的說法

---

## [2.1.0] - 2026-10-19

### 新增
- 📚 開發文件：`CHANGELOG.md`、`DECISIONS.md` (架構決策)、`KNOWN_ISSUES.md` (已知問題)、`AGENTS.md` (給 AI Agent 與開發者的規範)、`WORKFLOW_GUIDE.md` (開發、部署、測試流程)
- 🚀 npm script `redeploy` (`npm run redeploy -- <deploymentId>`，更新既有部署到新版本，網址不變)、`versions` (列出 GAS 版本)

### 變更
- README 加入文件索引

### 修復
- 在轉接站視窗按 Ctrl+C 時，不再先印出「向 Telegram 拿訊息失敗」並多等 5 秒，而是立即結束並設回 webhook

---

## [2.0.1] - 2026-10-19

### 變更
- 專案從 `gas/` 子資料夾移到 repo 根目錄 (原本外層的 Python 版已移除，保留在 wk06_local_bot)；更新 `.env` 路徑說明

---

## [2.0.0] - 2026-10-19

### 變更 (不相容)
- 🔄 **轉接站改為向 Telegram 拉訊息、交給 GAS 回答** (見 ADR-007)
  - 轉接站 `relay/relay.js` 用 `getUpdates` 長輪詢拿訊息，印出每一題，`POST ?action=ask` 交給 GAS
  - GAS 新增 ask 介面 (`src/Relay.js`)，以 `WEBHOOK_SECRET` 驗證，處理後直接回覆 Telegram，並把回覆與搜尋過程傳回轉接站印出
  - 轉接站只需要 `TELEGRAM_BOT_TOKEN`、`WEBHOOK_URL`、`WEBHOOK_SECRET`；Gemini 金鑰只放在 GAS
  - 轉接站啟動時移除 webhook (保留未處理訊息並補答)，`Ctrl+C` 結束時設回 GAS (GAS 獨立模式，見 ADR-008)
- 移除 1.1.0 的佇列輪詢 (`?action=poll`、`RELAY_MODE`) 與轉接站本機資料 (`.relay-data/`)

### 新增
- `traceLog` / `traceWarn`：搜尋判斷、搜尋引擎、讀網頁、換模型等步驟，同時寫日誌並回傳給轉接站
- `doGet` 健康檢查顯示 `relay-v2`，用來確認部署的是新版
- README 執行畫面截圖 (`docs/phone.png`、`docs/relay.png`)

### 修復
- **Telegram 越來越慢、最後不回**：改由轉接站拿訊息來避開 webhook 的 302 問題 (ISSUE-001)。⚠️ 當時對原因的判斷有誤，真正的原因與根治見 2.2.0
- 本機 curl 送 POST 時不再加 `-X POST`，302 轉址後改用 GET 取得 GAS 回應 (原本會拿到「找不到網頁」)

---

## [1.1.0] - 2026-10-19

### 新增
- 🛰️ 電腦上的轉接站 (`npm run relay`)：每 2 秒向 GAS 輪詢題目、在本機搜尋並呼叫 Gemini (後於 2.0.0 改版)
- 📄 單一檔案 `Code.gs` (`npm run build` 由 `src/*.js` 合併)，可直接貼進 GAS 編輯器；測試檢查與 `src/` 同步
- 🔁 **Gemini 備援模型** (`GEMINI_FALLBACK_MODELS`)：主模型 429 / 503 時不等待直接改用下一個，用完的模型以 CacheService 暫停 (每日額度 1 小時、每分鐘限制依建議秒數)；頁尾標示 `(備援)`、日誌記錄實際模型
- README 改寫為「怎麼裝、怎麼跑、我改了什麼」

### 修復
- `setWebhook` 接受學校 / 公司 (Workspace) 帳號的網址格式 (`/a/<網域>/macros/s/…/exec`)；`WEBHOOK_URL` 空白或填了 `/dev` 時給出明確說明
- 移除未使用的 OAuth scope `script.scriptapp`

---

## [1.0.0] - 2026-10-19

### 新增
- 🎉 **從 Python + Ollama 移植到 Google Apps Script**，功能對齊 W6 版：
  - 模型：本機 Ollama → **Gemini API** (Function Calling、router JSON 搜尋判斷、`/models` 列出 Gemini 模型)
  - 收訊息：長輪詢 → **Webhook** (`doPost`)，網址參數 `secret` 驗證、`update_id` 去重
  - 搜尋：DuckDuckGo HTML (被擋時冷卻 10 分鐘)、Google News RSS、**multi** 備援 (Bing → DuckDuckGo Lite → Mojeek，取代 ddgs)、網頁內文平行讀取 (`UrlFetchApp.fetchAll`) 與關鍵字摘錄
  - 儲存：JSON 檔 → **Google 試算表** (History / Quota / Logs)，`LockService` 保護配額
  - 設定：`.env` → **指令碼屬性**，修改後下一則訊息即生效
  - 指令：`/start` `/help` `/search` `/news` `/status` `/reset` `/models`
- 🧪 Node 內建 test runner + `dev/gasShim.js` (模擬 GAS 全域物件)，Markdown 轉換與關鍵字擷取的輸出與 Python 版逐字比對相同
- 🧰 clasp 只裝在專案資料夾，登入憑證存在 `.clasprc.json` (不寫到家目錄)
- 編輯器診斷函式：`setupProperties`、`checkEnv`、`testGemini`、`testSearch`、`simulate`

---

## 版本規劃

### 規劃中
- [ ] 轉接站異常結束 (關機、當機) 時，由 GAS 定時檢查並自動設回 webhook (ISSUE-005)
- [ ] 對話歷史改用每位使用者一列以外的格式，支援更長的記憶
- [ ] 轉接站多個訊息平行處理 (目前一次處理一則)
