import React, { useState, useEffect } from 'react';
import { Card, Title, Text, Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell, Badge } from '@tremor/react';
import axios from 'axios';
import { useTheme } from '../../context/ThemeContext';

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
        border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
        borderRadius: '0.5rem',
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
        border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
        borderRadius: '0.5rem',
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
        border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
        borderRadius: '0.5rem',
        padding: '0',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      <div style={{
        padding: '12px 16px',
        borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
        backgroundColor: isDark ? '#1f2937' : '#f9fafb',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Title style={{ fontSize: '14px', fontWeight: 600, color: isDark ? '#f9fafb' : '#111827', margin: 0 }}>
            CFTC Non-Commercial Net Long Positioning
          </Title>
        </div>
        {data?.date && (
          <Badge size="xs" color="gray" style={{
            backgroundColor: isDark ? '#374151' : '#f3f4f6',
            color: isDark ? '#d1d5db' : '#4b5563',
            border: 'none',
            fontSize: '10px'
          }}>
            {new Date(data.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </Badge>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 12px 12px 12px' }}>
        {categories.map((category) => (
          <div key={category} style={{ marginTop: '16px' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 8px',
              backgroundColor: isDark ? 'rgba(55, 65, 81, 0.5)' : '#f3f4f6',
              borderRadius: '4px',
              marginBottom: '8px'
            }}>
              <Text style={{
                fontSize: '11px',
                fontWeight: 700,
                color: isDark ? '#f3f4f6' : '#111827',
                letterSpacing: '0.05em',
                textTransform: 'uppercase'
              }}>
                {category}
              </Text>
            </div>
            
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '10px', color: isDark ? '#9ca3af' : '#6b7280', textTransform: 'uppercase' }}>Metric</TableHeaderCell>
                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '10px', color: isDark ? '#9ca3af' : '#6b7280', textTransform: 'uppercase', textAlign: 'right' }}>Latest</TableHeaderCell>
                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '10px', color: isDark ? '#9ca3af' : '#6b7280', textTransform: 'uppercase', textAlign: 'right' }}>W/W Chg</TableHeaderCell>
                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '10px', color: isDark ? '#9ca3af' : '#6b7280', textTransform: 'uppercase', textAlign: 'right' }}>1Y Z</TableHeaderCell>
                  <TableHeaderCell style={{ padding: '6px 8px', fontSize: '10px', color: isDark ? '#9ca3af' : '#6b7280', textTransform: 'uppercase', textAlign: 'right' }}>3Y Z</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {groupedData[category].map((row, idx) => (
                  <TableRow key={idx}>
                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 500, color: isDark ? '#d1d5db' : '#374151' }}>
                      {row.metric}
                    </TableCell>
                    <TableCell style={{ padding: '4px 8px', fontSize: '11px', fontFamily: 'monospace', textAlign: 'right', color: isDark ? '#f3f4f6' : '#111827' }}>
                      {formatNumber(row.latest)}
                    </TableCell>
                    <TableCell style={{ 
                      padding: '4px 8px', 
                      fontSize: '11px', 
                      fontFamily: 'monospace', 
                      textAlign: 'right',
                      color: row.wwChg > 0 ? (isDark ? '#34d399' : '#10b981') : row.wwChg < 0 ? (isDark ? '#f87171' : '#ef4444') : (isDark ? '#d1d5db' : '#374151')
                    }}>
                      {row.wwChg !== null && row.wwChg > 0 ? '+' : ''}{formatNumber(row.wwChg)}
                    </TableCell>
                    <TableCell style={{ 
                      padding: '4px 8px', 
                      fontSize: '11px', 
                      fontFamily: 'monospace', 
                      textAlign: 'right',
                      color: getZScoreColor(row.zScore1Y)
                    }}>
                      {formatZScore(row.zScore1Y)}
                    </TableCell>
                    <TableCell style={{ 
                      padding: '4px 8px', 
                      fontSize: '11px', 
                      fontFamily: 'monospace', 
                      textAlign: 'right',
                      color: getZScoreColor(row.zScore3Y)
                    }}>
                      {formatZScore(row.zScore3Y)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
      </div>
    </Card>
  );
};

export default CFTCNetLongCard;
