import { MAX_CSV_SIZE_BYTES, PresignedUploadService } from './presignedUploadService';

describe('PresignedUploadService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('requests a constrained policy and uploads the CSV with multipart POST', async () => {
    const file = new File(['symbol,quantity\nSPY,1\n'], 'portfolio.csv', { type: 'text/csv' });
    const fields = {
      key: 'portfolio-uploads/authorized.csv',
      policy: 'encoded-policy',
      'Content-Type': 'text/csv',
    };
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: 'https://example-bucket.s3.amazonaws.com',
          fields,
          key: 'portfolio-uploads/authorized.csv',
          expiresAt: '2026-07-15T20:00:00.000Z',
        }),
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(PresignedUploadService.uploadCSV(file)).resolves.toEqual({
      success: true,
      key: 'portfolio-uploads/authorized.csv',
      expiresAt: '2026-07-15T20:00:00.000Z',
    });

    expect(fetch).toHaveBeenNthCalledWith(1, 'http://localhost:3001/api/presigned-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'portfolio.csv',
        contentType: 'text/csv',
        sizeBytes: file.size,
      }),
    });

    const [, uploadOptions] = fetch.mock.calls[1];
    expect(fetch.mock.calls[1][0]).toBe('https://example-bucket.s3.amazonaws.com');
    expect(uploadOptions.method).toBe('POST');
    expect(uploadOptions.headers).toBeUndefined();
    expect(uploadOptions.body).toBeInstanceOf(FormData);
    expect(uploadOptions.body.get('key')).toBe(fields.key);
    expect(uploadOptions.body.get('policy')).toBe(fields.policy);
    expect(uploadOptions.body.get('Content-Type')).toBe('text/csv');
    expect(uploadOptions.body.get('file')).toBeInstanceOf(File);
  });

  test('rejects non-CSV and oversized files before requesting a policy', async () => {
    global.fetch = jest.fn();

    await expect(PresignedUploadService.uploadCSV({ name: 'portfolio.pdf', size: 100 }))
      .rejects.toThrow('Upload failed: File must be a CSV');
    await expect(PresignedUploadService.uploadCSV({ name: 'portfolio.csv', size: MAX_CSV_SIZE_BYTES + 1 }))
      .rejects.toThrow('Upload failed: File too large (max 10MB)');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('rejects an authorization that escapes the portfolio CSV prefix', async () => {
    const file = new File(['a,b\n'], 'portfolio.csv', { type: 'text/csv' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: 'https://example-bucket.s3.amazonaws.com',
        fields: { key: 'hedgeye-uploads/document.pdf' },
        key: 'hedgeye-uploads/document.pdf',
        expiresAt: '2026-07-15T20:00:00.000Z',
      }),
    });

    await expect(PresignedUploadService.uploadCSV(file))
      .rejects.toThrow('Upload failed: Upload authorization returned an invalid portfolio key');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
