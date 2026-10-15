import { getSecurityQuadPlaybookRanking, rankExposureQuads } from './quadPlaybookRanking';
import { getExposureDefinition } from '../constants/quadExposureCatalog';

describe('four-quad factor ordering', () => {
  test('ranks OIH using Energy chart placement, including an unlisted quad', () => {
    const result = getSecurityQuadPlaybookRanking({ symbol: 'OIH', conid: 415578515 });
    expect(result.status).toBe('ranked');
    expect(result.exposure.label).toBe('Energy');
    expect(result.ranking.orderText).toBe('3 → 2 → 1 → 4');
    expect(result.ranking.fits).toEqual([
      { quad: 3, status: 'best', rank: 2 },
      { quad: 2, status: 'best', rank: 4 },
      { quad: 1, status: 'not-listed', rank: null },
      { quad: 4, status: 'worst', rank: 1 },
    ]);
  });

  test('places Worst #1 last, rather than treating it as the strongest rank', () => {
    expect(getSecurityQuadPlaybookRanking('TLT').ranking.orderText).toBe('4 → 3 → 1 → 2');
    expect(getSecurityQuadPlaybookRanking('XLV').ranking.orderText).toBe('4 → 3 → 2 → 1');
  });

  test('keeps equal listed ranks and unlisted quads tied', () => {
    expect(getSecurityQuadPlaybookRanking('XLK').ranking.orderText).toBe('1 = 2 → 3 → 4');
    expect(getSecurityQuadPlaybookRanking('GLD').ranking.orderText).toBe('3 → 4 → 1 = 2');
    expect(getSecurityQuadPlaybookRanking('XLU').ranking.groups.at(-1)).toEqual([
      { quad: 1, status: 'worst', rank: 1 },
      { quad: 2, status: 'worst', rank: 1 },
    ]);
  });

  test('does not reverse a security rank when the portfolio shorts it', () => {
    const long = getSecurityQuadPlaybookRanking({ symbol: 'OIH', quantity: 10 });
    const short = getSecurityQuadPlaybookRanking({ symbol: 'OIH', quantity: -10 });
    expect(short.ranking).toEqual(long.ranking);
  });

  test('uses the primary mandate rather than averaging secondary factor ranks', () => {
    const result = getSecurityQuadPlaybookRanking('JOET');
    expect(result.exposure.label).toBe('Momentum');
    expect(result.profile.secondaryExposureIds).toContain(getExposureDefinition('Quality').id);
    expect(result.ranking.orderText).toBe('1 = 3 → 2 → 4');
  });

  test('keeps commodity exposure separate from producer equities and daily leverage', () => {
    expect(getSecurityQuadPlaybookRanking('UNG').exposure.label).toBe('Commodities');
    expect(getSecurityQuadPlaybookRanking('SRUUF').exposure.label).toBe('Commodities');
    expect(getSecurityQuadPlaybookRanking('OIH').exposure.label).toBe('Energy');
    expect(getSecurityQuadPlaybookRanking('UGL').ranking.orderText)
      .toBe(getSecurityQuadPlaybookRanking('GLD').ranking.orderText);
    expect(getSecurityQuadPlaybookRanking('UNHG').ranking.orderText)
      .toBe(getSecurityQuadPlaybookRanking('UNH').ranking.orderText);
  });

  test('reviews ticker identity and nonstandard fund mandates explicitly', () => {
    expect(getSecurityQuadPlaybookRanking({ symbol: 'MICC', conid: 836365978 }).exposure.label)
      .toBe('Consumer Staples');
    expect(getSecurityQuadPlaybookRanking({ symbol: 'SUJA', conid: 880601785 }).exposure.label)
      .toBe('Consumer Staples');
    expect(getSecurityQuadPlaybookRanking('AMZN').exposure.label).toBe('Consumer Discretionary');
    expect(getSecurityQuadPlaybookRanking('AMDY').exposure.label).toBe('Tech');
    expect(getSecurityQuadPlaybookRanking('JOJO').exposure.label).toBe('Fixed Income');
  });

  test.each(['IBIT', 'DBMF'])('does not manufacture a backtest rank for %s', symbol => {
    const result = getSecurityQuadPlaybookRanking(symbol);
    expect(result.profile.classificationStatus).toBe('reviewed');
    expect(result.status).toBe('not-covered');
    expect(result.ranking).toBeNull();
    expect(result.reason).toMatch(/not covered/);
  });

  test('unknown symbols remain unclassified even when supplied with a guessed sector', () => {
    const result = getSecurityQuadPlaybookRanking({ symbol: 'NOT-A-SECURITY', sector: 'Energy' });
    expect(result.status).toBe('unclassified');
    expect(result.ranking).toBeNull();
    expect(rankExposureQuads('made-up-factor')).toBeNull();
  });
});
