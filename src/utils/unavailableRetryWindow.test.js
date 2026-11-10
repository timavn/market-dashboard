const { FIRST_RETRY_MS, unavailableRetryMs } = require('./unavailableRetryWindow.cjs');

const MINUTE = 60 * 1000;

describe('unavailableRetryMs', () => {
  test('waits a minute after the first miss and doubles with each miss in a row', () => {
    expect(FIRST_RETRY_MS).toBe(MINUTE);
    expect([1, 2, 3, 4, 5].map((misses) => unavailableRetryMs(misses, 60 * MINUTE)))
      .toEqual([1, 2, 4, 8, 16].map((minutes) => minutes * MINUTE));
  });

  test('never waits longer than a good answer would be kept', () => {
    expect(unavailableRetryMs(5, 15 * MINUTE)).toBe(15 * MINUTE);
    expect(unavailableRetryMs(7, 60 * MINUTE)).toBe(60 * MINUTE);
    expect(unavailableRetryMs(10_000, 60 * MINUTE)).toBe(60 * MINUTE);
    // A cache time shorter than a minute is itself the limit.
    expect(unavailableRetryMs(1, 5_000)).toBe(5_000);
  });

  test('treats a missing or invalid miss count as the first miss', () => {
    for (const misses of [0, -3, undefined, null, Number.NaN, 'many']) {
      expect(unavailableRetryMs(misses, 60 * MINUTE)).toBe(MINUTE);
    }
    expect(unavailableRetryMs(2.9, 60 * MINUTE)).toBe(2 * MINUTE);
  });

  test('without a usable ceiling the wait still doubles and stays finite', () => {
    expect(unavailableRetryMs(3)).toBe(4 * MINUTE);
    expect(unavailableRetryMs(3, 0)).toBe(4 * MINUTE);
    expect(Number.isFinite(unavailableRetryMs(1e9))).toBe(true);
  });

  test('accepts a different first wait', () => {
    expect(unavailableRetryMs(1, 60 * MINUTE, 10_000)).toBe(10_000);
    expect(unavailableRetryMs(3, 60 * MINUTE, 10_000)).toBe(40_000);
    expect(unavailableRetryMs(3, 60 * MINUTE, -1)).toBe(4 * MINUTE);
  });
});
