# IAM Role Setup Guide for Lambda Function

This guide walks you through setting up IAM permissions for the CSV Portfolio Processor Lambda function.

## Option 1: Update Existing Lambda Role (Recommended)

If your Lambda function `CSVPortfolioProcessor` already exists, it has an execution role. We just need to add the correct permissions.

### Step 1: Find Your Lambda's Execution Role

1. Go to **AWS Console → Lambda → Functions**
2. Click on **CSVPortfolioProcessor**
3. Click the **Configuration** tab
4. Click **Permissions** in the left sidebar
5. Under "Execution role", you'll see the role name (e.g., `CSVPortfolioProcessor-role-xyz123`)
6. Click on the role name to open it in IAM

### Step 2: Get Your S3 Bucket Name

You need to replace `YOUR_BUCKET_NAME` in the policy with your actual bucket name.

1. Go to **S3 → Buckets**
2. Find your bucket (likely created in Day 1)
3. Copy the bucket name

### Step 3: Create Custom Policy

1. In the IAM role page, click **Add permissions → Create inline policy**
2. Click the **JSON** tab
3. Copy the contents from `lambda-execution-role-policy.json`
4. **IMPORTANT**: Replace `YOUR_BUCKET_NAME` with your actual S3 bucket name (do this twice in the Resource array)
5. Click **Review policy**
6. Name it: `CSVProcessorCustomPolicy`
7. Click **Create policy**

### Step 4: Verify Permissions

Your Lambda role should now have:
- ✅ S3 read access to your bucket
- ✅ DynamoDB read/write access to your 3 tables
- ✅ CloudWatch Logs access
- ✅ Basic Lambda execution permissions (already there)

## Option 2: Create New Role from Scratch

If you need to create a completely new role:

### Step 1: Create the Role

1. Go to **IAM → Roles**
2. Click **Create role**
3. Select **AWS service**
4. Choose **Lambda**
5. Click **Next**

### Step 2: Attach Managed Policy

1. Search for and select: **AWSLambdaBasicExecutionRole**
2. Click **Next**

### Step 3: Name and Create

1. Role name: `LambdaCSVProcessorRole`
2. Description: "Execution role for CSV Portfolio Processor Lambda"
3. Click **Create role**

### Step 4: Add Custom Policy

1. Find your new role: **IAM → Roles → LambdaCSVProcessorRole**
2. Click **Add permissions → Create inline policy**
3. Click **JSON** tab
4. Copy contents from `lambda-execution-role-policy.json`
5. Replace `YOUR_BUCKET_NAME` with your S3 bucket name
6. Click **Review policy**
7. Name: `CSVProcessorCustomPolicy`
8. Click **Create policy**

### Step 5: Attach Role to Lambda

1. Go to **Lambda → Functions → CSVPortfolioProcessor**
2. Click **Configuration → Permissions**
3. Under "Execution role", click **Edit**
4. Select **Use an existing role**
5. Choose **LambdaCSVProcessorRole**
6. Click **Save**

## Verify Your Setup

### Check S3 Permissions

Your role should allow:
- `s3:GetObject` - Read CSV files
- `s3:ListBucket` - List bucket contents

### Check DynamoDB Permissions

Your role should allow on all 3 tables:
- `dynamodb:PutItem` - Write single items
- `dynamodb:BatchWriteItem` - Write multiple items
- `dynamodb:GetItem` - Read items (for future queries)
- `dynamodb:Query` - Query items (for future API)

### Check CloudWatch Logs Permissions

Your role should allow:
- `logs:CreateLogGroup` - Create log groups
- `logs:CreateLogStream` - Create log streams
- `logs:PutLogEvents` - Write logs

## Security Best Practices

✅ **Least Privilege**: The policy only grants minimum required permissions
✅ **Resource Specific**: Permissions are scoped to specific tables and bucket
✅ **No Wildcards**: No overly permissive `*` in actions (except logs)

## Troubleshooting

### Error: "Access Denied" when Lambda runs

**Check:**
1. Role is attached to Lambda function
2. Bucket name in policy matches actual bucket
3. Table names match (PortfolioSnapshots, Holdings, ProcessingLogs)

### Error: "User is not authorized to perform: iam:CreatePolicy"

**Solution:** You need IAM permissions to create policies. Ask an admin or use Option 1 to update existing role.

### How to test permissions without uploading CSV

1. Go to **Lambda → CSVPortfolioProcessor → Test**
2. Create test event with S3 PUT structure:

```json
{
  "Records": [{
    "s3": {
      "bucket": {"name": "YOUR_BUCKET_NAME"},
      "object": {"key": "test.csv"}
    }
  }]
}
```

3. Click **Test**
4. Check CloudWatch logs for permission errors

## What's Next?

Once IAM is configured:
1. ✅ Upload Lambda function code (DEPLOYMENT_GUIDE.md)
2. ✅ Configure S3 trigger
3. ✅ Test with sample CSV
4. ✅ Set up API Gateway

## Quick Reference

**Required AWS Resources:**
- Lambda Function: `CSVPortfolioProcessor`
- S3 Bucket: `<your-bucket-name>`
- DynamoDB Tables: `PortfolioSnapshots`, `Holdings`, `ProcessingLogs`
- IAM Role: `<function-name>-role-xyz` or `LambdaCSVProcessorRole`

**Policy ARN Pattern:**
```
arn:aws:s3:::YOUR_BUCKET_NAME/*
arn:aws:dynamodb:REGION:ACCOUNT_ID:table/TABLE_NAME
arn:aws:logs:REGION:ACCOUNT_ID:*
```
