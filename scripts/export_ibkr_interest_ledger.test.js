const {
  buildExport,
  readPrivateInterestLedger,
  toCsv,
} = require('./export_ibkr_interest_ledger.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');

function snapshot({
  fetchedAt = '2026-08-10T10:00:00.000Z',
  debitInterest = -1,
  principal = -10000,
} = {}) {
  return {
    source: 'ibkr_flex_interest_web_service',
    fetchedAt,
    revisionHash: fetchedAt,
    fromDate: '2026-08-01',
    toDate: '2026-08-09',
    tierDetails: [{
      currency: 'USD',
      interestType: 'Debit Interest',
      valueDate: '2026-08-08',
      totalPrincipal: principal,
      rate: 3.6,
      totalInterest: debitInterest,
    }],
    cashTransactions: [
      {
        transactionId: 'shared',
        date: '2026-08-05',
        currency: 'USD',
        type: 'Broker Interest Paid',
        amount: -50,
        description: 'USD BORROW FEES FOR JUL-2026',
      },
      {
        transactionId: 'shared',
        date: '2026-08-05',
        currency: 'USD',
        type: 'Broker Interest Received',
        amount: 4,
        description: 'USD IBKR MANAGED SECURITIES (SYEP) FOR JUL-2026',
      },
    ],
    accruals: [],
    cashReports: [],
    borrowFeeDetails: [],
  };
}

describe('IBKR private interest ledger export', () => {
  test('aligns revisions, MTD checkpoints, forecasts, actuals, and postings without filling gaps', () => {
    const result = buildExport({
      snapshots: [
        snapshot(),
        snapshot({
          fetchedAt: '2026-08-11T10:00:00.000Z',
          debitInterest: -1.01,
          principal: -10100,
        }),
      ],
      observations: [
        {
          verified: true,
          sessionDate: '2026-08-08',
          observedAt: '2026-08-09T00:00:00.000Z',
          liveAccruedCash: -12.5,
          source: 'ibkr_live_interest_observation',
        },
        {
          verified: true,
          sessionDate: '2026-08-08',
          observedAt: '2026-08-09T00:00:15.000Z',
          liveAccruedCash: -12.5,
          source: 'ibkr_live_portfolio_balance',
        },
      ],
      predictions: [{
        identity: '2026-08-08',
        valueDate: '2026-08-08',
        coveredValueDates: ['2026-08-08'],
        issuedAt: '2026-08-08T21:00:00.000Z',
        accrualDays: 1,
        principal: 10100,
        raw: 1.01,
        point: 1.01,
        upper: 2.01,
        prospective: true,
        verified: true,
        status: 'provisional',
      }],
      actuals: [{
        kind: 'daily',
        valueDate: '2026-08-08',
        debitAmount: 1.01,
        accrualDays: 1,
        fetchedAt: '2026-08-09T10:00:00.000Z',
        verified: true,
      }],
      generatedAt: '2026-08-12T00:00:00.000Z',
    });

    expect(result.ledger).toEqual([
      expect.objectContaining({
        date: '2026-08-08',
        flex_debit_interest_cost: 1.01,
        live_mtd_net_accrued_signed: -12.5,
        forecast_point_debit_cost: 1.01,
        flex_actual_debit_cost: 1.01,
      }),
    ]);
    expect(result.forecasts).toEqual([
      expect.objectContaining({
        comparison_status: 'verified',
        actual_debit_interest: 1.01,
        point_residual_actual_minus_forecast: 0,
      }),
    ]);
    expect(result.formulaAudit).toEqual([
      expect.objectContaining({
        principal: 10100,
        formula_interest_absolute: 1.01,
        ibkr_interest_absolute: 1.01,
        residual_ibkr_minus_formula: 0,
      }),
    ]);
    expect(result.postings.map((row) => row.category)).toEqual([
      'stock_borrow_fee',
      'securities_lending_income',
    ]);
    expect(result.summary.recovered.cashPostings).toBe(2);
    expect(result.observations).toHaveLength(1);
    expect(result.summary.recovered.liveMtdCheckpoints).toBe(1);
  });

  test('leaves unavailable CSV cells blank', () => {
    expect(toCsv([{ date: '2026-08-10', actual: null }]))
      .toBe('date,actual\n2026-08-10,\n');
  });

  test('requires an exact account match before reading the private ledger', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-interest-ledger-'));
    const env = {
      IBKR_INTEREST_VALIDATION_ENABLED: 'true',
      IBKR_FLEX_EXPECTED_ACCOUNT_ID: 'U1',
      IBKR_INTEREST_VALIDATION_DATA_DIR: dataDir,
    };
    try {
      expect(() => readPrivateInterestLedger({ env, accountId: 'U2' }))
        .toThrow(expect.objectContaining({
          code: 'interest_ledger_account_mismatch',
          status: 403,
        }));
      expect(readPrivateInterestLedger({
        env,
        accountId: 'U1',
        now: new Date('2026-08-17T16:00:00.000Z'),
      })).toMatchObject({
        source: 'ibkr_verified_interest_ledger',
        available: false,
        status: 'unavailable',
        accountId: 'U1',
        accountMatched: true,
        fromCache: false,
        generatedAt: '2026-08-17T16:00:00.000Z',
      });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
