import React, { useState, useEffect } from 'react';
import './VolatilityPanel.css';

const VolatilityPanel = () => {
  const [selectedVolatility, setSelectedVolatility] = useState('VIX');
  const [selectedTimeframe, setSelectedTimeframe] = useState('1D');
  const [vixData, setVixData] = useState(null);
  const [loading, setLoading] = useState(false);

  const volatilityOptions = [
    { value: 'VIX', label: 'VIX' },
    { value: 'MOVE', label: 'MOVE' },
    { value: 'GVZ', label: 'GVZ' },
    { value: 'EVZ', label: 'EVZ' },
    { value: 'RVX', label: 'RVX' },
    { value: 'TYVIX', label: 'TYVIX' }
  ];

  const timeframeOptions = [
    { value: '1D', label: '1D' },
    { value: '1W', label: '1W' },
    { value: '1M', label: '1M' },
    { value: '3M', label: '3M' },
    { value: '6M', label: '6M' },
    { value: '1Y', label: '1Y' }
  ];

  // Fetch VIX data when component mounts or volatility changes
  useEffect(() => {
    const fetchVixData = async () => {
      if (selectedVolatility === 'VIX') {
        setLoading(true);
        try {
          const response = await fetch('http://localhost:3001/api/indicators/vix');
          const data = await response.json();
          setVixData(data);
        } catch (error) {
          console.error('Error fetching VIX data:', error);
        } finally {
          setLoading(false);
        }
      }
    };

    fetchVixData();
  }, [selectedVolatility]);

  const getVolatilityRanges = (volatility) => {
    switch (volatility) {
      case 'VIX':
        return 'Range: 0-19, 20-29, 30+. 0-19 is investable, 20-29 is chop, 30+ is noninvestable';
      case 'MOVE':
        return 'Range: 0-50, 50-100, 100+. 0-50 is low vol, 50-100 is normal, 100+ is high vol';
      case 'GVZ':
        return 'Range: 0-15, 15-25, 25+. 0-15 is low vol, 15-25 is normal, 25+ is high vol';
      default:
        return 'Range: 0-20, 20-40, 40+. 0-20 is low vol, 20-40 is normal, 40+ is high vol';
    }
  };

  const getVixLevel = (value) => {
    const num = parseFloat(value);
    if (num <= 19) return { level: 'INVESTABLE', color: 'green' };
    if (num <= 29) return { level: 'CHOP', color: 'yellow' };
    return { level: 'UNINVESTABLE', color: 'red' };
  };

  return (
    <div className="volatility-panel">
      <div className="volatility-header">
        <div className="header-cell">
          <select 
            value={selectedVolatility} 
            onChange={(e) => setSelectedVolatility(e.target.value)}
            className="volatility-select"
          >
            {volatilityOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="header-cell level-indicator">
          {vixData && selectedVolatility === 'VIX' ? (
            <span className={`level-badge ${getVixLevel(vixData.current).color}`}>
              {getVixLevel(vixData.current).level}
            </span>
          ) : (
            <span className="level-badge placeholder">Select VIX</span>
          )}
        </div>
        <div className="header-cell">
          <select 
            value={selectedTimeframe} 
            onChange={(e) => setSelectedTimeframe(e.target.value)}
            className="timeframe-select"
          >
            {timeframeOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="volatility-content">
        {loading ? (
          <div className="loading">Loading VIX data...</div>
        ) : vixData && selectedVolatility === 'VIX' ? (
          <div className="vix-data">
            <div className="vix-main">
              <div className="vix-value">
                <span className="value">{vixData.current}</span>
                <span className={`change ${parseFloat(vixData.change) >= 0 ? 'positive' : 'negative'}`}>
                  {vixData.change >= 0 ? '+' : ''}{vixData.change} ({vixData.changePercent}%)
                </span>
              </div>
            </div>
            <div className="vix-details">
              <div className="detail-item">
                <span className="label">High:</span>
                <span className="value">{vixData.high}</span>
              </div>
              <div className="detail-item">
                <span className="label">Low:</span>
                <span className="value">{vixData.low}</span>
              </div>
              <div className="detail-item">
                <span className="label">Open:</span>
                <span className="value">{vixData.open}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="graph-placeholder">
            {selectedVolatility === 'VIX' ? 'VIX data will appear here' : `${selectedVolatility} data not available yet`}
          </div>
        )}
      </div>
    </div>
  );
};

export default VolatilityPanel;
