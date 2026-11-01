'use strict';

// Presentation form of a verified security name. Provider names that already
// carry case (Yahoo longName) pass through unchanged. SEC's directory is all
// capitals with registrant suffixes ("COSTCO WHOLESALE CORP /NEW"); it is only
// re-cased here, never reworded, so the name still matches its source.
const ACRONYMS = new Set([
  'ADR', 'ADS', 'AG', 'AI', 'ASA', 'BDC', 'CBOE', 'ESG', 'ETF', 'ETFS', 'ETN', 'II', 'III', 'IV', 'IX', 'LLC', 'LP',
  'MLP', 'MSCI', 'NV', 'NYSE', 'PLC', 'REIT', 'SA', 'SE', 'SPDR', 'UK', 'US', 'USA', 'VI', 'VII', 'VIII', 'XL',
]);
const MINOR = new Set(['A', 'AN', 'AND', 'AT', 'DE', 'FOR', 'IN', 'OF', 'ON', 'OR', 'THE', 'TO']);
// "/NEW", "/DE/", "\MD\" and similar: SEC registrant markers, not part of the name.
const REGISTRANT_SUFFIX = /\s*[/\\][A-Z]{2,3}[/\\]?\s*$/;

function recaseWord(word, index) {
  if (!/[A-Z]/.test(word)) return word;
  const core = word.replace(/[^A-Z0-9&'.-]/g, '');
  if (ACRONYMS.has(core.replace(/\.$/, '')) || /\d/.test(core) || /[A-Z]&[A-Z]/.test(core)) return word;
  // Short tokens without a vowel are abbreviations (BP, HP, BNY).
  if (core.length <= 4 && !/[AEIOU]/.test(core)) return word;
  if (index > 0 && MINOR.has(core)) return word.toLowerCase();
  return word.split('-').map(part => part.toLowerCase()
    .replace(/^([^a-z]*)([a-z])/, (_, lead, letter) => lead + letter.toUpperCase())
    .replace(/^Mc([a-z])/, (_, letter) => `Mc${letter.toUpperCase()}`)).join('-');
}

function securityDisplayName(value) {
  let name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!name) return null;
  if (/[a-z]/.test(name)) return name;
  while (REGISTRANT_SUFFIX.test(name)) name = name.replace(REGISTRANT_SUFFIX, '');
  return name.split(' ').map(recaseWord).join(' ') || null;
}

// A futures contract name rolls with its month ("Gold Dec 26"); the record
// names the instrument, not the contract.
function continuousInstrumentName(value) {
  const name = securityDisplayName(value);
  return name ? name.replace(/\s*,?\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]+\d{2,4}$/i, '').trim() || null : null;
}

module.exports = { securityDisplayName, continuousInstrumentName };
