'use strict';

const { validateMomoRoster } = require('../momoRosterVerification.cjs');

const SOURCE = '/api/market/sp500-contributors?context=analyst';

function projectMomoRosterContext(snapshot, { nowMs = Date.now() } = {}) {
  // The morning audit and Analyst use the same source/date/coverage acceptance.
  // This projection contains research identities, never quote or signal values.
  const verified = validateMomoRoster(snapshot, { nowMs });
  const base = {
    schemaVersion: 'MomoRosterContextV1', date: verified.date,
    classification: 'dated_supporting_context', liveVerified: false, source: SOURCE,
  };
  if (verified.top10Tickers.length !== 10) return {
    ...base, status: 'unavailable', freshness: 'unavailable', data: null,
    reason: verified.reason || 'current_roster_unverified',
  };
  const momoStatus = verified.status === 'ready' ? 'available'
    : verified.status === 'pending' ? 'pending' : 'unavailable';
  const sources = {
    membership: { provider: 'State Street', sourceUrl: snapshot.membershipSourceUrl, asOf: snapshot.membershipAsOf },
    ranking: { provider: 'Nasdaq', sourceUrl: snapshot.rankingSourceUrl, retrievedAt: snapshot.fetchedAt },
  };
  if (momoStatus === 'available') sources.momo = {
    provider: 'Hedgeye', product: 'MOMO Tracker', publicationDate: verified.date,
  };
  return {
    ...base, status: momoStatus === 'available' ? 'available' : 'partial',
    asOf: snapshot.fetchedAt, freshness: 'current_roster',
    data: {
      topTenTickers: verified.top10Tickers,
      momoAdditionalTickers: verified.momoAdditionalTickers,
      tickerOrder: [...verified.top10Tickers, ...verified.momoAdditionalTickers],
      momoStatus, momoPublicationDate: momoStatus === 'available' ? verified.date : null,
      ranking: 'company-market-cap', sources,
    },
    scope: 'Research coverage universe; company ranks first, then MOMO additions by market cap.',
  };
}

module.exports = { projectMomoRosterContext };
