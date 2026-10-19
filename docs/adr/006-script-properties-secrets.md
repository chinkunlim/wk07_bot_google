# ADR-006 設定與金鑰只放指令碼屬性

| 項目 | 內容 |
|---|---|
| 狀態 | 採用 |
| 日期 | 2026-10-19 |
| 相關 | commit [`0a23708`](https://github.com/chinkunlim/wk07_bot_google/commit/0a23708)、CHANGELOG 1.0.0 |

## 情境

Bot Token、Gemini key 等金鑰不能進 repo；GAS 的 `doPost(e)` 讀不到 HTTP 標頭，無法使用 Telegram 的 `X-Telegram-Bot-Api-Secret-Token`。

## 決定

- 所有設定 (含 `TELEGRAM_BOT_TOKEN`、`GEMINI_API_KEY`、`WEBHOOK_SECRET`) 只從指令碼屬性讀取；`setupProperties()` 列印時遮蔽金鑰；修改屬性下一則訊息即生效
- Webhook 用網址參數 `?secret=` 驗證；轉接站的 ask 介面與 `?action=recent` 用 `?token=`，同一個 `WEBHOOK_SECRET`
- 轉接站只在本機 `.env` (gitignore) 放 Telegram Token、GAS 網址與 secret

## 後果

- repo 與程式碼不含任何金鑰
- secret 出現在 webhook 網址中，查詢時要遮蔽 (`getWebhookInfo()`、`npm run mode` 已處理)

## 考慮過的替代方案

- **寫在程式碼常數**：會隨 repo 公開
- **用 HTTP 標頭驗證**：GAS 讀不到標頭
