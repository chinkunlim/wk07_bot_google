# ADR-003 預設 Flash-Lite 模型，額度用完自動換備援模型

| 項目 | 內容 |
|---|---|
| 狀態 | 採用 |
| 日期 | 2026-10-19 |
| 相關 | commit [`0a23708`](https://github.com/chinkunlim/wk07_bot_google/commit/0a23708)、CHANGELOG 1.0.0 |

## 情境

Gemini 2.0 系列已停用、2.5 系列僅開放舊用戶；免費額度按模型分開計算。等待重試會讓 Telegram 使用者等太久。

## 決定

- `GEMINI_MODEL` 預設 `gemini-3.5-flash-lite`；`GEMINI_FALLBACK_MODELS` 預設 `gemini-3.1-flash-lite,gemini-3.6-flash`
- 遇 429 / 503 時**不等待**直接換下一個模型；用完的模型以 CacheService 暫停 (訊息含 PerDay 或建議等待 > 60 秒 → 1 小時，否則依建議秒數)
- 400 / 401 / 404 不切換，直接回報
- Gemini 3 建議維持預設 temperature，因此不設定

## 後果

- 多個模型輪替，免費額度撐更久
- 備援模型的回答品質可能不同，頁尾標示 `(備援)`、日誌記錄實際模型

## 考慮過的替代方案

- **只用單一模型 + 等待重試**：每日額度用完就整天不能用；等待會讓使用者以為當機
- **預設 gemini-2.5-flash / 2.0-flash**：2.0 已停用、2.5 僅限舊用戶
