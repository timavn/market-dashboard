export const labelOffsetAttributes = (verticalOffset) => ({
  'data-label-offset': Number(verticalOffset || 0).toFixed(2),
  'data-collision-adjusted': Math.abs(Number(verticalOffset || 0)) > 0.01 ? 'true' : undefined,
});

const CHART_LABEL_LAYOUT_HEIGHT_PX = 220;

const CHART_LABEL_MIN_GAP_PX = 16;

const CHART_LABEL_EDGE_PADDING_PX = 8;

const CHART_LABEL_TIE_PRIORITY = Object.freeze({ ath: 0, hrr: 1, contract: 2, latest: 3, lrr: 4 });

export const resolveChartLabelOffsets = (labels, domain, options = {}) => {
  const offsets = Object.fromEntries((labels || [])
    .filter((label) => label?.id)
    .map((label) => [label.id, 0]));
  const minimum = Number(domain?.[0]);
  const maximum = Number(domain?.[1]);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) return offsets;

  const height = Math.max(1, Number(options.height) || CHART_LABEL_LAYOUT_HEIGHT_PX);
  const gap = Math.max(1, Number(options.minGap) || CHART_LABEL_MIN_GAP_PX);
  const requestedPadding = Math.max(0, Number(options.padding) || CHART_LABEL_EDGE_PADDING_PX);
  const padding = Math.min(requestedPadding, height / 2);
  const usableHeight = Math.max(1, height - (padding * 2));
  const positioned = (labels || []).map((label, index) => ({
    ...label,
    index,
    value: Number(label?.value),
  })).filter((label) => label.id && Number.isFinite(label.value))
    .map((label) => ({
      ...label,
      rawY: padding + (((maximum - label.value) / (maximum - minimum)) * usableHeight),
      priority: CHART_LABEL_TIE_PRIORITY[label.id] ?? label.index,
    }))
    .sort((left, right) => left.rawY - right.rawY || left.priority - right.priority || left.index - right.index);

  const clusters = [];
  positioned.forEach((label) => {
    const cluster = clusters[clusters.length - 1];
    const prior = cluster?.[cluster.length - 1];
    if (!cluster || label.rawY - prior.rawY >= gap) clusters.push([label]);
    else cluster.push(label);
  });

  clusters.filter((cluster) => cluster.length > 1).forEach((cluster) => {
    const center = cluster.reduce((sum, label) => sum + label.rawY, 0) / cluster.length;
    const clusterHeight = (cluster.length - 1) * gap;
    const maximumStart = Math.max(padding, height - padding - clusterHeight);
    const start = Math.min(Math.max(center - (clusterHeight / 2), padding), maximumStart);
    cluster.forEach((label, index) => {
      offsets[label.id] = Number(((start + (index * gap)) - label.rawY).toFixed(2));
    });
  });
  return offsets;
};
