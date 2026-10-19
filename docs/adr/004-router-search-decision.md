# ADR-004 預設 router 搜尋判斷，搜尋結果附在使用者訊息後

| 項目 | 內容 |
|---|---|
| 狀態 | 採用 |
| 日期 | 2026-10-19 |
| 相關 | commit [`0a23708`](https://github.com/chinkunlim/wk07_bot_google/commit/0a23708)、CHANGELOG 1.0.0 |

## 情境

W6 的 router 模式會自己造一筆 `assistant tool_calls` 再接 `role: tool` 結果。Gemini 3 的工具呼叫 (functionCall) 帶有模型產生的 `thoughtSignature`，自己造的工具呼叫沒有簽章會被拒絕。

## 決定

- 預設 `SEARCH_DECISION=router`：先用 JSON schema 讓模型輸出 `{need_search, query}`，需要時搜尋
- router 模式把搜尋結果作為**使用者訊息的附加段落**，不偽造工具呼叫
- tools 模式 (原生 Function Calling) 把模型回傳的 content **原封不動**送回，保留簽章；最多 3 輪，達上限以 `toolMode: NONE` 產生最終回答

## 後果

- 寫程式、翻譯、閒聊不會亂搜；兩種模式都相容 Gemini 3
- router 每題至少呼叫 Gemini 2 次，較耗額度

## 考慮過的替代方案

- **只用 tools 模式**：模型自己決定，可控性較低
- **照 W6 偽造 functionCall**：Gemini 3 會因缺少 thoughtSignature 拒絕
