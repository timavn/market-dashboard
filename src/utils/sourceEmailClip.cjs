// The stored copy of a research email, made safe to show inside the Source
// popover: nothing in it runs or loads from the network, links open outside
// the frame, and the first mention of the cited ticker is marked so the
// popover can scroll to it.
const MESSAGE_ID = /^[a-f0-9]{8,32}$/i;
const TERM = /^[A-Z][A-Z0-9.^_-]{0,23}$/;
const HIT_ID = 'analyst-source-hit';

const HEAD = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><base target="_blank">`
  + `<style>html,body{margin:0}#${HIT_ID}{background:#fde68a;color:#111827;outline:2px solid #f59e0b;border-radius:2px}</style>`;
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function sanitizeEmailHtml(html) {
  return String(html || '')
    .replace(/<(script|iframe|object|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:script|iframe|object|embed|link|img|picture|source|video|audio|form|input|button|base|frame|frameset)\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/\s(?:on[a-z]+|srcset|background|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*(["']?)\s*(?:javascript|vbscript|data):[^"'\s>]*\2/gi, ' $1="#"')
    .replace(/url\(\s*[^)]*\)/gi, 'none')
    .replace(/@import[^;]*;?/gi, '');
}

// Marks the first visible mention: text between tags, outside head, style and title.
function markFirstMention(html, term) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9])(${escapeRegExp(term)})(?![A-Za-z0-9])`);
  const parts = html.split(/(<[^>]*>)/);
  let hidden = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.startsWith('<')) {
      if (/^<(head|style|title)\b/i.test(part)) hidden += 1;
      else if (/^<\/(head|style|title)\s*>/i.test(part)) hidden = Math.max(0, hidden - 1);
      continue;
    }
    if (hidden || !pattern.test(part)) continue;
    parts[index] = part.replace(pattern, `$1<mark id="${HIT_ID}">$2</mark>`);
    return { html: parts.join(''), found: true };
  }
  return { html, found: false };
}

function sourceEmailClip(html, term) {
  const safe = sanitizeEmailHtml(html);
  const marked = TERM.test(term || '') ? markFirstMention(safe, term) : { html: safe, found: false };
  const document = /<head\b[^>]*>/i.test(marked.html) ? marked.html.replace(/<head\b[^>]*>/i, match => `${match}${HEAD}`)
    : `<!doctype html><html><head>${HEAD}</head><body>${marked.html}</body></html>`;
  return { html: document, found: marked.found };
}

// The message's HTML body among its ledger rows: the first body part that was stored.
function emailBodyItem(items = []) {
  return items.filter(item => String(item.mimeType || '').toLowerCase() === 'text/html' && item.s3Key
    && String(item.attachmentId || '').startsWith('message-body-html'))
    .sort((a, b) => String(a.attachmentId).localeCompare(String(b.attachmentId)))[0] || null;
}

module.exports = { MESSAGE_ID, TERM, HIT_ID, sanitizeEmailHtml, markFirstMention, sourceEmailClip, emailBodyItem };
