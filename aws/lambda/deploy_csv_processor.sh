#!/bin/bash
# Deployment script for CSV Portfolio Processor Lambda function

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCTION_NAME="CSVPortfolioProcessor"
REGION="${AWS_REGION:-us-west-1}"
# Check if runtime needs update, assume python3.11 based on other scripts
RUNTIME="python3.11" 
TIMEOUT=300
MEMORY=512

echo "=========================================="
echo "CSV Portfolio Processor Deployment"
echo "=========================================="
echo "Function: $FUNCTION_NAME"
echo "Region: $REGION"
echo ""

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed."
    exit 1
fi

# Create temporary directory for packaging
TEMP_DIR=$(mktemp -d)
echo "📦 Creating deployment package in $TEMP_DIR"

# Copy Lambda function
cp "$SCRIPT_DIR/csv_processor.py" "$TEMP_DIR/"
# Copy any helper files if needed (e.g., performance_metrics_calculator.py if imported)
# cp "$SCRIPT_DIR/performance_metrics_calculator.py" "$TEMP_DIR/" 

# Install dependencies (if any specific ones beyond boto3 which is built-in)
# pip install -r "$SCRIPT_DIR/requirements.txt" -t "$TEMP_DIR" --quiet

# Create zip file
ZIP_FILE="$SCRIPT_DIR/csv_processor.zip"
echo "📦 Creating zip file: $ZIP_FILE"
cd "$TEMP_DIR"
zip -r "$ZIP_FILE" . -q
cd "$SCRIPT_DIR"

# Clean up temp directory
rm -rf "$TEMP_DIR"

echo "🔄 Updating existing Lambda function..."
    
# Update function code
aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP_FILE" \
    --region "$REGION"
    
echo "✓ Code updated"
    
echo ""
echo "=========================================="
echo "✅ Deployment complete!"
echo "=========================================="
