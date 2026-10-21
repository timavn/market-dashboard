import { useEffect, useState } from 'react';
import { publishedQuadReadings, quadReadingDate } from '../utils/portfolioQuadReadings';

const TTL_MS = 15 * 60_000;
let cache = null;

const load = () => {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.promise;
  const promise = Promise.resolve()
    .then(() => fetch(`${process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001'}/api/hedgeye/monthly-quad`, { cache: 'no-store' }))
    .then(response => {
      if (!response.ok) throw new Error('Monthly Quad unavailable');
      return response.json();
    })
    .catch(error => { cache = null; throw error; });
  cache = { at: Date.now(), promise };
  return promise;
};

// Readings parsed server-side from the subscriber's Hedgeye emails. Until they
// load, or if they cannot, the bundled published references stand.
export function usePublishedQuadReadings() {
  const [readings, setReadings] = useState(null);
  useEffect(() => {
    let live = true;
    load().then(payload => live && setReadings(publishedQuadReadings(payload, quadReadingDate())), () => {});
    return () => { live = false; };
  }, []);
  return readings;
}
