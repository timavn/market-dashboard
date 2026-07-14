function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9./-]{0,9}$/.test(ticker) ? ticker : null;
}

function isTickerToken(value) {
  const raw = String(value || '').trim();
  if (!raw || raw !== raw.toUpperCase()) return null;
  if (/^(LONG|SHORT|ADD|REMOVE|VIEW)$/i.test(raw)) return null;
  return normalizeTicker(raw);
}

function parseMoney(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[$,\s]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePercent(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[%+\s]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value) {
  const match = String(value || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const [, mm, dd, yy] = match;
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function parseDaysHeld(value) {
  const match = String(value || '').match(/(-?\d+)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function isHeaderToken(token) {
  return /^(current open positions|long:\s*\d+|short:\s*\d+|view:|ticker|name|position|entry date|entry price|recent price|price return|trend low end|trend high end|% from low end|% from high end|holding period)$/i
    .test(String(token || '').trim());
}

function tokenizeCurrentPositionsText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(/\n|\t/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !isHeaderToken(token));
}

function shouldDiscardRiskRange(price, entryPrice, recentPrice) {
  const reference = Math.max(Math.abs(entryPrice || 0), Math.abs(recentPrice || 0));
  return price != null && reference > 0 && Math.abs(price) > reference * 10;
}

function buildRow(ticker, tokens, index) {
  const sideIndex = tokens.findIndex((token) => /^(long|short)$/i.test(token));
  if (sideIndex < 1) return null;
  const side = tokens[sideIndex].toLowerCase() === 'short' ? 'Short' : 'Long';
  const dateIndex = tokens.findIndex((token, tokenIndex) => tokenIndex > sideIndex && normalizeDate(token));
  if (dateIndex < 0) return null;

  const moneyTokens = [];
  const percentTokens = [];
  let daysHeld = null;
  for (const token of tokens.slice(dateIndex + 1)) {
    if (/^\$?-?[\d,]+(?:\.\d+)?$/.test(token) || /^\$-?[\d,]+(?:\.\d+)?$/.test(token)) {
      moneyTokens.push(token);
      continue;
    }
    if (/^[+-]?\d+(?:\.\d+)?%$/.test(token)) {
      percentTokens.push(token);
      continue;
    }
    if (/\bda(?:y|ys)?\b/i.test(token) || /^\d+$/.test(token)) {
      daysHeld = parseDaysHeld(token);
    }
  }

  const entryPrice = parseMoney(moneyTokens[0]);
  const recentPrice = parseMoney(moneyTokens[1]);
  let trendLowEnd = parseMoney(moneyTokens[2]);
  let trendHighEnd = parseMoney(moneyTokens[3]);
  const warnings = [];

  if (shouldDiscardRiskRange(trendLowEnd, entryPrice, recentPrice)) {
    warnings.push(`Discarded malformed trend low for ${ticker}: ${moneyTokens[2]}`);
    trendLowEnd = null;
  }
  if (shouldDiscardRiskRange(trendHighEnd, entryPrice, recentPrice)) {
    warnings.push(`Discarded malformed trend high for ${ticker}: ${moneyTokens[3]}`);
    trendHighEnd = null;
  }

  return {
    id: `${ticker}_${index}`,
    etf: tokens.slice(0, sideIndex).join(' ').replace(/\s+/g, ' ').trim() || ticker,
    assetClass: 'ETF Pro',
    call: side,
    ticker,
    dateAdded: normalizeDate(tokens[dateIndex]),
    entryPrice,
    lastPrice: recentPrice,
    recentPrice,
    absolutePerformance: parsePercent(percentTokens[0]),
    relativePerformance: parsePercent(percentTokens[0]),
    trendLowEnd,
    trendHighEnd,
    percentFromLowEnd: parsePercent(percentTokens[1]),
    percentFromHighEnd: parsePercent(percentTokens[2]),
    daysHeld,
    parserWarnings: warnings,
  };
}

function parseEtfProCurrentPositionsText(text) {
  const tokens = tokenizeCurrentPositionsText(text);
  const rows = [];
  const warnings = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const ticker = isTickerToken(tokens[index]);
    if (!ticker) continue;

    const rowTokens = [];
    let cursor = index + 1;
    while (cursor < tokens.length && !isTickerToken(tokens[cursor])) {
      rowTokens.push(tokens[cursor]);
      cursor += 1;
    }

    const row = buildRow(ticker, rowTokens, rows.length);
    if (row) {
      warnings.push(...(row.parserWarnings || []));
      const { parserWarnings, ...cleanRow } = row;
      rows.push(cleanRow);
    } else {
      warnings.push(`Skipped malformed ETF Pro current-position row for ${ticker}`);
    }
    index = cursor - 1;
  }

  return {
    rows: rows.map((row, index) => ({ ...row, id: `${row.ticker}_${index}` })),
    warnings,
  };
}

function summarizeEtfProRows(rows = []) {
  const longs = [];
  const shorts = [];
  for (const row of rows || []) {
    const ticker = normalizeTicker(row.ticker);
    if (!ticker) continue;
    if (String(row.call || '').toLowerCase() === 'short') shorts.push(ticker);
    else longs.push(ticker);
  }
  return {
    longs,
    shorts,
    longCount: longs.length,
    shortCount: shorts.length,
  };
}

function buildEtfProCurrentPositionsPayload(text, options = {}) {
  const parsed = parseEtfProCurrentPositionsText(text);
  const summary = summarizeEtfProRows(parsed.rows);
  const snapshotDate = options.snapshotDate || new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
  const parsedAt = options.parsedAt || new Date().toISOString();
  return {
    meta: {
      snapshotDate,
      parsedAt,
      sourceFile: options.sourceFile || 'manual-current-open-positions',
      source: options.source || 'manual-current-open-positions',
      sourceKind: 'active-open-positions',
      rowCount: parsed.rows.length,
      longCount: summary.longCount,
      shortCount: summary.shortCount,
    },
    rows: parsed.rows,
    changes: null,
    dataQuality: {
      status: parsed.warnings.length > 0 ? 'warning' : 'ok',
      warnings: parsed.warnings,
      removedButMissing: [],
      duplicateAdds: [],
    },
  };
}

module.exports = {
  buildEtfProCurrentPositionsPayload,
  isTickerToken,
  normalizeTicker,
  parseEtfProCurrentPositionsText,
  summarizeEtfProRows,
};
