/**
 * Mini stock-chart tiles: four rising/falling bars + diagonal trend + arrowhead.
 */
function SectionIcon({ variant }) {
  const isLong = variant === 'long';
  const stroke = isLong ? '#059669' : '#dc2626';
  const fillBar = isLong ? 'rgba(5, 150, 105, 0.22)' : 'rgba(220, 38, 38, 0.22)';

  /* viewBox 48x36 — bars left→right; trend polyline + arrow */
  const barsLong = [
    { x: 8, w: 5, h: 10, y: 22 },
    { x: 16, w: 5, h: 14, y: 18 },
    { x: 24, w: 5, h: 18, y: 14 },
    { x: 32, w: 5, h: 22, y: 10 },
  ];
  const barsShort = [
    { x: 8, w: 5, h: 22, y: 10 },
    { x: 16, w: 5, h: 18, y: 14 },
    { x: 24, w: 5, h: 14, y: 18 },
    { x: 32, w: 5, h: 10, y: 22 },
  ];
  const bars = isLong ? barsLong : barsShort;

  const lineLong = 'M 9 26 L 38 11';
  const lineShort = 'M 9 12 L 38 27';
  const arrowLong = 'M 34 11 L 38 11 L 38 15';
  const arrowShort = 'M 34 27 L 38 27 L 38 23';

  return (
    <svg
      width="40"
      height="32"
      viewBox="0 0 48 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={`signal-section-icon-svg signal-section-icon-svg-${variant}`}
    >
      {bars.map(b => (
        <rect
          key={`${b.x}-${b.y}`}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx="1.5"
          fill={fillBar}
          stroke={stroke}
          strokeWidth="1.15"
          strokeOpacity="0.85"
        />
      ))}
      <path
        d={isLong ? lineLong : lineShort}
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d={isLong ? arrowLong : arrowShort}
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export default SectionIcon;
