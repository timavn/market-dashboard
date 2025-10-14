# 🚨 CSV Upload Fetch Error - Quick Fix Guide

## Problem
CSV upload button shows fetch error when trying to upload files.

## Quick Diagnosis (2 minutes)

### Step 1: Is the backend running?
```bash
# Check if server is running
lsof -i :3001

# If nothing shows, start it:
npm run server
```

**Expected output**:
```
🚀 Server running on port 3001
✅ AWS credentials validated successfully
```

### Step 2: Are AWS credentials configured?
```bash
# Check credentials file exists
cat ~/.aws/credentials

# Or check environment variables
echo $AWS_ACCESS_KEY_ID
```

If missing, run:
```bash
aws configure
# Enter your AWS credentials
```

### Step 3: Test backend directly
```bash
curl http://localhost:3001/api/health
```

**Expected**: `{"status":"OK","timestamp":"..."}`

If this fails, backend is not running or crashed.

### Step 4: Test presigned URL endpoint
```bash
curl -X POST http://localhost:3001/api/presigned-url \
  -H "Content-Type: application/json" \
  -d '{"filename":"uploads/test.csv","contentType":"text/csv"}'
```

**Expected**: JSON with `presignedUrl`, `key`, `bucket`

## Common Fixes

### Fix 1: Backend Not Running
```bash
# Kill any existing process
pkill -f "node.*server"

# Start fresh
npm run server
```

### Fix 2: AWS Credentials Missing
```bash
# Configure credentials
aws configure

# Or set environment variables
export AWS_ACCESS_KEY_ID=your_key_here
export AWS_SECRET_ACCESS_KEY=your_secret_here
export AWS_REGION=us-west-1
```

### Fix 3: Wrong Backend URL
Check `src/services/presignedUploadService.js` line 15:
```javascript
const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
```

Make sure frontend is using `http://localhost:3001` (not 3000).

### Fix 4: CORS Issue (Unlikely)
Check browser console (F12). If you see "CORS policy" error:
- Backend CORS is already configured (server.js:47-52)
- Make sure frontend is on `localhost:3000`
- Make sure backend is on `localhost:3001`

## Full Restart (Nuclear Option)

```bash
# Kill everything
pkill -f "node.*server"
pkill -f "react-scripts"

# Start backend
npm run server
# Wait for "✅ AWS credentials validated successfully"

# In new terminal, start frontend
npm start
```

## Test the Fix

1. Open browser to http://localhost:3000
2. Open DevTools (F12) → Console tab
3. Open Network tab
4. Try uploading a CSV file
5. Look for `/api/presigned-url` request in Network tab
6. Should see status 200

## Still Not Working?

### Check Backend Logs
Look in terminal where `npm run server` is running:
- Should see "🔗 Generating presigned URL for: ..."
- Should see "✅ Generated presigned URL: https://..."
- Any errors will show here

### Check Browser Console
Look in browser DevTools → Console:
- Any red errors?
- Any fetch errors?
- Any "Failed to fetch" messages?

### Check Network Tab
Browser DevTools → Network → Filter by "Fetch/XHR":
- Is `/api/presigned-url` request there?
- What's the status code? (should be 200)
- Click on it → Response tab → What does it say?

## Most Likely Issue

**Backend not running** - 90% of fetch errors

Solution:
```bash
npm run server
```

## Need More Help?

See detailed debugging guide:
- `aws/CSV_UPLOAD_FETCH_ERROR_DEBUG.md`
- `aws/CURRENT_STATUS_SUMMARY.md`

## Success Indicators

When it's working, you'll see:
1. ✅ Backend logs: "Generating presigned URL"
2. ✅ Browser Network tab: 200 OK response
3. ✅ CSV upload shows "Uploading..." then "Success!"
4. ✅ Lambda processes file (check CloudWatch)
5. ✅ Dashboard refreshes with new data
