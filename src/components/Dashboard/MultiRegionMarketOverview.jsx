import React, { useState, useEffect, useRef } from 'react';
import { Sparklines, SparklinesLine } from 'react-sparklines';
import { MarketDataService } from '../../services/api/marketDataService';
import MarketChartCard, { prefetchChartData } from './MarketChartCard';
import { US_MARKET_HOLIDAYS, UK_MARKET_HOLIDAYS, JP_MARKET_HOLIDAYS, isMarketHoliday } from '../../constants/globalMarkets';
import './MultiRegionMarketOverview.css';

// Helper to check if a date is a US market holiday
const isUSHoliday = (date) => isMarketHoliday(date, US_MARKET_HOLIDAYS);
const isUKHoliday = (date) => isMarketHoliday(date, UK_MARKET_HOLIDAYS);
const isJPHoliday = (date) => isMarketHoliday(date, JP_MARKET_HOLIDAYS);

// Market status types: 'open', 'extended', 'closed', 'holiday'
// Extended hours = pre-market (4:00-9:30 AM ET) and post-market (4:00-8:00 PM ET) for US markets
const getMarketStatus = (region) => {
  const now = new Date();

  switch(region) {
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

// Legacy helper for components that just need boolean
const isMarketOpen = (region) => {
  const status = getMarketStatus(region);
  return status === 'open' || status === 'extended';
};

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
    { symbol: 'USDMXN', name: 'USD/MXN' }
  ]
};

// IndexCard component - displays individual market index (used for currencies)
function IndexCard({ symbol, name, value, change, changePercent, sparklineData, loading, showStatus = true, region }) {
  // Parse change to determine if positive/negative
  const changeNum = change ? parseFloat(change.toString().replace(/[^0-9.-]/g, '')) : 0;
  const isPositive = changeNum >= 0;

  // Check if market is currently open
  const [marketOpen, setMarketOpen] = React.useState(false);

  React.useEffect(() => {
    const updateMarketStatus = () => {
      setMarketOpen(isMarketOpen(region));
    };

    updateMarketStatus();
    const interval = setInterval(updateMarketStatus, 60000);
    return () => clearInterval(interval);
  }, [region]);

  // Check if data is being received
  const hasData = !loading && value && value !== '--';

  // Normalize sparkline data
  const normalizedSparklineData = React.useMemo(() => {
    if (!sparklineData || sparklineData.length === 0) return null;

    const firstValue = sparklineData[0];
    if (!firstValue || firstValue === 0) return sparklineData;

    return sparklineData.map(price => ((price - firstValue) / firstValue) * 100);
  }, [sparklineData]);

  return (
    <div className="index-card">
      <div className="index-name-row">
        <div className="index-name-with-status">
          {showStatus && (
            <span
              className="market-status-emoji"
              title={marketOpen && hasData ? 'Market open - receiving data' : marketOpen ? 'Market open - no data' : 'Market closed'}
            >
              {marketOpen && hasData ? '🟢' : '🔴'}
            </span>
          )}
          <span className="index-name">{name}</span>
        </div>
        <div className="index-value">
          {loading ? '...' : value || '--'}
        </div>
      </div>

      {/* Sparkline Chart */}
      {!loading && normalizedSparklineData && normalizedSparklineData.length > 0 && (
        <div className="sparkline-container">
          <Sparklines
            data={normalizedSparklineData}
            width={90}
            height={22.5}
            margin={1.5}
          >
            <SparklinesLine
              color={isPositive ? '#16a34a' : '#dc2626'}
              style={{ strokeWidth: 1.125, fill: 'none' }}
            />
          </Sparklines>
        </div>
      )}

      {/* Change */}
      {!loading && (
        <div className={`index-change ${isPositive ? 'positive' : 'negative'}`}>
          <span className="arrow">{isPositive ? '▲' : '▼'}</span>
          <span>{change || '--'}</span>
        </div>
      )}

      {/* Percent */}
      {!loading && (
        <div className={`index-percent ${isPositive ? 'positive' : 'negative'}`}>
          {changePercent ? `${changePercent}%` : '--'}
        </div>
      )}
    </div>
  );
}

// LiquidityCard component - displays liquidity metrics
function LiquidityCard() {
  return (
    <div className="liquidity-card">
      {/* Global Dollar Liquidity Section */}
      <div className="liquidity-section">
        <div className="liquidity-header">
          <span className="liquidity-title">Global Dollar Liquidity</span>
        </div>
        <div className="liquidity-content">
          <div className="liquidity-metric">
            <div className="liquidity-metric-label">3M Annualized</div>
            <div className="liquidity-metric-value positive">+7%</div>
          </div>
          <div className="liquidity-metric">
            <div className="liquidity-metric-label">US M3</div>
            <div className="liquidity-metric-value positive">&gt; 4%</div>
          </div>
          <div className="liquidity-note">
            Expanding well above nominal GDP = asset inflation
          </div>
        </div>
      </div>

      {/* Market Volume Section */}
      <div className="liquidity-section">
        <div className="liquidity-header">
          <span className="liquidity-title">Market Volume (1/9 vs.)</span>
        </div>
        <div className="liquidity-content">
          <div className="liquidity-metric">
            <div className="liquidity-metric-label">Total Mkt Vol</div>
            <div className="liquidity-metric-value negative">-4%</div>
            <div className="liquidity-metric-sublabel">vs. 1Y Ave</div>
          </div>
          <div className="liquidity-metric">
            <div className="liquidity-metric-label">Exchange Vol</div>
            <div className="liquidity-metric-value negative">-1%</div>
            <div className="liquidity-metric-sublabel">vs. 1Y Ave</div>
          </div>
          <div className="liquidity-note">
            Total US exchange + OTC/OTCBB trading volume
          </div>
        </div>
      </div>
    </div>
  );
}

// RegionChartPanel component - displays a single full chart for a region with index tabs
function RegionChartPanel({ region, regionKey, data, selectedIndex, onSelectIndex }) {
  const { label, indices, regionKey: marketRegionKey } = region;
  const currentIndex = indices[selectedIndex];
  const quote = data?.find(d => d.symbol === currentIndex.symbol);

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

  // Helper to get change data for an index
  const getIndexChange = (symbol) => {
    const indexQuote = data?.find(d => d.symbol === symbol);
    if (!indexQuote?.changePercent) return null;
    const changeNum = parseFloat(indexQuote.changePercent.toString().replace(/[^0-9.-]/g, ''));
    return {
      percent: indexQuote.changePercent,
      isPositive: changeNum >= 0
    };
  };

  return (
    <div className="region-chart-panel">
      <div className="region-chart-header">
        <span className="region-status-emoji" title={statusIndicator.title}>{statusIndicator.emoji}</span>
        <span className="region-label">{label}</span>
        <div className="index-tabs">
          {indices.map((idx, i) => {
            const change = getIndexChange(idx.symbol);
            return (
              <button
                key={idx.symbol}
                className={`index-tab ${i === selectedIndex ? 'active' : ''}`}
                onClick={() => onSelectIndex(regionKey, i)}
              >
                <span className="index-tab-name">{idx.name}</span>
                {change && (
                  <span className={`index-tab-change ${change.isPositive ? 'positive' : 'negative'}`}>
                    {change.isPositive ? '▲' : '▼'}{change.percent}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <MarketChartCard
        key={currentIndex.symbol}
        symbol={currentIndex.symbol}
        name={currentIndex.name}
        initialData={{
          price: quote?.price,
          change: quote?.change,
          changePercent: quote?.changePercent
        }}
        hideStatus={true}
      />
    </div>
  );
}

// CurrenciesPanel component - displays mini currency cards
function CurrenciesPanel({ data, loading }) {
  return (
    <div className="currencies-panel">
      <div className="currencies-header">
        <span className="currencies-title">Currencies</span>
        <span className="currencies-hours">{CURRENCIES_CONFIG.tradingHours}</span>
      </div>
      <div className="currencies-grid">
        {CURRENCIES_CONFIG.indices.map((index) => {
          const quote = data?.find(d => d.symbol === index.symbol);
          return (
            <IndexCard
              key={index.symbol}
              symbol={index.symbol}
              name={index.name}
              value={quote?.price}
              change={quote?.change}
              changePercent={quote?.changePercent}
              sparklineData={quote?.sparklineData}
              loading={loading}
              showStatus={true}
              region="Currencies"
            />
          );
        })}
      </div>
    </div>
  );
}

// Main MultiRegionMarketOverview component
export default function MultiRegionMarketOverview() {
  const [marketData, setMarketData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const prefetchedRef = useRef(false);
  // Track which index is selected for each region (default to first index = 0)
  const [selectedIndices, setSelectedIndices] = useState({
    us: 0,
    europe: 0,
    asia: 0,
    crypto: 0,
    rates: 0,
    commodities: 0
  });

  // Prefetch chart data for default indices on mount
  useEffect(() => {
    if (prefetchedRef.current) return;
    prefetchedRef.current = true;

    // Prefetch the first index of each region (shown by default)
    const defaultSymbols = Object.values(MAIN_MARKET_REGIONS).map(
      region => region.indices[0].symbol
    );

    // Stagger prefetch requests to avoid overwhelming the server
    defaultSymbols.forEach((symbol, idx) => {
      setTimeout(() => {
        prefetchChartData(symbol);
      }, idx * 100); // 100ms stagger between requests
    });
  }, []);

  useEffect(() => {
    fetchMarketData();
    const interval = setInterval(fetchMarketData, 8000); // 8s polling (matches backend cache)
    return () => clearInterval(interval);
  }, []);

  const fetchMarketData = async () => {
    try {
      const data = await MarketDataService.getMultiRegionQuotes();
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

  // Handle index tab selection
  const handleSelectIndex = (regionKey, index) => {
    setSelectedIndices(prev => ({
      ...prev,
      [regionKey]: index
    }));
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
            selectedIndex={selectedIndices[regionKey]}
            onSelectIndex={handleSelectIndex}
          />
        ))}
      </div>

      {/* Secondary Section - Currencies & Liquidity */}
      <div className="secondary-markets-section">
        <CurrenciesPanel
          data={marketData.currencies}
          loading={loading}
        />
        <LiquidityCard />
      </div>
    </div>
  );
}
