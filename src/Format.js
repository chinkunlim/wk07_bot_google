/**
 * Telegram 訊息格式：Markdown → Telegram HTML、長訊息切段、HTML 退回純文字
 * (逐行移植自 bot/handler.py 的 markdown_to_html / split_message / html_to_plain)
 */

// Telegram 單則訊息上限 4096 字元，保留緩衝
const TELEGRAM_MAX_LENGTH = 4000;

/** 將 Markdown 轉換為 Telegram 支援的 HTML */
function markdownToHtml(text) {
  if (!text) return '';

  // ===== 階段 0: 保護所有特殊標記 =====
  const protectedMap = {};
  let protId = 0;
  const store = (content) => {
    const key = `__PROTECTED_${protId}__`;
    protId += 1;
    protectedMap[key] = content;
    return key;
  };
  const protect = (match) => store(match);

  // 保護程式碼區塊
  text = text.replace(/```[\s\S]*?```/g, protect);
  // 保護行內程式碼
  text = text.replace(/`[^`\n]+`/g, protect);
  // 保護已有的 Telegram 支援 HTML 標籤 (其餘 < > 如 "5 < 10" 需跳脫)
  text = text.replace(
    /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|tg-spoiler|blockquote)(?:\s[^<>]*)?>/g,
    protect,
  );

  // ===== 階段 1: HTML 跳脫 =====
  text = escapeHtml(text);

  // 保護超連結與網址，避免網址內的 _ * 被斜體/粗體規則破壞
  // [text](url)：文字仍可含粗體，網址直接保護
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, label, url) => `<a href="${store(url)}">${label}</a>`,
  );
  // 純網址 (不在 href="..." 內)
  text = text.replace(/(?<!href=")https?:\/\/[^\s<>()（）。，、；：！？「」]+/g, protect);

  // ===== 階段 2: 處理 Markdown =====
  // 粗體 **text** (處理未閉合)
  const boldCount = (text.match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) text += '**';
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // 斜體 *text* 或 _text_ (Python \w 會比對中文，JS 以 \p{L}\p{N} 對應)
  text = text.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, '$1<i>$2</i>$3');
  text = text.replace(
    new RegExp(`(^|[^_\\p{L}\\p{N}])_([^_\\n]+)_([^_\\p{L}\\p{N}]|$)`, 'gu'),
    '$1<i>$2</i>$3',
  );

  // 標題 # text -> <b>text</b>
  text = text.replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>');

  // 項目符號 - * + 開頭；有縮排 (空白或 tab) 的視為子項目
  text = text.replace(/^[*\-+][ \t]+(.+)$/gm, '• $1');
  text = text.replace(/^[ \t]+[*\-+][ \t]+(.+)$/gm, '    ◦ $1');

  // 分割線
  text = text.replace(/^---+$/gm, '──────────────');

  // ===== 階段 3: 還原受保護內容 =====
  const restoreProtected = (key) => {
    if (!(key in protectedMap)) return key;
    const content = protectedMap[key];
    // 程式碼區塊
    if (content.startsWith('```') && content.endsWith('```')) {
      let code = content.slice(3, -3);
      // 移除語言指定符
      const lines = code.split('\n');
      if (lines.length && lines[0].trim() && !lines[0].trim().includes(' ')) {
        code = lines.slice(1).join('\n');
      }
      return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
    }
    // 行內程式碼
    if (content.startsWith('`') && content.endsWith('`')) {
      return `<code>${escapeHtml(content.slice(1, -1))}</code>`;
    }
    // HTML 標籤、網址直接還原
    return content;
  };

  // 受保護內容可能互相巢狀 (如連結文字含行內程式碼)，重複還原
  for (let i = 0; i < 3; i++) {
    const restored = text.replace(/__PROTECTED_\d+__/g, restoreProtected);
    if (restored === text) break;
    text = restored;
  }

  return text;
}

/** 依換行切割過長訊息，單行超長則硬切 */
function splitMessage(text, limit) {
  limit = limit || TELEGRAM_MAX_LENGTH;
  if (text.length <= limit) return [text];

  const chunks = [];
  let current = '';
  for (let line of text.split('\n')) {
    while (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** 移除 HTML 標籤並還原實體 (HTML 解析失敗時的退路) */
function htmlToPlain(text) {
  return decodeHtmlEntities(String(text).replace(/<[^>]+>/g, ''));
}
