import React, { useState, useEffect } from 'react';
import { Card, Title, Text, Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell, Badge } from '@tremor/react';
import { Info, TrendingUp, RefreshCw, DollarSign, Package, LayoutGrid, ArrowUp, ArrowDown, Grid } from 'lucide-react';
import StatusDot from '../common/StatusDot';
import axios from 'axios';
import { useTheme } from '../../context/ThemeContext';

const CATEGORY_META = {
  EQUITIES:    { Icon: TrendingUp,  color: '#2563eb', bgLight: '#eff6ff',  bgDark: 'rgba(37,99,235,0.12)',   label: 'EQUITIES'    },
  RATES:       { Icon: RefreshCw,   color: '#7c3aed', bgLight: '#f5f3ff',  bgDark: 'rgba(124,58,237,0.12)',  label: 'RATES'       },
  CURRENCIES:  { Icon: DollarSign,  color: '#d97706', bgLight: '#fffbeb',  bgDark: 'rgba(217,119,6,0.12)',   label: 'CURRENCIES'  },
  COMMODITIES: { Icon: Package,     color: '#059669', bgLight: '#ecfdf5',  bgDark: 'rgba(5,150,105,0.12)',   label: 'COMMODITIES' },
  OTHER:       { Icon: LayoutGrid,  color: '#6b7280', bgLight: '#f3f4f6',  bgDark: 'rgba(107,114,128,0.12)', label: 'UNKNOWN'     },
};

const METRIC_EMOJI = {
  'Corn':        '🌽',
  'Wheat':       '🌾',
  'Lean Hogs':   '🐷',
  'Sugar':       '🍬',
  'Cotton':      '🧶',
  'Coffee':      '☕',
  'Cocoa':       '🍫',
  'Orange Juice':'🍊',
  'Soybeans':    '🫘',
  'Gold':        '🥇',
  'Silver':      '🥈',
  'Copper':      '🟤',
  'Crude Oil':   '🛢️',
  'Natural Gas': '🔥',
  'Bitcoin':     '₿',
  'Ethereum':    '⬡',
};

const CFTCNetLongCard = () => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
        // Fetch the latest CFTC positioning snapshot
        const response = await axios.get(`${backendUrl}/api/hedgeye/snapshot/cftc-positioning`);
        setData(response.data);
      } catch (err) {
        console.error('Error fetching CFTC data:', err);
        setError('Failed to load CFTC data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    // Refresh every 15 minutes
    const interval = setInterval(fetchData, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const formatNumber = (num, isPercent = false) => {
    if (num === null || num === undefined) return '--';
    const n = Number(num);
    return isPercent ? `${n.toFixed(2)}%` : n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  const formatZScore = (num) => {
    if (num === null || num === undefined) return '--';
    return Number(num).toFixed(2);
  };

  const getZScoreColor = (z) => {
    if (z === null || z === undefined) return isDark ? '#9ca3af' : '#6b7280';
    if (z > 2) return '#10b981'; // Very positive (green)
    if (z > 1) return isDark ? '#34d399' : '#059669'; // Positive (light green)
    if (z < -2) return '#ef4444'; // Very negative (red)
    if (z < -1) return isDark ? '#f87171' : '#dc2626'; // Negative (light red)
    return isDark ? '#d1d5db' : '#374151'; // Neutral
  };

  if (loading && !data) {
    return (
      <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `1px solid ${isDark ? '#374151' : 'var(--dashboard-border, #d7e5ef)'}`,
        borderRadius: 'var(--dashboard-radius, 6px)',
        boxShadow: isDark ? undefined : 'var(--dashboard-shadow, 0 1px 3px rgba(15, 23, 42, 0.08))',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '24px',
            height: '24px',
            border: `2px solid ${isDark ? '#374151' : '#e5e7eb'}`,
            borderTopColor: isDark ? '#60a5fa' : '#3b82f6',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }} />
          <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: '13px' }}>Loading CFTC Data...</Text>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card className={isDark ? 'dark:bg-gray-800' : ''} style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `1px solid ${isDark ? '#374151' : 'var(--dashboard-border, #d7e5ef)'}`,
        borderRadius: 'var(--dashboard-radius, 6px)',
        boxShadow: isDark ? undefined : 'var(--dashboard-shadow, 0 1px 3px rgba(15, 23, 42, 0.08))',
      }}>
        <Text style={{ color: '#ef4444' }}>{error}</Text>
      </Card>
    );
  }

  // Group data by category
  const groupedData = (data?.data || []).reduce((acc, row) => {
    const cat = row.category || 'OTHER';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(row);
    return acc;
  }, {});

  // Predefined category order
  const CATEGORY_ORDER = ['EQUITIES', 'RATES', 'CURRENCIES', 'COMMODITIES', 'OTHER'];
  const categories = Object.keys(groupedData).sort((a, b) => {
    const idxA = CATEGORY_ORDER.indexOf(a);
    const idxB = CATEGORY_ORDER.indexOf(b);
    if (idxA === -1 && idxB === -1) return a.localeCompare(b);
    if (idxA === -1) return 1;
    if (idxB === -1) return -1;
    return idxA - idxB;
  });

  return (
    <Card 
      className={isDark ? 'dark:bg-gray-800' : ''}
      style={{
        border: `1px solid ${isDark ? '#374151' : 'var(--dashboard-border, #d7e5ef)'}`,
        borderRadius: 'var(--dashboard-radius, 6px)',
        boxShadow: isDark ? undefined : 'var(--dashboard-shadow, 0 1px 3px rgba(15, 23, 42, 0.08))',
        padding: '0',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      <div style={{ padding: '6px 10px', borderBottom: `1px solid ${isDark ? '#374151' : 'var(--dashboard-border-soft, #e6eef5)'}`, backgroundColor: isDark ? '#1f2937' : '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <LayoutGrid size={14} color={isDark ? '#60a5fa' : '#2563eb'} strokeWidth={2.5} style={{ flexShrink: 0 }} />
        <Title style={{ fontSize: '13px', fontWeight: 800, color: isDark ? '#f9fafb' : '#111827', margin: 0, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          CFTC Non-Commercial Net Long Positioning
        </Title>
        <Info size={13} color={isDark ? '#6b7280' : '#9ca3af'} style={{ flexShrink: 0 }} />
        <div style={{ marginLeft: 'auto' }}>
          <StatusDot
            updatedAt={data?.date ? new Date(data.date + 'T12:00:00') : null}
            status={data ? 'active' : loading ? 'stale' : 'inactive'}
            size={9}
            label="CFTC Positioning Data"
            showDateOnly
          />
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 4px' }}>
        {categories.map((category) => {
          const meta = CATEGORY_META[category] || CATEGORY_META.OTHER;
          const { Icon: CatIcon } = meta;
          const hdr = { padding: '6px 8px', fontSize: '10px', fontWeight: 700, color: isDark ? '#9ca3af' : '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' };
          return (
            <div key={category} style={{ marginTop: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', backgroundColor: isDark ? meta.bgDark : meta.bgLight, borderRadius: '4px', marginBottom: '6px', borderLeft: `3px solid ${meta.color}` }}>
                <CatIcon size={12} color={meta.color} />
                <span style={{ fontSize: '11px', fontWeight: 700, color: meta.color, letterSpacing: '0.07em', textTransform: 'uppercase' }}>
                  {meta.label || category}
                </span>
              </div>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell style={hdr}>CONTRACT</TableHeaderCell>
                    <TableHeaderCell style={{ ...hdr, textAlign: 'right' }}>LATEST</TableHeaderCell>
                    <TableHeaderCell style={{ ...hdr, textAlign: 'right' }}>W/W CHANGE</TableHeaderCell>
                    <TableHeaderCell style={{ ...hdr, textAlign: 'right' }}>1Y Z-SCORE</TableHeaderCell>
                    <TableHeaderCell style={{ ...hdr, textAlign: 'right' }}>3Y Z-SCORE</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {groupedData[category].map((row, idx) => {
                    const wwColor = row.wwChg > 0
                      ? (isDark ? '#34d399' : '#10b981')
                      : row.wwChg < 0
                        ? (isDark ? '#f87171' : '#ef4444')
                        : (isDark ? '#d1d5db' : '#374151');
                    return (
                      <TableRow key={idx}>
                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 500, color: isDark ? '#d1d5db' : '#374151' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            {METRIC_EMOJI[row.metric] && (
                              <span style={{ fontSize: '13px', lineHeight: 1, flexShrink: 0 }}>{METRIC_EMOJI[row.metric]}</span>
                            )}
                            {row.metric}
                          </span>
                        </TableCell>
                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace', textAlign: 'right', color: isDark ? '#f3f4f6' : '#111827' }}>
                          {formatNumber(row.latest)}
                        </TableCell>
                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace', textAlign: 'right', color: wwColor }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', justifyContent: 'flex-end' }}>
                            {row.wwChg !== null && row.wwChg > 0 ? '+' : ''}{formatNumber(row.wwChg)}
                            {row.wwChg != null && row.wwChg > 0 && <ArrowUp size={10} />}
                            {row.wwChg != null && row.wwChg < 0 && <ArrowDown size={10} />}
                          </span>
                        </TableCell>
                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace', textAlign: 'right', color: getZScoreColor(row.zScore1Y) }}>
                          {formatZScore(row.zScore1Y)}
                        </TableCell>
                        <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace', textAlign: 'right', color: getZScoreColor(row.zScore3Y) }}>
                          {formatZScore(row.zScore3Y)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          );
        })}
      </div>
      <div style={{ padding: '5px 10px', fontSize: '10px', fontStyle: 'italic', color: isDark ? '#9ca3af' : '#6b7280', borderTop: `1px solid ${isDark ? '#374151' : 'var(--dashboard-border-soft, #e6eef5)'}`, backgroundColor: isDark ? '#1f2937' : '#f9fafb' }}>
        All values represent net contracts
      </div>
    </Card>
  );
};

export default CFTCNetLongCard;
