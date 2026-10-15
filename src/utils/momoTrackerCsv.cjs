function formatPublishedNumber(value, suffix = '') {
  if (value == null || String(value).trim() === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(2)}${suffix}` : '';
}

function buildMomoTrackerCsvRows(data = {}) {
  return Object.entries(data)
    .map(([ticker, rawInfo], sourceIndex) => {
      const info = rawInfo && typeof rawInfo === 'object' ? rawInfo : {};
      const publishedIndex = Number(info.index);
      return {
        ticker,
        ...info,
        buyTrade: formatPublishedNumber(info.buyTrade),
        sellTrade: formatPublishedNumber(info.sellTrade),
        upside: formatPublishedNumber(info.upside, '%'),
        downside: formatPublishedNumber(info.downside, '%'),
        rangeStatus: info.rangeStatus == null ? '' : String(info.rangeStatus),
        rangeStatusDate: info.rangeStatusDate == null ? '' : String(info.rangeStatusDate),
        index: info.index == null ? '' : info.index,
        _sortIndex: Number.isFinite(publishedIndex) ? publishedIndex : Number.MAX_SAFE_INTEGER,
        _sourceIndex: sourceIndex,
      };
    })
    .sort((left, right) => (
      left._sortIndex - right._sortIndex || left._sourceIndex - right._sourceIndex
    ))
    .map(({ _sortIndex, _sourceIndex, ...row }) => row);
}

module.exports = {
  buildMomoTrackerCsvRows,
  formatPublishedNumber,
};
