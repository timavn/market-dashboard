'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const net = require('node:net');
const {
  AWS, DynamoDB, S3, Lambda, clientOptions, CONNECTION_TIMEOUT_MS, DYNAMODB_IDLE_TIMEOUT_MS,
} = require('./clients.cjs');

test('document operations preserve native values, cursor and conditional writes, executing once', async () => {
  let calls = 0;
  const client = { send: async (command) => { calls++; return command.input; } };
  const ddb = new DynamoDB.DocumentClient({ client });
  const input = { TableName: 'T', Item: { id: 'a', value: 12, nested: { flag: true } }, ConditionExpression: 'attribute_not_exists(id)' };
  const operation = ddb.put(input);
  assert.deepEqual(await operation.promise(), input);
  assert.deepEqual(await operation.promise(), input);
  assert.equal(calls, 1);
  const cursor = { id: 'next' };
  assert.deepEqual((await ddb.scan({ TableName: 'T', ExclusiveStartKey: cursor }).promise()).ExclusiveStartKey, cursor);
});
test('v3 errors preserve legacy code and abort signals', async () => {
  const ddb = new DynamoDB.DocumentClient({ client: { send: async (_, options) => {
    assert.equal(options.abortSignal.aborted, true);
    throw Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' });
  } } });
  const operation = ddb.update({}); operation.abort();
  await assert.rejects(operation.promise(), { code: 'ConditionalCheckFailedException' });
});
test('S3 buffers historical object bytes and streams media with a strict buffer budget', async () => {
  const client = { send: async () => ({ Body: Readable.from([Buffer.from('hello')]) }) };
  assert.equal((await new S3({ client }).getObject({}).promise()).Body.toString(), 'hello');
  await assert.rejects(new S3({ client, maxBufferedObjectBytes: 4 }).getObject({}).promise(), { code: 'OBJECT_TOO_LARGE' });
  const chunks = [];
  for await (const chunk of new S3({ client }).getObject({}).createReadStream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'hello');
});
test('client config preserves explicit profile providers and optional session tokens', () => {
  const provider = AWS.SharedIniFileCredentials({ profile: 'test-profile' });
  assert.equal(typeof provider, 'function');
  assert.equal(clientOptions({ credentials: provider }).credentials, provider);
  assert.deepEqual(clientOptions({ accessKeyId: 'test', secretAccessKey: 'test-secret', sessionToken: 'test-token' }).credentials,
    { accessKeyId: 'test', secretAccessKey: 'test-secret', sessionToken: 'test-token' });
  assert.equal(clientOptions({ maxRetries: 2 }).maxAttempts, 3);
});
test('Lambda adapter preserves binary payload without serializing twice', async () => {
  const input = { FunctionName: 'test', Payload: Buffer.from('{}') };
  const client = { send: async (command) => command.input };
  assert.deepEqual(await new Lambda({ client }).invoke(input).promise(), input);
});

test('real v3 DynamoDB middleware marshals once and returns native values and pagination cursors', async () => {
  const requests = [];
  const responses = [
    {},
    { Items: [{ id: { S: 'a' }, value: { N: '12' }, nested: { M: { flag: { BOOL: true } } } }], LastEvaluatedKey: { id: { S: 'next' } } },
  ];
  const requestHandler = { handle: async (wireRequest) => {
    requests.push(JSON.parse(typeof wireRequest.body === 'string' ? wireRequest.body : Buffer.from(wireRequest.body).toString()));
    return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.0' },
      body: Buffer.from(JSON.stringify(responses.shift())) } };
  } };
  const client = new DynamoDB.DocumentClient({ region: 'us-west-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, requestHandler });
  await client.put({ TableName: 'TestTable', Item: { id: 'a', value: 12, nested: { flag: true, omitted: undefined } },
    ConditionExpression: 'attribute_not_exists(id)' }).promise();
  const result = await client.scan({ TableName: 'TestTable', ExclusiveStartKey: { id: 'previous' } }).promise();
  assert.deepEqual(requests[0].Item, { id: { S: 'a' }, value: { N: '12' }, nested: { M: { flag: { BOOL: true } } } });
  assert.equal(requests[0].ConditionExpression, 'attribute_not_exists(id)');
  assert.deepEqual(requests[1].ExclusiveStartKey, { id: { S: 'previous' } });
  assert.deepEqual(result.Items, [{ id: 'a', value: 12, nested: { flag: true } }]);
  assert.deepEqual(result.LastEvaluatedKey, { id: 'next' });
});

test('S3 signing preserves expiration, session credentials and constrained POST conditions without network access', async () => {
  const s3 = new S3({ region: 'us-west-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test-token' } });
  const url = new URL(await s3.getSignedUrlPromise('getObject', { Bucket: 'test-bucket', Key: 'folder/report.pdf', Expires: 75 }));
  assert.equal(url.pathname, '/folder/report.pdf');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '75');
  assert.equal(url.searchParams.get('X-Amz-Security-Token'), 'test-token');
  const signed = await s3.createPresignedPost({ Bucket: 'test-bucket', Key: 'analyst/upload.pdf', Expires: 60,
    Fields: { 'Content-Type': 'application/pdf' }, Conditions: [['content-length-range', 1, 1024]] });
  const policy = JSON.parse(Buffer.from(signed.fields.Policy, 'base64').toString());
  assert.ok(policy.conditions.some(condition => JSON.stringify(condition) === '["content-length-range",1,1024]'));
  assert.equal(signed.fields['Content-Type'], 'application/pdf');
  assert.equal(signed.fields.key, 'analyst/upload.pdf');
});

test('actual CSV and PDF upload policies retain their v2 Fields.key when signed by v3', async () => {
  const { buildPortfolioPresignedPostParams } = require('../../utils/portfolioUploadPolicy.cjs');
  const { buildPdfUploadPostParams } = require('../../routes/analyst.cjs');
  const s3 = new S3({ region: 'us-west-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const policies = [
    buildPortfolioPresignedPostParams({ bucket: 'test-bucket', key: 'portfolio-uploads/report.csv', contentType: 'text/csv' }),
    buildPdfUploadPostParams({ bucket: 'test-bucket', key: 'analyst/staging/report.pdf', uploadId: 'test-upload', cleanFilename: 'report.pdf' }),
  ];
  for (const input of policies) {
    const signed = await new Promise((resolve, reject) => s3.createPresignedPost(input, (error, result) => error ? reject(error) : resolve(result)));
    assert.equal(signed.fields.key, input.Fields.key);
    const policy = JSON.parse(Buffer.from(signed.fields.Policy, 'base64').toString());
    for (const required of input.Conditions) assert.ok(policy.conditions.some(condition => JSON.stringify(condition) === JSON.stringify(required)));
  }
  await assert.rejects(s3.createPresignedPost({ Bucket: 'test-bucket', Key: 'a', Fields: { key: 'b' } }), { code: 'INVALID_POST_KEY' });
});

test('server startup forwards the session token when explicit environment credentials are supplied', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const serverSource = fs.readFileSync(path.join(__dirname, '../../../server.js'), 'utf8');
  const update = serverSource.match(/AWS\.config\.update\((\{[\s\S]*?\})\);/);
  assert.ok(update);
  const { runInNewContext } = require('node:vm');
  const configured = runInNewContext(`(${update[1]})`, { process: { env: { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test-secret', AWS_SESSION_TOKEN: 'test-session' } } });
  assert.deepEqual(clientOptions(configured).credentials, { accessKeyId: 'test', secretAccessKey: 'test-secret', sessionToken: 'test-session' });
});

test('every client limits how long a connection may take, and only DynamoDB limits a silent request', () => {
  assert.deepEqual(clientOptions().requestHandler, { connectionTimeout: CONNECTION_TIMEOUT_MS });
  assert.deepEqual(clientOptions({}, { idleTimeoutMs: DYNAMODB_IDLE_TIMEOUT_MS }).requestHandler,
    { connectionTimeout: CONNECTION_TIMEOUT_MS, socketTimeout: DYNAMODB_IDLE_TIMEOUT_MS });
  assert.equal(CONNECTION_TIMEOUT_MS, 10_000);
  assert.equal(DYNAMODB_IDLE_TIMEOUT_MS, 20_000);
  // SDK v2 names are honoured, and nonsense falls back to the default.
  assert.deepEqual(clientOptions({ httpOptions: { connectTimeout: 2_000, timeout: 5_000 } }).requestHandler,
    { connectionTimeout: 2_000, socketTimeout: 5_000 });
  assert.deepEqual(clientOptions({ httpOptions: { connectTimeout: 0, timeout: -1 } }, { idleTimeoutMs: 7 }).requestHandler,
    { connectionTimeout: CONNECTION_TIMEOUT_MS, socketTimeout: 7 });
  // A caller's own handler is used as given.
  const requestHandler = { handle: async () => ({}) };
  assert.equal(clientOptions({ requestHandler, httpOptions: { timeout: 1 } }).requestHandler, requestHandler);
});

test('a DynamoDB request that is never answered fails instead of waiting for ever', async (t) => {
  // Accepts the connection and then says nothing.
  const sockets = new Set();
  const silent = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => { silent.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    silent.close(resolve);
  }));
  const options = {
    region: 'us-west-1', endpoint: `http://127.0.0.1:${silent.address().port}`,
    accessKeyId: 'test', secretAccessKey: 'test-secret',
  };

  const started = Date.now();
  const limited = new DynamoDB.DocumentClient({ ...options, httpOptions: { timeout: 150 } });
  await assert.rejects(limited.get({ TableName: 'T', Key: { id: 'a' } }).promise(), { code: 'TimeoutError' });
  // Three attempts of 150 ms plus the SDK's back-off, not minutes.
  assert.ok(Date.now() - started < 5_000);

  // A caller that passes its own handler settings without limits gets the
  // SDK's behaviour: no answer and no error. This is what every call did before.
  const unlimited = new DynamoDB.DocumentClient({ ...options, maxRetries: 0, requestHandler: {} });
  const pending = unlimited.get({ TableName: 'T', Key: { id: 'a' } });
  const outcome = await Promise.race([
    pending.promise().then(() => 'answered', () => 'failed'),
    new Promise((resolve) => { setTimeout(() => resolve('still waiting'), 600); }),
  ]);
  assert.equal(outcome, 'still waiting');
  pending.abort();
  await assert.rejects(pending.promise());
});

