import { useCallback, useEffect, useRef, useState } from 'react';
import { usePublishedQuadReadings } from './usePublishedQuadReadings';
import {
  PORTFOLIO_QUAD_READINGS_KEY,
  currentPortfolioQuadReadings,
  loadPortfolioQuadReadings,
  quadReadingDate,
} from '../utils/portfolioQuadReadings';

// The quad in force for each scope (U.S. Monthly, U.S. Quarterly, Global): the
// published reading unless a newer one was entered by hand. `update` records a
// manual reading for today; an empty value clears the scope.
export default function usePortfolioQuadReadings() {
  const published = usePublishedQuadReadings();
  const publishedRef = useRef(published);
  publishedRef.current = published;
  const [readings, setReadings] = useState(() => loadPortfolioQuadReadings(published));
  const [today, setToday] = useState(quadReadingDate);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    const refreshDate = () => setToday(quadReadingDate());
    const onStorage = (event) => {
      if (event.key === PORTFOLIO_QUAD_READINGS_KEY || event.key === null) setReadings(loadPortfolioQuadReadings(publishedRef.current));
    };
    const interval = window.setInterval(refreshDate, 60000);
    window.addEventListener('focus', refreshDate);
    window.addEventListener('storage', onStorage);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshDate);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => { if (published) setReadings(loadPortfolioQuadReadings(published)); }, [published]);

  const update = useCallback((scope, value) => {
    const updatedToday = quadReadingDate();
    setToday(updatedToday);
    setReadings((current) => {
      const updated = { ...current, [scope]: value ? { quad: Number(value), asOf: updatedToday, source: 'manual-hedgeye' } : null };
      try {
        window.localStorage.setItem(PORTFOLIO_QUAD_READINGS_KEY, JSON.stringify(updated));
        setSaveError(false);
      } catch (_error) {
        setSaveError(true);
      }
      return updated;
    });
  }, []);

  return { current: currentPortfolioQuadReadings(readings, today), update, saveError };
}
