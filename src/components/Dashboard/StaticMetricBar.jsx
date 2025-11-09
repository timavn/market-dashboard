import React from 'react';
import { Text } from '@tremor/react';

// Metric boxes configuration
const TOP_ROW_METRICS = [
  'Total Market Volume',
  'VIX',
  'gamma',
  '', // Empty placeholder
  '', // Empty placeholder
  '', // Empty placeholder
  '', // Empty placeholder
  '', // Empty placeholder
  '', // Empty placeholder
];

const BOTTOM_ROW_METRICS = [
  'usd',
  'gold',
  '10 yr',
  'dr cap, crb',
  'oil',
  'SP500',
  'nasdaq',
  'russell 2000',
];

const MetricBox = ({ label }) => {
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
        
        {/* Metric value (placeholder 0s for now) */}
        <Text
          style={{
            fontSize: '14px',
            fontWeight: 600,
            color: '#000000',
            marginLeft: 'auto',
          }}
          className="dark:text-gray-200"
        >
          0
        </Text>
      </div>
    </div>
  );
};

const StaticMetricBar = () => {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        width: '100%',
        padding: '4px 0',
      }}
    >
      {/* Top Row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(9, minmax(0, 1fr))',
          gap: '6px',
          width: '100%',
        }}
      >
        {TOP_ROW_METRICS.map((label, index) => (
          <MetricBox key={`top-${index}`} label={label} />
        ))}
      </div>

      {/* Bottom Row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
          gap: '6px',
          width: '100%',
        }}
      >
        {BOTTOM_ROW_METRICS.map((label, index) => (
          <MetricBox key={`bottom-${index}`} label={label} />
        ))}
      </div>
    </div>
  );
};

export default StaticMetricBar;

