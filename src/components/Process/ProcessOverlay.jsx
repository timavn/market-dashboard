import React, { useEffect, useRef } from 'react';
import ProcessPage from './ProcessPage';
import { useSurfaceActivity } from '../common/PersistentSurface';

const ProcessOverlay = ({ documentId, onClose, onNavigate }) => {
  const active = useSurfaceActivity();
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    const searchInput = dialog?.querySelector('input[type="search"]');
    searchInput?.focus();

    const handleKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current?.();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active]);

  return (
    <div className="process-overlay-host" data-testid="process-overlay">
      <div
        className="process-overlay-backdrop"
        data-testid="process-overlay-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        className="process-overlay-dialog"
        role="dialog"
        aria-labelledby="process-overlay-title"
      >
        <ProcessPage
          key={documentId}
          documentId={documentId}
          onNavigate={onNavigate}
        />
      </section>
    </div>
  );
};

export default ProcessOverlay;
