const {
  computeFlexExposure,
  parseFlexResponse,
  parseFlexStatement,
} = require('./ibkrFlexExposure.cjs');

const sampleStatementXml = `
<FlexQueryResponse>
  <FlexStatements>
    <FlexStatement accountId="U25779973" fromDate="2026-06-23" toDate="2026-06-23" currency="USD">
      <NetAssetValueByCurrency currency="USD" total="100000" />
      <CashReport currency="USD" endingCash="35000" />
      <OpenPositions>
        <OpenPosition symbol="SPY" assetCategory="STK" quantity="100" marketValue="70000" currency="USD" />
        <OpenPosition symbol="QQQ" assetCategory="STK" quantity="-50" marketValue="-25000" currency="USD" />
      </OpenPositions>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>`;

describe('IBKR Flex exposure parser', () => {
  test('parses Flex SendRequest response metadata', () => {
    const response = parseFlexResponse(`
      <FlexStatementResponse>
        <Status>Success</Status>
        <ReferenceCode>ABC123</ReferenceCode>
      </FlexStatementResponse>
    `);

    expect(response.status).toBe('Success');
    expect(response.referenceCode).toBe('ABC123');
  });

  test('parses positions, cash, NLV, and exposure metrics from an Activity Flex statement', () => {
    const parsed = parseFlexStatement(sampleStatementXml);

    expect(parsed.accountId).toBe('U25779973');
    expect(parsed.reportDate).toBe('2026-06-23');
    expect(parsed.positionCount).toBe(2);
    expect(parsed.exposure.hasData).toBe(true);
    expect(parsed.exposure.nlv).toBe(100000);
    expect(parsed.exposure.cashValue).toBe(35000);
    expect(parsed.exposure.longMV).toBe(70000);
    expect(parsed.exposure.shortMV).toBe(25000);
    expect(parsed.exposure.grossPct).toBeCloseTo(95);
    expect(parsed.exposure.netPct).toBeCloseTo(45);
    expect(parsed.exposure.equityCashSurplus).toBe(30000);
    expect(parsed.exposure.longFundingGap).toBe(0);
  });

  test('computes a long funding gap without treating shorts as deployable cash', () => {
    const exposure = computeFlexExposure({
      nlv: 100000,
      cashValue: 10000,
      targetCashBufferPct: 5,
      positions: [
        { symbol: 'LONG', quantity: 1, marketValue: 108000 },
        { symbol: 'SHORT', quantity: -1, marketValue: -25000 },
      ],
    });

    expect(exposure.longPct).toBeCloseTo(108);
    expect(exposure.shortPct).toBeCloseTo(25);
    expect(exposure.grossPct).toBeCloseTo(133);
    expect(exposure.netPct).toBeCloseTo(83);
    expect(exposure.targetCashBuffer).toBe(5000);
    expect(exposure.equityCashSurplus).toBe(-8000);
    expect(exposure.longFundingGap).toBe(13000);
  });

  test('does not infer a reconciliation baseline when official NLV is missing', () => {
    const exposure = computeFlexExposure({
      cashValue: 10000,
      positions: [{ symbol: 'SPY', quantity: 1, marketValue: 50000 }],
    });

    expect(exposure.hasData).toBe(false);
    expect(exposure.nlv).toBeNull();
    expect(exposure.longPct).toBeNull();
    expect(exposure.longFundingGap).toBeNull();
  });
});
