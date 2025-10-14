import React, { useState, useEffect } from 'react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { CorrelationHelpers, USDMarketService } from '../../services/api/usdMarketService';
import './USDProxies.css';

const USDProxies = ({ dxy, currencyPairs, loading, error }) => {
  const [historicalData, setHistoricalData] = useState({});
  const [timeframes, setTimeframes] = useState({});

  // Initialize timeframes for each currency pair
  useEffect(() => {
    if (currencyPairs) {
      const initialTimeframes = {};
      currencyPairs.forEach(pair => {
        initialTimeframes[pair.pair] = 30; // Default to 30 days
      });
      setTimeframes(initialTimeframes);
    }
  }, [currencyPairs]);

  // Fetch historical data when timeframes change
  useEffect(() => {
    const fetchHistoricalData = async () => {
      if (!currencyPairs) return;

      const promises = currencyPairs.map(async (pair) => {
        const timeframe = timeframes[pair.pair] || 30;
        try {
          const data = await USDMarketService.getHistoricalData(pair.pair, timeframe);
          return { pair: pair.pair, data: data.data || [] };
        } catch (err) {
          console.error(`Error fetching historical data for ${pair.pair}:`, err);
          return { pair: pair.pair, data: [] };
        }
      });

      const results = await Promise.all(promises);
      const dataMap = {};
      results.forEach(result => {
        dataMap[result.pair] = result.data;
      });
      setHistoricalData(dataMap);
    };

    fetchHistoricalData();
  }, [currencyPairs, timeframes]);

  const handleTimeframeChange = (pair, newTimeframe) => {
    setTimeframes(prev => ({
      ...prev,
      [pair]: parseInt(newTimeframe)
    }));
  };

  const MiniSparkline = ({ data, isPositive }) => {
    if (!data || data.length === 0) {
      return <div className="mini-chart-placeholder">No data</div>;
    }

    const chartData = data.map(item => ({
      value: parseFloat(item.close)
    }));

    return (
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={chartData}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={isPositive ? '#10B981' : '#EF4444'}
            strokeWidth={1.3}
            dot={false}
            activeDot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    );
  };

  if (loading) {
    return (
      <div className="usd-proxies-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading USD data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="usd-proxies-container">
        <div className="error-state">
          <p>Error loading USD data: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="usd-proxies-container">
      <div className="usd-proxies-content">
        {/* DXY Highlight - Left Side */}
        <div className="dxy-section">
          <div className="dxy-highlight">
            <div className="dxy-label">DXY</div>
            <div className="dxy-value">
              {dxy?.value ? dxy.value.toFixed(2) : '--'}
            </div>
            <div className={`dxy-change ${CorrelationHelpers.getChangeColor(dxy?.change)}`}>
              {CorrelationHelpers.formatChange(dxy?.change)} ({CorrelationHelpers.formatChangePercent(dxy?.changePercent)})
            </div>
          </div>
        </div>

        {/* Currency Pairs Grid - Right Side */}
        <div className="currency-section">
          <div className="currency-grid">
            {currencyPairs?.map((pair) => {
              const isPositive = parseFloat(pair.change) >= 0;
              const pairData = historicalData[pair.pair] || [];
              
              return (
                <div key={pair.pair} className="currency-pair">
                  <div className="pair-header">
                    <div className="pair-name">{pair.name}</div>
                    <select
                      className="timeframe-select"
                      value={timeframes[pair.pair] || 30}
                      onChange={(e) => handleTimeframeChange(pair.pair, e.target.value)}
                    >
                      <option value={7}>1W</option>
                      <option value={30}>1M</option>
                      <option value={90}>3M</option>
                      <option value={180}>6M</option>
                      <option value={365}>1Y</option>
                    </select>
                  </div>
                  <div className="pair-rate">{pair.rate}</div>
                  <div className="mini-chart">
                    <MiniSparkline data={pairData} isPositive={isPositive} />
                  </div>
                  <div className={`pair-change ${CorrelationHelpers.getChangeColor(pair.change)}`}>
                    {CorrelationHelpers.formatChangePercent(pair.changePercent)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Last Updated */}
      {(dxy?.timestamp || currencyPairs?.[0]?.timestamp) && (
        <div className="last-updated">
          Last updated: {new Date(dxy?.timestamp || currencyPairs[0]?.timestamp).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
};

export default USDProxies;
