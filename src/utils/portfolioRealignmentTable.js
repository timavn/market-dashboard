const text = value => typeof value === 'string' ? value.trim() : '';
const array = value => Array.isArray(value) ? value : [];

export const realignmentColumns = ['Ticker', 'Security', 'Bias', 'Size', 'Source action', 'Notes', 'Source date'];
const legacyColumns = ['Ticker', 'Security', 'Position', 'Source reading', 'Review action', 'Date'];
const sameColumns = (actual, expected) => array(actual).length === expected.length
  && expected.every((column, index) => actual[index] === column);

export const isRealignmentTable = (section, block) => section.id === 'refresh-realignment'
  && sameColumns(block.columns, realignmentColumns);

// Reformat saved display text only; never derive a new bias or position size.
export function displayRealignmentTable(section, block) {
  if (section.id !== 'refresh-realignment' || !sameColumns(block.columns, legacyColumns)) return block;
  const indexes = [0, 1, 2, 2, 3, 4, 5];
  return { ...block, columns: [...realignmentColumns], rows: array(block.rows).map(row => {
    const position = text(row.cells?.[2]);
    const split = /^(Long|Short|Neutral)(?:(?:\s*·\s*|\s+)(\d+(?:\.\d+)?%|—))?$/.exec(position);
    return { ...row,
      cells: [row.cells?.[0], row.cells?.[1], split?.[1] || position || '—', split?.[2] || '—', ...array(row.cells).slice(3)],
      ...(row.cellTitles ? { cellTitles: indexes.map(index => array(row.cellTitles)[index]) } : {}),
      ...(row.cellCitationIds ? { cellCitationIds: indexes.map(index => [...array(row.cellCitationIds[index])]) } : {}),
    };
  }) };
}
