const {
  MAX_PORTFOLIO_UPLOAD_BYTES,
  PRESIGNED_POST_TTL_SECONDS,
  buildPortfolioPresignedPostParams,
  createPortfolioUploadKey,
  validatePortfolioUploadRequest,
} = require('./portfolioUploadPolicy.cjs');

describe('portfolio CSV upload policy', () => {
  test('rejects oversized uploads in application validation', () => {
    expect(validatePortfolioUploadRequest({
      filename: 'portfolio.csv',
      contentType: 'text/csv',
      sizeBytes: MAX_PORTFOLIO_UPLOAD_BYTES + 1,
    })).toEqual({
      ok: false,
      statusCode: 413,
      error: 'CSV upload exceeds the 10 MB limit',
    });
  });

  test.each([
    ['portfolio.pdf', 'text/csv'],
    ['portfolio.csv', 'application/pdf'],
    ['../portfolio.csv', 'text/csv'],
  ])('rejects non-CSV or caller-controlled paths (%s, %s)', (filename, contentType) => {
    expect(validatePortfolioUploadRequest({ filename, contentType, sizeBytes: 100 }).ok).toBe(false);
  });

  test('builds a server-generated portfolio key', () => {
    expect(createPortfolioUploadKey('My Positions.csv', {
      nowMs: 1_234,
      uniqueId: 'test-id',
    })).toBe('portfolio-uploads/1234-test-id-My-Positions.csv');
  });

  test('S3 policy independently enforces prefix, CSV type, and 10 MB ceiling', () => {
    const key = 'portfolio-uploads/1234-test-id-portfolio.csv';
    const params = buildPortfolioPresignedPostParams({
      bucket: 'test-bucket',
      key,
      contentType: 'text/csv',
    });

    expect(params.Expires).toBe(PRESIGNED_POST_TTL_SECONDS);
    expect(params.Fields).toEqual({ key, 'Content-Type': 'text/csv' });
    expect(params.Conditions).toEqual(expect.arrayContaining([
      ['eq', '$key', key],
      ['starts-with', '$key', 'portfolio-uploads/'],
      ['eq', '$Content-Type', 'text/csv'],
      ['content-length-range', 1, MAX_PORTFOLIO_UPLOAD_BYTES],
    ]));
  });
});
