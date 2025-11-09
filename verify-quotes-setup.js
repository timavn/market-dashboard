#!/usr/bin/env node
/**
 * Quick verification script to test if quotes endpoint is working
 * Run: node verify-quotes-setup.js
 */

const axios = require('axios');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

async function testQuotesEndpoint() {
  console.log('🧪 Testing Quotes Endpoint Setup\n');
  console.log(`Backend URL: ${BACKEND_URL}\n`);
  
  // Test with a small set first
  const testSymbols = ['AAPL', 'SPY', 'BKLN', 'COMPQ', 'UST10Y'];
  console.log(`Testing with ${testSymbols.length} symbols: ${testSymbols.join(', ')}\n`);
  
  try {
    const startTime = Date.now();
    const response = await axios.get(`${BACKEND_URL}/api/quotes`, {
      params: { symbols: testSymbols.join(',') },
      timeout: 30000 // 30 second timeout for test
    });
    const duration = Date.now() - startTime;
    
    console.log(`✅ Request completed in ${duration}ms\n`);
    console.log(`Received ${Object.keys(response.data).length} quotes:\n`);
    
    testSymbols.forEach(symbol => {
      const quote = response.data[symbol.toUpperCase()];
      if (quote && quote.price) {
        console.log(`  ✅ ${symbol}: $${quote.price} (change: ${quote.change}, ${quote.changePercent}%)`);
      } else {
        console.log(`  ❌ ${symbol}: No price data`);
      }
    });
    
    const successCount = testSymbols.filter(s => response.data[s.toUpperCase()]?.price).length;
    console.log(`\n📊 Result: ${successCount}/${testSymbols.length} successful\n`);
    
    if (successCount === testSymbols.length) {
      console.log('✅ All test symbols returned prices!');
    } else {
      console.log('⚠️  Some symbols failed. Check server logs for details.');
    }
    
  } catch (error) {
    console.error('❌ Error testing endpoint:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('\n💡 Backend server is not running. Start it with: npm run server');
    } else if (error.code === 'ECONNABORTED') {
      console.error('\n💡 Request timed out. Backend may be processing slowly.');
    }
    process.exit(1);
  }
}

// Run test
testQuotesEndpoint();

