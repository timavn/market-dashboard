import React from 'react';
import { formatResearchSourceDate, formatResearchTime } from '../../../utils/researchDateFormat';
import { safeResearchUrl } from '../../../utils/researchSourceUrl';
import LoadingIndicator from '../../common/LoadingIndicator';

// Rows are the parent's validated research projection, never executable data.
// Expansion stays with the position owner so collapse/reopen preserves context.
export default function PortfolioResearchProducts({ rowId, symbol, rows, loading, expandedProducts, onToggleProduct }) {
  const researchProductExpansionKey = (row) => `${rowId}:${row.productId}`;
  const renderResearchProductContext = (row) => {
    const sourceUrl = safeResearchUrl(row.reference?.sourceUrl || row.reference?.url);
    const sourceTime = formatResearchTime(row.publishedAt);
    const contextFactLines = row.factLines.length > 1
      ? row.factLines.slice(1)
      : row.factLines;
    const sourceMeta = [
      row.productLabel,
      formatResearchSourceDate(row.marketDate),
      sourceTime === '—' ? null : `${sourceTime} ET`,
    ].filter(Boolean).join(' · ');
    return (
      <div
        className="pcv2-intel-grid pcv2-intel-reference-context"
        id={`research-product-context-${rowId}-${row.productId}`}
        role="region"
        aria-label={`${row.productLabel} facts for ${symbol}`}
        data-testid={`research-product-context-${rowId}-${row.productId}`}
      >
        <div className="pcv2-intel-cell pcv2-intel-span-20">
          <div
            className="pcv2-intel-reference-facts"
            role="list"
            aria-label={`${row.productLabel} fact list for ${symbol}`}
          >
            {contextFactLines.map((fact, index) => (
              <p
                className="pcv2-intel-reference-fact"
                role="listitem"
                key={`${row.productId}-fact-${index}`}
              >
                {fact}
              </p>
            ))}
          </div>
          <div className="pcv2-intel-reference-context-source">
            <span>Source: {sourceMeta}</span>
            {sourceUrl ? (
              <a href={sourceUrl} target="_blank" rel="noreferrer">
                OPEN SOURCE ↗
              </a>
            ) : (
              <span aria-disabled="true">SOURCE UNAVAILABLE</span>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderCurrentResearchProductRow = (row) => {
    const expansionKey = researchProductExpansionKey(row);
    const isExpanded = expandedProducts.has(expansionKey);
    const hasFacts = row.state === 'available' && row.factLines.length > 0;
    const detail = row.state === 'available'
      ? row.factLines[0] || `Verified current structured row for ${symbol}`
      : row.state === 'unavailable' ? 'UNAVAILABLE'
        : row.state === 'conflict' ? 'CONFLICT'
          : 'N/A';
    const statusLabel = row.state === 'available'
      ? `Verified ${row.productLabel} evidence for ${symbol}`
      : row.state === 'unavailable'
        ? `${row.productLabel} evidence is unavailable for ${symbol}`
        : row.state === 'conflict'
          ? `${row.productLabel} contains conflicting current rows for ${symbol}`
        : `${row.productLabel} has no verified mention for ${symbol}`;
    return (
      <React.Fragment key={`${rowId}-current-${row.key}`}>
        <div
          className={`pcv2-intel-grid pcv2-intel-reference-row ${isExpanded ? 'is-expanded' : ''} ${row.state !== 'available' ? 'is-empty' : ''} ${row.state === 'unavailable' ? 'is-unavailable' : ''}`}
          data-product-id={row.productId}
          data-testid={`research-product-row-${rowId}-${row.productId}`}
        >
          <div className="pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-time">
            {formatResearchTime(row.publishedAt)}
          </div>
          <div className="pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-product">
            {hasFacts ? (
              <button
                type="button"
                className="pcv2-intel-reference-product-button"
                aria-expanded={isExpanded}
                aria-controls={`research-product-context-${rowId}-${row.productId}`}
                aria-label={`${isExpanded ? 'Collapse' : 'View'} ${row.productLabel} facts for ${symbol}`}
                onClick={() => {
                  onToggleProduct(expansionKey);
                }}
              >
                <span>{row.productLabel}</span>
              </button>
            ) : row.productLabel}
          </div>
          <div
            className={`pcv2-intel-cell pcv2-intel-span-16 pcv2-intel-reference-note ${row.state !== 'available' ? 'is-empty' : ''}`}
            title={detail}
          >
            {hasFacts ? (
              <button
                type="button"
                className="pcv2-intel-reference-summary"
                aria-expanded={isExpanded}
                aria-controls={`research-product-context-${rowId}-${row.productId}`}
                aria-label={`${isExpanded ? 'Collapse' : 'View'} ${row.productLabel} context for ${symbol}`}
                onClick={() => {
                  onToggleProduct(expansionKey);
                }}
              >
                <span className="pcv2-intel-reference-summary__label">{detail}</span>
              </button>
            ) : (
              <span
                className={`pcv2-intel-reference-summary__label ${detail === 'N/A' ? 'is-na' : ''}`}
                title={statusLabel}
              >
                {detail}
              </span>
            )}
          </div>
        </div>
        {isExpanded && row.state === 'available' && renderResearchProductContext(row)}
      </React.Fragment>
    );
  };

  return (
    <>
      <div className="pcv2-intel-grid pcv2-intel-header pcv2-intel-reference-header" aria-label={`${symbol} research product references`}>
        <div className="pcv2-intel-cell pcv2-intel-span-2">TIME</div>
        <div className="pcv2-intel-cell pcv2-intel-span-2">PRODUCT</div>
        <div className="pcv2-intel-cell pcv2-intel-span-16">DETAIL</div>
      </div>
      {loading ? (
        <div className="pcv2-intel-grid pcv2-intel-reference-row pcv2-intel-loading-row" role="status">
          <div className="pcv2-intel-cell pcv2-intel-span-20">
            <LoadingIndicator label="Loading verified research…" size="sm" announce={false} />
          </div>
        </div>
      ) : rows.map((row) => renderCurrentResearchProductRow(row))}
    </>
  );
}
