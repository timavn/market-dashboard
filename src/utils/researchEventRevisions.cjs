'use strict';

// ResearchEventLedgerV2 events are never rewritten. A corrected re-parse of an
// email appends a complete new set marked parseRevision/revisedAt; for each
// source email only the newest such set is current. Mirrors
// current_research_events in the Gmail ingestor.
function currentResearchEvents(items) {
  const list = Array.isArray(items) ? items : [];
  const sourceKey = (item) => `${item?.productKey || ''}\u0000${item?.sourceMessageId || ''}`;
  const latest = new Map();
  for (const item of list) {
    const revision = String(item?.parseRevision || '');
    if (!revision) continue;
    const key = sourceKey(item);
    const revisedAt = String(item?.revisedAt || '');
    const best = latest.get(key);
    if (!best || revisedAt > best.revisedAt || (revisedAt === best.revisedAt && revision > best.revision)) {
      latest.set(key, { revisedAt, revision });
    }
  }
  if (!latest.size) return list;
  return list.filter((item) => {
    const best = latest.get(sourceKey(item));
    return !best || String(item?.parseRevision || '') === best.revision;
  });
}

module.exports = { currentResearchEvents };
