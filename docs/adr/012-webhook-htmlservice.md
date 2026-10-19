# ADR-012 Telegram webhook 回應改用 HtmlService

| 項目 | 內容 |
|---|---|
| 狀態 | 採用；更正 [ADR-007](007-relay-pulls-telegram.md)、[ADR-008](008-keep-gas-standalone.md) 的前提 |
| 日期 | 2026-10-19 |
| 相關 | commit [`e21d7f9`](https://github.com/chinkunlim/wk07_bot_google/commit/e21d7f9)、CHANGELOG 2.2.0、[ISSUE-001](../known-issues.md#issue-001-gas-獨立模式越來越慢最後不回) |

## 情境

GAS 獨立模式下 bot 幾則訊息後就不回 ([ISSUE-001](../known-issues.md#issue-001-gas-獨立模式越來越慢最後不回))，[ADR-007](007-relay-pulls-telegram.md) 當時判斷為「GAS 一律回 302、無法改變」。使用者 W5 / W6 的 GAS + Telegram bot 沒有這個問題；對照後發現舊專案 `doPost` 回傳 `HtmlService.createHtmlOutput()`，本專案回傳 `ContentService.createTextOutput()`。

## 決定

- 回給 Telegram 的所有路徑 (正常、重複、secret 不符、例外) 一律經 `webhookResponse_()` 回 `HtmlService`
- 轉接站的 ask 介面、`?action=recent` 與 `doGet` 健康檢查維持 `ContentService` (curl 會跟隨 302)
- 測試檢查所有 Telegram 路徑都回 HtmlService

## 後果

- `ContentService` 的輸出由 `script.googleusercontent.com` 提供，`/exec` 先回 **302**；`HtmlService` 由 `script.google.com` 直接回 **200**，Telegram 判定投遞成功
- 驗證：curl 模擬 Telegram (不跟隨轉址) 回 HTTP 200；不開轉接站連續提問全部回答，`pending_update_count` 為 0
- GAS 獨立模式與轉接站模式一樣穩定；轉接站改為「在電腦上觀察每一題」的工具 ([ADR-007](007-relay-pulls-telegram.md) 仍採用)
- 教訓：「平台限制、無法改變」的結論要先找反例驗證；這次使用者的舊專案就是反例

## 考慮過的替代方案

- **Cloudflare Worker 等代理**：多一個服務要維護
- **只靠轉接站**：電腦關機就不穩
