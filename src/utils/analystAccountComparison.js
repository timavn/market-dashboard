// Presentation guidance for dated accounting observations, never executable quotes.
const METRICS = [
  { key: 'equity', labels: ['net liquidation value', 'net liquidation', 'nlv'], favorable: 1,
    moves: ['Your equity base decreased, leaving less capital to absorb losses.', 'Your equity base was unchanged between these snapshots.', 'Your equity base increased, providing more capital to absorb losses.'],
    context: 'Cash flows and other adjustments must be reconciled before treating the change as trading profit or loss.' },
  { key: 'initial', labels: ['initial margin', 'initial margin requirement'], favorable: -1,
    moves: ['The broker requires less collateral under its initial-margin rules.', 'The initial-margin collateral requirement was unchanged.', 'The broker requires more collateral under its initial-margin rules.'],
    context: 'This is a collateral requirement; borrowing costs depend on the actual financed balance.' },
  { key: 'maintenance', labels: ['maintenance margin', 'maintenance margin requirement'], favorable: -1,
    moves: ['Less equity is required to maintain the existing positions.', 'The equity requirement for maintaining positions was unchanged.', 'More equity is required to maintain the existing positions.'],
    context: 'A portfolio manager watches this alongside excess liquidity to assess pressure from margin requirements.' },
  { key: 'funds', labels: ['available funds'], favorable: 1,
    moves: ['Headroom under the initial-margin test decreased.', 'Headroom under the initial-margin test was unchanged.', 'Headroom under the initial-margin test increased.'],
    context: 'This measures flexibility to adjust positions while meeting the broker’s collateral rules.' },
  { key: 'liquidity', labels: ['excess liquidity'], favorable: 1,
    moves: ['The cushion above maintenance requirements decreased.', 'The cushion above maintenance requirements was unchanged.', 'The cushion above maintenance requirements increased.'],
    context: 'This is breathing room against adverse moves, and it changes with both prices and margin requirements.' },
  { key: 'buying', labels: ['buying power'], favorable: 1,
    moves: ['The broker reports less purchasing capacity, including leverage.', 'The broker’s reported purchasing capacity was unchanged.', 'The broker reports more purchasing capacity, including leverage.'],
    context: 'A fund manager treats this as a capacity limit, rather than a target portfolio size.' },
  { key: 'gross', labels: ['gross market value', 'gross exposure'],
    moves: ['Combined long and short dollar exposure decreased.', 'Combined long and short dollar exposure was unchanged.', 'Combined long and short dollar exposure increased.'],
    context: 'Actual risk also depends on position mix, volatility, and how the holdings move together.' },
  { key: 'long', labels: ['long market value', 'long exposure'],
    moves: ['The dollar size of the long side decreased.', 'The dollar size of the long side was unchanged.', 'The dollar size of the long side increased.'],
    context: 'Trade records are needed to separate position changes from market-price moves.' },
  { key: 'short', labels: ['short market value', 'short market value (absolute)', 'short exposure', 'short exposure (magnitude)'],
    context: 'Whether this strengthens or weakens a hedge depends on what those shorts offset.' },
  { key: 'net', labels: ['net market value', 'net exposure'],
    context: 'Dollar balance alone does not establish market neutrality or effective hedging.' },
  { key: 'deficit', labels: ['maintenance deficit', 'maintenance margin deficit'], favorable: -1,
    moves: ['The reported maintenance shortfall decreased.', 'The reported maintenance shortfall was unchanged.', 'The reported maintenance shortfall increased.'],
    context: 'Excess liquidity provides the accompanying measure of margin headroom.' },
  { key: 'accrued', labels: ['accrued debit', 'accrued interest debit'],
    moves: ['The recorded accrued debit decreased.', 'The recorded accrued debit was unchanged.', 'The recorded accrued debit increased.'],
    context: 'The interest ledger is needed to separate new charges, credits, and adjustments before inferring financing costs.' },
];

const normalize = value => String(value || '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export const accountComparisonMetric = label => METRICS.find(metric => metric.labels.includes(normalize(label)));
const dated = value => /\b(?:20\d{2}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2})\b/i.test(value);

export function isAccountComparisonTable(headers, labels) {
  const names = headers.map(normalize);
  if (names[0] !== 'metric' || !dated(names[1]) || !dated(names[2])) return false;
  const currency = value => value.match(/\b(?:USD|CAD|AUD|NZD|HKD|SGD|EUR|GBP)\b/i)?.[0].toUpperCase() || null;
  if (currency(names[1]) !== currency(names[2])) return false;
  const legacy = names.length === 4 && names[3] === 'direction';
  const current = names.length === 5 && /^(?:dollar )?change$/.test(names[3]) && names[4] === 'what this means for the account';
  return Boolean((legacy || current) && labels.filter(accountComparisonMetric).length >= (legacy ? 2 : 1)
    && (!legacy || labels.every(accountComparisonMetric)));
}

// Parse complete dollar observations in integer cents. Reject annotations,
// percentages, mixed currencies, rounded k/m amounts and unavailable inputs.
export function accountComparisonCents(value) {
  const source = String(value || '').trim().replace(/−/g, '-');
  const parenthesized = /^\(.*\)$/.test(source);
  const text = parenthesized ? source.slice(1, -1) : source;
  const match = text.match(/^([+-]?)\$([+-]?)((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?$/);
  if (!match || (match[1] && match[2]) || (parenthesized && (match[1] || match[2]))) return null;
  const cents = Number(match[3].replace(/,/g, '')) * 100 + Number((match[4] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return (parenthesized || match[1] === '-' || match[2] === '-' ? -1 : 1) * cents;
}

export const formatAccountDollarChange = cents => `${cents > 0 ? '+' : cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percentage = (amount, equity) => (amount / equity * 100).toFixed(2);

export function accountComparisonMeaning(metric, before, after, equity) {
  const delta = after - before;
  const movement = Math.sign(delta) + 1;
  let opening = metric.moves?.[movement];
  if (metric.key === 'short') {
    const change = Math.abs(after) - Math.abs(before);
    opening = `The dollar size of the short side ${change < 0 ? 'decreased' : change > 0 ? 'increased' : 'was unchanged'}.`;
  }
  if (metric.key === 'net') {
    const side = amount => amount > 0 ? 'net long' : amount < 0 ? 'net short' : 'dollar balanced';
    opening = before === after ? `The book remained ${side(after)} in dollar terms.`
      : Math.sign(before) !== Math.sign(after) ? `The book moved from ${side(before)} to ${side(after)}.`
        : `The book became ${Math.abs(after) < Math.abs(before) ? 'less' : 'more'} ${side(after)} in dollar terms.`;
  }
  if (metric.key === 'deficit' && before === 0 && after === 0) opening = 'Neither snapshot shows a maintenance shortfall.';
  if (['gross', 'net'].includes(metric.key) && equity?.before > 0 && equity?.after > 0) {
    opening = `${metric.key === 'gross' ? 'Gross' : 'Net'} exposure moved from ${percentage(before, equity.before)}% to ${percentage(after, equity.after)}% of equity.`;
  }
  return `${opening} ${metric.context}`;
}
