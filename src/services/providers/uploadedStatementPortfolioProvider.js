const { readAllDynamoItems } = require('../data/dynamoPagination.cjs');
const { normalizeUploadedHolding } = require('./normalize/normalizePosition');

/**
 * @param {import('aws-sdk').DynamoDB.DocumentClient} dynamodb
 */
function createUploadedStatementPortfolioProvider(dynamodb) {
  async function getLatestSnapshot() {
    const snapshotResult = await readAllDynamoItems(dynamodb, 'scan', { TableName: 'PortfolioSnapshots' });
    const sorted = (snapshotResult.Items || []).sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
    );
    return sorted[0] || null;
  }

  async function getHoldingsForSnapshot(snapshotId) {
    const holdingsResult = await readAllDynamoItems(dynamodb, 'scan', {
        TableName: 'Holdings',
        FilterExpression: 'snapshotId = :snapshotId',
        ExpressionAttributeValues: { ':snapshotId': snapshotId },
      });
    return holdingsResult.Items || [];
  }

  async function getPortfolioSnapshot() {
    const latestSnapshot = await getLatestSnapshot();
    if (!latestSnapshot) {
      return {
        holdings: [],
        summary: null,
        assetAllocation: {},
        lastUpdated: null,
        dataSource: 'uploaded_statement',
        empty: true,
      };
    }

    const holdings = await getHoldingsForSnapshot(latestSnapshot.snapshotId);
    const normalized = holdings.map((h) =>
      normalizeUploadedHolding(h, latestSnapshot.snapshotId),
    );

    return {
      holdings: normalized,
      summary: latestSnapshot.summary || {},
      assetAllocation: latestSnapshot.assetAllocation || {},
      snapshotId: latestSnapshot.snapshotId,
      timestamp: latestSnapshot.timestamp,
      lastUpdated: latestSnapshot.timestamp,
      dataSource: 'uploaded_statement',
      empty: false,
    };
  }

  async function getProviderStatus() {
    const snap = await getLatestSnapshot();
    return {
      name: 'uploaded_statement',
      connected: Boolean(snap),
      lastSnapshotAt: snap?.timestamp || null,
    };
  }

  return {
    getPortfolioSnapshot,
    getProviderStatus,
    getLatestSnapshot,
  };
}

module.exports = { createUploadedStatementPortfolioProvider };
