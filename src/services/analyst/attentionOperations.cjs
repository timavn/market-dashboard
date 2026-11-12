const crypto = require('node:crypto');
const {
  RESEARCH_PRODUCTS,
  getResearchProduct,
  isResearchProductDue,
  newYorkParts,
} = require('../../utils/researchProductRegistry.cjs');
const { buildRootCauses } = require('../../utils/systemReadiness.cjs');
const { publicationIssues, discrepancyText, discrepancySourceLinks } = require('../../utils/researchSourceQuality.cjs');
const { normalizePublishedTickResearch } = require('../../utils/publishedTickResearch.cjs');
const { suppressedAnalystInboxFinding } = require('../../utils/analystInboxAlerts.cjs');

const READINESS_PATH = '/api/system-readiness';
const STATUS_PATH = '/api/system-status';
const RANGE_PATH = '/api/risk-ranges?envelope=1';
// Systems has a five-minute collector cache and a bounded revalidation grace.
const READINESS_MAX_AGE_MS = 6 * 60_000;
const STATUS_MAX_AGE_MS = 2 * 60_000;
const PROCESSING_GRACE_MS = 15 * 60_000;

function fresh(value, now, maxAge = READINESS_MAX_AGE_MS) {
  const timestamp = Date.parse(String(value || ''));
  const age = now.getTime() - timestamp;
  return Number.isFinite(timestamp) && age >= -30_000 && age <= maxAge;
}

function unsafeEvidence(value) {
  return !value || value.stale === true || value.mock === true || value.seeded === true
    || value.seed === true || value.synthetic === true || value.from_cache === true || value.cacheOnly === true
    || ['status', 'source', 'freshness', 'cacheState'].some(key =>
      /^(?:mock|seed|seeded|synthetic|fixture|cache-only|stale)(?:$|[:_-])/i.test(String(value[key] || '')));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function finding({ key, subject, concern, impact, next, now, firstObservedAt, significance, priority = 1, path = READINESS_PATH }) {
  const publicationTime = Number.isFinite(Date.parse(firstObservedAt))
    ? new Date(firstObservedAt).toISOString() : now.toISOString();
  const id = `attention:operations:${key}`;
  const citation = {
    id: `cite_${digest(id).slice(0, 32)}`,
    title: 'Systems',
    product: 'dashboard-health',
    publicationDate: newYorkParts(publicationTime).date,
    sourceUri: path,
    excerpt: [concern, impact, next].filter(Boolean).join(' '),
  };
  return {
    attentionVersion: 1,
    id,
    sourceId: id,
    symbol: subject,
    action: 'operational issue',
    state: 'open',
    kind: 'operational',
    priority,
    publicationTime,
    fingerprint: digest({ key, priority, significance }),
    citation,
    presentation: {
      subject,
      date: citation.publicationDate,
      rows: [
        { label: 'Issue', text: concern },
        ...(impact ? [{ label: 'Impact', text: impact }] : []),
        ...(next ? [{ label: 'Next', text: next }] : []),
      ],
      sourceLinks: [{ label: 'Systems', citation }],
    },
  };
}

function verificationFinding({ now, research = false, key = 'monitor', significance = 'unverified' }) {
  return finding({
    key,
    subject: research ? 'Research delivery' : 'Dashboard monitoring',
    concern: research ? 'Research delivery unverified.' : 'Dashboard health unverified.',
    impact: research ? 'Unknown which research reached the dashboard.' : 'No all-clear; some views may be down.',
    next: 'Restore the failed check in Systems.',
    now,
    significance,
  });
}

function normalizeChecks(report) {
  return (report.groups || []).flatMap(group => (group.checks || []).map(check => ({
    ...check,
    label: check.label || check.id,
    dependsOn: Array.isArray(check.dependsOn) ? check.dependsOn : [],
    capabilityIds: Array.isArray(check.capabilityIds) ? check.capabilityIds : [],
  })));
}

function serviceCopy(check, affected = []) {
  const gatewayAffected = affected.some(id => id.startsWith('ibkr.'));
  if (check.id === 'dashboard.ui') return {
    subject: 'Dashboard availability',
    concern: 'Dashboard page down.',
    impact: 'New loads may fail; open pages stay visible.',
    next: 'Restart the web service in Systems → reload.',
  };
  if (check.id === 'hermes.controller') return {
    subject: 'Automatic recovery',
    concern: 'Auto-recovery check failed.',
    impact: 'Failed services may need manual repair.',
    next: 'Confirm auto-recovery resumes in Systems.',
  };
  if (check.id === 'dashboard.hermes-bridge') return {
    subject: 'Portfolio research updates',
    concern: 'Portfolio snapshot not delivered to research.',
    impact: 'Scheduled research may use an old portfolio.',
    next: 'Restore delivery in Systems.',
  };
  if (['DASHBOARD_CODE_VERSION_DRIFT', 'DASHBOARD_SUPERVISOR_CODE_DRIFT'].includes(check.errorCode)) return {
    subject: 'Dashboard restart',
    concern: 'Dashboard running old code.',
    impact: 'Recent fixes not live.',
    next: 'Restart the dashboard in Systems.',
  };
  if (check.id === 'ibkr.gateway') return {
    subject: 'IB Gateway',
    concern: check.errorCode === 'IBKR_GATEWAY_API_UNRESPONSIVE'
      ? 'IB Gateway unresponsive.' : 'IB Gateway disconnected.',
    impact: 'Holdings and balances frozen; no portfolio alerts.',
    next: check.errorCode === 'IBKR_GATEWAY_API_UNRESPONSIVE'
      ? 'Still unresponsive after 10 min → quit and reopen IB Gateway, sign in.'
      : 'Sign in to IB Gateway → confirm the portfolio refreshes.',
  };
  if (check.id === 'ibkr.sidecar' || check.id === 'ibkr.runtime') return {
    subject: 'Portfolio connection',
    concern: 'Brokerage connection down.',
    impact: 'Holdings, balances and IBKR quotes unverified.',
    next: 'Restore the brokerage service in Systems.',
  };
  if (check.id === 'ibkr.accounts' || check.id === 'ibkr.portfolio') return {
    subject: 'Portfolio updates',
    concern: check.errorCode === 'IBKR_PARTIAL_ACCOUNT_COVERAGE'
      ? 'Not all accounts connected.'
      : 'Holdings and balances unverified.',
    impact: 'Portfolio alerts paused until all accounts are current.',
    next: check.errorCode === 'IBKR_PARTIAL_ACCOUNT_COVERAGE'
      ? 'Log in to IB Gateway with all accounts → refresh.'
      : 'Confirm a fresh portfolio for every account in Systems.',
  };
  if (check.id === 'gmail.ingestion') return {
    subject: 'Research delivery',
    concern: check.errorCode === 'GMAIL_QUARANTINED_ARTIFACTS_PENDING'
      ? 'Some research failed to load.' : 'Research delivery unverified.',
    impact: 'Email research may be missing from the dashboard.',
    next: /AUTH|OAUTH/.test(check.errorCode || '')
      ? 'Re-authorize Gmail in Systems.'
      : 'Fix ingestion in Systems.',
  };
  if (check.id.startsWith('hermes.') && check.id !== 'hermes.controller') {
    const workerLabel = check.id === 'hermes.security' ? 'Security checks'
      : String(check.label || check.id).replace(/^Hermes\s+/i, '');
    return {
      subject: workerLabel,
      concern: /STALE|MISSING/.test(check.errorCode || '')
        ? `${workerLabel} overdue.`
        : `${workerLabel} failed.`,
      impact: check.id === 'hermes.security'
        ? 'Security checks not current.'
        : 'Scheduled research may be missing updates.',
      next: `Restore ${workerLabel} in Systems.`,
    };
  }
  if (check.id === 'analyst.runtime') return {
    subject: 'Analyst monitoring',
    concern: 'Analyst checks stalled.',
    impact: 'New items may reach the Inbox late.',
    next: 'Restore the worker in Systems.',
  };
  return {
    subject: check.label || 'Dashboard issue',
    concern: `${check.label || 'A dashboard service'} failing.`,
    impact: gatewayAffected ? 'Portfolio updates blocked.' : check.impact || 'Affected function unverified.',
    next: 'Inspect in Systems.',
  };
}

function productConcern(product, now, receiptHealthy) {
  const registered = getResearchProduct(product.id);
  const today = newYorkParts(now).date;
  const edition = product.marketDate || today;
  const due = edition === today && isResearchProductDue(registered, { now, marketDate: today });
  const stages = product.stages || {};
  // An explicit failed artifact still proves receipt even when no successful
  // "received" stage was written by the parser.
  const received = stages.received === true || Number(product.counts?.artifacts || 0) > 0;
  const issues = publicationIssues(product);
  if (issues.length && product.status !== 'indexed') return {
    stage: 'source-discrepancy',
    concern: discrepancyText(issues),
    impact: 'Received, but not yet imported.',
    next: 'Import it; withhold only the disputed fields → confirm with Hedgeye.',
  };
  // A failed risk-range read or an old edition is not evidence of a failed parse.
  if (!received) {
    if (!due || !receiptHealthy) return null;
    if (product.errorCode && ![
      'RESEARCH_PRODUCT_DUE_MISSING', 'RISK_RANGE_PUBLICATION_MISSING', 'RISK_RANGE_INGESTION_STALE',
    ].includes(product.errorCode)) return { verification: true };
    return {
      stage: 'missing',
      concern: `${registered?.label || product.label} missing for ${edition}.`,
      impact: 'Dashboard and Analyst lack this update.',
      next: 'Check delivery → import the edition.',
    };
  }
  if (product.status === 'failed') return {
    stage: 'processing-failed',
    concern: `${product.label || registered?.label} failed to load.`,
    impact: 'Its research is ignored.',
    next: /invalid risk range.+lrr=.+hrr=/i.test(product.detail || '')
      ? 'Get a corrected report before using these ranges.'
      : 'Repair the import in Systems.',
    ...( /invalid risk range.+lrr=.+hrr=/i.test(product.detail || '')
      ? { context: 'Risk Range low ≥ high → report rejected.' } : {}),
  };
  if (stages.indexed !== true && product.status !== 'indexed') {
    const observed = Date.parse(product.observedAt || '');
    // Let an ordinary newly received publication finish processing first.
    if (!Number.isFinite(observed)) return { verification: true };
    if (now.getTime() - observed < PROCESSING_GRACE_MS) return null;
    return {
      stage: 'processing-incomplete',
      concern: `${product.label || registered?.label} received, import stalled.`,
      impact: 'Latest edition not in all views.',
      next: 'Finish the import in Systems.',
    };
  }
  return null;
}

function attachProductEvidence(item, product) {
  item.incidentKey = `research-product:${product.id}:${product.marketDate}`;
  const issues = publicationIssues(product);
  // reportDate is a source calendar date, not a midnight-UTC observation. Keep
  // it authoritative instead of shifting it to the prior New York session.
  const reportDate = [issues[0]?.source?.reportDate, product.publicationDate, product.marketDate]
    .find(value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')));
  if (reportDate) {
    item.sourceReportDate = reportDate;
    item.presentation.date = reportDate;
    item.citation.publicationDate = reportDate;
  }
  if (issues.length) {
    item.sourceDiscrepancy = true;
    item.sourceQuality = { status: 'discrepancy', issues };
    item.presentation.sourceLinks.push(...discrepancySourceLinks(issues, product.label));
  }
  const messageId = (product.sourceIds || []).find(value => /^[a-f0-9]{16,}$/i.test(value));
  const hasLinkedPublication = issues.some(issue => issue.source?.messageId === messageId && /^https:\/\/[^\s]+$/i.test(issue.source?.url || ''));
  if (messageId && !hasLinkedPublication && !item.presentation.sourceLinks.some(link => link.citation.sourceUri === `gmail://message/${messageId}`)) item.presentation.sourceLinks.push({
    label: product.label || 'Research publication',
    citation: {
      id: `cite_${digest(messageId).slice(0, 32)}`, title: product.label || 'Research publication',
      product: product.id, publicationDate: product.publicationDate || product.marketDate,
      sourceUri: `gmail://message/${messageId}`, excerpt: item.presentation.rows[0].text,
    },
  });
  return item;
}

async function snapshotConsumerIssues({ matrix, fetchJson, now, diagnostics }) {
  const targets = matrix.products.flatMap(product => {
    const definition = getResearchProduct(product.id);
    const consumer = definition?.dashboardConsumer;
    if (product.status !== 'indexed' || consumer?.kind !== 'snapshot') return [];
    const path = consumer.path || consumer.pathTemplate?.replace('{product}', encodeURIComponent(definition.id));
    return path ? [{ product, path, consumer }] : [];
  });
  const results = await Promise.allSettled(targets.map(target => fetchJson(target.path)));
  const findings = [];
  let complete = true;
  diagnostics.coverage.snapshotConsumers = [];
  for (let index = 0; index < targets.length; index += 1) {
    const { product, path, consumer } = targets[index];
    const result = results[index];
    const payload = result.status === 'fulfilled' ? result.value : null;
    const hasContent = Boolean(payload && (
      (payload.data && typeof payload.data === 'object' && Object.keys(payload.data).length)
      || String(payload.article?.bodyText || '').trim()
    ));
    const receivedDate = String(payload?.date || '').slice(0, 10);
    const expectedDate = product.publicationDate || product.marketDate;
    const sourceId = typeof payload?.htmlSource === 'string' ? payload.htmlSource : null;
    const sourceMatch = sourceId && (product.sourceIds || []).includes(sourceId);
    const revisionMismatch = sourceId && (product.sourceIds || []).some(id => String(id).includes('/')) && !sourceMatch;
    const available = payload && !unsafeEvidence(payload) && payload.available !== false
      && payload.cacheState !== 'stale' && payload.snapshotType === product.id
      && receivedDate === expectedDate && hasContent && !revisionMismatch;
    diagnostics.paths.push(path);
    diagnostics.coverage.snapshotConsumers.push({
      product: product.id, path, expectedDate, receivedDate: receivedDate || null,
      available: Boolean(available), revisionEvidence: sourceMatch ? 'source-matched' : 'edition-only',
    });
    const issues = publicationIssues(product, available ? payload : null);
    if (issues.length) {
      if (!available) complete = false;
      findings.push(attachProductEvidence(finding({
        key: `product:${product.id}:${product.marketDate}`,
        subject: product.label,
        concern: discrepancyText(issues),
        impact: available
          ? 'Disputed fields withheld; the rest is usable.'
          : 'Disputed fields withheld; delivery of the rest unverified.',
        next: available
          ? 'Confirm the disputed values with Hedgeye.'
          : 'Restore delivery → confirm the disputed values with Hedgeye.',
        now, firstObservedAt: issues[0].source?.publishedAt || product.observedAt,
        significance: { stage: 'source-discrepancy', issues, available: Boolean(available) }, path,
      }), { ...product, sourceQuality: { status: 'discrepancy', issues } }));
      continue;
    }
    if (available) continue;
    // A failed GET establishes an unavailable check, not an absent publication.
    if (result.status === 'rejected' || !payload || unsafeEvidence(payload)) complete = false;
    const behind = receivedDate && receivedDate < expectedDate;
    const concern = behind
      ? `${product.label}: ${(consumer.label || 'Research view').toLowerCase()} shows ${receivedDate}, not ${expectedDate}.`
      : `${product.label}: ${(consumer.label || 'Research view').toLowerCase()} unverified.`;
    findings.push(attachProductEvidence(finding({
      key: `product:${product.id}:${product.marketDate}`,
      subject: product.label,
      concern,
      impact: 'This view may be out of date.',
      next: 'Restore delivery in Systems.',
      now,
      significance: { stage: 'consumer-unverified', destination: path, behind: Boolean(behind), revisionMismatch: Boolean(revisionMismatch) },
      path,
    }), product));
  }
  return { findings, complete };
}

async function publishedBookConsumerIssues({ fetchJson, now, diagnostics }) {
  const targets = RESEARCH_PRODUCTS.filter(product => product.dashboardConsumer.kind === 'published-book');
  const findings = [];
  let complete = true;
  diagnostics.coverage.publishedBookConsumers = [];
  for (const product of targets) {
    const path = `${product.dashboardConsumer.path}?asOf=${encodeURIComponent(now.toISOString())}`;
    diagnostics.paths.push(path);
    let payload;
    try { payload = await fetchJson(path); }
    catch (error) {
      diagnostics.errors.push({ path, reason: String(error?.message || 'unavailable') });
    }
    const verifiedRows = Object.values(normalizePublishedTickResearch(payload, { date: newYorkParts(now).date, asOf: now.toISOString() }));
    const available = verifiedRows.length > 0 && fresh(payload.asOf, now)
      && payload.product === product.id && payload.sourceQuality?.continuity === 'complete';
    diagnostics.coverage.publishedBookConsumers.push({ product: product.id, path, available: Boolean(available) });
    if (!available) { complete = false; continue; }
    const datedIssues = new Map();
    for (const issue of publicationIssues(payload).filter(item => item.resolved !== true)) {
      const date = issue.source?.reportDate || issue.publicationDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date > newYorkParts(now).date) continue;
      datedIssues.set(date, [...(datedIssues.get(date) || []), issue]);
    }
    for (const [date, issues] of datedIssues) {
      const issue = issues.find(item => ['HEDGAI_PUBLISHED_BOOK_COUNT_DISCREPANCY', 'HEDGAI_POSITION_COUNT_DISCREPANCY'].includes(item.code)) || issues[0];
      const publishedAt = issue.source?.publishedAt || issue.publishedAt;
      const countDiscrepancy = ['HEDGAI_PUBLISHED_BOOK_COUNT_DISCREPANCY', 'HEDGAI_POSITION_COUNT_DISCREPANCY'].includes(issue.code);
      const published = issue.observed?.published;
      const reconstructed = issue.observed?.reconstructed;
      const hasCounts = countDiscrepancy && [published?.long, published?.short, reconstructed?.long, reconstructed?.short]
        .every(value => Number.isInteger(value) && value >= 0);
      const parsingRecovered = payload.sourceQuality.issues.some(item => item.resolved === true);
      const item = attachProductEvidence(finding({
        key: `product:${product.id}:${date}`, subject: product.label,
        concern: hasCounts
          ? `Headline ${published.long}L/${published.short}S ≠ recorded ${reconstructed.long}L/${reconstructed.short}S.`
          : discrepancyText([issue]),
        impact: hasCounts
          ? `${parsingRecovered ? 'Parsing recovered' : 'Actions verified'}; totals don’t match.`
          : 'Disputed field unresolved; the rest is usable.',
        next: hasCounts
          ? 'Check the full-book PDF or a correction.'
          : 'Verify the disputed field against the source.',
        now, firstObservedAt: publishedAt,
        significance: { stage: 'source-discrepancy', issues }, path,
      }), { ...product, marketDate: date, publicationDate: date, sourceQuality: { status: 'discrepancy', issues } });
      item.presentation.rows.push({ label: 'Status', text: hasCounts
        ? `${verifiedRows.length} readings usable; totals unreconciled.`
        : 'Unresolved.' });
      findings.push(item);
    }
  }
  return { findings, complete };
}

/**
 * Read-only attention projection. Systems owns acquisition, provider freshness,
 * account verification and dependency policy; this layer turns those verified
 * results into compact incidents without treating monitor failures as missing mail.
 */
async function collectOperationalAttention({ fetchJson, now = new Date() }) {
  const clock = now instanceof Date ? now : new Date(now);
  const diagnostics = { checkedAt: clock.toISOString(), paths: [READINESS_PATH, STATUS_PATH, RANGE_PATH], errors: [], coverage: {} };
  const results = await Promise.allSettled(diagnostics.paths.map(path => fetchJson(path)));
  const payloads = results.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    diagnostics.errors.push({ path: diagnostics.paths[index], reason: String(result.reason?.message || result.reason || 'unavailable') });
    return null;
  });
  const [report, status, ranges] = payloads;
  const findings = [];
  let complete = true;
  // This cumulative publisher book has its own consumer. Its valid instrument
  // actions and aggregate discrepancies are independent of a daily snapshot or
  // whether a saved Analyst review happens to be open.
  const books = await publishedBookConsumerIssues({ fetchJson, now: clock, diagnostics });
  if (!books.complete) complete = false;
  const reportValid = !unsafeEvidence(report) && Array.isArray(report.groups)
    && fresh(report.checkedAt, clock);
  if (!reportValid) {
    complete = false;
    findings.push(verificationFinding({ now: clock }));
  }
  const checks = reportValid ? normalizeChecks(report) : [];
  const byId = new Map(checks.map(check => [check.id, check]));
  const statusValid = !unsafeEvidence(status) && Array.isArray(status.services)
    && fresh(status.checkedAt, clock, STATUS_MAX_AGE_MS);
  const currentPortfolioStatus = statusValid && status.services.find(service => service.id === 'live-portfolio');
  const portfolioRespondingAfterDeepFailure = currentPortfolioStatus?.status === 'online'
    && Date.parse(status.checkedAt) > Date.parse(report?.checkedAt || '')
    && ['ibkr-sidecar', 'gateway-session', 'managed-account', 'fresh-session'].every(id =>
      currentPortfolioStatus.details?.some(detail => detail.id === id && detail.status === 'online'));
  if (reportValid && ['ibkr.gateway', 'ibkr.accounts', 'ibkr.portfolio', 'gmail.ingestion']
    .some(id => !byId.has(id))) {
    complete = false;
    findings.push(verificationFinding({ now: clock, significance: 'missing-required-checks' }));
  }
  const matrix = reportValid ? report.researchProductMatrix : null;
  const matrixValid = matrix && Array.isArray(matrix.products) && fresh(matrix.generatedAt, clock)
    && !unsafeEvidence(matrix) && !(matrix.collectionErrors || []).length;
  const gmail = byId.get('gmail.ingestion');
  const receiptHealthy = gmail?.status === 'pass' && fresh(gmail.observedAt, clock,
    Math.max(READINESS_MAX_AGE_MS, Number(gmail.readinessMaxAgeMinutes || 0) * 60_000));
  const rootCauses = buildRootCauses(checks);
  const activeServiceKeys = new Set();
  for (const cause of rootCauses) {
    const check = byId.get(cause.checkId);
    if (!check || check.id.startsWith('research.')) continue;
    if (suppressedAnalystInboxFinding({ id: `attention:operations:${check.id}` })) {
      diagnostics.suppressedServiceChecks ||= [];
      diagnostics.suppressedServiceChecks.push({ id: check.id, status: check.status, errorCode: check.errorCode });
      continue;
    }
    // Both checks directly probe the consumer. Deep checkedAt is collection
    // completion, not the UI probe time, so ordering aggregate timestamps is
    // invalid. A fresh successful readback wins over a cached failed probe.
    const lightweightReadback = { 'dashboard.ui': ['dashboard', 'react-ui'], 'analyst.runtime': ['ai', 'analyst-runtime'] }[check.id];
    if (lightweightReadback) {
      const [serviceId, detailId] = lightweightReadback;
      const directStatus = statusValid
        ? status.services.find(service => service.id === serviceId)?.details
          ?.find(detail => detail.id === detailId)?.status : null;
      if (directStatus === 'online') continue;
      // A timeout/unknown probe cannot corroborate an outage. Keep the
      // ambiguous attempt in Systems diagnostics until both checks fail.
      if (check.id === 'dashboard.ui' && directStatus !== 'offline') {
        complete = false;
        diagnostics.uiAvailability = { state: 'unverified', deepStatus: check.status, directStatus: directStatus || 'unavailable' };
        continue;
      }
    }
    // Explicit product incidents below identify the quarantined imports. Keep
    // the aggregate warning in diagnostics instead of a second generic row.
    if (check.errorCode === 'GMAIL_QUARANTINED_ARTIFACTS_PENDING' && matrixValid
      && matrix.products.some(product => product.status === 'failed'
        && (product.stages?.received || Number(product.counts?.artifacts || 0) > 0))) {
      diagnostics.quarantinedImports = { errorCode: check.errorCode, summary: check.summary };
      activeServiceKeys.add('gmail.ingestion');
      continue;
    }
    if (check.status === 'warn' && !check.blocking
      && check.id !== 'gmail.ingestion' && check.errorCode !== 'IBKR_PARTIAL_ACCOUNT_COVERAGE'
      && !cause.affectedCheckIds.some(id => byId.get(id)?.status === 'fail')) continue;
    if (!check.impact && !check.blocking) continue;
    const key = check.id.startsWith('ibkr.') ? 'portfolio-connection'
      : ['DASHBOARD_CODE_VERSION_DRIFT', 'DASHBOARD_SUPERVISOR_CODE_DRIFT'].includes(check.errorCode)
        ? 'dashboard-code' : check.id;
    if (activeServiceKeys.has(key)) continue;
    activeServiceKeys.add(key);
    const awaitingAccountVerification = key === 'portfolio-connection' && portfolioRespondingAfterDeepFailure;
    if (awaitingAccountVerification) complete = false;
    findings.push(finding({
      key,
      ...(awaitingAccountVerification ? {
        subject: 'Portfolio verification',
        concern: 'Portfolio back; full recovery unverified.',
        impact: 'Positions pass; account check pending.',
        next: 'Confirm all accounts in Systems.',
      } : serviceCopy(check, cause.affectedCheckIds)),
      now: clock,
      firstObservedAt: check.firstFailedAt || check.failedAt,
      priority: check.id.startsWith('ibkr.') ? 0 : 1,
      significance: { checkId: check.id, errorCode: check.errorCode, severity: check.status },
    }));
  }
  if (reportValid && !matrixValid) {
    complete = false;
    if (!activeServiceKeys.has('gmail.ingestion')) findings.push(verificationFinding({ now: clock, research: true, key: 'research-verification' }));
  }
  if (matrixValid) {
    const coveredProducts = new Set(matrix.products.map(product => product.id));
    diagnostics.coverage.products = [...coveredProducts];
    diagnostics.coverage.uncheckedProducts = RESEARCH_PRODUCTS.filter(product => !coveredProducts.has(product.id)).map(product => product.id);
    if (diagnostics.coverage.uncheckedProducts.length) complete = false;
    let verificationMissing = false;
    for (const product of matrix.products) {
      if (getResearchProduct(product.id)?.dashboardConsumer?.kind === 'published-book'
        && books.findings.some(item => item.incidentKey === `research-product:${product.id}:${product.marketDate}`)) continue;
      // An email no registered product matches is a Systems coverage gap
      // (Daily research product pipeline), not something to act on from the Inbox.
      if (product.id.startsWith('unsupported:')) {
        (diagnostics.unregisteredPublications ||= []).push({ id: product.id, marketDate: product.marketDate, detail: product.detail });
        continue;
      }
      if (product.errorCode === 'RESEARCH_PIPELINE_EVIDENCE_UNAVAILABLE' || unsafeEvidence(product)) {
        verificationMissing = true;
        continue;
      }
      const issue = productConcern(product, clock, receiptHealthy);
      if (issue?.verification) { verificationMissing = true; continue; }
      if (!issue) continue;
      const item = finding({
        key: `product:${product.id}:${product.marketDate || newYorkParts(clock).date}`,
        subject: product.label || getResearchProduct(product.id)?.label || 'Research product',
        ...issue,
        now: clock,
        firstObservedAt: issue.stage.startsWith('processing') ? product.observedAt : null,
        significance: { stage: issue.stage, errorCode: product.errorCode || null, failures: Number(product.counts?.failures || 0),
          ...(publicationIssues(product).length ? { sourceQuality: publicationIssues(product) } : {}) },
      });
      if (issue.context) item.presentation.rows.splice(1, 0, { label: 'Context', text: issue.context });
      findings.push(attachProductEvidence(item, product));
    }
    if (!receiptHealthy && !activeServiceKeys.has('gmail.ingestion')) verificationMissing = true;
    if (verificationMissing) {
      complete = false;
      if (!activeServiceKeys.has('gmail.ingestion')) findings.push(verificationFinding({ now: clock, research: true, key: 'research-verification' }));
    }
    // These readiness checks read the actual ETF Pro and RTA consumer responses.
    for (const [checkId, productId] of [['research.rta', 'real-time-alert'], ['research.etf-pro', 'etf-pro']]) {
      const check = byId.get(checkId);
      const product = matrix.products.find(row => row.id === productId);
      if (!check || check.status === 'pass' || check.status === 'warn' || product?.status !== 'indexed') continue;
      if ((check.dependsOn || []).some(id => byId.get(id)?.status !== 'pass')) continue;
      findings.push(attachProductEvidence(finding({
        key: `product:${productId}:${product.marketDate}`,
        subject: product.label,
        concern: check.errorCode === 'INVALID_RESEARCH_EVENT'
          ? `${product.label} positions cannot be reconstructed from the imported reports.`
          : `${product.label} was received, but its dashboard view cannot serve the verified update.`,
        impact: check.errorCode === 'INVALID_RESEARCH_EVENT'
          ? 'The research position list is unavailable because some imported source actions failed validation.'
          : 'The publication is indexed, but this research view is unavailable or behind.',
        next: check.errorCode === 'INVALID_RESEARCH_EVENT'
          ? 'Review the rejected imports in Systems, correct their source-action parsing, then rebuild and verify the research positions.'
          : 'Open Systems to restore the affected research view and verify the current publication.',
        now: clock,
        significance: { stage: 'consumer-unavailable', errorCode: check.errorCode },
      }), product));
    }
    const risk = matrix.products.find(product => product.id === 'risk-ranges');
    if (risk?.status === 'indexed') {
      const consumerVerified = !unsafeEvidence(ranges) && ranges.available === true
        && ranges.manifest?.persistedManifestVerified === true
        && ranges.manifest?.publicationDate === risk.marketDate
        && Object.keys(ranges.ranges || {}).length > 0;
      if (!consumerVerified) {
        complete = false;
        findings.push(attachProductEvidence(finding({
          key: `product:risk-ranges:${risk.marketDate}`,
          subject: 'Risk Ranges',
          concern: 'Risk Ranges was received, but the current dashboard response could not be verified.',
          impact: 'The range views and Analyst cannot rely on the expected publication.',
          next: 'Open Systems and verify the current Risk Ranges edition in its dashboard view.',
          now: clock,
          significance: { stage: 'consumer-unverified' },
          path: RANGE_PATH,
        }), risk));
      }
    }
    const consumers = await snapshotConsumerIssues({ matrix, fetchJson, now: clock, diagnostics });
    findings.push(...consumers.findings);
    if (!consumers.complete) complete = false;
    for (const product of matrix.products) {
      if (unsafeEvidence(product) || product.status !== 'indexed'
        || ['snapshot', 'published-book'].includes(getResearchProduct(product.id)?.dashboardConsumer?.kind)) continue;
      const issues = publicationIssues(product);
      if (!issues.length) continue;
      const existing = findings.find(item => item.incidentKey === `research-product:${product.id}:${product.marketDate}`);
      if (existing) {
        existing.presentation.rows.splice(1, 0, { label: 'Source discrepancy', text: discrepancyText(issues) });
        existing.fingerprint = digest([existing.fingerprint, issues]);
        continue;
      }
      findings.push(attachProductEvidence(finding({
        key: `product:${product.id}:${product.marketDate}`, subject: product.label,
        concern: discrepancyText(issues),
        impact: 'The import completed with the unaffected research retained. Only disputed fields are withheld from calculations; the original values remain in the source.',
        next: 'Use the remaining research and confirm the disputed fields with Hedgeye before using them.',
        now: clock, firstObservedAt: issues[0].source?.publishedAt || product.observedAt,
        significance: { stage: 'source-discrepancy', issues },
      }), product));
    }
  }
  if (!statusValid) {
    complete = false;
    diagnostics.errors.push({ path: STATUS_PATH, reason: 'Current lightweight status unavailable' });
    if (reportValid) findings.push(verificationFinding({ now: clock, key: 'market-monitor' }));
  } else {
    const market = status.services.find(service => service.id === 'market-data');
    diagnostics.coverage.services = status.services.map(service => ({ id: service.id, status: service.status }));
    if (!market || market.status === 'unknown') {
      complete = false;
      if (reportValid) findings.push(verificationFinding({ now: clock, key: 'market-monitor' }));
    } else if (market.status === 'offline' || (market.status === 'attention'
      && !/delayed/i.test(market.reason || ''))) {
      findings.push(finding({
        key: 'market-data',
        subject: 'Market data',
        concern: 'The market-data service cannot provide its verified current readings.',
        impact: 'Some dashboard prices and market assessments may be unavailable.',
        next: 'Open Systems to verify the provider connection and affected quotes.',
        now: clock,
        significance: { status: market.status, affected: (market.details || []).filter(detail => !['online', 'closed'].includes(detail.status)).map(detail => detail.id).sort() },
        path: STATUS_PATH,
      }));
    }
    // The cheap probe can observe a disconnect before the cached deep check.
    const portfolio = status.services.find(service => service.id === 'live-portfolio');
    if (portfolio && !['online', 'closed'].includes(portfolio.status) && !activeServiceKeys.has('portfolio-connection')) {
      const gateway = (portfolio.details || []).find(detail => detail.id === 'gateway-session');
      const disconnected = gateway?.status === 'offline';
      findings.push(finding({
        key: 'portfolio-connection',
        subject: disconnected ? 'IB Gateway' : 'Portfolio updates',
        concern: disconnected ? 'IB Gateway is disconnected.' : 'Current portfolio data cannot be fully verified.',
        impact: 'Portfolio holdings and balances cannot refresh reliably; current portfolio assessments are unavailable.',
        next: disconnected
          ? 'Open IB Gateway, sign in and verify API access, then check that the portfolio refreshes.'
          : 'Open Systems and verify a fresh portfolio response across all expected accounts.',
        now: clock,
        priority: 0,
        significance: disconnected
          ? { checkId: 'ibkr.gateway', errorCode: 'IBKR_GATEWAY_NOT_AUTHENTICATED', severity: 'fail' }
          : { checkId: 'ibkr.portfolio', errorCode: 'IBKR_LIVE_SESSION_UNVERIFIED', severity: 'fail' },
        path: STATUS_PATH,
      }));
      if (portfolio.status === 'unknown') complete = false;
    }
  }
  diagnostics.coverage.readinessChecks = checks.map(check => check.id);
  diagnostics.coverage.consumerReadbacks = RESEARCH_PRODUCTS.map(product => ({ product: product.id, ...product.dashboardConsumer }));
  diagnostics.coverage.unverifiedDestinations = [
    'Rendered dashboard window state (no rendering telemetry)',
    'Independent publisher discovery before local receipt',
    'Individual same-day revisions without a shared publication checksum',
    'Inflation Nowcast and Global Quads (outside the research delivery registry)',
    'Market Events, Dollar Liquidity and per-instrument rates/FX/volatility consumer completeness',
  ];
  findings.push(...books.findings);
  return { findings: findings.filter(item => !suppressedAnalystInboxFinding(item)), diagnostics, complete,
    completeKinds: complete ? ['operational'] : [] };
}

module.exports = { collectOperationalAttention };
