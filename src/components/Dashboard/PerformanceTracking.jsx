import React, { useState, useMemo, useEffect } from 'react';
import { Card, Text } from '@tremor/react';
import { useTheme } from '../../context/ThemeContext';
import SecurityDetailModal from './SecurityDetailModal';
import PortfolioPerformanceDashboard from './PortfolioPerformanceDashboard';
import RealizedGainLossBubbleChart from './RealizedGainLossBubbleChart';
import PerformanceService from '../../services/api/performanceService';
import { SECURITIES_LIST, ASSET_CLASS_NAMES } from '../../constants/securitiesList';
import { filterSecurities, getGicsSector, mapAssetClassToFactor } from '../../utils/securitiesUniverseUtils';
import { computeKPIs } from '../../utils/realizedGainLossUtils';
import './PerformanceTracking.css';

const PerformanceTracking = () => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [selectedSecurity, setSelectedSecurity] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [realizedLots, setRealizedLots] = useState([]);
  const [realizedLoading, setRealizedLoading] = useState(true);
  const [realizedError, setRealizedError] = useState(null);

  const rows = useMemo(
    () => [...SECURITIES_LIST].sort((a, b) => a.ticker.localeCompare(b.ticker, undefined, { sensitivity: 'base' })),
    []
  );

  const displayRows = useMemo(
    () => filterSecurities(rows, searchQuery),
    [rows, searchQuery]
  );

  useEffect(() => {
    let cancelled = false;
    setRealizedLoading(true);
    setRealizedError(null);
    PerformanceService.getRealizedGainLoss({ period: 'ytd' })
      .then((data) => {
        if (!cancelled) {
          setRealizedLots(Array.isArray(data?.lots) ? data.lots : []);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setRealizedError(err?.response?.data?.error || err?.message || 'Failed to load realized gain/loss');
        }
      })
      .finally(() => {
        if (!cancelled) setRealizedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const clearAllFilters = () => {
    setSearchQuery('');
  };

  const realizedKPIs = useMemo(() => computeKPIs(realizedLots), [realizedLots]);

  return (
    <div
      className="performance-tracking-wrap p-2 space-y-2"
      style={{ backgroundColor: isDark ? '#111827' : '#f9fafb' }}
    >
      <div className="px-1">
        <PortfolioPerformanceDashboard isDark={isDark} realizedKPIs={realizedKPIs} />
        
        <RealizedGainLossBubbleChart
          lots={realizedLots}
          searchQuery={searchQuery}
          loading={realizedLoading}
          error={realizedError}
          isDark={isDark}
        />
        {/* Match SecuritiesUniverse: centered search, summary, clear link */}
        <div className="flex flex-col items-center mb-2">
          <div style={{ width: '100%', maxWidth: '400px' }}>
            <input
              type="text"
              placeholder="Search by ticker, name, asset class, sector, factor exposure, benchmark..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3 py-1.5 border border-[#e5e7eb] dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#d1d5db]"
              style={{ fontSize: '14px' }}
            />
          </div>
          <div className="flex flex-col items-center gap-0.5 mt-1">
            <Text className="text-sm text-gray-500 dark:text-gray-400 font-medium m-0">
              {`Showing ${displayRows.length} of ${rows.length} securities`}
            </Text>
            <button
              type="button"
              onClick={clearAllFilters}
              className="text-xs text-blue-600 hover:text-blue-800 underline decoration-blue-300 underline-offset-2"
            >
              Clear all filters
            </button>
          </div>
        </div>
      </div>

      <Card
        className="rounded-lg p-0 overflow-hidden"
        style={{ backgroundColor: isDark ? '#1f2937' : '#f9fafb', border: '1px solid #e5e7eb' }}
      >
        <div
          className="performance-list-header flex flex-wrap sm:flex-nowrap items-baseline gap-x-3 gap-y-0.5 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-[#e5e7eb] dark:border-gray-600 bg-[#f9fafb] dark:bg-gray-800/90"
          aria-hidden
        >
          <span className="w-16 flex-shrink-0">Symbol</span>
          <span className="flex-1 min-w-[5rem]">Name</span>
          <span className="w-24 sm:w-28 flex-shrink-0">Class</span>
          <span className="w-28 sm:w-32 flex-shrink-0">Factor</span>
          <span className="w-[6.5rem] sm:w-32 flex-shrink-0">Sector</span>
        </div>
        {displayRows.map((row) => {
          const sector = getGicsSector(row.ticker);
          const assetClassName = ASSET_CLASS_NAMES[row.assetClass] || row.assetClass;
          const factorExposure = mapAssetClassToFactor(row.assetClass, row.ticker, row.name);
          return (
            <button
              key={row.ticker}
              type="button"
              onClick={() => {
                setSelectedSecurity(row.ticker);
                setIsModalOpen(true);
              }}
              className="performance-universe-row w-full text-left flex flex-wrap sm:flex-nowrap items-baseline gap-x-2 sm:gap-x-3 gap-y-0.5 px-2 py-1.5 border-b border-[#f3f4f6] dark:border-gray-600 hover:bg-[#f3f4f6] dark:hover:bg-gray-800/80 transition-colors"
            >
              <span className="font-semibold text-blue-600 dark:text-blue-400 w-16 flex-shrink-0">
                {row.ticker}
              </span>
              <span
                className="text-sm text-gray-700 dark:text-gray-300 flex-1 min-w-0 line-clamp-2 sm:line-clamp-1 text-left"
                title={row.name}
              >
                {row.name}
              </span>
              <span
                className="text-sm text-gray-600 dark:text-gray-400 w-24 sm:w-28 flex-shrink-0 text-left truncate"
                title={assetClassName}
              >
                {assetClassName}
              </span>
              <span
                className="text-sm text-gray-600 dark:text-gray-400 w-28 sm:w-32 flex-shrink-0 text-left truncate"
                title={factorExposure}
              >
                {factorExposure}
              </span>
              <span
                className="text-sm text-gray-600 dark:text-gray-400 w-[6.5rem] sm:w-32 flex-shrink-0 text-left truncate"
                title={sector}
              >
                {sector}
              </span>
            </button>
          );
        })}
      </Card>

      <SecurityDetailModal
        ticker={selectedSecurity}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </div>
  );
};

export default PerformanceTracking;
