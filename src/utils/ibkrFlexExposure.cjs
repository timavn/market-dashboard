const { XMLParser } = require('fast-xml-parser');

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

function normalizeKey(key) {
  return String(key || '').replace(/^@_/, '').toLowerCase();
}

function normalizeObjectKeys(row = {}) {
  return Object.entries(row || {}).reduce((acc, [key, value]) => {
    acc[key] = value;
    acc[normalizeKey(key)] = value;
    return acc;
  }, {});
}

function collectNodes(root, tagNames = []) {
  const wanted = new Set(tagNames.map((tag) => String(tag).toLowerCase()));
  const result = [];

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (wanted.has(String(key).toLowerCase())) {
        result.push(...asArray(value));
      }
      for (const child of asArray(value)) {
        walk(child);
      }
    }
  }

  walk(root);
  return result;
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
  const parsed = parseFlexXml(xmlText);
  const positionRows = collectNodes(parsed, ['OpenPosition', 'Position', 'FxPosition']);
  const positions = positionRows.map(normalizeFlexPosition).filter(Boolean);
  const cashRows = collectNodes(parsed, ['CashReport', 'CashBalance', 'StmtFunds']);
  const nlvRows = collectNodes(parsed, ['NetAssetValueByCurrency', 'NetAssetValue', 'EquitySummary']);
  const cashValue = cashRows.map(normalizeFlexCash).find((value) => value != null) ?? null;
  const nlv = nlvRows.map(normalizeFlexNlv).find((value) => value != null) ?? null;
  const statement =
    collectNodes(parsed, ['FlexStatement'])[0] ||
    collectNodes(parsed, ['FlexStatements'])[0] ||
    {};
  const normalizedStatement = normalizeObjectKeys(statement);
  const reportDate =
    normalizedStatement.todate ||
    normalizedStatement.fromdate ||
    normalizedStatement.whenGenerated ||
    normalizedStatement.whengenerated ||
    null;

  return {
    reportDate,
    accountId: normalizedStatement.accountid || null,
    currency: normalizedStatement.currency || normalizedStatement.basecurrency || 'USD',
    positions,
    positionCount: positions.length,
    exposure: computeFlexExposure({ positions, cashValue, nlv, targetCashBufferPct }),
  };
}

module.exports = {
  computeFlexExposure,
  parseFlexResponse,
  parseFlexStatement,
};
