import React, { useState, useEffect } from 'react';
import USDProxies from './USDProxies';
import USDCorrelationMatrix from './USDCorrelationMatrix';
import { USDMarketService } from '../../services/api/usdMarketService';
import { REFRESH_INTERVALS } from '../../constants/usdMarket';

const USDMacroDashboard = () => {
  const [data, setData] = useState({
    dxy: null,
    currencyPairs: null,
    correlations: null,
    rollingStats: null
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchUSDData = async () => {
    try {
      setError(null);
      const usdData = await USDMarketService.getAllUSDData();
      
      setData({
        dxy: usdData.dxy,
        currencyPairs: usdData.currencyPairs,
        correlations: usdData.correlations?.correlations || null,
        rollingStats: usdData.correlations?.rollingStats || null
      });
      
      setLastUpdated(new Date());
    } catch (err) {
      console.error('Error fetching USD data:', err);
      setError(err.message || 'Failed to fetch USD data');
    } finally {
      setLoading(false);
    }
  };

  // Initial data fetch
  useEffect(() => {
    fetchUSDData();
  }, []);

  // Set up refresh interval
  useEffect(() => {
    const interval = setInterval(() => {
      fetchUSDData();
    }, REFRESH_INTERVALS.DASHBOARD);

    return () => clearInterval(interval);
  }, []);

  // Manual refresh function
  const handleRefresh = () => {
    setLoading(true);
    fetchUSDData();
  };

  return (
    <div className="usd-macro-dashboard">
      <div className="dashboard-header">
        <h2>USD Macro Dashboard</h2>
        <div className="header-controls">
          {lastUpdated && (
            <span className="last-updated">
              Last updated: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button 
            className="refresh-button"
            onClick={handleRefresh}
            disabled={loading}
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="dashboard-content">
        {/* USD Proxies Section */}
        <USDProxies
          dxy={data.dxy}
          currencyPairs={data.currencyPairs}
          loading={loading}
          error={error}
        />

        {/* Correlation Matrix Section */}
        <USDCorrelationMatrix
          correlations={data.correlations}
          rollingStats={data.rollingStats}
          loading={loading}
          error={error}
        />
      </div>

      {/* Error overlay */}
      {error && (
        <div className="error-overlay">
          <div className="error-message">
            <h4>Error Loading USD Data</h4>
            <p>{error}</p>
            <button onClick={handleRefresh} className="retry-button">
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default USDMacroDashboard;
