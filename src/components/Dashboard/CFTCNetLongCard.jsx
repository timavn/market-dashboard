import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { CFTC_REPORT_COLUMNS, CFTC_REPORT_CONTRACT_ORDER, CFTC_STALE_AFTER_MS } from '../../constants/cftcPositioning';
import LoadingIndicator from '../common/LoadingIndicator';
import CFTCPositioningDetail from './CFTCPositioningDetail';
import {
  cftcValueClass,
  formatCftcDate,
  formatCftcReportNumber,
  getCftcDisplayRow,
  getCftcMethodologyNote,
  getCftcRowKey,
  isCftcReportDate,
  isCftcResearchSnapshot,
} from '../../utils/cftcPositioningPresentation';
import './CFTCNetLongCard.css';

const CATEGORY_ORDER = ['EQUITIES', 'RATES', 'CURRENCIES', 'COMMODITIES', 'CRYPTO', 'OTHER'];
const CONTRACT_RANK = new Map(CFTC_REPORT_CONTRACT_ORDER.map((code, index) => [code, index]));

export const getCftcFreshness = (date, {
  refreshFailed = false,
  cacheState = null,
  sourceVerified = false,
  decisionEligible = false,
  contentComplete = false,
} = {}) => {
  if (!isCftcReportDate(date)) return { label: 'UNAVAILABLE', stale: true, referenceOnly: true };
  const asOf = new Date(`${date}T23:59:59Z`);
  const stale = refreshFailed
    || cacheState === 'stale'
    || Number.isNaN(asOf.getTime())
    || Date.now() - asOf.getTime() > CFTC_STALE_AFTER_MS;
  const formatted = Number.isNaN(asOf.getTime())
    ? date
    : asOf.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const referenceOnly = stale || !sourceVerified || !decisionEligible;
  const prefix = stale
    ? 'STALE · REFERENCE ONLY · '
    : !sourceVerified || !decisionEligible
      ? 'UNVERIFIED · REFERENCE ONLY · '
      : !contentComplete
        ? 'PARTIAL · '
        : '';
  return {
    label: `${prefix}AS OF ${formatted}`.toUpperCase(),
    stale,
    referenceOnly,
  };
};

const CFTCNetLongCard = ({ resourceState = null }) => {
  const [localData, setData] = useState(null);
  const [localLoading, setLoading] = useState(true);
  const [localError, setError] = useState(null);
  const [selectedSeries, setSelectedSeries] = useState(null);
  const closeDetail = useCallback(() => setSelectedSeries(null), []);

  useEffect(() => {
    if (resourceState) return undefined;
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
        // Fetch the latest CFTC positioning snapshot
        const response = await axios.get(`${backendUrl}/api/hedgeye/snapshot/cftc-positioning`);
        setData(response.data);
      } catch (err) {
        console.error('Error fetching CFTC data:', err);
        setError('Failed to load CFTC data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    // Refresh every 15 minutes
    const interval = setInterval(fetchData, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, [resourceState]);

  const data = resourceState ? resourceState.data : localData;
  const loading = resourceState ? resourceState.loading : localLoading;
  const error = resourceState ? resourceState.error : localError;

  if (loading && !data) {
    return (
      <div className="cftc-positioning cftc-positioning--empty">
        <LoadingIndicator label="Loading CFTC Data..." size="md" centered />
      </div>
    );
  }

  if (error && !data) {
    return <div className="cftc-positioning cftc-positioning--empty">UNAVAILABLE</div>;
  }

  // Dated official research remains reference-only through refresh failures.
  // Unverified, mocked or seeded observations never become visible numbers.
  const sourceVerified = isCftcResearchSnapshot(data);
  const rows = sourceVerified && Array.isArray(data?.data)
    ? data.data.filter(row => row && typeof row === 'object').map(row => getCftcDisplayRow(row, data)) : [];
  const selectedRow = rows.find(row => getCftcRowKey(row) === selectedSeries);
  const groupedData = rows.reduce((acc, row) => {
    const cat = row.category || 'OTHER';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(row);
    return acc;
  }, {});
  Object.values(groupedData).forEach(categoryRows => categoryRows.sort((a, b) =>
    (CONTRACT_RANK.get(a.cftcContractMarketCode) ?? Infinity)
    - (CONTRACT_RANK.get(b.cftcContractMarketCode) ?? Infinity)));

  const categories = Object.keys(groupedData).sort((a, b) => {
    const idxA = CATEGORY_ORDER.indexOf(a);
    const idxB = CATEGORY_ORDER.indexOf(b);
    if (idxA === -1 && idxB === -1) return a.localeCompare(b);
    if (idxA === -1) return 1;
    if (idxB === -1) return -1;
    return idxA - idxB;
  });
  const reportDate = data?.reportDate || data?.date;
  const freshness = getCftcFreshness(reportDate, {
    refreshFailed: Boolean(error),
    cacheState: data?.cacheState,
    sourceVerified,
    decisionEligible: data?.decisionEligible === true,
    contentComplete: data?.contentComplete === true,
  });

  return (
    <div className="cftc-positioning">
      {categories.length === 0 ? (
        <div data-testid="cftc-unavailable" className="cftc-positioning--empty">
          OFFICIAL CFTC ROWS UNAVAILABLE
        </div>
      ) : (
        <div className="cftc-positioning__report">
          <table className="cftc-positioning__table" aria-label="CFTC positioning">
            <colgroup>
              <col className="cftc-positioning__category-col" />
              <col className="cftc-positioning__contract-col" />
              {CFTC_REPORT_COLUMNS.map(column => (
                <col key={column.key} className={column.score ? 'cftc-positioning__score-col' : 'cftc-positioning__value-col'} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th rowSpan={2} aria-label="Asset class" />
                <th rowSpan={2} scope="col">Metric</th>
                {CFTC_REPORT_COLUMNS.filter(column => !column.group).map(column => (
                  <th key={column.key} rowSpan={2} scope="col" title={column.key === 'latest' ? freshness.label : undefined}>
                    {column.key === 'latest' ? formatCftcDate(reportDate, { compact: true }) : column.label}
                  </th>
                ))}
                <th colSpan={2} scope="colgroup">3Y</th>
                <th colSpan={2} scope="colgroup">Z-Score</th>
              </tr>
              <tr>
                {CFTC_REPORT_COLUMNS.filter(column => column.group).map(column => (
                  <th key={column.key} scope="col">{column.label}</th>
                ))}
              </tr>
            </thead>
            {categories.map(category => (
              <tbody key={category} aria-label={category}>
                {groupedData[category].map((row, idx) => {
                  const rowStatus = String(row.status || 'unavailable').toLowerCase();
                  const unavailable = rowStatus === 'unavailable';
                  const partial = rowStatus === 'partial';
                  const discontinued = rowStatus === 'discontinued';
                  const statistics = data.schemaVersion === 'cftc-positioning-v3' ? row.historyStatistics : null;
                  return (
                    <tr
                      key={getCftcRowKey(row)}
                      className="cftc-positioning__instrument-row"
                      onClick={() => setSelectedSeries(getCftcRowKey(row))}
                    >
                      {idx === 0 && <th scope="rowgroup" rowSpan={groupedData[category].length} className="cftc-positioning__category">
                        <span>{category === 'OTHER' ? 'UNKNOWN' : category}</span>
                      </th>}
                      <th scope="row" className="cftc-positioning__metric">
                        <button
                          type="button"
                          className="cftc-positioning__detail-button"
                          aria-haspopup="dialog"
                          aria-expanded={selectedSeries === getCftcRowKey(row)}
                          title="Open positioning details"
                        >
                          {row.metric}
                        </button>
                        {(unavailable || partial || discontinued) && (
                          <span
                            data-testid={`cftc-row-status-${row.cftcContractMarketCode || idx}`}
                            className={`cftc-positioning__row-status${partial ? ' is-partial' : ''}`}
                          >
                            {discontinued
                              ? `DISCONTINUED · ${row.asOf}`
                              : partial ? 'PARTIAL' : 'UNAVAILABLE'}
                          </span>
                        )}
                      </th>
                      {CFTC_REPORT_COLUMNS.map(column => {
                        const value = column.history ? statistics?.[column.key] : row[column.key];
                        return <td key={column.key} className={`${column.score ? 'cftc-positioning__z-score ' : ''}${cftcValueClass(value, { score: column.score })}`}>
                          {formatCftcReportNumber(value, { score: column.score })}
                        </td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}
      <p className="cftc-positioning__note">
        {getCftcMethodologyNote(rows)}
      </p>
      {selectedRow && <CFTCPositioningDetail
        row={selectedRow}
        snapshot={data}
        freshness={freshness}
        onClose={closeDetail}
      />}
    </div>
  );
};

export default CFTCNetLongCard;
