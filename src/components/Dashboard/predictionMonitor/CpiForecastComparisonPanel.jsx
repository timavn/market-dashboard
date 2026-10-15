import React from 'react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { finite } from './monitorNumbers';
import { normalizeCpiChartValue, formatCpiPercent, formatCpiMonth, resolveCpiBlsActualAvailability } from './cpiForecastValues';
import { buildCpiCalendarAxis, buildCpiDailyChartRows, formatCpiReleaseAt } from './cpiForecastContext';
import { buildContractTradingClock } from './contractTradingClock';
import { buildSettlementIdentityViewModel } from './settlementIdentity';
import { labelOffsetAttributes, resolveChartLabelOffsets } from './chartLabelLayout';
import { CpiForecastTooltip } from './CpiForecastDetails';
import CpiForecastBoard from './CpiForecastBoard';
import CpiReleaseSetup from './CpiReleaseSetup';
import './CpiForecastComparisonPanel.css';

const CpiChartRailLabel = ({
  viewBox,
  value,
  color,
  verticalOffset = 0,
  testId,
}) => {
  if (!viewBox || !value) return null;
  const lineEndX = Number(viewBox.x) + Number(viewBox.width);
  const lineY = Number(viewBox.y);
  const labelX = lineEndX + 18;
  const labelY = lineY + 3 + verticalOffset;
  return (
    <g
      data-testid={testId}
      {...labelOffsetAttributes(verticalOffset)}
      pointerEvents="none"
    >
      <text
        x={labelX}
        y={labelY}
        fill={color}
        fontSize="9"
        fontWeight="400"
        textAnchor="start"
      >
        {value}
      </text>
    </g>
  );
};

const CpiForecastComparisonPanel = ({
  snapshot,
  nowMs,
  loading = false,
  refreshDelayed = false,
  resourceRefreshing = false,
  venueSelection = null,
  benchmarkData = null,
}) => {
  const comparison = snapshot?.forecastComparison || null;
  const reportMonth = comparison?.reportMonth || null;
  const event = venueSelection?.contracts?.event
    || venueSelection?.venue?.book?.event
    || venueSelection?.venue?.catalog?.event
    || snapshot?.contracts?.event
    || null;
  const releaseAtMs = Date.parse(comparison?.releaseAt || '');
  const releaseCurrent = Number.isFinite(releaseAtMs) && releaseAtMs > nowMs;
  const contractClock = buildContractTradingClock({ event, nowMs });
  const contractClockChecking = loading && !event;
  const contractClockHeadline = contractClockChecking
    ? 'CHECKING MARKET HOURS'
    : String(contractClock.headline || '');
  const contractClockSeparator = contractClockHeadline.indexOf(' · ');
  const contractClockStatus = contractClockSeparator >= 0
    ? contractClockHeadline.slice(0, contractClockSeparator)
    : contractClockHeadline;
  const contractClockTiming = contractClockSeparator >= 0
    ? contractClockHeadline.slice(contractClockSeparator + 3)
    : null;
  const exactSource = (source) => source?.status === 'available'
    && source?.reportMonth === reportMonth
    && releaseCurrent;
  const hedgeyeAvailable = exactSource(comparison?.hedgeye);
  const clevelandAvailable = exactSource(comparison?.clevelandFed);
  const blsFinal = comparison?.bls?.latestFinal || null;
  const {
    latestPublishedActualAvailable: blsLatestActualAvailable,
    reportMonthActualAvailable: blsReportMonthActualAvailable,
  } = resolveCpiBlsActualAvailability({
    bls: comparison?.bls,
    reportMonth,
    releaseAt: comparison?.releaseAt,
    nowMs,
  });
  const blsChartValue = blsReportMonthActualAvailable
    ? normalizeCpiChartValue(blsFinal?.value)
    : null;
  const scenarios = hedgeyeAvailable
    ? (comparison.hedgeye.scenarios || [])
      .filter((scenario) => finite(scenario?.value))
      .map((scenario) => ({ ...scenario, value: normalizeCpiChartValue(scenario.value) }))
    : [];
  const clevelandPoints = clevelandAvailable
    ? (comparison.clevelandFed.points || []).map((point) => ({
        timestamp: Number(point.timestamp),
        cleveland: normalizeCpiChartValue(point.value),
      })).filter((point) => Number.isFinite(point.timestamp) && finite(point.cleveland))
        .sort((left, right) => left.timestamp - right.timestamp)
    : [];
  const latestCleveland = clevelandPoints.at(-1) || null;
  const contractSettlementAt = event?.observationTime
    || event?.closeTime
    || comparison?.releaseAt
    || null;
  const cpiCalendarAxis = buildCpiCalendarAxis(reportMonth, clevelandPoints, {
    endAt: contractSettlementAt,
  });
  const allValues = [
    ...scenarios.map((scenario) => Number(scenario.value)),
    ...clevelandPoints.map((point) => Number(point.cleveland)),
    ...(finite(blsChartValue) ? [blsChartValue] : []),
  ].filter(Number.isFinite);
  const minimum = allValues.length ? Math.min(...allValues) : 0;
  const maximum = allValues.length ? Math.max(...allValues) : 5;
  const padding = Math.max(0.15, (maximum - minimum) * 0.18);
  const yDomain = [
    Math.floor((minimum - padding) * 10) / 10,
    Math.ceil((maximum + padding) * 10) / 10,
  ];
  const scenarioByKey = new Map(scenarios.map((scenario) => [scenario.key, scenario]));
  const cpiChartLabelOffsets = resolveChartLabelOffsets([
    ...(scenarioByKey.has('upside') ? [{ id: 'upside', value: Number(scenarioByKey.get('upside').value) }] : []),
    ...(scenarioByKey.has('base') ? [{ id: 'base', value: Number(scenarioByKey.get('base').value) }] : []),
    ...(finite(blsChartValue) ? [{ id: 'bls', value: blsChartValue }] : []),
    ...(latestCleveland ? [{ id: 'cleveland', value: Number(latestCleveland.cleveland) }] : []),
    ...(scenarioByKey.has('downside') ? [{ id: 'downside', value: Number(scenarioByKey.get('downside').value) }] : []),
  ], yDomain, {
    height: 84,
    minGap: 14,
    padding: 4,
  });
  const dailyChartRows = buildCpiDailyChartRows({
    calendarAxis: cpiCalendarAxis,
    clevelandPoints,
    scenarios,
    blsActual: blsChartValue,
    tooltipAnchor: yDomain[0],
  });
  const chartRows = dailyChartRows.length ? dailyChartRows : [
    { timestamp: Math.max(0, nowMs - 7 * 24 * 60 * 60_000), cleveland: null, tooltipAnchor: yDomain[0] },
    { timestamp: Number.isFinite(releaseAtMs) ? Math.max(nowMs, releaseAtMs) : nowMs, cleveland: null, tooltipAnchor: yDomain[0] },
  ];
  const settlement = buildSettlementIdentityViewModel(venueSelection, {
    checking: loading && !snapshot,
    nowMs,
  });
  const settlementStatusLabel = settlement.status === 'verified'
    ? 'BLS VERIFIED'
    : settlement.status === 'partial'
      ? 'SETTLEMENT PARTIAL'
      : 'SETTLEMENT UNAVAILABLE';
  const waiting = loading || resourceRefreshing || comparison?.status === 'refreshing';

  return (
    <section
      className={`pm-cpi-comparison-panel is-${comparison?.status || (waiting ? 'refreshing' : 'unavailable')}`}
      aria-label={`${formatCpiMonth(reportMonth)} headline CPI year-over-year forecast comparison`}
      data-testid="cpi-forecast-comparison"
    >
      <header className="pm-cpi-comparison-header">
        <div className="pm-cpi-contract-identity">
          <span>HEADLINE CPI-U · YEAR OVER YEAR</span>
          <strong>{formatCpiMonth(reportMonth).toUpperCase()}</strong>
          <small>{comparison?.eventTicker || 'CURRENT KALSHI EVENT CHECKING'}</small>
        </div>
        <div
          className="pm-cpi-settlement-badges"
          aria-label={settlement.accessibleLabel}
          title={settlement.status === 'verified' ? settlement.settlementText : settlement.reason || undefined}
        >
          <span className={`is-${settlement.status === 'unavailable' ? 'unavailable' : 'verified'}`}>{settlement.venueText}</span>
          <span className={`is-${settlement.status === 'unavailable' ? 'unavailable' : 'verified'}`}>{settlementStatusLabel}</span>
          {(snapshot?.referenceOnly || refreshDelayed) && <span className="is-reference">DATED REFERENCE</span>}
        </div>
        <div
          className="pm-cpi-event-clock pm-cpi-release-clock"
          aria-label="BLS release time"
          data-testid="cpi-release-clock"
        >
          <span>BLS RELEASE</span>
          <strong>{formatCpiReleaseAt(comparison?.releaseAt)}</strong>
        </div>
        <div
          className={`pm-spx-contract-clock pm-spx-chart-contract-clock is-${contractClockChecking ? 'loading' : contractClock.state}`}
          aria-label="Selected contract trading hours"
          title={contractClockChecking ? 'Waiting for verified current contract hours.' : contractClock.title}
        >
          <strong className="pm-spx-contract-clock-status">{contractClockStatus}</strong>
          {contractClockTiming && (
            <span className="pm-spx-contract-clock-timing">{contractClockTiming}</span>
          )}
        </div>
      </header>

      <div
        className="pm-cpi-comparison-chart"
      >
        <CpiForecastBoard
          comparison={comparison}
          benchmarkData={benchmarkData}
          reportMonth={reportMonth}
          releaseCurrent={releaseCurrent}
        />
        {allValues.length ? (
          <div
            className="pm-cpi-comparison-chart-plot"
            role="img"
            aria-label={`Cleveland Fed CPI nowcast history with Hedgeye scenario reference lines${blsReportMonthActualAvailable ? ' and the matching report-month BLS actual' : ''}`}
            data-testid="cpi-forecast-chart-plot"
            data-label-collision-count={Object.values(cpiChartLabelOffsets)
              .filter((offset) => Math.abs(Number(offset)) > 0.01).length}
            data-calendar-start-date={cpiCalendarAxis?.startDate || undefined}
            data-calendar-end-date={cpiCalendarAxis?.endDate || undefined}
            data-calendar-day-count={cpiCalendarAxis?.dayCount || 0}
            data-settlement-date={cpiCalendarAxis?.settlementDate || undefined}
            data-source-start-date={cpiCalendarAxis?.sourceStartDate || undefined}
            data-source-end-date={cpiCalendarAxis?.sourceEndDate || undefined}
            data-source-point-count={clevelandPoints.length}
            data-weekend-day-count={cpiCalendarAxis?.weekendDays.length || 0}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartRows} margin={{ top: 12, right: 122, bottom: 2, left: 0 }}>
                {(cpiCalendarAxis?.weekendDays || []).map((weekend) => (
                  <ReferenceArea
                    key={weekend.date}
                    className="pm-cpi-weekend-band"
                    x1={weekend.startMs}
                    x2={weekend.endMs}
                    fill="var(--pm-cpi-weekend-fill)"
                    fillOpacity={0.62}
                    stroke="none"
                    ifOverflow="hidden"
                    data-testid={`cpi-weekend-${weekend.date}`}
                    data-weekend-date={weekend.date}
                    aria-label={`${weekend.date}: weekend, no Cleveland Fed publication`}
                  />
                ))}
                <CartesianGrid strokeDasharray="2 4" vertical={false} />
                <XAxis
                  type="number"
                  scale="time"
                  dataKey="timestamp"
                  domain={cpiCalendarAxis?.domain || ['dataMin', 'dataMax']}
                  ticks={cpiCalendarAxis?.ticks}
                  interval={0}
                  tickFormatter={(value) => new Date(Number(value)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                  tick={{ fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  allowDataOverflow
                />
                <YAxis
                  domain={yDomain}
                  tickFormatter={(value) => `${Number(value).toFixed(1)}%`}
                  tick={{ fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                />
                <Tooltip
                  content={<CpiForecastTooltip hedgeyeAsOf={comparison?.hedgeye?.asOf} />}
                  cursor={{ stroke: 'var(--pm-spx-border)', strokeWidth: 1 }}
                  filterNull={false}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="tooltipAnchor"
                  name="Calendar day"
                  stroke="transparent"
                  strokeOpacity={0}
                  dot={false}
                  activeDot={false}
                  legendType="none"
                  isAnimationActive={false}
                />
                {scenarios.map((scenario) => (
                  <ReferenceLine
                    key={scenario.key}
                    y={Number(scenario.value)}
                    stroke={`var(--pm-cpi-${scenario.key})`}
                    strokeDasharray="5 4"
                    strokeWidth={1}
                    data-testid={`cpi-hedgeye-${scenario.key}-reference`}
                    label={(props) => (
                      <CpiChartRailLabel
                        viewBox={props.viewBox}
                        value={`${scenario.key.toUpperCase()} ${formatCpiPercent(scenario.value)}`}
                        color={`var(--pm-cpi-${scenario.key})`}
                        verticalOffset={cpiChartLabelOffsets[scenario.key] || 0}
                        testId={`cpi-chart-label-${scenario.key}`}
                      />
                    )}
                  />
                ))}
                {finite(blsChartValue) && (
                  <ReferenceLine
                    y={blsChartValue}
                    stroke="var(--pm-cpi-bls)"
                    strokeDasharray="2 3"
                    strokeWidth={1}
                    data-testid="cpi-bls-reference"
                    label={(props) => (
                      <CpiChartRailLabel
                        viewBox={props.viewBox}
                        value={`BLS ACTUAL ${formatCpiPercent(blsChartValue)}`}
                        color="var(--pm-cpi-bls)"
                        verticalOffset={cpiChartLabelOffsets.bls || 0}
                        testId="cpi-chart-label-bls"
                      />
                    )}
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="cleveland"
                  name="Cleveland Fed"
                  stroke="var(--pm-cpi-cleveland)"
                  strokeWidth={1}
                  connectNulls
                  dot={false}
                  activeDot={false}
                  data-testid="cpi-cleveland-line"
                  isAnimationActive={false}
                />
                {latestCleveland && (
                  <ReferenceLine
                    y={latestCleveland.cleveland}
                    stroke="transparent"
                    strokeWidth={0}
                    label={(props) => (
                      <CpiChartRailLabel
                        viewBox={props.viewBox}
                        value={`CLEVELAND FED ${formatCpiPercent(latestCleveland.cleveland)}`}
                        color="var(--pm-cpi-cleveland)"
                        verticalOffset={cpiChartLabelOffsets.cleveland || 0}
                        testId="cpi-cleveland-endpoint-label"
                      />
                    )}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="pm-cpi-comparison-empty" role="status">
            <strong>{waiting ? 'CHECKING VERIFIED CPI SOURCES' : 'CPI COMPARISON UNAVAILABLE'}</strong>
            <span>{comparison?.reason || 'No exact-month forecast comparison is available.'}</span>
          </div>
        )}
        <CpiReleaseSetup
          comparison={comparison}
          benchmarkData={benchmarkData}
          reportMonth={reportMonth}
          blsLatestActualAvailable={blsLatestActualAvailable}
          blsReportMonthActualAvailable={blsReportMonthActualAvailable}
        />
      </div>
    </section>
  );
};

export default CpiForecastComparisonPanel;
