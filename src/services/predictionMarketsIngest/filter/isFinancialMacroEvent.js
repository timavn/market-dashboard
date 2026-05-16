const {
  FINANCIAL_KEYWORDS,
  EXCLUDE_KEYWORDS,
  MACRO_SETTLEMENT_SOURCES,
  KALSHI_FINANCIAL_CATEGORIES,
} = require('../constants');

function textBlob(event) {
  return [
    event.event_title,
    event.contract_title,
    event.question,
    event.underlying,
    event.category,
    event.settlement_rules_summary,
    event.settlement_source,
    event.api_raw_symbol,
    ...(event._tags || []),
    ...(event._seriesCategory ? [event._seriesCategory] : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function hasMacroSettlement(event) {
  const src = (event.settlement_source || '').toLowerCase();
  const rules = (event.settlement_rules_summary || '').toLowerCase();
  const combined = `${src} ${rules}`;
  return MACRO_SETTLEMENT_SOURCES.some((s) => combined.includes(s));
}

function matchesKeywords(text, keywords) {
  return keywords.some((kw) => text.includes(kw));
}

/**
 * @param {object} event - normalized or pre-normalized candidate
 * @returns {boolean}
 */
function isFinancialMacroEvent(event) {
  const text = textBlob(event);

  if (matchesKeywords(text, EXCLUDE_KEYWORDS)) {
    if (!hasMacroSettlement(event)) return false;
  }

  if (event._seriesCategory && KALSHI_FINANCIAL_CATEGORIES.has(String(event._seriesCategory).toLowerCase())) {
    return true;
  }

  if (hasMacroSettlement(event)) return true;

  if (matchesKeywords(text, FINANCIAL_KEYWORDS)) return true;

  if (event.category && event.category !== 'Other Macro') {
    const macroCats = ['Index', 'Rates', 'Inflation', 'Labor', 'Growth', 'Commodities', 'FX', 'Crypto', 'Credit'];
    if (macroCats.includes(event.category)) return true;
  }

  return false;
}

module.exports = { isFinancialMacroEvent, textBlob };
