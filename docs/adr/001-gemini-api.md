# ADR-001 用 Gemini API 取代本機 Ollama

| 項目 | 內容 |
|---|---|
| 狀態 | 採用 |
| 日期 | 2026-10-19 |
| 相關 | commit [`0a23708`](https://github.com/chinkunlim/wk07_bot_google/commit/0a23708)、CHANGELOG 1.0.0 |

## 情境

W6 版用本機 Ollama (llama3.1) 回答。GAS 跑在 Google 的伺服器，連不到使用者電腦的 `localhost:11434`。

## 決定

模型改用 Gemini API (REST `generateContent`)，API key 放在 GAS 指令碼屬性。

## 後果

- 可直接用 `UrlFetchApp` 呼叫；有免費額度；支援 Function Calling 與 JSON schema 輸出，W6 的 router / tools 兩種搜尋判斷都能沿用
- 需要網路與 API key；免費額度有每分鐘、每日次數限制 (見 [ADR-003](003-gemini-fallback-models.md)、[ISSUE-010](../known-issues.md#issue-010-gemini-免費額度用完))
- 提問內容會送到 Google，不再是 100% 本機

## 考慮過的替代方案

- **繼續用 Ollama + 通道 (cloudflared / ngrok)**：電腦必須一直開著，且仍需公開網址，失去用 GAS 的意義
- **其他付費模型 API**：需要付費，免費額度不如 Gemini
