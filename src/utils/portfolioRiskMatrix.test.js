import { buildRiskMatrixRollup, quadFit } from './portfolioRiskMatrix';

const label = (symbol, assetClass, group, region, beta, riskSharePct) => ({ symbol, assetClass, group, region, beta, riskSharePct });
const riskRows = [
  label('XLU', 'Equity', 'Utilities', 'US', 0.5, 10),
  label('JACK', 'Equity', 'Consumer Discretionary', 'US', 1.2, 30),
  label('EWJ', 'Equity', 'Broad', 'Japan', 0.7, 8),
  label('IWM', 'Equity', 'Broad', 'US', 1.1, 12),
  label('TLT', 'Fixed income', 'Rates', 'US', -0.1, 20),
  label('CLOX', 'Fixed income', 'Credit', 'US', 0, 1),
  label('CAOS', 'Alternative', 'Equity hedge', 'US', -0.2, -3),
  label('BTAL', 'Alternative', 'Equity hedge', 'US', -1, -5),
  { symbol: 'NEWCO', assetClass: null, group: null, region: null, beta: 1, riskSharePct: 27 },
];
const holdings = [
  ['XLU', 3000], ['JACK', -2000], ['EWJ', -1500], ['IWM', -1500], ['TLT', 3500], ['CLOX', 3400], ['CAOS', 2700], ['BTAL', 2000], ['NEWCO', 1000],
].map(([symbol, marketValue]) => ({ symbol, marketValue }));
const rollup = () => buildRiskMatrixRollup({ holdings, nav: 100000, riskRows });
const row = id => rollup().find(item => item.id === id);

describe('risk matrix rollup', () => {
  test('rolls the book up by asset class, then group, in a fixed order', () => {
    expect(rollup().map(item => item.label)).toEqual([
      'Equity', 'Broad · US', 'Consumer Discretionary', 'Utilities', 'Japan',
      'Fixed income', 'Credit', 'Rates', 'Alternative · Equity hedge', 'Unlabelled',
    ]);
  });

  test('net, gross, risk share and beta contribution add up per row', () => {
    expect(row('Equity')).toMatchObject({ positions: 4, unmeasured: 0 });
    expect(row('Equity').netPct).toBeCloseTo(-2, 6);
    expect(row('Equity').grossPct).toBeCloseTo(8, 6);
    expect(row('Equity').riskSharePct).toBeCloseTo(60, 6);
    expect(row('Equity').beta).toBeCloseTo(0.5 * 0.03 - 1.2 * 0.02 - 0.7 * 0.015 - 1.1 * 0.015, 6);
    expect(row('Alternative')).toMatchObject({ positions: 2, symbols: ['CAOS', 'BTAL'] });
    expect(row('Alternative').riskSharePct).toBeCloseTo(-8, 6);
  });

  test('a holding nobody has labelled is its own row, never filed by guess', () => {
    expect(row('Unlabelled')).toMatchObject({ positions: 1, symbols: ['NEWCO'], playbook: null });
  });

  test('a position without a risk reading counts in exposure but not in risk', () => {
    const rows = buildRiskMatrixRollup({ holdings, nav: 100000, riskRows: riskRows.map(item => (item.symbol === 'TLT' ? { ...item, beta: null, riskSharePct: null } : item)) });
    expect(rows.find(item => item.id === 'Fixed income/Rates')).toMatchObject({ riskSharePct: null, beta: null, unmeasured: 1 });
    expect(rows.find(item => item.id === 'Fixed income').riskSharePct).toBeCloseTo(1, 6);
  });

  test('every exposure in the universe has a row, at zero when nothing is held', () => {
    const universe = [['Equity', 'Energy', 'US'], ['Equity', 'Broad', 'Brazil'], ['Equity', 'Utilities', 'US'], ['Commodity', 'Gold', 'Global'],
      ['Commodity', 'Broad', 'Global'], ['Fixed income', 'Cash', 'US'], ['Currency', 'US dollar', 'US'], ['Currency', 'Euro', 'Europe']];
    const rows = buildRiskMatrixRollup({ holdings, nav: 100000, riskRows, universe });
    expect(rows.map(item => item.label)).toEqual([
      'Equity', 'Broad · US', 'Consumer Discretionary', 'Energy', 'Utilities', 'Brazil', 'Japan',
      'Fixed income', 'Cash', 'Credit', 'Rates', 'Commodity', 'Broad', 'Gold', 'Currency', 'Euro', 'US dollar',
      'Alternative · Equity hedge', 'Unlabelled',
    ]);
    const find = id => rows.find(item => item.id === id);
    expect(find('Equity/Energy')).toMatchObject({ positions: 0, symbols: [], netPct: 0, grossPct: 0, riskSharePct: 0, beta: 0, unmeasured: 0 });
    expect(find('Equity').positions).toBe(4);
    expect(quadFit(find('Equity/Energy').playbook, 4)).toBe('worst');
    expect(quadFit(find('Commodity/Gold').playbook, 4)).toBe('best');
    expect(quadFit(find('Currency/US dollar').playbook, 1)).toBe('worst');
    expect(quadFit(find('Fixed income/Cash').playbook, 4)).toBeNull();
    expect(quadFit(find('Equity/Brazil').playbook, 1)).toBeNull();
  });

  test('no NAV means no table', () => {
    expect(buildRiskMatrixRollup({ holdings, nav: 0, riskRows })).toEqual([]);
  });

  test('quad fit reads the playbook for the label, and is blank where Hedgeye has no view', () => {
    expect(quadFit(row('Equity').playbook, 1)).toBe('best');
    expect(quadFit(row('Equity/Utilities').playbook, 1)).toBe('worst');
    expect(quadFit(row('Fixed income/Credit').playbook, 3)).toBe('worst');
    expect(quadFit(row('Fixed income/Rates').playbook, 1)).toBe('worst');
    expect(quadFit(row('Equity/Japan').playbook, 1)).toBeNull();
    expect(quadFit(row('Alternative').playbook, 1)).toBeNull();
    expect(quadFit(row('Equity').playbook, null)).toBeNull();
  });
});
