const test = require('node:test');
const assert = require('node:assert/strict');
const { OPERATION } = require('./analystManualVerification.cjs');
const { validManualBinding, beginManualEvidence, noteManualPage, manualEvidenceSatisfied, manualEvidencePrompt } = require('./analystManualEvidence.cjs');

const identity = { captureId: 'capture-1', conversationId: 'chat-1', turnId: 'turn-1' };
const binding = (count, summaryPageCount = 1) => ({ ...identity, operation: OPERATION, positionCount: count, summaryPageCount });
function evidenceTurn(count = 4, summaryPageCount = 1) {
  const turn = { submittedPrompt: 'Verify my original complete book.' };
  beginManualEvidence(turn, binding(count, summaryPageCount));
  return turn;
}
const page = (offset = 0, rowCount = 4, overrides = {}) => ({
  captureId: identity.captureId, scope: 'summary', representation: 'portfolio-verification-page-v1', complete: true,
  totalRowCount: 4, offset, rowCount, pageIndex: 0, pageCount: 1, nextCursor: null,
  researchVerification: { complete: false, holdings: { status: 'verified' } }, ...overrides,
});
const hermesResult = value => `{"result": ${JSON.stringify(JSON.stringify(value))}}`;

test('a manual binding requires the exact accepted operation and three durable owner identifiers', () => {
  assert.equal(validManualBinding(binding(0), identity), true);
  assert.equal(validManualBinding(binding(73), identity), true);
  for (const changes of [{ operation: 'another-operation' }, { captureId: '' }, { captureId: 'other-capture' },
    { conversationId: 'other-chat' }, { turnId: 'other-turn' }, { turnId: 'x'.repeat(201) },
    { positionCount: -1 }, { positionCount: 1.5 }, { positionCount: '4' }, { positionCount: Infinity },
    { summaryPageCount: 0 }, { summaryPageCount: -1 }, { summaryPageCount: 1.5 }, { summaryPageCount: '2' }]) {
    assert.equal(validManualBinding({ ...binding(4), ...changes }, identity), false, JSON.stringify(changes));
  }
  assert.equal(validManualBinding(null, identity), false);
});

test('beginning captured evidence clears previous live gates and buffered output while retaining the submitted prompt', () => {
  const turn = { submittedPrompt: 'Original question\nPreserve this.', requiredLiveTools: new Set(['get_portfolio_context']),
    completedLiveTools: new Set(['get_portfolio_context']), previousLiveRequirements: new Set(['old-tool']),
    liveGateOpen: true, liveBufferOverflow: true, bufferedAssistantEvents: [{ type: 'message_delta' }], bufferedAssistantChars: 100 };
  beginManualEvidence(turn, binding(4));
  assert.equal(turn.submittedPrompt, 'Original question\nPreserve this.');
  assert.equal(turn.requiredLiveTools.size, 0);
  assert.equal(turn.completedLiveTools.size, 0);
  assert.equal(turn.previousLiveRequirements.size, 0);
  assert.equal(turn.liveGateOpen, false);
  assert.equal(turn.liveBufferOverflow, false);
  assert.deepEqual(turn.bufferedAssistantEvents, []);
  assert.equal(turn.bufferedAssistantChars, 0);
  assert.equal(manualEvidenceSatisfied(turn), false);
});

test('every contiguous summary page is required, including a qualified partial research capture', () => {
  const turn = evidenceTurn(4, 2);
  assert.equal(noteManualPage(turn, page(2, 2, { pageIndex: 1, pageCount: 2 })), true);
  assert.equal(manualEvidenceSatisfied(turn), false);
  assert.equal(noteManualPage(turn, page(0, 2, { pageIndex: 0, pageCount: 2, nextCursor: 'next-page' })), true);
  assert.equal(manualEvidenceSatisfied(turn), true);
  assert.equal(turn.manualVerification.binding.positionCount, 4);
});

test('a missing or overlapping roster segment cannot certify the complete book', () => {
  const gap = evidenceTurn(4, 2);
  noteManualPage(gap, page(0, 1, { pageCount: 2, nextCursor: 'next-page' }));
  noteManualPage(gap, page(2, 2, { pageIndex: 1, pageCount: 2 }));
  assert.equal(manualEvidenceSatisfied(gap), false);
  const overlap = evidenceTurn(4, 2);
  noteManualPage(overlap, page(0, 3, { pageCount: 2, nextCursor: 'next-page' }));
  noteManualPage(overlap, page(2, 2, { pageIndex: 1, pageCount: 2 }));
  assert.equal(manualEvidenceSatisfied(overlap), false);
});

test('fragmented summary records require every advertised page even when their roster offsets repeat', () => {
  const turn = evidenceTurn(1, 2);
  const fragment = index => page(0, 1, { totalRowCount: 1, pageIndex: index, pageCount: 2,
    nextCursor: index ? null : 'fragment-two', researchVerification: undefined,
    data: { fragments: [{ recordKind: 'summary', recordId: 'holding-1', index, count: 2, jsonPart: index ? '}' : '{' }] } });
  assert.equal(noteManualPage(turn, fragment(0)), true);
  assert.equal(manualEvidenceSatisfied(turn), false, 'one fragment cannot stand for the unread holding evidence');
  assert.equal(noteManualPage(turn, fragment(1)), true);
  assert.equal(manualEvidenceSatisfied(turn), true);
});

test('a verified empty portfolio still requires its original empty summary page', () => {
  const turn = evidenceTurn(0);
  assert.equal(manualEvidenceSatisfied(turn), false);
  assert.equal(noteManualPage(turn, page(0, 0, { totalRowCount: 0 })), true);
  assert.equal(manualEvidenceSatisfied(turn), true);
});

test('captured page manifests reject a different page hash for the same index', () => {
  const turn = evidenceTurn();
  turn.manualVerification.binding.summaryPages = [{ pageIndex: 0, pageHash: 'issued-original-page' }];
  assert.equal(noteManualPage(turn, page(0, 4, { pageHash: 'another-page' })), false);
  assert.equal(manualEvidenceSatisfied(turn), false);
  assert.equal(noteManualPage(turn, page(0, 4, { pageHash: 'issued-original-page' })), true);
  assert.equal(manualEvidenceSatisfied(turn), true);
});

test('wrong capture, detail-only, incomplete, or malformed summary pages never open the output gate', () => {
  for (const changes of [{ captureId: 'other-capture' }, { scope: 'detail' }, { representation: 'legacy-page' },
    { complete: false }, { totalRowCount: 3 }, { offset: -1 }, { offset: 1.5 }, { rowCount: -1 },
    { rowCount: 5 }, { rowCount: '4' }, { pageCount: 2 }, { pageIndex: -1 }, { pageIndex: 1 }, { pageIndex: 1.5 }]) {
    const turn = evidenceTurn();
    assert.equal(noteManualPage(turn, page(0, 4, changes)), false, JSON.stringify(changes));
    assert.equal(manualEvidenceSatisfied(turn), false);
  }
  assert.equal(noteManualPage(evidenceTurn(), null), false);
});

test('metadata-only pages and repeated page reads cannot stand for an unread holding roster', () => {
  const metadata = evidenceTurn();
  assert.equal(noteManualPage(metadata, page(0, 0)), true);
  assert.equal(manualEvidenceSatisfied(metadata), false);
  const repeated = evidenceTurn(4, 2);
  const first = page(0, 4, { pageCount: 2, nextCursor: 'metadata-page' });
  assert.equal(noteManualPage(repeated, first), true);
  assert.equal(noteManualPage(repeated, first), true);
  assert.equal(manualEvidenceSatisfied(repeated), false);
  assert.equal(noteManualPage(repeated, page(4, 0, { pageCount: 2, pageIndex: 1 })), true);
  assert.equal(manualEvidenceSatisfied(repeated), true);
});

test('conflicting row counts for one captured offset cannot certify an unread summary page', () => {
  const turn = evidenceTurn(4, 2);
  assert.equal(noteManualPage(turn, page(0, 3, { pageCount: 2, nextCursor: 'remaining-page' })), true);
  assert.equal(noteManualPage(turn, page(0, 4, { pageCount: 2, pageIndex: 1 })), false);
  assert.equal(manualEvidenceSatisfied(turn), false);
});

test('summary pages must fit the 48,000-character Hermes wrapper without truncating roster counts', () => {
  const base = page(0, 4, { detail: '' });
  const encodedLength = hermesResult(base).length;
  const justBelow = { ...base, detail: 'x'.repeat(48_000 - encodedLength - 1) };
  const boundary = { ...base, detail: 'x'.repeat(48_000 - encodedLength) };
  assert.equal(hermesResult(justBelow).length, 47_999);
  assert.equal(hermesResult(boundary).length, 48_000);
  assert.ok(JSON.stringify(boundary).length < 48_000, 'the raw JSON alone would incorrectly pass');
  assert.equal(noteManualPage(evidenceTurn(), justBelow), true);
  const turn = evidenceTurn();
  assert.equal(noteManualPage(turn, boundary), false);
  assert.equal(manualEvidenceSatisfied(turn), false);
  assert.equal(turn.manualVerification.binding.positionCount, 4);
});

test('quotes, backslashes and newlines count after MCP text is escaped into the Hermes result', () => {
  const expanded = page(0, 4, { detail: '"\\\n'.repeat(4_500), nextCursor: 'opaque-cursor' });
  assert.ok(JSON.stringify(expanded).length < 48_000);
  assert.ok(hermesResult(expanded).length > 48_000);
  const turn = evidenceTurn();
  assert.equal(noteManualPage(turn, expanded), false);
  assert.equal(turn.manualVerification.pages.size, 0);
  assert.equal(manualEvidenceSatisfied(turn), false);
});

test('Unicode evidence must fit both the model character limit and the UTF-8 transport byte limit', () => {
  const tooManyBytes = page(0, 4, { detail: '€'.repeat(17_000) });
  const rendered = hermesResult(tooManyBytes);
  assert.ok([...rendered].length < 48_000);
  assert.ok(Buffer.byteLength(rendered, 'utf8') > 48_000);
  assert.equal(noteManualPage(evidenceTurn(), tooManyBytes), false);
  const retained = page(0, 4, { detail: '🧾'.repeat(10_000), nextCursor: 'signed-next-page' });
  assert.ok(Buffer.byteLength(hermesResult(retained), 'utf8') < 48_000);
  assert.equal(noteManualPage(evidenceTurn(), retained), true);
});

test('the final signed cursor is included in the page budget before a summary can certify the book', () => {
  const base = page(0, 4, { detail: '' });
  const fitted = { ...base, detail: 'x'.repeat(48_000 - hermesResult(base).length - 1) };
  assert.equal(noteManualPage(evidenceTurn(), fitted), true);
  const cursorAdded = { ...fitted, nextCursor: 'signed-capture-page-cursor' };
  assert.ok(hermesResult(cursorAdded).length > 48_000);
  const turn = evidenceTurn();
  assert.equal(noteManualPage(turn, cursorAdded), false);
  assert.equal(turn.manualVerification.pageIndices.size, 0);
  assert.equal(manualEvidenceSatisfied(turn), false);
});

test('the capture prompt keeps the complete original user request and binds all page reads to one capture', () => {
  const original = 'Original complete request.\n  Keep my exact second line and symbols: BRK.B.  ';
  const expected = binding(73);
  const before = structuredClone(expected);
  const prompt = manualEvidencePrompt(original, expected, 'Prefix guard', 'Suffix guard');
  assert.ok(prompt.startsWith('Prefix guard\n'));
  assert.ok(prompt.endsWith(`Suffix guard\n${original}`));
  assert.ok(prompt.includes(JSON.stringify(expected)));
  assert.match(prompt, /get_portfolio_verification_page with capture_id="capture-1" and no symbols/);
  assert.match(prompt, /Follow every nextCursor/);
  assert.match(prompt, /Do not reacquire get_portfolio_context/);
  // Clock times are shown in the user's Pacific time, converted rather than relabeled.
  assert.match(prompt, /24-hour HH:mm times in Pacific time \(PDT or PST\), converting each captured instant/);
  assert.doesNotMatch(prompt, /captured timezone/);
  assert.deepEqual(expected, before);
});
