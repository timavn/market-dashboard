import { useEffect, useRef } from 'react';
import { analystWorkspaceApi as api } from '../services/analyst/analystClient';

export default function useAnalystCapturedHistory({ active, conversationId, messages, transcript, hold, onCapturedBody, onCapturedUnavailable }) {
  const queue = useRef([]);
  const reads = useRef(new Set());
  const failed = useRef(new Set());
  const running = useRef(false);
  const mounted = useRef(true);
  const current = useRef({ active, conversationId, onCapturedBody, onCapturedUnavailable, hold });
  current.current = { active, conversationId, onCapturedBody, onCapturedUnavailable, hold };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; queue.current = []; };
  }, []);
  // A failed viewport read does not spin on every streamed frame. Returning to
  // the chat/window explicitly gives its exact saved capture another attempt.
  useEffect(() => { failed.current.clear(); }, [active, conversationId]);
  useEffect(() => {
    if (!active || !conversationId || hold() || !transcript.current || typeof IntersectionObserver === 'undefined') return undefined;
    const omitted = new Map(messages.filter(message => message.reviewBodyIncluded === false && !message.portfolioBrief)
      .map(message => [message.id, message]));
    if (!omitted.size) return undefined;
    let stopped = false;
    const drain = async () => {
      if (running.current) return;
      running.current = true;
      try {
        while (queue.current.length && mounted.current) {
          if (current.current.hold()) break;
          const item = queue.current.shift();
          if (!current.current.active || current.current.conversationId !== item.conversationId) { reads.current.delete(item.key); continue; }
          try {
            const path = `/conversations/${encodeURIComponent(item.conversationId)}?includeBriefs=false&briefMessageId=${encodeURIComponent(item.message.id)}`;
            const { conversation } = await api.request(path);
            const body = conversation?.messages?.find(message => message.id === item.message.id);
            if (conversation?.id !== item.conversationId || body?.reviewRunId !== item.message.reviewRunId
              || body.reviewBodyIncluded !== true || !body.portfolioBrief) throw new Error('Captured review unavailable.');
            if (mounted.current) current.current.onCapturedBody(item.conversationId, item.message, body);
          } catch {
            failed.current.add(item.key);
            if (mounted.current && current.current.conversationId === item.conversationId) {
              current.current.onCapturedUnavailable?.(item.conversationId, item.message);
            }
          }
          finally { reads.current.delete(item.key); }
        }
      } finally { running.current = false; }
    };
    const observer = new IntersectionObserver(entries => {
      if (stopped || hold()) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const message = omitted.get(entry.target.getAttribute('data-message-id'));
        if (!message?.reviewRunId) continue;
        const key = `${conversationId}:${message.id}:${message.reviewRunId}`;
        if (reads.current.has(key) || failed.current.has(key)) continue;
        reads.current.add(key);
        queue.current.push({ key, conversationId, message });
      }
      void drain();
    }, { root: transcript.current });
    for (const node of transcript.current.querySelectorAll('.analyst-captured-report-placeholder')) observer.observe(node);
    return () => { stopped = true; observer.disconnect(); };
  }, [active, conversationId, messages, transcript, hold]);
}
