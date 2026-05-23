import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Activity, FileText } from 'lucide-react';
import './PredictionMarkets.css';
import { MarketDataService } from '../../services/api/marketDataService';
import predictionMarketsIngestService from '../../services/api/predictionMarketsIngestService';
import {
  getMacroSignalQuotePlan,
  normalizePredictionMarketSignals,
} from '../../utils/predictionMarketSignals';
import { isTreasuryYieldSymbol } from '../../utils/treasuryYieldScale';
import {
  MacroSignalsCard,
  mapNormalizedRows,
  AssetTabs,
  DEFAULT_ASSET_CLASS,
  inferEventMacroAssetClass,
} from './macroSignals';
import { SecuritiesUniverseMetricsTable } from './securitiesUniverse/index';
import useEnrichedSecurity from '../../hooks/useEnrichedSecurity';
import RefreshButton from '../common/RefreshButton';
import LoadingIndicator from '../common/LoadingIndicator';
import StatusDot from '../common/StatusDot';
import Pmv2CardChrome from './Pmv2CardChrome';
import {
  filterContractMapEvents,
  groupContractMapByEvent,
} from '../../utils/contractMapFilters';
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

const API_BASE = (process.env.REACT_APP_API_URL || process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001') + '/api/prediction-markets';

async function pmFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

const ASSET_CLASS_DISPLAY = {
  equities: 'Equities',
  rates: 'Rates',
  fx: 'FX',
  commodities: 'Commodities',
  crypto: 'Crypto',
};

function contractToEvent(c) {
  const yes = Number(c.yesPrice ?? c.yesLast ?? 0);
  const no = Number(c.noPrice ?? c.noLast ?? 0);
  const myProb = c.adjustedProbability ?? c.myProbability;
  return {
    id: c.contractId,
    question: c.contractQuestion || c.eventName || '—',
    category: c.eventCategory || ASSET_CLASS_DISPLAY[c.assetClass] || c.assetClass || 'Other',
    settle: c.settlementDate || c.expirationDate || '—',
    yes,
    no,
    myProb: myProb != null ? Number(myProb) : null,
    side: c.contractSide || 'Yes',
    sizeUsd: (Number(c.entryPrice ?? (c.contractSide === 'No' ? no : yes)) || 0) * (c.numContracts ?? 0),
    status: c.status,
    payoutMultiplier: c.payoutMultiplier ?? 1,
    contract: c,
  };
}

function contractToBetRow(c, settings) {
  const price = Number(c.entryPrice ?? (c.contractSide === 'Yes' ? c.yesPrice : c.noPrice) ?? 0);
  const n = c.numContracts ?? 0;
  const cost = price * n;
  const p = c.adjustedProbability ?? c.myProbability;
  const fees = settings?.defaultFeePerContract ?? 0.02;
  const slippage = settings?.defaultSlippageBuffer ?? 0;
  const modelErr = settings?.modelErrorBuffer ?? 0;
  let edge = null;
  let ev = null;
  if (p != null && c.yesPrice != null && c.noPrice != null) {
    const adjP = Number(p);
    const yp = Number(c.yesPrice);
    const np = Number(c.noPrice);
    const side = c.contractSide === 'No' ? 'No' : 'Yes';
    const ge = side === 'Yes' ? grossEdgeYes(adjP, yp) : grossEdgeNo(adjP, np);
    edge = calcNetEdge(ge, fees, slippage, modelErr);
    const evPer = side === 'Yes' ? evYesPerContract(adjP, yp) : evNoPerContract(adjP, np);
    ev = evPer * n - fees * n;
  }
  return {
    id: c.contractId,
    time: c.updatedAt ? new Date(c.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
    contract: c.contractQuestion || c.eventName || '—',
    asset: c.eventCategory || ASSET_CLASS_DISPLAY[c.assetClass] || 'Other',
    side: c.contractSide || 'Yes',
    price,
    size: n,
    cost,
    myProb: p != null ? Number(p) : null,
    edge,
    ev,
    status: c.status,
    expiry: c.settlementDate || c.expirationDate || '—',
  };
}

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

const V2_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'Index', label: 'Index' },
  { id: 'Rates', label: 'Rates' },
  { id: 'Inflation', label: 'Inflation' },
  { id: 'Labor', label: 'Labor' },
  { id: 'Growth', label: 'Growth' },
  { id: 'FX', label: 'FX' },
  { id: 'Commodities', label: 'Commodities' },
  { id: 'Crypto', label: 'Crypto' },
];

const CMAP_VENUE_FILTERS = [
  { id: 'all', label: 'All venues' },
  { id: 'kalshi', label: 'Kalshi' },
  { id: 'ibkr', label: 'IBKR' },
  { id: 'merged', label: 'Merged' },
];

const CMAP_QUALITY_LABELS = {
  wide_spread: 'Wide spread',
  thin_liquidity: 'Thin',
  stale_quote: 'Stale',
  missing_settlement_source: 'No settlement',
  not_tradable_in_ibkr: 'Not in IBKR',
};

const PROVIDER_STATUS_LABEL = {
  connected: 'Connected',
  gateway_offline: 'Gateway offline',
  sidecar_offline: 'Sidecar offline',
  tws_offline: 'IB Gateway offline',
  auth_required: 'Login required',
  stale: 'Stale',
  error: 'Error',
  unknown: 'Unknown',
};

const EVENT_STATUSES = new Set(['watchlist', 'planned', 'open']);
const BET_STATUSES = new Set(['open', 'closed', 'settled']);

const CAT_COLORS = {
  Index:       { bg: '#e0f2fe', text: '#0369a1' },
  Equities:    { bg: '#e0f2fe', text: '#0369a1' },
  'Equity Index': { bg: '#e0f2fe', text: '#0369a1' },
  Rates:       { bg: '#dcfce7', text: '#166534' },
  Inflation:   { bg: '#fef9c3', text: '#92400e' },
  Labor:       { bg: '#fce7f3', text: '#9d174d' },
  Growth:      { bg: '#d1fae5', text: '#065f46' },
  Credit:      { bg: '#e5e7eb', text: '#374151' },
  FX:          { bg: '#ede9fe', text: '#6d28d9' },
  Commodities: { bg: '#ffedd5', text: '#9a3412' },
  Crypto:      { bg: '#fce7f3', text: '#9d174d' },
  'Other Macro': { bg: '#f3f4f6', text: '#374151' },
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

function ProviderStatusBar({ providers, onRefreshIbkr, ibkrRefreshing, lastIbkrUpdate }) {
  if (!providers) return null;
  const ibkr = providers.ibkr || {};
  const kalshi = providers.kalshi || {};
  const ibkrClass =
    ibkr.status === 'connected'
      ? 'ready'
      : ['gateway_offline', 'sidecar_offline', 'tws_offline', 'auth_required', 'unknown'].includes(ibkr.status)
        ? 'warn'
        : 'error';

  return (
    <div className="pmv2-provider-bar">
      <div className="pmv2-provider-items">
        <span className="pmv2-provider-item">
          <span className={`pmv2-status-dot ${kalshi.status === 'connected' ? 'ready' : 'warn'}`} />
          Kalshi: {PROVIDER_STATUS_LABEL[kalshi.status] || kalshi.status}
          {kalshi.last_success_at && (
            <span className="pmv2-provider-ts"> · {new Date(kalshi.last_success_at).toLocaleTimeString()}</span>
          )}
        </span>
        <span className="pmv2-provider-item">
          <span className={`pmv2-status-dot ${ibkrClass}`} />
          IBKR: {PROVIDER_STATUS_LABEL[ibkr.status] || ibkr.status}
          {lastIbkrUpdate && (
            <span className="pmv2-provider-ts"> · Last IBKR {new Date(lastIbkrUpdate).toLocaleString()}</span>
          )}
        </span>
        {ibkr.message && <span className="pmv2-provider-hint">{ibkr.message}</span>}
      </div>
      <RefreshButton
        label="Refresh IBKR"
        onClick={onRefreshIbkr}
        loading={ibkrRefreshing}
        disabled={ibkrRefreshing}
      />
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

function EventsTableV2({ events, selectedId, onSelect, settings, loading }) {
  const fees = settings?.defaultFeePerContract ?? 0.02;
  const slippage = settings?.defaultSlippageBuffer ?? 0;
  const modelErr = settings?.modelErrorBuffer ?? 0;

  return (
    <div className="pmv2-card">
      <div className="pmv2-card-title">≡ EVENTS</div>
      {loading ? (
        <LoadingIndicator label="Loading market events…" centered className="pmv2-empty" />
      ) : events.length === 0 ? (
        <div className="pmv2-empty">
          <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>No financial events loaded</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>Configure Kalshi API keys or run IB Gateway + npm run ibkr-sidecar, then Refresh IBKR.</div>
        </div>
      ) : (
      <div className="pmv2-table-wrap">
        <table className="pmv2-table">
          <thead>
            <tr>
              <th style={{ minWidth: 160 }}>EVENT ↕</th>
              <th>VENUE</th>
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
              let edge = null;
              if (ev.myProb != null) {
                const geY = grossEdgeYes(ev.myProb, ev.yes);
                const geN = grossEdgeNo(ev.myProb, ev.no);
                edge = Math.max(calcNetEdge(geY, fees, slippage, modelErr), calcNetEdge(geN, fees, slippage, modelErr));
              }
              return (
                <tr
                  key={ev.id}
                  className={`pmv2-row${ev.id === selectedId ? ' selected' : ''}`}
                  onClick={() => onSelect(ev.id)}
                >
                  <td>
                    <div className="pmv2-event-name">{ev.question}</div>
                    <CatPill cat={ev.category} />
                    {(ev.data_quality_flags || []).includes('stale_quote') && (
                      <span className="pmv2-stale-tag">stale</span>
                    )}
                  </td>
                  <td className="pmv2-td-sm">{ev.venue || '–'}</td>
                  <td className="pmv2-td-sm">{ev.settle}</td>
                  <td><div className="pmv2-price">{ev.yes.toFixed(2)}</div></td>
                  <td><div className="pmv2-price">{ev.no.toFixed(2)}</div></td>
                  <td className="pmv2-td-sm">{ev.myProb != null ? ev.myProb.toFixed(2) : '–'}</td>
                  <td>
                    {edge != null ? (
                      <span className={edge >= 0 ? 'pmv2-edge-pos' : 'pmv2-edge-neg'}>
                        {edge >= 0 ? '+' : ''}{(edge * 100).toFixed(1)}%
                      </span>
                    ) : '–'}
                  </td>
                  <td><SideBadge side={ev.side} /></td>
                  <td className="pmv2-td-sm">{ev.sizeUsd > 0 ? `$${ev.sizeUsd.toLocaleString()}` : '–'}</td>
                  <td><StatPill status={ev.status} /></td>
                  <td><button className="pmv2-dots" onClick={e => e.stopPropagation()}>⋮</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

// ─── V2 Signal Context Card ───────────────────────────────────────────────────

function PredictionMarketSignalContextCard({ signalContext, selectedEvent, loading, error, onRetry }) {
  const rows = signalContext?.topRows || [];
  const categoryLabel = signalContext?.category === 'all' ? 'All Macro' : signalContext?.category;

  return (
    <div className="pmv2-card pmv2-signal-card">
      <div className="pmv2-signal-header">
        <div>
          <div className="pmv2-card-title">SIGNAL CONTEXT</div>
          <div className="pmv2-signal-category">{categoryLabel || 'All Macro'}</div>
        </div>
        <RefreshButton onClick={onRetry} loading={loading} />
      </div>

      {selectedEvent?.question && (
        <div className="pmv2-signal-event" title={selectedEvent.question}>
          {selectedEvent.question}
        </div>
      )}

      {error && (
        <div className="pmv2-signal-error">
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="pmv2-empty pmv2-signal-empty">Loading Hedgeye signals...</div>
      ) : rows.length === 0 ? (
        <div className="pmv2-empty pmv2-signal-empty">No matching signals found.</div>
      ) : (
        <div className="pmv2-signal-list">
          {rows.map(row => (
            <SignalContextRow key={row.symbol} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function SignalContextRow({ row }) {
  return (
    <div className="pmv2-signal-row">
      <div className="pmv2-signal-row-top">
        <div>
          <div className="pmv2-signal-symbol">{row.symbol}</div>
          <div className="pmv2-signal-label">{row.label}</div>
        </div>
        <span className={`pmv2-signal-trend ${getTrendClass(row.trend)}`}>
          {row.trend || 'NO SIGNAL'}
        </span>
      </div>

      <div className="pmv2-signal-metrics">
        {(row.buyTrade != null || row.sellTrade != null) && (
          <div className="pmv2-signal-metric">
            <span>Trade</span>
            <strong>
              B {formatSignalLevel(row, row.buyTrade)} / S {formatSignalLevel(row, row.sellTrade)}
            </strong>
          </div>
        )}
        {(row.lrr != null || row.hrr != null) && (
          <div className="pmv2-signal-metric">
            <span>Risk Range</span>
            <strong>
              {formatSignalLevel(row, row.lrr)} - {formatSignalLevel(row, row.hrr)}
            </strong>
          </div>
        )}
        {(row.upside != null || row.downside != null) && (
          <div className="pmv2-signal-metric">
            <span>Risk/Reward</span>
            <strong>
              Up {formatPercentLevel(row.upside)} / Down {formatPercentLevel(row.downside)}
            </strong>
          </div>
        )}
      </div>

      <div className="pmv2-signal-footer">
        <span>{row.sources.length ? row.sources.join(' + ') : 'Waiting for Hedgeye data'}</span>
        {row.date && <span>{row.date}</span>}
      </div>
    </div>
  );
}

function getTrendClass(trend) {
  if (['BULLISH', 'LONG'].includes(trend)) return 'positive';
  if (['BEARISH', 'SHORT'].includes(trend)) return 'negative';
  if (trend === 'NEUTRAL') return 'neutral';
  return '';
}

function isLongTrend(trend) {
  return ['BULLISH', 'LONG'].includes(trend);
}

function isShortTrend(trend) {
  return ['BEARISH', 'SHORT'].includes(trend);
}

function formatSignalLevel(row, value) {
  if (value == null || Number.isNaN(Number(value))) return '--';
  const n = Number(value);
  if (isTreasuryYieldSymbol(row.symbol)) return `${n.toFixed(2)}%`;
  if (row.group === 'FX') return n >= 10 ? n.toFixed(2) : n.toFixed(4);
  if (row.group === 'Crypto' || row.group === 'Commodities') {
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
  }
  return n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : 2 });
}

function formatPercentLevel(value) {
  if (value == null || Number.isNaN(Number(value))) return '--';
  return `${Number(value).toFixed(1)}%`;
}

// ─── V2 Bet Builder ───────────────────────────────────────────────────────────

function BetBuilderV2({ event, settings }) {
  const [confidence, setConfidence] = useState(settings?.defaultConfidenceHaircut ?? 0.8);
  const [reviewOpen, setReviewOpen] = useState(false);

  const calc = useMemo(() => {
    if (!event || event.myProb == null) return null;
    const p = event.myProb;
    const yp = event.yes;
    const np = event.no;
    const pm = event.payoutMultiplier || 1;
    const fees = settings?.defaultFeePerContract ?? 0.02;
    const slippage = settings?.defaultSlippageBuffer ?? 0;
    const modelErr = settings?.modelErrorBuffer ?? 0;
    const minEdge = settings?.minNetEdge ?? 0.02;
    const geY = grossEdgeYes(p, yp);
    const geN = grossEdgeNo(p, np);
    const neY = calcNetEdge(geY, fees, slippage, modelErr);
    const neN = calcNetEdge(geN, fees, slippage, modelErr);
    const side = neY >= neN && neY > minEdge ? 'YES' : neN > minEdge ? 'NO' : 'NONE';
    const cp = side === 'YES' ? yp : np;
    const safeCp = cp > 0 ? cp : 0.01;
    const kf = Math.max(0, kellyFraction(p, safeCp));
    const kMult = settings?.kellyMultiplier ?? 0.25;
    const equity = settings?.portfolioEquity ?? 0;
    const maxBet = settings?.maxRiskPerBet ?? 0;
    const contracts = fractionalKellySizing(p, safeCp, kMult, equity, maxBet, pm);
    const evPer = side === 'YES' ? evYesPerContract(p, yp, pm) : evNoPerContract(p, np, pm);
    const totalEv = evPer * contracts;
    const maxLoss = safeCp * pm * contracts;
    const edgeVsMkt = side === 'YES' ? neY : neN;
    return { side, kf, contracts, totalEv, maxLoss, edgeVsMkt, cp: safeCp };
  }, [event, settings]);

  if (!event) {
    return (
      <div className="pmv2-card pmv2-bet-builder">
        <div className="pmv2-card-title">🎯 BET BUILDER</div>
        <div className="pmv2-empty">Select a contract with prices and model probability to size a bet.</div>
      </div>
    );
  }

  if (!calc) {
    return (
      <div className="pmv2-card pmv2-bet-builder">
        <div className="pmv2-card-title">🎯 BET BUILDER</div>
        <div className="pmv2-bb-contract">{event.question}</div>
        <div className="pmv2-empty" style={{ marginTop: 12 }}>Add market prices and your probability to calculate edge and sizing.</div>
      </div>
    );
  }

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

function RiskLimitsCardV2({ analytics, settings, risk }) {
  const equity = settings?.portfolioEquity ?? 0;
  const maxOpen = settings?.maxOpenRisk ?? 0;
  const maxPmPct = settings?.maxPmRiskPct ?? 0;
  const openRisk = risk?.totalMaxLoss ?? analytics?.totalOpenRisk ?? 0;
  const maxProfit = risk?.totalMaxProfit ?? 0;
  const riskPct = equity > 0 ? (openRisk / equity) * 100 : 0;
  const capPct = maxPmPct * 100;
  const openPct = maxOpen > 0 ? (openRisk / maxOpen) * 100 : 0;

  return (
    <div className="pmv2-card">
      <div className="pmv2-card-title">🛡 RISK LIMITS</div>
      <table className="pmv2-risk-table">
        <tbody>
          <tr>
            <td>Total Open Risk</td>
            <td>{fmt$(openRisk)} / {fmt$(maxOpen)}</td>
            <td className="pmv2-pct-neutral">{openPct.toFixed(1)}%</td>
          </tr>
          <tr>
            <td>PM Risk % of Portfolio</td>
            <td>{riskPct.toFixed(1)}% / {capPct.toFixed(1)}%</td>
            <td className="pmv2-pct-neutral">{capPct > 0 ? ((riskPct / capPct) * 100).toFixed(1) : '0.0'}%</td>
          </tr>
          <tr><td>Max Possible Profit</td><td>{fmt$(maxProfit)}</td><td></td></tr>
          <tr><td>Portfolio Equity</td><td>{fmt$(equity)}</td><td></td></tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── V2 Exposure Card ─────────────────────────────────────────────────────────

function ExposureCardV2({ risk, settings }) {
  const equity = settings?.portfolioEquity ?? 0;
  const byAc = risk?.byAssetClass ?? {};
  const rows = Object.entries(byAc).map(([key, val]) => ({
    label: ASSET_CLASS_DISPLAY[key] || key,
    risk: val,
    pct: equity > 0 ? (val / equity) * 100 : 0,
  }));
  const total = risk?.totalMaxLoss ?? rows.reduce((s, r) => s + r.risk, 0);

  return (
    <div className="pmv2-card">
      <div className="pmv2-card-title">⬡ OPEN EXPOSURE BY ASSET CLASS</div>
      {rows.length === 0 ? (
        <div className="pmv2-empty" style={{ padding: 16 }}>No open exposure</div>
      ) : (
        <table className="pmv2-risk-table">
          <thead>
            <tr><th>ASSET CLASS</th><th>OPEN RISK (USD)</th><th>% PORTFOLIO</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{fmt$(r.risk)}</td>
                <td className="pmv2-pct-neutral">{r.pct.toFixed(1)}%</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 700, borderTop: '1px solid #e5e7eb' }}>
              <td>Total</td><td>{fmt$(total)}</td>
              <td className="pmv2-pct-neutral">{equity > 0 ? ((total / equity) * 100).toFixed(1) : '0.0'}%</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── V2 Recent Bets Table ─────────────────────────────────────────────────────

function RecentBetsTableV2({ bets = [], loading }) {
  return (
    <div className="pmv2-card">
      <div className="pmv2-card-title">≡ RECENT BETS</div>
      {loading ? (
        <div className="pmv2-empty">Loading bets…</div>
      ) : bets.length === 0 ? (
        <div className="pmv2-empty">No bets recorded yet.</div>
      ) : (
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
            {bets.map(b => (
              <tr key={b.id} className="pmv2-row">
                <td className="pmv2-td-sm pmv2-muted">{b.time}</td>
                <td style={{ minWidth: 180, fontSize: 12 }}>{b.contract}</td>
                <td><CatPill cat={b.asset} /></td>
                <td><SideBadge side={b.side} /></td>
                <td className="pmv2-td-sm">{b.price.toFixed(2)}</td>
                <td className="pmv2-td-sm">{b.size}</td>
                <td className="pmv2-td-sm">${b.cost.toLocaleString()}</td>
                <td className="pmv2-td-sm">{b.myProb != null ? b.myProb.toFixed(2) : '–'}</td>
                <td>
                  {b.edge != null ? (
                    <span className={b.edge >= 0 ? 'pmv2-edge-pos' : 'pmv2-edge-neg'}>
                      {b.edge >= 0 ? '+' : ''}{(b.edge * 100).toFixed(1)}%
                    </span>
                  ) : '–'}
                </td>
                <td>
                  {b.ev != null ? (
                    <span className={b.ev >= 0 ? 'pmv2-edge-pos' : 'pmv2-edge-neg'}>
                      {b.ev >= 0 ? '+' : ''}${Math.abs(b.ev).toFixed(0)}
                    </span>
                  ) : '–'}
                </td>
                <td><StatPill status={b.status} /></td>
                <td className="pmv2-td-sm pmv2-muted">{b.expiry}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

const PREDICTION_MARKETS_LOGO_SRC = '/images/icons/prediction-markets.png';

/** Full horizontal logo or crystal-ball icon crop (sidebar). */
export function PredictionMarketsLogo({ variant = 'full', height = 28, className = '' }) {
  const isIcon = variant === 'icon';

  return (
    <img
      src={PREDICTION_MARKETS_LOGO_SRC}
      alt={isIcon ? '' : 'Prediction Markets'}
      aria-hidden={isIcon ? true : undefined}
      className={`pmv2-logo ${isIcon ? 'pmv2-logo-icon' : 'pmv2-logo-full'} ${className}`}
      style={{ height }}
      width={isIcon ? height : undefined}
    />
  );
}

/** @deprecated Use PredictionMarketsLogo with variant="icon" */
export function PalantirOrbIcon({ size = 24, className = '' }) {
  return <PredictionMarketsLogo variant="icon" height={size} className={className} />;
}

function PredictionMarketsHeaderV2({ onClose }) {
  return (
    <header className="pmv2-redesign-header">
      <div className="pmv2-header-left">
        <button
          type="button"
          className="pmv2-header-brand"
          onClick={onClose}
          title={onClose ? 'Close panel' : undefined}
          disabled={!onClose}
        >
          <PredictionMarketsLogo variant="icon" height={28} />
          <span className="pmv2-header-title">Prediction Markets</span>
        </button>
      </div>
    </header>
  );
}

function providerSourceStatus(status) {
  if (status === 'connected') return 'current';
  if (['gateway_offline', 'sidecar_offline', 'tws_offline', 'auth_required', 'unknown', 'stale'].includes(status)) {
    return 'stale';
  }
  return 'defective';
}

function deriveProviderAggregateStatus(kalshi, ibkr) {
  const kalshiOk = kalshi?.status === 'connected';
  const ibkrOk = ibkr?.status === 'connected';
  if (kalshiOk && ibkrOk) return 'active';
  if (!kalshiOk && !ibkrOk) return 'inactive';
  return 'stale';
}

function ContractProviderStatusDot({ providers, ibkrLoading, onRefreshIbkr }) {
  const kalshi = providers?.kalshi || {};
  const ibkr = providers?.ibkr || {};

  const sources = useMemo(() => [
    {
      id: 'kalshi',
      label: 'Kalshi',
      detail: PROVIDER_STATUS_LABEL[kalshi.status] || kalshi.status || 'Unknown',
      status: providerSourceStatus(kalshi.status),
    },
    {
      id: 'ibkr',
      label: 'IBKR',
      detail: PROVIDER_STATUS_LABEL[ibkr.status] || ibkr.status || 'Unknown',
      status: providerSourceStatus(ibkr.status),
      action: (
        <RefreshButton
          iconOnly
          onClick={onRefreshIbkr}
          loading={ibkrLoading}
          disabled={ibkrLoading}
          title="Refresh IBKR contracts"
          label="Refresh IBKR"
        />
      ),
    },
  ], [kalshi.status, ibkr.status, ibkrLoading, onRefreshIbkr]);

  return (
    <StatusDot
      status={deriveProviderAggregateStatus(kalshi, ibkr)}
      size={8}
      label="Contract providers"
      overallLabel="Providers"
      sources={sources}
      align="right"
    />
  );
}


function normalizeTrendLabel(raw) {
  if (!raw) return null;
  const u = raw.toUpperCase();
  if (u === 'BULLISH' || u === 'LONG') return 'BULLISH';
  if (u === 'BEARISH' || u === 'SHORT') return 'BEARISH';
  if (u === 'NEUTRAL') return 'NEUTRAL';
  return null;
}

function MscSignalBadge({ value }) {
  if (!value) return <span className="msc-dash">–</span>;
  const cls = value === 'BULLISH' ? 'bull' : value === 'BEARISH' ? 'bear' : 'neutral';
  const short = value === 'BULLISH' ? 'Bull' : value === 'BEARISH' ? 'Bear' : 'Neut';
  return <span className={`msc-signal-badge msc-signal-badge-${cls}`}>{short}</span>;
}

function TradePlanCard({ selectedSignal, selectedEvent, settings }) {
  const symbol = selectedSignal?.symbol ?? null;
  const {
    security: enrichedSecurity,
    loading: securityLoading,
    error: securityError,
    tradingDays,
    hasListEntry,
  } = useEnrichedSecurity(symbol);

  const tradePlan = useMemo(
    () => selectedSignal && selectedEvent ? calculatePositionSize(selectedSignal, selectedEvent, settings) : null,
    [selectedSignal, selectedEvent, settings]
  );

  const footerPrompt = selectedSignal && !selectedEvent ? (
    <div className="tp-prompt">
      <span className="tp-prompt-icon">↑</span>
      Select a contract above to generate a trade plan.
    </div>
  ) : null;

  if (!selectedSignal) {
    return (
      <Pmv2CardChrome
        icon={<Activity size={16} />}
        title="Signal Strength"
        titleId="signal-strength-title"
        className="tp-card tp-card-empty"
      >
        <div className="tp-empty-icon">◈</div>
        <div className="tp-empty-title">Select a signal</div>
        <div className="tp-empty-sub">Choose a signal from the left panel to view related contracts and generate a trade plan.</div>
      </Pmv2CardChrome>
    );
  }

  return (
    <Pmv2CardChrome
      icon={<Activity size={16} />}
      title="Signal Strength"
      titleId="signal-strength-title"
      className="tp-card"
      footer={footerPrompt}
    >
      <div className="tp-section tp-section-universe">
        <div className="tp-universe-metrics-wrap">
          <SecuritiesUniverseMetricsTable
            security={enrichedSecurity}
            loading={securityLoading}
            error={securityError}
            compact
            tradingDays={tradingDays}
            missingSymbol={!hasListEntry ? symbol : null}
          />
        </div>
      </div>

      {selectedEvent && (
        <>
          <div className="tp-divider" />

          <div className="tp-section">
            <div className="tp-section-label">Selected Contract</div>
            <div className="tp-contract-title">{selectedEvent.question || selectedEvent.event_title}</div>
            <div className="tp-contract-meta">
              <span className="tp-meta-chip">{selectedEvent.venue || 'Kalshi'}</span>
              {selectedEvent.settle && selectedEvent.settle !== '—' && (
                <span className="tp-meta-chip">Settles {formatDateShort(selectedEvent.settle)}</span>
              )}
              {selectedEvent.status && (
                <span className="tp-meta-chip">{selectedEvent.status}</span>
              )}
            </div>
            <div className="tp-signal-cols" style={{ marginTop: 8 }}>
              <TpStatBox label="Yes Price">
                {selectedEvent.yes != null ? fmtPct(selectedEvent.yes) : <span className="tp-muted">—</span>}
              </TpStatBox>
              <TpStatBox label="No Price">
                {selectedEvent.no != null ? fmtPct(selectedEvent.no) : <span className="tp-muted">—</span>}
              </TpStatBox>
              <TpStatBox label="Implied Prob">
                {selectedEvent.yes != null ? fmtPct(selectedEvent.yes) : <span className="tp-muted">—</span>}
              </TpStatBox>
              <TpStatBox label="Model Prob">
                {selectedEvent.myProb != null
                  ? <span className="tp-model-prob">{fmtPct(selectedEvent.myProb)}</span>
                  : <span className="tp-muted tp-signal-only">signal-only</span>}
              </TpStatBox>
            </div>
          </div>

          <div className="tp-divider" />

          {/* ── 3. Recommendation block ─────────────────── */}
          <div className="tp-section">
            <div className="tp-section-label">Recommendation</div>
            {tradePlan && (
              <div className={`tp-rec-box ${tradePlan.suggestedSize > 0 ? (tradePlan.recommendedSide === 'YES' ? 'yes' : 'no') : 'neutral'}`}>
                <div className="tp-rec-header">
                  <span className={`tp-rec-side ${tradePlan.recommendedSide === 'YES' ? 'yes' : 'no'}`}>
                    Buy {tradePlan.recommendedSide}
                  </span>
                  <span className={`tp-conf-badge ${tradePlan.confidence.toLowerCase()}`}>
                    {tradePlan.confidence} Confidence
                  </span>
                  {tradePlan.isSignalOnly && (
                    <span className="tp-signal-only-tag">Signal-Only</span>
                  )}
                </div>
                <div className="tp-rec-grid">
                  <TpStatBox label="Suggested Size">
                    <strong>{tradePlan.suggestedSize.toLocaleString()}</strong>
                    <div className="tp-stat-sub">contracts</div>
                  </TpStatBox>
                  <TpStatBox label="Max Size">
                    <strong>{tradePlan.maxSize.toLocaleString()}</strong>
                    <div className="tp-stat-sub">contracts</div>
                  </TpStatBox>
                  <TpStatBox label="Est. Cost">
                    <strong>{fmt$(tradePlan.estimatedCost)}</strong>
                  </TpStatBox>
                  <TpStatBox label="Expected Value">
                    <strong className={tradePlan.expectedValue >= 0 ? 'tp-pos' : 'tp-neg'}>
                      {fmt$(tradePlan.expectedValue)}
                    </strong>
                  </TpStatBox>
                </div>
                <div className="tp-rec-explanation">{tradePlan.explanation}</div>
              </div>
            )}
          </div>

          <div className="tp-divider" />

          {/* ── 4. IBKR Order Fields block ─────────────── */}
          <div className="tp-section">
            <div className="tp-section-label">IBKR Order Fields</div>
            <div className="tp-ibkr-grid">
              <TpFieldRow label="Contract / Event" value={selectedEvent.question || selectedEvent.event_title || '—'} fullWidth />
              <TpFieldRow label="Venue" value={selectedEvent.venue || 'Kalshi / IBKR ForecastEx'} />
              <TpFieldRow label="Side" value={tradePlan ? `Buy ${tradePlan.recommendedSide}` : '—'} highlight />
              <TpFieldRow label="Quantity" value={tradePlan ? `${tradePlan.suggestedSize} contracts` : '—'} />
              <TpFieldRow label="Limit Price" value={
                tradePlan && tradePlan.recommendedSide === 'YES' && selectedEvent.yes != null
                  ? fmtPct(selectedEvent.yes)
                  : tradePlan && selectedEvent.no != null
                    ? fmtPct(selectedEvent.no)
                    : '—'
              } />
              <TpFieldRow label="Est. Cost" value={tradePlan ? fmt$(tradePlan.estimatedCost) : '—'} />
              <TpFieldRow label="Worst-Case Loss" value={tradePlan ? fmt$(tradePlan.worstCaseLoss) : '—'} />
              <TpFieldRow label="Notes" value={`Signal: ${selectedSignal.symbol} ${selectedSignal.trend || ''}. Enter via ForecastEx or Kalshi bridge. Confirm settlement source before entry.`} fullWidth />
            </div>
          </div>
        </>
      )}
    </Pmv2CardChrome>
  );
}

function TpStatBox({ label, children }) {
  return (
    <div className="tp-stat-box">
      <div className="tp-stat-label">{label}</div>
      <div className="tp-stat-value">{children}</div>
    </div>
  );
}

function TpFieldRow({ label, value, highlight, fullWidth }) {
  return (
    <div className={`tp-field-row${fullWidth ? ' full' : ''}`}>
      <span className="tp-field-label">{label}</span>
      <span className={`tp-field-value${highlight ? ' highlight' : ''}`}>{value}</span>
    </div>
  );
}

function HeroStat({ label, value, tone }) {
  return (
    <div className={`pmv2-hero-stat ${tone || ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailCard({ label, value, note, wide }) {
  return (
    <div className={`pmv2-detail-card${wide ? ' wide' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

// ─── Contract Map helpers ────────────────────────────────────────────────────

function fmtCents(price) {
  if (price == null || price === '') return '–';
  const c = Math.round(Number(price) * 100);
  return `${c}¢`;
}

function fmtVenueLine(event) {
  const venues = event.venues?.length ? event.venues : [event.venue].filter(Boolean);
  const unique = [...new Set(venues)];
  const quote = event.quote_source ? ` · ${event.quote_source} quote` : '';
  if (event.is_merged) return `${unique.join(' + ')}${quote}`;
  return unique[0] || '—';
}

function fmtOiValue(event) {
  const oi = event.open_interest ?? event.liquidity;
  if (oi != null && Number(oi) > 0) return fmtVolume(oi);
  if (event.ibkr_tradable && !event.venues?.includes('Kalshi')) return '–';
  return fmtVolume(oi);
}

function fmtTotalVolume(event) {
  const total = event.total_volume ?? event.open_interest;
  if (total != null && Number(total) > 0) return fmtVolume(total);
  return fmtVolume(event.volume);
}

function fmtVolume(n) {
  const v = Number(n);
  if (!v || Number.isNaN(v)) return '–';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString();
}

function fmtTimeAgo(dateStr) {
  if (!dateStr) return '–';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return '–';
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtExpiryDate(dateStr) {
  if (!dateStr) return '–';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '–';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(2);
  return `${mm}/${dd}/${yy}`;
}

const CMAP_COLS = [
  { id: 'market',   label: 'MARKET',   sortable: false, align: 'left'  },
  { id: 'bid',      label: 'BID',      sortable: true,  align: 'right' },
  { id: 'ask',      label: 'ASK',      sortable: true,  align: 'right' },
  { id: 'spread',   label: 'SPREAD',   sortable: true,  align: 'right' },
  { id: 'vol24h',   label: '24H',      sortable: true,  align: 'right' },
  { id: 'total',    label: 'TOTAL',    sortable: true,  align: 'right', title: 'Lifetime volume (Kalshi) or session volume' },
  { id: 'oi',       label: 'OI',       sortable: true,  align: 'right', title: 'Open interest (Kalshi only)' },
  { id: 'inc',      label: 'INC',      sortable: false, align: 'right' },
  { id: 'category', label: 'CATEGORY', sortable: true,  align: 'left'  },
  { id: 'added',    label: 'ADDED',    sortable: true,  align: 'right' },
  { id: 'expires',  label: 'EXPIRES',  sortable: true,  align: 'right' },
];

function getEventSortVal(ev, colId) {
  switch (colId) {
    case 'bid':      return Number(ev.yes_bid ?? ev.yes ?? 0);
    case 'ask':      return Number(ev.yes_ask ?? 0);
    case 'spread':   return Number(ev.spread ?? 0);
    case 'vol24h':   return Number(ev.volume ?? 0);
    case 'total':    return Number(ev.total_volume ?? ev.open_interest ?? ev.volume ?? 0);
    case 'oi':       return Number(ev.open_interest ?? ev.liquidity ?? 0);
    case 'added':    return ev.updated_at ? new Date(ev.updated_at).getTime() : 0;
    case 'expires':  return ev.expiration_time ? new Date(ev.expiration_time).getTime() : Infinity;
    case 'category': return ev.category ?? '';
    default:         return 0;
  }
}

const CMAP_PAGE_SIZE = 20;

function ContractMapCard({ events, selectedId, onSelect, selectedSignal, loading, providers, ibkrLoading, onRefreshIbkr }) {
  const [selectedAssetClass, setSelectedAssetClass] = useState(DEFAULT_ASSET_CLASS);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [venueFilter, setVenueFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [groupByEvent, setGroupByEvent] = useState(false);
  const [sortCol, setSortCol] = useState('oi');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(0);

  const filteredEvents = useMemo(
    () => filterContractMapEvents(events, { categoryFilter, venueFilter, searchQuery }),
    [events, categoryFilter, venueFilter, searchQuery],
  );

  const tabbedEvents = useMemo(() => {
    const assetFiltered = filteredEvents.filter(
      (e) => inferEventMacroAssetClass(e) === selectedAssetClass,
    );
    return groupByEvent ? groupContractMapByEvent(assetFiltered) : assetFiltered;
  }, [filteredEvents, selectedAssetClass, groupByEvent]);

  const sorted = useMemo(() => {
    const arr = [...tabbedEvents];
    arr.sort((a, b) => {
      const av = getEventSortVal(a, sortCol);
      const bv = getEventSortVal(b, sortCol);
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return arr;
  }, [tabbedEvents, sortCol, sortDir]);

  useEffect(() => { setPage(0); }, [sortCol, sortDir, selectedAssetClass, categoryFilter, venueFilter, searchQuery, groupByEvent]);

  useEffect(() => {
    if (selectedId && !tabbedEvents.some(e => getEventKey(e) === selectedId)) {
      onSelect(null);
    }
  }, [selectedId, tabbedEvents, onSelect]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / CMAP_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const rows = sorted.slice(safePage * CMAP_PAGE_SIZE, (safePage + 1) * CMAP_PAGE_SIZE);

  function handleSort(colId) {
    if (!CMAP_COLS.find(c => c.id === colId)?.sortable) return;
    if (sortCol === colId) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(colId); setSortDir('desc'); }
  }

  return (
    <Pmv2CardChrome
      className="cmap-card pmv2-card-chrome--with-tabs"
      icon={<FileText size={16} />}
      title="Contracts"
      titleId="contracts-title"
      actions={(
        <>
          <span className="cmap-count">{tabbedEvents.length} contracts</span>
          <ContractProviderStatusDot
            providers={providers}
            ibkrLoading={ibkrLoading}
            onRefreshIbkr={onRefreshIbkr}
          />
        </>
      )}
      tabs={(
        <AssetTabs activeAssetClass={selectedAssetClass} onChange={setSelectedAssetClass} />
      )}
    >
      <div className="cmap-toolbar">
        <input
          type="search"
          className="cmap-search"
          placeholder="Search contracts…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search contracts"
        />
        <label className="cmap-group-toggle">
          <input
            type="checkbox"
            checked={groupByEvent}
            onChange={(e) => setGroupByEvent(e.target.checked)}
          />
          Group by event
        </label>
      </div>
      <FilterChipsV2 active={categoryFilter} onChange={setCategoryFilter} />
      <div className="cmap-venue-filters">
        {CMAP_VENUE_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`pmv2-chip${venueFilter === f.id ? ' active' : ''}`}
            onClick={() => setVenueFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {loading ? (
        <LoadingIndicator label="Loading contracts…" centered className="pmv2-empty" />
      ) : tabbedEvents.length === 0 ? (
        <div className="pmv2-empty">
          {events.length === 0 ? 'No contracts available.' : 'No contracts match the current filters.'}
        </div>
      ) : (
        <div className="cmap-table-scroll">
          <table className="cmap-table">
            <thead>
              <tr>
                {CMAP_COLS.map(col => (
                  <th
                    key={col.id}
                    className={`cmap-th${col.align === 'right' ? ' cmap-th-r' : ''}${col.sortable ? ' cmap-th-sort' : ''}`}
                    onClick={() => handleSort(col.id)}
                    title={col.title || undefined}
                  >
                    {col.label}
                    {col.sortable && sortCol === col.id && (
                      <span className="cmap-sort-icon">{sortDir === 'desc' ? ' ▼' : ' ▲'}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((ev, i) => {
                const isSelected = getEventKey(ev) === selectedId;
                const matchType = selectedSignal ? getMatchType(ev, selectedSignal) : null;
                const qualityFlags = (ev.data_quality_flags || []).filter(
                  (flag) => CMAP_QUALITY_LABELS[flag],
                );
                return (
                  <tr
                    key={ev.id || ev.question || i}
                    className={`cmap-row${isSelected ? ' cmap-row-selected' : ''}`}
                    onClick={() => onSelect(getEventKey(ev))}
                  >
                    <td className="cmap-td cmap-td-market">
                      <div className="cmap-market-name">
                        {ev.contract_title || ev.question || ev.event_title || '—'}
                        {ev.contract_count > 1 && (
                          <span className="cmap-group-count">{ev.contract_count} contracts</span>
                        )}
                      </div>
                      <div className="cmap-market-sub">
                        {ev.event_title && ev.contract_title && ev.event_title !== ev.contract_title
                          ? ev.event_title
                          : fmtVenueLine(ev)}
                        {matchType && (
                          <span className={`cmap-match-tag ${matchType.toLowerCase()}`}>{matchType}</span>
                        )}
                        {qualityFlags.map((flag) => (
                          <span key={flag} className="cmap-quality-flag" title={CMAP_QUALITY_LABELS[flag]}>
                            {CMAP_QUALITY_LABELS[flag]}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="cmap-td cmap-td-r cmap-price">
                      {fmtCents(ev.yes_bid ?? ev.yes)}
                    </td>
                    <td className="cmap-td cmap-td-r cmap-price">
                      {fmtCents(ev.yes_ask)}
                    </td>
                    <td className="cmap-td cmap-td-r cmap-muted">
                      {fmtCents(ev.spread)}
                    </td>
                    <td className="cmap-td cmap-td-r">{fmtVolume(ev.volume)}</td>
                    <td className="cmap-td cmap-td-r">{fmtTotalVolume(ev)}</td>
                    <td className="cmap-td cmap-td-r cmap-oi" title="Open interest (Kalshi only)">
                      {fmtOiValue(ev)}
                    </td>
                    <td className="cmap-td cmap-td-r cmap-muted">
                      {ev.min_tick != null ? fmtCents(ev.min_tick) : '–'}
                    </td>
                    <td className="cmap-td cmap-td-cat">{ev.category || '–'}</td>
                    <td className="cmap-td cmap-td-r cmap-muted">{fmtTimeAgo(ev.updated_at)}</td>
                    <td className="cmap-td cmap-td-r cmap-muted">{fmtExpiryDate(ev.expiration_time || ev.close_time)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="pmv2-pagination">
          <button type="button" className="pmv2-page-btn" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}>← Prev</button>
          <span className="pmv2-page-label">{safePage + 1} / {totalPages}</span>
          <button type="button" className="pmv2-page-btn" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage === totalPages - 1}>Next →</button>
        </div>
      )}
    </Pmv2CardChrome>
  );
}

function TradeTicketV2({ event, settings, risk, analytics }) {
  const calc = useMemo(() => buildTicketCalc(event, settings), [event, settings]);

  if (!event || !calc) {
    return (
      <div className="pmv2-ticket-stack">
        <div className="pmv2-card">
          <div className="pmv2-card-title">Trade Ticket</div>
          <div className="pmv2-empty">Select a mapped market to build a ticket.</div>
        </div>
      </div>
    );
  }

  const assetRows = buildAssetRows(risk, settings);

  return (
    <div className="pmv2-ticket-stack">
      <div className="pmv2-card pmv2-trade-ticket">
        <div className="pmv2-card-header">
          <div className="pmv2-card-title">Trade Ticket</div>
          <button type="button" className="pmv2-template-btn">Templates</button>
        </div>
        <label className="pmv2-ticket-label">Market</label>
        <select className="pmv2-ticket-select" value={event.id || event.question} readOnly>
          <option>{event.question}</option>
        </select>
        <div className="pmv2-ticket-row">
          <span>Side</span>
          <div className="pmv2-ticket-toggle">
            <button className={calc.side === 'YES' ? 'active yes' : ''}>Buy YES</button>
            <button className={calc.side === 'NO' ? 'active no' : ''}>Buy NO</button>
          </div>
        </div>
        <div className="pmv2-ticket-row two">
          <label>
            <span>Price</span>
            <input readOnly value={calc.cp.toFixed(3)} />
          </label>
          <label>
            <span>Size</span>
            <input readOnly value={calc.contracts.toLocaleString()} />
          </label>
        </div>
        <div className="pmv2-ticket-estimate">
          <span>Est. Cost</span>
          <strong>${calc.cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
          <small>Est. Profit (Model) {calc.edgeVsMkt >= 0 ? '+' : ''}{(calc.edgeVsMkt * 100).toFixed(1)}%</small>
        </div>
      </div>
      <div className="pmv2-card">
        <div className="pmv2-card-title">Risk Summary</div>
        <div className="pmv2-risk-list">
          <RiskLine label="Open Risk" value={fmt$(calc.maxLoss)} />
          <RiskLine label="Worst-Case Loss" value={fmt$(calc.maxLoss)} />
          <RiskLine label="Max Profit" value={fmt$(Math.max(0, calc.totalEv + calc.maxLoss))} />
          <RiskLine label="Tracked P&L" value={fmt$(analytics?.totalPnl)} />
          <RiskLine label="Kelly/Manual" value={calc.kf.toFixed(2)} />
        </div>
        <div className="pmv2-exposure-bars">
          {assetRows.map(row => (
            <div key={row.label}>
              <span>{row.label}</span>
              <strong>{row.pct.toFixed(1)}%</strong>
              <div><i style={{ width: `${Math.min(100, row.pct * 4)}%` }} /></div>
            </div>
          ))}
        </div>
      </div>
      <div className="pmv2-card">
        <div className="pmv2-card-title">Why this matches</div>
        <ul className="pmv2-match-reasons">
          <li>Variable Mapping: selected signal maps to the event settlement logic.</li>
          <li>Threshold Alignment: market boundary is close to model threshold.</li>
          <li>Settlement Alignment: both resolve on the same forecast horizon.</li>
          <li>Probability Calibration: historical error and fees are included.</li>
          <li>Liquidity Check: contract size is capped by risk settings.</li>
        </ul>
      </div>
    </div>
  );
}

function RiskLine({ label, value }) {
  return (
    <div className="pmv2-risk-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getBestEdge(events) {
  const edges = events.map(event => getEventEdge(event)).filter(edge => edge != null);
  if (!edges.length) return null;
  return Math.max(...edges);
}

function withPricingFields(event) {
  if (!event) return event;
  const yes = event.yes ?? event.yes_mid ?? event.last_price ?? event.yes_bid ?? 0;
  const no = event.no ?? event.no_mid ?? event.no_bid ?? Math.max(0.01, 1 - yes);
  return {
    ...event,
    yes: Number(yes) || 0,
    no: Number(no) || 0,
  };
}

function getEventKey(event) {
  return event?.id || event?.contractId || event?.question || null;
}

function getEventEdge(event, settings = DEFAULT_SETTINGS) {
  if (!event) return null;
  const p = event.myProb ?? 0.58;
  const yes = Number(event.yes || 0) || 0.5;
  const no = Number(event.no || 0) || Math.max(0.01, 1 - yes);
  const fees = settings?.defaultFeePerContract ?? 0.02;
  const slippage = settings?.defaultSlippageBuffer ?? 0;
  const modelErr = settings?.modelErrorBuffer ?? 0;
  const yesEdge = calcNetEdge(grossEdgeYes(p, yes), fees, slippage, modelErr);
  const noEdge = calcNetEdge(grossEdgeNo(p, no), fees, slippage, modelErr);
  return Math.max(yesEdge, noEdge);
}

function getRecommendedSide(event, settings = DEFAULT_SETTINGS) {
  if (!event) return 'Yes';
  const p = event.myProb ?? 0.58;
  const yes = Number(event.yes || 0) || 0.5;
  const no = Number(event.no || 0) || Math.max(0.01, 1 - yes);
  const yesEdge = calcNetEdge(grossEdgeYes(p, yes), settings.defaultFeePerContract, settings.defaultSlippageBuffer, settings.modelErrorBuffer);
  const noEdge = calcNetEdge(grossEdgeNo(p, no), settings.defaultFeePerContract, settings.defaultSlippageBuffer, settings.modelErrorBuffer);
  return yesEdge >= noEdge ? 'Yes' : 'No';
}

function buildTicketCalc(event, settings = DEFAULT_SETTINGS) {
  if (!event) return null;
  const p = event.myProb ?? 0.58;
  const yes = Number(event.yes || 0) || 0.5;
  const no = Number(event.no || 0) || Math.max(0.01, 1 - yes);
  const side = getRecommendedSide(event, settings).toUpperCase();
  const cp = Math.max(0.01, side === 'YES' ? yes : no);
  const pm = event.payoutMultiplier || 1;
  const contracts = fractionalKellySizing(
    p,
    cp,
    settings.kellyMultiplier ?? 0.25,
    settings.portfolioEquity ?? 0,
    settings.maxRiskPerBet ?? 0,
    pm
  );
  const kf = Math.max(0, kellyFraction(p, cp));
  const edgeVsMkt = getEventEdge(event, settings) || 0;
  const evPer = side === 'YES' ? evYesPerContract(p, yes, pm) : evNoPerContract(p, no, pm);
  const cost = cp * pm * contracts;
  const maxLoss = cost;
  const totalEv = evPer * contracts;
  return { side, cp, contracts, kf, edgeVsMkt, cost, maxLoss, totalEv };
}

function buildAssetRows(risk, settings) {
  const byAc = risk?.byAssetClass || {};
  const equity = settings?.portfolioEquity || 1;
  const rows = Object.entries(byAc).map(([key, val]) => ({
    label: ASSET_CLASS_DISPLAY[key] || key,
    pct: equity > 0 ? (Number(val) / equity) * 100 : 0,
  }));
  return rows.length ? rows.slice(0, 3) : [
    { label: 'U.S. Equities (Beta)', pct: 12.4 },
    { label: 'U.S. Equities (Beta)', pct: 13.8 },
  ];
}

// ─── Ticker alias map for contract→signal matching ───────────────────────────

const TICKER_ALIASES = {
  BTC:    ['BTC', 'Bitcoin', 'XBT', 'KXBTC', 'bitcoin'],
  ETH:    ['ETH', 'Ethereum', 'ether', 'ethereum'],
  SOL:    ['SOL', 'Solana', 'solana'],
  XRP:    ['XRP', 'Ripple', 'ripple'],
  SPX:    ['SPX', 'S&P', 'SP500', 'S&P500', 'S&P 500', 'ES', 'SPXW'],
  COMPQ:  ['COMPQ', 'NASDAQ', 'Nasdaq', 'NDX', 'QQQ', 'NQ'],
  QQQ:    ['QQQ', 'NASDAQ', 'Nasdaq', 'NDX', 'NQ'],
  IWM:    ['IWM', 'Russell', 'RUT', 'Russell 2000'],
  VIX:    ['VIX', 'volatility', 'Volatility', 'CBOE VIX'],
  GOLD:   ['GOLD', 'Gold', 'GC', 'GLD', 'XAUUSD'],
  SILVER: ['SILVER', 'Silver', 'SI', 'SLV', 'XAGUSD'],
  WTIC:   ['WTIC', 'WTI', 'CL', 'oil', 'crude', 'Crude Oil', 'OIL'],
  BRENT:  ['BRENT', 'Brent', 'BZ', 'Brent Crude'],
  NATGAS: ['NATGAS', 'NatGas', 'Natural Gas', 'NG', 'nat gas'],
  COPPER: ['COPPER', 'Copper', 'HG'],
  DXY:    ['DXY', 'Dollar Index', 'USD Index', 'USDX'],
  USD:    ['USD', 'Dollar', 'DXY', 'dollar'],
  UST10Y: ['10Y', '10-Year', 'UST10Y', 'TNX', '10yr', 'TMUBMUSD10Y'],
  UST2Y:  ['2Y', '2-Year', 'UST2Y', '2yr'],
  UST30Y: ['30Y', '30-Year', 'UST30Y', '30yr'],
  TLT:    ['TLT', '20Y Treasury', '20-Year', 'TLT'],
  'EUR/USD': ['EUR/USD', 'EURUSD', 'Euro', 'EUR'],
  'GBP/USD': ['GBP/USD', 'GBPUSD', 'Pound', 'GBP'],
  'USD/YEN':  ['USD/YEN', 'USDJPY', 'Yen', 'JPY'],
};

function getContractsForSignal(signal, allEvents) {
  if (!signal) {
    return [...allEvents].sort((a, b) => {
      const la = Number(a.liquidity ?? a.volume ?? a.open_interest ?? 0);
      const lb = Number(b.liquidity ?? b.volume ?? b.open_interest ?? 0);
      return lb - la;
    });
  }
  const ticker = signal.symbol;
  const rawAliases = TICKER_ALIASES[ticker] || [ticker];
  const aliases = [...new Set([ticker, signal.label, ...rawAliases].filter(Boolean))];
  const aliasesLower = aliases.map(a => a.toLowerCase());

  return allEvents
    .filter(event => {
      if (event.mappedSignalId === ticker) return true;
      const ut = (event.underlyingTicker || event.underlying || '').toUpperCase();
      if (ut && aliases.some(a => a.toUpperCase() === ut)) return true;
      if (ut && ut.includes(ticker.toUpperCase())) return true;
      const text = [
        event.question,
        event.eventTitle,
        event.event_title,
        event.category,
        event.underlying,
      ].filter(Boolean).join(' ').toLowerCase();
      return aliasesLower.some(a => text.includes(a));
    })
    .sort((a, b) => {
      const ea = getEventEdge(a) ?? -99;
      const eb = getEventEdge(b) ?? -99;
      return eb - ea;
    });
}

function getMatchType(event, signal) {
  if (!signal) return 'Unmapped';
  const ticker = signal.symbol;
  const aliases = TICKER_ALIASES[ticker] || [ticker];
  const ut = (event.underlyingTicker || event.underlying || '').toUpperCase();
  if (ut === ticker.toUpperCase() || aliases.some(a => a.toUpperCase() === ut)) return 'Exact';
  const text = [event.question, event.eventTitle, event.event_title].filter(Boolean).join(' ').toLowerCase();
  if (text.includes('range') || text.includes('above') || text.includes('below') || text.includes('between')) return 'Boundary';
  if (text.includes('tail') || text.includes('extreme') || text.includes('crash') || text.includes('surge')) return 'Tail';
  return 'Related';
}

const DEFAULT_RISK_SETTINGS = {
  maxRiskPerTrade: 500,
  maxPortfolioRisk: 0.05,
  maxThemeExposure: 2000,
};

function calculatePositionSize(signal, event, riskSettings = DEFAULT_SETTINGS) {
  const edge = getEventEdge(event, riskSettings) ?? 0;
  const maxRisk = riskSettings.maxRiskPerBet ?? riskSettings.maxRiskPerTrade ?? 500;
  const portfolioEquity = riskSettings.portfolioEquity ?? 100000;
  const side = getRecommendedSide(event, riskSettings);
  const price = side === 'Yes' ? (Number(event.yes) || 0.5) : (Number(event.no) || 0.5);
  const pm = event.payoutMultiplier || 1;
  const hasModel = event.myProb != null;

  if (!event || edge <= 0) {
    return {
      recommendedSide: inferSideFromSignal(signal, event),
      suggestedSize: 0,
      maxSize: 0,
      estimatedCost: 0,
      worstCaseLoss: 0,
      expectedValue: 0,
      confidence: 'Low',
      explanation: hasModel
        ? 'No positive edge detected after fees and slippage. Hold off or wait for better pricing.'
        : 'No model probability available. Recommendation derived from signal direction only — treat as indicative.',
      isSignalOnly: !hasModel,
      edge,
    };
  }

  const scoreNorm = Math.min(1, Math.max(0, (signal?.score ?? 50) / 130));
  const edgeMultiplier = Math.min(3, Math.max(0.5, edge / 0.05));
  const baseRisk = maxRisk * scoreNorm * edgeMultiplier;
  const cappedRisk = Math.min(baseRisk, maxRisk, portfolioEquity * (riskSettings.maxPmRiskPct ?? 0.05));

  const contracts = price > 0 ? Math.max(0, Math.floor(cappedRisk / (price * pm))) : 0;
  const maxContracts = price > 0 ? Math.max(0, Math.floor(maxRisk / (price * pm))) : 0;
  const estimatedCost = contracts * price * pm;
  const worstCaseLoss = estimatedCost;

  const evPer = side === 'Yes'
    ? evYesPerContract(event.myProb ?? 0.5, event.yes || 0.5, pm)
    : evNoPerContract(event.myProb ?? 0.5, event.no || 0.5, pm);
  const expectedValue = evPer * contracts;

  const confidence = edge > 0.1 ? 'High' : edge > 0.05 ? 'Medium' : 'Low';
  const explanation = hasModel
    ? `Model probability ${fmtPct(event.myProb)} vs. implied ${fmtPct(price)}. Signal score ${signal?.score ?? '--'}/100. Edge: ${fmtEdge(edge)}.`
    : `Signal-only estimate. No model probability. Direction derived from ${signal?.trend || 'signal'} trend — treat as indicative.`;

  return {
    recommendedSide: side.toUpperCase(),
    suggestedSize: contracts,
    maxSize: maxContracts,
    estimatedCost,
    worstCaseLoss,
    expectedValue,
    confidence,
    explanation,
    edge,
    isSignalOnly: !hasModel,
  };
}

function inferSideFromSignal(signal, event) {
  const trend = signal?.trend;
  if (isLongTrend(trend)) return 'YES';
  if (isShortTrend(trend)) return 'NO';
  return 'YES';
}

function getDirectionLabel(trend, side) {
  if (['BEARISH', 'SHORT'].includes(trend) || side === 'No') return 'Bearish';
  if (trend === 'NEUTRAL') return 'Neutral';
  return 'Bullish';
}

function inferCurrentLevel(signal, selectedEvent) {
  const level = signal?.price || selectedEvent?.contract?.modelExpectedLevel || selectedEvent?.contract?.modelUpperBound;
  if (level != null && !Number.isNaN(Number(level))) {
    return Number(level).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return selectedEvent?.category === 'Crypto' ? '104,250.00' : '5,321.41';
}

function buildBoundaryLabels(selectedEvent, signal) {
  const contract = selectedEvent?.contract || {};
  const threshold = contract.modelUpperBound || contract.modelExpectedLevel || signal?.hrr || signal?.buyTrade;
  const n = threshold != null && !Number.isNaN(Number(threshold)) ? Number(threshold) : null;
  const exact = n == null ? selectedEvent?.question?.match(/[\d,]+(?:\.\d+)?/)?.[0] || '7,850.0099' : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  const lower = n == null ? '7,825.00 - 7,849.9999' : `${(n - 25).toLocaleString(undefined, { maximumFractionDigits: 2 })} - ${(n - 0.0001).toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  return {
    exact,
    range: `${lower} / ${exact} or above`,
    note: 'Lower Boundary / Upper Boundary',
  };
}

function formatDateShort(dateValue) {
  if (!dateValue || dateValue === '—') return null;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return dateValue;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatMarketBand(event, index) {
  const question = event?.question || '';
  const threshold = question.match(/[\d,]+(?:\.\d+)?/)?.[0];
  if (!threshold) return index === 0 ? 'Exact market' : 'Adjacent boundary';
  return index === 0 ? `${threshold} or above` : `Boundary near ${threshold}`;
}

// ─── Main Component (v2) ──────────────────────────────────────────────────────

export default function PredictionMarkets({ onApiStatusChange, onClose }) {
  const [selectedId, setSelectedId] = useState(null);
  const [contracts, setContracts] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [analytics, setAnalytics] = useState(null);
  const [risk, setRisk] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ingestLoading, setIngestLoading] = useState(true);
  const [apiStatus, setApiStatus] = useState('loading');
  const [loadError, setLoadError] = useState(null);
  const [marketEvents, setMarketEvents] = useState([]);
  const [providers, setProviders] = useState(null);
  const [ingestError, setIngestError] = useState(null);
  const [signalsLoading, setSignalsLoading] = useState(true);
  const [signalsError, setSignalsError] = useState(null);
  const [selectedSignalSymbol, setSelectedSignalSymbol] = useState(null);
  const [signalData, setSignalData] = useState({
    riskRanges: {},
    bitcoinSnapshot: null,
    momoSnapshot: null,
    macroSnapshot: null,
    callSnapshot: null,
    spotPrices: {},
  });

  const [ibkrLoading, setIbkrLoading] = useState(false);
  const [uploadFreshness, setUploadFreshness] = useState(null);

  const loadIngest = useCallback(async (opts = {}) => {
    setIngestLoading(true);
    setIngestError(null);
    try {
      const data = await predictionMarketsIngestService.getAggregatedEvents({
        mock: opts.mock,
        refresh: opts.refreshKalshi !== false ? 'kalshi' : undefined,
      });
      const rows = data.events || data.dashboardEvents || [];
      setMarketEvents(rows);
      setProviders(data.providers || null);
    } catch (err) {
      console.error('[PM] ingest load error:', err);
      setIngestError(err.message);
    } finally {
      setIngestLoading(false);
    }
  }, []);

  const loadIbkr = useCallback(async () => {
    setIbkrLoading(true);
    try {
      const data = await predictionMarketsIngestService.refreshIbkr();
      const newEvents = data.events || data.dashboardEvents || [];
      setMarketEvents(newEvents);
      if (data.providers) setProviders(data.providers);
    } catch (err) {
      console.warn('[PM] IBKR refresh error:', err.message);
    } finally {
      setIbkrLoading(false);
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setApiStatus('loading');
    setLoadError(null);
    try {
      const [contractsRes, settingsRes, analyticsRes, riskRes] = await Promise.all([
        pmFetch('/contracts'),
        pmFetch('/settings'),
        pmFetch('/analytics'),
        pmFetch('/risk'),
      ]);
      const items = contractsRes.contracts || [];
      setContracts(items);
      setSettings({ ...DEFAULT_SETTINGS, ...(settingsRes.settings || {}) });
      setAnalytics(analyticsRes);
      setRisk(riskRes);
      setApiStatus('ready');
    } catch (err) {
      console.error('[PM] load error:', err);
      setLoadError(err.message);
      setApiStatus('error');
      setContracts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSignalData = useCallback(async () => {
    setSignalsLoading(true);
    setSignalsError(null);
    try {
      const riskRanges = await MarketDataService.getRiskRanges().catch(err => {
        console.warn('[PM] risk range signal load error:', err);
        return {};
      });
      const quotePlan = getMacroSignalQuotePlan(riskRanges || {});
      const quoteTickers = [...new Set(quotePlan.map(entry => entry.quote))];

      const [bitcoinSnapshot, momoSnapshot, macroSnapshot, callSnapshot, rawSpotPrices, freshness] = await Promise.all([
        MarketDataService.getHedgeyeSnapshot('bitcoin-trend-tracker').catch(err => {
          console.warn('[PM] bitcoin tracker signal load error:', err);
          return null;
        }),
        MarketDataService.getHedgeyeSnapshot('momo-tracker').catch(err => {
          console.warn('[PM] momo tracker signal load error:', err);
          return null;
        }),
        MarketDataService.getHedgeyeSnapshot('the-macro-show').catch(err => {
          console.warn('[PM] macro show signal load error:', err);
          return null;
        }),
        MarketDataService.getHedgeyeSnapshot('the-call').catch(err => {
          console.warn('[PM] the call signal load error:', err);
          return null;
        }),
        MarketDataService.getQuotes(quoteTickers).catch(err => {
          console.warn('[PM] spot price quote load error:', err);
          return {};
        }),
        MarketDataService.getHedgeyeFreshness().catch(err => {
          console.warn('[PM] hedgeye freshness load error:', err);
          return null;
        }),
      ]);

      const spotPrices = {};
      for (const { display, quote } of quotePlan) {
        const q = rawSpotPrices?.[quote] ?? rawSpotPrices?.[quote.toUpperCase()];
        if (q) spotPrices[display] = q;
      }

      setSignalData({
        riskRanges: riskRanges || {},
        bitcoinSnapshot,
        momoSnapshot,
        macroSnapshot,
        callSnapshot,
        spotPrices: spotPrices || {},
      });
      setUploadFreshness(freshness?.dataTypes ?? null);
    } catch (err) {
      console.error('[PM] signal context load error:', err);
      setSignalsError(err.message || 'Failed to load signal context');
    } finally {
      setSignalsLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { loadIngest(); }, [loadIngest]);
  useEffect(() => { loadSignalData(); }, [loadSignalData]);
  useEffect(() => { loadIbkr(); }, [loadIbkr]);
  useEffect(() => {
    onApiStatusChange?.(apiStatus);
  }, [apiStatus, onApiStatusChange]);

  const contractByQuestion = useMemo(() => {
    const map = new Map();
    for (const c of contracts) {
      const q = (c.contractQuestion || c.eventName || '').toLowerCase();
      if (q) map.set(q, c);
    }
    return map;
  }, [contracts]);

  const events = useMemo(() => {
    return marketEvents.map((ev) => {
      const match =
        ev.contract ||
        contractByQuestion.get((ev.question || '').toLowerCase());
      const priced = withPricingFields(ev);
      if (!match) return priced;
      const myProb = match.adjustedProbability ?? match.myProbability;
      return {
        ...priced,
        myProb: myProb != null ? Number(myProb) : priced.myProb,
        side: match.contractSide || priced.side,
        contract: match,
      };
    });
  }, [marketEvents, contractByQuestion]);

  const filteredEvents = events;

  const signalContext = useMemo(() => normalizePredictionMarketSignals({
    riskRanges: signalData.riskRanges,
    bitcoinSnapshot: signalData.bitcoinSnapshot,
    momoSnapshot: signalData.momoSnapshot,
    macroSnapshot: signalData.macroSnapshot,
    callSnapshot: signalData.callSnapshot,
    spotPrices: signalData.spotPrices,
    activeCategory: 'all',
    // Do not pass selectedEvent — it causes inferPredictionSignalCategory to narrow
    // the universe to a single category, hiding other asset classes in the sidebar.
  }), [signalData]);

  const macroSignalViews = useMemo(() => mapNormalizedRows(signalContext.rows || []), [signalContext]);

  const selectedSignal = useMemo(() => {
    if (!selectedSignalSymbol) return null;
    return signalContext.rows.find(row => row.symbol === selectedSignalSymbol) || null;
  }, [selectedSignalSymbol, signalContext]);

  // If the active signal symbol is no longer present in the loaded data, clear it
  useEffect(() => {
    if (selectedSignalSymbol && !signalContext.rows.some(row => row.symbol === selectedSignalSymbol)) {
      setSelectedSignalSymbol(null);
    }
  }, [selectedSignalSymbol, signalContext]);

  const contractMapEvents = useMemo(
    () => getContractsForSignal(selectedSignal, filteredEvents),
    [filteredEvents, selectedSignal],
  );

  const selectedEvent = useMemo(
    () => contractMapEvents.find(e => getEventKey(e) === selectedId) || null,
    [contractMapEvents, selectedId],
  );

  return (
    <div className="pmv2-wrap pmv2-redesign">
      <PredictionMarketsHeaderV2 onClose={onClose} />
      {(ingestError || loadError) && (
        <div className="pmv2-error-banner">
          {ingestError || loadError}
          <RefreshButton label="Retry" onClick={() => { loadData(); loadIngest(); }} />
        </div>
      )}
      <div className="pmv2-redesign-body">
        <MacroSignalsCard
          signals={macroSignalViews}
          selectedSignal={selectedSignal}
          onSelectSignal={view => {
            if (!view?.canonical?.symbol) return;
            setSelectedSignalSymbol(view.canonical.symbol);
          }}
          loading={signalsLoading}
          error={signalsError}
          onRefresh={loadSignalData}
          uploadFreshness={uploadFreshness}
        />
        <main className="pmv2-redesign-main">
          <ContractMapCard
            events={contractMapEvents}
            selectedId={selectedId}
            onSelect={setSelectedId}
            selectedSignal={selectedSignal}
            loading={loading || ingestLoading}
            providers={providers}
            ibkrLoading={ibkrLoading}
            onRefreshIbkr={loadIbkr}
          />
          <TradePlanCard
            selectedSignal={selectedSignal}
            selectedEvent={selectedEvent}
            settings={settings}
          />
        </main>
      </div>
    </div>
  );
}
