const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { createApiCorsOptions } = require('./corsConfig.cjs');

function requestPreflight(server) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: '/api/login-status/actions/aws-admin-login',
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-login-action',
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response));
    });
    request.once('error', reject);
    request.end();
  });
}

describe('API CORS login-action preflight', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(cors(createApiCorsOptions({ nodeEnv: 'development' })));
    app.post('/api/login-status/actions/:actionId', (_req, res) => res.sendStatus(202));
    server = app.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  test('allows the browser confirmation header from localhost', async () => {
    const response = await requestPreflight(server);
    const allowedHeaders = String(response.headers['access-control-allow-headers'] || '')
      .toLowerCase()
      .split(',')
      .map((header) => header.trim());

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowedHeaders).toContain('x-login-action');
  });
});
