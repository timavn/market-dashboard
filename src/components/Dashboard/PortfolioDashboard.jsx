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

const PortfolioDashboard = () => {
  const { theme, toggleTheme } = useTheme();
  const [portfolioData, setPortfolioData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showPortfolioMetrics, setShowPortfolioMetrics] = useState(false);
  const [showPeaPodWindow, setShowPeaPodWindow] = useState(false);
  const [volatilityExpanded, setVolatilityExpanded] = useState(false);
  const [securitiesExpanded, setSecuritiesExpanded] = useState(false);
  const [securitiesFullWidth, setSecuritiesFullWidth] = useState(false);
  const [peaPodImageError, setPeaPodImageError] = useState(false);
  const [bookImageError, setBookImageError] = useState(false);
  const [showBookMenu, setShowBookMenu] = useState(false);
  const [showBookModal, setShowBookModal] = useState(false);
  const [selectedBookContent, setSelectedBookContent] = useState(null);
  const [selectedBookTitle, setSelectedBookTitle] = useState('');
  const [bookMenuPosition, setBookMenuPosition] = useState({ top: 0, right: 0 });
  const bookMenuRef = useRef(null);
  const bookPopoverRef = useRef(null);
  
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
  const fetchPortfolio = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await MarketDataService.getPortfolio();
      setPortfolioData(data);
    } catch (e) {
      setError(e.message || 'Failed to load portfolio');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    fetchPortfolio();
    
    // Listen for portfolio refresh events (after CSV upload)
    const handlePortfolioRefresh = () => {
      if (isMounted) {
        console.log('Refreshing portfolio data after CSV upload...');
        fetchPortfolio();
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

  // Portfolio Metrics Content Component
  const PortfolioMetricsContent = () => (
    <Card className="dark:bg-gray-800" style={{ height: '100%', overflowY: 'auto', border: 'none', boxShadow: 'none', backgroundColor: 'transparent' }}>
      <Text className="text-xs text-gray-500 dark:text-gray-400 mb-4">
        Updated: {displayData.lastUpdated}
      </Text>
      
      {/* CSV Upload Section */}
      <div className="mb-6 pb-6 border-b">
        <CSVUpload 
          onUploadSuccess={(result) => {
            console.log('CSV uploaded successfully:', result);
          }}
          onUploadError={(error) => {
            console.error('CSV upload failed:', error);
          }}
        />
      </div>
      
      {/* Total Portfolio */}
      <div className="mb-6">
        <Title className="text-sm mb-3 dark:text-white">Total Portfolio</Title>
        <div className="space-y-3">
          <Metric className="dark:text-white">
            ${displayData.summary.totalValue.toLocaleString()}
          </Metric>
          
          {/* Position Sizing Legend */}
          <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1 pt-2 border-t dark:border-gray-700">
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
              <div>
                <div className="text-gray-600 dark:text-gray-500 font-medium mb-0.5">Long:</div>
                <div>FX : 4-12%</div>
                <div>Fixed Income : 4-10%</div>
                <div>Equities : 2-6%</div>
                <div>Commodities : 2-4%</div>
                <div>Crypto : 2-4%</div>
              </div>
              <div>
                <div className="text-gray-600 dark:text-gray-500 font-medium mb-0.5">Short:</div>
                <div>FX : 2-6%</div>
                <div>Fixed Income : 2-5%</div>
                <div>Equities : 1-3%</div>
                <div>Commodities : 1-2%</div>
                <div>Crypto : 1-2%</div>
              </div>
            </div>
            <div className="pt-1 border-t dark:border-gray-700 mt-1">
              <div className="text-gray-600 dark:text-gray-500 font-medium mb-0.5">Basis Points:</div>
              <div className="grid grid-cols-4 gap-x-2">
                <div>25 bps: ${Math.floor(displayData.summary.totalValue * 0.0025).toLocaleString()}</div>
                <div>50 bps: ${Math.floor(displayData.summary.totalValue * 0.005).toLocaleString()}</div>
                <div>100 bps: ${Math.floor(displayData.summary.totalValue * 0.01).toLocaleString()}</div>
                <div>500 bps: ${Math.floor(displayData.summary.totalValue * 0.05).toLocaleString()}</div>
              </div>
            </div>
          </div>
          
          <div className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
            <Text className="text-sm dark:text-white">P&L MTD</Text>
            <Badge color={parseFloat(displayData.summary.totalDayChange) >= 0 ? 'emerald' : 'rose'}>
              {displayData.summary.totalDayChange >= 0 ? '+' : ''}${displayData.summary.totalDayChange.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({parseFloat(displayData.summary.totalDayChangePercent).toFixed(2)}%)
            </Badge>
          </div>
          <div className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
            <Text className="text-xs dark:text-white">P&L YTD</Text>
            <Badge color={parseFloat(displayData.summary.totalGainLoss) >= 0 ? 'emerald' : 'rose'}>
              {displayData.summary.totalGainLoss >= 0 ? '+' : ''}${displayData.summary.totalGainLoss.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({parseFloat(displayData.summary.totalGainLossPercent).toFixed(2)}%)
            </Badge>
          </div>
          <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <Text className="text-sm dark:text-white">Positions</Text>
            <Text className="font-semibold dark:text-white">{displayData.summary.positionCount}</Text>
          </div>
        </div>
      </div>

      {/* Net Exposure */}
      {displayData.exposureMetrics && (
        <div className="mb-6 pt-6 border-t dark:border-gray-700">
          <Title className="text-sm mb-3 dark:text-white">Net Exposure</Title>
          <div className="space-y-2">
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Gross Exposure</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.exposureMetrics.grossExposure || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-green-50 dark:bg-green-900/20 rounded border border-green-200 dark:border-green-800">
              <Text className="text-xs dark:text-white">Net Long</Text>
              <Badge color="emerald" size="xs">
                {parseFloat(displayData.exposureMetrics.netLongExposure || 0).toFixed(2)}%
              </Badge>
            </div>
            <div className="flex justify-between items-center p-2 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
              <Text className="text-xs dark:text-white">Net Short</Text>
              <Badge color="red" size="xs">
                {parseFloat(displayData.exposureMetrics.netShortExposure || 0).toFixed(2)}%
              </Badge>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Net Exposure</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.exposureMetrics.netExposure || 0).toFixed(2)}%</Text>
            </div>
          </div>
        </div>
      )}

      {/* Risk Metrics */}
      {displayData.riskMetrics && (
        <div className="mb-6 pt-6 border-t dark:border-gray-700">
          <Title className="text-sm mb-3 dark:text-white">Risk Metrics</Title>
          <div className="space-y-2">
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Sharpe Ratio</Text>
              <Text className="text-xs font-semibold dark:text-white">{displayData.riskMetrics.sharpeRatio || '0.00'}</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Sortino Ratio</Text>
              <Text className="text-xs font-semibold dark:text-white">{displayData.riskMetrics.sortinoRatio || '0.00'}</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
              <Text className="text-xs dark:text-white">VaR (1d, 95%)</Text>
              <Badge color="red" size="xs">${displayData.riskMetrics.var95 || '0'}</Badge>
            </div>
            <div className="flex justify-between items-center p-2 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800">
              <Text className="text-xs dark:text-white">Max Drawdown</Text>
              <Badge color="amber" size="xs">{displayData.riskMetrics.maxDrawdown || '0.00'}%</Badge>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Volatility (Ann.)</Text>
              <Text className="text-xs font-semibold dark:text-white">{displayData.riskMetrics.volatility || '0.00'}%</Text>
            </div>
          </div>
        </div>
      )}

      {/* Asset Class Allocation */}
      {Object.keys(displayData.assetAllocation).length > 0 && (
        <div className="mb-6 pt-6 border-t dark:border-gray-700">
          <Title className="text-sm mb-3 dark:text-white">Asset Class Allocation</Title>
          <div className="space-y-2">
            {Object.entries(displayData.assetAllocation).map(([type, percentage]) => (
              <div key={type} className="space-y-1">
                <div className="flex justify-between items-center">
                  <Text className="text-xs dark:text-white">{type}</Text>
                  <Text className="text-xs font-semibold dark:text-white">{parseFloat(percentage || 0).toFixed(2)}%</Text>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                  <div 
                    className="bg-blue-600 h-2 rounded-full" 
                    style={{ width: `${Math.min(parseFloat(percentage), 100)}%` }}
                  ></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Holdings */}
      {displayData.topHoldings && displayData.topHoldings.length > 0 && (
        <div className="mb-6 pt-6 border-t dark:border-gray-700">
          <Title className="text-sm mb-3 dark:text-white">Top Holdings</Title>
          <div className="space-y-2">
            {displayData.topHoldings.map((holding) => (
              <div key={holding.symbol} className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                <Text className="text-xs font-semibold dark:text-white">{holding.symbol}</Text>
                <Text className="text-xs dark:text-white">
                  {portfolioData ? `$${holding.marketValue?.toLocaleString() || '0'}` : `${holding.accountPercent}%`}
                </Text>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Geographic Exposure */}
      {displayData.factorExposures?.geographic && (
        <div className="mb-6 pt-6 border-t dark:border-gray-700">
          <Title className="text-sm mb-3 dark:text-white">Geographic Exposure</Title>
          <div className="space-y-2">
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">North America</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.factorExposures.geographic.northAmerica || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Europe</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.factorExposures.geographic.europe || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Asia Pacific</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.factorExposures.geographic.asiaPacific || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Emerging Markets</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.factorExposures.geographic.emergingMarkets || 0).toFixed(2)}%</Text>
            </div>
          </div>
        </div>
      )}

      {/* Concentration Risk */}
      {displayData.concentrationMetrics && (
        <div className="pt-6 border-t dark:border-gray-700">
          <Title className="text-sm mb-3 dark:text-white">Concentration Risk</Title>
          <div className="space-y-2">
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Top 10 Holdings</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.concentrationMetrics.top10HoldingsPercent || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Largest Position</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.concentrationMetrics.largestPositionPercent || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">HHI Index</Text>
              <Text className="text-xs font-semibold dark:text-white">{displayData.concentrationMetrics.hhiIndex || '0.000'}</Text>
            </div>
          </div>
        </div>
      )}
    </Card>
  );

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen p-4 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Card className="text-center max-w-md">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-blue-500 border-t-transparent mx-auto mb-4"></div>
          <Text className="dark:text-gray-300">Loading market data...</Text>
        </Card>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen p-4 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Card className="text-center max-w-md">
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
      <Grid numItems={12} className="gap-4">
        
        {/* Left Sidebar - Securities List */}
        <div 
          className={showPortfolioMetrics ? 'col-span-12 md:col-span-2' : 'col-span-12 md:col-span-3'}
          style={{
            zIndex: showPortfolioMetrics ? 100 : 'auto', // Lower z-index when Portfolio Metrics overlays
          }}
        >
          <SecuritiesList />
        </div>

        {/* Center Panel - USD Macro Dashboard */}
        <div 
          className={showPortfolioMetrics ? 'col-span-12 md:col-span-7' : 'col-span-12 md:col-span-9'}
          style={{
            marginRight: showPortfolioMetrics ? '0px' : '16px', // Match left side p-4 spacing (16px) - main container already has paddingRight: 40px for Portfolio tab
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
          backgroundColor: '#f9fafb', // Solid opaque background
          borderLeft: showPortfolioMetrics ? '1px solid #e5e7eb' : 'none', // Left border when overlaying Securities
          borderRight: '1px solid #e5e7eb', // Always right border
          boxShadow: showPortfolioMetrics 
            ? '-2px 0 8px rgba(0, 0, 0, 0.1), 2px 0 8px rgba(0, 0, 0, 0.1)' 
            : '-2px 0 8px rgba(0, 0, 0, 0.1)',
          transition: 'width 0.3s ease-in-out',
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
          <Button
            onClick={toggleTheme}
            variant="secondary"
            size="sm"
            className="shadow-sm w-full"
            style={{ minWidth: '32px', height: '32px', padding: '0' }}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </Button>
          
          {/* X/Twitter Logo Button */}
          <Button
            onClick={() => window.open('https://x.com/i/lists/1986465259113357401', '_blank', 'noopener,noreferrer')}
            variant="secondary"
            size="sm"
            className="shadow-sm w-full mt-2"
            style={{ minWidth: '32px', height: '32px', padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Open X (Twitter) List"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>
          </Button>
          
          {/* The Pods Button */}
          <Button
            onClick={() => setShowPeaPodWindow(!showPeaPodWindow)}
            variant="secondary"
            size="sm"
            className="shadow-sm w-full mt-2"
            style={{ minWidth: '32px', height: '32px', padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
            title="The Pods"
          >
            {peaPodImageError ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 4C5.5 4 4 5.5 4 7.5c0 1.5.8 2.5 2 3v8c0 1.1.9 2 2 2s2-.9 2-2v-8c1.2-.5 2-1.5 2-3 0-2-1.5-3.5-3-3.5zm-1 4.5c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5S4.5 10.8 4.5 10s.7-1.5 1.5-1.5zm3 0c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5S7.5 10.8 7.5 10s.7-1.5 1.5-1.5z"/>
              </svg>
            ) : (
              <img 
                src="/images/icons/pea-pod.png" 
                alt="The Pods" 
                style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                onError={() => setPeaPodImageError(true)}
              />
            )}
          </Button>

          {/* Book/Notes Button */}
          <Button
            ref={bookMenuRef}
            onClick={() => setShowBookMenu(!showBookMenu)}
            variant="secondary"
            size="sm"
            className="shadow-sm w-full mt-2"
            style={{ minWidth: '32px', height: '32px', padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
            title="Open Notes"
          >
            {bookImageError ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 6 L12 4 L12 20 L4 18 Z M12 4 L20 6 L20 18 L12 20 Z"/>
              </svg>
            ) : (
              <img 
                src="/images/icons/book.png" 
                alt="Open Notes" 
                style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                onError={() => setBookImageError(true)}
              />
            )}
          </Button>
          
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
        </div>

        {/* Collapsed "Portfolio" Text - Vertical and Centered */}
        {!showPortfolioMetrics && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: '0 16px',
            }}
            onClick={() => setShowPortfolioMetrics(true)}
          >
            <Title
              style={{
                writingMode: 'vertical-rl',
                textOrientation: 'mixed',
                fontSize: '18px',
                fontWeight: 700,
                color: '#374151',
                margin: 0,
                userSelect: 'none',
              }}
              className="dark:text-gray-300"
            >
              Portfolio
            </Title>
          </div>
        )}

        {/* Expanded Content Area */}
        {showPortfolioMetrics && (
          <>
            {/* Header with Centered Title (Clickable to Collapse) */}
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
              onClick={() => setShowPortfolioMetrics(false)}
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
                Portfolio Metrics
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
              <PortfolioMetricsContent />
            </div>
          </>
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
          boxShadow: showPeaPodWindow 
            ? '-2px 0 8px rgba(0, 0, 0, 0.1), 2px 0 8px rgba(0, 0, 0, 0.1)' 
            : 'none',
          transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out',
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
                  className="px-3 py-2 text-sm border border-gray-300 rounded-none bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0 w-full"
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
                        className={`px-3 py-2 cursor-pointer text-sm ${
                          index === podsHighlightedIndex
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
                  <div className="p-3 bg-white dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">
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
                  <div className="p-3 bg-white dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">
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
                  <div className="p-3 bg-white dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">
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
              borderRadius: '0.5rem',
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
      />
    </div>
  );
};

export default PortfolioDashboard;
