import React, { useState, useEffect } from 'react';
import { Sparklines, SparklinesLine } from 'react-sparklines';
import { MarketDataService } from '../../services/api/marketDataService';
import MarketCountdown from './MarketCountdown';
import './MultiRegionMarketOverview.css';

// Utility functions to check if markets are open
const isMarketOpen = (region) => {
  const now = new Date();

  switch(region) {
    case 'US': {
      const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const dayOfWeek = etTime.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return false;
      const currentTime = etTime.getHours() + etTime.getMinutes() / 60;
      return currentTime >= 9.5 && currentTime < 16; // 9:30 AM - 4:00 PM ET
    }
    case 'Europe': {
      const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
      const dayOfWeek = londonTime.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return false;
      const currentTime = londonTime.getHours() + londonTime.getMinutes() / 60;
      return currentTime >= 8 && currentTime < 16.5; // 8:00 AM - 4:30 PM GMT
    }
    case 'Asia': {
      const tokyoTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const dayOfWeek = tokyoTime.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return false;
      const currentTime = tokyoTime.getHours() + tokyoTime.getMinutes() / 60;
      return currentTime >= 9 && currentTime < 15; // 9:00 AM - 3:00 PM JST
    }
    case 'Cryptocurrencies': {
      return true; // Crypto markets are 24/7
    }
    case 'Rates': {
      // Bond markets follow US market hours
      const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const dayOfWeek = etTime.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return false;
      const currentTime = etTime.getHours() + etTime.getMinutes() / 60;
      return currentTime >= 9.5 && currentTime < 16;
    }
    case 'Commodities': {
      // Commodities trade extended hours, but core hours are US market hours
      const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const dayOfWeek = etTime.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return false;
      const currentTime = etTime.getHours() + etTime.getMinutes() / 60;
      return currentTime >= 9.5 && currentTime < 16;
    }
    case 'Currencies': {
      // Forex is 24/5 (closed weekends)
      const dayOfWeek = now.getDay();
      return !(dayOfWeek === 0 || dayOfWeek === 6);
    }
    default:
      return false;
  }
};

// Market regions configuration
const MARKET_REGIONS = {
  us: {
    label: 'US',
    indices: [
      { symbol: 'SPY', name: 'S&P 500' },
      { symbol: 'DJI', name: 'Dow 30' },
      { symbol: 'IXIC', name: 'Nasdaq' },
      { symbol: 'RUT', name: 'Russell 2000' },
      { symbol: 'VIX', name: 'VIX' },
      { symbol: 'GLD', name: 'Gold' }
    ]
  },
  europe: {
    label: 'Europe',
    indices: [
      { symbol: 'FTSE', name: 'FTSE 100' },
      { symbol: 'CAC', name: 'CAC 40' },
      { symbol: 'DAX', name: 'DAX' },
      { symbol: 'N100', name: 'Euronext 100' },
      { symbol: 'EURUSD', name: 'EUR/USD' },
      { symbol: 'GBPUSD', name: 'USD/GBP' }
    ]
  },
  asia: {
    label: 'Asia',
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
    label: 'Cryptocurrencies',
    indices: [
      { symbol: 'BTC', name: 'Bitcoin' },
      { symbol: 'ETH', name: 'Ethereum' },
      { symbol: 'BNB', name: 'Binance Coin' },
      { symbol: 'ADA', name: 'Cardano' },
      { symbol: 'SOL', name: 'Solana' },
      { symbol: 'XRP', name: 'XRP' }
    ]
  },
  rates: {
    label: 'Rates',
    indices: [
      { symbol: 'UST13W', name: '13-Wk Bond' },
      { symbol: 'UST5Y', name: '5-Yr Bond' },
      { symbol: 'UST10Y', name: '10-Yr Bond' },
      { symbol: 'UST30Y', name: '30-Yr Bond' },
      { symbol: 'UST2Y', name: '2 Yr Yld Fut' },
      { symbol: 'TNX', name: '10 Yr T-Note' }
    ]
  },
  commodities: {
    label: 'Commodities',
    indices: [
      { symbol: 'CL', name: 'Crude Oil' },
      { symbol: 'GC', name: 'Gold' },
      { symbol: 'SI', name: 'Silver' },
      { symbol: 'HG', name: 'Copper' },
      { symbol: 'NG', name: 'Natural Gas' },
      { symbol: 'BZ', name: 'Brent Crude' }
    ]
  },
  currencies: {
    label: 'Currencies',
    indices: [
      { symbol: 'EURUSD', name: 'EUR/USD' },
      { symbol: 'USDJPY', name: 'USD/JPY' },
      { symbol: 'GBPUSD', name: 'USD/GBP' },
      { symbol: 'AUDUSD', name: 'USD/AUD' },
      { symbol: 'USDCAD', name: 'USD/CAD' },
      { symbol: 'USDMXN', name: 'USD/MXN' }
    ]
  },
  liquidity: {
    label: 'Liquidity',
    indices: [] // Special handling for liquidity metrics
  }
};

// IndexCard component - displays individual market index
function IndexCard({ name, value, change, changePercent, previousClose, sparklineData, loading, showStatus = true, region }) {
  // Parse change to determine if positive/negative
  const changeNum = change ? parseFloat(change.toString().replace(/[^0-9.-]/g, '')) : 0;
  const isPositive = changeNum >= 0;

  // Check if market is currently open (not just if data exists)
  const [marketOpen, setMarketOpen] = React.useState(false);

  React.useEffect(() => {
    const updateMarketStatus = () => {
      setMarketOpen(isMarketOpen(region));
    };

    updateMarketStatus();
    // Update market status every minute
    const interval = setInterval(updateMarketStatus, 60000);
    return () => clearInterval(interval);
  }, [region]);

  // Check if data is being received (API is live)
  const hasData = !loading && value && value !== '--';

  // Normalize sparkline data to show percentage changes from first data point
  // This makes small movements in currency pairs visible
  const normalizedSparklineData = React.useMemo(() => {
    if (!sparklineData || sparklineData.length === 0) return null;

    const firstValue = sparklineData[0];
    if (!firstValue || firstValue === 0) return sparklineData;

    // Convert to percentage changes from first value
    return sparklineData.map(price => ((price - firstValue) / firstValue) * 100);
  }, [sparklineData]);

  return (
    <div className="index-card">
      <div className="index-name-row">
        <div className="index-name-with-status">
          {showStatus && (
            <span
              className="market-status-dot"
              style={{ backgroundColor: marketOpen && hasData ? '#10B981' : '#EF4444' }}
              title={marketOpen && hasData ? 'Market open - receiving data' : marketOpen ? 'Market open - no data' : 'Market closed'}
            />
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
              color={isPositive ? '#16a34a' : '#dc2626'} // Dark green or dark red
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

      {/* Percent - Bottom Right */}
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

// RegionPanel component - displays a group of indices for one region
function RegionPanel({ region, data, loading }) {
  // Special handling for liquidity region
  if (region.label === 'Liquidity') {
    return (
      <div className="region-panel">
        <h3 className="region-title">{region.label}</h3>
        <div className="liquidity-container">
          <LiquidityCard />
        </div>
      </div>
    );
  }

  return (
    <div className="region-panel">
      <h3 className="region-title">{region.label}</h3>
      <div className="indices-grid">
        {region.indices.map((index) => {
          const quote = data?.find(d => d.symbol === index.symbol);
          return (
            <IndexCard
              key={index.symbol}
              name={index.name}
              value={quote?.price}
              change={quote?.change}
              changePercent={quote?.changePercent}
              previousClose={quote?.previousClose}
              sparklineData={quote?.sparklineData}
              loading={loading}
              showStatus={true}
              region={region.label}
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

  return (
    <div className="multi-region-overview">
      <MarketCountdown />

      {error && (
        <div className="error-message">
          Failed to load market data: {error}
        </div>
      )}

      <div className="regions-container">
        {Object.keys(MARKET_REGIONS).map((regionKey) => (
          <RegionPanel
            key={regionKey}
            region={MARKET_REGIONS[regionKey]}
            data={marketData[regionKey]}
            loading={loading}
          />
        ))}
      </div>
    </div>
  );
}
