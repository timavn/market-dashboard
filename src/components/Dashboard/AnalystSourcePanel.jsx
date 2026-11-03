import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

// The panel sits in the empty space right of the Analyst window, as tall as it.
const PANEL_WIDTH = 520;
const PANEL_MIN_WIDTH = 320;
const GAP = 12;
const MARGIN = 8;
// One Source reads at a time: opening a panel closes the one another table opened.
let closeShown = null;

// A source read beside the Analyst window, never over or inside what it reads: it mounts in the
// window (so its clicks stay the window's) but is fixed outside it, so nothing in the window moves.
// Without room on the right it lies over the window's right edge. Escape or its button closes it.
export default function AnalystSourcePanel({ host, title, meta, onClose, children }) {
  const panel = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const shut = () => close.current();
    if (closeShown) closeShown();
    closeShown = shut;
    // The Analyst window also closes on Escape; while a Source is open, Escape closes only the Source.
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      shut();
    };
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('keydown', escape, true);
      if (closeShown === shut) closeShown = null;
    };
  }, []);
  useLayoutEffect(() => {
    const surface = panel.current;
    if (!surface || !host) return undefined;
    const place = () => {
      const frame = host.getBoundingClientRect();
      const room = window.innerWidth - frame.right - GAP - MARGIN;
      const beside = room >= PANEL_MIN_WIDTH;
      const width = Math.min(PANEL_WIDTH, beside ? room : window.innerWidth - 2 * MARGIN);
      surface.classList.toggle('is-over', !beside);
      surface.style.width = `${width}px`;
      surface.style.left = `${beside ? frame.right + GAP : window.innerWidth - MARGIN - width}px`;
      surface.style.top = `${frame.top}px`;
      surface.style.height = `${frame.height}px`;
    };
    place();
    // The window resizes from its edge and recenters with the viewport.
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    resized?.observe(host);
    window.addEventListener('resize', place);
    return () => {
      resized?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [host]);
  if (!host) return null;
  return createPortal(<aside ref={panel} className="analyst-source-panel" aria-label={`Source: ${title}`}>
    <header>
      <span><strong>{title}</strong>{meta && <span>{meta}</span>}</span>
      <button type="button" aria-label="Close source" title="Close (Esc)" onClick={() => close.current()}><X size={14} /></button>
    </header>
    <div className="analyst-source-panel__body">{children}</div>
  </aside>, host);
}
