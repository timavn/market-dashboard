import React, { useState, useEffect } from 'react';

// Timezones ordered chronologically from west to east (earliest to latest)
const TIMEZONES = [
  { label: 'LA', timezone: 'America/Los_Angeles', city: 'Los Angeles' },    // UTC-8/-7 (earliest)
  { label: 'CHI', timezone: 'America/Chicago', city: 'Chicago' },            // UTC-6/-5
  { label: 'NY', timezone: 'America/New_York', city: 'New York' },          // UTC-5/-4
  { label: 'LON', timezone: 'Europe/London', city: 'London' },               // UTC+0/+1
  { label: 'HK', timezone: 'Asia/Hong_Kong', city: 'Hong Kong' },            // UTC+8
  { label: 'TOK', timezone: 'Asia/Tokyo', city: 'Tokyo' }                    // UTC+9 (latest)
];

// Helper function to interpolate between two hex colors
const interpolateColor = (color1, color2, factor) => {
  const hex1 = color1.replace('#', '');
  const hex2 = color2.replace('#', '');
  
  const r1 = parseInt(hex1.substring(0, 2), 16);
  const g1 = parseInt(hex1.substring(2, 4), 16);
  const b1 = parseInt(hex1.substring(4, 6), 16);
  
  const r2 = parseInt(hex2.substring(0, 2), 16);
  const g2 = parseInt(hex2.substring(2, 4), 16);
  const b2 = parseInt(hex2.substring(4, 6), 16);
  
  const r = Math.round(r1 + (r2 - r1) * factor);
  const g = Math.round(g1 + (g2 - g1) * factor);
  const b = Math.round(b1 + (b2 - b1) * factor);
  
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
};

// Calculate gradient colors based on UTC hour
const getGradientColors = (utcHour) => {
  // Night: 21:00 - 06:00 UTC (21-23, 0-6)
  // Dawn: 06:00 - 09:00 UTC
  // Day: 09:00 - 18:00 UTC
  // Dusk: 18:00 - 21:00 UTC
  
  const nightStart = '#1a1a3e';
  const nightEnd = '#2d2d5f';
  const dayStart = '#87CEEB'; // Sky blue
  const dayEnd = '#F5DEB3'; // Beige/gold
  
  if (utcHour >= 21 || utcHour < 6) {
    // Night: dark blue gradient
    return {
      start: nightStart,
      end: nightEnd
    };
  } else if (utcHour >= 6 && utcHour < 9) {
    // Dawn: transition from dark blue to light blue
    const progress = (utcHour - 6) / 3; // 0 to 1
    return {
      start: interpolateColor(nightStart, dayStart, progress),
      end: interpolateColor(nightEnd, dayEnd, progress)
    };
  } else if (utcHour >= 9 && utcHour < 18) {
    // Day: light blue to gold/beige
    return {
      start: dayStart,
      end: dayEnd
    };
  } else {
    // Dusk: 18:00 - 21:00 UTC, transition from gold to dark blue
    const progress = (utcHour - 18) / 3; // 0 to 1
    return {
      start: interpolateColor(dayEnd, nightStart, progress),
      end: interpolateColor(dayEnd, nightEnd, progress)
    };
  }
};

// Determine time of day icon based on hour
const getTimeIcon = (hour) => {
  // Night: 20:00 - 05:00 (8 PM - 5 AM)
  // Dawn/Dusk: 05:00 - 07:00 and 18:00 - 20:00 (5-7 AM and 6-8 PM)
  // Day: 07:00 - 18:00 (7 AM - 6 PM)
  
  if (hour >= 20 || hour < 5) {
    return 'moon';
  } else if ((hour >= 5 && hour < 7) || (hour >= 18 && hour < 20)) {
    return 'transition';
  } else {
    return 'sun';
  }
};

// Sun icon component
const SunIcon = ({ size = 12 }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="white" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
    className="time-icon sun-icon"
  >
    <circle cx="12" cy="12" r="5"></circle>
    <line x1="12" y1="1" x2="12" y2="3"></line>
    <line x1="12" y1="21" x2="12" y2="23"></line>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
    <line x1="1" y1="12" x2="3" y2="12"></line>
    <line x1="21" y1="12" x2="23" y2="12"></line>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
  </svg>
);

// Moon icon component
const MoonIcon = ({ size = 12 }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="white" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
    className="time-icon moon-icon"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
  </svg>
);

// Transition icon (sunrise/sunset) component
const TransitionIcon = ({ size = 12 }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="white" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
    className="time-icon transition-icon"
  >
    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
    <circle cx="12" cy="12" r="3"></circle>
  </svg>
);

export default function TimezoneClockBar() {
  const [times, setTimes] = useState({});
  const [times24, setTimes24] = useState({});
  const [timeIcons, setTimeIcons] = useState({});
  const [gradientColors, setGradientColors] = useState({ start: '#1a1a3e', end: '#2d2d5f' });

  useEffect(() => {
    const updateTimes = () => {
      const newTimes = {};
      const newTimes24 = {};
      const newTimeIcons = {};
      
      TIMEZONES.forEach(({ timezone, label }) => {
        // Get the current time in this timezone
        const now = new Date();
        const timeString = now.toLocaleString('en-US', {
          timeZone: timezone,
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
        
        // Extract hour from time string (format: "HH:MM:SS")
        const hour = parseInt(timeString.split(':')[0], 10);
        
        // 12-hour format
        const time12 = now.toLocaleString('en-US', {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });
        newTimes[label] = time12;
        
        // 24-hour format
        const time24 = now.toLocaleString('en-US', {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
        newTimes24[label] = time24;
        
        // Get icon based on hour
        newTimeIcons[label] = getTimeIcon(hour);
      });
      
      setTimes(newTimes);
      setTimes24(newTimes24);
      setTimeIcons(newTimeIcons);
      
      // Update gradient based on UTC hour
      const now = new Date();
      const utcHour = now.getUTCHours();
      setGradientColors(getGradientColors(utcHour));
    };

    updateTimes();
    const interval = setInterval(updateTimes, 1000); // Update every second
    return () => clearInterval(interval);
  }, []);

  const gradientStyle = {
    background: `linear-gradient(to right, ${gradientColors.start}, ${gradientColors.end})`
  };

  const renderTimeIcon = (iconType, size = 12) => {
    switch (iconType) {
      case 'sun':
        return <SunIcon size={size} />;
      case 'moon':
        return <MoonIcon size={size} />;
      case 'transition':
        return <TransitionIcon size={size} />;
      default:
        return <SunIcon size={size} />;
    }
  };

  return (
    <div className="timezone-clock-bar" style={gradientStyle}>
      <div className="timeline-line"></div>
      <div className="timeline-cities">
        {TIMEZONES.map(({ label, city, timezone }) => {
          const isHome = label === 'LA';
          const iconType = timeIcons[label] || 'sun';
          return (
            <div 
              key={label} 
              className={`timezone-timeline-node ${isHome ? 'home-timezone' : ''}`}
              title={`${city} (${timezone})`}
            >
              {isHome && (
                <svg 
                  className="home-icon" 
                  width="12" 
                  height="12" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  stroke="white" 
                  strokeWidth="2" 
                  strokeLinecap="round" 
                  strokeLinejoin="round"
                >
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                  <polyline points="9 22 9 12 15 12 15 22"></polyline>
                </svg>
              )}
              <span className="timezone-label">{label}</span>
              <div className="timeline-marker-above">
                {renderTimeIcon(iconType, isHome ? 14 : 12)}
              </div>
              <div className="timeline-line-marker"></div>
              <div className="timezone-time-container">
                <span className={`timezone-time ${isHome ? 'home-time' : ''}`}>
                  {times[label] || '--:--'}
                </span>
                <span className="timezone-time-24">
                  {times24[label] || '--:--'} UTC
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
