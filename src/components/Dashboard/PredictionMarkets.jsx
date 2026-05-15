import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTheme } from '../../context/ThemeContext';
import './PredictionMarkets.css';
import { MOCK_CONTRACTS, MOCK_SETTINGS } from '../../utils/predictionMarketsMockData';
import {
  adjustProbability,
  grossEdgeYes,
  grossEdgeNo,
  netEdge as calcNetEdge,
  evYesPerContract,
  evNoPerContract,
  kellyFraction,
  fractionalKellySizing,
  calcSizing,
  getRecommendation,
  bandToProb,
  brierScore,
  logLoss,
  calibrationBuckets,
  winRate as calcWinRate,
  evResiduals,
  performanceByDimension,
  openRiskSummary,
  validateContract,
} from '../../utils/predictionMarketsCalc';

const API_BASE = (process.env.REACT_APP_API_URL || 'http://localhost:3001') + '/api/prediction-markets';

const TABS = [
  { id: 'overview',     label: 'Overview' },
  { id: 'watchlist',    label: 'Watchlist' },
  { id: 'calculator',   label: 'Calculator' },
  { id: 'open',         label: 'Open Bets' },
  { id: 'closed',       label: 'Closed Bets' },
  { id: 'risk',         label: 'Risk Limits' },
  { id: 'calibration',  label: 'Calibration' },
  { id: 'performance',  label: 'Performance' },
  { id: 'journal',      label: 'Journal' },
  { id: 'settings',     label: 'Settings' },
];

const ASSET_CLASSES = ['equities', 'rates', 'fx', 'commodities', 'crypto'];
const EVENT_CATEGORIES = ['Equity Index', 'Rates', 'Inflation', 'Jobs', 'GDP', 'FX', 'Energy', 'Metals', 'Crypto', 'Other'];
const PLATFORMS = ['IBKR', 'ForecastEx', 'Kalshi', 'CME', 'Manual'];
const STATUSES = ['watchlist', 'planned', 'open', 'closed', 'settled', 'canceled'];
const SIZING_MODES = [
  { id: 'fractional_kelly', label: 'Frac Kelly' },
  { id: 'conservative_kelly', label: 'Cons Kelly' },
  { id: 'fixed_dollar', label: 'Fixed $' },
  { id: 'fixed_pct', label: 'Fixed %' },
  { id: 'manual', label: 'Manual' },
];
const MISTAKE_TAGS = [
  'paid_too_much', 'bad_probability', 'contract_mismatch', 'settlement_misunderstanding',
  'spread_too_wide', 'size_too_large', 'ignored_correlation', 'late_entry',
  'exited_early', 'poor_data_input', 'emotional_override',
];
const MISTAKE_LABELS = {
  paid_too_much: 'Paid Too Much', bad_probability: 'Bad Probability', contract_mismatch: 'Contract Mismatch',
  settlement_misunderstanding: 'Settlement Misunderstanding', spread_too_wide: 'Spread Too Wide',
  size_too_large: 'Size Too Large', ignored_correlation: 'Ignored Correlation', late_entry: 'Late Entry',
  exited_early: 'Exited Early', poor_data_input: 'Poor Data Input', emotional_override: 'Emotional Override',
};

const DEFAULT_SETTINGS = {
  portfolioEquity: 100000, minNetEdge: 0.02, defaultFeePerContract: 0.02, defaultSlippageBuffer: 0.005,
  modelErrorBuffer: 0.01, maxRiskPerBet: 500, maxRiskPerDay: 2000, maxPmRiskPct: 0.05,
  maxRiskByAssetClass: { equities: 5000, rates: 3000, fx: 3000, commodities: 2000, crypto: 2000 },
  kellyMultiplier: 0.25, defaultConfidenceHaircut: 0.8, stalePriceThresholdHours: 4,
  minSettlementDays: 0, maxSettlementDays: 90, maxOpenRisk: 10000, maxCorrelatedExposure: 3000,
  sizingMode: 'fractional_kelly', minConfidence: 0.5, fixedDollar: 500, fixedPct: 0.01,
};

const BLANK_CONTRACT = {
  platform: 'IBKR', eventName: '', eventCategory: 'Equity Index', assetClass: 'equities',
  underlying: '', contractQuestion: '', yesPrice: '', noPrice: '', bid: '', ask: '', midpoint: '',
  lastPrice: '', myProbability: '', confidenceScore: '', modelDirection: 'up',
  modelLowerBound: '', modelUpperBound: '', modelExpectedLevel: '', settlementDate: '',
  settlementTime: '', expirationDate: '', eventResolutionSource: '', contractSide: 'Yes',
  numContracts: '', entryPrice: '', thesis: '', notes: '', tags: '', correlationGroup: '',
  sizingMethod: 'fractional_kelly', manualOverride: false, manualOverrideReason: '',
  status: 'watchlist',
  journal: {
    modelSignal: '', contractSelected: '', whyThisContract: '', whySide: '', marketPrice: '',
    myProbability: '', perceivedEdge: '', riskSize: '', invalidationThesis: '',
    result: '', postTradeReview: '', mistakeTags: [],
  },
};

// ─── helpers ────────────────────────────────────────────────────────────────

function fmt$(n) { if (n == null || isNaN(n)) return '–'; return `$${Number(n).toFixed(2)}`; }
function fmtPct(n) { if (n == null || isNaN(n)) return '–'; return `${(n * 100).toFixed(1)}%`; }
function fmtEdge(n) { if (n == null || isNaN(n)) return '–'; const v = (n * 100).toFixed(2); return n > 0 ? `+${v}%` : `${v}%`; }
function edgeClass(n) { if (n == null) return ''; return n > 0 ? 'edge-positive' : n < 0 ? 'edge-negative' : 'edge-neutral'; }
function daysTo(d) { if (!d) return null; return Math.ceil((new Date(d) - new Date()) / 86400000); }

// ─── KPI Card ────────────────────────────────────────────────────────────────

function KPI({ label, value, sub, valueClass }) {
  return (
    <div className="pm-kpi">
      <div className="pm-kpi-label">{label}</div>
      <div className={`pm-kpi-value ${valueClass || ''}`}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ─── Status Badge ────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = { watchlist: 'watch', planned: 'planned', open: 'open', closed: 'closed', settled: 'settled', canceled: 'canceled' };
  return <span className={`pm-badge ${map[status] || 'watch'}`}>{status}</span>;
}

// ─── Empty State ─────────────────────────────────────────────────────────────

function Empty({ icon, text, sub, onAction, actionLabel }) {
  return (
    <div className="pm-empty">
      <div className="pm-empty-icon">{icon || '📋'}</div>
      <div className="pm-empty-text">{text}</div>
      {sub && <div className="pm-empty-sub">{sub}</div>}
      {onAction && (
        <button className="pm-btn pm-btn-primary" style={{ marginTop: 12 }} onClick={onAction}>
          {actionLabel || 'Add'}
        </button>
      )}
    </div>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab({ contracts, analytics, settings, isDark, onTabChange }) {
  const open = contracts.filter(c => c.status === 'open');
  const closed = contracts.filter(c => c.status === 'settled' || c.status === 'closed');
  const riskSummary = useMemo(() => openRiskSummary(open), [open]);

  const topOpps = useMemo(() => {
    return contracts
      .filter(c => c.status === 'watchlist' || c.status === 'planned')
      .map(c => {
        const p = parseFloat(c.adjustedProbability ?? c.myProbability) || 0;
        const yp = parseFloat(c.yesPrice) || 0;
        const np = parseFloat(c.noPrice) || 0;
        const fees = settings.defaultFeePerContract + settings.defaultSlippageBuffer + settings.modelErrorBuffer;
        const neY = calcNetEdge(grossEdgeYes(p, yp), fees, 0, 0);
        const neN = calcNetEdge(grossEdgeNo(p, np), fees, 0, 0);
        const bestNE = Math.max(neY, neN);
        const bestSide = neY >= neN ? 'Yes' : 'No';
        const cp = bestSide === 'Yes' ? yp : np;
        const ev = bestSide === 'Yes' ? evYesPerContract(p, yp) : evNoPerContract(p, np);
        return { ...c, bestNE, bestSide, ev, contractPrice: cp };
      })
      .filter(c => c.bestNE > 0)
      .sort((a, b) => b.bestNE - a.bestNE)
      .slice(0, 8);
  }, [contracts, settings]);

  const totalEV = useMemo(() => topOpps.reduce((s, c) => s + (c.ev || 0), 0), [topOpps]);

  return (
    <div>
      <div className="pm-kpi-grid">
        <KPI label="Total Open Risk" value={fmt$(riskSummary.totalMaxLoss)} valueClass={riskSummary.totalMaxLoss > settings.maxOpenRisk * 0.8 ? 'negative' : ''} />
        <KPI label="Open Contracts" value={open.length} />
        <KPI label="Total P&L" value={fmt$(analytics?.totalPnl)} valueClass={(analytics?.totalPnl || 0) >= 0 ? 'positive' : 'negative'} />
        <KPI label="Win Rate" value={analytics?.winRate != null ? fmtPct(analytics.winRate) : '–'} sub={`${closed.length} settled`} />
        <KPI label="Brier Score" value={analytics?.brierScore != null ? analytics.brierScore.toFixed(3) : '–'} sub="lower is better" />
        <KPI label="EV of Open Book" value={fmt$(riskSummary.totalMaxProfit - riskSummary.totalMaxLoss)} />
        <KPI label="Max Possible Loss" value={fmt$(riskSummary.totalMaxLoss)} />
        <KPI label="Max Possible Profit" value={fmt$(riskSummary.totalMaxProfit)} />
      </div>

      {Object.keys(riskSummary.byAssetClass).length > 0 && (
        <div className="pm-card">
          <div className="pm-card-title">Risk by Asset Class</div>
          {Object.entries(riskSummary.byAssetClass).map(([ac, risk]) => {
            const cap = settings.maxRiskByAssetClass?.[ac] || settings.maxOpenRisk;
            const pct = Math.min(1, risk / cap);
            return (
              <div key={ac} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                  <span style={{ textTransform: 'capitalize', fontWeight: 600 }}>{ac}</span>
                  <span>{fmt$(risk)} / {fmt$(cap)}</span>
                </div>
                <div className="pm-progress-bar-wrap">
                  <div className={`pm-progress-bar ${pct > 0.8 ? 'danger' : pct > 0.5 ? 'caution' : 'safe'}`} style={{ width: `${pct * 100}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="pm-card">
        <div className="pm-card-title">Top Opportunities by Net Edge</div>
        {topOpps.length === 0 ? (
          <Empty icon="🔍" text="No positive-edge opportunities" sub="Add contracts to the watchlist to see rankings." onAction={() => onTabChange('calculator')} actionLabel="Add Contract" />
        ) : (
          <div className="pm-table-wrap">
            <table className="pm-table">
              <thead>
                <tr>
                  <th>Event</th><th>Cat</th><th>Class</th><th>Settle</th>
                  <th>Yes $</th><th>No $</th><th>My Prob</th><th>Side</th>
                  <th>Net Edge</th><th>EV/Contract</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {topOpps.map(c => (
                  <tr key={c.contractId}>
                    <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.eventName}>{c.eventName}</td>
                    <td>{c.eventCategory}</td>
                    <td style={{ textTransform: 'capitalize' }}>{c.assetClass}</td>
                    <td>{c.settlementDate || '–'}</td>
                    <td>{c.yesPrice ? fmtPct(parseFloat(c.yesPrice)) : '–'}</td>
                    <td>{c.noPrice ? fmtPct(parseFloat(c.noPrice)) : '–'}</td>
                    <td>{c.myProbability ? fmtPct(parseFloat(c.myProbability)) : '–'}</td>
                    <td><span className={`pm-badge ${c.bestSide === 'Yes' ? 'yes' : 'no'}`}>{c.bestSide}</span></td>
                    <td><span className={edgeClass(c.bestNE)}>{fmtEdge(c.bestNE)}</span></td>
                    <td><span className={edgeClass(c.ev)}>{fmtEdge(c.ev)}</span></td>
                    <td><StatusBadge status={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Watchlist Tab ───────────────────────────────────────────────────────────

function WatchlistTab({ contracts, settings, isDark, onEdit, onDelete }) {
  const [filterStatus, setFilterStatus] = useState('all');
  const [sortKey, setSortKey] = useState('bestNE');
  const [sortDir, setSortDir] = useState(-1);

  const enriched = useMemo(() => {
    return contracts.map(c => {
      const p = parseFloat(c.adjustedProbability ?? c.myProbability) || 0;
      const yp = parseFloat(c.yesPrice) || 0;
      const np = parseFloat(c.noPrice) || 0;
      const fees = (settings.defaultFeePerContract || 0) + (settings.defaultSlippageBuffer || 0) + (settings.modelErrorBuffer || 0);
      const geY = grossEdgeYes(p, yp);
      const geN = grossEdgeNo(p, np);
      const neY = calcNetEdge(geY, fees, 0, 0);
      const neN = calcNetEdge(geN, fees, 0, 0);
      const bestNE = Math.max(neY, neN);
      const bestSide = neY >= neN ? 'Yes' : 'No';
      const cp = bestSide === 'Yes' ? yp : np;
      const n = parseInt(c.numContracts) || calcSizing(c.sizingMethod || 'fractional_kelly', {
        userProb: p, contractPrice: cp, portfolioEquity: settings.portfolioEquity,
        kellyMultiplier: settings.kellyMultiplier, maxBetCapDollars: settings.maxRiskPerBet,
        fixedDollar: settings.fixedDollar, fixedPct: settings.fixedPct,
      });
      const evPerContract = bestSide === 'Yes' ? evYesPerContract(p, yp) : evNoPerContract(p, np);
      const kf = kellyFraction(p, cp);
      const ml = cp * n;
      const mp = (1 - cp) * n;
      const rec = bestNE > (settings.minNetEdge || 0.02) ? 'Trade' : 'No Trade';
      return { ...c, p, geY, geN, neY, neN, bestNE, bestSide, cp, n, evPerContract, evDollars: evPerContract * n, kf, ml, mp, rec };
    });
  }, [contracts, settings]);

  const filtered = useMemo(() => {
    let rows = filterStatus === 'all' ? enriched : enriched.filter(c => c.status === filterStatus);
    rows = [...rows].sort((a, b) => {
      const aVal = a[sortKey] ?? -Infinity;
      const bVal = b[sortKey] ?? -Infinity;
      return sortDir * (bVal - aVal);
    });
    return rows;
  }, [enriched, filterStatus, sortKey, sortDir]);

  const handleSort = (key) => {
    if (key === sortKey) setSortDir(d => d * -1);
    else { setSortKey(key); setSortDir(-1); }
  };

  const SortTh = ({ k, label }) => (
    <th onClick={() => handleSort(k)} style={{ cursor: 'pointer' }}>
      {label} {sortKey === k ? (sortDir === -1 ? '↓' : '↑') : ''}
    </th>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#888' }}>Filter:</span>
        {['all', ...STATUSES].map(s => (
          <button key={s} className={`pm-sizing-mode-btn ${filterStatus === s ? 'active' : ''}`} onClick={() => setFilterStatus(s)}
            style={{ textTransform: 'capitalize' }}>
            {s === 'all' ? 'All' : s}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#888' }}>{filtered.length} contracts</span>
      </div>

      {filtered.length === 0 ? (
        <Empty icon="📋" text="No contracts" sub="Contracts you add will appear here." />
      ) : (
        <div className="pm-table-wrap">
          <table className="pm-table">
            <thead>
              <tr>
                <th>Event</th><th>Cat</th><SortTh k="assetClass" label="Class" /><SortTh k="settlementDate" label="Settle" />
                <th>Yes $</th><th>No $</th><th>My Prob</th><th>Mkt Prob</th>
                <SortTh k="bestNE" label="Net Edge" /><th>Side</th><SortTh k="n" label="Contracts" />
                <SortTh k="ml" label="Max Loss" /><SortTh k="evDollars" label="EV $" />
                <SortTh k="kf" label="Kelly %" /><th>Confidence</th><th>Rec</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.contractId} onClick={() => onEdit(c)}>
                  <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.contractQuestion || c.eventName}>{c.eventName}</td>
                  <td>{c.eventCategory}</td>
                  <td style={{ textTransform: 'capitalize' }}>{c.assetClass}</td>
                  <td>{c.settlementDate || '–'}</td>
                  <td>{c.yesPrice ? fmtPct(parseFloat(c.yesPrice)) : '–'}</td>
                  <td>{c.noPrice ? fmtPct(parseFloat(c.noPrice)) : '–'}</td>
                  <td>{c.myProbability ? fmtPct(parseFloat(c.myProbability)) : '–'}</td>
                  <td>{c.marketImpliedProbability ? fmtPct(parseFloat(c.marketImpliedProbability)) : (c.yesPrice ? fmtPct(parseFloat(c.yesPrice)) : '–')}</td>
                  <td><span className={edgeClass(c.bestNE)}>{fmtEdge(c.bestNE)}</span></td>
                  <td><span className={`pm-badge ${c.bestSide === 'Yes' ? 'yes' : 'no'}`}>{c.bestSide}</span></td>
                  <td>{c.n || '–'}</td>
                  <td>{fmt$(c.ml)}</td>
                  <td><span className={edgeClass(c.evDollars)}>{fmt$(c.evDollars)}</span></td>
                  <td>{c.kf > 0 ? fmtPct(c.kf) : '–'}</td>
                  <td>{c.confidenceScore ? fmtPct(parseFloat(c.confidenceScore)) : '–'}</td>
                  <td><span className={`pm-badge ${c.rec === 'Trade' ? 'trade' : 'no-trade'}`}>{c.rec}</span></td>
                  <td><StatusBadge status={c.status} /></td>
                  <td onClick={e => { e.stopPropagation(); if (window.confirm('Delete this contract?')) onDelete(c.contractId); }}>
                    <button className="pm-btn pm-btn-danger" style={{ padding: '2px 7px', fontSize: 10 }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Calculator Tab ───────────────────────────────────────────────────────────

function CalculatorTab({ settings, onSave, editingContract, isDark }) {
  const [form, setForm] = useState(() => editingContract ? { ...BLANK_CONTRACT, ...editingContract } : { ...BLANK_CONTRACT });
  const [sizingMode, setSizingMode] = useState(settings.sizingMode || 'fractional_kelly');
  const [showBandHelper, setShowBandHelper] = useState(false);
  const [band, setBand] = useState({ currentLevel: '', lowerBound: '', upperBound: '', expectedLevel: '', confidence: '', threshold: '', eventType: 'above_threshold', distribution: 'normal' });
  const [bandResult, setBandResult] = useState(null);
  const [saveStatus, setSaveStatus] = useState('');
  const [formErrors, setFormErrors] = useState([]);

  useEffect(() => {
    if (editingContract) setForm({ ...BLANK_CONTRACT, ...editingContract });
  }, [editingContract]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const calc = useMemo(() => {
    const p = parseFloat(form.myProbability);
    const ci = parseFloat(form.confidenceScore);
    const yp = parseFloat(form.yesPrice);
    const np = parseFloat(form.noPrice);
    const fees = settings.defaultFeePerContract;
    const slippage = settings.defaultSlippageBuffer;
    const modelErr = settings.modelErrorBuffer;
    if (isNaN(p) || isNaN(yp) || isNaN(np)) return null;

    const adjP = (!isNaN(ci)) ? adjustProbability(p, ci) : p;
    const geY = grossEdgeYes(adjP, yp);
    const geN = grossEdgeNo(adjP, np);
    const neY = calcNetEdge(geY, fees, slippage, modelErr);
    const neN = calcNetEdge(geN, fees, slippage, modelErr);
    const evY = evYesPerContract(adjP, yp);
    const evN = evNoPerContract(adjP, np);
    const kfY = kellyFraction(adjP, yp);
    const kfN = kellyFraction(adjP, np);

    const cp = form.contractSide === 'Yes' ? yp : np;
    const evPerContract = form.contractSide === 'Yes' ? evY : evN;
    const suggestedN = calcSizing(sizingMode, {
      userProb: adjP, contractPrice: cp, portfolioEquity: settings.portfolioEquity,
      kellyMultiplier: settings.kellyMultiplier, maxBetCapDollars: settings.maxRiskPerBet,
      fixedDollar: settings.fixedDollar, fixedPct: settings.fixedPct,
      manualContracts: parseInt(form.numContracts) || 0,
    });
    const n = parseInt(form.numContracts) || suggestedN;
    const ml = cp * n;
    const mp = (1 - cp) * n;
    const evTotal = evPerContract * n - fees * n;

    const rec = getRecommendation(
      { ...form, yesPrice: yp, noPrice: np, myProbability: p, adjustedProbability: adjP, confidenceScore: ci },
      { ...settings, sizingMode, currentOpenRisk: 0 }
    );

    return { adjP, geY, geN, neY, neN, evY, evN, kfY, kfN, suggestedN, n, ml, mp, evTotal, rec };
  }, [form, sizingMode, settings]);

  const handleBandCalc = () => {
    const result = bandToProb({
      currentLevel: parseFloat(band.currentLevel),
      lowerBound: parseFloat(band.lowerBound),
      upperBound: parseFloat(band.upperBound),
      expectedLevel: parseFloat(band.expectedLevel) || undefined,
      confidence: parseFloat(band.confidence) || undefined,
      threshold: parseFloat(band.threshold),
      eventType: band.eventType,
      distribution: band.distribution,
    });
    setBandResult(result);
    if (result.probability != null) set('myProbability', result.probability.toFixed(4));
  };

  const handleSave = async (status) => {
    const validation = validateContract(form);
    if (validation.errors.length > 0) { setFormErrors(validation.errors); return; }
    setFormErrors([]);
    const p = parseFloat(form.myProbability);
    const ci = parseFloat(form.confidenceScore);
    const adjP = (!isNaN(ci)) ? adjustProbability(p, ci) : p;
    const cp = form.contractSide === 'Yes' ? parseFloat(form.yesPrice) : parseFloat(form.noPrice);
    const sugN = calc?.suggestedN || 0;
    const payload = {
      ...form,
      status: status || form.status,
      adjustedProbability: adjP,
      numContracts: parseInt(form.numContracts) || sugN,
      entryPrice: status === 'open' ? (parseFloat(form.entryPrice) || cp) : form.entryPrice,
      sizingMethod: sizingMode,
      totalFees: (settings.defaultFeePerContract) * (parseInt(form.numContracts) || sugN),
    };
    await onSave(payload);
    setSaveStatus('Saved!');
    setTimeout(() => setSaveStatus(''), 2000);
    setForm({ ...BLANK_CONTRACT });
  };

  return (
    <div>
      {formErrors.length > 0 && (
        <div style={{ background: '#fff1f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}>
          {formErrors.map((e, i) => <div key={i} style={{ fontSize: 12, color: '#b91c1c' }}>• {e}</div>)}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 14 }}>
        {/* Left: form */}
        <div>
          <div className="pm-card">
            <div className="pm-card-title">Contract Details</div>
            <div className="pm-form-grid">
              <div className="pm-form-group">
                <label className="pm-label">Platform</label>
                <select className="pm-select" value={form.platform} onChange={e => set('platform', e.target.value)}>
                  {PLATFORMS.map(p => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Asset Class</label>
                <select className="pm-select" value={form.assetClass} onChange={e => set('assetClass', e.target.value)}>
                  {ASSET_CLASSES.map(a => <option key={a} value={a} style={{ textTransform: 'capitalize' }}>{a}</option>)}
                </select>
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Event Category</label>
                <select className="pm-select" value={form.eventCategory} onChange={e => set('eventCategory', e.target.value)}>
                  {EVENT_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Underlying</label>
                <input className="pm-input" placeholder="SPX, BTC, FOMC…" value={form.underlying} onChange={e => set('underlying', e.target.value)} />
              </div>
              <div className="pm-form-group span-2">
                <label className="pm-label">Event Name</label>
                <input className="pm-input" placeholder="e.g. SPX closes above 5500 on Jun 20" value={form.eventName} onChange={e => set('eventName', e.target.value)} />
              </div>
              <div className="pm-form-group span-2">
                <label className="pm-label">Contract Question</label>
                <input className="pm-input" placeholder="Will SPX close above 5500 on June 20, 2026?" value={form.contractQuestion} onChange={e => set('contractQuestion', e.target.value)} />
              </div>
            </div>
          </div>

          <div className="pm-card">
            <div className="pm-card-title">Prices & Probability</div>
            <div className="pm-form-grid three-col">
              <div className="pm-form-group">
                <label className="pm-label">Yes Price ($0–$1)</label>
                <input className="pm-input" type="number" step="0.01" min="0" max="1" placeholder="0.45" value={form.yesPrice} onChange={e => set('yesPrice', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">No Price ($0–$1)</label>
                <input className="pm-input" type="number" step="0.01" min="0" max="1" placeholder="0.55" value={form.noPrice} onChange={e => set('noPrice', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Bid / Ask</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input className="pm-input" type="number" step="0.01" placeholder="Bid" value={form.bid} onChange={e => set('bid', e.target.value)} style={{ width: '50%' }} />
                  <input className="pm-input" type="number" step="0.01" placeholder="Ask" value={form.ask} onChange={e => set('ask', e.target.value)} style={{ width: '50%' }} />
                </div>
              </div>
              <div className="pm-form-group">
                <label className="pm-label">My Probability</label>
                <input className="pm-input" type="number" step="0.01" min="0" max="1" placeholder="0.65" value={form.myProbability} onChange={e => set('myProbability', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Confidence (0–1)</label>
                <input className="pm-input" type="number" step="0.05" min="0" max="1" placeholder="0.80" value={form.confidenceScore} onChange={e => set('confidenceScore', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Model Direction</label>
                <select className="pm-select" value={form.modelDirection} onChange={e => set('modelDirection', e.target.value)}>
                  <option value="up">Up</option><option value="down">Down</option><option value="neutral">Neutral</option>
                </select>
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Model Lower Bound</label>
                <input className="pm-input" type="number" placeholder="5300" value={form.modelLowerBound} onChange={e => set('modelLowerBound', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Model Upper Bound</label>
                <input className="pm-input" type="number" placeholder="5700" value={form.modelUpperBound} onChange={e => set('modelUpperBound', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Model Expected Level</label>
                <input className="pm-input" type="number" placeholder="5500" value={form.modelExpectedLevel} onChange={e => set('modelExpectedLevel', e.target.value)} />
              </div>
            </div>
          </div>

          <div className="pm-card">
            <div className="pm-card-title">Settlement & Trade</div>
            <div className="pm-form-grid three-col">
              <div className="pm-form-group">
                <label className="pm-label">Settlement Date</label>
                <input className="pm-input" type="date" value={form.settlementDate} onChange={e => set('settlementDate', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Expiration Date</label>
                <input className="pm-input" type="date" value={form.expirationDate} onChange={e => set('expirationDate', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Resolution Source</label>
                <input className="pm-input" placeholder="CME official, BLS, Fed…" value={form.eventResolutionSource} onChange={e => set('eventResolutionSource', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Contract Side</label>
                <select className="pm-select" value={form.contractSide} onChange={e => set('contractSide', e.target.value)}>
                  <option>Yes</option><option>No</option>
                </select>
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Num Contracts (override)</label>
                <input className="pm-input" type="number" min="0" placeholder={`Suggested: ${calc?.suggestedN || '–'}`} value={form.numContracts} onChange={e => set('numContracts', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Entry Price (if open)</label>
                <input className="pm-input" type="number" step="0.01" value={form.entryPrice} onChange={e => set('entryPrice', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Correlation Group</label>
                <input className="pm-input" placeholder="Fed tightening, China risk…" value={form.correlationGroup} onChange={e => set('correlationGroup', e.target.value)} />
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Status</label>
                <select className="pm-select" value={form.status} onChange={e => set('status', e.target.value)}>
                  {STATUSES.map(s => <option key={s} value={s} style={{ textTransform: 'capitalize' }}>{s}</option>)}
                </select>
              </div>
              <div className="pm-form-group">
                <label className="pm-label">Tags (comma-sep)</label>
                <input className="pm-input" placeholder="spx, june, rates…" value={form.tags} onChange={e => set('tags', e.target.value)} />
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <div className="pm-form-group">
                <label className="pm-label">Thesis</label>
                <textarea className="pm-textarea" rows={2} placeholder="Why does this contract match your model signal?" value={form.thesis} onChange={e => set('thesis', e.target.value)} />
              </div>
            </div>
          </div>

          {/* Sizing mode */}
          <div className="pm-card">
            <div className="pm-card-title">Sizing Mode</div>
            <div className="pm-sizing-modes">
              {SIZING_MODES.map(m => (
                <button key={m.id} className={`pm-sizing-mode-btn ${sizingMode === m.id ? 'active' : ''}`} onClick={() => setSizingMode(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Band-to-Prob helper */}
          <div className="pm-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showBandHelper ? 10 : 0 }}>
              <div className="pm-card-title" style={{ marginBottom: 0 }}>Band → Probability Helper</div>
              <button className="pm-btn pm-btn-secondary" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => setShowBandHelper(v => !v)}>
                {showBandHelper ? 'Hide' : 'Show'}
              </button>
            </div>
            {showBandHelper && (
              <div>
                <div className="pm-form-grid three-col" style={{ marginTop: 8 }}>
                  <div className="pm-form-group">
                    <label className="pm-label">Current Level</label>
                    <input className="pm-input" type="number" value={band.currentLevel} onChange={e => setBand(b => ({ ...b, currentLevel: e.target.value }))} />
                  </div>
                  <div className="pm-form-group">
                    <label className="pm-label">Model Lower</label>
                    <input className="pm-input" type="number" value={band.lowerBound} onChange={e => setBand(b => ({ ...b, lowerBound: e.target.value }))} />
                  </div>
                  <div className="pm-form-group">
                    <label className="pm-label">Model Upper</label>
                    <input className="pm-input" type="number" value={band.upperBound} onChange={e => setBand(b => ({ ...b, upperBound: e.target.value }))} />
                  </div>
                  <div className="pm-form-group">
                    <label className="pm-label">Expected Level</label>
                    <input className="pm-input" type="number" value={band.expectedLevel} onChange={e => setBand(b => ({ ...b, expectedLevel: e.target.value }))} />
                  </div>
                  <div className="pm-form-group">
                    <label className="pm-label">Threshold</label>
                    <input className="pm-input" type="number" value={band.threshold} onChange={e => setBand(b => ({ ...b, threshold: e.target.value }))} />
                  </div>
                  <div className="pm-form-group">
                    <label className="pm-label">Confidence (0–1)</label>
                    <input className="pm-input" type="number" step="0.05" value={band.confidence} onChange={e => setBand(b => ({ ...b, confidence: e.target.value }))} />
                  </div>
                  <div className="pm-form-group">
                    <label className="pm-label">Event Type</label>
                    <select className="pm-select" value={band.eventType} onChange={e => setBand(b => ({ ...b, eventType: e.target.value }))}>
                      <option value="above_threshold">Above Threshold</option>
                      <option value="below_threshold">Below Threshold</option>
                      <option value="inside_range">Inside Range</option>
                      <option value="outside_range">Outside Range</option>
                    </select>
                  </div>
                  <div className="pm-form-group">
                    <label className="pm-label">Distribution</label>
                    <select className="pm-select" value={band.distribution} onChange={e => setBand(b => ({ ...b, distribution: e.target.value }))}>
                      <option value="normal">Normal</option>
                      <option value="triangular">Triangular</option>
                      <option value="uniform">Uniform</option>
                    </select>
                  </div>
                  <div className="pm-form-group" style={{ alignSelf: 'flex-end' }}>
                    <button className="pm-btn pm-btn-primary" onClick={handleBandCalc}>Calculate</button>
                  </div>
                </div>
                {bandResult && (
                  <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: '#f0fdf4', border: '1px solid #86efac' }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#15803d' }}>
                      Estimated Probability: {fmtPct(bandResult.probability)}
                    </div>
                    <div style={{ fontSize: 11, color: '#555', marginTop: 3 }}>{bandResult.explanation}</div>
                    {bandResult.warnings?.map((w, i) => <div key={i} style={{ fontSize: 11, color: '#92400e', marginTop: 2 }}>⚠ {w}</div>)}
                    <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>↑ Probability copied to "My Probability" field above.</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: live calcs */}
        <div>
          <div className="pm-card" style={{ position: 'sticky', top: 0 }}>
            <div className="pm-card-title">Live Calculations</div>
            {calc ? (
              <>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>Adjusted Probability (haircut)</div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{fmtPct(calc.adjP)}</div>
                </div>
                <hr className="pm-divider" />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 10, color: '#888', fontWeight: 600, textTransform: 'uppercase' }}>Yes Side</div>
                    <div style={{ fontSize: 11, marginTop: 2 }}>Gross Edge: <span className={edgeClass(calc.geY)}>{fmtEdge(calc.geY)}</span></div>
                    <div style={{ fontSize: 11 }}>Net Edge: <span className={edgeClass(calc.neY)}>{fmtEdge(calc.neY)}</span></div>
                    <div style={{ fontSize: 11 }}>EV/Contract: <span className={edgeClass(calc.evY)}>{fmtEdge(calc.evY)}</span></div>
                    <div style={{ fontSize: 11 }}>Kelly %: {fmtPct(calc.kfY)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#888', fontWeight: 600, textTransform: 'uppercase' }}>No Side</div>
                    <div style={{ fontSize: 11, marginTop: 2 }}>Gross Edge: <span className={edgeClass(calc.geN)}>{fmtEdge(calc.geN)}</span></div>
                    <div style={{ fontSize: 11 }}>Net Edge: <span className={edgeClass(calc.neN)}>{fmtEdge(calc.neN)}</span></div>
                    <div style={{ fontSize: 11 }}>EV/Contract: <span className={edgeClass(calc.evN)}>{fmtEdge(calc.evN)}</span></div>
                    <div style={{ fontSize: 11 }}>Kelly %: {fmtPct(calc.kfN)}</div>
                  </div>
                </div>
                <hr className="pm-divider" />
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10, color: '#888', fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>
                    {form.contractSide} Side Position
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 12 }}>
                    <div>Suggested Contracts:</div><div style={{ fontWeight: 700 }}>{calc.suggestedN}</div>
                    <div>Using Contracts:</div><div style={{ fontWeight: 700 }}>{calc.n}</div>
                    <div>Max Loss:</div><div style={{ fontWeight: 700, color: '#dc2626' }}>{fmt$(calc.ml)}</div>
                    <div>Max Profit:</div><div style={{ fontWeight: 700, color: '#16a34a' }}>{fmt$(calc.mp)}</div>
                    <div>Net EV Total:</div><div style={{ fontWeight: 700 }} className={edgeClass(calc.evTotal)}>{fmt$(calc.evTotal)}</div>
                  </div>
                </div>
                <hr className="pm-divider" />
                <div style={{ fontSize: 10, color: '#888', marginBottom: 6 }}>
                  EV Yes: p*(1-yesPrice) − (1−p)*yesPrice<br />
                  = {parseFloat(form.myProbability).toFixed(3)}*(1−{parseFloat(form.yesPrice).toFixed(3)}) − {(1-parseFloat(form.myProbability)).toFixed(3)}*{parseFloat(form.yesPrice).toFixed(3)}<br />
                  = {calc.evY.toFixed(4)} per contract
                </div>
                {/* Recommendation */}
                <div className={`pm-rec-box ${calc.rec.action === 'Trade' ? 'trade' : 'no-trade'}`}>
                  <div className={`pm-rec-title ${calc.rec.action === 'Trade' ? 'trade' : 'no-trade'}`}>
                    {calc.rec.action === 'Trade' ? '✓ TRADE' : '✗ NO TRADE'}
                    {calc.rec.side && ` — ${calc.rec.side} side`}
                  </div>
                  <div style={{ fontSize: 12 }}>{calc.rec.reason}</div>
                  {calc.rec.warnings?.length > 0 && (
                    <ul className="pm-warnings">{calc.rec.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  )}
                  {calc.rec.action === 'Trade' && (
                    <div style={{ marginTop: 6, fontSize: 11, fontWeight: 600 }}>
                      Size: {calc.rec.suggestedContracts} contracts · Max Loss: {fmt$(calc.rec.maxLoss)} · EV: {fmt$(calc.rec.ev)}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ color: '#aaa', fontSize: 12, textAlign: 'center', padding: '20px 0' }}>
                Enter Yes price, No price, and My Probability to see calculations.
              </div>
            )}
          </div>

          {/* Save buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
            <button className="pm-btn pm-btn-secondary" onClick={() => handleSave('watchlist')}>Save to Watchlist</button>
            <button className="pm-btn pm-btn-secondary" onClick={() => handleSave('planned')}>Save as Planned</button>
            <button className="pm-btn pm-btn-primary" onClick={() => handleSave('open')}>Save as Open Bet</button>
            {saveStatus && <div style={{ fontSize: 12, color: '#16a34a', textAlign: 'center' }}>{saveStatus}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Open Bets Tab ────────────────────────────────────────────────────────────

function OpenBetsTab({ contracts, settings, isDark, onUpdate }) {
  const open = contracts.filter(c => c.status === 'open');

  const handleSettle = async (c) => {
    const sv = parseFloat(window.prompt(`Settlement value for "${c.eventName}" (0 = No resolves, 1 = Yes resolves):`, ''));
    if (isNaN(sv)) return;
    const entryP = parseFloat(c.entryPrice ?? (c.contractSide === 'Yes' ? c.yesPrice : c.noPrice)) || 0;
    const n = c.numContracts || 0;
    const realizedProfit = (sv - entryP) * n * (c.contractSide === 'Yes' ? 1 : -1) - (c.totalFees || 0);
    const outcome = sv >= 0.99 ? 1 : 0;
    await onUpdate(c.contractId, { status: 'settled', settlementValue: sv, exitPrice: sv, realizedProfit, outcome });
  };

  const handleClose = async (c) => {
    const exitP = parseFloat(window.prompt(`Exit price for "${c.eventName}" ($0–$1):`, ''));
    if (isNaN(exitP)) return;
    const entryP = parseFloat(c.entryPrice ?? (c.contractSide === 'Yes' ? c.yesPrice : c.noPrice)) || 0;
    const n = c.numContracts || 0;
    const realizedProfit = (exitP - entryP) * n - (c.totalFees || 0);
    await onUpdate(c.contractId, { status: 'closed', exitPrice: exitP, realizedProfit });
  };

  if (open.length === 0) return <Empty icon="📂" text="No open bets" sub="Save a contract as 'Open' from the Calculator tab." />;

  return (
    <div className="pm-table-wrap">
      <table className="pm-table">
        <thead>
          <tr>
            <th>Event</th><th>Cat</th><th>Class</th><th>Side</th><th>Entry $</th>
            <th>Contracts</th><th>Cost Basis</th><th>Max Loss</th><th>Max Profit</th>
            <th>My Prob</th><th>EV Total</th><th>Settlement</th><th>Days</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {open.map(c => {
            const ep = parseFloat(c.entryPrice ?? (c.contractSide === 'Yes' ? c.yesPrice : c.noPrice)) || 0;
            const n = c.numContracts || 0;
            const p = parseFloat(c.adjustedProbability ?? c.myProbability) || 0;
            const evPC = c.contractSide === 'Yes' ? evYesPerContract(p, ep) : evNoPerContract(p, ep);
            const ml = ep * n;
            const mp = (1 - ep) * n;
            const days = daysTo(c.settlementDate);
            return (
              <tr key={c.contractId}>
                <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.eventName}>{c.eventName}</td>
                <td>{c.eventCategory}</td>
                <td style={{ textTransform: 'capitalize' }}>{c.assetClass}</td>
                <td><span className={`pm-badge ${c.contractSide === 'Yes' ? 'yes' : 'no'}`}>{c.contractSide}</span></td>
                <td>{fmtPct(ep)}</td>
                <td>{n}</td>
                <td>{fmt$(ml)}</td>
                <td style={{ color: '#dc2626' }}>{fmt$(ml)}</td>
                <td style={{ color: '#16a34a' }}>{fmt$(mp)}</td>
                <td>{fmtPct(p)}</td>
                <td><span className={edgeClass(evPC * n)}>{fmt$(evPC * n)}</span></td>
                <td>{c.settlementDate || '–'}</td>
                <td>{days != null ? (days < 0 ? <span style={{ color: '#dc2626' }}>Expired</span> : `${days}d`) : '–'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="pm-btn pm-btn-primary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => handleSettle(c)}>Settle</button>
                    <button className="pm-btn pm-btn-secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => handleClose(c)}>Close</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Closed Bets Tab ──────────────────────────────────────────────────────────

function ClosedBetsTab({ contracts, settings, isDark }) {
  const [filterAC, setFilterAC] = useState('all');
  const closed = contracts.filter(c => c.status === 'settled' || c.status === 'closed' || c.status === 'canceled');
  const filtered = filterAC === 'all' ? closed : closed.filter(c => c.assetClass === filterAC);

  if (closed.length === 0) return <Empty icon="📊" text="No closed bets yet" sub="Settled or closed contracts will appear here." />;

  const totPnl = filtered.reduce((s, c) => s + (c.realizedProfit || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {['all', ...ASSET_CLASSES].map(a => (
          <button key={a} className={`pm-sizing-mode-btn ${filterAC === a ? 'active' : ''}`} onClick={() => setFilterAC(a)}
            style={{ textTransform: 'capitalize' }}>{a}</button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#888' }}>
          {filtered.length} contracts · Total P&L: <strong className={totPnl >= 0 ? 'edge-positive' : 'edge-negative'}>{fmt$(totPnl)}</strong>
        </span>
      </div>
      <div className="pm-table-wrap">
        <table className="pm-table">
          <thead>
            <tr>
              <th>Event</th><th>Cat</th><th>Class</th><th>Side</th><th>Entry $</th>
              <th>Exit $</th><th>Settle $</th><th>Contracts</th><th>Cost</th>
              <th>P&L</th><th>My Prob</th><th>Outcome</th><th>EV at Entry</th><th>EV Residual</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => {
              const ep = parseFloat(c.entryPrice ?? (c.contractSide === 'Yes' ? c.yesPrice : c.noPrice)) || 0;
              const n = c.numContracts || 0;
              const p = parseFloat(c.adjustedProbability ?? c.myProbability) || 0;
              const evPC = c.contractSide === 'Yes' ? evYesPerContract(p, ep) : evNoPerContract(p, ep);
              const evAtEntry = evPC * n - (c.totalFees || 0);
              const realized = c.realizedProfit || 0;
              const residual = realized - evAtEntry;
              const outcome = c.outcome ?? (c.settlementValue >= 0.99 ? 1 : 0);
              return (
                <tr key={c.contractId}>
                  <td style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.eventName}>{c.eventName}</td>
                  <td>{c.eventCategory}</td>
                  <td style={{ textTransform: 'capitalize' }}>{c.assetClass}</td>
                  <td><span className={`pm-badge ${c.contractSide === 'Yes' ? 'yes' : 'no'}`}>{c.contractSide}</span></td>
                  <td>{fmtPct(ep)}</td>
                  <td>{c.exitPrice ? fmtPct(parseFloat(c.exitPrice)) : '–'}</td>
                  <td>{c.settlementValue != null ? fmtPct(parseFloat(c.settlementValue)) : '–'}</td>
                  <td>{n}</td>
                  <td>{fmt$(ep * n)}</td>
                  <td><span className={edgeClass(realized)}>{fmt$(realized)}</span></td>
                  <td>{fmtPct(p)}</td>
                  <td>{c.status === 'settled' ? (outcome === 1 ? '✓ Yes' : '✗ No') : '–'}</td>
                  <td><span className={edgeClass(evAtEntry)}>{fmt$(evAtEntry)}</span></td>
                  <td><span className={edgeClass(residual)}>{fmt$(residual)}</span></td>
                  <td><StatusBadge status={c.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Risk Limits Tab ──────────────────────────────────────────────────────────

function RiskLimitsTab({ contracts, settings, analytics, isDark, onTabChange }) {
  const open = contracts.filter(c => c.status === 'open');
  const riskSummary = useMemo(() => openRiskSummary(open), [open]);
  const totalRiskPct = settings.portfolioEquity > 0 ? riskSummary.totalMaxLoss / settings.portfolioEquity : 0;

  const ProgressRow = ({ label, value, cap, formatFn }) => {
    const pct = cap > 0 ? Math.min(1, value / cap) : 0;
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
          <span style={{ fontWeight: 600 }}>{label}</span>
          <span>{(formatFn || fmt$)(value)} / {(formatFn || fmt$)(cap)}</span>
        </div>
        <div className="pm-progress-bar-wrap">
          <div className={`pm-progress-bar ${pct > 0.8 ? 'danger' : pct > 0.5 ? 'caution' : 'safe'}`} style={{ width: `${pct * 100}%` }} />
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="pm-kpi-grid">
        <KPI label="Total Open Risk" value={fmt$(riskSummary.totalMaxLoss)} valueClass={totalRiskPct > 0.8 ? 'negative' : totalRiskPct > 0.5 ? '' : 'positive'} />
        <KPI label="Risk / Portfolio" value={fmtPct(totalRiskPct)} valueClass={totalRiskPct > settings.maxPmRiskPct ? 'negative' : 'positive'} />
        <KPI label="Max Possible Profit" value={fmt$(riskSummary.totalMaxProfit)} valueClass="positive" />
        <KPI label="Open Contracts" value={open.length} />
        <KPI label="Total P&L (Realized)" value={fmt$(analytics?.totalPnl)} valueClass={(analytics?.totalPnl || 0) >= 0 ? 'positive' : 'negative'} />
        <KPI label="Portfolio Equity" value={fmt$(settings.portfolioEquity)} />
      </div>

      <div className="pm-card">
        <div className="pm-card-title">Aggregate Risk Limits</div>
        <ProgressRow label="Total Open Risk vs Cap" value={riskSummary.totalMaxLoss} cap={settings.maxOpenRisk} />
        <ProgressRow label="PM Risk % of Portfolio" value={totalRiskPct} cap={settings.maxPmRiskPct} formatFn={fmtPct} />
      </div>

      {Object.keys(riskSummary.byAssetClass).length > 0 && (
        <div className="pm-card">
          <div className="pm-card-title">Risk by Asset Class</div>
          {ASSET_CLASSES.map(ac => {
            const v = riskSummary.byAssetClass[ac] || 0;
            const cap = settings.maxRiskByAssetClass?.[ac] || settings.maxOpenRisk;
            return <ProgressRow key={ac} label={ac.charAt(0).toUpperCase() + ac.slice(1)} value={v} cap={cap} />;
          })}
        </div>
      )}

      {Object.keys(riskSummary.byCategory).length > 0 && (
        <div className="pm-card">
          <div className="pm-card-title">Risk by Event Category</div>
          {Object.entries(riskSummary.byCategory).map(([cat, v]) => (
            <ProgressRow key={cat} label={cat} value={v} cap={settings.maxOpenRisk} />
          ))}
        </div>
      )}

      {Object.keys(riskSummary.bySettlementDate).length > 0 && (
        <div className="pm-card">
          <div className="pm-card-title">Risk by Settlement Date</div>
          <div className="pm-table-wrap">
            <table className="pm-table">
              <thead><tr><th>Settlement Date</th><th>Days Away</th><th>Max Loss</th><th>Contracts</th></tr></thead>
              <tbody>
                {Object.entries(riskSummary.bySettlementDate)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([date, risk]) => (
                    <tr key={date}>
                      <td>{date}</td>
                      <td>{daysTo(date) != null ? `${daysTo(date)}d` : '–'}</td>
                      <td>{fmt$(risk)}</td>
                      <td>{open.filter(c => c.settlementDate === date).length}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ marginTop: 8, textAlign: 'right' }}>
        <button className="pm-btn pm-btn-secondary" onClick={() => onTabChange('settings')}>Edit Risk Limits →</button>
      </div>
    </div>
  );
}

// ─── Calibration Tab ─────────────────────────────────────────────────────────

function CalibrationTab({ contracts, isDark }) {
  const closed = contracts.filter(c => (c.status === 'settled' || c.status === 'closed') && c.myProbability != null);
  const buckets = useMemo(() => calibrationBuckets(closed), [closed]);
  const bs = useMemo(() => brierScore(closed), [closed]);
  const ll = useMemo(() => logLoss(closed), [closed]);

  if (closed.length === 0) return <Empty icon="🎯" text="No settled bets for calibration" sub="Calibration analysis requires at least one settled contract." />;

  return (
    <div>
      <div className="pm-kpi-grid">
        <KPI label="Brier Score" value={bs != null ? bs.toFixed(4) : '–'} sub="lower = better" />
        <KPI label="Log Loss" value={ll != null ? ll.toFixed(4) : '–'} sub="lower = better" />
        <KPI label="Settled Bets" value={closed.length} />
      </div>

      <div className="pm-card">
        <div className="pm-card-title">Calibration Table</div>
        <div className="pm-table-wrap">
          <table className="pm-table">
            <thead>
              <tr>
                <th>Bucket</th><th>N</th><th>Avg Predicted</th><th>Actual Hit Rate</th>
                <th>Calib Error</th><th>P&L</th><th>Avg Price</th><th>Avg Edge</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map(b => (
                <tr key={b.label}>
                  <td style={{ fontWeight: 600 }}>{b.label}</td>
                  <td>{b.n}</td>
                  <td>{b.avgPredicted != null ? fmtPct(b.avgPredicted) : '–'}</td>
                  <td>{b.actualHitRate != null ? fmtPct(b.actualHitRate) : '–'}</td>
                  <td>
                    {b.calibrationError != null ? (
                      <span className={Math.abs(b.calibrationError) > 0.05 ? 'edge-negative' : 'edge-positive'}>
                        {fmtEdge(b.calibrationError)}
                      </span>
                    ) : '–'}
                  </td>
                  <td><span className={edgeClass(b.pnl)}>{fmt$(b.pnl)}</span></td>
                  <td>{b.avgPrice != null ? fmtPct(b.avgPrice) : '–'}</td>
                  <td>{b.avgEdge != null ? <span className={edgeClass(b.avgEdge)}>{fmtEdge(b.avgEdge)}</span> : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="pm-card">
        <div className="pm-card-title">Calibration Chart (Predicted vs Actual)</div>
        <CalibrationChart buckets={buckets} isDark={isDark} />
        <div style={{ fontSize: 10, color: '#888', marginTop: 6, textAlign: 'center' }}>
          Points on the diagonal line = perfectly calibrated. Above = overconfident. Below = underconfident.
        </div>
      </div>
    </div>
  );
}

function CalibrationChart({ buckets, isDark }) {
  const valid = buckets.filter(b => b.n > 0 && b.avgPredicted != null && b.actualHitRate != null);
  const W = 320, H = 220, PAD = 36;
  const scale = (v) => PAD + v * (W - PAD * 2);
  const scaleY = (v) => H - PAD - v * (H - PAD * 2);
  const gridColor = isDark ? '#374151' : '#e5e0d6';
  const lineColor = isDark ? '#6b7280' : '#e5e7eb';
  const textColor = isDark ? '#9ca3af' : '#888';
  const dotColor = '#3b82f6';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, display: 'block', margin: '0 auto' }}>
      {[0, 0.25, 0.5, 0.75, 1].map(v => (
        <g key={v}>
          <line x1={PAD} y1={scaleY(v)} x2={W - PAD} y2={scaleY(v)} stroke={gridColor} strokeWidth={0.5} />
          <line x1={scale(v)} y1={PAD} x2={scale(v)} y2={H - PAD} stroke={gridColor} strokeWidth={0.5} />
          <text x={PAD - 4} y={scaleY(v) + 3} fontSize={8} fill={textColor} textAnchor="end">{Math.round(v * 100)}%</text>
          <text x={scale(v)} y={H - PAD + 12} fontSize={8} fill={textColor} textAnchor="middle">{Math.round(v * 100)}%</text>
        </g>
      ))}
      {/* Diagonal — perfect calibration */}
      <line x1={scale(0.5)} y1={scaleY(0.5)} x2={scale(1)} y2={scaleY(1)} stroke={lineColor} strokeWidth={1.5} strokeDasharray="4 3" />
      {/* Data points */}
      {valid.map(b => (
        <g key={b.label}>
          <circle cx={scale(b.avgPredicted)} cy={scaleY(b.actualHitRate)} r={Math.max(3, Math.sqrt(b.n) * 1.5)} fill={dotColor} fillOpacity={0.8} />
          <text x={scale(b.avgPredicted)} y={scaleY(b.actualHitRate) - 6} fontSize={7} fill={dotColor} textAnchor="middle">{b.label}</text>
        </g>
      ))}
      <text x={W / 2} y={H - 2} fontSize={9} fill={textColor} textAnchor="middle">Predicted Probability →</text>
      <text x={8} y={H / 2} fontSize={9} fill={textColor} textAnchor="middle" transform={`rotate(-90, 8, ${H / 2})`}>Actual Frequency →</text>
    </svg>
  );
}

// ─── Performance Analytics Tab ────────────────────────────────────────────────

function PerformanceTab({ contracts, isDark }) {
  const closed = contracts.filter(c => c.status === 'settled' || c.status === 'closed');
  const [dim, setDim] = useState('assetClass');

  const DIMENSIONS = [
    { id: 'assetClass', label: 'Asset Class' },
    { id: 'eventCategory', label: 'Event Category' },
    { id: 'contractSide', label: 'Side (Yes/No)' },
    { id: 'sizingMethod', label: 'Sizing Method' },
    { id: 'manualOverride', label: 'Manual Override' },
  ];

  const rows = useMemo(() => performanceByDimension(closed, dim), [closed, dim]);

  const totPnl = closed.reduce((s, c) => s + (c.realizedProfit || 0), 0);
  const wRate = calcWinRate(closed);
  const avgModelProb = closed.length ? closed.reduce((s, c) => s + (parseFloat(c.myProbability) || 0), 0) / closed.length : null;

  const residuals = useMemo(() => evResiduals(closed), [closed]);
  const totalResidual = residuals.reduce((s, r) => s + r.residual, 0);

  if (closed.length === 0) return <Empty icon="📈" text="No settled bets for performance analytics" sub="Analytics will populate after contracts are settled." />;

  return (
    <div>
      <div className="pm-kpi-grid">
        <KPI label="Total P&L" value={fmt$(totPnl)} valueClass={totPnl >= 0 ? 'positive' : 'negative'} />
        <KPI label="Win Rate" value={wRate != null ? fmtPct(wRate) : '–'} sub={`${closed.length} bets`} />
        <KPI label="Avg Model Prob" value={avgModelProb != null ? fmtPct(avgModelProb) : '–'} />
        <KPI label="EV Residual" value={fmt$(totalResidual)} sub="realized − expected" valueClass={edgeClass(totalResidual)} />
      </div>

      <div className="pm-card">
        <div className="pm-card-title">Performance by Dimension</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {DIMENSIONS.map(d => (
            <button key={d.id} className={`pm-sizing-mode-btn ${dim === d.id ? 'active' : ''}`} onClick={() => setDim(d.id)}>
              {d.label}
            </button>
          ))}
        </div>
        <div className="pm-table-wrap">
          <table className="pm-table">
            <thead>
              <tr><th>Group</th><th>N</th><th>Total P&L</th><th>Win Rate</th><th>Avg Edge at Entry</th><th>Brier Score</th></tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.label}>
                  <td style={{ fontWeight: 600, textTransform: 'capitalize' }}>{String(r.label)}</td>
                  <td>{r.n}</td>
                  <td><span className={edgeClass(r.totalPnl)}>{fmt$(r.totalPnl)}</span></td>
                  <td>{r.winRate != null ? fmtPct(r.winRate) : '–'}</td>
                  <td><span className={edgeClass(r.avgEdgeAtEntry)}>{fmtEdge(r.avgEdgeAtEntry)}</span></td>
                  <td>{r.brierScore != null ? r.brierScore.toFixed(4) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="pm-card">
        <div className="pm-card-title">EV Residual by Contract</div>
        <div className="pm-table-wrap">
          <table className="pm-table">
            <thead>
              <tr><th>Event</th><th>Expected at Entry</th><th>Realized</th><th>Residual</th></tr>
            </thead>
            <tbody>
              {residuals.map(r => (
                <tr key={r.contractId}>
                  <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.eventName}>{r.eventName}</td>
                  <td><span className={edgeClass(r.expectedAtEntry)}>{fmt$(r.expectedAtEntry)}</span></td>
                  <td><span className={edgeClass(r.realized)}>{fmt$(r.realized)}</span></td>
                  <td><span className={edgeClass(r.residual)}>{fmt$(r.residual)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Journal Tab ─────────────────────────────────────────────────────────────

function JournalTab({ contracts, isDark, onUpdate }) {
  const [selected, setSelected] = useState(null);
  const [journal, setJournal] = useState({});
  const [saveMsg, setSaveMsg] = useState('');
  const [filterTag, setFilterTag] = useState('');

  const journalable = contracts.filter(c => c.status !== 'canceled');

  const setJ = (k, v) => setJournal(j => ({ ...j, [k]: v }));

  const handleSelect = (c) => {
    setSelected(c);
    setJournal(c.journal || {});
    setSaveMsg('');
  };

  const handleSave = async () => {
    if (!selected) return;
    await onUpdate(selected.contractId, { journal });
    setSaveMsg('Journal saved!');
    setTimeout(() => setSaveMsg(''), 2000);
    setSelected(s => ({ ...s, journal }));
  };

  const toggleMistakeTag = (tag) => {
    setJ('mistakeTags', journal.mistakeTags?.includes(tag)
      ? journal.mistakeTags.filter(t => t !== tag)
      : [...(journal.mistakeTags || []), tag]);
  };

  const allMistakeTags = useMemo(() => {
    const set = new Set();
    contracts.forEach(c => (c.journal?.mistakeTags || []).forEach(t => set.add(t)));
    return [...set];
  }, [contracts]);

  const filteredContracts = filterTag
    ? journalable.filter(c => c.journal?.mistakeTags?.includes(filterTag))
    : journalable;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 14 }}>
      {/* Contract list */}
      <div>
        <div className="pm-card" style={{ padding: '8px 10px' }}>
          <div className="pm-card-title">Filter by Mistake</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            <button className={`pm-tag-chip ${!filterTag ? 'selected' : ''}`} onClick={() => setFilterTag('')}>All</button>
            {allMistakeTags.map(t => (
              <button key={t} className={`pm-tag-chip ${filterTag === t ? 'selected' : ''}`} onClick={() => setFilterTag(filterTag === t ? '' : t)}>
                {MISTAKE_LABELS[t] || t}
              </button>
            ))}
          </div>
        </div>
        <div style={{ maxHeight: 'calc(100vh - 300px)', overflowY: 'auto' }}>
          {filteredContracts.length === 0 && <Empty icon="📝" text="No contracts" />}
          {filteredContracts.map(c => (
            <div key={c.contractId}
              onClick={() => handleSelect(c)}
              style={{
                padding: '9px 12px', marginBottom: 4, borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${selected?.contractId === c.contractId ? '#3b82f6' : '#e5e7eb'}`,
                background: selected?.contractId === c.contractId ? (isDark ? '#1e3a5f' : '#eff6ff') : (isDark ? '#1f2937' : '#ffffff'),
              }}>
              <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.eventName}</div>
              <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
                <StatusBadge status={c.status} />
                <span className={`pm-badge ${c.contractSide === 'Yes' ? 'yes' : 'no'}`}>{c.contractSide}</span>
              </div>
              {(c.journal?.mistakeTags || []).length > 0 && (
                <div style={{ fontSize: 10, color: '#d97706', marginTop: 3 }}>
                  {(c.journal.mistakeTags).map(t => MISTAKE_LABELS[t] || t).join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Journal form */}
      {selected ? (
        <div>
          <div className="pm-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{selected.eventName}</div>
                <div style={{ fontSize: 11, color: '#888' }}>{selected.contractQuestion}</div>
              </div>
              <StatusBadge status={selected.status} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                ['modelSignal', 'Model Signal', 'What did the model output?'],
                ['whyThisContract', 'Why This Contract', 'How does it match the forecast?'],
                ['whySide', 'Why Yes / No', 'Rationale for chosen side'],
                ['perceivedEdge', 'Perceived Edge', 'Why does edge exist?'],
                ['invalidationThesis', 'What Would Invalidate', 'Conditions that prove you wrong'],
                ['result', 'Result', 'What happened at settlement?'],
                ['postTradeReview', 'Post-Trade Review', 'What did you learn?'],
              ].map(([key, label, placeholder]) => (
                <div key={key} className="pm-form-group" style={key === 'postTradeReview' || key === 'invalidationThesis' ? { gridColumn: 'span 2' } : {}}>
                  <label className="pm-label">{label}</label>
                  <textarea className="pm-textarea" rows={2} placeholder={placeholder}
                    value={journal[key] || ''} onChange={e => setJ(key, e.target.value)} />
                </div>
              ))}
            </div>

            <div style={{ marginTop: 10 }}>
              <div className="pm-label" style={{ marginBottom: 4 }}>Mistake Tags</div>
              <div className="pm-tags-wrap">
                {MISTAKE_TAGS.map(t => (
                  <button key={t} className={`pm-tag-chip ${(journal.mistakeTags || []).includes(t) ? 'selected' : ''}`}
                    onClick={() => toggleMistakeTag(t)}>
                    {MISTAKE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="pm-btn pm-btn-primary" onClick={handleSave}>Save Journal</button>
              {saveMsg && <span style={{ fontSize: 12, color: '#16a34a' }}>{saveMsg}</span>}
            </div>
          </div>
        </div>
      ) : (
        <Empty icon="📝" text="Select a contract to journal" sub="Click any contract on the left to write or review its journal." />
      )}
    </div>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

function SettingsTab({ settings, onSave, isDark }) {
  const [form, setForm] = useState({ ...DEFAULT_SETTINGS, ...settings });
  const [saveMsg, setSaveMsg] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setAC = (ac, v) => setForm(f => ({ ...f, maxRiskByAssetClass: { ...f.maxRiskByAssetClass, [ac]: parseFloat(v) || 0 } }));

  const handleSave = async () => {
    await onSave(form);
    setSaveMsg('Settings saved!');
    setTimeout(() => setSaveMsg(''), 2000);
  };

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div className="pm-card">
          <div className="pm-card-title">Portfolio & Risk</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['portfolioEquity', 'Portfolio Equity ($)', 'number'],
              ['maxRiskPerBet', 'Max Risk per Bet ($)', 'number'],
              ['maxRiskPerDay', 'Max Risk per Day ($)', 'number'],
              ['maxOpenRisk', 'Max Total Open Risk ($)', 'number'],
              ['maxCorrelatedExposure', 'Max Correlated Exposure ($)', 'number'],
              ['maxPmRiskPct', 'Max PM Risk % of Portfolio (0–1)', 'number'],
            ].map(([k, label, type]) => (
              <div key={k} className="pm-form-group">
                <label className="pm-label">{label}</label>
                <input className="pm-input" type={type} step={k.includes('Pct') ? '0.01' : '100'} value={form[k] ?? ''} onChange={e => set(k, parseFloat(e.target.value))} />
              </div>
            ))}
          </div>
        </div>

        <div className="pm-card">
          <div className="pm-card-title">Edge & Fees</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['minNetEdge', 'Min Net Edge Threshold (0–1)', '0.01'],
              ['defaultFeePerContract', 'Default Fee per Contract ($)', '0.001'],
              ['defaultSlippageBuffer', 'Default Slippage Buffer ($)', '0.001'],
              ['modelErrorBuffer', 'Model Error Buffer ($)', '0.001'],
            ].map(([k, label, step]) => (
              <div key={k} className="pm-form-group">
                <label className="pm-label">{label}</label>
                <input className="pm-input" type="number" step={step} value={form[k] ?? ''} onChange={e => set(k, parseFloat(e.target.value))} />
              </div>
            ))}
          </div>
        </div>

        <div className="pm-card">
          <div className="pm-card-title">Kelly & Sizing</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="pm-form-group">
              <label className="pm-label">Default Sizing Mode</label>
              <select className="pm-select" value={form.sizingMode} onChange={e => set('sizingMode', e.target.value)}>
                {SIZING_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
            {[
              ['kellyMultiplier', 'Kelly Multiplier (e.g. 0.25)', '0.05'],
              ['defaultConfidenceHaircut', 'Default Confidence Multiplier (0–1)', '0.05'],
              ['minConfidence', 'Min Confidence to Trade (0–1)', '0.05'],
              ['fixedDollar', 'Fixed Dollar Sizing ($)', '50'],
              ['fixedPct', 'Fixed % Sizing (0–1)', '0.005'],
            ].map(([k, label, step]) => (
              <div key={k} className="pm-form-group">
                <label className="pm-label">{label}</label>
                <input className="pm-input" type="number" step={step} value={form[k] ?? ''} onChange={e => set(k, parseFloat(e.target.value))} />
              </div>
            ))}
          </div>
        </div>

        <div className="pm-card">
          <div className="pm-card-title">Risk Caps by Asset Class</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ASSET_CLASSES.map(ac => (
              <div key={ac} className="pm-form-group">
                <label className="pm-label" style={{ textTransform: 'capitalize' }}>{ac} Max Risk ($)</label>
                <input className="pm-input" type="number" step="100" value={form.maxRiskByAssetClass?.[ac] ?? ''} onChange={e => setAC(ac, e.target.value)} />
              </div>
            ))}
          </div>
        </div>

        <div className="pm-card">
          <div className="pm-card-title">Price & Horizon</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['stalePriceThresholdHours', 'Stale Price Threshold (hours)', '1'],
              ['minSettlementDays', 'Min Settlement Days', '1'],
              ['maxSettlementDays', 'Max Settlement Days', '1'],
            ].map(([k, label, step]) => (
              <div key={k} className="pm-form-group">
                <label className="pm-label">{label}</label>
                <input className="pm-input" type="number" step={step} value={form[k] ?? ''} onChange={e => set(k, parseFloat(e.target.value))} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
        <button className="pm-btn pm-btn-primary" onClick={handleSave}>Save Settings</button>
        {saveMsg && <span style={{ fontSize: 12, color: '#16a34a' }}>{saveMsg}</span>}
      </div>
    </div>
  );
}

// ─── V2 Mock Data ─────────────────────────────────────────────────────────────

const EVENTS_MOCK = [
  { id: 1, question: 'Will SPX close above 5500 on Jun 20, 2026?', category: 'Equities', settle: 'Jun 20, 2026', yes: 0.45, no: 0.55, yesChange: 0.02, noChange: -0.02, myProb: 0.65, side: 'Yes', sizeUsd: 1000, status: 'planned', payoutMultiplier: 1 },
  { id: 2, question: 'Will the Fed cut rates by Sep 17, 2025?', category: 'Rates', settle: 'Sep 17, 2025', yes: 0.38, no: 0.62, yesChange: 0.01, noChange: 0.01, myProb: 0.60, side: 'No', sizeUsd: 800, status: 'planned', payoutMultiplier: 1 },
  { id: 3, question: 'US CPI YoY below 2.5% in Dec 2025?', category: 'Inflation', settle: 'Dec 31, 2025', yes: 0.31, no: 0.69, yesChange: -0.02, noChange: 0.02, myProb: 0.55, side: 'Yes', sizeUsd: 600, status: 'watchlist', payoutMultiplier: 1 },
  { id: 4, question: 'Gold price above $2,500 by Aug 31, 2025?', category: 'Commodities', settle: 'Aug 31, 2025', yes: 0.47, no: 0.53, yesChange: 0.03, noChange: -0.03, myProb: 0.62, side: 'Yes', sizeUsd: 500, status: 'planned', payoutMultiplier: 1 },
  { id: 5, question: 'Bitcoin above $100k by Dec 31, 2025?', category: 'Crypto', settle: 'Dec 31, 2025', yes: 0.58, no: 0.42, yesChange: 0.04, noChange: -0.04, myProb: 0.70, side: 'Yes', sizeUsd: 750, status: 'open', payoutMultiplier: 1 },
  { id: 6, question: 'Will 10Y yield be below 4.00% on Jul 31, 2025?', category: 'Rates', settle: 'Jul 31, 2025', yes: 0.62, no: 0.38, yesChange: -0.02, noChange: 0.02, myProb: 0.40, side: 'No', sizeUsd: 400, status: 'watchlist', payoutMultiplier: 1 },
  { id: 7, question: 'Will WTI crude be above $80 on Jul 31, 2025?', category: 'Commodities', settle: 'Jul 31, 2025', yes: 0.41, no: 0.59, yesChange: 0.01, noChange: -0.01, myProb: 0.55, side: 'No', sizeUsd: 350, status: 'watchlist', payoutMultiplier: 1 },
];

const RECENT_BETS_MOCK = [
  { time: 'May 14, 15:20', contract: 'SPX > 5500 on Jun 20, 2026', asset: 'Equities', side: 'Yes', price: 0.45, size: 12, cost: 5400, myProb: 0.65, edge: 0.142, ev: 142, status: 'open', expiry: 'Jun 20, 2026' },
  { time: 'May 14, 14:55', contract: 'Fed cuts rates by Sep 17, 2025', asset: 'Rates', side: 'No', price: 0.60, size: 8, cost: 4800, myProb: 0.58, edge: 0.087, ev: 87, status: 'open', expiry: 'Sep 17, 2025' },
  { time: 'May 14, 11:30', contract: 'EUR/USD > 1.12 by Jun 30, 2025', asset: 'FX', side: 'Yes', price: 0.42, size: 10, cost: 4200, myProb: 0.57, edge: 0.063, ev: 63, status: 'open', expiry: 'Jun 30, 2025' },
  { time: 'May 13, 16:10', contract: 'US CPI YoY < 2.8% in Jun 2025', asset: 'Inflation', side: 'Yes', price: 0.48, size: 9, cost: 4320, myProb: 0.62, edge: 0.071, ev: 71, status: 'settled', expiry: 'Jun 11, 2025' },
  { time: 'May 13, 10:05', contract: 'Gold > $2,450 by Jul 31, 2025', asset: 'Commodities', side: 'Yes', price: 0.40, size: 7, cost: 2800, myProb: 0.55, edge: 0.049, ev: 49, status: 'open', expiry: 'Jul 31, 2025' },
];

const V2_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'Equities', label: 'Equity Index' },
  { id: 'Rates', label: 'Rates' },
  { id: 'Inflation', label: 'Inflation' },
  { id: 'FX', label: 'FX' },
  { id: 'Commodities', label: 'Commodities' },
  { id: 'Crypto', label: 'Crypto' },
];

const CAT_COLORS = {
  Equities:    { bg: '#e0f2fe', text: '#0369a1' },
  Rates:       { bg: '#dcfce7', text: '#166534' },
  Inflation:   { bg: '#fef9c3', text: '#92400e' },
  FX:          { bg: '#ede9fe', text: '#6d28d9' },
  Commodities: { bg: '#ffedd5', text: '#9a3412' },
  Crypto:      { bg: '#fce7f3', text: '#9d174d' },
};

const STATUS_STYLE = {
  planned:   { bg: '#fef3c7', text: '#92400e' },
  open:      { bg: '#dcfce7', text: '#166534' },
  watchlist: { bg: '#f3f4f6', text: '#6b7280' },
  settled:   { bg: '#ede9fe', text: '#6d28d9' },
  closed:    { bg: '#fee2e2', text: '#991b1b' },
};

// ─── V2 Shared Primitives ─────────────────────────────────────────────────────

function CatPill({ cat }) {
  const s = CAT_COLORS[cat] || { bg: '#f3f4f6', text: '#374151' };
  return (
    <span style={{ background: s.bg, color: s.text, fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>
      {cat}
    </span>
  );
}

function StatPill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.watchlist;
  return (
    <span style={{ background: s.bg, color: s.text, fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10, textTransform: 'capitalize', whiteSpace: 'nowrap' }}>
      {status}
    </span>
  );
}

function SideBadge({ side }) {
  return (
    <span style={{ background: side === 'Yes' ? '#dcfce7' : '#fee2e2', color: side === 'Yes' ? '#166534' : '#991b1b', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 }}>
      {side}
    </span>
  );
}

// ─── V2 Header ────────────────────────────────────────────────────────────────

function PMHeaderV2({ activeTab, setActiveTab }) {
  const [utc, setUtc] = useState('');
  useEffect(() => {
    const upd = () => {
      const n = new Date();
      setUtc(n.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }));
    };
    upd();
    const t = setInterval(upd, 30000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="pmv2-header">
      <div className="pmv2-header-left">
        <div className="pmv2-tabs">
          {[{ id: 'overview', label: 'Overview' }, { id: 'open', label: 'Open Bets' }].map(t => (
            <button key={t.id} className={`pmv2-tab${activeTab === t.id ? ' active' : ''}`} onClick={() => setActiveTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pmv2-header-right">
        <span className="pmv2-status-dot" />
        <span className="pmv2-status-text">PM Connected</span>
        <span className="pmv2-utc">UTC {utc}</span>
        <button className="pmv2-menu-btn">···</button>
      </div>
    </div>
  );
}

// ─── V2 Filter Chips ──────────────────────────────────────────────────────────

function FilterChipsV2({ active, onChange }) {
  return (
    <div className="pmv2-filters">
      {V2_FILTERS.map(f => (
        <button key={f.id} className={`pmv2-chip${active === f.id ? ' active' : ''}`} onClick={() => onChange(f.id)}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

// ─── V2 Events Table ──────────────────────────────────────────────────────────

function EventsTableV2({ events, selectedId, onSelect }) {
  return (
    <div className="pmv2-card">
      <div className="pmv2-card-title">≡ EVENTS</div>
      <div className="pmv2-table-wrap">
        <table className="pmv2-table">
          <thead>
            <tr>
              <th style={{ minWidth: 160 }}>EVENT ↕</th>
              <th>SETTLE ↕</th>
              <th>YES ↕</th>
              <th>NO ↕</th>
              <th>MY PROB ↕</th>
              <th>EDGE ↕</th>
              <th>SIDE ↕</th>
              <th>SIZE ↕</th>
              <th>STATUS ↕</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {events.map(ev => {
              const fees = 0.02;
              const geY = grossEdgeYes(ev.myProb, ev.yes);
              const geN = grossEdgeNo(ev.myProb, ev.no);
              const edge = Math.max(
                calcNetEdge(geY, fees, 0, 0),
                calcNetEdge(geN, fees, 0, 0)
              );
              return (
                <tr
                  key={ev.id}
                  className={`pmv2-row${ev.id === selectedId ? ' selected' : ''}`}
                  onClick={() => onSelect(ev.id)}
                >
                  <td>
                    <div className="pmv2-event-name">{ev.question}</div>
                    <CatPill cat={ev.category} />
                  </td>
                  <td className="pmv2-td-sm">{ev.settle}</td>
                  <td>
                    <div className="pmv2-price">{ev.yes.toFixed(2)}</div>
                    <div className={`pmv2-delta ${ev.yesChange >= 0 ? 'pos' : 'neg'}`}>
                      {ev.yesChange >= 0 ? '▲' : '▼'} {Math.abs(ev.yesChange).toFixed(2)}
                    </div>
                  </td>
                  <td>
                    <div className="pmv2-price">{ev.no.toFixed(2)}</div>
                    <div className={`pmv2-delta ${ev.noChange >= 0 ? 'pos' : 'neg'}`}>
                      {ev.noChange >= 0 ? '▲' : '▼'} {Math.abs(ev.noChange).toFixed(2)}
                    </div>
                  </td>
                  <td className="pmv2-td-sm">{ev.myProb.toFixed(2)}</td>
                  <td><span className="pmv2-edge-pos">+{(edge * 100).toFixed(1)}%</span></td>
                  <td><SideBadge side={ev.side} /></td>
                  <td className="pmv2-td-sm">${ev.sizeUsd.toLocaleString()}</td>
                  <td><StatPill status={ev.status} /></td>
                  <td><button className="pmv2-dots" onClick={e => e.stopPropagation()}>⋮</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── V2 Bet Builder ───────────────────────────────────────────────────────────

function BetBuilderV2({ event }) {
  const [confidence, setConfidence] = useState(0.80);
  const [reviewOpen, setReviewOpen] = useState(false);

  const calc = useMemo(() => {
    if (!event) return null;
    const p = event.myProb;
    const yp = event.yes;
    const np = event.no;
    const pm = event.payoutMultiplier || 1;
    const fees = 0.02;
    const geY = grossEdgeYes(p, yp);
    const geN = grossEdgeNo(p, np);
    const neY = calcNetEdge(geY, fees, 0, 0);
    const neN = calcNetEdge(geN, fees, 0, 0);
    const side = neY >= neN && neY > 0.02 ? 'YES' : neN > 0.02 ? 'NO' : 'NONE';
    const cp = side === 'YES' ? yp : np;
    const safeCp = cp > 0 ? cp : 0.01;
    const kf = Math.max(0, kellyFraction(p, safeCp));
    const contracts = fractionalKellySizing(p, safeCp, 0.25, 100000, 500, pm);
    const evPer = side === 'YES' ? evYesPerContract(p, yp, pm) : evNoPerContract(p, np, pm);
    const totalEv = evPer * contracts;
    const maxLoss = safeCp * pm * contracts;
    const edgeVsMkt = side === 'YES' ? geY : geN;
    return { side, kf, contracts, totalEv, maxLoss, edgeVsMkt, cp: safeCp };
  }, [event]);

  if (!event || !calc) return null;

  return (
    <div className="pmv2-card pmv2-bet-builder">
      <div className="pmv2-card-title">🎯 BET BUILDER</div>

      <div>
        <div className="pmv2-bb-label">CONTRACT</div>
        <div className="pmv2-bb-contract">{event.question}</div>
      </div>

      <div className="pmv2-bb-grid4">
        <div>
          <div className="pmv2-bb-label">YES PRICE</div>
          <div className="pmv2-bb-val">{event.yes.toFixed(2)}</div>
        </div>
        <div>
          <div className="pmv2-bb-label">NO PRICE</div>
          <div className="pmv2-bb-val">{event.no.toFixed(2)}</div>
        </div>
        <div>
          <div className="pmv2-bb-label">MY PROBABILITY</div>
          <div className="pmv2-bb-val">{event.myProb.toFixed(2)}</div>
        </div>
        <div>
          <div className="pmv2-bb-label">CONFIDENCE</div>
          <input
            className="pmv2-bb-input"
            type="number" min={0} max={1} step={0.05}
            value={confidence}
            onChange={e => setConfidence(parseFloat(e.target.value) || 0)}
          />
          <span className="pmv2-bb-hint">(0–1)</span>
        </div>
      </div>

      <div className="pmv2-bb-grid4">
        <div>
          <div className="pmv2-bb-label">PAYOUT (YES)</div>
          <div className="pmv2-bb-val">${(event.payoutMultiplier || 1).toFixed(2)}</div>
        </div>
        <div>
          <div className="pmv2-bb-label">PAYOUT (NO)</div>
          <div className="pmv2-bb-val">${(event.payoutMultiplier || 1).toFixed(2)}</div>
        </div>
        <div>
          <div className="pmv2-bb-label">EDGE (VS MKT)</div>
          <div className={`pmv2-bb-val ${calc.edgeVsMkt >= 0 ? 'pmv2-pos' : 'pmv2-neg'}`}>
            {calc.edgeVsMkt >= 0 ? '+' : ''}{(calc.edgeVsMkt * 100).toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="pmv2-bb-label">RECOMMENDED SIDE</div>
          <span className={`pmv2-bb-side ${calc.side.toLowerCase()}`}>{calc.side}</span>
        </div>
      </div>

      <div className="pmv2-bb-sizing-label">
        SUGGESTED CONTRACTS{' '}
        <span className="pmv2-bb-sizing-hint">(Kelly {confidence})</span>
      </div>
      <div className="pmv2-bb-grid4">
        <div>
          <div className="pmv2-bb-label">Contracts</div>
          <div className="pmv2-bb-val">{calc.contracts}</div>
        </div>
        <div>
          <div className="pmv2-bb-label">Est. Cost (Yes)</div>
          <div className="pmv2-bb-val">${(calc.contracts * event.yes * (event.payoutMultiplier || 1)).toFixed(0)}</div>
        </div>
        <div>
          <div className="pmv2-bb-label">Kelly Fraction</div>
          <div className="pmv2-bb-val">{calc.kf.toFixed(2)}</div>
        </div>
        <div>
          <div className="pmv2-bb-label">Max Loss</div>
          <div className="pmv2-bb-val pmv2-neg">${calc.maxLoss.toFixed(0)}</div>
        </div>
      </div>

      <div className="pmv2-bb-ev-strip">
        <div>
          <div className="pmv2-bb-ev-label">EXPECTED VALUE (EV)</div>
          <div className="pmv2-bb-ev-val pmv2-pos">
            +${calc.totalEv.toFixed(0)}{' '}
            <span className="pmv2-bb-ev-pct">(+{(calc.edgeVsMkt * 100).toFixed(1)}% EV)</span>
          </div>
        </div>
        <div>
          <div className="pmv2-bb-ev-label">MAX LOSS</div>
          <div className="pmv2-bb-ev-val pmv2-neg">
            ${calc.maxLoss.toFixed(0)}{' '}
            <span className="pmv2-bb-ev-pct">(100% of cost)</span>
          </div>
        </div>
      </div>

      <button className="pmv2-btn-primary" onClick={() => setReviewOpen(true)}>
        Review &amp; Place Bet
      </button>
      <button className="pmv2-btn-secondary">☆ Add to Watchlist</button>

      {reviewOpen && (
        <div className="pmv2-modal-overlay" onClick={() => setReviewOpen(false)}>
          <div className="pmv2-modal" onClick={e => e.stopPropagation()}>
            <div className="pmv2-modal-title">Review Bet</div>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '6px 0 14px' }}>
              Decision-support only — no orders placed. Submit manually via IBKR.
            </p>
            <div className="pmv2-modal-row"><span>Contract</span><span>{event.question.slice(0, 50)}…</span></div>
            <div className="pmv2-modal-row"><span>Side</span><span>{calc.side}</span></div>
            <div className="pmv2-modal-row"><span>Contracts</span><span>{calc.contracts}</span></div>
            <div className="pmv2-modal-row"><span>Max Loss</span><span>${calc.maxLoss.toFixed(2)}</span></div>
            <div className="pmv2-modal-row"><span>Expected Value</span><span>+${calc.totalEv.toFixed(2)}</span></div>
            <button className="pmv2-btn-primary" style={{ marginTop: 16 }} onClick={() => setReviewOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── V2 Risk Limits Card ──────────────────────────────────────────────────────

function RiskLimitsCardV2() {
  return (
    <div className="pmv2-card">
      <div className="pmv2-card-title">🛡 RISK LIMITS</div>
      <table className="pmv2-risk-table">
        <tbody>
          <tr><td>Total Open Risk</td><td>$0.00 / $10,000.00</td><td className="pmv2-pct-neutral">0.0%</td></tr>
          <tr><td>PM Risk % of Portfolio</td><td>0.0% / 5.0%</td><td className="pmv2-pct-neutral">0.0%</td></tr>
          <tr><td>Max Possible Profit</td><td>$0.00</td><td></td></tr>
          <tr><td>Portfolio Equity</td><td>$100,000.00</td><td></td></tr>
        </tbody>
      </table>
      <span className="pmv2-manage-link">Manage Risk Limits →</span>
    </div>
  );
}

// ─── V2 Exposure Card ─────────────────────────────────────────────────────────

function ExposureCardV2() {
  return (
    <div className="pmv2-card">
      <div className="pmv2-card-title">⬡ OPEN EXPOSURE BY ASSET CLASS</div>
      <table className="pmv2-risk-table">
        <thead>
          <tr><th>ASSET CLASS</th><th>OPEN RISK (USD)</th><th>% PORTFOLIO</th></tr>
        </thead>
        <tbody>
          {['Equities', 'Rates', 'Inflation', 'FX', 'Commodities', 'Crypto'].map(r => (
            <tr key={r}><td>{r}</td><td>$0.00</td><td className="pmv2-pct-neutral">0.0%</td></tr>
          ))}
          <tr style={{ fontWeight: 700, borderTop: '1px solid #e5e7eb' }}>
            <td>Total</td><td>$0.00</td><td className="pmv2-pct-neutral">0.0%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── V2 Recent Bets Table ─────────────────────────────────────────────────────

function RecentBetsTableV2() {
  return (
    <div className="pmv2-card">
      <div className="pmv2-card-title">≡ RECENT BETS</div>
      <div className="pmv2-table-wrap">
        <table className="pmv2-table">
          <thead>
            <tr>
              <th>TIME</th><th>CONTRACT</th><th>ASSET</th><th>SIDE</th>
              <th>PRICE</th><th>SIZE (CONTRACTS)</th><th>COST (USD)</th>
              <th>MY PROB</th><th>EDGE</th><th>EV (USD)</th><th>STATUS</th><th>EXPIRY</th>
            </tr>
          </thead>
          <tbody>
            {RECENT_BETS_MOCK.map((b, i) => (
              <tr key={i} className="pmv2-row">
                <td className="pmv2-td-sm pmv2-muted">{b.time}</td>
                <td style={{ minWidth: 180, fontSize: 12 }}>{b.contract}</td>
                <td><CatPill cat={b.asset} /></td>
                <td><SideBadge side={b.side} /></td>
                <td className="pmv2-td-sm">{b.price.toFixed(2)}</td>
                <td className="pmv2-td-sm">{b.size}</td>
                <td className="pmv2-td-sm">${b.cost.toLocaleString()}</td>
                <td className="pmv2-td-sm">{b.myProb.toFixed(2)}</td>
                <td><span className="pmv2-edge-pos">+{(b.edge * 100).toFixed(1)}%</span></td>
                <td><span className="pmv2-edge-pos">+${b.ev}</span></td>
                <td><StatPill status={b.status} /></td>
                <td className="pmv2-td-sm pmv2-muted">{b.expiry}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pmv2-view-all">View all bets →</div>
    </div>
  );
}

// ─── V2 Open Bets Tab ─────────────────────────────────────────────────────────

function OpenBetsTabV2() {
  const open = RECENT_BETS_MOCK.filter(b => b.status === 'open');
  return (
    <div style={{ padding: '10px 12px' }}>
      <div className="pmv2-card">
        <div className="pmv2-card-title">≡ OPEN BETS</div>
        <div className="pmv2-table-wrap">
          <table className="pmv2-table">
            <thead>
              <tr>
                <th>TIME</th><th>CONTRACT</th><th>ASSET</th><th>SIDE</th>
                <th>PRICE</th><th>SIZE</th><th>COST</th>
                <th>MY PROB</th><th>EDGE</th><th>EV</th><th>EXPIRY</th>
              </tr>
            </thead>
            <tbody>
              {open.map((b, i) => (
                <tr key={i} className="pmv2-row">
                  <td className="pmv2-td-sm pmv2-muted">{b.time}</td>
                  <td style={{ minWidth: 180, fontSize: 12 }}>{b.contract}</td>
                  <td><CatPill cat={b.asset} /></td>
                  <td><SideBadge side={b.side} /></td>
                  <td className="pmv2-td-sm">{b.price.toFixed(2)}</td>
                  <td className="pmv2-td-sm">{b.size}</td>
                  <td className="pmv2-td-sm">${b.cost.toLocaleString()}</td>
                  <td className="pmv2-td-sm">{b.myProb.toFixed(2)}</td>
                  <td><span className="pmv2-edge-pos">+{(b.edge * 100).toFixed(1)}%</span></td>
                  <td><span className="pmv2-edge-pos">+${b.ev}</span></td>
                  <td className="pmv2-td-sm pmv2-muted">{b.expiry}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component (v2) ──────────────────────────────────────────────────────

export default function PredictionMarkets() {
  const [activeTab, setActiveTab] = useState('overview');
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(EVENTS_MOCK[0].id);

  const filteredEvents = useMemo(
    () => filter === 'all' ? EVENTS_MOCK : EVENTS_MOCK.filter(e => e.category === filter),
    [filter]
  );

  const selectedEvent = useMemo(
    () => EVENTS_MOCK.find(e => e.id === selectedId) || EVENTS_MOCK[0],
    [selectedId]
  );

  return (
    <div className="pmv2-wrap">
      <PMHeaderV2 activeTab={activeTab} setActiveTab={setActiveTab} />
      {activeTab === 'overview' && (
        <>
          <FilterChipsV2 active={filter} onChange={setFilter} />
          <div className="pmv2-main-grid">
            <EventsTableV2 events={filteredEvents} selectedId={selectedId} onSelect={setSelectedId} />
            <BetBuilderV2 event={selectedEvent} />
            <div className="pmv2-right-col">
              <RiskLimitsCardV2 />
              <ExposureCardV2 />
            </div>
          </div>
          <div style={{ padding: '0 12px 12px' }}>
            <RecentBetsTableV2 />
          </div>
        </>
      )}
      {activeTab === 'open' && <OpenBetsTabV2 />}
    </div>
  );
}
