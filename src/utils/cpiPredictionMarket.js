import {
  evNoPerContract,
  evYesPerContract,
  fractionalKellySizing,
  grossEdgeNo,
  grossEdgeYes,
  netEdge,
} from './predictionMarketsCalc';

export const CPI_SCENARIO_PROBABILITY = 1 / 3;

const DEFAULT_CPI_SETTINGS = {
  portfolioEquity: null,
  maxRiskPerBet: 500,
  maxOpenRisk: 10000,
  kellyMultiplier: 0.25,
  minNetEdge: 0.02,
  defaultFeePerContract: 0.02,
  defaultSlippageBuffer: 0.005,
  modelErrorBuffer: 0.01,
  missingLiquidityCap: 25,
  visibleVolumeParticipation: 0.05,
};

const DEFAULT_CPI_STRIKE_INCREMENT = 0.1;
const DEFAULT_CPI_STRIKE_PADDING = 2;

function toNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,%\s,]/g, '');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePercentValue(value) {
  const n = toNumber(value);
  if (n == null) return null;
  if (Math.abs(n) > 0 && Math.abs(n) <= 0.05) return n * 100;
  return n;
}

function normalizeTextToken(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9.]+/g, ' ');
}

const CPI_MONTH_CODES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function normalizeCpiYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year)) return null;
  if (year >= 0 && year <= 99) return 2000 + year;
  return year >= 2000 && year <= 2099 ? year : null;
}

function toCpiMonthId(yearValue, monthCode) {
  const year = normalizeCpiYear(yearValue);
  const month = CPI_MONTH_CODES.indexOf(String(monthCode || '').slice(0, 3).toUpperCase());
  if (year == null || month < 0) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * Normalize CPI report/event month labels and KX ticker month codes to YYYY-MM.
 * Settlement dates are deliberately not accepted because CPI contracts commonly
 * settle in the month after the report month.
 */
export function normalizeCpiMonthId(value) {
  if (value && typeof value === 'object' && value.id) {
    return normalizeCpiMonthId(value.id);
  }

  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;

  const iso = text.match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (iso) return `${iso[1]}-${iso[2]}`;

  const ticker = text.match(/(?:^|[-_\s])(\d{2}|20\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:[-_\s]|$)/);
  if (ticker) return toCpiMonthId(ticker[1], ticker[2]);

  const monthThenYear = text.match(/\b(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\b\D{0,6}(\d{2}|20\d{2})\b/);
  if (monthThenYear) return toCpiMonthId(monthThenYear[2], monthThenYear[1]);

  const yearThenMonth = text.match(/\b(\d{2}|20\d{2})\b\D{0,6}(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\b/);
  if (yearThenMonth) return toCpiMonthId(yearThenMonth[1], yearThenMonth[2]);

  return null;
}

function cpiMonthIdentityValues(value = {}) {
  const raw = value?.raw && value.raw !== value ? value.raw : {};
  return [
    value.forecastMonth,
    value.forecast_month,
    value.reportMonth,
    value.report_month,
    value.releaseMonth,
    value.release_month,
    value.sourceMonth,
    value.source_month,
    value.eventMonth,
    value.event_month,
    value.releaseCode,
    value.release_code,
    value.event_ticker,
    value.eventTicker,
    value.api_raw_symbol,
    value.localSymbol,
    value.event_title,
    value.eventTitle,
    value.contract_title,
    value.contractTitle,
    value.question,
    value.description,
    value.ticker,
    value.symbol,
    raw.forecastMonth,
    raw.reportMonth,
    raw.releaseMonth,
    raw.sourceMonth,
    raw.eventMonth,
    raw.releaseCode,
    raw.event_ticker,
    raw.eventTicker,
    raw.api_raw_symbol,
    raw.localSymbol,
    raw.event_title,
    raw.eventTitle,
    raw.contract_title,
    raw.contractTitle,
    raw.question,
    raw.description,
    raw.ticker,
    raw.symbol,
  ];
}

export function getCpiContractMonthIds(value = {}) {
  return [...new Set(cpiMonthIdentityValues(value).map(normalizeCpiMonthId).filter(Boolean))];
}

export function getCpiContractMonthId(value = {}) {
  const monthIds = getCpiContractMonthIds(value);
  return monthIds.length === 1 ? monthIds[0] : null;
}

export function isCpiContractForMonth(value = {}, activeMonth = null) {
  const targetMonthId = normalizeCpiMonthId(activeMonth);
  if (!targetMonthId) return false;
  const monthIds = getCpiContractMonthIds(value);
  return monthIds.length === 1 && monthIds[0] === targetMonthId;
}

function cpiSearchText(value = {}) {
  return [
    value.category,
    value.underlying,
    value.event_title,
    value.contract_title,
    value.question,
    value.api_raw_symbol,
    value.symbol,
    value.description,
    value.localSymbol,
    value.tradingClass,
    value.assetClass,
    value.secType,
  ].filter(Boolean).join(' ');
}

function hasCpiToken(value = {}) {
  const text = normalizeTextToken(cpiSearchText(value));
  return (
    /\bKXCPI[A-Z0-9]*\b/.test(text) ||
    /\bCPI(?:Y|YOY|M|MOM|MM)?\b/.test(text) ||
    /\bCPIM\b/.test(text) ||
    /\bCPIYOY\b/.test(text) ||
    /\bCONSUMER PRICE INDEX\b/.test(text) ||
    /\bINFLATION\b/.test(text)
  );
}

function normalizeScenario(scenario, index) {
  const value = normalizePercentValue(
    scenario?.percent ?? scenario?.m_m ?? scenario?.mom ?? scenario?.forecast ?? scenario?.raw ?? scenario?.value,
  );
  if (value == null) return null;
  const fallback = index === 0 ? 'Upside' : index === 1 ? 'Base Case' : 'Downside';
  return {
    key: scenario?.key || fallback.toLowerCase().replace(/\s+/g, '-'),
    label: scenario?.label || scenario?.name || fallback,
    value,
  };
}

function getNowcastData(snapshot) {
  return snapshot?.data || snapshot || {};
}

function extractScenarioList(data) {
  if (Array.isArray(data?.scenarios)) return data.scenarios;
  const candidates = [
    { key: 'upside', label: 'Upside', value: data?.upside ?? data?.upsideMom ?? data?.upsideM_m },
    { key: 'base', label: 'Base Case', value: data?.base ?? data?.baseCase ?? data?.baseMom ?? data?.baseM_m },
    { key: 'downside', label: 'Downside', value: data?.downside ?? data?.downsideMom ?? data?.downsideM_m },
  ];
  return candidates;
}

export function normalizeCpiNowcast(snapshot) {
  if (!snapshot) {
    return {
      ok: false,
      reason: 'missing_snapshot',
      message: 'No inflation nowcast snapshot is available.',
      model: null,
    };
  }

  const data = getNowcastData(snapshot);
  const metric = data.metric || data.measure || data.title || data.heading || '';
  const metricText = String(metric);
  const isMom = /\bM\/M\b|\bMoM\b|month[\s-]*over[\s-]*month|monthly/i.test(metricText);
  const isYoy = /\bY\/Y\b|\bYoY\b|year[\s-]*over[\s-]*year|yearly/i.test(metricText);

  if (!isMom && !isYoy) {
    return {
      ok: false,
      reason: 'native_cpi_required',
      message: 'Latest Hedgeye nowcast is not a native Headline CPI nowcast, so sizing is disabled.',
      model: null,
      sourceMetric: metricText || null,
    };
  }

  const scenarios = extractScenarioList(data)
    .map(normalizeScenario)
    .filter(Boolean)
    .slice(0, 3);

  if (scenarios.length !== 3) {
    return {
      ok: false,
      reason: 'missing_scenarios',
      message: 'Need Upside, Base Case, and Downside M/M values before sizing CPI contracts.',
      model: null,
      sourceMetric: metricText || null,
    };
  }

  return {
    ok: true,
    reason: null,
    message: null,
    model: {
      metric: isYoy ? 'Headline CPI YoY' : 'Headline CPI M/M',
      forecastMonth: data.forecastMonth || data.month || data.period || snapshot.forecastMonth || 'CPI release',
      publishedText: data.publishedText || data.publishedAt || snapshot.publishedAt || snapshot.scrapedAt || null,
      releaseDate: data.releaseDate?.date || data.releaseDate || data.release_date || snapshot.releaseDate || null,
      outlook: data.outlook || data.summary || null,
      scenarios,
    },
    sourceMetric: metricText || (isYoy ? 'Headline CPI YoY' : 'Headline CPI M/M'),
  };
}

export function extractCpiAboveThreshold(event) {
  const text = [
    event?.contract_title,
    event?.question,
    event?.event_title,
    event?.api_raw_symbol,
    event?.symbol,
    event?.description,
    event?.localSymbol,
  ].filter(Boolean).join(' ');
  const match = text.match(/\babove\s+(-?\d+(?:\.\d+)?)\s*%?/i);
  if (match) return normalizePercentValue(match[1]);

  const tokenMatch = text.match(/(?:^|[-_\s])T(-?\d+(?:\.\d+)?)(?:[-_\s]?(?:YES|NO)\b|$)/i);
  if (tokenMatch) return normalizePercentValue(tokenMatch[1]);

  return null;
}

export function isIbkrTradableCpiEvent(event) {
  const venue = String(event?.venue || '').toLowerCase();
  const status = String(event?.status || '').toLowerCase();
  const source = String(event?.source_api || '');
  const flags = new Set([...(event?.data_quality_flags || []), ...(event?.flags || [])]);
  const rejectedFlags = [
    'cached', 'expired_contract', 'fallback', 'mock', 'no_live_quote',
    'portfolio_discovered', 'portfolio_seed', 'stale_quote',
    'unknown_contract_side', 'wrong_release',
  ];
  if (
    event?.heldPosition ||
    source === 'IBKR_PORTFOLIO' ||
    rejectedFlags.some((flag) => flags.has(flag)) ||
    (status && !['open', 'active'].includes(status))
  ) return false;
  const liveKalshiCpi = (
    venue === 'kalshi' &&
    source === 'kalshi_trade_api_v2' &&
    ['open', 'active'].includes(status || 'open')
  );
  const nativeIbkrCpi = Boolean(
    event?.tradable_in_ibkr === true &&
    ['IBKR_TWS_API', 'IBKR_CPAPI'].includes(source) &&
    ['forecastex', 'cme', 'ibkr'].includes(venue),
  );
  return (nativeIbkrCpi || liveKalshiCpi) && hasCpiToken(event) && extractCpiAboveThreshold(event) != null;
}

function getPrice(event, side) {
  const askKey = side === 'YES' ? 'yes_ask' : 'no_ask';
  const ask = toNumber(event?.[askKey]);
  if (ask != null && ask > 0 && ask < 1) return { price: ask, source: 'ask', executable: true };
  return { price: null, source: null, executable: false };
}

function getDepth(event, side) {
  const keys = side === 'YES'
    ? ['yes_ask_size', 'yesAskSize', 'ask_size', 'askSize', 'available_size']
    : ['no_ask_size', 'noAskSize', 'ask_size', 'askSize', 'available_size'];
  for (const key of keys) {
    const n = toNumber(event?.[key]);
    if (n != null && n > 0) return Math.floor(n);
  }
  return null;
}

function getLiquidityCap(event, side, settings) {
  const depth = getDepth(event, side);
  if (depth != null) return { cap: depth, source: 'depth', warning: null };

  const visible = toNumber(event?.volume) ?? toNumber(event?.total_volume) ?? toNumber(event?.open_interest) ?? toNumber(event?.liquidity);
  if (visible != null && visible > 0) {
    return {
      cap: Math.max(1, Math.floor(visible * (settings.visibleVolumeParticipation ?? DEFAULT_CPI_SETTINGS.visibleVolumeParticipation))),
      source: 'visible_volume',
      warning: 'Size capped by visible volume; live depth unavailable.',
    };
  }

  return {
    cap: settings.missingLiquidityCap ?? DEFAULT_CPI_SETTINGS.missingLiquidityCap,
    source: 'missing',
    warning: 'Live liquidity unavailable; conservative default size cap applied.',
  };
}

function scenarioProbabilityAbove(scenarios, threshold) {
  if (!Array.isArray(scenarios) || scenarios.length === 0 || threshold == null) return null;
  const wins = scenarios.filter((scenario) => Number(scenario.value) > Number(threshold)).length;
  return wins / scenarios.length;
}

function strikeScale(increment = DEFAULT_CPI_STRIKE_INCREMENT) {
  const n = Number(increment);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.round(1 / n);
}

function strikeTick(value, increment = DEFAULT_CPI_STRIKE_INCREMENT) {
  const n = normalizePercentValue(value);
  if (n == null) return null;
  return Math.round(n * strikeScale(increment));
}

function tickToStrike(tick, increment = DEFAULT_CPI_STRIKE_INCREMENT) {
  const scale = strikeScale(increment);
  return Number((tick / scale).toFixed(4));
}

function rowStrikeTick(row, increment = DEFAULT_CPI_STRIKE_INCREMENT) {
  return strikeTick(row?.threshold, increment);
}

function isHeldCpiRow(row = {}) {
  const event = row.event || {};
  return Boolean(
    event.heldPosition ||
    event.source_api === 'IBKR_PORTFOLIO' ||
    (event.data_quality_flags || []).includes('open_position'),
  );
}

function getHeldQuantity(event = {}) {
  const direct = toNumber(event.heldQuantity);
  if (direct != null) return direct;
  const raw = event.heldPosition || {};
  return toNumber(raw.quantity ?? raw.position) ?? 0;
}

function getHeldCostBasis(event = {}, quantity = 0) {
  const direct = toNumber(event.heldCostBasis);
  if (direct != null) return Math.abs(direct);
  const raw = event.heldPosition || {};
  const rawCost = toNumber(raw.costBasis);
  if (rawCost != null) return Math.abs(rawCost);
  const avgPrice = toNumber(event.heldAvgPrice ?? raw.avgPrice ?? raw.avgCost);
  return avgPrice != null ? Math.abs(quantity) * avgPrice : null;
}

function getHeldSide(event = {}) {
  const side = event.heldContractSide || inferContractSide(event.heldPosition || event);
  return side ? String(side).toUpperCase() : null;
}

function createMissingCpiStrikeRow(threshold, cpiModel = null) {
  const scenarios = cpiModel?.scenarios || [];
  const modelYesProbability = scenarioProbabilityAbove(scenarios, threshold);
  const modelNoProbability = modelYesProbability == null ? null : 1 - modelYesProbability;
  return {
    id: `target-cpi-strike-${Number(threshold).toFixed(1)}`,
    event: {
      category: 'Inflation',
      underlying: cpiModel?.metric || 'CPI',
      event_title: cpiModel?.forecastMonth || 'CPI target strike',
      contract_title: `Target CPI ${Number(threshold).toFixed(1)}%`,
      question: `Target CPI strike ${Number(threshold).toFixed(1)}%`,
      data_quality_flags: ['target_strike_missing_contract'],
    },
    title: `Target CPI ${Number(threshold).toFixed(1)}%`,
    venue: 'IBKR',
    threshold,
    modelYesProbability,
    modelNoProbability,
    yesPrice: null,
    yesPriceSource: null,
    noPrice: null,
    noPriceSource: null,
    recommendedSide: modelYesProbability != null && modelYesProbability < 0.5 ? 'NO' : 'YES',
    recommendedPrice: null,
    priceSource: null,
    executable: false,
    netEdge: null,
    evPerContract: 0,
    payoutMultiplier: 1,
    liquidityCap: 0,
    liquiditySource: 'missing_contract',
    rawSuggestedContracts: 0,
    suggestedContracts: 0,
    riskPerContract: 0,
    estimatedCost: 0,
    expectedValue: 0,
    maxProfit: 0,
    missingContract: true,
    warnings: ['No IBKR contract found for this target strike.'],
  };
}

export function deriveCpiTargetStrikes(cpiModelOrScenarios = null, options = {}) {
  const increment = options.increment ?? DEFAULT_CPI_STRIKE_INCREMENT;
  const padding = Number.isFinite(Number(options.padding))
    ? Math.max(0, Math.floor(Number(options.padding)))
    : DEFAULT_CPI_STRIKE_PADDING;
  const scenarios = Array.isArray(cpiModelOrScenarios)
    ? cpiModelOrScenarios
    : cpiModelOrScenarios?.scenarios || [];
  const ticks = scenarios
    .map((scenario) => strikeTick(scenario?.value ?? scenario, increment))
    .filter((tick) => tick != null && Number.isFinite(tick));

  if (ticks.length === 0) return [];

  const minTick = Math.min(...ticks) - padding;
  const maxTick = Math.max(...ticks) + padding;
  const strikeTicks = [];
  for (let tick = minTick; tick <= maxTick; tick += 1) {
    strikeTicks.push(tick);
  }
  return [...new Set(strikeTicks)].map((tick) => tickToStrike(tick, increment));
}

function eventTitle(event) {
  return event?.contract_title || event?.question || event?.event_title || event?.api_raw_symbol || 'CPI contract';
}

function eventKey(event) {
  return event?.id || event?.api_raw_id || event?.conid || event?.conId || eventTitle(event);
}

export function buildCpiContractLadder(events = [], cpiModel = null, rawSettings = {}, activeCpiMonth = null) {
  const settings = { ...DEFAULT_CPI_SETTINGS, ...(rawSettings || {}) };
  const scenarios = cpiModel?.scenarios || [];
  const totalCap = Math.max(0, Math.min(settings.maxRiskPerBet ?? 0, settings.maxOpenRisk ?? Infinity));

  const candidates = (events || [])
    .filter(isIbkrTradableCpiEvent)
    .filter((event) => !activeCpiMonth || isCpiContractForMonth(event, activeCpiMonth))
    .map((event) => {
      const threshold = extractCpiAboveThreshold(event);
      const heldRow = Boolean(
        event.heldPosition ||
        event.source_api === 'IBKR_PORTFOLIO' ||
        (event.data_quality_flags || []).includes('open_position'),
      );
      const modelYesProbability = scenarioProbabilityAbove(scenarios, threshold);
      const modelNoProbability = modelYesProbability == null ? null : 1 - modelYesProbability;
      const yesQuote = getPrice(event, 'YES');
      const noQuote = getPrice(event, 'NO');
      const payoutMultiplier = toNumber(event?.max_payout_per_contract ?? event?.payoutMultiplier) || 1;
      const heldQuantity = getHeldQuantity(event);
      const openContracts = Math.abs(heldQuantity || 0);
      const openSide = openContracts > 0 ? getHeldSide(event) : null;
      const heldCostBasis = getHeldCostBasis(event, heldQuantity);
      const openRiskPerContract = openContracts > 0
        ? (heldCostBasis != null && openContracts > 0
            ? heldCostBasis / openContracts
            : openSide === 'NO'
              ? noQuote.price
              : openSide === 'YES'
                ? yesQuote.price
                : null)
        : null;
      const openEstimatedCost = openContracts > 0 && openRiskPerContract != null
        ? openContracts * openRiskPerContract * payoutMultiplier
        : 0;
      const openMaxProfit = openContracts > 0 && openRiskPerContract != null
        ? openContracts * Math.max(0, payoutMultiplier - (openRiskPerContract * payoutMultiplier))
        : 0;
      const fees = settings.defaultFeePerContract ?? 0;
      const slippage = settings.defaultSlippageBuffer ?? 0;
      const modelError = settings.modelErrorBuffer ?? 0;
      const yesNetEdge = modelYesProbability == null || yesQuote.price == null
        ? null
        : netEdge(grossEdgeYes(modelYesProbability, yesQuote.price), fees, slippage, modelError);
      const noNetEdge = modelYesProbability == null || noQuote.price == null
        ? null
        : netEdge(grossEdgeNo(modelYesProbability, noQuote.price), fees, slippage, modelError);
      const hasYesEdge = Number.isFinite(yesNetEdge);
      const hasNoEdge = Number.isFinite(noNetEdge);
      const recommendedSide = !hasYesEdge && !hasNoEdge
        ? null
        : hasYesEdge && (!hasNoEdge || yesNetEdge >= noNetEdge) ? 'YES' : 'NO';
      const recommendedQuote = recommendedSide === 'YES'
        ? yesQuote
        : recommendedSide === 'NO' ? noQuote : { price: null, source: null, executable: false };
      const modelProbability = recommendedSide === 'YES'
        ? modelYesProbability
        : recommendedSide === 'NO' ? modelNoProbability : null;
      const netEdgeValue = recommendedSide === 'YES'
        ? yesNetEdge
        : recommendedSide === 'NO' ? noNetEdge : null;
      const liquidity = recommendedSide
        ? getLiquidityCap(event, recommendedSide, settings)
        : { cap: 0, warning: null };
      const evPerContract = modelProbability == null || recommendedQuote.price == null
        ? 0
        : recommendedSide === 'YES'
          ? evYesPerContract(modelProbability, recommendedQuote.price, payoutMultiplier)
          : evNoPerContract(modelYesProbability, recommendedQuote.price, payoutMultiplier);
      const livePortfolioEquity = Number(settings.portfolioEquity);
      const rawContracts = modelProbability != null
        && recommendedQuote.price != null
        && Number.isFinite(livePortfolioEquity)
        && livePortfolioEquity > 0
        ? fractionalKellySizing(
            modelProbability,
            recommendedQuote.price,
            settings.kellyMultiplier,
            livePortfolioEquity,
            settings.maxRiskPerBet,
            payoutMultiplier,
          )
        : 0;
      const priceRisk = (recommendedQuote.price || 0) * payoutMultiplier;
      const positiveEdge = !heldRow && netEdgeValue != null && netEdgeValue >= (settings.minNetEdge ?? 0);
      const cappedByLiquidity = Math.min(rawContracts, liquidity.cap);
      const warnings = [
        ...(recommendedQuote.executable ? [] : ['No executable ask available from IBKR.']),
        ...(liquidity.warning ? [liquidity.warning] : []),
        ...(positiveEdge ? [] : [heldRow ? 'Open position only; not sized as a new recommendation.' : 'No positive net edge after buffers.']),
      ];

      return {
        id: eventKey(event),
        event,
        title: eventTitle(event),
        venue: event?.venue || 'IBKR',
        threshold,
        modelYesProbability,
        modelNoProbability,
        yesPrice: yesQuote.price,
        yesPriceSource: yesQuote.source,
        noPrice: noQuote.price,
        noPriceSource: noQuote.source,
        recommendedSide,
        recommendedPrice: recommendedQuote.price,
        priceSource: recommendedQuote.source,
        executable: recommendedQuote.executable,
        netEdge: netEdgeValue,
        evPerContract,
        payoutMultiplier,
        liquidityCap: liquidity.cap,
        liquiditySource: liquidity.source,
        rawSuggestedContracts: positiveEdge ? rawContracts : 0,
        suggestedContracts: positiveEdge ? cappedByLiquidity : 0,
        riskPerContract: priceRisk,
        estimatedCost: positiveEdge ? cappedByLiquidity * priceRisk : 0,
        expectedValue: positiveEdge ? cappedByLiquidity * evPerContract : 0,
        maxProfit: positiveEdge ? cappedByLiquidity * (payoutMultiplier - priceRisk) : 0,
        openContracts,
        openSide,
        openRiskPerContract: openRiskPerContract != null ? openRiskPerContract * payoutMultiplier : 0,
        openEstimatedCost,
        openMaxProfit,
        isOpenPosition: openContracts > 0,
        warnings,
      };
    })
    .sort((a, b) => a.threshold - b.threshold);

  const ranked = [...candidates].sort((a, b) => (b.netEdge ?? -Infinity) - (a.netEdge ?? -Infinity));
  let remainingRisk = totalCap;
  const allocated = new Map();
  for (const row of ranked) {
    if (!row.suggestedContracts || !row.riskPerContract || remainingRisk <= 0) {
      allocated.set(row.id, 0);
      continue;
    }
    const totalCapContracts = Math.floor(remainingRisk / row.riskPerContract);
    const finalContracts = Math.max(0, Math.min(row.suggestedContracts, totalCapContracts));
    allocated.set(row.id, finalContracts);
    remainingRisk -= finalContracts * row.riskPerContract;
  }

  const allocatedCandidates = candidates.map((row) => {
    const contracts = allocated.get(row.id) ?? 0;
    return {
      ...row,
      suggestedContracts: contracts,
      estimatedCost: contracts * row.riskPerContract,
      expectedValue: contracts * row.evPerContract,
      maxProfit: contracts * (row.payoutMultiplier - row.riskPerContract),
      warnings: [
        ...row.warnings,
        ...(row.rawSuggestedContracts > contracts ? ['Release risk cap reduced suggested size.'] : []),
      ],
    };
  });

  const targetStrikes = deriveCpiTargetStrikes(cpiModel);
  if (targetStrikes.length === 0) return allocatedCandidates;

  const targetTicks = new Set(targetStrikes.map((strike) => strikeTick(strike)));
  const candidatesByTick = new Map();
  for (const row of allocatedCandidates) {
    const tick = rowStrikeTick(row);
    if (tick == null) continue;
    if (!candidatesByTick.has(tick)) candidatesByTick.set(tick, []);
    candidatesByTick.get(tick).push(row);
  }

  const usedRows = new Set();
  const targetRows = targetStrikes.flatMap((strike) => {
    const tick = strikeTick(strike);
    const matched = tick == null ? [] : candidatesByTick.get(tick) || [];
    if (matched.length === 0) return [createMissingCpiStrikeRow(strike, cpiModel)];
    matched.forEach((row) => usedRows.add(row.id));
    return matched;
  });

  const heldOutsideTargetRows = allocatedCandidates.filter((row) => {
    if (usedRows.has(row.id)) return false;
    const tick = rowStrikeTick(row);
    if (tick != null && targetTicks.has(tick)) return false;
    return isHeldCpiRow(row);
  });

  return [...targetRows, ...heldOutsideTargetRows]
    .sort((a, b) => a.threshold - b.threshold || String(a.id).localeCompare(String(b.id)));
}

export function isCpiPredictionPosition(position = {}) {
  return Number(position.quantity || 0) !== 0 && hasCpiToken(position);
}

function deriveAveragePrice(position, quantity) {
  const direct = toNumber(
    position.averageCost ??
    position.avgCost ??
    position.averagePrice ??
    position.avgPrice,
  );
  if (direct != null) {
    if (direct > 1 && Math.abs(quantity) > 0) return direct / Math.abs(quantity);
    return direct;
  }

  const costBasis = toNumber(position.costBasis);
  if (costBasis != null && Math.abs(quantity) > 0) {
    return Math.abs(costBasis / quantity);
  }

  return null;
}

function deriveLastPrice(position, quantity) {
  const direct = toNumber(position.price ?? position.lastPrice ?? position.marketPrice ?? position.mark);
  if (direct != null) return direct;

  const marketValue = toNumber(position.marketValue);
  if (marketValue != null && Math.abs(quantity) > 0) {
    return Math.abs(marketValue / quantity);
  }

  return null;
}

export function summarizeCpiPositions(positions = [], activeCpiMonth = null) {
  return (positions || [])
    .filter(isCpiPredictionPosition)
    .filter((position) => !activeCpiMonth || isCpiContractForMonth(position, activeCpiMonth))
    .map((position) => {
      const quantity = Number(position.quantity || 0);
      const lastPrice = deriveLastPrice(position, quantity);
      const avgPrice = deriveAveragePrice(position, quantity);
      const marketValue = toNumber(position.marketValue);
      const costBasis = toNumber(position.costBasis) ?? (avgPrice != null ? Math.abs(quantity) * avgPrice : null);
      const currentValue = marketValue != null
        ? marketValue
        : lastPrice != null
          ? Math.abs(quantity) * lastPrice
          : null;
      const unrealizedPnl = toNumber(position.unrealizedPnl ?? position.unrealizedPnL ?? position.unrealizedPNL ?? position.gainLoss) ??
        (currentValue != null && costBasis != null ? currentValue - costBasis : null);
      const side = quantity >= 0 ? 'LONG' : 'SHORT';
      const riskPrice = avgPrice ?? lastPrice;
      const maxLoss = riskPrice != null ? Math.abs(quantity) * riskPrice : null;
      const maxProfit = riskPrice != null ? Math.abs(quantity) * (1 - riskPrice) : null;
      const contractSide = inferContractSide(position);

      return {
        id: position.positionId || position.conid || position.symbol || position.description,
        title: position.description || position.localSymbol || position.symbol || 'CPI position',
        symbol: position.symbol,
        conid: position.conid ?? position.conId ?? null,
        accountId: position.accountId,
        side,
        quantity,
        avgPrice,
        lastPrice,
        currentValue,
        maxLoss,
        maxProfit,
        unrealizedPnl,
        contractSide,
        costBasis,
        raw: position,
      };
    });
}

function inferContractSide(position = {}) {
  const text = cpiSearchText(position);
  const match = text.match(/(?:^|[-_\s])(YES|NO)(?:$|[-_\s])/i);
  return match ? match[1].toUpperCase() : null;
}

export function buildCpiEventsFromPositions(positions = [], activeCpiMonth = null) {
  return summarizeCpiPositions(positions, activeCpiMonth)
    .map((position) => {
      const raw = position.raw || {};
      const threshold = extractCpiAboveThreshold(raw) ?? extractCpiAboveThreshold(position);
      if (threshold == null) return null;

      const contractSide = inferContractSide(raw);
      return {
        id: `held-${position.id}`,
        venue: 'IBKR',
        source_api: 'IBKR_PORTFOLIO',
        tradable_in_ibkr: false,
        category: 'Inflation',
        underlying: raw.symbol || position.symbol || 'CPI',
        event_title: raw.symbol || position.symbol || 'IBKR CPI position',
        contract_title: position.title,
        question: position.title,
        description: position.title,
        conid: position.conid,
        heldQuantity: position.quantity,
        heldAvgPrice: position.avgPrice,
        heldLastPrice: position.lastPrice,
        heldCostBasis: position.costBasis,
        heldMaxLoss: position.maxLoss,
        heldMaxProfit: position.maxProfit,
        heldContractSide: contractSide,
        price_source: 'position_exposure_only',
        data_quality_flags: ['open_position', 'catalog_missing', 'portfolio_derived', 'no_live_quote'],
        heldPosition: raw,
        updated_at: raw.lastUpdated || raw.updated_at || null,
      };
    })
    .filter(Boolean);
}
