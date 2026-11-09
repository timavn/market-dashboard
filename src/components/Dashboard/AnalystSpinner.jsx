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

// The one busy indicator the dashboard uses everywhere: a thin ring turning and, with elapsed, the blue
// seconds after it. Pass a label when the indicator is the only sign of the work (it then announces itself
// as a status). text names the work for screen readers only, so every load looks the same.
export default function AnalystSpinner({ size = 14, label, className = '', elapsed = false, since, text }) {
  const spinner = <svg className={`analyst-spinner${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 24 24"
    {...(label && !elapsed ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}>
    <circle className="analyst-spinner-track" cx="12" cy="12" r="9.5" />
    <path className="analyst-spinner-arc" d="M12 2.5a9.5 9.5 0 0 1 9.5 9.5" />
  </svg>;
  if (!elapsed && !text) return spinner;
  return <span className="analyst-spinner-group" {...(label ? { role: 'status', 'aria-label': label } : {})}>
    {spinner}{text && <span className="sr-only">{text}</span>}{elapsed && <Elapsed since={since} />}
  </span>;
}
