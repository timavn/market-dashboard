const crypto = require('crypto');
const { DISPLAY_STATUSES, PERFORMANCE_MARKET_KEYS, normalizeMarket, displayStateFromRecord, sortPerformanceRows } = require('../utils/contractPerformanceSort.cjs');
const { zonedTimeToUtc } = require('date-fns-tz');
const { parseFesContractIdentity, validateOfficialFesSchedule } = require('./forecastExFesIdentity.cjs');

const DEFAULT_TABLE_NAME = 'PredictionMarketPerformanceLedger';
const LIFECYCLE_PREFIX = 'lifecycle#';
const EXECUTION_PREFIX = 'execution#';
const REVISION_PREFIX = 'revision#';
const IMPORT_PREFIX = 'import#';
const HEALTH_KEY = 'health#capture';
const LEASE_KEY = 'lease#reconciler';
const SYSTEM_ACCOUNT_ID = 'system#prediction-performance';
const MANAGED_ACCOUNT_PREFIX = 'managed-account#';
const EPSILON = 1e-9;
const ACTIVE_STATUSES = new Set(['open', 'awaiting_resolution']);
const REVIEW_STATUSES = new Set(['review']);
const SCHEDULE_REPAIR_REASONS = new Set(['unsupported_contract_identity', 'contract_schedule_evidence_conflict']);
const BROKER_SETTLEMENT_POSTING_STATUS = 'broker_settlement_posting';
const BROKER_EXECUTION_REPRESENTATION_STATUS = 'broker_execution_representation';
const DEFAULT_RETENTION_SECONDS = 10 * 365 * 24 * 60 * 60;
const HEALTH_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MICROS_PER_DOLLAR = 1_000_000;
const MAX_TRANSACTION_ITEMS = 100;
const FORECASTEX_CENTRAL_TIME_ZONE = 'America/Chicago';
const FORECASTEX_LEDGER_MODEL_VERSION = 'forecast_ex_economic_v2';
const FORECASTEX_EXCHANGE_FEE_PER_CONTRACT = 0.01;
const PAIRED_OFFSET_COMPONENT_STATUS = 'paired_offset_component';
const MONEY_FIELDS = Object.freeze({
  price: 'priceMicros',
  commission: 'commissionMicros',
  tax: 'taxMicros',
  entryPrincipal: 'entryPrincipalMicros',
  fees: 'feesMicros',
  paid: 'paidMicros',
  risked: 'riskedMicros',
  pnl: 'pnlMicros',
  realizedPnl: 'realizedPnlMicros',
  entryCost: 'entryCostMicros',
  exitFees: 'exitFeesMicros',
  grossExitProceeds: 'grossExitProceedsMicros',
  netExitProceeds: 'netExitProceedsMicros',
  remainingPayout: 'remainingPayoutMicros',
  holdToExpiryPnl: 'holdToExpiryPnlMicros',
  savedVsHold: 'savedVsHoldMicros',
});

function text(value) {
  return String(value == null ? '' : value).trim();
}

function finite(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toMoneyMicros(value) {
  const number = finite(value);
  if (number == null) return null;
  const micros = Math.round(number * MICROS_PER_DOLLAR);
  if (!Number.isSafeInteger(micros)) throw new Error('A ledger money value exceeds the safe microdollar range.');
  return micros;
}

function fromMoneyMicros(value) {
  const micros = finite(value);
  return micros == null ? null : micros / MICROS_PER_DOLLAR;
}

function roundMoney(value) {
  const number = finite(value);
  return number == null ? null : Number(number.toFixed(6));
}

function serializeMoneyFields(item = {}) {
  const next = { ...item };
  Object.entries(MONEY_FIELDS).forEach(([field, microsField]) => {
    if (next[field] === undefined) return;
    const micros = toMoneyMicros(next[field]);
    delete next[field];
    if (micros != null) next[microsField] = micros;
    else delete next[microsField];
  });
  return next;
}

function deserializeMoneyFields(item = {}) {
  const next = { ...item };
  Object.entries(MONEY_FIELDS).forEach(([field, microsField]) => {
    if (next[microsField] === undefined) return;
    next[field] = fromMoneyMicros(next[microsField]);
  });
  return next;
}

function serializeLedgerItem(item = {}) {
  const next = serializeMoneyFields(item);
  delete next._expectedVersion;
  delete next._createOnly;
  return next;
}

function deserializeLedgerItem(item = {}) {
  return deserializeMoneyFields(item);
}

function timestamp(value) {
  const raw = text(value);
  if (!raw) return null;
  const compactDateTime = raw.match(/^(\d{4})(\d{2})(\d{2})[ T](\d{2}):?(\d{2}):?(\d{2})(?:\.(\d{1,3}))?Z?$/);
  if (compactDateTime) {
    const parsed = Date.UTC(
      Number(compactDateTime[1]),
      Number(compactDateTime[2]) - 1,
      Number(compactDateTime[3]),
      Number(compactDateTime[4]),
      Number(compactDateTime[5]),
      Number(compactDateTime[6]),
      Number(String(compactDateTime[7] || '').padEnd(3, '0') || 0),
    );
    return Number.isFinite(parsed) ? parsed : null;
  }
  const compactDay = raw.match(/^(\d{4})(\d{2})(\d{2})(?:[ T].*)?$/);
  if (compactDay) {
    const parsed = Date.UTC(Number(compactDay[1]), Number(compactDay[2]) - 1, Number(compactDay[3]));
    return Number.isFinite(parsed) ? parsed : null;
  }
  const compactMonth = raw.match(/^(\d{4})(\d{2})$/);
  if (compactMonth) {
    const parsed = Date.UTC(Number(compactMonth[1]), Number(compactMonth[2]) - 1, 1);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = timestamp(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function dateOnly(value, fallback = null) {
  const parsed = iso(value);
  return parsed ? parsed.slice(0, 10) : fallback;
}


function performanceSummaryKeys() {
  return ['all', ...PERFORMANCE_MARKET_KEYS];
}

function emptyPerformanceSummary() {
  return { count: 0, risked: 0, paid: 0, pnl: 0, roi: null };
}

function requestedPerformanceMarket(value) {
  const requested = String(value || 'all').toLowerCase();
  if (requested === 'spx' || requested === 'es') return 'sp500';
  if (requested === 'nq' || requested === 'nasdaq' || requested === 'nasdaq-100') return 'nasdaq100';
  if (requested === 'btc') return 'bitcoin';
  if (requested === 'eth') return 'ethereum';
  if (requested === 'all' || PERFORMANCE_MARKET_KEYS.includes(requested)) return requested;
  return 'all';
}


function normalizeDirection(value) {
  const raw = text(value).toUpperCase().replace(/[^A-Z]/g, '');
  if (raw === 'BUY' || raw === 'BOT' || raw === 'B') return 'BUY';
  if (raw === 'SELL' || raw === 'SLD' || raw === 'S') return 'SELL';
  return null;
}

function normalizeContractSide(value, source = '') {
  const raw = text(value).toUpperCase();
  if (/\bYES\b|[_-]YES(?:$|[_-])/.test(raw)) return 'YES';
  if (/\bNO\b|[_-]NO(?:$|[_-])/.test(raw)) return 'NO';
  const fromSource = text(source).toUpperCase();
  if (/\bYES\b|[_-]YES(?:$|[_-])/.test(fromSource)) return 'YES';
  if (/\bNO\b|[_-]NO(?:$|[_-])/.test(fromSource)) return 'NO';
  return null;
}

function normalizeStrike(value, source = '') {
  const direct = finite(value);
  if (direct != null) return direct;
  const raw = text(source);
  const venueTicker = raw.match(/(?:KX(?:WTI[A-Z]*|INX[A-Z]*|CPI[A-Z0-9]*|GOLD[A-Z]*|BTC|ETH)[-_][A-Z0-9]+|(?:COMCO|METLG|FES|FNQ)[_-]\d{6}|CPIY[_-]\d{4})[-_](?:T|B)?(-?\d+(?:\.\d+)?)[-_](?:YES|NO)\b/i);
  if (venueTicker) return finite(venueTicker[1]);
  const percent = raw.match(/(?:ABOVE|BELOW|CPI|INFLATION)?\s*(-?\d+(?:\.\d+)?)\s*%/i);
  if (percent) return finite(percent[1]);
  const dollar = raw.match(/\$\s*(\d+(?:\.\d+)?)/);
  if (dollar) return finite(dollar[1]);
  const ticker = raw.match(/(?:^|[-_\s])T(\d+(?:\.\d+)?)(?:[-_\s]|$)/i);
  if (ticker) return finite(ticker[1]);
  const numeric = raw.match(/(?:ABOVE|BELOW|THRESHOLD|STRIKE|SPX|INX|WTI)\s*(?:PRICE|VALUE|INDEX)?\s*(?:IS\s*)?(?:\$\s*)?(-?\d+(?:\.\d+)?)/i);
  return numeric ? finite(numeric[1]) : null;
}

function normalizeContractRule(value, source = '') {
  const explicit = text(value).toLowerCase();
  if (/^(above|greater|greater_than|at_or_above)$/.test(explicit)) return 'above';
  if (/^(below|less|less_than|under)$/.test(explicit)) return 'below';
  if (/between|bucket|range/.test(explicit)) return 'range';
  if (/\bBELOW\b|\bLESS\b|\bUNDER\b/i.test(source)) return 'below';
  if (/\bABOVE\b|\bGREATER\b/i.test(source)) return 'above';
  const thresholdMarker = source.match(/[-_]([TB])(?=-?\d)/i)?.[1]?.toUpperCase();
  if (thresholdMarker === 'B') return 'below';
  if (thresholdMarker === 'T') return 'above';
  return null;
}

function deriveEventTicker(source = '') {
  const raw = text(source).toUpperCase();
  const kalshi = raw.match(/\b(KX(?:WTI[A-Z]*|INX[A-Z]*|CPI[A-Z0-9]*|GOLD[A-Z]*|BTC|ETH)[-_]\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:\d{0,4}(?:H\d{4})?)?)\b/);
  if (kalshi) return kalshi[1].replace(/_/g, '-');
  const forecastEx = raw.match(/(?:^|[^A-Z0-9])((?:COMCO|METLG|FES|FNQ|CPIY)[_-]\d{4,6}[_-]-?\d+(?:\.\d+)?)(?=$|[_-](?:YES|NO)(?:$|[^A-Z0-9])|[^A-Z0-9_])/);
  return forecastEx ? forecastEx[1].replace(/-/g, '_') : null;
}

function compactDate(value) {
  const raw = text(value);
  const iso = raw.match(/^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  if (iso) {
    const normalized = `${iso[1]}${iso[2]}${iso[3]}`;
    const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return date.toISOString().slice(0, 10).replaceAll('-', '') === normalized ? normalized : null;
  }
  const compact = raw.match(/^(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
  if (!compact) return null;
  const date = new Date(Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3])));
  const normalized = date.toISOString().slice(0, 10).replaceAll('-', '');
  return normalized === compact.slice(1, 4).join('') ? normalized : null;
}

const FORECASTEX_THRESHOLD_PRODUCTS = Object.freeze({
  COMCO: Object.freeze({ market: 'wti', secType: 'OPT', symbols: Object.freeze(['COMCO']), tradingClass: 'COMCO' }),
  METLG: Object.freeze({ market: 'gold', secType: 'OPT', symbols: Object.freeze(['METLG']), tradingClass: 'METLG' }),
  FES: Object.freeze({ market: 'sp500', secType: 'FOP', symbols: Object.freeze(['ES', 'FES']), tradingClass: 'FES' }),
  CPIY: Object.freeze({ market: 'cpi', secType: 'OPT', symbols: Object.freeze(['CPIY']), tradingClass: 'CPIY' }),
});

function brokerContractSide(value) {
  const right = text(value).toUpperCase().replace(/[^A-Z]/g, '');
  if (right === 'C' || right === 'CALL') return 'YES';
  if (right === 'P' || right === 'PUT') return 'NO';
  return null;
}

function forecastExCpiIdentity(raw = {}) {
  const source = [
    raw.contractKey,
    raw.localSymbol,
    raw.eventTicker,
    raw.ticker,
    raw.symbol,
    raw.description,
    raw.contractDescription,
  ].filter(Boolean).join(' ').toUpperCase();
  const matches = [...source.matchAll(/(?:^|[^A-Z0-9])(CPIY[_-](\d{2})(\d{2})[_-](-?\d+(?:\.\d+)?)(?:[_-](YES|NO))?)(?=$|[^A-Z0-9])/g)];
  const identities = new Map();
  matches.forEach((match) => {
    const reportMonthNumber = Number(match[2]);
    const reportYear = 2000 + Number(match[3]);
    const strike = finite(match[4]);
    if (reportMonthNumber < 1 || reportMonthNumber > 12 || strike == null) return;
    const dateToken = `${match[2]}${match[3]}`;
    const key = `${dateToken}:${strike}`;
    const contractSide = match[5] || null;
    const existing = identities.get(key);
    if (existing?.contractSide && contractSide && existing.contractSide !== contractSide) {
      identities.set(key, { invalid: true });
      return;
    }
    identities.set(key, {
      productCode: 'CPIY',
      market: 'cpi',
      eventContract: `CPIY_${dateToken}_${match[4]}`,
      reportMonth: `${reportYear}-${match[2]}`,
      strike,
      contractSide: contractSide || existing?.contractSide || null,
      contractRule: 'above',
      cpiMeasurement: 'headline_yoy',
      cpiSeriesId: 'CUUR0000SA0',
      cpiRoundingDecimals: 1,
    });
  });
  if (identities.size !== 1) return null;
  const identity = [...identities.values()][0];
  if (identity.invalid) return null;

  const explicitExpiration = text(raw.expiration || raw.lastTradeDateOrContractMonth || raw.expiry);
  const normalizedExpiration = explicitExpiration ? compactDate(explicitExpiration) : null;
  if (explicitExpiration && !normalizedExpiration) return null;
  const explicitStrike = finite(raw.strike ?? raw.threshold ?? raw.floorStrike);
  if (explicitStrike != null && Math.abs(explicitStrike - identity.strike) > EPSILON) return null;
  const explicitSide = normalizeContractSide(raw.contractSide || raw.sideLabel, source);
  const brokerSide = brokerContractSide(raw.right || raw.contractRight || raw.contractSide);
  if (identity.contractSide && explicitSide && identity.contractSide !== explicitSide) return null;
  if (identity.contractSide && brokerSide && identity.contractSide !== brokerSide) return null;
  if (explicitSide && brokerSide && explicitSide !== brokerSide) return null;

  const product = FORECASTEX_THRESHOLD_PRODUCTS.CPIY;
  const secType = text(raw.secType || raw.securityType).toUpperCase();
  if (secType && ![product.secType, 'EVENT_FORECASTX'].includes(secType)) return null;
  const symbol = text(raw.symbol).toUpperCase();
  if (symbol && !product.symbols.some((candidate) => symbol === candidate || symbol.startsWith(`${candidate}_`))) return null;
  const tradingClass = text(raw.tradingClass).toUpperCase();
  if (tradingClass && tradingClass !== product.tradingClass) return null;
  const exchange = text(raw.exchange || raw.venue).toUpperCase();
  if (exchange && exchange !== '--' && !['FORECASTX', 'FORECASTEX'].includes(exchange)) return null;
  const explicitMarket = text(raw.market || raw.marketFamily || raw.marketProduct);
  if (explicitMarket && normalizeMarket(explicitMarket) !== product.market) return null;
  const explicitRule = text(raw.contractRule || raw.rule || raw.thresholdDirection || raw.strikeType);
  if (explicitRule && normalizeContractRule(explicitRule, source) !== 'above') return null;

  return {
    ...identity,
    resolutionDate: normalizedExpiration
      ? `${normalizedExpiration.slice(0, 4)}-${normalizedExpiration.slice(4, 6)}-${normalizedExpiration.slice(6, 8)}`
      : null,
    contractSide: identity.contractSide || explicitSide || brokerSide,
  };
}

function forecastExThresholdIdentity(raw = {}) {
  const source = [
    raw.contractKey,
    raw.localSymbol,
    raw.eventTicker,
    raw.ticker,
    raw.symbol,
    raw.description,
    raw.contractDescription,
  ].filter(Boolean).join(' ').toUpperCase();
  const matches = [...source.matchAll(/(?:^|[^A-Z0-9])((COMCO|METLG|FES)[_-](\d{2})(\d{2})(\d{2})[_-](-?\d+(?:\.\d+)?)(?:[_-](YES|NO))?)(?=$|[^A-Z0-9])/g)];
  const identities = new Map();
  matches.forEach((match) => {
    const productCode = match[2];
    const resolutionCompact = compactDate(`20${match[5]}${match[3]}${match[4]}`);
    const strike = finite(match[6]);
    if (!resolutionCompact || strike == null) return;
    const resolutionDate = `${resolutionCompact.slice(0, 4)}-${resolutionCompact.slice(4, 6)}-${resolutionCompact.slice(6, 8)}`;
    const contractSide = match[7] || null;
    const dateToken = `${match[3]}${match[4]}${match[5]}`;
    const key = `${productCode}:${dateToken}:${strike}`;
    const existing = identities.get(key);
    if (existing?.contractSide && contractSide && existing.contractSide !== contractSide) {
      identities.set(key, { invalid: true });
      return;
    }
    identities.set(key, {
      productCode,
      market: FORECASTEX_THRESHOLD_PRODUCTS[productCode].market,
      eventContract: `${productCode}_${dateToken}_${match[6]}`,
      resolutionDate,
      strike,
      contractSide: contractSide || existing?.contractSide || null,
      contractRule: 'above',
    });
  });
  const hasCpiIdentityToken = /(?:^|[^A-Z0-9])CPIY[_-]\d{4}[_-]-?\d+(?:\.\d+)?(?:[_-](?:YES|NO))?(?=$|[^A-Z0-9])/.test(source);
  if (identities.size === 0) return forecastExCpiIdentity(raw);
  if (identities.size !== 1 || hasCpiIdentityToken) return null;
  const identity = [...identities.values()][0];
  if (identity.invalid) return null;
  const explicitExpiration = text(raw.expiration || raw.lastTradeDateOrContractMonth || raw.expiry);
  const normalizedExpiration = explicitExpiration ? compactDate(explicitExpiration) : null;
  if (identity.productCode === 'FES') {
    if (explicitExpiration && !normalizedExpiration) return null;
    try {
      const dates = parseFesContractIdentity(identity.eventContract, {
        eventDate: raw.eventDate ?? null,
        expirationDate: normalizedExpiration
          ? `${normalizedExpiration.slice(0, 4)}-${normalizedExpiration.slice(4, 6)}-${normalizedExpiration.slice(6, 8)}`
          : null,
      });
      identity.eventDate = dates.eventDate;
      identity.expirationDate = dates.expirationDate;
      identity.resolutionDate = dates.expirationDate > dates.eventDate ? dates.expirationDate : null;
    } catch (_error) {
      return null;
    }
  } else if (explicitExpiration && normalizedExpiration !== identity.resolutionDate.replaceAll('-', '')) return null;
  const explicitStrike = finite(raw.strike ?? raw.threshold ?? raw.floorStrike);
  if (explicitStrike != null && Math.abs(explicitStrike - identity.strike) > EPSILON) return null;
  const explicitSide = normalizeContractSide(raw.contractSide || raw.sideLabel, source);
  const brokerSide = brokerContractSide(raw.right || raw.contractRight || raw.contractSide);
  if (identity.contractSide && explicitSide && identity.contractSide !== explicitSide) return null;
  if (identity.contractSide && brokerSide && identity.contractSide !== brokerSide) return null;
  if (explicitSide && brokerSide && explicitSide !== brokerSide) return null;

  const product = FORECASTEX_THRESHOLD_PRODUCTS[identity.productCode];
  const secType = text(raw.secType || raw.securityType).toUpperCase();
  if (secType && ![product.secType, 'EVENT_FORECASTX'].includes(secType)) return null;
  const symbol = text(raw.symbol).toUpperCase();
  if (symbol && !product.symbols.some((candidate) => symbol === candidate || symbol.startsWith(`${candidate}_`))) return null;
  const tradingClass = text(raw.tradingClass).toUpperCase();
  if (tradingClass && tradingClass !== product.tradingClass) return null;
  const exchange = text(raw.exchange || raw.venue).toUpperCase();
  if (exchange && exchange !== '--' && !['FORECASTX', 'FORECASTEX'].includes(exchange)) return null;
  const explicitMarket = text(raw.market || raw.marketFamily || raw.marketProduct);
  if (explicitMarket && normalizeMarket(explicitMarket) !== product.market) return null;
  const explicitRule = text(raw.contractRule || raw.rule || raw.thresholdDirection || raw.strikeType);
  if (explicitRule && normalizeContractRule(explicitRule, source) !== 'above') return null;
  return { ...identity, contractSide: identity.contractSide || explicitSide || brokerSide };
}

function forecastExComcoIdentity(raw = {}) {
  const identity = forecastExThresholdIdentity(raw);
  return identity?.productCode === 'COMCO' ? identity : null;
}

function repairLegacyFesDateIdentity(record, executions = [], now = new Date().toISOString()) {
  const conId = finite(record?.conId);
  const accountId = text(record?.accountId);
  if (!record || !accountId || !Number.isInteger(conId) || conId <= 0) return null;
  const identity = forecastExThresholdIdentity({
    ...record, expiration: null, lastTradeDateOrContractMonth: null, expiry: null,
  });
  if (identity?.productCode !== 'FES'
    || compactDate(record.expiration) !== identity.eventDate.replaceAll('-', '')) return null;
  const evidence = executions.filter((execution) => (
    text(execution.accountId) === accountId && Number(execution.conId) === conId
    && ['ibkr_live_execution', 'ibkr_flex_import'].includes(execution.source)
    && execution.execId && timestamp(execution.executionTime) != null
    && execution.isMock !== true && execution.isSeeded !== true
  )).map((execution) => ({ execution, identity: forecastExThresholdIdentity(execution) }))
    .filter((candidate) => candidate.identity?.productCode === 'FES'
      && candidate.identity.expirationDate > candidate.identity.eventDate);
  if (!evidence.length || evidence.some((candidate) => (
    candidate.identity.eventContract !== identity.eventContract
    || candidate.identity.contractSide !== identity.contractSide
    || candidate.identity.strike !== identity.strike
  ))) return null;
  const expirationDates = new Set(evidence.map((candidate) => candidate.identity.expirationDate));
  if (expirationDates.size !== 1) return null;
  const expirationDate = [...expirationDates][0];
  return {
    ...record,
    expiration: expirationDate,
    eventDate: identity.eventDate,
    fesDateIdentityRepair: {
      version: 1,
      source: 'ibkr_native_execution_identity',
      previousExpiration: record.expiration,
      previousEventDate: record.eventDate || null,
      eventDate: identity.eventDate,
      expirationDate,
      executionIds: [...new Set(evidence.map((candidate) => candidate.execution.execId))].sort(),
      observedAt: now,
    },
  };
}

function forecastExLastTradingAt(raw = {}) {
  const identity = raw?.productCode ? raw : forecastExThresholdIdentity(raw);
  const cutoff = {
    METLG: '12:30:00',
    FES: '15:00:00',
  }[identity?.productCode];
  const lastTradeDate = identity?.productCode === 'FES' ? identity.eventDate : identity?.resolutionDate;
  if (!cutoff || !lastTradeDate) return null;
  const lastTradingAt = zonedTimeToUtc(
    `${lastTradeDate} ${cutoff}`,
    FORECASTEX_CENTRAL_TIME_ZONE,
  );
  return Number.isFinite(lastTradingAt.getTime()) ? lastTradingAt.toISOString() : null;
}

function cpiIdentity(source = '', explicit = {}) {
  const raw = `${source} ${text(explicit.cpiMeasurement)} ${text(explicit.cpiSeriesId)}`.toUpperCase();
  if (!/KXCPIYOY|(?:^|[^A-Z0-9])CPIY(?:[_-]|$)|HEADLINE\s+CPI\s+YOY|YEAR[- ]OVER[- ]YEAR/.test(raw)) {
    return { cpiMeasurement: null, cpiSeriesId: null, cpiRoundingDecimals: null };
  }
  return {
    cpiMeasurement: 'headline_yoy',
    cpiSeriesId: text(explicit.cpiSeriesId) || 'CUUR0000SA0',
    cpiRoundingDecimals: finite(explicit.cpiRoundingDecimals) ?? 1,
  };
}

function normalizeExecution(raw = {}, accountId = null) {
  const account = text(raw.accountId || raw.account || raw.acctNumber);
  const expectedAccount = text(accountId);
  if (!account || (expectedAccount && account !== expectedAccount)) return null;
  const execId = text(raw.execId || raw.executionId || raw.ibExecutionId);
  const conId = finite(raw.conId || raw.conid);
  const shares = Math.abs(finite(raw.shares ?? raw.quantity ?? raw.qty) || 0);
  const price = finite(raw.price ?? raw.tradePrice);
  if (!execId || !Number.isInteger(conId) || conId <= 0 || shares <= 0 || price == null || price < 0) return null;
  const commissionReport = raw.commissionReport || {};
  const commissionValue = finite(raw.commission ?? raw.fees ?? commissionReport.commission);
  const taxValue = finite(raw.tax ?? raw.taxFee ?? commissionReport.tax);
  const commissionCurrency = text(raw.commissionCurrency || commissionReport.currency).toUpperCase();
  const commission = Math.abs(commissionValue == null || commissionValue < 0 ? 0 : commissionValue);
  const tax = Math.abs(taxValue == null || taxValue < 0 ? 0 : taxValue);
  const identity = contractIdentity(raw);
  const executionTime = iso(raw.executionTime || raw.time || raw.tradeDateTime);
  if (!executionTime) return null;
  return {
    execId,
    accountId: account,
    conId,
    symbol: text(raw.symbol),
    localSymbol: text(raw.localSymbol),
    description: text(raw.description || raw.contractDescription),
    exchange: text(raw.exchange || raw.venue),
    secType: text(raw.secType),
    tradingClass: text(raw.tradingClass),
    market: identity.market,
    eventTicker: identity.eventTicker,
    contractKey: text(raw.contractKey || raw.ticker || raw.localSymbol || raw.symbol || raw.conId),
    contractRule: identity.contractRule,
    expiration: identity.expiration,
    ...(identity.eventDate ? { eventDate: identity.eventDate } : {}),
    strike: identity.strike,
    cpiMeasurement: identity.cpiMeasurement,
    cpiSeriesId: identity.cpiSeriesId,
    cpiRoundingDecimals: identity.cpiRoundingDecimals,
    direction: normalizeDirection(raw.side || raw.action || raw.buySell || raw.direction),
    contractSide: identity.contractSide,
    shares,
    price,
    commission,
    commissionCurrency: commissionCurrency || null,
    tax,
    feesComplete: commissionValue != null
      && commissionValue >= 0
      && (taxValue == null || taxValue >= 0)
      && (!commissionCurrency || commissionCurrency === 'USD'),
    transactionType: text(raw.transactionType || raw.tradeType) || null,
    executionTime,
    source: raw.source || 'ibkr_live_execution',
    rawFingerprint: raw.rawFingerprint || null,
    feeEvidenceSource: raw.feeEvidenceSource || null,
    feeEvidenceFingerprint: raw.feeEvidenceFingerprint || null,
    orderId: finite(raw.orderId),
    permId: finite(raw.permId),
    clientId: finite(raw.clientId),
    orderRef: text(raw.orderRef) || null,
    cumQty: finite(raw.cumQty),
    avgPrice: finite(raw.avgPrice),
    liquidation: finite(raw.liquidation),
    lastLiquidity: finite(raw.lastLiquidity),
  };
}

function isPredictionMarketEvidence(raw = {}) {
  const source = [
    raw.market,
    raw.marketFamily,
    raw.marketProduct,
    raw.exchange,
    raw.symbol,
    raw.localSymbol,
    raw.description,
    raw.contractDescription,
    raw.tradingClass,
    raw.venue,
  ].filter(Boolean).join(' ');
  const normalized = source.toUpperCase();
  return (
    /FORECASTX|KALSHI/.test(normalized)
    || /\bKX[A-Z0-9]+\b/.test(normalized)
    || /\bCPIY?\b/.test(normalized)
    || /\bCOMCO\b/.test(normalized)
    || /(?:^|[-_ ])(?:YES|NO)(?:$|[-_ ])/.test(normalized)
  );
}

function contractIdentity(raw = {}) {
  const source = [
    raw.symbol,
    raw.localSymbol,
    raw.description,
    raw.contractDescription,
    raw.eventTicker,
    raw.ticker,
    raw.contractKey,
  ].filter(Boolean).join(' ');
  const normalizedSide = normalizeContractSide(raw.contractSide || raw.sideLabel, source);
  const normalizedStrike = normalizeStrike(raw.strike ?? raw.threshold ?? raw.floorStrike, source);
  const explicitExpiration = text(raw.expiration || raw.lastTradeDateOrContractMonth || raw.expiry);
  const forecastEx = forecastExThresholdIdentity({
    ...raw,
    contractSide: raw.contractSide || normalizedSide,
    strike: raw.strike ?? raw.threshold ?? raw.floorStrike ?? normalizedStrike,
    expiration: explicitExpiration,
  });
  const market = forecastEx?.market || normalizeMarket(raw.market || raw.marketFamily || raw.marketProduct, source);
  const contractSide = forecastEx?.contractSide || normalizedSide;
  const strike = forecastEx?.strike ?? normalizedStrike;
  const expiration = explicitExpiration || forecastEx?.resolutionDate?.replaceAll('-', '') || '';
  const eventTicker = forecastEx?.eventContract || text(raw.eventTicker || raw.event_ticker) || deriveEventTicker(source) || null;
  const contractKey = text(raw.contractKey || raw.ticker || raw.localSymbol || raw.symbol || raw.conId);
  const contractRule = forecastEx?.contractRule || normalizeContractRule(raw.contractRule || raw.rule || raw.thresholdDirection || raw.strikeType, source) || null;
  const cpi = cpiIdentity(source, raw);
  return {
    market,
    contractSide,
    strike,
    exchange: text(raw.exchange || raw.venue),
    expiration,
    ...(forecastEx?.productCode === 'FES' ? { eventDate: forecastEx.eventDate } : {}),
    eventTicker,
    contractKey,
    contractRule,
    ...cpi,
    source,
  };
}

function formatNumber(value, decimals = 2) {
  const number = finite(value);
  if (number == null) return '—';
  return number.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

function formatMarketStrike(market, strike) {
  if (strike == null) return '—';
  if (market === 'cpi') return `${formatNumber(strike, 1)}%`;
  if (market === 'wti') return `$${formatNumber(strike, 2)}`;
  if (market === 'gold') return `$${formatNumber(strike, 1)}`;
  if (market === 'bitcoin' || market === 'ethereum') return `$${formatNumber(strike, 2)}`;
  if (market === 'sp500' || market === 'nasdaq100') return formatNumber(strike, 0);
  return formatNumber(strike, 2);
}

function buildContractLabel(raw = {}) {
  const identity = contractIdentity(raw);
  const side = identity.contractSide || '—';
  const forecastEx = forecastExThresholdIdentity(raw);
  if (forecastEx?.productCode === 'FES') return `Above ${formatMarketStrike(identity.market, identity.strike)} ${side}`;
  const name = {
    cpi: 'CPI',
    wti: 'WTI',
    gold: 'Gold',
    sp500: 'SP500',
    nasdaq100: 'NQ',
    bitcoin: 'BTC',
    ethereum: 'ETH',
  }[identity.market];
  if (!name) return text(raw.description || raw.localSymbol || raw.symbol || identity.contractKey || 'Prediction contract');
  return `${name} ${formatMarketStrike(identity.market, identity.strike)} ${side}`;
}

function hasSupportedContractIdentity(record = {}) {
  if (!['cpi', 'gold', 'sp500', 'wti'].includes(record.market)
    || !['YES', 'NO'].includes(record.contractSide)
    || record.strike == null) return false;

  // IBKR routes venue-mapped KX contracts and native ForecastEx products
  // through FORECASTX. Native products are supported only when their exact
  // product identity and broker contract fields agree.
  const identitySource = [record.exchange, record.contractKey, record.eventTicker, record.symbol]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
  const forecastEx = forecastExThresholdIdentity(record);
  if (forecastEx
    && forecastEx.market === record.market
    && forecastEx.contractSide === record.contractSide
    && Math.abs(Number(forecastEx.strike) - Number(record.strike)) <= EPSILON
    && normalizeContractRule(record.contractRule, identitySource) === 'above') return true;
  if (/(?:FORECASTX|FORECASTEX)/.test(identitySource)
    && !/KX(?:WTI[A-Z]*|INX[A-Z]*|CPI[A-Z0-9]*|GOLD[A-Z]*)[-_]/.test(identitySource)) return false;
  if (!['above', 'below'].includes(normalizeContractRule(record.contractRule, identitySource))) return false;
  if (record.market === 'cpi' && (
    record.cpiMeasurement !== 'headline_yoy'
    || record.cpiSeriesId !== 'CUUR0000SA0'
    || finite(record.cpiRoundingDecimals) !== 1
  )) return false;
  if (record.market === 'sp500' && !/KXINX/.test(identitySource)) return false;
  if (record.market === 'wti' && !/KXWTI/.test(identitySource)) return false;
  if (record.market === 'gold' && !/KXGOLD[A-Z]*[-_]/.test(identitySource)) return false;
  return true;
}

function lifecycleKey(accountId, conId, sequence) {
  return `${LIFECYCLE_PREFIX}${conId}#${sequence}`;
}

function newLifecycle({ accountId, execution, sequence = 1, now = new Date().toISOString() }) {
  const identity = contractIdentity(execution);
  return {
    accountId,
    recordKey: lifecycleKey(accountId, execution.conId, sequence),
    itemType: 'lifecycle',
    lifecycleId: crypto.randomUUID(),
    version: 1,
    conId: execution.conId,
    symbol: text(execution.symbol) || null,
    localSymbol: text(execution.localSymbol) || null,
    secType: text(execution.secType) || null,
    tradingClass: text(execution.tradingClass) || null,
    market: identity.market,
    contractSide: identity.contractSide,
    strike: identity.strike,
    exchange: identity.exchange || text(execution.exchange) || null,
    expiration: identity.expiration || null,
    ...(identity.eventDate ? { eventDate: identity.eventDate } : {}),
    eventTicker: identity.eventTicker || null,
    contractKey: identity.contractKey || String(execution.conId),
    contractRule: identity.contractRule || null,
    cpiMeasurement: identity.cpiMeasurement || null,
    cpiSeriesId: identity.cpiSeriesId || null,
    cpiRoundingDecimals: identity.cpiRoundingDecimals,
    contractLabel: buildContractLabel(execution),
    openedAt: execution.executionTime || now,
    lastTradeAt: null,
    resolutionAt: null,
    payoutAt: null,
    settlementSymbol: null,
    resolvedDate: null,
    resolutionType: null,
    status: 'open',
    verification: 'ibkr_live_execution',
    reviewReason: null,
    netQuantity: 0,
    entryQuantity: 0,
    exitedQuantity: 0,
    remainingQuantity: 0,
    entryPrincipal: 0,
    fees: 0,
    feesComplete: true,
    paid: 0,
    risked: 0,
    entryCost: 0,
    exitFees: 0,
    netExitProceeds: 0,
    remainingPayout: null,
    holdToExpiryPnl: null,
    savedVsHold: null,
    valuationStatus: 'unvalued',
    pnl: null,
    roi: null,
    executionIds: [],
    lastPositionQuantity: null,
    lastPositionObservedAt: null,
    contractScheduleEvidence: null,
    payoutScheduleEvidence: null,
    settlementEvidence: null,
    correctionVersion: 0,
    updatedAt: now,
    createdAt: now,
  };
}

function ibkrFlexSettlementPayout(execution = {}) {
  if (execution.source !== 'ibkr_flex_import'
    || text(execution.transactionType).toUpperCase() !== 'BOOKTRADE'
    || execution.direction !== 'SELL'
    || execution.feesComplete !== true
    || Math.abs(Number(execution.commission || 0)) > EPSILON
    || Math.abs(Number(execution.tax || 0)) > EPSILON) return null;
  const payout = finite(execution.price);
  return payout === 0 || payout === 1 ? payout : null;
}

function lifecycleFill(lifecycle, execution, now = new Date().toISOString()) {
  const direction = execution.direction;
  if (!direction) {
    lifecycle.status = 'review';
    lifecycle.reviewReason = 'missing_execution_direction';
    return lifecycle;
  }
  const gross = execution.shares * execution.price;
  const fees = execution.commission + execution.tax;
  const incomingIdentity = contractIdentity(execution);
  const identityMismatch = (
    (lifecycle.market && incomingIdentity.market !== 'other' && lifecycle.market !== incomingIdentity.market)
    || (lifecycle.contractSide && incomingIdentity.contractSide && lifecycle.contractSide !== incomingIdentity.contractSide)
    || (lifecycle.strike != null && incomingIdentity.strike != null && Number(lifecycle.strike) !== Number(incomingIdentity.strike))
  );
  lifecycle.feesComplete = lifecycle.feesComplete !== false && execution.feesComplete === true;
  lifecycle.executionIds = [...new Set([...(lifecycle.executionIds || []), execution.execId])];
  lifecycle.fees = Number(lifecycle.fees || 0) + fees;
  lifecycle.risked = Number(lifecycle.entryPrincipal || 0) + lifecycle.fees;
  if (direction === 'BUY') {
    lifecycle.netQuantity = Number(lifecycle.netQuantity || 0) + execution.shares;
    lifecycle.entryQuantity = Number(lifecycle.entryQuantity || 0) + execution.shares;
    lifecycle.entryPrincipal = Number(lifecycle.entryPrincipal || 0) + gross;
    lifecycle.risked = lifecycle.entryPrincipal + lifecycle.fees;
    lifecycle.entryCost = lifecycle.risked;
    lifecycle.status = (!lifecycle.feesComplete || lifecycle.status === 'review' || !hasSupportedContractIdentity(lifecycle)) ? 'review' : 'open';
    if (!lifecycle.feesComplete) lifecycle.reviewReason = 'incomplete_fee_evidence';
    else if (!hasSupportedContractIdentity(lifecycle)) lifecycle.reviewReason = 'unsupported_contract_identity';
  } else {
    const before = Number(lifecycle.netQuantity || 0);
    if (before <= EPSILON || execution.shares > before + EPSILON) {
      lifecycle.paid = Number(lifecycle.paid || 0) + gross;
      lifecycle.status = 'review';
      lifecycle.reviewReason = 'unmatched_or_cross_zero_close';
      return lifecycle;
    }
    lifecycle.netQuantity = Math.max(0, before - execution.shares);
    lifecycle.paid = Number(lifecycle.paid || 0) + gross;
    lifecycle.risked = Number(lifecycle.entryPrincipal || 0) + lifecycle.fees;
    lifecycle.entryCost = lifecycle.risked;
    if (lifecycle.netQuantity <= EPSILON) {
      const brokerSettlementPayout = ibkrFlexSettlementPayout(execution);
      lifecycle.netQuantity = 0;
      lifecycle.resolvedDate = dateOnly(execution.executionTime, dateOnly(now));
      lifecycle.resolutionType = brokerSettlementPayout == null ? 'early_exit' : 'expiry';
      const identityVerified = hasSupportedContractIdentity(lifecycle);
      lifecycle.status = lifecycle.feesComplete && identityVerified ? 'verified' : 'review';
      lifecycle.verification = lifecycle.feesComplete && identityVerified
        ? (brokerSettlementPayout == null ? 'ibkr_live_execution' : 'ibkr_flex_settlement')
        : 'ibkr_live_execution_review';
      lifecycle.reviewReason = lifecycle.feesComplete ? (identityVerified ? null : 'unsupported_contract_identity') : 'incomplete_fee_evidence';
      lifecycle.pnl = lifecycle.paid - lifecycle.risked;
      lifecycle.roi = lifecycle.risked > 0 ? lifecycle.pnl / lifecycle.risked : null;
      lifecycle.performanceComplete = lifecycle.feesComplete === true;
      lifecycle.costBasisComplete = lifecycle.feesComplete === true;
      lifecycle.basisStatus = lifecycle.feesComplete === true ? 'complete' : 'missing';
      lifecycle.settlementEvidence = brokerSettlementPayout == null
        ? {
            source: 'ibkr_live_execution',
            closingTradeAt: execution.executionTime,
            closingTradePrice: Number(lifecycle.entryQuantity || 0) > 0
              ? Number(lifecycle.paid || 0) / Number(lifecycle.entryQuantity)
              : null,
          }
        : {
            source: 'ibkr_flex_book_trade',
            brokerExecutionId: execution.execId,
            payoutPerContract: brokerSettlementPayout,
            outcome: brokerSettlementPayout === 1
              ? lifecycle.contractSide
              : (lifecycle.contractSide === 'YES' ? 'NO' : 'YES'),
            outcomeObservedAt: execution.executionTime,
          };
    }
  }
  if (!lifecycle.feesComplete && lifecycle.status !== 'verified') {
    lifecycle.status = 'review';
    lifecycle.reviewReason = 'incomplete_fee_evidence';
  }
  if (identityMismatch) {
    lifecycle.status = 'review';
    lifecycle.reviewReason = 'contract_identity_mismatch';
  }
  lifecycle.remainingQuantity = Number(lifecycle.netQuantity || 0);
  lifecycle.exitedQuantity = Math.max(0, Number(lifecycle.entryQuantity || 0) - lifecycle.remainingQuantity);
  lifecycle.netExitProceeds = Number(lifecycle.paid || 0);
  lifecycle.updatedAt = now;
  return lifecycle;
}

function createSnapshotLifecycle({ accountId, position, sequence = 1, now = new Date().toISOString() }) {
  const identity = contractIdentity(position);
  const signedQuantity = finite(position.position ?? position.quantity) || 0;
  const quantity = Math.abs(finite(position.quantity ?? position.position) || 0);
  const shortPosition = signedQuantity < -EPSILON || /SHORT|SELL|SLD/i.test(text(position.side));
  const avgCost = finite(position.avgCost ?? position.averageCost);
  const costBasis = finite(position.costBasis);
  const principal = costBasis != null ? Math.abs(costBasis) : (avgCost != null ? quantity * avgCost : null);
  const lifecycle = {
    accountId,
    recordKey: lifecycleKey(accountId, finite(position.conId ?? position.conid), sequence),
    itemType: 'lifecycle',
    lifecycleId: crypto.randomUUID(),
    version: 1,
    conId: finite(position.conId ?? position.conid),
    symbol: text(position.symbol) || null,
    localSymbol: text(position.localSymbol) || null,
    description: text(position.description || position.contractDescription) || null,
    secType: text(position.secType) || null,
    tradingClass: text(position.tradingClass) || null,
    market: identity.market,
    contractSide: identity.contractSide,
    strike: identity.strike,
    exchange: identity.exchange || text(position.exchange) || null,
    expiration: identity.expiration || null,
    ...(identity.eventDate ? { eventDate: identity.eventDate } : {}),
    eventTicker: identity.eventTicker || null,
    contractKey: identity.contractKey || String(position.conId || position.conid),
    contractRule: identity.contractRule || null,
    cpiMeasurement: identity.cpiMeasurement || null,
    cpiSeriesId: identity.cpiSeriesId || null,
    cpiRoundingDecimals: identity.cpiRoundingDecimals,
    contractLabel: buildContractLabel(position),
    openedAt: iso(position.openedAt || position.firstSeenAt, now),
    lastTradeAt: null,
    resolutionAt: null,
    payoutAt: null,
    settlementSymbol: null,
    resolvedDate: null,
    resolutionType: null,
    status: 'open',
    verification: 'ibkr_live_position_snapshot',
    reviewReason: shortPosition ? 'unsupported_short_position' : (principal == null ? 'missing_cost_basis' : 'incomplete_fee_evidence'),
    netQuantity: quantity,
    entryQuantity: quantity,
    exitedQuantity: 0,
    remainingQuantity: quantity,
    entryPrincipal: principal == null ? 0 : principal,
    fees: 0,
    feesComplete: false,
    paid: 0,
    risked: principal == null ? 0 : principal,
    entryCost: principal == null ? 0 : principal,
    exitFees: 0,
    netExitProceeds: 0,
    remainingPayout: null,
    holdToExpiryPnl: null,
    savedVsHold: null,
    valuationStatus: 'unvalued',
    pnl: null,
    roi: null,
    executionIds: [],
    lastPositionQuantity: quantity,
    lastPositionObservedAt: now,
    contractScheduleEvidence: null,
    payoutScheduleEvidence: null,
    settlementEvidence: null,
    correctionVersion: 0,
    updatedAt: now,
    createdAt: now,
  };
  if (lifecycle.reviewReason) lifecycle.status = 'review';
  return lifecycle;
}

function isVerifiedLiveEvidence(payload = {}) {
  const status = text(payload.status || payload.meta?.status).toLowerCase();
  const source = text(payload.source || payload.meta?.source).toLowerCase();
  const fetchedAt = iso(payload.fetchedAt || payload.fetched_at || payload.meta?.fetchedAt);
  const age = fetchedAt ? Date.now() - Date.parse(fetchedAt) : Infinity;
  const historicalImport = status === 'historical_import' && source === 'ibkr_flex_import';
  if (historicalImport) return payload.ok !== false;
  const snapshotId = text(payload.snapshotId || payload.snapshot_id || payload.meta?.snapshotId);
  return (
    payload.ok !== false
    && payload.partial !== true
    && payload.complete === true
    && payload.coverageComplete === true
    && Boolean(snapshotId)
    && ['live', 'ibkr_live', 'ibkr_live_partial'].some((value) => status === value || source === value)
    && !/(cache|stale|mock|seed|fallback|unavailable|offline|partial)/.test(`${status} ${source}`)
    && age >= -5000
    && age <= 120000
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordDigest(record = {}) {
  return crypto.createHash('sha256').update(JSON.stringify(serializeLedgerItem(record))).digest('hex');
}

function createRevisionRecord({ accountId, target, before, after, revisionType, actor = 'system', now = new Date().toISOString() }) {
  const targetKey = text(target?.recordKey || before?.recordKey || after?.recordKey);
  const version = Number(after?.version || after?.correctionVersion || 1);
  const targetHash = crypto.createHash('sha256').update(targetKey).digest('hex').slice(0, 24);
  return {
    accountId,
    recordKey: `${REVISION_PREFIX}${targetHash}#${String(version).padStart(10, '0')}`,
    itemType: 'revision',
    targetRecordKey: targetKey,
    targetItemType: target?.itemType || before?.itemType || after?.itemType || null,
    revisionType,
    actor,
    version,
    beforeDigest: before ? recordDigest(before) : null,
    afterDigest: after ? recordDigest(after) : null,
    before: before ? serializeLedgerItem(before) : null,
    after: after ? serializeLedgerItem(after) : null,
    createdAt: now,
  };
}

function consolidateReconciliationRevisions(revisions, originalByKey, finalRecords, now) {
  const finalByKey = new Map(finalRecords.map((record) => [record.recordKey, record]));
  const byTarget = new Map();
  revisions.forEach((revision) => {
    const key = revision.targetRecordKey;
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(revision);
  });
  return [...byTarget.entries()].map(([key, changes]) => {
    const after = finalByKey.get(key);
    if (!after) throw new Error('A reconciliation revision must reference a final record write.');
    const revisionTypes = [...new Set(changes.map((change) => change.revisionType))];
    const actors = [...new Set(changes.map((change) => change.actor))];
    // A reconciliation writes one new target version, even when several
    // evidence repairs contributed to it. Audit that original-to-final change
    // once; retain each intermediate correction without duplicate write keys.
    const revision = createRevisionRecord({
      accountId: after.accountId, target: after,
      before: originalByKey.get(key) || null, after,
      revisionType: changes.length === 1 ? changes[0].revisionType : 'ledger_reconciliation',
      actor: actors.length === 1 ? actors[0] : 'prediction_market_reconciler', now,
    });
    if (changes.length > 1) {
      revision.revisionTypes = revisionTypes;
      revision.actors = actors;
      revision.changes = changes.map((change) => ({
        revisionType: change.revisionType, actor: change.actor,
        beforeDigest: change.beforeDigest, afterDigest: change.afterDigest,
        before: change.before, after: change.after,
      }));
    }
    return revision;
  });
}

const EXECUTION_COMPARISON_FIELDS = [
  'conId', 'shares', 'price', 'commission', 'tax', 'feesComplete',
  'executionTime', 'direction', 'contractSide', 'strike', 'market',
  'contractRule', 'expiration', 'eventDate', 'symbol', 'localSymbol', 'secType',
  'tradingClass', 'exchange',
  'eventTicker', 'contractKey',
  'orderId', 'permId', 'clientId', 'orderRef', 'cumQty', 'avgPrice',
  'liquidation', 'lastLiquidity',
];

function executionFingerprint(record = {}) {
  return JSON.stringify(EXECUTION_COMPARISON_FIELDS.map((field) => [field, record[field] ?? null]));
}

function executionSourceRank(value) {
  const source = text(value).toLowerCase();
  if (/ibkr_live/.test(source)) return 3;
  if (/ibkr_flex/.test(source)) return 2;
  return 1;
}

const EXECUTION_ECONOMIC_FIELDS = [
  'accountId', 'conId', 'shares', 'price', 'executionTime', 'direction',
  'contractSide', 'strike', 'market', 'contractKey',
];

function executionEconomicFingerprint(record = {}) {
  return JSON.stringify(EXECUTION_ECONOMIC_FIELDS.map((field) => [field, record[field] ?? null]));
}

function hasTrustedFlexFeeEvidence(record = {}) {
  return record.feesComplete === true
    && (/ibkr_flex/.test(text(record.source).toLowerCase())
      || record.feeEvidenceSource === 'ibkr_flex_import');
}

function mergeEquivalentExecutionEvidence(existing = {}, incoming = {}) {
  if (executionEconomicFingerprint(existing) !== executionEconomicFingerprint(incoming)) return null;

  const incomingPreferred = executionSourceRank(incoming.source) >= executionSourceRank(existing.source);
  const preferred = incomingPreferred ? incoming : existing;
  const supplemental = incomingPreferred ? existing : incoming;
  const merged = { ...supplemental, ...preferred };
  [
    'description', 'exchange', 'eventTicker', 'contractRule', 'expiration', 'eventDate',
    'symbol', 'localSymbol', 'secType', 'tradingClass', 'orderId', 'permId',
    'clientId', 'orderRef', 'cumQty', 'avgPrice', 'liquidation', 'lastLiquidity',
    'transactionType',
  ].forEach((field) => {
    if (merged[field] == null || merged[field] === '') merged[field] = supplemental[field] ?? merged[field];
  });

  // A committed, complete Flex activity report is the broker's exact fee
  // ledger. It safely enriches the same live execution ID when the immutable
  // economics above match; it must not be mistaken for a competing trade.
  const flexFeeEvidence = hasTrustedFlexFeeEvidence(incoming)
    ? incoming
    : (hasTrustedFlexFeeEvidence(existing) ? existing : null);
  if (flexFeeEvidence) {
    merged.commission = flexFeeEvidence.commission;
    merged.commissionCurrency = flexFeeEvidence.commissionCurrency || 'USD';
    merged.tax = flexFeeEvidence.tax;
    merged.feesComplete = true;
    merged.feeEvidenceSource = 'ibkr_flex_import';
    merged.feeEvidenceFingerprint = flexFeeEvidence.rawFingerprint || existing.feeEvidenceFingerprint || null;
  }
  return merged;
}

function restoreVerifiedExpiryAfterExecutionReplay(previous = {}, replayed = {}) {
  const payoutPerContract = officialSettlementPayout(previous);
  if (payoutPerContract == null) return replayed;
  const paid = finite(previous.paid);
  const entryCost = finite(replayed.entryCost ?? replayed.risked);
  replayed.status = 'verified';
  replayed.reviewReason = null;
  replayed.verification = previous.verification || 'verified_settlement';
  replayed.resolutionType = 'expiry';
  replayed.resolvedDate = previous.resolvedDate;
  replayed.settlementEvidence = clone(previous.settlementEvidence);
  replayed.netQuantity = 0;
  replayed.remainingQuantity = 0;
  replayed.paid = paid;
  replayed.performanceComplete = replayed.feesComplete === true && entryCost != null && paid != null;
  replayed.costBasisComplete = replayed.performanceComplete;
  replayed.basisStatus = replayed.performanceComplete ? 'complete' : 'missing';
  replayed.valuationStatus = replayed.performanceComplete ? 'official' : 'unavailable';
  replayed.pnl = replayed.performanceComplete ? roundMoney(paid - entryCost) : null;
  replayed.roi = replayed.performanceComplete && entryCost > 0 ? replayed.pnl / entryCost : null;
  return replayed;
}

function rebuildLifecycleFromExecutions(lifecycle, executions = [], now = new Date().toISOString()) {
  const next = clone(lifecycle);
  const ordered = [...executions].sort((left, right) => (
    Date.parse(left.executionTime) - Date.parse(right.executionTime)
    || String(left.execId).localeCompare(String(right.execId))
  ));
  const first = ordered[0];
  if (first) {
    const identity = contractIdentity(first);
    next.symbol = text(first.symbol) || null;
    next.localSymbol = text(first.localSymbol) || null;
    next.secType = text(first.secType) || null;
    next.tradingClass = text(first.tradingClass) || null;
    next.market = identity.market;
    next.contractSide = identity.contractSide;
    next.strike = identity.strike;
    next.exchange = identity.exchange || text(first.exchange) || next.exchange || null;
    next.expiration = identity.expiration || null;
    if (identity.eventDate) next.eventDate = identity.eventDate;
    next.eventTicker = identity.eventTicker || null;
    next.contractKey = identity.contractKey || String(first.conId);
    next.contractRule = identity.contractRule || null;
    next.cpiMeasurement = identity.cpiMeasurement || null;
    next.cpiSeriesId = identity.cpiSeriesId || null;
    next.cpiRoundingDecimals = identity.cpiRoundingDecimals;
    next.contractLabel = buildContractLabel(first);
    next.openedAt = first.executionTime || next.openedAt || now;
  }
  next.resolvedDate = null;
  next.resolutionType = null;
  next.status = 'open';
  next.verification = 'ibkr_live_execution';
  next.reviewReason = null;
  next.netQuantity = 0;
  next.entryQuantity = 0;
  next.exitedQuantity = 0;
  next.remainingQuantity = 0;
  next.entryPrincipal = 0;
  next.fees = 0;
  next.feesComplete = true;
  next.paid = 0;
  next.risked = 0;
  next.entryCost = 0;
  next.exitFees = 0;
  next.netExitProceeds = 0;
  next.remainingPayout = null;
  next.holdToExpiryPnl = null;
  next.savedVsHold = null;
  next.valuationStatus = 'unvalued';
  next.pnl = null;
  next.roi = null;
  next.executionIds = [];
  next.settlementEvidence = null;
  ordered.forEach((execution) => lifecycleFill(next, execution, now));
  restoreVerifiedExpiryAfterExecutionReplay(lifecycle, next);
  next.version = Number(next.version || 0) + 1;
  next.updatedAt = now;
  return next;
}

function rawExecutionView(execution = {}, role = null) {
  return {
    execId: execution.execId,
    role,
    accountId: execution.accountId,
    conId: finite(execution.conId),
    contractKey: execution.contractKey || execution.localSymbol || null,
    contractSide: execution.contractSide || null,
    direction: execution.direction || null,
    quantity: finite(execution.shares),
    price: finite(execution.price),
    commission: finite(execution.commission) || 0,
    tax: finite(execution.tax) || 0,
    executionTime: execution.executionTime || null,
    orderId: finite(execution.orderId),
    permId: finite(execution.permId),
    clientId: finite(execution.clientId),
    orderRef: execution.orderRef || null,
    transactionType: execution.transactionType || null,
  };
}

function forecastExExecutionGroups(executionRecords = []) {
  const groups = new Map();
  const unique = new Map();
  executionRecords.forEach((record) => {
    if (!record?.execId || record.itemType !== 'execution') return;
    const previous = unique.get(record.execId);
    if (!previous || executionSourceRank(record.source) >= executionSourceRank(previous.source)) unique.set(record.execId, record);
  });
  unique.forEach((execution) => {
    const identity = forecastExThresholdIdentity(execution);
    if (!identity || !['YES', 'NO'].includes(identity.contractSide)) return;
    const key = `${text(execution.accountId)}|${identity.eventContract}`;
    if (!groups.has(key)) groups.set(key, { identity, executions: [] });
    groups.get(key).executions.push({ ...execution, ...identity });
  });
  groups.forEach((group) => {
    const collapsed = collapseFlexBookTradeRepresentations(group.executions);
    group.executions = collapsed.executions;
    group.duplicateExecutionIds = collapsed.duplicateExecutionIds;
  });
  return groups;
}

function forecastExExecutionRepresentationKey(execution = {}) {
  return JSON.stringify([
    Number(execution.conId),
    execution.contractSide,
    execution.direction,
    roundMoney(Number(execution.shares || 0)),
    roundMoney(Number(execution.price || 0)),
    dateOnly(execution.executionTime),
  ]);
}

function collapseFlexBookTradeRepresentations(executions = []) {
  const liveConversionCounts = new Map();
  executions.filter((execution) => (
    execution.source !== 'ibkr_flex_import'
    && execution.direction === 'SELL'
    && Math.abs(Number(execution.price) - 0.5) <= EPSILON
  )).forEach((execution) => {
    const key = forecastExExecutionRepresentationKey(execution);
    liveConversionCounts.set(key, Number(liveConversionCounts.get(key) || 0) + 1);
  });
  const duplicateExecutionIds = new Set();
  const canonical = executions.filter((execution) => {
    const flexBookTrade = execution.source === 'ibkr_flex_import'
      && text(execution.transactionType).toUpperCase() === 'BOOKTRADE'
      && execution.direction === 'SELL'
      && Math.abs(Number(execution.price) - 0.5) <= EPSILON;
    if (!flexBookTrade) return true;
    const key = forecastExExecutionRepresentationKey(execution);
    const remaining = Number(liveConversionCounts.get(key) || 0);
    if (remaining <= 0) return true;
    liveConversionCounts.set(key, remaining - 1);
    duplicateExecutionIds.add(execution.execId);
    return false;
  });
  return { executions: canonical, duplicateExecutionIds };
}

function forecastExConversionGroups(executions = []) {
  const byTime = new Map();
  executions.forEach((execution) => {
    if (execution.direction !== 'SELL' || Math.abs(Number(execution.price) - 0.5) > EPSILON) return;
    const key = execution.executionTime;
    if (!key) return;
    if (!byTime.has(key)) byTime.set(key, { executionTime: key, YES: [], NO: [] });
    if (['YES', 'NO'].includes(execution.contractSide)) byTime.get(key)[execution.contractSide].push(execution);
  });
  const paired = [];
  const ambiguous = [];
  [...byTime.values()]
    .sort((left, right) => timestamp(left.executionTime) - timestamp(right.executionTime))
    .forEach((group) => {
      if (!group.YES.length || !group.NO.length) return;
      const yesQuantity = group.YES.reduce((sum, execution) => sum + Number(execution.shares || 0), 0);
      const noQuantity = group.NO.reduce((sum, execution) => sum + Number(execution.shares || 0), 0);
      if (yesQuantity <= EPSILON || Math.abs(yesQuantity - noQuantity) > EPSILON) {
        ambiguous.push({ ...group, yesQuantity, noQuantity, reason: 'conversion_legs_unbalanced' });
        return;
      }
      paired.push({ ...group, quantity: yesQuantity });
    });
  return { paired, ambiguous };
}

function forecastExCashoutCandidate(executions, conversionGroups, heldSide) {
  const offsetSide = heldSide === 'YES' ? 'NO' : 'YES';
  const entryExecutions = executions
    .filter((execution) => execution.contractSide === heldSide && execution.direction === 'BUY')
    .sort((left, right) => timestamp(left.executionTime) - timestamp(right.executionTime) || left.execId.localeCompare(right.execId));
  if (!entryExecutions.length) return { valid: false, reason: 'original_entry_missing' };

  const pairedSellIds = new Set(conversionGroups.flatMap((group) => [
    ...group.YES.map((execution) => execution.execId),
    ...group.NO.map((execution) => execution.execId),
  ]));
  const nonConversionHeldSells = executions.filter((execution) => (
    execution.contractSide === heldSide
    && execution.direction === 'SELL'
    && !pairedSellIds.has(execution.execId)
  ));
  if (nonConversionHeldSells.length) return { valid: false, reason: 'mixed_direct_exit_and_conversion' };

  const offsetBuys = executions
    .filter((execution) => execution.contractSide === offsetSide && execution.direction === 'BUY')
    .sort((left, right) => timestamp(left.executionTime) - timestamp(right.executionTime) || left.execId.localeCompare(right.execId));
  const lastEntryAt = Math.max(...entryExecutions.map((execution) => timestamp(execution.executionTime)));
  const firstOffsetAt = timestamp(offsetBuys[0]?.executionTime);
  if (!Number.isFinite(firstOffsetAt) || firstOffsetAt <= lastEntryAt) {
    return { valid: false, reason: 'original_position_not_established_before_cashout' };
  }
  const usedOffsetIds = new Set();
  const cashOuts = [];
  for (const group of conversionGroups) {
    const conversionAt = timestamp(group.executionTime);
    const eligiblePurchases = offsetBuys.filter((execution) => (
      !usedOffsetIds.has(execution.execId)
      && timestamp(execution.executionTime) <= conversionAt
    ));
    const purchases = [];
    let purchaseQuantity = 0;
    for (const execution of eligiblePurchases) {
      const nextQuantity = purchaseQuantity + Number(execution.shares || 0);
      // IBKR timestamps are second-granular. A later cashout purchase can share
      // the same timestamp as the current conversion, so consume only the
      // earliest whole fills needed for this exact conversion quantity. Never
      // split a broker fill or estimate an allocation.
      if (nextQuantity > group.quantity + EPSILON) break;
      purchases.push(execution);
      purchaseQuantity = nextQuantity;
      if (Math.abs(purchaseQuantity - group.quantity) <= EPSILON) break;
    }
    if (Math.abs(purchaseQuantity - group.quantity) > EPSILON) {
      return {
        valid: false,
        reason: 'opposite_purchase_quantity_mismatch',
        executionTime: group.executionTime,
        expectedQuantity: group.quantity,
        observedQuantity: purchaseQuantity,
      };
    }
    purchases.forEach((execution) => usedOffsetIds.add(execution.execId));
    const pairCredit = roundMoney(group.quantity);
    const oppositePremium = roundMoney(purchases.reduce(
      (sum, execution) => sum + Number(execution.shares || 0) * Number(execution.price || 0),
      0,
    ));
    const exchangeFee = roundMoney(group.quantity * FORECASTEX_EXCHANGE_FEE_PER_CONTRACT);
    const netProceeds = roundMoney(pairCredit - oppositePremium - exchangeFee);
    cashOuts.push({
      id: `cashout#${heldSide.toLowerCase()}#${group.executionTime}`,
      executedAt: group.executionTime,
      quantity: group.quantity,
      pairCredit,
      oppositePremium,
      exchangeFee,
      netProceeds,
      rawLegs: [
        ...purchases.map((execution) => rawExecutionView(execution, 'opposite_purchase')),
        ...group[heldSide].map((execution) => rawExecutionView(execution, 'held_conversion_leg')),
        ...group[offsetSide].map((execution) => rawExecutionView(execution, 'offset_conversion_leg')),
      ],
    });
  }

  const entryQuantity = entryExecutions.reduce((sum, execution) => sum + Number(execution.shares || 0), 0);
  const exitedQuantity = cashOuts.reduce((sum, cashOut) => sum + cashOut.quantity, 0);
  const remainingQuantity = roundMoney(entryQuantity - exitedQuantity);
  if (remainingQuantity < -EPSILON) return { valid: false, reason: 'cashout_exceeds_original_quantity' };
  const entryPrincipal = roundMoney(entryExecutions.reduce(
    (sum, execution) => sum + Number(execution.shares || 0) * Number(execution.price || 0),
    0,
  ));
  const entryFees = roundMoney(entryQuantity * FORECASTEX_EXCHANGE_FEE_PER_CONTRACT);
  const entryCost = roundMoney(entryPrincipal + entryFees);
  const exitFees = roundMoney(cashOuts.reduce((sum, cashOut) => sum + cashOut.exchangeFee, 0));
  const grossExitProceeds = roundMoney(cashOuts.reduce(
    (sum, cashOut) => sum + cashOut.pairCredit - cashOut.oppositePremium,
    0,
  ));
  const netExitProceeds = roundMoney(cashOuts.reduce((sum, cashOut) => sum + cashOut.netProceeds, 0));
  const involvedExecutionIds = new Set([
    ...entryExecutions.map((execution) => execution.execId),
    ...cashOuts.flatMap((cashOut) => cashOut.rawLegs.map((leg) => leg.execId)),
  ]);
  const offsetConIds = new Set(executions
    .filter((execution) => execution.contractSide === offsetSide)
    .map((execution) => finite(execution.conId))
    .filter(Number.isInteger));
  const offsetSideFullyPaired = executions
    .filter((execution) => execution.contractSide === offsetSide)
    .every((execution) => involvedExecutionIds.has(execution.execId));
  const conId = finite(entryExecutions[0]?.conId);
  if (!Number.isInteger(conId) || entryExecutions.some((execution) => Number(execution.conId) !== conId)) {
    return { valid: false, reason: 'original_contract_identity_ambiguous' };
  }
  return {
    valid: true,
    heldSide,
    offsetSide,
    conId,
    entryExecutions,
    entryQuantity,
    exitedQuantity,
    remainingQuantity: Math.max(0, remainingQuantity),
    entryPrincipal,
    entryFees,
    entryCost,
    exitFees,
    grossExitProceeds,
    netExitProceeds,
    cashOuts,
    involvedExecutionIds,
    usedOffsetIds,
    offsetConIds,
    offsetSideFullyPaired,
  };
}

function selectForecastExAnchor(lifecycles, candidate) {
  const executionIds = new Set([
    ...candidate.entryExecutions.map((execution) => execution.execId),
    ...candidate.cashOuts.flatMap((cashOut) => cashOut.rawLegs
      .filter((leg) => leg.role === 'held_conversion_leg')
      .map((leg) => leg.execId)),
  ]);
  return lifecycles
    .filter((record) => Number(record.conId) === Number(candidate.conId)
      && record.status !== PAIRED_OFFSET_COMPONENT_STATUS)
    .map((record) => ({
      record,
      overlap: (record.executionIds || []).filter((execId) => executionIds.has(execId)).length,
      quantity: Number(record.entryQuantity || 0),
    }))
    .sort((left, right) => right.overlap - left.overlap || right.quantity - left.quantity
      || String(left.record.openedAt || '').localeCompare(String(right.record.openedAt || '')))[0]?.record || null;
}

function canonicalReconstructionValue(value) {
  if (Array.isArray(value)) return value.map(canonicalReconstructionValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalReconstructionValue(value[key])]));
  }
  return value;
}

function reconstructionDigest(record = {}) {
  // Compare the representation that is actually persisted: absent/null money
  // fields serialize identically. Database map ordering is not a revision,
  // while array order and actual evidence changes remain significant.
  const copy = serializeLedgerItem(clone(record));
  delete copy.updatedAt;
  delete copy.version;
  delete copy.correctionVersion;
  return JSON.stringify(canonicalReconstructionValue(copy));
}

function officialSettlementPayout(record = {}) {
  if (record.resolutionType !== 'expiry') return null;
  const payout = finite(
    record.settlementEvidence?.payoutPerContract
    ?? record.settlementEvidence?.settlementPayout,
  );
  return payout === 0 || payout === 1 ? payout : null;
}

function reconstructForecastExEconomicRecords({
  lifecycleRecords = [],
  executionRecords = [],
  now = new Date().toISOString(),
  touchUpdatedAt = false,
} = {}) {
  const records = lifecycleRecords.map(clone);
  const beforeByKey = new Map(records.map((record) => [record.recordKey, clone(record)]));
  const changedKeys = new Set();
  const bundles = [];
  const ambiguous = [];
  const groups = forecastExExecutionGroups(executionRecords);

  groups.forEach(({ identity, executions, duplicateExecutionIds }) => {
    const eventLifecycles = records.filter((record) => (
      forecastExThresholdIdentity(record)?.eventContract === identity.eventContract
    ));
    // IBKR emits a zero-price SELL when the venue removes the un-cashed-out
    // remainder at expiry. It is settlement evidence, not an economic exit.
    // Remove an exactly matched posting before conversion/cashout analysis so
    // a legitimate partial cashout cannot be misclassified as mixed trading.
    const settlementPostingIds = new Set(executions
      .filter((execution) => ibkrFlexSettlementPayout(execution) != null || eventLifecycles.some(
        (record) => isExactBrokerSettlementPosting(record, execution),
      ))
      .map((execution) => execution.execId));
    const economicExecutions = executions.filter(
      (execution) => !settlementPostingIds.has(execution.execId),
    );
    const conversions = forecastExConversionGroups(economicExecutions);
    if (!conversions.paired.length) {
      ['YES', 'NO'].forEach((side) => {
        const sideExecutions = economicExecutions.filter((execution) => execution.contractSide === side);
        const entriesForSide = sideExecutions
          .filter((execution) => execution.direction === 'BUY')
          .sort((left, right) => timestamp(left.executionTime) - timestamp(right.executionTime)
            || String(left.execId).localeCompare(String(right.execId)));
        if (!entriesForSide.length
          || sideExecutions.some((execution) => execution.direction !== 'BUY')) return;
        const conIds = new Set(entriesForSide.map((execution) => finite(execution.conId)).filter(Number.isInteger));
        if (conIds.size !== 1) return;
        const candidate = { conId: [...conIds][0], entryExecutions: entriesForSide, cashOuts: [] };
        const anchor = selectForecastExAnchor(eventLifecycles, candidate);
        if (!anchor) return;
        const repairableEntryReview = anchor.status === 'review'
          && (['incomplete_fee_evidence', 'unsupported_contract_identity'].includes(anchor.reviewReason)
            || (anchor.reviewReason == null && anchor.economicBundleStatus === 'entry_only_verified'))
          && entriesForSide.every((execution) => !execution.commissionCurrency || execution.commissionCurrency === 'USD');
        const entryQuantity = roundMoney(entriesForSide.reduce(
          (sum, execution) => sum + Number(execution.shares || 0),
          0,
        ));
        const entryPrincipal = roundMoney(entriesForSide.reduce(
          (sum, execution) => sum + Number(execution.shares || 0) * Number(execution.price || 0),
          0,
        ));
        const entryFees = roundMoney(entryQuantity * FORECASTEX_EXCHANGE_FEE_PER_CONTRACT);
        const entryCost = roundMoney(entryPrincipal + entryFees);
        const officialPayout = officialSettlementPayout(anchor);
        const remainingPayout = officialPayout === 0 || officialPayout === 1
          ? roundMoney(entryQuantity * officialPayout)
          : null;
        const pnl = remainingPayout == null ? null : roundMoney(remainingPayout - entryCost);
        const entries = entriesForSide.map((execution) => {
          const grossCost = roundMoney(Number(execution.shares) * Number(execution.price));
          const exchangeFee = roundMoney(Number(execution.shares) * FORECASTEX_EXCHANGE_FEE_PER_CONTRACT);
          return {
            id: `entry#${execution.execId}`,
            executedAt: execution.executionTime,
            quantity: execution.shares,
            price: execution.price,
            grossCost,
            exchangeFee,
            totalCost: roundMoney(grossCost + exchangeFee),
            rawLegs: [rawExecutionView(execution, 'original_entry')],
          };
        });
        Object.assign(anchor, {
          contractLabel: identity.productCode === 'FES'
            ? `Above ${formatMarketStrike(identity.market, identity.strike)} ${side}`
            : buildContractLabel({ ...anchor, contractSide: side }),
          contractSide: side,
          contractRule: 'above',
          eventTicker: identity.eventContract,
          contractKey: `${identity.eventContract}_${side}`,
          conId: candidate.conId,
          entryQuantity,
          exitedQuantity: 0,
          remainingQuantity: officialPayout == null ? entryQuantity : 0,
          netQuantity: officialPayout == null ? entryQuantity : 0,
          entryPrincipal,
          fees: entryFees,
          entryCost,
          risked: entryCost,
          exitFees: 0,
          grossExitProceeds: 0,
          netExitProceeds: 0,
          paid: remainingPayout == null ? 0 : remainingPayout,
          remainingPayout,
          pnl,
          roi: pnl != null && entryCost > 0 ? pnl / entryCost : null,
          holdToExpiryPnl: pnl,
          savedVsHold: pnl == null ? null : 0,
          performanceComplete: true,
          costBasisComplete: true,
          feesComplete: true,
          basisStatus: 'complete',
          valuationStatus: remainingPayout == null ? 'awaiting_official' : 'official',
          economicRole: 'original_contract',
          economicBundleStatus: 'entry_only_verified',
          ledgerModelVersion: FORECASTEX_LEDGER_MODEL_VERSION,
          executionIds: entriesForSide.map((execution) => execution.execId),
          economicTransactions: { entries, cashOuts: [] },
          feeEvidence: {
            source: 'ibkr_execution_plus_forecastex_fee_schedule',
            feePerContract: FORECASTEX_EXCHANGE_FEE_PER_CONTRACT,
            entryFees,
            exitFees: 0,
          },
        });
        if (officialPayout != null) {
          anchor.status = 'verified';
          anchor.reviewReason = null;
          anchor.verification = anchor.verification || 'verified_settlement';
        } else if (repairableEntryReview && hasSupportedContractIdentity(anchor)) {
          // Exact entry reconstruction repairs the missing fee/identity
          // evidence as well as its accounting values. Do not strand a
          // repaired row in review after clearing its reason. Only an
          // independently verified schedule can advance it past last trade.
          const lastTradeAt = anchor.contractScheduleEvidence?.source === 'forecastex_official_contract_api'
            ? timestamp(anchor.lastTradeAt) : null;
          anchor.status = lastTradeAt != null && timestamp(now) >= lastTradeAt ? 'awaiting_resolution' : 'open';
          anchor.reviewReason = null;
        }
        if (touchUpdatedAt) anchor.updatedAt = now;
        changedKeys.add(anchor.recordKey);
      });
      return;
    }
    const candidates = ['YES', 'NO']
      .map((side) => forecastExCashoutCandidate(economicExecutions, conversions.paired, side))
      .filter((candidate) => candidate.valid);
    if (conversions.ambiguous.length || candidates.length !== 1) {
      const reason = conversions.ambiguous.length
        ? 'conversion_legs_unbalanced'
        : (candidates.length > 1 ? 'original_contract_side_ambiguous' : 'cashout_bundle_ambiguous');
      ambiguous.push({ eventContract: identity.eventContract, reason });
      eventLifecycles.forEach((record) => {
        if (record.status === 'confirmed'
          || record.status === PAIRED_OFFSET_COMPONENT_STATUS
          || record.status === BROKER_SETTLEMENT_POSTING_STATUS) return;
        record.status = 'review';
        record.reviewReason = 'cashout_bundle_ambiguous';
        record.valuationStatus = 'check';
        record.ledgerModelVersion = FORECASTEX_LEDGER_MODEL_VERSION;
        if (touchUpdatedAt) record.updatedAt = now;
        changedKeys.add(record.recordKey);
      });
      return;
    }

    const candidate = candidates[0];
    const anchor = selectForecastExAnchor(eventLifecycles, candidate);
    if (!anchor) {
      ambiguous.push({ eventContract: identity.eventContract, reason: 'original_lifecycle_missing' });
      return;
    }
    const officialPayout = officialSettlementPayout(anchor);
    const fullyExited = candidate.remainingQuantity <= EPSILON;
    const remainingPayout = fullyExited
      ? 0
      : (officialPayout === 0 || officialPayout === 1
      ? roundMoney(candidate.remainingQuantity * officialPayout)
      : null);
    const value = remainingPayout == null ? null : roundMoney(candidate.netExitProceeds + remainingPayout);
    const pnl = value == null ? null : roundMoney(value - candidate.entryCost);
    const holdToExpiryPnl = officialPayout === 0 || officialPayout === 1
      ? roundMoney(candidate.entryQuantity * officialPayout - candidate.entryCost)
      : null;
    const savedVsHold = pnl == null || holdToExpiryPnl == null ? null : roundMoney(pnl - holdToExpiryPnl);
    const entries = candidate.entryExecutions.map((execution) => {
      const grossCost = roundMoney(Number(execution.shares) * Number(execution.price));
      const exchangeFee = roundMoney(Number(execution.shares) * FORECASTEX_EXCHANGE_FEE_PER_CONTRACT);
      return {
        id: `entry#${execution.execId}`,
        executedAt: execution.executionTime,
        quantity: execution.shares,
        price: execution.price,
        grossCost,
        exchangeFee,
        totalCost: roundMoney(grossCost + exchangeFee),
        rawLegs: [rawExecutionView(execution, 'original_entry')],
      };
    });
    Object.assign(anchor, {
      contractLabel: identity.productCode === 'FES'
        ? `Above ${formatMarketStrike(identity.market, identity.strike)} ${candidate.heldSide}`
        : buildContractLabel({ ...anchor, contractSide: candidate.heldSide }),
      contractSide: candidate.heldSide,
      contractRule: 'above',
      eventTicker: identity.eventContract,
      contractKey: `${identity.eventContract}_${candidate.heldSide}`,
      conId: candidate.conId,
      entryQuantity: candidate.entryQuantity,
      exitedQuantity: candidate.exitedQuantity,
      remainingQuantity: candidate.remainingQuantity,
      netQuantity: fullyExited || officialPayout != null ? 0 : candidate.remainingQuantity,
      entryPrincipal: candidate.entryPrincipal,
      fees: candidate.entryFees,
      entryCost: candidate.entryCost,
      risked: candidate.entryCost,
      exitFees: candidate.exitFees,
      grossExitProceeds: candidate.grossExitProceeds,
      netExitProceeds: candidate.netExitProceeds,
      paid: value == null ? candidate.netExitProceeds : value,
      remainingPayout,
      pnl,
      roi: pnl != null && candidate.entryCost > 0 ? pnl / candidate.entryCost : null,
      holdToExpiryPnl,
      savedVsHold,
      performanceComplete: true,
      costBasisComplete: true,
      feesComplete: true,
      basisStatus: 'complete',
      valuationStatus: fullyExited ? 'broker_execution' : (value == null ? 'awaiting_official' : 'official'),
      economicRole: 'original_contract',
      economicBundleStatus: 'verified',
      ledgerModelVersion: FORECASTEX_LEDGER_MODEL_VERSION,
      executionIds: [...candidate.involvedExecutionIds],
      economicTransactions: { entries, cashOuts: candidate.cashOuts },
      feeEvidence: {
        source: 'ibkr_execution_plus_forecastex_fee_schedule',
        feePerContract: FORECASTEX_EXCHANGE_FEE_PER_CONTRACT,
        entryFees: candidate.entryFees,
        exitFees: candidate.exitFees,
      },
    });
    if (fullyExited) {
      const finalCashOut = candidate.cashOuts[candidate.cashOuts.length - 1];
      anchor.status = 'verified';
      anchor.reviewReason = null;
      anchor.verification = 'ibkr_live_execution';
      anchor.resolutionType = 'early_exit';
      anchor.resolvedDate = dateOnly(finalCashOut?.executedAt, dateOnly(now));
      anchor.settlementEvidence = {
        source: 'ibkr_live_execution',
        closingTradeAt: finalCashOut?.executedAt || null,
        economicBundle: 'forecastex_cashout_conversion',
      };
    } else if (officialPayout != null) {
      anchor.status = 'verified';
      anchor.reviewReason = null;
      anchor.verification = anchor.verification || 'verified_settlement';
    }
    if (touchUpdatedAt) anchor.updatedAt = now;
    changedKeys.add(anchor.recordKey);

    const pairedOffsetIds = new Set(candidate.cashOuts.flatMap((cashOut) => cashOut.rawLegs
      .filter((leg) => leg.role !== 'held_conversion_leg')
      .map((leg) => leg.execId)));
    eventLifecycles.forEach((record) => {
      if (record.recordKey === anchor.recordKey || record.status === 'confirmed') return;
      const ids = record.executionIds || [];
      const belongsToOffset = candidate.offsetSideFullyPaired
        && candidate.offsetConIds.has(Number(record.conId))
        && (ids.length === 0 || ids.every((execId) => pairedOffsetIds.has(execId)));
      if (!belongsToOffset) return;
      record.status = PAIRED_OFFSET_COMPONENT_STATUS;
      record.reviewReason = null;
      record.economicRole = 'paired_offset_component';
      record.pairedToLifecycleRecordKey = anchor.recordKey;
      record.ledgerModelVersion = FORECASTEX_LEDGER_MODEL_VERSION;
      record.valuationStatus = 'hidden_component';
      if (touchUpdatedAt) record.updatedAt = now;
      changedKeys.add(record.recordKey);
    });
    eventLifecycles.forEach((record) => {
      if (record.recordKey === anchor.recordKey || record.status === 'confirmed') return;
      const ids = record.executionIds || [];
      if (!ids.length || !ids.every((execId) => duplicateExecutionIds.has(execId))) return;
      record.status = BROKER_EXECUTION_REPRESENTATION_STATUS;
      record.reviewReason = null;
      record.economicRole = 'duplicate_broker_representation';
      record.pairedToLifecycleRecordKey = anchor.recordKey;
      record.ledgerModelVersion = FORECASTEX_LEDGER_MODEL_VERSION;
      record.valuationStatus = 'hidden_component';
      if (touchUpdatedAt) record.updatedAt = now;
      changedKeys.add(record.recordKey);
    });
    bundles.push({
      eventContract: identity.eventContract,
      lifecycleRecordKey: anchor.recordKey,
      heldSide: candidate.heldSide,
      entryQuantity: candidate.entryQuantity,
      exitedQuantity: candidate.exitedQuantity,
      remainingQuantity: candidate.remainingQuantity,
      entryCost: candidate.entryCost,
      netExitProceeds: candidate.netExitProceeds,
      cashOutCount: candidate.cashOuts.length,
    });
  });

  // Dynamic reads run the same replay as persistence. Report a record as changed
  // only when the economic projection differs, making repeated replays idempotent.
  const changedRecords = records.filter((record) => (
    changedKeys.has(record.recordKey)
    && reconstructionDigest(record) !== reconstructionDigest(beforeByKey.get(record.recordKey))
  ));
  return { records, changedRecords, bundles, ambiguous };
}

function isExactBrokerSettlementPosting(settledLifecycle = {}, execution = {}) {
  const settlementPayout = finite(
    settledLifecycle.settlementEvidence?.payoutPerContract
    ?? settledLifecycle.settlementEvidence?.settlementPayout,
  );
  const incomingIdentity = contractIdentity(execution);
  const settledAt = timestamp(
    settledLifecycle.resolutionAt
    || settledLifecycle.settlementEvidence?.outcomeObservedAt
    || settledLifecycle.settlementEvidence?.observedAt
    || settledLifecycle.resolvedDate,
  );
  const executionAt = timestamp(execution.executionTime);
  const remainingQuantity = finite(settledLifecycle.remainingQuantity);
  const netQuantity = finite(settledLifecycle.netQuantity);
  const recordedPosting = settledLifecycle.brokerSettlementEvidence;
  const exactRecordedPosting = recordedPosting?.source === 'ibkr_expiry_close_execution'
    && recordedPosting.execId === execution.execId
    && timestamp(recordedPosting.executionTime) === executionAt
    && finite(recordedPosting.quantity) === finite(execution.shares)
    && finite(recordedPosting.price) === 0;
  // Finalized accounting sets remaining quantity to zero. An already verified
  // exact broker removal remains the same posting after a date-only repair.
  const expectedQuantity = exactRecordedPosting ? finite(recordedPosting.quantity) : remainingQuantity != null
    ? remainingQuantity
    : (netQuantity != null && netQuantity > EPSILON
      ? netQuantity
      : finite(settledLifecycle.entryQuantity));
  return (settledLifecycle.status === 'verified'
      || (settledLifecycle.status === 'review'
        && settledLifecycle.reviewReason === 'cashout_bundle_ambiguous'))
    && settledLifecycle.resolutionType === 'expiry'
    && (settlementPayout === 0 || settlementPayout === 1)
    && Number(settledLifecycle.conId) === Number(execution.conId)
    && Number(expectedQuantity || 0) > EPSILON
    && execution.direction === 'SELL'
    && execution.feesComplete === true
    && Math.abs(Number(execution.price || 0)) <= EPSILON
    && Math.abs(Number(execution.commission || 0)) <= EPSILON
    && Math.abs(Number(execution.tax || 0)) <= EPSILON
    && Math.abs(Number(execution.shares || 0) - Number(expectedQuantity || 0)) <= EPSILON
    && Number.isFinite(settledAt)
    && Number.isFinite(executionAt)
    && executionAt >= settledAt
    && incomingIdentity.market === settledLifecycle.market
    && incomingIdentity.contractSide === settledLifecycle.contractSide
    && Math.abs(Number(incomingIdentity.strike) - Number(settledLifecycle.strike)) <= EPSILON
    && (!settledLifecycle.expiration || !incomingIdentity.expiration || settledLifecycle.expiration === incomingIdentity.expiration)
    && (!settledLifecycle.contractKey || !incomingIdentity.contractKey || settledLifecycle.contractKey === incomingIdentity.contractKey);
}

function attachBrokerSettlementPosting(settledLifecycle, execution, observedAt) {
  if (settledLifecycle.brokerSettlementEvidence?.execId === execution.execId) return false;
  settledLifecycle.brokerSettlementEvidence = {
    source: 'ibkr_expiry_close_execution',
    execId: execution.execId,
    executionTime: execution.executionTime,
    quantity: execution.shares,
    price: execution.price,
    observedAt,
  };
  settledLifecycle.updatedAt = observedAt;
  return true;
}

function repairExactExecutionCostBasis(lifecycle, executionById, observedAt) {
  // Position average cost is a useful last-resort control for native
  // ForecastEx contracts, whose exchange fee is folded into IBKR's average.
  // It is not transaction-level fee evidence for venue-mapped Kalshi
  // contracts. If a Kalshi lifecycle was previously inflated from average
  // cost, restore the exact, complete execution tape as the authoritative
  // basis.
  if (lifecycle.feeEvidence?.source !== 'ibkr_live_position_average_cost'
    || forecastExThresholdIdentity(lifecycle)) return false;
  const executionIds = [...new Set(lifecycle.executionIds || [])];
  if (!executionIds.length) return false;
  const tape = executionIds.map((execId) => executionById.get(execId));
  if (tape.some((execution) => !execution)) return false;
  const entries = tape.filter((execution) => execution.direction === 'BUY');
  if (!entries.length
    || entries.some((execution) => execution.feesComplete !== true)
    || entries.some((execution) => Number(execution.conId) !== Number(lifecycle.conId))) return false;
  const entryQuantity = roundMoney(entries.reduce(
    (sum, execution) => sum + Number(execution.shares || 0),
    0,
  ));
  if (Math.abs(entryQuantity - Number(lifecycle.entryQuantity || 0)) > EPSILON) return false;
  const entryPrincipal = roundMoney(entries.reduce(
    (sum, execution) => sum + Number(execution.shares || 0) * Number(execution.price || 0),
    0,
  ));
  const fees = roundMoney(entries.reduce(
    (sum, execution) => sum + Number(execution.commission || 0) + Number(execution.tax || 0),
    0,
  ));
  const entryCost = roundMoney(entryPrincipal + fees);
  const alreadyExact = lifecycle.entryPrincipal === entryPrincipal
    && lifecycle.fees === fees
    && lifecycle.entryCost === entryCost
    && lifecycle.risked === entryCost
    && lifecycle.feeEvidence?.source === 'ibkr_exact_execution_coverage';
  if (alreadyExact) return false;
  lifecycle.entryPrincipal = entryPrincipal;
  lifecycle.fees = fees;
  lifecycle.entryCost = entryCost;
  lifecycle.risked = entryCost;
  lifecycle.feesComplete = true;
  lifecycle.costBasisComplete = true;
  lifecycle.performanceComplete = true;
  lifecycle.basisStatus = 'complete';
  lifecycle.feeEvidence = {
    source: 'ibkr_exact_execution_coverage',
    entryExecutionIds: entries.map((execution) => execution.execId),
    entryQuantity,
    entryPrincipal,
    fees,
    entryCost,
    observedAt,
  };
  if (DISPLAY_STATUSES.has(lifecycle.status)) {
    lifecycle.pnl = roundMoney(Number(lifecycle.paid || 0) - entryCost);
    lifecycle.roi = entryCost > 0 ? lifecycle.pnl / entryCost : null;
    lifecycle.valuationStatus = 'official';
  }
  lifecycle.updatedAt = observedAt;
  return true;
}

function reconcileEvidence({
  accountId,
  positions = [],
  executions = [],
  positionsPayload = {},
  executionsPayload = {},
  existingRecords = [],
  now = new Date().toISOString(),
  allowClosureInference = true,
  closureBlockedReason = null,
}) {
  if (!isVerifiedLiveEvidence(positionsPayload) || !isVerifiedLiveEvidence(executionsPayload)) {
    return {
      status: 'capture_paused',
      reason: 'verified_live_evidence_unavailable',
      records: existingRecords,
      changed: [],
    };
  }
  const positionSnapshotId = text(positionsPayload.snapshotId || positionsPayload.snapshot_id);
  const executionSnapshotId = text(executionsPayload.snapshotId || executionsPayload.snapshot_id);
  if (positionSnapshotId !== executionSnapshotId) {
    return {
      status: 'capture_paused',
      reason: 'snapshot_scope_mismatch',
      records: existingRecords,
      changed: [],
    };
  }
  const positionSnapshotStartedAt = timestamp(
    positionsPayload.snapshotStartedAt
    || positionsPayload.snapshot_started_at
    || positionsPayload.meta?.snapshotStartedAt,
  );
  const temporalOverlap = Number.isFinite(positionSnapshotStartedAt) && executions
    .filter(isPredictionMarketEvidence)
    .some((execution) => {
      const executionAt = timestamp(execution.executionTime || execution.time || execution.tradeDateTime);
      return Number.isFinite(executionAt) && executionAt >= positionSnapshotStartedAt;
    });
  if (temporalOverlap) {
    return {
      status: 'capture_paused',
      reason: 'snapshot_temporal_overlap',
      records: existingRecords,
      changed: [],
    };
  }
  const payloadAccounts = [positionsPayload.account, executionsPayload.account]
    .map((value) => text(value))
    .filter(Boolean);
  const positionAccountMismatch = positions.some((position) => {
    const positionAccount = text(position.account || position.accountId || position.acctNumber);
    return positionAccount && positionAccount !== text(accountId);
  });
  const executionAccountMismatch = executions
    .filter(isPredictionMarketEvidence)
    .some((execution) => text(execution.accountId || execution.account || execution.acctNumber) !== text(accountId));
  if (payloadAccounts.some((value) => value !== text(accountId)) || positionAccountMismatch || executionAccountMismatch) {
    return {
      status: 'capture_paused',
      reason: 'account_scope_mismatch',
      records: existingRecords,
      changed: [],
    };
  }
  const records = existingRecords.filter((record) => record && record.itemType === 'lifecycle').map(clone);
  const existingExecutionRecords = existingRecords.filter((record) => record?.itemType === 'execution').map(clone);
  const originalByKey = new Map(existingRecords.map((record) => [record.recordKey, clone(record)]));
  const executionById = new Map(existingExecutionRecords.map((record) => [record.execId, record]));
  const correctedExecutionIds = new Set();
  const dateOnlyExecutionIds = new Set();
  const conflictingExecutionIds = new Set();
  const revisionRecords = [];
  const byConId = new Map();
  const settledExpiryByConId = new Map();
  records.forEach((record) => {
    if ((ACTIVE_STATUSES.has(record.status) || (record.status === 'review' && Number(record.netQuantity || 0) > EPSILON)) && record.conId != null) {
      const existing = byConId.get(Number(record.conId));
      if (!existing || String(record.updatedAt || '') > String(existing.updatedAt || '')) byConId.set(Number(record.conId), record);
    }
    if ((DISPLAY_STATUSES.has(record.status)
      || (record.status === 'review' && officialSettlementPayout(record) != null))
      && record.resolutionType === 'expiry' && record.conId != null) {
      const existing = settledExpiryByConId.get(Number(record.conId));
      if (!existing || String(record.updatedAt || '') > String(existing.updatedAt || '')) {
        settledExpiryByConId.set(Number(record.conId), record);
      }
    }
  });
  const changed = [];
  const predictionExecutions = executions.filter(isPredictionMarketEvidence);
  const normalizedExecutions = predictionExecutions
    .map((raw) => normalizeExecution(raw, accountId))
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.executionTime) - Date.parse(right.executionTime) || left.execId.localeCompare(right.execId));
  if (normalizedExecutions.length !== predictionExecutions.length) {
    return {
      status: 'capture_paused',
      reason: 'invalid_execution_evidence',
      records: existingRecords,
      changed: [],
    };
  }
  const executionRecords = [];
  const newExecutions = [];
  const flexBasisConsumedExecutionIds = new Set();
  const flexBasisBackfilledKeys = new Set();
  const flexSupersededSnapshotKeys = new Set();
  const exactExecutionBasisRepairedKeys = new Set();
  const legacyFesDateRepairedKeys = new Set();
  for (const execution of normalizedExecutions) {
    const existingExecution = executionById.get(execution.execId);
    if (!existingExecution) {
      const executionRecord = {
        accountId,
        recordKey: `${EXECUTION_PREFIX}${execution.execId}`,
        itemType: 'execution',
        ...execution,
        version: 1,
        correctionVersion: 0,
        createdAt: now,
        updatedAt: now,
      };
      executionRecords.push(executionRecord);
      executionById.set(execution.execId, executionRecord);
      newExecutions.push(execution);
    } else {
      // Flex's BookTrade classification distinguishes an official 0/1 expiry
      // posting from a trade. Keep that marker in this reconciliation's
      // authoritative replay even when every persisted economic field is
      // already identical; it does not justify rewriting the whole tape.
      if (!existingExecution.transactionType && execution.transactionType) {
        executionById.set(execution.execId, { ...existingExecution, transactionType: execution.transactionType });
      }
      if (executionFingerprint(existingExecution) === executionFingerprint(execution)) continue;
      const equivalentEvidence = mergeEquivalentExecutionEvidence(existingExecution, execution);
      if (equivalentEvidence
        && executionFingerprint(existingExecution) === executionFingerprint(equivalentEvidence)) continue;
      if (!equivalentEvidence
        && executionSourceRank(execution.source) < executionSourceRank(existingExecution.source)) {
        conflictingExecutionIds.add(execution.execId);
        continue;
      }
      const executionRecord = {
        ...existingExecution,
        ...(equivalentEvidence || execution),
        recordKey: existingExecution.recordKey || `${EXECUTION_PREFIX}${execution.execId}`,
        itemType: 'execution',
        version: Number(existingExecution.version || 1) + 1,
        correctionVersion: Number(existingExecution.correctionVersion || 0) + 1,
        previousUpdatedAt: existingExecution.updatedAt || null,
        updatedAt: now,
      };
      executionRecords.push(executionRecord);
      executionById.set(execution.execId, executionRecord);
      correctedExecutionIds.add(execution.execId);
      revisionRecords.push(createRevisionRecord({
        accountId,
        target: executionRecord,
        before: existingExecution,
        after: executionRecord,
        revisionType: equivalentEvidence ? 'ibkr_execution_enrichment' : 'ibkr_execution_correction',
        actor: equivalentEvidence?.feeEvidenceSource || execution.source || 'ibkr_live_execution',
        now,
      }));
    }
  }
  // Older normalization copied the FES event date into expiration. Correct
  // that known legacy value only from unanimous exact native broker identity;
  // the original financial evidence and trade timestamps are not changed.
  const nativeDateEvidence = [...normalizedExecutions, ...executionById.values()];
  for (const [execId, previous] of executionById) {
    const repaired = repairLegacyFesDateIdentity(previous, nativeDateEvidence, now);
    if (!repaired) continue;
    const original = originalByKey.get(previous.recordKey);
    repaired.version = original ? Number(original.version || 0) + 1 : 1;
    repaired.correctionVersion = Number(original?.correctionVersion || 0) + 1;
    repaired.updatedAt = now;
    executionById.set(execId, repaired);
    const writtenIndex = executionRecords.findIndex((record) => record.execId === execId);
    if (writtenIndex < 0) executionRecords.push(repaired);
    else executionRecords[writtenIndex] = repaired;
    const dateOnlyCorrection = original
      && [...EXECUTION_ECONOMIC_FIELDS, 'commission', 'tax', 'feesComplete']
        .every((field) => (original[field] ?? null) === (repaired[field] ?? null));
    if (dateOnlyCorrection) dateOnlyExecutionIds.add(execId);
    correctedExecutionIds.add(execId);
    revisionRecords.push(createRevisionRecord({
      accountId, target: repaired, before: original || previous, after: repaired,
      revisionType: 'fes_date_identity_repair_v1', actor: 'ibkr_native_execution_identity', now,
    }));
  }
  records.forEach((lifecycle) => {
    const repaired = repairLegacyFesDateIdentity(lifecycle, nativeDateEvidence, now);
    if (!repaired) return;
    Object.assign(lifecycle, repaired);
    lifecycle.updatedAt = now;
    changed.push(lifecycle);
    legacyFesDateRepairedKeys.add(lifecycle.recordKey);
  });
  records.forEach((lifecycle) => {
    if (!repairExactExecutionCostBasis(lifecycle, executionById, now)) return;
    changed.push(lifecycle);
    exactExecutionBasisRepairedKeys.add(lifecycle.recordKey);
  });
  for (const lifecycle of records.filter((record) => record.historicalImportId && record.conId != null)) {
    const flexExecutions = [...executionById.values()]
      .filter((execution) => Number(execution.conId) === Number(lifecycle.conId)
        && execution.source === 'ibkr_flex_import')
      .sort((left, right) => timestamp(left.executionTime) - timestamp(right.executionTime) || left.execId.localeCompare(right.execId));
    if (!flexExecutions.length) continue;
    const buys = flexExecutions.filter((execution) => execution.direction === 'BUY');
    const sells = flexExecutions.filter((execution) => execution.direction === 'SELL');
    const quantity = buys.reduce((sum, execution) => sum + Number(execution.shares || 0), 0);
    const expectedQuantity = Number(lifecycle.entryQuantity || lifecycle.positionSnapshotEvidence?.quantity || 0);
    const exactCoverage = sells.length === 0
      && Math.abs(quantity - expectedQuantity) <= EPSILON
      && buys.length > 0
      && buys.every((execution) => execution.feesComplete === true);
    // A snapshot can only absorb a pure, exact opening tape. If the tape has
    // exits/cashouts, leave every execution available to reconstruct an
    // authoritative replacement lifecycle instead of silently consuming it.
    if (exactCoverage) flexExecutions.forEach((execution) => flexBasisConsumedExecutionIds.add(execution.execId));
    for (const execution of flexExecutions) {
      const existingRecord = executionById.get(execution.execId);
      if (!existingRecord) continue;
      const field = exactCoverage ? 'lifecycleRecordKey' : 'basisCandidateLifecycleRecordKey';
      if (existingRecord[field] === lifecycle.recordKey) continue;
      existingRecord[field] = lifecycle.recordKey;
      const originalExecution = originalByKey.get(existingRecord.recordKey);
      if (originalExecution) {
        existingRecord.version = Number(originalExecution.version || 1) + 1;
        existingRecord.correctionVersion = Number(originalExecution.correctionVersion || 0) + 1;
        existingRecord.updatedAt = now;
        if (!executionRecords.some((record) => record.recordKey === existingRecord.recordKey)) executionRecords.push(existingRecord);
      }
    }
    if (!exactCoverage) {
      if (lifecycle.costBasisComplete !== true) lifecycle.basisStatus = 'missing';
      continue;
    }
    const entryPrincipal = roundMoney(buys.reduce(
      (sum, execution) => sum + Number(execution.shares || 0) * Number(execution.price || 0),
      0,
    ));
    const fees = roundMoney(buys.reduce(
      (sum, execution) => sum + Number(execution.commission || 0) + Number(execution.tax || 0),
      0,
    ));
    const entryCost = roundMoney(entryPrincipal + fees);
    const beforeBasis = reconstructionDigest(lifecycle);
    lifecycle.entryPrincipal = entryPrincipal;
    lifecycle.fees = fees;
    lifecycle.entryCost = entryCost;
    lifecycle.risked = entryCost;
    lifecycle.feesComplete = true;
    lifecycle.costBasisComplete = true;
    lifecycle.performanceComplete = true;
    lifecycle.basisStatus = 'complete';
    lifecycle.basisBreakdownAvailable = true;
    lifecycle.executionIds = [...new Set([...(lifecycle.executionIds || []), ...buys.map((execution) => execution.execId)])];
    lifecycle.costBasisSource = 'ibkr_flex_exact_execution_coverage';
    lifecycle.costBasisEvidence = {
      source: 'ibkr_flex_import',
      quantity: expectedQuantity,
      entryPrincipal,
      fees,
      entryCost,
      executionIds: buys.map((execution) => execution.execId),
      observedAt: now,
    };
    if (DISPLAY_STATUSES.has(lifecycle.status)) {
      lifecycle.pnl = roundMoney(Number(lifecycle.paid || 0) - entryCost);
      lifecycle.roi = entryCost > 0 ? lifecycle.pnl / entryCost : null;
      lifecycle.valuationStatus = 'official';
    }
    lifecycle.updatedAt = now;
    if (beforeBasis !== reconstructionDigest(lifecycle)) {
      changed.push(lifecycle);
      flexBasisBackfilledKeys.add(lifecycle.recordKey);
    }
  }
  for (const execution of newExecutions) {
    if (flexBasisConsumedExecutionIds.has(execution.execId)) continue;
    const settledLifecycle = settledExpiryByConId.get(execution.conId);
    if (settledLifecycle && isExactBrokerSettlementPosting(settledLifecycle, execution)) {
      const executionRecord = executionById.get(execution.execId);
      if (executionRecord) executionRecord.lifecycleRecordKey = settledLifecycle.recordKey;
      if (attachBrokerSettlementPosting(settledLifecycle, execution, now)) changed.push(settledLifecycle);
      continue;
    }
    let lifecycle = byConId.get(execution.conId);
    let orphanClose = false;
    if (!lifecycle
      || lifecycle.status === 'verified'
      || lifecycle.status === 'confirmed'
      || (lifecycle.historicalImportId && execution.source === 'ibkr_flex_import')
      || (lifecycle.status === 'awaiting_resolution' && execution.direction === 'BUY')) {
      if (execution.direction === 'SELL') {
        const sequence = records.filter((record) => Number(record.conId) === execution.conId).length + 1;
        lifecycle = newLifecycle({ accountId, execution, sequence, now });
        lifecycle.status = 'review';
        lifecycle.reviewReason = 'unmatched_or_cross_zero_close';
        lifecycle.entryPrincipal = 0;
        lifecycle.netQuantity = 0;
        lifecycle.version = Number(lifecycle.version || 0) + 1;
        records.push(lifecycle);
        byConId.set(execution.conId, lifecycle);
        orphanClose = true;
      } else {
        const sequence = records.filter((record) => Number(record.conId) === execution.conId).length + 1;
        lifecycle = newLifecycle({ accountId, execution, sequence, now });
        records.push(lifecycle);
        byConId.set(execution.conId, lifecycle);
      }
    }
    if (lifecycle) {
      const executionRecord = executionById.get(execution.execId);
      if (executionRecord) executionRecord.lifecycleRecordKey = lifecycle.recordKey;
      if (orphanClose) {
        lifecycle.executionIds = [...new Set([...(lifecycle.executionIds || []), execution.execId])];
        lifecycle.fees = execution.commission + execution.tax;
        lifecycle.feesComplete = execution.feesComplete === true;
        lifecycle.paid = execution.shares * execution.price;
        lifecycle.risked = lifecycle.fees;
        lifecycle.updatedAt = now;
      } else {
        lifecycleFill(lifecycle, execution, now);
      }
      lifecycle.contractLabel = buildContractLabel({ ...execution, contractSide: lifecycle.contractSide || execution.contractSide, strike: lifecycle.strike || execution.strike });
      lifecycle.market = lifecycle.market === 'other' ? normalizeMarket(execution.market, execution.description) : lifecycle.market;
      lifecycle.version = Number(lifecycle.version || 0) + 1;
      changed.push(lifecycle);
    }
  }

  // Older reconciler versions represented IBKR's zero-price expiry-removal
  // execution as a second, empty lifecycle requiring review. Preserve that
  // broker evidence, but link it to the already verified venue settlement and
  // retire the synthetic lifecycle automatically.
  for (const orphan of records) {
    if (orphan.status !== 'review'
      || !['unmatched_or_cross_zero_close', 'cashout_bundle_ambiguous'].includes(orphan.reviewReason)
      || Math.abs(Number(orphan.entryQuantity || 0)) > EPSILON
      || Math.abs(Number(orphan.netQuantity || 0)) > EPSILON
      || Math.abs(Number(orphan.entryPrincipal || 0)) > EPSILON
      || Math.abs(Number(orphan.fees || 0)) > EPSILON
      || Math.abs(Number(orphan.paid || 0)) > EPSILON
      || (orphan.executionIds || []).length !== 1) continue;
    const execution = executionById.get(orphan.executionIds[0]);
    const settledLifecycle = settledExpiryByConId.get(Number(orphan.conId));
    if (!execution || !settledLifecycle || !isExactBrokerSettlementPosting(settledLifecycle, execution)) continue;

    const orphanBefore = clone(orphan);
    orphan.status = BROKER_SETTLEMENT_POSTING_STATUS;
    orphan.reviewReason = null;
    orphan.verification = 'ibkr_expiry_close_linked';
    orphan.resolutionType = 'broker_settlement_posting';
    orphan.resolvedDate = dateOnly(execution.executionTime);
    orphan.linkedLifecycleRecordKey = settledLifecycle.recordKey;
    // Revision keys are target-version scoped. Assign the corrected version
    // before creating the immutable revision so it cannot collide with the
    // legacy version-1 economic-replay revision that originally created this
    // false review.
    orphan.version = Number(orphanBefore.version || 0) + 1;
    orphan.updatedAt = now;
    changed.push(orphan);
    revisionRecords.push(createRevisionRecord({
      accountId,
      target: orphan,
      before: orphanBefore,
      after: orphan,
      revisionType: 'broker_settlement_posting_linked',
      actor: 'ibkr_live_execution',
      now,
    }));

    if (execution.lifecycleRecordKey !== settledLifecycle.recordKey) {
      const originalExecution = originalByKey.get(execution.recordKey) || execution;
      const linkedExecution = {
        ...execution,
        lifecycleRecordKey: settledLifecycle.recordKey,
        version: Number(originalExecution.version || 1) + 1,
        correctionVersion: Number(originalExecution.correctionVersion || 0) + 1,
        previousUpdatedAt: originalExecution.updatedAt || null,
        updatedAt: now,
      };
      const existingIndex = executionRecords.findIndex((record) => record.recordKey === linkedExecution.recordKey);
      if (existingIndex >= 0) executionRecords[existingIndex] = linkedExecution;
      else executionRecords.push(linkedExecution);
      executionById.set(linkedExecution.execId, linkedExecution);
      revisionRecords.push(createRevisionRecord({
        accountId,
        target: linkedExecution,
        before: originalExecution,
        after: linkedExecution,
        revisionType: 'broker_settlement_execution_linked',
        actor: 'ibkr_live_execution',
        now,
      }));
    }
    if (attachBrokerSettlementPosting(settledLifecycle, execution, now)) changed.push(settledLifecycle);
  }
  if (correctedExecutionIds.size) {
    for (const lifecycle of records) {
      const lifecycleExecutionIds = new Set(lifecycle.executionIds || []);
      const affected = [...correctedExecutionIds].some((execId) => lifecycleExecutionIds.has(execId));
      if (!affected || lifecycle.status === 'confirmed') continue;
      if ([BROKER_SETTLEMENT_POSTING_STATUS, PAIRED_OFFSET_COMPONENT_STATUS].includes(lifecycle.status)
        && [...correctedExecutionIds].filter((execId) => lifecycleExecutionIds.has(execId))
          .every((execId) => dateOnlyExecutionIds.has(execId))) continue;
      const replay = [...lifecycleExecutionIds]
        .map((execId) => executionById.get(execId))
        .filter(Boolean)
        .map((record) => normalizeExecution({
          ...record,
          commission: record.feesComplete === false ? undefined : record.commission,
          tax: record.feesComplete === false ? undefined : record.tax,
        }, accountId))
        .filter(Boolean);
      const rebuilt = rebuildLifecycleFromExecutions(lifecycle, replay, now);
      Object.assign(lifecycle, rebuilt);
      byConId.set(Number(lifecycle.conId), lifecycle);
      changed.push(lifecycle);
    }
  }
  if (conflictingExecutionIds.size) {
    for (const lifecycle of records) {
      if (lifecycle.status === 'confirmed') continue;
      if (!(lifecycle.executionIds || []).some((execId) => conflictingExecutionIds.has(execId))) continue;
      if (lifecycle.status === 'review' && lifecycle.reviewReason === 'execution_evidence_conflict') continue;
      lifecycle.status = 'review';
      lifecycle.reviewReason = 'execution_evidence_conflict';
      lifecycle.updatedAt = now;
      changed.push(lifecycle);
    }
  }
  const predictionPositions = positions.filter(isPredictionMarketEvidence);
  const invalidPredictionPosition = predictionPositions.some((position) => {
    const conId = finite(position.conId ?? position.conid);
    const quantity = finite(position.position ?? position.quantity);
    return !Number.isInteger(conId) || conId <= 0 || quantity == null || Math.abs(quantity) <= EPSILON;
  });
  if (invalidPredictionPosition) {
    return {
      status: 'capture_paused',
      reason: 'invalid_position_evidence',
      records: existingRecords,
      changed: [],
    };
  }
  const positionConIds = predictionPositions
    .map((position) => finite(position.conId ?? position.conid))
    .filter((conId) => Number.isInteger(conId) && conId > 0);
  if (new Set(positionConIds).size !== positionConIds.length) {
    return {
      status: 'capture_paused',
      reason: 'duplicate_position_evidence',
      records: existingRecords,
      changed: [],
    };
  }
  const livePositions = new Map();
  predictionPositions.forEach((position) => {
    const conId = finite(position.conId ?? position.conid);
    const quantity = Math.abs(finite(position.quantity ?? position.position) || 0);
    if (!Number.isInteger(conId) || quantity <= 0) return;
    livePositions.set(conId, { ...position, conId, quantity });
    let lifecycle = byConId.get(conId);
    let positionChanged = changed.some((record) => record.recordKey === lifecycle?.recordKey);
    const retainedSettledPosition = settledExpiryByConId.get(conId);
    const settlementTimestamp = timestamp(retainedSettledPosition?.updatedAt || retainedSettledPosition?.resolvedDate);
    const hasNewOpeningExecution = newExecutions.some((execution) => (
      execution.conId === conId
      && execution.direction === 'BUY'
      && (!Number.isFinite(settlementTimestamp) || timestamp(execution.executionTime) > settlementTimestamp)
    ));
    if (!lifecycle && retainedSettledPosition && !hasNewOpeningExecution) {
      // IBKR can retain an expired event position until broker bookkeeping
      // finishes. Once the exact venue outcome has settled, do not create a
      // duplicate lifecycle merely because that zero-value position is still
      // present in the broker snapshot.
      return;
    }
    if (!lifecycle || lifecycle.status === 'verified' || lifecycle.status === 'confirmed') {
      const sequence = records.filter((record) => Number(record.conId) === conId).length + 1;
      lifecycle = createSnapshotLifecycle({ accountId, position: { ...position, conId, quantity }, sequence, now });
      records.push(lifecycle);
      byConId.set(conId, lifecycle);
      positionChanged = true;
    }
    const executionCloseInThisRound = normalizedExecutions.some((execution) => execution.conId === conId && execution.direction === 'SELL');
    const shortPosition = Number(position.position) < -EPSILON || /SHORT|SELL|SLD/i.test(text(position.side));
    if (shortPosition) {
      positionChanged = positionChanged
        || lifecycle.status !== 'review'
        || lifecycle.reviewReason !== 'unsupported_short_position';
      lifecycle.status = 'review';
      lifecycle.reviewReason = 'unsupported_short_position';
    }
    const positionQuantityMismatch = Math.abs(Number(lifecycle.netQuantity || 0) - quantity) > EPSILON;
    if (!executionCloseInThisRound && positionQuantityMismatch) {
      positionChanged = positionChanged
        || lifecycle.status !== 'review'
        || lifecycle.reviewReason !== 'position_quantity_changed_without_execution_evidence';
      lifecycle.status = 'review';
      lifecycle.reviewReason = 'position_quantity_changed_without_execution_evidence';
    }
    const contractLabel = buildContractLabel({
      ...position,
      contractSide: lifecycle.contractSide || position.contractSide,
      strike: lifecycle.strike || position.strike,
    });
    const observedIdentity = contractIdentity({
      ...position,
      right: position.right || position.contractRight || position.contractSide,
      exchange: lifecycle.exchange || position.exchange,
      contractKey: lifecycle.contractKey || position.contractKey || position.localSymbol,
      expiration: lifecycle.expiration || position.expiration,
      strike: lifecycle.strike ?? position.strike,
      contractSide: lifecycle.contractSide || position.contractSide,
    });
    const identityUpdates = {
      eventTicker: lifecycle.eventTicker || observedIdentity.eventTicker,
      contractRule: lifecycle.contractRule || observedIdentity.contractRule,
      expiration: lifecycle.expiration || observedIdentity.expiration,
      ...(observedIdentity.eventDate ? { eventDate: observedIdentity.eventDate } : {}),
      strike: lifecycle.strike ?? observedIdentity.strike,
      contractSide: lifecycle.contractSide || observedIdentity.contractSide,
      exchange: lifecycle.exchange || observedIdentity.exchange,
      contractKey: lifecycle.contractKey || observedIdentity.contractKey,
      symbol: text(position.symbol) || lifecycle.symbol || null,
      localSymbol: text(position.localSymbol) || lifecycle.localSymbol || null,
      secType: text(position.secType) || lifecycle.secType || null,
      tradingClass: text(position.tradingClass) || lifecycle.tradingClass || null,
    };
    const market = lifecycle.market === 'other' ? observedIdentity.market : lifecycle.market;
    const positionAverageCost = finite(position.avgCost ?? position.averageCost);
    const entryQuantity = Number(lifecycle.entryQuantity || 0);
    const netQuantity = Number(lifecycle.netQuantity || 0);
    const noRecordedExit = Number(lifecycle.paid || 0) <= EPSILON
      && Math.abs(entryQuantity - netQuantity) <= EPSILON
      && Math.abs(netQuantity - quantity) <= EPSILON;
    if (positionAverageCost != null && positionAverageCost >= 0 && noRecordedExit) {
      const brokerRisked = positionAverageCost * quantity;
      const entryPrincipal = Number(lifecycle.entryPrincipal || 0);
      const brokerAllocatedFees = brokerRisked - entryPrincipal;
      const nativeForecastEx = Boolean(forecastExThresholdIdentity(lifecycle));
      if (brokerAllocatedFees >= -0.005
        && (lifecycle.feesComplete !== true
          || (nativeForecastEx && brokerAllocatedFees > Number(lifecycle.fees || 0) + EPSILON))) {
        lifecycle.fees = Math.max(Number(lifecycle.fees || 0), Math.max(0, brokerAllocatedFees));
        lifecycle.risked = entryPrincipal + lifecycle.fees;
        lifecycle.feesComplete = true;
        lifecycle.feeEvidence = {
          source: 'ibkr_live_position_average_cost',
          averageCost: positionAverageCost,
          quantity,
          observedRisked: brokerRisked,
          observedAt: positionsPayload.fetchedAt || positionsPayload.fetched_at || now,
        };
        positionChanged = true;
      }
    }
    if (lifecycle.status === 'review'
      && lifecycle.reviewReason === 'unsupported_contract_identity'
      && lifecycle.feesComplete !== false
      && hasSupportedContractIdentity({ ...lifecycle, ...identityUpdates, market })) {
      lifecycle.status = 'open';
      lifecycle.reviewReason = null;
      positionChanged = true;
    }
    if (!shortPosition
      && !positionQuantityMismatch
      && lifecycle.status === 'review'
      && lifecycle.reviewReason === 'position_quantity_changed_without_execution_evidence'
      && lifecycle.feesComplete !== false
      && hasSupportedContractIdentity({ ...lifecycle, ...identityUpdates, market })) {
      lifecycle.status = 'open';
      lifecycle.reviewReason = null;
      positionChanged = true;
    }
    positionChanged = positionChanged
      || lifecycle.lastPositionQuantity !== quantity
      || lifecycle.contractLabel !== contractLabel
      || lifecycle.market !== market
      || Object.entries(identityUpdates).some(([key, value]) => lifecycle[key] !== value);
    if (positionChanged) {
      lifecycle.lastPositionQuantity = quantity;
      lifecycle.lastPositionObservedAt = positionsPayload.fetchedAt || positionsPayload.fetched_at || now;
      lifecycle.contractLabel = contractLabel;
      lifecycle.market = market;
      Object.assign(lifecycle, identityUpdates);
      lifecycle.updatedAt = now;
      changed.push(lifecycle);
    }
  });
  const closedThisRound = new Set(normalizedExecutions.filter((execution) => execution.direction === 'SELL').map((execution) => execution.conId));
  for (const lifecycle of records) {
    if (allowClosureInference
      && lifecycle.feesComplete !== false
      && ACTIVE_STATUSES.has(lifecycle.status)
      && lifecycle.netQuantity > EPSILON
      && !livePositions.has(Number(lifecycle.conId))
      && !closedThisRound.has(Number(lifecycle.conId))) {
      lifecycle.status = 'awaiting_resolution';
      lifecycle.reviewReason = 'awaiting_resolution';
      lifecycle.version = Number(lifecycle.version || 0) + 1;
      lifecycle.updatedAt = now;
      changed.push(lifecycle);
    } else if (!allowClosureInference
      && closureBlockedReason
      && ACTIVE_STATUSES.has(lifecycle.status)
      && lifecycle.netQuantity > EPSILON
      && !livePositions.has(Number(lifecycle.conId))
      && !closedThisRound.has(Number(lifecycle.conId))) {
      lifecycle.status = 'review';
      lifecycle.reviewReason = closureBlockedReason;
      lifecycle.version = Number(lifecycle.version || 0) + 1;
      lifecycle.updatedAt = now;
      changed.push(lifecycle);
    }
  }
  const economicReplay = reconstructForecastExEconomicRecords({
    lifecycleRecords: records,
    executionRecords: [...executionById.values()],
    now,
    touchUpdatedAt: true,
  });
  economicReplay.changedRecords.forEach((projected) => {
    const target = records.find((record) => record.recordKey === projected.recordKey);
    if (!target) return;
    Object.assign(target, projected);
    changed.push(target);
  });
  // Once an execution-complete replacement exists, retain the snapshot row as
  // immutable correction history but remove it from rows, totals, and review.
  records.filter((record) => record.historicalImportId
    && record.status !== 'historical_snapshot_superseded'
    && record.conId != null).forEach((snapshotRecord) => {
    const replacements = records.filter((candidate) => (
      candidate.recordKey !== snapshotRecord.recordKey
      && !candidate.historicalImportId
      && Number(candidate.conId) === Number(snapshotRecord.conId)
      && (candidate.executionIds || []).some(
        (execId) => executionById.get(execId)?.source === 'ibkr_flex_import',
      )
    ));
    if (!replacements.length) return;
    snapshotRecord.status = 'historical_snapshot_superseded';
    snapshotRecord.reviewReason = null;
    snapshotRecord.verification = 'superseded_by_ibkr_activity';
    snapshotRecord.supersededByLifecycleRecordKeys = replacements.map((record) => record.recordKey).sort();
    snapshotRecord.supersededAt = now;
    snapshotRecord.correctionVersion = Number(snapshotRecord.correctionVersion || 0) + 1;
    snapshotRecord.updatedAt = now;
    changed.push(snapshotRecord);
    flexSupersededSnapshotKeys.add(snapshotRecord.recordKey);
  });
  const uniqueChanged = [...new Map(changed.map((record) => [record.recordKey, record])).values()];
  uniqueChanged.forEach((record) => {
    const original = originalByKey.get(record.recordKey);
    record.version = original ? Number(original.version || 0) + 1 : 1;
  });
  legacyFesDateRepairedKeys.forEach((recordKey) => {
    const record = uniqueChanged.find((candidate) => candidate.recordKey === recordKey);
    if (!record) return;
    revisionRecords.push(createRevisionRecord({
      accountId, target: record, before: originalByKey.get(recordKey) || null, after: record,
      revisionType: 'fes_date_identity_repair_v1', actor: 'ibkr_native_execution_identity', now,
    }));
  });
  economicReplay.changedRecords.forEach((projected) => {
    const record = uniqueChanged.find((candidate) => candidate.recordKey === projected.recordKey);
    if (!record) return;
    const original = originalByKey.get(record.recordKey) || null;
    revisionRecords.push(createRevisionRecord({
      accountId,
      target: record,
      before: original,
      after: record,
      revisionType: 'forecast_ex_economic_replay_v2',
      actor: 'prediction_market_reconciler',
      now,
    }));
  });
  flexBasisBackfilledKeys.forEach((recordKey) => {
    const record = uniqueChanged.find((candidate) => candidate.recordKey === recordKey);
    if (!record) return;
    revisionRecords.push(createRevisionRecord({
      accountId,
      target: record,
      before: originalByKey.get(record.recordKey) || null,
      after: record,
      revisionType: 'ibkr_flex_exact_basis_backfill',
      actor: 'ibkr_flex_import',
      now,
    }));
  });
  exactExecutionBasisRepairedKeys.forEach((recordKey) => {
    const record = uniqueChanged.find((candidate) => candidate.recordKey === recordKey);
    if (!record) return;
    revisionRecords.push(createRevisionRecord({
      accountId,
      target: record,
      before: originalByKey.get(record.recordKey) || null,
      after: record,
      revisionType: 'exact_execution_cost_basis_repair',
      actor: 'prediction_market_reconciler',
      now,
    }));
  });
  flexSupersededSnapshotKeys.forEach((recordKey) => {
    const record = uniqueChanged.find((candidate) => candidate.recordKey === recordKey);
    if (!record) return;
    revisionRecords.push(createRevisionRecord({
      accountId,
      target: record,
      before: originalByKey.get(record.recordKey) || null,
      after: record,
      revisionType: 'historical_snapshot_superseded_by_activity',
      actor: 'ibkr_flex_import',
      now,
    }));
  });
  const finalRevisionRecords = consolidateReconciliationRevisions(
    revisionRecords, originalByKey, [...executionRecords, ...uniqueChanged], now,
  );
  const writeEntries = [
    ...executionRecords.map((record) => {
      const original = originalByKey.get(record.recordKey);
      return original
        ? { item: record, expectedVersion: Number(original.version || 1) }
        : { item: record, createOnly: true };
    }),
    ...uniqueChanged.map((record) => {
      const original = originalByKey.get(record.recordKey);
      return original
        ? { item: record, expectedVersion: Number(original.version || 0) }
        : { item: record, createOnly: true };
    }),
    ...finalRevisionRecords.map((record) => ({ item: record, createOnly: true })),
  ];
  return {
    status: 'captured',
    reason: null,
    records: [...records, ...[...executionById.values()]],
    changed: uniqueChanged,
    executionRecords,
    revisionRecords: finalRevisionRecords,
    writeEntries,
  };
}

function exactScheduleTicker(record = {}) {
  const forecastEx = forecastExThresholdIdentity(record);
  if (forecastEx) return forecastEx.eventContract.toUpperCase();
  const candidates = [
    record.contractKey,
    record.localSymbol,
    record.ticker,
    record.description,
    record.contractDescription,
    record.positionSnapshotEvidence?.description,
  ]
    .map((value) => text(value).toUpperCase().replace(/_/g, '-').replace(/-(?:YES|NO)$/, ''))
    .filter(Boolean);
  return candidates.find((value) => /^KX[A-Z0-9]+-[A-Z0-9]+-[A-Z]?-?\d+(?:\.\d+)?$/.test(value)) || null;
}

function applyContractSchedule(lifecycle, schedule = {}, { now = new Date().toISOString() } = {}) {
  const next = clone(lifecycle);
  const source = text(schedule.source);
  const expectedTicker = exactScheduleTicker(next);
  const observedTicker = text(schedule.eventTicker).toUpperCase().replace(/_/g, expectedTicker?.includes('-') ? '-' : '_');
  const lastTradeAt = iso(schedule.lastTradeAt);
  const resolutionAt = iso(schedule.resolutionAt);
  const expectedResolutionAt = iso(schedule.expectedResolutionAt);
  const payoutAt = schedule.payoutAt == null ? null : iso(schedule.payoutAt);
  const observedAt = iso(schedule.observedAt);
  const sourceUrl = text(schedule.sourceUrl);
  const sourceHash = text(schedule.sourceHash);
  const venueStatus = text(schedule.venueStatus).toLowerCase();
  const finalized = ['finalized', 'settled'].includes(venueStatus);
  const outcome = text(schedule.outcome).toUpperCase() || null;
  const isKalshi = source === 'kalshi_exact_market';
  const legacyKalshiSchedule = isKalshi && !venueStatus;
  const kalshiExpectedResolutionAt = expectedResolutionAt || (legacyKalshiSchedule ? resolutionAt : null);
  const trustedSource = ['forecastex_official_contract_api', 'kalshi_exact_market'].includes(source);
  const forecastExIdentity = forecastExThresholdIdentity(next);
  let validFesSchedule = true;
  if (forecastExIdentity?.productCode === 'FES') {
    try {
      validateOfficialFesSchedule({
        eventDate: forecastExIdentity.eventDate,
        brokerExpirationDate: forecastExIdentity.expirationDate,
        lastTradeDate: lastTradeAt,
        expirationDate: resolutionAt,
        payoutDate: payoutAt,
      });
    } catch (_error) {
      validFesSchedule = false;
    }
  }
  const structurallyValid = trustedSource
    && validFesSchedule
    && schedule.ok === true
    && expectedTicker
    && observedTicker === expectedTicker
    && lastTradeAt
    && observedAt
    && sourceUrl
    && sourceHash
    && (isKalshi
      ? (kalshiExpectedResolutionAt
        && timestamp(lastTradeAt) <= timestamp(finalized ? resolutionAt : kalshiExpectedResolutionAt)
        && (!finalized || (resolutionAt && payoutAt && ['YES', 'NO'].includes(outcome))))
      : (resolutionAt
        && timestamp(lastTradeAt) <= timestamp(resolutionAt)
        && (!payoutAt || timestamp(payoutAt) >= timestamp(resolutionAt))));
  if (!structurallyValid) {
    // Once exact venue settlement has been accepted, incomplete schedule
    // metadata cannot demote it. Settlement identity/outcome checks happen
    // below when complete exact evidence is available.
    if (DISPLAY_STATUSES.has(next.status) && next.settlementEvidence) {
      return { changed: false, conflict: false, record: next };
    }
    const changed = next.status !== 'review' || next.reviewReason !== 'contract_schedule_evidence_conflict';
    if (!changed) return { changed: false, conflict: true, record: next };
    next.status = 'review';
    next.reviewReason = 'contract_schedule_evidence_conflict';
    next.version = Number(next.version || 0) + 1;
    next.updatedAt = now;
    return { changed: true, conflict: true, record: next };
  }

  const settlementSymbol = text(schedule.settlementSymbol) || null;
  const recordedOutcome = text(
    next.settlementEvidence?.outcome || next.contractScheduleEvidence?.outcome,
  ).toUpperCase() || null;
  // For Kalshi, timestamps before finalization are mutable schedule metadata.
  // Only an exact contract identity mismatch or contradictory finalized result
  // is a review-worthy broker conflict.
  const conflict = isKalshi
    ? Boolean(
      (settlementSymbol && next.settlementSymbol && next.settlementSymbol !== settlementSymbol)
      || (finalized && recordedOutcome && recordedOutcome !== outcome),
    )
    : Boolean(
      (next.lastTradeAt && next.lastTradeAt !== lastTradeAt)
      || (next.resolutionAt && next.resolutionAt !== resolutionAt)
      || (settlementSymbol && next.settlementSymbol && next.settlementSymbol !== settlementSymbol)
      || (payoutAt && next.payoutAt && next.payoutAt !== payoutAt),
    );
  if (conflict) {
    const changed = next.status !== 'review' || next.reviewReason !== 'contract_schedule_evidence_conflict';
    if (!changed) return { changed: false, conflict: true, record: next };
    next.status = 'review';
    next.reviewReason = 'contract_schedule_evidence_conflict';
    next.version = Number(next.version || 0) + 1;
    next.updatedAt = now;
    return { changed: true, conflict: true, record: next };
  }

  let changed = false;
  const assign = (field, value, { replace = false } = {}) => {
    if (!value || next[field] === value || (!replace && next[field])) return;
    next[field] = value;
    changed = true;
  };
  assign('lastTradeAt', lastTradeAt, { replace: isKalshi });
  if (isKalshi) {
    assign('expectedResolutionAt', kalshiExpectedResolutionAt, { replace: true });
    if (finalized) {
      // Migrate the former expected timestamp in resolutionAt to the exact
      // venue finalization timestamp. This is an audited revision, not a
      // conflict or manual-review condition.
      assign('resolutionAt', resolutionAt, { replace: !DISPLAY_STATUSES.has(next.status) || !next.settlementEvidence });
      assign('payoutAt', payoutAt, { replace: !DISPLAY_STATUSES.has(next.status) || !next.settlementEvidence });
    } else if (legacyKalshiSchedule) {
      // Backward compatibility for previously persisted/test fixtures that
      // predate venueStatus and expectedResolutionAt.
      assign('resolutionAt', resolutionAt);
      assign('payoutAt', payoutAt);
    }
  } else {
    assign('resolutionAt', resolutionAt);
    assign('payoutAt', payoutAt);
  }
  assign('settlementSymbol', settlementSymbol);

  const scheduleEvidenceChanged = !next.contractScheduleEvidence
    || next.contractScheduleEvidence.sourceHash !== sourceHash;
  if (scheduleEvidenceChanged) {
    next.contractScheduleEvidence = {
      source,
      venue: schedule.venue || null,
      eventTicker: expectedTicker,
      venueStatus: venueStatus || null,
      outcome: finalized ? outcome : null,
      expectedResolutionAt: kalshiExpectedResolutionAt || null,
      finalizedAt: finalized ? (iso(schedule.finalizedAt) || resolutionAt) : null,
      sourceUrl,
      sourceHash,
      observedAt,
      rulesUrl: schedule.rulesUrl || null,
    };
    changed = true;
  }
  const payoutEvidenceChanged = payoutAt && (
    !next.payoutScheduleEvidence || next.payoutScheduleEvidence.sourceHash !== sourceHash
  );
  if (payoutEvidenceChanged) {
    next.payoutScheduleEvidence = {
      source,
      eventTicker: expectedTicker,
      outcome: finalized ? outcome : null,
      sourceUrl,
      sourceHash,
      observedAt,
    };
    changed = true;
  }
  const repairableReview = next.status === 'review'
    && SCHEDULE_REPAIR_REASONS.has(next.reviewReason)
    && (hasSupportedContractIdentity(next) || (isKalshi && Boolean(expectedTicker)));
  if (ACTIVE_STATUSES.has(next.status) || repairableReview) {
    const expectedStatus = timestamp(now) >= timestamp(lastTradeAt) ? 'awaiting_resolution' : 'open';
    if (next.status !== expectedStatus || next.reviewReason) {
      next.status = expectedStatus;
      next.reviewReason = null;
      changed = true;
    }
  }
  if (changed) {
    next.version = Number(next.version || 0) + 1;
    next.updatedAt = now;
  }
  return { changed, conflict: false, record: next };
}

function finalizeLifecycle(lifecycle, { paid, resolvedDate, resolutionType = 'expiry', evidence, verification = 'verified_settlement' } = {}) {
  const next = clone(lifecycle);
  next.paid = finite(paid) == null ? next.paid : finite(paid);
  next.resolvedDate = dateOnly(resolvedDate, next.resolvedDate || dateOnly(new Date()));
  next.resolutionType = resolutionType;
  next.status = 'verified';
  next.verification = verification;
  next.netQuantity = 0;
  const performanceComplete = next.costBasisComplete === true || next.feesComplete === true;
  const recordedEntryCost = finite(next.entryCost);
  const recordedRisked = finite(next.risked);
  const computedRisked = finite(next.entryPrincipal) != null && finite(next.fees) != null
    ? finite(next.entryPrincipal) + finite(next.fees)
    : null;
  next.performanceComplete = performanceComplete
    && (recordedEntryCost != null || computedRisked != null || recordedRisked != null);
  // entryCost is the ledger's canonical transaction basis. risked is retained
  // as a presentation-compatible alias and must never diverge from it.
  const authoritativeEntryCost = recordedEntryCost ?? computedRisked ?? recordedRisked;
  next.entryCost = next.performanceComplete ? authoritativeEntryCost : null;
  next.risked = next.entryCost;
  next.pnl = next.performanceComplete ? next.paid - next.risked : null;
  next.roi = next.performanceComplete && next.risked > 0 ? next.pnl / next.risked : null;
  const payoutPerContract = finite(evidence?.payoutPerContract ?? evidence?.settlementPayout);
  if (next.economicRole === 'original_contract' && (payoutPerContract === 0 || payoutPerContract === 1)) {
    const remainingQuantity = finite(next.remainingQuantity) || 0;
    const entryQuantity = finite(next.entryQuantity) || 0;
    const entryCost = finite(next.entryCost ?? next.risked);
    const netExitProceeds = finite(next.netExitProceeds) || 0;
    next.remainingPayout = roundMoney(remainingQuantity * payoutPerContract);
    next.paid = roundMoney(netExitProceeds + next.remainingPayout);
    next.pnl = entryCost == null ? null : roundMoney(next.paid - entryCost);
    next.roi = next.pnl != null && entryCost > 0 ? next.pnl / entryCost : null;
    next.holdToExpiryPnl = entryCost == null
      ? null
      : roundMoney(entryQuantity * payoutPerContract - entryCost);
    next.savedVsHold = next.pnl == null || next.holdToExpiryPnl == null
      ? null
      : roundMoney(next.pnl - next.holdToExpiryPnl);
    next.valuationStatus = 'official';
  }
  next.settlementEvidence = evidence || null;
  next.reviewReason = null;
  next.version = Number(next.version || 0) + 1;
  next.updatedAt = new Date().toISOString();
  return next;
}

function settlementDetailsFromRecord(record = {}) {
  const evidence = record.settlementEvidence || {};
  const valueFields = [
    'underlyingSettlementValue',
    'settlementValue',
    'closeValue',
    'final',
  ];
  const valueField = valueFields.find((field) => (
    evidence[field] != null
    && typeof evidence[field] !== 'boolean'
    && finite(evidence[field]) != null
  ));
  const settlementValue = valueField ? finite(evidence[valueField]) : null;
  const settlementSymbol = text(
    record.settlementSymbol
    || evidence.underlyingSettlementSymbol
    || evidence.settlementSymbol,
  ) || null;
  const outcomeRaw = text(evidence.outcome || evidence.result).toUpperCase();
  const outcome = ['YES', 'NO'].includes(outcomeRaw) ? outcomeRaw : null;
  const payoutPerContract = finite(
    evidence.payoutPerContract
    ?? evidence.settlementPayout,
  );
  const resolutionAt = iso(record.resolutionAt || evidence.resolutionAt);
  const payoutAt = iso(record.payoutAt || evidence.payoutAt);
  const resolverSource = settlementValue == null
    ? null
    : (evidence.underlyingSettlementSource || evidence.source || null);
  const resolverObservedAt = settlementValue == null
    ? null
    : (evidence.underlyingSettlementObservedAt || evidence.observedAt || record.updatedAt || null);
  const resolverSourceUrl = settlementValue == null
    ? null
    : (evidence.underlyingSettlementSourceUrl || evidence.sourceUrl || null);
  return {
    // Broker expiration/ticker dates are not universally the venue payout date
    // (ForecastEx FES can settle on the following business day), so only expose
    // a published settlement date or the finalized lifecycle date.
    settlementDate: dateOnly(evidence.settlementDate || resolutionAt || record.resolvedDate),
    lastTradeAt: iso(record.lastTradeAt),
    resolutionAt,
    payoutAt,
    outcome,
    outcomeObservedAt: iso(evidence.outcomeObservedAt || evidence.observedAt),
    payoutPerContract,
    settlementSymbol,
    settlementValue,
    settlementValueSource: settlementValue == null
      ? null
      : resolverSource,
    settlementValueObservedAt: settlementValue == null
      ? null
      : resolverObservedAt,
    settlementValueStatus: settlementValue == null
      ? null
      : (evidence.underlyingSettlementStatus || 'official_final'),
    resolverAvailability: settlementValue == null
      ? (settlementSymbol ? 'awaiting_official_settlement' : 'unavailable')
      : 'official_final',
    resolverSource,
    resolverObservedAt,
    resolverSourceUrl,
    resolver: {
      availability: settlementValue == null
        ? (settlementSymbol ? 'awaiting_official_settlement' : 'unavailable')
        : 'official_final',
      symbol: settlementSymbol,
      value: settlementValue,
      source: resolverSource,
      sourceUrl: resolverSourceUrl,
      observedAt: resolverObservedAt,
    },
    closingTradePrice: finite(evidence.closingTradePrice),
    closingTradeAt: iso(evidence.closingTradeAt),
  };
}


function normalizePerformanceRow(record) {
  if (!record || !DISPLAY_STATUSES.has(record.status)) return null;
  const normalizedMarket = normalizeMarket(record.market, record.contractLabel);
  const settlement = settlementDetailsFromRecord(record);
  const entryCost = finite(record.entryCost ?? record.risked);
  const paid = finite(record.paid);
  const performanceComplete = record.performanceComplete !== false
    && entryCost != null
    && paid != null;
  // Enforce the ledger equation at the read boundary as well as persistence.
  // This prevents a previously stored risked/P&L mismatch from leaking into
  // rows or consolidated totals while its correction revision is applied.
  const pnl = performanceComplete ? roundMoney(paid - entryCost) : null;
  const roi = performanceComplete && entryCost > 0 ? pnl / entryCost : null;
  return {
    id: record.lifecycleId || record.recordKey,
    conId: finite(record.conId),
    recordKey: record.recordKey || null,
    resolvedDate: record.resolvedDate,
    openedAt: record.openedAt || null,
    expiration: record.expiration || null,
    ...(record.eventDate ? { eventDate: record.eventDate } : {}),
    market: normalizedMarket === 'other' ? record.market : normalizedMarket,
    contractLabel: record.contractLabel,
    contractSide: record.contractSide,
    contractRule: record.contractRule || null,
    contractKey: record.contractKey || null,
    eventTicker: record.eventTicker || null,
    exchange: record.exchange || null,
    strike: finite(record.strike),
    quantity: finite(record.entryQuantity),
    entryQuantity: finite(record.entryQuantity),
    exitedQuantity: finite(record.exitedQuantity) || 0,
    remainingQuantity: finite(record.remainingQuantity) || 0,
    entryCost,
    risked: entryCost,
    exitFees: finite(record.exitFees) || 0,
    netExitProceeds: finite(record.netExitProceeds) || 0,
    remainingPayout: finite(record.remainingPayout),
    holdToExpiryPnl: finite(record.holdToExpiryPnl),
    savedVsHold: finite(record.savedVsHold),
    paid,
    currentValue: paid,
    pnl,
    roi,
    resolutionType: record.resolutionType,
    verification: record.verification,
    verificationProvenance: record.verification,
    status: record.status,
    performanceComplete,
    basisStatus: record.basisStatus || (entryCost == null ? 'missing' : 'complete'),
    valuationStatus: record.valuationStatus || 'official',
    ledgerModelVersion: record.ledgerModelVersion || null,
    economicRole: record.economicRole || null,
    displayState: displayStateFromRecord(record),
    updatedAt: record.updatedAt,
    ...(record.fesResearchContextStatus ? { fesResearchContextStatus: record.fesResearchContextStatus } : {}),
    ...settlement,
  };
}

function normalizeActivePerformanceRow(record) {
  if (!record || !ACTIVE_STATUSES.has(record.status)) return null;
  const normalizedMarket = normalizeMarket(record.market, record.contractLabel);
  const settlement = settlementDetailsFromRecord(record);
  return {
    id: record.lifecycleId || record.recordKey,
    recordKey: record.recordKey || null,
    resolvedDate: null,
    openedAt: record.openedAt || null,
    expiration: record.expiration || null,
    ...(record.eventDate ? { eventDate: record.eventDate } : {}),
    market: normalizedMarket === 'other' ? record.market : normalizedMarket,
    contractLabel: record.contractLabel,
    contractSide: record.contractSide,
    contractRule: record.contractRule || null,
    contractKey: record.contractKey,
    eventTicker: record.eventTicker,
    exchange: record.exchange,
    strike: finite(record.strike),
    conId: finite(record.conId),
    quantity: finite(record.netQuantity) || 0,
    entryQuantity: finite(record.entryQuantity ?? record.netQuantity) || 0,
    exitedQuantity: finite(record.exitedQuantity) || 0,
    remainingQuantity: finite(record.remainingQuantity ?? record.netQuantity) || 0,
    entryCost: finite(record.entryCost ?? record.risked),
    risked: finite(record.entryCost ?? record.risked),
    exitFees: finite(record.exitFees) || 0,
    netExitProceeds: finite(record.netExitProceeds ?? record.paid) || 0,
    remainingPayout: finite(record.remainingPayout),
    holdToExpiryPnl: finite(record.holdToExpiryPnl),
    savedVsHold: finite(record.savedVsHold),
    paid: finite(record.paid) || 0,
    currentValue: null,
    pnl: null,
    roi: null,
    resolutionType: null,
    verification: record.verification,
    verificationProvenance: record.verification,
    status: record.status,
    performanceComplete: record.performanceComplete !== false && finite(record.risked) != null,
    basisStatus: record.basisStatus || (finite(record.entryCost ?? record.risked) == null ? 'missing' : 'complete'),
    valuationStatus: record.valuationStatus || 'pending',
    ledgerModelVersion: record.ledgerModelVersion || null,
    economicRole: record.economicRole || null,
    displayState: displayStateFromRecord(record),
    reviewReason: record.reviewReason || null,
    updatedAt: record.updatedAt,
    ...(record.fesResearchContextStatus ? { fesResearchContextStatus: record.fesResearchContextStatus } : {}),
    ...settlement,
  };
}


function summarizeRows(rows = []) {
  const verified = rows.map(normalizePerformanceRow).filter(Boolean);
  const roundMoney = (value) => Number(value.toFixed(6));
  const risked = roundMoney(verified.reduce((sum, row) => sum + (row.risked || 0), 0));
  const paid = roundMoney(verified.reduce((sum, row) => sum + (row.paid || 0), 0));
  const pnl = roundMoney(verified.reduce((sum, row) => sum + (row.pnl || 0), 0));
  return {
    count: verified.length,
    risked,
    paid,
    pnl,
    roi: risked > 0 ? pnl / risked : null,
  };
}

function createLedgerStore({
  dynamodb,
  tableName = process.env.PREDICTION_MARKET_PERFORMANCE_LEDGER_TABLE || DEFAULT_TABLE_NAME,
  healthRetentionSeconds = HEALTH_RETENTION_SECONDS,
  maxTransactionItems = MAX_TRANSACTION_ITEMS,
} = {}) {
  if (!dynamodb) throw new Error('A DynamoDB DocumentClient is required.');
  async function queryAccount(accountId) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const result = await dynamodb.query({
        TableName: tableName,
        KeyConditionExpression: '#accountId = :accountId',
        ExpressionAttributeNames: { '#accountId': 'accountId' },
        ExpressionAttributeValues: { ':accountId': accountId },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }).promise();
      items.push(...(result.Items || []).map(deserializeLedgerItem));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
  async function queryAccountPrefix(accountId, recordKeyPrefix) {
    const prefix = text(recordKeyPrefix);
    if (!prefix) return queryAccount(accountId);
    const items = [];
    let ExclusiveStartKey;
    do {
      const result = await dynamodb.query({
        TableName: tableName,
        KeyConditionExpression: '#accountId = :accountId AND begins_with(#recordKey, :recordKeyPrefix)',
        ExpressionAttributeNames: { '#accountId': 'accountId', '#recordKey': 'recordKey' },
        ExpressionAttributeValues: { ':accountId': accountId, ':recordKeyPrefix': prefix },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }).promise();
      items.push(...(result.Items || [])
        .filter((item) => text(item?.recordKey).startsWith(prefix))
        .map(deserializeLedgerItem));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
  async function put(item, { expectedVersion } = {}) {
    const next = serializeLedgerItem(item);
    const params = { TableName: tableName, Item: next };
    if (expectedVersion != null) {
      params.ConditionExpression = '#version = :expectedVersion';
      params.ExpressionAttributeNames = { '#version': 'version' };
      params.ExpressionAttributeValues = { ':expectedVersion': Number(expectedVersion) };
    }
    await dynamodb.put(params).promise();
    return deserializeLedgerItem(next);
  }

  async function transactSave(entries = [], { clientRequestToken = crypto.randomUUID() } = {}) {
    if (!entries.length) return [];
    if (entries.length > maxTransactionItems) {
      const error = new Error(`A ledger transaction cannot exceed ${maxTransactionItems} records.`);
      error.code = 'LEDGER_TRANSACTION_TOO_LARGE';
      throw error;
    }
    const normalized = entries.map((entry) => (entry?.item ? entry : { item: entry }));
    const keys = normalized.map(({ item }) => `${item.accountId}\u0000${item.recordKey}`);
    if (new Set(keys).size !== keys.length) {
      const error = new Error('A ledger transaction cannot write the same record more than once.');
      error.code = 'LEDGER_TRANSACTION_DUPLICATE_KEY';
      throw error;
    }
    const TransactItems = normalized.map(({ item, expectedVersion, createOnly }) => {
      const Put = { TableName: tableName, Item: serializeLedgerItem(item) };
      if (createOnly) {
        Put.ConditionExpression = 'attribute_not_exists(#recordKey)';
        Put.ExpressionAttributeNames = { '#recordKey': 'recordKey' };
      } else if (expectedVersion != null) {
        Put.ConditionExpression = '#version = :expectedVersion';
        Put.ExpressionAttributeNames = { '#version': 'version' };
        Put.ExpressionAttributeValues = { ':expectedVersion': Number(expectedVersion) };
      }
      return { Put };
    });
    await dynamodb.transactWrite({
      TransactItems,
      ClientRequestToken: String(clientRequestToken).slice(0, 36),
    }).promise();
    return normalized.map(({ item }) => item);
  }

  async function saveMany(items = []) {
    return transactSave(items);
  }

  async function get(accountId, recordKey) {
    const result = await dynamodb.get({ TableName: tableName, Key: { accountId, recordKey } }).promise();
    return result.Item ? deserializeLedgerItem(result.Item) : null;
  }

  function healthItem(accountId, status, details = {}, observedAt = new Date().toISOString()) {
    return {
      accountId,
      recordKey: HEALTH_KEY,
      itemType: 'health',
      status,
      message: details.message || null,
      reason: details.reason || null,
      snapshotId: details.snapshotId || null,
      positionCount: finite(details.positionCount),
      executionCount: finite(details.executionCount),
      lastSuccessfulCaptureAt: details.lastSuccessfulCaptureAt || (status === 'capturing' ? observedAt : null),
      evidenceMode: details.evidenceMode || null,
      historyThrough: details.historyThrough || null,
      liveConnected: details.liveConnected === true,
      observedAt,
      updatedAt: observedAt,
      ttl: Math.floor(Date.parse(observedAt) / 1000) + healthRetentionSeconds,
    };
  }

  async function writeHealth(accountId, status, details = {}, observedAt = new Date().toISOString()) {
    const previous = await get(accountId, HEALTH_KEY).catch(() => null);
    const next = healthItem(accountId, status, {
      ...details,
      lastSuccessfulCaptureAt: status === 'capturing'
        ? observedAt
        : previous?.lastSuccessfulCaptureAt || details.lastSuccessfulCaptureAt || null,
    }, observedAt);
    await put(next);
    return next;
  }

  async function acquireLease(accountId, ownerId, { leaseMs = 55_000, now = Date.now() } = {}) {
    const leaseExpiresAt = now + leaseMs;
    try {
      await dynamodb.update({
        TableName: tableName,
        Key: { accountId, recordKey: LEASE_KEY },
        UpdateExpression: 'SET #itemType = :itemType, #ownerId = :ownerId, #leaseExpiresAt = :leaseExpiresAt, #updatedAt = :updatedAt, #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(#recordKey) OR #leaseExpiresAt < :now OR #ownerId = :ownerId',
        ExpressionAttributeNames: {
          '#recordKey': 'recordKey',
          '#itemType': 'itemType',
          '#ownerId': 'ownerId',
          '#leaseExpiresAt': 'leaseExpiresAt',
          '#updatedAt': 'updatedAt',
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':itemType': 'lease',
          ':ownerId': ownerId,
          ':leaseExpiresAt': leaseExpiresAt,
          ':now': now,
          ':updatedAt': new Date(now).toISOString(),
          ':ttl': Math.floor(leaseExpiresAt / 1000) + 24 * 60 * 60,
        },
      }).promise();
      return true;
    } catch (error) {
      if (error?.code === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
  async function registerManagedAccounts(accountIds = [], observedAt = new Date().toISOString()) {
    const entries = [...new Set(accountIds.map((value) => text(value)).filter(Boolean))].map((accountId) => ({
      item: {
        accountId: SYSTEM_ACCOUNT_ID,
        recordKey: `${MANAGED_ACCOUNT_PREFIX}${accountId}`,
        itemType: 'managed_account',
        managedAccountId: accountId,
        verification: 'ibkr_managed_accounts',
        observedAt,
        updatedAt: observedAt,
      },
    }));
    if (entries.length) await transactSave(entries);
    return entries.length;
  }
  async function isRegisteredManagedAccount(accountId) {
    const record = await get(SYSTEM_ACCOUNT_ID, `${MANAGED_ACCOUNT_PREFIX}${text(accountId)}`);
    return record?.itemType === 'managed_account' && record.managedAccountId === text(accountId);
  }
  async function listRegisteredManagedAccounts() {
    const records = await queryAccountPrefix(SYSTEM_ACCOUNT_ID, MANAGED_ACCOUNT_PREFIX);
    return records
      .filter((record) => record.itemType === 'managed_account' && text(record.managedAccountId))
      .map((record) => text(record.managedAccountId))
      .sort();
  }
  return {
    tableName,
    maxTransactionItems,
    queryAccount,
    queryAccountPrefix,
    put,
    saveMany,
    transactSave,
    get,
    healthItem,
    writeHealth,
    acquireLease,
    registerManagedAccounts,
    isRegisteredManagedAccount,
    listRegisteredManagedAccounts,
  };
}

async function queryOperationalAccountRecords(store, accountId) {
  if (typeof store?.queryAccountPrefix !== 'function') return store.queryAccount(accountId);
  const [lifecycles, executions, health] = await Promise.all([
    store.queryAccountPrefix(accountId, LIFECYCLE_PREFIX),
    store.queryAccountPrefix(accountId, EXECUTION_PREFIX),
    store.queryAccountPrefix(accountId, HEALTH_KEY),
  ]);
  return [...lifecycles, ...executions, ...health];
}

function missingDisplayEntryDates(records, executions = []) {
  return records.filter((record) => record.itemType === 'lifecycle'
    && (DISPLAY_STATUSES.has(record.status) || ACTIVE_STATUSES.has(record.status))
    && !recoverExactOpenedAt(record, executions));
}

async function queryDisplayAccountRecords(store, accountId) {
  if (typeof store?.queryAccountPrefix !== 'function') {
    const records = await store.queryAccount(accountId);
    const recoveryKeys = new Set(missingDisplayEntryDates(
      records, records.filter((record) => record.itemType === 'execution'),
    ).map((record) => record.recordKey));
    return [
      ...records.filter((record) => record.itemType !== 'revision'),
      ...await publishedRevisions(store, records.filter((record) => record.itemType === 'revision'
        && recoveryKeys.has(record.targetRecordKey))),
    ];
  }
  const [lifecycles, health] = await Promise.all([
    store.queryAccountPrefix(accountId, LIFECYCLE_PREFIX),
    store.queryAccountPrefix(accountId, HEALTH_KEY),
  ]);
  // Hidden review/component rows do not need a display date. Materialized
  // original entries usually recover a legacy date without any further reads.
  const missing = missingDisplayEntryDates(lifecycles);
  if (!missing.length) return [...lifecycles, ...health];
  const executions = await store.queryAccountPrefix(accountId, EXECUTION_PREFIX);
  const unresolved = missingDisplayEntryDates(missing, executions).filter((record) => text(record.recordKey));
  // Never scan the account's full revision history for a missing date. Only
  // inspect the specific displayed lifecycles not resolved by linked fills.
  const revisions = (await Promise.all(unresolved.map((record) => {
    const targetHash = crypto.createHash('sha256').update(record.recordKey).digest('hex').slice(0, 24);
    return store.queryAccountPrefix(accountId, `${REVISION_PREFIX}${targetHash}#`);
  }))).flat();
  return [...lifecycles, ...executions, ...await publishedRevisions(store, revisions), ...health];
}

// Oversized captures may stage immutable audit evidence before committing
// the ledger state. Only the marker written atomically with that state makes
// those revisions visible. Failed attempts preserve evidence without changing
// the published ledger; a retry uses its own publication ID.
async function publishedRevisions(store, revisions = []) {
  const publications = new Map();
  for (const revision of revisions) {
    if (!revision.publicationRecordKey) continue;
    const key = `${revision.accountId}:${revision.publicationRecordKey}`;
    if (!publications.has(key)) publications.set(key, typeof store?.get === 'function'
      ? store.get(revision.accountId, revision.publicationRecordKey)
      : Promise.resolve(null));
  }
  await Promise.all([...publications].map(async ([key, pending]) => {
    publications.set(key, await pending);
  }));
  return revisions.filter((revision) => {
    if (!revision.publicationRecordKey) return true;
    const publication = publications.get(`${revision.accountId}:${revision.publicationRecordKey}`);
    return publication?.itemType === 'capture_publication'
      && publication.accountId === revision.accountId
      && publication.recordKey === revision.publicationRecordKey;
  });
}

function recoverExactOpenedAt(record, executionRecords = [], revisionRecords = []) {
  if (record?.openedAt) return record.openedAt;
  const linkedExecutionIds = new Set(record?.executionIds || []);
  const candidates = [
    ...(record?.economicTransactions?.entries || []).map((entry) => entry.executedAt),
    ...executionRecords
      .filter((execution) => (
        String(execution.direction || '').toUpperCase() === 'BUY'
        && (execution.lifecycleRecordKey === record?.recordKey || linkedExecutionIds.has(execution.execId))
      ))
      .map((execution) => execution.executionTime),
    ...revisionRecords
      .filter((revision) => revision.targetRecordKey === record?.recordKey)
      .flatMap((revision) => [revision.before?.openedAt, revision.after?.openedAt]),
  ];
  const first = candidates
    .map((value) => timestamp(value))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  return Number.isFinite(first) ? new Date(first).toISOString() : null;
}

function isDeterministicBrokerSettlementGhost(record, lifecycleRecords = []) {
  if (record.status !== 'review'
    || !['unmatched_or_cross_zero_close', 'cashout_bundle_ambiguous'].includes(record.reviewReason)
    || Math.abs(Number(record.entryQuantity || 0)) > EPSILON
    || Math.abs(Number(record.netQuantity || 0)) > EPSILON
    || Math.abs(Number(record.entryPrincipal || 0)) > EPSILON
    || Math.abs(Number(record.fees || 0)) > EPSILON
    || Math.abs(Number(record.paid || 0)) > EPSILON
    || (record.executionIds || []).length !== 1
    || record.conId == null) return false;
  return lifecycleRecords.some((candidate) => (
    candidate.recordKey !== record.recordKey
    && Number(candidate.conId) === Number(record.conId)
    && DISPLAY_STATUSES.has(candidate.status)
    && candidate.resolutionType === 'expiry'
    && officialSettlementPayout(candidate) != null
  ));
}

async function persistCaptureEntries(store, writeEntries = [], healthItem = null) {
  const evidenceEntries = writeEntries.filter(Boolean);
  const healthEntry = healthItem ? { item: healthItem } : null;
  const maxItems = Number(store?.maxTransactionItems || MAX_TRANSACTION_ITEMS);
  const allEntries = healthEntry ? [...evidenceEntries, healthEntry] : evidenceEntries;
  if (allEntries.length <= maxItems) return store.transactSave(allEntries);

  // DynamoDB transactions are capped at 100 items. Preserve atomicity at the
  // lifecycle boundary when an account has enough fills across multiple
  // contracts to exceed that cap, and publish health only after every
  // lifecycle group succeeds.
  const executionLifecycle = new Map(evidenceEntries
    .filter((entry) => entry?.item?.itemType === 'execution' && entry.item.lifecycleRecordKey)
    .map((entry) => [entry.item.recordKey, entry.item.lifecycleRecordKey]));
  const groups = new Map();
  const groupFor = (entry) => {
    const item = entry?.item || {};
    if (item.itemType === 'lifecycle') return item.recordKey;
    if (item.itemType === 'execution') return item.lifecycleRecordKey || `evidence#${item.recordKey}`;
    if (item.itemType === 'revision') {
      if (item.after?.lifecycleRecordKey) return item.after.lifecycleRecordKey;
      if (String(item.targetRecordKey || '').startsWith(LIFECYCLE_PREFIX)) return item.targetRecordKey;
      return executionLifecycle.get(item.targetRecordKey) || `evidence#${item.targetRecordKey || item.recordKey}`;
    }
    return `evidence#${item.recordKey}`;
  };
  evidenceEntries.forEach((entry) => {
    const key = groupFor(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });
  for (const [groupKey, entries] of groups) {
    const stateCount = entries.filter((entry) => entry.item.itemType !== 'revision').length;
    if (entries.length > maxItems && stateCount + 1 > maxItems) {
      const error = new Error(`Lifecycle ${groupKey} requires ${entries.length} atomic ledger writes; the limit is ${maxItems}.`);
      error.code = 'LEDGER_LIFECYCLE_TRANSACTION_TOO_LARGE';
      throw error;
    }
  }
  const saved = [];
  for (const entries of groups.values()) {
    if (entries.length <= maxItems) {
      saved.push(...await store.transactSave(entries));
      continue;
    }
    const publicationId = crypto.randomUUID();
    const publicationRecordKey = `capture_publication#${publicationId}`;
    const revisions = entries.filter((entry) => entry.item.itemType === 'revision').map((entry) => ({
      ...entry,
      createOnly: true,
      item: {
        ...entry.item,
        recordKey: `${entry.item.recordKey}#${publicationId}`,
        publicationRecordKey,
      },
    }));
    for (let offset = 0; offset < revisions.length; offset += maxItems) {
      saved.push(...await store.transactSave(revisions.slice(offset, offset + maxItems)));
    }
    const stateEntries = entries.filter((entry) => entry.item.itemType !== 'revision');
    saved.push(...await store.transactSave([...stateEntries, {
      createOnly: true,
      item: {
        accountId: entries[0].item.accountId,
        recordKey: publicationRecordKey,
        itemType: 'capture_publication',
        revisionCount: revisions.length,
        createdAt: new Date().toISOString(),
      },
    }]));
  }
  if (healthEntry) saved.push(...await store.transactSave([healthEntry]));
  return saved;
}

async function loadPerformance({ store, accountId, market = 'all', sort = 'date', direction = 'desc' }) {
  if (!accountId) {
    const empty = summarizeRows([]);
    return {
      rows: [],
      activeRows: [],
      review: [],
      summary: empty,
      summaries: Object.fromEntries(performanceSummaryKeys().map((key) => [key, empty])),
      tracker: { status: 'account_required' },
    };
  }
  // The reconciler atomically materializes economic ForecastEx lifecycles.
  // Reads consult immutable execution/revision evidence only to recover an
  // exact opening timestamp omitted by older lifecycle projections.
  const records = await queryDisplayAccountRecords(store, accountId);
  const allLifecycleRecords = records.filter((record) => record.itemType === 'lifecycle');
  const executionRecords = records.filter((record) => record.itemType === 'execution');
  const revisionRecords = records.filter((record) => record.itemType === 'revision');
  const lifecycleRecords = allLifecycleRecords.filter((record) => (
    record.status !== PAIRED_OFFSET_COMPONENT_STATUS
    && record.status !== BROKER_SETTLEMENT_POSTING_STATUS
    && record.status !== BROKER_EXECUTION_REPRESENTATION_STATUS
    && !isDeterministicBrokerSettlementGhost(record, allLifecycleRecords)
  )).map((record) => {
    const openedAt = recoverExactOpenedAt(record, executionRecords, revisionRecords);
    return openedAt && !record.openedAt ? { ...record, openedAt } : record;
  });
  const health = records.find((record) => record.itemType === 'health' && record.recordKey === HEALTH_KEY) || null;
  const quarantinedRecords = lifecycleRecords.filter((record) => REVIEW_STATUSES.has(record.status));
  const authoritativeRecords = lifecycleRecords.filter((record) => !REVIEW_STATUSES.has(record.status));
  const rows = authoritativeRecords.map(normalizePerformanceRow).filter(Boolean);
  const activeRows = authoritativeRecords.map(normalizeActivePerformanceRow).filter(Boolean);
  const sourceGapCount = lifecycleRecords.filter((record) => record.reviewReason === 'incomplete_fee_evidence').length;
  const openCount = authoritativeRecords.filter((record) => record.status === 'open').length;
  const awaitingSettlementCount = authoritativeRecords.filter((record) => record.status === 'awaiting_resolution').length;
  const filtered = market === 'all' ? rows : rows.filter((row) => row.market === market);
  const filteredActive = market === 'all' ? activeRows : activeRows.filter((row) => row.market === market);
  const summaries = performanceSummaryKeys().reduce((output, key) => {
    output[key] = summarizeRows(key === 'all' ? rows : rows.filter((row) => row.market === key));
    return output;
  }, {});
  return {
    rows: sortPerformanceRows(filtered, sort, direction),
    activeRows: sortPerformanceRows(filteredActive, sort, direction),
    // Conflicting or incomplete evidence stays in the durable ledger for
    // automatic reconciliation, but is never turned into a user review task.
    review: [],
    summary: summarizeRows(filtered),
    summaries,
    tracker: {
      status: authoritativeRecords.length ? 'ready' : 'empty',
      accountId,
      openCount,
      awaitingSettlementCount,
      awaitingResultCount: awaitingSettlementCount,
      trackingCount: openCount + awaitingSettlementCount,
      sourceGapCount,
      sourceGapMessage: sourceGapCount
        ? 'Historical activity source not configured or missing required fee fields.'
        : null,
      updatedAt: lifecycleRecords.map((record) => record.updatedAt).filter(Boolean).sort().at(-1) || null,
      health: health?.status || 'capture_paused',
      healthMessage: health?.message || (health ? null : 'Waiting for the first verified IBKR account snapshot.'),
      healthReason: health?.reason || null,
      healthObservedAt: health?.observedAt || null,
      lastSuccessfulCaptureAt: health?.lastSuccessfulCaptureAt || null,
      snapshotId: health?.snapshotId || null,
      evidenceMode: health?.evidenceMode || null,
      historyThrough: health?.historyThrough || null,
      liveConnected: health?.liveConnected === true,
      quarantinedEvidenceCount: quarantinedRecords.length,
      ledgerModelVersion: FORECASTEX_LEDGER_MODEL_VERSION,
      economicReplay: {
        bundleCount: lifecycleRecords.filter((record) => record.economicBundleStatus === 'verified').length,
        ambiguousCount: lifecycleRecords.filter((record) => record.reviewReason === 'cashout_bundle_ambiguous').length,
      },
    },
  };
}

async function loadPerformanceExecutions({ store, accountId, id, prepared = null }) {
  if (!accountId || !id) return null;
  if (prepared && prepared.accountId !== accountId) throw new Error('Prepared execution history belongs to another account.');
  const scopedReadsAvailable = typeof store?.queryAccountPrefix === 'function';
  const records = prepared?.records || await queryOperationalAccountRecords(store, accountId);
  const executionRecords = records.filter((record) => record.itemType === 'execution');
  const replay = prepared?.replay || reconstructForecastExEconomicRecords({
    lifecycleRecords: records.filter((record) => record.itemType === 'lifecycle'),
    executionRecords,
  });
  const lifecycle = replay.records.find((record) => (
    record.lifecycleId === id || record.recordKey === id
  ));
  if (!lifecycle || lifecycle.status === PAIRED_OFFSET_COMPONENT_STATUS) return null;
  const transactionExecutionIds = new Set([
    ...(lifecycle.executionIds || []),
    ...(lifecycle.economicTransactions?.entries || []).flatMap((entry) => entry.rawLegs?.map((leg) => leg.execId) || []),
    ...(lifecycle.economicTransactions?.cashOuts || []).flatMap((cashOut) => cashOut.rawLegs?.map((leg) => leg.execId) || []),
  ]);
  const rawExecutions = executionRecords
    .filter((execution) => transactionExecutionIds.has(execution.execId))
    .sort((left, right) => timestamp(left.executionTime) - timestamp(right.executionTime) || left.execId.localeCompare(right.execId))
    .map((execution) => rawExecutionView(execution));
  const revisionPrefix = `${REVISION_PREFIX}${crypto.createHash('sha256').update(lifecycle.recordKey).digest('hex').slice(0, 24)}#`;
  const revisionRecords = scopedReadsAvailable
    ? await store.queryAccountPrefix(accountId, revisionPrefix)
    : records;
  const revisions = (await publishedRevisions(store, revisionRecords))
    .filter((record) => record.itemType === 'revision' && record.targetRecordKey === lifecycle.recordKey)
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  return {
    id: lifecycle.lifecycleId || lifecycle.recordKey,
    recordKey: lifecycle.recordKey,
    contractLabel: lifecycle.contractLabel,
    contractKey: lifecycle.contractKey,
    eventTicker: lifecycle.eventTicker,
    ledgerModelVersion: lifecycle.ledgerModelVersion || null,
    economicRole: lifecycle.economicRole || null,
    bundleStatus: lifecycle.economicBundleStatus || null,
    entryQuantity: finite(lifecycle.entryQuantity),
    exitedQuantity: finite(lifecycle.exitedQuantity) || 0,
    remainingQuantity: finite(lifecycle.remainingQuantity ?? lifecycle.netQuantity) || 0,
    entryCost: finite(lifecycle.entryCost ?? lifecycle.risked),
    exitFees: finite(lifecycle.exitFees) || 0,
    netExitProceeds: finite(lifecycle.netExitProceeds) || 0,
    economicEntries: lifecycle.economicTransactions?.entries || [],
    cashOuts: lifecycle.economicTransactions?.cashOuts || [],
    rawExecutions,
    revisions,
  };
}

function applyReviewPatch(record, patch = {}, expectedVersion) {
  if (!record || record.itemType !== 'lifecycle') return { ok: false, code: 'not_found' };
  if (expectedVersion != null && Number(record.version) !== Number(expectedVersion)) {
    return { ok: false, code: 'version_conflict' };
  }
  const next = clone(record);
  const allowed = ['market', 'contractLabel', 'contractSide', 'strike', 'resolutionType', 'entryPrincipal', 'fees', 'paid', 'resolvedDate', 'quantity', 'netQuantity'];
  allowed.forEach((field) => {
    if (patch[field] !== undefined) next[field] = patch[field];
  });
  if (patch.quantity !== undefined) next.entryQuantity = patch.quantity;
  next.market = normalizeMarket(next.market, next.contractLabel);
  if (!PERFORMANCE_MARKET_KEYS.includes(next.market)) return { ok: false, code: 'unsupported_market' };
  if (!text(next.contractLabel)) return { ok: false, code: 'contract_label_required' };
  const normalizedSide = normalizeContractSide(next.contractSide, next.contractLabel);
  if (!['YES', 'NO'].includes(normalizedSide)) return { ok: false, code: 'invalid_contract_side' };
  next.contractSide = normalizedSide;
  if (patch.contractLabel === undefined && (patch.market !== undefined || patch.contractSide !== undefined || patch.strike !== undefined)) {
    next.contractLabel = buildContractLabel(next);
  }
  if (!['expiry', 'early_exit'].includes(String(next.resolutionType))) return { ok: false, code: 'invalid_resolution_type' };
  next.resolvedDate = dateOnly(next.resolvedDate);
  if (!next.resolvedDate) return { ok: false, code: 'invalid_resolved_date' };
  next.entryPrincipal = finite(next.entryPrincipal);
  next.fees = finite(next.fees);
  next.paid = finite(next.paid);
  next.entryQuantity = finite(next.entryQuantity ?? next.netQuantity);
  next.netQuantity = finite(next.netQuantity);
  if ([next.entryPrincipal, next.fees, next.paid, next.entryQuantity, next.netQuantity].some((value) => value == null || value < 0)) return { ok: false, code: 'invalid_performance_amount' };
  if (next.entryQuantity <= 0) return { ok: false, code: 'invalid_performance_quantity' };
  next.risked = next.entryPrincipal + next.fees;
  next.pnl = next.paid - next.risked;
  next.roi = next.risked > 0 ? next.pnl / next.risked : null;
  next.feesComplete = true;
  next.netQuantity = 0;
  next.status = 'confirmed';
  next.verification = 'user_confirmed';
  next.reviewReason = null;
  next.correctionVersion = Number(next.correctionVersion || 0) + 1;
  next.version = Number(next.version || 0) + 1;
  next.reviewedAt = new Date().toISOString();
  next.updatedAt = next.reviewedAt;
  next.auditTrail = [
    ...(Array.isArray(next.auditTrail) ? next.auditTrail : []),
    {
      at: next.reviewedAt,
      action: 'user_confirmed',
      version: next.version,
      correctionVersion: next.correctionVersion,
    },
  ];
  return { ok: true, record: next };
}

function newYorkCalendarDate(value) {
  const parsed = timestamp(value);
  if (!Number.isFinite(parsed)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(parsed));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return byType.year && byType.month && byType.day
    ? `${byType.year}-${byType.month}-${byType.day}`
    : null;
}

function createReconciler({
  store,
  readEvidence,
  resolveSettlements,
  enrichCaptureResult,
  onBeforeAccountWrite,
  onAfterAccountWrite,
  intervalMs = 60_000,
  logger = console,
  ownerId = `${process.pid}-${crypto.randomUUID()}`,
} = {}) {
  let timer = null;
  let running = false;
  async function notifyAccountWrite(callback, context, label) {
    if (typeof callback !== 'function') return;
    try {
      await callback(context);
    } catch (error) {
      logger.warn?.(`[Prediction P&L] ${label} callback failed for ${context.accountId}: ${error.message}`);
    }
  }
  async function reconcileAccount(accountId) {
    if (!accountId || typeof readEvidence !== 'function') return { status: 'account_required' };
    try {
      const leased = await store.acquireLease(accountId, ownerId, { leaseMs: Math.max(120_000, intervalMs * 2) });
      if (!leased) return { status: 'leased_elsewhere' };
      const evidence = await readEvidence(accountId);
      const existingRecords = await queryOperationalAccountRecords(store, accountId);
      const priorHealth = existingRecords.find((record) => record.itemType === 'health' && record.recordKey === HEALTH_KEY);
      const hasActiveLifecycle = existingRecords.some((record) => record.itemType === 'lifecycle' && ACTIVE_STATUSES.has(record.status));
      const observedAt = evidence.fetchedAt || evidence.fetched_at || new Date().toISOString();
      const priorCaptureDay = newYorkCalendarDate(priorHealth?.lastSuccessfulCaptureAt);
      const observedDay = newYorkCalendarDate(observedAt);
      const priorCaptureTime = timestamp(priorHealth?.lastSuccessfulCaptureAt);
      const observedTime = timestamp(observedAt);
      const cadenceContinuous = Number.isFinite(priorCaptureTime)
        && Number.isFinite(observedTime)
        && observedTime >= priorCaptureTime
        && observedTime - priorCaptureTime <= Math.max(intervalMs * 3, 180_000);
      const captureWindowContinuous = !hasActiveLifecycle
        || (priorCaptureDay && observedDay && priorCaptureDay === observedDay)
        || cadenceContinuous;
      const historyOnly = evidence.evidenceMode === 'history_only';
      const result = reconcileEvidence({
        accountId,
        positions: evidence.positions || [],
        executions: evidence.executions || [],
        positionsPayload: evidence.positionsPayload || evidence,
        executionsPayload: evidence.executionsPayload || evidence,
        existingRecords,
        allowClosureInference: !historyOnly && captureWindowContinuous,
        // An execution-only Flex import is authoritative for the executions
        // it contains, but silence is not proof that a disconnected account
        // is flat. Preserve active lifecycle state until live positions return.
        closureBlockedReason: historyOnly || captureWindowContinuous
          ? null
          : 'capture_gap_requires_review',
      });
      if (result.status === 'captured') {
        if (typeof enrichCaptureResult === 'function') {
          await enrichCaptureResult({ accountId, result, existingRecords, evidence, observedAt });
        }
        const healthStatus = historyOnly ? 'history_only' : 'capturing';
        const health = store.healthItem(accountId, healthStatus, {
          snapshotId: evidence.snapshotId || evidence.snapshot_id || null,
          positionCount: evidence.positionCount ?? evidence.positions?.length,
          executionCount: evidence.executionCount ?? evidence.executions?.length,
          evidenceMode: evidence.evidenceMode || (historyOnly ? 'history_only' : 'live_plus_history'),
          historyThrough: evidence.authoritativeThrough || null,
          liveConnected: !historyOnly && evidence.liveConnected !== false,
          lastSuccessfulCaptureAt: historyOnly ? priorHealth?.lastSuccessfulCaptureAt || null : observedAt,
        }, observedAt);
        await notifyAccountWrite(onBeforeAccountWrite, {
          accountId,
          status: healthStatus,
          result,
          health,
        }, 'before-write');
        await persistCaptureEntries(store, result.writeEntries || [], health);
        if (typeof resolveSettlements === 'function') {
          await resolveSettlements({
            accountId,
            records: (result.records || []).filter((record) => record.itemType === 'lifecycle'),
            existingRecords,
            evidenceMode: evidence.evidenceMode || null,
            authoritativeThrough: evidence.authoritativeThrough || null,
          });
        }
        await notifyAccountWrite(onAfterAccountWrite, {
          accountId,
          status: healthStatus,
          result,
          health,
        }, 'after-write');
      } else {
        await notifyAccountWrite(onBeforeAccountWrite, {
          accountId,
          status: 'capture_paused',
          result,
        }, 'before-write');
        await store.writeHealth(accountId, 'capture_paused', {
          reason: result.reason,
          message: evidence.message || 'Fresh, complete IBKR evidence is unavailable.',
          snapshotId: evidence.snapshotId || evidence.snapshot_id || null,
        });
        await notifyAccountWrite(onAfterAccountWrite, {
          accountId,
          status: 'capture_paused',
          result,
        }, 'after-write');
      }
      return result;
    } catch (error) {
      logger.warn?.(`[Prediction P&L] account ${accountId} reconciliation paused: ${error.message}`);
      try {
        await notifyAccountWrite(onBeforeAccountWrite, {
          accountId,
          status: 'capture_paused',
          error,
        }, 'before-write');
        await store.writeHealth(accountId, 'capture_paused', {
          reason: error.code || 'reconciliation_error',
          message: error.message || 'Prediction-market capture is unavailable.',
        });
        await notifyAccountWrite(onAfterAccountWrite, {
          accountId,
          status: 'capture_paused',
          error,
        }, 'after-write');
      } catch (_) {
        // A ledger outage is already represented by the failed API read. Do
        // not replace it with an in-memory health fallback.
      }
      return { status: 'capture_paused', reason: error.code || error.message };
    }
  }
  async function reconcileAccounts(accountIds = []) {
    if (running) return { status: 'busy' };
    running = true;
    try {
      await store.registerManagedAccounts(accountIds);
      const results = {};
      for (const accountId of [...new Set(accountIds.filter(Boolean))]) results[accountId] = await reconcileAccount(accountId);
      return { status: 'complete', results };
    } finally {
      running = false;
    }
  }
  async function runOnce(getAccounts) {
    let accounts;
    try {
      accounts = typeof getAccounts === 'function' ? await getAccounts() : [];
    } catch (error) {
      logger.warn?.(`[Prediction P&L] live managed-account discovery failed: ${error.message}`);
      accounts = typeof store.listRegisteredManagedAccounts === 'function'
        ? await store.listRegisteredManagedAccounts()
        : [];
    }
    return reconcileAccounts(accounts);
  }
  function start(getAccounts) {
    if (timer) return;
    const tick = async () => {
      try {
        await runOnce(getAccounts);
      } catch (error) {
        logger.warn?.(`[Prediction P&L] background reconciliation failed: ${error.message}`);
      }
    };
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }
  return { reconcileAccount, reconcileAccounts, runOnce, start, stop };
}

module.exports = {
  ACTIVE_STATUSES,
  applyContractSchedule,
  DEFAULT_RETENTION_SECONDS,
  DEFAULT_TABLE_NAME,
  DISPLAY_STATUSES,
  EXECUTION_PREFIX,
  FORECASTEX_EXCHANGE_FEE_PER_CONTRACT,
  FORECASTEX_LEDGER_MODEL_VERSION,
  HEALTH_KEY,
  IMPORT_PREFIX,
  LEASE_KEY,
  LIFECYCLE_PREFIX,
  MICROS_PER_DOLLAR,
  REVISION_PREFIX,
  SCHEDULE_REPAIR_REASONS,
  SYSTEM_ACCOUNT_ID,
  applyReviewPatch,
  buildContractLabel,
  contractIdentity,
  createLedgerStore,
  createReconciler,
  createRevisionRecord,
  createSnapshotLifecycle,
  displayStateFromRecord,
  finalizeLifecycle,
  forecastExComcoIdentity,
  forecastExCpiIdentity,
  forecastExLastTradingAt,
  forecastExThresholdIdentity,
  repairLegacyFesDateIdentity,
  isPredictionMarketEvidence,
  isVerifiedLiveEvidence,
  hasSupportedContractIdentity,
  ibkrFlexSettlementPayout,
  lifecycleFill,
  loadPerformance,
  loadPerformanceExecutions,
  normalizeExecution,
  normalizeMarket,
  PERFORMANCE_MARKET_KEYS,
  performanceSummaryKeys,
  requestedPerformanceMarket,
  emptyPerformanceSummary,
  normalizeActivePerformanceRow,
  normalizePerformanceRow,
  newYorkCalendarDate,
  persistCaptureEntries,
  publishedRevisions,
  REVIEW_STATUSES,
  reconcileEvidence,
  reconstructForecastExEconomicRecords,
  PAIRED_OFFSET_COMPONENT_STATUS,
  deserializeLedgerItem,
  serializeLedgerItem,
  sortPerformanceRows,
  summarizeRows,
  timestamp,
  toMoneyMicros,
  fromMoneyMicros,
};
