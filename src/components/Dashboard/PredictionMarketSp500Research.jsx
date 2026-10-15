import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import LoadingIndicator from '../common/LoadingIndicator';
import './PredictionMarketSp500Research.css';

const WINDOWS = ['30d', '90d', 'all'];

const ACTION_METRICS = [
  ['qualifiedDayActionRate', 'Qualified-day action'],
  ['qualifiedStrikeActionRate', 'Qualified-strike action'],
  ['yesRate', 'YES actions'],
  ['noRate', 'NO actions'],
  ['addOnRate', 'Add-on'],
  ['reEntryRate', 'Re-entry'],
  ['multiStrikeLadderRate', 'Multi-strike ladder'],
  ['offSetupFillRate', 'Off-setup fills'],
  ['earlyExitRate', 'Early exit'],
  ['holdToResolutionRate', 'Hold to resolution'],
];

const PERFORMANCE_METRICS = [
  ['netPnl', 'Net P&L', 'money'],
  ['aggregateRoi', 'Aggregate ROI', 'percent'],
  ['pnlPer100Risk', 'P&L / $100 risk', 'money'],
  ['profitFactor', 'Profit factor', 'number'],
  ['averageWin', 'Average win', 'money'],
  ['averageLoss', 'Average loss', 'money'],
  ['fees', 'Fees', 'money'],
  ['expectancyPerContract', 'Expectancy / contract', 'money'],
  ['maximumRealizedDrawdown', 'Max realized drawdown', 'money'],
];

const CALIBRATION_METRICS = [
  ['hitRate', 'Hit rate', 'percent'],
  ['profitableDayRate', 'Profitable-day rate', 'percent'],
  ['averageFillImpliedProbability', 'Average paid probability', 'percent'],
  ['allInBreakevenProbability', 'All-in breakeven', 'percent'],
  ['empiricalMinusPaidProbability', 'Empirical − paid', 'percentSigned'],
  ['brierScore', 'Brier score', 'number'],
  ['logLoss', 'Log loss', 'number'],
];

const PATH_METRICS = [
  ['preFillSpread', 'Pre-fill spread', 'points'],
  ['preFillBidDepth', 'Bid depth', 'number'],
  ['preFillAskDepth', 'Ask depth', 'number'],
  ['fillVersusPriorAsk', 'Fill − prior ask', 'pointsSigned'],
  ['depthParticipation', 'Depth participation', 'percent'],
  ['plus5BidChange', '+5m bid Δ', 'pointsSigned'],
  ['plus15BidChange', '+15m bid Δ', 'pointsSigned'],
  ['plus30BidChange', '+30m bid Δ', 'pointsSigned'],
  ['bestBidExcursion', 'Best bid excursion', 'pointsSigned'],
  ['worstBidExcursion', 'Worst bid excursion', 'pointsSigned'],
  ['lastPreCloseBidChange', 'Pre-close bid Δ', 'pointsSigned'],
];

const OUTCOME_GEOMETRY_METRICS = [
  ['officialEsSettlementCoverage', 'Official ES settlement', 'percent'],
  ['cashSpxCloseCoverage', 'Cash-SPX close', 'percent'],
  ['publishedCashRangeContainedCloseRate', 'Published range contained close', 'percent'],
  ['averageDistanceToStrike', 'Average ES − strike', 'pointsSigned'],
  ['averageSideAdjustedSettlementMargin', 'Average side-adjusted margin', 'pointsSigned'],
];

const numeric = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const money = (value, signed = false) => {
  const number = numeric(value);
  if (number == null) return '—';
  const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Math.abs(number));
  return signed ? `${number >= 0 ? '+' : '−'}${formatted}` : number < 0 ? `−${formatted}` : formatted;
};

const percent = (value, signed = false) => {
  const number = numeric(value);
  if (number == null) return '—';
  const formatted = `${Math.abs(number * 100).toFixed(1)}%`;
  return signed ? `${number >= 0 ? '+' : '−'}${formatted}` : formatted;
};

const displayMetric = (stat, type = 'number') => {
  const value = stat?.value;
  if (value == null) return '—';
  if (type === 'money') return money(value, value < 0);
  if (type === 'percent') return percent(value);
  if (type === 'percentSigned') return percent(value, true);
  if (type === 'points' || type === 'pointsSigned') {
    const number = numeric(value);
    return `${type === 'pointsSigned' && number >= 0 ? '+' : ''}${number.toFixed(3)}`;
  }
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 3 });
};

const timeLabel = (value) => {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return 'Unavailable';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short',
  }).format(new Date(parsed));
};

function MetricCell({ label, stat, type = 'percent' }) {
  const interval = stat?.interval95;
  return (
    <div className="fes-research-metric" title={stat?.reason || undefined} data-available={stat?.value != null}>
      <span>{label}</span>
      <strong>{displayMetric(stat, type)}</strong>
      {interval ? <small>95% Wilson {percent(interval.low)}–{percent(interval.high)} · n={stat.observations}</small> : <small>{stat?.reason || 'Verified prospective sample'}</small>}
    </div>
  );
}

function MetricCard({ title, subtitle, rows, values }) {
  return (
    <section className="fes-research-card">
      <header><h4>{title}</h4>{subtitle && <p>{subtitle}</p>}</header>
      <div className="fes-research-card__metrics">
        {rows.map(([key, label, type]) => <MetricCell key={key} label={label} stat={values?.[key]} type={type} />)}
      </div>
    </section>
  );
}

export default function PredictionMarketSp500Research({ accountId }) {
  const [windowValue, setWindowValue] = useState('all');
  const [cohortKey, setCohortKey] = useState('cashRangeZone');
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = requestId.current + 1;
    requestId.current = id;
    if (!accountId) {
      setState({ status: 'unavailable', data: null, error: 'The Individual IBKR account is unavailable.' });
      return;
    }
    setState((current) => ({ ...current, status: current.data ? 'refreshing' : 'loading', error: null }));
    try {
      const data = await MarketDataService.getPredictionMarketSp500Research({ account: accountId, window: windowValue });
      if (id === requestId.current) setState({ status: 'ready', data, error: null });
    } catch (error) {
      const payload = error?.response?.data;
      const message = typeof payload?.error === 'string'
        ? payload.error
        : payload?.error?.message || 'ForecastEx FES research is unavailable.';
      if (id === requestId.current) setState({ status: 'unavailable', data: null, error: message });
    }
  }, [accountId, windowValue]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { window.clearInterval(timer); requestId.current += 1; };
  }, [load]);

  const data = state.data;
  const cohort = data?.cohorts?.tables?.[cohortKey];
  const provenance = useMemo(() => data?.provenance ? Object.entries(data.provenance) : [], [data?.provenance]);

  if (!accountId || state.status === 'unavailable') {
    return <div className="fes-research-state" data-state="unavailable"><strong>Research unavailable</strong><span>{state.error}</span></div>;
  }
  if (state.status === 'loading') return <div className="fes-research-state"><LoadingIndicator label="Loading prospective FES research…" size="sm" /></div>;

  return (
    <div className="fes-research" data-status={state.status}>
      <header className="fes-research-header">
        <div>
          <p className="fes-research-eyebrow">ForecastEx FES · read-only research</p>
          <h3>{data.collector?.resolverSymbol || 'Exact ES resolver unavailable'}{data.collector?.resolverMonthLabel ? ` · ${data.collector.resolverMonthLabel}` : ''} <span>SP500 hand ledger</span></h3>
          <p>{data.collector?.measurementDate || 'Measurement date unavailable'} · last trade {timeLabel(data.collector?.lastTradeAt)} · resolution {timeLabel(data.collector?.resolutionAt)} · payout {timeLabel(data.collector?.payoutAt)}</p>
        </div>
        <div className="fes-research-header__status">
          <span data-status={data.collector?.status}>{data.collector?.status || 'unavailable'}</span>
          <small>Prospective since {timeLabel(data.collector?.startedAt)}</small>
          {data.collector?.reason && <small>{data.collector.reason}</small>}
          {state.status === 'refreshing' && <small>Refreshing…</small>}
        </div>
        <div className="fes-research-window" role="group" aria-label="Research date window">
          {WINDOWS.map((item) => <button key={item} type="button" aria-pressed={windowValue === item} onClick={() => setWindowValue(item)}>{item.toUpperCase()}</button>)}
        </div>
      </header>

      <div className="fes-research-warning" data-ready={data.exploratory?.status === 'minimum_sample_reached'}>
        <strong>{data.exploratory?.label}</strong>
        <span>{data.exploratory?.warning}</span>
      </div>

      <section className="fes-research-hud" aria-label="Action frequency">
        {ACTION_METRICS.map(([key, label]) => <MetricCell key={key} label={label} stat={data.actionFrequency?.[key]} />)}
      </section>

      <div className="fes-research-grid">
        <MetricCard title="Performance" subtitle={`${data.performance?.resolvedContracts || 0} resolved contracts · ${data.performance?.uniqueEventDays || 0} unique days`} rows={PERFORMANCE_METRICS} values={data.performance} />
        <MetricCard title="Binary calibration" subtitle={data.calibration?.label} rows={CALIBRATION_METRICS} values={data.calibration} />
        <MetricCard title="Execution & direct quote path" subtitle={`${data.executionAndPath?.sampleExecutions || 0} matched buy executions`} rows={PATH_METRICS} values={data.executionAndPath} />
        <MetricCard title="Outcome geometry" subtitle={data.outcomeGeometry?.label} rows={OUTCOME_GEOMETRY_METRICS} values={data.outcomeGeometry} />
        <section className="fes-research-card">
          <header><h4>Pass analysis</h4><p>{data.passAnalysis?.label}</p></header>
          <div className="fes-research-card__metrics">
            <div className="fes-research-metric"><span>Passed / resolved</span><strong>{data.passAnalysis?.passedOpportunities || 0} / {data.passAnalysis?.resolvedPassedOpportunities || 0}</strong><small>Qualified opportunities not bought</small></div>
            <MetricCell label="Average hypothetical" stat={data.passAnalysis?.averageCounterfactualPerContract} type="money" />
            <MetricCell label="Total hypothetical" stat={data.passAnalysis?.totalCounterfactualPerContract} type="money" />
            <MetricCell label="Entry-context coverage" stat={data.coverage?.entryContextCoverage} type="percent" />
          </div>
        </section>
      </div>

      <section className="fes-research-table-card">
        <header>
          <div><h4>Cohort study</h4><p>Mutually exclusive buckets; contract and unique-day samples are always separate.</p></div>
          <label>Cohort<select value={cohortKey} onChange={(event) => setCohortKey(event.target.value)}>{(data.cohorts?.dimensions || []).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
        </header>
        <div className="fes-research-table-wrap">
          <table className="fes-research-table">
            <thead><tr><th>{cohort?.label || 'Cohort'}</th><th>Contracts</th><th>Days</th><th>Action</th><th>Hit</th><th>P&L</th><th>ROI</th><th>Calibration gap</th><th>+15m bid Δ</th><th>Coverage</th></tr></thead>
            <tbody>{(cohort?.rows || []).map((row) => <tr key={row.cohort}><th scope="row">{row.cohort}</th><td>{row.contractCount}</td><td>{row.uniqueDays}</td><td>{displayMetric(row.actionRate, 'percent')}</td><td>{displayMetric(row.hitRate, 'percent')}</td><td>{displayMetric(row.pnl, 'money')}</td><td>{displayMetric(row.roi, 'percent')}</td><td>{displayMetric(row.calibrationGap, 'percentSigned')}</td><td>{displayMetric(row.quotePathChange, 'pointsSigned')}</td><td>{displayMetric(row.contextCoverage, 'percent')}</td></tr>)}</tbody>
          </table>
          {!cohort?.rows?.length && <p className="fes-research-empty">No qualified prospective opportunities in this window.</p>}
        </div>
      </section>

      <section className="fes-research-table-card">
        <header><div><h4>Recent hands</h4><p>One FES measurement day per hand. Legacy/unmatched contracts stay labeled and out of contextual cohorts.</p></div></header>
        <div className="fes-research-table-wrap">
          <table className="fes-research-table fes-research-hands">
            <thead><tr><th>Date / resolver</th><th>Entry context</th><th>Action / pass</th><th>Outcome geometry</th><th>P&L</th></tr></thead>
            <tbody>{(data.hands || []).map((hand) => <tr key={`${hand.eventDate}-${hand.generationKey || ''}`}><th scope="row"><strong>{hand.eventDate}</strong><small>{hand.resolverSymbol || 'Resolver unavailable'}</small>{hand.legacyUnmatched && <em>Legacy / unmatched</em>}</th><td>{hand.entryContext ? <><strong>{hand.entryContext.directionalAlignment}</strong><small>{hand.entryContext.cashRangeZone} cash · {hand.entryContext.strikeZone} strike</small><small>Basis {hand.entryContext.basis ?? '—'} · Gamma {hand.entryContext.gammaSign} · VIX {hand.entryContext.vixRegime}</small></> : 'Unavailable'}</td><td><strong>{hand.actionCount} fills · {hand.passCount} passes</strong><small>{hand.action.map((item) => `${item.direction || 'BUY'} ${item.side} ${item.strike} @ ${item.fillPrice ?? '—'}${item.actionType === 'off_setup_entry' ? ' · off setup' : item.actionType === 'exit' ? ' · exit' : ''}`).join(' · ') || 'No action'}</small>{hand.passes?.length > 0 && <small>Passed {hand.passes.map((item) => `${item.side} ${item.strike} @ ${item.ask}`).join(' · ')}</small>}</td><td>{hand.outcome.length ? hand.outcome.map((item, index) => <span key={`${item.strike}-${index}`}><strong>{item.result || '—'} · ES {item.officialEsSettlement ?? '—'}</strong><small>{item.side} {item.strike} · margin {item.sideAdjustedSettlementMargin ?? '—'}</small><small>Cash SPX {item.cashSpxClose ?? '—'} · {item.cashSpxClosingRangeZone || 'unavailable'} · range contained {item.publishedCashRangeContainedClose == null ? '—' : item.publishedCashRangeContainedClose ? 'yes' : 'no'}</small></span>) : 'Pending / unavailable'}</td><td className={numeric(hand.pnl) > 0 ? 'positive' : numeric(hand.pnl) < 0 ? 'negative' : ''}>{hand.pnl == null ? '—' : money(hand.pnl, true)}</td></tr>)}</tbody>
          </table>
          {!data.hands?.length && <p className="fes-research-empty">Prospective collection has not produced a hand yet.</p>}
        </div>
      </section>

      <details className="fes-research-provenance">
        <summary>Data provenance and availability</summary>
        <div>{provenance.length ? provenance.map(([key, source]) => <section key={key}><strong>{key}</strong><span>{source?.status || 'unavailable'}</span><small>{source?.source || source?.symbol || 'No verified source'}{source?.asOf ? ` · ${timeLabel(source.asOf)}` : ''}</small></section>) : <p>No verified prospective context provenance is available.</p>}</div>
      </details>
    </div>
  );
}
