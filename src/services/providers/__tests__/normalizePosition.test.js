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

  it('marks marketValue missing instead of fabricating it from avgCost', () => {
    const p = normalizeIbkrPosition(
      { symbol: 'AAPL', position: 10, avgCost: 150, account: 'U1', secType: 'STK' },
      null,
    );
    expect(p.marketValue).toBe(null);
    expect(p.warning).toBe('missing_market_value');
  });

  it('classifies IBKR prediction market contracts without quote warnings', () => {
    const p = normalizeIbkrPosition(
      {
        symbol: 'KXCPIYOY',
        localSymbol: 'KXCPIYOY-26JUN-T4.2_NO',
        position: -1,
        avgCost: 0.51,
        account: 'U1',
        secType: 'OPT',
      },
      null,
    );
    expect(p.isPredictionMarket).toBe(true);
    expect(p.assetClass).toBe('Prediction Markets');
    expect(p.marketValue).toBe(null);
    expect(p.warning).toBe(null);
  });
});
