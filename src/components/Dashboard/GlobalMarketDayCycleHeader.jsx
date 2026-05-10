import React, { useEffect, useMemo, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sun, Moon, X, Globe } from 'lucide-react';
import { utcToZonedTime, format } from 'date-fns-tz';
import { GLOBAL_MARKETS, getMarketStatus, getMarketCountdown, US_MARKET_HOLIDAYS, UK_MARKET_HOLIDAYS, JP_MARKET_HOLIDAYS, HK_MARKET_HOLIDAYS, isMarketHoliday } from '../../constants/globalMarkets';

/**
 * Check if a timezone is currently in daytime (6 AM - 6 PM)
 */
const isLocalDaytime = (timezone, now) => {
  const zonedTime = utcToZonedTime(now, timezone);
  const hour = zonedTime.getHours();
  return hour >= 6 && hour < 18;
};

/**
 * Get the UTC offset label for a timezone (e.g., "UTC -5")
 */
const getUTCOffsetLabel = (timezone, now) => {
  // Use format with 'xxx' pattern to get offset like '-08:00' or '+09:00'
  const offsetString = format(now, 'xxx', { timeZone: timezone });
  
  // Parse the offset string (e.g., '-08:00' -> -8, '+09:00' -> 9)
  const match = offsetString.match(/([+-])(\d{2}):(\d{2})/);
  if (!match) return 'UTC 0';
  
  const sign = match[1] === '+' ? '+' : '';
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  const offsetHours = sign === '+' ? hours + minutes / 60 : -(hours + minutes / 60);
  
  // Round to nearest integer (most offsets are whole hours)
  const roundedOffset = Math.round(offsetHours);
  return `UTC ${sign}${roundedOffset}`;
};

/**
 * Format time in HH:mm format for a specific timezone
 */
const formatLocalTime = (now, timezone) => {
  return format(utcToZonedTime(now, timezone), 'HH:mm');
};

/**
 * Get the day offset for a city relative to UTC
 * Returns: -1 (yesterday), 0 (today), +1 (tomorrow)
 */
const getDayOffset = (timezone, now) => {
  const zonedTime = utcToZonedTime(now, timezone);
  
  // Get date strings in YYYY-MM-DD format for comparison
  const utcDateStr = format(now, 'yyyy-MM-dd', { timeZone: 'UTC' });
  const zonedDateStr = format(zonedTime, 'yyyy-MM-dd');
  
  if (zonedDateStr === utcDateStr) return 0;
  
  // Compare dates
  const utcParts = utcDateStr.split('-').map(Number);
  const zonedParts = zonedDateStr.split('-').map(Number);
  
  const utcDateObj = new Date(utcParts[0], utcParts[1] - 1, utcParts[2]);
  const zonedDateObj = new Date(zonedParts[0], zonedParts[1] - 1, zonedParts[2]);
  
  const diffMs = zonedDateObj - utcDateObj;
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  
  // Clamp to -1, 0, or 1 (shouldn't be more than 1 day difference)
  return Math.max(-1, Math.min(1, diffDays));
};

/**
 * Get day label for a city (formatted date like "Jan 15")
 */
const getDayLabel = (timezone, now) => {
  const zonedTime = utcToZonedTime(now, timezone);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[zonedTime.getMonth()];
  const day = zonedTime.getDate();
  return `${month} ${day}`;
};

/**
 * Get the appropriate holiday list for a market
 */
const getMarketHolidaysLocal = (market) => {
  switch (market.id) {
    case 'nyc':
    case 'chi':
    case 'lax':
      return US_MARKET_HOLIDAYS;
    case 'lon':
      return UK_MARKET_HOLIDAYS;
    case 'tyo':
      return JP_MARKET_HOLIDAYS;
    case 'hkg':
      return HK_MARKET_HOLIDAYS;
    default:
      return [];
  }
};

/**
 * Convert local market hours to UTC time ranges
 * Returns array of segments: [{ start: 0-1440, end: 0-1440, type: 'pre-market'|'regular'|'post-market' }]
 */
const getMarketHoursInUTC = (market, now) => {
  const segments = [];
  const zonedTime = utcToZonedTime(now, market.timezone);
  const dayOfWeek = zonedTime.getDay();

  // Weekend - no segments
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return [];
  }

  // Holiday check - no segments on holidays
  const holidays = getMarketHolidaysLocal(market);
  if (isMarketHoliday(zonedTime, holidays)) {
    return [];
  }

  // Get the date components in the market's timezone
  const year = zonedTime.getFullYear();
  const month = zonedTime.getMonth();
  const day = zonedTime.getDate();

  // Calculate UTC offset by comparing current UTC time with zoned time
  const currentZoned = utcToZonedTime(now, market.timezone);
  const currentUTCHours = now.getUTCHours();
  const currentZonedHours = currentZoned.getHours();
  const hourOffset = currentZonedHours - currentUTCHours;
  
  // Handle day boundary crossing
  const currentZonedDate = currentZoned.getDate();
  const currentUTCDate = now.getUTCDate();
  const dayOffset = currentZonedDate - currentUTCDate;
  const totalOffset = hourOffset + (dayOffset * 24);
  
  // Convert local time to UTC
  const localToUTC = (localHour, localMinute) => {
    let utcHour = localHour - totalOffset;
    // Normalize to 0-23 range
    while (utcHour < 0) utcHour += 24;
    while (utcHour >= 24) utcHour -= 24;
    return utcHour * 60 + localMinute;
  };

  // Pre-market segment
  if (market.preMarketOpen) {
    const preStart = localToUTC(market.preMarketOpen.hour, market.preMarketOpen.minute);
    const preEnd = localToUTC(market.marketOpen.hour, market.marketOpen.minute);
    segments.push({ start: preStart, end: preEnd, type: 'pre-market' });
  }

  // Regular trading hours
  const regStart = localToUTC(market.marketOpen.hour, market.marketOpen.minute);
  const regEnd = localToUTC(market.marketClose.hour, market.marketClose.minute);
  segments.push({ start: regStart, end: regEnd, type: 'regular' });

  // Post-market segment
  if (market.postMarketClose) {
    const postStart = localToUTC(market.marketClose.hour, market.marketClose.minute);
    const postEnd = localToUTC(market.postMarketClose.hour, market.postMarketClose.minute);
    segments.push({ start: postStart, end: postEnd, type: 'post-market' });
  }

  // Handle wrap-around (segments that cross midnight)
  return segments.map(seg => {
    if (seg.end < seg.start) {
      // Wraps around midnight - split into two segments
      return [
        { start: seg.start, end: 1440, type: seg.type },
        { start: 0, end: seg.end, type: seg.type }
      ];
    }
    return seg;
  }).flat();
};

/**
 * Count currently open markets (including pre/post market as "active")
 */
const getOpenMarketsCount = (markets, now) => {
  return markets.filter(market => {
    const zonedTime = utcToZonedTime(now, market.timezone);
    const status = getMarketStatus(market, zonedTime);
    return status === 'open' || status === 'pre-market' || status === 'post-market';
  }).length;
};

/**
 * Get city name from market code
 */
const getCityName = (code) => {
  const cityMap = {
    'NY': 'New York',
    'CHI': 'Chicago',
    'LA': 'Los Angeles',
    'LDN': 'London',
    'HK': 'Hong Kong',
    'TYO': 'Tokyo'
  };
  return cityMap[code] || code;
};

/**
 * Get next market event (open or close) with countdown
 */
const getNextMarketEvent = (markets, now) => {
  let nextEvent = null;
  let minMinutes = Infinity;

  markets.forEach(market => {
    const zonedTime = utcToZonedTime(now, market.timezone);
    const status = getMarketStatus(market, zonedTime);
    const dayOfWeek = zonedTime.getDay();
    const currentMinutes = zonedTime.getHours() * 60 + zonedTime.getMinutes();

    // Skip weekends and holidays
    if (dayOfWeek === 0 || dayOfWeek === 6 || status === 'holiday') {
      return;
    }

    const openMinutes = market.marketOpen.hour * 60 + market.marketOpen.minute;
    const closeMinutes = market.marketClose.hour * 60 + market.marketClose.minute;

    if (status === 'open') {
      // Next event is close
      let minutesUntilClose = closeMinutes - currentMinutes;
      if (minutesUntilClose < 0) minutesUntilClose += 1440;
      
      if (minutesUntilClose < minMinutes) {
        minMinutes = minutesUntilClose;
        nextEvent = {
          market: market.code,
          marketName: getCityName(market.code),
          action: 'closes',
          minutes: minutesUntilClose
        };
      }
    } else if (status === 'pre-market') {
      // Next event is open
      let minutesUntilOpen = openMinutes - currentMinutes;
      if (minutesUntilOpen < 0) minutesUntilOpen += 1440;
      
      if (minutesUntilOpen < minMinutes) {
        minMinutes = minutesUntilOpen;
        nextEvent = {
          market: market.code,
          marketName: getCityName(market.code),
          action: 'opens',
          minutes: minutesUntilOpen
        };
      }
    } else if (status === 'post-market') {
      // Next event is post-market close
      if (market.postMarketClose) {
        const postCloseMinutes = market.postMarketClose.hour * 60 + market.postMarketClose.minute;
        let minutesUntilPostClose = postCloseMinutes - currentMinutes;
        if (minutesUntilPostClose < 0) minutesUntilPostClose += 1440;
        
        if (minutesUntilPostClose < minMinutes) {
          minMinutes = minutesUntilPostClose;
          nextEvent = {
            market: market.code,
            marketName: getCityName(market.code),
            action: 'post-market ends',
            minutes: minutesUntilPostClose
          };
        }
      }
    } else {
      // Closed - find next open
      let minutesUntilOpen = openMinutes - currentMinutes;
      if (minutesUntilOpen <= 0) {
        // Opens tomorrow
        minutesUntilOpen += 1440;
      }
      
      if (minutesUntilOpen < minMinutes) {
        minMinutes = minutesUntilOpen;
        nextEvent = {
          market: market.code,
          marketName: getCityName(market.code),
          action: 'opens',
          minutes: minutesUntilOpen
        };
      }
    }
  });

  if (!nextEvent) return null;

  const hours = Math.floor(nextEvent.minutes / 60);
  const minutes = nextEvent.minutes % 60;
  let timeStr = '';
  if (hours > 0) {
    timeStr = `${hours}h ${minutes}m`;
  } else {
    timeStr = `${minutes}m`;
  }

  return {
    ...nextEvent,
    timeStr
  };
};

/**
 * Status dot component - using emoji for high-quality shiny look
 */
const StatusDot = ({ status }) => {
  const statusEmojis = {
    'open': '🟢', // Green circle emoji
    'pre-market': '🔵', // Blue circle emoji
    'post-market': '🔵', // Blue circle emoji
    'holiday': '🔴', // Red circle emoji for holidays
    'closed': '🔴' // Red circle emoji
  };

  return (
    <span className="text-[8px] leading-none">{statusEmojis[status] || statusEmojis.closed}</span>
  );
};

/**
 * Living Sky Ribbon - Animated Sun and Moon moving across 24-hour UTC cycle
 */
const LivingSkyRibbon = ({ now }) => {
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Update container width on mount and resize using ResizeObserver
  useEffect(() => {
    if (!containerRef.current) return;
    
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
    };
    
    // Initial measurement
    updateWidth();
    
    // Use ResizeObserver for better reliability
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(containerRef.current);
    
    // Fallback to window resize
    window.addEventListener('resize', updateWidth);
    
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, []);

  // Calculate horizontal position based on UTC time (0% at 00:00, 100% at 23:59)
  const celestialPosition = useMemo(() => {
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const totalMinutes = utcHours * 60 + utcMinutes;
    const xPercent = (totalMinutes / 1440) * 100;
    
    // Calculate arc height (peaks at 50% horizontal position, which is 12:00 PM UTC)
    // Maximum arc height: 10px upward
    const maxArcHeight = 10;
    const distanceFromCenter = Math.abs(xPercent - 50) / 50;
    const arcHeight = -maxArcHeight * (1 - distanceFromCenter * distanceFromCenter);
    
    return { xPercent, arcHeight };
  }, [now]);

  // Calculate opacity based on UTC time
  const celestialOpacity = useMemo(() => {
    const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    
    // Sun opacity: 1.0 between 06:00-18:00 UTC, fade to 0.0 at night
    let sunOpacity;
    if (utcHour >= 6 && utcHour < 18) {
      sunOpacity = 1.0;
    } else if (utcHour < 6) {
      // Fade in from midnight to 6 AM
      sunOpacity = Math.max(0, utcHour / 6);
    } else {
      // Fade out from 6 PM to midnight
      sunOpacity = Math.max(0, (24 - utcHour) / 6);
    }
    
    // Moon opacity: inverse of sun (1.0 between 18:00-06:00 UTC)
    const moonOpacity = 1 - sunOpacity;
    
    return { sunOpacity, moonOpacity };
  }, [now]);

  // Icon size
  const iconSize = 20;

  return (
    <div 
      ref={containerRef}
      className="absolute top-0 left-0 right-0 pointer-events-none"
      style={{ height: '60px', overflow: 'visible', zIndex: 5 }}
    >
      {/* Translucent background - only covers the 40px ribbon */}
      <div className="absolute top-0 left-0 right-0 h-[40px] bg-white/5 dark:bg-black/20" />
    </div>
  );
};

/**
 * Day/Night Overlay - Shows global day/night cycle with glow and stars
 */
const DayNightOverlay = ({ now }) => {
  // Calculate day/night positions based on UTC
  // Create a smooth gradient representing global day/night cycle
  const dayNightGradient = useMemo(() => {
    const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    // Daylight center shifts - approximate global noon
    const daylightCenter = 12;
    
    // Create smooth gradient stops
    const stops = [];
    const numStops = 48; // More stops for smoother gradient
    
    for (let i = 0; i <= numStops; i++) {
      const position = (i / numStops) * 100;
      // Calculate hour at this position (accounting for current UTC time)
      const hourAtPosition = (utcHour + (i / numStops) * 24) % 24;
      
      // Calculate distance from noon (with wrap-around)
      let distanceFromNoon = Math.abs(hourAtPosition - daylightCenter);
      if (distanceFromNoon > 12) distanceFromNoon = 24 - distanceFromNoon;
      
      // Day intensity: peaks at noon, fades to night
      // Use a smooth curve (cosine-based for natural transition)
      const normalizedDistance = distanceFromNoon / 6; // 6 hours = full day/night transition
      const dayIntensity = Math.max(0, Math.cos(normalizedDistance * Math.PI / 2));
      
      // Day areas: warm golden glow (light theme)
      // Night areas: light blue/gray
      if (dayIntensity > 0.15) {
        const glowIntensity = dayIntensity * 0.6;
        stops.push(`${position}% rgba(251, 191, 36, ${glowIntensity})`);
      } else {
        const nightIntensity = 0.4 + (dayIntensity * 0.3);
        stops.push(`${position}% rgba(147, 197, 253, ${nightIntensity})`);
      }
    }
    
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }, [now]);

  // Generate star positions for night areas
  const stars = useMemo(() => {
    const starCount = 40;
    const starArray = [];
    for (let i = 0; i < starCount; i++) {
      const position = Math.random() * 100; // Random position along timeline
      const size = Math.random() * 2 + 0.5; // Random size 0.5-2.5px
      const opacity = Math.random() * 0.6 + 0.3; // Random opacity 0.3-0.9
      const utcHour = (now.getUTCHours() + (position / 100) * 24) % 24;
      
      // Only show stars in night areas (roughly 6 PM - 6 AM UTC)
      const isNight = utcHour < 6 || utcHour >= 18;
      if (isNight) {
        starArray.push({ position, size, opacity });
      }
    }
    return starArray;
  }, [now]);

  return (
    <div className="absolute bottom-0 left-0 right-0 h-4 pointer-events-none overflow-hidden">
      {/* Day/Night gradient overlay - Light theme */}
      <div
        className="absolute inset-0"
        style={{
          background: dayNightGradient,
          mixBlendMode: 'multiply',
          opacity: 0.6
        }}
      />
      
      {/* Enhanced glow for daytime areas - Light theme */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(
              ellipse 100% 200% at 50% 50%,
              rgba(251, 191, 36, 0.6) 0%,
              rgba(251, 191, 36, 0.3) 30%,
              rgba(251, 191, 36, 0.15) 50%,
              transparent 75%
            )
          `,
          mixBlendMode: 'screen',
          opacity: 0.95
        }}
      />
      
      {/* Additional bright center glow - Light theme */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(
              ellipse 60% 150% at 50% 40%,
              rgba(255, 255, 255, 0.3) 0%,
              rgba(251, 191, 36, 0.2) 30%,
              transparent 60%
            )
          `,
          mixBlendMode: 'screen'
        }}
      />
      
      {/* Stars in night areas - Bright white stars for dark background */}
      {stars.map((star, idx) => {
        const utcHour = (now.getUTCHours() + (star.position / 100) * 24) % 24;
        const isNight = utcHour < 6 || utcHour >= 18;
        if (!isNight) return null;
        
        return (
          <div
            key={`star-${idx}`}
            className="absolute bottom-1/2 rounded-full bg-white"
            style={{
              left: `${star.position}%`,
              width: `${star.size}px`,
              height: `${star.size}px`,
              opacity: star.opacity * 0.9,
              transform: 'translateY(50%)',
              boxShadow: `0 0 ${star.size * 2}px rgba(255, 255, 255, 0.8)`
            }}
          />
        );
      })}
    </div>
  );
};

/**
 * Timeline Ribbon Component - Shows market hours as colored segments
 * Simplified and more informative design
 */
const TimelineRibbon = ({ markets, now }) => {
  const segments = useMemo(() => {
    const allSegments = [];
    markets.forEach(market => {
      const marketSegments = getMarketHoursInUTC(market, now);
      marketSegments.forEach(seg => {
        allSegments.push({ ...seg, market: market.code, marketId: market.id, marketName: market.name });
      });
    });
    return allSegments;
  }, [markets, now]);

  // More vibrant, distinct colors for light theme
  const segmentColors = {
    'pre-market': '#fbbf24', // amber-400
    'regular': '#10b981', // emerald-500
    'post-market': '#f97316' // orange-500
  };

  const segmentBorders = {
    'pre-market': '#f59e0b', // amber-500
    'regular': '#059669', // emerald-600
    'post-market': '#ea580c' // orange-600
  };

  return (
    <div className="absolute bottom-0 left-0 right-0 h-5 pointer-events-none z-0 border-t border-gray-300">
      {/* Base light background */}
      <div className="absolute inset-0 bg-gray-50" />
      
      {/* Market hour segments - More visible and distinct */}
      {segments.map((seg, idx) => {
        const leftPercent = (seg.start / 1440) * 100;
        const widthPercent = ((seg.end - seg.start) / 1440) * 100;
        const isRegular = seg.type === 'regular';
        
        return (
          <div
            key={`${seg.marketId}-${seg.type}-${idx}`}
            className="absolute bottom-0 h-full z-10"
            style={{
              left: `${leftPercent}%`,
              width: `${widthPercent}%`,
              backgroundColor: segmentColors[seg.type] || 'transparent',
              borderTop: `2px solid ${segmentBorders[seg.type] || 'transparent'}`,
              opacity: isRegular ? 0.7 : 0.5,
              boxShadow: isRegular ? 'inset 0 1px 2px rgba(0,0,0,0.1)' : 'none'
            }}
            title={`${seg.market} - ${seg.type.replace('-', ' ')}`}
          />
        );
      })}
      
      {/* Subtle day/night indication - Simplified */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          background: `
            linear-gradient(
              to right,
              rgba(147, 197, 253, 0.3) 0%,
              rgba(251, 191, 36, 0.2) 50%,
              rgba(147, 197, 253, 0.3) 100%
            )
          `
        }}
      />
    </div>
  );
};

/**
 * Midnight UTC Marker - Marks the date change (00:00 UTC)
 */
const MidnightMarker = ({ now }) => {
  const dateString = useMemo(() => {
    // Format UTC date directly
    const utcDate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    ));
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[now.getUTCMonth()];
    const day = now.getUTCDate();
    return `${month} ${day}`;
  }, [now]);

  // Midnight UTC is always at 0% (left edge)
  return (
    <div
      className="absolute top-0 bottom-0 w-[1px] pointer-events-none z-5"
      style={{ left: '0%' }}
    >
      {/* Vertical line */}
      <div className="absolute inset-0 bg-gradient-to-b from-blue-400 via-blue-300 to-blue-400 opacity-60" />
      
      {/* Date label at top - Light theme */}
      <div className="absolute top-0 left-2 bg-blue-500 text-white text-[9px] px-1.5 py-0.5 rounded-b whitespace-nowrap font-semibold shadow-sm">
        {dateString}
      </div>
      
      {/* "00:00" label vertically along the line - Light theme */}
      <div 
        className="absolute left-2 top-1/2 -translate-y-1/2 flex flex-col items-center gap-0.5"
        style={{ fontFamily: 'monospace' }}
      >
        {['0', '0', ':', '0', '0'].map((char, idx) => (
          <div
            key={`midnight-${char}-${idx}`}
            className="text-blue-600 font-bold leading-none"
            style={{
              fontSize: '9px',
              textShadow: '0 0 2px rgba(37, 99, 235, 0.5)'
            }}
          >
            {char}
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * UTC Time Marker - Fixed vertical line showing current UTC time
 */
const UTCTimeMarker = ({ now }) => {
  const utcPercent = useMemo(() => {
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const totalMinutes = utcHours * 60 + utcMinutes;
    return (totalMinutes / 1440) * 100;
  }, [now]);

  const utcTimeString = useMemo(() => {
    const hours = now.getUTCHours().toString().padStart(2, '0');
    const minutes = now.getUTCMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }, [now]);

  // Split time into individual characters for vertical display
  const timeChars = utcTimeString.split('');

  return (
    <div
      className="absolute top-0 bottom-0 w-[2px] pointer-events-none z-0"
      style={{ left: `${utcPercent}%` }}
    >
      <div className="absolute inset-0" style={{ backgroundColor: '#dc2626' }} />
      
      {/* UTC label - Left side of bar, at top */}
      <div 
        className="absolute top-0 right-full mr-2 flex items-center"
        style={{ fontFamily: 'monospace' }}
      >
        <div
          className="text-red-600 font-bold leading-none whitespace-nowrap"
          style={{
            fontSize: '9px',
            letterSpacing: '0.5px'
          }}
        >
          UTC
        </div>
      </div>
      
      {/* Time display - Right side of bar, at top, horizontal */}
      <div 
        className="absolute top-0 left-full ml-2 flex items-center gap-0.5"
        style={{ fontFamily: 'monospace' }}
      >
        {timeChars.map((char, idx) => (
          <div
            key={`${char}-${idx}`}
            className="text-red-600 font-bold leading-none"
            style={{
              fontSize: '10px'
            }}
          >
            {char}
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * Market Detail Modal Component - Positioned directly below clicked element
 */
const MarketDetailModal = ({ market, now, isOpen, onClose, anchorElement }) => {
  const zonedTime = utcToZonedTime(now, market.timezone);
  const status = getMarketStatus(market, zonedTime);
  const localTime = formatLocalTime(now, market.timezone);
  const utcOffset = getUTCOffsetLabel(market.timezone, now);
  const countdown = getMarketCountdown(market, zonedTime, status);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  // Calculate position based on anchor element
  useEffect(() => {
    if (anchorElement && isOpen) {
      const rect = anchorElement.getBoundingClientRect();
      const scrollY = window.scrollY || window.pageYOffset;
      const scrollX = window.scrollX || window.pageXOffset;
      
      // Modal dimensions (approximate)
      const modalWidth = 384; // max-w-md = 28rem = 448px, but we'll use 384px as estimate
      const modalHeight = 300; // Approximate height
      
      // Calculate initial position (directly below, centered)
      let top = rect.bottom + scrollY + 8;
      let left = rect.left + scrollX + (rect.width / 2);
      
      // Adjust if modal would go off right edge
      if (left + (modalWidth / 2) > window.innerWidth + scrollX) {
        left = window.innerWidth + scrollX - (modalWidth / 2) - 16;
      }
      // Adjust if modal would go off left edge
      if (left - (modalWidth / 2) < scrollX) {
        left = scrollX + (modalWidth / 2) + 16;
      }
      
      // Adjust if modal would go off bottom edge (flip above)
      if (top + modalHeight > window.innerHeight + scrollY) {
        top = rect.top + scrollY - modalHeight - 8;
      }
      
      setPosition({ top, left });
    }
  }, [anchorElement, isOpen]);

  const formatTime = (timeObj) => {
    if (!timeObj) return 'N/A';
    const hour = timeObj.hour.toString().padStart(2, '0');
    const minute = timeObj.minute.toString().padStart(2, '0');
    return `${hour}:${minute}`;
  };

  // Close on escape key or click outside
  useEffect(() => {
    if (!isOpen) return;
    
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose();
    };
    
    const handleClickOutside = (e) => {
      // Close if clicking outside the modal
      if (!e.target.closest('[data-market-modal]')) {
        onClose();
      }
    };
    
    // Small delay to prevent immediate close on the click that opened it
    const timeoutId = setTimeout(() => {
      window.addEventListener('keydown', handleEscape);
      document.addEventListener('click', handleClickOutside);
    }, 100);
    
    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('keydown', handleEscape);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          data-market-modal
          initial={{ opacity: 0, scale: 0.95, y: -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -10 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed bg-[#f8f6ef] border border-[#d6d0c3] rounded-lg shadow-2xl z-[9999] p-6 min-w-[320px] max-w-md"
          style={{
            top: `${position.top}px`,
            left: `${position.left}px`,
            transform: 'translateX(-50%)', // Center horizontally on the anchor point
          }}
          onClick={(e) => e.stopPropagation()}
        >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-black mb-1">{market.name}</h3>
                <div className="flex items-center gap-2">
                  <StatusDot status={status} />
                  <span className="text-sm text-black capitalize">{status.replace('-', ' ')}</span>
                </div>
              </div>
              <button
                onClick={onClose}
                className="text-gray-500 hover:text-black transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-[#4b5563]">Local Time</span>
                <span className="text-black font-mono">{localTime}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#4b5563]">UTC Offset</span>
                <span className="text-black">{utcOffset}</span>
              </div>
              <div className="border-t border-[#d6d0c3] pt-3 mt-3">
                <div className="text-[#4b5563] mb-2">Trading Hours</div>
                {market.preMarketOpen && (
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-amber-400">Pre-market</span>
                    <span className="text-black font-mono">
                      {formatTime(market.preMarketOpen)} - {formatTime(market.marketOpen)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-emerald-600">Regular Hours</span>
                  <span className="text-black font-mono">
                    {formatTime(market.marketOpen)} - {formatTime(market.marketClose)}
                  </span>
                </div>
                {market.postMarketClose && (
                  <div className="flex justify-between text-xs">
                    <span className="text-orange-600">Post-market</span>
                    <span className="text-black font-mono">
                      {formatTime(market.marketClose)} - {formatTime(market.postMarketClose)}
                    </span>
                  </div>
                )}
              </div>
              {countdown && (
                <div className="border-t border-[#d6d0c3] pt-3 mt-3">
                  <div className={`text-sm ${status === 'open' ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {countdown}
                  </div>
                </div>
              )}
            </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

/**
 * Individual city node component
 */
const CityNode = ({ market, now, onClick }) => {
  const zonedTime = utcToZonedTime(now, market.timezone);
  const status = getMarketStatus(market, zonedTime);
  const localTime = formatLocalTime(now, market.timezone);
  const utcOffset = getUTCOffsetLabel(market.timezone, now);
  const dayLabel = getDayLabel(market.timezone, now);

  const handleClick = (e) => {
    onClick(market, e.currentTarget);
  };

  return (
    <motion.div
      className="flex flex-col items-center cursor-pointer relative px-3 py-0.5 rounded-md hover:bg-gray-50"
      onClick={handleClick}
      whileHover={{ scale: 1.02 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      {/* Status Dot + City Code */}
      <div className="flex items-center gap-1 mb-0">
        <StatusDot status={status} />
        <span className="font-bold text-[11px] text-gray-900 tracking-wide">
          {market.code}
        </span>
      </div>

      {/* Local Time - large bold */}
      <span className="font-bold text-[15px] text-gray-900 tabular-nums leading-tight">
        {localTime}
      </span>

      {/* Day Badge - blue pill */}
      <div className="mt-0.5 text-[9px] px-1.5 py-0 rounded-full bg-blue-100 text-blue-700 font-medium whitespace-nowrap leading-[1.6]">
        {dayLabel}
      </div>

      {/* UTC Offset */}
      <span className="text-[9px] text-gray-400 mt-0">
        {utcOffset}
      </span>
    </motion.div>
  );
};

/**
 * Hour tick marks component
 */
const HourTicks = () => {
  return (
    <div className="absolute bottom-0 left-0 right-0 h-3 pointer-events-none">
      {/* Base line */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gray-300" />

      {/* Tick marks */}
      {Array.from({ length: 25 }).map((_, i) => (
        <div
          key={i}
          className="absolute bottom-0 w-px bg-gray-400"
          style={{
            left: `${(i / 24) * 100}%`,
            height: i % 6 === 0 ? '8px' : '4px'
          }}
        />
      ))}
    </div>
  );
};

/**
 * Global Market Day-Cycle Header
 * A high-density financial ribbon showing global market times and status
 */
const GlobalMarketDayCycleHeader = () => {
  const [now, setNow] = useState(new Date());
  const [selectedMarket, setSelectedMarket] = useState(null);
  const [anchorElement, setAnchorElement] = useState(null);

  // Update time every minute
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Format UTC time for header
  const utcTime = useMemo(() => {
    const hours = now.getUTCHours().toString().padStart(2, '0');
    const minutes = now.getUTCMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }, [now]);

  return (
    <div className="w-full mb-4">
      <div className="relative rounded-lg bg-white shadow-[0_2px_10px_rgba(0,0,0,0.08)] border border-gray-200">
        {/* Header Bar */}
        <div className="px-5 py-1 flex items-center justify-between border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Globe size={15} className="text-blue-500" />
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black">
              Global Market Day-Cycle
            </h2>
          </div>
          <div className="text-[12px] text-gray-500 font-mono tracking-wide">
            UTC {utcTime}
          </div>
        </div>

        {/* City Nodes Row */}
        <div className="flex items-center justify-around px-4 py-1.5">
          {GLOBAL_MARKETS.map((market) => (
            <CityNode
              key={market.id}
              market={market}
              now={now}
              onClick={(market, element) => {
                setSelectedMarket(market);
                setAnchorElement(element);
              }}
            />
          ))}
        </div>
      </div>

      {/* Market Detail Modal */}
      {selectedMarket && (
        <MarketDetailModal
          market={selectedMarket}
          now={now}
          isOpen={!!selectedMarket}
          anchorElement={anchorElement}
          onClose={() => {
            setSelectedMarket(null);
            setAnchorElement(null);
          }}
        />
      )}
    </div>
  );
};

export default GlobalMarketDayCycleHeader;
