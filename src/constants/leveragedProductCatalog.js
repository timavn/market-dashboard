/*
 * Leveraged-product relationships shown in the expanded portfolio card.
 *
 * This is relationship metadata, not quote data.  A product can be listed
 * here when its issuer describes a daily leveraged/inverse objective, but the
 * UI must still obtain a fresh quote separately before showing any executable
 * price, spread, sizing, or order control.
 */

const ISSUER_URLS = Object.freeze({
  direxion: 'https://www.direxion.com/single-stock-etfs',
  proshares: 'https://www.proshares.com/our-etfs/find-leveraged-and-inverse-etfs',
  rex: 'https://www.rexshares.com/t-rex-leveraged-etfs/',
  granite: 'https://graniteshares.com/institutional/us/en-us/fund-map/',
  volatilityShares: 'https://www.volatilityshares.com/etf-product-list.php',
  leverageShares: 'https://leverageshares.com/us/etfs/leverage-shares-2x-long-world-stock-daily-etf/',
  microSectors: 'https://microsectors.com/',
  ubs: 'https://etracs.ubs.com/product/detail/overview/ussymbol/MLPR',
});

const MATCH_LABELS = Object.freeze({
  direct: 'Direct',
  'same-exposure': 'Same exposure',
  proxy: 'Proxy',
});

const makeProduct = ({
  ticker,
  leverage,
  matchType = 'same-exposure',
  reference,
  issuer = 'Issuer',
  issuerUrl,
  description,
}) => Object.freeze({
  ticker,
  leverage,
  matchType,
  matchLabel: MATCH_LABELS[matchType] || 'Proxy',
  reference,
  issuer,
  issuerUrl: issuerUrl || null,
  reset: 'Daily',
  description: description || `Targets ${leverage} the daily performance of ${reference || 'its reference exposure'}.`,
});

const product = (ticker, leverage, matchType, reference, issuer, issuerUrl, description) => makeProduct({
  ticker,
  leverage,
  matchType,
  reference,
  issuer,
  issuerUrl,
  description,
});

const P = Object.freeze({
  // Metals and commodities
  UGLD: product('UGLD', '+2×', 'direct', 'GLD', 'Direxion', 'https://www.direxion.com/product/daily-gold-bull-2x-etf'),
  UGL: product('UGL', '+2×', 'proxy', 'gold futures', 'ProShares', ISSUER_URLS.proshares),
  GLL: product('GLL', '−2×', 'proxy', 'gold futures', 'ProShares', ISSUER_URLS.proshares),
  USLV: product('USLV', '+2×', 'direct', 'SLV', 'Direxion', 'https://www.direxion.com/product/daily-silver-bull-2x-etf'),
  AGQ: product('AGQ', '+2×', 'proxy', 'silver futures', 'ProShares', ISSUER_URLS.proshares),
  ZSL: product('ZSL', '−2×', 'proxy', 'silver futures', 'ProShares', ISSUER_URLS.proshares),
  UCOP: product('UCOP', '+2×', 'proxy', 'copper futures / CPER', 'ProShares', 'https://www.proshares.com/our-etfs/leveraged-and-inverse/ucop'),
  BOIL: product('BOIL', '+2×', 'proxy', 'natural gas futures', 'ProShares', ISSUER_URLS.proshares),
  KOLD: product('KOLD', '−2×', 'proxy', 'natural gas futures', 'ProShares', ISSUER_URLS.proshares),
  UCO: product('UCO', '+2×', 'proxy', 'WTI crude futures', 'ProShares', ISSUER_URLS.proshares),
  SCO: product('SCO', '−2×', 'proxy', 'WTI crude futures', 'ProShares', ISSUER_URLS.proshares),
  UPLT: product('UPLT', '+2×', 'proxy', 'platinum futures', 'ProShares', ISSUER_URLS.proshares),

  // Single-stock products
  AAPU: product('AAPU', '+2×', 'direct', 'AAPL', 'Direxion', ISSUER_URLS.direxion),
  AAPD: product('AAPD', '−1×', 'direct', 'AAPL', 'Direxion', ISSUER_URLS.direxion),
  AAPB: product('AAPB', '+2×', 'direct', 'AAPL', 'GraniteShares', ISSUER_URLS.granite),
  AMZU: product('AMZU', '+2×', 'direct', 'AMZN', 'Direxion', ISSUER_URLS.direxion),
  AMZD: product('AMZD', '−1×', 'direct', 'AMZN', 'Direxion', ISSUER_URLS.direxion),
  AMZZ: product('AMZZ', '+2×', 'direct', 'AMZN', 'GraniteShares', ISSUER_URLS.granite),
  GGLL: product('GGLL', '+2×', 'direct', 'GOOGL', 'Direxion', ISSUER_URLS.direxion),
  GGLS: product('GGLS', '−1×', 'direct', 'GOOGL', 'Direxion', ISSUER_URLS.direxion),
  GOOX: product('GOOX', '+2×', 'direct', 'GOOGL', 'REX Shares', ISSUER_URLS.rex),
  METU: product('METU', '+2×', 'direct', 'META', 'Direxion', ISSUER_URLS.direxion),
  METD: product('METD', '−1×', 'direct', 'META', 'Direxion', ISSUER_URLS.direxion),
  MSFU: product('MSFU', '+2×', 'direct', 'MSFT', 'Direxion', ISSUER_URLS.direxion),
  MSFD: product('MSFD', '−1×', 'direct', 'MSFT', 'Direxion', ISSUER_URLS.direxion),
  MSFL: product('MSFL', '+2×', 'direct', 'MSFT', 'GraniteShares', ISSUER_URLS.granite),
  NFXL: product('NFXL', '+2×', 'direct', 'NFLX', 'Direxion', ISSUER_URLS.direxion),
  NFXS: product('NFXS', '−1×', 'direct', 'NFLX', 'Direxion', ISSUER_URLS.direxion),
  NFLU: product('NFLU', '+2×', 'direct', 'NFLX', 'REX Shares', ISSUER_URLS.rex),
  NVDU: product('NVDU', '+2×', 'direct', 'NVDA', 'Direxion', ISSUER_URLS.direxion),
  NVDD: product('NVDD', '−1×', 'direct', 'NVDA', 'Direxion', ISSUER_URLS.direxion),
  NVDL: product('NVDL', '+2×', 'direct', 'NVDA', 'GraniteShares', ISSUER_URLS.granite),
  NVDQ: product('NVDQ', '−2×', 'direct', 'NVDA', 'REX Shares', ISSUER_URLS.rex),
  ORCU: product('ORCU', '+2×', 'direct', 'ORCL', 'Direxion', ISSUER_URLS.direxion),
  ORCS: product('ORCS', '−1×', 'direct', 'ORCL', 'Direxion', ISSUER_URLS.direxion),
  ORCZ: product('ORCZ', '−2×', 'direct', 'ORCL', 'Tradr', 'https://www.tradretfs.com/etfs'),
  TSLL: product('TSLL', '+2×', 'direct', 'TSLA', 'Direxion', ISSUER_URLS.direxion),
  TSLS: product('TSLS', '−1×', 'direct', 'TSLA', 'Direxion', ISSUER_URLS.direxion),
  TSLT: product('TSLT', '+2×', 'direct', 'TSLA', 'REX Shares', ISSUER_URLS.rex),
  TSLZ: product('TSLZ', '−2×', 'direct', 'TSLA', 'REX Shares', ISSUER_URLS.rex),

  // Index, country, sector, and rates products
  UPRO: product('UPRO', '+3×', 'direct', 'SPY / S&P 500', 'ProShares', ISSUER_URLS.proshares),
  SSO: product('SSO', '+2×', 'direct', 'SPY / S&P 500', 'ProShares', ISSUER_URLS.proshares),
  SPXU: product('SPXU', '−3×', 'direct', 'SPY / S&P 500', 'ProShares', ISSUER_URLS.proshares),
  QLD: product('QLD', '+2×', 'direct', 'QQQ', 'ProShares', ISSUER_URLS.proshares),
  TQQQ: product('TQQQ', '+3×', 'direct', 'QQQ', 'ProShares', ISSUER_URLS.proshares),
  SQQQ: product('SQQQ', '−3×', 'direct', 'QQQ', 'ProShares', ISSUER_URLS.proshares),
  UWM: product('UWM', '+2×', 'direct', 'IWM / Russell 2000', 'ProShares', ISSUER_URLS.proshares),
  URTY: product('URTY', '+3×', 'direct', 'IWM / Russell 2000', 'ProShares', ISSUER_URLS.proshares),
  SRTY: product('SRTY', '−3×', 'direct', 'IWM / Russell 2000', 'ProShares', ISSUER_URLS.proshares),
  URSP: product('URSP', '+2×', 'direct', 'RSP', 'ProShares', ISSUER_URLS.proshares),
  WLDU: product('WLDU', '+2×', 'direct', 'VT', 'Leverage Shares', ISSUER_URLS.leverageShares),
  UYG: product(
    'UYG',
    '+2×',
    'proxy',
    'Financial Select Sector Index',
    'ProShares',
    'https://www.proshares.com/our-etfs/leveraged-and-inverse/uyg',
  ),
  FAS: product(
    'FAS',
    '+3×',
    'same-exposure',
    'Financial Select Sector Index',
    'Direxion',
    'https://www.direxion.com/product/daily-financial-bull-bear-3x-etfs',
  ),
  FAZ: product(
    'FAZ',
    '−3×',
    'same-exposure',
    'Financial Select Sector Index',
    'Direxion',
    'https://www.direxion.com/product/daily-financial-bull-bear-3x-etfs',
  ),
  EURL: product('EURL', '+3×', 'proxy', 'European equities', 'Direxion', ISSUER_URLS.direxion),
  EPV: product('EPV', '−2×', 'proxy', 'European equities', 'ProShares', ISSUER_URLS.proshares),
  EDC: product('EDC', '+3×', 'proxy', 'emerging markets', 'Direxion', ISSUER_URLS.direxion),
  EDZ: product('EDZ', '−3×', 'proxy', 'emerging markets', 'Direxion', ISSUER_URLS.direxion),
  MEXX: product('MEXX', '+3×', 'direct', 'EWW / Mexico', 'Direxion', ISSUER_URLS.direxion),
  KORU: product('KORU', '+3×', 'direct', 'EWY / South Korea', 'Direxion', ISSUER_URLS.direxion),
  INDL: product('INDL', '+2×', 'direct', 'INDA / India', 'Direxion', ISSUER_URLS.direxion),
  BRZU: product('BRZU', '+2×', 'direct', 'EWZ / Brazil', 'Direxion', ISSUER_URLS.direxion),
  UBR: product('UBR', '+2×', 'direct', 'EWZ / Brazil', 'ProShares', ISSUER_URLS.proshares),
  BZQ: product('BZQ', '−2×', 'direct', 'EWZ / Brazil', 'ProShares', ISSUER_URLS.proshares),
  XPP: product('XPP', '+2×', 'direct', 'FXI / China', 'ProShares', ISSUER_URLS.proshares),
  YINN: product('YINN', '+3×', 'proxy', 'FXI / China', 'Direxion', ISSUER_URLS.direxion),
  FXP: product('FXP', '−2×', 'direct', 'FXI / China', 'ProShares', ISSUER_URLS.proshares),
  YANG: product('YANG', '−3×', 'proxy', 'FXI / China', 'Direxion', ISSUER_URLS.direxion),
  EZJ: product('EZJ', '+2×', 'direct', 'EWJ / Japan', 'ProShares', ISSUER_URLS.proshares),
  EWV: product('EWV', '−2×', 'direct', 'EWJ / Japan', 'ProShares', ISSUER_URLS.proshares),
  UPV: product('UPV', '+2×', 'direct', 'VGK / Europe', 'ProShares', ISSUER_URLS.proshares),
  GDXU: product('GDXU', '+3×', 'proxy', 'GDX / gold miners', 'MicroSectors', ISSUER_URLS.microSectors),
  GDXD: product('GDXD', '−3×', 'proxy', 'GDX / gold miners', 'MicroSectors', ISSUER_URLS.microSectors),
  NUGT: product('NUGT', '+2×', 'proxy', 'gold miners', 'Direxion', ISSUER_URLS.direxion),
  DUST: product('DUST', '−2×', 'proxy', 'gold miners', 'Direxion', ISSUER_URLS.direxion),
  DFEN: product('DFEN', '+3×', 'same-exposure', 'ITA / aerospace and defense', 'Direxion', ISSUER_URLS.direxion),
  NAIL: product('NAIL', '+3×', 'same-exposure', 'ITB / homebuilders', 'Direxion', ISSUER_URLS.direxion),
  SOXL: product('SOXL', '+3×', 'proxy', 'SMH / semiconductors', 'Direxion', ISSUER_URLS.direxion),
  SOXS: product('SOXS', '−3×', 'proxy', 'SMH / semiconductors', 'Direxion', ISSUER_URLS.direxion),
  URAA: product('URAA', '+2×', 'proxy', 'URA / uranium industry', 'Direxion', 'https://www.direxion.com/product/daily-uranium-industry-bull-2x-etf'),
  TECL: product('TECL', '+3×', 'proxy', 'XLK / technology', 'Direxion', ISSUER_URLS.direxion),
  TECS: product('TECS', '−3×', 'proxy', 'XLK / technology', 'Direxion', ISSUER_URLS.direxion),
  ROM: product('ROM', '+2×', 'proxy', 'XLK / technology', 'ProShares', ISSUER_URLS.proshares),
  REW: product('REW', '−2×', 'proxy', 'XLK / technology', 'ProShares', ISSUER_URLS.proshares),
  LTL: product('LTL', '+2×', 'same-exposure', 'XLC / communications', 'ProShares', ISSUER_URLS.proshares),
  UYM: product('UYM', '+2×', 'same-exposure', 'XLB / materials', 'ProShares', ISSUER_URLS.proshares),
  SMN: product('SMN', '−2×', 'same-exposure', 'XLB / materials', 'ProShares', ISSUER_URLS.proshares),
  ERX: product('ERX', '+2×', 'same-exposure', 'XLE / energy', 'Direxion', ISSUER_URLS.direxion),
  ERY: product('ERY', '−2×', 'same-exposure', 'XLE / energy', 'Direxion', ISSUER_URLS.direxion),
  GUSH: product('GUSH', '+2×', 'proxy', 'XOP / oil and gas E&P', 'Direxion', ISSUER_URLS.direxion),
  DRIP: product('DRIP', '−2×', 'proxy', 'XOP / oil and gas E&P', 'Direxion', ISSUER_URLS.direxion),
  UXI: product('UXI', '+2×', 'same-exposure', 'XLI / industrials', 'ProShares', ISSUER_URLS.proshares),
  SIJ: product('SIJ', '−2×', 'same-exposure', 'XLI / industrials', 'ProShares', ISSUER_URLS.proshares),
  UGE: product('UGE', '+2×', 'same-exposure', 'XLP / staples', 'ProShares', ISSUER_URLS.proshares),
  SZK: product('SZK', '−2×', 'same-exposure', 'XLP / staples', 'ProShares', ISSUER_URLS.proshares),
  URE: product('URE', '+2×', 'same-exposure', 'XLRE / real estate', 'ProShares', ISSUER_URLS.proshares),
  SRS: product('SRS', '−2×', 'same-exposure', 'XLRE / real estate', 'ProShares', ISSUER_URLS.proshares),
  DRN: product('DRN', '+3×', 'same-exposure', 'XLRE / real estate', 'Direxion', ISSUER_URLS.direxion),
  DRV: product('DRV', '−3×', 'same-exposure', 'XLRE / real estate', 'Direxion', ISSUER_URLS.direxion),
  UPW: product('UPW', '+2×', 'same-exposure', 'XLU / utilities', 'ProShares', ISSUER_URLS.proshares),
  SDP: product('SDP', '−3×', 'same-exposure', 'XLU / utilities', 'ProShares', ISSUER_URLS.proshares),
  UTSL: product('UTSL', '+3×', 'same-exposure', 'XLU / utilities', 'Direxion', ISSUER_URLS.direxion),
  RXL: product('RXL', '+2×', 'same-exposure', 'XLV / healthcare', 'ProShares', ISSUER_URLS.proshares),
  RXD: product('RXD', '−2×', 'same-exposure', 'XLV / healthcare', 'ProShares', ISSUER_URLS.proshares),
  CURE: product('CURE', '+3×', 'same-exposure', 'XLV / healthcare', 'Direxion', ISSUER_URLS.direxion),
  UCC: product('UCC', '+2×', 'same-exposure', 'XLY / discretionary', 'ProShares', ISSUER_URLS.proshares),
  SCC: product('SCC', '−2×', 'same-exposure', 'XLY / discretionary', 'ProShares', ISSUER_URLS.proshares),
  WANT: product('WANT', '+3×', 'same-exposure', 'XLY / discretionary', 'Direxion', ISSUER_URLS.direxion),
  UST: product('UST', '+2×', 'direct', 'IEF', 'ProShares', ISSUER_URLS.proshares),
  TBX: product('TBX', '−1×', 'direct', 'IEF', 'ProShares', ISSUER_URLS.proshares),
  PST: product('PST', '−2×', 'direct', 'IEF', 'ProShares', ISSUER_URLS.proshares),
  UBT: product('UBT', '+2×', 'direct', 'TLT', 'ProShares', ISSUER_URLS.proshares),
  TBF: product('TBF', '−1×', 'direct', 'TLT', 'ProShares', ISSUER_URLS.proshares),
  TBT: product('TBT', '−2×', 'direct', 'TLT', 'ProShares', ISSUER_URLS.proshares),
  TYD: product('TYD', '+3×', 'proxy', 'UST10Y / 7-10 year Treasuries', 'Direxion', ISSUER_URLS.direxion),
  TYO: product('TYO', '−3×', 'proxy', 'UST10Y / 7-10 year Treasuries', 'Direxion', ISSUER_URLS.direxion),
  TMF: product('TMF', '+3×', 'proxy', 'UST30Y / 20+ year Treasuries', 'Direxion', ISSUER_URLS.direxion),
  TMV: product('TMV', '−3×', 'proxy', 'UST30Y / 20+ year Treasuries', 'Direxion', ISSUER_URLS.direxion),
  UJB: product('UJB', '+2×', 'direct', 'HYG', 'ProShares', ISSUER_URLS.proshares),
  SJB: product('SJB', '−1×', 'direct', 'HYG', 'ProShares', ISSUER_URLS.proshares),
  ULE: product('ULE', '+2×', 'direct', 'FXE / EUR', 'ProShares', ISSUER_URLS.proshares),
  EUO: product('EUO', '−2×', 'direct', 'FXE / EUR', 'ProShares', ISSUER_URLS.proshares),
  YCL: product('YCL', '+2×', 'proxy', 'FXY / yen', 'ProShares', ISSUER_URLS.proshares),
  YCS: product('YCS', '−2×', 'proxy', 'FXY / yen', 'ProShares', ISSUER_URLS.proshares),

  // Digital assets and crypto-linked equities
  BTCU: product('BTCU', '+2×', 'direct', 'IBIT / bitcoin', 'Direxion', 'https://www.direxion.com/product/daily-bitcoin-bull-2x-etf'),
  BITU: product('BITU', '+2×', 'direct', 'bitcoin', 'ProShares', ISSUER_URLS.proshares),
  SBIT: product('SBIT', '−2×', 'direct', 'bitcoin', 'ProShares', ISSUER_URLS.proshares),
  EVMU: product('EVMU', '+2×', 'direct', 'ETHA / ether', 'Direxion', 'https://www.direxion.com/product/daily-ether-bull-2x-etf'),
  ETHT: product('ETHT', '+2×', 'direct', 'ether', 'ProShares', ISSUER_URLS.proshares),
  ETHD: product('ETHD', '−2×', 'direct', 'ether', 'ProShares', ISSUER_URLS.proshares),
  SLON: product('SLON', '+2×', 'proxy', 'SOL / solana', 'ProShares', ISSUER_URLS.proshares),
  UXRP: product('UXRP', '+2×', 'proxy', 'XRP', 'ProShares', ISSUER_URLS.proshares),
  LMBO: product('LMBO', '+2×', 'proxy', 'crypto industry', 'Direxion', ISSUER_URLS.direxion),
  COIA: product('COIA', '+2×', 'direct', 'COIN', 'ProShares', ISSUER_URLS.proshares),
  CONX: product('CONX', '+2×', 'direct', 'COIN', 'Direxion', ISSUER_URLS.direxion),
  CONI: product('CONI', '−2×', 'direct', 'COIN', 'GraniteShares', ISSUER_URLS.granite),
  CCUP: product('CCUP', '+2×', 'direct', 'CRCL', 'REX Shares', ISSUER_URLS.rex),
  CRCD: product('CRCD', '−2×', 'direct', 'CRCL', 'REX Shares', ISSUER_URLS.rex),
  MSTU: product('MSTU', '+2×', 'direct', 'MSTR', 'REX Shares', ISSUER_URLS.rex),
  MSTZ: product('MSTZ', '−2×', 'direct', 'MSTR', 'REX Shares', ISSUER_URLS.rex),
  MRAL: product('MRAL', '+2×', 'direct', 'MARA', 'GraniteShares', 'https://graniteshares.com/etfs/mral/'),
  RIOX: product('RIOX', '+2×', 'direct', 'RIOT', 'Defiance ETFs', 'https://www.defianceetfs.com/riox/'),
  BMNU: product('BMNU', '+2×', 'direct', 'BMNR', 'REX Shares', ISSUER_URLS.rex),
  BMNZ: product('BMNZ', '−2×', 'direct', 'BMNR', 'Defiance ETFs', 'https://www.defianceetfs.com/'),
  MLPR: product('MLPR', '+1.5×', 'proxy', 'MLPX / MLP infrastructure', 'UBS', ISSUER_URLS.ubs, 'Targets 1.5× the quarterly performance of the Alerian MLP Index.'),
  UVIX: product('UVIX', '+2×', 'proxy', 'VIX futures', 'Volatility Shares', ISSUER_URLS.volatilityShares, 'Targets 2× the daily performance of VIX futures.'),
  SVIX: product('SVIX', '−1×', 'proxy', 'VIX futures', 'Volatility Shares', ISSUER_URLS.volatilityShares, 'Targets −1× the daily performance of VIX futures.'),
});

const catalog = {};

const assign = (symbols, products) => {
  symbols.forEach((symbol) => {
    catalog[symbol] = Object.freeze(products.map((productTicker) => P[productTicker]).filter(Boolean));
  });
};

assign(['AAAU', 'GLD', 'GOLD'], ['UGLD', 'UGL', 'GLL']);
assign(['SILVER', 'SLV'], ['USLV', 'AGQ', 'ZSL']);
assign(['COPPER'], ['UCOP']);
assign(['NATGAS'], ['BOIL', 'KOLD']);
assign(['BRENT', 'WTIC'], ['UCO', 'SCO']);
assign(['PPLT'], ['UPLT']);

assign(['AAPL'], ['AAPU', 'AAPB', 'AAPD']);
assign(['AMZN'], ['AMZU', 'AMZZ', 'AMZD']);
assign(['GOOGL'], ['GGLL', 'GOOX', 'GGLS']);
assign(['META'], ['METU', 'METD']);
assign(['MSFT'], ['MSFU', 'MSFL', 'MSFD']);
assign(['NFLX'], ['NFXL', 'NFLU', 'NFXS']);
assign(['NVDA'], ['NVDU', 'NVDL', 'NVDQ']);
assign(['ORCL'], ['ORCU', 'ORCS', 'ORCZ']);
assign(['TSLA'], ['TSLL', 'TSLT', 'TSLZ']);

assign(['SPX', 'SPY'], ['SSO', 'UPRO', 'SPXU']);
assign(['QQQ', 'COMPQ'], ['QLD', 'TQQQ', 'SQQQ']);
assign(['IWM', 'RUT'], ['UWM', 'URTY', 'SRTY']);
assign(['RSP'], ['URSP']);
assign(['VT'], ['WLDU']);
assign(['XLF'], ['FAS', 'UYG', 'FAZ']);
assign(['DAX', 'EWG', 'EWQ', 'EWU', 'VGK'], ['UPV', 'EURL', 'EPV']);
assign(['EMXC'], ['EDC', 'EDZ']);
assign(['EWH', 'SSEC'], ['XPP', 'YINN', 'FXP']);
assign(['EWJ', 'NIKK'], ['EZJ', 'EWV']);
assign(['EWW'], ['MEXX']);
assign(['EWY'], ['KORU']);
assign(['EWZ'], ['BRZU', 'UBR', 'BZQ']);
assign(['FXI'], ['XPP', 'YINN', 'FXP']);
assign(['GDX'], ['GDXU', 'NUGT', 'GDXD']);
assign(['HEFA', 'ILF'], ['UPV', 'EPV']);
assign(['INDA'], ['INDL']);
assign(['ITA'], ['DFEN']);
assign(['ITB'], ['NAIL']);
assign(['SMH'], ['SOXL', 'SOXS']);
assign(['URA'], ['URAA']);
assign(['VIX'], ['UVIX', 'SVIX']);
assign(['XLB'], ['UYM', 'SMN']);
assign(['XLC'], ['LTL']);
assign(['XLE'], ['ERX', 'ERY']);
assign(['XLI'], ['UXI', 'SIJ']);
assign(['XLK'], ['TECL', 'ROM', 'TECS']);
assign(['XLP'], ['UGE', 'SZK']);
assign(['XLRE'], ['URE', 'DRN', 'SRS']);
assign(['XLU'], ['UPW', 'UTSL', 'SDP']);
assign(['XLV'], ['RXL', 'CURE', 'RXD']);
assign(['XLY'], ['UCC', 'WANT', 'SCC']);
assign(['XME'], ['GDXU', 'GDXD']);
assign(['XOP'], ['GUSH', 'ERX', 'DRIP']);
assign(['MLPX'], ['MLPR']);

assign(['HYG'], ['UJB', 'SJB']);
assign(['IEF'], ['UST', 'TBX', 'PST']);
assign(['TLT'], ['UBT', 'TBT', 'TBF']);
assign(['UST10Y'], ['TYD', 'TYO']);
assign(['UST30Y'], ['TMF', 'TMV']);
assign(['EUR/USD', 'FXE'], ['ULE', 'EUO']);
assign(['FXY', 'USD/YEN'], ['YCL', 'YCS']);

assign(['BITCOIN', 'BTC', 'IBIT'], ['BTCU', 'BITU', 'SBIT']);
assign(['ETH', 'ETHA'], ['EVMU', 'ETHT', 'ETHD']);
assign(['SOL'], ['SLON']);
assign(['XRP'], ['UXRP']);
assign(['BLOK'], ['LMBO']);
assign(['COIN'], ['COIA', 'CONX', 'CONI']);
assign(['CRCL'], ['CCUP', 'CRCD']);
assign(['MSTR'], ['MSTU', 'MSTZ']);
assign(['MARA'], ['MRAL']);
assign(['RIOT'], ['RIOX']);
assign(['BMNR'], ['BMNU', 'BMNZ']);

// IAK is not in SECURITIES_LIST, but it appears in live portfolio holdings.
// Keep its broad-financial alternatives available for the same card surface.
assign(['IAK'], ['UYG', 'FAS', 'FAZ']);

// Keep an explicit empty entry for universe members without a defensible
// current U.S.-listed daily leveraged/inverse match.  The expanded card can
// then distinguish "known, no match" from an unmapped security symbol.
assign([
  'BKLN', 'BNDX', 'CWB', 'EMB', 'IGOV', 'LQD', 'MBB', 'PFF', 'SHY', 'TIP', 'UST2Y',
  'EWA', 'EWC', 'EWS', 'EZA', 'MTUM', 'USMV', 'VYMI',
  'CAD/USD', 'FXB', 'FXF', 'GBP/USD', 'USD', 'UUP',
  'CANE', 'CORN', 'DBA', 'JO', 'NIB', 'PDBC', 'WEAT',
  'AVAX',
], []);

const BASE_MATCH_OVERRIDES = Object.freeze({
  AAAU: Object.freeze({ UGLD: 'same-exposure' }),
  GOLD: Object.freeze({ UGLD: 'same-exposure' }),
  SILVER: Object.freeze({ USLV: 'same-exposure' }),
  'EUR/USD': Object.freeze({ ULE: 'same-exposure', EUO: 'same-exposure' }),
  BITCOIN: Object.freeze({ BTCU: 'same-exposure', BITU: 'same-exposure', SBIT: 'same-exposure' }),
  BTC: Object.freeze({ BTCU: 'same-exposure', BITU: 'same-exposure', SBIT: 'same-exposure' }),
  ETH: Object.freeze({ EVMU: 'same-exposure' }),
  DAX: Object.freeze({ UPV: 'proxy', EURL: 'proxy', EPV: 'proxy' }),
  EWG: Object.freeze({ UPV: 'proxy', EURL: 'proxy', EPV: 'proxy' }),
  EWQ: Object.freeze({ UPV: 'proxy', EURL: 'proxy', EPV: 'proxy' }),
  EWU: Object.freeze({ UPV: 'proxy', EURL: 'proxy', EPV: 'proxy' }),
  VGK: Object.freeze({ UPV: 'same-exposure', EURL: 'same-exposure', EPV: 'same-exposure' }),
  EMXC: Object.freeze({ EDC: 'proxy', EDZ: 'proxy' }),
  EWH: Object.freeze({ XPP: 'proxy', YINN: 'proxy', FXP: 'proxy' }),
  SSEC: Object.freeze({ XPP: 'proxy', YINN: 'proxy', FXP: 'proxy' }),
  NIKK: Object.freeze({ EZJ: 'proxy', EWV: 'proxy' }),
  HEFA: Object.freeze({ UPV: 'proxy', EPV: 'proxy' }),
  ILF: Object.freeze({ UPV: 'proxy', EPV: 'proxy' }),
  IAK: Object.freeze({ UYG: 'proxy', FAS: 'proxy', FAZ: 'proxy' }),
});

const BASE_FIT_OVERRIDES = Object.freeze({
  IAK: Object.freeze({
    UYG: Object.freeze({
      fitLabel: 'Loose proxy',
      fitNote: 'Broad financials; insurance is only a minority of this benchmark.',
      overlapReferenceSymbol: 'XLF',
    }),
    FAS: Object.freeze({
      fitLabel: 'Loose proxy',
      fitNote: 'Broad financials; insurance is only a minority of this benchmark.',
      overlapReferenceSymbol: 'XLF',
    }),
    FAZ: Object.freeze({
      fitLabel: 'Loose proxy',
      fitNote: 'Broad financials; insurance is only a minority of this benchmark.',
      overlapReferenceSymbol: 'XLF',
    }),
  }),
});

export const LEVERAGED_PRODUCT_CATALOG = Object.freeze(catalog);

export const getLeveragedProducts = (symbol) => {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const products = LEVERAGED_PRODUCT_CATALOG[normalizedSymbol] || [];
  const overrides = BASE_MATCH_OVERRIDES[normalizedSymbol] || {};
  return products.map((productItem) => {
    const matchType = overrides[productItem.ticker];
    const fitOverride = BASE_FIT_OVERRIDES[normalizedSymbol]?.[productItem.ticker] || null;
    if ((!matchType || matchType === productItem.matchType) && !fitOverride) return productItem;
    return Object.freeze({
      ...productItem,
      ...(matchType ? {
        matchType,
        matchLabel: MATCH_LABELS[matchType] || 'Proxy',
      } : {}),
      ...(fitOverride || {}),
    });
  });
};

export const getLeveragedProduct = (symbol, productTicker) => (
  getLeveragedProducts(symbol).find((productItem) => productItem.ticker === String(productTicker || '').trim().toUpperCase()) || null
);

export const leveragedCatalogSymbols = () => Object.keys(LEVERAGED_PRODUCT_CATALOG);
