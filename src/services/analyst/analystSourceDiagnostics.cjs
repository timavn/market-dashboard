const { createHash } = require('node:crypto');
const { getResearchProduct, newYorkParts } = require('../../utils/researchProductRegistry.cjs');
const { publicationIssues, discrepancyText, discrepancySourceLinks } = require('../../utils/researchSourceQuality.cjs');

const THROTTLE_MS = 5 * 60_000;
const READINESS_MAX_AGE_MS = 6 * 60_000;
const RESEARCH_ARCHIVE_FAILURES = {
  RESEARCH_ARCHIVE_TIMEOUT: 'The review’s research archive request timed out before it could capture this publication.',
  RESEARCH_ARCHIVE_UNAVAILABLE: 'The review’s research archive request failed before it could capture this publication.',
  RESEARCH_ARCHIVE_INVALID_RESPONSE: 'The review’s research archive request returned an invalid response, so it could not capture this publication.',
  RESEARCH_ARCHIVE_DATE_MISMATCH: 'The review’s research archive response had the wrong requested date, so it was excluded from the capture.',
};
const BAD_FLAGS = ['stale', 'isStale', 'mock', 'isMock', 'seed', 'seeded', 'fixture', 'synthetic', 'inferred', 'fallback', 'cacheOnly', 'cachedOnly', 'cached', 'fromCache', 'from_cache', 'refreshFailed', 'offline', 'disconnected'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = (value, length = 1200) => String(value || '').replace(/\p{Cc}/gu, ' ').trim().slice(0, length);
const code = value => /^[A-Z][A-Z0-9_]{0,99}$/.test(String(value || '')) ? value : null;
const validTime = value => Number.isFinite(Date.parse(value));
const isBalance = source => source.requiresIbGateway === true && ['balance', 'portfolioBalance'].includes(source.id);
const partialArchive = source => source.id === 'portfolioRefreshResearch' && source.status === 'partial'
  && code(source.diagnostic?.code) === 'PORTFOLIO_REFRESH_ARCHIVE_PARTIAL';
const fresh = (value, now, age) => validTime(value) && now.getTime() - Date.parse(value) >= -5000 && now.getTime() - Date.parse(value) <= age;
function unsafe(value) {
  if (!value || typeof value !== 'object') return true;
  return BAD_FLAGS.some(flag => value[flag] === true) || value.connected === false
    || ['source', 'status', 'cacheState', 'providerStatus'].some(key => /(?:^|[:_-])(?:mock|seeded?|fixture|synthetic|cache[-_]?only|cached|stale)(?:$|[:_-])/i.test(String(value[key] || '')))
    || ['provenance', 'metadata', 'freshness'].some(key => value[key] && typeof value[key] === 'object' && unsafe(value[key]));
}
const rowsFor = (problem, cause, solution, status) => [
  { label: 'Problem', text: problem }, { label: 'Cause', text: cause },
  { label: 'Solution', text: solution }, { label: 'Status', text: status },
];
const verificationTime = value => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type).value;
  return `${part('month')} ${part('day')} ${part('hour')}:${part('minute')} PT`;
};
const recoveryMaterial = rows => rows.filter(row => row.label !== 'Status');
function capturedCause(source) {
  const diagnostic = code(source.diagnostic?.code);
  if (/GATEWAY|NOT_AUTHENTICATED|NOT_CONNECTED|DISCONNECTED/.test(diagnostic || '')) return 'The IBKR connection could not be verified when this review was captured.';
  if (/TIMEOUT|TIMED_OUT/.test(diagnostic || '')) return 'The source request timed out when this review was captured.';
  if (/BALANCE.*(?:INVALID|STALE|UNAVAILABLE)|ACCOUNT.*(?:UNAVAILABLE|INCOMPLETE)/.test(diagnostic || '')) return 'The captured brokerage response did not contain verified current balance evidence.';
  return null;
}
function researchFailure(product, source) {
  const received = product.stages?.received === true || Number(product.counts?.artifacts) > 0 || Number(product.counts?.failures) > 0;
  const match = clean(product.detail).match(/Invalid risk range for [^:]{0,100}\(([A-Z0-9.^-]{1,15})\):\s*lrr=([\d.]+),\s*hrr=([\d.]+)/i);
  if (match && Number(match[2]) > Number(match[3])) return `The received publication contains a reversed ${match[1]} range (${Number(match[2]).toLocaleString('en-US')}–${Number(match[3]).toLocaleString('en-US')}); validation stopped the import.`;
  if (received) return `${source.label} arrived, but processing or validation failed before it could be used.`;
  return 'The publication pipeline reported a processing failure; the failing step needs investigation.';
}
function liveBalance(balance, now) {
  return !unsafe(balance) && balance.available === true && balance.status === 'live'
    && balance.source === 'ibkr_live_session' && balance.fromCache === false && balance.freshness?.status === 'fresh'
    && ['observedAt', 'socketVerifiedAt', 'accountValuesObservedAt'].every(key => fresh(balance[key], now, 45_000));
}

function createSourceDiagnostics({ call, fetchJson, now = () => new Date() }) {
  const running = new Map();
  const get = fetchJson || (async path => {
    if (!path.startsWith('/api/')) throw new Error('Unexpected diagnostic source');
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}${path}`, { signal: AbortSignal.timeout(12_000) });
    const evidence = await response.json();
    // An unavailable source can still provide a dated, structured failure. Keep
    // that diagnostic evidence without treating an HTTP failure as recovery.
    if (!response.ok && !(code(evidence?.errorCode) && validTime(evidence?.observedAt || evidence?.checkedAt))) {
      throw new Error('Diagnostic evidence unavailable');
    }
    return evidence;
  });
  const read = path => Promise.resolve().then(() => get(path)).catch(() => null);

  async function diagnose(source, sources, report, balance, systemStatus, clock, old) {
    if (partialArchive(source)) {
      const count = Number.isSafeInteger(source.archiveCoverage?.count) && source.archiveCoverage.count > 0 ? source.archiveCoverage.count : null;
      return {
        rows: rowsFor('Portfolio research archive has captured coverage gaps.',
          `The complete archive scan received research, but ${count ? `${count} archived products contain` : 'some publications contain'} provenance or fields that could not be qualified. Valid evidence was retained.`,
          'Restore the original publication provenance and verify rejected fields before requalifying omitted facts; preserve the available research.',
          'The captured gaps remain unresolved; this saved review retains its original capture.'),
        stage: 'archive-partial', sourceLabel: 'Sources',
        detail: `${code(source.diagnostic.code)}. ${clean(source.detail, 300)}${source.archiveCoverage?.reasons?.length ? ` Captured reasons: ${clean(source.archiveCoverage.reasons.join(', '), 600)}.` : ''}`,
        path: `/api/analyst/conversations/${encodeURIComponent(sources.conversationId)}/sources`,
        unverified: false, issues: [],
      };
    }
    const day = newYorkParts(sources.capturedAt || sources.checkedAt).date;
    let problem = `${source.label} was excluded from this saved review.`;
    let cause = capturedCause(source) || 'Investigation inconclusive: the available checks do not establish why this source was excluded.';
    let solution = 'Open Systems to check the affected source, then refresh this review after verification.';
    let status = 'The saved review remains incomplete; current recovery is unverified.';
    let stage = 'inconclusive';
    let unverified = false;
    let detail = code(source.diagnostic?.code) || 'No captured diagnostic code.';
    let path = '/api/system-readiness';
    let issues = publicationIssues(source, old);
    const archiveFailure = getResearchProduct(source.id) && RESEARCH_ARCHIVE_FAILURES[code(source.diagnostic?.code)];
    if (archiveFailure) {
      stage = 'acquisition-failed'; cause = archiveFailure;
      solution = 'Verify the review’s research archive response in Systems, then refresh this review.';
      path = `/api/hedgeye/tldr/archive/${day}`;
    }
    const matrix = !unsafe(report) && fresh(report.checkedAt, clock, READINESS_MAX_AGE_MS) ? report.researchProductMatrix : null;
    const product = !unsafe(matrix) && fresh(matrix.generatedAt, clock, READINESS_MAX_AGE_MS) && !(matrix.collectionErrors || []).length
      ? matrix.products?.find(row => row.id === source.id && row.marketDate === day && !unsafe(row)) : null;
    const brokerService = !unsafe(systemStatus) && fresh(systemStatus.checkedAt, clock, 120_000)
      ? systemStatus.services?.find(row => row.id === 'live-portfolio') : null;
    const gateway = brokerService?.details?.find(row => row.id === 'gateway-session');
    if (source.id === 'hedgai-signals') {
      path = `/api/research/hedgai?asOf=${encodeURIComponent(clock.toISOString())}`;
      const research = await read(path);
      const verified = !unsafe(research) && research.version === 1 && research.product === 'hedgai-signals'
        && research.book?.rows?.length > 0;
      issues = publicationIssues(research, source, old);
      if (issues.length) {
        stage = 'source-discrepancy';
        problem = 'HedgAI contains a source-data discrepancy.';
        cause = discrepancyText(issues);
        solution = 'Preserve the baseline and original email actions; verify the disputed transition or metric against its source before using that field.';
        status = verified ? 'The dated book and unaffected research remain available; the discrepancy is unresolved.'
          : 'The recorded discrepancy remains unresolved; current HedgAI delivery could not be verified.';
        detail = cause;
      } else if (verified && research.sourceQuality?.continuity === 'complete') {
        stage = 'recovered'; cause = 'The saved review could not capture a verified HedgAI baseline and update history.';
        solution = 'Refresh this review to capture the verified HedgAI research.';
        status = `Verified ${verificationTime(clock)}; this saved review retains its original capture.`;
        detail = `HedgAI baseline ${research.baselineDate} and update continuity were verified.`;
      } else if (verified) {
        stage = 'continuity-unverified';
        cause = 'The dated HedgAI book is available, but delivery of subsequent updates could not be established.';
        solution = 'Verify the missing email publications or import a newer complete publisher baseline, then refresh the review.';
        status = 'Last-known research is retained; current signal continuity is unverified.';
        detail = cause;
      } else { unverified = true; }
    } else if (getResearchProduct(source.id) && product) {
      issues = publicationIssues(product, source, old);
      detail = `${archiveFailure ? `${code(source.diagnostic?.code)}. ` : ''}${clean(product.detail) || clean(product.errorCode)}`;
      if (!archiveFailure && product.status === 'failed' && product.errorCode !== 'RESEARCH_PIPELINE_EVIDENCE_UNAVAILABLE') {
        stage = 'processing-failed'; cause = researchFailure(product, source);
        solution = issues.length
          ? 'Import the full publication, retain its original values, and withhold only disputed fields from calculations. Confirm those fields with Hedgeye, then refresh this review with the available research.'
          : 'Repair the failed research import, verify the publication in Systems, then refresh this review.';
        status = 'Processing still needs repair; the saved review remains incomplete.';
      } else if (product.status === 'indexed' && product.stages?.indexed === true) {
        const snapshotPath = `/api/hedgeye/snapshot/${encodeURIComponent(source.id)}?date=${day}`;
        const snapshot = await read(snapshotPath);
        const consumerReady = !unsafe(snapshot) && !snapshot.error && snapshot.available !== false
          && snapshot.contentComplete !== false && snapshot.decisionEligible !== false
          && snapshot.date === day && snapshot.snapshotType === source.id
          && snapshot.data && typeof snapshot.data === 'object' && Object.keys(snapshot.data).length > 0;
        if (consumerReady) {
          issues = publicationIssues(snapshot, product, source, old);
          if (issues.length) {
            stage = 'source-discrepancy';
            problem = `${source.label} contains a source-data discrepancy.`;
            cause = discrepancyText(issues);
            solution = 'Use the unaffected research; confirm the disputed fields with Hedgeye before using them.';
            status = `Verified ${verificationTime(now())}: the publication and unaffected research are available; only disputed fields are withheld from calculations. The source discrepancy remains open.`;
          } else {
            stage = 'recovered'; status = `Verified ${verificationTime(now())}; this saved review still excludes the source.`;
            solution = 'Refresh this review to capture the recovered publication.';
          }
          detail += ` Exact-date consumer readback verified at ${snapshotPath}.`;
        } else {
          unverified = !archiveFailure && (!snapshot || unsafe(snapshot) || Boolean(snapshot.error));
          if (!archiveFailure) {
            stage = 'consumer-unverified'; cause = 'The publication is indexed, but its exact-date dashboard response could not be verified.';
            solution = 'Restore the publication response in Systems, verify the captured date, then refresh this review.';
          }
        }
      } else if (!archiveFailure && product.status === 'missing' && product.errorCode === 'RESEARCH_PRODUCT_DUE_MISSING'
        && !product.stages?.received && !Number(product.counts?.artifacts) && !Number(product.counts?.failures)) {
        stage = 'not-received'; cause = `Systems found no received publication for ${day}.`;
        solution = 'Check publication delivery and ingestion in Systems, then refresh this review when the source is verified.';
      }
    } else if (isBalance(source)) {
      path = '/api/portfolio/balance';
      if (liveBalance(balance, clock)) {
        stage = 'recovered'; status = `Verified ${verificationTime(balance.observedAt)}; this saved review still excludes live balances.`;
        cause = capturedCause(source) || (source.status === 'unavailable'
          ? 'The review’s balance request failed; its original error detail was not retained.'
          : 'The saved review did not capture live balances; its original error detail was not retained.');
        solution = 'Refresh this review to capture the verified live balances.';
        detail = `Verified live IBKR balance at ${balance.observedAt}; socket and account observations are current, with no cached response.`;
      } else if (balance && !unsafe(balance) && fresh(balance.observedAt, clock, 45_000) && code(balance.errorCode)) {
        detail = code(balance.errorCode); cause = capturedCause({ diagnostic: { code: detail } }) || cause;
        if (/GATEWAY|NOT_AUTHENTICATED|NOT_CONNECTED|DISCONNECTED/.test(detail)) {
          stage = 'gateway-offline';
          cause = 'The current balance request could not verify an authenticated IB Gateway connection.';
          solution = 'Sign in to IB Gateway, verify API access in Systems, then refresh this review.';
          status = 'Current balances remain unavailable; this saved review retains its original capture.';
        }
      }
      if (stage !== 'recovered' && gateway?.status === 'offline') {
        stage = 'gateway-offline';
        cause = 'IB Gateway is currently disconnected; the balance request cannot verify a managed account or current balances.';
        solution = 'Sign in to IB Gateway, verify API access in Systems, then refresh this review.';
        status = 'Current balances remain unavailable; this saved review retains its original capture.';
        detail += ' Current live-portfolio gateway-session check is offline.';
        path = '/api/system-status';
      }
    } else if (source.requiresIbGateway === true) {
      path = '/api/system-status';
      if (gateway?.status === 'offline') {
        stage = 'gateway-offline'; cause = 'IB Gateway is currently disconnected; this source cannot be independently reverified.';
        solution = 'Sign in to IB Gateway, verify API access in Systems, then refresh this review.';
        detail = 'Current live-portfolio gateway-session check is offline.';
      } else if (brokerService?.status === 'online') {
        stage = 'connection-available';
        status = 'The connection is available; recovery of this saved source is still unverified.';
        detail = 'Current live-portfolio service is online; no source-specific recovery was established.';
      }
    }
    return { rows: rowsFor(problem, cause, solution, status), stage, detail, path, unverified, issues };
  }

  async function inspectSnapshot(sources) {
    const clock = now();
    const key = `review-source-diagnostics:${sources.conversationId}`;
    const retained = (await call('setting', { key })).value;
    const capturedAt = sources.capturedAt || sources.checkedAt;
    if (retained && retained.runId !== sources.runId && Date.parse(retained.capturedAt) >= Date.parse(capturedAt)) return { skipped: 'older-capture' };
    const signature = hash(sources.items.map(row => [row.id, row.status, code(row.diagnostic?.code), row.sourceQuality, row.verifiedFromCapture,
      ...(partialArchive(row) ? [row.detail, row.archiveCoverage] : [])]));
    if (retained?.runId === sources.runId && retained.signature === signature && fresh(retained.inspectedAt, clock, THROTTLE_MS)) return { skipped: 'throttled' };
    const priorRows = (await call('findings')).findings || [];
    const previous = new Map(priorRows.map(row => [row.id, row.payload || row]));
    const findingId = source => `attention:review-sources:${hash([sources.conversationId, source.id]).slice(0, 32)}`;
    const needsInvestigation = row => ['missing', 'unavailable'].includes(row.status) || partialArchive(row)
      || (row.status === 'ready' && (publicationIssues(row).length || previous.get(findingId(row))?.sourceDiscrepancy));
    const missing = sources.items.filter(needsInvestigation);
    const [report, balance, systemStatus] = await Promise.all([
      missing.some(row => getResearchProduct(row.id)) ? read('/api/system-readiness') : null,
      missing.some(isBalance) ? read('/api/portfolio/balance') : null,
      missing.some(row => row.requiresIbGateway) ? read('/api/system-status') : null,
    ]);
    const findings = [];
    for (const source of sources.items) {
      const id = findingId(source);
      const old = previous.get(id);
      const managed = old?.managedBy === 'review-sources' && old?.conversationId === sources.conversationId
        && old.sourceDiscrepancy === true && publicationIssues(old).length > 0;
      if (managed && old.state === 'resolved' && old.resolvedFromCapture === true
        && old.reviewRunId === sources.runId && old.capturedAt === capturedAt && !publicationIssues(source).length) continue;
      if (source.status === 'ready' && !needsInvestigation(source)) {
        const capturedPublication = getResearchProduct(source.id) && source.verifiedFromCapture === true
          && old?.reviewRunId === sources.runId && old?.capturedAt === capturedAt
          && validTime(source.publishedAt || source.observedAt)
          && Date.parse(source.publishedAt || source.observedAt) <= Date.parse(capturedAt);
        const newerCapture = old?.reviewRunId !== sources.runId && Date.parse(capturedAt) > Date.parse(old?.capturedAt);
        if (managed && old.state !== 'resolved' && (capturedPublication || newerCapture)
          && validTime(source.observedAt || source.publishedAt)) {
          const finding = { ...old, state: 'resolved', reviewRunId: sources.runId, capturedAt,
            fingerprint: hash([old.sourceId, 'resolved']), resolvedAt: clock.toISOString(),
            ...(capturedPublication ? { resolvedFromCapture: true } : {}),
            presentation: { ...old.presentation, rows: capturedPublication
              ? rowsFor(`${source.label} was incorrectly excluded from this review’s Sources.`, 'The original review already captured the dated publication; the source projection omitted it.', 'No further action is needed.', 'Resolved using verified research already present in this review capture.')
              : rowsFor(`${source.label} was excluded from an earlier review.`, 'A newer review captured the verified source.', 'No further action is needed.', 'Resolved by the newer review capture.') } };
          await call('finding', { finding }); findings.push(finding);
        }
        continue;
      }
      if (!needsInvestigation(source)) continue;
      const diagnosis = await diagnose(source, sources, report, balance, systemStatus, now(), old);
      // Sources already explains missing, unavailable, partial and recovered
      // captures. Only an evidenced publication discrepancy belongs in Inbox.
      if (!diagnosis.issues.length) continue;
      diagnosis.rows[0].text = `${source.label} contains a source-data discrepancy.`;
      if ((diagnosis.stage === 'inconclusive' || diagnosis.unverified) && managed && old.state === 'open'
        && old.diagnosisStage && old.diagnosisStage !== 'inconclusive') {
        const finding = { ...old, reviewRunId: sources.runId, capturedAt, checkedAt: now().toISOString(), currentVerification: 'unavailable' };
        await call('finding', { finding }); findings.push(finding);
        continue;
      }
      const publicationTime = managed ? old.publicationTime : clock.toISOString();
      // A later verification time is supporting evidence, not a new incident. Reuse
      // legacy fingerprints too so this presentation change preserves acknowledgments.
      const datedStatus = ['recovered', 'source-discrepancy'].includes(diagnosis.stage);
      const sameRecovery = managed && old.state === 'open' && datedStatus
        && old.diagnosisStage === diagnosis.stage && old.fingerprint
        && hash(recoveryMaterial(old.presentation?.rows || [])) === hash(recoveryMaterial(diagnosis.rows));
      const sameDiscrepancy = managed && old.state === 'open' && old.fingerprint
        && hash(publicationIssues(old)) === hash(diagnosis.issues);
      const fingerprint = sameRecovery || sameDiscrepancy ? old.fingerprint
        : hash([source.id, diagnosis.stage, datedStatus ? recoveryMaterial(diagnosis.rows) : diagnosis.rows]);
      const citation = { id: `cite_${hash([id, diagnosis.stage]).slice(0, 32)}`, title: diagnosis.sourceLabel || 'Systems', product: 'dashboard-health',
        publicationDate: newYorkParts(clock).date, sourceUri: diagnosis.path, excerpt: diagnosis.detail };
      const finding = { attentionVersion: 1, managedBy: 'review-sources', id, sourceId: id, symbol: source.label,
        kind: 'operational', action: 'review source issue', state: 'open', priority: 1, publicationTime,
        conversationId: sources.conversationId, reviewRunId: sources.runId, capturedAt, sourceKey: source.id,
        ...(getResearchProduct(source.id) ? { incidentKey: `research-product:${source.id}:${diagnosis.issues[0]?.source?.reportDate || newYorkParts(capturedAt).date}` } : {}),
        checkedAt: now().toISOString(), diagnosisStage: diagnosis.stage, fingerprint, citation,
        ...(diagnosis.issues.length ? { sourceDiscrepancy: true, sourceQuality: { status: 'discrepancy', issues: diagnosis.issues } } : {}),
        presentation: { subject: source.label, date: newYorkParts(publicationTime).date, rows: diagnosis.rows,
          sourceLinks: [{ label: diagnosis.sourceLabel || 'Systems', citation }, ...discrepancySourceLinks(diagnosis.issues, source.label)] } };
      await call('finding', { finding }); findings.push(finding);
    }
    await call('setting', { key, value: { runId: sources.runId, capturedAt, signature, inspectedAt: clock.toISOString() } });
    return { findings, checkedAt: clock.toISOString() };
  }

  function inspect(sources) {
    if (sources?.basis !== 'review' || !['succeeded', 'failed', 'cancelled'].includes(sources.state)
      || !sources.conversationId || !sources.runId || !validTime(sources.capturedAt || sources.checkedAt) || !Array.isArray(sources.items)) return Promise.resolve({ skipped: 'not-terminal-review' });
    // Capture once; diagnostic reads and persistence must never amend review evidence.
    const snapshot = JSON.parse(JSON.stringify(sources));
    const pending = running.get(sources.conversationId);
    const signature = hash(snapshot);
    if (pending?.signature === signature) return pending.promise;
    const promise = (pending?.promise || Promise.resolve()).catch(() => {}).then(() => inspectSnapshot(snapshot));
    running.set(sources.conversationId, { signature, promise });
    const clear = () => { if (running.get(sources.conversationId)?.promise === promise) running.delete(sources.conversationId); };
    promise.then(clear, clear);
    return promise;
  }
  return { inspect };
}

module.exports = { createSourceDiagnostics, THROTTLE_MS };
