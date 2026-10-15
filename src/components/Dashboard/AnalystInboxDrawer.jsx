import React from 'react';
import { X } from 'lucide-react';
import AnalystInbox from './AnalystInbox';
import './AnalystInboxDrawer.css';

export default function AnalystInboxDrawer({ findings, error, onCitation, onAcknowledge, onClose }) {
  return <aside id="analyst-inbox-drawer" className="analyst-inbox-drawer" aria-label="Inbox">
    <header className="analyst-inbox-drawer-header">
      <span>Inbox</span>
      <button type="button" aria-label="Close Inbox" onClick={onClose}><X size={15} /></button>
    </header>
    <div className="analyst-inbox-scroll" tabIndex={0} role="region" aria-label="Inbox messages">
      <AnalystInbox findings={findings} error={error} onCitation={onCitation} onAcknowledge={onAcknowledge} />
    </div>
  </aside>;
}
