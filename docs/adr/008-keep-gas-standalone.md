# ADR-008 保留 GAS 獨立模式作為備援

| 項目 | 內容 |
|---|---|
| 狀態 | 採用；後果由 [ADR-012](012-webhook-htmlservice.md) 更正 (獨立模式已與轉接站模式一樣穩定) |
| 日期 | 2026-10-19 |
| 相關 | commit [`6e863e3`](https://github.com/chinkunlim/wk07_bot_google/commit/6e863e3)、CHANGELOG 2.0.0、[ISSUE-005](../known-issues.md#issue-005-轉接站異常結束時-webhook-沒有設回-gas) |

## 情境

改由轉接站拿訊息後，電腦關機時 bot 就不會回答。

## 決定

- 保留 Telegram webhook → GAS `doPost` 的路徑 (`setWebhook()`)
- 轉接站啟動時 `deleteWebhook(drop_pending_updates=false)`，Ctrl+C 結束時 `setWebhook` 設回 GAS (`RELAY_RESTORE_WEBHOOK=false` 可停用)

## 後果

- 電腦關機時 bot 仍能回答 (即使可能變慢)；下次開轉接站時，Telegram 保留的未處理訊息 (24 小時) 會被補答，`update_id` 去重避免重複回覆
- 獨立模式受 302 影響 ([ISSUE-001](../known-issues.md#issue-001-gas-獨立模式越來越慢最後不回))；轉接站異常結束時 webhook 不會設回 ([ISSUE-005](../known-issues.md#issue-005-轉接站異常結束時-webhook-沒有設回-gas))

## 考慮過的替代方案

- **只有轉接站模式**：電腦關機 bot 就停擺

> **後續 (2.2.0)**：[ADR-012](012-webhook-htmlservice.md) 之後獨立模式不再受 302 影響。依 ADR 慣例本文保留當時的判斷。
