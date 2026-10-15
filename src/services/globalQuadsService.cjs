const TABLE = process.env.HEDGEYE_DAILY_SNAPSHOT_TABLE || 'HedgeyeDailySnapshot';
const SOURCE = 'hedgeye-published-global-quads';
const GROUPS = ['g20', 'em', 'global'];
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '')
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
  && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

function verifiedGlobalQuads(item) {
  if (item?.schemaVersion !== 1 || item.source !== SOURCE || !item.data?.sources) return null;
  const sources = {};
  for (const [id, source] of Object.entries(item.data.sources)) {
    if (!/^[a-f0-9]{64}$/.test(id) || source?.id !== id || !validDate(source.asOf)
      || !new RegExp(`^hedgeye-email/assets/global-quads/${id}\\.(png|jpg)$`).test(source.s3Key || '')) continue;
    const screenshot = source.sourceType === 'reviewed-screenshot';
    if (screenshot) {
      if (source.verification?.method !== 'visual-source-comparison' || !source.verification.reviewedBy
        || !/^[a-f0-9]{64}$/.test(source.verification.contentHash || '')
        || !Number.isFinite(Date.parse(source.verification.reviewedAt))) continue;
    } else if (!Number.isFinite(Date.parse(source.publishedAt)) || !/^[a-z0-9]+$/.test(source.gmailMessageId || '')) continue;
    sources[id] = {
      id, asOf: source.asOf, publishedAt: source.publishedAt,
      sourceType: screenshot ? 'reviewed-screenshot' : 'email',
      sourceUrl: screenshot ? null : `https://mail.google.com/mail/#all/${source.gmailMessageId}`,
      imageUrl: `/api/hedgeye/global-quads/source/${id}`, page: source.page || null,
    };
  }
  const groups = {};
  for (const key of GROUPS) {
    const group = item.data.groups?.[key];
    if (!group || group.group !== key || !validDate(group.asOf) || !sources[group.sourceId]
      || !Array.isArray(group.rows) || !Array.isArray(group.columns)) continue;
    if (sources[group.sourceId].sourceType === 'reviewed-screenshot'
      && item.data.sources[group.sourceId].verification.contentHash !== group.contentHash) continue;
    const columns = group.columns.filter(c => /^20\d{2}-Q[1-4]$/.test(c.id)
      && /^[1-4]Q\d{2}E?$/.test(c.label) && ['actual', 'estimate'].includes(c.kind)
      && c.id === `20${c.label.slice(2, 4)}-Q${c.label[0]}`
      && c.kind === (c.label.endsWith('E') ? 'estimate' : 'actual'));
    if (columns.length !== group.columns.length || new Set(columns.map(c => c.id)).size !== columns.length) continue;
    const rows = group.rows.map(row => ({ ...row, values: Object.fromEntries(
      Object.entries(row.values || {}).filter(([quarter, v]) => columns.some(c => c.id === quarter)
        && sources[v?.sourceId] && (v.quad == null || [1, 2, 3, 4].includes(v.quad))
        && ['actual', 'estimate'].includes(v.kind)),
    ) }));
    if (!rows.length || !rows.some(r => Object.values(r.values).some(v => v.quad != null))) continue;
    groups[key] = { group: key, asOf: group.asOf, sourceId: group.sourceId, columns, rows,
      currentCountries: group.currentCountries || [] };
  }
  if (!Object.keys(groups).length) return null;
  return { schemaVersion: 1, snapshotType: 'global-quads', source: SOURCE,
    date: Object.values(groups).map(g => g.asOf).sort().at(-1), data: { groups, sources } };
}

async function loadGlobalQuads(dynamodb) {
  const [snapshotResult, healthResult] = await Promise.allSettled([
    dynamodb.get({ TableName: TABLE, Key: { date: 'LATEST', snapshotType: 'global-quads' }, ConsistentRead: true }).promise(),
    dynamodb.get({ TableName: TABLE, Key: { date: 'LATEST', snapshotType: 'global-quads-health' }, ConsistentRead: true }).promise(),
  ]);
  if (snapshotResult.status === 'rejected') throw snapshotResult.reason;
  const snapshot = snapshotResult.value;
  const health = healthResult.status === 'fulfilled' ? healthResult.value : {};
  const verified = verifiedGlobalQuads(snapshot.Item);
  const screenshotMode = health.Item?.mode === 'reviewed-screenshot';
  const issues = Object.entries(screenshotMode ? {} : health.Item?.issues || {}).map(([messageId, issue]) => ({
    publishedAt: issue.publishedAt, sourceUrl: `https://mail.google.com/mail/#all/${messageId}`,
    detail: 'An emailed quad table could not be verified.',
  }));
  return { ...(verified || { schemaVersion: 1, snapshotType: 'global-quads', source: SOURCE,
    date: null, data: { groups: {}, sources: {} } }),
  available: Boolean(verified), ingestion: { lastCheckedAt: health.Item?.lastCheckedAt || null,
    mode: screenshotMode ? 'reviewed-screenshot' : 'email',
    status: healthResult.status === 'rejected' ? 'unavailable' : issues.length ? 'attention' : 'ok', issues } };
}

module.exports = { loadGlobalQuads, verifiedGlobalQuads };
