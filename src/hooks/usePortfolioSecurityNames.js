import { useEffect, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';

const IDENTITY_BATCH_SIZE = 50;
const UNVERIFIED_FLAGS = ['mock', 'isMock', 'seed', 'seeded', 'isSeeded', 'synthetic', 'inferred', 'offline', 'disconnected'];
const UNAVAILABLE_STATES = ['unavailable', 'failed', 'error', 'offline', 'disconnected', 'mock', 'seeded'];
function invalidIdentity(value) {
  return value && (UNVERIFIED_FLAGS.some(flag => value[flag] === true)
    || value.connected === false || UNAVAILABLE_STATES.includes(value.status));
}

// Descriptive identities only. These never supply prices, research or sizing
// inputs, and a captured name always takes precedence in the report.
export default function usePortfolioSecurityNames(rows = []) {
  const [names, setNames] = useState({});
  const symbols = [...new Set(rows.filter(row => !row.securityName)
    .map(row => String(row.holding || '').trim().toUpperCase())
    .filter(symbol => /^[A-Z0-9][A-Z0-9.^=/_-]{0,31}$/.test(symbol)))].sort().join(',');
  useEffect(() => {
    if (!symbols) return undefined;
    let active = true;
    const controller = new AbortController();
    const requested = symbols.split(',');
    for (let offset = 0; offset < requested.length; offset += IDENTITY_BATCH_SIZE) {
      const batch = requested.slice(offset, offset + IDENTITY_BATCH_SIZE);
      MarketDataService.getSecurityIdentities(batch, { signal: controller.signal }).then(payload => {
        if (!active || !['available', 'partial'].includes(payload?.status) || invalidIdentity(payload)
          || payload.historicalOnly !== true || payload.executable !== false) return;
        const entries = (Array.isArray(payload.rows) ? payload.rows : []).filter(row => row && batch.includes(row.ticker)
          && row.nameVerified === true && !invalidIdentity(row) && row.identityStatus !== 'rejected'
          && typeof row.name === 'string' && row.name.trim() && row.name.trim().toUpperCase() !== row.ticker
          && typeof row.nameSource === 'string' && row.nameSource.trim());
        if (entries.length) setNames(previous => ({ ...previous,
          ...Object.fromEntries(entries.map(row => [row.ticker, { name: row.name.trim(), source: row.nameSource }])) }));
      }).catch(() => { /* Missing identity stays an em dash; other batches continue. */ });
    }
    return () => { active = false; controller.abort(); };
  }, [symbols]);
  return names;
}
