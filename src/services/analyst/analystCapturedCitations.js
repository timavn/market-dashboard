const identity = source => [source.captureConversationId, source.captureMessageId, source.id]
  .every(value => typeof value === 'string' && value.length > 0 && value.length <= 256);

// Evidence is read from the exact saved post, never from current research.
// Bound concurrent reads so a section with many publications leaves room for
// chat controls and source-status requests in the browser connection pool.
export async function hydrateAnalystCapturedCitations(sources, { request, isCurrent, onResolved }) {
  sources.filter(source => source.evidenceIncluded === false && !identity(source)).forEach(source => {
    if (isCurrent()) onResolved({ ...source, evidenceLoading: false, evidenceError: true });
  });
  const pending = sources.filter(source => source.evidenceIncluded === false && identity(source));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, async () => {
    while (isCurrent() && next < pending.length) {
      const source = pending[next++];
      const parts = [source.captureConversationId, source.captureMessageId, source.id].map(encodeURIComponent);
      let resolved;
      try {
        const payload = await request(`/conversations/${parts[0]}/citations/${parts[1]}/${parts[2]}`);
        if (!payload.citation || payload.citation.id !== source.id) throw new Error('Captured source unavailable.');
        resolved = { ...source, ...payload.citation, highlightTexts: source.highlightTexts,
          evidenceIncluded: true, evidenceLoading: false };
      } catch {
        resolved = { ...source, evidenceLoading: false, evidenceError: true };
      }
      if (isCurrent()) onResolved(resolved);
    }
  }));
}
