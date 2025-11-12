import React from 'react';
import { Card } from '@tremor/react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
} from 'recharts';

// Quad area with left QU/AD label box (20% width) and ComposedChart on right
const USQuadChart = () => {
  // Standard colors: Q=green (1), U=dark green (2), A=yellow (3), D=red (4)
  const QUAD_COLORS = {
    1: '#008000', // Quad 1
    2: '#7CB342', // Quad 2 - toned down light green
    3: '#FFC107', // Quad 3 - toned down yellow
    4: '#FE0000', // Quad 4
  };

  // Chart colors match QUAD colors
  const CHART_COLORS = {
    1: '#008000', // Quad 1
    2: '#7CB342', // Quad 2 - toned down light green
    3: '#FFC107', // Quad 3 - toned down yellow
    4: '#FE0000', // Quad 4
  };

  // Data from image: Sep-25 to Aug-26, normalized to sum to 100%
  // quadY maps quad values (1-4) to center of quad bands (reversed): Quad 1=12.5, Quad 2=37.5, Quad 3=62.5, Quad 4=87.5
  const data = [
    { month: 'Sep-25', quad1: 6, quad2: 8, quad3: 48, quad4: 38, quadValue: 3, quadY: 62.5 },
    { month: 'Oct-25', quad1: 3, quad2: 21, quad3: 61, quad4: 15, quadValue: 2, quadY: 37.5 },
    { month: 'Nov-25', quad1: 3, quad2: 27, quad3: 63, quad4: 7, quadValue: 3, quadY: 62.5 },
    { month: 'Dec-25', quad1: 8, quad2: 3, quad3: 23, quad4: 66, quadValue: 4, quadY: 87.5 },
    { month: 'Jan-26', quad1: 75, quad2: 2, quad3: 15, quad4: 8, quadValue: 1, quadY: 12.5 },
    { month: 'Feb-26', quad1: 50, quad2: 19, quad3: 8, quad4: 23, quadValue: 1, quadY: 12.5 },
    { month: 'Mar-26', quad1: 7, quad2: 9, quad3: 46, quad4: 38, quadValue: 3, quadY: 62.5 },
    { month: 'Apr-26', quad1: 65, quad2: 3, quad3: 7, quad4: 25, quadValue: 1, quadY: 12.5 },
    { month: 'May-26', quad1: 34, quad2: 42, quad3: 13, quad4: 11, quadValue: 2, quadY: 37.5 },
    { month: 'Jun-26', quad1: 29, quad2: 24, quad3: 21, quad4: 26, quadValue: 1, quadY: 12.5 },
    { month: 'Jul-26', quad1: 15, quad2: 18, quad3: 37, quad4: 30, quadValue: 3, quadY: 62.5 },
    { month: 'Aug-26', quad1: 25, quad2: 30, quad3: 25, quad4: 20, quadValue: 2, quadY: 37.5 },
  ];

  // Custom dot component for line showing quad numbers (1-4) in colored circles
  const CustomQuadDot = ({ cx, cy, payload }) => {
    if (cx == null || cy == null || !payload?.quadValue) return null;

    const quad = payload.quadValue;
    const fill = CHART_COLORS[quad] || '#9ca3af';

    return (
      <g>
        <circle cx={cx} cy={cy} r={13} fill={fill} stroke="#1f2937" strokeWidth={2} />
        <text x={cx} y={cy + 4} textAnchor="middle" fill="#ffffff" fontSize={12} fontWeight={700}>
          {quad}
        </text>
      </g>
    );
  };

  // Custom tooltip component showing percentages with % sign
  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload || payload.length === 0) return null;

    const data = payload[0].payload;
    
    return (
      <div style={{
        backgroundColor: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: '4px',
        padding: '8px',
      }}>
        <p style={{ margin: '0 0 4px 0', fontWeight: 'bold' }}>{data.month}</p>
        <p style={{ margin: '2px 0', color: CHART_COLORS[1] }}>quad1: {data.quad1}%</p>
        <p style={{ margin: '2px 0', color: CHART_COLORS[2] }}>quad2: {data.quad2}%</p>
        <p style={{ margin: '2px 0', color: CHART_COLORS[3] }}>quad3: {data.quad3}%</p>
        <p style={{ margin: '2px 0', color: CHART_COLORS[4] }}>quad4: {data.quad4}%</p>
      </div>
    );
  };

  // Heatmap data structure
  const countries = [
    'United States',
    'Argentina',
    'Australia',
    'Brazil',
    'Canada',
    'China',
    'Eurozone',
    'France',
    'Germany',
    'India',
    'Indonesia',
    'Italy',
    'Japan',
    'Mexico',
    'Russia',
    'South Africa',
    'South Korea',
    'Spain',
    'Turkey',
    'United Kingdom',
    'MODE/MEDIAN'
  ];

  const quarters = [
    { period: '2Q23', type: 'actuals' },
    { period: '3Q23', type: 'actuals' },
    { period: '4Q23', type: 'actuals' },
    { period: '1Q24', type: 'actuals' },
    { period: '2Q24', type: 'actuals' },
    { period: '3Q24', type: 'actuals' },
    { period: '4Q24', type: 'actuals' },
    { period: '1Q25', type: 'actuals' },
    { period: '2Q25', type: 'actuals' },
    { period: '3Q25E', type: 'estimates' },
    { period: '4Q25E', type: 'estimates' },
    { period: '1Q26E', type: 'estimates' },
    { period: '2Q26E', type: 'estimates' },
  ];

  // Generate sample heatmap data (country -> quarter -> quad value)
  // In a real implementation, this would come from an API or props
  // Using React.useMemo to ensure stable data across renders
  const heatmapData = React.useMemo(() => {
    const data = {};
    // Use a simple hash-based approach for consistent "random" values
    const seed = 12345;
    let currentSeed = seed;
    const random = () => {
      currentSeed = (currentSeed * 9301 + 49297) % 233280;
      return currentSeed / 233280;
    };
    
    countries.forEach((country, countryIndex) => {
      data[country] = {};
      quarters.forEach(({ period }, quarterIndex) => {
        // Generate consistent pseudo-random quad values (1-4) based on country and quarter
        const value = Math.floor(random() * 4) + 1;
        data[country][period] = value;
      });
    });
    return data;
  }, []);

  // Get cell background color based on quad value
  const getCellColor = (quadValue) => {
    // Use the same palette as charts for consistency across the app
    if (quadValue === 1) return CHART_COLORS[1]; // Green
    if (quadValue === 2) return CHART_COLORS[2]; // Light green (Quad 2)
    if (quadValue === 3) return CHART_COLORS[3]; // Yellow/Amber
    if (quadValue === 4) return CHART_COLORS[4]; // Red
    return '#f3f4f6'; // Default gray
  };

  // Get text color for cell
  const getTextColor = (quadValue) => {
    if (quadValue === 1) return '#ffffff'; // White text for green
    if (quadValue === 2) return '#ffffff'; // White text for light green (Quad 2)
    if (quadValue === 3) return '#000000'; // Black text for yellow
    if (quadValue === 4) return '#ffffff'; // White text for red
    return '#000000'; // Default black
  };

  // Calculate actuals and estimates column spans
  const actualsCount = quarters.filter(q => q.type === 'actuals').length;
  const estimatesCount = quarters.filter(q => q.type === 'estimates').length;

  // Sector exposures data - matching image description
  const sectorExposures = [
    { sector: 'Consumer Discretionary', ticker: 'XLY', price: 238.16, d1: -1.66, mtd: -0.74, qtd: -0.62, ytd: 6.16 },
    { sector: 'Financial Select Sector', ticker: 'XLF', price: 52.42, d1: 0.52, mtd: 0.10, qtd: -0.26, ytd: 8.46 },
    { sector: 'Health Care Select Sector', ticker: 'XLV', price: 293.94, d1: 0.41, mtd: 0.27, qtd: 0.15, ytd: 12.34 },
    { sector: 'Technology Select Sector', ticker: 'XLK', price: 75.99, d1: -2.64, mtd: -1.50, qtd: 0.85, ytd: 18.92 },
    { sector: 'Consumer Staples Select Sector', ticker: 'XLP', price: 152.61, d1: 0.45, mtd: 0.32, qtd: 0.18, ytd: 5.67 },
    { sector: 'Industrial Select Sector', ticker: 'XLI', price: 84.72, d1: -0.88, mtd: -0.42, qtd: 0.25, ytd: 9.81 },
    { sector: 'Materials Select Sector', ticker: 'XLB', price: 87.19, d1: -1.23, mtd: -0.65, qtd: -0.12, ytd: 7.43 },
    { sector: 'The Energy Select Sector', ticker: 'XLE', price: 88.83, d1: 0.38, mtd: 0.21, qtd: -0.35, ytd: 4.92 },
    { sector: 'Utilities Select Sector', ticker: 'XLU', price: 40.94, d1: 0.31, mtd: 0.18, qtd: 0.09, ytd: 3.75 },
    { sector: 'Real Estate Select Sector', ticker: 'XLRE', price: 112.81, d1: -0.95, mtd: -0.52, qtd: 0.33, ytd: 8.24 },
    { sector: 'Communications Services Sector', ticker: 'XLC', price: 95.67, d1: -1.42, mtd: -0.78, qtd: 0.47, ytd: 11.56 },
    { sector: 'S&P 500', ticker: 'SPX', price: 6771.55, d1: -1.17, mtd: -1.00, qtd: 1.24, ytd: 15.13 },
  ];

  // Table styling objects for factor exposures table
  const thLeft = {
    padding: '4px 6px',
    textAlign: 'left',
    backgroundColor: '#f3f4f6',
    fontWeight: 'bold',
    border: '1px solid #d1d5db',
    fontSize: '10px',
    minWidth: '180px',
  };
  const th = {
    padding: '4px 6px',
    textAlign: 'center',
    backgroundColor: '#f3f4f6',
    fontWeight: 'bold',
    border: '1px solid #d1d5db',
    fontSize: '10px',
    minWidth: '60px',
  };
  const thRight = {
    padding: '4px 6px',
    textAlign: 'right',
    backgroundColor: '#f3f4f6',
    fontWeight: 'bold',
    border: '1px solid #d1d5db',
    fontSize: '10px',
    minWidth: '80px',
  };
  const thPct = {
    padding: '4px 6px',
    textAlign: 'center',
    backgroundColor: '#f3f4f6',
    fontWeight: 'bold',
    border: '1px solid #d1d5db',
    fontSize: '10px',
    minWidth: '70px',
  };
  const tdLeft = {
    padding: '3px 6px',
    textAlign: 'left',
    border: '1px solid #d1d5db',
    fontSize: '10px',
    backgroundColor: '#ffffff',
  };
  const tdCenter = {
    padding: '3px 6px',
    textAlign: 'center',
    border: '1px solid #d1d5db',
    fontSize: '10px',
    backgroundColor: '#ffffff',
    fontWeight: '600',
  };
  const tdRight = {
    padding: '3px 6px',
    textAlign: 'right',
    border: '1px solid #d1d5db',
    fontSize: '10px',
    backgroundColor: '#ffffff',
  };
  const tdPct = {
    padding: '3px 6px',
    textAlign: 'center',
    border: '1px solid #d1d5db',
    fontSize: '10px',
    backgroundColor: '#ffffff',
  };

  return (
    <Card className="bg-white dark:bg-gray-800">
      {/* Two-column layout: Left QU/AD label, Right Chart + Exposures Table */}
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {/* Left label: QU over AD - stretches to cover chart + table */}
        <div
          style={{
            flexBasis: '20%',
            minWidth: 140,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            // Match app card outline (blue divider)
            borderRight: '2px solid #60A5FA',
            alignSelf: 'stretch',
          }}
        >
          <div
            style={{
              fontFamily: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
              lineHeight: 0.95,
            }}
            className="text-9xl tracking-wide select-none"
          >
            <div className="text-center">
              <span style={{ color: QUAD_COLORS[1] }}>Q</span>
              <span style={{ color: QUAD_COLORS[2] }}>U</span>
            </div>
            <div className="text-center">
              <span style={{ color: QUAD_COLORS[3] }}>A</span>
              <span style={{ color: QUAD_COLORS[4] }}>D</span>
            </div>
          </div>
        </div>

        {/* Right column: Chart + Exposures Table stacked vertically */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {/* Bar Chart */}
          <div style={{ height: 360, padding: '10px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={data}
                margin={{ top: 10, right: 10, left: 10, bottom: 40 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                {/* Quad bands background - reversed: QUAD 4 at top, QUAD 1 at bottom */}
                <ReferenceArea y1={75} y2={100} fill={CHART_COLORS[4]} fillOpacity={0.2} />
                <ReferenceArea y1={50} y2={75} fill={CHART_COLORS[3]} fillOpacity={0.2} />
                <ReferenceArea y1={25} y2={50} fill={CHART_COLORS[2]} fillOpacity={0.2} />
                <ReferenceArea y1={0} y2={25} fill={CHART_COLORS[1]} fillOpacity={0.2} />
                <XAxis
                  dataKey="month"
                  angle={-45}
                  textAnchor="end"
                  height={80}
                  tick={{ fontSize: 10 }}
                  interval={0}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[87.5, 62.5, 37.5, 12.5]}
                  tick={(props) => {
                    const { x, y, payload } = props;
                    let text = '';
                    let color = '#000';
                    if (payload.value === 87.5) {
                      text = 'QUAD 4';
                      color = CHART_COLORS[4]; // red - at top
                    } else if (payload.value === 62.5) {
                      text = 'QUAD 3';
                      color = CHART_COLORS[3]; // yellow
                    } else if (payload.value === 37.5) {
                      text = 'QUAD 2';
                      color = CHART_COLORS[2]; // light green
                    } else if (payload.value === 12.5) {
                      text = 'QUAD 1';
                      color = CHART_COLORS[1]; // green - at bottom
                    }
                    return (
                      <text x={x - 15} y={y} fill={color} fontSize={12} fontWeight="bold" textAnchor="end">
                        {text}
                      </text>
                    );
                  }}
                  width={90}
                />
                <Tooltip content={<CustomTooltip />} />
                {/* Stacked bars for conditional probabilities */}
                <Bar dataKey="quad1" stackId="a" fill={CHART_COLORS[1]} stroke="#000000" strokeWidth={1} barSize={24} />
                <Bar dataKey="quad2" stackId="a" fill={CHART_COLORS[2]} stroke="#000000" strokeWidth={1} barSize={24} />
                <Bar dataKey="quad3" stackId="a" fill={CHART_COLORS[3]} stroke="#000000" strokeWidth={1} barSize={24} />
                <Bar dataKey="quad4" stackId="a" fill={CHART_COLORS[4]} stroke="#000000" strokeWidth={1} barSize={24} />
                {/* Line overlay showing actual quad value experienced */}
                <Line
                  type="monotone"
                  dataKey="quadY"
                  stroke="#9CA3AF"
                  strokeWidth={2}
                  strokeDasharray="4 6"
                  dot={<CustomQuadDot />}
                  connectNulls
                  legendType="none"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Factor Exposures Table */}
          <div style={{ padding: '6px 10px', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
              <thead>
                <tr>
                  <th style={thLeft}>SECTOR</th>
                  <th style={th}>Ticker</th>
                  <th style={thRight}>Price</th>
                  <th style={thPct}>1-Day % Chg</th>
                  <th style={thPct}>MTD % Chg</th>
                  <th style={thPct}>QTD % Chg</th>
                  <th style={thPct}>YTD % Chg</th>
                </tr>
              </thead>
              <tbody>
                {sectorExposures.map((row) => (
                  <tr key={row.ticker}>
                    <td style={tdLeft}>{row.sector}</td>
                    <td style={tdCenter}>{row.ticker}</td>
                    <td style={tdRight}>
                      {row.ticker === 'SPX' 
                        ? row.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : `$${row.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      }
                    </td>
                    <td style={{
                      ...tdPct,
                      backgroundColor: row.d1 >= 0 ? '#16a34a22' : '#dc262622',
                      color: row.d1 >= 0 ? '#15803d' : '#b91c1c',
                      fontWeight: 700,
                    }}>
                      {row.d1 >= 0 ? '+' : ''}{row.d1.toFixed(2)}%
                    </td>
                    <td style={{
                      ...tdPct,
                      backgroundColor: row.mtd >= 0 ? '#16a34a22' : '#dc262622',
                      color: row.mtd >= 0 ? '#15803d' : '#b91c1c',
                      fontWeight: 700,
                    }}>
                      {row.mtd >= 0 ? '+' : ''}{row.mtd.toFixed(2)}%
                    </td>
                    <td style={{
                      ...tdPct,
                      backgroundColor: row.qtd >= 0 ? '#16a34a22' : '#dc262622',
                      color: row.qtd >= 0 ? '#15803d' : '#b91c1c',
                      fontWeight: 700,
                    }}>
                      {row.qtd >= 0 ? '+' : ''}{row.qtd.toFixed(2)}%
                    </td>
                    <td style={{
                      ...tdPct,
                      backgroundColor: row.ytd >= 0 ? '#16a34a22' : '#dc262622',
                      color: row.ytd >= 0 ? '#15803d' : '#b91c1c',
                      fontWeight: 700,
                    }}>
                      {row.ytd >= 0 ? '+' : ''}{row.ytd.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Heatmap Table */}
      <div style={{ marginTop: '15px', padding: '7.5px' }}>
        <div style={{ marginBottom: '6px', fontSize: '10.5px', fontWeight: 'bold' }}>
          Hedgeye Macro GIP Model Signals
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9px' }}>
            <thead>
              {/* First header row: Date and section headers */}
              <tr>
                <th
                  style={{
                    padding: '6px',
                    textAlign: 'left',
                    backgroundColor: '#3b82f6',
                    color: '#ffffff',
                    fontWeight: 'bold',
                    border: '1px solid #000',
                    position: 'sticky',
                    left: 0,
                    zIndex: 10,
                    minWidth: '90px',
                  }}
                >
                  10/1/2025
                </th>
                <th
                  colSpan={actualsCount}
                  style={{
                    padding: '6px',
                    textAlign: 'center',
                    backgroundColor: '#f3f4f6',
                    fontWeight: 'bold',
                    border: '1px solid #000',
                  }}
                >
                  Actuals
                </th>
                <th
                  colSpan={estimatesCount}
                  style={{
                    padding: '6px',
                    textAlign: 'center',
                    backgroundColor: '#f3f4f6',
                    fontWeight: 'bold',
                    border: '1px solid #000',
                  }}
                >
                  Estimates
                </th>
              </tr>
              {/* Second header row: Quarter periods */}
              <tr>
                <th
                  style={{
                    padding: '6px',
                    textAlign: 'left',
                    backgroundColor: '#f3f4f6',
                    fontWeight: 'bold',
                    border: '1px solid #000',
                    position: 'sticky',
                    left: 0,
                    zIndex: 10,
                  }}
                >
                  Country
                </th>
                {quarters.map(({ period }) => (
                  <th
                    key={period}
                    style={{
                      padding: '6px',
                      textAlign: 'center',
                      backgroundColor: '#f3f4f6',
                      fontWeight: 'bold',
                      border: '1px solid #000',
                      minWidth: '45px',
                    }}
                  >
                    {period}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {countries.map((country) => (
                <tr key={country}>
                  <td
                    style={{
                      padding: '6px',
                      textAlign: 'left',
                      fontWeight: country === 'MODE/MEDIAN' ? 'bold' : 'normal',
                      border: '1px solid #000',
                      backgroundColor: '#ffffff',
                      position: 'sticky',
                      left: 0,
                      zIndex: 5,
                    }}
                  >
                    {country}
                  </td>
                  {quarters.map(({ period }) => {
                    const quadValue = heatmapData[country]?.[period] || null;
                    return (
                      <td
                        key={period}
                        style={{
                          padding: '6px',
                          textAlign: 'center',
                          backgroundColor: quadValue ? getCellColor(quadValue) : '#f3f4f6',
                          color: quadValue ? getTextColor(quadValue) : '#000000',
                          fontWeight: 'bold',
                          border: '1px solid #000',
                          fontSize: '10.5px',
                        }}
                      >
                        {quadValue || ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
};

export default USQuadChart;


