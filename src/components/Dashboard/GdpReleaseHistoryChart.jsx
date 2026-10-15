import React from 'react';
import { GDP_HISTORY_STAGES, gdpShortQuarter, gdpSigned, gdpThresholdGap, selectGdpPreReleaseForecasts } from '../../utils/gdpPredictionMarket';

const releaseDate = (value) => value ? new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC',
}).format(new Date(value)).replace(', ', ' ’') : '—';

export default function GdpReleaseHistoryChart({ history, forecasts, comparison, selectedKey, onSelect, nowMs, quarterEstimates = [], onForecastDetails }) {
  const width = 1200;
  const left = 46;
  const right = 10;
  const top = 57;
  const bottom = 267;
  const groups = history.groups;
  const quarterWidth = (width - left - right) / Math.max(1, groups.length + quarterEstimates.length);
  const historyRight = left + groups.length * quarterWidth;
  const slotWidth = quarterWidth / Math.max(3, ...groups.map((g) => g.slots.length));
  const barWidth = Math.min(36, slotWidth * 0.58);
  const slotX = (groupIndex, slotIndex, count) => left + (groupIndex + 0.5) * quarterWidth + (slotIndex - (count - 1) / 2) * slotWidth;
  const positions = new Map(groups.flatMap((g, i) => g.slots.flatMap((s, j) => s.reading ? [[s.reading.key, slotX(i, j, g.slots.length)]] : [])));
  const markers = new Map(history.visible.map((r) => [r.key,
    selectGdpPreReleaseForecasts(forecasts, r, nowMs).find((f) => f.sourceId === comparison && f.matchedTarget)]));
  const values = [...history.visible.flatMap((r) => [r.value, markers.get(r.key)?.value]),
    ...quarterEstimates.map((r) => r.forecast?.value)].filter(Number.isFinite);
  const maximum = Math.max(1, ...values);
  const minimum = Math.min(0, ...values);
  const step = Math.max(0.5, Math.ceil((maximum - minimum) / 5));
  const hi = Math.ceil((maximum + step * 0.35) / step) * step;
  const lo = minimum < 0 ? Math.floor((minimum - step * 0.25) / step) * step : 0;
  const y = (value) => bottom - (value - lo) / (hi - lo) * (bottom - top);
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
  return <div className="pm-gdp-chart-scroll">
    <svg className="pm-gdp-chart" viewBox={`0 0 ${width} 334`} aria-label="GDP release history by quarter and Hedgeye quarterly estimates">
      {ticks.map((tick) => <g key={tick} className="pm-gdp-chart-tick">
        <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? 'pm-gdp-zero' : 'pm-gdp-gridline'} />
        <text x={left - 8} y={y(tick) + 4} textAnchor="end">{tick.toFixed(1)}%</text>
      </g>)}
      {groups.map(({ quarter, slots, notice }, index) => {
        const midpoint = left + (index + 0.5) * quarterWidth;
        const boundary = left + index * quarterWidth;
        const first = history.first.get(quarter);
        const latest = history.latest.get(quarter);
        const revision = first && latest && first.key !== latest.key ? gdpThresholdGap(latest.value, first.value) : null;
        return <g key={quarter} className="pm-gdp-quarter-group" role="group" aria-label={`${gdpShortQuarter(quarter)} release panel`}>
          <line x1={boundary} x2={boundary} y1="10" y2={bottom + 39} className="pm-gdp-quarter-line" />
          <text x={midpoint} y="22" textAnchor="middle" className="pm-gdp-quarter-title">{gdpShortQuarter(quarter)}</text>
          {revision !== null && <text x={midpoint} y="40" textAnchor="middle">{revision === 0 ? 'Unchanged' : `Revision ${gdpSigned(revision)} pp`}</text>}
          {slots.map(({ reading, stage, scheduled, pending }, slotIndex) => {
            if (reading) return null;
            const x = slotX(index, slotIndex, slots.length);
            return <g key={stage} className="pm-gdp-release-placeholder" role="group"
              aria-label={`${gdpShortQuarter(quarter)} ${GDP_HISTORY_STAGES[stage]} reading ${pending ? 'pending' : 'unavailable'}${scheduled ? `, ${scheduled.releaseAt.slice(0, 10)}` : ''}`}>
              <text x={x} y={y(0) - 21} textAnchor="middle">—</text>
              <text x={x} y={y(0) - 8} textAnchor="middle" className="pm-gdp-stage-label">{pending ? 'Pending' : 'Unavailable'}</text>
              <text x={x} y={bottom + 18} textAnchor="middle" className="pm-gdp-month-label">{releaseDate(scheduled?.releaseAt)}</text>
              <text x={x} y={bottom + 34} textAnchor="middle" className="pm-gdp-stage-label">{GDP_HISTORY_STAGES[stage]}</text>
            </g>;
          })}
          {notice && <a href={notice.sourceUrl} target="_blank" rel="noreferrer" aria-label={notice.description}>
            <title>{notice.description}</title><text x={midpoint} y={bottom + 55} textAnchor="middle" className="pm-gdp-release-notice">{notice.label}</text>
          </a>}
        </g>;
      })}
      {history.visible.map((reading) => {
        const x = positions.get(reading.key);
        const height = Math.max(1.5, Math.abs(y(reading.value) - y(0)));
        const selected = selectedKey === reading.key;
        const forecast = markers.get(reading.key);
        const label = `${gdpShortQuarter(reading.quarter)} ${GDP_HISTORY_STAGES[reading.stage]} reading, ${reading.releasedAt.slice(0, 10)}, ${reading.value.toFixed(1)}%`;
        return <g key={reading.key} className={`pm-gdp-history-bar ${reading.latest ? (reading.value < 0 ? 'is-negative' : reading.value > 0 ? 'is-positive' : 'is-neutral') : 'is-superseded'} ${selected ? 'is-selected' : ''}`}
          role="button" tabIndex="0" aria-label={label} aria-pressed={selected}
          onClick={() => onSelect(reading.key)} onKeyDown={(event) => {
            if (['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelect(reading.key); }
          }}>
          <title>{label}{forecast ? ` · ${comparison}: ${forecast.value}% published ${forecast.publishedAt}` : ''}</title>
          <rect className="pm-gdp-bar-hit" x={x - slotWidth / 2 + 2} y={top} width={slotWidth - 4} height={bottom - top + 39} />
          <rect className="pm-gdp-bar-fill" x={x - barWidth / 2} y={Math.min(y(0), y(reading.value))} width={barWidth} height={height} />
          <text className="pm-gdp-bar-value" x={x} y={reading.value >= 0 ? y(reading.value) - 8 : y(reading.value) + 16} textAnchor="middle">{reading.value.toFixed(1)}%</text>
          {forecast && <line className="pm-gdp-estimate-mark" x1={x - barWidth * 0.32} x2={x + barWidth * 0.32} y1={y(forecast.value)} y2={y(forecast.value)} />}
          <text x={x} y={bottom + 18} textAnchor="middle" className="pm-gdp-month-label">{releaseDate(reading.releasedAt)}</text>
          <text x={x} y={bottom + 34} textAnchor="middle" className="pm-gdp-stage-label">{GDP_HISTORY_STAGES[reading.stage]}</text>
        </g>;
      })}
      {quarterEstimates.map(({ quarter, forecast }, index) => {
        const boundary = historyRight + index * quarterWidth;
        const x = boundary + quarterWidth / 2;
        const publication = forecast && releaseDate(forecast.publishedAt);
        const label = `${gdpShortQuarter(quarter)} Hedgeye estimate, ${forecast ? `${forecast.value.toFixed(2)}%, published ${forecast.publishedAt.slice(0, 10)}` : 'unavailable'}`;
        const tone = !forecast || forecast.value === 0 ? 'is-neutral' : forecast.value > 0 ? 'is-positive' : 'is-negative';
        return <g key={quarter} className={`pm-gdp-quarter-estimate ${tone}`} role={forecast ? 'button' : 'group'} tabIndex={forecast ? 0 : undefined}
          aria-label={label} onClick={forecast ? onForecastDetails : undefined} onKeyDown={(event) => {
            if (forecast && ['Enter', ' '].includes(event.key)) { event.preventDefault(); onForecastDetails?.(); }
          }}>
          <line x1={boundary} x2={boundary} y1="10" y2={bottom + 39} className="pm-gdp-quarter-line" />
          <title>{label}{forecast ? ` · ${forecast.modelType} · ${forecast.targetStage ? `${forecast.targetStage} reading target` : 'Release target unconfirmed'} · Dated reference · Open forecast details` : ''}</title>
          <text x={x} y="22" textAnchor="middle" className="pm-gdp-quarter-title">{gdpShortQuarter(quarter)}E</text>
          <text x={x} y="40" textAnchor="middle" className="pm-gdp-forecast-caption">Hedgeye estimate</text>
          {forecast ? <>
            <rect className="pm-gdp-bar-hit" x={boundary + 4} y={top} width={quarterWidth - 8} height={bottom - top + 39} />
            <rect className="pm-gdp-forecast-fill" x={x - barWidth / 2} y={Math.min(y(0), y(forecast.value))} width={barWidth} height={Math.max(1.5, Math.abs(y(forecast.value) - y(0)))} />
            <text className="pm-gdp-forecast-value" x={x} y={forecast.value >= 0 ? y(forecast.value) - 8 : y(forecast.value) + 16} textAnchor="middle">{forecast.value.toFixed(2)}%</text>
          </> : <text className="pm-gdp-chart-empty" x={x} y={(top + bottom) / 2} textAnchor="middle">—</text>}
          <text x={x} y={bottom + 18} textAnchor="middle" className="pm-gdp-month-label">{forecast ? `Published ${publication}` : 'Unavailable'}</text>
          {forecast && <text x={x} y={bottom + 34} textAnchor="middle" className="pm-gdp-stage-label">Forecast details ›</text>}
        </g>;
      })}
      <line x1={width - right} x2={width - right} y1="10" y2={bottom + 39} className="pm-gdp-quarter-line" />
      {!history.visible.length && <text className="pm-gdp-chart-empty" x={left} y={bottom + 55}>Release history unavailable</text>}
    </svg>
  </div>;
}
