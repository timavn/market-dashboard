# Restart and Verify Spot Price Column Fixes

## Quick Start

### Step 1: Restart Backend Server

**If using separate terminals:**
```bash
# In the terminal running the backend:
# Press Ctrl+C to stop
npm run server
```

**If using npm run dev (both frontend and backend):**
```bash
# Press Ctrl+C to stop both
npm run dev
```

### Step 2: Verify Server Started Correctly

Look for these messages in the server console:
```
🚀 Server running on port 3001
📊 Market data API available at http://localhost:3001/api
```

### Step 3: Test the Endpoint (Optional)

Run the verification script:
```bash
node verify-quotes-setup.js
```

This will test 5 symbols and show you which ones work.

### Step 4: Monitor Backend Logs

When the frontend makes a request, you should see in the server console:

**Expected Logs:**
```
[API] /api/quotes called with 111 symbols: BKLN, BNDX, CWB, EMB, HYG ...
[API] Processing batch 1/23 (5 symbols)
[Cache] Miss for BKLN, fetching...
[Yahoo Finance] Fetching quote for: BKLN
[Yahoo Finance] BKLN - Available price fields: [...]
[Yahoo Finance] Successfully fetched BKLN: price=...
[API] Processing batch 2/23 (5 symbols)
...
[API] Returning X quotes out of 111 requested (Y failed)
```

### Step 5: Check Browser Console

After refreshing the browser, you should see:
```
[SecuritiesList] Fetching prices for 111 securities
[SecuritiesList] Received quotes: X quotes  (X should be >> 8)
[SecuritiesList] Price fetch complete: X success, Y failed
```

### Step 6: Verify UI

- Spot Price column should show prices for most securities
- Prices formatted as: $123.45 for stocks, 2.50% for yields
- Right-aligned column

## Troubleshooting

**If still seeing 8/111:**
1. Check server console for error messages
2. Look for `[Yahoo Finance] API error` or rate limiting messages
3. Check if server actually restarted (look for axios import confirmation)

**If request times out:**
- Frontend timeout is now 60 seconds
- First request may take 30-40 seconds
- Subsequent requests should be faster (cache hits)

**If server won't start:**
- Check for syntax errors in server.js
- Verify axios is installed: `npm list axios`
- Check Node.js version: `node --version` (should be 12+)

