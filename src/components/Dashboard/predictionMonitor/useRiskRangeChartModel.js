import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { resolveChartLabelOffsets } from './chartLabelLayout';
import { resolveVerifiedGoldSettlements, resolveVerifiedGoldSettlementTime } from './goldSettlementReferences';
import { resolveDayChangePercent } from './headerMarketReferences';
import { finite } from './monitorNumbers';
import { isSpxMonitorSectionUsable } from './monitorSectionValidation';
import { formatAthSessionDate } from './proxyFitPresentation';
import {
  buildIntradayTimeAxis,
  buildSpxPriceAxis,
  clampChartReferenceValue,
  expandSpxPriceAxis,
  resolveAthReferenceDate,
  resolveAthReferenceValue,
  resolveVerifiedVixCloses,
} from './riskRangeChartAxes';
import {
  buildMultiDayChartLayout,
  CHART_PLOT_HORIZONTAL_INSET_PX,
  chartSessionDate,
  projectOverlayPointsToSessions,
  sessionProgress,
  SPX_CLOSED_DAY_WIDTH_PX,
} from './riskRangeChartSessions';
import {
  calculateRiskRangeStructureScore,
  formatSignedStructureScore,
  isVerifiedRiskRangeStructureChart,
  riskRangeValues,
  unavailableRiskRangeStructureScore,
} from './riskRangeStructure';

const selectChartRange = (rootChart, selectedRange, enforceRange) => {
  const chart = rootChart?.variants?.[selectedRange] || (selectedRange === '1d' ? rootChart : null);
  if (!chart || !enforceRange) return chart;
  if (chart.range && chart.range !== selectedRange) return null;
  if (selectedRange !== '1d') return chart;

  // A missing intraday variant must not turn a multi-day root into a 1D chart.
  // Overnight futures and continuous markets may cross midnight, but still
  // belong to a single session and cannot span more than one day.
  const sessionDates = new Set([
    ...(Array.isArray(chart.rangeDates) ? chart.rangeDates : []),
    ...(Array.isArray(chart.dailyRanges) ? chart.dailyRanges : []).map((range) => range.date),
  ].filter(Boolean));
  const timestamps = (Array.isArray(chart.points) ? chart.points : [])
    .map((point) => Number(point.timestamp)).filter(Number.isFinite);
  return sessionDates.size > 1
    || (timestamps.length > 1 && Math.max(...timestamps) - Math.min(...timestamps) > 24 * 60 * 60_000)
    ? null : chart;
};

const useRiskRangeChartModel = ({
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
}) => {
  const chartPlotRef = useRef(null);
  const [chartPlotWidth, setChartPlotWidth] = useState(null);
  const rootChart = snapshot?.chart;
  const basisChartReference = snapshot?.chartReferences?.basis || null;
  const contractChartReference = snapshot?.perpetualReference
    ? null : snapshot?.chartReferences?.contract || null;
  const supportsRangeSelection = ['SPX', 'WTI', 'GOLD', 'SILVER', 'BRENT', 'BTC', 'ETH'].includes(marketUi.symbol);
  const selectedRange = supportsRangeSelection && ['1d', '5d', '10d'].includes(chartRange) ? chartRange : '1d';
  const chart = useMemo(() => selectChartRange(rootChart, selectedRange, supportsRangeSelection),
    [rootChart, selectedRange, supportsRangeSelection]);
  const contractRootChart = contractChartReference?.chart || null;
  const contractChart = useMemo(() => selectChartRange(contractRootChart, selectedRange, supportsRangeSelection),
    [contractRootChart, selectedRange, supportsRangeSelection]);
  const riskRange = snapshot?.riskRange;
  const spot = snapshot?.spot;
  const multiDay = selectedRange !== '1d';
  const sp500OneDayLayout = marketUi.symbol === 'SPX' && !multiDay;
  const goldOneDayLayout = marketUi.symbol === 'GOLD' && !multiDay;
  const compactMultiDay = selectedRange === '10d';
  const expectedSessionCount = selectedRange === '10d' ? 10 : selectedRange === '5d' ? 5 : 1;
  const rawPoints = useMemo(() => (Array.isArray(chart?.points) ? chart.points
    .map((point) => ({
      timestamp: Number(point.timestamp),
      value: Number(point.value),
      ...(point.sessionDate ? { sessionDate: point.sessionDate } : {}),
      ...(finite(point.high) ? { high: Number(point.high) } : {}),
    }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value)) : []), [chart]);
  const rawContractPoints = useMemo(() => (Array.isArray(contractChart?.points) ? contractChart.points
    .map((point) => ({
      timestamp: Number(point.timestamp),
      value: Number(point.value),
      ...(point.sessionDate ? { sessionDate: point.sessionDate } : {}),
    }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value)) : []), [contractChart]);
  const calendarThroughDate = marketUi.symbol === 'SPX' ? chartSessionDate(nowMs) : null;
  const multiDayLayout = useMemo(() => (multiDay
    ? buildMultiDayChartLayout(
        rawPoints,
        chart?.dailyRanges,
        expectedSessionCount,
        chartPlotWidth,
        marketUi.chartCalendar ? {
          calendar: marketUi.chartCalendar,
          throughDate: calendarThroughDate,
          closedDayWidthPx: SPX_CLOSED_DAY_WIDTH_PX[expectedSessionCount],
        } : {},
      )
    : null), [calendarThroughDate, chart, chartPlotWidth, expectedSessionCount, marketUi, multiDay, rawPoints]);
  const chartAvailable = isSpxMonitorSectionUsable(chart, nowMs)
    && rawPoints.length >= 2
    && (!multiDay || multiDayLayout.sessions.length === expectedSessionCount);
  useLayoutEffect(() => {
    const plot = chartPlotRef.current;
    if (!chartAvailable || !plot) return undefined;
    const updateWidth = () => {
      const width = plot.getBoundingClientRect().width - CHART_PLOT_HORIZONTAL_INSET_PX;
      if (!(width > 0)) return;
      setChartPlotWidth((current) => (Math.abs(Number(current) - width) < 0.5 ? current : width));
    };
    updateWidth();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(updateWidth);
      observer.observe(plot);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, [chartAvailable, multiDay]);
  const contractChartUsable = isSpxMonitorSectionUsable(contractChart, nowMs)
    && contractChart?.offline !== true && contractChart?.disconnected !== true
    && !/mock|seed|cache|stale|offline|disconnected|synthetic|inferred|fallback/i.test(String(contractChart?.source || ''))
    && rawContractPoints.length >= 2;
  const chartTerminal = chart?.refreshFailed === true
    || (
      ['unavailable', 'refresh_failed'].includes(String(chart?.status || '').toLowerCase())
      && chart?.refreshing !== true
      && (Boolean(chart?.errorCode) || Boolean(String(chart?.reason || '').trim()))
    );
  const chartIsLoading = !chartAvailable && !chartTerminal && (
    chart?.status === 'refreshing'
    || chart?.refreshing === true
    || chart?.refreshPending === true
    || (loading && !snapshot)
  );
  const chartRefreshActive = Boolean(
    resourceRefreshing
      || snapshot?.refresh?.state === 'refreshing'
      || chart?.refreshing === true
      || chart?.refreshPending === true,
  );
  const retainedChartRefresh = Boolean(chartAvailable && chart?.refreshRetained === true);
  const chartDisplayPhase = !chartAvailable
    ? chartIsLoading ? 'first-load' : 'unavailable'
    : snapshot?.referenceOnly
      ? 'dated-reference'
      : chart?.displayDelayed === true
        ? 'dated-reference'
      : chartRefreshActive
        ? retainedChartRefresh ? 'retained-refresh' : 'refreshing-with-chart'
        : 'ready';
  const latestDailyRange = useMemo(() => (!multiDay && Array.isArray(chart?.dailyRanges) && chart.dailyRanges.length
    ? chart.dailyRanges[chart.dailyRanges.length - 1]
    : null), [chart, multiDay]);
  const variantRange = useMemo(() => (latestDailyRange
    ? riskRangeValues(latestDailyRange)
    : !multiDay && Array.isArray(chart?.references) && chart.references.length
      ? riskRangeValues({ status: 'available', references: chart.references })
      : null), [chart, latestDailyRange, multiDay]);
  const snapshotRangeAvailable = isSpxMonitorSectionUsable(riskRange, nowMs)
    && finite(riskRange?.lrr) && finite(riskRange?.hrr);
  const latestChartDate = String(
    latestDailyRange?.date
      || chart?.rangeDates?.[chart.rangeDates.length - 1]
      || rawPoints[rawPoints.length - 1]?.sessionDate
      || chartSessionDate(rawPoints[rawPoints.length - 1]?.timestamp)
      || '',
  );
  const snapshotRangeDate = String(riskRange?.date || '').slice(0, 10);
  const snapshotRangeMatchesChart = snapshotRangeAvailable
    && /^\d{4}-\d{2}-\d{2}$/.test(latestChartDate)
    && snapshotRangeDate === latestChartDate;
  const selectedRiskRange = useMemo(() => (variantRange?.available
    ? { lrr: variantRange.lrr, hrr: variantRange.hrr }
    : snapshotRangeMatchesChart
      ? riskRange
      : null), [riskRange, snapshotRangeMatchesChart, variantRange]);
  const rangeAvailable = finite(selectedRiskRange?.lrr) && finite(selectedRiskRange?.hrr);
  const spotAvailable = isSpxMonitorSectionUsable(spot, nowMs) && finite(spot?.value);
  const points = useMemo(() => (
    chartAvailable ? (multiDay ? multiDayLayout.points : rawPoints) : []
  ), [chartAvailable, multiDay, multiDayLayout, rawPoints]);
  const latest = multiDay ? multiDayLayout?.latestPoint : points[points.length - 1] || null;
  const visibleGoldSettlementDates = useMemo(() => (chartAvailable && marketUi.symbol === 'GOLD'
    ? multiDay
      ? multiDayLayout.sessions.map((session) => session.date)
      : [latestChartDate]
    : []), [chartAvailable, latestChartDate, marketUi, multiDay, multiDayLayout]);
  const exactGoldSettlements = useMemo(() => (resolveVerifiedGoldSettlements(
    snapshot?.resolverTracking || snapshot?.resolverReference?.resolverTracking || null,
    visibleGoldSettlementDates,
  )), [snapshot, visibleGoldSettlementDates]);
  const goldSettlementMarkers = useMemo(() => (exactGoldSettlements.flatMap((settlement) => {
    if (!multiDay) return [{ ...settlement, x: settlement.timestamp }];
    const session = multiDayLayout.sessions.find((candidate) => candidate.date === settlement.date);
    if (!session) return [];
    const progress = sessionProgress(settlement.timestamp, session.startAt, session.endAt);
    return progress == null ? [] : [{
      ...settlement,
      x: Number(session.startX) + progress,
    }];
  })), [exactGoldSettlements, multiDay, multiDayLayout]);
  const basisWindowStart = points.find((point) => Number.isFinite(Number(point?.timestamp)))?.timestamp;
  const basisWindowEnd = useMemo(() => ([...points].reverse().find((point) => Number.isFinite(Number(point?.timestamp)))?.timestamp), [points]);
  const resolverSessionOpenTime = Date.parse(String(chart?.sessionWindow?.startAt || ''));
  const resolverSessionCloseTime = Date.parse(String(chart?.sessionWindow?.endAt || ''));
  const fallbackSessionOpenTime = Date.parse(String(snapshot?.session?.openTime || ''));
  const fallbackSessionCloseTime = Date.parse(String(snapshot?.session?.closeTime || ''));
  const sessionDomain = useMemo(() => ((sp500OneDayLayout ? [
    [fallbackSessionOpenTime, fallbackSessionCloseTime],
    [resolverSessionOpenTime, resolverSessionCloseTime],
  ] : [
    [resolverSessionOpenTime, resolverSessionCloseTime],
    [fallbackSessionOpenTime, fallbackSessionCloseTime],
  ]).find(([start, end]) => Number.isFinite(start) && Number.isFinite(end)
    && start < end && end - start <= 24 * 60 * 60_000
    && start <= basisWindowStart && end >= basisWindowEnd) || null),
  [basisWindowEnd, basisWindowStart, fallbackSessionCloseTime, fallbackSessionOpenTime, resolverSessionCloseTime, resolverSessionOpenTime, sp500OneDayLayout]);
  const contractObservedAt = Date.parse(contractChart?.latestAt || contractChart?.asOf || '');
  const contractWindowStart = sp500OneDayLayout ? sessionDomain?.[0] ?? basisWindowStart : basisWindowStart;
  const contractWindowEnd = sp500OneDayLayout
    ? Math.min(sessionDomain?.[1] ?? basisWindowEnd, nowMs, Number.isFinite(contractObservedAt) ? contractObservedAt : basisWindowEnd)
    : basisWindowEnd;
  const cashSessionDate = sp500OneDayLayout ? chartSessionDate(basisWindowEnd) : null;
  const contractPoints = useMemo(() => (chartAvailable && contractChartUsable
    ? multiDay
      ? projectOverlayPointsToSessions(rawContractPoints, multiDayLayout.sessions)
      : rawContractPoints
        .filter((point) => point.timestamp >= contractWindowStart && point.timestamp <= contractWindowEnd
          && (!cashSessionDate || !point.sessionDate || point.sessionDate === cashSessionDate))
        .map((point) => ({ ...point, contractValue: point.value }))
    : []), [cashSessionDate, chartAvailable, contractChartUsable, contractWindowEnd, contractWindowStart, multiDay, multiDayLayout, rawContractPoints]);
  const contractChartPointCount = contractPoints.filter((point) => finite(point?.contractValue)).length;
  const contractChartAvailable = contractChartPointCount >= 2;
  const intradayRiskRangeDomain = null;
  const contractLatest = useMemo(() => (contractChartAvailable
    ? [...contractPoints].reverse().find((point) => finite(point?.contractValue)) || null
    : null), [contractChartAvailable, contractPoints]);
  const structureSourceRange = multiDay ? selectedRange : '10d';
  const structureSourceChart = multiDay ? chart : rootChart?.variants?.['10d'];
  const structureExpectedSessionCount = multiDay ? expectedSessionCount : 10;
  const structureSourceVerified = supportsRangeSelection
    && isVerifiedRiskRangeStructureChart(structureSourceChart, nowMs)
    && (!multiDay || chartAvailable);
  const riskRangeStructureScore = useMemo(() => (structureSourceVerified
    ? calculateRiskRangeStructureScore(
      structureSourceChart?.dailyRanges,
      structureExpectedSessionCount,
    )
    : unavailableRiskRangeStructureScore(
      `Verified ${structureSourceRange.toUpperCase()} Risk Range structure is unavailable.`,
      Array.isArray(structureSourceChart?.dailyRanges) ? structureSourceChart.dailyRanges.length : 0,
    )), [structureExpectedSessionCount, structureSourceChart, structureSourceRange, structureSourceVerified]);
  const structureScoreAvailable = riskRangeStructureScore.status === 'available';
  const structureSessionScoresByDate = useMemo(() => (new Map(
    riskRangeStructureScore.sessions.map((session) => [session.date, session]),
  )), [riskRangeStructureScore]);
  const structureSummaryLabel = multiDay
    ? `${selectedRange.toUpperCase()} consecutive Risk Range trends`
    : '1D summary from the ending 10D consecutive Risk Range trends';
  const structureScoreTitle = structureScoreAvailable
    ? [
      structureSummaryLabel,
      `high ${formatSignedStructureScore(riskRangeStructureScore.highScore)}`,
      `low ${formatSignedStructureScore(riskRangeStructureScore.lowScore)}`,
      `HH events ${riskRangeStructureScore.counts.HH}`,
      `HL events ${riskRangeStructureScore.counts.HL}`,
      `LH events ${riskRangeStructureScore.counts.LH}`,
      `LL events ${riskRangeStructureScore.counts.LL}`,
      'direction changes restart at +1 or −1',
      `equal endpoints reset to 0 × ${riskRangeStructureScore.counts.EH + riskRangeStructureScore.counts.EL}`,
      'first visible session is the baseline',
    ].join(' · ')
    : riskRangeStructureScore.reason;
  const multiDayRangeValues = useMemo(() => (multiDay && chartAvailable
    ? multiDayLayout.sessions.flatMap((session) => session.riskRange.available
      ? [session.riskRange.lrr, session.riskRange.hrr]
      : [])
    : []), [chartAvailable, multiDay, multiDayLayout]);
  const values = useMemo(() => ([
    ...points.map((point) => point.value).filter(finite),
    ...contractPoints.map((point) => point.value).filter(finite),
    ...goldSettlementMarkers.map((settlement) => settlement.value).filter(finite),
    ...(multiDay ? multiDayRangeValues : rangeAvailable ? [Number(selectedRiskRange.lrr), Number(selectedRiskRange.hrr)] : []),
  ]), [contractPoints, goldSettlementMarkers, multiDay, multiDayRangeValues, points, rangeAvailable, selectedRiskRange]);
  const minimum = values.length ? Math.min(...values) : 0;
  const maximum = values.length ? Math.max(...values) : 1;
  const padding = Math.max((maximum - minimum) * 0.14, 8);
  const baseMultiDayPriceAxis = useMemo(() => (multiDay ? buildSpxPriceAxis(values) : null), [multiDay, values]);
  const multiDayPriceAxis = useMemo(() => (multiDay && marketUi.symbol === 'SPX'
    ? expandSpxPriceAxis(baseMultiDayPriceAxis, 100)
    : baseMultiDayPriceAxis), [baseMultiDayPriceAxis, marketUi, multiDay]);
  const oneDayPriceAxis = useMemo(() => (sp500OneDayLayout ? buildSpxPriceAxis(values, 5) : null), [sp500OneDayLayout, values]);
  const domain = useMemo(() => (multiDay ? multiDayPriceAxis.domain : oneDayPriceAxis?.domain || [minimum - padding, maximum + padding]), [maximum, minimum, multiDay, multiDayPriceAxis, oneDayPriceAxis, padding]);
  const vixClosesByDate = useMemo(() => (multiDay && marketUi.symbol === 'SPX'
    ? resolveVerifiedVixCloses(chart?.vixCloses, multiDayLayout.sessions.map((session) => session.date))
    : new Map()), [chart, marketUi, multiDay, multiDayLayout]);
  const vixCloseFallbackState = chart?.vixCloses?.status === 'loading' ? 'loading' : 'unavailable';
  const athValue = chartAvailable ? resolveAthReferenceValue(chart?.ath) : null;
  const athDate = chartAvailable ? resolveAthReferenceDate(chart?.ath, athValue) : null;
  const athDateLabel = athDate ? formatAthSessionDate(athDate) : null;
  const athReference = useMemo(() => (clampChartReferenceValue(athValue, domain)), [athValue, domain]);
  const chartLabelOffsets = useMemo(() => (resolveChartLabelOffsets([
    ...(athReference.value != null ? [{ id: 'ath', value: athReference.value }] : []),
    ...(!multiDay && rangeAvailable ? [
      { id: 'hrr', value: Number(selectedRiskRange.hrr) },
      { id: 'lrr', value: Number(selectedRiskRange.lrr) },
    ] : []),
    ...(contractLatest && finite(contractLatest.value) ? [{ id: 'contract', value: Number(contractLatest.value) }] : []),
    ...(latest && finite(latest.value) ? [{ id: 'latest', value: Number(latest.value) }] : []),
  ], domain)), [athReference, contractLatest, domain, latest, multiDay, rangeAvailable, selectedRiskRange]);
  const chartLabelCollisionCount = Object.values(chartLabelOffsets)
    .filter((offset) => Math.abs(Number(offset)) > 0.01).length;
  const third = rangeAvailable ? (Number(selectedRiskRange.hrr) - Number(selectedRiskRange.lrr)) / 3 : null;
  const sameFitSpot = spotAvailable && (spot?.fit || 'exact') === (chart?.fit || 'exact');
  const displayedValue = chartAvailable
    ? selectedRange === '1d' && sameFitSpot ? spot.value : (chart.latestValue ?? latest?.value)
    : spotAvailable ? spot.value : null;
  const compactMarketHeader = marketUi.simplified === true;
  const dayChangePreviousClose = spotAvailable && finite(spot?.previousClose)
    ? Number(spot.previousClose)
    : chartAvailable && finite(chart?.previousClose)
      ? Number(chart.previousClose)
      : null;
  const dayChangePercent = compactMarketHeader && finite(displayedValue) && dayChangePreviousClose != null
    ? resolveDayChangePercent(displayedValue, dayChangePreviousClose)
    : null;
  const compactPriceTone = !finite(displayedValue)
    ? 'unavailable'
    : dayChangePercent == null
      ? 'neutral'
      : dayChangePercent > 0 ? 'positive' : dayChangePercent < 0 ? 'negative' : 'neutral';
  const dayChangeTone = dayChangePercent == null
    ? 'unavailable'
    : dayChangePercent > 0 ? 'positive' : dayChangePercent < 0 ? 'negative' : 'neutral';
  const sessionState = String(snapshot?.session?.state || 'closed').toLowerCase();
  const trend = rangeAvailable ? String(riskRange?.trend || '').toUpperCase() : '';
  const headerAsOf = chartAvailable
    ? selectedRange === '1d' && sameFitSpot ? spot.asOf : chart.latestAt
    : spotAvailable ? spot.asOf : null;
  const sectionRefreshDelayed = Boolean(
    refreshDelayed
      || basisChartReference?.freshness?.status === 'delayed'
      || spot?.refreshIssue
      || chart?.refreshIssue
      || riskRange?.refreshIssue
  );
  const dailyAxis = !multiDay && (chart?.interval === '1d'
    || chart?.range === '1mo'
    || (points.length > 1 && points[points.length - 1].timestamp - points[0].timestamp > 2 * 24 * 60 * 60_000));
  const intradayTimeAxis = useMemo(() => {
    if (multiDay || dailyAxis || !chartAvailable) return null;
    const targetTicks = sp500OneDayLayout ? Math.max(3, Math.min(8, Math.floor((chartPlotWidth || 320) / 65))) : 8;
    const span = sessionDomain ? sessionDomain[1] - sessionDomain[0] : basisWindowEnd - basisWindowStart;
    const axis = buildIntradayTimeAxis(points.map((point) => point.timestamp), targetTicks, {
        domain: sessionDomain,
        includeEndpoints: true,
        ...(sp500OneDayLayout ? { minimumTickGapMs: span / targetTicks } : {}),
      });
    return sp500OneDayLayout ? {
      ...axis,
      timeZone: 'America/New_York',
      clock24: true,
    } : axis;
  }, [basisWindowEnd, basisWindowStart, chartAvailable, chartPlotWidth, dailyAxis, multiDay, points, sessionDomain, sp500OneDayLayout]);
  const goldSettlementScheduleCandidate = goldOneDayLayout && chartAvailable && !dailyAxis
    ? resolveVerifiedGoldSettlementTime(venueSelection, latestChartDate, nowMs)
    : null;
  // Clock validation may return an equivalent small schedule object. Keep its
  // identity stable so a countdown does not rebuild the price-chart subtree.
  const goldSettlementScheduleKey = JSON.stringify(goldSettlementScheduleCandidate);
  const goldSettlementSchedule = useMemo(
    () => JSON.parse(goldSettlementScheduleKey),
    [goldSettlementScheduleKey],
  );
  const goldSettlementScheduleVisible = goldSettlementSchedule
    && intradayTimeAxis
    && goldSettlementSchedule.timestamp >= intradayTimeAxis.domain[0]
    && goldSettlementSchedule.timestamp <= intradayTimeAxis.domain[1]
    ? goldSettlementSchedule
    : null;
  const referenceMode = chartAvailable && (chart?.status === 'historical' || chart?.availability === 'historical')
    ? 'LAST CLOSE'
    : chartAvailable ? 'CURRENT BAR' : 'UNAVAILABLE';
  const xauSpotProxy = chart?.fit === 'proxy'
    && /\bXAUUSD\b/i.test(`${spot?.label || ''} ${chart?.label || ''}`);
  const perpetualReference = snapshot?.perpetualReference;
  const coinbaseProxy = !perpetualReference && chart?.fit === 'proxy'
    && /coinbase/i.test(chart?.source || spot?.source || '');
  const referenceBadge = perpetualReference ? 'KALSHI PERP'
    : coinbaseProxy ? 'COINBASE PROXY'
      : xauSpotProxy ? 'XAUUSD PROXY' : chart && chart?.fit !== 'proxy' ? 'EXACT' : null;
  const referenceBadgeDetails = perpetualReference
    ? `${perpetualReference.instrument?.ticker || perpetualReference.instrument?.symbol || ''} · Direct Kalshi perpetual trades · ${perpetualReference.instrument?.priceUnit || 'USD'}. ${referenceMode}. Prediction contract settlement input is shown above the contract ladder.`
    : coinbaseProxy
      ? `Coinbase ${marketUi.symbol}/USD spot price. ${referenceMode}. Prediction contract settlement input is shown above the contract ladder.`
    : xauSpotProxy
    ? `Live IBKR XAUUSD spot-gold proxy. ${referenceMode}. This is not the exact Pyth resolver and is not executable.`
    : referenceBadge
      ? `Exact reference. ${referenceMode}. Full provenance is labeled on the blue reference marker.`
      : null;
  const basisSeriesSymbol = basisChartReference?.symbol
    || (snapshot?.chartReferences ? marketUi.symbol : 'SPOT');
  const contractSeriesSymbol = contractChartReference?.symbol
    || contractChartReference?.instrument?.displaySymbol
    || contractChartReference?.spot?.label
    || 'CONTRACT';
  const basisSeriesDelayed = basisChartReference?.freshness?.status === 'delayed';
  const contractSeriesDelayed = contractChartReference?.freshness?.status === 'delayed'
    || contractChartReference?.spot?.status === 'delayed'
    || contractChartReference?.spot?.availability === 'delayed';
  const contractSeriesState = contractChartAvailable
    ? contractSeriesDelayed ? 'delayed' : 'available'
    : contractChart?.status === 'refreshing' || contractChart?.refreshing === true
      ? 'loading'
      : 'unavailable';
  const chartClockHeadline = checkingHours
    ? 'CHECKING MARKET HOURS'
    : String(tradingClock?.headline || '');
  const chartClockSeparator = chartClockHeadline.indexOf(' · ');
  const chartClockStatus = chartClockSeparator >= 0
    ? chartClockHeadline.slice(0, chartClockSeparator)
    : chartClockHeadline;
  const chartClockTiming = chartClockSeparator >= 0
    ? chartClockHeadline.slice(chartClockSeparator + 3)
    : null;

  return {
    plot: {
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
    },
    shell: {
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
      xauSpotProxy,
    },
  };
};

export { useRiskRangeChartModel };
