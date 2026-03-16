// Service Tracking Configuration
// Defines all services, APIs, and their usage parameters

export const SERVICE_CONFIG = {
  // Internal API Endpoints
  internal: {
    quotes: {
      name: 'Signal Strength Quotes API',
      endpoint: '/api/quotes',
      description: 'Securities list spot quotes',
      updateFrequency: '30 seconds',
      updateFrequencyMs: 30000,
      estimatedCallsPerDay: 1440, // 30 seconds = 2 calls/min = 120 calls/hour = 1,440 calls/day (12 hours)
      estimatedCallsPerMonth: 43200, // 1,440 * 30
      costPerCall: 0,
      dataSource: 'Yahoo Finance / FRED',
      status: 'active'
    },
    multiRegionQuotes: {
      name: 'Multi-Region Overview API',
      endpoint: '/api/multi-region-quotes',
      description: 'Global markets + currencies overview panel',
      updateFrequency: '30 seconds (sparklines off by default)',
      updateFrequencyMs: 30000,
      estimatedCallsPerDay: 1440, // 30 seconds = 120 calls/hour = 1,440 calls/day (12 hours)
      estimatedCallsPerMonth: 43200, // 1,440 * 30
      costPerCall: 0,
      dataSource: 'Yahoo Finance / FRED',
      status: 'active'
    },
    macroIndicators: {
      name: 'Macro Indicators API',
      endpoint: '/api/macro-indicators',
      description: 'Top-row macro metrics (DXY, rates, commodities, indices)',
      updateFrequency: '30 seconds',
      updateFrequencyMs: 30000,
      estimatedCallsPerDay: 1440,
      estimatedCallsPerMonth: 43200,
      costPerCall: 0,
      dataSource: 'Yahoo Finance / FRED',
      status: 'active'
    },
    volatilitySnapshot: {
      name: 'Volatility Snapshot API',
      endpoint: '/api/volatility-snapshot',
      description: 'VIX/VVIX/RVX/VXN/GVZ/OVX/MOVE table snapshot',
      updateFrequency: '1 minute',
      updateFrequencyMs: 60 * 1000,
      estimatedCallsPerDay: 1440,
      estimatedCallsPerMonth: 43200,
      costPerCall: 0,
      dataSource: 'Yahoo Finance',
      status: 'active'
    },
    riskRanges: {
      name: 'Risk Ranges API',
      endpoint: '/api/risk-ranges',
      description: 'Hedgeye risk range data (LRR/HRR)',
      updateFrequency: 'Daily (8:00 AM EST)',
      updateFrequencyMs: 24 * 60 * 60 * 1000,
      estimatedCallsPerDay: 1,
      estimatedCallsPerMonth: 22, // Weekdays only
      costPerCall: 0,
      dataSource: 'Hedgeye Scraper → DynamoDB',
      status: 'active'
    },
    portfolio: {
      name: 'Portfolio API',
      endpoint: '/api/portfolio',
      description: 'Portfolio snapshots and holdings',
      updateFrequency: 'On-demand / After CSV upload',
      updateFrequencyMs: null,
      estimatedCallsPerDay: 5,
      estimatedCallsPerMonth: 150,
      costPerCall: 0,
      dataSource: 'DynamoDB (PortfolioSnapshots)',
      status: 'active'
    },
    performance: {
      name: 'Performance Tracking API',
      endpoint: '/api/performance/*',
      description: 'Performance metrics and history',
      updateFrequency: 'On-demand',
      updateFrequencyMs: null,
      estimatedCallsPerDay: 10,
      estimatedCallsPerMonth: 300,
      costPerCall: 0,
      dataSource: 'DynamoDB (PerformanceHistory)',
      status: 'active'
    },
    usdMacro: {
      name: 'USD Macro Dashboard API',
      endpoint: '/api/usd/*',
      description: 'DXY, currency pairs, correlations',
      updateFrequency: '15 minutes (dashboard refresh)',
      updateFrequencyMs: 15 * 60 * 1000,
      estimatedCallsPerDay: 96, // 15 min = 4 calls/hour * 24 hours
      estimatedCallsPerMonth: 2880,
      costPerCall: 0,
      dataSource: 'Yahoo Finance / FRED → DynamoDB',
      status: 'active'
    },
    hedgeyeSnapshot: {
      name: 'Hedgeye Snapshot API',
      endpoint: '/api/hedgeye/snapshot/:type',
      description: 'Latest Macro Show / The Call snapshot payloads',
      updateFrequency: 'On load / On-demand',
      updateFrequencyMs: null,
      estimatedCallsPerDay: 20,
      estimatedCallsPerMonth: 600,
      costPerCall: 0,
      dataSource: 'DynamoDB (HedgeyeDailySnapshot)',
      status: 'active'
    },
    workflowStatus: {
      name: 'Workflow Status API',
      endpoint: '/api/workflow-status',
      description: 'Automated workflow health monitoring',
      updateFrequency: '5 minutes',
      updateFrequencyMs: 5 * 60 * 1000,
      estimatedCallsPerDay: 288,
      estimatedCallsPerMonth: 8640,
      costPerCall: 0,
      dataSource: 'DynamoDB queries',
      status: 'active'
    }
  },

  // External API Services
  external: {
    yahooFinance: {
      name: 'Yahoo Finance',
      provider: 'Yahoo',
      description: 'Free market data (quotes, historical prices)',
      updateFrequency: 'Polled (8s/30s/60s/15m depending on panel)',
      rateLimit: 'No official limit (be respectful)',
      estimatedCallsPerDay: 24156, // Aggregate estimate across active quote-heavy panels
      estimatedCallsPerMonth: 724680,
      costPerCall: 0,
      costPerMonth: 0,
      status: 'active',
      notes: 'Free, no API key required; keep cadence conservative to avoid throttling'
    },
    fred: {
      name: 'FRED (Federal Reserve)',
      provider: 'Federal Reserve Economic Data',
      description: 'Treasury yields (UST30Y, UST10Y, UST2Y)',
      updateFrequency: 'Daily (after market close)',
      rateLimit: '120 calls/minute',
      estimatedCallsPerDay: 3, // 3 treasury yields
      estimatedCallsPerMonth: 90,
      costPerCall: 0,
      costPerMonth: 0,
      status: 'active',
      notes: 'Free, API key recommended for higher limits'
    },
    alphaVantage: {
      name: 'Alpha Vantage',
      provider: 'Alpha Vantage',
      description: 'Market data provider (configured but not actively used)',
      updateFrequency: 'N/A',
      rateLimit: '5 calls/minute (free tier)',
      estimatedCallsPerDay: 0,
      estimatedCallsPerMonth: 0,
      costPerCall: 0,
      costPerMonth: 0,
      status: 'configured',
      notes: 'API key configured, not currently in use'
    },
    finnhub: {
      name: 'Finnhub',
      provider: 'Finnhub',
      description: 'Market data provider (configured but not actively used)',
      updateFrequency: 'N/A',
      rateLimit: '60 calls/minute (free tier)',
      estimatedCallsPerDay: 0,
      estimatedCallsPerMonth: 0,
      costPerCall: 0,
      costPerMonth: 0,
      status: 'configured',
      notes: 'API key configured, not currently in use'
    },
    polygon: {
      name: 'Polygon.io',
      provider: 'Polygon.io',
      description: 'Market data provider (configured but not actively used)',
      updateFrequency: 'N/A',
      rateLimit: '5 calls/minute (free tier)',
      estimatedCallsPerDay: 0,
      estimatedCallsPerMonth: 0,
      costPerCall: 0,
      costPerMonth: 0,
      status: 'configured',
      notes: 'API key configured, not currently in use'
    }
  },

  // Automated Workflows
  workflows: {
    hedgeyeScraper: {
      name: 'Hedgeye Risk Range Scraper',
      type: 'scraper',
      description: 'Automated daily scraper for Hedgeye risk ranges',
      schedule: 'Daily at 8:00 AM EST (market days)',
      updateFrequency: 'Once per day',
      estimatedRunsPerDay: 1,
      estimatedRunsPerMonth: 22, // Weekdays only
      costPerRun: 0,
      costPerMonth: 0,
      dataSource: 'Hedgeye website → DynamoDB',
      status: 'active',
      method: 'Python + Playwright + Chrome Profile'
    },
    csvProcessor: {
      name: 'CSV Portfolio Processor',
      type: 'lambda',
      description: 'Processes Schwab CSV uploads to DynamoDB',
      schedule: 'On-demand (S3 trigger)',
      updateFrequency: 'When CSV uploaded',
      estimatedRunsPerDay: 0.5, // Average
      estimatedRunsPerMonth: 15,
      costPerRun: 0.0002, // AWS Lambda pricing (approximate)
      costPerMonth: 0.003,
      dataSource: 'S3 → Lambda → DynamoDB',
      status: 'active',
      method: 'AWS Lambda'
    },
    marketDataCollector: {
      name: 'Market Data Collector',
      type: 'lambda',
      description: 'Daily market data collection (if scheduled)',
      schedule: 'Daily (if configured)',
      updateFrequency: 'Once per day',
      estimatedRunsPerDay: 1,
      estimatedRunsPerMonth: 30,
      costPerRun: 0.0002,
      costPerMonth: 0.006,
      dataSource: 'External APIs → DynamoDB',
      status: 'configured',
      method: 'AWS Lambda'
    }
  },

  // AWS Services
  aws: {
    dynamodb: {
      name: 'DynamoDB',
      provider: 'AWS',
      description: 'NoSQL database for portfolio and market data',
      tables: [
        'PortfolioSnapshots',
        'Holdings',
        'ProcessingLogs',
        'HedgeyeRiskRanges',
        'HedgeyeDailySnapshot',
        'MarketPriceHistory',
        'USDCorrelations'
      ],
      estimatedReadsPerDay: 50000,
      estimatedWritesPerDay: 1000,
      estimatedReadsPerMonth: 1500000,
      estimatedWritesPerMonth: 30000,
      costPerRead: 0.00000025, // $0.25 per million reads
      costPerWrite: 0.00000125, // $1.25 per million writes
      estimatedCostPerMonth: 0.04, // ~$0.04/month
      status: 'active'
    },
    s3: {
      name: 'S3',
      provider: 'AWS',
      description: 'CSV file storage',
      estimatedRequestsPerDay: 5,
      estimatedRequestsPerMonth: 150,
      estimatedStorageGB: 0.1,
      costPerRequest: 0.000005,
      costPerGB: 0.023,
      estimatedCostPerMonth: 0.01,
      status: 'active'
    },
    lambda: {
      name: 'Lambda',
      provider: 'AWS',
      description: 'Serverless functions (CSV processor, market data)',
      estimatedInvocationsPerDay: 2,
      estimatedInvocationsPerMonth: 60,
      costPerInvocation: 0.0000002,
      estimatedCostPerMonth: 0.000012,
      status: 'active'
    }
  }
};

// Calculate totals
export const calculateTotals = () => {
  const totals = {
    internal: {
      callsPerDay: 0,
      callsPerMonth: 0,
      costPerMonth: 0
    },
    external: {
      callsPerDay: 0,
      callsPerMonth: 0,
      costPerMonth: 0
    },
    workflows: {
      runsPerDay: 0,
      runsPerMonth: 0,
      costPerMonth: 0
    },
    aws: {
      costPerMonth: 0
    }
  };

  // Sum internal APIs
  Object.values(SERVICE_CONFIG.internal).forEach(service => {
    totals.internal.callsPerDay += service.estimatedCallsPerDay || 0;
    totals.internal.callsPerMonth += service.estimatedCallsPerMonth || 0;
    totals.internal.costPerMonth += (service.costPerCall || 0) * (service.estimatedCallsPerMonth || 0);
  });

  // Sum external APIs
  Object.values(SERVICE_CONFIG.external).forEach(service => {
    totals.external.callsPerDay += service.estimatedCallsPerDay || 0;
    totals.external.callsPerMonth += service.estimatedCallsPerMonth || 0;
    totals.external.costPerMonth += service.costPerMonth || 0;
  });

  // Sum workflows
  Object.values(SERVICE_CONFIG.workflows).forEach(workflow => {
    totals.workflows.runsPerDay += workflow.estimatedRunsPerDay || 0;
    totals.workflows.runsPerMonth += workflow.estimatedRunsPerMonth || 0;
    totals.workflows.costPerMonth += workflow.costPerMonth || 0;
  });

  // Sum AWS costs
  Object.values(SERVICE_CONFIG.aws).forEach(service => {
    totals.aws.costPerMonth += service.estimatedCostPerMonth || 0;
  });

  // Grand total
  totals.grandTotal = 
    totals.internal.costPerMonth +
    totals.external.costPerMonth +
    totals.workflows.costPerMonth +
    totals.aws.costPerMonth;

  return totals;
};

