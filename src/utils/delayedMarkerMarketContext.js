import marketBackdropCatalog from '../constants/marketBackdropCatalog.json';
import {
  GLOBAL_MARKETS,
  HK_MARKET_HOLIDAYS,
  JP_MARKET_HOLIDAYS,
  UK_MARKET_HOLIDAYS,
} from '../constants/globalMarkets';

const clock = ({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
const clockProfile = (id, marketCalendar, marketHolidays) => {
  const market = GLOBAL_MARKETS.find((entry) => entry.id === id);
  return Object.freeze({
    marketTimeZone: market.timezone,
    marketOpenTime: clock(market.marketOpen),
    marketCloseTime: clock(market.marketClose),
    marketCalendar,
    marketHolidays,
  });
};

const PROFILES = Object.freeze({
  US: clockProfile('nyc', 'US'),
  UK: clockProfile('lon', 'weekday', UK_MARKET_HOLIDAYS),
  JP: clockProfile('tyo', 'weekday', JP_MARKET_HOLIDAYS),
  HK: clockProfile('hkg', 'weekday', HK_MARKET_HOLIDAYS),
  CN: Object.freeze({ marketTimeZone: 'Asia/Shanghai', marketOpenTime: '09:30', marketCloseTime: '15:00', marketCalendar: 'weekday' }),
  IN: Object.freeze({ marketTimeZone: 'Asia/Kolkata', marketOpenTime: '09:15', marketCloseTime: '15:30', marketCalendar: 'weekday' }),
  KR: Object.freeze({ marketTimeZone: 'Asia/Seoul', marketOpenTime: '09:00', marketCloseTime: '15:30', marketCalendar: 'weekday' }),
  TW: Object.freeze({ marketTimeZone: 'Asia/Taipei', marketOpenTime: '09:00', marketCloseTime: '13:30', marketCalendar: 'weekday' }),
  AU: Object.freeze({ marketTimeZone: 'Australia/Sydney', marketOpenTime: '10:00', marketCloseTime: '16:00', marketCalendar: 'weekday' }),
  ID: Object.freeze({ marketTimeZone: 'Asia/Jakarta', marketOpenTime: '09:00', marketCloseTime: '16:00', marketCalendar: 'weekday' }),
  MY: Object.freeze({ marketTimeZone: 'Asia/Kuala_Lumpur', marketOpenTime: '09:00', marketCloseTime: '17:00', marketCalendar: 'weekday' }),
  CRYPTO: Object.freeze({ continuous: true }),
  // Futures, FX and the dollar index trade Sunday evening to Friday 17:00 New York; they only stop for the weekend.
  WEEKLY: Object.freeze({ marketTimeZone: 'America/New_York', marketSchedule: 'weekly' }),
});

const WEEKLY_SYMBOLS = new Set(['DXY', 'USD', 'DX-Y.NYB']);
const CURRENCIES = 'USD|EUR|JPY|GBP|CHF|CAD|CNY|CNH|AUD|NZD|MXN|SEK|NOK|HKD|SGD|KRW|INR|BRL|ZAR';
const isWeeklyMarketSymbol = (symbol) => WEEKLY_SYMBOLS.has(symbol) || /=[XF]$/.test(symbol)
  || new RegExp(`^(?:${CURRENCIES})/?(?:${CURRENCIES})$`).test(symbol);

const SYMBOL_PROFILES = Object.freeze({
  N225: 'JP', HSI: 'HK', CSI300: 'CN', SSEC: 'CN', NIFTY50: 'IN',
  KOSPI: 'KR', TAIEX: 'TW', AXJO: 'AU', JKSE: 'ID', KLSE: 'MY',
  JGB10Y: 'JP', GILT10Y: 'UK', ACGB10Y: 'AU', KTB10Y: 'KR',
});

const instrumentProfiles = new Map();
marketBackdropCatalog.forEach((group) => group.rows.forEach((row) => {
  const profileId = row.provider?.secType === 'CRYPTO' ? 'CRYPTO'
    : row.provider?.secType === 'FUT' ? 'WEEKLY'
      : SYMBOL_PROFILES[row.symbol] || (group.id === 'europe' ? 'UK' : 'US');
  [row.symbol, row.provider?.yahooSymbol, row.provider?.ibkrSymbol].filter(Boolean)
    .forEach((symbol) => instrumentProfiles.set(symbol.toUpperCase(), PROFILES[profileId]));
}));

export const sourceMarketSessionDate = (value) => {
  const date = /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.000)?)?Z)?$/.exec(String(value || ''));
  return date?.[1] || null;
};

/** Session metadata is presentation context; it never changes a provider observation. */
export const delayedMarkerMarketContext = (row, instrument = {}) => {
  const session = row?.marketSession && typeof row.marketSession === 'object' ? row.marketSession : {};
  const symbol = String(row?.symbol || instrument?.symbol || '').toUpperCase();
  const profile = instrumentProfiles.get(symbol)
    || (isWeeklyMarketSymbol(symbol) || isWeeklyMarketSymbol(String(row?.name || '').toUpperCase()) ? PROFILES.WEEKLY : PROFILES.US);
  const calendar = row?.marketCalendar || row?.calendar || session.calendar || instrument?.chartCalendar;
  return {
    ...profile,
    marketSessionDate: row?.marketSessionDate || row?.sessionDate || row?.quoteSessionDate
      || row?.marketDate || session.sessionDate || session.date || null,
    marketTimeZone: row?.marketTimeZone || row?.exchangeTimezoneName || session.timeZone
      || row?.timeZone || profile.marketTimeZone,
    marketOpenTime: row?.marketOpenTime || session.openTime || profile.marketOpenTime,
    marketCloseTime: row?.marketCloseTime || session.closeTime || profile.marketCloseTime,
    marketSchedule: profile.marketSchedule,
    marketCalendar: calendar === 'us_equity' ? 'US' : calendar || profile.marketCalendar,
    marketHolidays: row?.marketHolidays || session.holidays || profile.marketHolidays,
    continuous: row?.continuous === true || session.continuous === true
      || calendar === 'continuous' || String(row?.secType || instrument?.secType || '').toUpperCase() === 'CRYPTO'
      || profile.continuous === true,
  };
};
