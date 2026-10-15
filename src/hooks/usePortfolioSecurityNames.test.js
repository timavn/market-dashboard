import { renderHook, waitFor } from '@testing-library/react';
import { MarketDataService } from '../services/api/marketDataService';
import usePortfolioSecurityNames from './usePortfolioSecurityNames';

jest.mock('../services/api/marketDataService', () => ({ MarketDataService: { getSecurityIdentities: jest.fn() } }));

beforeEach(() => jest.clearAllMocks());

test('only verified descriptive names with sources supplement the captured report', async () => {
  const valid = { ticker: 'DBMF', name: 'iMGP DBi Managed Futures Strategy ETF', nameVerified: true, nameSource: 'Yahoo Finance instrument metadata' };
  MarketDataService.getSecurityIdentities.mockResolvedValue({ status: 'available', historicalOnly: true, executable: false, rows: [
    valid, { ...valid, ticker: 'UNVERIFIED', nameVerified: false }, { ...valid, ticker: 'REJECTED', identityStatus: 'rejected' },
    { ...valid, ticker: 'NOSOURCE', nameSource: null },
    ...['mock', 'seed', 'seeded', 'synthetic', 'inferred'].map(flag => ({ ...valid, ticker: flag, [flag]: true })),
  ] });
  const { result } = renderHook(() => usePortfolioSecurityNames([{ holding: 'DBMF' }]));
  await waitFor(() => expect(result.current.DBMF?.name).toBe(valid.name));
  expect(Object.keys(result.current)).toEqual(['DBMF']);
});

test('captured identities do not require a current directory request', () => {
  renderHook(() => usePortfolioSecurityNames([{ holding: 'DBMF', securityName: 'Captured fund name' }]));
  expect(MarketDataService.getSecurityIdentities).not.toHaveBeenCalled();
});

test('expanding the roster preserves previously verified descriptive names through a partial response', async () => {
  MarketDataService.getSecurityIdentities
    .mockResolvedValueOnce({ status: 'available', historicalOnly: true, executable: false, rows: [{ ticker: 'DBMF', name: 'Verified fund name', nameVerified: true, nameSource: 'Provider' }] })
    .mockResolvedValueOnce({ status: 'partial', historicalOnly: true, executable: false, rows: [{ ticker: 'RXL', name: 'Verified second fund', nameVerified: true, nameSource: 'Provider' }] });
  const { result, rerender } = renderHook(({ rows }) => usePortfolioSecurityNames(rows), { initialProps: { rows: [{ holding: 'DBMF' }] } });
  await waitFor(() => expect(result.current.DBMF?.name).toBe('Verified fund name'));
  rerender({ rows: [{ holding: 'DBMF' }, { holding: 'RXL' }] });
  await waitFor(() => expect(result.current.RXL?.name).toBe('Verified second fund'));
  expect(result.current.DBMF.name).toBe('Verified fund name');
});

test('an unavailable directory leaves names empty', async () => {
  MarketDataService.getSecurityIdentities.mockResolvedValue({ status: 'unavailable', historicalOnly: true, executable: false, rows: [{ ticker: 'DBMF', name: 'Old name', nameVerified: true, nameSource: 'Provider' }] });
  const { result } = renderHook(() => usePortfolioSecurityNames([{ holding: 'DBMF' }]));
  await waitFor(() => expect(MarketDataService.getSecurityIdentities).toHaveBeenCalledTimes(1));
  expect(result.current).toEqual({});
});

test('complete books exceeding the identity route limit are requested in exact bounded batches', async () => {
  const rows = Array.from({ length: 73 }, (_, index) => ({ holding: `S${String(index).padStart(2, '0')}` }));
  MarketDataService.getSecurityIdentities.mockImplementation(async symbols => ({ status: 'available', historicalOnly: true, executable: false,
    rows: symbols.map(ticker => ({ ticker, name: `${ticker} Corporation`, nameVerified: true, nameSource: 'Provider' })) }));
  const { result } = renderHook(() => usePortfolioSecurityNames(rows));
  await waitFor(() => expect(Object.keys(result.current)).toHaveLength(73));
  expect(MarketDataService.getSecurityIdentities.mock.calls.map(([symbols]) => symbols.length)).toEqual([50, 23]);
  expect(MarketDataService.getSecurityIdentities.mock.calls.flatMap(([symbols]) => symbols)).toEqual(rows.map(row => row.holding));
});

test('each batch ignores unsolicited identities and rejects failed provider flags', async () => {
  const valid = { ticker: 'DBMF', name: 'Verified fund name', nameVerified: true, nameSource: 'Provider' };
  for (const invalid of [{ offline: true }, { connected: false }, { status: 'error' }, { isMock: true }, { disconnected: true }]) {
    MarketDataService.getSecurityIdentities.mockResolvedValue({ status: 'available', historicalOnly: true, executable: false,
      rows: [{ ...valid, ...invalid }, { ...valid, ticker: 'UNREQUESTED' }, { ...valid, ticker: 'RXL', name: 'Verified requested fund' }] });
    const { result, unmount } = renderHook(() => usePortfolioSecurityNames([{ holding: 'DBMF' }, { holding: 'RXL' }]));
    await waitFor(() => expect(result.current.RXL?.name).toBe('Verified requested fund'));
    expect(Object.keys(result.current)).toEqual(['RXL']);
    unmount();
  }
});

test('a failed identity batch cannot prevent another batch from filling its exact names', async () => {
  MarketDataService.getSecurityIdentities.mockImplementation(async symbols => {
    if (symbols.length === 50) throw new Error('Provider failed');
    return { status: 'partial', historicalOnly: true, executable: false,
      rows: [{ ticker: symbols[0], name: 'Verified second-batch name', nameVerified: true, nameSource: 'Provider' }] };
  });
  const rows = Array.from({ length: 51 }, (_, index) => ({ holding: `S${String(index).padStart(2, '0')}` }));
  const { result } = renderHook(() => usePortfolioSecurityNames(rows));
  await waitFor(() => expect(result.current.S50?.name).toBe('Verified second-batch name'));
  expect(Object.keys(result.current)).toEqual(['S50']);
});

test('unverified provider envelopes cannot supplement descriptive identity', async () => {
  MarketDataService.getSecurityIdentities.mockResolvedValue({ status: 'available', historicalOnly: true, executable: false, connected: false,
    rows: [{ ticker: 'DBMF', name: 'Disconnected name', nameVerified: true, nameSource: 'Provider' }] });
  const { result } = renderHook(() => usePortfolioSecurityNames([{ holding: 'DBMF' }]));
  await waitFor(() => expect(MarketDataService.getSecurityIdentities).toHaveBeenCalledTimes(1));
  expect(result.current).toEqual({});
});
