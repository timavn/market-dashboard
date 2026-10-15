'use strict';

const { parentPort } = require('node:worker_threads');
const { buildSecurityIntelligence } = require('../utils/securityIntelligence.cjs');
const { buildSecurityIntelligenceV2 } = require('../utils/securityIntelligenceV2.cjs');

// These are the existing pure projections. Provider acquisition, freshness and
// source selection remain with the caller; the worker never fetches or caches.
parentPort.on('message', message => {
  if (message?.type !== 'build' || !Number.isSafeInteger(message.id) || message.id < 1) return;
  try {
    const { version, ...params } = message.input;
    if (![1, 2].includes(version)) throw new Error('Invalid projection version');
    const build = version === 1 ? buildSecurityIntelligence : buildSecurityIntelligenceV2;
    parentPort.postMessage({ type: 'result', id: message.id, value: build(params) });
  } catch {
    parentPort.postMessage({ type: 'failure', id: message.id, code: 'SECURITY_INTELLIGENCE_BUILD_FAILED' });
  }
});
parentPort.postMessage({ type: 'ready' });
