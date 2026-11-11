'use strict';

// The last handler in the API's chain.
//
// Without one, Express answers a route that throws with an HTML page (and,
// outside production, the stack trace). The dashboard's clients expect JSON,
// so they failed on the page instead of reporting the error. The status is the
// one Express would have used; only the body changes, and the stack goes to
// the log instead of the response.

const API_PATH = /^\/(?:api|internal)(?:\/|$)/;

function errorStatus(error) {
  for (const value of [error?.status, error?.statusCode]) {
    if (Number.isInteger(value) && value >= 400 && value <= 599) return value;
  }
  return 500;
}

function createApiErrorHandler({ logger = console } = {}) {
  // Express recognises an error handler by its four parameters.
  return function apiErrorHandler(error, req, res, next) {
    // A response that has already started cannot be replaced, and anything
    // outside the API keeps Express's own handling.
    if (res.headersSent || !API_PATH.test(req.path || '')) return next(error);

    const status = errorStatus(error);
    const message = (error instanceof Error ? error.message : String(error ?? '')) || 'Request failed';
    if (status >= 500) {
      logger.error(`[API] ${req.method} ${req.path} failed:`, error?.stack || error);
      return res.status(status).json({
        error: 'Internal server error',
        details: message,
        code: error?.code || 'UNKNOWN_ERROR',
      });
    }
    return res.status(status).json({
      error: message,
      code: error?.code || error?.type || 'REQUEST_REJECTED',
    });
  };
}

module.exports = { createApiErrorHandler, errorStatus };
