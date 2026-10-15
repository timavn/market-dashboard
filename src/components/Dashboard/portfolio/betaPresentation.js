// Explanation text only. The parent accepts the historical Beta input and
// supplies formatted equation operands/date; this helper never calculates Beta.
export function buildBetaVerification({
  symbol,
  beta,
  covarianceLabel = null,
  benchmarkVarianceLabel = null,
  asOfLabel,
}) {
  return {
    symbol,
    metric: 'Beta',
    formula: `Beta = covariance of ${symbol} and ${beta?.benchmark || 'SPY'} returns ÷ variance of ${beta?.benchmark || 'SPY'} returns`,
    equation: beta
      ? covarianceLabel !== null && benchmarkVarianceLabel !== null
        ? `${covarianceLabel} ÷ ${benchmarkVarianceLabel} = ${Number(beta.value).toFixed(2)}`
        : `${beta.observations || beta.windowSessions || 252} aligned daily returns = ${Number(beta.value).toFixed(2)}`
      : 'Not calculated — verified aligned return history is unavailable.',
    result: beta ? Number(beta.value).toFixed(2) : 'Unavailable',
    takeaway: [
      `Beta shows how sensitive ${symbol} has been to moves in ${beta?.benchmark || 'SPY'}, the stock-market benchmark.`,
      beta
        ? Math.abs(Number(beta.value)) < 0.005
          ? `A beta near zero means ${symbol} has shown little tendency to move with the market.`
          : `A 1% move in ${beta.benchmark || 'SPY'} has been associated with about a ${Math.abs(Number(beta.value)).toFixed(2)}% move in ${symbol} in the ${Number(beta.value) < 0 ? 'opposite' : 'same'} direction, on average.`
        : 'Matching daily return history is needed to calculate it.',
      'It helps assess market exposure; it does not capture every price swing or predict the next move. Size uses total volatility.',
    ].join(' '),
    details: beta
      ? [
        `${beta.observations || beta.windowSessions || 252} aligned daily returns`,
        'Completed adjusted closes',
        `As of ${asOfLabel}`,
      ]
      : ['Historical beta inputs are unavailable.'],
  };
}
