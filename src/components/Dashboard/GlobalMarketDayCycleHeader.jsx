import React, { useEffect, useMemo, useState } from 'react';
import { utcToZonedTime, format } from 'date-fns-tz';
import { GLOBAL_MARKETS, getMarketStatus } from '../../constants/globalMarkets';
import './GlobalMarketDayCycleHeader.css';

const REGION_GROUPS = [
  { id: 'americas', label: 'Americas', codes: ['LA', 'CHI', 'NY'] },
  { id: 'europe', label: 'Europe', codes: ['LDN'] },
  { id: 'asia', label: 'Asia', codes: ['HK', 'TYO'] },
];

const isActiveStatus = (status) => ['open', 'pre-market', 'post-market'].includes(status);

const formatLocalTime = (now, timezone) => format(utcToZonedTime(now, timezone), 'HH:mm');

const GlobalMarketDayCycleHeader = ({ compact = false, className = '' }) => {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const groups = useMemo(() => REGION_GROUPS.map((group) => {
    const markets = group.codes
      .map((code) => GLOBAL_MARKETS.find((market) => market.code === code))
      .filter(Boolean)
      .map((market) => {
        const zonedTime = utcToZonedTime(now, market.timezone);
        const status = getMarketStatus(market, zonedTime);
        return {
          ...market,
          status,
          time: formatLocalTime(now, market.timezone),
        };
      });
    return {
      ...group,
      markets,
      active: markets.some((market) => isActiveStatus(market.status)),
    };
  }), [now]);

  return (
    <section
      className={`global-session-strip${compact ? ' global-session-strip--compact' : ''}${className ? ` ${className}` : ''}`}
      aria-label="Global market clocks"
    >
      <div className="global-session-strip__regions">
        {groups.map((group) => (
          <section
            key={group.id}
            className={`global-session-region global-session-region--${group.id}${group.active ? ' is-active' : ''}`}
            aria-label={`${group.label} market clocks`}
          >
            <div className="global-session-region__heading">
              <span>{group.label}</span>
            </div>
            <div
              className="global-session-region__cities"
              style={{ '--market-count': group.markets.length }}
            >
              {group.markets.map((market) => (
                <div
                  key={market.id}
                  className={`global-session-city global-session-city--${market.status}`}
                  aria-label={`${market.code} ${market.time}, ${market.status}`}
                  title={`${market.name} · ${market.status.replace('-', ' ')}`}
                >
                  <span>{market.code}</span>
                  <strong>{market.time}</strong>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
};

export { REGION_GROUPS, formatLocalTime, isActiveStatus };
export default GlobalMarketDayCycleHeader;
