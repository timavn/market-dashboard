import React, { useMemo, useState } from 'react';
import { Card, Text, Title } from '@tremor/react';

const {
  aggregatePortfolioQuadExposures,
} = require('../../utils/portfolioQuadExposure');

const DIMENSION_LABELS = {
  asset_class: 'Asset class',
  assetClasses: 'Asset class',
  equity_sector: 'Equity sector',
  equitySectors: 'Equity sector',
  equity_style: 'Equity style',
  equityStyleFactors: 'Equity style',
  fixed_income_sector: 'Fixed income',
  fixedIncomeSectors: 'Fixed income',
};

const FIT_LABELS = {
  favored: 'Best',
  best: 'Best',
  unfavorable: 'Worst',
  worst: 'Worst',
  'not-listed': 'Not listed',
};

const FIT_CLASSES = {
  favored: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200',
  best: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200',
  unfavorable: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200',
  worst: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200',
  'not-listed': 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-300',
};

const ALIGNMENT_CLASSES = {
  aligned: 'text-emerald-700 dark:text-emerald-300',
  conflict: 'text-red-700 dark:text-red-300',
  misaligned: 'text-red-700 dark:text-red-300',
  opposed: 'text-red-700 dark:text-red-300',
  mixed: 'text-amber-700 dark:text-amber-300',
  neutral: 'text-gray-600 dark:text-gray-300',
  unscored: 'text-gray-500 dark:text-gray-400',
};

const finiteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const formatPercent = (value, { signed = false } = {}) => {
  const number = finiteNumber(value);
  if (number === null) return '—';
  const sign = signed && number > 0 ? '+' : '';
  return `${sign}${number.toFixed(1)}%`;
};

const formatFit = (fit) => {
  if (!fit?.status) return 'Unscored';
  const label = FIT_LABELS[fit.status] || fit.status;
  return fit.rank !== null
    && fit.rank !== undefined
    && Number.isFinite(Number(fit.rank))
    ? `${label} #${fit.rank}`
    : label;
};

const fitPill = (fit, key) => (
  <span
    key={key}
    className={`inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[9px] font-semibold ${
      FIT_CLASSES[fit?.status] || FIT_CLASSES['not-listed']
    }`}
  >
    {formatFit(fit)}
  </span>
);

const humanize = (value, fallback = 'Unscored') => {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
};

const formatTransition = (previousFit, currentFit, transition) => {
  if (!previousFit?.status) return formatFit(currentFit);
  return `${formatFit(previousFit)} → ${formatFit(currentFit)}${
    transition && transition !== 'unchanged' ? ` · ${humanize(transition)}` : ''
  }`;
};

const formatQuadMap = (label) => (
  ['q1', 'q2', 'q3', 'q4']
    .map((quadKey) => `${quadKey.toUpperCase()} ${formatFit(label?.quadFits?.[quadKey])}`)
    .join(' · ')
);

const contributorText = (contributors) => {
  if (!Array.isArray(contributors) || contributors.length === 0) return 'No contributors';
  return contributors.slice(0, 3).map((contributor) => {
    const symbol = contributor?.localSymbol || contributor?.symbol || 'Unknown';
    const contribution = finiteNumber(
      contributor?.grossPct
      ?? contributor?.grossWeightPct
      ?? contributor?.absWeightPct
      ?? contributor?.weightPct
    );
    return contribution === null ? symbol : `${symbol} ${Math.abs(contribution).toFixed(1)}%`;
  }).join(' · ');
};

const getPositionIdentity = (position) => {
  const symbol = position?.localSymbol || position?.symbol || 'Unknown security';
  const contract = [
    position?.localSymbol && position.localSymbol !== position.symbol ? position.symbol : null,
    position?.conid ? `conid ${position.conid}` : null,
  ].filter(Boolean).join(' · ');
  return { symbol, contract };
};

const getCoverageCount = (coverage, keys, fallback = 0) => {
  for (const key of keys) {
    const value = finiteNumber(coverage?.[key]);
    if (value !== null) return value;
  }
  return fallback;
};

const PortfolioQuadExposureCard = ({
  portfolioData,
  isLoading = false,
  isRefreshing = false,
  error = null,
  currentQuad,
  previousQuad = null,
  currentPeriodLabel = '',
  previousPeriodLabel = '',
  selectedAccount = '',
}) => {
  const [view, setView] = useState('summary');
  const result = useMemo(() => aggregatePortfolioQuadExposures({
    portfolioData,
    currentQuad,
    previousQuad,
  }), [currentQuad, portfolioData, previousQuad]);

  const positions = Array.isArray(result?.positions) ? result.positions : [];
  const exposures = Array.isArray(result?.exposures) ? result.exposures : [];
  const availability = result?.availability || {};
  const liveExposureAvailable = availability.available === true;
  const unclassifiedPositions = positions.filter((position) => (
    position?.classificationStatus !== 'reviewed'
    || !Array.isArray(position?.labels)
    || position.labels.length === 0
  ));
  const classifiedCount = getCoverageCount(
    result?.coverage,
    ['classifiedPositionCount', 'classifiedCount', 'reviewedPositionCount'],
    positions.length - unclassifiedPositions.length
  );
  const totalCount = getCoverageCount(
    result?.coverage,
    ['totalPositionCount', 'positionCount', 'totalCount'],
    positions.length
  );
  const classifiedGrossPct = finiteNumber(
    result?.coverage?.classifiedShareOfGrossPct
    ?? result?.coverage?.classifiedGrossWeightPct
    ?? result?.coverage?.classifiedGrossPct
  );
  const sortedExposures = [...exposures].sort((a, b) => (
    (finiteNumber(b?.grossPct) ?? -Infinity) - (finiteNumber(a?.grossPct) ?? -Infinity)
    || String(a?.label || '').localeCompare(String(b?.label || ''))
  ));
  const sortedPositions = [...positions].sort((a, b) => {
    const aUnclassified = a?.classificationStatus === 'reviewed' ? 0 : 1;
    const bUnclassified = b?.classificationStatus === 'reviewed' ? 0 : 1;
    return bUnclassified - aUnclassified
      || (finiteNumber(b?.grossWeightPct) ?? -Infinity) - (finiteNumber(a?.grossWeightPct) ?? -Infinity)
      || String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
  });
  const showSecurityMap = view === 'securities' || !liveExposureAvailable;
  const currentQuadLabel = currentQuad ? String(currentQuad).toUpperCase() : 'No active quad';
  const previousQuadLabel = previousQuad ? String(previousQuad).toUpperCase() : null;
  const transitionLabel = previousQuadLabel
    ? `${previousQuadLabel} → ${currentQuadLabel}`
    : currentQuadLabel;
  const accountLabel = selectedAccount || portfolioData?.accountId || 'Selected account';

  return (
    <Card className="dark:bg-gray-800" aria-label="Portfolio Quad Exposure">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Title className="text-xl dark:text-white">Portfolio Quad Exposure</Title>
            <span className="rounded bg-gray-900 px-1.5 py-0.5 text-[10px] font-semibold text-white dark:bg-gray-100 dark:text-gray-950">
              {transitionLabel}
            </span>
            {isRefreshing && (
              <span className="text-[10px] text-blue-600 dark:text-blue-300">Refreshing live portfolio…</span>
            )}
          </div>
          <Text className="mt-1 text-xs text-gray-600 dark:text-gray-300">
            {accountLabel}
            {currentPeriodLabel ? ` · ${currentPeriodLabel}` : ''}
            {previousPeriodLabel ? ` · prior ${previousPeriodLabel}` : ''}
          </Text>
        </div>

        <div className="inline-flex rounded-md border border-gray-300 p-0.5 dark:border-gray-600">
          <button
            type="button"
            onClick={() => setView('summary')}
            disabled={!liveExposureAvailable}
            title={!liveExposureAvailable
              ? 'A verified live portfolio is required for weighted exposure rows.'
              : undefined}
            className={`rounded px-2 py-1 text-[10px] ${
              view === 'summary' && liveExposureAvailable
                ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-950'
                : !liveExposureAvailable
                  ? 'cursor-not-allowed text-gray-400 dark:text-gray-500'
                  : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            Exposure Summary
          </button>
          <button
            type="button"
            onClick={() => setView('securities')}
            className={`rounded px-2 py-1 text-[10px] ${
              showSecurityMap
                ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-950'
                : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            Security Map
          </button>
        </div>
      </div>

      {isLoading && !portfolioData ? (
        <div
          role="status"
          className="rounded-md border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200"
        >
          Loading the verified live portfolio…
        </div>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900/50">
              <div className="text-[9px] uppercase tracking-[0.1em] text-gray-500 dark:text-gray-400">Classified</div>
              <div className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                {classifiedCount}/{totalCount}
              </div>
            </div>
            <div
              className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900/50"
              aria-label={`Gross coverage ${
                liveExposureAvailable ? formatPercent(classifiedGrossPct) : 'Unavailable'
              }`}
            >
              <div className="text-[9px] uppercase tracking-[0.1em] text-gray-500 dark:text-gray-400">Gross coverage</div>
              <div className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                {liveExposureAvailable ? formatPercent(classifiedGrossPct) : 'Unavailable'}
              </div>
            </div>
            <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900/50">
              <div className="text-[9px] uppercase tracking-[0.1em] text-gray-500 dark:text-gray-400">Unclassified queue</div>
              <div className={`mt-0.5 text-sm font-semibold ${
                unclassifiedPositions.length > 0
                  ? 'text-amber-700 dark:text-amber-300'
                  : 'text-emerald-700 dark:text-emerald-300'
              }`}>
                {unclassifiedPositions.length}
              </div>
            </div>
            <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900/50">
              <div className="text-[9px] uppercase tracking-[0.1em] text-gray-500 dark:text-gray-400">Weighted analytics</div>
              <div className={`mt-0.5 text-sm font-semibold ${
                liveExposureAvailable
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-gray-600 dark:text-gray-300'
              }`}>
                {liveExposureAvailable ? 'Live' : 'Unavailable'}
              </div>
            </div>
          </div>

          {!liveExposureAvailable && (
            <div
              role="status"
              className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100"
            >
              <div className="font-semibold">No verified live portfolio exposure</div>
              <div className="mt-0.5">
                {error || availability.message || 'A fresh, socket-verified IBKR snapshot with live marks is required.'}
              </div>
              {positions.length > 0 && (
                <div className="mt-1 text-[10px] opacity-80">
                  Static reviewed labels remain visible below; weights and concentration are intentionally withheld.
                </div>
              )}
            </div>
          )}

          {!showSecurityMap && liveExposureAvailable && (
            <div>
              <div className="max-h-[430px] overflow-auto rounded-md border border-gray-200 custom-scrollbar dark:border-gray-700">
                <table className="min-w-[920px] w-full text-left text-[10px]" aria-label="Quad exposure summary">
                  <thead className="sticky top-0 z-10 bg-gray-50 text-[9px] uppercase tracking-[0.08em] text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                    <tr>
                      <th className="px-2 py-1.5">Exposure</th>
                      <th className="px-2 py-1.5">Dimension</th>
                      <th className="px-2 py-1.5 text-right">Long</th>
                      <th className="px-2 py-1.5 text-right">Short</th>
                      <th className="px-2 py-1.5 text-right">Gross</th>
                      <th className="px-2 py-1.5 text-right">Net</th>
                      <th className="px-2 py-1.5">{currentQuadLabel}</th>
                      <th className="px-2 py-1.5">Prior → current</th>
                      <th className="px-2 py-1.5">Alignment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {sortedExposures.map((exposure) => (
                      <tr key={exposure.exposureId || exposure.id} className="align-top hover:bg-gray-50 dark:hover:bg-gray-900/50">
                        <td className="px-2 py-1.5">
                          <div className="font-semibold text-gray-900 dark:text-gray-100">{exposure.label}</div>
                          <div className="mt-0.5 max-w-[230px] truncate text-[9px] text-gray-500 dark:text-gray-400" title={contributorText(exposure.contributors)}>
                            {exposure.positionCount || 0} positions · {contributorText(exposure.contributors)}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">
                          {DIMENSION_LABELS[exposure.dimension] || humanize(exposure.dimension)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-emerald-700 dark:text-emerald-300">
                          {formatPercent(exposure.longPct)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-red-700 dark:text-red-300">
                          {formatPercent(exposure.shortPct)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                          {formatPercent(exposure.grossPct)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-gray-700 dark:text-gray-200">
                          {formatPercent(exposure.netPct, { signed: true })}
                        </td>
                        <td className="px-2 py-1.5">{fitPill(exposure.currentFit, `${exposure.exposureId}-fit`)}</td>
                        <td className="px-2 py-1.5 text-gray-700 dark:text-gray-200">
                          {formatTransition(exposure.previousFit, exposure.currentFit, exposure.transition)}
                        </td>
                        <td className={`px-2 py-1.5 font-semibold ${
                          ALIGNMENT_CLASSES[exposure.alignment] || ALIGNMENT_CLASSES.unscored
                        }`}>
                          {humanize(exposure.alignment)}
                        </td>
                      </tr>
                    ))}
                    {sortedExposures.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">
                          No scored security exposures are available.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <Text className="mt-2 text-[10px] text-gray-500 dark:text-gray-400">
                Primary labels reconcile positions. Secondary labels are full-weight overlap lenses, so exposure rows are not additive and can total more than 100%.
              </Text>
            </div>
          )}

          {showSecurityMap && (
            <div>
              <div className="max-h-[470px] overflow-auto rounded-md border border-gray-200 custom-scrollbar dark:border-gray-700">
                <table className="min-w-[820px] w-full text-left text-[10px]" aria-label="Security exposure map">
                  <thead className="sticky top-0 z-10 bg-gray-50 text-[9px] uppercase tracking-[0.08em] text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                    <tr>
                      <th className="px-2 py-1.5">Security</th>
                      <th className="px-2 py-1.5">Side</th>
                      <th className="px-2 py-1.5 text-right">Weight</th>
                      <th className="px-2 py-1.5">Primary + overlaps</th>
                      <th className="px-2 py-1.5">Current fit</th>
                      <th className="px-2 py-1.5">Alignment</th>
                      <th className="px-2 py-1.5">Review</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {sortedPositions.map((position) => {
                      const identity = getPositionIdentity(position);
                      const labels = Array.isArray(position.labels) ? position.labels : [];
                      const primaryLabel = labels.find((label) => label.isPrimary) || labels[0];
                      return (
                        <tr key={position.positionKey} className="align-top hover:bg-gray-50 dark:hover:bg-gray-900/50">
                          <td className="px-2 py-1.5">
                            <div className="font-semibold text-gray-900 dark:text-gray-100">{identity.symbol}</div>
                            <div className="max-w-[190px] truncate text-[9px] text-gray-500 dark:text-gray-400" title={position.description || identity.contract}>
                              {position.description || identity.contract || position.positionKey}
                            </div>
                            {identity.contract && position.description && (
                              <div className="text-[9px] text-gray-400 dark:text-gray-500">{identity.contract}</div>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-gray-700 dark:text-gray-200">{humanize(position.side)}</td>
                          <td
                            className="px-2 py-1.5 text-right tabular-nums text-gray-700 dark:text-gray-200"
                            title={position.weightUnavailableReason || undefined}
                          >
                            {position.weightAvailability === false
                              ? 'Unavailable'
                              : formatPercent(position.weightPct, { signed: true })}
                          </td>
                          <td className="px-2 py-1.5">
                            {labels.length > 0 ? (
                              <div className="flex max-w-[320px] flex-wrap gap-1">
                                {labels.map((label, index) => (
                                  <span
                                    key={`${position.positionKey}-${label.exposureId}`}
                                    className={`rounded border px-1.5 py-0.5 ${
                                      label === primaryLabel || label.isPrimary
                                        ? 'border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-950'
                                        : 'border-gray-300 text-gray-700 dark:border-gray-600 dark:text-gray-200'
                                    }`}
                                    title={`${DIMENSION_LABELS[label.dimension] || humanize(label.dimension)} · ${
                                      label === primaryLabel || label.isPrimary ? 'Primary' : 'Overlap'
                                    } · ${formatQuadMap(label)}`}
                                  >
                                    {label.label}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="font-semibold text-amber-700 dark:text-amber-300">Unclassified</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex max-w-[280px] flex-col gap-1">
                              {labels.map((label) => (
                                <div
                                  key={`${position.positionKey}-${label.exposureId}-fit-row`}
                                  className="flex items-center justify-between gap-2"
                                  title={formatQuadMap(label)}
                                >
                                  <span className="max-w-[150px] truncate text-gray-600 dark:text-gray-300">
                                    {label.label}
                                  </span>
                                  {fitPill(
                                    label.currentFit,
                                    `${position.positionKey}-${label.exposureId}-fit`
                                  )}
                                </div>
                              ))}
                              {labels.length === 0 && <span className="text-gray-500 dark:text-gray-400">Unscored</span>}
                            </div>
                          </td>
                          <td className={`px-2 py-1.5 font-semibold ${
                            ALIGNMENT_CLASSES[position.alignment] || ALIGNMENT_CLASSES.unscored
                          }`}>
                            {humanize(position.alignment)}
                          </td>
                          <td className="px-2 py-1.5">
                            <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                              position.classificationStatus === 'reviewed'
                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                                : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                            }`}>
                              {position.classificationStatus === 'reviewed' ? 'Reviewed' : 'Needs review'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                    {sortedPositions.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">
                          No portfolio securities are available to classify.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <Text className="mt-2 text-[10px] text-gray-500 dark:text-gray-400">
                Reviewed taxonomy labels are static reference data. Portfolio weights appear only when the selected account has verified live marks.
              </Text>
            </div>
          )}
        </>
      )}
    </Card>
  );
};

export default PortfolioQuadExposureCard;
