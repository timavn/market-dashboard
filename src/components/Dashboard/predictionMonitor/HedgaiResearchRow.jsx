import React from 'react';
import { formatResearchSourceDate } from '../../../utils/researchDateFormat';
import { CompoundFactorValue } from './factorPresentation';

const percent = value => typeof value === 'number' && Number.isFinite(value)
  ? `${(value * 100).toFixed(1)}%` : '—';
const record = metric => `${percent(metric?.battingAverage)} · ${metric?.signals ?? '—'} signals · W/L ${metric?.winLoss ?? '—'}`;

export default function HedgaiResearchRow({ reading }) {
  if (!reading || reading.mock || reading.seeded || reading.synthetic || !reading.baselineDate) return null;
  const side = reading.position === 'Buy' ? 'Long' : reading.position === 'Short' ? 'Short' : 'Wait';
  const metric = reading.metrics?.[reading.position === 'Buy' ? 'buy' : 'short'];
  const current = Boolean(reading.activeDirection);
  const lastKnown = reading.status === 'last-known';
  const qualified = reading.position === 'Buy' ? reading.bullEligible : reading.bearEligible;
  const positionSources = reading.positionSourceIds || reading.sourceIds || [];
  const source = [...(reading.sources || [])].reverse().find(item => positionSources.includes(item.id));
  const href = /^(?:https:\/\/|\/api\/research\/hedgai\/source\/)/.test(source?.sourceUrl || '') ? source.sourceUrl : null;
  const detail = [
    'Tick · HedgAI research',
    reading.mapping?.label,
    `Buy history: ${record(reading.metrics?.buy)}`,
    `Short history: ${record(reading.metrics?.short)}`,
    `Metrics: ${formatResearchSourceDate(reading.metricsDate)}`,
    reading.initiatedAt ? `Initiated ${formatResearchSourceDate(reading.initiatedAt)}` : null,
    'Historical publisher performance; independent of native contract odds.',
  ].filter(Boolean).join(' · ');
  const qualifier = side === 'Wait'
    ? reading.bullEligible && reading.bearEligible ? 'Await signal' : reading.bullEligible ? 'Await Buy' : reading.bearEligible ? 'Await Short' : 'Neither side qualifies'
    : !qualified ? 'Below 60%' : !current && !lastKnown ? 'Last known' : null;
  return <tr title={detail} data-research-layer="hedgai">
    <th scope="row">{href ? <a href={href} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none', fontWeight: 400 }}>TICK</a> : 'TICK'}</th>
    <td className="pm-spx-factor-value">
      <CompoundFactorValue separator=" · " values={[
        { key: 'side', value: side, tone: side === 'Long' ? 'positive' : side === 'Short' ? 'negative' : 'neutral' },
        ...(side === 'Wait' ? [] : [{ key: 'record', value: percent(metric?.battingAverage), tone: 'neutral' }]),
        ...(qualifier ? [{ key: 'eligibility', value: qualifier, tone: 'neutral' }] : []),
        ...(lastKnown ? [{ key: 'continuity', value: 'Last known', tone: 'neutral' }] : []),
      ]} />
    </td>
    <td className="pm-spx-factor-placeholder">—</td>
    <td className="pm-spx-factor-placeholder">—</td>
    <td>{formatResearchSourceDate(reading.lastConfirmedAt || reading.publicationDate || reading.baselineDate)}</td>
  </tr>;
}
