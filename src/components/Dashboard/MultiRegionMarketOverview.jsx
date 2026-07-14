import React from 'react';
import { BarChart2 } from 'lucide-react';
import MarketVolumeTable from './MarketVolumeTable';
import { VolatilityTableWithTabs } from './VolatilityTable';
import USDCorrelationMatrix from './USDCorrelationMatrix';
import { US_MARKET_HOLIDAYS, UK_MARKET_HOLIDAYS, JP_MARKET_HOLIDAYS, isMarketHoliday } from '../../constants/globalMarkets';
import StatusDot from '../common/StatusDot';
import { getMinTimestamp, getSourceFreshness, SOURCE_POLL_INTERVALS } from '../../utils/timeUtils';
import useUsdCorrelations from '../../hooks/useUsdCorrelations';
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
  if (val == null) return '—';
  const s = String(val).trim();
  if (s === '') return '—';
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

/** Currencies compact rail: suffix % on numeric period cells (— unchanged). */
function formatCurrenciesPeriodCell(val) {
  const s = formatPeriodPct(val);
  return s === '—' ? '—' : `${s}%`;
}

// Same shape as `formatPeriodPct` but renders bps deltas (used by derived
// curve-spread rows like 2s10s / 5s30s / 3M10Y). Unit suffix is omitted
// because it's already shown in the YIELD column for these rows.
function formatPeriodBps(val) {
  if (val == null) return '—';
  const s = String(val).trim();
  if (s === '') return '—';
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
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
  }
};

// Currencies configuration (shared by regional rail panel)
const CURRENCIES_CONFIG = {
  label: 'Currencies',
  tradingHours: 'Sun 5PM - Fri 5PM EST',
  indices: [
    { symbol: 'USD', name: 'DXY' },
    { symbol: 'UUP', name: 'UUP' },
    { symbol: 'EURUSD', name: 'EUR/USD' },
    { symbol: 'USDJPY', name: 'USD/JPY' },
    { symbol: 'GBPUSD', name: 'GBP/USD' },
    { symbol: 'AUDUSD', name: 'AUD/USD' },
    { symbol: 'USDCAD', name: 'USD/CAD' },
    { symbol: 'USDMXN', name: 'USD/MXN' },
    { symbol: 'USDCHF', name: 'USD/CHF' },
    { symbol: 'NZDUSD', name: 'NZD/USD' },
    { symbol: 'USDCNY', name: 'USD/CNY' },
    { symbol: 'EURGBP', name: 'EUR/GBP' }
  ]
};

// Sectors configuration
const SECTORS_CONFIG = {
  label: 'Sectors',
  indices: [
    { symbol: 'SPX', name: 'S&P 500' },
    { symbol: 'XLY', name: 'Cons Discretionary' },
    { symbol: 'XLF', name: 'Financials' },
    { symbol: 'XLV', name: 'Health Care' },
    { symbol: 'XLK', name: 'Technology' },
    { symbol: 'XLP', name: 'Cons Staples' },
    { symbol: 'XLI', name: 'Industrials' },
    { symbol: 'XLB', name: 'Materials' },
    { symbol: 'XLE', name: 'Energy' },
    { symbol: 'XLU', name: 'Utilities' },
    { symbol: 'XLRE', name: 'Real Estate' },
    { symbol: 'XLC', name: 'Communication' }
  ]
};

// Compact Currencies panel: regional header + slim MTD/QTD/YTD table (sidebar or legacy rail layout)
export function CurrenciesCompactRail({ data, loading, layout = 'rail' }) {
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
        const idxQuote = data.find((d) => d.symbol === idx.symbol);
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

  const pctHeatFxDay = (val) => {
    const numeric = Number(String(val ?? '').replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(numeric)) return { className: 'region-mw-heat--na', style: {} };
    const intensity = Math.min(Math.abs(numeric) / 2, 1);
    return {
      className: `region-mw-heat--${numeric >= 0 ? 'pos' : 'neg'}`,
      style: { '--heat': intensity }
    };
  };

  const formatPctDisplay = (val) => {
    if (val == null || val === '' || val === '--') return '--';
    const num = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
    if (Number.isNaN(num)) return '--';
    return `${num}%`;
  };

  const tableRef = React.useRef(null);
  useAutoFitTable(tableRef, [data, loading]);

  return (
    <div
      className={`region-chart-panel region-chart-panel--mw currencies-compact-rail${layout === 'sidebar' ? ' currencies-compact-rail--in-sidebar' : ''}`}
    >
        <div className="region-chart-header region-chart-header--mw">
        <div className="region-header-left">
          <span className="card-header-icon card-header-icon--green" aria-hidden="true">
            <img
              src="/assets/ben-franklin-100.jpg"
              alt=""
              className="currency-header-portrait"
            />
          </span>
          <span className="region-label region-label--lg">Currencies</span>
        </div>
        <div className="region-header-status">
          <StatusDot
            updatedAt={currenciesLastUpdated}
            status={currenciesStatus === 'open' ? 'active' : 'inactive'}
            size={8}
            label="Currencies"
            emoji={currStatus.emoji}
            sources={currencySources}
          />
        </div>
      </div>
      <div className="region-mw-body currencies-compact-rail__body">
        <div className="region-mw-table-wrap currencies-rail-table-wrap">
          <table ref={tableRef} className="region-mw-quotes-table currencies-mw-table currencies-rail-table">
            <thead>
              <tr>
                <th className="region-mw-th region-mw-th-name" scope="col">
                  TICKER
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-price" scope="col">
                  PRICE
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col" title="Day % change">
                  %
                </th>
                <th
                  className="region-mw-th region-mw-th-num region-mw-th-metric"
                  scope="col"
                  title="30 trading sessions (~6 weeks rolling)."
                >
                  30D
                </th>
                <th
                  className="region-mw-th region-mw-th-num region-mw-th-metric"
                  scope="col"
                  title="90 trading sessions (~4 months rolling)."
                >
                  90D
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  YTD
                </th>
              </tr>
            </thead>
            <tbody>
              {CURRENCIES_CONFIG.indices.map((index) => {
                const quote = data?.find((d) => d.symbol === index.symbol);
                const price = loading ? '…' : (quote?.price != null ? String(quote.price) : '—');
                const changePercent = quote?.changePercent;
                const parsedChange = parseFloat(String(changePercent ?? '').replace(/[^0-9.-]/g, ''));
                const isPositive = Number.isFinite(parsedChange) && parsedChange >= 0;
                const hasChange = Number.isFinite(parsedChange);
                const heat = loading ? { className: 'region-mw-heat--na', style: {} } : pctHeatFxDay(changePercent);

                const thirtyRaw = quote?.thirtyDayChangePct;
                const ninetyRaw = quote?.ninetyDayChangePct;
                const ytdRaw = quote?.ytdChangePct;
                const thirtyNum = thirtyRaw == null || thirtyRaw === '' ? NaN : Number(thirtyRaw);
                const ninetyNum = ninetyRaw == null || ninetyRaw === '' ? NaN : Number(ninetyRaw);
                const ytdNum = ytdRaw == null || ytdRaw === '' ? NaN : Number(ytdRaw);
                const thirtyHeat = loading ? { className: 'region-mw-heat--na', style: {} } : pctHeatProps(thirtyNum);
                const ninetyHeat = loading ? { className: 'region-mw-heat--na', style: {} } : pctHeatProps(ninetyNum);
                const ytdHeat = loading ? { className: 'region-mw-heat--na', style: {} } : pctHeatProps(ytdNum);

                return (
                  <tr key={index.symbol} className="region-mw-tr">
                    <td className="region-mw-td region-mw-td-name">{index.name}</td>
                    <td className="region-mw-td region-mw-td-num region-mw-td-price">{price}</td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${heat.className} ${hasChange ? (isPositive ? 'positive' : 'negative') : ''}`}
                      style={heat.style}
                    >
                      {loading ? '…' : formatPctDisplay(changePercent)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${thirtyHeat.className}`}
                      style={thirtyHeat.style}
                    >
                      {loading ? '…' : formatCurrenciesPeriodCell(thirtyRaw)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${ninetyHeat.className}`}
                      style={ninetyHeat.style}
                    >
                      {loading ? '…' : formatCurrenciesPeriodCell(ninetyRaw)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${ytdHeat.className}`}
                      style={ytdHeat.style}
                    >
                      {loading ? '…' : formatCurrenciesPeriodCell(ytdRaw)}
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

// Compact Sectors panel
export function SectorsCompactRail({ data, loading, layout = 'rail' }) {
  const [sectorsStatus, setSectorsStatus] = React.useState('closed');
  const [isExpanded, setIsExpanded] = React.useState(false);
  React.useEffect(() => {
    const update = () => setSectorsStatus(getMarketStatus('US')); // Sectors follow US market hours
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, []);
  const secStatus = sectorsStatus === 'open' || sectorsStatus === 'extended'
    ? { emoji: '🟢', title: sectorsStatus === 'open' ? 'Market open' : 'Extended hours' }
    : { emoji: '🔴', title: 'Market closed' };

  const sectorsLastUpdated = React.useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return null;
    const timestamps = data
      .map((q) => q?.timestamp || q?.lastUpdated)
      .filter(Boolean);
    return getMinTimestamp(timestamps);
  }, [data]);

  const sectorSources = React.useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];
    const interval = SOURCE_POLL_INTERVALS.multiRegionQuotes;
    return SECTORS_CONFIG.indices
      .map((idx) => {
        const idxQuote = data.find((d) => d.symbol === idx.symbol);
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

  const pctHeatFxDay = (val) => {
    const numeric = Number(String(val ?? '').replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(numeric)) return { className: 'region-mw-heat--na', style: {} };
    const intensity = Math.min(Math.abs(numeric) / 2, 1);
    return {
      className: `region-mw-heat--${numeric >= 0 ? 'pos' : 'neg'}`,
      style: { '--heat': intensity }
    };
  };

  const formatPctDisplay = (val) => {
    if (val == null || val === '' || val === '--') return '--';
    const num = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
    if (Number.isNaN(num)) return '--';
    return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
  };

  const tableRef = React.useRef(null);
  useAutoFitTable(tableRef, [data, loading]);

  return (
    <div
      className={`region-chart-panel region-chart-panel--mw currencies-compact-rail${layout === 'sidebar' ? ' currencies-compact-rail--in-sidebar' : ''}${isExpanded ? ' sectors-compact-rail--expanded' : ''} origin-top-left transition-all duration-300 ease-in-out ${isExpanded ? 'relative z-[100] scale-[1.8] shadow-2xl bg-white' : 'scale-100'}`}
    >
      <div className="region-chart-header region-chart-header--mw">
        <div className="region-header-left">
          <span className="region-label">Sectors</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <StatusDot
            updatedAt={sectorsLastUpdated}
            status={sectorsStatus === 'open' ? 'active' : 'inactive'}
            size={8}
            label="Sectors"
            emoji={secStatus.emoji}
            sources={sectorSources}
          />
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-blue-500 hover:text-blue-700 p-1 rounded border border-blue-500 dark:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors z-10"
            title={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? (
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            ) : (
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"></path></svg>
            )}
          </button>
        </div>
      </div>
      <div className="region-mw-body currencies-compact-rail__body">
        <div className="region-mw-table-wrap currencies-rail-table-wrap">
          <table ref={tableRef} className="region-mw-quotes-table currencies-mw-table currencies-rail-table sectors-rail-table">
            <thead>
              <tr>
                <th className="region-mw-th region-mw-th-sector" scope="col">
                  SECTOR
                </th>
                <th className="region-mw-th region-mw-th-ticker" scope="col">
                  Ticker
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-price" scope="col">
                  Price
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  %
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  MTD %
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  QTD %
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  YTD %
                </th>
              </tr>
            </thead>
            <tbody>
              {SECTORS_CONFIG.indices.map((index) => {
                const quote = data?.find((d) => d.symbol === index.symbol);
                const priceVal = parseFloat(quote?.price);
                const price = loading ? '…' : (!Number.isNaN(priceVal) ? priceVal.toFixed(2) : '—');
                const changePercent = quote?.changePercent;
                const parsedChange = parseFloat(String(changePercent ?? '').replace(/[^0-9.-]/g, ''));
                const isPositive = Number.isFinite(parsedChange) && parsedChange >= 0;
                const hasChange = Number.isFinite(parsedChange);
                const heat = loading ? { className: 'region-mw-heat--na', style: {} } : pctHeatFxDay(changePercent);

                const mtdRaw = quote?.mtdChangePct;
                const qtdRaw = quote?.qtdChangePct;
                const ytdRaw = quote?.ytdChangePct;
                const mtdNum = mtdRaw == null || mtdRaw === '' ? NaN : Number(mtdRaw);
                const qtdNum = qtdRaw == null || qtdRaw === '' ? NaN : Number(qtdRaw);
                const ytdNum = ytdRaw == null || ytdRaw === '' ? NaN : Number(ytdRaw);
                const mtdHeat = loading ? { className: 'region-mw-heat--na', style: {} } : pctHeatProps(mtdNum);
                const qtdHeat = loading ? { className: 'region-mw-heat--na', style: {} } : pctHeatProps(qtdNum);
                const ytdHeat = loading ? { className: 'region-mw-heat--na', style: {} } : pctHeatProps(ytdNum);

                return (
                  <tr key={index.symbol} className="region-mw-tr">
                    <td className="region-mw-td region-mw-td-sector truncate max-w-[80px]" title={index.name}>{index.name}</td>
                    <td className="region-mw-td region-mw-td-ticker font-bold">{index.symbol}</td>
                    <td className="region-mw-td region-mw-td-num region-mw-td-price">{price}</td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${heat.className} ${hasChange ? (isPositive ? 'positive' : 'negative') : ''}`}
                      style={heat.style}
                    >
                      {loading ? '…' : formatPctDisplay(changePercent)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${mtdHeat.className}`}
                      style={mtdHeat.style}
                    >
                      {loading ? '…' : formatCurrenciesPeriodCell(mtdRaw)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${qtdHeat.className}`}
                      style={qtdHeat.style}
                    >
                      {loading ? '…' : formatCurrenciesPeriodCell(qtdRaw)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num region-mw-td-heat ${ytdHeat.className}`}
                      style={ytdHeat.style}
                    >
                      {loading ? '…' : formatCurrenciesPeriodCell(ytdRaw)}
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

// VolumeCard - standalone card (styled like region panels)
function VolumeCard() {
  const [volLastUpdated, setVolLastUpdated] = React.useState(null);
  const [volStatus, setVolStatus] = React.useState('defective');
  const [volHeaderNote, setVolHeaderNote] = React.useState('');

  const handleVolumeSourcesChange = React.useCallback((sources) => {
    const primarySource = Array.isArray(sources) ? sources[0] : null;
    setVolStatus(primarySource?.status || 'defective');
  }, []);

  return (
    <div className="region-chart-panel region-chart-panel--mw volume-card">
      <div className="region-chart-header region-chart-header--mw">
        <div className="region-header-left">
          <span className="card-header-icon card-header-icon--blue">
            <BarChart2 size={16} strokeWidth={2} />
          </span>
          <span className="region-label region-label--lg">Volume</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          {volHeaderNote ? (
            <span className="mw-card-header-note" title={volHeaderNote}>
              {volHeaderNote}
            </span>
          ) : null}
          <StatusDot
            updatedAt={volLastUpdated}
            status={volStatus}
            size={8}
            label="Volume"
            emoji="🟢"
            showDateOnly
          />
        </div>
      </div>
      <MarketVolumeTable
        onLastUpdatedChange={setVolLastUpdated}
        onSourcesChange={handleVolumeSourcesChange}
        onHeaderNoteChange={setVolHeaderNote}
      />
    </div>
  );
}

// USD Correlation card - same dimensions as Volatility card
function USDCorrelationCard({ correlations, rollingStats, correlationsTimestamp, calculationDate, loading, error, onRetry }) {
  return (
    <div className="region-chart-panel region-chart-panel--mw usd-correlation-card">
      <USDCorrelationMatrix
        correlations={correlations}
        rollingStats={rollingStats}
        correlationsTimestamp={correlationsTimestamp}
        calculationDate={calculationDate}
        loading={loading}
        error={error}
        onRetry={onRetry}
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
    <div className="region-chart-panel region-chart-panel--mw volatility-card">
      <VolatilityTableWithTabs statusIndicator={statusIndicator} />
    </div>
  );
}

// Format a numeric price/yield. Unit suffixes (%, bps) are not appended —
// the unit is shown in the column header instead to reduce clutter.
function formatTablePrice(rawPrice, unit) {
  if (rawPrice == null || rawPrice === '' || rawPrice === '--') return '—';
  const num =
    typeof rawPrice === 'number'
      ? rawPrice
      : parseFloat(String(rawPrice).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(num)) return '—';

  const fractionDigits = unit === 'bps' ? 1 : 2;

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(num);
}

// Derive per-row display metrics from the raw quote payload.
// Period columns map to server `computePeriodPercentsFromCloses`: WEEKLY ≈ 5 sessions,
// MONTHLY ≈ 21 sessions, 3M/6M ≈ 63/126 sessions (rolling), YTD = calendar year-to-date.
// This differs from the compact Currencies rail, which uses calendar MTD/QTD/YTD plus 15D.
function getRowMetrics(idx, quote) {
  const pctRaw = quote?.changePercent;
  const pctNum = parseFloat(String(pctRaw ?? '').replace(/[^0-9.-]/g, ''));
  const hasPct = Number.isFinite(pctNum);
  const isPositive = hasPct ? pctNum >= 0 : null;
  const unit = idx.unit || quote?.unit;
  const isBps = unit === 'bps';
  const priceStr = formatTablePrice(quote?.price, unit);
  let pctStr = '—';
  if (hasPct) {
    if (isBps) {
      pctStr = `${pctNum > 0 ? '+' : ''}${pctNum.toFixed(1)}`;
    } else {
      pctStr = `${pctNum > 0 ? '+' : ''}${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(pctNum)}`;
    }
  }

  const w = quote?.weekChangePct;
  const mo = quote?.monthChangePct;
  const m3 = quote?.threeMonthChangePct;
  const m6 = quote?.sixMonthChangePct;
  const ytd = quote?.ytdChangePct;
  const weekNum = w == null || w === '' ? NaN : Number(w);
  const monthNum = mo == null || mo === '' ? NaN : Number(mo);
  const threeMonthNum = m3 == null || m3 === '' ? NaN : Number(m3);
  const sixMonthNum = m6 == null || m6 === '' ? NaN : Number(m6);
  const ytdNum = ytd == null || ytd === '' ? NaN : Number(ytd);
  const formatPeriod = isBps ? formatPeriodBps : formatPeriodPct;

  return {
    priceStr,
    pctStr,
    pctNum,
    isPositive,
    quote,
    weekStr: formatPeriod(w),
    monthStr: formatPeriod(mo),
    threeMonthStr: formatPeriod(m3),
    sixMonthStr: formatPeriod(m6),
    ytdStr: formatPeriod(ytd),
    weekNum: Number.isFinite(weekNum) ? weekNum : null,
    monthNum: Number.isFinite(monthNum) ? monthNum : null,
    threeMonthNum: Number.isFinite(threeMonthNum) ? threeMonthNum : null,
    sixMonthNum: Number.isFinite(sixMonthNum) ? sixMonthNum : null,
    ytdNum: Number.isFinite(ytdNum) ? ytdNum : null
  };
}

// Auto-fit the quotes table so every cell stays on a single line. Measures
// each cell's `scrollWidth` (natural content width at the current font size)
// against its `clientWidth` (column width allocated by `table-layout: fixed`).
// If any cell would overflow, shrinks a single `--mw-scale` CSS variable on
// the table just enough for the widest cell to fit — same scale applied to
// every cell so the card stays internally consistent. Different cards compute
// independently, so one may render smaller than its neighbors.
function useAutoFitTable(tableRef, deps) {
  React.useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return undefined;

    const MIN_SCALE = 0.62;   // 11px * 0.62 ≈ 6.8px floor
    const MAX_SCALE = 1;
    const SAFETY = 0.97;      // Small margin to avoid sub-pixel re-overflow

    let rafId = null;

    const fit = () => {
      if (!table.isConnected) return;
      table.style.setProperty('--mw-scale', String(MAX_SCALE));
      // Force a synchronous layout so scrollWidth reflects the MAX_SCALE pass.
      void table.offsetWidth;

      const cells = table.querySelectorAll('th, td');
      let minFit = 1;
      cells.forEach((cell) => {
        const cw = cell.clientWidth;
        const sw = cell.scrollWidth;
        if (cw > 0 && sw > cw) {
          const ratio = cw / sw;
          if (ratio < minFit) minFit = ratio;
        }
      });

      if (minFit < 1) {
        const scale = Math.max(
          MIN_SCALE,
          Math.min(MAX_SCALE, MAX_SCALE * minFit * SAFETY)
        );
        table.style.setProperty('--mw-scale', scale.toFixed(3));
      }
    };

    const schedule = () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        fit();
      });
    };

    schedule();

    const ro = new ResizeObserver(schedule);
    ro.observe(table);

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// Shared quotes-table body used by both `RegionChartPanel` and `RatesCard`.
// `priceLabel` defaults to PRICE but callers may pass YIELD / OAS / SPREAD.
function QuotesTable({ indices, data, loading, priceLabel = 'PRICE', indexLabel = 'INDEX' }) {
  // Append a "(%)" unit hint to the price header only when the column's values
  // are expressed as a percent (YIELD). Plain PRICE and mixed-unit labels like
  // "OAS / PRICE" are left alone since they're not all-percent.
  const priceHeader =
    priceLabel === 'YIELD' ? 'YIELD (%)' : priceLabel;
  const tableRef = React.useRef(null);
  useAutoFitTable(tableRef, [indices, data, loading, priceLabel]);
  return (
    <div className="region-mw-body">
      <div className="region-mw-table-wrap">
        <table ref={tableRef} className="region-mw-quotes-table">
          <thead>
            <tr>
              <th className="region-mw-th region-mw-th-trend" aria-hidden="true" />
              <th className="region-mw-th region-mw-th-name" scope="col">{indexLabel}</th>
              <th className="region-mw-th region-mw-th-num region-mw-th-price" scope="col">
                {priceHeader}
              </th>
              <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">DAY (%)</th>
              <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">WEEKLY (%)</th>
              <th
                className="region-mw-th region-mw-th-num region-mw-th-metric"
                scope="col"
                title="Approx. 21 trading sessions (~1 month rolling). Not calendar month-to-date — see Currencies card for MTD %."
              >
                MONTHLY (%)
              </th>
              <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">3M (%)</th>
              <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">6M (%)</th>
              <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">YTD (%)</th>
            </tr>
          </thead>
          <tbody>
            {indices.map((idx) => {
              const quote = data?.find((d) => d.symbol === idx.symbol);
              const m = getRowMetrics(idx, quote);
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
              const threeMonthHeat = loading
                ? { className: 'region-mw-heat--na', style: {} }
                : pctHeatProps(m.threeMonthNum);
              const sixMonthHeat = loading
                ? { className: 'region-mw-heat--na', style: {} }
                : pctHeatProps(m.sixMonthNum);
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
                    className={`region-mw-td region-mw-td-num region-mw-td-price ${loading ? '' : m.quote?.price != null ? (dirUp ? 'positive' : dirDown ? 'negative' : '') : ''}`}
                  >
                    {loading ? '…' : m.priceStr}
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
                    className={`region-mw-td region-mw-td-num region-mw-td-heat ${threeMonthHeat.className}`}
                    style={threeMonthHeat.style}
                  >
                    {loading ? '…' : m.threeMonthStr}
                  </td>
                  <td
                    className={`region-mw-td region-mw-td-num region-mw-td-heat ${sixMonthHeat.className}`}
                    style={sixMonthHeat.style}
                  >
                    {loading ? '…' : m.sixMonthStr}
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
  );
}

const REGION_ICONS = {
  us:          { el: '🇺🇸', cls: '' },
  europe:      { el: '🌍', cls: '' },
  asia:        { el: '🌏', cls: '' },
  commodities: { el: '💧', cls: '' },
  crypto:      { el: '₿',  cls: 'region-icon--crypto' },
  rates:       { el: '%',  cls: 'region-icon--rates' },
};

// RegionChartPanel — full-width metrics table (charts may return later)
function RegionChartPanel({ region, regionKey, data, loading }) {
  const { label, indices, regionKey: marketRegionKey } = region;
  const tableIndices = React.useMemo(() => indices.slice(0, 12), [indices]);
  const isRates = marketRegionKey === 'Rates';
  const isCrypto = marketRegionKey === 'Cryptocurrencies';
  const indexLabel = isCrypto ? 'ASSET' : 'INDEX';
  const iconCfg = REGION_ICONS[regionKey] || { el: '', cls: '' };

  const [marketStatus, setMarketStatus] = React.useState('closed');

  React.useEffect(() => {
    const updateStatus = () => {
      setMarketStatus(getMarketStatus(marketRegionKey));
    };
    updateStatus();
    const interval = setInterval(updateStatus, 60000);
    return () => clearInterval(interval);
  }, [marketRegionKey]);

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

  const regionLastUpdated = React.useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return null;
    const timestamps = data
      .map((d) => d?.lastUpdated || d?.timestamp || d?.chartUpdatedAt)
      .filter(Boolean);
    return getMinTimestamp(timestamps);
  }, [data]);

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

  return (
    <div className={`region-chart-panel region-chart-panel--${regionKey} region-chart-panel--mw`}>
      <div className="region-chart-header region-chart-header--mw">
        <div className="region-header-left">
          <span className={`region-icon ${iconCfg.cls}`}>{iconCfg.el}</span>
          <span className="region-label">{label}</span>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <StatusDot
            updatedAt={regionLastUpdated}
            status={statusIndicator.emoji === '🟢' ? 'active' : statusIndicator.emoji === '🔵' ? 'stale' : 'inactive'}
            size={8}
            label={`${label} region`}
            emoji={statusIndicator.emoji}
            sources={regionSources}
          />
        </div>
      </div>
      <QuotesTable
        indices={tableIndices}
        data={data}
        loading={loading}
        priceLabel={isRates ? 'YIELD' : 'PRICE'}
        indexLabel={indexLabel}
      />
    </div>
  );
}

// Tabs shown on the enhanced Rates card. Order matters — first tab is the
// default. Labels map 1:1 to the `rates.<tabKey>` shape returned by the
// /api/multi-region-quotes endpoint.
const RATES_TABS = [
  { key: 'us_treasuries', label: 'Treasuries', priceLabel: 'YIELD' },
  { key: 'policy', label: 'Policy', priceLabel: 'YIELD' },
  { key: 'credit', label: 'Credit', priceLabel: 'OAS / PRICE' },
  { key: 'eu_sovereigns', label: 'EU', priceLabel: 'YIELD' },
  { key: 'asia_sovereigns', label: 'Asia', priceLabel: 'YIELD' }
];

// RatesCard — tabbed panel (same footprint as RegionChartPanel) exposing
// Treasuries + curve spreads, Policy, Credit, EU and Asia sovereigns.
function RatesCard({ data, loading }) {
  const [activeTab, setActiveTab] = React.useState('us_treasuries');
  const [marketStatus, setMarketStatus] = React.useState('closed');

  React.useEffect(() => {
    const update = () => setMarketStatus(getMarketStatus('Rates'));
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, []);

  const statusIndicator = React.useMemo(() => {
    switch (marketStatus) {
      case 'open':
        return { emoji: '🟢', title: 'Market open' };
      case 'extended':
        return { emoji: '🔵', title: 'Extended hours' };
      case 'holiday':
        return { emoji: '🔴', title: 'Market closed - Holiday' };
      default:
        return { emoji: '🔴', title: 'Market closed' };
    }
  }, [marketStatus]);

  const tabConfig = React.useMemo(
    () => RATES_TABS.find((t) => t.key === activeTab) || RATES_TABS[0],
    [activeTab]
  );

  // Rows for the active tab. `data` is `{ us_treasuries: [...], policy: [...] }`
  // when the server supports tabs. A legacy flat-array response is only
  // valid for the Treasuries tab; all other tabs render an empty state so
  // users can tell the backend hasn't been updated yet.
  const isLegacyShape = Array.isArray(data);
  const rows = React.useMemo(() => {
    if (!data) return [];
    if (isLegacyShape) {
      return activeTab === 'us_treasuries' ? data : [];
    }
    return Array.isArray(data[activeTab]) ? data[activeTab] : [];
  }, [data, isLegacyShape, activeTab]);

  // Build the `indices` input for QuotesTable from the rows themselves so
  // ordering matches the backend (including derived spread rows at the end).
  const tabIndices = React.useMemo(
    () => rows.map((r) => ({ symbol: r.symbol, name: r.name, unit: r.unit })),
    [rows]
  );

  const lastUpdated = React.useMemo(() => {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const timestamps = rows
      .map((r) => r?.lastUpdated || r?.timestamp || r?.chartUpdatedAt)
      .filter(Boolean);
    return getMinTimestamp(timestamps);
  }, [rows]);

  const sources = React.useMemo(() => {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const interval = SOURCE_POLL_INTERVALS.multiRegionQuotes;
    return rows
      .map((row) => {
        const ts = row?.lastUpdated || row?.timestamp || row?.chartUpdatedAt;
        if (!ts) return null;
        return {
          id: row.symbol,
          label: `${row.name} (${row.symbol})`,
          updatedAt: ts,
          status: getSourceFreshness(ts, interval)
        };
      })
      .filter(Boolean);
  }, [rows]);

  return (
    <div className="region-chart-panel region-chart-panel--rates region-chart-panel--mw rates-card">
      <div className="region-chart-header region-chart-header--mw rates-card-header">
        <div className="region-header-left">
          <span className="region-icon region-icon--rates">%</span>
          <span className="region-label">Rates</span>
        </div>
        <div className="rates-tabs" role="tablist" aria-label="Rates categories">
          {RATES_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={tab.key === activeTab}
              className={`rates-tab${tab.key === activeTab ? ' rates-tab--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <StatusDot
            updatedAt={lastUpdated}
            status={statusIndicator.emoji === '🟢' ? 'active' : statusIndicator.emoji === '🔵' ? 'stale' : 'inactive'}
            size={8}
            label="Rates region"
            emoji={statusIndicator.emoji}
            sources={sources}
          />
        </div>
      </div>
      {tabIndices.length === 0 && !loading ? (
        <div className="region-mw-body rates-tab-empty">
          <div className="rates-tab-empty-message">
            No data available for this tab yet.
          </div>
        </div>
      ) : (
        <QuotesTable
          indices={tabIndices}
          data={rows}
          loading={loading}
          priceLabel={tabConfig.priceLabel}
          indexLabel="TENOR"
        />
      )}
    </div>
  );
}

// Main MultiRegionMarketOverview component (multi-region quotes supplied by parent)
export default function MultiRegionMarketOverview({ marketData, loading, error }) {
  const {
    correlations,
    rollingStats,
    correlationsTimestamp,
    calculationDate,
    loading: correlationLoading,
    error: correlationError,
    retry: retryCorrelations,
  } = useUsdCorrelations();

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

      {/* Secondary Section - Left: Currencies + Volume; Right: USD Correlations + Volatility */}
      <div className="secondary-markets-section">
        <div className="secondary-left-column">
          <CurrenciesCompactRail
            data={marketData.currencies}
            loading={loading}
            layout="sidebar"
          />
          <VolumeCard />
        </div>
        <div className="secondary-cards-stack">
          <USDCorrelationCard
            correlations={correlations}
            rollingStats={rollingStats}
            correlationsTimestamp={correlationsTimestamp}
            calculationDate={calculationDate}
            loading={correlationLoading}
            error={correlationError}
            onRetry={retryCorrelations}
          />
          <VolatilityCard />
        </div>
      </div>

      <div className="main-markets-grid">
        {Object.keys(MAIN_MARKET_REGIONS)
          .filter((regionKey) => regionKey !== 'rates' && regionKey !== 'crypto')
          .map((regionKey) => (
            <RegionChartPanel
              key={regionKey}
              region={MAIN_MARKET_REGIONS[regionKey]}
              regionKey={regionKey}
              data={getRegionData(regionKey)}
              loading={loading}
            />
          ))}
      </div>

      <div className="bottom-markets-row">
        <RatesCard
          data={getRegionData('rates')}
          loading={loading}
        />
        <RegionChartPanel
          region={MAIN_MARKET_REGIONS.crypto}
          regionKey="crypto"
          data={getRegionData('crypto')}
          loading={loading}
        />
      </div>
    </div>
  );
}
