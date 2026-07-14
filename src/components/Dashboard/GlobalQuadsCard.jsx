import React, { useState } from 'react';
import { Card, Title } from '@tremor/react';
import { useTheme } from '../../context/ThemeContext';

// Country flag emoji helper
const FLAG = {
  'Argentina':      '🇦🇷',
  'Australia':      '🇦🇺',
  'Brazil':         '🇧🇷',
  'Canada':         '🇨🇦',
  'Chile':          '🇨🇱',
  'China':          '🇨🇳',
  'Colombia':       '🇨🇴',
  'Czech Republic': '🇨🇿',
  'France':         '🇫🇷',
  'Germany':        '🇩🇪',
  'Greece':         '🇬🇷',
  'Hong Kong':      '🇭🇰',
  'India':          '🇮🇳',
  'Indonesia':      '🇮🇩',
  'Israel':         '🇮🇱',
  'Italy':          '🇮🇹',
  'Japan':          '🇯🇵',
  'Malaysia':       '🇲🇾',
  'Mexico':         '🇲🇽',
  'Peru':           '🇵🇪',
  'Philippines':    '🇵🇭',
  'Poland':         '🇵🇱',
  'Russia':         '🇷🇺',
  'Saudi Arabia':   '🇸🇦',
  'Singapore':      '🇸🇬',
  'South Africa':   '🇿🇦',
  'South Korea':    '🇰🇷',
  'Spain':          '🇪🇸',
  'Taiwan':         '🇹🇼',
  'Thailand':       '🇹🇭',
  'Turkey':         '🇹🇷',
  'United Kingdom': '🇬🇧',
  'United States':  '🇺🇸',
};

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
const UPDATED_AT_STORAGE_KEY = `${STORAGE_KEY}.lastEditedAt`;

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

// Colors derived directly from the QUAD logo letters:
// Q=#008000 (Quad1), U=#7CB342 (Quad2), A=#FFC107 (Quad3), D=#FE0000 (Quad4)
const QUAD_COLORS = {
  '1': { bg: '#008000', text: '#ffffff' }, // Q - dark green
  '2': { bg: '#7CB342', text: '#ffffff' }, // U - light green
  '3': { bg: '#FFC107', text: '#1a1a1a' }, // A - amber (dark text for contrast)
  '4': { bg: '#FE0000', text: '#ffffff' }, // D - red
};

const getCellColor = (value) => {
  return QUAD_COLORS[value]?.bg || 'transparent';
};

const getCellTextColor = (value) => {
  if (!value) return null;
  return QUAD_COLORS[value]?.text || '#ffffff';
};

const getTextColor = (value, isDark) => {
  if (!value) return isDark ? '#9ca3af' : '#6b7280';
  return getCellTextColor(value) || '#ffffff';
};

const GlobalQuadsCard = () => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const [data, setData] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try { return JSON.parse(saved); } catch (e) { return getDefaultData(); }
      }
    }
    return getDefaultData();
  });
  const [lastEditedAt, setLastEditedAt] = useState(() => (
    typeof window !== 'undefined' ? localStorage.getItem(UPDATED_AT_STORAGE_KEY) : null
  ));

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  }, [data]);

  const handleCellChange = (country, quarter, value) => {
    if (value === '' || /^[1-4]$/.test(value)) {
      const editedAt = new Date().toISOString();
      setData(prev => ({ ...prev, [country]: { ...prev[country], [quarter]: value } }));
      setLastEditedAt(editedAt);
      if (typeof window !== 'undefined') {
        localStorage.setItem(UPDATED_AT_STORAGE_KEY, editedAt);
      }
    }
  };

  const border = `1px solid ${isDark ? '#374151' : 'var(--dashboard-border-soft, #e6eef5)'}`;
  const bg = isDark ? '#1f2937' : '#ffffff';
  const bgHeader = isDark ? '#111827' : '#f8fafc';

  const renderCell = (country, quarter) => {
    const value = data[country]?.[quarter] || '';
    const bgColor = getCellColor(value);
    const textColor = getTextColor(value, isDark);
    const isEst = ESTIMATES_QUARTERS.includes(quarter);
    return (
      <div
        key={`${country}-${quarter}`}
        style={{
          backgroundColor: bgColor || (isEst ? (isDark ? '#1e2a3a' : '#f0f6ff') : bg),
          borderRight: border,
          borderBottom: border,
          minWidth: COLUMN_WIDTH,
          height: '26px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => handleCellChange(country, quarter, e.target.value)}
          style={{
            width: '100%', height: '100%', border: 'none',
            backgroundColor: 'transparent',
            color: value ? textColor : (isDark ? '#4b5563' : '#d1d5db'),
            textAlign: 'center', fontSize: '12px', fontWeight: 700,
            fontFamily: 'monospace', outline: 'none', padding: 0, cursor: 'text',
          }}
          maxLength={1}
        />
      </div>
    );
  };

  const renderCountryRow = (country, regionWidth) => (
    <div
      key={country.name}
      style={{ display: 'flex', borderBottom: border }}
    >
      <div style={{
        width: regionWidth, flexShrink: 0, padding: '3px 8px',
        fontSize: '11px', fontWeight: 500,
        color: isDark ? '#d1d5db' : '#374151',
        display: 'flex', alignItems: 'center', gap: '5px',
        borderRight: border, backgroundColor: bg,
      }}>
        <span style={{ fontSize: '13px', lineHeight: 1, flexShrink: 0 }}>{FLAG[country.name] || '🏳️'}</span>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{country.name}</span>
      </div>
      {QUARTERS.map(q => renderCell(country.name, q))}
    </div>
  );

  const renderModeMedianRow = (key, regionWidth) => (
    <div style={{ display: 'flex', borderTop: `2px solid ${isDark ? '#374151' : '#cbd5e1'}` }}>
      <div style={{
        width: regionWidth, flexShrink: 0, padding: '5px 8px',
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.04em',
        color: isDark ? '#93c5fd' : '#1d4ed8',
        display: 'flex', alignItems: 'center',
        borderRight: border,
        backgroundColor: isDark ? '#172035' : '#eff6ff',
      }}>
        MODE / MEDIAN
      </div>
      {QUARTERS.map(q => {
        const val = data[key]?.[q] || '';
        const mmBg = val ? getCellColor(val) : (isDark ? '#172035' : '#eff6ff');
        const mmText = val ? getTextColor(val, isDark) : (isDark ? '#93c5fd' : '#1d4ed8');
        const isEst = ESTIMATES_QUARTERS.includes(q);
        return (
          <div key={q} style={{
            backgroundColor: mmBg || (isEst ? (isDark ? '#1a2d45' : '#e0eeff') : (isDark ? '#172035' : '#eff6ff')),
            borderRight: border, minWidth: COLUMN_WIDTH, height: '28px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <input
              type="text"
              value={val}
              onChange={(e) => handleCellChange(key, q, e.target.value)}
              style={{
                width: '100%', height: '100%', border: 'none',
                backgroundColor: 'transparent', color: mmText,
                textAlign: 'center', fontSize: '12px', fontWeight: 700,
                fontFamily: 'monospace', outline: 'none', padding: 0,
              }}
              maxLength={1}
            />
          </div>
        );
      })}
    </div>
  );

  const renderTableHeader = (sectionLabel, regionWidth) => (
    <div style={{ flexShrink: 0 }}>
      {/* Row 1: section label | ACTUALS (9 cols) | ESTIMATES (4 cols) */}
      <div style={{ display: 'flex', borderBottom: border, backgroundColor: bgHeader }}>
        <div style={{
          width: regionWidth, flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: '5px',
          padding: '7px 8px', borderRight: border,
          fontSize: '12px', fontWeight: 800,
          color: isDark ? '#f3f4f6' : '#111827',
          backgroundColor: isDark ? '#374151' : '#e2e8f0',
        }}>
          <span style={{ fontSize: '14px' }}>🌐</span>
          <span>{sectionLabel}</span>
        </div>
        <div style={{
          width: `calc(${COLUMN_WIDTH} * 9)`, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em',
          color: isDark ? '#9ca3af' : '#64748b',
          textTransform: 'uppercase',
          borderRight: border,
          backgroundColor: isDark ? '#1f2937' : '#f1f5f9',
        }}>
          ACTUALS
        </div>
        <div style={{
          width: `calc(${COLUMN_WIDTH} * 4)`, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em',
          color: isDark ? '#60a5fa' : '#2563eb',
          textTransform: 'uppercase',
          backgroundColor: isDark ? '#1e2d45' : '#dbeafe',
        }}>
          ESTIMATES
        </div>
      </div>
      {/* Row 2: quarter labels */}
      <div style={{ display: 'flex', borderBottom: `2px solid ${isDark ? '#374151' : '#cbd5e1'}`, backgroundColor: isDark ? '#1f2937' : '#f8fafc' }}>
        <div style={{ width: regionWidth, flexShrink: 0, borderRight: border }} />
        {ACTUALS_QUARTERS.map(q => (
          <div key={q} style={{
            minWidth: COLUMN_WIDTH, flexShrink: 0,
            padding: '5px 2px', fontSize: '10px', fontWeight: 600,
            color: isDark ? '#9ca3af' : '#64748b',
            textAlign: 'center', borderRight: border, fontFamily: 'monospace',
          }}>{q}</div>
        ))}
        {ESTIMATES_QUARTERS.map(q => (
          <div key={q} style={{
            minWidth: COLUMN_WIDTH, flexShrink: 0,
            padding: '5px 2px', fontSize: '10px', fontWeight: 700,
            color: isDark ? '#60a5fa' : '#2563eb',
            textAlign: 'center', borderRight: border, fontFamily: 'monospace',
            backgroundColor: isDark ? '#1e2d45' : '#eff6ff',
          }}>{q}</div>
        ))}
      </div>
    </div>
  );

  return (
    <Card
      className={isDark ? 'dark:bg-gray-800' : ''}
      style={{
        border: `1px solid ${isDark ? '#374151' : 'var(--dashboard-border, #d7e5ef)'}`,
        borderRadius: 'var(--dashboard-radius, 6px)',
        boxShadow: isDark ? undefined : 'var(--dashboard-shadow, 0 1px 3px rgba(15, 23, 42, 0.08))',
        padding: 0,
        height: '100%',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      {/* Card Header */}
      <div style={{
        padding: '6px 10px',
        borderBottom: border,
        backgroundColor: isDark ? '#1f2937' : '#ffffff',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexShrink: 0,
      }}>
        {/* Left: QUAD logo + title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            fontFamily: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
            lineHeight: 1, fontSize: '20px', display: 'flex', flexDirection: 'column', userSelect: 'none',
          }}>
            <div style={{ display: 'flex' }}>
              <span style={{ color: '#008000' }}>Q</span>
              <span style={{ color: '#7CB342' }}>U</span>
            </div>
            <div style={{ display: 'flex' }}>
              <span style={{ color: '#FFC107' }}>A</span>
              <span style={{ color: '#FE0000' }}>D</span>
            </div>
          </div>
          <Title style={{ fontSize: '14px', fontWeight: 700, color: isDark ? '#f9fafb' : '#111827', margin: 0 }}>
            Global Quad Forecast
          </Title>
        </div>
        {/* Right: legend pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            title={lastEditedAt ? `Last manually edited ${new Date(lastEditedAt).toLocaleString()}` : 'Manually maintained; no saved edit timestamp'}
            style={{
              display: 'inline-flex', alignItems: 'center', border: '1px solid #cbd5e1',
              borderRadius: '4px', padding: '2px 6px', color: isDark ? '#cbd5e1' : '#64748b',
              background: isDark ? '#1f2937' : '#f8fafc', fontSize: '9px', fontWeight: 700,
              letterSpacing: '0.04em', whiteSpace: 'nowrap',
            }}
          >
            MANUAL · {lastEditedAt ? new Date(lastEditedAt).toLocaleDateString() : 'NO AS-OF'}
          </span>
          {[
            { val: '1', label: 'Goldilocks',  desc: '(↑ growth, ↓ inflation)' },
            { val: '2', label: 'Reflation',   desc: '(↑ both)' },
            { val: '3', label: 'Stagflation', desc: '(↓ growth, ↑ inflation)' },
            { val: '4', label: 'Deflation',   desc: '(↓ both)' },
          ].map(({ val, label, desc }) => (
            <span key={val} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: '17px', height: '17px', borderRadius: '4px',
                backgroundColor: QUAD_COLORS[val].bg, color: QUAD_COLORS[val].text,
                fontSize: '10px', fontWeight: 800, fontFamily: 'monospace', flexShrink: 0,
              }}>{val}</span>
              <span style={{ fontSize: '10px', fontWeight: 600, color: isDark ? '#e5e7eb' : '#374151' }}>{label}</span>
              <span style={{ fontSize: '10px', color: isDark ? '#6b7280' : '#9ca3af' }}>{desc}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Side-by-Side Tables */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', gap: 0 }}>
        {/* G20 Table */}
        <div style={{ flex: 1, minWidth: 0, borderRight: `2px solid ${isDark ? '#4b5563' : '#cbd5e1'}` }}>
          {renderTableHeader('G20', G20_REGION_WIDTH)}
          <div>
            {G20_COUNTRIES.map(c => renderCountryRow(c, G20_REGION_WIDTH))}
            {/* ellipsis separator */}
            <div style={{
              display: 'flex', borderBottom: border,
              padding: '3px 10px', fontSize: '11px',
              color: isDark ? '#6b7280' : '#9ca3af',
              backgroundColor: isDark ? '#1a2535' : '#f8fafc',
            }}>…</div>
            {renderModeMedianRow('G20_MODE/MEDIAN', G20_REGION_WIDTH)}
          </div>
        </div>

        {/* EM Table */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {renderTableHeader('EM', EM_REGION_WIDTH)}
          <div>
            {EM_COUNTRIES.map(c => renderCountryRow(c, EM_REGION_WIDTH))}
            <div style={{
              display: 'flex', borderBottom: border,
              padding: '3px 10px', fontSize: '11px',
              color: isDark ? '#6b7280' : '#9ca3af',
              backgroundColor: isDark ? '#1a2535' : '#f8fafc',
            }}>…</div>
            {renderModeMedianRow('EM_MODE/MEDIAN', EM_REGION_WIDTH)}
          </div>
        </div>
      </div>
    </Card>
  );
};

export default GlobalQuadsCard;
