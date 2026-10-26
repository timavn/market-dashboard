import React, { useEffect, useState } from 'react';
import './AnalystSpinner.css';

const seconds = start => Math.max(0, Math.floor((Date.now() - start) / 1000));

// Whole seconds since the work started: since (the turn's start) or, without one, since it appeared.
function Elapsed({ since }) {
  const [start] = useState(() => Date.parse(since) || Date.now());
  const [value, setValue] = useState(() => seconds(start));
  useEffect(() => {
    const timer = setInterval(() => setValue(seconds(start)), 1_000);
    return () => clearInterval(timer);
  }, [start]);
  return <span className="analyst-spinner-elapsed" aria-hidden="true">{value}s</span>;
}

// The one busy indicator the dashboard uses everywhere: a turning ring and, with elapsed, the blue
// seconds after it. Pass a label when the spinner is the only sign of the work (it then announces
// itself as a status). text names the work for screen readers only, so every load looks the same.
export default function AnalystSpinner({ size = 14, label, className = '', elapsed = false, since, text }) {
  const ring = <span className={`analyst-spinner${className ? ` ${className}` : ''}`} style={{ '--analyst-spinner-size': `${size}px` }}
    {...(label && !elapsed ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })} />;
  if (!elapsed && !text) return ring;
  return <span className="analyst-spinner-group" {...(label ? { role: 'status', 'aria-label': label } : {})}>
    {ring}{text && <span className="sr-only">{text}</span>}{elapsed && <Elapsed since={since} />}
  </span>;
}
