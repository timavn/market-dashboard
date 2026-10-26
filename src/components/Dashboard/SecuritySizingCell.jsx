import React from 'react';
import { METRIC_DEFINITIONS } from '../../constants/metricDefinitions';

export default function SecuritySizingCell({ sizing, loading = false }) {
  return <div className="security-sizing-cell" title={sizing?.reason || METRIC_DEFINITIONS.minMax.calculation}>
    <div>{['minWeight', 'maxWeight'].map((key, index) => <span key={key}>
      <small>{index === 0 ? 'MIN' : 'MAX'}</small>
      <strong>{sizing?.[key] == null ? loading ? '…' : '—' : `${sizing[key].toFixed(2)}%`}</strong>
    </span>)}</div>
    {sizing?.asOf && <time dateTime={sizing.asOf}>{sizing.asOf}</time>}
    {!loading && !sizing?.available && <small>{sizing?.reason || 'Security identity needs verification'}</small>}
    {sizing?.riskBlocked && <small className="security-sizing-cell__blocked">Too volatile to size</small>}
  </div>;
}
