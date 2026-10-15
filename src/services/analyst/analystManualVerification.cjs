/** A requested manual chat owns one fresh capture, independent of the browser. */
const { logRunSettlement } = require('./analystRunTimeline.cjs');

const OPERATION = 'portfolio-cross-verification';
const CAPTURE_READY = new Set(['ready', 'partial']);
const ACTIVE_TURNS = new Set(['accepted', 'running']);
// The sidecar owns a 1 s readiness probe plus a 180 s capture and settles it
// itself. This backstop waits beyond that budget instead of firing first.
const CAPTURE_TIMEOUT_MS = 200_000;
// Daily recovery interrupts unowned turns idle for 190 s; manual capture never
// touches the turn. Keep the owner protected while it writes its own outcome.
const SETTLE_GRACE_MS = 15_000;
// Only a deleted/missing owner (404/410) or a lost turn binding (409) is final.
const DEFINITIVE_STATUS = new Set([404, 409, 410]);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function createManualVerificationWorkflow({ call, generate, active, canGenerate, log,
  captureTimeoutMs = CAPTURE_TIMEOUT_MS, pollMs = 500, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  async function start(accepted) {
    const { turn, conversation } = accepted;
    const capture = conversation.manualVerification;
    if (!capture || capture.turnId !== turn.id || active.has(turn.id)) return;
    const binding = { conversationId: conversation.id, turnId: turn.id, captureId: capture.captureId };
    let stopped = false;
    let outcome = 'stopped';
    let handedOff = false;
    const phaseTimes = { acceptedAt: instant(turn.created_at) || new Date().toISOString() };
    const settle = state => logRunSettlement({ runId: capture.captureId, kind: OPERATION, state,
      phaseTimes: { ...phaseTimes, settledAt: new Date().toISOString() } }, log);
    const captureDeadline = Date.now() + captureTimeoutMs;
    const owner = { conversationId: conversation.id, deadlineAt: captureDeadline + SETTLE_GRACE_MS,
      stop: async () => {
        stopped = true;
        await call('frame', { turnId: turn.id, type: 'interrupted', error: 'Response stopped. Retry is available.' });
        if (active.get(turn.id) === owner) active.delete(turn.id);
      } };
    active.set(turn.id, owner);
    try {
      await call('manual-start', binding);
      while (!stopped) {
        if (Date.now() >= captureDeadline) throw new Error('Portfolio verification could not finish. Retry is available.');
        let status;
        try {
          status = await call('manual-status', binding, { timeoutMs: 5_000 });
        } catch (error) {
          // A slow or restarting sidecar keeps capturing; read again until the
          // overall deadline instead of failing a healthy capture.
          if (DEFINITIVE_STATUS.has(error?.statusCode)) throw error;
          await wait(pollMs);
          continue;
        }
        if (stopped) break;
        if (status.conversationId !== binding.conversationId || status.turnId !== binding.turnId
          || status.captureId !== binding.captureId) throw new Error('Portfolio verification ownership changed.');
        if (!ACTIVE_TURNS.has(status.turnState)) { stopped = true; break; }
        if (CAPTURE_READY.has(status.state)) {
          if (!canGenerate()) throw new Error('The Analyst is unavailable. The captured verification is saved; retry is available.');
          let current;
          try { current = (await call('get', { conversationId: conversation.id, includeBriefs: false })).conversation; }
          catch (error) {
            if (DEFINITIVE_STATUS.has(error?.statusCode)) throw error;
            await wait(pollMs);
            continue;
          }
          if (stopped || current.activeTurn?.id !== turn.id || current.manualVerification?.captureId !== capture.captureId) break;
          active.delete(turn.id);
          phaseTimes.captureSettledAt = instant(status.capturedAt) || new Date().toISOString();
          phaseTimes.summarizingAt = new Date().toISOString();
          handedOff = true;
          generate({ ...accepted, conversation: current, manualVerification: binding, onSettled: settle });
          return;
        }
        if (!['queued', 'acquiring', 'running'].includes(status.state)) {
          throw new Error('Portfolio verification is unavailable. Retry is available.');
        }
        await wait(pollMs);
      }
    } catch (error) {
      if (!stopped) outcome = 'failed';
      if (!stopped) await call('frame', { turnId: turn.id, type: 'failed',
        error: error?.message === 'Portfolio verification ownership changed.' ? error.message
          : 'Portfolio verification could not finish. Retry is available.' }).catch(() => {});
    } finally {
      if (active.get(turn.id) === owner) active.delete(turn.id);
      if (!handedOff) settle(outcome);
    }
  }
  return { start };
}

module.exports = { OPERATION, CAPTURE_TIMEOUT_MS, SETTLE_GRACE_MS, createManualVerificationWorkflow };
