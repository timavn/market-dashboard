const EX_US_VOLUME_PROXY = Object.freeze({
  id: 'exUs',
  label: 'ex-US',
  symbol: 'ACWX',
  name: 'iShares MSCI ACWI ex U.S. ETF',
  issuerUrl: 'https://www.ishares.com/us/products/239594/ishares-msci-acwi-ex-us-etf',
  coverage: 'large- and mid-cap stocks in developed and emerging markets outside the U.S.',
  description: 'IBKR filtered regular-session ACWX ETF volume; a proxy for international-equity fund activity, not total overseas-exchange volume.',
  instrument: Object.freeze({
    symbol: 'ACWX', secType: 'STK', exchange: 'SMART', currency: 'USD', provider: 'ibkr',
  }),
});

module.exports = { EX_US_VOLUME_PROXY };
