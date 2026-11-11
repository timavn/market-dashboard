const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  commitPredictionPnlBackfill,
  createFlexActivityReader,
  fetchFlexStatement,
  getReconciliation,
  publicConfigStatus,
  previewPredictionPnlBackfill,
  previewStoredPredictionPnlBackfill,
  readFlexActivityTrades,
  startFlexActivitySync,
  stopFlexActivitySync,
  syncFlexActivity,
  validateFlexActivitySnapshots,
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
    jest.useRealTimers();
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

  test.each([
    ['tax-lot revision', { costBasis: 8, costBasisMicros: 8000000, realizedPnl: 2, realizedPnlMicros: 2000000, openCloseIndicator: 'C' }, false],
    ['different price', { price: 0.99 }, true],
    ['different quantity', { shares: 11, quantity: 11 }, true],
    ['different fee', { commission: 0.2, commissionMicros: 200000 }, true],
    ['missing fee', { commission: null, commissionMicros: null }, true],
    ['different cash', { netCash: -3, netCashMicros: -3000000 }, true],
    ['different contract', { conId: 42 }, true],
    ['different currency', { commissionCurrency: 'EUR' }, true],
  ])('deduplicates overlapping reports safely: %s', async (_label, revision, conflict) => {
    const snapshot = await fetchFlexStatement({
      fromDate: '2026-01-01', toDate: '2026-01-31', date: '2026-01-31',
      requestTextImpl: async (url) => String(url).includes('/SendRequest')
        ? '<FlexStatementResponse><Status>Success</Status><ReferenceCode>TEST</ReferenceCode></FlexStatementResponse>'
        : completeActivityStatement(),
      maxPolls: 1,
    });
    const revised = {
      ...snapshot, fetchedAt: '2099-01-01T00:00:00Z',
      trades: snapshot.trades.map((trade) => ({ ...trade, ...revision, rawFingerprint: 'revised-report' })),
      // A legitimate realized-P&L revision must still reconcile to the broker's
      // latest closed-lot control; an unbalanced revision is tested separately.
      closedLots: snapshot.closedLots.map((lot) => ({
        ...lot,
        realizedPnl: lot.realizedPnl + (revision.realizedPnl || 0),
        realizedPnlMicros: lot.realizedPnlMicros + (revision.realizedPnlMicros || 0),
      })),
    };
    fs.writeFileSync(path.join(dataDir, 'snapshots', '2026-01-02.json'), JSON.stringify(revised));
    const history = readFlexActivityTrades({ accountId: 'U25779973' });
    expect(history.status).toBe(conflict ? 'conflict' : 'ready');
    expect(history.complete).toBe(!conflict);
    expect(history.conflicts).toHaveLength(conflict ? 1 : 0);
    const expectedRevision = expect.objectContaining({
      ...revision, price: 0.25, netCash: -2.6,
      reportFingerprints: [snapshot.trades[0].rawFingerprint, 'revised-report'],
    });
    expect(history.trades).toEqual(conflict ? [] : [expectedRevision]);
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

  test('decodes each fresh polling response once and does not reuse another statement account', async () => {
    const { XMLParser } = require('fast-xml-parser');
    const parse = jest.spyOn(XMLParser.prototype, 'parse');
    let accountId = 'TEST-A';
    const requestTextImpl = jest.fn(async url => String(url).includes('/SendRequest')
      ? '<FlexStatementResponse><Status>Success</Status><ReferenceCode>TEST-REF</ReferenceCode></FlexStatementResponse>'
      : statementXml().replaceAll('U25779973', accountId));
    try {
      const first = await fetchFlexStatement({ date: '2026-06-23', requestTextImpl, maxPolls: 1 });
      expect(parse).toHaveBeenCalledTimes(2);
      accountId = 'TEST-B';
      const second = await fetchFlexStatement({ date: '2026-06-23', requestTextImpl, maxPolls: 1 });
      expect(parse).toHaveBeenCalledTimes(4);
      expect(requestTextImpl).toHaveBeenCalledTimes(4);
      expect(first.accountIds).toEqual(['TEST-A']);
      expect(second.accountIds).toEqual(['TEST-B']);
      expect(first.reportHash).not.toBe(second.reportHash);
      expect(second.trades.every(trade => trade.accountId === 'TEST-B')).toBe(true);
      expect(second.source).toBe('ibkr_flex_web_service');
    } finally {
      parse.mockRestore();
    }
  });

  test('fetches a configured rolling query once and accepts only a covering statement window', async () => {
    const requestTextImpl = jest.fn(async (url) => {
      const text = String(url);
      if (text.includes('/SendRequest')) {
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
    const sendRequestUrl = new URL(requestTextImpl.mock.calls.find(([url]) => String(url).includes('/SendRequest'))[0]);
    expect(sendRequestUrl.searchParams.has('fd')).toBe(false);
    expect(sendRequestUrl.searchParams.has('td')).toBe(false);
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

  const rollingRequest = (xml) => jest.fn(async (url) => String(url).includes('/SendRequest')
    ? '<FlexStatementResponse><Status>Success</Status><ReferenceCode>ROLLING</ReferenceCode></FlexStatementResponse>'
    : xml);

  async function seedRollingHistory() {
    process.env.IBKR_FLEX_ACTIVITY_USE_QUERY_PERIOD = 'true';
    await syncFlexActivity({
      fromDate: '2026-01-01', throughDate: '2026-09-10', maxPolls: 1,
      requestTextImpl: rollingRequest(completeActivityStatement('2025-09-11', '2026-09-10')),
    });
  }

  test.each([
    ['Sunday', '2026-09-13T12:00:00Z'],
    ['Monday', '2026-09-14T12:00:00Z'],
    ['publication lag', '2026-09-15T12:00:00Z'],
  ])('automatic rolling sync keeps newly published history through its actual cutoff on %s', async (_label, now) => {
    jest.useFakeTimers({ now: new Date(now) });
    await seedRollingHistory();
    const requestTextImpl = rollingRequest(completeActivityStatement('2025-09-12', '2026-09-11'));

    const result = await syncFlexActivity({ requestTextImpl, maxPolls: 1 });

    expect(result).toMatchObject({ status: 'synced', toDate: '2026-09-11', coverage: {
      fromDate: '2026-01-01', toDate: '2026-09-11', contiguous: true,
    } });
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'activity-sync.json')));
    expect(state.lastThroughDate).toBe('2026-09-11');
    expect(readFlexActivityTrades()).toMatchObject({ status: 'ready', complete: true, toDate: '2026-09-11' });
    expect(readFlexActivityTrades({ expectedToDate: '2026-09-13' })).toMatchObject({ status: 'coverage_gap', complete: false });
    const sendUrl = new URL(requestTextImpl.mock.calls[0][0]);
    expect(sendUrl.searchParams.has('fd')).toBe(false);
    expect(sendUrl.searchParams.has('td')).toBe(false);
  });

  test.each([
    ['wrong account', (xml) => xml.replaceAll('U25779973', 'OTHER'), 'flex_statement_account_mismatch'],
    ['missing overlap', (xml) => xml.replace('fromDate="2025-09-12"', 'fromDate="2026-09-05"'), 'flex_statement_range_mismatch'],
    ['older history', (xml) => xml.replace('toDate="2026-09-11"', 'toDate="2026-09-09"'), 'flex_statement_range_mismatch'],
    ['missing section', (xml) => xml.replace(/<CashTransactions>.*?<\/CashTransactions>/s, ''), 'flex_activity_validation_failed'],
    ['accounting mismatch', (xml) => xml.replace('fifoPnlRealized="7.40" tradeID="L1"', 'fifoPnlRealized="8.40" tradeID="L1"'), 'flex_activity_validation_failed'],
  ])('automatic rolling sync rejects %s before storing it or advancing history', async (_label, change, code) => {
    jest.useFakeTimers({ now: new Date('2026-09-14T12:00:00Z') });
    await seedRollingHistory();
    const stateFile = path.join(dataDir, 'state', 'activity-sync.json');
    const beforeState = fs.readFileSync(stateFile, 'utf8');
    const beforeSnapshots = fs.readdirSync(path.join(dataDir, 'snapshots'));
    const beforeReports = fs.readdirSync(path.join(dataDir, 'reports'));

    await expect(syncFlexActivity({
      requestTextImpl: rollingRequest(change(completeActivityStatement('2025-09-12', '2026-09-11'))), maxPolls: 1,
    })).rejects.toMatchObject({ code });

    expect(fs.readFileSync(stateFile, 'utf8')).toBe(beforeState);
    expect(fs.readdirSync(path.join(dataDir, 'snapshots'))).toEqual(beforeSnapshots);
    expect(fs.readdirSync(path.join(dataDir, 'reports'))).toEqual(beforeReports);
  });

  test('automatic rolling sync rejects inconsistent per-account coverage', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-14T12:00:00Z') });
    await seedRollingHistory();
    process.env.IBKR_FLEX_ACTIVITY_EXPECTED_ACCOUNTS = 'U25779973,SECOND';
    const first = completeActivityStatement('2025-09-12', '2026-09-11');
    const second = completeActivityStatement('2025-09-12', '2026-09-10')
      .replaceAll('U25779973', 'SECOND').match(/<FlexStatement accountId=.*<\/FlexStatement>/s)[0];
    const xml = first.replace('</FlexStatements>', `${second}</FlexStatements>`);

    await expect(syncFlexActivity({ requestTextImpl: rollingRequest(xml), maxPolls: 1 }))
      .rejects.toMatchObject({ code: 'flex_statement_range_mismatch' });
    expect(publicConfigStatus().dateCoverage.toDate).toBe('2026-09-10');
  });

  test.each(['fetch', 'sync', 'backfill'])('explicit %s keeps strict requested coverage when the rolling report is behind', async (kind) => {
    process.env.IBKR_FLEX_ACTIVITY_USE_QUERY_PERIOD = 'true';
    const options = {
      fromDate: '2026-01-01', toDate: '2026-09-13', throughDate: '2026-09-13',
      requestTextImpl: rollingRequest(completeActivityStatement('2025-09-12', '2026-09-11')), maxPolls: 1,
    };
    const run = { fetch: fetchFlexStatement, sync: syncFlexActivity, backfill: previewPredictionPnlBackfill }[kind];

    await expect(run(options)).rejects.toMatchObject({ code: 'flex_statement_range_mismatch' });
    expect(fs.existsSync(path.join(dataDir, 'snapshots'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'state', 'activity-sync.json'))).toBe(false);
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

  async function storedFixture() {
    return fetchFlexStatement({
      fromDate: '2026-01-01', toDate: '2026-01-31', date: '2026-01-31',
      requestTextImpl: async (url) => String(url).includes('/SendRequest')
        ? '<FlexStatementResponse><Status>Success</Status><ReferenceCode>TEST</ReferenceCode></FlexStatementResponse>'
        : completeActivityStatement(),
      maxPolls: 1,
    });
  }

  test.each(['YES', 'NO'])('enriches missing native %s evidence and never downgrades it on a later report', async (side) => {
    const snapshot = await storedFixture();
    const trade = {
      ...snapshot.trades[0], contractSide: side,
      localSymbol: `FES_082126_7700_${side}`,
    };
    const missing = { ...snapshot, fetchedAt: '2026-02-01T00:00:00Z', trades: [{ ...trade, contractSide: null }] };
    const known = { ...snapshot, fetchedAt: '2026-02-02T00:00:00Z', trades: [trade] };
    const laterMissing = { ...missing, fetchedAt: '2026-02-03T00:00:00Z' };
    const inputs = [laterMissing, known, missing];
    const unchanged = JSON.stringify(inputs);
    Object.freeze(inputs);
    inputs.forEach((row) => { Object.freeze(row.trades[0]); Object.freeze(row.trades); Object.freeze(row); });
    const result = validateFlexActivitySnapshots(inputs, { accountId: 'U25779973' });
    expect(result).toMatchObject({ status: 'ready', complete: true, sideEnrichmentCount: 1, conflicts: [] });
    expect(result.trades).toEqual([expect.objectContaining({ contractSide: side })]);
    expect(JSON.stringify(inputs)).toBe(unchanged);
  });

  test.each([
    ['opposite known side', { contractSide: 'NO' }, { contractSide: 'YES' }],
    ['contradictory text', { contractSide: null, localSymbol: 'FES_082126_7700_NO' }, { contractSide: 'YES', localSymbol: 'FES_082126_7700_NO' }],
    ['unreported identifier', { contractSide: null, brokerIdentifierStatus: 'missing' }, { contractSide: 'YES', brokerIdentifierStatus: 'missing' }],
    ['unverified source', { contractSide: null, source: 'seed' }, { contractSide: 'YES', source: 'seed' }],
    ['missing fingerprint', { contractSide: null, rawFingerprint: null }, { contractSide: 'YES', rawFingerprint: null }],
    ['changed price with identical fingerprint', {}, { price: 0.8 }],
  ])('retains true conflicts: %s', async (_name, oldChange, newChange) => {
    const snapshot = await storedFixture();
    const old = { ...snapshot, fetchedAt: '2026-02-01T00:00:00Z', trades: [{ ...snapshot.trades[0], ...oldChange }] };
    const recent = { ...snapshot, fetchedAt: '2026-02-02T00:00:00Z', trades: [{ ...snapshot.trades[0], ...newChange }] };
    fs.writeFileSync(path.join(dataDir, 'snapshots', '2026-01-01.json'), JSON.stringify(old));
    fs.writeFileSync(path.join(dataDir, 'snapshots', '2026-01-02.json'), JSON.stringify(recent));
    const result = readFlexActivityTrades({ accountId: 'U25779973' });
    expect(result).toMatchObject({ status: 'conflict', complete: false, trades: [], conflictScope: {
      accountIds: ['U25779973'], conIds: [913869765], executionCount: 1,
    } });
    const preview = previewStoredPredictionPnlBackfill({ fromDate: '2026-01-01', throughDate: '2026-01-31', persist: true });
    expect(preview).toMatchObject({ complete: false, conflictScope: { executionCount: 1 } });
    expect(() => commitPredictionPnlBackfill(preview.previewHash)).toThrow(/incomplete/);
    expect(publicConfigStatus().automaticSyncApproved).toBe(false);
  });

  test('rejects an accounting mismatch equally in reader, stored preview and commit', async () => {
    const snapshot = await storedFixture();
    const changed = { ...snapshot, fetchedAt: '2099-01-01T00:00:00Z', trades: snapshot.trades.map((trade) => ({
      ...trade, realizedPnl: 2, realizedPnlMicros: 2000000,
    })) };
    fs.writeFileSync(path.join(dataDir, 'snapshots', '2026-01-02.json'), JSON.stringify(changed));
    expect(readFlexActivityTrades({ accountId: 'U25779973' })).toMatchObject({
      status: 'accounting_mismatch', complete: false, conflicts: [], controls: { zeroToCent: false },
    });
    const preview = previewStoredPredictionPnlBackfill({ fromDate: '2026-01-01', throughDate: '2026-01-31', persist: true });
    expect(preview.complete).toBe(false);
    expect(() => commitPredictionPnlBackfill(preview.previewHash)).toThrow(/does not reconcile/);
  });

  test('stored preview requires no provider configuration and performs no writes by default', async () => {
    await storedFixture();
    delete process.env.IBKR_FLEX_TOKEN;
    const writes = jest.spyOn(fs, 'writeFileSync');
    try {
      const preview = previewStoredPredictionPnlBackfill({ fromDate: '2026-01-01', throughDate: '2026-01-31' });
      expect(preview).toMatchObject({ complete: true, validationVersion: 2 });
      expect(preview.sourceManifest).toEqual([expect.objectContaining({
        name: expect.stringMatching(/\.json$/), sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })]);
      expect(writes).not.toHaveBeenCalled();
    } finally { writes.mockRestore(); }
  });

  test('commit rehashes normalized source bytes even when embedded report hashes are unchanged', async () => {
    await storedFixture();
    const preview = previewStoredPredictionPnlBackfill({ fromDate: '2026-01-01', throughDate: '2026-01-31', persist: true });
    const file = path.join(dataDir, 'snapshots', preview.sourceManifest[0].name);
    fs.appendFileSync(file, '\n');
    expect(() => commitPredictionPnlBackfill(preview.previewHash)).toThrow(/Stored Flex evidence changed/);
    expect(publicConfigStatus().automaticSyncApproved).toBe(false);
  });

  test('commit refuses altered preview coverage even when its stated hash and source files are unchanged', async () => {
    await storedFixture();
    const preview = previewStoredPredictionPnlBackfill({ fromDate: '2026-01-01', throughDate: '2026-01-31', persist: true });
    preview.coverage[0].accountId = 'U000';
    fs.writeFileSync(path.join(dataDir, 'previews', `${preview.previewHash}.json`), JSON.stringify(preview));
    expect(() => commitPredictionPnlBackfill(preview.previewHash)).toThrow(/stored preview was changed/);
    expect(publicConfigStatus().automaticSyncApproved).toBe(false);
  });

  test('memoizes unchanged source parsing, isolates caller mutations and invalidates on a new source', async () => {
    const snapshot = await storedFixture();
    const reader = createFlexActivityReader();
    const reads = jest.spyOn(fs, 'readFileSync');
    try {
      const first = reader.read({ accountId: 'U25779973' });
      expect(first.complete).toBe(true);
      const initialReads = reads.mock.calls.length;
      first.trades[0].contractSide = 'NO';
      const second = reader.read({ accountId: 'U25779973' });
      expect(reads).toHaveBeenCalledTimes(initialReads);
      expect(second.trades[0].contractSide).toBe('YES');
      expect(reader.read({ accountId: 'U000' })).toMatchObject({ complete: false, trades: [] });
      expect(reads).toHaveBeenCalledTimes(initialReads);
      const forced = reader.read({ accountId: 'U25779973', force: true });
      expect(reads.mock.calls.length).toBeGreaterThan(initialReads);
      expect(forced.sourceFingerprint).toBe(second.sourceFingerprint);
      fs.writeFileSync(path.join(dataDir, 'snapshots', '2026-01-02.json'), JSON.stringify({ ...snapshot, fetchedAt: '2099-01-01T00:00:00Z' }));
      const refreshed = reader.read({ accountId: 'U25779973' });
      expect(refreshed.sourceManifest).toHaveLength(2);
      expect(refreshed.sourceFingerprint).not.toBe(second.sourceFingerprint);
    } finally { reads.mockRestore(); }
  });

  test('the latest statement is found from file names without parsing the older ones', async () => {
    const snapshot = await storedFixture();
    const directory = path.join(dataDir, 'snapshots');
    const store = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
    store('2025-01-02_2026-01-01.json', { ...snapshot, date: '2025-01-02_2026-01-01', fromDate: '2025-01-02', toDate: '2026-01-01' });
    store('2025-02-11_2026-02-10.json', { ...snapshot, date: '2025-02-11_2026-02-10', fromDate: '2025-02-11', toDate: '2026-02-10' });
    const reads = jest.spyOn(fs, 'readFileSync');
    try {
      expect(publicConfigStatus().dateCoverage.toDate).toBe('2026-02-10');
      const statementReads = reads.mock.calls.filter(([file]) => String(file).startsWith(directory));
      expect(statementReads).toHaveLength(1);
      expect(String(statementReads[0][0])).toContain('2025-02-11_2026-02-10.json');
    } finally { reads.mockRestore(); }
    // A statement whose dates disagree with its file name falls back to comparing every statement.
    store('2025-03-01_2026-03-01.json', { ...snapshot, date: '2026-01-15', fromDate: '2026-01-15', toDate: '2026-01-15' });
    expect(publicConfigStatus().dateCoverage.toDate).toBe('2026-02-10');
  });

  test('a reconciliation date is an exact date or a stored range, never a path', async () => {
    const snapshot = await storedFixture();
    const [storedName] = fs.readdirSync(path.join(dataDir, 'snapshots'));
    fs.writeFileSync(path.join(dataDir, 'outside.json'), JSON.stringify({ date: 'outside', exposure: { secret: true } }));
    for (const date of ['../outside', '../../etc/passwd', '2026-01-31/../../outside', '2026-13-45', '2026-01-01_2026-01-31_x']) {
      expect(getReconciliation({ date })).toMatchObject({ status: 'invalid_date', flex: null, latestSnapshot: null });
    }
    // The key a statement is stored under (one day, or "from_to") still reads it.
    expect(getReconciliation({ date: storedName.replace(/\.json$/, '') }).status).toBe('ready');
    expect(getReconciliation({ date: '2026-02-02' })).toMatchObject({ status: 'missing', latestSnapshot: { date: snapshot.date } });
  });

  test('stored history keeps only execution evidence in memory and shares identical rows', async () => {
    const snapshot = await storedFixture();
    expect(snapshot.statementOfFunds.length).toBeGreaterThan(0);
    fs.writeFileSync(path.join(dataDir, 'snapshots', '2026-02-01.json'), JSON.stringify({ ...snapshot, fetchedAt: '2026-02-02T00:00:00Z' }));
    const reader = createFlexActivityReader();
    const { snapshots } = reader.readSourceSet();

    expect(snapshots).toHaveLength(2);
    for (const stored of snapshots) {
      expect(stored).not.toHaveProperty('statementOfFunds');
      expect(stored).not.toHaveProperty('cashTransactions');
      expect(stored).not.toHaveProperty('positions');
      expect(stored.trades).toEqual(snapshot.trades);
      expect(stored.closedLots).toEqual(snapshot.closedLots);
      expect(stored.sections).toEqual(snapshot.sections);
      expect(stored.reportHash).toBe(snapshot.reportHash);
    }
    // The same execution reported by two statements is one object, not two copies.
    expect(snapshots[0].trades[0]).toBe(snapshots[1].trades[0]);
    // The checks read the reduced statements exactly as they read whole ones.
    const whole = [snapshot, { ...snapshot, fetchedAt: '2026-02-02T00:00:00Z' }];
    expect(validateFlexActivitySnapshots(snapshots, { accountId: 'U25779973' }))
      .toEqual(validateFlexActivitySnapshots(whole, { accountId: 'U25779973' }));
  });

  test('a restart soon after a successful sync does not request another statement', async () => {
    await storedFixture();
    const statePath = path.join(dataDir, 'state', 'activity-sync.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const requestText = jest.fn(async () => { throw new Error('no statement should be requested'); });
    const warn = jest.fn();
    const startedAt = Date.parse('2026-02-02T12:00:00Z');
    const start = (lastSuccessfulSyncAt) => {
      fs.writeFileSync(statePath, JSON.stringify({ authoritativeEnabled: true, lastThroughDate: '2026-01-31', lastSuccessfulSyncAt }));
      stopFlexActivitySync();
      startFlexActivitySync({ logger: { warn }, now: () => startedAt, intervalMs: 60 * 60 * 1000 });
    };
    const originalFetch = global.fetch;
    global.fetch = requestText;
    try {
      start('2026-02-02T11:00:00Z');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(requestText).not.toHaveBeenCalled();
      // A sync from yesterday is due again at start-up.
      start('2026-02-01T05:00:00Z');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(requestText).toHaveBeenCalled();
    } finally {
      stopFlexActivitySync();
      global.fetch = originalFetch;
    }
  });
});
