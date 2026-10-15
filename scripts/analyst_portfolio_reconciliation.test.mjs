import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  buildAuditPrompt,
  formatAuditResult,
  resolveRunMode,
  runAudit,
  validateAuditResult,
} from './analyst_portfolio_reconciliation.mjs';

test('buildAuditPrompt enforces verified-live portfolio data and bounded unheld additions', () => {
  const prompt = buildAuditPrompt('checkpoint');
  assert.match(prompt, /get_research_coverage/);
  assert.match(prompt, /get_briefing_packet/);
  assert.match(prompt, /excerpts_per_product set to 1/);
  assert.match(prompt, /get_portfolio_context/);
  assert.match(prompt, /liveVerified true/);
  assert.match(prompt, /separate search_research call for each action-bearing product/);
  assert.match(prompt, /request no more than 8 results/);
  assert.match(prompt, /etf-pro: ADD REMOVE LONG SHORT changes/);
  assert.match(prompt, /Never use cached, uploaded, historical, prior-run, or inferred holdings/);
  assert.match(prompt, /Never list every active unowned name/);
  assert.match(prompt, /Do not suppress an explicit source-declared change/);
  assert.match(prompt, /packet excerpt; do not describe the newest source as missing/);
  assert.match(prompt, /self-declared changes/);
  assert.match(prompt, /Do not treat an ordinary rank improvement/);
  assert.match(prompt, /disappears from Signal Strength or is removed from ETF Pro is a mismatch/);
  assert.match(prompt, /Do not stage or place an order/);
});

test('resolveRunMode selects checkpoint before the Eastern close and close afterward', () => {
  assert.equal(resolveRunMode('auto', new Date('2026-08-20T17:00:00Z')), 'checkpoint');
  assert.equal(resolveRunMode('auto', new Date('2026-08-20T21:00:00Z')), 'close');
  assert.equal(resolveRunMode('baseline', new Date('2026-08-20T21:00:00Z')), 'baseline');
});

test('validateAuditResult fails when a required tool or targeted search is missing', () => {
  assert.throws(() => validateAuditResult({
    text: '## Held-position mismatches\nNone',
    completedTools: ['get_research_coverage', 'get_briefing_packet'],
  }), /get_portfolio_context/);

  assert.throws(() => validateAuditResult({
    text: '## Held-position mismatches\nNone',
    completedTools: ['get_research_coverage', 'get_briefing_packet', 'get_portfolio_context'],
  }), /targeted research comparison/);
});

test('validateAuditResult accepts an explicit blocked audit after all live gates complete', () => {
  const result = validateAuditResult({
    text: 'AUDIT BLOCKED\n\nIBKR is unavailable.',
    completedTools: ['get_research_coverage', 'get_briefing_packet', 'get_portfolio_context'],
    citations: [],
  });
  assert.equal(result.blocked, true);
});

test('formatAuditResult preserves exact validated citation IDs', () => {
  const output = formatAuditResult({
    mode: 'checkpoint',
    text: '## Held-position mismatches\nNone',
    citations: [{
      id: 'cite_0123456789abcdef0123456789abcdef',
      product: 'etf-pro',
      publicationDate: '2026-08-20',
      title: 'ETF Pro update',
    }],
  });
  assert.match(output, /^Audit mode: checkpoint/);
  assert.match(output, /cite_0123456789abcdef0123456789abcdef/);
  assert.match(output, /ETF Pro update/);
});

test('validateAuditResult rejects citations the gateway could not validate', () => {
  assert.throws(() => validateAuditResult({
    text: 'AUDIT BLOCKED',
    completedTools: ['get_research_coverage', 'get_briefing_packet', 'get_portfolio_context'],
    rejectedCitations: ['cite_deadbeefdeadbeefdeadbeefdeadbeef'],
  }), /unvalidated citations/);
});

test('runAudit keeps its Analyst chat and never sends a session delete', async () => {
  const sent = [];
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      setImmediate(() => this.emit('open'));
    }
    send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      const reply = (frame) => setImmediate(() => this.emit('message', JSON.stringify(frame)));
      if (message.action === 'new_chat') reply({ type: 'session', storedSessionId: 'stored-audit' });
      if (message.action === 'prompt') {
        for (const name of ['get_research_coverage', 'get_briefing_packet', 'get_portfolio_context']) {
          reply({ type: 'tool', status: 'complete', name });
        }
        reply({ type: 'message_complete', text: 'AUDIT BLOCKED\n\nIBKR is unavailable.', citations: [] });
      }
    }
    close() { this.readyState = 3; }
  }
  const result = await runAudit({ mode: 'checkpoint', timeoutMs: 10_000, WebSocketImpl: FakeSocket });
  assert.equal(result.blocked, true);
  assert.deepEqual(sent.map(({ action }) => action), ['new_chat', 'prompt']);
});
