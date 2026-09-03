import {
  DASHBOARD_RESOURCE_CLASSIFICATIONS,
  getDashboardResourceDefinition,
  resolveDashboardResourceDefinition,
} from './dashboardResourceRegistry';
import { getSessionResource } from './sessionResourceStore';

export function resolveDashboardWarmupConfig(definitionId, context = {}, overrides = {}) {
  const definition = getDashboardResourceDefinition(definitionId);
  if (definition.warmup?.eligible !== true || definition.warmup?.providerPure !== true) {
    throw Object.assign(new Error(`Dashboard resource ${definitionId} is not safe to warm.`), {
      code: 'DASHBOARD_WARMUP_NOT_ELIGIBLE',
    });
  }
  if (
    definition.classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE
    || definition.accountScoped === true
  ) {
    throw Object.assign(new Error(`Dashboard resource ${definitionId} contains executable or account-scoped data.`), {
      code: 'DASHBOARD_WARMUP_EXECUTABLE_FORBIDDEN',
    });
  }
  if (
    definition.classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED
    && (
      typeof definition.referenceProjection !== 'function'
      || typeof definition.validateReference !== 'function'
    )
  ) {
    throw Object.assign(new Error(`Dashboard resource ${definitionId} has no safe warmup projection.`), {
      code: 'DASHBOARD_WARMUP_MIXED_PROJECTION_REQUIRED',
    });
  }
  if (overrides.forceRefresh === true || overrides.startsProviderWork === true) {
    throw Object.assign(new Error(`Dashboard resource ${definitionId} cannot run forced/provider warmup work.`), {
      code: 'DASHBOARD_WARMUP_FORCED_FORBIDDEN',
    });
  }
  const config = resolveDashboardResourceDefinition(definitionId, context, {
    ...overrides,
    core: true,
    pollIntervalMs: null,
    pollWhenHidden: false,
    pollWhenDocumentHidden: false,
  });
  if (typeof config.fetcher !== 'function') {
    throw new TypeError(`Dashboard warmup resource ${definitionId} requires a fetcher.`);
  }
  return {
    ...config,
    pollIntervalMs: null,
    pollWhenHidden: false,
    pollWhenDocumentHidden: false,
  };
}

export function warmDashboardResource(definitionId, context = {}, overrides = {}) {
  const config = resolveDashboardWarmupConfig(definitionId, context, overrides);
  const key = `${config.resourceKey}::${config.scopeKey}`;
  const entry = getSessionResource(key, config);
  const snapshot = entry.getSnapshot();
  if (
    (snapshot.data || snapshot.referenceData)
    && snapshot.availability !== 'persisted-reference'
  ) {
    return Promise.resolve(snapshot.data || snapshot.referenceData);
  }
  return entry.refresh();
}

export default warmDashboardResource;
