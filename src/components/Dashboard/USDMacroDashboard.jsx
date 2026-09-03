import React from 'react';
import useUsdCorrelations from '../../hooks/useUsdCorrelations';
import useVixRiskRange from '../../hooks/useVixRiskRange';
import useVolatilitySnapshot from '../../hooks/useVolatilitySnapshot';
import ExceptionFirstRadar from './ExceptionFirstRadar';

/**
 * Owns the single analytical polling state used by both the radar and its
 * detailed tables. Current regional quotes and provider health remain owned by
 * PortfolioDashboard so their last verified snapshot can stay mounted while
 * a replacement request is in flight or delayed.
 */
const USDMacroDashboard = ({
  multiRegionMarketData = {},
  multiRegionLoading = true,
  multiRegionError = null,
  providerStatus = null,
  ibkrConnection = null,
  onDashboardStatusChange,
}) => {
  const volatilityState = useVolatilitySnapshot();
  const vixRiskRangeState = useVixRiskRange();
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
        vixRiskRangeState={vixRiskRangeState}
        correlationState={correlationState}
        onDashboardStatusChange={onDashboardStatusChange}
      />
    </div>
  );
};

export default USDMacroDashboard;
