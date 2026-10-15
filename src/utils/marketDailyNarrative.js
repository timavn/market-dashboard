import catalog from '../constants/marketRotationCatalog.json';
import { validateMarketDailySnapshot } from '../hooks/useMarketDailySnapshot';
import { validateMarketRotationSnapshot } from '../hooks/useMarketRotationSnapshot';

const EMPTY = '—';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => Number.isInteger(value) && value >= 0 ? value.toLocaleString('en-US') : EMPTY;
const share = value => finite(value) && value >= 0 && value <= 100 ? `${value.toFixed(0)}%` : EMPTY;
const signed = (value, unit = '%') => finite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)}${unit === '%' ? '%' : ` ${unit}`}` : EMPTY;
const tone = value => !finite(value) || value === 0 ? 'neutral' : value > 0 ? 'positive' : 'negative';
const safeUrl = value => typeof value === 'string' && /^https:\/\//.test(value) ? value : null;
const distinct = values => [...new Set(values.filter(Boolean))];
const inlineName = value => /^[A-Z](?:[&.]|[A-Z])/.test(value) ? value : value.charAt(0).toLowerCase() + value.slice(1);
const comparable = (left, right, maxSkewMs = 20 * 60_000) => left && right
  && /^\d{4}-\d{2}-\d{2}$/.test(left.marketDate || '') && left.marketDate === right.marketDate
  && left.status === right.status && Math.abs(Date.parse(left.asOf) - Date.parse(right.asOf)) <= maxSkewMs;
const BAD_FLAGS = ['stale', 'isStale', 'mock', 'isMock', 'seed', 'seeded', 'synthetic', 'inferred', 'fromCache', 'cacheOnly', 'cache_only', 'offline', 'disconnected', 'fallback', 'portfolioDerived', 'portfolio_derived'];
const BAD_STATE = /(?:^|[\s_-])(?:unavailable|offline|disconnected|failed|stale|expired|mock|seed|seeded|synthetic|inferred|cache|cached|fallback|error)(?:$|[\s_-])/i;
const rejected = value => value && typeof value === 'object' && (
  BAD_FLAGS.some(key => value[key] === true) || value.connected === false || value.available === false
  || ['status', 'freshness', 'availability', 'source', 'provider', 'dataType'].some(key => BAD_STATE.test(String(value[key] || '')))
  || Object.values(value).some(child => child && typeof child === 'object' && rejected(child))
);

export function formatMarketDailyTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(value));
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/New_York',
  }).formatToParts(Date.parse(value));
  const part = key => parts.find(item => item.type === key)?.value || '';
  return `${part('month')} ${part('day')} ${part('hour')}:${part('minute')} ET`;
}

const sourcesFor = row => [
  safeUrl(row?.sourceUrl) ? { label: row.source || 'Source', url: row.sourceUrl } : null,
  safeUrl(row?.issuerUrl) ? { label: `${row.ticker} issuer`, url: row.issuerUrl } : null,
].filter(Boolean);
const uniqueSources = sources => [...new Map(sources.map(source => [source.url, source])).values()];
const quoteStatus = row => ['live', 'delayed', 'last-close'].includes(row?.status) ? row.status : row?.quoteStatus;
const provenance = row => row ? [
  row.retained || ['delayed', 'last-close'].includes(quoteStatus(row)) ? 'DELAYED' : String(quoteStatus(row) || '').toUpperCase(),
  formatMarketDailyTime(row.asOf), row.delayedSource || (row.proxy === true && row.status === 'last-close') ? 'DELAYED SOURCE' : '', row.source,
].filter(Boolean).join(' · ') : 'UNAVAILABLE';
const verifiedRow = (row, now) => row && typeof row.ticker === 'string' && row.ticker.trim()
  && typeof row.source === 'string' && row.source.trim() && safeUrl(row.sourceUrl)
  && ['live', 'delayed', 'last-close'].includes(row.status)
  && Number.isFinite(Date.parse(row.asOf)) && Date.parse(row.asOf) <= now
  && (row.retained || !row.expiresAt || Date.parse(row.expiresAt) > now) && !rejected(row) ? row : null;

const metric = (id, label, value, evidence, detail = '', extras = {}) => ({
  id, label, value, tone: 'neutral',
  detail: [detail, evidence?.detail, provenance(evidence)].filter(Boolean).join('\n'),
  sources: sourcesFor(evidence), asOf: evidence?.asOf || null,
  marketDate: evidence?.marketDate || null, retained: evidence?.retained === true, status: quoteStatus(evidence) || 'unavailable', ...extras,
});
const quotedMetric = (id, label, row, field = 'changePercent', unit = '%', detail = '') => metric(
  id, label, signed(row?.[field], unit), row, detail,
  { ticker: row?.ticker || '', name: row?.name || '', tone: tone(row?.[field]), changePercent: finite(row?.changePercent) ? row.changePercent : null },
);
const GROUP_DESCRIPTIONS = {
  participation: 'The advance–decline balance and median return distinguish broad participation from a move concentrated in the largest weights.',
  trend: 'Moving-average participation describes each trend horizon; new highs and lows show where longer-term extremes are forming. Each measure uses its disclosed eligible history.',
  sectors: 'The strongest and weakest sector ETFs show where leadership is concentrated across the 11-sector comparison.',
  contribution: 'SPY weight multiplied by daily return estimates each security’s fund impact, which can differ from its rank by percentage move.',
  technology: 'Software and semiconductor ETFs show whether these two technology exposures are participating together.',
  rotation: 'Leading and lagging themes compare the complete tracked ETF roster; overlapping holdings can connect their returns.',
  style: 'Growth versus value and momentum versus the broad market distinguish two dimensions of style leadership.',
  'risk-size': 'High beta versus low volatility and small caps versus large caps compare risk sensitivity and company size.',
  winners: 'Up to five of the largest percentage gains show the strongest constituents, independently of their SPY weights.',
  losers: 'Up to five of the largest percentage declines show the weakest constituents, independently of their SPY weights.',
  'relative-volume': 'Volume at least twice its usual pace, compared at the same elapsed session time. Ranked by relative volume.',
  'unusual-gains': 'Positive returns exceeding each security’s prior 40 comparable session readings, ranked by gain.',
  reversals: 'Opening gaps that crossed the prior close, with at least 0.5% on each side. Ranked by the size of the reversal.',
  'against-sector': 'Stocks moving at least 1% against a sector ETF moving at least 0.25%. Ranked by the stock–sector return gap.',
};
const group = (id, title, rows, narrative) => ({
  id, title, rows, narrative, description: GROUP_DESCRIPTIONS[id] || '',
  tickers: distinct(rows.flatMap(row => row.tickers || [row.ticker])),
});
const pairParts = (left, right, formatter = signed, leftTone = tone(left), rightTone = tone(right), separator = ' / ') => [
  { text: formatter(left), tone: formatter(left) === EMPTY ? 'neutral' : leftTone },
  { text: separator, tone: 'neutral' },
  { text: formatter(right), tone: formatter(right) === EMPTY ? 'neutral' : rightTone },
];
const pairMetric = (id, label, left, right, evidence, detail, formatter = signed, leftTone, rightTone, separator) => {
  const valueParts = pairParts(left, right, formatter, leftTone, rightTone, separator);
  return metric(id, label, valueParts.map(part => part.text).join(''), evidence, detail, { valueParts });
};
const historyCoverage = (label, eligible, total) => `${label}: ${count(eligible)} / ${count(total)} holdings with complete history. A partial reading uses only eligible holdings.`;
const securityGroup = (id, title, rows, narrative, valueLabel = 'Day') => ({ ...group(id, title, rows, narrative), layout: 'securities', valueLabel });
const rankedDailyRows = (rows, fallback, now, limit) => {
  const candidates = Array.isArray(rows) ? rows.slice(0, limit) : fallback;
  return (candidates.length ? candidates : [null]).map(row => {
    const verified = verifiedRow(row, now);
    return verified && finite(verified.changePercent) ? verified : null;
  });
};

function breadthGroups(snapshot) {
  const breadth = snapshot?.breadth || {};
  const observation = key => snapshot?.referenceObservations?.[key] || snapshot;
  const breadthEvidence = observation('breadth');
  const coverage = breadthEvidence?.coverage || {};
  const history = key => observation(key)?.coverage || {};
  const historyTotal = key => observation(key)?.universe?.count || total;
  const total = coverage.total || breadthEvidence?.universe?.count;
  const complete = Number.isInteger(total) && total > 0 && coverage.quotes === total;
  const advances = complete ? breadth.advancing : null;
  const declines = complete ? breadth.declining : null;
  const median = complete ? breadth.medianReturn : null;
  const largeMovesValid = complete && Number.isInteger(breadth.upOnePercent) && Number.isInteger(breadth.downOnePercent)
    && breadth.upOnePercent >= 0 && breadth.downOnePercent >= 0
    && breadth.upOnePercent <= advances && breadth.downOnePercent <= declines;
  const quartilesValid = complete && finite(breadth.lowerQuartileReturn) && finite(breadth.upperQuartileReturn)
    && finite(median) && breadth.lowerQuartileReturn <= median && breadth.upperQuartileReturn >= median;
  const countsValid = count(advances) !== EMPTY && count(declines) !== EMPTY;
  const participation = countsValid && finite(median) ? (
    advances > declines && median > 0 ? 'Advancers outnumber decliners and the median constituent is higher. Participation extends beyond the largest index weights.'
      : advances < declines && median < 0 ? 'Decliners outnumber advancers and the median constituent is lower. Weakness extends beyond the largest index weights.'
        : 'Participation is mixed: the advance–decline balance and the median return do not establish a broad directional majority.'
  ) : '';
  const averagesValid = share(breadth.above50Pct) !== EMPTY && share(breadth.above200Pct) !== EMPTY;
  const sameHistory = history('above50').history50 > 0 && history('above50').history50 === history('above200').history200;
  const sameHistoryDate = observation('above50')?.marketDate === observation('above200')?.marketDate;
  const technical = averagesValid && sameHistoryDate ? (
    breadth.above50Pct > 50 && breadth.above200Pct > 50 ? 'A majority of the eligible constituents are above each moving average, supporting participation across both trend horizons.'
      : breadth.above50Pct < 50 && breadth.above200Pct < 50 ? 'A majority of the eligible constituents are below each moving average, showing weakness across both trend horizons.'
        : !sameHistory ? 'The two horizons use different eligible histories, so their percentages describe separate groups of constituents.'
          : breadth.above50Pct > breadth.above200Pct ? 'More constituents are above their 50-day than their 200-day average: shorter-term participation is stronger than the longer-term base.'
            : breadth.above50Pct < breadth.above200Pct ? 'Fewer constituents are above their 50-day than their 200-day average: shorter-term participation is weaker than the longer-term base.'
              : 'The two moving-average measures show an evenly divided eligible universe.'
  ) : '';
  return [
    group('participation', 'Participation', [
      pairMetric('advances', 'Advancing / declining', advances, declines, breadthEvidence,
        `${count(coverage.quotes)} / ${count(total)} verified constituents. Unchanged: ${complete ? count(breadth.unchanged) : EMPTY}.`, count, 'positive', 'negative'),
      pairMetric('large-moves', 'Up ≥1% / down ≥1%', largeMovesValid ? breadth.upOnePercent : null, largeMovesValid ? breadth.downOnePercent : null, breadthEvidence,
        'Constituents gaining at least 1% or losing at least 1% versus their prior regular-session close. Requires the complete universe.', count, 'positive', 'negative'),
      metric('median', 'Median constituent return', signed(median), breadthEvidence, 'Equal weight across the complete verified constituent universe.', { tone: tone(median) }),
      pairMetric('return-range', 'Middle 50% of returns', quartilesValid ? breadth.lowerQuartileReturn : null, quartilesValid ? breadth.upperQuartileReturn : null, breadthEvidence,
        '25th to 75th percentiles of the complete constituent return distribution, using linear interpolation between ranked observations.', signed, undefined, undefined, ' to '),
    ], participation),
    group('trend', 'Trend confirmation', [
      metric('average-50', 'Above 50D average', share(breadth.above50Pct), observation('above50'), historyCoverage('50D', history('above50').history50, historyTotal('above50'))),
      metric('average-200', 'Above 200D average', share(breadth.above200Pct), observation('above200'), historyCoverage('200D', history('above200').history200, historyTotal('above200'))),
      pairMetric('extremes', 'New 52-week highs / lows', breadth.newHighs, breadth.newLows, observation('highLow'),
        historyCoverage('52-week', history('highLow').year, historyTotal('highLow')), count, 'positive', 'negative'),
    ], technical),
  ].map(item => ({ ...item, tickers: snapshot ? ['SPY'] : [] }));
}

function leadershipGroups(snapshot, now) {
  const leaders = snapshot?.leadership || {};
  const details = snapshot?.leadershipDetails || {};
  const leadingRows = rankedDailyRows(details.leadingSectors, [leaders.leadingSector], now, 2);
  const laggingRows = rankedDailyRows(details.laggingSectors, [leaders.laggingSector], now, 2);
  const lifts = rankedDailyRows(details.lifts, [leaders.lift], now, 2).map(row => row?.contributionPp > 0 ? row : null);
  const drags = rankedDailyRows(details.drags, [leaders.drag], now, 2).map(row => row?.contributionPp < 0 ? row : null);
  const [leading] = leadingRows;
  const [lagging] = laggingRows;
  const [lift] = lifts;
  const [drag] = drags;
  const comparableSectors = comparable(leading, lagging) && finite(leading.changePercent) && finite(lagging.changePercent);
  const comparableContributions = comparable(lift, drag) && finite(lift.contributionPp) && finite(drag.contributionPp);
  const participation = details.sectorParticipation;
  const sectorBreadth = comparableSectors && participation?.total === 11
    && ['advancing', 'declining', 'unchanged'].every(key => Number.isInteger(participation[key]) && participation[key] >= 0)
    && participation.advancing + participation.declining + participation.unchanged === 11
    ? `${participation.advancing} of 11 sectors are higher and ${participation.declining} are lower. ` : '';
  return [
    securityGroup('sectors', 'Sector leadership', [
      ...leadingRows.map((row, index) => quotedMetric(`leading-sector-${index}`, `Strongest sector ${index + 1}`, row)),
      ...laggingRows.map((row, index) => quotedMetric(`lagging-sector-${index}`, `Weakest sector ${index + 1}`, row)),
    ], comparableSectors ? `${sectorBreadth}${(leading.changePercent - lagging.changePercent).toFixed(2)} percentage points separate the leading and lagging sector ETFs.` : ''),
    securityGroup('contribution', 'Index impact', [
      ...lifts.map((row, index) => quotedMetric(`lift-${index}`, `SPY lift ${index + 1}`, row, 'contributionPp', 'pp', 'Published SPY weight × daily security return; estimated fund contribution.')),
      ...drags.map((row, index) => quotedMetric(`drag-${index}`, `SPY drag ${index + 1}`, row, 'contributionPp', 'pp', 'Published SPY weight × daily security return; estimated fund contribution.')),
    ], comparableContributions ? `${lift.ticker}'s lift ${Math.abs(lift.contributionPp) > Math.abs(drag.contributionPp) ? 'outweighs' : Math.abs(lift.contributionPp) < Math.abs(drag.contributionPp) ? 'is smaller than' : 'matches'} ${drag.ticker}'s drag. SPY holdings weights determine this impact.` : '', 'SPY impact'),
  ];
}

function themeGroups(snapshot) {
  const { software, semiconductors, leader, laggard } = snapshot?.themes || {};
  const technology = comparable(software, semiconductors) ? (
    software.changePercent > 0 && semiconductors.changePercent > 0 ? 'Software and semiconductors are both higher, showing participation across these two technology exposures.'
      : software.changePercent < 0 && semiconductors.changePercent < 0 ? 'Software and semiconductors are both lower, showing weakness across these two technology exposures.'
        : 'Software and semiconductor returns are mixed, so these technology exposures are not moving together.'
  ) : '';
  const ranked = snapshot?.themes?.ranked || [];
  const otherThemes = ranked.filter(row => ![software?.ticker, semiconductors?.ticker].includes(row.ticker));
  const broaderRows = otherThemes.length >= 4 ? [
    ...otherThemes.slice(0, 2).map((row, index) => quotedMetric(`leading-theme-${index}`, `Strongest other theme ${index + 1}`, row)),
    ...otherThemes.slice(-2).reverse().map((row, index) => quotedMetric(`lagging-theme-${index}`, `Weakest other theme ${index + 1}`, row)),
  ] : [quotedMetric('leading-theme', 'Leading theme', leader), quotedMetric('lagging-theme', 'Lagging theme', laggard)];
  const themeBreadth = ranked.length === catalog.themes.length ? `${ranked.filter(row => row.changePercent > 0).length} of ${ranked.length} themes are higher. ` : '';
  return [
    securityGroup('technology', 'Technology participation', [
      quotedMetric('software', 'Software', software),
      quotedMetric('semiconductors', 'Semiconductors', semiconductors),
    ], technology),
    securityGroup('rotation', 'Broader rotation', broaderRows,
      leader && laggard ? `${themeBreadth}${leader.name} ETF leads ${inlineName(laggard.name)} by ${(leader.changePercent - laggard.changePercent).toFixed(2)} percentage points across the complete ${catalog.themes.length}-ETF roster.${leader.changePercent < 0 ? ' Even the leading theme is lower on the day.' : ''}` : ''),
  ];
}

function factorGroups(snapshot) {
  const rows = catalog.factors.map(definition => {
    const pair = snapshot?.factors?.find(item => item.id === definition.id);
    const valid = finite(pair?.spreadPp);
    return metric(definition.id, definition.label, signed(pair?.spreadPp, 'pp'), valid ? pair : null,
      `${definition.left} minus ${definition.right}.\n${pair?.left ? `${pair.left.ticker}: ${signed(pair.left.changePercent)} · ${provenance(pair.left)}` : `${definition.left}: UNAVAILABLE`}\n${pair?.right ? `${pair.right.ticker}: ${signed(pair.right.changePercent)} · ${provenance(pair.right)}` : `${definition.right}: UNAVAILABLE`}`,
      { tone: tone(pair?.spreadPp), ticker: `${definition.left} / ${definition.right}`,
        tickers: valid ? [pair.left.ticker, pair.right.ticker] : [],
        legs: [pair?.left, pair?.right].map((leg, index) => ({
          ticker: leg?.ticker || definition[index === 0 ? 'left' : 'right'], name: leg?.name,
          value: signed(leg?.changePercent), tone: tone(leg?.changePercent), changePercent: leg?.changePercent,
          detail: provenance(leg),
        })), sources: uniqueSources([...sourcesFor(pair?.left), ...sourcesFor(pair?.right)]) });
  });
  const explain = id => {
    const pair = snapshot?.factors?.find(item => item.id === id);
    if (!finite(pair?.spreadPp)) return '';
    return pair.spreadPp === 0 ? `${pair.left.name} and ${inlineName(pair.right.name)} have equal returns`
      : `${pair.spreadPp > 0 ? pair.left.name : pair.right.name} is outperforming ${inlineName(pair.spreadPp > 0 ? pair.right.name : pair.left.name)}`;
  };
  const narration = (ids, explainUnits = false) => {
    const sentences = ids.map(explain).filter(Boolean);
    return sentences.length ? `${sentences.join('. ')}.${explainUnits ? ' The spreads compare daily ETF returns, with each leg measured from its prior close.' : ''}` : '';
  };
  return [
    group('style', 'Style leadership', rows.slice(0, 2), narration(['growth-value', 'momentum-market'], true)),
    group('risk-size', 'Risk and size', rows.slice(2), narration(['high-beta-low-vol', 'small-large'])),
  ].map(item => ({ ...item, layout: 'comparison' }));
}

function moverGroups(snapshot, now) {
  return [['winners', 'Winners'], ['losers', 'Losers']].map(([key, title]) => {
    const expanded = snapshot?.moverDetails?.[key];
    const available = rankedDailyRows(expanded, snapshot?.[key] || [], now, 5)
      .map(row => row && (key === 'winners' ? row.changePercent > 0 : row.changePercent < 0) ? row : null);
    const slots = Array.isArray(expanded) ? available.length : 3;
    const rows = Array.from({ length: slots }, (_, index) => quotedMetric(`${key}-${index}`, `${index + 1}`, available[index]));
    const last = available.at(-1);
    const range = available.length > 1 && available.every(row => comparable(row, available[0]))
      ? ` The displayed ${key === 'winners' ? 'gains' : 'declines'} range from ${signed(available[0].changePercent)} to ${signed(last.changePercent)}.` : '';
    return securityGroup(key, title, rows, available[0]
      ? `${available[0].ticker} has the ${key === 'winners' ? 'largest gain' : 'largest decline'} in the verified SPY constituent universe.${range} These ranks measure percentage moves; SPY impact also depends on holdings weights.` : '', key === 'winners' ? 'Gain' : 'Decline');
  });
}

function outlierGroups(snapshot, now) {
  const candidates = (key, qualifies) => {
    // Older verified responses can still supply their single headline reading.
    // An explicitly empty expanded list must never revive that headline.
    const list = snapshot?.outlierDetails?.[key];
    const rows = Array.isArray(list) ? list : [snapshot?.outliers?.[key]];
    const seen = new Set();
    return rows.slice(0, 3).map(row => verifiedRow(row, now)).filter(row => {
      if (!row || !qualifies(row) || seen.has(row.ticker)) return false;
      seen.add(row.ticker);
      return true;
    });
  };
  const volume = candidates('relativeVolume', row => finite(row.ratio) && row.ratio >= 2);
  const unusual = candidates('unusualGain', row => row.sessions === 40 && finite(row.changePercent) && row.changePercent > 0);
  const reversal = candidates('reversal', row => finite(row.gapPercent) && finite(row.changePercent)
    && Math.abs(row.gapPercent) >= 0.5 && Math.abs(row.changePercent) >= 0.5 && row.gapPercent * row.changePercent < 0);
  const against = candidates('againstSector', row => finite(row.changePercent) && finite(row.sectorChangePercent)
    && Math.abs(row.changePercent) >= 1 && Math.abs(row.sectorChangePercent) >= 0.25 && row.changePercent * row.sectorChangePercent < 0);
  const names = rows => new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' }).format(rows.map(row => row.ticker));
  const volumeDirections = [[row => row.changePercent > 0, 'rose'], [row => row.changePercent < 0, 'fell'], [row => row.changePercent === 0, 'were unchanged']]
    .map(([matches, verb]) => {
      const rows = volume.filter(row => finite(row.changePercent) && matches(row));
      return rows.length ? `${names(rows)} ${verb === 'were unchanged' && rows.length === 1 ? 'was unchanged' : verb}` : '';
    }).filter(Boolean).join('; ');
  const populated = rows => rows.length ? rows : [null];
  const outlierGroup = (id, title, rows, narrative, valueLabel) => ({ ...group(id, title, rows, narrative), valueLabel });
  return [
    outlierGroup('relative-volume', 'Same-time relative volume', populated(volume).map((row, index) =>
      metric(`volume-${index}`, 'Same-time relative volume', row ? `${row.ratio.toFixed(1)}× usual` : EMPTY, row,
        `Cumulative regular-session volume versus 20 prior sessions at the same elapsed time.${row?.cutoff ? ` Comparison through ${formatMarketDailyTime(row.cutoff)}.` : ''}`,
        { ticker: row?.ticker, name: row?.name, changePercent: row?.changePercent })),
    volume.length ? `${names(volume)} recorded at least twice the usual volume at the same point in the session.${volumeDirections ? ` ${volumeDirections}.` : ''}` : '', 'Relative volume'),
    outlierGroup('unusual-gains', 'Largest gains in 40 sessions', populated(unusual).map((row, index) =>
      quotedMetric(`unusual-gain-${index}`, 'Largest gain in 40 sessions', row, 'changePercent', '%',
        `Daily return versus 40 preceding sessions at the same session time.${row?.cutoff ? ` Comparison through ${formatMarketDailyTime(row.cutoff)}.` : ''}`)),
    unusual.length ? `${names(unusual)} ${unusual.length === 1 ? 'has a gain exceeding its' : 'each have a gain exceeding their'} prior 40 comparable session readings, showing unusual strength relative to recent daily returns.` : '', 'Gain'),
    outlierGroup('reversals', 'Open → now reversals', populated(reversal).map((row, index) => ({
      ...pairMetric(`reversal-${index}`, 'Open → now', row?.gapPercent, row?.changePercent, row,
        'Opening gap and latest return both use the prior regular-session close as their baseline.', signed, undefined, undefined, ' → '),
      ticker: row?.ticker, name: row?.name, changePercent: row?.changePercent,
    })), reversal.length ? `${names(reversal)} ${reversal.length === 1 ? 'has' : 'have'} crossed the prior close since the open. The opening move has reversed; both readings use the prior close as their baseline.` : '', 'Open → now'),
    outlierGroup('against-sector', 'Against their sectors', populated(against).map((row, index) => ({
      ...pairMetric(`against-sector-${index}`, 'Against its sector', row?.changePercent, row?.sectorChangePercent, row,
        `${row?.sectorName || 'Sector ETF'} comparison from the same observation session.`, signed, undefined, undefined, ' / '),
      ticker: row?.ticker, name: row?.name, changePercent: row?.changePercent,
    })), against.length ? `${against.map(row => `${row.ticker} is moving opposite ${row.sectorName || 'its sector ETF'}`).join('; ')}. These moves diverge from their sector backdrop.` : '', 'Stock / sector'),
  ];
}

const SECTIONS = {
  breadth: { title: 'MARKET BREADTH', build: breadthGroups },
  leadership: { title: 'LEADERSHIP', build: leadershipGroups },
  themes: { title: 'THEMES · ETF PROXIES', build: themeGroups, rotation: true },
  factors: { title: 'FACTORS · ETF SPREADS', build: factorGroups, rotation: true },
  movers: { title: 'WINNERS & LOSERS', build: moverGroups },
  outliers: { title: 'OUTLIERS', build: outlierGroups },
};

export function buildMarketDailyDetail(section, dailySnapshot, rotationSnapshot, now = Date.now()) {
  const definition = SECTIONS[section];
  if (!definition) return null;
  const candidate = !rejected(dailySnapshot) ? validateMarketDailySnapshot(dailySnapshot, now) : null;
  const dailyQuotes = [...(candidate?.winners || []), ...(candidate?.losers || []),
    ...Object.values(candidate?.leadership || {}), ...Object.values(candidate?.outliers || {}),
    ...Object.values(candidate?.outlierDetails || {}).flat(),
    ...Object.values(candidate?.leadershipDetails || {}).filter(Array.isArray).flat(),
    ...Object.values(candidate?.moverDetails || {}).flat()]
    .map(row => verifiedRow(row, now)).filter(Boolean);
  const dailyDates = distinct(dailyQuotes.map(row => row.marketDate));
  const dailyStatuses = distinct(dailyQuotes.map(row => row.status));
  const daily = candidate ? { ...candidate,
    marketDate: dailyDates.length === 1 ? dailyDates[0] : null,
    quoteStatus: dailyStatuses.length === 1 ? dailyStatuses[0] : dailyStatuses.length > 1 ? 'delayed' : null,
    delayedSource: dailyQuotes.some(row => row.delayedSource === true),
  } : null;
  const rotation = validateMarketRotationSnapshot(rotationSnapshot, now, true);
  const snapshot = definition.rotation ? rotation : daily;
  const groups = definition.build(snapshot, now);
  const rows = groups.flatMap(item => item.rows);
  const dates = distinct(rows.map(row => row.marketDate));
  const statuses = distinct(rows.filter(row => row.value !== EMPTY).map(row => row.status));
  const status = !snapshot ? 'UNAVAILABLE' : !rows.some(row => row.retained) && !snapshot.retained && statuses.length === 1 && statuses[0] === 'live' ? 'LIVE' : 'DELAYED';
  return {
    id: section, title: definition.title,
    subtitle: definition.rotation ? '' : snapshot?.universe?.label || 'S&P 500 · SPY',
    groups, asOf: rows.map(row => row.asOf).filter(Boolean).sort()[0] || snapshot?.asOf || null, marketDate: dates.length === 1 ? dates[0] : null,
    tickers: distinct(groups.flatMap(item => item.tickers)),
    sources: uniqueSources([...sourcesFor(snapshot), ...rows.flatMap(row => row.sources)]),
    status,
    methodology: definition.rotation
      ? section === 'themes' ? `Theme ranks require all ${catalog.themes.length} comparable ETF observations. ETF exposures may overlap. Roster: ${catalog.themes.map(row => `${row.name} (${row.ticker})`).join(', ')}.`
        : 'First ETF return minus second ETF return, in percentage points. Public ETF comparisons are not isolated factor returns or proprietary baskets.'
      : `SPY equity holdings proxy for the S&P 500; ${count(snapshot?.coverage?.quotes)} / ${count(snapshot?.coverage?.total || snapshot?.universe?.count)} verified observations. Holdings ${formatMarketDailyTime(snapshot?.universe?.asOf) || EMPTY}.${section === 'outliers' ? ' Up to three qualifying readings per category; a security can qualify in more than one category. Rankings use each category’s verified coverage.' : ''}`,
  };
}
