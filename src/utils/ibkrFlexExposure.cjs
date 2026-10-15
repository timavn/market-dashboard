const { XMLParser } = require('fast-xml-parser');
const crypto = require('node:crypto');
const { zonedTimeToUtc } = require('date-fns-tz');

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).replace(/[$,%\s,]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickNumber(source, keys) {
  for (const key of keys) {
    const value = toNumber(source?.[key]);
    if (value != null) return value;
  }
  return null;
}

function moneyMicros(value) {
  const numeric = toNumber(value);
  return numeric == null ? null : Math.round(numeric * 1_000_000);
}

function exactText(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function reportedIdentifier(source, keys) {
  const value = exactText(source, keys);
  if (!value || /^(?:N\/?A|NONE|NULL|-+)$/i.test(value)) return null;
  return value;
}

function normalizeKey(key) {
  return String(key || '').replace(/^@_/, '').toLowerCase();
}

function normalizeObjectKeys(row = {}) {
  const normalized = {};
  for (const key of Object.keys(row || {})) {
    const value = row[key];
    normalized[key] = value;
    normalized[normalizeKey(key)] = value;
  }
  return normalized;
}

function rowLevelOfDetail(row) {
  let value = null;
  for (const key of Object.keys(row || {})) {
    if (normalizeKey(key) === 'levelofdetail') value = row[key];
  }
  return String(value || '').toUpperCase();
}

const STATEMENT_NODE_TAGS = [
  'Trades', 'Trade', 'OpenPosition', 'Position', 'FxPosition', 'OpenPositions',
  'OptionEAE', 'OptionEAERecords', 'OptionExerciseAssignmentExpiration',
  'OptionExercisesAssignmentsExpirations', 'OptionExercise', 'OptionAssignment', 'OptionExpiration',
  'CashTransaction', 'CashTransactions', 'CashReport', 'CashBalance',
  'StatementOfFunds', 'StatementOfFundsLine', 'StmtFunds', 'StmtFundsLine', 'StatementOfFundsActivity',
  'NetAssetValueByCurrency', 'NetAssetValue', 'EquitySummary',
];

function createNodeLookup(root, tagNames = STATEMENT_NODE_TAGS) {
  const wanted = new Set(tagNames.map(tag => tag.toLowerCase()));
  const byName = new Map();
  const ordered = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      const name = key.toLowerCase();
      if (wanted.has(name)) {
        const rows = asArray(value);
        const existing = byName.get(name) || [];
        for (const row of rows) existing.push(row);
        byName.set(name, existing);
        ordered.push({ name, rows });
      }
      // Attributes are scalar leaves. Avoid creating arrays and entering a
      // recursive call for every attribute of every execution on every query.
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) value.forEach(walk);
        else walk(value);
      }
    }
  }
  walk(root);
  return {
    collect(names) {
      if (names.length === 1) return byName.get(names[0].toLowerCase()) || [];
      const selected = new Set(names.map(name => name.toLowerCase()));
      const result = [];
      for (const entry of ordered) {
        if (selected.has(entry.name)) for (const row of entry.rows) result.push(row);
      }
      return result;
    },
    has: names => names.some(name => byName.has(name.toLowerCase())),
  };
}

function parseFlexXml(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
  });
  return parser.parse(xmlText || '');
}

function parseFlexResponse(xmlText) {
  const parsed = parseFlexXml(xmlText);
  const response = parsed?.FlexStatementResponse || parsed?.FlexQueryResponse || parsed || {};
  const status = response.Status || response.status || null;
  const referenceCode = response.ReferenceCode || response.referenceCode || response.Reference || response.reference || null;
  const url = response.url || response.Url || response.URL || null;
  const errorCode = response.ErrorCode || response.errorCode || null;
  const errorMessage = response.ErrorMessage || response.errorMessage || null;
  return { status, referenceCode, url, errorCode, errorMessage, raw: parsed };
}

function normalizeFlexPosition(row) {
  const normalized = normalizeObjectKeys(row);
  const quantity = pickNumber(normalized, ['position', 'quantity', 'qty', 'shares']);
  const marketValue = pickNumber(normalized, [
    'marketvalue',
    'positionvalue',
    'value',
    'markvalue',
    'fmv',
  ]);
  const symbol =
    normalized.symbol ||
    normalized.underlyingsymbol ||
    normalized.conid ||
    normalized.description ||
    normalized.assetdescription ||
    '';
  const assetCategory = String(normalized.assetcategory || normalized.assetclass || normalized.sectype || '').toUpperCase();
  const currency = normalized.currency || normalized.currencyprimary || normalized.basecurrency || null;
  const isCash = assetCategory === 'CASH' || String(symbol).toUpperCase() === 'CASH';
  if (isCash) return null;
  if (marketValue == null && quantity == null) return null;
  return {
    symbol: String(symbol || '').trim(),
    description: normalized.description || normalized.assetdescription || null,
    assetCategory: assetCategory || null,
    currency,
    quantity,
    marketValue,
  };
}

function normalizeFlexCash(row) {
  const normalized = normalizeObjectKeys(row);
  return pickNumber(normalized, [
    'total',
    'endingcash',
    'cash',
    'cashbalance',
    'settledcash',
    'totalcash',
    'amount',
  ]);
}

function normalizeFlexNlv(row) {
  const normalized = normalizeObjectKeys(row);
  return pickNumber(normalized, [
    'total',
    'netassetvalue',
    'netliquidation',
    'netliquidationvalue',
    'equitywithloanvalue',
    'amount',
    'value',
  ]);
}

function normalizeFlexDateTime(value, tradeDate = null, timeZone = 'America/New_York') {
  const raw = String(value || '').trim();
  const date = String(tradeDate || '').trim();
  const localDateTime = raw.match(/^(\d{4})-?(\d{2})-?(\d{2})[;, T](\d{2}):?(\d{2}):?(\d{2})$/);
  const dateOnly = date.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  const rawDateOnly = raw.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  const timeOnly = raw.match(/^(\d{2}):?(\d{2}):?(\d{2})$/);
  let local = null;
  if (localDateTime) local = `${localDateTime[1]}-${localDateTime[2]}-${localDateTime[3]} ${localDateTime[4]}:${localDateTime[5]}:${localDateTime[6]}`;
  else if (dateOnly && timeOnly) local = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]} ${timeOnly[1]}:${timeOnly[2]}:${timeOnly[3]}`;
  else if (rawDateOnly) local = `${rawDateOnly[1]}-${rawDateOnly[2]}-${rawDateOnly[3]} 00:00:00`;
  if (local) {
    const parsed = zonedTimeToUtc(local, timeZone);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeFlexTrade(row, { accountId = null, timeZone = 'America/New_York' } = {}) {
  const normalized = normalizeObjectKeys(row);
  const conId = pickNumber(normalized, ['conid', 'contractid']);
  const quantity = Math.abs(pickNumber(normalized, ['quantity', 'qty', 'shares']) || 0);
  const price = pickNumber(normalized, ['tradeprice', 'price']);
  const sideRaw = String(normalized.buysell || normalized.side || normalized.action || '').trim().toUpperCase();
  const direction = ['BUY', 'BOT', 'B'].includes(sideRaw)
    ? 'BUY'
    : ['SELL', 'SLD', 'S'].includes(sideRaw)
      ? 'SELL'
      : null;
  const tradeDate = normalized.tradedate || normalized.date || null;
  const executionTime = normalizeFlexDateTime(
    normalized.datetime || normalized.tradedatetime || normalized.time || '',
    tradeDate,
    timeZone,
  );
  if (!Number.isInteger(conId) || conId <= 0 || quantity <= 0 || price == null || price < 0 || !direction || !executionTime) return null;
  const brokerExecutionId = reportedIdentifier(normalized, [
    'ibexecid', 'execid', 'extexecid', 'executionid',
  ]);
  const rawId = brokerExecutionId
    || reportedIdentifier(normalized, ['tradeid', 'transactionid', 'orderid', 'iborderid']);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
  const brokerId = rawId == null ? null : String(rawId).trim();
  const putCall = String(normalized.putcall || normalized.right || '').trim().toUpperCase();
  const contractSide = putCall === 'C' || putCall === 'CALL'
    ? 'YES'
    : putCall === 'P' || putCall === 'PUT'
      ? 'NO'
      : null;
  const commissionRaw = pickNumber(normalized, ['ibcommission', 'commission', 'commissions']);
  const taxRaw = pickNumber(normalized, ['tax', 'taxes', 'transactiontax']);
  const statementAccount = String(normalized.accountid || normalized.account || accountId || '').trim();
  const proceeds = pickNumber(normalized, ['proceeds']);
  const netCash = pickNumber(normalized, ['netcash', 'netamount', 'cash']);
  const costBasis = pickNumber(normalized, ['costbasis', 'cost', 'basis', 'costbasisofposition']);
  const realizedPnl = pickNumber(normalized, [
    'fifopnlrealized', 'realizedpnl', 'realizedprofitloss', 'mtmpnl',
  ]);
  return {
    accountId: statementAccount || null,
    execId: brokerId || `flex-${fingerprint.slice(0, 32)}`,
    brokerExecutionId,
    tradeId: normalized.tradeid || null,
    transactionId: normalized.transactionid || null,
    orderId: pickNumber(normalized, ['orderid', 'iborderid', 'brokerageorderid']),
    permId: pickNumber(normalized, ['permid']),
    orderRef: normalized.orderreference || normalized.orderref || null,
    conId,
    symbol: String(normalized.symbol || normalized.underlyingsymbol || '').trim(),
    localSymbol: String(normalized.localsymbol || normalized.symbol || '').trim(),
    description: normalized.description || normalized.assetdescription || null,
    exchange: normalized.exchange || normalized.listingexchange || null,
    secType: String(normalized.assetcategory || normalized.assetclass || normalized.sectype || '').trim().toUpperCase() || null,
    tradingClass: normalized.tradingclass || null,
    expiration: normalized.expiry || normalized.expiration || null,
    strike: pickNumber(normalized, ['strike']),
    contractSide,
    direction,
    side: direction,
    shares: quantity,
    quantity,
    price,
    tradePrice: price,
    proceeds,
    proceedsMicros: moneyMicros(proceeds),
    netCash,
    netCashMicros: moneyMicros(netCash),
    costBasis,
    costBasisMicros: moneyMicros(costBasis),
    realizedPnl,
    realizedPnlMicros: moneyMicros(realizedPnl),
    commission: commissionRaw == null ? null : Math.abs(commissionRaw),
    commissionMicros: moneyMicros(commissionRaw == null ? null : Math.abs(commissionRaw)),
    tax: taxRaw == null ? 0 : Math.abs(taxRaw),
    taxMicros: moneyMicros(taxRaw == null ? 0 : Math.abs(taxRaw)),
    commissionCurrency: normalized.ibcommissioncurrency || normalized.currency || normalized.currencyprimary || null,
    openCloseIndicator: exactText(normalized, ['opencloseindicator', 'openclose', 'code']),
    levelOfDetail: exactText(normalized, ['levelofdetail']),
    transactionType: exactText(normalized, ['transactiontype', 'type']),
    executionTime,
    tradeDate: executionTime.slice(0, 10),
    source: 'ibkr_flex_import',
    rawFingerprint: fingerprint,
    brokerIdentifierStatus: brokerId ? 'reported' : 'derived_fingerprint',
  };
}

function normalizedEvidenceBase(row, { accountId = null, timeZone = 'America/New_York' } = {}) {
  const normalized = normalizeObjectKeys(row);
  const statementAccount = exactText(normalized, ['accountid', 'account']) || accountId || null;
  const tradeDate = exactText(normalized, ['tradedate', 'date', 'reportdate', 'settledate']);
  const occurredAt = normalizeFlexDateTime(
    exactText(normalized, ['datetime', 'tradedatetime', 'activitydatetime', 'time']) || tradeDate,
    tradeDate,
    timeZone,
  );
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
  return {
    normalized,
    accountId: statementAccount,
    occurredAt,
    tradeDate: occurredAt?.slice(0, 10) || null,
    fingerprint,
  };
}

function normalizeFlexClosedLot(row, options = {}) {
  const base = normalizedEvidenceBase(row, options);
  const { normalized } = base;
  const realizedPnl = pickNumber(normalized, ['fifopnlrealized', 'realizedpnl', 'realizedprofitloss']);
  const costBasis = pickNumber(normalized, ['costbasis', 'basis', 'costbasisofposition']);
  const proceeds = pickNumber(normalized, ['proceeds', 'netcash', 'netamount']);
  const commission = pickNumber(normalized, ['ibcommission', 'commission', 'commissions']);
  const tax = pickNumber(normalized, ['tax', 'taxes', 'transactiontax']);
  const tradeId = exactText(normalized, ['tradeid', 'transactionid', 'execid', 'executionid']);
  return {
    accountId: base.accountId,
    controlId: tradeId || `closed-lot-${base.fingerprint.slice(0, 32)}`,
    tradeId: exactText(normalized, ['tradeid']),
    transactionId: exactText(normalized, ['transactionid']),
    execId: exactText(normalized, ['execid', 'executionid']),
    conId: pickNumber(normalized, ['conid', 'contractid']),
    symbol: exactText(normalized, ['symbol', 'underlyingsymbol']),
    localSymbol: exactText(normalized, ['localsymbol', 'symbol']),
    description: exactText(normalized, ['description', 'assetdescription']),
    exchange: exactText(normalized, ['exchange', 'listingexchange']),
    currency: exactText(normalized, ['currency', 'currencyprimary']),
    quantity: Math.abs(pickNumber(normalized, ['quantity', 'qty', 'shares']) || 0),
    proceeds,
    proceedsMicros: moneyMicros(proceeds),
    costBasis,
    costBasisMicros: moneyMicros(costBasis),
    commission: commission == null ? null : Math.abs(commission),
    commissionMicros: moneyMicros(commission == null ? null : Math.abs(commission)),
    tax: tax == null ? null : Math.abs(tax),
    taxMicros: moneyMicros(tax == null ? null : Math.abs(tax)),
    realizedPnl,
    realizedPnlMicros: moneyMicros(realizedPnl),
    openDateTime: normalizeFlexDateTime(exactText(normalized, ['opendatetime', 'opendate']), null, options.timeZone),
    closeDateTime: normalizeFlexDateTime(exactText(normalized, ['closedatetime', 'closedate']), null, options.timeZone),
    occurredAt: base.occurredAt,
    rawFingerprint: base.fingerprint,
    source: 'ibkr_flex_closed_lot_control',
  };
}

function normalizeFlexOptionEvent(row, options = {}) {
  const base = normalizedEvidenceBase(row, options);
  const { normalized } = base;
  const proceeds = pickNumber(normalized, ['proceeds', 'netcash', 'netamount', 'amount']);
  const costBasis = pickNumber(normalized, ['costbasis', 'basis']);
  const realizedPnl = pickNumber(normalized, ['fifopnlrealized', 'realizedpnl', 'realizedprofitloss']);
  const commission = pickNumber(normalized, ['ibcommission', 'commission', 'commissions', 'fee']);
  const tax = pickNumber(normalized, ['tax', 'taxes', 'transactiontax']);
  const eventId = exactText(normalized, ['tradeid', 'transactionid', 'execid', 'executionid']);
  return {
    accountId: base.accountId,
    eventId: eventId || `option-event-${base.fingerprint.slice(0, 32)}`,
    tradeId: exactText(normalized, ['tradeid']),
    transactionId: exactText(normalized, ['transactionid']),
    conId: pickNumber(normalized, ['conid', 'contractid']),
    symbol: exactText(normalized, ['symbol', 'underlyingsymbol']),
    localSymbol: exactText(normalized, ['localsymbol', 'symbol']),
    description: exactText(normalized, ['description', 'assetdescription']),
    exchange: exactText(normalized, ['exchange', 'listingexchange']),
    transactionType: exactText(normalized, ['transactiontype', 'type', 'code']),
    quantity: Math.abs(pickNumber(normalized, ['quantity', 'qty', 'shares']) || 0),
    proceeds,
    proceedsMicros: moneyMicros(proceeds),
    costBasis,
    costBasisMicros: moneyMicros(costBasis),
    commission: commission == null ? null : Math.abs(commission),
    commissionMicros: moneyMicros(commission == null ? null : Math.abs(commission)),
    tax: tax == null ? null : Math.abs(tax),
    taxMicros: moneyMicros(tax == null ? null : Math.abs(tax)),
    realizedPnl,
    realizedPnlMicros: moneyMicros(realizedPnl),
    occurredAt: base.occurredAt,
    rawFingerprint: base.fingerprint,
    source: 'ibkr_flex_option_event_control',
  };
}

function normalizeFlexCashTransaction(row, options = {}) {
  const base = normalizedEvidenceBase(row, options);
  const { normalized } = base;
  const amount = pickNumber(normalized, ['amount', 'proceeds', 'netcash', 'netamount']);
  const transactionId = exactText(normalized, ['transactionid', 'tradeid', 'activitycode']);
  return {
    accountId: base.accountId,
    transactionId: transactionId || `cash-${base.fingerprint.slice(0, 32)}`,
    conId: pickNumber(normalized, ['conid', 'contractid']),
    symbol: exactText(normalized, ['symbol', 'underlyingsymbol']),
    description: exactText(normalized, ['description', 'activitydescription']),
    transactionType: exactText(normalized, ['type', 'transactiontype', 'activitycode']),
    currency: exactText(normalized, ['currency', 'currencyprimary']),
    amount,
    amountMicros: moneyMicros(amount),
    occurredAt: base.occurredAt,
    rawFingerprint: base.fingerprint,
    source: 'ibkr_flex_cash_control',
  };
}

function normalizeFlexFundsLine(row, options = {}) {
  const base = normalizedEvidenceBase(row, options);
  const { normalized } = base;
  const amount = pickNumber(normalized, ['amount', 'cash', 'netcash', 'balance', 'endingcash']);
  const lineId = exactText(normalized, ['transactionid', 'tradeid', 'activitycode', 'code']);
  return {
    accountId: base.accountId,
    lineId: lineId || `funds-${base.fingerprint.slice(0, 32)}`,
    transactionId: exactText(normalized, ['transactionid']),
    conId: pickNumber(normalized, ['conid', 'contractid']),
    symbol: exactText(normalized, ['symbol', 'underlyingsymbol']),
    description: exactText(normalized, ['description', 'activitydescription']),
    lineType: exactText(normalized, ['type', 'transactiontype', 'activitycode', 'code']),
    currency: exactText(normalized, ['currency', 'currencyprimary']),
    amount,
    amountMicros: moneyMicros(amount),
    occurredAt: base.occurredAt,
    rawFingerprint: base.fingerprint,
    source: 'ibkr_flex_statement_of_funds_control',
  };
}

function computeFlexExposure({ positions = [], cashValue = null, nlv = null, targetCashBufferPct = 0 } = {}) {
  let longMV = 0;
  let shortMV = 0;
  let netMV = 0;

  for (const position of positions || []) {
    const mv = Number(position.marketValue);
    const qty = Number(position.quantity);
    if (!Number.isFinite(mv) && !Number.isFinite(qty)) continue;
    const signedMarketValue = Number.isFinite(mv) ? mv : 0;
    if (qty < 0 || signedMarketValue < 0) {
      shortMV += Math.abs(signedMarketValue);
      netMV += signedMarketValue;
    } else if (qty > 0 || signedMarketValue > 0) {
      longMV += Math.abs(signedMarketValue);
      netMV += signedMarketValue;
    }
  }

  const numericCash = Number(cashValue);
  const normalizedCash = Number.isFinite(numericCash) ? numericCash : null;
  const numericNlv = Number(nlv);
  const normalizedNlv = Number.isFinite(numericNlv) && numericNlv > 0
    ? numericNlv
    : null;
  const hasNlv = Number.isFinite(normalizedNlv) && normalizedNlv > 0;
  const grossMV = longMV + shortMV;
  const targetCashBuffer = hasNlv ? normalizedNlv * (Number(targetCashBufferPct || 0) / 100) : 0;
  const equityCashSurplus = hasNlv ? normalizedNlv - longMV : null;
  const longFundingGap = hasNlv ? Math.max(0, longMV + targetCashBuffer - normalizedNlv) : null;

  return {
    longMV,
    shortMV,
    grossMV,
    netMV,
    cashValue: normalizedCash,
    nlv: hasNlv ? normalizedNlv : null,
    longPct: hasNlv ? (longMV / normalizedNlv) * 100 : null,
    shortPct: hasNlv ? (shortMV / normalizedNlv) * 100 : null,
    grossPct: hasNlv ? (grossMV / normalizedNlv) * 100 : null,
    netPct: hasNlv ? ((longMV - shortMV) / normalizedNlv) * 100 : null,
    cashPct: hasNlv && normalizedCash != null ? (normalizedCash / normalizedNlv) * 100 : null,
    targetCashBuffer,
    equityCashSurplus,
    longFundingGap,
    hasData: hasNlv,
  };
}

function parseFlexStatement(xmlText, { targetCashBufferPct = 0 } = {}) {
  return parseFlexStatementDocument(parseFlexXml(xmlText), { targetCashBufferPct });
}

function parseFlexStatementDocument(parsed, { targetCashBufferPct = 0 } = {}) {
  const document = createNodeLookup(parsed, ['FlexStatement', 'FlexStatements']);
  const statements = document.collect(['FlexStatement']);
  const statementNodes = statements.length ? statements : [document.collect(['FlexStatements'])[0] || parsed];
  const requiredSectionNames = ['executions', 'closedLots', 'optionEvents', 'cashTransactions', 'statementOfFunds', 'openPositions'];

  const accounts = statementNodes.map((statement) => {
    // Index each account independently once; repeated whole-statement walks
    // previously revisited every execution attribute for every section.
    const nodes = createNodeLookup(statement);
    const normalizedStatement = normalizeObjectKeys(statement);
    const accountId = exactText(normalizedStatement, ['accountid', 'account']);
    const timeZone = exactText(normalizedStatement, ['timezone', 'timezoneid']) || 'America/New_York';
    const tradeGroups = nodes.collect(['Trades']);
    const executionRows = [];
    const closedLotRows = [];
    tradeGroups.forEach((group) => {
      const rows = createNodeLookup(group, ['Trade']).collect(['Trade']);
      const groupDetail = rowLevelOfDetail(group);
      rows.forEach((row) => {
        const detail = rowLevelOfDetail(row) || groupDetail;
        if (detail.includes('CLOSED')) closedLotRows.push(row);
        else executionRows.push(row);
      });
    });
    if (!tradeGroups.length) {
      nodes.collect(['Trade']).forEach((row) => {
        const detail = rowLevelOfDetail(row);
        if (detail.includes('CLOSED')) closedLotRows.push(row);
        else executionRows.push(row);
      });
    }

    const positions = nodes.collect(['OpenPosition', 'Position', 'FxPosition'])
      .map(normalizeFlexPosition)
      .filter(Boolean);
    const trades = executionRows
      .map((row) => normalizeFlexTrade(row, { accountId, timeZone }))
      .filter(Boolean);
    const closedLots = closedLotRows
      .map((row) => normalizeFlexClosedLot(row, { accountId, timeZone }))
      .filter(Boolean);
    const optionEvents = nodes.collect([
      'OptionEAE', 'OptionExerciseAssignmentExpiration', 'OptionExercise', 'OptionAssignment', 'OptionExpiration',
    ]).map((row) => normalizeFlexOptionEvent(row, { accountId, timeZone }));
    const cashTransactions = nodes.collect(['CashTransaction'])
      .map((row) => normalizeFlexCashTransaction(row, { accountId, timeZone }));
    const statementOfFunds = nodes.collect([
      'StatementOfFundsLine', 'StmtFundsLine', 'StatementOfFundsActivity',
    ]).map((row) => normalizeFlexFundsLine(row, { accountId, timeZone }));
    const cashRows = nodes.collect(['CashReport', 'CashBalance']);
    const nlvRows = nodes.collect(['NetAssetValueByCurrency', 'NetAssetValue', 'EquitySummary']);
    const cashValue = cashRows.map(normalizeFlexCash).find((value) => value != null) ?? null;
    const nlv = nlvRows.map(normalizeFlexNlv).find((value) => value != null) ?? null;
    const tradeDetails = tradeGroups.map(rowLevelOfDetail);
    const sections = {
      executions: tradeDetails.some((detail) => detail.includes('EXECUTION'))
        || executionRows.length > 0,
      closedLots: tradeDetails.some((detail) => detail.includes('CLOSED'))
        || closedLotRows.length > 0,
      optionEvents: nodes.has([
        'OptionEAE', 'OptionEAERecords', 'OptionExerciseAssignmentExpiration',
        'OptionExercisesAssignmentsExpirations',
      ]),
      cashTransactions: nodes.has(['CashTransactions', 'CashTransaction']),
      statementOfFunds: nodes.has([
        'StatementOfFunds', 'StatementOfFundsLine', 'StmtFunds', 'StmtFundsLine',
      ]),
      openPositions: nodes.has(['OpenPositions', 'OpenPosition']),
    };
    const missingSections = requiredSectionNames.filter((name) => !sections[name]);
    return {
      accountId,
      fromDate: exactText(normalizedStatement, ['fromdate']),
      toDate: exactText(normalizedStatement, ['todate']),
      reportDate: exactText(normalizedStatement, ['todate', 'fromdate', 'whengenerated']),
      currency: exactText(normalizedStatement, ['currency', 'basecurrency']) || 'USD',
      timeZone,
      sections,
      missingSections,
      complete: Boolean(accountId) && missingSections.length === 0,
      positions,
      positionCount: positions.length,
      trades,
      tradeCount: trades.length,
      closedLots,
      closedLotCount: closedLots.length,
      optionEvents,
      optionEventCount: optionEvents.length,
      cashTransactions,
      cashTransactionCount: cashTransactions.length,
      statementOfFunds,
      statementOfFundsCount: statementOfFunds.length,
      exposure: computeFlexExposure({ positions, cashValue, nlv, targetCashBufferPct }),
    };
  });
  const uniqueAccountIds = [...new Set(accounts.map((account) => account.accountId).filter(Boolean))];
  const topSections = Object.fromEntries(requiredSectionNames.map((name) => [
    name,
    accounts.length > 0 && accounts.every((account) => account.sections[name]),
  ]));
  const missingSections = requiredSectionNames.filter((name) => !topSections[name]);
  const positions = accounts.flatMap((account) => account.positions);
  const totalCash = accounts.reduce((sum, account) => sum + Number(account.exposure.cashValue || 0), 0);
  const totalNlv = accounts.reduce((sum, account) => sum + Number(account.exposure.nlv || 0), 0);
  return {
    reportDate: accounts.map((account) => account.reportDate).filter(Boolean).sort().at(-1) || null,
    fromDate: accounts.map((account) => account.fromDate).filter(Boolean).sort()[0] || null,
    toDate: accounts.map((account) => account.toDate).filter(Boolean).sort().at(-1) || null,
    accountId: uniqueAccountIds.length === 1 ? uniqueAccountIds[0] : null,
    accountIds: uniqueAccountIds,
    accountCount: uniqueAccountIds.length,
    accounts,
    currency: accounts[0]?.currency || 'USD',
    sections: topSections,
    missingSections,
    complete: accounts.length > 0 && accounts.every((account) => account.complete),
    positions,
    positionCount: positions.length,
    trades: accounts.flatMap((account) => account.trades),
    tradeCount: accounts.reduce((sum, account) => sum + account.tradeCount, 0),
    closedLots: accounts.flatMap((account) => account.closedLots),
    closedLotCount: accounts.reduce((sum, account) => sum + account.closedLotCount, 0),
    optionEvents: accounts.flatMap((account) => account.optionEvents),
    optionEventCount: accounts.reduce((sum, account) => sum + account.optionEventCount, 0),
    cashTransactions: accounts.flatMap((account) => account.cashTransactions),
    cashTransactionCount: accounts.reduce((sum, account) => sum + account.cashTransactionCount, 0),
    statementOfFunds: accounts.flatMap((account) => account.statementOfFunds),
    statementOfFundsCount: accounts.reduce((sum, account) => sum + account.statementOfFundsCount, 0),
    exposure: computeFlexExposure({
      positions,
      cashValue: accounts.every((account) => account.exposure.cashValue != null) ? totalCash : null,
      nlv: accounts.every((account) => account.exposure.nlv != null) ? totalNlv : null,
      targetCashBufferPct,
    }),
  };
}

module.exports = {
  computeFlexExposure,
  parseFlexResponse,
  parseFlexStatement,
  parseFlexStatementDocument,
  normalizeFlexTrade,
  normalizeFlexDateTime,
  normalizeFlexClosedLot,
  normalizeFlexOptionEvent,
  normalizeFlexCashTransaction,
  normalizeFlexFundsLine,
};
