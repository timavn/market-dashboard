#!/bin/bash
# Deployment script for Hedgeye Risk Range Scraper Lambda function

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCTION_NAME="HedgeyeRiskRangeScraper"
REGION="${AWS_REGION:-us-west-1}"
RUNTIME="python3.11"
TIMEOUT=300
MEMORY=512

echo "=========================================="
echo "Hedgeye Risk Range Scraper Deployment"
echo "=========================================="
echo "Function: $FUNCTION_NAME"
echo "Region: $REGION"
echo "Runtime: $RUNTIME"
echo ""

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed. Please install it first."
    exit 1
fi

# Check if credentials are configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS credentials not configured. Run 'aws configure' first."
    exit 1
fi

# Load credentials from config file
CONFIG_FILE="$SCRIPT_DIR/hedgeye_config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "⚠️  Warning: $CONFIG_FILE not found"
    echo "   Using environment variables HEDGEYE_EMAIL and HEDGEYE_PASSWORD"
    HEDGEYE_EMAIL="${HEDGEYE_EMAIL:-}"
    HEDGEYE_PASSWORD="${HEDGEYE_PASSWORD:-}"
    FIRECRAWL_API_KEY="${FIRECRAWL_API_KEY:-}"
else
    echo "✓ Found config file: $CONFIG_FILE"
    HEDGEYE_EMAIL=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['email'])")
    HEDGEYE_PASSWORD=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['password'])")
    # Try to get Firecrawl API key from config file (optional)
    FIRECRAWL_API_KEY=$(python3 -c "import json; config=json.load(open('$CONFIG_FILE')); print(config.get('firecrawl_api_key', ''))" 2>/dev/null || echo "")
fi

# If not in config file, try environment variable
if [ -z "$FIRECRAWL_API_KEY" ]; then
    FIRECRAWL_API_KEY="${FIRECRAWL_API_KEY:-}"
fi

if [ -z "$HEDGEYE_EMAIL" ] || [ -z "$HEDGEYE_PASSWORD" ]; then
    echo "❌ Error: HEDGEYE_EMAIL and HEDGEYE_PASSWORD must be set"
    echo "   Either create $CONFIG_FILE or set environment variables"
    exit 1
fi

if [ -z "$FIRECRAWL_API_KEY" ]; then
    echo "⚠️  Warning: FIRECRAWL_API_KEY not set"
    echo "   Firecrawl scraping will not be available (will fall back to Playwright/requests)"
    echo "   Set FIRECRAWL_API_KEY environment variable or add to $CONFIG_FILE"
else
    echo "✓ Firecrawl API key loaded"
fi

echo "✓ Credentials loaded"
echo ""

# Create temporary directory for packaging
TEMP_DIR=$(mktemp -d)
echo "📦 Creating deployment package in $TEMP_DIR"

# Copy Lambda function
cp "$SCRIPT_DIR/hedgeye_risk_range_scraper.py" "$TEMP_DIR/"

# Install dependencies
echo "📥 Installing dependencies..."
cd "$TEMP_DIR"
pip install -r "$SCRIPT_DIR/requirements.txt" -t . --quiet

# Create zip file
ZIP_FILE="$SCRIPT_DIR/hedgeye_risk_range_scraper.zip"
echo "📦 Creating zip file: $ZIP_FILE"
zip -r "$ZIP_FILE" . -q -x "*.pyc" "__pycache__/*" "*.dist-info/*" "*/tests/*" "*/test/*"

# Clean up temp directory
rm -rf "$TEMP_DIR"
echo "✓ Package created: $ZIP_FILE"
echo ""

# Check if function exists
FUNCTION_EXISTS=$(aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" 2>&1 || echo "NOT_FOUND")

if [[ "$FUNCTION_EXISTS" == *"NOT_FOUND"* ]] || [[ "$FUNCTION_EXISTS" == *"ResourceNotFoundException"* ]]; then
    echo "🆕 Creating new Lambda function..."
    
    # Get IAM role ARN (you may need to adjust this)
    echo "⚠️  You need to provide an IAM role ARN for the Lambda function"
    echo "   Example: arn:aws:iam::123456789012:role/lambda-execution-role"
    read -p "Enter IAM Role ARN: " ROLE_ARN
    
    if [ -z "$ROLE_ARN" ]; then
        echo "❌ Error: IAM Role ARN is required"
        exit 1
    fi
    
    # Build environment variables JSON
    ENV_VARS="HEDGEYE_EMAIL=$HEDGEYE_EMAIL,HEDGEYE_PASSWORD=$HEDGEYE_PASSWORD,RISK_RANGE_TABLE=RiskRangeData"
    if [ -n "$FIRECRAWL_API_KEY" ]; then
        ENV_VARS="$ENV_VARS,FIRECRAWL_API_KEY=$FIRECRAWL_API_KEY"
    fi
    
    aws lambda create-function \
        --function-name "$FUNCTION_NAME" \
        --runtime "$RUNTIME" \
        --role "$ROLE_ARN" \
        --handler hedgeye_risk_range_scraper.lambda_handler \
        --zip-file "fileb://$ZIP_FILE" \
        --timeout "$TIMEOUT" \
        --memory-size "$MEMORY" \
        --environment "Variables={$ENV_VARS}" \
        --region "$REGION" \
        --description "Scrapes Hedgeye Risk Range Signals (LRR/HRR) daily after market close"
    
    echo "✓ Function created"
else
    echo "🔄 Updating existing Lambda function..."
    
    # Update function code
    aws lambda update-function-code \
        --function-name "$FUNCTION_NAME" \
        --zip-file "fileb://$ZIP_FILE" \
        --region "$REGION" \
        --quiet
    
    echo "✓ Code updated"
    
    # Build environment variables JSON
    ENV_VARS="HEDGEYE_EMAIL=$HEDGEYE_EMAIL,HEDGEYE_PASSWORD=$HEDGEYE_PASSWORD,RISK_RANGE_TABLE=RiskRangeData"
    if [ -n "$FIRECRAWL_API_KEY" ]; then
        ENV_VARS="$ENV_VARS,FIRECRAWL_API_KEY=$FIRECRAWL_API_KEY"
    fi
    
    # Update function configuration
    aws lambda update-function-configuration \
        --function-name "$FUNCTION_NAME" \
        --timeout "$TIMEOUT" \
        --memory-size "$MEMORY" \
        --environment "Variables={$ENV_VARS}" \
        --region "$REGION" \
        --quiet
    
    echo "✓ Configuration updated"
fi

echo ""
echo "=========================================="
echo "✅ Deployment complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Test the function:"
echo "   aws lambda invoke --function-name $FUNCTION_NAME --region $REGION response.json"
echo ""
echo "2. Create EventBridge schedule (see aws/eventbridge/HEDGEYE_RISK_RANGE_SCHEDULE.md)"
echo ""
echo "3. Verify DynamoDB table exists:"
echo "   aws dynamodb describe-table --table-name RiskRangeData --region $REGION"
echo ""


