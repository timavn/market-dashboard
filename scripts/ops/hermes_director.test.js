const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeDirectorCommand,
  HERMES_AGENT_RUNS_TABLE,
  HERMES_ALERTS_TABLE,
} = require('../../src/utils/hermesManagingDirector.cjs');

function promiseResult(fn) {
  return { promise: async () => fn() };
}

function fakeDynamo() {
  const rows = { runs: [], alerts: [] };
  return {
    rows,
    put(params) {
      return promiseResult(() => {
        if (params.TableName === HERMES_AGENT_RUNS_TABLE) rows.runs.push(params.Item);
        else if (params.TableName === HERMES_ALERTS_TABLE) rows.alerts.push(params.Item);
        return {};
      });
    },
    query(params) {
      return promiseResult(() => ({
        Items: rows.runs
          .filter(row => row.worker === params.ExpressionAttributeValues[':worker'])
          .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))),
      }));
    },
    scan() {
      return promiseResult(() => ({ Items: rows.alerts }));
    },
  };
}

test('failed Lambda dispatch remains a real failed run with no synthetic success', async () => {
  const dynamodb = fakeDynamo();
  const lambdaClient = {
    invoke() {
      return promiseResult(() => { throw new Error('AccessDeniedException'); });
    },
  };

  const result = await executeDirectorCommand({
    dynamodb,
    lambdaClient,
    command: 'run analyst now',
    workflowSnapshot: {},
  });

  assert.equal(result.runRecord.status, 'failed');
  assert.equal(result.runRecord.source, 'dashboard-dispatch');
  assert.equal(result.runRecord.metadata.dispatchFailure, true);
  assert.match(result.runRecord.summary, /dispatch failed/i);
  assert.doesNotMatch(result.runRecord.summary, /fallback/i);
});

test('consolidated worker dispatch always includes the requested jobType', async () => {
  const dynamodb = fakeDynamo();
  let payload;
  const lambdaClient = {
    invoke(params) {
      payload = JSON.parse(params.Payload);
      return promiseResult(() => ({}));
    },
  };

  const result = await executeDirectorCommand({
    dynamodb,
    lambdaClient,
    command: 'run security now',
    workflowSnapshot: {},
  });

  assert.equal(payload.jobType, 'security');
  assert.equal(result.runRecord.status, 'running');
  assert.equal(result.runRecord.summary.includes('market-dashboard-hermes-worker-v2'), true);
});
