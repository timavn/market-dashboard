'use strict';

const reviewed = require('../../../constants/securityClassifications.json');
const { available, unavailable, withStatus } = require('../fields.cjs');

const LABELS = ['assetClass', 'group', 'region'];

const emptyClassification = reason => withStatus(Object.fromEntries(LABELS.map(label => [label, unavailable(reason)])));

// What a security is: asset class, the group that drives it within that class,
// and region. Reviewed facts only; a security nobody has labelled is unavailable,
// never guessed from its name or its price behaviour.
function createClassificationPiece({ table = reviewed } = {}) {
  const meta = { source: table.source || null, asOf: table.reviewedAt || null };
  async function loadMany(symbols) {
    return new Map(symbols.map((symbol) => {
      const labels = table.securities?.[symbol];
      if (!Array.isArray(labels) || labels.length !== LABELS.length || labels.some(label => !label)) return [symbol, emptyClassification('not-labelled')];
      return [symbol, withStatus(Object.fromEntries(LABELS.map((label, index) => [label, available(labels[index], meta)])))];
    }));
  }
  return { loadMany, empty: emptyClassification };
}

module.exports = { LABELS, createClassificationPiece, emptyClassification };
