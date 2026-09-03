import {
  markMarketQuotePayloadRefreshDelayed,
  MARKET_QUOTE_FUTURE_TOLERANCE_MS,
  marketPayloadObservedAt,
  reconcileMarketQuotePayload,
  validateMarketQuotePayload,
  validatePeriodReturnPayload,
} from './marketQuoteFreshness';
import { getSessionResource, resetSessionResourceStore } from './sessionResourceStore';

describe('market quote payload freshness', () => {
  beforeEach(() => {
    jest.useRealTimers();
    resetSessionResourceStore();
  });

  afterEach(() => {
    resetSessionResourceStore();
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

  test('fails closed when the payload contains only historical references', () => {
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

    expect(marketPayloadObservedAt(payload)).toBeNull();
    let error;
    try {
      validateMarketQuotePayload(payload);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'MARKET_QUOTES_EVIDENCE_MISSING',
      liveInvalidation: true,
    });
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

  test('publishes the same five-minute future tolerance used by server quote integrity', () => {
    expect(MARKET_QUOTE_FUTURE_TOLERANCE_MS).toBe(5 * 60 * 1000);
  });

  test('retains a missing verified index as a display-only delayed reference', () => {
    const currentData = {
      us: [
        {
          symbol: 'SPX',
          price: '7669.22',
          changePercent: '0.49',
          availability: 'current',
          source: 'ibkr',
          dataType: 'live',
          quoteAsOf: '2026-09-02T17:01:49.771Z',
        },
        {
          symbol: 'RSP',
          price: '218.66',
          availability: 'current',
          source: 'ibkr',
          dataType: 'live',
          quoteAsOf: '2026-09-02T17:01:50.341Z',
        },
      ],
    };
    const incomingData = {
      us: [{
        symbol: 'RSP',
        price: '218.70',
        availability: 'current',
        source: 'ibkr',
        dataType: 'live',
        quoteAsOf: '2026-09-02T17:02:20.341Z',
      }],
    };

    const reconciled = reconcileMarketQuotePayload({ currentData, incomingData });

    expect(reconciled).not.toBe(currentData);
    expect(reconciled.us.map(({ symbol }) => symbol)).toEqual(['SPX', 'RSP']);
    expect(reconciled.us[0]).toEqual(expect.objectContaining({
      symbol: 'SPX',
      price: '7669.22',
      availability: 'reference',
      freshness: 'refresh-delayed',
      quoteMode: 'last-verified-reference',
      lastVerifiedAt: '2026-09-02T17:01:49.771Z',
      displayDelayed: true,
      displayOnly: true,
      executable: false,
      retentionReason: 'quote_missing_from_refresh',
    }));
    expect(reconciled.us[1]).toBe(incomingData.us[0]);
    expect(marketPayloadObservedAt(reconciled)).toBe('2026-09-02T17:02:20.341Z');
  });

  test('does not retain synthetic or portfolio-derived rows after a refresh omits them', () => {
    const reconciled = reconcileMarketQuotePayload({
      currentData: {
        us: [
          {
            symbol: 'SPX', price: 7000, availability: 'current', source: 'mock',
            quoteAsOf: '2026-09-02T17:00:00.000Z',
          },
          {
            symbol: 'DJI', price: 50000, availability: 'current', source: 'ibkr',
            quoteAsOf: '2026-09-02T17:00:00.000Z', warning: 'portfolio-derived',
          },
        ],
      },
      incomingData: { us: [] },
    });

    expect(reconciled.us).toEqual([]);
  });

  test('demotes a retained whole-resource snapshot when its refresh is delayed', () => {
    const payload = {
      us: [{
        symbol: 'DJI',
        price: '53002.30',
        availability: 'current',
        source: 'ibkr',
        dataType: 'live',
        quoteAsOf: '2026-09-02T17:01:50.339Z',
      }],
      rates: {
        policy: [{
          symbol: 'IORB',
          price: 3.65,
          availability: 'historical',
          source: 'fred',
          dataType: 'historical',
          quoteAsOf: '2026-09-01T00:00:00.000Z',
        }],
      },
    };

    const demoted = markMarketQuotePayloadRefreshDelayed(payload, 'provider_offline');

    expect(demoted.us[0]).toEqual(expect.objectContaining({
      availability: 'reference',
      displayDelayed: true,
      retentionReason: 'provider_offline',
    }));
    expect(demoted.rates.policy[0]).toEqual(payload.rates.policy[0]);
    expect(payload.us[0].availability).toBe('current');
  });

  test('reconciles a partial refresh inside the retained informational resource', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T17:03:00.000Z'));
    const first = {
      us: [{
        symbol: 'SPX',
        price: '7669.22',
        availability: 'current',
        source: 'ibkr',
        dataType: 'live',
        quoteAsOf: '2026-09-02T17:02:50.000Z',
      }],
    };
    const partial = {
      us: [{
        symbol: 'RSP',
        price: '218.70',
        availability: 'current',
        source: 'ibkr',
        dataType: 'live',
        quoteAsOf: '2026-09-02T17:03:00.000Z',
      }],
    };
    const fetcher = jest.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(partial);
    const entry = getSessionResource('multi-region-market-quotes::partial-refresh', {
      kind: 'live',
      resourceClass: 'informational-live',
      fetcher,
      validate: validateMarketQuotePayload,
      getObservedAt: marketPayloadObservedAt,
      reconcileIncoming: reconcileMarketQuotePayload,
      maxAgeMs: 4 * 24 * 60 * 60 * 1000,
      futureToleranceMs: MARKET_QUOTE_FUTURE_TOLERANCE_MS,
      retainOnRefreshFailure: true,
      retainAfterExpiry: true,
    });

    await entry.refresh();
    await entry.refresh();

    expect(entry.getSnapshot().data.us).toEqual([
      expect.objectContaining({
        symbol: 'SPX',
        price: '7669.22',
        availability: 'reference',
        displayDelayed: true,
      }),
      expect.objectContaining({
        symbol: 'RSP',
        price: '218.70',
        availability: 'current',
      }),
    ]);
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
