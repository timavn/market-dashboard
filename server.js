require('dotenv').config();
if (process.env.MARKET_DASHBOARD_AWS_PROFILE_LOCKED === 'true') {
  for (const key of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
  ]) {
    delete process.env[key];
  }
}
const express = require('express');
const cors = require('cors');
const { createApiCorsOptions } = require('./src/services/api/corsConfig.cjs');
const { createApiErrorHandler } = require('./src/services/api/apiErrorHandler.cjs');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { AWS, S3, DynamoDB, Lambda, SES, CloudWatch } = require('./src/services/aws/clients.cjs');
const { readAllDynamoItems } = require('./src/services/data/dynamoPagination.cjs');
const { createQuoteRequestScheduler } = require('./src/services/providers/quoteRequestScheduler.cjs');
const scheduleQuoteFetch = createQuoteRequestScheduler();
const { createLocalTrustMiddleware, validateLocalRequest, rejectWebSocketUpgrade, createMessageBudget } = require('./src/services/security/localTrust.cjs');
const analystRuntimeGate = require('./src/services/analyst/analystRuntimeGate.cjs').getAnalystRuntimeGate();
const axios = require('axios');
const SERVICE_MANIFEST = require('./ops/services.json');
const AWS_RESOURCE_DEFAULTS = SERVICE_MANIFEST.aws?.resources || {};
const GMAIL_SERVICE_DEFINITION = (SERVICE_MANIFEST.services || [])
  .find((service) => service.id === 'gmail.ingestion');
const { createExchangeVolumeService } = require('./src/services/exchangeVolumeService.cjs');
const { createExUsVolumeService } = require('./src/services/exUsVolumeService.cjs');
const { createRegionalVolumeService } = require('./src/services/regionalVolumeService.cjs');
const { exchangeVolumeFreshness } = require('./src/utils/exchangeVolume.cjs');
const { createMoneyFlowService } = require('./src/services/moneyFlowService.cjs');
const usExchangeVolumeService = createExchangeVolumeService();
const exchangeVolumeService = createRegionalVolumeService({
  usService: usExchangeVolumeService,
  exUsService: createExUsVolumeService(),
});
const { buildMomoTrackerCsvRows } = require('./src/utils/momoTrackerCsv.cjs');
const { determineEtfProSnapshotDate } = require('./src/utils/etfProSnapshotDate.cjs');
const { currentResearchEvents } = require('./src/utils/researchEventRevisions.cjs');
const {
  parseEtfProActionEmail,
  parseEtfProFullBookEmail,
} = require('./src/utils/etfProEmailSnapshot.cjs');
const {
  comparePayloadOrder: compareEtfPayloadOrder,
} = require('./src/utils/etfProResolver.cjs');
const {
  MESSAGE_ID: SOURCE_EMAIL_ID,
  TERM: SOURCE_EMAIL_TERM,
  sourceEmailClip,
  emailBodyItem,
} = require('./src/utils/sourceEmailClip.cjs');
const {
  HEDGEYE_BUCKET,
  resolveHedgeyeMedia,
  buildHedgeyeContentUrlFromRequest,
} = require('./src/utils/hedgeyeMedia.cjs');
const { normalizeCboeTreasuryYield } = require('./src/utils/treasuryYieldScale.cjs');
const {
  HERMES_AGENT_RUNS_TABLE,
  HERMES_ALERTS_TABLE,
  listWorkerDefinitions,
  getDirectorSnapshot,
  executeDirectorCommand,
  updateAlertRecord,
} = require('./src/utils/hermesManagingDirector.cjs');
const {
  legacyHermesIsReadOnly,
  normalizeLegacyHermesMode,
  rejectLegacyHermesMutation,
  stripLegacyHermesWorkflowFields,
} = require('./src/utils/legacyHermesMode.cjs');
const legacyHermesMode = normalizeLegacyHermesMode();
const {
  summarizeRealTimeAlertPositions,
} = require('./src/utils/rtaPositionReconstruction.cjs');
const {
  materializeRtaLedgerItems,
} = require('./src/utils/rtaLedgerMaterialization.cjs');
const {
  buildEtfProPayloadsFromResearchEvents,
  filterLegacyRejectionsByCompleteCanonicalSources,
  filterIssuesAfterAuthoritativeCheckpoint,
  materializeRtaResearchEvents,
  mergeRtaMaterializations,
  partitionEtfProLegacyCoverage,
} = require('./src/utils/researchEventLedger.cjs');
const {
  applyRtaCanonicalComparisonGate,
  resolveEtfProCanonicalComparison,
} = require('./src/utils/researchComparisonSafety.cjs');
const {
  failClosedHealthFromCache,
  requireAuthoritativeCacheValue,
} = require('./src/utils/authoritativeResearchCache.cjs');
const {
  resolveRtaReplayCutoff,
  validateRtaCheckpoint,
} = require('./src/utils/rtaCheckpoint.cjs');
const {
  checkpointToEtfProFullBookPayload,
  validateEtfProCheckpoint,
} = require('./src/utils/etfProCheckpoint.cjs');
const {
  applyPersistedManifestGate,
  buildRiskRangeEnvelope,
  expectedRiskRangePublication,
} = require('./src/utils/riskRangePublication.cjs');
const { sidecarRequest } = require('./src/services/providers/ibkrSidecarClient');
const {
  buildAnalystRuntimeCheck,
  createSystemReadinessService,
  getLambdaActivity,
  getServiceHeartbeat,
  getSupervisorProvenance,
} = require('./src/services/systemReadinessService.cjs');
const {
  collectScheduledHeartbeatEvidence,
  createSystemStatusService,
  createUnavailableSystemStatus,
} = require('./src/services/systemStatusService.cjs');
const {
  createAwsProfileProbe,
  createLoginActionService,
  createLoginStatusService,
} = require('./src/services/loginStatusService.cjs');
const {
  resolveGmailPollHealth,
} = require('./src/utils/gmailPollHealth.cjs');
const {
  buildHistoricalBackfillStatus,
} = require('./src/utils/hermesHistoricalBackfill.cjs');
const {
  buildCpiNowcastHistory,
} = require('./src/utils/cpiNowcastHistory.cjs');
const { createSystemReadinessRepairService } = require('./src/services/systemReadinessRepairService.cjs');
const { createSystemReadinessRoutes } = require('./src/routes/systemReadiness.cjs');
const { createSp500ContributorsHandler } = require('./src/routes/sp500Contributors.cjs');
const { createMarketDailyHandler } = require('./src/routes/marketDaily.cjs');
const { createMarketRotationHandler } = require('./src/routes/marketRotation.cjs');
const {
  createLeveragedProductOverlapHandler,
  createExchangeVolumeHandler,
  createMarketEventsHandler,
} = require('./src/routes/referenceHandlers.cjs');
const {
  buildLiquidityModels,
} = require('./src/utils/liquidityModel.cjs');
const {
  createUsdCorrelationService,
} = require('./src/services/usdCorrelationService.cjs');
const { TREASURY_PAR_YIELD_URL, fetchTreasuryParYieldSeries } = require('./src/services/treasuryParYields.cjs');
const {
  createUsdCorrelationHandler,
} = require('./src/routes/correlationHandlers.cjs');
const {
  createFxvlSnapshotService,
} = require('./src/services/fxvlSnapshotService.cjs');
const {
  createLeveragedProductOverlapService,
} = require('./src/services/leveragedProductOverlapService.cjs');
const {
  fetchFlexStatement,
  getConfig: getFlexConfig,
  getReconciliation: getFlexReconciliation,
  publicConfigStatus: getFlexPublicConfigStatus,
  readAccountPositions: readFlexAccountPositions,
  startFlexActivitySync,
  stopFlexActivitySync,
} = require('./src/services/ibkrFlexService.cjs');
const { expectedIbkrAccountIds } = require('./src/utils/ibkrAccountCoverage.cjs');
const {
  getIbkrInterestValidationHistoryAsync,
  getIbkrInterestValidationStatusAsync,
  readPrivateInterestLedgerAsync,
  closeIbkrInterestEvidenceWorker,
  recordIbkrInterestBalanceObservation,
  runIbkrInterestValidation,
  startIbkrInterestValidation,
  stopIbkrInterestValidation,
} = require('./src/services/ibkrInterestValidationService.cjs');
const { getFreshCachedQuote } = require('./src/services/providers/quoteCachePolicy.cjs');
const { validateQuoteObservation } = require('./src/services/providers/normalize/quoteContract.cjs');
const {
  instrumentCacheKey,
  canUseSymbolStream,
} = require('./src/services/providers/instruments/instrumentResolver');
const {
  getProviderStatusSnapshot,
} = require('./src/services/providers/providerStatus');
const {
  toQuoteInstrument,
  buildQuoteMetadata,
  buildPeriodReturnsMetadata,
  isDisplayableQuoteRow,
} = require('./src/services/providers/multiRegionQuoteIntegrity.cjs');
const { latestObservationChange } = require('./src/services/providers/observationChange.cjs');
const {
  computePeriodBpsFromCloses,
  computePeriodPercentsFromCloses,
  computeSpreadBpsDeltas,
} = require('./src/utils/marketPeriodReturns.cjs');
const { unavailableRetryMs } = require('./src/utils/unavailableRetryWindow.cjs');
const { fetchOfficialSovereignSeries } = require('./src/services/officialSovereignYields.cjs');
const MARKET_BACKDROP_CATALOG = require('./src/constants/marketBackdropCatalog.json');
const MARKET_PULSE_SUPPLEMENTAL_CATALOG = require('./src/constants/marketPulseSupplementalCatalog.json');
const {
  createMarketQuoteReferenceStore,
  markRetainedReference,
} = require('./src/services/marketQuoteReferenceStore.cjs');
const {
  summarizeMarketDataStatusEvidence,
} = require('./src/services/marketDataStatusEvidence.cjs');
const {
  createVolatilitySnapshotService,
  isUsMarketOpen,
  mostRecentCompletedTradingDateKey,
} = require('./src/services/volatilitySnapshotService.cjs');
const {
  createVixHandler,
  createVolatilityHandler,
  createVolatilitySnapshotHandler,
} = require('./src/routes/volatilityHandlers.cjs');
const {
  createMarketEventsService,
} = require('./src/services/marketEventsService.cjs');
const { loadUsCpiConsensus } = require('./src/services/tradingEconomicsCalendarProvider.cjs');
const { scanAllPages } = require('./src/utils/dynamoScanAllPages.cjs');
const { createAsyncTtlCache } = require('./src/utils/serverResponseCache.cjs');
const {
  buildPublicMarketStructureSnapshot,
  isIsoDate: isMarketStructureIsoDate,
  resolveMarketStructureChartAsset,
  safeInlineFilename: safeMarketStructureFilename,
} = require('./src/utils/marketStructureReport.cjs');
const {
  createCheckpointFirstResearchResponse,
  failClosedResearchRefresh,
  setCheckpointFirstNoStoreHeader,
} = require('./src/utils/checkpointFirstResearchResponse.cjs');
const {
  buildEtfProCheckpointFirstResponse: buildFastEtfProCheckpointResponse,
  buildRtaCheckpointFirstResponse: buildFastRtaCheckpointResponse,
} = require('./src/utils/researchCheckpointFastPath.cjs');
const {
  DEFAULT_SOURCE: SECURITY_RISK_METRICS_SOURCE,
  REASONS: SECURITY_RISK_METRICS_REASONS,
  buildSecurityRiskMetrics,
  createUnavailableSecurityRiskMetrics,
  normalizeAdjustedPriceBars,
} = require('./src/utils/securityRiskMetrics.cjs');
const { fetchYahooAdjustedHistoryData } = require('./src/services/providers/yahooAdjustedHistory.cjs');
const { createCompletedSessionVolatilityHandler } = require('./src/services/completedSessionVolatility.cjs');
const { closeWorkbookReaders } = require('./src/services/workbookReaderWorkerService.cjs');
const {
  buildHedgeyeSecurityUniverse,
  parseSeedSecurities,
} = require('./src/utils/hedgeyeUniverseDiscovery.cjs');
const {
  FACTOR_DEFINITIONS: EXPOSURE_LAB_FACTOR_DEFINITIONS,
  MODEL_VERSION: EXPOSURE_LAB_MODEL_VERSION,
  buildFactorNeutralizationScenarios,
  buildPortfolioFactorRiskSnapshot,
  getFactorProxySymbols,
} = require('./src/utils/exposureLabFactorRisk.cjs');
const {
  buildEmptyCorrelation,
  buildEmptyGeography,
  buildExposureLabDiagnostics,
  classifyExposureLabPortfolioInput,
} = require('./src/utils/exposureLabDiagnostics.cjs');
const {
  getExposureLabGeographyHistorySymbols,
} = require('./src/constants/exposureLabGeography.cjs');
const {
  createExposureLabSecurityMaster,
  mergeSecurityMasterReviews,
} = require('./src/services/exposureLabSecurityMaster.cjs');
const {
  createExposureLabSecurityIdentityResolver,
  resolveExposureLabYahooSymbol,
} = require('./src/services/exposureLabSecurityIdentity.cjs');
const { createSecurityIdentitiesHandler } = require('./src/routes/securityIdentities.cjs');
const { createSecurityUniverseHandler } = require('./src/routes/securityUniverse.cjs');
const { createSecurityUniverseService } = require('./src/services/securityUniverse/securityUniverseService.cjs');
const { createIdentityPiece } = require('./src/services/securityUniverse/pieces/identity.cjs');
const { createResearchPiece } = require('./src/services/securityUniverse/pieces/research.cjs');
const { createStancePiece } = require('./src/services/securityUniverse/pieces/stance.cjs');
const { createMarketHistoryPiece } = require('./src/services/securityUniverse/pieces/marketHistory.cjs');
const { securitySizingReference } = require('./src/utils/securitySizingReference.js');
const {
  ANALYTICS_SOURCE_IDS,
  buildAnalyticsDailyBrief,
  isMarketDay,
} = require('./src/utils/analyticsDailyBrief.cjs');
const {
  DEFAULT_RETENTION_DAYS: TLDR_ARCHIVE_RETENTION_DAYS,
  DEFAULT_VISIBLE_DAYS: TLDR_ARCHIVE_VISIBLE_DAYS,
  assertArchiveDate,
  buildMorningTldrArchive,
  buildMorningTldrDay,
  buildMorningTldrStatus,
} = require('./src/utils/morningTldrArchive.cjs');
const {
  MAX_HISTORY_DAYS: SECURITY_INTELLIGENCE_MAX_HISTORY_DAYS,
  MAX_SYMBOLS: SECURITY_INTELLIGENCE_MAX_SYMBOLS,
  defaultResearchMarketDate,
  isValidMarketDate,
  loadSecurityIntelligenceInputs,
  normalizeRequestedSymbols,
} = require('./src/utils/securityIntelligence.cjs');
const { createSecurityIntelligenceWorkerService } = require('./src/services/securityIntelligenceWorkerService.cjs');
const { createAnalystRoutes } = require('./src/routes/analyst.cjs');
const { createPortfolioRefreshResearchWorkerService } = require('./src/services/analyst/portfolioRefreshResearchWorkerService.cjs');
const { createCurrencyPairsHandler } = require('./src/routes/currencyPairsHandler.cjs');
const { attachAnalystGatewayProxy } = require('./src/services/analyst/analystGatewayProxy.cjs');

const volatilitySnapshotService = createVolatilitySnapshotService({ httpClient: axios });
const marketEventsService = createMarketEventsService({ httpClient: axios });
const leveragedProductOverlapService = createLeveragedProductOverlapService();
const marketQuoteReferenceStore = createMarketQuoteReferenceStore({
  dataDir: process.env.MARKET_QUOTE_REFERENCE_DATA_DIR
    || path.join(process.cwd(), 'data', 'market-quotes-reference'),
});

function scaleRateProxyValue(raw, isRateProxy) {
  if (raw == null || raw === undefined || !isRateProxy) return raw;
  return normalizeCboeTreasuryYield(raw);
}

const app = express();
// In development, use port 3001 so React dev server can use 3000
// In production, use port 3000 (or PORT env var)
const PORT = process.env.PORT || (process.env.NODE_ENV === 'production' ? 3000 : 3001);
const HOST = '127.0.0.1';

// Configure AWS
AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
  // Falls back to ~/.aws/credentials if env vars not set
});

const s3 = new S3();
const dynamodb = new DynamoDB.DocumentClient();
const lambda = new Lambda();
const ses = new SES({ apiVersion: '2010-12-01' });
const cloudwatch = new CloudWatch();
const exposureLabSecurityMaster = createExposureLabSecurityMaster({
  documentClient: dynamodb,
  tableName: process.env.EXPOSURE_LAB_SECURITY_MASTER_TABLE
    || 'ExposureLabSecurityMasterV1',
  indexName: process.env.EXPOSURE_LAB_SECURITY_MASTER_INDEX
    || 'recordType-sortKey-index',
});

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PORTFOLIO_UPLOAD_BUCKET = 'market-dashboard-csv-data';
const configuredResearchRefreshTimeoutMs = Number(
  process.env.RESEARCH_AUTHORITATIVE_REFRESH_TIMEOUT_MS,
);
const RESEARCH_AUTHORITATIVE_REFRESH_TIMEOUT_MS = Number.isFinite(
  configuredResearchRefreshTimeoutMs,
)
  ? Math.min(120_000, Math.max(5_000, configuredResearchRefreshTimeoutMs))
  : 60_000;

// These caches are deliberately limited to non-live research/status data. Live
// IBKR, portfolio, and quote routes retain their existing freshness policies.
const { inMacroShowWindow, researchRefreshMs } = require('./src/utils/macroShowWindow.cjs');
const researchResponseCache = createAsyncTtlCache({ ttlMs: FIVE_MINUTES_MS, maxEntries: 100 });
const hermesLedgerCache = createAsyncTtlCache({ ttlMs: FIVE_MINUTES_MS, maxEntries: 1 });
const hermesRuntimeStateCache = createAsyncTtlCache({ ttlMs: FIVE_MINUTES_MS, maxEntries: 1 });
const researchEventLedgerCache = createAsyncTtlCache({ ttlMs: FIVE_MINUTES_MS, maxEntries: 10 });
const etfProSnapshotHistoryCache = createAsyncTtlCache({ ttlMs: FIVE_MINUTES_MS, maxEntries: 1 });
const s3ArtifactCache = createAsyncTtlCache({ ttlMs: ONE_DAY_MS, maxEntries: 1_000 });
const gmailPollHealthCache = createAsyncTtlCache({ ttlMs: FIVE_MINUTES_MS, maxEntries: 1 });
const checkpointFirstResearchResponse = createCheckpointFirstResearchResponse({
  cache: researchResponseCache,
  ttlMs: FIVE_MINUTES_MS,
  refreshAheadMs: 4 * 60 * 1000,
  refreshTimeoutMs: RESEARCH_AUTHORITATIVE_REFRESH_TIMEOUT_MS,
});

function setDataCacheHeaders(res, cacheResult) {
  const ageSeconds = Math.max(0, Math.floor((cacheResult.ageMs || 0) / 1000));
  res.setHeader('X-Data-Cache', cacheResult.status);
  res.setHeader('X-Data-Age', String(ageSeconds));
  res.setHeader('Age', String(ageSeconds));
  if (cacheResult.status === 'stale') {
    res.setHeader('Warning', '110 - "Response is stale"');
  }
}

async function sendCachedJson(res, cacheKey, loader) {
  const cacheResult = await researchResponseCache.get(cacheKey, loader);
  setDataCacheHeaders(res, cacheResult);
  return res.json(cacheResult.value);
}

async function sendCheckpointFirstJson(res, options) {
  // Browser/proxy caching would hide a newly completed fail-closed background
  // revalidation. Keep the bounded authoritative cache on the server only.
  setCheckpointFirstNoStoreHeader(res);
  const cacheResult = await checkpointFirstResearchResponse.get(options);
  setDataCacheHeaders(res, cacheResult);
  return res.json(cacheResult.value);
}

// Validate AWS credentials at startup
async function validateAWSCredentials() {
  try {
    // Validate only the project bucket so the runtime identity does not need
    // account-wide s3:ListAllMyBuckets permission.
    await s3.headBucket({ Bucket: PORTFOLIO_UPLOAD_BUCKET }).promise();
    console.log('✅ AWS credentials validated successfully');
    console.log('✅ Project upload storage is accessible');

    return true;
  } catch (error) {
    console.error('❌ AWS credentials validation failed:', error.message);
    console.error('💡 Make sure AWS credentials are configured in ~/.aws/credentials or environment variables');
    return false;
  }
}

// Middleware
// CORS: Allow React dev server (port 3000) in development, or same origin in production
app.use(createLocalTrustMiddleware());
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'JSON request content type is required' });
  }
  next();
});
app.use(cors(createApiCorsOptions()));
app.use(express.json({ limit: '5mb' }));

let analystGatewayProxy = null;
const portfolioResearchCapture = createPortfolioRefreshResearchWorkerService();
const analystRoutes = createAnalystRoutes({
  capturePortfolioResearch: params => portfolioResearchCapture.capture(params),
  getContractStatus: () => analystRuntimeGate.status(),
  s3,
  dynamodb,
  lambda,
  httpClient: axios,
  getRiskRangeStatus: ({ now } = {}) => buildCurrentRiskRangeWorkflowStatus({ now }),
  gatewayStatus: () => analystGatewayProxy?.status?.() || {
    connected: false,
    status: 'starting',
  },
});
app.use('/internal/analyst', analystRoutes.internalRouter);
// Completed-session price, volatility and volume windows beside Inbox alerts.
// Historical research only; the 2y sizing history is shared with the sizing cache.
app.get('/api/analyst/horizon-stats', async (req, res) => {
  const symbols = Array.from(new Set(String(req.query.symbols || '').split(',')
    .map((symbol) => symbol.trim().toUpperCase()).filter(validSecurityRiskMetricsSymbol))).slice(0, 25);
  res.set('Cache-Control', 'no-store');
  // A view of the security record's activity piece; a symbol without verified history is omitted.
  const record = await securityUniverse.load(symbols, { fields: ['activity'] });
  const rows = Object.fromEntries(symbols.map((symbol) => [symbol, record.rows[symbol]?.activity?.horizons])
    .filter(([, field]) => field?.status === 'available').map(([symbol, field]) => [symbol, field.value]));
  res.json({ rows, historicalOnly: true, executable: false });
});
// The stored original of a research email for the Source popover, made inert and with
// the cited ticker marked. Read-only: one ledger query and the cached S3 artifact.
app.get('/api/analyst/source-email/:messageId', async (req, res) => {
  const messageId = String(req.params.messageId || '');
  const term = String(req.query.find || '').toUpperCase();
  if (!SOURCE_EMAIL_ID.test(messageId) || (term && !SOURCE_EMAIL_TERM.test(term))) return res.status(400).json({ error: 'Invalid source email' });
  res.set('Cache-Control', 'no-store');
  try {
    const result = await dynamodb.query({
      TableName: HERMES_EMAIL_LEDGER_TABLE,
      KeyConditionExpression: 'messageId = :messageId',
      ExpressionAttributeValues: { ':messageId': messageId },
    }).promise();
    const item = emailBodyItem(result.Items || []);
    if (!item) return res.status(404).json({ error: 'Source email not stored' });
    res.json({ messageId, ...sourceEmailClip(await getCachedHermesArtifactText(item), term) });
  } catch (error) {
    console.warn('[Analyst] Source email read failed:', messageId, error.message);
    res.status(502).json({ error: 'Source email unavailable' });
  }
});
app.use('/api/analyst', analystRoutes.router);
const analystStagingCleanupTimer = setInterval(() => {
  analystRoutes.cleanupStaging().catch((error) => {
    console.warn('[Analyst] Staging cleanup failed:', error.message);
  });
}, 60 * 60 * 1000);
analystStagingCleanupTimer.unref();

/**
 * Resolve ETF Pro content date + counts from latest.json (handles legacy files without meta.snapshotDate).
 * Uses row asOf (via determineEtfProSnapshotDate), else parsedAt / source file mtime in America/New_York.
 */
function resolveEtfProSnapshotForAnalytics(etf) {
  if (!etf || typeof etf !== 'object') {
    return { snapDate: null, rowCount: 0, scraped: null };
  }
  const parsedAt = etf?.meta?.parsedAt;
  const fileMtime = etf?.meta?.sourceFileMtime;
  const fallbackIso = parsedAt || fileMtime;
  const rows = Array.isArray(etf?.rows) ? etf.rows : [];
  let snapDate = etf?.meta?.snapshotDate;
  if (!snapDate && rows.length > 0) {
    snapDate = determineEtfProSnapshotDate(rows, fallbackIso);
  }
  if (!snapDate && fallbackIso) {
    const d = new Date(fallbackIso);
    if (!Number.isNaN(d.getTime())) {
      snapDate = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    }
  }
  const rowCount = rows.length > 0 ? rows.length : (etf?.meta?.rowCount ?? 0);
  const scraped = parsedAt || fileMtime;
  return { snapDate, rowCount, scraped };
}

function etfProEmailSnapshotToPayload(snapshot) {
  if (!snapshot || snapshot.snapshotType !== 'etf-pro') return null;
  const data = snapshot.data || {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const changes = {
    previousDate: null,
    addedLongs: Array.isArray(data.addedLongs) ? data.addedLongs : [],
    removedLongs: Array.isArray(data.removedLongs) ? data.removedLongs : [],
    addedShorts: Array.isArray(data.addedShorts) ? data.addedShorts : [],
    removedShorts: Array.isArray(data.removedShorts) ? data.removedShorts : [],
  };
  changes.added = [...new Set([...changes.addedLongs, ...changes.addedShorts])];
  changes.removed = [...new Set([...changes.removedLongs, ...changes.removedShorts])];
  const sourceMessageIds = [
    ...(Array.isArray(snapshot.sourceMessageIds) ? snapshot.sourceMessageIds : []),
    snapshot.sourceMessageId,
    snapshot.gmailMessageId,
  ].filter(Boolean);

  return {
    meta: {
      snapshotDate: snapshot.date || null,
      parsedAt: snapshot.scrapedAt || null,
      sourceFile: snapshot.htmlSource || null,
      source: 'gmail-html',
      sourceMessageId: [...new Set(sourceMessageIds)].length === 1
        ? sourceMessageIds[0]
        : null,
      sourceMessageIds: [...new Set(sourceMessageIds)].sort(),
      headline: snapshot.article?.headline || data.headline || null,
      rowCount: rows.length,
    },
    rows,
    changes,
    data,
    article: snapshot.article || null,
  };
}

function classifyEtfProRows(rows = []) {
  const longs = new Set();
  const shorts = new Set();
  for (const row of rows || []) {
    const ticker = String(row.ticker || '').trim().toUpperCase();
    if (!ticker) continue;
    if (String(row.call || '').toLowerCase() === 'short') {
      shorts.add(ticker);
    } else {
      longs.add(ticker);
    }
  }
  return { longs, shorts };
}

function isEtfProActionPayload(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const changes = payload?.changes || {};
  const changeCount =
    (changes.addedLongs?.length || 0) +
    (changes.removedLongs?.length || 0) +
    (changes.addedShorts?.length || 0) +
    (changes.removedShorts?.length || 0);
  const headline = payload?.meta?.headline || '';
  return rows.length > 0 && (changeCount > 0 || /\bNew ETF Pro Changes?\b/i.test(headline));
}

function applyEtfProActionUpdate(basePayload, actionPayload, options = {}) {
  if (!basePayload || !actionPayload) return actionPayload || basePayload || null;
  const baseRows = Array.isArray(basePayload.rows) ? basePayload.rows : [];
  const changes = actionPayload.changes || {};
  const removedLongs = new Set((changes.removedLongs || []).map((t) => String(t).toUpperCase()));
  const removedShorts = new Set((changes.removedShorts || []).map((t) => String(t).toUpperCase()));
  const addedByTicker = new Map(
    (Array.isArray(actionPayload.rows) ? actionPayload.rows : [])
      .filter((row) => String(row.action || '').toUpperCase() === 'ADD')
      .map((row) => [String(row.ticker || '').toUpperCase(), row]),
  );
  const removedButMissing = [];
  const seenRemoved = new Set();
  const nextRows = baseRows.filter((row) => {
    const ticker = String(row.ticker || '').trim().toUpperCase();
    if (!ticker) return true;
    const side = String(row.call || '').toLowerCase() === 'short' ? 'short' : 'long';
    const shouldRemove = side === 'short' ? removedShorts.has(ticker) : removedLongs.has(ticker);
    if (shouldRemove) {
      seenRemoved.add(`${side}:${ticker}`);
      return false;
    }
    return true;
  });

  for (const ticker of removedLongs) {
    if (!seenRemoved.has(`long:${ticker}`)) removedButMissing.push(ticker);
  }
  for (const ticker of removedShorts) {
    if (!seenRemoved.has(`short:${ticker}`)) removedButMissing.push(ticker);
  }

  const existingTickers = new Set(nextRows.map((row) => String(row.ticker || '').toUpperCase()));
  for (const [ticker, row] of addedByTicker.entries()) {
    if (!ticker || existingTickers.has(ticker)) continue;
    nextRows.push({
      id: `${ticker}_${nextRows.length}`,
      etf: row.etf || ticker,
      assetClass: row.assetClass || 'ETF Pro',
      call: row.call || row.side || 'Long',
      ticker,
      dateAdded: actionPayload.meta?.snapshotDate || null,
      riskRangeHigh: row.riskRangeHigh ?? null,
      riskRangeLow: row.riskRangeLow ?? null,
      relativePerformance: null,
      absolutePerformance: null,
      daysHeld: 0,
      sourceAction: 'ADD',
    });
    existingTickers.add(ticker);
  }

  return {
    ...basePayload,
    meta: {
      ...(basePayload.meta || {}),
      snapshotDate: actionPayload.meta?.snapshotDate || basePayload.meta?.snapshotDate || null,
      parsedAt: actionPayload.meta?.parsedAt || basePayload.meta?.parsedAt || null,
      sourceFile: actionPayload.meta?.sourceFile || basePayload.meta?.sourceFile || null,
      sourceMessageId: actionPayload.meta?.sourceMessageId || basePayload.meta?.sourceMessageId || null,
      sourceSequence: actionPayload.meta?.sourceSequence ?? basePayload.meta?.sourceSequence ?? null,
      sourceEventKey: actionPayload.meta?.sourceEventKey || basePayload.meta?.sourceEventKey || null,
      source: options.source || 'gmail-html-applied-to-local-book',
      headline: actionPayload.meta?.headline || null,
      baseSnapshotDate: basePayload.meta?.snapshotDate || null,
      actionCount: Array.isArray(actionPayload.rows) ? actionPayload.rows.length : 0,
      appliedActionDates: [
        ...new Set([
          ...(Array.isArray(basePayload.meta?.appliedActionDates) ? basePayload.meta.appliedActionDates : []),
          actionPayload.meta?.snapshotDate,
        ].filter(Boolean)),
      ],
      rowCount: nextRows.length,
    },
    rows: nextRows.map((row, index) => ({ ...row, id: row.id || `${row.ticker}_${index}` })),
    changes,
    actionRows: actionPayload.rows || [],
    dataQuality: {
      status: removedButMissing.length > 0 ? 'partial' : 'ok',
      removedButMissing,
      warnings: removedButMissing.length > 0
        ? [`ETF Pro remove actions not found in base book: ${removedButMissing.join(', ')}`]
        : [],
    },
  };
}

function loadLocalEtfProPayload() {
  const etfproDir = path.join(__dirname, 'data', 'hedgeye', 'etfpro');
  const latestPath = path.join(etfproDir, 'latest.json');
  if (!fs.existsSync(latestPath)) {
    return { etfproDir, latestPath, payload: null };
  }
  const parsed = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
  const { snapDate: resolvedDate } = resolveEtfProSnapshotForAnalytics(parsed);
  if (resolvedDate && (!parsed.meta || !parsed.meta.snapshotDate)) {
    parsed.meta = { ...(parsed.meta || {}), snapshotDate: resolvedDate };
  }
  return { etfproDir, latestPath, payload: parsed };
}

function getPayloadDate(payload) {
  return payload?.meta?.snapshotDate || null;
}

function sortPayloadsChronologically(payloads) {
  return [...payloads].sort(compareEtfPayloadOrder);
}

function pickNewestPayload(payloads) {
  return sortPayloadsChronologically(payloads).at(-1) || null;
}

function dedupeEtfProActions(payloads) {
  const seen = new Set();
  const result = [];
  for (const payload of payloads) {
    if (!payload) continue;
    const changes = payload.changes || {};
    const signature = JSON.stringify({
      date: payload.meta?.snapshotDate || null,
      headline: payload.meta?.headline || null,
      addedLongs: [...(changes.addedLongs || [])].sort(),
      removedLongs: [...(changes.removedLongs || [])].sort(),
      addedShorts: [...(changes.addedShorts || [])].sort(),
      removedShorts: [...(changes.removedShorts || [])].sort(),
    });
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(payload);
  }
  return result;
}

function isEtfProActionAfterBase(actionPayload, basePayload) {
  const actionDate = getPayloadDate(actionPayload);
  const baseDate = getPayloadDate(basePayload);
  if (!actionDate || !baseDate) return false;
  return compareEtfPayloadOrder(actionPayload, basePayload) > 0;
}

async function getCachedHermesLedgerItems() {
  const cacheResult = await hermesLedgerCache.get('all', () => scanAllPages(dynamodb, {
    TableName: HERMES_EMAIL_LEDGER_TABLE,
  }));
  return requireAuthoritativeCacheValue(cacheResult, {
    errorCode: 'HERMES_LEDGER_CACHE_STALE',
    source: HERMES_EMAIL_LEDGER_TABLE,
  });
}

async function getHermesRuntimeState() {
  const cacheResult = await hermesRuntimeStateCache.get('gmail-runtime-state', async () => {
    const result = await dynamodb.get({
      TableName: HERMES_EMAIL_LEDGER_TABLE,
      Key: {
        messageId: `runtime#gmail#${HERMES_GMAIL_ACCOUNT}`,
        attachmentId: 'history-cursor',
      },
      ConsistentRead: true,
    }).promise();
    return result.Item || null;
  });
  return requireAuthoritativeCacheValue(cacheResult, {
    errorCode: 'HERMES_RUNTIME_STATE_CACHE_STALE',
    source: `${HERMES_EMAIL_LEDGER_TABLE} runtime state`,
  });
}

async function getResearchEventLedgerItems(
  productKey,
  { sinceEventTime = null, limit = 20_000, forceRefresh = false, refreshAfter = null } = {},
) {
  try {
    const cacheKey = `${productKey}:${sinceEventTime || 'all'}:${limit}`;
    const cached = researchEventLedgerCache.peek(cacheKey);
    if (forceRefresh && cached && (!refreshAfter || cached.storedAt < Number(refreshAfter))) {
      researchEventLedgerCache.delete(cacheKey);
    }
    const cacheResult = await researchEventLedgerCache.get(cacheKey, async () => {
      const items = [];
      let exclusiveStartKey;
      do {
        const expressionAttributeNames = { '#productKey': 'productKey' };
        const expressionAttributeValues = { ':productKey': productKey };
        let keyConditionExpression = '#productKey = :productKey';
        if (sinceEventTime) {
          // eventKey is prefixed by the ISO event time, so this is an exact
          // canonical checkpoint floor rather than a best-effort filter.
          expressionAttributeNames['#eventKey'] = 'eventKey';
          expressionAttributeValues[':startEventKey'] = String(sinceEventTime);
          keyConditionExpression += ' AND #eventKey >= :startEventKey';
        }
        const result = await dynamodb.query({
          TableName: RESEARCH_EVENT_LEDGER_TABLE,
          KeyConditionExpression: keyConditionExpression,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ScanIndexForward: true,
          ConsistentRead: false,
          Limit: Math.max(1, Math.min(1_000, Number(limit) || 20_000)),
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }).promise();
        items.push(...(result.Items || []));
        if (items.length >= limit) break;
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
      return items.slice(0, limit);
    });
    if (cacheResult.status === 'stale') {
      return {
        items: [],
        error: 'RESEARCH_EVENT_LEDGER_CACHE_STALE',
      };
    }
    return { items: currentResearchEvents(cacheResult.value || []), error: null };
  } catch (error) {
    // During migration the retained Gmail ledger/S3 archive remains a complete,
    // immutable fallback. Surface the V2 read failure in diagnostics; do not
    // silently substitute daily projections.
    return {
      items: [],
      error: error.code || error.message || 'research-event-ledger-unavailable',
    };
  }
}

function getHermesArtifactVersion(item) {
  return item.dataVersion ||
    item.contentHash ||
    item.s3VersionId ||
    item.versionId ||
    item.etag ||
    item.updatedAt ||
    item.createdAt ||
    item.receivedAt ||
    'unversioned';
}

async function getCachedHermesArtifactText(item) {
  const bucket = item.s3Bucket || HEDGEYE_BUCKET;
  const key = item.s3Key;
  const version = getHermesArtifactVersion(item);
  const cacheKey = JSON.stringify([bucket, key, version]);
  const cacheResult = await s3ArtifactCache.get(cacheKey, async () => {
    const params = { Bucket: bucket, Key: key };
    if (item.s3VersionId) params.VersionId = item.s3VersionId;
    const obj = await s3.getObject(params).promise();
    return obj.Body?.toString('utf8') || '';
  });
  return requireAuthoritativeCacheValue(cacheResult, {
    errorCode: 'HERMES_ARTIFACT_CACHE_STALE',
    source: `Hermes artifact ${key}`,
  });
}

async function getHermesEtfProEmailPayloads() {
  const fullBooks = [];
  const actions = [];
  const rejected = [];
  const items = await getCachedHermesLedgerItems();

  for (const item of items) {
    if (item.status !== 'STORED') continue;
    const subject = item.subject || '';
    const isEtfPro =
      item.reportType === 'etf-pro' ||
      item.snapshotType === 'etf-pro' ||
      /ETF Pro|New ETF Pro Changes?/i.test(subject);
    const isHtmlBody = String(item.mimeType || '').toLowerCase() === 'text/html' &&
      String(item.attachmentId || '').startsWith('message-body-');
    if (!isEtfPro || !isHtmlBody || !item.s3Key) continue;

    let htmlBody = '';
    try {
      htmlBody = await getCachedHermesArtifactText(item);
    } catch (err) {
      console.warn('[ETF Pro] Failed to read Hermes email artifact:', item.s3Key, err.message);
      rejected.push({
        code: 'legacy-artifact-read-failed',
        sourceMessageId: item.messageId || null,
        sourceArtifact: item.s3Key,
        message: err.message,
      });
      continue;
    }

    const fullBook = parseEtfProFullBookEmail(item, htmlBody);
    if (fullBook) {
      fullBooks.push(fullBook);
      continue;
    }

    const action = parseEtfProActionEmail(item, htmlBody);
    if (action) {
      actions.push(action);
      continue;
    }
    if (item.reportType === 'etf-pro' || item.snapshotType === 'etf-pro') {
      rejected.push({
        code: 'legacy-etf-email-unparsed',
        sourceMessageId: item.messageId || null,
        sourceArtifact: item.s3Key,
      });
    }
  }

  return { fullBooks, actions, rejected };
}

function resolveEtfProFromEmailFullBook({ fullBookPayload, actionPayloads }) {
  if (!fullBookPayload) return null;
  const actions = sortPayloadsChronologically(dedupeEtfProActions(actionPayloads))
    .filter((actionPayload) => isEtfProActionAfterBase(actionPayload, fullBookPayload));

  let payload = {
    ...fullBookPayload,
    meta: {
      ...(fullBookPayload.meta || {}),
      source: actions.length > 0 ? 'gmail-html-full-book-applied-actions' : 'gmail-html-full-book',
      baseSnapshotDate: fullBookPayload.meta?.snapshotDate || null,
      appliedActionDates: [],
      rowCount: Array.isArray(fullBookPayload.rows) ? fullBookPayload.rows.length : 0,
    },
    rows: Array.isArray(fullBookPayload.rows) ? fullBookPayload.rows : [],
    dataQuality: { status: 'ok', removedButMissing: [], warnings: [] },
  };

  for (const actionPayload of actions) {
    payload = applyEtfProActionUpdate(payload, actionPayload, {
      source: 'gmail-html-full-book-applied-actions',
    });
  }

  payload.meta = {
    ...(payload.meta || {}),
    source: actions.length > 0 ? 'gmail-html-full-book-applied-actions' : 'gmail-html-full-book',
    baseSnapshotDate: fullBookPayload.meta?.snapshotDate || null,
    rowCount: Array.isArray(payload.rows) ? payload.rows.length : 0,
  };
  return payload;
}

async function getGmailPollHealth() {
  const cacheResult = await gmailPollHealthCache.get('gmail-poll-health', async () => {
    const now = new Date();
    const account = String(
      process.env.HERMES_GMAIL_ACCOUNT || 'timsmithaviation@gmail.com',
    ).trim().toLowerCase();
    const serviceId = `gmail:${account}`;
    const functionName = process.env.HERMES_GMAIL_INGESTOR_FUNCTION
      || GMAIL_SERVICE_DEFINITION?.aws?.functionName
      || 'market-dashboard-gmail-ingestor-v2';
    const [heartbeatStore, metrics] = await Promise.all([
      getServiceHeartbeat(dynamodb, serviceId),
      getLambdaActivity(cloudwatch, functionName, now, 45),
    ]);
    return resolveGmailPollHealth({
      heartbeatStore,
      metrics,
      account,
      now,
      maxAgeMinutes: Number(
        process.env.GMAIL_HEARTBEAT_MAX_AGE_MINUTES
          || GMAIL_SERVICE_DEFINITION?.readinessMaxAgeMinutes
          || 45,
      ),
      expectedScheduleId: process.env.HERMES_GMAIL_SCHEDULE_ID
        || GMAIL_SERVICE_DEFINITION?.aws?.scheduleId
        || 'market-dashboard-gmail-v2-every-15m',
    });
  });
  return failClosedHealthFromCache(cacheResult);
}

async function getResolvedEtfProPayload() {
  const manualCheckpointRecord = loadLocalEtfProCheckpoint();
  const manualCheckpoint = manualCheckpointRecord?.checkpoint || null;
  const manualCheckpointValidation = manualCheckpointRecord?.checkpointValidation || null;
  const manualCheckpointTrust = manualCheckpoint
    ? { ...manualCheckpoint, checkpointValidation: manualCheckpointValidation }
    : null;
  const authoritativeCheckpointTime = manualCheckpointValidation?.valid
    ? manualCheckpoint?.asOf || null
    : null;
  const [emailSnapshots, ingestionHealth, eventLedgerResult, legacyPayloads] = await Promise.all([
    ALLOW_LEGACY_RESEARCH_REBUILD
      ? getEtfProEmailSnapshots()
      : Promise.resolve([]),
    getGmailPollHealth(),
    authoritativeCheckpointTime
      ? getResearchEventLedgerItems('etf-pro', {
        sinceEventTime: authoritativeCheckpointTime,
      })
      : Promise.resolve({ items: [], error: 'ETF_PRO_CHECKPOINT_REQUIRED' }),
    ALLOW_LEGACY_RESEARCH_REBUILD
      ? getHermesEtfProEmailPayloads()
      : Promise.resolve({ fullBooks: [], actions: [], rejected: [] }),
  ]);
  const materializedPayloads = emailSnapshots
    .map(etfProEmailSnapshotToPayload)
    .filter((payload) => Array.isArray(payload?.rows) && payload.rows.length > 0);
  const emailPayload = pickNewestPayload(materializedPayloads);
  const v2Payloads = buildEtfProPayloadsFromResearchEvents(eventLedgerResult.items);
  const manualFullBook = manualCheckpointValidation?.valid
    ? checkpointToEtfProFullBookPayload(manualCheckpoint)
    : null;
  const canonicalFullBooks = [
    ...v2Payloads.fullBooks,
    ...(manualFullBook ? [manualFullBook] : []),
  ];
  const canonicalCoverage = partitionEtfProLegacyCoverage({
    canonicalPayloads: {
      ...v2Payloads,
      fullBooks: canonicalFullBooks,
    },
    legacyPayloads,
    authoritativeCheckpointTime,
  });
  const migratedFullBooks = canonicalCoverage.uncoveredFullBooks;
  const migratedActions = canonicalCoverage.uncoveredActions;
  const replayPayloadCount = canonicalFullBooks.length + v2Payloads.actions.length +
    migratedFullBooks.length + migratedActions.length;
  // A content-hash-verified manual official checkpoint is an explicit
  // canonical coverage floor. ResearchEventLedgerV2 actions strictly newer
  // than that floor remain canonical for subsequent changes.
  const canonicalPayloads = {
    fullBooks: canonicalFullBooks,
    actions: v2Payloads.actions,
  };
  const hermesPayloads = replayPayloadCount > 0
    ? {
      fullBooks: [...canonicalFullBooks, ...migratedFullBooks],
      actions: [...v2Payloads.actions, ...migratedActions],
    }
    : {
      fullBooks: materializedPayloads.filter((payload) => !isEtfProActionPayload(payload)),
      actions: materializedPayloads.filter(isEtfProActionPayload),
    };
  const { etfproDir, latestPath, payload: localPayload } = loadLocalEtfProPayload();
  const migrationRejections = filterLegacyRejectionsByCompleteCanonicalSources(
    legacyPayloads.rejected,
    v2Payloads.completeSourceMessageIds,
  );
  const eventRejections = filterIssuesAfterAuthoritativeCheckpoint(
    [...v2Payloads.rejected, ...migrationRejections],
    authoritativeCheckpointTime,
  );
  const canonicalCoverageGaps = canonicalCoverage.coverageGaps;
  let resolvedPayload = resolveEtfProCanonicalComparison({
    canonicalPayloads,
    referencePayloads: hermesPayloads,
    localPayload,
    emailPayload: replayPayloadCount > 0 ? null : emailPayload,
    ingestionHealth,
    canonicalLedgerError: eventLedgerResult.error,
    canonicalRejections: eventRejections,
    canonicalCoverageGaps,
    authoritativeCheckpoint: manualCheckpointTrust,
  });
  if (resolvedPayload) {
    resolvedPayload = {
      ...resolvedPayload,
      meta: {
        ...(resolvedPayload.meta || {}),
        researchEventSource: manualFullBook
          ? (v2Payloads.selectedEventCount > 0
            ? 'manual-official-checkpoint-with-research-event-ledger-v2'
            : 'manual-official-checkpoint')
          : v2Payloads.selectedEventCount > 0
          ? (migratedFullBooks.length + migratedActions.length > 0
            ? 'research-event-ledger-v2-with-legacy-migration'
            : 'research-event-ledger-v2')
          : 'gmail-ledger-s3-legacy-migration',
        researchEventCount: v2Payloads.selectedEventCount,
        legacyMigrationPayloadCount: migratedFullBooks.length + migratedActions.length,
        researchEventLedgerError: eventLedgerResult.error,
        manualCheckpointId: manualCheckpoint?.id || null,
        manualCheckpointValidation,
        supersededCanonicalCoverageGapCount:
          canonicalCoverage.supersededCoverageGaps?.length || 0,
      },
    };
  }

  return {
    payload: resolvedPayload,
    etfproDir,
    latestPath,
    localPayload,
    emailPayload,
    hermesPayloads,
    canonicalPayloads,
    ingestionHealth,
    eventLedgerResult,
    eventRejections,
    manualCheckpoint: manualCheckpointTrust,
  };
}

async function fetchHermesRtaSnapshots(windowDays, { authoritativeCheckpointTime = null } = {}) {
  const cutoff = new Date(resolveRtaReplayCutoff({
    windowDays,
    checkpointTime: authoritativeCheckpointTime,
  }));
  const eventLedgerResult = authoritativeCheckpointTime
    ? await getResearchEventLedgerItems('real-time-alert', {
      sinceEventTime: authoritativeCheckpointTime,
    })
    : { items: [], error: 'RTA_CHECKPOINT_REQUIRED' };
  const legacy = ALLOW_LEGACY_RESEARCH_REBUILD
    ? await materializeRtaLedgerItems(await getCachedHermesLedgerItems(), {
      cutoff,
      getArtifactText: getCachedHermesArtifactText,
    })
    : { snapshots: [], rejected: [], selectedMessageCount: 0, materializedEventCount: 0 };
  const v2 = materializeRtaResearchEvents(eventLedgerResult.items.filter((item) => {
    const eventTime = new Date(item?.eventTime || '').getTime();
    return !Number.isFinite(eventTime) || eventTime >= cutoff.getTime();
  }));
  return {
    ...mergeRtaMaterializations(v2, legacy, { authoritativeCheckpointTime }),
    eventLedgerError: eventLedgerResult.error,
  };
}

const { loadRtaResolutions } = require('./src/utils/rtaResolutions.cjs');

function loadLocalRtaBenchmark() {
  const benchmarkPath = path.join(__dirname, 'data', 'hedgeye', 'rta', 'latest-benchmark.json');
  if (!fs.existsSync(benchmarkPath)) return null;
  try {
    const benchmark = JSON.parse(fs.readFileSync(benchmarkPath, 'utf8'));
    if (!benchmark || (!Array.isArray(benchmark.longs) && !Array.isArray(benchmark.shorts) && !Array.isArray(benchmark.holdings))) {
      return null;
    }
    const checkpointValidation = validateRtaCheckpoint(benchmark);
    return {
      ...benchmark,
      sourceFile: benchmarkPath,
      checkpointValidation,
    };
  } catch (error) {
    console.warn('[RTA] Failed to read local benchmark:', error.message);
    return null;
  }
}

function loadLocalEtfProCheckpoint() {
  const checkpointPath = path.join(
    __dirname,
    'data',
    'hedgeye',
    'etfpro',
    'latest-checkpoint.json',
  );
  if (!fs.existsSync(checkpointPath)) return null;
  try {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    const checkpointValidation = validateEtfProCheckpoint(checkpoint);
    return {
      checkpoint,
      sourceFile: checkpointPath,
      checkpointValidation,
    };
  } catch (error) {
    console.warn('[ETF Pro] Failed to read local checkpoint:', error.message);
    return null;
  }
}

async function getEtfProEmailSnapshots() {
  const cacheResult = await etfProSnapshotHistoryCache.get('bounded-etf-pro', () =>
    queryLatestSnapshotsByType('etf-pro', { limit: 120 }));
  const snapshots = requireAuthoritativeCacheValue(cacheResult, {
    errorCode: 'ETF_PRO_SNAPSHOT_HISTORY_CACHE_STALE',
    source: 'HedgeyeDailySnapshot ETF Pro history',
  });
  return (snapshots || [])
    .filter((item) => item?.snapshotType === 'etf-pro' && item?.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
      String(a.scrapedAt || '').localeCompare(String(b.scrapedAt || '')));
}

async function getHermesInboxStatus() {
  const defaultStatus = {
    status: 'missing',
    lastRun: null,
    lastUpdated: null,
    storedCount: 0,
    errorCount: 0,
    pendingCount: 0,
    attachmentCount: 0,
    latestFilename: null,
    latestS3Key: null,
    latestStatus: null,
    errorCode: null,
    lastSuccessAt: null,
    historicalBackfill: null,
    nextRun: 'Every 15 minutes',
    source: HERMES_EMAIL_LEDGER_TABLE,
    gmailAccount: HERMES_GMAIL_ACCOUNT,
    gmailQuery: HERMES_GMAIL_QUERY,
  };

  const runtimeState = await getHermesRuntimeState();
  if (!runtimeState) return defaultStatus;

  const counts = runtimeState.counts || {};
  const latestTime = runtimeState.lastSuccessAt || runtimeState.updatedAt || null;
  const storedCount = Number(counts.stored || 0);
  const errorCount = Number(counts.errors || 0);
  const pendingCount = Number(counts.remaining || 0);
  const historicalBackfill = runtimeState.archivedBackfillReasonCode
    ? {
      status: 'archived',
      archivedAt: runtimeState.archivedBackfillAt || null,
      reasonCode: runtimeState.archivedBackfillReasonCode,
      pendingCount: 0,
      retryableCount: 0,
      quarantinedCount: Number(runtimeState.quarantinedCount || 0),
      completedCount: Number(counts.stored || 0),
      totalCount: Number(counts.messages || 0),
    }
    : null;

  let status = 'success';
  // Historical failures remain useful evidence, but they must not permanently
  // poison the current status after a later poll succeeds. Scheduler/auth
  // heartbeat health is evaluated independently by /api/system-readiness.
  if (runtimeState.status === 'AUTH_REQUIRED') {
    status = 'error';
  } else if (runtimeState.status === 'ERROR') {
    status = 'error';
  } else if (runtimeState.status === 'IN_PROGRESS') {
    status = 'warning';
  } else if (runtimeState.status !== 'READY' && storedCount === 0) {
    status = 'missing';
  } else if (latestTime) {
    const ageMs = Date.now() - new Date(latestTime).getTime();
    if (ageMs > 14 * 24 * 60 * 60 * 1000) {
      status = 'stale';
    }
  }

  return {
    ...defaultStatus,
    status,
    lastRun: latestTime,
    lastUpdated: latestTime,
    storedCount,
    errorCount,
    pendingCount,
    attachmentCount: Number(counts.messages || 0),
    latestFilename: null,
    latestS3Key: null,
    latestStatus: runtimeState.status || null,
    errorCode: runtimeState?.errorCode || null,
    lastSuccessAt: runtimeState?.lastSuccessAt || null,
    historicalBackfill,
    gmailAccount: runtimeState.accountEmail || defaultStatus.gmailAccount,
    gmailQuery: runtimeState.query || defaultStatus.gmailQuery,
  };
}

// Performance Routes
const performanceRoutes = require('./src/routes/performance');
app.use('/api/performance', performanceRoutes);

// HedgAI research worker.
const { loadReviewedBaseline } = require('./src/services/hedgaiResearch.cjs');
const { createHedgaiResearchHandlers } = require('./src/routes/hedgaiResearch.cjs');
const { createHedgaiResearchWorkerService } = require('./src/services/hedgaiResearchWorkerService.cjs');
const hedgaiResearchWorker = createHedgaiResearchWorkerService({
  region: process.env.AWS_REGION || 'us-west-1',
  tableName: process.env.RESEARCH_EVENT_LEDGER_TABLE
    || AWS_RESOURCE_DEFAULTS.researchEventLedgerTable || 'ResearchEventLedgerV2',
});
const loadHedgaiResearch = options => hedgaiResearchWorker.loadResearch(options);

// Predictive Markets Review setup board: Hedgeye Tick/Trade/Trend, price and
// Risk Range position for every tracked Kalshi market.
const { createSetupBoardLoader, emailPublishedAt, extraCboeSeries } = require('./src/services/predictionSetupBoard.cjs');
const PREDICTION_EXTRA_CBOE_SERIES = extraCboeSeries();
const predictionRangeHistoryCache = new Map();
// History takes the dashboard alias for an index (SPX for ^GSPC); caret symbols are not accepted there.
const predictionHistorySymbol = (symbol) => (symbol.startsWith('^')
  ? Object.keys(YAHOO_TICKER_MAP).find((key) => YAHOO_TICKER_MAP[key] === symbol) || symbol : symbol);
// The survey consensus changes a few times a month; one read an hour is plenty.
let predictionCpiConsensus = null;
const loadPredictionSetupBoard = createSetupBoardLoader({
  loadRiskRanges: async ({ now }) => {
    const envelope = await loadRiskRangePublicationEnvelope({ now });
    const date = envelope?.manifest?.publicationDate;
    // The Risk Range email's own send time, so Sources reads like the other publications.
    const email = date ? await dynamodb.get({ TableName: 'HedgeyeDailySnapshot',
      Key: { date, snapshotType: 'risk-ranges' }, ProjectionExpression: 'publishedAt, article.bodyText',
    }).promise().then((result) => result.Item, () => null) : null;
    return { ...envelope, publishedAt: emailPublishedAt(email) };
  },
  loadCryptoQuant: () => queryLatestSnapshotsByType('bitcoin-trend-tracker', { limit: 1 }).then((rows) => rows[0] || null),
  loadHedgai: ({ now }) => loadHedgaiResearch({ asOf: now.toISOString() }),
  loadSecurityIntelligence: ({ symbols, now }) => loadCanonicalSecurityIntelligence({
    symbols, now, historyDays: SECURITY_INTELLIGENCE_MAX_HISTORY_DAYS }),
  loadNowcast: () => queryLatestSnapshotsByType('inflation-nowcast', { limit: 1 }).then((rows) => rows[0] || null),
  loadQuotes: async (symbols) => Object.fromEntries((await Promise.all(symbols.map(async (symbol) => {
    const quote = await getQuote(symbol).catch(() => null);
    return quote?.price && isQuoteUsableNow(quote, symbol) ? [symbol, quote] : null;
  }))).filter(Boolean)),
  loadVolatility: async () => ({ ...await volatilitySnapshotService.fetchSnapshot(),
    ...await volatilitySnapshotService.fetchCboeRows(PREDICTION_EXTRA_CBOE_SERIES).catch(() => ({})) }),
  loadUsdCorrelations: () => usdCorrelationService.getSnapshot(),
  loadPeriodReturns: (symbol) => getPeriodReturnsCached(symbol),
  loadKalshiEvents: (series) => require('./src/services/kalshiClient')
    .kalshiFetch('/events', { series_ticker: series, status: 'open', limit: 200 }).then((body) => body?.events || []),
  // A setup's lines with their quotes and resting size, and the account they are sized against. Read-only.
  loadKalshiMarkets: (eventTicker) => require('./src/services/kalshiClient')
    .paginateKalshi('/markets', { event_ticker: eventTicker, status: 'open', limit: 1000 }, 'markets'),
  loadKalshiBalance: () => require('./src/services/kalshiClient').kalshiFetch('/portfolio/balance'),
  // Open positions for the line monitor's held lines and Kalshi book. Read-only.
  loadKalshiPositions: () => require('./src/services/kalshiClient')
    .kalshiFetch('/portfolio/positions', { count_filter: 'position', limit: 1000 }),
  // One line's full order book, so the line monitor can price a bet at what it would actually fill at. Read-only.
  loadKalshiOrderbook: (ticker) => require('./src/services/kalshiClient')
    .kalshiFetch(`/markets/${encodeURIComponent(ticker)}/orderbook`).then((body) => body?.orderbook_fp || body?.orderbook || null),
  // The market date's Hedgeye products, read for Alpha Codes, levels, signals and positions.
  // A product not yet published that morning is simply absent.
  // Crypto Quant is stored as the Bitcoin Trend Tracker; it is only asked for when reading an earlier day.
  loadMorningProducts: async ({ marketDate, products }) => Object.fromEntries((await Promise.all(products.map((product) =>
    dynamodb.get({ TableName: 'HedgeyeDailySnapshot', Key: { date: marketDate,
      snapshotType: product === 'crypto-quant' ? 'bitcoin-trend-tracker' : product } }).promise()
      .then((result) => (result.Item ? [product, result.Item] : null))))).filter(Boolean)),
  loadLatestEditions: async ({ products }) => Object.fromEntries(await Promise.all(products.map((product) =>
    queryLatestSnapshotsByType(product, { limit: 1 }).then((rows) => [product, rows[0] || null])))),
  // Earlier primary Risk Ranges publications, for higher highs and higher lows. Weekdays are
  // probed back from the board's publication; holidays simply have none.
  loadRiskRangeHistory: async ({ before, sessions }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(before || ''))) return [];
    const dates = [];
    for (let day = new Date(`${before}T12:00:00Z`); dates.length < sessions * 2 + 2;) {
      day.setUTCDate(day.getUTCDate() - 1);
      if (day.getUTCDay() % 6 !== 0) dates.push(day.toISOString().slice(0, 10));
    }
    const publications = await Promise.all(dates.map(async (date) => {
      if (!predictionRangeHistoryCache.has(date)) {
        const envelope = await loadRiskRangePublicationEnvelope({ requestedDate: date });
        // A past publication never changes; only a complete one is kept.
        if (envelope?.available) predictionRangeHistoryCache.set(date, { date, ranges: envelope.ranges });
        else return null;
      }
      return predictionRangeHistoryCache.get(date);
    }));
    return publications.filter(Boolean).reverse().slice(-sessions);
  },
  loadCryptoQuantHistory: ({ sessions }) => queryLatestSnapshotsByType('bitcoin-trend-tracker', { limit: sessions })
    .then((rows) => [...rows].reverse()),
  // Highest completed daily high on record for each instrument a range is drawn against.
  loadAllTimeHighs: async (symbols) => Object.fromEntries((await Promise.all(symbols.map(async (symbol) => {
    const record = getTickerMapping(symbol).source === 'fred'
      ? await fetchFredHistoricalData(getTickerMapping(symbol).ticker, 600).then((rows) => (rows || [])
        .reduce((best, row) => (Number.isFinite(row.value) && (!best || row.value > best.value) ? { value: row.value, date: row.date } : best), null))
      : await fetchYahooMaximumAdjustedHistory(predictionHistorySymbol(symbol)).then(({ bars }) => bars
        .reduce((best, bar) => (Number.isFinite(bar.rawHigh) && (!best || bar.rawHigh > best.value) ? { value: bar.rawHigh, date: bar.date } : best), null),
      () => null);
    return record ? [symbol, { ...record, symbol }] : null;
  }))).filter(Boolean)),
  // Daily ETF volume over the last ~200 calendar days, enough for a 90-day average before the latest session.
  loadVolumeHistory: async (symbols) => Object.fromEntries((await Promise.all(symbols.map((symbol) => fetchYahooAdjustedHistory(symbol, {
    cacheScope: 'prediction-volume', period1: String(Math.floor(Date.now() / 1000) - 200 * 86400),
  }).then(({ bars }) => [symbol, bars], () => null)))).filter(Boolean)),
  // Recent daily closes for each market's own price, for its Z-score. Treasury yields read FRED.
  loadPriceHistory: async (symbols) => Object.fromEntries((await Promise.all(symbols.map((symbol) => (getTickerMapping(symbol).source === 'fred'
    ? fetchFredHistoricalData(getTickerMapping(symbol).ticker, 3).then((rows) => (rows || []).map((row) => ({ date: row.date, close: row.value })))
    : fetchYahooMaximumAdjustedHistory(predictionHistorySymbol(symbol)).then(({ bars }) => bars.map((bar) => ({ date: bar.date, close: bar.rawClose }))))
    .then((closes) => [symbol, closes], () => null)))).filter(Boolean)),
  loadCpiConsensus: async () => {
    if (predictionCpiConsensus && Date.now() - predictionCpiConsensus.at < 60 * 60_000) return predictionCpiConsensus.value;
    const value = await loadUsCpiConsensus({ httpClient: axios, requestedAt: Date.now() });
    predictionCpiConsensus = { at: Date.now(), value };
    return value;
  },
  // The archive is constructed later in this file; the board reads it per request.
  loadPublishedStatements: ({ date }) => publishedTradeArchive.loadStatements({ date }),
  // The Analyst's live Alpha Code watch: a broken line reads its Trade or Trend Neutral.
  loadAlphaCodeWatch: () => analystRoutes.dailyWorkflow?.alphaCodeWatch?.() ?? null,
  marketDateFor: (now) => defaultResearchMarketDate(now),
});
// The market day's Alpha Code lines with live prices, for the Analyst's line watch. The
// levels are re-read every few minutes as the morning's products arrive; prices on every call.
const ALPHA_CODE_LEVELS_MS = 5 * 60_000;
let alphaCodeLevels = null;
app.get('/api/analyst/alpha-code-lines', async (req, res) => {
  try {
    const { alphaCodeLines } = require('./src/services/analyst/alphaCodeWatch.cjs');
    const { buildLevelWatch, levelSymbols } = require('./src/services/analyst/marketLevels.cjs');
    const quoted = async (symbol) => {
      const quote = await getQuote(symbol).catch(() => null);
      const price = Number(quote?.price);
      return quote && Number.isFinite(price) && price > 0 && isQuoteUsableNow(quote, symbol) ? { quote, price } : null;
    };
    const now = new Date();
    const marketDate = defaultResearchMarketDate(now);
    if (!alphaCodeLevels || alphaCodeLevels.marketDate !== marketDate || now.getTime() - alphaCodeLevels.at > researchRefreshMs(now.getTime(), ALPHA_CODE_LEVELS_MS)) {
      const [board, statements, marketStructure] = await Promise.all([
        loadPredictionSetupBoard({ now, researchDate: marketDate }),
        publishedTradeArchive.loadStatements({ date: marketDate }).catch(() => null),
        queryLatestSnapshotsByType('market-structure', { limit: 120 }).catch(() => []),
      ]);
      const checks = Object.fromEntries((await Promise.all(levelSymbols(statements).map(async (symbol) => {
        const seen = await quoted(symbol);
        return seen ? [symbol, seen.price] : null;
      }))).filter(Boolean));
      // A restart answers before the archive has loaded; read it again shortly rather than
      // serving five minutes of a watch with no printed codes.
      const archiveRead = statements?.alphaCodes?.length > 0;
      alphaCodeLevels = { at: archiveRead ? now.getTime() : now.getTime() - ALPHA_CODE_LEVELS_MS + 30_000, marketDate,
        ...buildLevelWatch({ marketDate, boardLines: alphaCodeLines(board), statements, marketStructure, prices: checks }) };
      // Market Structure's levels and tiles open the email they were printed in.
      const structureEmail = date => (date ? marketStructureEmailId(date).catch(() => null) : null);
      if (alphaCodeLevels.regime) alphaCodeLevels.regime.messageId = await structureEmail(alphaCodeLevels.regime.date);
      for (const line of alphaCodeLevels.lines.filter(item => item.product === 'market-structure' && !item.messageId)) line.messageId = await structureEmail(line.printedDate);
    }
    const { lines, regime, coverage } = alphaCodeLevels;
    const prices = Object.fromEntries((await Promise.all([...new Set(lines.map((line) => line.symbol))].map(async (symbol) => {
      const seen = await quoted(symbol);
      // A delayed quote keeps the time it was observed, so a break is dated when the price was seen.
      return seen ? [symbol, { price: seen.price, asOf: seen.quote.observedAt || now.toISOString(), source: seen.quote.observation?.source || null,
        delayed: seen.quote.observation?.dataType === 'delayed' }] : null;
    }))).filter(Boolean));
    res.json({ marketDate, lines, prices, regime, coverage });
  } catch (error) {
    console.error('[alpha-code-lines]', error.message);
    res.status(503).json({ error: 'Alpha Code lines unavailable' });
  }
});

// The email a stored product snapshot was read from, for Source links. Editions never change.
const snapshotEmailIds = new Map();
async function snapshotEmailId(snapshotType, date) {
  const key = `${snapshotType}|${date}`;
  if (snapshotEmailIds.has(key)) return snapshotEmailIds.get(key);
  const result = await dynamodb.get({ TableName: 'HedgeyeDailySnapshot', Key: { date, snapshotType }, ProjectionExpression: 'htmlSource' }).promise().catch(() => null);
  const messageId = String(result?.Item?.htmlSource || '').match(/\/messages\/\d{4}-\d{2}-\d{2}\/[^/]+\/([a-f0-9]{8,32})-/i)?.[1] || null;
  if (messageId) snapshotEmailIds.set(key, messageId);
  return messageId;
}
// Market Structure's snapshot does not name its email; the research ledger does. The newest wins.
const marketStructureEmailIds = new Map();
async function marketStructureEmailId(marketDate) {
  if (marketStructureEmailIds.has(marketDate)) return marketStructureEmailIds.get(marketDate);
  const ids = new Set();
  let ExclusiveStartKey;
  do {
    const page = await dynamodb.query({ TableName: 'ResearchEntityEventsV1', IndexName: 'marketDate-index', KeyConditionExpression: '#date = :date', FilterExpression: '#product = :product',
      ProjectionExpression: 'sourceMessageId', ExpressionAttributeNames: { '#date': 'marketDate', '#product': 'productKey' }, ExpressionAttributeValues: { ':date': marketDate, ':product': 'market-structure' },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) }).promise();
    for (const item of page.Items || []) if (item.sourceMessageId) ids.add(item.sourceMessageId);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const messageId = [...ids].sort().at(-1) || null;
  if (messageId) marketStructureEmailIds.set(marketDate, messageId);
  return messageId;
}

// Books for products that are followed in one account only. Go-Anywhere runs in the Roth IRA,
// which the Gateway session does not list, so its holdings come from the newest IBKR activity
// statement: the one statement account that is not the primary (Gateway) account.
app.get('/api/analyst/account-books', (req, res) => {
  try {
    const primary = String(process.env.IBKR_FLEX_EXPECTED_ACCOUNT_ID || '').trim();
    const others = getFlexConfig().expectedAccountIds.filter(accountId => accountId !== primary);
    const roth = primary && others.length === 1 ? readFlexAccountPositions(others[0]) : null;
    res.json({ books: roth ? { 'go-anywhere': { account: 'Roth IRA', asOf: roth.asOf, fetchedAt: roth.fetchedAt,
      positions: roth.positions.map(({ symbol, quantity, marketValue }) => ({ symbol, quantity, marketValue })) } } : {} });
  } catch {
    res.status(503).json({ error: 'Account books unavailable' });
  }
});

// Each held security's published range with a live price, for the Analyst's range watch,
// and what Keith has said about his own size in the last week of Real-Time Alerts.
const RISK_RANGE_NOTES_MS = 5 * 60_000;
const RISK_RANGE_MAX_SYMBOLS = 200;
let riskRangeSizeNotes = null;
app.get('/api/analyst/risk-range-lines', async (req, res) => {
  try {
    const { sizeNotesFromEvents } = require('./src/services/analyst/riskRangeWatch.cjs');
    const { loadStanceLedger } = require('./src/services/analyst/stanceBook.cjs');
    const symbols = [...new Set(String(req.query.symbols || '').split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean))].slice(0, RISK_RANGE_MAX_SYMBOLS);
    const now = new Date();
    const batches = [];
    for (let offset = 0; offset < symbols.length; offset += securityUniverse.MAX_SYMBOLS) batches.push(symbols.slice(offset, offset + securityUniverse.MAX_SYMBOLS));
    const records = await Promise.all(batches.map(batch => securityUniverse.load(batch, { fields: ['research'] }).catch(() => null)));
    const ranges = records.flatMap(record => Object.values(record?.rows || {})).map(({ symbol, research }) => {
      const field = research?.riskRange;
      const [low, high] = [Number(field?.value?.lrr), Number(field?.value?.hrr)];
      // A proxy or unmatched reading is another instrument's range; this security has no bar of its own.
      return field?.status === 'available' && field.match === 'direct' && low > 0 && high > low
        ? { symbol, low, high, source: field.source || null, sourceId: field.sourceId || null, asOf: field.asOf || null, cadence: field.cadence || 'daily', messageId: field.sourceMessageId || null } : null;
    }).filter(Boolean);
    // The printing product's own email (daily sheet, Early Look, Investing Ideas, a tracker), named by its stored copy.
    for (const range of ranges.filter(item => item.sourceId && item.asOf && !item.messageId)) range.messageId = await snapshotEmailId(range.sourceId, range.asOf);
    const prices = Object.fromEntries((await Promise.all(ranges.map(async ({ symbol }) => {
      const quote = await getQuote(symbol).catch(() => null);
      const price = Number(quote?.price);
      return quote && Number.isFinite(price) && price > 0 && isQuoteUsableNow(quote, symbol)
        ? [symbol, { price, asOf: quote.observedAt || now.toISOString(), source: quote.observation?.source || null, delayed: quote.observation?.dataType === 'delayed' }] : null;
    }))).filter(Boolean));
    if (!riskRangeSizeNotes || now.getTime() - riskRangeSizeNotes.at > RISK_RANGE_NOTES_MS) {
      const ledger = await loadStanceLedger(dynamodb, { days: 7, now }).catch(() => null);
      if (ledger) riskRangeSizeNotes = { at: now.getTime(), notes: sizeNotesFromEvents(ledger.events) };
    }
    res.json({ marketDate: defaultResearchMarketDate(now), complete: records.every(Boolean), ranges, prices, sizeNotes: riskRangeSizeNotes?.notes || [] });
  } catch (error) {
    console.error('[risk-range-lines]', error.message);
    res.status(503).json({ error: 'Risk range lines unavailable' });
  }
});

// A security's closes under the range the daily sheet printed for each session; none is carried forward.
const RISK_RANGE_HISTORY_SESSIONS = 60;
app.get('/api/analyst/risk-range-history', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return res.status(400).json({ error: 'symbol is required' });
    const { rangeHistory } = require('./src/services/analyst/riskRangeWatch.cjs');
    const instrument = resolveHistoryInstrument(symbol);
    const [history, daily] = await Promise.all([
      fetchYahooSizingHistory(symbol).catch(() => null),
      dynamodb.query({ TableName: 'RiskRangeData', KeyConditionExpression: 'ticker = :ticker', ExpressionAttributeValues: { ':ticker': symbol } }).promise().then(result => result.Items || []).catch(() => []),
    ]);
    const bars = (history?.bars || []).map(bar => ({ date: String(bar.date || '').slice(0, 10), close: Number(bar.rawClose ?? bar.close ?? bar.adjustedClose) }));
    const rows = rangeHistory({ bars, daily: daily.map(item => ({ date: item.date, low: Number(item.lrr), high: Number(item.hrr) })), sessions: RISK_RANGE_HISTORY_SESSIONS });
    res.json({ symbol, listing: instrument?.yahooSymbol || symbol, rows });
  } catch (error) {
    console.error('[risk-range-history]', error.message);
    res.status(503).json({ error: 'Risk range history unavailable' });
  }
});

// How closely each stock follows the sector ETF it is filed under (?pairs=JACK:XLY,SAIA:XLI),
// on the shared two-year daily bars, and which sector ETF it follows best.
const SECTOR_FIT_MAX_PAIRS = 100;
app.get('/api/analyst/sector-fit', async (req, res) => {
  try {
    const { SECTOR_ETFS, buildSectorFit } = require('./src/utils/exposureLabDiagnostics.cjs');
    const assignments = [...new Map(String(req.query.pairs || '').split(',').map(pair => pair.trim().toUpperCase().split(':'))
      .filter(([symbol, etf]) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol || '') && SECTOR_ETFS.includes(etf))
      .map(([symbol, etf]) => [symbol, { symbol, etf }])).values()].slice(0, SECTOR_FIT_MAX_PAIRS);
    if (assignments.length === 0) return res.status(400).json({ error: 'pairs must list SYMBOL:SECTOR_ETF' });
    const symbols = [...new Set([...assignments.map(item => item.symbol), ...SECTOR_ETFS])];
    const loaded = await mapWithConcurrency(symbols, 6, async symbol => [symbol, (await fetchYahooSizingHistory(symbol).catch(() => null))?.bars || []]);
    res.set('Cache-Control', 'no-store');
    res.json({ historicalOnly: true, executable: false, generatedAt: new Date().toISOString(),
      ...buildSectorFit({ assignments, histories: Object.fromEntries(loaded) }) });
  } catch (error) {
    console.error('[sector-fit]', error.message);
    res.status(503).json({ error: 'Sector fit unavailable' });
  }
});

// The board's sized tickets, kept on paper and scored at settlement. Nothing here places an order.
const predictionPaperLedger = require('./src/services/predictionPaperLedger.cjs').createPaperLedger({ dynamodb,
  loadKalshiMarkets: (eventTicker) => require('./src/services/kalshiClient')
    .paginateKalshi('/markets', { event_ticker: eventTicker, limit: 1000 }, 'markets') });
app.get('/api/prediction-markets/paper-ledger', async (req, res) => {
  try {
    await predictionPaperLedger.settle({ force: req.query.settle === '1' });
    res.json(await predictionPaperLedger.summary({ tickets: req.query.tickets === '1' }));
  } catch (error) {
    console.error('[prediction-paper-ledger]', error.message);
    res.status(503).json({ error: 'Paper ledger unavailable' });
  }
});

// Today's Kalshi fills and settlements for the Analyst's Daily Review. Read-only: two account reads, summed.
const loadPredictionDayActivity = require('./src/services/predictionDayActivity.cjs').createDayActivityLoader({
  loadFills: (floor) => require('./src/services/kalshiClient')
    .paginateKalshi('/portfolio/fills', { min_ts: floor, limit: 200 }, 'fills'),
  loadSettlements: (floor) => require('./src/services/kalshiClient')
    .paginateKalshi('/portfolio/settlements', { min_ts: floor, limit: 200 }, 'settlements') });
app.get('/api/prediction-markets/day-activity', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await loadPredictionDayActivity({ since: String(req.query.since || '') }));
  } catch (error) {
    if (error.statusCode !== 400) console.error('[prediction-day-activity]', error.message);
    res.status(error.statusCode || 503).json({ error: error.statusCode === 400 ? error.message : 'Kalshi activity unavailable' });
  }
});

// ?date=YYYY-MM-DD reads an earlier market day's morning research for the report's date picker.
const predictionResearchBoards = new Map();
app.get('/api/prediction-markets/setup-board', async (req, res) => {
  try {
    const researchDate = String(req.query.date || '');
    if (!researchDate) {
      const board = await loadPredictionSetupBoard({ now: new Date() });
      // Paper record of the sized tickets; a ledger fault never costs the board.
      board.paper = await predictionPaperLedger.record(board).then(() => predictionPaperLedger.settle())
        .then(() => predictionPaperLedger.summary()).then(({ tickets, open, settled, wonTickets, stakedPct, pnlPct, returnOnStake }) =>
          ({ tickets, open, settled, wonTickets, stakedPct, pnlPct, returnOnStake }))
        .catch((error) => { console.error('[prediction-paper-ledger]', error.message); return null; });
      return res.json(board);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(researchDate)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const cached = predictionResearchBoards.get(researchDate);
    if (cached && Date.now() - cached.at < 10 * 60_000) return res.json(cached.board);
    const board = await loadPredictionSetupBoard({ now: new Date(), researchDate });
    predictionResearchBoards.set(researchDate, { at: Date.now(), board });
    if (predictionResearchBoards.size > 20) predictionResearchBoards.delete(predictionResearchBoards.keys().next().value);
    return res.json(board);
  } catch (error) {
    console.error('[prediction-setup-board]', error.message);
    res.status(503).json({ error: 'Setup board unavailable' });
  }
});

// Market / portfolio data providers (IBKR-first, Yahoo fallback)
const compositeMarketDataProvider = require('./src/services/providers/compositeMarketDataProvider');
const yahooMarketDataProvider = require('./src/services/providers/yahoo/yahooMarketDataProvider');
const ibkrStreamBridge = require('./src/services/ibkr/ibkrStreamBridge');
const { createUploadedStatementPortfolioProvider } = require('./src/services/providers/uploadedStatementPortfolioProvider');
const { createCompositePortfolioDataProvider } = require('./src/services/providers/compositePortfolioDataProvider');

const uploadedStatementPortfolioProvider = createUploadedStatementPortfolioProvider(dynamodb);
const portfolioDataProvider = createCompositePortfolioDataProvider(uploadedStatementPortfolioProvider);
app.locals.portfolioDataProvider = portfolioDataProvider;

const { createPcaDataSource } = require('./src/services/pca/pcaData.cjs');
const { createPcaService } = require('./src/services/pca/pcaService.cjs');
const { createPcaRiskRouter } = require('./src/routes/pcaRisk.cjs');
const pcaRiskService = createPcaService({
  dataSource: createPcaDataSource({
    getPortfolioSnapshot: account => portfolioDataProvider.getPortfolioSnapshot(account),
  }),
});
app.use('/api/risk/pca', createPcaRiskRouter({ service: pcaRiskService }));

const providersRoutes = require('./src/routes/providers');
app.use('/api/providers', providersRoutes);

// Import ticker mapping configuration
// Note: Since server.js is CommonJS and securitiesConfig.js is ES6, we'll create a helper function
// that replicates the logic. In the future, consider converting to ES6 modules or creating a shared config.

// In-memory cache for quotes (5-10 second TTL)
const quotesCache = new Map();
const CACHE_TTL = parseInt(process.env.QUOTES_CACHE_TTL || '30000'); // 30 seconds default
const inFlightApiRequests = new Map();

function runInFlight(key, producer) {
  const existing = inFlightApiRequests.get(key);
  if (existing) {
    return existing;
  }

  const request = Promise.resolve()
    .then(producer)
    .finally(() => {
      inFlightApiRequests.delete(key);
    });
  inFlightApiRequests.set(key, request);
  return request;
}

// Cache for historical data (1 hour TTL - changes daily)
const historicalCache = new Map();
const HISTORICAL_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Maximum-history bars are research inputs only. Cache only successful Yahoo
// responses and never serve an expired entry when refresh fails.
const securityRiskMetricsHistoryCache = new Map();
const securityRiskMetricsHistoryInFlight = new Map();
const parsedSecurityRiskMetricsCacheTtl = parseInt(
  process.env.SECURITY_RISK_METRICS_CACHE_TTL_MS || '3600000',
  10,
);
const SECURITY_RISK_METRICS_CACHE_TTL = Number.isFinite(parsedSecurityRiskMetricsCacheTtl)
  ? Math.max(60_000, parsedSecurityRiskMetricsCacheTtl)
  : 60 * 60 * 1000;
const parsedSecurityRiskMetricsCacheMaxEntries = parseInt(
  process.env.SECURITY_RISK_METRICS_CACHE_MAX_ENTRIES || '160',
  10,
);
const SECURITY_RISK_METRICS_CACHE_MAX_ENTRIES = Number.isFinite(parsedSecurityRiskMetricsCacheMaxEntries)
  ? Math.max(10, parsedSecurityRiskMetricsCacheMaxEntries)
  : 160;
const parsedExposureLabHistoryCalendarDays = parseInt(
  process.env.EXPOSURE_LAB_HISTORY_CALENDAR_DAYS || '550',
  10,
);
const EXPOSURE_LAB_HISTORY_CALENDAR_DAYS = Number.isFinite(parsedExposureLabHistoryCalendarDays)
  ? Math.max(400, parsedExposureLabHistoryCalendarDays)
  : 550;

// The universe is rebuilt from the complete persisted Hedgeye archive. Keep a
// short successful-response cache, but never substitute an expired result when
// DynamoDB is unavailable: archive coverage must be explicit and auditable.
const exposureLabUniverseCache = {
  value: null,
  timestamp: 0,
  inFlight: null,
};
const parsedExposureLabUniverseCacheTtl = parseInt(
  process.env.EXPOSURE_LAB_UNIVERSE_CACHE_TTL_MS || '900000',
  10,
);
const EXPOSURE_LAB_UNIVERSE_CACHE_TTL = Number.isFinite(parsedExposureLabUniverseCacheTtl)
  ? Math.max(60_000, parsedExposureLabUniverseCacheTtl)
  : 15 * 60 * 1000;

// Cache for risk ranges (1 hour TTL - changes daily)
const riskRangesCache = new Map();
const RISK_RANGES_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const RISK_RANGES_UNAVAILABLE_CACHE_TTL = 60 * 1000; // retry quickly while a publication is pending/stale/invalid
const RISK_RANGE_MANIFEST_TABLE = process.env.RISK_RANGE_MANIFEST_TABLE
  || AWS_RESOURCE_DEFAULTS.riskRangeManifestTable
  || 'RiskRangePublicationManifestsV2';
const RISK_RANGE_DATA_TABLE = process.env.HEDGEYE_RISK_RANGES_TABLE
  || AWS_RESOURCE_DEFAULTS.riskRangeDataTable
  || 'HedgeyeRiskRanges';
const RESEARCH_EVENT_LEDGER_TABLE = process.env.RESEARCH_EVENT_LEDGER_TABLE
  || AWS_RESOURCE_DEFAULTS.researchEventLedgerTable
  || 'ResearchEventLedgerV2';
const RESEARCH_ENTITY_EVENTS_TABLE = process.env.RESEARCH_ENTITY_EVENTS_TABLE
  || AWS_RESOURCE_DEFAULTS.researchEntityEventsTable
  || 'ResearchEntityEventsV1';
const RESEARCH_PRODUCT_MANIFEST_TABLE = process.env.RESEARCH_PRODUCT_MANIFEST_TABLE
  || AWS_RESOURCE_DEFAULTS.researchProductManifestTable
  || 'ResearchProductManifestsV1';
const RESEARCH_ENTITY_EVENTS_DATE_INDEX = process.env.RESEARCH_ENTITY_EVENTS_DATE_INDEX
  || 'marketDate-index';
const HERMES_EMAIL_LEDGER_TABLE = process.env.HERMES_LEDGER_TABLE
  || AWS_RESOURCE_DEFAULTS.gmailLedgerTable
  || 'HermesEmailIngestLedger';
const HERMES_GMAIL_QUERY = process.env.HERMES_GMAIL_QUERY || 'label:Hedgeye newer_than:30d';
const HERMES_GMAIL_ACCOUNT = process.env.HERMES_GMAIL_ACCOUNT || process.env.HERMES_ACCOUNT_EMAIL || 'timsmithaviation@gmail.com';
const HEDGEYE_SNAPSHOT_INDEX = process.env.HEDGEYE_SNAPSHOT_INDEX
  || 'snapshotType-date-meta-index';
const ALLOW_LEGACY_RESEARCH_REBUILD = String(
  process.env.HERMES_ALLOW_LEGACY_REBUILD || '',
).toLowerCase() === 'true';

async function queryLatestSnapshotsByType(
  snapshotType,
  { limit = 2, projectionExpression = null, expressionAttributeNames = {} } = {},
) {
  const type = String(snapshotType || '').trim();
  if (!type) return [];
  try {
    const params = {
      TableName: 'HedgeyeDailySnapshot',
      IndexName: HEDGEYE_SNAPSHOT_INDEX,
      KeyConditionExpression: '#snapshotType = :snapshotType',
      ExpressionAttributeNames: {
        '#snapshotType': 'snapshotType',
        ...expressionAttributeNames,
      },
      ExpressionAttributeValues: { ':snapshotType': type },
      ScanIndexForward: false,
      Limit: Math.max(1, Math.min(200, Number(limit) || 2)),
    };
    if (projectionExpression) params.ProjectionExpression = projectionExpression;
    const result = await dynamodb.query(params).promise();
    const rows = result.Items || [];
    if (projectionExpression || rows.length === 0) return rows;
    // The bounded index intentionally projects only freshness metadata. Full
    // payload consumers fetch the exact latest keys instead of reading the
    // whole table or storing large research documents in the GSI.
    const keys = rows.map((row) => ({
      date: row.date,
      snapshotType: row.snapshotType,
    }));
    const fullRows = [];
    // BatchGetItem accepts at most 100 keys per request. The bounded ETF Pro
    // history path can request more than one batch, so chunk and retry only
    // DynamoDB's explicitly returned UnprocessedKeys.
    for (let offset = 0; offset < keys.length; offset += 100) {
      let pending = keys.slice(offset, offset + 100);
      for (let attempt = 0; pending.length > 0 && attempt < 4; attempt += 1) {
        const full = await dynamodb.batchGet({
          RequestItems: {
            HedgeyeDailySnapshot: {
              Keys: pending,
              ConsistentRead: false,
            },
          },
        }).promise();
        fullRows.push(...(full.Responses?.HedgeyeDailySnapshot || []));
        pending = full.UnprocessedKeys?.HedgeyeDailySnapshot?.Keys || [];
      }
      if (pending.length > 0) {
        const error = new Error('DynamoDB did not process all Hedgeye snapshot keys');
        error.code = 'HEDGEYE_SNAPSHOT_BATCH_UNPROCESSED';
        throw error;
      }
    }
    if (fullRows.length === 0) return rows;
    // BatchGetItem returns items in no particular order; callers rely on the
    // index's newest-first order (current vs previous edition).
    const rank = new Map(keys.map((key, index) => [key.date, index]));
    return fullRows.sort((a, b) => (rank.get(a.date) ?? Infinity) - (rank.get(b.date) ?? Infinity));
  } catch (error) {
    // During the one-time GSI build (or a local environment without the
    // migration), keep the active path bounded by exact-key reads. Never
    // silently fall back to a table scan.
    if (!['ResourceNotFoundException', 'ValidationException'].includes(error.code)) {
      throw error;
    }
    const rows = [];
    const seenDates = new Set();
    const maxDays = Math.max(14, Number(limit) * 7);
    for (let offset = 0; offset < maxDays && rows.length < limit; offset += 1) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      const dateString = date.toLocaleDateString('en-CA', {
        timeZone: 'America/New_York',
      });
      if (seenDates.has(dateString)) continue;
      seenDates.add(dateString);
      const result = await dynamodb.get({
        TableName: 'HedgeyeDailySnapshot',
        Key: { date: dateString, snapshotType: type },
        ...(projectionExpression
          ? { ProjectionExpression: projectionExpression, ExpressionAttributeNames: expressionAttributeNames }
          : {}),
      }).promise();
      if (result.Item) rows.push(result.Item);
    }
    return rows;
  }
}

async function queryRiskRangePublicationRows(publicationDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(publicationDate || ''))) return [];
  const items = [];
  let exclusiveStartKey;
  do {
    const response = await dynamodb.query({
      TableName: RISK_RANGE_DATA_TABLE,
      KeyConditionExpression: '#date = :date',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':date': publicationDate },
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }).promise();
    items.push(...(response.Items || []));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

async function loadRiskRangePublicationEnvelope({ requestedDate = null, now = new Date() } = {}) {
  const options = {};
  const expectation = expectedRiskRangePublication(now, options);
  const publicationDate = requestedDate || expectation.expectedDate;
  const items = await queryRiskRangePublicationRows(publicationDate);
  const envelope = buildRiskRangeEnvelope(items, {
    now,
    requestedDate,
    minPrimaryCount: Number(process.env.RISK_RANGE_MIN_PRIMARY_COUNT || 30),
    ...options,
  });
  if (requestedDate) return envelope;

  let persistedManifest = null;
  let manifestError = null;
  try {
    persistedManifest = (await dynamodb.get({
      TableName: RISK_RANGE_MANIFEST_TABLE,
      Key: { publicationDate, manifestType: 'primary' },
      ConsistentRead: true,
    }).promise()).Item || null;
  } catch (error) {
    manifestError = error.code || error.message;
  }
  return applyPersistedManifestGate(envelope, items, persistedManifest, {
    now,
    ...expectation,
    manifestError,
  });
}

async function buildCurrentRiskRangeWorkflowStatus({ now = new Date() } = {}) {
  const envelope = await loadRiskRangePublicationEnvelope({ now });
  const manifestAccessDenied = /access.?denied|not authorized/i.test(
    String(envelope.diagnostics?.manifestError || ''),
  );
  return {
    status: envelope.status === 'current'
      ? 'success'
      : envelope.status === 'pending'
        ? 'pending'
        : envelope.status === 'stale'
          ? 'error'
          : envelope.status,
    lastRun: envelope.manifest.publicationDate,
    scrapedAt: envelope.manifest.latestUpdatedAt,
    count: envelope.manifest.decisionRangeCount,
    primaryCount: envelope.manifest.primaryCount,
    supplementalCount: envelope.manifest.supplementalCount,
    expectedDate: envelope.manifest.expectedDate,
    pendingDate: envelope.manifest.pendingDate,
    available: envelope.available,
    errorCode: envelope.diagnostics?.manifestReasons?.includes('manifest-unavailable')
      ? (manifestAccessDenied
        ? 'RISK_RANGE_MANIFEST_ACCESS_DENIED'
        : 'RISK_RANGE_MANIFEST_UNAVAILABLE')
      : envelope.diagnostics?.manifestReasons?.includes('manifest-missing')
        ? 'RISK_RANGE_MANIFEST_MISSING'
        : envelope.diagnostics?.manifestReasons?.length
          ? 'RISK_RANGE_MANIFEST_INVALID'
          : null,
    diagnostics: envelope.diagnostics,
    error: envelope.diagnostics?.manifestError || null,
    nextRun: '8:15 AM ET (market days)',
  };
}

async function buildWorkflowStatusSnapshot() {
  const today = new Date().toISOString().split('T')[0];
  const workflowStatus = {
    hedgeye: {
      status: 'unknown',
      lastRun: null,
      count: 0,
      nextRun: '8:15 AM ET (market days)'
    },
    csvUpload: {
      status: 'unknown',
      lastUpload: null,
      records: 0,
      fileName: null
    },
    hermesInbox: {
      status: 'unknown',
      lastRun: null,
      lastUpdated: null,
      storedCount: 0,
      errorCount: 0,
      pendingCount: 0,
      attachmentCount: 0,
      historicalBackfill: null,
      latestFilename: null,
      latestS3Key: null,
      nextRun: 'Every 15 minutes'
    }
  };

  try {
    workflowStatus.hedgeye = await buildCurrentRiskRangeWorkflowStatus({ now: new Date() });
  } catch (hedgeyeError) {
    console.error('[API] Error fetching Hedgeye status:', hedgeyeError);
    workflowStatus.hedgeye.status = 'error';
    workflowStatus.hedgeye.errorCode = hedgeyeError.code || 'RISK_RANGE_PUBLICATION_CHECK_FAILED';
    workflowStatus.hedgeye.error = hedgeyeError.message;
  }

  try {
    const portfolioResult = await readAllDynamoItems(dynamodb, 'scan', { TableName: 'PortfolioSnapshots' });

    if (portfolioResult.Items && portfolioResult.Items.length > 0) {
      const latest = portfolioResult.Items.sort((a, b) => {
        const dateA = new Date(a.snapshotDate || a.createdAt || 0);
        const dateB = new Date(b.snapshotDate || b.createdAt || 0);
        return dateB - dateA;
      })[0];

      const latestDate = latest.snapshotDate || latest.createdAt;
      const isToday = latestDate && new Date(latestDate).toISOString().split('T')[0] === today;

      workflowStatus.csvUpload = {
        status: isToday ? 'success' : 'stale',
        lastUpload: latestDate,
        records: latest.totalHoldings || latest.holdings?.length || 0,
        fileName: latest.sourceFile || latest.fileName || 'N/A'
      };
    }
  } catch (csvError) {
    console.error('[API] Error fetching CSV upload status:', csvError);
    workflowStatus.csvUpload.status = 'error';
  }

  try {
    workflowStatus.hermesInbox = await getHermesInboxStatus();
  } catch (hermesError) {
    console.error('[API] Error fetching Hermes inbox status:', hermesError);
    workflowStatus.hermesInbox = {
      ...workflowStatus.hermesInbox,
      status: 'error',
      error: hermesError.message,
      source: HERMES_EMAIL_LEDGER_TABLE,
    };
  }

  return workflowStatus;
}

// Cache for intraday sparkline data (5-minute TTL)
const intradayCache = new Map();
const INTRADAY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
// Symbols whose last intraday read returned nothing, with how many in a row.
const intradayUnavailable = new Map();

// FRED Series IDs for Treasury Yields and Rates. Treasury observations are
// dated daily references; they do not advertise intraday chart ranges.
const FRED_SERIES = {
  'UST2Y': 'DGS2',
  'UST5Y': 'DGS5',
  'UST13W': 'DGS3MO',
  'SOFR': 'SOFR',
  'FEDFUNDS': 'DFF',  // Federal Funds Effective Rate
  'IORB': 'IORB',     // Interest on Reserve Balances
  // Credit spreads (ICE BofA Option-Adjusted Spreads, daily, in percent)
  'IG_OAS': 'BAMLC0A0CM',     // US IG Corporate OAS
  'HY_OAS': 'BAMLH0A0HYM2',   // US HY Corporate OAS
};

// Treasury par yield curve tenors. Treasury publishes these the same afternoon;
// FRED's copy (DGS2) trails by a day or more, so FRED is only the fallback.
const TREASURY_PAR_TENORS = {
  'UST2Y': '2 Yr',
};
const TREASURY_PAR_CACHE_TTL = 15 * 60 * 1000;
const treasuryParClosesCache = new Map();

async function fetchTreasuryParDailyCloses(upperSym) {
  const tenor = TREASURY_PAR_TENORS[upperSym];
  if (!tenor) return null;
  const hit = treasuryParClosesCache.get(tenor);
  if (hit && Date.now() - hit.ts < TREASURY_PAR_CACHE_TTL) return hit.data;
  try {
    const rows = await fetchTreasuryParYieldSeries(tenor, { httpGet: axios.get, years: 2 });
    const closes = rows
      ? rows.map((row) => ({ t: Date.parse(`${row.date}T00:00:00Z`), close: row.close }))
      : null;
    if (closes) treasuryParClosesCache.set(tenor, { data: closes, ts: Date.now() });
    return closes;
  } catch (error) {
    console.warn(`[Treasury] par yield fetch failed for ${tenor}:`, error.message);
    return null;
  }
}

async function fetchTreasuryParQuote(upperSym) {
  const closes = await fetchTreasuryParDailyCloses(upperSym);
  if (!closes) return null;
  const latest = closes[closes.length - 1];
  const previous = closes[closes.length - 2];
  const change = latest.close - previous.close;
  return {
    receivedAt: new Date().toISOString(),
    price: latest.close.toFixed(2),
    change: change.toFixed(2),
    changePercent: previous.close > 0 ? ((change / previous.close) * 100).toFixed(2) : '0.00',
    timestamp: new Date(latest.t).toISOString(),
    source: 'us_treasury',
    sourceUrl: TREASURY_PAR_YIELD_URL,
    sourceInstrument: `Daily Treasury par yield curve rate, ${TREASURY_PAR_TENORS[upperSym]}`,
    sourceSeriesId: TREASURY_PAR_TENORS[upperSym],
    observationFrequency: 'daily',
    dataType: 'historical',
    displayOnly: true,
    executable: false,
    warning: 'official_daily_observation',
  };
}

// Treasury yields come from CNBC's Tradeweb feed, which follows the cash market
// through the Asia, London and New York sessions. CBOE's ^TNX/^TYX only print
// 7:20am-2pm CT, and Yahoo has no 2Y index; both stay as fallbacks.
const CNBC_TREASURY_SYMBOLS = {
  'UST2Y': 'US2Y',
  'UST10Y': 'US10Y',
  'UST30Y': 'US30Y',
};
// International 10Y yields read the same CNBC benchmark feed, so every
// sovereign row shares one methodology and same-day timing.
const CNBC_SOVEREIGN_SYMBOLS = {
  'BUND10Y': 'DE10Y-DE',
  'GILT10Y': 'GB10Y-GB',
  'OAT10Y': 'FR10Y-FR',
  'BTP10Y': 'IT10Y-IT',
  'JGB10Y': 'JP10Y-JP',
  'ACGB10Y': 'AU10Y-AU',
  'KTB10Y': 'KR10Y-KR',
  'CAN10Y': 'CA10Y-CA',
};
const cnbcYieldSymbol = (upperSym) => CNBC_TREASURY_SYMBOLS[upperSym] || CNBC_SOVEREIGN_SYMBOLS[upperSym];
const CNBC_QUOTE_URL = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const CNBC_QUOTE_CACHE_TTL = 60 * 1000;
const cnbcTreasuryQuoteCache = new Map();

async function fetchCnbcTreasuryQuote(upperSym) {
  const cnbcSymbol = cnbcYieldSymbol(upperSym);
  if (!cnbcSymbol) return null;
  const hit = cnbcTreasuryQuoteCache.get(cnbcSymbol);
  if (hit && Date.now() - hit.ts < CNBC_QUOTE_CACHE_TTL) return hit.data;
  try {
    const response = await axios.get(CNBC_QUOTE_URL, {
      params: { symbols: cnbcSymbol, requestMethod: 'itv', noform: 1, partnerId: 2, fund: 1, exthrs: 1, output: 'json' },
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const row = response.data?.FormattedQuoteResult?.FormattedQuote?.[0];
    const last = parseFloat(String(row?.last || '').replace('%', ''));
    const previous = parseFloat(String(row?.previous_day_closing || '').replace('%', ''));
    const observedAt = Date.parse(String(row?.last_time || ''));
    if (row?.symbol !== cnbcSymbol || !Number.isFinite(last) || !Number.isFinite(observedAt)) return null;
    const change = Number.isFinite(previous) ? last - previous : null;
    const data = {
      receivedAt: new Date().toISOString(),
      price: last.toFixed(3),
      change: change == null ? null : change.toFixed(3),
      changePercent: change != null && previous > 0 ? ((change / previous) * 100).toFixed(2) : null,
      timestamp: new Date(observedAt).toISOString(),
      // CNBC stamps last_time in the exchange's local time; its date is the trading session.
      sessionDate: String(row.last_time).slice(0, 10),
      source: 'cnbc',
      sourceInstrument: `${row.name || cnbcSymbol} (${row.exchange || 'CNBC'})`,
      sourceSeriesId: cnbcSymbol,
      observationFrequency: 'intraday',
      dataType: 'delayed',
      displayOnly: true,
      executable: false,
      warning: 'delayed_data',
    };
    cnbcTreasuryQuoteCache.set(cnbcSymbol, { data, ts: Date.now() });
    return data;
  } catch (error) {
    console.warn(`[CNBC] Treasury quote fetch failed for ${cnbcSymbol}:`, error.message);
    return null;
  }
}

const CNBC_CHART_URL = 'https://ts-api.cnbc.com/harmony/app/charts/1Y.json';
const CNBC_CLOSES_CACHE_TTL = 15 * 60 * 1000;
const cnbcTreasuryClosesCache = new Map();

// CNBC's 1Y chart carries about two years of daily closes for the same series
// as its quote, so period deltas never mix it with the Treasury par curve.
async function fetchCnbcTreasuryDailyCloses(upperSym) {
  const cnbcSymbol = cnbcYieldSymbol(upperSym);
  if (!cnbcSymbol) return null;
  const hit = cnbcTreasuryClosesCache.get(cnbcSymbol);
  if (hit && Date.now() - hit.ts < CNBC_CLOSES_CACHE_TTL) return hit.data;
  try {
    const response = await axios.get(CNBC_CHART_URL, {
      params: { symbol: cnbcSymbol },
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const bars = response.data?.barData?.priceBars;
    const closes = (Array.isArray(bars) ? bars : [])
      .map((bar) => {
        const day = String(bar?.tradeTime || '');
        return {
          t: Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))),
          close: parseFloat(bar?.close),
        };
      })
      .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.close))
      .sort((left, right) => left.t - right.t);
    if (closes.length < 2) return null;
    cnbcTreasuryClosesCache.set(cnbcSymbol, { data: closes, ts: Date.now() });
    return closes;
  } catch (error) {
    console.warn(`[CNBC] Treasury history fetch failed for ${cnbcSymbol}:`, error.message);
    return null;
  }
}

// CNBC's daily closes stop at the prior session. Extend them with the live
// reading so period and curve deltas end on today, like ^TNX/^TYX.
function withLiveTreasuryClose(closes, liveQuote) {
  if (!Array.isArray(closes) || closes.length === 0 || liveQuote?.source !== 'cnbc') return closes;
  const sessionDay = Date.parse(`${liveQuote.sessionDate}T00:00:00Z`);
  const close = Number(liveQuote.price);
  if (!Number.isFinite(sessionDay) || !Number.isFinite(close) || sessionDay <= closes[closes.length - 1].t) return closes;
  return [...closes, { t: sessionDay, close }];
}

// Registry of international sovereign 10Y symbols. The FRED IDs (OECD monthly
// averages) only identify the symbol for chart and mapping routes; quotes and
// period returns never use them, because a monthly average one to two months
// old reads as a stale daily yield.
const INTL_BOND_FRED_FALLBACK = {
  'BUND10Y': 'IRLTLT01DEM156N',   // Germany
  'GILT10Y': 'IRLTLT01GBM156N',   // UK
  'OAT10Y': 'IRLTLT01FRM156N',    // France
  'BTP10Y': 'IRLTLT01ITM156N',    // Italy
  'JGB10Y': 'IRLTLT01JPM156N',    // Japan
  'ACGB10Y': 'IRLTLT01AUM156N',   // Australia
  'KTB10Y': 'IRLTLT01KRM156N',    // South Korea
  'CAN10Y': 'IRLTLT01CAM156N',     // Canada
};

// Kept for forward compatibility if a keyless Stooq replacement becomes
// available. Empty for now; fetchIntlBondQuote skips Stooq when this is empty.
const STOOQ_BOND_SYMBOLS = {};

const TRADING_ECONOMICS_BOND_COUNTRIES = {
  BUND10Y: ['germany'],
  GILT10Y: ['united kingdom', 'uk'],
  OAT10Y: ['france'],
  BTP10Y: ['italy'],
  JGB10Y: ['japan'],
  ACGB10Y: ['australia'],
  KTB10Y: ['south korea', 'korea'],
  CAN10Y: ['canada'],
};
const TRADING_ECONOMICS_BOND_TTL_MS = 60 * 1000;
let tradingEconomicsBondCache = { expiresAt: 0, promise: null };

const firstFiniteNumber = (...values) => {
  for (const value of values) {
    if (value === '' || value == null) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const firstValidTimestamp = (...values) => {
  for (const value of values) {
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
};

async function fetchTradingEconomicsBondSnapshot() {
  const apiKey = String(process.env.TRADING_ECONOMICS_API_KEY || '').trim();
  if (!apiKey) return new Map();
  const now = Date.now();
  if (tradingEconomicsBondCache.promise && tradingEconomicsBondCache.expiresAt > now) {
    return tradingEconomicsBondCache.promise;
  }

  const promise = axios.get('https://api.tradingeconomics.com/markets/bond', {
    params: { c: apiKey, type: '10Y' },
    timeout: 12_000,
    headers: { 'User-Agent': 'market-dashboard/1.0' },
  }).then((response) => {
    const receivedAt = new Date().toISOString();
    const rows = Array.isArray(response.data) ? response.data : [];
    const bySymbol = new Map();
    Object.entries(TRADING_ECONOMICS_BOND_COUNTRIES).forEach(([symbol, aliases]) => {
      const match = rows.find((row) => {
        const identity = [row?.Country, row?.country, row?.Name, row?.name, row?.Symbol, row?.symbol]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return aliases.some((alias) => identity.includes(alias));
      });
      const price = firstFiniteNumber(match?.Last, match?.last, match?.Close, match?.close);
      const timestamp = firstValidTimestamp(
        match?.Date,
        match?.date,
        match?.LastUpdate,
        match?.lastUpdate,
      );
      if (price == null || !timestamp) return;
      const change = firstFiniteNumber(match?.DailyChange, match?.dailyChange, match?.Change, match?.change);
      const changePercent = firstFiniteNumber(
        match?.DailyPercentualChange,
        match?.dailyPercentualChange,
        match?.PercentChange,
        match?.percentChange,
      );
      bySymbol.set(symbol, {
        receivedAt,
        price: price.toFixed(3),
        change: change == null ? null : change.toFixed(3),
        changePercent: changePercent == null ? null : changePercent.toFixed(3),
        timestamp,
        source: 'trading_economics',
        dataType: 'delayed',
        observationFrequency: 'daily',
        warning: 'delayed_data',
      });
    });
    return bySymbol;
  }).catch((error) => {
    console.warn('[TradingEconomics] Global bond refresh unavailable:', error.message);
    return new Map();
  });

  tradingEconomicsBondCache = {
    expiresAt: now + TRADING_ECONOMICS_BOND_TTL_MS,
    promise,
  };
  return promise;
}

// Yahoo Finance ticker mappings (consolidated from securitiesConfig.js)
// This should match src/constants/securitiesConfig.js YAHOO_TICKER_MAP
const YAHOO_TICKER_MAP = {
  // Indices - US
  'SPX': '^GSPC',
  // SPY remains the ETF identity; the cash index is represented by SPX.
  'SPY': 'SPY',
  'DJI': '^DJI',
  'COMPQ': '^IXIC',
  'IXIC': '^IXIC',
  'RUT': '^RUT',
  'NDX': '^NDX',
  'MID': '^MID',
  'VIX': '^VIX',
  'RVX': '^RVX',
  'VXN': '^VXN',
  'GVZ': '^GVZ',
  'OVX': '^OVX',
  'CRB': '^TRCCRB',
  'SMH': 'SMH',

  // Indices - European
  'STOXX600': '^STOXX',
  'SX5E': '^STOXX50E',
  'DAX': '^GDAXI',
  'FTSE': '^FTSE',
  'CAC': '^FCHI',
  'N100': '^N100',
  'FTSEMIB': 'FTSEMIB.MI',
  'IBEX': '^IBEX',
  'SMI': '^SSMI',

  // Indices - Asian
  'NIKK': '^N225',
  'N225': '^N225',
  'HSI': '^HSI',
  'CSI300': '000300.SS',
  'SSEC': '000001.SS',
  'KOSPI': '^KS11',
  'TAIEX': '^TWII',
  'NIFTY50': '^NSEI',
  'AXJO': '^AXJO',
  'JKSE': '^JKSE',
  'KLSE': '^KLSE',

  // Indices - Other
  'MOVE': '^MOVE',
  'TNX': '^TNX',
  // Treasury yield indices used as rate proxies
  'UST10Y': '^TNX',
  'UST30Y': '^TYX',

  // Currency pairs
  'EUR/USD': 'EURUSD=X',
  'EURUSD': 'EURUSD=X',
  'USD/YEN': 'JPY=X',
  'USDJPY': 'JPY=X',
  'JPY=X': 'JPY=X',
  'GBP/USD': 'GBPUSD=X',
  'GBPUSD': 'GBPUSD=X',
  'CAD/USD': 'CADUSD=X',
  'USDCAD': 'USDCAD=X',
  'AUDUSD': 'AUDUSD=X',
  'USDMXN': 'MXN=X',
  'USDCHF': 'CHF=X',
  'NZDUSD': 'NZDUSD=X',
  'EURGBP': 'EURGBP=X',
  'USDCNY': 'CNY=X',
  'CNY=X': 'CNY=X',
  'USD': 'DX-Y.NYB',
  'DXY': 'DX-Y.NYB',

  // Currency ETFs
  'UUP': 'UUP',
  'FXE': 'FXE',
  'FXY': 'FXY',
  'FXF': 'FXF',
  'FXB': 'FXB',

  // Commodities
  'WTIC': 'CL=F',
  'WTI': 'CL=F',
  'CL': 'CL=F',
  'BRENT': 'BZ=F',
  'BZ': 'BZ=F',
  'NATGAS': 'NG=F',
  'NG': 'NG=F',
  'GOLD': 'GC=F',
  'GC': 'GC=F',
  'SILVER': 'SI=F',
  'SI': 'SI=F',
  'COPPER': 'HG=F',
  'HG': 'HG=F',
  'PLATINUM': 'PL=F',
  'PL': 'PL=F',
  'CORN': 'ZC=F',
  'ZC': 'ZC=F',
  'PALLADIUM': 'PA=F',
  'PA': 'PA=F',
  'WHEAT': 'ZW=F',
  'ZW': 'ZW=F',
  'SOYBEANS': 'ZS=F',
  'ZS': 'ZS=F',
  'RBOB': 'RB=F',
  'RB': 'RB=F',

  // ETFs for market breadth
  'QQQ': 'QQQ',
  'RSP': 'RSP',

  // Crypto
  'BTC': 'BTC-USD',
  'BITCOIN': 'BTC-USD',
  'ETH': 'ETH-USD',
  'ETHEREUM': 'ETH-USD',
  'BNB': 'BNB-USD',
  'ADA': 'ADA-USD',
  'CARDANO': 'ADA-USD',
  'SOL': 'SOL-USD',
  'SOLANA': 'SOL-USD',
  'AVAX': 'AVAX-USD',
  'XRP': 'XRP-USD',
  'DOGE': 'DOGE-USD',
  'LINK': 'LINK-USD',
  'TRX': 'TRX-USD',
  'TRON': 'TRX-USD',
};

const getBackdropCatalogGroup = (groupId) => (
  MARKET_BACKDROP_CATALOG.find((group) => group.id === groupId)
);

const toBackdropIndex = (row) => ({
  symbol: row.symbol,
  name: row.label,
  unit: row.unit || undefined,
  changeUnit: row.changeUnit || undefined,
  country: row.country || undefined,
  ...(row.provider || {}),
});

const getBackdropRegionIndices = (groupId) => (
  (getBackdropCatalogGroup(groupId)?.rows || [])
    .filter((row) => !row.derived)
    .map(toBackdropIndex)
);

const RATE_TAB_LABELS = {
  us_treasuries: 'Treasuries',
  credit: 'Credit',
  eu_sovereigns: 'Europe',
  asia_sovereigns: 'Asia Pacific',
  americas_sovereigns: 'Americas',
};

const buildBackdropRateTabs = () => {
  const rows = getBackdropCatalogGroup('rates')?.rows || [];
  return Object.fromEntries(Object.entries(RATE_TAB_LABELS).map(([tabKey, label]) => [
    tabKey,
    {
      label,
      indices: rows
        .filter((row) => row.tab === tabKey && !row.derived)
        .map(toBackdropIndex),
      derived: rows
        .filter((row) => row.tab === tabKey && row.derived)
        .map((row) => ({
          symbol: row.symbol,
          name: row.label,
          unit: row.unit || 'bps',
          changeUnit: row.changeUnit || 'bps',
          formula: row.derived.formula,
        })),
    },
  ]));
};

// Multi-region market configuration. The active backdrop regions consume the
// same ordered catalog as the UI so provider coverage cannot drift from the
// summary/detail roster.
const MARKET_REGIONS = {
  pulse: {
    label: 'Macro pulse',
    indices: MARKET_PULSE_SUPPLEMENTAL_CATALOG.map(toBackdropIndex)
  },
  us: {
    label: 'US',
    indices: getBackdropRegionIndices('us')
  },
  sectors: {
    label: 'Sectors',
    indices: [
      { symbol: 'XLY', name: 'Consumer Discretionary', yahooSymbol: 'XLY' },
      { symbol: 'XLF', name: 'Financial Select Sector', yahooSymbol: 'XLF' },
      { symbol: 'XLV', name: 'Health Care Select Sector', yahooSymbol: 'XLV' },
      { symbol: 'XLK', name: 'Technology Select Sector', yahooSymbol: 'XLK' },
      { symbol: 'XLP', name: 'Consumer Staples Select Sector', yahooSymbol: 'XLP' },
      { symbol: 'XLI', name: 'Industrial Select Sector', yahooSymbol: 'XLI' },
      { symbol: 'XLB', name: 'Materials Select Sector', yahooSymbol: 'XLB' },
      { symbol: 'XLE', name: 'The Energy Select Sector', yahooSymbol: 'XLE' },
      { symbol: 'XLU', name: 'Utilities Select Sector', yahooSymbol: 'XLU' },
      { symbol: 'XLRE', name: 'Real Estate Select Sector', yahooSymbol: 'XLRE' },
      { symbol: 'XLC', name: 'Communications Services Sector', yahooSymbol: 'XLC' },
      { symbol: 'SPX', name: 'S&P 500', yahooSymbol: '^GSPC', provider: 'yahoo', secType: 'IND' }
    ]
  },
  europe: {
    label: 'Europe',
    indices: getBackdropRegionIndices('europe')
  },
  asia: {
    label: 'Asia',
    indices: getBackdropRegionIndices('asia')
  },
  crypto: {
    label: 'Cryptocurrencies',
    indices: getBackdropRegionIndices('crypto')
  },
  rates: {
    label: 'Rates',
    // `indices` preserved for backwards compatibility with callers that
    // still expect a flat list (and for generic region iteration). The
    // tabbed structure is authoritative for the /api/multi-region-quotes
    // response shape under the `rates` key.
    indices: getBackdropRegionIndices('rates'),
    tabs: buildBackdropRateTabs()
  },
  commodities: {
    label: 'Commodities',
    indices: getBackdropRegionIndices('commodities')
  },
  currencies: {
    label: 'Currencies',
    indices: [
      { symbol: 'EURUSD', name: 'EUR/USD', yahooSymbol: 'EURUSD=X', provider: 'yahoo', secType: 'CASH' },
      { symbol: 'USDJPY', name: 'USD/JPY', yahooSymbol: 'JPY=X', provider: 'yahoo', secType: 'CASH' },
      { symbol: 'GBPUSD', name: 'GBP/USD', yahooSymbol: 'GBPUSD=X', provider: 'yahoo', secType: 'CASH' },
      { symbol: 'AUDUSD', name: 'AUD/USD', yahooSymbol: 'AUDUSD=X', provider: 'yahoo', secType: 'CASH' },
      { symbol: 'USDCAD', name: 'USD/CAD', yahooSymbol: 'USDCAD=X', provider: 'yahoo', secType: 'CASH' },
      { symbol: 'USDMXN', name: 'USD/MXN', yahooSymbol: 'MXN=X', provider: 'yahoo', secType: 'CASH' },
      { symbol: 'USDCHF', name: 'USD/CHF', yahooSymbol: 'CHF=X', provider: 'yahoo', secType: 'CASH' },
      { symbol: 'NZDUSD', name: 'NZD/USD', yahooSymbol: 'NZDUSD=X', provider: 'yahoo', secType: 'CASH' },
      { symbol: 'USDCNY', name: 'USD/CNY', yahooSymbol: 'CNY=X', provider: 'yahoo', secType: 'CASH' },
      { symbol: 'EURGBP', name: 'EUR/GBP', yahooSymbol: 'EURGBP=X', provider: 'yahoo', secType: 'CASH' },
      { symbol: 'USD', name: 'DXY', yahooSymbol: 'DX-Y.NYB', provider: 'yahoo', secType: 'IND' },
      { symbol: 'UUP', name: 'UUP', yahooSymbol: 'UUP' }
    ]
  }
};

// Helper to get ticker mapping (matches securitiesConfig.js logic)
function getTickerMapping(symbol) {
  const upperSymbol = symbol.toUpperCase();

  // Check FRED series first
  if (FRED_SERIES[upperSymbol]) {
    return { source: 'fred', ticker: FRED_SERIES[upperSymbol] };
  }

  if (INTL_BOND_FRED_FALLBACK[upperSymbol]) {
    return { source: 'fred', ticker: INTL_BOND_FRED_FALLBACK[upperSymbol] };
  }

  // Check Yahoo Finance special mappings
  if (YAHOO_TICKER_MAP[upperSymbol]) {
    return { source: 'yahoo', ticker: YAHOO_TICKER_MAP[upperSymbol] };
  }

  // Default: use ticker as-is for Yahoo Finance
  return { source: 'yahoo', ticker: upperSymbol };
}

// The Yahoo instrument behind a dashboard symbol: its listed share class
// (BRK.B → BRK-B) or the instrument the dashboard prices for an alias
// (BTC → BTC-USD, GOLD → GC=F). Daily history, identity and the security
// record all resolve through here, so they describe one instrument.
function resolveHistoryInstrument(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  const mapping = getTickerMapping(normalized);
  if (!normalized || mapping.source !== 'yahoo') return null;
  const listingSymbol = /^[A-Z]{1,5}\.[AB]$/.test(normalized) ? normalized.replace('.', '-') : normalized;
  const yahooSymbol = resolveExposureLabYahooSymbol(normalized, value => (/^[A-Z]{1,5}\.[AB]$/.test(value) ? listingSymbol : mapping.ticker));
  return yahooSymbol ? { yahooSymbol, listingSymbol } : null;
}

const exposureLabSecurityIdentityResolver = createExposureLabSecurityIdentityResolver({
  httpClient: axios,
  secUserAgent: process.env.EXPOSURE_LAB_SEC_USER_AGENT
    || 'market-dashboard/1.0 (local research operator)',
  resolveYahooSymbol: (ticker) => resolveHistoryInstrument(ticker)?.yahooSymbol || null,
});

// ETF Pro's printed range for each ETF it lists, keyed by ticker and dated by the
// full-book edition that printed it. The last good read stands if a refresh fails.
const ETF_PRO_RANGES_MS = 5 * 60_000;
let etfProWeeklyRanges = null;
async function loadEtfProWeeklyRanges() {
  if (etfProWeeklyRanges && Date.now() - etfProWeeklyRanges.at < ETF_PRO_RANGES_MS) return etfProWeeklyRanges.ranges;
  const stale = etfProWeeklyRanges?.ranges || new Map();
  const book = await buildEtfProResponse().catch(() => null);
  const asOf = book?.meta?.baseSnapshotDate || book?.meta?.snapshotDate || null;
  if (!book || book.available === false || book.current === false || !Array.isArray(book.rows) || !asOf) return stale;
  // The full-book edition that printed the ranges, not a later action email applied on top of it.
  const messageId = book.meta?.baseSourceMessageId || book.meta?.sourceMessageId || null;
  const ranges = new Map(book.rows
    .filter(row => row?.ticker && Number(row.trendLowEnd) > 0 && Number(row.trendHighEnd) > Number(row.trendLowEnd))
    .map(row => [String(row.ticker).toUpperCase(), { lrr: Number(row.trendLowEnd), hrr: Number(row.trendHighEnd), asOf, messageId }]));
  etfProWeeklyRanges = { at: Date.now(), ranges };
  return ranges;
}

// The central per-ticker security record. Every loader is a lazy closure: the
// research, archive and analyst services it reads are created later in this file.
const securityUniverse = createSecurityUniverseService({
  resolveInstrument: resolveHistoryInstrument,
  identity: createIdentityPiece({ resolver: exposureLabSecurityIdentityResolver, resolveInstrument: resolveHistoryInstrument }),
  research: createResearchPiece({
    loadSecurityIntelligence: ({ symbols }) => loadCanonicalSecurityIntelligence({ symbols }),
    // The security's own completed close, to check a range is on its scale. Bounded:
    // a slow history provider leaves the check 'not-checked' and keeps warming the
    // shared bar cache instead of holding research back.
    loadReferencePrices: async symbols => {
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 4000); timer.unref?.(); });
      const result = await Promise.race([buildSecurityRiskMetricsResponse({ symbols, sizingOnly: true }).catch(() => null), timeout]);
      clearTimeout(timer);
      const rows = result?.payload?.rows || {};
      return new Map(symbols.map(symbol => [symbol, rows[symbol]?.referencePrice?.status === 'available' ? rows[symbol].referencePrice.value : null]));
    },
    tradeArchiveStatus: () => publishedTradeArchive.status(),
    loadPublishedStatements: () => publishedTradeArchive.loadStatements({ date: defaultResearchMarketDate(new Date()) }),
    loadAlphaCodeWatch: () => analystRoutes.dailyWorkflow?.alphaCodeWatch?.() ?? null,
    loadWeeklyRanges: () => loadEtfProWeeklyRanges(),
  }),
  stance: createStancePiece({ getScoredStanceBook: () => analystRoutes.dailyWorkflow?.scoredStanceBook?.() }),
  marketHistory: createMarketHistoryPiece({
    loadRiskMetrics: async symbols => (await buildSecurityRiskMetricsResponse({ symbols, sizingOnly: true })).payload,
    loadSizingHistory: symbol => fetchYahooSizingHistory(symbol),
    sizingReference: securitySizingReference,
  }),
});

app.get('/api/security-universe', createSecurityUniverseHandler({ service: securityUniverse }));
// Three reviewed labels and risk numbers for the book the Portfolio screen posts (signed % of NAV).
app.post('/api/portfolio/risk-matrix', require('./src/routes/portfolioRiskMatrix.cjs').createPortfolioRiskMatrixHandler({
  classification: require('./src/services/securityUniverse/pieces/classification.cjs').createClassificationPiece(),
  loadHistory: symbol => fetchYahooSizingHistory(symbol),
  mapConcurrent: mapWithConcurrency,
}));
app.get('/api/security-identities', createSecurityIdentitiesHandler({ loadIdentities: symbols => securityUniverse.identities(symbols) }));

function enforceSecurityRiskMetricsCacheCapacity() {
  while (securityRiskMetricsHistoryCache.size > SECURITY_RISK_METRICS_CACHE_MAX_ENTRIES) {
    const oldestKey = securityRiskMetricsHistoryCache.keys().next().value;
    securityRiskMetricsHistoryCache.delete(oldestKey);
  }
}

async function fetchYahooAdjustedHistory(symbol, {
  forceRefresh = false,
  cacheScope = 'maximum',
  period1 = '-2208988800',
  period2 = String(Math.floor(Date.now() / 1000)),
} = {}) {
  const instrument = resolveHistoryInstrument(symbol);
  if (!instrument) {
    const error = new Error(`Yahoo maximum history is unsupported for ${symbol}`);
    error.code = SECURITY_RISK_METRICS_REASONS.UNSUPPORTED_SOURCE;
    throw error;
  }

  const { yahooSymbol } = instrument;
  const cacheKey = `${yahooSymbol.toUpperCase()}::${cacheScope}`;
  const now = Date.now();
  const cached = securityRiskMetricsHistoryCache.get(cacheKey);
  if (!forceRefresh && cached && now - cached.timestamp < SECURITY_RISK_METRICS_CACHE_TTL) {
    securityRiskMetricsHistoryCache.delete(cacheKey);
    securityRiskMetricsHistoryCache.set(cacheKey, cached);
    return {
      ...cached.data,
      cacheStatus: 'hit',
      cacheAgeSeconds: Math.max(0, Math.floor((now - cached.timestamp) / 1000)),
    };
  }
  if (!forceRefresh && cached) securityRiskMetricsHistoryCache.delete(cacheKey);

  const pending = securityRiskMetricsHistoryInFlight.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const { bars, fetchedAt, instrumentType, exchangeTimezone, regularSession } = await fetchYahooAdjustedHistoryData({
      symbol: yahooSymbol, httpClient: axios, period1, period2,
    });
    const data = { bars, yahooSymbol, fetchedAt, instrumentType, exchangeTimezone, regularSession };
    securityRiskMetricsHistoryCache.set(cacheKey, { data, timestamp: Date.now() });
    enforceSecurityRiskMetricsCacheCapacity();
    return { ...data, cacheStatus: 'miss', cacheAgeSeconds: 0 };
  })().finally(() => {
    securityRiskMetricsHistoryInFlight.delete(cacheKey);
  });

  securityRiskMetricsHistoryInFlight.set(cacheKey, request);
  return request;
}

async function fetchYahooMaximumAdjustedHistory(symbol, { forceRefresh = false } = {}) {
  return fetchYahooAdjustedHistory(symbol, {
    forceRefresh,
    cacheScope: 'maximum',
    period1: '-2208988800',
  });
}

// Two years of completed sessions: Position Sizing, the sidecar's sizing reader,
// Inbox horizon stats and the security record share this one cache entry.
async function fetchYahooSizingHistory(symbol, { forceRefresh = false } = {}) {
  return fetchYahooAdjustedHistory(symbol, {
    forceRefresh,
    cacheScope: 'sizing-2y',
    period1: String(Math.floor(Date.now() / 1000) - 2 * 366 * 86400),
  });
}

async function fetchYahooExposureLabAdjustedHistory(symbol, { forceRefresh = false } = {}) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - (EXPOSURE_LAB_HISTORY_CALENDAR_DAYS * 24 * 60 * 60);
  return fetchYahooAdjustedHistory(symbol, {
    forceRefresh,
    cacheScope: `exposure-lab-${EXPOSURE_LAB_HISTORY_CALENDAR_DAYS}d`,
    period1: String(period1),
    period2: String(period2),
  });
}

// Fetch from Yahoo Finance
async function fetchYahooQuote(yahooTicker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}`;
    const params = {
      range: '1d',
      interval: '1d',
      includePrePost: 'false'
    };

    console.log(`[Yahoo Finance] Fetching quote for: ${yahooTicker}`);

    const response = await axios.get(url, {
      params,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    const data = response.data;

    // Check for errors in Yahoo Finance response
    if (data.chart && data.chart.error) {
      console.warn(`[Yahoo Finance] API error for ${yahooTicker}:`, data.chart.error);
      return null;
    }

    if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
      console.warn(`[Yahoo Finance] Invalid response structure for ${yahooTicker}`);
      console.warn(`[Yahoo Finance] Response keys:`, Object.keys(data));
      if (data.chart) {
        console.warn(`[Yahoo Finance] Chart keys:`, Object.keys(data.chart));
      }
      return null;
    }

    const result = data.chart.result[0];

    // Check if result has errors
    if (result.error) {
      console.warn(`[Yahoo Finance] Result error for ${yahooTicker}:`, result.error);
      return null;
    }
    const meta = result.meta || {};
    const isRateProxyTicker = yahooTicker === '^TNX' || yahooTicker === '^TYX';

    // Log available price fields for debugging
    const availablePriceFields = Object.keys(meta).filter(key =>
      key.toLowerCase().includes('price') ||
      key.toLowerCase().includes('close') ||
      key.toLowerCase().includes('previous')
    );
    console.log(`[Yahoo Finance] ${yahooTicker} - Available price fields:`, availablePriceFields);

    // Try multiple price fields in order of preference
    let currentPrice = null;
    let previousClose = null;

    // Try regularMarketPrice first (most common)
    if (meta.regularMarketPrice !== undefined && meta.regularMarketPrice !== null) {
      currentPrice = meta.regularMarketPrice;
      previousClose = meta.previousClose || meta.chartPreviousClose || meta.previousClose || currentPrice;
    }
    // Try chartPreviousClose (for indices and some ETFs)
    else if (meta.chartPreviousClose !== undefined && meta.chartPreviousClose !== null) {
      currentPrice = meta.chartPreviousClose;
      previousClose = meta.previousClose || currentPrice;
    }
    // Try previousClose (fallback)
    else if (meta.previousClose !== undefined && meta.previousClose !== null) {
      currentPrice = meta.previousClose;
      previousClose = currentPrice;
    }
    // Try regularMarketPreviousClose
    else if (meta.regularMarketPreviousClose !== undefined && meta.regularMarketPreviousClose !== null) {
      currentPrice = meta.regularMarketPreviousClose;
      previousClose = currentPrice;
    }
    // Try to get from indicators.quote if available
    else if (result.indicators && result.indicators.quote && result.indicators.quote[0]) {
      const quote = result.indicators.quote[0];
      const closeValues = quote.close || [];
      if (closeValues.length > 0) {
        currentPrice = closeValues[closeValues.length - 1];
        previousClose = closeValues.length > 1 ? closeValues[closeValues.length - 2] : currentPrice;
      }
    }

    if (currentPrice !== null && currentPrice !== undefined) {
      // Ensure previousClose is set
      if (!previousClose) {
        previousClose = currentPrice;
      }

      if (isRateProxyTicker) {
        currentPrice = normalizeCboeTreasuryYield(currentPrice);
        previousClose = normalizeCboeTreasuryYield(previousClose);
      }
      const change = currentPrice - previousClose;
      const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

      console.log(`[Yahoo Finance] Successfully fetched ${yahooTicker}: price=${currentPrice}, change=${change}, source=${availablePriceFields.join(',')}`);

      return {
        price: currentPrice.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        previousClose: previousClose.toFixed(2),
        timestamp: Number.isFinite(meta.regularMarketTime)
          ? new Date(meta.regularMarketTime * 1000).toISOString()
          : null
      };
    } else {
      console.warn(`[Yahoo Finance] No price found in response for ${yahooTicker}`);
      console.warn(`[Yahoo Finance] Meta keys:`, Object.keys(meta));
      console.warn(`[Yahoo Finance] Sample meta data:`, JSON.stringify({
        regularMarketPrice: meta.regularMarketPrice,
        chartPreviousClose: meta.chartPreviousClose,
        previousClose: meta.previousClose,
        regularMarketPreviousClose: meta.regularMarketPreviousClose
      }, null, 2));
      return null;
    }
  } catch (error) {
    console.error(`[Yahoo Finance] Error fetching quote for ${yahooTicker}:`, error.message);
    if (error.response) {
      console.error(`[Yahoo Finance] Response status: ${error.response.status}`);
      console.error(`[Yahoo Finance] Response data:`, error.response.data);
    }
    return null;
  }
}

async function fetchFredQuoteFromCsv(seriesId) {
  try {
    const response = await axios.get('https://fred.stlouisfed.org/graph/fredgraph.csv', {
      params: { id: seriesId },
      timeout: 10000
    });

    const rows = String(response.data || '')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => {
        const [date, value] = line.split(',');
        const parsed = value != null ? parseFloat(value) : NaN;
        return {
          date,
          value: Number.isFinite(parsed) ? parsed : null
        };
      })
      .filter((row) => row.value != null);

    if (rows.length === 0) {
      return null;
    }

    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2] ?? latest;
    const change = latest.value - previous.value;
    const changePercent = previous.value > 0 ? (change / previous.value) * 100 : 0;

    return {
      receivedAt: new Date().toISOString(),
      price: latest.value.toFixed(2),
      change: change.toFixed(2),
      changePercent: changePercent.toFixed(2),
      timestamp: latest.date ? new Date(`${latest.date}T00:00:00Z`).toISOString() : null
    };
  } catch (error) {
    console.error(`[FRED] CSV fallback failed for ${seriesId}:`, error.message);
    return null;
  }
}

// Fetch from FRED API
async function fetchFredQuote(seriesId) {
  try {
    const apiKey = process.env.FRED_API_KEY || '';
    if (!apiKey) {
      console.warn(`[FRED] Warning: FRED_API_KEY environment variable is not set. Falling back to fredgraph CSV for ${seriesId}.`);
      return await fetchFredQuoteFromCsv(seriesId);
    }

    const url = 'https://api.stlouisfed.org/fred/series/observations';
    const params = {
      series_id: seriesId,
      api_key: apiKey,
      file_type: 'json',
      limit: '2', // Get 2 observations to calculate change
      sort_order: 'desc'
    };

    console.log(`[FRED] Fetching quote for: ${seriesId}`);

    const response = await axios.get(url, {
      params,
      timeout: 10000
    });

    const data = response.data;

    if (data.observations && data.observations.length > 0) {
      const obs = data.observations[0];
      if (obs.value && obs.value !== '.') {
        const price = parseFloat(obs.value);
        // For yields, we need previous value to calculate change
        const previousObs = data.observations[1];
        const previousPrice = previousObs && previousObs.value !== '.' ? parseFloat(previousObs.value) : price;
        const change = price - previousPrice;
        const changePercent = previousPrice > 0 ? (change / previousPrice) * 100 : 0;

        console.log(`[FRED] Successfully fetched ${seriesId}: price=${price}, change=${change}`);

        return {
          receivedAt: new Date().toISOString(),
          price: price.toFixed(2),
          change: change.toFixed(2),
          changePercent: changePercent.toFixed(2),
          timestamp: obs.date ? new Date(`${obs.date}T00:00:00Z`).toISOString() : null
        };
      } else {
        console.warn(`[FRED] Invalid value for ${seriesId}:`, obs.value);
      }
    } else {
      console.warn(`[FRED] No observations returned for ${seriesId}`);
    }

    return null;
  } catch (error) {
    console.error(`[FRED] Error fetching quote for ${seriesId}:`, error.message);
    if (error.response) {
      console.error(`[FRED] Response status: ${error.response.status}`);
      console.error(`[FRED] Response data:`, error.response.data);

      // Check if error is related to missing API key
      if (error.response.data && error.response.data.error_message) {
        const errorMsg = error.response.data.error_message.toLowerCase();
        if (errorMsg.includes('api_key') || errorMsg.includes('api key')) {
          console.error(`[FRED] API key error detected. Please set FRED_API_KEY environment variable. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html`);
        }
      }
    }
    return await fetchFredQuoteFromCsv(seriesId);
  }
}

// Fetch last-two EOD bond-yield observations from Stooq (free, daily).
// Returns { price, change, changePercent, timestamp } or null on failure.
async function fetchStooqBondQuote(stooqSymbol) {
  try {
    const url = 'https://stooq.com/q/d/l/';
    const response = await axios.get(url, {
      params: { s: stooqSymbol, i: 'd' },
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const text = String(response.data || '').trim();
    if (!text || text.toLowerCase().includes('no data')) {
      console.warn(`[Stooq] No data for ${stooqSymbol}`);
      return null;
    }

    const lines = text.split('\n').filter((line) => line && !line.startsWith('Date'));
    if (lines.length === 0) return null;

    // Lines: Date,Open,High,Low,Close,Volume
    // Take the last two rows with parseable Close.
    const rows = lines
      .map((line) => {
        const parts = line.split(',');
        if (parts.length < 5) return null;
        const closeNum = parseFloat(parts[4]);
        if (!Number.isFinite(closeNum)) return null;
        return { date: parts[0], close: closeNum };
      })
      .filter(Boolean);

    if (rows.length === 0) return null;

    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2] ?? latest;
    const change = latest.close - previous.close;
    const changePercent = previous.close !== 0 ? (change / previous.close) * 100 : 0;

    console.log(`[Stooq] ${stooqSymbol}: price=${latest.close}, change=${change.toFixed(3)} (${rows.length} rows)`);

    return {
      receivedAt: new Date().toISOString(),
      price: latest.close.toFixed(2),
      change: change.toFixed(2),
      changePercent: changePercent.toFixed(2),
      timestamp: latest.date
        ? new Date(`${latest.date}T00:00:00Z`).toISOString()
        : null
    };
  } catch (error) {
    console.error(`[Stooq] Error fetching ${stooqSymbol}:`, error.message);
    return null;
  }
}

// International sovereign 10Y yields: CNBC's same-day benchmark feed first,
// then a dated official daily history. Quote and period comparisons always
// use the same series. `symbol` is an internal symbol like BUND10Y / JGB10Y.
async function fetchIntlBondQuote(symbol) {
  const upper = symbol.toUpperCase();
  const cnbcQuote = await fetchCnbcTreasuryQuote(upper);
  if (cnbcQuote) return cnbcQuote;
  const official = await fetchOfficialSovereignSeries(upper);
  if (official?.closes?.length) {
    const latest = official.closes[official.closes.length - 1];
    const previous = official.closes[official.closes.length - 2];
    const dailyChange = latestObservationChange(official.closes);
    const hasDailyChange = dailyChange?.interval === 'daily';
    return {
      price: String(latest.close),
      change: hasDailyChange ? String(latest.close - previous.close) : null,
      changePercent: hasDailyChange ? dailyChange.value : null,
      timestamp: new Date(latest.t).toISOString(),
      receivedAt: official.receivedAt,
      source: official.source,
      sourceUrl: official.sourceUrl,
      sourceInstrument: official.sourceInstrument,
      sourceSeriesId: official.seriesId,
      observationFrequency: official.observationFrequency,
      dataType: 'historical',
      displayOnly: true,
      executable: false,
      warning: 'official_daily_observation',
    };
  }
  const tradingEconomicsRows = await fetchTradingEconomicsBondSnapshot();
  const tradingEconomicsQuote = tradingEconomicsRows.get(upper);
  if (tradingEconomicsQuote) return tradingEconomicsQuote;
  const stooqSym = STOOQ_BOND_SYMBOLS[upper];
  if (stooqSym) {
    const stooqQuote = await fetchStooqBondQuote(stooqSym);
    if (stooqQuote) return { ...stooqQuote, source: 'stooq', observationFrequency: 'daily' };
  }
  // No daily source: the overview's retention layer keeps the last dated value.
  return null;
}

// Wire provider layer (Yahoo mapping + FRED/intl bond special quotes)
yahooMarketDataProvider.setTickerMappingResolver(getTickerMapping);
compositeMarketDataProvider.setSpecialQuoteFetcher(async (symbol) => {
  const upperSym = symbol.toUpperCase();
  const isIntlBond =
    STOOQ_BOND_SYMBOLS[upperSym] != null || INTL_BOND_FRED_FALLBACK[upperSym] != null;
  const mapping = getTickerMapping(symbol);
  let quoteData = null;
  if (isIntlBond) {
    quoteData = await fetchIntlBondQuote(upperSym);
  } else if (TREASURY_PAR_TENORS[upperSym]) {
    quoteData = await fetchCnbcTreasuryQuote(upperSym)
      || await fetchTreasuryParQuote(upperSym)
      || await fetchFredQuote(mapping.ticker);
  } else if (CNBC_TREASURY_SYMBOLS[upperSym]) {
    // Null falls through to the Yahoo CBOE index.
    quoteData = await fetchCnbcTreasuryQuote(upperSym);
  } else if (mapping.source === 'fred') {
    quoteData = await fetchFredQuote(mapping.ticker);
  }
  if (quoteData && quoteData.price) {
    const source = quoteData.source || mapping.source;
    const isDatedReference = quoteData.dataType === 'historical' || source === 'fred' || source === 'stooq';
    return {
      legacy: {
        symbol: upperSym,
        ...quoteData,
        source,
        sourceSeriesId: quoteData.sourceSeriesId || (source === 'fred' ? mapping.ticker : null),
        observationFrequency: quoteData.observationFrequency || (source === 'fred' ? 'daily' : null),
        dataType: quoteData.dataType || (isDatedReference ? 'historical' : 'delayed'),
        entitlementStatus: null,
        warning: quoteData.warning || (isDatedReference ? 'historical_observation' : 'delayed_data')
      }
    };
  }
  return null;
});

function isQuoteUsableNow(quote, instrument) {
  if (!buildQuoteMetadata(quote).usable) return false;
  const provider = getProviderStatusSnapshot().ibkr;
  return validateQuoteObservation(quote, { instrument, connected: provider.connected, connectionGeneration: quote.source === 'ibkr' ? provider.connectionGeneration : undefined }).valid;
}

// Fetch quote with caching (IBKR-first via composite provider)
async function getQuote(symbolOrInstrument) {
  const now = Date.now();
  const symbol = typeof symbolOrInstrument === 'object'
    ? String(symbolOrInstrument.symbol || '').toUpperCase()
    : String(symbolOrInstrument || '').toUpperCase();
  const cacheKey = instrumentCacheKey(symbolOrInstrument);

  const cachedQuote = getFreshCachedQuote(quotesCache, cacheKey, now, CACHE_TTL);
  if (cachedQuote) {
    if (isQuoteUsableNow(cachedQuote, symbolOrInstrument)) {
      return cachedQuote;
    }
    quotesCache.delete(cacheKey);
  }

  if (ibkrStreamBridge.STREAM_ENABLED && canUseSymbolStream(symbolOrInstrument)) {
    const streamLegacy = ibkrStreamBridge.getCachedLegacy(symbol);
    if (streamLegacy && streamLegacy.price && isQuoteUsableNow(streamLegacy, symbolOrInstrument)) {
      quotesCache.set(cacheKey, { data: streamLegacy, timestamp: now });
      return streamLegacy;
    }
  }

  try {
    const quoteResult = await scheduleQuoteFetch(cacheKey, () => compositeMarketDataProvider.getQuote(symbolOrInstrument));
    const quoteMeta = buildQuoteMetadata(quoteResult);
    if (quoteMeta.usable && isQuoteUsableNow(quoteResult, symbolOrInstrument)) {
      quotesCache.set(cacheKey, { data: quoteResult, timestamp: Date.now() });
      return quoteResult;
    }
  } catch (error) {
    console.error(`[Quote] Error fetching quote for ${symbol}:`, error.message);
  }

  return null;
}

// Fetch intraday data for sparklines (5-minute intervals, last 50 points)
async function getIntradayData(symbol, range = '1d') {
  const mapping = getTickerMapping(symbol);
  // FRED observations are dated daily references; never substitute a
  // Yahoo intraday series for them (notably UST2Y/DGS2).
  if (mapping.source !== 'yahoo') return [];

  const cacheKey = `intraday:${symbol.toUpperCase()}`;

  // Check cache
  const cached = intradayCache.get(cacheKey);
  if (cached) return cached;

  // A symbol whose last read returned nothing is not asked for again on every
  // poll: each such request can wait out the full timeout.
  const missed = intradayUnavailable.get(cacheKey);
  if (missed && Date.now() - missed.ts < unavailableRetryMs(missed.misses, INTRADAY_CACHE_TTL)) {
    return [];
  }
  const rememberMiss = () => {
    intradayUnavailable.set(cacheKey, { ts: Date.now(), misses: (missed?.misses || 0) + 1 });
    return [];
  };

  try {
    const upperSymbol = symbol.toUpperCase();
    const isRateProxy = upperSymbol === 'UST10Y' || upperSymbol === 'UST30Y';

    const yahooSymbol = mapping.ticker;

    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?range=${range}&interval=5m`;

    const response = await axios.get(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const result = response.data?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]?.close) {
      console.warn(`[IntradayData] No valid data for ${symbol}`);
      return rememberMiss();
    }

    const closePrices = result.indicators.quote[0].close;

    // Extract last 50 data points for sparkline, filter out null values
    const sparklineData = closePrices
      .filter(price => price !== null && price !== undefined)
      .slice(-50)
      .map(price => {
        const n = isRateProxy ? normalizeCboeTreasuryYield(price) : price;
        return parseFloat(Number(n).toFixed(2));
      });

    // Cache for 5 minutes
    intradayCache.set(cacheKey, sparklineData);
    intradayUnavailable.delete(cacheKey);
    setTimeout(() => {
      intradayCache.delete(cacheKey);
    }, INTRADAY_CACHE_TTL).unref();

    return sparklineData;
  } catch (error) {
    console.error(`[IntradayData] Failed to fetch for ${symbol}:`, error.message);
    return rememberMiss();
  }
}

// Legacy endpoints explicitly report unavailable without fabricated market observations.
const fetchVolatilityData = async (symbol) => {
  const quote = await getQuote(symbol);
  const usable = quote && isQuoteUsableNow(quote, symbol);
  return {
    observation: usable ? quote.observation : null,
    observedAt: usable ? quote.observedAt : null,
    receivedAt: usable ? quote.receivedAt : null,
    expiresAt: usable ? quote.expiresAt : null,
    current: usable ? quote.price : null,
    change: usable ? quote.change : null,
    changePercent: usable ? quote.changePercent : null,
    timestamp: usable ? quote.timestamp : null,
    source: usable ? quote.source : null,
    dataType: usable ? quote.dataType : null,
    status: usable ? 'available' : 'unavailable',
    warning: usable ? quote.warning : 'No verified market observation available',
    high: null, low: null, open: null, volume: null,
  };
};

const fetchVIXData = async () => fetchVolatilityData('^VIX');

// Cache hits resolve immediately. Provider misses are deduplicated and bounded by identity.
async function batchProcess(items, _batchSize, _delayMs, processor) {
  return Promise.all(items.map(processor));
}

// API Routes
app.get('/api/quotes', async (req, res) => {
  const startTime = Date.now();
  try {
    if (req.query.symbols !== undefined && typeof req.query.symbols !== 'string') return res.status(400).json({ error: 'symbols must be a comma-separated string' });
    const symbols = [...new Set((req.query.symbols ? req.query.symbols.split(',') : ['SPY', 'QQQ', 'AAPL']).map(symbol => symbol.trim().toUpperCase()).filter(Boolean))];
    if (symbols.length > 100 || symbols.some(symbol => symbol.length > 80)) return res.status(400).json({ error: 'At most 100 valid symbols are supported' });
    const requestKey = `GET /api/quotes?symbols=${symbols.map(s => s.trim()).join(',')}`;
    const quotes = await runInFlight(requestKey, async () => {
      console.log(`[API] /api/quotes called with ${symbols.length} symbols:`, symbols.slice(0, 5), '...');

      const quoteMap = {};

      // Process in batches to avoid rate limiting
      // Yahoo Finance can be sensitive to rate limiting, so we'll do smaller batches with longer delays
      const BATCH_SIZE = 5; // Reduced from 10 to avoid rate limiting
      const DELAY_MS = 200; // Increased from 100ms to 200ms between batches

      const fetchStartTime = Date.now();
      const results = await batchProcess(
        symbols.map(s => s.trim()),
        BATCH_SIZE,
        DELAY_MS,
        async (symbol) => {
          try {
            return await getQuote(symbol);
          } catch (error) {
            console.error(`[API] Error fetching quote for ${symbol}:`, error.message);
            return null;
          }
        }
      );
      const fetchTime = Date.now() - fetchStartTime;
      console.log(`[API] Quote fetching completed in ${fetchTime}ms`);

      // Map results back to symbols
      let successCount = 0;
      let failCount = 0;
      symbols.forEach((symbol, index) => {
        const quote = results[index];
        if (quote && quote.price) {
          quoteMap[symbol.trim().toUpperCase()] = quote;
          successCount++;
        } else {
          failCount++;
          if (failCount <= 10) { // Log first 10 failures
            console.warn(`[API] No quote data for ${symbol}`);
          }
        }
      });

      const totalTime = Date.now() - startTime;
      console.log(`[API] /api/quotes completed: ${successCount} quotes out of ${symbols.length} requested (${failCount} failed) in ${totalTime}ms`);
      return quoteMap;
    });

    // One slow symbol must not cause an earlier observation to age into the response.
    for (const [symbol, quote] of Object.entries(quotes)) {
      if (!isQuoteUsableNow(quote, symbol)) delete quotes[symbol];
    }
    res.json(quotes);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/quotes after ${totalTime}ms:`, error);
    console.error('[API] Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to fetch quotes', details: error.message });
  }
});

// Chart Data endpoint - fetches OHLC data for expanded market charts
// Cache for chart data with different TTLs based on range
const chartDataCache = new Map();

app.get('/api/chart-data/:symbol', async (req, res) => {
  const startTime = Date.now();
  const { symbol } = req.params;
  const { range = '1d' } = req.query;

  // Validate range parameter
  const validRanges = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y'];
  if (!validRanges.includes(range)) {
    return res.status(400).json({ error: `Invalid range. Must be one of: ${validRanges.join(', ')}` });
  }

  // Determine interval based on range
  const intervalMap = {
    '1d': '5m',
    '5d': '15m',
    '1mo': '1h',
    '3mo': '1d',
    '6mo': '1d',
    '1y': '1d',
    '2y': '1d'
  };
  const interval = intervalMap[range];

  // Cache TTL based on range (shorter for intraday, longer for historical)
  // Client-side caching handles more frequent updates, so server cache can be longer
  const cacheTTLMap = {
    '1d': 2 * 60 * 1000,    // 2 minutes for intraday (client caches 30s)
    '5d': 10 * 60 * 1000,   // 10 minutes (client caches 1 min)
    '1mo': 15 * 60 * 1000,  // 15 minutes (client caches 5 min)
    '3mo': 30 * 60 * 1000,  // 30 minutes (client caches 5 min)
    '6mo': 60 * 60 * 1000,  // 1 hour (client caches 10 min)
    '1y': 60 * 60 * 1000,   // 1 hour (client caches 10 min)
    '2y': 60 * 60 * 1000    // 1 hour
  };
  const cacheTTL = cacheTTLMap[range];

  // Resolve the source before consulting the chart cache. This prevents a
  // previously cached proxy series from reintroducing intraday ranges after a
  // symbol is corrected to a dated FRED observation (UST2Y/DGS2).
  const mapping = getTickerMapping(symbol);
  const upperSym = symbol.toUpperCase();
  const isRateProxy = upperSym === 'UST10Y' || upperSym === 'UST30Y';
  if (mapping.source === 'fred' && !isRateProxy && (range === '1d' || range === '5d')) {
    return res.json({
      symbol: upperSym,
      name: upperSym,
      error: 'Intraday data not available for Treasury yields',
      availableRanges: ['1mo', '3mo', '6mo', '1y', '2y'],
      chartData: []
    });
  }

  const cacheKey = `chart:${symbol.toUpperCase()}:${range}`;

  // Check cache
  const cached = chartDataCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < cacheTTL) {
    console.log(`[ChartData] Cache hit for ${cacheKey}`);
    return res.json(cached.data);
  }

  try {
    // Check if this is a FRED symbol (Treasury yields)
    // UST2Y is an explicitly daily FRED observation. UST10Y/UST30Y remain
    // Yahoo yield-index proxies for the compact current-market surface.
    if (mapping.source === 'fred' && !isRateProxy) {
      // Fetch FRED historical data
      const fredData = await fetchFREDHistorical(mapping.ticker, range);
      if (fredData) {
        const responseData = {
          symbol: symbol.toUpperCase(),
          name: symbol.toUpperCase(),
          source: 'fred',
          current: fredData.current,
          ohlc: null, // FRED doesn't provide OHLC
          chartData: fredData.chartData,
          meta: {
            currency: 'USD',
            dataSource: 'FRED',
            range,
            interval: '1d'
          }
        };

        // Cache the result
        chartDataCache.set(cacheKey, { data: responseData, timestamp: Date.now() });
        return res.json(responseData);
      }
    }

    // Yahoo Finance data
    const yahooSymbol = mapping.source === 'yahoo' ? mapping.ticker : symbol;
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${interval}&includePrePost=false`;

    console.log(`[ChartData] Fetching ${url}`);

    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const result = response.data?.chart?.result?.[0];
    if (!result) {
      return res.status(404).json({ error: `No chart data found for ${symbol}` });
    }

    const meta = result.meta || {};
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};

    // Build chart data array
    const chartData = timestamps.map((ts, i) => ({
      timestamp: ts * 1000, // Convert to milliseconds
      open: quote.open?.[i] != null ? scaleRateProxyValue(quote.open[i], isRateProxy) : null,
      high: quote.high?.[i] != null ? scaleRateProxyValue(quote.high[i], isRateProxy) : null,
      low: quote.low?.[i] != null ? scaleRateProxyValue(quote.low[i], isRateProxy) : null,
      close: quote.close?.[i] != null ? scaleRateProxyValue(quote.close[i], isRateProxy) : null,
      volume: quote.volume?.[i] ?? null
    })).filter(d => d.close !== null); // Filter out null closes

    // Get current day's OHLC from meta
    const currentPriceRaw = meta.regularMarketPrice ?? meta.previousClose;
    const previousCloseRaw = meta.chartPreviousClose ?? meta.previousClose;
    const currentPrice = currentPriceRaw != null ? scaleRateProxyValue(currentPriceRaw, isRateProxy) : null;
    const previousClose = previousCloseRaw != null ? scaleRateProxyValue(previousCloseRaw, isRateProxy) : null;
    const change = currentPrice && previousClose ? currentPrice - previousClose : null;
    const changePercent = currentPrice && previousClose ? ((change / previousClose) * 100) : null;

    // Find today's OHLC from chart data (last trading day)
    const todayData = chartData.length > 0 ? chartData[chartData.length - 1] : null;

    const responseData = {
      symbol: symbol.toUpperCase(),
      name: meta.shortName || meta.symbol || symbol.toUpperCase(),
      source: 'yahoo',
      current: {
        price: currentPrice != null ? currentPrice.toFixed(2) : null,
        change: change != null ? change.toFixed(2) : null,
        changePercent: changePercent != null ? changePercent.toFixed(2) : null,
        previousClose: previousClose != null ? previousClose.toFixed(2) : null
      },
      ohlc: {
        open: (() => {
          const raw = meta.regularMarketOpen ?? todayData?.open ?? null;
          if (raw == null) return null;
          const v = isRateProxy && meta.regularMarketOpen != null ? scaleRateProxyValue(raw, true) : raw;
          return Number(v).toFixed(2);
        })(),
        high: (() => {
          const raw = meta.regularMarketDayHigh ?? todayData?.high ?? null;
          if (raw == null) return null;
          const v = isRateProxy && meta.regularMarketDayHigh != null ? scaleRateProxyValue(raw, true) : raw;
          return Number(v).toFixed(2);
        })(),
        low: (() => {
          const raw = meta.regularMarketDayLow ?? todayData?.low ?? null;
          if (raw == null) return null;
          const v = isRateProxy && meta.regularMarketDayLow != null ? scaleRateProxyValue(raw, true) : raw;
          return Number(v).toFixed(2);
        })(),
        close: currentPrice != null ? currentPrice.toFixed(2) : null
      },
      chartData,
      meta: {
        currency: meta.currency || 'USD',
        exchangeTimezone: meta.exchangeTimezoneName || meta.timezone,
        regularMarketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
        range,
        interval,
        dataPoints: chartData.length
      }
    };

    // Cache the result
    chartDataCache.set(cacheKey, { data: responseData, timestamp: Date.now() });

    const totalTime = Date.now() - startTime;
    console.log(`[ChartData] ${symbol} (${range}) completed in ${totalTime}ms with ${chartData.length} data points`);

    res.json(responseData);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[ChartData] Error fetching ${symbol} after ${totalTime}ms:`, error.message);
    res.status(500).json({ error: 'Failed to fetch chart data', details: error.message });
  }
});

// Helper function to fetch FRED historical data for charts
async function fetchFREDHistorical(seriesId, range) {
  try {
    const fredApiKey = process.env.FRED_API_KEY;
    if (!fredApiKey) {
      console.warn('[FRED] No API key configured');
      return null;
    }

    // Calculate start date based on range
    const endDate = new Date();
    const startDate = new Date();
    switch (range) {
      case '1mo': startDate.setMonth(startDate.getMonth() - 1); break;
      case '3mo': startDate.setMonth(startDate.getMonth() - 3); break;
      case '6mo': startDate.setMonth(startDate.getMonth() - 6); break;
      case '1y': startDate.setFullYear(startDate.getFullYear() - 1); break;
      case '2y': startDate.setFullYear(startDate.getFullYear() - 2); break;
      default: startDate.setMonth(startDate.getMonth() - 1);
    }

    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${fredApiKey}&file_type=json&observation_start=${startDate.toISOString().split('T')[0]}&observation_end=${endDate.toISOString().split('T')[0]}`;

    const response = await axios.get(url, { timeout: 10000 });
    const observations = response.data?.observations || [];

    if (observations.length === 0) return null;

    const chartData = observations
      .filter(obs => obs.value !== '.')
      .map(obs => ({
        timestamp: new Date(obs.date).getTime(),
        open: null,
        high: null,
        low: null,
        close: parseFloat(obs.value),
        volume: null
      }));

    const latestValue = chartData.length > 0 ? chartData[chartData.length - 1].close : null;
    const previousValue = chartData.length > 1 ? chartData[chartData.length - 2].close : null;
    const change = latestValue && previousValue ? latestValue - previousValue : null;
    const changePercent = latestValue && previousValue ? ((change / previousValue) * 100) : null;

    return {
      current: {
        price: latestValue?.toFixed(2) ?? null,
        change: change?.toFixed(2) ?? null,
        changePercent: changePercent?.toFixed(2) ?? null,
        previousClose: previousValue?.toFixed(2) ?? null
      },
      chartData
    };
  } catch (error) {
    console.error(`[FRED] Error fetching historical for ${seriesId}:`, error.message);
    return null;
  }
}

// Period returns (weekly / monthly / YTD) for multi-region table — one daily series per symbol, cached
const periodReturnsCache = new Map();
const PERIOD_RETURNS_CACHE_TTL = parseInt(process.env.PERIOD_RETURNS_CACHE_TTL_MS || '900000', 10);
/** Bump when `computePeriodPercentsFromCloses` grows new fields — avoids serving stale cached objects lacking them. */
const PERIOD_RETURNS_CACHE_KEY_VERSION = '10';

function symbolIsYahooRateProxy(upperSym) {
  return upperSym === 'UST10Y' || upperSym === 'UST30Y';
}

// Period maths (MTD/QTD/YTD bases, session and calendar windows) lives in
// src/utils/marketPeriodReturns.cjs, where it is unit-tested.

// Two years by default: the one-year window compares with the last close on or
// before the same date a year earlier, and a one-year history starts after
// that close whenever the date fell on a weekend or holiday.
async function fetchYahooDailyClosesSeries(symbol, range = '2y') {
  const upperSym = symbol.toUpperCase();
  const isRateProxy = symbolIsYahooRateProxy(upperSym);
  const mapping = getTickerMapping(symbol);
  if (mapping.source === 'fred' && !isRateProxy) return null;

  const yahooSymbol = mapping.source === 'yahoo' ? mapping.ticker : symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`;

  const response = await axios.get(url, {
    params: {
      range,
      interval: '1d',
      includePrePost: 'false',
    },
    timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const result = response.data?.chart?.result?.[0];
  if (!result) return null;
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = quote.close?.[i];
    if (c == null || c === undefined) continue;
    out.push({ t: timestamps[i] * 1000, close: scaleRateProxyValue(c, isRateProxy) });
  }
  // Month, quarter and year boundaries follow the exchange's own calendar day
  // (a Sydney session opens before midnight UTC).
  const gmtOffsetSeconds = Number(result.meta?.gmtoffset);
  if (Number.isFinite(gmtOffsetSeconds)) {
    Object.defineProperty(out, 'utcOffsetMs', { value: gmtOffsetSeconds * 1000, enumerable: false });
  }
  return out.length >= 2 ? out : null;
}

async function fetchFredDailyClosesSeries(seriesId) {
  const apiKey = process.env.FRED_API_KEY || '';
  if (!apiKey) return null;
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 520);
  const url = 'https://api.stlouisfed.org/fred/series/observations';
  const response = await axios.get(url, {
    params: {
      series_id: seriesId,
      api_key: apiKey,
      file_type: 'json',
      observation_start: startDate.toISOString().split('T')[0],
      observation_end: endDate.toISOString().split('T')[0],
      sort_order: 'asc'
    },
    timeout: 12000
  });
  const observations = response.data?.observations || [];
  const out = observations
    .filter((obs) => obs.value && obs.value !== '.')
    .map((obs) => ({
      t: new Date(obs.date).getTime(),
      close: parseFloat(obs.value)
    }))
    .filter((row) => Number.isFinite(row.close));
  return out.length >= 2 ? out : null;
}

function parseHistoricalBarTimestamp(value) {
  const raw = String(value || '').trim();
  if (/^\d{8}$/.test(raw)) {
    const year = Number(raw.slice(0, 4));
    const month = Number(raw.slice(4, 6)) - 1;
    const day = Number(raw.slice(6, 8));
    return Date.UTC(year, month, day);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchIbkrDailyClosesSeries(instrument, range = '1y') {
  const response = await compositeMarketDataProvider.getHistoricalBars(instrument, range, '1d');
  const bars = Array.isArray(response?.bars) ? response.bars : [];
  const out = bars
    .map((bar) => ({
      t: parseHistoricalBarTimestamp(bar?.date || bar?.timestamp || bar?.time),
      close: Number(bar?.close),
    }))
    .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.close))
    .sort((left, right) => left.t - right.t);
  return out.length >= 2 ? out : null;
}

async function computePeriodReturnsForSymbol(symbol, instrument = null, referenceQuote = null) {
  const mapping = getTickerMapping(symbol);
  const upperSym = symbol.toUpperCase();
  const isRateProxy = symbolIsYahooRateProxy(upperSym);
  let closes = null;
  let observationFrequency = 'daily';
  let periodReturnsSource = mapping.source;
  let periodSourceSeriesId = mapping.ticker;
  let periodSourceInstrument = null;
  let periodSourceUrl = null;
  if (INTL_BOND_FRED_FALLBACK[upperSym]) {
    const cnbcCloses = referenceQuote?.source === 'cnbc' ? await fetchCnbcTreasuryDailyCloses(upperSym) : null;
    if (referenceQuote?.source === 'cnbc') {
      if (!cnbcCloses) return null;
      closes = withLiveTreasuryClose(cnbcCloses, referenceQuote);
      periodReturnsSource = 'cnbc';
      periodSourceSeriesId = referenceQuote.sourceSeriesId;
      periodSourceInstrument = referenceQuote.sourceInstrument;
    } else {
      const official = await fetchOfficialSovereignSeries(upperSym);
      if (official && (!referenceQuote || (
        referenceQuote.source === official.source && referenceQuote.sourceSeriesId === official.seriesId
      ))) {
        closes = official.closes;
        if (referenceQuote) {
          const quoteTime = Date.parse(referenceQuote.timestamp);
          closes = closes.filter((row) => row.t <= quoteTime);
          const endpoint = closes[closes.length - 1];
          if (endpoint?.t !== quoteTime || endpoint.close !== Number(referenceQuote.price)) return null;
        }
        periodReturnsSource = official.source;
        periodSourceSeriesId = official.seriesId;
        periodSourceInstrument = official.sourceInstrument;
        periodSourceUrl = official.sourceUrl;
      }
    }
    // A quote from another benchmark cannot borrow a different history, and
    // monthly averages never fill daily period columns.
    if (!closes) return null;
  } else if (isRateProxy && referenceQuote?.source === 'cnbc') {
    // A Tradeweb quote cannot borrow CBOE index history.
    const cnbcCloses = await fetchCnbcTreasuryDailyCloses(upperSym);
    if (!cnbcCloses) return null;
    closes = withLiveTreasuryClose(cnbcCloses, referenceQuote);
    periodReturnsSource = 'cnbc';
    periodSourceSeriesId = referenceQuote.sourceSeriesId;
    periodSourceInstrument = referenceQuote.sourceInstrument;
  } else if (instrument?.provider === 'ibkr') {
    closes = await fetchIbkrDailyClosesSeries(instrument);
    periodReturnsSource = 'ibkr';
    periodSourceSeriesId = upperSym;
  } else if (mapping.source === 'fred' && !isRateProxy) {
    // Period columns follow the quote's own series so the endpoint matches.
    const cnbcCloses = referenceQuote?.source === 'cnbc' ? await fetchCnbcTreasuryDailyCloses(upperSym) : null;
    const treasuryCloses = referenceQuote?.source === 'fred' || referenceQuote?.source === 'cnbc'
      ? null : await fetchTreasuryParDailyCloses(upperSym);
    if (cnbcCloses) {
      closes = withLiveTreasuryClose(cnbcCloses, referenceQuote);
      periodReturnsSource = 'cnbc';
      periodSourceSeriesId = referenceQuote.sourceSeriesId;
      periodSourceInstrument = referenceQuote.sourceInstrument;
    } else if (treasuryCloses) {
      closes = treasuryCloses;
      periodReturnsSource = 'us_treasury';
      periodSourceSeriesId = TREASURY_PAR_TENORS[upperSym];
      periodSourceUrl = TREASURY_PAR_YIELD_URL;
    } else {
      closes = await fetchFredDailyClosesSeries(mapping.ticker);
    }
  } else {
    closes = await fetchYahooDailyClosesSeries(symbol);
  }
  if (!closes || closes.length < 2) return null;
  const ratePeriods = computePeriodBpsFromCloses(closes, { observationFrequency });
  if (!ratePeriods) return null;
  // Monthly FRED observations cannot support trading-day offsets. Keep the
  // calendar-month comparisons without populating legacy short-horizon fields
  // from 15 or 21 monthly rows.
  const percentPeriods = observationFrequency === 'monthly'
    ? {
      ...ratePeriods.backdropPercentageReturns,
      thirtyDayChangePct: null,
      ninetyDayChangePct: null,
      mtdChangePct: null,
      qtdChangePct: null,
      asOf: new Date(closes[closes.length - 1].t).toISOString(),
    }
    : computePeriodPercentsFromCloses(closes);
  return {
    ...percentPeriods,
    ...ratePeriods,
    observationFrequency,
    periodReturnsSource,
    periodSourceSeriesId,
    periodSourceInstrument,
    periodSourceUrl,
    latestObservationChange: latestObservationChange(closes),
  };
}

async function getPeriodReturnsCached(symbol, instrument = null, referenceQuote = null) {
  const identity = instrument ? instrumentCacheKey(instrument) : symbol.toUpperCase();
  const referenceSeries = referenceQuote
    ? `${referenceQuote.source || ''}:${referenceQuote.sourceSeriesId || ''}:${referenceQuote.timestamp || ''}` : '';
  const key = `${identity}:${referenceSeries}:${PERIOD_RETURNS_CACHE_KEY_VERSION}`;
  const now = Date.now();
  const hit = periodReturnsCache.get(key);
  // An empty result is asked for again sooner than a good one expires.
  const keepMs = hit?.misses
    ? unavailableRetryMs(hit.misses, PERIOD_RETURNS_CACHE_TTL)
    : PERIOD_RETURNS_CACHE_TTL;
  if (hit && now - hit.ts < keepMs) {
    return hit.data;
  }
  const data = await computePeriodReturnsForSymbol(symbol, instrument, referenceQuote);
  periodReturnsCache.set(key, { data, ts: now, misses: data ? 0 : (hit?.misses || 0) + 1 });
  return data;
}

// Cache raw daily-close series so derived spread rows can compute bps period
// deltas without re-fetching both legs on every request.
const dailyClosesCache = new Map();
const DAILY_CLOSES_CACHE_TTL = parseInt(process.env.DAILY_CLOSES_CACHE_TTL_MS || '3600000', 10);

async function mapWithConcurrency(items, concurrency, processor) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await processor(items[index], index);
    }
  }));

  return results;
}

async function getDailyClosesCached(symbol) {
  const upperSym = symbol.toUpperCase();
  if (CNBC_TREASURY_SYMBOLS[upperSym]) {
    // The curve leg follows the same CNBC series the quote row shows.
    const [cnbcCloses, liveQuote] = await Promise.all([
      fetchCnbcTreasuryDailyCloses(upperSym),
      fetchCnbcTreasuryQuote(upperSym),
    ]);
    if (cnbcCloses) return withLiveTreasuryClose(cnbcCloses, liveQuote);
  }
  return getPublishedDailyClosesCached(symbol);
}

async function getPublishedDailyClosesCached(symbol) {
  const key = symbol.toUpperCase();
  const now = Date.now();
  const hit = dailyClosesCache.get(key);
  // A failed read is asked for again sooner than a good one expires, so a
  // moment's outage does not blank the series for the full cache time.
  const keepMs = hit?.misses
    ? unavailableRetryMs(hit.misses, DAILY_CLOSES_CACHE_TTL)
    : DAILY_CLOSES_CACHE_TTL;
  if (hit && now - hit.ts < keepMs) {
    return hit.data;
  }
  const mapping = getTickerMapping(symbol);
  const upperSym = symbol.toUpperCase();
  const isRateProxy = symbolIsYahooRateProxy(upperSym);
  let closes = null;
  try {
    if (mapping.source === 'fred' && !isRateProxy) {
      closes = await fetchTreasuryParDailyCloses(upperSym) || await fetchFredDailyClosesSeries(mapping.ticker);
    } else {
      closes = await fetchYahooDailyClosesSeries(symbol);
    }
  } catch (err) {
    console.warn(`[Rates] daily closes fetch failed for ${symbol}:`, err.message);
    closes = null;
  }
  const available = Array.isArray(closes) && closes.length > 0;
  dailyClosesCache.set(key, {
    data: closes,
    ts: now,
    misses: available ? 0 : (hit?.misses || 0) + 1,
  });
  return closes;
}

// Build a date-keyed map of daily close values (UTC day) for quick alignment
// between two leg series.
function buildCloseByDayMap(series) {
  const map = new Map();
  if (!Array.isArray(series)) return map;
  for (const row of series) {
    const d = new Date(row.t);
    const dayKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    map.set(dayKey, { t: row.t, close: row.close });
  }
  return map;
}

// Build a paired spread series (in bps) from two daily-close series. Only days
// where both legs have a close are emitted. `factor` converts yields (%) to bps.
function buildSpreadBpsSeries(longSeries, shortSeries) {
  if (!Array.isArray(longSeries) || !Array.isArray(shortSeries)) return null;
  const shortByDay = buildCloseByDayMap(shortSeries);
  const out = [];
  for (const row of longSeries) {
    const d = new Date(row.t);
    const dayKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const shortHit = shortByDay.get(dayKey);
    if (!shortHit) continue;
    if (!Number.isFinite(row.close) || !Number.isFinite(shortHit.close)) continue;
    out.push({ t: row.t, close: (row.close - shortHit.close) * 100 });
  }
  return out.length >= 2 ? out : null;
}

const RISK_RANGE_TICKER_ALIASES = {
  BTC: ['BITCOIN'],
  GOLD: ['GLD'],
  GLD: ['GOLD'],
  WTIC: ['USO', 'OIL'],
  BRENT: ['USO'],
  OIL: ['USO'],
  DXY: ['USD'],
  USD: ['DXY'],
};

function lookupRiskRangeData(allData, ticker) {
  const upper = String(ticker).toUpperCase();
  if (allData[upper]) return allData[upper];
  for (const alt of RISK_RANGE_TICKER_ALIASES[upper] || []) {
    if (allData[alt]) return allData[alt];
  }
  return null;
}

function validSecurityRiskMetricsSymbol(symbol) {
  return /^[A-Z0-9][A-Z0-9.^=/_-]{0,31}$/.test(symbol);
}

function parseSecurityRiskAssetTypes(raw) {
  const out = {};
  if (raw == null || raw === '') return out;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    Object.entries(raw).forEach(([symbol, assetType]) => {
      const key = String(symbol || '').trim().toUpperCase();
      const value = String(assetType || '').trim().toLowerCase();
      if (key && value) out[key] = value;
    });
    return out;
  }
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  text.split(',').forEach((pair) => {
    const [symbolPart, ...typeParts] = pair.split(':');
    const key = String(symbolPart || '').trim().toUpperCase();
    const value = typeParts.join(':').trim().toLowerCase();
    if (key && value) out[key] = value;
  });
  return out;
}

function summarizeSecurityRiskMetricsCache(statuses) {
  const usable = statuses.filter(Boolean);
  if (usable.length === 0) return 'unavailable';
  if (usable.every((status) => status === 'hit')) return 'hit';
  if (usable.every((status) => status === 'miss')) return 'miss';
  return 'mixed';
}

function readExposureLabSeedSecurities() {
  const sourcePath = path.join(__dirname, 'src', 'constants', 'securitiesList.js');
  return parseSeedSecurities(fs.readFileSync(sourcePath, 'utf8'));
}

async function loadExposureLabUniverse({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (
    !forceRefresh
    && exposureLabUniverseCache.value
    && now - exposureLabUniverseCache.timestamp < EXPOSURE_LAB_UNIVERSE_CACHE_TTL
  ) {
    return {
      ...exposureLabUniverseCache.value,
      cache: {
        status: 'hit',
        ageSeconds: Math.max(0, Math.floor((now - exposureLabUniverseCache.timestamp) / 1000)),
        ttlSeconds: Math.floor(EXPOSURE_LAB_UNIVERSE_CACHE_TTL / 1000),
      },
    };
  }

  if (exposureLabUniverseCache.inFlight) return exposureLabUniverseCache.inFlight;

  const request = (async () => {
    const snapshotTableName = process.env.HEDGEYE_DAILY_SNAPSHOT_TABLE
      || 'HedgeyeDailySnapshot';
    const [snapshots, riskRangeRows, securityMasterResult] = await Promise.all([
      scanAllPages(dynamodb, { TableName: snapshotTableName }),
      scanAllPages(dynamodb, {
        TableName: RISK_RANGE_DATA_TABLE,
        ProjectionExpression: '#date, #ticker',
        ExpressionAttributeNames: {
          '#date': 'date',
          '#ticker': 'ticker',
        },
      }),
      exposureLabSecurityMaster.listCurrentReviews()
        .then((reviews) => ({ status: 'available', reviews }))
        .catch((error) => ({
          status: 'unavailable',
          reviews: [],
          reason: error.code || 'security_master_unavailable',
        })),
    ]);
    const discoveredUniverse = buildHedgeyeSecurityUniverse({
      snapshots,
      riskRangeRows,
      seedSecurities: readExposureLabSeedSecurities(),
    });
    const identifiedUniverse = await exposureLabSecurityIdentityResolver.resolve(
      discoveredUniverse,
      { forceRefresh },
    );
    const universe = mergeSecurityMasterReviews(
      identifiedUniverse,
      securityMasterResult.reviews,
    );
    const generatedAt = new Date().toISOString();
    const value = {
      ...universe,
      generatedAt,
      securityMaster: {
        status: securityMasterResult.status,
        reason: securityMasterResult.reason || null,
        table: exposureLabSecurityMaster.tableName,
        reviewedCount: securityMasterResult.reviews.length,
      },
      provenance: {
        snapshotTable: snapshotTableName,
        riskRangeTable: RISK_RANGE_DATA_TABLE,
        securityMasterTable: exposureLabSecurityMaster.tableName,
        seedFile: 'src/constants/securitiesList.js',
        identitySources: [
          'SEC company_tickers_exchange.json',
          'Yahoo Finance chart metadata for structured non-SEC symbols',
          'reviewed Exposure Lab security master',
        ],
        archiveScan: 'complete paginated DynamoDB scan',
      },
    };
    exposureLabUniverseCache.value = value;
    exposureLabUniverseCache.timestamp = Date.now();
    return {
      ...value,
      cache: {
        status: 'miss',
        ageSeconds: 0,
        ttlSeconds: Math.floor(EXPOSURE_LAB_UNIVERSE_CACHE_TTL / 1000),
      },
    };
  })().finally(() => {
    exposureLabUniverseCache.inFlight = null;
  });

  exposureLabUniverseCache.inFlight = request;
  return request;
}

// Full, read-only discovery ledger assembled from every persisted Hedgeye API
// pull. The Call positions are bounded by their explicit article declaration;
// unresolved fallback/text mentions remain non-executable pending identity QA.
app.get('/api/risk/exposure-lab/universe', async (req, res) => {
  const forceRefresh = ['1', 'true'].includes(
    String(req.query.forceRefresh || '').trim().toLowerCase(),
  );
  res.set('Cache-Control', 'no-store');
  res.set('X-Data-Use', 'historical-research-only');
  try {
    return res.json(await loadExposureLabUniverse({ forceRefresh }));
  } catch (error) {
    console.error('[ExposureLab] Complete Hedgeye universe scan unavailable:', error);
    return res.status(503).json({
      status: 'unavailable',
      reason: 'hedgeye_archive_scan_unavailable',
      error: error.message,
      rows: [],
      historicalOnly: true,
      executable: false,
      generatedAt: new Date().toISOString(),
    });
  }
});

app.get('/api/risk/exposure-lab/security-master', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Data-Use', 'risk-governance-non-executable');
  try {
    const reviews = await exposureLabSecurityMaster.listCurrentReviews();
    return res.json({
      status: 'available',
      table: exposureLabSecurityMaster.tableName,
      reviews,
      count: reviews.length,
      executable: false,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(503).json({
      status: 'unavailable',
      reason: error.code || 'security_master_unavailable',
      reviews: [],
      executable: false,
    });
  }
});

app.get('/api/risk/exposure-lab/security-master/:ticker/audit', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Data-Use', 'risk-governance-non-executable');
  try {
    const events = await exposureLabSecurityMaster.listAuditEvents(req.params.ticker, {
      limit: req.query.limit,
    });
    return res.json({
      status: 'available',
      ticker: String(req.params.ticker || '').trim().toUpperCase(),
      events,
      count: events.length,
      executable: false,
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 503;
    return res.status(status).json({
      status: 'unavailable',
      reason: error.code || 'security_review_audit_unavailable',
      events: [],
      executable: false,
    });
  }
});

app.put('/api/risk/exposure-lab/security-master/:ticker', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Data-Use', 'risk-governance-non-executable');
  try {
    const review = await exposureLabSecurityMaster.writeReview(req.params.ticker, req.body || {});
    exposureLabUniverseCache.value = null;
    exposureLabUniverseCache.timestamp = 0;
    return res.json({
      status: 'available',
      review,
      auditRecorded: true,
      executable: false,
    });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 503;
    return res.status(status).json({
      status: 'unavailable',
      reason: error.code || 'security_review_write_failed',
      error: error.message,
      auditRecorded: false,
      executable: false,
    });
  }
});

// Read-only historical research metrics, including completed daily price
// structure. This route deliberately contains no spot, NLV, position, action,
// or order data and can never be executable.
app.get('/api/security-risk-metrics/spx-realized-volatility', createCompletedSessionVolatilityHandler({
  loadHistory: fetchYahooAdjustedHistory,
}));
app.get('/api/security-risk-metrics', async (req, res) => {
  const rawSymbols = Array.isArray(req.query.symbols)
    ? req.query.symbols.join(',')
    : String(req.query.symbols || '');
  const symbols = Array.from(new Set(
    rawSymbols.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
  ));
  const forceRefresh = ['1', 'true'].includes(
    String(req.query.forceRefresh || '').trim().toLowerCase(),
  );
  const includeVolSeries = ['1', 'true'].includes(
    String(req.query.includeVolSeries || '').trim().toLowerCase(),
  );
  const assetTypeBySymbol = parseSecurityRiskAssetTypes(req.query.assetTypes);
  const sizingOnly = ['1', 'true'].includes(String(req.query.sizingOnly || '').toLowerCase());

  res.set('Cache-Control', 'no-store');
  res.set('X-Data-Use', 'historical-research-only');

  if (symbols.length === 0) {
    return res.status(400).json({
      status: 'unavailable',
      error: 'At least one symbol is required',
      rows: {},
      historicalOnly: true,
      executable: false,
    });
  }
  if (symbols.length > 50) {
    return res.status(400).json({
      status: 'unavailable',
      error: 'A maximum of 50 symbols may be requested',
      rows: {},
      historicalOnly: true,
      executable: false,
    });
  }

  const { payload, cacheStatus, cacheAgeSeconds } = await buildSecurityRiskMetricsResponse({
    symbols, forceRefresh, includeVolSeries, assetTypeBySymbol, sizingOnly,
  });
  res.set('X-Data-Cache', cacheStatus);
  res.set('X-Data-Age', String(cacheAgeSeconds));
  return res.json(payload);
});

// Per-symbol ATR, beta, reference close and (outside sizingOnly) the wider
// history metrics, with SPY as the beta benchmark. The route and the security
// record both read it, so their figures are the same computation.
async function buildSecurityRiskMetricsResponse({
  symbols, forceRefresh = false, includeVolSeries = false, assetTypeBySymbol = {}, sizingOnly = false,
}) {
  const fetchHistory = sizingOnly
    ? (symbol) => fetchYahooSizingHistory(symbol, { forceRefresh })
    : (symbol) => fetchYahooMaximumAdjustedHistory(symbol, { forceRefresh });
  const cacheStatuses = [];
  let benchmarkHistory = null;
  try {
    benchmarkHistory = await fetchHistory('SPY');
    cacheStatuses.push(benchmarkHistory.cacheStatus);
  } catch (error) {
    console.warn('[SecurityRiskMetrics] SPY maximum-history fetch unavailable:', error.message);
  }
  // The SPY history is shared by every beta calculation in this response.
  // Normalize it once so a large portfolio does not repeatedly parse and sort
  // the same maximum-history payload for every symbol.
  const normalizedBenchmarkBars = benchmarkHistory
    ? normalizeAdjustedPriceBars(benchmarkHistory.bars)
    : [];

  const rowEntries = await mapWithConcurrency(symbols, 6, async (symbol) => {
    if (!validSecurityRiskMetricsSymbol(symbol)) {
      return [symbol, createUnavailableSecurityRiskMetrics({
        symbol,
        reason: SECURITY_RISK_METRICS_REASONS.INVALID_SYMBOL,
        source: SECURITY_RISK_METRICS_SOURCE,
        provenance: { provider: 'Yahoo Finance', requestedSymbol: symbol },
      })];
    }

    let securityHistory;
    try {
      if (symbol === 'SPY' && benchmarkHistory) {
        securityHistory = benchmarkHistory;
      } else if (symbol === 'SPY') {
        throw new Error('SPY benchmark history is unavailable');
      } else {
        securityHistory = await fetchHistory(symbol);
        cacheStatuses.push(securityHistory.cacheStatus);
      }
    } catch (error) {
      const reason = error.code === SECURITY_RISK_METRICS_REASONS.UNSUPPORTED_SOURCE
        ? SECURITY_RISK_METRICS_REASONS.UNSUPPORTED_SOURCE
        : SECURITY_RISK_METRICS_REASONS.HISTORY_UNAVAILABLE;
      console.warn(`[SecurityRiskMetrics] ${symbol} maximum-history fetch unavailable:`, error.message);
      return [symbol, createUnavailableSecurityRiskMetrics({
        symbol,
        reason,
        source: SECURITY_RISK_METRICS_SOURCE,
        provenance: { provider: 'Yahoo Finance', requestedSymbol: symbol },
      })];
    }

    const provenance = {
      provider: 'Yahoo Finance',
      dataset: 'chart',
      range: null,
      requestWindow: sizingOnly ? 'Two years through request time; up to 252 aligned returns for sizing' : '1900-01-01 through request time (maximum returned provider history)',
      interval: '1d',
      adjustedCloseRequired: true,
      security: {
        requestedSymbol: symbol,
        yahooSymbol: securityHistory.yahooSymbol,
        fetchedAt: securityHistory.fetchedAt,
        cacheStatus: securityHistory.cacheStatus,
        cacheAgeSeconds: securityHistory.cacheAgeSeconds,
        exchangeTimezone: securityHistory.exchangeTimezone,
        regularSession: securityHistory.regularSession,
      },
      benchmark: benchmarkHistory ? {
        symbol: 'SPY',
        yahooSymbol: benchmarkHistory.yahooSymbol,
        fetchedAt: benchmarkHistory.fetchedAt,
        cacheStatus: benchmarkHistory.cacheStatus,
        cacheAgeSeconds: benchmarkHistory.cacheAgeSeconds,
      } : {
        symbol: 'SPY',
        status: 'unavailable',
      },
    };

    let row = buildSecurityRiskMetrics({
      symbol,
      securityBars: securityHistory.bars,
      benchmarkBars: benchmarkHistory?.bars || [],
      source: SECURITY_RISK_METRICS_SOURCE,
      provenance,
      assetType: assetTypeBySymbol[symbol] || 'equity',
      includeVolSeries: includeVolSeries && symbols.length === 1,
      normalizedBenchmarkBars,
      instrumentType: securityHistory.instrumentType,
      sizingOnly,
    });

    if (!benchmarkHistory) {
      const unavailableBeta = createUnavailableSecurityRiskMetrics({
        symbol,
        reason: SECURITY_RISK_METRICS_REASONS.BENCHMARK_UNAVAILABLE,
        source: SECURITY_RISK_METRICS_SOURCE,
      }).beta;
      const availableNonBetaMetrics = [row.atr14, row.records, row.priceStructure]
        .filter((metric) => metric?.status === 'available').length;
      row = {
        ...row,
        status: availableNonBetaMetrics > 0 ? 'partial' : 'unavailable',
        beta: unavailableBeta,
      };
    }

    return [symbol, row];
  });

  const rows = Object.fromEntries(rowEntries);
  const rowValues = Object.values(rows);
  const availableRows = rowValues.filter((row) => row.status === 'available').length;
  const usableRows = rowValues.filter((row) => row.status !== 'unavailable').length;
  const status = availableRows === rowValues.length
    ? 'available'
    : (usableRows > 0 ? 'partial' : 'unavailable');
  const asOf = rowValues
    .map((row) => row.asOf)
    .filter(Boolean)
    .sort()
    .pop() || null;
  const cacheStatus = summarizeSecurityRiskMetricsCache(cacheStatuses);
  const cacheAgeSeconds = Math.max(
    0,
    ...rowValues.map((row) => Number(row.provenance?.security?.cacheAgeSeconds) || 0),
  );
  const expectedCompletedSession = mostRecentCompletedTradingDateKey(new Date());
  const completedSessionRows = rowValues.filter((row) => row.status !== 'unavailable');
  const completedSessionCurrent = completedSessionRows.length > 0
    && completedSessionRows.every((row) => row.asOf === expectedCompletedSession);

  return {
    cacheStatus,
    cacheAgeSeconds,
    payload: {
      status,
      source: SECURITY_RISK_METRICS_SOURCE,
      benchmark: 'SPY',
      asOf,
      generatedAt: new Date().toISOString(),
      requestedSymbols: symbols,
      rows,
      cache: {
        status: cacheStatus,
        ageSeconds: cacheAgeSeconds,
        ttlSeconds: Math.floor(SECURITY_RISK_METRICS_CACHE_TTL / 1000),
      },
      completedSession: {
        status: completedSessionCurrent ? 'current' : 'unavailable',
        expectedAsOf: expectedCompletedSession,
        observedAsOf: asOf,
      },
      historicalOnly: true,
      executable: false,
    },
  };
}

function isExposureLabModelHolding(holding = {}) {
  if (holding?.isPredictionMarket === true) return false;
  const secType = String(
    holding?.secType || holding?.securityType || holding?.assetType || '',
  ).trim().toUpperCase();
  if (['OPT', 'OPTION', 'FOP', 'CASH'].includes(secType)) return false;
  const symbol = String(holding?.symbol || '').trim().toUpperCase();
  const marketValue = Number(holding?.marketValue);
  return Boolean(symbol) && Number.isFinite(marketValue) && marketValue !== 0;
}

function unavailableExposureLabSnapshot(reason, portfolio = null, extra = {}) {
  return {
    status: 'unavailable',
    reason,
    modelVersion: EXPOSURE_LAB_MODEL_VERSION,
    historicalOnly: true,
    executable: false,
    actionable: false,
    factors: [],
    positions: [],
    portfolio: null,
    correlations: {},
    correlation: buildEmptyCorrelation(reason),
    geography: buildEmptyGeography(reason),
    coverage: {
      modeledPositionCount: 0,
      totalPositionCount: 0,
      modeledGrossNavPct: 0,
      unmodeledGrossNavPct: 0,
    },
    portfolioState: portfolio ? {
      accountId: portfolio.accountId || null,
      dataSource: portfolio.dataSource || null,
      liveSessionVerified: portfolio.liveSessionVerified === true,
      fromCache: portfolio.fromCache ?? null,
      fetchedAt: portfolio.fetchedAt || null,
      socketVerifiedAt: portfolio.socketVerifiedAt || null,
      markState: portfolio.dataQuality?.markState || 'unavailable',
      dataQuality: portfolio.dataQuality || null,
    } : null,
    hedgeScenarios: {
      available: false,
      executable: false,
      orderSubmitted: false,
      blockers: [reason],
      rows: [],
    },
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

// Read-only factor-risk snapshot. Live IBKR supplies positions/NLV; adjusted
// completed-session history supplies the model. No route in Exposure Lab can
// create, preview, stage, or submit an order.
app.get('/api/risk/exposure-lab/snapshot', async (req, res) => {
  const startTime = Date.now();
  const accountId = req.query.account || process.env.IBKR_ACCOUNT_ID || undefined;
  const forceRefresh = ['1', 'true'].includes(
    String(req.query.forceRefresh || '').trim().toLowerCase(),
  );
  res.set('Cache-Control', 'no-store');
  res.set('X-Data-Use', 'historical-research-only');

  let portfolioData;
  try {
    portfolioData = await portfolioDataProvider.getPortfolioSnapshot(accountId);
  } catch (error) {
    console.warn('[ExposureLab] Live portfolio snapshot unavailable:', error.message);
    return res.status(503).json(unavailableExposureLabSnapshot(
      'live_portfolio_unavailable',
      null,
      { error: error.message },
    ));
  }

  const portfolioGate = classifyExposureLabPortfolioInput(portfolioData);
  if (!portfolioGate.verified) {
    return res.status(503).json(unavailableExposureLabSnapshot(
      portfolioGate.reason,
      portfolioData,
    ));
  }

  const sourceHoldings = Array.isArray(portfolioData.holdings)
    ? portfolioData.holdings
    : [];
  const holdings = sourceHoldings.filter(isExposureLabModelHolding);
  const excludedHoldings = sourceHoldings
    .filter((holding) => !isExposureLabModelHolding(holding))
    .map((holding) => ({
      symbol: holding?.symbol || holding?.localSymbol || null,
      secType: holding?.secType || holding?.assetType || null,
      reason: holding?.isPredictionMarket === true
        ? 'prediction_market_separate_ledger'
        : 'unsupported_or_unpriced_instrument',
    }));
  const positionSymbols = [...new Set(
    holdings.map((holding) => String(holding.symbol || '').trim().toUpperCase()).filter(Boolean),
  )];
  const parsedMaxPositionSymbols = parseInt(
    process.env.EXPOSURE_LAB_MAX_POSITION_SYMBOLS || '75',
    10,
  );
  const maxPositionSymbols = Number.isFinite(parsedMaxPositionSymbols)
    ? Math.max(1, parsedMaxPositionSymbols)
    : 75;
  if (positionSymbols.length > maxPositionSymbols) {
    return res.status(422).json(unavailableExposureLabSnapshot(
      'portfolio_scope_exceeds_model_limit',
      portfolioData,
      {
        sourceScope: {
          sourceHoldingCount: sourceHoldings.length,
          eligibleHoldingCount: holdings.length,
          eligibleSymbolCount: positionSymbols.length,
          excludedHoldings,
          maxPositionSymbols,
        },
      },
    ));
  }

  const factorProxySymbols = getFactorProxySymbols(EXPOSURE_LAB_FACTOR_DEFINITIONS);
  const geographyHistorySymbols = getExposureLabGeographyHistorySymbols();
  const requestedSymbols = [...new Set([
    ...positionSymbols,
    ...factorProxySymbols,
    ...geographyHistorySymbols,
  ])];
  const securityMasterPromise = exposureLabSecurityMaster.listCurrentReviews()
    .then((reviews) => ({ status: 'available', reviews }))
    .catch((error) => ({
      status: 'unavailable',
      reviews: [],
      reason: error.code || 'security_master_unavailable',
    }));
  const historyFailures = [];
  const historyResults = await mapWithConcurrency(requestedSymbols, 6, async (symbol) => {
    if (!validSecurityRiskMetricsSymbol(symbol)) {
      historyFailures.push({ symbol, reason: 'invalid_symbol' });
      return [symbol, []];
    }
    try {
      const history = await fetchYahooExposureLabAdjustedHistory(symbol, { forceRefresh });
      return [symbol, history.bars];
    } catch (error) {
      historyFailures.push({
        symbol,
        reason: error.code || 'history_unavailable',
        message: error.message,
      });
      return [symbol, []];
    }
  });
  const histories = Object.fromEntries(historyResults);
  const risk = buildPortfolioFactorRiskSnapshot({
    holdings,
    totalValue: portfolioData.summary?.totalValue,
    histories,
    factorDefinitions: EXPOSURE_LAB_FACTOR_DEFINITIONS,
  });

  const markState = portfolioData.dataQuality?.markState || 'unavailable';
  const liveMarksVerified = (
    markState === 'live'
    && portfolioData.dataQuality?.status === 'ok'
  );
  const securityMasterResult = await securityMasterPromise;
  const diagnostics = buildExposureLabDiagnostics({
    holdings,
    allocationHoldings: sourceHoldings,
    totalValue: portfolioData.summary?.totalValue,
    histories,
    factorDefinitions: EXPOSURE_LAB_FACTOR_DEFINITIONS,
    securityReviews: securityMasterResult.reviews,
    securityMasterAvailable: securityMasterResult.status === 'available',
    now: new Date(),
  });
  const hedgeScenarios = buildFactorNeutralizationScenarios({
    riskSnapshot: risk,
    totalValue: portfolioData.summary?.totalValue,
    factorDefinitions: EXPOSURE_LAB_FACTOR_DEFINITIONS,
    securityReviews: securityMasterResult.reviews,
    portfolioMode: liveMarksVerified ? 'live' : 'reference',
    securityMasterAvailable: securityMasterResult.status === 'available',
  });
  const response = {
    ...risk,
    correlation: diagnostics.correlation,
    geography: diagnostics.geography,
    actionable: false,
    generatedAt: new Date().toISOString(),
    portfolioState: {
      accountId: portfolioData.accountId || accountId || null,
      mode: liveMarksVerified ? 'live' : 'reference',
      dataSource: portfolioData.dataSource,
      liveSessionVerified: true,
      fromCache: false,
      fetchedAt: portfolioData.fetchedAt || null,
      socketVerifiedAt: portfolioData.socketVerifiedAt || null,
      markState,
      dataQuality: portfolioData.dataQuality || null,
      referenceMarks: portfolioData.referenceMarks || null,
    },
    sourceScope: {
      sourceHoldingCount: sourceHoldings.length,
      eligibleHoldingCount: holdings.length,
      eligibleSymbolCount: positionSymbols.length,
      excludedHoldings,
      factorProxySymbolCount: factorProxySymbols.length,
      geographyHistorySymbolCount: geographyHistorySymbols.length,
      requestedHistorySymbolCount: requestedSymbols.length,
      historyCalendarDays: EXPOSURE_LAB_HISTORY_CALENDAR_DAYS,
      historyFailureCount: historyFailures.length,
      historyFailures,
      maxPositionSymbols,
    },
    securityMaster: {
      status: securityMasterResult.status,
      reason: securityMasterResult.reason || null,
      reviewedCount: securityMasterResult.reviews.length,
      table: exposureLabSecurityMaster.tableName,
    },
    hedgeScenarios,
  };
  console.log(
    `[ExposureLab] snapshot completed in ${Date.now() - startTime}ms positions=${holdings.length} histories=${requestedSymbols.length} failures=${historyFailures.length}`,
  );
  return res.json(response);
});

// Risk Range Data endpoint - fetches LRR/HRR from Hedgeye
app.get('/api/risk-ranges', async (req, res) => {
  const startTime = Date.now();
  try {
    const { tickers, date } = req.query;
    const wantsEnvelope = String(req.query.envelope || '') === '1';
    const tickerList = tickers ? tickers.split(',').map(t => t.trim().toUpperCase()) : null;
    const expectation = date ? null : expectedRiskRangePublication(new Date());

    const cacheKey = JSON.stringify({
      tickers: tickerList ? [...tickerList].sort() : null,
      date: date || null,
      envelope: wantsEnvelope,
      publicationPhase: expectation
        ? {
          expectedDate: expectation.expectedDate,
          pendingDate: expectation.pendingDate,
          afterDeadline: expectation.afterDeadline,
        }
        : null,
    });
    const now = Date.now();

    const cached = riskRangesCache.get(cacheKey);
    const cacheTtl = cached?.envelope?.available
      ? RISK_RANGES_CACHE_TTL
      : RISK_RANGES_UNAVAILABLE_CACHE_TTL;
    if (cached && (now - cached.timestamp) < cacheTtl) {
      const totalTime = Date.now() - startTime;
      console.log(`[API] /api/risk-ranges cache hit for ${cacheKey} (${totalTime}ms)`);
      res.setHeader('X-Risk-Range-Status', cached.envelope.status);
      if (cached.envelope.manifest.publicationDate) {
        res.setHeader('X-Risk-Range-Publication-Date', cached.envelope.manifest.publicationDate);
      }
      return res.json(cached.data);
    }

    console.log(`[API] /api/risk-ranges called${tickerList ? ` for ${tickerList.length} tickers` : ' for all tickers'}`);
    const dbStartTime = Date.now();
    const envelope = await loadRiskRangePublicationEnvelope({
      requestedDate: date || null,
      now: new Date(),
    });
    const dbTime = Date.now() - dbStartTime;
    console.log(
      `[API] DynamoDB release query completed in ${dbTime}ms; risk-range publication ` +
      `${envelope.status} for ${envelope.manifest.publicationDate || 'none'} ` +
      `(${envelope.manifest.primaryCount} primary, ${envelope.manifest.supplementalCount} supplemental)`,
    );

    const allData = envelope.ranges;
    const riskRanges = tickerList
      ? Object.fromEntries(
        tickerList
          .map(ticker => {
            const upper = ticker.toUpperCase();
            const data = lookupRiskRangeData(allData, upper);
            return data ? [upper, data] : null;
          })
          .filter(Boolean)
      )
      : allData;
    const responseData = wantsEnvelope
      ? { ...envelope, ranges: riskRanges }
      : riskRanges;
    riskRangesCache.set(cacheKey, {
      data: responseData,
      envelope,
      timestamp: now,
    });
    res.setHeader('X-Risk-Range-Status', envelope.status);
    if (envelope.manifest.publicationDate) {
      res.setHeader('X-Risk-Range-Publication-Date', envelope.manifest.publicationDate);
    }
    const totalTime = Date.now() - startTime;
    console.log(`[API] Returning risk ranges for ${Object.keys(riskRanges).length} securities (total: ${totalTime}ms, DB: ${dbTime}ms)`);
    res.json(responseData);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/risk-ranges after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch risk ranges', details: error.message });
  }
});

// Historical Risk Ranges endpoint - specific ticker history
app.get('/api/risk-ranges/history', async (req, res) => {
  const startTime = Date.now();
  const { ticker, limit = 30 } = req.query;

  if (!ticker) {
    return res.status(400).json({ error: 'Ticker parameter is required' });
  }

  const parsedLimit = parseInt(limit) || 30;
  const upperTicker = ticker.toUpperCase();

  try {
    console.log(`[API] /api/risk-ranges/history called for ${upperTicker} (limit: ${parsedLimit})`);

    const params = {
      TableName: 'RiskRangeData',
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: {
        ':ticker': upperTicker
      },
      ScanIndexForward: false, // Descending order (newest first)
      Limit: parsedLimit
    };

    const result = await dynamodb.query(params).promise();
    const items = result.Items || [];

    // Sort array by date ascending for the chart (oldest to newest)
    items.sort((a, b) => new Date(a.date) - new Date(b.date));

    const totalTime = Date.now() - startTime;
    console.log(`[API] Returning ${items.length} historical items for ${upperTicker} (${totalTime}ms)`);

    res.json(items);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/risk-ranges/history after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch risk range history', details: error.message });
  }
});

// Bulk history endpoint for Securities Universe
app.get('/api/risk-ranges/history-all', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/risk-ranges/history-all called');

    const params = { TableName: 'RiskRangeData' };
    const items = await scanAllPages(dynamodb, params);

    const grouped = {};
    items.forEach(item => {
      if (!grouped[item.ticker]) grouped[item.ticker] = [];
      grouped[item.ticker].push({
        date: item.date,
        lrr: item.lrr,
        hrr: item.hrr,
        trend: item.trend,
        close: item.close,
        timestamp: item.timestamp
      });
    });

    Object.keys(grouped).forEach(ticker => {
      grouped[ticker].sort((a, b) => new Date(a.date) - new Date(b.date));
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] Returning full history for ${Object.keys(grouped).length} tickers (${items.length} total items) in ${totalTime}ms`);

    res.json(grouped);
  } catch (error) {
    console.error('[API] Error in /api/risk-ranges/history-all:', error);
    res.status(500).json({ error: 'Failed to fetch bulk history' });
  }
});

// Hedgeye Freshness endpoint - returns status of all 6 Hedgeye data types
app.get('/api/hedgeye/freshness', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/hedgeye/freshness called');

    // Helper for date status
    // Now uses the explicit content 'date' from the item, compared to 'today' (NY time)
    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
    const marketSession = isUsMarketOpen(now) ? 'open' : 'closed';

    const getFreshnessStatus = (itemDate) => {
      if (!itemDate) return 'missing';
      return itemDate === today ? 'fresh' : 'stale';
    };
    // Published only when Hedgeye releases a new edition (no daily cadence), so
    // the latest stored release is current until a newer one is ingested.
    const RELEASE_DRIVEN_SNAPSHOT_TYPES = new Set(['inflation-nowcast']);

    const results = {};
    const alerts = [];
    // Volume is measured from Cboe consolidated share volume, not the retired
    // Hedgeye Volume PDF; start the fetch now so it overlaps the DynamoDB reads.
    const volumeFreshnessRequest = exchangeVolumeService.fetchSnapshot({ days: 2 })
      .then((snapshot) => exchangeVolumeFreshness(snapshot, new Date()))
      .catch((err) => ({ status: 'error', error: err.message, source: 'CboeHistoricalMarketVolume' }));

    // 1. Processing Risk Ranges (HedgeyeRiskRanges Table)
    try {
      const envelope = await loadRiskRangePublicationEnvelope({ now });
      results['risk-ranges'] = {
        status: envelope.status === 'current'
          ? 'fresh'
          : envelope.status === 'pending'
            ? 'pending'
            : envelope.status,
        lastUpdated: envelope.manifest.publicationDate,
        scrapedAt: envelope.manifest.latestUpdatedAt,
        itemCount: envelope.manifest.decisionRangeCount,
        primaryCount: envelope.manifest.primaryCount,
        supplementalCount: envelope.manifest.supplementalCount,
        expectedDate: envelope.manifest.expectedDate,
        pendingDate: envelope.manifest.pendingDate,
        available: envelope.available,
        date: envelope.manifest.publicationDate,
        source: 'HedgeyeRiskRangesManifest',
      };
    } catch (err) {
      console.error('[API] Error querying HedgeyeRiskRanges:', err.message);
      results['risk-ranges'] = { status: 'error', error: err.message };
    }

    // 2. Processing Snapshots (HedgeyeDailySnapshot Table)
    // Other types are stored as single snapshot items per day
    const snapshotTypes = ['top-3-things', 'early-look', 'bitcoin-trend-tracker', 'momo-tracker', 'signal-strength', 'portfolio-solutions', 'the-macro-show', 'the-call', 'real-time-alert', 'market-structure', 'cftc-positioning', 'etf-pro', 'inflation-nowcast'];

    // Query one bounded latest row per product through the metadata-only GSI.
    // This replaced the previous full-table scan on every status refresh.
    const latestByType = {};
    const snapshotErrors = {};
    await Promise.all(snapshotTypes.map(async (snapshotType) => {
      try {
        const rows = await queryLatestSnapshotsByType(snapshotType, {
          limit: 1,
          projectionExpression: [
            '#snapshotType',
            '#date',
            '#scrapedAt',
            '#riskRangeCount',
            '#metricsCount',
            '#stockCount',
            '#cryptoCount',
            '#rankingCount',
            '#itemCount',
            '#changeCount',
          ].join(', '),
          expressionAttributeNames: {
            '#date': 'date',
            '#scrapedAt': 'scrapedAt',
            '#riskRangeCount': 'riskRangeCount',
            '#metricsCount': 'metricsCount',
            '#stockCount': 'stockCount',
            '#cryptoCount': 'cryptoCount',
            '#rankingCount': 'rankingCount',
            '#itemCount': 'itemCount',
            '#changeCount': 'changeCount',
          },
        });
        if (rows[0]) latestByType[snapshotType] = rows[0];
      } catch (error) {
        snapshotErrors[snapshotType] = error;
      }
    }));

    for (const snapshotType of snapshotTypes) {
      if (snapshotErrors[snapshotType]) {
        results[snapshotType] = {
          status: 'error',
          error: snapshotErrors[snapshotType].message,
        };
        continue;
      }

      const latestSnapshot = latestByType[snapshotType];

      if (latestSnapshot) {
        const explicitCount = [
          latestSnapshot.riskRangeCount,
          latestSnapshot.metricsCount,
          latestSnapshot.stockCount,
          latestSnapshot.cryptoCount,
          latestSnapshot.rankingCount,
          latestSnapshot.itemCount,
          latestSnapshot.changeCount,
        ].find((value) => value !== null && value !== undefined && value !== '');
        const numericCount = Number(explicitCount);
        const itemCount = Number.isFinite(numericCount) ? numericCount : 0;

        results[snapshotType] = {
          status: RELEASE_DRIVEN_SNAPSHOT_TYPES.has(snapshotType)
            ? 'current'
            : getFreshnessStatus(latestSnapshot.date),
          lastUpdated: latestSnapshot.date, // Use content date as primary
          scrapedAt: latestSnapshot.scrapedAt,
          itemCount: itemCount,
          date: latestSnapshot.date,
          source: 'HedgeyeDailySnapshot'
        };
      } else {
        results[snapshotType] = {
          status: 'missing',
          lastUpdated: null,
          itemCount: 0,
          date: null,
          source: 'HedgeyeDailySnapshot'
        };
      }
    }

    // 3. ETF Pro — local json (same as GET /api/hedgeye/etfpro)
    try {
      const { payload: etf, latestPath } = await getResolvedEtfProPayload();
      if (etf) {
        let { snapDate, rowCount, scraped } = resolveEtfProSnapshotForAnalytics(etf);
        if (!snapDate) {
          try {
            const st = fs.statSync(latestPath);
            if (st.mtime) {
              snapDate = st.mtime.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            }
          } catch (statErr) {
            console.warn('[API] ETF Pro freshness stat mtime failed:', statErr.message);
          }
        }
        if (!scraped) {
          try {
            scraped = fs.statSync(latestPath).mtime.toISOString();
          } catch (statErr2) {
            // leave scraped null
          }
        }
        results['etf-pro'] = {
          status: getFreshnessStatus(snapDate),
          lastUpdated: snapDate,
          scrapedAt: scraped,
          itemCount: rowCount,
          actionCount: etf.meta?.actionCount ?? undefined,
          date: snapDate,
          source: etf.meta?.source || 'EtfProLocal',
          headline: etf.meta?.headline || undefined,
          dataQuality: etf.dataQuality || undefined,
        };
      } else {
        results['etf-pro'] = results['etf-pro']?.date ? results['etf-pro'] : {
          status: 'missing',
          lastUpdated: null,
          itemCount: 0,
          date: null,
          source: 'EtfProLocal'
        };
      }
    } catch (err) {
      console.error('[API] Error reading ETF Pro for freshness:', err.message);
      results['etf-pro'] = { status: 'error', error: err.message };
    }

    results.volume = await volumeFreshnessRequest;

    // 4. Hermes Gmail ingestor — DynamoDB ledger of mailbox attachments.
    try {
      const hermesInbox = await getHermesInboxStatus();
      results['hermes-inbox'] = {
        status: hermesInbox.status === 'success' ? 'fresh' : hermesInbox.status,
        lastUpdated: hermesInbox.lastUpdated,
        scrapedAt: hermesInbox.lastUpdated,
        itemCount: hermesInbox.attachmentCount,
        storedCount: hermesInbox.storedCount,
        errorCount: hermesInbox.errorCount,
        pendingCount: hermesInbox.pendingCount,
        latestFilename: hermesInbox.latestFilename,
        latestS3Key: hermesInbox.latestS3Key,
        gmailAccount: hermesInbox.gmailAccount,
        gmailQuery: hermesInbox.gmailQuery,
        source: hermesInbox.source,
      };
    } catch (err) {
      console.error('[API] Error querying Hermes inbox ledger:', err.message);
      results['hermes-inbox'] = {
        status: 'error',
        error: err.message,
        source: HERMES_EMAIL_LEDGER_TABLE,
        gmailAccount: HERMES_GMAIL_ACCOUNT,
        gmailQuery: HERMES_GMAIL_QUERY,
      };
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hedgeye/freshness completed in ${totalTime}ms`);

    res.json({
      date: today,
      marketSession,
      dataTypes: results,
      alerts: alerts,
      meta: {
        queryTime: totalTime,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hedgeye/freshness after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch freshness data', details: error.message });
  }
});

async function buildWorkflowStatusResponse() {
  const workflowStatus = await buildWorkflowStatusSnapshot();
  if (legacyHermesIsReadOnly(legacyHermesMode)) {
    return stripLegacyHermesWorkflowFields(workflowStatus);
  }
  const hermesSnapshot = await getDirectorSnapshot({
    dynamodb,
    workflowSnapshot: workflowStatus,
  });
  workflowStatus.hermesDirector = hermesSnapshot.director;
  workflowStatus.hermesWorkers = hermesSnapshot.workers;
  workflowStatus.hermesAlerts = hermesSnapshot.alerts;
  workflowStatus.hermesTables = hermesSnapshot.tables;
  return workflowStatus;
}

async function buildHermesDirectorStatusResponse() {
  const workflowSnapshot = await buildWorkflowStatusSnapshot();
  const snapshot = await getDirectorSnapshot({
    dynamodb,
    workflowSnapshot,
  });
  return {
    ...snapshot,
    workflowSnapshot,
    workersCatalog: listWorkerDefinitions(),
    legacyMode: legacyHermesMode,
    readOnly: legacyHermesIsReadOnly(legacyHermesMode),
    retired: legacyHermesIsReadOnly(legacyHermesMode),
  };
}

// Workflow Status endpoint - returns status of automated workflows
app.get('/api/workflow-status', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/workflow-status called');
    const response = await sendCachedJson(res, 'workflow-status', buildWorkflowStatusResponse);
    console.log(`[API] /api/workflow-status completed in ${Date.now() - startTime}ms`);
    return response;
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/workflow-status after ${totalTime}ms:`, error);
    return res.status(500).json({ error: 'Failed to fetch workflow status', details: error.message });
  }
});

app.get('/api/hermes/director/status', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/hermes/director/status called');
    const response = await sendCachedJson(res, 'hermes-director-status', buildHermesDirectorStatusResponse);
    console.log(`[API] /api/hermes/director/status completed in ${Date.now() - startTime}ms`);
    return response;
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hermes/director/status after ${totalTime}ms:`, error);
    return res.status(500).json({
      error: 'Failed to fetch Hermes director status',
      details: error.message,
      tables: {
        runs: HERMES_AGENT_RUNS_TABLE,
        alerts: HERMES_ALERTS_TABLE,
      },
    });
  }
});

app.post('/api/hermes/director/command', async (req, res) => {
  if (legacyHermesIsReadOnly(legacyHermesMode)) {
    return rejectLegacyHermesMutation(res, legacyHermesMode);
  }
  const startTime = Date.now();
  try {
    const { command, payload = {} } = req.body || {};
    console.log('[API] /api/hermes/director/command called:', command);
    if (!command) {
      return res.status(400).json({ error: 'command is required' });
    }

    const workflowSnapshot = await buildWorkflowStatusSnapshot();
    const result = await executeDirectorCommand({
      dynamodb,
      lambdaClient: lambda,
      ses,
      command,
      payload,
      workflowSnapshot,
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hermes/director/command completed in ${totalTime}ms`);
    researchResponseCache.delete('workflow-status');
    researchResponseCache.delete('hermes-director-status');
    res.json(result);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hermes/director/command after ${totalTime}ms:`, error);
    res.status(500).json({
      error: 'Failed to execute Hermes command',
      details: error.message,
    });
  }
});

app.post('/api/hermes/alerts/:alertId/action', async (req, res) => {
  if (legacyHermesIsReadOnly(legacyHermesMode)) {
    return rejectLegacyHermesMutation(res, legacyHermesMode);
  }
  try {
    const { alertId } = req.params;
    const { action, hours } = req.body || {};
    if (!action) {
      return res.status(400).json({ error: 'action is required' });
    }

    let updates;
    if (action === 'resolve') {
      updates = { status: 'resolved', resolvedAt: new Date().toISOString() };
    } else if (action === 'acknowledge') {
      updates = { status: 'acknowledged' };
    } else if (action === 'snooze') {
      const snoozeHours = Number(hours) > 0 ? Number(hours) : 2;
      updates = {
        status: 'snoozed',
        snoozedUntil: new Date(Date.now() + snoozeHours * 60 * 60 * 1000).toISOString(),
      };
    } else {
      return res.status(400).json({ error: `Unsupported action: ${action}` });
    }

    const alert = await updateAlertRecord(dynamodb, alertId, updates);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const workflowSnapshot = await buildWorkflowStatusSnapshot();
    const snapshot = await getDirectorSnapshot({
      dynamodb,
      workflowSnapshot,
    });

    researchResponseCache.delete('workflow-status');
    researchResponseCache.delete('hermes-director-status');
    res.json({ alert, snapshot });
  } catch (error) {
    console.error('[API] Error updating Hermes alert:', error);
    res.status(500).json({
      error: 'Failed to update Hermes alert',
      details: error.message,
    });
  }
});

// Hedgeye preview media — stream S3/local file (stable URL, no presign expiry)
app.get('/api/hedgeye/screenshot/:date/content', async (req, res) => {
  const { date } = req.params;
  const snapshotType = req.query.type || 'risk-ranges';
  console.log(`[API] /api/hedgeye/screenshot/${date}/content?type=${snapshotType} called`);

  try {
    const media = await resolveHedgeyeMedia(dynamodb, date, snapshotType, {
      preferPdf: true,
      lambdaDir: path.join(__dirname, 'aws', 'lambda'),
    });

    if (!media) {
      return res.status(404).send('Screenshot not found for this date (checked S3 and local)');
    }

    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');

    if (media.source === 'local') {
      return res.sendFile(media.localPath);
    }

    const stream = s3
      .getObject({ Bucket: HEDGEYE_BUCKET, Key: media.s3Key })
      .createReadStream();

    stream.on('error', (err) => {
      console.error(`[API] S3 stream error for ${media.s3Key}:`, err.message);
      if (!res.headersSent) {
        res.status(502).send('Failed to load media from storage');
      } else {
        res.end();
      }
    });

    stream.pipe(res);
  } catch (error) {
    console.error(`[API] Error streaming hedgeye media:`, error);
    res.status(500).send('Failed to load media');
  }
});

// Hedgeye Screenshot metadata — returns stable content URL (proxied, not presigned)
app.get('/api/hedgeye/screenshot/:date', async (req, res) => {
  const { date } = req.params;
  const snapshotType = req.query.type || 'risk-ranges';
  console.log(`[API] /api/hedgeye/screenshot/${date}?type=${snapshotType} called`);

  try {
    const media = await resolveHedgeyeMedia(dynamodb, date, snapshotType, {
      preferPdf: true,
      lambdaDir: path.join(__dirname, 'aws', 'lambda'),
    });

    if (!media) {
      return res.status(404).json({ error: 'Screenshot not found for this date (checked S3 and local)' });
    }

    const contentUrl = buildHedgeyeContentUrlFromRequest(req, date, snapshotType);

    return res.json({
      url: contentUrl,
      s3Key: media.s3Key || null,
      localFilename: media.localFilename || null,
      source: media.source,
      date,
      type: media.mediaType,
      scrapedAt: media.scrapedAt || null,
    });
  } catch (error) {
    console.error(`[API] Error in hedgeye screenshot metadata:`, error);
    return res.status(500).json({ error: 'Failed to resolve screenshot', details: error.message });
  }
});

// New Endpoint: Serve local screenshots from aws/lambda
app.get('/api/local-screenshots/:filename', (req, res) => {
  const { filename } = req.params;
  const fs = require('fs');

  // Basic security: ensure filename is safe and strictly what we expect
  if (!filename.match(/^hedgeye_screenshot_[\d-]{10}_[\d]{6}\.png$/)) {
    return res.status(400).send('Invalid filename format');
  }

  const filePath = path.join(__dirname, 'aws', 'lambda', filename);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Hedgeye CSV endpoint - returns presigned S3 URL for CSV
app.get('/api/hedgeye/csv/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const type = req.query.type || 'risk-ranges'; // Default to risk-ranges for backward compatibility
    console.log(`[API] /api/hedgeye/csv/${date}?type=${type} called`);

    // Get snapshot from DynamoDB
    const snapshotParams = {
      TableName: 'HedgeyeDailySnapshot',
      Key: {
        date: date,
        snapshotType: type
      }
    };

    const snapshotResult = await dynamodb.get(snapshotParams).promise();

    if (!snapshotResult.Item) {
      return res.status(404).json({ error: 'Snapshot not found for this date and type' });
    }

    // LIST OF COLUMNS FOR EACH TYPE
    const COLUMNS = {
      'risk-ranges': ['ticker', 'lrr', 'close', 'hrr', 'trend'],
      'momo-tracker': [
        'ticker',
        'rangeStatus',
        'rangeStatusDate',
        'buyTrade',
        'sellTrade',
        'upside',
        'downside',
        'trend',
        'index'
      ]
    };

    // If we have data but no pre-generated CSV in S3 (or if we want to enforce sorting),
    // convert JSON to CSV on the fly.
    // For Momo Tracker, we enforce on-the-fly generation to ensure correct sorting by 'index'.
    if (type === 'momo-tracker' || !snapshotResult.Item.csvS3Key) {
      console.log(`[API] Generating CSV on-the-fly for ${type}`);
      const data = snapshotResult.Item.data || {};

      let items = [];
      if (type === 'momo-tracker') {
        items = buildMomoTrackerCsvRows(data);
      } else if (type === 'risk-ranges') {
        // Fallback logic for risk-ranges if needed
        items = Object.entries(data).map(([ticker, info]) => ({
          ticker,
          ...info
        }));
      }

      if (items.length === 0) {
        return res.status(404).json({ error: 'No data available to generate CSV' });
      }

      // Generate CSV string
      const headers = COLUMNS[type] || Object.keys(items[0]);
      const csvHeader = headers.join(',');
      const csvRows = items.map(item => {
        return headers.map(header => {
          // Handle special cases or generic string
          let val = item[header];
          if (val === undefined || val === null) val = '';
          return `"${val}"`;
        }).join(',');
      });

      const csvContent = [csvHeader, ...csvRows].join('\n');

      // Send as file download
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="hedgeye_${type}_${date}.csv"`);
      return res.send(csvContent);
    }

    // Default behavior: Redirect to S3 presigned URL (for existing risk-ranges files)
    const s3Key = snapshotResult.Item.csvS3Key;

    // Generate presigned URL (1 hour expiration)
    const params = {
      Bucket: 'market-dashboard-csv-data',
      Key: s3Key,
      Expires: 3600, // 1 hour
      ResponseContentDisposition: `attachment; filename="hedgeye_${type}_${date}.csv"`
    };

    const presignedUrl = await s3.getSignedUrlPromise('getObject', params);

    console.log(`[API] Generated presigned URL for CSV: ${s3Key}`);
    res.json({
      url: presignedUrl,
      s3Key: s3Key,
      date: date,
      scrapedAt: snapshotResult.Item.scrapedAt
    });

  } catch (error) {
    console.error('[API] Error in /api/hedgeye/csv:', error);
    res.status(500).json({ error: 'Failed to get CSV URL', details: error.message });
  }
});

// Hedgeye ETF Pro endpoint - serves the latest Gmail action snapshot or local workbook snapshot.
// Also computes day-over-day changes (adds/removes) for Longs and Shorts when local rows are available.
function buildEtfProCheckpointFirstResponse() {
  const checkpointRecord = loadLocalEtfProCheckpoint();
  return buildFastEtfProCheckpointResponse(checkpointRecord?.checkpoint || null);
}

async function buildEtfProResponse() {
  const { payload: parsed, etfproDir, latestPath, localPayload, emailPayload } = await getResolvedEtfProPayload();
  if (!parsed) {
    const error = new Error('ETF Pro snapshot not found');
    error.statusCode = 404;
    error.responseBody = {
      error: 'ETF Pro snapshot not found',
      hint: 'Run: npm run collect:etfpro',
      path: latestPath,
    };
    throw error;
  }
  if (parsed.available === false && (
    parsed.meta?.blockedByIngestion
    || parsed.meta?.blockedByCanonicalSource
    || parsed.meta?.blockedByResearchEventReplay
  )) {
    return parsed;
  }

  // Find previous day's snapshot for diffing
  let changes = null;
  try {
    const todayDate = parsed.meta?.snapshotDate || null;
    const dated = fs.readdirSync(etfproDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .filter(d => d !== todayDate)
      .sort()
      .reverse();

    if (dated.length > 0) {
      const prevPath = path.join(etfproDir, `${dated[0]}.json`);
      const prevParsed = JSON.parse(fs.readFileSync(prevPath, 'utf-8'));

      const classify = (rows) => {
        const longs = new Set();
        const shorts = new Set();
        for (const r of rows) {
          const ticker = String(r.ticker || '').trim().toUpperCase();
          if (!ticker) continue;
          if (String(r.call).toLowerCase() === 'short') {
            shorts.add(ticker);
          } else {
            longs.add(ticker);
          }
        }
        return { longs, shorts };
      };

      const today = classify(parsed.rows || []);
      const prev = classify(prevParsed.rows || []);

      changes = {
        previousDate: dated[0],
        addedLongs: [...today.longs].filter(t => !prev.longs.has(t)),
        removedLongs: [...prev.longs].filter(t => !today.longs.has(t)),
        addedShorts: [...today.shorts].filter(t => !prev.shorts.has(t)),
        removedShorts: [...prev.shorts].filter(t => !today.shorts.has(t)),
      };
    }
  } catch (diffErr) {
    console.warn('[API] Could not compute ETF Pro day-over-day diff:', diffErr.message);
  }

  parsed.changes = parsed.changes || changes;
  if (emailPayload?.changes && parsed.meta?.source === 'gmail-html-applied-to-local-book') {
    parsed.changes = emailPayload.changes;
  }
  if (localPayload?.meta?.snapshotDate && parsed.meta?.source === 'gmail-html-applied-to-local-book') {
    parsed.meta.previousFullBookDate = localPayload.meta.snapshotDate;
  }
  return parsed;
}

app.get('/api/hedgeye/etfpro', async (req, res) => {
  try {
    return await sendCheckpointFirstJson(res, {
      key: 'etf-pro',
      checkpointValue: buildEtfProCheckpointFirstResponse(),
      loadAuthoritative: buildEtfProResponse,
      onRefreshError: (error, currentValue) =>
        failClosedResearchRefresh(currentValue, error),
    });
  } catch (error) {
    console.error('[API] Error in /api/hedgeye/etfpro:', error);
    if (error.statusCode === 404) {
      return res.status(404).json(error.responseBody);
    }
    return res.status(500).json({ error: 'Failed to load ETF Pro snapshot', details: error.message });
  }
});

// Persist ETF Pro snapshot (parsed client-side from .xlsx, same on-disk format as collect:etfpro)
app.post('/api/hedgeye/etfpro', (req, res) => {
  const MAX_ROWS = 5000;
  try {
    const { rows, filename: sourceFilename } = req.body || {};
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'Request body must include a "rows" array' });
    }
    if (rows.length === 0) {
      return res.status(400).json({ error: 'rows array is empty' });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: `rows exceeds maximum (${MAX_ROWS})` });
    }
    for (const r of rows) {
      if (!r || typeof r !== 'object' || !String(r.ticker || '').trim()) {
        return res.status(400).json({ error: 'Each row must be an object with a non-empty ticker' });
      }
    }

    const parsedAt = new Date().toISOString();
    const snapshotDate = determineEtfProSnapshotDate(rows, parsedAt);
    const etfproDir = path.join(__dirname, 'data', 'hedgeye', 'etfpro');
    fs.mkdirSync(etfproDir, { recursive: true });

    const payload = {
      meta: {
        snapshotDate,
        parsedAt,
        source: 'upload',
        sourceFilename: sourceFilename != null ? String(sourceFilename) : null,
        rowCount: rows.length
      },
      rows
    };

    const datedPath = path.join(etfproDir, `${snapshotDate}.json`);
    const latestPath = path.join(etfproDir, 'latest.json');
    const json = JSON.stringify(payload, null, 2);
    fs.writeFileSync(datedPath, json);
    fs.writeFileSync(latestPath, json);
    console.log(`[API] POST /api/hedgeye/etfpro wrote ${datedPath} (${rows.length} rows, snapshotDate=${snapshotDate})`);

    checkpointFirstResearchResponse.invalidate('etf-pro');
    researchResponseCache.delete('readiness:etf-pro');
    researchResponseCache.delete('changelog');
    researchResponseCache.delete('analytics-daily-brief');
    researchResponseCache.delete('workflow-status');
    researchResponseCache.delete('hermes-director-status');
    return res.json({ ok: true, meta: payload.meta });
  } catch (error) {
    console.error('[API] Error in POST /api/hedgeye/etfpro:', error);
    return res.status(500).json({ error: 'Failed to save ETF Pro snapshot', details: error.message });
  }
});

// Morning TL;DR archive. The archive is reconstructed from the canonical
// dated HedgeyeDailySnapshot rows; no duplicate aggregate records or S3
// objects are written. Exact-date reads deliberately fail closed when a
// publication is missing instead of carrying a prior edition forward.
app.get('/api/hedgeye/tldr/archive', async (req, res) => {
  try {
    const archive = await buildMorningTldrArchive(dynamodb, {
      visibleDays: TLDR_ARCHIVE_VISIBLE_DAYS,
      retentionDays: TLDR_ARCHIVE_RETENTION_DAYS,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(archive);
  } catch (error) {
    console.error('[API] Error building Morning TL;DR archive:', error);
    return res.status(500).json({
      error: 'Failed to fetch the Morning TL;DR archive',
      code: error.code || 'TLDR_ARCHIVE_UNAVAILABLE',
    });
  }
});

app.get('/api/hedgeye/tldr/archive/:date/status', async (req, res) => {
  let parsedDate;
  try {
    parsedDate = assertArchiveDate(req.params.date);
  } catch (error) {
    return res.status(400).json({ error: error.message, code: error.code || 'INVALID_TLDR_DATE' });
  }

  if (!isMarketDay(parsedDate)) {
    return res.status(404).json({
      error: 'No market-day TL;DR publication status exists for this date',
      date: req.params.date,
      code: 'TLDR_MARKET_DAY_NOT_FOUND',
    });
  }

  try {
    const status = await buildMorningTldrStatus(dynamodb, req.params.date, {
      snapshotTableName: process.env.HEDGEYE_DAILY_SNAPSHOT_TABLE || 'HedgeyeDailySnapshot',
      manifestTableName: RESEARCH_PRODUCT_MANIFEST_TABLE,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(status);
  } catch (error) {
    console.error(`[API] Error building Morning TL;DR status ${req.params.date}:`, error);
    return res.status(500).json({
      error: 'Failed to fetch the Morning TL;DR publication status',
      code: error.code || 'TLDR_STATUS_UNAVAILABLE',
    });
  }
});

app.get('/api/hedgeye/tldr/archive/:date', async (req, res) => {
  let parsedDate;
  try {
    parsedDate = assertArchiveDate(req.params.date);
  } catch (error) {
    return res.status(400).json({ error: error.message, code: error.code || 'INVALID_TLDR_DATE' });
  }

  if (!isMarketDay(parsedDate)) {
    return res.status(404).json({
      error: 'No market-day TL;DR edition exists for this date',
      date: req.params.date,
      code: 'TLDR_MARKET_DAY_NOT_FOUND',
    });
  }

  try {
    const day = await buildMorningTldrDay(dynamodb, req.params.date, {
      retentionDays: TLDR_ARCHIVE_RETENTION_DAYS,
    });
    if (!day) {
      return res.status(404).json({
        error: 'No TL;DR publication is saved for this date',
        date: req.params.date,
        code: 'TLDR_DATE_NOT_FOUND',
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json(day);
  } catch (error) {
    console.error(`[API] Error building Morning TL;DR edition ${req.params.date}:`, error);
    return res.status(500).json({
      error: 'Failed to fetch the Morning TL;DR edition',
      code: error.code || 'TLDR_DAY_UNAVAILABLE',
    });
  }
});

// Hedgeye CPI nowcast history. This is historical/model research only; it is
// deliberately separate from live prediction-market quote and order routes.
app.get('/api/hedgeye/inflation-nowcast/history', async (req, res) => {
  const from = req.query.from ? String(req.query.from).trim() : null;
  const to = req.query.to ? String(req.query.to).trim() : null;
  try {
    const snapshotCache = await researchResponseCache.get(
      'hedgeye:inflation-nowcast:history:snapshots',
      () => queryLatestSnapshotsByType('inflation-nowcast', { limit: 200 }),
    );
    const response = buildCpiNowcastHistory(snapshotCache.value || [], {
      from,
      to,
      now: new Date(),
    });
    setDataCacheHeaders(res, snapshotCache);
    return res.json(response);
  } catch (error) {
    if (error.code === 'CPI_HISTORY_RANGE_INVALID') {
      return res.status(400).json({
        error: error.message,
        code: error.code,
      });
    }
    console.error('[API] Failed to build Hedgeye inflation nowcast history:', error);
    return res.status(500).json({
      error: 'Failed to fetch Hedgeye inflation nowcast history',
      code: error.code || 'CPI_HISTORY_UNAVAILABLE',
    });
  }
});

// Private Market Structure chart proxy. The dashboard principal can read only
// the dedicated asset prefix; raw email keys and S3 object names stay server-side.
app.get('/api/hedgeye/market-structure/:date/charts/:chartId', async (req, res) => {
  const date = String(req.params.date || '').trim();
  const chartId = String(req.params.chartId || '').trim().toLowerCase();
  if (!isMarketStructureIsoDate(date)) {
    return res.status(400).json({
      error: 'Market Structure chart date must use YYYY-MM-DD.',
      code: 'MARKET_STRUCTURE_DATE_INVALID',
    });
  }

  try {
    const result = await dynamodb.get({
      TableName: 'HedgeyeDailySnapshot',
      Key: { date, snapshotType: 'market-structure' },
      ConsistentRead: false,
    }).promise();
    let chart;
    try {
      chart = resolveMarketStructureChartAsset(result.Item || null, date, chartId);
    } catch (error) {
      if (error.code === 'MARKET_STRUCTURE_CHART_ID_INVALID') {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      throw error;
    }
    if (!chart) {
      return res.status(404).json({
        error: 'Market Structure chart not found',
        code: 'MARKET_STRUCTURE_CHART_NOT_FOUND',
      });
    }

    const object = await s3.getObject({
      Bucket: HEDGEYE_BUCKET,
      Key: chart.s3Key,
    }).promise();
    res.setHeader('Content-Type', chart.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${safeMarketStructureFilename(chart.name, chart.contentType)}"`,
    );
    if (object.ContentLength != null) {
      res.setHeader('Content-Length', String(object.ContentLength));
    }
    return res.status(200).send(object.Body);
  } catch (error) {
    if (['NoSuchKey', 'NotFound'].includes(error.code)) {
      return res.status(404).json({
        error: 'Market Structure chart not found',
        code: 'MARKET_STRUCTURE_CHART_NOT_FOUND',
      });
    }
    console.error(`[API] Failed to stream Market Structure chart ${date}/${chartId}:`, error);
    return res.status(500).json({
      error: 'Failed to fetch Market Structure chart',
      code: 'MARKET_STRUCTURE_CHART_UNAVAILABLE',
    });
  }
});

// Hedgeye Snapshot Data endpoint - returns full extracted data for any snapshot type
const { loadGlobalQuads } = require('./src/services/globalQuadsService.cjs');
const { createQuadResearchHandler } = require('./src/routes/quadResearch.cjs');
app.get('/api/research/quad-ranks', createQuadResearchHandler());
const hedgaiResearchHandlers = createHedgaiResearchHandlers({
  loadResearch: loadHedgaiResearch, loadBaseline: loadReviewedBaseline, root: __dirname,
});
app.get('/api/research/hedgai', hedgaiResearchHandlers.research);
app.get('/api/research/hedgai/source/:sourceId', hedgaiResearchHandlers.source);
app.get('/api/hedgeye/snapshot/global-quads', async (_req, res) => {
  try {
    const result = await researchResponseCache.get('global-quads', () => loadGlobalQuads(dynamodb));
    return res.json(result.value);
  } catch (_error) {
    return res.status(503).json({ error: 'Global Quads unavailable' });
  }
});
const { loadMonthlyQuads } = require('./src/services/monthlyQuadService.cjs');
app.get('/api/hedgeye/monthly-quad', async (_req, res) => {
  try {
    const result = await researchResponseCache.get('monthly-quad', () => loadMonthlyQuads({
      listEvents: async (since) => {
        const { items, error } = await getResearchEventLedgerItems('etf-pro', { sinceEventTime: since });
        if (error) throw new Error(error);
        return items;
      },
      readArtifact: (s3Key) => getCachedHermesArtifactText({ s3Key }),
    }));
    return res.json(result.value);
  } catch (_error) {
    return res.status(503).json({ error: 'Monthly Quad unavailable' });
  }
});
app.get('/api/hedgeye/global-quads/source/:sourceId', async (req, res) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.sourceId)) return res.sendStatus(404);
  try {
    const result = await dynamodb.get({ TableName: 'HedgeyeDailySnapshot', Key: { date: 'LATEST', snapshotType: 'global-quads' } }).promise();
    const source = result.Item?.data?.sources?.[req.params.sourceId];
    if (!source || !new RegExp(`^hedgeye-email/assets/global-quads/${req.params.sourceId}\\.(png|jpg)$`).test(source.s3Key || '')) return res.sendStatus(404);
    const object = await s3.getObject({ Bucket: process.env.HERMES_S3_BUCKET || 'market-dashboard-csv-data', Key: source.s3Key }).promise();
    res.set('Content-Type', source.s3Key.endsWith('.png') ? 'image/png' : 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    return res.send(object.Body);
  } catch (_error) { return res.sendStatus(404); }
});

// Sparse, explicitly published commodity Trends remain dated research evidence
// when later reports omit them. This never supplies quote or executable data.
app.get('/api/dashboard/research-narrative', async (_req, res) => {
  try {
    const date = defaultResearchMarketDate(new Date());
    const result = await researchResponseCache.get(`dashboard:research-narrative:${date}`, async () => {
      const { normalizeDashboardNarrativeResearch } = require('./src/utils/dashboardNarrativeResearch.cjs');
      const [snapshots, tracker, cryptoQuant] = await Promise.all([
        queryLatestSnapshotsByType('early-look', { limit: 60 }),
        queryLatestSnapshotsByType('bitcoin-trend-tracker', { limit: 60 }),
        queryLatestSnapshotsByType('crypto-quant', { limit: 60 }),
      ]);
      return {
        schemaVersion: 1,
        verified: true,
        source: 'early-look-archive',
        readings: normalizeDashboardNarrativeResearch(snapshots, { date }),
        cryptoPublications: [...cryptoQuant, ...tracker].map(({ article, data, ...publication }) => ({
          ...publication,
          article: { feedUrl: article?.feedUrl },
          data: { cryptos: data?.cryptos },
        })),
      };
    });
    setDataCacheHeaders(res, result);
    return res.json(result.value);
  } catch (error) {
    console.error('[API] Archived dashboard research unavailable:', error.message);
    return res.status(503).json({ error: 'Published research unavailable' });
  }
});

app.get('/api/hedgeye/snapshot/:snapshotType', async (req, res) => {
  const startTime = Date.now();
  const { snapshotType } = req.params;
  const date = req.query.date; // Optional date, defaults to latest
  const cacheKey = `hedgeye:snapshot:${String(snapshotType || '').trim()}:${date || 'latest'}`;

  console.log(`[API] /api/hedgeye/snapshot/${snapshotType}?date=${date} called`);

  try {
    // Snapshot payloads are immutable dated research artifacts. Cache the
    // bounded response for five minutes so dashboard polling does not repeat
    // the same multi-KB DynamoDB read. For latest requests, use the
    // snapshotType/date GSI first instead of probing seven dates (which was
    // especially wasteful for weekly products such as CFTC positioning).
    // Today's Macro Show must reach the predictive rollup as soon as it is pulled.
    if (String(snapshotType || '').trim() === 'the-macro-show' && !date && inMacroShowWindow(Date.now())) {
      researchResponseCache.delete(cacheKey);
    }
    const cacheResult = await researchResponseCache.get(cacheKey, async () => {
      let item = null;
      if (date) {
        const result = await dynamodb.get({
          TableName: 'HedgeyeDailySnapshot',
          Key: { date, snapshotType },
        }).promise();
        item = result.Item || null;
      } else {
        item = (await queryLatestSnapshotsByType(snapshotType, { limit: 1 }))[0] || null;
      }

      if (!item) return null;
      const response = {
        date: item.date,
        reportDate: item.reportDate,
        snapshotType,
        schemaVersion: item.schemaVersion,
        contentComplete: item.contentComplete,
        decisionEligible: item.decisionEligible,
        metricsCount: item.metricsCount,
        availableMetricsCount: item.availableMetricsCount,
        scrapedAt: item.scrapedAt,
        retrievedAt: item.retrievedAt,
        publishedAt: item.publishedAt,
        source: item.source,
        sourceUrl: item.sourceUrl,
        sourceUrls: item.sourceUrls,
        apiUrls: item.apiUrls,
        datasetIds: item.datasetIds,
        calculationVersion: item.calculationVersion,
        windowContract: item.windowContract,
        sourceContentHash: item.sourceContentHash,
        data: item.data,
        trendChanges: item.trendChanges,
        outbucket: item.outbucket,
        meta: {
          riskRangeCount: item.riskRangeCount,
          stockCount: item.stockCount,
          cryptoCount: item.cryptoCount,
          rankingCount: item.rankingCount,
          itemCount: item.itemCount,
          forecastCount: item.forecastCount,
          signalCount: item.signalCount,
          chartCount: item.chartCount,
        },
        article: item.article,
        htmlSource: item.htmlSource,
        reportType: item.reportType,
        warnings: item.warnings,
        sourceQuality: item.sourceQuality,
        rangeValidation: item.rangeValidation,
        sourceProduct: item.sourceProduct,
        sourcePriority: item.sourcePriority,
        pdfSource: item.pdfSource,
        screenshotS3Key: item.screenshotS3Key,
      };
      return snapshotType === 'market-structure'
        ? buildPublicMarketStructureSnapshot(response)
        : response;
    });
    setDataCacheHeaders(res, cacheResult);

    if (!cacheResult.value) {
      return res.status(404).json({ error: 'Snapshot not found', snapshotType, date });
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hedgeye/snapshot/${snapshotType} completed in ${totalTime}ms`);
    if (snapshotType === 'cftc-positioning') {
      return res.json({
        ...cacheResult.value,
        cacheState: cacheResult.status,
        decisionEligible: cacheResult.status === 'stale'
          ? false
          : cacheResult.value.decisionEligible,
        warnings: cacheResult.status === 'stale'
          ? [...(cacheResult.value.warnings || []), 'STALE_CACHE_REFERENCE_ONLY']
          : cacheResult.value.warnings,
      });
    }
    return res.json(cacheResult.value);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hedgeye/snapshot/${snapshotType} after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch snapshot', details: error.message });
  }
});

function buildRtaCheckpointFirstResponse() {
  const rtaBenchmark = loadLocalRtaBenchmark();
  return buildFastRtaCheckpointResponse(rtaBenchmark);
}

async function buildRealTimeAlertPositionsResponse() {
  const windowDays = 90;
  const rtaBenchmark = loadLocalRtaBenchmark();
  const authoritativeCheckpointTime = rtaBenchmark?.checkpointValidation?.valid
    ? rtaBenchmark.asOf
    : null;
  // ResearchEventLedgerV2 is canonical for migrated messages. The immutable
  // Gmail/S3 archive fills only uncovered source-message gaps; daily snapshots
  // remain rebuildable projections and never replace either event source.
  const [materialized, ingestionHealth] = await Promise.all([
    fetchHermesRtaSnapshots(windowDays, { authoritativeCheckpointTime }),
    getGmailPollHealth().catch((error) => ({
      status: 'unhealthy',
      healthy: false,
      verified: false,
      errorCode: error.code || 'GMAIL_HEARTBEAT_UNAVAILABLE',
      reason: error.message || 'Gmail ingestion health could not be loaded.',
      observedAt: null,
      lastSuccessAt: null,
      source: 'service-heartbeat-table',
    })),
  ]);

  const summary = summarizeRealTimeAlertPositions(materialized.snapshots, {
    windowDays,
    baseline: rtaBenchmark,
    resolutions: loadRtaResolutions(path.join(__dirname, 'data', 'hedgeye', 'rta', 'resolutions.json')),
  });
  if (!rtaBenchmark?.checkpointValidation?.valid) {
    const reasons = rtaBenchmark?.checkpointValidation?.reasons || ['checkpoint-missing'];
    const warning = `RTA authoritative checkpoint is required (${reasons.join(', ')}).`;
    summary.available = false;
    summary.longCount = null;
    summary.shortCount = null;
    summary.ratioText = null;
    summary.netBias = null;
    summary.holdings = [];
    summary.positionSourceConfidence = 'low';
    summary.dataQuality = {
      ...(summary.dataQuality || {}),
      status: 'error',
      warnings: [...new Set([...(summary.dataQuality?.warnings || []), warning])],
      invalidEvents: [
        ...(summary.dataQuality?.invalidEvents || []),
        {
          code: 'RTA_CHECKPOINT_REQUIRED',
          sourceMessageId: null,
          message: warning,
        },
      ],
    };
  }
  if (materialized.rejected.length > 0) {
    const rejectionWarnings = materialized.rejected.map((rejection) => {
      const sourceMessageId = rejection.sourceMessageId || rejection.messageId || 'unknown';
      return `RTA source message ${sourceMessageId} could not be materialized (${rejection.code}).`;
    });
    summary.available = false;
    summary.longCount = null;
    summary.shortCount = null;
    summary.ratioText = null;
    summary.netBias = null;
    summary.holdings = [];
    summary.positionSourceConfidence = 'low';
    summary.dataQuality = {
      ...(summary.dataQuality || {}),
      status: 'error',
      warnings: [...new Set([...(summary.dataQuality?.warnings || []), ...rejectionWarnings])],
      invalidEvents: [
        ...(summary.dataQuality?.invalidEvents || []),
        ...materialized.rejected.map((rejection) => ({
          code: rejection.code,
          sourceMessageId: rejection.sourceMessageId || rejection.messageId || null,
          message: rejectionWarnings.find((warning) =>
            warning.includes(rejection.sourceMessageId || rejection.messageId || 'unknown')),
        })),
      ],
    };
  }
  summary.sourceDiagnostics = {
    dailySnapshotCount: 0,
    hermesEventSnapshotCount: materialized.snapshots.length,
    selectedMessageCount: materialized.selectedMessageCount,
    materializedEventCount: materialized.materializedEventCount,
    v2EventCount: materialized.v2EventCount,
    legacyMigrationEventCount: materialized.legacyEventCount,
    researchEventLedgerError: materialized.eventLedgerError,
    canonicalCoverageGapCount: materialized.canonicalCoverageGaps?.length || 0,
    canonicalCoverageGaps: materialized.canonicalCoverageGaps || [],
    supersededCanonicalCoverageGapCount:
      materialized.supersededCanonicalCoverageGaps?.length || 0,
    supersededRejectedMessageCount: materialized.supersededRejections?.length || 0,
    rejectedMessageCount: materialized.rejected.length,
    reconstructionInput: materialized.v2EventCount > 0
      ? 'research-event-ledger-v2-with-legacy-migration'
      : 'gmail-ledger-s3-legacy-migration',
    positionSource: summary.positionSource,
    positionSourceConfidence: summary.positionSourceConfidence,
    benchmark: summary.baseline,
    checkpointValidation: rtaBenchmark?.checkpointValidation || { valid: false, reasons: ['checkpoint-missing'] },
    reconstructionWarnings: summary.reconstructionWarnings || [],
    gmailIngestion: {
      status: ingestionHealth.status || 'unknown',
      healthy: ingestionHealth.healthy === true,
      verified: ingestionHealth.verified === true,
      observedAt: ingestionHealth.observedAt || null,
      lastSuccessAt: ingestionHealth.lastSuccessAt || null,
      errorCode: ingestionHealth.errorCode || null,
      reason: ingestionHealth.reason || null,
      source: ingestionHealth.source || 'service-heartbeat-table',
    },
  };
  return applyRtaCanonicalComparisonGate(summary, {
    ingestionHealth,
    canonicalLedgerError: materialized.eventLedgerError,
    canonicalCoverageGaps: materialized.canonicalCoverageGaps,
    authoritativeCheckpoint: rtaBenchmark,
  });
}

app.get('/api/hedgeye/real-time-alert/positions', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/hedgeye/real-time-alert/positions called');
    const response = await sendCheckpointFirstJson(res, {
      key: 'rta-positions:90',
      checkpointValue: buildRtaCheckpointFirstResponse(),
      loadAuthoritative: buildRealTimeAlertPositionsResponse,
      onRefreshError: (error, currentValue) =>
        failClosedResearchRefresh(currentValue, error),
    });
    console.log(`[API] /api/hedgeye/real-time-alert/positions completed in ${Date.now() - startTime}ms`);
    return response;
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hedgeye/real-time-alert/positions after ${totalTime}ms:`, error);
    return res.status(500).json({
      error: 'Failed to reconstruct real-time alert positions',
      details: error.message,
    });
  }
});

// Hedgeye Changelog endpoint - returns added/removed items for each data type
async function buildHedgeyeChangelogResponse() {
  const startTime = Date.now();
  try {
    console.log('[API] /api/hedgeye/changelog called');

    const snapshotTypes = [
      'risk-ranges',
      'early-look',
      'bitcoin-trend-tracker',
      'momo-tracker',
      'signal-strength',
      'portfolio-solutions',
      'the-macro-show',
      'the-call',
      'real-time-alert',
      'volume',
      'market-structure',
      'cftc-positioning'
    ];

    const results = {};

    // Use the two most recent actual publications for every product. The old
    // seven-calendar-day lookup treated weekly/irregular products as if they
    // had no comparison history and generated false "no change" states.
    const snapshotHistoryByType = Object.fromEntries(
      await Promise.all(snapshotTypes.map(async (type) => {
        const rows = await queryLatestSnapshotsByType(type, { limit: 2 });
        const unique = rows.filter((snapshot, index, all) => (
          snapshot?.date
          && index === all.findIndex((row) => row.date === snapshot.date)
        ));
        return [type, unique];
      })),
    );

    const normalizeRealTimeAlerts = (snapshot) => {
      const data = snapshot?.data || {};
      if (Array.isArray(data.alerts)) return data.alerts.filter(Boolean);
      if (data.alert) return [data.alert].filter(Boolean);
      return [];
    };

    const getSnapshotEventTime = (snapshot) => (
      snapshot?.publishedAt ||
      snapshot?.scrapedAt ||
      snapshot?.receivedAt ||
      snapshot?.createdAt ||
      snapshot?.updatedAt ||
      snapshot?.date ||
      null
    );

    const getSnapshotMeta = (snapshot) => ({
      scrapedAt: snapshot?.scrapedAt || snapshot?.receivedAt || snapshot?.createdAt || snapshot?.updatedAt || null,
      publishedAt: snapshot?.publishedAt || null,
      eventTime: getSnapshotEventTime(snapshot),
    });

    // Process each type in parallel
    await Promise.all(snapshotTypes.map(async (type) => {
      try {
        const recentSnapshots = snapshotHistoryByType[type] || [];

        if (recentSnapshots.length < 2) {
          // Real-time alerts are event snapshots, so one current alert is enough.
          if (type === 'real-time-alert' && recentSnapshots.length === 1) {
            const current = recentSnapshots[0];
            const alerts = normalizeRealTimeAlerts(current);
            results[type] = {
              added: alerts.map(a => a.ticker || a.headline || a.signalPhrase).filter(Boolean),
              removed: [],
              alerts,
              available: alerts.length > 0,
              comparisonStatus: 'insufficient_history',
              currentDate: current.date,
              ...getSnapshotMeta(current),
            };
            return;
          }

          // For signal-strength, use explicit added/removed from the PDF even with just 1 snapshot
          if (type === 'signal-strength' && recentSnapshots.length === 1) {
            const current = recentSnapshots[0];
            const explicitAdded = (current.data?.added && Array.isArray(current.data.added)) ? current.data.added : [];
            const explicitRemoved = (current.data?.removed && Array.isArray(current.data.removed)) ? current.data.removed : [];
          results[type] = {
            added: explicitAdded,
            removed: explicitRemoved,
            available: true,
            comparisonStatus: 'insufficient_history',
            currentDate: current.date,
            ...getSnapshotMeta(current),
          };
          return;
        }

          // For cftc-positioning, extract significant Z-scores even with just 1 snapshot
          if (type === 'cftc-positioning' && recentSnapshots.length === 1) {
            const current = recentSnapshots[0];
            const significantPositive = [];
            const significantNegative = [];

            if (current.data && Array.isArray(current.data)) {
              current.data.forEach(metric => {
                // Handle DynamoDB Decimal type or regular numbers
                const z1yRaw = metric.zScore1Y;
                const z3yRaw = metric.zScore3Y;

                const z1y = z1yRaw !== undefined && z1yRaw !== null
                  ? (typeof z1yRaw === 'object' && z1yRaw.toNumber ? z1yRaw.toNumber() : parseFloat(z1yRaw))
                  : null;
                const z3y = z3yRaw !== undefined && z3yRaw !== null
                  ? (typeof z3yRaw === 'object' && z3yRaw.toNumber ? z3yRaw.toNumber() : parseFloat(z3yRaw))
                  : null;

                if (z1y > 2.0 || z3y > 2.0) {
                  significantPositive.push({
                    metric: metric.metric,
                    category: metric.category,
                    zScore1Y: z1y,
                    zScore3Y: z3y,
                    latest: metric.latest,
                    wwChg: metric.wwChg
                  });
                } else if (z1y < -2.0 || z3y < -2.0) {
                  significantNegative.push({
                    metric: metric.metric,
                    category: metric.category,
                    zScore1Y: z1y,
                    zScore3Y: z3y,
                    latest: metric.latest,
                    wwChg: metric.wwChg
                  });
                }
              });
            }

            // Sort by most extreme first
            significantPositive.sort((a, b) => Math.max(b.zScore1Y || 0, b.zScore3Y || 0) - Math.max(a.zScore1Y || 0, a.zScore3Y || 0));
            significantNegative.sort((a, b) => Math.min(a.zScore1Y || 0, a.zScore3Y || 0) - Math.min(b.zScore1Y || 0, b.zScore3Y || 0));

            results[type] = {
              available: true,
              comparisonStatus: 'insufficient_history',
              currentDate: current.date,
              ...getSnapshotMeta(current),
              significantPositive,
              significantNegative
            };
            console.log(`[Changelog] CFTC with 1 snapshot - positive: ${significantPositive.length}, negative: ${significantNegative.length}`);
            return;
          }

          results[type] = {
            added: [],
            removed: [],
            available: recentSnapshots.length > 0,
            comparisonStatus: recentSnapshots.length > 0 ? 'insufficient_history' : 'missing',
            currentDate: recentSnapshots.length > 0 ? recentSnapshots[0].date : null,
            ...(recentSnapshots.length > 0 ? getSnapshotMeta(recentSnapshots[0]) : {}),
          };
          return;
        }

        const current = recentSnapshots[0];
        const previous = recentSnapshots[1];

        // Debug logging for risk-ranges
        if (type === 'risk-ranges') {
          console.log('[Changelog] risk-ranges current snapshot keys:', Object.keys(current));
          console.log('[Changelog] Has trendChanges?', 'trendChanges' in current);
          console.log('[Changelog] trendChanges value:', current.trendChanges);
        }

        // Extract items based on type
        const getItems = (snapshot) => {
          if (!snapshot || !snapshot.data) return [];

          if (type === 'risk-ranges' || type === 'momo-tracker') {
            return Object.keys(snapshot.data);
          } else if (type === 'early-look') {
            if (snapshot.data) return Object.keys(snapshot.data);
            return [];
          } else if (type === 'bitcoin-trend-tracker') {
            const cryptos = snapshot.data.cryptos ? Object.keys(snapshot.data.cryptos) : [];
            const stocks = snapshot.data.stocks ? Object.keys(snapshot.data.stocks) : [];
            return [...cryptos, ...stocks];
          } else if (type === 'signal-strength') {
            return (snapshot.data.stocks || []).map(s => s.ticker);
          } else if (type === 'portfolio-solutions') {
            return (snapshot.data.rankings || []).map(r => r.ticker);
          } else if (type === 'the-macro-show' || type === 'the-call') {
            return [
              ...(snapshot.data.longs || []),
              ...(snapshot.data.shorts || []),
              ...(snapshot.data.neutrals || [])
            ];
          } else if (type === 'real-time-alert') {
            return normalizeRealTimeAlerts(snapshot)
              .map(a => a.ticker || a.headline || a.signalPhrase)
              .filter(Boolean);
          }
          return [];
        };

        const currentItems = getItems(current);
        const previousItems = getItems(previous);

        const added = currentItems.filter(item => !previousItems.includes(item));
        let removed = previousItems.filter(item => !currentItems.includes(item));

        // Updates logic (Trend Changes)
        let updates = [];
        if (current.data && previous.data) {
          // Trend Changes: Risk Ranges, Momo, Bitcoin
          if (type === 'risk-ranges' || type === 'momo-tracker' || type === 'bitcoin-trend-tracker') {
            const commonItems = currentItems.filter(item => previousItems.includes(item));

            commonItems.forEach(item => {
              let currData, prevData;

              if (type === 'bitcoin-trend-tracker') {
                // Check cryptos
                if (current.data.cryptos && current.data.cryptos[item]) currData = current.data.cryptos[item];
                else if (current.data.stocks && current.data.stocks[item]) currData = current.data.stocks[item];

                if (previous.data.cryptos && previous.data.cryptos[item]) prevData = previous.data.cryptos[item];
                else if (previous.data.stocks && previous.data.stocks[item]) prevData = previous.data.stocks[item];
              } else {
                currData = current.data[item];
                prevData = previous.data[item];
              }

              if (currData && prevData && currData.trend && prevData.trend) {
                if (currData.trend !== prevData.trend) {
                  updates.push({
                    ticker: item,
                    field: 'trend',
                    oldValue: prevData.trend,
                    newValue: currData.trend
                  });
                }
              }
            });
          }

          // Rank Changes: Portfolio Solutions
          if (type === 'portfolio-solutions') {
            const getRank = (snapshot, ticker) => {
              if (!snapshot.data || !snapshot.data.rankings) return null;
              const entry = snapshot.data.rankings.find(r => r.ticker === ticker);
              return entry ? entry.rank : null;
            };

            const commonItems = currentItems.filter(item => previousItems.includes(item));
            commonItems.forEach(ticker => {
              const currRank = getRank(current, ticker);
              const prevRank = getRank(previous, ticker);

              if (currRank && prevRank && currRank !== prevRank) {
                updates.push({
                  ticker: ticker,
                  field: 'rank',
                  oldValue: prevRank,
                  newValue: currRank
                });
              }
            });
          }

          // Explicit Added/Removed for Signal Strength (if available)
          if (type === 'signal-strength') {
            if (current.data.added && Array.isArray(current.data.added) && current.data.added.length > 0) {
              // Since the PDF explicitly lists "Added", we trust that as the definitive source for additions
              // The diff method might pick up noise or re-ordering
              // Note: We need to manipulate 'added' and 'removed' variables which are in scope
              // We empty the calculated arrays and push the explicit ones
              added.length = 0;
              current.data.added.forEach(t => { if (t) added.push(t) });
            }

            if (current.data.removed && Array.isArray(current.data.removed) && current.data.removed.length > 0) {
              removed.length = 0;
              current.data.removed.forEach(t => { if (t) removed.push(t) });
            }
          }
        }

        results[type] = {
          added: added,
          removed: removed,
          updates: updates || [],
          currentDate: current.date,
          previousDate: previous.date,
          available: true,
          ...getSnapshotMeta(current),
        };

        // Add topMovers and bottomMovers for portfolio-solutions
        if (type === 'portfolio-solutions') {
          if (current.data && current.data.topMovers) {
            results[type].topMovers = current.data.topMovers;
          }
          if (current.data && current.data.bottomMovers) {
            results[type].bottomMovers = current.data.bottomMovers;
          }
        }

        // Add trendChanges and outbucket from snapshot for risk-ranges
        if (type === 'risk-ranges') {
          if (current.trendChanges) {
            console.log('[Changelog] Adding trendChanges to risk-ranges:', current.trendChanges.length, 'items');
            results[type].trendChanges = current.trendChanges;
          } else {
            console.log('[Changelog] No trendChanges found for risk-ranges');
          }

          // Pass through raw lists for reference (optional, or just rely on diffs)
          results[type].outbucketList = current.outbucket || [];

          // Helper to normalize OutBucket items to display strings 
          const normalizeOutbucketItem = (item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
              // Format: "Name (TICKER) - TREND"
              const name = item.name || 'Unknown';
              const ticker = item.ticker || item.symbol || '';
              const trend = item.trend || '';
              if (ticker) return `${name} (${ticker}) - ${trend}`;
              return name;
            }
            return String(item);
          };

          // Helper to extract ticker for comparison
          const extractTicker = (item) => {
            if (typeof item === 'string') {
              const match = item.match(/\(([^)]+)\)/);
              return match ? match[1] : item;
            }
            if (item && typeof item === 'object') {
              return item.ticker || item.symbol || JSON.stringify(item);
            }
            return String(item);
          };

          // Compare OutBucket lists to find Added/Removed
          if (current.outbucket && previous.outbucket) {
            const currOut = current.outbucket.map(extractTicker);
            const prevOut = previous.outbucket.map(extractTicker);

            // Filter for added/removed, then normalize for display
            const addedOut = current.outbucket
              .filter(item => !prevOut.includes(extractTicker(item)))
              .map(normalizeOutbucketItem);
            const removedOut = previous.outbucket
              .filter(item => !currOut.includes(extractTicker(item)))
              .map(normalizeOutbucketItem);

            results[type].outbucketDiff = {
              added: addedOut,
              removed: removedOut
            };
          } else if (current.outbucket) {
            // If previous has no outbucket, everything is new (or just initialization)
            results[type].outbucketDiff = {
              added: current.outbucket.map(normalizeOutbucketItem),
              removed: []
            };
          } else {
            results[type].outbucketDiff = { added: [], removed: [] };
          }
        }

        // Add cryptoTrendChanges and etfTrendChanges for bitcoin-trend-tracker
        if (type === 'bitcoin-trend-tracker') {
          // Pass through the trend changes arrays from the snapshot
          results[type].cryptoTrendChanges = current.cryptoTrendChanges || [];
          results[type].etfTrendChanges = current.etfTrendChanges || [];
          results[type].previousDate = current.previousDate || previous.date;

          console.log('[Changelog] Bitcoin Tracker - Crypto trend changes:',
            results[type].cryptoTrendChanges.length,
            'ETF trend changes:', results[type].etfTrendChanges.length);
        }

        // Pass through current longs/shorts/neutrals for macro-show and the-call
        if (type === 'the-macro-show' || type === 'the-call') {
          results[type].currentLongs = current.data?.longs || [];
          results[type].currentShorts = current.data?.shorts || [];
          results[type].currentNeutrals = current.data?.neutrals || [];
        }

        if (type === 'real-time-alert') {
          results[type].alerts = normalizeRealTimeAlerts(current);
        }

        // Calculate trendChanges for early-look by comparing trends
        if (type === 'early-look') {
          const trendChanges = [];

          if (current.data && previous.data) {
            Object.keys(current.data).forEach(ticker => {
              const currData = current.data[ticker];
              const prevData = previous.data[ticker];

              if (prevData && currData.trend !== prevData.trend) {
                trendChanges.push({
                  ticker,
                  oldTrend: prevData.trend,
                  newTrend: currData.trend
                });
              }
            });
          }

          console.log('[Changelog] Calculated trendChanges for early-look:', trendChanges.length, 'items');
          results[type].trendChanges = trendChanges;
        }

        // CFTC Positioning - extract significant Z-score changes (> 2.0 or < -2.0)
        if (type === 'cftc-positioning') {
          const significantPositive = [];
          const significantNegative = [];

          console.log('[Changelog] CFTC - Processing data, type:', typeof current.data, 'isArray:', Array.isArray(current.data));

          if (current.data && Array.isArray(current.data)) {
            console.log(`[Changelog] CFTC - Total metrics: ${current.data.length}`);
            console.log('[Changelog] CFTC - First metric sample:', JSON.stringify(current.data[0], null, 2));

            current.data.forEach((metric, idx) => {
              // DynamoDB Decimals need special handling - convert to number
              const z1yRaw = metric.zScore1Y;
              const z3yRaw = metric.zScore3Y;

              // Handle DynamoDB Decimal type (has toNumber method) or regular numbers
              const z1y = z1yRaw !== undefined && z1yRaw !== null
                ? (typeof z1yRaw === 'object' && z1yRaw.toNumber ? z1yRaw.toNumber() : parseFloat(z1yRaw))
                : null;
              const z3y = z3yRaw !== undefined && z3yRaw !== null
                ? (typeof z3yRaw === 'object' && z3yRaw.toNumber ? z3yRaw.toNumber() : parseFloat(z3yRaw))
                : null;

              if (idx < 3) {
                console.log(`[Changelog] CFTC - Metric ${idx} (${metric.metric}): z1y=${z1y}, z3y=${z3y}`);
              }

              // Check if any Z-score exceeds threshold
              if (z1y > 2.0 || z3y > 2.0) {
                significantPositive.push({
                  metric: metric.metric,
                  category: metric.category,
                  zScore1Y: z1y,
                  zScore3Y: z3y,
                  latest: metric.latest,
                  wwChg: metric.wwChg
                });
              } else if (z1y < -2.0 || z3y < -2.0) {
                significantNegative.push({
                  metric: metric.metric,
                  category: metric.category,
                  zScore1Y: z1y,
                  zScore3Y: z3y,
                  latest: metric.latest,
                  wwChg: metric.wwChg
                });
              }
            });
          }

          // Sort by absolute Z-score (most extreme first)
          significantPositive.sort((a, b) => Math.max(b.zScore1Y || 0, b.zScore3Y || 0) - Math.max(a.zScore1Y || 0, a.zScore3Y || 0));
          significantNegative.sort((a, b) => Math.min(a.zScore1Y || 0, a.zScore3Y || 0) - Math.min(b.zScore1Y || 0, b.zScore3Y || 0));

          results[type].significantPositive = significantPositive;
          results[type].significantNegative = significantNegative;

          console.log(`[Changelog] CFTC Positioning - Significant positive: ${significantPositive.length}, negative: ${significantNegative.length}`);
          if (significantPositive.length > 0) {
            console.log('[Changelog] CFTC - Positive sample:', significantPositive[0]);
          }
          if (significantNegative.length > 0) {
            console.log('[Changelog] CFTC - Negative sample:', significantNegative[0]);
          }
        }

        const completed = results[type];
        if (completed?.available && !completed.comparisonStatus) {
          const hasChanges = [
            completed.added,
            completed.removed,
            completed.updates,
            completed.trendChanges,
            completed.cryptoTrendChanges,
            completed.etfTrendChanges,
            completed.alerts,
            completed.outbucketDiff?.added,
            completed.outbucketDiff?.removed,
          ].some((items) => Array.isArray(items) && items.length > 0);
          completed.comparisonStatus = hasChanges ? 'changed' : 'no_change';
        }

      } catch (err) {
        console.error(`Error processing changelog for ${type}:`, err);
        results[type] = { error: err.message, available: false };
      }
    }));

    // ETF Pro — local dated JSON + latest.json (same diff as GET /api/hedgeye/etfpro)
    try {
      const { payload: parsed, etfproDir } = await getResolvedEtfProPayload();
      if (!parsed) {
        results['etf-pro'] = {
          added: [], removed: [], available: false, currentDate: null, previousDate: null,
          addedLongs: [], removedLongs: [], addedShorts: [], removedShorts: []
        };
      } else {
        const todayDate = parsed.meta?.snapshotDate || null;
        let changes = parsed.changes || null;
        let previousDate = parsed.meta?.previousFullBookDate || parsed.meta?.baseSnapshotDate || null;

        if (!changes) {
          const dated = fs.readdirSync(etfproDir)
            .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
            .map(f => f.replace('.json', ''))
            .filter(d => d !== todayDate)
            .sort()
            .reverse();

          if (dated.length > 0) {
            const prevParsed = JSON.parse(fs.readFileSync(path.join(etfproDir, `${dated[0]}.json`), 'utf-8'));
            const today = classifyEtfProRows(parsed.rows || []);
            const prev = classifyEtfProRows(prevParsed.rows || []);
            changes = {
              addedLongs: [...today.longs].filter(t => !prev.longs.has(t)),
              removedLongs: [...prev.longs].filter(t => !today.longs.has(t)),
              addedShorts: [...today.shorts].filter(t => !prev.shorts.has(t)),
              removedShorts: [...prev.shorts].filter(t => !today.shorts.has(t)),
            };
            previousDate = dated[0];
          }
        }

        const addedLongs = changes?.addedLongs || [];
        const removedLongs = changes?.removedLongs || [];
        const addedShorts = changes?.addedShorts || [];
        const removedShorts = changes?.removedShorts || [];
        results['etf-pro'] = {
          available: !!todayDate,
          currentDate: todayDate,
          previousDate,
          comparisonStatus: previousDate
            ? ([...addedLongs, ...removedLongs, ...addedShorts, ...removedShorts].length > 0 ? 'changed' : 'no_change')
            : 'insufficient_history',
          scrapedAt: parsed.meta?.parsedAt || parsed.meta?.scrapedAt || null,
          publishedAt: parsed.meta?.publishedAt || null,
          eventTime: parsed.meta?.actionParsedAt || parsed.meta?.parsedAt || parsed.meta?.scrapedAt || todayDate || null,
          added: changes?.added || [...new Set([...addedLongs, ...addedShorts])],
          removed: changes?.removed || [...new Set([...removedLongs, ...removedShorts])],
          addedLongs,
          removedLongs,
          addedShorts,
          removedShorts,
          source: parsed.meta?.source || 'EtfProLocal',
          baseSnapshotDate: parsed.meta?.previousFullBookDate || parsed.meta?.baseSnapshotDate || todayDate,
          actionThroughDate: parsed.meta?.actionThroughDate || parsed.meta?.actionParsedAt || null,
          actionCount: parsed.meta?.actionCount,
          rowCount: Array.isArray(parsed.rows) ? parsed.rows.length : 0,
          dataQuality: parsed.dataQuality,
        };
      }
    } catch (err) {
      console.error('[API] ETF Pro changelog:', err.message);
      results['etf-pro'] = {
        available: false, error: err.message,
        added: [], removed: [], addedLongs: [], removedLongs: [], addedShorts: [], removedShorts: []
      };
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hedgeye/changelog completed in ${totalTime}ms`);
    return results;

  } catch (error) {
    console.error('[API] Error in /api/hedgeye/changelog:', error);
    throw error;
  }
}

app.get('/api/hedgeye/changelog', async (req, res) => {
  try {
    return await sendCachedJson(res, 'changelog', buildHedgeyeChangelogResponse);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch changelog', details: error.message });
  }
});

const { createPublishedTradeArchiveWorkerService } = require('./src/services/publishedTradeArchiveWorkerService.cjs');
const publishedTradeArchive = createPublishedTradeArchiveWorkerService();
const securityIntelligenceInputCache = createAsyncTtlCache({ ttlMs: FIVE_MINUTES_MS, maxEntries: 12 });
// A Real-Time Alert can refresh a Risk Range intraday; when the current ranges change, every cache built
// from them is dropped, so the dashboard, Security Intelligence (Portfolio Review, range lines) and the
// prediction board all read the revised range on their next request (user-specified 2026-11-20).
const riskRangeRevisionWatch = require('./src/services/riskRangeRevisionWatch.cjs').createRiskRangeRevisionWatch({
  load: ({ now }) => loadRiskRangePublicationEnvelope({ now }),
  onChange: () => {
    riskRangesCache.clear();
    securityIntelligenceInputCache.clear();
    predictionResearchBoards.clear();
  },
  log: (message) => console.log(message),
});
const securityIntelligenceProjection = createSecurityIntelligenceWorkerService();

// All security surfaces consume the same dated Trade evidence, including sparse
// publications outside the bounded history displayed in the research window.
async function loadCanonicalSecurityIntelligence({ symbols, date, historyDays = SECURITY_INTELLIGENCE_MAX_HISTORY_DAYS,
  now = new Date(), scope = 'symbols', limit, cursor, version = 2 } = {}) {
  const marketDate = date || defaultResearchMarketDate(now);
  const [inputResult, publishedTradeReadings] = await Promise.all([
    securityIntelligenceInputCache.get(`${marketDate}:${historyDays}`, () => loadSecurityIntelligenceInputs({
      dynamodb, marketDate, historyDays, now,
      riskRangeLoader: ({ now: requestNow }) => loadRiskRangePublicationEnvelope({ now: requestNow }),
      entityEventsTable: RESEARCH_ENTITY_EVENTS_TABLE,
      productManifestTable: RESEARCH_PRODUCT_MANIFEST_TABLE,
      entityEventsIndex: RESEARCH_ENTITY_EVENTS_DATE_INDEX,
    })),
    publishedTradeArchive.load({ date: marketDate }),
  ]);
  return securityIntelligenceProjection.build({ version, symbols, scope, limit, cursor,
    marketDate, historyDays, now, ...inputResult.value, publishedTradeReadings });
}

// The day's repository of what each product states in prose: Trade for published
// references (Gold/Silver/Copper spot), stated Trend and Alpha Codes. The same
// archive read as the Predictive Markets board and the security record.
app.get('/api/research/published-statements', async (req, res) => {
  const marketDate = req.query.date || defaultResearchMarketDate(new Date());
  res.setHeader('Cache-Control', 'no-store');
  if (!isValidMarketDate(marketDate)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const statements = await publishedTradeArchive.loadStatements({ date: marketDate });
    return res.json({ schemaVersion: 1, marketDate, refreshedAt: publishedTradeArchive.status()?.refreshedAt ?? null, ...statements });
  } catch (error) {
    console.error('[API] Error in /api/research/published-statements:', error);
    return res.status(503).json({ error: 'Published statements unavailable', details: error.message });
  }
});

app.get('/api/research/security-intelligence', async (req, res) => {
  const now = new Date();
  const rawSymbols = String(req.query.symbols || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const symbols = normalizeRequestedSymbols(rawSymbols);
  const marketDate = req.query.date || defaultResearchMarketDate(now);
  const historyDays = req.query.historyDays === undefined
    ? SECURITY_INTELLIGENCE_MAX_HISTORY_DAYS
    : Number(req.query.historyDays);

  if (rawSymbols.length === 0 || symbols.length === 0) {
    return res.status(400).json({ error: 'symbols must contain at least one valid ticker' });
  }
  if (rawSymbols.length > SECURITY_INTELLIGENCE_MAX_SYMBOLS) {
    return res.status(400).json({
      error: `symbols supports at most ${SECURITY_INTELLIGENCE_MAX_SYMBOLS} tickers`,
    });
  }
  if (symbols.length !== new Set(rawSymbols.map((value) => value.toUpperCase())).size) {
    return res.status(400).json({ error: 'symbols contains an invalid ticker' });
  }
  if (!isValidMarketDate(marketDate)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  if (
    !Number.isInteger(historyDays) ||
    historyDays < 0 ||
    historyDays > SECURITY_INTELLIGENCE_MAX_HISTORY_DAYS
  ) {
    return res.status(400).json({
      error: `historyDays must be an integer from 0 to ${SECURITY_INTELLIGENCE_MAX_HISTORY_DAYS}`,
    });
  }

  try {
    const response = await loadCanonicalSecurityIntelligence({ symbols, date: marketDate, historyDays, now, version: 1 });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(response);
  } catch (error) {
    console.error('[API] Error in /api/research/security-intelligence:', error);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({
      error: 'Failed to build security intelligence',
      details: error.message,
      bySymbol: {},
    });
  }
});

app.get('/api/research/security-intelligence/v2', async (req, res) => {
  const now = new Date();
  const scope = String(req.query.scope || 'symbols').trim().toLowerCase();
  const rawSymbols = String(req.query.symbols || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const symbols = normalizeRequestedSymbols(rawSymbols);
  const marketDate = req.query.date || defaultResearchMarketDate(now);
  const historyDays = req.query.historyDays === undefined
    ? scope === 'universe' ? 0 : SECURITY_INTELLIGENCE_MAX_HISTORY_DAYS
    : Number(req.query.historyDays);
  const limit = req.query.limit === undefined
    ? SECURITY_INTELLIGENCE_MAX_SYMBOLS
    : Number(req.query.limit);
  const cursor = req.query.cursor === undefined ? null : String(req.query.cursor);

  if (!['symbols', 'universe'].includes(scope)) {
    return res.status(400).json({ error: 'scope must be symbols or universe' });
  }
  if (scope === 'symbols' && (rawSymbols.length === 0 || symbols.length === 0)) {
    return res.status(400).json({ error: 'symbols must contain at least one valid ticker' });
  }
  if (scope === 'universe' && rawSymbols.length > 0) {
    return res.status(400).json({ error: 'universe scope cannot include symbols' });
  }
  if (rawSymbols.length > SECURITY_INTELLIGENCE_MAX_SYMBOLS) {
    return res.status(400).json({
      error: `symbols supports at most ${SECURITY_INTELLIGENCE_MAX_SYMBOLS} tickers`,
    });
  }
  if (
    scope === 'symbols'
    && symbols.length !== new Set(rawSymbols.map((value) => value.toUpperCase())).size
  ) {
    return res.status(400).json({ error: 'symbols contains an invalid ticker' });
  }
  if (!isValidMarketDate(marketDate)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  if (
    !Number.isInteger(historyDays)
    || historyDays < 0
    || historyDays > SECURITY_INTELLIGENCE_MAX_HISTORY_DAYS
    || (scope === 'universe' && historyDays !== 0)
  ) {
    return res.status(400).json({
      error: scope === 'universe'
        ? 'universe historyDays must be 0'
        : `historyDays must be an integer from 0 to ${SECURITY_INTELLIGENCE_MAX_HISTORY_DAYS}`,
    });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > SECURITY_INTELLIGENCE_MAX_SYMBOLS) {
    return res.status(400).json({
      error: `limit must be an integer from 1 to ${SECURITY_INTELLIGENCE_MAX_SYMBOLS}`,
    });
  }
  if (cursor !== null && !/^\d+$/.test(cursor)) {
    return res.status(400).json({ error: 'cursor must be a non-negative integer' });
  }

  try {
    const response = await loadCanonicalSecurityIntelligence({ symbols, scope, limit, cursor, date: marketDate, historyDays, now });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(response);
  } catch (error) {
    console.error('[API] Error in /api/research/security-intelligence/v2:', error);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({
      schemaVersion: 2,
      error: 'Failed to build security intelligence v2',
      details: error.message,
      bySymbol: {},
    });
  }
});

app.get('/api/analytics/daily-brief', async (req, res) => {
  const startTime = Date.now();
  try {
    if (req.query.refresh === '1') {
      researchResponseCache.delete('analytics-daily-brief');
      researchResponseCache.delete('changelog');
    }
    const cacheResult = await researchResponseCache.get(
      'analytics-daily-brief',
      buildHedgeyeChangelogResponse,
    );
    setDataCacheHeaders(res, cacheResult);
    const brief = buildAnalyticsDailyBrief({
      changelog: cacheResult.value,
      cacheState: cacheResult.status,
    });
    console.log(`[API] /api/analytics/daily-brief completed in ${Date.now() - startTime}ms`);
    return res.json(brief);
  } catch (error) {
    console.error('[API] Error in /api/analytics/daily-brief:', error);
    return res.status(500).json({
      error: 'Failed to build analytics daily brief',
      details: error.message,
      events: [],
    });
  }
});

async function getAnalyticsSourceSnapshot(sourceId, snapshotId) {
  if (sourceId === 'etf-pro') {
    const { payload: latest, etfproDir } = await getResolvedEtfProPayload();
    let payload = latest;
    const latestDate = latest?.meta?.snapshotDate || null;
    if (snapshotId !== latestDate) {
      const datedPath = path.join(etfproDir, `${snapshotId}.json`);
      payload = fs.existsSync(datedPath)
        ? JSON.parse(fs.readFileSync(datedPath, 'utf-8'))
        : null;
    }
    if (!payload) return null;
    return {
      sourceId,
      snapshotId,
      contentDate: payload.meta?.snapshotDate || snapshotId,
      publishedAt: payload.meta?.publishedAt || null,
      ingestedAt: payload.meta?.parsedAt || payload.meta?.scrapedAt || null,
      source: payload.meta?.source || 'EtfProLocal',
      quality: payload.dataQuality || null,
      parsed: {
        rows: Array.isArray(payload.rows) ? payload.rows : [],
        changes: payload.changes || null,
        meta: payload.meta || {},
      },
      artifactUrl: null,
    };
  }

  const result = await dynamodb.get({
    TableName: 'HedgeyeDailySnapshot',
    Key: { date: snapshotId, snapshotType: sourceId },
  }).promise();
  const item = result.Item;
  if (!item) return null;
  const hasArtifact = Boolean(item.screenshotS3Key || item.pdfSource || item.htmlSource);
  return {
    sourceId,
    snapshotId,
    contentDate: item.date || snapshotId,
    publishedAt: item.publishedAt || null,
    ingestedAt: item.scrapedAt || item.receivedAt || item.createdAt || item.updatedAt || null,
    source: item.sourceProduct || item.source || 'HedgeyeDailySnapshot',
    quality: {
      warnings: Array.isArray(item.warnings) ? item.warnings : [],
      reportType: item.reportType || null,
    },
    parsed: {
      data: item.data,
      trendChanges: item.trendChanges || [],
      outbucket: item.outbucket || [],
    },
    artifactUrl: hasArtifact
      ? `/api/hedgeye/screenshot/${encodeURIComponent(snapshotId)}/content?type=${encodeURIComponent(sourceId)}`
      : null,
  };
}

app.get('/api/analytics/sources/:sourceId/snapshots/:snapshotId', async (req, res) => {
  const { sourceId, snapshotId } = req.params;
  if (!ANALYTICS_SOURCE_IDS.has(sourceId)) {
    return res.status(400).json({ error: 'Unsupported analytics source', sourceId });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotId)) {
    return res.status(400).json({ error: 'snapshotId must be YYYY-MM-DD', snapshotId });
  }
  try {
    const snapshot = await getAnalyticsSourceSnapshot(sourceId, snapshotId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Analytics source snapshot not found', sourceId, snapshotId });
    }
    return res.json(snapshot);
  } catch (error) {
    console.error('[API] Error loading analytics source snapshot:', error);
    return res.status(500).json({
      error: 'Failed to load analytics source snapshot',
      details: error.message,
    });
  }
});


app.get('/api/macro-indicators', async (req, res) => {
  const startTime = Date.now();
  try {
    const macroIndicators = ['DXY', 'GLD', 'UST10Y', 'CRB', 'WTI', 'SPY', 'QQQ', 'IWM'];
    console.log(`[API] /api/macro-indicators called for ${macroIndicators.length} indicators`);

    const indicators = {};

    // Process in batches to avoid rate limiting
    const BATCH_SIZE = 5;
    const DELAY_MS = 200;

    const fetchStartTime = Date.now();
    const results = await batchProcess(
      macroIndicators,
      BATCH_SIZE,
      DELAY_MS,
      async (symbol) => {
        try {
          return await getQuote(symbol);
        } catch (error) {
          console.error(`[API] Error fetching macro indicator ${symbol}:`, error.message);
          return null;
        }
      }
    );
    const fetchTime = Date.now() - fetchStartTime;
    console.log(`[API] Macro indicators fetching completed in ${fetchTime}ms`);

    // Map results back to indicators
    let successCount = 0;
    macroIndicators.forEach((symbol, index) => {
      const quote = results[index];
      if (quote && quote.price && isQuoteUsableNow(quote, symbol)) {
        indicators[symbol] = {
          ...quote,
          symbol: symbol,
          price: quote.price,
          change: quote.change || null,
          changePercent: quote.changePercent || null,
          timestamp: quote.timestamp,
          source: quote.source,
          dataType: quote.dataType,
          availability: buildQuoteMetadata(quote).availability,
          warning: quote.warning
        };
        successCount++;
      } else {
        indicators[symbol] = {
          ...quote,
          symbol: symbol,
          price: null,
          error: 'No data available'
        };
      }
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/macro-indicators completed: ${successCount} indicators out of ${macroIndicators.length} requested in ${totalTime}ms`);
    res.json(indicators);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/macro-indicators after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch macro indicators' });
  }
});

const rateValueToBps = (value) => {
  if (value === '' || value == null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 1000) / 10;
};

// Build a uniform quote row for the multi-region response.
async function buildQuoteRow(index, { includeSparklines, wantPeriodReturns }) {
  try {
    const quoteInstrument = toQuoteInstrument(index);
    const quote = await getQuote(quoteInstrument);
    let quoteMetadata = buildQuoteMetadata(quote);
    const mapping = getTickerMapping(index.symbol);
    const isIntl = index.intl === true;

    let sparklineData = [];
    if (
      quoteMetadata.usable
      && includeSparklines
      && !isIntl
      && index.provider !== 'ibkr'
      && mapping.source === 'yahoo'
    ) {
      sparklineData = await getIntradayData(index.symbol);
    }

    let weekChangePct = null;
    let fifteenDayChangePct = null;
    let thirtyDayChangePct = null;
    let ninetyDayChangePct = null;
    let monthChangePct = null;
    let threeMonthChangePct = null;
    let sixMonthChangePct = null;
    let mtdChangePct = null;
    let qtdChangePct = null;
    let ytdChangePct = null;
    let oneYearChangePct = null;
    let periods = null;
    if (wantPeriodReturns) {
      try {
        periods = await getPeriodReturnsCached(index.symbol, quoteInstrument, quote);
        if (periods) {
          weekChangePct = periods.weekChangePct;
          fifteenDayChangePct = periods.fifteenDayChangePct ?? null;
          thirtyDayChangePct = periods.thirtyDayChangePct ?? null;
          ninetyDayChangePct = periods.ninetyDayChangePct ?? null;
          monthChangePct = periods.monthChangePct;
          threeMonthChangePct = periods.threeMonthChangePct ?? null;
          sixMonthChangePct = periods.sixMonthChangePct ?? null;
          mtdChangePct = periods.mtdChangePct ?? null;
          qtdChangePct = periods.qtdChangePct ?? null;
          ytdChangePct = periods.ytdChangePct;
          oneYearChangePct = periods.oneYearChangePct ?? null;
        }
      } catch (periodErr) {
        console.warn(`[API] Period returns failed for ${index.symbol}:`, periodErr.message);
      }
    }
    // Slow historical requests must not let the quote age into a current row.
    if (!isQuoteUsableNow(quote, quoteInstrument)) quoteMetadata = { ...quoteMetadata, usable: false, availability: 'unavailable', quoteAsOf: null };
    const periodMetadata = buildPeriodReturnsMetadata(periods);
    const usesBasisPointChanges = index.changeUnit === 'bps';
    // Intraday CNBC and daily official yields carry a real day change; monthly averages do not.
    const hasTrueDailyRateChange = !isIntl || ['daily', 'intraday'].includes(quote?.observationFrequency);
    const dayChangeBps = usesBasisPointChanges && hasTrueDailyRateChange
      ? rateValueToBps(quote?.change)
      : null;
    const publishedChange = usesBasisPointChanges && !hasTrueDailyRateChange
      ? null
      : quote?.change ?? null;
    const publishedChangePercent = usesBasisPointChanges && !hasTrueDailyRateChange
      ? null
      : quote?.changePercent ?? null;

    return {
      ...quote,
      symbol: index.symbol,
      name: index.name,
      unit: index.unit || undefined,
      changeUnit: index.changeUnit || undefined,
      price: quoteMetadata.usable ? quote.price : null,
      change: quoteMetadata.usable ? publishedChange : null,
      changePercent: quoteMetadata.usable ? publishedChangePercent : null,
      latestObservationChange: quoteMetadata.usable ? periods?.latestObservationChange ?? null : null,
      backdropPercentageReturns: quoteMetadata.usable && usesBasisPointChanges
        ? periods?.backdropPercentageReturns ?? null : null,
      timestamp: quoteMetadata.quoteAsOf,
      source: quoteMetadata.source,
      dataType: quoteMetadata.dataType,
      availability: quoteMetadata.availability,
      quoteAsOf: quoteMetadata.quoteAsOf,
      warning: quoteMetadata.warning,
      entitlementStatus: quoteMetadata.entitlementStatus,
      sparklineData,
      weekChangePct,
      fifteenDayChangePct,
      thirtyDayChangePct,
      ninetyDayChangePct,
      monthChangePct,
      threeMonthChangePct,
      sixMonthChangePct,
      mtdChangePct,
      qtdChangePct,
      ytdChangePct,
      oneYearChangePct,
      dayChangeBps,
      weekChangeBps: usesBasisPointChanges ? periods?.weekChangeBps ?? null : null,
      fifteenDayChangeBps: usesBasisPointChanges ? periods?.fifteenDayChangeBps ?? null : null,
      monthChangeBps: usesBasisPointChanges ? periods?.monthChangeBps ?? null : null,
      threeMonthChangeBps: usesBasisPointChanges ? periods?.threeMonthChangeBps ?? null : null,
      sixMonthChangeBps: usesBasisPointChanges ? periods?.sixMonthChangeBps ?? null : null,
      ytdChangeBps: usesBasisPointChanges ? periods?.ytdChangeBps ?? null : null,
      oneYearChangeBps: usesBasisPointChanges ? periods?.oneYearChangeBps ?? null : null,
      periodReturnsAsOf: periodMetadata.periodReturnsAsOf,
      periodReturnsStatus: periodMetadata.periodReturnsStatus,
      periodObservationFrequency: periods?.observationFrequency ?? null,
      periodReturnsSource: periods?.periodReturnsSource ?? null,
      periodSourceSeriesId: periods?.periodSourceSeriesId ?? null,
      periodSourceInstrument: periods?.periodSourceInstrument ?? null,
      periodSourceUrl: periods?.periodSourceUrl ?? null,
    };
  } catch (error) {
    console.error(`[API] Error fetching ${index.symbol}:`, error.message);
    return {
      symbol: index.symbol,
      name: index.name,
      unit: index.unit || undefined,
      changeUnit: index.changeUnit || undefined,
      price: null,
      change: null,
      changePercent: null,
      timestamp: null,
      source: null,
      dataType: null,
      availability: 'unavailable',
      quoteAsOf: null,
      warning: error.message || 'quote_fetch_failed',
      entitlementStatus: null,
      sparklineData: [],
      error: 'Failed to fetch quote',
      weekChangePct: null,
      fifteenDayChangePct: null,
      thirtyDayChangePct: null,
      ninetyDayChangePct: null,
      monthChangePct: null,
      threeMonthChangePct: null,
      sixMonthChangePct: null,
      mtdChangePct: null,
      qtdChangePct: null,
      ytdChangePct: null,
      oneYearChangePct: null,
      dayChangeBps: null,
      weekChangeBps: null,
      fifteenDayChangeBps: null,
      monthChangeBps: null,
      threeMonthChangeBps: null,
      sixMonthChangeBps: null,
      ytdChangeBps: null,
      oneYearChangeBps: null,
      periodReturnsAsOf: null,
      periodReturnsStatus: 'unavailable'
    };
  }
}

// Build the tabbed `rates` payload (Treasuries + derived curve spreads,
// Policy, Credit, EU Sovereigns, Asia Sovereigns).
async function buildRatesPayload(region, opts) {
  const tabs = region.tabs || {};
  const out = {};
  const rateIndicesBySymbol = new Map();
  Object.values(tabs).forEach((tab) => {
    (tab.indices || []).forEach((index) => rateIndicesBySymbol.set(index.symbol, index));
  });

  await Promise.all(Object.entries(tabs).map(async ([tabKey, tab]) => {
    const rows = await Promise.all((tab.indices || []).map((idx) => buildQuoteRow(idx, opts)));

    // Append derived rows (e.g. US Treasury curve spreads in bps). A derived
    // formula references symbols like ['UST10Y', 'UST2Y']; if a required leg
    // isn't present in this tab we fetch it on-demand via the cache-backed
    // getQuote so we can still compute the spread.
    if (Array.isArray(tab.derived) && tab.derived.length > 0) {
      const rowsBySymbol = new Map(rows.map((r) => [r.symbol, r]));
      const resolveYield = async (sym) => {
        const existing = rowsBySymbol.get(sym);
        if (existing && existing.price != null) {
          return { value: parseFloat(existing.price), ts: existing.timestamp };
        }
        try {
          const configuredIndex = rateIndicesBySymbol.get(sym);
          const q = await getQuote(configuredIndex ? toQuoteInstrument(configuredIndex) : sym);
          if (q?.price != null) {
            return { value: parseFloat(q.price), ts: q.timestamp };
          }
        } catch (err) {
          console.warn(`[Rates] derived leg ${sym} fetch failed:`, err.message);
        }
        return { value: NaN, ts: null };
      };

      for (const derived of tab.derived) {
        const [longSym, shortSym] = derived.formula;
        const [longLeg, shortLeg] = await Promise.all([resolveYield(longSym), resolveYield(shortSym)]);
        let priceStr = null;
        if (Number.isFinite(longLeg.value) && Number.isFinite(shortLeg.value)) {
          priceStr = ((longLeg.value - shortLeg.value) * 100).toFixed(1); // yields in %, spread in bps
        }

        // Populate bps period deltas from a date-aligned historical spread
        // series. If either leg is unavailable historically we leave the
        // period fields null and the row falls back to em-dashes on the UI.
        let dayDeltaBps = null;
        let weekDeltaBps = null;
        let fifteenDayDeltaBps = null;
        let monthDeltaBps = null;
        let threeMonthDeltaBps = null;
        let sixMonthDeltaBps = null;
        let mtdDeltaBps = null;
        let qtdDeltaBps = null;
        let ytdDeltaBps = null;
        let oneYearDeltaBps = null;
        let periodReturnsAsOf = null;
        let backdropPercentageReturns = null;
        try {
          const [longCloses, shortCloses] = await Promise.all([
            getDailyClosesCached(longSym),
            getDailyClosesCached(shortSym)
          ]);
          const spreadSeries = buildSpreadBpsSeries(longCloses, shortCloses);
          backdropPercentageReturns = {
            ...computePeriodPercentsFromCloses(spreadSeries, { absoluteBase: true }),
            latestObservationChange: latestObservationChange(spreadSeries),
          };
          const deltas = computeSpreadBpsDeltas(spreadSeries);
          if (deltas) {
            dayDeltaBps = deltas.dayDeltaBps;
            weekDeltaBps = deltas.weekDeltaBps;
            fifteenDayDeltaBps = deltas.fifteenDayDeltaBps;
            monthDeltaBps = deltas.monthDeltaBps;
            threeMonthDeltaBps = deltas.threeMonthDeltaBps;
            sixMonthDeltaBps = deltas.sixMonthDeltaBps;
            mtdDeltaBps = deltas.mtdDeltaBps;
            qtdDeltaBps = deltas.qtdDeltaBps;
            ytdDeltaBps = deltas.ytdDeltaBps;
            oneYearDeltaBps = deltas.oneYearDeltaBps;
            periodReturnsAsOf = deltas.asOf || null;
          }
        } catch (err) {
          console.warn(`[Rates] derived deltas failed for ${derived.symbol}:`, err.message);
        }

        const legTimes = [longLeg.ts, shortLeg.ts]
          .map((value) => Date.parse(String(value || '')))
          .filter(Number.isFinite);
        const derivedAsOf = legTimes.length === 2
          ? new Date(Math.min(...legTimes)).toISOString()
          : null;
        const derivedAvailable = priceStr != null && derivedAsOf != null;

        rows.push({
          symbol: derived.symbol,
          name: derived.name,
          unit: derived.unit || 'bps',
          changeUnit: derived.changeUnit || 'bps',
          price: derivedAvailable ? priceStr : null,
          change: derivedAvailable ? dayDeltaBps : null,
          // For bps-denominated derived rows the UI renders these fields with
          // a " bps" suffix (see getRowMetrics), so we populate them with the
          // bps delta rather than a percent change.
          changePercent: derivedAvailable ? dayDeltaBps : null,
          backdropPercentageReturns: derivedAvailable ? backdropPercentageReturns : null,
          timestamp: derivedAvailable ? derivedAsOf : null,
          source: 'derived',
          dataType: 'derived',
          availability: derivedAvailable ? 'historical' : 'unavailable',
          quoteAsOf: derivedAvailable ? derivedAsOf : null,
          warning: derivedAvailable ? 'derived_from_rate_legs' : 'derived_legs_unavailable',
          entitlementStatus: null,
          sparklineData: [],
          weekChangePct: weekDeltaBps,
          fifteenDayChangePct: fifteenDayDeltaBps,
          monthChangePct: monthDeltaBps,
          threeMonthChangePct: threeMonthDeltaBps,
          sixMonthChangePct: sixMonthDeltaBps,
          mtdChangePct: mtdDeltaBps,
          qtdChangePct: qtdDeltaBps,
          ytdChangePct: ytdDeltaBps,
          oneYearChangePct: oneYearDeltaBps,
          dayChangeBps: dayDeltaBps,
          weekChangeBps: weekDeltaBps,
          fifteenDayChangeBps: fifteenDayDeltaBps,
          monthChangeBps: monthDeltaBps,
          threeMonthChangeBps: threeMonthDeltaBps,
          sixMonthChangeBps: sixMonthDeltaBps,
          ytdChangeBps: ytdDeltaBps,
          oneYearChangeBps: oneYearDeltaBps,
          periodReturnsAsOf,
          periodReturnsStatus: periodReturnsAsOf ? 'historical' : 'unavailable',
          derived: true
        });
      }
    }

    const displayableRows = rows.filter(isDisplayableQuoteRow);
    out[tabKey] = marketQuoteReferenceStore.reconcileRows({
      mode: opts.wantPeriodReturns ? 'periods' : 'current',
      scope: `rates.${tabKey}`,
      incomingRows: displayableRows,
      expectedSymbols: [
        ...(tab.indices || []).map((index) => index.symbol),
        ...(tab.derived || []).map((index) => index.symbol),
      ],
      retentionReason: 'rate_provider_refresh_unavailable',
    });
  }));

  return out;
}

// The overview's IBKR rows stay subscribed while the overview is being asked
// for, so a poll reads them from the stream instead of opening and cancelling a
// market-data request for each one. The portfolio's lines come first; see the
// module for the line budget.
const { createOverviewStreamSubscription } = require('./src/services/ibkr/overviewStreamSubscription.cjs');
const overviewStreamSubscription = createOverviewStreamSubscription({
  rows: () => Object.values(MARKET_REGIONS).flatMap((region) => region.indices || []).map(toQuoteInstrument),
  setDesiredInstruments: ibkrStreamBridge.setDesiredInstruments,
  readStreamCapacity: async () => {
    const status = await sidecarRequest('/status', { timeoutMs: 3000 });
    return { active: status?.stream?.active_subscriptions, max: status?.stream?.max_stream_subs };
  },
  // Three misses in a row: a row with no entitlement, or a market that has
  // gone quiet for the night. A row that ticks now and then stays subscribed.
  isUnavailable: (row) => compositeMarketDataProvider.hasIbkrMiss(row, 3),
});

// Multi-Region Quotes endpoint - fetches quotes and sparklines for all regions
app.get('/api/multi-region-quotes', async (req, res) => {
  const startTime = Date.now();
  if (ibkrStreamBridge.STREAM_ENABLED) overviewStreamSubscription.touch();
  try {
    const { regions, includeSparklines = 'true', includePeriodReturns = 'false' } = req.query;
    const requestedRegions = regions ? regions.split(',') : Object.keys(MARKET_REGIONS);
    const wantPeriodReturns =
      includePeriodReturns === 'true' || includePeriodReturns === true || includePeriodReturns === '1';
    const wantSparklines = includeSparklines === 'true';
    const requestKey = `GET /api/multi-region-quotes?regions=${requestedRegions.join(',')}&includeSparklines=${wantSparklines}&includePeriodReturns=${wantPeriodReturns}`;

    const results = await runInFlight(requestKey, async () => {
      const payload = {};
      // Verified quotes out of those requested, per region, for one log line.
      const regionSummaries = [];
      const opts = { includeSparklines: wantSparklines, wantPeriodReturns };

      await Promise.all(requestedRegions.map(async (regionKey) => {
        const region = MARKET_REGIONS[regionKey];
        if (!region) {
          console.warn(`[API] Unknown region: ${regionKey}`);
          return;
        }

        // Tabbed regions (currently just `rates`) return a nested object keyed
        // by tab. All other regions return a flat array of quote rows.
        if (region.tabs) {
          const tabPayload = await buildRatesPayload(region, opts);
          payload[regionKey] = tabPayload;
          const tabCounts = Object.entries(tabPayload)
            .map(([k, v]) => `${k}=${v.length}`)
            .join(',');
          regionSummaries.push(`${regionKey}(${tabCounts})`);
          return;
        }

        const quotes = await Promise.all(region.indices.map((index) => buildQuoteRow(index, opts)));
        const displayableQuotes = quotes.filter(isDisplayableQuoteRow);
        payload[regionKey] = marketQuoteReferenceStore.reconcileRows({
          mode: wantPeriodReturns ? 'periods' : 'current',
          scope: regionKey,
          incomingRows: displayableQuotes,
          expectedSymbols: region.indices.map((index) => index.symbol),
          retentionReason: `${regionKey}_provider_refresh_unavailable`,
        });
        regionSummaries.push(`${regionKey}=${displayableQuotes.length}/${quotes.length}`);
      }));

      marketQuoteReferenceStore.flush();
      payload.meta = {
        observedAt: new Date().toISOString(),
        displayRole: 'informational',
        executable: false,
      };
      const totalTime = Date.now() - startTime;
      console.log(`[API] /api/multi-region-quotes verified/requested: ${regionSummaries.join(' ')} (sparklines: ${wantSparklines}, periodReturns: ${wantPeriodReturns})`);
      console.log(`[API] /api/multi-region-quotes completed in ${totalTime}ms`);
      return payload;
    });

    const revalidateRows = (rows) => rows.map((row) => {
      if (row.availability === 'reference') return row;
      if (row.source === 'derived') return row;
      if (isQuoteUsableNow(row)) return row;
      return markRetainedReference(row, 'observation_expired_during_refresh');
    }).filter(Boolean);
    const delivered = Object.fromEntries(Object.entries(results).map(([key, value]) => [key,
      key === 'meta' ? value : Array.isArray(value) ? revalidateRows(value)
        : Object.fromEntries(Object.entries(value).map(([tab, rows]) => [tab, revalidateRows(rows)])),
    ]));
    res.json(delivered);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/multi-region-quotes after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch multi-region quotes' });
  }
});

// Helper function to fetch FRED historical data
async function fetchFredHistoricalData(seriesId, months = 7) {
  try {
    const apiKey = process.env.FRED_API_KEY || '';
    if (!apiKey) {
      console.warn(`[FRED] Warning: FRED_API_KEY environment variable is not set.`);
      return null;
    }

    // Calculate date range (need extra month for safety)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const url = 'https://api.stlouisfed.org/fred/series/observations';
    const params = {
      series_id: seriesId,
      api_key: apiKey,
      file_type: 'json',
      observation_start: startDate.toISOString().split('T')[0],
      observation_end: endDate.toISOString().split('T')[0],
      sort_order: 'asc'
    };

    console.log(`[FRED] Fetching historical data for: ${seriesId} (${months} months)`);

    const response = await axios.get(url, {
      params,
      timeout: 15000
    });

    const data = response.data;

    if (data.observations && data.observations.length > 0) {
      // Filter out missing values and convert to numbers
      const validObservations = data.observations
        .filter(obs => obs.value && obs.value !== '.')
        .map(obs => ({
          date: obs.date,
          value: parseFloat(obs.value)
        }));

      console.log(`[FRED] Successfully fetched ${validObservations.length} observations for ${seriesId}`);
      return validObservations;
    }

    return null;
  } catch (error) {
    console.error(`[FRED] Error fetching historical data for ${seriesId}:`, error.message);
    return null;
  }
}

// Calculate annualized rate of change
function calculateAnnualizedROC(currentValue, pastValue, months) {
  if (!currentValue || !pastValue || pastValue <= 0) {
    return null;
  }

  const ratio = currentValue / pastValue;
  const periodsPerYear = 12 / months;
  const annualizedROC = (Math.pow(ratio, periodsPerYear) - 1) * 100;

  return annualizedROC;
}

// Get value N months ago from observations
function getValueMonthsAgo(observations, months) {
  if (!observations || observations.length === 0) {
    return null;
  }

  // Sort by date descending (most recent first)
  const sorted = [...observations].sort((a, b) => new Date(b.date) - new Date(a.date));

  if (sorted.length === 0) {
    return null;
  }

  // Get the most recent value
  const currentDate = new Date(sorted[0].date);
  const targetDate = new Date(currentDate);
  targetDate.setMonth(targetDate.getMonth() - months);

  // Find the closest observation to target date
  let closest = null;
  let minDiff = Infinity;

  for (const obs of sorted) {
    const obsDate = new Date(obs.date);
    const diff = Math.abs(obsDate - targetDate);

    if (diff < minDiff && obsDate <= targetDate) {
      minDiff = diff;
      closest = obs.value;
    }
  }

  // If no observation before target date, use the oldest available
  if (closest === null && sorted.length > 0) {
    closest = sorted[sorted.length - 1].value;
  }

  return closest;
}

const liquidityModelsCache = {
  timestamp: 0,
  data: null,
};
const LIQUIDITY_MODELS_CACHE_TTL = 6 * 60 * 60 * 1000;

async function loadLiquidityModelsCached({ refresh = false } = {}) {
  if (
    !refresh &&
    liquidityModelsCache.data &&
    Date.now() - liquidityModelsCache.timestamp < LIQUIDITY_MODELS_CACHE_TTL
  ) {
    return liquidityModelsCache.data;
  }
  const data = await buildLiquidityModels({
    baseDir: __dirname,
    now: new Date(),
  });
  liquidityModelsCache.timestamp = Date.now();
  liquidityModelsCache.data = data;
  return data;
}

const moneyFlowService = createMoneyFlowService({
  exchangeVolumeService: usExchangeVolumeService,
  loadLiquidityModels: loadLiquidityModelsCached,
});

// Dollar Liquidity Models endpoint
app.get('/api/liquidity-indicators', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/liquidity-indicators called');

    const data = await loadLiquidityModelsCached({ refresh: req.query.refresh === 'true' });

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/liquidity-indicators completed in ${totalTime}ms`);
    res.json(data);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/liquidity-indicators after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to build liquidity models', details: error.message });
  }
});

// Signal Strength cache
const signalStrengthCache = new Map();
const SIGNAL_STRENGTH_CACHE_TTL = 60000; // 1 minute cache

// Signal Strength Rankings Endpoint - Optimized with caching and parallel queries
app.get('/api/securities/signal-strength', async (req, res) => {
  const startTime = Date.now();

  // Check cache first
  const cached = signalStrengthCache.get('data');
  if (cached && Date.now() - cached.timestamp < SIGNAL_STRENGTH_CACHE_TTL) {
    console.log(`[API] /api/securities/signal-strength returning cached data (${Date.now() - startTime}ms)`);
    return res.json(cached.data);
  }

  try {
    // Import securities list dynamically
    const { SECURITIES_LIST } = await import('./src/constants/securitiesList.js');

    // Limit to expected securities instead of scanning entire table
    const symbols = SECURITIES_LIST.map(s => s.ticker);

    // Fetch latest market data in parallel batches
    const BATCH_SIZE = 10; // Process 10 at a time to avoid overwhelming DynamoDB
    const securitiesData = [];

    const queryStartTime = Date.now();

    // Process symbols in parallel batches
    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (symbol) => {
        try {
          const params = {
            TableName: 'MarketPriceHistory',
            KeyConditionExpression: 'symbol = :symbol',
            ExpressionAttributeValues: { ':symbol': symbol },
            ScanIndexForward: false,
            Limit: 1
          };

          const result = await dynamodb.query(params).promise();
          const securityConfig = SECURITIES_LIST.find(s => s.ticker === symbol) || {};

          let marketData = {
            ticker: symbol,
            name: securityConfig.name || symbol,
            assetClass: securityConfig.assetClass || 'equity',
            price: null,
            trendLevel: null,
            tailLevel: null,
            trendStatus: null,
            tailStatus: null,
            buyTrade: null,
            sellTrade: null,
            upside: null,
            downside: null,
            trendSignal: (securityConfig.bias || 'NEUTRAL').toUpperCase()
          };

          if (result.Items && result.Items.length > 0) {
            const latest = result.Items[0];
            marketData.price = latest.close;
            marketData.closingPrice = latest.close;
          }

          return marketData;
        } catch (error) {
          console.error(`Error fetching data for ${symbol}:`, error.message);
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      securitiesData.push(...batchResults.filter(Boolean));

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    // Calculate signal strength for each security
    const rankedSecurities = securitiesData.map(security => {
      let score = 0;

      // Base score from trend signal
      if (security.trendSignal === 'BULLISH') score += 50;
      else if (security.trendSignal === 'BEARISH') score -= 50;

      // If we have price vs trend level data, add momentum
      if (security.trendStatus === 'Above') score += 20;
      else if (security.trendStatus === 'Below') score -= 20;

      // If we have tail level data, add support/resistance
      if (security.tailStatus === 'Above') score += 10;
      else if (security.tailStatus === 'Below') score -= 10;

      // Risk/reward from upside/downside
      if (security.upside && security.downside) {
        const riskReward = security.upside - Math.abs(security.downside);
        score += Math.max(-20, Math.min(20, riskReward * 0.8));
      }

      score = Math.max(-100, Math.min(100, Math.round(score)));

      // Determine level and color
      let level = 'Neutral';
      let color = 'gray';
      if (score >= 70) { level = 'Very Strong'; color = 'emerald'; }
      else if (score >= 40) { level = 'Strong'; color = 'emerald'; }
      else if (score >= 10) { level = 'Moderate'; color = 'lime'; }
      else if (score >= -10) { level = 'Neutral'; color = 'gray'; }
      else if (score >= -40) { level = 'Weak'; color = 'amber'; }
      else if (score >= -70) { level = 'Very Weak'; color = 'red'; }
      else { level = 'Extremely Weak'; color = 'red'; }

      return {
        ...security,
        signalStrength: score,
        signalLevel: level,
        signalColor: color
      };
    }).sort((a, b) => b.signalStrength - a.signalStrength);

    const queryTime = Date.now() - queryStartTime;
    const totalTime = Date.now() - startTime;

    // Update cache
    signalStrengthCache.set('data', {
      data: rankedSecurities,
      timestamp: Date.now()
    });

    console.log(`[API] /api/securities/signal-strength completed: ${rankedSecurities.length} securities (queries: ${queryTime}ms, total: ${totalTime}ms)`);
    res.json(rankedSecurities);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/securities/signal-strength after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch signal strength rankings' });
  }
});

// Current issuer-published constituent overlap for supported leveraged-product proxies.
// This endpoint deliberately performs a fresh upstream read and never serves a cache fallback.
app.get('/api/leveraged-products/overlap', createLeveragedProductOverlapHandler({ leveragedProductOverlapService }));

function portfolioBalanceUnavailable(error, accountId = null) {
  return {
    available: false,
    status: 'unavailable',
    source: 'unavailable',
    accountId: accountId || null,
    fromCache: false,
    errorCode:
      error?.sidecarCode
      || error?.code
      || 'PORTFOLIO_BALANCE_UNAVAILABLE',
    message:
      error?.sidecarMessage
      || error?.message
      || 'Verified live IBKR portfolio balance is unavailable.',
    observedAt: new Date().toISOString(),
    // The producer's Gateway classification; consumers treat a dedicated
    // client failure as a disconnect only when this says so.
    ...(error?.gatewayErrorCode ? { gatewayErrorCode: error.gatewayErrorCode } : {}),
  };
}

async function readVerifiedPortfolioBalance(accountId) {
  const balance = await runInFlight(
    `portfolio-balance:${accountId || 'default'}`,
    () => portfolioDataProvider.getPortfolioBalance(accountId),
  );
  try {
    recordIbkrInterestBalanceObservation(balance);
  } catch (trackingError) {
    console.warn(
      '[IBKR Interest Validation] verified MTD checkpoint was not persisted:',
      trackingError?.code || 'interest_balance_observation_storage_error',
    );
  }
  return balance;
}

// Portfolio balance: independent, live, account-scoped, and never cached.
app.get('/api/portfolio/balance', async (req, res) => {
  const startTime = Date.now();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const accountId = String(
      req.query.account || process.env.IBKR_ACCOUNT_ID || '',
    ).trim() || undefined;
    const balance = await readVerifiedPortfolioBalance(accountId);
    console.log(
      `[API] /api/portfolio/balance completed in ${Date.now() - startTime}ms account=${balance.accountId}`,
    );
    return res.json(balance);
  } catch (error) {
    const accountId = String(req.query.account || '').trim() || null;
    const status = Number.isInteger(error?.status) ? error.status : 503;
    console.warn(
      `[API] /api/portfolio/balance unavailable after ${Date.now() - startTime}ms:`,
      error.message,
    );
    return res.status(status).json(portfolioBalanceUnavailable(error, accountId));
  }
});

// Read-only projection. This route never creates, modifies, or transmits an order.
app.post('/api/portfolio/balance/preview', async (req, res) => {
  const startTime = Date.now();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const preview = await portfolioDataProvider.getPortfolioBalancePreview(
      req.body || {},
    );
    console.log(
      `[API] /api/portfolio/balance/preview completed in ${Date.now() - startTime}ms account=${preview.accountId} action=${preview.action}`,
    );
    return res.json(preview);
  } catch (error) {
    const accountId = String(
      req.body?.accountId || req.body?.account || '',
    ).trim() || null;
    const status = Number.isInteger(error?.status) ? error.status : 503;
    console.warn(
      `[API] /api/portfolio/balance/preview unavailable after ${Date.now() - startTime}ms:`,
      error.message,
    );
    return res.status(status).json(portfolioBalanceUnavailable(error, accountId));
  }
});

// Portfolio: IBKR API live snapshot (read-only)
app.get('/api/portfolio', async (req, res) => {
  const startTime = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  try {
    const accountId = req.query.account || process.env.IBKR_ACCOUNT_ID || undefined;
    const source = req.query.source;

    let portfolioData = await portfolioDataProvider.getPortfolioSnapshot(accountId, { source });

    if (portfolioData.empty) {
      return res.json(portfolioData);
    }

    // The active default is socket-verified IBKR only. Explicit uploaded
    // statements remain archival and retain their original dated prices; this
    // route never blends Yahoo/current quotes into either source.


    const totalTime = Date.now() - startTime;
    console.log(
      `[API] /api/portfolio completed in ${totalTime}ms source=${portfolioData.dataSource} holdings=${portfolioData.holdings?.length || 0}`,
    );
    res.json(portfolioData);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/portfolio after ${totalTime}ms:`, error);
    res.status(500).json({
      error: 'Failed to fetch portfolio data',
      details: error.message,
    });
  }
});

app.get('/api/portfolio/accounts', async (req, res) => {
  const startTime = Date.now();
  try {
    const accounts = await portfolioDataProvider.getAccounts();
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return res.json({ accounts: [] });
    }

    const snapshots = await Promise.all(
      accounts.map(async (accountId) => {
        try {
          const [accountSummary, pnl] = await Promise.all([
            portfolioDataProvider.getAccountSummary(accountId),
            portfolioDataProvider.getPnL(accountId),
          ]);
          return {
            accountId,
            accountSummary: accountSummary || null,
            pnl: pnl || null,
          };
        } catch (error) {
          return {
            accountId,
            accountSummary: null,
            pnl: null,
            error: error.message,
          };
        }
      }),
    );

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/portfolio/accounts completed in ${totalTime}ms accounts=${snapshots.length}`);
    res.json({ accounts: snapshots });
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/portfolio/accounts after ${totalTime}ms:`, error);
    res.status(500).json({
      error: 'Failed to fetch portfolio account snapshots',
      details: error.message,
    });
  }
});

app.get('/api/ibkr/flex/status', (req, res) => {
  try {
    res.json(getFlexPublicConfigStatus());
  } catch (error) {
    console.error('[API] Error in /api/ibkr/flex/status:', error);
    res.status(500).json({
      enabled: false,
      configured: false,
      status: 'error',
      error: 'Failed to read IBKR Flex status',
    });
  }
});

app.post('/api/ibkr/flex/sync', async (req, res) => {
  const startTime = Date.now();
  try {
    const date = req.query.date || req.body?.date;
    const snapshot = await fetchFlexStatement({ date });
    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/ibkr/flex/sync completed in ${totalTime}ms date=${snapshot.date} positions=${snapshot.positionCount}`);
    res.json({
      ok: true,
      status: 'ready',
      durationMs: totalTime,
      flex: {
        date: snapshot.date,
        fetchedAt: snapshot.fetchedAt,
        reportDate: snapshot.reportDate,
        accountId: snapshot.accountId,
        currency: snapshot.currency,
        positionCount: snapshot.positionCount,
        exposure: snapshot.exposure,
      },
    });
  } catch (error) {
    const totalTime = Date.now() - startTime;
    const code = error.code || 'flex_error';
    console.warn(`[API] /api/ibkr/flex/sync unavailable after ${totalTime}ms:`, error.message);
    res.status(code === 'flex_disabled' || code === 'flex_missing_config' ? 409 : 502).json({
      ok: false,
      status: 'unavailable',
      code,
      durationMs: totalTime,
      error: error.message || 'IBKR Flex sync unavailable',
    });
  }
});

app.get('/api/portfolio/exposure/reconciliation', (req, res) => {
  try {
    res.json(getFlexReconciliation({ date: req.query.date }));
  } catch (error) {
    console.error('[API] Error in /api/portfolio/exposure/reconciliation:', error);
    res.status(500).json({
      status: 'error',
      source: 'ibkr_flex_web_service',
      error: 'Failed to read IBKR Flex reconciliation snapshot',
    });
  }
});

app.get('/api/ibkr/interest-validation/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const refreshLive = ['1', 'true'].includes(
      String(req.query.refreshLive || '').trim().toLowerCase(),
    );
    let liveRefreshError = null;
    if (refreshLive) {
      const accountId = String(
        req.query.account || process.env.IBKR_ACCOUNT_ID || '',
      ).trim() || undefined;
      try {
        await readVerifiedPortfolioBalance(accountId);
      } catch (error) {
        liveRefreshError = error;
        console.warn(
          '[IBKR Interest Validation] live MTD refresh unavailable:',
          error?.code || error?.message || 'portfolio_balance_unavailable',
        );
      }
    }
    const status = await getIbkrInterestValidationStatusAsync({
      account: req.query.account,
    });
    if (!liveRefreshError) return res.json(status);
    return res.json({
      ...status,
      mtd: {
        ...status.mtd,
        liveNetAccrued: null,
        liveNetAccruedStatus: 'unavailable',
        liveNetAccruedObservedAt: null,
        liveNetAccruedSource: null,
      },
      guard: {
        ...status.guard,
        liveNegativeAccrued: null,
        combinedReserve: null,
      },
    });
  } catch (error) {
    console.error('[API] Error in /api/ibkr/interest-validation/status:', error);
    return res.status(500).json({
      source: 'ibkr_interest_validation',
      available: false,
      status: 'unavailable',
      error: {
        code: 'interest_validation_status_error',
        message: 'IBKR interest validation status is unavailable.',
      },
      guard: {
        available: false,
        mode: 'off',
        appliedReserve: null,
      },
    });
  }
});

app.get('/api/ibkr/interest-validation/history', async (req, res) => {
  try {
    res.json(await getIbkrInterestValidationHistoryAsync({
      limit: req.query.limit,
    }));
  } catch (error) {
    console.error('[API] Error in /api/ibkr/interest-validation/history:', error);
    res.status(500).json({
      source: 'ibkr_interest_validation',
      predictions: [],
      actuals: [],
      misses: [],
      error: 'IBKR interest validation history is unavailable.',
    });
  }
});

app.get('/api/ibkr/interest-validation/ledger', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const accountId = String(req.query.account || '').trim();
  if (!accountId) {
    return res.status(400).json({
      source: 'ibkr_verified_interest_ledger',
      available: false,
      status: 'unavailable',
      accountMatched: false,
      fromCache: false,
      error: {
        code: 'interest_ledger_account_required',
        message: 'An explicit IBKR account is required for the interest ledger.',
      },
    });
  }
  try {
    return res.json(await readPrivateInterestLedgerAsync({ accountId }));
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 503;
    console.warn(
      '[API] /api/ibkr/interest-validation/ledger unavailable:',
      error?.code || 'interest_ledger_unavailable',
    );
    return res.status(status).json({
      source: 'ibkr_verified_interest_ledger',
      available: false,
      status: 'unavailable',
      accountMatched: false,
      fromCache: false,
      error: {
        code: error?.code || 'interest_ledger_unavailable',
        message: 'Verified IBKR interest-ledger evidence is unavailable.',
      },
    });
  }
});

app.post('/api/ibkr/interest-validation/run', async (req, res) => {
  const startedAt = Date.now();
  try {
    const result = await runIbkrInterestValidation({
      trigger: 'manual',
      force: true,
    });
    res.json({
      ...result,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    console.error('[API] Error in /api/ibkr/interest-validation/run:', error);
    res.status(503).json({
      source: 'ibkr_interest_validation',
      available: false,
      status: 'unavailable',
      durationMs: Date.now() - startedAt,
      error: {
        code: 'interest_validation_run_error',
        message: 'Verified IBKR interest inputs are unavailable.',
      },
      guard: {
        available: false,
        mode: 'off',
        appliedReserve: null,
      },
    });
  }
});

app.get('/api/options', (req, res) => {
  res.status(503).json({ status: 'unavailable', options: [], reason: 'verified_options_provider_unavailable' });
});


app.get('/api/indicators/vix', createVixHandler({ fetchVIXData }));

app.get('/api/indicators/volatility/:ticker', createVolatilityHandler({ fetchVolatilityData }));

app.get('/api/volatility-snapshot', createVolatilitySnapshotHandler({ volatilitySnapshotService }));

// Money flow: Fed net liquidity (supply) confirmed by up/down volume participation.
app.get('/api/money-flow', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const data = await moneyFlowService.getMoneyFlow({ refresh: req.query.refresh === 'true' });
    res.status(data.verdict === 'unavailable' ? 503 : 200).json(data);
  } catch (error) {
    console.error('[API] Error in /api/money-flow:', error);
    res.status(500).json({ error: 'Failed to build money flow', details: error.message });
  }
});

// Each completed-session volume source is verified independently on refresh.
app.get('/api/volume/market-share', createExchangeVolumeHandler({ exchangeVolumeService }));

// USD Macro Dashboard API Endpoints

// Verified, current-week tier-one macro calendar. The provider service owns the
// bounded upstream cache; the API itself is never browser/proxy cached.
app.get('/api/market-events', createMarketEventsHandler({ marketEventsService }));
app.get('/api/market/daily-snapshot', createMarketDailyHandler());
app.get('/api/market/rotation-snapshot', createMarketRotationHandler());
app.get('/api/market/sp500-contributors', createSp500ContributorsHandler({
  loadMomoSnapshot: async () => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const result = await dynamodb.get({
      TableName: 'HedgeyeDailySnapshot',
      Key: { date, snapshotType: 'momo-tracker' },
      ConsistentRead: true,
    }).promise();
    if (!result.Item) return null;
    // Keep publication evidence and rejection flags, but omit article/media
    // bodies from the frequently refreshed market-data response.
    const { article, htmlSource, screenshotS3Key, ...snapshot } = result.Item;
    return { ...snapshot, meta: { ...snapshot.meta, stockCount: snapshot.stockCount ?? snapshot.meta?.stockCount } };
  },
}));

// Get latest DXY value
app.get('/api/usd/dxy', async (req, res) => {
  try {
    const params = {
      TableName: 'MarketPriceHistory',
      KeyConditionExpression: 'symbol = :symbol',
      ExpressionAttributeValues: {
        ':symbol': 'DXY'
      },
      ScanIndexForward: false, // Sort by date descending
      Limit: 2 // Get latest and previous for change calculation
    };

    const result = await dynamodb.query(params).promise();

    if (!result.Items || result.Items.length === 0) {
      return res.json({
        value: null,
        change: null,
        changePercent: null,
        timestamp: null,
        message: 'No DXY data available'
      });
    }

    const latest = result.Items[0];
    const previous = result.Items[1];

    const value = parseFloat(latest.close);
    const change = previous ? value - parseFloat(previous.close) : 0;
    const changePercent = previous ? ((change / parseFloat(previous.close)) * 100).toFixed(2) : '0.00';

    res.json({
      value: value,
      change: change.toFixed(2),
      changePercent: changePercent,
      timestamp: latest.timestamp
    });

  } catch (error) {
    console.error('Error fetching DXY data:', error);
    res.status(500).json({ error: 'Failed to fetch DXY data' });
  }
});

// Currency-pair quotes remain unavailable until a verified provider is wired.
app.get('/api/usd/currency-pairs', createCurrencyPairsHandler());

const fxvlSnapshotService = createFxvlSnapshotService({
  fetchPairHistory: (symbol) => fetchYahooDailyClosesSeries(symbol, '2y'),
});
const usdCorrelationService = createUsdCorrelationService({
  // Yahoo has no 2-year yield index; the Treasury par curve publishes it the same day.
  fetchHistory: (symbol) => (symbol === 'UST2Y'
    ? fetchTreasuryParYieldSeries('2 Yr', { httpGet: axios.get })
    : fetchYahooDailyClosesSeries(YAHOO_TICKER_MAP[symbol] || symbol, '2y')),
  fetchFxvlSnapshot: () => fxvlSnapshotService.getSnapshot(),
});
// Get USD correlations from current daily market history.
app.get('/api/usd/correlations', createUsdCorrelationHandler({ usdCorrelationService }));

// Helper function to normalize currency pair symbols
function normalizeCurrencySymbol(symbol) {
  const currencyPairMap = {
    'EUR/USD': 'USDEUR',
    'USD/EUR': 'USDEUR',
    'GBP/USD': 'USDGBP',
    'USD/GBP': 'USDGBP',
    'CAD/USD': 'USDCAD',
    'USD/CAD': 'USDCAD',
    'JPY/USD': 'USDJPY',
    'USD/JPY': 'USDJPY',
    'USD/YEN': 'USDJPY',
    'CHF/USD': 'USDCHF',
    'USD/CHF': 'USDCHF',
    'CNY/USD': 'USDCNY',
    'USD/CNY': 'USDCNY',
    'AUD/USD': 'USDAUD',
    'USD/AUD': 'USDAUD',
    'NZD/USD': 'USDNZD',
    'USD/NZD': 'USDNZD'
  };
  return currencyPairMap[symbol.toUpperCase()] || symbol.toUpperCase();
}

// Get historical price data for a specific symbol
// Uses query parameter to handle symbols with slashes (e.g., GBP/USD, EUR/USD)
app.get('/api/usd/historical', async (req, res) => {
  const startTime = Date.now();
  const now = Date.now();
  try {
    const { symbol, days = 30 } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol query parameter is required' });
    }

    // Decode URL-encoded symbols
    let decodedSymbol = decodeURIComponent(symbol);

    // Normalize currency pair formats
    const normalizedSymbol = normalizeCurrencySymbol(decodedSymbol);
    const cacheKey = normalizedSymbol;

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    // Format dates as YYYY-MM-DD for DynamoDB
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    const dbStartTime = Date.now();
    const params = {
      TableName: 'MarketPriceHistory',
      KeyConditionExpression: 'symbol = :symbol AND #date BETWEEN :startDate AND :endDate',
      ExpressionAttributeNames: {
        '#date': 'date'
      },
      ExpressionAttributeValues: {
        ':symbol': normalizedSymbol,
        ':startDate': startDateStr,
        ':endDate': endDateStr
      },
      ScanIndexForward: true
    };

    const result = await dynamodb.query(params).promise();
    const dbTime = Date.now() - dbStartTime;
    console.log(`[API] Historical data query for ${normalizedSymbol} completed in ${dbTime}ms, found ${result.Items.length} items`);

    // If no data in database, try fetching from Yahoo Finance as fallback
    if (!result.Items || result.Items.length === 0) {
      console.log(`No historical data found in database for ${normalizedSymbol} (original: ${decodedSymbol}), trying Yahoo Finance fallback...`);

      const yahooTickerMap = {
        'DXY': 'DX-Y.NYB',
        'USDEUR': 'USDEUR=X',
        'EURUSD': 'EURUSD=X',
        'USDJPY': 'USDJPY=X',
        'JPYUSD': 'JPY=X',
        'USDGBP': 'USDGBP=X',
        'GBPUSD': 'GBPUSD=X',
        'USDCHF': 'USDCHF=X',
        'CHFUSD': 'USDCHF=X',
        'USDCAD': 'USDCAD=X',
        'CADUSD': 'CADUSD=X',
        'USDCNY': 'USDCNY=X',
        'CNYUSD': 'USDCNY=X',
        'USDAUD': 'USDAUD=X',
        'AUDUSD': 'USDAUD=X',
        'USDNZD': 'USDNZD=X',
        'NZDUSD': 'USDNZD=X',
        'EUR/USD': 'EURUSD=X',
        'USD/EUR': 'USDEUR=X',
        'GBP/USD': 'GBPUSD=X',
        'USD/GBP': 'USDGBP=X',
        'CAD/USD': 'CADUSD=X',
        'USD/CAD': 'USDCAD=X',
        'JPY/USD': 'JPY=X',
        'USD/JPY': 'USDJPY=X',
        'USD/YEN': 'JPY=X',
        'CHF/USD': 'USDCHF=X',
        'USD/CHF': 'USDCHF=X',
        'CNY/USD': 'USDCNY=X',
        'USD/CNY': 'USDCNY=X',
        'AUD/USD': 'USDAUD=X',
        'USD/AUD': 'USDAUD=X',
        'NZD/USD': 'USDNZD=X',
        'USD/NZD': 'USDNZD=X'
      };

      const yahooTicker = yahooTickerMap[normalizedSymbol] || yahooTickerMap[decodedSymbol.toUpperCase()] || decodedSymbol;

      try {
        const range = days <= 7 ? '5d' : days <= 30 ? '1mo' : days <= 90 ? '3mo' : days <= 180 ? '6mo' : '1y';
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}`;
        const response = await axios.get(url, {
          params: {
            range: range,
            interval: '1d',
            includePrePost: 'false'
          },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 10000
        });

        const data = response.data;
        console.log(`[Yahoo Debug] ${yahooTicker} - Chart Result Length:`, data.chart?.result?.length);
        if (data.chart?.result?.[0]?.indicators?.quote?.[0]) {
          const q = data.chart.result[0].indicators.quote[0];
          console.log(`[Yahoo Debug] ${yahooTicker} - Volume array length:`, q.volume ? q.volume.length : 'undefined');
        }
        if (data.chart && data.chart.result && data.chart.result.length > 0) {
          const result = data.chart.result[0];
          const timestamps = result.timestamp || [];
          const quotes = result.indicators?.quote?.[0];

          if (quotes && quotes.close && quotes.close.length > 0) {
            const historicalData = [];
            for (let i = 0; i < timestamps.length; i++) {
              const closePrice = quotes.close[i];
              // Skip null/undefined close prices
              if (closePrice === null || closePrice === undefined) continue;

              const date = new Date(timestamps[i] * 1000);
              const dateStr = date.toISOString().split('T')[0];

              historicalData.push({
                date: dateStr,
                close: closePrice,
                open: quotes.open?.[i] || null,
                high: quotes.high?.[i] || null,
                low: quotes.low?.[i] || null,
                volume: quotes.volume?.[i] || null
              });
            }

            // For small day ranges, just return the most recent data points
            // This ensures charts always have enough data to render
            const requestedDays = parseInt(days);
            const minDataPoints = Math.max(requestedDays, 5); // At least 5 points for a decent chart
            const trimmedData = historicalData.slice(-minDataPoints);

            if (trimmedData.length > 0) {
              const responseData = {
                symbol: decodedSymbol,
                data: trimmedData,
                count: trimmedData.length
              };

              // Store in cache (even for Yahoo Finance fallback)
              historicalCache.set(cacheKey, {
                data: responseData,
                timestamp: Date.now()
              });

              console.log(`Fetched ${trimmedData.length} data points from Yahoo Finance for ${normalizedSymbol} (original: ${decodedSymbol})`);
              return res.json(responseData);
            }
          }
        }
      } catch (yahooError) {
        // Log Yahoo Finance errors but don't block the overall response
        console.error(`Error fetching from Yahoo Finance for ${normalizedSymbol} (original: ${decodedSymbol}):`, yahooError.message);
      }

      console.log(`No historical data available for ${normalizedSymbol} (original: ${decodedSymbol}) from any source`);
      return res.json({
        symbol: decodedSymbol,
        data: [],
        message: `No historical data available for ${decodedSymbol} in the requested date range`
      });
    }

    const historicalData = result.Items.map(item => ({
      date: item.date,
      close: parseFloat(item.close),
      open: item.open ? parseFloat(item.open) : null,
      high: item.high ? parseFloat(item.high) : null,
      low: item.low ? parseFloat(item.low) : null,
      volume: item.volume || null
    }));

    const responseData = {
      symbol: decodedSymbol,
      data: historicalData,
      count: historicalData.length
    };

    // Store in cache
    historicalCache.set(cacheKey, {
      data: responseData,
      timestamp: now
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/usd/historical completed: ${historicalData.length} data points for ${normalizedSymbol} (original: ${decodedSymbol}, requested ${days} days) in ${totalTime}ms (DB: ${dbTime}ms)`);

    res.json(responseData);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    const symbolParam = req.query.symbol || 'unknown';
    console.error(`[API] Error in /api/usd/historical for ${symbolParam} after ${totalTime}ms:`, error);
    res.status(500).json({ error: `Failed to fetch historical data for ${symbolParam}` });
  }
});

const systemReadinessService = createSystemReadinessService({
  sidecarRequest,
  expectedIbkrAccounts: expectedIbkrAccountIds(),
  getDirectorSnapshot,
  buildWorkflowStatusSnapshot: async () => {
    const cache = await researchResponseCache.get('workflow-snapshot:readiness', buildWorkflowStatusSnapshot);
    return {
      ...cache.value,
      _readinessCache: { status: cache.status, ageMs: cache.ageMs || 0 },
    };
  },
  getHermesInboxStatus,
  buildRtaResponse: async () => {
    const cache = await researchResponseCache.get(
      'readiness:rta-positions:90',
      buildRealTimeAlertPositionsResponse,
    );
    return {
      ...cache.value,
      _readinessCache: { status: cache.status, ageMs: cache.ageMs || 0 },
    };
  },
  buildEtfResponse: async () => {
    const cache = await researchResponseCache.get(
      'readiness:etf-pro',
      buildEtfProResponse,
    );
    return {
      ...cache.value,
      _readinessCache: { status: cache.status, ageMs: cache.ageMs || 0 },
    };
  },
  dynamodb,
  cloudwatch,
  listWorkerDefinitions,
  legacyMode: legacyHermesMode,
  // The reliability controller defers stack restarts while this reports work.
  readAnalystActivity: ({ windowSeconds }) => analystRoutes.workspace.call(
    'activity',
    { windowSeconds },
    { timeoutMs: 5_000 },
  ),
  readPortfolioCloseBaseline: () => analystRoutes.dailyWorkflow.portfolioCloseBaseline(),
});

async function readDashboardStatusEvidence() {
  if (process.env.NODE_ENV === 'production') {
    const indexPath = path.join(__dirname, 'build', 'index.html');
    try {
      fs.accessSync(indexPath, fs.constants.R_OK);
      return {
        apiAvailable: true,
        uiAvailable: fs.statSync(indexPath).isFile(),
        uiVerified: true,
      };
    } catch (_error) {
      return {
        apiAvailable: true,
        uiAvailable: false,
        uiVerified: true,
      };
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 350);
  try {
    const response = await fetch('http://127.0.0.1:3000/', {
      headers: { Accept: 'text/html' },
      signal: controller.signal,
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel().catch(() => {});
    }
    return {
      apiAvailable: true,
      uiAvailable: response.ok && contentType.includes('text/html'),
      uiVerified: true,
    };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return {
      apiAvailable: true,
      uiAvailable: timedOut ? null : false,
      uiVerified: !timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function readMarketDataStatusEvidence() {
  return summarizeMarketDataStatusEvidence({
    quoteEntries: [...quotesCache.values()],
    providerStatus: getProviderStatusSnapshot(),
    nowMs: Date.now(),
    maxAgeMs: 60_000,
    cacheTtlMs: CACHE_TTL,
  });
}

async function readAiStatusEvidence() {
  const evaluationNow = new Date();
  const analyst = buildAnalystRuntimeCheck({
    supervisor: getSupervisorProvenance(),
    now: evaluationNow,
  });
  const gmailAccount = String(
    process.env.HERMES_GMAIL_ACCOUNT || 'timsmithaviation@gmail.com',
  ).trim().toLowerCase();
  const gmailRecord = {
    serviceId: `gmail:${gmailAccount}`,
    label: 'Gmail Function',
    scheduleId: process.env.HERMES_GMAIL_SCHEDULE_ID
      || GMAIL_SERVICE_DEFINITION?.aws?.scheduleId
      || 'market-dashboard-gmail-v2-every-15m',
    maxAgeMinutes: Number(
      process.env.GMAIL_HEARTBEAT_MAX_AGE_MINUTES
      || GMAIL_SERVICE_DEFINITION?.readinessMaxAgeMinutes
      || 45,
    ),
  };

  // Heartbeat reads are intentionally independent of the startup S3
  // HeadBucket check. The local runtime may be allowed to read DynamoDB even
  // when unrelated upload-bucket access is unavailable.
  const gmail = await collectScheduledHeartbeatEvidence({
    records: [gmailRecord],
    readHeartbeat: (serviceId) => getServiceHeartbeat(dynamodb, serviceId),
  });
  return { analyst, gmail, levels: alphaCodeLevels?.coverage || [] };
}

const systemStatusService = createSystemStatusService({
  readDashboardEvidence: readDashboardStatusEvidence,
  readMarketDataEvidence: readMarketDataStatusEvidence,
  // Gateway connectivity and live-position readiness are separate facts. The
  // portfolio status probe is intentionally lightweight and only reports
  // "ready" after /portfolio/live-positions has verified a fresh snapshot.
  readLivePortfolioEvidence: () => sidecarRequest('/portfolio/status', { timeoutMs: 600 }),
  // The Analyst runtime check proves only assistant availability. Portfolio and
  // market-data services remain the authority for verified live trading data.
  readAiEvidence: readAiStatusEvidence,
});

const loginGmailAccount = String(
  process.env.HERMES_GMAIL_ACCOUNT || 'timsmithaviation@gmail.com',
).trim().toLowerCase();
const loginGmailScheduleId = process.env.HERMES_GMAIL_SCHEDULE_ID
  || GMAIL_SERVICE_DEFINITION?.aws?.scheduleId
  || 'market-dashboard-gmail-v2-every-15m';
const loginStatusService = createLoginStatusService({
  readIbkr: () => sidecarRequest('/status', { timeoutMs: 1_500 }),
  readGmail: () => getServiceHeartbeat(dynamodb, `gmail:${loginGmailAccount}`),
  readAwsProfile: createAwsProfileProbe({ repoRoot: __dirname }),
  gmailAccount: loginGmailAccount,
  gmailScheduleId: loginGmailScheduleId,
});
let loginActionService;
async function collectLoginStatus(options = {}) {
  const report = await loginStatusService.collect(options);
  loginActionService?.syncVerification(report);
  return {
    ...report,
    actions: loginActionService?.getStatus() || {},
  };
}
loginActionService = createLoginActionService({
  repoRoot: __dirname,
  onSettled: () => {
    collectLoginStatus({ force: true }).catch(() => {});
  },
});

const systemReadinessRepairService = createSystemReadinessRepairService({
  lambdaClient: lambda,
  collectReadiness: () => systemReadinessService.collectForVerification(),
});

// Lightweight, on-demand status for the SYS flyout. Each dependency is
// independently bounded by systemStatusService; this route never invokes the
// full operational-readiness collector.
app.get('/api/system-status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.json(await systemStatusService.collect());
  } catch (error) {
    console.warn('[API] Lightweight system status failed:', error.message);
    return res.json(createUnavailableSystemStatus());
  }
});

// Cached, asynchronous authentication checks are deliberately separate from
// the sub-second Systems collector. Public results contain no credential,
// principal, account-ID, key-path, or balance values.
app.get('/api/login-status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const refresh = String(req.query.refresh || '').trim().toLowerCase();
    return res.json(await collectLoginStatus({
      force: refresh === '1' || refresh === 'true',
      fast: refresh === 'fast',
      slow: refresh === 'slow',
    }));
  } catch (error) {
    console.warn('[API] Login status collection failed:', error.message);
    loginActionService?.syncVerification(loginStatusService.report());
    return res.json({
      ...loginStatusService.report(),
      actions: loginActionService?.getStatus() || {},
    });
  }
});

app.post('/api/login-status/actions/:actionId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.get('X-Login-Action') !== '1') {
    return res.status(403).json({
      accepted: false,
      errorCode: 'LOGIN_ACTION_CONFIRMATION_REQUIRED',
      error: 'Login action confirmation is required.',
    });
  }
  try {
    const result = await loginActionService.run(req.params.actionId, {
      remoteAddress: req.socket?.remoteAddress,
    });
    return res.status(202).json(result);
  } catch (error) {
    return res.status(error.statusCode || 503).json({
      accepted: false,
      errorCode: error.code || 'LOGIN_ACTION_FAILED',
      error: error.message || 'The approved login action could not be started.',
    });
  }
});

app.use('/api/system-readiness', createSystemReadinessRoutes({
  readinessService: systemReadinessService,
  repairService: systemReadinessRepairService,
  invalidateResearchProjections: () => {
    checkpointFirstResearchResponse.invalidate('rta-positions:90');
    researchResponseCache.delete('readiness:rta-positions:90');
  },
}));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Daily Notes API Endpoints

// List all dates that have notes
app.get('/api/notes', async (req, res) => {
  try {
    const params = {
      TableName: 'DailyNotes',
      ProjectionExpression: '#dt', // Only retrieve the date attribute (using alias for reserved keyword)
      ExpressionAttributeNames: {
        '#dt': 'date'
      }
    };

    const result = await readAllDynamoItems(dynamodb, 'scan', params);

    // Extract dates and sort descending (newest first)
    const dates = result.Items
      .map(item => item.date)
      .filter(date => date) // Filter out any null/undefined dates
      .sort()
      .reverse(); // Sort descending (newest first)

    res.json({
      dates: dates,
      count: dates.length
    });

  } catch (error) {
    console.error('Error listing note dates:', error);
    res.status(500).json({
      error: 'Failed to list note dates',
      details: error.message
    });
  }
});

// Save a note for a specific date
app.post('/api/notes', async (req, res) => {
  try {
    const { date, content } = req.body;

    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const params = {
      TableName: 'DailyNotes',
      Item: {
        date: date,
        content: content || '',
        timestamp: new Date().toISOString(),
      }
    };

    await dynamodb.put(params).promise();

    res.json({
      success: true,
      date: date,
      timestamp: params.Item.timestamp
    });

  } catch (error) {
    console.error('Error saving note:', error);
    res.status(500).json({
      error: 'Failed to save note',
      details: error.message
    });
  }
});

// Get a note for a specific date
app.get('/api/notes/:date', async (req, res) => {
  try {
    const { date } = req.params;

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const params = {
      TableName: 'DailyNotes',
      Key: {
        date: date
      }
    };

    const result = await dynamodb.get(params).promise();

    if (!result.Item) {
      return res.status(404).json({
        error: 'Note not found',
        date: date
      });
    }

    res.json({
      date: result.Item.date,
      content: result.Item.content,
      timestamp: result.Item.timestamp
    });

  } catch (error) {
    console.error('Error loading note:', error);
    res.status(500).json({
      error: 'Failed to load note',
      details: error.message
    });
  }
});

// Calendar Notes API Endpoints

// Save a calendar note for a specific date
app.post('/api/notes/calendar', async (req, res) => {
  try {
    const { date, content } = req.body;

    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const params = {
      TableName: 'CalendarNotes',
      Item: {
        date: date,
        content: content || '',
        timestamp: new Date().toISOString(),
      }
    };

    await dynamodb.put(params).promise();

    res.json({
      success: true,
      date: date,
      timestamp: params.Item.timestamp
    });

  } catch (error) {
    console.error('Error saving calendar note:', error);
    res.status(500).json({
      error: 'Failed to save calendar note',
      details: error.message
    });
  }
});

// Get a calendar note for a specific date
app.get('/api/notes/calendar/:date', async (req, res) => {
  try {
    const { date } = req.params;

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const params = {
      TableName: 'CalendarNotes',
      Key: {
        date: date
      }
    };

    const result = await dynamodb.get(params).promise();

    if (!result.Item) {
      return res.status(404).json({
        error: 'Calendar note not found',
        date: date
      });
    }

    res.json({
      date: result.Item.date,
      content: result.Item.content,
      timestamp: result.Item.timestamp
    });

  } catch (error) {
    console.error('Error loading calendar note:', error);
    res.status(500).json({
      error: 'Failed to load calendar note',
      details: error.message
    });
  }
});

// Development-only diagnostics. Production does not register this route, and
// the response never discloses account bucket names.
if (process.env.NODE_ENV === 'development') {
  app.get('/api/aws-status', async (req, res) => {
    try {
      const credentials = AWS.config.credentials;
      const region = AWS.config.region;
      let storageStatus = 'unknown';

      try {
        await s3.headBucket({ Bucket: PORTFOLIO_UPLOAD_BUCKET }).promise();
        storageStatus = 'accessible';
      } catch (error) {
        storageStatus = 'error';
      }

      res.json({
        aws: {
          region,
          credentialsConfigured: !!credentials,
          credentialsType: credentials ? credentials.constructor.name : 'none',
          storageStatus,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to check AWS status',
        details: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  });
}

// Serve static files only in production
// In development, React dev server handles frontend (run separately on port 3000)
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));

  // Serve React app for all non-API routes (must be last route)
  // Use a function-based route matcher for Express 5 compatibility
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
} else {
  // In development, log that React dev server should be running separately
  console.log('📝 Development mode: React dev server should run separately on port 3000');
  console.log('   Start it with: npm start');
}

// Keep this after every route. A route that throws answers here with JSON,
// like the rest of the API, instead of Express's HTML error page.
app.use(createApiErrorHandler());

// Start HTTP server first so we can attach WebSocket server to it
const server = app.listen(PORT, HOST, async () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`📊 Market data API available at http://${HOST}:${PORT}/api`);
  console.log(`💼 Portfolio data available at http://${HOST}:${PORT}/api/portfolio`);

  analystRoutes.cleanupStaging().catch((error) => {
    console.warn('[Analyst] Initial staging cleanup failed:', error.message);
  });
  if (process.env.ANALYST_SERVICE_TOKEN) {
    const analystSidecarBase = String(
      process.env.ANALYST_SIDECAR_URL || 'http://127.0.0.1:6951',
    ).replace(/\/$/, '');
    axios.post(`${analystSidecarBase}/internal/sync`, {}, {
      headers: { Authorization: `Bearer ${process.env.ANALYST_SERVICE_TOKEN}` },
      timeout: 10 * 60 * 1000,
    }).then((response) => {
      console.log(`[Analyst] Initial research sync ${response.data?.status || 'completed'}.`);
    }).catch((error) => {
      console.warn('[Analyst] Initial research sync deferred:', error.message);
    });
  }

  if (process.env.NODE_ENV !== 'test') pcaRiskService.start();
  if (process.env.NODE_ENV !== 'test') riskRangeRevisionWatch.start();

  loginStatusService.start().catch((error) => {
    console.warn('[Login status] Initial collection failed:', error.message);
  });

  if (ibkrStreamBridge.STREAM_ENABLED) {
    ibkrStreamBridge.startIbkrStreamBridge();
    console.log('📡 IBKR stream bridge enabled (SSE → quotes state cache)');
  }

  if (process.env.NODE_ENV !== 'test') {
    startIbkrInterestValidation().then((status) => {
      console.log(
        `[IBKR Interest Validation] startup ${status.status}`
        + ` (${status.enabled ? 'enabled' : 'disabled'})`,
      );
    }).catch((err) => {
      console.warn('[IBKR Interest Validation] startup failed:', err.message);
    });
    startFlexActivitySync({ logger: console });
  }

  // Validate AWS credentials after server starts
  await validateAWSCredentials();
});

analystGatewayProxy = attachAnalystGatewayProxy(server, { runtimeGate: analystRuntimeGate });
analystRoutes.dailyWorkflow.start();

// Fail loud and fast on listen errors so the process exits with a non-zero
// code instead of being swallowed by the uncaughtException FATAL-GUARD
// below. Without this, EADDRINUSE silently drains the event loop and the
// process exits 0, which causes `concurrently -k` to kill `npm start` too.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${PORT} is already in use. Another server.js is probably still running.`);
    console.error(`        Run:  lsof -iTCP:${PORT} -sTCP:LISTEN -n -P    then:  kill <pid>`);
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`[FATAL] Permission denied binding to port ${PORT}.`);
    process.exit(1);
  }
  console.error('[FATAL] HTTP server error:', err);
  process.exit(1);
});

// -----------------------------
// WebSocket: /ws/market
// -----------------------------
// Each WebSocket surface owns only its exact upgrade path. Using multiple
// WebSocketServer({ server, path }) instances on the same HTTP server lets
// competing upgrade listeners touch the same socket and corrupt frames.
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const handleMarketWebSocketUpgrade = (request, socket, head) => {
  let pathname;
  try {
    pathname = new URL(request.url || '/', 'http://localhost').pathname;
  } catch (_error) {
    return;
  }
  if (pathname !== '/ws/market') return;
  const trust = validateLocalRequest(request);
  if (!trust.ok) return rejectWebSocketUpgrade(socket, trust.statusCode);
  if (wss.clients.size >= 20) return rejectWebSocketUpgrade(socket, 429);
  wss.handleUpgrade(request, socket, head, (client) => {
    wss.emit('connection', client, request);
  });
};
server.on('upgrade', handleMarketWebSocketUpgrade);

// Simple subscription tracking (by channel)
const channelToClients = new Map();
const quoteSubscriptions = require('./src/services/ibkr/quoteSubscriptions.cjs').createQuoteSubscriptionRegistry();
const wsClientSymbols = quoteSubscriptions.clients;
const symbolRefCount = quoteSubscriptions.refCounts;
const wsLastBroadcast = new Map();
const WS_QUOTE_THROTTLE_MS = Number(process.env.IBKR_WS_QUOTE_THROTTLE_MS || 250);

function addClientToChannel(ws, channel) {
  if (!channelToClients.has(channel)) {
    channelToClients.set(channel, new Set());
  }
  channelToClients.get(channel).add(ws);
}

function removeClientFromAllChannels(ws) {
  channelToClients.forEach((clients, channel) => {
    if (clients.has(ws)) {
      clients.delete(ws);
      if (clients.size === 0) channelToClients.delete(channel);
    }
  });
}

function releaseWsSymbols(ws) {
  quoteSubscriptions.release(ws);
  ibkrStreamBridge.setDesiredSymbols(quoteSubscriptions.desiredSymbols());
}

async function subscribeWsSymbols(ws, symbols) {
  let list;
  try {
    list = quoteSubscriptions.replace(ws, symbols);
  } catch (error) {
    ws.close(1008, error.message);
    return;
  }
  ibkrStreamBridge.setDesiredSymbols(quoteSubscriptions.desiredSymbols());
  for (const sym of list) {
    const cached = ibkrStreamBridge.getCachedLegacy(sym);
    if (cached && isQuoteUsableNow(cached, sym) && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ channel: 'quotes', payload: cached }));
  }
}

if (ibkrStreamBridge.STREAM_ENABLED) {
  ibkrStreamBridge.onQuote(legacy => {
    const sym = (legacy.symbol || '').toUpperCase();
    if (!sym || !(symbolRefCount.get(sym) > 0)) return;
    const clients = channelToClients.get('quotes');
    if (!clients || clients.size === 0) return;

    const last = wsLastBroadcast.get(sym) || 0;
    if (Date.now() - last < WS_QUOTE_THROTTLE_MS) return;
    wsLastBroadcast.set(sym, Date.now());
    if (!isQuoteUsableNow(legacy, sym)) return;
    const message = JSON.stringify({ channel: 'quotes', payload: legacy });
    clients.forEach(client => {
      if (client.readyState === client.OPEN && wsClientSymbols.get(client)?.has(sym)) {
        if (client.bufferedAmount > 1024 * 1024) client.close(1013, 'Slow consumer');
        else client.send(message);
      }
    });
  });
}

wss.on('connection', (ws) => {
  console.log('🔌 WebSocket client connected');

  const consumeMessageBudget = createMessageBudget();
  ws.on('message', (msg) => {
    if (!consumeMessageBudget()) { ws.close(1008, 'Message rate exceeded'); return; }
    try {
      const data = JSON.parse(msg.toString());
      if (data?.channel !== 'quotes') { ws.close(1008, 'Unsupported channel'); return; }
      if (data && data.action === 'subscribe' && data.channel) {
        addClientToChannel(ws, data.channel);
        if (data.channel === 'quotes' && Array.isArray(data.symbols)) {
          subscribeWsSymbols(ws, data.symbols).catch(err => {
            console.error('[WS] subscribe symbols error:', err.message);
          });
        }
        ws.send(JSON.stringify({ channel: 'system', payload: { status: 'subscribed', channel: data.channel } }));
      }
      if (data && data.action === 'unsubscribe' && data.channel) {
        const clients = channelToClients.get(data.channel);
        if (clients) clients.delete(ws);
        if (data.channel === 'quotes') {
          releaseWsSymbols(ws);
        }
        ws.send(JSON.stringify({ channel: 'system', payload: { status: 'unsubscribed', channel: data.channel } }));
      }
      if (data && data.action === 'update_symbols' && data.channel === 'quotes' && Array.isArray(data.symbols)) {
        subscribeWsSymbols(ws, data.symbols).catch(err => {
          console.error('[WS] update symbols error:', err.message);
        });
      }
    } catch (err) {
      console.error('WS message parse error:', err);
    }
  });

  ws.on('close', () => {
    releaseWsSymbols(ws);
    removeClientFromAllChannels(ws);
    console.log('🔌 WebSocket client disconnected');
  });
});

// Periodic cache eviction. Module-scope Maps are storing entries keyed by
// either `timestamp` (most caches) or `ts` (periodReturnsCache). Without
// eviction + a hard size ceiling, a long-running dev session lets these
// Maps grow until V8 hits --max-old-space-size and aborts the process
// (npm surfaces that as "npm run server exited with code 1").
const CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || '5000', 10);

const getEntryTimestamp = (value) => {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.timestamp === 'number') return value.timestamp;
  if (typeof value.ts === 'number') return value.ts;
  return null;
};

const sweepTtlCache = (cache, ttlMs, label) => {
  if (!cache || typeof cache.entries !== 'function') return;
  const now = Date.now();
  let removed = 0;

  for (const [key, value] of cache.entries()) {
    const ts = getEntryTimestamp(value);
    if (ts === null) continue;
    if (now - ts > ttlMs) {
      cache.delete(key);
      removed++;
    }
  }

  // Hard cap: if still oversized, drop oldest entries (Map preserves insert
  // order, so iterating from the start gives us the oldest first).
  if (cache.size > CACHE_MAX_ENTRIES) {
    const overflow = cache.size - CACHE_MAX_ENTRIES;
    let dropped = 0;
    for (const key of cache.keys()) {
      if (dropped >= overflow) break;
      cache.delete(key);
      dropped++;
    }
    if (dropped > 0) {
      console.log(`[CacheSweep] ${label}: capped at ${CACHE_MAX_ENTRIES}, dropped ${dropped} oldest`);
    }
  }

  if (removed > 0) {
    console.log(`[CacheSweep] ${label}: evicted ${removed} expired entries (remaining: ${cache.size})`);
  }
};

setInterval(() => {
  try {
    sweepTtlCache(quotesCache, CACHE_TTL, 'quotesCache');
    sweepTtlCache(historicalCache, HISTORICAL_CACHE_TTL, 'historicalCache');
    sweepTtlCache(
      securityRiskMetricsHistoryCache,
      SECURITY_RISK_METRICS_CACHE_TTL,
      'securityRiskMetricsHistoryCache',
    );
    sweepTtlCache(riskRangesCache, RISK_RANGES_CACHE_TTL, 'riskRangesCache');
    // chartDataCache uses per-range TTL; use the longest (1h) as upper bound
    sweepTtlCache(chartDataCache, 60 * 60 * 1000, 'chartDataCache');
    sweepTtlCache(periodReturnsCache, PERIOD_RETURNS_CACHE_TTL, 'periodReturnsCache');
  } catch (err) {
    console.warn('[CacheSweep] error:', err.message);
  }
}, CACHE_SWEEP_INTERVAL_MS).unref();

// Global error handlers — without these, a single stray rejected promise
// (e.g. a transient Yahoo Finance axios failure outside a try/catch) will
// terminate the Node process with exit code 1, killing the dev server.
// We log and keep running; real request errors are still surfaced by the
// per-route try/catch blocks that return 5xx to clients.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason && reason.stack ? reason.stack : String(reason);
  console.error('[FATAL-GUARD] Unhandled promise rejection:', msg);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL-GUARD] Uncaught exception:', err && err.stack ? err.stack : err);
  // Deliberately do not exit on transient runtime errors (e.g. stray
  // axios/Yahoo rejections) — in dev we prefer a live server with a
  // logged error over a crashed one. However, we MUST exit on fatal
  // startup errors like EADDRINUSE; otherwise the process drains its
  // event loop, exits 0, and `concurrently -k` kills the CRA dev server
  // along with it, masking the real problem.
  const fatalCodes = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);
  if (err && fatalCodes.has(err.code)) {
    process.exit(1);
  }
});

// Graceful shutdown: when concurrently (or the user) sends SIGTERM/SIGINT,
// close the HTTP server and terminate WebSocket clients so the process
// actually exits instead of lingering as a zombie holding port 3001.
const shutdown = (signal) => {
  console.log(`\n[shutdown] Received ${signal}, closing server...`);
  const done = () => process.exit(0);
  try {
    publishedTradeArchive.dispose();
    securityIntelligenceProjection.close();
    void closeWorkbookReaders();
    void portfolioResearchCapture.close();
    void hedgaiResearchWorker.close();
    pcaRiskService.stop();
    stopIbkrInterestValidation();
    void closeIbkrInterestEvidenceWorker();
    stopFlexActivitySync();
    clearInterval(analystStagingCleanupTimer);
    analystGatewayProxy?.close?.();
    server.off('upgrade', handleMarketWebSocketUpgrade);
    loginStatusService.stop();
    ibkrStreamBridge.stopIbkrStreamBridge();
    wss.clients.forEach((c) => { try { c.terminate(); } catch (_) {} });
    server.close(done);
    setTimeout(() => process.exit(0), 3000).unref();
  } catch (_) {
    process.exit(0);
  }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
