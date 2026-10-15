import { presentVerificationMarkdown, remarkAnalystVerificationCopy, verificationHoldings } from './analystVerificationPresentation';

const scope = `### Verification scope

- Account: IBKR \`Account123\`.
- Current book: 73 rows; 73/73 fresh marks; 0 missing marks; 73/73 valued; all returned marks were \`live\`.
- Security metadata: \`securityName\` was null for the 73 rows.
- Indexed research coverage: 18 available products. Latest dates were:
  - 30 September: HedgAI Signals, Risk Ranges, Early Look, Bitcoin Tracker, Portfolio Solutions, Signal Strength, Real-Time Alerts, Top 3 Things, Macro Show, The Call, Market Situation Report, ETF Pro, and Investing Ideas.
  - 29 September: MOMO Tracker and Inflation Nowcast.
  - 22 September: CFTC Positioning.
  - 26 August: Crypto Quant.
  - 20 March: Volume / Market Structure.
- Process context: sizing policy dated 18 September 2026, with canonical signal rules.
  Continued internal details.

### What is already aligned
Captured research readings stay unchanged. 【[1]】
`;

test('omits the three requested explanatory paragraphs while preserving action and publication evidence', () => {
  const paragraphs = [
    'Your process exits an existing position when Trade breaks; a Trend break with Trade still aligned instead reduces it to MIN. Neither rule can be selected from “Trade and/or Trend,” a generic cover label, or list membership alone. The readable reconciliation did not authorize a current action for any of these holdings.',
    'The original alerts say Cover-SOME—not full cover. The reconciliation’s generic “Cover” label for CHH, VFC and JACK must not be interpreted as an instruction to close those shorts.',
    'These are the verification’s latest publication dates. They do not prove complete delivery or examination of every edition.',
  ];
  const prose = value => ({ type: 'paragraph', children: [{ type: 'text', value }] });
  const action = prose('CHH — Cover-SOME, 24 Sep 2026 15:37 EDT.');
  const table = { type: 'table', children: [{ type: 'tableRow', children: [{ type: 'tableCell', children: [prose('Risk Ranges | 1 Oct 2026')] }] }] };
  const sourceQuote = { type: 'blockquote', children: [prose(paragraphs[0])] };
  const code = { type: 'code', value: paragraphs[2] };
  const emphasized = { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: paragraphs[1].slice(0, 46) }] },
    { type: 'text', value: paragraphs[1].slice(46).replaceAll(' ', '\n') }] };
  const tree = { type: 'root', children: [prose(paragraphs[0]), action, emphasized, table, prose(paragraphs[2]), sourceQuote, code] };
  const present = remarkAnalystVerificationCopy({ reviewKind: 'portfolio-cross-verification' });
  present(tree);
  expect(tree.children).toEqual([action, table, sourceQuote, code]);
  present(tree);
  expect(tree.children).toEqual([action, table, sourceQuote, code]);
});

test.each(['chat', 'portfolio-review', 'balance-review', 'prediction-markets-review'])('keeps %s explanatory copy unchanged', reviewKind => {
  const tree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text',
    value: 'These are the verification’s latest publication dates. They do not prove complete delivery or examination of every edition.' }] }] };
  const captured = JSON.stringify(tree);
  remarkAnalystVerificationCopy({ reviewKind })(tree);
  expect(JSON.stringify(tree)).toBe(captured);
});

test('scope retains account and all counts, removes internal metadata and makes complete research coverage a dated table', () => {
  const display = presentVerificationMarkdown(scope);
  expect(display).toContain('- Account: IBKR `Account123`.');
  expect(display).toContain('- Current book: 73 rows; 73/73 fresh marks; 0 missing marks; 73/73 valued; all returned marks were `live`.');
  expect(display).not.toMatch(/Security metadata|Process context|Continued internal details|Latest dates were/);
  expect(display).toContain('- Indexed research coverage: 18 available products.');
  expect(display).toContain('| Product | Latest publication |');
  expect(display).toContain('| Investing Ideas | 30 September |');
  expect(display).toContain('| Inflation Nowcast | 29 September |');
  expect(display).toContain('| Volume / Market Structure | 20 March |');
  expect(display.split('\n').filter(line => /^\| [^|-].+ \|/.test(line))).toHaveLength(19);
  expect(display).toContain('Captured research readings stay unchanged. 【[1]】');
  expect(scope).toContain('Security metadata');
  expect(presentVerificationMarkdown(display)).toBe(display);
});

test('only missing descriptive table labels use sourced names; every captured numeric and analytical cell remains unchanged', () => {
  const original = `${scope}
| Ticker | Security | Qty | Live mark | Check result |
| --- | --- | --- | --- | --- |
| CVI | CVI (STK; name unavailable) | +75.0 | 51.27 | RT SELL-SOME, 30 Sep |
| DBMF | Captured original fund | +100.0 | 32.59 | PS rank only; rule gate unknown |
| GIII | name unavailable | -129.375 | 27.12 | Unknown |
`;
  const identities = { CVI: { name: 'CVR Energy, Inc.', source: 'SEC' }, DBMF: { name: 'Today\'s label', source: 'Provider' }, GIII: { name: 'Unverified label' } };
  const display = presentVerificationMarkdown(original, identities);
  expect(display).toContain('| CVI | CVR Energy, Inc. | +75.0 | 51.27 | RT SELL-SOME, 30 Sep |');
  expect(display).toContain('| DBMF | Captured original fund | +100.0 | 32.59 | PS rank only; rule gate unknown |');
  expect(display).toContain('| GIII | — | -129.375 | 27.12 | Unknown |');
  expect(display).not.toContain('STK; name unavailable');
  expect(verificationHoldings(original)).toEqual([
    { holding: 'CVI', securityName: null }, { holding: 'DBMF', securityName: 'Captured original fund' }, { holding: 'GIII', securityName: null },
  ]);
  expect(original).toContain('CVI (STK; name unavailable)');
});

test('unrelated sections, fenced examples and existing coverage tables remain unchanged', () => {
  const original = '### Other notes\n- Process context: applicable source commentary.\n\n```markdown\n| Ticker | Security |\n| CVI | name unavailable |\n```\n\n### Verification scope\nIndexed research coverage: 1 product.\n\n| Product | Latest publication |\n| --- | --- |\n| Risk Ranges | 30 September |';
  expect(presentVerificationMarkdown(original, { CVI: { name: 'CVR Energy', source: 'SEC' } })).toBe(original);
  expect(verificationHoldings(original)).toEqual([]);
  const example = '### Verification scope\n\n```markdown\n- Process context: literal source example.\n- Security metadata: literal source example.\n```';
  expect(presentVerificationMarkdown(example)).toBe(example);
});

test('provider names are escaped as display text rather than markup', () => {
  const original = '| Ticker | Security | Qty |\n| --- | --- | --- |\n| TEST | name unavailable | +1 |';
  const display = presentVerificationMarkdown(original, { TEST: { name: 'A *fund* | B <company>', source: 'Provider' } });
  expect(display).toContain('A \\*fund\\* \\| B \\<company\\>');
});

const holdingsHeader = '| Ticker | Security | Held side / contract | Dated source reading | Check / implication |';
const holdingsSeparator = '|---|---|---|---|---|';
const cpi36 = '| KXCPIYOY | — | Long YES; `KXCPIYOY-26SEP-T3.6_YES` | CPI nowcast, 29 Sep [[1]] | Unavailable; review instrument separately |';
const cpi37 = '| KXCPIYOY | — | Short NO; `KXCPIYOY-26SEP-T3.7_NO` | — | Unavailable; review instrument separately |';
const cloz = '| CLOZ | Eldridge BBB-B CLO ETF | Long | Published rank 4 — PS, 1 Oct 2026 [[6]] | Watch; review dated support |';
const dbmf = '| DBMF | iMGP DBi Managed Futures Strategy ETF | Short | Published rank 8 — PS, 1 Oct 2026 [[16]] | Watch; review dated support |';

test('mixed holdings checks put distinct captured event contracts underneath the compact securities table', () => {
  const original = ['### All holdings checked', '', 'Complete 4-position capture.', '', holdingsHeader, holdingsSeparator,
    cpi36, cloz, cpi37, dbmf, '', 'Sources: [[1]] [[6]] [[16]]'].join('\n');
  const display = presentVerificationMarkdown(original);
  const [securities, contracts] = display.split('#### Event contracts');
  expect(securities).toContain('| Ticker | Security | Held side | Dated source reading | Check / implication |');
  expect(securities).toContain(`${holdingsSeparator}\n${cloz}\n${dbmf}`);
  expect(securities).not.toContain('KXCPIYOY');
  expect(contracts).toContain(`${holdingsHeader}\n${holdingsSeparator}\n${cpi36}\n${cpi37}`);
  expect(display).toContain('Complete 4-position capture.');
  expect(display).toContain('Sources: [[1]] [[6]] [[16]]');
  const rowsOf = value => value.split('\n').filter(line => /^\| (?:KXCPIYOY|CLOZ|DBMF) \|/.test(line)).sort();
  expect(rowsOf(display)).toEqual(rowsOf(original));
  expect(presentVerificationMarkdown(display)).toBe(display);
  expect(original).toContain(`${cpi36}\n${cloz}\n${cpi37}\n${dbmf}`);
});

test('a securities-only holdings check uses Held side without adding an empty contract table', () => {
  const original = [holdingsHeader, holdingsSeparator, cloz, dbmf].join('\n');
  const display = presentVerificationMarkdown(original);
  expect(display).toBe(original.replace('Held side / contract', 'Held side'));
  expect(display).not.toContain('Event contracts');
  expect(presentVerificationMarkdown(display)).toBe(display);
});

test('an already separate event-contract table stays unchanged and retains every threshold and side', () => {
  const original = ['#### Event contracts', '', holdingsHeader, holdingsSeparator, cpi36, cpi37].join('\n');
  expect(presentVerificationMarkdown(original)).toBe(original);
  expect(verificationHoldings(original)).toEqual([
    { holding: 'KXCPIYOY', securityName: null }, { holding: 'KXCPIYOY', securityName: null },
  ]);
});

test('captured ForecastEx binary contract IDs split without guessing from a ticker alone', () => {
  const binary = '| CPIY | — | Long; `CPIY_0926-3.3_YES` | — | Captured contract check |';
  const ordinary = '| KXTEC | Captured fund | Long | — | Ordinary security check |';
  const display = presentVerificationMarkdown([holdingsHeader, holdingsSeparator, binary, ordinary].join('\n'));
  const [securities, contracts] = display.split('#### Event contracts');
  expect(securities).toContain(ordinary);
  expect(contracts).toContain(binary);
  expect(securities).not.toContain('CPIY_0926');
});

test('unrelated contract comparisons and malformed table rows are not regrouped', () => {
  const comparisons = [holdingsHeader.replace('Held side / contract', 'Contract'), holdingsSeparator, cpi36, cloz].join('\n');
  expect(presentVerificationMarkdown(comparisons)).toBe(comparisons);
  const malformed = [holdingsHeader, holdingsSeparator, cpi36, '| CLOZ | Captured name | Long |'].join('\n');
  expect(presentVerificationMarkdown(malformed)).toBe(malformed);
});

test.each([
  ['````markdown', '```', '~~~~', '````'],
  ['~~~~markdown', '~~~', '```', '~~~~'],
])('literal tables within %s fences stay intact through shorter or mismatched delimiters', (opening, shorter, mismatched, closing) => {
  const literal = [opening, holdingsHeader, holdingsSeparator, cpi36, cloz, shorter, mismatched,
    holdingsHeader, holdingsSeparator, cpi37, dbmf, closing].join('\n');
  const original = `${literal}\n\n${holdingsHeader}\n${holdingsSeparator}\n${cpi36}\n${cloz}`;
  const display = presentVerificationMarkdown(original);
  expect(display.startsWith(literal)).toBe(true);
  expect(display.match(/#### Event contracts/g)).toHaveLength(1);
  expect(verificationHoldings(original)).toEqual([
    { holding: 'KXCPIYOY', securityName: null }, { holding: 'CLOZ', securityName: 'Eldridge BBB-B CLO ETF' },
  ]);
  expect(presentVerificationMarkdown(display)).toBe(display);
});
