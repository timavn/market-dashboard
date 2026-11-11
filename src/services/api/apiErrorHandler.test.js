/**
 * @jest-environment node
 */
// Express's own fallback handler needs setImmediate, which the default
// browser-like test environment does not provide.
const http = require('node:http');
const express = require('express');
const { createApiErrorHandler, errorStatus } = require('./apiErrorHandler.cjs');

function request(server, path, { method = 'GET', body = null } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      // One connection per request, so nothing is left open for the server to wait on.
      agent: false,
      headers: body == null ? {} : { 'Content-Type': 'application/json' },
    }, (res) => {
      let text = '';
      const settle = (interrupted) => resolve({
        status: res.statusCode, type: res.headers['content-type'] || '', text, interrupted,
      });
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => settle(false));
      // A connection cut mid-response never reaches "end".
      res.on('error', () => settle(true));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

describe('API error handler', () => {
  let server;
  let logged;

  beforeEach(async () => {
    logged = [];
    const app = express();
    app.use(express.json());
    app.get('/api/rejects', async () => { throw new Error('record store unavailable'); });
    app.get('/api/throws', () => { throw Object.assign(new Error('bad symbol'), { status: 422, code: 'INVALID_SYMBOL' }); });
    app.get('/api/upstream', async () => { throw Object.assign(new Error('Kalshi HTTP 503: down'), { status: 503 }); });
    app.get('/api/rejects-with-nothing', () => Promise.reject()); // eslint-disable-line prefer-promise-reject-errors
    app.get('/internal/analyst/fails', async () => { throw new Error('sidecar closed the connection'); });
    app.get('/api/partial', (req, res, next) => {
      res.status(200).type('text/plain');
      res.write('first half');
      next(new Error('failed after the response began'));
    });
    app.post('/api/echo', (req, res) => res.json(req.body));
    app.get('/page', () => { throw new Error('page failed'); });
    app.get('/api/fine', (req, res) => res.json({ ok: true }));
    // Most of the API is mounted routers, some nested.
    const nested = express.Router();
    nested.get('/deep', async () => { throw new Error('nested route failed'); });
    const mounted = express.Router();
    mounted.get('/horizon-stats', async () => { throw new Error('mounted route failed'); });
    mounted.use('/inner', nested);
    app.use('/api/analyst', mounted);
    app.use(createApiErrorHandler({ logger: { error: (...args) => logged.push(args) } }));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
  });

  test('a route that rejects answers with JSON and logs the stack instead of returning it', async () => {
    const response = await request(server, '/api/rejects');

    expect(response.status).toBe(500);
    expect(response.type).toMatch(/^application\/json/);
    expect(JSON.parse(response.text)).toEqual({
      error: 'Internal server error',
      details: 'record store unavailable',
      code: 'UNKNOWN_ERROR',
    });
    expect(response.text).not.toMatch(/apiErrorHandler|node_modules|at /);
    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toBe('[API] GET /api/rejects failed:');
    expect(logged[0][1]).toMatch(/record store unavailable[\s\S]*\n\s+at /);
  });

  test('an error that carries a client status keeps it and is not logged as a failure', async () => {
    const response = await request(server, '/api/throws');

    expect(response.status).toBe(422);
    expect(JSON.parse(response.text)).toEqual({ error: 'bad symbol', code: 'INVALID_SYMBOL' });
    expect(logged).toHaveLength(0);
  });

  test('an upstream status in the 500 range is passed on as before', async () => {
    const response = await request(server, '/api/upstream');

    expect(response.status).toBe(503);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'Internal server error', details: 'Kalshi HTTP 503: down' });
    expect(logged).toHaveLength(1);
  });

  test('a malformed JSON body answers 400 as JSON', async () => {
    const response = await request(server, '/api/echo', { method: 'POST', body: '{"symbol": ' });

    expect(response.status).toBe(400);
    expect(response.type).toMatch(/^application\/json/);
    expect(JSON.parse(response.text)).toMatchObject({ code: 'entity.parse.failed' });
  });

  test('the internal routes are covered too', async () => {
    const response = await request(server, '/internal/analyst/fails');

    expect(response.status).toBe(500);
    expect(JSON.parse(response.text).details).toBe('sidecar closed the connection');
  });

  test('routes inside mounted routers are covered, and the query string stays out of the log', async () => {
    const mounted = await request(server, '/api/analyst/horizon-stats?symbols=SPY');
    const nested = await request(server, '/api/analyst/inner/deep');

    expect(mounted.status).toBe(500);
    expect(JSON.parse(mounted.text).details).toBe('mounted route failed');
    expect(nested.status).toBe(500);
    expect(JSON.parse(nested.text).details).toBe('nested route failed');
    expect(logged.map(([label]) => label)).toEqual([
      '[API] GET /api/analyst/horizon-stats failed:',
      '[API] GET /api/analyst/inner/deep failed:',
    ]);
  });

  test('a response that had already started is left to Express', async () => {
    const response = await request(server, '/api/partial');

    // Express cuts the connection; the handler must not write JSON into it.
    expect(response).toMatchObject({ status: 200, text: 'first half', interrupted: true });
    expect(logged).toHaveLength(0);
  });

  test('a rejection that carries no error still answers with JSON', async () => {
    const response = await request(server, '/api/rejects-with-nothing');

    expect(response.status).toBe(500);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'Internal server error', code: 'UNKNOWN_ERROR' });
  });

  test('paths outside the API keep the default page', async () => {
    const response = await request(server, '/page');

    expect(response.status).toBe(500);
    expect(response.type).toMatch(/^text\/html/);
    expect(logged).toHaveLength(0);
  });

  test('a successful route is untouched', async () => {
    const response = await request(server, '/api/fine');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ ok: true });
  });

  test('status comes from the error only when it is an HTTP error status', () => {
    expect(errorStatus({ status: 404 })).toBe(404);
    expect(errorStatus({ statusCode: 413 })).toBe(413);
    expect(errorStatus({ status: 200 })).toBe(500);
    expect(errorStatus({ status: '404' })).toBe(500);
    expect(errorStatus(null)).toBe(500);
    expect(errorStatus(new Error('x'))).toBe(500);
  });
});
