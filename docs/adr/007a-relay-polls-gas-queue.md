# ADR-007a GAS 收 webhook、轉接站輪詢 GAS 佇列

| 項目 | 內容 |
|---|---|
| 狀態 | 已取代 (由 [ADR-007](007-relay-pulls-telegram.md) 取代) |
| 日期 | 2026-10-19 |
| 相關 | commit [`0f864a7`](https://github.com/chinkunlim/wk07_bot_google/commit/0f864a7) 採用、[`6e863e3`](https://github.com/chinkunlim/wk07_bot_google/commit/6e863e3) 取代；CHANGELOG 1.1.0、2.0.0 |

## 情境

作業要求「轉接站程式」在電腦上執行並印出每一題；搜尋引擎可能擋 Google 機房 IP，在家用網路搜尋比較穩。

## 決定

- Telegram webhook → GAS `doPost` 把訊息排入 CacheService 佇列
- 轉接站每 2 秒 `GET ?action=poll` 取題目，在本機用同一份程式 (gasShim) 搜尋並呼叫 Gemini
- 轉接站 30 秒沒輪詢時 GAS 自己回答

## 後果

- 訊息仍經由 Telegram webhook 進入 GAS，同樣受 302 問題影響而卡住
- 轉接站本機也要放 Gemini 金鑰；對話記憶分散在 GAS 與本機兩處

## 考慮過的替代方案

- 見 [ADR-007](007-relay-pulls-telegram.md)

> 編號 007a 是因為它在 007 之前採用、在記錄 ADR 時才補上；保留編號以維持既有 commit 與 CHANGELOG 的引用。
