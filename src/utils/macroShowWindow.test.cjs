const test = require('node:test');
const assert = require('node:assert/strict');
const { inMacroShowWindow, researchRefreshMs } = require('./macroShowWindow.cjs');

const at = (iso) => Date.parse(iso);

test('the window runs 10:00 to 12:00 ET on weekdays in winter and summer', () => {
  assert.equal(inMacroShowWindow(at('2026-11-09T14:59:59Z')), false);
  assert.equal(inMacroShowWindow(at('2026-11-09T15:00:00Z')), true);
  assert.equal(inMacroShowWindow(at('2026-11-09T16:59:59Z')), true);
  assert.equal(inMacroShowWindow(at('2026-11-09T17:00:00Z')), false);
  assert.equal(inMacroShowWindow(at('2026-07-13T14:00:00Z')), true);
  assert.equal(inMacroShowWindow(at('2026-11-07T15:30:00Z')), false);
});

test('research caches re-read every minute only inside the window', () => {
  assert.equal(researchRefreshMs(at('2026-11-09T15:30:00Z'), 300_000), 60_000);
  assert.equal(researchRefreshMs(at('2026-11-09T18:30:00Z'), 300_000), 300_000);
  assert.equal(researchRefreshMs(at('2026-11-09T15:30:00Z'), 0), 0);
});
