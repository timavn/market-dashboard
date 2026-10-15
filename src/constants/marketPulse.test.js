import marketBackdropCatalog from './marketBackdropCatalog.json';
import { PULSE_CATEGORIES, resolvePulseInstrument } from './marketPulse';

const category = (id) => PULSE_CATEGORIES.find((entry) => entry.id === id);

describe('market pulse instruments', () => {
  test('resolves configured provider aliases while preserving the configured instrument identity', () => {
    ['PL', ' pl=f ', '#pLaTiNuM'].forEach((symbol) => {
      expect(resolvePulseInstrument({ symbol }, category('commodities'))).toEqual(
        expect.objectContaining({ symbol: 'PL', ticker: 'PL', label: 'Platinum futures' }),
      );
    });
    expect(resolvePulseInstrument({ ticker: '^klse' }, category('global'))?.symbol).toBe('KLSE');
    expect(resolvePulseInstrument({ symbol: '000001.SS' }, category('global'))?.symbol).toBe('SSEC');
  });

  test('rejects unknown symbols, wrong categories, and ETF substitutes for configured futures', () => {
    expect(resolvePulseInstrument({ symbol: 'UNKNOWN', name: 'Platinum futures' }, category('commodities'))).toBeNull();
    expect(resolvePulseInstrument({ symbol: 'PPLT' }, category('commodities'))).toBeNull();
    expect(resolvePulseInstrument({ symbol: 'BKLN' }, category('sectors'))).toBeNull();
    expect(resolvePulseInstrument(null, category('credit'))).toBeNull();
    expect(resolvePulseInstrument({ symbol: 'BKLN' }, null)).toBeNull();
  });

  test('blocks displayed assets and their provider or exposure aliases even if a category adds them', () => {
    const symbols = ['SPX', '^GSPC', 'SPY', 'XLF', 'XLRE', 'GC=F', 'GOLD', 'SILVER', 'COPPER', 'BTC-USD', 'UUP', 'UST10Y'];
    const accidentalDuplicates = { instruments: symbols.map((symbol) => ({ symbol, ticker: symbol })) };
    symbols.forEach((symbol) => {
      expect(resolvePulseInstrument({ symbol }, accidentalDuplicates)).toBeNull();
    });
  });

  test('keeps every configured candidate eligible without repeating visible price series', () => {
    PULSE_CATEGORIES.forEach((entry) => {
      entry.instruments.forEach((candidate) => {
        expect(resolvePulseInstrument({ symbol: candidate.symbol }, entry)).toBe(candidate);
      });
    });
  });

  test('automatically excludes an instrument when the backdrop promotes it into the visible summary', () => {
    const promotedCatalog = marketBackdropCatalog.map((group) => ({
      ...group,
      rows: group.rows.map((row) => row.symbol === 'PL' ? { ...row, summary: true } : row),
    }));
    jest.doMock('./marketBackdropCatalog.json', () => promotedCatalog);
    try {
      jest.isolateModules(() => {
        const updated = require('./marketPulse');
        const commodities = updated.PULSE_CATEGORIES.find((entry) => entry.id === 'commodities');
        expect(updated.resolvePulseInstrument({ symbol: 'PL=F' }, commodities)).toBeNull();
        expect(updated.resolvePulseInstrument({ symbol: 'PLATINUM' }, commodities)).toBeNull();
        expect(updated.resolvePulseInstrument({ symbol: 'PA' }, commodities)?.symbol).toBe('PA');
      });
    } finally {
      jest.dontMock('./marketBackdropCatalog.json');
    }
  });
});
