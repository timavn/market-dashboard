import { analystVerificationSources, verificationSourceDate } from './analystVerificationSources';
import { presentVerificationMarkdown } from './analystVerificationPresentation';

const table = '| Product | Latest publication |\n| --- | --- |\n| Bitcoin Tracker | Archive: Jan 30, 2026; coverage monitor: Oct 5, 2026. Partial provenance. |\n| CFTC Positioning | Archive: Sep 29, 2026; coverage monitor: Sep 22, 2026, marked late. |\n| Crypto Quant | 5 Oct 2026 in archive; current view dated 26 Aug 2026. |\n| Risk Ranges | 5 Oct 2026, 11:51 UTC |\n| Volume | — |';

test.each([
  ['Archive: Jan 30, 2026; coverage monitor: Oct 5, 2026. Partial provenance.', { value: '2026-01-30', label: 'Jan 30' }],
  ['5 Oct 2026 in archive; current view dated 26 Aug 2026.', { value: '2026-10-05', label: 'Oct 5' }],
  ['2026-10-05T14:17:00Z; prior report Oct 2, 2026', { value: '2026-10-05T07:17:00-07:00', label: 'Oct 5 07:17 PDT' }],
  ['Jan 5, 2026, 07:15 UTC — partial provenance', { value: '2026-01-04T23:15:00-08:00', label: 'Jan 4 23:15 PST' }],
  ['30 September', { label: 'Sep 30' }],
  ['Sep 4 08:00 PT', { label: 'Sep 4 08:00 PT' }],
  ['Feb 30, 2026; monitor Oct 5, 2026', null],
  ['—', null],
])('the source date uses the Portfolio format and preserves the first publication: %s', (capture, expected) => {
  expect(verificationSourceDate(capture)).toEqual(expected);
});

test('moves only the captured indexed coverage into status rows and retains all date meanings', () => {
  const captured = `Intro.\n\n## Verification scope\nAccount checked.\n\n## Indexed research coverage\nBoth archive and coverage-monitor dates are shown.\n\n${table}\n\n## Watch list\nPreserved conclusion.`;
  const result = analystVerificationSources(captured);
  expect(result.markdown).toMatch(/^Intro\.\n\n## Verification scope\nAccount checked\.\n+## Watch list\nPreserved conclusion\.$/);
  expect(result.sources.basis).toBe('indexed-research');
  expect(result.sources.items.map(item => item.status)).toEqual(['partial', 'late', 'indexed', 'indexed', 'unavailable']);
  expect(result.sources.items[0].publicationLabel).toBe('Archive: Jan 30, 2026; coverage monitor: Oct 5, 2026. Partial provenance.');
  expect(result.sources.items[2].publicationLabel).toBe('5 Oct 2026 in archive; current view dated 26 Aug 2026.');
  expect(result.sources.items[3].publicationLabel).toBe('5 Oct 2026, 11:51 UTC');
  expect(result.sources.items[4].publicationLabel).toBeNull();
  expect(result.sources.detail).toBe('Both archive and coverage-monitor dates are shown.');
  expect(captured).toContain(table);
  expect(analystVerificationSources(result.markdown)).toEqual({ markdown: result.markdown, sources: null });
});

test('legacy nested scope coverage uses the same saved Sources projection without inventing a year', () => {
  const captured = '### Verification scope\n- Account: IBKR Account123.\n- Indexed research coverage: 2 available products. Latest dates were:\n  - 30 September: Risk Ranges, Early Look.\n- Process context: internal details.\n\n### Watch list\nCaptured reading.';
  const result = analystVerificationSources(presentVerificationMarkdown(captured));
  expect(result.sources.items.map(item => [item.label, item.publicationLabel, item.status])).toEqual([
    ['Risk Ranges', '30 September', 'indexed'], ['Early Look', '30 September', 'indexed'],
  ]);
  expect(result.markdown).toContain('- Account: IBKR Account123.');
  expect(result.markdown).not.toContain('Indexed research coverage');
  expect(result.markdown).toContain('Captured reading.');
});

test.each([
  `## Indexed research coverage\n\n${table.replace('| --- | --- |', '| --- |')}`,
  `## Indexed research coverage\n\n${table}\n| Extra | mismatched | row |`,
  `## Indexed research coverage\n\n| Product | Latest publication |\n| --- | --- |`,
  `## Other research\n\n${table}`,
  `\`\`\`markdown\n## Indexed research coverage\n${table}\n\`\`\``,
  `~~~markdown\n## Indexed research coverage\n${table}\n~~~`,
  `## Indexed research coverage\n\n${table.split('\n').map(line => `    ${line}`).join('\n')}`,
])('unrecognized or literal coverage stays intact', captured => {
  expect(analystVerificationSources(captured)).toEqual({ markdown: captured, sources: null });
});

test('all eighteen captured research products retain their original roster order', () => {
  const products = Array.from({ length: 18 }, (_, index) => `Product ${index + 1}`);
  const captured = `## Indexed research coverage\n\n| Product | Latest publication |\n| --- | --- |\n${products.map(product => `| ${product} | Oct 5, 2026 |`).join('\n')}`;
  expect(analystVerificationSources(captured).sources.items.map(item => item.label)).toEqual(products);
});

test.each([
  ['Oct 99, 2026', 'unavailable'], ['2026-99-99', 'unavailable'], ['Feb 30, 2026', 'unavailable'],
  ['Unavailable; prior publication Oct 5, 2026', 'unavailable'], ['Rejected Oct 5, 2026', 'unavailable'],
  ['Oct 5, 2026; not late; no provenance gaps', 'indexed'],
])('source status reflects captured evidence: %s', (publication, status) => {
  const captured = `## Indexed research coverage\n| Product | Latest publication |\n| --- | --- |\n| Risk Ranges | ${publication} |`;
  expect(analystVerificationSources(captured).sources.items[0].status).toBe(status);
});
