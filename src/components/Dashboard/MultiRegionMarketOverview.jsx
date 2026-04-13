import React, { useState, useEffect } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import { USDMarketService } from '../../services/api/usdMarketService';
import MarketVolumeTable from './MarketVolumeTable';
import { VolatilityTableWithTabs } from './VolatilityTable';
import USDCorrelationMatrix from './USDCorrelationMatrix';
import { US_MARKET_HOLIDAYS, UK_MARKET_HOLIDAYS, JP_MARKET_HOLIDAYS, isMarketHoliday } from '../../constants/globalMarkets';
import StatusDot from '../common/StatusDot';
import { getMinTimestamp, getSourceFreshness, SOURCE_POLL_INTERVALS } from '../../utils/timeUtils';
import { REFRESH_INTERVALS as USD_REFRESH_INTERVALS } from '../../constants/usdMarket';
import './MultiRegionMarketOverview.css';

// Helper to check if a date is a US market holiday
const isUSHoliday = (date) => isMarketHoliday(date, US_MARKET_HOLIDAYS);
const isUKHoliday = (date) => isMarketHoliday(date, UK_MARKET_HOLIDAYS);
const isJPHoliday = (date) => isMarketHoliday(date, JP_MARKET_HOLIDAYS);

// Market status types: 'open', 'extended', 'closed', 'holiday'
// Extended hours = pre-market (4:00-9:30 AM ET) and post-market (4:00-8:00 PM ET) for US markets
const getMarketStatus = (region) => {
  const now = new Date();

  switch (region) {
    case 'US': {
      const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const dayOfWeek = etTime.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return 'closed';
      // Check for US holidays
      if (isUSHoliday(etTime)) return 'holiday';
      const currentTime = etTime.getHours() + etTime.getMinutes() / 60;
      // Regular hours: 9:30 AM - 4:00 PM ET
      if (currentTime >= 9.5 && currentTime < 16) return 'open';
      // Pre-market: 4:00 AM - 9:30 AM ET
      if (currentTime >= 4 && currentTime < 9.5) return 'extended';
      // Post-market: 4:00 PM - 8:00 PM ET
      if (currentTime >= 16 && currentTime < 20) return 'extended';
      return 'closed';
    }
    case 'Europe': {
      const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
      const dayOfWeek = londonTime.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return 'closed';
      // Check for UK holidays
      if (isUKHoliday(londonTime)) return 'holiday';
      const currentTime = londonTime.getHours() + londonTime.getMinutes() / 60;
      // Regular hours: 8:00 AM - 4:30 PM GMT
      if (currentTime >= 8 && currentTime < 16.5) return 'open';
      return 'closed';
    }
    case 'Asia': {
      const tokyoTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const dayOfWeek = tokyoTime.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return 'closed';
      // Check for Japanese holidays
      if (isJPHoliday(tokyoTime)) return 'holiday';
      const currentTime = tokyoTime.getHours() + tokyoTime.getMinutes() / 60;
      // Regular hours: 9:00 AM - 3:00 PM JST
      if (currentTime >= 9 && currentTime < 15) return 'open';
      return 'closed';
    }
    case 'Cryptocurrencies': {
      return 'open'; // Crypto markets are 24/7
    }
    case 'Rates': {
      // Bond markets follow US market hours and holidays
      const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const dayOfWeek = etTime.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return 'closed';
      if (isUSHoliday(etTime)) return 'holiday';
      const currentTime = etTime.getHours() + etTime.getMinutes() / 60;
      if (currentTime >= 9.5 && currentTime < 16) return 'open';
      return 'closed';
    }
    case 'Commodities': {
      // Commodities trade extended hours, follow US holidays
      const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const dayOfWeek = etTime.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return 'closed';
      if (isUSHoliday(etTime)) return 'holiday';
      const currentTime = etTime.getHours() + etTime.getMinutes() / 60;
      // Core hours: 9:30 AM - 4:00 PM ET
      if (currentTime >= 9.5 && currentTime < 16) return 'open';
      // Extended hours for commodities (futures trade nearly 24 hours on weekdays)
      if (currentTime >= 6 && currentTime < 9.5) return 'extended';
      if (currentTime >= 16 && currentTime < 17) return 'extended';
      return 'closed';
    }
    case 'Currencies': {
      // Forex is 24/5 (closed weekends)
      const dayOfWeek = now.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return 'closed';
      return 'open';
    }
    default:
      return 'closed';
  }
};

/** Intensity 0–1 for heatmap backgrounds (day % now; weekly/monthly/ytd later). */
const HEAT_CAP_PCT = 15;

function pctHeatProps(pctNum) {
  if (!Number.isFinite(pctNum)) {
    return { className: 'region-mw-heat--na', style: {} };
  }
  const sign = pctNum >= 0 ? 'pos' : 'neg';
  const intensity = Math.min(Math.abs(pctNum) / HEAT_CAP_PCT, 1);
  return {
    className: `region-mw-heat--${sign}`,
    style: { '--heat': intensity }
  };
}

function formatPeriodPct(val) {
  if (val == null || !Number.isFinite(Number(val))) return '—';
  const n = Number(val);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

// Main market regions configuration (for 3x2 grid with full charts)
const MAIN_MARKET_REGIONS = {
  us: {
    label: 'US',
    regionKey: 'US',
    indices: [
      { symbol: 'SPY', name: 'S&P 500' },
      { symbol: 'DJI', name: 'Dow 30' },
      { symbol: 'IXIC', name: 'Nasdaq' },
      { symbol: 'RUT', name: 'Russell' },
      { symbol: 'QQQ', name: 'QQQ' },
      { symbol: 'RSP', name: 'EW S&P' }
    ]
  },
  europe: {
    label: 'Europe',
    regionKey: 'Europe',
    indices: [
      { symbol: 'FTSE', name: 'FTSE 100' },
      { symbol: 'CAC', name: 'CAC 40' },
      { symbol: 'DAX', name: 'DAX' },
      { symbol: 'N100', name: 'Euronext 100' },
      { symbol: 'EURUSD', name: 'EUR/USD' },
      { symbol: 'GBPUSD', name: 'GBP/USD' }
    ]
  },
  asia: {
    label: 'Asia',
    regionKey: 'Asia',
    indices: [
      { symbol: 'N225', name: 'Nikkei 225' },
      { symbol: 'HSI', name: 'Hang Seng' },
      { symbol: 'SSEC', name: 'Shanghai' },
      { symbol: 'AXJO', name: 'ASX 200' },
      { symbol: 'USDJPY', name: 'USD/JPY' },
      { symbol: 'USDCNY', name: 'USD/CNY' }
    ]
  },
  crypto: {
    label: 'Crypto',
    regionKey: 'Cryptocurrencies',
    indices: [
      { symbol: 'BTC', name: 'Bitcoin' },
      { symbol: 'ETH', name: 'Ethereum' },
      { symbol: 'BNB', name: 'BNB' },
      { symbol: 'ADA', name: 'Cardano' },
      { symbol: 'SOL', name: 'Solana' },
      { symbol: 'XRP', name: 'XRP' }
    ]
  },
  rates: {
    label: 'Rates',
    regionKey: 'Rates',
    indices: [
      { symbol: 'UST2Y', name: '2-Yr' },
      { symbol: 'UST5Y', name: '5-Yr' },
      { symbol: 'UST10Y', name: '10-Yr' },
      { symbol: 'UST30Y', name: '30-Yr' },
      { symbol: 'UST13W', name: '13-Wk' },
      { symbol: 'FEDFUNDS', name: 'Fed Funds' }
    ]
  },
  commodities: {
    label: 'Commodities',
    regionKey: 'Commodities',
    indices: [
      { symbol: 'BZ', name: 'Brent' },
      { symbol: 'CL', name: 'WTI' },
      { symbol: 'GC', name: 'Gold' },
      { symbol: 'SI', name: 'Silver' },
      { symbol: 'HG', name: 'Copper' },
      { symbol: 'PL', name: 'Platinum' }
    ]
  }
};

// Currencies configuration (for mini cards in secondary section)
const CURRENCIES_CONFIG = {
  label: 'Currencies',
  tradingHours: 'Sun 5PM - Fri 5PM EST',
  indices: [
    { symbol: 'EURUSD', name: 'EUR/USD' },
    { symbol: 'USDJPY', name: 'USD/JPY' },
    { symbol: 'GBPUSD', name: 'GBP/USD' },
    { symbol: 'AUDUSD', name: 'AUD/USD' },
    { symbol: 'USDCAD', name: 'USD/CAD' },
    { symbol: 'USDMXN', name: 'USD/MXN' },
    { symbol: 'USDCHF', name: 'USD/CHF' },
    { symbol: 'NZDUSD', name: 'NZD/USD' },
    { symbol: 'USDCNY', name: 'USD/CNY' },
    { symbol: 'EURGBP', name: 'EUR/GBP' },
    { symbol: 'USD', name: 'DXY' },
    { symbol: 'UUP', name: 'UUP' }
  ]
};

// VolumeCard - standalone card (styled like region panels)
function VolumeCard() {
  const [volLastUpdated, setVolLastUpdated] = React.useState(null);
  const [volStatus, setVolStatus] = React.useState('defective');

  const handleVolumeSourcesChange = React.useCallback((sources) => {
    const primarySource = Array.isArray(sources) ? sources[0] : null;
    setVolStatus(primarySource?.status || 'defective');
  }, []);

  return (
    <div className="secondary-card volume-card">
      <div className="region-chart-header">
        <StatusDot
          updatedAt={volLastUpdated}
          status={volStatus}
          size={10}
          className="mr-1"
          label="Volume"
          showDateOnly
        />
        <span className="region-label">Volume</span>
      </div>
      <MarketVolumeTable
        onLastUpdatedChange={setVolLastUpdated}
        onSourcesChange={handleVolumeSourcesChange}
      />
    </div>
  );
}

// USD Correlation card - same dimensions as Volatility card
function USDCorrelationCard({ correlations, rollingStats, correlationsTimestamp, calculationDate, loading, error }) {
  return (
    <div className="secondary-card usd-correlation-card">
      <USDCorrelationMatrix
        correlations={correlations}
        rollingStats={rollingStats}
        correlationsTimestamp={correlationsTimestamp}
        calculationDate={calculationDate}
        loading={loading}
        error={error}
      />
    </div>
  );
}

// VolatilityCard - standalone card (styled like region panels)
function VolatilityCard() {
  const [usStatus, setUsStatus] = React.useState('closed');
  React.useEffect(() => {
    const update = () => setUsStatus(getMarketStatus('US'));
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, []);
  const statusIndicator = usStatus === 'open' || usStatus === 'extended'
    ? { emoji: '🟢', title: usStatus === 'open' ? 'Market open' : 'Extended hours' }
    : { emoji: '🔴', title: 'Market closed' };

  return (
    <div className="secondary-card volatility-card">
      <VolatilityTableWithTabs statusIndicator={statusIndicator} />
    </div>
  );
}

// RegionChartPanel — full-width metrics table (charts may return later)
function RegionChartPanel({ region, regionKey, data, loading }) {
  const { label, indices, regionKey: marketRegionKey } = region;
  const tableIndices = React.useMemo(() => indices.slice(0, 12), [indices]);
  const isRates = marketRegionKey === 'Rates';

  const formatTablePrice = React.useCallback(
    (rawPrice, { suffix = '' } = {}) => {
      if (rawPrice == null || rawPrice === '' || rawPrice === '--') return '—';
      const num =
        typeof rawPrice === 'number'
          ? rawPrice
          : parseFloat(String(rawPrice).replace(/[^0-9.-]/g, ''));
      if (!Number.isFinite(num)) return '—';

      return (
        new Intl.NumberFormat('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(num) + suffix
      );
    },
    []
  );

  // Track market status with updates
  const [marketStatus, setMarketStatus] = React.useState('closed');

  React.useEffect(() => {
    const updateStatus = () => {
      setMarketStatus(getMarketStatus(marketRegionKey));
    };
    updateStatus();
    const interval = setInterval(updateStatus, 60000); // Update every minute
    return () => clearInterval(interval);
  }, [marketRegionKey]);

  // Get status indicator emoji and title
  const getStatusIndicator = () => {
    switch (marketStatus) {
      case 'open':
        return { emoji: '🟢', title: 'Market open' };
      case 'extended':
        return { emoji: '🔵', title: 'Extended hours trading (pre/post market)' };
      case 'holiday':
        return { emoji: '🔴', title: 'Market closed - Holiday' };
      default:
        return { emoji: '🔴', title: 'Market closed' };
    }
  };

  const statusIndicator = getStatusIndicator();

  // Oldest timestamp across all quotes in this region
  const regionLastUpdated = React.useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return null;
    const timestamps = data
      .map((d) => d?.lastUpdated || d?.timestamp || d?.chartUpdatedAt)
      .filter(Boolean);
    return getMinTimestamp(timestamps);
  }, [data]);

  // Per-index source breakdown for this region (one entry per symbol)
  const regionSources = React.useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];
    const interval = SOURCE_POLL_INTERVALS.multiRegionQuotes;
    return tableIndices
      .map((idx) => {
        const idxQuote = data.find(d => d.symbol === idx.symbol);
        const ts = idxQuote?.lastUpdated || idxQuote?.timestamp || idxQuote?.chartUpdatedAt;
        if (!ts) return null;
        return {
          id: idx.symbol,
          label: `${idx.name} (${idx.symbol})`,
          updatedAt: ts,
          status: getSourceFreshness(ts, interval)
        };
      })
      .filter(Boolean);
  }, [data, tableIndices]);

  const getRowMetrics = (symbol) => {
    const indexQuote = data?.find((d) => d.symbol === symbol);
    const pctRaw = indexQuote?.changePercent;
    const pctNum = parseFloat(String(pctRaw ?? '').replace(/[^0-9.-]/g, ''));
    const chgRaw = indexQuote?.change;
    const chgNum = parseFloat(String(chgRaw ?? '').replace(/[^0-9.-]/g, ''));
    const hasPct = Number.isFinite(pctNum);
    const hasChg = Number.isFinite(chgNum);
    const isPositive = hasPct ? pctNum >= 0 : hasChg ? chgNum >= 0 : null;
    const priceStr = formatTablePrice(indexQuote?.price, {
      suffix: isRates ? '%' : ''
    });
    const pctStr = hasPct
      ? `${pctNum > 0 ? '+' : ''}${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(pctNum)}%`
      : '—';
    const dayDisplay =
      hasChg && isPositive != null
        ? `${isPositive ? '▲' : '▼'} ${new Intl.NumberFormat('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 4
          }).format(Math.abs(chgNum))}`
        : '—';

    const w = indexQuote?.weekChangePct;
    const mo = indexQuote?.monthChangePct;
    const ytd = indexQuote?.ytdChangePct;
    const weekNum = w == null || w === '' ? NaN : Number(w);
    const monthNum = mo == null || mo === '' ? NaN : Number(mo);
    const ytdNum = ytd == null || ytd === '' ? NaN : Number(ytd);

    return {
      priceStr,
      pctStr,
      dayDisplay,
      pctNum,
      isPositive,
      indexQuote,
      weekStr: formatPeriodPct(w),
      monthStr: formatPeriodPct(mo),
      ytdStr: formatPeriodPct(ytd),
      weekNum: Number.isFinite(weekNum) ? weekNum : null,
      monthNum: Number.isFinite(monthNum) ? monthNum : null,
      ytdNum: Number.isFinite(ytdNum) ? ytdNum : null
    };
  };

  return (
    <div className={`region-chart-panel region-chart-panel--${regionKey} region-chart-panel--mw`}>
      <div className="region-chart-header region-chart-header--mw">
        <div className="region-header-left">
          <StatusDot
            updatedAt={regionLastUpdated}
            status={statusIndicator.emoji === '🟢' ? 'active' : statusIndicator.emoji === '🔵' ? 'stale' : 'inactive'}
            size={10}
            className="mr-1"
            label={`${label} region`}
            emoji={statusIndicator.emoji}
            sources={regionSources}
          />
          <span className="region-label">{label}</span>
        </div>
      </div>
      <div className="region-mw-body">
        <div className="region-mw-table-wrap">
          <table className="region-mw-quotes-table">
            <thead>
              <tr>
                <th className="region-mw-th region-mw-th-trend" aria-hidden="true" />
                <th className="region-mw-th region-mw-th-name" scope="col" />
                <th className="region-mw-th region-mw-th-num region-mw-th-price" scope="col">
                  {isRates ? 'YIELD' : 'PRICE'}
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-day" scope="col">
                  DAY
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  %
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  WEEKLY
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  MONTHLY
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  YTD
                </th>
              </tr>
            </thead>
            <tbody>
              {tableIndices.map((idx) => {
                const m = getRowMetrics(idx.symbol);
                const dirUp = m.isPositive === true;
                const dirDown = m.isPositive === false;
                const pctHeat = loading
                  ? { className: 'region-mw-heat--na', style: {} }
                  : pctHeatProps(m.pctNum);
                const weekHeat = loading
                  ? { className: 'region-mw-heat--na', style: {} }
                  : pctHeatProps(m.weekNum);
                const monthHeat = loading
                  ? { className: 'region-mw-heat--na', style: {} }
                  : pctHeatProps(m.monthNum);
                const ytdHeat = loading
                  ? { className: 'region-mw-heat--na', style: {} }
                  : pctHeatProps(m.ytdNum);
                return (
                  <tr key={idx.symbol} className="region-mw-tr">
                    <td className="region-mw-td region-mw-td-trend" aria-hidden="true">
                      {m.isPositive != null && (
                        <span className={dirUp ? 'mw-trend-up' : 'mw-trend-down'}>
                          {dirUp ? '▲' : '▼'}
                        </span>
                      )}
                    </td>
                    <td className="region-mw-td region-mw-td-name">{idx.name}</td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-price ${loading ? '' : m.indexQuote?.price != null ? (dirUp ? 'positive' : dirDown ? 'negative' : '') : ''}`}
                    >
                      {loading ? '…' : m.priceStr}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-day ${loading ? '' : m.isPositive != null ? (dirUp ? 'positive' : 'negative') : ''}`}
                    >
                      {loading ? '…' : m.dayDisplay}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${pctHeat.className}`}
                      style={pctHeat.style}
                    >
                      {loading ? '…' : m.pctStr}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${weekHeat.className}`}
                      style={weekHeat.style}
                    >
                      {loading ? '…' : m.weekStr}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${monthHeat.className}`}
                      style={monthHeat.style}
                    >
                      {loading ? '…' : m.monthStr}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${ytdHeat.className}`}
                      style={ytdHeat.style}
                    >
                      {loading ? '…' : m.ytdStr}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// CurrenciesPanel component - table with Ticker, Price, 1-Day % Chg, MTD/QTD/YTD % Chg
function CurrenciesPanel({ data, loading }) {
  const [currenciesStatus, setCurrenciesStatus] = React.useState('closed');
  React.useEffect(() => {
    const update = () => setCurrenciesStatus(getMarketStatus('Currencies'));
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, []);
  const currStatus = currenciesStatus === 'open'
    ? { emoji: '🟢', title: 'Market open' }
    : { emoji: '🔴', title: 'Market closed' };

  const currenciesLastUpdated = React.useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return null;
    const timestamps = data
      .map((q) => q?.timestamp || q?.lastUpdated)
      .filter(Boolean);
    return getMinTimestamp(timestamps);
  }, [data]);

  const currencySources = React.useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];
    const interval = SOURCE_POLL_INTERVALS.currenciesQuotes || SOURCE_POLL_INTERVALS.multiRegionQuotes;
    return CURRENCIES_CONFIG.indices
      .map((idx) => {
        const idxQuote = data.find(d => d.symbol === idx.symbol);
        const ts = idxQuote?.lastUpdated || idxQuote?.timestamp;
        if (!ts) return null;
        return {
          id: idx.symbol,
          label: `${idx.name} (${idx.symbol})`,
          updatedAt: ts,
          status: getSourceFreshness(ts, interval)
        };
      })
      .filter(Boolean);
  }, [data]);

  const formatPct = (val) => {
    if (val == null || val === '' || val === '--') return '--';
    const num = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
    if (Number.isNaN(num)) return '--';
    return `${num}%`;
  };

  return (
    <div className="currencies-panel">
      <div className="currencies-header">
        <div className="currencies-header-left">
        <StatusDot
          updatedAt={currenciesLastUpdated}
          status={currenciesStatus === 'open' ? 'active' : 'inactive'}
          size={10}
          className="mr-1"
          label="Currencies"
          emoji={currStatus.emoji}
          sources={currencySources}
        />
          <span className="currencies-title">Currencies</span>
        </div>
      </div>
      <div className="currencies-table-wrap">
        <table className="currencies-table">
          <thead>
            <tr>
              <th className="currencies-th currencies-th-ticker">Ticker</th>
              <th className="currencies-th currencies-th-price">Price</th>
              <th className="currencies-th currencies-th-pct">
                <span className="currencies-th-split">1-Day %</span>
                <span className="currencies-th-split">Chg</span>
              </th>
              <th className="currencies-th currencies-th-pct">
                <span className="currencies-th-split">MTD %</span>
                <span className="currencies-th-split">Chg</span>
              </th>
              <th className="currencies-th currencies-th-pct">
                <span className="currencies-th-split">QTD %</span>
                <span className="currencies-th-split">Chg</span>
              </th>
              <th className="currencies-th currencies-th-pct">
                <span className="currencies-th-split">YTD %</span>
                <span className="currencies-th-split">Chg</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {CURRENCIES_CONFIG.indices.map((index) => {
              const quote = data?.find(d => d.symbol === index.symbol);
              const price = loading ? '...' : (quote?.price != null ? String(quote.price) : '--');
              const changePercent = quote?.changePercent;
              const parsedChange = parseFloat(String(changePercent ?? '').replace(/[^0-9.-]/g, ''));
              const isPositive = Number.isFinite(parsedChange) && parsedChange >= 0;
              const hasChange = Number.isFinite(parsedChange);
              return (
                <tr key={index.symbol} className="currencies-tr">
                  <td className="currencies-td currencies-td-ticker">{index.name}</td>
                  <td className="currencies-td currencies-td-price">{price}</td>
                  <td className={`currencies-td currencies-td-pct ${hasChange ? (isPositive ? 'positive' : 'negative') : ''}`}>
                    {loading ? '...' : formatPct(changePercent)}
                  </td>
                  <td className="currencies-td currencies-td-pct">--</td>
                  <td className="currencies-td currencies-td-pct">--</td>
                  <td className="currencies-td currencies-td-pct">--</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Main MultiRegionMarketOverview component
export default function MultiRegionMarketOverview() {
  const [marketData, setMarketData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // USD correlation data for the USD Correlation card (right stack)
  const [correlationData, setCorrelationData] = useState({
    correlations: null,
    rollingStats: null,
    correlationsTimestamp: null,
    calculationDate: null
  });
  const [correlationLoading, setCorrelationLoading] = useState(true);
  const [correlationError, setCorrelationError] = useState(null);

  useEffect(() => {
    fetchMarketData();
    const interval = setInterval(fetchMarketData, 30000); // 30s polling to reduce provider throttling
    return () => clearInterval(interval);
  }, []);

  // Fetch USD correlation data for the USD Correlation card
  useEffect(() => {
    let cancelled = false;
    const fetchCorrelations = async () => {
      try {
        setCorrelationError(null);
        const data = await USDMarketService.getCorrelations();
        if (cancelled) return;
        setCorrelationData({
          correlations: data.correlations ?? null,
          rollingStats: data.rollingStats ?? null,
          correlationsTimestamp: data.timestamp ?? null,
          calculationDate: data.calculationDate ?? null
        });
      } catch (err) {
        if (!cancelled) {
          setCorrelationError(err.message || 'Failed to load correlation data');
        }
      } finally {
        if (!cancelled) setCorrelationLoading(false);
      }
    };
    fetchCorrelations();
    const interval = setInterval(fetchCorrelations, USD_REFRESH_INTERVALS.CORRELATIONS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const fetchMarketData = async () => {
    try {
      const data = await MarketDataService.getMultiRegionQuotes(null, false, true);
      setMarketData(data);
      setLoading(false);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch multi-region quotes:', err);
      setError(err.message);
      setLoading(false);
    }
  };

  // Map region keys to data keys in marketData
  const getRegionData = (regionKey) => {
    const keyMap = {
      'us': 'us',
      'europe': 'europe',
      'asia': 'asia',
      'crypto': 'crypto',
      'rates': 'rates',
      'commodities': 'commodities'
    };
    return marketData[keyMap[regionKey]];
  };

  return (
    <div className="multi-region-overview">

      {error && (
        <div className="error-message">
          Failed to load market data: {error}
        </div>
      )}

      {/* Main 3x2 Grid of Full Charts */}
      <div className="main-markets-grid">
        {Object.keys(MAIN_MARKET_REGIONS).map((regionKey) => (
          <RegionChartPanel
            key={regionKey}
            region={MAIN_MARKET_REGIONS[regionKey]}
            regionKey={regionKey}
            data={getRegionData(regionKey)}
            loading={loading}
          />
        ))}
      </div>

      {/* Secondary Section - Left: Currencies + Volume; Right: USD Correlations + Volatility */}
      <div className="secondary-markets-section">
        <div className="secondary-left-column">
          <CurrenciesPanel
            data={marketData.currencies}
            loading={loading}
          />
          <VolumeCard />
        </div>
        <div className="secondary-cards-stack">
          <USDCorrelationCard
            correlations={correlationData.correlations}
            rollingStats={correlationData.rollingStats}
            correlationsTimestamp={correlationData.correlationsTimestamp}
            calculationDate={correlationData.calculationDate}
            loading={correlationLoading}
            error={correlationError}
          />
          <VolatilityCard />
        </div>
      </div>
    </div>
  );
}
