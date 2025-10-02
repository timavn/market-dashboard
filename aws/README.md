# AWS Infrastructure Directory

## 🚀 **Today's Updates (October 1, 2025)**

### ✅ **Architecture Planning:**
- **Serverless Design**: Complete AWS serverless architecture planned
- **Services Identified**: S3, DynamoDB, Lambda, API Gateway, IAM
- **Data Flow**: CSV → S3 → Lambda → DynamoDB → API → Dashboard
- **Security**: IAM roles and permissions structure defined

### ✅ **AWS Infrastructure Created:**
- **DynamoDB Tables**: PortfolioSnapshots, Holdings, ProcessingLogs created
- **S3 Bucket**: CSV data storage bucket created
- **Lambda Function**: CSVPortfolioProcessor created (needs configuration)
- **AWS Credentials**: GitHub Secrets configured for CI/CD

### 🎯 **Tomorrow's Tasks:**
- **Lambda Configuration**: Change runtime to Python 3.9, set memory/timeout
- **IAM Permissions**: Add S3 and DynamoDB access to Lambda role
- **Python Code**: Write CSV processing logic for Schwab data
- **S3 Trigger**: Configure automatic processing on CSV upload
- **API Gateway**: Set up REST API endpoints for dashboard

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
