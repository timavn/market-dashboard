const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { CONTRACT_MESSAGE, createAnalystRuntimeGate } = require('./analystRuntimeGate.cjs');
test('only current-generation ordered IPC can enable Analyst and disconnect fails closed', () => {
  const transport = new EventEmitter();
  const gate = createAnalystRuntimeGate({ generation: 'current', transport });
  const publish = (extra = {}) => transport.emit('message', { type: CONTRACT_MESSAGE, generation: 'current', revision: 1, verified: true, hermesPid: 10, sidecarPid: 11, ...extra });
  publish({ generation: 'previous' }); assert.equal(gate.isVerified(), false);
  publish(); assert.equal(gate.isVerified(), true);
  publish({ revision: 2, verified: false }); assert.equal(gate.isVerified(), false);
  publish(); assert.equal(gate.isVerified(), false);
  publish({ revision: 3 }); assert.equal(gate.isVerified(), true);
  transport.emit('disconnect'); assert.equal(gate.isVerified(), false);
  publish({ revision: 4 }); assert.equal(gate.isVerified(), false);
  gate.dispose();
});
test('a successful probe without valid process identities remains unavailable', () => {
  const transport = new EventEmitter();
  const gate = createAnalystRuntimeGate({ generation: 'current', transport });
  for (const [index, pid] of [null, 0, -1, 1.5].entries()) {
    transport.emit('message', { type: CONTRACT_MESSAGE, generation: 'current', revision: index, verified: true, hermesPid: pid, sidecarPid: 11 });
    assert.equal(gate.isVerified(), false);
    assert.equal(gate.status().errorCode, 'ANALYST_CONTRACT_UNVERIFIED');
  }
  gate.dispose();
});
test('an unsupervised API cannot enable Analyst using an environment flag', () => {
  const transport = new EventEmitter();
  const gate = createAnalystRuntimeGate({ generation: '', transport });
  transport.emit('message', { type: CONTRACT_MESSAGE, generation: '', revision: 1, verified: true, hermesPid: 10, sidecarPid: 11 });
  assert.equal(gate.isVerified(), false); gate.dispose();
});
