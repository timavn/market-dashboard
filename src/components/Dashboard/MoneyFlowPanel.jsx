import React from 'react';
import { AreaChart, Area, BarChart, Bar, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, Landmark } from 'lucide-react';
import LoadingIndicator from '../common/LoadingIndicator';
import MarketVolumeTable from './MarketVolumeTable';
import UsDollarLiquidityPanel from './DollarLiquidityModels';
import './MoneyFlowPanel.css';

const CHANGE_WINDOWS = ['1w', '4w', '13w', '52w'];
const VERDICT_LABELS = {
  inflow: 'Inflow',
  outflow: 'Outflow',
  neutral: 'Neutral',
  unavailable: 'Unavailable',
};

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export const formatBillions = (value, { signed = false } = {}) => {
  if (!isNumber(value)) return '—';
  const sign = signed && value > 0 ? '+' : value < 0 ? '−' : '';
  const abs = Math.abs(value);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}T`;
  return `${sign}$${abs.toFixed(abs < 10 ? 1 : 0)}B`;
};

const formatPct = (value, digits = 1) => (
  isNumber(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value * 100).toFixed(digits)}%` : '—'
);

const formatRatio = (value) => (isNumber(value) ? value.toFixed(2) : '—');

const formatShares = (value) => (isNumber(value) ? `${(value / 1e9).toFixed(2)}B` : '—');

const shortDate = (date) => {
  if (!date) return '—';
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

// Same four-color blocks as Global Quads: green adds money to stocks, red
// drains it, yellow is mixed or low conviction, white is no reading.
const UP_READS = new Set([
  'inflow', 'expanding', 'accumulation', 'confirmed advance', 'leverage rising', 'cash drawing down', 'adding', 'green',
]);
const DOWN_READS = new Set([
  'outflow', 'contracting', 'distribution', 'confirmed decline', 'leverage falling', 'cash building', 'draining',
  'red risk',
]);

const readTone = (read = '') => {
  const normalized = String(read || '').toLowerCase();
  if (UP_READS.has(normalized)) return 'up';
  if (DOWN_READS.has(normalized)) return 'down';
  if (!normalized || normalized === 'unavailable') return 'none';
  return 'flat';
};

const directionClass = (direction = '') => ({
  up: 'is-up', down: 'is-down', flat: 'is-flat', none: 'is-muted',
}[readTone(direction)]);

export const ReadBlock = ({ read, label = read, strong = false }) => (
  <span className={`money-flow-block money-flow-block--${readTone(read)}${strong ? ' money-flow-block--strong' : ''}`}>
    {label || '—'}
  </span>
);

export const VerdictPill = ({ verdict }) => (
  <ReadBlock read={verdict} label={VERDICT_LABELS[verdict] || VERDICT_LABELS.unavailable} strong />
);

// Weekly change in one net-liquidity input. Moves under $10B read flat.
// Fed assets add money as they grow; the Treasury account and reverse repo
// take cash out of the system as they fill.
const componentRead = (history = [], key, weeks, [upRead, downRead]) => {
  const latest = history[history.length - 1];
  const prior = history[history.length - 1 - weeks];
  const change = latest && prior ? latest[key] - prior[key] : null;
  if (!isNumber(change)) return { change: null, read: 'unavailable' };
  if (Math.abs(change) < 10) return { change, read: 'flat' };
  return { change, read: change > 0 ? upRead : downRead };
};

const FED_ASSETS_READS = ['expanding', 'contracting'];
const CASH_ACCOUNT_READS = ['draining', 'adding'];

// Idle brokerage and fund cash piling up is money parked outside stocks.
const cashRead = (pct) => {
  if (!isNumber(pct)) return 'unavailable';
  if (pct > 0.005) return 'cash building';
  if (pct < -0.005) return 'cash drawing down';
  return 'cash flat';
};

const PreviewTable = ({ label, rows }) => (
  <table className="efr-mini-table money-flow-mini" aria-label={`Money flow ${label.toLowerCase()}`}>
    <thead>
      <tr><th>{label}</th><th>Value</th><th>Read</th></tr>
    </thead>
    <tbody>
      {rows.map(([rowLabel, value, read, readLabel]) => (
        <tr key={rowLabel}>
          <td>{rowLabel}</td>
          <td>{value}</td>
          <td className={`money-flow-read money-flow-block--${readTone(read)}`}>{readLabel || read || '—'}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

// One card for money entering or leaving stocks: supply on the left, the
// volume and positioning that confirm it on the right. `volume` is the
// exchange-volume table, which loads on its own.
// The volume table keeps the same slot in every state so it never remounts.
const MoneyFlowCard = ({ supply, participation, volume }) => (
  <div className="money-flow-card">
    {supply}
    <div className="money-flow-card__column">
      {participation}
      {volume}
    </div>
  </div>
);

export const MoneyFlowPreview = ({ data, loading = false, volume = null }) => {
  if (!data) {
    const empty = (
      <div className="efr-reference-empty">{loading ? <LoadingIndicator label="Loading money flow…" size="sm" /> : 'No verified data available'}</div>
    );
    return <MoneyFlowCard supply={empty} participation={null} volume={volume} />;
  }
  const netModel = data.layers?.netLiquidity;
  const net = netModel?.latest;
  const participation = data.layers?.participation;
  const margin = data.layers?.margin?.latest;
  const funds = data.layers?.moneyFunds?.latest;
  const usStack = data.layers?.usStack;
  const change = (key) => net?.changes?.[key];
  const componentRow = (label, key, weeks, reads) => {
    const { change: delta, read } = componentRead(netModel?.history, key, weeks, reads);
    return [label, formatBillions(delta, { signed: true }), read];
  };
  const supplyRows = [
    ['Fed net liquidity', formatBillions(net?.netLiquidity), net?.regime],
    ['1W change', formatBillions(change('1w')?.change, { signed: true }), change('1w')?.direction],
    ['4W change', formatBillions(change('4w')?.change, { signed: true }), change('4w')?.direction],
    ['13W change', formatBillions(change('13w')?.change, { signed: true }), change('13w')?.direction],
    ['52W change', formatBillions(change('52w')?.change, { signed: true }), change('52w')?.direction],
    componentRow('Fed balance sheet 1W', 'fedBalanceSheet', 1, FED_ASSETS_READS),
    componentRow('Fed balance sheet 4W', 'fedBalanceSheet', 4, FED_ASSETS_READS),
    componentRow('Treasury cash 1W', 'treasuryGeneralAccount', 1, CASH_ACCOUNT_READS),
    componentRow('Treasury cash 4W', 'treasuryGeneralAccount', 4, CASH_ACCOUNT_READS),
    componentRow('Reverse repo 4W', 'reverseRepo', 4, CASH_ACCOUNT_READS),
    ['U.S. dollar liquidity 3M', formatPct(usStack?.growth3m), usStack?.regime],
  ];
  const freeCredit = margin?.changes?.['3m']?.freeCredit;
  const funds4w = cashRead(funds?.change4w);
  const participationRows = [
    ['Up/down volume 1M', formatRatio(participation?.windows?.['1m']?.upDownRatio), participation?.windows?.['1m']?.regime],
    ['Up/down volume 3M', formatRatio(participation?.windows?.['3m']?.upDownRatio), participation?.windows?.['3m']?.regime],
    [
      `S&P ${participation?.asOf ? shortDate(participation.asOf) : 'last session'}`,
      participation?.latest ? `${formatPct(participation.latest.change, 2)} · vol ${formatPct(participation.latest.volumeVs1m, 0)}` : '—',
      participation?.latest?.signal,
    ],
    ['Margin debt 3M', formatPct(margin?.changes?.['3m']?.marginDebt), margin ? `leverage ${margin.leverage}` : null, margin?.leverage],
    ['Brokerage free credit 3M', formatPct(freeCredit), cashRead(freeCredit), cashRead(freeCredit).replace('cash ', '')],
    ['Retail money funds 4W', formatPct(funds?.change4w), funds4w, funds4w.replace('cash ', '')],
    ['Retail money funds 13W', formatPct(funds?.change13w), funds ? `cash ${funds.cash}` : null, funds?.cash],
  ];
  return (
    <MoneyFlowCard
      supply={<PreviewTable label="Supply" rows={supplyRows} />}
      participation={<PreviewTable label="Participation" rows={participationRows} />}
      volume={volume}
    />
  );
};

const SupplySection = ({ model }) => {
  const latest = model?.latest;
  return (
    <section className="dollar-liquidity-model">
      <div className="dollar-liquidity-model-header">
        <div className="dollar-liquidity-title-block">
          <Landmark size={16} />
          <div>
            <h3>Supply · Fed net liquidity</h3>
            <span>Fed balance sheet − Treasury account − reverse repo</span>
          </div>
        </div>
        <ReadBlock read={latest?.regime || 'unavailable'} strong />
      </div>
      {!latest ? (
        <div className="dollar-liquidity-empty">
          <strong>No verified net liquidity</strong>
          <span>{(model?.missingInputs || []).join(', ') || 'Weekly Fed data was unavailable on the latest refresh.'}</span>
        </div>
      ) : (
        <>
          <div className="dollar-liquidity-headlines">
            <div><span>Net liquidity</span><strong>{formatBillions(latest.netLiquidity)}</strong></div>
            <div><span>Fed assets</span><strong>{formatBillions(latest.fedBalanceSheet)}</strong></div>
            <div><span>TGA</span><strong>{formatBillions(latest.treasuryGeneralAccount)}</strong></div>
            <div><span>Reverse repo</span><strong>{formatBillions(latest.reverseRepo)}</strong></div>
          </div>
          <table className="dollar-liquidity-growth-table">
            <thead>
              <tr><th>Week of {shortDate(latest.date)}</th>{CHANGE_WINDOWS.map((key) => <th key={key}>{key.toUpperCase()}</th>)}</tr>
            </thead>
            <tbody>
              <tr>
                <td>Change</td>
                {CHANGE_WINDOWS.map((key) => (
                  <td key={key} className={directionClass(latest.changes?.[key]?.direction)}>
                    {formatBillions(latest.changes?.[key]?.change, { signed: true })}
                  </td>
                ))}
              </tr>
              <tr>
                <td>Percent</td>
                {CHANGE_WINDOWS.map((key) => <td key={key}>{formatPct(latest.changes?.[key]?.pct)}</td>)}
              </tr>
            </tbody>
          </table>
          {model.status === 'stale' && (
            <div className="money-flow-note">The latest weekly Fed release is older than expected.</div>
          )}
          <div className="dollar-liquidity-chart">
            <ResponsiveContainer width="100%" height={150}>
              <AreaChart data={model.history || []} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
                <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10 }} minTickGap={36} />
                <YAxis tick={{ fontSize: 10 }} width={52} domain={['auto', 'auto']} tickFormatter={(value) => formatBillions(value)} />
                <Tooltip labelFormatter={shortDate} formatter={(value) => [formatBillions(value), 'Net liquidity']} />
                <Area type="monotone" dataKey="netLiquidity" stroke="#4682B4" fill="#dbe7f3" strokeWidth={1.5} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </section>
  );
};

const ParticipationSection = ({ participation }) => {
  const windows = participation?.windows || {};
  const sessions = (participation?.history || []).slice(0, 21).reverse();
  return (
    <section className="dollar-liquidity-model">
      <div className="dollar-liquidity-model-header">
        <div className="dollar-liquidity-title-block">
          <Activity size={16} />
          <div>
            <h3>Participation · up vs down volume</h3>
            <span>Cboe consolidated volume by S&amp;P 500 close direction</span>
          </div>
        </div>
        <ReadBlock read={participation?.regime || 'unavailable'} strong />
      </div>
      {participation?.status !== 'ok' ? (
        <div className="dollar-liquidity-empty">
          <strong>No verified participation</strong>
          <span>{participation?.reason || 'Not enough paired up and down sessions to label volume.'}</span>
        </div>
      ) : (
        <>
          <div className="dollar-liquidity-headlines">
            <div><span>Last session</span><strong>{shortDate(participation.asOf)}</strong></div>
            <div>
              <span>S&amp;P 500</span>
              <strong className={participation.latest?.change > 0 ? 'is-up' : 'is-down'}>{formatPct(participation.latest?.change, 2)}</strong>
            </div>
            <div><span>Volume vs 1M</span><strong>{formatPct(participation.latest?.volumeVs1m)}</strong></div>
            <div>
              <span>Read</span>
              <strong><ReadBlock read={participation.latest?.signal} /></strong>
            </div>
          </div>
          <table className="dollar-liquidity-growth-table">
            <thead>
              <tr><th>Window</th><th>Up days</th><th>Down days</th><th>Up vol avg</th><th>Down vol avg</th><th>Ratio</th></tr>
            </thead>
            <tbody>
              {[['1M', windows['1m']], ['3M', windows['3m']]].map(([label, stats]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{stats?.upDays ?? '—'}</td>
                  <td>{stats?.downDays ?? '—'}</td>
                  <td>{formatShares(stats?.upVolumeAvg)}</td>
                  <td>{formatShares(stats?.downVolumeAvg)}</td>
                  <td>{formatRatio(stats?.upDownRatio)} <ReadBlock read={stats?.regime} /></td>
                </tr>
              ))}
            </tbody>
          </table>
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
        </>
      )}
    </section>
  );
};

const monthLabel = (date) => {
  if (!date) return '—';
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

const ContextSection = ({ layers = {} }) => {
  const { usStack, margin, moneyFunds } = layers;
  const marginLatest = margin?.latest;
  const fundsLatest = moneyFunds?.latest;
  const rows = [
    {
      label: 'U.S. M2 stack',
      level: usStack ? `Stack/GDP ${isNumber(usStack.stackToGdp) ? usStack.stackToGdp.toFixed(2) : '—'}` : '—',
      change: usStack ? `3M ${formatPct(usStack.growth3m)}` : '—',
      read: usStack?.regime,
      asOf: usStack ? monthLabel(usStack.date) : '—',
      source: 'FRED',
    },
    {
      label: 'Margin debt',
      level: formatBillions(marginLatest?.marginDebt),
      change: marginLatest ? `3M ${formatPct(marginLatest.changes?.['3m']?.marginDebt)}` : '—',
      read: marginLatest ? `leverage ${marginLatest.leverage}` : margin?.status,
      asOf: marginLatest ? monthLabel(marginLatest.asOf) : '—',
      source: 'FINRA',
      stale: margin?.status === 'stale',
    },
    {
      label: 'Brokerage free credit',
      level: formatBillions(marginLatest?.freeCredit),
      change: marginLatest ? `3M ${formatPct(marginLatest.changes?.['3m']?.freeCredit)}` : '—',
      read: marginLatest ? cashRead(marginLatest.changes?.['3m']?.freeCredit) : margin?.status,
      asOf: marginLatest ? monthLabel(marginLatest.asOf) : '—',
      source: 'FINRA',
      stale: margin?.status === 'stale',
    },
    {
      label: 'Retail money funds',
      level: formatBillions(fundsLatest?.retailMoneyFunds),
      change: fundsLatest ? `13W ${formatPct(fundsLatest.change13w)}` : '—',
      read: fundsLatest ? `cash ${fundsLatest.cash}` : moneyFunds?.status,
      asOf: fundsLatest ? shortDate(fundsLatest.date) : '—',
      source: 'FRED',
      stale: moneyFunds?.status === 'stale',
    },
  ];
  return (
    <section className="money-flow-context">
      <h3>Context <span>(does not vote)</span></h3>
      <table className="dollar-liquidity-growth-table">
        <thead>
          <tr><th>Series</th><th>Level</th><th>Change</th><th>Read</th><th>As of</th><th>Source</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{row.level}</td>
              <td>{row.change}</td>
              <td><ReadBlock read={row.read || 'unavailable'} /></td>
              <td className={row.stale ? 'is-flat' : undefined}>{row.asOf}{row.stale ? ' · stale' : ''}</td>
              <td>{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
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

const MoneyFlowPanel = ({ resourceState, liquidityState }) => {
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
      <div className="money-flow-summary">
        <VerdictPill verdict={data.verdict} />
        <div>
          {(data.reasons || []).map((reason) => <p key={reason}>{reason}</p>)}
          <p className="money-flow-rule">
            Supply leads, volume confirms: Inflow needs expanding net liquidity and accumulation;
            Outflow needs contracting net liquidity and distribution.
          </p>
        </div>
      </div>
      <div className="dollar-liquidity-grid">
        <SupplySection model={data.layers?.netLiquidity} />
        <ParticipationSection participation={data.layers?.participation} />
      </div>
      <div className="dollar-liquidity-grid">
        <VolumeSection />
        <UsStackSection liquidityState={liquidityState} />
      </div>
      <ContextSection layers={data.layers} />
    </section>
  );
};

export default MoneyFlowPanel;
