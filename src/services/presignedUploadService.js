/**
 * Upload portfolio CSVs through a constrained S3 presigned POST policy.
 * AWS credentials and bucket details remain server-side.
 */

const MAX_CSV_SIZE_BYTES = 10 * 1024 * 1024;
const CSV_CONTENT_TYPE = 'text/csv';

export class PresignedUploadService {
  static async uploadCSV(file) {
    try {
      this.validateCSV(file);

      const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
      const presignedResponse = await fetch(`${backendUrl}/api/presigned-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: file.name,
          contentType: CSV_CONTENT_TYPE,
          sizeBytes: file.size,
        }),
      });

      if (!presignedResponse.ok) {
        const errorData = await presignedResponse.json().catch(() => ({}));
        throw new Error(errorData.details || errorData.error || 'Failed to authorize upload');
      }

      const { url, fields, key, expiresAt } = await presignedResponse.json();
      if (!url || !fields || typeof fields !== 'object' || !key || !expiresAt) {
        throw new Error('Upload authorization response is incomplete');
      }
      if (!key.startsWith('portfolio-uploads/') || !key.toLowerCase().endsWith('.csv')) {
        throw new Error('Upload authorization returned an invalid portfolio key');
      }

      const formData = new FormData();
      Object.entries(fields).forEach(([field, value]) => {
        formData.append(field, String(value));
      });
      formData.append('file', file, file.name);

      const uploadResponse = await fetch(url, {
        method: 'POST',
        body: formData,
      });

      if (!uploadResponse.ok) {
        throw new Error('Upload to S3 failed');
      }

      return {
        success: true,
        key,
        expiresAt,
      };
    } catch (error) {
      throw new Error(`Upload failed: ${error.message}`);
    }
  }

  static validateCSV(file) {
    if (!file) {
      throw new Error('No file provided');
    }

    const filename = String(file.name || '');
    if (!filename || filename.includes('/') || filename.includes('\\') || !filename.toLowerCase().endsWith('.csv')) {
      throw new Error('File must be a CSV');
    }

    if (!Number.isFinite(file.size) || file.size <= 0) {
      throw new Error('CSV file is empty');
    }

    if (file.size > MAX_CSV_SIZE_BYTES) {
      throw new Error('File too large (max 10MB)');
    }

    return true;
  }
}

export { MAX_CSV_SIZE_BYTES };
