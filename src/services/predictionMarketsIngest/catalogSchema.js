const SERVICE_MANIFEST = require('../../../ops/services.json');

const DEFAULT_TABLE_NAME = SERVICE_MANIFEST.aws?.resources?.predictionCatalogTable
  || 'PredictionMarketCatalogV2';

function getCatalogStorageConfig(env = process.env) {
  return {
    tableName: env.PREDICTION_MARKET_CATALOG_V2_TABLE
      || env.FINANCIAL_PREDICTION_EVENTS_TABLE
      || DEFAULT_TABLE_NAME,
  };
}

// Pure CreateTable-compatible definition. Deployment is deliberately left to
// the repository's normal IaC workflow; importing this module has no AWS side effects.
function createDynamoCatalogTableInput(options = {}) {
  const config = getCatalogStorageConfig(options.env || {});
  return {
    TableName: options.tableName || config.tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'releaseKey', AttributeType: 'S' },
      { AttributeName: 'contractKey', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'releaseKey', KeyType: 'HASH' },
      { AttributeName: 'contractKey', KeyType: 'RANGE' },
    ],
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    SSESpecification: { SSEEnabled: true },
  };
}

module.exports = {
  DEFAULT_TABLE_NAME,
  createDynamoCatalogTableInput,
  getCatalogStorageConfig,
};
