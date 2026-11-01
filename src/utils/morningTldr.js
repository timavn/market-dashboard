/*
 * Pure helpers for the dashboard's morning TL;DR.  The panel deliberately
 * keeps these transformations deterministic: it renders dated Hedgeye
 * publications and compares their published fields, rather than inventing a
 * new narrative or using live market quotes as a proxy for research.
 */

export const TLDR_PRODUCT_DEFINITIONS = [
  {
    id: 'top-3-things',
    label: 'Top 3 Things',
    description: '',
    cadence: 'event_driven',
  },
  {
    id: 'risk-ranges',
    label: 'Risk Ranges',
    description: '',
    cadence: 'market_day_0800',
  },
  {
    id: 'early-look',
    label: 'Early Look',
    description: '',
    cadence: 'event_driven',
  },
  {
    id: 'the-call',
    label: 'The Call',
    description: '',
    cadence: 'event_driven',
  },
  {
    id: 'the-macro-show',
    label: 'Macro Show',
    description: '',
    cadence: 'event_driven',
  },
  {
    id: 'signal-strength',
    label: 'Signal Strength',
    description: '',
    cadence: 'event_driven',
  },
  {
    id: 'signal-strength-shorts',
    label: 'Signal Strength Shorts',
    description: '',
    cadence: 'event_driven',
  },
  {
    id: 'market-structure',
    label: 'Market Structure',
    description: '',
    cadence: 'event_driven',
  },
];

const NEW_YORK_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const SECTION_ALIASES = [
  ['top 5 most actionable', 'Top 5 Most Actionable'],
  ['macro commentary', 'Macro Commentary'],
  ['sector summary', 'Sector Summary'],
  ['main summary', 'Main Summary'],
  ['key takeaways', 'Key Takeaways'],
  ['the big picture', 'The Big Picture'],
  ['macro grind', 'Macro Grind'],
  ['quad path', 'Quad Path'],
  ['our levels', 'Our Levels'],
  ['position changes and portfolio actions', 'Position Changes and Portfolio Actions'],
  ['hedgeye positions', 'Hedgeye Positions'],
];

export const asArray = (value) => (Array.isArray(value) ? value : []);

export const cleanText = (value) => String(value || '')
  .replace(/\r/g, '')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .replace(/[ \t]{2,}/g, ' ')
  .trim();

export const cleanPosition = (value) => cleanText(value)
  .replace(/\s*The summary and positions listed here reflect[\s\S]*$/i, '')
  .replace(/\s*Positions listed in order mentioned[\s\S]*$/i, '')
  .replace(/\s*CLICK HERE[\s\S]*$/i, '')
  .replace(/^\$([A-Z0-9.]+)\b/, '$1')
  .trim();

export const todayInNewYork = (date = new Date()) => {
  const values = NEW_YORK_DATE_FORMATTER.formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${values.year}-${values.month}-${values.day}`;
};

export const snapshotDate = (snapshot) => snapshot?.date || snapshot?.meta?.date || null;

export const snapshotLabel = (snapshot) => {
  const date = snapshotDate(snapshot);
  if (!date) return 'Date unavailable';
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const formatTimestamp = (value) => {
  if (!value) return 'Unavailable';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unavailable';
  return parsed.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

export const isCurrentSnapshot = (snapshot, now = new Date()) => (
  Boolean(snapshotDate(snapshot) && snapshotDate(snapshot) === todayInNewYork(now))
);

export const getPositionGroups = (snapshot) => {
  const data = snapshot?.data || {};
  const normalize = (side) => asArray(data[side])
    .map(cleanPosition)
    .filter((value) => value && !/^not of any strength$/i.test(value));
  return {
    longs: normalize('longs'),
    shorts: normalize('shorts'),
    neutrals: normalize('neutrals'),
  };
};

export const getTopThreeThings = (snapshot) => asArray(snapshot?.data?.items)
  .map((item, index) => {
    const value = item && typeof item === 'object' ? item : { body: item };
    const parsedRank = Number(value.rank);
    const rank = Number.isInteger(parsedRank) && parsedRank > 0 ? parsedRank : index + 1;
    return {
      rank,
      title: cleanText(value.title || value.label || `Thing ${rank}`),
      body: cleanText(value.body || value.summary || value.text),
    };
  })
  .filter((item) => item.title && item.body)
  .sort((left, right) => left.rank - right.rank)
  .slice(0, 3);

const sideForPosition = (groups, value) => (
  Object.entries(groups).find(([, positions]) => positions.includes(value))?.[0] || null
);

export const diffPositionGroups = (currentSnapshot, previousSnapshot) => {
  const current = getPositionGroups(currentSnapshot);
  const previous = getPositionGroups(previousSnapshot);
  const added = [];
  const removed = [];
  const moved = [];

  Object.entries(current).forEach(([side, values]) => {
    values.forEach((value) => {
      const oldSide = sideForPosition(previous, value);
      if (!oldSide) {
        added.push({ value, side });
      } else if (oldSide !== side) {
        moved.push({ value, from: oldSide, to: side });
      }
    });
  });

  Object.entries(previous).forEach(([side, values]) => {
    values.forEach((value) => {
      if (!sideForPosition(current, value)) removed.push({ value, side });
    });
  });

  return { current, previous, added, removed, moved };
};

export const getRiskRangeRows = (snapshot) => {
  const data = snapshot?.data;
  if (Array.isArray(data)) return data.filter(Boolean);
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data)
    .map(([ticker, row]) => ({ ticker, ...(row || {}) }))
    .filter((row) => row.ticker && (row.lrr != null || row.hrr != null || row.trend));
};

const numeric = (value) => {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const formatNumber = (value, maximumFractionDigits = 2) => {
  const parsed = numeric(value);
  if (parsed == null) return '—';
  return parsed.toLocaleString('en-US', { maximumFractionDigits });
};

const riskRowKey = (row) => String(row?.ticker || row?.symbol || row?.name || '').trim().toUpperCase();

export const compareRiskRanges = (currentSnapshot, previousSnapshot, changelog = {}) => {
  const currentRows = getRiskRangeRows(currentSnapshot);
  const previousRows = getRiskRangeRows(previousSnapshot);
  const previousByKey = new Map(previousRows.map((row) => [riskRowKey(row), row]));
  const trendChanges = new Map(asArray(changelog?.trendChanges).map((change) => [
    String(change?.ticker || change?.symbol || '').toUpperCase(),
    change,
  ]));

  const changes = currentRows.map((row) => {
    const key = riskRowKey(row);
    const previous = previousByKey.get(key);
    const currentLrr = numeric(row.lrr);
    const previousLrr = numeric(previous?.lrr);
    const currentHrr = numeric(row.hrr);
    const previousHrr = numeric(previous?.hrr);
    const lrrDelta = currentLrr != null && previousLrr != null ? currentLrr - previousLrr : null;
    const hrrDelta = currentHrr != null && previousHrr != null ? currentHrr - previousHrr : null;
    const midpoint = numeric(row.lrr) != null && numeric(row.hrr) != null
      ? (numeric(row.lrr) + numeric(row.hrr)) / 2
      : null;
    const previousMidpoint = previous && numeric(previous.lrr) != null && numeric(previous.hrr) != null
      ? (numeric(previous.lrr) + numeric(previous.hrr)) / 2
      : null;
    const midpointPct = midpoint != null && previousMidpoint
      ? ((midpoint - previousMidpoint) / Math.abs(previousMidpoint)) * 100
      : null;
    const trendChange = trendChanges.get(key) || null;
    const trendChanged = Boolean(trendChange) || Boolean(previous && row.trend && previous.trend && row.trend !== previous.trend);
    const boundsChanged = Boolean(
      previous
      && ((numeric(row.lrr) != null && numeric(previous.lrr) != null && numeric(row.lrr) !== numeric(previous.lrr))
        || (numeric(row.hrr) != null && numeric(previous.hrr) != null && numeric(row.hrr) !== numeric(previous.hrr))),
    );
    const added = !previous;
    return {
      ...row,
      key,
      previous,
      trendChange,
      trendChanged,
      boundsChanged,
      added,
      lrrDelta,
      hrrDelta,
      midpointPct,
      material: added || trendChanged || boundsChanged,
    };
  }).filter((row) => row.material);

  // OutBucket names may be published in the trend-change block without a
  // corresponding row in the regular range table. Keep those explicit flips
  // in the morning review instead of silently dropping them.
  const knownKeys = new Set(currentRows.map(riskRowKey));
  asArray(changelog?.trendChanges).forEach((change) => {
    const key = String(change?.ticker || change?.symbol || '').trim().toUpperCase();
    if (!key || knownKeys.has(key)) return;
    changes.push({
      ticker: key,
      key,
      trend: change.newTrend || null,
      trendChange: change,
      trendChanged: true,
      boundsChanged: false,
      added: false,
      previous: null,
      lrrDelta: null,
      hrrDelta: null,
      midpointPct: null,
      material: true,
    });
  });

  return changes.sort((left, right) => {
    if (Boolean(right.trendChanged) !== Boolean(left.trendChanged)) return right.trendChanged ? 1 : -1;
    if (Boolean(right.added) !== Boolean(left.added)) return right.added ? 1 : -1;
    return Math.abs(right.midpointPct || 0) - Math.abs(left.midpointPct || 0);
  });
};

const normalizedTrend = (value) => String(value || '').trim().toUpperCase();

export const buildRiskRangeComparison = (currentSnapshot, previousSnapshot, changelog = {}) => {
  const currentRows = getRiskRangeRows(currentSnapshot);
  const previousRows = getRiskRangeRows(previousSnapshot);
  const hasPrevious = Boolean(previousSnapshot && previousRows.length);
  const previousByKey = new Map(previousRows.map((row) => [riskRowKey(row), row]));
  const explicitTrendChanges = new Map(asArray(changelog?.trendChanges).map((change) => [
    String(change?.ticker || change?.symbol || '').trim().toUpperCase(),
    change,
  ]));

  const currentComparisonRows = currentRows.map((row) => {
    const key = riskRowKey(row);
    const previous = hasPrevious ? previousByKey.get(key) : null;
    const added = Boolean(hasPrevious && !previous);
    const explicitTrendChange = explicitTrendChanges.get(key) || null;
    const priorTrend = explicitTrendChange?.oldTrend || previous?.trend || null;
    const currentTrend = explicitTrendChange?.newTrend || row.trend || null;
    const trendChanged = Boolean(
      previous
      && priorTrend
      && currentTrend
      && normalizedTrend(priorTrend) !== normalizedTrend(currentTrend),
    );
    const currentLrr = numeric(row.lrr);
    const previousLrr = numeric(previous?.lrr);
    const currentHrr = numeric(row.hrr);
    const previousHrr = numeric(previous?.hrr);
    const lrrDelta = currentLrr != null && previousLrr != null ? currentLrr - previousLrr : null;
    const hrrDelta = currentHrr != null && previousHrr != null ? currentHrr - previousHrr : null;
    const boundsChanged = Boolean(
      previous
      && (currentLrr !== previousLrr || currentHrr !== previousHrr),
    );
    const state = !hasPrevious
      ? 'uncompared'
      : trendChanged
        ? 'trend-change'
        : added
          ? 'added'
          : 'current';
    return {
      ...row,
      key,
      state,
      previous,
      priorTrend,
      currentTrend,
      priorLrr: previous?.lrr ?? null,
      priorHrr: previous?.hrr ?? null,
      priorPrevClose: previous?.prevClose ?? null,
      lrrDelta,
      hrrDelta,
      trendChanged,
      boundsChanged,
      added,
      removed: false,
      changed: trendChanged || added || boundsChanged,
    };
  });

  const currentKeys = new Set(currentRows.map(riskRowKey));
  const removedRows = hasPrevious
    ? previousRows
      .filter((row) => !currentKeys.has(riskRowKey(row)))
      .map((row) => ({
        key: riskRowKey(row),
        state: 'removed',
        originalName: row.originalName,
        lrr: null,
        hrr: null,
        trend: null,
        previous: row,
        priorTrend: row.trend || null,
        currentTrend: null,
        priorLrr: row.lrr ?? null,
        priorHrr: row.hrr ?? null,
        priorPrevClose: row.prevClose ?? null,
        lrrDelta: null,
        hrrDelta: null,
        trendChanged: false,
        boundsChanged: false,
        added: false,
        removed: true,
        changed: true,
      }))
    : [];

  const trendRows = currentComparisonRows.filter((row) => row.state === 'trend-change');
  const addedRows = currentComparisonRows.filter((row) => row.state === 'added');
  const remainingRows = currentComparisonRows.filter((row) => row.state === 'current' || row.state === 'uncompared');
  const rows = [...trendRows, ...addedRows, ...remainingRows, ...removedRows];
  return {
    hasPrevious,
    rows,
    counts: {
      changed: currentComparisonRows.filter((row) => row.changed).length + removedRows.length,
      trendChanged: trendRows.length,
      added: addedRows.length,
      rangeChanged: currentComparisonRows.filter((row) => row.boundsChanged).length,
      unchanged: currentComparisonRows.filter((row) => row.state === 'current' && !row.changed).length,
      uncompared: currentComparisonRows.filter((row) => row.state === 'uncompared').length,
      removed: removedRows.length,
      totalRows: rows.length,
    },
  };
};

// Turn the raw risk-range diff into mutually understandable buckets for the
// reader. Removed rows only exist in the prior publication, while range and
// trend changes describe instruments present in both editions.
export const classifyRiskRangeChanges = (currentSnapshot, previousSnapshot, changelog = {}) => {
  const comparison = buildRiskRangeComparison(currentSnapshot, previousSnapshot, changelog);
  const added = comparison.rows.filter((row) => row.state === 'added');
  const removed = comparison.rows.filter((row) => row.state === 'removed');
  const rangeChanges = comparison.rows.filter((row) => !row.removed && row.boundsChanged);
  const trendChanges = comparison.rows.filter((row) => row.state === 'trend-change' && !row.boundsChanged);
  return {
    all: comparison.rows.filter((row) => row.changed),
    added,
    removed,
    rangeChanges,
    trendChanges,
  };
};

export const getSignalChanges = (snapshot, changelog = {}) => {
  const data = snapshot?.data || {};
  const added = asArray(data.added).length ? asArray(data.added) : asArray(changelog?.added);
  const removed = asArray(data.removed).length ? asArray(data.removed) : asArray(changelog?.removed);
  const stockCount = snapshot?.meta?.stockCount ?? data.stockCount ?? changelog?.stockCount ?? null;
  const stocks = asArray(data.stocks)
    .map((stock) => {
      const value = stock && typeof stock === 'object' ? stock : { ticker: stock };
      const ticker = cleanPosition(value.ticker || value.symbol || value.asset);
      if (!ticker) return null;
      const daysOn = value.daysOn ?? value.days_on ?? value.days;
      const percentChangeSinceSignal = value.percentChangeSinceSignal
        ?? value.percent_change_since_signal
        ?? value.percentSinceSignal
        ?? value.signalReturn
        ?? value.percentChange;
      // A short's published Total Return; a long's reading is the change since its signal.
      const totalReturn = value.totalReturn == null || value.totalReturn === '' || !Number.isFinite(Number(value.totalReturn))
        ? null
        : Number(value.totalReturn);
      return {
        ticker,
        ...(totalReturn == null ? {} : { totalReturn }),
        daysOn: daysOn == null || daysOn === '' || !Number.isFinite(Number(daysOn)) ? null : Number(daysOn),
        percentChangeSinceSignal: percentChangeSinceSignal == null
          || percentChangeSinceSignal === ''
          || !Number.isFinite(Number(percentChangeSinceSignal))
          ? null
          : Number(percentChangeSinceSignal),
      };
    })
    .filter(Boolean);
  // The HTML email exposes only explicit additions/removals. A full table is
  // usable only when the stored row count matches the publication's count (or
  // the source explicitly marks the membership as complete); never pad it
  // with prior editions, watchlists, or dashboard securities.
  const normalizedStockCount = stockCount == null || stockCount === '' ? null : Number(stockCount);
  const membershipComplete = data.membershipComplete === true
    || snapshot?.meta?.membershipComplete === true
    || (Number.isFinite(normalizedStockCount) && normalizedStockCount > 0 && stocks.length === normalizedStockCount);
  return {
    added: added.map(cleanPosition).filter(Boolean),
    removed: removed.map(cleanPosition).filter(Boolean),
    stockCount,
    stocks,
    membershipComplete,
  };
};

const headingFromLine = (line) => {
  const normalized = cleanText(line).replace(/[•:]+$/g, '').trim();
  if (!normalized || normalized.length > 80) return null;
  const lower = normalized.toLowerCase();
  const matched = SECTION_ALIASES.find(([alias]) => lower === alias || lower.startsWith(`${alias} `));
  return matched ? matched[1] : null;
};

export const extractBodySections = (bodyText) => {
  const lines = cleanText(bodyText).split('\n').map((line) => line.trim()).filter(Boolean);
  const sections = [];
  let current = null;
  lines.forEach((line) => {
    const heading = headingFromLine(line);
    if (heading) {
      if (current && current.body.length) sections.push({ ...current, body: cleanText(current.body.join('\n')) });
      current = { title: heading, body: [] };
      return;
    }
    if (current) current.body.push(line);
  });
  if (current && current.body.length) sections.push({ ...current, body: cleanText(current.body.join('\n')) });
  return sections.filter((section) => section.body);
};

export const articleSections = (snapshot) => {
  const article = snapshot?.article || {};
  const parsed = Object.entries(article.sections || {})
    .map(([title, body]) => ({ title: cleanText(title), body: cleanText(body) }))
    .filter((section) => section.title && section.body);
  if (parsed.length) return parsed;
  return extractBodySections(article.bodyText);
};

export const articleTakeaways = (snapshot) => {
  const values = asArray(snapshot?.article?.keyTakeaways);
  if (values.length) return values.map(cleanText).filter(Boolean);
  const section = articleSections(snapshot).find((item) => item.title.toLowerCase() === 'key takeaways');
  if (!section) return [];
  return section.body
    .split(/\n|•|(?<=\.)\s+(?=[A-Z])/)
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 6);
};

export const getSourceStatus = (snapshot, { loading = false, error = null, now = new Date() } = {}) => {
  if (loading) return { label: 'Loading', tone: 'neutral', current: false };
  if (error && !snapshot) return { label: 'Unavailable', tone: 'error', current: false };
  if (!snapshot) return { label: 'Awaiting edition', tone: 'warning', current: false };
  if (snapshot?._cache?.stale) return { label: 'Stale reference', tone: 'warning', current: false };
  if (isCurrentSnapshot(snapshot, now)) return { label: 'Current', tone: 'fresh', current: true };
  return { label: 'Older reference', tone: 'warning', current: false };
};

export const countChanges = (productId, snapshot, previousSnapshot, changelog = {}) => {
  if (productId === 'risk-ranges') return buildRiskRangeComparison(snapshot, previousSnapshot, changelog).counts.changed;
  if (productId === 'signal-strength' || productId === 'signal-strength-shorts') {
    const changes = getSignalChanges(snapshot, changelog);
    return changes.added.length + changes.removed.length;
  }
  if (productId === 'the-call' || productId === 'the-macro-show') {
    const diff = diffPositionGroups(snapshot, previousSnapshot);
    return diff.added.length + diff.removed.length + diff.moved.length;
  }
  return asArray(changelog?.trendChanges).length;
};
