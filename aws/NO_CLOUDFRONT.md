# CloudFront NOT Used

## Important Note

**This project does NOT use AWS CloudFront CDN.**

## Why Not?

1. **Simplicity**: S3 static hosting is sufficient for this personal dashboard
2. **Cost**: CloudFront adds unnecessary cost (~$0.50-2/month) for low-traffic personal use
3. **Complexity**: CloudFront adds cache invalidation and configuration overhead
4. **Performance**: S3 static hosting performance is adequate for personal use

## Architecture

```
Frontend (React):
  Local Development → localhost:3000
  Production → S3 Static Hosting (future)

Backend (Express):
  Development → localhost:3001
  Production → EC2 or Lambda + API Gateway (future)

Data Pipeline:
  CSV Upload → S3 → Lambda → DynamoDB → Express API → Dashboard
```

## Deployment Strategy

### Current (Development):
- Frontend: `npm start` (localhost:3000)
- Backend: `npm run server` (localhost:3001)

### Future (Production):
- Frontend: S3 static hosting with custom domain
- Backend: EC2 instance or Lambda with API Gateway
- Database: DynamoDB (already configured)

## If You Need CloudFront

If you decide to add CloudFront later:
1. Create CloudFront distribution pointing to S3 bucket
2. Configure origin settings
3. Update DNS to point to CloudFront
4. Add cache invalidation to GitHub Actions workflow

**But it's not needed for personal portfolio tracking.**

## Documentation References

For deployment without CloudFront, see:
- [deploy/aws-s3-setup.md](../deploy/aws-s3-setup.md) - S3 static hosting
- [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) - S3-only deployment
- [README.md](../README.md) - Current architecture

## Why This Documentation Exists

Claude Code kept trying to incorporate CloudFront into the architecture despite it not being used. This file explicitly documents that CloudFront is NOT part of this project to prevent future confusion.
