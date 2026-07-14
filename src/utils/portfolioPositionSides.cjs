function getLongShortPositionSnapshot(holdings) {
  if (!Array.isArray(holdings)) {
    return { longs: [], shorts: [], longCount: 0, shortCount: 0 };
  }

  const longs = [];
  const shorts = [];

  holdings.forEach((holding) => {
    const quantity = parseFloat(holding?.quantity) || 0;
    const marketValue = parseFloat(holding?.marketValue) || 0;

    if (marketValue > 0) {
      longs.push(holding);
    } else if (marketValue < 0) {
      shorts.push(holding);
    } else if (quantity > 0) {
      longs.push(holding);
    } else if (quantity < 0) {
      shorts.push(holding);
    }
  });

  return {
    longs,
    shorts,
    longCount: longs.length,
    shortCount: shorts.length,
  };
}

module.exports = {
  getLongShortPositionSnapshot,
};
