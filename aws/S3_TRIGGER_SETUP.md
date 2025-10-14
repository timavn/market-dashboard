# S3 Trigger Setup for Lambda

Configure S3 to automatically trigger your Lambda function when CSV files are uploaded.

## Step 1: Open Lambda Function

1. Go to: https://console.aws.amazon.com/lambda
2. Click: **CSVPortfolioProcessor**

## Step 2: Add S3 Trigger

1. Scroll down to **Function overview** diagram
2. Click: **+ Add trigger**
3. In the dropdown, select: **S3**

## Step 3: Configure Trigger

Fill in the form:

- **Bucket**: Select your S3 bucket from dropdown
- **Event type**: Select **PUT** (or "All object create events")
- **Prefix**: `uploads/` (optional - only triggers for files in uploads/ folder)
- **Suffix**: `.csv` (only triggers for CSV files)
- **Enable trigger**: Check the box

## Step 4: Acknowledge Recursive Invocation

- Check the box: "I acknowledge that using the same S3 bucket for both input and output is not recommended..."
  - This is fine because we're only reading, not writing back to S3

## Step 5: Create Trigger

- Click: **Add**

## Verification

You should now see in the Function overview diagram:
```
S3 → CSVPortfolioProcessor → (outputs)
```

## Test the Trigger

### Option A: Upload via Console

1. Go to S3: https://console.aws.amazon.com/s3
2. Open your bucket
3. Create folder `uploads/` (if you used prefix)
4. Upload a test CSV file
5. Check Lambda logs in CloudWatch

### Option B: Create Test Event in Lambda

1. In Lambda, click **Test** tab
2. Create new test event with this JSON (replace bucket name):

```json
{
  "Records": [
    {
      "eventVersion": "2.1",
      "eventSource": "aws:s3",
      "awsRegion": "us-east-1",
      "eventTime": "2025-10-03T12:00:00.000Z",
      "eventName": "ObjectCreated:Put",
      "s3": {
        "bucket": {
          "name": "YOUR_BUCKET_NAME",
          "arn": "arn:aws:s3:::YOUR_BUCKET_NAME"
        },
        "object": {
          "key": "uploads/test-portfolio.csv",
          "size": 1024
        }
      }
    }
  ]
}
```

3. Save and click **Test**

## Next Steps

After trigger is configured:
1. ✅ Upload Lambda function code
2. ✅ Upload test CSV to S3
3. ✅ Verify data in DynamoDB
4. ✅ Set up API Gateway

## Troubleshooting

**Trigger not firing?**
- Check suffix matches (.csv)
- Check prefix matches folder structure
- Verify trigger is enabled

**Lambda errors?**
- Check CloudWatch Logs: Lambda → Monitor → View logs in CloudWatch
- Verify IAM permissions are set
- Check Lambda function code is uploaded

## Quick Reference

**Recommended Settings:**
- Event type: PUT
- Prefix: `uploads/`
- Suffix: `.csv`
- This ensures only CSV files in uploads/ folder trigger the function
