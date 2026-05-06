/**
 * Client-side filter for realized G/L lots (aligns with list search: ticker + name).
 * @param {Array<{ symbol?: string, name?: string }>} lots
 * @param {string} query
 * @returns {typeof lots}
 */
export function filterLotsBySearch(lots, query) {
  if (!lots || !lots.length) return lots || [];
  if (!query || !String(query).trim()) return lots;
  const q = String(query).toLowerCase().trim();
  return lots.filter((lot) => {
    const sym = (lot.symbol || '').toLowerCase();
    const name = (lot.name || '').toLowerCase();
    return sym.includes(q) || name.includes(q);
  });
}

export function computeKPIs(lots) {
  let netRealized = 0;
  let totalGains = 0;
  let totalLosses = 0;
  let winCount = 0;
  let lossCount = 0;
  let largestGain = 0;
  let largestLoss = 0;

  for (const lot of lots) {
    const gl = Number(lot.gainLossDollar) || 0;
    netRealized += gl;
    if (gl > 0) {
      totalGains += gl;
      winCount++;
      if (gl > largestGain) largestGain = gl;
    } else if (gl < 0) {
      totalLosses += gl;
      lossCount++;
      if (gl < largestLoss) largestLoss = gl;
    }
  }

  const tradeCount = lots.length;
  const winRate = tradeCount > 0 ? (winCount / tradeCount) * 100 : 0;
  const avgWin = winCount > 0 ? totalGains / winCount : 0;
  const avgLoss = lossCount > 0 ? totalLosses / lossCount : 0;
  const profitFactor = totalLosses !== 0 ? Math.abs(totalGains / totalLosses) : (totalGains > 0 ? Infinity : 0);

  return {
    netRealized,
    totalGains,
    totalLosses,
    winCount,
    lossCount,
    tradeCount,
    winRate,
    avgWin,
    avgLoss,
    largestGain,
    largestLoss,
    profitFactor,
  };
}

export function aggregateDailyPnL(lots) {
  const dailyMap = {};
  
  for (const lot of lots) {
    const d = lot.closedDate;
    if (!d) continue;
    if (!dailyMap[d]) dailyMap[d] = 0;
    dailyMap[d] += Number(lot.gainLossDollar) || 0;
  }

  // Sort dates
  const sortedDates = Object.keys(dailyMap).sort();
  const aggregated = [];
  let cumulative = 0;

  for (const date of sortedDates) {
    const dailyPnL = dailyMap[date];
    cumulative += dailyPnL;
    aggregated.push({
      date,
      dailyPnL,
      cumulativePnL: cumulative,
      timestamp: new Date(date + 'T12:00:00Z').getTime()
    });
  }

  return aggregated;
}
