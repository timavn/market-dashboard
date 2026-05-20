const { normalizeIbkrPosition, normalizeUploadedHolding } = require('../normalize/normalizePosition');
const mockIbkr = require('../__fixtures__/mockIbkrPosition.json');
const mockUpload = require('../__fixtures__/mockUploadHolding.json');

describe('normalizePosition', () => {
  it('normalizes IBKR position with quote', () => {
    const p = normalizeIbkrPosition(mockIbkr, {
      mark: 189.51,
      source: 'ibkr',
      timestamp: new Date().toISOString(),
    });
    expect(p.positionSource).toBe('ibkr_api');
    expect(p.conid).toBe(265598);
    expect(p.positionId).toBe('DU123456#265598');
    expect(p.marketValue).toBeCloseTo(18951, 0);
  });

  it('normalizes uploaded holding', () => {
    const h = normalizeUploadedHolding(mockUpload, 'snap1');
    expect(h.positionSource).toBe('uploaded_statement');
    expect(h.positionId).toBe('snap1#AAPL');
  });
});
