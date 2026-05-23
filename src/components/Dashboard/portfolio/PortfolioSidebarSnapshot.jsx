import React, { useEffect, useState, useCallback } from 'react';
import { Text } from '@tremor/react';
import DataSourceStatus from '../../common/DataSourceStatus';
import RefreshButton from '../../common/RefreshButton';
import LoadingIndicator from '../../common/LoadingIndicator';
import { MarketDataService } from '../../../services/api/marketDataService';
import { getPortfolioSidebarBanner } from '../../../utils/ibkrConnectionStatus';
import {
  computePortfolioExposure,
  formatExposurePct,
  formatCurrency,
} from '../../../utils/portfolioExposureMetrics';
import {
  saveSelectedAccount,
} from '../../../constants/ibkrAccountStorage';
import { formatIbkrAccountLabel } from '../../../constants/ibkrAccountLabels';
import './PortfolioSidebarSnapshot.css';

function ExposureCell({ label, value, className = '' }) {
  return (
    <div className="portfolio-sidebar-exposure__cell">
      <Text className="portfolio-sidebar-exposure__label">{label}</Text>
      <Text className={`portfolio-sidebar-exposure__value ${className}`.trim()}>{value}</Text>
    </div>
  );
}

const PortfolioSidebarSnapshot = ({
  portfolioData,
  loading = false,
  streamConnected = null,
  selectedAccount,
  onAccountChange,
  onRefresh,
}) => {
  const [accounts, setAccounts] = useState([]);

  const loadAccounts = useCallback(async () => {
    try {
      const status = await MarketDataService.getProviderStatus();
      const list = status?.ibkr?.accounts || status?.portfolio?.ibkr?.accounts || [];
      setAccounts(Array.isArray(list) ? list : []);
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts, portfolioData?.dataSource]);

  const handleAccountSelect = (e) => {
    const acct = e.target.value;
    saveSelectedAccount(acct);
    onAccountChange(acct);
  };

  const exposure = computePortfolioExposure({
    holdings: portfolioData?.holdings || [],
    accountSummary: portfolioData?.accountSummary,
    summary: portfolioData?.summary,
  });

  const currency = portfolioData?.accountSummary?.currency || 'USD';
  const sidebarBanner = getPortfolioSidebarBanner({ portfolioData, selectedAccount });
  const netPctClass =
    exposure.netPct > 0
      ? 'portfolio-sidebar-exposure__value--long'
      : exposure.netPct < 0
        ? 'portfolio-sidebar-exposure__value--short'
        : '';

  return (
    <div className="portfolio-sidebar-snapshot">
      <DataSourceStatus className="mb-3" streamConnected={streamConnected} />

      <div className="portfolio-sidebar-snapshot__account-row">
        <label className="portfolio-sidebar-snapshot__account-label" htmlFor="ibkr-account-select">
          Account
        </label>
        <select
          id="ibkr-account-select"
          className="portfolio-sidebar-snapshot__account-select"
          value={selectedAccount || ''}
          onChange={handleAccountSelect}
          disabled={accounts.length === 0}
        >
          {accounts.length === 0 ? (
            <option value="">No IBKR accounts</option>
          ) : (
            accounts.map(acct => (
              <option key={acct} value={acct}>
                {formatIbkrAccountLabel(acct)}
              </option>
            ))
          )}
        </select>
        <RefreshButton onClick={onRefresh} label="Refresh portfolio" iconOnly />
      </div>

      <div className="portfolio-sidebar-snapshot__header">
        <div>
          <Text className="portfolio-sidebar-snapshot__nlv-label">Net Liquidation</Text>
          <Text className="portfolio-sidebar-snapshot__nlv-value">
            {formatCurrency(exposure.nlv, currency)}
          </Text>
        </div>
        <Text className="portfolio-sidebar-snapshot__updated">
          {portfolioData?.lastUpdated || '—'}
        </Text>
      </div>

      {loading && (
        <div className="portfolio-sidebar-snapshot__loading">
          <LoadingIndicator label="Syncing portfolio…" size="sm" />
        </div>
      )}

      {sidebarBanner && !loading && (
        <Text
          className={
            sidebarBanner.type === 'offline'
              ? 'portfolio-sidebar-snapshot__offline'
              : 'portfolio-sidebar-snapshot__empty-account'
          }
        >
          {sidebarBanner.message}
        </Text>
      )}

      <div className="portfolio-sidebar-exposure">
        <div className="portfolio-sidebar-exposure__grid">
          <ExposureCell label="Gross" value={formatExposurePct(exposure.grossPct)} />
          <ExposureCell
            label="Net"
            value={formatExposurePct(exposure.netPct, { signed: true })}
            className={netPctClass}
          />
          <ExposureCell
            label="Long"
            value={formatExposurePct(exposure.longPct)}
            className="portfolio-sidebar-exposure__value--long"
          />
          <ExposureCell
            label="Short"
            value={formatExposurePct(exposure.shortPct)}
            className="portfolio-sidebar-exposure__value--short"
          />
          <ExposureCell label="Cash" value={formatExposurePct(exposure.cashPct)} />
        </div>
      </div>

      <div className="portfolio-sidebar-snapshot__footer">
        <Text className="portfolio-sidebar-snapshot__footer-note">
          See Portfolio Analysis tab for detailed analysis
        </Text>
      </div>
    </div>
  );
};

export default PortfolioSidebarSnapshot;
