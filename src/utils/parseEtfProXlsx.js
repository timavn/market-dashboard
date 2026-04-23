import readXlsxFile from 'read-excel-file/browser';
import cjsEtf from './etfProSnapshotDate.cjs';

const { determineEtfProSnapshotDate } = cjsEtf;

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

export async function parseEtfProWorkbook(file) {
  const rows = await readXlsxFile(file, { sheet: 1 });

  if (!rows || rows.length === 0) {
    throw new Error('This spreadsheet is empty.');
  }

  const headerRow = rows[0] ?? [];
  const expected = EXPECTED_HEADERS.map(normalizeHeader);
  const actual = headerRow.map(normalizeHeader);

  const matches =
    expected.length === actual.length &&
    expected.every((h, idx) => h === actual[idx]);

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

      const obj = {
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

      return obj;
    })
    .filter((r) => r.ticker);

  const uploadedAt = new Date().toISOString();
  const fileMtime = file && typeof file.lastModified === 'number'
    ? new Date(file.lastModified).toISOString()
    : null;
  const snapshotDate = determineEtfProSnapshotDate(data, fileMtime);

  return {
    rows: data,
    meta: {
      snapshotDate,
      uploadedAt,
      filename: file?.name ?? null,
      rowCount: data.length,
    },
  };
}

export const ETF_PRO_EXPECTED_HEADERS = EXPECTED_HEADERS.slice();

