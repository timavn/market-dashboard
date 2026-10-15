import { compactReviewMarkdown } from './analystReviewMarkdown';

const EXCEPTIONS = /^## Exceptions & Data Status\s*$/m;
const BALANCE_REPORT = /^# Balance Review\s*$/m;
const plain = value => String(value || '').replace(/\*\*/g, '').trim();
const key = value => plain(value).replace(/^[-*]\s+/, '').replace(/[.]$/, '').toLowerCase();
const MONEY = '(?:-\\$|\\$-?)[\\d,]+(?:\\.\\d+)?';
const moneyKey = amount => Number(amount.replace(/[$,]/g, ''));
const DATE = '\\d{4}-\\d{2}-\\d{2}(?:[ T]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?: UTC|Z)?)?';
const routine = [
  new RegExp(`^${MONEY}, with the broker observation refreshed and live-verified at ${DATE}\\.$`, 'i'),
  new RegExp(`^Buying power is ${MONEY} and excess liquidity is ${MONEY}\\.$`, 'i'),
  new RegExp(`^Settlement remained pending for ${DATE}, with no open orders and \\d+ same-day executions\\.$`, 'i'),
  new RegExp(`^MTD net accrued interest was ${MONEY}, including a verified debit of ${MONEY} observed on ${DATE}\\.$`, 'i'),
];
const ALL_CLEAR = /^(?:No (?:additional )?issues (?:found|identified|detected)|No additional findings beyond the data gaps above|No exceptions(?: identified)?|All required Balance Review dependencies passed their verified-live gates)\.?$/i;

// Compatibility for the former generated recap. Only known, complete routine
// sentences are omitted. Unfamiliar wording remains visible, even under a
// normally routine label, so this formatter cannot hide a new finding.
function narrativeFindings(value, reportText) {
  const source = String(value || '').trim();
  const reportedAmounts = new Set((plain(reportText).match(new RegExp(MONEY, 'g')) || []).map(moneyKey));
  const amountsAlreadyReported = text => (plain(text).match(new RegExp(MONEY, 'g')) || []).every(amount => reportedAmounts.has(moneyKey(amount)));
  const legacy = /^#{1,3} Review notes\s*$/m.test(source);
  const entries = source.split(/\n\s*\n|\n(?=[-*]\s)/).map(block => block.trim()).filter(Boolean);
  const findings = [];
  const judgments = [];
  for (const entry of entries) {
    if (/^#{1,3} (?:Review notes|Balance issues|Exceptions & Data Status)\s*$/i.test(entry)) continue;
    const text = entry.replace(/^[-*]\s+/, '');
    const field = text.match(/^\*\*([^*]+?):\*\*\s*([\s\S]+)$/);
    if (!legacy || !field) { findings.push(text); continue; }
    const [, label, body] = field;
    const readable = plain(body);
    if (['Net liquidation', 'Funding capacity', 'Settlement', 'Interest'].includes(label)
      && routine.some(pattern => pattern.test(readable)) && amountsAlreadyReported(body)) continue;
    if (label === 'Cash and borrowing') {
      const match = body.match(new RegExp(`^Available funds are ${MONEY}, while (.+)$`, 'i'));
      if (match && amountsAlreadyReported(body)) { findings.push(match[1].replace(/^./, char => char.toUpperCase())); continue; }
    }
    if (label === 'Margin health') {
      const match = body.match(/^Healthy, but (.+)$/i);
      if (match) { findings.push(match[1].replace(/^./, char => char.toUpperCase())); continue; }
      if (/^Healthy\.?$/i.test(readable)) continue;
    }
    if (label === 'Material change') {
      const match = readable.match(new RegExp(`^The report shows a (${MONEY}) trim requirement and a ${MONEY} policy buffer\\.$`, 'i'));
      if (match && amountsAlreadyReported(body)) { if (Number(match[1].replace(/[$,]/g, '')) > 0) findings.push(`Trim requirement: **${match[1]}**.`); continue; }
    }
    if (label === 'Process status') {
      if (new RegExp(`^The independent portfolio refresh was live-verified at ${DATE}, but it did not provide a usable holdings cross-check in the available evidence\\.$`, 'i').test(readable)) {
        findings.push('Independent position cross-check unavailable.');
        continue;
      }
    }
    if (label === 'Analyst judgment' || label === 'Action') { judgments.push(text); continue; }
    findings.push(text);
  }
  const hasRoomIssue = findings.some(item => /buffered room is \$0(?:\.00)?\b/i.test(plain(item)));
  const hasTrimIssue = findings.some(item => /^Trim requirement:/i.test(plain(item)));
  for (const item of judgments) {
    const body = plain(item).replace(/^[^:]+:\s*/, '');
    if (hasRoomIssue && hasTrimIssue && amountsAlreadyReported(body) && new RegExp(`^Do not add longs while buffered room is zero\\. Any trim should be process-driven by the ${MONEY} requirement rather than discretionary sizing\\.$`, 'i').test(body)) continue;
    if (hasRoomIssue && /^Preserve funding capacity until settlement and cash-floor constraints clear\.$/i.test(body)) continue;
    if (hasTrimIssue && /^Reassess the trim requirement after the next verified balance refresh\.$/i.test(body)) continue;
    findings.push(item);
  }
  return findings;
}

function compactFindings(findings) {
  const unique = [...new Map(findings.map(item => [key(item), item])).values()];
  const missing = unique.find(item => /^Missing evidence:/i.test(plain(item)) && /unavailable\.?$/i.test(plain(item)));
  return unique.filter(item => {
    if (ALL_CLEAR.test(plain(item))) return false;
    if (!missing || item === missing) return true;
    // The legacy missing-evidence list already carries these exact gaps.
    if (/borrowing balance/i.test(missing) && /^Borrowing balance (?:remains |is )?unavailable\.?$/i.test(plain(item))) return false;
    if (/independent position cross-check/i.test(missing)
      && /^(?:Verified portfolio exposure cross-check was unavailable|Independent position cross-check unavailable)\.?$/i.test(plain(item))) return false;
    return true;
  });
}

function mergeReport(report, narrative) {
  const markdown = compactReviewMarkdown(report.text);
  const match = EXCEPTIONS.exec(markdown);
  if (!match) return null;
  const before = markdown.slice(0, match.index + match[0].length).trimEnd();
  const remainder = markdown.slice(match.index + match[0].length);
  const nextSection = remainder.search(/^## /m);
  const exceptionText = nextSection < 0 ? remainder : remainder.slice(0, nextSection);
  const after = nextSection < 0 ? '' : remainder.slice(nextSection);
  const existing = exceptionText.split(/\n\s*\n|\n(?=[-*]\s)/).map(line => line.trim().replace(/^[-*]\s+/, '')).filter(Boolean);
  const findings = compactFindings([...existing, ...narrativeFindings(narrative.text, markdown)]);
  // Preserve a verified report's own empty-state wording. A narrative saying
  // "no additional issues" cannot turn incomplete evidence into an all-clear.
  const body = findings.length ? findings.map(item => `- ${item}`).join('\n') : exceptionText.trim();
  const citations = [...new Map([...(report.citations || []), ...(narrative.citations || [])]
    .map(citation => [citation.id || JSON.stringify(citation), citation])).values()];
  return { ...report, text: [before, body, after].filter(Boolean).join('\n\n'), citations };
}

// Only adjacent completed automatic messages are combined; user follow-ups,
// other review types, and partial/streaming answers retain their original text.
export function balanceReviewMessages(messages, kind) {
  if (kind !== 'balance-review' || !Array.isArray(messages)) return messages;
  const result = [];
  for (const message of messages) {
    const report = result[result.length - 1];
    if (message.role === 'assistant' && message.reviewNarrative && message.state === 'complete'
      && report?.role === 'assistant' && !report.reviewNarrative && report.state === 'complete'
      && BALANCE_REPORT.test(report.text || '')) {
      const merged = mergeReport(report, message);
      if (merged) { result[result.length - 1] = merged; continue; }
    }
    result.push(message);
  }
  return result;
}
