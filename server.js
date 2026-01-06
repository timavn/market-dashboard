require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');
const AWS = require('aws-sdk');
const axios = require('axios');

const app = express();
// In development, use port 3001 so React dev server can use 3000
// In production, use port 3000 (or PORT env var)
const PORT = process.env.PORT || (process.env.NODE_ENV === 'production' ? 3000 : 3001);

// Configure AWS
AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  // Falls back to ~/.aws/credentials if env vars not set
});

const s3 = new AWS.S3();
const dynamodb = new AWS.DynamoDB.DocumentClient();

// Validate AWS credentials at startup
async function validateAWSCredentials() {
  try {
    // Test credentials by listing buckets (minimal permission check)
    const result = await s3.listBuckets().promise();
    console.log('✅ AWS credentials validated successfully');
    console.log(`📦 Found ${result.Buckets.length} S3 buckets`);
    
    // Check if our target bucket exists
    const targetBucket = 'market-dashboard-csv-data';
    const bucketExists = result.Buckets.some(bucket => bucket.Name === targetBucket);
    if (bucketExists) {
      console.log(`✅ Target bucket '${targetBucket}' found`);
    } else {
      console.log(`⚠️  Target bucket '${targetBucket}' not found in account`);
    }
    
    return true;
  } catch (error) {
    console.error('❌ AWS credentials validation failed:', error.message);
    console.error('💡 Make sure AWS credentials are configured in ~/.aws/credentials or environment variables');
    return false;
  }
}

// Middleware
// CORS: Allow React dev server (port 3000) in development, or same origin in production
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? false // Same origin in production (Express serves static files)
    : ['http://localhost:3000', 'http://127.0.0.1:3000'], // React dev server in development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Import ticker mapping configuration
// Note: Since server.js is CommonJS and securitiesConfig.js is ES6, we'll create a helper function
// that replicates the logic. In the future, consider converting to ES6 modules or creating a shared config.

// In-memory cache for quotes (5-10 second TTL)
const quotesCache = new Map();
const CACHE_TTL = parseInt(process.env.QUOTES_CACHE_TTL || '8000'); // 8 seconds default

// FRED Series IDs for Treasury Yields
const FRED_SERIES = {
  'UST30Y': 'DGS30',
  'UST10Y': 'DGS10',
  'UST2Y': 'DGS2',
};

// Yahoo Finance ticker mappings (consolidated from securitiesConfig.js)
// This should match src/constants/securitiesConfig.js YAHOO_TICKER_MAP
const YAHOO_TICKER_MAP = {
  // Indices
  'SPX': '^GSPC',
  'COMPQ': '^IXIC',
  'RUT': '^RUT',
  'VIX': '^VIX',
  'DAX': '^GDAXI',
  'NIKK': '^N225',
  'SSEC': '000001.SS',
  'CRB': '^CRB',
  
  // Currency pairs
  'EUR/USD': 'EURUSD=X',
  'USD/YEN': 'JPY=X',
  'GBP/USD': 'GBPUSD=X',
  'CAD/USD': 'CADUSD=X',
  'USD': 'DX-Y.NYB',
  'DXY': 'DX-Y.NYB',
  
  // Currency ETFs
  'UUP': 'UUP',
  'FXE': 'FXE',
  'FXY': 'FXY',
  'FXF': 'FXF',
  'FXB': 'FXB',
  
  // Commodities
  'WTIC': 'CL=F',
  'WTI': 'CL=F',
  'BRENT': 'BZ=F',
  'NATGAS': 'NG=F',
  'GOLD': 'GC=F',
  'SILVER': 'SI=F',
  'COPPER': 'HG=F',
  
  // Crypto
  'BTC': 'BTC-USD',
  'BITCOIN': 'BTC-USD',
  'ETH': 'ETH-USD',
  'SOL': 'SOL-USD',
  'AVAX': 'AVAX-USD',
  'XRP': 'XRP-USD',
};

// Helper to get ticker mapping (matches securitiesConfig.js logic)
function getTickerMapping(symbol) {
  const upperSymbol = symbol.toUpperCase();
  
  // Check FRED series first
  if (FRED_SERIES[upperSymbol]) {
    return { source: 'fred', ticker: FRED_SERIES[upperSymbol] };
  }
  
  // Check Yahoo Finance special mappings
  if (YAHOO_TICKER_MAP[upperSymbol]) {
    return { source: 'yahoo', ticker: YAHOO_TICKER_MAP[upperSymbol] };
  }
  
  // Default: use ticker as-is for Yahoo Finance
  return { source: 'yahoo', ticker: upperSymbol };
}

// Fetch from Yahoo Finance
async function fetchYahooQuote(yahooTicker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}`;
    const params = {
      range: '1d',
      interval: '1d',
      includePrePost: 'false'
    };
    
    console.log(`[Yahoo Finance] Fetching quote for: ${yahooTicker}`);
    
    const response = await axios.get(url, {
      params,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });
    
    const data = response.data;
    
    // Check for errors in Yahoo Finance response
    if (data.chart && data.chart.error) {
      console.warn(`[Yahoo Finance] API error for ${yahooTicker}:`, data.chart.error);
      return null;
    }
    
    if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
      console.warn(`[Yahoo Finance] Invalid response structure for ${yahooTicker}`);
      console.warn(`[Yahoo Finance] Response keys:`, Object.keys(data));
      if (data.chart) {
        console.warn(`[Yahoo Finance] Chart keys:`, Object.keys(data.chart));
      }
      return null;
    }
    
    const result = data.chart.result[0];
    
    // Check if result has errors
    if (result.error) {
      console.warn(`[Yahoo Finance] Result error for ${yahooTicker}:`, result.error);
      return null;
    }
    const meta = result.meta || {};
    
    // Log available price fields for debugging
    const availablePriceFields = Object.keys(meta).filter(key => 
      key.toLowerCase().includes('price') || 
      key.toLowerCase().includes('close') ||
      key.toLowerCase().includes('previous')
    );
    console.log(`[Yahoo Finance] ${yahooTicker} - Available price fields:`, availablePriceFields);
    
    // Try multiple price fields in order of preference
    let currentPrice = null;
    let previousClose = null;
    
    // Try regularMarketPrice first (most common)
    if (meta.regularMarketPrice !== undefined && meta.regularMarketPrice !== null) {
      currentPrice = meta.regularMarketPrice;
      previousClose = meta.previousClose || meta.chartPreviousClose || meta.previousClose || currentPrice;
    }
    // Try chartPreviousClose (for indices and some ETFs)
    else if (meta.chartPreviousClose !== undefined && meta.chartPreviousClose !== null) {
      currentPrice = meta.chartPreviousClose;
      previousClose = meta.previousClose || currentPrice;
    }
    // Try previousClose (fallback)
    else if (meta.previousClose !== undefined && meta.previousClose !== null) {
      currentPrice = meta.previousClose;
      previousClose = currentPrice;
    }
    // Try regularMarketPreviousClose
    else if (meta.regularMarketPreviousClose !== undefined && meta.regularMarketPreviousClose !== null) {
      currentPrice = meta.regularMarketPreviousClose;
      previousClose = currentPrice;
    }
    // Try to get from indicators.quote if available
    else if (result.indicators && result.indicators.quote && result.indicators.quote[0]) {
      const quote = result.indicators.quote[0];
      const closeValues = quote.close || [];
      if (closeValues.length > 0) {
        currentPrice = closeValues[closeValues.length - 1];
        previousClose = closeValues.length > 1 ? closeValues[closeValues.length - 2] : currentPrice;
      }
    }
    
    if (currentPrice !== null && currentPrice !== undefined) {
      // Ensure previousClose is set
      if (!previousClose) {
        previousClose = currentPrice;
      }
      
      const change = currentPrice - previousClose;
      const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;
      
      console.log(`[Yahoo Finance] Successfully fetched ${yahooTicker}: price=${currentPrice}, change=${change}, source=${availablePriceFields.join(',')}`);
      
      return {
        price: currentPrice.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        timestamp: new Date().toISOString()
      };
    } else {
      console.warn(`[Yahoo Finance] No price found in response for ${yahooTicker}`);
      console.warn(`[Yahoo Finance] Meta keys:`, Object.keys(meta));
      console.warn(`[Yahoo Finance] Sample meta data:`, JSON.stringify({
        regularMarketPrice: meta.regularMarketPrice,
        chartPreviousClose: meta.chartPreviousClose,
        previousClose: meta.previousClose,
        regularMarketPreviousClose: meta.regularMarketPreviousClose
      }, null, 2));
      return null;
    }
  } catch (error) {
    console.error(`[Yahoo Finance] Error fetching quote for ${yahooTicker}:`, error.message);
    if (error.response) {
      console.error(`[Yahoo Finance] Response status: ${error.response.status}`);
      console.error(`[Yahoo Finance] Response data:`, error.response.data);
    }
    return null;
  }
}

// Fetch from FRED API
async function fetchFredQuote(seriesId) {
  try {
    const apiKey = process.env.FRED_API_KEY || '';
    if (!apiKey) {
      console.warn(`[FRED] Warning: FRED_API_KEY environment variable is not set. FRED API now requires an API key. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html`);
    }
    
    const url = 'https://api.stlouisfed.org/fred/series/observations';
    const params = {
      series_id: seriesId,
      api_key: apiKey,
      file_type: 'json',
      limit: '2', // Get 2 observations to calculate change
      sort_order: 'desc'
    };
    
    console.log(`[FRED] Fetching quote for: ${seriesId}`);
    
    const response = await axios.get(url, {
      params,
      timeout: 10000
    });
    
    const data = response.data;
    
    if (data.observations && data.observations.length > 0) {
      const obs = data.observations[0];
      if (obs.value && obs.value !== '.') {
        const price = parseFloat(obs.value);
        // For yields, we need previous value to calculate change
        const previousObs = data.observations[1];
        const previousPrice = previousObs && previousObs.value !== '.' ? parseFloat(previousObs.value) : price;
        const change = price - previousPrice;
        const changePercent = previousPrice > 0 ? (change / previousPrice) * 100 : 0;
        
        console.log(`[FRED] Successfully fetched ${seriesId}: price=${price}, change=${change}`);
        
        return {
          price: price.toFixed(2),
          change: change.toFixed(2),
          changePercent: changePercent.toFixed(2),
          timestamp: new Date().toISOString()
        };
      } else {
        console.warn(`[FRED] Invalid value for ${seriesId}:`, obs.value);
      }
    } else {
      console.warn(`[FRED] No observations returned for ${seriesId}`);
    }
    
    return null;
  } catch (error) {
    console.error(`[FRED] Error fetching quote for ${seriesId}:`, error.message);
    if (error.response) {
      console.error(`[FRED] Response status: ${error.response.status}`);
      console.error(`[FRED] Response data:`, error.response.data);
      
      // Check if error is related to missing API key
      if (error.response.data && error.response.data.error_message) {
        const errorMsg = error.response.data.error_message.toLowerCase();
        if (errorMsg.includes('api_key') || errorMsg.includes('api key')) {
          console.error(`[FRED] API key error detected. Please set FRED_API_KEY environment variable. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html`);
        }
      }
    }
    return null;
  }
}

// Fetch quote with caching
async function getQuote(symbol) {
  const now = Date.now();
  const cacheKey = symbol.toUpperCase();
  
  // Check cache
  const cached = quotesCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    console.log(`[Cache] Hit for ${cacheKey}`);
    return cached.data;
  }
  
  console.log(`[Cache] Miss for ${cacheKey}, fetching...`);
  
  // Fetch new data
  const mapping = getTickerMapping(symbol);
  let quoteData = null;
  
  try {
    if (mapping.source === 'fred') {
      quoteData = await fetchFredQuote(mapping.ticker);
    } else {
      quoteData = await fetchYahooQuote(mapping.ticker);
    }
    
    if (quoteData && quoteData.price) {
      const quoteResult = { symbol: symbol.toUpperCase(), ...quoteData };
      // Store in cache
      quotesCache.set(cacheKey, {
        data: quoteResult,
        timestamp: now
      });
      console.log(`[Cache] Stored quote for ${cacheKey}: price=${quoteData.price}`);
      return quoteResult;
    } else {
      console.warn(`[Quote] No valid price data returned for ${symbol} (${mapping.ticker})`);
      if (quoteData) {
        console.warn(`[Quote] Quote data structure:`, Object.keys(quoteData));
      }
    }
  } catch (error) {
    console.error(`[Quote] Error fetching quote for ${symbol}:`, error.message);
    if (error.stack) {
      console.error(`[Quote] Stack trace:`, error.stack.split('\n').slice(0, 3).join('\n'));
    }
  }
  
  // Return cached data even if expired, or null
  if (cached && cached.data && cached.data.price) {
    console.log(`[Cache] Returning expired cache for ${cacheKey}`);
    return cached.data;
  }
  
  return null;
}

// Mock portfolio data
const generatePortfolioData = () => {
  const totalValue = 250000 + Math.random() * 50000;
  const dayChange = (Math.random() - 0.5) * 5000;
  const dayChangePercent = (dayChange / totalValue) * 100;
  const totalGainLoss = (Math.random() - 0.3) * 20000;
  const totalGainLossPercent = (totalGainLoss / totalValue) * 100;
  
  return {
    summary: {
      totalValue: Math.floor(totalValue),
      totalDayChange: Math.floor(dayChange),
      totalDayChangePercent: dayChangePercent.toFixed(2),
      totalGainLoss: Math.floor(totalGainLoss),
      totalGainLossPercent: totalGainLossPercent.toFixed(2),
      positionCount: Math.floor(Math.random() * 20) + 5
    },
    assetAllocation: {
      'US Stocks': (Math.random() * 40 + 30).toFixed(1),
      'International': (Math.random() * 20 + 10).toFixed(1),
      'Bonds': (Math.random() * 20 + 5).toFixed(1),
      'Cash': (Math.random() * 10 + 5).toFixed(1),
      'Alternatives': (Math.random() * 15 + 5).toFixed(1)
    },
    topHoldings: [
      { symbol: 'AAPL', marketValue: Math.floor(Math.random() * 50000) + 20000, accountPercent: (Math.random() * 15 + 5).toFixed(1) },
      { symbol: 'MSFT', marketValue: Math.floor(Math.random() * 40000) + 15000, accountPercent: (Math.random() * 12 + 4).toFixed(1) },
      { symbol: 'GOOGL', marketValue: Math.floor(Math.random() * 30000) + 10000, accountPercent: (Math.random() * 10 + 3).toFixed(1) },
      { symbol: 'TSLA', marketValue: Math.floor(Math.random() * 25000) + 8000, accountPercent: (Math.random() * 8 + 2).toFixed(1) },
      { symbol: 'NVDA', marketValue: Math.floor(Math.random() * 20000) + 5000, accountPercent: (Math.random() * 6 + 2).toFixed(1) }
    ],
    lastUpdated: new Date().toLocaleTimeString()
  };
};

// Fixed options data
const generateOptionsData = () => ([
  { symbol: 'SPY', strike: '455', expiration: '12/20', type: 'C', bid: '1.25', ask: '1.35', volume: 1200, openInterest: 12430 },
  { symbol: 'QQQ', strike: '171', expiration: '12/20', type: 'P', bid: '2.10', ask: '2.20', volume: 765, openInterest: 16352 },
  { symbol: 'AAPL', strike: '289', expiration: '12/20', type: 'C', bid: '3.05', ask: '3.20', volume: 167, openInterest: 7386 },
  { symbol: 'TSLA', strike: '221', expiration: '12/20', type: 'P', bid: '4.50', ask: '4.70', volume: 453, openInterest: 5931 },
  { symbol: 'NVDA', strike: '217', expiration: '12/20', type: 'C', bid: '2.80', ask: '2.95', volume: 1081, openInterest: 6327 }
]);

// Real VIX data from Yahoo Finance
const fetchVIXData = async () => {
  try {
    // Using Yahoo Finance API (free, no API key required)
    const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d');
    const data = await response.json();
    
    if (data.chart && data.chart.result && data.chart.result[0]) {
      const result = data.chart.result[0];
      const meta = result.meta;
      const quotes = result.indicators.quote[0];
      
      // Get the latest price
      const latestPrice = meta.regularMarketPrice || meta.previousClose || 0;
      const previousClose = meta.previousClose || 0;
      const change = latestPrice - previousClose;
      const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;
      
      return {
        current: latestPrice.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        timestamp: new Date().toISOString(),
        high: meta.regularMarketDayHigh || 0,
        low: meta.regularMarketDayLow || 0,
        open: meta.regularMarketOpen || 0,
        volume: meta.regularMarketVolume || 0
      };
    }
    
    // Fallback to mock data if API fails
    return {
      current: '18.42',
      change: '0.00',
      changePercent: '0.00',
      timestamp: new Date().toISOString(),
      high: 19.50,
      low: 17.80,
      open: 18.20,
      volume: 0
    };
  } catch (error) {
    console.error('Error fetching VIX data:', error);
    // Fallback to mock data
    return {
      current: '18.42',
      change: '0.00',
      changePercent: '0.00',
      timestamp: new Date().toISOString(),
      high: 19.50,
      low: 17.80,
      open: 18.20,
      volume: 0
    };
  }
};

// Helper to batch process with delays (rate limiting)
async function batchProcess(items, batchSize, delayMs, processor) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    console.log(`[API] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(items.length / batchSize)} (${batch.length} symbols)`);
    
    // Process batch with small delay between each item to avoid rate limiting
    const batchResults = [];
    for (const item of batch) {
      const result = await processor(item);
      batchResults.push(result);
      // Small delay between requests (100ms to avoid rate limiting)
      if (batch.indexOf(item) < batch.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    results.push(...batchResults);
    
    // Add delay between batches to avoid rate limiting (except for last batch)
    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return results;
}

// API Routes
app.get('/api/quotes', async (req, res) => {
  try {
    const symbols = req.query.symbols ? req.query.symbols.split(',') : ['SPY', 'QQQ', 'AAPL'];
    console.log(`[API] /api/quotes called with ${symbols.length} symbols:`, symbols.slice(0, 5), '...');
    
    const quotes = {};
    
    // Process in batches to avoid rate limiting
    // Yahoo Finance can be sensitive to rate limiting, so we'll do smaller batches with longer delays
    const BATCH_SIZE = 5; // Reduced from 10 to avoid rate limiting
    const DELAY_MS = 200; // Increased from 100ms to 200ms between batches
    
    const results = await batchProcess(
      symbols.map(s => s.trim()),
      BATCH_SIZE,
      DELAY_MS,
      async (symbol) => {
        try {
          return await getQuote(symbol);
        } catch (error) {
          console.error(`[API] Error fetching quote for ${symbol}:`, error.message);
          return null;
        }
      }
    );
    
    // Map results back to symbols
    let successCount = 0;
    let failCount = 0;
    symbols.forEach((symbol, index) => {
      const quote = results[index];
      if (quote && quote.price) {
        quotes[symbol.trim().toUpperCase()] = quote;
        successCount++;
      } else {
        failCount++;
        if (failCount <= 10) { // Log first 10 failures
          console.warn(`[API] No quote data for ${symbol}`);
        }
      }
    });
    
    console.log(`[API] Returning ${successCount} quotes out of ${symbols.length} requested (${failCount} failed)`);
    res.json(quotes);
  } catch (error) {
    console.error('[API] Error in /api/quotes:', error);
    console.error('[API] Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to fetch quotes', details: error.message });
  }
});

// Risk Range Data endpoint - fetches LRR/HRR from Hedgeye (NEW SCHEMA)
app.get('/api/risk-ranges', async (req, res) => {
  try {
    const { tickers, date } = req.query;
    const tickerList = tickers ? tickers.split(',').map(t => t.trim().toUpperCase()) : null;
    const queryDate = date || new Date().toISOString().split('T')[0]; // Default to today

    console.log(`[API] /api/risk-ranges called for date: ${queryDate}${tickerList ? ` (${tickerList.length} tickers)` : ' (all tickers)'}`);

    // Try to get from DailySnapshot first (fastest)
    try {
      const snapshotParams = {
        TableName: 'HedgeyeDailySnapshot',
        Key: {
          date: queryDate,
          snapshotType: 'risk-ranges'
        }
      };

      const snapshotResult = await dynamodb.get(snapshotParams).promise();

      if (snapshotResult.Item && snapshotResult.Item.data) {
        console.log(`[API] Found snapshot with ${snapshotResult.Item.riskRangeCount} securities`);

        const allData = snapshotResult.Item.data;

        // Filter by tickers if provided
        const riskRanges = tickerList
          ? Object.fromEntries(
              tickerList
                .map(ticker => [ticker, allData[ticker] || null])
                .filter(([_, data]) => data !== null)
            )
          : allData;

        console.log(`[API] Returning ${Object.keys(riskRanges).length} risk ranges from snapshot`);
        return res.json(riskRanges);
      }
    } catch (snapshotError) {
      console.log('[API] Snapshot not found, querying individual records...');
    }

    // Fallback: Query HedgeyeRiskRanges table directly
    const params = {
      TableName: 'HedgeyeRiskRanges',
      KeyConditionExpression: '#date = :date',
      ExpressionAttributeNames: {
        '#date': 'date'
      },
      ExpressionAttributeValues: {
        ':date': queryDate
      }
    };

    const result = await dynamodb.query(params).promise();

    if (!result.Items || result.Items.length === 0) {
      console.log(`[API] No risk range data found for ${queryDate}`);
      return res.json({});
    }

    // Convert array to object keyed by ticker
    const allData = result.Items.reduce((acc, item) => {
      acc[item.ticker] = {
        lrr: parseFloat(item.lrr),
        hrr: parseFloat(item.hrr),
        timestamp: item.updatedAt
      };
      return acc;
    }, {});

    // Filter by tickers if provided
    const riskRanges = tickerList
      ? Object.fromEntries(
          tickerList
            .map(ticker => [ticker, allData[ticker] || null])
            .filter(([_, data]) => data !== null)
        )
      : allData;

    console.log(`[API] Returning ${Object.keys(riskRanges).length} risk ranges for ${queryDate}`);
    res.json(riskRanges);

  } catch (error) {
    console.error('[API] Error in /api/risk-ranges:', error);
    res.status(500).json({ error: 'Failed to fetch risk ranges', details: error.message });
  }
});

// Macro Indicators endpoint - fetches top row indicators
app.get('/api/macro-indicators', async (req, res) => {
  try {
    const macroIndicators = ['DXY', 'GLD', 'UST10Y', 'CRB', 'WTI', 'SPY', 'QQQ', 'IWM'];
    console.log(`[API] /api/macro-indicators called for ${macroIndicators.length} indicators`);
    
    const indicators = {};
    
    // Process in batches to avoid rate limiting
    const BATCH_SIZE = 5;
    const DELAY_MS = 200;
    
    const results = await batchProcess(
      macroIndicators,
      BATCH_SIZE,
      DELAY_MS,
      async (symbol) => {
        try {
          return await getQuote(symbol);
        } catch (error) {
          console.error(`[API] Error fetching macro indicator ${symbol}:`, error.message);
          return null;
        }
      }
    );
    
    // Map results back to indicators
    let successCount = 0;
    macroIndicators.forEach((symbol, index) => {
      const quote = results[index];
      if (quote && quote.price) {
        indicators[symbol] = {
          symbol: symbol,
          price: quote.price,
          change: quote.change || null,
          changePercent: quote.changePercent || null,
          timestamp: quote.timestamp || new Date().toISOString()
        };
        successCount++;
      } else {
        indicators[symbol] = {
          symbol: symbol,
          price: null,
          error: 'No data available'
        };
      }
    });
    
    console.log(`[API] Returning ${successCount} macro indicators out of ${macroIndicators.length} requested`);
    res.json(indicators);
  } catch (error) {
    console.error('[API] Error in /api/macro-indicators:', error);
    res.status(500).json({ error: 'Failed to fetch macro indicators' });
  }
});

// Signal Strength Rankings Endpoint
app.get('/api/securities/signal-strength', async (req, res) => {
  try {
    // For now, we'll fetch from DynamoDB MarketPriceHistory table
    // Get all unique symbols from the table
    const scanParams = {
      TableName: 'MarketPriceHistory',
      ProjectionExpression: 'symbol'
    };
    
    const scanResult = await dynamodb.scan(scanParams).promise();
    const uniqueSymbols = [...new Set(scanResult.Items.map(item => item.symbol))];
    
    // If no data in DynamoDB, return empty array (frontend will use fallback)
    if (uniqueSymbols.length === 0) {
      return res.json([]);
    }
    
    // Fetch latest market data from DynamoDB for all securities
    const today = new Date().toISOString().split('T')[0];
    const securitiesData = [];
    
    // For each symbol, get latest market data
    for (const symbol of uniqueSymbols) {
      try {
        // Get latest price data from DynamoDB
        const params = {
          TableName: 'MarketPriceHistory',
          KeyConditionExpression: 'symbol = :symbol',
          ExpressionAttributeValues: {
            ':symbol': symbol
          },
          ScanIndexForward: false,
          Limit: 1
        };
        
        const result = await dynamodb.query(params).promise();
        
        let marketData = {
          ticker: symbol,
          name: symbol,
          assetClass: 'equity', // Default, can be enhanced
          price: null,
          trendLevel: null,
          tailLevel: null,
          trendStatus: null,
          tailStatus: null,
          buyTrade: null,
          sellTrade: null,
          upside: null,
          downside: null,
          trendSignal: 'NEUTRAL'
        };
        
        if (result.Items && result.Items.length > 0) {
          const latest = result.Items[0];
          marketData.price = latest.close;
          marketData.closingPrice = latest.close;
        }
        
        securitiesData.push(marketData);
      } catch (error) {
        console.error(`Error fetching data for ${symbol}:`, error);
      }
    }
    
    // Calculate signal strength for each security
    // Simple calculation based on bias for now (can be enhanced with real data)
    const rankedSecurities = securitiesData.map(security => {
      let score = 0;
      
      // Base score from trend signal
      if (security.trendSignal === 'BULLISH') score += 50;
      else if (security.trendSignal === 'BEARISH') score -= 50;
      
      // If we have price vs trend level data, add momentum
      if (security.trendStatus === 'Above') score += 20;
      else if (security.trendStatus === 'Below') score -= 20;
      
      // If we have tail level data, add support/resistance
      if (security.tailStatus === 'Above') score += 10;
      else if (security.tailStatus === 'Below') score -= 10;
      
      // Risk/reward from upside/downside
      if (security.upside && security.downside) {
        const riskReward = security.upside - Math.abs(security.downside);
        score += Math.max(-20, Math.min(20, riskReward * 0.8));
      }
      
      score = Math.max(-100, Math.min(100, Math.round(score)));
      
      // Determine level and color
      let level = 'Neutral';
      let color = 'gray';
      if (score >= 70) { level = 'Very Strong'; color = 'emerald'; }
      else if (score >= 40) { level = 'Strong'; color = 'emerald'; }
      else if (score >= 10) { level = 'Moderate'; color = 'lime'; }
      else if (score >= -10) { level = 'Neutral'; color = 'gray'; }
      else if (score >= -40) { level = 'Weak'; color = 'amber'; }
      else if (score >= -70) { level = 'Very Weak'; color = 'red'; }
      else { level = 'Extremely Weak'; color = 'red'; }
      
      return {
        ...security,
        signalStrength: score,
        signalLevel: level,
        signalColor: color
      };
    }).sort((a, b) => b.signalStrength - a.signalStrength);
    
    res.json(rankedSecurities);
  } catch (error) {
    console.error('Error fetching signal strength rankings:', error);
    res.status(500).json({ error: 'Failed to fetch signal strength rankings' });
  }
});

// Get real portfolio data from DynamoDB
app.get('/api/portfolio', async (req, res) => {
  try {
    // Get latest portfolio snapshot - scan all and sort by timestamp
    const snapshotParams = {
      TableName: 'PortfolioSnapshots'
    };
    
    const snapshotResult = await dynamodb.scan(snapshotParams).promise();
    
    // Sort by timestamp descending to get the latest record
    const sortedItems = snapshotResult.Items.sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );
    
    if (!sortedItems || sortedItems.length === 0) {
      // No data yet - return empty state
      return res.json({
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
        lastUpdated: 'No portfolio data - upload a Schwab CSV to get started'
      });
    }
    
    const latestSnapshot = sortedItems[0];
    const snapshotId = latestSnapshot.snapshotId;
    
    // Get holdings for this snapshot
    const holdingsParams = {
      TableName: 'Holdings',
      FilterExpression: 'snapshotId = :snapshotId',
      ExpressionAttributeValues: {
        ':snapshotId': snapshotId
      }
    };
    
    const holdingsResult = await dynamodb.scan(holdingsParams).promise();
    const holdings = holdingsResult.Items || [];
    
    // Transform to frontend format
    const portfolioData = {
      summary: {
        totalValue: latestSnapshot.summary?.totalValue || 0,
        totalDayChange: latestSnapshot.summary?.totalDayChange || 0,
        totalDayChangePercent: latestSnapshot.summary?.totalDayChangePercent || '0.00',
        totalGainLoss: latestSnapshot.summary?.totalGainLoss || 0,
        totalGainLossPercent: latestSnapshot.summary?.totalGainLossPercent || '0.00',
        positionCount: latestSnapshot.summary?.positionCount || holdings.length
      },
      assetAllocation: latestSnapshot.assetAllocation || {},
      holdings: holdings.map(holding => ({
        symbol: holding.symbol,
        description: holding.description || '',
        quantity: holding.quantity || 0,
        price: holding.price || 0,
        marketValue: holding.marketValue || 0,
        costBasis: holding.costBasis || 0,
        gainLoss: holding.gainLoss || 0,
        gainLossPercent: holding.gainLossPercent || 0,
        assetType: holding.assetType || 'Unknown',
        assetClass: holding.assetClass || 'Other'
      })),
      topHoldings: holdings.slice(0, 10).map(holding => ({
        symbol: holding.symbol,
        marketValue: holding.marketValue,
        accountPercent: holding.accountPercent || '0.00'
      })),
      lastUpdated: (() => {
        // Lambda stores timestamp without 'Z' suffix, so we need to treat it as UTC
        const timestamp = latestSnapshot.timestamp.endsWith('Z')
          ? latestSnapshot.timestamp
          : latestSnapshot.timestamp + 'Z';
        const date = new Date(timestamp);

        // Format date part (MM/DD/YYYY)
        const datePart = date.toLocaleDateString('en-US', {
          timeZone: 'America/Los_Angeles',
          month: '2-digit',
          day: '2-digit',
          year: 'numeric'
        });

        // Format PST/PDT time
        const pstTime = date.toLocaleTimeString('en-US', {
          timeZone: 'America/Los_Angeles',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });

        // Format EST/EDT time
        const estTime = date.toLocaleTimeString('en-US', {
          timeZone: 'America/New_York',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });

        return `${datePart}, ${pstTime} PST / ${estTime} EST`;
      })()
    };
    
    res.json(portfolioData);
    
  } catch (error) {
    console.error('Error fetching portfolio data:', error);
    res.status(500).json({ 
      error: 'Failed to fetch portfolio data',
      details: error.message 
    });
  }
});

// Performance Tracking API Endpoints

// Get performance history
app.get('/api/performance/history', async (req, res) => {
  try {
    const { startDate, endDate, limit } = req.query;
    const table = 'PerformanceHistory';
    
    const params = {
      TableName: table
    };
    
    const result = await dynamodb.scan(params).promise();
    let items = result.Items || [];
    
    // Sort by date ascending
    items.sort((a, b) => a.date.localeCompare(b.date));
    
    // Filter by date range if provided
    if (startDate) {
      items = items.filter(item => item.date >= startDate);
    }
    if (endDate) {
      items = items.filter(item => item.date <= endDate);
    }
    
    // Apply limit if provided
    if (limit) {
      items = items.slice(-parseInt(limit));
    }
    
    // Transform to response format
    const response = {
      dates: items.map(item => item.date),
      values: items.map(item => parseFloat(item.totalValue) || 0),
      returns: items.map(item => parseFloat(item.dailyReturn) || 0),
      cumulativeReturns: items.map(item => parseFloat(item.cumulativeReturn) || 0),
      data: items.map(item => ({
        date: item.date,
        totalValue: parseFloat(item.totalValue) || 0,
        dailyReturn: parseFloat(item.dailyReturn) || 0,
        cumulativeReturn: parseFloat(item.cumulativeReturn) || 0,
        positionCount: item.positionCount || 0,
        snapshotId: item.snapshotId
      }))
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching performance history:', error);
    res.status(500).json({ error: 'Failed to fetch performance history' });
  }
});

// Get performance metrics
app.get('/api/performance/metrics', async (req, res) => {
  try {
    const { period = 'all' } = req.query;
    const table = 'PerformanceMetrics';
    
    // Get latest metrics for the specified period
    const params = {
      TableName: table,
      KeyConditionExpression: 'metricType = :metricType',
      ExpressionAttributeValues: {
        ':metricType': period
      },
      ScanIndexForward: false, // Descending order
      Limit: 1
    };
    
    const result = await dynamodb.query(params).promise();
    
    if (result.Items && result.Items.length > 0) {
      const metrics = result.Items[0];
      res.json({
        sharpeRatio: parseFloat(metrics.sharpeRatio) || 0,
        maxDrawdown: parseFloat(metrics.maxDrawdown) || 0,
        volatility: parseFloat(metrics.volatility) || 0,
        winRate: parseFloat(metrics.winRate) || 0,
        avgDailyReturn: parseFloat(metrics.avgDailyReturn) || 0,
        bestDay: parseFloat(metrics.bestDay) || 0,
        worstDay: parseFloat(metrics.worstDay) || 0,
        rollingReturns: metrics.rollingReturns || {},
        vsBenchmark: metrics.vsBenchmark || {},
        calculationDate: metrics.calculationDate
      });
    } else {
      // Return empty metrics if not calculated yet
      res.json({
        sharpeRatio: 0,
        maxDrawdown: 0,
        volatility: 0,
        winRate: 0,
        avgDailyReturn: 0,
        bestDay: 0,
        worstDay: 0,
        rollingReturns: {},
        vsBenchmark: {},
        calculationDate: null
      });
    }
  } catch (error) {
    console.error('Error fetching performance metrics:', error);
    res.status(500).json({ error: 'Failed to fetch performance metrics' });
  }
});

// Get position performance
app.get('/api/performance/positions', async (req, res) => {
  try {
    const { symbol, startDate, endDate } = req.query;
    const table = 'PositionPerformance';
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol parameter is required' });
    }
    
    const params = {
      TableName: table,
      KeyConditionExpression: 'symbol = :symbol',
      ExpressionAttributeValues: {
        ':symbol': symbol
      }
    };
    
    const result = await dynamodb.query(params).promise();
    let items = result.Items || [];
    
    // Sort by date ascending
    items.sort((a, b) => a.date.localeCompare(b.date));
    
    // Filter by date range if provided
    if (startDate) {
      items = items.filter(item => item.date >= startDate);
    }
    if (endDate) {
      items = items.filter(item => item.date <= endDate);
    }
    
    res.json({
      symbol: symbol,
      history: items.map(item => ({
        date: item.date,
        quantity: parseFloat(item.quantity) || 0,
        price: parseFloat(item.price) || 0,
        marketValue: parseFloat(item.marketValue) || 0,
        costBasis: parseFloat(item.costBasis) || 0,
        gainLoss: parseFloat(item.gainLoss) || 0,
        gainLossPercent: parseFloat(item.gainLossPercent) || 0,
        dailyReturn: parseFloat(item.dailyReturn) || 0,
        cumulativeReturn: parseFloat(item.cumulativeReturn) || 0
      }))
    });
  } catch (error) {
    console.error('Error fetching position performance:', error);
    res.status(500).json({ error: 'Failed to fetch position performance' });
  }
});

// Get benchmark comparison
app.get('/api/performance/benchmark-comparison', async (req, res) => {
  try {
    const { startDate, endDate, benchmarks = 'SPY,QQQ' } = req.query;
    const benchmarkList = benchmarks.split(',').map(b => b.trim());
    
    // Get portfolio performance history
    const perfParams = {
      TableName: 'PerformanceHistory'
    };
    const perfResult = await dynamodb.scan(perfParams).promise();
    let perfItems = (perfResult.Items || []).sort((a, b) => a.date.localeCompare(b.date));
    
    // Filter by date range
    if (startDate) {
      perfItems = perfItems.filter(item => item.date >= startDate);
    }
    if (endDate) {
      perfItems = perfItems.filter(item => item.date <= endDate);
    }
    
    // Get benchmark data from MarketData table
    const benchmarkData = {};
    for (const benchmark of benchmarkList) {
      benchmarkData[benchmark] = [];
      
      // Get market data for each date
      for (const perfItem of perfItems) {
        try {
          const marketParams = {
            TableName: 'MarketData',
            Key: { date: perfItem.date }
          };
          const marketResult = await dynamodb.get(marketParams).promise();
          
          if (marketResult.Item && marketResult.Item.marketData && marketResult.Item.marketData[benchmark]) {
            const price = marketResult.Item.marketData[benchmark].price || 0;
            benchmarkData[benchmark].push({
              date: perfItem.date,
              price: price,
              changePercent: marketResult.Item.marketData[benchmark].changePercent || 0
            });
          }
        } catch (err) {
          // Skip if data not available
        }
      }
    }
    
    // Calculate cumulative returns for benchmarks
    const benchmarkReturns = {};
    for (const benchmark of benchmarkList) {
      if (benchmarkData[benchmark].length > 0) {
        const firstPrice = benchmarkData[benchmark][0].price;
        benchmarkReturns[benchmark] = benchmarkData[benchmark].map(item => {
          if (firstPrice > 0) {
            return ((item.price - firstPrice) / firstPrice) * 100;
          }
          return 0;
        });
      } else {
        benchmarkReturns[benchmark] = [];
      }
    }
    
    res.json({
      portfolio: perfItems.map(item => ({
        date: item.date,
        value: parseFloat(item.totalValue) || 0,
        return: parseFloat(item.cumulativeReturn) || 0
      })),
      benchmarks: Object.keys(benchmarkReturns).reduce((acc, key) => {
        acc[key] = benchmarkData[key].map((item, idx) => ({
          date: item.date,
          price: item.price,
          return: benchmarkReturns[key][idx] || 0
        }));
        return acc;
      }, {})
    });
  } catch (error) {
    console.error('Error fetching benchmark comparison:', error);
    res.status(500).json({ error: 'Failed to fetch benchmark comparison' });
  }
});

// Get equity curve with drawdowns
app.get('/api/performance/equity-curve', async (req, res) => {
  try {
    const params = {
      TableName: 'PerformanceHistory'
    };
    
    const result = await dynamodb.scan(params).promise();
    let items = (result.Items || []).sort((a, b) => a.date.localeCompare(b.date));
    
    if (items.length === 0) {
      return res.json({
        dates: [],
        values: [],
        drawdowns: []
      });
    }
    
    // Calculate drawdowns
    const values = items.map(item => parseFloat(item.totalValue) || 0);
    const dates = items.map(item => item.date);
    const drawdowns = [];
    let peak = values[0];
    
    for (let i = 0; i < values.length; i++) {
      if (values[i] > peak) {
        peak = values[i];
      }
      const drawdown = peak > 0 ? ((values[i] - peak) / peak) * 100 : 0;
      drawdowns.push(drawdown);
    }
    
    res.json({
      dates: dates,
      values: values,
      drawdowns: drawdowns,
      returns: items.map(item => parseFloat(item.dailyReturn) || 0),
      cumulativeReturns: items.map(item => parseFloat(item.cumulativeReturn) || 0)
    });
  } catch (error) {
    console.error('Error fetching equity curve:', error);
    res.status(500).json({ error: 'Failed to fetch equity curve' });
  }
});

app.get('/api/options', (req, res) => {
  res.json(generateOptionsData());
});

app.get('/api/indicators/vix', async (req, res) => {
  try {
    const vixData = await fetchVIXData();
    res.json(vixData);
  } catch (error) {
    console.error('Error in VIX endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch VIX data' });
  }
});

app.get('/api/indicators/volume', (req, res) => {
  const symbols = req.query.symbols ? req.query.symbols.split(',') : ['SPY', 'QQQ'];
  const data = generateMockData();
  const volumeData = {};
  
  symbols.forEach(symbol => {
    if (data[symbol]) {
      volumeData[symbol] = {
        symbol,
        volume: data[symbol].volume,
        avgVolume: Math.floor(data[symbol].volume * (0.8 + Math.random() * 0.4)),
        timestamp: data[symbol].timestamp
      };
    }
  });
  
  res.json(volumeData);
});

// USD Macro Dashboard API Endpoints

// Get latest DXY value
app.get('/api/usd/dxy', async (req, res) => {
  try {
    const params = {
      TableName: 'MarketPriceHistory',
      KeyConditionExpression: 'symbol = :symbol',
      ExpressionAttributeValues: {
        ':symbol': 'DXY'
      },
      ScanIndexForward: false, // Sort by date descending
      Limit: 2 // Get latest and previous for change calculation
    };
    
    const result = await dynamodb.query(params).promise();
    
    if (!result.Items || result.Items.length === 0) {
      return res.json({ 
        value: null, 
        change: null, 
        changePercent: null, 
        timestamp: null,
        message: 'No DXY data available' 
      });
    }
    
    const latest = result.Items[0];
    const previous = result.Items[1];
    
    const value = parseFloat(latest.close);
    const change = previous ? value - parseFloat(previous.close) : 0;
    const changePercent = previous ? ((change / parseFloat(previous.close)) * 100).toFixed(2) : '0.00';
    
    res.json({
      value: value,
      change: change.toFixed(2),
      changePercent: changePercent,
      timestamp: latest.timestamp
    });
    
  } catch (error) {
    console.error('Error fetching DXY data:', error);
    res.status(500).json({ error: 'Failed to fetch DXY data' });
  }
});

// Get currency pairs (mock data for now - will be replaced with real Yahoo Finance data)
app.get('/api/usd/currency-pairs', async (req, res) => {
  try {
    // For now, return mock data. In production, this would fetch from Yahoo Finance
    const currencyPairs = [
      { pair: 'USDEUR', name: 'USD/EUR', rate: '0.9234', change: '-0.0012', changePercent: '-0.13%', timestamp: new Date().toISOString() },
      { pair: 'USDJPY', name: 'USD/JPY', rate: '149.23', change: '0.67', changePercent: '0.45%', timestamp: new Date().toISOString() },
      { pair: 'USDGBP', name: 'USD/GBP', rate: '1.2345', change: '0.0022', changePercent: '0.18%', timestamp: new Date().toISOString() },
      { pair: 'USDCHF', name: 'USD/CHF', rate: '0.8765', change: '-0.0034', changePercent: '-0.39%', timestamp: new Date().toISOString() },
      { pair: 'USDCAD', name: 'USD/CAD', rate: '1.3456', change: '0.0011', changePercent: '0.08%', timestamp: new Date().toISOString() },
      { pair: 'USDCNY', name: 'USD/CNY', rate: '7.2345', change: '0.0123', changePercent: '0.17%', timestamp: new Date().toISOString() },
      { pair: 'USDAUD', name: 'USD/AUD', rate: '1.5234', change: '-0.0023', changePercent: '-0.15%', timestamp: new Date().toISOString() }
    ];
    
    res.json(currencyPairs);
    
  } catch (error) {
    console.error('Error fetching currency pairs:', error);
    res.status(500).json({ error: 'Failed to fetch currency pairs' });
  }
});

// Get USD correlations
app.get('/api/usd/correlations', async (req, res) => {
  try {
    const params = {
      TableName: 'USDCorrelations',
      ScanIndexForward: false, // Sort by date descending
      Limit: 1
    };
    
    const result = await dynamodb.scan(params).promise();
    
    if (!result.Items || result.Items.length === 0) {
      return res.json({ 
        correlations: null, 
        rollingStats: null, 
        timestamp: null,
        message: 'No correlation data available' 
      });
    }
    
    const latest = result.Items[0];
    
    res.json({
      correlations: latest.correlations,
      rollingStats: latest.rollingStats,
      timestamp: latest.timestamp,
      calculationDate: latest.calculationDate
    });
    
  } catch (error) {
    console.error('Error fetching correlation data:', error);
    res.status(500).json({ error: 'Failed to fetch correlation data' });
  }
});

// Helper function to normalize currency pair symbols
function normalizeCurrencySymbol(symbol) {
  const currencyPairMap = {
    'EUR/USD': 'USDEUR',
    'USD/EUR': 'USDEUR',
    'GBP/USD': 'USDGBP',
    'USD/GBP': 'USDGBP',
    'CAD/USD': 'USDCAD',
    'USD/CAD': 'USDCAD',
    'JPY/USD': 'USDJPY',
    'USD/JPY': 'USDJPY',
    'USD/YEN': 'USDJPY',
    'CHF/USD': 'USDCHF',
    'USD/CHF': 'USDCHF',
    'CNY/USD': 'USDCNY',
    'USD/CNY': 'USDCNY',
    'AUD/USD': 'USDAUD',
    'USD/AUD': 'USDAUD',
    'NZD/USD': 'USDNZD',
    'USD/NZD': 'USDNZD'
  };
  return currencyPairMap[symbol.toUpperCase()] || symbol.toUpperCase();
}

// Get historical price data for a specific symbol
// Uses query parameter to handle symbols with slashes (e.g., GBP/USD, EUR/USD)
app.get('/api/usd/historical', async (req, res) => {
  try {
    const { symbol, days = 30 } = req.query;
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol query parameter is required' });
    }
    
    // Decode URL-encoded symbols
    let decodedSymbol = decodeURIComponent(symbol);
    
    // Normalize currency pair formats
    const normalizedSymbol = normalizeCurrencySymbol(decodedSymbol);
    
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    // Format dates as YYYY-MM-DD for DynamoDB
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    const params = {
      TableName: 'MarketPriceHistory',
      KeyConditionExpression: 'symbol = :symbol AND #date BETWEEN :startDate AND :endDate',
      ExpressionAttributeNames: {
        '#date': 'date'
      },
      ExpressionAttributeValues: {
        ':symbol': normalizedSymbol,
        ':startDate': startDateStr,
        ':endDate': endDateStr
      },
      ScanIndexForward: true
    };
    
    const result = await dynamodb.query(params).promise();
    
    // If no data in database, try fetching from Yahoo Finance as fallback
    if (!result.Items || result.Items.length === 0) {
      console.log(`No historical data found in database for ${normalizedSymbol} (original: ${decodedSymbol}), trying Yahoo Finance fallback...`);
      
      const yahooTickerMap = {
        'DXY': 'DX-Y.NYB',
        'USDEUR': 'USDEUR=X',
        'EURUSD': 'EURUSD=X',
        'USDJPY': 'USDJPY=X',
        'JPYUSD': 'JPY=X',
        'USDGBP': 'USDGBP=X',
        'GBPUSD': 'GBPUSD=X',
        'USDCHF': 'USDCHF=X',
        'CHFUSD': 'USDCHF=X',
        'USDCAD': 'USDCAD=X',
        'CADUSD': 'CADUSD=X',
        'USDCNY': 'USDCNY=X',
        'CNYUSD': 'USDCNY=X',
        'USDAUD': 'USDAUD=X',
        'AUDUSD': 'USDAUD=X',
        'USDNZD': 'USDNZD=X',
        'NZDUSD': 'USDNZD=X',
        'EUR/USD': 'EURUSD=X',
        'USD/EUR': 'USDEUR=X',
        'GBP/USD': 'GBPUSD=X',
        'USD/GBP': 'USDGBP=X',
        'CAD/USD': 'CADUSD=X',
        'USD/CAD': 'USDCAD=X',
        'JPY/USD': 'JPY=X',
        'USD/JPY': 'USDJPY=X',
        'USD/YEN': 'JPY=X',
        'CHF/USD': 'USDCHF=X',
        'USD/CHF': 'USDCHF=X',
        'CNY/USD': 'USDCNY=X',
        'USD/CNY': 'USDCNY=X',
        'AUD/USD': 'USDAUD=X',
        'USD/AUD': 'USDAUD=X',
        'NZD/USD': 'USDNZD=X',
        'USD/NZD': 'USDNZD=X'
      };
      
      const yahooTicker = yahooTickerMap[normalizedSymbol] || yahooTickerMap[decodedSymbol.toUpperCase()] || decodedSymbol;
      
      try {
        const range = days <= 7 ? '5d' : days <= 30 ? '1mo' : days <= 90 ? '3mo' : days <= 180 ? '6mo' : '1y';
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}`;
        const response = await axios.get(url, {
          params: {
            range: range,
            interval: '1d',
            includePrePost: 'false'
          },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 10000
        });
        
        const data = response.data;
        if (data.chart && data.chart.result && data.chart.result.length > 0) {
          const result = data.chart.result[0];
          const timestamps = result.timestamp || [];
          const quotes = result.indicators?.quote?.[0];
          
          if (quotes && quotes.close && quotes.close.length > 0) {
            const historicalData = [];
            for (let i = 0; i < timestamps.length; i++) {
              const closePrice = quotes.close[i];
              // Skip null/undefined close prices
              if (closePrice === null || closePrice === undefined) continue;
              
              const date = new Date(timestamps[i] * 1000);
              const dateStr = date.toISOString().split('T')[0];
              
              historicalData.push({
                date: dateStr,
                close: closePrice,
                open: quotes.open?.[i] || null,
                high: quotes.high?.[i] || null,
                low: quotes.low?.[i] || null,
                volume: quotes.volume?.[i] || null
              });
            }
            
            // For small day ranges, just return the most recent data points
            // This ensures charts always have enough data to render
            const requestedDays = parseInt(days);
            const minDataPoints = Math.max(requestedDays, 5); // At least 5 points for a decent chart
            const trimmedData = historicalData.slice(-minDataPoints);
            
            if (trimmedData.length > 0) {
              console.log(`Fetched ${trimmedData.length} data points from Yahoo Finance for ${normalizedSymbol} (original: ${decodedSymbol})`);
              return res.json({
                symbol: decodedSymbol,
                data: trimmedData,
                count: trimmedData.length
              });
            }
          }
        }
      } catch (yahooError) {
        console.error(`Error fetching from Yahoo Finance for ${normalizedSymbol} (original: ${decodedSymbol}):`, yahooError.message);
      }
      
      console.log(`No historical data available for ${normalizedSymbol} (original: ${decodedSymbol}) from any source`);
      return res.json({ 
        symbol: decodedSymbol,
        data: [],
        message: `No historical data available for ${decodedSymbol} in the requested date range` 
      });
    }
    
    const historicalData = result.Items.map(item => ({
      date: item.date,
      close: parseFloat(item.close),
      open: item.open ? parseFloat(item.open) : null,
      high: item.high ? parseFloat(item.high) : null,
      low: item.low ? parseFloat(item.low) : null,
      volume: item.volume || null
    }));
    
    console.log(`Fetched ${historicalData.length} data points for ${normalizedSymbol} (original: ${decodedSymbol}, requested ${days} days)`);
    
    res.json({
      symbol: decodedSymbol,
      data: historicalData,
      count: historicalData.length
    });
    
  } catch (error) {
    const symbolParam = req.query.symbol || 'unknown';
    console.error(`Error fetching historical data for ${symbolParam}:`, error);
    res.status(500).json({ error: `Failed to fetch historical data for ${symbolParam}` });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Daily Notes API Endpoints

// List all dates that have notes
app.get('/api/notes', async (req, res) => {
  try {
    const params = {
      TableName: 'DailyNotes',
      ProjectionExpression: '#dt', // Only retrieve the date attribute (using alias for reserved keyword)
      ExpressionAttributeNames: {
        '#dt': 'date'
      }
    };
    
    const result = await dynamodb.scan(params).promise();
    
    // Extract dates and sort descending (newest first)
    const dates = result.Items
      .map(item => item.date)
      .filter(date => date) // Filter out any null/undefined dates
      .sort()
      .reverse(); // Sort descending (newest first)
    
    res.json({
      dates: dates,
      count: dates.length
    });
    
  } catch (error) {
    console.error('Error listing note dates:', error);
    res.status(500).json({ 
      error: 'Failed to list note dates',
      details: error.message 
    });
  }
});

// Save a note for a specific date
app.post('/api/notes', async (req, res) => {
  try {
    const { date, content } = req.body;
    
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    
    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    
    const params = {
      TableName: 'DailyNotes',
      Item: {
        date: date,
        content: content || '',
        timestamp: new Date().toISOString(),
      }
    };
    
    await dynamodb.put(params).promise();
    
    res.json({
      success: true,
      date: date,
      timestamp: params.Item.timestamp
    });
    
  } catch (error) {
    console.error('Error saving note:', error);
    res.status(500).json({ 
      error: 'Failed to save note',
      details: error.message 
    });
  }
});

// Get a note for a specific date
app.get('/api/notes/:date', async (req, res) => {
  try {
    const { date } = req.params;
    
    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    
    const params = {
      TableName: 'DailyNotes',
      Key: {
        date: date
      }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      return res.status(404).json({ 
        error: 'Note not found',
        date: date 
      });
    }
    
    res.json({
      date: result.Item.date,
      content: result.Item.content,
      timestamp: result.Item.timestamp
    });
    
  } catch (error) {
    console.error('Error loading note:', error);
    res.status(500).json({ 
      error: 'Failed to load note',
      details: error.message 
    });
  }
});

// Calendar Notes API Endpoints

// Save a calendar note for a specific date
app.post('/api/notes/calendar', async (req, res) => {
  try {
    const { date, content } = req.body;
    
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    
    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    
    const params = {
      TableName: 'CalendarNotes',
      Item: {
        date: date,
        content: content || '',
        timestamp: new Date().toISOString(),
      }
    };
    
    await dynamodb.put(params).promise();
    
    res.json({
      success: true,
      date: date,
      timestamp: params.Item.timestamp
    });
    
  } catch (error) {
    console.error('Error saving calendar note:', error);
    res.status(500).json({ 
      error: 'Failed to save calendar note',
      details: error.message 
    });
  }
});

// Get a calendar note for a specific date
app.get('/api/notes/calendar/:date', async (req, res) => {
  try {
    const { date } = req.params;
    
    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    
    const params = {
      TableName: 'CalendarNotes',
      Key: {
        date: date
      }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      return res.status(404).json({ 
        error: 'Calendar note not found',
        date: date 
      });
    }
    
    res.json({
      date: result.Item.date,
      content: result.Item.content,
      timestamp: result.Item.timestamp
    });
    
  } catch (error) {
    console.error('Error loading calendar note:', error);
    res.status(500).json({ 
      error: 'Failed to load calendar note',
      details: error.message 
    });
  }
});

// AWS Status debugging endpoint (temporary)
app.get('/api/aws-status', async (req, res) => {
  try {
    const credentials = AWS.config.credentials;
    const region = AWS.config.region;
    
    // Test S3 access
    let s3Status = 'unknown';
    let bucketStatus = 'unknown';
    let bucketList = [];
    
    try {
      const result = await s3.listBuckets().promise();
      s3Status = 'accessible';
      bucketList = result.Buckets.map(b => b.Name);
      
      // Check if target bucket exists
      const targetBucket = 'market-dashboard-csv-data';
      bucketStatus = bucketList.includes(targetBucket) ? 'exists' : 'missing';
    } catch (error) {
      s3Status = 'error';
      bucketStatus = 'error';
    }
    
    res.json({
      aws: {
        region: region,
        credentialsConfigured: !!credentials,
        credentialsType: credentials ? credentials.constructor.name : 'none',
        s3Status: s3Status,
        bucketStatus: bucketStatus,
        availableBuckets: bucketList,
        targetBucket: 'market-dashboard-csv-data'
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check AWS status',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Presigned URL endpoint for CSV uploads
app.post('/api/presigned-url', async (req, res) => {
  try {
    const { filename, contentType } = req.body;
    
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }

    console.log(`🔗 Generating presigned URL for: ${filename}`);

    const params = {
      Bucket: 'market-dashboard-csv-data',
      Key: filename,
      ContentType: contentType || 'text/csv',
      Expires: 300 // 5 minutes
      // Removed ServerSideEncryption as it can cause signing issues
    };

    // Use promise-based approach for better error handling
    const presignedUrl = await new Promise((resolve, reject) => {
      s3.getSignedUrl('putObject', params, (err, url) => {
        if (err) {
          console.error('❌ S3 getSignedUrl error:', err);
          reject(err);
        } else {
          console.log(`✅ Generated presigned URL: ${url.substring(0, 100)}...`);
          resolve(url);
        }
      });
    });
    
    res.json({
      presignedUrl,
      key: filename,
      bucket: 'market-dashboard-csv-data'
    });
    
  } catch (error) {
    console.error('❌ Error generating presigned URL:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode
    });
    
    res.status(500).json({ 
      error: 'Failed to generate presigned URL',
      details: error.message,
      code: error.code || 'UNKNOWN_ERROR'
    });
  }
});

// Serve static files only in production
// In development, React dev server handles frontend (run separately on port 3000)
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));

  // Serve React app for all non-API routes (must be last route)
  // Use a function-based route matcher for Express 5 compatibility
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
} else {
  // In development, log that React dev server should be running separately
  console.log('📝 Development mode: React dev server should run separately on port 3000');
  console.log('   Start it with: npm start');
}

// Start HTTP server first so we can attach WebSocket server to it
const server = app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Market data API available at http://localhost:${PORT}/api`);
  console.log(`💼 Portfolio data available at http://localhost:${PORT}/api/portfolio`);
  
  // Validate AWS credentials after server starts
  await validateAWSCredentials();
});

// -----------------------------
// WebSocket: /ws/market
// -----------------------------
const wss = new WebSocketServer({ server, path: '/ws/market' });

// Simple subscription tracking (by channel)
const channelToClients = new Map();

function addClientToChannel(ws, channel) {
  if (!channelToClients.has(channel)) {
    channelToClients.set(channel, new Set());
  }
  channelToClients.get(channel).add(ws);
}

function removeClientFromAllChannels(ws) {
  channelToClients.forEach((clients, channel) => {
    if (clients.has(ws)) {
      clients.delete(ws);
      if (clients.size === 0) channelToClients.delete(channel);
    }
  });
}

function broadcastToChannel(channel, payload) {
  const clients = channelToClients.get(channel);
  if (!clients) return;
  const message = JSON.stringify({ channel, payload });
  clients.forEach(client => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('🔌 WebSocket client connected');

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data && data.action === 'subscribe' && data.channel) {
        addClientToChannel(ws, data.channel);
        // Acknowledge
        ws.send(JSON.stringify({ channel: 'system', payload: { status: 'subscribed', channel: data.channel } }));
      }
      if (data && data.action === 'unsubscribe' && data.channel) {
        const clients = channelToClients.get(data.channel);
        if (clients) clients.delete(ws);
        ws.send(JSON.stringify({ channel: 'system', payload: { status: 'unsubscribed', channel: data.channel } }));
      }
    } catch (err) {
      console.error('WS message parse error:', err);
    }
  });

  ws.on('close', () => {
    removeClientFromAllChannels(ws);
    console.log('🔌 WebSocket client disconnected');
  });
});

// Disable broadcaster by default to keep UI stable
// Set ENABLE_WS_BROADCAST=true to re-enable timed updates
if (process.env.ENABLE_WS_BROADCAST === 'true') {
  setInterval(() => {
    if (!channelToClients.has('quotes') || channelToClients.get('quotes').size === 0) return;
    const data = generateMockData();
    const quotes = Object.values(data).slice(0, 5);
    broadcastToChannel('quotes', quotes);
  }, 2000);
}

module.exports = app;
