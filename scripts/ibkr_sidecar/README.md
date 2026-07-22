# IBKR Sidecar

Local-only bridge from the dashboard to IB Gateway or TWS using `ib_insync`.

## Setup

```bash
cd scripts/ibkr_sidecar
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765 --loop asyncio
```

`ib_insync` needs the stdlib asyncio loop (not uvloop). If you omit `--loop asyncio`, startup will fail when `util.patchAsyncio()` runs.

From repo root:

```bash
npm run ibkr-sidecar          # start sidecar (creates venv on first run)
npm run ibkr-sidecar:check    # verify Gateway socket port is open
npm run verify:ibkr           # curl sidecar + Express health
```

## IB Gateway / TWS

Enable socket API access in IB Gateway or TWS.

Default ports:

- TWS paper: `7497`
- TWS live: `7496`
- IB Gateway paper: `4002`
- IB Gateway live: `4001`

`npm run ibkr-sidecar` loads `IB_GATEWAY_*` from the repo root `.env` (same as Express). Override in the shell if needed.

The sidecar reads:

```bash
IB_GATEWAY_HOST=127.0.0.1
IB_GATEWAY_PORT=4002
IB_GATEWAY_CLIENT_ID=17
```

## Streaming (persistent connection)

When `IBKR_PERSISTENT_CONNECT=true` (default), the sidecar keeps a read-only Gateway socket open and maintains in-memory caches.

| Endpoint | Purpose |
|----------|---------|
| `POST /subscribe` | Start streaming market data for instruments (ref-counted) |
| `POST /unsubscribe` | Stop streaming when ref count reaches zero |
| `GET /stream/quotes` | SSE feed of quote + connection status events |
| `GET /cache/quotes?symbols=SPY,QQQ` | Latest streamed ticks |
| `GET /cache/portfolio?account=` | Cached positions from `reqAccountUpdates` |
| `GET /cache/account-summary?account=` | Cached margin / buying power tags |

Express consumes SSE via `IBKR_STREAM_ENABLED=true` and pushes throttled updates on `/ws/market` channel `quotes`.

Verify streaming: `bash scripts/verify_ibkr_stream.sh` (Gateway must be online).

See [docs/IBKR_READ_ONLY_BOUNDARIES.md](../../docs/IBKR_READ_ONLY_BOUNDARIES.md).

## Endpoints

- `GET /status`: connection, accounts, and `stream` metadata
- `GET /livez`: process liveness plus invoked and real Python interpreter,
  environment prefix, app, and dependency provenance (`RUNTIME_DRIFT` if the
  managed workspace runtime is not in use)
- `GET /events`: last sidecar snapshot for diagnostics/readiness only; active
  trading routes must use `POST /refresh`
- `POST /refresh`: quote the exact metadata generation supplied by Express from `PredictionMarketCatalogV2` for the server-owned current release
- `POST /discover`: query IB ContractDetails for the server-owned current release and return a candidate generation; it never promotes local state
- `GET /accounts`: managed account IDs
- `GET /portfolio/live-positions`: verify the current IB socket and return identity/quantity for every managed account without cache, prices, or fallback
- `GET /portfolio/live-account-summary?account=`: verify the current IB socket and fetch a native account summary including NLV without cache or fallback
- `POST /quotes`: snapshot fallback; uses stream cache when subscribed
- `POST /historical`: body `{ "instrument", "range", "interval" }` — historical bars
- `GET /portfolio/positions?account=`: open positions (cache-first when streaming)
- `GET /portfolio/account-summary?account=`: net liquidation, cash, margins (cache-first)
- `GET /portfolio/open-orders?account=`: read-only open orders (dev only; not exposed in dashboard UI)
- `GET /portfolio/pnl?account=`: freshly subscribed native account PnL after a
  current socket round trip; it never derives a percentage from cached NLV

From repo root, verify market/portfolio providers:

```bash
npm run verify:ibkr-providers
```

Gateway install steps: [GATEWAY_SETUP.md](./GATEWAY_SETUP.md)

Run `npm run ibkr-sidecar:discover` after Gateway is connected. The command goes
through Express, which supplies the current CPI release, validates fresh native
ContractDetails coverage, and atomically promotes the generation and current
release pointer in `PredictionMarketCatalogV2`. The sidecar's ignored JSON files
are legacy diagnostics only and are never read by `/refresh` or written by
`/discover`. A failed or partial discovery leaves the prior V2 generation
untouched. Live event serialization carries the native conId, exchange, trading
class, expiry, catalog source, and YES/NO side used by the shared execution gate.
