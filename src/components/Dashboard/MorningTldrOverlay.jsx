import React, { useEffect, useRef } from 'react';
import MorningTldrPanel from './MorningTldrPanel';
import { useSurfaceActivity } from '../common/PersistentSurface';
import '../Process/ProcessWiki.css';
import './MorningTldrOverlay.css';

const MorningTldrOverlay = ({ onClose, ...panelProps }) => {
  const active = useSurfaceActivity();
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    dialog?.focus();

    const handleKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current?.();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active]);

  return (
    <div className="process-overlay-host morning-tldr-overlay-host" data-testid="morning-tldr-overlay">
      <div
        className="process-overlay-backdrop"
        data-testid="morning-tldr-overlay-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        className="process-overlay-dialog morning-tldr-overlay-dialog"
        data-testid="morning-tldr-window"
        role="dialog"
        aria-label="Morning TL;DR"
        tabIndex={-1}
      >
        <MorningTldrPanel {...panelProps} />
      </section>
    </div>
  );
};

export default MorningTldrOverlay;
