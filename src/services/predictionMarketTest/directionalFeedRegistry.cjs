const MONTH_CODES = Object.freeze({
  1: 'F', 2: 'G', 3: 'H', 4: 'J', 5: 'K', 6: 'M',
  7: 'N', 8: 'Q', 9: 'U', 10: 'V', 11: 'X', 12: 'Z',
});

const DIRECTIONAL_FEEDS = Object.freeze({
  sp500: Object.freeze({
    marketId: 'sp500', provider: 'ibkr', root: 'ES', exchange: 'CME',
    currency: 'USD', multiplier: '50', deliveryMonths: Object.freeze([3, 6, 9, 12]),
    riskRangeTicker: 'SPX', calendar: 'us_equity',
  }),
  wti: Object.freeze({
    marketId: 'wti', provider: 'ibkr', root: 'CL', exchange: 'NYMEX',
    currency: 'USD', multiplier: '1000', deliveryMonths: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    riskRangeTicker: 'WTIC', calendar: 'weekday',
  }),
  gold: Object.freeze({
    marketId: 'gold', provider: 'ibkr', root: 'GC', exchange: 'COMEX',
    currency: 'USD', multiplier: '100', deliveryMonths: Object.freeze([2, 4, 6, 8, 10, 12]),
    riskRangeTicker: 'GLD', calendar: 'weekday',
  }),
  silver: Object.freeze({
    marketId: 'silver', provider: 'ibkr', root: 'SI', exchange: 'COMEX',
    currency: 'USD', multiplier: '5000', deliveryMonths: Object.freeze([3, 5, 7, 9, 12]),
    riskRangeTicker: 'SILVER', calendar: 'weekday',
  }),
  brent: Object.freeze({
    marketId: 'brent', provider: 'ibkr', root: 'BZ', exchange: 'NYMEX',
    currency: 'USD', multiplier: '1000', deliveryMonths: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    riskRangeTicker: 'BRENT', calendar: 'weekday',
  }),
  bitcoin: Object.freeze({
    marketId: 'bitcoin', provider: 'coinbase', productId: 'BTC-USD',
    symbol: 'BTC', resolverIndex: 'BRTI', resolverName: 'Bitcoin Real-Time Index',
    resolverSourcePath: 'BRTI',
    riskRangeTicker: 'BITCOIN', calendar: 'continuous',
  }),
  ethereum: Object.freeze({
    marketId: 'ethereum', provider: 'coinbase', productId: 'ETH-USD',
    symbol: 'ETH', resolverIndex: 'ERTI', resolverName: 'Ethereum Real-Time Index',
    resolverSourcePath: 'ETHUSD_RTI',
    riskRangeTicker: 'ETH', calendar: 'continuous',
    riskRangeSourceType: 'bitcoin-trend-tracker',
  }),
});

const FUTURES_MARKET_IDS = Object.freeze(
  Object.keys(DIRECTIONAL_FEEDS).filter((marketId) => DIRECTIONAL_FEEDS[marketId].provider === 'ibkr'),
);

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deliveryKey(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})/);
  return match ? Number(`${match[1]}${match[2]}`) : null;
}

function contractExpiryMs(candidate) {
  const raw = String(
    candidate?.lastTradeDate
      || candidate?.contract?.lastTradeDate
      || candidate?.instrument?.lastTradeDate
      || candidate?.contract?.lastTradeDateOrContractMonth
      || candidate?.instrument?.lastTradeDateOrContractMonth
      || '',
  ).trim();
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}-${match[2]}-${match[3]}T23:59:59.999Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function businessDaysUntil(fromMs, untilMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(untilMs)) return null;
  if (untilMs < fromMs) return -1;
  let cursor = new Date(fromMs);
  cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()));
  const end = new Date(untilMs);
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  let days = 0;
  while (cursor.getTime() < endDay) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}

function generateDirectionalCandidates(marketId, nowMs = Date.now(), count = 3) {
  const definition = DIRECTIONAL_FEEDS[marketId];
  if (!definition || definition.provider !== 'ibkr') return [];
  const date = new Date(nowMs);
  const startYear = date.getUTCFullYear();
  const startMonth = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const startOffset = definition.root === 'CL'
    ? (day > 15 ? 2 : 1)
    : definition.root === 'BZ' ? 3 : 0;
  const candidates = [];
  // Generate a small qualification buffer. Expired delivery months are removed
  // after IBKR returns the qualified last-trade date.
  for (let offset = startOffset; offset < 36 && candidates.length < count + 1; offset += 1) {
    const absoluteMonth = (startYear * 12) + (startMonth - 1) + offset;
    const year = Math.floor(absoluteMonth / 12);
    const month = (absoluteMonth % 12) + 1;
    if (!definition.deliveryMonths.includes(month)) continue;
    if (offset === 0 && ['GC', 'SI'].includes(definition.root) && day > 10) continue;
    const contractMonth = `${year}${String(month).padStart(2, '0')}`;
    candidates.push({
      symbol: definition.root,
      displaySymbol: `${definition.root}${MONTH_CODES[month]}${String(year).slice(-2)}`,
      ibkrSymbol: definition.root,
      secType: 'FUT',
      exchange: definition.exchange,
      currency: definition.currency,
      lastTradeDateOrContractMonth: contractMonth,
      multiplier: definition.multiplier,
      provider: 'ibkr',
      deliveryKey: Number(contractMonth),
    });
  }
  return candidates;
}

function normalizedVolumeSessions(candidate) {
  const rows = Array.isArray(candidate?.volumeSessions)
    ? candidate.volumeSessions
    : Array.isArray(candidate?.volumes) ? candidate.volumes : [];
  return rows.map((row) => ({
    date: String(row?.date || '').slice(0, 10),
    volume: finiteNumber(row?.volume),
  })).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.volume !== null && row.volume >= 0)
    .sort((left, right) => left.date.localeCompare(right.date));
}

function median(values) {
  const sorted = values.map(finiteNumber).filter((value) => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function candidateIdentity(candidate) {
  const contract = candidate?.contract || {};
  const instrument = candidate?.instrument || candidate || {};
  const conId = finiteNumber(contract.conId ?? contract.conid ?? instrument.conId ?? instrument.conid);
  const month = String(
    contract.lastTradeDateOrContractMonth
      || instrument.lastTradeDateOrContractMonth
      || '',
  ).slice(0, 6);
  return {
    conId: conId === null ? null : Math.trunc(conId),
    deliveryKey: deliveryKey(month),
  };
}

function sameContract(left, right) {
  const a = candidateIdentity(left);
  const b = candidateIdentity(right);
  if (a.conId !== null && b.conId !== null) return a.conId === b.conId;
  return a.deliveryKey !== null && a.deliveryKey === b.deliveryKey;
}

function candidateScore(candidate) {
  const sessions = normalizedVolumeSessions(candidate).slice(-3);
  return {
    ...candidate,
    volumeSessions: sessions,
    medianVolume: sessions.length === 3 ? median(sessions.map((session) => session.volume)) : null,
  };
}

function crossedForTwoSessions(current, successor) {
  const currentByDate = new Map(normalizedVolumeSessions(current).map((row) => [row.date, row.volume]));
  const successorByDate = new Map(normalizedVolumeSessions(successor).map((row) => [row.date, row.volume]));
  const commonDates = [...successorByDate.keys()]
    .filter((date) => currentByDate.has(date))
    .sort()
    .slice(-2);
  return commonDates.length === 2 && commonDates.every((date) => (
    successorByDate.get(date) >= currentByDate.get(date) * 1.2
  ));
}

function selectDirectionalContract({ candidates = [], current = null, nowMs = Date.now() } = {}) {
  const scored = candidates
    .filter((candidate) => candidate?.qualified !== false)
    .filter((candidate) => {
      const expiry = contractExpiryMs(candidate);
      return expiry === null || expiry >= nowMs;
    })
    .map(candidateScore)
    .sort((left, right) => {
      const a = candidateIdentity(left).deliveryKey ?? Number.MAX_SAFE_INTEGER;
      const b = candidateIdentity(right).deliveryKey ?? Number.MAX_SAFE_INTEGER;
      return a - b;
    });
  if (!scored.length) return { selected: current || null, changed: false, reason: current ? 'hold_no_qualified_successor' : 'no_qualified_contract' };

  const restoredCurrent = current
    ? scored.find((candidate) => sameContract(candidate, current)) || candidateScore(current)
    : null;
  if (!restoredCurrent) {
    const ranked = scored.filter((candidate) => candidate.medianVolume !== null)
      .sort((left, right) => right.medianVolume - left.medianVolume);
    const selected = ranked[0] || null;
    return {
      selected,
      changed: Boolean(selected),
      reason: selected ? 'initial_three_session_median_volume' : 'no_completed_volume_sessions',
    };
  }

  const currentKey = candidateIdentity(restoredCurrent).deliveryKey;
  const successors = scored.filter((candidate) => {
    const key = candidateIdentity(candidate).deliveryKey;
    return key !== null && currentKey !== null && key > currentKey;
  });
  const expiry = contractExpiryMs(restoredCurrent);
  const businessDays = expiry === null ? null : businessDaysUntil(nowMs, expiry);
  if (businessDays !== null && businessDays <= 5 && successors.length) {
    const ranked = [...successors].sort((left, right) => {
      if (left.medianVolume === null && right.medianVolume !== null) return 1;
      if (right.medianVolume === null && left.medianVolume !== null) return -1;
      return (right.medianVolume || 0) - (left.medianVolume || 0);
    });
    return { selected: ranked[0], changed: true, reason: 'within_five_business_days_of_last_trade' };
  }

  const crossover = successors
    .filter((candidate) => crossedForTwoSessions(restoredCurrent, candidate))
    .sort((left, right) => (right.medianVolume || 0) - (left.medianVolume || 0))[0];
  if (crossover) return { selected: crossover, changed: true, reason: 'successor_volume_20pct_two_sessions' };
  return { selected: restoredCurrent, changed: false, reason: 'sticky_volume_hysteresis' };
}

function evaluateRiskRangeBasis({
  directionalPreviousClose,
  hedgeyePreviousClose,
  lrr,
  hrr,
} = {}) {
  const directional = finiteNumber(directionalPreviousClose);
  const hedgeye = finiteNumber(hedgeyePreviousClose);
  const low = finiteNumber(lrr);
  const high = finiteNumber(hrr);
  if (directional === null || hedgeye === null || low === null || high === null || high <= low || hedgeye <= 0) {
    return {
      status: 'unavailable', display: 'hide', fit: 'unavailable', gap: null,
      gapRangeWidthRatio: null, gapPriceRatio: null,
      reason: 'The directional and Hedgeye previous-close basis could not be verified.',
    };
  }
  const gap = Math.abs(directional - hedgeye);
  const rangeWidth = high - low;
  const gapRangeWidthRatio = gap / rangeWidth;
  const gapPriceRatio = gap / Math.abs(hedgeye);
  if (gapRangeWidthRatio > 0.25 || gapPriceRatio > 0.02) {
    return {
      status: 'mismatch', display: 'hide', fit: 'mismatched', gap,
      gapRangeWidthRatio, gapPriceRatio,
      reason: 'Risk Range hidden because its previous-close basis materially differs from the selected directional contract.',
    };
  }
  if (gapRangeWidthRatio > 0.10) {
    return {
      status: 'proxy', display: 'proxy', fit: 'proxy_context', gap,
      gapRangeWidthRatio, gapPriceRatio,
      reason: 'Risk Range shown as proxy context because the previous-close bases differ.',
    };
  }
  return {
    status: 'aligned', display: 'normal', fit: 'aligned', gap,
    gapRangeWidthRatio, gapPriceRatio, reason: null,
  };
}

module.exports = {
  DIRECTIONAL_FEEDS,
  FUTURES_MARKET_IDS,
  MONTH_CODES,
  businessDaysUntil,
  candidateIdentity,
  evaluateRiskRangeBasis,
  generateDirectionalCandidates,
  selectDirectionalContract,
};
