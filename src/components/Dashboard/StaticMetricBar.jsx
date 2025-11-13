import React, { useState, useEffect } from 'react';
import { Text } from '@tremor/react';
import { MarketDataService } from '../../services/api/marketDataService';

// Metric boxes configuration
// Top row: Major daily indicators (moved from bottom row with improved names)
const TOP_ROW_METRICS = [
  'DXY',
  'GLD',
  'UST10Y',
  'CRB',
  'WTI',
  'SPY',
  'QQQ',
  'IWM',
];

// Bottom row: Additional metrics (moved from top row)
const BOTTOM_ROW_METRICS = [
  'VOL BAR',
  'Total Market Volume',
  'gamma',
];

const MetricBox = ({ label, value, loading }) => {
  // Format value based on label
  const formatValue = (label, value) => {
    if (loading) return '...';
    if (value === null || value === undefined) return '--';
    
    // UST10Y should be displayed as percentage
    if (label === 'UST10Y') {
      return `${parseFloat(value).toFixed(2)}%`;
    }
    
    // All others as decimal
    return parseFloat(value).toFixed(2);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {/* Label above box */}
      {label && (
        <Text
          style={{
            fontFamily: "'Kalam', 'Comic Sans MS', cursive",
            fontSize: '11px',
            fontWeight: 400,
            textTransform: 'lowercase',
            color: '#000000',
            fontStyle: 'italic',
            paddingLeft: '2px',
          }}
          className="dark:text-gray-200"
        >
          {label}
        </Text>
      )}
      
      {/* Box with metric value */}
      <div
        style={{
          border: '1px solid #000000',
          backgroundColor: '#ffffff',
          padding: '6px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          minWidth: '0',
          width: '100%',
          height: '36px',
          borderRadius: '2px',
        }}
        className="dark:bg-gray-700 dark:border-gray-500"
      >
        {/* Green status circle */}
        <div
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: '#22c55e',
            flexShrink: 0,
          }}
        />
        
        {/* Metric value */}
        <Text
          style={{
            fontSize: '14px',
            fontWeight: 600,
            color: '#000000',
            marginLeft: 'auto',
            fontVariantNumeric: 'tabular-nums',
          }}
          className="dark:text-gray-200"
        >
          {formatValue(label, value)}
        </Text>
      </div>
    </div>
  );
};

const StaticMetricBar = () => {
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(true);

  // Fetch macro indicators
  const fetchMacroIndicators = async () => {
    try {
      setLoading(true);
      const data = await MarketDataService.getMacroIndicators();
      
      // Transform data to map by symbol
      const pricesMap = {};
      Object.keys(data).forEach(symbol => {
        const indicator = data[symbol];
        if (indicator && indicator.price !== null && indicator.price !== undefined) {
          pricesMap[symbol] = indicator.price;
        }
      });
      
      setPrices(pricesMap);
    } catch (error) {
      console.error('Error fetching macro indicators:', error);
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchMacroIndicators();
  }, []);

  // Set up polling interval (every 8 seconds, similar to SecuritiesList)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchMacroIndicators();
    }, 8000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        width: '100%',
        padding: '4px 0',
      }}
    >
      {/* Top Row - Major Daily Indicators */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${TOP_ROW_METRICS.length}, minmax(0, 1fr))`,
          gap: '6px',
          width: '100%',
        }}
      >
        {TOP_ROW_METRICS.map((label, index) => (
          <MetricBox 
            key={`top-${index}`} 
            label={label} 
            value={prices[label]}
            loading={loading && !prices[label]}
          />
        ))}
      </div>

      {/* Bottom Row - Additional Metrics */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${BOTTOM_ROW_METRICS.length}, minmax(0, 1fr))`,
          gap: '6px',
          width: '100%',
        }}
      >
        {BOTTOM_ROW_METRICS.map((label, index) => (
          <MetricBox key={`bottom-${index}`} label={label} />
        ))}
      </div>
    </div>
  );
};

export default StaticMetricBar;

