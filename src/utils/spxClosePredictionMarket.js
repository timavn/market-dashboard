const NEW_YORK_TIME_ZONE = 'America/New_York';

export function dateKeyInTimeZone(value, timeZone = NEW_YORK_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : null;
}

export function hasCurrentSpxRiskRange(riskRange, eventCloseTime) {
  const lrr = Number(riskRange?.lrr);
  const hrr = Number(riskRange?.hrr);
  return Boolean(
    riskRange?.date &&
    riskRange.date === dateKeyInTimeZone(eventCloseTime) &&
    Number.isFinite(lrr) &&
    Number.isFinite(hrr) &&
    lrr < hrr
  );
}

export function findSpxRiskRangeForEvent(history = [], eventCloseTime) {
  const eventDate = dateKeyInTimeZone(eventCloseTime);
  if (!eventDate) return null;
  const match = (history || []).find((item) => item?.date === eventDate) || null;
  return hasCurrentSpxRiskRange(match, eventCloseTime) ? match : null;
}

export function classifySpxThreshold(threshold, riskRange) {
  const strike = Number(threshold);
  const lrr = Number(riskRange?.lrr);
  const hrr = Number(riskRange?.hrr);
  if (![strike, lrr, hrr].every(Number.isFinite) || lrr >= hrr) return 'unknown';
  if (strike < lrr) return 'below';
  if (strike > hrr) return 'above';
  return 'inside';
}

export function selectRelevantSpxMarkets(markets = [], riskRange, paddingPoints = 25) {
  const lrr = Number(riskRange?.lrr);
  const hrr = Number(riskRange?.hrr);
  if (!Number.isFinite(lrr) || !Number.isFinite(hrr) || lrr >= hrr) return [];
  return (markets || [])
    .filter((market) => {
      const threshold = Number(market?.threshold);
      return Number.isFinite(threshold) && threshold >= lrr - paddingPoints && threshold <= hrr + paddingPoints;
    })
    .sort((a, b) => Number(a.threshold) - Number(b.threshold));
}

export function locateSpxLivePrice(markets = [], price) {
  if (price == null || price === '') return null;
  const livePrice = Number(price);
  const thresholds = (Array.isArray(markets) ? markets : [])
    .map((market, originalIndex) => ({
      originalIndex,
      threshold: Number(market?.threshold),
    }))
    .filter((item) => Number.isFinite(item.threshold))
    .sort((left, right) => left.threshold - right.threshold);

  if (!Number.isFinite(livePrice) || thresholds.length === 0) return null;

  const first = thresholds[0];
  if (livePrice < first.threshold) {
    return {
      afterIndex: -1,
      position: 'below',
      lower: null,
      upper: first.threshold,
    };
  }

  for (let index = 0; index < thresholds.length; index += 1) {
    const current = thresholds[index];
    if (livePrice === current.threshold) {
      return {
        afterIndex: current.originalIndex,
        position: 'exact',
        lower: current.threshold,
        upper: current.threshold,
      };
    }

    const next = thresholds[index + 1];
    if (next && livePrice > current.threshold && livePrice < next.threshold) {
      return {
        afterIndex: current.originalIndex,
        position: 'between',
        lower: current.threshold,
        upper: next.threshold,
      };
    }
  }

  const last = thresholds[thresholds.length - 1];
  return {
    afterIndex: last.originalIndex,
    position: 'above',
    lower: last.threshold,
    upper: null,
  };
}

export function isSpxClosePosition(position = {}, eventTicker = '') {
  const text = [
    position.symbol,
    position.localSymbol,
    position.description,
    position.contract_title,
    position.question,
  ].filter(Boolean).join(' ').toUpperCase();
  const eventToken = String(eventTicker || '').toUpperCase();
  return text.includes('KXINXU') && (!eventToken || text.includes(eventToken));
}
