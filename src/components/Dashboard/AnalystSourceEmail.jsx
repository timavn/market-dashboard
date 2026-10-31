import React, { useEffect, useRef, useState } from 'react';
import LoadingIndicator from '../common/LoadingIndicator';
import AnalystSourceExcerpt from './AnalystSourceExcerpt';
import { analystWorkspaceApi as api } from '../../services/analyst/analystClient';

const HIT_ID = 'analyst-source-hit';
const QUOTE_HIGHLIGHT = 'analyst-source-quote';
// The stored email fits the frame's width; past this it would be too small to read, and scrolls instead.
const MIN_SCALE = 0.55;

// Letters and digits only, so markup, spacing, quotes and dashes never stop a quoted line from matching.
const fold = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
// What to look for, longest first: the whole quote, the quote after a "Label: " the dashboard added,
// then runs of its words, for a line the dashboard trimmed or reworded around the product's own.
function quoteNeedles(quote) {
  const whole = String(quote || '');
  const words = whole.replace(/^[^:]{1,40}:\s+/, '').split(/\s+/).filter(Boolean);
  const runs = [8, 5, 3].flatMap(size => (words.length > size
    ? words.slice(0, words.length - size + 1).map((_word, index) => words.slice(index, index + size).join(' ')) : []));
  return [whole, words.join(' '), ...runs].map(fold).filter((needle, index, all) => needle.length >= 10 && all.indexOf(needle) === index);
}

// The quoted line in the email's visible text, as a range, or null.
export function findQuote(doc, quote) {
  const body = doc?.body;
  if (!body || !quote) return null;
  const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  let text = '';
  const at = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('style, script, title')) continue;
    const value = node.nodeValue;
    for (let index = 0; index < value.length; index += 1) {
      const folded = fold(value[index]);
      if (!folded) continue;
      text += folded;
      for (let count = 0; count < folded.length; count += 1) at.push([node, index]);
    }
  }
  for (const needle of quoteNeedles(quote)) {
    const start = text.indexOf(needle);
    if (start < 0) continue;
    const [first, firstOffset] = at[start];
    const [last, lastOffset] = at[start + needle.length - 1];
    // The line's closing punctuation ("1.1%", "Bearish.") belongs to it.
    let end = lastOffset + 1;
    while (end < last.nodeValue.length && /[^\sa-z0-9]/i.test(last.nodeValue[end])) end += 1;
    const range = doc.createRange();
    range.setStart(first, firstOffset);
    range.setEnd(last, end);
    return range;
  }
  return null;
}

// Fits the email to the frame and brings its marked ticker, or the quoted line, a third of the way down.
function frameEmail(frame, quote) {
  const doc = frame?.contentDocument;
  if (!doc?.documentElement) return;
  const width = doc.documentElement.scrollWidth;
  if (width > frame.clientWidth) doc.documentElement.style.zoom = String(Math.max(MIN_SCALE, frame.clientWidth / width));
  const hit = doc.getElementById(HIT_ID);
  const range = hit ? null : findQuote(doc, quote);
  // The quoted line takes the ticker's highlight where the browser can paint one without changing the email.
  const view = doc.defaultView;
  if (range && view?.CSS?.highlights && view.Highlight) {
    const style = doc.createElement('style');
    style.textContent = `::highlight(${QUOTE_HIGHLIGHT}){background-color:#fde68a;color:#111827}`;
    doc.head?.appendChild(style);
    view.CSS.highlights.set(QUOTE_HIGHLIGHT, new view.Highlight(range));
  }
  const target = hit || range;
  const page = doc.scrollingElement || doc.documentElement;
  if (target && page) page.scrollTop += target.getBoundingClientRect().top - frame.clientHeight / 3;
}

// The original research email, clipped around the cited ticker or the quoted line. The
// frame runs nothing and loads nothing; its links open in a new tab. Without a stored
// copy it shows the fallback, or else the excerpt.
export default function AnalystSourceEmail({ messageId, ticker, quote, title, excerpt, highlightTexts, fallback }) {
  const [state, setState] = useState({ status: 'loading' });
  const frame = useRef(null);
  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    api.request(`/source-email/${encodeURIComponent(messageId)}${ticker ? `?find=${encodeURIComponent(ticker)}` : ''}`)
      .then(result => current && setState(typeof result?.html === 'string' ? { status: 'ready', html: result.html } : { status: 'missing' }),
        () => current && setState({ status: 'missing' }));
    return () => { current = false; };
  }, [messageId, ticker]);
  if (state.status === 'loading') return <div className="analyst-source-email is-loading"><LoadingIndicator label="Loading the original email" size="sm" centered /></div>;
  if (state.status === 'missing') return fallback || <AnalystSourceExcerpt excerpt={excerpt} highlightTexts={highlightTexts} />;
  return <iframe ref={frame} className="analyst-source-email" title={`Original email: ${title}`} srcDoc={state.html}
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
    onLoad={() => frameEmail(frame.current, quote)} />;
}
