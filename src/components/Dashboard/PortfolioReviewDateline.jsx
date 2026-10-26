import React from 'react';
import AnalystSemanticText from './AnalystSemanticText';
import './PortfolioReviewDateline.css';

// The section title already says which date this is; the tooltip keeps the label.
const unlabeled = value => value?.replace(/^(?:Positioning|Previous|Published): /, '');

// A second labeled date ("Previous: …", "Period: …") lines its date up under the
// first one, with its label hanging to the left.
function SecondDate({ className, value }) {
  const [, label = '', date = value] = value.match(/^([^:]+:)\s*(.*)$/) || [];
  return <span className={className}>
    <span className="portfolio-review-dateline-label"><AnalystSemanticText>{label}</AnalystSemanticText></span>{' '}
    <span className="portfolio-review-dateline-date"><AnalystSemanticText>{date}</AnalystSemanticText></span>
  </span>;
}

export default function PortfolioReviewDateline({ text: labeled, period, previous }) {
  const text = unlabeled(labeled);
  const second = previous || period;
  if (text && second) {
    return <p className={`portfolio-review-dateline is-paired${period && !previous ? ' has-period' : ''}`} title={[labeled, second].join(' · ')}>
      <span className="portfolio-review-primary-date"><AnalystSemanticText>{text}</AnalystSemanticText></span>{' '}
      <SecondDate className={previous ? 'portfolio-review-previous' : 'portfolio-review-period'} value={second} />
    </p>;
  }
  return <p className={`portfolio-review-dateline${period ? ' has-period' : ''}`} title={[labeled, period].filter(Boolean).join(' · ')}>
    {period ? <span className="portfolio-review-period"><AnalystSemanticText>{period}</AnalystSemanticText></span>
      : <AnalystSemanticText>{text}</AnalystSemanticText>}
  </p>;
}
