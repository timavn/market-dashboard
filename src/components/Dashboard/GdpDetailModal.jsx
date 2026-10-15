import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import usePageScrollLock from '../../hooks/usePageScrollLock';

export default function GdpDetailModal({ title, children, onClose }) {
  const ref = useRef(null);
  const titleId = useId();
  usePageScrollLock(true);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector('button')?.focus();
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const nodes = [...ref.current.querySelectorAll('button:not([disabled]),a[href],select,[tabindex="0"]')];
      const first = nodes[0]; const last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus?.(); };
  }, [onClose]);
  return createPortal(<div className="pm-gdp-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="pm-gdp-card pm-gdp-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header><h2 id={titleId}>{title}</h2><button type="button" aria-label="Close GDP details" onClick={onClose}>×</button></header>
      <div className="pm-gdp-modal-body">{children}</div>
    </section>
  </div>, document.body);
}
