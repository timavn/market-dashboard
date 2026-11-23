# CLAUDE.md

Guidance for Claude Code in this repository. Two other files carry the detail and win over this one where they differ:

- `AGENTS.md`: working agreements and every user-specified product rule (data integrity, UI, Analyst, prediction markets).
- `README.md`: local architecture, setup, and data contracts.

## Project overview

A local Mac workspace for portfolio monitoring and market research. A Vite + React 18 dashboard talks to a local Express API (`server.js`), which reads live accounts from Interactive Brokers through a Python sidecar, reads Hedgeye research that a Gmail-ingesting Lambda stores in AWS, and hosts The Analyst (a local Hermes research chat with its own sidecar).

```text
Browser at localhost:3000 (Vite + React)
    └─ /api and /ws proxy → Express at 127.0.0.1:3001 (server.js)
          ├─ IBKR sidecar at 127.0.0.1:8765 → local IB Gateway
          ├─ Market and research providers (src/services/providers)
          ├─ AWS SDK v3 → S3 and DynamoDB (research ledgers, snapshots, Risk Ranges)
          └─ The Analyst → local Hermes + sidecar at 127.0.0.1:6951

Hedgeye email → Gmail ingestor Lambda (every 15 min) → S3 artifacts + DynamoDB → Express API → dashboard
```

Everything local listens on loopback only. AWS never calls the Mac.

## Commands

```bash
npm start                # Start the whole local stack through the supervisor (same as npm run dev)
npm run dev:status       # What is running and ready
npm run dev:doctor       # Diagnose the local stack
npm run dev:restart      # Restart known repository services
npm run dev:stop
npm run dev:ui           # Vite only (port 3000)
npm run dev:api          # Express only (port 3001)
npm run build            # Vite production build
npm run lint
npx jest <test file>     # One Jest suite (browser-side tests, jsdom)
npm run test:node        # Node test suite (server-side .cjs tests)
npm run test:analyst     # Analyst Python, Node and UI suites
```

`scripts/dev-stack/cli.js` supervises the stack and restarts it when `server.js` or other service files change, so save such files once rather than in several small edits.

## Code map

- **Frontend**: `index.html` → `src/index.jsx` → `src/App.jsx` → `src/components/Dashboard/PortfolioDashboard.jsx`. Dashboard cards live in `src/components/Dashboard/`; each loads its data through a resource hook in `src/hooks/` (for example `useDashboardPortfolio.js`, `useDashboardOverviewResources.js`, `useVolatilitySnapshot.js`). The browser polls the API; the dashboard has no WebSocket client for market data, although the server still exposes `/ws/market`.
- **API**: `server.js` plus route modules in `src/routes/` (`analyst.cjs`, `systemReadiness.cjs`, `marketDaily.cjs`, and others). Server-side services are the `.cjs` files in `src/services/` and `src/utils/`.
- **IBKR**: `scripts/ibkr_sidecar/` (Python, talks to IB Gateway) and `src/services/ibkr/`. Read-only; see `docs/IBKR_READ_ONLY_BOUNDARIES.md`.
- **The Analyst**: `src/routes/analyst.cjs`, `src/services/analyst/`, `scripts/analyst_sidecar/` (Python), `scripts/analyst/` (Hermes profile), `config/analyst/`. See `docs/THE_ANALYST.md`.
- **Prediction markets**: `src/services/prediction*.cjs` and `src/services/kalshiClient.js`. Read-only; nothing places orders.
- **Local operations**: `scripts/dev-stack/`, `scripts/ops/`, `ops/`.

## AWS

Region `us-west-1`, stack `market-dashboard-readiness-v2`, defined in `infra/template.yaml`:

- `market-dashboard-gmail-ingestor-v2` (`infra/lambdas/gmail_ingestor/`): reads Hedgeye email, stores artifacts in S3 and parsed research in DynamoDB.
- `market-dashboard-hedgeye-pdf-processor-v1`: PDF parsers, built from `aws/lambda/` by its `Makefile`. That folder is still deployed code, and several `scripts/` import its parsers.
- `market-dashboard-cftc-ingestor-v1` (`infra/lambdas/cftc_ingestor/`): daily at 15:31 Eastern, publishes official CFTC positioning as the `cftc-positioning` snapshot the dashboard reads.
- `market-dashboard-hermes-cloud-watchdog-v1` (`infra/lambdas/hermes_watchdog/`) and the cost guardian.
- `market-dashboard-hermes-worker-v2` and the Quant Analyst, Quant Developer and Security schedules are retired and kept disabled. The Analyst is the only active agent; do not restore the others.

Lambda and template changes ship only through the tested release path in `infra/README.md` (`prepare_tested_release.py`, then `infra/scripts/deploy.sh`). Never overlay function code directly.

The default local AWS profile is restricted and mostly read-only; the admin profile is used only with the user's explicit go-ahead.

## Environment

Copy `.env.example` to `.env`. It covers the backend URL, Kalshi keys, the IBKR sidecar and Gateway, and Analyst settings. AWS credentials come from the configured profiles, never from browser settings.

## Notes

- Use Node 22 (`.nvmrc`).
- Portfolio data comes from IBKR only. The Schwab CSV upload path (upload component, presigned-upload endpoint, `csv_processor` Lambda) has been removed from the code.
- Alpha Vantage, Finnhub and Polygon are not used.
- Light mode only; UI and formatting rules are in `AGENTS.md`.
