const crypto = require('crypto');
const {
  computeResearchEventVerificationHash,
} = require('../../../utils/researchEventLedger.cjs');
const {
  loadLatestSpxRtaRiskRange,
} = require('../rtaRiskRangeProvider');

function canonicalEvent({ eventTime, sourceMessageId, low, high }) {
  const item = {
    productKey: 'real-time-alert',
    eventKey: `${eventTime}#${sourceMessageId}#0000`,
    eventTime,
    sourceMessageId,
    sequence: 0,
    sourceEventCount: 1,
    eventType: 'POSITION_ACTION',
    payload: {
      headline: 'Real-Time Alert: Sell-SOME Signal (refreshed SPX Risk Range): APLE - KM',
      signalPhrase: 'Sell-SOME',
      ticker: 'APLE',
      action: 'SELL-SOME',
      refreshedRiskRange: { ticker: 'SPX', lrr: low, hrr: high },
    },
    eventHash: 'a'.repeat(64),
    parserVersion: 'research-event-ledger-v2',
    sourceArtifact: `${sourceMessageId}.html`,
    verificationHashVersion: 'research-event-content-v1',
  };
  return {
    ...item,
    verificationHash: computeResearchEventVerificationHash(item),
  };
}

describe('SPX Real-Time Alert refreshed Risk Range provider', () => {
  test('selects the newest verified canonical refreshed range for the current New York day', async () => {
    const result = await loadLatestSpxRtaRiskRange({
      now: Date.parse('2026-08-03T17:00:00.000Z'),
      getResearchEventItems: async () => [
        canonicalEvent({
          eventTime: '2026-08-03T14:23:00.000Z',
          sourceMessageId: 'earlier',
          low: 7344,
          high: 7585,
        }),
        canonicalEvent({
          eventTime: '2026-08-03T16:45:00.000Z',
          sourceMessageId: 'later',
          low: 7350,
          high: 7590,
        }),
      ],
      getHermesLedgerItems: async () => [],
    });

    expect(result).toMatchObject({
      status: 'available',
      low: 7350,
      high: 7590,
      source: 'Hedgeye Real-Time Alert',
      sourceMessageId: 'later',
      asOf: '2026-08-03T16:45:00.000Z',
    });
  });

  test('parses an already-stored RTA artifact when the canonical event predates the range field', async () => {
    const result = await loadLatestSpxRtaRiskRange({
      now: Date.parse('2026-08-03T17:00:00.000Z'),
      getResearchEventItems: async () => [],
      getHermesLedgerItems: async () => [{
        status: 'STORED',
        reportType: 'real-time-alert',
        messageId: 'legacy-rta',
        receivedAt: '2026-08-03T14:23:00.000Z',
        s3Key: 'rta/legacy.html',
        subject: 'Real-Time Alert: Sell-SOME Signal (refreshed SPX Risk Range): APLE - KM',
      }],
      getArtifactText: async () => 'SPX Refreshed Risk Range = 7,344-7,585',
    });

    expect(result).toMatchObject({
      status: 'available',
      low: 7344,
      high: 7585,
      sourceKind: 'hermes-email-ledger-s3',
      sourceMessageId: 'legacy-rta',
    });
  });

  test('recovers an immutable artifact whose broad Risk Range classifier failed', async () => {
    const body = '<p>SPX Refreshed Risk Range = 7344-7585</p>';
    const contentSha256 = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    const result = await loadLatestSpxRtaRiskRange({
      now: Date.parse('2026-08-03T17:00:00.000Z'),
      getResearchEventItems: async () => [],
      getHermesLedgerItems: async () => [{
        status: 'ERROR',
        reportType: 'risk-ranges',
        messageId: 'misclassified-rta',
        receivedAt: '2026-08-03T14:24:40.000Z',
        s3Key: 'risk-ranges/misclassified.html',
        contentSha256,
        subject: 'Real-Time Alert: Sell-SOME Signal (refreshed SPX Risk Range): APLE - KM',
      }],
      getArtifactText: async () => body,
    });

    expect(result).toMatchObject({
      status: 'available',
      low: 7344,
      high: 7585,
      sourceKind: 'hermes-email-ledger-s3',
    });
  });

  test('does not use a prior-day RTA as the current refreshed range', async () => {
    const result = await loadLatestSpxRtaRiskRange({
      now: Date.parse('2026-08-03T17:00:00.000Z'),
      getResearchEventItems: async () => [canonicalEvent({
        eventTime: '2026-08-02T16:23:00.000Z',
        sourceMessageId: 'yesterday',
        low: 7344,
        high: 7585,
      })],
      getHermesLedgerItems: async () => [],
    });

    expect(result.status).toBe('unavailable');
  });
});
