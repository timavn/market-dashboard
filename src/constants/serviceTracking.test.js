import { COST_INVENTORY, calculateTotals } from './serviceTracking';

describe('service cost inventory', () => {
  test('separates fixed, metered, expected, and dormant billing', () => {
    expect(COST_INVENTORY).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: 'Nous Plus (Hermes)', category: 'Fixed', billing: '$20/month' }),
      expect.objectContaining({ service: 'AWS', category: 'Metered' }),
      expect.objectContaining({ service: 'IBKR market data', category: 'Expected' }),
      expect.objectContaining({ service: 'Hedgeye products', category: 'Expected' }),
      expect.objectContaining({ service: 'OpenAI API', category: 'Dormant' }),
    ]));
  });

  test('does not publish a synthetic grand total for metered services', () => {
    expect(calculateTotals()).not.toHaveProperty('grandTotal');
  });
});
