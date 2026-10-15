import { finite } from './monitorNumbers';
import { isSpxMonitorSectionUsable } from './monitorSectionValidation';

const riskRangeValues = (range) => {
  const references = Array.isArray(range?.references) ? range.references : [];
  const low = references.find((reference) => String(reference?.label || '').toUpperCase() === 'LRR');
  const high = references.find((reference) => String(reference?.label || '').toUpperCase() === 'HRR');
  const lrr = finite(low?.value) ? Number(low.value) : null;
  const hrr = finite(high?.value) ? Number(high.value) : null;
  return range?.status === 'available' && lrr != null && hrr != null && lrr < hrr
    ? { available: true, lrr, hrr }
    : { available: false, lrr: null, hrr: null };
};

const unavailableRiskRangeStructureScore = (reason, sessionCount = 0) => ({
  status: 'unavailable',
  score: null,
  highScore: null,
  lowScore: null,
  sessionCount,
  comparisonCount: 0,
  eventCount: 0,
  counts: { HH: 0, HL: 0, LH: 0, LL: 0, EH: 0, EL: 0 },
  events: [],
  sessions: [],
  reason,
  basis: 'risk_range_endpoints',
});

const nextRiskRangeTrendScore = (currentScore, credit) => {
  if (credit === 0) return 0;
  return Math.sign(currentScore) === Math.sign(credit)
    ? currentScore + credit
    : credit;
};

/**
 * Consecutive Risk Range trend score for the sessions visible in a chart.
 *
 * The first visible session is the baseline. Each later HRR starts or extends
 * a positive higher-high (HH) run or a negative lower-high (LH) run. LRR runs
 * independently track higher lows (HL) and lower lows (LL). A direction
 * reversal restarts that leg at +1 or -1 immediately, while an equal endpoint
 * breaks its run back to zero. A complete verified window is required so a
 * partial trend cannot be mistaken for the requested 5D or 10D result.
 */
const calculateRiskRangeStructureScore = (dailyRanges = [], expectedSessionCount = null) => {
  const ranges = Array.isArray(dailyRanges) ? dailyRanges : [];
  const requiredCount = Number.isInteger(expectedSessionCount) && expectedSessionCount > 0
    ? expectedSessionCount
    : ranges.length;
  if (requiredCount < 2 || ranges.length !== requiredCount) {
    return unavailableRiskRangeStructureScore(
      `Complete exact-date Risk Range history is required for all ${requiredCount || 'requested'} sessions.`,
      ranges.length,
    );
  }

  const normalized = ranges.map((range) => {
    const values = riskRangeValues(range);
    return values.available && /^\d{4}-\d{2}-\d{2}$/.test(String(range?.date || ''))
      ? { date: range.date, lrr: values.lrr, hrr: values.hrr }
      : null;
  });
  if (normalized.some((range) => !range)) {
    return unavailableRiskRangeStructureScore(
      `Complete exact-date Risk Range history is required for all ${requiredCount} sessions.`,
      ranges.length,
    );
  }
  if (new Set(normalized.map((range) => range.date)).size !== normalized.length) {
    return unavailableRiskRangeStructureScore('Risk Range session dates are not unique.', ranges.length);
  }

  const chronological = [...normalized].sort((left, right) => left.date.localeCompare(right.date));
  const counts = { HH: 0, HL: 0, LH: 0, LL: 0, EH: 0, EL: 0 };
  const events = [];
  const sessions = [{
    date: chronological[0].date,
    comparisonDate: null,
    highEvent: 'BASE',
    highCredit: 0,
    highScore: 0,
    lowEvent: 'BASE',
    lowCredit: 0,
    lowScore: 0,
    score: 0,
    cumulativeScore: 0,
  }];
  let highScore = 0;
  let lowScore = 0;
  for (let index = 1; index < chronological.length; index += 1) {
    const previous = chronological[index - 1];
    const current = chronological[index];
    const highCredit = current.hrr > previous.hrr ? 1 : current.hrr < previous.hrr ? -1 : 0;
    const lowCredit = current.lrr > previous.lrr ? 1 : current.lrr < previous.lrr ? -1 : 0;
    const highEvent = highCredit > 0 ? 'HH' : highCredit < 0 ? 'LH' : 'EH';
    const lowEvent = lowCredit > 0 ? 'HL' : lowCredit < 0 ? 'LL' : 'EL';
    counts[highEvent] += 1;
    counts[lowEvent] += 1;
    highScore = nextRiskRangeTrendScore(highScore, highCredit);
    lowScore = nextRiskRangeTrendScore(lowScore, lowCredit);
    const event = {
      date: current.date,
      comparisonDate: previous.date,
      highEvent,
      highCredit,
      highScore,
      lowEvent,
      lowCredit,
      lowScore,
      score: highCredit + lowCredit,
      cumulativeScore: highScore + lowScore,
    };
    events.push(event);
    sessions.push(event);
  }

  return {
    status: 'available',
    score: highScore + lowScore,
    highScore,
    lowScore,
    sessionCount: chronological.length,
    comparisonCount: events.length,
    eventCount: events.length * 2,
    baselineDate: chronological[0].date,
    asOf: chronological[chronological.length - 1].date,
    counts,
    events,
    sessions,
    reason: null,
    basis: 'risk_range_endpoints',
    ruleVersion: 'visible-window-split-streak-v3',
  };
};

const formatSignedStructureScore = (score) => (
  Number(score) >= 0 ? `+${Number(score)}` : String(Number(score))
);

const structureScoreAriaValue = (score) => (
  Number(score) > 0 ? `plus ${Number(score)}` : Number(score) < 0 ? `minus ${Math.abs(Number(score))}` : 'zero'
);

const structureScoreToneFor = (score) => (
  Number(score) > 0 ? 'positive' : Number(score) < 0 ? 'negative' : 'neutral'
);

const isVerifiedRiskRangeStructureChart = (chart, nowMs) => {
  const source = String(chart?.source || '').trim();
  const availability = String(chart?.availability || '').toLowerCase();
  const riskRangeStatus = String(chart?.riskRangeStatus || '').toLowerCase();
  return isSpxMonitorSectionUsable(chart, nowMs)
    && source.length > 0
    && !/(?:mock|seed|fixture|fallback|cache|portfolio)/i.test(source)
    && !['unavailable', 'stale', 'cache', 'cache_only'].includes(availability)
    && Array.isArray(chart?.points)
    && chart.points.length >= 2
    && (!riskRangeStatus || ['available', 'aligned', 'proxy_context'].includes(riskRangeStatus))
    && chart?.refreshFailed !== true
    && chart?.connected !== false
    && chart?.disconnected !== true
    && chart?.fromCache !== true
    && chart?.cacheOnly !== true
    && chart?.seeded !== true
    && chart?.mock !== true
    && chart?.stale !== true;
};

export { calculateRiskRangeStructureScore, formatSignedStructureScore, isVerifiedRiskRangeStructureChart, riskRangeValues, structureScoreAriaValue, structureScoreToneFor, unavailableRiskRangeStructureScore };
