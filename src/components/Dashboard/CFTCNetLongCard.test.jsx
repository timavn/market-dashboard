import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import CFTCNetLongCard from './CFTCNetLongCard';

jest.mock('axios', () => ({ get: jest.fn() }));


const CURRENT_ROW = {
  category: 'EQUITIES',
  metric: 'SPX (Index + E-mini)',
  cftcContractMarketCode: '13874A',
  seriesType: 'legacy-noncommercial-combined',
  asOf: '2026-08-11',
  status: 'current',
  decisionEligible: true,
  latest: 25427,
  wwChg: 32375,
  zScore1Y: 2.42,
  zScore3Y: 1.62,
};

const snapshot = (overrides = {}) => ({
  date: '2026-08-11',
  reportDate: '2026-08-11',
  source: 'cftc-public-reporting-environment',
  snapshotType: 'cftc-positioning',
  schemaVersion: 'cftc-positioning-v2',
  calculationVersion: 'cftc-combined-net-sample-z-v1',
  sourceContentHash: 'a'.repeat(64),
  datasetIds: { legacy: 'srt6-5q2f', disaggregated: 'rxbv-e226' },
  retrievedAt: '2026-08-14T19:09:03Z',
  sourceUrls: {
    legacy: 'https://publicreporting.cftc.gov/Commitments-of-Traders/Legacy_All/srt6-5q2f',
    disaggregated: 'https://publicreporting.cftc.gov/Commitments-of-Traders/Disaggregated_All/rxbv-e226',
  },
  contentComplete: true,
  decisionEligible: true,
  data: [CURRENT_ROW],
  ...overrides,
});

const resource = (data, overrides = {}) => ({
  data,
  loading: false,
  refreshing: false,
  error: null,
  ...overrides,
});

describe('CFTCNetLongCard', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-17T15:00:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('renders the loading state without stale rows', () => {
    render(<CFTCNetLongCard resourceState={resource(null, { loading: true })} />);
    expect(screen.getByText('Loading CFTC Data...')).toBeInTheDocument();
    expect(screen.queryByText('SPX (Index + E-mini)')).not.toBeInTheDocument();
  });

  test('uses the official report date as the latest-column header without a separate toolbar row', () => {
    render(<CFTCNetLongCard resourceState={resource(snapshot())} />);
    expect(screen.getByRole('columnheader', { name: '8/11/26' })).toHaveAttribute('title', 'AS OF AUG 11');
    expect(screen.queryByRole('columnheader', { name: 'Latest' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('cftc-source-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cftc-freshness')).not.toBeInTheDocument();
    expect(screen.queryByText('OFFICIAL CFTC', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('AS OF AUG 11', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText('SPX (Index + E-mini)')).toBeInTheDocument();
    expect(screen.getByText('25,427')).toBeInTheDocument();
    expect(screen.getByText(/Official Combined futures \+ options/)).toBeInTheDocument();
  });

  test('keeps every contract in one table with the Macro Show columns and category groups', () => {
    const categories = [
      ['EQUITIES', 5], ['RATES', 6], ['CURRENCIES', 9], ['COMMODITIES', 18], ['CRYPTO', 1],
    ];
    const rows = categories.flatMap(([category, count]) => Array.from({ length: count }, (_, index) => ({
      ...CURRENT_ROW,
      category,
      metric: `${category} contract ${index + 1}`,
      cftcContractMarketCode: `${category}-${index}`,
    })));
    render(<CFTCNetLongCard resourceState={resource(snapshot({ data: rows }))} />);

    const table = screen.getByRole('table', { name: 'CFTC positioning' });
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(within(table).getAllByRole('button')).toHaveLength(39);
    for (const row of rows) {
      const group = within(table).getByRole('rowgroup', { name: row.category });
      expect(within(group).getByRole('rowheader', { name: row.metric, exact: true })).toBeVisible();
    }
    for (const [category, count] of categories) {
      const group = within(table).getByRole('rowgroup', { name: category });
      expect(within(group).getAllByRole('row')).toHaveLength(count);
    }
    expect(within(table).getAllByRole('columnheader').map(header => header.textContent))
      .toEqual(expect.arrayContaining(['Metric', '8/11/26', 'W/W Chg', '3M Avg', '6M Avg', '1Y Avg', '3Y', 'Max', 'Min', 'Z-Score', '1Y']));
    expect(within(table).getByRole('columnheader', { name: 'Z-Score' })).toHaveAttribute('colspan', '2');
    expect(within(table).getAllByRole('columnheader', { name: '3Y', exact: true }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ colSpan: 2 })]));
  });

  test('keeps a single-category report in the same unified table', () => {
    render(<CFTCNetLongCard resourceState={resource(snapshot())} />);
    const table = screen.getByRole('table', { name: 'CFTC positioning' });
    expect(within(table).getByRole('rowgroup', { name: 'EQUITIES' })).toBeVisible();
    expect(within(table).getByRole('rowheader', { name: CURRENT_ROW.metric })).toBeVisible();
  });

  test('shows partial and unavailable rows explicitly', () => {
    const partial = {
      ...CURRENT_ROW,
      category: 'COMMODITIES',
      metric: 'GOLD',
      cftcContractMarketCode: '088691',
      seriesType: 'disaggregated-managed-money-combined',
      status: 'partial',
      decisionEligible: false,
      zScore3Y: null,
    };
    const unavailable = {
      ...partial,
      metric: 'COPPER',
      cftcContractMarketCode: '085692',
      status: 'unavailable',
      latest: null,
      wwChg: null,
      zScore1Y: null,
    };
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      contentComplete: false,
      data: [CURRENT_ROW, partial, unavailable],
    }))} />);
    expect(screen.getByRole('columnheader', { name: '8/11/26' })).toHaveAttribute('title', 'PARTIAL · AS OF AUG 11');
    expect(screen.getByTestId('cftc-row-status-088691')).toHaveTextContent('PARTIAL');
    expect(screen.getByTestId('cftc-row-status-085692')).toHaveTextContent('UNAVAILABLE');
  });

  test('preserves the stale report date with its reference-only disclosure on the column header', () => {
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      date: '2026-07-28',
      reportDate: '2026-07-28',
      data: [{ ...CURRENT_ROW, asOf: '2026-07-28' }],
    }))} />);
    expect(screen.getByRole('columnheader', { name: '7/28/26' }))
      .toHaveAttribute('title', 'STALE · REFERENCE ONLY · AS OF JUL 28');
  });

  test.each([
    ['failed refresh', {}, { error: 'Refresh unavailable' }],
    ['stale cache', { cacheState: 'stale' }, {}],
  ])('preserves the original date and reference-only label after a %s', (_label, overrides, state) => {
    render(<CFTCNetLongCard resourceState={resource(snapshot(overrides), state)} />);
    expect(screen.getByRole('columnheader', { name: '8/11/26' }))
      .toHaveAttribute('title', 'STALE · REFERENCE ONLY · AS OF AUG 11');
    expect(screen.getByText('25,427')).toBeInTheDocument();
    expect(screen.queryByText(/\bLIVE\b/)).not.toBeInTheDocument();
  });

  test('shows a quiet unavailable state when the initial request fails', () => {
    render(<CFTCNetLongCard resourceState={resource(null, { error: 'Failed to load CFTC data' })} />);
    expect(screen.getByText('UNAVAILABLE')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('renders an explicit unavailable body when the official table has no rows', () => {
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      contentComplete: false,
      decisionEligible: false,
      data: [],
    }))} />);
    expect(screen.getByTestId('cftc-unavailable')).toHaveTextContent('OFFICIAL CFTC ROWS UNAVAILABLE');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '8/11/26' })).not.toBeInTheDocument();
  });

  test('changes the header only when the official report date changes, never on a daily retrieval', () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-17T15:00:00Z'));
    const first = snapshot({
      date: '2026-09-08', reportDate: '2026-09-08', retrievedAt: '2026-09-11T20:15:00Z',
      data: [{ ...CURRENT_ROW, asOf: '2026-09-08' }],
    });
    const { rerender } = render(<CFTCNetLongCard resourceState={resource(first)} />);
    expect(screen.getByRole('columnheader', { name: '9/8/26' })).toHaveAttribute('title', 'AS OF SEP 8');

    rerender(<CFTCNetLongCard resourceState={resource({ ...first, retrievedAt: '2026-09-17T14:00:00Z' })} />);
    expect(screen.getByRole('columnheader', { name: '9/8/26' })).toBeVisible();
    expect(screen.queryByRole('columnheader', { name: '9/17/26' })).not.toBeInTheDocument();

    const next = {
      ...first, date: '2026-09-15', reportDate: '2026-09-15', retrievedAt: '2026-09-17T14:00:00Z',
      data: [{ ...CURRENT_ROW, asOf: '2026-09-15' }],
    };
    rerender(<CFTCNetLongCard resourceState={resource(next)} />);
    expect(screen.getByRole('columnheader', { name: '9/15/26' })).toHaveAttribute('title', 'AS OF SEP 15');
    expect(screen.queryByRole('columnheader', { name: '9/8/26' })).not.toBeInTheDocument();
  });

  test('preserves Eurodollar as a dated discontinued reference', () => {
    const eurodollar = {
      category: 'RATES',
      metric: 'Eurodollar',
      cftcContractMarketCode: '132741',
      seriesType: 'legacy-noncommercial-combined',
      asOf: '2023-06-13',
      status: 'discontinued',
      decisionEligible: false,
      latest: 47762,
      wwChg: -6488,
      zScore1Y: null,
      zScore3Y: null,
    };
    render(<CFTCNetLongCard resourceState={resource(snapshot({ data: [CURRENT_ROW, eurodollar] }))} />);
    expect(screen.getByTestId('cftc-row-status-132741')).toHaveTextContent(
      'DISCONTINUED · 2023-06-13',
    );
  });

  test('opens a compact detail from the row and shows full-precision history with display-only rounding', async () => {
    const row = {
      ...CURRENT_ROW,
      seriesId: '13874A:legacy-noncommercial-combined',
      zScore1Y: 2.42549,
      historyStatistics: {
        average3M: 12345.6789,
        average6M: 20001.231,
        average1Y: 23456.9,
        maximum3Y: 35000,
        minimum3Y: -45000,
      },
    };
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      schemaVersion: 'cftc-positioning-v3',
      calculationVersion: 'cftc-combined-net-sample-z-v2',
      data: [row],
    }))} />);
    const table = screen.getByRole('table', { name: 'CFTC positioning' });
    expect(within(table).getAllByRole('cell').map(cell => cell.textContent))
      .toEqual(['25,427', '32,375', '12,346', '20,001', '23,457', '35,000', '(45,000)', '2.43X', '1.62X']);
    await userEvent.click(screen.getByText('25,427'));
    const dialog = screen.getByRole('dialog', { name: 'SPX (Index + E-mini) positioning' });
    expect(within(dialog).getByText('12,346')).toBeInTheDocument();
    expect(within(dialog).getByText('20,001')).toBeInTheDocument();
    expect(within(dialog).getByText('23,457')).toBeInTheDocument();
    expect(within(dialog).getByText('35,000')).toBeInTheDocument();
    expect(within(dialog).getByText('-45,000')).toBeInTheDocument();
    expect(within(dialog).getByText('2.43')).toBeInTheDocument();
    expect(within(dialog).getByText('-45,000')).toHaveClass('is-negative');
    expect(within(dialog).getByText('2.43')).toHaveClass('is-positive', 'is-extreme');
    expect(within(dialog).getByText('1.62')).toHaveClass('is-positive');
    expect(within(dialog).getByText('1.62')).not.toHaveClass('is-extreme');
    expect(within(dialog).getByText('25,427')).not.toHaveClass('is-positive');
    expect(row.historyStatistics.average3M).toBe(12345.6789);
    expect(row.zScore1Y).toBe(2.42549);
    expect(within(dialog).getByText('Aug 11, 2026')).toBeInTheDocument();
    expect(within(dialog).getByText('Aug 14, 2026 12:09 PT')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Official CFTC source ↗' })).toHaveAttribute('href', snapshot().sourceUrls.legacy);
    expect(within(dialog).getByText(/13, 26 and 52 weekly observations; 3Y uses 156/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Colors describe positioning, not buy or sell signals/)).toBeInTheDocument();
  });

  test('provides keyboard opening, focus trapping, Escape dismissal and focus restoration', async () => {
    render(<CFTCNetLongCard resourceState={resource(snapshot())} />);
    const trigger = screen.getByRole('button', { name: CURRENT_ROW.metric });
    await userEvent.tab();
    expect(trigger).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const close = screen.getByRole('button', { name: 'Close positioning details' });
    expect(close).toHaveFocus();
    const source = screen.getByRole('link', { name: 'Official CFTC source ↗' });
    await userEvent.tab({ shift: true });
    expect(source).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('cftc-detail-backdrop'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('keeps managed money as a separately dated alternative to primary legacy Silver', async () => {
    const silver = {
      ...CURRENT_ROW,
      category: 'COMMODITIES',
      metric: 'SILVER',
      cftcContractMarketCode: '084691',
      latest: 24736,
      wwChg: -500,
      zScore1Y: -0.41,
      zScore3Y: -0.89,
      alternateSeries: [{
        ...CURRENT_ROW,
        metric: 'SILVER',
        cftcContractMarketCode: '084691',
        seriesType: 'disaggregated-managed-money-combined',
        sourceUrl: snapshot().sourceUrls.disaggregated,
        latest: 14176,
        wwChg: 2006,
        zScore1Y: -0.13,
        zScore3Y: -0.68,
        historyStatistics: { average3M: 18000, average6M: 19000, average1Y: 20000, maximum3Y: 45000, minimum3Y: -12000 },
      }],
    };
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      schemaVersion: 'cftc-positioning-v3',
      calculationVersion: 'cftc-combined-net-sample-z-v2',
      data: [silver],
    }))} />);
    expect(screen.getByText('24,736')).toBeInTheDocument();
    expect(screen.getByText('(500)')).toBeInTheDocument();
    expect(screen.getByText('-0.41X')).toBeInTheDocument();
    expect(screen.queryByText('14,176')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'SILVER' }));
    const alternative = screen.getByRole('region', { name: 'Alternative trader group' });
    expect(within(alternative).getByText('14,176')).toBeInTheDocument();
    expect(within(alternative).getByText('+2,006')).toBeInTheDocument();
    expect(within(alternative).getByText(/Disaggregated managed money/)).toBeInTheDocument();
    expect(within(alternative).getByRole('link')).toHaveAttribute('href', snapshot().sourceUrls.disaggregated);
    const history = within(alternative).getByRole('region', { name: 'Alternative historical positioning context' });
    expect(within(history).getByText('18,000')).toBeInTheDocument();
    expect(within(history).getByText('-12,000')).toBeInTheDocument();
    expect(within(history).getByText('-12,000')).toHaveClass('is-negative');
    expect(within(alternative).getByText('-0.13')).toHaveClass('is-negative');
    expect(within(alternative).getByText('-0.13')).not.toHaveClass('is-extreme');
  });

  test('keeps old v2 reports readable without inventing historical context', async () => {
    render(<CFTCNetLongCard resourceState={resource(snapshot())} />);
    expect(within(screen.getByRole('table', { name: 'CFTC positioning' })).getAllByText('—')).toHaveLength(5);
    await userEvent.click(screen.getByRole('button', { name: CURRENT_ROW.metric }));
    const history = screen.getByRole('region', { name: 'Historical positioning context' });
    expect(within(history).getAllByText('—')).toHaveLength(5);
    expect(within(history).getByText('Historical statistics unavailable for this snapshot.')).toBeInTheDocument();
  });

  test.each([
    { source: 'mock' }, { mock: true }, { seeded: true }, { cacheOnly: true },
    { sourceVerified: false }, { schemaVersion: 'cftc-positioning-v99' },
    { reportDate: '2026-02-30' }, { snapshotType: 'other' },
    { date: '2026-08-04' }, { sourceContentHash: null },
    { datasetIds: { legacy: 'wrong' } }, { date: '2026-08-18', reportDate: '2026-08-18' },
  ])('suppresses unverified snapshot values: %j', overrides => {
    render(<CFTCNetLongCard resourceState={resource(snapshot(overrides))} />);
    expect(screen.queryByText('25,427')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '8/11/26' })).not.toBeInTheDocument();
    expect(screen.getByTestId('cftc-unavailable')).toBeInTheDocument();
  });

  test.each([
    { source: 'synthetic' }, { mock: true }, { seeded: true }, { cacheOnly: true },
    { sourceVerified: false }, { status: 'unavailable' }, { asOf: 'invalid' },
    { asOf: '2026-08-04' }, { asOf: '2026-08-18' },
    { datasetId: 'rxbv-e226' }, { seriesId: 'wrong:legacy-noncommercial-combined' },
  ])('preserves the roster while suppressing unverified row numbers: %j', async overrides => {
    render(<CFTCNetLongCard resourceState={resource(snapshot({ data: [{ ...CURRENT_ROW, ...overrides }] }))} />);
    expect(screen.getByRole('button', { name: CURRENT_ROW.metric })).toBeInTheDocument();
    expect(screen.queryByText('25,427')).not.toBeInTheDocument();
    for (const cell of screen.getAllByRole('cell')) {
      expect(cell).toHaveClass('is-unavailable');
      expect(cell).not.toHaveClass('is-extreme');
    }
    await userEvent.click(screen.getByRole('button', { name: CURRENT_ROW.metric }));
    expect(screen.getByText('VERIFIED POSITIONING UNAVAILABLE')).toBeInTheDocument();
  });

  test.each([
    { cftcContractMarketCode: '088691' }, { asOf: '2026-08-04' },
    { datasetId: 'srt6-5q2f' }, { seriesId: 'wrong:disaggregated-managed-money-combined' },
    { mock: true }, { seeded: true }, { sourceVerified: false },
  ])('suppresses an invalid alternate cohort independently of the primary row: %j', async overrides => {
    const silver = {
      ...CURRENT_ROW,
      metric: 'SILVER',
      cftcContractMarketCode: '084691',
      latest: 24736,
      alternateSeries: [{
        ...CURRENT_ROW,
        metric: 'SILVER',
        cftcContractMarketCode: '084691',
        seriesType: 'disaggregated-managed-money-combined',
        latest: 14176,
        ...overrides,
      }],
    };
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      schemaVersion: 'cftc-positioning-v3', calculationVersion: 'cftc-combined-net-sample-z-v2',
      data: [silver],
    }))} />);
    await userEvent.click(screen.getByRole('button', { name: 'SILVER' }));
    expect(screen.queryByRole('region', { name: 'Alternative trader group' })).not.toBeInTheDocument();
    expect(screen.queryByText('14,176')).not.toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText('24,736')).toBeInTheDocument();
  });

  test('retains dated details after refresh failure and clears them if source verification is revoked', async () => {
    const { rerender } = render(<CFTCNetLongCard resourceState={resource(snapshot())} />);
    await userEvent.click(screen.getByRole('button', { name: CURRENT_ROW.metric }));
    rerender(<CFTCNetLongCard resourceState={resource(snapshot(), { error: 'Refresh failed' })} />);
    expect(within(screen.getByRole('dialog')).getByText('STALE · REFERENCE ONLY · AS OF AUG 11')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText('Aug 11, 2026')).toBeInTheDocument();
    rerender(<CFTCNetLongCard resourceState={resource(snapshot({ sourceVerified: false }))} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('25,427')).not.toBeInTheDocument();
  });

  test('colors parenthesized negatives red across all seven ordinary columns and leaves positives neutral', () => {
    const rows = [-1, 1].map(sign => ({
      ...CURRENT_ROW,
      metric: sign < 0 ? 'Negative columns' : 'Positive columns',
      cftcContractMarketCode: `columns-${sign}`,
      latest: 100 * sign,
      wwChg: 101 * sign,
      historyStatistics: {
        average3M: 102 * sign, average6M: 103 * sign, average1Y: 104 * sign,
        maximum3Y: 105 * sign, minimum3Y: 106 * sign,
      },
    }));
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      schemaVersion: 'cftc-positioning-v3', calculationVersion: 'cftc-combined-net-sample-z-v2', data: rows,
    }))} />);
    const negative = screen.getByRole('button', { name: 'Negative columns' }).closest('tr');
    const positive = screen.getByRole('button', { name: 'Positive columns' }).closest('tr');
    const negativeCells = within(negative).getAllByRole('cell').slice(0, 7);
    expect(negativeCells.map(cell => cell.textContent)).toEqual(['(100)', '(101)', '(102)', '(103)', '(104)', '(105)', '(106)']);
    for (const cell of negativeCells) {
      expect(cell).toHaveClass('is-negative');
      expect(cell).not.toHaveClass('is-extreme');
    }
    for (const cell of within(positive).getAllByRole('cell').slice(0, 7)) {
      expect(cell).not.toHaveClass('is-negative');
      expect(cell).not.toHaveClass('is-positive');
      expect(cell).not.toHaveClass('is-extreme');
    }
  });

  test.each([
    [2, -2, false], [2.00001, -2.00001, true], [1.99999, -1.99999, false],
  ])('outlines only raw z-scores strictly beyond two: %p / %p', (positive, negative, extreme) => {
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      data: [{ ...CURRENT_ROW, zScore1Y: positive, zScore3Y: negative }],
    }))} />);
    const positiveCell = screen.getByRole('cell', { name: '2.00X' });
    const negativeCell = screen.getByRole('cell', { name: '-2.00X' });
    expect(positiveCell).toHaveClass('is-positive');
    expect(negativeCell).toHaveClass('is-negative');
    expect(positiveCell.classList.contains('is-extreme')).toBe(extreme);
    expect(negativeCell.classList.contains('is-extreme')).toBe(extreme);
  });

  test.each([null, undefined, NaN, Infinity, -Infinity, '3.5'])('never outlines missing or invalid z-scores: %p', score => {
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      data: [{ ...CURRENT_ROW, zScore1Y: score, zScore3Y: score }],
    }))} />);
    const cells = screen.getAllByRole('cell').slice(-2);
    for (const cell of cells) {
      expect(cell).toHaveTextContent('—');
      expect(cell).toHaveClass('is-unavailable');
      expect(cell).not.toHaveClass('is-extreme');
      expect(cell).not.toHaveClass('is-positive');
      expect(cell).not.toHaveClass('is-negative');
    }
  });
});
