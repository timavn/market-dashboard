import React, { useId, useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatIndex } from './monitorFormatting';
import { finite } from './monitorNumbers';
import {
  AthReferenceLabel,
  ChartEndpointLabel,
  ChartTooltip,
  GoldSettlementMarkerLabel,
  GoldSettlementTimeLabel,
  MarketClosedBandLabel,
  RightEdgeReferenceLabel,
  RiskRangeChartLabel,
  RiskRangeStructureCounterLabel,
  VixCloseLabel,
} from './RiskRangeChartAnnotations';
import { formatIntradayTimeTick } from './riskRangeChartAxes';

const INITIAL_ONE_DAY_CHART_DIMENSION = Object.freeze({ width: 540, height: 185 });

const INITIAL_MULTI_DAY_CHART_DIMENSION = Object.freeze({ width: 1080, height: 185 });

const useRiskRangeChartPlot = (model) => {
  // Hidden monitor windows keep their SVGs mounted. Paint servers must belong
  // to this chart so another window cannot shadow its texture definitions.
  const patternPrefix = useId();
  const weekendSeparatorPatternId = `${patternPrefix}-weekend-separator`;
  const closedDayPatternIds = useMemo(() => ({
    weekend: `${patternPrefix}-market-closed-weekend`,
    holiday: `${patternPrefix}-market-closed-holiday`,
  }), [patternPrefix]);
  const {
    athDateLabel,
    athReference,
    athValue,
    basisSeriesSymbol,
    chart,
    chartAvailable,
    chartLabelOffsets,
    compactMultiDay,
    contractChartAvailable,
    contractLatest,
    contractPoints,
    contractSeriesDelayed,
    contractSeriesSymbol,
    dailyAxis,
    domain,
    goldSettlementMarkers,
    goldSettlementScheduleVisible,
    intradayRiskRangeDomain,
    intradayTimeAxis,
    latest,
    marketUi,
    multiDay,
    multiDayLayout,
    multiDayPriceAxis,
    oneDayPriceAxis,
    points,
    rangeAvailable,
    selectedRange,
    selectedRiskRange,
    structureScoreAvailable,
    structureSessionScoresByDate,
    third,
    vixCloseFallbackState,
    vixClosesByDate,
  } = model;
  const chartPlot = useMemo(() => (chartAvailable ? (
    <ResponsiveContainer
      width="100%"
      height="100%"
      initialDimension={multiDay
        ? INITIAL_MULTI_DAY_CHART_DIMENSION
        : INITIAL_ONE_DAY_CHART_DIMENSION}
    >
      <LineChart data={points} margin={{ top: multiDay ? 22 : 12, right: 144, left: 2, bottom: multiDay ? 0 : 2 }}>
        <defs>
          <pattern
            id={weekendSeparatorPatternId}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
          >
            <rect className="pm-spx-weekend-pattern-base" width="6" height="6" />
            <path
              className="pm-spx-weekend-pattern-stripe"
              d="M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5"
              fill="none"
              strokeWidth="1.5"
            />
          </pattern>
          {Object.entries(closedDayPatternIds).map(([type, patternId]) => (
            <pattern
              key={patternId}
              id={patternId}
              width="7"
              height="7"
              patternUnits="userSpaceOnUse"
            >
              <rect className={`pm-spx-market-closed-pattern-base is-${type}`} width="7" height="7" />
              <path
                className={`pm-spx-market-closed-pattern-stripe is-${type}`}
                d="M-1 1 L1 -1 M0 7 L7 0 M6 8 L8 6"
                fill="none"
                strokeWidth="1.4"
              />
            </pattern>
          ))}
        </defs>
    {!multiDay && rangeAvailable && (
      <>
        <ReferenceArea x1={intradayRiskRangeDomain?.[0]} x2={intradayRiskRangeDomain?.[1]} y1={Number(selectedRiskRange.lrr)} y2={Number(selectedRiskRange.lrr) + third} fill="#fee2e2" fillOpacity={0.68} stroke="none" />
        <ReferenceArea x1={intradayRiskRangeDomain?.[0]} x2={intradayRiskRangeDomain?.[1]} y1={Number(selectedRiskRange.hrr) - third} y2={Number(selectedRiskRange.hrr)} fill="#dcfce7" fillOpacity={0.72} stroke="none" />
      </>
    )}
    {!multiDay && (chart?.sessionWindow?.closedIntervals || []).map((interval, index) => (
      <ReferenceArea
        key={`resolver-closed-${interval.startAt}-${index}`}
        x1={Date.parse(interval.startAt)}
        x2={Date.parse(interval.endAt)}
        fill="#cbd5e1"
        fillOpacity={0.45}
        stroke="none"
        ifOverflow="hidden"
        data-testid={`resolver-closed-interval-${index}`}
      />
    ))}
    {multiDay && multiDayLayout.sessions.map((session) => session.riskRange.available && (
      <React.Fragment key={`areas-${session.date}`}>
        <ReferenceArea
          x1={session.startX}
          x2={session.endX}
          y1={session.riskRange.lrr}
          y2={session.riskRange.lrr + ((session.riskRange.hrr - session.riskRange.lrr) / 3)}
          fill="#fee2e2"
          fillOpacity={0.68}
          stroke="none"
        />
        <ReferenceArea
          x1={session.startX}
          x2={session.endX}
          y1={session.riskRange.hrr - ((session.riskRange.hrr - session.riskRange.lrr) / 3)}
          y2={session.riskRange.hrr}
          fill="#dcfce7"
          fillOpacity={0.72}
          stroke="none"
        />
      </React.Fragment>
    ))}
    <CartesianGrid vertical={false} stroke="#dbe4ef" strokeDasharray="3 5" />
    {multiDay ? (
      <XAxis
        type="number"
        dataKey="plotX"
        domain={[0, multiDayLayout.maxX]}
        ticks={multiDayLayout.sessions.map((session) => session.tickX)}
        axisLine={false}
        tickLine={false}
        tick={false}
        height={1}
        allowDataOverflow
      />
    ) : dailyAxis ? (
      <XAxis
        dataKey="timestamp"
        axisLine={false}
        tickLine={false}
        minTickGap={54}
        tick={{ fill: '#64748b', fontSize: 10 }}
        tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
      />
    ) : (
      <XAxis
        type="number"
        scale="time"
        dataKey="timestamp"
        domain={intradayTimeAxis.domain}
        ticks={intradayTimeAxis.ticks}
        interval={0}
        axisLine={false}
        tickLine={false}
        minTickGap={54}
        tick={{ fill: '#64748b', fontSize: 10 }}
        tickFormatter={(value) => {
          const time = formatIntradayTimeTick(value, intradayTimeAxis.step, intradayTimeAxis);
          if (intradayTimeAxis.clock24) {
            return Number(value) === intradayTimeAxis.domain[1] ? `${time} ET` : time;
          }
          if (!intradayTimeAxis.hasSessionEndpoints) return time;
          if (Number(value) === intradayTimeAxis.domain[0]) return `OPEN ${time}`;
          if (Number(value) === intradayTimeAxis.domain[1]) return `CLOSE ${time}`;
          return time;
        }}
        allowDataOverflow
      />
    )}
    <YAxis
      domain={domain}
      ticks={multiDay ? multiDayPriceAxis.ticks : oneDayPriceAxis?.ticks}
      interval={multiDay || oneDayPriceAxis ? 0 : undefined}
      width={58}
      axisLine={false}
      tickLine={false}
      tick={{ fill: '#64748b', fontSize: 10 }}
      tickFormatter={(value) => Number(value).toLocaleString('en-US', {
        maximumFractionDigits: marketUi.precision ?? 2,
      })}
    />
    <Tooltip content={<ChartTooltip
      multiDay={multiDay}
      dailyRanges={chart?.dailyRanges || []}
      ath={chart?.ath}
      basisSymbol={basisSeriesSymbol}
      contractSymbol={contractSeriesSymbol}
      contractPoints={contractPoints}
    />} />
    {!multiDay && rangeAvailable && (
      <>
        <ReferenceLine
          {...(intradayRiskRangeDomain ? { segment: intradayRiskRangeDomain.map((x) => ({ x, y: Number(selectedRiskRange.lrr) })) } : { y: Number(selectedRiskRange.lrr) })}
          stroke="#dc2626"
          strokeDasharray="6 6"
          label={(props) => (
            <RightEdgeReferenceLabel
              viewBox={props.viewBox}
              value={`LRR ${formatIndex(selectedRiskRange.lrr, marketUi.precision ?? 2)}`}
              color="#dc2626"
              verticalOffset={chartLabelOffsets.lrr}
              testId={`spx-${selectedRange}-lrr-reference`}
            />
          )}
        />
        <ReferenceLine
          {...(intradayRiskRangeDomain ? { segment: intradayRiskRangeDomain.map((x) => ({ x, y: Number(selectedRiskRange.hrr) })) } : { y: Number(selectedRiskRange.hrr) })}
          stroke="#059669"
          strokeDasharray="6 6"
          label={(props) => (
            <RightEdgeReferenceLabel
              viewBox={props.viewBox}
              value={`HRR ${formatIndex(selectedRiskRange.hrr, marketUi.precision ?? 2)}`}
              color="#059669"
              verticalOffset={chartLabelOffsets.hrr}
              testId={`spx-${selectedRange}-hrr-reference`}
            />
          )}
        />
      </>
    )}
    {multiDay && multiDayLayout.gaps.map((gap) => (
      gap.calendarAware ? (
        <React.Fragment key={`gap-${gap.previousDate}-${gap.date}`}>
          {gap.closedDays.map((closure) => {
            const accessibleLabel = closure.type === 'holiday'
              ? `${closure.date}: market closed holiday — ${closure.holidayName}`
              : `${closure.date}: market closed weekend`;
            return (
              <ReferenceArea
                key={`closed-${closure.date}`}
                className={`pm-spx-market-closed-band is-${closure.type}`}
                x1={closure.bandStartX}
                x2={closure.bandEndX}
                fill={`url(#${closedDayPatternIds[closure.type]})`}
                fillOpacity={1}
                stroke="none"
                data-testid={`spx-${selectedRange}-market-closed-${closure.date}`}
                data-closure-date={closure.date}
                data-closure-type={closure.type}
                data-holiday-name={closure.holidayName || undefined}
                aria-label={accessibleLabel}
                label={(props) => (
                  <MarketClosedBandLabel
                    viewBox={props.viewBox}
                    closure={closure}
                    testId={`spx-${selectedRange}-market-closed-label-${closure.date}`}
                  />
                )}
              />
            );
          })}
          {gap.segments.filter((segment) => segment.type === 'neutral').map((segment, segmentIndex) => (
            <ReferenceLine
              key={`neutral-${gap.previousDate}-${gap.date}-${segment.date || segmentIndex}`}
              x={segment.x}
              stroke="#94a3b8"
              strokeWidth={1}
            />
          ))}
        </React.Fragment>
      ) : gap.isWeekend ? (
        <ReferenceArea
          key={`gap-${gap.date}`}
          className="pm-spx-weekend-separator"
          x1={gap.separatorStartX}
          x2={gap.separatorEndX}
          fill={`url(#${weekendSeparatorPatternId})`}
          fillOpacity={1}
          stroke="none"
          data-testid={`spx-${selectedRange}-weekend-separator-${gap.date}`}
          data-previous-session={gap.previousDate}
          aria-label={`Weekend between ${gap.previousDate} and ${gap.date}`}
        />
      ) : (
        <ReferenceLine key={`gap-${gap.date}`} x={gap.x} stroke="#94a3b8" strokeWidth={1} />
      )
    ))}
    {multiDay && multiDayLayout.sessions.map((session) => session.riskRange.available && (
      <React.Fragment key={`ranges-${session.date}`}>
        <ReferenceLine
          segment={[{ x: session.startX, y: session.riskRange.lrr }, { x: session.endX, y: session.riskRange.lrr }]}
          stroke="#dc2626"
          strokeDasharray="6 5"
        />
        <ReferenceLine
          segment={[{ x: session.startX, y: session.riskRange.hrr }, { x: session.endX, y: session.riskRange.hrr }]}
          stroke="#059669"
          strokeDasharray="6 5"
        />
      </React.Fragment>
    ))}
    {athReference.value != null && (
      multiDay ? multiDayLayout.sessions.map((session, index) => {
        const isLastSession = index === multiDayLayout.sessions.length - 1;
        return (
          <ReferenceLine
            key={`ath-${session.date}`}
            segment={[
              { x: session.startX, y: athReference.value },
              { x: session.endX, y: athReference.value },
            ]}
            className="pm-spx-ath-reference-line"
            stroke="#2563eb"
            strokeWidth={1.25}
            strokeDasharray="2 4"
            strokeLinecap="round"
            ifOverflow="visible"
            data-testid={isLastSession
              ? `spx-${selectedRange}-ath-line`
              : `spx-${selectedRange}-ath-line-segment-${session.date}`}
            data-ath-segment-date={session.date}
            data-clamp-edge={athReference.edge || undefined}
            label={isLastSession ? (props) => (
              <AthReferenceLabel
                viewBox={{
                  ...props.viewBox,
                  width: Number(props.viewBox.width) * (1 + (multiDayLayout.trailingGap?.width || 0)),
                }}
                value={`ATH ${formatIndex(athValue, marketUi.precision ?? 2)}${athDateLabel ? ` (${athDateLabel})` : ''}`}
                clampEdge={athReference.edge}
                verticalOffset={chartLabelOffsets.ath}
                testId={`spx-${selectedRange}-ath-reference`}
              />
            ) : undefined}
          />
        );
      }) : (
        <ReferenceLine
          y={athReference.value}
          className="pm-spx-ath-reference-line"
          stroke="#2563eb"
          strokeWidth={1.25}
          strokeDasharray="2 4"
          strokeLinecap="round"
          ifOverflow="visible"
          data-testid={`spx-${selectedRange}-ath-line`}
          data-clamp-edge={athReference.edge || undefined}
          label={(props) => (
            <AthReferenceLabel
              viewBox={props.viewBox}
              value={`ATH ${formatIndex(athValue, marketUi.precision ?? 2)}${athDateLabel ? ` (${athDateLabel})` : ''}`}
              clampEdge={athReference.edge}
              verticalOffset={chartLabelOffsets.ath}
              testId={`spx-${selectedRange}-ath-reference`}
            />
          )}
        />
      )
    )}
    {goldSettlementScheduleVisible && goldSettlementMarkers.length === 0 && (
      <ReferenceLine
        x={goldSettlementScheduleVisible.timestamp}
        className="pm-gold-settlement-time-line"
        stroke="#7c3aed"
        strokeWidth={1}
        strokeDasharray="3 4"
        ifOverflow="visible"
        data-testid="spx-1d-settlement-time-line"
        label={(props) => (
          <GoldSettlementTimeLabel
            viewBox={props.viewBox}
            settlement={goldSettlementScheduleVisible}
            testId="spx-1d-settlement-time"
          />
        )}
      />
    )}
    <Line
      type="linear"
      dataKey="value"
      stroke="#111827"
      strokeWidth={1.75}
      dot={false}
      activeDot={{ r: 3 }}
      connectNulls={false}
      isAnimationActive={false}
      data-testid={`spx-${selectedRange}-price-line`}
    />
    {contractChartAvailable && (
      <Line
        type="linear"
        data={contractPoints}
        dataKey="contractValue"
        stroke="#2563eb"
        strokeWidth={1}
        dot={false}
        activeDot={{ r: 2.5 }}
        connectNulls={false}
        isAnimationActive={false}
        data-testid={`spx-${selectedRange}-contract-line`}
      />
    )}
    {goldSettlementMarkers.map((settlement) => (
      <ReferenceDot
        key={`gold-settlement-${settlement.date}`}
        x={settlement.x}
        y={settlement.value}
        r={3.5}
        fill="#7c3aed"
        stroke="#ffffff"
        strokeWidth={1.25}
        ifOverflow="visible"
        isFront
        data-testid={`spx-${selectedRange}-settlement-dot-${settlement.date}`}
        label={(props) => (
          <GoldSettlementMarkerLabel
            viewBox={props.viewBox}
            settlement={settlement}
            compact={compactMultiDay}
            testId={`spx-${selectedRange}-settlement-${settlement.date}`}
          />
        )}
      />
    ))}
    {multiDay && marketUi.symbol === 'SPX' && multiDayLayout.sessions.map((session) => {
      const vixClose = vixClosesByDate.get(session.date);
      const state = finite(vixClose) ? 'available' : vixCloseFallbackState;
      return (
        <ReferenceDot
          key={`vix-close-${session.date}`}
          x={session.tickX}
          y={domain[1]}
          r={0}
          fill="transparent"
          stroke="none"
          ifOverflow="visible"
          isFront
          label={(props) => (
            <VixCloseLabel
              viewBox={props.viewBox}
              value={vixClose}
              date={session.date}
              state={state}
              compact={compactMultiDay}
              testId={`spx-${selectedRange}-vix-close-${session.date}`}
            />
          )}
        />
      );
    })}
    {multiDay && structureScoreAvailable && multiDayLayout.sessions.map((session) => {
      const sessionScore = structureSessionScoresByDate.get(session.date);
      if (!session.riskRange.available || !sessionScore) return null;
      return (
        <React.Fragment key={`structure-counters-${session.date}`}>
          <ReferenceDot
            x={session.tickX}
            y={session.riskRange.hrr}
            r={0}
            fill="transparent"
            stroke="none"
            isFront
            label={(props) => (
              <RiskRangeStructureCounterLabel
                viewBox={props.viewBox}
                score={sessionScore.highScore}
                leg="high"
                event={sessionScore.highEvent}
                date={session.date}
                testId={`spx-${selectedRange}-high-structure-${session.date}`}
                boundaryOffset={compactMultiDay ? 4 : 24}
              />
            )}
          />
          <ReferenceDot
            x={session.tickX}
            y={session.riskRange.lrr}
            r={0}
            fill="transparent"
            stroke="none"
            isFront
            label={(props) => (
              <RiskRangeStructureCounterLabel
                viewBox={props.viewBox}
                score={sessionScore.lowScore}
                leg="low"
                event={sessionScore.lowEvent}
                date={session.date}
                testId={`spx-${selectedRange}-low-structure-${session.date}`}
                boundaryOffset={compactMultiDay ? 4 : 24}
              />
            )}
          />
        </React.Fragment>
      );
    })}
    {multiDay && !compactMultiDay && multiDayLayout.sessions.map((session) => (
      session.riskRange.available ? (
        <React.Fragment key={`range-labels-${session.date}`}>
          <ReferenceDot
            x={session.tickX}
            y={session.riskRange.hrr}
            r={0}
            fill="transparent"
            stroke="none"
            isFront
            label={(props) => (
              <RiskRangeChartLabel
                viewBox={props.viewBox}
                value={`HRR ${formatIndex(session.riskRange.hrr, Number.isInteger(session.riskRange.hrr) ? 0 : 2)}${session.range?.structure?.status === 'available' ? ` · ${session.range.structure.highEvent}` : ''}`}
                tone="high"
                placement="above"
                testId={`spx-${selectedRange}-hrr-${session.date}`}
              />
            )}
          />
          <ReferenceDot
            x={session.tickX}
            y={session.riskRange.lrr}
            r={0}
            fill="transparent"
            stroke="none"
            isFront
            label={(props) => (
              <RiskRangeChartLabel
                viewBox={props.viewBox}
                value={`LRR ${formatIndex(session.riskRange.lrr, Number.isInteger(session.riskRange.lrr) ? 0 : 2)}${session.range?.structure?.status === 'available' ? ` · ${session.range.structure.lowEvent}` : ''}`}
                tone="low"
                placement="below"
                testId={`spx-${selectedRange}-lrr-${session.date}`}
              />
            )}
          />
        </React.Fragment>
      ) : (
        <ReferenceDot
          key={`range-unavailable-${session.date}`}
          x={session.tickX}
          y={multiDayPriceAxis.domain[1]}
          r={0}
          fill="transparent"
          stroke="none"
          isFront
          label={(props) => (
            <RiskRangeChartLabel
              viewBox={props.viewBox}
              value="RR unavailable"
              tone="unavailable"
              placement="below"
              testId={`spx-${selectedRange}-rr-unavailable-${session.date}`}
            />
          )}
        />
      )
    ))}
    {latest && (
      <ReferenceDot
        x={multiDay ? multiDayLayout.trailingGap ? multiDayLayout.maxX : latest.plotX : latest.timestamp}
        y={latest.value}
        r={0}
        fill="transparent"
        stroke="none"
        isFront
        label={(props) => (
          <ChartEndpointLabel
            viewBox={props.viewBox}
            value={`${basisSeriesSymbol} ${formatIndex(latest.value, marketUi.precision ?? 2)}`}
            fontWeight={marketUi.symbol === 'GOLD' ? 400 : 800}
            verticalOffset={chartLabelOffsets.latest}
            testId={`spx-${selectedRange}-latest-reference`}
          />
        )}
      />
    )}
    {contractChartAvailable && contractLatest && (
      <ReferenceDot
        x={multiDay ? multiDayLayout.trailingGap ? multiDayLayout.maxX : contractLatest.plotX : contractLatest.timestamp}
        y={contractLatest.value}
        r={0}
        fill="transparent"
        stroke="none"
        isFront
        label={(props) => (
          <ChartEndpointLabel
            viewBox={props.viewBox}
            value={`${contractSeriesSymbol} ${formatIndex(contractLatest.value, marketUi.precision ?? 2)}${contractSeriesDelayed ? ' · D' : ''}`}
            color="#2563eb"
            fontWeight={marketUi.symbol === 'GOLD' ? 400 : 800}
            verticalOffset={chartLabelOffsets.contract}
            testId={`spx-${selectedRange}-contract-reference`}
          />
        )}
      />
    )}
      </LineChart>
    </ResponsiveContainer>
  ) : null), [
    chartAvailable,
    closedDayPatternIds,
    weekendSeparatorPatternId,
    athDateLabel,
    athReference,
    athValue,
    basisSeriesSymbol,
    chart,
    chartLabelOffsets,
    compactMultiDay,
    contractChartAvailable,
    contractLatest,
    contractPoints,
    contractSeriesDelayed,
    contractSeriesSymbol,
    dailyAxis,
    domain,
    goldSettlementMarkers,
    goldSettlementScheduleVisible,
    intradayRiskRangeDomain,
    intradayTimeAxis,
    latest,
    marketUi,
    multiDay,
    multiDayLayout,
    multiDayPriceAxis,
    oneDayPriceAxis,
    points,
    rangeAvailable,
    selectedRange,
    selectedRiskRange,
    structureScoreAvailable,
    structureSessionScoresByDate,
    third,
    vixCloseFallbackState,
    vixClosesByDate,
  ]);
  return chartPlot;
};

export { useRiskRangeChartPlot };
