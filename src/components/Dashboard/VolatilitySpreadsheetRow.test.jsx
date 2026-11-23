import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { VolatilityMapPanel } from './ExceptionFirstRadar';
import { retainFxVolatility } from '../../utils/fxVolatilityReference';

const OBSERVED_AT = '2026-09-11T20:00:00.000Z';
const CURRENT_ROW = {
  availability: 'available',
  freshness: 'current',
  quoteMode: 'live',
  source: 'ibkr',
  asOf: OBSERVED_AT,
  lastPx: 16.65,
  day1Ago: 15.03,
  day15Ago: 14.8,
  week4Ago: 22.22,
  month3Ago: 19.23,
  month6Ago: 15.45,
  dayChangePct: 10.78,
  fifteenDayChangePct: 12.5,
  monthChangePct: -25.07,
  threeMonthChangePct: -13.42,
  sixMonthChangePct: 7.77,
};

const G5RV_ROW = {
  ...CURRENT_ROW,
  lastPx: 5.87,
  availability: 'historical',
  freshness: 'historical',
  quoteMode: 'end-of-day',
  source: 'yahoo',
  measure: 'realized',
};

const renderSpreadsheet = (snapshot, props = {}) => render(
  <VolatilityMapPanel layout="spreadsheet" volatilityState={{ snapshot }} {...props} />,
);

describe('Volatility spreadsheet presentation', () => {
  afterEach(() => jest.restoreAllMocks());

  test('renders G5RV as a dated spreadsheet row with the same horizons and regime', () => {
    const { container } = renderSpreadsheet({ VIX: CURRENT_ROW }, { fxvlSnapshot: G5RV_ROW });
    const row = screen.getByRole('row', { name: /G5RV G5 FX 1M realized vol as of SEP 11/ });
    expect(row).toHaveAttribute('data-status', 'historical');
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent))
      .toEqual(['5.87C', '+10.78%', '+12.50%', '-25.07%', '-13.42%', '+7.77%', 'Low<8']);
    expect(within(row).getByText('5.87').closest('td')).toHaveAttribute('title', expect.stringContaining('yahoo'));
    expect(within(row).getByRole('button', { name: /Historical reference/ }))
      .toHaveAttribute('aria-label', expect.stringContaining(OBSERVED_AT));
    expect(container.querySelector('.efr-vol-sparkline')).toBeNull();
  });

  test('keeps independently verified G5RV available when the other volatility feed fails', () => {
    renderSpreadsheet(null, { fxvlSnapshot: G5RV_ROW });
    expect(screen.getByRole('row', { name: /G5RV G5 FX 1M realized vol/ })).toHaveTextContent('5.87');
    expect(screen.getByRole('row', { name: 'VIX volatility data unavailable' }))
      .toHaveAttribute('data-status', 'unavailable');
  });

  test('keeps every G5RV cell and original provider time when its refresh is delayed', () => {
    renderSpreadsheet(null, { fxvlSnapshot: retainFxVolatility(G5RV_ROW) });
    const row = screen.getByRole('row', { name: 'G5RV last verified volatility; refresh delayed' });
    expect(row).toHaveAttribute('data-status', 'refresh-delayed');
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent))
      .toEqual(['5.87C', '+10.78%', '+12.50%', '-25.07%', '-13.42%', '+7.77%', 'Low<8']);
    expect(within(row).getByRole('button', { name: /Refresh delayed/ }))
      .toHaveAccessibleName(expect.stringContaining(OBSERVED_AT));
  });

  test('keeps the verified G5RV level when its history is incomplete', () => {
    renderSpreadsheet(null, { fxvlSnapshot: { ...G5RV_ROW, month6Ago: null, sixMonthChangePct: null } });
    const row = screen.getByRole('row', { name: /G5RV G5 FX 1M realized vol/ });
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent))
      .toEqual(['5.87C', '+10.78%', '+12.50%', '-25.07%', '-13.42%', '—', 'Low<8']);
  });

  test.each([
    ['stale', { freshness: 'stale' }],
    ['offline', { availability: 'unavailable' }],
    ['cache-only', { freshness: 'cache-only' }],
    ['seed', { source: 'seed' }],
    ['mock', { source: 'mock' }],
    ['missing observation', { asOf: null }],
  ])('withholds %s FX volatility values in the combined table', (_label, overrides) => {
    renderSpreadsheet({ VIX: CURRENT_ROW }, { fxvlSnapshot: { ...G5RV_ROW, ...overrides } });
    const row = screen.getByRole('row', { name: 'G5RV volatility data unavailable' });
    expect(row).toHaveAttribute('data-status', 'unavailable');
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(Array(7).fill('—'));
  });

  test('aligns the nine series by period and retains previous levels in tooltips', () => {
    renderSpreadsheet({ VIX: CURRENT_ROW });
    const table = screen.getByRole('table', { name: 'Volatility performance' });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent))
      .toEqual(['Series', 'Level', 'DAY', '15D', '1M', '3M', '6M', 'Regime']);
    expect(within(table).getAllByRole('row')).toHaveLength(10);
    const row = within(table).getByRole('row', { name: 'VIX current volatility' });
    expect(row).toHaveAttribute('data-status', 'live');
    expect(within(row).getByText('16.7')).toHaveClass('efr-vol-regime-value--green');
    expect(within(row).getByText('16.7').closest('td')).toHaveAttribute('title', `Level 16.65 · ibkr · live · as of ${OBSERVED_AT}`);
    expect(within(row).getByText('Low')).toBeInTheDocument();
    expect(within(row).getByText('<19')).toBeInTheDocument();
    expect(within(row).getByText('+12.50%')).toHaveAttribute('title', expect.stringContaining('15D prior level 14.80'));
    expect(within(row).getByText('-25.07%')).toHaveClass('is-falling');
    expect(within(row).queryByRole('button', { name: /Delayed quote/ })).not.toBeInTheDocument();
    expect(within(table).queryByRole('img')).not.toBeInTheDocument();
  });

  test('adds emerging-market volatility with provider attribution and its explainer', () => {
    renderSpreadsheet({ VXEEM: { ...CURRENT_ROW, lastPx: 25.26, source: 'cboe', quoteMode: 'delayed' } },
      { fxvlSnapshot: G5RV_ROW });
    const table = screen.getByRole('table', { name: 'Volatility performance' });
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    const row = within(table).getByRole('row', { name: 'VXEEM current volatility' });
    expect(row).toHaveAttribute('data-status', 'delayed');
    expect(within(row).getByText('25.3').closest('td'))
      .toHaveAttribute('title', expect.stringContaining(`cboe · delayed · as of ${OBSERVED_AT}`));
    expect(within(row).getAllByRole('cell').at(-1)).toHaveTextContent('—');
    fireEvent.click(within(row).getByRole('button', { name: 'Explain VXEEM volatility index' }));
    const dialog = screen.getByRole('dialog', { name: 'Cboe Emerging Markets ETF Volatility Index' });
    expect(within(dialog).getByText(/iShares MSCI Emerging Markets ETF/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Official Cboe volatility-index methodology/ }))
      .toHaveAttribute('href', expect.stringContaining('cdn.cboe.com'));
  });

  test.each([
    ['VIX', 18.99, '19', 'green', 'Low'],
    ['VIX', 19, '19', 'yellow', 'Moderate'],
    ['VVIX', 114.99, '115', 'yellow', 'Moderate'],
    ['VVIX', 115, '115', 'red', 'High'],
  ])('rounds %s %s for display while preserving its exact reading and regime', (symbol, level, display, bucket, regime) => {
    const reading = Object.freeze({ ...CURRENT_ROW, lastPx: level });
    renderSpreadsheet({ [symbol]: reading });
    const row = screen.getByRole('row', { name: `${symbol} current volatility` });
    const displayedLevel = within(row).getByText(display);
    expect(displayedLevel).toHaveClass(`efr-vol-regime-value--${bucket}`);
    expect(displayedLevel.closest('td')).toHaveAttribute('title', `Level ${level} · ibkr · live · as of ${OBSERVED_AT}`);
    expect(within(row).getByText(regime)).toBeInTheDocument();
    expect(within(row).getByText('+10.78%')).toHaveAttribute('title', expect.stringContaining('DAY prior level 15.03'));
    expect(reading.lastPx).toBe(level);
  });

  test('marks provider-delayed and retained readings with their original observations', () => {
    const now = Date.parse('2026-09-12T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    renderSpreadsheet({
      VIX: { ...CURRENT_ROW, quoteMode: 'delayed', source: 'cboe' },
      VVIX: {
        ...CURRENT_ROW,
        availability: 'reference',
        freshness: 'refresh-delayed',
        refreshDelayed: true,
        lastVerifiedAt: OBSERVED_AT,
        retainedUntil: '2026-09-13T20:00:00.000Z',
      },
    });
    const delayed = screen.getByRole('row', { name: 'VIX current volatility' });
    expect(delayed).toHaveAttribute('data-status', 'delayed');
    expect(within(delayed).getByRole('button', { name: /Delayed quote/ })).toBeInTheDocument();
    const retained = screen.getByRole('row', { name: 'VVIX last verified volatility; refresh delayed' });
    expect(retained).toHaveAttribute('data-status', 'refresh-delayed');
    expect(within(retained).getByText('16.7').closest('td'))
      .toHaveAttribute('title', expect.stringContaining(OBSERVED_AT));
    expect(within(retained).getByRole('button', { name: /Refresh delayed · last verified/ }))
      .toBeInTheDocument();
  });

  test('marks the source session orange and an older retained session red without changing evidence', () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-11T20:05:00.000Z'));
    const retained = Object.freeze({
      ...CURRENT_ROW,
      asOf: '2026-09-10T20:00:00.000Z', lastVerifiedAt: '2026-09-10T20:00:00.000Z',
      marketSessionDate: '2026-09-10', availability: 'reference',
      freshness: 'refresh-delayed', refreshDelayed: true,
    });
    renderSpreadsheet({
      VIX: { ...CURRENT_ROW, quoteMode: 'delayed', source: 'cboe', marketSessionDate: '2026-09-11' },
      VVIX: retained,
    });
    expect(within(screen.getByRole('row', { name: 'VIX current volatility' })).getByRole('button', { name: /Delayed quote/ }))
      .toHaveAttribute('data-data-age', 'same-session');
    expect(within(screen.getByRole('row', { name: 'VVIX last verified volatility; refresh delayed' })).getByRole('button', { name: /Refresh delayed/ }))
      .toHaveAttribute('data-data-age', 'older-session');
    expect(retained.asOf).toBe('2026-09-10T20:00:00.000Z');
    expect(retained.lastPx).toBe(CURRENT_ROW.lastPx);
  });

  test.each([
    ['VIX', 16.65, '16.7', 'ibkr'],
    ['VVIX', 95.13, '95.1', 'cboe'],
    ['RVX', 23.41, '23.4', 'cboe'],
    ['MOVE', 92.4, '92.4', 'yahoo'],
  ])('keeps every %s period and its original evidence after weeks without a refresh', (symbol, level, display, source) => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T20:00:00.000Z'));
    const retainedRow = Object.freeze({
      ...CURRENT_ROW,
      lastPx: level,
      source,
      availability: 'reference',
      freshness: 'refresh-delayed',
      refreshDelayed: true,
      lastVerifiedAt: OBSERVED_AT,
      retainedUntil: '2026-09-13T20:00:00.000Z',
    });
    renderSpreadsheet({ [symbol]: retainedRow });
    const row = screen.getByRole('row', { name: `${symbol} last verified volatility; refresh delayed` });
    expect(row).toHaveAttribute('data-status', 'refresh-delayed');
    const cells = within(row).getAllByRole('cell');
    expect(cells.slice(0, 6).map((cell) => cell.textContent))
      .toEqual([`${display}C`, '+10.78%', '+12.50%', '-25.07%', '-13.42%', '+7.77%']);
    cells.slice(0, 6).forEach((cell) => {
      expect(cell).toHaveAttribute('title', expect.stringContaining(`${source} · refresh-delayed · as of ${OBSERVED_AT}`));
    });
    const marker = within(row).getByRole('button', { name: /Refresh delayed · last verified/ });
    expect(marker).toHaveAttribute('aria-label', expect.stringContaining(OBSERVED_AT));
    fireEvent.click(marker);
    expect(screen.getByRole('status')).toHaveTextContent('Updated Sep 11, 2026');
    expect(screen.getByRole('status')).not.toHaveTextContent('Oct 23');
    expect(retainedRow.asOf).toBe(OBSERVED_AT);
    expect(retainedRow.lastVerifiedAt).toBe(OBSERVED_AT);
  });

  test('keeps a verified level and available periods when another history period is missing', () => {
    renderSpreadsheet({ VIX: {
      ...CURRENT_ROW,
      month3Ago: null,
      threeMonthChangePct: null,
    } });
    const row = screen.getByRole('row', { name: 'VIX current volatility' });
    expect(row).toHaveAttribute('data-status', 'live');
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent))
      .toEqual(['16.7', '+10.78%', '+12.50%', '-25.07%', '—', '+7.77%', 'Low<19']);
  });

  test.each(['spreadsheet', 'map'])('shows the original observation time in %s when verification happened later', (layout) => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-12T12:00:00.000Z'));
    const lastVerifiedAt = '2026-09-11T20:05:00.000Z';
    const retainedRow = Object.freeze({
      ...CURRENT_ROW,
      availability: 'reference',
      freshness: 'refresh-delayed',
      refreshDelayed: true,
      lastVerifiedAt,
    });
    render(<VolatilityMapPanel layout={layout} volatilityState={{ snapshot: { VIX: retainedRow } }} />);
    const marker = screen.getByRole('button', { name: /Refresh delayed · last verified/ });
    expect(marker.getAttribute('aria-label')).toContain(OBSERVED_AT);
    expect(marker.getAttribute('aria-label')).not.toContain(lastVerifiedAt);
    expect(retainedRow.lastVerifiedAt).toBe(lastVerifiedAt);
  });

  test('preserves historical MOVE dates and its threshold', () => {
    renderSpreadsheet({ MOVE: {
      ...CURRENT_ROW,
      lastPx: 92.4,
      availability: 'historical',
      freshness: 'historical',
      quoteMode: 'end-of-day',
      source: 'yahoo',
    } });
    const row = screen.getByRole('row', { name: 'MOVE end-of-day volatility as of SEP 11' });
    expect(row).toHaveAttribute('data-status', 'historical');
    expect(within(row).getByText('92.4')).toHaveClass('efr-vol-regime-value--green');
    expect(within(row).getByText('<100')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Historical reference/ })).toBeInTheDocument();
  });

  test.each([
    ['stale', { freshness: 'stale' }],
    ['provider offline', { availability: 'unavailable', freshness: 'unavailable', error: 'provider_offline' }],
    ['cache-only', { availability: 'unavailable', freshness: 'cache-only', source: 'cache_only' }],
    ['seed', { availability: 'unavailable', freshness: 'unavailable', source: 'seed' }],
    ['mock', { availability: 'unavailable', freshness: 'unavailable', source: 'mock' }],
    ['missing date', { asOf: null }],
    ['unverified reference', {
      availability: 'reference', freshness: 'refresh-delayed', refreshDelayed: true,
      lastVerifiedAt: null, retainedUntil: '2026-09-13T20:00:00.000Z',
    }],
    ['reference without provider provenance', {
      availability: 'reference', freshness: 'refresh-delayed', refreshDelayed: true,
      lastVerifiedAt: OBSERVED_AT, source: null,
    }],
  ])('keeps rejected %s input unavailable without a numeric level or regime', (_label, overrides) => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-12T12:00:00.000Z'));
    renderSpreadsheet({
      VIX: { ...CURRENT_ROW, ...overrides },
      VXEEM: { ...CURRENT_ROW, ...overrides },
    });
    ['VIX', 'VXEEM'].forEach((symbol) => {
      const row = screen.getByRole('row', { name: `${symbol} volatility data unavailable` });
      expect(row).toHaveAttribute('data-status', 'unavailable');
      expect(within(row).queryByText('16.7')).not.toBeInTheDocument();
      expect(within(row).queryByText('Low')).not.toBeInTheDocument();
      expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(Array(7).fill('—'));
    });
  });

  test('keeps the VIX regime compact without displaying Risk Range bounds', () => {
    const range = {
      verified: true, status: 'available', source: 'risk_range_publication',
      lrr: 14.5, hrr: 17.5, date: '2026-09-11', asOf: '2026-09-11T13:00:00.000Z',
    };
    const { rerender } = renderSpreadsheet({ VIX: CURRENT_ROW }, {
      vixRiskRangeState: { status: 'available', range },
    });
    const row = screen.getByRole('row', { name: 'VIX current volatility' });
    expect(within(row).getAllByRole('cell').at(-1)).toHaveTextContent(/^Low<19$/);
    expect(screen.queryByLabelText('VIX Risk Range')).not.toBeInTheDocument();
    rerender(<VolatilityMapPanel layout="spreadsheet" volatilityState={{ snapshot: { VIX: CURRENT_ROW } }}
      vixRiskRangeState={{ status: 'available', range: { ...range, source: 'cache_only' } }} />);
    expect(screen.queryByLabelText('VIX Risk Range')).not.toBeInTheDocument();
  });

  test('keeps every ticker connected to its existing explainer', () => {
    renderSpreadsheet({ VIX: CURRENT_ROW });
    ['VIX', 'VVIX', 'RVX', 'VXN', 'VXEEM', 'GVZ', 'OVX', 'BITVX', 'MOVE'].forEach((symbol) => {
      expect(screen.getByRole('button', { name: `Explain ${symbol} volatility index` }))
        .toHaveAttribute('aria-haspopup', 'dialog');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Explain VIX volatility index' }));
    expect(screen.getByRole('dialog', { name: 'Cboe Volatility Index' })).toBeInTheDocument();
  });
});
