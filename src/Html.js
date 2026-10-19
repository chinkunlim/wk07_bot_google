/**
 * HTML 工具：實體解碼、跳脫、去標籤、屬性擷取
 * GAS 沒有 BeautifulSoup / DOM，搜尋結果與網頁內文都用這裡的 regex 工具解析
 */

const HTML_NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  times: '×', divide: '÷', yen: '¥', euro: '€', pound: '£', cent: '¢', deg: '°',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', shy: '',
};

/** 解碼 HTML/XML 實體 (具名、十進位、十六進位)，不認得的保留原樣 */
function decodeHtmlEntities(text) {
  if (!text) return '';
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!code || code > 0x10ffff) return m;
      return String.fromCodePoint(code);
    }
    const named = HTML_NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}

/** Telegram HTML 需要跳脫的三個字元 */
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 去除標籤並解碼實體，空白正規化為單一空格
 * 標籤直接移除不補空格 (同 BeautifulSoup get_text(strip=True))，避免「國立<strong>東華</strong>」變成「國立 東華」
 */
function htmlFragmentText(fragment) {
  if (!fragment) return '';
  const text = decodeHtmlEntities(String(fragment).replace(/<[^>]+>/g, ''));
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 從標籤屬性字串取出屬性值 (支援雙引號、單引號、無引號)，並解碼實體 */
function getHtmlAttr(attrs, name) {
  const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = re.exec(attrs || '');
  if (!m) return '';
  return decodeHtmlEntities(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
}

/** 列出片段中所有 <a>：[{attrs, href, cls, inner}] */
function findAnchors(fragment) {
  const anchors = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(fragment || '')) !== null) {
    anchors.push({
      attrs: m[1],
      href: getHtmlAttr(m[1], 'href'),
      cls: getHtmlAttr(m[1], 'class'),
      inner: m[2],
    });
  }
  return anchors;
}

/** 依 class 名稱找第一個元素的內部 HTML (同名標籤不巢狀時適用) */
function findElementByClass(fragment, className) {
  const re = new RegExp(
    '<([a-z0-9]+)\\b[^>]*class\\s*=\\s*["\'][^"\']*\\b' + className + '\\b[^"\']*["\'][^>]*>([\\s\\S]*?)</\\1>',
    'i',
  );
  const m = re.exec(fragment || '');
  return m ? m[2] : '';
}

/** 把 HTML 依某個開頭標記切成區塊 (每個區塊從該標記之後到下一個標記之前) */
function splitHtmlBlocks(html, startPattern) {
  const parts = String(html || '').split(startPattern);
  return parts.slice(1);
}

/** 截斷摘要 (與 Python 版一致：超過上限加 ...) */
function truncateText(text, limit) {
  return text.length > limit ? text.slice(0, limit) + '...' : text;
}
