import React from 'react';
import AnalystSemanticText from './AnalystSemanticText';
import './PortfolioReviewDateline.css';

export default function PortfolioReviewDateline({ text, period }) {
  return <p className={`portfolio-review-dateline${period ? ' has-period' : ''}`} title={[text, period].filter(Boolean).join(' · ')}>
    {period ? <>
      {text && <span className="portfolio-review-primary-date"><AnalystSemanticText>{text}</AnalystSemanticText></span>}
      {text && ' '}
      <span className="portfolio-review-period"><AnalystSemanticText>{period}</AnalystSemanticText></span>
    </> : <AnalystSemanticText>{text}</AnalystSemanticText>}
  </p>;
}
