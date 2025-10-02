const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Mock market data generator
const generateMockData = () => {
  const symbols = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'MSFT', 'GOOGL', 'AMZN'];
  const data = {};
  
  symbols.forEach(symbol => {
    const basePrice = Math.random() * 500 + 50;
    const change = (Math.random() - 0.5) * 10;
    const changePercent = (change / basePrice) * 100;
    
    data[symbol] = {
      symbol,
      price: basePrice.toFixed(2),
      change: change.toFixed(2),
      changePercent: changePercent.toFixed(2),
      volume: Math.floor(Math.random() * 1000000) + 100000,
      high: (basePrice + Math.random() * 5).toFixed(2),
      low: (basePrice - Math.random() * 5).toFixed(2),
      open: (basePrice + (Math.random() - 0.5) * 2).toFixed(2),
      timestamp: new Date().toISOString()
    };
  });
  
  return data;
};

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

// Mock options data
const generateOptionsData = () => {
  const symbols = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA'];
  const options = [];
  
  symbols.forEach(symbol => {
    const basePrice = Math.random() * 500 + 50;
    const strikes = [basePrice * 0.9, basePrice, basePrice * 1.1];
    
    strikes.forEach(strike => {
      ['C', 'P'].forEach(type => {
        options.push({
          symbol,
          strike: strike.toFixed(0),
          expiration: '12/20',
          type,
          bid: (Math.random() * 5 + 0.5).toFixed(2),
          ask: (Math.random() * 5 + 1).toFixed(2),
          volume: Math.floor(Math.random() * 5000) + 100,
          openInterest: Math.floor(Math.random() * 20000) + 1000
        });
      });
    });
  });
  
  return options.slice(0, 10); // Return first 10 options
};

// Mock VIX data
const generateVIXData = () => {
  return {
    current: (Math.random() * 20 + 15).toFixed(2),
    change: ((Math.random() - 0.5) * 2).toFixed(2),
    changePercent: ((Math.random() - 0.5) * 10).toFixed(2),
    timestamp: new Date().toISOString()
  };
};

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

app.get('/api/portfolio', (req, res) => {
  res.json(generatePortfolioData());
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Market data API available at http://localhost:${PORT}/api`);
  console.log(`💼 Portfolio data available at http://localhost:${PORT}/api/portfolio`);
});

module.exports = app;
