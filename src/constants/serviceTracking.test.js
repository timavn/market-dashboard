import { COST_INVENTORY, SERVICE_CONFIG, calculateTotals } from './serviceTracking';

describe('service cost inventory', () => {
  test('the service inventory lists only the current Analyst agent', () => {
    const entries = Object.values(SERVICE_CONFIG).flatMap(group => Object.values(group));
    expect(entries.some(entry => entry.name === 'The Analyst')).toBe(true);
    expect(entries.some(entry => /Quant Analyst|Quant Developer|Hermes Security|Managing Director|Hermes Director/.test(entry.name))).toBe(false);
    expect(Object.values(SERVICE_CONFIG.internal).some(entry => entry.endpoint?.startsWith('/api/hermes/director/'))).toBe(false);
  });
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
