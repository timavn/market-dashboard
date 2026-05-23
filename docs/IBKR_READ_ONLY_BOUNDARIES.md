# IBKR Read-Only Boundaries

This dashboard is **read-only** and **non-execution**. IBKR Desktop remains the execution platform.

## Allowed via IB Gateway (this stack)

- Live and delayed market data (streaming + snapshot fallback)
- Historical bars (recent ranges; long-range charts may use Yahoo/FRED)
- Account values, positions, buying power, margin fields
- Portfolio analytics and reconciliation with uploaded statements
- Prediction market / event contract quotes when configured

## Not implemented (by design)

- Order placement, modification, or cancellation
- Open-order monitoring in the UI (sidecar dev endpoint gated off by default)
- Execution tracking, trading buttons, hotkeys
- Automated or algorithmic trading
- Any broker write action

## Architecture

- **Python sidecar** (`scripts/ibkr_sidecar/`): `ib_insync`, `readonly=True`, persistent connection when enabled
- **Express** (`server.js`): SSE bridge → in-memory quote cache → WebSocket to React
- **Yahoo**: fallback for unsupported symbols and long-horizon charts only

## Environment

- `IBKR_STREAM_ENABLED=true` — Node SSE bridge and WS quote channel
- `IBKR_EXPOSE_OPEN_ORDERS=false` — keep open orders off the composite portfolio API (default)
- `REACT_APP_IBKR_STREAM_ENABLED` — enable WebSocket pilot on the React client
