import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import catalog from '../../constants/marketRotationCatalog.json';
import useMarketRotationSnapshot from '../../hooks/useMarketRotationSnapshot';
import MarketRotationPanels from './MarketRotationPanels';
import { mergeMarketRotationSnapshots, retainMarketRotationSnapshot } from '../../utils/marketRotationReference.cjs';

jest.mock('../../hooks/useMarketRotationSnapshot', () => ({
  ...jest.requireActual('../../hooks/useMarketRotationSnapshot'),
  __esModule: true,
  default: jest.fn(),
}));

const AS_OF = '2026-09-24T14:40:00.000Z';
const EXPIRES = '2026-09-24T15:00:00.000Z';
const definitions = [...catalog.themes, ...catalog.instruments];
const quote = (ticker, changePercent, overrides = {}) => ({
  ...definitions.find(item => item.ticker === ticker),
  changePercent, asOf: AS_OF, expiresAt: EXPIRES, status: 'delayed', marketDate: '2026-09-24',
  source: 'Yahoo Finance', sourceUrl: `https://finance.yahoo.com/quote/${ticker}`, proxy: true,
  ...overrides,
});
const fixture = () => ({
  status: 'available', source: 'Yahoo Finance', proxy: true, asOf: AS_OF, expiresAt: EXPIRES,
  themes: {
    software: quote('IGV', 1.25), semiconductors: quote('SMH', -0.65),
    leader: quote('URA', 2.4), laggard: quote('TAN', -2.1),
    coverage: { verified: 10, total: 10, comparable: true, expiresAt: EXPIRES },
  },
  factors: catalog.factors.map((definition, index) => ({
    id: definition.id, label: definition.label, left: quote(definition.left, index === 0 ? 1.2 : -0.2),
    right: quote(definition.right, 0.4), spreadPp: index === 0 ? 0.8 : -0.6,
    asOf: AS_OF, expiresAt: EXPIRES, status: 'delayed', marketDate: '2026-09-24', source: 'Yahoo Finance', proxy: true,
  })),
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-24T14:45:00.000Z'));
  useMarketRotationSnapshot.mockReturnValue({ snapshot: null, loading: false });
});
afterEach(() => jest.useRealTimers());

test('adds software, semis, tracked theme leaders and factor spreads with semantic colors', () => {
  render(<MarketRotationPanels snapshot={fixture()} />);
  expect(screen.getAllByRole('table')).toHaveLength(2);
  screen.getAllByRole('table').forEach(table => expect(within(table).getAllByRole('row')).toHaveLength(4));
  expect(screen.getByText('IGV')).toBeInTheDocument();
  expect(screen.getByText('SMH')).toBeInTheDocument();
  expect(screen.getByText('Uranium & nuclear')).toBeInTheDocument();
  expect(screen.getByText('+1.25%')).toHaveClass('is-positive');
  expect(screen.getByText('-0.65%')).toHaveClass('is-negative');
  const growth = screen.getByText('Growth vs value').closest('tr');
  expect(within(growth).getByText('+0.80 pp')).toHaveClass('is-positive');
  expect(growth).toHaveAttribute('title', expect.stringContaining('IWF − IWD'));
  expect(growth).toHaveAttribute('title', expect.stringContaining('+1.20% for the observed session'));
  expect(growth).toHaveAttribute('title', expect.stringContaining('+0.40% for the observed session'));
  expect(growth).toHaveAttribute('title', expect.stringContaining('Sep 24 10:40 ET'));
  expect(growth.title).not.toMatch(/\b(?:AM|PM)\b/);
});

test('discloses the ETF universe and issuer sources without claiming a proprietary short basket', () => {
  render(<MarketRotationPanels snapshot={fixture()} />);
  const themes = screen.getByRole('heading', { name: /THEMES/ });
  expect(themes).toHaveAttribute('title', expect.stringContaining('tracked 10-ETF universe'));
  expect(themes).toHaveAttribute('title', expect.stringContaining('Cybersecurity (CIBR)'));
  expect(screen.getByText('Software').closest('tr')).toHaveAttribute('title', expect.stringContaining('ishares.com'));
  expect(screen.getByRole('heading', { name: /FACTORS/ })).toHaveAttribute('title', expect.stringContaining('percentage points'));
  expect(screen.queryByText(/Goldman|short basket|buy|sell/i)).not.toBeInTheDocument();
});

test('withholds an incomplete ranking and a missing factor leg while keeping unrelated observations', () => {
  const data = fixture();
  data.status = 'partial';
  data.themes.coverage = { verified: 9, total: 10, comparable: false };
  data.factors[0].right = null;
  render(<MarketRotationPanels snapshot={data} />);
  expect(screen.queryByText('Uranium & nuclear')).not.toBeInTheDocument();
  expect(screen.getByText('+1.25%')).toBeInTheDocument();
  expect(screen.getByText('Growth vs value').closest('tr')).toHaveTextContent('—');
  expect(screen.getByText('Small vs large').closest('tr')).toHaveTextContent('-0.60 pp');
});

test.each([{ stale: true }, { mock: true }, { seeded: true }, { cacheOnly: true }, { connected: false }])('withholds a contaminated theme and keeps verified factors: %p', flags => {
  const data = fixture();
  data.themes.software = { ...data.themes.software, ...flags };
  render(<MarketRotationPanels snapshot={data} />);
  expect(screen.queryByText('+1.25%')).not.toBeInTheDocument();
  expect(screen.getByText('Growth vs value').closest('tr')).toHaveTextContent('+0.80 pp');
});

test('retains empty rows after a failed refresh and keeps the panels independent of the breadth data', () => {
  useMarketRotationSnapshot.mockReturnValue({ snapshot: fixture(), loading: false });
  const { rerender } = render(<MarketRotationPanels />);
  expect(screen.getByText('+1.25%')).toBeInTheDocument();
  useMarketRotationSnapshot.mockReturnValue({ snapshot: null, loading: false });
  rerender(<MarketRotationPanels />);
  expect(screen.queryByText('+1.25%')).not.toBeInTheDocument();
  expect(screen.getAllByRole('row')).toHaveLength(8);
  expect(screen.getAllByText('—')).toHaveLength(8);
});

test('displays verified completed-session observations as clickable delayed Ds', () => {
  const data = fixture();
  const close = item => item && { ...item, status: 'last-close' };
  for (const key of ['software', 'semiconductors', 'leader', 'laggard']) data.themes[key] = close(data.themes[key]);
  data.factors = data.factors.map(pair => ({ ...close(pair), left: close(pair.left), right: close(pair.right) }));
  render(<MarketRotationPanels snapshot={data} />);
  expect(screen.queryByText('LAST CLOSE')).not.toBeInTheDocument();
  expect(screen.getAllByText('D')).toHaveLength(2);
  const themes = screen.getByRole('heading', { name: /THEMES/ });
  const marker = within(themes).getByRole('button', { name: 'Updated Sep 24 10:40 ET' });
  expect(marker.closest('button') || marker).toHaveAttribute('data-data-age', 'same-session');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.click(marker);
  expect(screen.getByRole('status')).toHaveTextContent('Updated Sep 24 10:40 ET');
  expect(screen.getByText('Software').closest('tr')).toHaveAttribute('title', expect.stringContaining('DELAYED'));
});

test('colors current-session delayed headers orange and prior-session retained headers red without erasing readings', () => {
  const retained = retainMarketRotationSnapshot(mergeMarketRotationSnapshots(null, fixture()));
  const { rerender } = render(<MarketRotationPanels snapshot={fixture()} />);
  expect(screen.getAllByText('D')).toHaveLength(2);
  screen.getAllByText('D').forEach(marker => expect(marker.closest('button') || marker).toHaveAttribute('data-data-age', 'same-session'));

  jest.setSystemTime(new Date('2026-09-25T14:45:00.000Z'));
  act(() => jest.advanceTimersByTime(60_000));
  rerender(<MarketRotationPanels snapshot={retained} />);
  screen.getAllByText('D').forEach(marker => expect(marker.closest('button') || marker).toHaveAttribute('data-data-age', 'older-session'));
  expect(screen.getByText('+1.25%')).toBeInTheDocument();
  expect(screen.getByText('Growth vs value').closest('tr')).toHaveTextContent('+0.80 pp');
  expect(screen.getByText('Software').closest('tr')).toHaveAttribute('title', expect.stringContaining('Sep 24 10:40 ET'));
});
