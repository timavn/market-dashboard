const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { computeResearchEventVerificationHash } = require('../utils/researchEventLedger.cjs');
const { addCalendarDays, isTradingDateKey, previousTradingDateKey } = require('../utils/usEquityMarketCalendar.cjs');
const instrumentCatalog = require('../../infra/lambdas/gmail_ingestor/hedgai_instruments.json');

const PRODUCT = 'hedgai-signals';
const THRESHOLD = 0.6;
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_BASELINE_PATH = path.join(REPO_ROOT, 'data/research/hedgai/2026-09-28-baseline.json');
const TYPES = new Set(['HEDGAI_PUBLICATION', 'HEDGAI_ACTION', 'HEDGAI_REAFFIRMATION', 'HEDGAI_METRICS', 'HEDGAI_BASELINE']);
const ACTIONS = new Set(['open-long', 'open-short', 'close-long', 'close-short']);
const ACTION_HEADINGS = { 'buys added': 'open-long', 'shorts added': 'open-short', 'buys closed': 'close-long', 'shorts closed': 'close-short' };
const SOURCE_REPARSE_TYPE = 'HEDGAI_SOURCE_REPARSE';
const copy = value => JSON.parse(JSON.stringify(value));
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(sorted(value))).digest('hex');
const unique = values => [...new Set(values.filter(Boolean))];
const ms = value => { const number = Date.parse(value || ''); return Number.isFinite(number) ? number : null; };
const marketDate = value => ms(value) === null ? null : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const fake = value => value?.mock === true || value?.seeded === true || value?.fixture === true || /(?:^|[\s_-])(mock|seed|seeded|fixture)(?:$|[\s_-])/i.test(`${value?.sourceType || ''} ${value?.source || ''} ${value?.sourceKind || ''}`);
const verifiedEnvelope = event => !fake(event) && !fake(event.payload) && event.immutable === true
  && event.payload && typeof event.payload === 'object' && event.sourceMessageId && ms(event.eventTime) !== null
  && String(event.parserVersion || '').startsWith('research-event-ledger-v2')
  && /^[a-f0-9]{64}$/i.test(event.eventHash || '') && event.verificationHashVersion === 'research-event-content-v1'
  && event.verificationHash === computeResearchEventVerificationHash(event);

function validateBaseline(baseline) {
  if (!baseline || baseline.product !== PRODUCT || baseline.version !== 1 || !baseline.provenance?.reviewed
    || fake(baseline) || fake(baseline.provenance) || baseline.provenance.method !== 'visual-source-comparison'
    || !Array.isArray(baseline.rows) || !baseline.rows.length || !Array.isArray(baseline.sources)
    || baseline.rows.length !== baseline.provenance.expectedRowCount
    || baseline.sources.length !== baseline.provenance.expectedSourceCount
    || hash(baseline.rows) !== baseline.provenance.rowsHash
    || ms(baseline.publishedAt) === null || marketDate(baseline.publishedAt) !== baseline.baselineDate) {
    throw new Error('HedgAI reviewed baseline is missing or does not match its review.');
  }
  const ids = new Set(baseline.sources.map(source => source.id));
  if (new Set(baseline.rows.map(row => row.instrumentId)).size !== baseline.rows.length
    || baseline.rows.some(row => !row.instrumentId || !row.ticker || !['Buy', 'Short', 'Wait'].includes(row.position)
      || !['top', 'need-more-data'].includes(row.group)
      || ['sourceIds', 'positionSourceIds', 'metricsSourceIds'].some(field => !row[field]?.length || row[field].some(id => !ids.has(id))))
    || baseline.sources.some(source => fake(source) || source.sourceType !== 'reviewed-screenshot'
      || !/^[a-f0-9]{64}$/.test(source.imageSha256 || '') || source.review?.method !== 'visual-source-comparison')) {
    throw new Error('HedgAI baseline has invalid instrument or source provenance.');
  }
  return baseline;
}

function loadReviewedBaseline({ baselinePath = DEFAULT_BASELINE_PATH, verifyArtifacts = true } = {}) {
  const baseline = validateBaseline(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
  if (verifyArtifacts) {
    for (const source of baseline.sources) {
      const artifact = path.resolve(REPO_ROOT, source.artifactPath || '');
      if (!artifact.startsWith(`${path.join(REPO_ROOT, 'data/research/hedgai/sources')}${path.sep}`)) throw new Error('HedgAI source path is outside its archive.');
      const bytes = fs.readFileSync(artifact);
      if (hash(bytes) !== source.imageSha256 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error('HedgAI archived screenshot does not match its reviewed hash.');
      }
    }
  }
  return copy(baseline);
}

function eligible(metric) {
  return typeof metric?.battingAverage === 'number' && Number.isFinite(metric.battingAverage)
    && metric.battingAverage >= THRESHOLD && metric.battingAverage <= 1
    && Number.isInteger(metric.signals) && metric.signals > 0;
}

function publicationTimeVerified(payload = {}) {
  return payload.publicationTimeBasis !== 'email-received-at'
    && !(payload.sourceQuality?.issues || []).some(issue => ['HEDGAI_PUBLICATION_TIME_MISSING', 'HEDGAI_PUBLICATION_TIME_INVALID'].includes(issue.code));
}

function sourceFor(event) {
  const payload = event.payload || {};
  const verifiedTime = publicationTimeVerified(payload);
  return { id: payload.publicationId || event.sourceMessageId, title: payload.headline || 'HedgAI Signals',
    sourceType: 'gmail-email', publicationId: payload.publicationId || null,
    publicationDate: verifiedTime ? payload.publicationDate || marketDate(event.eventTime) : null,
    publishedAt: verifiedTime ? payload.publishedAt || event.eventTime : null,
    publicationTimeVerified: verifiedTime, publicationTimeBasis: payload.publicationTimeBasis || 'verified-ledger-publication-time',
    receivedAt: verifiedTime ? null : event.eventTime,
    sourceMessageId: event.sourceMessageId, sourceUrl: payload.sourceUrl || null,
    artifactPath: event.sourceArtifact || null, contentHash: event.contentHash || null };
}

function publicationSignature(events) {
  // Sequence integrity is checked before this comparison. A second delivery
  // may use a different Gmail ID/artifact and heading order for the same dated
  // publication; neither transport detail changes the publisher's actions.
  const semantic = events.map(event => {
    const payload = { ...event.payload };
    delete payload.sourceMessageId;
    delete payload.sourceArtifact;
    return { type: event.eventType, payload };
  }).sort((a, b) => JSON.stringify(sorted(a)).localeCompare(JSON.stringify(sorted(b))));
  return hash(semantic);
}

function reconcileCatalogAliases(manifest, events) {
  const payload = manifest.payload;
  const normalizeLabel = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const resolved = new Map();
  const recovered = [];
  for (const issue of payload.sourceQuality?.issues || []) {
    if (issue.code !== 'HEDGAI_INSTRUMENT_UNMAPPED' || fake(issue) || typeof issue.sourceText !== 'string' || typeof issue.sourceLabel !== 'string') continue;
    const heading = issue.sourceText.match(/^\s*(Buys Added|Shorts Added|Buys Closed|Shorts Closed):\s*(.*?)\s*$/i);
    if (!heading || !normalizeLabel(heading[2]) || normalizeLabel(heading[2]) !== normalizeLabel(issue.sourceLabel)) continue;
    const matches = instrumentCatalog.instruments.filter(instrument => [instrument.sourceLabel, instrument.ticker, ...(instrument.aliases || [])]
      .some(label => normalizeLabel(label) === normalizeLabel(issue.sourceLabel)));
    if (matches.length !== 1) continue;
    const instrument = matches[0];
    const action = ACTION_HEADINGS[heading[1].toLowerCase()];
    const resolution = { type: 'catalog-alias', instrumentId: instrument.instrumentId, ticker: instrument.ticker,
      sourceLabel: issue.sourceLabel, sourceText: issue.sourceText, action, catalogVersion: instrumentCatalog.schemaVersion };
    resolved.set(issue, resolution);
    // This is a projection of an explicit, hash-verified manifest heading. It
    // never rewrites the immutable ledger envelope or substitutes new evidence.
    recovered.push({ eventType: 'HEDGAI_ACTION', eventTime: manifest.eventTime, sequence: events.length + recovered.length,
      derivedFromVerifiedManifest: true, payload: { publicationId: payload.publicationId, publishedAt: payload.publishedAt || manifest.eventTime,
        publicationDate: payload.publicationDate, sourceUrl: payload.sourceUrl, instrumentId: instrument.instrumentId,
        ticker: instrument.ticker, sourceLabel: issue.sourceLabel, sourceCategory: heading[1], sourceText: issue.sourceText, action } });
  }
  const seen = new Set(events.filter(event => event.eventType === 'HEDGAI_ACTION').map(event => `${event.payload.instrumentId}|${event.payload.action}`));
  const added = recovered.filter(event => {
    const identity = `${event.payload.instrumentId}|${event.payload.action}`;
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
  const sourceIssues = payload.sourceQuality?.issues || [];
  // A missing-category, unknown label or real source discrepancy must keep its
  // original blocker. Only an edition incomplete solely from resolved aliases
  // can become complete after this bounded reconciliation.
  const complete = payload.complete || (sourceIssues.length > 0 && sourceIssues.every(issue => resolved.has(issue)));
  return { events: [...events, ...added], resolved, complete, recoveredActionCount: added.length };
}

function applySourceReparses(events, cutoff, issues) {
  const originals = new Map();
  const reparses = new Map();
  for (const event of events) {
    if (event?.productKey !== PRODUCT) continue;
    const map = event.eventType === SOURCE_REPARSE_TYPE ? reparses : originals;
    const key = event.eventType === SOURCE_REPARSE_TYPE ? event.payload?.originalMessageId : event.sourceMessageId;
    const group = map.get(key) || [];
    if (!group.some(item => item.eventKey && item.eventKey === event.eventKey && item.verificationHash === event.verificationHash)) group.push(event);
    map.set(key, group);
  }
  const replacements = new Map();
  for (const [messageId, repairEvents] of reparses) {
    const applicable = repairEvents.filter(event => ms(event.eventTime) !== null && ms(event.capturedAt) !== null
      && ms(event.eventTime) <= cutoff && ms(event.capturedAt) <= cutoff);
    if (!applicable.length) continue;
    const original = [...(originals.get(messageId) || [])].sort((a, b) => a.sequence - b.sequence);
    const manifest = original.find(event => event.eventType === 'HEDGAI_PUBLICATION');
    const count = original[0]?.sourceEventCount;
    const originalValid = Number.isInteger(count) && count > 0 && original.length === count
      && original.filter(event => event.eventType === 'HEDGAI_PUBLICATION').length === 1
      && manifest.payload.sourceMessageId === messageId && manifest.payload.sourceArtifact === manifest.sourceArtifact
      && original.every((event, index) => event.sequence === index && event.sourceEventCount === count
        && TYPES.has(event.eventType) && verifiedEnvelope(event)
        && event.payload.publicationId === manifest?.payload.publicationId
        && ms(event.eventTime) === ms(manifest?.eventTime)
        && event.sourceArtifact === manifest?.sourceArtifact && event.contentHash === manifest?.contentHash);
    const repair = applicable[0];
    const payload = repair.payload || {};
    const publication = payload.publication || {};
    const actions = payload.actions;
    const reaffirmations = payload.reaffirmations;
    const valid = applicable.length === 1 && originalValid && verifiedEnvelope(repair)
      && repair.sourceKind === 'verified-source-reparse' && repair.sequence === 0 && repair.sourceEventCount === 1
      && repair.parserVersion === 'research-event-ledger-v2:hedgai-source-reparse-v1'
      && payload.method === 'canonical-parser-content-hash' && payload.parserVersion === 'hedgai-email-v2'
      && payload.originalMessageId === messageId && /^[a-f0-9]{64}$/i.test(payload.sourceContentHash || '')
      && payload.sourceContentHash === manifest.contentHash && repair.contentHash === manifest.contentHash
      && payload.sourceArtifact === manifest.sourceArtifact && repair.sourceArtifact === manifest.sourceArtifact
      && Array.isArray(payload.originalEvents) && payload.originalEvents.length === original.length
      && payload.originalEvents.every((event, index) => event?.eventKey === original[index].eventKey
        && event.verificationHash === original[index].verificationHash)
      && !fake(publication) && publication.complete === true && publicationTimeVerified(publication)
      && publication.headline === manifest.payload.headline
      && publication.sourceMessageId === messageId && publication.sourceArtifact === manifest.sourceArtifact
      && publication.publicationId === manifest.payload.publicationId
      && publication.publicationDate === manifest.payload.publicationDate
      && publication.sourceUrl === manifest.payload.sourceUrl && ms(publication.publishedAt) === ms(manifest.eventTime)
      && ms(repair.eventTime) === ms(manifest.eventTime)
      && Array.isArray(actions) && Array.isArray(reaffirmations) && publication.actionCount === actions.length
      && !(publication.sourceQuality?.issues || []).some(issue => issue.blocking !== false)
      && [...actions, ...reaffirmations].every(action => !fake(action)
        && action.publicationId === publication.publicationId && action.publicationDate === publication.publicationDate
        && ms(action.publishedAt) === ms(publication.publishedAt) && action.sourceUrl === publication.sourceUrl
        && instrumentCatalog.instruments.some(instrument => instrument.instrumentId === action.instrumentId && instrument.ticker === action.ticker)
        && typeof action.sourceText === 'string' && action.sourceText.trim()
        && (actions.includes(action) ? ACTIONS.has(action.action) : ['maintain-long', 'maintain-short'].includes(action.action)));
    if (!valid) {
      issues.push({ code: 'source-reparse-invalid', message: 'A source parsing repair did not match the complete archived publication.',
        sourceIds: unique([manifest?.payload.publicationId, messageId]), blocking: true });
      continue;
    }
    const resolution = { type: 'verified-source-reparse', parserVersion: payload.parserVersion,
      sourceContentHash: payload.sourceContentHash, repairEventKey: repair.eventKey };
    const priorIssues = (manifest.payload.sourceQuality?.issues || []).map(issue => ({ ...copy(issue), blocking: false,
      resolved: true, resolution }));
    const repairedPublication = { ...copy(publication), sourceQuality: { status: priorIssues.length ? 'discrepancy' : 'clear', issues: priorIssues } };
    const parsed = [['HEDGAI_PUBLICATION', repairedPublication], ...actions.map(action => ['HEDGAI_ACTION', action]),
      ...reaffirmations.map(action => ['HEDGAI_REAFFIRMATION', action]),
      ...original.filter(event => event.eventType === 'HEDGAI_METRICS').map(event => ['HEDGAI_METRICS', event.payload])];
    replacements.set(messageId, parsed.map(([eventType, value], sequence) => {
      const event = { ...manifest, eventType, payload: copy(value), sequence, sourceEventCount: parsed.length,
        eventKey: `${manifest.eventTime}#${messageId}#${sequence}#source-reparse-${repair.verificationHash}`,
        derivedFromVerifiedSourceReparse: resolution, eventHash: hash({ eventType, payload: value }) };
      return { ...event, verificationHash: computeResearchEventVerificationHash(event) };
    }));
  }
  return events.filter(event => event?.eventType !== SOURCE_REPARSE_TYPE && !replacements.has(event?.sourceMessageId))
    .concat([...replacements.values()].flat());
}

function verifiedPublications(events, cutoff, baselineTime, issues) {
  events = applySourceReparses(events, cutoff, issues);
  const groups = new Map();
  for (const event of events) {
    if (event?.productKey !== PRODUCT || event.eventType === 'HEDGAI_BASELINE') continue;
    const time = ms(event.eventTime);
    if (time !== null && (time > cutoff || time < baselineTime)) continue;
    const key = event.sourceMessageId || `unidentified-${groups.size}`;
    const group = groups.get(key) || [];
    // Duplicate reads of the same immutable event do not create a sequence gap.
    if (!group.some(existing => existing.eventKey === event.eventKey && existing.verificationHash === event.verificationHash && existing.eventKey)) group.push(event);
    groups.set(key, group);
  }
  const publications = [];
  for (const [messageId, group] of groups) {
    group.sort((a, b) => a.sequence - b.sequence);
    const count = group[0]?.sourceEventCount;
    const valid = Number.isInteger(count) && count === group.length && count > 0
      && group.every((event, index) => event.sequence === index && event.sourceEventCount === count
        && event.sourceMessageId && TYPES.has(event.eventType) && ms(event.eventTime) !== null
        && verifiedEnvelope(event));
    const manifests = group.filter(event => event.eventType === 'HEDGAI_PUBLICATION');
    const manifest = manifests[0];
    if (!valid || manifests.length !== 1 || typeof manifest.payload.complete !== 'boolean') {
      issues.push({ code: 'publication-incomplete-or-invalid', message: 'A HedgAI publication could not be verified in full.', sourceIds: [messageId], blocking: true });
      continue;
    }
    const payload = manifest.payload;
    const publicationId = payload.publicationId;
    if (!publicationId || group.some(event => event.payload.publicationId !== publicationId
      || ms(event.payload.publishedAt || event.eventTime) !== ms(manifest.eventTime))
      || (Number.isInteger(payload.actionCount) && payload.actionCount !== group.filter(event => event.eventType === 'HEDGAI_ACTION').length)) {
      issues.push({ code: 'publication-identity-mismatch', message: 'HedgAI publication identity or action coverage is inconsistent.', sourceIds: [messageId], blocking: true });
      continue;
    }
    const reconciled = reconcileCatalogAliases(manifest, group);
    if (!reconciled.complete) issues.push({ code: 'publication-content-incomplete', message: 'The complete source is preserved, but some published actions require interpretation.', sourceIds: [payload.publicationId || messageId], blocking: true });
    for (const issue of payload.sourceQuality?.issues || []) {
      const resolution = reconciled.resolved.get(issue);
      issues.push({ ...copy(issue), sourceIds: unique([publicationId, ...(issue.sourceIds || [])]),
        blocking: resolution ? false : issue.blocking !== false, ...(resolution ? { resolved: true, resolution } : {}) });
    }
    if (!publicationTimeVerified(payload) && !(payload.sourceQuality?.issues || []).some(issue => ['HEDGAI_PUBLICATION_TIME_MISSING', 'HEDGAI_PUBLICATION_TIME_INVALID'].includes(issue.code))) {
      issues.push({ code: 'publication-time-unverified', message: 'Receipt time cannot establish when these actions were published.', sourceIds: [publicationId], blocking: true });
    }
    publications.push({ id: publicationId, manifest, events: reconciled.events,
      ...(reconciled.resolved.size ? { reconciliation: { type: 'catalog-alias', parserComplete: payload.complete,
        complete: reconciled.complete, recoveredActionCount: reconciled.recoveredActionCount,
        resolutions: [...reconciled.resolved.values()] } } : {}) });
  }
  const uniquePublications = new Map();
  publications.sort((a, b) => ms(a.manifest.eventTime) - ms(b.manifest.eventTime) || a.id.localeCompare(b.id));
  for (const publication of publications) {
    const previous = uniquePublications.get(publication.id);
    const signature = publicationSignature(publication.events);
    if (previous && previous.signature !== signature) {
      issues.push({ code: 'publication-conflict', message: 'Duplicate copies disagree on a HedgAI publication.', sourceIds: [publication.id], blocking: true });
    }
    if (previous) previous.deliveryManifests.push(publication.manifest);
    else uniquePublications.set(publication.id, { ...publication, signature, deliveryManifests: [publication.manifest] });
  }
  return [...uniquePublications.values()];
}

function publicationWindow(asOf) {
  const date = marketDate(asOf);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(asOf)).map(part => [part.type, part.value]));
  // Check after the cash open, not at midnight. This is an operational review
  // window; no guaranteed publisher delivery time is asserted.
  const notDue = !isTradingDateKey(date) || Number(parts.hour) * 60 + Number(parts.minute) < 570;
  return { expectedDate: notDue ? previousTradingDateKey(date) : date, notDue };
}

function unverifiedSessions(from, through, publicationDates) {
  const missing = [];
  let date = addCalendarDays(from, 1);
  while (date && date <= through && missing.length < 370) {
    if (isTradingDateKey(date) && !publicationDates.has(date)) missing.push(date);
    date = addCalendarDays(date, 1);
  }
  return missing;
}

function reviewedMetrics(payload, eventTime) {
  const review = payload.provenance || {};
  const sources = payload.sources;
  const metrics = payload.metrics;
  return ['combined', 'buy', 'short'].every(side => {
    const value = metrics?.[side];
    return typeof value?.battingAverage === 'number' && value.battingAverage >= 0 && value.battingAverage <= 1
      && typeof value.winLoss === 'number' && Number.isFinite(value.winLoss) && value.winLoss >= 0
      && Number.isInteger(value.signals) && value.signals >= 0;
  }) && !fake(payload) && !fake(review) && review.reviewed === true && review.method === 'visual-source-comparison'
    && ['reviewed-screenshot', 'reviewed-pdf'].includes(review.sourceType) && hash(metrics) === review.metricsHash
    && ms(review.reviewedAt) !== null && marketDate(review.reviewedAt) >= payload.metricsDate
    && /^\d{4}-\d{2}-\d{2}$/.test(payload.metricsDate || '') && payload.metricsDate <= marketDate(eventTime)
    && Array.isArray(sources) && sources.length > 0 && sources.every(source => !fake(source) && source.id
      && ['reviewed-screenshot', 'reviewed-pdf'].includes(source.sourceType)
      && /^[a-f0-9]{64}$/i.test(source.imageSha256 || source.sourceSha256 || '')
      && source.artifactPath && source.publicationDate === payload.metricsDate);
}

/** Immutable, quote-independent publisher context. Batting average never becomes odds. */
function buildHedgaiResearch({ baseline, events = [], asOf, availability = 'available', continuity } = {}) {
  const cutoff = ms(asOf);
  if (cutoff === null) throw new Error('HedgAI projection requires an explicit valid asOf.');
  validateBaseline(baseline);
  const checkpointIssues = [];
  const archivedCheckpointSources = copy(baseline.sources);
  // A later fully reviewed checkpoint is an explicit reconciliation boundary.
  // Partial books and ordinary email actions never reset continuity.
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.productKey !== PRODUCT || event.eventType !== 'HEDGAI_BASELINE'
      || ms(event.eventTime) > cutoff) continue;
    try {
      if (!verifiedEnvelope(event) || event.sequence !== 0 || event.sourceEventCount !== 1
        || event.sourceKind !== 'reviewed-screenshot-baseline') throw new Error('Unverified checkpoint');
      const candidate = validateBaseline(event.payload);
      if (ms(candidate.publishedAt) !== ms(event.eventTime)) throw new Error('Checkpoint time mismatch');
      archivedCheckpointSources.push(...copy(candidate.sources));
      if (ms(candidate.publishedAt) > ms(baseline.publishedAt)) baseline = candidate;
    } catch {
      checkpointIssues.push({ code: 'baseline-checkpoint-invalid', message: 'A later baseline could not be verified; the prior book remains dated context.', sourceIds: [event.sourceMessageId], blocking: true });
    }
  }
  const asOfDate = marketDate(asOf);
  const common = { version: 1, product: PRODUCT, asOf: new Date(cutoff).toISOString(), baselineDate: baseline.baselineDate,
    metricsDate: baseline.metricsDate, threshold: THRESHOLD, methodology: copy(baseline.methodology || {}) };
  if (cutoff < ms(baseline.publishedAt)) return { ...common, book: { rows: [] }, changes: [], reaffirmations: [], unresolvedActions: [], sources: [], marketMatches: [], sourceQuality: { continuity: 'unknown', issues: [{ code: 'baseline-after-capture', message: 'The reviewed baseline was published after this capture.', sourceIds: [], blocking: true }] } };
  const issues = [...copy(baseline.sourceQuality?.issues || []), ...checkpointIssues];
  const rows = copy(baseline.rows).map(row => ({ ...row, metricsDate: baseline.metricsDate,
    publicationDate: baseline.baselineDate, lastConfirmedAt: baseline.publishedAt }));
  const byId = new Map(rows.map(row => [row.instrumentId, row]));
  const sources = archivedCheckpointSources;
  const changes = [];
  const reaffirmations = [];
  const unresolvedActions = [];
  const dates = new Set([baseline.baselineDate]);
  const included = new Set(baseline.includedPublicationIds || []);
  const publications = verifiedPublications(Array.isArray(events) ? events : [], cutoff, ms(baseline.publishedAt), issues);
  const simultaneous = new Map();
  for (const publication of publications) for (const event of publication.events) {
    if (event.eventType !== 'HEDGAI_ACTION' || !publicationTimeVerified(publication.manifest.payload)) continue;
    const key = `${ms(event.eventTime)}|${event.payload.instrumentId}`;
    const entry = simultaneous.get(key) || { instrumentId: event.payload.instrumentId, publications: new Set(), actions: new Set() };
    entry.publications.add(publication.id); entry.actions.add(event.payload.action); simultaneous.set(key, entry);
  }
  const ambiguousAtTime = new Set();
  for (const [key, entry] of simultaneous) if (entry.publications.size > 1 && entry.actions.size > 1) {
    ambiguousAtTime.add(key);
    issues.push({ code: 'same-time-publication-conflict', message: 'Different publications give conflicting actions at the same time; ordering is unverified.', instrumentId: entry.instrumentId, sourceIds: [...entry.publications], blocking: true });
  }
  let latest = baseline.publishedAt;
  let latestPublicationSource = null;
  let metricsDate = baseline.metricsDate;
  for (const publication of publications) {
    const source = { ...sourceFor(publication.manifest),
      ...(publication.reconciliation ? { reconciliation: copy(publication.reconciliation) } : {}),
      deliveries: publication.deliveryManifests.map(manifest => {
        const evidence = sourceFor(manifest);
        return { sourceMessageId: evidence.sourceMessageId, artifactPath: evidence.artifactPath,
          contentHash: evidence.contentHash, publishedAt: evidence.publishedAt, receivedAt: evidence.receivedAt,
          publicationTimeVerified: evidence.publicationTimeVerified };
      }) };
    sources.push(source);
    if (!source.publicationTimeVerified) {
      for (const event of publication.events) {
        if (event.eventType === 'HEDGAI_PUBLICATION') continue;
        unresolvedActions.push({ ...copy(event.payload), eventType: event.eventType,
          publicationDate: null, publishedAt: null, receivedAt: event.eventTime,
          applied: false, unresolvedDate: true, sourceIds: [source.id] });
      }
      continue;
    }
    dates.add(source.publicationDate);
    latest = source.publishedAt;
    latestPublicationSource = source;
    const includedInBaseline = included.has(publication.id);
    const blocked = new Set();
    const actionSets = new Map();
    for (const event of publication.events) if (event.eventType === 'HEDGAI_ACTION') {
      const set = actionSets.get(event.payload.instrumentId) || new Set();
      set.add(event.payload.action); actionSets.set(event.payload.instrumentId, set);
    }
    for (const [instrumentId, actions] of actionSets) {
      if (actions.has('open-long') && actions.has('open-short')) {
        blocked.add(instrumentId);
        issues.push({ code: 'simultaneous-opposite-opens', message: 'One publication opens both directions without a verified order.', instrumentId, sourceIds: [source.id], blocking: true });
      }
      const position = byId.get(instrumentId)?.position;
      if (!includedInBaseline && ((position === 'Buy' && actions.has('close-short')) || (position === 'Short' && actions.has('close-long')))) {
        blocked.add(instrumentId);
        issues.push({ code: 'close-side-conflict', message: 'A close action names a different side from the publication starting book.', instrumentId, sourceIds: [source.id], blocking: true });
      }
      if (ambiguousAtTime.has(`${ms(source.publishedAt)}|${instrumentId}`)) blocked.add(instrumentId);
    }
    // Email heading order lists additions before closures. Resolve the actual
    // position transition from the publication starting book: close, then open.
    const priority = event => event.eventType === 'HEDGAI_ACTION' ? (event.payload.action.startsWith('close-') ? 0 : 1) : 2;
    const orderedEvents = [...publication.events].sort((a, b) => priority(a) - priority(b) || a.sequence - b.sequence);
    for (const event of orderedEvents) {
      if (event.eventType === 'HEDGAI_PUBLICATION') continue;
      const payload = event.payload;
      const row = byId.get(payload.instrumentId);
      if (!row) {
        issues.push({ code: 'instrument-unmapped', message: 'A published HedgAI instrument is absent from the reviewed baseline.', instrumentId: payload.instrumentId || null, sourceIds: [source.id], blocking: true });
        continue;
      }
      const samePublication = included.has(publication.id);
      if (event.eventType === 'HEDGAI_METRICS') {
        if (!reviewedMetrics(payload, event.eventTime) || ms(payload.provenance.reviewedAt) > cutoff) {
          issues.push({ code: 'metrics-review-required', message: 'New performance metrics require a complete reviewed capture.', instrumentId: row.instrumentId, sourceIds: [source.id], blocking: false });
        } else {
          sources.push(...copy(payload.sources));
          if (payload.metricsDate > row.metricsDate) {
            row.metrics = copy(payload.metrics);
            row.metricsDate = payload.metricsDate;
            row.metricsSourceIds = payload.sources.map(item => item.id);
            row.sourceIds = unique([...row.sourceIds, ...row.metricsSourceIds]);
            metricsDate = payload.metricsDate > metricsDate ? payload.metricsDate : metricsDate;
          } else if (payload.metricsDate === row.metricsDate && hash(payload.metrics) !== hash(row.metrics)) {
            issues.push({ code: 'metrics-same-date-conflict', message: 'Conflicting performance tables require explicit reconciliation.', instrumentId: row.instrumentId, sourceIds: [source.id], blocking: false });
          }
        }
        continue;
      }
      const isLong = String(payload.action).endsWith('-long');
      const direction = isLong ? 'Bullish' : 'Bearish';
      const evidence = { instrumentId: row.instrumentId, ticker: row.ticker, sourceLabel: row.sourceLabel,
        action: payload.action, direction, eligible: eligible(row.metrics?.[isLong ? 'buy' : 'short']),
        publicationDate: source.publicationDate, publishedAt: source.publishedAt, sourceIds: [source.id],
        sourceText: payload.sourceText || '', alreadyIncludedInBaseline: samePublication };
      if (event.eventType === 'HEDGAI_REAFFIRMATION' && ['maintain-long', 'maintain-short'].includes(payload.action)) {
        reaffirmations.push(evidence);
        if (row.position !== (isLong ? 'Buy' : 'Short')) {
          issues.push({ code: 'reaffirmation-book-conflict', message: 'A reaffirmation disagrees with the last verified source book.', instrumentId: row.instrumentId, sourceIds: [source.id], blocking: true });
        } else {
          row.lastConfirmedAt = source.publishedAt;
          row.positionSourceIds = unique([...row.positionSourceIds, source.id]);
          row.sourceIds = unique([...row.sourceIds, source.id]);
        }
        continue;
      }
      if (event.eventType !== 'HEDGAI_ACTION' || !ACTIONS.has(payload.action)) {
        issues.push({ code: 'action-unrecognized', message: 'A HedgAI action could not be applied without changing its meaning.', instrumentId: row.instrumentId, sourceIds: [source.id], blocking: true });
        continue;
      }
      changes.push(evidence);
      if (blocked.has(row.instrumentId)) continue;
      if (!samePublication) {
        if (payload.action.startsWith('open-')) {
          if (row.position !== (isLong ? 'Buy' : 'Short')) row.initiatedAt = source.publicationDate;
          row.position = isLong ? 'Buy' : 'Short';
        } else if (row.position === (isLong ? 'Buy' : 'Short')) {
          row.position = 'Wait'; row.initiatedAt = null;
        } else if (row.position !== 'Wait') {
          issues.push({ code: 'close-side-conflict', message: 'A close action names a different side from the verified book.', instrumentId: row.instrumentId, sourceIds: [source.id], blocking: true });
        }
      }
      row.publicationDate = source.publicationDate;
      row.lastConfirmedAt = source.publishedAt;
      row.positionSourceIds = unique([...row.positionSourceIds, source.id]);
      row.sourceIds = unique([...row.sourceIds, source.id]);
    }
  }
  const publishedCounts = String(latestPublicationSource?.title || '').match(/\b(\d+)\s+Longs\s+and\s+(\d+)\s+Shorts\b/i);
  if (publishedCounts) {
    const publishedLongCount = Number(publishedCounts[1]);
    const publishedShortCount = Number(publishedCounts[2]);
    const projectedLongCount = rows.filter(row => row.position === 'Buy').length;
    const projectedShortCount = rows.filter(row => row.position === 'Short').length;
    if (publishedLongCount !== projectedLongCount || publishedShortCount !== projectedShortCount) {
      issues.push({ code: 'HEDGAI_PUBLISHED_BOOK_COUNT_DISCREPANCY',
        id: hash(`${latestPublicationSource.id}|published-book-counts|${publishedLongCount}|${publishedShortCount}|${projectedLongCount}|${projectedShortCount}`),
        message: `The publication headline reports ${publishedLongCount} Longs and ${publishedShortCount} Shorts; the full ${rows.length}-instrument book reconstructed from published readings contains ${projectedLongCount} Buy and ${projectedShortCount} Short positions. The headline scope or an unreported book revision needs verification.`,
        sourceText: latestPublicationSource.title, sourceHeadline: latestPublicationSource.title,
        publicationId: latestPublicationSource.publicationId, publicationDate: latestPublicationSource.publicationDate,
        publishedAt: latestPublicationSource.publishedAt, sourceUrl: latestPublicationSource.sourceUrl,
        publishedLongCount, publishedShortCount, projectedLongCount, projectedShortCount,
        source: { productId: PRODUCT, reportDate: latestPublicationSource.publicationDate,
          publishedAt: latestPublicationSource.publishedAt, url: latestPublicationSource.sourceUrl },
        observed: { published: { long: publishedLongCount, short: publishedShortCount },
          reconstructed: { long: projectedLongCount, short: projectedShortCount } },
        disposition: 'aggregate_unreconciled', field: 'positionCounts', affectedFields: ['positionCounts'],
        sourceIds: [latestPublicationSource.id], blocking: false });
    }
  }
  const window = publicationWindow(asOf);
  const missing = unverifiedSessions(baseline.baselineDate, window.expectedDate, dates);
  if (missing.length && continuity !== 'complete') issues.push({ code: 'publication-continuity-unverified', message: 'Publication coverage after the baseline has not been verified.', dates: missing, sourceIds: [], blocking: true });
  if (availability !== 'available') issues.push({ code: 'research-read-unavailable', message: 'Current research delivery could not be checked; the book is last-known context.', sourceIds: [], blocking: true });
  if (continuity === 'gap' || continuity === 'unknown') issues.push({ code: 'research-continuity-unverified', message: 'Research delivery continuity is not confirmed.', sourceIds: [], blocking: true });
  const hasGap = issues.some(issue => issue.blocking);
  const globalGap = issues.some(issue => issue.blocking && (!issue.instrumentId || !byId.has(issue.instrumentId)));
  const currentEditionAvailable = marketDate(latest) === asOfDate;
  const quality = hasGap ? (continuity === 'gap' || issues.some(issue => ['publication-incomplete-or-invalid', 'publication-conflict'].includes(issue.code)) ? 'gap' : 'unknown') : 'complete';
  for (const row of rows) {
    row.bullEligible = eligible(row.metrics?.buy);
    row.bearEligible = eligible(row.metrics?.short);
    row.lastKnownDirection = row.position === 'Buy' ? 'Bullish' : row.position === 'Short' ? 'Bearish' : null;
    const rowGap = globalGap || issues.some(issue => issue.blocking && issue.instrumentId === row.instrumentId);
    row.activeDirection = !rowGap && ((row.position === 'Buy' && row.bullEligible) || (row.position === 'Short' && row.bearEligible)) ? row.lastKnownDirection : null;
    row.status = rowGap ? 'last-known' : 'current';
  }
  return { ...common, metricsDate, book: { rows }, changes, reaffirmations, unresolvedActions, sources: [...new Map(sources.map(source => [source.id, source])).values()],
    marketMatches: rows.flatMap(row => row.marketMatches || []),
    sourceQuality: { continuity: quality, issues, lastPublicationAt: latest, coverageThrough: marketDate(latest), metricsDate,
      currentEditionAvailable, publicationStatus: currentEditionAvailable ? 'received' : window.notDue ? 'not-due' : 'unverified',
      publicationCheckWindow: '09:30 America/New_York; operational review window, not publisher SLA',
      publisherSummary: copy(baseline.sourceQuality?.publisherSummary || []) } };
}

module.exports = { PRODUCT, THRESHOLD, DEFAULT_BASELINE_PATH, loadReviewedBaseline, validateBaseline, buildHedgaiResearch };
