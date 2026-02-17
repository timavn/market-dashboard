import React, { useState, useEffect } from 'react';
import { Card, Title, Text } from '@tremor/react';
import USDCorrelationMatrix from './USDCorrelationMatrix';
import USQuadChart from './USQuadChart';
import WelcomeToTheMachine from './WelcomeToTheMachine';
import MultiRegionMarketOverview from './MultiRegionMarketOverview';
import GlobalMarketDayCycleHeader from './GlobalMarketDayCycleHeader';
import FXLayoutsShowcase from './FXLayoutsShowcase';
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

  return (
    <div className="space-y-4">
      {/* Global Market Day-Cycle Header */}
      <GlobalMarketDayCycleHeader />

      {/* Banner with Title and Metric Bar */}
      <Card className="dark:bg-gray-800 relative macro-dashboard-card rounded-lg">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <MultiRegionMarketOverview />
        </div>
      </Card>

      {/* MACRO and THE CALL - Side by Side */}
      <div className="flex flex-col md:flex-row gap-4" style={{ alignItems: 'stretch' }}>
        {/* Left: MACRO */}
        <div className="flex-1 macro-call-card">
          <Card className="dark:bg-gray-800 rounded-lg" style={{ height: '100%' }}>
            <div className="macro-call-header">
              <span className="region-status-emoji" title="Active">🟢</span>
              <span className="region-label dark:text-white">MACRO</span>
              <div className="macro-call-long-short">
                <div className="macro-call-row long">LONG:</div>
                <div className="macro-call-row short">SHORT:</div>
              </div>
            </div>
            <div className="macro-call-body">
              {/* Empty - populated from Hedgeye Macro Show summary */}
            </div>
          </Card>
        </div>

        {/* Right: THE CALL */}
        <div className="flex-1 macro-call-card">
          <Card className="dark:bg-gray-800 rounded-lg" style={{ height: '100%' }}>
            <div className="macro-call-header">
              <span className="region-status-emoji" title="Active">🟢</span>
              <span className="region-label dark:text-white">THE CALL</span>
              <div className="macro-call-long-short">
                <div className="macro-call-row long">LONG:</div>
                <div className="macro-call-row short">SHORT:</div>
              </div>
            </div>
            <div className="macro-call-body">
              {/* Empty - populated from Hedgeye analyst call summary */}
            </div>
          </Card>
        </div>
      </div>

      <div className="space-y-4">
        {/* FX Layouts Showcase */}
        <FXLayoutsShowcase
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

        {/* US Quad Charts Section */}
        <USQuadChart />

        {/* Welcome to the Machine Section */}
        <WelcomeToTheMachine />
      </div>

      {/* Error overlay */}
      {error && (
        <Card className="bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800 rounded-lg">
          <Title className="text-red-600 dark:text-red-400">Error Loading USD Data</Title>
          <Text className="mb-4 dark:text-gray-300">{error}</Text>
        </Card>
      )}
    </div>
  );
};

export default USDMacroDashboard;
