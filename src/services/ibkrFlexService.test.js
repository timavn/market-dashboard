const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  fetchFlexStatement,
  getReconciliation,
  publicConfigStatus,
} = require('./ibkrFlexService.cjs');

const originalEnv = { ...process.env };

function setFlexEnv(dataDir) {
  process.env.IBKR_FLEX_ENABLED = 'true';
  process.env.IBKR_FLEX_TOKEN = 'super-secret-flex-token';
  process.env.IBKR_FLEX_ACTIVITY_QUERY_ID = '123456';
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
        </FlexStatement>
      </FlexStatements>
    </FlexQueryResponse>`;
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
    expect(requestTextImpl).toHaveBeenCalledTimes(2);

    const rawPath = path.join(dataDir, 'raw', '2026-06-23.xml');
    const snapshotPath = path.join(dataDir, 'snapshots', '2026-06-23.json');
    expect(fs.existsSync(rawPath)).toBe(true);
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const reconciliation = getReconciliation({ date: '2026-06-23' });
    expect(reconciliation.status).toBe('ready');
    expect(reconciliation.flex.exposure.grossPct).toBeCloseTo(83);
    expect(reconciliation.flex.positions).toBeUndefined();
  });

  test('reports disabled reconciliation without returning stale live data', () => {
    process.env.IBKR_FLEX_ENABLED = 'false';

    const reconciliation = getReconciliation({ date: '2026-06-23' });

    expect(reconciliation.status).toBe('disabled');
    expect(reconciliation.flex).toBeNull();
  });
});
