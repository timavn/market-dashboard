import React from 'react';
import './AnalystLoading.css';

export default function AnalystLoading() {
  return (
    <div className="analyst-loading" role="status" aria-label="Loading" aria-busy="true">
      <span className="analyst-loading-ring" aria-hidden="true" />
    </div>
  );
}
