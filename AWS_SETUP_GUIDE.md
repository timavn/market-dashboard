# AWS Setup Guide for CSV Upload

## Problem
The CSV upload feature requires AWS credentials to generate presigned URLs for S3 uploads.

## Solution Options

### Option 1: Environment Variables (Recommended)
Create a `.env` file in the project root:

```bash
# AWS Configuration
AWS_ACCESS_KEY_ID=your_access_key_here
AWS_SECRET_ACCESS_KEY=your_secret_key_here
AWS_REGION=us-west-1
```

### Option 2: AWS CLI Configuration
Install AWS CLI and configure credentials:

```bash
# Install AWS CLI (if not already installed)
brew install awscli

# Configure credentials
aws configure
# Enter your Access Key ID, Secret Access Key, and Region (us-west-1)
```

### Option 3: AWS Credentials File
Create `~/.aws/credentials`:

```ini
[default]
aws_access_key_id = your_access_key_here
aws_secret_access_key = your_secret_key_here
region = us-west-1
```

## Testing
After setting up credentials, restart the server and test:

```bash
# Test AWS status
curl http://localhost:3001/api/aws-status

# Test presigned URL
curl -X POST http://localhost:3001/api/presigned-url \
  -H "Content-Type: application/json" \
  -d '{"filename":"test.csv","contentType":"text/csv"}'
```

## Required AWS Permissions
Your AWS user/role needs these permissions:
- `s3:PutObject` on bucket `market-dashboard-csv-data`
- `s3:ListBucket` on bucket `market-dashboard-csv-data`

## Troubleshooting
- Check `/api/aws-status` endpoint for detailed AWS configuration info
- Server logs will show AWS credential validation results
- Ensure the S3 bucket `market-dashboard-csv-data` exists in your AWS account
