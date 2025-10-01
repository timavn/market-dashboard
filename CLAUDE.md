# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A React-based financial market dashboard with portfolio analytics, real-time market data integration, and options trading interface. Features include Schwab CSV import, Global Quad Matrix visualization, risk metrics, and WebSocket-based real-time updates.

## Development Commands

```bash
npm start              # Start development server (localhost:3000)
npm run build          # Build production bundle
npm test               # Run test suite
npm run lint           # Run ESLint on src/ files
npm run lint:fix       # Auto-fix ESLint issues
npm run format         # Format code with Prettier
```

## Architecture Overview

### Component Structure
- **Entry Point**: `src/index.js` → `src/App.jsx` → `src/components/Dashboard/PortfolioDashboard.jsx`
- **Layout**: 12-column CSS Grid (2-col sidebar, 7-col center, 3-col right panel)
- **Component Directories**:
  - `components/Dashboard/` - Main dashboard components
  - `components/Portfolio/` - Portfolio-specific components
  - `components/Options/` - Options trading UI
  - `components/Charts/` - Chart visualizations
  - `components/UI/` - Reusable UI elements

### Service Layer Architecture
- **API Service**: `src/services/api/marketDataService.js` - Axios-based REST API client with 10s timeout
- **WebSocket Service**: `src/services/websocket/marketWebSocket.js` - Singleton WebSocket manager with auto-reconnect (max 5 attempts)
- **CSV Parser**: `src/utils/csvParser.js` - Schwab CSV processing utilities

### Custom Hooks
Located in `src/hooks/useMarketData.js`:
- `useMarketData(symbols)` - Fetches quotes + subscribes to WebSocket updates
- `useOptionsData(symbol)` - Fetches options chain data
- `useVIXData()` - Fetches VIX with 30s auto-refresh

### API Configuration
Defined in `src/constants/apiEndpoints.js`:
- **Base URL**: `REACT_APP_API_BASE_URL` (default: http://localhost:3001)
- **External Integrations**: Alpha Vantage, Finnhub, Polygon.io
- **WebSocket Endpoints**: `/ws/market`, `/ws/options`, `/ws/portfolio`

## CSV Processing

The `parseSchwabCSV()` function in `src/utils/csvParser.js`:
1. Searches for header line containing "Symbol" and "Description"
2. Parses comma-separated data with quoted fields
3. Converts dollar amounts (removes `$` and `,`) and percentages
4. Filters out account total rows and invalid positions
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
REACT_APP_ALPHA_VANTAGE_KEY=your_key
REACT_APP_FINNHUB_KEY=your_key
REACT_APP_POLYGON_KEY=your_key
REACT_APP_WS_URL=ws://localhost:3001
```

## Deployment

### AWS S3 + CloudFront
Automated via GitHub Actions (`.github/workflows/deploy.yml`):
- Triggers on push to `main` branch
- Builds production bundle with `npm run build`
- Syncs `build/` to S3 bucket
- Invalidates CloudFront cache

**Required GitHub Secrets**:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `S3_BUCKET_NAME`
- `CLOUDFRONT_DISTRIBUTION_ID` (optional)

### Manual Deployment
Use `upload-to-s3.ps1` (PowerShell script for manual S3 upload)

## Design System

**Color Scheme**:
- Background: `#F5F5DC` (Beige)
- Text: `#000080` (Navy)
- Accents: `#4682B4` (Steel Blue)
- Borders: `#D3D3D3` (Light Gray)

**Grid Layout**: Main dashboard uses 12-column grid with responsive gap spacing

## Data Flow

1. **Initial Load**: Components mount → custom hooks fetch initial data via `MarketDataService`
2. **WebSocket Connection**: `marketWebSocket.connect()` establishes persistent connection
3. **Real-time Updates**: Subscriptions via `marketWebSocket.subscribe(channel, callback)` receive live updates
4. **CSV Import**: User uploads Schwab CSV → `parseSchwabCSV()` → state update → UI refresh

## Key Implementation Notes

- **WebSocket Reconnect**: Exponential backoff (1s * attempt count), max 5 attempts
- **Portfolio Data**: Currently defaults to zeroed values until AWS integration provides live data
- **Tab Navigation**: 'M' and 'Q' tabs toggle between different dashboard views
- **Utilities**: Use `parseDollar()` and `parsePercent()` helpers for consistent number formatting