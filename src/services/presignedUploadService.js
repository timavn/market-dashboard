/**
 * Presigned Upload Service
 * Uploads files to S3 using presigned URLs (no credentials needed in browser)
 */

export class PresignedUploadService {
  
  /**
   * Get presigned URL from backend and upload file
   */
  static async uploadCSV(file) {
    try {
      // Step 1: Get presigned URL from backend
      // Use full URL to bypass proxy issues
      const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3000';

      console.log('🔍 DEBUG: Starting CSV upload');
      console.log('🔍 DEBUG: Backend URL:', backendUrl);
      console.log('🔍 DEBUG: File name:', file.name);
      console.log('🔍 DEBUG: File size:', file.size);

      const requestUrl = `${backendUrl}/api/presigned-url`;
      console.log('🔍 DEBUG: Fetching presigned URL from:', requestUrl);

      const presignedResponse = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: this.generateFilename(file.name),
          contentType: 'text/csv'
        })
      });

      console.log('🔍 DEBUG: Presigned response status:', presignedResponse.status);
      console.log('🔍 DEBUG: Presigned response ok:', presignedResponse.ok);

      if (!presignedResponse.ok) {
        const errorData = await presignedResponse.json().catch(() => ({}));
        const errorMessage = errorData.details || errorData.error || 'Failed to get presigned URL';
        throw new Error(errorMessage);
      }

      const { presignedUrl, key } = await presignedResponse.json();

      console.log('🔍 DEBUG: Got presigned URL:', presignedUrl.substring(0, 100) + '...');
      console.log('🔍 DEBUG: S3 key:', key);

      // Step 2: Upload file directly to S3 using presigned URL
      console.log('🔍 DEBUG: Uploading to S3...');
      const uploadResponse = await fetch(presignedUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': 'text/csv',
        }
      });

      if (!uploadResponse.ok) {
        throw new Error('Upload to S3 failed');
      }

      return {
        success: true,
        location: `https://market-dashboard-csv-data.s3.us-west-1.amazonaws.com/${key}`,
        key: key,
        bucket: 'market-dashboard-csv-data'
      };
      
    } catch (error) {
      console.error('❌ DEBUG: Upload error caught:', error);
      console.error('❌ DEBUG: Error type:', error.constructor.name);
      console.error('❌ DEBUG: Error message:', error.message);
      console.error('❌ DEBUG: Error stack:', error.stack);
      throw new Error(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Generate unique filename with timestamp
   */
  static generateFilename(originalName) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = originalName.replace('.csv', '');
    return `uploads/${baseName}-${timestamp}.csv`;
  }

  /**
   * Validate CSV file
   */
  static validateCSV(file) {
    if (!file) {
      throw new Error('No file provided');
    }

    if (!file.name.toLowerCase().endsWith('.csv')) {
      throw new Error('File must be a CSV');
    }

    if (file.size > 10 * 1024 * 1024) { // 10MB limit
      throw new Error('File too large (max 10MB)');
    }

    return true;
  }
}
