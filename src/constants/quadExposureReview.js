// Business/mandate review for the September 2026 portfolio. These are analyst
// classifications into the existing +EV categories, not measured factor betas.
export const QUAD_EXPOSURE_REVIEW_DATE = '2026-09-07';

export const QUAD_EXPOSURE_REVIEW = [
  {
    symbols: ['OIH'], primary: ['equitySectors', 'Energy'],
    secondary: [['assetClasses', 'Equities']],
    note: 'Oil equipment, services and drilling companies. Energy equities are the primary exposure; this fund does not hold physical oil.',
    sources: ['https://www.vaneck.com/us/en/investments/oil-services-etf-oih/overview/'],
  },
  {
    symbols: ['SNOW', 'TTD'], primary: ['equitySectors', 'Tech'],
    secondary: [['assetClasses', 'Equities'], ['equityStyleFactors', 'Secular Growth']],
    note: 'Software platforms: Snowflake provides cloud data infrastructure; The Trade Desk provides advertising technology.',
    sources: ['https://investors.snowflake.com/overview/default.aspx', 'https://investors.thetradedesk.com/financials/quarterly-results/default.aspx'],
  },
  {
    symbols: ['FRPT', 'SJM', 'MICC'], primary: ['equitySectors', 'Consumer Staples'],
    secondary: [['assetClasses', 'Equities']],
    note: 'Food businesses: Freshpet makes pet food, Smucker sells packaged food and pet products, and MICC is Magnum Ice Cream Company, not the former Millicom ticker.',
    sources: ['https://investor.freshpet.com/node/14301/html', 'https://www.jmsmucker.com/assets/jmsmucker/news-stories/corporate-publications/FY24_AnnualReport.pdf', 'https://www.sec.gov/Archives/edgar/data/2071668/000110465926029805/micc-20251231x20f.htm'],
  },
  {
    symbols: ['SAIA', 'R', 'CSX', 'PCAR'], primary: ['equitySectors', 'Industrials'],
    secondary: [['assetClasses', 'Equities']],
    note: 'Freight transportation, logistics, railroads and truck manufacturing are industrial businesses.',
    sources: ['https://investors.ryder.com/about/default.aspx', 'https://investors.paccar.com/financials/quarterly-results/default.aspx', 'https://www.csx.com/'],
  },
  {
    symbols: ['JPM', 'PFSI'], primary: ['equitySectors', 'Financials'],
    secondary: [['assetClasses', 'Equities']],
    note: 'Banking and mortgage origination/servicing businesses. PFSI is a financial-services company, not a mortgage bond fund.',
    sources: ['https://www.jpmorgan.com/about-us', 'https://www.pennymac.com/'],
  },
  {
    symbols: ['TXG', 'RDNT'], primary: ['equitySectors', 'Health Care'],
    secondary: [['assetClasses', 'Equities']],
    note: 'Life-science tools and diagnostic imaging. Technology used by a health-care business does not make it a broad Tech-sector fund.',
    sources: ['https://www.10xgenomics.com/company', 'https://www.radnet.com/about-radnet/news'],
  },
  {
    symbols: ['DKS', 'AMZN'], primary: ['equitySectors', 'Consumer Discretionary'],
    secondary: [['assetClasses', 'Equities']],
    note: 'Retail businesses are classified by their consumer-discretionary sector. Amazon also has a material cloud business; the primary sector remains Consumer Discretionary.',
    sources: ['https://investors.dicks.com/about-us/', 'https://www.ssga.com/us/en/individual/etfs/state-street-consumer-discretionary-select-sector-spdr-etf-xly'],
  },
  {
    symbols: ['EXPGY'], primary: ['equitySectors', 'Industrials'],
    secondary: [['assetClasses', 'Equities']],
    note: 'Experian supplies credit information and analytics as a professional-services business. Credit-related revenues do not make its shares a Credit bond exposure.',
    sources: ['https://www.experianplc.com/what-we-do/our-business-model'],
  },
  {
    symbols: ['IGV'], primary: ['equitySectors', 'Tech'],
    secondary: [['assetClasses', 'Equities'], ['equityStyleFactors', 'Secular Growth']],
    note: 'The fund targets software companies.',
    sources: ['https://www.ishares.com/us/products/239771/'],
  },
  {
    symbols: ['FXH', 'XBI', 'MSOS'], primary: ['equitySectors', 'Health Care'],
    secondary: [['assetClasses', 'Equities']],
    note: 'FXH targets health-care stocks and XBI targets biotech. MSOS is a cannabis strategy whose prospectus specifies concentration in pharmaceuticals, biotechnology and life sciences; it is not a defensive substitute for the broad sector.',
    sources: ['https://www.ftportfolios.com/retail/etf/ETFsummary.aspx?Ticker=FXH', 'https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-biotech-etf-xbi', 'https://www.sec.gov/Archives/edgar/data/1408970/000182912625008584/advisorshares-msos_497k.htm'],
  },
  {
    symbols: ['PRN'], primary: ['equitySectors', 'Industrials'],
    secondary: [['assetClasses', 'Equities'], ['equityStyleFactors', 'Momentum']],
    note: 'Industrials is the mandate; momentum selects stocks within that sector.',
    sources: ['https://www.invesco.com/us-rest/contentdetail?contentId=119307c649400410VgnVCM10000046f1bf0aRCRD'],
  },
  {
    symbols: ['JETS'], primary: ['equitySectors', 'Industrials'],
    secondary: [['assetClasses', 'Equities']],
    note: 'Airlines and aviation businesses are transportation equities, not an oil commodity exposure.',
    sources: ['https://usglobaletfs.com/fund/u-s-global-jets-etf/'],
  },
  {
    symbols: ['JOET'], primary: ['equityStyleFactors', 'Momentum'],
    secondary: [['assetClasses', 'Equities'], ['equityStyleFactors', 'Quality']],
    note: 'The mandate combines momentum and quality. Momentum is the selected primary +EV lens; Quality remains visible as a secondary exposure. Their quad ranks are not averaged.',
    sources: ['https://ir.virtus.com/news/news-details/2020/Virtus-ETFs-Launches-Core-Equity-Exchange-Traded-Fund-Driven-by-the-Investment-Principles-of-Joe-Terranova/default.aspx'],
  },
  {
    symbols: ['LVHI'], primary: ['equityStyleFactors', 'Dividend Yield'],
    secondary: [['assetClasses', 'Equities'], ['equityStyleFactors', 'Low Beta']],
    note: 'International high-dividend equities with a low-volatility screen and currency hedging. Dividend Yield is the primary mandate; Low Beta is a qualitative secondary lens, not a measured beta.',
    sources: ['https://www.franklintempleton.com/investments/options/exchange-traded-funds/products/91481/SINGLCLASS/franklin-international-low-volatility-high-dividend-index-etf/LVHI'],
  },
  {
    symbols: ['EWP'], primary: ['assetClasses', 'Equities'], secondary: [],
    note: 'A diversified Spain equity fund. Country membership alone does not assign a single sector or style.',
    sources: ['https://www.ishares.com/us/products/239683/ishares-msci-spain-capped-etf'],
  },
  {
    symbols: ['EMIF', 'PBD'], primary: ['assetClasses', 'Equities'],
    secondary: [['equitySectors', 'Industrials'], ['equitySectors', 'Utilities']],
    note: 'Diversified thematic equity portfolios spanning several sectors: emerging-market infrastructure or global clean energy. Use broad Equities for the single primary rank; sector overlaps are secondary.',
    sources: ['https://www.ishares.com/us/products/239735/ishares-emerging-markets-infrastructure-etf', 'https://www.invesco.com/us/en/solutions/esg-sustainability.html'],
  },
  {
    symbols: ['RXL', 'LLYX', 'UNHG'], primary: ['equitySectors', 'Health Care'],
    secondary: [['assetClasses', 'Equities'], ['equityStyleFactors', 'Leverage']],
    note: 'Daily leveraged long exposure to the health-care sector, Eli Lilly or UnitedHealth. Rank the underlying sector; leverage changes the payoff, not the sector classification.',
    sources: ['https://www.proshares.com/our-etfs/leveraged-and-inverse/rxl', 'https://www.defianceetfs.com/llyx/', 'https://leverageshares.com/us/etfs/leverage-shares-2x-long-unh-daily-etf/'],
  },
  {
    symbols: ['FAS'], primary: ['equitySectors', 'Financials'],
    secondary: [['assetClasses', 'Equities'], ['equityStyleFactors', 'Leverage']],
    note: 'Daily leveraged long financial-sector exposure.', sources: ['https://www.direxion.com/all-etfs?filter=sector-equity'],
  },
  {
    symbols: ['BRZU'], primary: ['assetClasses', 'Equities'],
    secondary: [['equityStyleFactors', 'Leverage']],
    note: 'Daily leveraged long Brazil equities. The country basket is the primary exposure.',
    sources: ['https://www.direxion.com/all-etfs?filter=sector-equity'],
  },
  {
    symbols: ['YCL'], primary: ['assetClasses', 'FX'], secondary: [],
    note: 'Daily leveraged long yen exposure. This uses the broad FX chart category, which does not distinguish individual currencies.',
    sources: ['https://www.proshares.com/our-etfs/find-leveraged-and-inverse-etfs'],
  },
  {
    symbols: ['UGL'], primary: ['assetClasses', 'Gold'], secondary: [],
    note: 'Daily leveraged long gold exposure. The gold asset-class lens applies, rather than an equity sector.',
    sources: ['https://www.proshares.com/our-etfs/leveraged-and-inverse/ugl?source=CORE_GROWTH'],
  },
  {
    symbols: ['AMDY'], primary: ['equitySectors', 'Tech'],
    secondary: [['assetClasses', 'Equities']],
    note: 'Options provide AMD exposure and income. Tech describes the underlying business; option income and limited upside mean the fund will not reproduce the sector backtest. Distributions are not the Dividend Yield stock factor.',
    sources: ['https://yieldmaxetfs.com/our-etfs/amdy/'],
  },
  {
    symbols: ['ZROZ'], primary: ['fixedIncomeSectors', 'Long Bond'],
    secondary: [['assetClasses', 'Fixed Income']],
    note: 'Long-dated zero-coupon Treasury exposure.',
    sources: ['https://www.sec.gov/Archives/edgar/data/1450011/000119312525249112/d34027d497k.htm'],
  },
  {
    symbols: ['JOJO'], primary: ['assetClasses', 'Fixed Income'], secondary: [],
    note: 'A bond strategy rotating between high-yield credit and Treasuries. Broad Fixed Income is a coarse mandate classification; its changing allocation is not a permanent HY Credit or Long Bond exposure.',
    sources: ['https://atacfunds.com/faq/'],
  },
  {
    symbols: ['UNG', 'SRUUF'], primary: ['assetClasses', 'Commodities'], secondary: [],
    note: 'Natural-gas futures or physical uranium exposure, rather than shares in energy producers.',
    sources: ['https://www.uscfinvestments.com/ung', 'https://www.sprottusa.com/api-update/investment-strategies/physical-commodity-funds/uranium/'],
  },
  {
    symbols: ['DBMF'], primary: ['assetClasses', 'Managed Futures'], secondary: [],
    note: 'A changing long/short futures strategy spanning equities, bonds, currencies and commodities. The four-quad chart does not backtest this strategy; a single static asset-class rank would be misleading.',
    sources: ['https://www.imgp.com/us/fund/US53700T8273-imgp-dbi-managed-futures-strategy-etf/'],
  },
];
