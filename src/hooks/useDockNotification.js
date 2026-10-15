import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_PREFIX = 'market-dashboard:dock-notifications:v1';

function normalizeIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id) => (
    (typeof id === 'string' && id.trim().length > 0)
    || (typeof id === 'number' && Number.isFinite(id))
  )).map(String))].sort();
}

function readDismissedIds(key) {
  if (typeof window === 'undefined') return [];
  try {
    return normalizeIds(JSON.parse(window.localStorage.getItem(key)));
  } catch {
    return [];
  }
}

function writeDismissedIds(key, ids) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Dismissal still works for this mounted dock when storage is unavailable.
  }
}

export default function useDockNotification({ channel, scope = 'default', notificationIds = [] }) {
  const storageKey = `${STORAGE_PREFIX}:${encodeURIComponent(channel)}:${encodeURIComponent(scope)}`;
  const storedIds = useMemo(() => readDismissedIds(storageKey), [storageKey]);
  const identity = JSON.stringify(normalizeIds(notificationIds));
  const incomingIds = useMemo(() => JSON.parse(identity), [identity]);
  const [state, setState] = useState(() => ({
    key: storageKey,
    dismissedIds: storedIds,
    pendingIds: [],
  }));
  const current = useMemo(() => (state.key === storageKey
    ? state
    : { key: storageKey, dismissedIds: storedIds, pendingIds: [] }), [state, storageKey, storedIds]);

  useEffect(() => {
    setState((previous) => {
      const active = previous.key === storageKey
        ? previous
        : { key: storageKey, dismissedIds: storedIds, pendingIds: [] };
      const additions = incomingIds.filter((id) => (
        !active.dismissedIds.includes(id) && !active.pendingIds.includes(id)
      ));
      if (active === previous && additions.length === 0) return previous;
      return { ...active, pendingIds: [...active.pendingIds, ...additions] };
    });
  }, [storageKey, storedIds, incomingIds]);

  const dismiss = useCallback(() => {
    const dismissedIds = normalizeIds([
      ...current.dismissedIds,
      ...current.pendingIds,
      ...incomingIds,
    ]);
    if (dismissedIds.length > 0) writeDismissedIds(storageKey, dismissedIds);
    setState({ key: storageKey, dismissedIds, pendingIds: [] });
  }, [current, incomingIds, storageKey]);

  return {
    hasNotification: current.pendingIds.length > 0
      || incomingIds.some((id) => !current.dismissedIds.includes(id)),
    dismiss,
  };
}
