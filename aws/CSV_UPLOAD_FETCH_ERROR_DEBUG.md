# CSV Upload Fetch Error - Debugging Guide

## Current Issue

The CSV upload button is experiencing a fetch error when trying to communicate with the backend server.

## Architecture Overview

```
User Browser (CSVUpload.jsx)
    ↓
    Fetch POST to /api/presigned-url
    ↓
Express Backend (server.js:289)
    ↓
    Generate S3 presigned URL
    ↓
Return presigned URL to browser
    ↓
Browser uploads CSV directly to S3
    ↓
S3 triggers Lambda → DynamoDB
```

## Component Location

- **Frontend**: [src/components/CSVUpload.jsx](../src/components/CSVUpload.jsx)
- **Backend**: [server.js](../server.js) line 289-340
- **Service**: [src/services/presignedUploadService.js](../src/services/presignedUploadService.js)

## Expected Flow

1. User selects CSV file
2. `CSVUpload.jsx` calls `PresignedUploadService.uploadCSV(file)`
3. Service makes POST to `${backendUrl}/api/presigned-url`
4. Backend generates presigned S3 URL (valid 5 minutes)
5. Service uploads file directly to S3 using presigned URL
6. Lambda automatically processes the upload
7. Dashboard shows success message

## Common Fetch Errors

### Error 1: Backend Not Running
**Symptom**: `Failed to fetch` or `net::ERR_CONNECTION_REFUSED`
**Solution**:
```bash
npm run server
# or
npm run dev
```

### Error 2: CORS Issue
**Symptom**: `Access to fetch blocked by CORS policy`
**Solution**: Backend already configured for CORS (server.js:47-52)
```javascript
cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
})
```

### Error 3: Wrong Backend URL
**Symptom**: 404 Not Found
**Check**: Environment variable in frontend
```javascript
// presignedUploadService.js:15
const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
```

### Error 4: AWS Credentials Not Set
**Symptom**: Backend returns 500 error with AWS credentials message
**Solution**: Set AWS credentials in environment or `~/.aws/credentials`
```bash
# Option 1: Environment variables
export AWS_ACCESS_KEY_ID=your_key
export AWS_SECRET_ACCESS_KEY=your_secret
export AWS_REGION=us-west-1

# Option 2: AWS CLI credentials file
aws configure
```

### Error 5: S3 Bucket Permissions
**Symptom**: Backend error "Access Denied" when generating presigned URL
**Solution**: Verify IAM user has `s3:PutObject` permission on bucket

## Debugging Steps

### Step 1: Verify Backend is Running
```bash
# Start backend server
npm run server

# Should see:
# 🚀 Server running on port 3001
# 📊 Market data API available at http://localhost:3001/api
# 💼 Portfolio data available at http://localhost:3001/api/portfolio
# ✅ AWS credentials validated successfully
```

### Step 2: Test Backend Endpoint Directly
```bash
# Test presigned URL generation
curl -X POST http://localhost:3001/api/presigned-url \
  -H "Content-Type: application/json" \
  -d '{"filename": "uploads/test.csv", "contentType": "text/csv"}'

# Expected response:
# {
#   "presignedUrl": "https://market-dashboard-csv-data.s3.us-west-1.amazonaws.com/...",
#   "key": "uploads/test.csv",
#   "bucket": "market-dashboard-csv-data"
# }
```

### Step 3: Check Browser Console
Open browser DevTools (F12) → Console tab
Look for:
- Network errors (red text)
- Fetch errors
- CORS errors
- JavaScript errors

### Step 4: Check Network Tab
Open browser DevTools (F12) → Network tab
1. Filter by "Fetch/XHR"
2. Try uploading CSV
3. Look for `/api/presigned-url` request
4. Check status code (should be 200)
5. Check response body (should contain presignedUrl)

### Step 5: Check Backend Logs
In terminal where `npm run server` is running:
- Look for "Generating presigned URL" message
- Check for any error messages
- Verify AWS credentials validation succeeded

## Current Code Implementation

### Frontend Service (presignedUploadService.js)
```javascript
static async uploadCSV(file) {
  // Step 1: Get presigned URL from backend
  const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
  const presignedResponse = await fetch(`${backendUrl}/api/presigned-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: this.generateFilename(file.name),
      contentType: 'text/csv'
    })
  });

  const { presignedUrl, key } = await presignedResponse.json();

  // Step 2: Upload directly to S3
  const uploadResponse = await fetch(presignedUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': 'text/csv' }
  });

  return { success: true, location: `.../${key}`, key, bucket: '...' };
}
```

### Backend Endpoint (server.js)
```javascript
app.post('/api/presigned-url', async (req, res) => {
  const { filename, contentType } = req.body;

  const params = {
    Bucket: 'market-dashboard-csv-data',
    Key: filename,
    ContentType: contentType || 'text/csv',
    Expires: 300 // 5 minutes
  };

  const presignedUrl = await new Promise((resolve, reject) => {
    s3.getSignedUrl('putObject', params, (err, url) => {
      if (err) reject(err);
      else resolve(url);
    });
  });

  res.json({ presignedUrl, key: filename, bucket: 'market-dashboard-csv-data' });
});
```

## Quick Test Checklist

- [ ] Backend server running (`npm run server`)
- [ ] AWS credentials validated (check startup logs)
- [ ] Frontend running (`npm start`)
- [ ] Both running on correct ports (3001 backend, 3000 frontend)
- [ ] Browser console shows no errors
- [ ] Network tab shows `/api/presigned-url` request
- [ ] Backend logs show "Generating presigned URL"

## Next Steps After Fix

1. Test CSV upload end-to-end
2. Verify Lambda processes the file
3. Check DynamoDB for new data
4. Confirm dashboard displays updated portfolio

## Related Files

- Component: [src/components/CSVUpload.jsx](../src/components/CSVUpload.jsx)
- Service: [src/services/presignedUploadService.js](../src/services/presignedUploadService.js)
- Backend: [server.js](../server.js)
- Dashboard Integration: [src/components/Dashboard/PortfolioDashboard.jsx](../src/components/Dashboard/PortfolioDashboard.jsx)

## Support Resources

- Express CORS: https://expressjs.com/en/resources/middleware/cors.html
- S3 Presigned URLs: https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html
- Fetch API: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
