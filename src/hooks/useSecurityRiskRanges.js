import { useEffect, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';

const BATCH_SIZE = 50;
const REFRESH_MS = 5 * 60_000;

// Each security's own published Risk Range from the central security record. A proxy
// or unmatched reading is another instrument's range, so that security shows none.
export function riskRangeFromRecord(record) {
  const field = record?.research?.riskRange;
  const low = Number(field?.value?.lrr);
  const high = Number(field?.value?.hrr);
  if (field?.status !== 'available' || field.match !== 'direct' || !(low > 0) || !(high > low)) return null;
  return { low, high, source: field.source || null, asOf: field.asOf || null, cadence: field.cadence || 'daily' };
}

export default function useSecurityRiskRanges(symbols = []) {
  const [ranges, setRanges] = useState({});
  const key = [...new Set(symbols.map(symbol => String(symbol || '').trim().toUpperCase()).filter(Boolean))].sort().join(',');
  useEffect(() => {
    if (!key) return undefined;
    let active = true;
    const controller = new AbortController();
    const load = () => {
      const requested = key.split(',');
      for (let offset = 0; offset < requested.length; offset += BATCH_SIZE) {
        Promise.resolve().then(() => MarketDataService.getSecurityRecords(requested.slice(offset, offset + BATCH_SIZE), { signal: controller.signal })).then(payload => {
          if (!active || !payload?.rows) return;
          setRanges(previous => ({ ...previous, ...Object.fromEntries(Object.entries(payload.rows).map(([symbol, record]) => [symbol, riskRangeFromRecord(record)])) }));
        }).catch(() => { /* A failed batch keeps its last ranges; the next refresh retries. */ });
      }
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [key]);
  return ranges;
}
