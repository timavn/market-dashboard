import React, { useState, useEffect, useCallback } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import RefreshButton from './RefreshButton';
import './DataSourceStatus.css';

const POLL_MS = 45000;

function formatTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

const DataSourceStatus = ({ className = '' }) => {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await MarketDataService.getProviderStatus();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const ibkrConnected = status?.ibkr?.connected;
  const lastQuote = status?.ibkr?.lastQuoteAt;
  const lastPortfolio = status?.ibkr?.lastPortfolioAt;
  const marketSource = status?.market?.lastSource;
  const marketWarning = status?.market?.lastWarning;
  const portfolioSource = status?.portfolio?.dataSource;
  const portfolioWarning = status?.portfolio?.lastWarning;

  const hasWarning = Boolean(marketWarning || portfolioWarning || error);

  return (
    <div
      className={`data-source-status ${hasWarning ? 'data-source-status--warning' : ''} ${className}`.trim()}
    >
      <span
        className={`data-source-status__dot ${ibkrConnected ? 'data-source-status__dot--ok' : 'data-source-status__dot--off'}`}
        title={ibkrConnected ? 'IBKR connected' : 'IBKR disconnected'}
      />
      <span>IBKR {ibkrConnected ? 'connected' : 'offline'}</span>
      <span className="data-source-status__badge" title="Market quote source">
        quotes: {marketSource || '—'}
      </span>
      <span className="data-source-status__badge" title="Portfolio position source">
        portfolio: {portfolioSource || '—'}
      </span>
      <span title="Last IBKR quote">Q {formatTime(lastQuote)}</span>
      <span title="Last IBKR portfolio sync">P {formatTime(lastPortfolio)}</span>
      <RefreshButton onClick={load} label="Refresh status" iconOnly />
      {(marketWarning || portfolioWarning || error) && (
        <span className="data-source-status__warn">
          {[marketWarning, portfolioWarning, error].filter(Boolean).join(' · ')}
        </span>
      )}
    </div>
  );
};

export default DataSourceStatus;
