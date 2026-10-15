import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import FactorMonitor from './FactorMonitor';

const reading = overrides => ({
  instrumentId: 'hedgai:QQQ', ticker: 'QQQ', position: 'Short', baselineDate: '2026-09-28', metricsDate: '2026-09-28',
  initiatedAt: '2026-09-21', bullEligible: true, bearEligible: false, activeDirection: null,
  mapping: { fit: 'proxy', label: 'Nasdaq-100 · source-listed QQQ proxy' },
  metrics: { buy: { battingAverage: 0.81, signals: 21, winLoss: 2.75 }, short: { battingAverage: 0.48, signals: 25, winLoss: 0.68 } },
  sourceIds: ['source'], sources: [{ id: 'source', sourceUrl: '/api/research/hedgai/source/abc' }], ...overrides,
});
const show = (value, marketId = 'nasdaq100') => render(<FactorMonitor marketId={marketId} marketUi={{ fullLabel: 'Nasdaq-100' }}
  snapshot={{ status: 'unavailable', factorRows: [{ id: 'gate', role: 'gate', label: 'TRADE / TREND', value: 'BULLISH / BULLISH' }],
    publishedResearch: { hedgai: value }, factors: {} }} />);

test('published Nasdaq Short remains excluded despite qualifying buy history and unavailable contracts', () => {
  show(reading());
  const row = screen.getByRole('rowheader', { name: 'TICK' }).closest('tr');
  expect(row).toHaveTextContent('Short · 48.0% · Below 60%');
  expect(row).not.toHaveTextContent('Long');
  expect(row).toHaveAttribute('title', expect.stringContaining('Tick · HedgAI research'));
  expect(within(row).getByRole('link', { name: 'TICK' })).toHaveAttribute('href', '/api/research/hedgai/source/abc');
  expect(row).toHaveAttribute('title', expect.stringContaining('Buy history: 81.0% · 21 signals'));
  expect(within(row).getAllByRole('cell').slice(1, 3).map(cell => cell.textContent)).toEqual(['—', '—']);
  const headers = screen.getAllByRole('rowheader').map(node => node.textContent);
  expect(headers.indexOf('TICK')).toBeLessThan(headers.indexOf('TRADE / TREND'));
});

test('Wait is neutral and qualifying historical upside never activates a current direction', () => {
  show(reading({ position: 'Wait' }));
  const row = screen.getByRole('rowheader', { name: 'TICK' }).closest('tr');
  expect(row).toHaveTextContent('Wait · Await Buy');
  expect(within(row).getByText('Wait')).toHaveClass('is-neutral');
});

test.each(['Wait', 'Short'])('retained %s states disclose uncertain update continuity', position => {
  show(reading({ position, status: 'last-known' }));
  expect(screen.getByRole('rowheader', { name: 'TICK' }).closest('tr')).toHaveTextContent('Last known');
});

test('SPX uses the same reading before its Trade/Trend gate without executable values', () => {
  show(reading({ position: 'Buy', activeDirection: 'Bullish', metrics: { buy: { battingAverage: 0.6, signals: 20, winLoss: 1.33 } } }), 'sp500');
  const row = screen.getByRole('rowheader', { name: 'TICK' }).closest('tr');
  expect(row).toHaveTextContent('Long · 60.0%');
  expect(within(row).getByText('Long')).toHaveClass('is-positive');
  expect(screen.getAllByRole('rowheader').map(node => node.textContent).slice(-3)).toEqual(['TICK', 'TRADE / TREND GATE', 'CONTRACT / RR GEOMETRY']);
});

test.each(['mock', 'seeded', 'synthetic'])('%s research never becomes a monitor reading', flag => {
  show(reading({ [flag]: true }));
  expect(screen.queryByRole('rowheader', { name: 'TICK' })).not.toBeInTheDocument();
});
