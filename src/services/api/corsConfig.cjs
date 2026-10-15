'use strict';

const API_CORS_ALLOWED_HEADERS = Object.freeze([
  'Content-Type',
  'Authorization',
  'X-Readiness-Repair',
  'X-Login-Action',
  'Last-Event-ID',
]);

const API_CORS_EXPOSED_HEADERS = Object.freeze([
  'X-Data-Cache',
  'X-Data-Age',
  'X-Risk-Range-Status',
  'X-Risk-Range-Publication-Date',
  'Age',
  'Warning',
]);

function createApiCorsOptions({ nodeEnv = process.env.NODE_ENV } = {}) {
  return {
    origin: nodeEnv === 'production'
      ? false
      : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [...API_CORS_ALLOWED_HEADERS],
    exposedHeaders: [...API_CORS_EXPOSED_HEADERS],
  };
}

module.exports = {
  API_CORS_ALLOWED_HEADERS,
  API_CORS_EXPOSED_HEADERS,
  createApiCorsOptions,
};
