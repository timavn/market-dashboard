import React, { useState } from 'react';
import { verifiedReferenceQuote } from '../../utils/legacyMarketDisplay';
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

const TickerTape = ({ quotes = {} }) => {
  const [isPaused, setIsPaused] = useState(false);
  const tickerData = FIXED_TICKERS.map((ticker) => ({
    ...ticker,
    reference: verifiedReferenceQuote(quotes[ticker.symbol], ticker.symbol),
  }));

  // Duplicate ticker data for seamless scrolling
  const doubledTickers = [...tickerData, ...tickerData];

  return (
    <div
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
        className="ticker-tape-track flex items-center gap-8 whitespace-nowrap h-full"
        style={{
          animation: isPaused || !tickerData.some((ticker) => ticker.reference) ? 'none' : 'scroll 40s linear infinite',
          width: 'max-content'
        }}
      >
        {doubledTickers.map((ticker, index) => (
          <div
            key={`${ticker.symbol}-${index}`}
            className="flex items-center gap-3 flex-shrink-0 h-full"
            aria-hidden={index >= tickerData.length ? true : undefined}
          >
            <Text className="font-semibold text-sm dark:text-white" style={{ minWidth: '60px' }}>
              {ticker.symbol}
            </Text>
            <Text className="text-sm dark:text-gray-300" style={{ minWidth: '80px' }}>
              {ticker.reference ? ticker.reference.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
            </Text>
            <Text
              className={`text-sm font-semibold ${
                ticker.reference?.changePercent == null ? 'text-gray-500' : ticker.reference.changePercent >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
              style={{ minWidth: '70px' }}
            >
              {ticker.reference?.changePercent == null ? '—' : `${ticker.reference.changePercent >= 0 ? '+' : ''}${ticker.reference.changePercent.toFixed(2)}%`}
            </Text>
            <Text className="text-xs text-gray-500">{ticker.reference ? `Reference · As of ${new Date(ticker.reference.asOf).toLocaleString()}` : 'Unavailable'}</Text>
          </div>
        ))}
      </div>

      <style>{`
        @media (prefers-reduced-motion: reduce) { .ticker-tape-track { animation: none !important; } }
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
