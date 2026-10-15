import { compactReviewMarkdown } from './analystReviewMarkdown';

test('new daily Portfolio Review preserves compact tables and source links', () => {
  const source = '# Portfolio Review\n\n<!-- analyst-daily-rollup -->\n\n## Since last review\n\n| Exposure | Previous | Current |\n| --- | --- | --- |\n| Gross | $100 | $120 |\n\n[Early Look](https://app.hedgeye.com/feed/123)';
  const result = compactReviewMarkdown(source);
  expect(result).toContain('| Gross | $100 | $120 |');
  expect(result).not.toContain('### Exposure:');
  expect(result).toContain('[Early Look](https://app.hedgeye.com/feed/123)');
  expect(compactReviewMarkdown(result)).toBe(result);
});

test('saved Balance Review account comparisons preserve dates, values, source links and original Direction for table presentation', () => {
  const table = `| Metric | Sep 22, 2026 | Sep 23, 2026 | Direction |
| --- | ---: | ---: | --- |
| **Net liquidation** | $175,378.64 | $175,500.00 | Higher [source](https://example.com/account) |
| Available funds | $0.00 | Unavailable | Pending \\| incomplete |`;
  const source = `# Balance Review\n\n## Account change\n\n${table}\n\nThe source observations are historical.`;
  const result = compactReviewMarkdown(source);
  expect(result).toBe(source);
  expect(result).not.toContain('### Metric:');
  expect(compactReviewMarkdown(result)).toBe(result);
});

test.each(['Dollar change', 'Change'])('approved five-column account table retains its authored explanations with a %s column', changeHeader => {
  const table = `| Metric | 2026-09-22 | 2026-09-23 | ${changeHeader} | What this means for the account |
| --- | ---: | ---: | ---: | --- |
| Net liquidation | $100.00 | $110.00 | +$10.00 | The reported account value is higher. [Account evidence](https://example.com/account) |
| Excess liquidity | $20.00 | $15.00 | -$5.00 | The reported maintenance-margin cushion is lower. |`;
  const source = `# Balance Review\n\n${table}`;
  const result = compactReviewMarkdown(source);
  expect(result).toBe(source);
  expect(compactReviewMarkdown(result)).toBe(result);
});

test('summary and detail account comparisons are deduplicated as complete tables without losing distinct rows', () => {
  const table = amount => `| Metric | Sep 22, 2026 | Sep 23, 2026 | Direction |
| --- | ---: | ---: | --- |
| Net liquidation | $100.00 | ${amount} | Higher |
| Available funds | $20.00 | $15.00 | Lower |`;
  const summary = table('$110.00');
  const detail = table('$120.00');
  const source = `# Balance Review\n\n${summary}\n\n<!-- analyst-details -->\n\n# Balance Review\n\n${detail}`;
  const result = compactReviewMarkdown(source);
  expect(result).toContain(summary);
  expect(result).toContain(detail);
  expect(compactReviewMarkdown(result)).toBe(result);
  const duplicate = compactReviewMarkdown(source.replace(detail, summary));
  expect(duplicate.split(summary)).toHaveLength(2);
  expect(duplicate).not.toContain('## Additional findings');
});

test.each([
  ['Metric', 'Sep 22, 2026', 'Sep 23, 2026', 'Direction', 'SPX', 'DXY'],
  ['Metric', 'Before', 'After', 'Direction', 'Net liquidation', 'Available funds'],
  ['Metric', 'Sep 22, 2026', 'Sep 23, 2026', 'Signal', 'Net liquidation', 'Available funds'],
  ['Metric', 'Sep 22, 2026', 'Sep 23, 2026', 'Direction', 'Net liquidation', 'Unsupported metric'],
])('unrelated legacy tables retain their existing compact outline behavior: %s / %s / %s / %s', (...columns) => {
  const [first, before, after, last, firstMetric, secondMetric] = columns;
  const source = `# Balance Review\n\n| ${first} | ${before} | ${after} | ${last} |\n| --- | --- | --- | --- |\n| ${firstMetric} | $100 | $110 | Higher |\n| ${secondMetric} | $20 | $15 | Lower |`;
  const result = compactReviewMarkdown(source);
  expect(result).toContain(`### Metric: ${firstMetric}`);
  expect(result).toContain(`### Metric: ${secondMetric}`);
  expect(result).toContain(`**${last}:** Higher`);
  expect(result).not.toContain('| --- |');
});

test('saved Balance review keeps one title, every distinct amount and caveat, with dates in Sources', () => {
  const source = `Last exchange trading day: **2026-09-04**.

# Balance Review

**Outcome:** Partial

- Available funds: **$85,173.30**; excess liquidity: **$85,204.10**; buying power: **$340,693.21**.
- borrowing: **Unavailable**; liquid buffer: **Unavailable**.
Only independently verified fields support capacity decisions.

<!-- analyst-details -->
# Balance Review

**Outcome:** Partial

## Account Summary
- Observed: **2026-09-07T01:07:33.264000Z**
- Available funds / buying power / excess liquidity: **$85,173.30 / $340,693.21 / $85,204.10**
- Long / short / gross / net exposure: **$142,505.09 / $85,592.32 / $228,097.41 / $56,912.77**
- Source refresh unavailable [evidence](https://example.com/evidence).
`;
  const result = compactReviewMarkdown(source);
  expect(result.match(/^# Balance Review$/gm)).toHaveLength(1);
  for (const amount of ['$85,173.30', '$85,204.10', '$340,693.21']) expect(result.split(amount)).toHaveLength(2);
  expect(result).toContain('**Short market value:** $85,592.32');
  expect(result).not.toContain('Observed:');
  expect(result).not.toContain('Partial');
  expect(result).toContain('**Borrowing balance:** Unavailable');
  expect(result).toContain('**Liquidity buffer:** Unavailable');
  expect(result).toContain('Only independently verified fields support capacity decisions.');
  expect(result).toContain('[evidence](https://example.com/evidence)');
  expect(result).toContain('2026-09-04');
  expect(compactReviewMarkdown(result)).toBe(result);
});

test.each(['Ready', 'Partial', 'Blocked'])('Balance Review omits redundant %s currency and observation lines', status => {
  const result = compactReviewMarkdown(`# Balance Review\n\n${status} · USD\n\n**Account:** U123\n\n**Observed:** 2026-09-18T17:33:54Z\n\n**Net liquidation:** $175,378.64\n\n## Exceptions & Data Status\n\n- Holdings verification unavailable since Sep 18 10:33 PT.`);
  expect(result).not.toContain(`${status} · USD`);
  expect(result).not.toContain('Observed:');
  expect(result).toContain('**Account:** U123');
  expect(result).toContain('**Net liquidation:** $175,378.64');
  expect(result).toContain('Holdings verification unavailable since Sep 18 10:33 PT.');
  expect(compactReviewMarkdown(result)).toBe(result);
});

test('other reviews and ordinary messages retain their observation fields and statuses', () => {
  for (const title of ['# Portfolio Review', '# Predictive Markets Review', 'Balance details']) {
    const source = `${title}\n\nPartial · USD\n\n**Observed:** 2026-09-18T17:33:54Z`;
    expect(compactReviewMarkdown(source)).toBe(source);
  }
});

test('a blocked Balance Review omits its status even when currency is unavailable', () => {
  const result = compactReviewMarkdown('# Balance Review\n\nBlocked · Unavailable\n\n## Exceptions & Data Status\n\n- IBKR balances unavailable.');
  expect(result).not.toContain('Blocked · Unavailable');
  expect(result).toContain('IBKR balances unavailable.');
});

test('saved contract rows retain empty cells, escaped pipes, unavailable states and explicit zero', () => {
  const result = compactReviewMarkdown(`# Predictive Markets Review

| Contract | Venue | Native book | Value | Source |
|---|---|---|---|---|
| Test\\|contract | | Unavailable | $0.00 | [source](https://example.com) |
`);
  expect(result).toContain('### Contract: Test\\|contract');
  expect(result).toContain('**Venue:** —');
  expect(result).toContain('**Native book:** Unavailable');
  expect(result).toContain('**Value:** $0.00');
  expect(result).toContain('**Source:** [source](https://example.com)');
  expect(result).not.toContain('|---|');
});

test('an ambiguous saved metric group is never relabeled or partially dropped', () => {
  const line = '- Account / currency: **segment / account / USD**';
  expect(compactReviewMarkdown(`# Balance Review\n\n${line}`)).toContain(line);
});

test('saved narrative metrics use the same outline without changing the dated analysis', () => {
  const result = compactReviewMarkdown('## Balance Review — Partial\n\nThis is dated analysis.\n\n### Source statements\n- Available funds: **$85,165.26**\n- Open orders / same-day executions: **0 / 8**\n- Code-computed add-long room: **$0.00**');
  expect(result).toContain('**Available funds:** $85,165.26');
  expect(result).toContain('**Open orders:** 0');
  expect(result).toContain('**Same-day executions:** 8');
  expect(result).toContain('**Code-computed add-long room:** $0.00');
  expect(result).toContain('This is dated analysis.');
});

test('saved portfolio findings and withheld sizing survive removal of the duplicate summary title', () => {
  const result = compactReviewMarkdown(`# Portfolio Review
**Outcome:** Partial
- Verified NLV: **$100,000.00**. Gross exposure: **$80,000.00**.
- **TEST**: conflict. Process action: review. cite_123
  - contract: YES at native 0.3; sizing withheld.
<!-- analyst-details -->
# Portfolio Review
**Outcome:** Partial
- Net liquidation value: **$100,000.00**
- Gross exposure: **$80,000.00**
`);
  expect(result.match(/^# Portfolio Review$/gm)).toHaveLength(1);
  expect(result.split('$100,000.00')).toHaveLength(2);
  expect(result).toContain('cite_123');
  expect(result).toContain('sizing withheld.');
});

test('ordinary chat and fenced source examples retain their original content', () => {
  const chat = 'Use this table:\n| A | B |\n|---|---|\n| x | y |';
  expect(compactReviewMarkdown(chat)).toBe(chat);
  const code = '```markdown\n- Observed: **2026-09-07T01:07:33Z**\n| A | B |\n|---|---|\n| x | y |\n```';
  expect(compactReviewMarkdown(`# Balance Review\n\n${code}`)).toContain(code);
});
