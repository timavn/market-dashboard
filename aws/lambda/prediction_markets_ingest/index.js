/**
 * Scheduled Kalshi financial/macro prediction market ingest.
 * IBKR ingest runs locally via Express + Client Portal Gateway only.
 */
const path = require('path');

// Lambda package root is this folder; ingest lib lives in repo src/
const ingestPath = path.join(__dirname, '../../../src/services/predictionMarketsIngest');
const { getAggregatedFinancialPredictionEvents } = require(ingestPath);

exports.handler = async () => {
  process.env.IBKR_INGEST_ENABLED = 'false';

  try {
    const result = await getAggregatedFinancialPredictionEvents({
      refreshKalshi: true,
      refreshIbkr: false,
    });

    console.log(
      JSON.stringify({
        ok: true,
        eventCount: result.events.length,
        fetched_at: result.fetched_at,
        providers: result.providers,
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        eventCount: result.events.length,
        fetched_at: result.fetched_at,
      }),
    };
  } catch (err) {
    console.error('[PredictionMarketsIngest] Lambda error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
