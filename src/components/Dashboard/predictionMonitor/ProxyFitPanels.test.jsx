import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ProxyFitPanel from './ProxyFitPanel';
import PythTrackingPanel from './PythTrackingPanel';
import { formatAthSessionDate, formatPythTrackingUsd, proxyFitDeviationTone, proxyFitSigned } from './proxyFitPresentation';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const SPX = freeze({ symbol: 'SPX', fullLabel: 'S&P 500' });
// Already-normalized historical reference fixtures; the monitor remains the
// provider/provenance boundary. No executable prices or requests are involved.
const comparison = (overrides = {}) => ({
  status: 'available', proxyLabel: 'ESU26', underlyingLabel: 'SPX', currentBasisPct: 0.42,
  alignedThroughDate: '2026-08-17', methodology: 'Completed aligned closes only.',
  rows: [
    { window: 20, status: 'available', averageBasisPct: -0.25, deviationZ: 2, returnCorrelation: 0.97 },
    { window: 5, status: 'available', averageBasisPct: 0.3, deviationZ: -1, returnCorrelation: 0.98 },
    { window: 60, status: 'available', averageBasisPct: 0, deviationZ: 0.5, returnCorrelation: 0 },
  ],
  ...overrides,
});
const tracking = (overrides = {}) => ({
  status: 'available', sampleSize: 17, meanSignedErrorUsd: -0.85, meanAbsoluteErrorUsd: 1.5,
  medianAbsoluteErrorUsd: 0.67, p90AbsoluteErrorUsd: 5.01, maxAbsoluteErrorUsd: 6.97,
  guardBandUsd: 10, methodology: 'Verified finalized comparisons.',
  latestFinal: { value: 4448.11, eventTicker: 'KXGOLDD-26AUG3117' },
  ...overrides,
});
const metric = (panel, name) => within(panel).getByText(name, { selector: 'dt' }).nextElementSibling;

test('preserves the compact four-window comparison, signed precision, deviation tones, and frozen input identity', () => {
  const input = freeze(comparison());
  const { container } = render(<ProxyFitPanel comparison={input} marketUi={SPX} />);
  const panel = screen.getByRole('complementary', { name: 'S&P 500 proxy fit comparison' });
  expect(container.children).toHaveLength(1);
  expect(panel).toHaveAttribute('data-testid', 'spx-proxy-fit');
  expect(panel).toHaveClass('pm-spx-proxy-fit', 'is-available');
  expect(panel).toHaveAttribute('title', 'Completed aligned closes only.');
  expect(within(panel).getByLabelText('Proxy ESU26 compared with underlying SPX')).toHaveTextContent('ESU26→SPX');
  expect(panel).toHaveTextContent('+0.42%');
  expect(panel).toHaveTextContent('VERIFIED');
  expect(panel).toHaveTextContent('LAST ALIGNED BASIS · AS OF 8/17/2026');
  expect(within(within(panel).getAllByRole('row')[0]).getAllByRole('columnheader').map((cell) => cell.getAttribute('aria-label') || cell.textContent)).toEqual(['WINDOW', 'AVG BASIS', 'DEVIATION', 'RET CORR']);
  const rows = within(panel).getAllByRole('row').slice(1);
  expect(rows.map((row) => row.querySelector('th').textContent)).toEqual(['5D', '20D', '60D', '120D']);
  expect(within(rows[0]).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['+0.30%', '-1.00σ', '0.98']);
  expect(within(rows[0]).getAllByRole('cell')[1]).toHaveClass('is-caution');
  expect(within(rows[1]).getAllByRole('cell')[1]).toHaveClass('is-danger');
  expect(within(rows[2]).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['0.00%', '+0.50σ', '0.00']);
  expect(within(rows[2]).getAllByRole('cell')[1]).toHaveClass('is-normal');
  expect(rows[3]).toHaveClass('is-unavailable');
  expect(within(rows[3]).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['—', '—', '—']);
  expect(input.rows.map((row) => row.window)).toEqual([20, 5, 60]);
  expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
});

test('allows partial comparison context but keeps unavailable window values hidden and invalid dates unfilled', () => {
  render(<ProxyFitPanel comparison={freeze(comparison({
    status: 'PARTIAL', alignedThroughDate: 'invalid-date',
    rows: [
      { window: 5, status: 'unavailable', averageBasisPct: 88.88, deviationZ: 7.77, returnCorrelation: 0.66 },
      { window: 20, status: 'available', averageBasisPct: '0.25', deviationZ: null, returnCorrelation: '0.97' },
    ],
  }))} marketUi={SPX} />);
  const panel = screen.getByTestId('spx-proxy-fit');
  expect(panel).toHaveClass('is-partial');
  expect(panel).toHaveTextContent('PARTIAL');
  expect(panel).toHaveTextContent('LAST ALIGNED BASIS · AS OF —');
  expect(panel).not.toHaveTextContent('88.88');
  expect(panel).not.toHaveTextContent('7.77');
  const row = within(panel).getByText('20D', { selector: 'th' }).closest('tr');
  expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['+0.25%', '—', '0.97']);
  expect(within(row).getAllByRole('cell')[1]).toHaveClass('is-unavailable');
});

test.each(['loading', 'unavailable', 'offline', 'stale', 'cache-only', 'mock', 'seeded'])('hides retained comparison numbers when the prepared status becomes %s', (status) => {
  const { rerender } = render(<ProxyFitPanel comparison={freeze(comparison())} marketUi={SPX} />);
  expect(screen.getByTestId('spx-proxy-fit')).toHaveTextContent('+0.42%');
  rerender(<ProxyFitPanel comparison={freeze(comparison({ status, reason: 'Current comparison unavailable.' }))} marketUi={SPX} />);
  const panel = screen.getByTestId('spx-proxy-fit');
  expect(panel).toHaveClass(status === 'loading' ? 'is-loading' : 'is-unavailable');
  expect(panel).toHaveAttribute('title', 'Current comparison unavailable.');
  expect(panel).toHaveTextContent(status === 'loading' ? 'CHECKING' : 'NO VERIFIED ALIGNED COMPARISON');
  ['+0.42%', '+0.30%', '-1.00σ', '0.98', '8/17/2026'].forEach((value) => expect(panel).not.toHaveTextContent(value));
  expect(within(panel).getAllByRole('cell').every((cell) => cell.textContent === '—')).toBe(true);
});

test('keeps unavailable SPX labels tied to a known own contract instead of a mismatched cached label', () => {
  const input = freeze(comparison({ status: 'unavailable', proxyLabel: 'SP500', underlyingLabel: 'SILVER' }));
  const { rerender } = render(<ProxyFitPanel comparison={input} marketUi={SPX} contractReferenceLabel="MESZ26" />);
  expect(screen.getByLabelText('Proxy MESZ26 compared with underlying SPX')).toBeInTheDocument();
  expect(screen.queryByText('SILVER')).not.toBeInTheDocument();
  rerender(<ProxyFitPanel comparison={input} marketUi={SPX} />);
  expect(screen.getByLabelText('Proxy UNAVAILABLE compared with underlying SPX')).toBeInTheDocument();
  rerender(<ProxyFitPanel comparison={{ ...input, proxyLabel: 'ESU26' }} marketUi={SPX} contractReferenceLabel="MESZ26" />);
  expect(screen.getByLabelText('Proxy ESU26 compared with underlying SPX')).toBeInTheDocument();
});

test('keeps the existing exact-resolver link and entitlement note scoped to Brent', () => {
  const input = freeze(comparison({ proxyLabel: 'BZX26', underlyingLabel: 'BRENT', exactResolverUrl: 'https://app.pyth.com/explore/Commodities.Index.BRENT%2FUSD' }));
  const { rerender } = render(<ProxyFitPanel comparison={input} marketUi={{ symbol: 'BRENT', fullLabel: 'Brent' }} />);
  const panel = screen.getByTestId('brent-proxy-fit');
  expect(panel).toHaveTextContent('PYTH INDEX NOT INCLUDED · LIVE HISTORY ENTITLEMENT REQUIRED');
  const link = within(panel).getByRole('link', { name: 'OPEN EXACT PYTH BRENT INDEX' });
  expect(link).toHaveAttribute('href', input.exactResolverUrl);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noreferrer');
  rerender(<ProxyFitPanel comparison={input} marketUi={SPX} />);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.queryByText('PYTH INDEX NOT INCLUDED · LIVE HISTORY ENTITLEMENT REQUIRED')).not.toBeInTheDocument();
});

test('preserves finalized Pyth metrics, signed dollars, resolver text, and current-event precedence', () => {
  const input = freeze(tracking({ currentEventFinal: { value: '4450.12', eventTicker: 'CURRENT-EVENT' } }));
  render(<PythTrackingPanel tracking={input} />);
  const panel = screen.getByRole('complementary', { name: 'Gold Pyth resolver tracking' });
  expect(panel).toHaveClass('pm-spx-proxy-fit', 'pm-gold-pyth-tracking', 'is-available');
  expect(panel).toHaveTextContent('XAUUSD→PYTH GOLD/USD');
  expect(panel).toHaveTextContent('PYTH 1-MIN CANDLE CLOSE · 4:59–5:00 PM ET');
  expect(panel).toHaveTextContent('±$10.00');
  expect([...panel.querySelectorAll('dt')].map((item) => item.textContent)).toEqual(['N', 'BIAS', 'MAE', 'MEDIAN', 'P90', 'MAX']);
  expect([...panel.querySelectorAll('dd')].map((item) => item.textContent)).toEqual(['17', '-$0.85', '$1.50', '$0.67', '$5.01', '$6.97']);
  expect(panel).toHaveTextContent('CURRENT EVENT FINAL$4450.12CURRENT-EVENT');
  expect(panel).not.toHaveTextContent('4448.11');
  expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
  expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
});

test.each(['partial', 'loading', 'unavailable'])('preserves Pyth %s presentation: hidden error metrics, sample count and dated official final', (status) => {
  render(<PythTrackingPanel tracking={freeze(tracking({ status }))} />);
  const panel = screen.getByTestId('gold-pyth-tracking');
  expect(metric(panel, 'N')).toHaveTextContent(/^17$/);
  ['BIAS', 'MAE', 'MEDIAN', 'P90', 'MAX'].forEach((name) => {
    expect(metric(panel, name)).toHaveTextContent(/^—$/);
    expect(metric(panel, name).parentElement).toHaveClass('is-unavailable');
  });
  expect(panel).toHaveTextContent('LATEST OFFICIAL FINAL$4448.11KXGOLDD-26AUG3117');
  expect(panel).not.toHaveTextContent('-$0.85');
});

test('preserves the existing missing-tracking threshold display without fabricating finalized observations', () => {
  const { rerender } = render(<PythTrackingPanel tracking={null} />);
  const panel = screen.getByTestId('gold-pyth-tracking');
  expect(panel).toHaveClass('is-unavailable');
  expect(panel).toHaveTextContent('±$10.00');
  expect(metric(panel, 'N')).toHaveTextContent(/^0$/);
  expect(panel).toHaveTextContent('LATEST OFFICIAL FINAL—NO FINALIZED MATCH');
  rerender(<PythTrackingPanel tracking={tracking({ currentEventFinal: { value: null, eventTicker: 'CURRENT-WITHOUT-VALUE' } })} />);
  expect(panel).toHaveTextContent('CURRENT EVENT FINAL—CURRENT-WITHOUT-VALUE');
  expect(panel).not.toHaveTextContent('4448.11');
});

test('keeps numeric coercion, missing-value formatting, and exact deviation thresholds unchanged', () => {
  expect(proxyFitSigned('0.125', '%')).toBe('+0.13%');
  expect(proxyFitSigned(0, '%')).toBe('0.00%');
  expect(formatPythTrackingUsd(-0.85, { signed: true })).toBe('-$0.85');
  expect(formatPythTrackingUsd(0.85, { signed: true })).toBe('+$0.85');
  expect(formatPythTrackingUsd(-1.5)).toBe('$1.50');
  [null, undefined, '', NaN, Infinity].forEach((value) => {
    expect(proxyFitSigned(value, '%')).toBe('—');
    expect(formatPythTrackingUsd(value)).toBe('—');
    expect(proxyFitDeviationTone(value)).toBe('is-unavailable');
  });
  expect([0.999, -1, 1.999, -2].map(proxyFitDeviationTone)).toEqual(['is-normal', 'is-caution', 'is-caution', 'is-danger']);
  expect(formatAthSessionDate('2026-08-17')).toBe('8/17/2026');
  expect(formatAthSessionDate('bad-date')).toBe('bad-date');
});
