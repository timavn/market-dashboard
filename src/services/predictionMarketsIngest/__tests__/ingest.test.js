const { normalizeEvent, comparisonFingerprint } = require('../normalize/normalizeEvent');
const { isFinancialMacroEvent } = require('../filter/isFinancialMacroEvent');
const { enrichEvent } = require('../enrich/enrichEvent');
const { assignComparisonGroup } = require('../group/assignComparisonGroup');
const { mergeCrossVenueEvents } = require('../merge/mergeCrossVenueEvents');
const { sortAggregatedEvents } = require('../sortEvents');
const { fromKalshiCents, deriveNoFromYes } = require('../normalize/priceScaling');

describe('priceScaling', () => {
  test('fromKalshiCents converts cents to 0-1', () => {
    expect(fromKalshiCents(45)).toBeCloseTo(0.45);
    expect(fromKalshiCents(0.45)).toBeCloseTo(0.45);
  });

  test('deriveNoFromYes complements yes prices', () => {
    const { no_bid, no_ask } = deriveNoFromYes(0.4, 0.45);
    expect(no_bid).toBeCloseTo(0.55);
    expect(no_ask).toBeCloseTo(0.6);
  });
});

describe('normalizeEvent kalshi', () => {
  test('maps market fields', () => {
    const event = normalizeEvent(
      {
        market: {
          ticker: 'TEST-1',
          yes_bid: 42,
          yes_ask: 45,
          last_price: 44,
          status: 'open',
          close_time: '2025-06-11T12:00:00Z',
        },
        series: { ticker: 'CPI', category: 'economics', title: 'CPI Release' },
        event: { title: 'June CPI' },
      },
      'kalshi'
    );
    expect(event.id).toBe('kalshi:TEST-1');
    expect(event.yes_bid).toBeCloseTo(0.42);
    expect(event.venue).toBe('Kalshi');
  });
});

describe('isFinancialMacroEvent', () => {
  test('includes CPI market', () => {
    expect(
      isFinancialMacroEvent({
        question: 'Will CPI exceed 3%?',
        category: 'Inflation',
        settlement_source: 'BLS',
      })
    ).toBe(true);
  });

  test('excludes sports without macro settlement', () => {
    expect(
      isFinancialMacroEvent({
        question: 'Will the Chiefs win the Super Bowl?',
        category: 'Other Macro',
      })
    ).toBe(false);
  });
});

describe('enrichEvent', () => {
  test('computes mids and spread', () => {
    const e = enrichEvent({
      yes_bid: 0.4,
      yes_ask: 0.5,
      no_bid: 0.5,
      no_ask: 0.6,
      status: 'open',
      settlement_source: 'BLS',
      volume: 10000,
      updated_at: new Date().toISOString(),
    });
    expect(e.yes_mid).toBeCloseTo(0.45);
    expect(e.spread).toBeCloseTo(0.1);
    expect(e.data_quality_flags).toContain('wide_spread');
  });
});

describe('assignComparisonGroup', () => {
  test('same fingerprint shares group id', () => {
    const a = {
      question: 'Will CPI exceed 3%?',
      underlying: 'CPI',
      event_date: '2025-06-11',
      settlement_source: 'BLS',
    };
    const b = { ...a, venue: 'Kalshi', api_raw_id: '1' };
    const c = { ...a, venue: 'ForecastEx', api_raw_id: '2' };
    const grouped = assignComparisonGroup([b, c]);
    expect(grouped[0].comparison_group_id).toBe(grouped[1].comparison_group_id);
  });
});

describe('sortAggregatedEvents', () => {
  test('open before settled', () => {
    const sorted = sortAggregatedEvents([
      { status: 'settled', event_date: '2025-01-01', volume: 999, spread: 0.01 },
      { status: 'open', event_date: '2025-06-01', volume: 1, spread: 0.5 },
    ]);
    expect(sorted[0].status).toBe('open');
  });
});

describe('comparisonFingerprint', () => {
  test('stable for same inputs', () => {
    const fp1 = comparisonFingerprint({
      question: 'Fed rate above 5%?',
      underlying: 'FF',
      event_date: '2025-03-19',
      settlement_source: 'Federal Reserve',
    });
    const fp2 = comparisonFingerprint({
      question: 'Fed rate above 5%?',
      underlying: 'FF',
      event_date: '2025-03-19',
      settlement_source: 'Federal Reserve',
    });
    expect(fp1).toBe(fp2);
  });
});

describe('mergeCrossVenueEvents', () => {
  test('prefers IBKR quotes and keeps Kalshi OI', () => {
    const grouped = assignComparisonGroup([
      {
        id: 'kalshi:cpi-1',
        venue: 'Kalshi',
        api_raw_id: 'cpi-1',
        question: 'Will CPI exceed 3%?',
        underlying: 'CPI',
        event_date: '2025-06-11',
        settlement_source: 'BLS',
        yes_bid: 0.4,
        yes_ask: 0.42,
        open_interest: 5000,
        liquidity: 8000,
        volume: 1200,
        url: 'https://kalshi.com/markets/cpi-1',
      },
      {
        id: 'cme:999',
        venue: 'CME',
        api_raw_id: '999',
        tradable_in_ibkr: true,
        question: 'Will CPI exceed 3%?',
        underlying: 'CPI',
        event_date: '2025-06-11',
        settlement_source: 'BLS',
        yes_bid: 0.41,
        yes_ask: 0.43,
        volume: 50,
      },
    ]);

    const merged = mergeCrossVenueEvents(grouped);
    expect(merged).toHaveLength(1);
    expect(merged[0].yes_bid).toBeCloseTo(0.41);
    expect(merged[0].yes_ask).toBeCloseTo(0.43);
    expect(merged[0].open_interest).toBe(5000);
    expect(merged[0].liquidity).toBe(8000);
    expect(merged[0].quote_source).toBe('CME');
    expect(merged[0].venues).toEqual(expect.arrayContaining(['Kalshi', 'CME']));
    expect(merged[0].is_merged).toBe(true);
    expect(merged[0].alt_quotes).toHaveLength(2);
  });

  test('single venue rows get canonical metadata', () => {
    const merged = mergeCrossVenueEvents([
      {
        id: 'kalshi:only',
        venue: 'Kalshi',
        api_raw_id: 'only',
        question: 'Only on Kalshi',
        comparison_group_id: 'cg_only',
      },
    ]);
    expect(merged[0].venues).toEqual(['Kalshi']);
    expect(merged[0].is_merged).toBe(false);
  });
});
