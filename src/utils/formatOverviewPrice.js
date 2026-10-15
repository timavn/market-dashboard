const wholeNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const tenths = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const hundredths = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const subunit = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });

// Display-only precision for overview prices and index levels. Callers retain
// responsibility for quote availability and unit-specific formats (rates, FX).
export function formatOverviewPrice(value) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';

  const magnitude = Math.abs(value);
  const formatter = magnitude >= 100 ? wholeNumber
    : magnitude >= 10 ? tenths
      : magnitude >= 1 ? hundredths
        : subunit;
  return formatter.format(value);
}
