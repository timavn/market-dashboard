import { QUAD_PLAYBOOK } from '../constants/quadExposureCatalog';

const CLASS_ORDER = ['Equity', 'Fixed income', 'Commodity', 'Currency', 'Alternative'];
export const UNLABELLED = 'Unlabelled';

// Where each label sits in Hedgeye's quad playbook. A label with no entry
// (a hedge, a single foreign market) has no published view and shows a dash.
const CLASS_PLAYBOOK = { Equity: 'Equities', 'Fixed income': 'Fixed Income', Commodity: 'Commodities', Currency: 'FX' };
const SECTOR_PLAYBOOK = { Technology: 'Tech', 'Real Estate': 'REITS' };
const playbookEntry = (assetClass, group, region) => {
  if (assetClass === 'Equity' && group && group !== 'Broad') return { dimension: 'equitySectors', label: SECTOR_PLAYBOOK[group] || group };
  if (assetClass === 'Equity' && group === 'Broad' && region !== 'US') return null;
  if (assetClass === 'Fixed income' && group === 'Credit') return { dimension: 'assetClasses', label: 'Credit' };
  if (assetClass === 'Fixed income' && group === 'Cash') return null;
  if (assetClass === 'Commodity' && group === 'Gold') return { dimension: 'assetClasses', label: 'Gold' };
  if (assetClass === 'Currency' && group === 'US dollar') return { dimension: 'assetClasses', label: 'USD' };
  return CLASS_PLAYBOOK[assetClass] ? { dimension: 'assetClasses', label: CLASS_PLAYBOOK[assetClass] } : null;
};

export const quadFit = (entry, quad) => {
  const lists = entry && QUAD_PLAYBOOK[`q${quad}`]?.[entry.dimension];
  if (!lists) return null;
  return lists.best.includes(entry.label) ? 'best' : lists.worst.includes(entry.label) ? 'worst' : null;
};

const number = value => (value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null);
const emptyTotals = () => ({ positions: 0, longPct: 0, shortPct: 0, riskSharePct: 0, beta: 0, measured: 0, members: [] });
const add = (totals, position) => {
  totals.positions += 1;
  totals.members.push(position);
  if (position.weightPct > 0) totals.longPct += position.weightPct; else totals.shortPct -= position.weightPct;
  if (position.riskSharePct != null && position.beta != null) {
    totals.measured += 1;
    totals.riskSharePct += position.riskSharePct;
    totals.beta += position.beta * position.weightPct / 100;
  }
};
const finish = (totals, fields) => ({
  ...fields,
  positions: totals.positions,
  // Largest position first, so a truncated list still names what matters.
  symbols: totals.members.sort((left, right) => Math.abs(right.weightPct) - Math.abs(left.weightPct) || left.symbol.localeCompare(right.symbol))
    .map(member => member.symbol),
  netPct: totals.longPct - totals.shortPct,
  grossPct: totals.longPct + totals.shortPct,
  // Nothing held is a true zero, not a missing reading.
  riskSharePct: totals.measured || !totals.positions ? totals.riskSharePct : null,
  beta: totals.measured || !totals.positions ? totals.beta : null,
  unmeasured: totals.positions - totals.measured,
});

// A row's name and place within its class. Broad equity funds split by region,
// since Japan and the US are different bets; a foreign one is named by its
// region alone and sorts after the sectors.
const groupOf = ([assetClass, group, region]) => {
  if (group !== 'Broad') return { label: group, rank: 1 };
  if (assetClass !== 'Equity') return { label: 'Broad', rank: 0 };
  return region === 'US' ? { label: 'Broad · US', rank: 0 } : { label: region, rank: 2 };
};

// The book rolled up by asset class, then by group. `universe` is every reviewed
// label set ([asset class, group, region]) in the security universe: each
// exposure it names gets a row even when nothing is held, so a zero is visible.
// A class with one group is a single row. Weights are signed % of NAV; beta is
// each row's contribution to the book's beta, and risk shares sum to 100% across
// classes.
export function buildRiskMatrixRollup({ holdings = [], nav, riskRows = [], universe = [] } = {}) {
  const navValue = number(nav);
  if (!Array.isArray(holdings) || !(navValue > 0)) return [];
  const risk = new Map(riskRows.map(row => [row.symbol, row]));
  const bySymbol = new Map();
  for (const holding of holdings) {
    const symbol = String(holding?.symbol || '').trim().toUpperCase();
    const value = number(holding?.marketValue);
    if (!symbol || !value) continue;
    bySymbol.set(symbol, (bySymbol.get(symbol) || 0) + value / navValue * 100);
  }

  const classes = new Map();
  const groupFor = (labels) => {
    const assetClass = labels ? labels[0] : UNLABELLED;
    const { label, rank } = labels ? groupOf(labels) : { label: UNLABELLED, rank: 1 };
    if (!classes.has(assetClass)) classes.set(assetClass, { totals: emptyTotals(), groups: new Map() });
    const bucket = classes.get(assetClass);
    if (!bucket.groups.has(label)) bucket.groups.set(label, { totals: emptyTotals(), rank, playbook: labels ? playbookEntry(...labels) : null });
    return { bucket, group: bucket.groups.get(label) };
  };
  for (const labels of universe) {
    if (Array.isArray(labels) && labels.length === 3 && labels.every(Boolean)) groupFor(labels);
  }
  for (const [symbol, weightPct] of bySymbol) {
    const row = risk.get(symbol) || {};
    const { bucket, group } = groupFor(row.assetClass && row.group && row.region ? [row.assetClass, row.group, row.region] : null);
    const position = { symbol, weightPct, riskSharePct: number(row.riskSharePct), beta: number(row.beta) };
    add(bucket.totals, position);
    add(group.totals, position);
  }

  const order = name => (CLASS_ORDER.includes(name) ? CLASS_ORDER.indexOf(name) : name === UNLABELLED ? 99 : 50);
  return [...classes].sort(([left], [right]) => order(left) - order(right) || left.localeCompare(right)).flatMap(([assetClass, bucket]) => {
    const groups = [...bucket.groups].sort(([left, a], [right, b]) => a.rank - b.rank || left.localeCompare(right));
    const classPlaybook = playbookEntry(assetClass, null, null);
    if (groups.length === 1) {
      const [label, group] = groups[0];
      return [finish(group.totals, {
        id: assetClass, level: 'class', label: label === assetClass ? assetClass : `${assetClass} · ${label}`, playbook: group.playbook || classPlaybook,
      })];
    }
    return [
      finish(bucket.totals, { id: assetClass, level: 'class', label: assetClass, playbook: classPlaybook }),
      ...groups.map(([label, group]) => finish(group.totals, { id: `${assetClass}/${label}`, level: 'group', label, playbook: group.playbook })),
    ];
  });
}
