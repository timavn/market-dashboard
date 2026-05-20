import { inferEventMacroAssetClass } from './inferEventAssetClass';

describe('inferEventMacroAssetClass', () => {
  test('maps ingest categories directly', () => {
    expect(inferEventMacroAssetClass({ category: 'Index' })).toBe('EQ');
    expect(inferEventMacroAssetClass({ category: 'Rates' })).toBe('FI');
    expect(inferEventMacroAssetClass({ category: 'FX' })).toBe('FX');
    expect(inferEventMacroAssetClass({ category: 'Commodities' })).toBe('CMD');
    expect(inferEventMacroAssetClass({ category: 'Crypto' })).toBe('CRPT');
    expect(inferEventMacroAssetClass({ category: 'Credit' })).toBe('FI');
  });

  test('maps cross-cutting macro categories', () => {
    expect(inferEventMacroAssetClass({ category: 'Inflation' })).toBe('FI');
    expect(inferEventMacroAssetClass({ category: 'Labor' })).toBe('EQ');
    expect(inferEventMacroAssetClass({ category: 'Growth' })).toBe('EQ');
  });

  test('infers Other Macro from question text', () => {
    expect(
      inferEventMacroAssetClass({
        category: 'Other Macro',
        question: 'Will CPI YoY exceed 3% in June?',
      }),
    ).toBe('FI');
    expect(
      inferEventMacroAssetClass({
        category: 'Other Macro',
        question: 'Will the S&P 500 close above 6000?',
      }),
    ).toBe('EQ');
    expect(
      inferEventMacroAssetClass({
        category: 'Other Macro',
        question: 'Will bitcoin trade above $100k?',
      }),
    ).toBe('CRPT');
  });

  test('returns null for unclassifiable events', () => {
    expect(
      inferEventMacroAssetClass({
        category: 'Other Macro',
        question: 'Will the mayor win re-election?',
      }),
    ).toBeNull();
    expect(inferEventMacroAssetClass(null)).toBeNull();
  });
});
