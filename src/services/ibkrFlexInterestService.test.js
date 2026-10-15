const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createIbkrFlexInterestService,
  publicConfigStatus,
  validateIsoDateRange,
} = require('./ibkrFlexInterestService.cjs');

const ACCOUNT_ID = 'U12345678';
const TOKEN = 'top-secret-flex-token';
const QUERY_ID = '987654';

function makeEnv(dataDir, overrides = {}) {
  return {
    IBKR_FLEX_ENABLED: 'true',
    IBKR_FLEX_TOKEN: TOKEN,
    IBKR_FLEX_INTEREST_QUERY_ID: QUERY_ID,
    IBKR_FLEX_EXPECTED_ACCOUNT_ID: ACCOUNT_ID,
    IBKR_FLEX_BASE_URL: 'https://configured.flex.test/FlexWebService',
    IBKR_FLEX_INTEREST_DATA_DIR: dataDir,
    IBKR_FLEX_INTEREST_MAX_POLLS: '3',
    IBKR_FLEX_INTEREST_POLL_INTERVAL_MS: '10',
    ...overrides,
  };
}

function statementXml({
  accountId = ACCOUNT_ID,
  fromDate = '20260701',
  toDate = '20260731',
  dailyInterest = '-12.50',
} = {}) {
  return `
    <FlexQueryResponse>
      <FlexStatements>
        <FlexStatement accountId="${accountId}" fromDate="${fromDate}" toDate="${toDate}">
          <TierInterestDetails>
            <TierInterestDetail accountId="${accountId}" currency="USD"
              interestType="Debit Interest" valueDate="20260701"
              totalPrincipal="-100000" rate="6.5" totalInterest="${dailyInterest}" />
          </TierInterestDetails>
          <InterestAccruals>
            <InterestAccrualsCurrency accountId="${accountId}" currency="USD"
              fromDate="${fromDate}" toDate="${toDate}" interestAccrued="-100"
              endingAccrualBalance="-150" />
          </InterestAccruals>
          <CashTransactions>
            <CashTransaction accountId="${accountId}" transactionID="txn-1"
              currency="USD" date="20260703" type="Broker Interest Paid"
              amount="-125" description="USD Debit Interest Paid" />
          </CashTransactions>
          <CashReport>
            <CashReportCurrency accountId="${accountId}" currency="USD"
              fromDate="${fromDate}" toDate="${toDate}" brokerInterest="-125" />
            <CashReportCurrency accountId="${accountId}" currency="BASE_SUMMARY"
              brokerInterest="-125" />
          </CashReport>
        </FlexStatement>
      </FlexStatements>
    </FlexQueryResponse>
  `;
}

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

function sendResponse({
  url = 'https://attacker.invalid/steal-token',
} = {}) {
  return response(`
    <FlexStatementResponse>
      <Status>Success</Status>
      <ReferenceCode>ABC123</ReferenceCode>
      <Url>${url}</Url>
    </FlexStatementResponse>
  `);
}

describe('IBKR Flex interest service', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-flex-interest-'));
  });

  afterEach(() => {
    fs.chmodSync(dataDir, 0o700);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('validates real, ordered ISO ranges capped at 365 inclusive days', () => {
    expect(validateIsoDateRange({
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
    })).toMatchObject({ inclusiveDays: 365 });
    expect(() => validateIsoDateRange({
      fromDate: '2026-02-30',
      toDate: '2026-03-01',
    })).toThrow(expect.objectContaining({ code: 'flex_interest_invalid_date_range' }));
    expect(() => validateIsoDateRange({
      fromDate: '2026-07-02',
      toDate: '2026-07-01',
    })).toThrow(expect.objectContaining({ code: 'flex_interest_invalid_date_range' }));
    expect(() => validateIsoDateRange({
      fromDate: '2025-01-01',
      toDate: '2026-01-01',
    })).toThrow(expect.objectContaining({ code: 'flex_interest_invalid_date_range' }));
  });

  test('rejects an HTTP Flex endpoint before sending credentials', async () => {
    const fetchImpl = jest.fn();
    const service = createIbkrFlexInterestService({
      env: makeEnv(dataDir, {
        IBKR_FLEX_BASE_URL: 'http://configured.flex.test/FlexWebService',
      }),
      dataDir,
      fetchImpl,
    });

    await expect(service.sync({
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    })).rejects.toMatchObject({
      code: 'flex_interest_invalid_base_url',
      message: 'IBKR Flex base URL must use HTTPS',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('keeps status public and returns no persisted data while disabled', () => {
    fs.writeFileSync(path.join(dataDir, 'latest.json'), JSON.stringify({
      accountId: ACCOUNT_ID,
      token: TOKEN,
    }));
    const env = makeEnv(dataDir, { IBKR_FLEX_ENABLED: 'false' });
    const status = publicConfigStatus({ env, dataDir });

    expect(status).toMatchObject({
      enabled: false,
      configured: true,
      status: 'disabled',
      expectedAccountMasked: 'U******78',
      latest: null,
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(JSON.stringify(status)).not.toContain(ACCOUNT_ID);
  });

  test('polls no faster than once per second and ignores the returned statement URL', async () => {
    const sleeps = [];
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(sendResponse())
      .mockResolvedValueOnce(response(`
        <FlexStatementResponse>
          <Status>Fail</Status>
          <ErrorCode>1019</ErrorCode>
          <ErrorMessage>Statement generation in progress.</ErrorMessage>
        </FlexStatementResponse>
      `))
      .mockResolvedValueOnce(response(statementXml()));
    const service = createIbkrFlexInterestService({
      env: makeEnv(dataDir),
      dataDir,
      fetchImpl,
      now: () => new Date('2026-07-26T12:00:00.000Z'),
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    });

    const snapshot = await service.sync({
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    expect(sleeps).toEqual([1000, 1000]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1][0]).toMatch(
      /^https:\/\/configured\.flex\.test\/FlexWebService\/GetStatement\?/,
    );
    expect(fetchImpl.mock.calls[1][0]).not.toContain('attacker.invalid');
    expect(snapshot).toMatchObject({
      source: 'ibkr_flex_interest_web_service',
      fetchedAt: '2026-07-26T12:00:00.000Z',
      expectedAccountMasked: 'U******78',
      expectedAccountFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      reportHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      revisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      tierDetailSectionPresent: true,
      accrualSectionPresent: true,
      cashTransactionSectionPresent: true,
      cashReportSectionPresent: true,
      tierDetails: [expect.objectContaining({ totalInterest: -12.5 })],
      derived: {
        dailyDebitActuals: [expect.objectContaining({ debitAmount: 12.5 })],
        monthlyPaid: [expect.objectContaining({ paid: 125 })],
      },
    });
    expect(service.status().latest.sectionPresence).toEqual({
      tierInterestDetails: true,
      interestAccruals: true,
      cashTransactions: true,
      cashReport: true,
      stockBorrowFeeDetails: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain(ACCOUNT_ID);
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
  });

  test('persists private immutable content-addressed revisions and an atomic latest file', async () => {
    const xml = statementXml();
    const fetchImpl = jest.fn(async (url) =>
      url.includes('/SendRequest') ? sendResponse() : response(xml));
    const service = createIbkrFlexInterestService({
      env: makeEnv(dataDir),
      dataDir,
      fetchImpl,
      now: () => new Date('2026-07-26T12:00:00.000Z'),
      sleep: async () => {},
    });

    const first = await service.sync({
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    const second = await service.sync({
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    const revisionsDir = path.join(dataDir, 'revisions');
    const revisionFiles = fs.readdirSync(revisionsDir);

    expect(second).toEqual(first);
    expect(revisionFiles).toEqual([`${first.revisionId}.json`]);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(revisionsDir, revisionFiles[0])).mode & 0o777).toBe(0o400);
    expect(fs.statSync(path.join(dataDir, 'latest.json')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dataDir).some((name) => name.endsWith('.tmp'))).toBe(false);

    const persisted = fs.readFileSync(path.join(revisionsDir, revisionFiles[0]), 'utf8');
    expect(persisted).not.toContain(TOKEN);
    expect(persisted).not.toContain(ACCOUNT_ID);
  });

  test('never reuses stored Flex revisions for a different account', async () => {
    const service = createIbkrFlexInterestService({
      env: makeEnv(dataDir),
      dataDir,
      fetchImpl: async (url) => (
        url.includes('/SendRequest')
          ? sendResponse()
          : response(statementXml())
      ),
      now: () => new Date('2026-07-26T12:00:00.000Z'),
      sleep: async () => {},
    });
    await service.sync({
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    const otherAccountService = createIbkrFlexInterestService({
      env: makeEnv(dataDir, {
        IBKR_FLEX_EXPECTED_ACCOUNT_ID: 'U87654321',
      }),
      dataDir,
    });
    expect(otherAccountService.status()).toMatchObject({
      status: 'storage_error',
      latest: null,
      errorCode: 'flex_interest_integrity_error',
    });
    expect(() => otherAccountService.history()).toThrow(
      expect.objectContaining({
        code: 'flex_interest_integrity_error',
      }),
    );
  });

  test('status and history verify revision hashes and never publish a tampered cache', async () => {
    let report = statementXml();
    const service = createIbkrFlexInterestService({
      env: makeEnv(dataDir),
      dataDir,
      fetchImpl: async (url) =>
        url.includes('/SendRequest') ? sendResponse() : response(report),
      now: () => new Date('2026-07-26T12:00:00.000Z'),
      sleep: async () => {},
    });
    const first = await service.sync({
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    report = statementXml({ dailyInterest: '-13.75' });
    const second = await service.sync({
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    expect(service.status()).toMatchObject({
      status: 'ready',
      latest: {
        reportHash: second.reportHash,
        expectedAccountMasked: 'U******78',
      },
    });
    expect(service.history({ limit: 1 })).toEqual([second]);
    expect(service.history({ limit: 10 })).toEqual([second, first]);

    const revisionPath = path.join(dataDir, 'revisions', `${second.revisionId}.json`);
    fs.chmodSync(revisionPath, 0o600);
    const tampered = JSON.parse(fs.readFileSync(revisionPath, 'utf8'));
    tampered.tierDetails[0].totalInterest = -999999;
    fs.writeFileSync(revisionPath, JSON.stringify(tampered));

    expect(service.status()).toMatchObject({
      status: 'storage_error',
      latest: null,
      errorCode: 'flex_interest_integrity_error',
    });
    expect(() => service.history()).toThrow(expect.objectContaining({
      code: 'flex_interest_integrity_error',
    }));
  });

  test('limited history keeps exact fetched-date ordering and still rejects tampering outside its newest rows', async () => {
    let report = statementXml();
    let observed = '2026-07-26T12:00:00.000Z';
    const service = createIbkrFlexInterestService({
      env: makeEnv(dataDir), dataDir,
      fetchImpl: async url => url.includes('/SendRequest') ? sendResponse() : response(report),
      now: () => new Date(observed), sleep: async () => {},
    });
    const sync = () => service.sync({ fromDate: '2026-07-01', toDate: '2026-07-31' });
    const oldest = await sync();
    report = statementXml({ dailyInterest: '-13.75' });
    observed = '2026-07-27T12:00:00.000Z';
    const newer = await sync();
    report = statementXml({ dailyInterest: '-15.25' });
    const sameTime = await sync();
    const expected = [newer, sameTime].sort((a, b) => b.revisionId.localeCompare(a.revisionId));
    expect(service.history({ limit: 1 })).toEqual(expected.slice(0, 1));
    expect(service.history({ limit: 2 })).toEqual(expected);
    expect(service.history({ limit: 50 })).toEqual([...expected, oldest]);
    const file = path.join(dataDir, 'revisions', `${oldest.revisionId}.json`);
    fs.chmodSync(file, 0o600);
    const corrupted = JSON.parse(fs.readFileSync(file, 'utf8'));
    corrupted.tierDetails[0].totalInterest = -999;
    fs.writeFileSync(file, JSON.stringify(corrupted));
    expect(() => service.history({ limit: 1 })).toThrow(expect.objectContaining({ code: 'flex_interest_integrity_error' }));
  });

  test('fails closed on account/range mismatches and redacts request secrets from errors', async () => {
    const accountMismatch = createIbkrFlexInterestService({
      env: makeEnv(dataDir),
      dataDir,
      fetchImpl: async (url) =>
        url.includes('/SendRequest')
          ? sendResponse()
          : response(statementXml({ accountId: 'U99999999' })),
      sleep: async () => {},
    });
    await expect(accountMismatch.sync({
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    })).rejects.toMatchObject({ code: 'flex_interest_account_mismatch' });

    const fetchFailure = createIbkrFlexInterestService({
      env: makeEnv(dataDir),
      dataDir,
      fetchImpl: async (url) => {
        throw new Error(`request failed: ${url}; account=${ACCOUNT_ID}`);
      },
      sleep: async () => {},
    });
    let caught;
    try {
      await fetchFailure.sync({
        fromDate: '2026-07-01',
        toDate: '2026-07-31',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.message).not.toContain(TOKEN);
    expect(caught.message).not.toContain(QUERY_ID);
    expect(caught.message).not.toContain(ACCOUNT_ID);

    const rangeMismatch = createIbkrFlexInterestService({
      env: makeEnv(dataDir),
      dataDir,
      fetchImpl: async (url) =>
        url.includes('/SendRequest')
          ? sendResponse()
          : response(statementXml({ toDate: '20260730' })),
      sleep: async () => {},
    });
    await expect(rangeMismatch.sync({
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    })).rejects.toMatchObject({ code: 'flex_interest_report_range_mismatch' });
  });
});
