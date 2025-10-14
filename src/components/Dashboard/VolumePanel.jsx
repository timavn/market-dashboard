import React, { useState } from 'react';
import './VolumePanel.css';

const VolumePanel = () => {
  const [selectedVolume, setSelectedVolume] = useState('SPY');
  const [selectedTimeframe, setSelectedTimeframe] = useState('1D');

  const volumeOptions = [
    { value: 'SPY', label: 'SPY' },
    { value: 'QQQ', label: 'QQQ' },
    { value: 'IWM', label: 'IWM' },
    { value: 'DIA', label: 'DIA' },
    { value: 'VTI', label: 'VTI' },
    { value: 'EFA', label: 'EFA' },
    { value: 'EEM', label: 'EEM' },
    { value: 'GLD', label: 'GLD' },
    { value: 'SLV', label: 'SLV' },
    { value: 'USO', label: 'USO' },
    { value: 'TLT', label: 'TLT' },
    { value: 'HYG', label: 'HYG' }
  ];

  const timeframeOptions = [
    { value: '1D', label: '1D' },
    { value: '1W', label: '1W' },
    { value: '1M', label: '1M' },
    { value: '3M', label: '3M' },
    { value: '6M', label: '6M' },
    { value: '1Y', label: '1Y' }
  ];

  return (
    <div className="volume-panel">
      <div className="volume-header">
        <div className="header-cell">
          <select 
            value={selectedVolume} 
            onChange={(e) => setSelectedVolume(e.target.value)}
            className="volume-select"
          >
            {volumeOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
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
      <div className="volume-content">
        <div className="graph-placeholder">
          Graph
        </div>
      </div>
    </div>
  );
};

export default VolumePanel;
