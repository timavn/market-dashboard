# IBKR Debit-Interest Validation

The dashboard issues an immutable debit-interest forecast after a verified
market close, reconciles it to the next IBKR Flex report, and recalibrates the
future point estimate and upper reserve after every prospective match.

## One-time Flex setup

Create an Activity Flex Query named `Market Dashboard – Interest Validation`
for the configured strategy account, using XML output and `yyyy-MM-dd` dates.
Include:

- Interest Details (Tiers): account, currency, interest type, value date,
  tier break, balance threshold, securities and commodities principal, rate,
  securities/commodities/total interest, and code.
- Interest Accruals: all currency-level fields.
- Cash Transactions: account, currency, date/time, amount, type, description,
  and code.
- Cash Report: account, currency, from/to date, broker interest,
  ending cash, ending settled cash, and report date.
- Securities Borrowed/Lent Fee Details (optional but required for daily
  per-security borrow fees): account, currency, symbol, value date, start
  date, quantity, collateral amount, fee rate, borrow fee, IB carry charge,
  IB ticket charge, total charges, and code.

Generate a Flex Web Service token, then set these private `.env` values:

```dotenv
IBKR_FLEX_TOKEN=...
IBKR_FLEX_INTEREST_QUERY_ID=...
```

The expected account and graduated validator are already configured locally.
Restart the dashboard stack after adding the token and query ID.

## Runtime behavior

- The API checks at 6:30 a.m. New York time and retrieves a rolling 45-day
  window so revisions and monthly postings are retained.
- Beginning at 4:30 p.m. New York time, the API requests a fresh,
  double-read IBKR observation. The sidecar uses broker time and IBKR
  `liquidHours` to prove the completed session and weekend/holiday accrual
  span.
- Predictions are immutable. Daily Flex actuals create revisions; they never
  rewrite the issued forecast.
- Every verified daily actual is classified against the locked lower/upper
  forecast band. A miss immediately returns the model to `Provisional`; a
  later verified in-band forecast can resume its sample-based status.
- An unchanged live MTD accrual is never interpreted as a zero daily actual.
  The comparison stays `Pending` until Flex returns authoritative evidence for
  the covered value date.
- Current-day audit reads refresh the broker balance directly. Repeated values
  refresh the live checkpoint without duplicating the immutable journal, and a
  failed or stale read removes the live MTD value instead of retaining it.
- Stock-borrow charges are kept separate from margin-debit interest. The
  aggregate posted value comes from Flex Cash Transactions such as `USD BORROW
  FEES FOR JUL-2026`; it is never estimated from short market value or the
  shortable-shares quote. The daily card remains unavailable until the
  per-security fee-detail section is included in the query.
- Broker-native margin health (`AvailableFunds`, `ExcessLiquidity`, and
  `BuyingPower`) is displayed separately from estimated interest-bearing
  principal. The settled-cash model is non-actionable and never emits a sell
  instruction or margin-call amount.
- The status endpoint reports whether all four required Flex sections are
  present. Missing sections keep the audit visibly incomplete instead of
  treating absent rows as zeroes.
- Thirty prospective matched forecasts plus a monthly posting changes the
  sample-based status to `Validated`, provided the latest verified forecast is
  not a miss.

Private records are stored under:

`~/Library/Application Support/market-dashboard/ibkr-interest-validation-v1/`

Use `POST /api/ibkr/interest-validation/run` for an explicit collection pass,
and inspect `GET /api/ibkr/interest-validation/status` or `/history`.
