import React from 'react';
import useUsdCorrelations from '../../hooks/useUsdCorrelations';
import useVolatilitySnapshot from '../../hooks/useVolatilitySnapshot';
import ExceptionFirstRadar from './ExceptionFirstRadar';

/**
 * Owns the single analytical polling state used by both the radar and its
 * detailed tables. Current regional quotes and provider health remain owned by
 * PortfolioDashboard so a failed refresh can clear them at the page boundary.
 */
const USDMacroDashboard = ({
  multiRegionMarketData = {},
  multiRegionLoading = true,
  multiRegionError = null,
  providerStatus = null,
  ibkrConnection = null,
}) => {
  const volatilityState = useVolatilitySnapshot();
  const correlationState = useUsdCorrelations();

  return (
    <div className="usd-macro-dashboard-shell">
      <ExceptionFirstRadar
        marketData={multiRegionMarketData}
        marketDataLoading={multiRegionLoading}
        marketDataError={multiRegionError}
        providerStatus={providerStatus}
        ibkrConnection={ibkrConnection}
        volatilityState={volatilityState}
        correlationState={correlationState}
      />
    </div>
  );
};

export default USDMacroDashboard;
