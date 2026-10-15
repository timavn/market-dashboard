import { formatAsOf } from './monitorFormatting';

export const formatDateTimeInZone = (value, timeZone) => {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short',
    }).format(new Date(parsed));
  } catch (_error) {
    return formatAsOf(value);
  }
};

const timestampMs = (value) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
};

const formatTradingDuration = (targetMs, nowMs) => {
  const remainingSeconds = Math.max(0, Math.floor((targetMs - nowMs) / 1_000));
  const days = Math.floor(remainingSeconds / 86_400);
  const hours = Math.floor((remainingSeconds % 86_400) / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const formatTradingWindow = (openTime, closeTime, timeZone) => {
  const openLabel = openTime ? formatDateTimeInZone(openTime, timeZone) : '—';
  const closeLabel = closeTime ? formatDateTimeInZone(closeTime, timeZone) : '—';
  if (openLabel !== '—' && closeLabel !== '—') return `${openLabel} → ${closeLabel}`;
  if (closeLabel !== '—') return `CLOSE ${closeLabel}`;
  if (openLabel !== '—') return `OPEN ${openLabel}`;
  return null;
};

export function buildContractTradingClock({
  event = null,
  generation = null,
  nowMs = Date.now(),
  localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
} = {}) {
  const pick = (key) => event?.[key] || generation?.[key] || null;
  const openTime = pick('openTime');
  const closeTime = pick('closeTime');
  const observationTime = pick('observationTime');
  const resolutionTime = event?.resolutionAt || pick('resolutionTime');
  const exchangeTimeZone = pick('timezone');
  const openMs = timestampMs(openTime);
  const closeMs = timestampMs(closeTime);
  const observationMs = timestampMs(observationTime);
  const resolutionMs = timestampMs(resolutionTime);
  const normalizedNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const rawStatus = String(event?.status || generation?.status || '').trim().toLowerCase();
  const closedStatuses = new Set(['closed', 'expired', 'settled', 'resolved', 'finalized', 'cancelled', 'canceled']);
  const pausedStatuses = new Set(['halted', 'paused', 'suspended']);
  const openStatuses = new Set(['open', 'active', 'live', 'trading']);
  const scheduledStatuses = new Set(['scheduled', 'upcoming', 'pending', 'initialized']);
  let state = 'unavailable';
  let headline = 'CONTRACT HOURS UNAVAILABLE';

  if (closedStatuses.has(rawStatus) || (closeMs != null && closeMs <= normalizedNowMs)) {
    state = 'closed';
    if (observationMs != null && observationMs > normalizedNowMs && observationMs !== closeMs) {
      headline = `TRADING CLOSED · OBSERVES IN ${formatTradingDuration(observationMs, normalizedNowMs)}`;
    } else if (resolutionMs != null && resolutionMs > normalizedNowMs) {
      headline = `TRADING CLOSED · RESOLVES IN ${formatTradingDuration(resolutionMs, normalizedNowMs)}`;
    } else {
      headline = 'TRADING CLOSED';
    }
  } else if (openMs != null && openMs > normalizedNowMs) {
    state = 'scheduled';
    headline = `OPENS IN ${formatTradingDuration(openMs, normalizedNowMs)}`;
  } else if (pausedStatuses.has(rawStatus)) {
    state = 'paused';
    headline = closeMs != null
      ? `TRADING ${rawStatus.toUpperCase()} · CLOSES IN ${formatTradingDuration(closeMs, normalizedNowMs)}`
      : `TRADING ${rawStatus.toUpperCase()} · CLOSE TIME UNAVAILABLE`;
  } else if (
    openStatuses.has(rawStatus)
    || (openMs != null && closeMs != null && openMs <= normalizedNowMs && closeMs > normalizedNowMs)
  ) {
    state = 'open';
    headline = closeMs != null
      ? `OPEN · CLOSES IN ${formatTradingDuration(closeMs, normalizedNowMs)}`
      : 'OPEN · CLOSE TIME UNAVAILABLE';
  } else if (scheduledStatuses.has(rawStatus)) {
    state = 'scheduled';
    headline = openMs != null
      ? `OPENS IN ${formatTradingDuration(openMs, normalizedNowMs)}`
      : 'SCHEDULED · OPEN TIME UNAVAILABLE';
  } else if (closeMs != null && closeMs > normalizedNowMs) {
    state = 'unavailable';
    headline = `TRADING STATUS UNAVAILABLE · CLOSES IN ${formatTradingDuration(closeMs, normalizedNowMs)}`;
  }

  const exchangeWindow = exchangeTimeZone
    ? formatTradingWindow(openTime, closeTime, exchangeTimeZone)
    : null;
  const localWindow = formatTradingWindow(openTime, closeTime, localTimeZone);
  const scheduleLines = [];
  if (exchangeWindow) {
    scheduleLines.push(`${exchangeTimeZone === localTimeZone ? 'EXCHANGE / LOCAL' : 'EXCHANGE'} · ${exchangeWindow}`);
  }
  if (localWindow && exchangeTimeZone !== localTimeZone) {
    scheduleLines.push(`LOCAL · ${localWindow}`);
  }
  if (!scheduleLines.length && observationMs != null) {
    const observationLabel = formatDateTimeInZone(observationTime, localTimeZone);
    if (observationLabel !== '—') scheduleLines.push(`LOCAL OBSERVATION · ${observationLabel}`);
  }

  return {
    state,
    headline,
    primarySchedule: scheduleLines[0] || 'VERIFIED TRADING WINDOW UNAVAILABLE',
    secondarySchedule: scheduleLines[1] || null,
    title: [headline, ...scheduleLines].join(' · '),
  };
}
