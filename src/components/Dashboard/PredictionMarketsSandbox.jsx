import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  RefreshCw,
  ShieldAlert,
  Target,
  X,
} from 'lucide-react';
import Pmv2CardChrome from './Pmv2CardChrome';
import predictionMarketsIngestService from '../../services/api/predictionMarketsIngestService';
import { MarketDataService } from '../../services/api/marketDataService';
import { startVisibilityAwarePolling } from '../../utils/visibilityAwarePolling';
import {
  classifySpxThreshold,
  dateKeyInTimeZone,
  findSpxRiskRangeForEvent,
  hasCurrentSpxRiskRange,
  isSpxClosePosition,
  locateSpxLivePrice,
  selectRelevantSpxMarkets,
} from '../../utils/spxClosePredictionMarket';
import {
  buildSpxCloseConfluence,
  extractSpxTradeSignal,
  normalizeMarketStructureSnapshot,
  normalizeUsdCorrelationSnapshot,
  normalizeVixSnapshot,
} from '../../utils/spxCloseConfluence';
import './PredictionMarketsSandbox.css';

const SPX_CLOSE_POLL_MS = 30000;
const LIVE_SPX_MAX_AGE_MS = 60000;
const DAILY_SESSION_COUNT = 13;

const EMPTY_LIVE_SPX = Object.freeze({
  status: 'loading',
  price: null,
  timestamp: null,
  message: 'Checking for a verified live cash-SPX quote.',
});

const EMPTY_CONFLUENCE_SOURCES = Object.freeze({
  tradeSnapshot: null,
  usdSnapshot: null,
  volatilitySnapshot: null,
  marketStructureSnapshot: null,
});

const EMPTY_PRICE_STRUCTURE_SOURCE = Object.freeze({
  status: 'loading',
  structure: null,
  source: null,
  fetchedAt: null,
  error: null,
});

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCompletedPriceStructure(payload) {
  const row = payload?.rows?.SPX;
  const structure = row?.priceStructure;
  const asOf = String(structure?.asOf || '');
  const highScore = finiteNumber(structure?.highLeg?.score);
  const lowScore = finiteNumber(structure?.lowLeg?.score);
  const score = finiteNumber(structure?.score);
  const forcedProviderRead = payload?.cache?.status === 'miss'
    && row?.provenance?.security?.cacheStatus === 'miss';
  const policySafe = payload?.historicalOnly === true
    && payload?.executable === false
    && row?.historicalOnly === true
    && row?.executable === false;
  const completedCashIndexBars = structure?.priceBasis === 'completed SPX cash-index daily high and low'
    && row?.provenance?.security?.yahooSymbol === '^GSPC';
  const structurallyValid = structure?.status === 'available'
    && structure?.ruleVersion === 'spx-structure-run-v1'
    && /^\d{4}-\d{2}-\d{2}$/.test(asOf)
    && Number.isInteger(highScore)
    && Number.isInteger(lowScore)
    && Number.isInteger(score)
    && score === highScore + lowScore
    && Number(structure?.observations) >= 2;

  if (!forcedProviderRead || !policySafe || !completedCashIndexBars || !structurallyValid) {
    throw new Error('Fresh completed cash-SPX high/low structure is unavailable.');
  }

  return {
    status: 'available',
    structure,
    source: row.source || payload.source || 'Yahoo Finance chart API',
    fetchedAt: row.provenance.security.fetchedAt || payload.generatedAt || null,
    error: null,
  };
}

function resolvePriceStructureReference(source, data) {
  const unavailable = {
    available: false,
    read: source?.status === 'loading'
      ? 'Refreshing completed cash-index daily highs and lows'
      : 'Completed cash-index daily high/low structure unavailable',
    points: 'REF —',
    asOf: null,
    status: source?.status === 'loading'
      ? { label: 'CHECKING PROVIDER', tone: 'neutral' }
      : { label: 'UNAVAILABLE', tone: 'unavailable' },
  };
  const structure = source?.structure;
  const targetDate = dateKeyInTimeZone(data?.event?.closeTime);
  if (source?.status !== 'available' || !structure || !targetDate) return unavailable;

  const historical = Boolean(data?.historicalOnly);
  const sameSession = structure.asOf === targetDate;
  const hasLookahead = structure.asOf > targetDate || (!historical && sameSession);
  if (hasLookahead) {
    return {
      ...unavailable,
      read: 'Completed high/low read withheld to prevent session look-ahead',
      status: { label: 'WRONG-DATE · HIDDEN', tone: 'unavailable' },
    };
  }

  const highScore = structure.highLeg.score;
  const lowScore = structure.lowLeg.score;
  const score = structure.score;
  return {
    available: true,
    read: `High ${formatSignedPoints(highScore)} (${structure.highLeg.event}) · Low ${formatSignedPoints(lowScore)} (${structure.lowLeg.event}) · Net ${formatSignedPoints(score)}`,
    points: `REF ${formatSignedPoints(score)}`,
    asOf: structure.asOf,
    status: historical && sameSession
      ? { label: 'POST-CLOSE · NOT RETRO-SCORED', tone: 'neutral' }
      : historical
        ? { label: 'PRIOR-CLOSE · NOT RETRO-SCORED', tone: 'neutral' }
        : { label: 'REFERENCE · NOT IN 0–8', tone: score > 0 ? 'support' : score < 0 ? 'conflict' : 'neutral' },
  };
}

function isIbkrConnected(status) {
  return Boolean(
    status?.ibkr?.connected === true ||
    status?.ibkr?.status === 'connected' ||
    status?.portfolio?.ibkr?.connected === true ||
    status?.portfolio?.ibkr?.status === 'connected'
  );
}

export function resolveVerifiedLiveSpxQuote(quotes, providerStatus, now = Date.now()) {
  const providerTimestampMs = Date.parse(providerStatus?.timestamp || '');
  const providerAgeMs = now - providerTimestampMs;
  const providerStatusCurrent = Boolean(
    !providerStatus?.statusRefreshDelayed &&
    !providerStatus?.ibkr?.statusRefreshDelayed &&
    Number.isFinite(providerTimestampMs) &&
    providerAgeMs >= 0 &&
    providerAgeMs <= LIVE_SPX_MAX_AGE_MS
  );

  if (!isIbkrConnected(providerStatus) || !providerStatusCurrent) {
    return {
      status: 'unavailable',
      price: null,
      timestamp: null,
      message: isIbkrConnected(providerStatus)
        ? 'IBKR provider status is not current; the live SPX marker is unavailable.'
        : 'IBKR is disconnected; the live SPX marker is unavailable.',
    };
  }

  const quote = quotes?.SPX;
  const directPrice = finiteNumber(quote?.last);
  const timestamp = quote?.timestamp || null;
  const timestampMs = Date.parse(timestamp || '');
  const ageMs = now - timestampMs;
  const warning = String(quote?.warning || '');
  const entitlement = String(quote?.entitlementStatus || '');
  const blockedProvenance = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|historical|synthetic|inferred|derived/i;
  const deniedEntitlement = /denied|unavailable|not[_ -]?subscribed|no[_ -]?permission/i;
  const verified = Boolean(
    String(quote?.symbol || '').toUpperCase() === 'SPX' &&
    quote?.source === 'ibkr' &&
    String(quote?.dataType || '').toLowerCase() === 'live' &&
    directPrice != null &&
    directPrice > 0 &&
    Number.isFinite(timestampMs) &&
    ageMs >= 0 &&
    ageMs <= LIVE_SPX_MAX_AGE_MS &&
    !blockedProvenance.test(warning) &&
    !deniedEntitlement.test(entitlement)
  );

  if (!verified) {
    return {
      status: 'unavailable',
      price: null,
      timestamp: null,
      message: 'IBKR did not return a fresh, entitled live cash-SPX trade.',
    };
  }

  return {
    status: 'live',
    price: directPrice,
    timestamp,
    message: 'Verified IBKR live cash-SPX quote.',
  };
}

async function loadVerifiedLiveSpxQuote() {
  try {
    const providerStatus = await MarketDataService.getProviderStatus();
    if (!isIbkrConnected(providerStatus)) {
      return resolveVerifiedLiveSpxQuote({}, providerStatus);
    }
    const quotes = await MarketDataService.getQuotes(['SPX']);
    return resolveVerifiedLiveSpxQuote(quotes, providerStatus);
  } catch (error) {
    return {
      status: 'unavailable',
      price: null,
      timestamp: null,
      message: error?.message || 'The verified live cash-SPX quote is unavailable.',
    };
  }
}

function formatCents(value) {
  const number = finiteNumber(value);
  return number == null ? '—' : `${Math.round(number * 100)}¢`;
}

function formatSettlementPayout(value) {
  const number = finiteNumber(value);
  return number == null ? '—' : `$${number.toFixed(2)}`;
}

function formatIndexLevel(value, maximumFractionDigits = 2) {
  const number = finiteNumber(value);
  if (number == null) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(number);
}

function formatContracts(value) {
  const number = finiteNumber(value);
  if (number == null) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: Math.abs(number) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(number) >= 1000 ? 1 : 0,
  }).format(number);
}

function formatEventDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function formatSessionDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(value));
}

function formatSourceDate(value) {
  if (!value) return '—';
  const token = String(value).slice(0, 10);
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(token) ? `${token}T12:00:00.000Z` : value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp));
}

function formatFetchedTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatSpxQuoteTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))} ET`;
}

function formatSignedPoints(value) {
  const number = finiteNumber(value);
  if (number == null) return '—';
  const prefix = number > 0 ? '+' : number < 0 ? '−' : '';
  return `${prefix}${formatIndexLevel(Math.abs(number))}`;
}

function formatSignedDollars(value) {
  const number = finiteNumber(value);
  if (number == null) return '—';
  const prefix = number > 0 ? '+' : number < 0 ? '−' : '';
  return `${prefix}$${Math.abs(number).toFixed(2)}`;
}

function formatCorrelation(value) {
  const number = finiteNumber(value);
  if (number == null) return '—';
  const prefix = number > 0 ? '+' : number < 0 ? '−' : '';
  return `${prefix}${Math.abs(number).toFixed(3)}`;
}

function formatPercent(value, digits = 0) {
  const number = finiteNumber(value);
  return number == null ? '—' : `${number.toFixed(digits)}%`;
}

function formatDirection(value) {
  if (value === 'bullish') return 'BULLISH';
  if (value === 'bearish') return 'BEARISH';
  return '—';
}

function formatGamma(value) {
  if (value === 'positive') return 'Positive';
  if (value === 'negative') return 'Negative';
  if (value === 'neutral') return 'Neutral';
  return 'Unavailable';
}

function formatVixBucket(value) {
  if (value === 'investable') return 'Investable';
  if (value === 'uninvestable') return 'Uninvestable';
  if (value === 'chop') return 'Chop';
  return 'Unavailable';
}

function formatStructureValue(value, kind) {
  if (!value) return 'Unavailable';
  if (value === 'neutral') return 'Neutral';
  if (kind === 'pv') return value === 'long' ? 'Long' : value === 'short' ? 'Short' : 'Unavailable';
  if (kind === 'allocation') return value === 'risk_on' ? 'Risk On' : value === 'risk_off' ? 'Risk Off' : 'Unavailable';
  return value === 'bullish' ? 'Bullish' : value === 'bearish' ? 'Bearish' : 'Unavailable';
}

function formatConfluencePoints(points, maximum) {
  return Number.isFinite(points) ? `${points}/${maximum}` : `—/${maximum}`;
}

function zoneLabel(zone) {
  if (zone === 'below') return 'Below RR';
  if (zone === 'above') return 'Above RR';
  if (zone === 'inside') return 'Inside RR';
  return 'Unknown';
}

function resolutionAtLevel(level, threshold) {
  const observed = finiteNumber(level);
  const boundary = finiteNumber(threshold);
  if (observed == null || boundary == null) return null;
  return observed >= boundary ? 'YES' : 'NO';
}

function spreadLabel(bid, ask) {
  const left = finiteNumber(bid);
  const right = finiteNumber(ask);
  return left == null || right == null ? '—' : `${Math.round((right - left) * 100)}¢`;
}

function rangeLevels(riskRange) {
  const lower = finiteNumber(riskRange?.lrr);
  const upper = finiteNumber(riskRange?.hrr);
  if (lower == null || upper == null) return [];
  return [
    { key: 'lower', label: 'LRR', value: lower },
    { key: 'mid', label: 'RR midpoint', value: (lower + upper) / 2 },
    { key: 'upper', label: 'HRR', value: upper },
  ];
}

function positionQuantity(position = {}) {
  const value = Number(position.quantity ?? position.position);
  return Number.isFinite(value) ? value : 0;
}

function positionLabel(position = {}) {
  return position.localSymbol || position.symbol || position.description || 'SPX close position';
}

function isExpectedLiveUnavailable(error) {
  const status = Number(error?.response?.status);
  const code = error?.response?.data?.code;
  return status === 503 && ['SPX_EVENT_UNAVAILABLE', 'SPX_BOOK_UNAVAILABLE'].includes(code);
}

function classifyCloseAgainstRange(closeValue, riskRange) {
  const close = finiteNumber(closeValue);
  const lower = finiteNumber(riskRange?.lrr);
  const upper = finiteNumber(riskRange?.hrr);
  if (close == null || lower == null || upper == null) return 'pending';
  if (close < lower) return 'below';
  if (close > upper) return 'above';
  return 'inside';
}

function buildDailySessions(data, currentRiskRange, riskRangeHistory, recentSettled) {
  const byDate = new Map();
  const sessions = Array.isArray(recentSettled?.sessions) ? recentSettled.sessions : [];

  sessions.forEach((session) => {
    const closeTime = session.closeTime || session.event?.closeTime;
    const key = dateKeyInTimeZone(closeTime);
    const matchedRiskRange = findSpxRiskRangeForEvent(riskRangeHistory, closeTime);
    if (!key || !matchedRiskRange || finiteNumber(session.closeValue) == null) return;
    byDate.set(key, {
      eventTicker: session.eventTicker || session.event?.ticker,
      closeTime,
      closeValue: finiteNumber(session.closeValue),
      riskRange: matchedRiskRange,
      historicalOnly: true,
      venue: session.venue || {},
    });
  });

  if (data?.event?.closeTime && currentRiskRange) {
    const key = dateKeyInTimeZone(data.event.closeTime);
    if (key) {
      byDate.set(key, {
        eventTicker: data.event.ticker,
        closeTime: data.event.closeTime,
        closeValue: data.historicalOnly ? finiteNumber(data.closeValue) : null,
        riskRange: currentRiskRange,
        historicalOnly: Boolean(data.historicalOnly),
        venue: data.venue || {},
        selected: true,
      });
    }
  }

  return [...byDate.values()]
    .sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime))
    .slice(-DAILY_SESSION_COUNT);
}

function DailySessionCard({ session }) {
  const lower = finiteNumber(session.riskRange?.lrr);
  const upper = finiteNumber(session.riskRange?.hrr);
  const close = finiteNumber(session.closeValue);
  const result = classifyCloseAgainstRange(close, session.riskRange);
  const span = Math.max(1, upper - lower);
  const plotLow = lower - span * 0.22;
  const plotHigh = upper + span * 0.22;
  const position = (value) => {
    const number = finiteNumber(value);
    if (number == null) return null;
    return Math.max(0, Math.min(100, ((number - plotLow) / (plotHigh - plotLow)) * 100));
  };
  const lowerPct = position(lower);
  const upperPct = position(upper);
  const closePct = position(close);

  return (
    <article
      className={[
        'cpi-calendar-card',
        'spx-daily-card',
        session.selected ? 'active' : '',
        `spx-daily-card--${result}`,
      ].filter(Boolean).join(' ')}
      aria-current={session.selected ? 'date' : undefined}
      aria-label={`${formatSessionDate(session.closeTime)}: ${close == null ? 'close pending' : `SPX close ${formatIndexLevel(close)}`}; Risk Range ${formatIndexLevel(lower)} to ${formatIndexLevel(upper)}`}
    >
      <span className="cpi-calendar-month">{formatSessionDate(session.closeTime)}</span>
      <span className="cpi-calendar-divider" />
      <strong className="cpi-calendar-final">{close == null ? '—' : formatIndexLevel(close)}</strong>
      <span className="cpi-calendar-mini-chart spx-daily-mini-chart" aria-hidden="true">
        <i className="spx-daily-range-fill" style={{ bottom: `${lowerPct}%`, height: `${upperPct - lowerPct}%` }} />
        <i className="spx-daily-level-line spx-daily-level-line--hrr" style={{ bottom: `${upperPct}%` }} />
        <i className="spx-daily-level-line spx-daily-level-line--lrr" style={{ bottom: `${lowerPct}%` }} />
        {closePct != null && (
          <i className="spx-daily-level-line spx-daily-level-line--close" style={{ bottom: `${closePct}%` }} />
        )}
      </span>
      <span className="cpi-estimate-labels spx-daily-values">
        <span className="upper"><span className="cpi-estimate-value">{formatIndexLevel(upper, 0)}</span> <span className="cpi-estimate-name">hrr</span></span>
        <span className="base"><span className="cpi-estimate-value">{close == null ? '—' : formatIndexLevel(close, 0)}</span> <span className="cpi-estimate-name">close</span></span>
        <span className="lower"><span className="cpi-estimate-value">{formatIndexLevel(lower, 0)}</span> <span className="cpi-estimate-name">lrr</span></span>
      </span>
    </article>
  );
}

function SpxDailyHeader({ data, riskRange, sessions, refreshing, onRefresh, onClose }) {
  const historical = Boolean(data.historicalOnly);
  return (
    <header className="cpi-calculator-header cpi-calendar-header spx-daily-header">
      <div className="cpi-calendar-title-row">
        <div className="cpi-calendar-title-block">
          <span className="cpi-calendar-title-accent" aria-hidden="true" />
          <div><h1>S&amp;P 500 Close</h1></div>
        </div>
        <div className="cpi-calendar-meta">
          <strong>{historical ? 'Last settled' : 'Active'}: {formatEventDate(data.event.closeTime)}</strong>
          <span className="cpi-calendar-settlement">
            {historical ? 'Historical settlement · 4:00 PM ET cash index' : 'Cash S&P 500 Index · Settlement 4:00 PM ET'}
          </span>
        </div>
        <div className="spx-close-header-actions">
          <span className={`spx-close-mode-label ${historical ? 'historical' : 'live'}`}>
            {historical ? 'SETTLED · NOT TRADEABLE' : 'DIRECT VENUE · RESEARCH ONLY'}
          </span>
          <button type="button" className="spx-close-refresh" onClick={onRefresh} disabled={refreshing} aria-label="Refresh SPX close workbench">
            <RefreshCw size={13} className={refreshing ? 'spx-close-spin' : ''} aria-hidden="true" />
            {historical ? 'Check live' : 'Refresh'}
          </button>
          {onClose && (
            <button type="button" className="spx-close-close" onClick={onClose} aria-label="Close SPX Close">
              <X size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="cpi-calendar-grid spx-daily-calendar-grid" aria-label="Daily SPX Risk Ranges and cash closes">
        {sessions.map((session) => (
          <DailySessionCard key={session.eventTicker || session.closeTime} session={session} />
        ))}
      </div>
    </header>
  );
}

function ScenarioResolution({ level, threshold }) {
  const result = resolutionAtLevel(level, threshold);
  return <span className={`spx-resolution spx-resolution--${String(result).toLowerCase()}`}>{result || '—'}</span>;
}

function liveMarkerContext(placement) {
  if (!placement) return '';
  if (placement.position === 'between') {
    return `between strikes ${formatIndexLevel(placement.lower)} and ${formatIndexLevel(placement.upper)}`;
  }
  if (placement.position === 'exact') return `at the ${formatIndexLevel(placement.lower)} strike`;
  if (placement.position === 'below') return `below the shown ladder ending at ${formatIndexLevel(placement.upper)}`;
  return `above the shown ladder starting at ${formatIndexLevel(placement.lower)}`;
}

function LiveSpxMarkerRow({ liveSpx, placement, columnCount }) {
  if (liveSpx?.status !== 'live' || !placement) return null;
  const edgeLabel = placement.position === 'above'
    ? ' · ABOVE SHOWN LADDER'
    : placement.position === 'below' ? ' · BELOW SHOWN LADDER' : placement.position === 'exact' ? ' · AT STRIKE' : '';
  const formattedPrice = formatIndexLevel(liveSpx.price);
  const formattedTime = formatSpxQuoteTime(liveSpx.timestamp);
  return (
    <tr
      className={`spx-live-marker-row spx-live-marker-row--${placement.position}`}
      data-testid="spx-live-marker"
      aria-label={`Live S&P 500 cash index ${formattedPrice}, ${liveMarkerContext(placement)}, as of ${formattedTime}`}
    >
      <td colSpan={columnCount}>
        <span className="spx-live-marker-line" aria-hidden="true" />
        <span className="spx-live-marker-label">
          <b>LIVE SPX</b> {formattedPrice}<time dateTime={liveSpx.timestamp}> · {formattedTime}</time>{edgeLabel}
        </span>
      </td>
    </tr>
  );
}

function ContractsCard({ data, markets, riskRange, liveSpx, selectedTicker, onSelect }) {
  const levels = rangeLevels(riskRange);
  const historical = Boolean(data.historicalOnly);
  const markerPlacement = liveSpx?.status === 'live'
    ? locateSpxLivePrice(markets, liveSpx.price)
    : null;
  const columnCount = historical ? 8 : 9;
  return (
    <Pmv2CardChrome
      icon={<Target size={14} />}
      title="Contracts"
      titleId="spx-close-contracts-title"
      className="cpi-matrix-card spx-close-contracts-card"
      actions={(
        <span className="spx-close-card-meta-group">
          <span className="spx-close-card-meta">
            {historical ? 'SETTLED OUTCOMES' : 'RR ±25 PTS'} · {formatFetchedTime(data.fetchedAt)}
          </span>
          <span
            className={`spx-live-quote-state spx-live-quote-state--${liveSpx?.status || 'unavailable'}`}
            title={liveSpx?.status === 'live'
              ? `Verified IBKR live cash-SPX quote as of ${formatSpxQuoteTime(liveSpx.timestamp)}`
              : liveSpx?.message}
          >
            {liveSpx?.status === 'live'
              ? `LIVE SPX ${formatIndexLevel(liveSpx.price)}`
              : liveSpx?.status === 'loading' ? 'SPX MARKER CHECKING' : 'LIVE SPX UNAVAILABLE'}
          </span>
        </span>
      )}
    >
      <div className="cpi-matrix-table-wrap spx-close-table-wrap">
        <table
          className="cpi-matrix-table spx-close-contracts-table"
          aria-label={historical ? 'Settled S&P 500 cash close threshold outcomes' : 'S&P 500 cash close threshold ladder'}
        >
          <thead>
            {historical ? (
              <tr>
                <th>Contract</th>
                {levels.map((level) => <th key={level.key}><strong>{level.label}</strong><span>{formatIndexLevel(level.value)}</span></th>)}
                <th>Actual<br />close</th>
                <th>Result</th>
                <th>Δ close</th>
                <th>Volume<br />/ OI</th>
              </tr>
            ) : (
              <tr>
                <th>Contract</th>
                {levels.map((level) => <th key={level.key}><strong>{level.label}</strong><span>{formatIndexLevel(level.value)}</span></th>)}
                <th>YES<br />bid / ask</th>
                <th>NO<br />bid / ask</th>
                <th>Spread<br />Y / N</th>
                <th>YES<br />depth</th>
                <th>24h<br />/ OI</th>
              </tr>
            )}
          </thead>
          <tbody>
            {markerPlacement?.afterIndex === -1 && (
              <LiveSpxMarkerRow liveSpx={liveSpx} placement={markerPlacement} columnCount={columnCount} />
            )}
            {markets.map((market, marketIndex) => {
              const selected = market.ticker === selectedTicker;
              const zone = classifySpxThreshold(market.threshold, riskRange);
              return (
                <React.Fragment key={market.ticker}>
                  <tr
                    className={selected ? 'selected' : ''}
                    onClick={() => onSelect(market.ticker)}
                    aria-selected={selected}
                  >
                    <td className="cpi-matrix-contract-cell spx-contract-cell">
                      <button type="button" onClick={() => onSelect(market.ticker)} aria-label={`${historical ? 'Inspect settled SPX above' : 'Inspect SPX above'} ${formatIndexLevel(market.threshold)}`}>
                        <strong>SPX ≥ {formatIndexLevel(market.threshold)}</strong>
                        <span>{zoneLabel(zone)}</span>
                      </button>
                    </td>
                    {levels.map((level) => (
                      <td key={level.key}><ScenarioResolution level={level.value} threshold={market.threshold} /></td>
                    ))}
                    {historical ? (
                      <>
                        <td>{formatIndexLevel(data.closeValue)}</td>
                        <td><span className={`spx-resolution spx-resolution--${market.result}`}>{String(market.result || '—').toUpperCase()}</span></td>
                        <td>{formatSignedPoints(Number(data.closeValue) - Number(market.threshold))}</td>
                        <td><span className="spx-paired-value"><strong>{formatContracts(market.volumeTotal)}</strong><small>{formatContracts(market.openInterest)}</small></span></td>
                      </>
                    ) : (
                      <>
                        <td><span className="spx-book-value"><b>{formatCents(market.yesBid)}</b><i>/</i><b>{formatCents(market.yesAsk)}</b></span></td>
                        <td><span className="spx-book-value"><b>{formatCents(market.noBid)}</b><i>/</i><b>{formatCents(market.noAsk)}</b></span></td>
                        <td><span className="spx-paired-value"><strong>{spreadLabel(market.yesBid, market.yesAsk)}</strong><small>{spreadLabel(market.noBid, market.noAsk)}</small></span></td>
                        <td>{formatContracts(market.yesBidSize)} × {formatContracts(market.yesAskSize)}</td>
                        <td><span className="spx-paired-value"><strong>{formatContracts(market.volume24h)}</strong><small>{formatContracts(market.openInterest)}</small></span></td>
                      </>
                    )}
                  </tr>
                  {markerPlacement?.afterIndex === marketIndex && (
                    <LiveSpxMarkerRow liveSpx={liveSpx} placement={markerPlacement} columnCount={columnCount} />
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Pmv2CardChrome>
  );
}

function structureDirection(value, kind) {
  if (!value || value === 'neutral') return null;
  if (kind === 'pv') return value === 'long' ? 'bullish' : value === 'short' ? 'bearish' : null;
  if (kind === 'allocation') return value === 'risk_on' ? 'bullish' : value === 'risk_off' ? 'bearish' : null;
  return value === 'bullish' || value === 'bearish' ? value : null;
}

function structureReadStatus(value, kind, direction) {
  if (!value) return { label: 'UNAVAILABLE', tone: 'unavailable' };
  const signalDirection = structureDirection(value, kind);
  if (!signalDirection) return { label: 'NEUTRAL', tone: 'neutral' };
  if (!direction) return { label: 'WAITING FOR GATE', tone: 'neutral' };
  return signalDirection === direction
    ? { label: 'ALIGNED', tone: 'support' }
    : { label: 'CONFLICT', tone: 'conflict' };
}

function ConfluenceFactorRow({ label, read, rule, points, maximum, asOf, status, exactDate = false }) {
  return (
    <tr>
      <th>{label}</th>
      <td>{read}</td>
      <td>{rule}</td>
      <td className="spx-confluence-points">{maximum == null ? points : formatConfluencePoints(points, maximum)}</td>
      <td>{exactDate && asOf ? asOf : formatSourceDate(asOf)}</td>
      <td>
        <span className={`spx-confluence-status spx-confluence-status--${status?.tone || 'neutral'}`}>
          {status?.label || '—'}
        </span>
      </td>
    </tr>
  );
}

function ConfluenceLedger({
  confluence,
  sources,
  riskRange,
  selectedMarket,
  data,
  priceStructureSource,
}) {
  const historical = Boolean(data.historicalOnly);
  const structure = sources.marketStructure;
  const usd = sources.usd;
  const vix = sources.vix;
  const scoreLabel = confluence.score == null ? `— / ${confluence.maxScore}` : `${confluence.score} / ${confluence.maxScore}`;
  const bandLabel = confluence.band === 'high'
    ? 'HIGH INDICATOR CONFLUENCE'
    : confluence.band === 'mixed' ? 'MIXED INDICATOR CONFLUENCE' : confluence.band === 'low' ? 'LOW INDICATOR CONFLUENCE' : null;
  const eligibilityLabel = confluence.eligibilityPassed
    ? confluence.scoreReady ? 'ELIGIBLE' : 'ELIGIBLE · INPUTS MISSING'
    : 'NOT ELIGIBLE';
  const coveragePercent = Number.isFinite(confluence.geometry.coverage)
    ? confluence.geometry.coverage * 100
    : null;
  const correlationType = Number.isFinite(usd?.r30)
    ? (usd.r30 < 0 ? 'inverse' : usd.r30 > 0 ? 'direct' : 'flat')
    : 'unavailable';
  const structureCurrent = Boolean(confluence.structure.exactDate);
  const visibleStructure = structureCurrent ? structure : null;
  const gammaDetails = confluence.gamma.inputAvailable ? [
    formatGamma(visibleStructure?.gammaExposure),
    Number.isFinite(visibleStructure?.gammaThrottle) ? `throttle ${formatSignedPoints(visibleStructure.gammaThrottle)}` : null,
    Number.isFinite(visibleStructure?.realizedVol10d) ? `10D rVol ${visibleStructure.realizedVol10d.toFixed(2)}` : null,
  ].filter(Boolean).join(' · ') : 'Same-session gamma input unavailable';
  const systematicStatus = structureReadStatus(visibleStructure?.systematicFlow, 'flow', confluence.direction);
  const pvStatus = structureReadStatus(visibleStructure?.pvBand, 'pv', confluence.direction);
  const allocationStatus = structureReadStatus(visibleStructure?.strategicAllocation, 'allocation', confluence.direction);
  const geometryStatus = !confluence.direction
    ? { label: 'WAITING FOR GATE', tone: 'neutral' }
    : confluence.geometry.strikeInside
      ? { label: confluence.geometry.points > 0 ? 'SUPPORT' : 'LOW SUPPORT', tone: confluence.geometry.points > 0 ? 'support' : 'neutral' }
      : { label: 'OUTSIDE RR', tone: 'conflict' };
  const usdStatus = confluence.correlation.available
    ? { label: confluence.correlation.points > 0 ? 'STRONG LINK' : 'BELOW TIER', tone: confluence.correlation.points > 0 ? 'support' : 'neutral' }
    : { label: 'UNAVAILABLE', tone: 'unavailable' };
  const gammaStatus = confluence.gamma.available
    ? { label: confluence.gamma.points ? 'FIT' : 'NO FIT', tone: confluence.gamma.points ? 'support' : 'neutral' }
    : confluence.gamma.inputAvailable
      ? { label: confluence.geometry.strikeInside ? 'WAITING FOR GATE' : 'BLOCKED BY GEOMETRY', tone: 'neutral' }
      : { label: 'UNAVAILABLE', tone: 'unavailable' };
  const vixStatus = confluence.volatility.available
    ? { label: confluence.volatility.points ? 'ALIGNED' : 'NO POINT', tone: confluence.volatility.points ? 'support' : 'neutral' }
    : confluence.volatility.inputAvailable
      ? { label: 'WAITING FOR GATE', tone: 'neutral' }
      : { label: 'UNAVAILABLE', tone: 'unavailable' };
  const structureStatus = confluence.structure.available
    ? { label: `${confluence.structure.alignedCount}/3 ALIGNED`, tone: confluence.structure.points ? 'support' : confluence.structure.conflictCount ? 'conflict' : 'neutral' }
    : { label: 'UNAVAILABLE', tone: 'unavailable' };
  const priceStructureReference = resolvePriceStructureReference(priceStructureSource, data);
  const thesisBid = confluence.side === 'YES'
    ? finiteNumber(selectedMarket?.yesBid)
    : confluence.side === 'NO' ? finiteNumber(selectedMarket?.noBid) : null;
  const thesisAsk = confluence.side === 'YES'
    ? finiteNumber(selectedMarket?.yesAsk)
    : confluence.side === 'NO' ? finiteNumber(selectedMarket?.noAsk) : null;
  const liveSpread = thesisBid != null && thesisAsk != null ? thesisAsk - thesisBid : null;
  const thesisAskSize = confluence.side === 'YES'
    ? finiteNumber(selectedMarket?.yesAskSize)
    : confluence.side === 'NO' ? finiteNumber(selectedMarket?.noAskSize) : null;
  const quoteObserved = Boolean(
    confluence.side &&
    thesisBid != null &&
    thesisAsk != null &&
    liveSpread != null &&
    liveSpread >= 0
  );
  const executionLabel = historical
    ? 'ARCHIVE ONLY · NO HINDSIGHT SCORE'
    : !confluence.scoreReady
      ? 'NOT READY · INDICATOR INPUTS INCOMPLETE'
      : !data.ibkr?.executionVerified
        ? 'RESEARCH ONLY · IBKR EXECUTION NOT VERIFIED'
        : !quoteObserved
          ? 'NOT READY · TWO-SIDED THESIS BOOK MISSING'
          : 'MARKET OBSERVED · VALUE STILL UNPROVEN';

  return (
    <section className="spx-confluence-ledger" aria-label="SPX setup confluence analysis">
      <div className="spx-confluence-summary">
        <span className="spx-confluence-kicker">INDICATOR CONFLUENCE · SIGNAL ONLY · {confluence.version}</span>
        <dl>
          <div><dt>Eligibility</dt><dd className={`spx-confluence-eligibility spx-confluence-eligibility--${confluence.status}`}>{eligibilityLabel}</dd></div>
          <div><dt>Trade</dt><dd>{formatDirection(confluence.exactTrade ? confluence.tradeDirection : null)}</dd></div>
          <div><dt>Trend</dt><dd>{formatDirection(confluence.exactTrend ? confluence.trendDirection : null)}</dd></div>
          <div><dt>Thesis side</dt><dd>{confluence.side || '—'}</dd></div>
          <div><dt>Score</dt><dd className="spx-confluence-total">{scoreLabel}</dd></div>
          <div><dt>Indicator read</dt><dd>{bandLabel || (confluence.status === 'incomplete' ? 'AWAITING INPUTS' : 'GATE BLOCKED')}</dd></div>
        </dl>
      </div>

      <div className="spx-confluence-table-wrap">
        <table className="spx-confluence-table" aria-label="SPX confluence score ledger">
          <thead>
            <tr>
              <th>Factor</th>
              <th>Current read</th>
              <th>Transparent rule</th>
              <th>Pts</th>
              <th>As of</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <ConfluenceFactorRow
              label="Contract geometry"
              read={coveragePercent == null
                ? `K ${formatIndexLevel(selectedMarket?.threshold)} · direction unavailable`
                : `K ${formatIndexLevel(selectedMarket?.threshold)} · ${formatPercent(coveragePercent)} of RR resolves ${confluence.side}`}
              rule="Strike inside RR · ≥75%=2 · ≥50%=1"
              points={confluence.geometry.available ? confluence.geometry.points : null}
              maximum={2}
              asOf={riskRange?.date}
              status={geometryStatus}
            />
            <ConfluenceFactorRow
              label="USD linkage strength"
              read={confluence.correlation.available
                ? `30D r ${formatCorrelation(usd.r30)} · ${correlationType} · ${confluence.correlation.stableSign ? '15/30/90 stable' : 'sign not stable'}`
                : 'Current session-safe SPX / DXY correlation unavailable'}
              rule="Magnitude only · |r30| .50=1 · .70 + stable=2"
              points={confluence.correlation.available ? confluence.correlation.points : null}
              maximum={2}
              asOf={confluence.correlation.available ? usd?.date : null}
              status={usdStatus}
            />
            <ConfluenceFactorRow
              label="Gamma / threshold fit"
              read={gammaDetails}
              rule="Positive γ for ≥50% RR support · negative γ for extension"
              points={confluence.gamma.available ? confluence.gamma.points : null}
              maximum={1}
              asOf={confluence.gamma.inputAvailable ? visibleStructure?.date : null}
              status={gammaStatus}
            />
            <ConfluenceFactorRow
              label="VIX regime"
              read={confluence.volatility.inputAvailable && Number.isFinite(vix?.value) ? `${vix.value.toFixed(2)} · ${formatVixBucket(vix.bucket)}` : 'Current session-safe VIX unavailable'}
              rule="Bull=Investable · Bear=Uninvestable · Chop=0"
              points={confluence.volatility.available ? confluence.volatility.points : null}
              maximum={1}
              asOf={confluence.volatility.inputAvailable ? vix?.date : null}
              status={vixStatus}
            />
            <ConfluenceFactorRow
              label="Systematic flow"
              read={formatStructureValue(visibleStructure?.systematicFlow, 'flow')}
              rule="Bullish / Bearish alignment"
              points="BREADTH"
              asOf={structureCurrent ? visibleStructure?.date : null}
              status={systematicStatus}
            />
            <ConfluenceFactorRow
              label="PV Band R/R"
              read={formatStructureValue(visibleStructure?.pvBand, 'pv')}
              rule="Long / Short alignment"
              points="BREADTH"
              asOf={structureCurrent ? visibleStructure?.date : null}
              status={pvStatus}
            />
            <ConfluenceFactorRow
              label="Strategic allocation"
              read={formatStructureValue(visibleStructure?.strategicAllocation, 'allocation')}
              rule="Risk On / Risk Off alignment"
              points="BREADTH"
              asOf={structureCurrent ? visibleStructure?.date : null}
              status={allocationStatus}
            />
            <ConfluenceFactorRow
              label="Structure breadth"
              read={confluence.structure.available
                ? `${confluence.structure.alignedCount} aligned · ${confluence.structure.conflictCount} conflict`
                : 'Daily normalized structure report unavailable'}
              rule="3/3=2 · 2/3=1 · correlated inputs capped"
              points={confluence.structure.available ? confluence.structure.points : null}
              maximum={2}
              asOf={confluence.structure.inputAvailable ? visibleStructure?.date : null}
              status={structureStatus}
            />
            <ConfluenceFactorRow
              label="HH / HL accumulator"
              read={priceStructureReference.read}
              rule="Continuation ±1 · first reversal resets leg · ATH/ATL bonus ±1"
              points={priceStructureReference.points}
              asOf={priceStructureReference.asOf}
              status={priceStructureReference.status}
              exactDate
            />
          </tbody>
          <tfoot>
            <tr>
              <th colSpan="3">TOTAL · INDICATOR CHECKLIST, NOT BET QUALITY, WIN PROBABILITY, OR EV</th>
              <td>{scoreLabel}</td>
              <td colSpan="2">{historical ? 'ARCHIVE ONLY' : 'UNCALIBRATED v0.1'}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="spx-confluence-execution">
        <span>Bet / execution gate · separate from score</span>
        <strong>{executionLabel}</strong>
        {!historical && (
          <small>{quoteObserved
            ? `${confluence.side} ${formatCents(thesisBid)} / ${formatCents(thesisAsk)} · ${formatCents(liveSpread)} spread · ${formatContracts(thesisAskSize)} ask depth · ${formatContracts(selectedMarket?.volume24h)} volume · ${formatContracts(selectedMarket?.openInterest)} OI`
            : 'Thesis side or a verified live two-sided quote is unavailable'}</small>
        )}
        {!historical && thesisAsk != null && (
          <small>Price hurdle · {formatCents(thesisAsk)} ask requires a hit rate above {formatPercent(thesisAsk * 100)} before fees; this score is not yet calibrated to a probability.</small>
        )}
      </div>

      {(confluence.blockers.length > 0 || confluence.missing.length > 0) && (
        <p className="spx-confluence-blockers">
          {[...confluence.blockers, ...confluence.missing.map((key) => `${key} input unavailable or wrong-date`)].join(' · ')}
        </p>
      )}
      <p className="spx-confluence-note">
        {historical
          ? 'Historical indicator scoring is withheld until the app has a pre-4:00 PM archive of every input and a strike selected before settlement; today\'s snapshots are never backfilled into Friday.'
          : 'Required gate: same-session published SPX Trade and Trend must align. Strong readings do not authorize a trade; log and calibrate this ordinal score against settlements before assigning a betting threshold.'}
      </p>
    </section>
  );
}

function LivePaydayCard({ data, riskRange, selectedMarket, positions, positionsLive, positionsMessage, confluence, confluenceSources, priceStructureSource }) {
  const levels = rangeLevels(riskRange);
  const zone = classifySpxThreshold(selectedMarket?.threshold, riskRange);
  const yesAsk = finiteNumber(selectedMarket?.yesAsk);
  const noAsk = finiteNumber(selectedMarket?.noAsk);
  const midpoint = (Number(riskRange.lrr) + Number(riskRange.hrr)) / 2;

  return (
    <Pmv2CardChrome
      icon={<BarChart3 size={14} />}
      title="Payday"
      titleId="spx-close-payday-title"
      className="cpi-payoff-card cpi-payday-exposure-card spx-close-payday-card"
      actions={<span className="spx-close-card-meta">PER CONTRACT · BEFORE FEES · NO MODEL EDGE</span>}
      bodyClassName="spx-close-payday-body"
    >
      {selectedMarket ? (
        <>
          <ConfluenceLedger
            confluence={confluence}
            sources={confluenceSources}
            riskRange={riskRange}
            selectedMarket={selectedMarket}
            data={data}
            priceStructureSource={priceStructureSource}
          />
          <div className="spx-payday-selection">
            <span>Selected contract</span>
            <strong>Cash SPX ≥ {formatIndexLevel(selectedMarket.threshold)} at 4:00 PM ET</strong>
            <i>{zoneLabel(zone)}</i>
          </div>

          <div className="cpi-payday-table-wrap spx-payday-table-wrap">
            <table className="cpi-payday-table spx-payday-table" aria-label="Selected SPX contract settlement analysis">
              <thead>
                <tr>
                  <th>RR scenario</th>
                  <th>SPX close</th>
                  <th>Resolves</th>
                  <th>YES ask</th>
                  <th>YES gross P/L</th>
                  <th>NO ask</th>
                  <th>NO gross P/L</th>
                </tr>
              </thead>
              <tbody>
                {levels.map((level) => {
                  const result = resolutionAtLevel(level.value, selectedMarket.threshold);
                  const yesPayout = result === 'YES' ? 1 : 0;
                  const noPayout = result === 'NO' ? 1 : 0;
                  return (
                    <tr key={level.key}>
                      <th>{level.label}</th>
                      <td>{formatIndexLevel(level.value)}</td>
                      <td><span className={`spx-resolution spx-resolution--${result.toLowerCase()}`}>{result}</span></td>
                      <td>{formatCents(yesAsk)}</td>
                      <td className={yesPayout - yesAsk >= 0 ? 'spx-pnl-positive' : 'spx-pnl-negative'}>{formatSignedDollars(yesAsk == null ? null : yesPayout - yesAsk)}</td>
                      <td>{formatCents(noAsk)}</td>
                      <td className={noPayout - noAsk >= 0 ? 'spx-pnl-positive' : 'spx-pnl-negative'}>{formatSignedDollars(noAsk == null ? null : noPayout - noAsk)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <table className="spx-analytics-table" aria-label="Selected SPX contract diagnostics">
            <tbody>
              <tr>
                <th>Threshold vs LRR</th><td>{formatSignedPoints(Number(selectedMarket.threshold) - Number(riskRange.lrr))}</td>
                <th>Threshold vs midpoint</th><td>{formatSignedPoints(Number(selectedMarket.threshold) - midpoint)}</td>
                <th>Threshold vs HRR</th><td>{formatSignedPoints(Number(selectedMarket.threshold) - Number(riskRange.hrr))}</td>
              </tr>
              <tr>
                <th>YES spread</th><td>{spreadLabel(selectedMarket.yesBid, selectedMarket.yesAsk)}</td>
                <th>YES depth</th><td>{formatContracts(selectedMarket.yesBidSize)} × {formatContracts(selectedMarket.yesAskSize)}</td>
                <th>24h volume / OI</th><td>{formatContracts(selectedMarket.volume24h)} / {formatContracts(selectedMarket.openInterest)}</td>
              </tr>
              <tr>
                <th>Risk Range</th><td>{formatIndexLevel(riskRange.lrr)}–{formatIndexLevel(riskRange.hrr)}</td>
                <th>Hedgeye trend</th><td>{riskRange.trend || '—'}</td>
                <th>IBKR execution</th><td>{data.ibkr?.executionVerified ? 'Verified' : 'Not verified'}</td>
              </tr>
            </tbody>
          </table>

          <div className="spx-position-ledger">
            <span>IBKR exact-event positions</span>
            {!positionsLive ? (
              <p>{positionsMessage || 'Live IBKR position data unavailable.'}</p>
            ) : positions.length === 0 ? (
              <p>No open positions in {data.event.ticker}.</p>
            ) : (
              <table aria-label="Open SPX close positions">
                <tbody>
                  {positions.map((position, index) => (
                    <tr key={position.conId || position.localSymbol || index}>
                      <th>{positionLabel(position)}</th>
                      <td>{formatContracts(Math.abs(positionQuantity(position)))} contracts</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p className="spx-payday-footnote">
            Deterministic $1 settlement arithmetic only. The Risk Range supplies closing levels, not probabilities, fair value, expected value, or position size.
          </p>
        </>
      ) : null}
    </Pmv2CardChrome>
  );
}

function HistoricalPaydayCard({ data, riskRange, selectedMarket, dailySessions, confluence, confluenceSources, priceStructureSource }) {
  const closeValue = Number(data.closeValue);
  const yesMarkets = data.markets.filter((market) => market.result === 'yes');
  const noMarkets = data.markets.filter((market) => market.result === 'no');
  const highestYes = yesMarkets.reduce((value, market) => Math.max(value, Number(market.threshold)), -Infinity);
  const lowestNo = noMarkets.reduce((value, market) => Math.min(value, Number(market.threshold)), Infinity);
  const rangeWidth = Number(riskRange.hrr) - Number(riskRange.lrr);
  const rangePosition = rangeWidth > 0 ? ((closeValue - Number(riskRange.lrr)) / rangeWidth) * 100 : null;
  const result = String(selectedMarket?.result || '').toUpperCase();
  const yesPayout = selectedMarket ? Number(selectedMarket.settlementPayout) : null;
  const noPayout = yesPayout == null ? null : 1 - yesPayout;

  return (
    <Pmv2CardChrome
      icon={<BarChart3 size={14} />}
      title="Payday"
      titleId="spx-close-payday-title"
      className="cpi-payoff-card cpi-payday-exposure-card spx-close-payday-card spx-close-payday-card--historical"
      actions={<span className="spx-close-card-meta spx-close-card-meta--historical">SETTLED · NOT TRADEABLE · NO LIVE QUOTES</span>}
      bodyClassName="spx-close-payday-body"
    >
      {selectedMarket && (
        <>
          <ConfluenceLedger
            confluence={confluence}
            sources={confluenceSources}
            riskRange={riskRange}
            selectedMarket={selectedMarket}
            data={data}
            priceStructureSource={priceStructureSource}
          />
          <div className="spx-payday-selection">
            <span>Selected settled contract</span>
            <strong>Cash SPX ≥ {formatIndexLevel(selectedMarket.threshold)} at 4:00 PM ET</strong>
            <i>{formatEventDate(data.event.closeTime)}</i>
          </div>

          <div className="cpi-payday-table-wrap spx-payday-table-wrap spx-payday-table-wrap--historical">
            <table className="cpi-payday-table spx-payday-table" aria-label="Settled SPX contract payout analysis">
              <thead>
                <tr>
                  <th>Observation</th>
                  <th>Cash close</th>
                  <th>Relative to RR</th>
                  <th>Selected result</th>
                  <th>YES payout</th>
                  <th>NO payout</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Kalshi expiration value</th>
                  <td>{formatIndexLevel(closeValue)}</td>
                  <td>{zoneLabel(classifyCloseAgainstRange(closeValue, riskRange))}</td>
                  <td><span className={`spx-resolution spx-resolution--${result.toLowerCase()}`}>{result}</span></td>
                  <td>{formatSettlementPayout(yesPayout)}</td>
                  <td>{formatSettlementPayout(noPayout)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <table className="spx-analytics-table spx-analytics-table--historical" aria-label="Settled session diagnostics">
            <tbody>
              <tr>
                <th>Hedgeye RR</th><td>{formatIndexLevel(riskRange.lrr)}–{formatIndexLevel(riskRange.hrr)}</td>
                <th>Close location</th><td>{Number.isFinite(rangePosition) ? `${rangePosition.toFixed(1)}% of RR` : '—'}</td>
                <th>Trend</th><td>{riskRange.trend || '—'}</td>
              </tr>
              <tr>
                <th>Highest YES</th><td>{Number.isFinite(highestYes) ? formatIndexLevel(highestYes) : '—'}</td>
                <th>Lowest NO</th><td>{Number.isFinite(lowestNo) ? formatIndexLevel(lowestNo) : '—'}</td>
                <th>Crossing interval</th><td>{Number.isFinite(highestYes) && Number.isFinite(lowestNo) ? `${formatIndexLevel(highestYes)}–${formatIndexLevel(lowestNo)}` : '—'}</td>
              </tr>
              <tr>
                <th>Close vs threshold</th><td>{formatSignedPoints(closeValue - Number(selectedMarket.threshold))}</td>
                <th>Selected volume / OI</th><td>{formatContracts(selectedMarket.volumeTotal)} / {formatContracts(selectedMarket.openInterest)}</td>
                <th>Ladder volume / OI</th><td>{formatContracts(data.venue.volumeTotal)} / {formatContracts(data.venue.openInterest)}</td>
              </tr>
              <tr>
                <th>Event</th><td colSpan="3">{data.event.ticker}</td>
                <th>Finalized strikes</th><td>{data.event.marketCount}</td>
              </tr>
            </tbody>
          </table>

          <div className="spx-session-history-wrap">
            <table className="spx-session-history-table" aria-label="Recent SPX Risk Range settlement history">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Cash close</th>
                  <th>LRR</th>
                  <th>HRR</th>
                  <th>RR width</th>
                  <th>Close vs mid</th>
                  <th>RR position</th>
                  <th>Result</th>
                  <th>Volume / OI</th>
                </tr>
              </thead>
              <tbody>
                {dailySessions.map((session) => {
                  const sessionClose = Number(session.closeValue);
                  const lower = Number(session.riskRange.lrr);
                  const upper = Number(session.riskRange.hrr);
                  const width = upper - lower;
                  const midpoint = (lower + upper) / 2;
                  const position = width > 0 ? ((sessionClose - lower) / width) * 100 : null;
                  const rangeResult = classifyCloseAgainstRange(sessionClose, session.riskRange);
                  return (
                    <tr key={session.eventTicker || session.closeTime} className={session.selected ? 'selected' : ''}>
                      <th>{formatSessionDate(session.closeTime)}</th>
                      <td>{formatIndexLevel(sessionClose)}</td>
                      <td>{formatIndexLevel(lower, 0)}</td>
                      <td>{formatIndexLevel(upper, 0)}</td>
                      <td>{formatIndexLevel(width, 0)}</td>
                      <td>{formatSignedPoints(sessionClose - midpoint)}</td>
                      <td>{Number.isFinite(position) ? `${position.toFixed(1)}%` : '—'}</td>
                      <td><span className={`spx-range-result spx-range-result--${rangeResult}`}>{zoneLabel(rangeResult)}</span></td>
                      <td>{formatContracts(session.venue?.volumeTotal)} / {formatContracts(session.venue?.openInterest)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="spx-payday-footnote spx-payday-footnote--historical">
            Historical settlement record only. Bid, ask, depth, implied probability, and trade controls are intentionally absent.
          </p>
        </>
      )}
    </Pmv2CardChrome>
  );
}

function UnavailableContractsCard({ loading, error, onRefresh, refreshing }) {
  return (
    <Pmv2CardChrome
      icon={<Target size={14} />}
      title="Contracts"
      titleId="spx-close-contracts-title"
      className="cpi-matrix-card spx-close-contracts-card"
      actions={<span className="spx-close-card-meta">{loading ? 'CHECKING LIVE CONTRACTS' : 'CONTRACTS UNAVAILABLE'}</span>}
      bodyClassName="spx-card-state-body"
    >
      <div className="spx-card-state" role="status" aria-label="Contracts availability" aria-live="polite">
        <span className="spx-card-state__icon" aria-hidden="true">
          {loading ? <RefreshCw className="spx-close-spin" size={16} /> : <ShieldAlert size={16} />}
        </span>
        <div>
          <strong>{loading ? 'Checking live contracts' : 'Contracts unavailable'}</strong>
          <p>{loading
            ? 'Checking the verified 4 p.m. cash-index ladder and its date-matched Risk Range.'
            : error || 'No verified live contract or date-matched settled contract is available.'}</p>
        </div>
        {!loading && (
          <button type="button" className="spx-close-refresh" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw size={13} className={refreshing ? 'spx-close-spin' : ''} aria-hidden="true" />
            Retry live scan
          </button>
        )}
      </div>
    </Pmv2CardChrome>
  );
}

function UnavailablePaydayCard({ loading }) {
  const value = loading ? 'Checking' : 'Unavailable';
  return (
    <Pmv2CardChrome
      icon={<BarChart3 size={14} />}
      title="Payday"
      titleId="spx-close-payday-title"
      className="cpi-payoff-card cpi-payday-exposure-card spx-close-payday-card"
      actions={<span className="spx-close-card-meta">NO VERIFIED CONTRACT</span>}
      bodyClassName="spx-unavailable-analysis"
    >
      <section aria-label="Contract-dependent analysis status">
        <p>Contract-dependent analysis stays disabled until a verified contract is available.</p>
        <dl>
          <div><dt>Selected contract</dt><dd>{value}</dd></div>
          <div><dt>Live quote</dt><dd>{value}</dd></div>
          <div><dt>Payoff analysis</dt><dd>{value}</dd></div>
        </dl>
      </section>
    </Pmv2CardChrome>
  );
}

function EmptyHeader({ sessions, loading, refreshing, onRefresh, onClose }) {
  return (
    <header className="cpi-calculator-header cpi-calendar-header spx-daily-header spx-daily-header--empty">
      <div className="cpi-calendar-title-row">
        <div className="cpi-calendar-title-block">
          <span className="cpi-calendar-title-accent" aria-hidden="true" />
          <div><h1>S&amp;P 500 Close</h1></div>
        </div>
        <div className="cpi-calendar-meta">
          <strong>{loading ? 'Checking daily contracts' : 'Daily contract scan unavailable'}</strong>
          <span className="cpi-calendar-settlement">Cash index · 4:00 PM ET</span>
        </div>
        <div className="spx-close-header-actions">
          <span className="spx-close-mode-label">NO VERIFIED CONTRACT</span>
          <button type="button" className="spx-close-refresh" onClick={onRefresh} disabled={refreshing} aria-label="Refresh SPX close workbench">
            <RefreshCw size={13} className={refreshing ? 'spx-close-spin' : ''} aria-hidden="true" />
            Refresh
          </button>
          {onClose && (
            <button type="button" className="spx-close-close" onClick={onClose} aria-label="Close SPX Close"><X size={17} /></button>
          )}
        </div>
      </div>
      {sessions.length > 0 && (
        <div className="cpi-calendar-grid spx-daily-calendar-grid" aria-label="Recent settled SPX Risk Ranges and cash closes">
          {sessions.map((session) => (
            <DailySessionCard key={session.eventTicker || session.closeTime} session={session} />
          ))}
        </div>
      )}
    </header>
  );
}

export default function PredictionMarketsSandbox({
  onClose,
  portfolioData,
  sharedPositionsState,
  embedded = false,
}) {
  const [data, setData] = useState(null);
  const [liveSpx, setLiveSpx] = useState(EMPTY_LIVE_SPX);
  const [riskRange, setRiskRange] = useState(null);
  const [riskRangeHistory, setRiskRangeHistory] = useState([]);
  const [recentSettled, setRecentSettled] = useState(null);
  const [positions, setPositions] = useState([]);
  const [positionsLive, setPositionsLive] = useState(false);
  const [positionsMessage, setPositionsMessage] = useState(null);
  const [confluenceSources, setConfluenceSources] = useState(EMPTY_CONFLUENCE_SOURCES);
  const [priceStructureSource, setPriceStructureSource] = useState(EMPTY_PRICE_STRUCTURE_SOURCE);
  const [selectedTicker, setSelectedTicker] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const priceStructureRequestRef = useRef(0);
  const sharedPositionsRef = useRef(sharedPositionsState);

  useEffect(() => {
    sharedPositionsRef.current = sharedPositionsState;
  }, [sharedPositionsState]);

  const loadPriceStructure = useCallback(async () => {
    const requestId = priceStructureRequestRef.current + 1;
    priceStructureRequestRef.current = requestId;
    setPriceStructureSource(EMPTY_PRICE_STRUCTURE_SOURCE);
    try {
      const payload = await MarketDataService.getSecurityRiskMetrics(
        ['SPX'],
        { forceRefresh: true },
      );
      const normalized = normalizeCompletedPriceStructure(payload);
      if (!mountedRef.current || requestId !== priceStructureRequestRef.current) return;
      setPriceStructureSource(normalized);
    } catch (loadError) {
      if (!mountedRef.current || requestId !== priceStructureRequestRef.current) return;
      setPriceStructureSource({
        status: 'unavailable',
        structure: null,
        source: null,
        fetchedAt: null,
        error: loadError?.message || 'Completed cash-SPX high/low structure is unavailable.',
      });
    }
  }, []);

  const loadWorkbench = useCallback(async ({ manual = false } = {}) => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (manual) setRefreshing(true);
    setLiveSpx(EMPTY_LIVE_SPX);
    try {
      const [
        liveResult,
        rangesResult,
        historyResult,
        settledResult,
        recentResult,
        positionResult,
        tradeResult,
        usdResult,
        volatilityResult,
        structureResult,
        liveSpxResult,
      ] = await Promise.all([
        predictionMarketsIngestService.getSpxCloseWorkbench()
          .then((value) => ({ value, error: null }))
          .catch((loadError) => ({ value: null, error: loadError })),
        MarketDataService.getRiskRanges(['SPX'])
          .then((value) => ({ value, error: null }))
          .catch((loadError) => ({ value: null, error: loadError })),
        MarketDataService.getRiskRangeHistory('SPX', 30)
          .then((value) => ({ value, error: null }))
          .catch((loadError) => ({ value: null, error: loadError })),
        predictionMarketsIngestService.getLastSettledSpxCloseSession()
          .then((value) => ({ value, error: null }))
          .catch((loadError) => ({ value: null, error: loadError })),
        predictionMarketsIngestService.getRecentSettledSpxCloseSessions(DAILY_SESSION_COUNT)
          .then((value) => ({ value, error: null }))
          .catch((loadError) => ({ value: null, error: loadError })),
        sharedPositionsRef.current
          ? Promise.resolve({
            meta: {
              source: ['live', 'partial'].includes(sharedPositionsRef.current.status)
                ? 'ibkr_live'
                : 'ibkr_live_unavailable',
              status: sharedPositionsRef.current.status,
              message: sharedPositionsRef.current.message,
            },
            positions: sharedPositionsRef.current.positions || [],
          })
          : MarketDataService.getPortfolioPredictionMarketPositions({
            primaryAccount: portfolioData?.accountId || null,
          }).catch((positionError) => ({
            meta: { source: 'ibkr_live_unavailable', message: positionError.message },
            positions: [],
          })),
        MarketDataService.getHedgeyeSnapshot('momo-tracker')
          .then((value) => ({ value, error: null }))
          .catch((loadError) => ({ value: null, error: loadError })),
        MarketDataService.getUsdCorrelations()
          .then((value) => ({ value, error: null }))
          .catch((loadError) => ({ value: null, error: loadError })),
        MarketDataService.getVolatilitySnapshot()
          .then((value) => ({ value, error: null }))
          .catch((loadError) => ({ value: null, error: loadError })),
        MarketDataService.getHedgeyeSnapshot('market-structure')
          .then((value) => ({ value, error: null }))
          .catch((loadError) => ({ value: null, error: loadError })),
        loadVerifiedLiveSpxQuote(),
      ]);
      if (!mountedRef.current || requestId !== requestRef.current) return;

      const marketData = liveResult.value;
      setLiveSpx(liveSpxResult);
      const nextRiskRange = rangesResult.value?.SPX;
      const history = Array.isArray(historyResult.value) ? historyResult.value : [];
      setRiskRangeHistory(history);
      setRecentSettled(recentResult.value);
      const nextConfluenceSources = {
        tradeSnapshot: tradeResult.value,
        usdSnapshot: usdResult.value,
        volatilitySnapshot: volatilityResult.value,
        marketStructureSnapshot: structureResult.value,
      };
      const hasLiveLadder = Boolean(
        marketData?.ok &&
        Array.isArray(marketData.markets) &&
        marketData.markets.length > 0 &&
        hasCurrentSpxRiskRange(nextRiskRange, marketData.event?.closeTime)
      );

      if (hasLiveLadder) {
        const relevant = selectRelevantSpxMarkets(marketData.markets, nextRiskRange);
        if (!relevant.length) throw new Error('No complete SPX close books are near today’s Hedgeye Risk Range.');
        const midpoint = (Number(nextRiskRange.lrr) + Number(nextRiskRange.hrr)) / 2;
        const defaultMarket = [...relevant].sort((left, right) => (
          Math.abs(Number(left.threshold) - midpoint) - Math.abs(Number(right.threshold) - midpoint)
        ))[0];
        const livePositions = positionResult?.meta?.source === 'ibkr_live';
        const exactPositions = livePositions
          ? (positionResult.positions || []).filter((position) => isSpxClosePosition(position, marketData.event.ticker))
          : [];

        setData(marketData);
        setRiskRange(nextRiskRange);
        setPositions(exactPositions);
        setPositionsLive(livePositions);
        setPositionsMessage(livePositions ? null : (positionResult?.meta?.message || 'Live IBKR position data is unavailable.'));
        setConfluenceSources(nextConfluenceSources);
        setSelectedTicker((current) => relevant.some((market) => market.ticker === current) ? current : defaultMarket.ticker);
        setError(null);
        return;
      }

      if (liveResult.error && !isExpectedLiveUnavailable(liveResult.error)) throw liveResult.error;
      if (marketData?.ok && !hasCurrentSpxRiskRange(nextRiskRange, marketData.event?.closeTime) && historyResult.error) {
        throw rangesResult.error || historyResult.error;
      }

      const historicalData = settledResult.value;
      const historicalRiskRange = findSpxRiskRangeForEvent(history, historicalData?.event?.closeTime);
      if (!historicalData?.ok || historicalData.historicalOnly !== true || !historicalData.markets?.length) {
        throw settledResult.error || liveResult.error || new Error('No settled SPX close session is available.');
      }
      if (!historicalRiskRange) {
        throw new Error(`No date-matched Hedgeye SPX Risk Range is available for ${formatEventDate(historicalData.event?.closeTime)}.`);
      }
      const relevantHistory = selectRelevantSpxMarkets(historicalData.markets, historicalRiskRange);
      if (!relevantHistory.length) throw new Error('No settled SPX thresholds are near the matched Risk Range.');
      const historicalMidpoint = (Number(historicalRiskRange.lrr) + Number(historicalRiskRange.hrr)) / 2;
      const defaultHistoryMarket = [...relevantHistory].sort((left, right) => (
        Math.abs(Number(left.threshold) - historicalMidpoint) -
        Math.abs(Number(right.threshold) - historicalMidpoint)
      ))[0];

      setData(historicalData);
      setRiskRange(historicalRiskRange);
      setPositions([]);
      setPositionsLive(false);
      setPositionsMessage(null);
      setConfluenceSources(nextConfluenceSources);
      setSelectedTicker((current) => relevantHistory.some((market) => market.ticker === current) ? current : defaultHistoryMarket.ticker);
      setError(null);
    } catch (loadError) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setData(null);
      setRiskRange(null);
      setPositions([]);
      setPositionsLive(false);
      setPositionsMessage(null);
      setConfluenceSources(EMPTY_CONFLUENCE_SOURCES);
      setSelectedTicker(null);
      setError(loadError?.response?.data?.error || loadError.message || 'Live SPX close data is unavailable.');
    } finally {
      if (mountedRef.current && requestId === requestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [portfolioData?.accountId]);

  useEffect(() => {
    if (!sharedPositionsState || !data?.event?.ticker || data?.historicalOnly) return;
    const livePositions = ['live', 'partial'].includes(sharedPositionsState.status);
    setPositions(livePositions
      ? (sharedPositionsState.positions || []).filter((position) => isSpxClosePosition(position, data.event.ticker))
      : []);
    setPositionsLive(livePositions);
    setPositionsMessage(livePositions
      ? (sharedPositionsState.status === 'partial' ? sharedPositionsState.message : null)
      : (sharedPositionsState.message || 'Live IBKR position data is unavailable.'));
  }, [data?.event?.ticker, data?.historicalOnly, sharedPositionsState]);

  useEffect(() => {
    mountedRef.current = true;
    loadWorkbench();
    const stopPolling = startVisibilityAwarePolling({
      poll: loadWorkbench,
      intervalMs: SPX_CLOSE_POLL_MS,
    });
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      priceStructureRequestRef.current += 1;
      stopPolling();
    };
  }, [loadWorkbench]);

  const priceStructureTargetDate = dateKeyInTimeZone(data?.event?.closeTime);
  useEffect(() => {
    if (priceStructureTargetDate) loadPriceStructure();
  }, [loadPriceStructure, priceStructureTargetDate]);

  const refreshWorkbench = useCallback(() => {
    loadWorkbench({ manual: true });
    loadPriceStructure();
  }, [loadPriceStructure, loadWorkbench]);

  const relevantMarkets = useMemo(
    () => data && riskRange ? selectRelevantSpxMarkets(data.markets, riskRange) : [],
    [data, riskRange],
  );
  const selectedMarket = useMemo(
    () => relevantMarkets.find((market) => market.ticker === selectedTicker) || relevantMarkets[0] || null,
    [relevantMarkets, selectedTicker],
  );
  const dailySessions = useMemo(
    () => buildDailySessions(data, riskRange, riskRangeHistory, recentSettled),
    [data, riskRange, riskRangeHistory, recentSettled],
  );
  const normalizedConfluenceSources = useMemo(() => ({
    trade: extractSpxTradeSignal(confluenceSources.tradeSnapshot, riskRange),
    usd: normalizeUsdCorrelationSnapshot(confluenceSources.usdSnapshot),
    vix: normalizeVixSnapshot(confluenceSources.volatilitySnapshot),
    marketStructure: normalizeMarketStructureSnapshot(confluenceSources.marketStructureSnapshot),
  }), [confluenceSources, riskRange]);
  const sessionConfluenceSources = useMemo(() => {
    if (!data?.historicalOnly) return normalizedConfluenceSources;
    return {
      trade: extractSpxTradeSignal(null, null),
      usd: normalizeUsdCorrelationSnapshot(null),
      vix: normalizeVixSnapshot(null),
      marketStructure: normalizeMarketStructureSnapshot(null),
    };
  }, [data?.historicalOnly, normalizedConfluenceSources]);
  const confluence = useMemo(() => {
    if (!data || !riskRange || !selectedMarket) return null;
    return buildSpxCloseConfluence({
      targetDate: dateKeyInTimeZone(data.event?.closeTime),
      historical: Boolean(data.historicalOnly),
      riskRange,
      trade: sessionConfluenceSources.trade,
      selectedMarket,
      usd: sessionConfluenceSources.usd,
      vix: sessionConfluenceSources.vix,
      marketStructure: sessionConfluenceSources.marketStructure,
    });
  }, [data, riskRange, selectedMarket, sessionConfluenceSources]);

  return (
    <div className="pmv2-wrap pmv2-redesign spx-close-workbench" data-testid="spx-close-workbench">
      <div className="cpi-workbench-shell spx-close-workbench-shell">
        {data && riskRange ? (
          <>
            <SpxDailyHeader
              data={data}
              riskRange={riskRange}
              sessions={dailySessions}
              refreshing={refreshing}
              onRefresh={refreshWorkbench}
              onClose={embedded ? null : onClose}
            />
            <main className="cpi-workbench-grid spx-close-analysis-grid">
              <ContractsCard
                data={data}
                markets={relevantMarkets}
                riskRange={riskRange}
                liveSpx={liveSpx}
                selectedTicker={selectedMarket?.ticker}
                onSelect={setSelectedTicker}
              />
              {data.historicalOnly ? (
                <HistoricalPaydayCard
                  data={data}
                  riskRange={riskRange}
                  selectedMarket={selectedMarket}
                  dailySessions={dailySessions}
                  confluence={confluence}
                  confluenceSources={sessionConfluenceSources}
                  priceStructureSource={priceStructureSource}
                />
              ) : (
                <LivePaydayCard
                  data={data}
                  riskRange={riskRange}
                  selectedMarket={selectedMarket}
                  positions={positions}
                  positionsLive={positionsLive}
                  positionsMessage={positionsMessage}
                  confluence={confluence}
                  confluenceSources={sessionConfluenceSources}
                  priceStructureSource={priceStructureSource}
                />
              )}
            </main>
          </>
        ) : (
          <>
            <EmptyHeader
              sessions={dailySessions}
              loading={loading}
              refreshing={refreshing}
              onRefresh={refreshWorkbench}
              onClose={embedded ? null : onClose}
            />
            <main className="cpi-workbench-grid spx-close-analysis-grid">
              <UnavailableContractsCard
                loading={loading}
                error={error}
                refreshing={refreshing}
                onRefresh={refreshWorkbench}
              />
              <UnavailablePaydayCard loading={loading} />
            </main>
          </>
        )}
      </div>
    </div>
  );
}
