'use strict';

const { securityCalls } = require('../../analyst/stanceBook.cjs');
const { available, unavailable, withStatus } = require('../fields.cjs');

const SOURCE = 'Hedgeye stance book (Signal Strength, ETF Pro, Real-Time Alerts)';
// The attention scan scores the book every 30 s while it runs.
const MAX_AGE_MS = 5 * 60_000;

const emptyStance = reason => withStatus({ calls: unavailable(reason, { source: SOURCE }) });

// Product calls from the book the Inbox scan last scored: the same entries,
// SOME partials included, that its stance cards read. A book nobody has scored
// recently is unavailable rather than an old answer.
function createStancePiece({ getScoredStanceBook, now = Date.now, maxAgeMs = MAX_AGE_MS } = {}) {
  async function loadMany(symbols) {
    const scored = typeof getScoredStanceBook === 'function' ? getScoredStanceBook() : null;
    const scoredAt = Date.parse(scored?.scoredAt);
    if (!scored?.book || !Number.isFinite(scoredAt)) return new Map(symbols.map(symbol => [symbol, emptyStance(scored?.reason || 'stance-book-not-scored')]));
    if (now() - scoredAt > maxAgeMs) return new Map(symbols.map(symbol => [symbol, emptyStance('stance-book-not-scored-recently')]));
    return new Map(symbols.map(symbol => [symbol, withStatus({
      calls: available(securityCalls(scored.book, symbol), { source: SOURCE, asOf: scored.scoredAt }),
    })]));
  }

  return { loadMany, empty: emptyStance };
}

module.exports = { createStancePiece, emptyStance };
