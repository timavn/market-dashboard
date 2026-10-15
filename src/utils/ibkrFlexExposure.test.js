const {
  computeFlexExposure,
  parseFlexResponse,
  parseFlexStatement,
  parseFlexStatementDocument,
  normalizeFlexTrade,
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
  test('indexed account sections preserve mixed tag order, empty coverage, dates and timezone isolation', () => {
    const document = parseFlexResponse(`<FlexQueryResponse><FlexStatements>
      <FlexStatement accountId="TEST-A" fromDate="2026-03-08" toDate="2026-03-08" timeZone="America/New_York">
        <CashBalance cash="17"/><CashReport endingCash="99"/>
        <OpenPositions>
          <Position symbol="FIRST" quantity="1" marketValue="10"/>
          <OpenPosition symbol="SECOND" quantity="1" marketValue="20"/>
          <FxPosition symbol="THIRD" quantity="1" marketValue="30"/>
        </OpenPositions>
        <Trades levelOfDetail="EXECUTION"><Trade execID="A-1" symbol="TEST" conid="10" buySell="BUY" quantity="1" tradePrice="1" dateTime="20260308;033000"/></Trades>
        <Trades levelOfDetail="CLOSED_LOT"/>
        <OptionEAERecords/><CashTransactions/><StatementOfFunds/>
      </FlexStatement>
      <FlexStatement accountId="TEST-B" fromDate="2026-03-09" toDate="2026-03-09" timeZone="UTC">
        <OpenPositions/>
        <Trades levelOfDetail="EXECUTION"><Trade execID="B-1" symbol="TEST" conid="20" buySell="SELL" quantity="1" tradePrice="1" dateTime="20260309;033000"/></Trades>
      </FlexStatement>
    </FlexStatements></FlexQueryResponse>`).raw;
    const parsed = parseFlexStatementDocument(document);
    expect(parsed.accountIds).toEqual(['TEST-A', 'TEST-B']);
    expect(parsed.fromDate).toBe('2026-03-08');
    expect(parsed.toDate).toBe('2026-03-09');
    expect(parsed.accounts[0].positions.map(row => row.symbol)).toEqual(['FIRST', 'SECOND', 'THIRD']);
    expect(parsed.accounts[0].exposure.cashValue).toBe(17);
    expect(parsed.accounts[0].complete).toBe(true);
    expect(parsed.accounts[0].optionEvents).toEqual([]);
    expect(parsed.accounts[1].positions).toEqual([]);
    expect(parsed.accounts[1].complete).toBe(false);
    expect(parsed.accounts[1].sections.cashTransactions).toBe(false);
    expect(parsed.trades.map(row => [row.accountId, row.execId, row.executionTime])).toEqual([
      ['TEST-A', 'A-1', '2026-03-08T07:30:00.000Z'],
      ['TEST-B', 'B-1', '2026-03-09T03:30:00.000Z'],
    ]);
    expect(parsed.trades.every(row => row.source === 'ibkr_flex_import')).toBe(true);
  });

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

  test('normalizes prediction-market trades with broker IDs, fees, cash, and timestamps', () => {
    const trade = normalizeFlexTrade({
      accountId: 'U25779973', assetCategory: 'FOP', symbol: 'ES', localSymbol: 'FES_082126_7700_YES',
      conid: '913869765', putCall: 'C', buySell: 'BUY', quantity: '500', tradePrice: '0.28',
      ibCommission: '-5.00', netCash: '-145.00', proceeds: '-140.00', tradeDate: '20260821',
      dateTime: '20260821;143000', execID: 'FLEX-EXEC-1', transactionID: 'TX-1', orderID: '42',
    });
    expect(trade).toMatchObject({
      accountId: 'U25779973', execId: 'FLEX-EXEC-1', transactionId: 'TX-1', orderId: 42,
      conId: 913869765, contractSide: 'YES', direction: 'BUY', shares: 500, price: 0.28,
      commission: 5, netCash: -145, proceeds: -140, executionTime: '2026-08-21T18:30:00.000Z',
      source: 'ibkr_flex_import', brokerIdentifierStatus: 'reported',
    });
  });

  test('normalizes ISO-date Flex timestamps emitted by yyyy-MM-dd activity queries', () => {
    const trade = normalizeFlexTrade({
      accountId: 'U25779973', assetCategory: 'FOP', symbol: 'CPIY', localSymbol: 'CPIY_0626_3.6_NO',
      conid: '999000001', putCall: 'P', buySell: 'BUY', quantity: '16000', tradePrice: '0.061607',
      ibCommission: '0', ibCommissionCurrency: 'USD', netCash: '-985.71', proceeds: '-985.71', cost: '985.71',
      tradeDate: '2026-06-03', dateTime: '2026-06-03;163805', ibExecID: 'FLEX-ISO-1',
    });

    expect(trade).toMatchObject({
      execId: 'FLEX-ISO-1',
      contractSide: 'NO',
      brokerExecutionId: 'FLEX-ISO-1',
      costBasis: 985.71,
      commissionCurrency: 'USD',
      executionTime: '2026-06-03T20:38:05.000Z',
      tradeDate: '2026-06-03',
    });
  });

  test('parses separate execution/control sections for every account in a bundle', () => {
    const parsed = parseFlexStatement(`
      <FlexQueryResponse><FlexStatements>
        ${['U111', 'U222'].map((accountId) => `
          <FlexStatement accountId="${accountId}" fromDate="2026-01-01" toDate="2026-01-31" currency="USD">
            <Trades levelOfDetail="EXECUTION"><Trade accountId="${accountId}" conid="913869765" symbol="FES" localSymbol="FES_082126_7700_YES" exchange="FORECASTX" putCall="C" buySell="BUY" quantity="10" tradePrice="0.25" proceeds="-2.50" netCash="-2.60" costBasis="2.50" fifoPnlRealized="0" ibCommission="-0.10" tradeDate="20260115" dateTime="20260115;100000" execID="${accountId}-E1" tradeID="${accountId}-T1" openCloseIndicator="O" /></Trades>
            <Trades levelOfDetail="CLOSED_LOT"><Trade accountId="${accountId}" conid="913869765" symbol="FES" localSymbol="FES_082126_7700_YES" exchange="FORECASTX" quantity="10" proceeds="10" costBasis="2.60" fifoPnlRealized="7.40" tradeID="${accountId}-L1" /></Trades>
            <OptionExercisesAssignmentsExpirations><OptionEAE accountId="${accountId}" conid="913869765" symbol="FES" localSymbol="FES_082126_7700_YES" transactionType="Expiration" quantity="10" proceeds="10" costBasis="2.60" fifoPnlRealized="7.40" tradeID="${accountId}-O1" tradeDate="20260131" /></OptionExercisesAssignmentsExpirations>
            <CashTransactions><CashTransaction accountId="${accountId}" conid="913869765" symbol="FES" amount="10" transactionID="${accountId}-C1" date="20260131" /></CashTransactions>
            <StatementOfFunds><StatementOfFundsLine accountId="${accountId}" conid="913869765" symbol="FES" amount="10" transactionID="${accountId}-F1" date="20260131" /></StatementOfFunds>
            <OpenPositions><OpenPosition accountId="${accountId}" conid="913869765" symbol="FES" quantity="0" marketValue="0" /></OpenPositions>
          </FlexStatement>`).join('')}
      </FlexStatements></FlexQueryResponse>
    `);
    expect(parsed).toMatchObject({
      accountId: null,
      accountIds: ['U111', 'U222'],
      accountCount: 2,
      complete: true,
      sections: {
        executions: true, closedLots: true, optionEvents: true,
        cashTransactions: true, statementOfFunds: true, openPositions: true,
      },
      tradeCount: 2,
      closedLotCount: 2,
      optionEventCount: 2,
      cashTransactionCount: 2,
      statementOfFundsCount: 2,
    });
    expect(parsed.trades[0]).toMatchObject({
      costBasisMicros: 2500000,
      netCashMicros: -2600000,
      realizedPnlMicros: 0,
      openCloseIndicator: 'O',
    });
  });
});
