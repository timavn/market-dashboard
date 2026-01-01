import React, { useState, useEffect } from 'react';
import { Text } from '@tremor/react';
import { MarketDataService } from '../../services/api/marketDataService';

// Metric boxes configuration
// Top row: Major daily indicators (moved from bottom row with improved names)
const TOP_ROW_METRICS = [
  'DXY',
  'GLD',
  'UST10Y',
  'CRB',
  'WTI',
  'SPY',
  'QQQ',
  'IWM',
];

// Bottom row: Volume metrics
const VOLUME_METRICS = [
  { label: 'Total Market Volume', subLabel: '12/30 vs.', metrics: ['Prior Day', '1M Ave', '3M ave', '1Y Ave'] },
  { label: 'Total Exchange Volume', subLabel: '12/30 vs.', metrics: ['Prior Day', '1M Ave', '3M ave', '1Y Ave'] },
];

// Yield curve data - hardcoded for now
const YIELD_CURVE_DATA = [
  {
    series: '2yr Yield',
    last: '3.45',
    '1w': '3.45',
    '1m': '3.53',
    '4m': '3.43',
    dod: { value: '-1bps', percent: '-0.2%', isPositive: false },
    yoy: { value: '-8 bps', percent: '-2.4%', isPositive: false },
    mom: { value: '-4 bps', percent: '-2%', isPositive: false }
  },
  {
    series: '10yr Yield',
    last: '4.12',
    '1w': '4.11',
    '1m': '4.16',
    '4m': '4.01',
    dod: { value: '1bps', percent: '0.3%', isPositive: true },
    yoy: { value: '-4 bps', percent: '-1.0%', isPositive: false },
    mom: { value: '11 bps', percent: '2.7%', isPositive: true }
  },
  {
    series: '2-10 Spread',
    last: '0.67',
    '1w': '0.66',
    '1m': '0.63',
    '4m': '0.52',
    dod: { value: '2 bps', percent: '2.7%', isPositive: true },
    yoy: { value: '4 bps', percent: '6.8%', isPositive: true },
    mom: { value: '15 bps', percent: '28.6%', isPositive: true }
  }
];

// Volatility matrix data - hardcoded for now
const VOLATILITY_DATA = [
  {
    series: 'VIX',
    last: '14.33',
    '1w': '14.20',
    '1m': '14.08',
    '4m': '17.13',
    dod: { value: '13 bps', percent: '0.9%', isPositive: true },
    yoy: { value: '25 bps', percent: '1.8%', isPositive: true },
    mom: { value: '-286 bps', percent: '-16.6%', isPositive: false }
  },
  {
    series: 'RVX',
    last: '19.30',
    '1w': '19.18',
    '1m': '18.63',
    '4m': '23.36',
    dod: { value: '12 bps', percent: '0.6%', isPositive: true },
    yoy: { value: '61 bps', percent: '3.3%', isPositive: true },
    mom: { value: '-406 bps', percent: '-17.4%', isPositive: false }
  },
  {
    series: 'NazVol',
    last: '18.95',
    '1w': '18.39',
    '1m': '17.85',
    '4m': '23.67',
    dod: { value: '56 bps', percent: '3.0%', isPositive: true },
    yoy: { value: '110 bps', percent: '6.2%', isPositive: true },
    mom: { value: '-472 bps', percent: '-19.9%', isPositive: false }
  },
  {
    series: 'GV2',
    last: '24.83',
    '1w': '25.71',
    '1m': '23.80',
    '4m': '22.40',
    dod: { value: '-88 bps', percent: '-3.4%', isPositive: false },
    yoy: { value: '103 bps', percent: '4.3%', isPositive: true },
    mom: { value: '243 bps', percent: '10.8%', isPositive: true }
  },
  {
    series: 'OVX',
    last: '30.76',
    '1w': '32.16',
    '1m': '33.03',
    '4m': '37.57',
    dod: { value: '-140 bps', percent: '-4.4%', isPositive: false },
    yoy: { value: '-227 bps', percent: '-6.9%', isPositive: false },
    mom: { value: '-681 bps', percent: '-18.1%', isPositive: false }
  }
];

// Additional metrics row
const ADDITIONAL_METRICS = [
  'VOL BAR',
  'gamma',
];

const MetricBox = ({ label, value, loading }) => {
  // Format value based on label
  const formatValue = (label, value) => {
    if (loading) return '...';
    if (value === null || value === undefined) return '--';

    // UST10Y should be displayed as percentage
    if (label === 'UST10Y') {
      return `${parseFloat(value).toFixed(2)}%`;
    }

    // All others as decimal
    return parseFloat(value).toFixed(2);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {/* Label above box */}
      {label && (
        <Text
          style={{
            fontFamily: "'Kalam', 'Comic Sans MS', cursive",
            fontSize: '11px',
            fontWeight: 400,
            textTransform: 'lowercase',
            color: '#000000',
            fontStyle: 'italic',
            paddingLeft: '2px',
          }}
          className="dark:text-gray-200"
        >
          {label}
        </Text>
      )}

      {/* Box with metric value */}
      <div
        style={{
          border: '1px solid #000000',
          backgroundColor: '#ffffff',
          padding: '6px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          minWidth: '0',
          width: '100%',
          height: '36px',
          borderRadius: '2px',
        }}
        className="dark:bg-gray-700 dark:border-gray-500"
      >
        {/* Green status circle */}
        <div
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: '#22c55e',
            flexShrink: 0,
          }}
        />

        {/* Metric value */}
        <Text
          style={{
            fontSize: '14px',
            fontWeight: 600,
            color: '#000000',
            marginLeft: 'auto',
            fontVariantNumeric: 'tabular-nums',
          }}
          className="dark:text-gray-200"
        >
          {formatValue(label, value)}
        </Text>
      </div>
    </div>
  );
};

// Volume metric row component showing label and percentage changes (compact version)
const VolumeMetricRow = ({ label, subLabel, values = [] }) => {
  // Hardcoded data - can be replaced with API data later
  const mockData = label === 'Total Market Volume'
    ? ['-6%', '-17%', '-28%', '-22%']
    : ['-3%', '-19%', '-31%', '-26%'];

  const headers = ['Prior Day', '1M Ave', '3M ave', '1Y Ave'];

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: '6px',
      fontSize: '10px',
    }}>
      {/* Label */}
      <div style={{
        fontWeight: 600,
        color: '#000000',
        minWidth: '110px',
        paddingTop: '12px', // Align with values row
      }}
      className="dark:text-gray-200">
        {label}
      </div>

      {/* Metric values with headers - compact vertical layout */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}>
        {/* Date header (12/30 vs.) */}
        <div style={{
          fontSize: '9px',
          fontWeight: 500,
          color: '#6B7280',
          marginBottom: '1px',
        }}
        className="dark:text-gray-400">
          {subLabel}
        </div>

        {/* Column headers row */}
        <div style={{
          display: 'flex',
          gap: '8px',
        }}>
          {headers.map((header, index) => (
            <div key={index} style={{
              fontSize: '8px',
              fontWeight: 500,
              color: '#6B7280',
              minWidth: '45px',
              textAlign: 'center',
            }}
            className="dark:text-gray-400">
              {header}
            </div>
          ))}
        </div>

        {/* Values row */}
        <div style={{
          display: 'flex',
          gap: '8px',
        }}>
          {mockData.map((value, index) => (
            <div key={index} style={{
              fontWeight: 600,
              color: value.startsWith('-') ? '#ef4444' : '#22c55e',
              minWidth: '45px',
              textAlign: 'center',
            }}>
              {value}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// Yield Curve Table Component
const YieldCurveTable = () => {
  return (
    <div style={{
      fontSize: '9px',
      border: '1px solid #E5E7EB',
      borderRadius: '4px',
      overflow: 'hidden',
    }}
    className="dark:border-gray-600">
      {/* Title Ribbon */}
      <div style={{
        backgroundColor: '#1E40AF',
        color: '#FFFFFF',
        padding: '4px 8px',
        fontSize: '10px',
        fontWeight: 600,
        textAlign: 'center',
        letterSpacing: '0.5px',
      }}>
        YIELDS
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ backgroundColor: '#F9FAFB' }} className="dark:bg-gray-800">
            <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid #E5E7EB' }} className="dark:text-gray-200 dark:border-gray-600">Series</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid #E5E7EB' }} className="dark:text-gray-200 dark:border-gray-600">Last Px</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid #E5E7EB' }} className="dark:text-gray-200 dark:border-gray-600">1w Ago</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid #E5E7EB' }} className="dark:text-gray-200 dark:border-gray-600">1M Ago</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid #E5E7EB' }} className="dark:text-gray-200 dark:border-gray-600">4M Ago</th>
            <th colSpan="2" style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, backgroundColor: '#D1FAE5', borderBottom: '1px solid #E5E7EB' }} className="dark:bg-green-900/20 dark:border-gray-600">
              <div>DoD</div>
              <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: '2px' }}>
                <span>Δ</span>
                <span>%Δ</span>
              </div>
            </th>
            <th colSpan="2" style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, backgroundColor: '#DBEAFE', borderBottom: '1px solid #E5E7EB' }} className="dark:bg-blue-900/20 dark:border-gray-600">
              <div>YoY</div>
              <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: '2px' }}>
                <span>Δ</span>
                <span>%Δ</span>
              </div>
            </th>
            <th colSpan="2" style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, backgroundColor: '#FEF3C7', borderBottom: '1px solid #E5E7EB' }} className="dark:bg-yellow-900/20 dark:border-gray-600">
              <div>MoM</div>
              <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: '2px' }}>
                <span>Δ</span>
                <span>%Δ</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {YIELD_CURVE_DATA.map((row, index) => (
            <tr key={index} style={{ borderBottom: index < YIELD_CURVE_DATA.length - 1 ? '1px solid #E5E7EB' : 'none' }} className="dark:border-gray-700">
              <td style={{ padding: '4px 6px', fontWeight: 600 }} className="dark:text-gray-200">{row.series}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', color: '#1E40AF' }} className="dark:text-blue-400">{row.last}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">{row['1w']}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">{row['1m']}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">{row['4m']}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#D1FAE5', fontWeight: 600, color: row.dod.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-green-900/20">{row.dod.value}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#D1FAE5', fontWeight: 600, color: row.dod.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-green-900/20">{row.dod.percent}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#DBEAFE', fontWeight: 600, color: row.yoy.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-blue-900/20">{row.yoy.value}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#DBEAFE', fontWeight: 600, color: row.yoy.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-blue-900/20">{row.yoy.percent}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#FEF3C7', fontWeight: 600, color: row.mom.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-yellow-900/20">{row.mom.value}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#FEF3C7', fontWeight: 600, color: row.mom.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-yellow-900/20">{row.mom.percent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// Volatility Matrix Table Component
const VolatilityTable = () => {
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
        backgroundColor: '#7C3AED',
        color: '#FFFFFF',
        padding: '4px 8px',
        fontSize: '10px',
        fontWeight: 600,
        textAlign: 'center',
        letterSpacing: '0.5px',
      }}>
        VOLATILITY
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ backgroundColor: '#F9FAFB' }} className="dark:bg-gray-800">
            <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid #E5E7EB' }} className="dark:text-gray-200 dark:border-gray-600">Series</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid #E5E7EB' }} className="dark:text-gray-200 dark:border-gray-600">Last Px</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid #E5E7EB' }} className="dark:text-gray-200 dark:border-gray-600">1w Ago</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid #E5E7EB' }} className="dark:text-gray-200 dark:border-gray-600">1M Ago</th>
            <th style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid #E5E7EB' }} className="dark:text-gray-200 dark:border-gray-600">4M Ago</th>
            <th colSpan="2" style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, backgroundColor: '#FEE2E2', borderBottom: '1px solid #E5E7EB' }} className="dark:bg-red-900/20 dark:border-gray-600">
              <div>DoD</div>
              <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: '2px' }}>
                <span>Δ</span>
                <span>%Δ</span>
              </div>
            </th>
            <th colSpan="2" style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, backgroundColor: '#E0E7FF', borderBottom: '1px solid #E5E7EB' }} className="dark:bg-indigo-900/20 dark:border-gray-600">
              <div>YoY</div>
              <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: '2px' }}>
                <span>Δ</span>
                <span>%Δ</span>
              </div>
            </th>
            <th colSpan="2" style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 600, backgroundColor: '#D1FAE5', borderBottom: '1px solid #E5E7EB' }} className="dark:bg-green-900/20 dark:border-gray-600">
              <div>MoM</div>
              <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: '2px' }}>
                <span>Δ</span>
                <span>%Δ</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {VOLATILITY_DATA.map((row, index) => (
            <tr key={index} style={{ borderBottom: index < VOLATILITY_DATA.length - 1 ? '1px solid #E5E7EB' : 'none' }} className="dark:border-gray-700">
              <td style={{ padding: '4px 6px', fontWeight: 600 }} className="dark:text-gray-200">{row.series}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', color: '#1E40AF' }} className="dark:text-blue-400">{row.last}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">{row['1w']}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">{row['1m']}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center' }} className="dark:text-gray-300">{row['4m']}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#FEE2E2', fontWeight: 600, color: row.dod.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-red-900/20">{row.dod.value}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#FEE2E2', fontWeight: 600, color: row.dod.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-red-900/20">{row.dod.percent}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#E0E7FF', fontWeight: 600, color: row.yoy.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-indigo-900/20">{row.yoy.value}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#E0E7FF', fontWeight: 600, color: row.yoy.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-indigo-900/20">{row.yoy.percent}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#D1FAE5', fontWeight: 600, color: row.mom.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-green-900/20">{row.mom.value}</td>
              <td style={{ padding: '4px 6px', textAlign: 'center', backgroundColor: '#D1FAE5', fontWeight: 600, color: row.mom.isPositive ? '#059669' : '#DC2626' }} className="dark:bg-green-900/20">{row.mom.percent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const StaticMetricBar = () => {
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(true);

  // Fetch macro indicators
  const fetchMacroIndicators = async () => {
    try {
      setLoading(true);
      const data = await MarketDataService.getMacroIndicators();
      
      // Transform data to map by symbol
      const pricesMap = {};
      Object.keys(data).forEach(symbol => {
        const indicator = data[symbol];
        if (indicator && indicator.price !== null && indicator.price !== undefined) {
          pricesMap[symbol] = indicator.price;
        }
      });
      
      setPrices(pricesMap);
    } catch (error) {
      console.error('Error fetching macro indicators:', error);
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchMacroIndicators();
  }, []);

  // Set up polling interval (every 8 seconds, similar to SecuritiesList)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchMacroIndicators();
    }, 8000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        width: '100%',
        padding: '4px 0',
      }}
    >
      {/* Top Row - Major Daily Indicators */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${TOP_ROW_METRICS.length}, minmax(0, 1fr))`,
          gap: '6px',
          width: '100%',
        }}
      >
        {TOP_ROW_METRICS.map((label, index) => (
          <MetricBox
            key={`top-${index}`}
            label={label}
            value={prices[label]}
            loading={loading && !prices[label]}
          />
        ))}
      </div>

      {/* Volume Metrics and Yield Curve Section - Side by Side */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 2fr',
        gap: '12px',
        width: '100%',
      }}>
        {/* Left: Volume Metrics */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}>
          {/* Volume Title Ribbon */}
          <div style={{
            backgroundColor: '#059669',
            color: '#FFFFFF',
            padding: '4px 8px',
            fontSize: '10px',
            fontWeight: 600,
            textAlign: 'center',
            letterSpacing: '0.5px',
            borderRadius: '4px 4px 0 0',
            marginBottom: '4px',
          }}>
            VOLUME
          </div>
          {VOLUME_METRICS.map((metric, index) => (
            <VolumeMetricRow
              key={`volume-${index}`}
              label={metric.label}
              subLabel={metric.subLabel}
              values={metric.metrics}
            />
          ))}
        </div>

        {/* Right: Yield Curve and Volatility Tables */}
        <div>
          <YieldCurveTable />
          <VolatilityTable />
        </div>
      </div>

      {/* Bottom Row - Additional Metrics */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${ADDITIONAL_METRICS.length}, minmax(0, 1fr))`,
          gap: '6px',
          width: '100%',
        }}
      >
        {ADDITIONAL_METRICS.map((label, index) => (
          <MetricBox key={`additional-${index}`} label={label} />
        ))}
      </div>
    </div>
  );
};

export default StaticMetricBar;

