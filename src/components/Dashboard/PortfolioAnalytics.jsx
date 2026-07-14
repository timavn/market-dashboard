import React, { useState, useCallback, useMemo } from 'react';
import { Card, Title, Text } from '@tremor/react';
import { calculateMacroFactorExposures } from '../../utils/macroAnalysisUtils';

const TOP_N_DEFAULT = 3;

const factorViewOptions = [
  { id: 'audit', label: 'Audit', description: 'One-line scorecard' },
  { id: 'drivers', label: 'Drivers', description: 'Contributor tables by factor' },
  { id: 'signed', label: 'Signed', description: 'Positive and negative exposure split' }
];

const parseNum = (value) => {
  const next = Number.parseFloat(value);
  return Number.isFinite(next) ? next : 0;
};

const formatSigned = (value, decimals = 1) => {
  const num = parseNum(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(decimals)}%`;
};

const PortfolioAnalytics = ({ portfolioData }) => {
  const [expandedFactors, setExpandedFactors] = useState(new Set());
  const [factorView, setFactorView] = useState('audit');

  const toggleExpand = useCallback((factorId) => {
    setExpandedFactors((prev) => {
      const next = new Set(prev);
      if (next.has(factorId)) next.delete(factorId);
      else next.add(factorId);
      return next;
    });
  }, []);

  const factorData = useMemo(() => {
    if (!portfolioData?.holdings) return [];
    return calculateMacroFactorExposures(portfolioData.holdings, portfolioData.summary?.totalValue);
  }, [portfolioData]);

  const factorRows = useMemo(() => {
    return factorData.map((factor) => {
      const contributors = factor.allContributors ?? factor.topContributors ?? [];
      const positive = contributors
        .filter((item) => parseNum(item.contributionPercent) > 0)
        .sort((a, b) => parseNum(b.contributionPercent) - parseNum(a.contributionPercent));
      const negative = contributors
        .filter((item) => parseNum(item.contributionPercent) < 0)
        .sort((a, b) => parseNum(a.contributionPercent) - parseNum(b.contributionPercent));
      const topContributor = contributors[0];
      const totalPositive = positive.reduce((sum, item) => sum + parseNum(item.contributionPercent), 0);
      const totalNegative = negative.reduce((sum, item) => sum + parseNum(item.contributionPercent), 0);
      const avgBeta = contributors.length
        ? contributors.reduce((sum, item) => sum + parseNum(item.beta), 0) / contributors.length
        : 0;

      return {
        ...factor,
        contributors,
        positive,
        negative,
        topContributor,
        totalPositive,
        totalNegative,
        avgBeta
      };
    });
  }, [factorData]);

  if (!portfolioData || !portfolioData.summary) {
    return (
      <Card className="dark:bg-gray-800">
        <Title className="mb-2 dark:text-white">Portfolio Analysis</Title>
        <Text className="text-xs text-gray-500 dark:text-gray-400">
          No portfolio data available
        </Text>
      </Card>
    );
  }

  const renderSwitcher = () => (
    <div className="pfa-switcher" role="tablist" aria-label="Factor exposure design variants">
      {factorViewOptions.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={factorView === option.id}
          className={`pfa-switcher__button ${factorView === option.id ? 'is-active' : ''}`}
          onClick={() => setFactorView(option.id)}
          title={option.description}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  const renderScoreStrip = () => (
    <div className="pfa-score-strip">
      {factorRows.map((factor) => (
        <div key={factor.factorId} className="pfa-metric">
          <span>{factor.subject}</span>
          <strong className={factor.score >= 0 ? 'pfa-positive' : 'pfa-negative'}>
            {formatSigned(factor.score, 0)}
          </strong>
        </div>
      ))}
    </div>
  );

  const renderAuditView = () => (
    <table className="pfa-table">
      <thead>
        <tr>
          <th>Factor</th>
          <th className="pfa-num">Net</th>
          <th className="pfa-num">Positive</th>
          <th className="pfa-num">Negative</th>
          <th className="pfa-num">Avg Beta</th>
          <th>Largest Driver</th>
          <th className="pfa-num">Driver Ctrb</th>
        </tr>
      </thead>
      <tbody>
        {factorRows.map((factor) => (
          <tr key={factor.factorId}>
            <td>
              <strong style={{ color: factor.color }}>{factor.subject}</strong>
              <div className="pfa-subtitle">{factor.calculationMethod}</div>
            </td>
            <td className={`pfa-num ${factor.score >= 0 ? 'pfa-positive' : 'pfa-negative'}`}>{formatSigned(factor.score, 0)}</td>
            <td className="pfa-num pfa-positive">{formatSigned(factor.totalPositive)}</td>
            <td className="pfa-num pfa-negative">{formatSigned(factor.totalNegative)}</td>
            <td className="pfa-num">{factor.avgBeta.toFixed(2)}</td>
            <td>{factor.topContributor?.symbol || '--'}</td>
            <td className={`pfa-num ${parseNum(factor.topContributor?.contributionPercent) >= 0 ? 'pfa-positive' : 'pfa-negative'}`}>
              {factor.topContributor ? formatSigned(factor.topContributor.contributionPercent, 2) : '--'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const renderDriversView = () => (
    <div className="pfa-factor-grid">
      {factorRows.map((factor) => {
        const isExpanded = expandedFactors.has(factor.factorId);
        const visibleRows = isExpanded ? factor.contributors : factor.contributors.slice(0, TOP_N_DEFAULT);

        return (
          <section key={factor.factorId} className="pfa-factor-card" style={{ borderLeftColor: factor.color }}>
            <div className="pfa-factor-card__head">
              <div>
                <strong>{factor.subject}</strong>
                <span>{factor.calculationMethod}</span>
              </div>
              <strong className={factor.score >= 0 ? 'pfa-positive' : 'pfa-negative'}>{formatSigned(factor.score, 0)}</strong>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th className="pfa-num">Wgt</th>
                  <th className="pfa-num">Beta</th>
                  <th className="pfa-num">Ctrb</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((c, idx) => (
                  <tr key={`${factor.factorId}-${c.symbol}-${idx}`}>
                    <td>{c.symbol}</td>
                    <td className="pfa-num">{c.weightPercent}%</td>
                    <td className="pfa-num">{parseNum(c.beta).toFixed(2)}</td>
                    <td className={`pfa-num ${parseNum(c.contributionPercent) >= 0 ? 'pfa-positive' : 'pfa-negative'}`}>
                      {formatSigned(c.contributionPercent, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {factor.contributors.length > TOP_N_DEFAULT && (
              <button type="button" className="pfa-expand" onClick={() => toggleExpand(factor.factorId)}>
                {isExpanded ? 'Show less' : `Show all ${factor.contributors.length}`}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );

  const renderSignedView = () => (
    <div className="pfa-signed-grid">
      {factorRows.map((factor) => (
        <section key={factor.factorId} className="pfa-signed-card">
          <h4 style={{ color: factor.color }}>{factor.subject}</h4>
          <div className="pfa-signed-row">
            <span>Net</span>
            <strong className={factor.score >= 0 ? 'pfa-positive' : 'pfa-negative'}>{formatSigned(factor.score, 0)}</strong>
          </div>
          <div className="pfa-signed-row">
            <span>Positive</span>
            <strong className="pfa-positive">{formatSigned(factor.totalPositive)}</strong>
          </div>
          <div className="pfa-signed-row">
            <span>Negative</span>
            <strong className="pfa-negative">{formatSigned(factor.totalNegative)}</strong>
          </div>
          <div className="pfa-signed-row">
            <span>Top +</span>
            <strong>{factor.positive[0]?.symbol || '--'} {factor.positive[0] ? formatSigned(factor.positive[0].contributionPercent, 2) : ''}</strong>
          </div>
          <div className="pfa-signed-row">
            <span>Top -</span>
            <strong>{factor.negative[0]?.symbol || '--'} {factor.negative[0] ? formatSigned(factor.negative[0].contributionPercent, 2) : ''}</strong>
          </div>
        </section>
      ))}
    </div>
  );

  return (
    <section className="pfa-shell">
      <div className="pfa-header">
        <div>
          <span className="pcv-eyebrow">Macro Factor Exposure</span>
          <Title className="pfa-title dark:text-white">Numeric Risk Audit</Title>
          <div className="pfa-subtitle">Beta-adjusted exposure by macro driver. Positive values add exposure; negative values hedge or detract.</div>
        </div>
        {renderSwitcher()}
      </div>

      {renderScoreStrip()}
      {factorView === 'audit' && renderAuditView()}
      {factorView === 'drivers' && renderDriversView()}
      {factorView === 'signed' && renderSignedView()}
    </section>
  );
};

export default PortfolioAnalytics;
