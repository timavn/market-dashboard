export function previewQuarters(group, now = new Date()) {
  const year = Number(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'America/New_York' }).format(now));
  const month = Number(new Intl.DateTimeFormat('en-US', { month: 'numeric', timeZone: 'America/New_York' }).format(now));
  const current = year * 4 + Math.floor((month - 1) / 3);
  const published = new Map((group?.columns || []).map(column => [column.id, column]));

  return Array.from({ length: 5 }, (_, index) => {
    const quarterIndex = current - 1 + index;
    const quarter = quarterIndex % 4 + 1;
    const quarterYear = Math.floor(quarterIndex / 4);
    const id = `${quarterYear}-Q${quarter}`;
    // Calendar labels do not change the publication's actual/estimate provenance.
    return {
      ...published.get(id),
      id,
      label: `${quarter}Q${String(quarterYear).slice(-2)}${index > 1 ? 'E' : ''}`,
      period: index === 0 ? 'previous' : index === 1 ? 'current' : 'estimate',
    };
  });
}
