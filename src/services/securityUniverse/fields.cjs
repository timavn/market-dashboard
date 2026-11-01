'use strict';

// Every fact in the security record is a Field: the value with its own source,
// as-of date and status. A missing fact is a Field too, with value null and a
// reason, so a reader can always tell "not published" from "not loaded".
const UNTRUSTED_FLAGS = ['mock', 'isMock', 'seed', 'seeded', 'isSeeded', 'fixture', 'synthetic', 'inferred', 'fallback',
  'stale', 'isStale', 'cacheOnly', 'fromCache', 'offline', 'disconnected'];

const flagged = value => Boolean(value && typeof value === 'object'
  && (UNTRUSTED_FLAGS.some(flag => value[flag] === true) || value.connected === false));

const available = (value, { source = null, asOf = null, ...extra } = {}) => ({ status: 'available', value, source, asOf, reason: null, ...extra });
const unavailable = (reason, { source = null, asOf = null, ...extra } = {}) => ({ status: 'unavailable', value: null, source, asOf, reason, ...extra });

const isField = value => Boolean(value && typeof value === 'object' && typeof value.status === 'string' && 'value' in value);

// A piece is available when every Field it holds is, unavailable when none is.
function pieceStatus(piece) {
  const statuses = Object.values(piece || {}).filter(isField).map(field => field.status);
  if (!statuses.length || statuses.every(status => status === 'unavailable')) return 'unavailable';
  return statuses.every(status => status === 'available') ? 'available' : 'partial';
}

function withStatus(fields) {
  return { status: pieceStatus(fields), ...fields };
}

const round = (value, places = 2) => (typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(places)) : null);

module.exports = { UNTRUSTED_FLAGS, available, flagged, isField, pieceStatus, round, unavailable, withStatus };
