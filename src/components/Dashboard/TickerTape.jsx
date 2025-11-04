import React, { useState, useEffect, useRef } from 'react';
import { Text } from '@tremor/react';

const FIXED_TICKERS = [
  { symbol: 'SP500', name: 'S&P 500' },
  { symbol: 'NASDAQ', name: 'NASDAQ' },
  { symbol: 'GOLD', name: 'Gold' },
  { symbol: 'SILVER', name: 'Silver' },
  { symbol: 'RUT', name: 'Russell 2000' },
  { symbol: 'CL', name: 'Crude Oil' },
  { symbol: 'EUR/USD', name: 'EUR/USD' },
  { symbol: 'UST10Y', name: '10yr Bond' },
  { symbol: 'BTC', name: 'Bitcoin' },
  { symbol: 'FTSE', name: 'FTSE 100' },
  { symbol: 'NIKK', name: 'Nikkei 225' },
];

const TickerTape = () => {
  const [tickerData, setTickerData] = useState([]);
  const [isPaused, setIsPaused] = useState(false);
  const containerRef = useRef(null);
  const animationRef = useRef(null);

  // Generate mock price data
  useEffect(() => {
    const generateMockData = () => {
      return FIXED_TICKERS.map(ticker => {
        const basePrice = 100 + Math.random() * 500;
        const previousClose = basePrice * (0.98 + Math.random() * 0.04);
        const currentPrice = previousClose * (0.995 + Math.random() * 0.01);
        const change = currentPrice - previousClose;
        const changePercent = ((change / previousClose) * 100).toFixed(2);
        
        return {
          symbol: ticker.symbol,
          name: ticker.name,
          price: parseFloat(currentPrice.toFixed(2)),
          change: parseFloat(change.toFixed(2)),
          changePercent: parseFloat(changePercent),
          isPositive: change >= 0
        };
      });
    };

    setTickerData(generateMockData());
    
    // Refresh data periodically (every 30 seconds)
    const interval = setInterval(() => {
      setTickerData(generateMockData());
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  // Duplicate ticker data for seamless scrolling
  const doubledTickers = [...tickerData, ...tickerData];

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-4 py-2"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      style={{ 
        height: '40px',
        width: '100%',
        maxWidth: '100%'
      }}
    >
      <div
        className="flex items-center gap-8 whitespace-nowrap h-full"
        style={{
          animation: isPaused ? 'none' : 'scroll 40s linear infinite',
          width: 'max-content'
        }}
      >
        {doubledTickers.map((ticker, index) => (
          <div
            key={`${ticker.symbol}-${index}`}
            className="flex items-center gap-3 flex-shrink-0 h-full"
          >
            <Text className="font-semibold text-sm dark:text-white" style={{ minWidth: '60px' }}>
              {ticker.symbol}
            </Text>
            <Text className="text-sm dark:text-gray-300" style={{ minWidth: '80px' }}>
              ${ticker.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </Text>
            <Text
              className={`text-sm font-semibold ${
                ticker.isPositive
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
              style={{ minWidth: '70px' }}
            >
              {ticker.isPositive ? '+' : ''}{ticker.changePercent}%
            </Text>
          </div>
        ))}
      </div>

      <style>{`
        @keyframes scroll {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-50%);
          }
        }
      `}</style>
    </div>
  );
};

export default TickerTape;

