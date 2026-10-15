import React from 'react';
import DelayedDataMarker from '../DelayedDataMarker';
import { delayedMarkerMarketContext } from '../../../utils/delayedMarkerMarketContext';
import GoldCorrelationPanel from './GoldCorrelationPanel';
import { GOLD_SETTLEMENT_SOURCE } from './goldSettlementReferences';
import { formatDayChangePercent, GoldHeaderMarketStrip, SpxHeaderMarketStrip } from './HeaderMarketStrip';
import { MARKET_UI } from './marketUi';
import MomoTrackerPanel from './MomoTrackerPanel';
import { formatAsOf, formatIndex } from './monitorFormatting';
import ProxyFitPanel from './ProxyFitPanel';
import PythTrackingPanel from './PythTrackingPanel';
import { formatSessionLabel, formatSessionTime, formatShortSessionDate } from './riskRangeChartSessions';
import { formatSignedStructureScore, structureScoreAriaValue, structureScoreToneFor } from './riskRangeStructure';
import { SettlementIdentityChips } from './SettlementIdentityChips';
import { useRiskRangeChartModel } from './useRiskRangeChartModel';
import { useRiskRangeChartPlot } from './useRiskRangeChartPlot';

const ClosedChartDate = ({ closure, selectedRange, compactMultiDay }) => (
  <span
    className={`pm-spx-axis-closed-day is-${closure.type}`}
    data-testid={`spx-${selectedRange}-closed-date-${closure.date}`}
    aria-label={closure.type === 'holiday'
      ? `${closure.date}: market closed holiday — ${closure.holidayName}`
      : `${closure.date}: market closed weekend`}
    title={closure.type === 'holiday' ? closure.holidayName : undefined}
  >
    <strong>{compactMultiDay
      ? formatShortSessionDate(closure.date)
      : `${formatSessionLabel(closure.date).weekday} · ${formatSessionLabel(closure.date).date}`}</strong>
  </span>
);

const SpxRiskRangeChart = ({
  snapshot,
  nowMs,
  refreshDelayed,
  marketUi = MARKET_UI.sp500,
  onMarketChange,
  chartRange = '1d',
  onChartRangeChange,
  tradingClock = null,
  checkingHours = false,
  loading = false,
  venueSelection = null,
  spySpot = null,
  cashIndexSpot = null,
  futuresReference = null,
  momoTracker = null,
  sp500Contributors = null,
  momoTrackerSpots = {},
  momoTrackerState = 'loading',
  goldMarketReferences = [],
  goldCorrelationSnapshot = null,
  goldCorrelationState = 'idle',
  goldCorrelationReason = null,
  goldCorrelationResource = null,
  resourceRefreshing = false,
}) => {
  const { plot, shell } = useRiskRangeChartModel({
    snapshot,
    nowMs,
    refreshDelayed,
    marketUi,
    chartRange,
    tradingClock,
    checkingHours,
    loading,
    venueSelection,
    resourceRefreshing,
  });
  const {
    athDate,
    athReference,
    athValue,
    basisSeriesDelayed,
    basisSeriesSymbol,
    chart,
    chartAvailable,
    chartClockStatus,
    chartClockTiming,
    chartDisplayPhase,
    chartIsLoading,
    chartLabelCollisionCount,
    chartPlotRef,
    chartRefreshActive,
    compactMarketHeader,
    compactMultiDay,
    compactPriceTone,
    contractChartAvailable,
    contractChartPointCount,
    contractChartReference,
    contractSeriesState,
    contractSeriesSymbol,
    dayChangePercent,
    dayChangeTone,
    displayedValue,
    domain,
    expectedSessionCount,
    goldOneDayLayout,
    goldSettlementMarkers,
    headerAsOf,
    intradayTimeAxis,
    multiDay,
    multiDayLayout,
    points,
    rangeAvailable,
    referenceBadge,
    referenceBadgeDetails,
    retainedChartRefresh,
    riskRangeStructureScore,
    sectionRefreshDelayed,
    selectedRange,
    sessionState,
    sp500OneDayLayout,
    structureScoreAvailable,
    structureScoreTitle,
    structureSourceRange,
    structureSummaryLabel,
    supportsRangeSelection,
    trend,
    vixClosesByDate,
  } = shell;
  const chartPlot = useRiskRangeChartPlot(plot);
  const switchMarket = MARKET_UI[marketUi.switchMarketId];

  return (
    <section
      className="pm-spx-chart-panel"
      aria-label={loading && !snapshot
        ? `Loading ${marketUi.symbol} Risk Range chart`
        : `${marketUi.symbol} Risk Range chart`}
    >
      <div className="pm-spx-chart-header">
        {compactMarketHeader && marketUi.symbol === 'SPX' ? (
          <SpxHeaderMarketStrip
            cashSpot={cashIndexSpot}
            spySpot={spySpot}
            futuresReference={futuresReference}
            nowMs={nowMs}
          />
        ) : compactMarketHeader && marketUi.symbol === 'GOLD' ? (
          <GoldHeaderMarketStrip
            references={goldMarketReferences}
            nowMs={nowMs}
          />
        ) : (
          <>
            <span className="pm-spx-chart-symbol">{snapshot?.perpetualReference ? `${marketUi.symbol} PERP` : marketUi.symbol}</span>
            <strong className={compactMarketHeader ? `pm-spx-chart-price is-${compactPriceTone}` : undefined}>
              {formatIndex(displayedValue, marketUi.spotPrecision ?? marketUi.precision ?? 2)}
            </strong>
          </>
        )}
        {compactMarketHeader && !['SPX', 'GOLD'].includes(marketUi.symbol) ? (
          <span
            className={`pm-spx-day-change is-${dayChangeTone}`}
            aria-label={dayChangePercent == null
              ? `${marketUi.symbol} daily change unavailable`
              : `${marketUi.symbol} ${dayChangePercent > 0 ? 'up' : dayChangePercent < 0 ? 'down' : 'unchanged'} ${Math.abs(dayChangePercent).toFixed(2)} percent today`}
          >
            {formatDayChangePercent(dayChangePercent)}
          </span>
        ) : !compactMarketHeader ? (
          <>
            <span className={`pm-spx-session pm-spx-session--${sessionState}`}>{sessionState === 'open' ? 'OPEN' : 'CLOSED'}</span>
            <span className={`pm-spx-trend ${trend ? `pm-spx-trend--${trend.toLowerCase()}` : ''}`}>{trend || '—'}</span>
          </>
        ) : null}
        {!snapshot?.perpetualReference && <SettlementIdentityChips
          venueSelection={venueSelection}
          checking={loading && !venueSelection?.venue}
          nowMs={nowMs}
        />}
        {referenceBadge && !['GOLD', 'SPX'].includes(marketUi.symbol) && (
          <span
            className={`pm-spx-reference-badge pm-spx-reference-badge--${referenceBadge.endsWith('PROXY') ? 'proxy' : 'exact'}`}
            aria-label={referenceBadgeDetails}
            title={referenceBadgeDetails}
          >
            {referenceBadge}
          </span>
        )}
        {supportsRangeSelection && (
          <div className="pm-spx-chart-range-tabs" role="tablist" aria-label={`${marketUi.symbol} chart range`}>
            {['1d', '5d', '10d'].map((range) => (
              <button
                key={range}
                type="button"
                role="tab"
                aria-selected={selectedRange === range}
                className={selectedRange === range ? 'is-active' : undefined}
                onClick={() => onChartRangeChange?.(range)}
              >
                {range.toUpperCase()}
              </button>
            ))}
          </div>
        )}
        {marketUi.symbol !== 'SPX' && contractChartReference && contractSeriesState !== 'available' && (
          <span
            className={`pm-spx-contract-series-state is-${contractSeriesState}`}
            data-testid={`spx-${selectedRange}-contract-state`}
            aria-label={`${contractSeriesSymbol} contract reference ${contractSeriesState}`}
            title={contractChartReference.disclosure || contractChartReference?.spot?.reason || undefined}
          >
            {contractSeriesSymbol}
            {contractSeriesState === 'delayed' ? (
              <DelayedDataMarker
                status="delayed"
                title={contractChartReference.disclosure || `${contractSeriesSymbol} delayed contract reference`}
                updatedAt={contractChartReference?.freshness?.asOf
                  || contractChartReference?.spot?.lastVerifiedAt
                  || contractChartReference?.spot?.asOf
                  || contractChartReference?.spot?.timestamp}
                {...delayedMarkerMarketContext(contractChartReference?.spot, marketUi)}
              />
            ) : ` ${contractSeriesState === 'loading' ? '…' : '—'}`}
          </span>
        )}
        {supportsRangeSelection && marketUi.symbol !== 'SPX' && (
          <span
            className={`pm-spx-structure-score${structureScoreAvailable ? '' : ' is-unavailable'}`}
            data-testid={`spx-${selectedRange}-rr-structure-summary`}
            data-source-range={structureSourceRange}
            title={structureScoreTitle}
            aria-label={structureScoreAvailable
              ? `${structureSummaryLabel}, high ${structureScoreAriaValue(riskRangeStructureScore.highScore)}, low ${structureScoreAriaValue(riskRangeStructureScore.lowScore)}`
              : `${structureSummaryLabel} unavailable`}
          >
            <span>H</span>
            <strong className={structureScoreAvailable ? `is-${structureScoreToneFor(riskRangeStructureScore.highScore)}` : undefined}>
              {structureScoreAvailable ? formatSignedStructureScore(riskRangeStructureScore.highScore) : '—'}
            </strong>
            <i aria-hidden="true">·</i>
            <span>L</span>
            <strong className={structureScoreAvailable ? `is-${structureScoreToneFor(riskRangeStructureScore.lowScore)}` : undefined}>
              {structureScoreAvailable ? formatSignedStructureScore(riskRangeStructureScore.lowScore) : '—'}
            </strong>
          </span>
        )}
        {chart?.ath && (
          <span className="pm-spx-ath-slot">
            {chart?.ath?.status === 'loading' && <span className="pm-spx-ath-state is-loading">ATH CHECKING</span>}
            {chart?.ath?.status === 'unavailable' && <span className="pm-spx-ath-state is-unavailable">ATH UNAVAILABLE</span>}
          </span>
        )}
        {chartAvailable && chart?.sessionMode === 'last_complete' && (
          <span
            className="pm-spx-last-complete-session"
            title={chart?.sessionDate ? `Verified resolver session ${chart.sessionDate}` : undefined}
          >
            LAST COMPLETE SESSION
          </span>
        )}
        {switchMarket && typeof onMarketChange === 'function' && (
          <button
            type="button"
            className="pm-spx-chart-market-switch"
            aria-label={`Switch to ${switchMarket.fullLabel}`}
            onClick={() => onMarketChange(marketUi.switchMarketId)}
          >
            {switchMarket.label} <span aria-hidden="true">↔</span>
          </button>
        )}
        {!switchMarket && marketUi.symbol !== 'SPX' && (
          <span
            className="pm-spx-chart-time"
            data-testid={`${marketUi.symbol.toLowerCase()}-chart-as-of`}
          >
            {formatAsOf(headerAsOf, sectionRefreshDelayed)}
          </span>
        )}
        {compactMarketHeader && tradingClock && !snapshot?.perpetualReference && (
          <div
            className={`pm-spx-contract-clock pm-spx-chart-contract-clock is-${checkingHours ? 'loading' : tradingClock.state}`}
            aria-label="Selected contract trading hours"
            title={checkingHours ? 'Waiting for verified current contract hours.' : tradingClock.title}
          >
            <strong className="pm-spx-contract-clock-status">{chartClockStatus}</strong>
            {chartClockTiming && (
              <span className="pm-spx-contract-clock-timing">{chartClockTiming}</span>
            )}
          </div>
        )}
      </div>
      <div
        className={`pm-spx-chart-canvas${snapshot?.perpetualReference ? ' has-direct-perpetual' : ''}${!multiDay && !snapshot?.perpetualReference ? ' has-proxy-fit' : ''}${sp500OneDayLayout ? ' has-sp500-one-day-layout' : ''}${goldOneDayLayout ? ' has-gold-one-day-layout' : ''}`}
        data-testid="spx-chart-canvas"
        data-chart-range={selectedRange}
        data-session-mode={chart?.sessionMode || undefined}
        data-session-date={chart?.sessionDate || undefined}
        data-basis-series-symbol={basisSeriesSymbol}
        data-basis-series-status={basisSeriesDelayed ? 'delayed' : chartAvailable ? 'available' : 'unavailable'}
        data-basis-series-point-count={chartAvailable ? points.length : 0}
        data-chart-point-count={chartAvailable ? points.length : 0}
        data-chart-display-phase={chartDisplayPhase}
        data-chart-refresh-status={chartRefreshActive ? 'refreshing' : 'idle'}
        data-chart-retained-refresh={retainedChartRefresh ? 'true' : 'false'}
        data-contract-series-symbol={contractSeriesSymbol}
        data-contract-series-status={contractSeriesState}
        data-contract-series-point-count={contractChartAvailable ? contractChartPointCount : 0}
        data-gold-settlement-count={marketUi.symbol === 'GOLD' ? goldSettlementMarkers.length : undefined}
        data-gold-settlement-source={goldSettlementMarkers.length ? GOLD_SETTLEMENT_SOURCE : undefined}
        data-session-count={multiDay && chartAvailable ? multiDayLayout.sessions.length : undefined}
        data-rr-overlay-count={chartAvailable
          ? multiDay
            ? multiDayLayout.sessions.filter((session) => session.riskRange.available).length
            : rangeAvailable ? 1 : 0
          : undefined}
        data-ath-reference-value={athValue ?? undefined}
        data-ath-reference-date={athDate || undefined}
        data-ath-reference-clamp={athReference.edge || undefined}
        data-vix-close-count={multiDay && marketUi.symbol === 'SPX' ? vixClosesByDate.size : undefined}
        data-price-domain-min={chartAvailable ? domain[0] : undefined}
        data-price-domain-max={chartAvailable ? domain[1] : undefined}
        data-label-collision-count={chartLabelCollisionCount}
        data-risk-range-structure-score={structureScoreAvailable ? riskRangeStructureScore.score : undefined}
        data-risk-range-high-structure-score={structureScoreAvailable ? riskRangeStructureScore.highScore : undefined}
        data-risk-range-low-structure-score={structureScoreAvailable ? riskRangeStructureScore.lowScore : undefined}
        data-risk-range-structure-source={structureScoreAvailable ? structureSourceRange : undefined}
        data-time-tick-count={intradayTimeAxis?.ticks.length || undefined}
        data-time-tick-step-minutes={intradayTimeAxis?.step ? intradayTimeAxis.step / 60_000 : undefined}
        data-session-open-time={intradayTimeAxis?.hasSessionEndpoints
          ? new Date(intradayTimeAxis.domain[0]).toISOString()
          : undefined}
        data-session-close-time={intradayTimeAxis?.hasSessionEndpoints
          ? new Date(intradayTimeAxis.domain[1]).toISOString()
          : undefined}
      >
        {!multiDay && !snapshot?.perpetualReference && (
          marketUi.symbol === 'GOLD'
            ? <PythTrackingPanel tracking={snapshot?.resolverTracking || snapshot?.resolverReference?.resolverTracking || null} />
            : <ProxyFitPanel
                comparison={snapshot?.proxyFit || snapshot?.resolverReference?.proxyFit || null}
                contractReferenceLabel={contractChartReference?.symbol
                  || snapshot?.resolverReference?.instrument?.displaySymbol
                  || snapshot?.resolverReference?.spot?.label}
                marketUi={marketUi}
              />
        )}
        {chartAvailable ? (
          <div className={`pm-spx-chart-frame ${multiDay ? compactMultiDay ? 'is-ten-day' : 'is-five-day' : 'is-one-day'}`}>
            <div className="pm-spx-chart-plot" ref={chartPlotRef}>
              {chartPlot}
            </div>
            {multiDay && (
              <div
                className={`pm-spx-five-day-axis ${compactMultiDay ? 'is-ten-day' : ''}`}
                aria-label={`${expectedSessionCount} ${marketUi.symbol} session dates${multiDayLayout.closedDays.length ? ' and closed calendar dates' : ''}${compactMultiDay ? '' : ' and market-hour ticks'}`}
                style={{
                  gridTemplateColumns: multiDayLayout.axisGridTemplate,
                }}
              >
                {multiDayLayout.sessions.map((session, index) => (
                  <React.Fragment key={`axis-${session.date}`}>
                    {index > 0 && (multiDayLayout.gaps[index - 1].calendarAware
                      ? multiDayLayout.gaps[index - 1].segments.map((segment, segmentIndex) => (
                          segment.type === 'closed' ? (
                            <ClosedChartDate
                              key={`closed-date-${segment.date}`}
                              closure={segment.closure}
                              selectedRange={selectedRange}
                              compactMultiDay={compactMultiDay}
                            />
                          ) : (
                            <span
                              key={`axis-gap-${segment.date || segmentIndex}`}
                              className="pm-spx-axis-gap"
                              aria-hidden="true"
                            />
                          )
                        ))
                      : (
                          <span
                            className={`pm-spx-axis-gap${multiDayLayout.gaps[index - 1].isWeekend ? ' is-weekend' : ''}`}
                            aria-hidden="true"
                          />
                        ))}
                    <div
                      data-testid={`spx-${selectedRange}-session-${session.date}`}
                      aria-label={`${session.label.weekday} ${session.label.date}`}
                    >
                      {!compactMultiDay && (
                        <span className="pm-spx-five-day-time-ticks" aria-label="Actual New York session times">
                          <i className="is-first" style={{ left: '0%' }}>{formatSessionTime(session.startAt)}</i>
                          <i className="is-last" style={{ left: '100%' }}>{formatSessionTime(session.endAt)}</i>
                        </span>
                      )}
                      <strong>{compactMultiDay ? formatShortSessionDate(session.date) : `${session.label.weekday} · ${session.label.date}`}</strong>
                    </div>
                  </React.Fragment>
                ))}
                {multiDayLayout.trailingGap?.closedDays.map((closure) => (
                  <ClosedChartDate
                    key={`closed-date-${closure.date}`}
                    closure={closure}
                    selectedRange={selectedRange}
                    compactMultiDay={compactMultiDay}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div
            className={`pm-spx-inline-empty${chartIsLoading ? ' is-loading' : ''}`}
            role="status"
            aria-live="polite"
          >
            {chartIsLoading
              ? `LOADING VERIFIED ${marketUi.symbol} ${selectedRange.toUpperCase()} PRICE HISTORY…`
              : `${marketUi.symbol} ${selectedRange.toUpperCase()} DATA UNAVAILABLE`}
          </div>
        )}
        {sp500OneDayLayout && (
          <MomoTrackerPanel
            contributors={sp500Contributors}
            snapshot={momoTracker}
            spots={momoTrackerSpots}
            state={momoTrackerState}
            nowMs={nowMs}
          />
        )}
        {goldOneDayLayout && (
          <GoldCorrelationPanel
            snapshot={goldCorrelationSnapshot}
            state={goldCorrelationState}
            reason={goldCorrelationReason}
          />
        )}
      </div>
    </section>
  );
};

export { SpxRiskRangeChart };
