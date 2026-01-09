# Getting Started: Risk Range Scraper Preview

## ✅ Current Status

All prerequisites are met and verified:
- ✅ AWS credentials configured
- ✅ boto3 installed (v1.40.46)
- ✅ Playwright available
- ✅ S3 bucket accessible
- ✅ Backend server running (port 3001)
- ✅ Frontend running (port 3000)
- ✅ Screenshot capture code implemented
- ✅ CSV export code implemented
- ✅ Backend API endpoints implemented
- ✅ Frontend Preview tab implemented

## 🚀 Next Steps to Get It Working

### Option 1: Test Immediately (Recommended)

**Run the scraper manually to generate your first screenshot:**

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
python3 hedgeye_local_scraper.py --scrape --chrome
```

**What will happen:**
1. Scraper launches Chrome with your profile
2. Navigates to Hedgeye risk range page
3. Captures full-page screenshot
4. Uploads screenshot to S3: `market-dashboard-csv-data/hedgeye-screenshots/YYYY-MM-DD/`
5. Exports CSV: `hedgeye_risk_ranges_YYYY-MM-DD.csv`
6. Uploads CSV to S3 (optional): `market-dashboard-csv-data/hedgeye-exports/`
7. Stores S3 keys in DynamoDB

**Then view in dashboard:**
1. Open: http://localhost:3000
2. Click **Service Tracking** button (bottom right)
3. Click **Preview** tab
4. See screenshot and extracted data side-by-side!

### Option 2: Wait for Scheduled Run

The scraper is already scheduled to run daily at **8:00 AM EST** on market days.

**Check schedule:**
```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
./manage_scraper.sh status
```

**Manually trigger a run:**
```bash
./manage_scraper.sh run
```

## 🔍 Verification Steps

After running the scraper, verify everything worked:

### 1. Check S3 for Screenshot
```bash
aws s3 ls s3://market-dashboard-csv-data/hedgeye-screenshots/ --recursive
```

You should see:
```
hedgeye-screenshots/2025-01-15/risk-ranges-2025-01-15-080000.png
```

### 2. Check S3 for CSV
```bash
aws s3 ls s3://market-dashboard-csv-data/hedgeye-exports/ --recursive
```

You should see:
```
hedgeye-exports/risk-ranges-2025-01-15.csv
```

### 3. Check DynamoDB
```bash
aws dynamodb get-item \
  --table-name HedgeyeDailySnapshot \
  --key '{"date":{"S":"2025-01-15"},"snapshotType":{"S":"risk-ranges"}}' \
  --region us-west-1 | grep screenshotS3Key
```

Should show `screenshotS3Key` and `csvS3Key` fields.

### 4. Test Backend Endpoint
```bash
DATE=$(date +%Y-%m-%d)
curl http://localhost:3001/api/hedgeye/screenshot/$DATE
```

Should return JSON with presigned URL:
```json
{
  "url": "https://market-dashboard-csv-data.s3.amazonaws.com/...",
  "s3Key": "hedgeye-screenshots/2025-01-15/...",
  "date": "2025-01-15",
  "scrapedAt": "2025-01-15T08:00:00Z"
}
```

### 5. View in Dashboard
1. Open http://localhost:3000
2. Click **Service Tracking** (bottom right)
3. Click **Preview** tab
4. Screenshot should appear on left, data table on right

## 🐛 Troubleshooting

### Screenshot Not Appearing in Dashboard

**Check:**
1. Is screenshot in S3? Run: `aws s3 ls s3://market-dashboard-csv-data/hedgeye-screenshots/ --recursive`
2. Is S3 key in DynamoDB? Check `HedgeyeDailySnapshot` table
3. Is date correct? Preview tab uses date from `lastRun` timestamp
4. Check browser console for errors (F12 → Console)

### S3 Upload Fails

**Check:**
1. AWS credentials: `aws configure list`
2. S3 permissions: User needs `s3:PutObject` permission
3. Bucket name: Must be `market-dashboard-csv-data`
4. Region: Must be `us-west-1`

### Backend Endpoint Returns 404

**This is normal if:**
- No scrape has run yet for today's date
- Scrape ran but screenshot upload failed

**Fix:**
- Run scraper manually to generate screenshot
- Check scraper logs for S3 upload errors

### Preview Tab Shows "No Screenshot Available"

**This is normal if:**
- Scraper hasn't run yet
- Scraper ran but screenshot capture failed

**Fix:**
- Run scraper: `python3 hedgeye_local_scraper.py --scrape --chrome`
- Check scraper output for screenshot capture messages

## 📋 Quick Reference

**Run scraper manually:**
```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
python3 hedgeye_local_scraper.py --scrape --chrome
```

**Check scraper status:**
```bash
./manage_scraper.sh status
```

**View logs:**
```bash
./manage_scraper.sh logs
```

**Test everything:**
```bash
./test_preview_functionality.sh
```

**View dashboard:**
- Frontend: http://localhost:3000
- Backend API: http://localhost:3001

## 🎯 What Happens Next

Once you run the scraper:

1. **Screenshot captured** → Saved locally and uploaded to S3
2. **CSV exported** → Saved locally and uploaded to S3  
3. **DynamoDB updated** → S3 keys stored in snapshot record
4. **Dashboard ready** → Preview tab can display screenshot and data

**Daily automated runs:**
- Scraper runs at 8:00 AM EST on market days
- Screenshot and CSV generated automatically
- Available in dashboard Preview tab immediately after

## 📚 Additional Resources

- **Testing Checklist**: `TESTING_CHECKLIST.md`
- **Scraper Setup**: `SCRAPER_SETUP.md`
- **LaunchAgent Guide**: `HEDGEYE_LOCAL_SCRAPER_README.md`


