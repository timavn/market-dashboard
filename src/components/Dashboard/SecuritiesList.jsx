import React from 'react';
import { getSecuritiesWithPlaceholders, ASSET_CLASS_NAMES } from '../../constants/securitiesList';
import './SecuritiesList.css';

const SecuritiesList = () => {
  const securities = getSecuritiesWithPlaceholders();

  return (
    <div className="securities-list-container">
      {/* Color Legend */}
      <div className="securities-legend">
        <div className="legend-title">Asset Classes</div>
        <div className="legend-items">
          <div className="legend-item">
            <span className="legend-color asset-class-fixedIncome"></span>
            <span className="legend-label">Fixed Income</span>
          </div>
          <div className="legend-item">
            <span className="legend-color asset-class-equity"></span>
            <span className="legend-label">Equity</span>
          </div>
          <div className="legend-item">
            <span className="legend-color asset-class-currency"></span>
            <span className="legend-label">Currency</span>
          </div>
          <div className="legend-item">
            <span className="legend-color asset-class-commodity"></span>
            <span className="legend-label">Commodity</span>
          </div>
          <div className="legend-item">
            <span className="legend-color asset-class-crypto"></span>
            <span className="legend-label">Crypto</span>
          </div>
        </div>
      </div>
      
      <table className="securities-table">
        <thead>
          <tr>
            <th>TICKER</th>
            <th>W/W</th>
            <th>M/M</th>
            <th>RISK RANGE</th>
            <th>TRADE</th>
            <th>TREND</th>
          </tr>
        </thead>
        <tbody>
          {securities.map((security, index) => (
            <tr 
              key={security.ticker}
              className={`security-row asset-class-${security.assetClass}`}
              title={security.name}
            >
              <td className="ticker-cell">{security.ticker}</td>
              <td className="rank-change">{security.weekChange}</td>
              <td className="rank-change">{security.monthChange}</td>
              <td className="risk-range">{security.riskRange}</td>
              <td className="trade-cell">{security.trade}</td>
              <td className="trend-cell">{security.trend}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default SecuritiesList;

