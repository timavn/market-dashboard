const { easternDate } = require('./analystPolicy.cjs');
const { isTradingDateKey } = require('../../utils/usEquityMarketCalendar.cjs');
const { MARKETS } = require('./analystPredictions.cjs');

const REVIEW_KIND = 'prediction-markets-review';

/** Hermes schedules this adapter; the existing daily workflow owns the report and narrative. */
function createMorningPredictionReview({ workspace, prepare, request, now = () => new Date() }) {
  let starting;
  const key = date => `hermes-prediction-morning:${date}`;
  const base = date => ({ date, reviewKind: REVIEW_KIND });

  async function status() {
    const date = easternDate(now());
    if (!isTradingDateKey(date)) return { ...base(date), status: 'skipped', reason: 'non_trading_day' };
    const saved = (await workspace.call('setting', { key: key(date) })).value;
    if (!saved?.runId) return { ...base(date), status: 'pending', reason: 'not_started' };
    const response = await request(`/internal/reviews/${encodeURIComponent(saved.runId)}`);
    const run = response.run || response;
    const result = { ...base(date), conversationId: saved.conversationId, runId: saved.runId };
    if (run.runId !== saved.runId || run.reviewKind !== REVIEW_KIND) throw new Error('Morning review identity could not be verified.');
    if (['failed', 'cancelled'].includes(run.state)) return { ...result, status: 'failed', reason: 'review_failed' };
    if (run.state !== 'succeeded') return { ...result, status: 'running' };
    if (run.outcome === 'blocked') return { ...result, status: 'blocked', reason: 'current_evidence_unavailable' };
    if (!['ready', 'partial'].includes(run.outcome)) throw new Error('Morning review outcome could not be verified.');
    const marketIds = Array.isArray(run.marketIds) ? run.marketIds : [];
    if (marketIds.length !== MARKETS.length || new Set(marketIds).size !== marketIds.length
      || MARKETS.some(([marketId]) => !marketIds.includes(marketId))) throw new Error('Morning market coverage is incomplete.');
    if (easternDate(new Date(run.completedAt)) !== date) throw new Error('Morning review publication date is not current.');
    const { conversation } = await workspace.call('get', { conversationId: saved.conversationId });
    // Completion means the exact deterministic report reached the Analyst conversation.
    const published = conversation?.messages?.some(message => message.role === 'assistant'
      && message.state === 'complete' && typeof message.text === 'string' && message.text.trim()
      && (message.turn_id === saved.turnId || message.source_id === `daily-report:${saved.runId}`));
    if (!published) return { ...result, status: 'running' };
    return { ...result, status: 'ready', outcome: run.outcome, completedAt: run.completedAt, marketIds };
  }

  async function startOne() {
    await workspace.initialize();
    const current = await status();
    if (['skipped', 'running', 'ready'].includes(current.status)) return current;
    const conversation = await prepare(REVIEW_KIND, true);
    if (!conversation?.id) throw new Error('Morning review could not open its Analyst conversation.');
    const record = (await workspace.call('setting', { key: `daily-run:${conversation.id}` })).value;
    if (!record?.runId || record.kind !== REVIEW_KIND) throw new Error('Morning review has not started; another response may be active.');
    const age = now().getTime() - Date.parse(record.startedAt || '');
    if (!Number.isFinite(age) || age < -5_000 || age > 60_000) throw new Error('Morning review has not acquired a current run.');
    await workspace.call('setting', { key: key(current.date), value: {
      conversationId: conversation.id, runId: record.runId, turnId: record.turnId,
    } });
    return status();
  }

  function start() {
    if (!starting) starting = startOne().finally(() => { starting = null; });
    return starting;
  }
  return { start, status };
}

module.exports = { createMorningPredictionReview };
