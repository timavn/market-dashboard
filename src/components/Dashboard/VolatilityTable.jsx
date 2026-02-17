import React, { useState, useEffect, useRef } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import './VolatilityTable.css';

// Volatility ranges from The Process (bookContent.js) - VIX explicit; others use similar framework
const VOL_RANGES = {
  VIX: {
    name: 'VIX (S&P 500 Implied Vol)',
    source: 'The Process',
    ranges: [
      { min: 9, max: 19, label: 'Investable', color: 'green', desc: 'Buy dips, normal risk' },
      { min: 20, max: 29, label: 'Chop bucket', color: 'yellow', desc: 'Trade ranges, be aggressive on longs' },
      { min: 29, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive, preserve capital' }
    ]
  },
  RVX: {
    name: 'RVX (Russell 2000 Implied Vol)',
    source: 'Similar framework to VIX',
    ranges: [
      { min: 12, max: 24, label: 'Investable', color: 'green', desc: 'Typically ~1.2x VIX' },
      { min: 24, max: 36, label: 'Chop bucket', color: 'yellow', desc: 'Trade ranges' },
      { min: 36, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive' }
    ]
  },
  NazVol: {
    name: 'NazVol / VXN (Nasdaq Implied Vol)',
    source: 'Similar framework to VIX',
    ranges: [
      { min: 12, max: 24, label: 'Investable', color: 'green', desc: 'Typically ~1.2x VIX' },
      { min: 24, max: 36, label: 'Chop bucket', color: 'yellow', desc: 'Trade ranges' },
      { min: 36, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive' }
    ]
  },
  GVZ: {
    name: 'GVZ (Gold Implied Vol)',
    source: 'The Process (Gold vol uses Chop Bucket framework)',
    ranges: [
      { min: 12, max: 24, label: 'Investable', color: 'green', desc: 'Low vol regime' },
      { min: 24, max: 36, label: 'Chop bucket', color: 'yellow', desc: 'Trade ranges' },
      { min: 36, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive' }
    ]
  },
  OVX: {
    name: 'OVX (Oil Implied Vol)',
    source: 'Similar framework',
    ranges: [
      { min: 25, max: 40, label: 'Investable', color: 'green', desc: 'Lower vol regime' },
      { min: 40, max: 55, label: 'Chop bucket', color: 'yellow', desc: 'Trade ranges' },
      { min: 55, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive' }
    ]
  },
  MOVE: {
    name: 'MOVE (Bond Market Implied Vol)',
    source: 'Different scale - Treasury options',
    ranges: [
      { min: 70, max: 100, label: 'Investable', color: 'green', desc: 'Lower vol regime' },
      { min: 100, max: 120, label: 'Chop bucket', color: 'yellow', desc: 'Trade ranges' },
      { min: 120, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive' }
    ]
  }
};

const MACRO_SERIES = [
  { name: 'VIX', symbol: '^VIX', rowStyle: 'green' },
  { name: 'RVX', symbol: '^RVX', rowStyle: 'yellow' },
  { name: 'NazVol', symbol: '^VXN', rowStyle: 'yellow' },
  { name: 'GVZ', symbol: '^GVZ', rowStyle: 'blue' },
  { name: 'OVX', symbol: '^OVX', rowStyle: 'blue' }
];

const RATES_SERIES = [
  { name: 'MOVE', symbol: '^MOVE', rowStyle: 'blue' }
];

// VIX buckets from The Process (bookContent.js): 9-19 Investable, 20-29 Chop, 29+ Uninvestable
const getVixBucket = (value) => {
  if (value == null || isNaN(value)) return null;
  const v = parseFloat(value);
  if (v < 9) return 'green'; // Below investable range = low vol, favorable
  if (v <= 19) return 'green'; // Investable
  if (v <= 29) return 'yellow'; // Chop bucket
  return 'red'; // Uninvestable
};

const POLL_INTERVAL_MS = 60000; // 1 minute during market hours

const VolatilityTable = ({ mode = 'macro', onIndicatorHelp }) => {
  const series = mode === 'rates' ? RATES_SERIES : MACRO_SERIES;
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);

  const fetchVolatilityData = async () => {
    try {
      const symbols = series.map(s => s.symbol);
      const [quotesRes, ...historicalRes] = await Promise.all([
        MarketDataService.getQuotes(symbols),
        ...series.map(s => MarketDataService.getHistoricalData(s.symbol, 30))
      ]);

      const result = {};
      series.forEach((s, i) => {
        const quote = quotesRes?.[s.symbol] || quotesRes?.[s.symbol.replace('^', '')] || quotesRes?.[s.name];
        const hist = historicalRes[i]?.data || [];
        const sorted = [...hist].sort((a, b) => new Date(b.date) - new Date(a.date));

        const lastPx = quote?.price ?? (sorted[0]?.close != null ? parseFloat(sorted[0].close) : null);
        const day1 = sorted[1]?.close != null ? parseFloat(sorted[1].close) : null;
        const week1 = sorted[5]?.close != null ? parseFloat(sorted[5].close) : null;
        const week4 = sorted[21]?.close != null ? parseFloat(sorted[21].close) : null;

        result[s.name] = {
          lastPx,
          day1Ago: day1,
          week1Ago: week1,
          week4Ago: week4
        };
      });
      setData(result);
    } catch (err) {
      console.error('Error fetching volatility data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchVolatilityData();
    const interval = setInterval(fetchVolatilityData, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [mode]);

  const formatValue = (v) => (v != null ? Number(v).toFixed(2) : '--');

  const getCellClass = (s, rowData, colIndex) => {
    // VIX: dynamic color from Last Px per Process ranges (9-19 green, 20-29 yellow, 29+ red)
    if (s.name === 'VIX') {
      const bucket = getVixBucket(rowData?.lastPx);
      if (bucket) return `vol-cell ${bucket}`;
      return 'vol-cell';
    }
    if (s.rowStyle === 'blue') return 'vol-cell blue';
    if (s.rowStyle === 'green') return 'vol-cell green';
    if (s.rowStyle === 'yellow') {
      return colIndex < 3 ? 'vol-cell yellow' : 'vol-cell green';
    }
    return 'vol-cell';
  };

  if (loading) {
    return (
      <div className="volatility-table-loading">Loading volatility data...</div>
    );
  }

  return (
    <div className="volatility-table">
      <div className="volatility-table-header">
        <div className="vol-th vol-th-series">Series</div>
        <div className="vol-th">Last Px</div>
        <div className="vol-th">1 Day Ago</div>
        <div className="vol-th">1 Wk Ago</div>
        <div className="vol-th">4 Wks Ago</div>
      </div>
      {series.map((s) => {
        const row = data[s.name] || {};
        return (
          <div key={s.name} className="volatility-table-row">
            <div className="vol-td vol-td-series">
              <button
                type="button"
                className="vol-ranges-help-btn"
                onClick={() => onIndicatorHelp?.(s.name)}
                title={`View ${s.name} ranges`}
                aria-label={`View ${s.name} ranges`}
              >
                ?
              </button>
              <span>{s.name}</span>
            </div>
            <div className={getCellClass(s, row, 0)}>{formatValue(row.lastPx)}</div>
            <div className={getCellClass(s, row, 1)}>{formatValue(row.day1Ago)}</div>
            <div className={getCellClass(s, row, 2)}>{formatValue(row.week1Ago)}</div>
            <div className={getCellClass(s, row, 3)}>{formatValue(row.week4Ago)}</div>
          </div>
        );
      })}
    </div>
  );
};

const VolRangesPopover = ({ indicatorKey, onClose }) => {
  const ref = useRef(null);
  const info = indicatorKey ? VOL_RANGES[indicatorKey] : null;

  useEffect(() => {
    if (!indicatorKey) return;
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest('.vol-ranges-help-btn')) {
        onClose();
      }
    };
    const handleEscape = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [indicatorKey, onClose]);

  if (!indicatorKey || !info) return null;

  return (
    <div className="vol-ranges-popover-backdrop" onClick={onClose}>
      <div ref={ref} className="vol-ranges-popover" onClick={(e) => e.stopPropagation()}>
        <div className="vol-ranges-popover-header">
          <span className="vol-ranges-popover-title">{info.name}</span>
          <button type="button" className="vol-ranges-popover-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="vol-ranges-popover-body">
          <div className="vol-ranges-indicator-source">Source: {info.source}</div>
          <div className="vol-ranges-ranges">
            {info.ranges.map((r, i) => (
              <div key={i} className={`vol-ranges-range vol-ranges-range-${r.color}`}>
                <span className="vol-ranges-range-label">{r.label}:</span>
                <span className="vol-ranges-range-math">
                  {r.max != null ? `${r.min}–${r.max}` : `${r.min}+`}
                </span>
                <span className="vol-ranges-range-desc">— {r.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const VolatilityTableWithTabs = ({ statusIndicator }) => {
  const [activeTab, setActiveTab] = React.useState('macro');
  const [openIndicator, setOpenIndicator] = React.useState(null);
  const status = statusIndicator || { emoji: '🟢', title: 'Active' };
  return (
    <div className="volatility-tabs">
      <div className="volatility-header-with-tabs">
        <span className="region-status-emoji" title={status.title}>{status.emoji}</span>
        <span className="region-label">Volatility</span>
        <div className="volatility-tab-buttons-inline">
          <button
            className={`volatility-tab-btn ${activeTab === 'macro' ? 'active' : ''}`}
            onClick={() => setActiveTab('macro')}
          >
            MACRO
          </button>
          <button
            className={`volatility-tab-btn ${activeTab === 'rates' ? 'active' : ''}`}
            onClick={() => setActiveTab('rates')}
          >
            Rates
          </button>
        </div>
      </div>
      <VolRangesPopover indicatorKey={openIndicator} onClose={() => setOpenIndicator(null)} />
      <VolatilityTable mode={activeTab} onIndicatorHelp={setOpenIndicator} />
    </div>
  );
};

export default VolatilityTable;
export { VolatilityTableWithTabs };
