const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const {
  createDynamoCatalogTableInput,
  getCatalogStorageConfig,
} = require('../catalogSchema');
const {
  _setDynamoForTests,
  eventCatalogItem,
  loadOperationalCatalogByRelease,
  persistCatalogEvents,
  saveEventsToDynamo,
} = require('../cache');

const cloudFormationSchema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('!Ref', { kind: 'scalar', construct: (value) => value }),
  new yaml.Type('!GetAtt', { kind: 'scalar', construct: (value) => value }),
  new yaml.Type('!Sub', { kind: 'scalar', construct: (value) => value }),
  new yaml.Type('!Sub', { kind: 'sequence', construct: (value) => value }),
  new yaml.Type('!Equals', { kind: 'sequence', construct: (value) => value }),
  new yaml.Type('!If', { kind: 'sequence', construct: (value) => value }),
  new yaml.Type('!Condition', { kind: 'scalar', construct: (value) => value }),
  new yaml.Type('!And', { kind: 'sequence', construct: (value) => value }),
  new yaml.Type('!Not', { kind: 'sequence', construct: (value) => value }),
]);

describe('release-keyed prediction catalog schema', () => {
  afterEach(() => {
    _setDynamoForTests(null);
  });

  test('is byte-for-structure compatible with the existing SAM table resource', () => {
    const template = yaml.load(fs.readFileSync(
      path.resolve(__dirname, '../../../../infra/template.yaml'),
      'utf8',
    ), { schema: cloudFormationSchema });
    const schema = createDynamoCatalogTableInput();

    expect(schema).toEqual(template.Resources.PredictionMarketCatalogV2.Properties);
  });

  test('keeps catalog configuration injectable for IaC and tests', () => {
    expect(getCatalogStorageConfig({
      PREDICTION_MARKET_CATALOG_V2_TABLE: 'CustomCatalog',
    })).toEqual({
      tableName: 'CustomCatalog',
    });
  });

  test('adapts current-release contract metadata into the composite venue-native key shape', () => {
    const item = eventCatalogItem({
      id: 'kalshi:KXCPIYOY-26JUL-T3.4',
      api_raw_id: 'KXCPIYOY-26JUL-T3.4',
      venue: 'Kalshi',
      releaseKey: 'KXCPIYOY#2026-07',
      status: 'open',
      updated_at: '2026-07-21T17:00:00.000Z',
      yes_bid: 0.42,
      yes_ask: 0.44,
      no_bid: 0.56,
      no_ask: 0.58,
      last_price: 0.43,
      yes_mid: 0.43,
      no_mid: 0.57,
      yes_last: 0.43,
      no_last: 0.57,
      bid: 0.42,
      ask: 0.44,
      last: 0.43,
      mark: 0.43,
      price: 0.43,
      spread: 0.02,
      implied_probability: 0.43,
      implied_probability_mid: 0.43,
      model_probability: 0.47,
      volume: 1234,
      open_interest: 456,
      liquidity: 789,
      data_quality_flags: ['live'],
    }, '2026-07-21T17:01:00.000Z');

    expect(item).toMatchObject({
      releaseKey: 'KXCPIYOY#2026-07',
      contractKey: 'Kalshi#KXCPIYOY-26JUL-T3.4',
      updatedAt: '2026-07-21T17:01:00.000Z',
      itemType: 'contract',
      metadata: {
        releaseKey: 'KXCPIYOY#2026-07',
        api_raw_id: 'KXCPIYOY-26JUL-T3.4',
        venue: 'Kalshi',
      },
    });
    const serialized = JSON.stringify(item.metadata).toLowerCase();
    [
      'yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'yes_mid', 'no_mid',
      'yes_last', 'no_last', 'last_price', '"bid"', '"ask"', '"last"',
      '"mark"', '"price"', 'spread', 'implied_probability',
      'implied_probability_mid', 'model_probability', 'volume',
      'open_interest', 'liquidity', 'updated_at', 'data_quality_flags',
    ].forEach((field) => expect(serialized).not.toContain(field));
    expect(item).not.toHaveProperty('payload');
    expect(item).not.toHaveProperty('status');
  });

  test('rejects non-release rows instead of making an unqueryable catalog item', () => {
    expect(() => eventCatalogItem({ venue: 'Kalshi', api_raw_id: 'unknown' }))
      .toThrow(/require releaseKey/i);
  });

  test('atomically replaces a release generation and retires absent native IDs', async () => {
    const query = jest.fn(() => ({
      promise: async () => ({
        Items: [
          {
            releaseKey: 'KXCPIYOY#2026-07',
            contractKey: '__META__',
            updatedAt: '2026-07-21T16:00:00Z',
          },
          { releaseKey: 'KXCPIYOY#2026-07', contractKey: 'IBKR#7000' },
          { releaseKey: 'KXCPIYOY#2026-07', contractKey: 'IBKR#7001' },
        ],
      }),
    }));
    const transactWrite = jest.fn(() => ({ promise: async () => ({}) }));
    _setDynamoForTests({ query, transactWrite });

    const result = await saveEventsToDynamo([{
      conId: 7001,
      api_raw_id: '7001',
      venue: 'IBKR',
      releaseKey: 'KXCPIYOY#2026-07',
      catalog_source: 'ibkr_contract_details',
      exchange: 'FORECASTX',
      tradingClass: 'KXCPIYOY',
      expiration_time: '20260812',
      quote_side: 'YES',
    }], { source: 'authoritative-reconciliation', replaceVenues: true });

    expect(result).toMatchObject({
      atomic: true,
      contracts: 1,
      retired: 1,
      releases: ['KXCPIYOY#2026-07'],
    });
    const transaction = transactWrite.mock.calls[0][0].TransactItems;
    expect(transaction).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            contractKey: 'IBKR#7001',
            metadata: expect.objectContaining({
              catalog_source: 'ibkr_contract_details',
              exchange: 'FORECASTX',
              tradingClass: 'KXCPIYOY',
            }),
          }),
        }),
      }),
      {
        Delete: {
          TableName: 'PredictionMarketCatalogV2',
          Key: { releaseKey: 'KXCPIYOY#2026-07', contractKey: 'IBKR#7000' },
        },
      },
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({
            contractKey: '__META__',
            metadata: expect.objectContaining({ atomicReplacement: true, retiredCount: 1 }),
          }),
          ConditionExpression: '#updatedAt = :previousUpdatedAt',
          ExpressionAttributeValues: { ':previousUpdatedAt': '2026-07-21T16:00:00Z' },
        }),
      }),
    ]));
  });

  test('propagates DynamoDB transaction failures instead of reporting persistence success', async () => {
    const failure = new Error('transaction cancelled');
    _setDynamoForTests({
      query: jest.fn(() => ({ promise: async () => ({ Items: [] }) })),
      transactWrite: jest.fn(() => ({ promise: async () => { throw failure; } })),
    });
    await expect(persistCatalogEvents([{
      api_raw_id: 'KXCPIYOY-26JUL-T3.4',
      venue: 'Kalshi',
      releaseKey: 'KXCPIYOY#2026-07',
    }])).rejects.toThrow('transaction cancelled');
  });

  test('a successful IBKR replacement never deletes healthy Kalshi metadata', async () => {
    const query = jest.fn((input) => ({
      promise: async () => ({
        Items: input.ExpressionAttributeValues[':releaseKey'] === '__CONTROL__'
          ? [{
              releaseKey: '__CONTROL__',
              contractKey: 'CPI#CURRENT',
              updatedAt: '2026-07-21T16:00:00Z',
              metadata: { currentReleaseKey: 'KXCPIYOY#2026-07' },
            }]
          : [
              {
                releaseKey: 'KXCPIYOY#2026-07',
                contractKey: '__META__',
                itemType: 'meta',
                updatedAt: '2026-07-21T16:00:00Z',
                metadata: { schemaVersion: 2, atomicReplacement: true, promotionState: 'active' },
              },
              { releaseKey: 'KXCPIYOY#2026-07', contractKey: 'IBKR#7000', venue: 'IBKR' },
              { releaseKey: 'KXCPIYOY#2026-07', contractKey: 'Kalshi#JUL-T3.4', venue: 'Kalshi' },
            ],
      }),
    }));
    const transactWrite = jest.fn(() => ({ promise: async () => ({}) }));
    _setDynamoForTests({ query, transactWrite });

    const result = await saveEventsToDynamo([{
      conId: 7001,
      api_raw_id: '7001',
      venue: 'IBKR',
      releaseKey: 'KXCPIYOY#2026-07',
      catalog_source: 'ibkr_contract_details',
      exchange: 'FORECASTX',
      tradingClass: 'KXCPIYOY',
      lastTradeDateOrContractMonth: '20260812',
      quote_side: 'YES',
    }], {
      releaseKey: 'KXCPIYOY#2026-07',
      venues: ['IBKR'],
      source: 'authoritative-reconciliation',
      promoteCurrent: true,
      replaceVenues: true,
    });

    const transaction = transactWrite.mock.calls[0][0].TransactItems;
    expect(transaction).toContainEqual({
      Delete: {
        TableName: 'PredictionMarketCatalogV2',
        Key: { releaseKey: 'KXCPIYOY#2026-07', contractKey: 'IBKR#7000' },
      },
    });
    expect(transaction).not.toContainEqual(expect.objectContaining({
      Delete: expect.objectContaining({
        Key: { releaseKey: 'KXCPIYOY#2026-07', contractKey: 'Kalshi#JUL-T3.4' },
      }),
    }));
    expect(transaction).toContainEqual(expect.objectContaining({
      Put: expect.objectContaining({
        Item: expect.objectContaining({
          releaseKey: '__CONTROL__',
          contractKey: 'CPI#CURRENT',
          metadata: expect.objectContaining({ currentReleaseKey: 'KXCPIYOY#2026-07' }),
        }),
      }),
    }));
    expect(result).toMatchObject({
      atomic: true,
      promotedCurrent: true,
      activeContracts: 2,
      retired: 1,
    });
  });

  test('loads only an atomically promoted current release for operational quoting', async () => {
    _setDynamoForTests({
      query: jest.fn((input) => ({
        promise: async () => ({
          Items: input.ExpressionAttributeValues[':releaseKey'] === '__CONTROL__'
            ? [{
                releaseKey: '__CONTROL__',
                contractKey: 'CPI#CURRENT',
                metadata: { currentReleaseKey: 'KXCPIYOY#2026-07' },
              }]
            : [
                {
                  releaseKey: 'KXCPIYOY#2026-07',
                  contractKey: '__META__',
                  itemType: 'meta',
                  metadata: {
                    schemaVersion: 2,
                    atomicReplacement: true,
                    promotionState: 'active',
                  },
                },
                {
                  releaseKey: 'KXCPIYOY#2026-07',
                  contractKey: 'IBKR#7001',
                  venue: 'IBKR',
                  metadata: { releaseKey: 'KXCPIYOY#2026-07', venue: 'IBKR', conId: 7001 },
                },
                {
                  releaseKey: 'KXCPIYOY#2026-07',
                  contractKey: 'Kalshi#JUL-T3.4',
                  venue: 'Kalshi',
                  metadata: { releaseKey: 'KXCPIYOY#2026-07', venue: 'Kalshi', api_raw_id: 'JUL-T3.4' },
                },
              ],
        }),
      })),
    });

    await expect(loadOperationalCatalogByRelease('KXCPIYOY#2026-07', {
      venues: ['IBKR'],
    })).resolves.toEqual([
      { releaseKey: 'KXCPIYOY#2026-07', venue: 'IBKR', conId: 7001 },
    ]);
  });

  test('ordinary partial provider refreshes are upsert-only within the same venue', async () => {
    const transactWrite = jest.fn(() => ({ promise: async () => ({}) }));
    _setDynamoForTests({
      query: jest.fn(() => ({
        promise: async () => ({
          Items: [
            {
              releaseKey: 'KXCPIYOY#2026-07',
              contractKey: '__META__',
              itemType: 'meta',
              updatedAt: '2026-07-21T16:00:00Z',
            },
            { releaseKey: 'KXCPIYOY#2026-07', contractKey: 'Kalshi#A', venue: 'Kalshi' },
            { releaseKey: 'KXCPIYOY#2026-07', contractKey: 'Kalshi#B', venue: 'Kalshi' },
          ],
        }),
      })),
      transactWrite,
    });

    const result = await saveEventsToDynamo([{
      api_raw_id: 'A',
      venue: 'Kalshi',
      releaseKey: 'KXCPIYOY#2026-07',
    }], {
      releaseKey: 'KXCPIYOY#2026-07',
      venues: ['Kalshi'],
      source: 'partial-live-provider-refresh',
    });

    const transaction = transactWrite.mock.calls[0][0].TransactItems;
    expect(transaction.some((item) => Boolean(item.Delete))).toBe(false);
    expect(result).toMatchObject({ atomic: true, retired: 0, activeContracts: 2 });
    expect(transaction).toContainEqual(expect.objectContaining({
      Put: expect.objectContaining({
        Item: expect.objectContaining({
          contractKey: '__META__',
          metadata: expect.objectContaining({ replacementMode: 'upsert_only' }),
        }),
      }),
    }));
  });
});
