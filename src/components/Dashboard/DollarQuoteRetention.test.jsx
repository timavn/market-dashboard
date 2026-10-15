import React from 'react';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExceptionFirstRadar from './ExceptionFirstRadar';
import { createMarketQuoteReferenceStore } from '../../services/marketQuoteReferenceStore.cjs';

jest.mock('./GlobalMarketDayCycleHeader', () => () => null);
jest.mock('./MarketPulseRibbon', () => () => null);
// Keep the real quote guards: a permissive status mock hid the Dollar opt-in bug.
jest.mock('./RadarReferencePanels', () => ({
  ...jest.requireActual('./RadarReferencePanels'),
  __esModule: true,
  default: () => null,
}));

const OBSERVED_AT = '2026-09-11T20:00:00.000Z';
const NOW = Date.parse('2026-09-12T21:00:00.000Z');
const currency = (overrides = {}) => ({
  symbol: 'USDCHF',
  name: 'USD/CHF',
  price: 0.82,
  changePercent: 1.23,
  fifteenDayChangePct: 1.93,
  monthChangePct: 0.24,
  threeMonthChangePct: 2.9,
  sixMonthChangePct: 3.47,
  ytdChangePct: 3.04,
  oneYearChangePct: 2.53,
  source: 'yahoo',
  dataType: 'delayed',
  availability: 'delayed',
  quoteAsOf: OBSERVED_AT,
  timestamp: OBSERVED_AT,
  periodReturnsStatus: 'historical',
  periodReturnsAsOf: '2026-09-11',
  ...overrides,
});

const dollarRow = (name) => within(screen.getByRole('table', {
  name: 'USD currency spreadsheet',
})).getByRole('row', { name: new RegExp(name) });

describe('Dollar informational quote retention', () => {
  let dataDir;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dollar-retention-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('keeps prices and returns through partial failures, disconnects and reloads, then accepts recovery', () => {
    const store = createMarketQuoteReferenceStore({ dataDir, now: () => NOW });
    const reconcile = (incomingRows) => store.reconcileRows({
      scope: 'currencies', mode: 'periods', incomingRows,
      expectedSymbols: ['USDCHF', 'EURUSD'],
    });
    const euro = currency({ symbol: 'EURUSD', name: 'EUR/USD', price: 1.25 });
    const initial = reconcile([currency(), euro]);
    const onDashboardStatusChange = jest.fn();
    const view = render(<ExceptionFirstRadar
      marketData={{ currencies: initial }} onDashboardStatusChange={onDashboardStatusChange}
    />);
    expect(dollarRow('USD/CHF')).toHaveTextContent('0.820');
    expect(dollarRow('USD/EUR')).toHaveTextContent('0.800');

    const partial = reconcile([euro]);
    view.rerender(<ExceptionFirstRadar
      marketData={{ currencies: partial }} onDashboardStatusChange={onDashboardStatusChange}
    />);
    const swiss = dollarRow('USD/CHF');
    // Retained period returns carry the shared D marker with their original history date.
    expect(within(swiss).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'USD/CHF', '0.820D', '1.23%', '1.93%D', '0.24%D', '2.90%D', '3.47%D', '3.04%D', '2.53%D',
    ]);
    expect(within(swiss).getAllByRole('cell')[3])
      .toHaveAttribute('title', expect.stringMatching(/Last verified historical return · Sep 11, 2026/));
    expect(within(swiss).getByRole('button', { name: /last verified 2026-09-11T20:00:00.000Z/ }))
      .toHaveAttribute('data-data-status', 'refresh-delayed');

    const failed = reconcile([currency({ availability: 'unavailable', price: null })]);
    store.flush();
    view.rerender(<ExceptionFirstRadar
      marketData={{ currencies: failed }} providerStatus={{ ibkr: { connected: false } }}
      marketDataError="Refresh failed" onDashboardStatusChange={onDashboardStatusChange}
    />);
    expect(dollarRow('USD/CHF')).toHaveTextContent('0.820');
    expect(dollarRow('USD/EUR')).toHaveTextContent('0.800');
    expect(within(dollarRow('USD/EUR')).getByRole('button', { name: /last verified/ }))
      .toHaveAccessibleName(expect.stringContaining(OBSERVED_AT));
    const statuses = onDashboardStatusChange.mock.calls.at(-1)[0];
    expect(statuses.find(({ id }) => id === 'usd').issues.join(' ')).not.toMatch(/USD\/CHF|EUR\/USD/);

    view.unmount();
    const reloadedStore = createMarketQuoteReferenceStore({ dataDir, now: () => NOW });
    const restored = reloadedStore.reconcileRows({
      scope: 'currencies', mode: 'periods', incomingRows: [], expectedSymbols: ['USDCHF', 'EURUSD'],
    });
    const { rerender } = render(<ExceptionFirstRadar marketData={{ currencies: restored }} />);
    expect(dollarRow('USD/CHF')).toHaveTextContent('0.820');
    expect(restored[0]).toMatchObject({
      source: 'yahoo', quoteAsOf: OBSERVED_AT, lastVerifiedAt: OBSERVED_AT,
      displayOnly: true, executable: false,
    });

    const recovered = reloadedStore.reconcileRows({
      scope: 'currencies', mode: 'periods', expectedSymbols: ['USDCHF', 'EURUSD'],
      incomingRows: [currency({ price: 0.825, quoteAsOf: '2026-09-12T20:59:00.000Z',
        timestamp: '2026-09-12T20:59:00.000Z' })],
    });
    rerender(<ExceptionFirstRadar marketData={{ currencies: recovered }} />);
    expect(dollarRow('USD/CHF')).toHaveTextContent('0.825');
    expect(within(dollarRow('USD/CHF')).getByRole('button', { name: /2026-09-12T20:59:00.000Z/ }))
      .toHaveAttribute('data-data-status', 'delayed');
    expect(dollarRow('USD/EUR')).toHaveTextContent('0.800');
  });

  test.each([
    { quoteAsOf: '2026-09-01T20:00:00.000Z', timestamp: '2026-09-01T20:00:00.000Z' },
    { source: 'ibkr', availability: 'current', dataType: 'live',
      quoteAsOf: '2026-09-12T20:59:59.000Z', timestamp: '2026-09-12T20:59:59.000Z' },
  ])('keeps a verified observation when it ages or the provider disconnects: %j', (overrides) => {
    render(<ExceptionFirstRadar marketData={{ currencies: [currency(overrides)] }}
      providerStatus={{ ibkr: { connected: false } }}
    />);
    expect(dollarRow('USD/CHF')).toHaveTextContent('0.820');
    expect(within(dollarRow('USD/CHF')).getByRole('button', { name: /last verified/ }))
      .toHaveAttribute('data-data-status', 'refresh-delayed');
  });

  test.each([
    { source: 'mock' }, { seeded: true }, { cacheOnly: true }, { fromCache: true },
    { freshness: 'stale' }, { source: 'portfolio' },
    { quoteAsOf: null, timestamp: null },
  ])('does not fabricate a reading when no verified observation exists: %j', (invalid) => {
    render(<ExceptionFirstRadar marketData={{ currencies: [currency(invalid)] }} />);
    const row = dollarRow('USD/CHF');
    expect(within(row).getAllByRole('cell').slice(1).map((cell) => cell.textContent))
      .toEqual(Array(8).fill('—'));
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });
});
