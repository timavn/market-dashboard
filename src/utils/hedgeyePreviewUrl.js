/**
 * Stable Hedgeye preview media URLs (proxied through Express, not S3 presign).
 */

export function buildHedgeyeContentUrl(backendUrl, date, snapshotType) {
  const base = String(backendUrl || '').replace(/\/+$/, '');
  const encodedType = encodeURIComponent(snapshotType || 'risk-ranges');
  return `${base}/api/hedgeye/screenshot/${date}/content?type=${encodedType}`;
}

export function buildHedgeyeContentUrlFromRequest(req, date, snapshotType) {
  const protocol = req.protocol;
  const host = req.get('host');
  return buildHedgeyeContentUrl(`${protocol}://${host}`, date, snapshotType);
}

export function appendCacheBust(url) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}t=${Date.now()}`;
}
