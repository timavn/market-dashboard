const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  commitPredictionPnlBackfill,
  fetchFlexStatement,
  getReconciliation,
  publicConfigStatus,
  previewPredictionPnlBackfill,
  readFlexActivityTrades,
  syncFlexActivity,
} = require('./ibkrFlexService.cjs');

const originalEnv = { ...process.env };

function setFlexEnv(dataDir) {
  process.env.IBKR_FLEX_ENABLED = 'true';
  process.env.IBKR_FLEX_ACTIVITY_ENABLED = 'true';
  process.env.IBKR_FLEX_TOKEN = 'super-secret-flex-token';
  process.env.IBKR_FLEX_ACTIVITY_QUERY_ID = '123456';
  process.env.IBKR_FLEX_ACTIVITY_EXPECTED_ACCOUNTS = 'U25779973';
  process.env.IBKR_FLEX_ACTIVITY_USE_QUERY_PERIOD = 'false';
  process.env.IBKR_FLEX_DATA_DIR = dataDir;
  process.env.IBKR_FLEX_TARGET_CASH_BUFFER_PCT = '0';
}

function statementXml() {
  return `
    <FlexQueryResponse>
      <FlexStatements>
        <FlexStatement accountId="U25779973" fromDate="2026-06-23" toDate="2026-06-23" currency="USD">
          <NetAssetValueByCurrency currency="USD" total="100000" />
          <CashReport currency="USD" endingCash="20000" />
          <OpenPosition symbol="SPY" assetCategory="STK" quantity="100" marketValue="65000" currency="USD" />
          <OpenPosition symbol="QQQ" assetCategory="STK" quantity="-40" marketValue="-18000" currency="USD" />
          <Trade accountId="U25779973" assetCategory="FOP" symbol="ES" localSymbol="FES_082126_7700_YES" conid="913869765" putCall="C" buySell="BUY" quantity="500" tradePrice="0.28" ibCommission="-5" netCash="-145" tradeDate="20260623" dateTime="20260623;143000" execID="FLEX-1" transactionID="TX-1" />
        </FlexStatement>
      </FlexStatements>
    </FlexQueryResponse>`;
}

function completeActivityStatement(fromDate = '2026-01-01', toDate = '2026-01-31') {
  return `<FlexQueryResponse><FlexStatements><FlexStatement accountId="U25779973" fromDate="${fromDate}" toDate="${toDate}" currency="USD">
    <Trades levelOfDetail="EXECUTION"><Trade accountId="U25779973" conid="913869765" symbol="FES" localSymbol="FES_082126_7700_YES" exchange="FORECASTX" putCall="C" buySell="BUY" quantity="10" tradePrice="0.25" proceeds="-2.50" netCash="-2.60" costBasis="2.50" fifoPnlRealized="0" ibCommission="-0.10" tradeDate="20260115" dateTime="20260115;100000" execID="E1" /></Trades>
    <Trades levelOfDetail="CLOSED_LOT"><Trade accountId="U25779973" conid="913869765" symbol="FES" localSymbol="FES_082126_7700_YES" exchange="FORECASTX" quantity="10" proceeds="10" costBasis="2.60" fifoPnlRealized="7.40" tradeID="L1" /></Trades>
    <OptionExercisesAssignmentsExpirations><OptionEAE accountId="U25779973" conid="913869765" symbol="FES" localSymbol="FES_082126_7700_YES" transactionType="Expiration" quantity="10" proceeds="10" costBasis="2.60" fifoPnlRealized="7.40" tradeID="O1" tradeDate="20260131" /></OptionExercisesAssignmentsExpirations>
    <CashTransactions><CashTransaction accountId="U25779973" conid="913869765" symbol="FES" amount="10" transactionID="C1" date="20260131" /></CashTransactions>
    <StatementOfFunds><StatementOfFundsLine accountId="U25779973" conid="913869765" symbol="FES" amount="10" transactionID="F1" date="20260131" /></StatementOfFunds>
    <OpenPositions><OpenPosition accountId="U25779973" conid="913869765" symbol="FES" quantity="0" marketValue="0" /></OpenPositions>
  </FlexStatement></FlexStatements></FlexQueryResponse>`;
}

function executionControlledActivityStatement(fromDate = '2026-01-01', toDate = '2026-01-31') {
  return `<FlexQueryResponse><FlexStatements><FlexStatement accountId="U25779973" fromDate="${fromDate}" toDate="${toDate}" currency="USD">
    <Trades><Trade levelOfDetail="EXECUTION" accountId="U25779973" conid="913869765" symbol="CPIY" localSymbol="CPIY_0126_3.5_YES" exchange="FORECASTX" putCall="C" buySell="BUY" quantity="10" tradePrice="0.25" proceeds="-2.50" netCash="-2.60" cost="2.50" fifoPnlRealized="0" ibCommission="-0.10" taxes="0" tradeDate="2026-01-15" dateTime="2026-01-15;100000" ibExecID="E1" tradeID="T1" />
    <Trade levelOfDetail="EXECUTION" accountId="U25779973" conid="913869765" symbol="CPIY" localSymbol="CPIY_0126_3.5_YES" exchange="FORECASTX" putCall="C" buySell="SELL" quantity="10" tradePrice="1" proceeds="10" netCash="10" cost="-2.60" fifoPnlRealized="7.40" ibCommission="0" taxes="0" tradeDate="2026-01-31" dateTime="2026-01-31;000000" ibExecID="N/A" tradeID="T2" transactionType="BookTrade" /></Trades>
    <OptionExercisesAssignmentsExpirations><OptionEAE accountId="U25779973" conid="913869765" symbol="CPIY" localSymbol="CPIY_0126_3.5_YES" transactionType="Expiration" quantity="10" proceeds="10" costBasis="2.60" fifoPnlRealized="7.40" tradeID="T2" tradeDate="2026-01-31" /></OptionExercisesAssignmentsExpirations>
    <CashTransactions><CashTransaction accountId="U25779973" conid="913869765" symbol="CPIY" amount="10" transactionID="C1" date="2026-01-31" /></CashTransactions>
    <StatementOfFunds><StatementOfFundsLine accountId="U25779973" conid="913869765" symbol="CPIY" amount="10" transactionID="F1" date="2026-01-31" /></StatementOfFunds>
    <OpenPositions><OpenPosition accountId="U25779973" conid="913869765" symbol="CPIY" quantity="0" marketValue="0" /></OpenPositions>
  </FlexStatement></FlexStatements></FlexQueryResponse>`;
}

describe('IBKR Flex service', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-flex-test-'));
    process.env = { ...originalEnv };
    setFlexEnv(dataDir);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('publishes Flex configuration status without exposing the token', () => {
    const status = publicConfigStatus();

    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.tokenConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain('super-secret-flex-token');
  });

  test('syncs, parses, stores, and reads a daily reconciliation snapshot', async () => {
    const requestTextImpl = jest.fn(async (url) => {
      const text = String(url);
      expect(text).toContain('t=super-secret-flex-token');
      if (text.includes('/SendRequest')) {
        return '<FlexStatementResponse><Status>Success</Status><ReferenceCode>ABC123</ReferenceCode></FlexStatementResponse>';
      }
      return statementXml();
    });

    const snapshot = await fetchFlexStatement({
      date: '2026-06-23',
      requestTextImpl,
      maxPolls: 1,
    });

    expect(snapshot.source).toBe('ibkr_flex_web_service');
    expect(snapshot.accountId).toBe('U25779973');
    expect(snapshot.exposure.longPct).toBeCloseTo(65);
    expect(snapshot.exposure.shortPct).toBeCloseTo(18);
    expect(snapshot.tradeCount).toBe(1);
    expect(requestTextImpl).toHaveBeenCalledTimes(2);

    const snapshotPath = path.join(dataDir, 'snapshots', '2026-06-23.json');
    const rawPath = path.join(dataDir, 'raw', '2026-06-23.xml');
    const reports = fs.readdirSync(path.join(dataDir, 'reports'));
    expect(fs.existsSync(rawPath)).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/^2026-06-23-[a-f0-9]{64}\.json$/);
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const reconciliation = getReconciliation({ date: '2026-06-23' });
    expect(reconciliation.status).toBe('ready');
    expect(reconciliation.flex.exposure.grossPct).toBeCloseTo(83);
    expect(reconciliation.flex.positions).toBeUndefined();
  });

  test('fetches a configured rolling query once and accepts only a covering statement window', async () => {
    const requestTextImpl = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/SendRequest')) {
        const parsed = new URL(text);
        expect(parsed.searchParams.has('fd')).toBe(false);
        expect(parsed.searchParams.has('td')).toBe(false);
        return '<FlexStatementResponse><Status>Success</Status><ReferenceCode>ROLLING123</ReferenceCode></FlexStatementResponse>';
      }
      return completeActivityStatement('2025-09-02', '2026-09-01');
    });

    const snapshot = await fetchFlexStatement({
      fromDate: '2026-01-01',
      toDate: '2026-09-01',
      useQueryPeriod: true,
      requestTextImpl,
      maxPolls: 1,
    });

    expect(snapshot).toMatchObject({
      fromDate: '2025-09-02',
      toDate: '2026-09-01',
      date: '2026-09-01',
    });
    expect(requestTextImpl).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(dataDir, 'snapshots', '2025-09-02_2026-09-01.json'))).toBe(true);
  });

  test('reports disabled reconciliation without returning stale live data', () => {
    process.env.IBKR_FLEX_ENABLED = 'false';
    process.env.IBKR_FLEX_ACTIVITY_ENABLED = 'false';

    const reconciliation = getReconciliation({ date: '2026-06-23' });

    expect(reconciliation.status).toBe('disabled');
    expect(reconciliation.flex).toBeNull();
    expect(readFlexActivityTrades()).toMatchObject({ status: 'disabled', complete: false, trades: [] });
  });

  test('bootstraps activity from January 1 and then advances idempotently', async () => {
    let activeRange = null;
    const requestTextImpl = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/SendRequest')) {
        const parsed = new URL(text);
        const format = (value) => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
        activeRange = { fromDate: format(parsed.searchParams.get('fd')), toDate: format(parsed.searchParams.get('td')) };
        return '<FlexStatementResponse><Status>Success</Status><ReferenceCode>ABC123</ReferenceCode></FlexStatementResponse>';
      }
      return statementXml()
        .replace('fromDate="2026-06-23"', `fromDate="${activeRange.fromDate}"`)
        .replace('toDate="2026-06-23"', `toDate="${activeRange.toDate}"`);
    });
    const first = await syncFlexActivity({ throughDate: '2026-06-23', requestTextImpl, maxPolls: 1 });
    expect(first).toMatchObject({ status: 'synced', fromDate: '2026-01-01', toDate: '2026-06-23' });
    expect(String(requestTextImpl.mock.calls[0][0])).toContain('fd=20260101');
    expect(String(requestTextImpl.mock.calls[0][0])).toContain('td=20260131');
    expect(first.snapshots).toHaveLength(6);
    const second = await syncFlexActivity({ throughDate: '2026-06-23', requestTextImpl, maxPolls: 1 });
    expect(second).toMatchObject({ status: 'synced', fromDate: '2026-06-17', toDate: '2026-06-23' });
    expect(String(requestTextImpl.mock.calls[12][0])).toContain('fd=20260617');
    expect(requestTextImpl).toHaveBeenCalledTimes(14);
  });

  test('approves automatic activity sync only after complete zero-difference preview controls', async () => {
    const requestTextImpl = jest.fn(async (url) => (
      String(url).includes('/SendRequest')
        ? '<FlexStatementResponse><Status>Success</Status><ReferenceCode>ABC123</ReferenceCode></FlexStatementResponse>'
        : completeActivityStatement()
    ));
    const preview = await previewPredictionPnlBackfill({
      fromDate: '2026-01-01',
      throughDate: '2026-01-31',
      requestTextImpl,
      maxPolls: 1,
    });
    expect(preview).toMatchObject({
      complete: true,
      missingSections: [],
      controls: { zeroToCent: true, consolidatedDifference: 0 },
    });
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(publicConfigStatus().automaticSyncApproved).toBe(false);
    const committed = commitPredictionPnlBackfill(preview.previewHash);
    expect(committed).toMatchObject({ status: 'committed', previewHash: preview.previewHash });
    expect(publicConfigStatus()).toMatchObject({
      automaticSyncApproved: true,
      accountsCovered: [expect.stringMatching(/^U\*+73$/)],
      reconciliationDifferences: { consolidated: 0 },
    });
  });

  test('accepts broker execution accounting when IBKR omits the selected Closed Lots block', async () => {
    const requestTextImpl = jest.fn(async (url) => (
      String(url).includes('/SendRequest')
        ? '<FlexStatementResponse><Status>Success</Status><ReferenceCode>ABC123</ReferenceCode></FlexStatementResponse>'
        : executionControlledActivityStatement()
    ));

    const preview = await previewPredictionPnlBackfill({
      fromDate: '2026-01-01',
      throughDate: '2026-01-31',
      requestTextImpl,
      maxPolls: 1,
    });
    const history = readFlexActivityTrades({ accountId: 'U25779973' });

    expect(preview).toMatchObject({
      complete: true,
      reportedSections: { closedLots: false },
      sections: { closedLots: true },
      sectionAlternatives: { closedLots: 'execution_accounting' },
      controls: {
        zeroToCent: true,
        consolidatedDifference: 0,
        accounts: [expect.objectContaining({
          mode: 'execution_accounting',
          executionAccountingComplete: true,
          unmatchedOptionEventCount: 0,
        })],
      },
    });
    expect(history).toMatchObject({
      status: 'ready',
      complete: true,
      sectionAlternatives: { closedLots: 'execution_accounting' },
      fetchedAt: expect.any(String),
      snapshotId: expect.stringMatching(/^flex-[a-f0-9]{32}$/),
    });
    expect(publicConfigStatus()).toMatchObject({
      requiredSectionCoverage: { closedLots: true },
      reportedSectionCoverage: { closedLots: false },
      sectionAlternatives: { closedLots: 'execution_accounting' },
    });
    expect(history.trades).toHaveLength(2);
  });
});
