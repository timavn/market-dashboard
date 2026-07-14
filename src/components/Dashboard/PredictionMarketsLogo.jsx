import React from 'react';

const PREDICTION_MARKETS_LOGO_SRC = '/images/icons/prediction-markets.png';

/** Full horizontal logo or icon crop used by collapsed dashboard navigation. */
export default function PredictionMarketsLogo({ variant = 'full', height = 28, className = '' }) {
  const isIcon = variant === 'icon';

  return (
    <img
      src={PREDICTION_MARKETS_LOGO_SRC}
      alt={isIcon ? '' : 'Prediction Markets'}
      aria-hidden={isIcon ? true : undefined}
      className={`pmv2-logo ${isIcon ? 'pmv2-logo-icon' : 'pmv2-logo-full'} ${className}`}
      style={{ height }}
      width={isIcon ? height : undefined}
    />
  );
}

