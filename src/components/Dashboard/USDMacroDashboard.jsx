import React, { useState, useEffect } from 'react';
import { Card, Title, Text, Button, Flex } from '@tremor/react';
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
    <div className="space-y-4">
      <Card>
        <Flex justifyContent="between" alignItems="center">
          <Title>USD Macro Dashboard</Title>
          <Flex className="gap-3" alignItems="center">
            {lastUpdated && (
              <Text className="text-xs text-gray-500">
                Last updated: {lastUpdated.toLocaleTimeString()}
              </Text>
            )}
            <Button 
              onClick={handleRefresh}
              disabled={loading}
              size="xs"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </Button>
          </Flex>
        </Flex>
      </Card>

      <div className="space-y-4">
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
        <Card className="bg-red-50 border-red-200">
          <Title className="text-red-600">Error Loading USD Data</Title>
          <Text className="mb-4">{error}</Text>
          <Button onClick={handleRefresh} color="red" size="xs">
            Retry
          </Button>
        </Card>
      )}
    </div>
  );
};

export default USDMacroDashboard;
