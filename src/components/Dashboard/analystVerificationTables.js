const cellText = node => typeof node?.value === 'string' ? node.value
  : (node?.children || []).map(cellText).join('');
const label = node => cellText(node).replace(/[*`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Bound only manual holdings checks; other reports keep their table layouts.
export function remarkAnalystVerificationTables({ reviewKind } = {}) {
  return tree => {
    if (reviewKind !== 'portfolio-cross-verification') return;
    const visit = node => {
      if (node.type === 'table') {
        const headers = (node.children?.[0]?.children || []).map(label);
        const securities = headers[0] === 'ticker' && headers[1] === 'security';
        const realignment = securities && ['current side', 'held side'].includes(headers[2])
          && ['dated source action', 'description', 'action'].includes(headers[3]);
        const kind = realignment ? 'is-realignment-check'
          : securities && headers[2] === 'held side' ? 'is-holdings-check'
          : securities && headers[2] === 'held side / contract' ? 'is-holdings-contracts'
            : headers[0] === 'contract' && headers[1] === 'yes/no' ? 'is-holdings-contracts' : null;
        if (realignment && ['dated source action', 'description'].includes(headers[3])) {
          node.children[0].children[3].children = [{ type: 'text', value: 'Action' }];
        }
        if (kind) {
          const properties = node.data?.hProperties || {};
          const classes = Array.isArray(properties.className) ? properties.className
            : String(properties.className || '').split(/\s+/).filter(Boolean);
          node.data = { ...node.data, hProperties: { ...properties, className: [...new Set([...classes, kind])] } };
        }
      }
      (node.children || []).forEach(visit);
    };
    visit(tree);
  };
}
