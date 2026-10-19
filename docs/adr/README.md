# 架構決策記錄 (ADR)

記錄本專案**重要且不易回頭**的技術決定：當時的情境、決定、後果與考慮過的替代方案。
小決定 (命名、文案、小重構) 寫在 commit 訊息即可，不需要 ADR。

## 索引

| ADR | 決定 | 狀態 |
|---|---|---|
| [ADR-001](001-gemini-api.md) | 用 Gemini API 取代本機 Ollama | 採用 |
| [ADR-002](002-self-built-search.md) | 自建網路搜尋，不用 Gemini Search Grounding | 採用 |
| [ADR-003](003-gemini-fallback-models.md) | 預設 Flash-Lite 模型，額度用完自動換備援模型 | 採用 |
| [ADR-004](004-router-search-decision.md) | 預設 router 搜尋判斷，搜尋結果附在使用者訊息後 | 採用 |
| [ADR-005](005-google-sheets-storage.md) | 資料存 Google 試算表 | 採用 |
| [ADR-006](006-script-properties-secrets.md) | 設定與金鑰只放指令碼屬性 | 採用 |
| [ADR-007](007-relay-pulls-telegram.md) | 轉接站向 Telegram 拉訊息、交給 GAS 回答 | 採用 |
| [ADR-007a](007a-relay-polls-gas-queue.md) | GAS 收 webhook、轉接站輪詢 GAS 佇列 | 已取代 |
| [ADR-008](008-keep-gas-standalone.md) | 保留 GAS 獨立模式作為備援 | 採用 |
| [ADR-009](009-src-single-source-codegs.md) | `src/` 為唯一原始碼，`Code.gs` 由建置產生 | 採用 |
| [ADR-010](010-node-shim-tests-local-clasp.md) | 本機用 Node 模擬 GAS 測試，clasp 不裝全域 | 採用 |
| [ADR-011](011-multi-search-engine.md) | 以 multi 引擎取代 ddgs 套件 | 採用 |
| [ADR-012](012-webhook-htmlservice.md) | Telegram webhook 回應改用 HtmlService | 採用 |

## 撰寫規則

1. **一個決定一個檔案**：`NNN-簡短英文-slug.md`，編號遞增、不重複使用
2. **已採用的 ADR 不改內容**：之後發現錯誤或改變做法時，**新增一份 ADR** 說明新決定，並只修改舊 ADR 的「狀態」欄 (例如「已取代 (由 ADR-012 取代)」)，保留當時的判斷以便溯源
3. **狀態**：`提議` → `採用` → `已取代` / `已廢棄`
4. **連結**：「相關」欄列出 commit、CHANGELOG 版本與 [已知問題](../known-issues.md)，讓「問題 → 決策 → 程式 → 版本」可以互相追溯
5. 新 ADR 從 [template.md](template.md) 複製開始

## 溯源範例

```
ISSUE-001 bot 越來越慢 (docs/known-issues.md)
  └─ ADR-007 轉接站拉訊息 (當時以為 302 無法改變)
       └─ ADR-012 改用 HtmlService (找到真正原因，更正 007 / 008)
            └─ commit e21d7f9 ─▶ CHANGELOG 2.2.0
```
