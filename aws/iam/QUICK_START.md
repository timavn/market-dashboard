# Quick Start: IAM Permissions Setup

**Goal:** Give your Lambda function permission to read from S3 and write to DynamoDB.

## 🚀 Fast Track (5 minutes)

### 1. Open Your Lambda Function
- Go to: https://console.aws.amazon.com/lambda
- Click: **CSVPortfolioProcessor**

### 2. Find Your Role
- Click: **Configuration** tab → **Permissions**
- Click the role name under "Execution role"

### 3. Get Your Bucket Name
- Open new tab: https://console.aws.amazon.com/s3
- Copy your bucket name

### 4. Add Permissions
Back in the IAM role page:
- Click: **Add permissions** → **Create inline policy**
- Click: **JSON** tab
- Paste this (replace `YOUR_BUCKET_NAME` with your actual bucket):

```json
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
                "arn:aws:s3:::YOUR_BUCKET_NAME",
                "arn:aws:s3:::YOUR_BUCKET_NAME/*"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "dynamodb:PutItem",
                "dynamodb:BatchWriteItem",
                "dynamodb:GetItem",
                "dynamodb:Query"
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

- Click: **Review policy**
- Name: `CSVProcessorPolicy`
- Click: **Create policy**

### 5. Done! ✅

Your Lambda now has permissions to:
- ✅ Read CSV files from S3
- ✅ Write portfolio data to DynamoDB
- ✅ Write logs to CloudWatch

## Next Steps

1. Upload Lambda code (see `aws/lambda/DEPLOYMENT_GUIDE.md`)
2. Configure S3 trigger
3. Test with sample CSV

## Need Help?

See full guide: `IAM_SETUP_GUIDE.md`
