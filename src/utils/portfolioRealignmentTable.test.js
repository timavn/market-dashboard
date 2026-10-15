import { displayRealignmentTable, isRealignmentTable, realignmentColumns } from './portfolioRealignmentTable';

const section = { id: 'refresh-realignment' };
const columns = ['Ticker', 'Security', 'Position', 'Source reading', 'Review action', 'Date'];
const blockFor = position => ({ type: 'table', columns, rows: [{
  cells: ['CVI', 'CVR Energy', position, 'Sell some', 'Review partial Long reduction', 'Sep 30, 2026'],
  citationIds: ['rta'], cellTitles: ['CVI', 'CVR Energy', 'Captured position', 'Exact partial sale', 'Review only', '2026-09-30T14:00:00Z'],
  cellCitationIds: [[], [], ['holdings'], ['rta'], ['rta'], ['rta']],
}] });

test.each([
  ['Long · 2.20%', 'Long', '2.20%'],
  ['Short 2.000%', 'Short', '2.000%'],
  ['Neutral · 0.00%', 'Neutral', '0.00%'],
  ['Long · —', 'Long', '—'],
  ['Long', 'Long', '—'],
  ['Unavailable', 'Unavailable', '—'],
  ['Long allocation pending', 'Long allocation pending', '—'],
  ['Long3.12%', 'Long3.12%', '—'],
])('saved realignment separates explicit bias and exact size from %s', (position, bias, size) => {
  const block = blockFor(position);
  const before = JSON.stringify(block);
  const displayed = displayRealignmentTable(section, block);
  expect(displayed.columns).toEqual(realignmentColumns);
  expect(displayed.rows[0].cells).toEqual(['CVI', 'CVR Energy', bias, size, 'Sell some', 'Review partial Long reduction', 'Sep 30, 2026']);
  expect(displayed.rows[0].cellTitles).toEqual(['CVI', 'CVR Energy', 'Captured position', 'Captured position', 'Exact partial sale', 'Review only', '2026-09-30T14:00:00Z']);
  expect(displayed.rows[0].cellCitationIds).toEqual([[], [], ['holdings'], ['holdings'], ['rta'], ['rta'], ['rta']]);
  expect(displayed.rows[0].citationIds).toEqual(['rta']);
  expect(JSON.stringify(block)).toBe(before);
  expect(displayed.rows[0].cellCitationIds[4]).not.toBe(block.rows[0].cellCitationIds[3]);
  expect(isRealignmentTable(section, displayed)).toBe(true);
  expect(displayRealignmentTable(section, displayed)).toBe(displayed);
});

test.each(['refresh-watch-list', 'refresh-aligned', 'position-confirmations'])('does not reformat %s tables', id => {
  const block = blockFor('Long · 2.20%');
  expect(displayRealignmentTable({ id }, block)).toBe(block);
  expect(isRealignmentTable({ id }, { ...block, columns: realignmentColumns })).toBe(false);
});

test('a new separated capture and an unrelated legacy schema pass through intact', () => {
  const current = { type: 'table', columns: realignmentColumns, rows: [{ cells: ['CVI', 'CVR Energy', 'Long', '2.20%', 'Sell some', 'Review partial Long reduction', 'Sep 30, 2026'] }] };
  expect(displayRealignmentTable(section, current)).toBe(current);
  const other = { ...blockFor('Long'), columns: ['Ticker', 'Security', 'Position', 'Product', 'Reading', 'Why'] };
  expect(displayRealignmentTable(section, other)).toBe(other);
});
