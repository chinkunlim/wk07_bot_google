# KNOWN_ISSUES.md - 已知問題與規避方式

狀態：🔴 未解決、🟡 有規避方式、🟢 已解決 (保留紀錄)。

| ID | 問題 | 狀態 |
|---|---|---|
| [001](#issue-001-gas-獨立模式越來越慢最後不回) | GAS 獨立模式越來越慢、最後不回 (302) | 🟡 |
| [002](#issue-002-push-之後網址跑的還是舊程式) | push 之後網址跑的還是舊程式 | 🟡 |
| [003](#issue-003-開著的舊編輯器分頁把新程式蓋回去) | 開著的舊編輯器分頁把新程式蓋回去 | 🟡 |
| [004](#issue-004-clasp-create-覆蓋-appsscriptjson) | `clasp create` 覆蓋 `appsscript.json` | 🟡 |
| [005](#issue-005-轉接站異常結束時-webhook-沒有設回-gas) | 轉接站異常結束時 webhook 沒有設回 GAS | 🔴 |
| [006](#issue-006-瀏覽器開網址顯示無法開啟這個檔案) | 瀏覽器開網址顯示「無法開啟這個檔案」 | 🟡 |
| [007](#issue-007-剛部署後偶爾-http-404) | 剛部署後偶爾 HTTP 404 | 🟡 |
| [008](#issue-008-學校--公司帳號可能無法開放所有人存取) | 學校 / 公司帳號可能無法開放「所有人」存取 | 🟡 |
| [009](#issue-009-從其他程式停止轉接站最多等-25-秒) | 從其他程式停止轉接站最多等 25 秒 | 🟡 |
| [010](#issue-010-gemini-免費額度用完) | Gemini 免費額度用完 | 🟡 |
| [011](#issue-011-搜尋引擎改版或封鎖) | 搜尋引擎改版或封鎖 | 🟡 |
| [012](#issue-012-npm-audit-顯示-3-個-high) | `npm audit` 顯示 3 個 high | 🟡 |
| [013](#issue-013-轉接站視窗與截圖會顯示-telegram-user-id) | 轉接站視窗與截圖會顯示 Telegram User ID | 🟡 |
| [014](#issue-014-轉接站一次只處理一則訊息) | 轉接站一次只處理一則訊息 | 🔴 |
| [015](#issue-015-在外層資料夾執行-npm-找不到-packagejson) | 在別的資料夾執行 npm 找不到 `package.json` | 🟢 |
| [016](#issue-016-轉接站看不到-gas-的搜尋過程) | 轉接站看不到 GAS 的搜尋過程 | 🟢 |
| [017](#issue-017-setwebhook-拒絕學校帳號網址--dev-網址) | `setWebhook` 拒絕學校帳號網址 / `/dev` 網址 | 🟢 |

---

## ISSUE-001 GAS 獨立模式越來越慢、最後不回

- **現象**：沒開轉接站時 (webhook 指向 GAS)，前幾則訊息正常，之後回覆越來越慢甚至不回；`getWebhookInfo` 顯示 `Wrong response from the webhook: 302 Found`，`pending_update_count` 一直累積。
- **原因**：GAS 網頁應用程式一律回 302 轉址，Telegram 視為投遞失敗，重送並逐次拉長重試間隔，新訊息排在後面。程式碼端無法改變 302。
- **規避**：開轉接站 (`npm run relay`)，它改用 getUpdates 拿訊息，沒有這個問題；Telegram 保留的未處理訊息會被補答。見 ADR-007、ADR-008。

## ISSUE-002 push 之後網址跑的還是舊程式

- **現象**：`npm run push` 成功，但 bot 行為沒變；開 `/exec` 網址看不到 `relay-v2`。
- **原因**：部署作業綁定的是「建立版本當時」的程式快照，push 只更新 HEAD。在「管理部署作業」打開再按部署而沒選「新版本」，版本不會變；「新增部署作業」則會產生另一個網址。
- **規避**：`npm run redeploy -- <deploymentId>` (deploymentId 用 `npm run deployments` 查，對照 `WEBHOOK_URL` 中 `/s/` 後那段)，或編輯器「管理部署作業 → 鉛筆 → 版本：新版本 → 部署」。

## ISSUE-003 開著的舊編輯器分頁把新程式蓋回去

- **現象**：push 之後又變回舊程式；`clasp pull` 下來的版本缺少剛推的檔案。
- **原因**：push 前就開著的 GAS 編輯器分頁保有舊內容，在裡面執行函式時會把舊內容存回伺服器。
- **規避**：push 之後先重新整理所有編輯器分頁再操作；或關掉舊分頁，用 `npm run open` 開新的。

## ISSUE-004 `clasp create` 覆蓋 `appsscript.json`

- **現象**：`npm run create` 後 `appsscript.json` 變成美國時區、沒有 `webapp` 與 `oauthScopes`。
- **規避**：先備份再還原：
  ```bash
  cp appsscript.json appsscript.json.bak
  npm run create
  mv appsscript.json.bak appsscript.json
  ```

## ISSUE-005 轉接站異常結束時 webhook 沒有設回 GAS

- **現象**：電腦睡眠、關機或轉接站當掉 (沒有按 Ctrl+C) 後，bot 完全不回。
- **原因**：webhook 只在轉接站正常結束時設回 GAS；異常結束時 webhook 仍是移除狀態，沒有人去拿訊息。
- **規避**：重新開轉接站 (未處理的訊息會補答，Telegram 最多保留 24 小時)；或在 GAS 編輯器 `src/Main.gs` 執行 `setWebhook` 切到 GAS 獨立模式。
- **規劃**：GAS 定時觸發器檢查轉接站最近是否活動，太久沒有就自動 setWebhook。

## ISSUE-006 瀏覽器開網址顯示「無法開啟這個檔案」

- **現象**：瀏覽器開 `/exec` 網址出現 Google 雲端硬碟的「很抱歉，目前無法開啟這個檔案」。
- **原因**：瀏覽器同時登入多個 Google 帳號時，GAS 網頁應用程式常無法判斷帳號。bot 本身不受影響。
- **規避**：用無痕視窗開，或在終端機 `curl -sL <WEBHOOK_URL>`。

## ISSUE-007 剛部署後偶爾 HTTP 404

- **現象**：轉接站顯示一行 `GAS 回應 HTTP 404`，之後自動恢復。
- **原因**：剛建立新版本時 Google 伺服器還在同步。
- **規避**：不用處理；若持續出現，確認部署未被封存、網址正確。

## ISSUE-008 學校 / 公司帳號可能無法開放「所有人」存取

- **現象**：部署網頁應用程式時「誰可以存取」沒有「所有人」，只有網域內使用者；轉接站收到 Google 登入頁 (HTML)。
- **原因**：Google Workspace 管理員可以限制對外分享。
- **規避**：改用個人 Gmail 建立 GAS 專案 (刪掉 `.clasp.json` 後重新 `npm run create`)。

## ISSUE-009 從其他程式停止轉接站最多等 25 秒

- **說明**：在轉接站視窗按 Ctrl+C 會立即結束 (curl 一起收到中斷)。若從其他終端機送 `kill -INT <pid>`，要等這次 Telegram 長輪詢 (25 秒) 回來才處理。
- **規避**：等它印出「🛑 轉接站結束」與「☁️ 已把 webhook 設回 GAS」；第二次中斷會立即強制結束，但不會設回 webhook (見 ISSUE-005)。

## ISSUE-010 Gemini 免費額度用完

- **現象**：回覆「Gemini API 使用量已達上限」。
- **原因**：免費額度有每分鐘 / 每日限制；router 模式每題至少呼叫 2 次。
- **規避**：`GEMINI_FALLBACK_MODELS` 多加幾個模型 (額度按模型分開)；或改 `SEARCH_DECISION=tools`；`/models` 查可用模型。處理失敗時本次不計入使用者額度。

## ISSUE-011 搜尋引擎改版或封鎖

- **現象**：日誌出現 `🚫 [DuckDuckGo] 被機器人驗證擋下`、`⚠️ [multi] … 換下一個引擎`，或各引擎都沒有結果。
- **原因**：搜尋結果是解析 HTML 取得，網站改版會失效；部分引擎會擋 Google 機房或特定 IP (本機測試時 Mojeek 回 403)。
- **規避**：GAS 編輯器執行 `testSearch` 看各引擎狀況；改 `SEARCH_ENGINE` / `SEARCH_FALLBACK_ENGINE` (例如 `google_news`)；更新 `src/Search*.js` 的解析器並補 `test/search.test.js` 的 fixture。

## ISSUE-012 `npm audit` 顯示 3 個 high

- **原因**：clasp 依賴的 `micromatch` → `braces` 有深層巢狀樣式造成的 DoS 問題。
- **影響**：只在本機開發用 (推送程式時比對 `.claspignore`)，輸入是自己的設定檔；部署到 GAS 的程式不含這些套件。
- **規避**：不要執行 `npm audit fix --force` (會降回不相容的 clasp 2.x)；等 clasp 更新後 `npm update`。

## ISSUE-013 轉接站視窗與截圖會顯示 Telegram User ID

- **說明**：轉接站每題會印出 `名字 (User ID)`。User ID 不是密碼，別人拿到也無法操作 bot (白名單保護)，但公開截圖前可視需要塗掉。

## ISSUE-014 轉接站一次只處理一則訊息

- **現象**：多人同時提問時，後面的訊息要等前一則處理完 (每則約 2–15 秒)。
- **原因**：轉接站同步處理以保持視窗輸出清楚，GAS 每次請求也有 6 分鐘上限。
- **規劃**：改為平行處理多則訊息。

## ISSUE-015 在外層資料夾執行 npm 找不到 `package.json`

- **狀態**：🟢 已解決 (2.0.1 把專案移到 repo 根目錄，不再有 `gas/` 子資料夾)。
- **說明**：所有 npm 指令都要在有 `package.json` 的資料夾執行。

## ISSUE-016 轉接站看不到 GAS 的搜尋過程

- **狀態**：🟢 已解決 (2.0.0)。
- **原因**：原本想在 GAS 端暫時覆寫 `console` 攔截日誌，實測無效。
- **解決**：重點步驟改呼叫 `traceLog` / `traceWarn`，處理轉接站請求時一併回傳。

## ISSUE-017 `setWebhook` 拒絕學校帳號網址 / `/dev` 網址

- **狀態**：🟢 已解決 (1.1.0)。
- **說明**：學校帳號的網址格式為 `https://script.google.com/a/<網域>/macros/s/…/exec`，現已接受；`/dev` 是編輯者專用的測試網址，Telegram 與轉接站都無法存取，`setWebhook` 會提示改用 `/exec`。
