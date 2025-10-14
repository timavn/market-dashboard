const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');
const AWS = require('aws-sdk');

const app = express();
const PORT = process.env.PORT || 3001;

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
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Fixed mock market data (no randomness)
const FIXED_QUOTES = {
  SPY: { symbol: 'SPY', price: '454.70', change: '0.00', changePercent: '0.00', volume: 140591, high: '455.00', low: '452.00', open: '454.00', timestamp: new Date().toISOString() },
  QQQ: { symbol: 'QQQ', price: '171.41', change: '0.00', changePercent: '0.00', volume: 767854, high: '172.00', low: '170.00', open: '171.00', timestamp: new Date().toISOString() },
  AAPL: { symbol: 'AAPL', price: '289.18', change: '0.00', changePercent: '0.00', volume: 167018, high: '290.00', low: '288.00', open: '289.00', timestamp: new Date().toISOString() },
  TSLA: { symbol: 'TSLA', price: '221.36', change: '0.00', changePercent: '0.00', volume: 453877, high: '223.00', low: '220.00', open: '221.00', timestamp: new Date().toISOString() },
  NVDA: { symbol: 'NVDA', price: '217.03', change: '0.00', changePercent: '0.00', volume: 1081837, high: '218.00', low: '216.00', open: '217.00', timestamp: new Date().toISOString() },
  MSFT: { symbol: 'MSFT', price: '335.12', change: '0.00', changePercent: '0.00', volume: 512345, high: '336.00', low: '334.00', open: '335.00', timestamp: new Date().toISOString() },
  GOOGL: { symbol: 'GOOGL', price: '128.45', change: '0.00', changePercent: '0.00', volume: 234567, high: '129.00', low: '128.00', open: '128.00', timestamp: new Date().toISOString() },
  AMZN: { symbol: 'AMZN', price: '142.90', change: '0.00', changePercent: '0.00', volume: 345678, high: '143.50', low: '142.00', open: '142.50', timestamp: new Date().toISOString() }
};

const generateMockData = () => ({ ...FIXED_QUOTES });

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

// Fixed VIX data
const generateVIXData = () => ({
  current: '18.42',
  change: '0.00',
  changePercent: '0.00',
  timestamp: new Date().toISOString()
});

// API Routes
app.get('/api/quotes', (req, res) => {
  const symbols = req.query.symbols ? req.query.symbols.split(',') : ['SPY', 'QQQ', 'AAPL'];
  const data = generateMockData();
  const filteredData = {};
  
  symbols.forEach(symbol => {
    if (data[symbol]) {
      filteredData[symbol] = data[symbol];
    }
  });
  
  res.json(filteredData);
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

app.get('/api/options', (req, res) => {
  res.json(generateOptionsData());
});

app.get('/api/indicators/vix', (req, res) => {
  res.json(generateVIXData());
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

// Get historical price data for a specific symbol
app.get('/api/usd/historical/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { days = 30 } = req.query; // Default to 30 days
    
    const params = {
      TableName: 'MarketPriceHistory',
      KeyConditionExpression: 'symbol = :symbol',
      ExpressionAttributeValues: {
        ':symbol': symbol.toUpperCase()
      },
      ScanIndexForward: false, // Sort by date descending
      Limit: parseInt(days)
    };
    
    const result = await dynamodb.query(params).promise();
    
    if (!result.Items || result.Items.length === 0) {
      return res.json({ 
        symbol: symbol,
        data: [],
        message: `No historical data available for ${symbol}` 
      });
    }
    
    // Convert to array format for charting
    const historicalData = result.Items.map(item => ({
      date: item.date,
      close: parseFloat(item.close),
      open: item.open ? parseFloat(item.open) : null,
      high: item.high ? parseFloat(item.high) : null,
      low: item.low ? parseFloat(item.low) : null,
      volume: item.volume || null
    })).reverse(); // Reverse to get chronological order
    
    res.json({
      symbol: symbol,
      data: historicalData,
      count: historicalData.length
    });
    
  } catch (error) {
    console.error(`Error fetching historical data for ${req.params.symbol}:`, error);
    res.status(500).json({ error: `Failed to fetch historical data for ${req.params.symbol}` });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
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

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
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
