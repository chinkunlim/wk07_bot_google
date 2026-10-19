# DECISIONS.md - 架構決策記錄 (ADR)

記錄本專案重要的技術選擇：當時的情境、決定、理由與代價。
狀態：`採用`、`已取代` (後面註明被哪一條取代)。

| ADR | 決定 | 狀態 |
|---|---|---|
| [001](#adr-001-用-gemini-api-取代本機-ollama) | 用 Gemini API 取代本機 Ollama | 採用 |
| [002](#adr-002-自建網路搜尋不用-gemini-search-grounding) | 自建網路搜尋，不用 Gemini Search Grounding | 採用 |
| [003](#adr-003-預設-flash-lite-模型額度用完自動換備援模型) | 預設 Flash-Lite 模型，額度用完自動換備援模型 | 採用 |
| [004](#adr-004-預設-router-搜尋判斷搜尋結果附在使用者訊息後) | 預設 router 搜尋判斷，搜尋結果附在使用者訊息後 | 採用 |
| [005](#adr-005-資料存-google-試算表) | 資料存 Google 試算表 | 採用 |
| [006](#adr-006-設定與金鑰只放指令碼屬性) | 設定與金鑰只放指令碼屬性 | 採用 |
| [007](#adr-007-轉接站向-telegram-拉訊息交給-gas-回答) | 轉接站向 Telegram 拉訊息、交給 GAS 回答 | 採用 (取代 007a) |
| [007a](#adr-007a-gas-收-webhook-轉接站輪詢-gas-佇列) | GAS 收 webhook、轉接站輪詢 GAS 佇列 | 已取代 (→ 007) |
| [008](#adr-008-保留-gas-獨立模式作為備援) | 保留 GAS 獨立模式作為備援 | 採用 |
| [009](#adr-009-src-為唯一原始碼codegs-由建置產生) | `src/` 為唯一原始碼，`Code.gs` 由建置產生 | 採用 |
| [010](#adr-010-本機用-node-模擬-gas-測試clasp-不裝全域) | 本機用 Node 模擬 GAS 測試，clasp 不裝全域 | 採用 |
| [011](#adr-011-以-multi-引擎取代-ddgs-套件) | 以 multi 引擎取代 ddgs 套件 | 採用 |

---

## ADR-001 用 Gemini API 取代本機 Ollama

- **情境**：W6 用本機 Ollama (llama3.1) 回答。GAS 跑在 Google 的伺服器，連不到使用者電腦的 `localhost:11434`。
- **決定**：模型改用 Gemini API (REST `generateContent`)，API key 放在 GAS 指令碼屬性。
- **理由**：GAS 可直接以 `UrlFetchApp` 呼叫；有免費額度；支援 Function Calling 與 JSON schema 輸出，W6 的 router / tools 兩種搜尋判斷都能沿用。
- **代價**：需要網路與 API key；免費額度有每分鐘、每日次數限制 (見 ADR-003、ISSUE-010)。資料會送到 Google，不再是 100% 本機。

## ADR-002 自建網路搜尋，不用 Gemini Search Grounding

- **情境**：Gemini 內建 Google 搜尋 (grounding) 最省事，但實測免費版無法使用。
- **決定**：沿用 W6 的自建搜尋：DuckDuckGo HTML、Google News RSS、備援引擎，搜尋後讀前 N 筆網頁內文並依關鍵字摘錄。
- **理由**：不需額外金鑰與付費；W6 已驗證的摘錄演算法 (例如完整列出老師開的全部課程) 可逐行移植。
- **代價**：要自己解析各搜尋引擎的 HTML，網站改版就可能失效 (ISSUE-011)；Google 機房 IP 可能被搜尋引擎擋 (實測 DuckDuckGo 目前可用)。

## ADR-003 預設 Flash-Lite 模型，額度用完自動換備援模型

- **情境**：Gemini 2.0 系列已停用、2.5 系列僅開放舊用戶；免費額度按模型分開計算。
- **決定**：`GEMINI_MODEL` 預設 `gemini-3.5-flash-lite`；`GEMINI_FALLBACK_MODELS` 預設 `gemini-3.1-flash-lite,gemini-3.6-flash`。遇 429 / 503 時**不等待**直接換下一個模型；用完的模型以 CacheService 暫停 (訊息含 PerDay 或建議等待 > 60 秒 → 1 小時，否則依建議秒數)，之後的請求先跳過。400 / 401 / 404 不切換，直接回報。
- **理由**：Flash-Lite 免費額度較寬、速度快；多個模型輪替可以撐更久；等待重試會讓 Telegram 使用者等太久。
- **代價**：備援模型的回答品質可能不同，頁尾標示 `(備援)` 讓使用者知道。
- **注意**：Gemini 3 建議維持預設 temperature，因此不設定 temperature。

## ADR-004 預設 router 搜尋判斷，搜尋結果附在使用者訊息後

- **情境**：W6 的 router 模式會自己造一筆 `assistant tool_calls` 再接 `role: tool` 結果。Gemini 3 的工具呼叫 (functionCall) 帶有模型產生的 `thoughtSignature`，自己造的工具呼叫沒有簽章會被拒絕。
- **決定**：
  - 預設 `SEARCH_DECISION=router`：先用 JSON schema 讓模型輸出 `{need_search, query}`，需要時搜尋。
  - router 模式把搜尋結果作為**使用者訊息的附加段落**，不偽造工具呼叫。
  - tools 模式 (原生 Function Calling) 把模型回傳的 content **原封不動**送回，保留簽章；最多 3 輪，達上限以 `toolMode: NONE` 產生最終回答。
- **理由**：router 可控性高、寫程式 / 翻譯 / 閒聊不會亂搜；兩種模式都相容 Gemini 3。
- **代價**：router 每題至少呼叫 Gemini 2 次，較耗額度。

## ADR-005 資料存 Google 試算表

- **情境**：GAS 沒有本機檔案系統。可選 PropertiesService (單值 9KB、總量 500KB)、CacheService (最多 6 小時)、Google 試算表。
- **決定**：
  - 對話歷史、每日配額、互動日誌存在自動建立的試算表 (History / Quota / Logs 分頁)；`SPREADSHEET_ID` 留空時自動建立並寫回。
  - 配額與歷史寫入用 `LockService.getScriptLock()` 互斥 (取代 Python 的 threading.Lock)。
  - `update_id` 去重、模型暫停、DuckDuckGo 冷卻用 CacheService (短期資料)。
- **理由**：試算表永久保存、使用者可以直接打開看日誌；短期狀態放快取，速度快。
- **代價**：讀寫試算表比本機檔案慢；每位使用者的歷史存在一個儲存格 (上限 5 萬字元，超過時丟棄舊的輪次)。

## ADR-006 設定與金鑰只放指令碼屬性

- **決定**：所有設定 (含 `TELEGRAM_BOT_TOKEN`、`GEMINI_API_KEY`、`WEBHOOK_SECRET`) 只從指令碼屬性讀取，程式碼與 repo 不含任何金鑰；`setupProperties()` 列印時遮蔽金鑰。修改屬性下一則訊息即生效，不需重新部署。轉接站只在本機 `.env` (已 gitignore) 放 Telegram Token、GAS 網址與 secret。
- **Webhook 驗證**：GAS 的 `doPost(e)` 讀不到 HTTP 標頭 (`X-Telegram-Bot-Api-Secret-Token`)，改用網址參數 `?secret=`；轉接站的 ask 介面用 `?token=`，同一個 `WEBHOOK_SECRET`。
- **代價**：secret 出現在 webhook 網址中，查詢 `getWebhookInfo` 時要遮蔽 (`getWebhookInfo()` 已處理)。

## ADR-007 轉接站向 Telegram 拉訊息、交給 GAS 回答

- **情境**：Telegram webhook 直接打 GAS 時，GAS 網頁應用程式一律回 **302 轉址** (程式無法改變)。Telegram 把 302 當成失敗：重送同一則訊息並逐次拉長間隔，新訊息排在後面。實測幾則訊息後 `pending_update_count` 累積、超過 90 秒沒有任何投遞，bot 完全不回。
- **決定**：
  - 電腦上的轉接站 (`relay/relay.js`) 用 `getUpdates` 長輪詢 (25 秒) 主動拿訊息，印出每一題。
  - 轉接站 `POST ?action=ask&token=…` 把 update 交給 GAS；GAS 處理後**直接回覆 Telegram**，並回傳 `{replies, logs, seconds}` 讓轉接站印出過程。
  - 轉接站用 curl：POST 不加 `-X POST`，302 後改用 GET 取得 GAS 回應 (跟瀏覽器行為一致)。
  - 處理過程的重點以 `traceLog` 記錄 (實測在 GAS 覆寫 `console` 無效，攔截不到日誌)。
- **理由**：getUpdates 沒有 302 問題，秒回且穩定；不需要 cloudflared 通道或固定 IP；Gemini 金鑰與所有邏輯仍集中在 GAS。
- **代價**：轉接站要開著 bot 才穩定 (見 ADR-008)；一次處理一則訊息。
- **取代**：ADR-007a。

## ADR-007a GAS 收 webhook、轉接站輪詢 GAS 佇列

- **狀態**：已取代 (1.1.0 採用，2.0.0 被 ADR-007 取代)。
- **內容**：Telegram webhook → GAS `doPost` 把訊息排入 CacheService 佇列；轉接站每 2 秒 `GET ?action=poll` 取題目，在本機用同一份程式 (gasShim) 搜尋並呼叫 Gemini；轉接站 30 秒沒輪詢時 GAS 自己回答。
- **取代原因**：訊息仍經由 Telegram webhook 進入 GAS，同樣受 302 問題影響而卡住；而且轉接站本機也要放 Gemini 金鑰、對話記憶分散在兩處。

## ADR-008 保留 GAS 獨立模式作為備援

- **決定**：保留 Telegram webhook → GAS `doPost` 的路徑 (`setWebhook()`)。轉接站啟動時 `deleteWebhook(drop_pending_updates=false)`，Ctrl+C 結束時 `setWebhook` 設回 GAS (`RELAY_RESTORE_WEBHOOK=false` 可停用)。
- **理由**：電腦關機時 bot 仍能回答 (即使可能變慢)；下次開轉接站時，Telegram 保留的未處理訊息 (24 小時) 會被補答，`update_id` 去重避免重複回覆。
- **代價**：獨立模式受 302 影響 (ISSUE-001)；轉接站異常結束時 webhook 不會設回 (ISSUE-005)。

## ADR-009 `src/` 為唯一原始碼，`Code.gs` 由建置產生

- **情境**：作業要求 repo 內有 `Code.gs`；但單一檔案 (目前約 2683 行) 難維護，clasp 推送多檔也比較清楚。
- **決定**：程式寫在 `src/*.js` (依功能分檔，GAS 共用全域命名空間)；`npm run build` 合併成 `Code.gs` 供貼進編輯器。clasp 只推 `src/` (`.claspignore`)，兩種方式擇一，避免函式重複定義。`npm test` 檢查 `Code.gs` 與 `src/` 同步，並測試單獨載入 `Code.gs` 可運作。
- **規範**：頂層程式碼不可引用其他檔案的常數 (GAS 載入順序不保證)，跨檔引用放在函式內 (例如 `getSearchEngines()` 以函式回傳)。

## ADR-010 本機用 Node 模擬 GAS 測試，clasp 不裝全域

- **決定**：
  - `dev/gasShim.js` 把 `src/*.js` 載入同一個 `vm` context，提供 PropertiesService、CacheService、LockService、Utilities、UrlFetchApp、SpreadsheetApp (記憶體版) 等替身；測試用 Node 內建 test runner，零第三方依賴。
  - `npm run simulate` 用同一個環境 + curl 真的連網，在終端機與 bot 對話。
  - clasp 只裝在專案的 `node_modules`，所有 npm script 帶 `-A .clasprc.json`，登入憑證不寫到家目錄。
- **理由**：不部署也能測完整流程 (doPost → 搜尋判斷 → Gemini → Telegram，假網路)；不污染本機環境。
- **代價**：替身行為與真正的 GAS 可能有差異 (例如 `console` 可覆寫、302 行為)，最後仍要在 GAS 編輯器用 `simulate` / `testSearch` 實測。

## ADR-011 以 multi 引擎取代 ddgs 套件

- **情境**：W6 的備援引擎是 Python 套件 ddgs，GAS 無法安裝。
- **決定**：`multi` 引擎依序嘗試 Bing → DuckDuckGo Lite → Mojeek，以 regex 解析 HTML；Bing 的轉址連結 (`u=a1<base64>`) 還原為真實網址。DuckDuckGo HTML 被機器人驗證擋下 (HTTP 202 / anomaly) 時冷卻 10 分鐘，由備援接手。
- **理由**：免金鑰、可在 GAS 與 Node 共用；多個引擎降低單一來源被擋的風險。
- **代價**：HTML 結構改版就要更新解析器 (ISSUE-011)。
