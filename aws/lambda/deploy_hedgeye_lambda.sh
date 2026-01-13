#!/bin/bash
# Quick deployment script for Hedgeye PDF Processor Lambda
#
# Prerequisites:
# - AWS CLI configured with credentials
# - Existing S3 bucket: market-dashboard-csv-data
# - Existing DynamoDB table: HedgeyeDailySnapshot
#
# Usage:
#   chmod +x deploy_hedgeye_lambda.sh
#   ./deploy_hedgeye_lambda.sh

set -e  # Exit on error

echo "=========================================="
echo "Hedgeye PDF Processor - Lambda Deployment"
echo "=========================================="
echo ""

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "✓ AWS Account ID: $ACCOUNT_ID"

# Set variables
REGION="us-west-1"
FUNCTION_NAME="hedgeye-pdf-processor"
ROLE_NAME="hedgeye-pdf-processor-role"
BUCKET_NAME="market-dashboard-csv-data"
PYTHON_LAYER_NAME="hedgeye-pdf-processor-deps"
POPPLER_LAYER_ARN="arn:aws:lambda:us-west-1:764866452798:layer:poppler:1"

echo ""
echo "Configuration:"
echo "  Region: $REGION"
echo "  Function: $FUNCTION_NAME"
echo "  Bucket: $BUCKET_NAME"
echo ""

# Step 1: Create Python dependencies layer
echo "=========================================="
echo "Step 1: Creating Python dependencies layer"
echo "=========================================="

mkdir -p lambda-layers/python-deps/python
echo "Installing Python dependencies..."

pip3 install \
  pdfplumber \
  pdf2image \
  PyPDF2 \
  Pillow \
  -t lambda-layers/python-deps/python --quiet

cd lambda-layers/python-deps
zip -r ../python-deps-layer.zip python -q
cd ../..

echo "Uploading Python dependencies layer..."
PYTHON_LAYER_VERSION=$(aws lambda publish-layer-version \
  --layer-name $PYTHON_LAYER_NAME \
  --description "Python dependencies for Hedgeye PDF processor" \
  --zip-file fileb://lambda-layers/python-deps-layer.zip \
  --compatible-runtimes python3.9 \
  --region $REGION \
  --query Version --output text)

PYTHON_LAYER_ARN="arn:aws:lambda:$REGION:$ACCOUNT_ID:layer:$PYTHON_LAYER_NAME:$PYTHON_LAYER_VERSION"
echo "✓ Python layer created: $PYTHON_LAYER_ARN"

# Step 2: Package Lambda function code
echo ""
echo "=========================================="
echo "Step 2: Packaging Lambda function code"
echo "=========================================="

mkdir -p lambda-deployment
cd lambda-deployment

# Copy all required files
cp ../hedgeye_pdf_processor_lambda.py lambda_function.py
cp ../date_utils.py .
cp ../parse_bitcoin_tracker.py .
cp ../parse_early_look.py .
cp ../parse_portfolio_solutions.py .
cp ../parse_momo_tracker.py .
cp ../parse_signal_strength.py .

# Create deployment package
zip -r hedgeye_pdf_processor.zip *.py -q
cd ..

echo "✓ Lambda deployment package created"

# Step 3: Create IAM role (if doesn't exist)
echo ""
echo "=========================================="
echo "Step 3: Creating IAM role"
echo "=========================================="

if aws iam get-role --role-name $ROLE_NAME 2>/dev/null; then
  echo "✓ IAM role already exists: $ROLE_NAME"
else
  echo "Creating IAM role..."

  # Trust policy
  cat > /tmp/lambda-trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "lambda.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF

  aws iam create-role \
    --role-name $ROLE_NAME \
    --assume-role-policy-document file:///tmp/lambda-trust-policy.json \
    --output text

  # Wait for role to be created
  sleep 5

  # Create and attach policy
  cat > /tmp/hedgeye-processor-policy.json <<EOF
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
        "arn:aws:s3:::$BUCKET_NAME",
        "arn:aws:s3:::$BUCKET_NAME/hedgeye/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:GetItem"
      ],
      "Resource": "arn:aws:dynamodb:$REGION:*:table/HedgeyeDailySnapshot"
    },
    {
      "Effect": "Allow",
      "Action": [
        "textract:AnalyzeDocument",
        "textract:DetectDocumentText"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:$REGION:*:*"
    }
  ]
}
EOF

  aws iam put-role-policy \
    --role-name $ROLE_NAME \
    --policy-name HedgeyePDFProcessorPolicy \
    --policy-document file:///tmp/hedgeye-processor-policy.json

  rm /tmp/lambda-trust-policy.json /tmp/hedgeye-processor-policy.json

  echo "✓ IAM role created: $ROLE_NAME"

  # Wait for IAM role to propagate
  echo "Waiting for IAM role to propagate (10 seconds)..."
  sleep 10
fi

ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME"

# Step 4: Create or update Lambda function
echo ""
echo "=========================================="
echo "Step 4: Creating/updating Lambda function"
echo "=========================================="

if aws lambda get-function --function-name $FUNCTION_NAME --region $REGION 2>/dev/null; then
  echo "Lambda function exists. Updating code..."

  aws lambda update-function-code \
    --function-name $FUNCTION_NAME \
    --zip-file fileb://lambda-deployment/hedgeye_pdf_processor.zip \
    --region $REGION \
    --output text

  echo "✓ Lambda function code updated"
else
  echo "Creating Lambda function..."

  aws lambda create-function \
    --function-name $FUNCTION_NAME \
    --runtime python3.9 \
    --role $ROLE_ARN \
    --handler lambda_function.lambda_handler \
    --zip-file fileb://lambda-deployment/hedgeye_pdf_processor.zip \
    --timeout 120 \
    --memory-size 1024 \
    --region $REGION \
    --layers $PYTHON_LAYER_ARN $POPPLER_LAYER_ARN \
    --output text

  echo "✓ Lambda function created"
fi

# Step 5: Configure S3 trigger
echo ""
echo "=========================================="
echo "Step 5: Configuring S3 trigger"
echo "=========================================="

# Add S3 invoke permission (ignore if already exists)
aws lambda add-permission \
  --function-name $FUNCTION_NAME \
  --statement-id s3-trigger-hedgeye \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn arn:aws:s3:::$BUCKET_NAME \
  --region $REGION 2>/dev/null || echo "Permission already exists"

echo "✓ Lambda invoke permission configured"

echo ""
echo "=========================================="
echo "Deployment Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Configure S3 event notification manually in AWS Console:"
echo "   - Bucket: $BUCKET_NAME"
echo "   - Event: s3:ObjectCreated:*"
echo "   - Prefix: hedgeye/"
echo "   - Suffix: .pdf"
echo "   - Lambda: $FUNCTION_NAME"
echo ""
echo "2. Test by uploading a PDF:"
echo "   aws s3 cp ~/Desktop/hedgeye/bitcoin-tracker-2026-01-09.pdf s3://$BUCKET_NAME/hedgeye/"
echo ""
echo "3. Monitor logs:"
echo "   aws logs tail /aws/lambda/$FUNCTION_NAME --follow"
echo ""
echo "Lambda Function ARN:"
echo "   arn:aws:lambda:$REGION:$ACCOUNT_ID:function:$FUNCTION_NAME"
echo ""
