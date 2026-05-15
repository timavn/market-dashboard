import React from 'react';
import { Title, Text, Card, Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell, Badge } from '@tremor/react';

const quadData = [
  {
    quad: "Quad 1: Goldilocks",
    bestAssetClasses: "Equities, Credit, Commodities, FX",
    worstAssetClasses: "Fixed Income, USD",
    bestEquitySectors: "Tech, Consumer Discretionary, Communication Services, Industrials, Materials, REITS",
    worstEquitySectors: "Utilities, Consumer Staples, Health Care",
    bestEquityStyleFactors: "High Beta, Momentum, Leverage, Secular Growth, Mid Caps",
    worstEquityStyleFactors: "Low Beta, Defensives, Value, Dividend Yield, Small Caps",
    bestFixedIncomeSectors: "BDCs, Convertibles, HY Credit, EM $ Debt, Leveraged Loans",
    worstFixedIncomeSectors: "TIPS, Short Duration Treasurys, MBS, Treasury Belly, Long Bond"
  },
  {
    quad: "Quad 2: Reflation",
    bestAssetClasses: "Commodities, Equities, Credit, FX",
    worstAssetClasses: "Fixed Income, USD",
    bestEquitySectors: "Tech, Industrials, Financials, Energy, Consumer Discretionary",
    worstEquitySectors: "Utilities, Communication Services, Consumer Staples, REITS, Health Care",
    bestEquityStyleFactors: "Secular Growth, High Beta, Small Caps, Cyclical Growth, Momentum",
    worstEquityStyleFactors: "Low Beta, Dividend Yield, Value, Defensives, Size",
    bestFixedIncomeSectors: "Convertibles, BDCs, Preferreds, Leveraged Loans, HY Credit",
    worstFixedIncomeSectors: "Long Bond, Treasury Belly, Munis, MBS, IG Credit"
  },
  {
    quad: "Quad 3: Stagflation",
    bestAssetClasses: "Gold, Commodities, Fixed Income",
    worstAssetClasses: "Credit",
    bestEquitySectors: "Utilities, Energy, REITS, Tech, Consumer Staples, Health Care",
    worstEquitySectors: "Communication Services, Financials, Consumer Discretionary, Industrials, Materials",
    bestEquityStyleFactors: "Secular Growth, Momentum, Mid Caps, Low Beta, Quality",
    worstEquityStyleFactors: "Small Caps, Dividend Yield, Value, Defensives, Size",
    bestFixedIncomeSectors: "Munis, EM $ Debt, Long Bond, TIPS, Treasury Belly",
    worstFixedIncomeSectors: "BDCs, Preferreds, Convertibles, Leveraged Loans, HY Credit"
  },
  {
    quad: "Quad 4: Deflation",
    bestAssetClasses: "Fixed Income, Gold, USD",
    worstAssetClasses: "Commodities, Equities, Credit, FX",
    bestEquitySectors: "Consumer Staples, Health Care, Utilities",
    worstEquitySectors: "Energy, Tech, Financials, Industrials, Consumer Discretionary",
    bestEquityStyleFactors: "Low Beta, Dividend Yield, Quality, Defensives, Value",
    worstEquityStyleFactors: "High Beta, Momentum, Leverage, Secular Growth, Cyclical Growth",
    bestFixedIncomeSectors: "Long Bond, Treasury Belly, IG Credit, Munis, MBS",
    worstFixedIncomeSectors: "Preferreds, EM Local Currency, BDCs, Leveraged Loans, TIPS"
  }
];

const quarterlyExpectedValues = [
  { name: "S&P 500 INDEX", ticker: "SPY", q1: 0.0, q2: 4.6, q3: -3.1, q4: -0.8 },
  { name: "Communication Services", ticker: "XLC", q1: 7.3, q2: 1.4, q3: -1.0, q4: -0.3 },
  { name: "Consumer Cyclical", ticker: "XLY", q1: 8.1, q2: 4.4, q3: 0.0, q4: -0.8 },
  { name: "Consumer Non-Cyclical", ticker: "XLP", q1: 4.4, q2: 2.1, q3: 0.1, q4: 1.5 },
  { name: "Energy", ticker: "XLE", q1: 4.6, q2: 4.8, q3: 2.8, q4: -1.8 },
  { name: "Financials", ticker: "XLF", q1: 5.5, q2: 4.8, q3: -0.8, q4: -0.3 },
  { name: "Health Care", ticker: "XLV", q1: 4.5, q2: 3.9, q3: -0.3, q4: 1.8 },
  { name: "Industrials", ticker: "XLI", q1: 6.3, q2: 5.1, q3: -0.4, q4: -0.1 },
  { name: "Information Technology", ticker: "XLK", q1: 9.4, q2: 7.7, q3: 0.7, q4: -2.1 },
  { name: "Materials", ticker: "XLB", q1: 5.9, q2: 4.1, q3: -0.7, q4: 0.6 },
  { name: "REITS", ticker: "XLRE", q1: 5.0, q2: 2.9, q3: 0.5, q4: 1.0 },
  { name: "Utilities", ticker: "XLU", q1: 3.5, q2: 0.8, q3: 2.7, q4: 1.4 },
  { name: "Growth", ticker: "IWF", q1: 7.7, q2: 5.8, q3: -3.1, q4: -1.5 },
  { name: "Value", ticker: "IWD", q1: 5.5, q2: 3.4, q3: 0.0, q4: 0.1 },
  { name: "Cyclicals", ticker: "RSP", q1: 7.8, q2: 5.5, q3: 0.0, q4: -2.1 },
  { name: "Defensives", ticker: "DEF", q1: 5.6, q2: 3.9, q3: -0.1, q4: 0.3 },
  { name: "High Beta", ticker: "SPHB", q1: 8.9, q2: 8.2, q3: -1.0, q4: -3.3 },
  { name: "Low Beta", ticker: "SPLV", q1: 3.9, q2: 2.3, q3: 0.8, q4: 2.4 },
  { name: "Momentum", ticker: "MTUM", q1: 7.2, q2: 5.1, q3: 0.9, q4: -1.5 },
  { name: "Quality", ticker: "QUAL", q1: 6.8, q2: 4.7, q3: 0.1, q4: 0.8 },
  { name: "Dividend Yield", ticker: "SDY", q1: 5.5, q2: 3.2, q3: -0.2, q4: 2.2 },
  { name: "Size", ticker: "OEF", q1: 4.8, q2: 3.2, q3: -0.1, q4: -1.1 },
  { name: "Secular Growth", ticker: "QQQ", q1: 8.1, q2: 7.7, q3: 0.6, q4: -2.3 },
  { name: "Mid-Caps", ticker: "MDY", q1: 6.6, q2: 5.1, q3: 0.6, q4: -0.8 },
  { name: "Small-Caps", ticker: "IWM", q1: 6.2, q2: 5.7, q3: -0.5, q4: -1.2 },
  { name: "BARCLAYS AGG", ticker: "AGG", q1: 1.3, q2: 0.6, q3: 0.4, q4: 2.0 },
  { name: "Leveraged Loans", ticker: "BKLN", q1: 2.2, q2: 1.3, q3: 0.4, q4: 0.8 },
  { name: "BDCs", ticker: "BIZD", q1: 5.9, q2: 5.8, q3: -1.1, q4: -0.1 },
  { name: "Preferreds", ticker: "PFF", q1: 2.1, q2: 2.9, q3: -0.3, q4: -0.2 },
  { name: "IG Credit", ticker: "LQD", q1: 2.0, q2: 0.8, q3: 0.2, q4: 2.2 },
  { name: "HY Credit", ticker: "HYG", q1: 3.3, q2: 2.1, q3: 0.0, q4: 1.4 },
  { name: "Convertibles", ticker: "CWB", q1: 5.1, q2: 5.8, q3: -0.7, q4: 0.3 },
  { name: "EM USD Debt", ticker: "EMB", q1: 2.8, q2: 1.8, q3: 0.7, q4: 2.0 },
  { name: "EM Local Currency Debt", ticker: "EMLC", q1: 1.7, q2: 2.1, q3: -0.5, q4: 0.2 },
  { name: "1-3yr Treasurys", ticker: "SHY", q1: 0.7, q2: 0.4, q3: 0.5, q4: 1.2 },
  { name: "3-10yr Treasurys", ticker: "IEF", q1: 1.2, q2: 0.2, q3: 0.6, q4: 2.4 },
  { name: "10-20yr Treasurys", ticker: "TLT", q1: 1.4, q2: -0.2, q3: 0.4, q4: 3.3 },
  { name: "20+ Year Treasurys", ticker: "EDV", q1: 1.5, q2: -0.7, q3: 0.5, q4: 4.1 },
  { name: "0-5yr TIPS", ticker: "STIP", q1: 0.7, q2: 1.0, q3: 0.8, q4: 0.6 },
  { name: "5-10yr TIPS", ticker: "TIP", q1: 1.0, q2: 1.5, q3: 0.9, q4: 1.4 },
  { name: "MBS", ticker: "MBB", q1: 1.0, q2: 0.6, q3: 0.6, q4: 1.6 },
  { name: "Munis", ticker: "MUB", q1: 1.5, q2: 0.4, q3: 0.4, q4: 1.7 },
  { name: "Taxable Munis", ticker: "BAB", q1: 2.1, q2: 0.5, q3: 0.7, q4: 1.7 },
  { name: "CRB Index", ticker: "DBC", q1: 1.3, q2: 5.2, q3: 2.8, q4: -3.6 },
  { name: "CRB Raw Index", ticker: "", q1: 0.3, q2: 0.9, q3: 3.7, q4: 0.0 },
  { name: "CRB Foodstuffs Index", ticker: "DBA", q1: -0.1, q2: 3.1, q3: 2.2, q4: -1.2 },
  { name: "Bloomberg Energy Index", ticker: "BNO", q1: 5.9, q2: 11.1, q3: 6.5, q4: -9.1 },
  { name: "Bloomberg Precious Metals Index", ticker: "DBP", q1: 3.0, q2: 3.2, q3: 0.3, q4: 2.3 },
  { name: "Silver", ticker: "SLV", q1: 5.0, q2: 3.9, q3: -1.3, q4: 2.8 },
  { name: "Bitcoin", ticker: "GBTC", q1: 80.8, q2: 33.2, q3: 157.2, q4: 7.8 },
  { name: "WTI Crude Oil", ticker: "USO", q1: 4.8, q2: 9.6, q3: 4.7, q4: -6.8 },
  { name: "Natural Gas", ticker: "UNG", q1: 2.0, q2: 3.8, q3: 3.5, q4: -3.7 },
  { name: "Iron Ore", ticker: "", q1: -2.7, q2: 11.2, q3: -4.6, q4: -4.4 },
  { name: "Copper", ticker: "CPER", q1: 4.9, q2: 6.2, q3: -0.4, q4: 0.4 },
  { name: "US Dollar Index", ticker: "UUP", q1: -0.6, q2: -0.3, q3: 0.3, q4: 0.9 },
  { name: "Gold", ticker: "GLD", q1: 2.7, q2: 3.2, q3: 1.6, q4: 3.1 },
  { name: "EM FX", ticker: "CEW", q1: 0.2, q2: 0.6, q3: -1.2, q4: -1.9 }
];

const getColorForValue = (val) => {
  if (val > 0) return "text-emerald-600 dark:text-emerald-400 font-medium text-xs";
  if (val < 0) return "text-rose-600 dark:text-rose-400 font-medium text-xs";
  return "text-gray-500 dark:text-gray-400 text-xs";
};

const formatValue = (val) => {
  return `${val > 0 ? '+' : ''}${val.toFixed(1)}%`;
};

const ExpectedValuesWindow = ({ show, onClose, top, right, width, theme, showPortfolioMetrics }) => {
  if (!show) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: right,
        width: width,
        height: '100vh',
        zIndex: 1200,
        backgroundColor: theme === 'dark' ? '#111827' : '#ffffff',
        borderLeft: '1px solid #d1d5db',
        borderRight: '1px solid #d1d5db',
        borderRadius: '0.75rem 0 0 0',
        boxShadow: '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)',
        transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      className="dark:border-gray-700"
    >
      <div
        style={{
          padding: '12px 16px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          borderBottom: '1px solid #d1d5db',
          backgroundColor: theme === 'dark' ? '#1f2937' : '#f3f4f6',
          cursor: 'pointer',
        }}
        className="dark:border-gray-700 hover:bg-[#f3f4f6] dark:hover:bg-gray-800 transition-colors"
        onClick={onClose}
      >
        <Title
          className="dark:text-white"
          style={{
            fontSize: '18px',
            fontWeight: 700,
            color: '#000',
            letterSpacing: '-0.02em',
          }}
        >
          Expected Values Data
        </Title>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }} className="custom-scrollbar">
        <Title className="mb-4 text-xl font-bold dark:text-white">Highest/Lowest Expected Values By Quad Regime</Title>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          {quadData.map((quad, index) => (
            <Card key={index} className="dark:bg-gray-800">
              <Title className="text-lg font-bold mb-3 dark:text-white">{quad.quad}</Title>
              <div className="space-y-3 text-sm">
                <div>
                  <span className="font-semibold text-green-600 dark:text-green-400">Best Asset Classes:</span>
                  <p className="dark:text-gray-300">{quad.bestAssetClasses}</p>
                </div>
                <div>
                  <span className="font-semibold text-red-600 dark:text-red-400">Worst Asset Classes:</span>
                  <p className="dark:text-gray-300">{quad.worstAssetClasses}</p>
                </div>
                <div>
                  <span className="font-semibold text-green-600 dark:text-green-400">Best Equity Sectors:</span>
                  <p className="dark:text-gray-300">{quad.bestEquitySectors}</p>
                </div>
                <div>
                  <span className="font-semibold text-red-600 dark:text-red-400">Worst Equity Sectors:</span>
                  <p className="dark:text-gray-300">{quad.worstEquitySectors}</p>
                </div>
                <div>
                  <span className="font-semibold text-green-600 dark:text-green-400">Best Equity Style Factors:</span>
                  <p className="dark:text-gray-300">{quad.bestEquityStyleFactors}</p>
                </div>
                <div>
                  <span className="font-semibold text-red-600 dark:text-red-400">Worst Equity Style Factors:</span>
                  <p className="dark:text-gray-300">{quad.worstEquityStyleFactors}</p>
                </div>
                <div>
                  <span className="font-semibold text-green-600 dark:text-green-400">Best Fixed Income Sectors:</span>
                  <p className="dark:text-gray-300">{quad.bestFixedIncomeSectors}</p>
                </div>
                <div>
                  <span className="font-semibold text-red-600 dark:text-red-400">Worst Fixed Income Sectors:</span>
                  <p className="dark:text-gray-300">{quad.worstFixedIncomeSectors}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>

        <Title className="mb-4 text-xl font-bold dark:text-white mt-12">Quarterly Expected Values By GIP Model Quad Regime</Title>
        <div className="overflow-x-auto pb-4 custom-scrollbar">
          <table className="w-full text-left border-collapse table-fixed">
            <thead>
              {/* Main Headers row */}
              <tr>
                <th className="sticky left-0 z-20 bg-[#111] dark:bg-[#000] p-1 border border-gray-700 text-center font-bold text-white shadow-[2px_0_4px_rgba(0,0,0,0.1)] w-[120px] md:w-[150px] text-xs">
                  Exposure
                </th>
                {[
                  "EV by Quadrant", "Shallow GDP \u2191", "Deep GDP \u2193", "Fed Easing", 
                  "Fed On Hold", "Fed Tightening", "Quad 1 Prior", "Quad 2 Prior", 
                  "Quad 3 Prior", "Quad 4 Prior", "China Quad"
                ].map((header, idx) => (
                  <th key={idx} colSpan={4} className="p-1 border border-gray-600 bg-[#222] dark:bg-[#111] text-center text-xs font-semibold text-white">
                    {header}
                  </th>
                ))}
              </tr>
              {/* Sub Headers row */}
              <tr>
                <th className="sticky left-0 z-20 bg-[#222] dark:bg-[#111] border border-gray-600 p-1 shadow-[2px_0_4px_rgba(0,0,0,0.1)]"></th>
                {Array(11).fill(0).map((_, groupIdx) => (
                  <React.Fragment key={groupIdx}>
                    <th className="p-0 border border-gray-400 bg-[#4ade80] text-black text-center text-[9px] font-bold">1</th>
                    <th className="p-0 border border-gray-400 bg-[#fde047] text-black text-center text-[9px] font-bold">2</th>
                    <th className="p-0 border border-gray-400 bg-[#fca5a5] text-black text-center text-[9px] font-bold">3</th>
                    <th className="p-0 border border-gray-400 bg-[#ef4444] text-white text-center text-[9px] font-bold">4</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {quarterlyExpectedValues.map((item, idx) => (
                <tr key={idx} className="hover:bg-gray-100 dark:hover:bg-gray-800/80 transition-colors">
                  <td className="sticky left-0 z-10 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 p-0.5 shadow-[2px_0_4px_rgba(0,0,0,0.1)] overflow-hidden">
                    <div className="flex items-center justify-between gap-1">
                      <Text className="font-semibold text-gray-900 dark:text-gray-100 text-[9px] leading-tight truncate">{item.name}</Text>
                      {item.ticker && (
                        <span className="font-bold text-gray-600 dark:text-gray-400 text-[9px] leading-tight flex-shrink-0">
                          ({item.ticker})
                        </span>
                      )}
                    </div>
                  </td>
                  {Array(11).fill(0).map((_, groupIdx) => (
                    <React.Fragment key={groupIdx}>
                      <td className="border border-gray-300 dark:border-gray-700 p-0 text-center">
                        <input type="text" className="w-full h-5 bg-transparent text-center text-[9px] text-gray-900 dark:text-gray-100 focus:outline-none focus:bg-white dark:focus:bg-gray-800 focus:ring-1 focus:ring-blue-500 font-mono px-0" />
                      </td>
                      <td className="border border-gray-300 dark:border-gray-700 p-0 text-center">
                        <input type="text" className="w-full h-5 bg-transparent text-center text-[9px] text-gray-900 dark:text-gray-100 focus:outline-none focus:bg-white dark:focus:bg-gray-800 focus:ring-1 focus:ring-blue-500 font-mono px-0" />
                      </td>
                      <td className="border border-gray-300 dark:border-gray-700 p-0 text-center">
                        <input type="text" className="w-full h-5 bg-transparent text-center text-[9px] text-gray-900 dark:text-gray-100 focus:outline-none focus:bg-white dark:focus:bg-gray-800 focus:ring-1 focus:ring-blue-500 font-mono px-0" />
                      </td>
                      <td className="border border-gray-300 dark:border-gray-700 p-0 text-center">
                        <input type="text" className="w-full h-5 bg-transparent text-center text-[9px] text-gray-900 dark:text-gray-100 focus:outline-none focus:bg-white dark:focus:bg-gray-800 focus:ring-1 focus:ring-blue-500 font-mono px-0" />
                      </td>
                    </React.Fragment>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default ExpectedValuesWindow;
