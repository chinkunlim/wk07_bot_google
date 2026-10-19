# ADR-007 轉接站向 Telegram 拉訊息、交給 GAS 回答

| 項目 | 內容 |
|---|---|
| 狀態 | 採用；前提由 [ADR-012](012-webhook-htmlservice.md) 更正 (轉接站本身仍採用) |
| 日期 | 2026-10-19 |
| 相關 | commit [`6e863e3`](https://github.com/chinkunlim/wk07_bot_google/commit/6e863e3)、CHANGELOG 2.0.0、[ISSUE-001](../known-issues.md#issue-001-gas-獨立模式越來越慢最後不回)；取代 [ADR-007a](007a-relay-polls-gas-queue.md) |

## 情境

Telegram webhook 直接打 GAS 時，GAS 網頁應用程式一律回 **302 轉址** (程式無法改變)。Telegram 把 302 當成失敗：重送同一則訊息並逐次拉長間隔，新訊息排在後面。實測幾則訊息後 `pending_update_count` 累積、超過 90 秒沒有任何投遞，bot 完全不回。

## 決定

- 電腦上的轉接站 (`relay/relay.js`) 用 `getUpdates` 長輪詢 (25 秒) 主動拿訊息，印出每一題
- 轉接站 `POST ?action=ask&token=…` 把 update 交給 GAS；GAS 處理後**直接回覆 Telegram**，並回傳 `{replies, logs, seconds}` 讓轉接站印出過程
- 轉接站用 curl：POST 不加 `-X POST`，302 後改用 GET 取得 GAS 回應 (跟瀏覽器行為一致)
- 處理過程的重點以 `traceLog` 記錄 (實測在 GAS 覆寫 `console` 無效)

## 後果

- getUpdates 沒有 302 問題，秒回且穩定；不需要 cloudflared 通道或固定 IP；Gemini 金鑰與所有邏輯仍集中在 GAS
- 轉接站要開著 bot 才穩定 (見 [ADR-008](008-keep-gas-standalone.md))；一次處理一則訊息

## 考慮過的替代方案

- **GAS 收 webhook、轉接站輪詢佇列**：見 [ADR-007a](007a-relay-polls-gas-queue.md)，同樣受 302 影響
- **Cloudflare Worker 等代理先回 200**：要多維護一個雲端服務
- **GAS 定時觸發器用 getUpdates**：最慢要等 1 分鐘，且觸發器每日執行時間有限

> **後續 (2.2.0)**：情境中「GAS 一律回 302、程式無法改變」經 [ADR-012](012-webhook-htmlservice.md) 證實有誤 (302 來自 ContentService)。依 ADR 慣例本文保留當時的判斷，不再修改。
