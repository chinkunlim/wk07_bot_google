# ADR-011 以 multi 引擎取代 ddgs 套件

| 項目 | 內容 |
|---|---|
| 狀態 | 採用 |
| 日期 | 2026-10-19 |
| 相關 | commit [`0a23708`](https://github.com/chinkunlim/wk07_bot_google/commit/0a23708)、CHANGELOG 1.0.0 |

## 情境

W6 的備援引擎是 Python 套件 ddgs，GAS 無法安裝。

## 決定

- `multi` 引擎依序嘗試 Bing → DuckDuckGo Lite → Mojeek，以 regex 解析 HTML；Bing 轉址連結 (`u=a1<base64>`) 還原為真實網址
- DuckDuckGo HTML 被機器人驗證擋下 (HTTP 202 / anomaly) 時冷卻 10 分鐘，由備援接手

## 後果

- 免金鑰、可在 GAS 與 Node 共用；多個引擎降低單一來源被擋的風險
- HTML 結構改版就要更新解析器 ([ISSUE-011](../known-issues.md#issue-011-搜尋引擎改版或封鎖))

## 考慮過的替代方案

- **ddgs**：GAS 無法安裝 Python 套件
- **只用 DuckDuckGo**：被擋時就沒有結果
