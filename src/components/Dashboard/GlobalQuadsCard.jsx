import React, { useState, useEffect } from 'react';
import { Card, Title } from '@tremor/react';
import { useTheme } from '../../context/ThemeContext';

const QUARTERS = [
  '1Q24', '2Q24', '3Q24', '4Q24',
  '1Q25', '2Q25', '3Q25', '4Q25',
  '1Q26', '2Q26E', '3Q26E', '4Q26E', '1Q27E'
];

const ACTUALS_QUARTERS = QUARTERS.slice(0, 9);
const ESTIMATES_QUARTERS = QUARTERS.slice(9);

const COLUMN_WIDTH = '48px';
const G20_REGION_WIDTH = '110px';
const EM_REGION_WIDTH = '110px';

// G20 Countries (left side) - from G20 GIP Model Summary image
const G20_COUNTRIES = [
  { name: 'Argentina' },
  { name: 'Australia' },
  { name: 'Brazil' },
  { name: 'Canada' },
  { name: 'China' },
  { name: 'France' },
  { name: 'Germany' },
  { name: 'India' },
  { name: 'Indonesia' },
  { name: 'Italy' },
  { name: 'Japan' },
  { name: 'Mexico' },
  { name: 'Russia' },
  { name: 'South Africa' },
  { name: 'South Korea' },
  { name: 'Spain' },
  { name: 'Turkey' },
  { name: 'United Kingdom' },
  { name: 'United States' },
];

// EM Countries (right side) - from Emerging Market GIP Model Summary image
const EM_COUNTRIES = [
  { name: 'Argentina' },
  { name: 'Brazil' },
  { name: 'Chile' },
  { name: 'China' },
  { name: 'Colombia' },
  { name: 'Czech Republic' },
  { name: 'Greece' },
  { name: 'Hong Kong' },
  { name: 'India' },
  { name: 'Indonesia' },
  { name: 'Israel' },
  { name: 'Malaysia' },
  { name: 'Mexico' },
  { name: 'Peru' },
  { name: 'Philippines' },
  { name: 'Poland' },
  { name: 'Russia' },
  { name: 'Saudi Arabia' },
  { name: 'Singapore' },
  { name: 'South Africa' },
  { name: 'South Korea' },
  { name: 'Taiwan' },
  { name: 'Thailand' },
  { name: 'Turkey' },
];

const STORAGE_KEY = 'quadForecast_v3';

const getDefaultData = () => {
  const data = {};
  // Initialize G20 countries
  G20_COUNTRIES.forEach(country => {
    data[country.name] = {};
    QUARTERS.forEach(q => {
      data[country.name][q] = '';
    });
  });
  // Initialize EM countries
  EM_COUNTRIES.forEach(country => {
    data[country.name] = {};
    QUARTERS.forEach(q => {
      data[country.name][q] = '';
    });
  });
  // Add MODE/MEDIAN rows for both sections
  data['G20_MODE/MEDIAN'] = {};
  data['EM_MODE/MEDIAN'] = {};
  QUARTERS.forEach(q => {
    data['G20_MODE/MEDIAN'][q] = '';
    data['EM_MODE/MEDIAN'][q] = '';
  });
  return data;
};

const getCellColor = (value, isDark) => {
  switch (value) {
    case '1':
      return isDark ? '#059669' : '#10b981'; // green-600 / green-500
    case '2':
      return isDark ? '#4ade80' : '#86efac'; // green-400 / green-300
    case '3':
      return isDark ? '#fbbf24' : '#f59e0b'; // amber-400 / amber-500
    case '4':
      return isDark ? '#dc2626' : '#ef4444'; // red-600 / red-500
    default:
      return 'transparent';
  }
};

const getTextColor = (value, isDark) => {
  if (!value) return isDark ? '#9ca3af' : '#6b7280';
  return '#ffffff';
};

const GlobalQuadsCard = () => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  
  const [data, setData] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) {
          return getDefaultData();
        }
      }
    }
    return getDefaultData();
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  }, [data]);

  const handleCellChange = (country, quarter, value) => {
    if (value === '' || /^[1-4]$/.test(value)) {
      setData(prev => ({
        ...prev,
        [country]: {
          ...prev[country],
          [quarter]: value
        }
      }));
    }
  };

  const renderCell = (country, quarter) => {
    const value = data[country]?.[quarter] || '';
    const bgColor = getCellColor(value, isDark);
    const textColor = getTextColor(value, isDark);
    
    return (
      <div
        key={`${country}-${quarter}`}
        style={{
          backgroundColor: bgColor,
          border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          minWidth: COLUMN_WIDTH,
          height: '28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => handleCellChange(country, quarter, e.target.value)}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            backgroundColor: 'transparent',
            color: textColor,
            textAlign: 'center',
            fontSize: '12px',
            fontWeight: 600,
            fontFamily: 'monospace',
            outline: 'none',
            padding: 0
          }}
          maxLength={1}
        />
      </div>
    );
  };

  // Render functions for G20 table
  const renderG20CountryRow = (country) => (
    <div
      key={country.name}
      style={{
        display: 'grid',
        gridTemplateColumns: `${G20_REGION_WIDTH} repeat(13, ${COLUMN_WIDTH})`,
        borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`
      }}
    >
      <div
        style={{
          padding: '4px 8px',
          fontSize: '11px',
          fontWeight: 400,
          color: isDark ? '#d1d5db' : '#374151',
          display: 'flex',
          alignItems: 'center',
          borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          backgroundColor: isDark ? '#1f2937' : '#ffffff'
        }}
      >
        {country.name}
      </div>
      {QUARTERS.map(q => renderCell(country.name, q))}
    </div>
  );

  const renderG20ModeMedianRow = () => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${G20_REGION_WIDTH} repeat(13, ${COLUMN_WIDTH})`,
        borderBottom: 'none'
      }}
    >
      <div
        style={{
          padding: '6px 8px',
          fontSize: '10px',
          fontWeight: 700,
          color: '#ffffff',
          backgroundColor: isDark ? '#1e40af' : '#3b82f6',
          display: 'flex',
          alignItems: 'center',
          borderRight: `1px solid ${isDark ? '#1e3a8a' : '#2563eb'}`
        }}
      >
        MODE/MEDIAN
      </div>
      {QUARTERS.map(q => (
        <div
          key={q}
          style={{
            backgroundColor: isDark ? '#1e40af' : '#3b82f6',
            borderRight: `1px solid ${isDark ? '#1e3a8a' : '#2563eb'}`,
            minWidth: COLUMN_WIDTH,
            height: '28px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <input
            type="text"
            value={data['G20_MODE/MEDIAN']?.[q] || ''}
            onChange={(e) => handleCellChange('G20_MODE/MEDIAN', q, e.target.value)}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              backgroundColor: 'transparent',
              color: '#ffffff',
              textAlign: 'center',
              fontSize: '12px',
              fontWeight: 700,
              fontFamily: 'monospace',
              outline: 'none',
              padding: 0
            }}
            maxLength={1}
          />
        </div>
      ))}
    </div>
  );

  // Render functions for EM table
  const renderEMCountryRow = (country) => (
    <div
      key={country.name}
      style={{
        display: 'grid',
        gridTemplateColumns: `${EM_REGION_WIDTH} repeat(13, ${COLUMN_WIDTH})`,
        borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`
      }}
    >
      <div
        style={{
          padding: '4px 8px',
          fontSize: '11px',
          fontWeight: 400,
          color: isDark ? '#d1d5db' : '#374151',
          display: 'flex',
          alignItems: 'center',
          borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          backgroundColor: isDark ? '#1f2937' : '#ffffff'
        }}
      >
        {country.name}
      </div>
      {QUARTERS.map(q => renderCell(country.name, q))}
    </div>
  );

  const renderEMModeMedianRow = () => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${EM_REGION_WIDTH} repeat(13, ${COLUMN_WIDTH})`,
        borderBottom: 'none'
      }}
    >
      <div
        style={{
          padding: '6px 8px',
          fontSize: '10px',
          fontWeight: 700,
          color: '#ffffff',
          backgroundColor: isDark ? '#1e40af' : '#3b82f6',
          display: 'flex',
          alignItems: 'center',
          borderRight: `1px solid ${isDark ? '#1e3a8a' : '#2563eb'}`
        }}
      >
        MODE/MEDIAN
      </div>
      {QUARTERS.map(q => (
        <div
          key={q}
          style={{
            backgroundColor: isDark ? '#1e40af' : '#3b82f6',
            borderRight: `1px solid ${isDark ? '#1e3a8a' : '#2563eb'}`,
            minWidth: COLUMN_WIDTH,
            height: '28px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <input
            type="text"
            value={data['EM_MODE/MEDIAN']?.[q] || ''}
            onChange={(e) => handleCellChange('EM_MODE/MEDIAN', q, e.target.value)}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              backgroundColor: 'transparent',
              color: '#ffffff',
              textAlign: 'center',
              fontSize: '12px',
              fontWeight: 700,
              fontFamily: 'monospace',
              outline: 'none',
              padding: 0
            }}
            maxLength={1}
          />
        </div>
      ))}
    </div>
  );

  // Render table header for a section
  const renderTableHeader = (sectionLabel, regionWidth) => (
    <div style={{ flexShrink: 0 }}>
      {/* Top Tier - Section Label */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `${regionWidth} repeat(9, ${COLUMN_WIDTH}) repeat(4, ${COLUMN_WIDTH})`,
          borderBottom: `1px solid ${isDark ? '#4b5563' : '#d1d5db'}`,
          backgroundColor: isDark ? '#111827' : '#f3f4f6'
        }}
      >
        <div
          style={{
            padding: '10px 8px',
            fontSize: '12px',
            fontWeight: 700,
            color: isDark ? '#f9fafb' : '#111827',
            textAlign: 'center',
            borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: isDark ? '#374151' : '#e5e7eb'
          }}
        >
          {sectionLabel}
        </div>
        {/* Actuals Header - spans 9 columns */}
        <div
          style={{
            gridColumn: 'span 9',
            padding: '10px',
            fontSize: '12px',
            fontWeight: 700,
            color: isDark ? '#f9fafb' : '#111827',
            textAlign: 'center',
            borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
            borderBottom: `2px solid ${isDark ? '#4b5563' : '#9ca3af'}`,
            backgroundColor: isDark ? '#1f2937' : '#e5e7eb'
          }}
        >
          Actuals
        </div>
        {/* Estimates Header - spans 4 columns */}
        <div
          style={{
            gridColumn: 'span 4',
            padding: '10px',
            fontSize: '12px',
            fontWeight: 700,
            color: isDark ? '#f9fafb' : '#111827',
            textAlign: 'center',
            borderBottom: `2px solid ${isDark ? '#3b82f6' : '#60a5fa'}`,
            backgroundColor: isDark ? '#1e3a8a' : '#dbeafe'
          }}
        >
          Estimates
        </div>
      </div>

      {/* Second Tier - Quarter Labels */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `${regionWidth} repeat(13, ${COLUMN_WIDTH})`,
          borderBottom: `2px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          backgroundColor: isDark ? '#1f2937' : '#f9fafb'
        }}
      >
        <div
          style={{
            borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`
          }}
        />
        {ACTUALS_QUARTERS.map(q => (
          <div
            key={q}
            style={{
              padding: '8px 2px',
              fontSize: '11px',
              fontWeight: 600,
              color: isDark ? '#9ca3af' : '#4b5563',
              textAlign: 'center',
              borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
              fontFamily: 'monospace'
            }}
          >
            {q}
          </div>
        ))}
        {ESTIMATES_QUARTERS.map(q => (
          <div
            key={q}
            style={{
              padding: '8px 2px',
              fontSize: '11px',
              fontWeight: 600,
              color: '#3b82f6',
              textAlign: 'center',
              borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
              fontFamily: 'monospace'
            }}
          >
            {q}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Card
      className={isDark ? 'dark:bg-gray-800' : ''}
      style={{
        border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
        borderRadius: '0.5rem',
        padding: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '8px 16px',
          borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          backgroundColor: isDark ? '#1f2937' : '#f9fafb',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* QUAD Logo */}
          <div
            style={{
              fontFamily: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
              lineHeight: 1,
              fontSize: '20px',
              display: 'flex',
              flexDirection: 'column',
              userSelect: 'none',
            }}
          >
            <div style={{ display: 'flex' }}>
              <span style={{ color: '#008000' }}>Q</span>
              <span style={{ color: '#7CB342' }}>U</span>
            </div>
            <div style={{ display: 'flex' }}>
              <span style={{ color: '#FFC107' }}>A</span>
              <span style={{ color: '#FE0000' }}>D</span>
            </div>
          </div>
          <Title
            style={{
              fontSize: '14px',
              fontWeight: 600,
              color: isDark ? '#f9fafb' : '#111827',
              margin: 0
            }}
          >
            Global Quad Forecast
          </Title>
        </div>
        <div style={{ fontSize: '10px', color: isDark ? '#9ca3af' : '#6b7280' }}>
          1=Goldilocks (↑growth, ↓inflation) | 2=Reflation (↑both) | 3=Stagflation (↓growth, ↑inflation) | 4=Deflation (↓both)
        </div>
      </div>

      {/* Side-by-Side Tables */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', gap: '1px' }}>
        {/* G20 Table */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {renderTableHeader('G20', G20_REGION_WIDTH)}
          
          {/* G20 Data - flat list */}
          <div>
            {G20_COUNTRIES.map(renderG20CountryRow)}
            {renderG20ModeMedianRow()}
          </div>
        </div>

        {/* EM Table */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {renderTableHeader('EM', EM_REGION_WIDTH)}
          
          {/* EM Data - flat list */}
          <div>
            {EM_COUNTRIES.map(renderEMCountryRow)}
            {renderEMModeMedianRow()}
          </div>
        </div>
      </div>
    </Card>
  );
};

export default GlobalQuadsCard;
