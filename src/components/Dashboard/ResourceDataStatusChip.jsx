import React from 'react';
import DataStatusChip from './DataStatusChip';

const displayTimestamp = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : null;
};

export const resourceStateToDataStatus = (resource = {}) => {
  const phase = resource.phase || resource.resourceState;
  const datedReference = resource.resourceClass === 'dated-reference';
  const observedAt = displayTimestamp(resource.observedAt || resource.referenceObservedAt);
  const error = resource.error?.message || null;
  if (phase === 'ready') {
    if (datedReference) {
      return {
        status: 'historical',
        label: 'AS OF',
        detail: observedAt || 'VALIDATED REFERENCE',
      };
    }
    return { status: 'live', label: 'LIVE', detail: observedAt ? `AS OF ${observedAt}` : null };
  }
  if (phase === 'refreshing-with-data') {
    if (datedReference) {
      return {
        status: 'historical',
        label: 'REFRESHING',
        detail: observedAt ? `LAST VALIDATED ${observedAt}` : 'VALIDATED REFERENCE RETAINED',
      };
    }
    return {
      status: 'live',
      label: 'REFRESHING',
      detail: observedAt ? `LAST VERIFIED ${observedAt}` : null,
    };
  }
  if (phase === 'delayed-reference') {
    return {
      status: 'delayed',
      label: 'AS OF',
      detail: observedAt || 'LAST VERIFIED REFERENCE',
      issues: error ? [error] : [],
    };
  }
  if (phase === 'first-load') {
    return { status: 'loading', label: 'LOADING', detail: null };
  }
  return {
    status: 'unavailable',
    label: 'UNAVAILABLE',
    detail: observedAt ? `LAST OBSERVED ${observedAt}` : null,
    issues: error ? [error] : [],
  };
};

const ResourceDataStatusChip = ({ resource, context = 'Data status', ...props }) => {
  const mapped = resourceStateToDataStatus(resource);
  return (
    <DataStatusChip
      {...mapped}
      {...props}
      context={context}
      indicatorOnly={props.indicatorOnly ?? true}
      title={props.title || [mapped.label, mapped.detail, resource?.error?.message]
        .filter(Boolean)
        .join(' · ')}
    />
  );
};

export default ResourceDataStatusChip;
