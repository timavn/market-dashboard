# 🔍 DEBUG STEPS - CSV Upload "Failed to Fetch" Error

## I've Added Debug Logging - Here's How to Use It

### Step 1: Open Browser Console (F12)

1. **Go to your dashboard:** http://localhost:3000
2. **Open DevTools:**
   - Mac: `Cmd + Option + I`
   - Windows: `F12` or `Ctrl + Shift + I`
3. **Click the "Console" tab**
4. **Clear the console:** Click the 🚫 icon to clear old messages

### Step 2: Try Uploading a CSV

1. **Drag a CSV file** to the "Upload Schwab CSV" button
2. **Watch the console** - you should see debug messages

### Step 3: What to Look For

#### **Scenario A: You See Debug Messages** 🔍

If you see messages starting with `🔍 DEBUG:`, look at what it says:

```javascript
// GOOD - Request is being made:
🔍 DEBUG: Starting CSV upload
🔍 DEBUG: Backend URL: http://localhost:3001
🔍 DEBUG: Fetching presigned URL from: http://localhost:3001/api/presigned-url

// THEN one of these:

// SUCCESS PATH:
🔍 DEBUG: Presigned response status: 200
🔍 DEBUG: Presigned response ok: true
🔍 DEBUG: Got presigned URL: https://market-dashboard-csv-data.s3...
→ Issue is with S3 upload, not backend

// FAILURE PATH:
🔍 DEBUG: Presigned response status: 500
🔍 DEBUG: Presigned response ok: false
→ Backend is returning an error

// NO RESPONSE:
❌ DEBUG: Upload error caught: TypeError: Failed to fetch
→ Can't reach backend at all
```

#### **Scenario B: No Debug Messages at All** ❌

If you don't see ANY debug messages:
- React hasn't reloaded the new code
- Need to hard refresh: `Cmd + Shift + R`

---

## 🎯 What Each Error Means

### Error 1: "TypeError: Failed to fetch"
**Meaning:** Browser can't connect to `http://localhost:3001`

**Possible causes:**
- Backend server not running
- Wrong URL
- CORS blocking the request
- Browser privacy/firewall blocking localhost

**Check:**
```bash
# Is backend running?
lsof -ti :3001
# Should show a process ID

# Can you curl it?
curl http://localhost:3001/api/health
# Should return: {"status":"OK",...}
```

---

### Error 2: "Response status: 500" or "Response status: 404"
**Meaning:** Backend is reached but returning an error

**Check console for:**
- Status 404 = Wrong endpoint URL
- Status 500 = Backend crashed/AWS error

**Solution:**
Check backend terminal logs for crash messages

---

### Error 3: "NetworkError when attempting to fetch resource"
**Meaning:** CORS policy blocking the request

**Check console for:**
```
Access to fetch at 'http://localhost:3001/api/presigned-url' from origin
'http://localhost:3000' has been blocked by CORS policy
```

**Solution:**
Backend CORS should already be configured, but check server.js:47-52

---

## 📋 **Step-by-Step Debugging Checklist**

### ✅ Step 1: Verify Backend is Running
```bash
curl http://localhost:3001/api/health
```
**Expected:** `{"status":"OK","timestamp":"..."}`

**If fails:** Backend not running
```bash
npm run server
```

---

### ✅ Step 2: Verify Presigned URL Endpoint Works
```bash
curl -X POST http://localhost:3001/api/presigned-url \
  -H "Content-Type: application/json" \
  -d '{"filename":"uploads/test.csv","contentType":"text/csv"}'
```
**Expected:** JSON with `presignedUrl`, `key`, `bucket`

**If fails:** Backend AWS credentials issue or crash

---

### ✅ Step 3: Check Frontend is Using Correct URL
**In browser console, after trying to upload:**
```javascript
// Should see:
🔍 DEBUG: Backend URL: http://localhost:3001
```

**If it shows different URL:**
- Check .env file exists
- Restart React to pick up .env

---

### ✅ Step 4: Check Browser Network Tab
1. **Open DevTools** → **Network tab**
2. **Filter by "Fetch/XHR"**
3. **Try uploading CSV**
4. **Look for request** to `presigned-url`

**Click on the request and check:**
- **Headers tab:** What's the Request URL?
- **Response tab:** What did backend return?
- **Status:** Should be 200

---

## 🚨 **Most Common Issues & Solutions**

### Issue 1: Backend URL Shows Undefined
```javascript
🔍 DEBUG: Backend URL: undefined
```

**Solution:**
```bash
# Create .env file
echo "REACT_APP_BACKEND_URL=http://localhost:3001" > .env

# Restart React
pkill -f "react-scripts"
npm start
```

---

### Issue 2: CORS Error in Console
```
Access-Control-Allow-Origin...
```

**Solution:**
Backend CORS config should allow localhost:3000. Check server.js has:
```javascript
cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
})
```

---

### Issue 3: Backend Returns 500 Error
```javascript
🔍 DEBUG: Presigned response status: 500
```

**Solution:**
Check backend terminal for error logs. Likely AWS credentials issue:
```bash
# Check credentials exist
cat ~/.aws/credentials

# Restart backend
pkill -f "node.*server"
npm run server
```

---

## 🎯 **What to Report Back**

After trying the upload with debug logging, tell me:

1. **What debug messages you see** (copy/paste the console output)
2. **What the Network tab shows** (status code, URL, response)
3. **Any red errors** in console

This will tell us EXACTLY where it's failing:
- Before fetch = Frontend issue
- During fetch = Network/CORS issue
- After fetch returns error = Backend issue
- During S3 upload = AWS/S3 issue

---

## 🔄 **Quick Reset If Needed**

If things get messy, full reset:
```bash
# Kill everything
pkill -f "node.*server"
pkill -f "react-scripts"

# Wait
sleep 3

# Start backend
npm run server &

# Wait for backend to start
sleep 5

# Start frontend
npm start

# Wait for "Compiled successfully"
# Then hard refresh browser: Cmd + Shift + R
```

---

## 📝 **Action Items for You:**

1. ✅ **Hard refresh browser:** `Cmd + Shift + R`
2. ✅ **Open Console:** `Cmd + Option + I`
3. ✅ **Try uploading CSV**
4. ✅ **Copy the console output** (everything with 🔍 or ❌)
5. ✅ **Paste it here** so I can see exactly what's happening

The debug logs will show us EXACTLY where it's failing! 🎯
