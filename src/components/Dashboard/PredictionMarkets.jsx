import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Activity, FileText } from 'lucide-react';
import './PredictionMarkets.css';
import { MarketDataService } from '../../services/api/marketDataService';
import predictionMarketsIngestService from '../../services/api/predictionMarketsIngestService';
import {
  getMacroSignalQuotePlan,
  normalizePredictionMarketSignals,
} from '../../utils/predictionMarketSignals';
import { SECURITY_INTELLIGENCE_V2_ENABLED } from '../../hooks/useSecurityIntelligence';
import {
  buildCanonicalRiskRangeMap,
  buildCanonicalTrackerSnapshot,
} from '../../utils/securityIntelligenceV2';
import { isTreasuryYieldSymbol } from '../../utils/treasuryYieldScale';
import {
  MacroSignalsCard,
  mapNormalizedRows,
  AssetTabs,
  DEFAULT_ASSET_CLASS,
  inferEventMacroAssetClass,
  isCpiMacroEvent,
} from './macroSignals';
import { SecuritiesUniverseMetricsTable } from './securitiesUniverse/index';
import useEnrichedSecurity from '../../hooks/useEnrichedSecurity';
import RefreshButton from '../common/RefreshButton';
import LoadingIndicator from '../common/LoadingIndicator';
import StatusDot from '../common/StatusDot';
import Pmv2CardChrome from './Pmv2CardChrome';
import contractsArmWrestleIcon from '../../assets/contracts-arm-wrestle.png';
import payoutMapTreasureIcon from '../../assets/payout-map-treasure.png';
import {
  filterContractMapEvents,
  groupContractMapByEvent,
} from '../../utils/contractMapFilters';
import {
  buildCpiContractLadder,
  isCpiContractForMonth,
  normalizeCpiNowcast,
  summarizeCpiPositions,
} from '../../utils/cpiPredictionMarket';
import {
  buildCpiAllocationModel,
  buildCpiCalibratedProbabilityCurve,
  calculateKalshiTakerFee,
} from '../../utils/cpiAllocationModel';
import authoritativeIbkrCpiContract from '../../utils/authoritativeIbkrCpiContract.cjs';
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

async function loadCanonicalSecurityUniverse() {
  const bySymbol = {};
  let cursor = null;
  let firstPage = null;
  do {
    const page = await MarketDataService.getSecurityIntelligenceUniverseV2({
      limit: 200,
      cursor,
    });
    if (page?.schemaVersion !== 2) {
      throw new Error('Canonical security universe returned an unsupported schema.');
    }
    firstPage = firstPage || page;
    Object.assign(bySymbol, page.bySymbol || {});
    cursor = page.page?.nextCursor || null;
  } while (cursor);
  return {
    ...(firstPage || { schemaVersion: 2, marketDate: null, bySymbol: {} }),
    bySymbol,
    page: null,
  };
}

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
  portfolioEquity: null, minNetEdge: 0.02, defaultFeePerContract: 0.02, defaultSlippageBuffer: 0.005,
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
        <div style={{ background: '#fef2f2', border: '1px solid #dc2626', borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}>
          {formErrors.map((e, i) => <div key={i} style={{ fontSize: 12, color: '#dc2626' }}>• {e}</div>)}
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
                  <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: '#ecfdf5', border: '1px solid #059669' }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#059669' }}>
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
                    <div>Max Profit:</div><div style={{ fontWeight: 700, color: '#059669' }}>{fmt$(calc.mp)}</div>
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
            {saveStatus && <div style={{ fontSize: 12, color: '#059669', textAlign: 'center' }}>{saveStatus}</div>}
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
                <td style={{ color: '#059669' }}>{fmt$(mp)}</td>
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
              {saveMsg && <span style={{ fontSize: 12, color: '#059669' }}>{saveMsg}</span>}
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
        {saveMsg && <span style={{ fontSize: 12, color: '#059669' }}>{saveMsg}</span>}
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
  open_position: 'Held',
  missing_market_value: 'No MV',
  wide_spread: 'Wide spread',
  thin_liquidity: 'Thin',
  stale_quote: 'Stale',
  missing_settlement_source: 'No settlement',
  not_tradable_in_ibkr: 'Not in IBKR',
};

const PROVIDER_STATUS_LABEL = {
  connected: 'Connected',
  connected_live: 'Live',
  connected_no_quotes: 'No live quotes',
  connected_catalog_incomplete: 'Catalog incomplete',
  connected_no_contracts: 'No contracts',
  connected_positions_only: 'Positions loaded',
  gateway_half_connected: 'Gateway half-connected',
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
const { isAuthoritativeIbkrCpiContract } = authoritativeIbkrCpiContract;

function isIbkrWorkbenchEvent(event) {
  if (event?.source_api === 'kalshi_trade_api_v2' && event?.venue === 'Kalshi') return true;
  return isAuthoritativeIbkrCpiContract(event);
}

function filterIbkrWorkbenchEvents(events = []) {
  return (events || []).filter(isIbkrWorkbenchEvent);
}

const CAT_COLORS = {
  Index:       { bg: '#e0f2fe', text: '#0369a1' },
  Equities:    { bg: '#e0f2fe', text: '#0369a1' },
  'Equity Index': { bg: '#e0f2fe', text: '#0369a1' },
  Rates:       { bg: '#ecfdf5', text: '#059669' },
  Inflation:   { bg: '#fef9c3', text: '#92400e' },
  Labor:       { bg: '#fce7f3', text: '#9d174d' },
  Growth:      { bg: '#ecfdf5', text: '#059669' },
  Credit:      { bg: '#e5e7eb', text: '#374151' },
  FX:          { bg: '#ede9fe', text: '#6d28d9' },
  Commodities: { bg: '#ffedd5', text: '#9a3412' },
  Crypto:      { bg: '#fce7f3', text: '#9d174d' },
  'Other Macro': { bg: '#f3f4f6', text: '#374151' },
};

const STATUS_STYLE = {
  planned:   { bg: '#fef3c7', text: '#92400e' },
  open:      { bg: '#ecfdf5', text: '#059669' },
  watchlist: { bg: '#f3f4f6', text: '#6b7280' },
  settled:   { bg: '#ede9fe', text: '#6d28d9' },
  closed:    { bg: '#fef2f2', text: '#dc2626' },
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
    <span style={{ background: side === 'Yes' ? '#ecfdf5' : '#fef2f2', color: side === 'Yes' ? '#059669' : '#dc2626', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 }}>
      {side}
    </span>
  );
}

// ─── V2 Header ────────────────────────────────────────────────────────────────

function ProviderStatusBar({ providers, onRefreshIbkr, ibkrRefreshing, lastIbkrUpdate }) {
  if (!providers) return null;
  const ibkr = providers.ibkr || {};
  const kalshi = providers.kalshi || {};
  const kalshiLive = kalshi.display_ready === true || kalshi.status === 'connected_live';
  const ibkrClass = ibkr.execution_ready === true || ibkr.status === 'connected_live'
    ? 'ready'
    : (ibkr.gateway_connected === true || ibkr.gateway?.ok === true || ibkr.status === 'connected')
      ? 'warn'
      : 'error';

  return (
    <div className="pmv2-provider-bar">
      <div className="pmv2-provider-items">
        <span className="pmv2-provider-item">
          <span className={`pmv2-status-dot ${kalshiLive ? 'ready' : 'warn'}`} />
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

      {reviewOpen && createPortal(
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
        </div>,
        document.body,
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

function providerSourceStatus(status) {
  if (['connected', 'connected_live'].includes(status)) return 'current';
  if (status === 'gateway_half_connected') return 'stale';
  if ([
    'connected_no_contracts',
    'connected_positions_only',
    'connected_no_quotes',
    'connected_catalog_incomplete',
    'gateway_offline',
    'sidecar_offline',
    'tws_offline',
    'auth_required',
    'unknown',
    'stale',
  ].includes(status)) {
    return 'stale';
  }
  return 'defective';
}

function getCpiProviderDiscovery(providers = {}) {
  const ibkr = providers?.ibkr || providers || {};
  return ibkr.cpi_discovery || ibkr.cpiDiscovery || {};
}

function getCpiContractsTotal(providers = {}) {
  const ibkr = providers?.ibkr || providers || {};
  const cpiDiscovery = getCpiProviderDiscovery(providers);
  return ibkr.contracts_total ?? ibkr.contractsTotal ?? cpiDiscovery.contracts_total ?? cpiDiscovery.contractsTotal ?? null;
}

function hasCompleteIbkrCpiCatalog(providers = {}) {
  const ibkr = providers?.ibkr || {};
  const cpiDiscovery = getCpiProviderDiscovery(providers);
  const targetStrikes = cpiDiscovery.targetStrikes || [];
  const missingStrikes = cpiDiscovery.missingStrikes || [];
  const contractsTotal = getCpiContractsTotal(providers);
  const portfolioSeedCount = ibkr.portfolio_seed_count ?? ibkr.portfolioSeedCount ?? 0;
  if (targetStrikes.length > 0 && missingStrikes.length > 0) return false;
  if (targetStrikes.length > 0 && Number(contractsTotal || 0) < targetStrikes.length) return false;
  if (Number(contractsTotal || 0) > 0 && Number(portfolioSeedCount || 0) >= Number(contractsTotal || 0)) return false;
  return true;
}

function deriveProviderAggregateStatus(providers) {
  const ibkr = providers?.ibkr || providers || {};
  if (isLiveIbkrProvider(providers?.ibkr ? providers : { ibkr })) return 'active';
  if (!ibkr?.status || ibkr.status === 'unknown') return 'inactive';
  return 'stale';
}

function deriveCpiProviderAggregateStatus(providers) {
  if (isLiveIbkrProvider(providers) || providers?.kalshi?.display_ready === true) return 'active';
  return deriveProviderAggregateStatus(providers);
}

function isConnectedIbkrProvider(providers) {
  const ibkr = providers?.ibkr;
  return ibkr?.status === 'connected' && ibkr?.gateway?.ok === true;
}

function isReachableIbkrGatewayProvider(providers) {
  const ibkr = providers?.ibkr;
  return Boolean(ibkr?.gateway?.ok === true && [
    'connected',
    'connected_no_contracts',
    'connected_positions_only',
    'connected_catalog_incomplete',
  ].includes(ibkr?.status));
}

function isLiveIbkrProvider(providers) {
  return isConnectedIbkrProvider(providers)
    && providers?.ibkr?.execution_ready === true
    && hasCompleteIbkrCpiCatalog(providers);
}

function isLiveCpiContractProvider(providers) {
  return providers?.ibkr?.execution_ready === true
    || providers?.kalshi?.display_ready === true;
}

const NON_LIVE_TRADING_FLAGS = new Set([
  'stale_quote',
  'portfolio_seed',
  'portfolio_discovered',
  'catalog_missing',
  'mock',
  'fallback',
  'no_live_quote',
  'cached',
  'expired_contract',
  'wrong_release',
  'unknown_contract_side',
]);

function hasNonLiveTradingFlag(event) {
  return (event?.data_quality_flags || []).some((flag) => NON_LIVE_TRADING_FLAGS.has(flag));
}

function isLiveTradingEvent(event, nowMs = Date.now()) {
  if (!event || event.source_api === 'IBKR_PORTFOLIO' || event.heldPosition || hasNonLiveTradingFlag(event)) return false;
  if (!['IBKR_TWS_API', 'IBKR_CPAPI', 'kalshi_trade_api_v2'].includes(event.source_api)) return false;
  const status = String(event.status || 'open').toLowerCase();
  if (!['open', 'active'].includes(status)) return false;
  const rawExpiry = event.close_time || event.expiration_time || '';
  const compactExpiry = String(rawExpiry).match(/^(\d{4})(\d{2})(\d{2})/);
  const expiresAt = compactExpiry
    ? Date.parse(`${compactExpiry[1]}-${compactExpiry[2]}-${compactExpiry[3]}T23:59:59Z`)
    : Date.parse(rawExpiry);
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
  const updatedAt = Date.parse(event.updated_at || '');
  if (!Number.isFinite(updatedAt)) return false;
  const ageMs = nowMs - updatedAt;
  return ageMs >= -5000 && ageMs <= 120000;
}

function formatCpiDiagnosticStrikes(values = []) {
  if (!Array.isArray(values) || values.length === 0) return 'None';
  return values.map((value) => fmtCpiLevel(value, 1)).join(', ');
}

function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function formatCpiTiming(timing = {}) {
  if (!timing || typeof timing !== 'object') return null;
  const total = formatDurationMs(timing.express_total_ms ?? timing.total_ms);
  const phase = timing.phase ? String(timing.phase) : null;
  if (!total && !phase) return null;
  return `Last ${phase || 'IBKR'} phase${total ? `: ${total}` : ''}`;
}

function ContractProviderStatusDot({
  providers,
  strikeCount = 0,
  targetStrikeCount = 0,
  contractWarnings = [],
  ibkrLoading,
  ibkrDiscovering,
  onRefreshIbkr,
  onDiscoverIbkr,
  className = '',
}) {
  const ibkr = providers?.ibkr || {};
  const kalshi = providers?.kalshi || {};
  const cpiDiscovery = ibkr.cpi_discovery || ibkr.cpiDiscovery || kalshi.cpi_discovery || kalshi.cpiDiscovery || null;
  const contractsTotal = ibkr.contracts_total ?? ibkr.contractsTotal ?? cpiDiscovery?.contracts_total ?? cpiDiscovery?.contractsTotal;
  const contractsAdded = ibkr.contracts_added ?? ibkr.contractsAdded ?? cpiDiscovery?.contracts_added ?? cpiDiscovery?.contractsAdded;
  const lastSuccessAt = ibkr.last_success_at || ibkr.lastSuccessAt || cpiDiscovery?.last_success_at || null;
  const portfolioSeedCount = ibkr.portfolio_seed_count ?? ibkr.portfolioSeedCount ?? 0;
  const portfolioCpiPositions = ibkr.portfolio_cpi_positions ?? ibkr.portfolioCpiPositions ?? 0;
  const timingText = formatCpiTiming(ibkr.cpi_timing || ibkr.cpiTiming);
  const ibkrCatalogComplete = hasCompleteIbkrCpiCatalog(providers);

  const sources = useMemo(() => {
    const targetStrikes = cpiDiscovery?.targetStrikes || [];
    const foundStrikes = cpiDiscovery?.foundStrikes || [];
    const missingStrikes = cpiDiscovery?.missingStrikes || [];
    const displayTargetCount = targetStrikes.length || targetStrikeCount || strikeCount;
    const detailRows = [
      {
        text: `${strikeCount} of ${displayTargetCount} target strike${displayTargetCount === 1 ? '' : 's'} loaded`,
        acknowledgeable: false,
      },
      {
        text: `${targetStrikeCount || displayTargetCount} target strike${(targetStrikeCount || displayTargetCount) === 1 ? '' : 's'} shown`,
        acknowledgeable: false,
      },
      ...(lastSuccessAt ? [
        {
          text: `Last refreshed: ${fmtTimeAgo(lastSuccessAt)} ago`,
          acknowledgeable: false,
        },
      ] : []),
      ...(targetStrikes.length > 0 ? [
        {
          text: `Target strikes: ${formatCpiDiagnosticStrikes(targetStrikes)}`,
          acknowledgeable: false,
        },
        {
          text: `Found strikes: ${formatCpiDiagnosticStrikes(foundStrikes)}`,
          acknowledgeable: false,
        },
        {
          text: `Missing strikes: ${formatCpiDiagnosticStrikes(missingStrikes)}`,
          acknowledgeable: false,
        },
      ] : []),
      ...(contractsTotal != null ? [
        {
          text: `Discovered contracts: ${contractsTotal}${contractsAdded != null ? ` total, ${contractsAdded} added last run` : ''}`,
          acknowledgeable: false,
        },
      ] : []),
      ...(portfolioCpiPositions ? [
        {
          text: `${portfolioCpiPositions} held CPI position${portfolioCpiPositions === 1 ? '' : 's'} tracked separately`,
          acknowledgeable: false,
        },
      ] : []),
      ...(portfolioSeedCount ? [
        {
          text: `${portfolioSeedCount} portfolio-seeded contract${portfolioSeedCount === 1 ? '' : 's'} excluded from executable ladder`,
          acknowledgeable: false,
        },
      ] : []),
      ...(timingText ? [
        {
          text: timingText,
          acknowledgeable: false,
        },
      ] : []),
      ...[...new Set(contractWarnings.filter(Boolean))].map((warning) => ({
        text: warning,
        acknowledgeable: false,
      })),
    ];

    return [
      {
        id: 'ibkr',
        label: 'IBKR',
        detail: ibkr.message || PROVIDER_STATUS_LABEL[ibkr.status] || ibkr.status || 'Unknown',
        detailRows,
        status: ibkr.status === 'connected' && !ibkrCatalogComplete ? 'stale' : providerSourceStatus(ibkr.status),
        action: (
          <>
            {['connected_no_contracts', 'connected_positions_only'].includes(ibkr.status) && onDiscoverIbkr && (
              <RefreshButton
                iconOnly
                onClick={onDiscoverIbkr}
                loading={ibkrDiscovering}
                disabled={ibkrLoading || ibkrDiscovering}
                title="Discover IBKR event contracts"
                label="Discover IBKR"
              />
            )}
            <RefreshButton
              iconOnly
              onClick={onRefreshIbkr}
              loading={ibkrLoading}
              disabled={ibkrLoading || ibkrDiscovering}
              title="Refresh IBKR contracts"
              label="Refresh IBKR"
            />
          </>
        ),
      },
      ...(kalshi.status ? [{
        id: 'kalshi',
        label: 'Kalshi',
        detail: kalshi.message || PROVIDER_STATUS_LABEL[kalshi.status] || kalshi.status,
        detailRows: [
          ...(cpiDiscovery?.kalshiFoundStrikes?.length ? [{
            text: `Kalshi CPI strikes: ${formatCpiDiagnosticStrikes(cpiDiscovery.kalshiFoundStrikes)}`,
            acknowledgeable: false,
          }] : []),
        ],
        status: providerSourceStatus(kalshi.status),
      }] : []),
    ];
  }, [
    contractWarnings,
    strikeCount,
    targetStrikeCount,
    cpiDiscovery,
    contractsTotal,
    contractsAdded,
    lastSuccessAt,
    portfolioCpiPositions,
    portfolioSeedCount,
    timingText,
    ibkr.status,
    ibkr.message,
    ibkrCatalogComplete,
    kalshi.status,
    kalshi.message,
    ibkrLoading,
    ibkrDiscovering,
    onRefreshIbkr,
    onDiscoverIbkr,
  ]);

  return (
    <StatusDot
      status={deriveCpiProviderAggregateStatus(providers)}
      emoji="🟢"
      size={8}
      label="IBKR contract provider"
      overallLabel="IBKR contracts"
      sources={sources}
      align="right"
      className={className}
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
            {tradePlan?.unavailableLiveData ? (
              <div className="cpi-state cpi-state-compact tp-no-live-state">
                <strong>No live executable quote</strong>
                <span>{tradePlan.explanation}</span>
              </div>
            ) : tradePlan && (
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
            {tradePlan?.unavailableLiveData ? (
              <div className="cpi-state cpi-state-compact tp-no-live-state">
                <strong>Order fields disabled</strong>
                <span>Connect IB Gateway/TWS and refresh live contract quotes before entering an order.</span>
              </div>
            ) : (
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
            )}
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

function normalizeContractToken(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isPredictionMarketHolding(holding = {}) {
  if (holding.isPredictionMarket) return true;
  const secType = String(holding.secType || holding.assetType || '').toUpperCase();
  const text = [
    holding.symbol,
    holding.description,
    holding.localSymbol,
    holding.tradingClass,
  ].filter(Boolean).join(' ').toUpperCase();
  return (
    secType === 'EVENT' ||
    /\bKX[A-Z0-9]+\b/.test(text) ||
    /\bCPIY\b/.test(text) ||
    /(?:^|[-_ ])(?:YES|NO)(?:$|[-_ ])/.test(text)
  );
}

function getHeldPredictionMarketPositions(portfolioData) {
  return (portfolioData?.holdings || []).filter(
    (holding) => Number(holding.quantity || 0) !== 0 && isPredictionMarketHolding(holding),
  );
}

function dedupeHeldPredictionMarketPositions(positions = []) {
  const seen = new Set();
  const out = [];
  for (const holding of positions) {
    const key = [
      holding.accountId,
      holding.conid,
      holding.symbol,
      holding.description,
    ].map(normalizeContractToken).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(holding);
  }
  return out;
}

function getHoldingMatchTokens(holding = {}) {
  return [
    holding.conid,
    holding.conId,
    holding.symbol,
    holding.description,
    holding.localSymbol,
    holding.positionId,
  ]
    .map(normalizeContractToken)
    .filter(Boolean);
}

function getEventMatchTokens(event = {}) {
  return [
    event.conid,
    event.conId,
    event.ibkr_conid,
    event.ibkrConId,
    event.ibkr_contract?.conId,
    event.contract?.conId,
    event.contract?.conid,
    event.symbol,
    event.underlying,
    event.underlyingTicker,
    event.localSymbol,
    event.contract_title,
    event.event_title,
    event.question,
    event.id,
  ]
    .map(normalizeContractToken)
    .filter(Boolean);
}

function eventMatchesHeldPosition(event, holding) {
  const holdingTokens = getHoldingMatchTokens(holding);
  const eventTokens = getEventMatchTokens(event);
  return holdingTokens.some((holdingToken) =>
    eventTokens.some((eventToken) =>
      eventToken === holdingToken ||
      eventToken.includes(holdingToken) ||
      holdingToken.includes(eventToken),
    ),
  );
}

function inferPredictionHoldingCategory(holding = {}) {
  const text = [holding.symbol, holding.description, holding.localSymbol].filter(Boolean).join(' ');
  if (/\b(CPI|PCE|PPI|INFLATION)\b/i.test(text)) return 'Inflation';
  return 'Other Macro';
}

function buildHeldPredictionEvent(holding) {
  const title = holding.description || holding.symbol || 'IBKR prediction contract';
  const price = Number(holding.price);
  const validBinaryPrice = Number.isFinite(price) && price >= 0 && price <= 1 ? price : null;
  const flags = ['open_position'];
  if (holding.marketValue == null) flags.push('missing_market_value');

  return {
    id: `held-${holding.positionId || holding.conid || holding.symbol || title}`,
    question: title,
    contract_title: title,
    event_title: holding.symbol || title,
    category: inferPredictionHoldingCategory(holding),
    venue: 'IBKR',
    venues: ['IBKR'],
    ibkr_tradable: true,
    isOpenPosition: true,
    heldQuantity: Number(holding.quantity || 0),
    heldMarketValue: holding.marketValue,
    heldPosition: holding,
    yes: validBinaryPrice,
    yes_bid: null,
    yes_ask: null,
    no: validBinaryPrice != null ? Math.max(0, 1 - validBinaryPrice) : null,
    spread: null,
    volume: null,
    total_volume: null,
    open_interest: null,
    data_quality_flags: flags,
    quote_source: holding.priceSource || null,
    updated_at: holding.lastUpdated || null,
  };
}

function mergeHeldPredictionEvents(events, heldPositions) {
  if (!heldPositions.length) return events;
  const matchedHoldings = new Set();
  const enhanced = events.map((event) => {
    const holding = heldPositions.find((candidate) => eventMatchesHeldPosition(event, candidate));
    if (!holding) return event;
    matchedHoldings.add(holding.positionId || holding.conid || holding.symbol || holding.description);
    return {
      ...event,
      isOpenPosition: true,
      heldQuantity: Number(holding.quantity || 0),
      heldMarketValue: holding.marketValue,
      heldPosition: holding,
      data_quality_flags: [...new Set([...(event.data_quality_flags || []), 'open_position'])],
    };
  });
  const synthetic = heldPositions
    .filter((holding) => !matchedHoldings.has(holding.positionId || holding.conid || holding.symbol || holding.description))
    .map(buildHeldPredictionEvent);
  return [...enhanced, ...synthetic];
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

function ContractMapCard({ events, selectedId, onSelect, selectedSignal, loading, providers, ibkrLoading, onRefreshIbkr, heldContractCount = 0 }) {
  const [selectedAssetClass, setSelectedAssetClass] = useState(DEFAULT_ASSET_CLASS);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [venueFilter, setVenueFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [groupByEvent, setGroupByEvent] = useState(false);
  const [openPositionsOnly, setOpenPositionsOnly] = useState(false);
  const [sortCol, setSortCol] = useState('oi');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(0);

  const filteredEvents = useMemo(
    () => filterContractMapEvents(events, { categoryFilter, venueFilter, searchQuery }),
    [events, categoryFilter, venueFilter, searchQuery],
  );

  const tabbedEvents = useMemo(() => {
    const assetFiltered = filteredEvents.filter((e) => (
      selectedAssetClass === 'MACRO'
        ? isCpiMacroEvent(e)
        : inferEventMacroAssetClass(e) === selectedAssetClass
    ));
    const openFiltered = openPositionsOnly
      ? assetFiltered.filter((e) => e.isOpenPosition)
      : assetFiltered;
    return groupByEvent ? groupContractMapByEvent(openFiltered) : openFiltered;
  }, [filteredEvents, selectedAssetClass, groupByEvent, openPositionsOnly]);

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

  useEffect(() => { setPage(0); }, [sortCol, sortDir, selectedAssetClass, categoryFilter, venueFilter, searchQuery, groupByEvent, openPositionsOnly]);

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
        <label className="cmap-group-toggle">
          <input
            type="checkbox"
            checked={openPositionsOnly}
            onChange={(e) => setOpenPositionsOnly(e.target.checked)}
          />
          Open positions{heldContractCount ? ` (${heldContractCount})` : ''}
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
    const emptyMessage = event
      ? 'No live executable bid/ask quote is available for this market.'
      : 'Select a mapped market to build a ticket.';
    return (
      <div className="pmv2-ticket-stack">
        <div className="pmv2-card">
          <div className="pmv2-card-title">Trade Ticket</div>
          <div className="pmv2-empty">{emptyMessage}</div>
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
  const yes = Number(event.yes ?? event.yes_mid ?? event.yes_bid);
  const no = Number(event.no ?? event.no_mid ?? event.no_bid);
  return {
    ...event,
    yes: Number.isFinite(yes) ? yes : null,
    no: Number.isFinite(no) ? no : null,
  };
}

function getEventKey(event) {
  return event?.id || event?.contractId || event?.question || null;
}

function hasExecutablePrices(event) {
  const yes = Number(event?.yes);
  const no = Number(event?.no);
  return (
    Number.isFinite(yes) &&
    Number.isFinite(no) &&
    yes > 0 &&
    yes < 1 &&
    no > 0 &&
    no < 1
  );
}

function getEventEdge(event, settings = DEFAULT_SETTINGS) {
  if (!event || !hasExecutablePrices(event)) return null;
  const p = Number(event.myProb);
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  const yes = Number(event.yes);
  const no = Number(event.no);
  const fees = settings?.defaultFeePerContract ?? 0.02;
  const slippage = settings?.defaultSlippageBuffer ?? 0;
  const modelErr = settings?.modelErrorBuffer ?? 0;
  const yesEdge = calcNetEdge(grossEdgeYes(p, yes), fees, slippage, modelErr);
  const noEdge = calcNetEdge(grossEdgeNo(p, no), fees, slippage, modelErr);
  return Math.max(yesEdge, noEdge);
}

function getRecommendedSide(event, settings = DEFAULT_SETTINGS) {
  if (!event) return null;
  if (!hasExecutablePrices(event)) return null;
  const p = Number(event.myProb);
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  const yes = Number(event.yes);
  const no = Number(event.no);
  const yesEdge = calcNetEdge(grossEdgeYes(p, yes), settings.defaultFeePerContract, settings.defaultSlippageBuffer, settings.modelErrorBuffer);
  const noEdge = calcNetEdge(grossEdgeNo(p, no), settings.defaultFeePerContract, settings.defaultSlippageBuffer, settings.modelErrorBuffer);
  return yesEdge >= noEdge ? 'Yes' : 'No';
}

function buildTicketCalc(event, settings = DEFAULT_SETTINGS) {
  if (!event || !hasExecutablePrices(event)) return null;
  const p = event.myProb ?? 0.58;
  const yes = Number(event.yes);
  const no = Number(event.no);
  const recommendedSide = getRecommendedSide(event, settings);
  if (!recommendedSide) return null;
  const side = recommendedSide.toUpperCase();
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
  const equity = Number(settings?.portfolioEquity);
  if (!Number.isFinite(equity) || equity <= 0) return [];
  const rows = Object.entries(byAc).map(([key, val]) => ({
    label: ASSET_CLASS_DISPLAY[key] || key,
    pct: equity > 0 ? (Number(val) / equity) * 100 : 0,
  }));
  return rows.slice(0, 3);
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
  if (!event || !hasExecutablePrices(event)) {
    return {
      recommendedSide: inferSideFromSignal(signal, event),
      suggestedSize: 0,
      maxSize: 0,
      estimatedCost: 0,
      worstCaseLoss: 0,
      expectedValue: 0,
      confidence: 'Low',
      explanation: 'No verified live bid/ask quote is available for this contract. Sizing and order fields are disabled until live data returns.',
      isSignalOnly: true,
      unavailableLiveData: true,
      edge: null,
    };
  }
  const edge = getEventEdge(event, riskSettings) ?? 0;
  const maxRisk = riskSettings.maxRiskPerBet ?? riskSettings.maxRiskPerTrade ?? 500;
  const portfolioEquity = Number(riskSettings.portfolioEquity);
  if (!Number.isFinite(portfolioEquity) || portfolioEquity <= 0) {
    return {
      recommendedSide: inferSideFromSignal(signal, event),
      suggestedSize: 0,
      maxSize: 0,
      estimatedCost: 0,
      worstCaseLoss: 0,
      expectedValue: 0,
      confidence: 'Low',
      explanation: 'Live net liquidation value is unavailable. Sizing and order fields are disabled.',
      isSignalOnly: true,
      unavailableLiveData: true,
      edge,
    };
  }
  const side = getRecommendedSide(event, riskSettings);
  const price = side === 'Yes' ? Number(event.yes) : Number(event.no);
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

function fmtCpiPercent(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return `${n.toFixed(digits)}%`;
}

function fmtCpiLevel(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return n.toFixed(digits);
}

function formatCpiLevelPercent(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return `${n.toFixed(digits)}%`;
}

function fmtProb(value) {
  if (value == null || value === '') return '–';
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return `${Math.round(n * 100)}%`;
}

const CPI_MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getCpiMonthOptions(latest = null) {
  const anchor = latest && Number.isInteger(latest.year) && Number.isInteger(latest.month)
    ? latest
    : { year: new Date().getFullYear(), month: new Date().getMonth() };
  return Array.from({ length: 13 }, (_, index) => {
    const offset = index - 12;
    const date = new Date(anchor.year, anchor.month + offset, 1);
    const month = date.getMonth();
    const year = date.getFullYear();
    const shortYear = String(year).slice(-2);
    return {
      id: `${year}-${String(month + 1).padStart(2, '0')}`,
      label: `${CPI_MONTH_LABELS[month]} ${shortYear}`,
      fullLabel: `${date.toLocaleString('en-US', { month: 'long' })} ${year}`,
      month,
      year,
    };
  });
}

const DEFAULT_CPI_MONTH_OPTIONS = getCpiMonthOptions();
const CPI_MODEL_NOWCAST_DATE = process.env.REACT_APP_CPI_MODEL_NOWCAST_DATE || null;
const PM_WORKBENCH_STATE_KEY = 'marketDashboard.predictionMarkets.workbench.v1';
const DEFAULT_CPI_RISK_PCT = 1;

function parseCpiRiskPct(value) {
  if (value == null || String(value).trim() === '') return null;
  const percentage = Number(value);
  return Number.isFinite(percentage) && percentage > 0 && percentage <= 100
    ? percentage
    : null;
}

function getPersistedCpiRiskPct(state = {}) {
  return parseCpiRiskPct(state.cpiRiskPct) ?? DEFAULT_CPI_RISK_PCT;
}

function getCpiAllocationSignature({
  model,
  rows = [],
  history = [],
  finals = [],
  positions = [],
  liveNlv = null,
  riskPct = null,
  settings = {},
  currentOpenRisk = null,
  providers = null,
} = {}) {
  return JSON.stringify({
    liveNlv,
    riskPct,
    model: {
      forecastMonth: model?.forecastMonth || null,
      publishedText: model?.publishedText || null,
      scenarios: (model?.scenarios || []).map((scenario) => ({
        key: scenario.key,
        value: scenario.value,
      })),
    },
    rows: rows.map((row) => ({
      id: row.id,
      threshold: row.threshold,
      yesPrice: row.yesPrice,
      noPrice: row.noPrice,
      yesBid: row.event?.yes_bid,
      yesAskSize: row.event?.yes_ask_size,
      yesBidSize: row.event?.yes_bid_size,
      noAskSize: row.event?.no_ask_size,
      retrievedAt: row.event?.quote_retrieved_at || row.event?.updated_at || null,
      flags: row.event?.data_quality_flags || [],
    })),
    history: normalizeCpiNowcastHistory(history).map((entry) => ({
      id: entry.id,
      status: entry.status,
      raw: entry.scenarios?.raw || null,
    })),
    finals: normalizeCpiOfficialFinals(finals).map((entry) => ({ id: entry.id, value: entry.value })),
    positions: positions.map((position) => ({
      id: position.id,
      side: position.contractSide,
      quantity: position.quantity,
      avgPrice: position.avgPrice,
      costBasis: position.costBasis,
      title: position.title,
    })),
    limits: {
      maxRiskPerBet: settings.maxRiskPerBet,
      maxOpenRisk: settings.maxOpenRisk,
      maxCorrelatedExposure: settings.maxCorrelatedExposure,
      maxPmRiskPct: settings.maxPmRiskPct,
      currentOpenRisk,
    },
    providerState: {
      ibkr: providers?.ibkr?.status || null,
      ibkrExecutionReady: providers?.ibkr?.execution_ready === true,
      kalshi: providers?.kalshi?.status || null,
      kalshiDisplayReady: providers?.kalshi?.display_ready === true,
    },
  });
}

function getCpiMonthFromLabel(value) {
  const match = String(value || '').trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return null;
  const month = CPI_MONTH_LABELS.findIndex((label) => label.toLowerCase() === match[1].slice(0, 3).toLowerCase());
  const year = Number(match[2]);
  if (month < 0 || !Number.isInteger(year)) return null;
  return getCpiMonthOptions({ year, month }).at(-1) || null;
}

function getCpiMonthFromId(value) {
  const match = String(value || '').match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (!match) return null;
  return getCpiMonthOptions({ year: Number(match[1]), month: Number(match[2]) - 1 }).at(-1) || null;
}

function readPredictionMarketsWorkbenchState() {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PM_WORKBENCH_STATE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePredictionMarketsWorkbenchState(state) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PM_WORKBENCH_STATE_KEY, JSON.stringify(state));
  } catch {
    // Non-critical UI preference persistence.
  }
}

function getPersistedCpiMonth(state) {
  const savedMonthId = state?.activeCpiMonthId;
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(savedMonthId || ''))) return null;
  return getCpiMonthFromId(savedMonthId);
}

const CPI_CALENDAR_FINALS = [
  { id: '2025-06', label: 'Jun 25', final: 2.80, context: true, settlementLabel: 'Settlement Tuesday, July 15, 2025 · 8:30 AM ET' },
  { id: '2025-07', label: 'Jul 25', final: 2.70, settlementLabel: 'Settlement Tuesday, August 12, 2025 · 8:30 AM ET' },
  { id: '2025-08', label: 'Aug 25', final: 2.92, settlementLabel: 'Settlement Thursday, September 11, 2025 · 8:30 AM ET' },
  { id: '2025-09', label: 'Sep 25', final: 3.01, settlementLabel: 'Settlement Friday, October 24, 2025 · 8:30 AM ET' },
  { id: '2025-10', label: 'Oct 25', final: 2.87, settlementLabel: 'Settlement Thursday, November 13, 2025 · 8:30 AM ET' },
  { id: '2025-11', label: 'Nov 25', final: 2.74, settlementLabel: 'Settlement Thursday, December 18, 2025 · 8:30 AM ET' },
  { id: '2025-12', label: 'Dec 25', final: 2.68, settlementLabel: 'Settlement Tuesday, January 13, 2026 · 8:30 AM ET' },
  { id: '2026-01', label: 'Jan 26', final: 2.39, settlementLabel: 'Settlement Friday, February 13, 2026 · 8:30 AM ET' },
  { id: '2026-02', label: 'Feb 26', final: 2.41, settlementLabel: 'Settlement Wednesday, March 11, 2026 · 8:30 AM ET' },
  { id: '2026-03', label: 'Mar 26', final: 3.26, settlementLabel: 'Settlement Friday, April 10, 2026 · 8:30 AM ET' },
  { id: '2026-04', label: 'Apr 26', final: 3.81, settlementLabel: 'Settlement Tuesday, May 12, 2026 · 8:30 AM ET' },
  { id: '2026-05', label: 'May 26', final: 4.25, settlementLabel: 'Settlement Wednesday, June 10, 2026 · 8:30 AM ET' },
  { id: '2026-06', label: 'Jun 26', final: null, settlementLabel: 'Settlement Tuesday, July 14, 2026 · 8:30 AM ET' },
];

const CPI_RELEASE_DATES = Object.freeze({
  '2025-06': '2025-07-15T12:30:00.000Z',
  '2025-07': '2025-08-12T12:30:00.000Z',
  '2025-08': '2025-09-11T12:30:00.000Z',
  '2025-09': '2025-10-24T12:30:00.000Z',
  '2025-10': '2025-11-13T13:30:00.000Z',
  '2025-11': '2025-12-18T13:30:00.000Z',
  '2025-12': '2026-01-13T13:30:00.000Z',
  '2026-01': '2026-02-13T13:30:00.000Z',
  '2026-02': '2026-03-11T12:30:00.000Z',
  '2026-03': '2026-04-10T12:30:00.000Z',
  '2026-04': '2026-05-12T12:30:00.000Z',
  '2026-05': '2026-06-10T12:30:00.000Z',
  '2026-06': '2026-07-14T12:30:00.000Z',
  '2026-07': '2026-08-12T12:30:00.000Z',
  '2026-08': '2026-09-11T12:30:00.000Z',
});
const CPI_OFFICIAL_RETRY_DELAYS_MS = [2000, 5000, 10000, 60000];
const CPI_OFFICIAL_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const CPI_RELEASE_REFRESH_INTERVAL_MS = 30 * 1000;
const CPI_BENCHMARK_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const BLS_CPI_SOURCE_URL = 'https://www.bls.gov/news.release/cpi.t01.htm';

function cpiReleaseTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T12:30:00.000Z`
    : text;
  return Date.parse(normalized);
}

function normalizeCpiOfficialFinals(payload = null) {
  const finals = Array.isArray(payload) ? payload : payload?.finals;
  if (!Array.isArray(finals)) return [];
  return finals.map((entry) => {
    const id = String(entry?.id || entry?.monthId || '').trim();
    const rawValue = entry?.value ?? entry?.final;
    const value = rawValue == null || String(rawValue).trim() === '' ? null : Number(rawValue);
    return /^20\d{2}-(0[1-9]|1[0-2])$/.test(id) && Number.isFinite(value)
      ? {
          id,
          value,
          source: entry.source || 'bls_api',
        }
      : null;
  }).filter(Boolean);
}

function normalizeCpiNowcastHistory(payload = null) {
  const entries = Array.isArray(payload) ? payload : payload?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const id = String(entry?.monthId || entry?.id || '').trim();
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(id)) return null;
    const scenarios = entry?.scenarios;
    const rounded = {
      upper: Number(scenarios?.upper?.rounded),
      base: Number(scenarios?.base?.rounded),
      lower: Number(scenarios?.lower?.rounded),
    };
    const raw = {
      upper: Number(scenarios?.upper?.raw),
      base: Number(scenarios?.base?.raw),
      lower: Number(scenarios?.lower?.raw),
    };
    const hasScenarios = [rounded.upper, rounded.base, rounded.lower].every(Number.isFinite)
      && [raw.upper, raw.base, raw.lower].every(Number.isFinite)
      && raw.lower < raw.base
      && raw.base < raw.upper;
    return {
      id,
      releaseAt: entry.releaseAt || null,
      status: entry.status || 'unavailable',
      publishedAt: entry.publishedAt || null,
      source: entry.source || null,
      scenarios: hasScenarios ? { rounded, raw } : null,
    };
  }).filter(Boolean);
}

function finiteCpiComparisonValue(value) {
  if (value == null || String(value).trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function safeCpiSourceUrl(value) {
  const text = String(value || '').trim();
  return /^https:\/\//i.test(text) ? text : null;
}

function normalizeCpiBenchmarkPayload(payload, period) {
  const exactEnvelope = payload?.period === period
    && payload?.metric === 'headline-cpi-yoy'
    && payload?.unit === 'percent';
  const sources = exactEnvelope && Array.isArray(payload?.sources) ? payload.sources : [];
  return {
    period,
    metric: 'headline-cpi-yoy',
    unit: 'percent',
    fetchedAt: exactEnvelope ? payload.fetchedAt || null : null,
    sources: sources.map((source) => {
      const status = String(source?.status || '').trim().toLowerCase();
      const point = finiteCpiComparisonValue(source?.point);
      const sourceName = String(source?.source || '').trim().toLowerCase();
      const rejectedSource = /(mock|seed|fallback|stale|offline|cache)/.test(sourceName);
      const available = status === 'available' && point != null && !rejectedSource;
      return {
        id: String(source?.id || '').trim(),
        kind: String(source?.kind || '').trim(),
        status: available ? 'available' : 'unavailable',
        point: available ? point : null,
        asOf: source?.asOf || null,
        releaseAt: source?.releaseAt || null,
        source: source?.source || null,
        sourceUrl: safeCpiSourceUrl(source?.sourceUrl),
        reason: available
          ? null
          : source?.reason || 'This forecast source is unavailable for the selected month.',
      };
    }),
  };
}

function buildCpiCalendarEntries({
  officialFinals = [],
  nowcastHistory = [],
  forecastMonth = null,
  forecastReleaseDate = null,
  anchorMonth = null,
  anchorMonths = [],
} = {}) {
  const entries = new Map(CPI_CALENDAR_FINALS.map((entry) => [entry.id, {
    ...entry,
    releaseDate: entry.releaseDate || CPI_RELEASE_DATES[entry.id] || null,
  }]));
  normalizeCpiOfficialFinals(officialFinals).forEach((official) => {
    const existing = entries.get(official.id) || getCpiMonthFromId(official.id);
    if (!existing) return;
    entries.set(official.id, {
      ...existing,
      id: official.id,
      label: existing.label || `${CPI_MONTH_LABELS[existing.month]} ${String(existing.year).slice(-2)}`,
      final: official.value,
      finalSource: official.source,
      releaseDate: existing.releaseDate || CPI_RELEASE_DATES[official.id] || null,
    });
  });

  normalizeCpiNowcastHistory(nowcastHistory).forEach((history) => {
    const existing = entries.get(history.id) || getCpiMonthFromId(history.id);
    if (!existing) return;
    const releaseDate = existing.releaseDate || history.releaseAt || CPI_RELEASE_DATES[history.id] || null;
    entries.set(history.id, {
      ...existing,
      id: history.id,
      label: existing.label || `${CPI_MONTH_LABELS[existing.month]} ${String(existing.year).slice(-2)}`,
      releaseDate,
      settlementLabel: existing.settlementLabel || (releaseDate
        ? `Settlement ${formatDateShort(releaseDate)} · 8:30 AM ET`
        : 'Settlement date unavailable'),
      nowcastHistory: history,
    });
  });

  if (forecastMonth?.id && !entries.has(forecastMonth.id)) {
    entries.set(forecastMonth.id, {
      id: forecastMonth.id,
      label: forecastMonth.label,
      final: null,
      releaseDate: forecastReleaseDate || CPI_RELEASE_DATES[forecastMonth.id] || null,
      settlementLabel: forecastReleaseDate
        ? `Settlement ${formatDateShort(forecastReleaseDate)} · 8:30 AM ET`
        : 'Settlement date unavailable',
    });
  } else if (forecastMonth?.id && forecastReleaseDate) {
    const existing = entries.get(forecastMonth.id);
    entries.set(forecastMonth.id, {
      ...existing,
      releaseDate: existing?.releaseDate || forecastReleaseDate,
      settlementLabel: existing?.settlementLabel || `Settlement ${formatDateShort(forecastReleaseDate)} · 8:30 AM ET`,
    });
  }

  const latestFinalId = [...entries.values()]
    .filter((entry) => entry.final != null && Number.isFinite(Number(entry.final)))
    .map((entry) => entry.id)
    .sort()
    .at(-1);
  const latestFinalMonth = getCpiMonthFromId(latestFinalId);
  const anchor = [anchorMonth, ...anchorMonths, forecastMonth, latestFinalMonth]
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(-1) || getCpiMonthFromId(CPI_CALENDAR_FINALS.at(-1)?.id);

  return getCpiMonthOptions(anchor).map((month) => {
    const existing = entries.get(month.id);
    return existing || {
      id: month.id,
      label: month.label,
      final: null,
      releaseDate: CPI_RELEASE_DATES[month.id] || null,
      settlementLabel: 'Settlement date unavailable',
    };
  });
}

export function isCpiMonthExpired(entry = null, now = new Date()) {
  if (!entry) return false;
  if (entry.final != null && Number.isFinite(Number(entry.final))) return true;
  const releaseDate = entry.releaseDate;
  if (!releaseDate) return false;
  const releaseDeadline = cpiReleaseTimestamp(releaseDate);
  const nowValue = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(releaseDeadline) && Number.isFinite(nowValue) && releaseDeadline < nowValue;
}

function hasPendingCpiOfficialFinal(finals = [], now = Date.now()) {
  const finalIds = new Set(normalizeCpiOfficialFinals(finals).map((entry) => entry.id));
  return Object.entries(CPI_RELEASE_DATES).some(([id, releaseDate]) => {
    const releaseDeadline = cpiReleaseTimestamp(releaseDate);
    return Number.isFinite(releaseDeadline) && releaseDeadline < now && !finalIds.has(id);
  });
}

const CPI_MISSING_DATA_TITLE = 'Missing Data';
const CPI_MISSING_DATA_MESSAGE = 'Live data is unavailable for this section.';

function CpiMissingDataBox({
  title = CPI_MISSING_DATA_TITLE,
  message = CPI_MISSING_DATA_MESSAGE,
} = {}) {
  return (
    <div className="cpi-missing-data-box" role="status" aria-live="polite">
      <strong>{title}</strong>
      <span>{message}</span>
    </div>
  );
}

function getScenarioValue(model, key) {
  const aliases = {
    upside: ['upside', 'upper', 'bull', 'high'],
    base: ['base', 'base-case', 'base case', 'central'],
    downside: ['downside', 'lower', 'bear', 'low'],
  };
  const wanted = aliases[key] || [key];
  const scenario = model?.scenarios?.find((item) => {
    const tokens = [
      item?.key,
      item?.label,
      item?.name,
    ].map((value) => String(value || '').trim().toLowerCase());
    return tokens.some((token) => wanted.includes(token));
  });
  return scenario?.value ?? scenario?.percent ?? scenario?.raw ?? null;
}

function hasOrderedCpiScenarioValues(lower, base, upper) {
  const low = Number(lower);
  const mid = Number(base);
  const high = Number(upper);
  return (
    [low, mid, high].every(Number.isFinite) &&
    low < mid &&
    mid < high
  );
}

function formatCpiComparisonPoint(value) {
  const numeric = finiteCpiComparisonValue(value);
  return numeric == null ? '—' : `${numeric.toFixed(2)}%`;
}

function formatCpiComparisonRange(lower, upper) {
  const low = finiteCpiComparisonValue(lower);
  const high = finiteCpiComparisonValue(upper);
  return low == null || high == null ? '—' : `${low.toFixed(2)}%–${high.toFixed(2)}%`;
}

function formatCpiComparisonDelta(value) {
  const numeric = finiteCpiComparisonValue(value);
  if (numeric == null) return '—';
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)} pp`;
}

function formatCpiComparisonAsOf(value, fallback = '—') {
  if (!value) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const releaseDate = new Date(`${value}T12:00:00.000Z`);
    if (Number.isNaN(releaseDate.getTime())) return fallback;
    const dateLabel = releaseDate.toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    return `${dateLabel}, 8:30 AM ET`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function buildCpiForecastComparisonRows({
  entry,
  benchmarkPayload,
  benchmarksLoading = false,
  benchmarksError = null,
} = {}) {
  const history = entry?.nowcastHistory || null;
  const rawScenarios = history?.scenarios?.raw || null;
  const lower = finiteCpiComparisonValue(rawScenarios?.lower);
  const base = finiteCpiComparisonValue(rawScenarios?.base);
  const upper = finiteCpiComparisonValue(rawScenarios?.upper);
  const hedgeyeAvailable = hasOrderedCpiScenarioValues(lower, base, upper);
  const sourceById = new Map((benchmarkPayload?.sources || []).map((source) => [source.id, source]));
  const streetSource = sourceById.get('wall-street-consensus') || null;
  const clevelandSource = sourceById.get('cleveland-fed') || null;
  const benchmarkUnavailableReason = benchmarksError || 'Verified benchmark data is unavailable for the selected month.';
  const benchmarkRow = ({ id, label, detail, source }) => {
    if (benchmarksLoading) {
      return {
        id,
        label,
        detail: 'Loading verified source…',
        status: 'loading',
        point: null,
        sourceUrl: null,
        asOf: null,
      };
    }
    const available = source?.status === 'available' && finiteCpiComparisonValue(source?.point) != null;
    return {
      id,
      label,
      detail: available ? detail : source?.reason || benchmarkUnavailableReason,
      status: available ? 'available' : 'unavailable',
      point: available ? finiteCpiComparisonValue(source.point) : null,
      sourceUrl: source?.sourceUrl || null,
      asOf: source?.asOf || null,
      releaseAt: source?.releaseAt || null,
    };
  };

  const street = benchmarkRow({
    id: 'wall-street-consensus',
    label: 'Wall Street consensus',
    detail: 'Trading Economics survey consensus',
    source: streetSource,
  });
  const cleveland = benchmarkRow({
    id: 'cleveland-fed',
    label: 'Cleveland Fed',
    detail: 'Independent model nowcast',
    source: clevelandSource,
  });
  const releaseAt = street.releaseAt || cleveland.releaseAt || entry?.releaseDate || null;
  const finalValue = finiteCpiComparisonValue(entry?.final);
  const finalAvailable = finalValue != null;
  const expired = isCpiMonthExpired(entry, Date.now());
  const rows = [
    {
      id: 'hedgeye',
      label: 'Hedgeye · our view',
      detail: hedgeyeAvailable
        ? history?.status === 'provisional' ? 'Provisional forecast' : 'Final pre-release forecast'
        : 'No source-matched Hedgeye forecast is available for this month.',
      status: hedgeyeAvailable ? 'available' : 'unavailable',
      point: hedgeyeAvailable ? base : null,
      rangeLow: hedgeyeAvailable ? lower : null,
      rangeHigh: hedgeyeAvailable ? upper : null,
      asOf: history?.publishedAt || null,
      asOfFallback: hedgeyeAvailable && history?.status === 'final-pre-release'
        ? 'Final pre-release'
        : '—',
      sourceUrl: null,
    },
    street,
    cleveland,
    {
      id: 'bls-actual',
      label: 'BLS actual',
      detail: finalAvailable
        ? 'Official Headline CPI YoY result'
        : expired ? 'Official BLS result is unavailable.' : 'Pending official release',
      status: finalAvailable ? 'available' : expired ? 'unavailable' : 'pending',
      point: finalAvailable ? finalValue : null,
      asOf: finalAvailable ? releaseAt : null,
      sourceUrl: BLS_CPI_SOURCE_URL,
    },
  ];
  const consensusPoint = street.status === 'available' ? street.point : null;
  return rows.map((row) => ({
    ...row,
    delta: row.id !== 'wall-street-consensus'
      && row.status === 'available'
      && consensusPoint != null
      ? Number((row.point - consensusPoint).toFixed(6))
      : null,
    deltaLabel: row.id === 'wall-street-consensus' && row.status === 'available'
      ? 'Benchmark'
      : null,
  }));
}

export function getCpiAccountValue(portfolioData = null, now = new Date()) {
  const source = String(
    portfolioData?.dataSource ||
    portfolioData?.meta?.source ||
    portfolioData?.accountSummary?.source ||
    '',
  ).trim().toLowerCase();
  const quality = String(portfolioData?.dataQuality?.status || '').trim().toLowerCase();
  const providerState = String(
    portfolioData?.providerStatus?.status ||
    portfolioData?.status ||
    '',
  ).trim().toLowerCase();
  const rejectedStates = new Set(['cached', 'disconnected', 'error', 'fallback', 'mock', 'offline', 'stale']);
  const socketVerifiedAt = Date.parse(portfolioData?.accountSummary?.socketVerifiedAt || '');
  const socketAgeMs = new Date(now).getTime() - socketVerifiedAt;
  const hasFreshSocketVerification = Number.isFinite(socketVerifiedAt)
    && Number.isFinite(socketAgeMs)
    && socketAgeMs >= -5000
    && socketAgeMs <= 5 * 60 * 1000;
  const isVerifiedLiveIbkr = ['ibkr_api', 'ibkr_live', 'ibkr_live_session'].includes(source) &&
    portfolioData?.accountSummary?.source === 'ibkr_live_session' &&
    portfolioData?.liveSessionVerified === true &&
    hasFreshSocketVerification &&
    !portfolioData?.error &&
    portfolioData?.fromCache !== true &&
    !rejectedStates.has(quality) &&
    !rejectedStates.has(providerState);
  if (!isVerifiedLiveIbkr) return null;

  const candidates = [
    portfolioData?.accountSummary?.netLiquidation,
    portfolioData?.accountSummary?.equityWithLoanValue,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function getCpiRiskBps(value, portfolioData = null) {
  const n = Number(value);
  const accountValue = getCpiAccountValue(portfolioData);
  if (!Number.isFinite(n) || accountValue <= 0) return 0;
  return Math.round((n / accountValue) * 10000);
}

function getAllocatedCpiRows(rows = []) {
  return rows.filter((row) => !row.missingContract && Number(row.suggestedContracts || 0) > 0);
}

function isOpenCpiPositionRow(row = {}) {
  const event = row.event || {};
  return Boolean(
    row.isOpenPosition ||
    Number(row.openContracts || 0) > 0 ||
    event.heldPosition ||
    event.source_api === 'IBKR_PORTFOLIO' ||
    (event.data_quality_flags || []).includes('open_position'),
  );
}

function getCpiPayoffLeg(row = {}) {
  if (isOpenCpiPositionRow(row)) {
    const contracts = Number(row.openContracts || 0);
    const riskPerContract = Number(row.openRiskPerContract || 0);
    return {
      contracts,
      side: row.openSide || row.recommendedSide,
      riskPerContract,
      payoutMultiplier: Number(row.payoutMultiplier || 1),
      estimatedCost: Number(row.openEstimatedCost || (contracts * riskPerContract) || 0),
      maxProfit: Number(row.openMaxProfit || 0),
      source: 'open_position',
    };
  }

  const contracts = Number(row.suggestedContracts || 0);
  const riskPerContract = Number(row.riskPerContract || 0);
  return {
    contracts,
    side: row.recommendedSide,
    riskPerContract,
    payoutMultiplier: Number(row.payoutMultiplier || 1),
    estimatedCost: Number(row.estimatedCost || (contracts * riskPerContract) || 0),
    maxProfit: Number(row.maxProfit || 0),
    source: 'recommendation',
  };
}

function getPayoffCpiRows(rows = []) {
  return rows.filter((row) => {
    if (row.missingContract) return false;
    const leg = getCpiPayoffLeg(row);
    return leg.contracts > 0 && leg.riskPerContract > 0;
  });
}

function calculateCpiScenarioPayoff(rows = [], scenarioValue) {
  if (scenarioValue == null) return null;
  const settlementValue = roundCpiSettlementLevel(scenarioValue);
  if (!Number.isFinite(settlementValue)) return null;
  return getPayoffCpiRows(rows).reduce((sum, row) => {
    const leg = getCpiPayoffLeg(row);
    const threshold = Number(row.threshold);
    if (!leg.contracts || !Number.isFinite(threshold)) return sum;
    const yesWins = settlementValue > threshold;
    const legWins = leg.side === 'YES' ? yesWins : !yesWins;
    const perContract = legWins ? leg.payoutMultiplier - leg.riskPerContract : -leg.riskPerContract;
    return sum + (leg.contracts * perContract);
  }, 0);
}

function formatCpiMoney(value, { decimals = 0, signed = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  const sign = signed && n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function formatCpiCompactMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10000 ? 1 : 1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatCpiContracts(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 });
}

function roundCpiSettlementLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

function getCpiScenarioSpecs(model) {
  return [
    { key: 'downside', label: 'Downside', tone: 'negative' },
    { key: 'base', label: 'Base', tone: 'neutral' },
    { key: 'upside', label: 'Upside', tone: 'positive' },
  ].map((scenario) => {
    const value = getScenarioValue(model, scenario.key);
    return {
      ...scenario,
      value,
      roundedValue: roundCpiSettlementLevel(value),
    };
  }).filter((scenario) => Number.isFinite(Number(scenario.value)) && scenario.roundedValue != null);
}

function getCpiScenarioWinCount(threshold, side, scenarios = []) {
  const strike = Number(threshold);
  if (!Number.isFinite(strike) || !scenarios.length) return 0;
  return scenarios.filter((scenario) => {
    const roundedValue = Number(scenario.roundedValue);
    if (!Number.isFinite(roundedValue)) return false;
    const yesWins = roundedValue > strike;
    return side === 'NO' ? !yesWins : yesWins;
  }).length;
}

function getCpiSettlementBoundary(threshold) {
  const strike = roundCpiSettlementLevel(threshold);
  if (!Number.isFinite(strike)) return null;
  return Number((strike + 0.05).toFixed(2));
}

function getCpiPayoffStepSegments(rows = [], min = 3.5, max = 4.5) {
  const payoffRows = getPayoffCpiRows(rows);
  const epsilon = 0.0001;
  const payAt = (value) => calculateCpiScenarioPayoff(payoffRows, value) ?? 0;
  const boundaries = [...new Set(payoffRows
    .map((row) => getCpiSettlementBoundary(row.threshold))
    .filter((boundary) => Number.isFinite(boundary) && boundary > min && boundary < max)
    .map((boundary) => Number(boundary.toFixed(2))))].sort((a, b) => a - b);

  const horizontals = [];
  const verticals = [];
  let cursor = min;

  boundaries.forEach((boundary) => {
    const leftPayoff = payAt(Math.max(min, boundary - epsilon));
    const rightPayoff = payAt(Math.min(max, boundary + epsilon));
    if (boundary > cursor) {
      horizontals.push({
        from: cursor,
        to: boundary,
        payoff: leftPayoff,
        tone: leftPayoff >= 0 ? 'positive' : 'negative',
      });
    }
    if (leftPayoff !== rightPayoff) {
      verticals.push({
        cpi: boundary,
        fromPayoff: leftPayoff,
        toPayoff: rightPayoff,
        tone: rightPayoff >= 0 ? 'positive' : 'negative',
      });
    }
    cursor = boundary;
  });

  if (cursor < max) {
    const payoff = payAt(Math.min(max, cursor + epsilon));
    horizontals.push({
      from: cursor,
      to: max,
      payoff,
      tone: payoff >= 0 ? 'positive' : 'negative',
    });
  }

  return { horizontals, verticals };
}

function getCpiLineScenarioOutcomes(threshold, side, scenarios = []) {
  return scenarios.map((scenario) => {
    const strike = Number(threshold);
    const roundedValue = Number(scenario.roundedValue);
    const yesWins = Number.isFinite(strike) && Number.isFinite(roundedValue) && roundedValue > strike;
    const wins = side === 'NO' ? !yesWins : yesWins;
    return {
      ...scenario,
      wins,
    };
  });
}

function formatCpiCents(value) {
  if (value == null || value === '') return '–';
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return `${Math.round(n * 100)}c`;
}

function formatCpiEdgeCents(value) {
  if (value == null || value === '') return '–';
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  const cents = Math.round(n * 100);
  return cents > 0 ? `+${cents}c` : `${cents}c`;
}

function getCpiLineTitle(threshold, side) {
  return `Above ${fmtCpiLevel(threshold, 1)} ${side}`;
}

function getCpiLineAsk(row, side) {
  if (!row || row.missingContract) return null;
  const ask = side === 'NO' ? row.noPrice : row.yesPrice;
  const n = Number(ask);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

function getCpiPositionLine(position, scenarios = []) {
  const threshold = getCpiPositionThreshold(position);
  const side = String(position.contractSide || 'YES').toUpperCase() === 'NO' ? 'NO' : 'YES';
  const avgPrice = Number(position.avgPrice ?? position.lastPrice);
  const fairValue = scenarios.length
    ? getCpiScenarioWinCount(threshold, side, scenarios) / scenarios.length
    : null;
  const edge = Number.isFinite(avgPrice) && fairValue != null ? fairValue - avgPrice : null;
  return {
    id: `open-${position.id || position.title || threshold}-${side}`,
    source: 'open_position',
    title: getCpiLineTitle(threshold, side),
    threshold,
    side,
    ask: Number.isFinite(avgPrice) ? avgPrice : null,
    askLabel: 'Avg',
    fairValue,
    edge,
    outcomes: getCpiLineScenarioOutcomes(threshold, side, scenarios),
    wins: getCpiScenarioWinCount(threshold, side, scenarios),
    scenarioCount: scenarios.length,
    position,
    executable: false,
  };
}

function getCpiDirectVolume(row = {}) {
  const raw = row?.event?.volume;
  if (raw == null || raw === '') return null;
  const volume = Number(raw);
  return Number.isFinite(volume) && volume > 0 ? volume : null;
}

function getCpiDirectDisplayAsk(row = {}, side = 'YES') {
  const raw = side === 'NO' ? row?.event?.no_ask : row?.event?.yes_ask;
  if (raw == null || raw === '') return null;
  const ask = Number(raw);
  return Number.isFinite(ask) && ask >= 0 && ask <= 1 ? ask : null;
}

function hasCompleteCpiDisplayBook(row = {}) {
  const event = row.event || {};
  const validPair = (bidValue, askValue) => {
    if (bidValue == null || bidValue === '' || askValue == null || askValue === '') return false;
    const bid = Number(bidValue);
    const ask = Number(askValue);
    return Number.isFinite(bid) && Number.isFinite(ask)
      && bid >= 0 && ask <= 1 && ask >= bid;
  };
  return validPair(event.yes_bid, event.yes_ask) && validPair(event.no_bid, event.no_ask);
}

function getCpiDisplayProviderPriority(row = {}) {
  const source = String(row?.event?.source_api || '').toUpperCase();
  if (source === 'IBKR_TWS_API' || source === 'IBKR_CPAPI') return 2;
  if (source === 'KALSHI_TRADE_API_V2') return 1;
  return 0;
}

function shouldPreferCpiDisplayRow(candidate, current) {
  if (!current) return true;
  const completeDelta = Number(hasCompleteCpiDisplayBook(candidate)) - Number(hasCompleteCpiDisplayBook(current));
  if (completeDelta !== 0) return completeDelta > 0;
  return getCpiDisplayProviderPriority(candidate) > getCpiDisplayProviderPriority(current);
}

function selectCpiPositiveVolumeRows(rows = []) {
  const byStrike = new Map();
  rows.forEach((row) => {
    if (row?.missingContract || getCpiDirectVolume(row) == null || !Number.isFinite(Number(row.threshold))) return;
    const strike = Number(row.threshold).toFixed(1);
    const current = byStrike.get(strike);
    if (shouldPreferCpiDisplayRow(row, current)) byStrike.set(strike, row);
  });
  return [...byStrike.values()]
    .sort((a, b) => Number(a.threshold) - Number(b.threshold));
}

function getCpiLineFee(row, ask) {
  if (ask == null) return null;
  const venue = String(row?.event?.venue || row?.venue || '').toLowerCase();
  if (venue === 'kalshi') return calculateKalshiTakerFee(1, ask);
  const rawFee = row?.event?.fee_per_contract;
  if (rawFee == null || rawFee === '') return null;
  const fee = Number(rawFee);
  return Number.isFinite(fee) && fee >= 0 ? fee : null;
}

function getCpiScenarioMatrixRows(rows = [], model = null, probabilityCurve = null) {
  const scenarios = getCpiScenarioSpecs(model);
  const curveByStrike = new Map((probabilityCurve?.probabilities || []).map((entry) => [
    Number(entry.threshold).toFixed(4),
    entry,
  ]));
  return selectCpiPositiveVolumeRows(rows)
    .map((row) => {
      const side = 'YES';
      const threshold = Number(row.threshold);
      const volume = getCpiDirectVolume(row);
      const ask = getCpiDirectDisplayAsk(row, side);
      const executableAsk = getCpiLineAsk(row, side);
      const curveEntry = curveByStrike.get(threshold.toFixed(4));
      const fairValue = curveEntry?.fairProbability ?? null;
      const payoutMultiplier = Number(row.payoutMultiplier || 1);
      const fee = getCpiLineFee(row, executableAsk);
      const edge = fairValue != null && executableAsk != null && fee != null && payoutMultiplier > 0
        ? fairValue - executableAsk - (fee / payoutMultiplier)
        : null;
      return {
        id: `${row.id}-${side}`,
        source: 'live_provider',
        row,
        title: getCpiLineTitle(threshold, side),
        threshold,
        side,
        ask,
        askLabel: 'Ask',
        fairValue,
        edge,
        volume,
        outcomes: getCpiLineScenarioOutcomes(threshold, side, scenarios),
        wins: getCpiScenarioWinCount(threshold, side, scenarios),
        scenarioCount: scenarios.length,
        executable: executableAsk != null,
        payoutMultiplier,
      };
    });
}

function getCpiLineBadgeTone(line, index = 0) {
  if (line?.side === 'YES') return 'green';
  if (line?.side === 'NO') return 'blue';
  return Number(line?.edge) > 0 || index === 0 ? 'slate' : 'gray';
}

function getCpiPositionScenarioPayoff(position = {}, line = {}, scenario = {}) {
  const contracts = Math.abs(Number(position.quantity || 0));
  const risk = Number(position.maxLoss);
  const profit = Number(position.maxProfit);
  if (!contracts || !Number.isFinite(risk) || !Number.isFinite(profit)) return null;
  const outcome = line.outcomes?.find((entry) => entry.key === scenario.key);
  const wins = Boolean(outcome?.wins);
  return wins ? profit : -risk;
}

function getCpiScenarioExposureColumns(openPositions = [], lines = [], scenarios = []) {
  return scenarios.map((scenario) => {
    const entries = openPositions.map((position, index) => {
      const line = lines[index] || getCpiPositionLine(position, scenarios);
      const payoff = getCpiPositionScenarioPayoff(position, line, scenario);
      const outcome = line.outcomes?.find((entry) => entry.key === scenario.key);
      const wins = Boolean(outcome?.wins);
      return {
        id: `${scenario.key}-${position.id || position.title || index}`,
        position,
        line,
        wins,
        payoff,
      };
    });
    const netPayoff = entries.reduce((sum, entry) => (
      Number.isFinite(Number(entry.payoff)) ? sum + Number(entry.payoff) : sum
    ), 0);
    return {
      ...scenario,
      entries,
      winners: entries.filter((entry) => entry.wins),
      losers: entries.filter((entry) => !entry.wins),
      netPayoff,
    };
  });
}

function getCpiScenarioBiasLabel(columns = []) {
  const positive = columns.filter((column) => Number(column.netPayoff) > 0);
  if (positive.length >= 2) {
    return `${positive[0].label} -> ${positive[positive.length - 1].label}`;
  }
  if (positive.length === 1) return positive[0].label;
  const best = [...columns].sort((a, b) => Number(b.netPayoff) - Number(a.netPayoff))[0];
  return best?.label || '–';
}

function getLargestCpiOpenLine(openPositions = [], lines = []) {
  return openPositions.reduce((best, position, index) => {
    const score = Math.max(Math.abs(Number(position.maxLoss || 0)), Math.abs(Number(position.currentValue || 0)));
    if (!best || score > best.score) {
      return {
        position,
        line: lines[index] || null,
        score,
      };
    }
    return best;
  }, null);
}

function getCpiPositionThreshold(position = {}) {
  const text = [position.title, position.symbol].filter(Boolean).join(' ');
  const match = text.match(/(?:^|[-_\s])T(-?\d+(?:\.\d+)?)(?:[-_\s]?(?:YES|NO)\b|$)/i) ||
    text.match(/\b(?:above|below)\s+(-?\d+(?:\.\d+)?)\s*%?/i);
  return match ? Number(match[1]) : null;
}

function getCpiPayoffChartData(rows = [], model) {
  const payoffRows = getPayoffCpiRows(rows);
  const min = 3.5;
  const max = 4.5;
  const { horizontals, verticals } = getCpiPayoffStepSegments(payoffRows, min, max);
  const points = [];
  horizontals.forEach((segment) => {
    points.push(
      { cpi: segment.from, payoff: segment.payoff },
      { cpi: segment.to, payoff: segment.payoff },
    );
  });
  verticals.forEach((segment) => {
    points.push(
      { cpi: segment.cpi, payoff: segment.fromPayoff },
      { cpi: segment.cpi, payoff: segment.toPayoff },
    );
  });
  return points
    .sort((a, b) => (a.cpi - b.cpi) || (a.payoff - b.payoff))
    .map((point) => ({
      ...point,
      positivePayoff: point.payoff >= 0 ? point.payoff : null,
      negativePayoff: point.payoff <= 0 ? point.payoff : null,
    }));
}

function getCpiPayoffMetrics(rows = [], model, portfolioData = null) {
  const payoffRows = getPayoffCpiRows(rows);
  const totalRisk = payoffRows.reduce((sum, row) => sum + getCpiPayoffLeg(row).estimatedCost, 0);
  const maxProfit = payoffRows.reduce((sum, row) => sum + getCpiPayoffLeg(row).maxProfit, 0);
  const stepSegments = getCpiPayoffStepSegments(payoffRows, 3.5, 4.5);
  const chartData = getCpiPayoffChartData(payoffRows, model);
  const positivePoints = chartData.filter((point) => point.payoff >= 0);
  const breakevenLower = positivePoints[0]?.cpi ?? null;
  const breakevenUpper = positivePoints[positivePoints.length - 1]?.cpi ?? null;
  const scenarios = ['downside', 'base', 'upside']
    .map((key) => getScenarioValue(model, key))
    .filter((value) => Number.isFinite(Number(value)));
  const wins = scenarios.filter((value) => (calculateCpiScenarioPayoff(payoffRows, value) ?? 0) > 0).length;
  const winProbability = scenarios.length ? wins / scenarios.length : null;
  const rewardRisk = totalRisk > 0 ? maxProfit / totalRisk : null;
  const riskBps = getCpiRiskBps(totalRisk, portfolioData);
  return {
    chartData,
    stepSegments,
    totalRisk,
    riskBps,
    maxProfit,
    maxLoss: -totalRisk,
    breakevenLower,
    breakevenUpper,
    chartMin: chartData[0]?.cpi ?? 3.5,
    chartMax: chartData[chartData.length - 1]?.cpi ?? 4.5,
    rewardRisk,
    winProbability,
  };
}

function getCpiStrikeExposureRows(rows = []) {
  const payoffRows = getPayoffCpiRows(rows);
  const levels = [...new Set(rows
    .map((row) => Number(row.threshold))
    .filter(Number.isFinite)
    .map((threshold) => Number(threshold.toFixed(1))))].sort((a, b) => a - b);

  return levels.map((strike) => {
    const exposure = payoffRows.reduce((sum, row) => {
      const threshold = Number(row.threshold);
      if (!Number.isFinite(threshold) || Number(threshold.toFixed(1)) !== strike) return sum;
      const leg = getCpiPayoffLeg(row);
      const sign = leg.side === 'NO' ? -1 : 1;
      return sum + (sign * leg.contracts * leg.payoutMultiplier);
    }, 0);
    return {
      strike,
      exposure,
      tone: exposure > 0 ? 'positive' : exposure < 0 ? 'negative' : 'neutral',
    };
  });
}

const clampCpiPct = (value) => Math.max(0, Math.min(100, value));

function getCpiPayoffStackMarkers(legMarkers = [], strikeExposureRows = []) {
  const sideByStrike = new Map();
  legMarkers.forEach((marker) => {
    const strike = Number(marker.threshold);
    if (!Number.isFinite(strike)) return;
    sideByStrike.set(Number(strike.toFixed(1)), marker.side || (Number(marker.exposure) >= 0 ? 'YES' : 'NO'));
  });

  return strikeExposureRows
    .filter((row) => Number.isFinite(Number(row.strike)) && Math.abs(Number(row.exposure || 0)) > 0)
    .map((row) => {
      const strike = Number(row.strike);
      const exposure = Number(row.exposure || 0);
      return {
        strike,
        exposure,
        side: sideByStrike.get(Number(strike.toFixed(1))) || (exposure >= 0 ? 'YES' : 'NO'),
        tone: exposure >= 0 ? 'positive' : 'negative',
      };
    })
    .sort((a, b) => a.strike - b.strike);
}

function CpiPayoffMap({ metrics, scenarios, legMarkers, strikeExposureRows }) {
  const chartData = Array.isArray(metrics?.chartData) ? metrics.chartData : [];
  const stepSegments = metrics?.stepSegments || { horizontals: [], verticals: [] };
  const chartMin = Number(metrics?.chartMin ?? 3.5);
  const chartMax = Number(metrics?.chartMax ?? 4.5);
  const chartRange = Math.max(0.01, chartMax - chartMin);
  const maxAbsPayoff = Math.max(
    1,
    ...chartData.map((point) => Math.abs(Number(point.payoff || 0))),
    ...(stepSegments.horizontals || []).map((segment) => Math.abs(Number(segment.payoff || 0))),
    ...(stepSegments.verticals || []).flatMap((segment) => [
      Math.abs(Number(segment.fromPayoff || 0)),
      Math.abs(Number(segment.toPayoff || 0)),
    ]),
    Math.abs(Number(metrics?.maxProfit || 0)),
    Math.abs(Number(metrics?.maxLoss || 0)),
  );

  const svgWidth = 720;
  const svgHeight = 320;
  const plot = { left: 52, top: 40, right: 20, bottom: 68 };
  const plotWidth = svgWidth - plot.left - plot.right;
  const plotHeight = svgHeight - plot.top - plot.bottom;
  const xFor = (value) => plot.left + (clampCpiPct(((Number(value) - chartMin) / chartRange) * 100) / 100) * plotWidth;
  const yFor = (value) => plot.top + ((maxAbsPayoff - Number(value || 0)) / (maxAbsPayoff * 2)) * plotHeight;
  const zeroY = yFor(0);
  const stackMarkers = getCpiPayoffStackMarkers(legMarkers, strikeExposureRows);
  const ticks = Array.from({ length: Math.round((chartMax - chartMin) * 10) + 1 }, (_, index) => Number((chartMin + index * 0.1).toFixed(1)));
  const areaSegments = (stepSegments.horizontals || []).map((segment) => {
    const x0 = xFor(segment.from);
    const x1 = xFor(segment.to);
    const y = yFor(segment.payoff);
    return {
      ...segment,
      path: `M ${x0} ${zeroY} L ${x0} ${y} L ${x1} ${y} L ${x1} ${zeroY} Z`,
      linePath: `M ${x0} ${y} L ${x1} ${y}`,
    };
  });
  const verticalSegments = (stepSegments.verticals || []).map((segment) => {
    const x = xFor(segment.cpi);
    return {
      ...segment,
      path: `M ${x} ${yFor(segment.fromPayoff)} L ${x} ${yFor(segment.toPayoff)}`,
    };
  });

  let previousMarkerX = -Infinity;
  const markers = stackMarkers.map((marker, index) => {
    const x = xFor(marker.strike);
    const compact = x - previousMarkerX < 72;
    previousMarkerX = x;
    return {
      ...marker,
      x,
      lane: compact ? index % 2 : 0,
      compact,
    };
  });

  return (
    <div className="cpi-payoff-map" aria-label="CPI payoff and strike exposure map">
      <svg className="cpi-payoff-map-svg" viewBox={`0 0 ${svgWidth} ${svgHeight}`} role="img" aria-label="Payoff line with strike exposure markers">
        <rect x="0" y="0" width={svgWidth} height={svgHeight} rx="8" className="cpi-payoff-map-bg" />
        {[maxAbsPayoff, 0, -maxAbsPayoff].map((value) => (
          <line
            key={`grid-${value}`}
            x1={plot.left}
            x2={svgWidth - plot.right}
            y1={yFor(value)}
            y2={yFor(value)}
            className={value === 0 ? 'cpi-payoff-zero-line' : 'cpi-payoff-grid-line'}
          />
        ))}
        <text x={10} y={plot.top - 12} className="cpi-payoff-map-label">P&amp;L</text>
        <text x={plot.left - 8} y={yFor(maxAbsPayoff) + 4} textAnchor="end" className="cpi-payoff-map-y">{formatCpiCompactMoney(maxAbsPayoff)}</text>
        <text x={plot.left - 8} y={zeroY + 4} textAnchor="end" className="cpi-payoff-map-y">$0</text>
        <text x={plot.left - 8} y={yFor(-maxAbsPayoff) + 4} textAnchor="end" className="cpi-payoff-map-y">-{formatCpiCompactMoney(maxAbsPayoff)}</text>

        {areaSegments.map((area, index) => (
          <path key={`area-${index}`} d={area.path} className={`cpi-payoff-area ${area.tone}`} />
        ))}
        {areaSegments.map((line, index) => (
          <path
            key={`line-${index}`}
            d={line.linePath}
            className={`cpi-payoff-line ${line.tone}`}
            data-step-segment="horizontal"
            data-from-cpi={line.from}
            data-to-cpi={line.to}
            data-payoff={line.payoff}
          />
        ))}
        {verticalSegments.map((line, index) => (
          <path
            key={`jump-${index}`}
            d={line.path}
            className={`cpi-payoff-line cpi-payoff-line-jump ${line.tone}`}
            data-step-segment="vertical"
            data-cpi={line.cpi}
            data-from-payoff={line.fromPayoff}
            data-to-payoff={line.toPayoff}
          />
        ))}

        {scenarios.map((scenario, index) => {
          if (!Number.isFinite(Number(scenario.value))) return null;
          const x = xFor(scenario.value);
          const roundedValue = scenario.roundedValue ?? roundCpiSettlementLevel(scenario.value);
          const labelY = Math.max(plot.top + 12 + (index % 2) * 14, zeroY - 17 - (index % 2) * 14);
          return (
            <g key={`scenario-${scenario.key}`}>
              <line x1={x} x2={x} y1={plot.top} y2={zeroY + 10} className={`cpi-scenario-tick ${scenario.tone}`} />
              <circle cx={x} cy={zeroY} r="3" className={`cpi-scenario-dot ${scenario.tone}`} />
              <text x={x} y={labelY} textAnchor="middle" className={`cpi-scenario-marker-label ${scenario.tone}`}>
                {`${fmtCpiLevel(scenario.value, 2)} -> ${fmtCpiLevel(roundedValue, 1)}`}
              </text>
            </g>
          );
        })}

        {ticks.map((tick) => {
          const x = xFor(tick);
          return (
            <g key={`tick-${tick}`}>
              <line x1={x} x2={x} y1={zeroY + 4} y2={zeroY + 8} className="cpi-payoff-axis-tick" />
              <text x={x} y={zeroY + 23} textAnchor="middle" className="cpi-payoff-map-x">{tick.toFixed(1)}</text>
            </g>
          );
        })}

        {markers.map((marker) => {
          const labelY = zeroY + 44 + marker.lane * 24;
          const amountLabel = formatCpiMoney(marker.exposure, { decimals: 0 });
          const fullLabel = `${fmtCpiLevel(marker.strike, 1)} ${marker.side} ${amountLabel}`;
          return (
            <g key={`stack-${marker.strike}-${marker.side}`} className={`cpi-stack-marker ${marker.tone}`}>
              <title>{fullLabel}</title>
              <line x1={marker.x} x2={marker.x} y1={zeroY + 8} y2={labelY - 18} />
              <circle cx={marker.x} cy={zeroY + 8} r="4" />
              <rect x={marker.x - (marker.compact ? 29 : 42)} y={labelY - 17} width={marker.compact ? 58 : 84} height="18" rx="5" />
              <text x={marker.x} y={labelY - 4} textAnchor="middle">
                {marker.compact ? amountLabel : `${fmtCpiLevel(marker.strike, 1)} ${marker.side}`}
              </text>
              {!marker.compact && (
                <text x={marker.x} y={labelY + 14} textAnchor="middle" className="cpi-stack-amount">
                  {amountLabel}
                </text>
              )}
            </g>
          );
        })}
        <text x={(plot.left + svgWidth - plot.right) / 2} y={svgHeight - 7} textAnchor="middle" className="cpi-payoff-axis-label-svg">Headline CPI YoY (%)</text>
      </svg>
    </div>
  );
}

function getCpiCalendarEntryDisplay(entry) {
  const finalValue = finiteCpiComparisonValue(entry?.final);
  const rawScenarios = entry?.nowcastHistory?.scenarios?.raw || null;
  const estimateBase = finiteCpiComparisonValue(rawScenarios?.base);
  const released = isCpiMonthExpired(entry, Date.now());
  const hasEstimate = !released && hasOrderedCpiScenarioValues(
    rawScenarios?.lower,
    rawScenarios?.base,
    rawScenarios?.upper,
  );
  const hasFinal = finalValue != null;
  const displayValue = hasFinal ? finalValue : hasEstimate ? estimateBase : null;
  const valueKind = hasFinal ? 'actual' : hasEstimate ? 'estimate' : 'unavailable';
  const provenanceTitle = hasFinal
    ? 'Official BLS Headline CPI YoY actual'
    : hasEstimate
      ? `${entry?.nowcastHistory?.status === 'provisional' ? 'Provisional' : 'Final pre-release'} Hedgeye estimate`
      : 'CPI value unavailable';
  return { displayValue, valueKind, provenanceTitle };
}

function formatCpiToplineSettlement(entry) {
  const rawDate = entry?.releaseDate;
  if (!rawDate) return 'Settlement unavailable';
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(String(rawDate))
      ? `${rawDate}T12:00:00.000Z`
      : rawDate,
  );
  if (Number.isNaN(date.getTime())) return 'Settlement unavailable';
  const dateLabel = date.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
  });
  return `Settles ${dateLabel} · 8:30 AM ET`;
}

function formatCpiLiveQuoteTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function CpiCalculatorHeader({
  activeMonth,
  calendarEntries = [],
  liveQuoteObservedAt = null,
  loading = false,
  expiredMonth = false,
}) {
  const activeEntry = calendarEntries.find((entry) => entry.id === activeMonth?.id) || null;
  const monthTitle = activeMonth
    ? `${CPI_MONTH_LABELS[activeMonth.month].toUpperCase()} ${activeMonth.year}`
    : 'UNAVAILABLE';
  const quoteTime = formatCpiLiveQuoteTime(liveQuoteObservedAt);
  const liveLabel = expiredMonth
    ? 'Historical view'
    : quoteTime
      ? `Live ${quoteTime} ET`
      : loading
        ? 'Loading live quotes…'
        : 'Live data unavailable';
  const liveTone = expiredMonth ? 'historical' : quoteTime ? 'live' : loading ? 'loading' : 'unavailable';

  return (
    <header className="cpi-ledger-topline cpi-calendar-header">
      <h1>CPI <span aria-hidden="true">·</span> {monthTitle}</h1>
      <span className="cpi-ledger-settlement">{formatCpiToplineSettlement(activeEntry)}</span>
      <span className={`cpi-ledger-live-status ${liveTone}`} role="status">{liveLabel}</span>
    </header>
  );
}

function CpiForecastRail({
  model,
  activeMonth,
  months,
  calendarEntries = [],
  onMonthSelect,
  benchmarkPayload = null,
  benchmarksLoading = false,
  benchmarksError = null,
}) {
  const monthLookup = useMemo(
    () => new Map((months || []).map((month) => [month.id, month])),
    [months],
  );
  const activeEntry = calendarEntries.find((entry) => entry.id === activeMonth?.id) || null;
  const comparisonRows = buildCpiForecastComparisonRows({
    entry: activeEntry,
    benchmarkPayload,
    benchmarksLoading,
    benchmarksError,
  });
  const comparisonById = new Map(comparisonRows.map((row) => [row.id, row]));
  const hedgeye = comparisonById.get('hedgeye') || {};
  const street = comparisonById.get('wall-street-consensus') || {};
  const cleveland = comparisonById.get('cleveland-fed') || {};
  const rawScenarios = activeEntry?.nowcastHistory?.scenarios?.raw || null;
  const historicalScenarios = hasOrderedCpiScenarioValues(
    rawScenarios?.lower,
    rawScenarios?.base,
    rawScenarios?.upper,
  ) ? [
      { key: 'downside', label: 'Downside', tone: 'negative', value: rawScenarios.lower },
      { key: 'base', label: 'Base', tone: 'neutral', value: rawScenarios.base },
      { key: 'upside', label: 'Upside', tone: 'positive', value: rawScenarios.upper },
    ].map((scenario) => ({
      ...scenario,
      roundedValue: roundCpiSettlementLevel(scenario.value),
    })) : [];
  const scenarios = historicalScenarios.length
    ? historicalScenarios
    : model
      ? getCpiScenarioSpecs(model)
      : [];
  const forecastAsOf = hedgeye.status === 'available'
    ? formatCpiComparisonAsOf(hedgeye.asOf, hedgeye.asOfFallback)
    : 'Forecast timestamp unavailable';
  const renderSourceLabel = (row, fallbackLabel) => row?.sourceUrl ? (
    <a href={row.sourceUrl} target="_blank" rel="noreferrer">{fallbackLabel}</a>
  ) : fallbackLabel;
  const renderSourceValue = (row) => row?.status === 'loading'
    ? 'Loading…'
    : formatCpiComparisonPoint(row?.point);

  return (
    <aside className="cpi-ledger-panel cpi-forecast-rail" aria-labelledby="cpi-forecast-rail-title">
      <div className="cpi-ledger-panel-scroll">
        <section className="cpi-forecast-summary">
          <h2 id="cpi-forecast-rail-title">Forecast</h2>
          <dl>
            <div title={hedgeye.detail}>
              <dt>Hedgeye</dt>
              <dd>{renderSourceValue(hedgeye)}</dd>
            </div>
            <div title={hedgeye.detail}>
              <dt>Range</dt>
              <dd>{formatCpiComparisonRange(hedgeye.rangeLow, hedgeye.rangeHigh)}</dd>
            </div>
            <div title={cleveland.detail}>
              <dt>{renderSourceLabel(cleveland, 'Cleveland Fed')}</dt>
              <dd>{renderSourceValue(cleveland)}</dd>
            </div>
            <div title={street.detail}>
              <dt>{renderSourceLabel(street, 'Street')}</dt>
              <dd>{renderSourceValue(street)}</dd>
            </div>
          </dl>
        </section>

        <section className="cpi-forecast-scenarios" aria-labelledby="cpi-scenario-levels-title">
          <h3 id="cpi-scenario-levels-title">Scenario levels</h3>
          {scenarios.length ? (
            <dl>
              {scenarios.map((scenario) => (
                <div className={scenario.tone} key={scenario.key}>
                  <dt>{scenario.label}</dt>
                  <dd>{fmtCpiLevel(scenario.value, 2)} → {fmtCpiLevel(scenario.roundedValue, 1)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <CpiMissingDataBox
              title="Scenario levels unavailable"
              message="A source-matched Hedgeye CPI forecast is required."
            />
          )}
        </section>

        <section className="cpi-month-history" aria-labelledby="cpi-month-history-title">
          <div className="cpi-month-history-heading">
            <h3 id="cpi-month-history-title">Month history</h3>
            <span>YoY</span>
          </div>
          <div className="cpi-month-history-list">
            {calendarEntries.map((entry) => {
              const month = monthLookup.get(entry.id);
              const isActive = entry.id === activeMonth?.id;
              const { displayValue, valueKind, provenanceTitle } = getCpiCalendarEntryDisplay(entry);
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={isActive ? 'active' : ''}
                  aria-pressed={isActive}
                  aria-label={`${entry.label}; ${displayValue == null ? 'value unavailable' : `${formatCpiLevelPercent(displayValue, 1)} ${valueKind}`}; ${provenanceTitle}`}
                  title={provenanceTitle}
                  onClick={() => month && onMonthSelect(month)}
                  disabled={!month}
                >
                  <span>{entry.label}</span>
                  <strong>{displayValue == null ? '—' : formatCpiLevelPercent(displayValue, 1)}</strong>
                  <small>{valueKind === 'estimate' ? 'est' : valueKind === 'actual' ? 'actual' : ''}</small>
                </button>
              );
            })}
          </div>
        </section>
      </div>
      <footer className="cpi-forecast-footnote">
        <span>All values are % change YoY</span>
        <span>Forecast as of {forecastAsOf}</span>
      </footer>
    </aside>
  );
}

function CpiNoLiveContractState({
  rows,
  loading,
  providers,
  ibkrLoading,
  ibkrDiscovering,
  onRefreshIbkr,
  onDiscoverIbkr,
  title = CPI_MISSING_DATA_TITLE,
  message = CPI_MISSING_DATA_MESSAGE,
}) {
  const showLoading = loading && providers == null && rows.length === 0;

  if (showLoading) {
    return (
      <LoadingIndicator
        label="Loading IBKR CPI contracts..."
        centered
        className="pmv2-empty"
      />
    );
  }

  return (
    <div className="cpi-state cpi-state-compact cpi-missing-data-panel">
      <CpiMissingDataBox title={title} message={message} />
      <div className="cpi-state-actions">
        <RefreshButton
          label="Discover IBKR Contracts"
          onClick={onDiscoverIbkr}
          loading={ibkrDiscovering}
          disabled={ibkrLoading || ibkrDiscovering}
        />
        <RefreshButton
          label="Refresh Quotes"
          onClick={onRefreshIbkr}
          loading={ibkrLoading}
          disabled={ibkrLoading || ibkrDiscovering}
        />
      </div>
    </div>
  );
}

function CpiExpiredTableState({ section, monthLabel }) {
  return (
    <div className="cpi-expired-table-state" role="status">
      <strong>{monthLabel || 'This CPI month'} has passed</strong>
      <span>No live {section.toLowerCase()} data is shown after the CPI release.</span>
    </div>
  );
}

function CpiLineBadge({ children, tone = 'gray' }) {
  return <span className={`cpi-line-badge ${tone}`}>{children}</span>;
}

function CpiLineBadgeLegend() {
  return (
    <div className="cpi-line-badge-legend" aria-label="Line badge legend">
      <span><i className="cpi-line-badge green" />YES</span>
      <span><i className="cpi-line-badge blue" />NO</span>
      <span><i className="cpi-line-badge gray" />Other</span>
    </div>
  );
}

function CpiScenarioMatrixCard({
  rows,
  displayRows = [],
  matrixRows,
  loading,
  model,
  providers,
  ibkrLoading,
  ibkrDiscovering,
  onRefreshIbkr,
  onDiscoverIbkr,
  expiredMonth = false,
  monthLabel = null,
}) {
  const scenarios = model ? getCpiScenarioSpecs(model) : [];
  const contractWarnings = useMemo(() => (
    rows.flatMap((row) => (
      (row.warnings || []).map((warning) => `${row.title}: ${warning}`)
    ))
  ), [rows]);
  const loadedContractRows = useMemo(
    () => rows.filter((row) => !row.missingContract).length,
    [rows],
  );

  return (
    <Pmv2CardChrome
      className={`cpi-matrix-card${expiredMonth ? ' cpi-expired-month' : ''}`}
      icon={(
        <img
          className="cpi-contracts-card-icon"
          src={contractsArmWrestleIcon}
          alt=""
        />
      )}
      title={(
        <span className="cpi-card-title-with-help">
          <span>Contracts</span>
        </span>
      )}
      titleId="cpi-scenario-matrix-title"
      actions={!expiredMonth && (
        <div className="cpi-header-actions">
          <ContractProviderStatusDot
            providers={providers}
            strikeCount={loadedContractRows}
            targetStrikeCount={rows.length}
            contractWarnings={contractWarnings}
            ibkrLoading={ibkrLoading}
            ibkrDiscovering={ibkrDiscovering}
            onRefreshIbkr={onRefreshIbkr}
            onDiscoverIbkr={onDiscoverIbkr}
          />
        </div>
      )}
    >
      {expiredMonth ? (
        <CpiExpiredTableState section="contracts" monthLabel={monthLabel} />
      ) : matrixRows.length === 0 ? (
        <CpiNoLiveContractState
          rows={rows}
          loading={loading}
          providers={providers}
          ibkrLoading={ibkrLoading}
          ibkrDiscovering={ibkrDiscovering}
          onRefreshIbkr={onRefreshIbkr}
          onDiscoverIbkr={onDiscoverIbkr}
          title={displayRows.length === 0 ? CPI_MISSING_DATA_TITLE : 'No live-volume contracts'}
          message={displayRows.length === 0
            ? CPI_MISSING_DATA_MESSAGE
            : 'No verified current-release contracts have positive venue volume.'}
        />
      ) : (
        <div className="cpi-matrix-table-wrap">
          <table className="cpi-matrix-table" aria-label="CPI contracts">
            <thead>
              <tr>
                <th>Contract</th>
                {scenarios.map((scenario) => (
                  <th key={scenario.key} className={scenario.tone}>
                    <strong>{scenario.label}</strong>
                    <span>{fmtCpiLevel(scenario.value, 2)} -&gt; {fmtCpiLevel(scenario.roundedValue, 1)}</span>
                  </th>
                ))}
                <th>Fair<br />(c)</th>
                <th>Ask<br />(c)</th>
                <th>Edge<br />(c)</th>
                <th className="cpi-matrix-volume">Volume</th>
              </tr>
            </thead>
            <tbody>
              {matrixRows.map((line, index) => {
                const edgeTone = Number(line.edge) > 0 ? 'edge-positive' : Number(line.edge) < 0 ? 'edge-negative' : 'edge-neutral';
                const badgeTone = getCpiLineBadgeTone(line, index);
                return (
                  <tr key={line.id} className={index === 0 && Number(line.edge) > 0 ? 'selected' : ''}>
                    <td className="cpi-matrix-contract-cell">
                      <span className="cpi-matrix-contract-inner">
                        <CpiLineBadge tone={badgeTone}>{index + 1}</CpiLineBadge>
                        <strong>{line.title}</strong>
                      </span>
                    </td>
                    {line.outcomes.map((outcome) => (
                      <td key={`${line.id}-${outcome.key}`}>
                        <span className={`cpi-outcome-pill ${outcome.wins ? 'win' : 'loss'}`}>
                          {outcome.wins ? 'Win' : 'Loss'}
                        </span>
                      </td>
                    ))}
                    <td>{formatCpiCents(line.fairValue)}</td>
                    <td>
                      {formatCpiCents(line.ask)}
                      {line.askLabel === 'Avg' && <small className="cpi-matrix-sub">avg</small>}
                    </td>
                    <td className={edgeTone}>
                      <strong>{formatCpiEdgeCents(line.edge)}</strong>
                    </td>
                    <td className="cpi-matrix-volume">{fmtVolume(line.volume)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Pmv2CardChrome>
  );
}

function CpiContractLadderPanel({
  rows,
  displayRows = [],
  matrixRows,
  loading,
  providers,
  ibkrLoading,
  ibkrDiscovering,
  onRefreshIbkr,
  onDiscoverIbkr,
  expiredMonth = false,
  monthLabel = null,
}) {
  return (
    <section
      className={`cpi-ledger-panel cpi-contract-ladder${expiredMonth ? ' cpi-expired-month' : ''}`}
      aria-label="Contract ladder"
    >
      <div className="cpi-ledger-panel-body">
        {expiredMonth ? (
          <CpiExpiredTableState section="contracts" monthLabel={monthLabel} />
        ) : matrixRows.length === 0 ? (
          <CpiNoLiveContractState
            rows={rows}
            loading={loading}
            providers={providers}
            ibkrLoading={ibkrLoading}
            ibkrDiscovering={ibkrDiscovering}
            onRefreshIbkr={onRefreshIbkr}
            onDiscoverIbkr={onDiscoverIbkr}
            title={displayRows.length === 0 ? CPI_MISSING_DATA_TITLE : 'No live-volume contracts'}
            message={displayRows.length === 0
              ? CPI_MISSING_DATA_MESSAGE
              : 'No verified current-release contracts have positive venue volume.'}
          />
        ) : (
          <div className="cpi-contract-table-wrap">
            <table className="cpi-contract-table" aria-label="CPI contracts">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Fair <small>(c)</small></th>
                  <th>Ask <small>(c)</small></th>
                  <th>Edge <small>(c)</small></th>
                  <th>Volume</th>
                </tr>
              </thead>
              <tbody>
                {matrixRows.map((line) => {
                  const edgeTone = Number(line.edge) > 0
                    ? 'edge-positive'
                    : Number(line.edge) < 0 ? 'edge-negative' : 'edge-neutral';
                  return (
                    <tr
                      key={line.id}
                      className={Number(line.edge) > 0 ? 'edge-positive-row' : ''}
                    >
                      <td className="cpi-contract-name"><strong>{line.title}</strong></td>
                      <td>{formatCpiCents(line.fairValue)}</td>
                      <td>{formatCpiCents(line.ask)}</td>
                      <td className={edgeTone}>
                        <strong>{formatCpiEdgeCents(line.edge)}</strong>
                      </td>
                      <td>{fmtVolume(line.volume)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {matrixRows.length > 0 && !expiredMonth && (
          <footer className="cpi-contract-footnote">
            <span>c = cents (e.g., 67c = $0.67)</span>
            <span>Volume = contracts traded</span>
          </footer>
        )}
      </div>
    </section>
  );
}

function getCpiAllocatorStatusMessage(reason) {
  const messages = {
    live_nlv_unavailable: 'Verified live IBKR net liquidation value is required.',
    invalid_risk_percentage: 'Enter a percentage greater than 0 and no more than 100.',
    current_scenarios_unavailable: 'A current ordered Hedgeye CPI nowcast is required.',
    insufficient_calibration_history: 'Resolved pre-release Hedgeye/BLS calibration history is incomplete.',
    insufficient_live_market_curve: 'At least three direct live two-sided CPI books are required.',
    no_live_executable_depth: 'Fresh native asks, depth, and a known venue fee schedule are required.',
    live_provider_unavailable: 'A verified live CPI market-data provider is required.',
  };
  return messages[reason] || 'The allocation model is not ready from verified live inputs.';
}

function CpiRiskBudgetPanel({
  liveNlv,
  riskPctInput,
  onRiskPctChange,
  onApply,
  preview,
  allocationPlan,
  allocationInvalidated,
}) {
  const ready = preview?.status === 'ready';
  const requestedBudget = Number.isFinite(Number(preview?.requestedBudget))
    ? preview.requestedBudget
    : null;
  const allowedBudget = Number.isFinite(Number(preview?.effectiveBudget))
    ? preview.effectiveBudget
    : null;
  return (
    <section className="cpi-risk-budget-panel" aria-labelledby="cpi-risk-budget-title">
      <header>
        <div>
          <h3 id="cpi-risk-budget-title">Risk Budget</h3>
          <span>Additional CPI risk · sizing only · no order submission</span>
        </div>
        <button
          type="button"
          className="cpi-allocation-apply"
          onClick={onApply}
          disabled={!ready}
        >
          {allocationPlan ? 'Recalculate' : 'Apply / recalculate'}
        </button>
      </header>
      <div className="cpi-risk-budget-grid">
        <label className="cpi-risk-input-field">
          <span>% of NLV</span>
          <span className="cpi-risk-input-control">
            <input
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              inputMode="decimal"
              value={riskPctInput}
              onChange={(event) => onRiskPctChange(event.target.value)}
              aria-label="CPI risk percentage of net liquidation value"
            />
            <b>%</b>
          </span>
        </label>
        <div>
          <span>Verified live NLV</span>
          <strong>{liveNlv != null ? formatCpiMoney(liveNlv, { decimals: 0 }) : '–'}</strong>
        </div>
        <div>
          <span>Requested budget</span>
          <strong>{requestedBudget != null ? formatCpiMoney(requestedBudget, { decimals: 2 }) : '–'}</strong>
        </div>
        <div>
          <span>Allowed after guardrails</span>
          <strong>{allowedBudget != null ? formatCpiMoney(allowedBudget, { decimals: 2 }) : '–'}</strong>
        </div>
        <div>
          <span>Post-trade CPI risk</span>
          <strong>
            {allocationPlan?.metrics
              ? `${formatCpiMoney(allocationPlan.metrics.postTradeWorstLoss, { decimals: 2 })} · ${(allocationPlan.metrics.postTradeRiskPct * 100).toFixed(2)}% NLV`
              : '–'}
          </strong>
        </div>
      </div>
      <div className={`cpi-allocation-readiness${ready ? ' ready' : ' unavailable'}`} role="status">
        {allocationInvalidated
          ? 'Live inputs changed. The prior allocation was invalidated; recalculate before using it.'
          : !ready
            ? getCpiAllocatorStatusMessage(preview?.reason)
            : allocationPlan
              ? 'Allocation is calculated from the currently displayed live snapshot.'
              : 'Verified inputs are ready. Apply to calculate an allocation.'}
      </div>
    </section>
  );
}

function CpiAllocationTable({ plan }) {
  if (!plan) return null;
  return (
    <section className="cpi-allocation-section" aria-labelledby="cpi-allocation-title">
      <header className="cpi-payday-section-heading">
        <div>
          <h3 id="cpi-allocation-title">Proposed Allocation</h3>
          <span>One side per strike · native top-of-book depth · fees included</span>
        </div>
      </header>
      <div className="cpi-allocation-table-wrap">
        <table className="cpi-allocation-table">
          <thead>
            <tr>
              <th>Contract</th>
              <th>Side</th>
              <th>Model fair</th>
              <th>Ask / VWAP</th>
              <th>Net edge</th>
              <th>Allocated</th>
              <th>Qty</th>
              <th>Fees</th>
              <th>Max loss</th>
            </tr>
          </thead>
          <tbody>
            {plan.allocations.map((allocation) => (
              <tr key={allocation.id} data-testid="cpi-allocation-row">
                <td><strong>Above {fmtCpiLevel(allocation.threshold, 1)}</strong></td>
                <td>{allocation.side || '–'}</td>
                <td>{allocation.fairProbability != null ? fmtProb(allocation.fairProbability) : '–'}</td>
                <td>
                  {allocation.ask != null ? formatCpiCents(allocation.ask) : '–'}
                  {allocation.depthCap > 0 && (
                    <small>Depth {formatCpiContracts(allocation.depthCap)}</small>
                  )}
                </td>
                <td className={Number(allocation.netEdge) >= 0 ? 'edge-positive' : 'edge-negative'}>
                  {allocation.netEdge != null ? formatCpiEdgeCents(allocation.netEdge) : '–'}
                </td>
                <td>{formatCpiMoney(allocation.allocation, { decimals: 2 })}</td>
                <td>{formatCpiContracts(allocation.contracts)}</td>
                <td>{formatCpiMoney(allocation.fees, { decimals: 2 })}</td>
                <td>{formatCpiMoney(allocation.maxLoss, { decimals: 2 })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CpiAllocationDiagnostics({ plan }) {
  if (!plan?.metrics) return null;
  const metrics = plan.metrics;
  const items = [
    ['Calibration observations', formatCpiContracts(metrics.calibrationObservations)],
    ['Deployed', formatCpiMoney(plan.deployedBudget, { decimals: 2 })],
    ['Residual cash', formatCpiMoney(plan.residualBudget, { decimals: 2 })],
    ['Expected P&L', formatCpiMoney(metrics.expectedPnl, { decimals: 2, signed: true })],
    ['Worst-case P&L', formatCpiMoney(metrics.combinedWorstPnl, { decimals: 2, signed: true })],
    ['CVaR 95%', formatCpiMoney(metrics.cvar95, { decimals: 2, signed: true })],
    ['Total fees', formatCpiMoney(metrics.totalFees, { decimals: 2 })],
  ];
  return (
    <section className="cpi-allocation-diagnostics" aria-labelledby="cpi-diagnostics-title">
      <header className="cpi-payday-section-heading">
        <div>
          <h3 id="cpi-diagnostics-title">Model Diagnostics</h3>
          <span>Expected values use the calibrated settlement-state distribution</span>
        </div>
      </header>
      <div className="cpi-diagnostic-grid">
        {items.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {plan.warnings?.length > 0 && (
        <div className={`cpi-allocation-warnings${metrics.forcedDeployment ? ' mandate-override' : ''}`}>
          {plan.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      )}
    </section>
  );
}

function CpiSettlementOutcomeTable({ plan }) {
  if (!plan?.settlementStates?.length) return null;
  return (
    <section className="cpi-settlement-section" aria-labelledby="cpi-settlement-title">
      <header className="cpi-payday-section-heading">
        <div>
          <h3 id="cpi-settlement-title">Settlement Outcomes</h3>
          <span>Current book, additional allocation, and combined expiration P&amp;L</span>
        </div>
      </header>
      <div className="cpi-settlement-table-wrap">
        <table className="cpi-settlement-table">
          <thead>
            <tr>
              <th>Reported CPI</th>
              <th>Probability</th>
              <th>Current book</th>
              <th>Proposed</th>
              <th>Combined</th>
            </tr>
          </thead>
          <tbody>
            {plan.settlementStates.map((state) => (
              <tr key={state.key}>
                <td>{state.label}</td>
                <td>{fmtProb(state.probability)}</td>
                {[state.currentPnl, state.proposedPnl, state.combinedPnl].map((value, index) => (
                  <td key={`${state.key}-${index}`} className={value >= 0 ? 'edge-positive' : 'edge-negative'}>
                    {formatCpiMoney(value, { decimals: 2, signed: true })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CpiCompactRiskBudgetPanel({
  liveNlv,
  riskPctInput,
  onRiskPctChange,
  onApply,
  preview,
  allocationPlan,
  allocationInvalidated,
}) {
  const ready = preview?.status === 'ready';
  const allowedBudget = Number.isFinite(Number(preview?.effectiveBudget))
    ? preview.effectiveBudget
    : null;

  return (
    <section className="cpi-ledger-risk" aria-labelledby="cpi-ledger-risk-title">
      <header>
        <h3 id="cpi-ledger-risk-title">Risk budget</h3>
        <span>Worst-case loss across all scenarios</span>
      </header>
      <div className="cpi-ledger-risk-grid">
        <label>
          <span>NLV %</span>
          <span className="cpi-ledger-risk-input">
            <input
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              inputMode="decimal"
              value={riskPctInput}
              onChange={(event) => onRiskPctChange(event.target.value)}
              aria-label="CPI risk percentage of net liquidation value"
            />
            <b>%</b>
          </span>
        </label>
        <div>
          <span>NLV</span>
          <strong>{liveNlv != null ? formatCpiMoney(liveNlv, { decimals: 0 }) : '–'}</strong>
        </div>
        <div>
          <span>Allowed</span>
          <strong>{allowedBudget != null ? formatCpiMoney(allowedBudget, { decimals: 2 }) : '–'}</strong>
        </div>
        <button
          type="button"
          className="cpi-ledger-calculate"
          onClick={onApply}
          disabled={!ready}
        >
          Calculate
        </button>
      </div>
      <div className={`cpi-allocation-readiness${ready ? ' ready' : ' unavailable'}`} role="status">
        {allocationInvalidated
          ? 'Live inputs changed. The prior allocation was invalidated; calculate again before using it.'
          : !ready
            ? getCpiAllocatorStatusMessage(preview?.reason)
            : allocationPlan
              ? 'Allocation calculated from the currently displayed live snapshot.'
              : 'Verified inputs are ready. Calculate to build an allocation.'}
      </div>
    </section>
  );
}

function CpiCurrentBookTable({ openPositions, positionLines, totalRisk }) {
  if (!openPositions.length) {
    return (
      <div className="cpi-current-book-empty">
        <CpiMissingDataBox
          title="No live positions"
          message="No verified live CPI positions are available."
        />
      </div>
    );
  }

  return (
    <div className="cpi-current-book-table-wrap">
      <table className="cpi-current-book-table" aria-label="Current CPI positions">
        <thead>
          <tr>
            <th>Position</th>
            <th>Qty</th>
            <th>Avg</th>
            <th>Risk</th>
          </tr>
        </thead>
        <tbody>
          {openPositions.map((position, index) => {
            const line = positionLines[index] || getCpiPositionLine(position, []);
            return (
              <tr key={position.id || `${line.title}-${index}`}>
                <td><strong>{line.title}</strong></td>
                <td>{formatCpiContracts(Math.abs(position.quantity || 0))}</td>
                <td>{formatCpiCents(line.ask)}</td>
                <td>{formatCpiMoney(position.maxLoss, { decimals: 0 })}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>Total risk</td>
            <td colSpan="3">{formatCpiMoney(totalRisk, { decimals: 0 })}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function CpiScenarioNetPayoff({ scenarioColumns, hasLivePositions }) {
  return (
    <section className="cpi-net-payoff" aria-labelledby="cpi-net-payoff-title">
      <h3 id="cpi-net-payoff-title">Scenario net payoff</h3>
      <div className="cpi-net-payoff-grid">
        {scenarioColumns.map((scenario) => (
          <div className={scenario.tone} key={scenario.key}>
            <span>{scenario.label}</span>
            <small>{fmtCpiLevel(scenario.value, 2)} → {fmtCpiLevel(scenario.roundedValue, 1)}</small>
            <strong className={hasLivePositions
              ? scenario.netPayoff >= 0 ? 'positive' : 'negative'
              : 'unavailable'}>
              {hasLivePositions
                ? formatCpiMoney(scenario.netPayoff, { decimals: 0, signed: true })
                : '–'}
            </strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function CpiCurrentBookPanel({
  model,
  openPositions,
  liveNlv,
  riskPctInput,
  onRiskPctChange,
  onApply,
  preview,
  allocationPlan,
  allocationInvalidated = false,
  expiredMonth = false,
  monthLabel = null,
}) {
  const scenarios = model ? getCpiScenarioSpecs(model) : [];
  const positionLines = openPositions.map((position) => getCpiPositionLine(position, scenarios));
  const totalRisk = openPositions.reduce((sum, position) => sum + Number(position.maxLoss || 0), 0);
  const scenarioColumns = getCpiScenarioExposureColumns(openPositions, positionLines, scenarios);

  return (
    <aside
      className={`cpi-ledger-panel cpi-current-book${expiredMonth ? ' cpi-expired-month' : ''}`}
      aria-labelledby="cpi-current-book-title"
    >
      <header className="cpi-ledger-section-header">
        <h2 id="cpi-current-book-title">Current book</h2>
      </header>
      <div className="cpi-current-book-scroll">
        {expiredMonth ? (
          <CpiExpiredTableState section="book" monthLabel={monthLabel} />
        ) : (
          <>
            <CpiCurrentBookTable
              openPositions={openPositions}
              positionLines={positionLines}
              totalRisk={totalRisk}
            />
            {scenarioColumns.length > 0 && (
              <CpiScenarioNetPayoff
                scenarioColumns={scenarioColumns}
                hasLivePositions={openPositions.length > 0}
              />
            )}
            <CpiCompactRiskBudgetPanel
              liveNlv={liveNlv}
              riskPctInput={riskPctInput}
              onRiskPctChange={onRiskPctChange}
              onApply={onApply}
              preview={preview}
              allocationPlan={allocationPlan}
              allocationInvalidated={allocationInvalidated}
            />
            {allocationPlan && (
              <details className="cpi-allocation-details">
                <summary>
                  <span>Allocation details</span>
                  <small>
                    {allocationPlan.allocations?.length || 0} lines · {formatCpiMoney(allocationPlan.deployedBudget, { decimals: 2 })} deployed
                  </small>
                </summary>
                <div className="cpi-allocation-details-body">
                  <CpiAllocationTable plan={allocationPlan} />
                  <CpiAllocationDiagnostics plan={allocationPlan} />
                  <CpiSettlementOutcomeTable plan={allocationPlan} />
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function CpiPayoffConfirmationCard({
  model,
  openPositions,
  liveNlv,
  riskPctInput,
  onRiskPctChange,
  onApply,
  preview,
  allocationPlan,
  allocationInvalidated = false,
  expiredMonth = false,
  monthLabel = null,
}) {
  const scenarios = getCpiScenarioSpecs(model);
  const openPositionLines = openPositions.map((position) => getCpiPositionLine(position, scenarios));
  const totalContracts = openPositions.reduce((sum, position) => sum + Math.abs(Number(position.quantity || 0)), 0);
  const totalRisk = openPositions.reduce((sum, position) => sum + Number(position.maxLoss || 0), 0);
  const totalMaxProfit = openPositions.reduce((sum, position) => sum + Number(position.maxProfit || 0), 0);
  const totalUnrealizedPnl = openPositions.reduce((sum, position) => {
    const pnl = Number(position.unrealizedPnl);
    return Number.isFinite(pnl) ? sum + pnl : sum;
  }, 0);
  const scenarioColumns = getCpiScenarioExposureColumns(openPositions, openPositionLines, scenarios);
  const largestLine = getLargestCpiOpenLine(openPositions, openPositionLines);
  const netBias = getCpiScenarioBiasLabel(scenarioColumns);
  const marketCount = new Set(openPositions.map((position) => position.symbol).filter(Boolean)).size;

  return (
    <Pmv2CardChrome
      className={`cpi-payoff-card cpi-payday-exposure-card${expiredMonth ? ' cpi-expired-month' : ''}`}
      icon={(
        <img
          className="cpi-payoff-card-icon"
          src={payoutMapTreasureIcon}
          alt=""
        />
      )}
      title={(
        <span className="cpi-card-title-with-help">
          <span>Payday</span>
        </span>
      )}
      titleId="cpi-payoff-title"
      actions={<CpiLineBadgeLegend />}
    >
      {expiredMonth ? (
        <CpiExpiredTableState section="payday" monthLabel={monthLabel} />
      ) : (
        <div className="cpi-payday-planner">
          <CpiRiskBudgetPanel
            liveNlv={liveNlv}
            riskPctInput={riskPctInput}
            onRiskPctChange={onRiskPctChange}
            onApply={onApply}
            preview={preview}
            allocationPlan={allocationPlan}
            allocationInvalidated={allocationInvalidated}
          />
          <CpiAllocationTable plan={allocationPlan} />
          <CpiAllocationDiagnostics plan={allocationPlan} />
          <CpiSettlementOutcomeTable plan={allocationPlan} />
          <section className="cpi-current-positions-section" aria-labelledby="cpi-current-positions-title">
            <header className="cpi-payday-section-heading">
              <div>
                <h3 id="cpi-current-positions-title">Current Positions</h3>
                <span>Existing live portfolio exposure</span>
              </div>
            </header>
            <CpiScenarioExposureBody
              openPositions={openPositions}
              model={model}
              scenarios={scenarios}
              totalContracts={totalContracts}
              totalRisk={totalRisk}
              totalMaxProfit={totalMaxProfit}
              totalUnrealizedPnl={totalUnrealizedPnl}
              scenarioColumns={scenarioColumns}
              largestLine={largestLine}
              netBias={netBias}
              marketCount={marketCount}
              showHeader={false}
              showRail={false}
              compact
            />
          </section>
        </div>
      )}
    </Pmv2CardChrome>
  );
}

function CpiScenarioExposureBody({
  openPositions,
  model,
  scenarios,
  totalContracts,
  totalRisk,
  totalMaxProfit,
  totalUnrealizedPnl,
  scenarioColumns,
  largestLine,
  netBias,
  marketCount,
  showHeader = true,
  showRail = true,
  compact = false,
}) {
  const bodyClasses = [
    'cpi-scenario-exposure-card',
    compact ? 'compact' : '',
    showRail ? '' : 'no-rail',
  ].filter(Boolean).join(' ');
  return (
    <div className={bodyClasses}>
      {showHeader && (
        <header className="cpi-scenario-exposure-header">
          <div>
            <h3>Scenario Exposure</h3>
            <span>CPI prediction market positions</span>
          </div>
          <small>{model?.forecastMonth ? `As of ${model.forecastMonth}` : 'Current book'}</small>
        </header>
      )}
      {openPositions.length === 0 || scenarios.length === 0 ? (
        <div className="cpi-position-empty-panel">
          <CpiMissingDataBox />
        </div>
      ) : compact ? (
        <CpiScenarioExposureTable
          openPositions={openPositions}
          scenarioColumns={scenarioColumns}
          totalContracts={totalContracts}
          totalRisk={totalRisk}
        />
      ) : (
        <div className="cpi-scenario-exposure-layout">
          {showRail && (
            <aside className="cpi-scenario-exposure-rail">
              <div>
                <span>Total Risk</span>
                <strong>{formatCpiMoney(totalRisk, { decimals: 0 })}</strong>
                <small>Max loss at expiration</small>
              </div>
              <div>
                <span>Net Bias</span>
                <strong className="positive">{netBias}</strong>
                <small>{totalUnrealizedPnl < 0 ? 'Working through drawdown' : 'Current P&L positive'}</small>
              </div>
              <div>
                <span>Largest Open Line</span>
                <strong>{largestLine?.line?.title || '–'}</strong>
                {largestLine?.position && (
                  <small>
                    {formatCpiContracts(Math.abs(largestLine.position.quantity || 0))} contracts
                    {' · '}
                    P&L {formatCpiMoney(largestLine.position.unrealizedPnl, { decimals: 0, signed: true })}
                  </small>
                )}
              </div>
              <div>
                <span>Total Positions</span>
                <strong>{openPositions.length}</strong>
                <small>
                  {formatCpiContracts(totalContracts)} contracts
                  {marketCount ? ` across ${marketCount} market${marketCount === 1 ? '' : 's'}` : ''}
                </small>
              </div>
              <div>
                <span>Max Profit</span>
                <strong>{formatCpiMoney(totalMaxProfit, { decimals: 0 })}</strong>
                <small>Entry-price based</small>
              </div>
            </aside>
          )}
            <section className="cpi-scenario-exposure-board">
              {scenarioColumns.map((scenario) => (
                <article className={`cpi-scenario-column ${scenario.tone}`} key={scenario.key}>
                  <header>
                    <span>{scenario.label}</span>
                    <strong>{fmtCpiLevel(scenario.value, 2)} -&gt; {fmtCpiLevel(scenario.roundedValue, 1)}</strong>
                  </header>
                  <div className="cpi-scenario-column-body">
                    <div className="cpi-scenario-position-counts">
                      <span className="win">Win {scenario.winners.length}</span>
                      <span className="loss">Loss {scenario.losers.length}</span>
                    </div>
                    <div className="cpi-scenario-position-list">
                      {[...scenario.winners, ...scenario.losers].map((entry, index) => (
                        <div className={`cpi-scenario-position-chip ${entry.wins ? 'win' : 'loss'}`} key={entry.id}>
                          <span>
                            <span className={`cpi-line-badge ${getCpiLineBadgeTone(entry.line, index)}`}>{index + 1}</span>
                            <strong>{entry.line.title}</strong>
                            <small>{formatCpiContracts(Math.abs(entry.position.quantity || 0))}</small>
                          </span>
                          <b>{formatCpiMoney(entry.payoff, { decimals: 0, signed: true })}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                  <footer>
                    <span>Net Payoff</span>
                    <strong className={scenario.netPayoff >= 0 ? 'positive' : 'negative'}>
                      {formatCpiMoney(scenario.netPayoff, { decimals: 0, signed: true })}
                    </strong>
                    <small>if CPI settles {fmtCpiLevel(scenario.value, 2)} -&gt; {fmtCpiLevel(scenario.roundedValue, 1)}</small>
                  </footer>
                </article>
              ))}
            </section>
          </div>
        )}
      </div>
  );
}

function CpiScenarioExposureTable({
  openPositions,
  scenarioColumns,
  totalContracts,
  totalRisk,
}) {
  return (
    <div className="cpi-payday-table-wrap">
      <table className="cpi-payday-table cpi-matrix-table">
        <thead>
          <tr>
            <th>Position</th>
            {scenarioColumns.map((scenario) => (
              <th key={scenario.key}>
                <strong>{scenario.label}</strong>
                <span>{fmtCpiLevel(scenario.value, 2)} -&gt; {fmtCpiLevel(scenario.roundedValue, 1)}</span>
              </th>
            ))}
            <th>Qty</th>
            <th>Avg<br />(c)</th>
            <th>Risk</th>
          </tr>
        </thead>
        <tbody>
          {openPositions.map((position, index) => {
            const firstEntry = scenarioColumns[0]?.entries?.[index];
            const line = firstEntry?.line || getCpiPositionLine(position, []);
            return (
              <tr key={position.id || `${line.title}-${index}`}>
                <td className="cpi-matrix-contract-cell">
                  <span className="cpi-matrix-contract-inner">
                    <CpiLineBadge tone={getCpiLineBadgeTone(line, index)}>{index + 1}</CpiLineBadge>
                    <strong>{line.title}</strong>
                  </span>
                </td>
                {scenarioColumns.map((scenario) => {
                  const entry = scenario.entries[index];
                  const tone = entry?.wins ? 'win' : 'loss';
                  return (
                    <td key={`${scenario.key}-${position.id || index}`} className={`cpi-payday-scenario-cell ${tone}`}>
                      <span className={`cpi-payday-payoff-pill ${tone}`}>
                        <span>{entry?.wins ? 'Win' : 'Loss'}</span>
                        <strong>{formatCpiMoney(entry?.payoff, { decimals: 0, signed: true })}</strong>
                      </span>
                    </td>
                  );
                })}
                <td>{formatCpiContracts(Math.abs(position.quantity || 0))}</td>
                <td>
                  {formatCpiCents(line.ask)}
                  {line.askLabel === 'Avg' && <small className="cpi-matrix-sub">avg</small>}
                </td>
                <td>{formatCpiMoney(position.maxLoss, { decimals: 0 })}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>Net Payoff</td>
            {scenarioColumns.map((scenario) => (
              <td
                key={`${scenario.key}-net`}
                className={scenario.netPayoff >= 0 ? 'edge-positive' : 'edge-negative'}
              >
                <strong>{formatCpiMoney(scenario.netPayoff, { decimals: 0, signed: true })}</strong>
              </td>
            ))}
            <td>{formatCpiContracts(totalContracts)}</td>
            <td>–</td>
            <td>{formatCpiMoney(totalRisk, { decimals: 0 })}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Main Component (v2) ──────────────────────────────────────────────────────

export default function PredictionMarkets({
  onApiStatusChange,
  onClose,
  portfolioData,
  sharedPositionsState,
  embedded = false,
}) {
  const persistedWorkbenchState = useMemo(readPredictionMarketsWorkbenchState, []);
  const [selectedId, setSelectedId] = useState(() => persistedWorkbenchState.selectedId || null);
  const [contracts, setContracts] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [analytics, setAnalytics] = useState(null);
  const [risk, setRisk] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ingestLoading, setIngestLoading] = useState(false);
  const [apiStatus, setApiStatus] = useState('loading');
  const [loadError, setLoadError] = useState(null);
  const [marketEvents, setMarketEvents] = useState([]);
  const [cpiProviderEvents, setCpiProviderEvents] = useState([]);
  const [providers, setProviders] = useState(null);
  const [ingestError, setIngestError] = useState(null);
  const [signalsLoading, setSignalsLoading] = useState(true);
  const [signalsError, setSignalsError] = useState(null);
  const [selectedSignalSymbol, setSelectedSignalSymbol] = useState(() => persistedWorkbenchState.selectedSignalSymbol || null);
  const [signalData, setSignalData] = useState({
    riskRanges: {},
    canonicalResearch: null,
    bitcoinSnapshot: null,
    momoSnapshot: null,
    macroSnapshot: null,
    callSnapshot: null,
    inflationNowcastSnapshot: null,
    spotPrices: {},
  });

  const [ibkrLoading, setIbkrLoading] = useState(false);
  const [ibkrDiscovering, setIbkrDiscovering] = useState(false);
  const [uploadFreshness, setUploadFreshness] = useState(null);
  const [portfolioPredictionPositions, setPortfolioPredictionPositions] = useState([]);
  const [portfolioPredictionPositionsLive, setPortfolioPredictionPositionsLive] = useState(false);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [activeCpiMonth, setActiveCpiMonth] = useState(() => getPersistedCpiMonth(persistedWorkbenchState));
  const [cpiRiskPctInput, setCpiRiskPctInput] = useState(() => (
    getPersistedCpiRiskPct(persistedWorkbenchState).toFixed(2)
  ));
  const [cpiAllocationRequest, setCpiAllocationRequest] = useState(null);
  const [cpiAllocationInvalidated, setCpiAllocationInvalidated] = useState(false);
  const [cpiAllocationClock, setCpiAllocationClock] = useState(() => Date.now());
  const [cpiOfficialFinals, setCpiOfficialFinals] = useState([]);
  const [cpiNowcastHistory, setCpiNowcastHistory] = useState({ entries: [] });
  const [cpiBenchmarkState, setCpiBenchmarkState] = useState({
    period: null,
    payload: null,
    loading: false,
    error: null,
  });
  const [currentCpiRelease, setCurrentCpiRelease] = useState(null);
  const [currentCpiReleaseError, setCurrentCpiReleaseError] = useState(null);
  const ibkrBusyRef = useRef(false);
  const cpiOfficialRetryTimerRef = useRef(null);
  const currentCpiReleaseRef = useRef(null);
  const lastCpiReleaseKeyRef = useRef(null);
  const userSelectedCpiMonthRef = useRef(Boolean(persistedWorkbenchState.activeCpiMonthId));

  const normalizedCpiNowcast = useMemo(
    () => normalizeCpiNowcast(signalData.inflationNowcastSnapshot),
    [signalData.inflationNowcastSnapshot],
  );
  const sourceCpiMonth = useMemo(
    () => normalizedCpiNowcast.ok
      ? getCpiMonthFromLabel(normalizedCpiNowcast.model?.forecastMonth)
      : null,
    [normalizedCpiNowcast],
  );
  const operationalCpiMonth = useMemo(
    () => getCpiMonthFromId(currentCpiRelease?.reportMonth),
    [currentCpiRelease?.reportMonth],
  );
  const currentCpiNowcast = useMemo(() => {
    if (!currentCpiRelease?.scenarios?.length || !currentCpiRelease?.forecastMonth) return null;
    return normalizeCpiNowcast({
      publishedAt: currentCpiRelease.source?.asOf || null,
      data: {
        metric: currentCpiRelease.metric || 'Headline CPI YoY',
        forecastMonth: currentCpiRelease.forecastMonth,
        releaseDate: currentCpiRelease.releaseAt || currentCpiRelease.releaseDate || null,
        scenarios: currentCpiRelease.scenarios,
      },
    });
  }, [currentCpiRelease]);
  const cpiCalendarNowcastHistory = useMemo(() => {
    const entries = Array.isArray(cpiNowcastHistory?.entries)
      ? [...cpiNowcastHistory.entries]
      : [];
    if (currentCpiNowcast?.ok && operationalCpiMonth?.id) {
      const model = currentCpiNowcast.model;
      const scenarios = model.scenarios || [];
      const raw = {
        upper: Number(scenarios.find((scenario) => scenario.key === 'upside')?.value),
        base: Number(scenarios.find((scenario) => scenario.key === 'base')?.value),
        lower: Number(scenarios.find((scenario) => scenario.key === 'downside')?.value),
      };
      if ([raw.upper, raw.base, raw.lower].every(Number.isFinite)) {
        const replacement = {
          id: operationalCpiMonth.id,
          monthId: operationalCpiMonth.id,
          releaseAt: currentCpiRelease?.releaseAt || model.releaseDate || null,
          status: 'provisional',
          publishedAt: currentCpiRelease?.source?.asOf || model.publishedText || null,
          source: currentCpiRelease?.source || null,
          scenarios: {
            raw,
            rounded: {
              upper: roundCpiSettlementLevel(raw.upper),
              base: roundCpiSettlementLevel(raw.base),
              lower: roundCpiSettlementLevel(raw.lower),
            },
          },
        };
        const index = entries.findIndex((entry) => (entry?.id || entry?.monthId) === operationalCpiMonth.id);
        if (index >= 0) entries[index] = { ...entries[index], ...replacement };
        else entries.push(replacement);
      }
    }
    return { ...cpiNowcastHistory, entries };
  }, [cpiNowcastHistory, currentCpiNowcast, currentCpiRelease?.releaseAt, currentCpiRelease?.source?.asOf, operationalCpiMonth]);
  const cpiMonths = useMemo(() => {
    const anchor = [operationalCpiMonth, activeCpiMonth, sourceCpiMonth]
      .filter(Boolean)
      .sort((left, right) => left.id.localeCompare(right.id))
      .at(-1);
    return anchor
      ? getCpiMonthOptions({ year: anchor.year, month: anchor.month })
      : DEFAULT_CPI_MONTH_OPTIONS;
  }, [activeCpiMonth, operationalCpiMonth, sourceCpiMonth]);

  const cpiCalendarEntries = useMemo(
    () => buildCpiCalendarEntries({
      officialFinals: cpiOfficialFinals,
      nowcastHistory: cpiCalendarNowcastHistory,
      forecastMonth: operationalCpiMonth || sourceCpiMonth,
      forecastReleaseDate: currentCpiRelease?.releaseAt || normalizedCpiNowcast.model?.releaseDate,
      anchorMonths: [operationalCpiMonth, activeCpiMonth],
    }),
    [activeCpiMonth, cpiCalendarNowcastHistory, cpiOfficialFinals, currentCpiRelease?.releaseAt, normalizedCpiNowcast.model?.releaseDate, operationalCpiMonth, sourceCpiMonth],
  );

  const activeCpiCalendarEntry = useMemo(
    () => cpiCalendarEntries.find((entry) => entry.id === activeCpiMonth?.id) || null,
    [activeCpiMonth?.id, cpiCalendarEntries],
  );
  const activeCpiMonthExpired = isCpiMonthExpired(activeCpiCalendarEntry, Date.now());

  useEffect(() => {
    const period = activeCpiMonth?.id || null;
    if (!period) {
      setCpiBenchmarkState({ period: null, payload: null, loading: false, error: null });
      return undefined;
    }
    let disposed = false;
    const load = async () => {
      setCpiBenchmarkState({ period, payload: null, loading: true, error: null });
      try {
        if (typeof predictionMarketsIngestService.getCpiBenchmarks !== 'function') {
          throw new Error('CPI benchmark service is unavailable.');
        }
        const response = await predictionMarketsIngestService.getCpiBenchmarks(period);
        if (
          response?.period !== period
          || response?.metric !== 'headline-cpi-yoy'
          || response?.unit !== 'percent'
        ) {
          throw new Error('CPI benchmark response did not match the selected month and metric.');
        }
        if (!disposed) {
          setCpiBenchmarkState({
            period,
            payload: normalizeCpiBenchmarkPayload(response, period),
            loading: false,
            error: null,
          });
        }
      } catch (error) {
        if (!disposed) {
          setCpiBenchmarkState({
            period,
            payload: null,
            loading: false,
            error: error?.message || 'Verified CPI benchmark data is unavailable.',
          });
        }
      }
    };

    load();
    const intervalId = !activeCpiMonthExpired
      ? window.setInterval(load, CPI_BENCHMARK_REFRESH_INTERVAL_MS)
      : null;
    return () => {
      disposed = true;
      if (intervalId != null) window.clearInterval(intervalId);
    };
  }, [activeCpiMonth?.id, activeCpiMonthExpired]);

  useEffect(() => {
    const preferredMonth = operationalCpiMonth || sourceCpiMonth;
    if (
      preferredMonth &&
      !userSelectedCpiMonthRef.current &&
      activeCpiMonth?.id !== preferredMonth.id
    ) {
      setActiveCpiMonth(preferredMonth);
    }
  }, [activeCpiMonth?.id, operationalCpiMonth, sourceCpiMonth]);

  useEffect(() => {
    const releaseKey = currentCpiRelease?.releaseKey || null;
    if (!releaseKey) return;
    const previousReleaseKey = lastCpiReleaseKeyRef.current;
    if (previousReleaseKey && previousReleaseKey !== releaseKey && operationalCpiMonth) {
      // A canonical release-key change is the only event that may override a
      // persisted historical selection. This prevents July rows from
      // surviving the official 8:30 AM ET rollover into August.
      userSelectedCpiMonthRef.current = false;
      setActiveCpiMonth(operationalCpiMonth);
    }
    lastCpiReleaseKeyRef.current = releaseKey;
  }, [currentCpiRelease?.releaseKey, operationalCpiMonth]);

  const selectCpiMonth = useCallback((month) => {
    userSelectedCpiMonthRef.current = true;
    setActiveCpiMonth(month);
  }, []);

  useEffect(() => {
    ibkrBusyRef.current = ibkrLoading || ibkrDiscovering;
  }, [ibkrLoading, ibkrDiscovering]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setCpiAllocationClock(Date.now()), 15000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    writePredictionMarketsWorkbenchState({
      selectedId,
      selectedSignalSymbol,
      activeCpiMonthId: activeCpiMonth?.id || null,
      cpiRiskPct: parseCpiRiskPct(cpiRiskPctInput),
    });
  }, [activeCpiMonth, cpiRiskPctInput, selectedId, selectedSignalSymbol]);

  const loadPortfolioPredictionPositions = useCallback(async () => {
    if (sharedPositionsState) {
      const sharedLive = ['live', 'partial'].includes(sharedPositionsState.status);
      const sharedPositions = sharedLive && Array.isArray(sharedPositionsState.positions)
        ? sharedPositionsState.positions
        : [];
      setPortfolioPredictionPositions(sharedPositions);
      setPortfolioPredictionPositionsLive(sharedLive);
      setPositionsLoading(sharedPositionsState.status === 'loading');
      return sharedPositionsState;
    }
    setPositionsLoading(true);
    try {
      const data = await MarketDataService.getPortfolioPredictionMarketPositions({
        primaryAccount: portfolioData?.accountId || null,
      });
      const positions = Array.isArray(data?.positions) ? data.positions : [];
      const liveSource = data?.meta?.source === 'ibkr_live';
      setPortfolioPredictionPositions(liveSource ? positions : []);
      setPortfolioPredictionPositionsLive(liveSource);
      return data;
    } catch (err) {
      console.warn('[PM] portfolio prediction positions load error:', err.message);
      setPortfolioPredictionPositions([]);
      setPortfolioPredictionPositionsLive(false);
      return null;
    } finally {
      setPositionsLoading(false);
    }
  }, [portfolioData?.accountId, sharedPositionsState]);

  const loadIbkr = useCallback(async (requestBody = {}) => {
    if (ibkrBusyRef.current) return null;
    ibkrBusyRef.current = true;
    setIbkrLoading(true);
    setIngestError(null);
    try {
      const data = await predictionMarketsIngestService.refreshIbkr(requestBody);
      const liveProvider = isLiveCpiContractProvider(data.providers);
      const newEvents = liveProvider
        ? filterIbkrWorkbenchEvents(data.events || data.dashboardEvents || [])
            .filter((event) => isLiveTradingEvent(event))
        : [];
      const providerEvents = liveProvider
        ? filterIbkrWorkbenchEvents(data.providerEvents || data.events || data.dashboardEvents || [])
            .filter((event) => isLiveTradingEvent(event))
        : [];
      setMarketEvents(newEvents);
      setCpiProviderEvents(providerEvents);
      if (data.providers) setProviders(data.providers);
      await loadPortfolioPredictionPositions();
    } catch (err) {
      console.warn('[PM] IBKR refresh error:', err.message);
      setIngestError(err.message);
      // A transport failure is not evidence that the previously verified
      // contracts vanished. Keep them mounted; their own provider timestamps
      // and the next confirmed provider response govern availability.
    } finally {
      ibkrBusyRef.current = false;
      setIbkrLoading(false);
    }
  }, [loadPortfolioPredictionPositions]);

  const discoverIbkr = useCallback(async (requestBody = {}) => {
    if (ibkrBusyRef.current) return null;
    ibkrBusyRef.current = true;
    setIbkrDiscovering(true);
    setIngestError(null);
    try {
      const data = await predictionMarketsIngestService.discoverIbkr(requestBody);
      const liveProvider = isLiveCpiContractProvider(data.providers);
      const newEvents = liveProvider
        ? filterIbkrWorkbenchEvents(data.events || data.dashboardEvents || [])
            .filter((event) => isLiveTradingEvent(event))
        : [];
      const providerEvents = liveProvider
        ? filterIbkrWorkbenchEvents(data.providerEvents || data.events || data.dashboardEvents || [])
            .filter((event) => isLiveTradingEvent(event))
        : [];
      setMarketEvents(newEvents);
      setCpiProviderEvents(providerEvents);
      if (data.providers) setProviders(data.providers);
      await loadPortfolioPredictionPositions();
    } catch (err) {
      console.warn('[PM] IBKR discovery error:', err.message);
      setIngestError(err.message);
    } finally {
      ibkrBusyRef.current = false;
      setIbkrDiscovering(false);
    }
  }, [loadPortfolioPredictionPositions]);

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
    if (SECURITY_INTELLIGENCE_V2_ENABLED) {
      setSignalData((current) => ({
        riskRanges: {},
        canonicalResearch: null,
        bitcoinSnapshot: null,
        momoSnapshot: null,
        macroSnapshot: null,
        callSnapshot: null,
        inflationNowcastSnapshot: current.inflationNowcastSnapshot,
        spotPrices: {},
      }));
    }
    try {
      // Published Trade comes from all indexed products in the canonical
      // projection, independently of the legacy Risk Range display flag.
      const canonicalPayload = await loadCanonicalSecurityUniverse().catch(() => null);
      const riskRanges = SECURITY_INTELLIGENCE_V2_ENABLED
        ? buildCanonicalRiskRangeMap(canonicalPayload, { primaryOnly: true })
        : await MarketDataService.getRiskRanges().catch(err => {
          console.warn('[PM] risk range signal load error:', err);
          return {};
        });
      const quotePlan = getMacroSignalQuotePlan(riskRanges || {}, canonicalPayload);
      const quoteTickers = [...new Set(quotePlan.map(entry => entry.quote))];

      const [bitcoinSnapshot, momoSnapshot, macroSnapshot, callSnapshot, freshness] = await Promise.all([
        SECURITY_INTELLIGENCE_V2_ENABLED
          ? Promise.resolve(buildCanonicalTrackerSnapshot(canonicalPayload, 'bitcoin-trend-tracker'))
          : MarketDataService.getHedgeyeSnapshot('bitcoin-trend-tracker').catch(err => {
            console.warn('[PM] bitcoin tracker signal load error:', err);
            return null;
          }),
        SECURITY_INTELLIGENCE_V2_ENABLED
          ? Promise.resolve(buildCanonicalTrackerSnapshot(canonicalPayload, 'momo-tracker'))
          : MarketDataService.getHedgeyeSnapshot('momo-tracker').catch(err => {
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
        MarketDataService.getHedgeyeFreshness().catch(err => {
          console.warn('[PM] hedgeye freshness load error:', err);
          return null;
        }),
      ]);

      setSignalData((current) => ({
        ...current,
        riskRanges: riskRanges || {},
        canonicalResearch: canonicalPayload,
        bitcoinSnapshot,
        momoSnapshot,
        macroSnapshot,
        callSnapshot,
        spotPrices: {},
      }));
      setUploadFreshness(freshness?.dataTypes ?? null);

      if (!quoteTickers.length) return;

      MarketDataService.getQuotes(quoteTickers).then((rawSpotPrices) => {
        const spotPrices = {};
        for (const { display, quote } of quotePlan) {
          const q = rawSpotPrices?.[quote] ?? rawSpotPrices?.[quote.toUpperCase()];
          if (q) spotPrices[display] = q;
        }
        setSignalData((current) => ({
          ...current,
          spotPrices,
        }));
      }).catch(err => {
        console.warn('[PM] spot price quote load error:', err);
      });
    } catch (err) {
      console.error('[PM] signal context load error:', err);
      setSignalsError(err.message || 'Failed to load signal context');
    } finally {
      setSignalsLoading(false);
    }
  }, []);

  const loadCpiNowcastData = useCallback(async () => {
    const historyRequest = typeof MarketDataService.getHedgeyeInflationNowcastHistory === 'function'
      ? MarketDataService.getHedgeyeInflationNowcastHistory({ from: '2025-07' })
      : Promise.resolve({ entries: [] });
    const [snapshotResult, historyResult] = await Promise.allSettled([
      MarketDataService.getHedgeyeSnapshot('inflation-nowcast', CPI_MODEL_NOWCAST_DATE),
      historyRequest,
    ]);
    if (snapshotResult.status === 'fulfilled') {
      setSignalData((current) => ({
        ...current,
        inflationNowcastSnapshot: snapshotResult.value,
      }));
    } else {
      console.warn('[PM] inflation nowcast signal load error:', snapshotResult.reason);
    }
    if (historyResult.status === 'fulfilled') {
      setCpiNowcastHistory(historyResult.value || { entries: [] });
    } else {
      console.warn('[PM] inflation nowcast history load error:', historyResult.reason);
      setCpiNowcastHistory({ entries: [] });
    }
  }, []);

  const loadCpiOfficialFinals = useCallback(async () => {
    if (typeof predictionMarketsIngestService.getCpiOfficialFinals !== 'function') return null;
    try {
      const response = await predictionMarketsIngestService.getCpiOfficialFinals();
      const finals = normalizeCpiOfficialFinals(response);
      setCpiOfficialFinals(finals);
      return { ...response, finals };
    } catch (err) {
      console.warn('[PM] official CPI finals load error:', err.message);
      return {
        ok: false,
        finals: [],
        refreshing: false,
        remoteStatus: 'unavailable',
      };
    }
  }, []);

  const loadCurrentCpiRelease = useCallback(async () => {
    setIngestLoading(true);
    try {
      const current = await predictionMarketsIngestService.getCurrentCpiRelease();
      if (!current?.ok || !current?.releaseKey || !current?.request?.cpi) {
        throw new Error(current?.error || 'Current CPI release is unavailable.');
      }
      currentCpiReleaseRef.current = current;
      setCurrentCpiRelease(current);
      setCurrentCpiReleaseError(null);
      if (current.providers) setProviders(current.providers);
      const rows = isLiveCpiContractProvider(current.providers)
        ? filterIbkrWorkbenchEvents(current.events || current.dashboardEvents || [])
            .filter((event) => isLiveTradingEvent(event))
        : [];
      const providerRows = isLiveCpiContractProvider(current.providers)
        ? filterIbkrWorkbenchEvents(current.providerEvents || current.events || current.dashboardEvents || [])
            .filter((event) => isLiveTradingEvent(event))
        : [];
      setMarketEvents(rows);
      setCpiProviderEvents(providerRows);
    } catch (err) {
      console.warn('[PM] current CPI release load error:', err.message);
      setCurrentCpiReleaseError(err.message || 'Current CPI release is unavailable.');
      const previous = currentCpiReleaseRef.current;
      const previousReleaseAt = cpiReleaseTimestamp(previous?.releaseAt || previous?.releaseDate || '');
      if (Number.isFinite(previousReleaseAt) && previousReleaseAt <= Date.now()) {
        // Once the official release timestamp has passed, an unavailable
        // next-month forecast must clear the outgoing ladder rather than
        // leave stale July contracts mounted.
        currentCpiReleaseRef.current = null;
        setCurrentCpiRelease(null);
        setMarketEvents([]);
        setCpiProviderEvents([]);
        setProviders(null);
      }
    } finally {
      setIngestLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { loadCpiNowcastData(); }, [loadCpiNowcastData]);
  useEffect(() => {
    let disposed = false;
    let retryAttempt = 0;

    const schedule = (delay) => {
      if (disposed) return;
      cpiOfficialRetryTimerRef.current = window.setTimeout(run, delay);
    };

    const run = async () => {
      const response = await loadCpiOfficialFinals();
      if (disposed) return;
      const finals = response?.finals || [];
      const refreshing = response?.refreshing === true || response?.remoteStatus === 'refreshing';
      const pendingReleasedFinal = hasPendingCpiOfficialFinal(finals);
      const remoteUnavailable = response?.remoteStatus === 'unavailable' || response?.ok === false;
      if (refreshing || pendingReleasedFinal || remoteUnavailable) {
        const delay = CPI_OFFICIAL_RETRY_DELAYS_MS[Math.min(retryAttempt, CPI_OFFICIAL_RETRY_DELAYS_MS.length - 1)];
        retryAttempt += 1;
        schedule(delay);
        return;
      }
      retryAttempt = 0;
      schedule(CPI_OFFICIAL_REFRESH_INTERVAL_MS);
    };

    run();
    return () => {
      disposed = true;
      if (cpiOfficialRetryTimerRef.current != null) {
        window.clearTimeout(cpiOfficialRetryTimerRef.current);
        cpiOfficialRetryTimerRef.current = null;
      }
    };
  }, [loadCpiOfficialFinals]);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (!disposed) loadCurrentCpiRelease();
    };
    refresh();
    const intervalId = window.setInterval(refresh, CPI_RELEASE_REFRESH_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [loadCurrentCpiRelease]);
  useEffect(() => {
    const releaseAt = cpiReleaseTimestamp(currentCpiRelease?.releaseAt || currentCpiRelease?.releaseDate || '');
    if (!Number.isFinite(releaseAt)) return undefined;
    const delay = releaseAt <= Date.now()
      ? 0
      : Math.min(releaseAt - Date.now() + 50, CPI_RELEASE_REFRESH_INTERVAL_MS);
    const timerId = window.setTimeout(() => loadCurrentCpiRelease(), delay);
    return () => window.clearTimeout(timerId);
  }, [currentCpiRelease?.releaseAt, currentCpiRelease?.releaseDate, loadCurrentCpiRelease]);
  useEffect(() => { loadSignalData(); }, [loadSignalData]);
  useEffect(() => { loadPortfolioPredictionPositions(); }, [loadPortfolioPredictionPositions]);
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
    canonicalResearch: signalData.canonicalResearch,
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
    if (
      !signalsLoading &&
      selectedSignalSymbol &&
      signalContext.rows.length > 0 &&
      !signalContext.rows.some(row => row.symbol === selectedSignalSymbol)
    ) {
      setSelectedSignalSymbol(null);
    }
  }, [selectedSignalSymbol, signalContext, signalsLoading]);

  const heldPredictionPositions = useMemo(
    () => {
      const liveEndpointPositions = portfolioPredictionPositionsLive && Array.isArray(portfolioPredictionPositions)
        ? portfolioPredictionPositions
        : [];
      const livePortfolioHoldings = !sharedPositionsState && portfolioData?.dataSource === 'ibkr_api'
        ? getHeldPredictionMarketPositions(portfolioData)
        : [];
      return dedupeHeldPredictionMarketPositions([
        ...liveEndpointPositions,
        ...livePortfolioHoldings,
      ]);
    },
    [portfolioData, portfolioPredictionPositions, portfolioPredictionPositionsLive, sharedPositionsState],
  );

  const cpiNowcastResult = useMemo(() => {
    if (
      currentCpiNowcast?.ok
      && signalData.inflationNowcastSnapshot
      && operationalCpiMonth?.id === activeCpiMonth?.id
    ) {
      return {
        ...currentCpiNowcast,
        sourceModel: currentCpiNowcast.model,
      };
    }
    const historyEntry = normalizeCpiNowcastHistory(cpiNowcastHistory)
      .find((entry) => entry.id === activeCpiMonth?.id && entry.scenarios);
    if (signalData.inflationNowcastSnapshot && historyEntry?.scenarios) {
      const historyNowcast = normalizeCpiNowcast({
        publishedAt: historyEntry.publishedAt,
        data: {
          metric: 'Headline CPI YoY',
          forecastMonth: activeCpiMonth?.fullLabel,
          releaseDate: historyEntry.releaseAt,
          scenarios: [
            { key: 'upside', label: 'Upside', value: historyEntry.scenarios.raw.upper },
            { key: 'base', label: 'Base Case', value: historyEntry.scenarios.raw.base },
            { key: 'downside', label: 'Downside', value: historyEntry.scenarios.raw.lower },
          ],
        },
      });
      if (historyNowcast.ok) {
        return { ...historyNowcast, sourceModel: historyNowcast.model };
      }
    }
    if (!normalizedCpiNowcast.ok) return normalizedCpiNowcast;
    if (!sourceCpiMonth || sourceCpiMonth.id !== activeCpiMonth?.id) {
      return {
        ok: false,
        reason: 'forecast_month_mismatch',
        message: `No source-matched Hedgeye CPI nowcast is available for ${activeCpiMonth?.fullLabel || 'the selected month'}.`,
        model: null,
        sourceModel: normalizedCpiNowcast.model,
      };
    }
    return {
      ...normalizedCpiNowcast,
      sourceModel: normalizedCpiNowcast.model,
    };
  }, [activeCpiMonth?.fullLabel, activeCpiMonth?.id, cpiNowcastHistory, currentCpiNowcast, normalizedCpiNowcast, operationalCpiMonth, signalData.inflationNowcastSnapshot, sourceCpiMonth]);

  const cpiAutoRefreshRequest = useMemo(
    () => (
      cpiNowcastResult.ok
      && !activeCpiMonthExpired
      && currentCpiRelease?.request?.cpi?.targetStrikes?.length
        ? {}
        : null
    ),
    [activeCpiMonthExpired, cpiNowcastResult.ok, currentCpiRelease],
  );

  useEffect(() => {
    if (!cpiAutoRefreshRequest) return undefined;
    let cancelled = false;
    const refresh = () => {
      if (cancelled || ibkrBusyRef.current) return;
      loadIbkr(cpiAutoRefreshRequest);
    };
    refresh();
    const intervalId = window.setInterval(refresh, 45000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [cpiAutoRefreshRequest, loadIbkr]);

  const refreshCpiContracts = useCallback(
    () => currentCpiRelease ? loadIbkr({}) : Promise.resolve(null),
    [currentCpiRelease, loadIbkr],
  );

  const discoverCpiContracts = useCallback(
    () => currentCpiRelease ? discoverIbkr({}) : Promise.resolve(null),
    [currentCpiRelease, discoverIbkr],
  );

  const cpiPositions = useMemo(
    () => summarizeCpiPositions(heldPredictionPositions, activeCpiMonth),
    [activeCpiMonth, heldPredictionPositions],
  );

  const cpiContractEvents = useMemo(() => {
    const merged = events
      .filter((event) => isLiveTradingEvent(event, cpiAllocationClock))
      .filter((event) => isCpiContractForMonth(event, activeCpiMonth));
    const seen = new Set();
    return merged.filter((event) => {
      const key = event?.id || event?.conid || event?.question || event?.contract_title;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [activeCpiMonth, cpiAllocationClock, events]);

  const cpiDisplayContractEvents = useMemo(() => {
    const liveRows = cpiProviderEvents
      .filter((event) => isLiveTradingEvent(event, cpiAllocationClock))
      .filter((event) => isCpiContractForMonth(event, activeCpiMonth));
    const seen = new Set();
    return liveRows.filter((event) => {
      const key = event?.id || event?.conid || event?.question || event?.contract_title;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [activeCpiMonth, cpiAllocationClock, cpiProviderEvents]);

  const cpiLiveQuoteObservedAt = useMemo(() => {
    if (activeCpiMonthExpired || !isLiveCpiContractProvider(providers)) return null;
    return cpiDisplayContractEvents.reduce((latest, event) => {
      const observedAt = Date.parse(event?.updated_at || '');
      if (!Number.isFinite(observedAt)) return latest;
      return latest == null || observedAt > latest ? observedAt : latest;
    }, null);
  }, [activeCpiMonthExpired, cpiDisplayContractEvents, providers]);

  const cpiLiveNlv = useMemo(
    () => getCpiAccountValue(portfolioData, new Date(cpiAllocationClock)),
    [cpiAllocationClock, portfolioData],
  );

  const cpiSizingSettings = useMemo(() => ({
    ...settings,
    // Stored/manual equity is never valid for an active CPI trade size. Fail
    // closed unless the portfolio provider identifies a live IBKR snapshot.
    portfolioEquity: cpiLiveNlv,
  }), [cpiLiveNlv, settings]);

  const cpiContractRows = useMemo(
    () => !activeCpiMonthExpired && cpiNowcastResult.ok && isLiveCpiContractProvider(providers) && cpiContractEvents.length > 0
      ? buildCpiContractLadder(cpiContractEvents, cpiNowcastResult.model, cpiSizingSettings, activeCpiMonth)
      : [],
    [activeCpiMonth, activeCpiMonthExpired, cpiNowcastResult, providers, cpiContractEvents, cpiSizingSettings],
  );

  const cpiDisplayContractRows = useMemo(
    () => !activeCpiMonthExpired && cpiNowcastResult.ok && isLiveCpiContractProvider(providers) && cpiDisplayContractEvents.length > 0
      ? buildCpiContractLadder(
          cpiDisplayContractEvents,
          cpiNowcastResult.model,
          { ...cpiSizingSettings, portfolioEquity: null },
          activeCpiMonth,
          { scope: 'all-live' },
        )
      : [],
    [
      activeCpiMonth,
      activeCpiMonthExpired,
      cpiDisplayContractEvents,
      cpiNowcastResult,
      cpiSizingSettings,
      providers,
    ],
  );

  const cpiPositiveVolumeRows = useMemo(
    () => selectCpiPositiveVolumeRows(cpiDisplayContractRows),
    [cpiDisplayContractRows],
  );

  const cpiDisplayProbabilityCurve = useMemo(
    () => buildCpiCalibratedProbabilityCurve({
      model: cpiNowcastResult.model,
      history: cpiNowcastHistory,
      finals: cpiOfficialFinals,
      rows: cpiPositiveVolumeRows,
    }),
    [cpiNowcastHistory, cpiNowcastResult.model, cpiOfficialFinals, cpiPositiveVolumeRows],
  );

  const cpiScenarioMatrixRows = useMemo(
    () => getCpiScenarioMatrixRows(cpiPositiveVolumeRows, cpiNowcastResult.model, cpiDisplayProbabilityCurve),
    [cpiDisplayProbabilityCurve, cpiNowcastResult.model, cpiPositiveVolumeRows],
  );

  const cpiRiskPct = parseCpiRiskPct(cpiRiskPctInput);
  const cpiCurrentOpenRisk = Number.isFinite(Number(risk?.totalMaxLoss ?? analytics?.totalOpenRisk))
    ? Number(risk?.totalMaxLoss ?? analytics?.totalOpenRisk)
    : null;
  const cpiAllocationSignature = useMemo(
    () => getCpiAllocationSignature({
      model: cpiNowcastResult.model,
      rows: cpiContractRows,
      history: cpiNowcastHistory,
      finals: cpiOfficialFinals,
      positions: cpiPositions,
      liveNlv: cpiLiveNlv,
      riskPct: cpiRiskPct,
      settings: cpiSizingSettings,
      currentOpenRisk: cpiCurrentOpenRisk,
      providers,
    }),
    [
      cpiContractRows,
      cpiCurrentOpenRisk,
      cpiLiveNlv,
      cpiNowcastHistory,
      cpiNowcastResult.model,
      cpiOfficialFinals,
      cpiPositions,
      cpiRiskPct,
      cpiSizingSettings,
      providers,
    ],
  );
  const cpiAllocationPreview = useMemo(
    () => buildCpiAllocationModel({
      model: cpiNowcastResult.model,
      history: cpiNowcastHistory,
      finals: cpiOfficialFinals,
      rows: cpiContractRows,
      openPositions: cpiPositions,
      portfolioEquity: cpiLiveNlv,
      riskPct: cpiRiskPct,
      settings: cpiSizingSettings,
      currentOpenRisk: cpiCurrentOpenRisk,
      providerReady: isLiveCpiContractProvider(providers),
      now: cpiAllocationClock,
    }),
    [
      cpiAllocationClock,
      cpiContractRows,
      cpiCurrentOpenRisk,
      cpiLiveNlv,
      cpiNowcastHistory,
      cpiNowcastResult.model,
      cpiOfficialFinals,
      cpiPositions,
      cpiRiskPct,
      cpiSizingSettings,
      providers,
    ],
  );
  const cpiAllocationPlan = cpiAllocationRequest?.signature === cpiAllocationSignature
    && cpiAllocationPreview.status === 'ready'
    ? cpiAllocationPreview
    : null;

  useEffect(() => {
    if (
      cpiAllocationRequest &&
      (
        cpiAllocationRequest.signature !== cpiAllocationSignature ||
        cpiAllocationPreview.status !== 'ready'
      )
    ) {
      setCpiAllocationRequest(null);
      setCpiAllocationInvalidated(true);
    }
  }, [cpiAllocationPreview.status, cpiAllocationRequest, cpiAllocationSignature]);

  const updateCpiRiskPctInput = useCallback((value) => {
    setCpiRiskPctInput(value);
    if (cpiAllocationRequest) setCpiAllocationInvalidated(true);
    setCpiAllocationRequest(null);
  }, [cpiAllocationRequest]);

  const applyCpiAllocation = useCallback(() => {
    if (cpiAllocationPreview.status !== 'ready') return;
    setCpiAllocationRequest({
      signature: cpiAllocationSignature,
      riskPct: cpiRiskPct,
    });
    setCpiAllocationInvalidated(false);
  }, [cpiAllocationPreview.status, cpiAllocationSignature, cpiRiskPct]);

  const contractMapEvents = useMemo(
    () => mergeHeldPredictionEvents(
      getContractsForSignal(selectedSignal, filteredEvents),
      heldPredictionPositions,
    ),
    [filteredEvents, heldPredictionPositions, selectedSignal],
  );

  const selectedEvent = useMemo(
    () => contractMapEvents.find(e => getEventKey(e) === selectedId) || null,
    [contractMapEvents, selectedId],
  );

  void analytics;
  void risk;
  void macroSignalViews;
  void selectedEvent;
  void setSelectedId;
  void onClose;
  void embedded;

  return (
    <div className="pmv2-wrap pmv2-redesign">
      {(ingestError || loadError) && (
        <div className="pmv2-error-banner">
          {ingestError || loadError}
          <RefreshButton label="Retry" onClick={() => { loadData(); loadCurrentCpiRelease(); }} />
        </div>
      )}
      <div className="cpi-workbench-shell">
        <CpiCalculatorHeader
          activeMonth={activeCpiMonth}
          calendarEntries={cpiCalendarEntries}
          liveQuoteObservedAt={cpiLiveQuoteObservedAt}
          loading={loading || ingestLoading || ibkrLoading || ibkrDiscovering}
          expiredMonth={activeCpiMonthExpired}
        />
        {!activeCpiMonthExpired && !cpiNowcastResult.ok && cpiNowcastResult.message && (
          <div className="pmv2-error-banner cpi-inline-error" role="status">
            {cpiNowcastResult.message}
          </div>
        )}
        {signalsError && (
          <div className="pmv2-error-banner cpi-inline-error">{signalsError}</div>
        )}
        {currentCpiReleaseError && !activeCpiMonthExpired && (
          <div className="pmv2-error-banner cpi-inline-error" role="status">
            Current CPI release unavailable: {currentCpiReleaseError}
          </div>
        )}
        <main className="cpi-workbench-grid">
          <CpiForecastRail
            model={cpiNowcastResult.ok ? cpiNowcastResult.model : null}
            activeMonth={activeCpiMonth}
            months={cpiMonths}
            calendarEntries={cpiCalendarEntries}
            onMonthSelect={selectCpiMonth}
            benchmarkPayload={cpiBenchmarkState.period === activeCpiMonth?.id
              ? cpiBenchmarkState.payload
              : null}
            benchmarksLoading={cpiBenchmarkState.period === activeCpiMonth?.id
              ? cpiBenchmarkState.loading
              : true}
            benchmarksError={cpiBenchmarkState.period === activeCpiMonth?.id
              ? cpiBenchmarkState.error
              : null}
          />
          <CpiContractLadderPanel
            rows={cpiContractRows}
            displayRows={cpiDisplayContractRows}
            matrixRows={cpiScenarioMatrixRows}
            loading={loading || ingestLoading || ibkrLoading || ibkrDiscovering}
            providers={providers}
            ibkrLoading={ibkrLoading}
            ibkrDiscovering={ibkrDiscovering}
            onRefreshIbkr={refreshCpiContracts}
            onDiscoverIbkr={discoverCpiContracts}
            expiredMonth={activeCpiMonthExpired}
            monthLabel={activeCpiCalendarEntry?.label || activeCpiMonth?.fullLabel}
          />
          <CpiCurrentBookPanel
            model={cpiNowcastResult.model}
            openPositions={cpiPositions}
            liveNlv={cpiLiveNlv}
            riskPctInput={cpiRiskPctInput}
            onRiskPctChange={updateCpiRiskPctInput}
            onApply={applyCpiAllocation}
            preview={cpiAllocationPreview}
            allocationPlan={cpiAllocationPlan}
            allocationInvalidated={cpiAllocationInvalidated}
            expiredMonth={activeCpiMonthExpired}
            monthLabel={activeCpiCalendarEntry?.label || activeCpiMonth?.fullLabel}
          />
        </main>
      </div>
    </div>
  );
}
