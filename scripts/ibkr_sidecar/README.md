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
```

## IB Gateway / TWS

Enable socket API access in IB Gateway or TWS.

Default ports:

- TWS paper: `7497`
- TWS live: `7496`
- IB Gateway paper: `4002`
- IB Gateway live: `4001`

The sidecar reads:

```bash
IB_GATEWAY_HOST=127.0.0.1
IB_GATEWAY_PORT=4002
IB_GATEWAY_CLIENT_ID=17
```

## Endpoints

- `GET /status`: connection and account status
- `GET /events`: last sidecar snapshot
- `POST /refresh`: fetch seeded contracts from `event_contracts.json`

Add known event contract conids to `event_contracts.json` once you have them.
