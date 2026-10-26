const { normalizeAdjustedPriceBars } = require('./securityRiskMetrics.cjs');

// Trading-session windows shown beside an Inbox alert. They describe recent
// price behaviour only and are independent of the Tick/Trade/Trend/Tail durations.
const HORIZONS = [1, 15, 30, 90];
const BASELINE = 252;
const PARKINSON = 1 / (4 * Math.log(2));
const round = (value, places = 1) => value == null || !Number.isFinite(value) ? null : Number(value.toFixed(places));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

// Range-based (Parkinson) volatility is defined for a single session, so 1D
// and 90D use the same estimator and can be compared directly.
function parkinsonVol(bars) {
  if (!bars.length || bars.some(bar => !(bar.adjustedHigh > 0 && bar.adjustedLow > 0))) return null;
  return Math.sqrt(PARKINSON * mean(bars.map(bar => Math.log(bar.adjustedHigh / bar.adjustedLow) ** 2)) * 252) * 100;
}

function averageVolume(bars) {
  return bars.length && bars.every(bar => bar.volume > 0) ? mean(bars.map(bar => bar.volume)) : null;
}

function horizonStats(rawBars) {
  const bars = normalizeAdjustedPriceBars(rawBars).filter(bar => bar.adjustedClose > 0);
  const last = bars.at(-1);
  if (!last) return null;
  const baselineBars = bars.slice(-BASELINE);
  const baselineVolume = baselineBars.length >= 90 ? averageVolume(baselineBars) : null;
  const columns = HORIZONS.map(sessions => {
    const window = bars.slice(-sessions);
    const start = bars.at(-1 - sessions);
    const high = Math.max(...window.map(bar => bar.adjustedHigh ?? NaN));
    const low = Math.min(...window.map(bar => bar.adjustedLow ?? NaN));
    const volume = averageVolume(window);
    return {
      label: `${sessions}D`,
      priceChangePct: start ? round((last.adjustedClose / start.adjustedClose - 1) * 100) : null,
      realizedVolPct: window.length === sessions ? round(parkinsonVol(window), 0) : null,
      volumeRatio: window.length === sessions && volume && baselineVolume ? round(volume / baselineVolume) : null,
      // Where the close sits between the window's low (0) and high (100).
      rangePct: window.length === sessions && high > low ? round((last.adjustedClose - low) / (high - low) * 100, 0) : null,
    };
  });
  return { asOf: last.date, baselineVolPct: round(baselineBars.length >= 90 ? parkinsonVol(baselineBars) : null, 0), columns };
}

module.exports = { HORIZONS, horizonStats };
