'use strict';
const { EventEmitter } = require('node:events');
const CONTRACT_MESSAGE = 'market-dashboard:analyst-contract';
const CONTRACT_READY_MESSAGE = 'market-dashboard:analyst-gate-ready';

function createAnalystRuntimeGate({ generation = process.env.MARKET_DASHBOARD_SUPERVISOR_GENERATION, transport = process } = {}) {
  const events = new EventEmitter();
  let disconnected = false;
  let state = { verified: false, generation: generation || null, revision: -1, checkedAt: null, errorCode: 'ANALYST_CONTRACT_PENDING' };
  function close(errorCode = 'ANALYST_SUPERVISOR_DISCONNECTED') {
    disconnected = true;
    state = { ...state, verified: false, errorCode };
    events.emit('change', { ...state });
  }
  function receive(message) {
    if (disconnected || !generation || message?.type !== CONTRACT_MESSAGE || message.generation !== generation
        || !Number.isSafeInteger(message.revision) || message.revision <= state.revision) return;
    const verified = message.verified === true
      && Number.isSafeInteger(message.hermesPid) && message.hermesPid > 0
      && Number.isSafeInteger(message.sidecarPid) && message.sidecarPid > 0;
    state = {
      verified,
      generation, revision: message.revision,
      checkedAt: typeof message.checkedAt === 'string' ? message.checkedAt : null,
      errorCode: verified ? null : 'ANALYST_CONTRACT_UNVERIFIED',
    };
    events.emit('change', { ...state });
  }
  transport.on?.('message', receive);
  transport.on?.('disconnect', close);
  if (transport.connected && generation) transport.send?.({ type: CONTRACT_READY_MESSAGE, generation }, () => {});
  return {
    status: () => ({ ...state }),
    isVerified: () => state.verified,
    subscribe(listener) { events.on('change', listener); return () => events.off('change', listener); },
    close,
    dispose() { transport.off?.('message', receive); transport.off?.('disconnect', close); close(); events.removeAllListeners(); },
  };
}

let defaultGate;
function getAnalystRuntimeGate() { if (!defaultGate) defaultGate = createAnalystRuntimeGate(); return defaultGate; }
module.exports = { CONTRACT_MESSAGE, CONTRACT_READY_MESSAGE, createAnalystRuntimeGate, getAnalystRuntimeGate };
