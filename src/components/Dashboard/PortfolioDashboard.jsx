import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Card, Metric, Text, Grid, Title, Button, Badge } from '@tremor/react';
import ReactMarkdown from 'react-markdown';
import { MarketDataService } from '../../services/api/marketDataService';
import { useTheme } from '../../context/ThemeContext';
import CSVUpload from '../CSVUpload';
import USDMacroDashboard from './USDMacroDashboard';
import SecuritiesList from './SecuritiesList';
import ResizableBottomPanels from './ResizableBottomPanels';
import { SECURITIES_LIST, ASSET_CLASS_NAMES } from '../../constants/securitiesList';
import { bookContent } from '../../constants/bookContent';
import WorkflowStatus from './WorkflowStatus';
import SecuritiesUniverse from './SecuritiesUniverse';
import PerformanceTracking from './PerformanceTracking';
import PortfolioBreakdown from './PortfolioBreakdown';

const PortfolioDashboard = () => {
  const { theme, toggleTheme } = useTheme();
  const [portfolioData, setPortfolioData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dataUpdatedNotification, setDataUpdatedNotification] = useState(null); // For optimistic updates
  const portfolioDataRef = useRef(null); // Ref to track current portfolio data for polling
  const [showPortfolioMetrics, setShowPortfolioMetrics] = useState(false);
  const [showPeaPodWindow, setShowPeaPodWindow] = useState(false);
  const [volatilityExpanded, setVolatilityExpanded] = useState(false);
  const [securitiesExpanded, setSecuritiesExpanded] = useState(false);
  const [securitiesFullWidth, setSecuritiesFullWidth] = useState(false);
  const [signalStrengthExpanded, setSignalStrengthExpanded] = useState(false);
  const [selectedSecurityTicker, setSelectedSecurityTicker] = useState(null);
  const [peaPodImageError, setPeaPodImageError] = useState(false);
  const [bookImageError, setBookImageError] = useState(false);
  const [showBookMenu, setShowBookMenu] = useState(false);
  const [showBookModal, setShowBookModal] = useState(false);
  const [selectedBookContent, setSelectedBookContent] = useState(null);
  const [selectedBookTitle, setSelectedBookTitle] = useState('');
  const [bookMenuPosition, setBookMenuPosition] = useState({ top: 0, right: 0 });
  const bookMenuRef = useRef(null);
  const bookPopoverRef = useRef(null);
  const [showWorkflowStatus, setShowWorkflowStatus] = useState(false);
  const [analyticsRefreshKey, setAnalyticsRefreshKey] = useState(0);
  const [workflowStatusImageError, setWorkflowStatusImageError] = useState(false);
  const [showSecuritiesUniverse, setShowSecuritiesUniverse] = useState(false);
  const [showPerformanceTracking, setShowPerformanceTracking] = useState(false);
  const [showPortfolioBreakdown, setShowPortfolioBreakdown] = useState(false);
  const [securitiesUniverseImageError, setSecuritiesUniverseImageError] = useState(false);
  const [performanceImageError, setPerformanceImageError] = useState(false);
  const [portfolioBreakdownImageError, setPortfolioBreakdownImageError] = useState(false);

  // Tag navigation state
  const [selectedTag, setSelectedTag] = useState(null);
  const bookContentRef = useRef(null);

  // The Pods search state
  const [podsSearchQuery, setPodsSearchQuery] = useState('');
  const [podsShowSearchResults, setPodsShowSearchResults] = useState(false);
  const [podsHighlightedIndex, setPodsHighlightedIndex] = useState(-1);
  const [podsSelectedSecurity, setPodsSelectedSecurity] = useState(null);
  const podsSearchInputRef = useRef(null);

  // Filter securities based on search query - searches entire universe
  const podsFilteredSecurities = useMemo(() => {
    if (!podsSearchQuery.trim()) {
      return [];
    }
    const query = podsSearchQuery.toLowerCase().trim();
    // Search across ALL securities in the universe
    return SECURITIES_LIST.filter(security =>
      security.ticker.toLowerCase().includes(query) ||
      security.name.toLowerCase().includes(query)
    ).slice(0, 15); // Limit to 15 results
  }, [podsSearchQuery]);

  // Handle security selection from search
  const handlePodsSecuritySelect = (security) => {
    setPodsSelectedSecurity(security);
    setPodsSearchQuery(`${security.ticker} - ${security.name}`);
    setPodsShowSearchResults(false);
    setPodsHighlightedIndex(-1);
    podsSearchInputRef.current?.blur();
  };

  // Fetch portfolio data
  // silent: if true, don't set loading state (for background refreshes)
  const fetchPortfolio = async (silent = false) => {
    try {
      if (!silent) {
        setLoading(true); // Only show loading on initial load
      }
      setError(null);
      const data = await MarketDataService.getPortfolio();
      setPortfolioData(data);
      portfolioDataRef.current = data; // Update ref
      return data; // Return for polling logic
    } catch (e) {
      if (!silent) {
        setError(e.message || 'Failed to load portfolio');
      }
      throw e; // Re-throw for error handling
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    let isMounted = true;
    fetchPortfolio();

    // Listen for portfolio refresh events (after CSV upload)
    const handlePortfolioRefresh = () => {
      if (isMounted) {
        console.log('Refreshing portfolio data after CSV upload...');

        // Store the current portfolio timestamp to detect when new data arrives
        // Capture from ref to get current value
        const currentData = portfolioDataRef.current;
        let currentTimestamp = currentData?.lastUpdated;
        let currentHoldingsCount = currentData?.holdings?.length || 0;
        let currentTotalValue = currentData?.summary?.totalValue || 0;
        let pollCount = 0;
        const maxPolls = 10; // Poll for up to 30 seconds (10 polls × 3 seconds)
        const pollInterval = 3000; // Poll every 3 seconds
        let pollIntervalId = null;

        // Initial fetch (silent mode - no blank screen)
        fetchPortfolio(true).then(initialData => {
          if (!isMounted) return;

          // Update captured values after initial fetch
          if (initialData) {
            currentTimestamp = initialData.lastUpdated;
            currentHoldingsCount = initialData.holdings?.length || 0;
            currentTotalValue = initialData.summary?.totalValue || 0;
            console.log('Initial portfolio state:', {
              timestamp: currentTimestamp,
              holdingsCount: currentHoldingsCount,
              totalValue: currentTotalValue
            });
          }

          // Start polling for new data
          pollIntervalId = setInterval(() => {
            pollCount++;

            if (pollCount >= maxPolls) {
              console.log('Polling timeout reached, stopping...');
              if (pollIntervalId) clearInterval(pollIntervalId);
              return;
            }

            if (!isMounted) {
              if (pollIntervalId) clearInterval(pollIntervalId);
              return;
            }

            // Fetch portfolio and check if timestamp changed
            MarketDataService.getPortfolio()
              .then(newData => {
                if (!isMounted) return;

                const newTimestamp = newData?.lastUpdated;
                const newHoldingsCount = newData?.holdings?.length || 0;
                const newTotalValue = newData?.summary?.totalValue || 0;

                // Check if we have NEW data (not just same empty state)
                const hasNewData = (
                  (newTimestamp && newTimestamp !== currentTimestamp) ||
                  (newHoldingsCount > 0 && newHoldingsCount !== currentHoldingsCount) ||
                  (newTotalValue > 0 && newTotalValue !== currentTotalValue)
                );

                if (hasNewData) {
                  console.log('New portfolio data detected:', {
                    timestamp: newTimestamp,
                    holdingsCount: newHoldingsCount,
                    totalValue: newTotalValue,
                    previousTimestamp: currentTimestamp,
                    previousHoldingsCount: currentHoldingsCount,
                    previousTotalValue: currentTotalValue
                  });
                  setPortfolioData(newData);
                  portfolioDataRef.current = newData;

                  // Show optimistic update notification
                  setDataUpdatedNotification({
                    message: 'Portfolio data updated',
                    timestamp: new Date()
                  });

                  // Clear notification after 3 seconds
                  setTimeout(() => {
                    setDataUpdatedNotification(null);
                  }, 3000);

                  if (pollIntervalId) clearInterval(pollIntervalId);
                } else {
                  console.log(`Polling for new data... (${pollCount}/${maxPolls})`, {
                    current: { timestamp: currentTimestamp, holdings: currentHoldingsCount, value: currentTotalValue },
                    fetched: { timestamp: newTimestamp, holdings: newHoldingsCount, value: newTotalValue }
                  });
                }
              })
              .catch(error => {
                console.warn('Error polling for portfolio data:', error);
                // Continue polling on error
              });
          }, pollInterval);
        }).catch(error => {
          console.warn('Error in initial portfolio fetch during refresh:', error);
        });
      }
    };

    window.addEventListener('portfolioRefresh', handlePortfolioRefresh);

    return () => {
      isMounted = false;
      window.removeEventListener('portfolioRefresh', handlePortfolioRefresh);
    };
  }, []);

  // Handle clicks outside book menu
  useEffect(() => {
    const handleClickOutside = (e) => {
      const clickedButton = bookMenuRef.current && bookMenuRef.current.contains(e.target);
      const clickedPopover = bookPopoverRef.current && bookPopoverRef.current.contains(e.target);
      if (!clickedButton && !clickedPopover) {
        setShowBookMenu(false);
      }
    };
    if (showBookMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showBookMenu]);

  // Calculate popover position when menu opens
  useEffect(() => {
    if (showBookMenu && bookMenuRef.current) {
      const buttonRect = bookMenuRef.current.getBoundingClientRect();
      setBookMenuPosition({
        top: buttonRect.top,
        right: window.innerWidth - buttonRect.left + 8, // Position to the left with 8px margin
      });
    }
  }, [showBookMenu]);

  // Book/Notes file configuration
  const bookFiles = [
    { name: 'The Coach', path: 'main/The Coach.md' },
    { name: 'The Process', path: 'main/The Process.md' },
    { name: 'The Playbook', path: 'main/The Playbook.md' }
  ];

  const openBookFile = (fileName) => {
    const content = bookContent[fileName];
    if (content) {
      setSelectedBookContent(content);
      setSelectedBookTitle(fileName);
      setShowBookModal(true);
      setShowBookMenu(false);
      setSelectedTag(null); // Reset selected tag when opening new file
    } else {
      console.error('Book content not found:', fileName);
    }
  };

  // Extract all unique tags from content
  const extractTags = (content) => {
    if (!content) return [];
    const tagRegex = /#(\w+)/g;
    const matches = content.match(tagRegex);
    if (!matches) return [];
    const uniqueTags = [...new Set(matches.map(tag => tag.substring(1)))]; // Remove # prefix
    return uniqueTags.sort();
  };

  // Parse content into sections and map tags to sections
  const parseContentSections = (content) => {
    if (!content) return { sections: [], tagMap: {} };

    const lines = content.split('\n');
    const sections = [];
    const tagMap = {};
    let currentSection = null;
    let currentSectionIndex = 0;

    lines.forEach((line, index) => {
      // Check if line is a heading
      const h2Match = line.match(/^## (.+)$/);
      const h3Match = line.match(/^### (.+)$/);
      const h4Match = line.match(/^#### (.+)$/);

      if (h2Match || h3Match || h4Match) {
        // Save previous section if exists
        if (currentSection) {
          sections.push(currentSection);
        }

        // Start new section
        const title = h2Match ? h2Match[1] : (h3Match ? h3Match[1] : h4Match[1]);
        const sectionId = `section-${currentSectionIndex}`;
        currentSection = {
          id: sectionId,
          title: title.trim(),
          level: h2Match ? 2 : (h3Match ? 3 : 4),
          startLine: index,
          content: line + '\n',
          tags: []
        };
        currentSectionIndex++;
      } else if (currentSection) {
        // Add line to current section
        currentSection.content += line + '\n';

        // Extract tags from this line
        const tagRegex = /#(\w+)/g;
        const matches = line.match(tagRegex);
        if (matches) {
          matches.forEach(tag => {
            const tagName = tag.substring(1);
            if (!currentSection.tags.includes(tagName)) {
              currentSection.tags.push(tagName);
            }
            if (!tagMap[tagName]) {
              tagMap[tagName] = [];
            }
            if (!tagMap[tagName].find(s => s.id === currentSection.id)) {
              tagMap[tagName].push({
                id: currentSection.id,
                title: currentSection.title,
                level: currentSection.level,
                snippet: line.substring(0, 100).trim() // First 100 chars as snippet
              });
            }
          });
        }
      }
    });

    // Add last section
    if (currentSection) {
      sections.push(currentSection);
    }

    return { sections, tagMap };
  };

  // Count total occurrences of each tag
  const countTagOccurrences = (content, tagName) => {
    if (!content) return 0;
    const tagRegex = new RegExp(`#${tagName}\\b`, 'g');
    const matches = content.match(tagRegex);
    return matches ? matches.length : 0;
  };

  // Memoize tags and sections parsing
  const { tags, sections, tagSectionsMap, tagCounts } = useMemo(() => {
    if (!selectedBookContent) {
      return { tags: [], sections: [], tagSectionsMap: {}, tagCounts: {} };
    }
    const extractedTags = extractTags(selectedBookContent);
    const { sections: parsedSections, tagMap } = parseContentSections(selectedBookContent);

    // Count total occurrences for each tag
    const counts = {};
    extractedTags.forEach(tag => {
      counts[tag] = countTagOccurrences(selectedBookContent, tag);
    });

    return {
      tags: extractedTags,
      sections: parsedSections,
      tagSectionsMap: tagMap,
      tagCounts: counts
    };
  }, [selectedBookContent]);

  // Scroll to section
  const scrollToSection = (sectionId) => {
    if (bookContentRef.current) {
      const element = bookContentRef.current.querySelector(`#${sectionId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Highlight briefly
        element.style.backgroundColor = theme === 'dark' ? 'rgba(59, 130, 246, 0.3)' : 'rgba(59, 130, 246, 0.1)';
        setTimeout(() => {
          element.style.backgroundColor = 'transparent';
        }, 2000);
      }
    }
  };

  // Default zeroed data - will be replaced with Schwab portfolio data
  const defaultData = {
    summary: {
      totalValue: 0,
      totalDayChange: 0,
      totalDayChangePercent: '0.00',
      totalGainLoss: 0,
      totalGainLossPercent: '0.00',
      positionCount: 0
    },
    assetAllocation: {},
    topHoldings: [],
    lastUpdated: 'Schwab Integration Pending'
  };

  const displayData = portfolioData || defaultData;

  // Calculate bottom padding based on panel heights
  const COLLAPSED_HEIGHT = 40; // Matches ResizableBottomPanels collapsed height
  const EXPANDED_HEIGHT = 500; // 25% taller than 400px
  const volatilityHeight = volatilityExpanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT;
  const securitiesHeight = securitiesExpanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT;
  const maxPanelHeight = Math.max(volatilityHeight, securitiesHeight);

  // Portfolio Metrics Content Component (Refactored to Snapshot)
  const PortfolioMetricsContent = () => (
    <div className="h-full flex flex-col p-4">
      {/* Upload Section - Primary Hero */}
      <div className="mb-6">
        <CSVUpload
          onUploadSuccess={(result) => {
            console.log('CSV uploaded successfully:', result);
          }}
          onUploadError={(error) => {
            console.error('CSV upload failed:', error);
          }}
        />
        <Text className="text-xs text-center text-gray-400 mt-2">
          Last updated: {displayData.lastUpdated}
        </Text>
      </div>

      {/* Snapshot Metrics - Single Compact Row */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Card className="p-3 bg-white dark:bg-gray-800 border-none shadow-sm flex flex-col items-center justify-center">
          <Text className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Total Value</Text>
          <Text className="text-sm font-bold mt-0.5 dark:text-white">
            ${(displayData.summary.totalValue / 1000).toFixed(1)}k
          </Text>
        </Card>

        <Card className="p-3 bg-white dark:bg-gray-800 border-none shadow-sm flex flex-col items-center justify-center">
          <Text className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Net Exposure</Text>
          <Text className="text-sm font-bold mt-0.5 dark:text-white">
            {parseFloat(displayData.exposureMetrics?.netExposure || 0).toFixed(1)}%
          </Text>
        </Card>

        <Card className="p-3 bg-white dark:bg-gray-800 border-none shadow-sm flex flex-col items-center justify-center">
          <Text className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Cash</Text>
          <Text className="text-sm font-bold mt-0.5 dark:text-white">
            {/* Simple cash calculation approximation if not explicitly provided */}
            {displayData.assetAllocation?.['Cash'] ? parseFloat(displayData.assetAllocation['Cash']).toFixed(1) : '—'}%
          </Text>
        </Card>
      </div>

      {/* Secondary Info - Text Row */}
      <div className="flex justify-between items-center px-2 py-2 border-t border-gray-100 dark:border-gray-800">
        <Text className="text-xs text-gray-500">
          Positions: <span className="font-medium text-gray-700 dark:text-gray-300">{displayData.summary.positionCount}</span>
        </Text>
        <Text className="text-xs text-gray-500">
          <span className="text-green-600 font-medium">{displayData.summary.longCount || 0} Long</span> / <span className="text-red-600 font-medium">{displayData.summary.shortCount || 0} Short</span>
        </Text>
      </div>

      {/* Optional: Simple Net Exposure Bar */}
      <div className="mt-4 px-2">
        <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-1.5 overflow-hidden flex">
          {/* Long Bar */}
          <div
            className="bg-emerald-500 h-full"
            style={{ width: `${Math.min(parseFloat(displayData.exposureMetrics?.grossLongExposure || 50), 100)}%` }}
          ></div>
          {/* Short Bar (represented as space or distinct color if we had gross short scaling nicely, but simplified here) */}
        </div>
        <div className="flex justify-between mt-1">
          <Text className="text-[10px] text-emerald-600 font-medium">Long</Text>
          <Text className="text-[10px] text-gray-400">Net Exposure</Text>
          <Text className="text-[10px] text-red-500 font-medium">Short</Text>
        </div>
      </div>

      {/* Call to action for full breakdown */}
      <div className="mt-auto pt-8 text-center">
        <Text className="text-xs text-gray-400 italic">
          See Portfolio Analysis tab for detailed analysis
        </Text>
      </div>
    </div>
  );

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen p-4 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div
          style={{
            width: '40px',
            height: '40px',
            border: '4px solid',
            borderColor: theme === 'dark' ? '#374151' : '#e5e7eb',
            borderTopColor: theme === 'dark' ? '#3b82f6' : '#2563eb',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite'
          }}
        />
        <style>{`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen p-4 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Card className="text-center max-w-md rounded-lg">
          <Title className="text-red-600 dark:text-red-400 mb-4">Error loading data</Title>
          <Text className="mb-4 dark:text-gray-300">{error}</Text>
          <Button onClick={() => window.location.reload()} color="red">
            Retry
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen p-4 bg-gray-50 dark:bg-gray-900"
      style={{
        paddingBottom: `${maxPanelHeight + 20}px`, // Panel height + extra padding
        paddingRight: showPortfolioMetrics ? '0px' : '40px', // No padding when open to extend content closer, matches collapsed width
        transition: 'padding-right 0.3s ease-in-out, padding-bottom 0.3s ease-in-out',
      }}
    >
      {/* Data Updated Notification (Optimistic Update) */}
      {dataUpdatedNotification && (
        <div
          className="fixed top-4 right-4 z-50 animate-fade-in"
          style={{
            animation: 'fadeIn 0.3s ease-in'
          }}
        >
          <Card className="bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800 shadow-lg">
            <div className="flex items-center gap-2">
              <Badge color="emerald" size="sm">
                ✓ {dataUpdatedNotification.message}
              </Badge>
            </div>
          </Card>
        </div>
      )}

      <Grid numItems={12} className="gap-4">

        {/* Left Sidebar - Securities List */}
        <div
          className={signalStrengthExpanded
            ? 'col-span-12 md:col-span-3'
            : 'col-span-12 md:col-span-2'}
          style={{
            zIndex: showPortfolioMetrics ? (signalStrengthExpanded ? 1200 : 100) : 'auto',
            overflow: 'visible', // Allow card to expand beyond container
            transition: 'all 0.3s ease-in-out',
          }}
        >
          <SecuritiesList
            onTickerClick={(ticker) => {
              setSelectedSecurityTicker(ticker);
              setSecuritiesExpanded(true);
            }}
            isPortfolioOpen={showPortfolioMetrics}
            isExpanded={signalStrengthExpanded}
            onExpandToggle={() => setSignalStrengthExpanded(!signalStrengthExpanded)}
          />
        </div>

        {/* Center Panel - USD Macro Dashboard */}
        <div
          className={showPortfolioMetrics
            ? (signalStrengthExpanded ? 'col-span-12 md:col-span-6' : 'col-span-12 md:col-span-7')
            : (signalStrengthExpanded ? 'col-span-12 md:col-span-9' : 'col-span-12 md:col-span-10')}
          style={{
            marginRight: showPortfolioMetrics ? '0px' : '16px', // Match left side p-4 spacing (16px) - main container already has paddingRight: 40px for Portfolio tab
            transition: 'all 0.3s ease-in-out',
          }}
        >
          <USDMacroDashboard />
        </div>

        {/* Right Sidebar - Portfolio Metrics (removed from grid, now in vertical bar) */}
      </Grid>

      {/* Vertical Portfolio Bar - Always Visible */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0, // Always anchored to right
          width: showPortfolioMetrics
            ? 'calc((100vw - 16px) * (2/12) + 16px + 128px)' // Securities width (col-span-2) + gap + Portfolio Metrics content (reduced by another 20%)
            : '40px', // Matches collapsed height of bottom tabs
          height: '100vh',
          zIndex: showPortfolioMetrics ? 1100 : 1000, // Higher z-index when open to overlay Securities
          backgroundColor: showPortfolioMetrics ? '#ffffff' : '#f9fafb', // Match bottom panels when expanded
          borderLeft: showPortfolioMetrics ? '1px solid #e5e7eb' : 'none', // Left border when overlaying Securities
          borderRight: '1px solid #e5e7eb', // Always right border
          borderTop: 'none',
          borderBottom: 'none',
          borderRadius: showPortfolioMetrics ? '1rem 0 0 1rem' : '0.75rem 0 0 0.75rem', // Rounded left corners (top and bottom)
          boxShadow: showPortfolioMetrics
            ? '-2px 0 8px rgba(0, 0, 0, 0.1), 2px 0 8px rgba(0, 0, 0, 0.1)'
            : '-2px 0 8px rgba(0, 0, 0, 0.1)',
          transition: 'width 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: 'flex',
          flexDirection: 'column',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {/* Top Section - Night Mode Toggle */}
        <div
          style={{
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            borderBottom: '1px solid #e5e7eb',
            minHeight: '120px',
          }}
          className="dark:border-gray-700"
        >
          {/* Night Mode Toggle */}
          <button
            onClick={toggleTheme}
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors w-full"
            style={{
              minWidth: '32px',
              height: '32px',
              padding: showPortfolioMetrics ? '0 12px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              gap: showPortfolioMetrics ? '12px' : '0'
            }}
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            <div style={{ width: '20px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: '16px', lineHeight: 1 }}>{theme === 'dark' ? '☀️' : '🌙'}</span>
            </div>
            {showPortfolioMetrics && (
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap">
                {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
              </span>
            )}
          </button>

          {/* X/Twitter Logo Button */}
          <button
            onClick={() => window.open('https://x.com/i/lists/1986465259113357401', '_blank', 'noopener,noreferrer')}
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors w-full mt-2"
            style={{
              minWidth: '32px',
              height: '32px',
              padding: showPortfolioMetrics ? '0 12px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              gap: showPortfolioMetrics ? '12px' : '0'
            }}
            title="Open X (Twitter) List"
          >
            <div style={{ width: '20px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-gray-700 dark:text-gray-300 shrink-0">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </div>
            {showPortfolioMetrics && (
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap">
                X.com
              </span>
            )}
          </button>

          {/* The Pods Button */}
          <button
            onClick={() => setShowPeaPodWindow(!showPeaPodWindow)}
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors w-full mt-2"
            style={{
              minWidth: '32px',
              height: '32px',
              padding: showPortfolioMetrics ? '0 12px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              overflow: 'hidden',
              gap: showPortfolioMetrics ? '12px' : '0'
            }}
            title="The Pods"
          >
            <div className="shrink-0 flex items-center justify-center w-5 h-5" style={{ width: '20px', flexShrink: 0 }}>
              {peaPodImageError ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-gray-700 dark:text-gray-300">
                  <path d="M7 4C5.5 4 4 5.5 4 7.5c0 1.5.8 2.5 2 3v8c0 1.1.9 2 2 2s2-.9 2-2v-8c1.2-.5 2-1.5 2-3 0-2-1.5-3.5-3-3.5zm-1 4.5c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5S4.5 10.8 4.5 10s.7-1.5 1.5-1.5zm3 0c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5S7.5 10.8 7.5 10s.7-1.5 1.5-1.5z" />
                </svg>
              ) : (
                <img
                  src="/images/icons/pea-pod.png"
                  alt="The Pods"
                  style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                  onError={() => setPeaPodImageError(true)}
                />
              )}
            </div>
            {showPortfolioMetrics && (
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap">
                The Pods
              </span>
            )}
          </button>

          {/* Book/Notes Button */}
          <button
            ref={bookMenuRef}
            onClick={() => setShowBookMenu(!showBookMenu)}
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors w-full mt-2"
            style={{
              minWidth: '32px',
              height: '32px',
              padding: showPortfolioMetrics ? '0 12px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              overflow: 'hidden',
              gap: showPortfolioMetrics ? '12px' : '0'
            }}
            title="Open Notes"
          >
            <div className="shrink-0 flex items-center justify-center w-5 h-5" style={{ width: '20px', flexShrink: 0 }}>
              {bookImageError ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-gray-700 dark:text-gray-300">
                  <path d="M4 6 L12 4 L12 20 L4 18 Z M12 4 L20 6 L20 18 L12 20 Z" />
                </svg>
              ) : (
                <img
                  src="/images/icons/book.png"
                  alt="Open Notes"
                  style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                  onError={() => setBookImageError(true)}
                />
              )}
            </div>
            {showPortfolioMetrics && (
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200 whitespace-nowrap">
                Notes
              </span>
            )}
          </button>

          {/* Popover Menu */}
          {showBookMenu && (
            <div
              ref={bookPopoverRef}
              style={{
                position: 'fixed',
                top: `${bookMenuPosition.top}px`,
                right: `${bookMenuPosition.right}px`,
                minWidth: '180px',
                backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
                border: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                borderRadius: '0.375rem',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                zIndex: 1000,
                padding: '4px 0',
              }}
            >
              {bookFiles.map((file, index) => (
                <button
                  key={index}
                  onClick={() => openBookFile(file.name)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 12px',
                    fontSize: '14px',
                    color: theme === 'dark' ? '#f3f4f6' : '#111827',
                    backgroundColor: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  className="hover:bg-gray-100 dark:hover:bg-gray-700"
                  onMouseEnter={(e) => {
                    e.target.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.backgroundColor = 'transparent';
                  }}
                >
                  {file.name}
                </button>
              ))}
            </div>
          )}

          {/* Separator for Main Navigation Buttons */}
          <div style={{
            width: '100%',
            height: '1px',
            backgroundColor: theme === 'dark' ? '#374151' : '#e5e7eb',
            margin: '12px 0 8px 0'
          }} />

          {/* Securities Universe Button */}
          <button
            onClick={() => setShowSecuritiesUniverse(!showSecuritiesUniverse)}
            className={`rounded-md border border-gray-300 dark:border-gray-600 transition-colors w-full ${showSecuritiesUniverse
              ? 'bg-blue-500 dark:bg-blue-600 hover:bg-blue-600 dark:hover:bg-blue-700 text-white'
              : 'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            style={{
              minWidth: '32px',
              height: '32px',
              padding: showPortfolioMetrics ? '0 12px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              overflow: 'hidden',
              marginTop: '4px',
              gap: showPortfolioMetrics ? '12px' : '0'
            }}
            title="Securities Universe"
          >
            <div className="shrink-0 flex items-center justify-center w-6 h-6" style={{ width: '20px', flexShrink: 0 }}>
              {securitiesUniverseImageError ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={showSecuritiesUniverse ? "text-white" : "text-gray-700 dark:text-gray-300"}>
                  <defs>
                    <radialGradient id="planetGradient" cx="0.4" cy="0.3">
                      <stop offset="0%" stopColor="#E6E6FA" stopOpacity="0.9" />
                      <stop offset="50%" stopColor="#9370DB" stopOpacity="0.95" />
                      <stop offset="100%" stopColor="#663399" stopOpacity="1" />
                    </radialGradient>
                    <linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#DDA0DD" stopOpacity="0.8" />
                      <stop offset="50%" stopColor="#9370DB" stopOpacity="0.9" />
                      <stop offset="100%" stopColor="#DDA0DD" stopOpacity="0.8" />
                    </linearGradient>
                  </defs>
                  <circle cx="12" cy="12" r="7" fill="url(#planetGradient)" />
                  <ellipse cx="13" cy="10" rx="3" ry="2" fill="#E6E6FA" opacity="0.4" />
                  <ellipse cx="10" cy="13" rx="2.5" ry="1.8" fill="#DDA0DD" opacity="0.3" />
                  <ellipse cx="12" cy="12" rx="11" ry="2.5" fill="url(#ringGradient)" opacity="0.9" />
                  <ellipse cx="12" cy="12" rx="9.5" ry="2.2" fill="none" stroke="#DDA0DD" strokeWidth="0.5" opacity="0.7" />
                  <ellipse cx="12" cy="12" rx="9" ry="2" fill="url(#ringGradient)" opacity="0.8" />
                  <ellipse cx="12" cy="12" rx="7.5" ry="1.8" fill="none" stroke="#DDA0DD" strokeWidth="0.4" opacity="0.6" />
                  <ellipse cx="12" cy="12" rx="7" ry="1.5" fill="url(#ringGradient)" opacity="0.7" />
                </svg>
              ) : (
                <img
                  src="/images/icons/securities-universe.png"
                  alt="Securities Universe"
                  style={{ width: '24px', height: '24px', objectFit: 'contain' }}
                  onError={() => setSecuritiesUniverseImageError(true)}
                />
              )}
            </div>
            {showPortfolioMetrics && (
              <span className={`text-sm font-medium whitespace-nowrap ${showSecuritiesUniverse ? 'text-white' : 'text-gray-700 dark:text-gray-200'}`}>
                Securities Universe
              </span>
            )}
          </button>

          {/* Performance Tracking Button */}
          <button
            onClick={() => setShowPerformanceTracking(!showPerformanceTracking)}
            className={`rounded-md border border-gray-300 dark:border-gray-600 transition-colors w-full ${showPerformanceTracking
              ? 'bg-blue-500 dark:bg-blue-600 hover:bg-blue-600 dark:hover:bg-blue-700 text-white'
              : 'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            style={{
              minWidth: '32px',
              height: '32px',
              padding: showPortfolioMetrics ? '0 12px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              overflow: 'hidden',
              marginTop: '4px',
              gap: showPortfolioMetrics ? '12px' : '0'
            }}
            title="Performance Tracking"
          >
            <div className="shrink-0 flex items-center justify-center w-5 h-5" style={{ width: '20px', flexShrink: 0 }}>
              {performanceImageError ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={showPerformanceTracking ? "text-white" : "text-gray-700 dark:text-gray-300"}>
                  <polyline points="22 6 13.5 15.5 8.5 10.5 2 17" />
                  <polyline points="16 6 22 6 22 12" />
                </svg>
              ) : (
                <img
                  src="/images/icons/performance.png"
                  alt="Performance Tracking"
                  style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                  onError={() => setPerformanceImageError(true)}
                />
              )}
            </div>
            {showPortfolioMetrics && (
              <span className={`text-sm font-medium whitespace-nowrap ${showPerformanceTracking ? 'text-white' : 'text-gray-700 dark:text-gray-200'}`}>
                Performance
              </span>
            )}
          </button>

          {/* Portfolio Breakdown Button */}
          <button
            onClick={() => setShowPortfolioBreakdown(!showPortfolioBreakdown)}
            className={`rounded-md border border-gray-300 dark:border-gray-600 transition-colors w-full ${showPortfolioBreakdown
              ? 'bg-blue-500 dark:bg-blue-600 hover:bg-blue-600 dark:hover:bg-blue-700 text-white'
              : 'bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            style={{
              minWidth: '32px',
              height: '32px',
              padding: showPortfolioMetrics ? '0 12px' : '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: showPortfolioMetrics ? 'flex-start' : 'center',
              overflow: 'hidden',
              marginTop: '4px',
              gap: showPortfolioMetrics ? '12px' : '0'
            }}
            title="Portfolio Breakdown"
          >
            <div className="shrink-0 flex items-center justify-center w-5 h-5" style={{ width: '20px', flexShrink: 0 }}>
              {portfolioBreakdownImageError ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={showPortfolioBreakdown ? "text-white" : "text-gray-700 dark:text-gray-300"}>
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 2 L12 12 L20 12 Z" fill="currentColor" opacity="0.8" />
                  <path d="M12 2 A10 10 0 0 1 22 12 L12 12 Z" fill="currentColor" opacity="0.4" />
                  <path d="M12 2 A10 10 0 0 0 2 12 L12 12 Z" fill="currentColor" opacity="0.2" />
                </svg>
              ) : (
                <img
                  src="/images/icons/portfolio-construction.png"
                  alt="Portfolio Breakdown"
                  style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                  onError={() => setPortfolioBreakdownImageError(true)}
                />
              )}
            </div>
            {showPortfolioMetrics && (
              <span className={`text-sm font-medium whitespace-nowrap ${showPortfolioBreakdown ? 'text-white' : 'text-gray-700 dark:text-gray-200'}`}>
                Portfolio Analysis
              </span>
            )}
          </button>

          {/* Expand/Collapse Portfolio Bar Button */}
          <button
            onClick={() => setShowPortfolioMetrics(!showPortfolioMetrics)}
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors mt-2 w-full"
            title={showPortfolioMetrics ? "Collapse Portfolio" : "Expand Portfolio"}
            style={{
              minWidth: '32px',
              height: '30px',
              padding: '0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="text-gray-700 dark:text-gray-300"
            >
              <path
                d={showPortfolioMetrics ? "M6 12L10 8L6 4" : "M10 12L6 8L10 4"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {/* Expanded Content Area */}
        {showPortfolioMetrics && (
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '16px',
            }}
          >
            <PortfolioMetricsContent />
          </div>
        )}
      </div>

      {/* The Pods Window - Separate Pop-out Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: showPortfolioMetrics
            ? 'calc((100vw - 16px) * (2/12) + 16px + 128px)' // Position to the left of portfolio bar when open
            : '40px', // Position to the left of collapsed portfolio bar
          width: showPeaPodWindow
            ? 'calc((100vw - 16px) * (2/12) + 16px + 128px)' // Same width as portfolio window
            : '0px',
          height: '100vh',
          zIndex: showPeaPodWindow ? 1200 : -1, // Higher z-index than portfolio bar when open, hidden when closed
          backgroundColor: '#f9fafb',
          borderLeft: showPeaPodWindow ? '1px solid #e5e7eb' : 'none',
          borderRight: showPeaPodWindow ? '1px solid #e5e7eb' : 'none',
          borderRadius: showPeaPodWindow ? '0.75rem 0 0 0' : '0',
          boxShadow: showPeaPodWindow
            ? '-2px 0 8px rgba(0, 0, 0, 0.1), 2px 0 8px rgba(0, 0, 0, 0.1)'
            : 'none',
          transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: showPeaPodWindow ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {showPeaPodWindow && (
          <>
            {/* Header with Centered Title (Clickable to Close) */}
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                cursor: 'pointer',
              }}
              className="dark:border-gray-700"
              onClick={() => setShowPeaPodWindow(false)}
            >
              <Title
                className="dark:text-white"
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: '#374151',
                  margin: 0,
                  userSelect: 'none',
                }}
              >
                The Pods
              </Title>
            </div>

            {/* Scrollable Content */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '16px',
              }}
            >
              {/* Securities Search Box */}
              <div className="relative mb-4" style={{ width: '100%', maxWidth: '400px' }}>
                <input
                  ref={podsSearchInputRef}
                  type="text"
                  value={podsSearchQuery}
                  placeholder="Search securities..."
                  onChange={(e) => {
                    setPodsSearchQuery(e.target.value);
                    setPodsShowSearchResults(true);
                    setPodsHighlightedIndex(-1);
                  }}
                  onFocus={() => {
                    if (podsSearchQuery.trim()) {
                      setPodsShowSearchResults(true);
                    }
                  }}
                  onBlur={() => {
                    // Delay hiding to allow click on results
                    setTimeout(() => {
                      setPodsShowSearchResults(false);
                      setPodsHighlightedIndex(-1);
                    }, 200);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setPodsHighlightedIndex(prev =>
                        prev < podsFilteredSecurities.length - 1 ? prev + 1 : prev
                      );
                      setPodsShowSearchResults(true);
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setPodsHighlightedIndex(prev => prev > 0 ? prev - 1 : -1);
                    } else if (e.key === 'Enter' && podsHighlightedIndex >= 0) {
                      e.preventDefault();
                      const selected = podsFilteredSecurities[podsHighlightedIndex];
                      if (selected) {
                        handlePodsSecuritySelect(selected);
                      }
                    } else if (e.key === 'Escape') {
                      setPodsShowSearchResults(false);
                      setPodsSearchQuery('');
                      podsSearchInputRef.current?.blur();
                    }
                  }}
                  className="px-3 py-2 text-sm border border-gray-300 rounded-md bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0 w-full"
                />
                {podsShowSearchResults && podsFilteredSecurities.length > 0 && (
                  <div
                    className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 shadow-lg max-h-60 overflow-y-auto"
                    style={{ top: '100%' }}
                  >
                    {podsFilteredSecurities.map((security, index) => (
                      <div
                        key={security.ticker}
                        onClick={() => handlePodsSecuritySelect(security)}
                        className={`px-3 py-2 cursor-pointer text-sm ${index === podsHighlightedIndex
                          ? 'bg-blue-100 dark:bg-blue-900/30'
                          : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                        onMouseEnter={() => setPodsHighlightedIndex(index)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="font-semibold dark:text-white">{security.ticker}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-500 ml-2">
                            {ASSET_CLASS_NAMES[security.assetClass] || security.assetClass}
                          </div>
                        </div>
                        <div className="text-xs text-gray-600 dark:text-gray-400 truncate">
                          {security.name}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* POD Calculations */}
              <div
                className="mt-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
                style={{ width: '100%', maxWidth: '400px' }}
              >
                <Text className="text-sm font-semibold dark:text-white mb-4">
                  POD Calculations
                </Text>

                <div className="space-y-4">
                  {/* POD1 */}
                  <div className="p-3 bg-white dark:bg-gray-700 rounded-md border border-gray-200 dark:border-gray-600">
                    <div className="flex items-center justify-between mb-2">
                      <Text className="text-sm font-semibold dark:text-white">
                        POD1
                      </Text>
                      <Badge color="blue" size="sm">
                        Revenue
                      </Badge>
                    </div>
                    <Text className="text-xs text-gray-600 dark:text-gray-400">
                      #roc of REVENUE Growth
                    </Text>
                    <div className="mt-2">
                      <Text className="text-lg font-bold dark:text-white">
                        {podsSelectedSecurity ? '--' : '--'}
                      </Text>
                    </div>
                  </div>

                  {/* POD2 */}
                  <div className="p-3 bg-white dark:bg-gray-700 rounded-md border border-gray-200 dark:border-gray-600">
                    <div className="flex items-center justify-between mb-2">
                      <Text className="text-sm font-semibold dark:text-white">
                        POD2
                      </Text>
                      <Badge color="emerald" size="sm">
                        EBITDA/EPS
                      </Badge>
                    </div>
                    <Text className="text-xs text-gray-600 dark:text-gray-400">
                      #roc of EBITDA or EPS Growth
                    </Text>
                    <div className="mt-2">
                      <Text className="text-lg font-bold dark:text-white">
                        {podsSelectedSecurity ? '--' : '--'}
                      </Text>
                    </div>
                  </div>

                  {/* POD3 */}
                  <div className="p-3 bg-white dark:bg-gray-700 rounded-md border border-gray-200 dark:border-gray-600">
                    <div className="flex items-center justify-between mb-2">
                      <Text className="text-sm font-semibold dark:text-white">
                        POD3
                      </Text>
                      <Badge color="purple" size="sm">
                        FCF
                      </Badge>
                    </div>
                    <Text className="text-xs text-gray-600 dark:text-gray-400">
                      #roc of FCF (Free Cash Flow) Growth
                    </Text>
                    <div className="mt-2">
                      <Text className="text-lg font-bold dark:text-white">
                        {podsSelectedSecurity ? '--' : '--'}
                      </Text>
                    </div>
                  </div>
                </div>
              </div>

              {/* Selected Security Display (Placeholder for future calculation) */}
              {podsSelectedSecurity && (
                <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                  <Text className="text-sm font-semibold dark:text-white mb-2">
                    Selected Security
                  </Text>
                  <Text className="text-sm dark:text-gray-300">
                    <strong>Ticker:</strong> {podsSelectedSecurity.ticker}
                  </Text>
                  <Text className="text-sm dark:text-gray-300">
                    <strong>Name:</strong> {podsSelectedSecurity.name}
                  </Text>
                  <Text className="text-sm dark:text-gray-300">
                    <strong>Asset Class:</strong> {ASSET_CLASS_NAMES[podsSelectedSecurity.assetClass] || podsSelectedSecurity.assetClass}
                  </Text>
                  <Text className="text-sm dark:text-gray-400 mt-2 italic">
                    Calculation will appear here based on 3 factors
                  </Text>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Book/Notes Modal */}
      {showBookModal && selectedBookContent && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => {
            setShowBookModal(false);
            setSelectedTag(null);
          }}
        >
          <div
            style={{
              backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
              borderRadius: '0.75rem',
              width: '90%',
              maxWidth: selectedTag ? '1400px' : '1200px',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'row',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
              transition: 'max-width 0.3s ease-in-out',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Left Sidebar - Tag Navigation */}
            {selectedTag && tagSectionsMap[selectedTag] && (
              <div
                style={{
                  width: '250px',
                  borderRight: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  backgroundColor: theme === 'dark' ? '#111827' : '#f9fafb',
                  transition: 'width 0.3s ease-in-out',
                }}
              >
                {/* Sidebar Header */}
                <div
                  style={{
                    padding: '16px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      margin: 0,
                    }}
                  >
                    #{selectedTag}
                  </Text>
                  <Button
                    onClick={() => setSelectedTag(null)}
                    variant="secondary"
                    size="sm"
                    style={{ minWidth: '24px', height: '24px', padding: '0', fontSize: '14px' }}
                  >
                    ✕
                  </Button>
                </div>

                {/* Sections List */}
                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '8px',
                  }}
                >
                  {tagSectionsMap[selectedTag].map((section, index) => (
                    <div
                      key={section.id}
                      onClick={() => scrollToSection(section.id)}
                      style={{
                        padding: '12px',
                        marginBottom: '8px',
                        borderRadius: '0.375rem',
                        cursor: 'pointer',
                        backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
                        border: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                        transition: 'all 0.2s ease-in-out',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                        e.currentTarget.style.borderColor = theme === 'dark' ? '#4b5563' : '#d1d5db';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = theme === 'dark' ? '#1f2937' : '#ffffff';
                        e.currentTarget.style.borderColor = theme === 'dark' ? '#374151' : '#e5e7eb';
                      }}
                    >
                      <div
                        style={{
                          fontSize: section.level === 2 ? '14px' : '13px',
                          fontWeight: section.level === 2 ? 600 : 500,
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          marginBottom: '4px',
                        }}
                      >
                        {section.title}
                      </div>
                      {section.snippet && (
                        <div
                          style={{
                            fontSize: '11px',
                            color: theme === 'dark' ? '#9ca3af' : '#6b7280',
                            lineHeight: '1.4',
                            marginTop: '4px',
                          }}
                        >
                          {section.snippet}...
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Main Content Area */}
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0, // Allow flexbox to shrink
              }}
            >
              {/* Modal Header */}
              <div
                style={{
                  padding: '20px',
                  borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Title
                  style={{
                    fontSize: '24px',
                    fontWeight: 700,
                    margin: 0,
                    color: theme === 'dark' ? '#f3f4f6' : '#111827',
                  }}
                >
                  {selectedBookTitle}
                </Title>
                <Button
                  onClick={() => {
                    setShowBookModal(false);
                    setSelectedTag(null);
                  }}
                  variant="secondary"
                  size="sm"
                  style={{ minWidth: '32px', height: '32px', padding: '0' }}
                >
                  ✕
                </Button>
              </div>

              {/* Tag Bar */}
              {tags.length > 0 && (
                <div
                  style={{
                    padding: '12px 20px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px',
                    backgroundColor: theme === 'dark' ? '#111827' : '#f9fafb',
                  }}
                >
                  {tags.map((tag) => {
                    const count = tagCounts[tag] || 0;
                    const isActive = selectedTag === tag;
                    return (
                      <button
                        key={tag}
                        onClick={() => setSelectedTag(isActive ? null : tag)}
                        style={{
                          padding: '6px 12px',
                          fontSize: '12px',
                          fontWeight: 500,
                          borderRadius: '0.375rem',
                          border: `1px solid ${isActive
                            ? (theme === 'dark' ? '#3b82f6' : '#2563eb')
                            : (theme === 'dark' ? '#374151' : '#d1d5db')
                            }`,
                          backgroundColor: isActive
                            ? (theme === 'dark' ? '#1e3a8a' : '#dbeafe')
                            : (theme === 'dark' ? '#1f2937' : '#ffffff'),
                          color: isActive
                            ? (theme === 'dark' ? '#93c5fd' : '#1e40af')
                            : (theme === 'dark' ? '#f3f4f6' : '#111827'),
                          cursor: 'pointer',
                          transition: 'all 0.2s ease-in-out',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                        onMouseEnter={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                            e.currentTarget.style.borderColor = theme === 'dark' ? '#4b5563' : '#9ca3af';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive) {
                            e.currentTarget.style.backgroundColor = theme === 'dark' ? '#1f2937' : '#ffffff';
                            e.currentTarget.style.borderColor = theme === 'dark' ? '#374151' : '#d1d5db';
                          }
                        }}
                      >
                        <span>#{tag}</span>
                        <span
                          style={{
                            fontSize: '10px',
                            opacity: 0.7,
                            padding: '2px 6px',
                            borderRadius: '0.25rem',
                            backgroundColor: isActive
                              ? (theme === 'dark' ? 'rgba(147, 197, 253, 0.2)' : 'rgba(30, 64, 175, 0.2)')
                              : (theme === 'dark' ? 'rgba(156, 163, 175, 0.2)' : 'rgba(107, 114, 128, 0.2)'),
                          }}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Modal Content */}
              <div
                ref={bookContentRef}
                style={{
                  padding: '24px',
                  overflowY: 'auto',
                  flex: 1,
                  color: theme === 'dark' ? '#f3f4f6' : '#111827',
                  lineHeight: '1.6',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                }}
              >
                <ReactMarkdown
                  components={{
                    h2: ({ node, children, ...props }) => {
                      const text = String(children);
                      const section = sections.find(s => s.title === text.trim() && s.level === 2);
                      return (
                        <h2
                          id={section?.id || undefined}
                          style={{
                            fontSize: '1.5rem',
                            fontWeight: 700,
                            marginTop: '2rem',
                            marginBottom: '1rem',
                            borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                            paddingBottom: '0.5rem',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          }}
                          {...props}
                        >
                          {children}
                        </h2>
                      );
                    },
                    h3: ({ node, children, ...props }) => {
                      const text = String(children);
                      const section = sections.find(s => s.title === text.trim() && s.level === 3);
                      return (
                        <h3
                          id={section?.id || undefined}
                          style={{
                            fontSize: '1.25rem',
                            fontWeight: 600,
                            marginTop: '1.5rem',
                            marginBottom: '0.75rem',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          }}
                          {...props}
                        >
                          {children}
                        </h3>
                      );
                    },
                    h4: ({ node, children, ...props }) => {
                      const text = String(children);
                      const section = sections.find(s => s.title === text.trim() && s.level === 4);
                      return (
                        <h4
                          id={section?.id || undefined}
                          style={{
                            fontSize: '1.1rem',
                            fontWeight: 600,
                            marginTop: '1.25rem',
                            marginBottom: '0.75rem',
                            color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          }}
                          {...props}
                        >
                          {children}
                        </h4>
                      );
                    },
                    p: ({ node, children, ...props }) => (
                      <p
                        style={{
                          marginBottom: '1rem',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        }}
                        {...props}
                      >
                        {children}
                      </p>
                    ),
                    strong: ({ node, children, ...props }) => (
                      <strong style={{ fontWeight: 700 }} {...props}>
                        {children}
                      </strong>
                    ),
                    em: ({ node, children, ...props }) => (
                      <em style={{ fontStyle: 'italic' }} {...props}>
                        {children}
                      </em>
                    ),
                    hr: ({ node, ...props }) => (
                      <hr
                        style={{
                          margin: '1.5rem 0',
                          border: 'none',
                          borderTop: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                        }}
                        {...props}
                      />
                    ),
                    ul: ({ node, children, ...props }) => (
                      <ul
                        style={{
                          marginBottom: '1rem',
                          paddingLeft: '1.5rem',
                          listStyleType: 'disc',
                        }}
                        {...props}
                      >
                        {children}
                      </ul>
                    ),
                    ol: ({ node, children, ...props }) => (
                      <ol
                        style={{
                          marginBottom: '1rem',
                          paddingLeft: '1.5rem',
                          listStyleType: 'decimal',
                        }}
                        {...props}
                      >
                        {children}
                      </ol>
                    ),
                    li: ({ node, children, ...props }) => (
                      <li
                        style={{
                          marginBottom: '0.5rem',
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                        }}
                        {...props}
                      >
                        {children}
                      </li>
                    ),
                  }}
                >
                  {selectedBookContent}
                </ReactMarkdown>
              </div>
            </div>

            {/* Right Sidebar - Table of Contents */}
            {sections.length > 0 && (
              <div
                style={{
                  width: '220px',
                  borderLeft: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  backgroundColor: theme === 'dark' ? '#111827' : '#f9fafb',
                  transition: 'width 0.3s ease-in-out',
                }}
              >
                {/* TOC Header */}
                <div
                  style={{
                    padding: '16px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`,
                  }}
                >
                  <Text
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: theme === 'dark' ? '#f3f4f6' : '#111827',
                      margin: 0,
                    }}
                  >
                    Table of Contents
                  </Text>
                </div>

                {/* TOC List */}
                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '12px 8px',
                  }}
                >
                  {sections.map((section, index) => {
                    const indent = section.level === 2 ? 0 : section.level === 3 ? 16 : 32;
                    return (
                      <div
                        key={section.id}
                        onClick={() => scrollToSection(section.id)}
                        style={{
                          padding: '8px 12px',
                          paddingLeft: `${12 + indent}px`,
                          marginBottom: '4px',
                          borderRadius: '0.375rem',
                          cursor: 'pointer',
                          backgroundColor: 'transparent',
                          transition: 'all 0.2s ease-in-out',
                          fontSize: section.level === 2 ? '13px' : section.level === 3 ? '12px' : '11px',
                          fontWeight: section.level === 2 ? 600 : section.level === 3 ? 500 : 400,
                          color: theme === 'dark' ? '#f3f4f6' : '#111827',
                          borderLeft: section.level === 2
                            ? `2px solid ${theme === 'dark' ? '#374151' : '#e5e7eb'}`
                            : 'none',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = 'transparent';
                        }}
                      >
                        {section.title}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Resizable Bottom Panels */}
      <ResizableBottomPanels
        volatilityExpanded={volatilityExpanded}
        securitiesExpanded={securitiesExpanded}
        onVolatilityToggle={setVolatilityExpanded}
        onSecuritiesToggle={setSecuritiesExpanded}
        securitiesFullWidth={securitiesFullWidth}
        onSecuritiesFullWidthToggle={(fullWidth) => {
          setSecuritiesFullWidth(fullWidth);
          if (fullWidth) {
            setSecuritiesExpanded(true);
          }
        }}
        selectedTicker={selectedSecurityTicker}
      />

      {/* Securities Universe Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: showPortfolioMetrics
            ? 'calc((100vw - 16px) * (2/12) + 16px + 128px)'
            : '40px',
          width: showSecuritiesUniverse
            ? (showPortfolioMetrics
              ? 'calc((100vw - 16px) * (10/12) - 128px)'
              : 'calc((100vw - 16px) * (9/12) - 40px)')
            : '0px',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: showSecuritiesUniverse ? 1400 : -1,
          borderLeft: showSecuritiesUniverse ? '1px solid #e5e7eb' : 'none',
          borderRight: showSecuritiesUniverse ? '1px solid #e5e7eb' : 'none',
          borderRadius: showSecuritiesUniverse ? '0.75rem 0 0 0' : '0',
          boxShadow: showSecuritiesUniverse
            ? '-2px 0 8px rgba(0, 0, 0, 0.1), 2px 0 8px rgba(0, 0, 0, 0.1)'
            : 'none',
          transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: showSecuritiesUniverse ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {showSecuritiesUniverse && (
          <>
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                cursor: 'pointer',
              }}
              className="dark:border-gray-700"
              onClick={() => setShowSecuritiesUniverse(false)}
            >
              <Title
                className="dark:text-white"
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: '#374151',
                  margin: 0,
                  userSelect: 'none',
                }}
              >
                Securities Universe
              </Title>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 0,
              }}
            >
              <SecuritiesUniverse />
            </div>
          </>
        )}
      </div>

      {/* Performance Tracking Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: showPortfolioMetrics
            ? 'calc((100vw - 16px) * (2/12) + 16px + 128px)'
            : '40px',
          width: showPerformanceTracking
            ? (showPortfolioMetrics
              ? 'calc((100vw - 16px) * (10/12) - 128px)'
              : 'calc((100vw - 16px) * (9/12) - 40px)')
            : '0px',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: showPerformanceTracking ? 1500 : -1,
          borderLeft: showPerformanceTracking ? '1px solid #e5e7eb' : 'none',
          borderRight: showPerformanceTracking ? '1px solid #e5e7eb' : 'none',
          borderRadius: showPerformanceTracking ? '0.75rem 0 0 0' : '0',
          boxShadow: showPerformanceTracking
            ? '-2px 0 8px rgba(0, 0, 0, 0.1), 2px 0 8px rgba(0, 0, 0, 0.1)'
            : 'none',
          transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: showPerformanceTracking ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {showPerformanceTracking && (
          <>
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                cursor: 'pointer',
              }}
              className="dark:border-gray-700"
              onClick={() => setShowPerformanceTracking(false)}
            >
              <Title
                className="dark:text-white"
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: '#374151',
                  margin: 0,
                  userSelect: 'none',
                }}
              >
                Performance Tracking
              </Title>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 0,
              }}
            >
              <PerformanceTracking />
            </div>
          </>
        )}
      </div>

      {/* Portfolio Breakdown Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: showPortfolioMetrics
            ? 'calc((100vw - 16px) * (2/12) + 16px + 128px)'
            : '40px',
          width: showPortfolioBreakdown
            ? (showPortfolioMetrics
              ? 'calc((100vw - 16px) * (10/12) - 128px)'
              : 'calc((100vw - 16px) * (9/12) - 40px)')
            : '0px',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: showPortfolioBreakdown ? 1300 : -1,
          borderLeft: showPortfolioBreakdown ? '1px solid #e5e7eb' : 'none',
          borderRight: showPortfolioBreakdown ? '1px solid #e5e7eb' : 'none',
          borderRadius: showPortfolioBreakdown ? '0.75rem 0 0 0' : '0',
          boxShadow: showPortfolioBreakdown
            ? '-2px 0 8px rgba(0, 0, 0, 0.1), 2px 0 8px rgba(0, 0, 0, 0.1)'
            : 'none',
          transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
          display: showPortfolioBreakdown ? 'flex' : 'none',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {showPortfolioBreakdown && (
          <>
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                cursor: 'pointer',
              }}
              className="dark:border-gray-700"
              onClick={() => setShowPortfolioBreakdown(false)}
            >
              <Title
                className="dark:text-white"
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: '#374151',
                  margin: 0,
                  userSelect: 'none',
                }}
              >
                Portfolio Analysis
              </Title>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '16px',
              }}
            >
              <PortfolioBreakdown portfolioData={portfolioData} isLoading={loading} />
            </div>
          </>
        )}
      </div>

      {/* Workflow Status Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0, // Always anchored to right edge
          width: showWorkflowStatus
            ? 'calc((100vw - 16px) * (5/12))' // Fixed width, independent of portfolio bar
            : '0px',
          height: '100vh',
          backgroundColor: '#ffffff',
          zIndex: showWorkflowStatus ? 1600 : -1,
          borderLeft: showWorkflowStatus ? '1px solid #e5e7eb' : 'none',
          borderTop: showWorkflowStatus ? '1px solid #e5e7eb' : 'none',
          borderBottom: showWorkflowStatus ? '1px solid #e5e7eb' : 'none',
          boxShadow: showWorkflowStatus
            ? '-2px 0 8px rgba(0, 0, 0, 0.1)'
            : 'none',
          transition: 'width 0.3s ease-in-out',
          display: showWorkflowStatus ? 'flex' : 'none',
          visibility: showWorkflowStatus ? 'visible' : 'hidden',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: showWorkflowStatus ? '0.75rem 0 0 0' : '0', // Rounded top-left corner
        }}
        className="dark:bg-gray-900/95 dark:border-gray-700 backdrop-blur-sm"
      >
        {showWorkflowStatus && (
          <>
            {/* Header with Centered Title (Clickable to Close) */}
            <div
              style={{
                padding: '8px 12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                background: 'linear-gradient(to bottom, rgba(249, 250, 251, 0.8), rgba(243, 244, 246, 0.5))',
              }}
              className="dark:border-gray-700 dark:bg-gradient-to-b dark:from-gray-800/80 dark:to-gray-700/50"
            >
              {/* Empty spacer for centering */}
              <div style={{ width: '28px' }} />

              <Title
                className="dark:text-white"
                style={{
                  fontSize: '14px',
                  fontWeight: 700,
                  color: '#374151',
                  margin: 0,
                  userSelect: 'none',
                  cursor: 'pointer',
                }}
                onClick={() => setShowWorkflowStatus(false)}
              >
                Analytics
              </Title>

              {/* Refresh Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setAnalyticsRefreshKey(prev => prev + 1);
                }}
                style={{
                  width: '28px',
                  height: '28px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'transparent',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '16px',
                  color: theme === 'dark' ? '#9ca3af' : '#6b7280',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = theme === 'dark' ? '#374151' : '#f3f4f6';
                  e.currentTarget.style.color = theme === 'dark' ? '#f3f4f6' : '#374151';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = theme === 'dark' ? '#9ca3af' : '#6b7280';
                }}
                title="Refresh Analytics"
              >
                ↻
              </button>
            </div>

            {/* Scrollable Content */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 0,
              }}
            >
              <WorkflowStatus key={analyticsRefreshKey} />
            </div>
          </>
        )}
      </div>

      {/* Analytics Button - Standalone in Bottom Right Corner */}
      <div
        style={{
          position: 'fixed',
          bottom: '16px',
          right: '16px',
          zIndex: 1700,
        }}
      >
        <Button
          onClick={() => setShowWorkflowStatus(!showWorkflowStatus)}
          variant={showWorkflowStatus ? 'primary' : 'secondary'}
          size="md"
          className="shadow-lg"
          style={{
            minWidth: '48px',
            height: '48px',
            padding: '0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '50%',
            border: showWorkflowStatus ? '2px solid #3b82f6' : '2px solid #e5e7eb',
            backgroundColor: '#ffffff',
            transition: 'all 0.2s ease-in-out',
          }}
          title="Analytics"
        >
          <img
            src="/images/icons/analytics.png"
            alt="Analytics"
            style={{
              width: '24px',
              height: '24px',
              objectFit: 'contain',
            }}
          />
        </Button>
      </div>
    </div >
  );
};

export default PortfolioDashboard;
