import React, { createContext, useContext, useMemo } from 'react';
import { portfolioReviewCompanyNames, portfolioReviewTickers } from '../../utils/portfolioReviewTypography';

export const PortfolioReviewTextContext = createContext(null);
export const PortfolioReviewCompanyNamesContext = createContext(null);

export function PortfolioReviewTextProvider({ brief, rollup, children }) {
  const parent = useContext(PortfolioReviewTextContext);
  const parentNames = useContext(PortfolioReviewCompanyNamesContext);
  const tickers = useMemo(() => new Set([
    ...(parent || []), ...portfolioReviewTickers({ brief, rollup: rollup || brief?.dailyRollup }),
  ]), [parent, brief, rollup]);
  const names = useMemo(() => new Set([
    ...(parentNames || []), ...portfolioReviewCompanyNames({ brief, rollup: rollup || brief?.dailyRollup }),
  ]), [parentNames, brief, rollup]);
  return <PortfolioReviewTextContext.Provider value={tickers}>
    <PortfolioReviewCompanyNamesContext.Provider value={names}>{children}</PortfolioReviewCompanyNamesContext.Provider>
  </PortfolioReviewTextContext.Provider>;
}
