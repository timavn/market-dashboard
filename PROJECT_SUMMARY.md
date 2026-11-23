# Market Dashboard: Project Summary

Updated November 22, 2026. This replaces the October 2025 summary, which described the retired Schwab CSV and Create React App setup.

## What it is

A local Mac workspace for portfolio monitoring and market research. It shows live Interactive Brokers accounts beside Hedgeye research, market data and prediction markets, and includes The Analyst, a local research chat that reviews the portfolio against that research.

## Architecture

```text
Browser at localhost:3000 (Vite + React 18)
    └─ Express API at 127.0.0.1:3001 (server.js)
          ├─ IBKR sidecar (Python, 127.0.0.1:8765) → local IB Gateway
          ├─ Market and research providers
          ├─ AWS: S3 artifacts and DynamoDB research tables
          └─ The Analyst: local Hermes + Python sidecar (127.0.0.1:6951)

Hedgeye email → Gmail ingestor Lambda (every 15 minutes) → S3 + DynamoDB → API → dashboard
```

Everything local listens on loopback only. `npm start` runs the whole stack through the supervisor in `scripts/dev-stack/`.

## Main parts

| Part | What it does | Where |
| --- | --- | --- |
| Dashboard | Market overview, volatility, currencies, research and portfolio cards | `src/components/Dashboard`, `src/hooks` |
| Portfolio | Verified balances, positions and orders from IBKR, read-only | `scripts/ibkr_sidecar`, `src/services/ibkr` |
| Research | Hedgeye products parsed into ledgers, snapshots and Risk Ranges | `infra/lambdas/gmail_ingestor`, `aws/lambda` (PDF parsers) |
| CFTC positioning | Official CFTC data, read daily at 15:31 Eastern | `infra/lambdas/cftc_ingestor` |
| The Analyst | Research chat, Portfolio Review, Predictive Markets Review, Inbox | `src/routes/analyst.cjs`, `scripts/analyst_sidecar`, `config/analyst` |
| Prediction markets | Kalshi setup board, sizing and line monitor, read-only | `src/services/prediction*.cjs` |
| Systems | Readiness checks, local supervisor, cloud watchdog | `src/routes/systemReadiness.cjs`, `scripts/dev-stack`, `infra/lambdas/hermes_watchdog` |

## AWS

Region `us-west-1`, one stack (`market-dashboard-readiness-v2`) defined in `infra/template.yaml`. Lambda changes ship only through the tested release path in `infra/README.md`.

## Retired

- Schwab CSV upload (upload page, presigned-upload endpoint, `csv_processor` Lambda): replaced by IBKR.
- Create React App: replaced by Vite.
- Quant Analyst, Quant Developer and Security agents: schedules disabled; The Analyst is the only active agent.
- Alpha Vantage, Finnhub and Polygon: not used.

## Where to read more

- `README.md`: setup, local architecture and data contracts
- `AGENTS.md`: working agreements and product rules
- `docs/THE_ANALYST.md`: The Analyst
- `infra/README.md`: cloud runtime and release path
