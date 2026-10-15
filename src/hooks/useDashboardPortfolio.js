import { useCallback, useEffect, useRef, useState } from 'react';
import { useDashboardResource } from './useDashboardResource';
import { MarketDataService } from '../services/api/marketDataService';
import { loadSelectedAccount, saveSelectedAccount, saveIbkrAccounts } from '../constants/ibkrAccountStorage';
import { getIbkrConnectionDisplay, getPreferredIbkrAccount } from '../utils/ibkrConnectionStatus';
import { PORTFOLIO_POLL_MS, PROVIDER_STATUS_POLL_MS, PROVIDER_STATUS_POLL_OFFLINE_MS, PROVIDER_STATUS_TIMEOUT_MS, PORTFOLIO_REQUEST_TIMEOUT_MS, PORTFOLIO_LIVE_MAX_AGE_MS } from '../constants/dashboardResourceTiming';

const withTimeout = (promise, timeoutMs, label) => new Promise((resolve, reject) => {
  const timeoutId = setTimeout(() => {
    const error = new Error(`${label} timed out after ${timeoutMs}ms`);
    error.code = 'ETIMEDOUT';
    reject(error);
  }, timeoutMs);

  promise.then(
    (value) => {
      clearTimeout(timeoutId);
      resolve(value);
    },
    (error) => {
      clearTimeout(timeoutId);
      reject(error);
    },
  );
});

const isConnectedProviderStatus = (status) => Boolean(
  status?.ibkr?.connected ||
  status?.ibkr?.status === 'connected' ||
  status?.portfolio?.ibkr?.connected ||
  status?.portfolio?.ibkr?.status === 'connected',
);

const isRejectedPortfolioResponse = (snapshot) => (
  snapshot?.dataSource === 'ibkr_offline'
  || (
    snapshot?.dataSource === 'ibkr_api'
    && snapshot?.liveSessionVerified !== true
  )
  || snapshot?.dataSource !== 'ibkr_api'
  || snapshot?.fromCache !== false
  || snapshot?._cache?.stale === true
);

const validateLivePortfolioSnapshot = (snapshot, expectedAccount) => {
  const reportedAccount = String(snapshot?.accountId || '').trim();
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || isRejectedPortfolioResponse(snapshot)
    || (expectedAccount && reportedAccount !== expectedAccount)
    || !snapshot.fetchedAt
    || !snapshot.socketVerifiedAt
  ) {
    throw Object.assign(
      new Error(
        snapshot?.dataSource === 'ibkr_offline'
          ? 'IBKR is disconnected; the live portfolio is unavailable.'
          : 'The portfolio response was not verified live account data.',
      ),
      {
        code: snapshot?.dataSource === 'ibkr_offline'
          ? 'PORTFOLIO_GATEWAY_OFFLINE'
          : expectedAccount && reportedAccount && reportedAccount !== expectedAccount
            ? 'PORTFOLIO_ACCOUNT_MISMATCH'
            : 'PORTFOLIO_RESPONSE_UNVERIFIED',
        liveInvalidation: true,
      },
    );
  }
  return snapshot;
};

export function useDashboardPortfolio({ surfaceActive }) {
  const [selectedAccount, setSelectedAccount] = useState(() => loadSelectedAccount());

  const loadPortfolio = useCallback(() => withTimeout(
    MarketDataService.getPortfolio({ account: selectedAccount || undefined }),
    PORTFOLIO_REQUEST_TIMEOUT_MS,
    'Portfolio refresh',
  ), [selectedAccount]);

  const validatePortfolio = useCallback(
    (snapshot) => validateLivePortfolioSnapshot(snapshot, selectedAccount),
    [selectedAccount],
  );

  const portfolioResource = useDashboardResource('portfolio', {
    accountId: selectedAccount,
  }, {
    fetcher: loadPortfolio,
    validate: validatePortfolio,
    getObservedAt: (snapshot) => snapshot.fetchedAt,
    maxAgeMs: PORTFOLIO_LIVE_MAX_AGE_MS,
    pollIntervalMs: PORTFOLIO_POLL_MS,
    enabled: Boolean(selectedAccount),
    active: true,
    pollWhenHidden: true,
    pollWhenDocumentHidden: false,
    invalidateOnScopeChange: true,
    core: true,
    expectedScope: selectedAccount,
    getScope: (snapshot) => snapshot.accountId,
    expiredCode: 'PORTFOLIO_SNAPSHOT_EXPIRED',
    expiredMessage: 'The last verified live portfolio snapshot expired.',
  });

  const portfolioData = selectedAccount ? portfolioResource.data : null;

  const portfolioLoading = Boolean(
    selectedAccount && portfolioResource.initialLoading && !portfolioData
  );

  const portfolioRefreshing = Boolean(selectedAccount && portfolioResource.refreshing);

  const refreshPortfolioResource = portfolioResource.refresh;

  const ibkrAccountsRef = useRef([]);

  const selectedAccountRef = useRef(loadSelectedAccount());

  const [ibkrConnection, setIbkrConnection] = useState(null);

  const [providerStatus, setProviderStatus] = useState(null);

  const ibkrConnectionRef = useRef(null);

  const lastGoodProviderStatusRef = useRef(null);

  const providerStatusInFlightRef = useRef(null);

  const fetchPortfolio = useCallback((accountId) => {
    const requestedAccount = String(accountId || '').trim();
    if (
      requestedAccount
      && selectedAccountRef.current
      && requestedAccount !== selectedAccountRef.current
    ) {
      return Promise.resolve(null);
    }
    return refreshPortfolioResource();
  }, [refreshPortfolioResource]);

  const handleAccountChange = useCallback((accountId) => {
    saveSelectedAccount(accountId);
    selectedAccountRef.current = accountId || '';
    setSelectedAccount(accountId);
    // The account-scoped resource key changes on the next render, so the old
    // account snapshot can never be exposed while the new read is in flight.
    return Promise.resolve(null);
  }, []);

  const refreshProviderStatus = useCallback(async () => {
    if (providerStatusInFlightRef.current) return providerStatusInFlightRef.current;
    const request = (async () => {
      try {
        const status = await withTimeout(
          MarketDataService.getProviderStatus(),
          PROVIDER_STATUS_TIMEOUT_MS,
          'Provider status',
        );
        if (isConnectedProviderStatus(status)) {
          lastGoodProviderStatusRef.current = status;
        }
        setProviderStatus(status);
        const list = status?.ibkr?.accounts || status?.portfolio?.ibkr?.accounts || [];
        if (Array.isArray(list) && list.length > 0) {
          ibkrAccountsRef.current = list;
          saveIbkrAccounts(list);
        }
        setIbkrConnection(getIbkrConnectionDisplay({ status, error: null }));
        return status;
      } catch (err) {
        const lastGoodStatus = lastGoodProviderStatusRef.current;
        if (lastGoodStatus && (err?.code === 'ETIMEDOUT' || /timed out/i.test(err?.message || ''))) {
          const delayedStatus = {
            ...lastGoodStatus,
            statusRefreshDelayed: true,
            statusRefreshError: err.message,
            statusRefreshDelayedAt: new Date().toISOString(),
          };
          setProviderStatus(delayedStatus);
          const delayedConnection = getIbkrConnectionDisplay({ status: delayedStatus, error: null });
          setIbkrConnection({
            ...delayedConnection,
            statusRefreshDelayed: true,
            statusRefreshError: err.message,
            statusRefreshDelayedAt: delayedStatus.statusRefreshDelayedAt,
          });
          return delayedStatus;
        }
        setProviderStatus({
          unavailable: true,
          error: err.message || 'Provider status unavailable',
          responseTimestamp: new Date().toISOString(),
          ibkr: { connected: false, status: 'offline' },
        });
        setIbkrConnection(getIbkrConnectionDisplay({ status: null, error: err.message }));
        throw err;
      }
    })().finally(() => {
      if (providerStatusInFlightRef.current === request) providerStatusInFlightRef.current = null;
    });
    providerStatusInFlightRef.current = request;
    return request;
  }, []);

  const resolvePortfolioAccount = useCallback((status = null) => {
    const explicit = selectedAccountRef.current || selectedAccount || '';
    if (status) {
      return getPreferredIbkrAccount(status, explicit) || undefined;
    }
    if (explicit) {
      return explicit;
    }
    return ibkrAccountsRef.current[0] || undefined;
  }, [selectedAccount]);

  useEffect(() => {
    ibkrConnectionRef.current = ibkrConnection;
  }, [ibkrConnection]);

  useEffect(() => {
    selectedAccountRef.current = selectedAccount || '';
  }, [selectedAccount]);

  const pollingFnsRef = useRef({});

  pollingFnsRef.current = {
    handleAccountChange,
    refreshProviderStatus,
    resolvePortfolioAccount,
  };

  useEffect(() => {
    if (!surfaceActive) return undefined;
    let cancelled = false;
    let statusTimeout = null;
    let running = false;
    let suspended = Boolean(document.hidden);

    const scheduleStatusPoll = () => {
      if (cancelled || document.hidden) return;
      const delay = ibkrConnectionRef.current?.connected
        ? PROVIDER_STATUS_POLL_MS
        : PROVIDER_STATUS_POLL_OFFLINE_MS;
      statusTimeout = setTimeout(load, delay);
    };
    const load = async () => {
      if (cancelled || document.hidden || running) return;
      running = true;
      try {
        const status = await pollingFnsRef.current.refreshProviderStatus();
        if (cancelled) return;
        const acct = pollingFnsRef.current.resolvePortfolioAccount(status);
        if (acct && acct !== selectedAccountRef.current) {
          await pollingFnsRef.current.handleAccountChange(acct);
        }
      } catch {
        // Provider health decorates connection state. The independently keyed
        // portfolio resource owns its own availability and refresh lifecycle.
      } finally {
        running = false;
        scheduleStatusPoll();
      }
    };
    const handleVisibilityChange = () => {
      const hidden = Boolean(document.hidden);
      if (suspended === hidden) return;
      suspended = hidden;
      clearTimeout(statusTimeout);
      statusTimeout = null;
      if (!document.hidden) void load();
    };

    void load();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      clearTimeout(statusTimeout);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // Polling callbacks are read from pollingFnsRef so UI state changes do not
    // tear down and recreate the dashboard's background refresh loops.
  }, [surfaceActive]);

  return { selectedAccount, portfolioData, portfolioLoading, portfolioRefreshing, ibkrConnection, providerStatus, fetchPortfolio, handleAccountChange, refreshProviderStatus, resolvePortfolioAccount };
}

export default useDashboardPortfolio;
