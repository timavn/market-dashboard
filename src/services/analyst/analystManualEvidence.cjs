const { OPERATION } = require('./analystManualVerification.cjs');
const PAGE_TOOL = 'get_portfolio_verification_page';
// Hermes spills MCP results above 50,000 characters. Match the capture service's
// 48,000-character/byte cap after the text result is JSON-wrapped, cursor included.
const PAGE_BUDGET = 48_000;

function pageFitsTransportBudget(page) {
  // MCP emits compact text; Hermes wraps it with json.dumps' default outer space.
  const rendered = `{"result": ${JSON.stringify(JSON.stringify(page))}}`;
  return [...rendered].length < PAGE_BUDGET && Buffer.byteLength(rendered, 'utf8') < PAGE_BUDGET;
}

function validManualBinding(binding, expected) {
  return binding?.operation === OPERATION
    && ['captureId', 'conversationId', 'turnId'].every(key => typeof binding[key] === 'string'
      && binding[key] === expected[key] && binding[key].length > 0 && binding[key].length <= 200)
    && Number.isSafeInteger(binding.positionCount) && binding.positionCount >= 0
    && Number.isSafeInteger(binding.summaryPageCount) && binding.summaryPageCount > 0;
}

function beginManualEvidence(turn, binding) {
  turn.requiredLiveTools = new Set();
  turn.completedLiveTools = new Set();
  turn.previousLiveRequirements = new Set();
  turn.manualVerification = { binding, pages: new Map(), pageIndices: new Set(), readEmptySummary: false };
  turn.liveGateOpen = false;
  turn.liveBufferOverflow = false;
  turn.bufferedAssistantEvents = [];
  turn.bufferedAssistantChars = 0;
}

function noteManualPage(turn, page) {
  const manual = turn.manualVerification;
  if (!manual || !page || page.captureId !== manual.binding.captureId || page.scope !== 'summary'
    || page.representation !== 'portfolio-verification-page-v1' || page.complete !== true
    || page.pageCount !== manual.binding.summaryPageCount || !Number.isSafeInteger(page.pageIndex)
    || page.pageIndex < 0 || page.pageIndex >= page.pageCount
    || page.totalRowCount !== manual.binding.positionCount || !Number.isSafeInteger(page.offset)
    || !Number.isSafeInteger(page.rowCount) || page.offset < 0 || page.rowCount < 0
    || page.offset + page.rowCount > page.totalRowCount || !pageFitsTransportBudget(page)) return false;
  const issuedPage = manual.binding.summaryPages?.find(entry => entry.pageIndex === page.pageIndex);
  if (manual.binding.summaryPages && (!issuedPage || issuedPage.pageHash !== page.pageHash)) return false;
  if (page.rowCount && manual.pages.has(page.offset) && manual.pages.get(page.offset) !== page.rowCount) return false;
  if (!page.totalRowCount) manual.readEmptySummary = true;
  if (page.rowCount) manual.pages.set(page.offset, page.rowCount);
  manual.pageIndices.add(page.pageIndex);
  return true;
}

function manualEvidenceSatisfied(turn) {
  const manual = turn.manualVerification;
  if (!manual) return true;
  if (manual.pageIndices.size !== manual.binding.summaryPageCount) return false;
  if (manual.binding.positionCount === 0) return manual.readEmptySummary;
  let offset = 0;
  for (const [start, count] of [...manual.pages].sort((a, b) => a[0] - b[0])) {
    if (start !== offset) return false;
    offset += count;
  }
  return offset === manual.binding.positionCount;
}

function manualEvidencePrompt(text, binding, prefix, suffix) {
  return [prefix,
    'This is the server-owned manual portfolio verification for this accepted chat turn.',
    JSON.stringify(binding),
    `Read ${PAGE_TOOL} with capture_id=${JSON.stringify(binding.captureId)} and no symbols. Follow every nextCursor until the complete holding roster has been read.`,
    'Read scoped detail pages with this same capture ID and exact symbols only when needed. These pages never reacquire the book or repeat the full roster.',
    'Use this capture\'s original dates, completeness, product coverage, all holdings, exact publisher actions, rule implications and tool-issued citations. Partial evidence must remain qualified; unavailable current holdings do not become an invented roster.',
    'Do not reacquire get_portfolio_context or rerun research to recreate this check. Ordinary subsequent current-data questions still require their independent fresh reads.',
    'The shared Sources table above the answer owns source coverage and progress. Do not repeat an Indexed research coverage table or acquisition diagnostics in the report.',
    'Keep the existing manual verification report format, concise cells and dated exact source links. Preserve every returned security and event contract, partial versus full actions, and direct versus proxy instruments. No invented executable prices or target sizes.',
    'Show 24-hour HH:mm times in Pacific time (PDT or PST), converting each captured instant instead of relabeling its clock; date-only publication and session dates stay unchanged. Dates and observations must never be replaced with page-read or generation time.',
    suffix, text].join('\n');
}

module.exports = { PAGE_TOOL, validManualBinding, beginManualEvidence, noteManualPage, manualEvidenceSatisfied, manualEvidencePrompt };
