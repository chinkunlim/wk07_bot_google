# ADR-002 自建網路搜尋，不用 Gemini Search Grounding

| 項目 | 內容 |
|---|---|
| 狀態 | 採用 |
| 日期 | 2026-10-19 |
| 相關 | commit [`0a23708`](https://github.com/chinkunlim/wk07_bot_google/commit/0a23708)、CHANGELOG 1.0.0 |

## 情境

Gemini 內建 Google 搜尋 (grounding) 最省事，但實測免費版無法使用。

## 決定

沿用 W6 的自建搜尋：DuckDuckGo HTML、Google News RSS、備援引擎；搜尋後讀前 N 筆網頁內文，依關鍵字摘錄。

## 後果

- 不需額外金鑰與付費；W6 已驗證的摘錄演算法 (例如完整列出老師開的全部課程) 可逐行移植
- 要自己解析各搜尋引擎的 HTML，網站改版就可能失效 ([ISSUE-011](../known-issues.md#issue-011-搜尋引擎改版或封鎖))
- Google 機房 IP 可能被搜尋引擎擋 (實測 DuckDuckGo 目前可用)

## 考慮過的替代方案

- **Gemini Search Grounding**：免費版無法使用
- **需要金鑰的搜尋 API**：要另外申請與管理金鑰
- **只用 Google News RSS**：只有新聞，查不到一般網頁 (例如課程資料)
