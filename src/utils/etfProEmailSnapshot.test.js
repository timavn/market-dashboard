const {
  parseEtfProActionEmail,
  parseEtfProFullBookEmail,
} = require('./etfProEmailSnapshot.cjs');

describe('ETF Pro email parsing', () => {
  test('extracts full lineup from June update email text', () => {
    const payload = parseEtfProFullBookEmail(
      {
        messageId: 'gmail-full-book',
        attachmentId: 'message-body-html-2',
        subject: 'ETF Pro Plus: June Update (Q2 2026)',
        receivedAt: '2026-06-10T12:30:05+00:00',
        s3Key: 'hedgeye-email/messages/2026-06-10/etf-pro/full.html',
      },
      `
        <p>Welcome back! The current lineup of ETFs is as follows:</p>
        <p>Long: BUXX, AAAU, CLOX, OIH, NORW, COM, XTL, EQRR, HYG, CLOZ, CPER, CNXT, IWM, VYM, QTUM, VXF, SLX, DRAM, DBB, ROBO, TAN, UUP, DBMF, BUG, UFO, XAR, FWD</p>
        <p>Short: TLT, ZROZ, INDA, PALL, EPHE, ITB, IDX, XLU, IHI, BTAL, EWZ, INQQ, WOOD, PAWZ, FXE</p>
        <p>( VIEW LARGER IMAGE )</p>
      `
    );

    expect(payload.meta.source).toBe('gmail-html-full-book');
    expect(payload.meta.snapshotDate).toBe('2026-06-10');
    expect(payload.meta).toMatchObject({
      sourceMessageId: 'gmail-full-book',
      sourceSequence: 2,
      sourceEventKey: '2026-06-10T12:30:05+00:00#gmail-full-book#0002',
    });
    expect(payload.rows).toHaveLength(42);
    expect(payload.rows.filter((row) => row.call === 'Long')).toHaveLength(27);
    expect(payload.rows.filter((row) => row.call === 'Short')).toHaveLength(15);
    expect(payload.rows.map((row) => row.ticker)).toEqual(expect.arrayContaining(['BUXX', 'FWD', 'TLT', 'FXE']));
  });

  test('extracts action changes from ETF Pro update email text', () => {
    const payload = parseEtfProActionEmail(
      {
        subject: 'UPDATE: 5 New ETF Pro Changes',
        snapshotDate: '2026-06-11',
        receivedAt: '2026-06-11T14:26:05+00:00',
        s3Key: 'hedgeye-email/messages/2026-06-11/etf-pro/action.html',
      },
      `
        <p>We are ADDING Long : US Deflation (BNDD) Health Care (PINK)</p>
        <p>We are ADDING Short : Bitcoin (IBIT) Commodities Strategy (HARD)</p>
        <p>We are REMOVING Short : US Treasury Long (ZROZ) - (61.09 - 63.51)</p>
        <p>How to Use ETF Pro Plus Updates:</p>
      `
    );

    expect(payload.meta.source).toBe('gmail-html-action');
    expect(payload.changes.addedLongs).toEqual(['BNDD', 'PINK']);
    expect(payload.changes.addedShorts).toEqual(['IBIT', 'HARD']);
    expect(payload.changes.removedShorts).toEqual(['ZROZ']);
    expect(payload.rows.filter((row) => row.action === 'ADD')).toHaveLength(4);
    expect(payload.rows.filter((row) => row.action === 'REMOVE')).toHaveLength(1);
  });

  test('extracts same-day single ETF Pro long add with dotted company name', () => {
    const payload = parseEtfProActionEmail(
      {
        subject: 'UPDATE: 1 New ETF Pro Change',
        receivedAt: '2026-06-22T11:45:00-04:00',
        s3Key: 'hedgeye-email/messages/2026-06-22/etf-pro/action.html',
      },
      `
        <p>We are ADDING Long : The J.M. Smucker Company (SJM)</p>
        <p>How to Use ETF Pro Plus Updates:</p>
      `
    );

    expect(payload.meta.snapshotDate).toBe('2026-06-22');
    expect(payload.changes.addedLongs).toEqual(['SJM']);
    expect(payload.changes.removedLongs).toEqual([]);
    expect(payload.rows).toEqual([
      expect.objectContaining({
        ticker: 'SJM',
        etf: 'The J.M. Smucker Company',
        call: 'Long',
        action: 'ADD',
      }),
    ]);
  });

  test('extracts weekly report BULLISH and BEARISH tables as a full book', () => {
    const payload = parseEtfProFullBookEmail(
      {
        subject: 'ETF Pro Plus - New Weekly Report',
        receivedAt: '2026-06-21T17:58:02+00:00',
        s3Key: 'hedgeye-email/messages/2026-06-21/etf-pro/full.html',
      },
      `
        <p>BULLISH</p>
        <p>TICKER</p><p>DATE ADDED</p><p>RECENT PRICE*</p><p>TREND RANGES</p><p>ASSET CLASS</p>
        <p>Income Short Maturity</p><p>BUXX</p><p>10/25/2023</p><p>$20.25</p><p>$20.21</p><p>$20.29</p><p>Domestic Fixed Income</p>
        <p>Physical Gold</p><p>AAAU</p><p>2/28/2025</p><p>$41.57</p><p>$40.26</p><p>$44.40</p><p>Foreign Currency</p>
        <p>BEARISH</p>
        <p>TICKER</p><p>DATE ADDED</p><p>RECENT PRICE*</p><p>TREND RANGES</p><p>ASSET CLASS</p>
        <p>Palladium</p><p>PALL</p><p>5/1/2026</p><p>$23.23</p><p>$21.26</p><p>$24.98</p><p>Commodities</p>
        <p>*All ETF recent intra day prices data through 6/21/2026</p>
      `
    );

    expect(payload.meta.source).toBe('gmail-html-full-book');
    expect(payload.meta.snapshotDate).toBe('2026-06-21');
    expect(payload.meta.longCount).toBe(2);
    expect(payload.meta.shortCount).toBe(1);
    expect(payload.rows).toEqual([
      expect.objectContaining({ ticker: 'BUXX', call: 'Long', dateAdded: '2023-10-25', trendHighEnd: 20.29 }),
      expect.objectContaining({ ticker: 'AAAU', call: 'Long', dateAdded: '2025-02-28', trendLowEnd: 40.26 }),
      expect.objectContaining({ ticker: 'PALL', call: 'Short', dateAdded: '2026-05-01', recentPrice: 23.23 }),
    ]);
  });
});
