import React from 'react';
import AnalystSpinner from './AnalystSpinner';
import './AnalystLoading.css';

export default function AnalystLoading() {
  return (
    <div className="analyst-loading" role="status" aria-label="Loading" aria-busy="true">
      <AnalystSpinner size={26} elapsed />
    </div>
  );
}
