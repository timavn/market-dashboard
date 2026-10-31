import React, { useEffect, useRef, useState } from 'react';
import './AnalystSpinner.css';

// Every rolling readout on the page shares one timer, so a table full of loading cells costs one interval.
const rolling = new Set();
let ticker = null;
const roll = () => (Math.random() * 9.99).toFixed(2);
function watch(node) {
  rolling.add(node);
  ticker ||= setInterval(() => rolling.forEach(item => { item.textContent = roll(); }), 90);
  return () => {
    rolling.delete(node);
    if (!rolling.size) { clearInterval(ticker); ticker = null; }
  };
}

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

// The one busy indicator the dashboard uses everywhere: muted digits rolling where the value will land and,
// with elapsed, the blue seconds after them. The digits are never a reading. Pass a label when the indicator
// is the only sign of the work (it then announces itself as a status). text names the work for screen
// readers only, so every load looks the same.
export default function AnalystSpinner({ size = 14, label, className = '', elapsed = false, since, text }) {
  const digits = useRef(null);
  useEffect(() => watch(digits.current), []);
  const spinner = <span ref={digits} className={`analyst-spinner${className ? ` ${className}` : ''}`} style={{ '--analyst-spinner-size': `${size}px` }}
    {...(label && !elapsed ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}>0.00</span>;
  if (!elapsed && !text) return spinner;
  return <span className="analyst-spinner-group" {...(label ? { role: 'status', 'aria-label': label } : {})}>
    {spinner}{text && <span className="sr-only">{text}</span>}{elapsed && <Elapsed since={since} />}
  </span>;
}
