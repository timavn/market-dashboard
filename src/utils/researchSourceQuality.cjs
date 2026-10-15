const { createHash } = require('node:crypto');

const clean = value => String(value || '').replace(/\p{Cc}/gu, ' ').trim();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const qualityIdentity = issue => issue.code === 'invalid_bounds' ? hash([
  issue.source?.productId, issue.source?.reportDate, issue.code,
  clean(issue.ticker).match(/\(([A-Z0-9.^-]+)\)$/i)?.[1] || issue.ticker,
  issue.field, issue.observed?.lrr, issue.observed?.hrr,
]) : issue.id;

// Quality findings are evidence about the publication itself. A successful
// import, an empty issues array, or a later edition does not correct that source.
function sourceQualityIssues(...values) {
  const issues = new Map();
  for (const value of values.flat().filter(Boolean)) {
    for (const issue of (Array.isArray(value.sourceQuality?.issues) ? value.sourceQuality.issues : [])) {
      if (!issue || typeof issue !== 'object' || !issue.code) continue;
      const copy = JSON.parse(JSON.stringify(issue));
      copy.id ||= hash([copy.code, copy.ticker, copy.field, copy.observed, copy.source]);
      const identity = qualityIdentity(copy);
      if (!issues.has(identity)) issues.set(identity, copy);
    }
    for (const artifact of (Array.isArray(value.artifacts) ? value.artifacts : [])) {
      for (const issue of sourceQualityIssues(artifact)) {
        const identity = qualityIdentity(issue);
        if (!issues.has(identity)) issues.set(identity, issue);
      }
    }
  }
  return [...issues.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function legacyRangeIssue(product) {
  const match = clean(product?.detail).match(/Invalid risk range for ([^:]{0,100})\(([A-Z0-9.^-]{1,15})\):\s*lrr=([\d.]+),\s*hrr=([\d.]+)/i);
  if (!match || Number(match[3]) <= Number(match[4])) return [];
  const source = { productId: product.id, reportDate: product.publicationDate || product.marketDate,
    messageId: (product.sourceIds || []).find(value => /^[a-f0-9]{16,}$/i.test(value)) || null };
  return [{ id: hash([source.productId, source.reportDate, match[2], 'invalid_bounds']), code: 'invalid_bounds',
    ticker: match[2], field: 'riskRange', observed: { lrr: Number(match[3]), hrr: Number(match[4]), originalName: `${match[1].trim()} (${match[2]})` },
    message: clean(product.detail), disposition: 'withheld_from_structured_data', source }];
}

function publicationIssues(...values) {
  const structured = sourceQualityIssues(...values);
  return structured.length ? structured : values.flatMap(value => legacyRangeIssue(value));
}

function discrepancyText(issues) {
  return issues.map(issue => {
    const ticker = clean(issue.ticker) || 'Published';
    const { lrr, hrr } = issue.observed || {};
    if (issue.code === 'invalid_bounds' && lrr !== null && hrr !== null && lrr !== undefined && hrr !== undefined
      && String(lrr).trim() && String(hrr).trim() && Number.isFinite(Number(lrr)) && Number.isFinite(Number(hrr))
      && Number(lrr) >= Number(hrr)) {
      const number = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 12 });
      return `${ticker} has conflicting lower and upper bounds: published lower ${number(lrr)} ${Number(lrr) === Number(hrr) ? 'equals' : 'exceeds'} upper ${number(hrr)}.`;
    }
    return `${ticker}: ${clean(issue.message) || 'The published value needs verification.'}`;
  }).join(' ');
}

function discrepancySourceLinks(issues, label) {
  const links = new Map();
  for (const issue of issues) {
    const source = issue.source || {};
    const uri = /^https:\/\/[^\s]+$/i.test(source.url || '') ? source.url
      : source.messageId ? `gmail://message/${source.messageId}` : null;
    if (!uri || links.has(uri)) continue;
    const citation = { id: `cite_${hash(uri).slice(0, 32)}`, title: label || 'Source publication',
      product: source.productId, publicationDate: source.reportDate,
      sourceUri: uri, excerpt: discrepancyText([issue]) };
    links.set(uri, { label: label || 'Source publication', citation });
  }
  return [...links.values()];
}

module.exports = { sourceQualityIssues, publicationIssues, discrepancyText, discrepancySourceLinks };
