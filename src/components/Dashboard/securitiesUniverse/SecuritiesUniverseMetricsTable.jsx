import React from 'react';
import { Loader } from 'lucide-react';
import { METRICS_COLUMNS } from './metricsColumns';
import SecuritiesUniverseMetricsRow from './SecuritiesUniverseMetricsRow';
import { buildTradingDays } from '../../../utils/enrichSecurity';
import './securitiesUniverseMetrics.css';

function SecuritiesUniverseMetricsHeader({
  columns,
  sortable = false,
  getSortInfo,
  onSort,
  onMetricDefinitionClick,
}) {
  return (
    <thead className="su-metrics-thead">
      <tr>
        {columns.map((col, index, arr) => {
          const isSortable = sortable && col.sortable !== false;
          return (
            <th
              key={col.key}
              className="su-metrics-th"
              style={{
                width: col.width,
                minWidth: col.width,
                maxWidth: col.width,
                borderLeft: index === 0 ? '1px solid #d1d5db' : 'none',
                borderRight:
                  index === arr.length - 1 ? '1px solid #d1d5db' : '1px solid #e5e7eb',
                cursor: isSortable ? 'pointer' : 'default',
              }}
              onClick={isSortable && onSort ? () => onSort(col.key) : undefined}
            >
              <div className="su-metrics-th-inner">
                <span
                  className={`su-metrics-th-label${col.infoParams ? ' su-metrics-th-label--info' : ''}`}
                  onClick={
                    col.infoParams && onMetricDefinitionClick
                      ? e => {
                          e.stopPropagation();
                          onMetricDefinitionClick(e, col.infoParams);
                        }
                      : undefined
                  }
                >
                  {col.label}
                </span>
                <div className="su-metrics-th-icon">{col.icon}</div>
              </div>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

function SecuritiesUniverseMetricsTable({
  security,
  securities,
  loading = false,
  error = null,
  compact = false,
  sortable = false,
  getSortInfo,
  onSort,
  onMetricDefinitionClick,
  tradingDays: tradingDaysProp,
  missingSymbol,
}) {
  const tradingDays = tradingDaysProp || buildTradingDays();
  const columns = METRICS_COLUMNS;
  const rows = securities || (security ? [security] : []);

  if (missingSymbol) {
    return (
      <div className="su-metrics-empty">
        No Securities Universe entry for <strong>{missingSymbol}</strong>
      </div>
    );
  }

  if (loading && rows.length === 0) {
    return (
      <div className="su-metrics-loading">
        <Loader className="su-metrics-spin" size={18} />
        <span>Loading metrics…</span>
      </div>
    );
  }

  if (error && rows.length === 0) {
    return <div className="su-metrics-error">{error}</div>;
  }

  return (
    <div className={`su-metrics-table-wrap${compact ? ' su-metrics-table-wrap--compact' : ''}`}>
      <table className="su-metrics-table">
        <SecuritiesUniverseMetricsHeader
          columns={columns}
          sortable={sortable}
          getSortInfo={getSortInfo}
          onSort={onSort}
          onMetricDefinitionClick={onMetricDefinitionClick}
        />
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="su-metrics-empty-cell">
                No security selected
              </td>
            </tr>
          ) : (
            rows.map((sec, index) => (
              <SecuritiesUniverseMetricsRow
                key={sec.ticker}
                security={sec}
                rowIndex={index}
                tradingDays={tradingDays}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default SecuritiesUniverseMetricsTable;
