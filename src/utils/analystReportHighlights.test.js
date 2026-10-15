import { analystReportHighlightRanges } from './analystReportHighlights';

const keys = (value, context) => analystReportHighlightRanges(value, context).map(range => value.slice(range.start, range.end));

test('salient account, position book, scan coverage and dates are blue', () => {
  const value = 'Account U25779973 has a fresh 71-position book. The engine scan covered 1,829 indexed publications on Oct 5, 2026 07:17 PDT.';
  expect(keys(value)).toEqual(['U25779973', '71', '1,829', 'Oct 5, 2026 07:17 PDT']);
  expect(keys('The engine scanned 1,829 registered publication snapshots spanning 28 Jul 2025–5 Oct 2026.'))
    .toEqual(['1,829', '28 Jul 2025', '5 Oct 2026']);
});

test('saved scope formats preserve count meaning without emphasizing unrelated financial values', () => {
  expect(keys('Current book: 73 rows; 73/73 fresh marks; 0 missing marks; 73/73 valued. Indexed research coverage: 18 available products.'))
    .toEqual(['73', '73/73', '73/73', '18']);
  expect(keys('P&L: -$1,829.71. Price 71. Quad 4. 71% Long exposure.')).toEqual([]);
});

test('both publication date orders and ISO calendar days receive emphasis', () => {
  expect(keys('Published 30 September · Sep 24, 2026 · 2026-10-05')).toEqual(['30 September', 'Sep 24, 2026', '2026-10-05']);
});

test('URLs and literal code stay untouched, and account column context supports captured identifiers', () => {
  expect(keys('https://example.com/U25779973/2026-10-05 `71 positions`')).toEqual([]);
  expect(keys('Account123', 'Account')).toEqual(['Account123']);
  expect(keys('71', 'Position count')).toEqual(['71']);
});
