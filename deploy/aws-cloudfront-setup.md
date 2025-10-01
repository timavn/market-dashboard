# (Optional) AWS CloudFront CDN Setup

## Why CloudFront?
- **Global CDN**: Faster loading worldwide
- **HTTPS**: Free SSL certificate via AWS Certificate Manager
- **Custom Domain**: Professional URLs
- **Caching**: Better performance and lower costs

## Step 1: Create CloudFront Distribution

1. **Navigate to CloudFront** in AWS Console
2. **Create Distribution**
3. **Origin Settings**:
   - **Origin Domain**: Select your S3 bucket from dropdown
   - **S3 bucket access**: "Yes use OAI" (more secure)
   - **Create new OAI**: Yes, and update bucket policy

## Step 2: Distribution Settings

- **Viewer Protocol Policy**: "Redirect HTTP to HTTPS"
- **Allowed HTTP Methods**: GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE
- **Cache Policy**: "Caching Optimized"
- **Default Root Object**: `index.html`

## Step 3: Custom Error Pages (For React Router)

Add custom error page:
- **HTTP Error Code**: 403, 404
- **Response Page Path**: `/index.html`
- **HTTP Response Code**: 200

## Step 4: SSL Certificate (Optional)

If you have a custom domain:
1. **Request Certificate** in AWS Certificate Manager
2. **Add certificate** to CloudFront distribution
3. **Add CNAME** for your domain

## Step 5: Deploy

- Click **Create Distribution**
- **Wait 15-20 minutes** for deployment
- Your CloudFront URL: `https://d1234567890.cloudfront.net`