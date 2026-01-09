import React, { useState, useEffect } from 'react';
import { Card, Title, Text, Badge, Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell, Button, Metric } from '@tremor/react';
import { MarketDataService } from '../../services/api/marketDataService';
import { ENDPOINTS } from '../../constants/apiEndpoints';
import { useTheme } from '../../context/ThemeContext';
import { SERVICE_CONFIG, calculateTotals } from '../../constants/serviceTracking';
import axios from 'axios';

const WorkflowStatus = () => {
  const { theme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [workflowStatus, setWorkflowStatus] = useState(null);
  const [riskRanges, setRiskRanges] = useState({});
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [activeTab, setActiveTab] = useState('status'); // 'status', 'data', 'apis', 'services', 'preview'
  const [serviceTotals, setServiceTotals] = useState(null);
  const [screenshotUrl, setScreenshotUrl] = useState(null);
  const [csvUrl, setCsvUrl] = useState(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);

  const isDark = theme === 'dark';

  // Get hedgeyeStatus and csvStatus from workflowStatus (with safe defaults)
  const hedgeyeStatus = workflowStatus?.hedgeye || {};
  const csvStatus = workflowStatus?.csvUpload || {};

  // Fetch workflow status and data
  const fetchData = async () => {
    try {
      setLoading(true);
      
      // Fetch workflow status
      const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
      const statusResponse = await axios.get(`${backendUrl}${ENDPOINTS.WORKFLOW_STATUS || '/api/workflow-status'}`);
      setWorkflowStatus(statusResponse.data);

      // Fetch today's risk ranges
      const riskRangesData = await MarketDataService.getRiskRanges();
      setRiskRanges(riskRangesData || {});

      setLastRefresh(new Date());
    } catch (error) {
      console.error('Error fetching workflow status:', error);
      // Set default status if endpoint doesn't exist yet or server is down
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
      
      // Also try to fetch risk ranges directly even if workflow-status fails
      try {
        const riskRangesData = await MarketDataService.getRiskRanges();
        setRiskRanges(riskRangesData || {});
      } catch (riskError) {
        console.error('Error fetching risk ranges:', riskError);
      }
    } finally {
      setLoading(false);
    }
  };

  // Fetch screenshot URL when preview tab is active
  useEffect(() => {
    const currentHedgeyeStatus = workflowStatus?.hedgeye || {};
    if (activeTab === 'preview' && currentHedgeyeStatus.lastRun) {
      fetchScreenshotUrl();
      fetchCsvUrl();
    } else {
      // Clear URLs when leaving preview tab
      setScreenshotUrl(null);
      setCsvUrl(null);
    }
  }, [activeTab, workflowStatus?.hedgeye?.lastRun]);

  useEffect(() => {
    fetchData();
    
    // Calculate service totals
    const totals = calculateTotals();
    setServiceTotals(totals);
    
    // Auto-refresh every 5 minutes
    const interval = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch screenshot presigned URL
  const fetchScreenshotUrl = async () => {
    const currentHedgeyeStatus = workflowStatus?.hedgeye || {};
    if (!currentHedgeyeStatus.lastRun) return;
    
    try {
      setScreenshotLoading(true);
      const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
      const date = new Date(currentHedgeyeStatus.lastRun).toISOString().split('T')[0];
      const response = await axios.get(`${backendUrl}/api/hedgeye/screenshot/${date}`);
      setScreenshotUrl(response.data.url);
    } catch (error) {
      console.error('Error fetching screenshot URL:', error);
      setScreenshotUrl(null);
    } finally {
      setScreenshotLoading(false);
    }
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
  const getDataFreshness = (timestamp) => {
    if (!timestamp) return { status: 'error', hours: null, label: 'No data' };
    
    const now = new Date();
    const dataTime = new Date(timestamp);
    const hoursAgo = (now - dataTime) / (1000 * 60 * 60);
    
    if (hoursAgo < 24) {
      return { status: 'success', hours: hoursAgo, label: `${Math.round(hoursAgo)}h ago` };
    } else if (hoursAgo < 48) {
      return { status: 'warning', hours: hoursAgo, label: `${Math.round(hoursAgo)}h ago` };
    } else {
      return { status: 'error', hours: hoursAgo, label: `${Math.round(hoursAgo)}h ago` };
    }
  };

  // Format timestamp
  const formatTimestamp = (timestamp) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
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

  const hedgeyeFreshness = getDataFreshness(hedgeyeStatus.lastRun);
  const csvFreshness = getDataFreshness(csvStatus.lastUpload);

  // Convert risk ranges to table data
  const riskRangesTableData = Object.entries(riskRanges).map(([ticker, data]) => ({
    ticker,
    lrr: data.lrr || 0,
    hrr: data.hrr || 0,
    timestamp: data.timestamp || null
  })).sort((a, b) => a.ticker.localeCompare(b.ticker));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: isDark 
            ? 'linear-gradient(to bottom, rgba(31, 41, 55, 0.8), rgba(55, 65, 81, 0.5))' 
            : 'linear-gradient(to bottom, rgba(249, 250, 251, 0.8), rgba(243, 244, 246, 0.5))',
          backdropFilter: 'blur(4px)',
        }}
        className="dark:border-gray-700"
      >
        <Title style={{ fontSize: '16px', fontWeight: 600, color: isDark ? '#f9fafb' : '#111827' }}>
          Service Tracking & Status
        </Title>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <Text style={{ fontSize: '12px', color: isDark ? '#9ca3af' : '#6b7280' }}>
            Updated: {lastRefresh.toLocaleTimeString()}
          </Text>
          <Button
            size="xs"
            variant="secondary"
            onClick={fetchData}
            disabled={loading}
          >
            {loading ? '...' : '↻'}
          </Button>
        </div>
      </div>

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
        {['status', 'data', 'apis', 'services', 'preview'].map((tab) => {
          const tabLabels = {
            status: 'Status',
            data: 'Data',
            apis: 'API Usage',
            services: 'Services',
            preview: 'Preview'
          };
          
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                flex: '0 0 auto',
                padding: '12px 16px',
                border: 'none',
                borderBottom: activeTab === tab ? `2px solid ${isDark ? '#3b82f6' : '#2563eb'}` : '2px solid transparent',
                backgroundColor: 'transparent',
                color: activeTab === tab
                  ? (isDark ? '#60a5fa' : '#2563eb')
                  : (isDark ? '#9ca3af' : '#6b7280'),
                cursor: 'pointer',
                fontWeight: activeTab === tab ? 600 : 400,
                fontSize: '13px',
                whiteSpace: 'nowrap',
                borderBottomLeftRadius: activeTab === tab ? '6px' : '0',
                borderBottomRightRadius: activeTab === tab ? '6px' : '0'
              }}
            >
              {tabLabels[tab]}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        {loading && !workflowStatus ? (
          <div style={{ textAlign: 'center', padding: '40px', color: isDark ? '#9ca3af' : '#6b7280' }}>
            Loading workflow status...
          </div>
        ) : activeTab === 'status' ? (
          /* Status Overview */
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
        ) : activeTab === 'data' ? (
          /* Data Snapshot */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Risk Ranges Table */}
            <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
              <Title style={{ fontSize: '16px', marginBottom: '16px', color: isDark ? '#f9fafb' : '#111827' }}>
                Risk Ranges ({riskRangesTableData.length} securities)
              </Title>
              
              {riskRangesTableData.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center' }}>
                  <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '8px', display: 'block', fontSize: '14px' }}>
                    No risk range data available for today
                  </Text>
                  <div style={{ 
                    marginTop: '12px', 
                    padding: '12px', 
                    backgroundColor: isDark ? '#1f2937' : '#f3f4f6', 
                    borderRadius: '6px',
                    border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`
                  }}>
                    <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px', display: 'block', marginBottom: '4px' }}>
                      <strong>Expected Behavior:</strong>
                    </Text>
                    <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px', display: 'block' }}>
                      {hedgeyeStatus.status === 'unknown' || !hedgeyeStatus.lastRun 
                        ? '• Scraper is configured and scheduled to run daily at 8:00 AM EST (market days)'
                        : `• Last successful scrape: ${formatTimestamp(hedgeyeStatus.lastRun)}`
                      }
                    </Text>
                    <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px', display: 'block', marginTop: '4px' }}>
                      • Data will appear here after the scraper runs successfully
                    </Text>
                    <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px', display: 'block', marginTop: '4px' }}>
                      • Check the Status Overview tab for scraper health
                    </Text>
                  </div>
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Ticker</TableHeaderCell>
                        <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>LRR</TableHeaderCell>
                        <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>HRR</TableHeaderCell>
                        <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Updated</TableHeaderCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {riskRangesTableData.map((row) => (
                        <TableRow key={row.ticker}>
                          <TableCell style={{ color: isDark ? '#f9fafb' : '#111827', fontWeight: 500 }}>
                            {row.ticker}
                          </TableCell>
                          <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                            {row.lrr.toFixed(2)}
                          </TableCell>
                          <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                            {row.hrr.toFixed(2)}
                          </TableCell>
                          <TableCell style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px' }}>
                            {row.timestamp ? formatTimestamp(row.timestamp) : 'N/A'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>
          </div>
        ) : activeTab === 'apis' ? (
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
          </div>
        ) : activeTab === 'services' ? (
          /* Services Configuration */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
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
          /* Preview - Side-by-side Screenshot and Data */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{ border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, borderRadius: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <Title style={{ fontSize: '16px', color: isDark ? '#f9fafb' : '#111827' }}>
                  Screenshot vs Extracted Data
                </Title>
                {csvUrl && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => window.open(csvUrl, '_blank')}
                  >
                    Download CSV
                  </Button>
                )}
              </div>
              
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr', 
                gap: '16px',
                minHeight: '500px'
              }}>
                {/* Left Side - Screenshot */}
                <div style={{ 
                  display: 'flex', 
                  flexDirection: 'column',
                  border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                  borderRadius: '8px',
                  overflow: 'hidden',
                  backgroundColor: isDark ? '#1f2937' : '#ffffff'
                }}>
                  <div style={{ 
                    padding: '12px', 
                    borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                    backgroundColor: isDark ? '#111827' : '#f9fafb'
                  }}>
                    <Text style={{ fontSize: '13px', fontWeight: 600, color: isDark ? '#f9fafb' : '#111827' }}>
                      Screenshot
                    </Text>
                    {hedgeyeStatus.lastRun && (
                      <Text style={{ fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280', marginTop: '4px' }}>
                        Captured: {formatTimestamp(hedgeyeStatus.lastRun)}
                      </Text>
                    )}
                  </div>
                  <div style={{ 
                    flex: 1, 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    padding: '16px',
                    overflow: 'auto',
                    backgroundColor: isDark ? '#111827' : '#ffffff'
                  }}>
                    {screenshotLoading ? (
                      <Text style={{ color: isDark ? '#9ca3af' : '#6b7280' }}>Loading screenshot...</Text>
                    ) : screenshotUrl ? (
                      <img 
                        src={screenshotUrl} 
                        alt="Hedgeye Risk Range Screenshot" 
                        style={{ 
                          maxWidth: '100%', 
                          maxHeight: '100%', 
                          objectFit: 'contain',
                          borderRadius: '4px',
                          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
                        }}
                        onError={() => {
                          console.error('Failed to load screenshot');
                          setScreenshotUrl(null);
                        }}
                      />
                    ) : (
                      <div style={{ textAlign: 'center', padding: '40px' }}>
                        <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '8px', display: 'block' }}>
                          No screenshot available
                        </Text>
                        <Text style={{ color: isDark ? '#6b7280' : '#9ca3af', fontSize: '12px', display: 'block' }}>
                          Screenshot will appear here after the scraper runs
                        </Text>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right Side - Extracted Data */}
                <div style={{ 
                  display: 'flex', 
                  flexDirection: 'column',
                  border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                  borderRadius: '8px',
                  overflow: 'hidden',
                  backgroundColor: isDark ? '#1f2937' : '#ffffff'
                }}>
                  <div style={{ 
                    padding: '12px', 
                    borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                    backgroundColor: isDark ? '#111827' : '#f9fafb'
                  }}>
                    <Text style={{ fontSize: '13px', fontWeight: 600, color: isDark ? '#f9fafb' : '#111827' }}>
                      Extracted Data
                    </Text>
                    {hedgeyeStatus.lastRun && (
                      <Text style={{ fontSize: '11px', color: isDark ? '#9ca3af' : '#6b7280', marginTop: '4px' }}>
                        Extracted: {formatTimestamp(hedgeyeStatus.lastRun)}
                      </Text>
                    )}
                  </div>
                  <div style={{ 
                    flex: 1, 
                    overflow: 'auto',
                    padding: '16px'
                  }}>
                    {riskRangesTableData.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '40px' }}>
                        <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', marginBottom: '8px', display: 'block' }}>
                          No data extracted yet
                        </Text>
                        <Text style={{ color: isDark ? '#6b7280' : '#9ca3af', fontSize: '12px', display: 'block' }}>
                          Data will appear here after the scraper runs successfully
                        </Text>
                      </div>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <Table>
                          <TableHead>
                            <TableRow>
                              <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Ticker</TableHeaderCell>
                              <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>LRR</TableHeaderCell>
                              <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>HRR</TableHeaderCell>
                              <TableHeaderCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>Updated</TableHeaderCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {riskRangesTableData.map((row) => (
                              <TableRow key={row.ticker}>
                                <TableCell style={{ color: isDark ? '#f9fafb' : '#111827', fontWeight: 500 }}>
                                  {row.ticker}
                                </TableCell>
                                <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                                  {row.lrr.toFixed(2)}
                                </TableCell>
                                <TableCell style={{ color: isDark ? '#f9fafb' : '#111827' }}>
                                  {row.hrr.toFixed(2)}
                                </TableCell>
                                <TableCell style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '12px' }}>
                                  {row.timestamp ? formatTimestamp(row.timestamp) : 'N/A'}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default WorkflowStatus;

