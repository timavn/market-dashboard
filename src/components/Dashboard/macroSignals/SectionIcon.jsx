import { useId } from 'react';

const VARIANT_CONFIG = {
  long: {
    path: 'M12 3.25 L18.75 12.25 H14.5 V20.75 H9.5 V12.25 H5.25 Z',
    stops: ['#059669', '#059669', '#059669', '#ecfdf5'],
    highlight: 'M12 5.5 L16.2 11.5 H13.8 V12.5 H10.2 V11.5 H7.8 Z',
    glow: 'rgba(34, 197, 94, 0.55)',
  },
  short: {
    path: 'M12 20.75 L5.25 11.75 H9.5 V3.25 H14.5 V11.75 H18.75 Z',
    stops: ['#dc2626', '#dc2626', '#dc2626', '#dc2626'],
    highlight: 'M12 18.5 L7.8 12.5 H10.2 V11.5 H13.8 V12.5 H16.2 Z',
    glow: 'rgba(239, 68, 68, 0.55)',
  },
  neutral: {
    path: 'M3.5 11.25 H14.75 V7.75 L21.25 12 L14.75 16.25 V12.75 H3.5 Z',
    stops: ['#334155', '#64748b', '#94a3b8', '#e2e8f0'],
    highlight: 'M5.5 12.25 H13.5 V10.25 L17.5 12 L13.5 13.75 V12.25 H5.5 Z',
    glow: 'rgba(100, 116, 139, 0.4)',
  },
};

/**
 * Polished directional arrow for LONGS / SHORTS / NEUTRAL section headers.
 */
function SectionIcon({ variant = 'long' }) {
  const config = VARIANT_CONFIG[variant] || VARIANT_CONFIG.long;
  const uid = useId().replace(/:/g, '');
  const gradId = `section-arrow-grad-${uid}`;
  const shineId = `section-arrow-shine-${uid}`;

  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`signal-section-icon-svg signal-section-icon-svg-${variant}`}
    >
      <defs>
        <linearGradient id={gradId} x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
          {config.stops.map((color, i) => (
            <stop
              key={color}
              offset={`${(i / (config.stops.length - 1)) * 100}%`}
              stopColor={color}
            />
          ))}
        </linearGradient>
        <linearGradient id={shineId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="45%" stopColor="#ffffff" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <filter
          id={`${uid}-shadow`}
          x="-20%"
          y="-20%"
          width="140%"
          height="140%"
          colorInterpolationFilters="sRGB"
        >
          <feDropShadow dx="0" dy="1" stdDeviation="0.65" floodColor={config.glow} />
          <feDropShadow dx="0" dy="0.5" stdDeviation="0.25" floodColor="rgba(15, 23, 42, 0.2)" />
        </filter>
      </defs>
      <g filter={`url(#${uid}-shadow)`}>
        <path d={config.path} fill={`url(#${gradId})`} />
        <path d={config.highlight} fill={`url(#${shineId})`} />
      </g>
    </svg>
  );
}

export default SectionIcon;
