import React, { useState, useEffect } from 'react';
import { Card, Title } from '@tremor/react';
import { useTheme } from '../../context/ThemeContext';
import { BarChart2, FileText, Percent, PieChart, TrendingUp, DollarSign } from 'lucide-react';
import StatusDot from '../common/StatusDot';

const GROUPS = [
  { id: 'debt',  label: 'DEBT',      Icon: FileText,   bgColor: '#1e3a5f', rows: ['High Debt/EV', 'Low Debt/EV'] },
  { id: 'si',    label: 'SI',        Icon: BarChart2,  bgColor: '#1e3a5f', rows: ['High Short Interest', 'Low Short Interest'] },
  { id: 'beta',  label: 'BETA',      Icon: null, iconText: '\u03b2', bgColor: '#1e40af', rows: ['High Beta', 'Low Beta'] },
  { id: 'yield', label: 'YIELD',     Icon: Percent,    bgColor: '#78350f', rows: ['High Yield', 'Low Yield'] },
  { id: 'mcap',  label: 'MKT\nCAP', Icon: PieChart,   bgColor: '#4c1d95', rows: ['MCAP Bottom 25%', 'MCAP Top 25%'] },
  { id: 'sales', label: 'SALES',     Icon: TrendingUp, bgColor: '#1d4ed8', rows: ['Top 25% Sales Growth', 'Bottom 25% Sales Growth'] },
  { id: 'eps',   label: 'EPS',       Icon: DollarSign, bgColor: '#065f46', rows: ['Top 25% EPS Growth', 'Bottom 25% EPS Growth'] },
];

const COLUMNS = ['1D', '1W', '1M', '3M', '6M', 'YTD'];
const COLUMN_LABELS = ['1D\n% CHG', '1W\n% CHG', '1M\n% CHG', '3M\n% CHG', '6M\n% CHG', 'YTD\n% CHG'];

const STORAGE_KEY = 'styleFactorPerformanceData';

const getAllRowLabels = () => {
  const labels = [];
  GROUPS.forEach(group => {
    group.rows.forEach(row => labels.push(row));
  });
  return labels;
};

const getDefaultData = () => {
  const data = {};
  const rows = getAllRowLabels();
  rows.forEach(row => {
    data[row] = {};
    COLUMNS.forEach(col => {
      data[row][col] = '';
    });
  });
  return data;
};

const parseValue = (val) => {
  if (val === '' || val === null || val === undefined) return null;
  const num = parseFloat(val);
  return isNaN(num) ? null : num;
};

const getTopValuesPerColumn = (data) => {
  const topValues = {};
  COLUMNS.forEach(col => {
    const values = [];
    const rows = getAllRowLabels();
    rows.forEach(row => {
      const val = parseValue(data[row]?.[col]);
      if (val !== null) values.push({ row, val });
    });
    values.sort((a, b) => b.val - a.val);
    topValues[col] = new Set(values.slice(0, 2).map(v => v.row));
  });
  return topValues;
};

const StyleFactorPerformanceCard = () => {
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

  const topValues = getTopValuesPerColumn(data);

  const handleCellChange = (row, col, value) => {
    if (value === '' || /^-?\d*\.?\d*$/.test(value)) {
      setData(prev => ({
        ...prev,
        [row]: {
          ...prev[row],
          [col]: value
        }
      }));
    }
  };

  const formatDisplay = (value) => {
    if (value === '' || value === null || value === undefined) return '';
    const num = parseFloat(value);
    if (isNaN(num)) return value;
    return num > 0 ? `+${num}%` : `${num}%`;
  };

  const renderCell = (row, col) => {
    const value = data[row]?.[col] || '';
    const isTop = topValues[col]?.has(row);
    const bgColor = isTop ? (isDark ? '#059669' : '#10b981') : 'transparent';
    const textColor = isTop ? '#ffffff' : (isDark ? '#d1d5db' : '#374151');

    return (
      <div
        key={`${row}-${col}`}
        style={{
          backgroundColor: bgColor,
          borderLeft: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          minWidth: '60px',
          height: '24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <input
          type="text"
          value={value}
          placeholder="-"
          onChange={(e) => handleCellChange(row, col, e.target.value)}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            backgroundColor: 'transparent',
            color: textColor,
            textAlign: 'right',
            fontSize: '11px',
            fontWeight: isTop ? 600 : 400,
            fontFamily: 'monospace',
            outline: 'none',
            padding: '0 6px'
          }}
        />
      </div>
    );
  };

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
          padding: '10px 12px',
          borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          backgroundColor: isDark ? '#1f2937' : '#ffffff'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
          <TrendingUp size={14} color={isDark ? '#60a5fa' : '#2563eb'} strokeWidth={2.5} style={{ flexShrink: 0 }} />
          <Title
            style={{
              fontSize: '13px',
              fontWeight: 800,
              color: isDark ? '#f9fafb' : '#111827',
              margin: 0,
              textTransform: 'uppercase',
              letterSpacing: '0.04em'
            }}
          >
            Factor Performance
          </Title>
          <div style={{ marginLeft: 'auto' }}>
            <StatusDot
              updatedAt={null}
              status="active"
              size={9}
              label="Style Factor Performance (manually maintained)"
            />
          </div>
        </div>
      </div>

      {/* Table Header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '34px 140px repeat(6, 60px)',
          borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,

          backgroundColor: isDark ? '#1f2937' : '#f9fafb'
        }}
      >
        <div style={{ borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}` }} />
        <div
          style={{
            padding: '6px 8px',
            fontSize: '10px',
            fontWeight: 700,
            color: isDark ? '#9ca3af' : '#6b7280',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
            display: 'flex',
            alignItems: 'center'
          }}
        >
          FACTOR
        </div>
        {COLUMN_LABELS.map((label, idx) => (
          <div
            key={COLUMNS[idx]}
            style={{
              padding: '4px',
              fontSize: '9px',
              fontWeight: 700,
              color: isDark ? '#9ca3af' : '#6b7280',
              textAlign: 'center',
              borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              lineHeight: 1.2
            }}
          >
            {label.split('\n').map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </div>
        ))}
      </div>

      {/* Data Rows */}
      <div style={{ flex: 1 }}>
        {GROUPS.map((group, groupIdx) => (
          <div
            key={group.id}
            style={{
              display: 'flex',
              borderBottom: groupIdx !== GROUPS.length - 1
                ? `2px solid ${isDark ? '#4b5563' : '#d1d5db'}`
                : `1px solid ${isDark ? '#374151' : '#e5e7eb'}`
            }}
          >
            {/* Icon Badge - spans full group height */}
            <div style={{
              width: '34px',
              flexShrink: 0,
              backgroundColor: group.bgColor,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`
            }}>
              {group.Icon
                ? <group.Icon size={11} color="#ffffff" strokeWidth={2.5} />
                : <span style={{ fontSize: '13px', fontWeight: 700, color: '#ffffff', lineHeight: 1 }}>{group.iconText}</span>
              }
              <span style={{
                fontSize: '6px',
                fontWeight: 700,
                color: 'rgba(255,255,255,0.9)',
                textTransform: 'uppercase',
                textAlign: 'center',
                lineHeight: 1.1,
                whiteSpace: 'pre-line'
              }}>
                {group.label}
              </span>
            </div>
            {/* Rows */}
            <div style={{ flex: 1 }}>
              {group.rows.map((row, rowIdx) => (
                <div
                  key={row}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '140px repeat(6, 60px)',
                    borderBottom: rowIdx !== group.rows.length - 1
                      ? `1px solid ${isDark ? '#374151' : '#e5e7eb'}`
                      : 'none'
                  }}
                >
                  {/* Row Label */}
                  <div style={{
                    padding: '4px 8px',
                    fontSize: '10px',
                    fontWeight: 500,
                    color: isDark ? '#d1d5db' : '#374151',
                    borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                    display: 'flex',
                    alignItems: 'center',
                    backgroundColor: isDark ? '#1f2937' : '#ffffff'
                  }}>
                    {row}
                  </div>
                  {/* Data Cells */}
                  {COLUMNS.map(col => renderCell(row, col))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '6px 12px',
          fontSize: '9px',
          fontStyle: 'italic',
          color: isDark ? '#9ca3af' : '#6b7280',
          borderTop: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          backgroundColor: isDark ? '#1f2937' : '#f9fafb'
        }}
      >
        *Mean Performance of Top Quartile vs. Bottom Quartile, S&P500 Companies
      </div>
    </Card>
  );
};

export default StyleFactorPerformanceCard;
