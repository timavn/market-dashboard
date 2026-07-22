const { getCurrentCpiRelease } = require('./cpiRelease');
const { discoverIbkrEventContracts } = require('./providers/ibkrProvider');
const { persistCatalogEvents } = require('./cache');

const RECONCILIATION_TYPE = 'cpi_catalog_reconciliation';
const VALID_TRIGGERS = new Set(['manual', 'premarket', 'release_change', 'startup']);
const DEFAULT_POLL_MS = 5 * 60 * 1000;
const DEFAULT_PREMARKET_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_TIME_ZONE = 'America/New_York';

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function releaseFingerprint(release = {}) {
  if (!release.releaseKey) return null;
  return JSON.stringify({
    releaseKey: release.releaseKey,
    releaseDate: release.releaseDate || release.cpi?.releaseDate || null,
    sourceAsOf: release.source?.asOf || null,
    targetStrikes: release.targetStrikes || release.cpi?.targetStrikes || [],
    scenarios: (release.scenarios || []).map((scenario) => ({
      key: scenario.key,
      value: scenario.value,
    })),
  });
}

function dateInTimeZone(date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function isPremarketWindow(date, {
  timeZone = DEFAULT_TIME_ZONE,
  startMinutes = 4 * 60,
  endMinutes = 9 * 60 + 30,
} = {}) {
  const parts = dateInTimeZone(date, timeZone);
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday)) return false;
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  return minuteOfDay >= startMinutes && minuteOfDay < endMinutes;
}

function currentDate(now) {
  const value = now();
  return value instanceof Date ? value : new Date(value);
}

function operationalDiscoveryBody(release = {}, requestedBody = {}) {
  const cpi = release.cpi || release.request?.cpi;
  if (!release.releaseKey || !cpi) {
    const error = new Error('The server could not resolve the current CPI release for reconciliation.');
    error.code = 'CPI_RELEASE_UNAVAILABLE';
    throw error;
  }
  return {
    ...(requestedBody?.fair_probability != null
      ? { fair_probability: requestedBody.fair_probability }
      : {}),
    cpi: { ...cpi, releaseKey: release.releaseKey },
  };
}

function strikeTick(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10) : null;
}

function assessDiscoveryQualification(discovery = {}, release = {}) {
  const promotion = discovery.catalog_promotion || discovery.catalogPromotion || {};
  const report = discovery.cpi_discovery || {};
  const qualification = discovery.catalog_qualification || {};
  const targetTicks = new Set((release.cpi?.targetStrikes || release.targetStrikes || [])
    .map(strikeTick)
    .filter((tick) => tick != null));
  const foundTicks = new Set((report.foundStrikes || [])
    .map(strikeTick)
    .filter((tick) => tick != null));
  const reportedMissing = [
    ...(report.missingStrikes || []),
    ...(qualification.missingStrikes || []),
    ...(qualification.freshMissingStrikes || []),
  ]
    .map(strikeTick)
    .filter((tick) => tick != null);
  const computedMissing = [...targetTicks].filter((tick) => !foundTicks.has(tick));
  const missingTicks = [...new Set([...reportedMissing, ...computedMissing])].sort((a, b) => a - b);
  const discoveredCount = Number(discovery.discovered ?? report.discovered ?? 0);
  const qualifiedContracts = Number(qualification.qualifiedContracts ?? 0);
  const freshDiscoveredContracts = Number(qualification.freshDiscoveredContracts ?? 0);
  const releaseKey = release.releaseKey || null;
  const releaseMatches = Boolean(
    releaseKey
    && promotion.releaseKey === releaseKey
    && report.releaseKey === releaseKey
    && qualification.releaseKey === releaseKey
  );
  const candidateGeneration = promotion.type === 'catalog_candidate'
    && promotion.atomic === false
    && promotion.releaseKey === releaseKey
    && promotion.authority === 'PredictionMarketCatalogV2';
  const freshDiscoveryVerified = discoveredCount > 0 && freshDiscoveredContracts > 0;
  const qualificationVerified = qualification.authoritative === true
    && qualification.complete === true
    && qualifiedContracts > 0
    && releaseMatches;
  const targetCoverageComplete = targetTicks.size > 0
    && missingTicks.length === 0
    && qualification.targetCoverageComplete === true
    && qualification.freshTargetCoverageComplete === true
    && qualifiedContracts >= targetTicks.size
    && freshDiscoveredContracts >= targetTicks.size;

  let code = null;
  if (!candidateGeneration) code = 'CATALOG_CANDIDATE_UNVERIFIED';
  else if (!freshDiscoveryVerified) code = 'CATALOG_ZERO_FRESH_DISCOVERIES';
  else if (qualification.authoritative !== true || !releaseMatches || qualifiedContracts <= 0) {
    code = 'CATALOG_QUALIFICATION_UNVERIFIED';
  } else if (!targetCoverageComplete) code = 'CATALOG_TARGET_COVERAGE_INCOMPLETE';
  else if (!qualificationVerified) code = 'CATALOG_QUALIFICATION_UNVERIFIED';

  return {
    ok: code == null,
    code,
    candidateGeneration,
    freshDiscoveryVerified,
    qualificationVerified,
    targetCoverageComplete,
    discoveredCount,
    freshDiscoveredContracts,
    qualifiedContracts,
    missingStrikes: missingTicks.map((tick) => tick / 10),
  };
}

function parseContractExpiry(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const day = text.match(/^(\d{4})(\d{2})(\d{2})/);
  const timestamp = day
    ? Date.parse(`${day[1]}-${day[2]}-${day[3]}T23:59:59.999Z`)
    : Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function catalogCandidateStrikeTick(candidate = {}) {
  const direct = strikeTick(candidate.strike);
  if (direct != null) return direct;
  const text = [
    candidate.localSymbol,
    candidate.contract_title,
    candidate.question,
    candidate.description,
  ].filter(Boolean).join(' ');
  const above = text.match(/\babove\s+(-?\d+(?:\.\d+)?)\s*%?/i);
  if (above) return strikeTick(above[1]);
  const nativeToken = text.match(/(?:^|[-_\s])T(-?\d+(?:\.\d+)?)(?:[-_\s]?(?:YES|NO)\b|$)/i);
  return nativeToken ? strikeTick(nativeToken[1]) : null;
}

function assessCatalogCandidates(candidates = [], release = {}, at = new Date()) {
  const expectedReleaseKey = release.releaseKey || null;
  const targetTicks = new Set((release.cpi?.targetStrikes || release.targetStrikes || [])
    .map(strikeTick)
    .filter((tick) => tick != null));
  const candidateTicks = new Set();
  const seen = new Set();
  const failures = [];
  const allowedVenues = new Set(['IBKR', 'FORECASTEX', 'CME']);
  for (const candidate of candidates || []) {
    const venue = String(candidate?.venue || '').toUpperCase();
    const conId = Number(candidate?.conId ?? candidate?.conid);
    const releaseKey = String(candidate?.releaseKey || candidate?.release_key || '');
    const side = String(candidate?.quote_side || candidate?.native_side || '').toUpperCase();
    const expiry = parseContractExpiry(
      candidate?.expiration_time || candidate?.lastTradeDateOrContractMonth,
    );
    const key = `${venue}#${conId}`;
    if (!allowedVenues.has(venue)) failures.push(`${key}:non_ibkr_venue`);
    if (!Number.isInteger(conId) || conId <= 0) failures.push(`${key}:missing_native_conid`);
    if (seen.has(key)) failures.push(`${key}:duplicate_native_contract`);
    seen.add(key);
    if (releaseKey !== expectedReleaseKey) failures.push(`${key}:wrong_release`);
    if (String(candidate?.catalog_source || '') !== 'ibkr_contract_details') {
      failures.push(`${key}:unverified_catalog_source`);
    }
    if (!String(candidate?.exchange || '').trim()) failures.push(`${key}:missing_exchange`);
    if (!String(candidate?.tradingClass || '').trim()) failures.push(`${key}:missing_trading_class`);
    if (!['YES', 'NO'].includes(side)) failures.push(`${key}:unknown_native_side`);
    if (!Number.isFinite(expiry) || expiry <= new Date(at).getTime()) {
      failures.push(`${key}:missing_or_expired_expiry`);
    }
    const tick = catalogCandidateStrikeTick(candidate);
    if (tick != null && targetTicks.has(tick)) candidateTicks.add(tick);
  }
  const missingTicks = [...targetTicks].filter((tick) => !candidateTicks.has(tick));
  if (!candidates?.length) failures.push('catalog:no_candidates');
  if (targetTicks.size === 0) failures.push('catalog:no_target_strikes');
  if (missingTicks.length) failures.push('catalog:target_coverage_incomplete');
  return {
    ok: failures.length === 0,
    failures: [...new Set(failures)],
    missingStrikes: missingTicks.map((tick) => tick / 10),
    venues: [...new Set((candidates || []).map((candidate) => candidate?.venue).filter(Boolean))],
  };
}

function createCpiCatalogReconciler({
  loadCurrentRelease = getCurrentCpiRelease,
  discover = discoverIbkrEventContracts,
  promoteCatalog = persistCatalogEvents,
  now = () => new Date(),
  schedule = setInterval,
  cancelSchedule = clearInterval,
  logger = console,
  env = process.env,
} = {}) {
  const pollMs = positiveInteger(env.PM_CPI_RECONCILE_POLL_MS, DEFAULT_POLL_MS);
  const premarketIntervalMs = positiveInteger(
    env.PM_CPI_PREMARKET_RECONCILE_MS,
    DEFAULT_PREMARKET_INTERVAL_MS,
  );
  const timeZone = env.PM_CPI_RECONCILE_TIME_ZONE || DEFAULT_TIME_ZONE;
  const state = {
    started: false,
    timer: null,
    inFlight: null,
    lastOutcome: null,
    lastSuccessfulFingerprint: null,
    lastObservedFingerprint: null,
    lastPremarketAtMs: null,
  };

  function snapshot() {
    return {
      type: RECONCILIATION_TYPE,
      enabled: env.PM_CPI_RECONCILER_ENABLED !== 'false',
      started: state.started,
      inFlight: Boolean(state.inFlight),
      pollMs,
      premarketIntervalMs,
      timeZone,
      lastObservedFingerprint: state.lastObservedFingerprint,
      lastOutcome: state.lastOutcome,
    };
  }

  function skippedOutcome(trigger, code, message) {
    const at = currentDate(now).toISOString();
    return {
      type: RECONCILIATION_TYPE,
      trigger,
      status: 'skipped',
      code,
      message,
      startedAt: at,
      completedAt: at,
      durationMs: 0,
    };
  }

  async function reconcile({ trigger = 'manual', requestedBody = {}, release = null } = {}) {
    const normalizedTrigger = VALID_TRIGGERS.has(trigger) ? trigger : 'manual';
    if (state.inFlight) {
      return {
        outcome: skippedOutcome(
          normalizedTrigger,
          'CATALOG_RECONCILE_BUSY',
          'A CPI catalog reconciliation is already running.',
        ),
        currentRelease: null,
        requestBody: null,
        discovery: null,
      };
    }

    const run = (async () => {
      const started = currentDate(now);
      let currentRelease = release;
      let requestBody = null;
      try {
        currentRelease = currentRelease || await loadCurrentRelease();
        const fingerprint = releaseFingerprint(currentRelease);
        state.lastObservedFingerprint = fingerprint;
        requestBody = operationalDiscoveryBody(currentRelease, requestedBody);
        const discovery = await discover(requestBody);
        const qualification = assessDiscoveryQualification(discovery, currentRelease);
        const candidates = Array.isArray(discovery?.catalog_contracts)
          ? discovery.catalog_contracts
          : [];
        const candidateAssessment = assessCatalogCandidates(candidates, currentRelease, started);
        let persisted = null;
        if (discovery?.ok !== false && qualification.ok && candidateAssessment.ok) {
          try {
            persisted = await promoteCatalog(candidates, {
              releaseKey: currentRelease.releaseKey,
              venues: candidateAssessment.venues,
              source: 'authoritative-ibkr-contract-details',
              promoteCurrent: true,
              replaceVenues: true,
            });
          } catch (error) {
            const persistenceError = new Error(`PredictionMarketCatalogV2 promotion failed: ${error.message}`);
            persistenceError.code = 'CATALOG_PERSISTENCE_FAILED';
            persistenceError.cause = error;
            throw persistenceError;
          }
        }
        const promotionVerified = Boolean(
          persisted?.atomic === true
          && persisted?.promotedCurrent === true
          && persisted?.releases?.length === 1
          && persisted.releases[0] === currentRelease.releaseKey
        );
        const succeeded = discovery?.ok !== false
          && qualification.ok
          && candidateAssessment.ok
          && promotionVerified;
        const completed = currentDate(now);
        let failureCode = null;
        if (discovery?.ok === false) failureCode = discovery?.errorCode || 'CATALOG_DISCOVERY_FAILED';
        else if (!qualification.ok) failureCode = qualification.code;
        else if (!candidateAssessment.ok) failureCode = 'CATALOG_CANDIDATE_INVALID';
        else if (!promotionVerified) failureCode = 'CATALOG_PROMOTION_UNVERIFIED';
        const outcome = {
          type: RECONCILIATION_TYPE,
          trigger: normalizedTrigger,
          status: succeeded ? 'succeeded' : 'failed',
          code: succeeded
            ? 'CATALOG_RECONCILED'
            : failureCode || 'CATALOG_RECONCILE_VALIDATION_FAILED',
          result: succeeded ? 'promoted' : 'not_promoted',
          releaseKey: currentRelease.releaseKey,
          releaseFingerprint: fingerprint,
          atomicPromotion: promotionVerified,
          qualificationVerified: qualification.qualificationVerified,
          targetCoverageComplete: qualification.targetCoverageComplete,
          freshDiscoveredContracts: qualification.freshDiscoveredContracts,
          missingStrikes: qualification.missingStrikes,
          contractsAdded: Number(discovery?.contracts_added || 0),
          contractsTotal: Number(discovery?.contracts_total || 0),
          retiredContracts: Number(persisted?.retired || 0),
          persistedContracts: Number(persisted?.contracts || 0),
          startedAt: started.toISOString(),
          completedAt: completed.toISOString(),
          durationMs: Math.max(0, completed.getTime() - started.getTime()),
          message: succeeded
            ? null
            : discovery?.message || (
              qualification.code === 'CATALOG_ZERO_FRESH_DISCOVERIES'
                ? 'The sidecar retained catalog rows but did not freshly rediscover any authoritative contracts.'
                : qualification.code === 'CATALOG_TARGET_COVERAGE_INCOMPLETE'
                  ? `The authoritative current-release catalog is missing target strikes: ${qualification.missingStrikes.join(', ')}.`
                  : !candidateAssessment.ok
                    ? `The native catalog candidate failed validation: ${candidateAssessment.failures.join(', ')}.`
                  : qualification.code === 'CATALOG_QUALIFICATION_UNVERIFIED'
                    ? 'The sidecar did not prove native contract qualification for the current release.'
                    : 'PredictionMarketCatalogV2 did not verify an atomic current-release promotion.'
            ),
        };
        state.lastOutcome = outcome;
        if (succeeded) {
          state.lastSuccessfulFingerprint = fingerprint;
          if (
            normalizedTrigger === 'premarket' ||
            (normalizedTrigger === 'startup' && isPremarketWindow(completed, { timeZone }))
          ) {
            state.lastPremarketAtMs = completed.getTime();
          }
        }
        return { outcome, currentRelease, requestBody, discovery };
      } catch (error) {
        const completed = currentDate(now);
        const outcome = {
          type: RECONCILIATION_TYPE,
          trigger: normalizedTrigger,
          status: 'failed',
          code: error.code || 'CATALOG_RECONCILE_ERROR',
          result: 'not_promoted',
          releaseKey: currentRelease?.releaseKey || null,
          atomicPromotion: false,
          startedAt: started.toISOString(),
          completedAt: completed.toISOString(),
          durationMs: Math.max(0, completed.getTime() - started.getTime()),
          message: error.message,
        };
        state.lastOutcome = outcome;
        return { outcome, currentRelease, requestBody, discovery: null };
      }
    })();

    state.inFlight = run;
    try {
      return await run;
    } finally {
      state.inFlight = null;
    }
  }

  async function poll() {
    if (state.inFlight) {
      return skippedOutcome('release_change', 'CATALOG_RECONCILE_BUSY', 'Reconciliation is already running.');
    }
    let release;
    try {
      release = await loadCurrentRelease();
    } catch (error) {
      const failed = await reconcile({ trigger: 'release_change' });
      if (failed.outcome.status === 'failed') {
        logger.warn?.(`[PM Reconciler] ${failed.outcome.code}: ${failed.outcome.message}`);
      }
      return failed.outcome;
    }
    const fingerprint = releaseFingerprint(release);
    state.lastObservedFingerprint = fingerprint;
    if (!fingerprint || fingerprint !== state.lastSuccessfulFingerprint) {
      const changed = await reconcile({ trigger: 'release_change', release });
      return changed.outcome;
    }

    const at = currentDate(now);
    const premarketDue = isPremarketWindow(at, { timeZone }) && (
      state.lastPremarketAtMs == null ||
      at.getTime() - state.lastPremarketAtMs >= premarketIntervalMs
    );
    if (premarketDue) {
      const premarket = await reconcile({ trigger: 'premarket', release });
      return premarket.outcome;
    }
    return skippedOutcome('premarket', 'CATALOG_RECONCILE_NOT_DUE', 'No release change or premarket cadence is due.');
  }

  async function start() {
    if (env.PM_CPI_RECONCILER_ENABLED === 'false') {
      return skippedOutcome('startup', 'CATALOG_RECONCILER_DISABLED', 'CPI catalog reconciler is disabled.');
    }
    if (state.started) {
      return skippedOutcome('startup', 'CATALOG_RECONCILER_STARTED', 'CPI catalog reconciler is already started.');
    }
    state.started = true;
    state.timer = schedule(() => {
      poll().catch((error) => logger.warn?.(`[PM Reconciler] poll failed: ${error.message}`));
    }, pollMs);
    state.timer?.unref?.();
    const startup = await reconcile({ trigger: 'startup' });
    if (startup.outcome.status === 'failed') {
      logger.warn?.(`[PM Reconciler] ${startup.outcome.code}: ${startup.outcome.message}`);
    }
    return startup.outcome;
  }

  function stop() {
    if (state.timer) cancelSchedule(state.timer);
    state.timer = null;
    state.started = false;
  }

  return { reconcile, poll, start, stop, getStatus: snapshot };
}

const singleton = createCpiCatalogReconciler();

module.exports = {
  assessCatalogCandidates,
  assessDiscoveryQualification,
  createCpiCatalogReconciler,
  isPremarketWindow,
  operationalDiscoveryBody,
  releaseFingerprint,
  reconcileCurrentCpiCatalog: (options) => singleton.reconcile(options),
  startCpiCatalogReconciler: () => singleton.start(),
  stopCpiCatalogReconciler: () => singleton.stop(),
  getCpiCatalogReconcilerStatus: () => singleton.getStatus(),
};
