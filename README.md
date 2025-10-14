# Market Dashboard - AWS Serverless Portfolio Tracker

A fully automated portfolio tracking system that processes Schwab CSV exports and displays real-time portfolio data using AWS serverless architecture.

## 🚀 **Current Status: AWS BACKEND WORKING** (October 10, 2025)

### ✅ **What's Working:**
- **AWS Lambda Function**: Processes Schwab CSV files automatically ✅
- **DynamoDB Storage**: Stores portfolio snapshots and holdings data ✅
- **S3 Integration**: Automatic file processing on upload ✅
- **Daily Portfolio Replacement**: Clears old data, stores fresh daily data ✅
- **React Frontend**: Dashboard interface running locally ✅
- **Express Backend**: Fetches portfolio data from DynamoDB via API ✅

### 🔧 **Current Task:**
- **CSV Upload Button**: Implementing browser-based upload with presigned S3 URLs
- **Fetch Error Debugging**: Troubleshooting presigned URL endpoint communication
- **Next Step**: Fix fetch error and complete end-to-end CSV upload flow

## 🏗️ **Architecture**

```
Schwab CSV → S3 Upload → Lambda Process → DynamoDB → API Gateway → React Dashboard
```

### **AWS Services:**
- **S3**: CSV file storage and triggers
- **Lambda**: CSV processing and data transformation  
- **DynamoDB**: Portfolio data storage (3 tables)
- **IAM**: Security and permissions
- **CloudWatch**: Logging and monitoring

## 📊 **Data Flow**

1. **Upload Schwab CSV** to S3 bucket (`market-dashboard-csv-data/uploads/`)
2. **Lambda triggers automatically** and processes the file
3. **Data stored in DynamoDB** (PortfolioSnapshots, Holdings, ProcessingLogs)
4. **Daily replacement logic** clears old holdings, stores new ones
5. **Frontend displays** real portfolio data (when API Gateway connected)

## 🛠️ **Setup Status**

### **Completed:**
- ✅ DynamoDB tables created with correct schemas
- ✅ Lambda function deployed with CSV processing
- ✅ S3 trigger configured for automatic processing
- ✅ IAM permissions configured
- ✅ Daily portfolio replacement logic implemented
- ✅ React frontend running locally
- ✅ Test data processing working (5 test holdings)

### **In Progress:**
- 🔧 CSV parser debugging (Schwab format issues)
- 🔧 Real Schwab data parsing (32 holdings showing zeros)
- 🔧 API Gateway setup (for frontend data access)

### **Next Steps:**
- 🔧 Fix Schwab CSV column name mapping
- 🔧 Deploy updated parser
- 🔧 Test with real Schwab data
- 🔧 Set up API Gateway
- 🔧 Connect frontend to AWS data

## 📁 **Project Structure**

```
├── aws/                    # AWS infrastructure
│   ├── lambda/             # Lambda function code
│   ├── dynamodb/           # Table creation scripts
│   ├── iam/                # IAM policies and guides
│   └── README.md           # AWS setup documentation
├── src/                    # React frontend
│   ├── components/         # Dashboard components
│   ├── services/           # API services
│   └── hooks/               # Custom React hooks
└── README.md              # This file
```

## 🚀 **Quick Start**

### **For Development:**
```bash
npm install
npm start
```

### **For AWS Setup:**
See `aws/README.md` for complete AWS infrastructure setup.

## 📋 **Current Task Details**

**Task**: Implement CSV upload button on website
**Status**: Lambda/S3/DynamoDB pipeline is WORKING - now connecting frontend
**Component**: `CSVUpload.jsx` - Drag-and-drop upload with presigned URLs
**Backend**: Express endpoint `/api/presigned-url` generates secure S3 upload URLs
**Issue**: Investigating fetch error between frontend and backend
**Goal**: Enable users to upload CSVs directly from dashboard

## 💰 **Cost Estimate**
- **Lambda**: ~$0.10/month
- **DynamoDB**: ~$1.50/month  
- **S3**: ~$0.50/month
- **Total**: ~$2/month for automated portfolio tracking

## 🎯 **Next Steps**
1. ✅ ~~Deploy updated CSV parser~~ (COMPLETED)
2. ✅ ~~Test with real Schwab data~~ (COMPLETED)
3. 🔧 Fix fetch error in CSV upload button
4. 🔧 Test end-to-end CSV upload from dashboard
5. ⏳ Optional: Set up API Gateway (currently using Express backend)