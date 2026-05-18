/** Clean ~22px diagonal trend arrows */
function TrendIcon({ trend }) {
  const green = '#059669';
  const red = '#dc2626';
  const muted = '#cbd5e1';

  if (trend === 'bull') {
    return (
      <svg
        className="trend-icon-svg trend-icon-svg-bull"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
      >
        <path
          d="M5 17 L11 11 L14 14 L19 9"
          stroke={green}
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15 9 H19 V13"
          stroke={green}
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (trend === 'bear') {
    return (
      <svg
        className="trend-icon-svg trend-icon-svg-bear"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
      >
        <path
          d="M5 8 L11 14 L14 11 L19 16"
          stroke={red}
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15 16 H19 V12"
          stroke={red}
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg className="trend-icon-svg trend-icon-svg-neutral" width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path d="M6 12 H18" stroke={muted} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default TrendIcon;
