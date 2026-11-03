# Security Universe Documentation

> **Per-ticker facts now have one record:** names, research decisions, product calls, risk, sizing and activity come from `GET /api/security-universe` (see `docs/SECURITY_RECORD.md`). This page describes the static 118-security list and its ticker mappings; the record resolves a dashboard symbol's Yahoo instrument through `resolveHistoryInstrument` in `server.js`.

## Overview

The security universe consists of **118 securities** across 5 asset classes, providing comprehensive coverage of global financial markets.

## Asset Class Breakdown

- **Fixed Income**: 16 securities (Treasury yields, corporate bonds, mortgage-backed securities)
- **Equity**: 62 securities (Indices, sectors, individual stocks, country ETFs)
- **Currency/FX**: 10 securities (Currency pairs, currency ETFs, dollar index)
- **Commodity**: 16 securities (Precious metals, energy, base metals, agriculture)
- **Cryptocurrency**: 15 securities (Bitcoin, Ethereum, altcoins, crypto-related stocks)

## Security Universe Definition

The main security universe is defined in `src/constants/securitiesList.js`. Each security has:
- `ticker`: Unique ticker symbol
- `name`: Full name/description
- `assetClass`: One of: `fixedIncome`, `equity`, `currency`, `commodity`, `crypto`
- `bias`: Trading bias: `BULLISH`, `BEARISH`, or `NEUTRAL`

## Ticker Mapping System

### Single Source of Truth

All ticker mappings are defined in `src/constants/securitiesConfig.js`. The `server.js` file uses a matching implementation to ensure consistency.

### Mapping Categories

#### 1. Standard ETFs/Stocks
Most securities use their ticker as-is:
- Examples: `SPY`, `AAPL`, `TLT`, `HYG`
- No special mapping required

#### 2. Indices (Yahoo Finance requires ^ prefix)
- `SPX` → `^GSPC` (S&P 500 Index)
- `COMPQ` → `^IXIC` (NASDAQ Composite)
- `RUT` → `^RUT` (Russell 2000)
- `VIX` → `^VIX` (Volatility Index)
- `DAX` → `^GDAXI` (German DAX)
- `NIKK` → `^N225` (Nikkei 225)
- `SSEC` → `000001.SS` (Shanghai Composite)
- `CRB` → `^CRB` (CRB Commodity Index)

#### 3. Currency Pairs (Yahoo Finance format)
- `EUR/USD` → `EURUSD=X`
- `GBP/USD` → `GBPUSD=X`
- `CAD/USD` → `CADUSD=X`
- `USD/YEN` → `JPY=X`
- `USD` → `DX-Y.NYB` (U.S. Dollar Index / DXY)

#### 4. Commodities (Futures format)
- `WTIC` / `WTI` → `CL=F` (WTI Crude Oil)
- `BRENT` → `BZ=F` (Brent Crude Oil)
- `NATGAS` → `NG=F` (Natural Gas)
- `GOLD` → `GC=F` (Gold Futures)
- `SILVER` → `SI=F` (Silver Futures)
- `COPPER` → `HG=F` (Copper Futures)

#### 5. Cryptocurrency (Yahoo Finance format)
- `BTC` / `BITCOIN` → `BTC-USD`
- `ETH` → `ETH-USD`
- `SOL` → `SOL-USD`
- `AVAX` → `AVAX-USD`
- `XRP` → `XRP-USD`

#### 6. Treasury Yields (FRED API)
- `UST2Y` → `DGS2` (2-Year Treasury Constant Maturity Rate)
- `UST10Y` → `DGS10` (10-Year Treasury Constant Maturity Rate)
- `UST30Y` → `DGS30` (30-Year Treasury Constant Maturity Rate)

## Data Sources

### Yahoo Finance
- **Primary source** for most securities
- Provides real-time quotes and historical data
- Supports: ETFs, stocks, indices, currency pairs, commodities, crypto

### FRED (Federal Reserve Economic Data)
- **Used for**: Treasury yields only
- Provides historical interest rate data
- More reliable for government bond yields

## API Configuration

### Getting Security Configuration

```javascript
import { getSecurityConfig } from './constants/securitiesConfig';

const config = getSecurityConfig('SPY');
// Returns:
// {
//   ticker: 'SPY',
//   source: 'yahoo',
//   apiTicker: 'SPY',
//   name: 'S&P 500 (SPY)',
//   assetClass: 'equity'
// }
```

### Getting API Ticker

```javascript
import { getApiTicker } from './constants/securitiesConfig';

const apiTicker = getApiTicker('SPX');
// Returns: '^GSPC'
```

## Adding New Securities

### Step 1: Add to Securities List
Add the security to `src/constants/securitiesList.js`:

```javascript
{ ticker: 'NEWTICKER', name: 'New Security Name', assetClass: 'equity', bias: 'NEUTRAL' }
```

### Step 2: Add Ticker Mapping (if needed)
If the ticker requires special mapping, add it to `YAHOO_TICKER_MAP` in `src/constants/securitiesConfig.js`:

```javascript
const YAHOO_TICKER_MAP = {
  // ... existing mappings
  'NEWTICKER': 'YAHOO_FORMAT_TICKER',
};
```

### Step 3: Update Server.js (if needed)
If the ticker requires special handling in `server.js`, ensure the mapping logic in `getTickerMapping()` function handles it correctly.

### Step 4: Verify Data Collection
Ensure the data collection Lambda functions (`market_data_collector.py`, `backfill_market_data.py`) can fetch data for the new security.

## Data Collection Requirements

### Historical Data
- All securities should have historical price data stored in DynamoDB `MarketPriceHistory` table
- Minimum requirement: 365 days of data for accurate 1-year metrics
- Data structure: `{ symbol, date, close, open, high, low, volume }`

### Real-time Quotes
- Updated every 5-10 seconds via `/api/quotes` endpoint
- Cached in-memory with TTL to reduce API calls

## Security Count by Asset Class

| Asset Class | Count | Examples |
|------------|-------|----------|
| Fixed Income | 16 | TLT, HYG, UST10Y |
| Equity | 62 | SPY, AAPL, QQQ, XLE |
| Currency | 10 | USD, EUR/USD, UUP |
| Commodity | 16 | GOLD, WTIC, GLD, DBA, CORN, WEAT |
| Crypto | 15 | BTC, ETH, COIN |
| **Total** | **118** | |

## Special Cases

### Duplicate Tickers
- `BTC` and `BITCOIN` both map to `BTC-USD` (same underlying asset)
- `WTIC` and `WTI` both map to `CL=F` (same underlying asset)
- `USD` and `DXY` both map to `DX-Y.NYB` (same underlying asset)

### Asset Class Notes
- `GLD` and `SLV` are ETFs but classified as `commodity` (they track gold/silver prices)
- `DBA`, `CORN`, `WEAT`, `CANE`, `JO`, `NIB` are agriculture commodity ETFs
- `PPLT` is a platinum ETF classified as `commodity`
- `VIX` is an index but classified as `equity` (volatility indicator)
- Treasury yields (`UST2Y`, `UST10Y`, `UST30Y`) are rates, not securities, but included for completeness

## Maintenance

### Regular Tasks
1. **Verify API mappings**: Test that all tickers can be fetched from their respective sources
2. **Check data collection**: Ensure historical data is being collected for all securities
3. **Update mappings**: If Yahoo Finance changes ticker formats, update `YAHOO_TICKER_MAP`
4. **Validate new securities**: Before adding, verify the ticker works with the intended data source

### Troubleshooting

#### Missing Historical Data
- Check DynamoDB `MarketPriceHistory` table for the security
- Verify data collection Lambda is running
- Check if ticker mapping is correct

#### API Errors
- Verify ticker format in `YAHOO_TICKER_MAP` or `FRED_SERIES`
- Test the ticker directly on Yahoo Finance or FRED website
- Check if the security still exists (delisted, merged, etc.)

## Files Reference

- **Security Universe Definition**: `src/constants/securitiesList.js`
- **Ticker Mappings**: `src/constants/securitiesConfig.js`
- **Server Ticker Logic**: `server.js` (lines 62-220)
- **Data Collection**: `aws/lambda/market_data_collector.py`
- **Historical Data Backfill**: `aws/lambda/backfill_market_data.py`


