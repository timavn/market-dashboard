# Investment Pipeline Evaluation: Market Dashboard

> *"How much of your firm's investment process do you actually understand?"*

This document evaluates the market-dashboard project through the lens of the systematic investment process pipeline. It serves as a self-audit to understand what we've built, what assumptions are hidden in our "black boxes," and where we can deepen our understanding and capabilities.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [The Framework: 7 Stations of the Investment Process](#the-framework)
3. [Pipeline Coverage Matrix](#pipeline-coverage-matrix)
4. [Station 1: Data Curation](#station-1-data-curation)
5. [Station 2: Feature Engineering](#station-2-feature-engineering)
6. [Station 3: Signal Generation](#station-3-signal-generation)
7. [Station 4: Portfolio Construction](#station-4-portfolio-construction)
8. [Station 5: Risk Management](#station-5-risk-management)
9. [Station 6: Execution](#station-6-execution)
10. [Station 7: Infrastructure](#station-7-infrastructure)
11. [Known Limitations & Black Boxes](#known-limitations)
12. [Improvement Roadmap](#improvement-roadmap)

---

## Executive Summary

This project is a **personal investment dashboard** that implements portions of a systematic investment process. Unlike institutional systems where specialization creates strategic blindness, this project gives us end-to-end visibility—but with trade-offs in depth and sophistication.

### What We've Built

```
Schwab CSV → S3 → Lambda → DynamoDB → Express API → React Dashboard
     ↓              ↓            ↓           ↓
Portfolio      Hedgeye     Risk Ranges   Real-time
  Data         Scraper      + Signals     Display
```

### Pipeline Coverage Summary

| Station | Coverage | Description |
|---------|----------|-------------|
| Data Curation | **70%** | Multiple sources, some vendor handling, no point-in-time |
| Feature Engineering | **40%** | Basic transformations, limited normalization |
| Signal Generation | **60%** | Hedgeye signals + custom scoring, no backtesting |
| Portfolio Construction | **20%** | Analytics only, no optimization |
| Risk Management | **30%** | Basic metrics, simplified models |
| Execution | **0%** | Not implemented |
| Infrastructure | **70%** | Solid AWS serverless foundation |

---

## The Framework

The systematic investment process is a pipeline of specialized stations. In large firms, each station is a black box that downstream users consume without understanding internals. We aim to understand our entire pipeline.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        SYSTEMATIC INVESTMENT PROCESS                             │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐ │
│   │   DATA   │───▶│ FEATURES │───▶│ SIGNALS  │───▶│PORTFOLIO │───▶│   RISK   │ │
│   │ CURATION │    │ENGINEERING│   │GENERATION│    │CONSTRUCT.│    │MANAGEMENT│ │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘ │
│        │               │               │               │               │        │
│        └───────────────┴───────────────┴───────────────┴───────────────┘        │
│                                        │                                         │
│                              ┌─────────▼─────────┐                              │
│                              │    EXECUTION      │                              │
│                              └───────────────────┘                              │
│                                                                                  │
│   ┌──────────────────────────────────────────────────────────────────────────┐  │
│   │                         INFRASTRUCTURE                                    │  │
│   │   (Data pipelines, APIs, storage, scheduling, monitoring)                │  │
│   └──────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### What a PM Should Know at Each Station

According to the framework, a practitioner should understand:

1. **Data**: Where data comes from, vendor quirks, corporate actions handling, point-in-time methodology
2. **Features**: Why transformations were chosen, normalization methods, decay characteristics
3. **Signals**: Theoretical basis, holding period, conditions where signals break
4. **Portfolio**: How positions are sized, what constraints apply, how signals become weights
5. **Risk**: Risk model methodology, factor definitions, stress scenarios
6. **Execution**: Transaction costs, timing effects, market impact
7. **Infrastructure**: Platform assumptions, production vs backtest parity, versioning

---

## Pipeline Coverage Matrix

| Station | Component | Implementation | Understanding | Documented |
|---------|-----------|----------------|---------------|------------|
| **Data** | Yahoo Finance quotes | ✅ Implemented | ⚠️ Partial | ⚠️ Partial |
| | FRED Treasury yields | ✅ Implemented | ✅ Full | ✅ Yes |
| | Schwab CSV parsing | ✅ Implemented | ✅ Full | ✅ Yes |
| | Hedgeye risk ranges | ✅ Implemented | ⚠️ Partial | ⚠️ Partial |
| | Point-in-time handling | ❌ Not implemented | ❌ Gap | ❌ No |
| | Corporate actions | ❌ Delegated to Yahoo | ❌ Black box | ❌ No |
| **Features** | Price normalization | ⚠️ Basic | ⚠️ Partial | ❌ No |
| | Trend/Tail levels | ✅ From Hedgeye | ⚠️ Partial | ⚠️ Partial |
| | USD correlations | ✅ Implemented | ✅ Full | ⚠️ Partial |
| **Signals** | Signal strength score | ✅ Implemented | ✅ Full | ✅ Yes |
| | Quad regime rankings | ✅ Implemented | ✅ Full | ✅ Yes |
| | LRR/HRR signals | ✅ Implemented | ⚠️ Partial | ⚠️ Partial |
| | Signal backtesting | ❌ Not implemented | ❌ Gap | ❌ No |
| **Portfolio** | Risk metrics | ✅ Implemented | ✅ Full | ⚠️ Partial |
| | Factor exposures | ✅ Implemented | ⚠️ Partial | ⚠️ Partial |
| | Optimization | ❌ Not implemented | ❌ Gap | ❌ No |
| | Position sizing | ❌ Not implemented | ❌ Gap | ❌ No |
| **Risk** | VaR calculation | ⚠️ Simplified | ⚠️ Partial | ❌ No |
| | Concentration metrics | ✅ Implemented | ✅ Full | ⚠️ Partial |
| | Stress testing | ❌ Not implemented | ❌ Gap | ❌ No |
| **Execution** | Order management | ❌ Not implemented | N/A | N/A |
| | TCA | ❌ Not implemented | ❌ Gap | ❌ No |
| **Infra** | AWS Lambda | ✅ Implemented | ✅ Full | ✅ Yes |
| | DynamoDB | ✅ Implemented | ✅ Full | ✅ Yes |
| | Express API | ✅ Implemented | ✅ Full | ✅ Yes |
| | React Dashboard | ✅ Implemented | ✅ Full | ⚠️ Partial |

**Legend**: ✅ Complete | ⚠️ Partial | ❌ Gap/Missing

---

## Station 1: Data Curation

### Current Implementation

We aggregate data from multiple sources:

#### Source 1: Yahoo Finance (Primary Market Data)

**File**: `server.js` (lines 142-170)

**Known Vendor Quirks**:
- Index symbols require `^` prefix (e.g., `^GSPC` not `SPX`)
- Currency pairs use `=X` suffix
- Futures use `=F` suffix
- Some tickers have special formats (`DX-Y.NYB` for dollar index)
- Rate limiting: ~2000 requests/hour without API key
- Data delays: 15-20 minutes for free tier

**What We Don't Know**:
- How Yahoo handles corporate actions (splits, dividends)
- Data revision policy (do they restate historical data?)
- Survivorship bias handling
- Source of underlying data (exchange feeds? consolidated tape?)

#### Source 2: FRED (Treasury Yields)

**File**: `server.js` (lines 71-75)

```javascript
const FRED_SERIES = {
  'UST30Y': 'DGS30',  // 30-Year Treasury Constant Maturity Rate
  'UST10Y': 'DGS10',  // 10-Year Treasury Constant Maturity Rate
  'UST2Y': 'DGS2',    // 2-Year Treasury Constant Maturity Rate
};
```

**What We Know**:
- Data is from Federal Reserve (authoritative source)
- Daily updates at 3:00 PM ET
- Historical data available back to 1962

#### Source 3: Schwab CSV (Portfolio Holdings)

**File**: `aws/lambda/csv_processor.py` (lines 80-189)

**Known Vendor Quirks (Schwab)**:
- Header row is on line 3, not line 1
- Dollar formatting: `$1,234.56` requires cleaning
- Negative numbers: `($500.00)` format
- Missing data represented as `--` or `N/A`
- "Account Total" rows must be filtered
- Security Type values: "ETFs & Closed End Funds", "Equity", "Cash and Money Market", etc.

#### Source 4: Hedgeye Risk Ranges (Signals)

**File**: `aws/HEDGEYE_AUTOMATION_SETUP.md`

Scraping Hedgeye's Risk Range Signals page for:
- LRR (Low Risk Range / Buy Trade)
- HRR (High Risk Range / Sell Trade)

**What We Know**:
- Scraped daily at 5:00 PM ET after market close
- Stored in DynamoDB with date-based partitioning
- Mapped to our ticker universe via `TICKER_MAPPING`

**What We Don't Know (Black Boxes)**:
- How Hedgeye calculates LRR/HRR
- What model/methodology underlies the signals
- Signal decay characteristics
- Historical accuracy of signals

### Data Curation Gaps

| Gap | Impact | Mitigation |
|-----|--------|------------|
| **No point-in-time database** | Potential look-ahead bias in analysis | Store daily snapshots with timestamps |
| **Corporate actions delegated** | Splits/dividends may cause discontinuities | Trust Yahoo or build adjustment layer |
| **No data quality monitoring** | Bad data could propagate silently | Add validation checks and alerting |
| **No backfill policy** | Can't rebuild history if vendor changes | Document current data and archive raw |

---

## Station 2: Feature Engineering

### Current Implementation

Feature engineering transforms raw data into predictive inputs.

#### Feature 1: Price Position vs Trend Level

**File**: `src/services/signalStrengthService.js` (lines 32-49)

- Binary classification: above/below threshold
- No normalization (distance from level ignored)
- No decay modeling

#### Feature 2: Price Position vs Tail Level

**File**: `src/services/signalStrengthService.js` (lines 51-68)

- Secondary signal (half weight of trend level)
- Same binary classification approach

#### Feature 3: Risk/Reward Ratio

**File**: `src/services/signalStrengthService.js` (lines 70-78)

- Linear combination of upside/downside
- Clamped to ±20 range
- Scaling factor of 0.8 (assumes 25% max move → 20 points)

#### Feature 4: Sector Classification

**File**: `src/services/portfolioAnalytics.js` (lines 171-237)

- Keyword-based sector classification (brittle)
- No GICS codes or industry classifications
- ETFs classified by name, not underlying holdings

### Feature Engineering Gaps

| Gap | Impact | Improvement |
|-----|--------|-------------|
| **No z-score normalization** | Can't compare features across assets | Add rolling z-scores |
| **Binary features only** | Lose information about magnitude | Add continuous features |
| **No decay modeling** | Don't know signal half-life | Track feature performance over time |
| **No outlier handling** | Extreme values distort signals | Add winsorization |

---

## Station 3: Signal Generation

### Current Implementation

#### Signal 1: Composite Signal Strength Score

**File**: `src/services/signalStrengthService.js`

```
Signal Strength = Base Score + Momentum Score + Support/Resistance Score + Risk/Reward Score
                  ±50           ±20              ±10                        ±20
                  
Range: -100 to +100
```

**Scoring Breakdown**:

| Component | Weight | Source | Theoretical Basis |
|-----------|--------|--------|-------------------|
| Base (Trend Signal) | ±50 | Hedgeye bias | Discretionary overlay |
| Momentum | ±20 | Price vs Trend Level | Trend following |
| Support/Resistance | ±10 | Price vs Tail Level | Technical levels |
| Risk/Reward | ±20 | Upside - Downside | Asymmetric payoff |

#### Signal 2: Quad Regime Rankings

**File**: `src/constants/quadRankings.js`

Based on Hedgeye's Growth-Inflation Quad model:

| Quad | Growth | Inflation | Favored Assets |
|------|--------|-----------|----------------|
| Q1 | Accelerating | Decelerating | Equities, Credit, High Beta |
| Q2 | Accelerating | Accelerating | Commodities, Cyclicals |
| Q3 | Decelerating | Accelerating | Gold, TIPS, Utilities |
| Q4 | Decelerating | Decelerating | Bonds, Defensives, USD |

#### Signal 3: LRR/HRR Risk Range Signals

```
LRR (Low Risk Range) = Buy signal level
HRR (High Risk Range) = Sell signal level

If Price < LRR: BULLISH (buy zone)
If Price > HRR: BEARISH (sell zone)
If LRR < Price < HRR: NEUTRAL (hold zone)
```

### Signal Generation Gaps

| Gap | Impact | Improvement |
|-----|--------|-------------|
| **No backtesting** | Can't validate signal efficacy | Build simple backtest framework |
| **No signal decay analysis** | Don't know optimal holding period | Track signal age vs performance |
| **Manual bias inputs** | Stale biases in securitiesList.js | Automate from Hedgeye data |
| **No signal correlation** | May be double-counting | Add correlation matrix |

---

## Station 4: Portfolio Construction

### Current Implementation

**Critical Gap**: We analyze portfolios but don't construct them. The portfolio comes from Schwab CSV uploads—positions are determined manually, not by an optimizer.

#### What We Have: Portfolio Analytics

**File**: `src/services/portfolioAnalytics.js`

**Metrics Calculated**:

| Category | Metrics |
|----------|---------|
| Basic | Total value, cost basis, P&L, position count |
| Risk | Volatility, Sharpe, Sortino, VaR (95%), Max Drawdown |
| Exposure | Gross, Net Long, Net Short, Net |
| Concentration | Top 10 %, Largest position %, HHI Index |
| Factors | Market cap, Sector, Geographic exposures |

#### What We Don't Have: Portfolio Optimization

**What's Missing**:
- No optimizer (mean-variance, Black-Litterman, risk parity)
- No constraint system
- No position sizing rules
- No turnover management
- No target portfolio generation

---

## Station 5: Risk Management

### Current Implementation

**File**: `src/services/portfolioAnalytics.js` (lines 40-61)

**Known Simplifications**:

| Metric | Current Method | Proper Method |
|--------|----------------|---------------|
| Volatility | P&L % variance | Historical return std dev (annualized) |
| Sharpe | Hardcoded 2% RF | Current T-bill rate |
| VaR | 5th percentile of P&L | Parametric/Monte Carlo with correlations |
| Drawdown | Simplified | Peak-to-trough from equity curve |

### Risk Management Gaps

| Gap | Impact | Improvement |
|-----|--------|-------------|
| **Simplified VaR** | May understate tail risk | Add parametric VaR with correlations |
| **No stress testing** | Don't know scenario impacts | Add historical stress scenarios |
| **Keyword sectors** | Misclassification errors | Use GICS codes or ETF lookthrough |
| **Static risk-free** | Sharpe ratio inaccurate | Pull current T-bill rate |

---

## Station 6: Execution

### Current Implementation

**Not Implemented**. This is a monitoring dashboard, not a trading system.

### What You Should Know

Per the article:

> "For a one-day reversal factor: if you can trade on the same day's close, Sharpe is 1.4x. If you have to trade at next day's open, Sharpe drops to 0.3x. That is an 80% loss from execution timing alone."

**Transaction Cost Components**:
- Commissions (Schwab: $0 for stocks/ETFs)
- Bid-ask spread (varies by liquidity)
- Market impact (for larger orders)
- Timing slippage (signal decay)

---

## Station 7: Infrastructure

### Current Implementation

#### AWS Serverless Architecture

**Components**:

| Component | Purpose | File |
|-----------|---------|------|
| S3 | CSV storage, triggers Lambda | `market-dashboard-csv-data` bucket |
| Lambda | CSV processing, Hedgeye scraping | `aws/lambda/csv_processor.py` |
| DynamoDB | Portfolio snapshots, risk ranges | 3 tables |
| EventBridge | Daily automation | 5 PM ET schedule |
| Express | API layer, data aggregation | `server.js` |
| React | Dashboard UI | `src/` |

#### API Layer

**File**: `server.js`

Endpoints:
- `GET /api/quotes` - Real-time prices from Yahoo
- `GET /api/portfolio` - Latest portfolio from DynamoDB
- `GET /api/risk-ranges` - Hedgeye LRR/HRR data
- `GET /api/usd/correlations` - USD correlation matrix
- `POST /api/presigned-url` - S3 upload URLs

---

## Known Limitations

### Black Boxes We Accept

1. **Yahoo Finance Data Quality**: We trust Yahoo for corporate actions, data accuracy, and timeliness. No independent verification.

2. **Hedgeye LRR/HRR Methodology**: We consume signals without understanding the underlying model. It's a black box we've chosen to trust.

3. **Schwab Reporting Accuracy**: We trust that Schwab's CSV exports are accurate and timely.

### Assumptions We've Made

| Assumption | Location | Risk |
|------------|----------|------|
| 2% risk-free rate | `portfolioAnalytics.js:48` | Sharpe inaccurate when rates change |
| 25% max upside/downside | `signalStrengthService.js:77` | Score saturation in volatile markets |
| ETFs are 70% large cap | `portfolioAnalytics.js:163` | Factor exposure errors |
| Yahoo handles splits | Implicit | Data discontinuities |

---

## Improvement Roadmap

### Phase 1: Foundation (Highest Priority)

1. **Add Point-in-Time Data Storage**
   - Store daily price snapshots with timestamps
   - Enable historical analysis without look-ahead bias
   - Effort: Medium | Impact: High

2. **Implement Signal Backtesting**
   - Simple framework to test signal efficacy
   - Track hit rate over 5d/20d horizons
   - Effort: Medium | Impact: High

3. **Add Data Quality Monitoring**
   - Alerts for missing data, outliers, stale prices
   - Daily data completeness checks
   - Effort: Low | Impact: Medium

### Phase 2: Analytics Enhancement

4. **Improve Risk Model**
   - Replace keyword sectors with GICS codes
   - Add proper VaR calculation
   - Track correlations over time
   - Effort: Medium | Impact: Medium

5. **Add Feature Normalization**
   - Z-score features
   - Add percentile rankings
   - Track feature decay
   - Effort: Low | Impact: Medium

### Phase 3: Advanced Capabilities

6. **Add Basic Optimizer**
   - Simple mean-variance or equal risk contribution
   - Generate target portfolios from signals
   - Effort: High | Impact: High

7. **Add Stress Testing**
   - Historical scenarios (2008, 2020, etc.)
   - Factor shock analysis
   - Effort: Medium | Impact: Medium

---

## Conclusion

This project implements a substantial portion of the investment pipeline, with particular strength in:
- **Data aggregation** from multiple sources
- **Signal generation** via composite scoring
- **Risk monitoring** with basic metrics
- **Infrastructure** for automation

The major gaps are:
- **Portfolio construction** (no optimizer)
- **Execution** (manual trading only)
- **Backtesting** (can't validate signals)

Unlike practitioners at large firms who are siloed into single stations, you have visibility across the entire pipeline. The challenge is deepening understanding at each station while maintaining breadth.

> *"The goal is not to reject your firm's infrastructure. The goal is to see through it."*

For this personal project, the goal is to understand every component deeply enough that you could rebuild it from scratch—or improve it—without depending on black boxes you don't understand.

---

*Last Updated: December 2024*





