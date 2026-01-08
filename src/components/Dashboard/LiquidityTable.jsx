import React from 'react';

const LiquidityTable = ({ data, loading }) => {
  // Helper to get color based on value
  const getColor = (value) => {
    if (value === null || value === undefined) return '#6B7280'; // Gray for null
    if (value > 0) return '#059669'; // Green for positive
    if (value < 0) return '#DC2626'; // Red for negative
    return '#6B7280'; // Gray for zero
  };

  // Helper to get background color based on value
  const getBackgroundColor = (value) => {
    if (value === null || value === undefined) return '#F3F4F6';
    if (value > 0) return '#D1FAE5'; // Light green
    if (value < 0) return '#FEE2E2'; // Light red
    return '#F3F4F6'; // Light gray
  };

  // Format value for display
  const formatValue = (value) => {
    if (value === null || value === undefined) return 'N/A';
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
  };

  if (loading) {
    return (
      <div style={{
        fontSize: '9px',
        border: '1px solid #E5E7EB',
        borderRadius: '4px',
        overflow: 'hidden',
      }}
      className="dark:border-gray-600">
        <div style={{
          backgroundColor: '#059669',
          color: '#FFFFFF',
          padding: '4px 8px',
          fontSize: '10px',
          fontWeight: 600,
          textAlign: 'center',
          letterSpacing: '0.5px',
        }}>
          LIQUIDITY
        </div>
        <div style={{ padding: '20px', textAlign: 'center' }} className="dark:text-gray-300">
          Loading...
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{
        fontSize: '9px',
        border: '1px solid #E5E7EB',
        borderRadius: '4px',
        overflow: 'hidden',
      }}
      className="dark:border-gray-600">
        <div style={{
          backgroundColor: '#059669',
          color: '#FFFFFF',
          padding: '4px 8px',
          fontSize: '10px',
          fontWeight: 600,
          textAlign: 'center',
          letterSpacing: '0.5px',
        }}>
          LIQUIDITY
        </div>
        <div style={{ padding: '20px', textAlign: 'center' }} className="dark:text-gray-300">
          No data available
        </div>
      </div>
    );
  }

  const m3Proxy = data.m3Proxy?.value;
  const moneySupplyVsGDP = data.moneySupplyVsGDP || {};

  return (
    <div style={{
      fontSize: '9px',
      border: '1px solid #E5E7EB',
      borderRadius: '4px',
      overflow: 'hidden',
      marginTop: '8px',
    }}
    className="dark:border-gray-600">
      {/* Title Ribbon */}
      <div style={{
        backgroundColor: '#059669',
        color: '#FFFFFF',
        padding: '4px 8px',
        fontSize: '10px',
        fontWeight: 600,
        textAlign: 'center',
        letterSpacing: '0.5px',
      }}>
        LIQUIDITY
      </div>

      {/* M3 Proxy Display */}
      {m3Proxy !== null && m3Proxy !== undefined && (
        <div style={{
          padding: '6px 8px',
          backgroundColor: '#F9FAFB',
          borderBottom: '1px solid #E5E7EB',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
        className="dark:bg-gray-800 dark:border-gray-600">
          <span style={{ fontWeight: 600 }} className="dark:text-gray-200">M3 Proxy (1m):</span>
          <span style={{
            fontWeight: 700,
            color: getColor(m3Proxy),
            fontSize: '11px',
          }}>
            {formatValue(m3Proxy)}
          </span>
        </div>
      )}

      {/* Money Supply vs GDP Table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <thead>
          <tr style={{ backgroundColor: '#F9FAFB' }} className="dark:bg-gray-800">
            <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid #E5E7EB', width: '30%' }} className="dark:text-gray-200 dark:border-gray-600">Metric</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid #E5E7EB', width: '23%' }} className="dark:text-gray-200 dark:border-gray-600">1m</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid #E5E7EB', width: '23%' }} className="dark:text-gray-200 dark:border-gray-600">3m</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid #E5E7EB', width: '23%' }} className="dark:text-gray-200 dark:border-gray-600">6m</th>
          </tr>
        </thead>
        <tbody>
          {/* Money Supply ROC Row */}
          <tr style={{ borderBottom: '1px solid #E5E7EB' }} className="dark:border-gray-700">
            <td style={{ padding: '4px 6px', fontWeight: 600 }} className="dark:text-gray-200">Money Supply ROC</td>
            <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">
              {formatValue(moneySupplyVsGDP['1m']?.moneySupplyROC)}
            </td>
            <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">
              {formatValue(moneySupplyVsGDP['3m']?.moneySupplyROC)}
            </td>
            <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">
              {formatValue(moneySupplyVsGDP['6m']?.moneySupplyROC)}
            </td>
          </tr>

          {/* GDP ROC Row */}
          <tr style={{ borderBottom: '1px solid #E5E7EB' }} className="dark:border-gray-700">
            <td style={{ padding: '4px 6px', fontWeight: 600 }} className="dark:text-gray-200">GDP ROC</td>
            <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">
              {formatValue(moneySupplyVsGDP['1m']?.gdpROC)}
            </td>
            <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">
              {formatValue(moneySupplyVsGDP['3m']?.gdpROC)}
            </td>
            <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">
              {formatValue(moneySupplyVsGDP['6m']?.gdpROC)}
            </td>
          </tr>

          {/* Spread Row (highlighted) */}
          <tr>
            <td style={{ padding: '4px 6px', fontWeight: 700 }} className="dark:text-gray-200">Spread (MS - GDP)</td>
            <td style={{
              padding: '4px 6px',
              textAlign: 'center',
              fontWeight: 700,
              backgroundColor: getBackgroundColor(moneySupplyVsGDP['1m']?.spread),
              color: getColor(moneySupplyVsGDP['1m']?.spread),
            }}
            className="dark:bg-gray-700">
              {formatValue(moneySupplyVsGDP['1m']?.spread)}
            </td>
            <td style={{
              padding: '4px 6px',
              textAlign: 'center',
              fontWeight: 700,
              backgroundColor: getBackgroundColor(moneySupplyVsGDP['3m']?.spread),
              color: getColor(moneySupplyVsGDP['3m']?.spread),
            }}
            className="dark:bg-gray-700">
              {formatValue(moneySupplyVsGDP['3m']?.spread)}
            </td>
            <td style={{
              padding: '4px 6px',
              textAlign: 'center',
              fontWeight: 700,
              backgroundColor: getBackgroundColor(moneySupplyVsGDP['6m']?.spread),
              color: getColor(moneySupplyVsGDP['6m']?.spread),
            }}
            className="dark:bg-gray-700">
              {formatValue(moneySupplyVsGDP['6m']?.spread)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

export default LiquidityTable;

