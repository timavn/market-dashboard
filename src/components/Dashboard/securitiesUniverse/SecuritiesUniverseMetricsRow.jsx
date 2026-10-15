import React from 'react';
import RiskRangeCell from './RiskRangeCell';
import DashboardResearchLabel from '../DashboardResearchLabel';
import { buildTradingDays } from '../../../utils/enrichSecurity';
import {
  formatSecurityPrice,
  getIvolPremColor,
  getTTMZScoreColor,
  getIOVRPercentileColor,
  formatVolatilityMetric,
  getQuadColor,
  formatPriceChange,
  getPriceChangeColor,
  formatZScore,
  getZScoreColor,
} from './securitiesUniverseMetricsUtils';

function SecuritiesUniverseMetricsRow({ security, rowIndex = 0, tradingDays }) {
  if (!security) return null;

  const days = tradingDays || buildTradingDays();
  const priceChange1D = security.priceChanges?.['1D'];
  const priceChange1W = security.priceChanges?.['1W'];
  const priceChange1M = security.priceChanges?.['1M'];
  const volMetrics = security.volatilityMetrics;

  return (
    <tr
      className={`su-metrics-row ${security.researchHealth && security.researchHealth !== 'ready' ? 'su-research-attention' : ''}`}
      title={security.researchHealth && security.researchHealth !== 'ready'
        ? `${security.ticker} current research is incomplete or unavailable.`
        : undefined}
      style={{
        borderBottom: '1px solid #e8e2d5',
        backgroundColor: security.researchHealth && security.researchHealth !== 'ready'
          ? '#fef2f2'
          : rowIndex % 2 === 0 ? 'transparent' : '#f9fafb',
      }}
    >
      <td style={{ padding: '2px 3px', fontWeight: '600', borderRight: '1px solid #e5e7eb', textAlign: 'center' }} className="dark:text-white">
                        {security.ticker}
                      </td>
                      <td style={{ padding: '2px 3px', textAlign: 'center', fontWeight: 400, borderRight: '1px solid #e5e7eb', whiteSpace: 'nowrap' }} className="dark:text-gray-300">
                        <DashboardResearchLabel label={security.ticker} reading={security.tickResearch} showName={false} />
                        <span style={{ marginLeft: security.tickResearch ? 3 : 0,
                          color: security.bias === 'BULLISH' ? '#059669' :
                            security.bias === 'BEARISH' ? '#dc2626' : '#6b7280'
                        }}>
                          {({ BULLISH: 'Te ↑', BEARISH: 'Te ↓', NEUTRAL: 'Te →' })[security.bias] || security.bias || '—'}
                        </span>
                      </td>
                      <td style={{ padding: '2px 3px', textAlign: 'center', borderRight: '1px solid #e5e7eb' }} className="dark:text-gray-300">
                        <div style={{ display: 'flex', justifyContent: 'center' }}>
                          <RiskRangeCell riskRangeHistory={security.riskRangeHistory} tradingDays={days} />
                        </div>
                      </td>

                      <td
                        style={{
                          padding: '2px 3px',
                          textAlign: 'center',
                          color: volMetrics ? getIvolPremColor(volMetrics.ivolPrem) : '#6b7280',
                          fontWeight: 600,
                          borderRight: '1px solid #e5e7eb'
                        }}
                        className="dark:text-white"
                      >
                        {volMetrics ? formatVolatilityMetric(volMetrics.ivolPrem) : '--'}
                      </td>
                      <td
                        style={{
                          padding: '2px 3px',
                          textAlign: 'center',
                          color: volMetrics ? getTTMZScoreColor(volMetrics.ttmZScore) : '#6b7280',
                          fontWeight: 600,
                          borderRight: '1px solid #e5e7eb'
                        }}
                        className="dark:text-white"
                      >
                        {volMetrics ? formatVolatilityMetric(volMetrics.ttmZScore) : '--'}
                      </td>
                      <td
                        style={{
                          padding: '2px 3px',
                          textAlign: 'center',
                          color: volMetrics ? getIOVRPercentileColor(volMetrics.iovrPercentile) : '#6b7280',
                          fontWeight: 600,
                          borderRight: '1px solid #e5e7eb'
                        }}
                        className="dark:text-white"
                      >
                        {volMetrics ? formatVolatilityMetric(volMetrics.iovrPercentile, true) : '--'}
                      </td>
                      <td style={{ padding: '2px 3px', textAlign: 'center', borderRight: '1px solid #e5e7eb' }} className="dark:text-white">
                        {(() => {
                          const zScoreColors = getZScoreColor(security.zScore);
                          return (
                            <span
                              style={{
                                display: 'inline-block',
                                fontSize: '7px',
                                padding: '2px 6px',
                                lineHeight: '1.2',
                                borderRadius: '4px',
                                backgroundColor: zScoreColors.bgColor,
                                color: zScoreColors.color,
                                border: zScoreColors.emphasis
                                  ? `2px solid ${zScoreColors.borderColor}`
                                  : `1px solid ${zScoreColors.borderColor}`,
                                fontWeight: zScoreColors.emphasis ? 700 : 600,
                                boxShadow: zScoreColors.emphasis ? '0 1px 3px rgba(0,0,0,0.15)' : 'none'
                              }}
                            >
                              {formatZScore(security.zScore)}
                            </span>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '2px 3px', textAlign: 'center', borderRight: '1px solid #e5e7eb' }} className="dark:text-gray-300">
                        {security.beta}
                      </td>
                      <td style={{ padding: '2px 3px', textAlign: 'center', borderRight: '1px solid #e5e7eb' }}>
                        {security.quadRanking && security.quadRanking !== '--' ? (
                          <div style={{ display: 'flex', gap: '2px', justifyContent: 'center', alignItems: 'center' }}>
                            {security.quadRanking.split('/').map((quadNum, index, array) => {
                              const num = parseInt(quadNum);
                              return (
                                <React.Fragment key={index}>
                                  <span
                                    style={{
                                      color: getQuadColor(num),
                                      fontWeight: 600,
                                      fontSize: '8px'
                                    }}
                                  >
                                    {quadNum}
                                  </span>
                                  {index < array.length - 1 && (
                                    <span style={{ color: '#6b7280', fontSize: '8px' }}>/</span>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="dark:text-gray-400">--</span>
                        )}
                      </td>
                      <td style={{ padding: '2px 3px', textAlign: 'center', borderRight: '1px solid #e5e7eb' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', fontSize: '7px', alignItems: 'center' }}>
                          <span
                            style={{
                              color: getPriceChangeColor(priceChange1D) === 'emerald' ? '#059669' :
                                getPriceChangeColor(priceChange1D) === 'red' ? '#dc2626' : '#6b7280'
                            }}
                            className="dark:text-gray-300"
                          >
                            1D: {formatPriceChange(priceChange1D)}
                          </span>
                          <span
                            style={{
                              color: getPriceChangeColor(priceChange1W) === 'emerald' ? '#059669' :
                                getPriceChangeColor(priceChange1W) === 'red' ? '#dc2626' : '#6b7280'
                            }}
                            className="dark:text-gray-300"
                          >
                            1W: {formatPriceChange(priceChange1W)}
                          </span>
                          <span
                            style={{
                              color: getPriceChangeColor(priceChange1M) === 'emerald' ? '#059669' :
                                getPriceChangeColor(priceChange1M) === 'red' ? '#dc2626' : '#6b7280'
                            }}
                            className="dark:text-gray-300"
                          >
                            1M: {formatPriceChange(priceChange1M)}
                          </span>
                        </div>
                      </td>
                      <td
                        style={{
                          padding: '2px 3px',
                          textAlign: 'center',
                          fontWeight: 600,
                          borderRight: '1px solid #e5e7eb'
                        }}
                        className="dark:text-white"
                      >
                        {security.atr !== null ? (
                          <div style={{
                            display: 'inline-grid',
                            gridTemplateColumns: 'auto auto',
                            columnGap: '3px',
                            rowGap: '1px',
                            fontSize: '9px',
                            justifyContent: 'center',
                            alignItems: 'center'
                          }}>
                            <span style={{ color: '#6b7280', fontWeight: 500, textAlign: 'right' }}>Spot:</span>
                            <span style={{ color: '#374151', textAlign: 'left', fontWeight: 600 }}>
                              {security.price !== null && security.price !== undefined
                                ? formatSecurityPrice(security.price, security.ticker)
                                : '--'}
                            </span>
                            <span style={{ color: '#6b7280', fontWeight: 500, textAlign: 'right' }}>Abs:</span>
                            <span style={{ color: '#374151', textAlign: 'left' }}>{security.atr.toFixed(2)}</span>
                            <span style={{ color: '#6b7280', fontWeight: 500, textAlign: 'right' }}>%:</span>
                            <span style={{
                              color: security.atrPercent > 5 ? '#dc2626' :
                                security.atrPercent > 2 ? '#f59e0b' : '#059669',
                              textAlign: 'left'
                            }}>
                              {security.atrPercent.toFixed(1)}%
                            </span>
                          </div>
                        ) : '--'}
                      </td>
                      <td style={{ padding: '2px 3px', textAlign: 'center', fontWeight: 600 }} className="dark:text-white">
                        {security.signal}
                      </td>

    </tr>
  );
}

export default SecuritiesUniverseMetricsRow;
