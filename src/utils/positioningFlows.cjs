// Context layers for the money flow card. They do not vote on the verdict:
// margin debt is money borrowed into stocks, free credit and retail money
// market funds are cash waiting outside them. All values are in billions.

const MARGIN_HEADERS = Object.freeze({
  month: 'Year-Month',
  debit: "Debit Balances in Customers' Securities Margin Accounts",
  cashCredit: "Free Credit Balances in Customers' Cash Accounts",
  marginCredit: "Free Credit Balances in Customers' Securities Margin Accounts",
});
// FINRA posts month M around the middle of month M+1.
const MARGIN_MAX_AGE_DAYS = 80;
// The weekly FRED retail money fund series runs several weeks behind.
const MMF_MAX_AGE_DAYS = 70;
const DIRECTION_TOLERANCE = 0.005;
const DAY_MS = 24 * 60 * 60 * 1000;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseFinraMarginRows(rows) {
  const header = (rows?.[0] || []).map((cell) => String(cell || '').trim());
  const index = Object.fromEntries(Object.entries(MARGIN_HEADERS).map(([key, label]) => [key, header.indexOf(label)]));
  if (Object.values(index).some((position) => position < 0)) {
    throw new Error('FINRA margin statistics columns changed');
  }
  return rows.slice(1).map((row) => {
    const month = String(row[index.month] || '').trim();
    const debit = Number(row[index.debit]);
    const cashCredit = Number(row[index.cashCredit]);
    const marginCredit = Number(row[index.marginCredit]);
    if (!/^\d{4}-\d{2}$/.test(month) || !finite(debit) || !finite(cashCredit) || !finite(marginCredit)) return null;
    // FINRA reports millions of dollars.
    const freeCredit = (cashCredit + marginCredit) / 1000;
    return { month, marginDebt: debit / 1000, freeCredit, netLeverage: debit / 1000 - freeCredit };
  }).filter(Boolean).sort((a, b) => a.month.localeCompare(b.month));
}

function pctChange(current, prior) {
  return finite(current) && finite(prior) && prior > 0 ? current / prior - 1 : null;
}

function direction(pct, up, down) {
  if (!finite(pct)) return 'unavailable';
  if (pct > DIRECTION_TOLERANCE) return up;
  if (pct < -DIRECTION_TOLERANCE) return down;
  return 'flat';
}

function ageDays(date, now) {
  return (new Date(now).getTime() - Date.parse(`${date}T00:00:00Z`)) / DAY_MS;
}

function summarizeMargin(rows, now = new Date()) {
  if (!rows?.length) return { status: 'unavailable', latest: null, history: [] };
  const latest = rows[rows.length - 1];
  const back = (months) => rows[rows.length - 1 - months];
  const changes = Object.fromEntries([['1m', 1], ['3m', 3], ['12m', 12]].map(([key, months]) => [key, {
    marginDebt: pctChange(latest.marginDebt, back(months)?.marginDebt),
    freeCredit: pctChange(latest.freeCredit, back(months)?.freeCredit),
  }]));
  // A month is dated at its last day, when the balances were measured.
  const [year, month] = latest.month.split('-').map(Number);
  const asOf = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return {
    status: ageDays(asOf, now) > MARGIN_MAX_AGE_DAYS ? 'stale' : 'ok',
    latest: {
      ...latest,
      asOf,
      changes,
      leverage: direction(changes['3m'].marginDebt, 'rising', 'falling'),
    },
    history: rows.slice(-60),
  };
}

function summarizeMoneyFunds(series, now = new Date()) {
  const rows = (series || []).filter((point) => finite(point.value)).sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return { status: 'unavailable', latest: null };
  const latest = rows[rows.length - 1];
  const change4w = pctChange(latest.value, rows[rows.length - 5]?.value);
  const change13w = pctChange(latest.value, rows[rows.length - 14]?.value);
  return {
    status: ageDays(latest.date, now) > MMF_MAX_AGE_DAYS ? 'stale' : 'ok',
    latest: {
      date: latest.date,
      retailMoneyFunds: latest.value,
      change4w,
      change13w,
      cash: direction(change13w, 'building', 'drawing down'),
    },
  };
}

module.exports = {
  MARGIN_HEADERS,
  parseFinraMarginRows,
  summarizeMargin,
  summarizeMoneyFunds,
};
