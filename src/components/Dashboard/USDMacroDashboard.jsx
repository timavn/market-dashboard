import React, { useState, useEffect, useCallback } from 'react';
import { Card, Title, Text } from '@tremor/react';
import USQuadChart from './USQuadChart';
import WelcomeToTheMachine from './WelcomeToTheMachine';
import MultiRegionMarketOverview from './MultiRegionMarketOverview';
import GlobalMarketDayCycleHeader from './GlobalMarketDayCycleHeader';
import StatusDot from '../common/StatusDot';
import { USDMarketService } from '../../services/api/usdMarketService';
import { MarketDataService } from '../../services/api/marketDataService';
import { REFRESH_INTERVALS } from '../../constants/usdMarket';
import { isTradingDay } from '../../utils/marketHolidays';

const NEW_YORK_TZ = 'America/New_York';
const NEW_YORK_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: NEW_YORK_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const NEW_YORK_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: NEW_YORK_TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const getFormatterParts = (formatter, date = new Date()) => {
  const parts = formatter.formatToParts(date);
  return parts.reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
};

const formatDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getDateFromDateKey = (dateKey) => {
  const [year, month, day] = dateKey.split('-').map((value) => Number(value));
  return new Date(year, month - 1, day, 12, 0, 0, 0);
};

const addDaysToDateKey = (dateKey, daysToAdd) => {
  const date = getDateFromDateKey(dateKey);
  date.setDate(date.getDate() + daysToAdd);
  return formatDateKey(date);
};

const getTodayDateKeyInNewYork = () => {
  const { year, month, day } = getFormatterParts(NEW_YORK_DATE_FORMATTER);
  return `${year}-${month}-${day}`;
};

const getRecentMarketDays = (count = 5) => {
  const days = [];
  let cursor = getDateFromDateKey(getTodayDateKeyInNewYork());

  while (days.length < count) {
    if (isTradingDay(cursor)) {
      const dateKey = formatDateKey(cursor);
      days.push({
        dateKey,
        label: cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      });
    }
    const previousDay = new Date(cursor);
    previousDay.setDate(previousDay.getDate() - 1);
    cursor = previousDay;
  }

  return days;
};

const getPreviousTradingDateKey = (dateKey) => {
  let cursor = getDateFromDateKey(dateKey);

  while (!isTradingDay(cursor)) {
    const previousDay = new Date(cursor);
    previousDay.setDate(previousDay.getDate() - 1);
    cursor = previousDay;
  }

  return formatDateKey(cursor);
};

const getEffectiveSnapshotDateKey = (snapshot) => {
  if (!snapshot?.date || typeof snapshot.date !== 'string') return null;
  return getPreviousTradingDateKey(snapshot.date);
};

const getCandidateDateKeysForMarketDay = (marketDayKey) => [
  marketDayKey,
  addDaysToDateKey(marketDayKey, 1),
  addDaysToDateKey(marketDayKey, 2)
];

const getMsUntilNextNewYorkMidnight = () => {
  const { hour, minute, second } = getFormatterParts(NEW_YORK_TIME_FORMATTER);
  const elapsedMs =
    Number(hour) * 60 * 60 * 1000 +
    Number(minute) * 60 * 1000 +
    Number(second) * 1000;
  const oneDayMs = 24 * 60 * 60 * 1000;
  return Math.max(1000, oneDayMs - elapsedMs + 1000);
};

const USDMacroDashboard = () => {
  const initialMarketDays = getRecentMarketDays(5);
  const [data, setData] = useState({
    dxy: null,
    currencyPairs: null,
    correlations: null,
    rollingStats: null,
    correlationsTimestamp: null,
    correlationsCalculationDate: null
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [marketDays, setMarketDays] = useState(initialMarketDays);
  const [macroShowRows, setMacroShowRows] = useState(
    initialMarketDays.map((day) => ({ ...day, snapshot: null }))
  );
  const [theCallRows, setTheCallRows] = useState(
    initialMarketDays.map((day) => ({ ...day, snapshot: null }))
  );

  const fetchUSDData = async () => {
    try {
      setError(null);
      const usdData = await USDMarketService.getAllUSDData();
      
      setData({
        dxy: usdData.dxy,
        currencyPairs: usdData.currencyPairs,
        correlations: usdData.correlations?.correlations || null,
        rollingStats: usdData.correlations?.rollingStats || null,
        correlationsTimestamp: usdData.correlations?.timestamp || null,
        correlationsCalculationDate: usdData.correlations?.calculationDate || null
      });
      
      setLastUpdated(new Date());
    } catch (err) {
      console.error('Error fetching USD data:', err);
      setError(err.message || 'Failed to fetch USD data');
    } finally {
      setLoading(false);
    }
  };

  const fetchShowData = useCallback(async (daysToFetch) => {
    const resolveSnapshotForRow = async (snapshotType, marketDayKey) => {
      const candidateDateKeys = getCandidateDateKeysForMarketDay(marketDayKey);

      for (const candidateDateKey of candidateDateKeys) {
        const snapshot = await MarketDataService.getHedgeyeSnapshot(
          snapshotType,
          candidateDateKey
        );
        if (!snapshot) continue;

        if (getEffectiveSnapshotDateKey(snapshot) === marketDayKey) {
          return snapshot;
        }
      }

      return null;
    };

    const [macroSnapshots, callSnapshots] = await Promise.all([
      Promise.all(
        daysToFetch.map((day) =>
          resolveSnapshotForRow('the-macro-show', day.dateKey)
        )
      ),
      Promise.all(
        daysToFetch.map((day) => resolveSnapshotForRow('the-call', day.dateKey))
      )
    ]);

    setMacroShowRows(
      daysToFetch.map((day, index) => ({
        ...day,
        snapshot:
          macroSnapshots[index] &&
          getEffectiveSnapshotDateKey(macroSnapshots[index]) === day.dateKey
            ? macroSnapshots[index]
            : null
      }))
    );
    setTheCallRows(
      daysToFetch.map((day, index) => ({
        ...day,
        snapshot:
          callSnapshots[index] &&
          getEffectiveSnapshotDateKey(callSnapshots[index]) === day.dateKey
            ? callSnapshots[index]
            : null
      }))
    );
  }, []);

  const refreshShowData = useCallback(async () => {
    const nextMarketDays = getRecentMarketDays(5);
    setMarketDays(nextMarketDays);
    await fetchShowData(nextMarketDays);
  }, [fetchShowData]);

  const getLatestScrapedAt = (rows) =>
    rows.find((row) => row?.snapshot?.scrapedAt)?.snapshot?.scrapedAt || null;

  // Initial data fetch
  useEffect(() => {
    fetchUSDData();
    refreshShowData();
  }, []);

  // Set up refresh interval
  useEffect(() => {
    const interval = setInterval(() => {
      fetchUSDData();
    }, REFRESH_INTERVALS.DASHBOARD);

    return () => clearInterval(interval);
  }, []);

  // Refresh Macro/The Call rows when a new New York market day starts
  useEffect(() => {
    let timeoutId;

    const scheduleMidnightRefresh = () => {
      const msUntilMidnight = getMsUntilNextNewYorkMidnight();
      timeoutId = setTimeout(async () => {
        await refreshShowData();
        scheduleMidnightRefresh();
      }, msUntilMidnight);
    };

    scheduleMidnightRefresh();
    return () => clearTimeout(timeoutId);
  }, [refreshShowData]);

  const getSideDisplayText = (row, side) => {
    const snapshot = row?.snapshot;
    if (!snapshot) return 'N/A';

    if (snapshot?.snapshotType === 'the-macro-show') {
      const rawMap = {
        long: snapshot?.data?.rawLongsText,
        short: snapshot?.data?.rawShortsText,
        neutral: snapshot?.data?.rawNeutralText
      };
      const rawValue = rawMap[side];
      if (typeof rawValue === 'string') {
        const trimmed = rawValue.trim();
        if (trimmed.length > 0) return trimmed;
      }
    }

    const valuesBySide = {
      long: snapshot?.data?.longs,
      short: snapshot?.data?.shorts,
      neutral: snapshot?.data?.neutrals
    };
    const values = valuesBySide[side];
    if (!Array.isArray(values) || values.length === 0) {
      return side === 'neutral' ? 'None' : 'No securities listed';
    }

    return values.join(', ');
  };

  const renderShowRows = (rows) =>
    rows.map((row, rowIndex) => {
      const longs = getSideDisplayText(row, 'long');
      const shorts = getSideDisplayText(row, 'short');
      const neutrals = getSideDisplayText(row, 'neutral');
      const isLongNA = longs === 'N/A';
      const isShortNA = shorts === 'N/A';
      const isNeutralNA = neutrals === 'N/A';
      const isLastRow = rowIndex === rows.length - 1;

      return (
        <div
          key={row.dateKey}
          className={`macro-call-day-row ${isLastRow ? 'last-row' : ''}`}
        >
          <div className="macro-call-day-block">{row.label}</div>
          <div className="macro-call-day-content">
            <div className="macro-call-day-line long">
              <span className="macro-call-side-label">Long</span>
              <span className={`macro-call-day-values ${isLongNA ? 'is-na' : ''}`}>{longs}</span>
            </div>
            <div className="macro-call-divider" />
            <div className="macro-call-day-line short">
              <span className="macro-call-side-label">Short</span>
              <span className={`macro-call-day-values ${isShortNA ? 'is-na' : ''}`}>{shorts}</span>
            </div>
            <div className="macro-call-divider" />
            <div className="macro-call-day-line neutral">
              <span className="macro-call-side-label">Neutral</span>
              <span className={`macro-call-day-values ${isNeutralNA ? 'is-na' : ''}`}>{neutrals}</span>
            </div>
          </div>
        </div>
      );
    });

  const latestMacroScrapedAt = getLatestScrapedAt(macroShowRows);
  const latestCallScrapedAt = getLatestScrapedAt(theCallRows);

  return (
    <div className="space-y-4">
      {/* Global Market Day-Cycle Header */}
      <GlobalMarketDayCycleHeader />

      {/* Banner with Title and Metric Bar */}
      <div className="relative rounded-lg">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <MultiRegionMarketOverview />
        </div>
      </div>

      {/* MACRO and THE CALL - Side by Side */}
      <div className="flex flex-col md:flex-row gap-4" style={{ alignItems: 'stretch' }}>
        {/* Left: MACRO SHOW */}
        <div className="flex-1 macro-call-card">
          <div className="region-chart-header">
            <StatusDot
              updatedAt={latestMacroScrapedAt}
              status={latestMacroScrapedAt ? 'active' : undefined}
              size={10}
              className="mr-1"
              label="Macro Show"
              emoji={latestMacroScrapedAt ? '🟢' : '⚪'}
            />
            <span className="region-label dark:text-white">MACRO SHOW</span>
          </div>
          <div className="macro-call-body macro-call-body-days">
            {renderShowRows(macroShowRows.length > 0 ? macroShowRows : marketDays.map((day) => ({ ...day, snapshot: null })))}
          </div>
        </div>

        {/* Right: THE CALL */}
        <div className="flex-1 macro-call-card">
          <div className="region-chart-header">
            <StatusDot
              updatedAt={latestCallScrapedAt}
              status={latestCallScrapedAt ? 'active' : undefined}
              size={10}
              className="mr-1"
              label="The Call"
              emoji={latestCallScrapedAt ? '🟢' : '⚪'}
            />
            <span className="region-label dark:text-white">THE CALL</span>
          </div>
          <div className="macro-call-body macro-call-body-days">
            {renderShowRows(theCallRows.length > 0 ? theCallRows : marketDays.map((day) => ({ ...day, snapshot: null })))}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {/* US Quad Charts Section */}
        <USQuadChart />

        {/* Welcome to the Machine Section */}
        <WelcomeToTheMachine />
      </div>

      {/* Error overlay */}
      {error && (
        <Card className="bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800 rounded-lg">
          <Title className="text-red-600 dark:text-red-400">Error Loading USD Data</Title>
          <Text className="mb-4 dark:text-gray-300">{error}</Text>
        </Card>
      )}
    </div>
  );
};

export default USDMacroDashboard;
