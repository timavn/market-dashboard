const {
  OFFICIAL_MARGIN_RATE_URL,
  fetchOfficialUsdProMarginSchedule,
  parseOfficialUsdMarginSchedule,
} = require('./ibkrPublishedMarginRateService.cjs');

const officialTable = `
  <table>
    <tr><th>Currency</th><th>Tier</th><th>Rate Charged: IBKR <span>Pro</span></th><th>Rate Charged: IBKR <span>Lite</span></th></tr>
    <tr><td>USD</td><td>0 ≤ 100,000</td><td>5.130% (BM + 1.5%)</td><td>6.130% (BM + 2.5%)</td></tr>
    <tr><td></td><td>100,000 ≤ 1,000,000</td><td>4.630%</td><td>6.130%</td></tr>
    <tr><td></td><td>1,000,000 ≤ 50,000,000</td><td>4.380%</td><td>6.130%</td></tr>
    <tr><td></td><td>50,000,000 ≤ 250,000,000</td><td>4.130%</td><td>6.130%</td></tr>
    <tr><td></td><td>&gt; 250,000,000</td><td>4.130%</td><td>6.130%</td></tr>
    <tr><td>EUR</td><td>0 ≤ 90,000</td><td>3.696%</td><td>4.696%</td></tr>
  </table>
`;

describe('official IBKR margin-rate evidence', () => {
  test('parses one complete USD Pro schedule and hashes the normalized tiers', () => {
    const parsed = parseOfficialUsdMarginSchedule(officialTable);

    expect(parsed).toMatchObject({
      currency: 'USD',
      plan: 'IBKR Pro',
      liteAnnualRate: 0.0613,
      tiers: [
        { upTo: 100000, annualRate: 0.0513 },
        { upTo: 1000000, annualRate: 0.0463 },
        { upTo: 50000000, annualRate: 0.0438 },
        { upTo: 250000000, annualRate: 0.0413 },
        { upTo: null, annualRate: 0.0413 },
      ],
    });
    expect(parsed.scheduleHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('records the official URL, fetch time, schedule hash, and provisional status', async () => {
    const result = await fetchOfficialUsdProMarginSchedule({
      fetchImpl: jest.fn(async () => ({
        ok: true,
        url: OFFICIAL_MARGIN_RATE_URL,
        text: async () => officialTable,
      })),
      now: () => new Date('2026-08-10T21:00:00.000Z'),
    });

    expect(result).toMatchObject({
      source: 'ibkr_official_margin_rates',
      url: OFFICIAL_MARGIN_RATE_URL,
      fetchedAt: '2026-08-10T21:00:00.000Z',
      provisional: true,
    });
    expect(result.scheduleHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each([
    ['missing rows', officialTable.replace(/<tr><td><\/td><td>&gt; 250,000,000[\s\S]*?<\/tr>/, '')],
    ['duplicate table', `${officialTable}${officialTable}`],
  ])('fails closed for an ambiguous page: %s', (_label, html) => {
    expect(() => parseOfficialUsdMarginSchedule(html)).toThrow(
      expect.objectContaining({
        code: expect.stringMatching(/ambiguous/),
      }),
    );
  });

  test('omits evidence when the official page is unavailable', async () => {
    await expect(fetchOfficialUsdProMarginSchedule({
      fetchImpl: jest.fn(async () => ({ ok: false, url: OFFICIAL_MARGIN_RATE_URL })),
    })).rejects.toMatchObject({
      code: 'interest_official_rate_fetch_unavailable',
    });
  });
});
