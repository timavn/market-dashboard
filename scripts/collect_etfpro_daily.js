/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const readXlsxFile = require('read-excel-file/node');

const DEFAULT_SOURCE_DIR = '/Users/timsmith/Desktop/dashboard/hedgeye/etfpro';
const FILENAME_PREFIX = 'etf-pro-all-active-tickers-';
const FILENAME_SUFFIX = '.xlsx';

const EXPECTED_HEADERS = [
  'ETF',
  'Asset Class',
  'Call',
  'Ticker',
  'Date Added',
  'Last Price',
  'Absolute Performance',
  'S&P 500',
  'Relative Performance',
  'Days Held',
  'As of',
  'Last Published',
];

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseMaybeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function parseMaybeDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIsoDateOnly(date) {
  if (!date) return null;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function listCandidateFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter(
      (name) =>
        name.startsWith(FILENAME_PREFIX) &&
        name.endsWith(FILENAME_SUFFIX) &&
        name.length > FILENAME_PREFIX.length + FILENAME_SUFFIX.length
    )
    .map((name) => path.join(dirPath, name));
}

function getLatestByMtime(filePaths) {
  let best = null;
  let bestMtime = -1;
  for (const p of filePaths) {
    try {
      const stat = fs.statSync(p);
      const m = stat.mtimeMs ?? 0;
      if (m > bestMtime) {
        best = { path: p, stat };
        bestMtime = m;
      }
    } catch {
      // ignore
    }
  }
  return best;
}

async function parseWorkbookFromPath(xlsxPath) {
  const result = await readXlsxFile(xlsxPath, { sheet: 1 });
  const rows = Array.isArray(result) && result[0] && Array.isArray(result[0].data) ? result[0].data : result;
  if (!rows || !Array.isArray(rows) || rows.length === 0) throw new Error('Spreadsheet is empty.');

  const headerRow = rows[0] ?? [];
  if (!Array.isArray(headerRow)) {
    throw new Error('Unexpected spreadsheet format (header row is not an array).');
  }
  const expected = EXPECTED_HEADERS.map(normalizeHeader);
  const actual = headerRow.map(normalizeHeader);
  const matches =
    expected.length === actual.length && expected.every((h, idx) => h === actual[idx]);

  if (!matches) {
    throw new Error(
      `Unexpected header row. Expected: ${EXPECTED_HEADERS.join(
        ', '
      )}. Got: ${headerRow.map((h) => String(h ?? '')).join(', ')}`
    );
  }

  const data = rows
    .slice(1)
    .filter((r) => Array.isArray(r) && r.some((cell) => String(cell ?? '').trim() !== ''))
    .map((r, idx) => {
      const [
        etf,
        assetClass,
        call,
        ticker,
        dateAdded,
        lastPrice,
        absolutePerformance,
        sp500,
        relativePerformance,
        daysHeld,
        asOf,
        lastPublished,
      ] = r;

      const dateAddedD = parseMaybeDate(dateAdded);
      const asOfD = parseMaybeDate(asOf);
      const lastPublishedD = parseMaybeDate(lastPublished);

      return {
        id: `${String(ticker ?? '').trim()}_${idx}`,
        etf: String(etf ?? '').trim(),
        assetClass: String(assetClass ?? '').trim(),
        call: String(call ?? '').trim(),
        ticker: String(ticker ?? '').trim(),
        dateAdded: toIsoDateOnly(dateAddedD),
        lastPrice: parseMaybeNumber(lastPrice),
        absolutePerformance: parseMaybeNumber(absolutePerformance),
        sp500: parseMaybeNumber(sp500),
        relativePerformance: parseMaybeNumber(relativePerformance),
        daysHeld: parseMaybeNumber(daysHeld),
        asOf: asOfD ? asOfD.toISOString() : null,
        lastPublished: lastPublishedD ? lastPublishedD.toISOString() : null,
      };
    })
    .filter((r) => r.ticker);

  return data;
}

function determineSnapshotDate(rows, fallbackDateIso) {
  const asOfValues = rows.map((r) => r.asOf).filter(Boolean);
  if (asOfValues.length > 0) {
    const latest = asOfValues
      .map((v) => new Date(v))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (latest) return toIsoDateOnly(latest);
  }
  if (fallbackDateIso) return toIsoDateOnly(new Date(fallbackDateIso));
  return toIsoDateOnly(new Date());
}

async function main() {
  const sourceDir = process.env.ETFPRO_SOURCE_DIR || DEFAULT_SOURCE_DIR;
  const outDir = path.join(__dirname, '..', 'data', 'hedgeye', 'etfpro');
  ensureDir(outDir);

  const candidates = listCandidateFiles(sourceDir);
  if (candidates.length === 0) {
    throw new Error(
      `No ETF Pro xlsx files found in ${sourceDir}. Expected pattern: ${FILENAME_PREFIX}*.xlsx`
    );
  }

  const latest = getLatestByMtime(candidates);
  if (!latest) throw new Error('Unable to stat any candidate ETF Pro files.');

  console.log(`[ETFPRO] Using source: ${latest.path}`);
  const rows = await parseWorkbookFromPath(latest.path);

  const parsedAt = new Date().toISOString();
  const fileMtime = latest.stat.mtime.toISOString();
  const snapshotDate = determineSnapshotDate(rows, fileMtime);

  const payload = {
    meta: {
      snapshotDate,
      parsedAt,
      sourceFile: latest.path,
      sourceFileMtime: fileMtime,
      rowCount: rows.length,
    },
    rows,
  };

  const latestPath = path.join(outDir, 'latest.json');
  const datedPath = path.join(outDir, `${snapshotDate}.json`);

  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(datedPath, JSON.stringify(payload, null, 2));

  console.log(`[ETFPRO] Wrote ${latestPath}`);
  console.log(`[ETFPRO] Wrote ${datedPath}`);
}

main().catch((err) => {
  console.error(`[ETFPRO] ERROR: ${err.message}`);
  process.exit(1);
});

