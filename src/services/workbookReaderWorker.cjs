'use strict';

const { parentPort } = require('node:worker_threads');
const readNodeWorkbook = require('read-excel-file/node');
const readUniversalWorkbook = require('read-excel-file/universal');

// Fetching, source verification and provenance stay with the caller. This worker
// only applies the existing parser to an owned copy of the acquired bytes.
parentPort.on('message', async message => {
  if (message?.type !== 'read') return;
  parentPort.postMessage({ type: 'started', id: message.id });
  try {
    const reader = message.parser === 'universal' ? readUniversalWorkbook : readNodeWorkbook;
    const input = message.parser === 'universal' ? message.buffer : Buffer.from(message.buffer);
    const value = await reader(input, message.options);
    parentPort.postMessage({ type: 'result', id: message.id, value });
  } catch (error) {
    parentPort.postMessage({ type: 'failure', id: message.id, error: {
      name: String(error?.name || 'Error'), message: String(error?.message || 'Workbook parsing failed.'),
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    } });
  }
});

parentPort.postMessage({ type: 'ready' });
