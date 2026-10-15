export const MARKET_UI = Object.freeze({
  gdp: Object.freeze({ label: 'GDP', fullLabel: 'U.S. real GDP', symbol: 'GDP', precision: 2,
    simplified: true, defaultVenue: 'forecastex', venueIds: Object.freeze(['forecastex']),
    fixedContract: Object.freeze({ venueId: 'forecastex', venueLabel: 'ForecastEx', productCode: 'RGDP' }) }),
  cpi: Object.freeze({
    label: 'CPI',
    fullLabel: 'Headline CPI YoY',
    symbol: 'CPI',
    precision: 1,
    simplified: true,
    defaultVenue: 'kalshi',
    venueIds: Object.freeze(['kalshi']),
    fixedContract: Object.freeze({ venueId: 'kalshi', venueLabel: 'Kalshi', productCode: 'KXCPIYOY' }),
  }),
  sp500: Object.freeze({
    label: 'SP500',
    fullLabel: 'S&P 500',
    symbol: 'SPX',
    precision: 0,
    spotPrecision: 2,
    defaultVenue: 'auto',
    venueIds: Object.freeze(['forecastex']),
    simplified: true,
    chartCalendar: 'us_equity',
    fixedContract: Object.freeze({ venueId: 'forecastex', venueLabel: 'ForecastEx', productCode: 'FES' }),
  }),
  wti: Object.freeze({
    label: 'WTI', fullLabel: 'WTI Oil', symbol: 'WTI', precision: 2, simplified: true, chartCalendar: 'weekday',
  }),
  nasdaq100: Object.freeze({ label: 'Nasdaq', fullLabel: 'Nasdaq-100', symbol: 'NDX', precision: 0, simplified: false }),
  gold: Object.freeze({
    label: 'Gold', fullLabel: 'Gold', symbol: 'GOLD', precision: 1, simplified: true, chartCalendar: 'weekday',
    switchMarketId: 'silver',
    defaultVenue: 'kalshi',
    venueIds: Object.freeze(['kalshi']),
    fixedContract: Object.freeze({ venueId: 'kalshi', venueLabel: 'Kalshi', productCode: 'KXGOLDD' }),
  }),
  silver: Object.freeze({
    label: 'Silver', fullLabel: 'Silver', symbol: 'SILVER', precision: 2, simplified: true, chartCalendar: 'weekday',
    switchMarketId: 'gold',
  }),
  brent: Object.freeze({
    label: 'Brent', fullLabel: 'Brent Oil', symbol: 'BRENT', precision: 2, simplified: true, chartCalendar: 'weekday',
  }),
  bitcoin: Object.freeze({
    label: 'Bitcoin', fullLabel: 'Bitcoin', symbol: 'BTC', precision: 0, spotPrecision: 2, simplified: true,
    chartCalendar: 'continuous', switchMarketId: 'ethereum',
  }),
  ethereum: Object.freeze({
    label: 'Ethereum', fullLabel: 'Ethereum', symbol: 'ETH', precision: 0, spotPrecision: 2, simplified: true,
    chartCalendar: 'continuous', switchMarketId: 'bitcoin',
  }),
});
