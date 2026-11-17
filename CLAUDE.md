# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A React-based financial market dashboard with AWS serverless backend for automated portfolio tracking. Users upload Schwab CSV exports to S3, which triggers Lambda processing to store portfolio data in DynamoDB. The React dashboard displays real-time portfolio analytics, market data, and options trading interface with Global Quad Matrix visualization.

## Development Commands

```bash
npm start              # Start React dev server only (localhost:3000)
npm run server         # Start Express backend server only (localhost:3001)
npm run dev            # Start both frontend and backend concurrently
npm run build          # Build production bundle
npm test               # Run test suite
npm run lint           # Run ESLint on src/ files
npm run lint:fix       # Auto-fix ESLint issues
npm run format         # Format code with Prettier
```

## Architecture Overview

### Full Stack Architecture
```
Schwab CSV → S3 Upload → Lambda Process → DynamoDB → Express API → React Dashboard
                                                    ↘ WebSocket (real-time)
```

### Frontend Component Structure
- **Entry Point**: `src/index.js` → `src/App.jsx` → `src/components/Dashboard/PortfolioDashboard.jsx`
- **Layout**: 12-column CSS Grid (2-col sidebar, 7-col center, 3-col right panel)
- **Component Directories**:
  - `components/Dashboard/` - Main dashboard components
  - `components/CSVUpload.jsx` - S3 presigned URL upload component
  - `components/Portfolio/` - Portfolio-specific components
  - `components/Options/` - Options trading UI
  - `components/Charts/` - Chart visualizations

### Backend Architecture (server.js)
- **Express Server**: Port 3001, serves REST API and WebSocket endpoints
- **AWS Integration**: S3 presigned URL generation, DynamoDB portfolio data queries
- **WebSocket Server**: `/ws/market` endpoint with channel-based subscriptions
- **Portfolio Endpoint**: `/api/portfolio` queries latest DynamoDB snapshot and holdings

### Service Layer
- **API Service**: `src/services/api/marketDataService.js` - Axios client with 10s timeout, handles both AWS API Gateway and local server formats
- **CSV Parser**: `src/utils/csvParser.js` - Schwab CSV processing utilities
- **Portfolio Analytics**: `src/services/portfolioAnalytics.js` - Calculates risk metrics, exposure, concentration, factor analysis

### Custom Hooks
Located in `src/hooks/`. Each dashboard card loads its data through a resource hook, for example:
- `useDashboardPortfolio.js` - Portfolio and provider status
- `useDashboardOverviewResources.js` - Market overview tables
- `useVolatilitySnapshot.js` - Volatility card

The browser polls the API; the dashboard has no WebSocket client for market data.

### API Configuration
Defined in `src/constants/apiEndpoints.js`:
- **Backend URL**: `process.env.REACT_APP_BACKEND_URL` or `http://localhost:3001`
- **External Integrations**: Alpha Vantage, Finnhub, Polygon.io (configured via env vars)
- **WebSocket**: `/ws/market` path

## AWS Infrastructure

Located in `aws/` directory:
- **Lambda**: `csv_processor.lambda_handler` - Processes Schwab CSV files, implements daily portfolio replacement logic
- **DynamoDB Tables**:
  - `PortfolioSnapshots` - Portfolio summaries with asset allocation
  - `Holdings` - Individual holdings per snapshot (composite key: `snapshotId#symbol`)
  - `ProcessingLogs` - CSV processing logs
- **S3 Bucket**: `market-dashboard-csv-data` with automatic Lambda trigger on `uploads/*.csv`
- **IAM**: `CSVProcessorPolicy` grants Lambda permissions for S3 read, DynamoDB write, CloudWatch logging

See `aws/README.md` for complete infrastructure setup and deployment details.

## CSV Processing

The `parseSchwabCSV()` function in `src/utils/csvParser.js`:
1. Searches for header line containing "Symbol" and "Description"
2. Parses comma-separated data with quoted fields (handles commas in quotes)
3. Converts dollar amounts (removes `$` and `,`) and percentages using `parseDollar()` / `parsePercent()`
4. Filters out "Account Total" rows and invalid positions
5. Helper functions: `calculatePortfolioSummary()`, `calculateAssetAllocation()`, `getTopHoldings()`

**Asset Type Mapping**:
- "ETFs & Closed End Funds" / "Equity" → Equities
- "Cash and Money Market" → Cash
- "Fixed Income" → Fixed Income
- "Options" → Derivatives

## Environment Configuration

Copy `.env.example` to `.env` and configure:
```bash
REACT_APP_API_BASE_URL=http://localhost:3001
REACT_APP_BACKEND_URL=http://localhost:3001    # Express backend URL
REACT_APP_ALPHA_VANTAGE_KEY=your_key
REACT_APP_FINNHUB_KEY=your_key
REACT_APP_POLYGON_KEY=your_key
REACT_APP_WS_URL=ws://localhost:3001

# Backend AWS credentials (for server.js)
AWS_REGION=us-west-1
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
```

Backend falls back to `~/.aws/credentials` if env vars not set.

## Deployment

### AWS S3 
Automated via GitHub Actions (`.github/workflows/deploy.yml`):
- Triggers on push to `main` branch
- Builds production bundle with `npm run build`
- Syncs `build/` to S3 bucket

**Required GitHub Secrets**:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `S3_BUCKET_NAME`


## Design System

**Color Scheme**:
- Background: `#F5F5DC` (Beige)
- Text: `#000080` (Navy)
- Accents: `#4682B4` (Steel Blue)
- Borders: `#D3D3D3` (Light Gray)
- Panel Headers: `#E6E6E6`

**Grid Layout**: Main dashboard uses 12-column grid (Tailwind-style classes)

## Data Flow

### Development Mode (Local)
1. **Initial Load**: Components mount → resource hooks in `src/hooks/` → `MarketDataService` → Express server
2. **CSV Upload**: User uploads via `CSVUpload` component → requests presigned URL from `/api/presigned-url` → uploads to S3 → Lambda processes → DynamoDB updated → `portfolioRefresh` event triggers UI refresh
3. **Updates**: each resource hook polls its endpoint on its own interval; the server's `/ws/market` endpoint has no dashboard client

### Production Mode (AWS)
1. User uploads Schwab CSV to S3 bucket
2. S3 trigger invokes Lambda function
3. Lambda parses CSV, stores in DynamoDB (daily replacement: clears old holdings first)
4. Frontend fetches from API Gateway (or Express server)
5. Dashboard displays portfolio analytics

## Key Implementation Notes

- **Portfolio Data Formats**: `MarketDataService.getPortfolio()` handles both AWS API Gateway format (`{snapshot, holdings}`) and local server format (direct object)
- **Tab Navigation**: 'M' and 'Q' tabs in left sidebar toggle dashboard views
- **Daily Portfolio Replacement**: Lambda clears old holdings before storing new ones to prevent duplicates
- **WebSocket Broadcasting**: Disabled by default (set `ENABLE_WS_BROADCAST=true` to enable periodic updates)
- **Portfolio Refresh Event**: `window.addEventListener('portfolioRefresh')` in `PortfolioDashboard` listens for upload completion