# WORKFLOW_GUIDE.md - 開發、部署與測試流程

第一次安裝見 `README.md`「怎麼裝」。本文件說明之後日常的開發、部署、測試與發布流程。
所有 npm 指令都在專案根目錄 (有 `package.json` 的資料夾) 執行。

---

## 1. 環境

| 需要 | 用途 |
|---|---|
| Node.js 20 以上 | 測試、建置、轉接站、clasp |
| curl (macOS 內建) | 轉接站與本機模擬連網 |
| `npm install` | 只裝 clasp (開發用)；GAS 與轉接站本身不需任何套件 |
| `.clasprc.json` (`npm run login` 產生) | clasp 登入憑證，存在專案內 |
| `.clasp.json` (`npm run create` 產生) | GAS 專案 ID |
| `.env` (複製 `.env.example`) | 轉接站：`TELEGRAM_BOT_TOKEN`、`WEBHOOK_URL`、`WEBHOOK_SECRET`；本機模擬：`GEMINI_API_KEY` |

以上三個檔案都在 `.gitignore`，不會進版控。

## 2. 日常開發循環

```
修改 src/ ─▶ npm test ─▶ npm run build ─▶ (選) npm run simulate ─▶ git commit
                                                    │
                                                    ▼
                             npm run push ─▶ 建立新版本部署 ─▶ 實測 ─▶ git push
```

1. **修改 `src/*.js`** (不要直接改 `Code.gs`)
2. **測試**
   ```bash
   npm test
   ```
3. **重新產生 `Code.gs`** (沒做的話 `npm test` 的同步檢查會失敗)
   ```bash
   npm run build
   ```
4. **本機模擬** (選用，真的連 Gemini 與搜尋，不經過 Telegram)
   ```bash
   npm run simulate
   ```
5. **推送到 GAS**
   ```bash
   npm run push
   ```
6. **讓網址跑新程式**：部署綁定版本，只 push 不會生效 (ISSUE-002)
   ```bash
   npm run deployments
   ```
   找出 `WEBHOOK_URL` 中 `/s/` 後那段 ID 對應的部署，再執行：
   ```bash
   npm run redeploy -- <deploymentId> --description "說明這次改了什麼"
   ```
   或在編輯器「部署 → 管理部署作業 → 鉛筆 → 版本：新版本 → 部署」。網址不變。
7. **確認生效**：開 `/exec` 網址看健康檢查文字 (目前為 `relay-v2`)；改了健康檢查以外的程式時，用轉接站問一題確認
8. **commit 與 push** (見 §6)

> ⚠️ push 之後，**之前就開著的 GAS 編輯器分頁要先重新整理**，否則在裡面執行任何函式都會把舊程式存回去 (ISSUE-003)。

## 3. 只改設定

指令碼屬性 (模型、搜尋引擎、額度、白名單…) 在 GAS 編輯器「專案設定 → 指令碼屬性」修改，**下一則訊息就生效**，不需 push 或部署。
轉接站的 `.env` 修改後重開轉接站。

## 4. 執行模式

| 模式 | 怎麼進入 | 特性 |
|---|---|---|
| **轉接站模式** (主要) | `npm run relay` (會自動移除 webhook) | 秒回、穩定；視窗印出每一題與搜尋過程；電腦要開著 |
| **GAS 獨立模式** (備援) | 轉接站 Ctrl+C 結束 (自動設回 webhook)，或 GAS 編輯器執行 `setWebhook` | 電腦關機也能回，但受 302 影響可能越來越慢 (ISSUE-001) |

- 同一個 Bot Token 同時只能有一個轉接站 (或 W6 Python 版) 在拿訊息，否則出現 `Conflict`
- 轉接站異常結束 (關機、當機) 時 webhook 不會設回，bot 會不回直到重開轉接站或執行 `setWebhook` (ISSUE-005)
- 切換模式不會遺失訊息：Telegram 保留未處理的訊息 24 小時，`update_id` 去重避免重複回答

## 5. 測試策略

| 層級 | 指令 / 位置 | 涵蓋 | 需要網路 / 金鑰 |
|---|---|---|---|
| 單元 | `test/format.test.js`、`pageFetch.test.js`、`search.test.js` | Markdown、切段、關鍵字、內文摘錄、各引擎解析 (含真實 Bing 頁面 fixture)、備援切換 | 否 |
| 元件 | `test/gemini.test.js`、`store.test.js` | 請求格式、重試、備援模型、錯誤；設定、配額、歷史、日誌、去重 | 否 |
| 端對端 (假網路) | `test/handler.test.js`、`relay.test.js` | doPost → 指令 / router / tools → Gemini → Telegram；轉接站 ask 介面與轉接站程式；`Code.gs` 同步與單獨載入 | 否 |
| 本機實測 | `npm run simulate` | 真實 Gemini + 搜尋 | Gemini key |
| GAS 實測 | 編輯器 `checkEnv`、`testGemini`、`testSearch`、`simulate` | 在 Google 機房的實際行為 (搜尋是否被擋、試算表權限) | GAS 指令碼屬性 |
| 上線實測 | `npm run relay` + 手機提問 | 完整流程 | 全部 |

原則：
- 修 bug 先寫能重現的測試；外部網站解析改用 `test/fixtures/` 的 HTML，不在測試中連網
- vm 內建立的陣列 / 物件與測試屬於不同 realm，比較前用 `JSON.parse(JSON.stringify(x))`
- 替身 (`dev/gasShim.js`) 與真正 GAS 有差異 (例如 GAS 無法覆寫 `console`、302 行為)，重要改動要做 GAS 實測

## 6. 版本控管

- **分支**：小改動直接在 `main`；較大的功能用 `feature/*`、`fix/*`、`docs/*` 再合併
- **提交訊息**：Conventional Commits，例如
  - `feat: 新增 /weather 指令`
  - `fix: Bing 改版後解析不到摘要`
  - `docs: 補充部署步驟`
- **commit 前**：
  ```bash
  npm test
  ```
  並確認沒有金鑰 (指令見 `AGENTS.md` §7)；`git status` 不應出現 `.env`、`.clasp*.json`
- **發布**：
  1. 更新 `package.json` 的 `version` (語意化版本：不相容改動升主版號、新功能升次版號、修正升修訂號)
  2. `CHANGELOG.md` 新增版本段落；架構改變補 `DECISIONS.md`；新問題補 `KNOWN_ISSUES.md`
  3. commit、push；需要時打 tag：`git tag v2.1.0 && git push --tags`

## 7. 首次部署到新的 Google 帳號

1. `npm run logout`，刪掉 `.clasp.json`
2. 依 README「怎麼裝」第 3–5 步重新建立專案、設定屬性、部署、`setWebhook`
3. 更新 `.env` 的 `WEBHOOK_URL`、`WEBHOOK_SECRET`

## 8. 疑難排解速查

| 狀況 | 參考 |
|---|---|
| 推了程式但沒變化 | ISSUE-002、003 |
| bot 不回 / 越來越慢 | ISSUE-001、005 |
| 轉接站「收到網頁而不是 JSON」 | ISSUE-008、002 |
| 瀏覽器開網址顯示無法開啟 | ISSUE-006 |
| 額度用完 | ISSUE-010 |
| 搜尋沒有結果 | ISSUE-011 |
| 偶爾一行 404 | ISSUE-007 |
