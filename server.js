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

// Performance Routes
const performanceRoutes = require('./src/routes/performance');
app.use('/api/performance', performanceRoutes);

// Import ticker mapping configuration
// Note: Since server.js is CommonJS and securitiesConfig.js is ES6, we'll create a helper function
// that replicates the logic. In the future, consider converting to ES6 modules or creating a shared config.

// In-memory cache for quotes (5-10 second TTL)
const quotesCache = new Map();
const CACHE_TTL = parseInt(process.env.QUOTES_CACHE_TTL || '8000'); // 8 seconds default

// Cache for historical data (1 hour TTL - changes daily)
const historicalCache = new Map();
const HISTORICAL_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Cache for risk ranges (1 hour TTL - changes daily)
const riskRangesCache = new Map();
const RISK_RANGES_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Cache for intraday sparkline data (5-minute TTL)
const intradayCache = new Map();
const INTRADAY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// FRED Series IDs for Treasury Yields and Rates
const FRED_SERIES = {
  'UST30Y': 'DGS30',
  'UST10Y': 'DGS10',
  'UST5Y': 'DGS5',
  'UST2Y': 'DGS2',
  'UST13W': 'DGS3MO',
  'SOFR': 'SOFR',
  'FEDFUNDS': 'DFF',  // Federal Funds Effective Rate
};

// Yahoo Finance ticker mappings (consolidated from securitiesConfig.js)
// This should match src/constants/securitiesConfig.js YAHOO_TICKER_MAP
const YAHOO_TICKER_MAP = {
  // Indices - US
  'SPX': '^GSPC',
  'SPY': '^GSPC',
  'DJI': '^DJI',
  'COMPQ': '^IXIC',
  'IXIC': '^IXIC',
  'RUT': '^RUT',
  'VIX': '^VIX',
  'CRB': '^CRB',

  // Indices - European
  'DAX': '^GDAXI',
  'FTSE': '^FTSE',
  'CAC': '^FCHI',
  'N100': '^N100',

  // Indices - Asian
  'NIKK': '^N225',
  'N225': '^N225',
  'HSI': '^HSI',
  'SSEC': '000001.SS',
  'AXJO': '^AXJO',

  // Indices - Other
  'MOVE': '^MOVE',
  'TNX': '^TNX',

  // Currency pairs
  'EUR/USD': 'EURUSD=X',
  'EURUSD': 'EURUSD=X',
  'USD/YEN': 'JPY=X',
  'USDJPY': 'JPY=X',
  'JPY=X': 'JPY=X',
  'GBP/USD': 'GBPUSD=X',
  'GBPUSD': 'GBPUSD=X',
  'CAD/USD': 'CADUSD=X',
  'USDCAD': 'CADUSD=X',
  'AUDUSD': 'AUDUSD=X',
  'USDMXN': 'MXN=X',
  'USDCNY': 'CNY=X',
  'CNY=X': 'CNY=X',
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
  'CL': 'CL=F',
  'BRENT': 'BZ=F',
  'BZ': 'BZ=F',
  'NATGAS': 'NG=F',
  'NG': 'NG=F',
  'GOLD': 'GC=F',
  'GC': 'GC=F',
  'SILVER': 'SI=F',
  'SI': 'SI=F',
  'COPPER': 'HG=F',
  'HG': 'HG=F',
  'PLATINUM': 'PL=F',
  'PL': 'PL=F',

  // ETFs for market breadth
  'QQQ': 'QQQ',
  'RSP': 'RSP',

  // Crypto
  'BTC': 'BTC-USD',
  'BITCOIN': 'BTC-USD',
  'ETH': 'ETH-USD',
  'ETHEREUM': 'ETH-USD',
  'BNB': 'BNB-USD',
  'ADA': 'ADA-USD',
  'CARDANO': 'ADA-USD',
  'SOL': 'SOL-USD',
  'SOLANA': 'SOL-USD',
  'AVAX': 'AVAX-USD',
  'XRP': 'XRP-USD',
};

// Multi-region market configuration
const MARKET_REGIONS = {
  us: {
    label: 'US',
    indices: [
      { symbol: 'SPY', name: 'S&P 500', yahooSymbol: '^GSPC' },
      { symbol: 'DJI', name: 'Dow 30', yahooSymbol: '^DJI' },
      { symbol: 'IXIC', name: 'Nasdaq', yahooSymbol: '^IXIC' },
      { symbol: 'RUT', name: 'Russell 2000', yahooSymbol: '^RUT' },
      { symbol: 'QQQ', name: 'QQQ (Tech)', yahooSymbol: 'QQQ' },
      { symbol: 'RSP', name: 'EW S&P (Breadth)', yahooSymbol: 'RSP' }
    ]
  },
  europe: {
    label: 'Europe',
    indices: [
      { symbol: 'FTSE', name: 'FTSE 100', yahooSymbol: '^FTSE' },
      { symbol: 'CAC', name: 'CAC 40', yahooSymbol: '^FCHI' },
      { symbol: 'DAX', name: 'DAX', yahooSymbol: '^GDAXI' },
      { symbol: 'N100', name: 'Euronext 100', yahooSymbol: '^N100' },
      { symbol: 'EURUSD', name: 'EUR/USD', yahooSymbol: 'EURUSD=X' },
      { symbol: 'GBPUSD', name: 'USD/GBP', yahooSymbol: 'GBPUSD=X' }
    ]
  },
  asia: {
    label: 'Asia',
    indices: [
      { symbol: 'N225', name: 'Nikkei 225', yahooSymbol: '^N225' },
      { symbol: 'HSI', name: 'Hang Seng', yahooSymbol: '^HSI' },
      { symbol: 'SSEC', name: 'Shanghai', yahooSymbol: '000001.SS' },
      { symbol: 'AXJO', name: 'ASX 200', yahooSymbol: '^AXJO' },
      { symbol: 'USDJPY', name: 'USD/JPY', yahooSymbol: 'JPY=X' },
      { symbol: 'USDCNY', name: 'USD/CNY', yahooSymbol: 'CNY=X' }
    ]
  },
  crypto: {
    label: 'Cryptocurrencies',
    indices: [
      { symbol: 'BTC', name: 'Bitcoin', yahooSymbol: 'BTC-USD' },
      { symbol: 'ETH', name: 'Ethereum', yahooSymbol: 'ETH-USD' },
      { symbol: 'BNB', name: 'Binance Coin', yahooSymbol: 'BNB-USD' },
      { symbol: 'ADA', name: 'Cardano', yahooSymbol: 'ADA-USD' },
      { symbol: 'SOL', name: 'Solana', yahooSymbol: 'SOL-USD' },
      { symbol: 'XRP', name: 'XRP', yahooSymbol: 'XRP-USD' }
    ]
  },
  rates: {
    label: 'Rates',
    indices: [
      { symbol: 'UST2Y', name: '2-Yr', fredSymbol: 'DGS2' },
      { symbol: 'UST5Y', name: '5-Yr', fredSymbol: 'DGS5' },
      { symbol: 'UST10Y', name: '10-Yr', fredSymbol: 'DGS10' },
      { symbol: 'UST30Y', name: '30-Yr', fredSymbol: 'DGS30' },
      { symbol: 'UST13W', name: '13-Wk', fredSymbol: 'DGS3MO' },
      { symbol: 'FEDFUNDS', name: 'Fed Funds', fredSymbol: 'DFF' }
    ]
  },
  commodities: {
    label: 'Commodities',
    indices: [
      { symbol: 'BZ', name: 'Brent Crude', yahooSymbol: 'BZ=F' },
      { symbol: 'CL', name: 'WTI Crude', yahooSymbol: 'CL=F' },
      { symbol: 'GC', name: 'Gold', yahooSymbol: 'GC=F' },
      { symbol: 'SI', name: 'Silver', yahooSymbol: 'SI=F' },
      { symbol: 'HG', name: 'Copper', yahooSymbol: 'HG=F' },
      { symbol: 'PL', name: 'Platinum', yahooSymbol: 'PL=F' }
    ]
  },
  currencies: {
    label: 'Currencies',
    indices: [
      { symbol: 'EURUSD', name: 'EUR/USD', yahooSymbol: 'EURUSD=X' },
      { symbol: 'USDJPY', name: 'USD/JPY', yahooSymbol: 'JPY=X' },
      { symbol: 'GBPUSD', name: 'USD/GBP', yahooSymbol: 'GBPUSD=X' },
      { symbol: 'AUDUSD', name: 'USD/AUD', yahooSymbol: 'AUDUSD=X' },
      { symbol: 'USDCAD', name: 'USD/CAD', yahooSymbol: 'CADUSD=X' },
      { symbol: 'USDMXN', name: 'USD/MXN', yahooSymbol: 'MXN=X' }
    ]
  }
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
        previousClose: previousClose.toFixed(2),
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

// Fetch intraday data for sparklines (5-minute intervals, last 50 points)
async function getIntradayData(symbol, range = '1d') {
  const cacheKey = `intraday:${symbol.toUpperCase()}`;

  // Check cache
  const cached = intradayCache.get(cacheKey);
  if (cached) {
    console.log(`[IntradayCache] Hit for ${cacheKey}`);
    return cached;
  }

  console.log(`[IntradayCache] Miss for ${cacheKey}, fetching...`);

  try {
    // Get the Yahoo ticker mapping
    const mapping = getTickerMapping(symbol);
    const yahooSymbol = mapping.source === 'yahoo' ? mapping.ticker : symbol;

    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?range=${range}&interval=5m`;

    const response = await axios.get(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const result = response.data?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]?.close) {
      console.warn(`[IntradayData] No valid data for ${symbol}`);
      return [];
    }

    const closePrices = result.indicators.quote[0].close;

    // Extract last 50 data points for sparkline, filter out null values
    const sparklineData = closePrices
      .filter(price => price !== null && price !== undefined)
      .slice(-50)
      .map(price => parseFloat(price.toFixed(2)));

    // Cache for 5 minutes
    intradayCache.set(cacheKey, sparklineData);
    setTimeout(() => {
      intradayCache.delete(cacheKey);
      console.log(`[IntradayCache] Expired and deleted ${cacheKey}`);
    }, INTRADAY_CACHE_TTL);

    console.log(`[IntradayCache] Stored sparkline for ${cacheKey}: ${sparklineData.length} points`);
    return sparklineData;
  } catch (error) {
    console.error(`[IntradayData] Failed to fetch for ${symbol}:`, error.message);
    return [];
  }
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
  const batchStartTime = Date.now();
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(items.length / batchSize);
    console.log(`[API] Processing batch ${batchNum}/${totalBatches} (${batch.length} symbols)`);

    // Process batch with small delay between each item to avoid rate limiting
    const batchResults = [];
    const itemStartTime = Date.now();
    for (const item of batch) {
      const itemStart = Date.now();
      const result = await processor(item);
      const itemTime = Date.now() - itemStart;
      batchResults.push(result);
      // Small delay between requests (100ms to avoid rate limiting)
      if (batch.indexOf(item) < batch.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const batchTime = Date.now() - itemStartTime;
    console.log(`[API] Batch ${batchNum} completed in ${batchTime}ms (avg ${(batchTime / batch.length).toFixed(0)}ms per item)`);
    results.push(...batchResults);

    // Add delay between batches to avoid rate limiting (except for last batch)
    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  const totalTime = Date.now() - batchStartTime;
  console.log(`[API] Batch processing completed: ${items.length} items in ${totalTime}ms (avg ${(totalTime / items.length).toFixed(0)}ms per item)`);
  return results;
}

// API Routes
app.get('/api/quotes', async (req, res) => {
  const startTime = Date.now();
  try {
    const symbols = req.query.symbols ? req.query.symbols.split(',') : ['SPY', 'QQQ', 'AAPL'];
    console.log(`[API] /api/quotes called with ${symbols.length} symbols:`, symbols.slice(0, 5), '...');

    const quotes = {};

    // Process in batches to avoid rate limiting
    // Yahoo Finance can be sensitive to rate limiting, so we'll do smaller batches with longer delays
    const BATCH_SIZE = 5; // Reduced from 10 to avoid rate limiting
    const DELAY_MS = 200; // Increased from 100ms to 200ms between batches

    const fetchStartTime = Date.now();
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
    const fetchTime = Date.now() - fetchStartTime;
    console.log(`[API] Quote fetching completed in ${fetchTime}ms`);

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

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/quotes completed: ${successCount} quotes out of ${symbols.length} requested (${failCount} failed) in ${totalTime}ms`);
    res.json(quotes);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/quotes after ${totalTime}ms:`, error);
    console.error('[API] Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to fetch quotes', details: error.message });
  }
});

// Chart Data endpoint - fetches OHLC data for expanded market charts
// Cache for chart data with different TTLs based on range
const chartDataCache = new Map();

app.get('/api/chart-data/:symbol', async (req, res) => {
  const startTime = Date.now();
  const { symbol } = req.params;
  const { range = '1d' } = req.query;

  // Validate range parameter
  const validRanges = ['1d', '5d', '1mo', '3mo', '6mo', '1y'];
  if (!validRanges.includes(range)) {
    return res.status(400).json({ error: `Invalid range. Must be one of: ${validRanges.join(', ')}` });
  }

  // Determine interval based on range
  const intervalMap = {
    '1d': '5m',
    '5d': '15m',
    '1mo': '1h',
    '3mo': '1d',
    '6mo': '1d',
    '1y': '1d'
  };
  const interval = intervalMap[range];

  // Cache TTL based on range (shorter for intraday, longer for historical)
  // Client-side caching handles more frequent updates, so server cache can be longer
  const cacheTTLMap = {
    '1d': 2 * 60 * 1000,    // 2 minutes for intraday (client caches 30s)
    '5d': 10 * 60 * 1000,   // 10 minutes (client caches 1 min)
    '1mo': 15 * 60 * 1000,  // 15 minutes (client caches 5 min)
    '3mo': 30 * 60 * 1000,  // 30 minutes (client caches 5 min)
    '6mo': 60 * 60 * 1000,  // 1 hour (client caches 10 min)
    '1y': 60 * 60 * 1000    // 1 hour (client caches 10 min)
  };
  const cacheTTL = cacheTTLMap[range];

  const cacheKey = `chart:${symbol.toUpperCase()}:${range}`;

  // Check cache
  const cached = chartDataCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < cacheTTL) {
    console.log(`[ChartData] Cache hit for ${cacheKey}`);
    return res.json(cached.data);
  }

  try {
    // Get the Yahoo ticker mapping
    const mapping = getTickerMapping(symbol);

    // Check if this is a FRED symbol (Treasury yields)
    if (mapping.source === 'fred') {
      // For FRED data, we only have daily data, so disable intraday ranges
      if (range === '1d' || range === '5d') {
        return res.json({
          symbol: symbol.toUpperCase(),
          name: symbol.toUpperCase(),
          error: 'Intraday data not available for Treasury yields',
          availableRanges: ['1mo', '3mo', '6mo', '1y'],
          chartData: []
        });
      }

      // Fetch FRED historical data
      const fredData = await fetchFREDHistorical(mapping.ticker, range);
      if (fredData) {
        const responseData = {
          symbol: symbol.toUpperCase(),
          name: symbol.toUpperCase(),
          source: 'fred',
          current: fredData.current,
          ohlc: null, // FRED doesn't provide OHLC
          chartData: fredData.chartData,
          meta: {
            currency: 'USD',
            dataSource: 'FRED',
            range,
            interval: '1d'
          }
        };

        // Cache the result
        chartDataCache.set(cacheKey, { data: responseData, timestamp: Date.now() });
        return res.json(responseData);
      }
    }

    // Yahoo Finance data
    const yahooSymbol = mapping.source === 'yahoo' ? mapping.ticker : symbol;
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${interval}&includePrePost=false`;

    console.log(`[ChartData] Fetching ${url}`);

    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const result = response.data?.chart?.result?.[0];
    if (!result) {
      return res.status(404).json({ error: `No chart data found for ${symbol}` });
    }

    const meta = result.meta || {};
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};

    // Build chart data array
    const chartData = timestamps.map((ts, i) => ({
      timestamp: ts * 1000, // Convert to milliseconds
      open: quote.open?.[i] ?? null,
      high: quote.high?.[i] ?? null,
      low: quote.low?.[i] ?? null,
      close: quote.close?.[i] ?? null,
      volume: quote.volume?.[i] ?? null
    })).filter(d => d.close !== null); // Filter out null closes

    // Get current day's OHLC from meta
    const currentPrice = meta.regularMarketPrice ?? meta.previousClose;
    const previousClose = meta.chartPreviousClose ?? meta.previousClose;
    const change = currentPrice && previousClose ? currentPrice - previousClose : null;
    const changePercent = currentPrice && previousClose ? ((change / previousClose) * 100) : null;

    // Find today's OHLC from chart data (last trading day)
    const todayData = chartData.length > 0 ? chartData[chartData.length - 1] : null;

    const responseData = {
      symbol: symbol.toUpperCase(),
      name: meta.shortName || meta.symbol || symbol.toUpperCase(),
      source: 'yahoo',
      current: {
        price: currentPrice?.toFixed(2) ?? null,
        change: change?.toFixed(2) ?? null,
        changePercent: changePercent?.toFixed(2) ?? null,
        previousClose: previousClose?.toFixed(2) ?? null
      },
      ohlc: {
        open: (meta.regularMarketOpen ?? todayData?.open)?.toFixed(2) ?? null,
        high: (meta.regularMarketDayHigh ?? todayData?.high)?.toFixed(2) ?? null,
        low: (meta.regularMarketDayLow ?? todayData?.low)?.toFixed(2) ?? null,
        close: currentPrice?.toFixed(2) ?? null
      },
      chartData,
      meta: {
        currency: meta.currency || 'USD',
        exchangeTimezone: meta.exchangeTimezoneName || meta.timezone,
        regularMarketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
        range,
        interval,
        dataPoints: chartData.length
      }
    };

    // Cache the result
    chartDataCache.set(cacheKey, { data: responseData, timestamp: Date.now() });

    const totalTime = Date.now() - startTime;
    console.log(`[ChartData] ${symbol} (${range}) completed in ${totalTime}ms with ${chartData.length} data points`);

    res.json(responseData);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[ChartData] Error fetching ${symbol} after ${totalTime}ms:`, error.message);
    res.status(500).json({ error: 'Failed to fetch chart data', details: error.message });
  }
});

// Helper function to fetch FRED historical data for charts
async function fetchFREDHistorical(seriesId, range) {
  try {
    const fredApiKey = process.env.FRED_API_KEY;
    if (!fredApiKey) {
      console.warn('[FRED] No API key configured');
      return null;
    }

    // Calculate start date based on range
    const endDate = new Date();
    const startDate = new Date();
    switch (range) {
      case '1mo': startDate.setMonth(startDate.getMonth() - 1); break;
      case '3mo': startDate.setMonth(startDate.getMonth() - 3); break;
      case '6mo': startDate.setMonth(startDate.getMonth() - 6); break;
      case '1y': startDate.setFullYear(startDate.getFullYear() - 1); break;
      default: startDate.setMonth(startDate.getMonth() - 1);
    }

    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${fredApiKey}&file_type=json&observation_start=${startDate.toISOString().split('T')[0]}&observation_end=${endDate.toISOString().split('T')[0]}`;

    const response = await axios.get(url, { timeout: 10000 });
    const observations = response.data?.observations || [];

    if (observations.length === 0) return null;

    const chartData = observations
      .filter(obs => obs.value !== '.')
      .map(obs => ({
        timestamp: new Date(obs.date).getTime(),
        open: null,
        high: null,
        low: null,
        close: parseFloat(obs.value),
        volume: null
      }));

    const latestValue = chartData.length > 0 ? chartData[chartData.length - 1].close : null;
    const previousValue = chartData.length > 1 ? chartData[chartData.length - 2].close : null;
    const change = latestValue && previousValue ? latestValue - previousValue : null;
    const changePercent = latestValue && previousValue ? ((change / previousValue) * 100) : null;

    return {
      current: {
        price: latestValue?.toFixed(2) ?? null,
        change: change?.toFixed(2) ?? null,
        changePercent: changePercent?.toFixed(2) ?? null,
        previousClose: previousValue?.toFixed(2) ?? null
      },
      chartData
    };
  } catch (error) {
    console.error(`[FRED] Error fetching historical for ${seriesId}:`, error.message);
    return null;
  }
}

// Risk Range Data endpoint - fetches LRR/HRR from Hedgeye
app.get('/api/risk-ranges', async (req, res) => {
  const startTime = Date.now();
  try {
    const { tickers, date } = req.query;
    const tickerList = tickers ? tickers.split(',').map(t => t.trim().toUpperCase()) : null;

    // Create cache key
    const cacheKey = tickerList ? tickerList.sort().join(',') : 'all';
    const now = Date.now();

    // Check cache (5 minute TTL)
    const cached = riskRangesCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < RISK_RANGES_CACHE_TTL) {
      const totalTime = Date.now() - startTime;
      console.log(`[API] /api/risk-ranges cache hit for ${cacheKey} (${totalTime}ms)`);
      return res.json(cached.data);
    }

    console.log(`[API] /api/risk-ranges called${tickerList ? ` for ${tickerList.length} tickers` : ' for all tickers'}`);

    // Query HedgeyeRiskRanges table - scan for latest date
    const dbStartTime = Date.now();

    // Scan to find all items and group by date to find the most recent with good data
    let targetDate = date;
    let allItems = [];

    // Full scan to get all items (table should be small - just risk ranges)
    const scanParams = {
      TableName: 'HedgeyeRiskRanges'
    };

    let lastKey = null;
    let fullScan = [];
    do {
      if (lastKey) scanParams.ExclusiveStartKey = lastKey;
      const scanResult = await dynamodb.scan(scanParams).promise();
      fullScan = fullScan.concat(scanResult.Items || []);
      lastKey = scanResult.LastEvaluatedKey;
    } while (lastKey);

    console.log(`[API] Full scan returned ${fullScan.length} total items`);

    // Group by date
    const byDate = {};
    fullScan.forEach(item => {
      const d = item.date;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(item);
    });

    // Find the date with the most items (best coverage) or use specified date
    const dates = Object.keys(byDate).sort().reverse(); // Most recent first
    console.log(`[API] Found dates: ${dates.join(', ')}`);

    if (targetDate && byDate[targetDate]) {
      allItems = byDate[targetDate];
    } else {
      // Find date with most items (best data quality)
      let bestDate = dates[0];
      let bestCount = 0;
      dates.forEach(d => {
        if (byDate[d].length > bestCount) {
          bestCount = byDate[d].length;
          bestDate = d;
        }
      });
      targetDate = bestDate;
      allItems = byDate[targetDate] || [];
      console.log(`[API] Selected date ${targetDate} with ${allItems.length} items (best coverage)`);
    }

    const dbTime = Date.now() - dbStartTime;
    console.log(`[API] DynamoDB scan completed in ${dbTime}ms, found ${allItems.length} items for date ${targetDate}`);

    if (allItems.length === 0) {
      const totalTime = Date.now() - startTime;
      console.log(`[API] No risk range data found in DynamoDB (${totalTime}ms)`);
      return res.json({});
    }

    // Transform to expected format: { ticker: { lrr, hrr, trend, timestamp } }
    const allData = {};
    allItems.forEach(item => {
      allData[item.ticker] = {
        lrr: parseFloat(item.lrr) || 0,
        hrr: parseFloat(item.hrr) || 0,
        trend: item.trend || 'N/A',
        timestamp: item.updatedAt || null,
        date: item.date
      };
    });

    // Filter by tickers if provided
    const riskRanges = tickerList
      ? Object.fromEntries(
        tickerList
          .map(ticker => [ticker, allData[ticker] || null])
          .filter(([_, data]) => data !== null)
      )
      : allData;

    // Store in cache
    riskRangesCache.set(cacheKey, {
      data: riskRanges,
      timestamp: now
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] Returning risk ranges for ${Object.keys(riskRanges).length} securities (total: ${totalTime}ms, DB: ${dbTime}ms)`);
    res.json(riskRanges);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/risk-ranges after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch risk ranges', details: error.message });
  }
});

// Historical Risk Ranges endpoint - specific ticker history
app.get('/api/risk-ranges/history', async (req, res) => {
  const startTime = Date.now();
  const { ticker, limit = 30 } = req.query;

  if (!ticker) {
    return res.status(400).json({ error: 'Ticker parameter is required' });
  }

  const parsedLimit = parseInt(limit) || 30;
  const upperTicker = ticker.toUpperCase();

  try {
    console.log(`[API] /api/risk-ranges/history called for ${upperTicker} (limit: ${parsedLimit})`);

    const params = {
      TableName: 'RiskRangeData',
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: {
        ':ticker': upperTicker
      },
      ScanIndexForward: false, // Descending order (newest first)
      Limit: parsedLimit
    };

    const result = await dynamodb.query(params).promise();
    const items = result.Items || [];

    // Sort array by date ascending for the chart (oldest to newest)
    items.sort((a, b) => new Date(a.date) - new Date(b.date));

    const totalTime = Date.now() - startTime;
    console.log(`[API] Returning ${items.length} historical items for ${upperTicker} (${totalTime}ms)`);

    res.json(items);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/risk-ranges/history after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch risk range history', details: error.message });
  }
});

// Bulk history endpoint for Securities Universe
app.get('/api/risk-ranges/history-all', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/risk-ranges/history-all called');

    const params = { TableName: 'RiskRangeData' };
    const result = await dynamodb.scan(params).promise();
    const items = result.Items || [];

    const grouped = {};
    items.forEach(item => {
      if (!grouped[item.ticker]) grouped[item.ticker] = [];
      grouped[item.ticker].push({
        date: item.date,
        lrr: item.lrr,
        hrr: item.hrr,
        trend: item.trend,
        close: item.close,
        timestamp: item.timestamp
      });
    });

    Object.keys(grouped).forEach(ticker => {
      grouped[ticker].sort((a, b) => new Date(a.date) - new Date(b.date));
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] Returning full history for ${Object.keys(grouped).length} tickers (${items.length} total items) in ${totalTime}ms`);

    res.json(grouped);
  } catch (error) {
    console.error('[API] Error in /api/risk-ranges/history-all:', error);
    res.status(500).json({ error: 'Failed to fetch bulk history' });
  }
});

// Hedgeye Freshness endpoint - returns status of all 6 Hedgeye data types
app.get('/api/hedgeye/freshness', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/hedgeye/freshness called');

    // Helper for date status
    // Now uses the explicit content 'date' from the item, compared to 'today' (NY time)
    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

    const getFreshnessStatus = (itemDate) => {
      if (!itemDate) return 'missing';
      return itemDate === today ? 'fresh' : 'stale';
    };

    const results = {};
    const alerts = [];

    // 1. Processing Risk Ranges (HedgeyeRiskRanges Table)
    // Risk Ranges are stored as individual items per ticker per date
    try {
      const rrParams = { TableName: 'HedgeyeRiskRanges' };
      const rrResult = await dynamodb.scan(rrParams).promise();
      const items = rrResult.Items || [];

      if (items.length > 0) {
        // Sort by date descending to find the latest batch
        // Assumption: date format is YYYY-MM-DD so string sort works
        const latestItem = items.sort((a, b) => b.date.localeCompare(a.date))[0];
        const latestDate = latestItem.date;

        // Count items for this latest date
        const itemsOnDate = items.filter(i => i.date === latestDate);

        results['risk-ranges'] = {
          status: getFreshnessStatus(latestDate),
          lastUpdated: latestDate, // Use content date as primary source for freshness
          scrapedAt: latestItem.updatedAt, // Keep technical timestamp available
          itemCount: itemsOnDate.length,
          date: latestDate,
          source: 'HedgeyeRiskRanges'
        };
      } else {
        results['risk-ranges'] = { status: 'missing', itemCount: 0, date: null, source: 'HedgeyeRiskRanges' };
      }
    } catch (err) {
      console.error('[API] Error querying HedgeyeRiskRanges:', err.message);
      results['risk-ranges'] = { status: 'error', error: err.message };
    }

    // 2. Processing Snapshots (HedgeyeDailySnapshot Table)
    // Other types are stored as single snapshot items per day
    const snapshotTypes = ['early-look', 'bitcoin-trend-tracker', 'momo-tracker', 'signal-strength', 'portfolio-solutions'];

    for (const snapshotType of snapshotTypes) {
      try {
        let latestSnapshot = null;

        // Query recent dates (last 7 days) to find the latest entry
        for (let i = 0; i < 7; i++) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

          const queryParams = {
            TableName: 'HedgeyeDailySnapshot',
            Key: {
              date: dateStr,
              snapshotType: snapshotType
            }
          };

          const queryResult = await dynamodb.get(queryParams).promise();
          if (queryResult.Item) {
            latestSnapshot = queryResult.Item;
            break;
          }
        }

        if (latestSnapshot) {
          // Calculate item count based on snapshot type
          let itemCount = 0;

          // Use explicit count fields if available
          if (latestSnapshot.riskRangeCount) itemCount = latestSnapshot.riskRangeCount;
          else if (latestSnapshot.stockCount) itemCount = latestSnapshot.stockCount;
          else if (latestSnapshot.cryptoCount) itemCount = latestSnapshot.cryptoCount + (latestSnapshot.stockCount || 0);
          else if (latestSnapshot.rankingCount) itemCount = latestSnapshot.rankingCount;

          // Fallback to counting data keys if explicit counts are missing/zero
          if (itemCount === 0 && latestSnapshot.data) {
            if (snapshotType === 'bitcoin-trend-tracker' && latestSnapshot.data.cryptos) {
              itemCount = Object.keys(latestSnapshot.data.cryptos).length + Object.keys(latestSnapshot.data.stocks || {}).length;
            } else if (Array.isArray(latestSnapshot.data)) {
              itemCount = latestSnapshot.data.length;
            } else if (Array.isArray(latestSnapshot.data.stocks)) {
              itemCount = latestSnapshot.data.stocks.length;
            } else if (Array.isArray(latestSnapshot.data.rankings)) {
              itemCount = latestSnapshot.data.rankings.length;
            } else if (typeof latestSnapshot.data === 'object') {
              itemCount = Object.keys(latestSnapshot.data).length;
            }
          }

          results[snapshotType] = {
            status: getFreshnessStatus(latestSnapshot.date),
            lastUpdated: latestSnapshot.date, // Use content date as primary
            scrapedAt: latestSnapshot.scrapedAt,
            itemCount: itemCount,
            date: latestSnapshot.date,
            source: 'HedgeyeDailySnapshot'
          };

        } else {
          results[snapshotType] = {
            status: 'missing',
            lastUpdated: null,
            itemCount: 0,
            date: null,
            source: 'HedgeyeDailySnapshot'
          };
        }
      } catch (err) {
        console.error(`[API] Error querying HedgeyeDailySnapshot for ${snapshotType}:`, err.message);
        results[snapshotType] = { status: 'error', error: err.message };
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hedgeye/freshness completed in ${totalTime}ms`);

    res.json({
      date: today,
      dataTypes: results,
      alerts: alerts,
      meta: {
        queryTime: totalTime,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hedgeye/freshness after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch freshness data', details: error.message });
  }
});

// Workflow Status endpoint - returns status of automated workflows
app.get('/api/workflow-status', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/workflow-status called');

    const today = new Date().toISOString().split('T')[0];
    const workflowStatus = {
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
    };

    // Get latest Hedgeye snapshot
    try {
      const hedgeyeStartTime = Date.now();
      const snapshotParams = {
        TableName: 'HedgeyeDailySnapshot',
        Key: {
          date: today,
          snapshotType: 'risk-ranges'
        }
      };

      const snapshotResult = await dynamodb.get(snapshotParams).promise();
      const hedgeyeGetTime = Date.now() - hedgeyeStartTime;
      console.log(`[API] Hedgeye get completed in ${hedgeyeGetTime}ms`);

      if (snapshotResult.Item) {
        workflowStatus.hedgeye = {
          status: 'success',
          lastRun: snapshotResult.Item.date,
          scrapedAt: snapshotResult.Item.scrapedAt,
          count: snapshotResult.Item.riskRangeCount || 0,
          nextRun: '8:00 AM EST (market days)'
        };
      } else {
        // Try to find most recent snapshot by querying recent dates (more efficient than scan)
        const queryStartTime = Date.now();
        let latest = null;

        // Try querying recent dates (last 7 days) in descending order
        for (let i = 0; i < 7; i++) {
          const date = new Date();
          date.setDate(date.getDate() - i);
          const dateStr = date.toISOString().split('T')[0];

          try {
            const queryParams = {
              TableName: 'HedgeyeDailySnapshot',
              KeyConditionExpression: 'date = :date AND snapshotType = :type',
              ExpressionAttributeValues: {
                ':date': dateStr,
                ':type': 'risk-ranges'
              }
            };

            const queryResult = await dynamodb.query(queryParams).promise();
            if (queryResult.Items && queryResult.Items.length > 0) {
              latest = queryResult.Items[0];
              break;
            }
          } catch (err) {
            // Continue to next date
            continue;
          }
        }

        // Fallback to scan only if query didn't find anything
        if (!latest) {
          const scanStartTime = Date.now();
          const scanParams = {
            TableName: 'HedgeyeDailySnapshot',
            FilterExpression: 'snapshotType = :type',
            ExpressionAttributeValues: {
              ':type': 'risk-ranges'
            },
            Limit: 10 // Get more items to find the latest
          };

          // Note: Scan is not ideal for large tables, but works as fallback
          const recentSnapshot = await dynamodb.scan(scanParams).promise();
          const scanTime = Date.now() - scanStartTime;
          console.log(`[API] Hedgeye scan fallback completed in ${scanTime}ms`);

          if (recentSnapshot.Items && recentSnapshot.Items.length > 0) {
            // Sort by date descending to get most recent
            latest = recentSnapshot.Items.sort((a, b) => {
              const dateA = new Date(a.date || 0);
              const dateB = new Date(b.date || 0);
              return dateB - dateA;
            })[0];
          }
        }

        const queryTime = Date.now() - queryStartTime;
        console.log(`[API] Hedgeye query/scan completed in ${queryTime}ms`);

        if (latest) {
          const latestDate = latest.date;
          const isToday = latestDate === today;
          const isRecent = latestDate && new Date(latestDate) >= new Date(new Date(today).getTime() - 2 * 24 * 60 * 60 * 1000); // Within 2 days

          workflowStatus.hedgeye = {
            status: isToday ? 'success' : (isRecent ? 'stale' : 'error'),
            lastRun: latest.date, // Use content date
            scrapedAt: latest.scrapedAt,
            count: latest.riskRangeCount || 0,
            nextRun: '8:00 AM EST (market days)'
          };
        }
      }
    } catch (hedgeyeError) {
      console.error('[API] Error fetching Hedgeye status:', hedgeyeError);
      workflowStatus.hedgeye.status = 'error';
    }

    // Get latest portfolio snapshot (CSV upload)
    try {
      const portfolioStartTime = Date.now();
      const portfolioParams = {
        TableName: 'PortfolioSnapshots',
        Limit: 10 // Get more items to find the latest
      };

      const portfolioResult = await dynamodb.scan(portfolioParams).promise();
      const portfolioTime = Date.now() - portfolioStartTime;
      console.log(`[API] Portfolio scan completed in ${portfolioTime}ms`);

      if (portfolioResult.Items && portfolioResult.Items.length > 0) {
        // Sort by snapshotDate descending to get most recent
        const latest = portfolioResult.Items.sort((a, b) => {
          const dateA = new Date(a.snapshotDate || a.createdAt || 0);
          const dateB = new Date(b.snapshotDate || b.createdAt || 0);
          return dateB - dateA;
        })[0];

        const latestDate = latest.snapshotDate || latest.createdAt;
        const isToday = latestDate && new Date(latestDate).toISOString().split('T')[0] === today;

        workflowStatus.csvUpload = {
          status: isToday ? 'success' : 'stale',
          lastUpload: latestDate,
          records: latest.totalHoldings || latest.holdings?.length || 0,
          fileName: latest.sourceFile || latest.fileName || 'N/A'
        };
      }
    } catch (csvError) {
      console.error('[API] Error fetching CSV upload status:', csvError);
      workflowStatus.csvUpload.status = 'error';
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/workflow-status completed in ${totalTime}ms`);
    res.json(workflowStatus);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/workflow-status after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch workflow status', details: error.message });
  }
});

// Hedgeye Screenshot endpoint - returns presigned S3 URL for screenshot
// UPDATED: Falls back to local files in aws/lambda if S3/DynamoDB fails
// Now supports ?type= query param for different data types
app.get('/api/hedgeye/screenshot/:date', async (req, res) => {
  const { date } = req.params;
  const snapshotType = req.query.type || 'risk-ranges'; // Default to risk-ranges
  console.log(`[API] /api/hedgeye/screenshot/${date}?type=${snapshotType} called`);

  try {
    // 1. Try DynamoDB + S3 first
    const snapshotParams = {
      TableName: 'HedgeyeDailySnapshot',
      Key: {
        date: date,
        snapshotType: snapshotType
      }
    };

    const snapshotResult = await dynamodb.get(snapshotParams).promise();

    // Always prefer PDF if available (for verification purposes)
    const preferPdf = true;

    if (snapshotResult.Item) {
      const hasPdf = snapshotResult.Item.pdfSource;
      const hasScreenshot = snapshotResult.Item.screenshotS3Key;

      // If we prefer PDF and have it, use it
      if (preferPdf && hasPdf) {
        const pdfS3Key = snapshotResult.Item.pdfSource;
        console.log(`[API] Using PDF (preferred) for ${snapshotType}: ${pdfS3Key}`);

        const params = {
          Bucket: 'market-dashboard-csv-data',
          Key: pdfS3Key,
          Expires: 3600 // 1 hour
        };

        try {
          const presignedUrl = s3.getSignedUrl('getObject', params);
          console.log(`[API] Generated presigned URL for PDF: ${pdfS3Key}`);
          return res.json({
            url: presignedUrl,
            s3Key: pdfS3Key,
            date: date,
            type: 'pdf',
            scrapedAt: snapshotResult.Item.scrapedAt
          });
        } catch (s3Error) {
          console.warn(`[API] PDF S3 signing failed, trying screenshot: ${s3Error.message}`);
          // Fall through to screenshot
        }
      }

      // Use screenshot if available
      if (hasScreenshot) {
        const s3Key = snapshotResult.Item.screenshotS3Key;

        // Generate presigned URL
        const params = {
          Bucket: 'market-dashboard-csv-data',
          Key: s3Key,
          Expires: 3600 // 1 hour
        };

        try {
          const presignedUrl = s3.getSignedUrl('getObject', params);
          console.log(`[API] Generated presigned URL for screenshot: ${s3Key}`);
          return res.json({
            url: presignedUrl,
            s3Key: s3Key,
            date: date,
            type: 'screenshot',
            scrapedAt: snapshotResult.Item.scrapedAt
          });
        } catch (s3Error) {
          console.warn(`[API] S3 signing failed, trying PDF fallback: ${s3Error.message}`);
          // Fall through to PDF check
        }
      }

      // Fallback to PDF if no screenshot or screenshot failed
      if (hasPdf) {
        const pdfS3Key = snapshotResult.Item.pdfSource;
        console.log(`[API] Fallback to PDF: ${pdfS3Key}`);

        const params = {
          Bucket: 'market-dashboard-csv-data',
          Key: pdfS3Key,
          Expires: 3600 // 1 hour
        };

        try {
          const presignedUrl = s3.getSignedUrl('getObject', params);
          console.log(`[API] Generated presigned URL for PDF: ${pdfS3Key}`);
          return res.json({
            url: presignedUrl,
            s3Key: pdfS3Key,
            date: date,
            type: 'pdf',
            scrapedAt: snapshotResult.Item.scrapedAt
          });
        } catch (s3Error) {
          console.warn(`[API] PDF S3 signing failed: ${s3Error.message}`);
          // Fall through to local check
        }
      }
    }

    console.log(`[API] No S3 key found in DynamoDB for ${date}/${snapshotType}, checking local files...`);

  } catch (error) {
    console.warn(`[API] DynamoDB/S3 error for screenshot: ${error.message}`);
    // Fall through to local check
  }

  // 2. Fallback: Check local aws/lambda directory for matching screenshot
  try {
    const fs = require('fs');
    const lambdaDir = path.join(__dirname, 'aws', 'lambda');

    if (fs.existsSync(lambdaDir)) {
      const files = fs.readdirSync(lambdaDir);
      // Look for hedgeye_screenshot_YYYY-MM-DD_HHMMSS.png
      const matchingFile = files.find(f =>
        f.startsWith(`hedgeye_screenshot_${date}`) && f.endsWith('.png')
      );

      if (matchingFile) {
        console.log(`[API] Found local screenshot: ${matchingFile}`);
        // Return a URL pointing to our local file server endpoint
        // Use full URL for robustness if needed, or relative
        const protocol = req.protocol;
        const host = req.get('host');
        const localUrl = `${protocol}://${host}/api/local-screenshots/${matchingFile}`;

        return res.json({
          url: localUrl,
          source: 'local',
          date: date
        });
      }
    }
  } catch (localError) {
    console.error(`[API] Error searching for local screenshot: ${localError.message}`);
  }

  return res.status(404).json({ error: 'Screenshot not found for this date (checked S3 and local)' });
});

// New Endpoint: Serve local screenshots from aws/lambda
app.get('/api/local-screenshots/:filename', (req, res) => {
  const { filename } = req.params;
  const fs = require('fs');

  // Basic security: ensure filename is safe and strictly what we expect
  if (!filename.match(/^hedgeye_screenshot_[\d-]{10}_[\d]{6}\.png$/)) {
    return res.status(400).send('Invalid filename format');
  }

  const filePath = path.join(__dirname, 'aws', 'lambda', filename);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Hedgeye CSV endpoint - returns presigned S3 URL for CSV
app.get('/api/hedgeye/csv/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const type = req.query.type || 'risk-ranges'; // Default to risk-ranges for backward compatibility
    console.log(`[API] /api/hedgeye/csv/${date}?type=${type} called`);

    // Get snapshot from DynamoDB
    const snapshotParams = {
      TableName: 'HedgeyeDailySnapshot',
      Key: {
        date: date,
        snapshotType: type
      }
    };

    const snapshotResult = await dynamodb.get(snapshotParams).promise();

    if (!snapshotResult.Item) {
      return res.status(404).json({ error: 'Snapshot not found for this date and type' });
    }

    // LIST OF COLUMNS FOR EACH TYPE
    const COLUMNS = {
      'risk-ranges': ['ticker', 'lrr', 'close', 'hrr', 'trend'],
      'momo-tracker': ['ticker', 'buyTrade', 'sellTrade', 'upside', 'downside', 'trend', 'index']
    };

    // If we have data but no pre-generated CSV in S3 (or if we want to enforce sorting),
    // convert JSON to CSV on the fly.
    // For Momo Tracker, we enforce on-the-fly generation to ensure correct sorting by 'index'.
    if (type === 'momo-tracker' || !snapshotResult.Item.csvS3Key) {
      console.log(`[API] Generating CSV on-the-fly for ${type}`);
      const data = snapshotResult.Item.data || {};

      let items = [];
      if (type === 'momo-tracker') {
        items = Object.entries(data).map(([ticker, info]) => ({
          ticker,
          ...info,
          // Ensure numbers are formatted nicely
          buyTrade: parseFloat(info.buyTrade || 0).toFixed(2),
          sellTrade: parseFloat(info.sellTrade || 0).toFixed(2),
          upside: parseFloat(info.upside || 0).toFixed(2) + '%',
          downside: parseFloat(info.downside || 0).toFixed(2) + '%',
          index: info.index ?? 999
        }));

        // Sort by index
        items.sort((a, b) => a.index - b.index);
      } else if (type === 'risk-ranges') {
        // Fallback logic for risk-ranges if needed
        items = Object.entries(data).map(([ticker, info]) => ({
          ticker,
          ...info
        }));
      }

      if (items.length === 0) {
        return res.status(404).json({ error: 'No data available to generate CSV' });
      }

      // Generate CSV string
      const headers = COLUMNS[type] || Object.keys(items[0]);
      const csvHeader = headers.join(',');
      const csvRows = items.map(item => {
        return headers.map(header => {
          // Handle special cases or generic string
          let val = item[header];
          if (val === undefined || val === null) val = '';
          return `"${val}"`;
        }).join(',');
      });

      const csvContent = [csvHeader, ...csvRows].join('\n');

      // Send as file download
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="hedgeye_${type}_${date}.csv"`);
      return res.send(csvContent);
    }

    // Default behavior: Redirect to S3 presigned URL (for existing risk-ranges files)
    const s3Key = snapshotResult.Item.csvS3Key;

    // Generate presigned URL (1 hour expiration)
    const params = {
      Bucket: 'market-dashboard-csv-data',
      Key: s3Key,
      Expires: 3600, // 1 hour
      ResponseContentDisposition: `attachment; filename="hedgeye_${type}_${date}.csv"`
    };

    const presignedUrl = s3.getSignedUrl('getObject', params);

    console.log(`[API] Generated presigned URL for CSV: ${s3Key}`);
    res.json({
      url: presignedUrl,
      s3Key: s3Key,
      date: date,
      scrapedAt: snapshotResult.Item.scrapedAt
    });

  } catch (error) {
    console.error('[API] Error in /api/hedgeye/csv:', error);
    res.status(500).json({ error: 'Failed to get CSV URL', details: error.message });
  }
});

// Hedgeye Snapshot Data endpoint - returns full extracted data for any snapshot type
app.get('/api/hedgeye/snapshot/:snapshotType', async (req, res) => {
  const startTime = Date.now();
  const { snapshotType } = req.params;
  const date = req.query.date; // Optional date, defaults to latest

  console.log(`[API] /api/hedgeye/snapshot/${snapshotType}?date=${date} called`);

  try {
    let item = null;

    if (date) {
      // Fetch specific date
      const params = {
        TableName: 'HedgeyeDailySnapshot',
        Key: { date: date, snapshotType: snapshotType }
      };
      const result = await dynamodb.get(params).promise();
      item = result.Item;
    } else {
      // Find latest by scanning last 7 days
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

        const params = {
          TableName: 'HedgeyeDailySnapshot',
          Key: { date: dateStr, snapshotType: snapshotType }
        };
        const result = await dynamodb.get(params).promise();
        if (result.Item) {
          item = result.Item;
          break;
        }
      }
    }

    if (!item) {
      return res.status(404).json({ error: 'Snapshot not found', snapshotType, date });
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hedgeye/snapshot/${snapshotType} completed in ${totalTime}ms`);

    res.json({
      date: item.date,
      snapshotType: snapshotType,
      scrapedAt: item.scrapedAt,
      data: item.data,
      trendChanges: item.trendChanges,
      outbucket: item.outbucket,
      meta: {
        riskRangeCount: item.riskRangeCount,
        stockCount: item.stockCount,
        cryptoCount: item.cryptoCount,
        rankingCount: item.rankingCount
      },
      pdfSource: item.pdfSource,
      screenshotS3Key: item.screenshotS3Key
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hedgeye/snapshot/${snapshotType} after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch snapshot', details: error.message });
  }
});

// Hedgeye Changelog endpoint - returns added/removed items for each data type
app.get('/api/hedgeye/changelog', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/hedgeye/changelog called');

    // First, fetch Risk Ranges for today (or latest) to use for cross-referencing
    // Users often view "Early Look" and "Risk Ranges" as shared data, so if a ticker
    // is missing from Early Look but present in Risk Ranges, we shouldn't mark it as "Removed".
    let activeTickers = [];
    try {
      const rrParams = {
        TableName: 'HedgeyeDailySnapshot',
        KeyConditionExpression: 'snapshotType = :type',
        ExpressionAttributeValues: { ':type': 'risk-ranges' },
        Limit: 1,
        ScanIndexForward: false
      };
      // We can't query by snapshotType easily without index, so we'll just rely on the main loop 
      // to populate this if we process risk-ranges first, or just do a quick scan for today's RR.
      const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
      // Format YYYY-MM-DD
      const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      const rrItem = await dynamodb.get({
        TableName: 'HedgeyeDailySnapshot',
        Key: { date: todayISO, snapshotType: 'risk-ranges' }
      }).promise();

      if (rrItem.Item && rrItem.Item.data) {
        activeTickers = Object.keys(rrItem.Item.data);
      }
    } catch (e) {
      console.warn('Failed to pre-fetch risk ranges for changelog xref:', e);
    }

    const snapshotTypes = [
      'risk-ranges',
      'early-look',
      'bitcoin-trend-tracker',
      'momo-tracker',
      'signal-strength',
      'portfolio-solutions'
    ];

    const results = {};

    // Process each type in parallel
    await Promise.all(snapshotTypes.map(async (type) => {
      try {
        // 1. Get recent snapshots for this type (last 7 days)
        const recentSnapshots = [];
        for (let i = 0; i < 7; i++) {
          if (recentSnapshots.length >= 2) break;

          const date = new Date();
          date.setDate(date.getDate() - i);
          const dateStr = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD in EST

          const item = await dynamodb.get({
            TableName: 'HedgeyeDailySnapshot',
            Key: { date: dateStr, snapshotType: type }
          }).promise();

          if (item.Item) {
            recentSnapshots.push(item.Item);
          }
        }

        // Sort snapshots: 
        // 1. Newest Date first
        // 2. If same date, prefer 'risk-ranges' over 'early-look' (as it's more complete)
        recentSnapshots.sort((a, b) => {
          const dateA = new Date(a.date);
          const dateB = new Date(b.date);
          if (dateB - dateA !== 0) return dateB - dateA;

          // Same date: prefer risk-ranges (priority 1) over early-look (priority 0)
          const priorityA = a.snapshotType === 'risk-ranges' ? 1 : 0;
          const priorityB = b.snapshotType === 'risk-ranges' ? 1 : 0;
          return priorityB - priorityA;
        });

        // De-duplicate dates - keep only the highest priority snapshot for each date
        const uniqueSnapshots = [];
        const seenDates = new Set();

        for (const snap of recentSnapshots) {
          if (!seenDates.has(snap.date)) {
            uniqueSnapshots.push(snap);
            seenDates.add(snap.date);
          }
          if (uniqueSnapshots.length >= 2) break;
        }

        if (recentSnapshots.length < 2) {
          results[type] = { added: [], removed: [], available: recentSnapshots.length > 0 };
          return;
        }

        const current = recentSnapshots[0];
        const previous = recentSnapshots[1];

        // Debug logging for risk-ranges
        if (type === 'risk-ranges') {
          console.log('[Changelog] risk-ranges current snapshot keys:', Object.keys(current));
          console.log('[Changelog] Has trendChanges?', 'trendChanges' in current);
          console.log('[Changelog] trendChanges value:', current.trendChanges);
        }

        // Extract items based on type
        const getItems = (snapshot) => {
          if (!snapshot || !snapshot.data) return [];

          if (type === 'risk-ranges' || type === 'momo-tracker') {
            return Object.keys(snapshot.data);
          } else if (type === 'early-look') {
            if (snapshot.data) return Object.keys(snapshot.data);
            return [];
          } else if (type === 'bitcoin-trend-tracker') {
            const cryptos = snapshot.data.cryptos ? Object.keys(snapshot.data.cryptos) : [];
            const stocks = snapshot.data.stocks ? Object.keys(snapshot.data.stocks) : [];
            return [...cryptos, ...stocks];
          } else if (type === 'signal-strength') {
            return (snapshot.data.stocks || []).map(s => s.ticker);
          } else if (type === 'portfolio-solutions') {
            return (snapshot.data.rankings || []).map(r => r.ticker);
          }
          return [];
        };

        const currentItems = getItems(current);
        const previousItems = getItems(previous);

        const added = currentItems.filter(item => !previousItems.includes(item));
        let removed = previousItems.filter(item => !currentItems.includes(item));

        // Updates logic (Trend Changes)
        let updates = [];
        if (current.data && previous.data) {
          // Trend Changes: Risk Ranges, Momo, Bitcoin
          if (type === 'risk-ranges' || type === 'momo-tracker' || type === 'bitcoin-trend-tracker') {
            const commonItems = currentItems.filter(item => previousItems.includes(item));

            commonItems.forEach(item => {
              let currData, prevData;

              if (type === 'bitcoin-trend-tracker') {
                // Check cryptos
                if (current.data.cryptos && current.data.cryptos[item]) currData = current.data.cryptos[item];
                else if (current.data.stocks && current.data.stocks[item]) currData = current.data.stocks[item];

                if (previous.data.cryptos && previous.data.cryptos[item]) prevData = previous.data.cryptos[item];
                else if (previous.data.stocks && previous.data.stocks[item]) prevData = previous.data.stocks[item];
              } else {
                currData = current.data[item];
                prevData = previous.data[item];
              }

              if (currData && prevData && currData.trend && prevData.trend) {
                if (currData.trend !== prevData.trend) {
                  updates.push({
                    ticker: item,
                    field: 'trend',
                    oldValue: prevData.trend,
                    newValue: currData.trend
                  });
                }
              }
            });
          }

          // Rank Changes: Portfolio Solutions
          if (type === 'portfolio-solutions') {
            const getRank = (snapshot, ticker) => {
              if (!snapshot.data || !snapshot.data.rankings) return null;
              const entry = snapshot.data.rankings.find(r => r.ticker === ticker);
              return entry ? entry.rank : null;
            };

            const commonItems = currentItems.filter(item => previousItems.includes(item));
            commonItems.forEach(ticker => {
              const currRank = getRank(current, ticker);
              const prevRank = getRank(previous, ticker);

              if (currRank && prevRank && currRank !== prevRank) {
                updates.push({
                  ticker: ticker,
                  field: 'rank',
                  oldValue: prevRank,
                  newValue: currRank
                });
              }
            });
          }

          // Explicit Added/Removed for Signal Strength (if available)
          if (type === 'signal-strength') {
            if (current.data.added && Array.isArray(current.data.added) && current.data.added.length > 0) {
              // Since the PDF explicitly lists "Added", we trust that as the definitive source for additions
              // The diff method might pick up noise or re-ordering
              // Note: We need to manipulate 'added' and 'removed' variables which are in scope
              // We empty the calculated arrays and push the explicit ones
              added.length = 0;
              current.data.added.forEach(t => { if (t) added.push(t) });
            }

            if (current.data.removed && Array.isArray(current.data.removed) && current.data.removed.length > 0) {
              removed.length = 0;
              current.data.removed.forEach(t => { if (t) removed.push(t) });
            }
          }
        }

        // SPECIAL LOGIC: For 'early-look', if a removed item exists in today's 'risk-ranges', 
        // ignore the removal. This handles cases where a partial file (like Geopolitical Risk) 
        // was uploaded instead of the full Early Look, but the data exists elsewhere.
        if (type === 'early-look' && activeTickers.length > 0) {
          removed = removed.filter(item => !activeTickers.includes(item));
        }

        results[type] = {
          added: added,
          removed: removed,
          updates: updates || [],
          currentDate: current.date,
          previousDate: previous.date,
          available: true
        };

        // Add trendChanges and outbucket from snapshot for risk-ranges
        if (type === 'risk-ranges') {
          if (current.trendChanges) {
            console.log('[Changelog] Adding trendChanges to risk-ranges:', current.trendChanges.length, 'items');
            results[type].trendChanges = current.trendChanges;
          } else {
            console.log('[Changelog] No trendChanges found for risk-ranges');
          }

          // Pass through raw lists for reference (optional, or just rely on diffs)
          results[type].outbucketList = current.outbucket || [];

          // Helper to normalize OutBucket items to display strings 
          const normalizeOutbucketItem = (item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
              // Format: "Name (TICKER) - TREND"
              const name = item.name || 'Unknown';
              const ticker = item.ticker || item.symbol || '';
              const trend = item.trend || '';
              if (ticker) return `${name} (${ticker}) - ${trend}`;
              return name;
            }
            return String(item);
          };

          // Helper to extract ticker for comparison
          const extractTicker = (item) => {
            if (typeof item === 'string') {
              const match = item.match(/\(([^)]+)\)/);
              return match ? match[1] : item;
            }
            if (item && typeof item === 'object') {
              return item.ticker || item.symbol || JSON.stringify(item);
            }
            return String(item);
          };

          // Compare OutBucket lists to find Added/Removed
          if (current.outbucket && previous.outbucket) {
            const currOut = current.outbucket.map(extractTicker);
            const prevOut = previous.outbucket.map(extractTicker);

            // Filter for added/removed, then normalize for display
            const addedOut = current.outbucket
              .filter(item => !prevOut.includes(extractTicker(item)))
              .map(normalizeOutbucketItem);
            const removedOut = previous.outbucket
              .filter(item => !currOut.includes(extractTicker(item)))
              .map(normalizeOutbucketItem);

            results[type].outbucketDiff = {
              added: addedOut,
              removed: removedOut
            };
          } else if (current.outbucket) {
            // If previous has no outbucket, everything is new (or just initialization)
            results[type].outbucketDiff = {
              added: current.outbucket.map(normalizeOutbucketItem),
              removed: []
            };
          } else {
            results[type].outbucketDiff = { added: [], removed: [] };
          }
        }

        // Calculate trendChanges for early-look by comparing trends
        if (type === 'early-look') {
          const trendChanges = [];

          if (current.data && previous.data) {
            Object.keys(current.data).forEach(ticker => {
              const currData = current.data[ticker];
              const prevData = previous.data[ticker];

              if (prevData && currData.trend !== prevData.trend) {
                trendChanges.push({
                  ticker,
                  oldTrend: prevData.trend,
                  newTrend: currData.trend
                });
              }
            });
          }

          console.log('[Changelog] Calculated trendChanges for early-look:', trendChanges.length, 'items');
          results[type].trendChanges = trendChanges;
        }

      } catch (err) {
        console.error(`Error processing changelog for ${type}:`, err);
        results[type] = { error: err.message, available: false };
      }
    }));

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hedgeye/changelog completed in ${totalTime}ms`);
    res.json(results);

  } catch (error) {
    console.error('[API] Error in /api/hedgeye/changelog:', error);
    res.status(500).json({ error: 'Failed to fetch changelog', details: error.message });
  }
});


app.get('/api/macro-indicators', async (req, res) => {
  const startTime = Date.now();
  try {
    const macroIndicators = ['DXY', 'GLD', 'UST10Y', 'CRB', 'WTI', 'SPY', 'QQQ', 'IWM'];
    console.log(`[API] /api/macro-indicators called for ${macroIndicators.length} indicators`);

    const indicators = {};

    // Process in batches to avoid rate limiting
    const BATCH_SIZE = 5;
    const DELAY_MS = 200;

    const fetchStartTime = Date.now();
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
    const fetchTime = Date.now() - fetchStartTime;
    console.log(`[API] Macro indicators fetching completed in ${fetchTime}ms`);

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

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/macro-indicators completed: ${successCount} indicators out of ${macroIndicators.length} requested in ${totalTime}ms`);
    res.json(indicators);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/macro-indicators after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch macro indicators' });
  }
});

// Multi-Region Quotes endpoint - fetches quotes and sparklines for all regions
app.get('/api/multi-region-quotes', async (req, res) => {
  const startTime = Date.now();
  try {
    const { regions, includeSparklines = 'true' } = req.query;
    const requestedRegions = regions ? regions.split(',') : Object.keys(MARKET_REGIONS);

    console.log(`[API] /api/multi-region-quotes called for regions: ${requestedRegions.join(', ')}, sparklines: ${includeSparklines}`);

    const results = {};

    for (const regionKey of requestedRegions) {
      const region = MARKET_REGIONS[regionKey];
      if (!region) {
        console.warn(`[API] Unknown region: ${regionKey}`);
        continue;
      }

      console.log(`[API] Fetching ${region.indices.length} indices for ${regionKey}...`);

      // Fetch quotes for all indices in this region in parallel
      const quotes = await Promise.all(
        region.indices.map(async (index) => {
          try {
            // Use yahooSymbol or fredSymbol as appropriate
            const symbol = index.yahooSymbol || index.fredSymbol;
            const quote = await getQuote(symbol);

            // Fetch sparkline data if requested (default: true)
            let sparklineData = [];
            if (includeSparklines === 'true' && index.yahooSymbol) {
              // Only fetch sparklines for Yahoo symbols (not FRED)
              sparklineData = await getIntradayData(symbol);
            }

            return {
              symbol: index.symbol,
              name: index.name,
              price: quote?.price || null,
              change: quote?.change || null,
              changePercent: quote?.changePercent || null,
              timestamp: quote?.timestamp || new Date().toISOString(),
              sparklineData
            };
          } catch (error) {
            console.error(`[API] Error fetching ${index.symbol}:`, error.message);
            return {
              symbol: index.symbol,
              name: index.name,
              price: null,
              error: 'Failed to fetch quote'
            };
          }
        })
      );

      results[regionKey] = quotes;
      console.log(`[API] Completed ${regionKey}: ${quotes.length} quotes fetched`);
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/multi-region-quotes completed in ${totalTime}ms`);
    res.json(results);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/multi-region-quotes after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch multi-region quotes' });
  }
});

// Helper function to fetch FRED historical data
async function fetchFredHistoricalData(seriesId, months = 7) {
  try {
    const apiKey = process.env.FRED_API_KEY || '';
    if (!apiKey) {
      console.warn(`[FRED] Warning: FRED_API_KEY environment variable is not set.`);
      return null;
    }

    // Calculate date range (need extra month for safety)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const url = 'https://api.stlouisfed.org/fred/series/observations';
    const params = {
      series_id: seriesId,
      api_key: apiKey,
      file_type: 'json',
      observation_start: startDate.toISOString().split('T')[0],
      observation_end: endDate.toISOString().split('T')[0],
      sort_order: 'asc'
    };

    console.log(`[FRED] Fetching historical data for: ${seriesId} (${months} months)`);

    const response = await axios.get(url, {
      params,
      timeout: 15000
    });

    const data = response.data;

    if (data.observations && data.observations.length > 0) {
      // Filter out missing values and convert to numbers
      const validObservations = data.observations
        .filter(obs => obs.value && obs.value !== '.')
        .map(obs => ({
          date: obs.date,
          value: parseFloat(obs.value)
        }));

      console.log(`[FRED] Successfully fetched ${validObservations.length} observations for ${seriesId}`);
      return validObservations;
    }

    return null;
  } catch (error) {
    console.error(`[FRED] Error fetching historical data for ${seriesId}:`, error.message);
    return null;
  }
}

// Calculate annualized rate of change
function calculateAnnualizedROC(currentValue, pastValue, months) {
  if (!currentValue || !pastValue || pastValue <= 0) {
    return null;
  }

  const ratio = currentValue / pastValue;
  const periodsPerYear = 12 / months;
  const annualizedROC = (Math.pow(ratio, periodsPerYear) - 1) * 100;

  return annualizedROC;
}

// Get value N months ago from observations
function getValueMonthsAgo(observations, months) {
  if (!observations || observations.length === 0) {
    return null;
  }

  // Sort by date descending (most recent first)
  const sorted = [...observations].sort((a, b) => new Date(b.date) - new Date(a.date));

  if (sorted.length === 0) {
    return null;
  }

  // Get the most recent value
  const currentDate = new Date(sorted[0].date);
  const targetDate = new Date(currentDate);
  targetDate.setMonth(targetDate.getMonth() - months);

  // Find the closest observation to target date
  let closest = null;
  let minDiff = Infinity;

  for (const obs of sorted) {
    const obsDate = new Date(obs.date);
    const diff = Math.abs(obsDate - targetDate);

    if (diff < minDiff && obsDate <= targetDate) {
      minDiff = diff;
      closest = obs.value;
    }
  }

  // If no observation before target date, use the oldest available
  if (closest === null && sorted.length > 0) {
    closest = sorted[sorted.length - 1].value;
  }

  return closest;
}

// Liquidity Indicators endpoint
app.get('/api/liquidity-indicators', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/liquidity-indicators called');

    // Fetch MZM (Money Zero Maturity) and GDP data
    const fredStartTime = Date.now();
    const [mzmData, gdpData] = await Promise.all([
      fetchFredHistoricalData('MZM', 7), // Need 7 months for 6m calculation
      fetchFredHistoricalData('GDP', 7)  // GDP is quarterly, but we'll use last available
    ]);
    const fredTime = Date.now() - fredStartTime;
    console.log(`[API] FRED data fetching completed in ${fredTime}ms`);

    if (!mzmData || mzmData.length === 0) {
      return res.status(500).json({ error: 'Failed to fetch MZM data from FRED' });
    }

    // Get current and historical values for MZM
    const sortedMzm = [...mzmData].sort((a, b) => new Date(b.date) - new Date(a.date));
    const currentMzm = sortedMzm[0].value;
    const mzm1m = getValueMonthsAgo(mzmData, 1);
    const mzm3m = getValueMonthsAgo(mzmData, 3);
    const mzm6m = getValueMonthsAgo(mzmData, 6);

    // Calculate M3 Proxy (MZM) 1m annualized growth
    const m3Proxy1m = calculateAnnualizedROC(currentMzm, mzm1m, 1);

    // Calculate Money Supply ROC for different periods
    const moneySupplyROC1m = calculateAnnualizedROC(currentMzm, mzm1m, 1);
    const moneySupplyROC3m = calculateAnnualizedROC(currentMzm, mzm3m, 3);
    const moneySupplyROC6m = calculateAnnualizedROC(currentMzm, mzm6m, 6);

    // Handle GDP (quarterly data)
    let gdpROC1m = null;
    let gdpROC3m = null;
    let gdpROC6m = null;

    if (gdpData && gdpData.length > 0) {
      const sortedGdp = [...gdpData].sort((a, b) => new Date(b.date) - new Date(a.date));
      const currentGdp = sortedGdp[0].value;

      // For GDP, we'll use the last available quarterly value for all periods
      // since it's quarterly data, we approximate monthly changes
      // Get the most recent quarter and the quarter from ~3 months ago
      const gdp3m = getValueMonthsAgo(gdpData, 3);
      const gdp6m = getValueMonthsAgo(gdpData, 6);

      // For 1m, we'll use the same value as 3m (since GDP is quarterly)
      // Or calculate based on 3m if we have it
      if (gdp3m) {
        gdpROC1m = calculateAnnualizedROC(currentGdp, gdp3m, 3); // Use 3m for 1m approximation
        gdpROC3m = calculateAnnualizedROC(currentGdp, gdp3m, 3);
      }

      if (gdp6m) {
        gdpROC6m = calculateAnnualizedROC(currentGdp, gdp6m, 6);
      }
    }

    // Calculate spreads (Money Supply ROC - GDP ROC)
    const spread1m = moneySupplyROC1m !== null && gdpROC1m !== null
      ? moneySupplyROC1m - gdpROC1m
      : null;
    const spread3m = moneySupplyROC3m !== null && gdpROC3m !== null
      ? moneySupplyROC3m - gdpROC3m
      : null;
    const spread6m = moneySupplyROC6m !== null && gdpROC6m !== null
      ? moneySupplyROC6m - gdpROC6m
      : null;

    const result = {
      m3Proxy: {
        value: m3Proxy1m !== null ? parseFloat(m3Proxy1m.toFixed(1)) : null,
        period: '1m',
        timestamp: new Date().toISOString()
      },
      moneySupplyVsGDP: {
        '1m': {
          moneySupplyROC: moneySupplyROC1m !== null ? parseFloat(moneySupplyROC1m.toFixed(1)) : null,
          gdpROC: gdpROC1m !== null ? parseFloat(gdpROC1m.toFixed(1)) : null,
          spread: spread1m !== null ? parseFloat(spread1m.toFixed(1)) : null
        },
        '3m': {
          moneySupplyROC: moneySupplyROC3m !== null ? parseFloat(moneySupplyROC3m.toFixed(1)) : null,
          gdpROC: gdpROC3m !== null ? parseFloat(gdpROC3m.toFixed(1)) : null,
          spread: spread3m !== null ? parseFloat(spread3m.toFixed(1)) : null
        },
        '6m': {
          moneySupplyROC: moneySupplyROC6m !== null ? parseFloat(moneySupplyROC6m.toFixed(1)) : null,
          gdpROC: gdpROC6m !== null ? parseFloat(gdpROC6m.toFixed(1)) : null,
          spread: spread6m !== null ? parseFloat(spread6m.toFixed(1)) : null
        }
      },
      timestamp: new Date().toISOString()
    };

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/liquidity-indicators completed in ${totalTime}ms (FRED: ${fredTime}ms)`);
    res.json(result);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/liquidity-indicators after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch liquidity indicators', details: error.message });
  }
});

// Signal Strength Rankings Endpoint
app.get('/api/securities/signal-strength', async (req, res) => {
  const startTime = Date.now();
  try {
    // For now, we'll fetch from DynamoDB MarketPriceHistory table
    // Get all unique symbols from the table
    const scanStartTime = Date.now();
    const scanParams = {
      TableName: 'MarketPriceHistory',
      ProjectionExpression: 'symbol'
    };

    const scanResult = await dynamodb.scan(scanParams).promise();
    const scanTime = Date.now() - scanStartTime;
    console.log(`[API] Signal strength scan completed in ${scanTime}ms, found ${scanResult.Items.length} items`);
    const uniqueSymbols = [...new Set(scanResult.Items.map(item => item.symbol))];

    // If no data in DynamoDB, return empty array (frontend will use fallback)
    if (uniqueSymbols.length === 0) {
      return res.json([]);
    }

    // Fetch latest market data from DynamoDB for all securities
    const today = new Date().toISOString().split('T')[0];
    const securitiesData = [];

    // For each symbol, get latest market data
    const queryStartTime = Date.now();
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

    const queryTime = Date.now() - queryStartTime;
    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/securities/signal-strength completed: ${rankedSecurities.length} securities (scan: ${scanTime}ms, queries: ${queryTime}ms, total: ${totalTime}ms)`);
    res.json(rankedSecurities);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/securities/signal-strength after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch signal strength rankings' });
  }
});

// Get real portfolio data from DynamoDB
app.get('/api/portfolio', async (req, res) => {
  const startTime = Date.now();
  try {
    // Get latest portfolio snapshot - scan all and sort by timestamp
    const snapshotStartTime = Date.now();
    const snapshotParams = {
      TableName: 'PortfolioSnapshots'
    };

    const snapshotResult = await dynamodb.scan(snapshotParams).promise();
    const snapshotTime = Date.now() - snapshotStartTime;
    console.log(`[API] Portfolio snapshot scan completed in ${snapshotTime}ms, found ${snapshotResult.Items.length} items`);

    // Sort by timestamp descending to get the latest record
    const sortedItems = snapshotResult.Items.sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    );

    if (!sortedItems || sortedItems.length === 0) {
      const totalTime = Date.now() - startTime;
      console.log(`[API] /api/portfolio completed (no data) in ${totalTime}ms`);
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
    const holdingsStartTime = Date.now();
    const holdingsParams = {
      TableName: 'Holdings',
      FilterExpression: 'snapshotId = :snapshotId',
      ExpressionAttributeValues: {
        ':snapshotId': snapshotId
      }
    };

    const holdingsResult = await dynamodb.scan(holdingsParams).promise();
    const holdingsTime = Date.now() - holdingsStartTime;
    console.log(`[API] Holdings scan completed in ${holdingsTime}ms, found ${holdingsResult.Items.length} holdings`);
    const holdings = holdingsResult.Items || [];

    // Fetch real-time quotes for all holdings to get intraday G/L
    const quotesStartTime = Date.now();
    const symbols = holdings.map(h => h.symbol).filter(Boolean);
    let quotes = {};

    if (symbols.length > 0) {
      try {
        const BATCH_SIZE = 5;
        const DELAY_MS = 200;
        const quoteResults = await batchProcess(
          symbols,
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

        symbols.forEach((symbol, index) => {
          const quote = quoteResults[index];
          if (quote && quote.changePercent) {
            quotes[symbol.toUpperCase()] = quote;
          }
        });

        const quotesTime = Date.now() - quotesStartTime;
        console.log(`[API] Quotes fetched for ${Object.keys(quotes).length} holdings in ${quotesTime}ms`);
      } catch (error) {
        console.error(`[API] Error fetching quotes for holdings:`, error.message);
        // Continue without quotes - holdings will have null dayChangePercent
      }
    }

    // Transform to frontend format
    const portfolioData = {
      summary: {
        totalValue: latestSnapshot.summary?.totalValue || 0,
        totalDayChange: latestSnapshot.summary?.totalDayChange || 0,
        totalDayChangePercent: latestSnapshot.summary?.totalDayChangePercent || '0.00',
        totalGainLoss: latestSnapshot.summary?.totalGainLoss || 0,
        totalGainLossPercent: latestSnapshot.summary?.totalGainLossPercent || '0.00',
        totalGainLossPercent: latestSnapshot.summary?.totalGainLossPercent || '0.00',
        positionCount: latestSnapshot.summary?.positionCount || holdings.length,
        longCount: latestSnapshot.summary?.longCount || 0,
        shortCount: latestSnapshot.summary?.shortCount || 0
      },
      assetAllocation: latestSnapshot.assetAllocation || {},
      // Include full holdings array for PortfolioBreakdown component
      holdings: holdings.map(holding => {
        const symbolUpper = holding.symbol?.toUpperCase();
        const quote = quotes[symbolUpper] || null;
        // dayChangePercent comes from real-time quotes API (intraday change)
        const dayChangePercent = quote?.changePercent ? parseFloat(quote.changePercent) : null;

        return {
          symbol: holding.symbol,
          description: holding.description || '',
          quantity: holding.quantity || 0,
          price: holding.price || 0,
          marketValue: holding.marketValue || 0,
          costBasis: holding.costBasis || 0,
          gainLoss: holding.gainLoss || 0,
          gainLossPercent: holding.gainLossPercent || 0,
          dayChangePercent: dayChangePercent, // Intraday G/L from real-time market prices
          assetType: holding.assetType || '',
          assetClass: holding.assetClass || ''
        };
      }),
      // Keep topHoldings for summary views
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

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/portfolio completed in ${totalTime}ms (snapshot: ${snapshotTime}ms, holdings: ${holdingsTime}ms)`);
    res.json(portfolioData);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/portfolio after ${totalTime}ms:`, error);
    res.status(500).json({
      error: 'Failed to fetch portfolio data',
      details: error.message
    });
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
  const startTime = Date.now();
  try {
    const dbStartTime = Date.now();

    // Try query by calculationDate first (more efficient than scan)
    // Get today's date and try recent dates in descending order
    const today = new Date().toISOString().split('T')[0];
    let latest = null;

    // Try today, yesterday, and up to 7 days ago
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      try {
        const params = {
          TableName: 'USDCorrelations',
          Key: {
            calculationDate: dateStr
          }
        };

        const result = await dynamodb.get(params).promise();
        if (result.Item) {
          latest = result.Item;
          break;
        }
      } catch (err) {
        // Continue to next date
        continue;
      }
    }

    // Fallback to scan if query didn't find anything
    if (!latest) {
      const scanParams = {
        TableName: 'USDCorrelations',
        Limit: 1
      };

      const scanResult = await dynamodb.scan(scanParams).promise();
      if (scanResult.Items && scanResult.Items.length > 0) {
        // Sort by calculationDate descending
        latest = scanResult.Items.sort((a, b) => {
          const dateA = new Date(a.calculationDate || 0);
          const dateB = new Date(b.calculationDate || 0);
          return dateB - dateA;
        })[0];
      }
    }

    const dbTime = Date.now() - dbStartTime;
    console.log(`[API] USD correlations query completed in ${dbTime}ms`);

    if (!latest) {
      const totalTime = Date.now() - startTime;
      console.log(`[API] /api/usd/correlations completed (no data) in ${totalTime}ms`);
      return res.json({
        correlations: null,
        rollingStats: null,
        timestamp: null,
        message: 'No correlation data available'
      });
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/usd/correlations completed in ${totalTime}ms (DB: ${dbTime}ms)`);
    res.json({
      correlations: latest.correlations,
      rollingStats: latest.rollingStats,
      timestamp: latest.timestamp,
      calculationDate: latest.calculationDate
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/usd/correlations after ${totalTime}ms:`, error);
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
  const startTime = Date.now();
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

    const dbStartTime = Date.now();
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
    const dbTime = Date.now() - dbStartTime;
    console.log(`[API] Historical data query for ${normalizedSymbol} completed in ${dbTime}ms, found ${result.Items.length} items`);

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
              const responseData = {
                symbol: decodedSymbol,
                data: trimmedData,
                count: trimmedData.length
              };

              // Store in cache (even for Yahoo Finance fallback)
              historicalCache.set(cacheKey, {
                data: responseData,
                timestamp: now
              });

              console.log(`Fetched ${trimmedData.length} data points from Yahoo Finance for ${normalizedSymbol} (original: ${decodedSymbol})`);
              return res.json(responseData);
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

    const responseData = {
      symbol: decodedSymbol,
      data: historicalData,
      count: historicalData.length
    };

    // Store in cache
    historicalCache.set(cacheKey, {
      data: responseData,
      timestamp: now
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/usd/historical completed: ${historicalData.length} data points for ${normalizedSymbol} (original: ${decodedSymbol}, requested ${days} days) in ${totalTime}ms (DB: ${dbTime}ms)`);

    res.json(responseData);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    const symbolParam = req.query.symbol || 'unknown';
    console.error(`[API] Error in /api/usd/historical for ${symbolParam} after ${totalTime}ms:`, error);
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
