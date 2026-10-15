import React, { useState, useEffect, useMemo } from 'react';
import { Card, Metric, Text, Grid, Badge, Flex } from '@tremor/react';
import PopoverSelect from '../common/PopoverSelect';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { USDMarketService } from '../../services/api/usdMarketService';
import LoadingIndicator from '../common/LoadingIndicator';
import { useSurfaceActivity } from '../common/PersistentSurface';
import { verifiedHistoricalRecords, verifiedReferenceQuote } from '../../utils/legacyMarketDisplay';

// Currency index mapping
const CURRENCY_INDEXES = {
  'USDEUR': { ticker: 'FXE', name: 'Euro' },
  'USDJPY': { ticker: 'FXY', name: 'Japanese Yen' },
  'USDCHF': { ticker: 'FXF', name: 'Swiss Franc' },
  'USDGBP': { ticker: 'FXB', name: 'British Pound' },
  'USDCAD': { ticker: 'FXC', name: 'Canadian Dollar' },
  'USDCNY': { ticker: 'FXCH', name: 'Chinese Yuan' },
  'USDAUD': { ticker: 'FXA', name: 'Australian Dollar' },
  'USD': { ticker: 'UUP', name: 'U.S. Dollar' },
  'GOLD': { ticker: 'GLD', name: 'Gold' }
};

const TIMEFRAMES = [
  { value: '7', label: '1W' }, { value: '30', label: '1M' },
  { value: '90', label: '3M' }, { value: '180', label: '6M' }, { value: '365', label: '1Y' },
];
const EMPTY_PAIRS = [];
const percent = (value) => value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

function MiniSparkline({ data }) {
  if (!data?.length) return <div className="h-[88px] flex items-center justify-center text-gray-400 text-xs">No verified history</div>;
  return <><ResponsiveContainer width="100%" height={88}>
    <LineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
      <XAxis dataKey="date" tick={false} tickLine={false} />
      <YAxis domain={['dataMin', 'dataMax']} tick={false} tickLine={false} width={1} />
      <Line type="monotone" dataKey="close" stroke="#059669" strokeWidth={1.5} dot={false} activeDot={false} />
    </LineChart>
  </ResponsiveContainer><Text className="text-xs text-gray-500">
    Historical reference · As of {data.at(-1).dateObj.toLocaleDateString()}
  </Text></>;
}

const USDProxies = ({ dxy, currencyPairs = EMPTY_PAIRS, loading, error, indexQuotes = {} }) => {
  const [fullHistory, setFullHistory] = useState({});
  const [timeframes, setTimeframes] = useState({});
  const active = useSurfaceActivity();
  const symbols = useMemo(() => [...new Set([
    ...currencyPairs.map((pair) => pair.pair),
    ...currencyPairs.map((pair) => CURRENCY_INDEXES[pair.pair]?.ticker).filter(Boolean),
  ])], [currencyPairs]);
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const load = () => Promise.all(symbols.map(async (symbol) => {
      try {
        const response = await USDMarketService.getHistoricalData(symbol, 365);
        return [symbol, verifiedHistoricalRecords(response, symbol)];
      } catch { return [symbol, []]; }
    })).then((entries) => { if (!cancelled) setFullHistory(Object.fromEntries(entries)); });
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVisible);
      load();
    };
    if (document.hidden) document.addEventListener('visibilitychange', onVisible);
    else load();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, symbols]);
  const history = useMemo(() => Object.fromEntries(symbols.map((symbol) => {
    const cutoff = Date.now() - Number(timeframes[symbol] || 30) * 86_400_000;
    return [symbol, (fullHistory[symbol] || []).filter((row) => row.dateObj.getTime() >= cutoff)];
  })), [fullHistory, symbols, timeframes]);

  const referenceContent = (symbol, quote, chart = true) => {
    const reference = verifiedReferenceQuote(quote, symbol);
    return <>
      <Metric className="dark:text-white">{reference?.value.toFixed(2) ?? '—'}</Metric>
      {chart && <MiniSparkline data={history[symbol]} />}
      <Badge color={reference?.changePercent == null ? 'gray' : reference.changePercent >= 0 ? 'emerald' : 'red'} size="xs">
        {percent(reference?.changePercent)}
      </Badge>
      <Text className="text-xs text-gray-500 mt-1">
        {reference ? `Reference · As of ${new Date(reference.asOf).toLocaleString()}` : 'Verified quote unavailable'}
      </Text>
    </>;
  };
  const timeframe = (symbol) => <PopoverSelect
    ariaLabel={`${symbol} history period`}
    value={timeframes[symbol] || '30'} options={TIMEFRAMES}
    onChange={(value) => setTimeframes((current) => ({ ...current, [symbol]: value }))}
    buttonClassName="max-w-[60px] min-w-[50px]"
  />;
  if (loading) return <Card><LoadingIndicator label="Loading USD data..." size="lg" centered className="py-8" /></Card>;
  if (error) return <Card><Text>Error loading USD data: {error}</Text></Card>;
  return <Card className="dark:bg-gray-800 rounded-lg">
    <Grid numItems={1} numItemsLg={12} className="gap-4">
      <div className="col-span-12 lg:col-span-4">
        <Grid numItems={1} className="gap-4">
          {[['DXY', 'DXY', dxy], ['UUP', 'UUP (USD Index)', indexQuotes.UUP], ['GLD', 'GLD (Gold)', indexQuotes.GLD]].map(([symbol, label, quote]) => (
            <Card key={symbol} className="bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <Text className="text-sm font-semibold mb-2 dark:text-white">{label}</Text>
              {referenceContent(symbol, quote, false)}
            </Card>
          ))}
        </Grid>
      </div>
      <div className="col-span-12 lg:col-span-8">
        <Grid numItems={2} numItemsSm={3} className="gap-4">
          {currencyPairs.map((pair) => {
            const index = CURRENCY_INDEXES[pair.pair];
            return <Card key={pair.pair} className="dark:bg-gray-700 rounded-lg">
              <Flex justifyContent="between" alignItems="center" className="mb-2">
                <Text className="text-xs font-semibold dark:text-white">{pair.name}</Text>
                {timeframe(pair.pair)}
              </Flex>
              {referenceContent(pair.pair, pair)}
              {index && <div className="mt-2 pt-2 border-t dark:border-gray-600">
                <Flex justifyContent="between" alignItems="center">
                  <Text className="text-xs font-semibold dark:text-gray-300">{index.ticker}</Text>
                  {timeframe(index.ticker)}
                </Flex>
                {referenceContent(index.ticker, indexQuotes[index.ticker])}
              </div>}
            </Card>;
          })}
        </Grid>
      </div>
    </Grid>
  </Card>;
};
export default USDProxies;
