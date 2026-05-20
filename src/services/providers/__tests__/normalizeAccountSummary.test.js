const { normalizeAccountSummary } = require('../normalize/normalizeAccountSummary');
const mockSummary = require('../__fixtures__/mockIbkrAccountSummary.json');

describe('normalizeAccountSummary', () => {
  it('maps IB tag fields to canonical summary', () => {
    const s = normalizeAccountSummary(mockSummary);
    expect(s.netLiquidation).toBe(1000000);
    expect(s.buyingPower).toBe(2000000);
    expect(s.sma).toBe(950000);
    expect(s.currency).toBe('USD');
  });
});
