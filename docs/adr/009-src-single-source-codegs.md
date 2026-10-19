# ADR-009 `src/` 為唯一原始碼，`Code.gs` 由建置產生

| 項目 | 內容 |
|---|---|
| 狀態 | 採用 |
| 日期 | 2026-10-19 |
| 相關 | commit [`0f864a7`](https://github.com/chinkunlim/wk07_bot_google/commit/0f864a7)、CHANGELOG 1.1.0 |

## 情境

作業要求 repo 內有 `Code.gs`；但單一檔案 (約 2700 行) 難維護，clasp 推送多檔也比較清楚。

## 決定

- 程式寫在 `src/*.js` (依功能分檔，GAS 共用全域命名空間)；`npm run build` 合併成 `Code.gs` 供貼進編輯器
- clasp 只推 `src/` (`.claspignore`)，兩種方式擇一，避免函式重複定義
- `npm test` 檢查 `Code.gs` 與 `src/` 同步，並測試單獨載入 `Code.gs` 可運作
- 頂層程式碼不可引用其他檔案的常數 (GAS 載入順序不保證)，跨檔引用放在函式內

## 後果

- 原始碼好維護，又滿足作業要求
- 修改 `src/` 後必須記得 `npm run build` (測試會擋下忘記的情況)

## 考慮過的替代方案

- **只維護一個手寫的 `Code.gs`**：檔案太大、難以分工與審查
- **只有 `src/`**：不符合作業要求，也無法直接貼進編輯器
