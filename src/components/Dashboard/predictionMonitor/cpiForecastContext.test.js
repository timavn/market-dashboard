import {
  buildCpiCalendarAxis,
  buildCpiDailyChartRows,
  normalizeCpiBenchmarkPanelData,
} from './cpiForecastContext';
import { buildContractTradingClock } from './contractTradingClock';
import { buildSettlementIdentityViewModel } from './settlementIdentity';
import { labelOffsetAttributes, resolveChartLabelOffsets } from './chartLabelLayout';

const NOW = Date.parse('2026-09-11T11:00:00.000Z');
const RELEASE = '2026-09-11T12:30:00.000Z';

const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

const benchmark = () => ({
  period: '2026-08', metric: 'headline-cpi-yoy', unit: 'percent',
  fetchedAt: new Date(NOW).toISOString(),
  sources: [{
    id: 'wall-street-consensus', kind: 'consensus', status: 'available',
    period: '2026-08', releaseAt: RELEASE, point: '3.04', source: 'Trading Economics',
    sourceUrl: 'https://tradingeconomics.com/united-states/inflation-cpi',
  }],
  releaseSetup: {
    status: 'partial', period: '2026-08', releaseAt: RELEASE,
    checkedAt: new Date(NOW).toISOString(), source: 'Trading Economics',
    rows: [{
      id: 'headline-yoy', status: 'available', period: '2026-08', releaseAt: RELEASE,
      previous: '2.9', consensus: '3.04', providerForecast: '3.08', actual: null,
      source: 'Trading Economics', sourceUrl: 'http://invalid.example',
    }],
  },
});

describe('CPI forecast context boundaries', () => {
  it('normalizes a frozen exact-release envelope without reordering sources or the four measures', () => {
    const payload = freeze(benchmark());
    const result = normalizeCpiBenchmarkPanelData(payload, '2026-08', RELEASE, NOW);
    expect(result.sources[0]).toMatchObject({ id: 'wall-street-consensus', status: 'available', point: 3.04 });
    expect(result.releaseSetup.rows.map(row => row.id)).toEqual(['headline-mom', 'headline-yoy', 'core-mom', 'core-yoy']);
    expect(result.releaseSetup.rows[1]).toMatchObject({ previous: 2.9, consensus: 3.04, providerForecast: 3.08, actual: null, sourceUrl: null });
    expect(payload.sources[0].point).toBe('3.04');
  });

  it('rejects wrong or aged envelopes and keeps disallowed source provenance pending', () => {
    for (const changes of [{ period: '2026-07' }, { metric: 'core-cpi-yoy' }, { unit: 'points' }, { fetchedAt: new Date(NOW - 30 * 60_000 - 1).toISOString() }]) {
      expect(normalizeCpiBenchmarkPanelData({ ...benchmark(), ...changes }, '2026-08', RELEASE, NOW)).toBeNull();
    }
    for (const source of ['mock', 'seed', 'cache-only', 'offline', 'stale', 'fixture']) {
      const payload = benchmark();
      payload.sources[0].source = source;
      payload.releaseSetup.rows[0].source = source;
      const result = normalizeCpiBenchmarkPanelData(freeze(payload), '2026-08', RELEASE, NOW);
      expect(result.sources[0]).toMatchObject({ status: 'pending', point: null, asOf: null });
      expect(result.releaseSetup.rows[1]).toMatchObject({ status: 'pending', consensus: null, providerForecast: null });
    }
  });

  it('keeps weekend publication gaps while retaining only tooltip context and one-decimal chart precision', () => {
    const points = freeze([
      { timestamp: Date.parse('2026-08-31T12:00:00Z'), cleveland: 3.06 },
      { timestamp: Date.parse('2026-08-28T12:00:00Z'), cleveland: 2.91 },
    ]);
    const axis = buildCpiCalendarAxis('2026-08', points, { endAt: '2026-08-31T20:00:00Z' });
    const rows = buildCpiDailyChartRows({ calendarAxis: freeze(axis), clevelandPoints: points, scenarios: freeze([{ key: 'base', value: 3.04 }]), blsActual: null, tooltipAnchor: 2.5 });
    expect(axis).toMatchObject({ startDate: '2026-08-01', endDate: '2026-08-31', dayCount: 31, sourceStartDate: '2026-08-28', sourceEndDate: '2026-08-31' });
    expect(axis.weekendDays.map(day => day.date)).toContain('2026-08-30');
    expect(rows.find(row => row.date === '2026-08-27')).toMatchObject({ cleveland: null, clevelandLatest: null, scenarios: { base: 3 } });
    expect(rows.find(row => row.date === '2026-08-30')).toMatchObject({ cleveland: null, clevelandLatest: 2.9, blsActual: null });
    expect(rows.at(-1)).toMatchObject({ cleveland: 3.1, clevelandLatest: 3.1 });
    expect(points[0].cleveland).toBe(3.06);
  });
});

describe('shared CPI chart/header dependencies', () => {
  it('changes the trading clock at the exact close while keeping observation time distinct', () => {
    const event = freeze({ status: 'open', openTime: '2026-09-11T10:00:00Z', closeTime: '2026-09-11T11:00:00Z', observationTime: RELEASE, timezone: 'UTC' });
    expect(buildContractTradingClock({ event, nowMs: NOW - 1, localTimeZone: 'UTC' })).toMatchObject({ state: 'open', headline: 'OPEN · CLOSES IN 0s' });
    expect(buildContractTradingClock({ event, nowMs: NOW, localTimeZone: 'UTC' })).toMatchObject({ state: 'closed', headline: 'TRADING CLOSED · OBSERVES IN 1h 30m', secondarySchedule: null });
  });

  it('requires the current matching catalog for settlement identity and preserves checking state', () => {
    const selection = freeze({
      contracts: { event: { ticker: 'KXCPIYOY-26SEP', generationId: 'august' } },
      venue: {
        id: 'kalshi',
        catalog: { status: 'available', expiresAt: RELEASE, event: { generationId: 'august' } },
        settlementBasis: { status: 'verified', instrument: 'CPI-U', method: 'year-over-year', observationAt: RELEASE, sourceName: 'BLS', sourceUrl: 'https://www.bls.gov/cpi/' },
      },
    });
    expect(buildSettlementIdentityViewModel(selection, { nowMs: NOW })).toMatchObject({ status: 'verified', venueText: 'KALSHI' });
    expect(buildSettlementIdentityViewModel(selection, { nowMs: Date.parse(RELEASE) + 1 })).toMatchObject({ status: 'unavailable' });
    expect(buildSettlementIdentityViewModel({ ...selection, contracts: { event: { generationId: 'july' } } }, { nowMs: NOW })).toMatchObject({ status: 'unavailable' });
    expect(buildSettlementIdentityViewModel(null, { checking: true, nowMs: NOW })).toMatchObject({ status: 'checking', basis: null });
  });

  it('keeps stable collision offsets and their DOM attribute precision without mutating labels', () => {
    const labels = freeze([{ id: 'upside', value: 3 }, { id: 'base', value: 3 }, { id: 'downside', value: 3 }]);
    const offsets = resolveChartLabelOffsets(labels, [2, 4], { height: 84, minGap: 14, padding: 4 });
    expect(offsets).toEqual({ upside: -14, base: 0, downside: 14 });
    expect(labelOffsetAttributes(offsets.upside)).toEqual({ 'data-label-offset': '-14.00', 'data-collision-adjusted': 'true' });
    expect(labelOffsetAttributes(0)).toEqual({ 'data-label-offset': '0.00', 'data-collision-adjusted': undefined });
    expect(resolveChartLabelOffsets(labels, [4, 2])).toEqual({ upside: 0, base: 0, downside: 0 });
  });
});
