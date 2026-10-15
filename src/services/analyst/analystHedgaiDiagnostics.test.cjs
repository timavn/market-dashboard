const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceDiagnostics } = require('./analystSourceDiagnostics.cjs');

test('a HedgAI transition discrepancy creates one durable incident without changing its saved source', async () => {
  const issue = { id: 'transition-1', code: 'ambiguous_transition', ticker: 'SPY', message: 'A Short was added while the prior Buy has no published closure.',
    source: { productId: 'hedgai-signals', reportDate: '2026-09-28', url: 'https://app.hedgeye.com/feed_items/187742' } };
  const original = { basis: 'review', state: 'succeeded', conversationId: 'c1', runId: 'r1', capturedAt: '2026-09-28T18:00:00Z',
    items: [{ id: 'hedgai-signals', label: 'HedgAI', status: 'ready', sourceQuality: { issues: [issue] } }] };
  const sources = structuredClone(original);
  const findings = new Map(); const settings = new Map();
  const service = createSourceDiagnostics({ now: () => new Date('2026-09-28T19:00:00Z'),
    fetchJson: async path => path.startsWith('/api/research/hedgai?')
      ? { version: 1, product: 'hedgai-signals', book: { rows: [{ ticker: 'SPY' }] }, sourceQuality: { continuity: 'gap', issues: [issue] } } : {},
    call: async (operation, body = {}) => {
      if (operation === 'setting') { if ('value' in body) settings.set(body.key, body.value); return { value: settings.get(body.key) }; }
      if (operation === 'findings') return { findings: [...findings.values()] };
      if (operation === 'finding') { findings.set(body.finding.id, body.finding); return {}; }
      throw new Error(operation);
    },
  });
  await service.inspect(sources);
  await service.inspect(sources);
  assert.equal(findings.size, 1);
  const finding = [...findings.values()][0];
  assert.equal(finding.diagnosisStage, 'source-discrepancy');
  assert.match(JSON.stringify(finding.presentation), /prior Buy has no published closure/);
  assert.match(JSON.stringify(finding.presentation), /unaffected research remain available/);
  assert.deepEqual(sources, original);
});

test('missing HedgAI, continuity gaps and verified recovery stay in Sources without Inbox warnings', async () => {
  for (const research of [null,
    { version: 1, product: 'hedgai-signals', book: { rows: [] }, sourceQuality: { continuity: 'gap', issues: [] } },
    { version: 1, product: 'hedgai-signals', book: { rows: [{ ticker: 'SPY' }] }, sourceQuality: { continuity: 'gap', issues: [] } },
    { version: 1, product: 'hedgai-signals', book: { rows: [{ ticker: 'SPY' }] }, sourceQuality: { continuity: 'complete', issues: [] } },
  ]) {
    const sources = { basis: 'review', state: 'succeeded', conversationId: 'c1', runId: 'r1', capturedAt: '2026-09-28T18:00:00Z',
      items: [{ id: 'hedgai-signals', label: 'HedgAI', status: 'unavailable' }] };
    const original = structuredClone(sources); const writes = [];
    const service = createSourceDiagnostics({ now: () => new Date('2026-09-28T19:00:00Z'),
      fetchJson: async path => path.startsWith('/api/research/hedgai?') ? research : {},
      call: async (operation, body = {}) => {
        if (operation === 'setting') return {};
        if (operation === 'findings') return { findings: [] };
        if (operation === 'finding') { writes.push(body.finding); return {}; }
        throw new Error(operation);
      },
    });
    assert.deepEqual((await service.inspect(sources)).findings, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(sources, original);
  }
});
