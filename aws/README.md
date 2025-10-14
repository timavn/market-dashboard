# AWS Infrastructure Directory

## 🚀 **Recent Updates**

### **October 6, 2025** ✅
**Lambda Function Deployment:**
- ✅ Python 3.9 runtime configured
- ✅ Memory: 512 MB, Timeout: 30 seconds
- ✅ Handler: `csv_processor.lambda_handler`
- ✅ Code deployed: Complete Schwab CSV parser with DynamoDB integration
- ✅ Environment variables configured (PORTFOLIO_TABLE, HOLDINGS_TABLE, LOGS_TABLE)

**IAM Security:**
- ✅ Inline policy created: `CSVProcessorPolicy`
- ✅ Permissions: S3 GetObject/ListBucket, DynamoDB PutItem/BatchWriteItem, CloudWatch Logs
- ✅ Bucket: `market-dashboard-csv-data`

**S3 Integration:**
- ✅ S3 trigger configured for PUT events
- ✅ Event filter: `uploads/*.csv`
- ✅ Bucket: `market-dashboard-csv-data`

**Testing:**
- ✅ Test CSV created with 5 sample holdings
- ✅ Lambda test event configured with proper S3 event structure
- ✅ **FINAL EXECUTION TEST COMPLETED** - Lambda processing working
- ✅ **Real Schwab CSV tested** - 32 holdings detected, parser needs debugging

**Code Fixes Applied:**
- ✅ DynamoDB Decimal type handling
- ✅ Holdings table `holdingId` composite key (snapshotId#symbol)
- ✅ ProcessingLogs table `logId` key
- ✅ Python variable scope in error handlers
- ✅ **Daily portfolio replacement logic** - clears old holdings before storing new ones
- ✅ **Schwab CSV format debugging** - updated parser for exact column names

### **October 1, 2025** ✅
**Architecture Planning:**
- ✅ Serverless Design: Complete AWS serverless architecture planned
- ✅ Services Identified: S3, DynamoDB, Lambda, API Gateway, IAM
- ✅ Data Flow: CSV → S3 → Lambda → DynamoDB → API → Dashboard
- ✅ Security: IAM roles and permissions structure defined

**AWS Infrastructure Created:**
- ✅ DynamoDB Tables: PortfolioSnapshots, Holdings, ProcessingLogs
- ✅ S3 Bucket: `market-dashboard-csv-data`
- ✅ Lambda Function: CSVPortfolioProcessor (shell)
- ✅ AWS Credentials: GitHub Secrets configured for CI/CD

### 🎯 **Next Steps:**
- **CSV Parser Fix**: Deploy updated parser with exact Schwab column names
- **Real Data Testing**: Test with actual Schwab CSV to verify parsing
- **API Gateway**: Set up REST API endpoints for dashboard data access
- **Frontend Connection**: Update React app to fetch from API Gateway
- **End-to-End Testing**: Complete pipeline testing with real portfolio data

## 📊 **Planned AWS Services**

### **Storage:**
- **S3**: CSV file storage and static website hosting
- **DynamoDB**: Portfolio data and snapshots

### **Compute:**
- **Lambda**: CSV processing and data transformation
- **API Gateway**: REST API for dashboard data

### **Security:**
- **IAM**: Roles and permissions for services
- **CloudWatch**: Monitoring and logging

## 🏗️ **Infrastructure as Code**
- CloudFormation templates for infrastructure
- Lambda deployment packages
- IAM policies and roles
- S3 bucket configurations
