function stripHtmlToText(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|li|h1|h2|h3|h4|h5|h6)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9./-]{0,9}$/.test(ticker) ? ticker : null;
}

function normalizeDate(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const [, month, day, year] = match;
  return `${year.length === 2 ? `20${year}` : year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseMoney(value) {
  const cleaned = String(value || '').replace(/[$,\s]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function getItemTimestamp(item = {}) {
  return item.receivedAt || item.createdAt || item.updatedAt || null;
}

function getItemDate(item = {}) {
  if (item.snapshotDate) return item.snapshotDate;
  const raw = getItemTimestamp(item);
  const d = raw ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function uniqueTickers(values) {
  return [...new Set(values.map(normalizeTicker).filter(Boolean))];
}

function parseTickerList(value = '') {
  return uniqueTickers(
    String(value)
      .replace(/\([^)]*\)/g, ' ')
      .split(/[\s,;]+/)
  );
}

function rowsFromTickers(tickers, call, snapshotDate, sourceAction = null, namesByTicker = new Map()) {
  return uniqueTickers(tickers).map((ticker, index) => ({
    id: `${ticker}_${index}`,
    etf: namesByTicker.get(ticker) || ticker,
    assetClass: 'ETF Pro',
    call,
    ticker,
    dateAdded: sourceAction === 'ADD' ? snapshotDate : null,
    lastPrice: null,
    absolutePerformance: null,
    sp500: null,
    relativePerformance: null,
    daysHeld: null,
    asOf: null,
    lastPublished: null,
    action: sourceAction,
  }));
}

function getEmailLines(htmlBody = '') {
  return stripHtmlToText(htmlBody)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isWeeklyTableHeader(line) {
  return /^(ticker|date added|recent price\*?|trend ranges|asset class)$/i.test(String(line || '').trim());
}

function parseWeeklyEtfProSection(lines, startIndex, endIndex, call) {
  const rows = [];
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const name = lines[index];
    if (!name || isWeeklyTableHeader(name)) continue;

    const ticker = normalizeTicker(lines[index + 1]);
    const dateAdded = normalizeDate(lines[index + 2]);
    if (!ticker || !dateAdded) continue;

    rows.push({
      id: `${ticker}_${rows.length}`,
      etf: name,
      assetClass: lines[index + 6] || 'ETF Pro',
      call,
      ticker,
      dateAdded,
      lastPrice: parseMoney(lines[index + 3]),
      recentPrice: parseMoney(lines[index + 3]),
      trendLowEnd: parseMoney(lines[index + 4]),
      trendHighEnd: parseMoney(lines[index + 5]),
      sourceAction: null,
    });
    index += 6;
  }
  return rows;
}

function parseEtfProWeeklyTableEmail(item = {}, htmlBody = '') {
  const lines = getEmailLines(htmlBody);
  const bullishIndex = lines.findIndex((line) => /^BULLISH$/i.test(line));
  const bearishIndex = lines.findIndex((line) => /^BEARISH$/i.test(line));
  if (bullishIndex < 0 || bearishIndex < 0 || bearishIndex <= bullishIndex) return null;

  const endIndex = lines.findIndex((line, index) => index > bearishIndex && /^\*All ETF recent intra day prices/i.test(line));
  const snapshotDate = getItemDate(item);
  const longRows = parseWeeklyEtfProSection(lines, bullishIndex, bearishIndex, 'Long');
  const shortRows = parseWeeklyEtfProSection(
    lines,
    bearishIndex,
    endIndex > bearishIndex ? endIndex : lines.length,
    'Short',
  );
  if (longRows.length === 0 && shortRows.length === 0) return null;

  const rows = [...longRows, ...shortRows].map((row, index) => ({ ...row, id: `${row.ticker}_${index}` }));
  return {
    meta: {
      snapshotDate,
      parsedAt: getItemTimestamp(item),
      sourceFile: item.s3Key || null,
      source: 'gmail-html-full-book',
      headline: item.subject || null,
      rowCount: rows.length,
      longCount: longRows.length,
      shortCount: shortRows.length,
    },
    rows,
    changes: null,
    data: {
      headline: item.subject || null,
      fullBookLongs: longRows.map((row) => row.ticker),
      fullBookShorts: shortRows.map((row) => row.ticker),
    },
    dataQuality: {
      status: 'ok',
      warnings: [],
      removedButMissing: [],
      duplicateAdds: [],
    },
  };
}

function parseNamedTickers(value = '') {
  const namesByTicker = new Map();
  const tickers = [];
  const regex = /([A-Z][A-Za-z0-9&'’/ .+-]{1,90}?)\s*\(([A-Z][A-Z0-9./-]{1,9})\)/g;
  let match;
  while ((match = regex.exec(String(value))) !== null) {
    const ticker = normalizeTicker(match[2]);
    if (!ticker) continue;
    tickers.push(ticker);
    namesByTicker.set(ticker, match[1].replace(/\s+/g, ' ').trim());
  }
  return { tickers: uniqueTickers(tickers), namesByTicker };
}

function parseEtfProFullBookEmail(item = {}, htmlBody = '') {
  const text = stripHtmlToText(htmlBody);
  const compact = text.replace(/\s+/g, ' ');
  const fullBookMatch = compact.match(
    /current lineup of ETFs is as follows:\s*Long:\s*([\s\S]+?)\s+Short:\s*([\s\S]+?)(?:\s+\(\s*VIEW LARGER IMAGE\s*\)|\s+The monthly Quad|\s+Since the|\s+How to Use|\s+Dear ETF|$)/i
  );

  if (!fullBookMatch) return parseEtfProWeeklyTableEmail(item, htmlBody);

  const snapshotDate = getItemDate(item);
  const longTickers = parseTickerList(fullBookMatch[1]);
  const shortTickers = parseTickerList(fullBookMatch[2]);
  if (longTickers.length === 0 && shortTickers.length === 0) return null;

  const rows = [
    ...rowsFromTickers(longTickers, 'Long', snapshotDate),
    ...rowsFromTickers(shortTickers, 'Short', snapshotDate),
  ].map((row, index) => ({ ...row, id: `${row.ticker}_${index}` }));

  return {
    meta: {
      snapshotDate,
      parsedAt: getItemTimestamp(item),
      sourceFile: item.s3Key || null,
      source: 'gmail-html-full-book',
      headline: item.subject || null,
      rowCount: rows.length,
    },
    rows,
    changes: null,
    data: {
      headline: item.subject || null,
      fullBookLongs: longTickers,
      fullBookShorts: shortTickers,
    },
  };
}

function parseEtfProActionEmail(item = {}, htmlBody = '') {
  const text = stripHtmlToText(htmlBody).replace(/\s+/g, ' ');
  const sectionRegex = /(?:We are\s+)?(ADDING|REMOVING)\s+(Long|Short)\s*:\s*([\s\S]*?)(?=\s+(?:We are\s+)?(?:ADDING|REMOVING)\s+(?:Long|Short)\s*:|\s+How to Use|\s+Dear ETF|\s*$)/gi;
  const snapshotDate = getItemDate(item);
  const changes = {
    previousDate: null,
    addedLongs: [],
    removedLongs: [],
    addedShorts: [],
    removedShorts: [],
  };
  const actionRows = [];

  let match;
  while ((match = sectionRegex.exec(text)) !== null) {
    const verb = match[1].toUpperCase();
    const side = match[2].toLowerCase();
    const parsed = parseNamedTickers(match[3]);
    const tickers = parsed.tickers.length > 0 ? parsed.tickers : parseTickerList(match[3]);
    const targetKey = `${verb === 'ADDING' ? 'added' : 'removed'}${side === 'short' ? 'Shorts' : 'Longs'}`;
    changes[targetKey].push(...tickers);

    if (verb === 'ADDING') {
      actionRows.push(...rowsFromTickers(
        tickers,
        side === 'short' ? 'Short' : 'Long',
        snapshotDate,
        'ADD',
        parsed.namesByTicker
      ));
    } else {
      actionRows.push(...rowsFromTickers(
        tickers,
        side === 'short' ? 'Short' : 'Long',
        snapshotDate,
        'REMOVE',
        parsed.namesByTicker
      ));
    }
  }

  changes.addedLongs = uniqueTickers(changes.addedLongs);
  changes.removedLongs = uniqueTickers(changes.removedLongs);
  changes.addedShorts = uniqueTickers(changes.addedShorts);
  changes.removedShorts = uniqueTickers(changes.removedShorts);
  changes.added = [...new Set([...changes.addedLongs, ...changes.addedShorts])];
  changes.removed = [...new Set([...changes.removedLongs, ...changes.removedShorts])];

  const changeCount = changes.added.length + changes.removed.length;
  if (changeCount === 0) return null;

  return {
    meta: {
      snapshotDate,
      parsedAt: getItemTimestamp(item),
      sourceFile: item.s3Key || null,
      source: 'gmail-html-action',
      headline: item.subject || null,
      rowCount: actionRows.length,
      actionCount: actionRows.length,
    },
    rows: actionRows.map((row, index) => ({ ...row, id: `${row.ticker}_${index}` })),
    changes,
    data: {
      headline: item.subject || null,
      ...changes,
    },
  };
}

module.exports = {
  parseEtfProActionEmail,
  parseEtfProFullBookEmail,
  parseEtfProWeeklyTableEmail,
  stripHtmlToText,
};
