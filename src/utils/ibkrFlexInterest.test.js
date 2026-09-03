const {
  deriveMonthlyPaid,
  parseFlexInterestResponse,
  parseFlexInterestStatement,
} = require('./ibkrFlexInterest.cjs');

const ACCOUNT_ID = 'U12345678';

function interestStatementXml({ accountId = ACCOUNT_ID } = {}) {
  return `
    <FlexQueryResponse queryName="Interest ledger" type="AF">
      <FlexStatements count="1">
        <FlexStatement accountId="${accountId}" fromDate="20260701" toDate="2026-07-31"
          whenGenerated="20260726;120000">
          <TierInterestDetails>
            <TierInterestDetail accountId="${accountId}" currency="USD"
              interestType="Debit Interest" valueDate="20260702" tierBreak="I"
              balanceThreshold="0" totalPrincipal="-100000" rate="6.83"
              totalInterest="-18.97" />
            <TierInterestDetail accountId="${accountId}" currency="USD"
              interestType="Debit Interest" valueDate="20260702" tierBreak="II"
              totalPrincipal="-25000" rate="6.33" totalInterest="-4.34" />
            <TierInterestDetail accountId="${accountId}" currency="EUR"
              interestType="Credit Interest" valueDate="20260702"
              totalPrincipal="50000" rate="2.10" totalInterest="2.88" />
            <TierInterestDetail accountId="${accountId}" currency="BASE_SUMMARY"
              interestType="Debit Interest" valueDate="20260702" totalInterest="-99" />
          </TierInterestDetails>
          <InterestAccruals>
            <InterestAccrualsCurrency accountId="${accountId}" currency="USD"
              fromDate="20260701" toDate="20260731" startingAccrualBalance="-90"
              interestAccrued="-112.50" accrualReversal="0"
              endingAccrualBalance="-202.50" />
            <InterestAccrualsCurrency accountId="${accountId}" currency="BASE_SUMMARY"
              fromDate="20260701" toDate="20260731" interestAccrued="-112.50" />
          </InterestAccruals>
          <CashTransactions>
            <CashTransaction accountId="${accountId}" transactionID="paid-1"
              currency="USD" date="20260703" settleDate="20260703"
              type="Broker Interest Paid" amount="-143.25"
              description="USD Debit Interest Paid for June 2026" />
            <CashTransaction accountId="${accountId}" transactionID="received-1"
              currency="USD" date="20260710" type="BrokerInterestReceived"
              amount="8.50" description="USD Credit Interest" />
            <CashTransaction accountId="${accountId}" transactionID="borrow-1"
              currency="USD" date="20260710" type="Broker Interest Paid"
              amount="-294.87" description="USD BORROW FEES FOR JUN-2026" />
            <CashTransaction accountId="${accountId}" currency="USD"
              date="20260710" type="Dividends" amount="500" />
            <CashTransaction accountId="${accountId}" currency="BASE_SUMMARY"
              date="20260703" type="Broker Interest Paid" amount="-143.25" />
          </CashTransactions>
          <SecuritiesBorrowedLentFeeDetails accountId="${accountId}">
            <SecuritiesBorrowedLentFeeDetail accountId="${accountId}" currency="USD"
              symbol="HARD" valueDate="20260710" startDate="20260709"
              quantity="100" collateralAmount="10000" feeRate="12.5"
              borrowFee="3.25" ibCarryCharge="0.10" ibTicketCharge="0.05"
              totalCharges="3.40" code="Borrow" />
            <SecuritiesBorrowedLentFeeDetail accountId="${accountId}" currency="BASE_SUMMARY"
              symbol="BASE" valueDate="20260710" totalCharges="99" />
          </SecuritiesBorrowedLentFeeDetails>
          <CashReport>
            <CashReportCurrency accountId="${accountId}" currency="USD"
              fromDate="20260701" toDate="20260731" startingCash="-100000"
              brokerInterest="-134.75" brokerInterestSec="-134.75"
              endingCash="-110000" endingSettledCash="-109500" />
            <CashReportCurrency accountId="${accountId}" currency="BASE_SUMMARY"
              brokerInterest="-134.75" />
          </CashReport>
        </FlexStatement>
      </FlexStatements>
    </FlexQueryResponse>
  `;
}

describe('IBKR Flex interest parser', () => {
  test('parses Flex request metadata without trusting the returned URL', () => {
    const response = parseFlexInterestResponse(`
      <FlexStatementResponse>
        <Status>Success</Status>
        <ReferenceCode>ABC123</ReferenceCode>
        <Url>https://attacker.invalid/GetStatement</Url>
      </FlexStatementResponse>
    `);

    expect(response).toMatchObject({
      status: 'Success',
      referenceCode: 'ABC123',
      responseUrl: 'https://attacker.invalid/GetStatement',
      isStatement: false,
    });
  });

  test('normalizes all authoritative interest sections and excludes BASE_SUMMARY rows', () => {
    const result = parseFlexInterestStatement(interestStatementXml(), {
      expectedAccountId: ACCOUNT_ID,
    });

    expect(result).toMatchObject({
      accountId: ACCOUNT_ID,
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
      tierDetailSectionPresent: true,
      accrualSectionPresent: true,
      cashTransactionSectionPresent: true,
      cashReportSectionPresent: true,
    });
    expect(result.tierDetails).toHaveLength(3);
    expect(result.accruals).toEqual([
      expect.objectContaining({
        currency: 'USD',
        interestAccrued: -112.5,
        endingAccrualBalance: -202.5,
      }),
    ]);
    expect(result.cashTransactions).toHaveLength(3);
    expect(result.cashTransactions.map((row) => row.type)).toEqual([
      'Broker Interest Paid',
      'Broker Interest Received',
      'Broker Interest Paid',
    ]);
    expect(result.borrowFeeDetails).toEqual([
      expect.objectContaining({
        symbol: 'HARD',
        valueDate: '2026-07-10',
        totalCharges: 3.4,
      }),
    ]);
    expect(result.borrowFeeDetailsSectionPresent).toBe(true);
    expect(result.cashReports).toEqual([
      expect.objectContaining({
        currency: 'USD',
        brokerInterest: -134.75,
        endingSettledCash: -109500,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('BASE_SUMMARY');
  });

  test('derives signed daily debit actuals and monthly paid/received totals', () => {
    const result = parseFlexInterestStatement(interestStatementXml(), {
      expectedAccountId: ACCOUNT_ID,
    });

    expect(result.derived.dailyDebitActuals).toEqual([
      {
        date: '2026-07-02',
        fromDate: '2026-07-02',
        toDate: '2026-07-02',
        accrualDays: 1,
        currency: 'USD',
        totalInterest: -23.31,
        debitAmount: 23.31,
        rowCount: 2,
      },
    ]);
    expect(result.derived.monthlyPaid).toEqual([
      {
        month: '2026-07',
        currency: 'USD',
        paid: 143.25,
        received: 8.5,
        net: -134.75,
        transactionCount: 2,
      },
    ]);
    expect(result.derived.stockBorrowFeePayments).toEqual([
      {
        month: '2026-06',
        currency: 'USD',
        amount: 294.87,
        transactionCount: 1,
        postedDates: ['2026-07-10'],
        transactionIds: ['borrow-1'],
      },
    ]);
    expect(result.derived.dailyStockBorrowFees).toEqual([
      {
        date: '2026-07-10',
        amount: 3.4,
        positionCount: 1,
        rowCount: 1,
      },
    ]);
  });

  test('keeps securities-lending income out of margin-interest reconciliation', () => {
    expect(deriveMonthlyPaid([
      {
        date: '2026-08-05',
        currency: 'USD',
        type: 'Broker Interest Paid',
        amount: -56.29,
        description: 'USD DEBIT INT FOR JUL-2026',
      },
      {
        date: '2026-08-05',
        currency: 'USD',
        type: 'Broker Interest Received',
        amount: 3.57,
        description: 'USD CREDIT INT FOR JUL-2026',
      },
      {
        date: '2026-08-05',
        currency: 'USD',
        type: 'Broker Interest Received',
        amount: 20.58,
        description: 'USD SHORT CREDIT INTEREST FOR JUL-2026',
      },
      {
        date: '2026-08-05',
        currency: 'USD',
        type: 'Broker Interest Received',
        amount: 21.85,
        description: 'USD IBKR MANAGED SECURITIES (SYEP) FOR JUL-2026',
      },
    ])).toEqual([{
      month: '2026-08',
      currency: 'USD',
      paid: 56.29,
      received: 24.15,
      net: -32.14,
      transactionCount: 3,
    }]);
  });

  test('requires an exact configured account match across the statement and rows', () => {
    expect(() => parseFlexInterestStatement(interestStatementXml(), {
      expectedAccountId: 'u12345678',
    })).toThrow(expect.objectContaining({
      code: 'flex_interest_account_mismatch',
    }));

    const mixedAccountXml = interestStatementXml()
      .replace(
        `accountId="${ACCOUNT_ID}" transactionID="paid-1"`,
        'accountId="U99999999" transactionID="paid-1"',
      );
    expect(() => parseFlexInterestStatement(mixedAccountXml, {
      expectedAccountId: ACCOUNT_ID,
    })).toThrow(expect.objectContaining({
      code: 'flex_interest_account_mismatch',
    }));
  });

  test('rejects responses containing more than one Flex statement', () => {
    const secondStatement = `
      <FlexStatement accountId="${ACCOUNT_ID}" fromDate="20200101" toDate="20200131">
        <TierInterestDetails>
          <TierInterestDetail accountId="${ACCOUNT_ID}" currency="USD"
            interestType="Debit Interest" valueDate="20200102"
            securitiesPrincipal="-1000" rate="6.5" totalInterest="-1" />
        </TierInterestDetails>
      </FlexStatement>
    `;
    const multipleStatementsXml = interestStatementXml().replace(
      '</FlexStatements>',
      `${secondStatement}</FlexStatements>`,
    );

    expect(() => parseFlexInterestStatement(multipleStatementsXml, {
      expectedAccountId: ACCOUNT_ID,
    })).toThrow(expect.objectContaining({
      code: 'flex_interest_statement_count_invalid',
    }));
  });

  test('rejects account-unbound and unsafe XML', () => {
    expect(() => parseFlexInterestStatement(interestStatementXml()))
      .toThrow(expect.objectContaining({
        code: 'flex_interest_expected_account_required',
      }));
    expect(() => parseFlexInterestStatement(
      '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>',
      { expectedAccountId: ACCOUNT_ID },
    )).toThrow(expect.objectContaining({
      code: 'flex_interest_unsafe_xml',
    }));
  });
});
