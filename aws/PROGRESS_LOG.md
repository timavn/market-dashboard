# AWS Integration Progress Log

Detailed day-by-day log of the Schwab portfolio integration development.

---

## October 3, 2025

### Session Goals
- Complete Lambda function deployment
- Configure IAM permissions
- Set up S3 trigger
- Test CSV processing pipeline

### Morning: Frontend Stabilization
**Issue:** Options data was updating so rapidly the UI was unreadable.

**Actions:**
1. Disabled auto-refresh in `useMarketData.js` hook (VIX 30s interval)
2. Disabled portfolio data fetching in `PortfolioDashboard.jsx`
3. Kept `enableRealtime: false` for market data
4. Cleaned up unused state variables (setPortfolioData, setError, vixLoading)

**Result:** UI now stable, ready to focus on AWS integration.

### Afternoon: IAM Permissions Setup
**Actions:**
1. Created inline policy `CSVProcessorPolicy` for Lambda execution role
2. Granted permissions:
   - S3: `GetObject`, `ListBucket` on `market-dashboard-csv-data` bucket
   - DynamoDB: `PutItem`, `BatchWriteItem`, `GetItem`, `Query` on 3 tables
   - CloudWatch: `CreateLogGroup`, `CreateLogStream`, `PutLogEvents`
3. Attached policy to `CSVPortfolioProcessor-role` execution role

**Files Created:**
- `aws/iam/lambda-execution-role-policy.json` - Full IAM policy template
- `aws/iam/trust-policy.json` - Lambda trust relationship
- `aws/iam/IAM_SETUP_GUIDE.md` - Detailed step-by-step guide
- `aws/iam/QUICK_START.md` - 5-minute quick reference

**Result:** ✅ Lambda has necessary permissions for S3 read and DynamoDB write.

### Afternoon: Lambda Function Development
**Actions:**
1. Wrote complete Python CSV processor (`csv_processor.py`):
   - Schwab CSV parsing (mirrors frontend `csvParser.js` logic)
   - DynamoDB integration for 3 tables
   - Error handling and logging
   - S3 file download and processing

2. Configured Lambda settings:
   - Runtime: Python 3.9
   - Handler: `csv_processor.lambda_handler`
   - Memory: 512 MB
   - Timeout: 30 seconds
   - Environment variables: PORTFOLIO_TABLE, HOLDINGS_TABLE, LOGS_TABLE

3. Created deployment package:
   ```bash
   cd aws/lambda
   zip csv_processor.zip csv_processor.py
   ```

**Files Created:**
- `aws/lambda/csv_processor.py` - Main Lambda function
- `aws/lambda/requirements.txt` - Python dependencies (boto3)
- `aws/lambda/DEPLOYMENT_GUIDE.md` - Deployment instructions
- `aws/lambda/README.md` - Lambda documentation

**Result:** ✅ Lambda code uploaded and configured.

### Evening: S3 Trigger Configuration
**Actions:**
1. Added S3 trigger to Lambda:
   - Bucket: `market-dashboard-csv-data`
   - Event type: PUT
   - Prefix: `uploads/`
   - Suffix: `.csv`
2. Created test infrastructure:
   - Generated `test-portfolio.csv` with 5 sample holdings
   - Created Lambda test event with proper S3 event structure

**Files Created:**
- `aws/S3_TRIGGER_SETUP.md` - S3 trigger setup guide
- `test-portfolio.csv` - Sample CSV for testing (AAPL, MSFT, SPY, QQQ, TSLA)

**Result:** ✅ S3 trigger configured and ready to test.

### Evening: Debugging Session
**Issues Encountered & Fixed:**

#### Issue 1: DynamoDB ValidationException - Float Types
**Error:** `ValidationException when calling BatchWriteItem`
**Root Cause:** DynamoDB requires `Decimal` type, but code was using `float`
**Fix:** Changed `parse_number()` to return `Decimal` instead of `float`
**Files Modified:** `csv_processor.py` lines 149-164

#### Issue 2: ProcessingLogs Table Key Mismatch
**Error:** `Type mismatch for key logId`
**Root Cause:** Code used `processingId` but table expects `logId`
**Fix:** Updated `log_processing()` function to use correct key name
**Files Modified:** `csv_processor.py` lines 217-240

#### Issue 3: Holdings Table Key Mismatch
**Error:** `Provided key element does not match the schema`
**Root Cause:** Holdings table expects `holdingId` partition key only
**Fix:** Created composite key `snapshotId#symbol` as `holdingId`
**Files Modified:** `csv_processor.py` lines 201-218

#### Issue 4: Python Variable Scope
**Error:** `local variable 'bucket' referenced before assignment`
**Root Cause:** `bucket` and `key` defined in try block, used in except block
**Fix:** Initialize `bucket = None` and `key = None` before try block
**Files Modified:** `csv_processor.py` lines 17-59

#### Issue 5: Test Event Malformed
**Error:** `Error processing CSV: 'Records'`
**Root Cause:** Test event had generic placeholder JSON, not S3 event structure
**Fix:** Created proper S3 PUT event structure with correct bucket/key
**Result:** Test event saved and ready for execution

### Test Status
**Ready to Execute:**
- Lambda test event configured with S3 structure
- Test CSV uploaded to `s3://market-dashboard-csv-data/uploads/test-portfolio.csv`
- All code fixes applied and deployed

**Next Action:** Run test event in Lambda console (Test tab → Test button)

### Time Invested
- Frontend fixes: 30 minutes
- IAM setup: 45 minutes
- Lambda development: 2 hours
- Debugging: 3 hours
- Documentation: 1 hour
**Total:** ~7 hours

---

## October 1, 2025

### Session Goals
- Set up development environment
- Deploy initial React application
- Plan AWS architecture
- Create AWS infrastructure

### Completed
1. **Development Environment**
   - Installed Node.js 18.20.8 via nvm
   - Installed all npm dependencies
   - Verified development server runs (localhost:3000)
   - Verified production build succeeds

2. **AWS Architecture Planning**
   - Designed serverless CSV processing pipeline
   - Identified required AWS services (S3, DynamoDB, Lambda, API Gateway)
   - Planned data flow: CSV → S3 → Lambda → DynamoDB → API → Dashboard
   - Documented security requirements (IAM roles, policies)

3. **AWS Infrastructure Creation**
   - Created DynamoDB tables:
     - `PortfolioSnapshots` (partition: snapshotId, sort: timestamp)
     - `Holdings` (partition: holdingId)
     - `ProcessingLogs` (partition: logId)
   - Created S3 bucket: `market-dashboard-csv-data`
   - Created Lambda function shell: `CSVPortfolioProcessor`
   - Configured GitHub Secrets for CI/CD

4. **Frontend Preparation**
   - Zeroed out portfolio display values
   - Prepared UI for AWS data integration
   - Kept existing CSV parser logic for reference

### Files Created
- `deploy/aws-s3-setup.md` - S3 static hosting guide
- `deploy/aws-cloudfront-setup.md` - CloudFront CDN setup
- `deploy/deployment-checklist.md` - Deployment steps
- `aws/README.md` - AWS infrastructure documentation

### Time Invested
~4 hours

---

## Current Status (October 10, 2025)

### ✅ COMPLETED:
1. **Lambda Test Event** - WORKING
   - Lambda successfully processes CSV files
   - CloudWatch logs show successful executions
   - All error handling working correctly

2. **DynamoDB Data Verification** - WORKING
   - PortfolioSnapshots storing daily snapshots
   - Holdings storing individual positions
   - ProcessingLogs tracking all uploads

3. **Real Schwab CSV Testing** - WORKING
   - Real Schwab data parsing successfully
   - 30+ holdings processed correctly
   - Daily replacement logic working

4. **Backend API Development** - WORKING
   - Express server fetching from DynamoDB
   - `/api/portfolio` endpoint returns real data
   - `/api/presigned-url` generates S3 upload URLs
   - CORS configured for frontend access

### 🔧 IN PROGRESS:
5. **CSV Upload Button Implementation**
   - Created `CSVUpload.jsx` component
   - Drag-and-drop functionality implemented
   - Presigned URL upload flow configured
   - **Current Issue**: Investigating fetch error

### ⏳ NEXT STEPS:
6. **Fix Fetch Error**
   - Debug communication between frontend and backend
   - Verify backend server is running
   - Test presigned URL generation
   - Complete end-to-end upload flow

7. **Production Testing** (After fetch fix)
   - Test CSV upload from dashboard
   - Verify automatic Lambda processing
   - Confirm data appears in dashboard
   - Test error handling

8. **Optional Enhancements** (Future)
   - API Gateway (currently using Express backend)
   - Historical snapshot comparison
   - Portfolio performance charts
   - Multi-user support with authentication

---

## Issues & Lessons Learned

### DynamoDB Gotchas
- **Type Safety**: DynamoDB requires `Decimal` for numbers, not `float` or `int`
- **Schema Matching**: Partition/sort keys must match table schema exactly
- **Composite Keys**: Use delimiter pattern (e.g., `snapshotId#symbol`) for composite IDs

### Lambda Debugging
- **CloudWatch Logs**: Essential for debugging - check logs first
- **Test Events**: Create realistic test events early to catch issues
- **Variable Scope**: Be careful with try/except blocks and variable initialization
- **Decimal Import**: Always import `from decimal import Decimal` for DynamoDB

### Development Workflow
- **Region Awareness**: Always verify correct AWS region (us-west-1)
- **Incremental Testing**: Test each component before integration
- **Documentation as You Go**: Write guides while memory is fresh
- **Error Messages**: DynamoDB errors are often vague - check table schemas first

### Time Estimates
- Initial estimates were optimistic (20-30 min actual vs 5 min estimated)
- Debugging took 3x longer than development
- Documentation should be ~20% of development time

---

## Resources Created

### Documentation
- 3 IAM setup guides
- 2 Lambda deployment guides
- 1 S3 trigger guide
- 1 Complete setup checklist
- This progress log

### Code
- 1 Python Lambda function (237 lines)
- 1 Test CSV file
- 1 Lambda test event
- Multiple IAM policy templates

### AWS Resources
- 3 DynamoDB tables
- 1 S3 bucket
- 1 Lambda function
- 1 IAM inline policy
- 1 S3 trigger

**Total Lines of Code:** ~250 lines Python
**Total Documentation:** ~2,000 lines markdown
**Total AWS Resources:** 7 resources configured
