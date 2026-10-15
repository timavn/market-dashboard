const {
  AUDITED_FALSE_MENTIONS,
  VERIFIED_EVIDENCE_TICKER_ALIASES,
  buildHedgeyeSecurityUniverse,
  normalizeDeclaredPositionEntry,
  normalizeResearchPositionEntry,
  normalizeTickerCandidates,
  parseMacroShowDeclaredPositions,
  parseTheCallDeclaredPositions,
  parseSeedSecurities,
} = require('./hedgeyeUniverseDiscovery.cjs');

describe('hedgeyeUniverseDiscovery', () => {
  test('normalizes direct, parenthesized, class-share, FX, and composite mentions', () => {
    expect(normalizeTickerCandidates('NVDA')).toEqual(['NVDA']);
    expect(normalizeTickerCandidates('Gold (AAAU)')).toEqual(['AAAU']);
    expect(normalizeTickerCandidates('BF.B')).toEqual(['BF.B']);
    expect(normalizeTickerCandidates('$5930.KR')).toEqual(['5930.KR']);
    expect(normalizeTickerCandidates('$ADS.DE')).toEqual(['ADS.DE']);
    expect(normalizeTickerCandidates('$005930.KS')).toEqual(['005930.KS']);
    expect(normalizeTickerCandidates('ATZ')).toEqual(['ATZ']);
    expect(normalizeTickerCandidates('NVDA.PNG')).toEqual([]);
    expect(normalizeTickerCandidates('EUR/USD')).toEqual(['EUR/USD']);
    expect(normalizeTickerCandidates('USD/JPY')).toEqual(['USD/JPY']);
    expect(normalizeTickerCandidates('BTC/ETH')).toEqual(['BTC', 'ETH']);
    expect(normalizeTickerCandidates('GOOGL/GOOG')).toEqual(['GOOGL', 'GOOG']);
    expect(normalizeTickerCandidates('ordinary prose')).toEqual([]);
    expect(normalizeTickerCandidates('NEW')).toEqual([]);
    expect(normalizeDeclaredPositionEntry('$JD-LON')).toEqual(['JD']);
    expect(normalizeDeclaredPositionEntry('GLASF / GLAS')).toEqual(['GLASF', 'GLAS']);
    expect(normalizeDeclaredPositionEntry('WYFI (Pre IPO)')).toEqual(['WYFI']);
    expect(normalizeResearchPositionEntry('Gold (AAAU)')).toEqual(['AAAU']);
    expect(normalizeResearchPositionEntry('Energy equities (XLE)')).toEqual(['XLE']);
    expect(normalizeResearchPositionEntry('SPDR S&P Oil & Gas ETF (XOP)')).toEqual(['XOP']);
    expect(normalizeResearchPositionEntry('NVIDIA (NVDA)')).toEqual(['NVDA']);
    expect(normalizeResearchPositionEntry('PIMCO Treasury ETF (ZROZ)')).toEqual(['ZROZ']);
    expect(normalizeResearchPositionEntry('CLO ETF (CLOZ)')).toEqual(['CLOZ']);
    expect(normalizeResearchPositionEntry('JP Morgan (JPM)')).toEqual(['JPM']);
    expect(normalizeResearchPositionEntry('JB Hunt')).toEqual([]);
    expect(normalizeResearchPositionEntry('USA equities')).toEqual([]);
    expect(normalizeResearchPositionEntry('LXD & IVOL (fixed-income ETFs)')).toEqual(['LXD', 'IVOL']);
    expect(normalizeResearchPositionEntry('Natural Gas equities (e.g., BCF, RRC)')).toEqual(['BCF', 'RRC']);
    expect(normalizeResearchPositionEntry('Semiconductors (basket)')).toEqual([]);
    expect(normalizeResearchPositionEntry('NIKL (nickel)')).toEqual(['NIKL']);
    expect(normalizeResearchPositionEntry('FXY (Yen)')).toEqual(['FXY']);
    expect(normalizeResearchPositionEntry('Soybeans (NEW POSITION)')).toEqual([]);
    expect(normalizeResearchPositionEntry('Gold')).toEqual([]);
  });

  test('applies every audited archive exclusion only to its exact source and date', () => {
    const grouped = new Map();
    AUDITED_FALSE_MENTIONS.forEach((identity) => {
      const [product, date, ticker] = identity.split('#');
      const key = `${product}#${date}`;
      const tickers = grouped.get(key) || [];
      tickers.push(ticker);
      grouped.set(key, tickers);
    });
    const snapshots = [...grouped.entries()].map(([key, tickers]) => {
      const [snapshotType, date] = key.split('#');
      return {
        date,
        snapshotType,
        article: { bodyText: tickers.map((ticker) => `$${ticker}`).join(' ') },
      };
    });
    snapshots.push({
      date: '2026-08-23',
      snapshotType: 'the-call',
      article: { bodyText: 'A genuinely explicit future mention ($SRE).' },
    });
    snapshots.push({
      date: '2026-08-23',
      snapshotType: 'early-look',
      data: { 'BSE SENSEX (INDIA)': { trend: 'Bullish' } },
    });

    const universe = buildHedgeyeSecurityUniverse({ snapshots });
    expect(universe.rows.map((row) => row.ticker)).toEqual(['SRE']);
  });

  test('applies all verified ticker repairs at the evidence level', () => {
    const grouped = new Map();
    VERIFIED_EVIDENCE_TICKER_ALIASES.forEach((targetTicker, identity) => {
      const [product, date, sourceTicker] = identity.split('#');
      const key = `${product}#${date}`;
      const aliases = grouped.get(key) || [];
      aliases.push({ sourceTicker, targetTicker });
      grouped.set(key, aliases);
    });
    const snapshots = [...grouped.entries()].map(([key, aliases]) => {
      const [snapshotType, date] = key.split('#');
      return {
        date,
        snapshotType,
        data: { longs: aliases.map(({ sourceTicker }) => sourceTicker) },
        article: { bodyText: 'Archive body unavailable.' },
      };
    });

    const universe = buildHedgeyeSecurityUniverse({ snapshots });
    const rowTickers = universe.rows.map((row) => row.ticker);
    const targetTickers = [...new Set(VERIFIED_EVIDENCE_TICKER_ALIASES.values())];
    const replacedSourceTickers = [...VERIFIED_EVIDENCE_TICKER_ALIASES.entries()]
      .map(([identity]) => identity.split('#')[2])
      .filter((sourceTicker) => !targetTickers.includes(sourceTicker));
    expect(rowTickers).toEqual(expect.arrayContaining(targetTickers));
    expect(rowTickers).toEqual(expect.not.arrayContaining(replacedSourceTickers));
  });

  test('extracts seed rows without evaluating the source module', () => {
    expect(parseSeedSecurities(`
      { ticker: 'SPY', name: 'SPDR S&P 500 ETF', assetClass: 'equity', bias: 'BULLISH' },
      { ticker: "HYG", name: "High Yield", assetClass: "fixedIncome" },
    `)).toEqual([
      { ticker: 'SPY', name: 'SPDR S&P 500 ETF', assetClass: 'equity' },
      { ticker: 'HYG', name: 'High Yield', assetClass: 'fixedIncome' },
    ]);
  });

  test('retains every mention while separating catalogued, structured, and parser candidates', () => {
    const universe = buildHedgeyeSecurityUniverse({
      seedSecurities: [{ ticker: 'SPY', name: 'S&P 500', assetClass: 'equity' }],
      riskRangeRows: [
        { date: '2026-08-20', ticker: 'Technology Select Sector (XLK)' },
      ],
      snapshots: [
        {
          date: '2026-08-21',
          snapshotType: 'risk-ranges',
          data: {
            NVDA: { originalName: 'Nvidia', trend: 'Bullish' },
          },
        },
        {
          date: '2026-08-21',
          snapshotType: 'real-time-alert',
          data: { alerts: [{ ticker: 'CRWD', name: 'CrowdStrike' }] },
        },
        {
          date: '2026-08-21',
          snapshotType: 'the-call',
          data: { longs: ['MRVL', 'ABCD'] },
          article: { bodyText: 'Explicit research reference to Example ($EXMPL).' },
        },
      ],
    });

    const rows = Object.fromEntries(universe.rows.map((row) => [row.ticker, row]));
    expect(rows.SPY.discoveryState).toBe('catalogued');
    expect(rows.NVDA.discoveryState).toBe('structured');
    expect(rows.CRWD.discoveryState).toBe('structured');
    expect(rows.XLK.discoveryState).toBe('structured');
    expect(rows.MRVL.discoveryState).toBe('candidate');
    expect(rows.ABCD.discoveryState).toBe('candidate');
    expect(rows.EXMPL.discoveryState).toBe('candidate');
    expect(rows.MRVL.analysisEligible).toBe(false);
    expect(rows.MRVL.hedgeEligible).toBe(false);
    expect(universe.historicalOnly).toBe(true);
    expect(universe.executable).toBe(false);
  });

  test('uses The Call declared positions and discards prose leaked into parser lists', () => {
    const bodyText = [
      'Morning research note',
      'HEDGEYE POSITIONS',
      'LONGS: BABA, $JD-LON, $5930.KR',
      'SHORTS: BALL',
      'NEUTRAL: PDD',
      'We talked ABOUT ADIDAS and THE consumer backdrop after the position list.',
    ].join('\n');
    expect(parseTheCallDeclaredPositions(bodyText)).toEqual({
      longs: ['BABA', 'JD', '5930.KR'],
      shorts: ['BALL'],
      neutrals: ['PDD'],
    });

    const universe = buildHedgeyeSecurityUniverse({
      snapshots: [{
        date: '2025-09-02',
        snapshotType: 'the-call',
        data: {
          longs: ['BABA', 'JD', 'LON', '5930.KR'],
          shorts: ['BALL'],
          neutrals: ['PDD', 'ABOUT', 'ADIDAS', 'THE'],
        },
        article: { bodyText },
      }],
    });
    const rows = Object.fromEntries(universe.rows.map((row) => [row.ticker, row]));

    expect(rows.BABA).toEqual(expect.objectContaining({
      discoveryState: 'structured',
      confidence: 'high',
    }));
    expect(rows.BABA.confidenceKinds).toContain('declared_position');
    expect(rows.BALL.discoveryState).toBe('structured');
    expect(rows.JD.discoveryState).toBe('structured');
    expect(rows.LON).toBeUndefined();
    expect(rows.PDD.discoveryState).toBe('structured');
    expect(rows['5930.KR'].discoveryState).toBe('structured');
    expect(rows.ABOUT).toBeUndefined();
    expect(rows.ADIDAS).toBeUndefined();
    expect(rows.THE).toBeUndefined();
  });

  test('retains a clean The Call parser list when the declared section is unavailable', () => {
    const universe = buildHedgeyeSecurityUniverse({
      snapshots: [{
        date: '2026-08-21',
        snapshotType: 'the-call',
        data: { longs: ['MRVL'], neutrals: ['PDD'] },
        article: { bodyText: 'Archive body unavailable.' },
      }],
    });
    const rows = Object.fromEntries(universe.rows.map((row) => [row.ticker, row]));

    expect(rows.MRVL.discoveryState).toBe('candidate');
    expect(rows.PDD.discoveryState).toBe('candidate');
  });

  test('repairs the audited Aritzia listing and rejects chip-model variants as securities', () => {
    const universe = buildHedgeyeSecurityUniverse({
      snapshots: [
        {
          date: '2026-06-30',
          snapshotType: 'the-call',
          data: { longs: ['GLAS', 'SXT', 'ATZ', 'TO'] },
          article: { bodyText: 'Archive body unavailable.' },
        },
        {
          date: '2025-08-12',
          snapshotType: 'the-call',
          article: {
            bodyText: 'Long – NVIDIA Corporation (NVDA): Blackwell chips (B30/B40).',
          },
        },
      ],
    });
    const rows = Object.fromEntries(universe.rows.map((row) => [row.ticker, row]));

    expect(rows['ATZ.TO']).toEqual(expect.objectContaining({
      discoveryState: 'candidate',
      mentionCount: 1,
    }));
    expect(rows.ATZ).toBeUndefined();
    expect(rows.TO).toBeUndefined();
    expect(rows.NVDA).toBeDefined();
    expect(rows.B30).toBeUndefined();
    expect(rows.B40).toBeUndefined();
  });

  test.each([
    'TICKERS DISCUSSED',
    'SECTOR POSITION MONITOR',
  ])('supports the archived The Call %s heading', (heading) => {
    const universe = buildHedgeyeSecurityUniverse({
      snapshots: [{
        date: '2026-08-20',
        snapshotType: 'the-call',
        data: {
          longs: ['ADS', 'DE', 'WYFI'],
          shorts: [],
          neutrals: ['DOL', 'TO', 'ABOUT'],
        },
        article: {
          bodyText: [
            heading,
            'LONGS: $ADS.DE, WYFI (Pre IPO)',
            'SHORTS: NONE',
            'NEUTRAL: $DOL.TO, $005930.KS',
          ].join('\n'),
        },
      }],
    });
    const rows = Object.fromEntries(universe.rows.map((row) => [row.ticker, row]));

    expect(rows['ADS.DE'].discoveryState).toBe('structured');
    expect(rows.WYFI.discoveryState).toBe('structured');
    expect(rows['DOL.TO'].discoveryState).toBe('structured');
    expect(rows['005930.KS'].discoveryState).toBe('structured');
    expect(rows.ADS).toBeUndefined();
    expect(rows.DE).toBeUndefined();
    expect(rows.DOL).toBeUndefined();
    expect(rows.TO).toBeUndefined();
    expect(rows.ABOUT).toBeUndefined();
  });

  test('bounds Macro Show positions to its TLDR declaration or clean raw paragraph', () => {
    const snapshot = {
      date: '2026-08-21',
      snapshotType: 'the-macro-show',
      data: {
        longs: ['Gold (AAAU)', 'Euro (EUR)', 'not of any strength'],
        shorts: ['U.S. Dollar (USD)', 'CLICK HERE TO WATCH'],
        neutrals: [],
        rawLongsText: 'Gold (AAAU), Euro (EUR)',
        rawShortsText: 'U.S. Dollar (USD)\n\nThe summary and positions listed here...',
        rawNeutralText: '',
      },
      article: {
        bodyText: [
          'TL;DR – POSITIONS MENTIONED',
          'BULLISH : Gold (AAAU), Euro (EUR), Energy equities (XLE)',
          'BEARISH : U.S. Dollar (USD), Qatar Equities (QAT)',
          'The summary and positions listed here reflect commentary.',
        ].join('\n'),
      },
    };
    expect(parseMacroShowDeclaredPositions(snapshot)).toEqual({
      longs: ['AAAU', 'EUR', 'XLE'],
      shorts: ['USD', 'QAT'],
      neutrals: [],
    });

    const universe = buildHedgeyeSecurityUniverse({ snapshots: [snapshot] });
    const rows = Object.fromEntries(universe.rows.map((row) => [row.ticker, row]));
    expect(Object.keys(rows).sort()).toEqual(['AAAU', 'EUR', 'QAT', 'USD', 'XLE']);
    expect(rows.AAAU.discoveryState).toBe('structured');
    expect(rows.CLICK).toBeUndefined();
    expect(rows.GOLD).toBeUndefined();
  });

  test('aggregates repeated evidence without losing source-product provenance', () => {
    const universe = buildHedgeyeSecurityUniverse({
      snapshots: [
        { date: '2026-08-20', snapshotType: 'signal-strength', data: { stocks: [{ ticker: 'DDOG' }] } },
        { date: '2026-08-21', snapshotType: 'real-time-alert', data: { alert: { ticker: 'DDOG' } } },
      ],
    });
    const row = universe.rows.find((candidate) => candidate.ticker === 'DDOG');
    expect(row.mentionCount).toBe(2);
    expect(row.pullCount).toBe(2);
    expect(row.firstSeen).toBe('2026-08-20');
    expect(row.lastSeen).toBe('2026-08-21');
    expect(row.products.map((source) => source.product)).toEqual([
      'real-time-alert',
      'signal-strength',
    ]);
  });

  test('never promotes Hedgeye payload labels into the canonical security name', () => {
    const universe = buildHedgeyeSecurityUniverse({
      snapshots: [{
        date: '2026-08-21',
        snapshotType: 'real-time-alert',
        data: {
          alerts: [
            { ticker: 'BABA', name: 'Real-Time Alert' },
            { ticker: 'BALL', name: 'Real-Time Alert' },
          ],
        },
      }],
      seedSecurities: [{ ticker: 'SPY', name: 'S&P 500', assetClass: 'equity' }],
    });
    const rows = Object.fromEntries(universe.rows.map((row) => [row.ticker, row]));

    expect(rows.BABA.name).toBeNull();
    expect(rows.BALL.name).toBeNull();
    expect(rows.SPY).toEqual(expect.objectContaining({
      name: 'S&P 500',
      catalogName: 'S&P 500',
      nameSource: 'Dashboard security catalog',
    }));
  });
});
