import { inferEventMacroAssetClass, isCpiMacroEvent } from './inferEventAssetClass';

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

  test('identifies CPI contracts for the macro contracts tab', () => {
    expect(isCpiMacroEvent({ question: 'Will CPI YoY exceed 3% in June?' })).toBe(true);
    expect(isCpiMacroEvent({ symbol: 'CPIY-26JUN-3.0', contract_title: 'June CPI above 3.0%' })).toBe(true);
    expect(isCpiMacroEvent({ question: 'Will PCE inflation exceed 3% in June?' })).toBe(false);
    expect(isCpiMacroEvent({ category: 'Inflation', question: 'Will PPI exceed 3%?' })).toBe(false);
  });
});
