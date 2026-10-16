import React, { useEffect, useState } from 'react';
import { useGlobalQuads } from '../../hooks/useGlobalQuads';
import { previewQuarters } from '../../utils/globalQuadsPeriods';

const backend = () => process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
const BASELINE_TTL_MS = 5 * 60_000;
// The setup board reads quotes, research and every Kalshi series per call.
const SETUPS_TTL_MS = 15 * 60_000;

// The landing remounts each time a chat closes; share one read per TTL.
const cache = {};
const cached = (key, ttl, load) => {
  const entry = cache[key];
  if (entry && Date.now() - entry.at < ttl) return entry.promise;
  const promise = load().catch(error => { delete cache[key]; throw error; });
  cache[key] = { at: Date.now(), promise };
  return promise;
};
const getJson = async path => {
  const response = await fetch(`${backend()}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} unavailable`);
  return response.json();
};
const loadBaseline = () => cached('baseline', BASELINE_TTL_MS, () => getJson('/api/analyst/automation/portfolio-close/baseline'));
const loadSetups = () => cached('setups', SETUPS_TTL_MS, async () => {
  const board = await getJson('/api/prediction-markets/setup-board');
  return Array.isArray(board?.rows) ? board.rows.filter(row => row.setup?.side).length : null;
});

const easternClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const clockLabel = now => {
  const parts = Object.fromEntries(easternClock.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} · ${parts.hour}:${parts.minute} ET`;
};
const sessionLabel = date => (/^\d{4}-(\d{2})-(\d{2})$/.exec(date || '') || []).slice(1).join('/');

export function usQuad(snapshot, now = new Date()) {
  const group = snapshot?.data?.groups?.g20;
  const current = previewQuarters(group, now).find(column => column.period === 'current');
  const quad = group?.rows?.find(row => row.country === 'United States')?.values?.[current?.id]?.quad;
  return Number.isInteger(quad) && quad >= 1 && quad <= 4 ? quad : null;
}

function useLoaded(load) {
  const [value, setValue] = useState({ state: 'loading' });
  useEffect(() => {
    let live = true;
    load().then(data => live && setValue({ state: 'ready', data }), () => live && setValue({ state: 'failed' }));
    return () => { live = false; };
  }, [load]);
  return value;
}

const Item = ({ label, children, tone, title }) => <span className="analyst-landing-stat" title={title}>
  {label} <span className={tone ? `is-${tone}` : undefined}>{children}</span>
</span>;

export function AnalystLandingClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return <time className="analyst-landing-clock" dateTime={now.toISOString()}>{clockLabel(now)}</time>;
}

export default function AnalystLandingStatus({ holdingsCount }) {
  const quads = useGlobalQuads();
  const baseline = useLoaded(loadBaseline);
  const setups = useLoaded(loadSetups);
  const quad = usQuad(quads.data);
  const close = baseline.data;
  const verified = baseline.state === 'ready' && close?.status === 'ready';
  return <div className="analyst-landing-status" role="group" aria-label="Portfolio status">
    <Item label="HOLDINGS">{Number.isInteger(holdingsCount) ? holdingsCount : '—'}</Item>
    <Item label="VERIFIED" tone={verified ? 'positive' : close?.sessionDate ? 'warning' : undefined}
      title={verified ? `Holdings captured ${close.capturedAt}` : close?.reason}>
      {close?.sessionDate ? `CLOSE ${sessionLabel(close.sessionDate)}${verified ? '' : ' UNVERIFIED'}` : '—'}
    </Item>
    <Item label="REGIME">{quad ? `Q${quad}` : '—'}</Item>
    <Item label="OPEN SETUPS">{setups.state === 'ready' && Number.isInteger(setups.data) ? setups.data : '—'}</Item>
  </div>;
}
