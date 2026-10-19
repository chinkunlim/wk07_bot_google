# ADR-005 資料存 Google 試算表

| 項目 | 內容 |
|---|---|
| 狀態 | 採用 |
| 日期 | 2026-10-19 |
| 相關 | commit [`0a23708`](https://github.com/chinkunlim/wk07_bot_google/commit/0a23708) (來源欄位：[`80697a1`](https://github.com/chinkunlim/wk07_bot_google/commit/80697a1))、CHANGELOG 1.0.0、2.4.0 |

## 情境

GAS 沒有本機檔案系統。對話歷史、每日配額、互動日誌需要持久保存。

## 決定

- 對話歷史、每日配額、互動日誌存在自動建立的試算表 (History / Quota / Logs 分頁)；`SPREADSHEET_ID` 留空時自動建立並寫回
- 配額與歷史寫入用 `LockService.getScriptLock()` 互斥 (取代 Python 的 threading.Lock)
- `update_id` 去重、模型暫停、DuckDuckGo 冷卻等短期狀態用 CacheService

## 後果

- 永久保存、使用者可以直接打開看日誌
- 讀寫比本機檔案慢；每位使用者的歷史存在一個儲存格 (上限 5 萬字元，超過時丟棄舊輪次)

## 考慮過的替代方案

- **PropertiesService**：單值 9KB、總量 500KB，不夠存歷史與日誌
- **CacheService**：最多保存 6 小時，不適合配額與日誌
- **外部資料庫 (Firestore 等)**：需要額外設定與憑證
