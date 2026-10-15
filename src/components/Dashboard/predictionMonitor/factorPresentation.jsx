import React from 'react';
import DelayedDataMarker from '../DelayedDataMarker';
import { getBucketForSeries } from '../../../utils/volatilityRegimes';
import { finite } from './monitorNumbers';
import { formatFactorAsOf } from './monitorFormatting';

export const formatFactorNumber = (value, precision = 2) => finite(value)
  ? Number(value).toLocaleString('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    })
  : '—';

export const formatSignedFactorNumber = (value, precision = 2) => finite(value)
  ? `${Number(value) > 0 ? '+' : ''}${formatFactorNumber(value, precision)}`
  : '—';

export const factorToken = (value) => String(value || '').trim().replaceAll('_', ' ').toUpperCase();

export const factorDirectionTone = (value) => {
  const token = factorToken(value);
  if (['BULL', 'BULLISH', 'BUY', 'LONG', 'POSITIVE', 'RISK ON', 'INVESTABLE', 'PASS'].includes(token)) {
    return 'positive';
  }
  if (['BEAR', 'BEARISH', 'SELL', 'SHORT', 'NEGATIVE', 'RISK OFF', 'UNINVESTABLE', 'BLOCKED'].includes(token)) {
    return 'negative';
  }
  if (token === 'CHOP') return 'caution';
  return token ? 'neutral' : null;
};

export const factorSignTone = (value) => {
  if (!finite(value)) return null;
  const number = Number(value);
  return number > 0 ? 'positive' : number < 0 ? 'negative' : 'neutral';
};

export const factorCorrelationTone = (value) => {
  if (!finite(value)) return null;
  const displayed = Number(Number(value).toFixed(2));
  if (Math.abs(displayed) <= 0.5) return 'neutral';
  return displayed > 0 ? 'positive' : 'negative';
};

export const factorRelativeTone = (value, baseline = 1) => {
  if (!finite(value)) return null;
  const number = Number(value);
  return number > baseline ? 'positive' : number < baseline ? 'negative' : 'neutral';
};

export const factorVolatilityTone = (series, value) => ({
  green: 'positive',
  yellow: 'caution',
  red: 'negative',
}[getBucketForSeries(series, value)] || null);

const FactorToken = ({ value, tone, accessibleLabel }) => {
  const resolvedTone = tone ?? (value === '—' ? 'unavailable' : factorDirectionTone(value));
  return (
    <span
      className={`pm-spx-factor-token${resolvedTone ? ` is-${resolvedTone}` : ''}`}
      aria-label={accessibleLabel}
    >{value}</span>
  );
};

export const CompoundFactorValue = ({ values, separator }) => (
  <span className="pm-spx-factor-compound">
    {values.map(({ key, value, tone, accessibleLabel }, index) => (
      <React.Fragment key={key}>
        {index > 0 ? <span className="pm-spx-factor-separator">{separator}</span> : null}
        <FactorToken value={value} tone={tone} accessibleLabel={accessibleLabel} />
      </React.Fragment>
    ))}
  </span>
);

export const genericFactorValuePresentation = (row, displayValue) => {
  const id = factorToken(row?.id);
  const label = factorToken(row?.label);
  if (Array.isArray(row?.metrics)) {
    return {
      value: (
        <CompoundFactorValue
          separator=" / "
          values={row.metrics.map((metric, index) => {
            const value = finite(metric.value)
              ? `${formatSignedFactorNumber(metric.value)}${metric.format === 'percent' ? '%' : ''}`
              : '—';
            return {
              key: metric.label || index,
              value,
              accessibleLabel: `${metric.label}: ${value === '—' ? 'unavailable' : value}`,
              tone: value === '—' ? 'unavailable' : metric.format === 'correlation'
                ? factorCorrelationTone(metric.value) : factorSignTone(metric.value),
            };
          })}
        />
      ),
      tone: null,
    };
  }
  if (id === 'GATE') {
    const directions = String(displayValue || '— / —').split('/').map((value) => factorToken(value) || '—');
    return {
      value: (
        <CompoundFactorValue
          separator=" / "
          values={directions.map((value, index) => ({
            key: `direction-${index}`,
            value,
            tone: value === '—' ? 'unavailable' : factorDirectionTone(value),
          }))}
        />
      ),
      tone: null,
    };
  }
  if (id === 'CFTC') {
    const zScores = String(displayValue || '— / —').split('/').map((value) => String(value || '').trim() || '—');
    return {
      value: (
        <CompoundFactorValue
          separator=" / "
          values={zScores.map((value, index) => ({
            key: `z-score-${index}`,
            value,
            tone: value === '—' ? 'unavailable' : factorSignTone(value),
          }))}
        />
      ),
      tone: null,
    };
  }
  if (id === 'USD' || label.includes('CORRELATION')) {
    return { value: displayValue, tone: factorCorrelationTone(row?.value) };
  }
  if (['VIX', 'VVIX', 'NAZVOL', 'RVX', 'GVZ', 'OVX', 'MOVE', 'BITVX'].includes(id)) {
    return { value: displayValue, tone: factorVolatilityTone(id, row?.value) };
  }
  const directionalTone = factorDirectionTone(row?.value ?? displayValue);
  return {
    value: displayValue,
    tone: ['positive', 'negative', 'caution'].includes(directionalTone) ? directionalTone : null,
  };
};

export const FactorRow = ({
  label,
  value,
  valueTone,
  source,
  detail,
  valueDetail,
  asOf,
  available,
  partial = false,
  refreshDelayed,
  referenceStatus = 'live',
  unavailableValue = '—',
  unavailableAsOf = null,
}) => {
  const availability = available ? (partial ? 'partial' : 'available') : 'unavailable';
  const title = [source, detail].filter(Boolean).join(' · ') || undefined;
  return (
    <tr
      className={!available ? 'is-unavailable' : partial ? 'is-partial' : undefined}
      data-availability={availability}
      title={title}
    >
      <th scope="row">{label}</th>
      <td
        className={`pm-spx-factor-value${valueTone ? ` is-${valueTone}` : ''}`}
        data-tone={valueTone || undefined}
      >
        {available ? (
          <>
            {value}
            <DelayedDataMarker
              status={refreshDelayed ? 'refresh-delayed' : referenceStatus}
              title={refreshDelayed
                ? `Refresh delayed · last verified ${asOf || 'time unavailable'}`
                : `Historical reference · as of ${asOf || 'time unavailable'}`}
              updatedAt={asOf}
            />
            {valueDetail ? <span className="pm-spx-factor-value-detail">{valueDetail}</span> : null}
          </>
        ) : unavailableValue}
      </td>
      <td className="pm-spx-factor-placeholder">—</td>
      <td className="pm-spx-factor-placeholder">—</td>
      <td>{formatFactorAsOf(available ? asOf : unavailableAsOf)}</td>
    </tr>
  );
};
