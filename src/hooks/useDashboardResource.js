import { useMemo } from 'react';
import { resolveDashboardResourceDefinition } from '../utils/dashboardResourceRegistry';
import { useSessionResource } from './useSessionResource';

export function useDashboardResource(definitionId, context = {}, overrides = {}) {
  const contextKey = JSON.stringify(context || {});
  const config = useMemo(
    () => resolveDashboardResourceDefinition(definitionId, context, overrides),
    // Callers are expected to memoize function overrides, just as they do for
    // useSessionResource. The serialized context keeps primitive scope changes
    // explicit without making a fresh resource on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [definitionId, contextKey, overrides],
  );
  return useSessionResource(config);
}

export default useDashboardResource;
