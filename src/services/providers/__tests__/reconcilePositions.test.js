const { reconcilePositions } = require('../normalize/reconcilePositions');
const { normalizeIbkrPosition, normalizeUploadedHolding } = require('../normalize/normalizePosition');
const mockIbkr = require('../__fixtures__/mockIbkrPosition.json');
const mockUpload = require('../__fixtures__/mockUploadHolding.json');

describe('reconcilePositions', () => {
  it('warns on quantity mismatch', () => {
    const ibkr = [normalizeIbkrPosition(mockIbkr)];
    const upload = [normalizeUploadedHolding(mockUpload, 's1')];
    const warnings = reconcilePositions(ibkr, upload);
    expect(warnings.some((w) => w.includes('Quantity mismatch'))).toBe(true);
  });

  it('returns empty when one side missing', () => {
    expect(reconcilePositions([], [])).toEqual([]);
    expect(reconcilePositions([normalizeIbkrPosition(mockIbkr)], [])).toEqual([]);
  });
});
