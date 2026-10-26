import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { analystWorkspaceApi as api } from '../../services/analyst/analystClient';
import AnalystSpinner from './AnalystSpinner';
import './AnalystAlertThread.css';

// Must match INBOX_THREAD_PREFIX in analystWorkspace.cjs.
const INBOX_THREAD_PREFIX = 'About this Inbox alert:';
const POLL_MS = 2_500;
const MAX_READ_FAILURES = 3;

// The opening message carries the alert for the Analyst; the card above
// already shows it, so the thread shows only what was typed.
const visibleText = message => {
  const text = String(message?.text || '');
  if (message?.role !== 'user' || !text.startsWith(INBOX_THREAD_PREFIX)) return text;
  const split = text.indexOf('\n\n');
  return split < 0 ? text : text.slice(split + 2);
};

// MessageComponent is the workspace's Message renderer, passed in so the Inbox
// does not load the markdown stack on its own.
export default function AnalystAlertThread({ findingId, alert, conversationId, onStarted, onCitation, MessageComponent }) {
  const [conversation, setConversation] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const pending = useRef(null);

  const load = useCallback(async () => {
    if (!conversationId) return null;
    const result = await api.request(`/conversations/${encodeURIComponent(conversationId)}`);
    setConversation(result.conversation);
    return result.conversation;
  }, [conversationId]);

  useEffect(() => {
    let timer = null;
    let current = true;
    let failures = 0;
    // A read can be slow while the Analyst is writing; keep polling and only
    // report a problem once several reads in a row have failed.
    const tick = async () => {
      try {
        const latest = await load();
        failures = 0;
        if (!current) return;
        setReadError('');
        if (latest?.activeTurn) timer = setTimeout(tick, POLL_MS);
      } catch {
        if (!current) return;
        failures += 1;
        if (failures >= MAX_READ_FAILURES) setReadError('Couldn’t reach the Analyst. Retrying…');
        timer = setTimeout(tick, POLL_MS * Math.min(failures + 1, 4));
      }
    };
    void tick();
    return () => { current = false; clearTimeout(timer); };
  }, [load, sending]);

  const send = async (retryText) => {
    const text = (retryText ?? draft).trim();
    if (!text || sending) return;
    // A retried send reuses its request ID so the server accepts it once.
    if (pending.current?.text !== text) pending.current = { text, requestId: crypto.randomUUID() };
    setSending(true); setError('');
    try {
      const result = await api.request(`/inbox-threads/${encodeURIComponent(findingId)}`,
        { text, alert, requestId: pending.current.requestId });
      pending.current = null;
      if (retryText === undefined) setDraft('');
      if (result.conversation) setConversation(result.conversation);
      if (result.conversation?.id && result.conversation.id !== conversationId) onStarted(findingId, result.conversation.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  const messages = (conversation?.messages || []).filter(message => !message.internal
    && (message.role === 'user' || message.text?.trim()));
  const responding = sending || Boolean(conversation?.activeTurn);
  // A turn that ended without an answer (e.g. holdings could not be verified) says why, as in the main chat.
  const failed = !responding && ['failed', 'interrupted'].includes(conversation?.lastTurn?.state) ? conversation.lastTurn : null;
  const lastQuestion = [...messages].reverse().find(message => message.role === 'user');

  return <div className="analyst-alert-thread">
    {messages.length > 0 && <div className="analyst-alert-thread-messages">
      {messages.map(message => message.role === 'user'
        ? <p key={message.id} className="analyst-alert-thread-question">{visibleText(message)}</p>
        : MessageComponent ? <MessageComponent key={message.id} message={message} onCitation={onCitation} />
          : <p key={message.id} className="analyst-alert-thread-answer">{message.text}</p>)}
    </div>}
    {responding && <p className="analyst-alert-thread-status">
      <AnalystSpinner size={16} label="The Analyst is responding" elapsed since={conversation?.activeTurn?.created_at} /></p>}
    {failed && <p className="analyst-alert-thread-error" role="alert">
      <span>{failed.error || 'The response was interrupted.'}</span>
      {lastQuestion && <button type="button" onClick={() => void send(visibleText(lastQuestion))}>Retry</button>}</p>}
    {(error || readError) && <p className="analyst-alert-thread-error" role="alert">{error || readError}</p>}
    <form className="analyst-alert-thread-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label="Discuss this alert with the Analyst" rows={1} value={draft}
        placeholder={messages.length ? 'Reply to the Analyst…' : 'Ask the Analyst about this alert…'}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <button type="submit" aria-label="Send" disabled={!draft.trim() || responding}><Send size={11} /></button>
    </form>
  </div>;
}
