import { ArrowUp, ArrowDown, ArrowRight } from 'lucide-react';

function normalizeSignalArrowValue(value) {
  if (value === 'bullish' || value === 'bull' || value === 'Buy' || value === 'Long') {
    return 'bullish';
  }
  if (value === 'bearish' || value === 'bear' || value === 'Sell' || value === 'Short') {
    return 'bearish';
  }
  return 'neutral';
}

function SignalArrow({ value }) {
  const normalized = normalizeSignalArrowValue(value);

  if (normalized === 'bullish') {
    return <ArrowUp className="signal-arrow signal-arrow-bullish" />;
  }

  if (normalized === 'bearish') {
    return <ArrowDown className="signal-arrow signal-arrow-bearish" />;
  }

  return <ArrowRight className="signal-arrow signal-arrow-neutral" />;
}

export default SignalArrow;
