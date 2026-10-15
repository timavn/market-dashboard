#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  createIbkrFlexInterestService,
} = require('../src/services/ibkrFlexInterestService.cjs');
const {
  buildMatches,
  getConfig: getValidationConfig,
  nyParts,
} = require('../src/services/ibkrInterestValidationService.cjs');
const {
  createInterestValidationStore,
} = require('../src/services/ibkrInterestValidationStore.cjs');
const {
  coveredMonthFromDescription,
  deriveMonthlyPaid,
  deriveStockBorrowFeePayments,
  isSecuritiesLendingIncomeTransaction,
  isStockBorrowFeeTransaction,
} = require('../src/utils/ibkrFlexInterest.cjs');

const TIME_ZONE = 'America/New_York';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value) {
  const parsed = finite(value);
  if (parsed === null) return null;
  return Number((Math.round((parsed + Number.EPSILON) * 100) / 100).toFixed(2));
}

function isoDate(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function addUtcDays(value, count) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function daysBetween(left, right) {
  return Math.floor(
    (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`))
    / 86_400_000,
  );
}

function continuousDates(first, last) {
  if (!isoDate(first) || !isoDate(last) || first > last) return [];
  const dates = [];
  for (let date = first; date <= last; date = addUtcDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function tierRowDate(row) {
  return isoDate(row?.valueDate || row?.reportDate || row?.toDate || row?.fromDate);
}

function tierPrincipal(row) {
  const total = finite(row?.totalPrincipal);
  if (total !== null) return Math.abs(total);
  const components = [
    row?.securitiesPrincipal,
    row?.commoditiesPrincipal,
    row?.ibuklPrincipal,
  ].map(finite).filter((value) => value !== null);
  return components.length
    ? components.reduce((sum, value) => sum + Math.abs(value), 0)
    : null;
}

function snapshotRank(snapshot) {
  return [String(snapshot?.fetchedAt || ''), String(snapshot?.revisionHash || '')]
    .join('|');
}

function latestTierRowsByDate(snapshots) {
  const byDate = new Map();
  [...snapshots]
    .filter((snapshot) => (
      snapshot?.source === 'ibkr_flex_interest_web_service'
      && Array.isArray(snapshot.tierDetails)
    ))
    .sort((left, right) => snapshotRank(left).localeCompare(snapshotRank(right)))
    .forEach((snapshot) => {
      const rowsByDate = new Map();
      snapshot.tierDetails.forEach((row) => {
        const date = tierRowDate(row);
        if (!date || row?.currency !== 'USD' || finite(row.totalInterest) === null) return;
        if (!rowsByDate.has(date)) rowsByDate.set(date, []);
        rowsByDate.get(date).push(row);
      });
      rowsByDate.forEach((rows, date) => {
        byDate.set(date, { snapshot, rows });
      });
    });
  return byDate;
}

function summarizeTierDay(date, entry) {
  if (!entry) return null;
  const result = {
    date,
    debit: 0,
    credit: 0,
    shortCredit: 0,
    other: 0,
    net: 0,
    rowCount: entry.rows.length,
    sourceFetchedAt: entry.snapshot.fetchedAt,
    sourceFromDate: entry.snapshot.fromDate,
    sourceToDate: entry.snapshot.toDate,
  };
  entry.rows.forEach((row) => {
    const interest = finite(row.totalInterest);
    if (interest === null) return;
    const type = String(row.interestType || '').toLowerCase();
    result.net += interest;
    if (type.includes('debit')) {
      result.debit += Math.abs(interest);
    } else if (type.includes('short') && type.includes('credit')) {
      result.shortCredit += Math.abs(interest);
    } else if (type.includes('credit')) {
      result.credit += Math.abs(interest);
    } else {
      result.other += interest;
    }
  });
  ['debit', 'credit', 'shortCredit', 'other', 'net'].forEach((field) => {
    result[field] = roundMoney(result[field]);
  });
  return result;
}

function verifiedObservations(records) {
  const seen = new Set();
  return records
    .filter((row) => (
      row?.verified === true
      && isoDate(row.sessionDate)
      && finite(row.liveAccruedCash) !== null
      && Number.isFinite(Date.parse(String(row.observedAt || '')))
    ))
    .sort((left, right) => (
      String(left.observedAt).localeCompare(String(right.observedAt))
      || Number(left.sequence || 0) - Number(right.sequence || 0)
    ))
    .filter((row) => {
      const value = finite(row.liveAccruedCash);
      const identity = `${row.sessionDate}|${Number(value.toFixed(8)).toFixed(8)}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}

function latestObservationByDate(records) {
  return verifiedObservations(records).reduce((map, row) => {
    map.set(row.sessionDate, row);
    return map;
  }, new Map());
}

function observationLedger(records) {
  const rows = verifiedObservations(records);
  return rows.map((row, index) => {
    const previous = [...rows.slice(0, index)].reverse().find(
      (candidate) => candidate.sessionDate.slice(0, 7) === row.sessionDate.slice(0, 7),
    ) || null;
    return {
      session_date: row.sessionDate,
      observed_at: row.observedAt,
      live_mtd_net_accrued_signed: roundMoney(row.liveAccruedCash),
      live_mtd_cost_display: roundMoney(Math.max(0, -row.liveAccruedCash)),
      change_since_prior_checkpoint: previous
        ? roundMoney(row.liveAccruedCash - previous.liveAccruedCash)
        : null,
      calendar_days_since_prior_checkpoint: previous
        ? daysBetween(previous.sessionDate, row.sessionDate)
        : null,
      source: row.source || 'ibkr_live_interest_observation',
    };
  });
}

function latestActualsByDate(records) {
  return records
    .filter((row) => (
      row?.kind === 'daily'
      && row?.verified === true
      && isoDate(row.valueDate)
      && finite(row.debitAmount) !== null
    ))
    .reduce((map, row) => {
      const current = map.get(row.valueDate);
      if (
        !current
        || String(row.fetchedAt || '').localeCompare(String(current.fetchedAt || '')) >= 0
      ) map.set(row.valueDate, row);
      return map;
    }, new Map());
}

function forecastLedger(predictions, actuals) {
  const matches = new Map(buildMatches(predictions, actuals).map((row) => [row.id, row]));
  return predictions
    .filter((row) => row?.prospective === true && row?.verified === true)
    .sort((left, right) => String(left.valueDate).localeCompare(String(right.valueDate)))
    .map((row) => {
      const match = matches.get(row.identity) || null;
      return {
        value_date: row.valueDate,
        covered_value_dates: Array.isArray(row.coveredValueDates)
          ? row.coveredValueDates.join('|')
          : '',
        issued_at: row.issuedAt || null,
        accrual_days: row.accrualDays,
        estimated_principal: finite(row.principal),
        raw_forecast: finite(row.raw),
        point_forecast: finite(row.point),
        upper_forecast: finite(row.upper),
        effective_annual_rate: finite(row.effectiveAnnualRate),
        actual_debit_interest: match ? finite(match.actualInterest) : null,
        point_residual_actual_minus_forecast: match
          ? roundMoney(match.actualInterest - row.point)
          : null,
        comparison_status: match ? 'verified' : 'awaiting_flex_actual',
        model_status: row.status || null,
      };
    });
}

function cashTransactionKey(row) {
  return [
    row?.transactionId,
    row?.date,
    row?.currency,
    row?.type,
    row?.amount,
    row?.description,
  ].join('|');
}

function uniqueCashTransactions(snapshots) {
  const rows = new Map();
  [...snapshots]
    .sort((left, right) => snapshotRank(left).localeCompare(snapshotRank(right)))
    .forEach((snapshot) => {
      (snapshot?.cashTransactions || []).forEach((row) => {
        if (row?.currency === 'USD' && finite(row.amount) !== null) {
          rows.set(cashTransactionKey(row), row);
        }
      });
    });
  return [...rows.values()].sort((left, right) => (
    String(left.date).localeCompare(String(right.date))
    || String(left.description).localeCompare(String(right.description))
  ));
}

function postingCategory(row) {
  if (isStockBorrowFeeTransaction(row)) return 'stock_borrow_fee';
  if (isSecuritiesLendingIncomeTransaction(row)) return 'securities_lending_income';
  const description = String(row?.description || '').toUpperCase();
  if (description.includes('SHORT CREDIT INTEREST')) return 'short_credit_interest';
  if (description.includes('DEBIT INT')) return 'margin_debit_interest';
  if (description.includes('CREDIT INT')) return 'cash_credit_interest';
  return 'other_broker_interest';
}

function postingLedger(snapshots) {
  return uniqueCashTransactions(snapshots).map((row) => ({
    posted_date: row.date || null,
    covered_month: coveredMonthFromDescription(row.description),
    category: postingCategory(row),
    amount_signed: roundMoney(row.amount),
    currency: row.currency,
    transaction_type: row.type,
    description: row.description,
  }));
}

function formulaAudit(snapshots) {
  const tierDays = latestTierRowsByDate(snapshots);
  return [...tierDays.values()]
    .flatMap((entry) => entry.rows.map((row) => {
      const principal = tierPrincipal(row);
      const ratePercent = finite(row.rate);
      const actual = finite(row.totalInterest);
      const formula = (
        principal === null || ratePercent === null
          ? null
          : roundMoney((principal * ratePercent / 100) / 360)
      );
      return {
        value_date: tierRowDate(row),
        interest_type: row.interestType,
        principal,
        annual_rate_percent: ratePercent,
        day_count: 360,
        formula_interest_absolute: formula,
        ibkr_interest_absolute: actual === null ? null : roundMoney(Math.abs(actual)),
        residual_ibkr_minus_formula: (
          formula === null || actual === null
            ? null
            : roundMoney(Math.abs(actual) - formula)
        ),
      };
    }))
    .sort((left, right) => (
      left.value_date.localeCompare(right.value_date)
      || left.interest_type.localeCompare(right.interest_type)
    ));
}

function dailyLedger({ snapshots, observations, predictions, actuals }) {
  const tierDays = latestTierRowsByDate(snapshots);
  const observationByDate = latestObservationByDate(observations);
  const predictionByDate = new Map(predictions
    .filter((row) => row?.prospective === true && row?.verified === true)
    .map((row) => [row.valueDate, row]));
  const actualByDate = latestActualsByDate(actuals);
  const dates = [
    ...tierDays.keys(),
    ...observationByDate.keys(),
    ...predictionByDate.keys(),
    ...actualByDate.keys(),
  ].filter(isoDate).sort();
  if (!dates.length) return [];

  let runningMonth = null;
  let reportedMtdNet = 0;
  return continuousDates(dates[0], dates.at(-1)).map((date) => {
    const month = date.slice(0, 7);
    if (month !== runningMonth) {
      runningMonth = month;
      reportedMtdNet = 0;
    }
    const tier = summarizeTierDay(date, tierDays.get(date));
    if (tier) reportedMtdNet = roundMoney(reportedMtdNet + tier.net);
    const observation = observationByDate.get(date) || null;
    const prediction = predictionByDate.get(date) || null;
    const actual = actualByDate.get(date) || null;
    return {
      date,
      flex_debit_interest_cost: tier?.debit ?? null,
      flex_cash_credit_interest: tier?.credit ?? null,
      flex_short_credit_interest: tier?.shortCredit ?? null,
      flex_other_interest_signed: tier?.other ?? null,
      flex_net_interest_signed: tier?.net ?? null,
      flex_reported_mtd_net_signed: tier ? reportedMtdNet : null,
      flex_tier_row_count: tier?.rowCount ?? 0,
      flex_source_fetched_at: tier?.sourceFetchedAt ?? null,
      live_mtd_net_accrued_signed: observation
        ? roundMoney(observation.liveAccruedCash)
        : null,
      live_mtd_observed_at: observation?.observedAt ?? null,
      forecast_point_debit_cost: prediction ? finite(prediction.point) : null,
      forecast_upper_debit_cost: prediction ? finite(prediction.upper) : null,
      forecast_estimated_principal: prediction ? finite(prediction.principal) : null,
      flex_actual_debit_cost: actual ? finite(actual.debitAmount) : null,
      row_status: tier || observation || prediction || actual
        ? 'verified_evidence_present'
        : 'no_verified_interest_row',
    };
  });
}

function summarizeExport({ snapshots, observations, predictions, actuals, ledger, forecasts, postings, audit, generatedAt }) {
  const tierDates = ledger.filter((row) => row.flex_tier_row_count > 0).map((row) => row.date);
  const observationRows = observationLedger(observations);
  const actualDates = [...latestActualsByDate(actuals).keys()].sort();
  const exactFormulaRows = audit.filter((row) => row.residual_ibkr_minus_formula === 0);
  const marginPaid = deriveMonthlyPaid(uniqueCashTransactions(snapshots));
  const borrowPaid = deriveStockBorrowFeePayments(uniqueCashTransactions(snapshots));
  return {
    schemaVersion: '1',
    generatedAt,
    timeZone: TIME_ZONE,
    source: 'ibkr_verified_interest_evidence_export',
    accountScoped: true,
    accountIdentifierIncluded: false,
    recovered: {
      immutableFlexRevisions: snapshots.length,
      flexRequestedRangeFrom: snapshots.map((row) => row.fromDate).filter(Boolean).sort()[0] || null,
      flexRequestedRangeThrough: snapshots.map((row) => row.toDate).filter(Boolean).sort().at(-1) || null,
      tierDetailRows: audit.length,
      tierDetailDates: tierDates.length,
      tierDetailFrom: tierDates[0] || null,
      tierDetailThrough: tierDates.at(-1) || null,
      dailyDebitActualDates: actualDates.length,
      dailyDebitActualFrom: actualDates[0] || null,
      dailyDebitActualThrough: actualDates.at(-1) || null,
      liveMtdCheckpoints: observationRows.length,
      forecastRows: forecasts.length,
      matchedForecastRows: forecasts.filter((row) => row.comparison_status === 'verified').length,
      cashPostings: postings.length,
    },
    formulaAudit: {
      rows: audit.length,
      exactToCentRows: exactFormulaRows.length,
      maxAbsoluteResidual: audit.length
        ? Math.max(...audit.map((row) => Math.abs(row.residual_ibkr_minus_formula || 0)))
        : null,
      formula: 'round_cent(abs(principal) * annual_rate_percent / 100 / 360)',
    },
    postedMarginInterestByPostingMonth: marginPaid,
    postedStockBorrowFeesByCoveredMonth: borrowPaid,
    unavailableSections: {
      interestAccrualRows: snapshots.some((row) => row.accruals?.length) ? null : 'not_returned_by_configured_flex_query',
      cashReportRows: snapshots.some((row) => row.cashReports?.length) ? null : 'not_returned_by_configured_flex_query',
      dailyStockBorrowFeeRows: snapshots.some((row) => row.borrowFeeDetails?.length) ? null : 'not_returned_by_configured_flex_query',
    },
    caveats: [
      'Blank cells are unavailable evidence, never inferred zeroes.',
      'Live MTD AccruedCash-S is net debit and credit interest; forecasts and daily debit actuals are gross debit interest.',
      'Spaced live MTD checkpoints cannot be treated as one-day forecast actuals.',
      'Historical Flex tier principal validates the interest arithmetic, but historical live cash/collateral inputs were not archived for principal-model backtesting.',
    ],
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows, columns = null) {
  const headers = columns || (rows[0] ? Object.keys(rows[0]) : []);
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
  ].join('\n') + '\n';
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function atomicPrivateWrite(filePath, content) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
}

function buildExport({ snapshots, observations, predictions, actuals, generatedAt = new Date().toISOString() }) {
  const ledger = dailyLedger({ snapshots, observations, predictions, actuals });
  const forecasts = forecastLedger(predictions, actuals);
  const postings = postingLedger(snapshots);
  const audit = formulaAudit(snapshots);
  const summary = summarizeExport({
    snapshots,
    observations,
    predictions,
    actuals,
    ledger,
    forecasts,
    postings,
    audit,
    generatedAt,
  });
  return {
    summary,
    ledger,
    observations: observationLedger(observations),
    forecasts,
    postings,
    formulaAudit: audit,
  };
}

function loadPrivateLedgerBundle({
  env = process.env,
  now = new Date(),
  accountId = null,
} = {}) {
  const config = getValidationConfig(env);
  if (!config.enabled || !config.expectedAccountId) {
    throw Object.assign(new Error('IBKR interest validation account is not configured.'), {
      code: 'interest_export_not_configured',
      status: 503,
    });
  }
  const requestedAccountId = String(accountId || '').trim();
  if (requestedAccountId && requestedAccountId !== config.expectedAccountId) {
    throw Object.assign(new Error('The requested account does not match the interest ledger.'), {
      code: 'interest_ledger_account_mismatch',
      status: 403,
    });
  }
  const accountDataDir = path.join(
    config.dataDir,
    'accounts',
    config.accountFingerprint,
  );
  const store = createInterestValidationStore({ dataDir: accountDataDir });
  const flexService = createIbkrFlexInterestService({
    env,
    dataDir: path.join(accountDataDir, 'flex'),
  });
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const data = buildExport({
    snapshots: flexService.history({ limit: 1000 }),
    observations: store.readRecords('observations'),
    predictions: store.readRecords('predictions'),
    actuals: store.readRecords('actuals'),
    generatedAt,
  });
  return {
    accountDataDir,
    config,
    data,
    generatedAt,
  };
}

function readPrivateInterestLedger(options = {}) {
  const {
    config,
    data,
    generatedAt,
  } = loadPrivateLedgerBundle(options);
  const evidenceRowCount = data.summary.recovered.tierDetailRows
    + data.summary.recovered.dailyDebitActualDates
    + data.summary.recovered.liveMtdCheckpoints
    + data.summary.recovered.forecastRows
    + data.summary.recovered.cashPostings;
  return {
    source: 'ibkr_verified_interest_ledger',
    available: evidenceRowCount > 0,
    status: evidenceRowCount > 0 ? 'verified_history' : 'unavailable',
    accountId: config.expectedAccountId,
    accountMatched: true,
    accountMasked: config.accountMasked,
    fromCache: false,
    generatedAt,
    summary: data.summary,
    ledger: data.ledger,
    observations: data.observations,
    forecasts: data.forecasts,
    postings: data.postings,
    formulaAudit: data.formulaAudit,
  };
}

function exportPrivateLedger({ env = process.env, now = new Date() } = {}) {
  const {
    accountDataDir,
    config,
    data,
    generatedAt,
  } = loadPrivateLedgerBundle({ env, now });
  const outputDir = path.join(
    accountDataDir,
    'exports',
    nyParts(new Date(generatedAt), config.timeZone || TIME_ZONE).date,
  );
  ensurePrivateDirectory(outputDir);
  const files = {
    summary: path.join(outputDir, 'summary.json'),
    dailyLedger: path.join(outputDir, 'daily-interest-ledger.csv'),
    observations: path.join(outputDir, 'mtd-observations.csv'),
    forecasts: path.join(outputDir, 'forecast-validation.csv'),
    postings: path.join(outputDir, 'interest-postings.csv'),
    formulaAudit: path.join(outputDir, 'tier-formula-audit.csv'),
  };
  atomicPrivateWrite(files.summary, `${JSON.stringify(data.summary, null, 2)}\n`);
  atomicPrivateWrite(files.dailyLedger, toCsv(data.ledger));
  atomicPrivateWrite(files.observations, toCsv(data.observations));
  atomicPrivateWrite(files.forecasts, toCsv(data.forecasts));
  atomicPrivateWrite(files.postings, toCsv(data.postings));
  atomicPrivateWrite(files.formulaAudit, toCsv(data.formulaAudit));
  return { outputDir, files, summary: data.summary };
}

if (require.main === module) {
  require('dotenv').config({
    path: path.join(process.cwd(), '.env'),
    quiet: true,
  });
  try {
    const result = exportPrivateLedger();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      code: error?.code || 'interest_export_failed',
      message: String(error?.message || 'IBKR interest export failed')
        .replace(/\b[UDF]\d{5,}\b/gi, '[account-redacted]'),
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildExport,
  dailyLedger,
  exportPrivateLedger,
  formulaAudit,
  forecastLedger,
  observationLedger,
  postingLedger,
  readPrivateInterestLedger,
  toCsv,
};
