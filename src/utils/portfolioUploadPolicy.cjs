const crypto = require('crypto');

const MAX_PORTFOLIO_UPLOAD_BYTES = 10 * 1024 * 1024;
const PRESIGNED_POST_TTL_SECONDS = 300;
const CSV_CONTENT_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
]);

function validatePortfolioUploadRequest({ filename, contentType, sizeBytes } = {}) {
  const cleanFilename = typeof filename === 'string' ? filename.trim() : '';
  const normalizedContentType = typeof contentType === 'string'
    ? contentType.split(';', 1)[0].trim().toLowerCase()
    : '';

  if (!cleanFilename) {
    return { ok: false, statusCode: 400, error: 'Filename is required' };
  }
  if (cleanFilename.length > 255 || cleanFilename.includes('/') || cleanFilename.includes('\\')) {
    return { ok: false, statusCode: 400, error: 'Filename must be a plain CSV filename' };
  }
  if (!/\.csv$/i.test(cleanFilename)) {
    return { ok: false, statusCode: 400, error: 'Only .csv portfolio uploads are accepted' };
  }
  if (!CSV_CONTENT_TYPES.has(normalizedContentType)) {
    return { ok: false, statusCode: 400, error: 'Unsupported CSV content type' };
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, statusCode: 400, error: 'sizeBytes must be a positive integer' };
  }
  if (sizeBytes > MAX_PORTFOLIO_UPLOAD_BYTES) {
    return { ok: false, statusCode: 413, error: 'CSV upload exceeds the 10 MB limit' };
  }

  return { ok: true, cleanFilename, normalizedContentType, sizeBytes };
}

function createPortfolioUploadKey(filename, {
  nowMs = Date.now(),
  uniqueId = crypto.randomUUID(),
} = {}) {
  const originalStem = String(filename).replace(/\.csv$/i, '');
  const safeStem = originalStem
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'portfolio';
  return `portfolio-uploads/${nowMs}-${uniqueId}-${safeStem}.csv`;
}

function buildPortfolioPresignedPostParams({ bucket, key, contentType }) {
  if (!/^portfolio-uploads\/[^/]+\.csv$/i.test(key)) {
    throw new Error('Portfolio upload key must be a CSV under portfolio-uploads/');
  }
  if (!CSV_CONTENT_TYPES.has(contentType)) {
    throw new Error('Portfolio upload content type must be CSV');
  }

  return {
    Bucket: bucket,
    Expires: PRESIGNED_POST_TTL_SECONDS,
    Fields: {
      key,
      'Content-Type': contentType,
    },
    Conditions: [
      ['eq', '$key', key],
      ['starts-with', '$key', 'portfolio-uploads/'],
      ['eq', '$Content-Type', contentType],
      ['content-length-range', 1, MAX_PORTFOLIO_UPLOAD_BYTES],
    ],
  };
}

module.exports = {
  MAX_PORTFOLIO_UPLOAD_BYTES,
  PRESIGNED_POST_TTL_SECONDS,
  buildPortfolioPresignedPostParams,
  createPortfolioUploadKey,
  validatePortfolioUploadRequest,
};
