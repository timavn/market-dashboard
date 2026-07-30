const { XMLParser, XMLValidator } = require('fast-xml-parser');

const BASE_SUMMARY_CURRENCY = 'BASE_SUMMARY';
const BROKER_INTEREST_PAID = 'Broker Interest Paid';
const BROKER_INTEREST_RECEIVED = 'Broker Interest Received';

function createInterestError(message, code = 'flex_interest_parse_error') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeKey(key) {
  return String(key || '').replace(/^@_/, '').toLowerCase();
}

function normalizeObjectKeys(row = {}) {
  return Object.entries(row || {}).reduce((result, [key, value]) => {
    result[normalizeKey(key)] = value;
    return result;
  }, {});
}

function pick(row, keys) {
  for (const key of keys) {
    const value = row?.[normalizeKey(key)];
    if (value != null && String(value).trim() !== '') return value;
  }
  return null;
}

function toStringOrNull(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  let normalized = String(value).trim();
  if (!normalized || /^(?:n\/a|nan|--?)$/i.test(normalized)) return null;
  const parenthesized = /^\(.*\)$/.test(normalized);
  if (parenthesized) normalized = normalized.slice(1, -1);
  normalized = normalized.replace(/[,$%\s]/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parenthesized ? -parsed : parsed;
}

function pickNumber(row, keys) {
  return toNumberOrNull(pick(row, keys));
}

function isRealIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function normalizeFlexDate(value) {
  const text = toStringOrNull(value);
  if (!text) return null;
  const datePart = text.split(/[;T\s]/, 1)[0];
  const iso = /^\d{8}$/.test(datePart)
    ? `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`
    : datePart;
  return isRealIsoDate(iso) ? iso : null;
}

function normalizeCurrency(value) {
  const currency = toStringOrNull(value);
  return currency ? currency.toUpperCase() : null;
}

function isBaseSummary(row) {
  return normalizeCurrency(pick(row, ['currency'])) === BASE_SUMMARY_CURRENCY;
}

function collectNodes(root, tagNames) {
  const wanted = new Set(tagNames.map((tag) => String(tag).toLowerCase()));
  const nodes = [];

  function walk(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(String(key).toLowerCase())) {
        nodes.push(...asArray(child));
      }
      for (const nested of asArray(child)) {
        walk(nested);
      }
    }
  }

  walk(root);
  return nodes;
}

function parseFlexXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) {
    throw createInterestError('IBKR Flex interest response was empty');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xmlText)) {
    throw createInterestError(
      'IBKR Flex interest XML declarations are not allowed',
      'flex_interest_unsafe_xml',
    );
  }

  try {
    if (XMLValidator.validate(xmlText) !== true) {
      throw new Error('invalid XML');
    }
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseAttributeValue: false,
      parseTagValue: false,
      processEntities: false,
      trimValues: true,
    });
    return parser.parse(xmlText);
  } catch {
    throw createInterestError('IBKR Flex interest response was not valid XML');
  }
}

function parseFlexInterestResponse(xmlText) {
  const parsed = parseFlexXml(xmlText);
  const response = parsed?.FlexStatementResponse
    || parsed?.FlexQueryResponse
    || parsed;
  const row = normalizeObjectKeys(response || {});
  return {
    status: toStringOrNull(pick(row, ['status'])),
    referenceCode: toStringOrNull(pick(row, ['referenceCode', 'reference'])),
    responseUrl: toStringOrNull(pick(row, ['url'])),
    errorCode: toStringOrNull(pick(row, ['errorCode'])),
    errorMessage: toStringOrNull(pick(row, ['errorMessage'])),
    isStatement: Boolean(parsed?.FlexQueryResponse || parsed?.FlexStatements),
  };
}

function normalizeTierDetail(rawRow) {
  const row = normalizeObjectKeys(rawRow);
  return {
    currency: normalizeCurrency(pick(row, ['currency'])),
    interestType: toStringOrNull(pick(row, ['interestType'])),
    reportDate: normalizeFlexDate(pick(row, ['reportDate'])),
    valueDate: normalizeFlexDate(pick(row, ['valueDate', 'date'])),
    fromDate: normalizeFlexDate(pick(row, ['fromDate'])),
    toDate: normalizeFlexDate(pick(row, ['toDate'])),
    tierBreak: toStringOrNull(pick(row, ['tierBreak'])),
    balanceThreshold: pickNumber(row, ['balanceThreshold']),
    marginBalance: pickNumber(row, ['marginBalance', 'balance']),
    securitiesPrincipal: pickNumber(row, ['securitiesPrincipal']),
    commoditiesPrincipal: pickNumber(row, ['commoditiesPrincipal']),
    ibuklPrincipal: pickNumber(row, ['ibuklPrincipal']),
    totalPrincipal: pickNumber(row, ['totalPrincipal']),
    rate: pickNumber(row, ['rate']),
    securitiesInterest: pickNumber(row, ['securitiesInterest']),
    commoditiesInterest: pickNumber(row, ['commoditiesInterest']),
    ibuklInterest: pickNumber(row, ['ibuklInterest']),
    totalInterest: pickNumber(row, ['totalInterest']),
    fxRateToBase: pickNumber(row, ['fxRateToBase']),
    code: toStringOrNull(pick(row, ['code'])),
  };
}

function normalizeAccrual(rawRow) {
  const row = normalizeObjectKeys(rawRow);
  return {
    currency: normalizeCurrency(pick(row, ['currency'])),
    fromDate: normalizeFlexDate(pick(row, ['fromDate'])),
    toDate: normalizeFlexDate(pick(row, ['toDate'])),
    startingAccrualBalance: pickNumber(row, ['startingAccrualBalance']),
    interestAccrued: pickNumber(row, ['interestAccrued', 'interestAccrual']),
    accrualReversal: pickNumber(row, ['accrualReversal']),
    endingAccrualBalance: pickNumber(row, ['endingAccrualBalance']),
    fxTranslation: pickNumber(row, ['fxTranslation']),
  };
}

function canonicalCashInterestType(value) {
  const compact = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  if (compact === 'brokerinterestpaid') return BROKER_INTEREST_PAID;
  if (compact === 'brokerinterestreceived') return BROKER_INTEREST_RECEIVED;
  return null;
}

function normalizeCashTransaction(rawRow) {
  const row = normalizeObjectKeys(rawRow);
  const type = canonicalCashInterestType(pick(row, ['type']));
  if (!type) return null;
  return {
    transactionId: toStringOrNull(pick(row, ['transactionID', 'transactionId'])),
    date: normalizeFlexDate(pick(row, ['date', 'reportDate', 'dateTime'])),
    settleDate: normalizeFlexDate(pick(row, ['settleDate'])),
    currency: normalizeCurrency(pick(row, ['currency'])),
    type,
    amount: pickNumber(row, ['amount']),
    fxRateToBase: pickNumber(row, ['fxRateToBase']),
    description: toStringOrNull(pick(row, ['description'])),
    code: toStringOrNull(pick(row, ['code'])),
  };
}

function normalizeCashReport(rawRow) {
  const row = normalizeObjectKeys(rawRow);
  return {
    currency: normalizeCurrency(pick(row, ['currency'])),
    fromDate: normalizeFlexDate(pick(row, ['fromDate'])),
    toDate: normalizeFlexDate(pick(row, ['toDate'])),
    reportDate: normalizeFlexDate(pick(row, ['reportDate'])),
    startingCash: pickNumber(row, ['startingCash']),
    brokerInterest: pickNumber(row, ['brokerInterest']),
    brokerInterestSecurities: pickNumber(row, ['brokerInterestSec']),
    brokerInterestCommodities: pickNumber(row, ['brokerInterestCom']),
    endingCash: pickNumber(row, ['endingCash']),
    endingSettledCash: pickNumber(row, ['endingSettledCash']),
  };
}

function rowAccountId(rawRow) {
  return toStringOrNull(pick(normalizeObjectKeys(rawRow), ['accountId']));
}

function validateExpectedAccount({
  expectedAccountId,
  statementRows,
  sectionRows,
}) {
  if (!toStringOrNull(expectedAccountId)) {
    throw createInterestError(
      'An expected IBKR account ID is required',
      'flex_interest_expected_account_required',
    );
  }

  const statementAccountIds = statementRows.map(rowAccountId).filter(Boolean);
  if (statementAccountIds.length === 0) {
    throw createInterestError(
      'IBKR Flex interest statement did not identify an account',
      'flex_interest_account_missing',
    );
  }

  const observedAccountIds = [
    ...statementAccountIds,
    ...sectionRows.map(rowAccountId).filter(Boolean),
  ];
  const mismatch = observedAccountIds.find((accountId) => accountId !== expectedAccountId);
  if (mismatch) {
    throw createInterestError(
      'IBKR Flex interest statement account did not match the configured account',
      'flex_interest_account_mismatch',
    );
  }

  const uniqueStatementAccounts = new Set(statementAccountIds);
  if (uniqueStatementAccounts.size !== 1 || statementAccountIds[0] !== expectedAccountId) {
    throw createInterestError(
      'IBKR Flex interest statement account did not match the configured account',
      'flex_interest_account_mismatch',
    );
  }
}

function stableNumber(value) {
  return Number(Number(value).toPrecision(15));
}

function deriveDailyDebitActuals(tierDetails) {
  const byDay = new Map();

  for (const row of tierDetails) {
    const isDebit = String(row.interestType || '').toLowerCase().includes('debit');
    const date = row.valueDate || row.reportDate || row.toDate || row.fromDate;
    if (!isDebit || !date || !row.currency || row.totalInterest == null) continue;
    const key = `${date}\u0000${row.currency}`;
    const current = byDay.get(key) || {
      date,
      fromDate: row.fromDate || date,
      toDate: row.toDate || date,
      currency: row.currency,
      totalInterest: 0,
      debitAmount: 0,
      rowCount: 0,
    };
    if ((row.fromDate || date) !== current.fromDate) current.fromDate = null;
    if ((row.toDate || date) !== current.toDate) current.toDate = null;
    current.totalInterest += row.totalInterest;
    current.debitAmount += Math.abs(row.totalInterest);
    current.rowCount += 1;
    byDay.set(key, current);
  }

  return [...byDay.values()]
    .map((row) => ({
      ...row,
      accrualDays: row.fromDate && row.toDate
        ? Math.floor(
          (
            Date.parse(`${row.toDate}T00:00:00Z`)
            - Date.parse(`${row.fromDate}T00:00:00Z`)
          ) / 86_400_000,
        ) + 1
        : null,
      totalInterest: stableNumber(row.totalInterest),
      debitAmount: stableNumber(row.debitAmount),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency));
}

function deriveMonthlyPaid(cashTransactions) {
  const byMonth = new Map();

  for (const row of cashTransactions) {
    if (!row.date || !row.currency || row.amount == null) continue;
    const month = row.date.slice(0, 7);
    const key = `${month}\u0000${row.currency}`;
    const current = byMonth.get(key) || {
      month,
      currency: row.currency,
      paid: 0,
      received: 0,
      net: 0,
      transactionCount: 0,
    };
    if (row.type === BROKER_INTEREST_PAID) {
      current.paid += Math.abs(row.amount);
    } else if (row.type === BROKER_INTEREST_RECEIVED) {
      current.received += Math.abs(row.amount);
    }
    current.net += row.amount;
    current.transactionCount += 1;
    byMonth.set(key, current);
  }

  return [...byMonth.values()]
    .map((row) => ({
      ...row,
      paid: stableNumber(row.paid),
      received: stableNumber(row.received),
      net: stableNumber(row.net),
    }))
    .sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency));
}

function parseFlexInterestStatement(xmlText, { expectedAccountId } = {}) {
  const parsed = parseFlexXml(xmlText);
  const statementRows = collectNodes(parsed, ['FlexStatement']);
  if (statementRows.length === 0) {
    throw createInterestError(
      'IBKR Flex interest response did not contain a statement',
      'flex_interest_statement_missing',
    );
  }
  if (statementRows.length !== 1) {
    throw createInterestError(
      'IBKR Flex interest response must contain exactly one statement',
      'flex_interest_statement_count_invalid',
    );
  }

  const tierRows = collectNodes(parsed, ['TierInterestDetail']);
  const accrualRows = collectNodes(parsed, ['InterestAccrualsCurrency']);
  const cashTransactionRows = collectNodes(parsed, ['CashTransaction']);
  const cashReportRows = collectNodes(parsed, ['CashReportCurrency', 'CashReport']);
  validateExpectedAccount({
    expectedAccountId,
    statementRows,
    sectionRows: [
      ...tierRows,
      ...accrualRows,
      ...cashTransactionRows,
      ...cashReportRows,
    ],
  });

  const normalizedStatement = normalizeObjectKeys(statementRows[0]);
  const tierDetails = tierRows
    .map(normalizeObjectKeys)
    .filter((row) => !isBaseSummary(row))
    .map(normalizeTierDetail);
  const accruals = accrualRows
    .map(normalizeObjectKeys)
    .filter((row) => !isBaseSummary(row))
    .map(normalizeAccrual);
  const cashTransactions = cashTransactionRows
    .map(normalizeObjectKeys)
    .filter((row) => !isBaseSummary(row))
    .map(normalizeCashTransaction)
    .filter(Boolean);
  const cashReports = cashReportRows
    .map(normalizeObjectKeys)
    .filter((row) => normalizeCurrency(pick(row, ['currency'])) && !isBaseSummary(row))
    .map(normalizeCashReport);

  return {
    accountId: expectedAccountId,
    fromDate: normalizeFlexDate(pick(normalizedStatement, ['fromDate'])),
    toDate: normalizeFlexDate(pick(normalizedStatement, ['toDate'])),
    whenGenerated: toStringOrNull(pick(normalizedStatement, ['whenGenerated'])),
    tierDetails,
    accruals,
    cashTransactions,
    cashReports,
    derived: {
      dailyDebitActuals: deriveDailyDebitActuals(tierDetails),
      monthlyPaid: deriveMonthlyPaid(cashTransactions),
    },
  };
}

module.exports = {
  BASE_SUMMARY_CURRENCY,
  BROKER_INTEREST_PAID,
  BROKER_INTEREST_RECEIVED,
  canonicalCashInterestType,
  deriveDailyDebitActuals,
  deriveMonthlyPaid,
  normalizeFlexDate,
  parseFlexInterestResponse,
  parseFlexInterestStatement,
};
