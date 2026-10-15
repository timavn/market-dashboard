const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQuoteSubscriptionRegistry } = require('./quoteSubscriptions.cjs');
test('one browser changing or clearing its list preserves another browser shared symbol', () => {
  const registry = createQuoteSubscriptionRegistry();
  registry.replace('first', ['SPY']); registry.replace('second', ['SPY']);
  registry.replace('first', ['QQQ']);
  assert.deepEqual(registry.desiredSymbols().sort(), ['QQQ', 'SPY']);
  assert.equal(registry.refCounts.get('SPY'), 1);
  registry.replace('second', []);
  assert.deepEqual(registry.desiredSymbols(), ['QQQ']);
  registry.release('first'); registry.release('first');
  assert.deepEqual(registry.desiredSymbols(), []);
  assert.equal(registry.clients.size, 1);
});
test('capacity failure is atomic and repeated identical subscription is idempotent', () => {
  const registry = createQuoteSubscriptionRegistry({ maxSymbols: 2 });
  registry.replace('first', ['SPY', 'spy']); registry.replace('first', ['SPY']);
  registry.replace('second', ['QQQ']);
  assert.equal(registry.refCounts.get('SPY'), 1);
  assert.throws(() => registry.replace('third', ['AAPL']), /capacity/);
  assert.deepEqual(registry.desiredSymbols(), ['SPY', 'QQQ']);
  assert.equal(registry.clients.has('third'), false);
});
