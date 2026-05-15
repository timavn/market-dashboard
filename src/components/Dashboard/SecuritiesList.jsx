import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Text } from '@tremor/react';
import { SECURITIES_LIST } from '../../constants/securitiesList';
import { MarketDataService } from '../../services/api/marketDataService';
import { isFreshForToday } from '../../utils/dateFreshness';
import EtfProCard from './EtfProCard';
import './SecuritiesList.css';

const VIEW_KEY = 'leftSidebarView_v1';
const SS_ROWS_PER_PAGE_FALLBACK = 10;
const SS_ROW_APPROX_PX = 31;

const SecuritiesList = ({ isPortfolioOpen = false }) => {
  const securities = SECURITIES_LIST;
  const [showLegend, setShowLegend] = useState(false);
  const [showDotLegend, setShowDotLegend] = useState(false);
  const [ssPage, setSsPage] = useState(0);
  const [etfProFresh, setEtfProFresh] = useState(false);
  const [activeView, setActiveView] = useState(() => {
    const saved = localStorage.getItem(VIEW_KEY);
    return saved === 'etfpro' ? 'etfpro' : 'signal';
  });
  const [prices, setPrices] = useState({}); // { ticker: { price, timestamp } }
  const [riskRanges, setRiskRanges] = useState({}); // { ticker: { lrr, hrr, timestamp } }
  const [loading, setLoading] = useState(true);
  const [updateTrigger, setUpdateTrigger] = useState(0); // Trigger for real-time color updates
  const [updatedRows, setUpdatedRows] = useState(new Set()); // Track rows that were just updated for blink animation
  const [topMovers, setTopMovers] = useState({
    weekly: { upside: [], downside: [] },
    monthly: { upside: [], downside: [] }
  });
  const dotLegendRef = useRef(null);
  const ssDataContainerRef = useRef(null);
  const rowRefs = useRef({});
  const pricesRef = useRef({}); // Ref to track current prices for stale closure prevention
  const riskRangesRef = useRef({}); // Ref to track current risk ranges for stale closure prevention
  const [ssRowsPerPage, setSsRowsPerPage] = useState(SS_ROWS_PER_PAGE_FALLBACK);

  // Asset class color mapping - using more vibrant, distinct colors
  const getAssetClassColor = useCallback((assetClass) => {
    const colors = {
      fixedIncome: 'blue',      // Blue for bonds/fixed income
      equity: 'emerald',         // Green for stocks
      currency: 'violet',        // Purple/violet for currencies
      commodity: 'orange',       // Orange for commodities
      crypto: 'yellow'           // Yellow for crypto
    };
    return colors[assetClass] || 'gray';
  }, []);

  // Get background color for row highlighting
  const getAssetClassBgColor = useCallback((assetClass) => {
    const bgColors = {
      fixedIncome: 'bg-blue-50 dark:bg-blue-900/20',
      equity: 'bg-emerald-50 dark:bg-emerald-900/20',
      currency: 'bg-violet-50 dark:bg-violet-900/20',
      commodity: 'bg-orange-50 dark:bg-orange-900/20',
      crypto: 'bg-yellow-50 dark:bg-yellow-900/20'
    };
    return bgColors[assetClass] || 'bg-gray-50 dark:bg-gray-900/20';
  }, []);

  const getAssetClassName = useCallback((assetClass) => {
    const names = {
      fixedIncome: 'Fixed Income',
      equity: 'Equity',
      currency: 'Currency',
      commodity: 'Commodity',
      crypto: 'Crypto'
    };
    return names[assetClass] || assetClass;
  }, []);

  // Format price based on asset type
  const formatPrice = useCallback((ticker, price, assetClass) => {
    // Handle undefined/null cases
    if (price === undefined || price === null) {
      return '--';
    }

    // Handle both old format (string) and new format (object with price property)
    let priceValue;
    if (typeof price === 'object' && price !== null) {
      // New format: { price: "...", timestamp: "..." }
      priceValue = price.price;
    } else if (typeof price === 'string') {
      // Old format: just a string
      priceValue = price;
    } else {
      return '--';
    }

    // Check if priceValue is valid
    if (!priceValue || priceValue === 'N/A' || priceValue === '--') {
      return '--';
    }

    const priceNum = parseFloat(priceValue);
    if (isNaN(priceNum)) {
      return '--';
    }

    // Treasury yields show as percentage
    if (ticker.startsWith('UST')) {
      return `${priceNum.toFixed(2)}%`;
    }

    // For other assets, show as number without $ symbol
    return `${priceNum.toFixed(2)}`;
  }, []);

  // Check if timestamp is more than 1 market day old
  // Market days are weekdays, and we consider >26 hours as more than 1 market day
  // (accounts for market close ~4 PM ET to next day open ~9:30 AM ET)
  const isMoreThanOneMarketDayOld = (timestamp) => {
    if (!timestamp) return false;

    const now = Date.now();
    const timestampMs = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
    const elapsedMs = now - timestampMs;
    const elapsedHours = elapsedMs / (1000 * 60 * 60);

    // More than 26 hours old (accounts for market close to next day open)
    return elapsedHours > 26;
  };

  // Calculate update status based on timestamp
  const getUpdateStatus = (timestamp, lrrTimestamp = null, hrrTimestamp = null) => {
    // Priority 1: Check if LRR or HRR are more than 1 market day old (blue)
    if (lrrTimestamp && isMoreThanOneMarketDayOld(lrrTimestamp)) {
      return { status: 'lrr-stale', color: '#3B82F6', emoji: '🔵' }; // Blue
    }
    if (hrrTimestamp && isMoreThanOneMarketDayOld(hrrTimestamp)) {
      return { status: 'hrr-stale', color: '#3B82F6', emoji: '🔵' }; // Blue
    }

    // Priority 2: Check price update status
    if (!timestamp) {
      return { status: 'stale', color: '#EF4444', emoji: '🔴' }; // Red for no timestamp
    }

    const now = Date.now();
    const timestampMs = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
    const elapsedMs = now - timestampMs;
    const elapsedSeconds = elapsedMs / 1000;
    const elapsedMinutes = elapsedSeconds / 60;

    if (elapsedMinutes < 1) {
      return { status: 'fresh', color: '#10B981', emoji: '🟢' }; // Green
    } else if (elapsedMinutes < 5) {
      return { status: 'recent', color: '#F59E0B', emoji: '🟡' }; // Yellow/Orange
    } else {
      return { status: 'stale', color: '#EF4444', emoji: '🔴' }; // Red
    }
  };

  // Helper to format risk levels with max 6 digits to keep columns aligned
  const formatRiskLevel = (value, isPercentage = false) => {
    if (value === undefined || value === null || value === '--') return '--';
    const num = parseFloat(value);
    if (isNaN(num)) return '--';

    // Percentage case (e.g., UST)
    if (isPercentage) {
      return `${num.toFixed(2)}%`;
    }

    // Default case: Max 2 decimals, limit total digits to 6
    let decimals = 2;
    let formatted = num.toFixed(decimals);

    // Help count digits
    const countDigits = (str) => str.replace(/[^0-9]/g, '').length;

    // Reduce precision if we have more than 6 digits
    while (decimals > 0 && countDigits(formatted) > 6) {
      decimals--;
      formatted = num.toFixed(decimals);
    }

    // Remove .00
    if (formatted.endsWith('.00')) {
      return formatted.slice(0, -3);
    }

    return formatted;
  };

  // Poll for prices every 30 seconds
  useEffect(() => {
    const isDev = process.env.NODE_ENV === 'development';

    if (isDev) {
      console.log('[SecuritiesList] Setting up polling interval');
    }

    let pollCount = 0;

    // Fetch prices function
    const fetchPricesData = async () => {
      pollCount++;
      const pollId = `poll-${pollCount}`;
      const isFirstPoll = pollCount === 1;

      // Only log in dev mode or for first poll
      if (isDev && isFirstPoll) {
        console.log(`[SecuritiesList] [${pollId}] Starting fetchPricesData (poll #${pollCount})`);
      }

      try {
        const tickers = securities.map(s => s.ticker);

        if (isDev && isFirstPoll) {
          console.log(`[SecuritiesList] [${pollId}] Fetching prices for ${tickers.length} securities`);
        }

        const quotes = await MarketDataService.getQuotes(tickers);

        if (isDev && isFirstPoll) {
          console.log(`[SecuritiesList] [${pollId}] API Response received:`, {
            quoteCount: Object.keys(quotes).length,
            sampleQuote: quotes[Object.keys(quotes)[0]]
          });
        }

        // Handle empty response
        if (!quotes || Object.keys(quotes).length === 0) {
          console.warn(`[SecuritiesList] [${pollId}] Empty quotes response! Keeping existing data.`);
          // Keep existing data, just update loading state
          setLoading(false);
          return;
        }

        const priceMap = {};
        let successCount = 0;
        let failCount = 0;

        tickers.forEach(ticker => {
          const quote = quotes[ticker.toUpperCase()];
          if (quote && quote.price) {
            // Store both price and timestamp
            const timestamp = quote.timestamp || new Date().toISOString();
            priceMap[ticker] = {
              price: quote.price,
              timestamp: timestamp
            };
            successCount++;
          } else {
            // For failed quotes, keep existing data if available, or set to null
            // Use ref to avoid stale closure issues
            const existingData = pricesRef.current[ticker];
            if (existingData && existingData.price && existingData.price !== '--') {
              // Keep existing data but mark as potentially stale
              priceMap[ticker] = existingData;
            } else {
              priceMap[ticker] = { price: '--', timestamp: null };
            }
            failCount++;
          }
        });

        // Only log summary in dev mode or if there are failures
        if (isDev && (isFirstPoll || failCount > 0)) {
          console.log(`[SecuritiesList] [${pollId}] Price fetch complete: ${successCount} success, ${failCount} failed`);
        }

        setPrices(priceMap);
        pricesRef.current = priceMap; // Update ref
        setLoading(false);
        // Trigger update for dot colors
        setUpdateTrigger(prev => prev + 1);

        // Mark all rows with price data as updated for blink animation
        const updatedTickers = new Set();
        Object.keys(priceMap).forEach(ticker => {
          if (priceMap[ticker] && priceMap[ticker].price && priceMap[ticker].price !== '--') {
            updatedTickers.add(ticker);
          }
        });
        setUpdatedRows(updatedTickers);

        // Clear updated rows after animation completes (1.5 seconds)
        setTimeout(() => {
          setUpdatedRows(new Set());
        }, 1500);
      } catch (error) {
        // Always log errors
        console.error(`[SecuritiesList] [${pollId}] Error fetching prices:`, error);
        console.error(`[SecuritiesList] [${pollId}] Error details:`, {
          message: error.message,
          stack: error.stack?.split('\n').slice(0, 3),
          response: error.response?.data,
          status: error.response?.status,
          config: {
            url: error.config?.url,
            method: error.config?.method
          }
        });

        // On error, keep existing data if available
        if (Object.keys(pricesRef.current).length > 0) {
          if (isDev) {
            console.log(`[SecuritiesList] [${pollId}] Error occurred, keeping existing ${Object.keys(pricesRef.current).length} price entries`);
          }
        } else {
          console.warn(`[SecuritiesList] [${pollId}] Error occurred and no existing data available`);
        }

        setLoading(false);
      }
    };

    // Initial fetch
    if (isDev) {
      console.log('[SecuritiesList] Performing initial fetch');
    }
    fetchPricesData();

    // Set up polling interval (30 seconds)
    const interval = setInterval(() => {
      fetchPricesData();
    }, 30000);

    return () => {
      if (isDev) {
        console.log('[SecuritiesList] Cleaning up polling interval');
      }
      clearInterval(interval);
    };
  }, [securities]);

  // Fetch risk ranges (LRR/HRR) on component mount and periodically
  useEffect(() => {
    const fetchRiskRanges = async () => {
      try {
        const tickers = securities.map(s => s.ticker);
        const riskRangeData = await MarketDataService.getRiskRanges(tickers);

        // Transform data to match our format
        const riskRangeMap = {};
        Object.keys(riskRangeData).forEach(ticker => {
          const data = riskRangeData[ticker];
          if (data) {
            riskRangeMap[ticker.toUpperCase()] = {
              lrr: data.lrr,
              hrr: data.hrr,
              trend: data.trend,
              timestamp: data.timestamp
            };
          }
        });

        setRiskRanges(riskRangeMap);
        riskRangesRef.current = riskRangeMap;
      } catch (error) {
        console.error('[SecuritiesList] Error fetching risk ranges:', error);
        // Keep existing data on error
      }
    };

    // Initial fetch
    fetchRiskRanges();

    // Refresh risk ranges every 5 minutes (they update daily after market close)
    const riskRangeInterval = setInterval(() => {
      fetchRiskRanges();
    }, 5 * 60 * 1000); // 5 minutes

    return () => clearInterval(riskRangeInterval);
  }, [securities]);

  // Real-time color updates for dots (every 10 seconds to update as data ages)
  useEffect(() => {
    const colorUpdateInterval = setInterval(() => {
      setUpdateTrigger(prev => prev + 1);
    }, 10000); // Update every 10 seconds

    return () => clearInterval(colorUpdateInterval);
  }, []);

  // Fetch and calculate top movers (weekly and monthly)
  useEffect(() => {
    const calculateTopMovers = async () => {
      try {
        const tickers = securities.map(s => s.ticker);
        const moversData = {
          weekly: { upside: [], downside: [] },
          monthly: { upside: [], downside: [] }
        };

        // Only process tickers that have current price data
        const tickersWithPrices = tickers.filter(ticker => {
          const price = prices[ticker]?.price;
          return price && price !== '--' && !isNaN(parseFloat(price));
        });

        if (tickersWithPrices.length === 0) return;

        // Fetch historical data for all securities in smaller batches to avoid overwhelming the API
        const batchSize = 5;
        for (let i = 0; i < tickersWithPrices.length; i += batchSize) {
          const batch = tickersWithPrices.slice(i, i + batchSize);
          await Promise.all(batch.map(async (ticker) => {
            try {
              // Fetch one 30-day history and compute both W/W and M/M from the
              // same series so the numerator and denominator come from the
              // same era (robust to stale DB history).
              const history = await MarketDataService
                .getHistoricalData(ticker, 30)
                .catch(() => ({ data: [] }));

              const closes = (history?.data || [])
                .map(d => (typeof d.close === 'number' ? d.close : parseFloat(d.close)))
                .filter(c => Number.isFinite(c) && c > 0);

              if (closes.length < 2) return;

              const last = closes[closes.length - 1];
              const weekAgo = closes.length >= 6 ? closes[closes.length - 6] : closes[0];
              const monthAgo = closes[0];

              const weeklyChange = ((last - weekAgo) / weekAgo) * 100;
              const monthlyChange = ((last - monthAgo) / monthAgo) * 100;

              const security = securities.find(s => s.ticker === ticker);
              if (!security) return;

              if (Number.isFinite(weeklyChange)) {
                moversData.weekly[weeklyChange >= 0 ? 'upside' : 'downside'].push({
                  ticker,
                  name: security.name,
                  change: weeklyChange,
                  assetClass: security.assetClass
                });
              }

              if (Number.isFinite(monthlyChange)) {
                moversData.monthly[monthlyChange >= 0 ? 'upside' : 'downside'].push({
                  ticker,
                  name: security.name,
                  change: monthlyChange,
                  assetClass: security.assetClass
                });
              }
            } catch (error) {
              // Silently skip tickers that fail (no historical data available)
            }
          }));

          // Small delay between batches to avoid overwhelming the API
          if (i + batchSize < tickersWithPrices.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        // Sort and get top 5 for each category
        const sortAndLimit = (arr, ascending = false) => {
          return arr
            .filter(item => !isNaN(item.change))
            .sort((a, b) => ascending ? a.change - b.change : b.change - a.change)
            .slice(0, 5);
        };

        setTopMovers({
          weekly: {
            upside: sortAndLimit(moversData.weekly.upside, false),
            downside: sortAndLimit(moversData.weekly.downside, true)
          },
          monthly: {
            upside: sortAndLimit(moversData.monthly.upside, false),
            downside: sortAndLimit(moversData.monthly.downside, true)
          }
        });
      } catch (error) {
        console.error('Error calculating top movers:', error);
      }
    };

    // Only calculate if we have price data and not loading
    if (Object.keys(prices).length > 0 && !loading) {
      // Debounce to avoid recalculating too frequently
      const timeoutId = setTimeout(() => {
        calculateTopMovers();
      }, 1000);

      return () => clearTimeout(timeoutId);
    }
  }, [prices, loading, securities]);

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dotLegendRef.current && !dotLegendRef.current.contains(e.target)) {
        setShowDotLegend(false);
      }
    };
    if (showDotLegend) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDotLegend]);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, activeView);
  }, [activeView]);

  useEffect(() => {
    if (activeView !== 'signal') return undefined;
    const el = ssDataContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      setSsRowsPerPage(SS_ROWS_PER_PAGE_FALLBACK);
      return undefined;
    }

    const computeRowsPerPage = () => {
      const renderedRow = el.querySelector('.securities-data-row');
      const rowHeight = renderedRow?.offsetHeight || SS_ROW_APPROX_PX;
      const nextRowsPerPage = Math.max(
        1,
        Math.min(securities.length, Math.floor(el.clientHeight / rowHeight) || SS_ROWS_PER_PAGE_FALLBACK)
      );
      setSsRowsPerPage(nextRowsPerPage);
    };

    const resizeObserver = new ResizeObserver(computeRowsPerPage);
    resizeObserver.observe(el);
    computeRowsPerPage();

    return () => resizeObserver.disconnect();
  }, [activeView, securities.length]);

  const ssEffectiveRowsPerPage = Math.max(1, Math.min(securities.length, ssRowsPerPage));
  const ssTotalPages = Math.max(1, Math.ceil(securities.length / ssEffectiveRowsPerPage));
  const ssCurrentPage = Math.min(ssPage, ssTotalPages - 1);

  useEffect(() => {
    if (ssPage !== ssCurrentPage) {
      setSsPage(ssCurrentPage);
    }
  }, [ssCurrentPage, ssPage]);

  const handleEtfProFreshness = useCallback((fresh) => {
    setEtfProFresh(fresh);
  }, []);

  // Eagerly check ETF Pro freshness on mount so the dot reflects the latest
  // upload state without requiring the user to click the ETFP tab first.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snapshot = await MarketDataService.getHedgeyeEtfPro();
        if (cancelled) return;
        setEtfProFresh(isFreshForToday(snapshot?.meta?.snapshotDate));
      } catch {
        if (!cancelled) setEtfProFresh(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const ssFresh = useMemo(() => {
    const entries = Object.values(riskRanges);
    if (entries.length === 0) return false;
    return isFreshForToday(entries[0]?.date);
  }, [riskRanges]);

  return (
    <div className="relative securities-card" style={{ overflow: 'hidden' }}>
      <div className="securities-card-header">
        {/* Row 1: Title */}
        <div className="securities-card-title-row">
          {activeView === 'signal' ? (
            <span className="securities-icon-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            </span>
          ) : (
            <span className="securities-icon-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </span>
          )}
          <span className="securities-card-title">
            {activeView === 'etfpro' ? 'ETF PRO' : 'SIGNAL STRENGTH'}
          </span>
        </div>
        {/* Row 2: Toggle */}
        <div className="securities-card-controls-row">
          <div className="securities-view-toggle" role="tablist" aria-label="Left sidebar view">
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'signal'}
              className={activeView === 'signal' ? 'toggle-btn active' : 'toggle-btn'}
              onClick={() => setActiveView('signal')}
            >
              <span className={`status-dot ${ssFresh ? 'fresh' : 'stale'}`} />
              SS
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'etfpro'}
              className={activeView === 'etfpro' ? 'toggle-btn active' : 'toggle-btn'}
              onClick={() => setActiveView('etfpro')}
            >
              <span className={`status-dot ${etfProFresh ? 'fresh' : 'stale'}`} />
              ETFP
            </button>
          </div>
        </div>
      </div>

      <div className="securities-card-body">
      {activeView === 'etfpro' ? (
        <EtfProCard onFreshness={handleEtfProFreshness} />
      ) : (
        <>
          {/* Top Movers Section - Compact Table Format */}
          <div className="top-movers-section">
            <div className="top-movers-compact top-movers-sidebyside">
              {/* Top Gainers Table */}
              <div className="top-movers-table-container">
                <div className="top-movers-header gainers">✦ GAINERS</div>
                <table className="top-movers-table">
                  <thead>
                    <tr>
                      <th className="col-rank">#</th>
                      <th className="col-ticker">Ticker</th>
                      <th className="col-change">W/W</th>
                      <th className="col-change">M/M</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topMovers.weekly.upside.length > 0 ? (
                      topMovers.weekly.upside.map((mover, idx) => {
                        // Find matching monthly data for this ticker
                        const monthlyData =
                          topMovers.monthly.upside.find((m) => m.ticker === mover.ticker) ||
                          topMovers.monthly.downside.find((m) => m.ticker === mover.ticker);
                        const monthlyChange = monthlyData?.change;
                        return (
                          <tr key={mover.ticker}>
                            <td className="col-rank">{idx + 1}</td>
                            <td className="col-ticker">{mover.ticker}</td>
                            <td
                              className={`col-change ${
                                mover.change >= 0 ? 'positive' : 'negative'
                              }`}
                            >
                              {mover.change >= 0 ? '+' : ''}
                              {mover.change.toFixed(1)}%
                            </td>
                            <td
                              className={`col-change ${
                                monthlyChange !== undefined
                                  ? monthlyChange >= 0
                                    ? 'positive'
                                    : 'negative'
                                  : ''
                              }`}
                            >
                              {monthlyChange !== undefined
                                ? `${monthlyChange >= 0 ? '+' : ''}${monthlyChange.toFixed(1)}%`
                                : '--'}
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan="4" className="loading-cell">
                          Loading...
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Top Losers Table */}
              <div className="top-movers-table-container">
                <div className="top-movers-header losers">↘ LOSERS</div>
                <table className="top-movers-table">
                  <thead>
                    <tr>
                      <th className="col-rank">#</th>
                      <th className="col-ticker">Ticker</th>
                      <th className="col-change">W/W</th>
                      <th className="col-change">M/M</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topMovers.weekly.downside.length > 0 ? (
                      topMovers.weekly.downside.map((mover, idx) => {
                        // Find matching monthly data for this ticker
                        const monthlyData =
                          topMovers.monthly.downside.find((m) => m.ticker === mover.ticker) ||
                          topMovers.monthly.upside.find((m) => m.ticker === mover.ticker);
                        const monthlyChange = monthlyData?.change;
                        return (
                          <tr key={mover.ticker}>
                            <td className="col-rank">{idx + 1}</td>
                            <td className="col-ticker">{mover.ticker}</td>
                            <td
                              className={`col-change ${
                                mover.change >= 0 ? 'positive' : 'negative'
                              }`}
                            >
                              {mover.change >= 0 ? '+' : ''}
                              {mover.change.toFixed(1)}%
                            </td>
                            <td
                              className={`col-change ${
                                monthlyChange !== undefined
                                  ? monthlyChange >= 0
                                    ? 'positive'
                                    : 'negative'
                                  : ''
                              }`}
                            >
                              {monthlyChange !== undefined
                                ? `${monthlyChange >= 0 ? '+' : ''}${monthlyChange.toFixed(1)}%`
                                : '--'}
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan="4" className="loading-cell">
                          Loading...
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

      {/* Quick Section - ADDED and REMOVED */}
      <div className="quick-section px-2 py-1.5 border-b border-gray-200 dark:border-gray-700">
        <div className="quick-item">
          <span className="quick-label" style={{ color: '#10B981' }}>ADDED:</span>
          <span className="quick-tickers">
            <span className="quick-ticker">AAPL</span>
            <span className="quick-ticker">MSFT</span>
            <span className="quick-ticker">GOOGL</span>
          </span>
        </div>
        <div className="quick-item">
          <span className="quick-label" style={{ color: '#EF4444' }}>REMOVED:</span>
          <span className="quick-tickers">
            <span className="quick-ticker">TSLA</span>
            <span className="quick-ticker">NVDA</span>
          </span>
        </div>
      </div>

      {/* Asset Class Legend - Horizontal, above column titles */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-200 dark:border-gray-700">
        {['fixedIncome', 'equity', 'currency', 'commodity', 'crypto'].map((assetClass) => {
          const emojiMap = {
            fixedIncome: '🟦',  // Blue square
            equity: '🟩',       // Green square
            currency: '🟪',     // Purple square
            commodity: '🟧',    // Orange square
            crypto: '🟨'        // Yellow square
          };
          const shortNames = {
            fixedIncome: 'FI',
            equity: 'Eq',
            currency: 'FX',
            commodity: 'Com',
            crypto: 'Crypto'
          };
          return (
            <div key={assetClass} className="flex items-center gap-0.5" title={getAssetClassName(assetClass)}>
              <span className="text-[10px] leading-none">{emojiMap[assetClass]}</span>
              <span className="text-gray-700 dark:text-gray-300 whitespace-nowrap text-[10px] leading-tight">{shortNames[assetClass]}</span>
            </div>
          );
        })}
      </div>

      <div className="securities-table-wrapper">
        {/* Header Row */}
        <div
          className="securities-header-row"
          style={{
            gridTemplateColumns: '20px 30px 60px 70px 60px 60px'
          }}
        >
          <div
            className="header-dot relative"
            ref={dotLegendRef}
            onMouseEnter={() => setShowDotLegend(true)}
            onMouseLeave={() => setShowDotLegend(false)}
          >
            <span className="cursor-pointer hover:opacity-70">U</span>
            {/* Dot Status Legend Popover */}
            {showDotLegend && (
              <div
                className="absolute z-50 mt-2 p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg min-w-[200px]"
                style={{ left: 0, top: '100%' }}
              >
                <Text className="text-xs font-semibold mb-2 block dark:text-white">Update Status</Text>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm leading-none">🟢</span>
                    <Text className="text-xs dark:text-gray-300">Fresh (&lt; 1 min)</Text>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm leading-none">🟡</span>
                    <Text className="text-xs dark:text-gray-300">Recent (1-5 min)</Text>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm leading-none">🔴</span>
                    <Text className="text-xs dark:text-gray-300">Stale (&gt; 5 min)</Text>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm leading-none">🔵</span>
                    <Text className="text-xs dark:text-gray-300">LRR/HRR &gt; 1 market day old</Text>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="header-number">#</div>
          <div className="header-ticker">Ticker</div>
          <div className="header-price">Spot Price</div>
          <div className="header-bias">Bias</div>
          <div className="header-lrr">LRR</div>
        </div>

        {/* Data Rows */}
        <div className="securities-data-container" ref={ssDataContainerRef}>
          {securities
            .slice(
              ssCurrentPage * ssEffectiveRowsPerPage,
              (ssCurrentPage + 1) * ssEffectiveRowsPerPage
            )
            .map((security, localIndex) => {
            const index = ssCurrentPage * ssEffectiveRowsPerPage + localIndex;
            const isLastOnPage = localIndex === Math.min(
              ssEffectiveRowsPerPage,
              securities.length - ssCurrentPage * ssEffectiveRowsPerPage
            ) - 1;
            return (
            <div
              key={security.ticker}
              className={`securities-data-row ${getAssetClassBgColor(security.assetClass)} ${isLastOnPage ? 'last-row' : ''} ${updatedRows.has(security.ticker) ? 'row-updated' : ''}`}
              style={{
                gridTemplateColumns: '20px 30px 60px 70px 60px 60px'
              }}
            >
              <div className="data-dot-cell">
                {(() => {
                  const priceData = prices[security.ticker];
                  const timestamp = priceData?.timestamp || null;
                  const riskRangeData = riskRanges[security.ticker.toUpperCase()] || riskRangesRef.current[security.ticker.toUpperCase()];
                  const lrrTimestamp = riskRangeData?.timestamp || null;
                  const hrrTimestamp = riskRangeData?.timestamp || null;
                  const status = getUpdateStatus(timestamp, lrrTimestamp, hrrTimestamp);
                  // Use updateTrigger to force re-render for real-time updates
                  const _ = updateTrigger;

                  let tooltipText = '';
                  if (status.status === 'lrr-stale' || status.status === 'hrr-stale') {
                    tooltipText = `LRR/HRR are more than 1 market day old`;
                    if (lrrTimestamp) {
                      tooltipText += ` (LRR: ${new Date(lrrTimestamp).toLocaleString()})`;
                    }
                    if (hrrTimestamp) {
                      tooltipText += ` (HRR: ${new Date(hrrTimestamp).toLocaleString()})`;
                    }
                  } else {
                    tooltipText = `Last updated: ${timestamp ? new Date(timestamp).toLocaleTimeString() : 'Never'} (${status.status})`;
                  }

                  return (
                    <span
                      className="ticker-dot-emoji"
                      title={tooltipText}
                      style={{ fontSize: '8px', lineHeight: 1 }}
                    >{status.emoji}</span>
                  );
                })()}
              </div>
              <div className="data-number-cell">
                <span className="data-number">{index + 1}</span>
              </div>
              <div className="data-ticker-cell">
                <span className="data-ticker">{security.ticker}</span>
              </div>
              <div className="data-price-cell">
                <span className="data-price">
                  {(() => {
                    const priceData = prices[security.ticker];
                    // Show '...' only when loading AND no data exists
                    if (loading && priceData === undefined) {
                      return '...';
                    }
                    // If we have data (even if loading is true), show it
                    if (priceData !== undefined && priceData !== null) {
                      return formatPrice(security.ticker, priceData, security.assetClass);
                    }
                    // No data and not loading, show '--'
                    return '--';
                  })()}
                </span>
              </div>
              <div className="data-bias-cell">
                {(() => {
                  const riskRangeData = riskRanges[security.ticker.toUpperCase()] || riskRangesRef.current[security.ticker.toUpperCase()];
                  const trend = riskRangeData?.trend;

                  let displayTrend = '--';
                  let colorClass = 'text-gray-400';

                  if (trend === 'BULLISH') {
                    displayTrend = 'Bullish';
                    colorClass = '!text-emerald-600 dark:!text-emerald-400 font-bold';
                  } else if (trend === 'BEARISH') {
                    displayTrend = 'Bearish';
                    colorClass = '!text-red-600 dark:!text-red-400 font-bold';
                  } else if (trend === 'NEUTRAL') {
                    displayTrend = 'Neutral';
                    colorClass = 'text-gray-500 dark:text-gray-400';
                  }

                  return <span className={`data-signal text-[10px] ${colorClass}`}>{displayTrend}</span>;
                })()}
              </div>
              <div className="data-lrr-cell">
                <span className="data-lrr">
                  {(() => {
                    const riskRangeData = riskRanges[security.ticker.toUpperCase()] || riskRangesRef.current[security.ticker.toUpperCase()];
                    const lrr = riskRangeData?.lrr;

                    if (lrr !== undefined && lrr !== null) {
                      const isPercentage = security.ticker.startsWith('UST');
                      return formatRiskLevel(lrr, isPercentage);
                    }
                    return '--';
                  })()}
                </span>
              </div>
            </div>
            );
          })}
        </div>
        {/* Pagination Controls */}
        {(() => {
          if (ssTotalPages <= 1) return null;
          return (
            <div className="ss-pagination">
              <button
                className="ss-page-btn"
                onClick={() => setSsPage(p => Math.max(0, p - 1))}
                disabled={ssCurrentPage === 0}
              >‹</button>
              <span className="ss-page-info">{ssCurrentPage + 1} / {ssTotalPages}</span>
              <button
                className="ss-page-btn"
                onClick={() => setSsPage(p => Math.min(ssTotalPages - 1, p + 1))}
                disabled={ssCurrentPage === ssTotalPages - 1}
              >›</button>
            </div>
          );
        })()}
      </div>
        </>
      )}
      </div>
    </div>
  );
};

export default SecuritiesList;
