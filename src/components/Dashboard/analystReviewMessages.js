const REVIEW_KINDS = new Set(['portfolio-review', 'balance-review', 'prediction-markets-review', 'daily-review']);
const completed = message => ['complete', 'succeeded'].includes(message.reviewState || message.state);
const failed = message => ['failed', 'interrupted', 'cancelled'].includes(message.reviewState || message.state);

// Automatic revisions replace their own post; explicitly requested posts and
// actual conversation messages remain in the transcript.
export function analystReviewMessages(conversation) {
  const messages = conversation?.messages || [];
  if (!REVIEW_KINDS.has(conversation?.kind)) return messages;
  const postKey = message => message.reviewPostId
    || (message.portfolioBrief || message.id === conversation.referenceReview?.messageId ? 'base' : null);
  const posts = new Map();
  messages.forEach((message, index) => {
    const key = postKey(message, index);
    if (!key || message.role !== 'assistant' || message.reviewNarrative) return;
    const prior = posts.get(key);
    // A failed automatic revision or legacy no-change notice cannot replace
    // its saved report. A requested new post has its own key and stays visible.
    if (prior && (message.reviewUnchanged || (failed(message) && completed(prior.message)))) return;
    // Preserve a dated verified portfolio when its automatic refresh has no
    // holdings. A separately requested unavailable post still remains visible.
    if (message.portfolioBrief?.available === false && prior?.message.portfolioBrief?.available === true) return;
    posts.set(key, { message, index });
  });
  return messages.filter((message, index) => {
    const key = postKey(message, index);
    if (!key || message.role !== 'assistant') return true;
    const post = posts.get(key);
    if (message.reviewNarrative) return !post || (index > post.index
      && (!message.reviewRunId || !post.message.reviewRunId || message.reviewRunId === post.message.reviewRunId));
    return post?.index === index;
  });
}
