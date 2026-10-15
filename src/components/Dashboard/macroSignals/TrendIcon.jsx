import { ArrowUp, ArrowDown, ArrowRight } from 'lucide-react';

function normalizeSignalArrowValue(value) {
  if (value === 'bullish' || value === 'bull' || value === 'Buy' || value === 'Long') {
    return 'bullish';
  }
  if (value === 'bearish' || value === 'bear' || value === 'Sell' || value === 'Short') {
    return 'bearish';
  }
  return value === 'neutral' || value === 'Neutral' || value === 'NEUTRAL' ? 'neutral' : null;
}

function SignalArrow({ value }) {
  const normalized = normalizeSignalArrowValue(value);

  if (!normalized) return <span className="signal-arrow-unavailable" aria-label="Unavailable">—</span>;

  if (normalized === 'bullish') {
    return <ArrowUp className="signal-arrow signal-arrow-bullish" />;
  }

  if (normalized === 'bearish') {
    return <ArrowDown className="signal-arrow signal-arrow-bearish" />;
  }

  return <ArrowRight className="signal-arrow signal-arrow-neutral" />;
}

export default SignalArrow;
