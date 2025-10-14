# Lambda Function: CSV Portfolio Processor

## Overview
This Lambda function processes Schwab CSV files uploaded to S3 and stores the portfolio data in DynamoDB.

## Deployment Steps

### 1. Create Deployment Package
```bash
cd aws/lambda
pip install -r requirements.txt -t .
zip -r csv_processor.zip . -x "*.pyc" -x "__pycache__/*" -x "README.md"
```

### 2. Configure Lambda Function in AWS Console

**Function Configuration:**
- **Runtime**: Python 3.9
- **Memory**: 512 MB
- **Timeout**: 30 seconds
- **Handler**: csv_processor.lambda_handler

**Environment Variables:**
- `PORTFOLIO_TABLE`: PortfolioSnapshots
- `HOLDINGS_TABLE`: Holdings
- `LOGS_TABLE`: ProcessingLogs

### 3. IAM Role Permissions

The Lambda execution role needs the following permissions:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject"
            ],
            "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "dynamodb:PutItem",
                "dynamodb:BatchWriteItem"
            ],
            "Resource": [
                "arn:aws:dynamodb:*:*:table/PortfolioSnapshots",
                "arn:aws:dynamodb:*:*:table/Holdings",
                "arn:aws:dynamodb:*:*:table/ProcessingLogs"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ],
            "Resource": "arn:aws:logs:*:*:*"
        }
    ]
}
```

### 4. Configure S3 Trigger

In the AWS Console:
1. Go to your Lambda function
2. Click "Add trigger"
3. Select "S3"
4. Choose your bucket
5. Set Event type: "PUT"
6. Set Prefix (optional): `uploads/`
7. Set Suffix: `.csv`

### 5. Upload Function Code

**Option A: AWS Console**
1. Go to Lambda → Functions → CSVPortfolioProcessor
2. Click "Upload from" → ".zip file"
3. Upload `csv_processor.zip`

**Option B: AWS CLI** (if installed)
```bash
aws lambda update-function-code \
    --function-name CSVPortfolioProcessor \
    --zip-file fileb://csv_processor.zip
```

## Testing

### Create Test Event

Use this sample S3 event to test:

```json
{
  "Records": [
    {
      "s3": {
        "bucket": {
          "name": "YOUR_BUCKET_NAME"
        },
        "object": {
          "key": "test-portfolio.csv"
        }
      }
    }
  ]
}
```

### Sample Schwab CSV Format

The function expects CSV with these columns:
- Symbol
- Description
- Quantity
- Price
- Market Value
- Cost Basis Total
- Gain/Loss $
- Gain/Loss %
- Type

## Monitoring

View logs in CloudWatch:
```bash
aws logs tail /aws/lambda/CSVPortfolioProcessor --follow
```

## Architecture

```
CSV Upload → S3 Bucket → Lambda Trigger → Process CSV → DynamoDB Tables
                                                      ├─ PortfolioSnapshots
                                                      ├─ Holdings
                                                      └─ ProcessingLogs
```
