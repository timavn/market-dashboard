import React from 'react';
import { USD_METRICS, CORRELATION_PERIODS } from '../../constants/usdMarket';
import { CorrelationHelpers } from '../../services/api/usdMarketService';
import './USDCorrelationMatrix.css';

const USDCorrelationMatrix = ({ correlations, rollingStats, loading, error }) => {
  if (loading) {
    return (
      <div className="correlation-matrix-container">
        <div className="correlation-matrix-header">
          <h3>Key $USD Correlations</h3>
          <p className="subtitle">*Days = Trading Days*</p>
        </div>
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading correlation data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="correlation-matrix-container">
        <div className="correlation-matrix-header">
          <h3>Key $USD Correlations</h3>
          <p className="subtitle">*Days = Trading Days*</p>
        </div>
        <div className="error-state">
          <p>Error loading correlation data: {error}</p>
        </div>
      </div>
    );
  }

  if (!correlations || !rollingStats) {
    return (
      <div className="correlation-matrix-container">
        <div className="correlation-matrix-header">
          <h3>Key $USD Correlations</h3>
          <p className="subtitle">*Days = Trading Days*</p>
        </div>
        <div className="no-data-state">
          <p>No correlation data available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="correlation-matrix-container">
      <div className="correlation-matrix-header">
        <h3>Key $USD Correlations</h3>
        <p className="subtitle">*Days = Trading Days*</p>
      </div>
      
      <div className="correlation-matrix">
        <table className="correlation-table">
          <thead>
            <tr className="header-row">
              <th className="metric-column">METRIC</th>
              {CORRELATION_PERIODS.map(period => (
                <th key={period} className="period-column">{period}D</th>
              ))}
              <th colSpan="4" className="rolling-header">52-Wk Rolling 30D Correlation</th>
            </tr>
            <tr className="subheader-row">
              <th></th>
              {CORRELATION_PERIODS.map(period => (
                <th key={period}></th>
              ))}
              <th className="rolling-subheader">High</th>
              <th className="rolling-subheader">Low</th>
              <th className="rolling-subheader">% Time Pos</th>
              <th className="rolling-subheader">% Time Neg</th>
            </tr>
          </thead>
          <tbody>
            {USD_METRICS.map(metric => {
              const metricCorrelations = correlations[metric.symbol] || {};
              const metricRollingStats = rollingStats[metric.symbol] || {};
              
              return (
                <tr key={metric.symbol} className="data-row">
                  <td className="metric-name">{metric.name}</td>
                  
                  {/* Correlation periods */}
                  {CORRELATION_PERIODS.map(period => {
                    const correlation = metricCorrelations[`${period}D`];
                    const colorClass = CorrelationHelpers.getCorrelationColor(correlation);
                    const displayValue = CorrelationHelpers.formatCorrelation(correlation);
                    
                    return (
                      <td 
                        key={period} 
                        className={`correlation-cell ${colorClass}`}
                        title={`${metric.name} vs USD (${period}D): ${displayValue}`}
                      >
                        {displayValue}
                      </td>
                    );
                  })}
                  
                  {/* Rolling statistics */}
                  <td className="rolling-stat high">
                    {CorrelationHelpers.formatCorrelation(metricRollingStats.high)}
                  </td>
                  <td className="rolling-stat low">
                    {CorrelationHelpers.formatCorrelation(metricRollingStats.low)}
                  </td>
                  <td className="rolling-stat percent-positive">
                    {CorrelationHelpers.formatPercentage(metricRollingStats.percentTimePositive)}
                  </td>
                  <td className="rolling-stat percent-negative">
                    {CorrelationHelpers.formatPercentage(metricRollingStats.percentTimeNegative)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      
      <div className="correlation-legend">
        <div className="legend-item">
          <span className="legend-color positive-strong"></span>
          <span>Strong Positive (>0.3)</span>
        </div>
        <div className="legend-item">
          <span className="legend-color positive-weak"></span>
          <span>Weak Positive (0.1-0.3)</span>
        </div>
        <div className="legend-item">
          <span className="legend-color neutral"></span>
          <span>Neutral (-0.1-0.1)</span>
        </div>
        <div className="legend-item">
          <span className="legend-color negative-weak"></span>
          <span>Weak Negative (-0.3 to -0.1)</span>
        </div>
        <div className="legend-item">
          <span className="legend-color negative-medium"></span>
          <span>Medium Negative (-0.6 to -0.3)</span>
        </div>
        <div className="legend-item">
          <span className="legend-color negative-strong"></span>
          <span>Strong Negative (&lt;-0.6)</span>
        </div>
      </div>
    </div>
  );
};

export default USDCorrelationMatrix;
