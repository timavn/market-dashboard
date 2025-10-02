# TODO - Next Session Tasks

## 🎯 **Immediate Next Steps (Lambda Configuration)**

### **Step 1: Change Lambda Runtime**
- [ ] Go to Lambda function `CSVPortfolioProcessor`
- [ ] Click "Edit" in "Runtime settings"
- [ ] Change Runtime to **Python 3.9**
- [ ] Change Handler to **lambda_function.lambda_handler**
- [ ] Click "Save"

### **Step 2: Configure Memory and Timeout**
- [ ] Go to "Configuration" tab
- [ ] Click "Edit" in "General configuration"
- [ ] Set Memory to **512 MB**
- [ ] Set Timeout to **5 minutes**
- [ ] Click "Save"

### **Step 3: Add IAM Permissions**
- [ ] In "Configuration" tab, click on Role name
- [ ] Add policy: `AmazonS3ReadOnlyAccess`
- [ ] Add policy: `AmazonDynamoDBFullAccess`
- [ ] Verify permissions are attached

## 🚀 **After Lambda Configuration**

### **Step 4: Write Python Code**
- [ ] Create CSV processing logic for Schwab data
- [ ] Add S3 file reading functionality
- [ ] Add DynamoDB writing functionality
- [ ] Add error handling and logging

### **Step 5: Configure S3 Trigger**
- [ ] Add S3 trigger to Lambda function
- [ ] Configure for CSV file uploads
- [ ] Test trigger with sample file

### **Step 6: Test Complete Pipeline**
- [ ] Upload sample Schwab CSV
- [ ] Verify data processing
- [ ] Check DynamoDB tables
- [ ] Test error scenarios

## 📊 **Current AWS Infrastructure Status**

### ✅ **Completed:**
- DynamoDB Tables: PortfolioSnapshots, Holdings, ProcessingLogs
- S3 Bucket: CSV data storage
- Lambda Function: CSVPortfolioProcessor (created, needs config)
- GitHub Secrets: AWS credentials configured

### ⏳ **Pending:**
- Lambda runtime configuration (Python 3.9)
- Lambda memory/timeout settings
- IAM permissions for S3/DynamoDB
- Python CSV processing code
- S3 trigger configuration
- API Gateway setup

## 🔧 **Technical Details**

### **Lambda Function Requirements:**
- **Runtime**: Python 3.9
- **Memory**: 512 MB
- **Timeout**: 5 minutes
- **Handler**: lambda_function.lambda_handler
- **Permissions**: S3 read, DynamoDB write

### **DynamoDB Tables:**
- **PortfolioSnapshots**: Historical portfolio data
- **Holdings**: Current positions and transactions
- **ProcessingLogs**: CSV processing status and errors

### **S3 Bucket Structure:**
```
csv-data-bucket/
├── raw-csv/           # Original CSV uploads
├── processed/         # Cleaned/validated data
└── snapshots/         # Historical snapshots
```

## 🎯 **Success Criteria**
- [ ] Lambda processes CSV files automatically
- [ ] Data is stored in DynamoDB correctly
- [ ] Error handling works properly
- [ ] Dashboard can read data from DynamoDB
- [ ] Complete end-to-end pipeline functional
