const {
  GOLD_EXACT_URL,
  GOLD_GUARD_BAND_USD,
  buildGoldPythTracking,
  normalizeFinalizedGoldEvents,
} = require('./goldPythTracking.cjs');

function goldEvent({
  date,
  value,
  eventTicker = (() => {
    const [year, month, day] = date.split('-');
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return `KXGOLDD-${year.slice(-2)}${months[Number(month) - 1]}${day}17`;
  })(),
  seriesTicker = 'KXGOLDD',
  status = 'finalized',
  result = 'yes',
  rules = `If the close price of the 1-minute candlestick for gold on ${date} at 5:00 PM EDT is above 4000.00 USD/t.oz, then Yes.`,
  duplicateValue = value,
} = {}) {
  const closeTime = `${date}T21:00:00.000Z`;
  const market = (suffix, expirationValue) => ({
    ticker: `${eventTicker}-${suffix}`,
    status,
    result,
    expiration_value: String(expirationValue),
    settlement_ts: `${date}T22:01:00.000Z`,
    close_time: closeTime,
    rules_primary: rules,
  });
  return {
    event_ticker: eventTicker,
    series_ticker: seriesTicker,
    markets: [market('T4000', value), market('T4010', duplicateValue)],
  };
}

describe('Gold Pyth tracking', () => {
  test('accepts only consistent finalized daily KXGOLDD expiration values', () => {
    const valid = goldEvent({ date: '2026-08-31', value: 4448.11, eventTicker: 'KXGOLDD-26AUG3117' });
    const rows = normalizeFinalizedGoldEvents({ events: [
      valid,
      goldEvent({ date: '2026-08-30', value: 4400, status: 'open' }),
      goldEvent({ date: '2026-08-29', value: 4400, seriesTicker: 'KXGOLDW' }),
      goldEvent({ date: '2026-08-28', value: 4400, duplicateValue: 4401 }),
      goldEvent({ date: '2026-08-27', value: 4400, rules: 'Unrelated settlement rule.' }),
    ] });

    expect(rows).toEqual([expect.objectContaining({
      eventTicker: 'KXGOLDD-26AUG3117',
      value: 4448.11,
      observationAt: '2026-08-31T21:00:00.000Z',
      source: 'kalshi_finalized_expiration_value',
    })]);
  });

  test('calculates rolling error statistics without applying a synthetic correction', () => {
    const dates = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31'];
    const errors = [-2, -1, 0, 1, 2, 3];
    const events = dates.map((date, index) => goldEvent({
      date,
      value: 4400 + index + errors[index],
      eventTicker: index === dates.length - 1 ? 'KXGOLDD-26AUG3117' : undefined,
    }));
    const proxyPoints = dates.map((date, index) => ({
      timestamp: Date.parse(`${date}T20:00:00.000Z`),
      value: 4400 + index,
    }));

    const tracking = buildGoldPythTracking({
      payload: { events },
      proxyPoints,
      selectedEventTicker: 'KXGOLDD-26AUG3117',
    });

    expect(tracking).toMatchObject({
      status: 'available',
      resolverSymbol: 'Metal.Index.GOLD/USD',
      proxySymbol: 'XAUUSD',
      sampleSize: 6,
      meanSignedErrorUsd: 0.5,
      meanAbsoluteErrorUsd: 1.5,
      medianAbsoluteErrorUsd: 1.5,
      p90AbsoluteErrorUsd: 2.5,
      maxAbsoluteErrorUsd: 3,
      guardBandUsd: GOLD_GUARD_BAND_USD,
      exactUrl: GOLD_EXACT_URL,
      currentEventFinal: { eventTicker: 'KXGOLDD-26AUG3117' },
    });
    expect(tracking.settlements).toHaveLength(6);
    expect(tracking.settlements.at(-1)).toMatchObject({
      status: 'available',
      availability: 'official_final',
      final: true,
      eventTicker: 'KXGOLDD-26AUG3117',
      value: 4408,
      observationAt: '2026-08-31T21:00:00.000Z',
      source: 'kalshi_finalized_expiration_value',
    });
    expect(tracking).not.toHaveProperty('correctedValue');
    expect(tracking).not.toHaveProperty('observations');
  });

  test('publishes a labeled latest official final but withholds statistics below five matches', () => {
    const event = goldEvent({
      date: '2026-08-31',
      value: 4448.11,
      eventTicker: 'KXGOLDD-26AUG3117',
    });
    const tracking = buildGoldPythTracking({
      payload: { events: [event] },
      proxyPoints: [{ timestamp: Date.parse('2026-08-31T20:00:00.000Z'), value: 4441.14 }],
      selectedEventTicker: 'KXGOLDD-26SEP0117',
    });

    expect(tracking).toMatchObject({
      status: 'partial',
      sampleSize: 1,
      meanSignedErrorUsd: null,
      latestFinal: { eventTicker: 'KXGOLDD-26AUG3117', value: 4448.11 },
      currentEventFinal: null,
    });
    expect(tracking.settlements).toEqual([
      expect.objectContaining({
        status: 'available',
        availability: 'official_final',
        final: true,
        eventTicker: 'KXGOLDD-26AUG3117',
        value: 4448.11,
      }),
    ]);
  });
});
