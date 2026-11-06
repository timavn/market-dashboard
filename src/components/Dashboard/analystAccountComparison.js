import {
  accountComparisonCents, accountComparisonMeaning, accountComparisonMetric,
  formatAccountDollarChange, isAccountComparisonTable,
} from '../../utils/analystAccountComparison';

const textOf = node => node?.value ?? (node?.children || []).map(textOf).join('');
const cell = value => ({ type: 'tableCell', children: [{ type: 'text', value }] });
const simpleDirection = /^(?:improved|lower|higher|unchanged|no change|no deficit|(?:less|more)(?: net)? (?:long|short))\.?$/i;
const unsupported = /\b(?:unavailable|unverified|offline|disconnected|stale|cache[- ]only|cached|mock|seeded|hypothetical|estimated)\b/i;

// Enrich only recognized, dated account comparisons. The saved message text,
// original observations, timestamps and source links are never rewritten.
export function remarkAnalystAccountComparison() {
  return tree => {
    function visit(node) {
      if (node.type === 'table') {
        const [header, ...rows] = node.children || [];
        const headings = (header?.children || []).map(textOf);
        if (rows.some(row => row.children?.length !== headings.length)
          || !isAccountComparisonTable(headings, rows.map(row => textOf(row.children[0])))) return;
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: ['is-account-comparison'] } };
        node.align = ['left', 'right', 'right', 'right', 'left'];
        if (headings.length === 5) return; // Keep authored explanations and citations.
        const observations = rows.map(row => ({
          row, metric: accountComparisonMetric(textOf(row.children[0])),
          before: accountComparisonCents(textOf(row.children[1])),
          after: accountComparisonCents(textOf(row.children[2])),
          unavailable: unsupported.test([...headings, ...row.children.map(textOf)].join(' ')),
        }));
        const equity = observations.find(item => item.metric.key === 'equity' && !item.unavailable);
        header.children = [...header.children.slice(0, 3), cell('Dollar change'), cell('What this means for the account')];
        observations.forEach(({ row, metric, before, after, unavailable }) => {
          const comparable = !unavailable && before !== null && after !== null && Number.isSafeInteger(after - before);
          const delta = comparable ? after - before : null;
          const change = cell(comparable ? formatAccountDollarChange(delta) : '—');
          // A dollar change reads by its own sign: up green, down red.
          const tone = !comparable || delta === 0 ? 'muted' : delta > 0 ? 'positive' : 'negative';
          if (tone) change.data = { hProperties: { className: [`analyst-account-change--${tone}`] } };
          const explanation = comparable ? accountComparisonMeaning(metric, before, after, equity)
            : 'A comparable dollar amount is unavailable for one or both snapshots; the change cannot be established.';
          const original = row.children[3];
          const preserveOriginal = !simpleDirection.test(textOf(original).trim()) || original.children.some(child => child.type !== 'text');
          const meaning = preserveOriginal ? { ...original, children: [...original.children, { type: 'text', value: ` ${explanation}` }] } : cell(explanation);
          row.children = [...row.children.slice(0, 3), change, meaning];
        });
      } else if (!['code', 'inlineCode', 'html', 'blockquote', 'footnoteDefinition'].includes(node.type)) {
        (node.children || []).forEach(visit);
      }
    }
    visit(tree);
  };
}
