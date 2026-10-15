const { easternDate, marketSession } = require('./analystPolicy.cjs');
const { isTradingDateKey, previousTradingDateKey } = require('../../utils/usEquityMarketCalendar.cjs');

function lastCompletedPortfolioSession(now) {
  const date = easternDate(now);
  return isTradingDateKey(date) && marketSession(now) === 'closed'
    ? date
    : previousTradingDateKey(date);
}

function portfolioResearchDate(now) {
  const date = easternDate(now);
  return isTradingDateKey(date) ? date : previousTradingDateKey(date);
}

async function openPortfolioReference({ call, request, now, includeCurrentSession = false }) {
  const targetDate = lastCompletedPortfolioSession(now);
  const { runs = [] } = await request('/internal/reviews?limit=500&view=portfolio-reference');
  // These are immutable reports verified at acquisition, never current quotes.
  // Use the portfolio observation's Eastern date, not the run's UTC save date.
  const candidates = runs.flatMap(run => {
    const historical = run.dependencies?.portfolioReference;
    // A missing price or P/L field can make the portfolio partial even when
    // the broker verified the complete holdings snapshot at acquisition.
    const portfolio = ['ready', 'partial'].includes(run.dependencies?.portfolio?.status) ? run.dependencies.portfolio : historical;
    const verified = portfolio?.detail?.liveVerified === true || portfolio === historical && historical?.detail?.verifiedAtCapture === true;
    const observed = new Date(portfolio?.asOf);
    const completed = Date.parse(run.completedAt);
    if (run.reviewKind !== 'portfolio-review' || run.state !== 'succeeded'
      || !['ready', 'partial'].includes(run.outcome) || !run.reportMarkdown?.trim()
      || !['ready', 'partial'].includes(portfolio?.status) || !verified
      || !portfolio.asOf
      || !Number.isFinite(observed.getTime()) || !Number.isFinite(completed)
      || observed.getTime() > completed || completed > now.getTime()) return [];
    const tradingDate = easternDate(observed);
    // A manual weekend/holiday review is a dated observation too. Its actual
    // capture date must not be relabeled as the previous session's close.
    if (tradingDate > targetDate && !(includeCurrentSession && tradingDate <= easternDate(now))) return [];
    return [{ run, observed, tradingDate }];
  }).sort((a, b) => b.observed - a.observed || Date.parse(b.run.completedAt) - Date.parse(a.run.completedAt));

  if (!candidates.length) return null;
  // History can contain hundreds of revisions from deleted conversations.
  // Read their tombstones once instead of one sidecar request per saved run.
  const conversationIds = [...new Set(candidates.map(({ run }) => run.conversationId))];
  const { deletedConversationIds } = await call('deleted', { conversationIds });
  if (!Array.isArray(deletedConversationIds)) throw new Error('Saved review history is unavailable.');
  const deleted = new Set(deletedConversationIds);
  for (const { run, observed, tradingDate } of candidates) {
    if (deleted.has(run.conversationId)) continue;
    let conversation;
    try { ({ conversation } = await call('get', { conversationId: run.conversationId, includeBriefs: false })); }
    // Deleted (410) or absent (404) concurrently with the tombstone read.
    catch (error) { if (error.statusCode === 404 || error.statusCode === 410) continue; throw error; }
    let message = conversation.messages.find(m => m.role === 'assistant' && m.state === 'complete' && m.text.trim() === run.reportMarkdown.trim());
    if (!message) {
      const result = await request(`/internal/reviews/${encodeURIComponent(run.runId)}`);
      const captured = result.run || result;
      await call('append', { conversationId: conversation.id, sourceId: `daily-report:${run.runId}`, text: run.reportMarkdown, citations: captured.citations || [], createdAt: run.completedAt });
      ({ conversation } = await call('get', { conversationId: conversation.id, includeBriefs: false }));
      message = conversation.messages.find(m => m.source_id === `daily-report:${run.runId}`);
    }
    await call('setting', { key: `portfolio-reference:${conversation.id}`, value: {
      runId: run.runId, messageId: message.id, targetDate, tradingDate,
      asOf: observed.toISOString(), afterClose: isTradingDateKey(tradingDate) && marketSession(observed) === 'closed',
    } });
    if (conversation.archived) await call('archive', { conversationId: conversation.id, archived: false });
    return { ...(await call('get', { conversationId: conversation.id, includeBriefs: false })).conversation, briefsIncluded: false };
  }

  return null;
}

module.exports = { lastCompletedPortfolioSession, portfolioResearchDate, openPortfolioReference };
