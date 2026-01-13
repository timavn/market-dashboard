# Hedgeye PDF Processor - Lambda Deployment Guide

Complete guide to deploying the Hedgeye PDF processor as an AWS Lambda function with S3 trigger.

## Overview

**Goal**: Automatically process Hedgeye PDFs when uploaded to S3 `hedgeye/` folder

**Architecture**:
```
User uploads PDF to S3
    ↓
S3 PUT event (hedgeye/*.pdf)
    ↓
Lambda: hedgeye_pdf_processor
    ↓
AWS Textract (table extraction)
    ↓
DynamoDB: HedgeyeDailySnapshot
```

**Cost**: ~$0.50/month (Lambda invocations within free tier, Textract ~$2.25/month)

---

## Prerequisites

1. AWS CLI configured with credentials
2. Existing S3 bucket: `market-dashboard-csv-data`
3. Existing DynamoDB table: `HedgeyeDailySnapshot`
4. Python 3.9+ locally for packaging

---

## Step 1: Create Lambda Layer for Poppler

Poppler is a binary dependency needed by `pdf2image` to convert PDFs to images.

### Option A: Use Pre-built Layer (Recommended)

Search for "poppler" in AWS Lambda Layers public repository:
- https://github.com/shelfio/aws-lambda-poppler-layer

**For `us-west-1` region:**
```bash
# Add the public layer ARN
arn:aws:lambda:us-west-1:764866452798:layer:poppler:1
```

### Option B: Build Your Own Layer

```bash
# Create layer directory
mkdir -p lambda-layers/poppler/bin

# Download poppler binaries for Amazon Linux 2
# Use Docker to build for correct architecture
docker run --rm -v "$PWD/lambda-layers/poppler":/out amazonlinux:2 bash -c "
  yum install -y poppler-utils
  cp /usr/bin/pdftoppm /out/bin/
  cp /usr/bin/pdfinfo /out/bin/
"

# Package layer
cd lambda-layers/poppler
zip -r ../poppler-layer.zip .
cd ../..

# Upload layer to AWS
aws lambda publish-layer-version \
  --layer-name poppler-utils \
  --description "Poppler utilities for pdf2image" \
  --zip-file fileb://lambda-layers/poppler-layer.zip \
  --compatible-runtimes python3.9 python3.10 python3.11 \
  --region us-west-1
```

---

## Step 2: Create Lambda Layer for Python Dependencies

Package all Python dependencies into a Lambda layer.

```bash
# Navigate to lambda directory
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda

# Create layer directory
mkdir -p lambda-layers/python-deps/python

# Install dependencies
pip3 install \
  pdfplumber \
  pdf2image \
  PyPDF2 \
  Pillow \
  -t lambda-layers/python-deps/python

# Package layer
cd lambda-layers/python-deps
zip -r ../python-deps-layer.zip .
cd ../..

# Upload layer to AWS
aws lambda publish-layer-version \
  --layer-name hedgeye-pdf-processor-deps \
  --description "Python dependencies for Hedgeye PDF processor" \
  --zip-file fileb://lambda-layers/python-deps-layer.zip \
  --compatible-runtimes python3.9 \
  --region us-west-1
```

**Expected output:**
```json
{
    "LayerArn": "arn:aws:lambda:us-west-1:YOUR_ACCOUNT_ID:layer:hedgeye-pdf-processor-deps",
    "LayerVersionArn": "arn:aws:lambda:us-west-1:YOUR_ACCOUNT_ID:layer:hedgeye-pdf-processor-deps:1",
    "Version": 1
}
```

**Save the LayerVersionArn** - you'll need it for Step 4.

---

## Step 3: Package Lambda Function Code

Create a deployment package with all parser modules.

```bash
# Create deployment directory
mkdir -p lambda-deployment
cd lambda-deployment

# Copy all required Python files
cp ../hedgeye_pdf_processor_lambda.py lambda_function.py
cp ../date_utils.py .
cp ../parse_bitcoin_tracker.py .
cp ../parse_early_look.py .
cp ../parse_portfolio_solutions.py .
cp ../parse_momo_tracker.py .
cp ../parse_signal_strength.py .

# Create deployment package
zip -r hedgeye_pdf_processor.zip *.py

# Upload to S3 (optional, for large packages)
aws s3 cp hedgeye_pdf_processor.zip s3://market-dashboard-csv-data/lambda-deployments/

cd ..
```

---

## Step 4: Create IAM Role for Lambda

The Lambda function needs permissions for:
- S3: Read PDFs from bucket
- DynamoDB: Write to HedgeyeDailySnapshot
- Textract: Analyze documents
- CloudWatch: Write logs

```bash
# Create trust policy for Lambda
cat > lambda-trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "lambda.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF

# Create IAM role
aws iam create-role \
  --role-name hedgeye-pdf-processor-role \
  --assume-role-policy-document file://lambda-trust-policy.json

# Create policy document
cat > hedgeye-processor-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::market-dashboard-csv-data",
        "arn:aws:s3:::market-dashboard-csv-data/hedgeye/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:GetItem"
      ],
      "Resource": "arn:aws:dynamodb:us-west-1:*:table/HedgeyeDailySnapshot"
    },
    {
      "Effect": "Allow",
      "Action": [
        "textract:AnalyzeDocument",
        "textract:DetectDocumentText"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:us-west-1:*:*"
    }
  ]
}
EOF

# Attach policy to role
aws iam put-role-policy \
  --role-name hedgeye-pdf-processor-role \
  --policy-name HedgeyePDFProcessorPolicy \
  --policy-document file://hedgeye-processor-policy.json

# Clean up policy files
rm lambda-trust-policy.json hedgeye-processor-policy.json
```

---

## Step 5: Create Lambda Function

```bash
# Create Lambda function
aws lambda create-function \
  --function-name hedgeye-pdf-processor \
  --runtime python3.9 \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/hedgeye-pdf-processor-role \
  --handler lambda_function.lambda_handler \
  --zip-file fileb://lambda-deployment/hedgeye_pdf_processor.zip \
  --timeout 120 \
  --memory-size 1024 \
  --region us-west-1 \
  --layers \
    arn:aws:lambda:us-west-1:YOUR_ACCOUNT_ID:layer:hedgeye-pdf-processor-deps:1 \
    arn:aws:lambda:us-west-1:764866452798:layer:poppler:1

# Expected output:
# {
#     "FunctionName": "hedgeye-pdf-processor",
#     "FunctionArn": "arn:aws:lambda:us-west-1:YOUR_ACCOUNT_ID:function:hedgeye-pdf-processor",
#     "Runtime": "python3.9",
#     "Handler": "lambda_function.lambda_handler",
#     "State": "Active"
# }
```

**Replace `YOUR_ACCOUNT_ID` with your AWS account ID.**

**Configuration Notes**:
- **Timeout**: 120 seconds (2 minutes) - Textract API can be slow
- **Memory**: 1024 MB - PDF processing is memory-intensive
- **Layers**: Python deps + Poppler binaries

---

## Step 6: Configure S3 Trigger

Grant S3 permission to invoke Lambda, then create the trigger.

```bash
# Add S3 invoke permission to Lambda
aws lambda add-permission \
  --function-name hedgeye-pdf-processor \
  --statement-id s3-trigger-hedgeye \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn arn:aws:s3:::market-dashboard-csv-data \
  --region us-west-1

# Create S3 event notification configuration
cat > s3-notification.json <<EOF
{
  "LambdaFunctionConfigurations": [
    {
      "Id": "hedgeye-pdf-processing",
      "LambdaFunctionArn": "arn:aws:lambda:us-west-1:YOUR_ACCOUNT_ID:function:hedgeye-pdf-processor",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [
            {"Name": "prefix", "Value": "hedgeye/"},
            {"Name": "suffix", "Value": ".pdf"}
          ]
        }
      }
    }
  ]
}
EOF

# Apply notification configuration
aws s3api put-bucket-notification-configuration \
  --bucket market-dashboard-csv-data \
  --notification-configuration file://s3-notification.json

# Clean up
rm s3-notification.json
```

**Important**: This replaces any existing S3 event configurations. If you already have triggers (like the `uploads/*.csv` trigger), you need to include both in the JSON.

**To preserve existing triggers**:
```bash
# Get current configuration
aws s3api get-bucket-notification-configuration \
  --bucket market-dashboard-csv-data > current-notifications.json

# Edit current-notifications.json to add the new Lambda configuration
# Then apply:
aws s3api put-bucket-notification-configuration \
  --bucket market-dashboard-csv-data \
  --notification-configuration file://current-notifications.json
```

---

## Step 7: Test the Lambda Function

### Test 1: Manual Lambda Invocation

Create a test event that simulates an S3 PUT event:

```bash
cat > test-event.json <<EOF
{
  "Records": [
    {
      "eventVersion": "2.1",
      "eventSource": "aws:s3",
      "awsRegion": "us-west-1",
      "eventTime": "2026-01-10T12:00:00.000Z",
      "eventName": "ObjectCreated:Put",
      "s3": {
        "bucket": {
          "name": "market-dashboard-csv-data"
        },
        "object": {
          "key": "hedgeye/bitcoin-tracker-2026-01-09.pdf"
        }
      }
    }
  ]
}
EOF

# Invoke Lambda
aws lambda invoke \
  --function-name hedgeye-pdf-processor \
  --payload file://test-event.json \
  --region us-west-1 \
  response.json

# Check response
cat response.json
```

### Test 2: Upload a Real PDF

```bash
# Upload a test PDF from your local machine
aws s3 cp ~/Desktop/hedgeye/bitcoin-tracker-2026-01-09.pdf \
  s3://market-dashboard-csv-data/hedgeye/

# Wait 5 seconds for Lambda to process

# Check CloudWatch logs
aws logs tail /aws/lambda/hedgeye-pdf-processor --follow
```

### Test 3: Verify DynamoDB Data

```bash
# Query HedgeyeDailySnapshot for the uploaded date
aws dynamodb query \
  --table-name HedgeyeDailySnapshot \
  --key-condition-expression "#d = :date" \
  --expression-attribute-names '{"#d":"date"}' \
  --expression-attribute-values '{":date":{"S":"2026-01-09"}}' \
  --region us-west-1
```

---

## Step 8: Monitor and Debug

### View CloudWatch Logs

```bash
# Stream logs in real-time
aws logs tail /aws/lambda/hedgeye-pdf-processor --follow

# Search for errors
aws logs filter-log-events \
  --log-group-name /aws/lambda/hedgeye-pdf-processor \
  --filter-pattern "ERROR"
```

### Common Issues

**Issue**: Lambda timeout (Task timed out after 120.00 seconds)
- **Fix**: Increase timeout to 180 seconds
```bash
aws lambda update-function-configuration \
  --function-name hedgeye-pdf-processor \
  --timeout 180
```

**Issue**: Out of memory error
- **Fix**: Increase memory to 1536 MB or 2048 MB
```bash
aws lambda update-function-configuration \
  --function-name hedgeye-pdf-processor \
  --memory-size 1536
```

**Issue**: Module not found (e.g., `ModuleNotFoundError: No module named 'pdfplumber'`)
- **Fix**: Verify Lambda layer is attached and contains dependencies

**Issue**: Textract permission denied
- **Fix**: Verify IAM role has `textract:AnalyzeDocument` permission

---

## Step 9: Update Lambda Code (After Changes)

When you modify parser code:

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda/lambda-deployment

# Update the changed file (e.g., parse_bitcoin_tracker.py)
cp ../parse_bitcoin_tracker.py .

# Re-package
zip -r hedgeye_pdf_processor.zip *.py

# Update Lambda
aws lambda update-function-code \
  --function-name hedgeye-pdf-processor \
  --zip-file fileb://hedgeye_pdf_processor.zip \
  --region us-west-1
```

---

## Deployment Checklist

- [ ] Lambda layer created (Python dependencies)
- [ ] Lambda layer created (Poppler binaries)
- [ ] IAM role created with correct permissions
- [ ] Lambda function created
- [ ] Lambda layers attached
- [ ] S3 trigger configured
- [ ] Test with manual invocation (passes)
- [ ] Test with real PDF upload (passes)
- [ ] DynamoDB data verified
- [ ] CloudWatch logs show success

---

## Cost Monitoring

Track costs in AWS Cost Explorer:
- Filter by service: Lambda, Textract
- Expected monthly cost: ~$2.75-3.30/month
  - Lambda: FREE (within free tier)
  - Textract: ~$2.25/month (150 pages)
  - S3/DynamoDB: ~$0.50/month

---

## Next Steps

After successful deployment:
1. ✅ Archive old local script workflow
2. ✅ Update documentation to reflect automated processing
3. 🚀 Proceed to Phase 2, Task 2: EventBridge schedules for market data
4. 🚀 Proceed to Phase 2, Task 3: CloudWatch alarms

---

**Last Updated**: January 10, 2026
