import {
  MARKET_QUOTE_FUTURE_TOLERANCE_MS,
  marketPayloadObservedAt,
  markMarketPayloadRetained,
  reconcileMarketQuotePayload,
  validateMarketQuotePayload,
  validatePeriodReturnPayload,
} from './marketQuoteFreshness';
import { getSessionResource, resetSessionResourceStore } from './sessionResourceStore';
import { resolveDashboardResourceDefinition } from './dashboardResourceRegistry';

describe('market quote payload freshness', () => {
  beforeEach(() => {
    jest.useRealTimers();
    resetSessionResourceStore();
    window.sessionStorage?.clear();
  });

  afterEach(() => {
    resetSessionResourceStore();
    window.sessionStorage?.clear();
    jest.useRealTimers();
  });

  test('uses active quote time at UTC rollover without letting a future historical row poison the payload', () => {
    const payload = {
      us: [{
        symbol: 'SPX',
        price: 7463.63,
        source: 'yahoo',
        dataType: 'delayed',
        availability: 'delayed',
        quoteAsOf: '2026-08-17T20:42:27.000Z',
      }],
      rates: {
        policy: [{
          symbol: 'IORB',
          price: 3.65,
          source: 'fred',
          dataType: 'historical',
          availability: 'historical',
          quoteAsOf: '2026-08-18T00:00:00.000Z',
        }],
      },
    };

    expect(marketPayloadObservedAt(payload))
      .toBe('2026-08-17T20:42:27.000Z');
    expect(validateMarketQuotePayload(payload)).toBe(payload);
    expect(payload.rates.policy[0]).toMatchObject({
      symbol: 'IORB',
      availability: 'historical',
      quoteAsOf: '2026-08-18T00:00:00.000Z',
    });
  });

  test('accepts an authoritative historical-only payload for the informational surface', () => {
    const payload = {
      rates: {
        policy: [{
          symbol: 'IORB',
          price: 3.65,
          source: 'fred',
          dataType: 'historical',
          availability: 'historical',
          quoteAsOf: '2026-08-18T00:00:00.000Z',
        }],
      },
    };

    expect(marketPayloadObservedAt(payload)).toBe('2026-08-18T00:00:00.000Z');
    expect(validateMarketQuotePayload(payload)).toBe(payload);
  });

  test('keeps period-return freshness separate from active quote freshness', () => {
    const payload = {
      us: [{
        symbol: 'SPX',
        availability: 'delayed',
        quoteAsOf: '2026-08-17T20:42:27.000Z',
        periodReturnsAsOf: '2026-08-14T00:00:00.000Z',
      }],
      rates: {
        policy: [{
          symbol: 'IORB',
          availability: 'historical',
          quoteAsOf: '2026-08-18T00:00:00.000Z',
          periodReturnsAsOf: '2026-08-15T00:00:00.000Z',
        }],
      },
    };

    expect(marketPayloadObservedAt(payload, { periodOnly: true }))
      .toBe('2026-08-15T00:00:00.000Z');
    expect(validatePeriodReturnPayload(payload)).toBe(payload);
  });

  test.each(['bundesbank', 'japan_mof', 'bank_of_england'])(
    'retains verified %s observations through refresh failure without changing their dates', (source) => {
      const quote = { symbol: 'RATE', price: 3.58, source, availability: 'historical',
        dataType: 'historical', observationFrequency: 'daily', sourceSeriesId: 'official-series',
        quoteAsOf: '2026-09-23T00:00:00Z', executable: false, displayOnly: true };
      const payload = { rates: [quote] };
      expect(validateMarketQuotePayload(payload)).toBe(payload);
      expect(markMarketPayloadRetained(payload, 'refresh-failed').rates[0]).toMatchObject({
        price: 3.58, source, lastVerifiedAt: quote.quoteAsOf,
        sourceSeriesId: 'official-series', availability: 'reference', executable: false,
      });
      for (const invalid of [{ mock: true }, { seeded: true }, { cacheOnly: true }, { connected: false }]) {
        expect(() => validateMarketQuotePayload({ rates: [{ ...quote, ...invalid }] })).toThrow();
      }
    },
  );

  test('publishes the same five-minute future tolerance used by server quote integrity', () => {
    expect(MARKET_QUOTE_FUTURE_TOLERANCE_MS).toBe(5 * 60 * 1000);
  });

  test('merges verified index history with newer quotes and retains omitted rows before persistence', () => {
    const quote = { symbol: 'SPX', price: 7515.34, changePercent: -0.5, availability: 'current',
      source: 'ibkr', dataType: 'live', quoteAsOf: '2026-09-02T17:01:49.771Z',
      fifteenDayChangePct: 2, monthChangePct: 3, periodReturnsStatus: 'historical',
      periodReturnsAsOf: '2026-09-01T13:30:00Z', periodReturnsSource: 'yahoo',
      periodSourceSeriesId: '^GSPC', periodObservationFrequency: 'daily' };
    const russell = { ...quote, symbol: 'RUT', periodSourceSeriesId: '^RUT', price: 2800 };
    const newer = { ...quote, price: 7520, quoteAsOf: '2026-09-02T17:02:49.771Z',
      fifteenDayChangePct: null, monthChangePct: null, periodReturnsStatus: 'unavailable',
      periodReturnsAsOf: null, periodReturnsSource: null, periodSourceSeriesId: null };
    const merged = reconcileMarketQuotePayload({
      currentReferenceData: { us: [quote, russell], rates: { us: [{ ...quote, symbol: 'UST10Y' }] } },
      incomingData: { us: [newer] },
    });
    expect(merged.us[0]).toMatchObject({ price: 7520, availability: 'current',
      quoteAsOf: newer.quoteAsOf, fifteenDayChangePct: 2, monthChangePct: 3,
      periodReturnsAsOf: quote.periodReturnsAsOf, periodReturnsSource: 'yahoo',
      periodSourceSeriesId: '^GSPC' });
    expect(merged.us[1]).toMatchObject({ symbol: 'RUT', price: 2800,
      quoteAsOf: russell.quoteAsOf, availability: 'reference', displayDelayed: true, executable: false,
      monthChangePct: 3, periodReturnsAsOf: russell.periodReturnsAsOf });
    expect(merged.rates.us[0]).toMatchObject({ symbol: 'UST10Y', availability: 'reference',
      quoteAsOf: quote.quoteAsOf, executable: false, monthChangePct: 3 });
    expect(quote).not.toHaveProperty('periodReturnProvenance');
  });

  test.each([{ source: 'mock' }, { seeded: true }, { cacheOnly: true },
    { fromCache: true }, { freshness: 'stale' }, { connected: false }, { warning: 'provider_offline' }])(
    'a rejected index row cannot erase retained history: %j', (invalid) => {
      const quote = { symbol: 'RUT', price: 2800, availability: 'delayed', source: 'yahoo',
        dataType: 'delayed', quoteAsOf: '2026-09-02T17:01:49.771Z', monthChangePct: 3,
        periodReturnsStatus: 'historical', periodReturnsAsOf: '2026-09-01T13:30:00Z',
        periodReturnsSource: 'yahoo', periodSourceSeriesId: '^RUT' };
      expect(reconcileMarketQuotePayload({ currentData: { us: [quote] }, incomingData: {
        us: [{ ...quote, ...invalid, price: 9999, monthChangePct: 99 }],
      } }).us).toEqual([expect.objectContaining({ price: 2800, monthChangePct: 3,
        availability: 'reference', quoteAsOf: quote.quoteAsOf })]);
      expect(reconcileMarketQuotePayload({ incomingData: { us: [{ ...quote, ...invalid }] } }).us).toEqual([]);
    },
  );

  test('persists merged index timeframes and reloads them after long aging and a failed refresh', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T18:00:00Z'));
    const spx = { symbol: 'SPX', price: 7515, availability: 'current', source: 'ibkr', dataType: 'live',
      quoteAsOf: '2026-09-02T17:01:49.771Z', monthChangePct: 3, fifteenDayChangePct: 2,
      periodReturnsStatus: 'historical', periodReturnsAsOf: '2026-09-01T13:30:00Z',
      periodReturnsSource: 'yahoo', periodSourceSeriesId: '^GSPC', periodObservationFrequency: 'daily' };
    const russell = { ...spx, symbol: 'RUT', price: 2800, periodSourceSeriesId: '^RUT' };
    const fetcher = jest.fn().mockResolvedValueOnce({ us: [spx, russell] }).mockResolvedValueOnce({
      us: [{ ...spx, price: 7520, quoteAsOf: '2026-09-02T17:02:49.771Z',
        monthChangePct: null, fifteenDayChangePct: null, periodReturnsAsOf: null,
        periodReturnsStatus: 'unavailable', periodReturnsSource: null, periodSourceSeriesId: null }, russell],
    }).mockRejectedValue(new Error('Provider disconnected'));
    const config = resolveDashboardResourceDefinition('market-period-returns', {}, {
      fetcher, validate: validatePeriodReturnPayload,
      getObservedAt: (payload) => marketPayloadObservedAt(payload, { periodOnly: true }),
    });
    const key = `${config.resourceKey}::${config.scopeKey}`;
    const entry = getSessionResource(key, config);
    await entry.refresh();
    await entry.refresh();
    const stored = JSON.parse(window.sessionStorage.getItem(config.persistReferenceSnapshot.key));
    expect(stored.data.us[0]).toMatchObject({ price: 7520, monthChangePct: 3,
      fifteenDayChangePct: 2, periodReturnsAsOf: spx.periodReturnsAsOf, periodReturnsSource: 'yahoo' });
    resetSessionResourceStore();
    jest.setSystemTime(new Date('2028-01-15T18:00:00Z'));
    const reloaded = getSessionResource(key, config);
    expect(reloaded.getSnapshot()).toMatchObject({ hydratedFromStorage: true,
      data: { us: [expect.objectContaining({ monthChangePct: 3, periodReturnsAsOf: spx.periodReturnsAsOf }),
        expect.objectContaining({ symbol: 'RUT', monthChangePct: 3 })] } });
    await reloaded.refresh();
    expect(reloaded.getSnapshot().data.us[0]).toMatchObject({ monthChangePct: 3,
      periodReturnsAsOf: spx.periodReturnsAsOf, periodReturnsSource: 'yahoo' });
  });

  test('accepts explicitly dated, non-executable retained references', () => {
    const payload = {
      us: [{
        symbol: 'SPX',
        price: '7669.22',
        availability: 'reference',
        source: 'ibkr',
        dataType: 'live',
        quoteAsOf: '2026-09-02T17:01:49.771Z',
        lastVerifiedAt: '2026-09-02T17:01:49.771Z',
        displayDelayed: true,
        displayOnly: true,
        executable: false,
      }],
    };

    expect(validateMarketQuotePayload(payload)).toBe(payload);
    expect(marketPayloadObservedAt(payload)).toBe('2026-09-02T17:01:49.771Z');
  });

  test('demotes reloaded or failed-refresh readings without changing their observation time', () => {
    const quote = { symbol: 'SPX', price: 7515.34, changePercent: -0.5, availability: 'current',
      source: 'ibkr', dataType: 'live', quoteAsOf: '2026-09-02T17:01:49.771Z' };
    const payload = { us: [quote], rates: { policy: [{ ...quote, symbol: 'UST2Y' }] } };
    const retained = markMarketPayloadRetained(payload, 'persisted-reference');
    expect(retained.us[0]).toMatchObject({ ...quote, availability: 'reference',
      lastVerifiedAt: quote.quoteAsOf, displayDelayed: true, executable: false });
    expect(retained.rates.policy[0]).toMatchObject({ availability: 'reference', executable: false });
    expect(quote.availability).toBe('current');
    expect(markMarketPayloadRetained(retained, 'refresh-delayed').us[0].lastVerifiedAt).toBe(quote.quoteAsOf);
  });

  test.each([{ source: 'mock' }, { seeded: true }, { cacheOnly: true }, { freshness: 'stale' },
    { warning: 'provider_offline' }, { source: 'portfolio' }])('never relabels unverified input as retained: %j', (invalid) => {
    const payload = { us: [{ symbol: 'SPX', price: 7515.34, availability: 'current', source: 'ibkr',
      dataType: 'live', quoteAsOf: '2026-09-02T17:01:49.771Z', ...invalid }] };
    expect(markMarketPayloadRetained(payload).us).toEqual([]);
    expect(() => validateMarketQuotePayload(payload)).toThrow();
  });

  test('keeps the mixed-provider quote resource populated across the UTC rollover incident', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-17T23:59:00.000Z'));
    const payload = {
      us: [{
        symbol: 'SPX',
        price: 7463.63,
        source: 'yahoo',
        dataType: 'delayed',
        availability: 'delayed',
        quoteAsOf: '2026-08-17T20:42:27.000Z',
      }],
      rates: {
        policy: [{
          symbol: 'IORB',
          price: 3.65,
          source: 'fred',
          dataType: 'historical',
          availability: 'historical',
          quoteAsOf: '2026-08-18T00:00:00.000Z',
        }],
      },
    };
    const entry = getSessionResource('multi-region-market-quotes::utc-rollover', {
      kind: 'live',
      fetcher: jest.fn().mockResolvedValue(payload),
      validate: validateMarketQuotePayload,
      getObservedAt: marketPayloadObservedAt,
      maxAgeMs: 4 * 24 * 60 * 60 * 1000,
      futureToleranceMs: MARKET_QUOTE_FUTURE_TOLERANCE_MS,
      isExplicitInvalidation: () => true,
    });

    await entry.refresh();

    expect(entry.getSnapshot()).toMatchObject({
      availability: 'live',
      observedAt: '2026-08-17T20:42:27.000Z',
      data: payload,
      error: null,
    });
  });
});
