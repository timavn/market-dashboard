import React from 'react';
import { Title, Text, Card } from '@tremor/react';
import expectedValuesData from '../../constants/expectedValuesData';

const { quadData, quarterlyExpectedValues } = expectedValuesData;

const ExpectedValuesWindow = ({ show, onClose, right, width, theme }) => {
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

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 16px 28px' }} className="custom-scrollbar">
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
              <tr>
                <th className="sticky left-0 z-20 bg-[#111] dark:bg-[#000] p-1 border border-gray-700 text-center font-bold text-white shadow-[2px_0_4px_rgba(0,0,0,0.1)] w-[120px] md:w-[150px] text-xs">
                  Exposure
                </th>
                {[
                  'EV by Quadrant', 'Shallow GDP Up', 'Deep GDP Down', 'Fed Easing',
                  'Fed On Hold', 'Fed Tightening', 'Quad 1 Prior', 'Quad 2 Prior',
                  'Quad 3 Prior', 'Quad 4 Prior', 'China Quad',
                ].map((header, idx) => (
                  <th key={idx} colSpan={4} className="p-1 border border-gray-600 bg-[#222] dark:bg-[#111] text-center text-xs font-semibold text-white">
                    {header}
                  </th>
                ))}
              </tr>
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
