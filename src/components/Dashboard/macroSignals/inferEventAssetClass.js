import { inferPredictionSignalCategory } from '../../../utils/predictionMarketSignals';
import { GROUP_TO_ASSET_CLASS } from './constants';

/** Extra patterns for ingest categories not covered by inferPredictionSignalCategory */
const EXTRA_CATEGORY_PATTERNS = [
  { category: 'Inflation', pattern: /\b(cpi|pce|ppi|inflation)\b/i },
  { category: 'Labor', pattern: /\b(payroll|jobs|unemployment|nfp|labor)\b/i },
  { category: 'Growth', pattern: /\b(gdp|growth|recession|retail sales)\b/i },
];

function eventText(event) {
  return [
    event.question,
    event.event_title,
    event.eventTitle,
    event.contract_title,
    event.category,
    event.underlying,
    event.symbol,
  ]
    .filter(Boolean)
    .join(' ');
}

export function isCpiMacroEvent(event) {
  return /\bCPIY?\b|\bCONSUMER PRICE INDEX\b/i.test(eventText(event));
}

function inferCategoryFromText(event) {
  const text = eventText(event);
  const fromUniverse = inferPredictionSignalCategory('all', event);
  if (fromUniverse && fromUniverse !== 'all') return fromUniverse;
  const extra = EXTRA_CATEGORY_PATTERNS.find(({ pattern }) => pattern.test(text));
  return extra?.category || 'all';
}

function categoryToAssetClass(category) {
  if (!category || category === 'all') return null;
  return INGEST_CATEGORY_TO_ASSET_CLASS[category] || GROUP_TO_ASSET_CLASS[category] || null;
}

/** Ingest / dashboard event category → macro tab key */
const INGEST_CATEGORY_TO_ASSET_CLASS = {
  Index: 'EQ',
  Rates: 'FI',
  FX: 'FX',
  Commodities: 'CMD',
  Crypto: 'CRPT',
  Credit: 'FI',
  Inflation: 'FI',
  Labor: 'EQ',
  Growth: 'EQ',
};

/**
 * Map a prediction-market event to EQ|FI|FX|CMD|CRPT for Contract Map tabs.
 * Returns null when the event cannot be classified (excluded from all tabs).
 *
 * @param {object|null|undefined} event
 * @returns {import('./constants').MacroAssetClass|null}
 */
export function inferEventMacroAssetClass(event) {
  if (!event) return null;

  const direct = categoryToAssetClass(event.category);
  if (direct) return direct;

  return categoryToAssetClass(inferCategoryFromText(event));
}
