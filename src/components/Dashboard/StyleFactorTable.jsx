import React, { useState } from 'react';
import { FACTOR_DEFINITIONS } from '../../constants/factorDefinitions';

const data = [
  // --- FUNDAMENTAL FACTORS ---
  {
    category: "Value",
    description: "Cheap vs. Expensive valuation",
    items: [
      { name: "Book-to-Price (Deep Value)", values: [0.8, -1.2, 3.4, 5.1, 6.2, 8.4] },
      { name: "Earnings Yield", values: [0.4, -0.5, 1.2, 2.8, 4.5, 5.9] },
      { name: "Free Cash Flow Yield", values: [0.2, -0.8, 2.1, 3.3, 4.1, 6.2] },
      { name: "Price-to-Earnings (P/E)", values: [-0.3, 0.9, -1.5, 2.4, 3.8, 5.1] },
    ]
  },
  {
    category: "Growth",
    description: "Expansion in Sales/Earnings",
    items: [
      { name: "Sales Growth (Top 25%)", values: [-0.5, -4.1, 5.2, 12.8, 16.5, 20.5] },
      { name: "EPS Growth (Top 25%)", values: [-0.2, -3.9, 4.8, 11.5, 15.2, 19.4] },
    ]
  },
  {
    category: "Quality",
    description: "Profitability & Balance Sheet Safety",
    items: [
      { name: "Return on Equity (ROE)", values: [0.6, 1.2, 1.8, 3.5, 5.2, 8.1] },
      { name: "Gross Margin Stability", values: [0.3, 0.5, 0.9, 1.2, 2.4, 3.1] },
      { name: "Low Leverage (Low Debt/EV)", values: [0.1, 0.8, 1.5, 2.2, 3.1, 4.5] },
    ]
  },
  
  // --- MARKET FACTORS ---
  {
    category: "Momentum",
    description: "Trend following vs. Reversion",
    items: [
      { name: "Price Momentum (12M)", values: [1.2, 2.4, 5.8, 8.4, 12.1, 15.3] },
      { name: "Reversal (1M Mean Reversion)", values: [-1.5, -2.1, -0.5, 1.2, 0.8, -1.2] },
    ]
  },
  {
    category: "Volatility & Risk",
    description: "Systematic & Idiosyncratic Risk",
    items: [
      { name: "High Beta", values: [-0.5, -5.2, 4.8, 12.3, 15.2, 18.6] },
      { name: "Residual Volatility", values: [-0.8, -4.5, 2.1, 9.5, 11.2, 14.1] },
    ]
  },
  {
    category: "Liquidity & Size",
    description: "Ease of trading & Market Cap",
    items: [
      { name: "Large Cap (Top 25%)", values: [-0.4, -2.6, 8.2, 15.5, 18.9, 21.3] },
      { name: "High Liquidity (Turnover)", values: [0.2, -1.1, 0.5, 1.8, 2.2, 3.5] },
    ]
  },

  // --- POSITIONING ---
  {
    category: "Crowding & Sentiment",
    description: "Hedge Fund positioning risks",
    items: [
      { name: "High Short Interest", values: [0.1, -3.4, -2.1, 0.8, 1.2, 1.6] },
      { name: "HF Concentration", values: [0.9, 1.5, 3.2, 4.1, 5.5, 7.8] },
    ]
  },
];

const timeframes = ['1D', '1W', '1M', '3M', '6M', '1Y'];

const StyleFactorTable = () => {
  const [modalConfig, setModalConfig] = useState({ isOpen: false, title: '', description: '' });

  const handleOpenModal = (type, key, context = {}) => {
    let title = '';
    let description = '';

    if (type === 'category') {
      const def = FACTOR_DEFINITIONS.categories[key];
      title = def ? def.title : key;
      description = def ? def.description : 'No description available.';
    } else if (type === 'factor') {
      const def = FACTOR_DEFINITIONS.factors[key];
      title = def ? def.title : key;
      description = def ? def.description : 'No description available.';
    } else if (type === 'value') {
      const def = FACTOR_DEFINITIONS.calculations['return'];
      title = `${context.factor} (${context.timeframe})` || 'Performance Return';
      description = (
        <div>
          <p className="mb-2">{def ? def.description : 'Return calculation.'}</p>
          <div className="mt-4 p-3 bg-gray-50 dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">Current Value: </span>
            <span className={`text-sm font-bold ${context.value > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {context.value > 0 ? '+' : ''}{context.value.toFixed(1)}%
            </span>
          </div>
        </div>
      );
    }

    setModalConfig({ isOpen: true, title, description });
  };

  const handleCloseModal = () => {
    setModalConfig({ isOpen: false, title: '', description: '' });
  };

  const getValueColor = (val) => {
    if (val > 0) return 'text-emerald-600 font-medium dark:text-emerald-400';
    if (val < 0) return 'text-rose-600 font-medium dark:text-rose-400';
    return 'text-gray-400 dark:text-gray-500';
  };

  const formatValue = (val) => {
    return `${val > 0 ? '+' : ''}${val.toFixed(1)}%`;
  };

  return (
    <div className="w-full relative">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
        
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-200 bg-gray-50 flex justify-between items-end dark:bg-gray-700 dark:border-gray-600">
          <div>
            <h2 className="text-xl font-bold text-gray-900 tracking-tight dark:text-white">Factor Risk Model</h2>
            <p className="text-sm text-gray-500 mt-1 dark:text-gray-400">Performance of major style factors and HF positioning signals</p>
          </div>
          <div className="text-right">
             <span className="block text-xs text-gray-400 uppercase tracking-wider font-semibold mb-1 dark:text-gray-500">Last Update</span>
             <span className="text-sm font-mono text-gray-700 dark:text-gray-300">NOV 22 • 16:00 EST</span>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {data.map((group, groupIdx) => (
                <React.Fragment key={groupIdx}>
                  {/* Category Header and Timeframes */}
                  <tr className="bg-slate-50 border-y border-gray-200 dark:bg-gray-700 dark:border-gray-600">
                    <td className="px-6 py-3">
                      <div className="flex items-baseline gap-3">
                        <button 
                          onClick={() => handleOpenModal('category', group.category)}
                          className="text-xs font-bold text-slate-700 uppercase tracking-widest dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer transition-colors text-left"
                        >
                          {group.category}
                        </button>
                      </div>
                    </td>
                    {timeframes.map((tf) => (
                      <td key={tf} className="px-4 py-3 text-right">
                        <span className="text-xs font-bold text-slate-700 uppercase tracking-widest dark:text-gray-200">{tf}</span>
                      </td>
                    ))}
                  </tr>

                  {/* Rows */}
                  {group.items.map((item, itemIdx) => (
                    <tr 
                      key={itemIdx} 
                      className="hover:bg-blue-50/30 transition-colors duration-150 group dark:hover:bg-gray-700/50"
                    >
                      <td className="px-6 py-3 font-medium text-gray-700 border-l-4 border-transparent group-hover:border-blue-500 relative dark:text-gray-300">
                        <button 
                          onClick={() => handleOpenModal('factor', item.name)}
                          className="hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer transition-colors text-left w-full"
                        >
                          {item.name}
                        </button>
                      </td>
                      {item.values.map((val, idx) => (
                        <td 
                          key={idx} 
                          className={`px-4 py-3 text-right tabular-nums tracking-tight cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 rounded transition-colors ${getValueColor(val)}`}
                          onClick={() => handleOpenModal('value', null, { value: val, timeframe: timeframes[idx], factor: item.name })}
                        >
                          {formatValue(val)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        
        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-gray-200 flex justify-between items-center text-xs text-gray-400 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-500">
          <span>*Long/Short spread returns calculated daily.</span>
          <div className="flex gap-4">
            <span>source: Internal Analytics</span>
          </div>
        </div>
      </div>

      {/* Modal Overlay */}
      {modalConfig.isOpen && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={handleCloseModal}
        >
          <div 
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md border border-gray-200 dark:border-gray-700 transform transition-all scale-100 opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                {modalConfig.title}
              </h3>
              <button
                onClick={handleCloseModal}
                className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 transition-colors focus:outline-none"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            {/* Modal Content */}
            <div className="p-6">
              <div className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed">
                {modalConfig.description}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StyleFactorTable;
