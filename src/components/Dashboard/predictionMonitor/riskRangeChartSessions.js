import usEquityMarketCalendar from '../../../utils/usEquityMarketCalendar.cjs';
import { finite } from './monitorNumbers';
import { riskRangeValues } from './riskRangeStructure';

const {
  addCalendarDays: addUsEquityCalendarDays,
  closedUsEquityDatesBetween,
} = usEquityMarketCalendar;

const chartSessionParts = (timestamp) => {
  if (!Number.isFinite(Number(timestamp))) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(Number(timestamp)));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  return values.year && values.month && values.day && Number.isFinite(hour) && Number.isFinite(minute)
    ? {
      date: `${values.year}-${values.month}-${values.day}`,
      minutes: (hour * 60) + minute,
    }
    : null;
};

const chartSessionDate = (timestamp) => chartSessionParts(timestamp)?.date || null;

const formatSessionLabel = (date) => {
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed)) return { weekday: '—', date: String(date || '—') };
  return {
    weekday: new Date(parsed).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).toUpperCase(),
    date: new Date(parsed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toUpperCase(),
  };
};

const formatShortSessionDate = (date) => {
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
    : String(date || '—');
};

const formatSessionTime = (timestamp) => Number.isFinite(Number(timestamp))
  ? new Date(Number(timestamp)).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
    })
  : '—';

const MULTI_DAY_SESSION_GAP = 0.04;

const UTC_DAY_MS = 24 * 60 * 60 * 1000;

const WEEKEND_SEPARATOR_WIDTH_PX = 15;

const WEEKEND_SEPARATOR_GUTTER_PX = 2;

const WEEKEND_INTERVAL_WIDTH_PX = WEEKEND_SEPARATOR_WIDTH_PX + (WEEKEND_SEPARATOR_GUTTER_PX * 2);

const DEFAULT_WEEKEND_SESSION_GAP = 0.24;

const CLOSED_DAY_BAND_GUTTER_PX = 2;

const SPX_CLOSED_DAY_WIDTH_PX = Object.freeze({ 5: 44, 10: 28 });

const US_EQUITY_CALENDAR = 'us_equity';

const WEEKDAY_CALENDAR = 'weekday';

const CONTINUOUS_CALENDAR = 'continuous';

const CHART_PLOT_HORIZONTAL_INSET_PX = 164;

const utcDateValue = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(timestamp);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    ? timestamp
    : null;
};

const crossesWeekend = (previousDate, nextDate) => {
  const previous = utcDateValue(previousDate);
  const next = utcDateValue(nextDate);
  if (!Number.isFinite(previous) || !Number.isFinite(next) || next <= previous) return false;
  for (let cursor = previous + UTC_DAY_MS; cursor < next; cursor += UTC_DAY_MS) {
    const day = new Date(cursor).getUTCDay();
    if (day === 0 || day === 6) return true;
  }
  return false;
};

const calendarDateKeysBetween = (previousDate, nextDate) => {
  if (utcDateValue(previousDate) == null || utcDateValue(nextDate) == null || previousDate >= nextDate) return [];
  const dates = [];
  for (let date = addUsEquityCalendarDays(previousDate, 1); date && date < nextDate; date = addUsEquityCalendarDays(date, 1)) {
    dates.push(date);
  }
  return dates;
};

const closedDatesBetweenForCalendar = (calendar, previousDate, nextDate) => {
  if (calendar === US_EQUITY_CALENDAR) {
    return closedUsEquityDatesBetween(previousDate, nextDate);
  }
  if (calendar === WEEKDAY_CALENDAR) {
    return calendarDateKeysBetween(previousDate, nextDate).flatMap((date) => {
      const timestamp = utcDateValue(date);
      const day = Number.isFinite(timestamp) ? new Date(timestamp).getUTCDay() : null;
      return day === 0 || day === 6
        ? [{ date, type: 'weekend', holidayName: null }]
        : [];
    });
  }
  return [];
};

const sessionProgress = (timestamp, startAt, endAt) => {
  const value = Number(timestamp);
  const start = Number(startAt);
  const end = Number(endAt);
  if (!Number.isFinite(value) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.min(1, Math.max(0, (value - start) / (end - start)));
};

const buildMultiDayChartLayout = (
  points,
  dailyRanges = [],
  expectedSessionCount = 5,
  plotWidthPx = null,
  configuration = {},
) => {
  const calendar = configuration?.calendar;
  const sessions = dailyRanges.map((range) => {
    const sessionPoints = points.filter((point) => (
      point?.sessionDate || chartSessionDate(point?.timestamp)
    ) === range?.date);
    if (!range?.date || sessionPoints.length < 2) return null;
    const firstTimestamp = Number(sessionPoints[0].timestamp);
    const lastTimestamp = Number(sessionPoints[sessionPoints.length - 1].timestamp);
    const startAt = Number.isFinite(Number(range.startAt)) ? Number(range.startAt) : firstTimestamp;
    const endAt = Number.isFinite(Number(range.endAt)) ? Number(range.endAt) : lastTimestamp;
    if (!(endAt > startAt)) return null;
    return {
      date: range.date,
      points: sessionPoints,
      range,
      riskRange: riskRangeValues(range),
      startAt,
      endAt,
    };
  }).filter(Boolean);
  if (sessions.length !== expectedSessionCount) {
    return {
      points: [], sessions: [], gaps: [], closedDays: [], weekendOpenSessions: [],
      maxX: null, axisGridTemplate: null, latestPoint: null, trailingGap: null,
    };
  }

  const calendarAware = [US_EQUITY_CALENDAR, WEEKDAY_CALENDAR, CONTINUOUS_CALENDAR].includes(calendar);
  const gapDefinitions = sessions.slice(1).map((session, index) => {
    const previousDate = sessions[index].date;
    if (calendarAware) {
      const missingDateKeys = calendarDateKeysBetween(previousDate, session.date);
      const closuresByDate = new Map(
        closedDatesBetweenForCalendar(calendar, previousDate, session.date)
          .map((closure) => [closure.date, closure]),
      );
      const segments = missingDateKeys.length
        ? missingDateKeys.map((date) => {
            const closure = closuresByDate.get(date);
            return closure
              ? { type: 'closed', date, closure }
              : { type: 'neutral', date, closure: null };
          })
        : [{ type: 'neutral', date: null, closure: null }];
      const closedDays = segments.filter((segment) => segment.type === 'closed').map((segment) => segment.closure);
      return {
        date: session.date,
        previousDate,
        calendarAware: true,
        missingDateKeys,
        unknownDateKeys: segments
          .filter((segment) => segment.type === 'neutral' && segment.date)
          .map((segment) => segment.date),
        segments,
        closedDays,
        isWeekend: closedDays.some((closure) => closure.type === 'weekend'),
      };
    }
    return {
      date: session.date,
      previousDate,
      calendarAware: false,
      missingDateKeys: calendarDateKeysBetween(previousDate, session.date),
      unknownDateKeys: [],
      segments: [],
      closedDays: [],
      isWeekend: crossesWeekend(previousDate, session.date),
    };
  });
  // A closure is calendar context, never an extra price session. Only extend
  // across consecutive confirmed closed dates, so missing trading data stays missing.
  const trailingClosedDays = [];
  const throughDate = configuration?.throughDate;
  const lastSessionDate = sessions[sessions.length - 1]?.date;
  if (calendarAware && utcDateValue(throughDate) != null) {
    for (let date = addUsEquityCalendarDays(lastSessionDate, 1);
      date && date <= throughDate;
      date = addUsEquityCalendarDays(date, 1)) {
      const [closure] = closedDatesBetweenForCalendar(
        calendar, addUsEquityCalendarDays(date, -1), addUsEquityCalendarDays(date, 1),
      );
      if (!closure) break;
      trailingClosedDays.push(closure);
    }
  }
  const trailingDefinition = trailingClosedDays.length ? {
    date: trailingClosedDays[trailingClosedDays.length - 1].date,
    previousDate: lastSessionDate,
    calendarAware: true,
    missingDateKeys: trailingClosedDays.map((closure) => closure.date),
    unknownDateKeys: [],
    segments: trailingClosedDays.map((closure) => ({ type: 'closed', date: closure.date, closure })),
    closedDays: trailingClosedDays,
    isWeekend: trailingClosedDays.some((closure) => closure.type === 'weekend'),
  } : null;
  const numericPlotWidth = Number(plotWidthPx);
  let weekendGapUnits = DEFAULT_WEEKEND_SESSION_GAP;
  let closedDayUnits = null;
  const closedDayWidthPx = Number(configuration?.closedDayWidthPx);
  if (calendarAware) {
    const closedDayCount = gapDefinitions.reduce((sum, gap) => sum + gap.closedDays.length, trailingClosedDays.length);
    const neutralSegmentCount = gapDefinitions.reduce(
      (sum, gap) => sum + gap.segments.filter((segment) => segment.type === 'neutral').length,
      0,
    );
    const baseLayoutUnits = sessions.length + (neutralSegmentCount * MULTI_DAY_SESSION_GAP);
    const desiredWidthPx = Number.isFinite(closedDayWidthPx) && closedDayWidthPx > 0 ? closedDayWidthPx : 44;
    const fixedClosedWidthPx = desiredWidthPx * closedDayCount;
    closedDayUnits = closedDayCount > 0
      && Number.isFinite(numericPlotWidth)
      && numericPlotWidth > fixedClosedWidthPx
      ? (desiredWidthPx * baseLayoutUnits) / (numericPlotWidth - fixedClosedWidthPx)
      : Math.max(0.18, desiredWidthPx / 140);
  } else {
    const weekendGapCount = gapDefinitions.filter((gap) => gap.isWeekend).length;
    const regularGapCount = gapDefinitions.length - weekendGapCount;
    const baseLayoutUnits = sessions.length + (regularGapCount * MULTI_DAY_SESSION_GAP);
    weekendGapUnits = weekendGapCount > 0
      && Number.isFinite(numericPlotWidth)
      && numericPlotWidth > WEEKEND_INTERVAL_WIDTH_PX * weekendGapCount
      ? (WEEKEND_INTERVAL_WIDTH_PX * baseLayoutUnits)
        / (numericPlotWidth - (WEEKEND_INTERVAL_WIDTH_PX * weekendGapCount))
      : DEFAULT_WEEKEND_SESSION_GAP;
  }

  const positionCalendarGap = (definition, startX) => {
    let segmentCursorX = startX;
    const segments = definition.segments.map((segment) => {
      const width = segment.type === 'closed' ? closedDayUnits : MULTI_DAY_SESSION_GAP;
      const segmentStartX = segmentCursorX;
      const segmentEndX = segmentStartX + width;
      const inset = segment.type === 'closed'
        ? width * (CLOSED_DAY_BAND_GUTTER_PX / Math.max(closedDayWidthPx || 44, 1))
        : 0;
      segmentCursorX = segmentEndX;
      return {
        ...segment,
        x: segmentStartX + (width / 2),
        startX: segmentStartX,
        endX: segmentEndX,
        width,
        ...(segment.type === 'closed' ? {
          bandStartX: segmentStartX + inset,
          bandEndX: segmentEndX - inset,
        } : {}),
      };
    });
    const endX = segmentCursorX;
    const closedDays = segments
      .filter((segment) => segment.type === 'closed')
      .map((segment) => ({
        ...segment.closure,
        x: segment.x,
        startX: segment.startX,
        endX: segment.endX,
        width: segment.width,
        bandStartX: segment.bandStartX,
        bandEndX: segment.bandEndX,
      }));
    const separatorStartX = closedDays[0]?.bandStartX ?? startX;
    const separatorEndX = closedDays[closedDays.length - 1]?.bandEndX ?? endX;
    const x = startX + ((endX - startX) / 2);
    return {
      ...definition,
      x,
      startX,
      endX,
      width: endX - startX,
      segments,
      closedDays,
      separatorStartX,
      separatorEndX,
    };
  };

  const plottedPoints = [];
  const plottedSessions = [];
  const gaps = [];
  let cursorX = 0;
  sessions.forEach((session, index) => {
    if (index > 0) {
      const definition = gapDefinitions[index - 1];
      const startX = cursorX;
      if (calendarAware) {
        const gap = positionCalendarGap(definition, startX);
        gaps.push(gap);
        const { x, endX } = gap;
        plottedPoints.push({ plotX: x, timestamp: null, value: null, sessionDate: null });
        cursorX = endX;
      } else {
        const width = definition.isWeekend ? weekendGapUnits : MULTI_DAY_SESSION_GAP;
        const endX = startX + width;
        const separatorX = startX + (width / 2);
        const separatorInset = definition.isWeekend
          ? width * (WEEKEND_SEPARATOR_GUTTER_PX / WEEKEND_INTERVAL_WIDTH_PX)
          : 0;
        gaps.push({
          ...definition,
          x: separatorX,
          startX,
          endX,
          width,
          separatorStartX: startX + separatorInset,
          separatorEndX: endX - separatorInset,
        });
        plottedPoints.push({ plotX: separatorX, timestamp: null, value: null, sessionDate: null });
        cursorX = endX;
      }
    }
    const startX = cursorX;
    const endX = startX + 1;
    session.points.forEach((point) => {
      const progress = sessionProgress(point.timestamp, session.startAt, session.endAt);
      if (progress == null) return;
      plottedPoints.push({
        ...point,
        plotX: startX + progress,
        sessionDate: session.date,
      });
    });
    plottedSessions.push({
      ...session,
      startX,
      endX,
      tickX: startX + 0.5,
      label: formatSessionLabel(session.date),
    });
    cursorX = endX;
  });
  const trailingGap = trailingDefinition ? positionCalendarGap(trailingDefinition, cursorX) : null;
  if (trailingGap) {
    gaps.push(trailingGap);
    cursorX = trailingGap.endX;
  }
  const axisGridTemplate = plottedSessions.flatMap((session, index) => {
    if (index === 0) return ['minmax(0, 1fr)'];
    const gap = gaps[index - 1];
    const gapColumns = gap.calendarAware
      ? gap.segments.map((segment) => `${segment.width}fr`)
      : [`${gap.width}fr`];
    return [...gapColumns, 'minmax(0, 1fr)'];
  }).concat(trailingGap?.segments.map((segment) => `${segment.width}fr`) || []).join(' ');
  return {
    points: plottedPoints,
    sessions: plottedSessions,
    gaps,
    trailingGap,
    closedDays: gaps.flatMap((gap) => gap.closedDays),
    weekendOpenSessions: [],
    maxX: cursorX,
    axisGridTemplate,
    latestPoint: [...plottedPoints].reverse().find((point) => finite(point.value)) || null,
  };
};

const buildFiveDayChartLayout = (points, dailyRanges = [], plotWidthPx = null, configuration = {}) => (
  buildMultiDayChartLayout(points, dailyRanges, 5, plotWidthPx, configuration)
);

const projectOverlayPointsToSessions = (points = [], sessions = []) => {
  const orderedSessions = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => Number.isFinite(Number(session?.startAt))
      && Number.isFinite(Number(session?.endAt))
      && Number(session.endAt) > Number(session.startAt));
  const projected = (Array.isArray(points) ? points : []).flatMap((point) => {
    const timestamp = Number(point?.timestamp);
    const value = Number(point?.value);
    if (!Number.isFinite(timestamp) || !Number.isFinite(value)) return [];
    const session = orderedSessions.find((candidate) => (
      timestamp >= Number(candidate.startAt) && timestamp <= Number(candidate.endAt)
    ));
    if (!session) return [];
    const progress = sessionProgress(timestamp, session.startAt, session.endAt);
    if (progress == null) return [];
    return [{
      ...point,
      timestamp,
      value,
      contractValue: value,
      plotX: Number(session.startX) + progress,
      sessionDate: session.date,
    }];
  }).sort((left, right) => left.timestamp - right.timestamp);
  return projected.reduce((withSessionGaps, point) => {
    const previous = withSessionGaps.at(-1);
    if (previous && previous.sessionDate && previous.sessionDate !== point.sessionDate) {
      withSessionGaps.push({
        timestamp: null,
        value: null,
        contractValue: null,
        plotX: (Number(previous.plotX) + Number(point.plotX)) / 2,
        sessionDate: null,
        isSessionGap: true,
      });
    }
    withSessionGaps.push(point);
    return withSessionGaps;
  }, []);
};

export { CHART_PLOT_HORIZONTAL_INSET_PX, SPX_CLOSED_DAY_WIDTH_PX, buildFiveDayChartLayout, buildMultiDayChartLayout, chartSessionDate, chartSessionParts, formatSessionLabel, formatSessionTime, formatShortSessionDate, projectOverlayPointsToSessions, sessionProgress };
