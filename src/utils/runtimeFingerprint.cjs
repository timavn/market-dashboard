const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_RUNTIME_SOURCE_FILES = Object.freeze([
  'package.json',
  'server.js',
  'ops/services.json',
  'scripts/dev-stack/cli.js',
  'scripts/ibkr_sidecar/app.py',
  'scripts/ibkr_sidecar/requirements.txt',
  'scripts/ibkr_sidecar/start.sh',
  'scripts/ops/hermes_snapshot_bridge.js',
  'src/services/systemReadinessService.cjs',
  'src/services/ibkrFlexService.cjs',
  'src/services/predictionMarketPerformanceLedger.cjs',
  'src/routes/predictionMarketPerformance.js',
  'src/routes/providers.js',
  'src/routes/predictionMarketsIngest.js',
  'src/services/predictionMarketsIngest/cache.js',
  'src/services/predictionMarketsIngest/reconciliationService.js',
  'src/services/predictionMarketsIngest/watchlistProvider.js',
  'src/services/providers/compositePortfolioDataProvider.js',
  'src/services/providers/ibkr/ibkrPortfolioDataProvider.js',
  'src/utils/authoritativeIbkrCpiContract.cjs',
  'src/utils/etfProResolver.cjs',
  'src/utils/gmailPollHealth.cjs',
  'src/utils/ibkrAccountCoverage.cjs',
  'src/utils/riskRangePublication.cjs',
  'src/utils/rtaCheckpoint.cjs',
  'src/utils/rtaLedgerMaterialization.cjs',
  'src/utils/runtimeFingerprint.cjs',
  'src/utils/systemReadiness.cjs',
]);

function computeRuntimeFingerprint(repoRoot, files = DEFAULT_RUNTIME_SOURCE_FILES) {
  const root = path.resolve(repoRoot);
  const normalizedFiles = [...new Set(files.map((file) => String(file)))].sort();
  const hash = crypto.createHash('sha256');
  const errors = [];

  for (const relativePath of normalizedFiles) {
    const absolutePath = path.resolve(root, relativePath);
    const relative = path.relative(root, absolutePath);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      errors.push({ file: relativePath, code: 'SOURCE_PATH_OUTSIDE_REPOSITORY' });
      continue;
    }
    try {
      hash.update(`${relativePath}\0`, 'utf8');
      hash.update(fs.readFileSync(absolutePath));
      hash.update('\0', 'utf8');
    } catch (error) {
      errors.push({
        file: relativePath,
        code: error.code || 'SOURCE_READ_FAILED',
        message: error.message,
      });
    }
  }

  return {
    algorithm: 'sha256',
    digest: errors.length === 0 ? hash.digest('hex') : null,
    files: normalizedFiles,
    errors,
  };
}

module.exports = {
  DEFAULT_RUNTIME_SOURCE_FILES,
  computeRuntimeFingerprint,
};
