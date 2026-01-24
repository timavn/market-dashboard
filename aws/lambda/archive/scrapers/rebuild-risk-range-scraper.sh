#!/bin/bash

# Script to rebuild the RiskRangeScraper Lambda package with all dependencies

set -e  # Exit on error

LAMBDA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCTION_NAME="hedgeye_risk_range_scraper"
ZIP_NAME="${FUNCTION_NAME}.zip"
S3_BUCKET="risk-range-scraper"  # Update this to your S3 bucket name

echo "🔨 Rebuilding Lambda package for ${FUNCTION_NAME}..."
echo ""

# Change to lambda directory
cd "$LAMBDA_DIR"

# Clean up old files
echo "🧹 Cleaning up old files..."
rm -f "$ZIP_NAME"
rm -rf package/ __pycache__/ *.pyc
rm -rf playwright* beautifulsoup4* lxml* requests* boto3*

# Create a clean directory for the package
echo "📦 Creating package directory..."
mkdir -p package
cd package

# Copy the Lambda function code
echo "📋 Copying Lambda function code..."
cp "../${FUNCTION_NAME}.py" .

# Install dependencies (excluding boto3 which is in Lambda runtime)
echo "📥 Installing dependencies..."
# Create temp requirements without boto3
grep -v "^boto3" ../requirements.txt > /tmp/requirements_no_boto3.txt || cat ../requirements.txt > /tmp/requirements_no_boto3.txt
pip install --target . -r /tmp/requirements_no_boto3.txt
rm -f /tmp/requirements_no_boto3.txt

# Remove boto3 if it was installed anyway (Lambda runtime has it)
echo "🧹 Removing boto3/botocore (using Lambda runtime version)..."
rm -rf boto3* botocore* s3transfer* jmespath* 2>/dev/null || true

# Install Playwright browser binaries (required for headless browser)
# Note: Playwright installs browsers to ~/.cache/playwright by default
# For Lambda, we need to set PLAYWRIGHT_BROWSERS_PATH to install in the package
# Use chromium-headless-shell instead of full chromium to save space
echo "📥 Installing Playwright browser binaries (headless-shell for smaller size)..."
export PLAYWRIGHT_BROWSERS_PATH=$(pwd)/.playwright  # Install to package directory
python -m playwright install chromium-headless-shell --with-deps || echo "⚠️  Warning: Playwright browser installation may have failed, but continuing..."

# Create the zip file (zip contents of package directory, not the directory itself)
# Exclude unnecessary files to reduce size
echo "📦 Creating zip file..."
cd "$LAMBDA_DIR"/package

# Final cleanup: make absolutely sure boto3 is gone
rm -rf boto3* botocore* s3transfer* jmespath* 2>/dev/null || true

zip -r "$LAMBDA_DIR/$ZIP_NAME" . \
  -x "*.pyc" \
  -x "__pycache__/*" \
  -x "*.dist-info/*" \
  -x "*/tests/*" \
  -x "*/test/*" \
  -x "*.md" \
  -x "*.txt" \
  -x "*.rst" \
  -x "*.LICENSE" \
  -x "boto3*" \
  -x "botocore*" \
  -x "s3transfer*" \
  -x "jmespath*"
cd "$LAMBDA_DIR"

# Get file size
FILE_SIZE=$(du -h "$ZIP_NAME" | cut -f1)
echo ""
echo "✅ Package created: $ZIP_NAME ($FILE_SIZE)"
echo ""

# Check if file is too large for direct upload (>50MB)
FILE_SIZE_BYTES=$(stat -f%z "$ZIP_NAME" 2>/dev/null || stat -c%s "$ZIP_NAME" 2>/dev/null)
MAX_DIRECT_UPLOAD=$((50 * 1024 * 1024))  # 50MB

if [ "$FILE_SIZE_BYTES" -gt "$MAX_DIRECT_UPLOAD" ]; then
    echo "⚠️  Package is larger than 50MB. You'll need to upload to S3 first."
    echo ""
    echo "To upload to S3 and update Lambda:"
    echo "  aws s3 cp $ZIP_NAME s3://${S3_BUCKET}/${ZIP_NAME}"
    echo "  aws lambda update-function-code \\"
    echo "    --function-name RiskRangeScraper \\"
    echo "    --s3-bucket ${S3_BUCKET} \\"
    echo "    --s3-key ${ZIP_NAME}"
else
    echo "✅ Package is small enough for direct upload (<50MB)"
    echo ""
    echo "To update Lambda directly:"
    echo "  aws lambda update-function-code \\"
    echo "    --function-name RiskRangeScraper \\"
    echo "    --zip-file fileb://${ZIP_NAME}"
fi

echo ""
echo "🎉 Rebuild complete!"

