import { balanceReviewMessages } from './balanceReviewPresentation';

const report = {
  id: 'report', role: 'assistant', state: 'complete',
  text: '# Balance Review\n\n**Net liquidation:** $175,226.47\n\n**Available funds:** $98,981.77\n\n**Buying power:** $395,927.09\n\n**Excess liquidity:** $102,216.50\n\n**Trim requirement:** $1,766.48\n\n**Policy buffer:** $7,160.42\n\n**MTD net accrued:** $-93.87\n\n**Verified debit:** $1.16\n\n## Exceptions & Data Status\n\n- Verified portfolio exposure cross-check was unavailable.',
  citations: [{ id: 'balance', title: 'Verified balance' }],
};
const narrative = {
  id: 'narrative', role: 'assistant', state: 'complete', reviewNarrative: true,
  citations: [{ id: 'interest', title: 'Interest evidence' }],
  text: `## Review notes

**Net liquidation:** $175,226.47, with the broker observation refreshed and live-verified at **2026-09-17 16:07:21.988230 UTC**.

**Cash and borrowing:** Available funds are $98,981.77, while borrowing balance remains unavailable.

**Funding capacity:** Buying power is $395,927.09 and excess liquidity is $102,216.50.

**Margin health:** Healthy, but buffered room is $0.00 because the securities and commodity cash floors constrain additional longs.

**Material change:** The report shows a $1,766.48 trim requirement and a $7,160.42 policy buffer.

**Settlement:** Settlement remained pending for **2026-09-17**, with no open orders and 20 same-day executions.

**Interest:** MTD net accrued interest was **-$93.87**, including a verified debit of **$1.16** observed on **2026-09-17**.

**Analyst judgment:** Do not add longs while buffered room is zero. Any trim should be process-driven by the $1,766.48 requirement rather than discretionary sizing.

- **Action:** Preserve funding capacity until settlement and cash-floor constraints clear.
- **Action:** Reassess the trim requirement after the next verified balance refresh.
- **Missing evidence:** Borrowing balance, liquidity buffer, interest forecast range, latest actual interest, latest posting amount, and the independent position cross-check remain unavailable.

**Process status:** The independent portfolio refresh was live-verified at **2026-09-17 16:07:22.414057 UTC**, but it did not provide a usable holdings cross-check in the available evidence.`,
};

test('the saved verbose balance recap becomes three issue bullets with its original source evidence', () => {
  const messages = [report, narrative];
  const original = JSON.stringify(messages);
  const [result] = balanceReviewMessages(messages, 'balance-review');
  expect(balanceReviewMessages(messages, 'balance-review')).toHaveLength(1);
  expect(result.text.match(/^## Exceptions & Data Status$/gm)).toHaveLength(1);
  expect(result.text.match(/^- /gm)).toHaveLength(3);
  expect(result.text).toContain('Buffered room is $0.00 because the securities and commodity cash floors constrain additional longs.');
  expect(result.text).toContain('Trim requirement: **$1,766.48**.');
  expect(result.text).toContain('**Missing evidence:** Borrowing balance, liquidity buffer, interest forecast range, latest actual interest, latest posting amount, and the independent position cross-check remain unavailable.');
  expect(result.text).not.toMatch(/Review notes|Process status|Analyst judgment|\*\*Action:|live-verified|16:07/);
  expect(result.text.split('## Exceptions & Data Status')[1]).not.toMatch(/\$395,927|\$7,160|\$93.87/);
  expect(result.text).toContain('**MTD net accrued:** $-93.87');
  expect(result.citations).toEqual([...report.citations, ...narrative.citations]);
  expect(JSON.stringify(messages)).toBe(original);
});

test('unfamiliar findings under routine labels retain their complete dates, amounts and citations', () => {
  const uniqueFinding = '**Interest:** Short-borrow fees jumped to $230 on 2026-09-18; reconcile the debit with [broker evidence](https://example.com/fee).';
  const uniqueStatus = '**Process status:** The balance API failed after the refresh; the independently verified holdings snapshot is stale.';
  const [result] = balanceReviewMessages([report, { ...narrative, text: `## Review notes\n\n${uniqueFinding}\n\n${uniqueStatus}` }], 'balance-review');
  expect(result.text).toContain(uniqueFinding);
  expect(result.text).toContain(uniqueStatus);
});

test('new issue-only narratives merge once and do not override existing data gaps with an all-clear', () => {
  const [result] = balanceReviewMessages([report, { ...narrative, text: '## Balance issues\n\n- Verified portfolio exposure cross-check was unavailable.\n- No additional issues found.\n- No additional findings beyond the data gaps above.' }], 'balance-review');
  expect(result.text.match(/cross-check/g)).toHaveLength(1);
  expect(result.text).not.toContain('No additional issues found');
  expect(result.text).not.toContain('No additional findings');
  expect(result.text).not.toContain('Balance issues');
});

test('a complete verified empty-state remains concise when there are no additional findings', () => {
  const clear = { ...report, text: '# Balance Review\n\n## Exceptions & Data Status\n\nNo issues found.' };
  const [result] = balanceReviewMessages([clear, { ...narrative, text: '## Balance issues\n\nNo additional issues found.' }], 'balance-review');
  expect(result.text).toBe(clear.text);
});

test('an additional evidenced issue replaces the report empty-state', () => {
  const clear = { ...report, text: '# Balance Review\n\n## Exceptions & Data Status\n\nNo issues detected.' };
  const [result] = balanceReviewMessages([clear, { ...narrative, text: '## Balance issues\n\n- Borrow fees exceed the verified policy limit.' }], 'balance-review');
  expect(result.text).not.toContain('No issues detected');
  expect(result.text).toContain('Borrow fees exceed the verified policy limit.');
});

test('ordinary follow-ups, other reviews, streaming and unpaired messages remain unchanged', () => {
  const chat = { ...narrative, reviewNarrative: false };
  expect(balanceReviewMessages([report, chat], 'balance-review')).toEqual([report, chat]);
  expect(balanceReviewMessages([report, narrative], 'portfolio-review')).toEqual([report, narrative]);
  const running = { ...narrative, state: 'running' };
  expect(balanceReviewMessages([report, running], 'balance-review')).toEqual([report, running]);
  const user = { id: 'user', role: 'user', text: 'Explain the figures' };
  expect(balanceReviewMessages([report, user, narrative], 'balance-review')).toEqual([report, user, narrative]);
  expect(balanceReviewMessages([narrative], 'balance-review')).toEqual([narrative]);
});

test('legacy-looking new findings and distinct updated amounts are never removed by label alone', () => {
  const findings = ['**Net liquidation:** $170,000.00 on 2026-09-18, below yesterday’s $175,226.47.', '**Settlement:** Settlement failed for 2026-09-17.', '**Action:** Reconcile the unexplained $5,226.47 cash difference.'];
  const [result] = balanceReviewMessages([report, { ...narrative, text: `## Review notes\n\n${findings.join('\n\n')}` }], 'balance-review');
  findings.forEach(finding => expect(result.text).toContain(finding));
});

test('a familiar recap with a newer changed amount retains its amount and observation date', () => {
  const update = '**Net liquidation:** $170,000.00, with the broker observation refreshed and live-verified at **2026-09-18 16:07:21.988230 UTC**.';
  const [result] = balanceReviewMessages([report, { ...narrative, text: `## Review notes\n\n${update}` }], 'balance-review');
  expect(result.text).toContain(update);
});

test('opposite signs are distinct even when a money sign can appear before or after the dollar symbol', () => {
  const changed = '**Interest:** MTD net accrued interest was **$93.87**, including a verified debit of **$1.16** observed on **2026-09-18**.';
  const [result] = balanceReviewMessages([report, { ...narrative, text: `## Review notes\n\n${changed}` }], 'balance-review');
  expect(result.text).toContain(changed);
});
