#!/usr/bin/env node

/**
 * Minimal Analyst HTTP/WebSocket host for browser smoke tests.
 *
 * It connects the production gateway proxy and Express review routes to an
 * isolated Hermes profile and the test-only sidecar in browser_smoke_app.py.
 * That sidecar executes the real ReviewRunV2 coordinator, persistence,
 * fingerprinting, rendering, retry, and hydration paths for all three reviews.
 * This host never fabricates review responses or points validation at a real
 * dashboard conversation store.
 */

const http = require('node:http');
const axios = require('axios');
const express = require('express');
const { createAnalystRoutes } = require('../../src/routes/analyst.cjs');
const { attachAnalystGatewayProxy } = require('../../src/services/analyst/analystGatewayProxy.cjs');

const host = '127.0.0.1';
const port = Number(process.env.ANALYST_SMOKE_API_PORT || 3101);
const uiOrigin = process.env.ANALYST_SMOKE_UI_ORIGIN || 'http://127.0.0.1:3100';
const hermesUrl = process.env.ANALYST_SMOKE_HERMES_URL || 'ws://127.0.0.1:9122/api/ws';
const analystSidecarUrl = process.env.ANALYST_SMOKE_SIDECAR_URL || 'http://127.0.0.1:6952';
const hermesHttpUrl = process.env.ANALYST_SMOKE_HERMES_HTTP_URL || 'http://127.0.0.1:9121';
const hermesToken = String(process.env.HERMES_DASHBOARD_SESSION_TOKEN || '');
const analystServiceToken = String(process.env.ANALYST_SERVICE_TOKEN || '');

if (!hermesToken || !analystServiceToken) {
  process.stderr.write('HERMES_DASHBOARD_SESSION_TOKEN and ANALYST_SERVICE_TOKEN are required.\n');
  process.exit(2);
}

const app = express();
app.use((request, reply, next) => {
  reply.setHeader('Access-Control-Allow-Origin', uiOrigin);
  reply.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  reply.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  reply.setHeader('Cache-Control', 'no-store');
  if (request.method === 'OPTIONS') return reply.sendStatus(204);
  next();
});
app.use(express.json());

let gateway;

process.env.ANALYST_SIDECAR_URL = analystSidecarUrl;
process.env.ANALYST_HERMES_HTTP_URL = hermesHttpUrl;
process.env.ANALYST_CONTRACT_VERIFIED = 'true';
const { router: analystRouter } = createAnalystRoutes({
  // Upload/feed collaborators are never exercised by this review-only smoke
  // host. Supplying inert objects keeps the production route factory intact.
  s3: {},
  dynamodb: {},
  httpClient: axios,
  gatewayStatus: () => gateway?.status() || { status: 'idle' },
});
app.use('/api/analyst', analystRouter);

const server = http.createServer(app);
gateway = attachAnalystGatewayProxy(server, {
  upstreamHost: hermesUrl,
  token: hermesToken,
  analystServiceToken,
  analystSidecarUrl,
  contractVerified: true,
  gmEnabled: false,
});

server.listen(port, host, () => {
  process.stdout.write(`Analyst browser smoke harness ready on http://${host}:${port}.\n`);
});

function close() {
  gateway.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
