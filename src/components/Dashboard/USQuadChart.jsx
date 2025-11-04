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

  return (
    <Card className="bg-white">
      <div style={{ height: 360, display: 'flex' }}>
        {/* Left label: QU over AD */}
        <div
          style={{
            flexBasis: '20%',
            minWidth: 140,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            // Match app card outline (blue divider)
            borderRight: '2px solid #60A5FA',
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

        {/* Right canvas area - ComposedChart */}
        <div style={{ flex: 1, padding: '10px' }}>
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
      </div>
    </Card>
  );
};

export default USQuadChart;


