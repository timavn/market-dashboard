// React render start -> commit, not click latency, network latency, or browser paint.
// Called only by the development-only Contract P&L Profiler. Keep a bounded local
// diagnostic buffer; never include account IDs, contract labels or monetary data.
export function recordContractPnlCommit(_id, phase, _actualDuration, _baseDuration, startTime, commitTime) {
  const name = 'contract-pnl:render-to-commit';
  if (!['mount', 'update', 'nested-update'].includes(phase) || !Number.isFinite(startTime)
    || !Number.isFinite(commitTime) || commitTime < startTime) return;
  const sample = { phase, duration: commitTime - startTime };
  try {
    if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
      if (performance.getEntriesByName(name).length >= 50) performance.clearMeasures(name);
      performance.measure(name, { start: startTime, end: commitTime, detail: { phase } });
    }
  } catch (_error) {
    // Diagnostics must never interrupt the card on browsers without measure options.
  }
  return sample;
}

// Mirror only phase/duration on this panel's own DOM node for read-only browser
// verification. No global document writes, visible UI, persistence or telemetry.
export function recordContractPnlPanelCommit(element, ...timing) {
  if (process.env.NODE_ENV !== 'development') return;
  const sample = recordContractPnlCommit(...timing);
  if (!sample || !element) return;
  try {
    const attribute = 'data-contract-pnl-timing';
    const previous = JSON.parse(element.getAttribute(attribute) || '[]');
    const samples = Array.isArray(previous) ? previous.slice(-49) : [];
    element.setAttribute(attribute, JSON.stringify([...samples, sample]));
  } catch (_error) {
    // A detached or unsupported diagnostic node must not affect the card.
  }
}
