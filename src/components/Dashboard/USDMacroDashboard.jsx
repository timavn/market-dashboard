import React, { useState, useEffect } from 'react';
import { Card, Title, Text } from '@tremor/react';
import USDCorrelationMatrix from './USDCorrelationMatrix';
import USQuadChart from './USQuadChart';
import WelcomeToTheMachine from './WelcomeToTheMachine';
import MultiRegionMarketOverview from './MultiRegionMarketOverview';
import GlobalMarketDayCycleHeader from './GlobalMarketDayCycleHeader';
import DailyNotepad from './DailyNotepad';
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

      {/* Events/Signals and Daily Notepad - Side by Side */}
      <div className="flex flex-col md:flex-row gap-4" style={{ alignItems: 'stretch' }}>
        {/* Left: Events & Signals */}
        <div className="flex-1">
          <Card className="dark:bg-gray-800 rounded-lg" style={{ height: '100%' }}>
            <Title className="mb-4 dark:text-white">Events & Signals</Title>
            <div className="space-y-3">
              <div>
                <Text className="text-sm font-semibold mb-2 dark:text-gray-300">Market Events</Text>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-600 dark:text-gray-400">
                  <li>Placeholder for significant market events</li>
                  <li>Economic data releases and surprises</li>
                  <li>Central bank announcements</li>
                </ul>
              </div>
              <div>
                <Text className="text-sm font-semibold mb-2 dark:text-gray-300">Outlier Signals</Text>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-600 dark:text-gray-400">
                  <li>Placeholder for outlier price movements</li>
                  <li>Unusual volume spikes</li>
                  <li>Volatility breakouts</li>
                </ul>
              </div>
              <div>
                <Text className="text-sm font-semibold mb-2 dark:text-gray-300">Important Indicators</Text>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-600 dark:text-gray-400">
                  <li>Placeholder for key indicator signals</li>
                  <li>Risk range violations</li>
                  <li>Correlation breakdowns</li>
                </ul>
              </div>
              <div className="pt-3 border-t dark:border-gray-700">
                <Text className="text-sm font-semibold mb-2 dark:text-gray-300">Previous Week Portfolio Summary</Text>
                <Text className="text-sm text-gray-600 dark:text-gray-400">
                  Placeholder for weekly portfolio summary including currency market review, signals, and positioning updates. 
                  Example: Global currency market analysis, position performance, and trend signals across major pairs.
                </Text>
              </div>
            </div>
          </Card>
        </div>

        {/* Right: Daily Notepad */}
        <div className="flex-1">
          <DailyNotepad />
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
