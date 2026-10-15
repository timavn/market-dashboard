const textOf = node => typeof node?.value === 'string'
  ? node.value : (node?.children || []).map(textOf).join('');

const paragraphsOf = node => node.type === 'list' && !node.ordered
  ? (node.children || []).flatMap(item => (item.children || []).flatMap(paragraphsOf)) : [node];

// Saved evidence stays intact; only the Watch list's list containers change.
export function remarkAnalystWatchList({ reviewKind } = {}) {
  return tree => {
    if (reviewKind !== 'portfolio-cross-verification') return;
    let watchDepth = null;
    tree.children = (tree.children || []).flatMap(node => {
      if (node.type === 'heading') {
        if (/^watch\s+list$/i.test(textOf(node).trim())) watchDepth = node.depth;
        else if (watchDepth !== null && node.depth <= watchDepth) watchDepth = null;
      }
      return watchDepth !== null ? paragraphsOf(node) : [node];
    });
  };
}
