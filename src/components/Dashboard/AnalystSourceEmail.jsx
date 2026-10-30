import React, { useEffect, useRef, useState } from 'react';
import LoadingIndicator from '../common/LoadingIndicator';
import AnalystSourceExcerpt from './AnalystSourceExcerpt';
import { analystWorkspaceApi as api } from '../../services/analyst/analystClient';

const HIT_ID = 'analyst-source-hit';
// The stored email fits the frame's width; past this it would be too small to read, and scrolls instead.
const MIN_SCALE = 0.55;

// Fits the email to the frame and brings its marked ticker a third of the way down.
function frameEmail(frame) {
  const doc = frame?.contentDocument;
  if (!doc?.documentElement) return;
  const width = doc.documentElement.scrollWidth;
  if (width > frame.clientWidth) doc.documentElement.style.zoom = String(Math.max(MIN_SCALE, frame.clientWidth / width));
  const hit = doc.getElementById(HIT_ID);
  const page = doc.scrollingElement || doc.documentElement;
  if (hit && page) page.scrollTop += hit.getBoundingClientRect().top - frame.clientHeight / 3;
}

// The original research email, clipped around the cited ticker. The frame runs
// nothing and loads nothing; its links open in a new tab. Without a stored copy
// the popover keeps the excerpt.
export default function AnalystSourceEmail({ messageId, ticker, title, excerpt, highlightTexts }) {
  const [state, setState] = useState({ status: 'loading' });
  const frame = useRef(null);
  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    api.request(`/source-email/${encodeURIComponent(messageId)}?find=${encodeURIComponent(ticker)}`)
      .then(result => current && setState(typeof result?.html === 'string' ? { status: 'ready', html: result.html } : { status: 'missing' }),
        () => current && setState({ status: 'missing' }));
    return () => { current = false; };
  }, [messageId, ticker]);
  if (state.status === 'loading') return <div className="analyst-source-email is-loading"><LoadingIndicator label="Loading the original email" size="sm" centered /></div>;
  if (state.status === 'missing') return <AnalystSourceExcerpt excerpt={excerpt} highlightTexts={highlightTexts} />;
  return <iframe ref={frame} className="analyst-source-email" title={`Original email: ${title}`} srcDoc={state.html}
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
    onLoad={() => frameEmail(frame.current)} />;
}
