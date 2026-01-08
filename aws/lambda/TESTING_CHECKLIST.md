# Risk Range Scraper Preview - Testing Checklist

## Prerequisites ✅ (Already Verified)
- ✅ AWS credentials configured (`aws configure list` shows credentials)
- ✅ boto3 installed (v1.40.46)
- ✅ Playwright available
- ✅ S3 bucket accessible (`market-dashboard-csv-data`)
- ✅ Backend server running (port 3001)
- ✅ Frontend running (port 3000)

## Step-by-Step Testing

### 1. Test Screenshot Capture & S3 Upload

**Run scraper manually to test screenshot functionality:**

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
python3 hedgeye_local_scraper.py --scrape --chrome
```

**What to verify:**
- [ ] Screenshot is captured (check for `hedgeye_screenshot_*.png` in lambda directory)
- [ ] Screenshot is uploaded to S3 (check S3 console: `market-dashboard-csv-data/hedgeye-screenshots/`)
- [ ] Screenshot S3 key is stored in DynamoDB (`HedgeyeDailySnapshot` table)
- [ ] CSV file is created locally (`hedgeye_risk_ranges_*.csv`)
- [ ] CSV is uploaded to S3 (if enabled: `market-dashboard-csv-data/hedgeye-exports/`)

**Check S3:**
```bash
aws s3 ls s3://market-dashboard-csv-data/hedgeye-screenshots/ --recursive
aws s3 ls s3://market-dashboard-csv-data/hedgeye-exports/ --recursive
```

### 2. Test Backend API Endpoints

**Test screenshot endpoint:**
```bash
# Get today's date
DATE=$(date +%Y-%m-%d)

# Test screenshot endpoint
curl http://localhost:3001/api/hedgeye/screenshot/$DATE

# Should return JSON with presigned URL
```

**Test CSV endpoint:**
```bash
curl http://localhost:3001/api/hedgeye/csv/$DATE

# Should return JSON with presigned URL
```

**What to verify:**
- [ ] Endpoint returns 200 with presigned URL (if screenshot exists)
- [ ] Endpoint returns 404 if no screenshot for date
- [ ] Presigned URL is valid and accessible

### 3. Test Frontend Preview Tab

**Steps:**
1. Open dashboard in browser: `http://localhost:3000`
2. Click Service Tracking button (bottom right)
3. Navigate to "Preview" tab
4. Verify side-by-side view appears

**What to verify:**
- [ ] Preview tab appears in tab list
- [ ] Screenshot loads on left side (if available)
- [ ] Extracted data table appears on right side
- [ ] Timestamps display correctly
- [ ] "Download CSV" button appears (if CSV available)
- [ ] Missing screenshot shows placeholder message gracefully

### 4. Verify DynamoDB Data

**Check snapshot record:**
```bash
aws dynamodb get-item \
  --table-name HedgeyeDailySnapshot \
  --key '{"date":{"S":"2025-01-15"},"snapshotType":{"S":"risk-ranges"}}' \
  --region us-west-1
```

**What to verify:**
- [ ] `screenshotS3Key` field exists in snapshot
- [ ] `csvS3Key` field exists (if CSV uploaded)
- [ ] S3 keys are valid paths

### 5. Test Full Workflow (End-to-End)

**Simulate a real scrape:**
1. Run scraper: `python3 hedgeye_local_scraper.py --scrape --chrome`
2. Wait for completion
3. Check S3 for screenshot
4. Open dashboard Preview tab
5. Verify screenshot and data appear side-by-side

**What to verify:**
- [ ] Screenshot appears in Preview tab
- [ ] Data table matches screenshot content
- [ ] CSV download works
- [ ] Timestamps are accurate

### 6. Verify LaunchAgent Schedule

**Check LaunchAgent status:**
```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
./manage_scraper.sh status
```

**What to verify:**
- [ ] LaunchAgent is loaded
- [ ] Schedule shows 8:00 AM EST
- [ ] Next run time is correct

### 7. Test Error Handling

**Test missing screenshot gracefully:**
- View Preview tab when no scrape has run yet
- Should show "No screenshot available" message

**Test S3 upload failure:**
- Temporarily break AWS credentials
- Run scraper
- Should save screenshot locally and continue

## Common Issues & Fixes

### Issue: Screenshot not appearing in Preview tab
**Check:**
- Is screenshot in S3? `aws s3 ls s3://market-dashboard-csv-data/hedgeye-screenshots/`
- Is S3 key in DynamoDB? Check `HedgeyeDailySnapshot` table
- Is backend endpoint working? Test `/api/hedgeye/screenshot/:date`
- Is date format correct? Should be `YYYY-MM-DD`

### Issue: S3 upload fails
**Check:**
- AWS credentials: `aws configure list`
- S3 bucket permissions: User needs `s3:PutObject` on bucket
- Bucket name: Should be `market-dashboard-csv-data`
- Region: Should be `us-west-1`

### Issue: Presigned URL doesn't work
**Check:**
- Backend server is running
- S3 bucket CORS configuration (if needed)
- URL expiration (1 hour)

### Issue: CSV not downloading
**Check:**
- CSV exists in S3: `aws s3 ls s3://market-dashboard-csv-data/hedgeye-exports/`
- CSV S3 key in DynamoDB
- Presigned URL endpoint works

## Quick Test Command

**Run all checks at once:**
```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda

# 1. Test scraper (dry run - check if it would work)
python3 hedgeye_local_scraper.py --check

# 2. Check S3 access
aws s3 ls s3://market-dashboard-csv-data/hedgeye-screenshots/ 2>&1

# 3. Test backend endpoint
DATE=$(date +%Y-%m-%d)
curl -s http://localhost:3001/api/hedgeye/screenshot/$DATE | jq .

# 4. Check LaunchAgent
./manage_scraper.sh status
```

## Next Steps After Testing

Once everything works:
1. ✅ Screenshot capture verified
2. ✅ S3 upload verified  
3. ✅ Backend endpoints verified
4. ✅ Frontend Preview tab verified
5. ✅ LaunchAgent scheduled correctly

**Then:**
- Wait for next scheduled run (8:00 AM EST) OR
- Manually trigger: `./manage_scraper.sh run`
- Check Preview tab in dashboard after scrape completes

