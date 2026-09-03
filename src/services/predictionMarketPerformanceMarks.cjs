const {
  forecastExThresholdIdentity,
} = require('./predictionMarketPerformanceLedger.cjs');
const { CONTRACT_REGISTRY } = require('./predictionMarketTest/registry.cjs');

const DEFAULT_LIVE_MARK_MAX_AGE_MS = 120_000;
const DEFAULT_CLOSING_TRADE_MAX_GAP_MS = 24 * 60 * 60 * 1000;
const MONEY_DECIMALS = 6;

function finite(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
  const number = finite(value);
  return number == null ? null : Number(number.toFixed(MONEY_DECIMALS));
}

function exactKalshiMarketTicker(record = {}) {
  const candidates = [
    record.contractKey,
    record.localSymbol,
    record.ticker,
    record.description,
    record.contractDescription,
    record.eventTicker,
    record.positionSnapshotEvidence?.description,
  ]
    .map((value) => String(value || '').trim().toUpperCase().replace(/_/g, '-'))
    .filter(Boolean);
  for (const candidate of candidates) {
    const withoutSide = candidate.replace(/-(?:YES|NO)$/, '');
    if (/^KX[A-Z0-9]+-[A-Z0-9]+-[A-Z]?-?\d+(?:\.\d+)?$/.test(withoutSide)) return withoutSide;
  }
  return null;
}

function directContractPrice(value) {
  const number = finite(value);
  return number != null && number >= 0 && number <= 1 ? number : null;
}

function normalizedSide(value) {
  const side = String(value || '').trim().toUpperCase();
  return side === 'YES' || side === 'NO' ? side : null;
}

function validTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function datePart(value) {
  const raw = String(value || '').trim();
  const calendar = raw.match(/^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/);
  if (calendar) {
    const candidate = `${calendar[1]}-${calendar[2]}-${calendar[3]}`;
    const parsed = Date.parse(`${candidate}T00:00:00Z`);
    if (Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === candidate) return candidate;
  }
  const compact = raw.match(/^(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function markResult({
  price,
  state,
  source,
  observedAt,
  contractTicker,
  dataDate = null,
  settlementDate = null,
  settlementValue = null,
  settlementValueSource = null,
  sourceUrl = null,
  sourceHash = null,
} = {}) {
  const normalizedPrice = directContractPrice(price);
  if (normalizedPrice == null || !validTimestamp(observedAt)) return null;
  const normalizedSettlementValue = finite(settlementValue);
  return {
    price: normalizedPrice,
    state,
    source,
    observedAt: new Date(Date.parse(observedAt)).toISOString(),
    contractTicker: contractTicker || null,
    dataDate,
    settlementDate: datePart(settlementDate),
    settlementValue: normalizedSettlementValue,
    settlementValueSource: normalizedSettlementValue == null ? null : settlementValueSource,
    sourceUrl,
    sourceHash,
  };
}

function addUtcDays(value, days) {
  const date = datePart(value);
  if (!date) return null;
  const timestamp = Date.parse(`${date}T00:00:00Z`) + Number(days) * 24 * 60 * 60 * 1000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function trustedForecastExSnapshot(snapshot, dataDate) {
  if (snapshot?.ok !== true
    || snapshot?.source !== 'forecastex_official_prices'
    || snapshot?.snapshotType !== 'settled_outcome_candidates'
    || snapshot?.dataDate !== dataDate
    || !/^[a-f0-9]{64}$/i.test(String(snapshot?.sha256 || ''))) return false;
  try {
    return /(^|\.)forecastex\.com$/i.test(new URL(snapshot.url).hostname);
  } catch (_error) {
    return false;
  }
}

function trustedForecastExSchedule(schedule, identity) {
  if (schedule?.ok !== true
    || schedule?.venue !== 'ForecastEx'
    || schedule?.source !== 'forecastex_official_contract_api'
    || String(schedule?.productCode || '').toUpperCase() !== identity?.productCode
    || String(schedule?.eventTicker || '').toUpperCase() !== identity?.eventContract
    || datePart(schedule?.eventDate) !== identity?.resolutionDate
    || finite(schedule?.strike) !== finite(identity?.strike)
    || !/^[a-f0-9]{64}$/i.test(String(schedule?.sourceHash || ''))) return false;
  const lastTradeAt = validTimestamp(schedule.lastTradeAt);
  const resolutionAt = validTimestamp(schedule.resolutionAt);
  const payoutAt = validTimestamp(schedule.payoutAt);
  if (lastTradeAt == null || resolutionAt == null || payoutAt == null
    || lastTradeAt >= resolutionAt || resolutionAt > payoutAt) return false;
  if (identity.productCode === 'FES'
    && !/^ES[HMUZ]\d{2}$/.test(String(schedule?.settlementSymbol || '').trim().toUpperCase())) return false;
  try {
    const source = new URL(schedule.sourceUrl);
    const rules = new URL(schedule.rulesUrl);
    return /(^|\.)forecastex\.com$/i.test(source.hostname)
      && rules.hostname.toLowerCase() === 'data.forecastex.com'
      && rules.pathname.toLowerCase() === '/regulatory/festermsandconditions.pdf';
  } catch (_error) {
    return false;
  }
}

function resolverOutcomePrice(identity, side, isYes) {
  if (!identity || !['YES', 'NO'].includes(side) || typeof isYes !== 'boolean') return null;
  const heldSideWon = side === 'YES' ? isYes : !isYes;
  return heldSideWon ? 1 : 0;
}

function verifiedResolverSettlement(record = {}, observations = []) {
  const identity = forecastExThresholdIdentity(record);
  if (!identity) return null;
  const registered = CONTRACT_REGISTRY.find((product) => (
    product.id === identity.market
    && product.resolutionDate === identity.resolutionDate
    && product.venues?.some((venue) => venue.venue === 'ForecastEx' && venue.productCode === identity.productCode)
  ));
  const expectedSymbol = String(record.settlementSymbol || registered?.resolver?.contractSymbol || '').trim().toUpperCase();
  if (!expectedSymbol) return null;
  const candidates = (observations || []).filter((observation) => (
    observation?.role === 'resolver'
    && observation?.availability === 'official_final'
    && observation?.final === true
    && ['databento_glbx_mdp3_statistics', 'cme_daily_bulletin_final'].includes(observation?.source)
    && String(observation?.productCode || '').toUpperCase() === identity.productCode
    && String(observation?.market || '') === identity.market
    && datePart(observation?.tradingDate || observation?.eventDate) === identity.resolutionDate
    && String(observation?.symbol || '').trim().toUpperCase() === expectedSymbol
    && finite(observation?.value) != null
    && validTimestamp(observation?.asOf) != null
    && (observation?.source !== 'cme_daily_bulletin_final' || (
      /(^|\.)cmegroup\.com$/i.test((() => {
        try { return new URL(observation.sourceUrl).hostname; } catch (_error) { return ''; }
      })())
      && /^[a-f0-9]{64}$/i.test(String(observation.sourceHash || ''))
    ))
  ));
  const matches = identity.productCode === 'FES'
    ? candidates.filter((observation) => observation.source === 'cme_daily_bulletin_final')
    : candidates;
  if (matches.length !== 1) return null;
  const observation = matches[0];
  return {
    value: finite(observation.value),
    source: observation.source,
    sourceUrl: observation.sourceUrl || null,
    sourceHash: observation.sourceHash || null,
    observedAt: new Date(validTimestamp(observation.asOf)).toISOString(),
    status: 'official_final',
    symbol: observation.symbol || null,
    tradingDate: identity.resolutionDate,
    productCode: identity.productCode,
  };
}

function applyResolverSettlementDetails(rows = [], observations = []) {
  return (rows || []).map((row) => {
    if (finite(row?.settlementValue) != null) return row;
    const settlement = verifiedResolverSettlement(row, observations);
    if (!settlement) return row;
    return {
      ...row,
      settlementValue: settlement.value,
      settlementValueSource: settlement.source,
      settlementValueObservedAt: settlement.observedAt,
      settlementValueStatus: settlement.status,
      settlementValueSymbol: settlement.symbol,
      settlementSymbol: row.settlementSymbol || settlement.symbol,
      resolverAvailability: 'official_final',
      resolverSource: settlement.source,
      resolverObservedAt: settlement.observedAt,
      resolverSourceUrl: settlement.sourceUrl,
      resolver: {
        availability: 'official_final',
        symbol: row.settlementSymbol || settlement.symbol,
        value: settlement.value,
        source: settlement.source,
        sourceUrl: settlement.sourceUrl,
        observedAt: settlement.observedAt,
      },
    };
  });
}

function verifiedPreliminaryResolverReference(record = {}, observations = []) {
  const identity = forecastExThresholdIdentity(record);
  if (identity?.productCode !== 'FES') return null;
  const expectedSymbol = String(record.settlementSymbol || '').trim().toUpperCase();
  const expectedCutoff = validTimestamp(record.lastTradeAt);
  if (!expectedSymbol || expectedCutoff == null) return null;
  const matches = (observations || []).filter((observation) => {
    const value = finite(observation?.value);
    const open = finite(observation?.windowOpen);
    const high = finite(observation?.windowHigh);
    const low = finite(observation?.windowLow);
    const close = finite(observation?.windowClose);
    const barStart = validTimestamp(observation?.barStartAt);
    const cutoff = validTimestamp(observation?.cutoffAt);
    const asOf = validTimestamp(observation?.asOf);
    const provenance = [
      observation?.source,
      observation?.provider,
      observation?.warning,
      observation?.cacheState,
      observation?.provenance,
    ].filter(Boolean).join(' ');
    return observation?.role === 'resolver_reference'
      && observation?.availability === 'preliminary_reference'
      && observation?.final === false
      && observation?.complete === true
      && observation?.source === 'ibkr_exact_cutoff_bar'
      && observation?.provider === 'ibkr'
      && !/delayed|frozen|stale|cache|mock|seed|fallback|offline|disconnected|synthetic/i.test(provenance)
      && String(observation?.productCode || '').toUpperCase() === 'FES'
      && String(observation?.eventContract || '').toUpperCase() === identity.eventContract.toUpperCase()
      && datePart(observation?.tradingDate) === identity.resolutionDate
      && String(observation?.symbol || '').trim().toUpperCase() === expectedSymbol
      && [value, open, high, low, close].every((candidate) => candidate != null)
      && high >= low
      && open >= low && open <= high
      && close >= low && close <= high
      && Math.abs(value - close) <= Number.EPSILON
      && barStart != null
      && cutoff === expectedCutoff
      && cutoff - barStart === 60_000
      && asOf != null
      && asOf >= cutoff;
  });
  if (matches.length !== 1) return null;
  const observation = matches[0];
  return {
    value: finite(observation.value),
    windowOpen: finite(observation.windowOpen),
    windowHigh: finite(observation.windowHigh),
    windowLow: finite(observation.windowLow),
    windowClose: finite(observation.windowClose),
    barStartAt: new Date(validTimestamp(observation.barStartAt)).toISOString(),
    cutoffAt: new Date(expectedCutoff).toISOString(),
    observedAt: new Date(validTimestamp(observation.asOf)).toISOString(),
    symbol: observation.symbol,
    source: observation.source,
    provider: observation.provider,
    provenance: observation.provenance || 'verified_ibkr_historical_trade_bar',
  };
}

function applyPreliminaryResolverReferences(rows = [], observations = []) {
  return (rows || []).map((row) => {
    if (finite(row?.settlementValue) != null || ['verified', 'confirmed'].includes(String(row?.status || '').toLowerCase())) return row;
    const reference = verifiedPreliminaryResolverReference(row, observations);
    if (!reference) return row;
    const strike = finite(row.strike);
    const contractSide = normalizedSide(row.contractSide);
    let outcome = null;
    if (strike != null && reference.windowHigh <= strike) outcome = 'NO';
    else if (strike != null && reference.windowLow > strike) outcome = 'YES';
    const payoutPerContract = outcome && contractSide ? (outcome === contractSide ? 1 : 0) : null;
    const entryQuantity = finite(row.entryQuantity ?? row.quantity);
    const remainingQuantity = finite(row.remainingQuantity ?? row.quantity);
    const entryCost = finite(row.entryCost ?? row.risked);
    const netExitProceeds = finite(row.netExitProceeds ?? row.paid) || 0;
    const remainingPayout = payoutPerContract == null || remainingQuantity == null
      ? null
      : roundMoney(remainingQuantity * payoutPerContract);
    const currentValue = remainingPayout == null ? null : roundMoney(netExitProceeds + remainingPayout);
    const pnl = currentValue == null || entryCost == null ? null : roundMoney(currentValue - entryCost);
    const holdToExpiryPnl = payoutPerContract == null || entryQuantity == null || entryCost == null
      ? null
      : roundMoney(entryQuantity * payoutPerContract - entryCost);
    const savedVsHold = pnl == null || holdToExpiryPnl == null ? null : roundMoney(pnl - holdToExpiryPnl);
    return {
      ...row,
      currentValue,
      pnl,
      roi: pnl != null && entryCost > 0 ? pnl / entryCost : null,
      remainingPayout,
      holdToExpiryPnl,
      savedVsHold,
      valuationStatus: outcome ? 'preliminary' : 'pending_overlap',
      preliminaryReferenceValue: reference.value,
      preliminaryReferenceWindowOpen: reference.windowOpen,
      preliminaryReferenceWindowHigh: reference.windowHigh,
      preliminaryReferenceWindowLow: reference.windowLow,
      preliminaryReferenceWindowClose: reference.windowClose,
      preliminaryReferenceBarStartAt: reference.barStartAt,
      preliminaryReferenceCutoffAt: reference.cutoffAt,
      preliminaryReferenceObservedAt: reference.observedAt,
      preliminaryOutcome: outcome,
      preliminaryPayoutPerContract: payoutPerContract,
      preliminaryReferenceSource: reference.source,
      preliminaryReferenceProvenance: reference.provenance,
      resolverAvailability: 'preliminary_reference',
      resolver: {
        availability: 'preliminary_reference',
        symbol: row.settlementSymbol || reference.symbol,
        value: null,
        source: null,
        sourceUrl: null,
        observedAt: null,
        preliminaryReferenceValue: reference.value,
        preliminaryWindowHigh: reference.windowHigh,
        preliminaryWindowLow: reference.windowLow,
        preliminaryCutoffAt: reference.cutoffAt,
        preliminaryOutcome: outcome,
        preliminarySource: reference.source,
        preliminaryObservedAt: reference.observedAt,
        preliminaryProvenance: reference.provenance,
      },
      // A cutoff reference is an underlying price, never a binary contract mark.
      markPrice: null,
      markState: 'unavailable',
      markSource: null,
      markObservedAt: null,
    };
  });
}

function buildPredictionMarketMarkProviders({
  kalshiFetch,
  loadOfficialForecastExPrices,
  now = () => new Date(),
  liveMarkMaxAgeMs = DEFAULT_LIVE_MARK_MAX_AGE_MS,
  closingTradeMaxGapMs = DEFAULT_CLOSING_TRADE_MAX_GAP_MS,
} = {}) {
  async function kalshi(record = {}) {
    if (typeof kalshiFetch !== 'function') return null;
    const ticker = exactKalshiMarketTicker(record);
    const side = normalizedSide(record.contractSide);
    if (!ticker || !side) return null;

    const response = await kalshiFetch(`/markets/${encodeURIComponent(ticker)}`);
    const market = response?.market;
    if (!market || String(market.ticker || '').toUpperCase() !== ticker) return null;
    const status = String(market.status || '').trim().toLowerCase();
    const result = String(market.result || '').trim().toUpperCase();
    const currentTime = now().getTime();

    if (['settled', 'finalized'].includes(status) && ['YES', 'NO'].includes(result)) {
      const observedAt = market.settlement_ts
        || market.settled_time
        || market.updated_time
        || market.close_time;
      return markResult({
        price: result === side ? 1 : 0,
        state: 'verified_settlement',
        source: 'kalshi_verified_settlement',
        observedAt,
        contractTicker: ticker,
        settlementDate: observedAt,
        settlementValue: market.expiration_value,
        settlementValueSource: 'kalshi_published_expiration_value',
      });
    }

    if (['open', 'active'].includes(status)) {
      const closeAt = validTimestamp(market.close_time || market.expected_expiration_time);
      const observedAt = market.updated_time;
      const observedTimestamp = validTimestamp(observedAt);
      const age = observedTimestamp == null ? Infinity : currentTime - observedTimestamp;
      if (closeAt != null && closeAt <= currentTime) return null;
      if (age < -5_000 || age > liveMarkMaxAgeMs) return null;
      return markResult({
        price: market[`${side.toLowerCase()}_bid_dollars`],
        state: 'live_bid',
        source: 'kalshi_direct_bid',
        observedAt,
        contractTicker: ticker,
        settlementDate: market.expected_expiration_time || market.expiration_time,
      });
    }

    if (status !== 'closed') return null;
    const tradesResponse = await kalshiFetch('/markets/trades', { ticker, limit: 1 });
    const trade = (tradesResponse?.trades || [])
      .filter((candidate) => String(candidate?.ticker || '').toUpperCase() === ticker)
      .sort((left, right) => Date.parse(right.created_time || 0) - Date.parse(left.created_time || 0))[0];
    if (!trade) return null;
    const observedTimestamp = validTimestamp(trade.created_time);
    const closeTimestamp = validTimestamp(market.close_time || market.expected_expiration_time);
    if (observedTimestamp == null || closeTimestamp == null) return null;
    if (observedTimestamp > closeTimestamp + 5_000 || closeTimestamp - observedTimestamp > closingTradeMaxGapMs) return null;
    return markResult({
      price: trade[`${side.toLowerCase()}_price_dollars`],
      state: 'closing_trade',
      source: 'kalshi_direct_closing_trade',
      observedAt: trade.created_time,
      contractTicker: ticker,
      settlementDate: market.expected_expiration_time || market.expiration_time,
    });
  }

  async function forecastex(record = {}) {
    if (typeof loadOfficialForecastExPrices !== 'function') return null;
    const identity = forecastExThresholdIdentity(record);
    const side = normalizedSide(record.contractSide);
    if (!identity || !side || identity.contractSide !== side) return null;
    const currentDate = now().toISOString().slice(0, 10);
    const postResolutionDates = Array.from({ length: 8 }, (_unused, offset) => (
      addUtcDays(identity.resolutionDate, offset)
    )).filter((date) => date && date <= currentDate);
    const dates = [...new Set([currentDate, ...postResolutionDates].filter(Boolean))];
    for (const dataDate of dates) {
      let snapshot;
      try {
        snapshot = await loadOfficialForecastExPrices({ dataDate });
      } catch (error) {
        if (error?.code === 'FORECASTEX_PRICES_NOT_PUBLISHED') continue;
        throw error;
      }
      if (snapshot?.ok !== true
        || snapshot?.source !== 'forecastex_official_prices'
        || snapshot?.snapshotType !== 'settled_outcome_candidates'
        || snapshot?.dataDate !== dataDate) continue;
      const eventRows = (snapshot.rows || []).filter((row) => (
        String(row.eventContract || '').toUpperCase() === identity.eventContract.toUpperCase()
      ));
      const heldRows = eventRows.filter((row) => String(row.subtype || '').toUpperCase() === side);
      if (heldRows.length !== 1) continue;
      const row = heldRows[0];
      const price = directContractPrice(row.settlementPrice);
      if (price == null) continue;
      const expirationTimestamp = validTimestamp(row.expirationDate);
      const binaryPair = eventRows.length === 2
        && new Set(eventRows.map((candidate) => String(candidate.subtype || '').toUpperCase())).size === 2
        && eventRows.every((candidate) => directContractPrice(candidate.settlementPrice) === 0
          || directContractPrice(candidate.settlementPrice) === 1)
        && eventRows.reduce((sum, candidate) => sum + directContractPrice(candidate.settlementPrice), 0) === 1;
      const final = binaryPair
        && expirationTimestamp != null
        && expirationTimestamp <= now().getTime()
        && (price === 0 || price === 1);
      return markResult({
        price,
        state: final ? 'verified_settlement' : 'official_reference',
        source: final ? 'forecastex_verified_settlement' : 'forecastex_official_price',
        observedAt: snapshot.fetchedAt,
        contractTicker: `${identity.eventContract}_${side}`,
        dataDate,
        settlementDate: row.expirationDate,
        sourceUrl: snapshot.url || null,
        sourceHash: snapshot.sha256 || null,
      });
    }
    return null;
  }

  return { forecastex, kalshi };
}

async function resolveForecastExOfficialSettlementMarks(
  records = [],
  {
    loadOfficialForecastExPrices,
    loadContractSchedule,
    getResolverSettlements,
    now = () => new Date(),
  } = {},
) {
  const requested = Array.isArray(records) ? records.slice(0, 100) : [];
  const currentTime = now();
  const currentTimestamp = currentTime.getTime();
  const currentDate = currentTime.toISOString().slice(0, 10);
  const snapshotPromises = new Map();
  const schedulePromises = new Map();
  const memoizedLoader = async ({ dataDate }) => {
    if (!snapshotPromises.has(dataDate)) {
      snapshotPromises.set(dataDate, Promise.resolve().then(() => (
        loadOfficialForecastExPrices({ dataDate })
      )));
    }
    const snapshot = await snapshotPromises.get(dataDate);
    if (!trustedForecastExSnapshot(snapshot, dataDate)) {
      const error = new Error('ForecastEx official settlement evidence was not authoritative.');
      error.code = 'FORECASTEX_SETTLEMENT_EVIDENCE_UNVERIFIED';
      throw error;
    }
    return snapshot;
  };
  const providers = buildPredictionMarketMarkProviders({
    loadOfficialForecastExPrices: typeof loadOfficialForecastExPrices === 'function'
      ? memoizedLoader
      : null,
    now,
  });

  const prepared = await Promise.all(requested.map(async (record, index) => {
    const identity = forecastExThresholdIdentity(record);
    const side = normalizedSide(record?.contractSide || record?.eventContractSide);
    const base = {
      requestIndex: index,
      conId: record?.conId ?? null,
      localSymbol: record?.localSymbol || record?.contractKey || null,
      eventContract: identity?.eventContract || null,
      contractSide: side,
      resolutionDate: identity?.resolutionDate || null,
    };
    if (!identity || !side || identity.contractSide !== side) {
      return { record, identity, side, base, result: { ...base, status: 'unavailable', reason: 'contract_identity_unverified' } };
    }
    let schedule = null;
    if (typeof loadContractSchedule === 'function') {
      try {
        if (!schedulePromises.has(identity.eventContract)) {
          schedulePromises.set(identity.eventContract, Promise.resolve().then(() => loadContractSchedule({
            ...record,
            contractKey: record?.contractKey || `${identity.eventContract}_${side}`,
            contractSide: side,
            contractRule: 'above',
            strike: identity.strike,
          })));
        }
        const candidate = await schedulePromises.get(identity.eventContract);
        if (trustedForecastExSchedule(candidate, identity)) schedule = candidate;
      } catch (_error) {
        schedule = null;
      }
    }
    const exactCloseAt = validTimestamp(schedule?.lastTradeAt);
    if ((exactCloseAt != null && currentTimestamp < exactCloseAt)
      || (exactCloseAt == null && (!identity.resolutionDate || identity.resolutionDate >= currentDate))) {
      return { record, identity, side, base, schedule, result: { ...base, status: 'active', reason: null } };
    }
    return {
      record: {
        ...record,
        status: record?.status || 'awaiting_resolution',
        contractKey: record?.contractKey || `${identity.eventContract}_${side}`,
        eventTicker: identity.eventContract,
        contractSide: side,
        contractRule: 'above',
        strike: identity.strike,
        settlementSymbol: schedule?.settlementSymbol || record?.settlementSymbol || null,
        lastTradeAt: schedule?.lastTradeAt || record?.lastTradeAt || null,
        resolutionAt: schedule?.resolutionAt || record?.resolutionAt || null,
        payoutAt: schedule?.payoutAt || record?.payoutAt || null,
      },
      identity,
      side,
      base,
      schedule,
      result: null,
    };
  }));

  await Promise.all(prepared.map(async (entry) => {
    if (entry.result) return;
    try {
      const mark = await providers.forecastex(entry.record);
      const verified = mark?.state === 'verified_settlement'
        && mark?.source === 'forecastex_verified_settlement'
        && (mark.price === 0 || mark.price === 1)
        && trustedForecastExSnapshot({
          ok: true,
          source: 'forecastex_official_prices',
          snapshotType: 'settled_outcome_candidates',
          dataDate: mark.dataDate,
          url: mark.sourceUrl,
          sha256: mark.sourceHash,
        }, mark.dataDate);
      if (!verified) {
        return;
      }
      entry.result = {
        ...entry.base,
        status: 'verified_settlement',
        reason: null,
        settlementPrice: mark.price,
        settlementSource: mark.source,
        settlementObservedAt: mark.observedAt,
        settlementDataDate: mark.dataDate,
        settlementDate: mark.settlementDate,
        settlementSourceUrl: mark.sourceUrl,
        settlementSourceHash: mark.sourceHash,
      };
    } catch (_error) {
      // The venue's final complementary pair commonly publishes after the
      // exact resolver observation. Continue to the resolver evidence below.
    }
  }));

  const resolverEntries = prepared.filter((entry) => (
    !entry.result
    && entry.identity?.productCode === 'FES'
    && trustedForecastExSchedule(entry.schedule, entry.identity)
  ));
  let resolverObservations = [];
  if (resolverEntries.length && typeof getResolverSettlements === 'function') {
    try {
      const observations = await getResolverSettlements({
        records: resolverEntries.map((entry) => entry.record),
      });
      if (Array.isArray(observations)) resolverObservations = observations;
    } catch (_error) {
      resolverObservations = [];
    }
  }

  resolverEntries.forEach((entry) => {
    const official = verifiedResolverSettlement(entry.record, resolverObservations);
    if (official) {
      const price = resolverOutcomePrice(
        entry.identity,
        entry.side,
        official.value > entry.identity.strike,
      );
      if (price != null) {
        entry.result = {
          ...entry.base,
          status: 'verified_settlement',
          reason: null,
          settlementPrice: price,
          settlementSource: official.source,
          settlementObservedAt: official.observedAt,
          settlementDataDate: official.tradingDate,
          settlementDate: official.tradingDate,
          settlementSourceUrl: official.sourceUrl,
          settlementSourceHash: official.sourceHash,
          settlementValue: official.value,
          settlementSymbol: official.symbol,
          settlementBasis: 'official_resolver_outcome',
        };
        return;
      }
    }

    const reference = verifiedPreliminaryResolverReference(entry.record, resolverObservations);
    if (!reference) return;
    const strike = finite(entry.identity.strike);
    const isYes = reference.windowLow > strike
      ? true
      : reference.windowHigh <= strike
        ? false
        : null;
    const price = resolverOutcomePrice(entry.identity, entry.side, isYes);
    if (price == null) return;
    entry.result = {
      ...entry.base,
      status: 'resolver_determined',
      reason: 'official_settlement_pending',
      valuationPrice: price,
      valuationSource: reference.source,
      valuationObservedAt: reference.observedAt,
      resolverValue: reference.value,
      resolverSymbol: reference.symbol,
      resolverWindowHigh: reference.windowHigh,
      resolverWindowLow: reference.windowLow,
      resolverCutoffAt: reference.cutoffAt,
      resolverSource: reference.source,
      resolverProvenance: reference.provenance,
      finalSettlementPending: true,
    };
  });

  return prepared.map((entry) => entry.result || {
    ...entry.base,
    status: 'awaiting_settlement',
    reason: entry.schedule ? 'official_settlement_not_published' : 'official_settlement_unavailable',
  });
}

function providerForRecord(record = {}, providers = {}) {
  const source = [record.exchange, record.contractKey, record.eventTicker]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
  if (/\b(?:COMCO|METLG|FES)[_-]/.test(source)) return providers.forecastex;
  if (/\bKX[A-Z0-9]+[-_]/.test(source)) return providers.kalshi;
  return null;
}

function applyContractMark(record = {}, mark = null) {
  const risked = finite(record.risked);
  const paid = finite(record.paid) || 0;
  const quantity = finite(record.quantity ?? record.netQuantity);
  if (!mark || risked == null || quantity == null || quantity < 0) {
    return {
      ...record,
      currentValue: null,
      pnl: null,
      roi: null,
      markPrice: null,
      markState: 'unavailable',
      markSource: null,
      markObservedAt: null,
      settlementDate: record.settlementDate || null,
      settlementValue: finite(record.settlementValue),
      settlementValueSource: record.settlementValueSource || null,
      settlementValueObservedAt: record.settlementValueObservedAt || null,
      settlementValueStatus: record.settlementValueStatus || null,
    };
  }
  const openValue = roundMoney(quantity * mark.price);
  const currentValue = roundMoney(paid + openValue);
  const pnl = roundMoney(currentValue - risked);
  return {
    ...record,
    currentValue,
    pnl,
    roi: risked > 0 ? pnl / risked : null,
    markPrice: mark.price,
    markState: mark.state,
    markSource: mark.source,
    markObservedAt: mark.observedAt,
    markContractTicker: mark.contractTicker,
    markDataDate: mark.dataDate,
    settlementDate: mark.settlementDate || record.settlementDate || null,
    settlementValue: finite(mark.settlementValue) ?? finite(record.settlementValue),
    settlementValueSource: mark.settlementValueSource || record.settlementValueSource || null,
    settlementValueObservedAt: mark.settlementValue == null ? (record.settlementValueObservedAt || null) : mark.observedAt,
    settlementValueStatus: mark.settlementValue == null ? (record.settlementValueStatus || null) : 'official_final',
  };
}

async function markActivePerformanceRows(rows = [], providers = {}) {
  return Promise.all((rows || []).map(async (row) => {
    const provider = providerForRecord(row, providers);
    if (typeof provider !== 'function') return applyContractMark(row, null);
    try {
      const mark = await provider(row);
      // Closed-but-unresolved ForecastEx contracts may carry the venue's exact
      // published contract price as a reversible mark-to-market estimate. The
      // lifecycle remains awaiting_resolution; only a verified complementary
      // binary pair can finalize it through the settlement provider.
      const isVerifiedBinarySettlement = mark?.state === 'verified_settlement'
        && (mark.price === 0 || mark.price === 1);
      const isOfficialForecastExReference = mark?.state === 'official_reference'
        && mark?.source === 'forecastex_official_price';
      const forecastExIdentity = forecastExThresholdIdentity(row);
      if (String(row.status || '').toLowerCase() === 'awaiting_resolution'
        && forecastExIdentity?.productCode === 'FES'
        && !isVerifiedBinarySettlement) {
        return applyContractMark(row, null);
      }
      if (String(row.status || '').toLowerCase() === 'awaiting_resolution'
        && mark
        && !isVerifiedBinarySettlement
        && !isOfficialForecastExReference) {
        return applyContractMark(row, null);
      }
      return applyContractMark(row, mark);
    } catch (_error) {
      return applyContractMark(row, null);
    }
  }));
}

function summarizeTrackedRows(rows = []) {
  const validRows = (rows || []).filter(Boolean);
  const valuedRows = validRows.filter((row) => finite(row.pnl) != null);
  const risked = roundMoney(validRows.reduce((sum, row) => sum + (finite(row.risked) || 0), 0));
  const currentValue = valuedRows.length === validRows.length
    ? roundMoney(validRows.reduce((sum, row) => sum + (finite(row.currentValue ?? row.paid) || 0), 0))
    : null;
  const pnl = valuedRows.length === validRows.length
    ? roundMoney(validRows.reduce((sum, row) => sum + finite(row.pnl), 0))
    : null;
  return {
    count: validRows.length,
    valuedCount: valuedRows.length,
    complete: valuedRows.length === validRows.length,
    risked,
    currentValue,
    pnl,
    roi: pnl != null && risked > 0 ? pnl / risked : null,
  };
}

module.exports = {
  DEFAULT_CLOSING_TRADE_MAX_GAP_MS,
  DEFAULT_LIVE_MARK_MAX_AGE_MS,
  applyContractMark,
  applyPreliminaryResolverReferences,
  applyResolverSettlementDetails,
  buildPredictionMarketMarkProviders,
  directContractPrice,
  exactKalshiMarketTicker,
  markActivePerformanceRows,
  resolveForecastExOfficialSettlementMarks,
  summarizeTrackedRows,
  verifiedPreliminaryResolverReference,
  verifiedResolverSettlement,
};
