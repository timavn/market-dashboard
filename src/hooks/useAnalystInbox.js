import { useCallback, useRef, useState } from 'react';
import { analystWorkspaceApi as api } from '../services/analyst/analystClient';
import { reuseAnalystEvidence } from '../services/analyst/analystEvidenceIdentity';
import { isActionRequired } from '../utils/analystInboxAlerts.cjs';

const emptyInbox = { findings: [], unread: 0, actionRequired: 0 };
const isRead = finding => finding.unread === 0 || finding.unread === false;
const fingerprintOf = finding => finding?.payload?.fingerprint || finding?.fingerprint || null;
const materialRevisionOf = finding => finding?.payload?.materialRevision ?? finding?.materialRevision ?? null;
const revisionKey = (id, fingerprint, materialRevision) => JSON.stringify([id, fingerprint || null, materialRevision ?? null]);

export default function useAnalystInbox() {
  const [inbox, setInbox] = useState(emptyInbox);
  const [inboxError, setInboxError] = useState('');
  const snapshot = useRef(emptyInbox);
  const pending = useRef(new Map());
  const loading = useRef(null);
  const requested = useRef(0);
  const applied = useRef(0);
  const published = useRef(emptyInbox);

  const publish = useCallback(() => {
    // Keep research evidence for saved reviews; only remove it from the unread queue.
    const findings = snapshot.current.findings.map(finding => pending.current.has(revisionKey(finding.id, fingerprintOf(finding), materialRevisionOf(finding)))
      ? { ...finding, unread: 0 } : finding);
    const next = reuseAnalystEvidence(published.current, { ...snapshot.current, findings,
      unread: findings.filter(finding => Boolean(finding.unread)).length,
      actionRequired: findings.filter(finding => Boolean(finding.unread) && isActionRequired(finding)).length });
    if (next === published.current) return;
    published.current = next;
    setInbox(next);
    window.dispatchEvent(new CustomEvent('analyst-inbox', { detail: next }));
  }, []);

  const loadInbox = useCallback(({ invalidate = false } = {}) => {
    if (loading.current) {
      // Polls share the pending read. An event or revision mismatch still
      // needs one subsequent read, because this request may predate the write.
      if (invalidate) loading.current.again = true;
      return loading.current.promise;
    }
    const entry = { again: false };
    loading.current = entry;
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          const request = ++requested.current;
          try {
            const result = await api.request('/inbox');
            if (request >= applied.current) {
              applied.current = request;
              snapshot.current = result;
              for (const finding of result.findings) {
                const acknowledgment = pending.current.get(revisionKey(finding.id, fingerprintOf(finding), materialRevisionOf(finding)));
                if (isRead(finding) && acknowledgment) acknowledgment.confirmed = true;
              }
              publish();
            }
          } catch (error) {
            if (!entry.again) throw error;
          }
        } while (entry.again);
      } finally { if (loading.current === entry) loading.current = null; }
    })();
    return entry.promise;
  }, [publish]);

  // Dismissing clears any alert, action-required included, for the rest of the Pacific day unless its message changes.
  const acknowledge = useCallback(async (id, displayedFingerprint, displayedMaterialRevision, keptReason) => {
    const current = snapshot.current.findings.find(finding => finding.id === id);
    const fingerprint = displayedFingerprint || fingerprintOf(current);
    const materialRevision = displayedMaterialRevision ?? materialRevisionOf(current);
    const key = revisionKey(id, fingerprint, materialRevision);
    if (pending.current.has(key)) return;
    const acknowledgment = { confirmed: false };
    pending.current.set(key, acknowledgment);
    setInboxError('');
    publish();
    try {
      const result = await api.request(`/inbox/${encodeURIComponent(id)}/read`, { acknowledge: true,
        ...(fingerprint ? { fingerprint } : {}), ...(materialRevision !== null ? { materialRevision } : {}),
        ...(keptReason ? { keptReason } : {}) });
      if (result?.acknowledged === false) {
        await loadInbox({ invalidate: true });
        return;
      }
      // A GET started before this save may still contain the old unread state.
      applied.current = ++requested.current;
      snapshot.current = { ...snapshot.current, findings: snapshot.current.findings.map(finding => finding.id === id
        && fingerprintOf(finding) === fingerprint && materialRevisionOf(finding) === materialRevision
        ? { ...finding, unread: 0 } : finding) };
    } catch {
      // A poll can confirm the save even when its HTTP response is lost.
      if (!acknowledgment.confirmed) setInboxError('Couldn’t mark this alert as read. Try again.');
    } finally {
      pending.current.delete(key);
      publish();
    }
  }, [loadInbox, publish]);

  return { inbox, inboxError, loadInbox, acknowledge };
}
