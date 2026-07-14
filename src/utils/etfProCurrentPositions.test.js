const fs = require('fs');
const path = require('path');
const {
  buildEtfProCurrentPositionsPayload,
  parseEtfProCurrentPositionsText,
  summarizeEtfProRows,
} = require('./etfProCurrentPositions.cjs');

const fixturePath = path.join(__dirname, '__fixtures__', 'etfProCurrentPositions-2026-06-14.txt');
const june28FixturePath = path.join(__dirname, '__fixtures__', 'etfProCurrentPositions-2026-06-28.txt');

describe('ETF Pro current positions parser', () => {
  test('parses pasted Current Open Positions table into the authoritative book', () => {
    const text = fs.readFileSync(fixturePath, 'utf8');
    const payload = buildEtfProCurrentPositionsPayload(text, {
      snapshotDate: '2026-06-14',
      parsedAt: '2026-06-14T12:00:00.000Z',
    });
    const summary = summarizeEtfProRows(payload.rows);

    expect(payload.meta.sourceKind).toBe('active-open-positions');
    expect(payload.rows).toHaveLength(39);
    expect(summary.longCount).toBe(18);
    expect(summary.shortCount).toBe(21);
    expect(summary.longs).toEqual([
      'LQD', 'FXH', 'PINK', 'BNDD', 'TINY', 'XAR', 'BUG', 'DBMF', 'UUP',
      'DRAM', 'VXF', 'QTUM', 'VYM', 'CPER', 'CLOZ', 'CLOX', 'AAAU', 'BUXX',
    ]);
    expect(summary.shorts).toEqual([
      'EZA', 'MSTY', 'HARD', 'IBIT', 'EWG', 'USO', 'EWA', 'XLY', 'TUR',
      'AGNG', 'FXE', 'PAWZ', 'WOOD', 'INQQ', 'EWZ', 'BTAL', 'IHI', 'IDX',
      'EPHE', 'PALL', 'INDA',
    ]);
  });

  test('normalizes money, percent fields, and malformed risk ranges', () => {
    const text = fs.readFileSync(fixturePath, 'utf8');
    const parsed = parseEtfProCurrentPositionsText(text);
    const vym = parsed.rows.find((row) => row.ticker === 'VYM');
    const eza = parsed.rows.find((row) => row.ticker === 'EZA');

    expect(eza.entryPrice).toBe(66.43);
    expect(eza.recentPrice).toBe(66.87);
    expect(eza.absolutePerformance).toBe(-0.66);
    expect(eza.percentFromLowEnd).toBe(6.97);
    expect(vym.trendLowEnd).toBeNull();
    expect(vym.trendHighEnd).toBe(163);
    expect(parsed.warnings).toContain('Discarded malformed trend low for VYM: $156,155.00');
  });

  test('parses the June 28 ETF Pro calibration book', () => {
    const text = fs.readFileSync(june28FixturePath, 'utf8');
    const payload = buildEtfProCurrentPositionsPayload(text, {
      snapshotDate: '2026-06-28',
      parsedAt: '2026-06-28T00:00:00-07:00',
    });
    const summary = summarizeEtfProRows(payload.rows);

    expect(payload.meta).toMatchObject({
      snapshotDate: '2026-06-28',
      sourceKind: 'active-open-positions',
      rowCount: 39,
      longCount: 20,
      shortCount: 19,
    });
    expect(payload.rows).toHaveLength(39);
    expect(summary.longCount).toBe(20);
    expect(summary.shortCount).toBe(19);
    expect(payload.rows.find((row) => row.ticker === 'UGA')).toMatchObject({ call: 'Short' });
    expect(payload.rows.find((row) => row.ticker === 'VYMI')).toMatchObject({ call: 'Long' });
    expect(payload.rows.find((row) => row.ticker === 'BUXX')).toMatchObject({ call: 'Long' });
    expect(summary.longs).toEqual([
      'VYMI', 'DBJP', 'XHB', 'TLT', 'IAK', 'XLV', 'XLRE', 'LQD', 'FXH',
      'BNDD', 'TINY', 'XAR', 'UUP', 'DRAM', 'VXF', 'VYM', 'CLOZ', 'CLOX',
      'AAAU', 'BUXX',
    ]);
    expect(summary.shorts).toEqual([
      'UGA', 'EIS', 'IVES', 'XLY', 'MAGS', 'EWM', 'URA', 'SOLZ', 'MSTY',
      'HARD', 'IBIT', 'EWG', 'USO', 'FXE', 'EWZ', 'BTAL', 'IHI', 'IDX',
      'PALL',
    ]);
  });
});
