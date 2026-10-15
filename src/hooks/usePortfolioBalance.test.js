import { renderHook, waitFor } from '@testing-library/react';
import {
  clearPortfolioBalanceReferenceSnapshotsForTests,
  usePortfolioBalance,
} from './usePortfolioBalance';
import { useSessionResource } from './useSessionResource';

jest.mock('./useSessionResource', () => ({
  useSessionResource: jest.fn(),
}));

jest.mock('../services/api/marketDataService', () => ({
  MarketDataService: {
    getPortfolioBalance: jest.fn(),
  },
}));

function snapshot(accountId = 'U1', snapshotId = 'snapshot-1') {
  return {
    accountId,
    snapshotId,
    source: 'ibkr_live_session',
    status: 'live',
    fromCache: false,
    observedAt: new Date().toISOString(),
  };
}

function resource(overrides = {}) {
  return {
    data: null,
    error: null,
    availability: 'unavailable',
    initialLoading: false,
    refreshing: false,
    observedAt: null,
    refresh: jest.fn(),
    ...overrides,
  };
}

describe('usePortfolioBalance last-verified reference snapshots', () => {
  let currentResource;

  beforeEach(() => {
    clearPortfolioBalanceReferenceSnapshotsForTests();
    currentResource = resource();
    useSessionResource.mockImplementation(() => currentResource);
  });

  test('retains a same-account live snapshot in memory through a transient sidecar failure', async () => {
    const live = snapshot();
    currentResource = resource({
      data: live,
      availability: 'live',
      observedAt: live.observedAt,
    });
    const { result, rerender } = renderHook(
      ({ account }) => usePortfolioBalance(account),
      { initialProps: { account: 'U1' } },
    );
    expect(result.current).toMatchObject({
      status: 'live',
      executable: true,
      snapshot: live,
    });
    await waitFor(() => expect(result.current.snapshot).toBe(live));

    currentResource = resource({
      error: Object.assign(new Error('sidecar restart'), {
        code: 'IBKR_SIDECAR_UNREACHABLE',
      }),
    });
    rerender({ account: 'U1' });

    expect(result.current).toMatchObject({
      status: 'last_verified',
      executable: false,
      snapshot: live,
      lastVerifiedAt: live.observedAt,
    });
  });

  test('replaces the reference only with a newer verified live snapshot', async () => {
    const first = snapshot('U1', 'snapshot-1');
    currentResource = resource({ data: first, availability: 'live' });
    const { result, rerender } = renderHook(() => usePortfolioBalance('U1'));
    await waitFor(() => expect(result.current.snapshot).toBe(first));

    const second = snapshot('U1', 'snapshot-2');
    currentResource = resource({ data: second, availability: 'live' });
    rerender();
    await waitFor(() => expect(result.current.snapshot).toBe(second));

    currentResource = resource({
      error: Object.assign(new Error('timed out'), {
        code: 'IBKR_BALANCE_REQUEST_TIMEOUT',
      }),
    });
    rerender();
    expect(result.current.snapshot.snapshotId).toBe('snapshot-2');
    expect(result.current.status).toBe('last_verified');
  });

  test.each([
    'ACCOUNT_NOT_MANAGED',
    'ACCOUNT_UPDATE_ACCOUNT_MISMATCH',
    'MANAGED_ACCOUNTS_MISSING',
    'ACCOUNT_NOT_READY',
  ])('retains the reference while sidecar account state rebuilds (%s)', async (code) => {
    const live = snapshot();
    currentResource = resource({
      data: live,
      availability: 'live',
      observedAt: live.observedAt,
    });
    const { result, rerender } = renderHook(() => usePortfolioBalance('U1'));
    await waitFor(() => expect(result.current.snapshot).toBe(live));

    currentResource = resource({
      error: Object.assign(new Error('The sidecar account subscription is rebuilding.'), {
        code,
      }),
    });
    rerender();

    expect(result.current).toMatchObject({
      status: 'last_verified',
      executable: false,
      snapshot: live,
    });
  });

  test('clears references on account changes and account mismatches', async () => {
    const live = snapshot();
    currentResource = resource({ data: live, availability: 'live' });
    const { result, rerender } = renderHook(
      ({ account }) => usePortfolioBalance(account),
      { initialProps: { account: 'U1' } },
    );
    await waitFor(() => expect(result.current.snapshot).toBe(live));

    currentResource = resource({
      error: Object.assign(new Error('sidecar unavailable'), {
        code: 'IBKR_SIDECAR_UNREACHABLE',
      }),
    });
    rerender({ account: 'U2' });
    expect(result.current.status).toBe('unavailable');
    expect(result.current.snapshot).toBeNull();

    rerender({ account: 'U1' });
    expect(result.current.snapshot).toBeNull();

    currentResource = resource({ data: live, availability: 'live' });
    rerender({ account: 'U1' });
    await waitFor(() => expect(result.current.snapshot).toBe(live));
    currentResource = resource({
      error: Object.assign(new Error('wrong account'), {
        code: 'PORTFOLIO_BALANCE_ACCOUNT_MISMATCH',
      }),
    });
    rerender({ account: 'U1' });
    expect(result.current.status).toBe('unavailable');
    expect(result.current.snapshot).toBeNull();
  });

  test('clears a reference when broker evidence reports a different account', async () => {
    const live = snapshot();
    currentResource = resource({ data: live, availability: 'live' });
    const { result, rerender } = renderHook(() => usePortfolioBalance('U1'));
    await waitFor(() => expect(result.current.snapshot).toBe(live));

    currentResource = resource({
      error: Object.assign(new Error('wrong account'), {
        code: 'IBKR_GATEWAY_UNAVAILABLE',
        response: {
          data: {
            errorCode: 'IBKR_GATEWAY_UNAVAILABLE',
            accountId: 'U2',
          },
        },
      }),
    });
    rerender();

    expect(result.current.status).toBe('unavailable');
    expect(result.current.snapshot).toBeNull();
  });
});
