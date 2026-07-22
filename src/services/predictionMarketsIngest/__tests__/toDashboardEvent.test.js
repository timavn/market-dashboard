const { normalizedToDashboardEvent } = require('../toDashboardEvent');

describe('prediction event dashboard adapter', () => {
  test('does not complement, zero-fill, or assign a default side when native fields are absent', () => {
    const row = normalizedToDashboardEvent({
      id: 'kalshi:test',
      venue: 'Kalshi',
      yes_bid: 0.41,
      last_price: 0.42,
      no_mid: null,
      max_payout_per_contract: null,
    });

    expect(row).toMatchObject({
      yes: null,
      no: null,
      side: null,
      payoutMultiplier: null,
      myProb: null,
    });
  });

  test('passes through only native mids and explicit user decisions', () => {
    const row = normalizedToDashboardEvent({
      id: 'kalshi:test',
      venue: 'Kalshi',
      yes_mid: 0.42,
      no_mid: 0.59,
      max_payout_per_contract: 1,
    }, {
      adjustedProbability: 0.55,
      contractSide: 'No',
    });

    expect(row).toMatchObject({
      yes: 0.42,
      no: 0.59,
      side: 'No',
      payoutMultiplier: 1,
      myProb: 0.55,
    });
  });
});
