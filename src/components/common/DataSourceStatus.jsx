import React, { useState, useEffect, useCallback } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import { getIbkrConnectionDisplay } from '../../utils/ibkrConnectionStatus';
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

function sanitizeStatusWarning(warning, portfolioSource) {
  if (!warning) return null;
  if (
    portfolioSource === 'ibkr_api' &&
    /Upload has|uploaded statement does not|Quantity mismatch|Market value mismatch/i.test(warning)
  ) {
    return null;
  }
  if (warning.length > 120) {
    return `${warning.slice(0, 117)}…`;
  }
  return warning;
}

const DataSourceStatus = ({ className = '', streamConnected = null }) => {
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
  const connection = getIbkrConnectionDisplay({ status, error });
  const streamMode = status?.ibkr?.streamMode;
  const lastQuote = status?.ibkr?.lastQuoteAt;
  const lastPortfolio = status?.ibkr?.lastPortfolioAt;
  const portfolioSource = status?.portfolio?.dataSource;
  const marketSource = status?.market?.lastSource;
  const marketWarning = sanitizeStatusWarning(status?.market?.lastWarning, portfolioSource);
  const portfolioWarning = sanitizeStatusWarning(status?.portfolio?.lastWarning, portfolioSource);

  const gatewayTitle = connection.title;
  const ibkrStatusLabel = connection.label;
  const connectionWarning = connection.warn;

  const streamLabel =
    streamConnected === true
      ? 'ws'
      : streamConnected === false
        ? 'poll'
        : streamMode || '—';

  const streamTitle =
    streamConnected === true
      ? 'Live quote WebSocket active'
      : streamConnected === false
        ? 'Using REST polling for quotes'
        : 'Quote streaming status';

  const hasWarning = Boolean(marketWarning || portfolioWarning || connectionWarning);

  return (
    <div
      className={`data-source-status ${hasWarning ? 'data-source-status--warning' : ''} ${className}`.trim()}
    >
      <span
        className={`data-source-status__dot ${ibkrConnected ? 'data-source-status__dot--ok' : 'data-source-status__dot--off'}`}
        title={gatewayTitle}
      />
      <span title={gatewayTitle}>IBKR {ibkrStatusLabel}</span>
      <span className="data-source-status__badge" title="Last market quote provider (equities, indices, etc.)">
        quotes: {marketSource || '—'}
      </span>
      <span className="data-source-status__badge" title={streamTitle}>
        stream: {streamLabel}
      </span>
      <span
        className="data-source-status__badge"
        title="Portfolio snapshot source (positions, NLV, exposure bar)"
      >
        portfolio: {portfolioSource || '—'}
      </span>
      <span title="Last IBKR market quote">Q {formatTime(lastQuote)}</span>
      <span title="Last IBKR portfolio sync">P {formatTime(lastPortfolio)}</span>
      <RefreshButton onClick={load} label="Refresh status" iconOnly />
      {(marketWarning || portfolioWarning || connectionWarning) && (
        <span className="data-source-status__warn">
          {[marketWarning, portfolioWarning, connectionWarning].filter(Boolean).join(' · ')}
        </span>
      )}
    </div>
  );
};

export default DataSourceStatus;
