import React, { useState, useEffect, useRef } from 'react';
import { Card, Title, Text, Badge, Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell, Button, Metric } from '@tremor/react';
import { MarketDataService } from '../../services/api/marketDataService';
import { ENDPOINTS } from '../../constants/apiEndpoints';
import { useTheme } from '../../context/ThemeContext';
import { SERVICE_CONFIG, calculateTotals } from '../../constants/serviceTracking';
import { SECURITIES_LIST } from '../../constants/securitiesList';
import axios from 'axios';

// Helper to format dates consistently (M/D)
const formatDate = (dateStr) => {
  // Fallback to today's date if dateStr is empty/null
  if (!dateStr) {
    return new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
  }
  // Append T12:00:00 to force local time interpretation in mid-day (avoiding timezone shifts)
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
};

const WorkflowStatus = () => {
  const { theme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('Initializing...');
  const [workflowStatus, setWorkflowStatus] = useState(null);
  const [riskRanges, setRiskRanges] = useState({});
  const [freshnessData, setFreshnessData] = useState(null);
  const [changelogData, setChangelogData] = useState(null);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [activeTab, setActiveTab] = useState('freshness'); // 'freshness', 'preview', 'services'
  const [serviceTotals, setServiceTotals] = useState(null);
  const [csvUrl, setCsvUrl] = useState(null);
  const [previewViewMode, setPreviewViewMode] = useState('table'); // 'table' or 'json'
  const [selectedPreviewDate, setSelectedPreviewDate] = useState(() => {
    // Default to today in YYYY-MM-DD format (EST timezone)
    const today = new Date();
    return today.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  });
  const [snapshotCache, setSnapshotCache] = useState({}); // Cache: {"type-date": {data, pdfUrl}}

  // All 6 data types with their PDF loading states
  const DATA_TYPES = [
    { key: 'risk-ranges', label: 'Risk Ranges' },
    { key: 'early-look', label: 'Early Look' },
    { key: 'bitcoin-trend-tracker', label: 'Bitcoin Tracker' },
    { key: 'momo-tracker', label: 'Momo Tracker' },
    { key: 'signal-strength', label: 'Signal Strength' },
    { key: 'portfolio-solutions', label: 'Portfolio Solutions' }
  ];

  // Track PDF URLs and loading states for each data type
  const [allPdfData, setAllPdfData] = useState({});
  // Track snapshot data for each data type (for table views)
  const [allSnapshotData, setAllSnapshotData] = useState({});

  // Track last fetched run date to prevent re-fetching on tab switch
  const lastFetchedRunDate = useRef(null);

  const isDark = theme === 'dark';

  // Get hedgeyeStatus and csvStatus from workflowStatus (with safe defaults)
  const hedgeyeStatus = workflowStatus?.hedgeye || {};
  const csvStatus = workflowStatus?.csvUpload || {};

  // Fetch workflow status and data
  const fetchData = async () => {
    console.log('[WorkflowStatus] fetchData called');
    try {
      setLoading(true);
      setLoadingStatus('Loading data...');
      const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
      console.log('[WorkflowStatus] Backend URL:', backendUrl);

      // Helper for individual timeouts
      // Increased to 60s because server can be busy with price fetches
      const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out - server may be busy')), ms))
      ]);

      const TIMEOUT_MS = 60000; // 60s individual timeout (server can be busy with price fetches)

      // Execute all fetches in parallel using Promise.allSettled
      // This ensures that if one request fails/hangs, others are still processed
      const results = await Promise.allSettled([
        withTimeout(axios.get(`${backendUrl}${ENDPOINTS.WORKFLOW_STATUS || '/api/workflow-status'}`), TIMEOUT_MS),
        withTimeout(MarketDataService.getRiskRanges(), TIMEOUT_MS),
        withTimeout(MarketDataService.getHedgeyeFreshness(), TIMEOUT_MS),
        withTimeout(axios.get(`${backendUrl}/api/hedgeye/changelog`), TIMEOUT_MS)
      ]);

      console.log('[WorkflowStatus] All promises settled, processing results...');
      console.log('[WorkflowStatus] Results:', results.map(r => r.status));

      // Process workflow status
      if (results[0].status === 'fulfilled') {
        console.log('[WorkflowStatus] Workflow status fulfilled:', results[0].value.data?.hedgeye?.lastRun);
        setWorkflowStatus(results[0].value.data);
      } else {
        console.error('Error fetching workflow status:', results[0].reason);
        setWorkflowStatus({
          hedgeye: {
            status: 'unknown',
            lastRun: null,
            count: 0,
            nextRun: '8:00 AM EST (market days)'
          },
          csvUpload: {
            status: 'unknown',
            lastUpload: null,
            records: 0,
            fileName: null
          }
        });
      }

      // Process risk ranges
      if (results[1].status === 'fulfilled') {
        setRiskRanges(results[1].value || {});
      } else {
        console.error('Error fetching risk ranges:', results[1].reason);
        setRiskRanges({});
      }

      // Process freshness data
      if (results[2].status === 'fulfilled') {
        console.log('[WorkflowStatus] Freshness fulfilled, risk-ranges itemCount:', results[2].value?.dataTypes?.['risk-ranges']?.itemCount);
        setFreshnessData(results[2].value);
      } else {
        console.error('Error fetching Hedgeye freshness:', results[2].reason);
        setFreshnessData(null);
      }

      // Process changelog data
      if (results[3].status === 'fulfilled') {
        setChangelogData(results[3].value.data);
      } else {
        console.error('Error fetching Hedgeye changelog:', results[3].reason);
        setChangelogData(null);
      }

      setLastRefresh(new Date());
    } catch (error) {
      console.error('Error in fetchData:', error);
    } finally {
      setLoading(false);
      setLoadingStatus('');
    }
  };

  // Fetch all PDFs sequentially when preview tab is active
  // Fetch all PDFs sequentially when preview tab is active
  useEffect(() => {
    const currentHedgeyeStatus = workflowStatus?.hedgeye || {};
    if (activeTab === 'preview' && currentHedgeyeStatus.lastRun) {
      // Only fetch if we haven't fetched for this date yet
      if (lastFetchedRunDate.current !== currentHedgeyeStatus.lastRun) {
        fetchAllPdfs();
        fetchCsvUrl();
        lastFetchedRunDate.current = currentHedgeyeStatus.lastRun;
      }
    }
  }, [activeTab, workflowStatus]);

  useEffect(() => {
    fetchData();

    // Calculate service totals
    const totals = calculateTotals();
    setServiceTotals(totals);

    // Auto-refresh every 5 minutes
    const interval = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch preview data when selected date changes
  useEffect(() => {
    if (activeTab === 'preview' && selectedPreviewDate) {
      console.log(`📅 Fetching preview data for ${selectedPreviewDate}`);
      fetchAllPdfs(selectedPreviewDate);
    }
  }, [selectedPreviewDate, activeTab]);

  // Helper: Get data from local storage cache
  const getFromCache = (key, date) => {
    try {
      const cacheKey = `hedgeye_pdf_${key}_${date}`;
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {
      console.warn('Error reading from cache:', e);
    }
    return null;
  };

  // Helper: Save data to local storage cache
  const saveToCache = (key, date, data) => {
    try {
      const cacheKey = `hedgeye_pdf_${key}_${date}`;
      localStorage.setItem(cacheKey, JSON.stringify(data));
    } catch (e) {
      console.warn('Error saving to cache:', e);
    }
  };



  // Improved parallel fetcher
  const fetchAllPdfs = async (customDate = null) => {
    const currentHedgeyeStatus = workflowStatus?.hedgeye || {};
    if (!currentHedgeyeStatus.lastRun && !customDate) return;

    const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
    const date = customDate || new Date(currentHedgeyeStatus.lastRun).toISOString().split('T')[0];

    // Helper to fetch single item
    const fetchItem = async (key) => {
      // Set loading state for this item
      setAllPdfData(prev => ({
        ...prev,
        [key]: { ...prev[key], loading: true, error: null }
      }));

      try {
        // --- PDF / Screenshot Handling ---
        let pdfResult = null;
        const cachedPdf = getFromCache(key, date);

        if (cachedPdf) {
          console.log(`[Cache Hit] ${key}`);
          pdfResult = cachedPdf;
        } else {
          // Fetch from network
          const response = await axios.get(`${backendUrl}/api/hedgeye/screenshot/${date}?type=${key}`);
          pdfResult = {
            url: response.data.url,
            type: response.data.type || 'screenshot',
            error: null
          };
          // Cache it
          saveToCache(key, date, pdfResult);
        }

        // Update PDF state immediately
        setAllPdfData(prev => ({
          ...prev,
          [key]: { loading: false, ...pdfResult }
        }));

        // --- Snapshot Handling (with cache) ---
        const cacheKey = `${key}-${date}`;

        // Check cache first
        if (snapshotCache[cacheKey]) {
          console.log(`✓ Using cached snapshot for ${key} on ${date}`);
          setAllSnapshotData(prev => ({
            ...prev,
            [key]: snapshotCache[cacheKey]
          }));
        } else {
          // Fetch from API
          try {
            const snapshotResponse = await axios.get(`${backendUrl}/api/hedgeye/snapshot/${key}?date=${date}`);
            const snapshotData = snapshotResponse.data;

            // Store in cache
            setSnapshotCache(prev => ({
              ...prev,
              [cacheKey]: snapshotData
            }));

            setAllSnapshotData(prev => ({
              ...prev,
              [key]: snapshotData
            }));
          } catch (err) {
            console.warn(`Snapshot failed for ${key} on ${date}`, err);
            setAllSnapshotData(prev => ({
              ...prev,
              [key]: null
            }));
          }
        }

      } catch (error) {
        console.error(`Error fetching PDF for ${key}:`, error);
        setAllPdfData(prev => ({
          ...prev,
          [key]: {
            loading: false,
            url: null,
            type: null,
            error: 'Not available'
          }
        }));
      }
    };

    // Fire all requests in parallel
    await Promise.all(DATA_TYPES.map(item => fetchItem(item.key)));
  };

  // Fetch CSV presigned URL
  const fetchCsvUrl = async () => {
    const currentHedgeyeStatus = workflowStatus?.hedgeye || {};
    if (!currentHedgeyeStatus.lastRun) return;

    try {
      const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
      const date = new Date(currentHedgeyeStatus.lastRun).toISOString().split('T')[0];
      const response = await axios.get(`${backendUrl}/api/hedgeye/csv/${date}`);
      setCsvUrl(response.data.url);
    } catch (error) {
      console.error('Error fetching CSV URL:', error);
      setCsvUrl(null);
    }
  };

  // Calculate data freshness
  const getDataFreshness = (contentDate, uploadTimestamp, dataType) => {
    if (!contentDate) return { status: 'error', hours: null, label: 'No data', dateStr: 'Never', timestampStr: 'Never' };

    // Current date in YYYY-MM-DD format (EST)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    let dataDate;
    // Check if contentDate is already YYYY-MM-DD (Content Date from backend)
    const isSimpleContentDate = typeof contentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(contentDate);

    if (isSimpleContentDate) {
      dataDate = contentDate;
    } else {
      const co = new Date(contentDate);
      if (isNaN(co.getTime())) return { status: 'error', hours: null, label: 'Invalid Date', dateStr: 'Invalid', timestampStr: 'Invalid' };
      dataDate = co.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    }

    // Determine the display timestamp string
    // Use uploadTimestamp if provided, otherwise fallback to contentDate
    const displayTime = uploadTimestamp || contentDate;
    const isSimpleDisplayDate = typeof displayTime === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(displayTime);

    let dateObj;
    if (isSimpleDisplayDate) {
      dateObj = new Date(displayTime + 'T12:00:00');
    } else {
      dateObj = new Date(displayTime);
    }

    if (isNaN(dateObj.getTime())) {
      return { status: 'error', hours: null, label: 'Invalid Display Date', dateStr: 'Invalid', timestampStr: 'Invalid' };
    }

    // Professional timestamp format (e.g. "2026-01-21 14:30:45")
    const timestampStr = isSimpleDisplayDate
      ? displayTime // Just show the date if we don't have time
      : dateObj.toLocaleString('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).replace(',', '');

    // Display string (e.g. "Jan 21")
    const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    // Calculate age in hours (approximation for simple dates)
    const daysDiff = (new Date(today) - new Date(dataDate)) / (1000 * 60 * 60 * 24);
    const hoursAgo = daysDiff * 24;

    // Green only if SAME DAY
    if (dataDate === today) {
      return { status: 'success', hours: hoursAgo, label: dateStr, dateStr, timestampStr };
    }

    // Custom threshold for bi-weekly products (Signal Strength, Portfolio Solutions)
    // Allow up to 4 days (96 hours) to be "Yellow" instead of "Red"
    const isBiWeekly = dataType === 'signal-strength' || dataType === 'portfolio-solutions';
    const warningThreshold = isBiWeekly ? 96 : 48;

    if (hoursAgo < warningThreshold) {
      // Yellow (Warning) - valid but not today
      const daysAgo = Math.round(hoursAgo / 24);
      return { status: 'warning', hours: hoursAgo, label: `${dateStr} ${daysAgo > 0 ? `(${daysAgo}d ago)` : ''}`, dateStr, timestampStr };
    } else {
      // Red (Error) - too old
      const daysAgo = Math.round(hoursAgo / 24);
      return { status: 'error', hours: hoursAgo, label: `${dateStr} ${daysAgo > 0 ? `(${daysAgo}d ago)` : ''}`, dateStr, timestampStr };
    }
  };

  // Format timestamp - professional format like "January 21, 2026"
  const formatTimestamp = (timestamp) => {
    if (!timestamp) return 'Never';
    const isSimpleDate = typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(timestamp);
    const date = isSimpleDate ? new Date(timestamp + 'T12:00:00') : new Date(timestamp);

    return date.toLocaleString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  };

  // Get status badge color
  const getStatusColor = (status) => {
    switch (status) {
      case 'success':
      case 'healthy':
        return 'emerald';
      case 'warning':
      case 'stale':
        return 'yellow';
      case 'error':
      case 'failed':
        return 'red';
      default:
        return 'gray';
    }
  };

  const hedgeyeFreshness = getDataFreshness(hedgeyeStatus.lastRun, hedgeyeStatus.scrapedAt);
  const csvFreshness = getDataFreshness(csvStatus.lastUpload, csvStatus.scrapedAt);

  // Validation helper: check if a row has valid data
  const getRowStatus = (ticker, lrr, hrr) => {
    if (lrr >= hrr) return { status: 'error', icon: '❌', message: 'LRR >= HRR' };
    if (lrr < 0 || hrr < 0) return { status: 'error', icon: '❌', message: 'Negative value' };
    if (lrr === 0 && hrr === 0) return { status: 'error', icon: '❌', message: 'Missing data' };
    return { status: 'valid', icon: '✓', message: '' };
  };

  // Convert risk ranges to table data with validation status
  // Preserves original extraction order for easy side-by-side comparison with PDF
  const riskRangesTableData = Object.entries(riskRanges).map(([ticker, data]) => {
    const lrr = data.lrr || 0;
    const hrr = data.hrr || 0;
    const validation = getRowStatus(ticker, lrr, hrr);
    return {
      ticker,
      lrr,
      hrr,
      trend: data.trend || 'N/A',
      timestamp: data.timestamp || null,
      status: validation.status,
      statusIcon: validation.icon,
      statusMessage: validation.message
    };
  }); // No sorting - preserves extraction order to match PDF

  // Calculate health metrics for the health bar
  const extractedCount = riskRangesTableData.length;
  const expectedCount = SECURITIES_LIST.length;
  const errorCount = riskRangesTableData.filter(r => r.status === 'error').length;
  const validCount = riskRangesTableData.filter(r => r.status === 'valid').length;

  // Calculate coverage - which securities from SECURITIES_LIST have Hedgeye data
  const hedgeyeTickers = new Set(riskRangesTableData.map(r => r.ticker));
  const missingTickers = SECURITIES_LIST
    .filter(s => !hedgeyeTickers.has(s.ticker))
    .map(s => s.ticker)
    .sort();
  const coveragePercent = expectedCount > 0 ? Math.round((extractedCount / expectedCount) * 100) : 0;

  // Determine overall health status
  const getHealthStatus = () => {
    if (extractedCount === 0) return { status: 'error', label: 'NO DATA', color: 'red' };
    if (errorCount > 0) return { status: 'warning', label: 'WARNINGS', color: 'yellow' };
    if (hedgeyeFreshness.status === 'error') return { status: 'stale', label: 'STALE', color: 'yellow' };
    if (hedgeyeFreshness.status === 'warning') return { status: 'warning', label: 'AGING', color: 'yellow' };
    return { status: 'healthy', label: 'HEALTHY', color: 'emerald' };
  };
  const healthStatus = getHealthStatus();

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>


      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          backgroundColor: isDark ? '#1f2937' : '#f9fafb',
          overflowX: 'auto',
          backdropFilter: 'blur(4px)',
        }}
        className="dark:border-gray-700"
      >
        {['freshness', 'preview', 'services'].map((tab) => {
          const tabLabels = {
            freshness: 'Data Upload',
            preview: 'Data Preview',
            services: 'Services & Costs'
          };

          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                flex: '0 0 auto',
                padding: '8px 12px',
                border: 'none',
                backgroundColor: 'transparent',
                color: activeTab === tab
                  ? (isDark ? '#60a5fa' : '#2563eb')
                  : (isDark ? '#9ca3af' : '#6b7280'),
                cursor: 'pointer',
                fontWeight: activeTab === tab ? 600 : 400,
                fontSize: '12px',
                whiteSpace: 'nowrap'
              }}
            >
              {tabLabels[tab]}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '6px' }}>
        {loading && !workflowStatus && !freshnessData ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '400px',
            gap: '16px'
          }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                border: '3px solid',
                borderColor: isDark ? '#374151' : '#e5e7eb',
                borderTopColor: isDark ? '#3b82f6' : '#2563eb',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite'
              }}
            />
            <Text style={{
              fontSize: '12px',
              color: isDark ? '#9ca3af' : '#6b7280',
              fontWeight: 500,
              letterSpacing: '0.01em'
            }}>
              {loadingStatus}
            </Text>
            <style>{`
              @keyframes spin {
                to { transform: rotate(360deg); }
              }
            `}</style>
          </div>
        ) : activeTab === 'freshness' ? (
          /* Daily Freshness - New Primary View */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div>
              <Title style={{ fontSize: '15px', fontWeight: 600, color: isDark ? '#f9fafb' : '#111827' }}>
                Data Upload
              </Title>
            </div>

            {/* Data Upload Table */}
            <Card
              className={isDark ? 'dark:bg-gray-800' : ''}
              style={{
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '0.5rem',
                padding: '0',
                overflow: 'hidden'
              }}
            >
              <div style={{
                backgroundColor: isDark ? '#374151' : '#f3f4f6',
                borderBottom: `1px solid ${isDark ? '#4b5563' : '#e5e7eb'}`,
                padding: '3px 5px'
              }}>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 2fr',
                  gap: '4px'
                }}>
                  <Text style={{
                    fontSize: '5px',
                    fontWeight: 600,
                    color: isDark ? '#9ca3af' : '#6b7280'
                  }}>
                    Source
                  </Text>
                  <Text style={{
                    fontSize: '5px',
                    fontWeight: 600,
                    color: isDark ? '#9ca3af' : '#6b7280'
                  }}>
                    Items
                  </Text>
                  <Text style={{
                    fontSize: '5px',
                    fontWeight: 600,
                    color: isDark ? '#9ca3af' : '#6b7280'
                  }}>
                    Last Upload
                  </Text>
                </div>
              </div>

              <div>
                {(() => {
                  // Define the 6 data types with their display info
                  const dataTypeConfig = {
                    'risk-ranges': { name: 'Risk Ranges', unit: 'items' },
                    'early-look': { name: 'Early Look', unit: 'items' },
                    'bitcoin-trend-tracker': { name: 'Bitcoin Tracker', unit: 'items' },
                    'momo-tracker': { name: 'MOMO Tracker', unit: 'items' },
                    'signal-strength': { name: 'Signal Strength', unit: 'items' },
                    'portfolio-solutions': { name: 'Portfolio Solutions', unit: 'items' }
                  };

                  return Object.entries(dataTypeConfig).map(([key, config], index) => {
                    const data = freshnessData?.dataTypes?.[key] || { status: 'missing', itemCount: 0 };

                    // Get background color based on status
                    const getBackgroundColor = (status) => {
                      if (status === 'fresh') return isDark ? 'rgba(16, 185, 129, 0.15)' : 'rgba(16, 185, 129, 0.1)'; // light green
                      if (status === 'stale') return isDark ? 'rgba(234, 179, 8, 0.15)' : 'rgba(234, 179, 8, 0.1)'; // light yellow
                      return isDark ? 'rgba(239, 68, 68, 0.15)' : 'rgba(239, 68, 68, 0.1)'; // light red
                    };

                    // Get hover background color based on status
                    const getHoverBackgroundColor = (status) => {
                      if (status === 'fresh') return isDark ? 'rgba(16, 185, 129, 0.25)' : 'rgba(16, 185, 129, 0.15)';
                      if (status === 'stale') return isDark ? 'rgba(234, 179, 8, 0.25)' : 'rgba(234, 179, 8, 0.15)';
                      return isDark ? 'rgba(239, 68, 68, 0.25)' : 'rgba(239, 68, 68, 0.15)';
                    };

                    // Frontend freshness is still used for the timestamp
                    const freshness = getDataFreshness(data.lastUpdated || data.date, data.scrapedAt, key);

                    return (
                      <div
                        key={key}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '2fr 1fr 2fr',
                          gap: '4px',
                          padding: '4px 5px',
                          borderBottom: index < 5 ? `1px solid ${isDark ? '#374151' : '#e5e7eb'}` : 'none',
                          cursor: 'pointer',
                          transition: 'background-color 0.15s ease',
                          backgroundColor: getBackgroundColor(data.status)
                        }}
                        onClick={() => {
                          setActiveTab('preview');
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = getHoverBackgroundColor(data.status);
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = getBackgroundColor(data.status);
                        }}
                      >
                        {/* Source Column */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                          <Text style={{
                            fontSize: '5px',
                            fontWeight: 500,
                            color: isDark ? '#f9fafb' : '#111827'
                          }}>
                            {config.name}
                          </Text>
                        </div>

                        {/* Items Column */}
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <Text style={{
                            fontSize: '5px',
                            color: isDark ? '#e5e7eb' : '#374151',
                            fontWeight: 500
                          }}>
                            {data.itemCount}
                          </Text>
                        </div>

                        {/* Last Upload Column */}
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <Text style={{
                            fontSize: '5px',
                            color: isDark ? '#9ca3af' : '#6b7280',
                            fontFamily: 'monospace'
                          }}>
                            {freshness.timestampStr}
                          </Text>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </Card>

            {/* Alerts Section */}
            {freshnessData?.alerts && freshnessData.alerts.length > 0 && (
              <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
                <Title style={{ fontSize: '14px', marginBottom: '12px', color: isDark ? '#f9fafb' : '#111827' }}>
                  Alerts ({freshnessData.alerts.length})
                </Title>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {freshnessData.alerts.map((alert, index) => (
                    <div
                      key={index}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 12px',
                        backgroundColor: alert.severity === 'error'
                          ? (isDark ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.05)')
                          : (isDark ? 'rgba(234, 179, 8, 0.1)' : 'rgba(234, 179, 8, 0.05)'),
                        borderRadius: '6px',
                        border: `1px solid ${alert.severity === 'error' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(234, 179, 8, 0.3)'}`
                      }}
                    >
                      <span style={{ fontSize: '14px' }}>{alert.severity === 'error' ? '🔴' : '⚠️'}</span>
                      <Text style={{ fontSize: '13px', color: isDark ? '#f9fafb' : '#111827' }}>
                        <strong style={{ textTransform: 'capitalize' }}>{alert.type.replace('-', ' ')}:</strong> {alert.message}
                      </Text>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* No Alerts - All Good - Section removed per user request */}

            {/* Changelog Section */}
            <div style={{ marginTop: '12px' }}>
              <Title style={{ fontSize: '14px', fontWeight: 600, color: isDark ? '#f9fafb' : '#111827', marginBottom: '8px' }}>
                Changes
              </Title>
              {changelogLoading ? (
                <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280' }}>Loading changelog...</Text>
              ) : !changelogData || Object.keys(changelogData).length === 0 ? (
                <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280' }}>No changelog data available.</Text>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' }}>
                  {[
                    { key: 'risk-ranges', label: 'Risk Ranges' },
                    { key: 'early-look', label: 'Early Look' },
                    { key: 'bitcoin-trend-tracker', label: 'Bitcoin Tracker' },
                    { key: 'portfolio-solutions', label: 'Portfolio Solutions' },
                    { key: 'signal-strength', label: 'Signal Strength' },
                    { key: 'momo-tracker', label: 'MOMO Tracker' }
                  ].map(({ key, label }) => {
                    const diff = changelogData[key];

                    // Always show bitcoin-trend-tracker, portfolio-solutions, momo-tracker, and signal-strength cards
                    const alwaysShow = key === 'bitcoin-trend-tracker' || key === 'portfolio-solutions' || key === 'momo-tracker' || key === 'signal-strength';

                    if (!alwaysShow) {
                      if (!diff || !diff.available) return null;
                      if (diff.added.length === 0 && diff.removed.length === 0 && (!diff.updates || diff.updates.length === 0) && (!diff.trendChanges || diff.trendChanges.length === 0)) return null;
                    }

                    // Check if there's any data to display
                    const hasData = diff && diff.available && (
                      diff.added.length > 0 ||
                      diff.removed.length > 0 ||
                      (diff.updates && diff.updates.length > 0) ||
                      (diff.trendChanges && diff.trendChanges.length > 0) ||
                      (diff.cryptoTrendChanges && diff.cryptoTrendChanges.length > 0) ||
                      (diff.etfTrendChanges && diff.etfTrendChanges.length > 0)
                    );

                    return (
                      <Card key={key} className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem', padding: '10px' }}>
                        {/* Card Title - Centered for all cards */}
                        <div style={{ textAlign: 'center', marginBottom: '12px' }}>
                          <Text style={{ fontSize: '10px', fontWeight: 700, color: isDark ? '#f9fafb' : '#111827', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            {key === 'risk-ranges' ? 'Risk Ranges (TREND)' : label}
                          </Text>
                        </div>

                        {/* Removed 'No changes detected' text per user request */}


                        {key === 'risk-ranges' && diff && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            {/* 1. Trend Changes */}
                            <div>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'block' }}>
                                Trend Changes <span style={{ fontWeight: 400, fontSize: '10px' }}>({formatDate(diff.currentDate)})</span>
                              </div>
                              {diff.trendChanges && diff.trendChanges.length > 0 ? (
                                <div style={{ display: 'grid', gap: '4px' }}>
                                  {/* Header */}
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', fontSize: '9px', color: isDark ? '#6b7280' : '#9ca3af' }}>
                                    <span>Asset</span>
                                    <span>Previous ({formatDate(diff.previousDate)})</span>
                                    <span>Current ({formatDate(diff.currentDate)})</span>
                                  </div>
                                  {/* Rows */}
                                  {diff.trendChanges.map((change, idx) => (
                                    <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', fontSize: '10px' }}>
                                      <span style={{ fontWeight: 500, color: isDark ? '#f9fafb' : '#111827' }}>{change.ticker}</span>
                                      <span style={{ color: change.oldTrend === 'BULLISH' ? '#10b981' : change.oldTrend === 'BEARISH' ? '#ef4444' : (isDark ? '#f9fafb' : '#111827') }}>
                                        {change.oldTrend === 'BULLISH' ? 'BULLISH' : change.oldTrend === 'BEARISH' ? 'BEARISH' : 'NEUTRAL'}
                                      </span>
                                      <span style={{ color: change.newTrend === 'BULLISH' ? '#10b981' : change.newTrend === 'BEARISH' ? '#ef4444' : (isDark ? '#f9fafb' : '#111827') }}>
                                        {change.newTrend === 'BULLISH' ? 'BULLISH' : change.newTrend === 'BEARISH' ? 'BEARISH' : 'NEUTRAL'}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <Text style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>
                                  N/A
                                </Text>
                              )}
                            </div>

                            {/* 2. Risk Ranges (Constituents) */}
                            <div>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'block' }}>
                                Risk Ranges <span style={{ fontWeight: 400, fontSize: '10px' }}>({formatDate(diff.currentDate)})</span>
                              </div>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                                <div>
                                  <span style={{ fontSize: '9px', color: isDark ? '#6b7280' : '#9ca3af' }}>Added</span>
                                  {(diff.added?.length > 0) ? (
                                    diff.added.map(t => (
                                      <div key={t} style={{ fontSize: '10px', color: '#10b981' }}>{t}</div>
                                    ))
                                  ) : (
                                    <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>
                                      N/A
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <span style={{ fontSize: '9px', color: isDark ? '#6b7280' : '#9ca3af' }}>Removed</span>
                                  {(diff.removed?.length > 0) ? (
                                    diff.removed.map(t => (
                                      <div key={t} style={{ fontSize: '10px', color: '#ef4444' }}>{t}</div>
                                    ))
                                  ) : (
                                    <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>
                                      N/A
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* 3. OutBucket */}
                            <div>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'block' }}>
                                OutBucket <span style={{ fontWeight: 400, fontSize: '10px' }}>({formatDate(diff.currentDate)})</span>
                              </div>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                                <div>
                                  <span style={{ fontSize: '9px', color: isDark ? '#6b7280' : '#9ca3af' }}>Added</span>
                                  {(diff.outbucketDiff?.added?.length > 0) ? (
                                    (diff.outbucketDiff.added || []).map(t => {
                                      const text = typeof t === 'string' ? t : (t?.ticker || t?.symbol || JSON.stringify(t));
                                      // Parse: "Name (TICKER) - TREND" -> ticker and trend
                                      const tickerMatch = text.match(/\(([^)]+)\)/);
                                      const ticker = tickerMatch ? tickerMatch[1] : text.split(' ')[0];
                                      const trendMatch = text.match(/-\s*(BULLISH|BEARISH|NEUTRAL)\s*$/i);
                                      const trend = trendMatch ? trendMatch[1].toUpperCase() : '';
                                      const trendColor = trend === 'BULLISH' ? '#10b981' : trend === 'BEARISH' ? '#ef4444' : (isDark ? '#9ca3af' : '#6b7280');
                                      return (
                                        <div key={text} style={{ fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>
                                          <span style={{ color: isDark ? '#f9fafb' : '#111827' }}>{ticker} - </span>
                                          <span style={{ color: trendColor }}>{trend || 'N/A'}</span>
                                        </div>
                                      );
                                    })
                                  ) : (
                                    <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>
                                      N/A
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <span style={{ fontSize: '9px', color: isDark ? '#6b7280' : '#9ca3af' }}>Removed</span>
                                  {(diff.outbucketDiff?.removed?.length > 0) ? (
                                    (diff.outbucketDiff.removed || []).map(t => {
                                      const text = typeof t === 'string' ? t : (t?.ticker || t?.symbol || JSON.stringify(t));
                                      // Parse: "Name (TICKER) - TREND" -> ticker and trend
                                      const tickerMatch = text.match(/\(([^)]+)\)/);
                                      const ticker = tickerMatch ? tickerMatch[1] : text.split(' ')[0];
                                      const trendMatch = text.match(/-\s*(BULLISH|BEARISH|NEUTRAL)\s*$/i);
                                      const trend = trendMatch ? trendMatch[1].toUpperCase() : '';
                                      const trendColor = trend === 'BULLISH' ? '#10b981' : trend === 'BEARISH' ? '#ef4444' : (isDark ? '#9ca3af' : '#6b7280');
                                      return (
                                        <div key={text} style={{ fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>
                                          <span style={{ color: isDark ? '#f9fafb' : '#111827' }}>{ticker} - </span>
                                          <span style={{ color: trendColor }}>{trend || 'N/A'}</span>
                                        </div>
                                      );
                                    })
                                  ) : (
                                    <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>
                                      N/A
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* BITCOIN TRACKER: Crypto + Crypto ETFs Trend Changes */}
                        {key === 'bitcoin-trend-tracker' && diff && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            {/* 1. Crypto Trend Changes */}
                            <div style={{ marginBottom: '8px' }}>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Cryptocurrencies</span> <span style={{ fontWeight: 400, fontSize: '10px' }}>({diff.currentDate ? formatDate(diff.currentDate) : ''})</span>
                              </div>
                              {diff.cryptoTrendChanges && diff.cryptoTrendChanges.length > 0 ? (
                                <div style={{ display: 'grid', gap: '4px' }}>
                                  {/* Header */}
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', fontSize: '9px', color: isDark ? '#6b7280' : '#9ca3af' }}>
                                    <span>Asset</span>
                                    <span>Previous ({formatDate(diff.previousDate)})</span>
                                    <span>Current ({formatDate(diff.currentDate)})</span>
                                  </div>
                                  {/* Rows */}
                                  {diff.cryptoTrendChanges.map((change, idx) => (
                                    <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', fontSize: '10px' }}>
                                      <span style={{ fontWeight: 500, color: isDark ? '#f9fafb' : '#111827' }}>{change.ticker}</span>
                                      <span style={{ color: change.oldTrend === 'BULLISH' ? '#10b981' : change.oldTrend === 'BEARISH' ? '#ef4444' : (isDark ? '#f9fafb' : '#111827') }}>
                                        {change.oldTrend}
                                      </span>
                                      <span style={{ color: change.newTrend === 'BULLISH' ? '#10b981' : change.newTrend === 'BEARISH' ? '#ef4444' : (isDark ? '#f9fafb' : '#111827') }}>
                                        {change.newTrend}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>N/A</div>
                              )}
                            </div>

                            {/* 2. Crypto ETFs Trend Changes */}
                            <div>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Crypto ETFs</span> <span style={{ fontWeight: 400, fontSize: '10px' }}>({diff.currentDate ? formatDate(diff.currentDate) : ''})</span>
                              </div>
                              {diff.etfTrendChanges && diff.etfTrendChanges.length > 0 ? (
                                <div style={{ display: 'grid', gap: '4px' }}>
                                  {/* Header */}
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', fontSize: '9px', color: isDark ? '#6b7280' : '#9ca3af' }}>
                                    <span>Asset</span>
                                    <span>Previous ({formatDate(diff.previousDate)})</span>
                                    <span>Current ({formatDate(diff.currentDate)})</span>
                                  </div>
                                  {/* Rows */}
                                  {diff.etfTrendChanges.map((change, idx) => (
                                    <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', fontSize: '10px' }}>
                                      <span style={{ fontWeight: 500, color: isDark ? '#f9fafb' : '#111827' }}>{change.ticker}</span>
                                      <span style={{ color: change.oldTrend === 'BULLISH' ? '#10b981' : change.oldTrend === 'BEARISH' ? '#ef4444' : (isDark ? '#f9fafb' : '#111827') }}>
                                        {change.oldTrend}
                                      </span>
                                      <span style={{ color: change.newTrend === 'BULLISH' ? '#10b981' : change.newTrend === 'BEARISH' ? '#ef4444' : (isDark ? '#f9fafb' : '#111827') }}>
                                        {change.newTrend}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>N/A</div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* PORTFOLIO SOLUTIONS: Added/Removed with Blue Headers */}
                        {key === 'portfolio-solutions' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            {/* Added Section */}
                            <div>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Added</span> <span style={{ fontWeight: 400, fontSize: '10px' }}>({diff?.currentDate ? formatDate(diff.currentDate) : ''})</span>
                              </div>
                              {(diff?.added && diff.added.length > 0) ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                  {diff.added.map(t => {
                                    const match = t.match(/\(([^)]+)\)/);
                                    const ticker = match ? match[1] : t;
                                    return (
                                      <span key={t} style={{ fontSize: '10px', color: '#10b981', backgroundColor: isDark ? 'rgba(16, 185, 129, 0.1)' : 'rgba(16, 185, 129, 0.05)', padding: '2px 4px', borderRadius: '3px' }}>{ticker}</span>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>N/A</div>
                              )}
                            </div>

                            {/* Removed Section */}
                            <div>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Removed</span> <span style={{ fontWeight: 400, fontSize: '10px' }}>({diff?.currentDate ? formatDate(diff.currentDate) : ''})</span>
                              </div>
                              {(diff?.removed && diff.removed.length > 0) ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                  {diff.removed.map(t => {
                                    const match = t.match(/\(([^)]+)\)/);
                                    const ticker = match ? match[1] : t;
                                    return (
                                      <span key={t} style={{ fontSize: '10px', color: '#ef4444', backgroundColor: isDark ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.05)', padding: '2px 4px', borderRadius: '3px' }}>{ticker}</span>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>N/A</div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* SIGNAL STRENGTH: Added/Removed with Blue Headers */}
                        {key === 'signal-strength' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            {/* Added Section */}
                            <div>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Added</span> <span style={{ fontWeight: 400, fontSize: '10px' }}>({diff.currentDate ? formatDate(diff.currentDate) : ''})</span>
                              </div>
                              {(diff.added && diff.added.length > 0) ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                  {diff.added.map(t => (
                                    <span key={t} style={{ fontSize: '10px', color: '#10b981', backgroundColor: isDark ? 'rgba(16, 185, 129, 0.1)' : 'rgba(16, 185, 129, 0.05)', padding: '2px 4px', borderRadius: '3px' }}>{t}</span>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>N/A</div>
                              )}
                            </div>

                            {/* Removed Section */}
                            <div>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Removed</span> <span style={{ fontWeight: 400, fontSize: '10px' }}>({diff.currentDate ? formatDate(diff.currentDate) : ''})</span>
                              </div>
                              {(diff.removed && diff.removed.length > 0) ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                  {diff.removed.map(t => (
                                    <span key={t} style={{ fontSize: '10px', color: '#ef4444', backgroundColor: isDark ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.05)', padding: '2px 4px', borderRadius: '3px' }}>{t}</span>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>N/A</div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* MOMO TRACKER: Added/Removed with Blue Headers */}
                        {key === 'momo-tracker' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            {/* Added Section */}
                            <div>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Added</span> <span style={{ fontWeight: 400, fontSize: '10px' }}>({diff?.currentDate ? formatDate(diff.currentDate) : ''})</span>
                              </div>
                              {(diff?.added && diff.added.length > 0) ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                  {diff.added.map(t => (
                                    <span key={t} style={{ fontSize: '10px', color: '#10b981', backgroundColor: isDark ? 'rgba(16, 185, 129, 0.1)' : 'rgba(16, 185, 129, 0.05)', padding: '2px 4px', borderRadius: '3px' }}>{t}</span>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>N/A</div>
                              )}
                            </div>

                            {/* Removed Section */}
                            <div>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Removed</span> <span style={{ fontWeight: 400, fontSize: '10px' }}>({diff?.currentDate ? formatDate(diff.currentDate) : ''})</span>
                              </div>
                              {(diff?.removed && diff.removed.length > 0) ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                  {diff.removed.map(t => (
                                    <span key={t} style={{ fontSize: '10px', color: '#ef4444', backgroundColor: isDark ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.05)', padding: '2px 4px', borderRadius: '3px' }}>{t}</span>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>N/A</div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* GENERIC FALLBACK: Added/Removed Table for any others */}
                        {key !== 'risk-ranges' && key !== 'bitcoin-trend-tracker' && key !== 'portfolio-solutions' && key !== 'signal-strength' && key !== 'momo-tracker' && hasData && (
                          <div>
                            {/* Section Header - match Risk Ranges style */}
                            <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'block' }}>
                              {label} <span style={{ fontWeight: 400, fontSize: '10px' }}>({formatDate(diff.currentDate)})</span>
                            </div>

                            {/* Added/Removed Grid - match Risk Ranges style */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                              <div>
                                <span style={{ fontSize: '9px', color: isDark ? '#6b7280' : '#9ca3af' }}>Added</span>
                                {(diff.added?.length > 0) ? (
                                  diff.added.map(t => {
                                    // Extract ticker from strings like "Consumer Discretionary (XLY)" -> "XLY"
                                    const match = t.match(/\(([^)]+)\)/);
                                    const ticker = match ? match[1] : t;
                                    return (
                                      <div key={t} style={{ fontSize: '10px', color: '#10b981' }}>{ticker}</div>
                                    );
                                  })
                                ) : (
                                  <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>
                                    N/A
                                  </div>
                                )}
                              </div>
                              <div>
                                <span style={{ fontSize: '9px', color: isDark ? '#6b7280' : '#9ca3af' }}>Removed</span>
                                {(diff.removed?.length > 0) ? (
                                  diff.removed.map(t => {
                                    // Extract ticker from strings like "Consumer Discretionary (XLY)" -> "XLY"
                                    const match = t.match(/\(([^)]+)\)/);
                                    const ticker = match ? match[1] : t;
                                    return (
                                      <div key={t} style={{ fontSize: '10px', color: '#ef4444' }}>{ticker}</div>
                                    );
                                  })
                                ) : (
                                  <div style={{ fontSize: '10px', color: isDark ? '#f9fafb' : '#111827', fontStyle: 'italic' }}>
                                    N/A
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : activeTab === 'preview_old_status' ? (
          /* OLD Status Overview - keeping for reference but removed from tabs */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Hedgeye Scraper Status */}
            <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '12px' }}>
                <div>
                  <Title style={{ fontSize: '16px', marginBottom: '4px', color: isDark ? '#f9fafb' : '#111827' }}>
                    Hedgeye Risk Range Scraper
                  </Title>
                  <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280' }}>
                    Automated daily scraper
                  </Text>
                </div>
                <Badge color={getStatusColor(hedgeyeFreshness.status)}>
                  {hedgeyeStatus.status || hedgeyeFreshness.status}
                </Badge>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '12px' }}>
                <div>
                  <Text style={{ fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '4px' }}>
                    Last Run
                  </Text>
                  <Text style={{ fontSize: '14px', fontWeight: 500, color: isDark ? '#f9fafb' : '#111827' }}>
                    {formatTimestamp(hedgeyeStatus.lastRun)}
                  </Text>
                  {!hedgeyeStatus.lastRun && (
                    <Text style={{ fontSize: '11px', color: isDark ? '#6b7280' : '#9ca3af', fontStyle: 'italic', marginTop: '2px' }}>
                      Not run yet
                    </Text>
                  )}
                </div>
                <div>
                  <Text style={{ fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '4px' }}>
                    Securities Scraped
                  </Text>
                  <Text style={{ fontSize: '14px', fontWeight: 500, color: isDark ? '#f9fafb' : '#111827' }}>
                    {hedgeyeStatus.count || Object.keys(riskRanges).length || 0}
                  </Text>
                </div>
                <div>
                  <Text style={{ fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '4px' }}>
                    Data Freshness
                  </Text>
                  <Badge color={getStatusColor(hedgeyeFreshness.status)} size="sm">
                    {hedgeyeFreshness.label}
                  </Badge>
                </div>
                <div>
                  <Text style={{ fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '4px' }}>
                    Next Run
                  </Text>
                  <Text style={{ fontSize: '14px', fontWeight: 500, color: isDark ? '#f9fafb' : '#111827' }}>
                    {hedgeyeStatus.nextRun || '8:00 AM EST (market days)'}
                  </Text>
                </div>
              </div>

              {(!hedgeyeStatus.lastRun || hedgeyeStatus.status === 'unknown') && (
                <div style={{ marginTop: '12px', padding: '12px', backgroundColor: isDark ? '#1f2937' : '#f3f4f6', borderRadius: '6px', border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}` }}>
                  <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280' }}>
                    <strong>Status:</strong> Scraper is configured and scheduled. It will run automatically at 8:00 AM EST on market days.
                    {!hedgeyeStatus.lastRun && ' No data has been collected yet.'}
                  </Text>
                </div>
              )}
            </Card>

            {/* CSV Upload Status */}
            <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '12px' }}>
                <div>
                  <Title style={{ fontSize: '16px', marginBottom: '4px', color: isDark ? '#f9fafb' : '#111827' }}>
                    CSV Portfolio Upload
                  </Title>
                  <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280' }}>
                    Manual portfolio uploads
                  </Text>
                </div>
                <Badge color={getStatusColor(csvFreshness.status)}>
                  {csvStatus.status || csvFreshness.status}
                </Badge>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '12px' }}>
                <div>
                  <Text style={{ fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '4px' }}>
                    Last Upload
                  </Text>
                  <Text style={{ fontSize: '14px', fontWeight: 500, color: isDark ? '#f9fafb' : '#111827' }}>
                    {formatTimestamp(csvStatus.lastUpload)}
                  </Text>
                </div>
                <div>
                  <Text style={{ fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '4px' }}>
                    Records Processed
                  </Text>
                  <Text style={{ fontSize: '14px', fontWeight: 500, color: isDark ? '#f9fafb' : '#111827' }}>
                    {csvStatus.records || 0}
                  </Text>
                </div>
                <div>
                  <Text style={{ fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '4px' }}>
                    File Name
                  </Text>
                  <Text style={{ fontSize: '14px', fontWeight: 500, color: isDark ? '#f9fafb' : '#111827' }}>
                    {csvStatus.fileName || 'N/A'}
                  </Text>
                </div>
                <div>
                  <Text style={{ fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '4px' }}>
                    Data Freshness
                  </Text>
                  <Badge color={getStatusColor(csvFreshness.status)} size="sm">
                    {csvFreshness.label}
                  </Badge>
                </div>
              </div>
            </Card>
          </div>
        ) : activeTab === 'services' ? (
          /* API Usage */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Summary Metrics */}
            {serviceTotals && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '16px' }}>
                <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
                  <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '4px' }}>Total API Calls/Day</Text>
                  <Metric style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                    {(serviceTotals.internal.callsPerDay + serviceTotals.external.callsPerDay).toLocaleString()}
                  </Metric>
                </Card>
                <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
                  <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '4px' }}>Total API Calls/Month</Text>
                  <Metric style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                    {(serviceTotals.internal.callsPerMonth + serviceTotals.external.callsPerMonth).toLocaleString()}
                  </Metric>
                </Card>
                <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
                  <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '4px' }}>Estimated Monthly Cost</Text>
                  <Metric style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                    ${serviceTotals.grandTotal.toFixed(2)}
                  </Metric>
                </Card>
              </div>
            )}

            {/* Internal APIs */}
            <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
              <Title style={{ fontSize: '16px', marginBottom: '16px', color: isDark ? '#f9fafb' : '#111827' }}>
                Internal API Endpoints
              </Title>
              <div style={{ overflowX: 'auto' }}>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Service</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Update Frequency</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Calls/Day</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Calls/Month</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Data Source</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {Object.entries(SERVICE_CONFIG.internal).map(([key, service]) => (
                      <TableRow key={key}>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827', fontWeight: 500 }}>
                          {service.name}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px' }}>
                          {service.updateFrequency}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                          {service.estimatedCallsPerDay.toLocaleString()}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                          {service.estimatedCallsPerMonth.toLocaleString()}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px' }}>
                          {service.dataSource}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>

            {/* External APIs */}
            <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
              <Title style={{ fontSize: '16px', marginBottom: '16px', color: isDark ? '#f9fafb' : '#111827' }}>
                External API Services
              </Title>
              <div style={{ overflowX: 'auto' }}>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Service</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Status</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Rate Limit</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Calls/Day</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Calls/Month</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Cost/Month</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {Object.entries(SERVICE_CONFIG.external).map(([key, service]) => (
                      <TableRow key={key}>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827', fontWeight: 500 }}>
                          {service.name}
                        </TableCell>
                        <TableCell>
                          <Badge color={service.status === 'active' ? 'emerald' : 'gray'} size="sm">
                            {service.status}
                          </Badge>
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px' }}>
                          {service.rateLimit}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                          {service.estimatedCallsPerDay.toLocaleString()}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                          {service.estimatedCallsPerMonth.toLocaleString()}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                          ${service.costPerMonth.toFixed(2)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>

            {/* Automated Workflows */}
            <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
              <Title style={{ fontSize: '16px', marginBottom: '16px', color: isDark ? '#f9fafb' : '#111827' }}>
                Automated Workflows
              </Title>
              <div style={{ overflowX: 'auto' }}>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Workflow</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Schedule</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Runs/Day</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Runs/Month</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Method</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {Object.entries(SERVICE_CONFIG.workflows).map(([key, workflow]) => (
                      <TableRow key={key}>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827', fontWeight: 500 }}>
                          {workflow.name}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px' }}>
                          {workflow.schedule}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                          {workflow.estimatedRunsPerDay}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                          {workflow.estimatedRunsPerMonth}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px' }}>
                          {workflow.method}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>

            {/* AWS Services */}
            <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
              <Title style={{ fontSize: '16px', marginBottom: '16px', color: isDark ? '#f9fafb' : '#111827' }}>
                AWS Services
              </Title>
              <div style={{ overflowX: 'auto' }}>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Service</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Description</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Usage</TableHeaderCell>
                      <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Cost/Month</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {Object.entries(SERVICE_CONFIG.aws).map(([key, service]) => (
                      <TableRow key={key}>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827', fontWeight: 500 }}>
                          {service.name}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px' }}>
                          {service.description}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px' }}>
                          {service.tables ? `${service.tables.length} tables` :
                            service.estimatedInvocationsPerMonth ? `${service.estimatedInvocationsPerMonth} invocations` :
                              service.estimatedStorageGB ? `${service.estimatedStorageGB} GB` : 'N/A'}
                        </TableCell>
                        <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                          ${service.estimatedCostPerMonth.toFixed(2)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>

            {/* Service Parameters Example */}
            <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
              <Title style={{ fontSize: '16px', marginBottom: '12px', color: isDark ? '#f9fafb' : '#111827' }}>
                Key Service Parameters
              </Title>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ padding: '12px', backgroundColor: isDark ? '#1f2937' : '#f3f4f6', borderRadius: '6px' }}>
                  <Text style={{ fontSize: '13px', fontWeight: 600, color: isDark ? '#f9fafb' : '#111827', marginBottom: '4px' }}>
                    Signal Strength Spot Price Updates
                  </Text>
                  <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280' }}>
                    Updates every <strong>8 seconds</strong> • ~10,800 calls/day • ~324,000 calls/month
                  </Text>
                </div>
                <div style={{ padding: '12px', backgroundColor: isDark ? '#1f2937' : '#f3f4f6', borderRadius: '6px' }}>
                  <Text style={{ fontSize: '13px', fontWeight: 600, color: isDark ? '#f9fafb' : '#111827', marginBottom: '4px' }}>
                    USD Macro Dashboard
                  </Text>
                  <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280' }}>
                    DXY updates every <strong>5 minutes</strong> • Dashboard refreshes every <strong>15 minutes</strong>
                  </Text>
                </div>
                <div style={{ padding: '12px', backgroundColor: isDark ? '#1f2937' : '#f3f4f6', borderRadius: '6px' }}>
                  <Text style={{ fontSize: '13px', fontWeight: 600, color: isDark ? '#f9fafb' : '#111827', marginBottom: '4px' }}>
                    Hedgeye Risk Range Scraper
                  </Text>
                  <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280' }}>
                    Runs daily at <strong>8:00 AM EST (market days)</strong> • ~22 runs/month
                  </Text>
                </div>
              </div>
            </Card>
          </div>
        ) : activeTab === 'preview' ? (
          /* Preview - Vertical Scrolling List of All Data Types */
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: 'calc(100vh - 180px)',
            overflow: 'auto',
            gap: '16px',
            padding: '4px'
          }}>
            {DATA_TYPES.map(({ key, label }) => {
              const pdfData = allPdfData[key] || {};
              // Determine data for this type
              const hasData = key === 'risk-ranges' && riskRangesTableData.length > 0;
              const jsonData = key === 'risk-ranges' ? riskRanges : (freshnessData?.dataTypes?.[key] || {});

              return (
                <div
                  key={key}
                  style={{
                    border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                    borderRadius: '8px',
                    overflow: 'hidden',
                    backgroundColor: isDark ? '#1f2937' : '#ffffff',
                    flexShrink: 0,
                    display: 'flex',
                    flexDirection: 'column'
                  }}
                >
                  {/* Card Header */}
                  <div style={{
                    padding: '8px 12px',
                    borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                    backgroundColor: isDark ? '#111827' : '#f9fafb',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <Text style={{
                      fontSize: '13px',
                      fontWeight: 600,
                      color: isDark ? '#f9fafb' : '#111827'
                    }}>
                      {label}
                    </Text>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      {/* Date Picker */}
                      <input
                        type="date"
                        value={selectedPreviewDate}
                        onChange={(e) => setSelectedPreviewDate(e.target.value)}
                        max={new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })}
                        style={{
                          padding: '3px 8px',
                          fontSize: '11px',
                          fontWeight: 500,
                          borderRadius: '4px',
                          border: `1px solid ${isDark ? '#4b5563' : '#d1d5db'}`,
                          backgroundColor: isDark ? '#1f2937' : 'white',
                          color: isDark ? '#f9fafb' : '#111827',
                          cursor: 'pointer'
                        }}
                      />

                      {/* View Toggle for Data */}
                      <div style={{ display: 'flex', backgroundColor: isDark ? '#374151' : '#e5e7eb', borderRadius: '4px', padding: '2px' }}>
                        <button
                          onClick={() => setPreviewViewMode('table')}
                          style={{
                            padding: '2px 8px',
                            fontSize: '10px',
                            fontWeight: 600,
                            borderRadius: '3px',
                            border: 'none',
                            cursor: 'pointer',
                            backgroundColor: previewViewMode === 'table' ? (isDark ? '#1f2937' : 'white') : 'transparent',
                            color: previewViewMode === 'table' ? (isDark ? '#f9fafb' : '#111827') : (isDark ? '#9ca3af' : '#6b7280'),
                            boxShadow: previewViewMode === 'table' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none'
                          }}
                        >
                          Table
                        </button>
                        <button
                          onClick={() => setPreviewViewMode('json')}
                          style={{
                            padding: '2px 8px',
                            fontSize: '10px',
                            fontWeight: 600,
                            borderRadius: '3px',
                            border: 'none',
                            cursor: 'pointer',
                            backgroundColor: previewViewMode === 'json' ? (isDark ? '#1f2937' : 'white') : 'transparent',
                            color: previewViewMode === 'json' ? (isDark ? '#f9fafb' : '#111827') : (isDark ? '#9ca3af' : '#6b7280'),
                            boxShadow: previewViewMode === 'json' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none'
                          }}
                        >
                          JSON
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Split Content */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    height: '600px',
                    backgroundColor: isDark ? '#111827' : '#f3f4f6'
                  }}>
                    {/* Left Side: PDF/Screenshot */}
                    <div style={{
                      borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                      overflow: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      position: 'relative'
                    }}>
                      {pdfData.loading ? (
                        <div style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: '8px',
                          height: '100%',
                          justifyContent: 'center'
                        }}>
                          <div
                            style={{
                              width: '24px',
                              height: '24px',
                              border: '2px solid',
                              borderColor: isDark ? '#374151' : '#e5e7eb',
                              borderTopColor: isDark ? '#3b82f6' : '#2563eb',
                              borderRadius: '50%',
                              animation: 'spin 0.8s linear infinite'
                            }}
                          />
                          <Text style={{
                            color: isDark ? '#9ca3af' : '#6b7280',
                            fontSize: '11px'
                          }}>
                            Loading {label}...
                          </Text>
                        </div>
                      ) : pdfData.url && pdfData.type === 'pdf' ? (
                        <iframe
                          src={`${pdfData.url}#toolbar=0&navpanes=0&scrollbar=1`}
                          title={label}
                          style={{
                            width: '100%',
                            height: '100%',
                            border: 'none'
                          }}
                        />
                      ) : pdfData.url ? (
                        <img
                          src={pdfData.url}
                          alt={label}
                          style={{
                            width: '100%',
                            height: 'auto',
                            objectFit: 'contain'
                          }}
                        />
                      ) : (
                        <div style={{
                          height: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}>
                          <Text style={{
                            color: isDark ? '#6b7280' : '#9ca3af',
                            fontSize: '12px'
                          }}>
                            {pdfData.error || 'Waiting...'}
                          </Text>
                        </div>
                      )}
                    </div>

                    {/* Right Side: Extracted Data */}
                    <div style={{
                      overflow: 'auto',
                      backgroundColor: isDark ? '#1f2937' : '#ffffff',
                      display: 'flex',
                      flexDirection: 'column'
                    }}>
                      {(() => {
                        const snapshotData = allSnapshotData[key];
                        const data = snapshotData?.data;

                        // JSON view
                        if (previewViewMode === 'json') {
                          return (
                            <div style={{ padding: '12px' }}>
                              <pre style={{
                                fontSize: '10px',
                                fontFamily: 'monospace',
                                margin: 0,
                                whiteSpace: 'pre-wrap',
                                color: isDark ? '#d1d5db' : '#374151'
                              }}>
                                {JSON.stringify(snapshotData || {}, null, 2)}
                              </pre>
                            </div>
                          );
                        }

                        // No data available
                        if (!data) {
                          return (
                            <div style={{
                              flex: 1,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              padding: '20px',
                              color: isDark ? '#9ca3af' : '#6b7280',
                              fontSize: '12px'
                            }}>
                              Loading data...
                            </div>
                          );
                        }


                        // Risk Ranges - Special format with 3 sections
                        if (key === 'risk-ranges') {
                          const items = Object.entries(data)
                            .map(([ticker, info]) => ({
                              ticker,
                              lrr: info.lrr || 0,
                              close: info.prevClose || 0,
                              hrr: info.hrr || 0,
                              trend: info.trend || 'N/A',
                              index: info.index ?? 9999
                            }))
                            .sort((a, b) => a.index - b.index);

                          const trendChanges = snapshotData.trendChanges || [];
                          const outbucket = snapshotData.outbucket || [];

                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '16px 4px' }}>

                              {/* 1. Trend Changes Section */}
                              {trendChanges.length > 0 && (
                                <div>
                                  <Text style={{
                                    fontSize: '12px',
                                    fontWeight: 700,
                                    color: isDark ? '#f3f4f6' : '#111827',
                                    paddingLeft: '8px',
                                    marginBottom: '8px',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.05em'
                                  }}>
                                    Trend Changes ({trendChanges.length})
                                  </Text>
                                  <Table>
                                    <TableHead>
                                      <TableRow>
                                        <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Ticker</TableHeaderCell>
                                        <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Change</TableHeaderCell>
                                      </TableRow>
                                    </TableHead>
                                    <TableBody>
                                      {trendChanges.map((tc, idx) => (
                                        <TableRow key={idx}>
                                          <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600 }}>{tc.ticker}</TableCell>
                                          <TableCell style={{ padding: '4px 8px', fontSize: '11px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                              <span style={{ color: tc.oldTrend === 'BULLISH' ? '#10b981' : tc.oldTrend === 'BEARISH' ? '#ef4444' : '#6b7280' }}>{tc.oldTrend}</span>
                                              <span style={{ color: isDark ? '#9ca3af' : '#6b7280' }}>→</span>
                                              <span style={{ fontWeight: 600, color: tc.newTrend === 'BULLISH' ? '#10b981' : tc.newTrend === 'BEARISH' ? '#ef4444' : '#6b7280' }}>{tc.newTrend}</span>
                                            </div>
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </div>
                              )}

                              {/* 2. Risk Ranges Table (The standard one) */}
                              <div>
                                <Text style={{
                                  fontSize: '12px',
                                  fontWeight: 700,
                                  color: isDark ? '#f3f4f6' : '#111827',
                                  paddingLeft: '8px',
                                  marginBottom: '8px',
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.05em'
                                }}>
                                  Risk Ranges ({items.length})
                                </Text>
                                <Table>
                                  <TableHead>
                                    <TableRow>
                                      <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Ticker</TableHeaderCell>
                                      <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>LRR</TableHeaderCell>
                                      <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Close</TableHeaderCell>
                                      <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>HRR</TableHeaderCell>
                                      <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Trend</TableHeaderCell>
                                    </TableRow>
                                  </TableHead>
                                  <TableBody>
                                    {items.map((row) => (
                                      <TableRow key={row.ticker}>
                                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600 }}>{row.ticker}</TableCell>
                                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace' }}>{Number(row.lrr).toFixed(2)}</TableCell>
                                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace', fontWeight: 600 }}>{Number(row.close).toFixed(2)}</TableCell>
                                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace' }}>{Number(row.hrr).toFixed(2)}</TableCell>
                                        <TableCell style={{ padding: '4px 8px' }}>
                                          <span style={{
                                            fontSize: '10px',
                                            padding: '2px 6px',
                                            borderRadius: '4px',
                                            backgroundColor: row.trend === 'BULLISH' ? (isDark ? 'rgba(16, 185, 129, 0.2)' : '#dcfce7') :
                                              row.trend === 'BEARISH' ? (isDark ? 'rgba(239, 68, 68, 0.2)' : '#fee2e2') : 'rgba(107, 114, 128, 0.2)',
                                            color: row.trend === 'BULLISH' ? '#10b981' :
                                              row.trend === 'BEARISH' ? '#ef4444' : '#6b7280'
                                          }}>
                                            {row.trend}
                                          </span>
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>

                              {/* 3. OutBucket Section */}
                              {outbucket.length > 0 && (
                                <div>
                                  <Text style={{
                                    fontSize: '12px',
                                    fontWeight: 700,
                                    color: isDark ? '#f3f4f6' : '#111827',
                                    paddingLeft: '8px',
                                    marginBottom: '8px',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.05em'
                                  }}>
                                    #OutBucket ({outbucket.length})
                                  </Text>
                                  <Table>
                                    <TableHead>
                                      <TableRow>
                                        <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Ticker</TableHeaderCell>
                                        <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Removed At</TableHeaderCell>
                                        <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Final Trend</TableHeaderCell>
                                      </TableRow>
                                    </TableHead>
                                    <TableBody>
                                      {outbucket.map((item, idx) => (
                                        <TableRow key={idx}>
                                          <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600 }}>{item.ticker}</TableCell>
                                          <TableCell style={{ padding: '4px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>{item.dateRemoved}</TableCell>
                                          <TableCell style={{ padding: '4px 8px' }}>
                                            <span style={{
                                              fontSize: '10px',
                                              color: item.trend === 'BULLISH' ? '#10b981' :
                                                item.trend === 'BEARISH' ? '#ef4444' : '#6b7280'
                                            }}>
                                              {item.trend}
                                            </span>
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </div>
                              )}

                            </div>
                          );
                        }

                        // Early Look - simple format with LRR/HRR
                        if (key === 'early-look') {
                          const items = Object.entries(data)
                            .map(([ticker, info]) => ({
                              ticker,
                              lrr: info.lrr || 0,
                              hrr: info.hrr || 0,
                              trend: info.trend || 'N/A',
                              index: info.index ?? 9999
                            }))
                            .sort((a, b) => a.index - b.index);

                          return (
                            <Table>
                              <TableHead>
                                <TableRow>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Ticker</TableHeaderCell>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>LRR</TableHeaderCell>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>HRR</TableHeaderCell>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Trend</TableHeaderCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {items.map((row) => (
                                  <TableRow key={row.ticker}>
                                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600 }}>{row.ticker}</TableCell>
                                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace' }}>{Number(row.lrr).toFixed(2)}</TableCell>
                                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace' }}>{Number(row.hrr).toFixed(2)}</TableCell>
                                    <TableCell style={{ padding: '4px 8px' }}>
                                      <span style={{
                                        fontSize: '10px',
                                        padding: '2px 6px',
                                        borderRadius: '4px',
                                        backgroundColor: row.trend === 'BULLISH' ? (isDark ? 'rgba(16, 185, 129, 0.2)' : '#dcfce7') :
                                          row.trend === 'BEARISH' ? (isDark ? 'rgba(239, 68, 68, 0.2)' : '#fee2e2') : 'rgba(107, 114, 128, 0.2)',
                                        color: row.trend === 'BULLISH' ? '#10b981' :
                                          row.trend === 'BEARISH' ? '#ef4444' : '#6b7280'
                                      }}>
                                        {row.trend}
                                      </span>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          );
                        }

                        // Momo Tracker - Buy/Sell columns
                        if (key === 'momo-tracker') {
                          const items = Object.entries(data)
                            .map(([ticker, info]) => ({
                              ticker,
                              buyTrade: info.buyTrade || 0,
                              sellTrade: info.sellTrade || 0,
                              upside: info.upside || 0,
                              downside: info.downside || 0,
                              trend: info.trend || 'N/A',
                              index: (typeof info.index === 'number') ? info.index : 9999
                            }))
                            .sort((a, b) => a.index - b.index);

                          return (
                            <Table>
                              <TableHead>
                                <TableRow>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Ticker</TableHeaderCell>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>LRR</TableHeaderCell>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>HRR</TableHeaderCell>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Upside</TableHeaderCell>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Downside</TableHeaderCell>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Trend</TableHeaderCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {items.map((row) => (
                                  <TableRow key={row.ticker}>
                                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600 }}>{row.ticker}</TableCell>
                                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace' }}>{Number(row.buyTrade).toFixed(0)}</TableCell>
                                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace' }}>{Number(row.sellTrade).toFixed(0)}</TableCell>
                                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace', color: '#10b981' }}>{Number(row.upside).toFixed(2)}%</TableCell>
                                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace', color: '#ef4444' }}>{Number(row.downside).toFixed(2)}%</TableCell>
                                    <TableCell style={{ padding: '4px 8px' }}>
                                      <span style={{
                                        fontSize: '10px',
                                        padding: '2px 6px',
                                        borderRadius: '4px',
                                        backgroundColor: row.trend === 'BULLISH' ? (isDark ? 'rgba(16, 185, 129, 0.2)' : '#dcfce7') :
                                          row.trend === 'BEARISH' ? (isDark ? 'rgba(239, 68, 68, 0.2)' : '#fee2e2') : 'rgba(107, 114, 128, 0.2)',
                                        color: row.trend === 'BULLISH' ? '#10b981' :
                                          row.trend === 'BEARISH' ? '#ef4444' : '#6b7280'
                                      }}>
                                        {row.trend}
                                      </span>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          );
                        }
                        // Bitcoin Tracker - has cryptos and stocks
                        if (key === 'bitcoin-trend-tracker') {
                          const cryptos = data.cryptos ? Object.entries(data.cryptos) : [];
                          const stocks = data.stocks ? Object.entries(data.stocks) : [];
                          const allItems = [...cryptos, ...stocks]
                            .map(([ticker, info]) => ({
                              ticker,
                              buyTrade: info.buyTrade || 0,
                              sellTrade: info.sellTrade || 0,
                              trend: info.trend || 'N/A',
                              index: info.index ?? 9999
                            }))
                            .sort((a, b) => a.index - b.index);

                          return (
                            <Table>
                              <TableHead>
                                <TableRow>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Ticker</TableHeaderCell>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>LRR</TableHeaderCell>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>HRR</TableHeaderCell>
                                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Trend</TableHeaderCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {allItems.map((row) => (
                                  <TableRow key={row.ticker}>
                                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600 }}>{row.ticker}</TableCell>
                                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace' }}>{Number(row.buyTrade).toLocaleString()}</TableCell>
                                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace' }}>{Number(row.sellTrade).toLocaleString()}</TableCell>
                                    <TableCell style={{ padding: '4px 8px' }}>
                                      <span style={{
                                        fontSize: '10px',
                                        padding: '2px 6px',
                                        borderRadius: '4px',
                                        backgroundColor: row.trend === 'BULLISH' ? (isDark ? 'rgba(16, 185, 129, 0.2)' : '#dcfce7') :
                                          row.trend === 'BEARISH' ? (isDark ? 'rgba(239, 68, 68, 0.2)' : '#fee2e2') : 'rgba(107, 114, 128, 0.2)',
                                        color: row.trend === 'BULLISH' ? '#10b981' :
                                          row.trend === 'BEARISH' ? '#ef4444' : '#6b7280'
                                      }}>
                                        {row.trend}
                                      </span>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          );
                        }

                        // Signal Strength - has stocks array + added/removed
                        if (key === 'signal-strength') {
                          const stocks = data.stocks || [];
                          const added = data.added || [];
                          const removed = data.removed || [];

                          return (
                            <div style={{ padding: '12px' }}>
                              {added.length > 0 && (
                                <div style={{ marginBottom: '12px' }}>
                                  <Text style={{ fontSize: '11px', fontWeight: 600, color: '#10b981', marginBottom: '4px', display: 'block' }}>
                                    Added ({added.length})
                                  </Text>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                    {added.map(ticker => (
                                      <span key={ticker} style={{ fontSize: '10px', padding: '2px 6px', backgroundColor: isDark ? 'rgba(16, 185, 129, 0.2)' : '#dcfce7', borderRadius: '4px', color: '#10b981' }}>{ticker}</span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {removed.length > 0 && (
                                <div style={{ marginBottom: '12px' }}>
                                  <Text style={{ fontSize: '11px', fontWeight: 600, color: '#ef4444', marginBottom: '4px', display: 'block' }}>
                                    Removed ({removed.length})
                                  </Text>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                    {removed.map(ticker => (
                                      <span key={ticker} style={{ fontSize: '10px', padding: '2px 6px', backgroundColor: isDark ? 'rgba(239, 68, 68, 0.2)' : '#fee2e2', borderRadius: '4px', color: '#ef4444' }}>{ticker}</span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              <Text style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#f9fafb' : '#111827', marginBottom: '4px', display: 'block' }}>
                                Stocks ({stocks.length})
                              </Text>
                              <Table>
                                <TableHead>
                                  <TableRow>
                                    <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Ticker</TableHeaderCell>
                                    <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Strength</TableHeaderCell>
                                  </TableRow>
                                </TableHead>
                                <TableBody>
                                  {stocks.map((stock, idx) => (
                                    <TableRow key={stock.ticker || idx}>
                                      <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600 }}>{stock.ticker || stock}</TableCell>
                                      <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace' }}>{stock.strength || '-'}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          );
                        }

                        // Portfolio Solutions - has rankings
                        if (key === 'portfolio-solutions') {
                          const rankings = data.rankings || [];
                          const topMovers = data.topMovers || { weekly: [], monthly: [] };
                          const bottomMovers = data.bottomMovers || { weekly: [], monthly: [] };

                          // Try to get date from data or fallback to freshness
                          const dataDate = data.date || data.timestamp || freshnessData?.dataTypes?.['portfolio-solutions']?.date;
                          const formattedDate = dataDate ? formatDate(dataDate) : '';

                          const renderMoverSection = (title, top, bottom) => (
                            <div style={{ marginBottom: '16px' }}>
                              <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '4px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>{title}</span> <span style={{ fontWeight: 400, fontSize: '10px' }}>({formattedDate})</span>
                              </div>

                              {/* Top Movers */}
                              <div style={{ marginBottom: '6px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: '10px', fontWeight: 600, color: '#10b981' }}>Top Movers:</span>
                                  {top && top.length > 0 ? top.map((mover, i) => (
                                    <span key={i} style={{ fontSize: '10px', color: isDark ? '#d1d5db' : '#374151' }}>
                                      <span style={{ fontWeight: 600 }}>{mover.ticker}</span>
                                      <span style={{ color: '#10b981', marginLeft: '1px' }}>(+{mover.change})</span>
                                      {i < top.length - 1 && ','}
                                    </span>
                                  )) : <span style={{ fontSize: '10px', fontStyle: 'italic', color: '#9ca3af' }}>None</span>}
                                </div>
                              </div>

                              {/* Bottom Movers */}
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: '10px', fontWeight: 600, color: '#ef4444' }}>Bottom Movers:</span>
                                  {bottom && bottom.length > 0 ? bottom.map((mover, i) => (
                                    <span key={i} style={{ fontSize: '10px', color: isDark ? '#d1d5db' : '#374151' }}>
                                      <span style={{ fontWeight: 600 }}>{mover.ticker}</span>
                                      <span style={{ color: '#ef4444', marginLeft: '1px' }}>({mover.change})</span>
                                      {i < bottom.length - 1 && ','}
                                    </span>
                                  )) : <span style={{ fontSize: '10px', fontStyle: 'italic', color: '#9ca3af' }}>None</span>}
                                </div>
                              </div>
                            </div>
                          );

                          return (
                            <div style={{ padding: '12px' }}>
                              {/* 1-WEEK RE-RANK HISTORY */}
                              {renderMoverSection('1-Week Re-Rank History', topMovers.weekly, bottomMovers.weekly)}

                              {/* 1-MONTH RE-RANK HISTORY */}
                              {renderMoverSection('1-Month Re-Rank History', topMovers.monthly, bottomMovers.monthly)}

                              <div style={{ marginTop: '12px', borderTop: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, paddingTop: '12px' }}>
                                <div style={{ fontSize: '11px', fontWeight: 600, color: isDark ? '#93c5fd' : '#1d4ed8', marginBottom: '8px', padding: '4px 6px', backgroundColor: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span>RANKED LIST ({rankings.length})</span> <span style={{ fontWeight: 400, fontSize: '10px' }}>({formattedDate})</span>
                                </div>
                                <Table>
                                  <TableHead>
                                    <TableRow>
                                      <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Rank</TableHeaderCell>
                                      <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Ticker</TableHeaderCell>
                                      <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>1 Week Ago</TableHeaderCell>
                                      <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>1 Month Ago</TableHeaderCell>
                                      <TableHeaderCell style={{ padding: '6px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>Asset Class</TableHeaderCell>
                                    </TableRow>
                                  </TableHead>
                                  <TableBody>
                                    {rankings.map((item, idx) => (
                                      <TableRow key={item.ticker || idx}>
                                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600 }}>{item.rank || idx + 1}</TableCell>
                                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 600 }}>{item.ticker}</TableCell>
                                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace' }}>{item.weekAgo || '-'}</TableCell>
                                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace' }}>{item.monthAgo || '-'}</TableCell>
                                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280' }}>{item.assetClass || '-'}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
                          );
                        }

                        // Fallback
                        return (
                          <div style={{
                            flex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '20px',
                            color: isDark ? '#9ca3af' : '#6b7280',
                            fontSize: '12px'
                          }}>
                            No table view defined for {label}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div >
        ) : null}

      </div >
    </div >
  );
};

export default WorkflowStatus;

