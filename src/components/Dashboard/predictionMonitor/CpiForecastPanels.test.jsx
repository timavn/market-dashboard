import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import CpiForecastBoard from './CpiForecastBoard';
import CpiReleaseSetup from './CpiReleaseSetup';
import CpiForecastComparisonPanel from './CpiForecastComparisonPanel';
import { CpiForecastTooltip } from './CpiForecastDetails';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

const NOW = Date.parse('2026-09-11T11:00:00Z');
const RELEASE = '2026-09-11T12:30:00Z';
const comparison = () => ({
  status: 'available', reportMonth: '2026-08', releaseAt: RELEASE, eventTicker: 'KXCPIYOY-26SEP',
  hedgeye: {
    status: 'available', reportMonth: '2026-08', baseValue: 3.04,
    asOf: '2026-09-10T12:00:00Z', sourceUrl: 'https://app.hedgeye.com',
    scenarios: [{ key: 'downside', value: 2.86 }, { key: 'base', value: 3.04 }, { key: 'upside', value: 3.16 }],
  },
  clevelandFed: {
    status: 'available', reportMonth: '2026-08', value: 3.06,
    sourceUrl: 'https://www.clevelandfed.org', asOf: '2026-09-10T12:00:00Z',
    points: [{ timestamp: Date.parse('2026-08-28T12:00:00Z'), value: 2.94 }, { timestamp: Date.parse('2026-08-31T12:00:00Z'), value: 3.06 }],
  },
  bls: { status: 'available', latestFinal: { reportMonth: '2026-08', value: 3.2 } },
});
const benchmarkData = () => ({
  fetchedAt: new Date(NOW).toISOString(),
  sources: [{ id: 'wall-street-consensus', status: 'available', point: 3, sourceUrl: 'https://tradingeconomics.com', asOf: new Date(NOW).toISOString() }],
  releaseSetup: {
    sourceUrl: 'https://tradingeconomics.com', checkedAt: new Date(NOW).toISOString(),
    rows: [
      { id: 'headline-mom', status: 'available', previous: 0.2, consensus: 0.3, actual: 8 },
      { id: 'headline-yoy', status: 'available', previous: 2.9, consensus: 3, providerForecast: 3.08, actual: 9 },
    ],
  },
});

const nativeResizeObserver = global.ResizeObserver;
class ResizeObserverForChart {
  constructor(callback) { this.callback = callback; }
  observe(target) { this.callback([{ target, contentRect: { width: 900, height: 260 } }]); }
  unobserve() {}
  disconnect() {}
}
beforeAll(() => { global.ResizeObserver = ResizeObserverForChart; });
afterAll(() => { global.ResizeObserver = nativeResizeObserver; });

describe('CPI forecast display cards', () => {
  it('keeps board order, two-decimal forecasts and source links, then gates every forecast at release', () => {
    const { rerender } = render(<CpiForecastBoard comparison={comparison()} benchmarkData={benchmarkData()} reportMonth="2026-08" releaseCurrent />);
    const board = screen.getByRole('complementary', { name: 'CPI forecast board' });
    expect(within(board).getAllByRole('rowheader').map(row => row.textContent)).toEqual([
      expect.stringContaining('Street consensus'), expect.stringContaining('Cleveland Fed'),
      expect.stringContaining('Hedgeye base'), expect.stringContaining('Trading Economics'),
    ]);
    expect(within(board).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['3.00%', '3.06%', '3.04%', '3.08%']);
    expect(within(board).getByText(/RANGE 2.86%–3.16%/)).toBeVisible();
    expect(within(board).getByRole('link', { name: 'Cleveland Fed' })).toHaveAttribute('href', 'https://www.clevelandfed.org');
    rerender(<CpiForecastBoard comparison={comparison()} benchmarkData={benchmarkData()} reportMonth="2026-08" releaseCurrent={false} />);
    expect(within(board).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['PENDING', 'PENDING', 'PENDING', 'PENDING']);
  });

  it('keeps release actuals blank until the matching BLS report is available, without using benchmark actuals', () => {
    const props = { comparison: comparison(), benchmarkData: benchmarkData(), reportMonth: '2026-08', blsLatestActualAvailable: false, blsReportMonthActualAvailable: false };
    const { rerender } = render(<CpiReleaseSetup {...props} />);
    const setup = screen.getByRole('complementary', { name: 'CPI release setup' });
    const headline = within(setup).getByRole('row', { name: /Headline YoY/ });
    expect(within(headline).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['2.9%', '3.0%', '—']);
    expect(within(setup).queryByRole('columnheader', { name: 'SURPRISE' })).not.toBeInTheDocument();
    rerender(<CpiReleaseSetup {...props} blsLatestActualAvailable blsReportMonthActualAvailable />);
    expect(within(headline).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['3.2%', '3.0%', '3.2%', '+0.2 pp']);
    expect(within(setup).getByRole('columnheader', { name: 'SURPRISE' })).toBeVisible();
    expect(within(setup).queryByText('9.0%')).not.toBeInTheDocument();
    expect(within(setup).queryByText('8.0%')).not.toBeInTheDocument();
  });

  it('renders concise checking/unavailable states and distinguishes delayed reference metadata', () => {
    const { rerender } = render(<CpiForecastComparisonPanel snapshot={null} nowMs={NOW} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('CHECKING VERIFIED CPI SOURCES');
    expect(screen.getByText('CHECKING MARKET HOURS')).toBeVisible();
    expect(screen.queryByTestId('cpi-forecast-chart-plot')).not.toBeInTheDocument();
    rerender(<CpiForecastComparisonPanel snapshot={{ referenceOnly: true }} nowMs={NOW} />);
    expect(screen.getByRole('status')).toHaveTextContent('CPI COMPARISON UNAVAILABLE');
    expect(screen.getByText('DATED REFERENCE')).toBeVisible();
  });

  it('uses the actual chart leaf and flips exact-month scenario/BLS visibility at the release instant', () => {
    const snapshot = { forecastComparison: comparison(), contracts: { event: { status: 'open', closeTime: RELEASE, observationTime: RELEASE, timezone: 'America/New_York' } } };
    const { rerender } = render(<CpiForecastComparisonPanel snapshot={snapshot} nowMs={NOW} benchmarkData={benchmarkData()} />);
    const plot = screen.getByTestId('cpi-forecast-chart-plot');
    expect(plot).toHaveAttribute('data-calendar-start-date', '2026-08-01');
    expect(plot).toHaveAttribute('data-calendar-end-date', '2026-09-11');
    expect(plot).toHaveAttribute('data-source-point-count', '2');
    expect(screen.getByTestId('cpi-chart-label-base')).toHaveTextContent('BASE 3.0%');
    expect(screen.getByTestId('cpi-cleveland-endpoint-label')).toHaveTextContent('CLEVELAND FED 3.1%');
    expect(screen.queryByTestId('cpi-chart-label-bls')).not.toBeInTheDocument();
    rerender(<CpiForecastComparisonPanel snapshot={snapshot} nowMs={Date.parse(RELEASE)} benchmarkData={benchmarkData()} />);
    expect(screen.queryByTestId('cpi-chart-label-base')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cpi-cleveland-endpoint-label')).not.toBeInTheDocument();
    expect(screen.getByTestId('cpi-chart-label-bls')).toHaveTextContent('BLS ACTUAL 3.2%');
  });

  it('labels carried Cleveland tooltip context as last-published rather than a daily publication', () => {
    render(<CpiForecastTooltip active label={Date.parse('2026-08-30T12:00:00Z')} payload={[{ payload: {
      cleveland: null, clevelandLatest: 2.94, clevelandLatestTimestamp: Date.parse('2026-08-28T12:00:00Z'),
      scenarios: { base: 3.04 }, blsActual: null,
    } }]} />);
    const tooltip = screen.getByTestId('cpi-chart-tooltip');
    expect(tooltip).toHaveTextContent('LAST PUBLISHED AUG 28');
    expect(tooltip).toHaveTextContent('2.9%');
    expect(tooltip).toHaveTextContent('3.0%');
    expect(within(tooltip).queryByText('BLS ACTUAL')).not.toBeInTheDocument();
  });
});
