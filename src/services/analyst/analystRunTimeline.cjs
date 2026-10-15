/** One timestamped log line per settled Analyst run, with its phase durations. */
const PHASES = [['accepted', 'acceptedAt'], ['dispatched', 'dispatchedAt'], ['captureSettled', 'captureSettledAt'],
  ['summarizing', 'summarizingAt'], ['settled', 'settledAt']];
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const token = value => String(value ?? '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128) || '-';

// Only scalar identities and clocks are logged; never prompts, reports or evidence.
function runSettlementLine({ runId, kind, state, phaseTimes = {} }, at = new Date()) {
  const present = PHASES.filter(([, key]) => instant(phaseTimes[key]));
  const spans = present.slice(1).map(([name, key], index) => {
    const [previous, previousKey] = present[index];
    return `${previous}->${name}=${Math.max(0, Date.parse(phaseTimes[key]) - Date.parse(phaseTimes[previousKey]))}ms`;
  });
  const total = present.length > 1
    ? [`total=${Math.max(0, Date.parse(phaseTimes[present.at(-1)[1]]) - Date.parse(phaseTimes[present[0][1]]))}ms`] : [];
  return [at.toISOString(), '[analyst] run settled', `runId=${token(runId)}`, `kind=${token(kind)}`, `state=${token(state)}`,
    ...spans, ...total].join(' ');
}

function logRunSettlement(run, log = console.info) {
  // Diagnostics must never affect publication or settlement.
  try { log(runSettlementLine(run)); } catch { /* ignore */ }
}

module.exports = { logRunSettlement, runSettlementLine };
