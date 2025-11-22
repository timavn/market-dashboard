import React, { useState, useEffect, useRef } from 'react';
import { Card, Text, Badge, Flex } from '@tremor/react';
import PopoverSelect from '../common/PopoverSelect';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const VolatilityPanel = () => {
  const [selectedVolatility, setSelectedVolatility] = useState('VIX');
  const [selectedTimeframe, setSelectedTimeframe] = useState('1M');
  const [vixData, setVixData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [chartData, setChartData] = useState([]);
  const [metrics, setMetrics] = useState({
    closing: 0.00,
    current: 0.00,
    lrr: 0.00,
    trr: 0.00,
    dayOverDay: { percent: 0.00, bps: 0 },
    weekOverWeek: { percent: 0.00, bps: 0 },
    monthOverMonth: { percent: 0.00, bps: 0 },
    threeMonthOverMonth: { percent: 0.00, bps: 0 },
    sixMonthOverMonth: { percent: 0.00, bps: 0 },
    yearOverYear: { percent: 0.00, bps: 0 },
    si: 0.00, // Short Interest
    hhhl: '--', // Higher High / Higher Low
    lhll: '--', // Lower High / Lower Low
    vol: 0.00, // Volatility indicator value
    volTicker: 'VIX' // Volatility ticker name
  });

  const volatilityOptions = [
    { value: 'VIX', label: 'VIX' },
    { value: 'MOVE', label: 'MOVE' },
    { value: 'GVZ', label: 'GVZ' },
    { value: 'EVZ', label: 'EVZ' },
    { value: 'RVX', label: 'RVX' },
    { value: 'TYVIX', label: 'TYVIX' }
  ];

  const timeframeOptions = [
    { value: '1D', label: '1D' },
    { value: '1W', label: '1W' },
    { value: '1M', label: '1M' },
    { value: '3M', label: '3M' },
    { value: '6M', label: '6M' },
    { value: '1Y', label: '1Y' }
  ];

  // Update volTicker when selectedVolatility changes
  useEffect(() => {
    setMetrics(prev => ({
      ...prev,
      volTicker: selectedVolatility
    }));
  }, [selectedVolatility]);

  // Fetch VIX data and generate chart data
  useEffect(() => {
    const fetchData = async () => {
      if (selectedVolatility === 'VIX') {
        setLoading(true);
        try {
          const response = await fetch('http://localhost:3000/api/indicators/vix');
          const data = await response.json();
          setVixData(data);

          // Map timeframe to days
          const timeframeMap = {
            '1D': 1,
            '1W': 7,
            '1M': 30,
            '3M': 90,
            '6M': 180,
            '1Y': 365
          };
          const days = timeframeMap[selectedTimeframe] || 30;

          // Generate mock chart data
          const mockData = generateMockChartData(days, parseFloat(data.current || 18));
          setChartData(mockData);
          calculateMetrics(mockData);
        } catch (error) {
          console.error('Error fetching VIX data:', error);
        } finally {
          setLoading(false);
        }
      } else {
        // For non-VIX volatility, generate mock data
        const timeframeMap = {
          '1D': 1,
          '1W': 7,
          '1M': 30,
          '3M': 90,
          '6M': 180,
          '1Y': 365
        };
        const days = timeframeMap[selectedTimeframe] || 30;
        const mockData = generateMockChartData(days, 18);
        setChartData(mockData);
        calculateMetrics(mockData);
      }
    };

    fetchData();
  }, [selectedVolatility, selectedTimeframe]);

  // Generate mock chart data
  const generateMockChartData = (days, baseValue) => {
    const data = [];
    let currentValue = baseValue || 18;
    
    for (let i = days; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      
      // Simulate volatility movement
      const change = (Math.random() - 0.5) * 2;
      currentValue += change;
      currentValue = Math.max(10, Math.min(40, currentValue)); // Keep in reasonable VIX range
      
      data.push({
        date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        value: parseFloat(currentValue.toFixed(2))
      });
    }
    
    return data;
  };

  // Calculate metrics from chart data
  const calculateMetrics = (data) => {
    if (!data || data.length === 0) return;

    const latest = data[data.length - 1];
    const previous = data.length > 1 ? data[data.length - 2] : latest;
    const weekAgo = data.length >= 7 ? data[Math.max(0, data.length - 7)] : latest;
    const monthAgo = data.length >= 30 ? data[Math.max(0, data.length - 30)] : latest;
    const threeMonthAgo = data.length >= 90 ? data[Math.max(0, data.length - 90)] : latest;
    const sixMonthAgo = data.length >= 180 ? data[Math.max(0, data.length - 180)] : latest;
    const yearAgo = data.length >= 365 ? data[Math.max(0, data.length - 365)] : latest;

    const current = latest.value;
    const closing = previous.value;

    // Calculate percentage changes
    const calculateChange = (current, previous) => {
      if (!previous || previous === 0) return { percent: 0.00, bps: 0 };
      const percent = ((current - previous) / previous) * 100;
      const bps = percent * 100;
      return { percent: parseFloat(percent.toFixed(2)), bps: Math.round(bps) };
    };

    const dayOverDay = calculateChange(current, closing);
    const weekOverWeek = calculateChange(current, weekAgo.value);
    const monthOverMonth = calculateChange(current, monthAgo.value);
    const threeMonthOverMonth = calculateChange(current, threeMonthAgo.value);
    const sixMonthOverMonth = calculateChange(current, sixMonthAgo.value);
    const yearOverYear = calculateChange(current, yearAgo.value);

    setMetrics(prev => ({
      ...prev,
      closing: parseFloat(closing.toFixed(2)),
      current: parseFloat(current.toFixed(2)),
      lrr: 0.00, // Placeholder - lower risk range
      trr: 0.00, // Placeholder - higher risk range
      dayOverDay,
      weekOverWeek,
      monthOverMonth,
      threeMonthOverMonth,
      sixMonthOverMonth,
      yearOverYear,
      vol: parseFloat(current.toFixed(2)), // Current volatility value
      volTicker: selectedVolatility // Current volatility ticker
    }));
  };

  const formatMetricValue = (value, percent, bps) => {
    const sign = percent >= 0 ? '+' : '';
    return `${sign}${percent.toFixed(2)}%`;
  };

  const getChangeColor = (percent) => {
    return percent >= 0 ? 'emerald' : 'rose';
  };

  // Determine line color based on volatility level
  const getVolatilityColor = (value) => {
    const num = parseFloat(value);
    if (num <= 19) return '#10b981'; // Green for low volatility
    if (num <= 29) return '#f59e0b'; // Amber for medium volatility
    return '#ef4444'; // Red for high volatility
  };

  // Lightweight Popover component (no external deps)
  const Popover = ({ trigger, children }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
      const handleClickOutside = (e) => {
        if (ref.current && !ref.current.contains(e.target)) {
          setOpen(false);
        }
      };
      document.addEventListener('mousedown', handleClickOutside, true);
      return () => document.removeEventListener('mousedown', handleClickOutside, true);
    }, []);

    return (
      <div ref={ref} className="relative inline-block">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="px-2 py-1 text-sm border rounded bg-white dark:bg-gray-700 dark:text-white border-gray-300 dark:border-gray-600 shadow-sm"
        >
          {trigger}
        </button>
        {open && (
          <div
            className="absolute z-[9999] mt-2 w-36 max-h-64 overflow-auto rounded border bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 shadow-lg"
          >
            {children({ close: () => setOpen(false) })}
          </div>
        )}
      </div>
    );
  };

  return (
    <Card className="p-2 dark:bg-gray-800" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Top Controls Row */}
      <Flex className="mb-2 gap-2" justifyContent="between" alignItems="center">
        <div className="flex items-center gap-2">
          {/* Volatility Popover (left) */}
          <Popover trigger={<span>{selectedVolatility}</span>}>
          {({ close }) => (
            <div className="py-1">
              {volatilityOptions.map((opt) => (
                <button
                  key={opt.value}
                  className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 ${
                    selectedVolatility === opt.value ? 'font-semibold' : ''
                  }`}
                  onClick={() => {
                    setSelectedVolatility(opt.value);
                    close();
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </Popover>
        </div>
        {/* Timeframe Popover moved to right side (top-right) */}
        <div>
          <PopoverSelect
            value={selectedTimeframe}
            options={timeframeOptions}
            onChange={setSelectedTimeframe}
            buttonClassName="w-20 justify-center"
          />
        </div>
      </Flex>

      {/* Time Period Metrics Above Chart */}
      <Flex className="flex-wrap gap-2 mb-1 text-xs dark:text-white">
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">D/D:</Text>
          <Badge 
            color={getChangeColor(metrics.dayOverDay.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.dayOverDay.percent, metrics.dayOverDay.bps)}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">W/W:</Text>
          <Badge 
            color={getChangeColor(metrics.weekOverWeek.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.weekOverWeek.percent, metrics.weekOverWeek.bps)}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">M/M:</Text>
          <Badge 
            color={getChangeColor(metrics.monthOverMonth.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.monthOverMonth.percent, metrics.monthOverMonth.bps)}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">3M:</Text>
          <Badge 
            color={getChangeColor(metrics.threeMonthOverMonth.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.threeMonthOverMonth.percent, metrics.threeMonthOverMonth.bps)}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">6M:</Text>
          <Badge 
            color={getChangeColor(metrics.sixMonthOverMonth.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.sixMonthOverMonth.percent, metrics.sixMonthOverMonth.bps)}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Y/Y:</Text>
          <Badge 
            color={getChangeColor(metrics.yearOverYear.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.yearOverYear.percent, metrics.yearOverYear.bps)}
          </Badge>
        </div>
      </Flex>

      {/* Chart Area */}
      <div className="flex-1 dark:text-white" style={{ minHeight: 0 }}>
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent"></div>
            <Text className="ml-3 dark:text-gray-300">Loading chart data...</Text>
          </div>
        ) : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis 
                dataKey="date" 
                tick={{ fontSize: 10 }}
                angle={-45}
                textAnchor="end"
                height={60}
                padding={{ bottom: 10 }}
              />
              <YAxis 
                tick={{ fontSize: 10 }}
                label={{ value: selectedVolatility, angle: -90, position: 'insideLeft' }}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: '4px',
                  fontSize: '12px'
                }}
                labelStyle={{ color: '#374151' }}
              />
              <Line 
                type="monotone" 
                dataKey="value" 
                stroke={getVolatilityColor(metrics.current || 18)}
                strokeWidth={2}
                dot={false}
                name={selectedVolatility}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-full">
            <Text className="text-gray-500 dark:text-gray-400">No chart data available</Text>
          </div>
        )}
      </div>

      {/* Bottom Metrics Bar */}
      <Flex className="flex-wrap gap-2 text-xs dark:text-white">
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Closing:</Text>
          <Text className="dark:text-gray-300">{metrics.closing.toFixed(2)}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Current:</Text>
          <Text className="dark:text-gray-300">{metrics.current.toFixed(2)}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">LRR:</Text>
          <Text className="dark:text-gray-300">{metrics.lrr.toFixed(2)}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">TRR:</Text>
          <Text className="dark:text-gray-300">{metrics.trr.toFixed(2)}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">SI:</Text>
          <Text className="dark:text-gray-300">{typeof metrics.si === 'number' ? metrics.si.toFixed(2) : metrics.si}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">HH/HL:</Text>
          <Text className="dark:text-gray-300">{metrics.hhhl}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">LH/LL:</Text>
          <Text className="dark:text-gray-300">{metrics.lhll}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Vol={metrics.volTicker}:</Text>
          <Text className="dark:text-gray-300">
            {typeof metrics.vol === 'number' ? metrics.vol.toFixed(2) : '--'}
          </Text>
        </div>
      </Flex>
    </Card>
  );
};

export default VolatilityPanel;
