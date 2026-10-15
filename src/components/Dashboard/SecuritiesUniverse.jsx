import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Card, Title, Text, Badge } from '@tremor/react';
import { SECURITIES_LIST, ASSET_CLASS_NAMES } from '../../constants/securitiesList';
import { MarketDataService } from '../../services/api/marketDataService';
import { SECURITY_INTELLIGENCE_V2_ENABLED } from '../../hooks/useSecurityIntelligence';
import { canonicalProductState, getCanonicalRiskRange } from '../../utils/securityIntelligenceV2';
import { filterSecurities } from '../../utils/securitiesUniverseUtils';
import {
  enrichSecuritiesList,
  buildTradingDays,
  getTradingDayKeys,
} from '../../utils/enrichSecurity';
import SecuritiesUniverseMetricsRow from './securitiesUniverse/SecuritiesUniverseMetricsRow';
import { METRIC_DEFINITIONS } from '../../constants/metricDefinitions';
import MetricDefinitionPopover from '../common/MetricDefinitionPopover';
import { useSurfaceActivity } from '../common/PersistentSurface';
import useHedgaiTickResearch from '../../hooks/useHedgaiTickResearch';
import {
  FileText,
  Activity,
  BarChart3,
  AreaChart,
  SlidersHorizontal,
  Percent,
  // Sigma, // Lucide doesn't have Sigma in all versions, using FunctionSquare as fallback if needed or custom path
  FunctionSquare,
  LineChart,
  Type,
  LayoutGrid,
  DollarSign,
  ArrowUp,
  ArrowDown,
  TrendingUp
} from 'lucide-react';

// Day label component with hover tooltip
const DayLabelWithTooltip = ({ label, date, isLast = false }) => {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div
      style={{
        width: isLast ? '32px' : '28px',
        textAlign: 'center',
        fontSize: '8px',
        color: '#6b7280',
        backgroundColor: '#f9fafb',
        borderRadius: '2px',
        padding: '2px 2px',
        position: 'relative'
      }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {label}
      {showTooltip && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: '#1f2937',
            color: '#fff',
            padding: '4px 8px',
            borderRadius: '4px',
            fontSize: '10px',
            whiteSpace: 'nowrap',
            zIndex: 1000,
            marginBottom: '4px',
            pointerEvents: 'none'
          }}
        >
          {date}
        </div>
      )}
    </div>
  );
};

const SecuritiesUniverse = () => {
  const active = useSurfaceActivity();
  const { readings: tickReadings } = useHedgaiTickResearch({ active });
  const [searchQuery, setSearchQuery] = useState('');
  const [prices, setPrices] = useState({});
  const [priceHistory, setPriceHistory] = useState({});
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState([]); // Array of { key, direction } objects
  const [activeFilters, setActiveFilters] = useState({
    assetClasses: [],
    factorExposures: [],
    biases: []
  });
  const [selectedQuad, setSelectedQuad] = useState(null);
  const [shortsMode, setShortsMode] = useState(false); // false = longs (best quads), true = shorts (worst quads)
  const [openPopover, setOpenPopover] = useState(null); // { metricKey, position: { top, left } }
  const [riskRanges, setRiskRanges] = useState({});
  const [securityIntelligence, setSecurityIntelligence] = useState({});

  // Fetch Risk Ranges
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const fetchRiskRanges = async () => {
      try {
        if (SECURITY_INTELLIGENCE_V2_ENABLED) {
          // Clear the prior current-day projection before a new verification
          // attempt so a failed refresh cannot retain stale ranges.
          setRiskRanges({});
          setSecurityIntelligence({});
          const bySymbol = {};
          let cursor = null;
          do {
            const payload = await MarketDataService.getSecurityIntelligenceUniverseV2({
              limit: 200,
              cursor,
            });
            if (payload?.schemaVersion !== 2) {
              throw new Error('Canonical security universe returned an unsupported schema.');
            }
            Object.assign(bySymbol, payload.bySymbol || {});
            cursor = payload.page?.nextCursor || null;
          } while (cursor && !cancelled);
          const nextRanges = {};
          const nextIntelligence = {};
          SECURITIES_LIST.forEach((security) => {
            const ticker = security.ticker.toUpperCase();
            const entry = bySymbol[ticker] || null;
            const product = entry?.products?.['risk-ranges'] || null;
            const range = getCanonicalRiskRange(entry, { primaryOnly: true });
            const status = product ? canonicalProductState(product) : 'not_listed';
            nextRanges[ticker] = range
              ? [{ ...range, date: range.date, status }]
              : [];
            nextIntelligence[ticker] = {
              health: entry?.health?.status || 'attention',
              status,
            };
          });
          if (!cancelled) {
            setRiskRanges(nextRanges);
            setSecurityIntelligence(nextIntelligence);
          }
          return;
        }
        // Fetch full history from bulk endpoint
        const historyData = await MarketDataService.getAllRiskRangeHistory();
        if (!cancelled && historyData) {
          setRiskRanges(historyData); // Stores { ticker: [history array] }
          setSecurityIntelligence({});
        }
      } catch (error) {
        console.error('Error fetching risk ranges:', error);
        if (!cancelled && SECURITY_INTELLIGENCE_V2_ENABLED) {
          setRiskRanges(Object.fromEntries(SECURITIES_LIST.map((security) => [security.ticker.toUpperCase(), []])));
          setSecurityIntelligence(Object.fromEntries(SECURITIES_LIST.map((security) => [security.ticker.toUpperCase(), {
            health: 'unavailable', status: 'unavailable',
          }])));
        }
      }
    };
    fetchRiskRanges();
    return () => { cancelled = true; };
  }, [active]);

  // Fetch prices for all securities (non-blocking - show table even if prices fail)
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const fetchPrices = async () => {
      try {
        // Set loading to false immediately so table shows, then load prices in background
        setLoading(false);

        const tickers = SECURITIES_LIST.map(s => s.ticker);

        // Fetch quotes in smaller batches to avoid rate limiting
        const batchSize = 20; // Smaller batches
        const allQuotes = {};
        let failed = false;

        for (let i = 0; i < tickers.length; i += batchSize) {
          if (cancelled) return;
          const batch = tickers.slice(i, i + batchSize);
          try {
            const quotes = await MarketDataService.getQuotes(batch);
            if (quotes && typeof quotes === 'object') {
              Object.assign(allQuotes, quotes);
            }
            // Small delay between batches
            if (i + batchSize < tickers.length) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          } catch (error) {
            console.error(`Error fetching batch ${i}-${i + batchSize}:`, error);
            failed = true;
          }
        }

        if (cancelled) return;
        // Quotes are live evidence. A partial provider failure cannot leave a
        // mixture of old and new executable-looking values on screen.
        setPrices(failed ? {} : allQuotes);
        console.log(`Loaded prices for ${Object.keys(allQuotes).length} securities`);
      } catch (error) {
        console.error('Error fetching prices:', error);
        // Don't block UI - prices will show as '--' if unavailable
      }
    };

    fetchPrices();
    return () => { cancelled = true; };
  }, [active]);

  // Fetch price history for Z-score calculation (for a sample, can be enhanced to fetch all)
  useEffect(() => {
    if (!active || loading) return undefined;
    let cancelled = false;
    const fetchPriceHistory = async () => {
      try {
        // Fetch history for all securities
        const allTickers = SECURITIES_LIST.map(s => s.ticker);
        const historyData = {};

        // Fetch in parallel with delay to avoid rate limiting
        const fetchWithDelay = async (ticker, delay) => {
          await new Promise(resolve => setTimeout(resolve, delay));
          if (cancelled) return;
          try {
            // Fetch 30 days to give ATR(14) enough valid data points
            const history = await MarketDataService.getHistoricalData(ticker, 30);
            if (history && history.data && Array.isArray(history.data)) {
              historyData[ticker] = history.data;
            }
          } catch (error) {
            // Silently fail for individual securities
            console.debug(`No history for ${ticker}`);
          }
        };

        // Fetch in batches of 10 to act as a rolling window
        const batchSize = 10;
        for (let i = 0; i < allTickers.length; i += batchSize) {
          if (cancelled) return;
          const batch = allTickers.slice(i, i + batchSize);
          const promises = batch.map((ticker, index) =>
            fetchWithDelay(ticker, index * 50) // 50ms stagger within batch
          );

          await Promise.all(promises);

          // Update state incrementally so results stream in
          if (!cancelled) setPriceHistory(prev => ({ ...prev, ...historyData }));

          // Wait a bit between batches
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (error) {
        console.error('Error fetching price history:', error);
      }
    };

    fetchPriceHistory();
    return () => { cancelled = true; };
  }, [active, loading]);

  const tradingDays = useMemo(() => buildTradingDays(), []);
  const tradingDayKeys = useMemo(() => getTradingDayKeys(tradingDays), [tradingDays]);

  const enrichedSecurities = useMemo(
    () => enrichSecuritiesList(SECURITIES_LIST, {
        prices,
        priceHistory,
        riskRanges,
        tradingDayKeys,
      }).map((security) => {
        const intelligence = securityIntelligence[security.ticker.toUpperCase()] || null;
        const currentRange = security.riskRangeHistory?.current;
        const canonicalTrend = currentRange?.trend || null;
        return {
          ...security,
          tickResearch: tickReadings[security.ticker.toUpperCase()] || null,
          riskRangeHistory: {
            ...security.riskRangeHistory,
            status: intelligence?.status || security.riskRangeHistory?.status || null,
          },
          bias: canonicalTrend || (SECURITY_INTELLIGENCE_V2_ENABLED ? null : security.signal),
          signal: canonicalTrend || (SECURITY_INTELLIGENCE_V2_ENABLED ? null : security.signal),
          researchHealth: intelligence?.health || null,
          researchStatus: intelligence?.status || null,
        };
      }),
    [prices, priceHistory, riskRanges, securityIntelligence, tradingDayKeys, tickReadings],
  );

  // Filter securities based on search query and active filters
  const filteredSecurities = useMemo(() => {
    let filtered = enrichedSecurities;

    // Apply search query filter
    if (searchQuery) {
      filtered = filterSecurities(filtered, searchQuery);
    }

    // Apply asset class filters
    if (activeFilters.assetClasses.length > 0) {
      filtered = filtered.filter(security => {
        const assetClassName = ASSET_CLASS_NAMES[security.assetClass] || security.assetClass;
        return activeFilters.assetClasses.includes(assetClassName);
      });
    }

    // Apply factor exposure filters
    if (activeFilters.factorExposures.length > 0) {
      filtered = filtered.filter(security =>
        activeFilters.factorExposures.includes(security.factorExposure)
      );
    }

    // Apply bias filters
    if (activeFilters.biases.length > 0) {
      filtered = filtered.filter(security =>
        activeFilters.biases.includes(security.bias)
      );
    }

    // Apply Quad filter
    if (selectedQuad !== null) {
      filtered = filtered.filter(security => {
        if (!security.quadRanking || security.quadRanking === '--') return false;
        const quads = security.quadRanking.split('/').map(q => parseInt(q));
        if (shortsMode) {
          // Shorts mode: Check if selected Quad is in worst positions (3rd or 4th)
          return quads[2] === selectedQuad || quads[3] === selectedQuad;
        } else {
          // Longs mode: Check if selected Quad is in best positions (1st or 2nd)
          return quads[0] === selectedQuad || quads[1] === selectedQuad;
        }
      });
    }

    return filtered;
  }, [enrichedSecurities, searchQuery, activeFilters, selectedQuad, shortsMode]);

  // Sort securities (supports multiple column sorting)
  const sortedSecurities = useMemo(() => {
    // ATR is not user-sortable; ignore if present (legacy or stray state)
    const effectiveSortConfig = sortConfig.filter(s => s.key !== 'atr');
    if (effectiveSortConfig.length === 0) {
      return filteredSecurities;
    }

    const sorted = [...filteredSecurities].sort((a, b) => {
      // Apply each sort in order
      for (const sort of effectiveSortConfig) {
        let aValue = a[sort.key];
        let bValue = b[sort.key];

        // Handle nested values
        if (sort.key === 'priceChanges') {
          aValue = a.priceChanges?.['1D'] || 0;
          bValue = b.priceChanges?.['1D'] || 0;
        }

        // Handle Quad ranking sorting (sort by first number in format "3/4/2/1")
        if (sort.key === 'quadRanking') {
          const aFirst = a.quadRanking && a.quadRanking !== '--' ? parseInt(a.quadRanking.split('/')[0]) : 999;
          const bFirst = b.quadRanking && b.quadRanking !== '--' ? parseInt(b.quadRanking.split('/')[0]) : 999;
          aValue = aFirst;
          bValue = bFirst;
        }

        // Handle T/T/T sorting (sort by bias: BULLISH > NEUTRAL > BEARISH)
        if (sort.key === 'bias') {
          const biasOrder = { 'BULLISH': 3, 'NEUTRAL': 2, 'BEARISH': 1 };
          aValue = biasOrder[a.bias] || 0;
          bValue = biasOrder[b.bias] || 0;
        }

        // Handle Risk Range sorting (sort by presence of data)
        if (sort.key === 'riskRangeHistory') {
          // Sort values: 1 for has data, 0 for no data
          aValue = (a.riskRangeHistory && a.riskRangeHistory.current) ? 1 : 0;
          bValue = (b.riskRangeHistory && b.riskRangeHistory.current) ? 1 : 0;
        }

        // Handle null/undefined
        if (aValue === null || aValue === undefined) aValue = '';
        if (bValue === null || bValue === undefined) bValue = '';

        // String compare (case-insensitive) only when both are strings; never call
        // toLowerCase on numbers — e.g. null ATR -> '' while peer row has a number
        if (typeof aValue === 'string' && typeof bValue === 'string') {
          aValue = aValue.toLowerCase();
          bValue = bValue.toLowerCase();
        }

        // Compare values
        if (aValue < bValue) {
          const result = sort.direction === 'asc' ? -1 : 1;
          if (result !== 0) return result;
        } else if (aValue > bValue) {
          const result = sort.direction === 'asc' ? 1 : -1;
          if (result !== 0) return result;
        }
        // If equal, continue to next sort criteria
      }
      return 0;
    });

    return sorted;
  }, [filteredSecurities, sortConfig]);

  // Handle column sort (toggle on/off, supports multiple columns)
  const handleSort = (key) => {
    if (key === 'atr') return;
    setSortConfig(prev => {
      const existingIndex = prev.findIndex(s => s.key === key);

      if (existingIndex >= 0) {
        // Column is already sorted - toggle direction or remove
        const existing = prev[existingIndex];
        if (existing.direction === 'asc') {
          // Change to desc
          const updated = [...prev];
          updated[existingIndex] = { ...existing, direction: 'desc' };
          return updated;
        } else {
          // Remove from sort
          return prev.filter((_, index) => index !== existingIndex);
        }
      } else {
        // Add new sort (ascending by default)
        return [...prev, { key, direction: 'asc' }];
      }
    });
  };

  // Get sort info for a column
  const getSortInfo = (key) => {
    const sortIndex = sortConfig.findIndex(s => s.key === key);
    if (sortIndex < 0) return null;
    return {
      direction: sortConfig[sortIndex].direction,
      order: sortIndex + 1 // 1-based order
    };
  };

  // Handle filter tag clicks
  const toggleFilter = (category, value) => {
    setActiveFilters(prev => {
      const currentFilters = prev[category] || [];
      const isActive = currentFilters.includes(value);

      return {
        ...prev,
        [category]: isActive
          ? currentFilters.filter(f => f !== value)
          : [...currentFilters, value]
      };
    });
  };


  // Clear all filters
  const clearAllFilters = () => {
    setActiveFilters({
      assetClasses: [],
      factorExposures: [],
      biases: []
    });
    setSelectedQuad(null);
    setShortsMode(false);
    setSearchQuery('');
  };

  // Handle metric definition popover on button click
  const handleMetricDefinitionClick = (e, metricKey) => {
    e.stopPropagation(); // Prevent sorting when clicking definition button

    const definition = METRIC_DEFINITIONS[metricKey];
    if (!definition) return;

    // If popover is already open for this metric, close it
    if (openPopover?.metricKey === metricKey) {
      setOpenPopover(null);
    } else {
      setOpenPopover({ metricKey, definition });
    }
  };

  const closePopover = () => {
    setOpenPopover(null);
  };

  return (
    <div style={{ padding: '8px 12px', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Search Bar centered, summary underneath centered */}
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
          <Text className="text-sm text-gray-500 dark:text-gray-400 font-medium">
            {`Showing ${filteredSecurities.length} of ${SECURITIES_LIST.length} securities`}
          </Text>
          <button
            onClick={clearAllFilters}
            className="text-xs text-blue-600 hover:text-blue-800 underline decoration-blue-300 underline-offset-2"
          >
            Clear all filters
          </button>
        </div>
      </div>

      {/* Filter Tags - Left: Asset Class + Factor Exposure; Right: Bias + Quad Filter (mirrored) */}
      <div className="flex flex-wrap justify-between items-start gap-4 mb-3">
        {/* Left column: Asset Class + Factor Exposure */}
        <div className="flex flex-col gap-2 items-start">
          {[
            {
              title: 'ASSET CLASS',
              icon: (
                <svg width="24" height="24" viewBox="0 0 24 24" className="text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 2 L12 12 L22 12" />
                </svg>
              ),
              options: ['CURRENCY/FX', 'FIXED INCOME', 'EQUITY', 'COMMODITY', 'CRYPTOCURRENCY'],
              activeValues: activeFilters.assetClasses.map(a => a.toUpperCase()),
              onSelect: (val) => {
                const originalMap = {
                  'CURRENCY/FX': 'Currency/FX',
                  'FIXED INCOME': 'Fixed Income',
                  'EQUITY': 'Equity',
                  'COMMODITY': 'Commodity',
                  'CRYPTOCURRENCY': 'Cryptocurrency'
                };
                toggleFilter('assetClasses', originalMap[val]);
              }
            },
            {
              title: 'FACTOR EXPOSURE',
              icon: <SlidersHorizontal size={24} strokeWidth={1.5} className="text-blue-500" />,
              options: ['GROWTH', 'VALUE', 'QUALITY', 'MOMENTUM', 'LOW VOLATILITY'],
              activeValues: activeFilters.factorExposures.map(f => f.toUpperCase()),
              onSelect: (val) => {
                const originalMap = {
                  'GROWTH': 'Growth',
                  'VALUE': 'Value',
                  'QUALITY': 'Quality',
                  'MOMENTUM': 'Momentum',
                  'LOW VOLATILITY': 'Low Volatility'
                };
                toggleFilter('factorExposures', originalMap[val]);
              }
            }
          ].map((section, idx) => (
            <div key={idx} className="flex gap-2">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <div className="flex-shrink-0 flex items-center justify-center" style={{ width: 24, height: 24 }}>
                    {section.icon}
                  </div>
                  <span className="text-xs font-semibold text-black uppercase tracking-wide leading-tight">{section.title}</span>
                </div>
                <div className="flex w-max">
                  {section.options.map((opt, i) => {
                    const isActive = section.activeValues.includes(opt);
                    const isFirst = i === 0;
                    const isLast = i === section.options.length - 1;
                    return (
                      <button
                        key={opt}
                        onClick={() => section.onSelect(opt)}
                        style={{
                          border: '1px solid #d1d5db',
                          padding: '4px 12px',
                          fontSize: '11px',
                          fontWeight: 600,
                          backgroundColor: isActive ? '#f3f4f6' : '#ffffff',
                          color: isActive ? '#111' : '#1e293b',
                          borderRightWidth: isLast ? '1px' : '0',
                          borderRadius: isFirst ? '4px 0 0 4px' : isLast ? '0 4px 4px 0' : '0',
                          cursor: 'pointer',
                          minWidth: '70px',
                          transition: 'background-color 0.1s'
                        }}
                        className="hover:bg-[#f3f4f6]"
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
        {/* Right column: Bias + Quad Filter (mirrored - right-aligned) */}
        <div className="flex flex-col gap-2 items-end">
          {[
            {
              title: 'BIAS',
              icon: (
                <svg width="24" height="24" viewBox="0 0 24 24" className="text-blue-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 4H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h2" />
                  <line x1="12" y1="4" x2="12" y2="20" />
                  <path d="M17 4h2c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2h-2" />
                </svg>
              ),
              options: ['BULLISH', 'BEARISH', 'NEUTRAL'],
              activeValues: activeFilters.biases,
              onSelect: (val) => toggleFilter('biases', val)
            },
            {
              title: 'QUAD FILTER',
              icon: <LayoutGrid size={24} className="text-blue-500" />,
              options: ['QUAD 1', 'QUAD 2', 'QUAD 3', 'QUAD 4'],
              activeValues: selectedQuad ? [`QUAD ${selectedQuad}`] : [],
              onSelect: (val) => {
                const num = parseInt(val.split(' ')[1]);
                setSelectedQuad(selectedQuad === num ? null : num);
              }
            }
          ].map((section, idx) => (
            <div key={idx} className="flex gap-2 flex-row-reverse">
              <div className="flex flex-col gap-0.5 items-end">
                <div className="flex items-center gap-2 flex-row-reverse">
                  <div className="flex-shrink-0 flex items-center justify-center" style={{ width: 24, height: 24 }}>
                    {section.icon}
                  </div>
                  <span className="text-xs font-semibold text-black uppercase tracking-wide leading-tight">{section.title}</span>
                </div>
                <div className="flex w-max">
                  {section.options.map((opt, i) => {
                    const isActive = section.activeValues.includes(opt);
                    const isFirst = i === 0;
                    const isLast = i === section.options.length - 1;
                    return (
                      <button
                        key={opt}
                        onClick={() => section.onSelect(opt)}
                        style={{
                          border: '1px solid #d1d5db',
                          padding: '4px 12px',
                          fontSize: '11px',
                          fontWeight: 600,
                          backgroundColor: isActive ? '#f3f4f6' : '#ffffff',
                          color: isActive ? '#111' : '#1e293b',
                          borderRightWidth: isLast ? '1px' : '0',
                          borderRadius: isFirst ? '4px 0 0 4px' : isLast ? '0 4px 4px 0' : '0',
                          cursor: 'pointer',
                          minWidth: '70px',
                          transition: 'background-color 0.1s'
                        }}
                        className="hover:bg-[#f3f4f6]"
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Data Table */}
      <Card className="dark:bg-gray-800 p-0 rounded-lg overflow-hidden" style={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', boxShadow: 'none', outline: 'none', flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ overflow: 'auto', flex: '1 1 auto', minHeight: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '8px' }}>
            <thead className="bg-[#f9fafb] text-slate-800">
              <tr style={{ borderTop: '1px solid #d1d5db', borderBottom: '1px solid #d1d5db' }}>
                {[
                  { key: 'ticker', label: 'Ticker', icon: <div style={{ height: '17px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 600 }} className="text-blue-500">ABC</div>, align: 'center', width: '45px' },
                  {
                    key: 'bias', label: 'Tick / Trend', icon: (
                      <svg width="17" height="17" viewBox="0 0 24 24" className="text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M7 4H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h2" />
                        <line x1="12" y1="4" x2="12" y2="20" />
                        <path d="M17 4h2c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2h-2" />
                      </svg>
                    ), align: 'center', infoParams: 'trend', width: '60px'
                  },
                  { key: 'riskRangeHistory', label: 'Risk Range', icon: <div style={{ height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '17px', fontWeight: 600 }} className="text-blue-500">RR</div>, align: 'center', infoParams: 'riskRange', width: '400px' },
                  { key: 'ivolPrem', label: 'IVOL Prem', icon: <Percent size={22} className="text-blue-500" />, align: 'center', infoParams: 'ivolPrem', width: '65px' },
                  { key: 'ttmZScore', label: 'TTM Z-Score', icon: <div style={{ height: '22px', width: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '17px', fontWeight: 600 }} className="text-blue-500">Z</div>, align: 'center', infoParams: 'ttmZScore', width: '55px' },
                  { key: 'ivolZScore', label: 'IVOL High', icon: <Percent size={22} className="text-blue-500" />, align: 'center', infoParams: 'ivolZScore', width: '60px' },
                  { key: 'zScore', label: 'Z-Score', icon: <div style={{ height: '22px', width: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '17px', fontWeight: 600 }} className="text-blue-500">Z</div>, align: 'center', infoParams: 'zScore', width: '50px' },
                  { key: 'beta', label: 'Beta', icon: <div style={{ height: '22px', width: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '17px', fontWeight: 600 }} className="text-blue-500">β</div>, align: 'center', infoParams: 'beta', width: '40px' },

                  { key: 'quadRanking', label: 'Quad', icon: <LayoutGrid size={22} className="text-blue-500" />, align: 'center', infoParams: 'quad', width: '50px' },
                  { key: 'priceChanges', label: 'Price Change', icon: <DollarSign size={22} className="text-blue-500" />, align: 'center', width: '80px' },
                  {
                    key: 'atr',
                    label: 'ATR',
                    icon: (
                      <svg width="29" height="29" viewBox="0 0 100 100" aria-hidden style={{ display: 'block' }}>
                        <title>ATR (stop sign)</title>
                        <polygon
                          points="30,5 70,5 95,30 95,70 70,95 30,95 5,70 5,30"
                          fill="#dc2626"
                          stroke="#dc2626"
                          strokeWidth="3"
                          strokeLinejoin="miter"
                        />
                        <text
                          x="50"
                          y="51"
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill="#ffffff"
                          fontSize="26"
                          fontWeight="800"
                          fontFamily="system-ui, -apple-system, Impact, 'Arial Black', sans-serif"
                          letterSpacing="-0.06em"
                          style={{ userSelect: 'none' }}
                        >
                          STOP
                        </text>
                      </svg>
                    ),
                    align: 'center',
                    infoParams: 'atr',
                    width: '70px',
                    sortable: false
                  },
                  { key: 'signal', label: 'Sig', icon: <Activity size={22} className="text-blue-500" />, align: 'center', width: '50px' }
                ].map((col, index, arr) => {
                  const isSortable = col.sortable !== false;
                  return (
                  <th
                    key={col.key}
                    style={{
                      padding: '3px 3px 4px',
                      textAlign: col.align,
                      verticalAlign: 'middle',
                      background: '#f9fafb',
                      color: '#1e293b',
                      borderLeft: index === 0 ? '1px solid #d1d5db' : 'none',
                      borderRight: index === arr.length - 1 ? '1px solid #d1d5db' : '1px solid #e5e7eb',
                      borderBottom: '1px solid #d1d5db',
                      width: col.width,
                      minWidth: col.width,
                      maxWidth: col.width,
                      position: 'sticky',
                      top: 0,
                      zIndex: 10,
                      boxShadow: 'inset 0 -1px 0 #d1d5db'
                    }}
                    className={isSortable ? 'group hover:bg-[#f3f4f6] transition-colors' : 'transition-colors'}
                    onClick={isSortable ? () => handleSort(col.key) : undefined}
                    aria-sort={!isSortable ? 'none' : undefined}
                  >
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'stretch',
                        gap: 0,
                        cursor: isSortable ? 'pointer' : 'default',
                        width: '100%'
                      }}
                    >
                      {/* 2px below labels (match filter tag gap-0.5). Column + flex-end = bottom of band, not right-aligned. */}
                      <div
                        style={{
                          minHeight: '24px',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'flex-end',
                          alignItems: 'center',
                          textAlign: 'center',
                          padding: '0 1px',
                          lineHeight: 1.12,
                          marginBottom: '2px',
                          width: '100%'
                        }}
                      >
                        <span
                          onClick={(e) => {
                            if (col.infoParams) {
                              e.stopPropagation();
                              handleMetricDefinitionClick(e, col.infoParams);
                            }
                          }}
                          style={{
                            fontSize: '9px',
                            color: '#000000',
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                            lineHeight: 1.12,
                            cursor: col.infoParams ? 'pointer' : 'default',
                            display: 'block',
                            width: '100%',
                            maxWidth: '100%'
                          }}
                          className={col.infoParams ? "hover:text-blue-600 transition-colors" : ""}
                        >
                          {col.label}
                        </span>
                      </div>
                      <div
                        style={{
                          minHeight: '31px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#1e40af',
                          width: '100%',
                          marginBottom: '1px'
                        }}
                      >
                        {col.icon}
                      </div>
                      <div
                        style={{
                          minHeight: '12px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: '100%'
                        }}
                      >
                        {isSortable ? (() => {
                          const sortInfo = getSortInfo(col.key);
                          if (sortInfo) {
                            return (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '1px', color: '#2563eb', fontWeight: 700, fontSize: '9px' }}>
                                <span>{sortInfo.order}</span>
                                {sortInfo.direction === 'asc' ? <ArrowUp size={12} strokeWidth={3} /> : <ArrowDown size={12} strokeWidth={3} />}
                              </div>
                            );
                          }
                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '2px', color: '#cbd5e1' }}>
                              <ArrowUp size={10} strokeWidth={2.5} />
                              <ArrowDown size={10} strokeWidth={2.5} />
                            </div>
                          );
                        })() : (
                          <div style={{ minHeight: '12px' }} aria-hidden="true" />
                        )}
                      </div>
                    </div>
                  </th>
                );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedSecurities.length === 0 ? (
                <tr>
                  <td colSpan="12" style={{ padding: '40px', textAlign: 'center' }} className="dark:text-gray-400">
                    {searchQuery
                      ? `No securities found matching "${searchQuery}"`
                      : 'No securities available'}
                  </td>
                </tr>
              ) : (
                sortedSecurities.map((security, index) => (
                  <SecuritiesUniverseMetricsRow
                    key={security.ticker}
                    security={security}
                    rowIndex={index}
                    tradingDays={tradingDays}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card >

      {/* Metric Definition Popover */}
      {
        openPopover && (
          <MetricDefinitionPopover
            metricKey={openPopover.metricKey}
            definition={openPopover.definition}
            onClose={closePopover}
          />
        )
      }
    </div >
  );
};

export default SecuritiesUniverse;
