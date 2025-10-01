# AWS S3 Static Website Setup

## Step 1: Create S3 Bucket

1. **Log into AWS Console** → Navigate to S3
2. **Create Bucket**:
   - Bucket name: `market-dashboard-[your-unique-suffix]` (must be globally unique)
   - Region: Choose closest to your target audience (e.g., `us-east-1`)
   - **Uncheck "Block all public access"** (required for static hosting)
   - Acknowledge the warning about public access

## Step 2: Configure Static Website Hosting

1. **Go to Bucket** → Properties tab
2. **Scroll to "Static website hosting"**
3. **Enable static website hosting**
4. **Index document**: `index.html`
5. **Error document**: `index.html` (for React Router support)
6. **Save changes**

## Step 3: Set Bucket Policy for Public Read

Go to **Permissions** → **Bucket Policy** and add:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "PublicReadGetObject",
            "Effect": "Allow",
            "Principal": "*",
            "Action": "s3:GetObject",
            "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
        }
    ]
}
```

Replace `YOUR-BUCKET-NAME` with your actual bucket name.

## Step 4: Upload Files

Upload the contents of your `build/` folder to the S3 bucket root.

**Your static website URL will be**:
`http://YOUR-BUCKET-NAME.s3-website-REGION.amazonaws.com`

Note: Using S3 website hosting serves HTTP only. If you need HTTPS or a custom domain, add CloudFront later (optional).