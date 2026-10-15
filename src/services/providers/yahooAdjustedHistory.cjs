const { parseYahooChartBars } = require('../../utils/securityRiskMetrics.cjs');

// Shared historical research transport. This never supplies an executable quote.
// Preserve the vendor response and corporate actions for reproducible research.
async function fetchYahooAdjustedHistoryData({
  symbol,
  httpClient = require('axios'),
  period1 = '-2208988800',
  period2 = String(Math.floor(Date.now() / 1000)),
  now = Date.now(),
} = {}) {
  if (typeof symbol !== 'string' || !/^[A-Za-z0-9.^=-]{1,24}$/.test(symbol)) {
    throw new Error('Invalid historical benchmark symbol');
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const params = {
    // An explicit epoch window avoids Yahoo's range=max monthly coarsening.
    period1: String(period1), period2: String(period2), interval: '1d',
    includePrePost: 'false', includeAdjustedClose: 'true', events: 'div,splits',
  };
  const response = await httpClient.get(url, {
    params, timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const chart = response.data?.chart;
  if (chart?.error) throw new Error('Historical price provider rejected the request');
  const result = chart?.result?.[0];
  if (result?.meta?.dataGranularity !== '1d') {
    throw new Error('Historical price provider did not return daily observations');
  }
  const bars = parseYahooChartBars(result, { now });
  if (!bars.some(bar => Number.isFinite(bar.adjustedClose) && bar.adjustedClose > 0)) {
    throw new Error('Historical price provider returned no explicit adjusted prices');
  }
  return {
    bars,
    events: result.events || {},
    rawResponse: response.data,
    sourceUrl: `${url}?${new URLSearchParams(params)}`,
    fetchedAt: new Date().toISOString(),
    yahooSymbol: symbol,
    instrumentType: result.meta?.instrumentType || null,
    exchangeTimezone: result.meta?.exchangeTimezoneName || null,
    regularSession: result.meta?.currentTradingPeriod?.regular || null,
    metadata: result.meta || {},
  };
}

module.exports = { fetchYahooAdjustedHistoryData };
