import React, { useState } from 'react';
import './VolatilityPanel.css';

const VolatilityPanel = () => {
  const [selectedVolatility, setSelectedVolatility] = useState('VIX');
  const [selectedTimeframe, setSelectedTimeframe] = useState('1D');

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
        <div className="header-cell range-info">
          {getVolatilityRanges(selectedVolatility)}
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
        <div className="graph-placeholder">
          Graph
        </div>
      </div>
    </div>
  );
};

export default VolatilityPanel;
