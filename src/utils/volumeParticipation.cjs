// Volume confirms price: money committing to the market shows up as heavier
// volume on up sessions than on down sessions. Every trade has a buyer and a
// seller, so this measures conviction behind moves, not money entering.
const { previousTradingDateKey } = require('./usEquityMarketCalendar.cjs');

const PARTICIPATION_WINDOWS = Object.freeze({ '1m': 21, '3m': 63 });
// Up-volume / down-volume ratio bands for the 1M window.
const PARTICIPATION_RATIO_BANDS = Object.freeze({ accumulationAtOrAbove: 1.1, distributionAtOrBelow: 0.9 });
// Fewer up or down sessions than this leaves the ratio too noisy to label.
const MIN_SESSIONS_PER_SIDE = 5;
// Recent average daily volume is compared with the trailing year's average.
const VOLUME_TREND_WINDOWS = Object.freeze({ '1w': 5, '1m': 21, '3m': 63 });
const VOLUME_TREND_BASELINE = 252;
// A 1M average more than 5% off the yearly norm reads light or heavy.
const VOLUME_TREND_BAND = 0.05;
// A window needs most of its sessions verified before it is averaged.
const VOLUME_TREND_MIN_COVERAGE = 0.8;

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Pairs each Cboe session with the index close and the previous trading
// session's close. Sessions missing either input are dropped, never bridged.
function pairSessions(volumeRows, closes) {
  const closeByDate = new Map((closes || [])
    .filter(row => row && positive(row.close))
    .map(row => [row.date, row.close]));
  return (volumeRows || [])
    .filter(row => row && positive(row.volume) && closeByDate.has(row.date)
      && closeByDate.has(previousTradingDateKey(row.date)))
    .map(row => {
      const close = closeByDate.get(row.date);
      const priorClose = closeByDate.get(previousTradingDateKey(row.date));
      return { date: row.date, volume: row.volume, close, change: (close / priorClose) - 1 };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function windowStats(sessions, size) {
  const window = sessions.slice(0, size);
  const up = window.filter(session => session.change > 0);
  const down = window.filter(session => session.change < 0);
  const upVolumeAvg = average(up.map(session => session.volume));
  const downVolumeAvg = average(down.map(session => session.volume));
  const enough = window.length === size && up.length >= MIN_SESSIONS_PER_SIDE && down.length >= MIN_SESSIONS_PER_SIDE;
  const upDownRatio = enough ? upVolumeAvg / downVolumeAvg : null;
  return {
    sessions: window.length,
    upDays: up.length,
    downDays: down.length,
    upVolumeAvg,
    downVolumeAvg,
    upDownRatio,
    volumeAvg: average(window.map(session => session.volume)),
    regime: participationRegime(upDownRatio),
  };
}

function participationRegime(ratio) {
  if (!Number.isFinite(ratio)) return 'unavailable';
  if (ratio >= PARTICIPATION_RATIO_BANDS.accumulationAtOrAbove) return 'accumulation';
  if (ratio <= PARTICIPATION_RATIO_BANDS.distributionAtOrBelow) return 'distribution';
  return 'balanced';
}

function sessionSignal(session, volumeAvg) {
  if (!session || !positive(volumeAvg) || session.change === 0) return 'unavailable';
  const heavy = session.volume > volumeAvg;
  if (session.change > 0) return heavy ? 'confirmed advance' : 'light advance';
  return heavy ? 'confirmed decline' : 'light decline';
}

function calculateParticipation(volumeRows, closes) {
  const sessions = pairSessions(volumeRows, closes);
  const windows = Object.fromEntries(Object.entries(PARTICIPATION_WINDOWS)
    .map(([key, size]) => [key, windowStats(sessions, size)]));
  const latest = sessions[0] || null;
  return {
    status: windows['1m'].regime === 'unavailable' ? 'unavailable' : 'ok',
    asOf: latest?.date || null,
    latest: latest ? {
      ...latest,
      volumeVs1m: positive(windows['1m'].volumeAvg) ? (latest.volume / windows['1m'].volumeAvg) - 1 : null,
      signal: sessionSignal(latest, windows['1m'].volumeAvg),
    } : null,
    windows,
    regime: windows['1m'].regime,
    history: sessions.slice(0, PARTICIPATION_WINDOWS['3m']),
  };
}

// Conviction behind the tape, not direction: how busy recent sessions are
// against the trailing year. Rows are calendar slots, so a session Cboe left
// incomplete stays a gap instead of shifting the window.
function calculateVolumeTrend(volumeRows) {
  const rows = (volumeRows || []).filter(row => row?.date).sort((a, b) => b.date.localeCompare(a.date));
  const windowAverage = (size) => {
    const window = rows.slice(0, size);
    const volumes = window.map(row => row.volume).filter(positive);
    return window.length === size && volumes.length >= Math.ceil(size * VOLUME_TREND_MIN_COVERAGE)
      ? average(volumes)
      : null;
  };
  const baseline = windowAverage(VOLUME_TREND_BASELINE);
  const windows = Object.fromEntries(Object.entries(VOLUME_TREND_WINDOWS).map(([key, size]) => {
    const recent = windowAverage(size);
    return [key, positive(recent) && positive(baseline) ? (recent / baseline) - 1 : null];
  }));
  const oneMonth = windows['1m'];
  const read = !Number.isFinite(oneMonth)
    ? 'unavailable'
    : oneMonth < -VOLUME_TREND_BAND ? 'light' : oneMonth > VOLUME_TREND_BAND ? 'heavy' : 'normal';
  const latest = rows.find(row => positive(row.volume)) || null;
  return {
    status: read === 'unavailable' ? 'unavailable' : 'ok',
    asOf: rows[0]?.date || null,
    latest: latest ? { date: latest.date, volume: latest.volume } : null,
    baselineSessions: VOLUME_TREND_BASELINE,
    windows,
    read,
  };
}

module.exports = {
  MIN_SESSIONS_PER_SIDE,
  PARTICIPATION_RATIO_BANDS,
  PARTICIPATION_WINDOWS,
  VOLUME_TREND_BASELINE,
  calculateParticipation,
  calculateVolumeTrend,
  pairSessions,
  participationRegime,
};
