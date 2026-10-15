import React from 'react';
import { labelOffsetAttributes } from './chartLabelLayout';
import { formatIndex } from './monitorFormatting';
import { finite } from './monitorNumbers';
import { chartSessionDate, formatSessionTime, formatShortSessionDate } from './riskRangeChartSessions';
import {
  formatSignedStructureScore,
  riskRangeValues,
  structureScoreAriaValue,
  structureScoreToneFor,
} from './riskRangeStructure';

const ChartEndpointLabel = ({
  viewBox,
  value,
  color = '#111827',
  fontWeight = 800,
  verticalOffset = 0,
  testId,
}) => {
  if (!viewBox || value === '—') return null;
  return (
    <text
      x={viewBox.x + 8}
      y={viewBox.y + 3 + verticalOffset}
      fill={color}
      fontSize="10"
      fontWeight={fontWeight}
      textAnchor="start"
      data-testid={testId}
      {...labelOffsetAttributes(verticalOffset)}
      pointerEvents="none"
    >
      {value}
    </text>
  );
};

const RightEdgeReferenceLabel = ({ viewBox, value, color, verticalOffset = 0, testId }) => {
  if (!viewBox || !value) return null;
  return (
    <text
      x={Number(viewBox.x) + Number(viewBox.width) + 8}
      y={Number(viewBox.y) + 3 + verticalOffset}
      fill={color}
      fontSize="10"
      fontWeight="800"
      textAnchor="start"
      data-testid={testId}
      {...labelOffsetAttributes(verticalOffset)}
      pointerEvents="none"
    >
      {value}
    </text>
  );
};

const MarketClosedBandLabel = ({ viewBox, closure, testId }) => {
  if (!viewBox || !closure) return null;
  const visibleLabel = closure.type === 'holiday'
    ? 'MARKET CLOSED HOLIDAY'
    : 'MARKET CLOSED WEEKEND';
  const accessibleLabel = closure.type === 'holiday'
    ? `${closure.date}: market closed holiday — ${closure.holidayName}`
    : `${closure.date}: market closed weekend`;
  const x = Number(viewBox.x) + (Number(viewBox.width) / 2);
  const y = Number(viewBox.y) + (Number(viewBox.height) / 2);
  return (
    <g
      className={`pm-spx-market-closed-label is-${closure.type}`}
      data-testid={testId}
      role="img"
      aria-label={accessibleLabel}
      pointerEvents="none"
    >
      <title>{accessibleLabel}</title>
      <text
        x={x}
        y={y}
        transform={`rotate(-90 ${x} ${y})`}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {visibleLabel}
      </text>
    </g>
  );
};

const RiskRangeChartLabel = ({ viewBox, value, tone, placement, testId }) => {
  if (!viewBox || !value) return null;
  const color = tone === 'high' ? '#059669' : tone === 'low' ? '#dc2626' : '#a53844';
  const labelWidth = Math.max(58, (String(value).length * 5.8) + 14);
  const labelHeight = 16;
  const x = Number(viewBox.x) - (labelWidth / 2);
  const y = placement === 'above'
    ? Number(viewBox.y) - labelHeight - 4
    : Number(viewBox.y) + 4;
  return (
    <g
      data-testid={testId}
      data-boundary-placement={placement}
      pointerEvents="none"
    >
      <rect
        x={x}
        y={y}
        width={labelWidth}
        height={labelHeight}
        rx="2"
        fill="rgba(255, 255, 255, 0.96)"
        stroke="#cbd5e1"
        strokeWidth="0.8"
      />
      <text
        x={Number(viewBox.x)}
        y={y + 11.5}
        fill={color}
        fontSize="9"
        fontWeight="800"
        textAnchor="middle"
      >
        {value}
      </text>
    </g>
  );
};

const AthReferenceLabel = ({ viewBox, value, testId, clampEdge = null, verticalOffset = 0 }) => {
  if (!viewBox || !value) return null;
  const x = Number(viewBox.x) + Number(viewBox.width) + 8;
  const y = Number(viewBox.y) + 3 + verticalOffset;
  const rangePosition = clampEdge === 'top'
    ? ', above visible chart range'
    : clampEdge === 'bottom'
      ? ', below visible chart range'
      : '';
  return (
    <text
      x={x}
      y={y}
      fill="#2563eb"
      fontSize="10"
      fontWeight="800"
      textAnchor="start"
      data-testid={testId}
      data-clamp-edge={clampEdge || undefined}
      aria-label={`${value}${rangePosition}`}
      {...labelOffsetAttributes(verticalOffset)}
      pointerEvents="none"
    >
      {value}
    </text>
  );
};

const VixCloseLabel = ({ viewBox, value, date, state = 'unavailable', compact = false, testId }) => {
  if (!viewBox) return null;
  const available = state === 'available' && finite(value) && Number(value) > 0;
  const displayValue = available ? formatIndex(value, compact ? 1 : 2) : state === 'loading' ? '…' : '—';
  const label = `VIX ${displayValue}`;
  const labelWidth = Math.max(38, (label.length * (compact ? 4.5 : 5.2)) + 10);
  const labelHeight = 15;
  const x = Number(viewBox.x) - (labelWidth / 2);
  const y = Number(viewBox.y) + 3;
  const ariaLabel = available
    ? `${date} VIX close ${displayValue}`
    : state === 'loading'
      ? `${date} VIX close loading`
      : `${date} VIX close unavailable`;
  return (
    <g
      className={`pm-spx-vix-close-label is-${available ? 'available' : state}`}
      data-testid={testId}
      data-state={available ? 'available' : state}
      data-value={available ? Number(value) : undefined}
      aria-label={ariaLabel}
      pointerEvents="none"
    >
      <title>{ariaLabel}</title>
      <rect x={x} y={y} width={labelWidth} height={labelHeight} rx="3" strokeWidth="0.8" />
      <text
        x={Number(viewBox.x)}
        y={y + 11.2}
        fontSize={compact ? '7.5' : '8.5'}
        fontWeight="850"
        textAnchor="middle"
      >
        {label}
      </text>
    </g>
  );
};

const GoldSettlementMarkerLabel = ({ viewBox, settlement, compact = false, testId }) => {
  if (!viewBox || !settlement || !finite(settlement.value)) return null;
  const time = formatSessionTime(settlement.timestamp);
  const displayValue = formatIndex(settlement.value, 1);
  const label = compact ? `5P · ${displayValue}` : `${time} · ${displayValue}`;
  const labelWidth = Math.max(48, (label.length * (compact ? 4.4 : 5.1)) + 10);
  const labelHeight = compact ? 14 : 15;
  const x = Number(viewBox.x) - labelWidth - 5;
  const y = Number(viewBox.y) - labelHeight - 5;
  const ariaLabel = `${settlement.date} official Pyth settlement, ${displayValue} at ${time} Eastern Time`;
  return (
    <g
      className="pm-gold-settlement-label"
      data-testid={testId}
      data-date={settlement.date}
      data-value={settlement.value}
      data-observation-at={settlement.observationAt}
      data-source={settlement.source}
      aria-label={ariaLabel}
      pointerEvents="none"
    >
      <title>{ariaLabel}</title>
      <rect x={x} y={y} width={labelWidth} height={labelHeight} rx="3" strokeWidth="0.9" />
      <text
        x={x + (labelWidth / 2)}
        y={y + (compact ? 10.2 : 11.2)}
        fontSize={compact ? '7.5' : '8.5'}
        fontWeight="400"
        textAnchor="middle"
      >
        {label}
      </text>
    </g>
  );
};

const GoldSettlementTimeLabel = ({ viewBox, settlement, testId }) => {
  if (!viewBox || !settlement) return null;
  const time = formatSessionTime(settlement.timestamp);
  const label = `PYTH ${time} ET`;
  const labelWidth = Math.max(78, (label.length * 5.2) + 10);
  const x = Number(viewBox.x) - labelWidth - 5;
  const y = Number(viewBox.y) + 3;
  const ariaLabel = `Exact Gold settlement observation at ${time} Eastern Time on ${settlement.date}`;
  return (
    <g
      className="pm-gold-settlement-time-label"
      data-testid={testId}
      data-date={settlement.date}
      data-observation-at={settlement.observationAt}
      aria-label={ariaLabel}
      pointerEvents="none"
    >
      <title>{ariaLabel}</title>
      <rect x={x} y={y} width={labelWidth} height="15" rx="3" strokeWidth="0.9" />
      <text x={x + (labelWidth / 2)} y={y + 11.2} fontSize="8.5" fontWeight="400" textAnchor="middle">
        {label}
      </text>
    </g>
  );
};

const RiskRangeStructureCounterLabel = ({
  viewBox,
  score,
  leg,
  event,
  date,
  testId,
  boundaryOffset = 4,
}) => {
  if (!viewBox || !Number.isFinite(Number(score))) return null;
  const value = formatSignedStructureScore(score);
  const tone = structureScoreToneFor(score);
  const placement = leg === 'high' ? 'above' : 'below';
  const labelWidth = Math.max(24, (value.length * 6) + 10);
  const labelHeight = 15;
  const x = Number(viewBox.x) - (labelWidth / 2);
  const y = placement === 'above'
    ? Number(viewBox.y) - labelHeight - boundaryOffset
    : Number(viewBox.y) + boundaryOffset;
  const eventLabel = event === 'BASE' ? 'window baseline' : event;
  const boundaryLabel = leg === 'high' ? 'above HRR' : 'below LRR';
  const ariaLabel = `${date} ${leg} structure ${structureScoreAriaValue(score)}, ${boundaryLabel}, ${eventLabel}`;
  return (
    <g
      className={`pm-spx-structure-counter is-${tone}`}
      data-testid={testId}
      data-score={Number(score)}
      data-score-tone={tone}
      data-boundary-placement={placement}
      data-boundary-offset={boundaryOffset}
      aria-label={ariaLabel}
      pointerEvents="none"
    >
      <title>{ariaLabel}</title>
      <rect
        x={x}
        y={y}
        width={labelWidth}
        height={labelHeight}
        rx="3"
        strokeWidth="0.9"
      />
      <text
        x={Number(viewBox.x)}
        y={y + 11.2}
        fontSize="9"
        fontWeight="850"
        textAnchor="middle"
      >
        {value}
      </text>
    </g>
  );
};

const formatTooltipTimestamp = (timestamp, includeDate) => new Date(timestamp).toLocaleString('en-US', {
  timeZone: 'America/New_York',
  ...(includeDate ? { weekday: 'short', month: 'short', day: 'numeric' } : {}),
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

const ChartTooltip = ({
  active,
  payload,
  multiDay = false,
  dailyRanges = [],
  ath = null,
  basisSymbol = 'SPOT',
  contractSymbol = 'CONTRACT',
  contractPoints = [],
}) => {
  const basisPayload = (active && payload?.find((entry) => (
    entry?.dataKey === 'value' && finite(entry?.payload?.value)
  ))) || (active && payload?.find((entry) => finite(entry?.payload?.value)));
  const point = basisPayload?.payload;
  if (!point || !finite(point.value) || !Number.isFinite(Number(point.timestamp))) return null;
  const payloadContractPoint = payload?.find((entry) => (
    entry?.dataKey === 'contractValue' && finite(entry?.payload?.contractValue)
  ))?.payload;
  const contractPoint = payloadContractPoint || contractPoints.find((candidate) => (
    Number(candidate?.timestamp) === Number(point.timestamp)
  ));
  const range = multiDay
    ? dailyRanges.find((candidate) => candidate?.date === (point.sessionDate || chartSessionDate(point.timestamp)))
    : null;
  const rangeValues = riskRangeValues(range);
  const structure = range?.structure?.status === 'available' ? range.structure : null;
  const athMarker = multiDay && ath?.status === 'available'
    ? ath.markers?.find((marker) => (
      marker?.date === (point.sessionDate || chartSessionDate(point.timestamp))
      && Number(marker?.timestamp) === Number(point.timestamp)
    ))
    : null;
  return (
    <div className="pm-spx-chart-tooltip">
      <strong>{basisSymbol} {formatIndex(point.value)}</strong>
      {finite(contractPoint?.value ?? contractPoint?.contractValue) && (
        <strong className="pm-spx-chart-tooltip-contract">
          {contractSymbol} {formatIndex(contractPoint?.value ?? contractPoint?.contractValue)}
        </strong>
      )}
      <span>{formatTooltipTimestamp(Number(point.timestamp), multiDay)}</span>
      {multiDay && rangeValues.available && (
        <span className="pm-spx-chart-tooltip-range">
          LRR {formatIndex(rangeValues.lrr, Number.isInteger(rangeValues.lrr) ? 0 : 2)}{structure ? ` · ${structure.lowEvent}` : ''} · HRR {formatIndex(rangeValues.hrr, Number.isInteger(rangeValues.hrr) ? 0 : 2)}{structure ? ` · ${structure.highEvent}` : ''}
          {range?.riskRangeCarryForward === 'last_published_non_publication_session'
            ? ` · published ${formatShortSessionDate(range.riskRangePublicationDate)}`
            : ''}
        </span>
      )}
      {multiDay && !rangeValues.available && <span className="pm-spx-chart-tooltip-range is-unavailable">RR unavailable</span>}
      {athMarker && <span className="pm-spx-chart-tooltip-ath">ATH {formatIndex(athMarker.value, 0)}</span>}
    </div>
  );
};

export { AthReferenceLabel, ChartEndpointLabel, ChartTooltip, GoldSettlementMarkerLabel, GoldSettlementTimeLabel, MarketClosedBandLabel, RightEdgeReferenceLabel, RiskRangeChartLabel, RiskRangeStructureCounterLabel, VixCloseLabel };
