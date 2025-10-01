# AWS Deployment Checklist

## Prerequisites
- [ ] AWS Account created
- [ ] AWS CLI installed locally (optional but helpful)
- [ ] Domain name (optional, for custom URL)

## Deployment Steps

### Phase 1: Basic S3 Hosting
- [ ] Create S3 bucket with unique name
- [ ] Enable static website hosting
- [ ] Configure bucket policy for public access
- [ ] Upload build files to S3
- [ ] Test S3 website URL

### Phase 2 (Optional): CloudFront CDN
- [ ] (Optional) Create CloudFront distribution for CDN/HTTPS/custom domain
- [ ] (Optional) Configure origin as S3 bucket
- [ ] (Optional) Set up custom error pages for SPA routing
- [ ] (Optional) Enable HTTPS redirect
- [ ] (Optional) Wait for deployment (15-20 mins)
- [ ] (Optional) Test CloudFront URL

### Phase 3: Custom Domain (Optional)
- [ ] Purchase domain (Route 53 or external)
- [ ] Request SSL certificate in Certificate Manager
- [ ] Validate certificate
- [ ] Add CNAME to CloudFront distribution
- [ ] Configure DNS in Route 53

### Phase 4: CI/CD Pipeline
- [ ] Move GitHub Actions file to `.github/workflows/`
- [ ] Set up AWS IAM user for GitHub Actions
- [ ] Add GitHub repository secrets:
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
  - `S3_BUCKET_NAME`
- [ ] Test automated deployment

## Resume-Worthy Features Implemented
✅ **React.js** - Modern frontend framework
✅ **AWS S3** - Static website hosting
⬜ **AWS CloudFront** (optional) - Global CDN, HTTPS, caching
⬜ **AWS Certificate Manager** (optional) - SSL/TLS certificates
✅ **GitHub Actions** - CI/CD pipeline
✅ **Infrastructure as Code** - Automated deployments
✅ **Performance Optimization** - CDN, caching strategies

## Cost Estimate
- **S3**: ~$1-5/month for hosting
- **CloudFront** (optional): ~$1-10/month depending on traffic
- **Route 53** (optional): ~$0.50/month per domain
- **Certificate Manager** (optional): FREE

## Next Steps After Deployment
1. Monitor CloudWatch metrics
2. Set up CloudWatch alarms
3. Add monitoring and logging
4. (Optional) Consider CloudFront or AWS Amplify later if needs evolve