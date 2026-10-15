const { formatMarketDate } = require('./marketDateFormat.cjs');

describe('market calendar date formatting', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test.each([
    ['2026-03-08T04:59:59.999Z', '2026-03-07'],
    ['2026-03-08T05:00:00.000Z', '2026-03-08'],
    ['2026-03-09T03:59:59.999Z', '2026-03-08'],
    ['2026-03-09T04:00:00.000Z', '2026-03-09'],
    ['2026-11-01T03:59:59.999Z', '2026-10-31'],
    ['2026-11-01T04:00:00.000Z', '2026-11-01'],
    ['2026-11-02T04:59:59.999Z', '2026-11-01'],
    ['2026-11-02T05:00:00.000Z', '2026-11-02'],
  ])('keeps the New York date at %s', (timestamp, expected) => {
    expect(formatMarketDate(new Date(timestamp))).toBe(expected);
  });

  test.each(['America/New_York', 'America/Los_Angeles', 'UTC', 'Asia/Tokyo'])(
    'preserves existing locale formatting in %s',
    (timeZone) => {
      for (const timestamp of ['2026-01-01T02:00:00Z', '2026-07-01T23:59:59Z']) {
        const date = new Date(timestamp);
        expect(formatMarketDate(date, timeZone)).toBe(
          date.toLocaleDateString('en-CA', { timeZone }),
        );
      }
    },
  );

  test('a large ledger constructs one formatter and still evaluates every input date', () => {
    jest.resetModules();
    const OriginalFormatter = Intl.DateTimeFormat;
    const constructor = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      (...args) => new OriginalFormatter(...args),
    );
    const { formatMarketDate: format } = require('./marketDateFormat.cjs');
    const firstDate = new Date('2026-09-04T13:00:00Z');
    for (let index = 0; index < 5000; index += 1) {
      expect(format(firstDate)).toBe('2026-09-04');
    }
    expect(format(new Date('2026-09-05T13:00:00Z'))).toBe('2026-09-05');
    expect(constructor).toHaveBeenCalledTimes(1);
  });

  test('formatter retention is bounded even when callers vary time zones', () => {
    jest.resetModules();
    const OriginalFormatter = Intl.DateTimeFormat;
    const constructor = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      (...args) => new OriginalFormatter(...args),
    );
    const { formatMarketDate: format } = require('./marketDateFormat.cjs');
    const date = new Date('2026-09-04T13:00:00Z');
    const zones = ['UTC', ...Array.from({ length: 16 }, (_, index) => (
      index < 8 ? `Etc/GMT+${index + 1}` : `Etc/GMT-${index - 7}`
    ))];
    zones.forEach((timeZone) => format(date, timeZone));
    format(date, zones.at(-1));
    expect(constructor).toHaveBeenCalledTimes(17);
    format(date, 'UTC');
    expect(constructor).toHaveBeenCalledTimes(18);
  });

  test('does not silently replace invalid dates or time zones', () => {
    expect(() => formatMarketDate(new Date('invalid'))).toThrow(RangeError);
    expect(() => formatMarketDate(new Date(), 'invalid-zone')).toThrow(RangeError);
  });
});
