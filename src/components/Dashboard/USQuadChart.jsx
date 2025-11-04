import React from 'react';
import { Card, Title } from '@tremor/react';
import { 
  LineChart, 
  Line, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  ReferenceArea,
  LabelList,
  Cell
} from 'recharts';

// Quad colors matching the image exactly
const QUAD_COLORS = {
  1: { bg: '#90EE90', border: '#28a745', text: '#155724' }, // Light green
  2: { bg: '#ADFF2F', border: '#9ACD32', text: '#556B2F' }, // Light yellow-green
  3: { bg: '#FFA500', border: '#FF8C00', text: '#8B4513' }, // Light orange
  4: { bg: '#FF6B6B', border: '#DC3545', text: '#8B0000' }  // Light red
};

// Generate all months from Jan-24 to Aug-26
const generateMonths = () => {
  const months = [];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  // Jan 2024 to Dec 2024
  for (let i = 0; i < 12; i++) {
    months.push(`${monthNames[i]}-24`);
  }
  
  // Jan 2025 to Dec 2025
  for (let i = 0; i < 12; i++) {
    months.push(`${monthNames[i]}-25`);
  }
  
  // Jan 2026 to Aug 2026
  for (let i = 0; i < 8; i++) {
    months.push(`${monthNames[i]}-26`);
  }
  
  return months;
};

// Quad timeline data (from image)
const getQuadTimelineData = () => {
  const months = generateMonths();
  const quadData = {
    'Jan-24': 4,
    'Feb-24': 2,
    'Mar-24': null, // Not specified
    'Apr-24': null,
    'May-24': 1,
    'Jun-24': null,
    'Jul-24': null,
    'Aug-24': null,
    'Sep-24': null,
    'Oct-24': 3,
    'Nov-24': null,
    'Dec-24': null,
    'Jan-25': null,
    'Feb-25': 4,
    'Mar-25': 1,
    'Apr-25': null,
    'May-25': null,
    'Jun-25': null,
    'Jul-25': null,
    'Aug-25': null,
    'Sep-25': 2,
    'Oct-25': null,
    'Nov-25': null,
    'Dec-25': 4,
    'Jan-26': 1,
    'Feb-26': null,
    'Mar-26': null,
    'Apr-26': null,
    'May-26': 2,
    'Jun-26': null,
    'Jul-26': 3,
    'Aug-26': null
  };
  
  return months.map(month => ({
    month,
    quad: quadData[month] || null,
    quadValue: quadData[month] || null // For Y-axis positioning
  }));
};

// Conditional probabilities data (from image - Sep-25 to Aug-26)
const getProbabilitiesData = () => {
  return [
    { month: 'Sep-25', quad1: 6, quad2: 8, quad3: 48, quad4: 39 },
    { month: 'Oct-25', quad1: 3, quad2: 21, quad3: 60, quad4: 14 },
    { month: 'Nov-25', quad1: 3, quad2: 27, quad3: 63, quad4: 7 },
    { month: 'Dec-25', quad1: 8, quad2: 3, quad3: 23, quad4: 68 },
    { month: 'Jan-26', quad1: 75, quad2: 2, quad3: 15, quad4: 8 },
    { month: 'Feb-26', quad1: 50, quad2: 19, quad3: 8, quad4: 22 },
    { month: 'Mar-26', quad1: 7, quad2: 9, quad3: 46, quad4: 38 },
    { month: 'Apr-26', quad1: 65, quad2: 3, quad3: 7, quad4: 25 },
    { month: 'May-26', quad1: 34, quad2: 42, quad3: 13, quad4: 11 },
    { month: 'Jun-26', quad1: 29, quad2: 24, quad3: 21, quad4: 26 },
    { month: 'Jul-26', quad1: 15, quad2: 18, quad3: 37, quad4: 30 },
    { month: 'Aug-26', quad1: 25, quad2: 30, quad3: 25, quad4: 20 }
  ];
};

// Custom dot component for timeline (colored square with number)
const CustomDot = ({ cx, cy, payload }) => {
  if (!payload.quad) return null;
  
  const quad = payload.quad;
  const color = QUAD_COLORS[quad];
  
  return (
    <g>
      <rect
        x={cx - 12}
        y={cy - 12}
        width={24}
        height={24}
        fill={color.bg}
        stroke={color.border}
        strokeWidth={2}
        rx={2}
      />
      <text
        x={cx}
        y={cy + 5}
        textAnchor="middle"
        fill={color.text}
        fontSize={14}
        fontWeight="bold"
      >
        {quad}
      </text>
    </g>
  );
};

// Custom label for stacked bars
const CustomBarLabel = ({ x, y, width, height, value, index }) => {
  if (value < 5) return null; // Don't show labels for very small segments
  
  return (
    <text
      x={x + width / 2}
      y={y + height / 2}
      fill="white"
      textAnchor="middle"
      fontSize={11}
      fontWeight="bold"
    >
      {value}%
    </text>
  );
};

const USQuadChart = () => {
  const timelineData = getQuadTimelineData();
  const probabilitiesData = getProbabilitiesData();

  return (
    <Card className="dark:bg-gray-800">
      <div className="flex">
        {/* Vertical QUAD Text */}
        <div className="flex items-center justify-center w-16 mr-4">
          <div 
            className="text-4xl font-bold text-gray-700 dark:text-gray-300"
            style={{ 
              writingMode: 'vertical-rl',
              textOrientation: 'upright'
            }}
          >
            QUAD
          </div>
        </div>

        {/* Charts Container */}
        <div className="flex-1">
          {/* Top Chart: Quad Timeline */}
          <div className="mb-6">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={timelineData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                
                {/* Background quad bands */}
                <ReferenceArea y1={0.5} y2={1.5} fill={QUAD_COLORS[1].bg} fillOpacity={0.3} />
                <ReferenceArea y1={1.5} y2={2.5} fill={QUAD_COLORS[2].bg} fillOpacity={0.3} />
                <ReferenceArea y1={2.5} y2={3.5} fill={QUAD_COLORS[3].bg} fillOpacity={0.3} />
                <ReferenceArea y1={3.5} y2={4.5} fill={QUAD_COLORS[4].bg} fillOpacity={0.3} />
                
                <XAxis 
                  dataKey="month" 
                  angle={-45}
                  textAnchor="end"
                  height={80}
                  tick={{ fontSize: 10 }}
                  interval={0}
                />
                <YAxis 
                  domain={[0.5, 4.5]}
                  ticks={[1, 2, 3, 4]}
                  tickFormatter={(value) => `QUAD ${value}`}
                  tick={{ fontSize: 12, fontWeight: 'bold' }}
                  width={80}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: '4px'
                  }}
                />
                <Line 
                  type="monotone" 
                  dataKey="quadValue" 
                  stroke="#888888"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={<CustomDot />}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Bottom Chart: Conditional Probabilities */}
          <div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={probabilitiesData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis 
                  dataKey="month" 
                  angle={-45}
                  textAnchor="end"
                  height={80}
                  tick={{ fontSize: 10 }}
                />
                <YAxis 
                  domain={[0, 100]}
                  tick={{ fontSize: 12 }}
                  label={{ value: 'Conditional Probabilities', angle: -90, position: 'insideLeft' }}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: '4px'
                  }}
                />
                <Bar dataKey="quad1" stackId="a" fill={QUAD_COLORS[1].border}>
                  <LabelList dataKey="quad1" content={<CustomBarLabel />} />
                </Bar>
                <Bar dataKey="quad2" stackId="a" fill={QUAD_COLORS[2].border}>
                  <LabelList dataKey="quad2" content={<CustomBarLabel />} />
                </Bar>
                <Bar dataKey="quad3" stackId="a" fill={QUAD_COLORS[3].border}>
                  <LabelList dataKey="quad3" content={<CustomBarLabel />} />
                </Bar>
                <Bar dataKey="quad4" stackId="a" fill={QUAD_COLORS[4].border}>
                  <LabelList dataKey="quad4" content={<CustomBarLabel />} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            
            {/* Legend */}
            <div className="flex items-center gap-4 mt-4 ml-20">
              {[1, 2, 3, 4].map(quad => (
                <div key={quad} className="flex items-center gap-2">
                  <div 
                    className="w-4 h-4 border-2 rounded"
                    style={{ 
                      backgroundColor: QUAD_COLORS[quad].bg,
                      borderColor: QUAD_COLORS[quad].border
                    }}
                  />
                  <span className="text-xs font-semibold dark:text-gray-300">{quad}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
};

export default USQuadChart;

