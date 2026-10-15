# Quad +EV classification review — 2026-09-07

All 58 current portfolio securities have a reviewed primary classification. 56 have a category in the existing four-quad chart; IBIT (Cryptocurrency) and DBMF (Managed Futures) do not. The prior universe and prior-book mappings remain available.

## Reading the order

The ranking uses the ordered Best/Worst factor lists in the existing four-quad +EV chart, preserved in src/constants/quadExposureCatalog.js and checked against expectedValuesData.quadData. It does not use the separate quarterly return table or manufacture individual-security backtests.

Use one primary sector, style, fixed-income sector, or asset class. Secondary exposures remain context and are not averaged. Business or fund-mandate classifications are analyst judgments supported by the sources below; they are not measured factor betas.

Best entries come first, smaller Best rank first. Unlisted quads are placed in the middle as a display convention. Worst entries come last, with Worst #1 last. Equal status and rank share a rank, shown as =. Unlisted means unknown, not neutral or zero return. The convention compares chart placement, not actual returns across quads; rank gaps do not quantify return gaps.

OIH holds oil-services equities and maps to Energy. Q3 Best #2, Q2 Best #4, Q1 unlisted, Q4 Worst #1 gives **3 → 2 → 1 → 4**. Holding OIH short does not reverse that underlying classification. Daily leverage and option overlays also do not create a new sector backtest.

The portfolio Class column now uses the same reviewed economic exposure before the broker’s generic ETF/equity label. MF denotes Managed Futures. Gold retains the dashboard’s existing FX grouping; its Quad +EV category is explicitly Gold.

## Current portfolio

| Security | Primary +EV category | Quad order | Secondary exposures |
| --- | --- | --- | --- |
| AMDY | Tech | 1 = 2 → 3 → 4 | Equities |
| AMZN | Consumer Discretionary | 1 → 2 → 4 → 3 | Equities |
| BRZU | Equities | 1 → 2 → 3 → 4 | Leverage |
| CLOZ | HY Credit | 1 → 2 → 4 → 3 | Fixed Income, Credit, IG Credit, Leveraged Loans |
| COLO | Equities | 1 → 2 → 3 → 4 | Commodities, Financials |
| CRWD | Tech | 1 = 2 → 3 → 4 | Equities, Secular Growth, High Beta |
| CSX | Industrials | 2 → 1 → 3 = 4 | Equities |
| DBMF | Managed Futures | Not covered | — |
| DKS | Consumer Discretionary | 1 → 2 → 4 → 3 | Equities |
| EMIF | Equities | 1 → 2 → 3 → 4 | Industrials, Utilities |
| ENZL | Equities | 1 → 2 → 3 → 4 | Health Care |
| EWP | Equities | 1 → 2 → 3 → 4 | — |
| EXPGY | Industrials | 2 → 1 → 3 = 4 | Equities |
| EZA | Equities | 1 → 2 → 3 → 4 | — |
| FAS | Financials | 2 → 1 → 4 → 3 | Equities, Leverage |
| FRPT | Consumer Staples | 4 → 3 → 2 → 1 | Equities |
| FXH | Health Care | 4 → 3 → 2 → 1 | Equities |
| GDX | Materials | 1 → 2 = 4 → 3 | Equities, Gold |
| HYG | HY Credit | 1 → 2 → 4 → 3 | Fixed Income, Credit |
| IBIT | Cryptocurrency | Not covered | — |
| IGV | Tech | 1 = 2 → 3 → 4 | Equities, Secular Growth |
| IPAY | Financials | 2 → 1 → 4 → 3 | Equities, Secular Growth |
| JETS | Industrials | 2 → 1 → 3 = 4 | Equities |
| JOET | Momentum | 1 = 3 → 2 → 4 | Equities, Quality |
| JOJO | Fixed Income | 4 → 3 → 1 = 2 | — |
| JPM | Financials | 2 → 1 → 4 → 3 | Equities |
| LLYX | Health Care | 4 → 3 → 2 → 1 | Equities, Leverage |
| LVHI | Dividend Yield | 4 → 1 → 2 = 3 | Equities, Low Beta |
| MICC | Consumer Staples | 4 → 3 → 2 → 1 | Equities |
| MSFT | Tech | 1 = 2 → 3 → 4 | Equities |
| MSOS | Health Care | 4 → 3 → 2 → 1 | Equities |
| OIH | Energy | 3 → 2 → 1 → 4 | Equities |
| PBD | Equities | 1 → 2 → 3 → 4 | Industrials, Utilities |
| PCAR | Industrials | 2 → 1 → 3 = 4 | Equities |
| PFSI | Financials | 2 → 1 → 4 → 3 | Equities |
| PRN | Industrials | 2 → 1 → 3 = 4 | Equities, Momentum |
| PTF | Tech | 1 = 2 → 3 → 4 | Equities, Momentum, Secular Growth |
| QAT | Equities | 1 → 2 → 3 → 4 | Financials |
| R | Industrials | 2 → 1 → 3 = 4 | Equities |
| RDNT | Health Care | 4 → 3 → 2 → 1 | Equities |
| RXL | Health Care | 4 → 3 → 2 → 1 | Equities, Leverage |
| SAIA | Industrials | 2 → 1 → 3 = 4 | Equities |
| SJM | Consumer Staples | 4 → 3 → 2 → 1 | Equities |
| SNOW | Tech | 1 = 2 → 3 → 4 | Equities, Secular Growth |
| SRUUF | Commodities | 2 → 3 → 1 → 4 | — |
| SUJA | Consumer Staples | 4 → 3 → 2 → 1 | Equities, Secular Growth |
| TLT | Long Bond | 4 → 3 → 1 → 2 | Fixed Income |
| TTD | Tech | 1 = 2 → 3 → 4 | Equities, Secular Growth |
| TXG | Health Care | 4 → 3 → 2 → 1 | Equities |
| UGL | Gold | 3 → 4 → 1 = 2 | — |
| UNG | Commodities | 2 → 3 → 1 → 4 | — |
| UNHG | Health Care | 4 → 3 → 2 → 1 | Equities, Leverage |
| WEAT | Commodities | 2 → 3 → 1 → 4 | — |
| WMT | Consumer Staples | 4 → 3 → 2 → 1 | Equities, Defensives, Quality |
| XBI | Health Care | 4 → 3 → 2 → 1 | Equities |
| XLU | Utilities | 3 → 4 → 1 = 2 | Equities, Low Beta, Defensives |
| YCL | FX | 1 = 2 → 3 → 4 | — |
| ZROZ | Long Bond | 4 → 3 → 1 → 2 | Fixed Income |

## Existing chart categories

Cash, Cryptocurrency, and Managed Futures are explicit classification categories outside the chart. Their absence does not create a fabricated four-way tie.

| Dimension | Category | Q1 | Q2 | Q3 | Q4 | Display order |
| --- | --- | --- | --- | --- | --- | --- |
| Asset Classes | Equities | Best #1 | Best #2 | Not listed | Worst #2 | 1 → 2 → 3 → 4 |
| Asset Classes | Credit | Best #2 | Best #3 | Worst #1 | Worst #3 | 1 → 2 → 4 → 3 |
| Asset Classes | Commodities | Best #3 | Best #1 | Best #2 | Worst #1 | 2 → 3 → 1 → 4 |
| Asset Classes | FX | Best #4 | Best #4 | Not listed | Worst #4 | 1 = 2 → 3 → 4 |
| Asset Classes | Fixed Income | Worst #1 | Worst #1 | Best #3 | Best #1 | 4 → 3 → 1 = 2 |
| Asset Classes | USD | Worst #2 | Worst #2 | Not listed | Best #3 | 4 → 3 → 1 = 2 |
| Equity Sectors | Tech | Best #1 | Best #1 | Best #4 | Worst #2 | 1 = 2 → 3 → 4 |
| Equity Sectors | Consumer Discretionary | Best #2 | Best #5 | Worst #3 | Worst #5 | 1 → 2 → 4 → 3 |
| Equity Sectors | Communication Services | Best #3 | Worst #2 | Worst #1 | Not listed | 1 → 4 → 2 → 3 |
| Equity Sectors | Industrials | Best #4 | Best #2 | Worst #4 | Worst #4 | 2 → 1 → 3 = 4 |
| Equity Sectors | Materials | Best #5 | Not listed | Worst #5 | Not listed | 1 → 2 = 4 → 3 |
| Equity Sectors | REITS | Best #6 | Worst #4 | Best #3 | Not listed | 3 → 1 → 4 → 2 |
| Equity Sectors | Utilities | Worst #1 | Worst #1 | Best #1 | Best #3 | 3 → 4 → 1 = 2 |
| Equity Sectors | Consumer Staples | Worst #2 | Worst #3 | Best #5 | Best #1 | 4 → 3 → 2 → 1 |
| Equity Sectors | Health Care | Worst #3 | Worst #5 | Best #6 | Best #2 | 4 → 3 → 2 → 1 |
| Equity Style Factors | High Beta | Best #1 | Best #2 | Not listed | Worst #1 | 1 → 2 → 3 → 4 |
| Equity Style Factors | Momentum | Best #2 | Best #5 | Best #2 | Worst #2 | 1 = 3 → 2 → 4 |
| Equity Style Factors | Leverage | Best #3 | Not listed | Not listed | Worst #3 | 1 → 2 = 3 → 4 |
| Equity Style Factors | Secular Growth | Best #4 | Best #1 | Best #1 | Worst #4 | 2 = 3 → 1 → 4 |
| Equity Style Factors | Mid Caps | Best #5 | Not listed | Best #3 | Not listed | 3 → 1 → 2 = 4 |
| Equity Style Factors | Low Beta | Worst #1 | Worst #1 | Best #4 | Best #1 | 4 → 3 → 1 = 2 |
| Equity Style Factors | Defensives | Worst #2 | Worst #4 | Worst #4 | Best #4 | 4 → 2 = 3 → 1 |
| Equity Style Factors | Value | Worst #3 | Worst #3 | Worst #3 | Best #5 | 4 → 1 = 2 = 3 |
| Equity Style Factors | Dividend Yield | Worst #4 | Worst #2 | Worst #2 | Best #2 | 4 → 1 → 2 = 3 |
| Equity Style Factors | Small Caps | Worst #5 | Best #3 | Worst #1 | Not listed | 2 → 4 → 1 → 3 |
| Fixed Income Sectors | BDCs | Best #1 | Best #2 | Worst #1 | Worst #3 | 1 → 2 → 4 → 3 |
| Fixed Income Sectors | Convertibles | Best #2 | Best #1 | Worst #3 | Not listed | 2 → 1 → 4 → 3 |
| Fixed Income Sectors | HY Credit | Best #3 | Best #5 | Worst #5 | Not listed | 1 → 2 → 4 → 3 |
| Fixed Income Sectors | EM $ Debt | Best #4 | Not listed | Best #2 | Not listed | 3 → 1 → 2 = 4 |
| Fixed Income Sectors | Leveraged Loans | Best #5 | Best #4 | Worst #4 | Worst #4 | 2 → 1 → 3 = 4 |
| Fixed Income Sectors | TIPS | Worst #1 | Not listed | Best #4 | Worst #5 | 3 → 2 → 4 → 1 |
| Fixed Income Sectors | Short Duration Treasurys | Worst #2 | Not listed | Not listed | Not listed | 2 = 3 = 4 → 1 |
| Fixed Income Sectors | MBS | Worst #3 | Worst #4 | Not listed | Best #5 | 4 → 3 → 2 → 1 |
| Fixed Income Sectors | Treasury Belly | Worst #4 | Worst #2 | Best #5 | Best #2 | 4 → 3 → 1 → 2 |
| Fixed Income Sectors | Long Bond | Worst #5 | Worst #1 | Best #3 | Best #1 | 4 → 3 → 1 → 2 |
| Equity Sectors | Financials | Not listed | Best #3 | Worst #2 | Worst #3 | 2 → 1 → 4 → 3 |
| Equity Sectors | Energy | Not listed | Best #4 | Best #2 | Worst #1 | 3 → 2 → 1 → 4 |
| Equity Style Factors | Cyclical Growth | Not listed | Best #4 | Not listed | Worst #5 | 2 → 1 = 3 → 4 |
| Equity Style Factors | Size | Not listed | Worst #5 | Worst #5 | Not listed | 1 = 4 → 2 = 3 |
| Fixed Income Sectors | Preferreds | Not listed | Best #3 | Worst #2 | Worst #1 | 2 → 1 → 3 → 4 |
| Fixed Income Sectors | Munis | Not listed | Worst #3 | Best #1 | Best #4 | 3 → 4 → 1 → 2 |
| Fixed Income Sectors | IG Credit | Not listed | Worst #5 | Not listed | Best #3 | 4 → 1 = 3 → 2 |
| Asset Classes | Gold | Not listed | Not listed | Best #1 | Best #2 | 3 → 4 → 1 = 2 |
| Equity Style Factors | Quality | Not listed | Not listed | Best #5 | Best #3 | 4 → 3 → 1 = 2 |
| Fixed Income Sectors | EM Local Currency | Not listed | Not listed | Not listed | Worst #2 | 1 = 2 = 3 → 4 |
| Asset Classes | Cash | Not listed | Not listed | Not listed | Not listed | Not covered |
| Asset Classes | Cryptocurrency | Not listed | Not listed | Not listed | Not listed | Not covered |
| Asset Classes | Managed Futures | Not listed | Not listed | Not listed | Not listed | Not covered |

## Classification notes and primary sources

These additions and corrections extend the previously reviewed catalog. Sources establish security identity and business or fund mandate; the existing dashboard chart supplies the ordinal ranks. Existing profiles not listed below retain their prior review.

**OIH — Energy.** Oil equipment, services and drilling companies. Energy equities are the primary exposure; this fund does not hold physical oil. Sources: [vaneck.com](https://www.vaneck.com/us/en/investments/oil-services-etf-oih/overview/).

**SNOW, TTD — Tech.** Software platforms: Snowflake provides cloud data infrastructure; The Trade Desk provides advertising technology. Sources: [investors.snowflake.com](https://investors.snowflake.com/overview/default.aspx), [investors.thetradedesk.com](https://investors.thetradedesk.com/financials/quarterly-results/default.aspx).

**FRPT, SJM, MICC — Consumer Staples.** Food businesses: Freshpet makes pet food, Smucker sells packaged food and pet products, and MICC is Magnum Ice Cream Company, not the former Millicom ticker. Sources: [investor.freshpet.com](https://investor.freshpet.com/node/14301/html), [jmsmucker.com](https://www.jmsmucker.com/assets/jmsmucker/news-stories/corporate-publications/FY24_AnnualReport.pdf), [sec.gov](https://www.sec.gov/Archives/edgar/data/2071668/000110465926029805/micc-20251231x20f.htm).

**SAIA, R, CSX, PCAR — Industrials.** Freight transportation, logistics, railroads and truck manufacturing are industrial businesses. Sources: [investors.ryder.com](https://investors.ryder.com/about/default.aspx), [investors.paccar.com](https://investors.paccar.com/financials/quarterly-results/default.aspx), [csx.com](https://www.csx.com/).

**JPM, PFSI — Financials.** Banking and mortgage origination/servicing businesses. PFSI is a financial-services company, not a mortgage bond fund. Sources: [jpmorgan.com](https://www.jpmorgan.com/about-us), [pennymac.com](https://www.pennymac.com/).

**TXG, RDNT — Health Care.** Life-science tools and diagnostic imaging. Technology used by a health-care business does not make it a broad Tech-sector fund. Sources: [10xgenomics.com](https://www.10xgenomics.com/company), [radnet.com](https://www.radnet.com/about-radnet/news).

**DKS, AMZN — Consumer Discretionary.** Retail businesses are classified by their consumer-discretionary sector. Amazon also has a material cloud business; the primary sector remains Consumer Discretionary. Sources: [investors.dicks.com](https://investors.dicks.com/about-us/), [ssga.com](https://www.ssga.com/us/en/individual/etfs/state-street-consumer-discretionary-select-sector-spdr-etf-xly).

**EXPGY — Industrials.** Experian supplies credit information and analytics as a professional-services business. Credit-related revenues do not make its shares a Credit bond exposure. Sources: [experianplc.com](https://www.experianplc.com/what-we-do/our-business-model).

**IGV — Tech.** The fund targets software companies. Sources: [ishares.com](https://www.ishares.com/us/products/239771/).

**FXH, XBI, MSOS — Health Care.** FXH targets health-care stocks and XBI targets biotech. MSOS is a cannabis strategy whose prospectus specifies concentration in pharmaceuticals, biotechnology and life sciences; it is not a defensive substitute for the broad sector. Sources: [ftportfolios.com](https://www.ftportfolios.com/retail/etf/ETFsummary.aspx?Ticker=FXH), [ssga.com](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-biotech-etf-xbi), [sec.gov](https://www.sec.gov/Archives/edgar/data/1408970/000182912625008584/advisorshares-msos_497k.htm).

**PRN — Industrials.** Industrials is the mandate; momentum selects stocks within that sector. Sources: [invesco.com](https://www.invesco.com/us-rest/contentdetail?contentId=119307c649400410VgnVCM10000046f1bf0aRCRD).

**JETS — Industrials.** Airlines and aviation businesses are transportation equities, not an oil commodity exposure. Sources: [usglobaletfs.com](https://usglobaletfs.com/fund/u-s-global-jets-etf/).

**JOET — Momentum.** The mandate combines momentum and quality. Momentum is the selected primary +EV lens; Quality remains visible as a secondary exposure. Their quad ranks are not averaged. Sources: [ir.virtus.com](https://ir.virtus.com/news/news-details/2020/Virtus-ETFs-Launches-Core-Equity-Exchange-Traded-Fund-Driven-by-the-Investment-Principles-of-Joe-Terranova/default.aspx).

**LVHI — Dividend Yield.** International high-dividend equities with a low-volatility screen and currency hedging. Dividend Yield is the primary mandate; Low Beta is a qualitative secondary lens, not a measured beta. Sources: [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds/products/91481/SINGLCLASS/franklin-international-low-volatility-high-dividend-index-etf/LVHI).

**EWP — Equities.** A diversified Spain equity fund. Country membership alone does not assign a single sector or style. Sources: [ishares.com](https://www.ishares.com/us/products/239683/ishares-msci-spain-capped-etf).

**EMIF, PBD — Equities.** Diversified thematic equity portfolios spanning several sectors: emerging-market infrastructure or global clean energy. Use broad Equities for the single primary rank; sector overlaps are secondary. Sources: [ishares.com](https://www.ishares.com/us/products/239735/ishares-emerging-markets-infrastructure-etf), [invesco.com](https://www.invesco.com/us/en/solutions/esg-sustainability.html).

**RXL, LLYX, UNHG — Health Care.** Daily leveraged long exposure to the health-care sector, Eli Lilly or UnitedHealth. Rank the underlying sector; leverage changes the payoff, not the sector classification. Sources: [proshares.com](https://www.proshares.com/our-etfs/leveraged-and-inverse/rxl), [defianceetfs.com](https://www.defianceetfs.com/llyx/), [leverageshares.com](https://leverageshares.com/us/etfs/leverage-shares-2x-long-unh-daily-etf/).

**FAS — Financials.** Daily leveraged long financial-sector exposure. Sources: [direxion.com](https://www.direxion.com/all-etfs?filter=sector-equity).

**BRZU — Equities.** Daily leveraged long Brazil equities. The country basket is the primary exposure. Sources: [direxion.com](https://www.direxion.com/all-etfs?filter=sector-equity).

**YCL — FX.** Daily leveraged long yen exposure. This uses the broad FX chart category, which does not distinguish individual currencies. Sources: [proshares.com](https://www.proshares.com/our-etfs/find-leveraged-and-inverse-etfs).

**UGL — Gold.** Daily leveraged long gold exposure. The gold asset-class lens applies, rather than an equity sector. Sources: [proshares.com](https://www.proshares.com/our-etfs/leveraged-and-inverse/ugl?source=CORE_GROWTH).

**AMDY — Tech.** Options provide AMD exposure and income. Tech describes the underlying business; option income and limited upside mean the fund will not reproduce the sector backtest. Distributions are not the Dividend Yield stock factor. Sources: [yieldmaxetfs.com](https://yieldmaxetfs.com/our-etfs/amdy/).

**ZROZ — Long Bond.** Long-dated zero-coupon Treasury exposure. Sources: [sec.gov](https://www.sec.gov/Archives/edgar/data/1450011/000119312525249112/d34027d497k.htm).

**JOJO — Fixed Income.** A bond strategy rotating between high-yield credit and Treasuries. Broad Fixed Income is a coarse mandate classification; its changing allocation is not a permanent HY Credit or Long Bond exposure. Sources: [atacfunds.com](https://atacfunds.com/faq/).

**UNG, SRUUF — Commodities.** Natural-gas futures or physical uranium exposure, rather than shares in energy producers. Sources: [uscfinvestments.com](https://www.uscfinvestments.com/ung), [sprottusa.com](https://www.sprottusa.com/api-update/investment-strategies/physical-commodity-funds/uranium/).

**DBMF — Managed Futures.** A changing long/short futures strategy spanning equities, bonds, currencies and commodities. The four-quad chart does not backtest this strategy; a single static asset-class rank would be misleading. Sources: [imgp.com](https://www.imgp.com/us/fund/US53700T8273-imgp-dbi-managed-futures-strategy-etf/).
