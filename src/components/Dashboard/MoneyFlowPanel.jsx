import React from 'react';
import { AreaChart, Area, BarChart, Bar, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, Landmark } from 'lucide-react';
import LoadingIndicator from '../common/LoadingIndicator';
import MarketVolumeTable from './MarketVolumeTable';
import UsDollarLiquidityPanel from './DollarLiquidityModels';
import MarketSituationReportCard, { getMarketSituationFreshness } from './MarketSituationReportCard';
import './MoneyFlowPanel.css';

const VERDICT_LABELS = {
  inflow: 'Inflow',
  outflow: 'Outflow',
  neutral: 'Neutral',
  unavailable: 'Unavailable',
};

// Every flow is a percent change over the same four windows. Weekly Fed data
// counts weeks; monthly FINRA data fills 1M, 3M and 1Y only.
const WINDOWS = [['1w', '1W'], ['1m', '1M'], ['3m', '3M'], ['1y', '1Y']];
const NET_WEEKS = { '1w': 1, '1m': 4, '3m': 13, '1y': 52 };
const NET_CHANGE_KEYS = { '1w': '1w', '1m': '4w', '3m': '13w', '1y': '52w' };
// Cash moves under half a percent read flat, like FINRA and FRED summaries.
const CASH_BAND = 0.005;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export const formatBillions = (value, { signed = false } = {}) => {
  if (!isNumber(value)) return '—';
  const sign = signed && value > 0 ? '+' : value < 0 ? '−' : '';
  const abs = Math.abs(value);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}T`;
  return `${sign}$${abs.toFixed(abs < 10 ? 1 : 0)}B`;
};

// Grid levels drop the $, like the rest of the dashboard's level columns.
const formatLevel = (value) => (isNumber(value) ? formatBillions(value).replace('$', '') : '—');

const formatShares = (value) => (isNumber(value) ? `${(value / 1e9).toFixed(2)}B` : '—');

const shortDate = (date) => {
  if (!date) return '—';
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const monthLabel = (date) => {
  if (!date) return '—';
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

// Same four-color blocks as Global Quads: green adds money to stocks, red
// drains it, yellow is mixed or low conviction, white is no reading.
const UP_READS = new Set([
  'inflow', 'expanding', 'accumulation', 'rising', 'levering up', 'deploying', 'buying', 'green',
]);
const DOWN_READS = new Set([
  'outflow', 'contracting', 'distribution', 'falling', 'de-levering', 'building', 'selling', 'red',
]);

const readTone = (read = '') => {
  const normalized = String(read || '').toLowerCase();
  if (UP_READS.has(normalized)) return 'up';
  if (DOWN_READS.has(normalized)) return 'down';
  if (!normalized || normalized === 'unavailable') return 'none';
  return 'flat';
};

const flowPct = (value) => `${Math.abs(value * 100).toFixed(2)}%`;

// A flow prints without its sign: green when money moved toward stocks, red
// when it moved away, gray when it rounds to nothing.
const FlowValue = ({ value }) => {
  if (!isNumber(value)) return <span className="is-muted">—</span>;
  const text = flowPct(value);
  const tone = text === '0.00%' ? 'is-muted' : value > 0 ? 'is-up' : 'is-down';
  return <span className={tone}>{text}</span>;
};

// A row lists only the windows its source can fill; the rest stay blank, and
// a listed window with no reading shows a dash.
const pickWindows = (keys, source = {}) => Object.fromEntries(keys.map((key) => [key, source?.[key] ?? null]));

const describeFigure = (label, value) => `${label}: ${isNumber(value) ? `${value < 0 ? '−' : ''}${flowPct(value)}` : 'unavailable'}`;

const cashRead = (deployed) => {
  if (!isNumber(deployed)) return 'unavailable';
  if (deployed > CASH_BAND) return 'deploying';
  if (deployed < -CASH_BAND) return 'building';
  return 'flat';
};

const negate = (value) => (isNumber(value) ? -value : null);

// Each Fed input as a share of the prior net liquidity, signed so that money
// added to the system is positive. The three inputs add up to the net change.
const contributions = (history = [], key, sign) => {
  const latest = history[history.length - 1];
  return Object.fromEntries(WINDOWS.map(([window]) => {
    const prior = history[history.length - 1 - NET_WEEKS[window]];
    const ok = latest && prior && isNumber(latest[key]) && isNumber(prior[key]) && prior.netLiquidity > 0;
    return [window, ok ? (sign * (latest[key] - prior[key])) / prior.netLiquidity : null];
  }));
};

const liquidityLayer = (data, { expanded }) => {
  const model = data?.layers?.netLiquidity;
  const net = model?.latest;
  const history = model?.history || [];
  const stack = data?.layers?.usStack;
  const netValues = Object.fromEntries(WINDOWS.map(([window]) => [window, net?.changes?.[NET_CHANGE_KEYS[window]]?.pct ?? null]));
  const source = net ? `Fed H.4.1 · week of ${shortDate(net.date)}` : 'Fed H.4.1 unavailable';
  return {
    id: 'liquidity',
    name: 'Liquidity',
    summary: describeFigure('Fed net liquidity 3M', netValues['3m']),
    read: net?.regime || 'unavailable',
    rows: [
      { label: 'Fed net liquidity', source, level: formatLevel(net?.netLiquidity), values: netValues, read: net?.regime },
      { label: 'Fed balance sheet', sub: true, source, level: formatLevel(net?.fedBalanceSheet), values: contributions(history, 'fedBalanceSheet', 1) },
      { label: 'Treasury cash released', sub: true, source, level: formatLevel(net?.treasuryGeneralAccount), values: contributions(history, 'treasuryGeneralAccount', -1) },
      // The reverse repo has sat near zero since 2025 and the M2 stack only
      // moves monthly, so both earn rows only in the expanded view.
      ...(expanded ? [
        { label: 'Reverse repo released', sub: true, source, level: formatLevel(net?.reverseRepo), values: contributions(history, 'reverseRepo', -1) },
        {
          label: 'U.S. M2 stack',
          source: stack ? `FRED · ${monthLabel(stack.date)} · M2 stack to GDP` : 'FRED unavailable',
          level: isNumber(stack?.stackToGdp) ? `${stack.stackToGdp.toFixed(2)}×` : '—',
          values: { '3m': stack?.growth3m ?? null },
          read: stack?.regime,
        },
      ] : []),
    ],
  };
};

const tapeLayer = (data) => {
  const participation = data?.layers?.participation;
  const trend = participation?.volumeTrend;
  const ratio = (window) => participation?.windows?.[window]?.upDownRatio;
  const skew = (window) => (isNumber(ratio(window)) ? ratio(window) - 1 : null);
  const asOf = participation?.asOf ? `Cboe · through ${shortDate(participation.asOf)}` : 'Cboe unavailable';
  return {
    id: 'tape',
    name: 'Tape',
    summary: describeFigure('Up vs down volume 1M', skew('1m')),
    read: participation?.regime || 'unavailable',
    rows: [
      {
        label: 'Up vs down volume',
        source: `${asOf} · up-session volume over down-session volume`,
        level: isNumber(ratio('1m')) ? `${ratio('1m').toFixed(2)}×` : '—',
        values: { '1m': skew('1m'), '3m': skew('3m') },
        read: participation?.regime,
      },
      {
        label: 'US volume vs 1Y avg',
        source: `${asOf} · average daily volume against the trailing ${trend?.baselineSessions || 252} sessions`,
        level: formatShares(trend?.latest?.volume),
        values: pickWindows(['1w', '1m', '3m'], trend?.windows),
        read: trend?.read,
      },
    ],
  };
};

const investorsLayer = (data) => {
  const margin = data?.layers?.margin?.latest;
  const funds = data?.layers?.moneyFunds?.latest;
  const marginChange = (window, field) => margin?.changes?.[window]?.[field] ?? null;
  const freeCredit = {
    '1m': negate(marginChange('1m', 'freeCredit')),
    '3m': negate(marginChange('3m', 'freeCredit')),
    '1y': negate(marginChange('12m', 'freeCredit')),
  };
  const fundsDeployed = {
    '1w': negate(funds?.change1w),
    '1m': negate(funds?.change4w),
    '3m': negate(funds?.change13w),
    '1y': negate(funds?.change52w),
  };
  const finra = margin ? `FINRA · ${monthLabel(margin.asOf)}` : 'FINRA unavailable';
  const leverage = margin?.leverage;
  return {
    id: 'investors',
    name: 'Investors',
    summary: describeFigure('Margin debt 3M', marginChange('3m', 'marginDebt')),
    read: { rising: 'levering up', falling: 'de-levering', flat: 'steady' }[leverage] || 'unavailable',
    rows: [
      {
        label: 'Margin debt',
        source: finra,
        level: formatLevel(margin?.marginDebt),
        values: { '1m': marginChange('1m', 'marginDebt'), '3m': marginChange('3m', 'marginDebt'), '1y': marginChange('12m', 'marginDebt') },
        read: leverage,
      },
      {
        label: 'Free credit deployed',
        source: `${finra} · idle brokerage cash; a falling balance is cash put to work`,
        level: formatLevel(margin?.freeCredit),
        values: freeCredit,
        read: cashRead(freeCredit['3m']),
      },
      {
        label: 'Money funds deployed',
        source: funds ? `FRED WRMFNS · ${shortDate(funds.date)} · a falling balance is cash put to work` : 'FRED WRMFNS unavailable',
        level: formatLevel(funds?.retailMoneyFunds),
        values: fundsDeployed,
        read: cashRead(fundsDeployed['3m']),
      },
    ],
  };
};

// Market Situation Report signals. Matched by label because the report's ids
// have changed between parser versions.
const SITUATION_SIGNALS = [
  { pattern: /gamma/i, label: 'Dealer gamma', notes: { negative: 'Amplifies moves', positive: 'Dampens moves' } },
  { pattern: /systematic/i, label: 'Systematic flows', notes: { negative: 'CTAs selling', positive: 'CTAs buying' } },
  { pattern: /pv band/i, label: 'PV band risk/reward', notes: {} },
  { pattern: /strategic/i, label: 'Strategic allocation', notes: {} },
];
const SIGNAL_TONES = { positive: 'up', negative: 'down', neutral: 'flat' };

const mechanicalLayer = (situation) => {
  const freshness = getMarketSituationFreshness(situation);
  const signals = freshness.status === 'unavailable' ? [] : situation?.data?.signals || [];
  const gvt = situation?.data?.chartMetrics?.spxGammaVolatilityThrottle?.gammaThrottle;
  const source = freshness.detail ? `Market Situation Report · ${freshness.detail}` : 'Market Situation Report unavailable';
  const rows = SITUATION_SIGNALS.map((definition) => {
    const signal = signals.find((candidate) => definition.pattern.test(candidate?.label || ''));
    const tone = SIGNAL_TONES[signal?.tone] || 'none';
    return {
      label: definition.label,
      source: freshness.status === 'delayed' ? `${source} · stale` : source,
      level: /gamma/i.test(definition.label) && isNumber(gvt) ? `GVT ${gvt < 0 ? '−' : ''}${Math.abs(gvt).toFixed(2)}` : '',
      note: definition.notes[signal?.tone] || '',
      read: signal ? { label: signal.value, tone } : null,
    };
  });
  const negatives = signals.filter((signal) => signal?.tone === 'negative').length;
  const positives = signals.filter((signal) => signal?.tone === 'positive').length;
  return {
    id: 'mechanical',
    name: 'Mechanical',
    summary: signals.length ? `${negatives} of ${signals.length} signals bearish · ${source}` : source,
    read: !signals.length ? 'unavailable' : negatives > positives ? 'selling' : positives > negatives ? 'buying' : 'mixed',
    rows,
  };
};

export const buildFlowLayers = (data, situation, { expanded = false } = {}) => [
  liquidityLayer(data, { expanded }),
  tapeLayer(data),
  investorsLayer(data),
  mechanicalLayer(situation),
];

const readOf = (read) => (read && typeof read === 'object'
  ? read
  : { label: read, tone: readTone(read) });

const ReadCell = ({ read }) => {
  if (!read) return <td className="money-flow-read" />;
  const { label, tone } = readOf(read);
  return <td className={`money-flow-read money-flow-block--${tone}`}>{label || '—'}</td>;
};

// A tile is colored by its layer's read, like a Global Quads cell; the
// figure behind the read sits in its tooltip.
const LayerTile = ({ layer, rowSpan }) => (
  <th
    scope="rowgroup"
    rowSpan={rowSpan}
    className={`money-flow-grid__tile money-flow-block--${readTone(layer.read)}`}
    title={layer.summary}
  >
    <span className="money-flow-grid__tile-name">{layer.name}</span>
    <span className="money-flow-grid__tile-read">{layer.read}</span>
  </th>
);

// Layers run down the left, each tile spanning its own rows; every row reads
// green when money moved toward stocks over that window.
export const MoneyFlowGrid = ({ data, situation, title = 'Money Flow', expanded = false, empty = null }) => {
  const layers = buildFlowLayers(data, situation, { expanded });
  return (
    <table className={`efr-mini-table money-flow-grid${expanded ? ' money-flow-grid--expanded' : ''}`} aria-label="Money flow">
      <thead>
        <tr>
          <th
            scope="col"
            className={`money-flow-grid__verdict money-flow-block--${data ? readTone(data.verdict) : 'none'}`}
            title="Verdict: supply leads, volume confirms"
          >
            {data ? VERDICT_LABELS[data.verdict] || VERDICT_LABELS.unavailable : ''}
          </th>
          <th scope="col" className="money-flow-grid__title">{title}</th>
          <th scope="col">Level</th>
          {WINDOWS.map(([window, label]) => <th scope="col" key={window}>{label}</th>)}
          <th scope="col">Read</th>
        </tr>
      </thead>
      <tbody>
        {!data ? (
          <tr><td colSpan={WINDOWS.length + 4} className="money-flow-grid__empty">{empty}</td></tr>
        ) : layers.flatMap((layer) => layer.rows.map((row, index) => (
          <tr key={`${layer.id}-${row.label}`} data-layer={layer.id}>
            {index === 0 && <LayerTile layer={layer} rowSpan={layer.rows.length} />}
            <td className={row.sub ? 'money-flow-grid__sub' : undefined} title={row.source}>{row.label}</td>
            <td>{row.level}</td>
            {row.note !== undefined
              ? <td colSpan={WINDOWS.length} className="money-flow-grid__note">{row.note}</td>
              : WINDOWS.map(([window]) => (
                <td key={window}>{row.values && window in row.values ? <FlowValue value={row.values[window]} /> : null}</td>
              ))}
            <ReadCell read={row.read} />
          </tr>
        )))}
      </tbody>
    </table>
  );
};

export const MoneyFlowPreview = ({ data, situation, loading = false, title }) => (
  <div className="money-flow-card">
    <MoneyFlowGrid
      data={data}
      situation={situation}
      title={title}
      empty={loading ? <LoadingIndicator label="Loading money flow…" size="sm" /> : 'No verified data available'}
    />
  </div>
);

const NetLiquidityChart = ({ model }) => (
  <section className="dollar-liquidity-model">
    <div className="dollar-liquidity-model-header">
      <div className="dollar-liquidity-title-block">
        <Landmark size={16} />
        <div>
          <h3>Fed net liquidity</h3>
          <span>Fed balance sheet − Treasury account − reverse repo, weekly</span>
        </div>
      </div>
    </div>
    {model?.status === 'stale' && (
      <div className="money-flow-note">The latest weekly Fed release is older than expected.</div>
    )}
    {model?.history?.length ? (
      <div className="dollar-liquidity-chart">
        <ResponsiveContainer width="100%" height={150}>
          <AreaChart data={model.history} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
            <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10 }} minTickGap={36} />
            <YAxis tick={{ fontSize: 10 }} width={52} domain={['auto', 'auto']} tickFormatter={(value) => formatBillions(value)} />
            <Tooltip labelFormatter={shortDate} formatter={(value) => [formatBillions(value), 'Net liquidity']} />
            <Area type="monotone" dataKey="netLiquidity" stroke="#4682B4" fill="#dbe7f3" strokeWidth={1.5} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    ) : (
      <div className="dollar-liquidity-empty">
        <strong>No verified net liquidity</strong>
        <span>{(model?.missingInputs || []).join(', ') || 'Weekly Fed data was unavailable on the latest refresh.'}</span>
      </div>
    )}
  </section>
);

const ParticipationChart = ({ participation }) => {
  const sessions = (participation?.history || []).slice(0, 21).reverse();
  return (
    <section className="dollar-liquidity-model">
      <div className="dollar-liquidity-model-header">
        <div className="dollar-liquidity-title-block">
          <Activity size={16} />
          <div>
            <h3>Up vs down volume · last 21 sessions</h3>
            <span>Cboe consolidated volume, colored by S&amp;P 500 close direction</span>
          </div>
        </div>
      </div>
      {sessions.length ? (
        <div className="dollar-liquidity-chart">
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={sessions} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10 }} minTickGap={24} />
              <YAxis tick={{ fontSize: 10 }} width={42} tickFormatter={formatShares} />
              <Tooltip labelFormatter={shortDate} formatter={(value) => [formatShares(value), 'Shares']} />
              <Bar dataKey="volume" radius={[2, 2, 0, 0]}>
                {sessions.map((session) => (
                  <Cell key={session.date} fill={session.change > 0 ? '#2f855a' : '#c0392b'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="dollar-liquidity-empty">
          <strong>No verified participation</strong>
          <span>{participation?.reason || 'Not enough paired up and down sessions to label volume.'}</span>
        </div>
      )}
    </section>
  );
};

const VolumeSection = () => (
  <section className="dollar-liquidity-model money-flow-volume">
    <div className="dollar-liquidity-model-header">
      <div className="dollar-liquidity-title-block">
        <Activity size={16} />
        <div>
          <h3>Volume · vs trailing averages</h3>
          <span>Completed-session U.S. and ex-U.S. share volume</span>
        </div>
      </div>
    </div>
    <MarketVolumeTable showDetails showAsOf={false} />
  </section>
);

const UsStackSection = ({ liquidityState }) => {
  const { data, loading, error } = liquidityState || {};
  if (data?.models?.us) return <UsDollarLiquidityPanel model={data.models.us} />;
  return (
    <section className="dollar-liquidity-model">
      {loading
        ? <LoadingIndicator label="Loading U.S. dollar liquidity…" size="lg" centered className="py-8" />
        : (
          <div className="dollar-liquidity-empty">
            <strong>No verified U.S. dollar liquidity</strong>
            <span>{error || 'The monthly U.S. stack was unavailable on the latest refresh.'}</span>
          </div>
        )}
    </section>
  );
};

const MoneyFlowPanel = ({ resourceState, liquidityState, situationState }) => {
  const { data, loading, error } = resourceState || {};
  if (loading && !data) {
    return (
      <section className="dashboard-card-chrome dollar-liquidity-panel money-flow-panel">
        <LoadingIndicator label="Loading money flow..." size="lg" centered className="py-8" />
      </section>
    );
  }
  if (!data) {
    return (
      <section className="dashboard-card-chrome dollar-liquidity-panel money-flow-panel">
        <div className="dollar-liquidity-empty error">
          <strong>Unable to load money flow</strong>
          <span>{error || 'No verified data available.'}</span>
        </div>
      </section>
    );
  }
  return (
    <section className="dashboard-card-chrome dollar-liquidity-panel money-flow-panel">
      <MoneyFlowGrid data={data} situation={situationState?.data} expanded />
      <div className="money-flow-summary">
        {(data.reasons || []).map((reason) => <p key={reason}>{reason}</p>)}
        <p className="money-flow-rule">
          Supply leads, volume confirms: Inflow needs expanding net liquidity and accumulation;
          Outflow needs contracting net liquidity and distribution. Investors and Mechanical are context and do not vote.
        </p>
      </div>
      <div className="dollar-liquidity-grid">
        <NetLiquidityChart model={data.layers?.netLiquidity} />
        <ParticipationChart participation={data.layers?.participation} />
      </div>
      <div className="dollar-liquidity-grid">
        <VolumeSection />
        <UsStackSection liquidityState={liquidityState} />
      </div>
      <MarketSituationReportCard
        snapshot={situationState?.data}
        loading={situationState?.loading}
        refreshing={situationState?.refreshing}
        error={situationState?.error}
        embedded
      />
    </section>
  );
};

export default MoneyFlowPanel;
