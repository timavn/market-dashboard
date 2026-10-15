const test = require('node:test');
const assert = require('node:assert/strict');
const { membershipDateIsUsable } = require('./marketDailyMembership.cjs');

test('retains the original issuer membership date through weekend and holiday publication lag', () => {
  assert.equal(membershipDateIsUsable('2026-09-24', Date.parse('2026-09-26T15:00:00Z')), true);
  assert.equal(membershipDateIsUsable('2026-09-03', Date.parse('2026-09-07T15:00:00Z')), true);
  assert.equal(membershipDateIsUsable('2026-09-24', Date.parse('2026-10-26T15:00:00Z')), true);
});

test('rejects missing, invalid, nontrading and future issuer dates in the market timezone', () => {
  const nowMs = Date.parse('2026-09-26T15:00:00Z');
  for (const date of [undefined, null, '', '09/24/2026', '2026-02-30', '2026-09-26', '2026-09-07', '2026-09-28']) {
    assert.equal(membershipDateIsUsable(date, nowMs), false, String(date));
  }
  assert.equal(membershipDateIsUsable('2026-09-25', Date.parse('2026-09-25T02:00:00Z')), false);
  assert.equal(membershipDateIsUsable('2026-09-24', NaN), false);
});
