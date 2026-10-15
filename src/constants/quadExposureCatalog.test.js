import expectedValuesData from './expectedValuesData';
import { SECURITIES_LIST } from './securitiesList';
import {
  CONID_SECURITY_PROFILE_OVERRIDES,
  EXPOSURE_CLASSIFICATION_VERSION,
  EXPOSURE_DEFINITIONS,
  EXPOSURE_LIST,
  HEDGEYE_EXPOSURE_LIST,
  LIVE_BOOK_SECURITY_PROFILES,
  QUAD_PLAYBOOK,
  SECURITY_EXPOSURE_PROFILES,
  getExposureDefinition,
  getExposureQuadFit,
  normalizeQuadKey,
  resolveSecurityExposureProfile,
} from './quadExposureCatalog';

const CURRENT_LIVE_BOOK_SYMBOLS = [
  'FAB', 'QAT', 'URI', 'VOOG', 'RSP', 'CLOX', 'DDS', 'PTF', 'SUJA', 'BRKR',
  'HCA', 'ENZL', 'CPER', 'CZR', 'FISV', 'HSY', 'WMT', 'NOBL', 'EWZ', 'DESK',
  'EWY', 'MEME', 'CLOZ', 'DDOG', 'EWH', 'XLU', 'EIS', 'EWQ', 'XLV', 'XLK',
  'COLO', 'VTIP', 'BUG', 'XLE', 'EWG', 'LLY', 'VYM', 'UNH', 'EWUS', 'INDA',
  'IAK', 'EPHE', 'XLRE', 'IDX', 'PSKY', 'CRWD', 'KTB', 'EQRR', 'IPAY',
];

const SEPTEMBER_BOOK_SYMBOLS = [
  'CLOZ', 'YCL', 'SNOW', 'FRPT', 'DBMF', 'QAT', 'XLU', 'RXL', 'UNG', 'AMZN',
  'JOET', 'SAIA', 'COLO', 'PTF', 'LLYX', 'FXH', 'JPM', 'SUJA', 'EWP', 'TXG',
  'PRN', 'GDX', 'MSFT', 'R', 'IGV', 'EZA', 'TLT', 'ZROZ', 'UGL', 'PFSI',
  'RDNT', 'TTD', 'ENZL', 'WEAT', 'BRZU', 'IBIT', 'CSX', 'WMT', 'MSOS', 'UNHG',
  'XBI', 'AMDY', 'JETS', 'PCAR', 'HYG', 'JOJO', 'SRUUF', 'EXPGY', 'PBD', 'MICC',
  'DKS', 'CRWD', 'LVHI', 'FAS', 'OIH', 'IPAY', 'EMIF', 'SJM',
];

const EXPECTED_VALUE_FIELDS = {
  assetClasses: ['bestAssetClasses', 'worstAssetClasses'],
  equitySectors: ['bestEquitySectors', 'worstEquitySectors'],
  equityStyleFactors: ['bestEquityStyleFactors', 'worstEquityStyleFactors'],
  fixedIncomeSectors: ['bestFixedIncomeSectors', 'worstFixedIncomeSectors'],
};

describe('QUAD_PLAYBOOK', () => {
  test('limits the Hedgeye table catalog to exactly the worksheet labels', () => {
    const worksheetLabels = new Set(expectedValuesData.quadData.flatMap(quad => (
      Object.values(EXPECTED_VALUE_FIELDS).flatMap(fields => fields.flatMap(field => quad[field].split(', ')))
    )));
    expect(HEDGEYE_EXPOSURE_LIST).toHaveLength(45);
    expect(new Set(HEDGEYE_EXPOSURE_LIST.map(exposure => exposure.label))).toEqual(worksheetLabels);
  });

  test('preserves every ordered best/worst list from expectedValuesData', () => {
    expectedValuesData.quadData.forEach((expectedQuad, index) => {
      const quad = QUAD_PLAYBOOK[`q${index + 1}`];
      expect(quad.quad).toBe(expectedQuad.quad);

      Object.entries(EXPECTED_VALUE_FIELDS).forEach(([dimension, [bestField, worstField]]) => {
        expect(quad[dimension].best).toEqual(expectedQuad[bestField].split(', '));
        expect(quad[dimension].worst).toEqual(expectedQuad[worstField].split(', '));
      });
    });
  });

  test('has stable unique ids and a complete fit for each quad', () => {
    const ids = EXPOSURE_LIST.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);

    EXPOSURE_LIST.forEach((definition) => {
      expect(definition.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(['assetClasses', 'equitySectors', 'equityStyleFactors', 'fixedIncomeSectors'])
        .toContain(definition.dimension);

      ['q1', 'q2', 'q3', 'q4'].forEach((quadKey) => {
        const fit = definition.quadFits[quadKey];
        expect(['best', 'worst', 'not-listed']).toContain(fit.status);
        const rankedValue = expect.any(Number);
        expect(fit.rank).toEqual(fit.status === 'not-listed' ? null : rankedValue);
        expect(fit.rank === null || fit.rank > 0).toBe(true);
      });
    });
  });

  test('normalizes quad inputs and resolves aliases without fabricating unknowns', () => {
    expect(normalizeQuadKey('Quad 3: Stagflation')).toBe('q3');
    expect(normalizeQuadKey('Q2')).toBe('q2');
    expect(normalizeQuadKey(4)).toBe('q4');
    expect(normalizeQuadKey('Quad 9')).toBeNull();

    expect(getExposureDefinition('REITs', 'equitySectors')?.label).toBe('REITS');
    expect(getExposureDefinition('EM USD Debt', 'fixedIncomeSectors')?.label).toBe('EM $ Debt');
    expect(getExposureDefinition('made-up-factor')).toBeNull();
  });

  test('marks Credit best in Q2 and worst in Q3', () => {
    expect(getExposureQuadFit('Credit', 'q2', 'assetClasses')).toEqual({
      status: 'best',
      rank: 3,
    });
    expect(getExposureQuadFit('Credit', 'q3', 'assetClasses')).toEqual({
      status: 'worst',
      rank: 1,
    });
  });
});

describe('reviewed security exposure profiles', () => {
  const expectValidReviewedProfile = (profile, symbol) => {
    expect(profile).toEqual(expect.objectContaining({
      symbol,
      classificationStatus: 'reviewed',
      classificationSource: 'curated',
      classificationVersion: EXPOSURE_CLASSIFICATION_VERSION,
    }));
    expect(EXPOSURE_DEFINITIONS[profile.primaryExposureId]).toBeDefined();
    expect(new Set(profile.secondaryExposureIds).size).toBe(profile.secondaryExposureIds.length);
    expect(profile.secondaryExposureIds).not.toContain(profile.primaryExposureId);
    profile.secondaryExposureIds.forEach((id) => {
      expect(EXPOSURE_DEFINITIONS[id]).toBeDefined();
    });
  };

  test('covers every September portfolio security with a reviewed primary exposure', () => {
    expect(SEPTEMBER_BOOK_SYMBOLS).toHaveLength(58);
    SEPTEMBER_BOOK_SYMBOLS.forEach(symbol => {
      const profile = resolveSecurityExposureProfile(symbol);
      expectValidReviewedProfile(profile, symbol);
      expect(getExposureDefinition(profile.primaryExposureId)).not.toBeNull();
    });
  });

  test('covers all 119 securities in the dashboard universe', () => {
    expect(SECURITIES_LIST).toHaveLength(119);
    expect(new Set(SECURITIES_LIST.map(({ ticker }) => ticker)).size).toBe(119);

    SECURITIES_LIST.forEach(({ ticker }) => {
      expectValidReviewedProfile(resolveSecurityExposureProfile(ticker), ticker);
    });
  });

  test('explicitly covers every symbol in the current 49-security live book', () => {
    expect(CURRENT_LIVE_BOOK_SYMBOLS).toHaveLength(49);
    expect(Object.keys(LIVE_BOOK_SECURITY_PROFILES)).toEqual(
      expect.arrayContaining(CURRENT_LIVE_BOOK_SYMBOLS),
    );

    CURRENT_LIVE_BOOK_SYMBOLS.forEach((symbol) => {
      expectValidReviewedProfile(resolveSecurityExposureProfile({ symbol }), symbol);
    });
  });

  test('maps direct gold instruments and gold miners to the Gold lens', () => {
    ['GLD', 'GOLD', 'AAAU'].forEach((symbol) => {
      const profile = SECURITY_EXPOSURE_PROFILES[symbol];
      expect(getExposureDefinition(profile.primaryExposureId)?.label).toBe('Gold');
    });

    const gdx = resolveSecurityExposureProfile('GDX');
    const secondaryLabels = gdx.secondaryExposureIds.map((id) => EXPOSURE_DEFINITIONS[id].label);
    expect(getExposureDefinition(gdx.primaryExposureId)?.label).toBe('Materials');
    expect(secondaryLabels).toEqual(expect.arrayContaining(['Equities', 'Gold']));

    const xme = resolveSecurityExposureProfile('XME');
    expect(xme.secondaryExposureIds.map((id) => getExposureDefinition(id)?.label))
      .toContain('Gold');
  });

  test('uses contract identity to disambiguate the US-listed SUJA security', () => {
    const suja = resolveSecurityExposureProfile({ symbol: 'SUJA', conid: 880601785 });
    expect(getExposureDefinition(suja.primaryExposureId)?.label).toBe('Consumer Staples');
    expect(suja.secondaryExposureIds.map((id) => getExposureDefinition(id)?.label))
      .toEqual(expect.arrayContaining(['Equities', 'Secular Growth']));
  });

  test('classifies the payments-focused IPAY fund as Financials, not Tech', () => {
    const ipay = resolveSecurityExposureProfile('IPAY');
    expect(getExposureDefinition(ipay.primaryExposureId)?.label).toBe('Financials');
    expect(ipay.secondaryExposureIds.map((id) => getExposureDefinition(id)?.label))
      .toEqual(expect.arrayContaining(['Equities', 'Secular Growth']));
  });

  test('captures reviewed factor, country-sector, and CLO overlap lenses', () => {
    const labelsFor = (symbol) => {
      const profile = resolveSecurityExposureProfile(symbol);
      return [profile.primaryExposureId, ...profile.secondaryExposureIds]
        .map((id) => getExposureDefinition(id)?.label);
    };

    expect(labelsFor('RSP')).toEqual(expect.arrayContaining(['Equities', 'Value', 'Size']));
    expect(labelsFor('RSP')).not.toContain('Cyclical Growth');
    expect(labelsFor('QAT')).toContain('Financials');
    expect(labelsFor('EWQ')).toContain('Industrials');
    expect(labelsFor('IDX')).toEqual(
      expect.arrayContaining(['Equities', 'Financials', 'Commodities']),
    );
    expect(labelsFor('CLOX')).toEqual(
      expect.arrayContaining(['IG Credit', 'Credit', 'Leveraged Loans']),
    );
    expect(labelsFor('CLOZ')).toEqual(
      expect.arrayContaining(['HY Credit', 'IG Credit', 'Credit', 'Leveraged Loans']),
    );
  });

  test('does not turn agency MBS into the corporate Credit transition lens', () => {
    const mbb = resolveSecurityExposureProfile('MBB');
    const labels = [mbb.primaryExposureId, ...mbb.secondaryExposureIds]
      .map((id) => getExposureDefinition(id)?.label);
    expect(labels).toContain('MBS');
    expect(labels).toContain('Fixed Income');
    expect(labels).not.toContain('Credit');
  });

  test('returns an explicit unclassified profile for unknown symbols', () => {
    expect(CONID_SECURITY_PROFILE_OVERRIDES['880601785']).toBeDefined();
    expect(resolveSecurityExposureProfile({ symbol: 'NOT-A-SECURITY', conid: 123 })).toEqual({
      symbol: 'NOT-A-SECURITY',
      primaryExposureId: null,
      secondaryExposureIds: [],
      classificationStatus: 'unclassified',
      classificationSource: 'unmapped',
      classificationVersion: EXPOSURE_CLASSIFICATION_VERSION,
    });
  });
});
