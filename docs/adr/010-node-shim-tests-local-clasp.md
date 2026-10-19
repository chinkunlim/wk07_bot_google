# ADR-010 本機用 Node 模擬 GAS 測試，clasp 不裝全域

| 項目 | 內容 |
|---|---|
| 狀態 | 採用 |
| 日期 | 2026-10-19 |
| 相關 | commit [`0a23708`](https://github.com/chinkunlim/wk07_bot_google/commit/0a23708)、CHANGELOG 1.0.0 |

## 情境

GAS 只能在雲端執行，每次驗證都要推送、部署，很慢；使用者要求不污染本機環境。

## 決定

- `dev/gasShim.js` 把 `src/*.js` 載入同一個 `vm` context，提供 PropertiesService、CacheService、LockService、Utilities、UrlFetchApp、SpreadsheetApp (記憶體版)、ContentService、HtmlService 等替身
- 測試用 Node 內建 test runner，零第三方依賴
- `npm run simulate` 用同一環境 + curl 真的連網
- clasp 只裝在專案的 `node_modules`，npm script 一律帶 `-A .clasprc.json`，登入憑證不寫到家目錄

## 後果

- 不部署也能測完整流程 (doPost → 搜尋判斷 → Gemini → Telegram，假網路)；不污染本機
- 替身與真正 GAS 有差異 (例如 `console` 可覆寫、ContentService 不會 302)，重要改動仍要在 GAS 編輯器實測

## 考慮過的替代方案

- **只在 GAS 編輯器手動測試**：慢、無法自動化
- **clasp 裝全域**：會寫入家目錄與全域 npm
