# IBKR Prediction-Market Activity History

The Contract P&L ledger requires a separate IBKR Activity Flex Query. The
existing interest-validation query must remain unchanged.

## One-time Portal setup

Create an XML Activity Flex Query named `Market Dashboard Prediction Activity`
and include every account that can trade prediction markets.

Enable these sections and the listed transaction-level fields:

- **Trades — Executions and Closed Lots:** account ID, conid, symbol,
  description, exchange, execution/trade IDs, date/time, side, quantity, price,
  proceeds, commissions, taxes, net cash, cost basis, realized P&L, open/close,
  expiry, strike, and put/call.
- **Options Exercises, Assignments and Expirations:** account ID, conid, symbol,
  quantity, proceeds, basis, fees, realized P&L, transaction type, and trade ID.
- **Cash Transactions:** account ID, transaction ID, date, type, description,
  symbol/conid when available, amount, and currency.
- **Statement of Funds:** account ID, transaction ID, date, activity code,
  description, symbol/conid when available, debit, credit, and balance.
- **Open Positions — lot detail:** account ID, conid, symbol, exchange,
  quantity, cost basis, expiry, strike, and put/call. This is a residual-position
  control only and is not counted as transaction P&L.

After saving the query, place its ID and the complete expected-account list in
the local environment (never commit either value):

```dotenv
IBKR_FLEX_ACTIVITY_ENABLED=true
IBKR_FLEX_ACTIVITY_QUERY_ID=<saved activity query id>
IBKR_FLEX_ACTIVITY_EXPECTED_ACCOUNTS=<account 1>,<account 2>
IBKR_FLEX_ACTIVITY_USE_QUERY_PERIOD=true
```

`IBKR_FLEX_TOKEN` is shared with the existing Flex Web Service configuration.
Set `IBKR_FLEX_ACTIVITY_USE_QUERY_PERIOD=true` for a saved rolling-period query
such as Last 365 Calendar Days. The importer then requests that configured
window once and verifies that it fully contains the requested backfill range.

## Initial 2026 rebuild

Run the preview through the previous completed day:

```bash
npm run prediction-pnl:backfill -- --from 2026-01-01 --through YYYY-MM-DD --dry-run
```

The preview is commit-eligible only when every expected account has contiguous
date coverage, every required section is satisfied, and account plus
consolidated control differences round to `$0.00`. Review the generated
June-CPI audit, then commit the exact preview hash:

```bash
npm run prediction-pnl:backfill -- --commit <preview-hash>
```

The commit enables the seven-day-overlap daily Activity sync. Until that gate
passes, all-account Contract P&L remains visibly incomplete and excludes the
uncovered accounts; it never treats missing history as zero.

## P&L publication boundary

The dashboard publishes only broker-verified settled lifecycles and verified
live `open` or `awaiting_resolution` lifecycles. Conflicting, ambiguous,
unsupported, or incomplete evidence remains quarantined in the durable ledger
for automatic reconciliation, but it produces no table row, total, or manual
review task. Manual P&L confirmation is disabled. If authoritative evidence is
not available, the corresponding dashboard result stays blank.

IBKR can omit the selected Closed Lots block while still returning the complete
execution tape. In that case the importer accepts the explicit
`execution_accounting` alternative only when every prediction execution has
broker IDs and complete cash/fee fields, every fully closed contract's net cash
equals IBKR realized P&L to the cent, and each Option EAE row matches a unique
execution. The preview reports direct section coverage separately from this
alternative so the exception remains visible.

Normalized reports are stored with immutable SHA-256 hashes. Raw Flex XML,
tokens, and query IDs are not retained or returned by status endpoints.
