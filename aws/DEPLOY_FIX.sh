#!/bin/bash

# 🚀 AWS Lambda DynamoDB Schema Fix Deployment Script
# This script applies all the fixes for the DynamoDB schema mismatch error

echo "🚀 Starting AWS Lambda DynamoDB Schema Fix..."

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI not found. Please install AWS CLI first."
    exit 1
fi

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 not found. Please install Python 3 first."
    exit 1
fi

echo "✅ Prerequisites check passed"

# Step 1: Create DynamoDB tables
echo "📊 Step 1: Creating DynamoDB tables..."
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/dynamodb

if [ -f "create_tables.py" ]; then
    python3 create_tables.py
    if [ $? -eq 0 ]; then
        echo "✅ DynamoDB tables created successfully"
    else
        echo "❌ Failed to create DynamoDB tables"
        exit 1
    fi
else
    echo "❌ create_tables.py not found"
    exit 1
fi

# Step 2: Update Lambda function code
echo "🔧 Step 2: Updating Lambda function code..."
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda

# Create new deployment package
echo "📦 Creating deployment package..."
zip -r csv_processor_fixed.zip csv_processor.py

if [ -f "csv_processor_fixed.zip" ]; then
    echo "✅ Deployment package created: csv_processor_fixed.zip"
    echo "📤 Upload this file to your Lambda function in the AWS Console"
    echo "   - Go to Lambda → CSVPortfolioProcessor → Code source"
    echo "   - Upload from → .zip file"
    echo "   - Select csv_processor_fixed.zip"
else
    echo "❌ Failed to create deployment package"
    exit 1
fi

# Step 3: Display IAM policy update instructions
echo "🔐 Step 3: IAM Policy Update Required"
echo ""
echo "To update IAM permissions:"
echo "1. Go to IAM → Roles → CSVPortfolioProcessor-role-XXXXX"
echo "2. Click 'Add permissions' → 'Create inline policy'"
echo "3. Copy the contents from aws/lambda/iam-policy.json"
echo "4. Name it: CSVProcessorPolicy"
echo "5. Attach to the role"
echo ""

# Step 4: Display test instructions
echo "🧪 Step 4: Test the Fix"
echo ""
echo "To test the updated Lambda function:"
echo "1. Go to Lambda → CSVPortfolioProcessor → Test"
echo "2. Use this test event:"
echo ""
cat << 'EOF'
{
  "Records": [{
    "s3": {
      "bucket": {"name": "market-dashboard-csv-data"},
      "object": {"key": "uploads/test-portfolio.csv"}
    }
  }]
}
EOF
echo ""
echo "3. Click 'Test' and check for successful execution"
echo "4. Verify data appears in DynamoDB tables"
echo ""

echo "🎉 Fix deployment complete!"
echo ""
echo "Next steps:"
echo "1. Upload csv_processor_fixed.zip to Lambda"
echo "2. Update IAM permissions"
echo "3. Test the Lambda function"
echo "4. Upload a CSV file to S3 to verify end-to-end"
echo ""
echo "📚 For detailed instructions, see: aws/FIX_DYNAMODB_SCHEMA_ERROR.md"

