import { useCallback, useMemo, useState } from 'react';
import { holdingMatchesFactorExposure } from '../../../utils/portfolioFactorExposure';
import {
  csvEscape, formatPct, getAssetClassAbbreviation, getPortfolioWeight, getQuadExposureLabels,
  getSecurityName, getSleeveForHolding, getVerifiedDayGainLossPercent, getVerifiedHoldingMark,
  isHistoricalReferenceMark,
} from './portfolioPositionsModel';

export function usePortfolioPositions({
  longs, shorts, totalValue, hasVerifiedPortfolioMarks, canUseHoldingForSizing, factorSelection,
}) {
  const {
    available: factorExposureAvailable,
    dimension: factorExposureDimension,
    id: selectedFactorExposureId,
  } = factorSelection;

  const [ledgerSearchFilter, setLedgerSearchFilter] = useState('');
  const [ledgerSortField, setLedgerSortField] = useState('weight');
  const [ledgerSleeveFilter, setLedgerSleeveFilter] = useState('all');
  const [longsBasisPoints, setLongsBasisPoints] = useState({});
  const [longsPercentPortfolio, setLongsPercentPortfolio] = useState({});
  const [shortsBasisPoints, setShortsBasisPoints] = useState({});
  const [shortsPercentPortfolio, setShortsPercentPortfolio] = useState({});
  const [editingPercentPortfolio, setEditingPercentPortfolio] = useState({});

  const calculateSharesFromBasisPoints = (holding, basisPoints, totalValue, isShort = false) => {
    if (!canUseHoldingForSizing(holding) || !basisPoints || !totalValue) return null;
    const price = parseFloat(holding.price);
    if (price === 0) return null;

    // Basis points to dollar amount: (basisPoints / 10000) * totalValue
    const dollarAmount = (parseFloat(basisPoints) / 10000) * totalValue;
    let shares = dollarAmount / price;

    // For shorts: positive basis points means increase short (sell more = negative shares)
    // Negative basis points means reduce short (buy back = positive shares)
    if (isShort) {
      shares = -shares; // Flip sign for shorts
    }

    return Math.round(shares);
  };

  const calculateSharesFromPercent = (holding, targetPercent, totalValue, isShort = false) => {
    if (
      !canUseHoldingForSizing(holding)
      || targetPercent === undefined
      || targetPercent === null
      || !totalValue
    ) return null;
    const price = parseFloat(holding.price);
    if (price === 0) return null;

    // Current % of portfolio - use rounded value to match what's displayed
    // This ensures the calculation matches user expectations from the UI
    const currentPercentRaw = totalValue > 0 ? ((Math.abs(holding.marketValue) / totalValue) * 100) : 0;
    const currentPercent = Math.round(currentPercentRaw * 100) / 100; // Round to 2 decimal places
    const targetPercentNum = parseFloat(targetPercent);

    // Round target to 2 decimal places as well for consistent comparison
    const targetPercentRounded = Math.round(targetPercentNum * 100) / 100;

    // Difference in percentage (using rounded values)
    const percentDiff = targetPercentRounded - currentPercent;

    // If no difference after rounding, return 0
    if (Math.abs(percentDiff) < 0.001) return 0;

    // Dollar amount needed: (percentDiff / 100) * totalValue
    const dollarAmount = (percentDiff / 100) * totalValue;
    let shares = dollarAmount / price;

    // For shorts: if target % is higher than current, we need to sell more (negative shares)
    // If target % is lower, we need to buy back (positive shares)
    if (isShort) {
      shares = -shares; // Flip sign for shorts
    }

    // Round shares, but ensure at least 1 or -1 if there's any non-zero diff
    // This prevents the counter showing 0 when the user has changed the target %
    if (shares > 0 && shares < 1) {
      return 1;
    } else if (shares < 0 && shares > -1) {
      return -1;
    }

    return Math.round(shares);
  };

  const getHoldingTargetPercent = useCallback((holding, isLongs) => {
    const percentPortfolioState = isLongs ? longsPercentPortfolio : shortsPercentPortfolio;
    const basisPointsState = isLongs ? longsBasisPoints : shortsBasisPoints;
    const absolutePct = getPortfolioWeight(holding, totalValue);
    if (absolutePct === null && percentPortfolioState[holding.symbol] === undefined) return null;
    const currentPct = isLongs ? absolutePct : -absolutePct;
    if (percentPortfolioState[holding.symbol] !== undefined) return Number(percentPortfolioState[holding.symbol]);
    if (basisPointsState[holding.symbol] !== undefined) return currentPct + (Number(basisPointsState[holding.symbol]) / 100);
    return currentPct;
  }, [longsBasisPoints, longsPercentPortfolio, shortsBasisPoints, shortsPercentPortfolio, totalValue]);

  const getResizeShares = (holding, isLongs) => {
    if (!canUseHoldingForSizing(holding)) return null;
    const percentPortfolioState = isLongs ? longsPercentPortfolio : shortsPercentPortfolio;
    const basisPointsState = isLongs ? longsBasisPoints : shortsBasisPoints;
    const targetPercent = percentPortfolioState[holding.symbol];
    const basisPoints = basisPointsState[holding.symbol];

    if (targetPercent !== undefined) {
      return calculateSharesFromPercent(holding, Math.abs(Number(targetPercent)), totalValue, !isLongs);
    }

    if (basisPoints) {
      return calculateSharesFromBasisPoints(holding, basisPoints, totalValue, !isLongs);
    }

    return 0;
  };

  const getActionForResize = (shares, isLongs, holding = null) => {
    if (shares === null || shares === undefined) {
      return {
        label: isHistoricalReferenceMark(holding) ? 'Reference only' : 'Unavailable',
        tone: 'neutral',
      };
    }
    const absShares = Math.abs(Number(shares) || 0);
    if (!absShares) return { label: 'Hold', tone: 'neutral' };

    if (isLongs) {
      return shares < 0
        ? { label: `Trim ${absShares}`, tone: 'trim' }
        : { label: `Add ${absShares}`, tone: 'add' };
    }

    return shares > 0
      ? { label: `Cover ${absShares}`, tone: 'add' }
      : { label: `Short ${absShares}`, tone: 'trim' };
  };

  const getDayGainLossPercent = (holding) => (
    getVerifiedDayGainLossPercent(holding, hasVerifiedPortfolioMarks)
  );

  const sortLedgerHoldings = useCallback((rows) => {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      const getValue = (holding) => {
        const weight = getPortfolioWeight(holding, totalValue);
        switch (ledgerSortField) {
          case 'ticker':
            return (holding.symbol || '').toUpperCase();
          case 'name':
            return getSecurityName(holding).toUpperCase();
          case 'dayGainLoss':
            return Math.abs(
              getVerifiedDayGainLossPercent(holding, hasVerifiedPortfolioMarks) || 0
            );
          case 'weight':
          default:
            return weight ?? Number.NEGATIVE_INFINITY;
        }
      };

      const aValue = getValue(a);
      const bValue = getValue(b);
      if (typeof aValue === 'string' || typeof bValue === 'string') {
        return String(aValue).localeCompare(String(bValue));
      }
      return Number(bValue) - Number(aValue);
    });
    return sorted;
  }, [hasVerifiedPortfolioMarks, ledgerSortField, totalValue]);

  const filterLedgerHoldings = useCallback((rows) => {
    const query = ledgerSearchFilter.trim().toLowerCase();
    return rows.filter(holding => {
      if (ledgerSleeveFilter !== 'all' && getSleeveForHolding(holding) !== ledgerSleeveFilter) return false;
      if (
        factorExposureAvailable
        && selectedFactorExposureId
        && !holdingMatchesFactorExposure(
          holding,
          factorExposureDimension,
          selectedFactorExposureId,
        )
      ) return false;
      if (!query) return true;
      const name = getSecurityName(holding).toLowerCase();
      const symbol = (holding.symbol || '').toLowerCase();
      return symbol.includes(query) || name.includes(query);
    });
  }, [
    factorExposureAvailable,
    factorExposureDimension,
    ledgerSearchFilter,
    ledgerSleeveFilter,
    selectedFactorExposureId,
  ]);

  const ledgerLongs = useMemo(() => {
    return sortLedgerHoldings(filterLedgerHoldings(longs));
  }, [filterLedgerHoldings, longs, sortLedgerHoldings]);

  const ledgerShorts = useMemo(() => {
    return sortLedgerHoldings(filterLedgerHoldings(shorts));
  }, [filterLedgerHoldings, shorts, sortLedgerHoldings]);

  const ledgerRows = useMemo(() => ([
    ...ledgerLongs.map((holding, index) => ({ holding, index, isLongs: true })),
    ...ledgerShorts.map((holding, index) => ({ holding, index, isLongs: false }))
  ]), [ledgerLongs, ledgerShorts]);

  const handleExportCsv = () => {
    const rows = [
      ['Rank', 'Ticker', 'Name', 'Side', 'Weight % (NAV)', 'Target % (NAV)', '+EV Exposure Labels', 'Exposure Ctrb', 'Resize (Shares)', 'Price', 'Day G/L (%)', 'Action']
    ];

    ledgerRows.forEach(({ holding, index, isLongs }) => {
      const currentPct = getPortfolioWeight(holding, totalValue);
      const targetPct = getHoldingTargetPercent(holding, isLongs);
      const exposureLabels = getQuadExposureLabels(holding);
      const shares = getResizeShares(holding, isLongs);
      const action = getActionForResize(shares, isLongs, holding);
      const mark = getVerifiedHoldingMark(holding, hasVerifiedPortfolioMarks);
      const dayGainLossPercent = getDayGainLossPercent(holding);

      rows.push([
        index + 1,
        holding.symbol || '',
        getSecurityName(holding),
        isLongs ? 'Long' : 'Short',
        currentPct === null ? '' : (isLongs ? currentPct : -currentPct).toFixed(2),
        Number.isFinite(targetPct) ? targetPct.toFixed(2) : '',
        exposureLabels.join(' · ') || 'Unclassified',
        currentPct === null ? '' : formatPct(isLongs ? currentPct : -currentPct, 1, { signed: true }),
        shares ?? '',
        mark === null ? '' : mark.value.toFixed(4),
        dayGainLossPercent === null ? '' : dayGainLossPercent.toFixed(2),
        action.label
      ]);
    });

    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `portfolio-construction-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const getTargetInputProps = (holding, isLongs, pctOfAccount) => {
    if (!canUseHoldingForSizing(holding)) return null;
    const percentPortfolioState = isLongs ? longsPercentPortfolio : shortsPercentPortfolio;
    const setPercentPortfolioState = isLongs ? setLongsPercentPortfolio : setShortsPercentPortfolio;
    const setBasisPointsState = isLongs ? setLongsBasisPoints : setShortsBasisPoints;
    const targetPercent = percentPortfolioState[holding.symbol];
    const displayPercent = targetPercent !== undefined ? Number(targetPercent) : (isLongs ? Number(pctOfAccount) : -Number(pctOfAccount));
    const editingKey = `${isLongs ? 'long' : 'short'}_${holding.symbol}`;
    const isEditing = editingPercentPortfolio[editingKey] !== undefined;

    const commitValue = (value) => {
      if (value === '') {
        setPercentPortfolioState(prev => {
          const next = { ...prev };
          delete next[holding.symbol];
          return next;
        });
        setBasisPointsState(prev => {
          const next = { ...prev };
          delete next[holding.symbol];
          return next;
        });
        return;
      }

      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        setPercentPortfolioState(prev => ({ ...prev, [holding.symbol]: Math.round(parsed * 100) / 100 }));
        setBasisPointsState(prev => {
          const next = { ...prev };
          delete next[holding.symbol];
          return next;
        });
      }
    };

    const bump = (direction) => {
      const current = Number(isEditing ? editingPercentPortfolio[editingKey] : displayPercent) || 0;
      const next = Math.round((current + direction * 0.01) * 100) / 100;
      setPercentPortfolioState(prev => ({ ...prev, [holding.symbol]: next }));
      if (isEditing) {
        setEditingPercentPortfolio(prev => ({ ...prev, [editingKey]: next.toFixed(2) }));
      }
    };

    return {
      value: isEditing ? editingPercentPortfolio[editingKey] : displayPercent.toFixed(2),
      onFocus: (e) => {
        setEditingPercentPortfolio(prev => ({ ...prev, [editingKey]: displayPercent.toFixed(2) }));
        e.target.select();
      },
      onChange: (e) => {
        if (e.target.value === '' || e.target.value === '-' || /^-?\d*\.?\d*$/.test(e.target.value)) {
          setEditingPercentPortfolio(prev => ({ ...prev, [editingKey]: e.target.value }));
        }
      },
      onBlur: (e) => {
        commitValue(e.target.value);
        setEditingPercentPortfolio(prev => {
          const next = { ...prev };
          delete next[editingKey];
          return next;
        });
      },
      onKeyDown: (e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setEditingPercentPortfolio(prev => {
            const next = { ...prev };
            delete next[editingKey];
            return next;
          });
          e.currentTarget.blur();
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          bump(e.key === 'ArrowUp' ? 1 : -1);
        }
      },
    };
  };

  const getRowPresentation = (holding, isLongs) => {
    const pctOfAccount = getPortfolioWeight(holding, totalValue);
    const assetClass = getAssetClassAbbreviation(holding);
    const shares = getResizeShares(holding, isLongs);
    const action = getActionForResize(shares, isLongs, holding);
    const mark = getVerifiedHoldingMark(holding, hasVerifiedPortfolioMarks);
    const dayGainLossPercent = getDayGainLossPercent(holding);
    const factorLabels = getQuadExposureLabels(holding);
    const factorExposureText = factorLabels.length > 0 ? factorLabels.join(' · ') : 'Unclassified';
    const compactActionLabel = action.label === 'Reference only'
      ? 'Ref only'
      : action.label === 'Unavailable'
        ? 'No live'
        : String(action.label || '—').split(/\s+/)[0];
    return { pctOfAccount, assetClass, shares, action, mark, dayGainLossPercent, factorLabels, factorExposureText, compactActionLabel };
  };

  return {
    longRows: ledgerLongs,
    shortRows: ledgerShorts,
    filters: {
      search: ledgerSearchFilter, sortField: ledgerSortField, sleeve: ledgerSleeveFilter,
      setSearch: setLedgerSearchFilter, setSortField: setLedgerSortField, setSleeve: setLedgerSleeveFilter,
    },
    targetControls: { getInputProps: getTargetInputProps },
    getRowPresentation,
    exportCsv: handleExportCsv,
    // The dormant legacy table reads these same bindings until its separate inventory.
    legacySizing: {
      longsBasisPoints, setLongsBasisPoints, longsPercentPortfolio, setLongsPercentPortfolio,
      shortsBasisPoints, setShortsBasisPoints, shortsPercentPortfolio, setShortsPercentPortfolio,
      editingPercentPortfolio, setEditingPercentPortfolio,
      calculateSharesFromBasisPoints, calculateSharesFromPercent,
    },
  };
}

export default usePortfolioPositions;
