const expectedValuesData = require('../constants/expectedValuesData');

const DEFAULT_WINDOWS = [30, 90, 180];
const DEFAULT_PRIMARY_WINDOW = 90;
const CLUSTER_CORRELATION_THRESHOLD = 0.6;
const ANCHOR_CORRELATION_THRESHOLD = 0.5;
const SIGNATURE_WEIGHT_BUCKET_PCT = 0.25;

const CASH_SYMBOLS = new Set([
  'CASH',
  'CASH & CASH INVESTMENTS',
  'BIL',
  'CLIP',
  'GBIL',
  'SGOV',
  'SHV',
  'TBIL',
  'TFLO',
  'USFR',
  'XBIL',
]);

const FALLBACK_LABEL_RULES = [
  { label: 'Gold', pattern: /(gold|newmont|barrick|gold miner|gdx|xau|aaau|gld|nem)/i, evTicker: 'GLD' },
  { label: 'Silver', pattern: /(silver|slv|si=)/i, evTicker: 'SLV' },
  { label: 'Bitcoin', pattern: /(bitcoin|btc|ibit|gbtc|mstr|coin|mara|riot)/i, evTicker: 'GBTC' },
  { label: 'WTI Crude Oil', pattern: /(crude|oil|wti|uso|xop)/i, evTicker: 'USO' },
  { label: 'Natural Gas', pattern: /(natural gas|natgas|ung)/i, evTicker: 'UNG' },
  { label: 'US Dollar Index', pattern: /(u\.?s\.? dollar|usd|dxy|uup)/i, evTicker: 'UUP' },
  { label: 'High Beta', pattern: /(high beta|sphb)/i, evTicker: 'SPHB' },
  { label: 'Low Beta', pattern: /(low beta|splv|usmv)/i, evTicker: 'SPLV' },
  { label: 'Momentum', pattern: /(momentum|mtum)/i, evTicker: 'MTUM' },
  { label: 'Quality', pattern: /(quality|qual)/i, evTicker: 'QUAL' },
];

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function parseNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizeCorrelationWindows(windows = DEFAULT_WINDOWS, primaryWindow = DEFAULT_PRIMARY_WINDOW) {
  const primary = Number(primaryWindow) || DEFAULT_PRIMARY_WINDOW;
  const cleanWindows = [...new Set((windows || DEFAULT_WINDOWS).map(Number).filter((value) => Number.isFinite(value) && value > 1))]
    .sort((a, b) => a - b);
  if (!cleanWindows.includes(primary)) cleanWindows.push(primary);
  return cleanWindows.sort((a, b) => a - b);
}

function round(value, decimals = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getDateKey(row) {
  if (row?.date) return String(row.date).slice(0, 10);
  const raw = row?.t ?? row?.timestamp;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function normalizeHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .map((row) => {
      const close = parseNumber(row?.close ?? row?.price, NaN);
      const date = getDateKey(row);
      if (!date || !Number.isFinite(close) || close <= 0) return null;
      return { date, close };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildReturnsByDate(history = []) {
  const rows = normalizeHistory(history);
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1].close;
    const next = rows[i].close;
    if (prev > 0 && next > 0) {
      out.push({ date: rows[i].date, value: Math.log(next / prev) });
    }
  }
  return out;
}

function isCashHolding(holding = {}) {
  const symbol = normalizeSymbol(holding.symbol);
  const assetClass = String(holding.assetClass || holding.assetType || '').toLowerCase();
  const description = String(holding.description || holding.name || '').toLowerCase();
  return (
    CASH_SYMBOLS.has(symbol) ||
    assetClass.includes('cash') ||
    assetClass.includes('money market') ||
    description.includes('money market') ||
    description.includes('treasury bill')
  );
}

function isOptionHolding(holding = {}) {
  const secType = normalizeSymbol(holding.secType || holding.securityType || holding.assetType);
  const assetClass = String(holding.assetClass || holding.assetType || '').toLowerCase();
  const description = String(holding.description || holding.name || '').toLowerCase();
  return secType === 'OPT' || secType === 'OPTION' || assetClass.includes('option') || description.includes(' option ');
}

function getHoldingSide(holding = {}) {
  const marketValue = parseNumber(holding.marketValue, 0);
  const quantity = parseNumber(holding.quantity, 0);
  return marketValue < 0 || quantity < 0 ? 'short' : 'long';
}

function normalizeSecurityType(holding = {}) {
  return String(
    holding.secType ||
    holding.securityType ||
    holding.assetType ||
    holding.assetClass ||
    'unspecified',
  )
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_') || 'UNSPECIFIED';
}

function getSignatureTotalValue(holdings = [], totalValue = null) {
  const direct = parseNumber(totalValue, 0);
  if (direct > 0) return direct;
  return (Array.isArray(holdings) ? holdings : []).reduce((sum, holding) => (
    sum + Math.abs(parseNumber(holding?.marketValue, 0))
  ), 0);
}

function buildCorrelationRequestSignature(holdings = [], totalValue = null, options = {}) {
  const bucketPct = parseNumber(options.bucketPct, SIGNATURE_WEIGHT_BUCKET_PCT) || SIGNATURE_WEIGHT_BUCKET_PCT;
  const nlv = getSignatureTotalValue(holdings, totalValue);
  if (!Array.isArray(holdings) || holdings.length === 0 || nlv <= 0) return '';

  const rowsByKey = new Map();
  for (const holding of holdings) {
    const symbol = normalizeSymbol(holding?.symbol);
    const marketValue = parseNumber(holding?.marketValue, 0);
    if (!symbol || Math.abs(marketValue) === 0) continue;

    const side = getHoldingSide(holding);
    const securityType = normalizeSecurityType(holding);
    const key = `${symbol}|${side}|${securityType}`;
    const current = rowsByKey.get(key) || {
      symbol,
      side,
      securityType,
      signedWeightPct: 0,
    };
    current.signedWeightPct += (marketValue / nlv) * 100;
    rowsByKey.set(key, current);
  }

  return Array.from(rowsByKey.values())
    .map((row) => {
      const bucketedWeight = Math.round(row.signedWeightPct / bucketPct) * bucketPct;
      return {
        ...row,
        bucketedWeight,
      };
    })
    .sort((a, b) => (
      a.symbol.localeCompare(b.symbol) ||
      a.side.localeCompare(b.side) ||
      a.securityType.localeCompare(b.securityType)
    ))
    .map((row) => `${row.symbol}:${row.side}:${row.securityType}:${row.bucketedWeight.toFixed(2)}`)
    .join('|');
}

function getCorrelationScoringCandidates(holdings = []) {
  return (Array.isArray(holdings) ? holdings : []).filter((holding) => {
    const symbol = normalizeSymbol(holding?.symbol);
    const marketValue = parseNumber(holding?.marketValue, 0);
    if (!symbol || Math.abs(marketValue) === 0) return false;
    if (isCashHolding(holding) || isOptionHolding(holding)) return false;
    return true;
  });
}

function getCorrelationScorableSymbols(holdings = []) {
  return [...new Set(getCorrelationScoringCandidates(holdings).map((holding) => normalizeSymbol(holding.symbol)))]
    .sort((a, b) => a.localeCompare(b));
}

function buildCorrelationCacheKey({
  holdings = [],
  totalValue = null,
  windows = DEFAULT_WINDOWS,
  primaryWindow = DEFAULT_PRIMARY_WINDOW,
} = {}) {
  const primary = Number(primaryWindow) || DEFAULT_PRIMARY_WINDOW;
  const cleanWindows = normalizeCorrelationWindows(windows, primary);
  return JSON.stringify({
    signature: buildCorrelationRequestSignature(holdings, totalValue),
    windows: cleanWindows,
    primaryWindow: primary,
  });
}

function resolveExpectedValueLabel(holding = {}) {
  const symbol = normalizeSymbol(holding.symbol);
  const direct = expectedValuesData.getExpectedValueForTicker(symbol);
  if (direct) {
    return {
      label: direct.name,
      anchorTicker: direct.ticker,
      ev: expectedValuesData.getExpectedValueQuadScores(direct),
      labelSource: 'expected-value',
    };
  }

  const haystack = [
    symbol,
    holding.description,
    holding.name,
    holding.assetClass,
    holding.assetType,
  ].filter(Boolean).join(' ');

  const fallback = FALLBACK_LABEL_RULES.find((rule) => rule.pattern.test(haystack));
  if (fallback) {
    const evAnchor = expectedValuesData.getExpectedValueForTicker(fallback.evTicker);
    return {
      label: fallback.label,
      anchorTicker: fallback.evTicker,
      ev: expectedValuesData.getExpectedValueQuadScores(evAnchor),
      labelSource: 'fallback-rule',
    };
  }

  return {
    label: String(holding.description || holding.name || holding.assetClass || symbol || 'Unlabeled'),
    anchorTicker: symbol,
    ev: null,
    labelSource: 'fallback',
  };
}

function calculateCorrelation(seriesA = [], seriesB = [], window = DEFAULT_PRIMARY_WINDOW) {
  const mapA = new Map(seriesA.map((row) => [row.date, row.value]));
  const aligned = [];
  for (const row of seriesB) {
    if (mapA.has(row.date)) {
      aligned.push([mapA.get(row.date), row.value]);
    }
  }

  const recent = aligned.slice(-window);
  const minObs = Math.max(10, Math.ceil(window * 0.45));
  if (recent.length < minObs) return { correlation: null, observations: recent.length };

  const meanA = recent.reduce((sum, row) => sum + row[0], 0) / recent.length;
  const meanB = recent.reduce((sum, row) => sum + row[1], 0) / recent.length;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (const [a, b] of recent) {
    const da = a - meanA;
    const db = b - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  if (varA <= 0 || varB <= 0) return { correlation: null, observations: recent.length };
  const correlation = Math.max(-1, Math.min(1, cov / Math.sqrt(varA * varB)));
  return { correlation, observations: recent.length };
}

function buildPosition(holding, totalValue) {
  const marketValue = parseNumber(holding.marketValue, 0);
  const quantity = parseNumber(holding.quantity, 0);
  const symbol = normalizeSymbol(holding.symbol);
  const absMarketValue = Math.abs(marketValue);
  const signedWeightPct = totalValue > 0 ? (marketValue / totalValue) * 100 : 0;
  const absWeightPct = Math.abs(signedWeightPct);
  const side = marketValue < 0 || quantity < 0 ? 'short' : 'long';
  const label = resolveExpectedValueLabel(holding);

  return {
    symbol,
    name: holding.description || holding.name || symbol,
    side,
    marketValue,
    absMarketValue,
    signedWeightPct,
    absWeightPct,
    quantity,
    ...label,
  };
}

function getPairKey(symbolA, symbolB) {
  return [symbolA, symbolB].sort().join('|');
}

function findPair(pairMap, symbolA, symbolB) {
  return pairMap.get(getPairKey(symbolA, symbolB)) || null;
}

function buildPairwise(positions, returnsBySymbol, windows) {
  const pairwise = [];
  const pairMap = new Map();
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const a = positions[i];
      const b = positions[j];
      const byWindow = {};
      let observations = 0;
      for (const window of windows) {
        const result = calculateCorrelation(returnsBySymbol[a.symbol], returnsBySymbol[b.symbol], window);
        byWindow[`${window}D`] = result.correlation == null ? null : round(result.correlation, 3);
        observations = Math.max(observations, result.observations);
      }
      const primaryWindowKey = `${windows.primaryWindow || DEFAULT_PRIMARY_WINDOW}D`;
      const primaryCorrelation = byWindow[primaryWindowKey] ?? null;
      const weightedImpact = primaryCorrelation == null
        ? 0
        : a.absWeightPct * b.absWeightPct * Math.max(primaryCorrelation, 0);
      const pair = {
        symbols: [a.symbol, b.symbol],
        labels: [a.label, b.label],
        correlation: primaryCorrelation,
        correlations: byWindow,
        observations,
        weightedImpact: round(weightedImpact, 2),
        sameSide: a.side === b.side,
      };
      pairwise.push(pair);
      pairMap.set(getPairKey(a.symbol, b.symbol), pair);
    }
  }
  return {
    pairwise: pairwise.sort((a, b) => Math.abs(b.weightedImpact) - Math.abs(a.weightedImpact)),
    pairMap,
  };
}

function getPositiveCorrelation(pairMap, symbolA, symbolB) {
  if (symbolA === symbolB) return 1;
  const pair = findPair(pairMap, symbolA, symbolB);
  if (!pair || pair.correlation == null) return 0;
  return Math.max(pair.correlation, 0);
}

function inheritCorrelatedLabels(positions, pairMap) {
  const directAnchors = positions.filter((position) => (
    position.labelSource === 'expected-value' ||
    position.labelSource === 'fallback-rule'
  ));

  return positions.map((position) => {
    if (position.labelSource !== 'fallback' || directAnchors.length === 0) return position;

    const bestAnchor = directAnchors.reduce((best, anchor) => {
      const pair = findPair(pairMap, position.symbol, anchor.symbol);
      const correlation = pair?.correlation;
      if (correlation == null || correlation < ANCHOR_CORRELATION_THRESHOLD) return best;
      if (!best || correlation > best.correlation) {
        return { anchor, correlation };
      }
      return best;
    }, null);

    if (!bestAnchor) return position;
    return {
      ...position,
      label: bestAnchor.anchor.label,
      anchorTicker: bestAnchor.anchor.anchorTicker,
      ev: bestAnchor.anchor.ev,
      labelSource: 'correlated-anchor',
      labelAnchorCorrelation: round(bestAnchor.correlation, 2),
    };
  });
}

function buildClusters(positions, pairMap, threshold = CLUSTER_CORRELATION_THRESHOLD) {
  const parent = new Map(positions.map((position) => [position.symbol, position.symbol]));
  const find = (symbol) => {
    const next = parent.get(symbol);
    if (next === symbol) return symbol;
    const root = find(next);
    parent.set(symbol, root);
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const pair of pairMap.values()) {
    if (pair.correlation != null && pair.correlation >= threshold) {
      union(pair.symbols[0], pair.symbols[1]);
    }
  }

  const groups = new Map();
  for (const position of positions) {
    const root = find(position.symbol);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(position);
  }

  return Array.from(groups.values()).map((members) => {
    const longPct = members
      .filter((member) => member.side === 'long')
      .reduce((sum, member) => sum + member.absWeightPct, 0);
    const shortPct = members
      .filter((member) => member.side === 'short')
      .reduce((sum, member) => sum + member.absWeightPct, 0);
    const grossClusterPct = longPct + shortPct;
    const netClusterPct = longPct - shortPct;

    let riskMass = 0;
    for (const a of members) {
      for (const b of members) {
        riskMass += a.absWeightPct * b.absWeightPct * getPositiveCorrelation(pairMap, a.symbol, b.symbol);
      }
    }

    const labelWeights = members.reduce((acc, member) => {
      acc[member.label] = (acc[member.label] || 0) + member.absWeightPct;
      return acc;
    }, {});
    const label = Object.entries(labelWeights).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unlabeled';
    const topDriver = [...members].sort((a, b) => b.absWeightPct - a.absWeightPct)[0] || null;

    const quadScores = ['q1', 'q2', 'q3', 'q4'].reduce((acc, quad) => {
      let weighted = 0;
      let weight = 0;
      for (const member of members) {
        const ev = member.ev?.[quad];
        if (Number.isFinite(ev)) {
          weighted += ev * member.absWeightPct;
          weight += member.absWeightPct;
        }
      }
      acc[quad] = weight > 0 ? round(weighted / weight, 2) : null;
      return acc;
    }, {});
    const bestQuad = Object.entries(quadScores)
      .filter(([, value]) => value != null)
      .sort((a, b) => b[1] - a[1])[0]?.[0]?.toUpperCase() || null;

    return {
      id: members.map((member) => member.symbol).sort().join('-'),
      label,
      memberCount: members.length,
      longPct: round(longPct),
      shortPct: round(shortPct),
      grossClusterPct: round(grossClusterPct),
      netClusterPct: round(netClusterPct),
      correlationAdjustedGrossPct: round(Math.sqrt(Math.max(riskMass, 0))),
      topDriver: topDriver ? topDriver.symbol : null,
      quadFit: {
        bestQuad,
        scores: quadScores,
      },
      members: members
        .sort((a, b) => b.absWeightPct - a.absWeightPct)
        .map((member) => ({
          symbol: member.symbol,
          name: member.name,
          side: member.side,
          weightPct: round(member.signedWeightPct, 2),
          absWeightPct: round(member.absWeightPct, 2),
          label: member.label,
          labelSource: member.labelSource,
          anchorTicker: member.anchorTicker,
          labelAnchorCorrelation: member.labelAnchorCorrelation ?? null,
        })),
    };
  }).sort((a, b) => b.correlationAdjustedGrossPct - a.correlationAdjustedGrossPct);
}

function calculateEffectiveBets(positions, pairMap) {
  const scoredGross = positions.reduce((sum, position) => sum + position.absWeightPct, 0);
  if (scoredGross <= 0) {
    return { adjustedHhi: 0, effectiveIndependentBets: null };
  }

  let adjustedHhi = 0;
  for (const a of positions) {
    for (const b of positions) {
      const weightA = a.absWeightPct / scoredGross;
      const weightB = b.absWeightPct / scoredGross;
      adjustedHhi += weightA * weightB * getPositiveCorrelation(pairMap, a.symbol, b.symbol);
    }
  }

  return {
    adjustedHhi,
    effectiveIndependentBets: adjustedHhi > 0 ? 1 / adjustedHhi : null,
  };
}

function computePortfolioCorrelationConcentration({
  holdings = [],
  totalValue = null,
  histories = {},
  windows = DEFAULT_WINDOWS,
  primaryWindow = DEFAULT_PRIMARY_WINDOW,
  asOf = new Date().toISOString(),
} = {}) {
  const cleanWindows = normalizeCorrelationWindows(windows, primaryWindow);
  cleanWindows.primaryWindow = primaryWindow;

  const nlv = parseNumber(totalValue, 0) || holdings.reduce((sum, holding) => sum + Math.abs(parseNumber(holding.marketValue, 0)), 0);
  const scorable = [];
  const unscored = [];
  let cashValue = 0;

  for (const holding of holdings) {
    const symbol = normalizeSymbol(holding.symbol);
    const marketValue = parseNumber(holding.marketValue, 0);
    const absMarketValue = Math.abs(marketValue);
    if (!symbol || absMarketValue === 0) continue;

    if (isCashHolding(holding)) {
      cashValue += absMarketValue;
      continue;
    }

    if (isOptionHolding(holding)) {
      unscored.push({
        symbol,
        reason: 'Options are unscored in v1',
        weightPct: nlv > 0 ? round((absMarketValue / nlv) * 100, 2) : 0,
      });
      continue;
    }

    scorable.push(buildPosition(holding, nlv));
  }

  const returnsBySymbol = {};
  const scoredPositions = [];
  for (const position of scorable) {
    const history = histories[position.symbol] || histories[position.symbol.toLowerCase()] || [];
    const returns = buildReturnsByDate(history);
    const minReturns = Math.max(10, Math.ceil(primaryWindow * 0.45));
    if (returns.length < minReturns) {
      unscored.push({
        symbol: position.symbol,
        reason: `Needs at least ${minReturns} daily returns for ${primaryWindow}D correlation`,
        weightPct: round(position.absWeightPct, 2),
      });
      continue;
    }
    returnsBySymbol[position.symbol] = returns;
    scoredPositions.push(position);
  }

  const grossPct = scorable.reduce((sum, position) => sum + position.absWeightPct, 0);
  const netPct = scorable.reduce((sum, position) => sum + position.signedWeightPct, 0);
  const scoredPct = holdings.length > 0 && nlv > 0
    ? (scoredPositions.reduce((sum, position) => sum + position.absMarketValue, 0) / nlv) * 100
    : 0;

  if (scoredPositions.length === 0) {
    return {
      asOf,
      windows: cleanWindows,
      primaryWindow,
      coverage: {
        scoredPct: 0,
        scoredCount: 0,
        unscoredCount: unscored.length,
        cashPct: nlv > 0 ? round((cashValue / nlv) * 100, 1) : 0,
      },
      scores: {
        concentrationScore: null,
        effectiveIndependentBets: null,
        largestClusterPct: 0,
        grossPct: round(grossPct),
        netPct: round(netPct),
      },
      clusters: [],
      pairwise: [],
      unscored,
    };
  }

  let { pairwise, pairMap } = buildPairwise(scoredPositions, returnsBySymbol, cleanWindows);
  const labeledPositions = inheritCorrelatedLabels(scoredPositions, pairMap);
  ({ pairwise, pairMap } = buildPairwise(labeledPositions, returnsBySymbol, cleanWindows));

  const clusters = buildClusters(labeledPositions, pairMap);
  const { adjustedHhi, effectiveIndependentBets } = calculateEffectiveBets(labeledPositions, pairMap);
  const largestClusterPct = clusters[0]?.grossClusterPct || 0;
  const concentrationScore = adjustedHhi > 0 ? Math.min(100, Math.round(adjustedHhi * 100)) : 0;

  return {
    asOf,
    windows: cleanWindows,
    primaryWindow,
    coverage: {
      scoredPct: round(scoredPct, 1),
      scoredCount: labeledPositions.length,
      unscoredCount: unscored.length,
      cashPct: nlv > 0 ? round((cashValue / nlv) * 100, 1) : 0,
    },
    scores: {
      concentrationScore,
      adjustedHhi: round(adjustedHhi, 4),
      effectiveIndependentBets: effectiveIndependentBets == null ? null : round(effectiveIndependentBets, 1),
      largestClusterPct: round(largestClusterPct, 1),
      grossPct: round(grossPct, 1),
      netPct: round(netPct, 1),
    },
    clusters,
    pairwise: pairwise.slice(0, 25),
    unscored,
  };
}

module.exports = {
  DEFAULT_WINDOWS,
  DEFAULT_PRIMARY_WINDOW,
  CLUSTER_CORRELATION_THRESHOLD,
  ANCHOR_CORRELATION_THRESHOLD,
  SIGNATURE_WEIGHT_BUCKET_PCT,
  buildReturnsByDate,
  buildCorrelationCacheKey,
  buildCorrelationRequestSignature,
  calculateCorrelation,
  computePortfolioCorrelationConcentration,
  getCorrelationScorableSymbols,
  getCorrelationScoringCandidates,
  isCashHolding,
  isOptionHolding,
  normalizeCorrelationWindows,
  resolveExpectedValueLabel,
};
