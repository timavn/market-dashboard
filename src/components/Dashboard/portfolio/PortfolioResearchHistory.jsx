import React from 'react';
import LoadingIndicator from '../../common/LoadingIndicator';

// The parent supplies dated, validated display rows, never executable data.
// Keep native disclosure state so updates preserve open/closed state and a
// position panel's unmount/remount resets it, just as the inline section did.
export default function PortfolioResearchHistory({ rowId, rows, historyDays, loading, error }) {
  return (
    <details className="pcv2-intel-history">
      <summary>
        Previous {historyDays} market days ({loading ? 'loading…' : `${rows.length} product rows`})
      </summary>
      <div className="pcv2-intel-history-body">
        {loading ? (
          <div className="pcv2-intel-grid pcv2-intel-reference-row pcv2-intel-loading-row" role="status">
            <div className="pcv2-intel-cell pcv2-intel-span-20">
              <LoadingIndicator label="Loading verified historical references…" size="sm" announce={false} />
            </div>
          </div>
        ) : rows.length > 0
          ? rows.map((row) => (
            <div
              className="pcv2-intel-grid pcv2-intel-reference-row "
              key={`${rowId}-history-${row.key}`}
            >
              <div className="pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-time">
                {row.dateLabel}
              </div>
              <div className="pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-product">
                {row.productLabel}
              </div>
              <div
                className="pcv2-intel-cell pcv2-intel-span-16 pcv2-intel-reference-note "
                title={row.note || undefined}
              >
                {row.note}
              </div>
            </div>
          ))
          : (
            <div className="pcv2-intel-grid pcv2-intel-reference-row is-empty">
              <div className="pcv2-intel-cell pcv2-intel-span-20 pcv2-intel-history-empty">
                {error
                  ? 'Historical references unavailable.'
                  : 'No verified historical references returned.'}
              </div>
            </div>
          )}
      </div>
    </details>
  );
}
