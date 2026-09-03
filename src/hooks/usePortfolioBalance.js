import { useCallback, useEffect, useRef } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { useSessionResource } from './useSessionResource';

export const PORTFOLIO_BALANCE_POLL_MS = 15_000;
export const PORTFOLIO_BALANCE_MAX_AGE_MS = 45_000;

// Deliberately process-memory only. A verified balance may remain visible as
// non-executable reference data while the sidecar reconnects, but it must not
// survive a browser reload or be hydrated from storage.
const lastVerifiedBalanceByAccount = new Map();

function snapshotIsFresh(snapshot, now = Date.now()) {
  const observedAt = Date.parse(String(snapshot?.observedAt || ''));
  if (!Number.isFinite(observedAt)) return false;
  const age = now - observedAt;
  return age >= -5_000 && age <= PORTFOLIO_BALANCE_MAX_AGE_MS;
}

function unavailableFromError(error) {
  const payload = error?.response?.data;
  return {
    code:
      payload?.errorCode
      || error?.code
      || 'PORTFOLIO_BALANCE_UNAVAILABLE',
    message:
      payload?.message
      || error?.message
      || 'Verified live IBKR portfolio balance is unavailable.',
    observedAt: payload?.observedAt || null,
  };
}

function balanceErrorCode(error) {
  const payload = error?.response?.data;
  return String(
    payload?.errorCode
      || error?.code
      || error?.sidecarCode
      || '',
  ).trim().toUpperCase();
}

function isBalanceAccountMismatch(error, expectedAccount = '') {
  const payload = error?.response?.data || {};
  const code = balanceErrorCode(error);
  const reportedAccount = String(payload.accountId || payload.account || '').trim();
  if (reportedAccount && expectedAccount && reportedAccount !== expectedAccount) {
    return true;
  }

  // Sidecar startup can briefly report ACCOUNT_NOT_MANAGED or
  // ACCOUNT_UPDATE_ACCOUNT_MISMATCH while its dedicated account subscription
  // is being rebuilt. Those are failed reads for the requested account, not
  // proof that the selected account changed. Only clear reference data when a
  // response actually belongs to another scope (or client validation says it
  // did).
  return [
    'ACCOUNT_MISMATCH',
    'PORTFOLIO_BALANCE_ACCOUNT_MISMATCH',
    'LIVE_RESOURCE_SCOPE_MISMATCH',
  ].includes(code);
}

function isRetainableBalanceInterruption(error) {
  if (!error) return true;
  const payload = error?.response?.data || {};
  const code = balanceErrorCode(error);
  if (/(?:ACCOUNT_REQUIRED|CACHE|MOCK|SEED|POSITION_SCOPE|ACCOUNTING_UNRECONCILED)/.test(code)) {
    return false;
  }
  if (/(?:GATEWAY|SIDECAR|POSITIONS|CLIENT_ID|SOCKET|TIMEOUT|TIMED_OUT|REQUEST_CANCEL|DISCONNECT|OFFLINE|STALE|EXPIRED|ECONNREFUSED|NETWORK|ACCOUNT_NOT_MANAGED|ACCOUNT_UPDATE_ACCOUNT_MISMATCH|MANAGED_ACCOUNTS_MISSING|ACCOUNT_NOT_READY)/.test(code)) {
    return true;
  }
  const message = String(error?.message || payload.message || '').toLowerCase();
  return /gateway|sidecar|socket|timed? out|timeout|cancelled|disconnect|offline|connection refused|econnrefused|network error|fetch failed|expired/.test(message);
}

function isExplicitBalanceInvalidation(error, expectedAccount = '') {
  const payload = error?.response?.data || {};
  const code = balanceErrorCode(error);
  const reportedAccount = String(payload.accountId || payload.account || '').trim();
  if (reportedAccount && expectedAccount && reportedAccount !== expectedAccount) {
    return true;
  }

  const explicitCodeTokens = [
    'GATEWAY',
    'SIDECAR',
    'POSITIONS',
    'SOCKET',
    'CLIENT_ID',
    'TIMEOUT',
    'TIMED_OUT',
    'REQUEST_CANCEL',
    'DISCONNECT',
    'OFFLINE',
    'ACCOUNT_NOT_MANAGED',
    'ACCOUNT_REQUIRED',
    'ACCOUNT_MISMATCH',
    'ACCOUNT_UPDATE_ACCOUNT_MISMATCH',
    'ACCOUNT_NOT_READY',
    'MANAGED_ACCOUNTS_MISSING',
    'SOCKET_TIMESTAMP',
    'STALE',
    'EXPIRED',
    'CACHE',
    'MOCK',
    'SEED',
  ];
  if (explicitCodeTokens.some((token) => code.includes(token))) return true;

  const message = String(error?.message || payload.message || '').toLowerCase();
  return error?.reason === 'sidecar_offline'
    || /gateway|positions?|socket|client id|timed? out|timeout|cancelled|sidecar.*(?:offline|unavailable)|ibkr.*(?:disconnect|offline)|connection refused|econnrefused|network error|fetch failed|cache|mock|seed/.test(message);
}

function validateBalanceSnapshot(snapshot, expectedAccount) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw Object.assign(new Error('The balance response did not contain a verified snapshot.'), {
      code: 'PORTFOLIO_BALANCE_DATA_MISSING',
    });
  }
  const reportedAccount = String(snapshot.accountId || snapshot.account || '').trim();
  if (reportedAccount && expectedAccount && reportedAccount !== expectedAccount) {
    throw Object.assign(new Error('The balance response belongs to a different account.'), {
      code: 'PORTFOLIO_BALANCE_ACCOUNT_MISMATCH',
    });
  }
  const evidenceText = [
    snapshot.source,
    snapshot.status,
    snapshot.availability,
    snapshot.warning,
    snapshot.error,
  ].filter(Boolean).join(' ');
  if (
    snapshot.fromCache === true
    || snapshot?._cache?.stale === true
    || /cache|mock|seed|synthetic|fallback|inferred|portfolio-derived|stale|expired|offline|disconnected/i.test(evidenceText)
  ) {
    throw Object.assign(new Error('The balance response was not verified live broker data.'), {
      code: 'PORTFOLIO_BALANCE_FORBIDDEN_SOURCE',
      liveInvalidation: true,
    });
  }
  return snapshot;
}

export function usePortfolioBalance(accountId, { active = true } = {}) {
  const normalizedAccount = String(accountId || '').trim();
  const previousAccountRef = useRef(normalizedAccount);
  const fetcher = useCallback(() => MarketDataService.getPortfolioBalance({
    account: normalizedAccount,
  }), [normalizedAccount]);
  const validate = useCallback(
    (snapshot) => validateBalanceSnapshot(snapshot, normalizedAccount),
    [normalizedAccount],
  );
  const explicitInvalidation = useCallback(
    (error) => isExplicitBalanceInvalidation(error, normalizedAccount),
    [normalizedAccount],
  );

  const resource = useSessionResource({
    resourceKey: 'portfolio-balance',
    scopeKey: normalizedAccount,
    kind: 'live',
    fetcher,
    validate,
    getObservedAt: (snapshot) => snapshot.observedAt,
    maxAgeMs: PORTFOLIO_BALANCE_MAX_AGE_MS,
    pollIntervalMs: PORTFOLIO_BALANCE_POLL_MS,
    enabled: Boolean(normalizedAccount),
    active,
    refreshOnActivate: false,
    pollWhenHidden: false,
    pollWhenDocumentHidden: false,
    invalidateOnScopeChange: true,
    core: true,
    isExplicitInvalidation: explicitInvalidation,
    expectedScope: normalizedAccount,
    getScope: (snapshot) => snapshot.accountId || snapshot.account || null,
    expiredCode: 'PORTFOLIO_BALANCE_STALE',
    expiredMessage: 'The last verified portfolio balance is older than 45 seconds.',
  });

  const accountChanged = previousAccountRef.current !== normalizedAccount;
  if (accountChanged) {
    lastVerifiedBalanceByAccount.delete(previousAccountRef.current);
    lastVerifiedBalanceByAccount.delete(normalizedAccount);
    previousAccountRef.current = normalizedAccount;
  }

  useEffect(() => {
    if (!normalizedAccount || !resource.data) return;
    const verifiedAt = resource.data.observedAt || resource.observedAt || null;
    const existing = lastVerifiedBalanceByAccount.get(normalizedAccount);
    const candidateTime = Date.parse(String(verifiedAt || ''));
    const existingTime = Date.parse(String(existing?.verifiedAt || ''));
    if (
      !existing
      || !Number.isFinite(existingTime)
      || (Number.isFinite(candidateTime) && candidateTime >= existingTime)
    ) {
      lastVerifiedBalanceByAccount.set(normalizedAccount, {
        snapshot: resource.data,
        verifiedAt,
      });
    }
  }, [normalizedAccount, resource.data, resource.observedAt]);

  useEffect(() => {
    if (!normalizedAccount || !resource.error) return;
    if (isBalanceAccountMismatch(resource.error, normalizedAccount)) {
      lastVerifiedBalanceByAccount.delete(normalizedAccount);
    }
  }, [normalizedAccount, resource.error]);

  if (!normalizedAccount) {
    return {
      status: 'unavailable',
      snapshot: null,
      liveSnapshot: null,
      executable: false,
      lastVerifiedAt: null,
      error: { code: 'BALANCE_ACCOUNT_REQUIRED', message: 'Select an account.' },
      refresh: resource.refresh,
      refreshing: false,
      loading: false,
    };
  }

  const error = resource.error ? unavailableFromError(resource.error) : null;
  const retained = !resource.data
    && !accountChanged
    && !isBalanceAccountMismatch(resource.error, normalizedAccount)
    && isRetainableBalanceInterruption(resource.error)
    ? lastVerifiedBalanceByAccount.get(normalizedAccount) || null
    : null;
  const status = resource.data
    ? 'live'
    : retained
      ? 'last_verified'
      : resource.initialLoading || resource.availability === 'loading'
        ? 'loading'
        : 'unavailable';

  return {
    status,
    snapshot: resource.data || retained?.snapshot || null,
    liveSnapshot: resource.data,
    executable: status === 'live',
    lastVerifiedAt: retained?.verifiedAt || null,
    error,
    refresh: resource.refresh,
    refreshing: resource.refreshing,
    loading: resource.initialLoading && !resource.data,
    availability: resource.availability,
    observedAt: resource.observedAt,
  };
}

export function clearPortfolioBalanceReferenceSnapshotsForTests() {
  lastVerifiedBalanceByAccount.clear();
}

export { snapshotIsFresh };
